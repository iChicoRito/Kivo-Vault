use std::sync::Mutex;

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use argon2::Argon2;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::database::DatabaseState;

const KEY_LENGTH: usize = 32;
const SALT_LENGTH: usize = 16;
const NONCE_LENGTH: usize = 12;
const MIN_PASSWORD_LENGTH: usize = 8;

const CANARY_PLAINTEXT: &[u8] = b"kivo-vault-v1";
const CREDENTIAL_AAD: &[u8] = b"kivo-credential-v1";

const LOCKED_MESSAGE: &str = "The password vault is locked";
const UNLOCK_ERROR: &str = "Could not unlock the vault";

/// Holds the derived vault key while the vault is unlocked. The key exists only
/// in memory; locking overwrites the bytes and clears the slot.
#[derive(Default)]
pub struct VaultKeyState(Mutex<Option<[u8; KEY_LENGTH]>>);

impl VaultKeyState {
    fn require_key(&self) -> Result<[u8; KEY_LENGTH], String> {
        let guard = self.0.lock().map_err(|_| LOCKED_MESSAGE.to_string())?;
        guard
            .as_ref()
            .copied()
            .ok_or_else(|| LOCKED_MESSAGE.to_string())
    }

    fn is_unlocked(&self) -> bool {
        self.0.lock().map(|guard| guard.is_some()).unwrap_or(false)
    }

    fn store(&self, key: [u8; KEY_LENGTH]) {
        if let Ok(mut guard) = self.0.lock() {
            *guard = Some(key);
        }
    }

    pub(crate) fn clear(&self) {
        if let Ok(mut guard) = self.0.lock() {
            if let Some(key) = guard.as_mut() {
                key.fill(0);
            }

            *guard = None;
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub configured: bool,
    pub unlocked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialSummary {
    pub id: String,
    pub service: String,
    pub username: String,
    pub url: String,
    pub category: String,
    pub tags: Vec<String>,
    pub is_favorite: bool,
    pub deleted_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Credential {
    pub id: String,
    pub service: String,
    pub username: String,
    pub url: String,
    pub category: String,
    pub tags: Vec<String>,
    pub is_favorite: bool,
    pub deleted_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// Decrypted for the caller only; never returned by a list command.
    pub password: String,
    pub notes: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialInput {
    pub id: Option<String>,
    pub service: String,
    #[serde(default)]
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub is_favorite: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CredentialFilter {
    pub query: Option<String>,
    pub category: Option<String>,
    pub tag: Option<String>,
    pub favorite: Option<bool>,
    pub trashed: Option<bool>,
}

/// Every field a person typed, sealed as one encrypted blob per row. Only the
/// id, favorite flag, trash stamp and dates stay readable in the database.
#[derive(Serialize, Deserialize)]
struct CredentialData {
    service: String,
    username: String,
    password: String,
    url: String,
    category: String,
    tags: Vec<String>,
    notes: String,
}

/// Ties each blob to its row, so blobs cannot be swapped between rows.
fn credential_aad(id: &str) -> Vec<u8> {
    format!("kivo:credential:v2:{id}").into_bytes()
}

fn seal_credential(
    key: &[u8; KEY_LENGTH],
    id: &str,
    data: &CredentialData,
) -> Result<([u8; NONCE_LENGTH], Vec<u8>), String> {
    let json = serde_json::to_vec(data).map_err(|_| "Could not protect the data".to_string())?;
    let nonce = random_bytes::<NONCE_LENGTH>()?;
    let ciphertext = encrypt(key, &nonce, &json, &credential_aad(id))?;
    Ok((nonce, ciphertext))
}

fn open_credential(
    key: &[u8; KEY_LENGTH],
    id: &str,
    nonce: &[u8],
    ciphertext: &[u8],
) -> Result<CredentialData, String> {
    let nonce: [u8; NONCE_LENGTH] = nonce
        .try_into()
        .map_err(|_| "Could not read the credential".to_string())?;
    let json = decrypt(key, &nonce, ciphertext, &credential_aad(id))
        .map_err(|_| "Could not read the credential".to_string())?;
    serde_json::from_slice(&json).map_err(|_| "Could not read the credential".to_string())
}

/// Rows written before every field was encrypted: readable columns plus a
/// password sealed with the old fixed AAD. Converted once the key is known.
fn convert_legacy_credentials(
    connection: &mut Connection,
    key: &[u8; KEY_LENGTH],
) -> Result<usize, String> {
    let fail = |error: rusqlite::Error| format!("Could not update the password vault: {error}");
    let transaction = connection.transaction().map_err(fail)?;
    let rows = {
        let mut statement = transaction
            .prepare(
                "SELECT id, service, username, password_nonce, password_ciphertext, url,
                        category, tags, notes
                 FROM credentials WHERE data_ciphertext IS NULL",
            )
            .map_err(fail)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                    row.get::<_, Vec<u8>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                ))
            })
            .map_err(fail)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(fail)?;
        rows
    };

    for (id, service, username, nonce, ciphertext, url, category, tags, notes) in &rows {
        let nonce: [u8; NONCE_LENGTH] = nonce
            .as_slice()
            .try_into()
            .map_err(|_| "Could not read the credential".to_string())?;
        let password = decrypt(key, &nonce, ciphertext, CREDENTIAL_AAD)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .ok_or_else(|| "Could not read the credential".to_string())?;
        let data = CredentialData {
            service: service.clone(),
            username: username.clone(),
            password,
            url: url.clone(),
            category: category.clone(),
            tags: parse_tags(tags),
            notes: notes.clone(),
        };
        write_sealed(&transaction, key, id, &data)?;
    }

    transaction.commit().map_err(fail)?;
    Ok(rows.len())
}

/// Stores the blob and blanks every readable copy of the fields.
fn write_sealed(
    connection: &Connection,
    key: &[u8; KEY_LENGTH],
    id: &str,
    data: &CredentialData,
) -> Result<usize, String> {
    let (nonce, ciphertext) = seal_credential(key, id, data)?;
    connection
        .execute(
            "UPDATE credentials
             SET data_nonce = ?1, data_ciphertext = ?2,
                 service = '', username = '', url = '', category = '', tags = '[]',
                 notes = '', password_nonce = x'', password_ciphertext = x''
             WHERE id = ?3",
            params![nonce.as_slice(), ciphertext, id],
        )
        .map_err(|error| format!("Could not save the credential: {error}"))
}

/// Reads and decrypts credentials in database order.
fn read_credentials(
    connection: &Connection,
    key: &[u8; KEY_LENGTH],
    condition: &str,
    values: &[rusqlite::types::Value],
) -> Result<Vec<Credential>, String> {
    let sql = format!(
        "SELECT id, data_nonce, data_ciphertext, is_favorite, deleted_at, created_at, updated_at
         FROM credentials
         WHERE data_ciphertext IS NOT NULL AND {condition}
         ORDER BY is_favorite DESC, updated_at DESC"
    );
    let fail = |error: rusqlite::Error| format!("Could not read the credentials: {error}");
    let mut statement = connection.prepare(&sql).map_err(fail)?;
    let rows = statement
        .query_map(rusqlite::params_from_iter(values.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Vec<u8>>(1)?,
                row.get::<_, Vec<u8>>(2)?,
                row.get::<_, i64>(3)? != 0,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
            ))
        })
        .map_err(fail)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(fail)?;

    rows.into_iter()
        .map(
            |(id, nonce, ciphertext, is_favorite, deleted_at, created_at, updated_at)| {
                let data = open_credential(key, &id, &nonce, &ciphertext)?;
                Ok(Credential {
                    id,
                    service: data.service,
                    username: data.username,
                    url: data.url,
                    category: data.category,
                    tags: data.tags,
                    is_favorite,
                    deleted_at,
                    created_at,
                    updated_at,
                    password: data.password,
                    notes: data.notes,
                })
            },
        )
        .collect()
}

struct VaultConfigRow {
    salt: Vec<u8>,
    canary_nonce: Vec<u8>,
    canary_ciphertext: Vec<u8>,
}

fn random_bytes<const N: usize>() -> Result<[u8; N], String> {
    let mut bytes = [0u8; N];
    getrandom::getrandom(&mut bytes)
        .map_err(|error| format!("Could not generate secure random bytes: {error}"))?;
    Ok(bytes)
}

fn derive_key(password: &str, salt: &[u8]) -> Result<[u8; KEY_LENGTH], String> {
    let mut key = [0u8; KEY_LENGTH];
    Argon2::default()
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|_| "Could not protect the master password".to_string())?;
    Ok(key)
}

fn encrypt(
    key: &[u8; KEY_LENGTH],
    nonce: &[u8; NONCE_LENGTH],
    plaintext: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, String> {
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|_| "Could not protect the data".to_string())?;

    cipher
        .encrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| "Could not protect the data".to_string())
}

fn decrypt(
    key: &[u8; KEY_LENGTH],
    nonce: &[u8; NONCE_LENGTH],
    ciphertext: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| "Could not read the protected data".to_string())?;

    cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|_| "Could not read the protected data".to_string())
}

fn vault_configured(connection: &Connection) -> rusqlite::Result<bool> {
    let count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM vault_config WHERE id = 1",
        [],
        |row| row.get(0),
    )?;

    Ok(count > 0)
}

fn read_vault_config(connection: &Connection) -> rusqlite::Result<Option<VaultConfigRow>> {
    connection
        .query_row(
            "SELECT salt, canary_nonce, canary_ciphertext FROM vault_config WHERE id = 1",
            [],
            |row| {
                Ok(VaultConfigRow {
                    salt: row.get(0)?,
                    canary_nonce: row.get(1)?,
                    canary_ciphertext: row.get(2)?,
                })
            },
        )
        .optional()
}

fn setup_vault_in(
    connection: &mut Connection,
    master_password: &str,
) -> Result<[u8; KEY_LENGTH], String> {
    if master_password.chars().count() < MIN_PASSWORD_LENGTH {
        return Err("Use at least 8 characters".to_string());
    }

    if vault_configured(connection)
        .map_err(|error| format!("Could not read the password vault: {error}"))?
    {
        return Err("The password vault is already set up".to_string());
    }

    let salt = random_bytes::<SALT_LENGTH>()?;
    let key = derive_key(master_password, &salt)?;
    let nonce = random_bytes::<NONCE_LENGTH>()?;
    let ciphertext = encrypt(&key, &nonce, CANARY_PLAINTEXT, b"")?;

    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not save the password vault: {error}"))?;

    transaction
        .execute(
            "INSERT INTO vault_config
               (id, salt, canary_nonce, canary_ciphertext, created_at, updated_at)
             VALUES (1, ?1, ?2, ?3,
                     strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                     strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            params![salt.as_slice(), nonce.as_slice(), ciphertext],
        )
        .map_err(|error| format!("Could not save the password vault: {error}"))?;

    transaction
        .commit()
        .map_err(|error| format!("Could not save the password vault: {error}"))?;

    Ok(key)
}

fn unlock_vault_in(
    connection: &Connection,
    master_password: &str,
) -> Result<[u8; KEY_LENGTH], String> {
    let config = read_vault_config(connection)
        .map_err(|error| format!("Could not read the password vault: {error}"))?;

    let Some(config) = config else {
        return Err("The password vault is not set up".to_string());
    };

    let mut key = derive_key(master_password, &config.salt)?;

    let nonce: [u8; NONCE_LENGTH] = match config.canary_nonce.as_slice().try_into() {
        Ok(nonce) => nonce,
        Err(_) => {
            key.fill(0);
            return Err(UNLOCK_ERROR.to_string());
        }
    };

    let plaintext = match decrypt(&key, &nonce, &config.canary_ciphertext, b"") {
        Ok(plaintext) => plaintext,
        Err(_) => {
            key.fill(0);
            return Err(UNLOCK_ERROR.to_string());
        }
    };

    if plaintext.as_slice() != CANARY_PLAINTEXT {
        key.fill(0);
        return Err(UNLOCK_ERROR.to_string());
    }

    Ok(key)
}

fn new_id(connection: &Connection) -> rusqlite::Result<String> {
    connection.query_row("SELECT lower(hex(randomblob(16)))", [], |row| row.get(0))
}

// Tag names are stored as a JSON array; a malformed value reads as no tags.
fn parse_tags(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default()
}

fn normalize_tags(tags: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut names = Vec::new();

    for tag in tags {
        let name = tag.trim();

        if name.is_empty() {
            continue;
        }

        // Case-insensitive dedupe, first spelling wins.
        if seen.insert(name.to_lowercase()) {
            names.push(name.to_string());
        }
    }

    names
}

// The fields are encrypted, so SQL narrows only by trash and favorite; the
// rest of the filter runs on the decrypted rows. A personal vault is small.
fn read_credential_summaries(
    connection: &Connection,
    key: &[u8; KEY_LENGTH],
    filter: Option<&CredentialFilter>,
) -> Result<Vec<CredentialSummary>, String> {
    // Trashed listings flip the scope and show only deleted rows.
    let trashed = filter.and_then(|filter| filter.trashed) == Some(true);
    let mut condition = format!(
        "deleted_at IS {}",
        if trashed { "NOT NULL" } else { "NULL" }
    );
    if filter.and_then(|filter| filter.favorite) == Some(true) {
        condition.push_str(" AND is_favorite = 1");
    }

    let category = filter
        .and_then(|filter| filter.category.as_deref())
        .filter(|value| !value.is_empty());
    let tag = filter
        .and_then(|filter| filter.tag.as_deref())
        .filter(|value| !value.is_empty())
        .map(str::to_lowercase);
    let query = filter
        .and_then(|filter| filter.query.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_lowercase);

    let summaries = read_credentials(connection, key, &condition, &[])?
        .into_iter()
        .filter(|credential| category.is_none_or(|category| credential.category == category))
        .filter(|credential| {
            tag.as_ref().is_none_or(|tag| {
                credential
                    .tags
                    .iter()
                    .any(|value| value.to_lowercase() == *tag)
            })
        })
        .filter(|credential| {
            query.as_ref().is_none_or(|query| {
                [&credential.service, &credential.username, &credential.category]
                    .into_iter()
                    .chain(credential.tags.iter())
                    .any(|value| value.to_lowercase().contains(query.as_str()))
            })
        })
        .map(|credential| CredentialSummary {
            id: credential.id,
            service: credential.service,
            username: credential.username,
            url: credential.url,
            category: credential.category,
            tags: credential.tags,
            is_favorite: credential.is_favorite,
            deleted_at: credential.deleted_at,
            created_at: credential.created_at,
            updated_at: credential.updated_at,
        })
        .collect();

    Ok(summaries)
}

fn read_credential(
    connection: &Connection,
    key: &[u8; KEY_LENGTH],
    id: &str,
) -> Result<Option<Credential>, String> {
    Ok(read_credentials(
        connection,
        key,
        "id = ?",
        &[rusqlite::types::Value::Text(id.to_string())],
    )?
    .into_iter()
    .next())
}

fn write_credential(
    connection: &mut Connection,
    key: &[u8; KEY_LENGTH],
    input: &CredentialInput,
) -> Result<Credential, String> {
    let service = input.service.trim().to_string();

    if service.is_empty() {
        return Err("Service is required".to_string());
    }

    if input.password.is_empty() {
        return Err("Password is required".to_string());
    }

    let category = {
        let category = input.category.trim();

        if category.is_empty() {
            "Uncategorized".to_string()
        } else {
            category.to_string()
        }
    };
    let data = CredentialData {
        service,
        username: input.username.trim().to_string(),
        password: input.password.clone(),
        url: input.url.trim().to_string(),
        category,
        tags: normalize_tags(&input.tags),
        notes: input.notes.clone(),
    };
    let is_favorite = i64::from(input.is_favorite);
    let fail = |error: rusqlite::Error| format!("Could not save the credential: {error}");

    let transaction = connection.transaction().map_err(fail)?;
    let id = match &input.id {
        Some(id) => {
            let updated = transaction
                .execute(
                    "UPDATE credentials
                     SET is_favorite = ?1,
                         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                     WHERE id = ?2",
                    params![is_favorite, id],
                )
                .map_err(fail)?;

            if updated == 0 {
                return Err("Credential was not found".to_string());
            }

            id.clone()
        }
        None => {
            let id = new_id(&transaction).map_err(fail)?;

            // The readable columns are required by the table, so the row starts
            // blank and the sealed blob is written straight after.
            transaction
                .execute(
                    "INSERT INTO credentials
                       (id, service, password_nonce, password_ciphertext, is_favorite,
                        created_at, updated_at)
                     VALUES (?1, '', x'', x'', ?2,
                             strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                             strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                    params![id, is_favorite],
                )
                .map_err(fail)?;

            id
        }
    };
    write_sealed(&transaction, key, &id, &data)?;
    transaction.commit().map_err(fail)?;

    read_credential(connection, key, &id)?
        .ok_or_else(|| "Could not save the credential".to_string())
}

fn write_credentials_favorite(
    connection: &mut Connection,
    ids: &[String],
    favorite: bool,
) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not update the credentials: {error}"))?;

    for id in ids {
        transaction
            .execute(
                "UPDATE credentials SET is_favorite = ?1 WHERE id = ?2",
                params![i64::from(favorite), id],
            )
            .map_err(|error| format!("Could not update the credentials: {error}"))?;
    }

    transaction
        .commit()
        .map_err(|error| format!("Could not update the credentials: {error}"))
}

fn write_credentials_trashed(connection: &mut Connection, ids: &[String]) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not move the credentials to Trash: {error}"))?;

    for id in ids {
        transaction
            .execute(
                "UPDATE credentials
                 SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                 WHERE id = ?1 AND deleted_at IS NULL",
                params![id],
            )
            .map_err(|error| format!("Could not move the credentials to Trash: {error}"))?;
    }

    transaction
        .commit()
        .map_err(|error| format!("Could not move the credentials to Trash: {error}"))
}

fn write_credentials_restored(connection: &mut Connection, ids: &[String]) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not restore the credentials: {error}"))?;

    for id in ids {
        transaction
            .execute(
                "UPDATE credentials SET deleted_at = NULL
                 WHERE id = ?1 AND deleted_at IS NOT NULL",
                params![id],
            )
            .map_err(|error| format!("Could not restore the credentials: {error}"))?;
    }

    transaction
        .commit()
        .map_err(|error| format!("Could not restore the credentials: {error}"))
}

fn remove_credentials_permanently(
    connection: &mut Connection,
    ids: &[String],
) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not delete the credentials: {error}"))?;

    for id in ids {
        transaction
            .execute("DELETE FROM credentials WHERE id = ?1", params![id])
            .map_err(|error| format!("Could not delete the credentials: {error}"))?;
    }

    transaction
        .commit()
        .map_err(|error| format!("Could not delete the credentials: {error}"))
}

fn vault_status_with_state(
    db: &DatabaseState,
    vault: &VaultKeyState,
) -> Result<VaultStatus, String> {
    let connection = db.require_connection()?;
    let configured = vault_configured(connection.as_ref().expect("checked above"))
        .map_err(|error| format!("Could not read the password vault: {error}"))?;

    Ok(VaultStatus {
        configured,
        unlocked: vault.is_unlocked(),
    })
}

fn setup_vault_with_state(
    db: &DatabaseState,
    vault: &VaultKeyState,
    master_password: &str,
) -> Result<VaultStatus, String> {
    {
        let mut connection = db.require_connection()?;
        let key = setup_vault_in(connection.as_mut().expect("checked above"), master_password)?;
        vault.store(key);
    }

    vault_status_with_state(db, vault)
}

fn unlock_vault_with_state(
    db: &DatabaseState,
    vault: &VaultKeyState,
    master_password: &str,
) -> Result<VaultStatus, String> {
    {
        let mut connection = db.require_connection()?;
        let connection = connection.as_mut().expect("checked above");
        let key = unlock_vault_in(connection, master_password)?;
        // Older rows keep readable fields until the key is here to seal them.
        if convert_legacy_credentials(connection, &key)? > 0 {
            // Rewrites the file so no copy of the old readable fields is left.
            let _ = connection.execute_batch("VACUUM");
        }
        vault.store(key);
    }

    vault_status_with_state(db, vault)
}

fn lock_vault_with_state(db: &DatabaseState, vault: &VaultKeyState) -> Result<VaultStatus, String> {
    vault.clear();
    vault_status_with_state(db, vault)
}

fn list_credentials_with_state(
    db: &DatabaseState,
    vault: &VaultKeyState,
    filter: Option<&CredentialFilter>,
) -> Result<Vec<CredentialSummary>, String> {
    let key = vault.require_key()?;

    let connection = db.require_connection()?;

    read_credential_summaries(connection.as_ref().expect("checked above"), &key, filter)
}

fn load_credential_with_state(
    db: &DatabaseState,
    vault: &VaultKeyState,
    id: &str,
) -> Result<Credential, String> {
    let key = vault.require_key()?;
    let connection = db.require_connection()?;

    read_credential(connection.as_ref().expect("checked above"), &key, id)?
        .ok_or_else(|| "Credential was not found".to_string())
}

fn save_credential_with_state(
    db: &DatabaseState,
    vault: &VaultKeyState,
    input: &CredentialInput,
) -> Result<Credential, String> {
    let key = vault.require_key()?;
    let mut connection = db.require_connection()?;

    write_credential(connection.as_mut().expect("checked above"), &key, input)
}

fn set_credentials_favorite_with_state(
    db: &DatabaseState,
    vault: &VaultKeyState,
    ids: &[String],
    favorite: bool,
) -> Result<(), String> {
    vault.require_key()?;

    if ids.is_empty() {
        return Ok(());
    }

    let mut connection = db.require_connection()?;

    write_credentials_favorite(connection.as_mut().expect("checked above"), ids, favorite)
}

fn trash_credentials_with_state(
    db: &DatabaseState,
    vault: &VaultKeyState,
    ids: &[String],
) -> Result<(), String> {
    vault.require_key()?;

    if ids.is_empty() {
        return Ok(());
    }

    let mut connection = db.require_connection()?;

    write_credentials_trashed(connection.as_mut().expect("checked above"), ids)
}

fn restore_credentials_with_state(
    db: &DatabaseState,
    vault: &VaultKeyState,
    ids: &[String],
) -> Result<(), String> {
    vault.require_key()?;

    if ids.is_empty() {
        return Ok(());
    }

    let mut connection = db.require_connection()?;

    write_credentials_restored(connection.as_mut().expect("checked above"), ids)
}

fn delete_credentials_permanently_with_state(
    db: &DatabaseState,
    vault: &VaultKeyState,
    ids: &[String],
) -> Result<(), String> {
    vault.require_key()?;

    if ids.is_empty() {
        return Ok(());
    }

    let mut connection = db.require_connection()?;

    remove_credentials_permanently(connection.as_mut().expect("checked above"), ids)
}

#[tauri::command]
pub fn vault_status(
    db: State<'_, DatabaseState>,
    vault: State<'_, VaultKeyState>,
) -> Result<VaultStatus, String> {
    vault_status_with_state(db.inner(), vault.inner())
}

#[tauri::command]
pub fn setup_vault(
    master_password: String,
    db: State<'_, DatabaseState>,
    vault: State<'_, VaultKeyState>,
) -> Result<VaultStatus, String> {
    setup_vault_with_state(db.inner(), vault.inner(), &master_password)
}

#[tauri::command]
pub fn unlock_vault(
    master_password: String,
    db: State<'_, DatabaseState>,
    vault: State<'_, VaultKeyState>,
) -> Result<VaultStatus, String> {
    db.check_attempt()?;
    let result = unlock_vault_with_state(db.inner(), vault.inner(), &master_password);
    record_secret_result(&db, &result, UNLOCK_ERROR);
    result
}

#[tauri::command]
pub fn lock_vault(
    db: State<'_, DatabaseState>,
    vault: State<'_, VaultKeyState>,
) -> Result<VaultStatus, String> {
    lock_vault_with_state(db.inner(), vault.inner())
}

#[tauri::command]
pub fn list_credentials(
    filter: Option<CredentialFilter>,
    db: State<'_, DatabaseState>,
    vault: State<'_, VaultKeyState>,
) -> Result<Vec<CredentialSummary>, String> {
    list_credentials_with_state(db.inner(), vault.inner(), filter.as_ref())
}

#[tauri::command]
pub fn load_credential(
    id: String,
    db: State<'_, DatabaseState>,
    vault: State<'_, VaultKeyState>,
) -> Result<Credential, String> {
    load_credential_with_state(db.inner(), vault.inner(), &id)
}

#[tauri::command]
pub fn save_credential(
    input: CredentialInput,
    db: State<'_, DatabaseState>,
    vault: State<'_, VaultKeyState>,
) -> Result<Credential, String> {
    save_credential_with_state(db.inner(), vault.inner(), &input)
}

#[tauri::command]
pub fn set_credentials_favorite(
    ids: Vec<String>,
    favorite: bool,
    db: State<'_, DatabaseState>,
    vault: State<'_, VaultKeyState>,
) -> Result<(), String> {
    set_credentials_favorite_with_state(db.inner(), vault.inner(), &ids, favorite)
}

#[tauri::command]
pub fn trash_credentials(
    ids: Vec<String>,
    db: State<'_, DatabaseState>,
    vault: State<'_, VaultKeyState>,
) -> Result<(), String> {
    trash_credentials_with_state(db.inner(), vault.inner(), &ids)
}

#[tauri::command]
pub fn restore_credentials(
    ids: Vec<String>,
    db: State<'_, DatabaseState>,
    vault: State<'_, VaultKeyState>,
) -> Result<(), String> {
    restore_credentials_with_state(db.inner(), vault.inner(), &ids)
}

#[tauri::command]
pub fn delete_credentials_permanently(
    ids: Vec<String>,
    db: State<'_, DatabaseState>,
    vault: State<'_, VaultKeyState>,
) -> Result<(), String> {
    delete_credentials_permanently_with_state(db.inner(), vault.inner(), &ids)
}

/// A reset needs the app lock password when one is set, or else the password
/// vault's master password when that vault is set up. Returns whether a
/// password was needed, and fails when a needed one is missing or wrong.
fn check_reset_password(connection: &Connection, password: Option<&str>) -> Result<bool, String> {
    if crate::database::has_stored_password_lock(connection)
        .map_err(|error| format!("Could not read app lock: {error}"))?
    {
        let verifier = crate::database::read_password_verifier(connection)
            .map_err(|error| format!("Could not read app lock: {error}"))?
            .unwrap_or_default();
        return match password {
            Some(password) if crate::security::secret_matches(password, &verifier) => Ok(true),
            _ => Err(RESET_PASSWORD_ERROR.to_string()),
        };
    }

    if vault_configured(connection)
        .map_err(|error| format!("Could not read the password vault: {error}"))?
    {
        let Some(password) = password else {
            return Err(RESET_PASSWORD_ERROR.to_string());
        };
        let mut key = unlock_vault_in(connection, password)
            .map_err(|_| RESET_PASSWORD_ERROR.to_string())?;
        key.fill(0);
        return Ok(true);
    }

    Ok(false)
}

const RESET_PASSWORD_ERROR: &str = "That password is not correct";

fn reset_with_state(
    db: &DatabaseState,
    vault: &VaultKeyState,
    password: Option<&str>,
) -> Result<(), String> {
    {
        let connection = db.require_connection()?;
        check_reset_password(connection.as_ref().expect("checked above"), password)?;
    }
    vault.clear();
    db.reset()
}

/// Tells the Danger zone whether to ask for a password before a reset.
#[tauri::command]
pub fn reset_requires_password(db: State<'_, DatabaseState>) -> Result<bool, String> {
    let connection = db.require_connection()?;
    let connection = connection.as_ref().expect("checked above");
    let locked = crate::database::has_stored_password_lock(connection)
        .map_err(|error| format!("Could not read app lock: {error}"))?;
    let vault = vault_configured(connection)
        .map_err(|error| format!("Could not read the password vault: {error}"))?;
    Ok(locked || vault)
}

/// Checks the reset password before the confirm step, so a wrong one never
/// gets past the first screen. The reset itself checks it again.
#[tauri::command]
pub fn verify_reset_password(password: String, db: State<'_, DatabaseState>) -> Result<(), String> {
    db.check_attempt()?;
    let connection = db.require_connection()?;
    let result =
        check_reset_password(connection.as_ref().expect("checked above"), Some(&password));
    record_secret_result(&db, &result, RESET_PASSWORD_ERROR);
    result.map(|_| ())
}

/// Counts only a wrong secret toward the wait; other errors do not.
fn record_secret_result<T>(db: &DatabaseState, result: &Result<T, String>, wrong_message: &str) {
    let wrong = matches!(result, Err(error) if error == wrong_message);
    if wrong || result.is_ok() {
        db.record_attempt(!wrong);
    }
}

// Wipes every note, source, file, password, and setting. The password vault key
// is cleared too, so nothing unlocked survives the reset.
#[tauri::command]
pub fn reset_vault(
    password: Option<String>,
    db: State<'_, DatabaseState>,
    keys: State<'_, VaultKeyState>,
) -> Result<(), String> {
    db.check_attempt()?;
    let result = reset_with_state(db.inner(), keys.inner(), password.as_deref());
    record_secret_result(&db, &result, RESET_PASSWORD_ERROR);
    result
}

/// Copies a password like normal text, so it stays on the clipboard and shows
/// in Win+V. Done in Rust because the webview cannot write the clipboard while
/// Kivo is unfocused.
#[tauri::command]
pub fn copy_secret(text: String) -> Result<(), String> {
    arboard::Clipboard::new()
        .and_then(|mut clipboard| clipboard.set_text(text))
        .map_err(|_| "Could not copy to the clipboard".to_string())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;
    use crate::database::apply_migrations;

    // One temp root holds the database file and the managed folder so Drop can remove both.
    struct TempVault {
        root: PathBuf,
        database_path: PathBuf,
        files_dir: PathBuf,
    }

    impl TempVault {
        fn new(label: &str) -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock is after the Unix epoch")
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "kivo-passwords-{label}-{}-{unique}",
                std::process::id()
            ));

            Self {
                database_path: root.join("kivo.db"),
                files_dir: root.join("files"),
                root,
            }
        }

        fn state(&self) -> DatabaseState {
            let state = DatabaseState::new(self.database_path.clone(), self.files_dir.clone());
            state.initialize().expect("initialize database");
            state
        }
    }

    impl Drop for TempVault {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn reset_needs_the_master_password_once_the_password_vault_is_set_up() {
        let temp = TempVault::new("reset");
        let db = temp.state();
        let vault = VaultKeyState::default();
        setup_vault_with_state(&db, &vault, "correct horse").expect("set up vault");

        assert!(reset_with_state(&db, &vault, None).is_err());
        assert!(reset_with_state(&db, &vault, Some("wrong password")).is_err());
        assert!(vault_status_with_state(&db, &vault).expect("status").configured);

        reset_with_state(&db, &vault, Some("correct horse")).expect("reset with password");
        assert!(!vault_status_with_state(&db, &vault).expect("status").configured);
    }

    fn migrated_memory_database() -> Connection {
        let mut connection = Connection::open_in_memory().expect("open in-memory database");
        apply_migrations(&mut connection).expect("apply migrations");
        connection
    }

    fn credential_input(service: &str, password: &str) -> CredentialInput {
        CredentialInput {
            id: None,
            service: service.to_string(),
            username: String::new(),
            password: password.to_string(),
            url: String::new(),
            category: "Uncategorized".to_string(),
            tags: Vec::new(),
            notes: String::new(),
            is_favorite: false,
        }
    }

    fn unlocked_vault() -> (TempVault, DatabaseState, VaultKeyState) {
        let workspace = TempVault::new("unlocked");
        let db = workspace.state();
        let vault = VaultKeyState::default();
        setup_vault_with_state(&db, &vault, "correct horse battery").expect("setup vault");

        (workspace, db, vault)
    }

    fn raw_secret(db: &DatabaseState, id: &str) -> (Vec<u8>, Vec<u8>) {
        let connection = db.require_connection().expect("lock connection");

        connection
            .as_ref()
            .expect("connection is initialized")
            .query_row(
                "SELECT data_ciphertext, data_nonce FROM credentials WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read raw secret")
    }

    #[test]
    fn setup_stores_a_canary_that_the_right_password_unlocks() {
        let mut connection = migrated_memory_database();
        let key = setup_vault_in(&mut connection, "correct horse battery").expect("setup vault");

        let (salt, nonce, ciphertext): (Vec<u8>, Vec<u8>, Vec<u8>) = connection
            .query_row(
                "SELECT salt, canary_nonce, canary_ciphertext FROM vault_config WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read vault config");

        assert_eq!(salt.len(), SALT_LENGTH);
        assert_eq!(nonce.len(), NONCE_LENGTH);
        assert_ne!(ciphertext.as_slice(), CANARY_PLAINTEXT);
        assert!(!ciphertext
            .windows(13)
            .any(|window| window == CANARY_PLAINTEXT));

        // The stored salt re-derives the same key the setup returned.
        assert_eq!(
            derive_key("correct horse battery", &salt).expect("derive"),
            key
        );
        assert_eq!(
            unlock_vault_in(&connection, "correct horse battery").expect("unlock"),
            key
        );
    }

    #[test]
    fn setup_rejects_short_master_passwords_and_writes_nothing() {
        let workspace = TempVault::new("short-password");
        let db = workspace.state();
        let vault = VaultKeyState::default();

        for short in ["", "short", "1234567"] {
            let error = setup_vault_with_state(&db, &vault, short).expect_err("short rejected");
            assert_eq!(error, "Use at least 8 characters");
        }

        let connection = db.require_connection().expect("lock connection");
        assert!(
            !vault_configured(connection.as_ref().expect("connection is initialized"))
                .expect("read configured"),
            "a rejected setup must not write the vault row"
        );
        assert!(!vault.is_unlocked());
    }

    #[test]
    fn unlock_rejects_a_wrong_password_and_keeps_no_key() {
        let (_workspace, db, vault) = unlocked_vault();
        lock_vault_with_state(&db, &vault).expect("lock");
        assert!(!vault.is_unlocked());

        let error =
            unlock_vault_with_state(&db, &vault, "wrong password").expect_err("wrong password");
        assert_eq!(error, UNLOCK_ERROR);
        assert!(!vault.is_unlocked());
        assert_eq!(
            vault.require_key().expect_err("no key is kept"),
            LOCKED_MESSAGE
        );
    }

    #[test]
    fn encrypting_the_same_plaintext_twice_uses_fresh_nonces_and_output() {
        let key = random_bytes::<KEY_LENGTH>().expect("key");
        let first_nonce = random_bytes::<NONCE_LENGTH>().expect("nonce");
        let second_nonce = random_bytes::<NONCE_LENGTH>().expect("nonce");

        let first = encrypt(&key, &first_nonce, b"hunter2", CREDENTIAL_AAD).expect("encrypt");
        let second = encrypt(&key, &second_nonce, b"hunter2", CREDENTIAL_AAD).expect("encrypt");

        assert_ne!(first_nonce, second_nonce);
        assert_ne!(first.as_slice(), b"hunter2");
        assert_ne!(first, second);
        assert_eq!(
            decrypt(&key, &first_nonce, &first, CREDENTIAL_AAD)
                .expect("decrypt")
                .as_slice(),
            b"hunter2"
        );
    }

    #[test]
    fn tampered_ciphertext_is_rejected() {
        let key = random_bytes::<KEY_LENGTH>().expect("key");
        let nonce = random_bytes::<NONCE_LENGTH>().expect("nonce");
        let mut ciphertext = encrypt(&key, &nonce, b"hunter2", CREDENTIAL_AAD).expect("encrypt");

        let last = ciphertext.len() - 1;
        ciphertext[last] ^= 0x01;

        assert!(decrypt(&key, &nonce, &ciphertext, CREDENTIAL_AAD).is_err());
    }

    #[test]
    fn every_credential_command_refuses_to_run_while_locked() {
        let workspace = TempVault::new("locked");
        let db = workspace.state();
        let vault = VaultKeyState::default();
        let ids = vec!["missing".to_string()];

        assert_eq!(
            list_credentials_with_state(&db, &vault, None).expect_err("locked"),
            LOCKED_MESSAGE
        );
        assert_eq!(
            load_credential_with_state(&db, &vault, "missing").expect_err("locked"),
            LOCKED_MESSAGE
        );
        assert_eq!(
            save_credential_with_state(&db, &vault, &credential_input("GitHub", "secret"))
                .expect_err("locked"),
            LOCKED_MESSAGE
        );
        assert_eq!(
            set_credentials_favorite_with_state(&db, &vault, &ids, true).expect_err("locked"),
            LOCKED_MESSAGE
        );
        assert_eq!(
            trash_credentials_with_state(&db, &vault, &ids).expect_err("locked"),
            LOCKED_MESSAGE
        );
        assert_eq!(
            restore_credentials_with_state(&db, &vault, &ids).expect_err("locked"),
            LOCKED_MESSAGE
        );
        assert_eq!(
            delete_credentials_permanently_with_state(&db, &vault, &ids).expect_err("locked"),
            LOCKED_MESSAGE
        );
    }

    #[test]
    fn credentials_flow_through_save_list_filter_trash_and_delete() {
        let (_workspace, db, vault) = unlocked_vault();

        let work = {
            let mut input = credential_input("GitHub", "gh-secret");
            input.username = "ada".to_string();
            input.category = "Work".to_string();
            input.tags = vec!["Alpha".to_string()];
            input.is_favorite = true;
            input.notes = "work account".to_string();
            save_credential_with_state(&db, &vault, &input).expect("save work")
        };

        let personal = {
            let mut input = credential_input("Gmail", "gm-secret");
            input.username = "ada@example.com".to_string();
            input.category = "Personal".to_string();
            input.tags = vec!["Beta".to_string()];
            save_credential_with_state(&db, &vault, &input).expect("save personal")
        };

        // Favorites sort ahead of the rest.
        let listed = list_credentials_with_state(&db, &vault, None).expect("list");
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, work.id);
        assert!(listed[0].is_favorite);
        assert_eq!(listed[0].tags, vec!["Alpha".to_string()]);
        assert_eq!(listed[1].id, personal.id);

        // Loading returns the plaintext password and notes.
        let loaded = load_credential_with_state(&db, &vault, &work.id).expect("load");
        assert_eq!(loaded.password, "gh-secret");
        assert_eq!(loaded.notes, "work account");

        // Favorite filter.
        let favorites = list_credentials_with_state(
            &db,
            &vault,
            Some(&CredentialFilter {
                favorite: Some(true),
                ..CredentialFilter::default()
            }),
        )
        .expect("list favorites");
        assert_eq!(favorites.len(), 1);
        assert_eq!(favorites[0].id, work.id);

        // Exact category match.
        let personal_only = list_credentials_with_state(
            &db,
            &vault,
            Some(&CredentialFilter {
                category: Some("Personal".to_string()),
                ..CredentialFilter::default()
            }),
        )
        .expect("list personal");
        assert_eq!(personal_only.len(), 1);
        assert_eq!(personal_only[0].id, personal.id);

        // Tag membership, case-insensitive.
        let tagged = list_credentials_with_state(
            &db,
            &vault,
            Some(&CredentialFilter {
                tag: Some("alpha".to_string()),
                ..CredentialFilter::default()
            }),
        )
        .expect("list tagged");
        assert_eq!(tagged.len(), 1);
        assert_eq!(tagged[0].id, work.id);

        // Search is case-insensitive over service, username, and category.
        for query in ["GITHUB", "ada@example.com", "personal"] {
            let found = list_credentials_with_state(
                &db,
                &vault,
                Some(&CredentialFilter {
                    query: Some(query.to_string()),
                    ..CredentialFilter::default()
                }),
            )
            .expect("search");
            assert_eq!(found.len(), 1, "query {query} should match exactly one");
        }

        // Trash hides the row from the live list and surfaces it in the trash view.
        trash_credentials_with_state(&db, &vault, std::slice::from_ref(&work.id)).expect("trash");
        let live = list_credentials_with_state(&db, &vault, None).expect("list live");
        assert_eq!(live.len(), 1);
        assert_eq!(live[0].id, personal.id);

        let trashed = list_credentials_with_state(
            &db,
            &vault,
            Some(&CredentialFilter {
                trashed: Some(true),
                ..CredentialFilter::default()
            }),
        )
        .expect("list trashed");
        assert_eq!(trashed.len(), 1);
        assert_eq!(trashed[0].id, work.id);

        // Restore brings it back.
        restore_credentials_with_state(&db, &vault, std::slice::from_ref(&work.id))
            .expect("restore");
        assert_eq!(
            list_credentials_with_state(&db, &vault, None)
                .expect("list restored")
                .len(),
            2
        );

        // Permanent delete removes the row for good.
        delete_credentials_permanently_with_state(&db, &vault, std::slice::from_ref(&personal.id))
            .expect("delete forever");
        let remaining = list_credentials_with_state(&db, &vault, None).expect("list remaining");
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, work.id);
    }

    #[test]
    fn saved_credentials_store_ciphertext_with_a_fresh_nonce_each_time() {
        let (_workspace, db, vault) = unlocked_vault();
        let mut input = credential_input("GitHub", "hunter2");
        input.username = "ada@example.com".to_string();
        input.url = "https://github.com".to_string();
        input.tags = vec!["WorkTag".to_string()];
        input.notes = "recovery code 1234".to_string();
        let saved = save_credential_with_state(&db, &vault, &input).expect("save");

        let (first_ciphertext, first_nonce) = raw_secret(&db, &saved.id);
        assert_eq!(first_nonce.len(), NONCE_LENGTH);

        // Nothing a person typed is readable anywhere in the stored row.
        let row: String = {
            let connection = db.require_connection().expect("lock connection");
            connection
                .as_ref()
                .expect("connection is initialized")
                .query_row(
                    "SELECT service || username || url || category || tags || notes
                            || hex(password_ciphertext) || hex(data_ciphertext)
                     FROM credentials WHERE id = ?1",
                    params![saved.id],
                    |row| row.get(0),
                )
                .expect("read raw row")
        };
        for plain in ["GitHub", "ada@", "github.com", "WorkTag", "recovery", "hunter2"] {
            assert!(!row.contains(plain), "{plain} is stored readable");
        }
        for plain in [&b"GitHub"[..], b"hunter2", b"recovery"] {
            assert!(!first_ciphertext.windows(plain.len()).any(|window| window == plain));
        }

        let mut update = input.clone();
        update.id = Some(saved.id.clone());
        save_credential_with_state(&db, &vault, &update).expect("update");

        let (second_ciphertext, second_nonce) = raw_secret(&db, &saved.id);
        assert_ne!(first_ciphertext, second_ciphertext);
        assert_ne!(first_nonce, second_nonce);
    }

    #[test]
    fn save_requires_a_service_and_a_password() {
        let (_workspace, db, vault) = unlocked_vault();

        let mut blank_service = credential_input("   ", "secret");
        assert_eq!(
            save_credential_with_state(&db, &vault, &blank_service).expect_err("service required"),
            "Service is required"
        );

        blank_service.service = "GitHub".to_string();
        blank_service.password = String::new();
        assert_eq!(
            save_credential_with_state(&db, &vault, &blank_service).expect_err("password required"),
            "Password is required"
        );

        let mut unknown = credential_input("GitHub", "secret");
        unknown.id = Some("missing".to_string());
        assert_eq!(
            save_credential_with_state(&db, &vault, &unknown).expect_err("unknown id"),
            "Credential was not found"
        );
    }

    #[test]
    fn credential_tags_stay_out_of_the_shared_tag_list() {
        let (_workspace, db, vault) = unlocked_vault();

        let mut input = credential_input("GitHub", "secret");
        input.tags = vec!["Shared".to_string(), "PasswordOnly".to_string()];
        save_credential_with_state(&db, &vault, &input).expect("save");

        let connection = db.require_connection().expect("lock connection");
        let connection = connection.as_ref().expect("connection is initialized");
        connection
            .execute(
                "INSERT INTO items (id, kind, title, tags, created_at, updated_at)
                 VALUES ('item-shared', 'note', 'Shared note', '[\"Shared\"]',
                         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
                [],
            )
            .expect("seed item");

        let tags = crate::vault::read_tags(connection, None).expect("read tags");
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].name, "Shared");
        assert_eq!(tags[0].count, 1);
    }

    #[test]
    fn unlock_converts_rows_saved_by_older_versions() {
        let (_workspace, db, vault) = unlocked_vault();
        let key = vault.require_key().expect("key");

        // A row as older versions wrote it: readable fields, sealed password.
        {
            let connection = db.require_connection().expect("lock connection");
            let connection = connection.as_ref().expect("connection is initialized");
            let nonce = random_bytes::<NONCE_LENGTH>().unwrap();
            let ciphertext = encrypt(&key, &nonce, b"old-secret", CREDENTIAL_AAD).unwrap();
            connection
                .execute(
                    "INSERT INTO credentials (id, service, username, password_nonce,
                       password_ciphertext, url, category, tags, notes, created_at, updated_at)
                     VALUES ('legacy', 'Bank', 'ada', ?1, ?2, 'https://bank.example', 'Banking',
                             '[\"Money\"]', 'pin hint', 'now', 'now')",
                    params![nonce.as_slice(), ciphertext],
                )
                .expect("seed legacy row");
        }

        lock_vault_with_state(&db, &vault).expect("lock");
        unlock_vault_with_state(&db, &vault, "correct horse battery").expect("unlock");

        let loaded = load_credential_with_state(&db, &vault, "legacy").expect("load");
        assert_eq!(loaded.service, "Bank");
        assert_eq!(loaded.username, "ada");
        assert_eq!(loaded.password, "old-secret");
        assert_eq!(loaded.url, "https://bank.example");
        assert_eq!(loaded.category, "Banking");
        assert_eq!(loaded.tags, vec!["Money".to_string()]);
        assert_eq!(loaded.notes, "pin hint");

        let connection = db.require_connection().expect("lock connection");
        let readable: String = connection
            .as_ref()
            .expect("connection is initialized")
            .query_row(
                "SELECT service || username || url || category || tags || notes
                 FROM credentials WHERE id = 'legacy'",
                [],
                |row| row.get(0),
            )
            .expect("read raw row");
        assert_eq!(readable, "[]");
    }

    #[test]
    fn a_blob_moved_to_another_row_does_not_open() {
        let (_workspace, db, vault) = unlocked_vault();
        let first = save_credential_with_state(&db, &vault, &credential_input("Bank", "one"))
            .expect("save first");
        let second = save_credential_with_state(&db, &vault, &credential_input("Forum", "two"))
            .expect("save second");

        {
            let connection = db.require_connection().expect("lock connection");
            connection
                .as_ref()
                .expect("connection is initialized")
                .execute(
                    "UPDATE credentials
                     SET (data_nonce, data_ciphertext) =
                         (SELECT data_nonce, data_ciphertext FROM credentials WHERE id = ?1)
                     WHERE id = ?2",
                    params![first.id, second.id],
                )
                .expect("swap blob");
        }

        assert!(load_credential_with_state(&db, &vault, &second.id).is_err());
    }
}

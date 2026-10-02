use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use argon2::Argon2;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::database::DatabaseState;
use crate::key_slots::{self, VaultScope};

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
pub struct VaultKeyState(Mutex<Option<[u8; KEY_LENGTH]>>, AtomicU64);

impl VaultKeyState {
    pub(crate) fn require_key(&self) -> Result<[u8; KEY_LENGTH], String> {
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

    /// Goes up on every lock. An unlock that started before a lock must not
    /// put its key back afterwards.
    pub(crate) fn generation(&self) -> u64 {
        self.1.load(Ordering::SeqCst)
    }

    /// Stores `key` only if no lock happened since `generation` was read.
    pub(crate) fn store_if_current(&self, mut key: [u8; KEY_LENGTH], generation: u64) -> Result<(), String> {
        let Ok(mut guard) = self.0.lock() else {
            key.fill(0);
            return Err(LOCKED_MESSAGE.to_string());
        };
        if self.generation() != generation {
            key.fill(0);
            return Err("The password vault locked while unlocking. Try again.".to_string());
        }
        *guard = Some(key);
        Ok(())
    }

    pub(crate) fn clear(&self) {
        if let Ok(mut guard) = self.0.lock() {
            self.1.fetch_add(1, Ordering::SeqCst);
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

/// An earlier state of a credential, kept when its details change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialVersion {
    pub id: String,
    pub created_at: String,
    pub service: String,
    pub username: String,
    pub url: String,
    pub password: String,
}

/// One login read from a password export, shown before anything is saved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRow {
    pub service: String,
    pub url: String,
    pub username: String,
    pub password: String,
    pub notes: String,
    /// The saved credential this login matches, if any.
    pub duplicate_of: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub rows: Vec<ImportRow>,
    /// Lines left out because they had no password.
    pub skipped: usize,
}

/// A login the person chose to import. With `replace_id`, only the password
/// of that saved credential changes; the old one moves to its history.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportChoice {
    pub service: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub replace_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub imported: usize,
    pub replaced: usize,
    pub failed: Vec<String>,
}

/// The same size limit as other imports.
const MAX_IMPORT_CSV_BYTES: u64 = 50 * 1024 * 1024;
const NOT_A_PASSWORD_EXPORT: &str = "This file is not a Chrome or Edge password export";

/// How many earlier versions each credential keeps, the same as note history.
const CREDENTIAL_VERSION_LIMIT: i64 = 20;

/// Every field a person typed, sealed as one encrypted blob per row. Only the
/// id, favorite flag, trash stamp and dates stay readable in the database.
#[derive(PartialEq, Serialize, Deserialize)]
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
    open_sealed(key, &credential_aad(id), nonce, ciphertext)
}

fn open_sealed(
    key: &[u8; KEY_LENGTH],
    aad: &[u8],
    nonce: &[u8],
    ciphertext: &[u8],
) -> Result<CredentialData, String> {
    let nonce: [u8; NONCE_LENGTH] = nonce
        .try_into()
        .map_err(|_| "Could not read the credential".to_string())?;
    let json = decrypt(key, &nonce, ciphertext, aad)
        .map_err(|_| "Could not read the credential".to_string())?;
    serde_json::from_slice(&json).map_err(|_| "Could not read the credential".to_string())
}

/// Ties each saved version to its credential and its own row, so versions
/// cannot be swapped between credentials or with the live blob.
fn version_aad(credential_id: &str, version_id: &str) -> Vec<u8> {
    format!("kivo:credential-version:v1:{credential_id}:{version_id}").into_bytes()
}

/// Keeps the credential's current details as a version when `next` changes
/// them, then drops the oldest versions past the limit. Rows still waiting for
/// the legacy conversion have no blob and are skipped.
fn keep_previous_version(
    connection: &Connection,
    key: &[u8; KEY_LENGTH],
    id: &str,
    next: &CredentialData,
) -> Result<(), String> {
    let fail = |error: rusqlite::Error| format!("Could not save the credential: {error}");
    let sealed: Option<(Option<Vec<u8>>, Option<Vec<u8>>)> = connection
        .query_row(
            "SELECT data_nonce, data_ciphertext FROM credentials WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(fail)?;
    let Some((Some(nonce), Some(ciphertext))) = sealed else {
        return Ok(());
    };
    let current = open_credential(key, id, &nonce, &ciphertext)?;

    if &current == next {
        return Ok(());
    }

    let version_id = new_id(connection).map_err(fail)?;
    let json =
        serde_json::to_vec(&current).map_err(|_| "Could not protect the data".to_string())?;
    let version_nonce = random_bytes::<NONCE_LENGTH>()?;
    let version_ciphertext = encrypt(key, &version_nonce, &json, &version_aad(id, &version_id))?;
    connection
        .execute(
            "INSERT INTO credential_versions
               (id, credential_id, created_at, data_nonce, data_ciphertext)
             VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?3, ?4)",
            params![version_id, id, version_nonce.as_slice(), version_ciphertext],
        )
        .map_err(fail)?;
    connection
        .execute(
            "DELETE FROM credential_versions
             WHERE credential_id = ?1 AND id NOT IN (
               SELECT id FROM credential_versions WHERE credential_id = ?1
               ORDER BY created_at DESC, rowid DESC LIMIT ?2
             )",
            params![id, CREDENTIAL_VERSION_LIMIT],
        )
        .map_err(fail)?;
    Ok(())
}

/// Newest first.
fn read_credential_versions(
    connection: &Connection,
    key: &[u8; KEY_LENGTH],
    credential_id: &str,
) -> Result<Vec<CredentialVersion>, String> {
    let fail = |error: rusqlite::Error| format!("Could not read the history: {error}");
    let mut statement = connection
        .prepare(
            "SELECT id, created_at, data_nonce, data_ciphertext FROM credential_versions
             WHERE credential_id = ?1 ORDER BY created_at DESC, rowid DESC",
        )
        .map_err(fail)?;
    let rows = statement
        .query_map(params![credential_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Vec<u8>>(2)?,
                row.get::<_, Vec<u8>>(3)?,
            ))
        })
        .map_err(fail)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(fail)?;

    rows.into_iter()
        .map(|(id, created_at, nonce, ciphertext)| {
            let data = open_sealed(key, &version_aad(credential_id, &id), &nonce, &ciphertext)?;
            Ok(CredentialVersion {
                id,
                created_at,
                service: data.service,
                username: data.username,
                url: data.url,
                password: data.password,
            })
        })
        .collect()
}

/// Ids of credentials whose sealed data no longer opens with the vault key.
pub(crate) fn damaged_credential_ids(
    connection: &Connection,
    key: &[u8; KEY_LENGTH],
) -> Result<Vec<String>, String> {
    let fail = |error: rusqlite::Error| format!("Could not read the credentials: {error}");
    let mut statement = connection
        .prepare(
            "SELECT id, data_nonce, data_ciphertext FROM credentials
             WHERE data_ciphertext IS NOT NULL AND deleted_at IS NULL",
        )
        .map_err(fail)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Vec<u8>>(1)?,
                row.get::<_, Vec<u8>>(2)?,
            ))
        })
        .map_err(fail)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(fail)?;
    Ok(rows
        .into_iter()
        .filter(|(id, nonce, ciphertext)| open_credential(key, id, nonce, ciphertext).is_err())
        .map(|(id, _, _)| id)
        .collect())
}

/// Splits CSV text into records: quoted fields, doubled quotes inside them,
/// line breaks inside quotes, a leading byte-order mark, and CRLF or LF lines.
fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut records = Vec::new();
    let mut record = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();

    while let Some(c) = chars.next() {
        if quoted {
            match c {
                '"' if chars.peek() == Some(&'"') => {
                    field.push('"');
                    chars.next();
                }
                '"' => quoted = false,
                _ => field.push(c),
            }
            continue;
        }
        match c {
            '"' => quoted = true,
            ',' => record.push(std::mem::take(&mut field)),
            '\r' => {}
            '\n' => {
                record.push(std::mem::take(&mut field));
                records.push(std::mem::take(&mut record));
            }
            _ => field.push(c),
        }
    }
    if !field.is_empty() || !record.is_empty() {
        record.push(field);
        records.push(record);
    }
    records.retain(|record| record.iter().any(|field| !field.trim().is_empty()));
    records
}

/// The website part of a URL, lowercased and without `www.`, so
/// `https://www.GitHub.com/login` and `github.com` match.
fn url_host(url: &str) -> String {
    let url = url.trim();
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = host.rsplit_once('@').map_or(host, |(_, host)| host);
    let host = host.split(':').next().unwrap_or("");
    let host = host.to_lowercase();
    host.strip_prefix("www.").map(str::to_string).unwrap_or(host)
}

/// Reads a Chrome or Edge export (`name,url,username,password,note`).
/// Columns are found by header name, so their order does not matter.
fn read_password_csv(text: &str) -> Result<(Vec<ImportRow>, usize), String> {
    let mut records = parse_csv(text).into_iter();
    let header: Vec<String> = records
        .next()
        .ok_or(NOT_A_PASSWORD_EXPORT)?
        .iter()
        .map(|name| name.trim().to_lowercase())
        .collect();
    let column = |name: &str| header.iter().position(|field| field == name);
    let password_column = column("password").ok_or(NOT_A_PASSWORD_EXPORT)?;
    let (name, url, username, note) = (column("name"), column("url"), column("username"), column("note"));
    let cell = |record: &[String], index: Option<usize>| {
        index
            .and_then(|index| record.get(index))
            .map(|value| value.trim().to_string())
            .unwrap_or_default()
    };

    let mut rows = Vec::new();
    let mut skipped = 0;
    for record in records {
        let password = record.get(password_column).cloned().unwrap_or_default();
        if password.is_empty() {
            skipped += 1;
            continue;
        }
        let url = cell(&record, url);
        let service = match cell(&record, name) {
            name if !name.is_empty() => name,
            _ if !url_host(&url).is_empty() => url_host(&url),
            _ => url.clone(),
        };
        if service.is_empty() {
            skipped += 1;
            continue;
        }
        rows.push(ImportRow {
            service,
            url,
            username: cell(&record, username),
            password,
            notes: record
                .get(note.unwrap_or(usize::MAX))
                .cloned()
                .unwrap_or_default(),
            duplicate_of: None,
        });
    }
    Ok((rows, skipped))
}

/// A login matches a saved credential with the same username on the same
/// website. Without a website on either side, the service name decides.
fn same_login(row: &ImportRow, saved: &Credential) -> bool {
    if !row.username.eq_ignore_ascii_case(saved.username.trim()) {
        return false;
    }
    let (row_host, saved_host) = (url_host(&row.url), url_host(&saved.url));
    if !row_host.is_empty() && !saved_host.is_empty() {
        return row_host == saved_host;
    }
    row.service.trim().eq_ignore_ascii_case(saved.service.trim())
}

fn preview_password_import_in(
    connection: &Connection,
    key: &[u8; KEY_LENGTH],
    text: &str,
) -> Result<ImportPreview, String> {
    let (mut rows, skipped) = read_password_csv(text)?;
    let saved = read_credentials(connection, key, "deleted_at IS NULL", &[])?;
    for row in &mut rows {
        row.duplicate_of = saved
            .iter()
            .find(|credential| same_login(row, credential))
            .map(|credential| credential.id.clone());
    }
    Ok(ImportPreview { rows, skipped })
}

/// Saves each chosen login on its own, so one bad line does not stop the rest.
fn import_credentials_in(
    connection: &mut Connection,
    key: &[u8; KEY_LENGTH],
    choices: &[ImportChoice],
) -> ImportResult {
    let mut result = ImportResult::default();
    for choice in choices {
        let saved = match &choice.replace_id {
            Some(id) => read_credential(connection, key, id).and_then(|saved| {
                let saved = saved.ok_or_else(|| "Credential was not found".to_string())?;
                write_credential(
                    connection,
                    key,
                    &CredentialInput {
                        id: Some(saved.id),
                        service: saved.service,
                        username: saved.username,
                        password: choice.password.clone(),
                        url: saved.url,
                        category: saved.category,
                        tags: saved.tags,
                        notes: saved.notes,
                        is_favorite: saved.is_favorite,
                    },
                )
            }),
            None => write_credential(
                connection,
                key,
                &CredentialInput {
                    id: None,
                    service: choice.service.clone(),
                    username: choice.username.clone(),
                    password: choice.password.clone(),
                    url: choice.url.clone(),
                    category: String::new(),
                    tags: Vec::new(),
                    notes: choice.notes.clone(),
                    is_favorite: false,
                },
            ),
        };
        match (saved, &choice.replace_id) {
            (Ok(_), Some(_)) => result.replaced += 1,
            (Ok(_), None) => result.imported += 1,
            (Err(_), _) => result.failed.push(choice.service.clone()),
        }
    }
    result
}

/// Puts a saved version back. The details it replaces are kept as a version
/// first, so a restore can itself be undone.
fn restore_credential_version_in(
    connection: &mut Connection,
    key: &[u8; KEY_LENGTH],
    version_id: &str,
) -> Result<Credential, String> {
    let fail = |error: rusqlite::Error| format!("Could not restore this version: {error}");
    let (credential_id, nonce, ciphertext, is_favorite): (String, Vec<u8>, Vec<u8>, i64) =
        connection
            .query_row(
                "SELECT v.credential_id, v.data_nonce, v.data_ciphertext, c.is_favorite
                 FROM credential_versions v JOIN credentials c ON c.id = v.credential_id
                 WHERE v.id = ?1",
                params![version_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(fail)?
            .ok_or_else(|| "This version was not found".to_string())?;
    let data = open_sealed(key, &version_aad(&credential_id, version_id), &nonce, &ciphertext)?;

    write_credential(
        connection,
        key,
        &CredentialInput {
            id: Some(credential_id),
            service: data.service,
            username: data.username,
            password: data.password,
            url: data.url,
            category: data.category,
            tags: data.tags,
            notes: data.notes,
            is_favorite: is_favorite != 0,
        },
    )
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

pub(crate) fn vault_configured(connection: &Connection) -> rusqlite::Result<bool> {
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

    // A random data key behind a v1 password slot; the password never derives it.
    let key = random_bytes::<KEY_LENGTH>()?;
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
            params![SLOT_SALT_PLACEHOLDER.as_slice(), nonce.as_slice(), ciphertext],
        )
        .map_err(|error| format!("Could not save the password vault: {error}"))?;
    key_slots::install_password_slot(&transaction, VaultScope::Passwords, &key, master_password)?;

    transaction
        .commit()
        .map_err(|error| format!("Could not save the password vault: {error}"))?;

    Ok(key)
}

/// Opens the password vault's data key. A v1 vault opens only through its
/// password slot (never the older derivation); an older vault derives its key
/// from the password as before.
fn unlock_vault_in(
    connection: &Connection,
    master_password: &str,
) -> Result<[u8; KEY_LENGTH], String> {
    if key_slots::has_slots(connection, VaultScope::Passwords)? {
        return key_slots::unlock_with_password(connection, VaultScope::Passwords, master_password)?
            .ok_or_else(|| UNLOCK_ERROR.to_string());
    }
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
            keep_previous_version(&transaction, key, id, &data)?;
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

pub(crate) fn write_credentials_trashed(connection: &mut Connection, ids: &[String]) -> Result<(), String> {
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

pub(crate) fn setup_vault_with_state(
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

/// Unlocks, moving an older vault to a random data key first when every
/// record can be read. See `upgrade_legacy_vault`.
fn unlock_and_upgrade(connection: &mut Connection, master_password: &str) -> Result<[u8; KEY_LENGTH], String> {
    let mut key = unlock_vault_in(connection, master_password)?;
    if key_slots::has_slots(connection, VaultScope::Passwords)? {
        // Rows in the oldest readable-fields format can still arrive (for
        // example from an older backup); seal them with the current key.
        if convert_legacy_credentials(connection, &key)? > 0 {
            let _ = connection.execute_batch("VACUUM");
        }
        return Ok(key);
    }
    match upgrade_legacy_vault(connection, &key, master_password) {
        Ok(new_key) => {
            key.fill(0);
            // Rewrites the file so no copy of the old ciphertext or readable fields is left.
            let _ = connection.execute_batch("VACUUM");
            Ok(new_key)
        }
        // A record that cannot be read blocks the upgrade, which changed
        // nothing; the vault keeps working in its older form until repaired.
        Err(_) => {
            if convert_legacy_credentials(connection, &key)? > 0 {
                let _ = connection.execute_batch("VACUUM");
            }
            Ok(key)
        }
    }
}

pub(crate) fn unlock_vault_with_state(
    db: &DatabaseState,
    vault: &VaultKeyState,
    master_password: &str,
) -> Result<VaultStatus, String> {
    let generation = vault.generation();
    {
        let mut connection = db.require_connection()?;
        let connection = connection.as_mut().expect("checked above");
        let key = unlock_and_upgrade(connection, master_password)?;
        vault.store_if_current(key, generation)?;
    }

    vault_status_with_state(db, vault)
}

/// Checks the password vault's password for recovery setup and turning it
/// off. Moves an older vault to a v1 slot first; a vault that cannot move yet
/// cannot have a recovery kit.
pub(crate) fn authenticate_vault_password(
    connection: &mut Connection,
    master_password: &str,
) -> Result<[u8; KEY_LENGTH], String> {
    let mut key = unlock_and_upgrade(connection, master_password)?;
    if !key_slots::has_slots(connection, VaultScope::Passwords)? {
        key.fill(0);
        return Err("Some saved passwords could not be read. Check vault health, then try again.".to_string());
    }
    Ok(key)
}

pub(crate) const VAULT_PASSWORD_MIN: usize = MIN_PASSWORD_LENGTH;

/// Changes only the password vault's password: its slot is rewrapped, the
/// data key and every saved credential and history entry stay as they are.
fn change_vault_password_with_state(
    db: &DatabaseState,
    current: &str,
    next: &str,
) -> Result<(), String> {
    if next.chars().count() < MIN_PASSWORD_LENGTH {
        return Err("Use at least 8 characters".to_string());
    }
    let mut guard = db.require_connection()?;
    let connection = guard.as_mut().expect("checked above");
    let mut key = unlock_and_upgrade(connection, current)?;
    let result = (|| {
        if !key_slots::has_slots(connection, VaultScope::Passwords)? {
            return Err(
                "Some saved passwords could not be read. Check vault health, then try again."
                    .to_string(),
            );
        }
        let transaction = connection
            .transaction()
            .map_err(|error| format!("Could not change the password: {error}"))?;
        key_slots::replace_password_slot(&transaction, VaultScope::Passwords, &key, next)?;
        transaction
            .commit()
            .map_err(|error| format!("Could not change the password: {error}"))
    })();
    key.fill(0);
    result
}

/// The `vault_config.salt` column is NOT NULL from the original schema. A v1
/// vault never derives a key from it, so it holds this fixed placeholder.
const SLOT_SALT_PLACEHOLDER: [u8; SALT_LENGTH] = [0; SALT_LENGTH];

/// Moves an older password vault (key derived from the password) to a random
/// data key behind a v1 password slot. Every credential, pre-blob row and
/// history entry is read and authenticated first without changing anything;
/// then one transaction re-encrypts all of them with fresh nonces, replaces the
/// canary, retires the old salt and installs the slot. Ids, dates, favorites
/// and Trash state stay. Any failure leaves the vault exactly as it was.
fn upgrade_legacy_vault(
    connection: &mut Connection,
    old_key: &[u8; KEY_LENGTH],
    master_password: &str,
) -> Result<[u8; KEY_LENGTH], String> {
    let fail = |error: rusqlite::Error| format!("Could not update the password vault: {error}");

    // 1. Read and authenticate everything with the old key.
    let rows: Vec<(String, Option<Vec<u8>>, Option<Vec<u8>>, Vec<u8>, Vec<u8>, String, String, String, String, String, String)> = {
        let mut statement = connection
            .prepare(
                "SELECT id, data_nonce, data_ciphertext, password_nonce, password_ciphertext,
                        service, username, url, category, tags, notes
                 FROM credentials",
            )
            .map_err(fail)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?,
                    row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?, row.get(10)?,
                ))
            })
            .map_err(fail)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(fail)?;
        rows
    };
    let mut credentials = Vec::with_capacity(rows.len());
    for (id, data_nonce, data_ciphertext, password_nonce, password_ciphertext, service, username, url, category, tags, notes) in rows {
        let data = match (data_nonce, data_ciphertext) {
            (Some(nonce), Some(ciphertext)) => open_credential(old_key, &id, &nonce, &ciphertext)?,
            _ => {
                let nonce: [u8; NONCE_LENGTH] = password_nonce
                    .as_slice()
                    .try_into()
                    .map_err(|_| "Could not read the credential".to_string())?;
                let password = decrypt(old_key, &nonce, &password_ciphertext, CREDENTIAL_AAD)
                    .ok()
                    .and_then(|bytes| String::from_utf8(bytes).ok())
                    .ok_or_else(|| "Could not read the credential".to_string())?;
                CredentialData { service, username, password, url, category, tags: parse_tags(&tags), notes }
            }
        };
        credentials.push((id, data));
    }
    let version_rows: Vec<(String, String, Vec<u8>, Vec<u8>)> = {
        let mut statement = connection
            .prepare("SELECT id, credential_id, data_nonce, data_ciphertext FROM credential_versions")
            .map_err(fail)?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
            .map_err(fail)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(fail)?;
        rows
    };
    let mut versions = Vec::with_capacity(version_rows.len());
    for (id, credential_id, nonce, ciphertext) in version_rows {
        let nonce: [u8; NONCE_LENGTH] = nonce
            .as_slice()
            .try_into()
            .map_err(|_| "Could not read the history".to_string())?;
        let plain = decrypt(old_key, &nonce, &ciphertext, &version_aad(&credential_id, &id))
            .map_err(|_| "Could not read the history".to_string())?;
        versions.push((id, credential_id, zeroize::Zeroizing::new(plain)));
    }

    // 2. Rewrite everything under a new random key in one transaction.
    let new_key = random_bytes::<KEY_LENGTH>()?;
    let transaction = connection.transaction().map_err(fail)?;
    for (id, data) in &credentials {
        write_sealed(&transaction, &new_key, id, data)?;
    }
    for (id, credential_id, plain) in &versions {
        let nonce = random_bytes::<NONCE_LENGTH>()?;
        let ciphertext = encrypt(&new_key, &nonce, plain, &version_aad(credential_id, id))?;
        transaction
            .execute(
                "UPDATE credential_versions SET data_nonce = ?1, data_ciphertext = ?2 WHERE id = ?3",
                params![nonce.as_slice(), ciphertext, id],
            )
            .map_err(fail)?;
    }
    let canary_nonce = random_bytes::<NONCE_LENGTH>()?;
    let canary = encrypt(&new_key, &canary_nonce, CANARY_PLAINTEXT, b"")?;
    transaction
        .execute(
            "UPDATE vault_config
             SET salt = ?1, canary_nonce = ?2, canary_ciphertext = ?3,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = 1",
            params![SLOT_SALT_PLACEHOLDER.as_slice(), canary_nonce.as_slice(), canary],
        )
        .map_err(fail)?;
    key_slots::install_password_slot(&transaction, VaultScope::Passwords, &new_key, master_password)?;
    transaction.commit().map_err(fail)?;
    Ok(new_key)
}

fn lock_vault_with_state(db: &DatabaseState, vault: &VaultKeyState) -> Result<VaultStatus, String> {
    vault.clear();
    db.clear_pending_recovery();
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

pub(crate) fn load_credential_with_state(
    db: &DatabaseState,
    vault: &VaultKeyState,
    id: &str,
) -> Result<Credential, String> {
    let key = vault.require_key()?;
    let connection = db.require_connection()?;

    read_credential(connection.as_ref().expect("checked above"), &key, id)?
        .ok_or_else(|| "Credential was not found".to_string())
}

pub(crate) fn save_credential_with_state(
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

#[tauri::command(async)]
pub fn vault_status(
    db: State<'_, DatabaseState>,
    vault: State<'_, VaultKeyState>,
) -> Result<VaultStatus, String> {
    vault_status_with_state(db.inner(), vault.inner())
}

#[tauri::command(async)]
pub fn setup_vault(
    master_password: String,
    db: State<'_, DatabaseState>,
    vault: State<'_, VaultKeyState>,
) -> Result<VaultStatus, String> {
    setup_vault_with_state(db.inner(), vault.inner(), &master_password)
}

#[tauri::command(async)]
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

#[tauri::command(async)]
pub fn change_password_vault_password(
    current: String,
    next: String,
    db: State<'_, DatabaseState>,
) -> Result<(), String> {
    db.check_attempt()?;
    let result = change_vault_password_with_state(db.inner(), &current, &next);
    record_secret_result(&db, &result, UNLOCK_ERROR);
    if result.is_ok() {
        db.revoke_device_unlock("passwords");
    }
    result
}

#[tauri::command(async)]
pub fn lock_vault(
    db: State<'_, DatabaseState>,
    vault: State<'_, VaultKeyState>,
) -> Result<VaultStatus, String> {
    lock_vault_with_state(db.inner(), vault.inner())
}

#[tauri::command(async)]
pub fn list_credentials(
    filter: Option<CredentialFilter>,
    db: State<'_, DatabaseState>,
    vault: State<'_, VaultKeyState>,
) -> Result<Vec<CredentialSummary>, String> {
    list_credentials_with_state(db.inner(), vault.inner(), filter.as_ref())
}

#[tauri::command(async)]
pub fn load_credential(
    id: String,
    db: State<'_, DatabaseState>,
    vault: State<'_, VaultKeyState>,
) -> Result<Credential, String> {
    load_credential_with_state(db.inner(), vault.inner(), &id)
}

#[tauri::command(async)]
pub fn save_credential(
    input: CredentialInput,
    db: State<'_, DatabaseState>,
    vault: State<'_, VaultKeyState>,
) -> Result<Credential, String> {
    save_credential_with_state(db.inner(), vault.inner(), &input)
}

#[tauri::command(async)]
pub fn list_credential_versions(
    id: String,
    db: State<'_, DatabaseState>,
    vault: State<'_, VaultKeyState>,
) -> Result<Vec<CredentialVersion>, String> {
    let key = vault.require_key()?;
    let connection = db.require_connection()?;

    read_credential_versions(connection.as_ref().expect("checked above"), &key, &id)
}

#[tauri::command(async)]
pub fn restore_credential_version(
    version_id: String,
    db: State<'_, DatabaseState>,
    vault: State<'_, VaultKeyState>,
) -> Result<Credential, String> {
    let key = vault.require_key()?;
    let mut connection = db.require_connection()?;

    restore_credential_version_in(connection.as_mut().expect("checked above"), &key, &version_id)
}

#[tauri::command(async)]
pub fn pick_password_csv(app: AppHandle) -> Result<Option<String>, String> {
    Ok(app
        .dialog()
        .file()
        .add_filter("Password export (CSV)", &["csv"])
        .blocking_pick_file()
        .map(|path| path.to_string()))
}

#[tauri::command(async)]
pub fn preview_password_import(
    path: String,
    db: State<'_, DatabaseState>,
    vault: State<'_, VaultKeyState>,
) -> Result<ImportPreview, String> {
    let key = vault.require_key()?;
    let size = std::fs::metadata(&path)
        .map_err(|error| format!("Could not read the file: {error}"))?
        .len();
    if size > MAX_IMPORT_CSV_BYTES {
        return Err("This file is too large to import".to_string());
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|error| format!("Could not read the file: {error}"))?;
    let connection = db.require_connection()?;

    preview_password_import_in(connection.as_ref().expect("checked above"), &key, &text)
}

#[tauri::command(async)]
pub fn import_credentials(
    choices: Vec<ImportChoice>,
    db: State<'_, DatabaseState>,
    vault: State<'_, VaultKeyState>,
) -> Result<ImportResult, String> {
    let key = vault.require_key()?;
    let mut connection = db.require_connection()?;

    Ok(import_credentials_in(connection.as_mut().expect("checked above"), &key, &choices))
}

#[tauri::command(async)]
pub fn set_credentials_favorite(
    ids: Vec<String>,
    favorite: bool,
    db: State<'_, DatabaseState>,
    vault: State<'_, VaultKeyState>,
) -> Result<(), String> {
    set_credentials_favorite_with_state(db.inner(), vault.inner(), &ids, favorite)
}

#[tauri::command(async)]
pub fn trash_credentials(
    ids: Vec<String>,
    db: State<'_, DatabaseState>,
    vault: State<'_, VaultKeyState>,
) -> Result<(), String> {
    trash_credentials_with_state(db.inner(), vault.inner(), &ids)
}

#[tauri::command(async)]
pub fn restore_credentials(
    ids: Vec<String>,
    db: State<'_, DatabaseState>,
    vault: State<'_, VaultKeyState>,
) -> Result<(), String> {
    restore_credentials_with_state(db.inner(), vault.inner(), &ids)
}

#[tauri::command(async)]
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
#[tauri::command(async)]
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
#[tauri::command(async)]
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
#[tauri::command(async)]
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

/// Copies a password. By default it is copied like normal text, so it stays on
/// the clipboard and shows in Win+V. The clipboard preferences can keep it out
/// of Win+V history and clear it after a delay, but only if the clipboard still
/// holds it, so anything the user copied since is kept. Done in Rust because
/// the webview cannot write the clipboard while Kivo is unfocused.
#[tauri::command(async)]
pub fn copy_secret(text: String, db: State<'_, DatabaseState>) -> Result<(), String> {
    let (clear_seconds, exclude_history) = {
        let connection = db.require_connection()?;
        let preferences =
            crate::database::read_preferences(connection.as_ref().expect("checked above"))
                .map_err(|error| format!("Could not read preferences: {error}"))?;
        (
            preferences.clipboard_clear_seconds,
            preferences.clipboard_exclude_history,
        )
    };
    let mut clipboard =
        arboard::Clipboard::new().map_err(|_| "Could not copy to the clipboard".to_string())?;

    #[cfg(windows)]
    let written = if exclude_history {
        use arboard::SetExtWindows;
        clipboard
            .set()
            .exclude_from_history()
            .exclude_from_cloud()
            .text(text.as_str())
    } else {
        clipboard.set_text(text.as_str())
    };
    #[cfg(not(windows))]
    let written = {
        let _ = exclude_history;
        clipboard.set_text(text.as_str())
    };

    written.map_err(|_| "Could not copy to the clipboard".to_string())?;

    if clear_seconds > 0 {
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(clear_seconds as u64));

            if let Ok(mut clipboard) = arboard::Clipboard::new() {
                if clipboard.get_text().is_ok_and(|current| current == text) {
                    let _ = clipboard.clear();
                }
            }
        });
    }

    Ok(())
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

        // T24: the data key is random behind a v1 slot; the password does not derive it.
        assert_eq!(salt, SLOT_SALT_PLACEHOLDER.to_vec());
        assert!(key_slots::has_slots(&connection, VaultScope::Passwords).expect("slots"));
        assert_ne!(
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

    fn versions(db: &DatabaseState, vault: &VaultKeyState, id: &str) -> Vec<CredentialVersion> {
        let key = vault.require_key().expect("vault is unlocked");
        let connection = db.require_connection().expect("lock connection");
        read_credential_versions(connection.as_ref().expect("connection is initialized"), &key, id)
            .expect("read versions")
    }

    fn resave(db: &DatabaseState, vault: &VaultKeyState, id: &str, password: &str) -> Credential {
        let mut input = credential_input("Bank", password);
        input.id = Some(id.to_string());
        save_credential_with_state(db, vault, &input).expect("save change")
    }

    #[test]
    fn changing_a_credential_keeps_the_old_details_and_restore_brings_them_back() {
        let (_workspace, db, vault) = unlocked_vault();
        let saved = save_credential_with_state(&db, &vault, &credential_input("Bank", "old-pass"))
            .expect("save");
        assert!(versions(&db, &vault, &saved.id).is_empty(), "a new credential has no history");

        resave(&db, &vault, &saved.id, "old-pass");
        assert!(
            versions(&db, &vault, &saved.id).is_empty(),
            "saving without a change keeps no version"
        );

        resave(&db, &vault, &saved.id, "new-pass");
        let history = versions(&db, &vault, &saved.id);
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].password, "old-pass");
        assert_eq!(history[0].service, "Bank");

        let restored = {
            let key = vault.require_key().expect("vault is unlocked");
            let mut connection = db.require_connection().expect("lock connection");
            restore_credential_version_in(
                connection.as_mut().expect("connection is initialized"),
                &key,
                &history[0].id,
            )
            .expect("restore version")
        };
        assert_eq!(restored.password, "old-pass");

        let history = versions(&db, &vault, &saved.id);
        assert_eq!(history.len(), 2, "the replaced details are kept too");
        assert_eq!(history[0].password, "new-pass");
    }

    #[test]
    fn history_keeps_only_the_newest_twenty_versions() {
        let (_workspace, db, vault) = unlocked_vault();
        let saved = save_credential_with_state(&db, &vault, &credential_input("Bank", "pass-0"))
            .expect("save");
        for n in 1..=25 {
            resave(&db, &vault, &saved.id, &format!("pass-{n}"));
        }

        let history = versions(&db, &vault, &saved.id);
        assert_eq!(history.len(), 20);
        assert_eq!(history[0].password, "pass-24");
        assert_eq!(history[19].password, "pass-5");
    }

    #[test]
    fn csv_reader_handles_quotes_line_breaks_and_a_byte_order_mark() {
        let text = "\u{feff}name,url,username,password,note\r\n\
                    \"Bank, Main\",https://bank.example/login,ada,\"pa\"\"ss\",\"line one\nline two\"\r\n\
                    \r\n";
        let records = parse_csv(text);
        assert_eq!(records.len(), 2, "blank lines are dropped");
        assert_eq!(
            records[1],
            vec!["Bank, Main", "https://bank.example/login", "ada", "pa\"ss", "line one\nline two"]
        );
    }

    #[test]
    fn password_export_columns_are_found_by_name_and_empty_passwords_are_skipped() {
        let text = "url,password,username,name\n\
                    https://www.GitHub.com/login,one,ada,\n\
                    https://forum.example,,bob,Forum\n";
        let (rows, skipped) = read_password_csv(text).expect("read export");
        assert_eq!(skipped, 1);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].service, "github.com", "an empty name falls back to the website");
        assert_eq!(rows[0].username, "ada");
        assert_eq!(rows[0].password, "one");

        assert_eq!(
            read_password_csv("name,url,username\nBank,,ada\n").unwrap_err(),
            NOT_A_PASSWORD_EXPORT
        );
        assert_eq!(read_password_csv("").unwrap_err(), NOT_A_PASSWORD_EXPORT);
    }

    #[test]
    fn url_host_ignores_scheme_www_port_path_and_case() {
        assert_eq!(url_host("https://www.GitHub.com:443/login?x=1"), "github.com");
        assert_eq!(url_host("github.com"), "github.com");
        assert_eq!(url_host("android://hash@com.example.app/"), "com.example.app");
        assert_eq!(url_host(""), "");
    }

    #[test]
    fn import_marks_duplicates_and_replace_keeps_the_old_password_in_history() {
        let (_workspace, db, vault) = unlocked_vault();
        let mut input = credential_input("GitHub", "old-pass");
        input.username = "ada".to_string();
        input.url = "https://github.com".to_string();
        input.category = "Development".to_string();
        let saved = save_credential_with_state(&db, &vault, &input).expect("save");

        let text = "name,url,username,password,note\n\
                    github.com,https://www.github.com/session,ADA,new-pass,\n\
                    Forum,https://forum.example,ada,forum-pass,hi\n";
        let key = vault.require_key().expect("vault is unlocked");
        let preview = {
            let connection = db.require_connection().expect("lock connection");
            preview_password_import_in(connection.as_ref().expect("connection is initialized"), &key, text)
                .expect("preview")
        };
        assert_eq!(preview.rows[0].duplicate_of.as_deref(), Some(saved.id.as_str()));
        assert_eq!(preview.rows[1].duplicate_of, None);

        let choices: Vec<ImportChoice> = preview
            .rows
            .iter()
            .map(|row| ImportChoice {
                service: row.service.clone(),
                url: row.url.clone(),
                username: row.username.clone(),
                password: row.password.clone(),
                notes: row.notes.clone(),
                replace_id: row.duplicate_of.clone(),
            })
            .collect();
        let result = {
            let mut connection = db.require_connection().expect("lock connection");
            import_credentials_in(connection.as_mut().expect("connection is initialized"), &key, &choices)
        };
        assert_eq!(result, ImportResult { imported: 1, replaced: 1, failed: Vec::new() });

        let updated = load_credential_with_state(&db, &vault, &saved.id).expect("load");
        assert_eq!(updated.password, "new-pass");
        assert_eq!(updated.category, "Development", "replace only changes the password");
        let history = versions(&db, &vault, &saved.id);
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].password, "old-pass");
    }

    #[test]
    fn health_check_finds_credentials_that_no_longer_open() {
        let (_workspace, db, vault) = unlocked_vault();
        save_credential_with_state(&db, &vault, &credential_input("Bank", "one"))
            .expect("save good");
        let bad = save_credential_with_state(&db, &vault, &credential_input("Forum", "two"))
            .expect("save bad");
        let key = vault.require_key().expect("vault is unlocked");
        let connection = db.require_connection().expect("lock connection");
        let connection = connection.as_ref().expect("connection is initialized");
        connection
            .execute("UPDATE credentials SET data_ciphertext = x'00' WHERE id = ?1", params![bad.id])
            .expect("damage credential");

        assert_eq!(damaged_credential_ids(connection, &key).expect("check"), vec![bad.id]);
    }

    #[test]
    fn a_version_moved_to_another_credential_does_not_open() {
        let (_workspace, db, vault) = unlocked_vault();
        let first = save_credential_with_state(&db, &vault, &credential_input("Bank", "one"))
            .expect("save first");
        let second = save_credential_with_state(&db, &vault, &credential_input("Forum", "two"))
            .expect("save second");
        resave(&db, &vault, &first.id, "one-changed");

        {
            let connection = db.require_connection().expect("lock connection");
            connection
                .as_ref()
                .expect("connection is initialized")
                .execute(
                    "UPDATE credential_versions SET credential_id = ?1 WHERE credential_id = ?2",
                    params![second.id, first.id],
                )
                .expect("move version");
        }

        let key = vault.require_key().expect("vault is unlocked");
        let connection = db.require_connection().expect("lock connection");
        assert!(read_credential_versions(
            connection.as_ref().expect("connection is initialized"),
            &key,
            &second.id
        )
        .is_err());
    }

    // T24 phase 1 baselines: the two vaults before key slots or recovery exist.

    const T24_CONTENT_PASSWORD: &str = "content master password";
    const T24_VAULT_PASSWORD: &str = "credential vault password";

    /// One database with content encryption on and a password vault, each with its own password.
    fn t24_two_vaults() -> (TempVault, DatabaseState, VaultKeyState) {
        let workspace = TempVault::new("t24-two-vaults");
        let db = workspace.state();
        {
            let mut guard = db.require_connection().expect("lock connection");
            let connection = guard.as_mut().expect("connection is initialized");
            crate::database::write_password_verifier(
                connection,
                &crate::security::hash_secret(T24_CONTENT_PASSWORD).expect("hash"),
            )
            .expect("set content password");
            crate::encryption::enable(connection, &workspace.files_dir, T24_CONTENT_PASSWORD)
                .expect("enable content encryption");
        }
        let vault = VaultKeyState::default();
        setup_vault_with_state(&db, &vault, T24_VAULT_PASSWORD).expect("setup vault");
        (workspace, db, vault)
    }

    #[test]
    fn t24_each_vault_password_opens_only_its_own_vault() {
        let (_workspace, db, vault) = t24_two_vaults();
        vault.clear();
        let guard = db.require_connection().expect("lock connection");
        let connection = guard.as_ref().expect("connection is initialized");

        assert!(unlock_vault_in(connection, T24_CONTENT_PASSWORD).is_err());
        assert!(unlock_vault_in(connection, T24_VAULT_PASSWORD).is_ok());
        assert_eq!(
            crate::encryption::unlock(connection, T24_VAULT_PASSWORD).expect("unlock call"),
            None
        );
        assert!(crate::encryption::unlock(connection, T24_CONTENT_PASSWORD)
            .expect("unlock call")
            .is_some());
    }

    #[test]
    fn t24_current_and_historical_credentials_survive_reopening() {
        let (workspace, db, vault) = t24_two_vaults();
        let saved = save_credential_with_state(&db, &vault, &credential_input("Bank", "old-pass"))
            .expect("save");
        resave(&db, &vault, &saved.id, "new-pass");
        drop(db);
        vault.clear();

        let reopened = workspace.state();
        let fresh = VaultKeyState::default();
        unlock_vault_with_state(&reopened, &fresh, T24_VAULT_PASSWORD).expect("unlock");

        let current = load_credential_with_state(&reopened, &fresh, &saved.id).expect("load");
        assert_eq!(current.password, "new-pass");
        let history = versions(&reopened, &fresh, &saved.id);
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].password, "old-pass");
    }

    #[test]
    fn t24_wrong_password_or_altered_canary_installs_no_key() {
        let (_workspace, db, vault) = t24_two_vaults();
        vault.clear();

        assert!(unlock_vault_with_state(&db, &vault, "wrong password").is_err());
        assert!(vault.require_key().is_err());

        // A v1 vault proves its key with the stored key check (the canary is
        // only for older vaults), so alter that instead.
        {
            let guard = db.require_connection().expect("lock connection");
            let connection = guard.as_ref().expect("connection is initialized");
            let mut check: Vec<u8> = connection
                .query_row("SELECT key_check FROM vault_keys WHERE scope = 'passwords'", [], |row| {
                    row.get(0)
                })
                .expect("read key check");
            *check.last_mut().expect("key check has bytes") ^= 1;
            connection
                .execute(
                    "UPDATE vault_keys SET key_check = ?1 WHERE scope = 'passwords'",
                    params![check],
                )
                .expect("alter key check");
        }

        assert!(unlock_vault_with_state(&db, &vault, T24_VAULT_PASSWORD).is_err());
        assert!(vault.require_key().is_err());
    }

    // ---- T24 phase 5: password vault on a random key behind a v1 slot ----

    const T24_OLD_PASSWORD: &str = "legacy vault password";

    /// A password vault as older Kivo versions stored it: the key derived from
    /// the password, a canary, sealed credentials (one trashed, one with
    /// history) and one row in the oldest readable-fields format.
    fn t24_legacy_vault() -> (TempVault, DatabaseState, VaultKeyState, [u8; KEY_LENGTH], String, String) {
        let workspace = TempVault::new("t24-legacy");
        let db = workspace.state();
        let salt = random_bytes::<SALT_LENGTH>().unwrap();
        let old_key = derive_key(T24_OLD_PASSWORD, &salt).unwrap();
        {
            let guard = db.require_connection().unwrap();
            let connection = guard.as_ref().unwrap();
            let nonce = random_bytes::<NONCE_LENGTH>().unwrap();
            let canary = encrypt(&old_key, &nonce, CANARY_PLAINTEXT, b"").unwrap();
            connection
                .execute(
                    "INSERT INTO vault_config (id, salt, canary_nonce, canary_ciphertext, created_at, updated_at)
                     VALUES (1, ?1, ?2, ?3, 'then', 'then')",
                    params![salt.as_slice(), nonce.as_slice(), canary],
                )
                .unwrap();
        }
        let vault = VaultKeyState::default();
        vault.store(old_key);
        let bank = save_credential_with_state(&db, &vault, &credential_input("Bank", "old-pass")).unwrap();
        resave(&db, &vault, &bank.id, "new-pass");
        let forum = save_credential_with_state(&db, &vault, &credential_input("Forum", "forum-pass")).unwrap();
        trash_credentials_with_state(&db, &vault, &[forum.id.clone()]).unwrap();
        {
            let guard = db.require_connection().unwrap();
            let nonce = random_bytes::<NONCE_LENGTH>().unwrap();
            let ciphertext = encrypt(&old_key, &nonce, b"oldest-secret", CREDENTIAL_AAD).unwrap();
            guard
                .as_ref()
                .unwrap()
                .execute(
                    "INSERT INTO credentials (id, service, username, password_nonce, password_ciphertext,
                       url, category, tags, notes, created_at, updated_at)
                     VALUES ('oldest', 'Mail', 'ada', ?1, ?2, '', 'Email', '[]', '', 'then', 'then')",
                    params![nonce.as_slice(), ciphertext],
                )
                .unwrap();
        }
        vault.clear();
        (workspace, db, vault, old_key, bank.id, forum.id)
    }

    fn t24_has_slot(db: &DatabaseState) -> bool {
        let guard = db.require_connection().unwrap();
        key_slots::has_slots(guard.as_ref().unwrap(), VaultScope::Passwords).unwrap()
    }

    #[test]
    fn t24_older_vault_moves_to_a_random_key_and_keeps_everything() {
        let (workspace, db, vault, old_key, bank, forum) = t24_legacy_vault();
        let (old_nonce, old_ciphertext) = raw_secret(&db, &bank);

        unlock_vault_with_state(&db, &vault, T24_OLD_PASSWORD).expect("unlock and upgrade");

        assert!(t24_has_slot(&db));
        let new_key = vault.require_key().unwrap();
        assert_ne!(new_key, old_key, "the old password-derived key is no longer the vault key");
        let (new_nonce, new_ciphertext) = raw_secret(&db, &bank);
        assert_ne!(new_nonce, old_nonce, "fresh nonces");
        assert_ne!(new_ciphertext, old_ciphertext);
        assert!(open_credential(&old_key, &bank, &new_nonce, &new_ciphertext).is_err());

        assert_eq!(load_credential_with_state(&db, &vault, &bank).unwrap().password, "new-pass");
        assert_eq!(versions(&db, &vault, &bank)[0].password, "old-pass");
        let trashed = load_credential_with_state(&db, &vault, &forum).unwrap();
        assert!(trashed.deleted_at.is_some(), "Trash state is kept");
        let oldest = load_credential_with_state(&db, &vault, "oldest").unwrap();
        assert_eq!((oldest.password.as_str(), oldest.created_at.as_str()), ("oldest-secret", "then"));
        {
            let guard = db.require_connection().unwrap();
            let salt: Vec<u8> = guard
                .as_ref()
                .unwrap()
                .query_row("SELECT salt FROM vault_config WHERE id = 1", [], |row| row.get(0))
                .unwrap();
            assert_eq!(salt, SLOT_SALT_PLACEHOLDER.to_vec(), "the old derivation salt is retired");
        }

        // Survives a restart and still refuses the wrong password.
        drop(db);
        let reopened = workspace.state();
        let fresh = VaultKeyState::default();
        assert!(unlock_vault_with_state(&reopened, &fresh, "wrong password").is_err());
        unlock_vault_with_state(&reopened, &fresh, T24_OLD_PASSWORD).expect("unlock after restart");
        assert_eq!(fresh.require_key().unwrap(), new_key);
        assert!(check_reset_password(reopened.require_connection().unwrap().as_ref().unwrap(), Some(T24_OLD_PASSWORD)).unwrap());
    }

    #[test]
    fn t24_a_record_that_cannot_be_read_blocks_the_upgrade_without_changing_anything() {
        let (_workspace, db, vault, old_key, bank, _forum) = t24_legacy_vault();
        {
            let guard = db.require_connection().unwrap();
            guard
                .as_ref()
                .unwrap()
                .execute("UPDATE credential_versions SET data_ciphertext = x'00112233445566778899aabbccddeeff00'", [])
                .unwrap();
        }
        let before = raw_secret(&db, &bank);

        unlock_vault_with_state(&db, &vault, T24_OLD_PASSWORD).expect("still unlocks the older way");

        assert!(!t24_has_slot(&db), "no half-upgraded state");
        assert_eq!(vault.require_key().unwrap(), old_key);
        assert_eq!(raw_secret(&db, &bank), before);
        assert_eq!(load_credential_with_state(&db, &vault, &bank).unwrap().password, "new-pass");
        assert!(change_vault_password_with_state(&db, T24_OLD_PASSWORD, "another long password").is_err());
    }

    #[test]
    fn t24_changing_the_vault_password_rewraps_only_the_slot() {
        let (_workspace, db, vault) = unlocked_vault();
        let saved = save_credential_with_state(&db, &vault, &credential_input("Bank", "secret")).unwrap();
        let key = vault.require_key().unwrap();
        let before = raw_secret(&db, &saved.id);

        assert!(change_vault_password_with_state(&db, "correct horse battery", "short").is_err());
        assert!(change_vault_password_with_state(&db, "wrong password", "a long new password").is_err());
        change_vault_password_with_state(&db, "correct horse battery", "a long new password").unwrap();

        assert_eq!(raw_secret(&db, &saved.id), before, "credentials are not re-encrypted");
        let guard = db.require_connection().unwrap();
        let connection = guard.as_ref().unwrap();
        assert!(unlock_vault_in(connection, "correct horse battery").is_err());
        assert_eq!(unlock_vault_in(connection, "a long new password").unwrap(), key);
    }

    #[test]
    fn t24_content_password_change_leaves_the_password_vault_alone() {
        let (_workspace, db, vault) = t24_two_vaults();
        vault.clear();
        {
            let mut guard = db.require_connection().unwrap();
            crate::encryption::change_password(guard.as_mut().unwrap(), T24_CONTENT_PASSWORD, "new content password")
                .unwrap();
        }
        assert!(unlock_vault_with_state(&db, &vault, T24_VAULT_PASSWORD).is_ok());
        assert!(unlock_vault_with_state(&db, &vault, "new content password").is_err());
    }

    #[test]
    fn t24_a_lock_during_unlock_keeps_the_vault_locked() {
        let vault = VaultKeyState::default();
        let generation = vault.generation();
        vault.clear();

        assert!(vault.store_if_current([7; KEY_LENGTH], generation).is_err());
        assert!(vault.require_key().is_err());
        assert!(vault.store_if_current([7; KEY_LENGTH], vault.generation()).is_ok());
    }
}

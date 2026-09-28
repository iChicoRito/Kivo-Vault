use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use argon2::Argon2;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

use crate::database::{self, DatabaseState};
use crate::security::{hash_secret, secret_matches};

const KEY_LEN: usize = 32;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
const KEY_AAD: &[u8] = b"kivo:main-vault-key:v1";

#[derive(Default)]
pub struct ContentKeyState(Mutex<Option<[u8; KEY_LEN]>>);

impl ContentKeyState {
    pub fn store(&self, key: [u8; KEY_LEN]) -> Result<(), String> {
        let mut current = self.0.lock().map_err(|_| "Vault is locked".to_string())?;
        if let Some(previous) = current.as_mut() {
            previous.fill(0);
        }
        *current = Some(key);
        Ok(())
    }

    pub fn require_key(&self) -> Result<[u8; KEY_LEN], String> {
        self.0
            .lock()
            .map_err(|_| "Vault is locked".to_string())?
            .as_ref()
            .copied()
            .ok_or_else(|| "Vault is locked".to_string())
    }

    pub fn clear(&self) -> Result<(), String> {
        let mut current = self.0.lock().map_err(|_| "Vault is locked".to_string())?;
        if let Some(key) = current.as_mut() {
            key.fill(0);
        }
        *current = None;
        Ok(())
    }
}

pub struct WrappedVaultKey {
    pub salt: Vec<u8>,
    pub wrapped: Vec<u8>,
}

fn random_array<const N: usize>() -> Result<[u8; N], String> {
    let mut value = [0; N];
    getrandom::getrandom(&mut value).map_err(|_| "Could not create encryption key".to_string())?;
    Ok(value)
}

pub(crate) fn derive_key(password: &str, salt: &[u8]) -> Result<[u8; KEY_LEN], String> {
    if salt.len() != SALT_LEN {
        return Err("Could not unlock protected data".to_string());
    }

    let mut key = [0; KEY_LEN];
    Argon2::default()
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|_| "Could not unlock protected data".to_string())?;
    Ok(key)
}

pub fn new_vault_key() -> Result<[u8; KEY_LEN], String> {
    random_array()
}

pub fn encrypt_bytes(key: &[u8; KEY_LEN], plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, String> {
    let nonce = random_array::<NONCE_LEN>()?;
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|_| "Could not protect data".to_string())?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| "Could not protect data".to_string())?;

    let mut result = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    result.extend_from_slice(&nonce);
    result.extend_from_slice(&ciphertext);
    Ok(result)
}

pub fn decrypt_bytes(key: &[u8; KEY_LEN], stored: &[u8], aad: &[u8]) -> Result<Vec<u8>, String> {
    if stored.len() < NONCE_LEN + TAG_LEN {
        return Err("Could not read protected data".to_string());
    }

    let (nonce, ciphertext) = stored.split_at(NONCE_LEN);
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|_| "Could not read protected data".to_string())?;
    cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|_| "Could not read protected data".to_string())
}

pub fn wrap_vault_key(key: &[u8; KEY_LEN], password: &str) -> Result<WrappedVaultKey, String> {
    if password.trim().is_empty() {
        return Err("Password is required".to_string());
    }

    let salt = random_array::<SALT_LEN>()?;
    let mut wrapping_key = derive_key(password, &salt)?;
    let wrapped = encrypt_bytes(&wrapping_key, key, KEY_AAD);
    wrapping_key.fill(0);

    Ok(WrappedVaultKey {
        salt: salt.to_vec(),
        wrapped: wrapped?,
    })
}

pub fn unwrap_vault_key(
    salt: &[u8],
    wrapped: &[u8],
    password: &str,
) -> Result<[u8; KEY_LEN], String> {
    let mut wrapping_key = derive_key(password, salt)?;
    let unwrapped = decrypt_bytes(&wrapping_key, wrapped, KEY_AAD);
    wrapping_key.fill(0);

    let data = unwrapped.map_err(|_| "Could not unlock protected data".to_string())?;
    data.try_into()
        .map_err(|_| "Could not unlock protected data".to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectionState {
    pub lock_enabled: bool,
    pub encryption_enabled: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionSummary {
    pub item_count: usize,
    pub file_count: usize,
}

/// The encrypted fields of one item. `title`, `tags` and `file_name` are None in
/// secrets written before names were sealed; readers then keep the column.
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct ProtectedItem {
    pub description: String,
    pub content: Option<String>,
    pub url: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub file_name: Option<String>,
}

fn collection_aad(id: &str) -> Vec<u8> {
    format!("kivo:collection:v1:{id}").into_bytes()
}
fn version_title_aad(id: &str) -> Vec<u8> {
    format!("kivo:version-title:v1:{id}").into_bytes()
}

fn open_text(key: &[u8; 32], bytes: &[u8], aad: &[u8]) -> Result<String, String> {
    String::from_utf8(decrypt_bytes(key, bytes, aad)?)
        .map_err(|_| "Could not read protected data".into())
}

pub fn open_collection_name(key: &[u8; 32], id: &str, bytes: &[u8]) -> Result<String, String> {
    open_text(key, bytes, &collection_aad(id))
}

pub fn seal_version_title(key: &[u8; 32], id: &str, title: &str) -> Result<Vec<u8>, String> {
    encrypt_bytes(key, title.as_bytes(), &version_title_aad(id))
}

pub fn open_version_title(key: &[u8; 32], id: &str, bytes: &[u8]) -> Result<String, String> {
    open_text(key, bytes, &version_title_aad(id))
}

/// Stored in `files.original_name` while the real name is sealed. The extension
/// stays so previews and opening still pick the right program.
fn placeholder_file_name(name: &str) -> String {
    match Path::new(name).extension().and_then(|ext| ext.to_str()) {
        Some(ext) => format!("file.{ext}"),
        None => "file".to_string(),
    }
}

/// Moves every readable title, tag list, file name, collection name and version
/// title into its encrypted field, then blanks the column. It only touches rows
/// that still hold readable text, so running it again is cheap and safe. Writers
/// call it after saving, and unlock calls it to finish any older or unfinished
/// rows.
pub fn seal_all(connection: &Connection, key: &[u8; 32]) -> Result<(), String> {
    let fail = |error: rusqlite::Error| format!("Could not protect names: {error}");
    let rows: Vec<(String, String, String)> = {
        let mut statement = connection
            .prepare("SELECT id, title, tags FROM items WHERE title <> '' OR tags <> '[]'")
            .map_err(fail)?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(fail)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(fail)?;
        rows
    };
    for (id, title, tags) in rows {
        let mut secret = read_secret(connection, key, &id).unwrap_or_default();
        if !title.is_empty() {
            secret.title = Some(title);
        }
        if tags != "[]" {
            secret.tags = Some(serde_json::from_str(&tags).unwrap_or_default());
        }
        if secret.file_name.is_none() {
            let name: Option<String> = connection
                .query_row(
                    "SELECT original_name FROM files WHERE item_id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(fail)?;
            if let Some(name) = name {
                connection
                    .execute(
                        "UPDATE files SET original_name = ?2 WHERE item_id = ?1",
                        params![id, placeholder_file_name(&name)],
                    )
                    .map_err(fail)?;
                secret.file_name = Some(name);
            }
        }
        write_secret(connection, key, &id, &secret)?;
        connection
            .execute(
                "UPDATE items SET title = '', tags = '[]' WHERE id = ?1",
                params![id],
            )
            .map_err(fail)?;
    }

    let collections: Vec<(String, String)> = {
        let mut statement = connection
            .prepare("SELECT id, name FROM collections WHERE name_secret IS NULL")
            .map_err(fail)?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(fail)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(fail)?;
        rows
    };
    for (id, name) in collections {
        // The id keeps the UNIQUE name column satisfied without a readable name.
        connection
            .execute(
                "UPDATE collections SET name = id, name_secret = ?2 WHERE id = ?1",
                params![id, encrypt_bytes(key, name.as_bytes(), &collection_aad(&id))?],
            )
            .map_err(fail)?;
    }

    let versions: Vec<(String, String)> = {
        let mut statement = connection
            .prepare("SELECT id, title FROM item_versions WHERE title <> ''")
            .map_err(fail)?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(fail)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(fail)?;
        rows
    };
    for (id, title) in versions {
        connection
            .execute(
                "UPDATE item_versions SET title = '', title_secret = ?2 WHERE id = ?1",
                params![id, encrypt_bytes(key, title.as_bytes(), &version_title_aad(&id))?],
            )
            .map_err(fail)?;
    }
    Ok(())
}

/// Reverse of `seal_all`, used when encryption is turned off.
fn unseal_all(connection: &Connection, key: &[u8; 32]) -> Result<(), String> {
    let fail = |error: rusqlite::Error| format!("Could not restore names: {error}");
    let collections: Vec<(String, Vec<u8>)> = {
        let mut statement = connection
            .prepare("SELECT id, name_secret FROM collections WHERE name_secret IS NOT NULL")
            .map_err(fail)?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(fail)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(fail)?;
        rows
    };
    for (id, sealed) in collections {
        connection
            .execute(
                "UPDATE collections SET name = ?2, name_secret = NULL WHERE id = ?1",
                params![id, open_collection_name(key, &id, &sealed)?],
            )
            .map_err(fail)?;
    }
    let versions: Vec<(String, Vec<u8>)> = {
        let mut statement = connection
            .prepare("SELECT id, title_secret FROM item_versions WHERE title_secret IS NOT NULL")
            .map_err(fail)?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(fail)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(fail)?;
        rows
    };
    for (id, sealed) in versions {
        connection
            .execute(
                "UPDATE item_versions SET title = ?2, title_secret = NULL WHERE id = ?1",
                params![id, open_version_title(key, &id, &sealed)?],
            )
            .map_err(fail)?;
    }
    Ok(())
}

fn item_aad(id: &str) -> Vec<u8> {
    format!("kivo:item:v1:{id}").into_bytes()
}
fn version_aad(id: &str) -> Vec<u8> {
    format!("kivo:version:v1:{id}").into_bytes()
}
fn file_aad(id: &str) -> Vec<u8> {
    format!("kivo:file:v1:{id}").into_bytes()
}

pub fn encrypt_file(key: &[u8; 32], id: &str, bytes: &[u8]) -> Result<Vec<u8>, String> {
    encrypt_bytes(key, bytes, &file_aad(id))
}
pub fn decrypt_file(key: &[u8; 32], id: &str, bytes: &[u8]) -> Result<Vec<u8>, String> {
    decrypt_bytes(key, bytes, &file_aad(id))
}

pub fn is_enabled(connection: &Connection) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT COALESCE((SELECT encryption_enabled FROM security WHERE id=1),0)",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value != 0)
        .map_err(|error| format!("Could not read protection state: {error}"))
}

pub fn key_if_enabled(
    connection: &Connection,
    keys: &ContentKeyState,
) -> Result<Option<[u8; 32]>, String> {
    if is_enabled(connection)? {
        keys.require_key().map(Some)
    } else {
        Ok(None)
    }
}

pub fn write_secret(
    connection: &Connection,
    key: &[u8; 32],
    id: &str,
    value: &ProtectedItem,
) -> Result<(), String> {
    // A caller that only changes the body leaves the sealed names as they were.
    let mut value = value.clone();
    if value.title.is_none() || value.tags.is_none() || value.file_name.is_none() {
        if let Ok(previous) = read_secret(connection, key, id) {
            value.title = value.title.or(previous.title);
            value.tags = value.tags.or(previous.tags);
            value.file_name = value.file_name.or(previous.file_name);
        }
    }
    let bytes = serde_json::to_vec(&value).map_err(|_| "Could not protect data".to_string())?;
    let encrypted = encrypt_bytes(key, &bytes, &item_aad(id))?;
    connection.execute("INSERT INTO item_secrets(item_id,nonce,ciphertext) VALUES (?1,?2,?3) ON CONFLICT(item_id) DO UPDATE SET nonce=excluded.nonce,ciphertext=excluded.ciphertext", params![id, &encrypted[..NONCE_LEN], &encrypted[NONCE_LEN..]])
        .map_err(|error| format!("Could not save protected item: {error}"))?;
    Ok(())
}

pub fn read_secret(
    connection: &Connection,
    key: &[u8; 32],
    id: &str,
) -> Result<ProtectedItem, String> {
    let (nonce, ciphertext): (Vec<u8>, Vec<u8>) = connection
        .query_row(
            "SELECT nonce,ciphertext FROM item_secrets WHERE item_id=?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "Could not read protected data".to_string())?;
    if nonce.len() != NONCE_LEN {
        return Err("Could not read protected data".into());
    }
    let mut stored = nonce;
    stored.extend(ciphertext);
    let bytes = decrypt_bytes(key, &stored, &item_aad(id))?;
    serde_json::from_slice(&bytes).map_err(|_| "Could not read protected data".into())
}

pub fn encrypt_version(key: &[u8; 32], id: &str, content: &str) -> Result<Vec<u8>, String> {
    encrypt_bytes(key, content.as_bytes(), &version_aad(id))
}
pub fn decrypt_version(key: &[u8; 32], id: &str, bytes: &[u8]) -> Result<String, String> {
    String::from_utf8(decrypt_bytes(key, bytes, &version_aad(id))?)
        .map_err(|_| "Could not read protected data".into())
}
// Read path for note versions once content encryption is wired into the vault.
#[allow(dead_code)]
pub fn read_version(connection: &Connection, key: &[u8; 32], id: &str) -> Result<String, String> {
    let bytes: Vec<u8> = connection
        .query_row(
            "SELECT encrypted_content FROM item_versions WHERE id=?1",
            params![id],
            |r| r.get(0),
        )
        .map_err(|_| "Could not read protected data".to_string())?;
    decrypt_version(key, id, &bytes)
}

fn verifier_matches(connection: &Connection, password: &str) -> Result<bool, String> {
    Ok(database::read_password_verifier(connection)
        .map_err(|error| error.to_string())?
        .is_some_and(|hash| secret_matches(password, &hash)))
}

pub fn unlock(connection: &Connection, password: &str) -> Result<Option<[u8; 32]>, String> {
    if !verifier_matches(connection, password)? {
        return Ok(None);
    }
    if !is_enabled(connection)? {
        return Ok(None);
    }
    let (salt, wrapped): (Vec<u8>, Vec<u8>) = connection
        .query_row(
            "SELECT encryption_salt, wrapped_key FROM security WHERE id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| "Could not unlock protected data".to_string())?;
    unwrap_vault_key(&salt, &wrapped, password).map(Some)
}

/// Where decrypted copies of encrypted files go when the user opens them.
pub fn temp_dir() -> PathBuf {
    std::env::temp_dir().join("kivo-decrypted")
}

/// Deletes every decrypted temporary copy. A copy still open in another app may
/// stay behind on Windows; the next lock or app start tries again.
pub fn clear_temp_files() {
    let _ = fs::remove_dir_all(temp_dir());
}

fn journal(files_dir: &Path) -> PathBuf {
    files_dir.with_extension("content-conversion")
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && Path::new(name).file_name().is_some_and(|part| part == name)
        && name != "."
        && name != ".."
}

fn file_rows(connection: &Connection) -> Result<Vec<(String, String, bool)>, String> {
    let mut statement = connection
        .prepare("SELECT item_id,stored_name,encrypted FROM files ORDER BY item_id")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)? != 0,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;
    Ok(rows)
}

struct PreparedFiles {
    names: Vec<String>,
}

// The committed database flag alone cannot tell which side of the journal is
// the protected side: enabling stores plaintext in "old", disabling stores it
// in "new". Recording the direction lets recovery pick the bytes that match the
// committed flag in every case.
#[derive(Serialize, Deserialize)]
struct JournalMarker {
    encrypt: bool,
    names: Vec<String>,
}

// A ready journal always contains both old and new bytes. Recovery chooses by
// the committed database flag, including when a process exits during a swap.
fn stage_files(
    connection: &Connection,
    files_dir: &Path,
    key: &[u8; 32],
    encrypt: bool,
) -> Result<PreparedFiles, String> {
    let rows = file_rows(connection)?;
    let stage = journal(files_dir);
    if stage.exists() {
        return Err("File conversion needs recovery before retry".into());
    }
    fs::create_dir(&stage).map_err(|error| format!("Could not stage files: {error}"))?;
    let result = (|| {
        fs::create_dir(stage.join("old")).map_err(|error| error.to_string())?;
        fs::create_dir(stage.join("new")).map_err(|error| error.to_string())?;
        let mut names = Vec::new();
        for (id, name, stored_encrypted) in rows {
            if !valid_name(&name) || stored_encrypted == encrypt {
                return Err("Managed file state is inconsistent".into());
            }
            let old = fs::read(files_dir.join(&name))
                .map_err(|_| "A managed file is missing or unreadable".to_string())?;
            let new = if encrypt {
                encrypt_file(key, &id, &old)?
            } else {
                decrypt_file(key, &id, &old)?
            };
            for (folder, bytes) in [("old", &old), ("new", &new)] {
                let path = stage.join(folder).join(&name);
                let file = fs::File::create(&path).map_err(|error| error.to_string())?;
                use std::io::Write;
                let mut file = file;
                file.write_all(bytes)
                    .and_then(|_| file.sync_all())
                    .map_err(|error| error.to_string())?;
            }
            names.push(name);
        }
        let marker = JournalMarker {
            encrypt,
            names: names.clone(),
        };
        let marker_json = serde_json::to_vec(&marker).map_err(|error| error.to_string())?;
        let mut ready = fs::File::create(stage.join("ready")).map_err(|error| error.to_string())?;
        use std::io::Write;
        ready
            .write_all(&marker_json)
            .and_then(|_| ready.sync_all())
            .map_err(|error| error.to_string())?;
        Ok(PreparedFiles { names })
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&stage);
    }
    result
}

fn replace_file(source: &Path, target: &Path, stage: &Path) -> Result<(), String> {
    let temp = stage.join("replacement");
    fs::copy(source, &temp).map_err(|error| error.to_string())?;
    // A read-only handle cannot flush on Windows; open for write so sync_all succeeds.
    fs::OpenOptions::new()
        .write(true)
        .open(&temp)
        .and_then(|file| file.sync_all())
        .map_err(|error| error.to_string())?;
    let displaced = stage.join("displaced");
    if displaced.exists() {
        fs::remove_file(&displaced).map_err(|error| error.to_string())?;
    }
    if target.exists() {
        fs::rename(target, &displaced).map_err(|error| error.to_string())?;
    }
    fs::rename(&temp, target).map_err(|error| error.to_string())?;
    fs::remove_file(displaced).map_err(|error| error.to_string())?;
    Ok(())
}

fn swap_files(files_dir: &Path, prepared: &PreparedFiles) -> Result<(), String> {
    let stage = journal(files_dir);
    for name in &prepared.names {
        replace_file(&stage.join("new").join(name), &files_dir.join(name), &stage)?;
    }
    Ok(())
}

pub fn recover_files(connection: &Connection, files_dir: &Path) -> Result<(), String> {
    let stage = journal(files_dir);
    if !stage.exists() {
        return Ok(());
    }
    let marker = stage.join("ready");
    if marker.exists() {
        let ready: JournalMarker =
            serde_json::from_slice(&fs::read(&marker).map_err(|error| error.to_string())?)
                .map_err(|_| "File conversion journal is damaged".to_string())?;
        // "new" holds the operation's target bytes. Re-apply them only when the
        // committed flag agrees with the operation; otherwise restore "old".
        let source = if is_enabled(connection)? == ready.encrypt {
            "new"
        } else {
            "old"
        };
        for name in ready.names {
            if !valid_name(&name) || !stage.join(source).join(&name).is_file() {
                return Err("File conversion journal is damaged".into());
            }
            replace_file(
                &stage.join(source).join(&name),
                &files_dir.join(name),
                &stage,
            )?;
        }
    }
    fs::remove_dir_all(stage).map_err(|error| format!("Could not finish file recovery: {error}"))
}

pub fn enable(
    connection: &mut Connection,
    files_dir: &Path,
    password: &str,
) -> Result<[u8; 32], String> {
    recover_files(connection, files_dir)?;
    if is_enabled(connection)? {
        return Err("Encryption is already enabled".into());
    }
    if !database::has_stored_password_lock(connection).map_err(|error| error.to_string())? {
        return Err("Set a Master Password before enabling encryption".into());
    }
    if !verifier_matches(connection, password)? {
        return Err("Incorrect Master Password".into());
    }
    let key = new_vault_key()?;
    let wrapped = wrap_vault_key(&key, password)?;
    let prepared = stage_files(connection, files_dir, &key, true)?;
    let outcome = (|| {
        let tx = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        let rows = {
            let mut statement = tx
                .prepare("SELECT id,description,content,url FROM items")
                .map_err(|error| error.to_string())?;
            let rows = statement
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        ProtectedItem {
                            description: r.get(1)?,
                            content: r.get(2)?,
                            url: r.get(3)?,
                            ..Default::default()
                        },
                    ))
                })
                .map_err(|error| error.to_string())?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|error| error.to_string())?;
            rows
        };
        for (id, item) in &rows {
            write_secret(&tx, &key, id, item)?;
            tx.execute(
                "UPDATE items SET description='',content=NULL,url=NULL WHERE id=?1",
                params![id],
            )
            .map_err(|error| error.to_string())?;
        }
        let versions = {
            let mut statement = tx
                .prepare("SELECT id,content FROM item_versions")
                .map_err(|error| error.to_string())?;
            let rows = statement
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(|error| error.to_string())?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|error| error.to_string())?;
            rows
        };
        for (id, body) in versions {
            tx.execute(
                "UPDATE item_versions SET content='',encrypted_content=?2 WHERE id=?1",
                params![id, encrypt_version(&key, &id, &body)?],
            )
            .map_err(|error| error.to_string())?;
        }
        seal_all(&tx, &key)?;
        tx.execute("DELETE FROM item_search", [])
            .map_err(|error| error.to_string())?;
        // Related-search vectors are derived from plaintext. They must not
        // survive while encryption is on. The migration that creates the table
        // may not be present yet in older test databases.
        let has_vectors: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='item_vectors'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if has_vectors > 0 {
            tx.execute("DELETE FROM item_vectors", [])
                .map_err(|error| error.to_string())?;
        }
        tx.execute("UPDATE index_state SET needs_index=0,indexed_at=NULL,status='pending',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", []).map_err(|error| error.to_string())?;
        tx.execute("UPDATE files SET encrypted=1", [])
            .map_err(|error| error.to_string())?;
        swap_files(files_dir, &prepared)?;
        tx.execute(
            "UPDATE security SET encryption_enabled=1,encryption_salt=?1,wrapped_key=?2 WHERE id=1",
            params![wrapped.salt, wrapped.wrapped],
        )
        .map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(key)
    })();
    recover_files(connection, files_dir)?;
    if outcome.is_ok() {
        // Rewrites the file so plaintext written before secure_delete was on
        // leaves no copy in free pages. A failure here does not undo encryption.
        let _ = connection.execute_batch("VACUUM");
    }
    outcome
}

pub fn disable(
    connection: &mut Connection,
    files_dir: &Path,
    password: &str,
) -> Result<ConversionSummary, String> {
    recover_files(connection, files_dir)?;
    if !is_enabled(connection)? {
        return Err("Encryption is not enabled".into());
    }
    let key =
        unlock(connection, password)?.ok_or_else(|| "Incorrect Master Password".to_string())?;
    // Verify every row before any file is replaced. A bad tag leaves state unchanged.
    let ids = {
        let mut statement = connection
            .prepare("SELECT id FROM items")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    let items = ids
        .iter()
        .map(|id| read_secret(connection, &key, id).map(|value| (id.clone(), value)))
        .collect::<Result<Vec<_>, _>>()?;
    let versions = {
        let mut statement = connection
            .prepare("SELECT id,encrypted_content FROM item_versions")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
            })
            .map_err(|error| error.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    let versions = versions
        .iter()
        .map(|(id, bytes)| decrypt_version(&key, id, bytes).map(|text| (id.clone(), text)))
        .collect::<Result<Vec<_>, _>>()?;
    let prepared = stage_files(connection, files_dir, &key, false)?;
    let count = prepared.names.len();
    let outcome = (|| {
        let tx = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        for (id, item) in &items {
            tx.execute(
                "UPDATE items SET description=?2,content=?3,url=?4 WHERE id=?1",
                params![id, item.description, item.content, item.url],
            )
            .map_err(|error| error.to_string())?;
            if let Some(title) = &item.title {
                tx.execute("UPDATE items SET title=?2 WHERE id=?1", params![id, title])
                    .map_err(|error| error.to_string())?;
            }
            if let Some(tags) = &item.tags {
                let tags = serde_json::to_string(tags).map_err(|error| error.to_string())?;
                tx.execute("UPDATE items SET tags=?2 WHERE id=?1", params![id, tags])
                    .map_err(|error| error.to_string())?;
            }
            if let Some(name) = &item.file_name {
                tx.execute(
                    "UPDATE files SET original_name=?2 WHERE item_id=?1",
                    params![id, name],
                )
                .map_err(|error| error.to_string())?;
            }
        }
        unseal_all(&tx, &key)?;
        for (id, body) in &versions {
            tx.execute(
                "UPDATE item_versions SET content=?2,encrypted_content=NULL WHERE id=?1",
                params![id, body],
            )
            .map_err(|error| error.to_string())?;
        }
        tx.execute("DELETE FROM item_secrets", [])
            .map_err(|error| error.to_string())?;
        tx.execute("UPDATE files SET encrypted=0", [])
            .map_err(|error| error.to_string())?;
        tx.execute("UPDATE index_state SET needs_index=1,indexed_at=NULL,status='pending',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", []).map_err(|error| error.to_string())?;
        swap_files(files_dir, &prepared)?;
        tx.execute("UPDATE security SET encryption_enabled=0,encryption_salt=NULL,wrapped_key=NULL WHERE id=1", []).map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(ConversionSummary {
            item_count: items.len(),
            file_count: count,
        })
    })();
    recover_files(connection, files_dir)?;
    outcome
}

pub fn change_password(
    connection: &mut Connection,
    current: &str,
    next: &str,
) -> Result<(), String> {
    if !verifier_matches(connection, current)? {
        return Err("Incorrect Master Password".into());
    }
    let verifier = hash_secret(next)?;
    let wrapped = if is_enabled(connection)? {
        let key = unlock(connection, current)?
            .ok_or_else(|| "Could not unlock protected data".to_string())?;
        Some(wrap_vault_key(&key, next)?)
    } else {
        None
    };
    let tx = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    if let Some(wrapped) = wrapped {
        tx.execute("UPDATE security SET password_verifier=?1,encryption_salt=?2,wrapped_key=?3,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=1", params![verifier,wrapped.salt,wrapped.wrapped]).map_err(|error| error.to_string())?;
    } else {
        tx.execute("UPDATE security SET password_verifier=?1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=1", params![verifier]).map_err(|error| error.to_string())?;
    }
    tx.commit().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn read_protection_state(state: State<'_, DatabaseState>) -> Result<ProtectionState, String> {
    let guard = state.require_connection()?;
    let connection = guard.as_ref().expect("checked above");
    Ok(ProtectionState {
        lock_enabled: database::has_stored_password_lock(connection)
            .map_err(|error| error.to_string())?,
        encryption_enabled: is_enabled(connection)?,
    })
}

#[tauri::command]
pub fn unlock_content_vault(
    password: String,
    state: State<'_, DatabaseState>,
) -> Result<bool, String> {
    let guard = state.require_connection()?;
    let connection = guard.as_ref().expect("checked above");
    state.check_attempt()?;
    let matched = if !is_enabled(connection)? {
        verifier_matches(connection, &password)?
    } else {
        match unlock(connection, &password)? {
            Some(key) => {
                // Finishes rows saved before names were sealed.
                seal_all(connection, &key)?;
                state.content_key().store(key)?;
                true
            }
            None => false,
        }
    };
    state.record_attempt(matched);
    Ok(matched)
}

/// Counts a wrong Master Password toward the wait; other errors do not.
fn record_password_result<T>(state: &DatabaseState, result: &Result<T, String>) {
    let wrong = matches!(result, Err(error) if error == "Incorrect Master Password");
    if wrong || result.is_ok() {
        state.record_attempt(!wrong);
    }
}

#[tauri::command]
pub fn lock_content_vault(state: State<'_, DatabaseState>) -> Result<(), String> {
    clear_temp_files();
    state.clear_unlocked_collections();
    state.content_key().clear()
}

#[tauri::command]
pub fn enable_encryption(
    password: String,
    state: State<'_, DatabaseState>,
) -> Result<ConversionSummary, String> {
    let mut guard = state.require_connection()?;
    let connection = guard.as_mut().expect("checked above");
    state.check_attempt()?;
    let key = enable(connection, state.files_dir(), &password);
    record_password_result(&state, &key);
    let key = key?;
    state.content_key().store(key)?;
    let items: i64 = connection
        .query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
        .map_err(|error| error.to_string())?;
    let files: i64 = connection
        .query_row("SELECT COUNT(*) FROM files", [], |r| r.get(0))
        .map_err(|error| error.to_string())?;
    Ok(ConversionSummary {
        item_count: items as usize,
        file_count: files as usize,
    })
}

#[tauri::command]
pub fn disable_encryption(
    password: String,
    state: State<'_, DatabaseState>,
) -> Result<ConversionSummary, String> {
    let mut guard = state.require_connection()?;
    state.check_attempt()?;
    let result = disable(
        guard.as_mut().expect("checked above"),
        state.files_dir(),
        &password,
    );
    record_password_result(&state, &result);
    let result = result?;
    state.content_key().clear()?;
    Ok(result)
}

#[tauri::command]
pub fn change_master_password(
    current: String,
    next: String,
    state: State<'_, DatabaseState>,
) -> Result<(), String> {
    let mut guard = state.require_connection()?;
    state.check_attempt()?;
    let result = change_password(guard.as_mut().expect("checked above"), &current, &next);
    record_password_result(&state, &result);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::{apply_migrations, write_password_verifier};
    use rusqlite::{params, Connection};
    use std::fs;
    use std::path::PathBuf;

    struct Fixture {
        connection: Connection,
        files: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let files = std::env::temp_dir().join(format!("kivo-content-{}", uuid()));
            fs::create_dir_all(&files).unwrap();
            let mut connection = Connection::open(files.join("vault.db")).unwrap();
            connection
                .pragma_update(None, "foreign_keys", "ON")
                .unwrap();
            apply_migrations(&mut connection).unwrap();
            write_password_verifier(
                &mut connection,
                &crate::security::hash_secret("old-pass").unwrap(),
            )
            .unwrap();
            connection.execute("INSERT INTO items(id,kind,title,description,content,created_at,updated_at) VALUES ('note','note','Title','secret description','secret body','now','now')", []).unwrap();
            connection.execute("INSERT INTO item_versions(id,item_id,title,content,created_at) VALUES ('version','note','Title','old secret body','now')", []).unwrap();
            connection.execute("INSERT INTO items(id,kind,title,description,created_at,updated_at,deleted_at) VALUES ('file','file','File','file secret','now','now','later')", []).unwrap();
            connection.execute("INSERT INTO files(item_id,stored_name,original_name,byte_size,imported_at) VALUES ('file','file.txt','file.txt',11,'now')", []).unwrap();
            fs::write(files.join("file.txt"), b"secret file").unwrap();
            Self { connection, files }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.files);
        }
    }

    fn uuid() -> String {
        let mut bytes = [0u8; 16];
        getrandom::getrandom(&mut bytes).unwrap();
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    #[test]
    fn encrypted_rows_versions_and_trashed_file_round_trip_without_plaintext_at_rest() {
        let mut fixture = Fixture::new();
        let key = enable(&mut fixture.connection, &fixture.files, "old-pass").unwrap();
        assert_eq!(
            fixture
                .connection
                .query_row(
                    "SELECT description || COALESCE(content,'') FROM items WHERE id='note'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            ""
        );
        assert_eq!(
            fixture
                .connection
                .query_row(
                    "SELECT content FROM item_versions WHERE id='version'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            ""
        );
        let stored = fs::read(fixture.files.join("file.txt")).unwrap();
        assert!(!stored.windows(11).any(|window| window == b"secret file"));
        assert_eq!(decrypt_file(&key, "file", &stored).unwrap(), b"secret file");
        let protected = read_secret(&fixture.connection, &key, "note").unwrap();
        assert_eq!(protected.content.as_deref(), Some("secret body"));
        assert_eq!(
            read_version(&fixture.connection, &key, "version").unwrap(),
            "old secret body"
        );
        disable(&mut fixture.connection, &fixture.files, "old-pass").unwrap();
        assert_eq!(
            fs::read(fixture.files.join("file.txt")).unwrap(),
            b"secret file"
        );
        assert_eq!(
            fixture
                .connection
                .query_row("SELECT content FROM items WHERE id='note'", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            "secret body"
        );
    }

    #[test]
    fn wrong_password_and_tampered_ciphertext_do_not_change_state() {
        let mut fixture = Fixture::new();
        assert!(enable(&mut fixture.connection, &fixture.files, "wrong").is_err());
        assert_eq!(
            fs::read(fixture.files.join("file.txt")).unwrap(),
            b"secret file"
        );
        let key = enable(&mut fixture.connection, &fixture.files, "old-pass").unwrap();
        assert!(unlock(&fixture.connection, "wrong").unwrap().is_none());
        let mut ciphertext: Vec<u8> = fixture
            .connection
            .query_row(
                "SELECT ciphertext FROM item_secrets WHERE item_id='note'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        ciphertext[0] ^= 1;
        fixture
            .connection
            .execute(
                "UPDATE item_secrets SET ciphertext=?1 WHERE item_id='note'",
                params![ciphertext],
            )
            .unwrap();
        assert!(read_secret(&fixture.connection, &key, "note").is_err());
        assert!(disable(&mut fixture.connection, &fixture.files, "old-pass").is_err());
        assert!(is_enabled(&fixture.connection).unwrap());
    }

    #[test]
    fn interrupted_file_conversion_recovers_to_database_flag() {
        let fixture = Fixture::new();
        let key = new_vault_key().unwrap();
        let prepared = stage_files(&fixture.connection, &fixture.files, &key, true).unwrap();
        swap_files(&fixture.files, &prepared).unwrap();
        assert_ne!(
            fs::read(fixture.files.join("file.txt")).unwrap(),
            b"secret file"
        );
        recover_files(&fixture.connection, &fixture.files).unwrap();
        assert_eq!(
            fs::read(fixture.files.join("file.txt")).unwrap(),
            b"secret file"
        );
        assert!(!is_enabled(&fixture.connection).unwrap());
    }
}

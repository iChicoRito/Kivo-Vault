use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::database::DatabaseState;

const FORMAT: i64 = 1;
const MIN_SCHEMA: i64 = 12;
const MAX_SCHEMA: i64 = 17;
const DATABASE: &str = "kivo.db";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub path: String,
    pub created_at: String,
    pub app_version: String,
    pub schema_version: i64,
    pub item_count: i64,
    pub file_count: i64,
    pub valid: bool,
    pub problems: Vec<String>,
    /// Sealed with the Master Password. Counts stay hidden until restore.
    pub encrypted: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSummary {
    pub item_count: i64,
    pub file_count: i64,
    pub safety_copy_path: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    format: i64,
    app_version: String,
    schema_version: i64,
    created_at: String,
    counts: Counts,
    database_sha256: String,
    files: Vec<ManagedFile>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Counts {
    items: i64,
    files: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManagedFile {
    stored_name: String,
    original_name: String,
    byte_size: i64,
    encrypted: bool,
    sha256: String,
}

fn plain_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.ends_with(['.', ' '])
        && !name.chars().any(|c| {
            c.is_control()
                || c == char::from(92u8)
                || matches!(c, '/' | ':' | '<' | '>' | '"' | '|' | '?' | '*')
        })
        && Path::new(name)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
        && !matches!(
            name.split('.')
                .next()
                .unwrap_or("")
                .to_ascii_uppercase()
                .as_str(),
            "CON"
                | "PRN"
                | "AUX"
                | "NUL"
                | "COM1"
                | "COM2"
                | "COM3"
                | "COM4"
                | "COM5"
                | "COM6"
                | "COM7"
                | "COM8"
                | "COM9"
                | "LPT1"
                | "LPT2"
                | "LPT3"
                | "LPT4"
                | "LPT5"
                | "LPT6"
                | "LPT7"
                | "LPT8"
                | "LPT9"
        )
}

fn regular(path: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(path)
        .map_err(|e| format!("Cannot inspect {}: {e}", path.display()))?;
    if !meta.file_type().is_file() {
        return Err(format!("Not a regular file: {}", path.display()));
    }
    Ok(())
}

fn directory(path: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(path)
        .map_err(|e| format!("Cannot inspect {}: {e}", path.display()))?;
    if !meta.file_type().is_dir() {
        return Err(format!("Not a directory: {}", path.display()));
    }
    Ok(())
}

fn hash(path: &Path) -> Result<String, String> {
    regular(path)?;
    let mut source = File::open(path).map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let n = source.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        digest.update(&buffer[..n]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn version(connection: &Connection) -> Result<i64, String> {
    connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|e| e.to_string())
}

fn supported_schema(version: i64) -> bool {
    (MIN_SCHEMA..=MAX_SCHEMA).contains(&version)
}

fn check_db(connection: &Connection) -> Result<(), String> {
    let result: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if result != "ok" {
        return Err(format!("SQLite integrity check failed: {result}"));
    }
    Ok(())
}

fn count(connection: &Connection, table: &str) -> Result<i64, String> {
    connection
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .map_err(|e| e.to_string())
}

fn file_rows(connection: &Connection) -> Result<Vec<ManagedFile>, String> {
    let mut stmt = connection.prepare("SELECT stored_name, original_name, byte_size, encrypted FROM files ORDER BY stored_name").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(ManagedFile {
                stored_name: row.get(0)?,
                original_name: row.get(1)?,
                byte_size: row.get(2)?,
                encrypted: row.get::<_, i64>(3)? == 1,
                sha256: String::new(),
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

fn unique_sibling(path: &Path, label: &str) -> Result<PathBuf, String> {
    let parent = path.parent().ok_or("Path has no parent")?;
    let stem = path
        .file_name()
        .ok_or("Path has no name")?
        .to_string_lossy();
    for n in 0..100 {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        let candidate = parent.join(format!(
            ".{stem}.{label}-{}-{stamp}-{n}",
            std::process::id()
        ));
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("Could not reserve staging directory".into())
}

fn check_destination(destination: &Path, app_dir: &Path) -> Result<(), String> {
    let app_dir = fs::canonicalize(app_dir).map_err(|e| e.to_string())?;
    let mut probe = destination.to_path_buf();
    while !probe.exists() {
        probe = probe
            .parent()
            .ok_or("Destination has no existing parent")?
            .to_path_buf();
    }
    let real = fs::canonicalize(&probe).map_err(|e| e.to_string())?;
    if real.starts_with(&app_dir) || app_dir.starts_with(&real) && destination == probe {
        return Err("Backup destination overlaps the live app directory".into());
    }
    // Lexical components beyond the existing ancestor may not redirect through `..`.
    if destination
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err("Backup destination contains traversal".into());
    }
    Ok(())
}

fn write_backup(connection: &Connection, files_dir: &Path, stage: &Path) -> Result<(), String> {
    directory(files_dir)?;
    let schema = version(connection)?;
    if !supported_schema(schema) {
        return Err(format!("Unsupported live schema version: {schema}"));
    }
    let snapshot = stage.join(DATABASE);
    let sql = format!(
        "VACUUM INTO '{}'",
        snapshot.to_string_lossy().replace('\'', "''")
    );
    connection
        .execute_batch(&sql)
        .map_err(|e| format!("Could not snapshot database: {e}"))?;
    let snap = Connection::open_with_flags(&snapshot, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    check_db(&snap)?;
    let mut files = file_rows(&snap)?;
    fs::create_dir(stage.join("files")).map_err(|e| e.to_string())?;
    let mut seen = HashSet::new();
    for file in &mut files {
        if !plain_name(&file.stored_name)
            || !seen.insert(file.stored_name.clone())
            || file.byte_size < 0
        {
            return Err("Unsafe or duplicate managed file name/size".into());
        }
        let source = files_dir.join(&file.stored_name);
        regular(&source)?;
        fs::copy(&source, stage.join("files").join(&file.stored_name))
            .map_err(|e| e.to_string())?;
        file.sha256 = hash(&source)?;
        if !file.encrypted
            && fs::metadata(&source).map_err(|e| e.to_string())?.len() != file.byte_size as u64
        {
            return Err("Managed file size differs from database".into());
        }
    }
    // Unknown files cannot silently disappear from a backup.
    for entry in fs::read_dir(files_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "Non-Unicode managed file name")?;
        if !seen.contains(&name) {
            return Err(format!("Untracked managed file: {name}"));
        }
    }
    let created_at: String = snap
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
            row.get(0)
        })
        .map_err(|e| e.to_string())?;
    let manifest = Manifest {
        format: FORMAT,
        app_version: env!("CARGO_PKG_VERSION").into(),
        schema_version: schema,
        created_at,
        counts: Counts {
            items: count(&snap, "items")?,
            files: count(&snap, "files")?,
        },
        database_sha256: hash(&snapshot)?,
        files,
    };
    let mut output = File::create(stage.join("manifest.json")).map_err(|e| e.to_string())?;
    serde_json::to_writer_pretty(&mut output, &manifest).map_err(|e| e.to_string())?;
    output.flush().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn create_backup_at(
    connection: &Connection,
    files_dir: &Path,
    destination: &Path,
    replace: bool,
) -> Result<BackupInfo, String> {
    let app_dir = files_dir
        .parent()
        .ok_or("Managed files have no app directory")?;
    check_destination(destination, app_dir)?;
    let parent = destination
        .parent()
        .ok_or("Backup destination has no parent")?;
    directory(parent)?;
    if destination.exists() && !replace {
        return Err("Backup destination already exists; replacement requires confirmation".into());
    }
    let stage = unique_sibling(destination, "partial")?;
    let result = (|| {
        write_backup(connection, files_dir, &stage)?;
        let checked = inspect_backup_at(&stage);
        if !checked.valid {
            return Err(checked.problems.join("; "));
        }
        if destination.exists() {
            directory(destination)?;
            let old = unique_sibling(destination, "previous")?;
            fs::remove_dir(&old).map_err(|e| e.to_string())?;
            fs::rename(destination, &old).map_err(|e| e.to_string())?;
            if let Err(e) = fs::rename(&stage, destination) {
                fs::rename(&old, destination).map_err(|rollback| {
                    format!("Backup rename failed: {e}; rollback failed: {rollback}")
                })?;
                return Err(e.to_string());
            }
            let _ = fs::remove_dir_all(&old);
        } else {
            fs::rename(&stage, destination).map_err(|e| e.to_string())?;
        }
        Ok(inspect_backup_at(destination))
    })();
    if stage.exists() {
        let _ = fs::remove_dir_all(&stage);
    }
    result
}

/// Saves a new backup inside `parent`, in its own folder named after the local
/// date and time, so a backup never replaces anything already there.
pub fn create_backup_in(
    connection: &Connection,
    files_dir: &Path,
    parent: &Path,
) -> Result<BackupInfo, String> {
    let stamp: String = connection
        .query_row("SELECT strftime('%Y-%m-%d %H-%M-%S', 'now', 'localtime')", [], |row| {
            row.get(0)
        })
        .map_err(|e| e.to_string())?;
    let base = format!("Kivo Backup {stamp}");
    let mut destination = parent.join(&base);
    let mut copy = 2;
    while destination.exists() {
        destination = parent.join(format!("{base} ({copy})"));
        copy += 1;
    }
    create_backup_at(connection, files_dir, &destination, false)
}

pub fn inspect_backup_at(path: &Path) -> BackupInfo {
    let mut info = BackupInfo {
        path: path.display().to_string(),
        created_at: String::new(),
        app_version: String::new(),
        schema_version: 0,
        item_count: 0,
        file_count: 0,
        valid: false,
        problems: Vec::new(),
        encrypted: false,
    };
    let result = if path.join(SEALED_HEADER).exists() {
        inspect_sealed(path, &mut info)
    } else {
        inspect(path, &mut info)
    };
    if let Err(error) = result {
        info.problems.push(error);
    }
    info.valid = info.problems.is_empty();
    info
}

fn inspect(path: &Path, info: &mut BackupInfo) -> Result<(), String> {
    directory(path)?;
    regular(&path.join("manifest.json"))?;
    let manifest: Manifest =
        serde_json::from_reader(File::open(path.join("manifest.json")).map_err(|e| e.to_string())?)
            .map_err(|e| format!("Invalid manifest: {e}"))?;
    info.created_at = manifest.created_at.clone();
    info.app_version = manifest.app_version.clone();
    info.schema_version = manifest.schema_version;
    info.item_count = manifest.counts.items;
    info.file_count = manifest.counts.files;
    if manifest.format != FORMAT {
        info.problems.push("Unsupported backup format".into());
    }
    if !supported_schema(manifest.schema_version) {
        info.problems.push(format!(
            "Unsupported schema version: {}",
            manifest.schema_version
        ));
    }
    if manifest.counts.files < 0
        || manifest.counts.items < 0
        || manifest.counts.files as usize != manifest.files.len()
    {
        info.problems.push("Manifest count mismatch".into());
    }
    if manifest.created_at.is_empty() || manifest.app_version.is_empty() {
        info.problems
            .push("Manifest date or app version missing".into());
    }
    let db = path.join(DATABASE);
    if hash(&db)? != manifest.database_sha256 {
        info.problems.push("Database hash mismatch".into());
    }
    let conn = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    check_db(&conn)?;
    if version(&conn)? != manifest.schema_version {
        info.problems
            .push("Database schema differs from manifest".into());
    }
    if count(&conn, "items")? != manifest.counts.items
        || count(&conn, "files")? != manifest.counts.files
    {
        info.problems
            .push("Database counts differ from manifest".into());
    }
    let rows = file_rows(&conn)?;
    directory(&path.join("files"))?;
    let mut seen = HashSet::new();
    for file in &manifest.files {
        if !plain_name(&file.stored_name)
            || !seen.insert(file.stored_name.clone())
            || file.byte_size < 0
        {
            info.problems
                .push("Unsafe or duplicate managed file name/size".into());
            continue;
        }
        if !rows.iter().any(|row| {
            row.stored_name == file.stored_name
                && row.original_name == file.original_name
                && row.byte_size == file.byte_size
                && row.encrypted == file.encrypted
        }) {
            info.problems
                .push(format!("File metadata mismatch: {}", file.stored_name));
        }
        let source = path.join("files").join(&file.stored_name);
        match hash(&source) {
            Ok(value) if value == file.sha256 => {}
            _ => info.problems.push(format!(
                "File hash mismatch or missing: {}",
                file.stored_name
            )),
        }
        if !file.encrypted
            && fs::metadata(&source).map(|m| m.len()).ok() != Some(file.byte_size as u64)
        {
            info.problems
                .push(format!("File size mismatch: {}", file.stored_name));
        }
    }
    for entry in fs::read_dir(path.join("files")).map_err(|e| e.to_string())? {
        let name = entry
            .map_err(|e| e.to_string())?
            .file_name()
            .into_string()
            .map_err(|_| "Non-Unicode file name")?;
        if !seen.contains(&name) {
            info.problems
                .push(format!("Unexpected managed file: {name}"));
        }
    }
    for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
        let name = entry
            .map_err(|e| e.to_string())?
            .file_name()
            .into_string()
            .map_err(|_| "Non-Unicode backup entry")?;
        if !matches!(name.as_str(), "manifest.json" | DATABASE | "files") {
            info.problems
                .push(format!("Unexpected backup entry: {name}"));
        }
    }
    Ok(())
}

fn copy_managed(source: &Path, target: &Path) -> Result<(), String> {
    directory(source)?;
    fs::create_dir(target).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "Non-Unicode managed file name")?;
        if !plain_name(&name) {
            return Err("Unsafe managed file name".into());
        }
        regular(&entry.path())?;
        fs::copy(entry.path(), target.join(name)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Caller must close all live SQLite connections, clear vault keys, and explicitly confirm replacement.
/// Refuses active WAL sidecars; command layer reopens and migrates after success.
pub fn restore_backup_at(
    path: &Path,
    live_db: &Path,
    live_files: &Path,
) -> Result<RestoreSummary, String> {
    let info = inspect_backup_at(path);
    if !info.valid {
        return Err(format!("Backup invalid: {}", info.problems.join("; ")));
    }
    let parent = live_db.parent().ok_or("Live database has no parent")?;
    directory(parent)?;
    directory(live_files)?;
    regular(live_db)?;
    if live_files.parent() != Some(parent)
        || live_db.file_name().is_none_or(|name| name != DATABASE)
        || live_db == path.join(DATABASE)
    {
        return Err("Live paths overlap backup or are not in the same app directory".into());
    }
    let real_backup = fs::canonicalize(path).map_err(|e| e.to_string())?;
    let real_parent = fs::canonicalize(parent).map_err(|e| e.to_string())?;
    if real_backup.starts_with(&real_parent) || real_parent.starts_with(&real_backup) {
        return Err("Backup overlaps live vault".into());
    }
    for suffix in ["-wal", "-shm", "-journal"] {
        if live_db
            .with_file_name(format!(
                "{}{}",
                live_db.file_name().unwrap().to_string_lossy(),
                suffix
            ))
            .exists()
        {
            return Err("Close and checkpoint the live database before restore".into());
        }
    }
    let safety = unique_sibling(live_db, "pre-restore")?;
    let incoming = unique_sibling(live_db, "incoming")?;
    let result = (|| {
        fs::copy(live_db, safety.join(live_db.file_name().unwrap())).map_err(|e| e.to_string())?;
        copy_managed(live_files, &safety.join("files"))?;
        fs::copy(
            path.join(DATABASE),
            incoming.join(live_db.file_name().unwrap()),
        )
        .map_err(|e| e.to_string())?;
        copy_managed(&path.join("files"), &incoming.join("files"))?;
        fs::copy(path.join("manifest.json"), incoming.join("manifest.json"))
            .map_err(|e| e.to_string())?;
        let staged = inspect_backup_at(&incoming);
        if !staged.valid {
            return Err(format!(
                "Staged backup invalid: {}",
                staged.problems.join("; ")
            ));
        }
        let recheck = inspect_backup_at(path);
        if !recheck.valid {
            return Err(format!(
                "Backup changed during restore: {}",
                recheck.problems.join("; ")
            ));
        }
        // Move old assets to safety instead of deleting them; rollback uses these exact bytes.
        fs::rename(live_db, safety.join("original.db")).map_err(|e| e.to_string())?;
        if let Err(e) = fs::rename(live_files, safety.join("original-files")) {
            fs::rename(safety.join("original.db"), live_db)
                .map_err(|r| format!("Swap failed: {e}; rollback failed: {r}"))?;
            return Err(e.to_string());
        }
        let swap = (|| {
            fs::rename(incoming.join(live_db.file_name().unwrap()), live_db)
                .map_err(|e| e.to_string())?;
            fs::rename(incoming.join("files"), live_files).map_err(|e| e.to_string())?;
            Ok::<(), String>(())
        })();
        if let Err(e) = swap {
            if live_db.exists() {
                fs::remove_file(live_db)
                    .map_err(|r| format!("Swap failed: {e}; rollback failed: {r}"))?;
            }
            fs::rename(safety.join("original.db"), live_db)
                .map_err(|r| format!("Swap failed: {e}; rollback failed: {r}"))?;
            fs::rename(safety.join("original-files"), live_files)
                .map_err(|r| format!("Swap failed: {e}; rollback failed: {r}"))?;
            return Err(e);
        }
        Ok(RestoreSummary {
            item_count: info.item_count,
            file_count: info.file_count,
            safety_copy_path: safety.display().to_string(),
        })
    })();
    let _ = fs::remove_dir_all(&incoming);
    if result.is_err()
        && !safety.join("original.db").exists()
        && !safety.join("original-files").exists()
    {
        let _ = fs::remove_dir_all(&safety);
    }
    result
}

/// Clears the content key, closes the live connection, restores, then reopens.
/// The connection is reopened even when the restore fails so the app is never
/// left without a database.
pub(crate) fn restore_into(state: &DatabaseState, path: &Path) -> Result<RestoreSummary, String> {
    let _ = state.content_key().clear();
    state.close_connection()?;
    let result = restore_backup_at(path, state.database_path(), state.files_dir());
    let reopened = state.reopen_connection();
    match (result, reopened) {
        (Ok(summary), Ok(())) => Ok(summary),
        (Ok(_), Err(error)) => Err(format!(
            "Restored the backup but could not reopen the vault: {error}"
        )),
        (Err(error), Ok(())) => Err(error),
        (Err(error), Err(reopen)) => Err(format!("{error}; could not reopen the vault: {reopen}")),
    }
}

// Encrypted backups (format 2). The plain snapshot is built in the system temp
// folder, then every file is sealed with a key from the Master Password and
// written to the chosen folder, so that folder only ever holds ciphertext.

const SEALED_FORMAT: i64 = 2;
const SEALED_HEADER: &str = "backup.json";
const SEALED_MANIFEST: &str = "manifest.enc";
const SEALED_DATABASE: &str = "kivo.db.enc";
const WRONG_BACKUP_PASSWORD: &str = "That Master Password does not open this backup.";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SealedHeader {
    format: i64,
    app_version: String,
    created_at: String,
    salt: String,
}

fn sealed_aad(name: &str) -> Vec<u8> {
    format!("kivo:backup:v1:{name}").into_bytes()
}

fn seal_file(key: &[u8; 32], source: &Path, target: &Path, name: &str) -> Result<(), String> {
    // ponytail: whole-file read; stream in chunks if backups outgrow memory.
    let bytes = fs::read(source).map_err(|e| e.to_string())?;
    let sealed = crate::encryption::encrypt_bytes(key, &bytes, &sealed_aad(name))?;
    fs::write(target, sealed).map_err(|e| e.to_string())
}

fn open_file(key: &[u8; 32], source: &Path, target: &Path, name: &str) -> Result<(), String> {
    let bytes = fs::read(source).map_err(|e| e.to_string())?;
    let plain = crate::encryption::decrypt_bytes(key, &bytes, &sealed_aad(name))
        .map_err(|_| WRONG_BACKUP_PASSWORD.to_string())?;
    fs::write(target, plain).map_err(|e| e.to_string())
}

fn temp_stage(label: &str) -> Result<PathBuf, String> {
    unique_sibling(&std::env::temp_dir().join("kivo-backup"), label)
}

fn inspect_sealed(path: &Path, info: &mut BackupInfo) -> Result<(), String> {
    info.encrypted = true;
    directory(path)?;
    regular(&path.join(SEALED_HEADER))?;
    let header: SealedHeader = serde_json::from_reader(
        File::open(path.join(SEALED_HEADER)).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Invalid backup header: {e}"))?;
    info.created_at = header.created_at;
    info.app_version = header.app_version;
    if header.format != SEALED_FORMAT {
        info.problems.push("Unsupported backup format".into());
    }
    regular(&path.join(SEALED_MANIFEST))?;
    regular(&path.join(SEALED_DATABASE))?;
    directory(&path.join("files"))?;
    for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
        let name = entry
            .map_err(|e| e.to_string())?
            .file_name()
            .into_string()
            .map_err(|_| "Non-Unicode backup entry")?;
        if !matches!(
            name.as_str(),
            SEALED_HEADER | SEALED_MANIFEST | SEALED_DATABASE | "files"
        ) {
            info.problems
                .push(format!("Unexpected backup entry: {name}"));
        }
    }
    Ok(())
}

/// Writes an encrypted backup into a new dated folder inside `parent`.
pub fn create_sealed_backup_in(
    connection: &Connection,
    files_dir: &Path,
    parent: &Path,
    password: &str,
) -> Result<BackupInfo, String> {
    let app_dir = files_dir
        .parent()
        .ok_or("Managed files have no app directory")?;
    let stamp: String = connection
        .query_row("SELECT strftime('%Y-%m-%d %H-%M-%S', 'now', 'localtime')", [], |row| {
            row.get(0)
        })
        .map_err(|e| e.to_string())?;
    let base = format!("Kivo Backup {stamp}");
    let mut destination = parent.join(&base);
    let mut copy = 2;
    while destination.exists() {
        destination = parent.join(format!("{base} ({copy})"));
        copy += 1;
    }
    check_destination(&destination, app_dir)?;
    directory(parent)?;

    let plain = temp_stage("plain")?;
    let partial = unique_sibling(&destination, "partial");
    let result = (|| {
        let partial = partial.clone()?;
        write_backup(connection, files_dir, &plain)?;
        let checked = inspect_backup_at(&plain);
        if !checked.valid {
            return Err(checked.problems.join("; "));
        }

        let mut salt = [0u8; 16];
        getrandom::getrandom(&mut salt).map_err(|_| "Could not protect the backup")?;
        let mut key = crate::encryption::derive_key(password, &salt)?;
        let sealed = (|| {
            seal_file(&key, &plain.join("manifest.json"), &partial.join(SEALED_MANIFEST), SEALED_MANIFEST)?;
            seal_file(&key, &plain.join(DATABASE), &partial.join(SEALED_DATABASE), SEALED_DATABASE)?;
            fs::create_dir(partial.join("files")).map_err(|e| e.to_string())?;
            for entry in fs::read_dir(plain.join("files")).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let name = entry
                    .file_name()
                    .into_string()
                    .map_err(|_| "Non-Unicode managed file name")?;
                seal_file(&key, &entry.path(), &partial.join("files").join(&name), &format!("files/{name}"))?;
            }
            Ok::<(), String>(())
        })();
        key.fill(0);
        sealed?;

        let header = SealedHeader {
            format: SEALED_FORMAT,
            app_version: env!("CARGO_PKG_VERSION").into(),
            created_at: checked.created_at,
            salt: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, salt),
        };
        let mut output = File::create(partial.join(SEALED_HEADER)).map_err(|e| e.to_string())?;
        serde_json::to_writer_pretty(&mut output, &header).map_err(|e| e.to_string())?;
        output.flush().map_err(|e| e.to_string())?;
        drop(output);
        fs::rename(&partial, &destination).map_err(|e| e.to_string())?;
        Ok(inspect_backup_at(&destination))
    })();
    let _ = fs::remove_dir_all(&plain);
    if let Ok(partial) = partial {
        if partial.exists() {
            let _ = fs::remove_dir_all(&partial);
        }
    }
    result
}

/// Decrypts a sealed backup into a new temp folder in the plain layout, so the
/// normal checks and restore run on it unchanged. The caller deletes the folder.
pub fn open_sealed_backup(path: &Path, password: &str) -> Result<PathBuf, String> {
    let info = inspect_backup_at(path);
    if !info.valid {
        return Err(format!("Backup invalid: {}", info.problems.join("; ")));
    }
    let header: SealedHeader = serde_json::from_reader(
        File::open(path.join(SEALED_HEADER)).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Invalid backup header: {e}"))?;
    let salt = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &header.salt)
        .map_err(|_| "Invalid backup header")?;
    let mut key = crate::encryption::derive_key(password, &salt)?;
    let target = temp_stage("open")?;
    let opened = (|| {
        open_file(&key, &path.join(SEALED_MANIFEST), &target.join("manifest.json"), SEALED_MANIFEST)?;
        open_file(&key, &path.join(SEALED_DATABASE), &target.join(DATABASE), SEALED_DATABASE)?;
        fs::create_dir(target.join("files")).map_err(|e| e.to_string())?;
        for entry in fs::read_dir(path.join("files")).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| "Non-Unicode managed file name")?;
            if !plain_name(&name) {
                return Err("Unsafe managed file name".into());
            }
            open_file(&key, &entry.path(), &target.join("files").join(&name), &format!("files/{name}"))?;
        }
        Ok::<(), String>(())
    })();
    key.fill(0);
    if let Err(error) = opened {
        let _ = fs::remove_dir_all(&target);
        return Err(error);
    }
    Ok(target)
}

/// Restores a plain or sealed backup. A sealed one needs the Master Password
/// it was made with; its decrypted copy is always deleted afterwards.
pub(crate) fn restore_with_password(
    state: &DatabaseState,
    path: &Path,
    password: Option<&str>,
) -> Result<RestoreSummary, String> {
    if !path.join(SEALED_HEADER).exists() {
        return restore_into(state, path);
    }
    let password = password.ok_or("Enter the Master Password this backup was made with.")?;
    let opened = open_sealed_backup(path, password)?;
    let result = restore_into(state, &opened);
    let _ = fs::remove_dir_all(&opened);
    result
}

/// Makes a backup: sealed with the Master Password when an app lock exists,
/// plain otherwise. A wrong password counts toward the wrong-try wait.
fn backup_for_lock(
    state: &DatabaseState,
    parent: &Path,
    password: Option<&str>,
) -> Result<BackupInfo, String> {
    let guard = state.require_connection()?;
    let connection = guard.as_ref().expect("checked above");
    let verifier = crate::database::read_password_verifier(connection)
        .map_err(|e| e.to_string())?
        .filter(|_| crate::database::has_stored_password_lock(connection).unwrap_or(false));
    let Some(verifier) = verifier else {
        return create_backup_in(connection, state.files_dir(), parent);
    };
    let password = password.ok_or("Enter your Master Password to encrypt the backup.")?;
    state.check_attempt()?;
    let matched = crate::security::secret_matches(password, &verifier);
    state.record_attempt(matched);
    if !matched {
        return Err("Incorrect Master Password".into());
    }
    create_sealed_backup_in(connection, state.files_dir(), parent, password)
}

#[tauri::command]
pub fn pick_backup_destination(app: AppHandle) -> Result<Option<String>, String> {
    Ok(app
        .dialog()
        .file()
        .blocking_pick_folder()
        .map(|path| path.to_string()))
}

#[tauri::command]
pub fn pick_backup_source(app: AppHandle) -> Result<Option<String>, String> {
    Ok(app
        .dialog()
        .file()
        .blocking_pick_folder()
        .map(|path| path.to_string()))
}

#[tauri::command]
pub fn create_backup(
    destination: String,
    replace: bool,
    state: State<'_, DatabaseState>,
) -> Result<BackupInfo, String> {
    let guard = state.require_connection()?;
    let connection = guard.as_ref().expect("checked above");
    // This path writes a plain backup, so it is closed once an app lock exists.
    if crate::database::has_stored_password_lock(connection).map_err(|e| e.to_string())? {
        return Err("Use Back up now to make an encrypted backup".into());
    }
    create_backup_at(
        connection,
        state.files_dir(),
        Path::new(&destination),
        replace,
    )
}

/// One-click backup. With no folder it goes to "Kivo Backups" in Documents.
#[tauri::command]
pub fn create_backup_now(
    folder: Option<String>,
    password: Option<String>,
    app: AppHandle,
    state: State<'_, DatabaseState>,
) -> Result<BackupInfo, String> {
    use tauri::Manager;

    let parent = match folder {
        Some(folder) => PathBuf::from(folder),
        None => app
            .path()
            .document_dir()
            .map_err(|e| format!("Could not find the Documents folder: {e}"))?
            .join("Kivo Backups"),
    };
    backup_for_lock(state.inner(), &parent, password.as_deref())
}

#[tauri::command]
pub fn inspect_backup(path: String) -> Result<BackupInfo, String> {
    Ok(inspect_backup_at(Path::new(&path)))
}

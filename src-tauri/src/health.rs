//! Vault health check. Builds on the backup checks: the same SQLite integrity
//! check, plus the managed files and the sealed records of the live vault.
//! Repairs never delete anything: broken items go to Trash and stray files move
//! to a folder the person can open.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::database::DatabaseState;
use crate::passwords::VaultKeyState;

/// AES-GCM adds a 12-byte nonce and a 16-byte tag to every encrypted file.
const SEAL_OVERHEAD: u64 = 28;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthProblem {
    /// `missing_file`, `stray_file`, `damaged_item` or `damaged_credential`.
    pub kind: String,
    /// The item or credential id, or the stored file name for a stray file.
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthReport {
    /// Set when SQLite reports damage; there is no automatic repair for it.
    pub database_problem: Option<String>,
    pub problems: Vec<HealthProblem>,
    /// Parts that could not be checked: `content_locked`, `passwords_locked`
    /// or `collections_locked`.
    pub skipped: Vec<String>,
}

fn problem(kind: &str, id: &str, label: &str) -> HealthProblem {
    HealthProblem {
        kind: kind.to_string(),
        id: id.to_string(),
        label: label.to_string(),
    }
}

fn database_problem(connection: &Connection) -> Option<String> {
    if let Err(error) = crate::backup::check_db(connection) {
        return Some(error);
    }
    let broken_links: i64 = connection
        .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| row.get(0))
        .unwrap_or(0);
    (broken_links > 0).then(|| format!("{broken_links} records point to data that no longer exists"))
}

struct FileRow {
    item_id: String,
    stored_name: String,
    byte_size: i64,
    encrypted: bool,
}

pub(crate) fn check_vault(
    connection: &Connection,
    files_dir: &Path,
    content_key: Option<&[u8; 32]>,
    content_locked: bool,
    vault_key: Option<&[u8; 32]>,
    locked_collections: &[String],
) -> Result<HealthReport, String> {
    let fail = |error: rusqlite::Error| format!("Could not check the vault: {error}");
    let mut report = HealthReport {
        database_problem: database_problem(connection),
        ..HealthReport::default()
    };

    // Items in locked collections are left alone, so their names stay hidden.
    let mut statement = connection
        .prepare(&format!(
            "SELECT id, title FROM items WHERE deleted_at IS NULL{}",
            crate::database::locked_filter_sql("collection_id", locked_collections)
        ))
        .map_err(fail)?;
    let items = statement
        .query_map(rusqlite::params_from_iter(locked_collections.iter()), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(fail)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(fail)?;
    if !locked_collections.is_empty() {
        report.skipped.push("collections_locked".into());
    }

    let mut titles = std::collections::HashMap::new();
    for (id, title) in &items {
        let title = match content_key {
            Some(key) => match crate::encryption::read_secret(connection, key, id) {
                Ok(secret) => secret.title.unwrap_or_default(),
                Err(_) => {
                    report.problems.push(problem("damaged_item", id, "An item that can no longer be read"));
                    continue;
                }
            },
            None => title.clone(),
        };
        titles.insert(id.clone(), if title.trim().is_empty() { "Untitled".to_string() } else { title });
    }
    if content_locked {
        report.skipped.push("content_locked".into());
    }

    let mut statement = connection
        .prepare("SELECT item_id, stored_name, byte_size, encrypted FROM files")
        .map_err(fail)?;
    let files = statement
        .query_map([], |row| {
            Ok(FileRow {
                item_id: row.get(0)?,
                stored_name: row.get(1)?,
                byte_size: row.get(2)?,
                encrypted: row.get::<_, i64>(3)? != 0,
            })
        })
        .map_err(fail)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(fail)?;
    let known: HashSet<&str> = files.iter().map(|file| file.stored_name.as_str()).collect();

    for file in &files {
        let Some(title) = titles.get(&file.item_id) else {
            continue; // In Trash, in a locked collection, or already reported.
        };
        let expected = file.byte_size.max(0) as u64 + if file.encrypted { SEAL_OVERHEAD } else { 0 };
        let intact = fs::metadata(files_dir.join(&file.stored_name))
            .is_ok_and(|meta| meta.is_file() && meta.len() == expected);
        if !intact {
            report.problems.push(problem("missing_file", &file.item_id, title));
        }
    }

    if let Ok(entries) = fs::read_dir(files_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if entry.file_type().is_ok_and(|kind| kind.is_file()) && !known.contains(name.as_str()) {
                report.problems.push(problem("stray_file", &name, &name));
            }
        }
    }

    match vault_key {
        Some(key) => {
            for id in crate::passwords::damaged_credential_ids(connection, key)? {
                report
                    .problems
                    .push(problem("damaged_credential", &id, "A saved login that can no longer be read"));
            }
        }
        None => report.skipped.push("passwords_locked".into()),
    }

    Ok(report)
}

/// Moves stray files into `destination`. Only names that are still not linked
/// to any item are moved, so a live file can never be taken away.
pub(crate) fn move_stray_files(
    connection: &Connection,
    files_dir: &Path,
    names: &[String],
    destination: &Path,
) -> Result<usize, String> {
    let mut moved = 0;
    for name in names {
        let plain = Path::new(name).file_name().is_some_and(|part| part == name.as_str());
        let linked: i64 = connection
            .query_row("SELECT COUNT(*) FROM files WHERE stored_name = ?1", params![name], |row| row.get(0))
            .map_err(|error| format!("Could not check the file: {error}"))?;
        let source = files_dir.join(name);
        if !plain || linked > 0 || !source.is_file() {
            continue;
        }
        fs::create_dir_all(destination)
            .map_err(|error| format!("Could not create the recovery folder: {error}"))?;
        let target = destination.join(name);
        if fs::rename(&source, &target).is_err() {
            // A rename cannot cross drives; copy first so nothing is lost.
            fs::copy(&source, &target).map_err(|error| format!("Could not move {name}: {error}"))?;
            fs::remove_file(&source).map_err(|error| format!("Could not move {name}: {error}"))?;
        }
        moved += 1;
    }
    Ok(moved)
}

#[tauri::command]
pub fn check_vault_health(
    state: State<'_, DatabaseState>,
    vault: State<'_, VaultKeyState>,
) -> Result<HealthReport, String> {
    let connection = state.require_connection()?;
    let connection = connection.as_ref().expect("checked above");
    let (content_key, content_locked) =
        match crate::encryption::key_if_enabled(connection, state.content_key()) {
            Ok(key) => (key, false),
            Err(_) => (None, true),
        };
    let locked = crate::database::locked_collection_ids(connection, &state)?;

    check_vault(
        connection,
        state.files_dir(),
        content_key.as_ref(),
        content_locked,
        vault.require_key().ok().as_ref(),
        &locked,
    )
}

/// Applies one repair to the chosen problems and returns how many were fixed.
/// Stray files go to "Kivo Recovered Files" in Documents.
#[tauri::command]
pub fn repair_vault_health(
    kind: String,
    ids: Vec<String>,
    app: AppHandle,
    state: State<'_, DatabaseState>,
    vault: State<'_, VaultKeyState>,
) -> Result<usize, String> {
    use tauri::Manager;

    let mut connection = state.require_connection()?;
    let connection = connection.as_mut().expect("checked above");
    match kind.as_str() {
        "missing_file" | "damaged_item" => {
            crate::vault::write_trashed_items(connection, &ids)?;
            Ok(ids.len())
        }
        "damaged_credential" => {
            vault.require_key()?;
            crate::passwords::write_credentials_trashed(connection, &ids)?;
            Ok(ids.len())
        }
        "stray_file" => {
            let stamp: String = connection
                .query_row("SELECT strftime('%Y-%m-%d %H-%M-%S', 'now', 'localtime')", [], |row| {
                    row.get(0)
                })
                .map_err(|error| error.to_string())?;
            let destination: PathBuf = app
                .path()
                .document_dir()
                .map_err(|error| format!("Could not find the Documents folder: {error}"))?
                .join("Kivo Recovered Files")
                .join(stamp);
            move_stray_files(connection, state.files_dir(), &ids, &destination)
        }
        _ => Err("Unknown repair".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::apply_migrations;

    struct Temp(PathBuf);

    impl Temp {
        fn new(label: &str) -> Self {
            let unique = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock is after the epoch")
                .as_nanos();
            let root = std::env::temp_dir().join(format!("kivo-health-{label}-{}-{unique}", std::process::id()));
            fs::create_dir_all(root.join("files")).expect("create files folder");
            Self(root)
        }
        fn files(&self) -> PathBuf {
            self.0.join("files")
        }
    }

    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn vault_with_file(temp: &Temp) -> Connection {
        let mut connection = Connection::open_in_memory().expect("open database");
        apply_migrations(&mut connection).expect("migrate");
        connection
            .execute_batch(
                "INSERT INTO items (id, kind, title, created_at, updated_at)
                   VALUES ('note-1', 'note', 'Groceries', '2026-01-01', '2026-01-01'),
                          ('file-1', 'file', 'Lease', '2026-01-01', '2026-01-01');
                 INSERT INTO files (item_id, stored_name, original_name, byte_size, imported_at, encrypted)
                   VALUES ('file-1', 'lease.pdf', 'lease.pdf', 5, '2026-01-01', 0);",
            )
            .expect("seed items");
        fs::write(temp.files().join("lease.pdf"), b"hello").expect("write file");
        connection
    }

    fn kinds(report: &HealthReport) -> Vec<(&str, &str)> {
        report.problems.iter().map(|p| (p.kind.as_str(), p.id.as_str())).collect()
    }

    #[test]
    fn a_healthy_vault_reports_no_problems() {
        let temp = Temp::new("healthy");
        let connection = vault_with_file(&temp);
        let report = check_vault(&connection, &temp.files(), None, false, None, &[]).expect("check");
        assert_eq!(report.database_problem, None);
        assert!(report.problems.is_empty(), "{:?}", report.problems);
        assert_eq!(report.skipped, vec!["passwords_locked"], "a locked password vault is reported as skipped");
    }

    #[test]
    fn missing_and_changed_files_are_reported_and_repaired_by_moving_the_item_to_trash() {
        let temp = Temp::new("missing");
        let mut connection = vault_with_file(&temp);
        fs::write(temp.files().join("lease.pdf"), b"hello, changed").expect("change file");
        let report = check_vault(&connection, &temp.files(), None, false, None, &[]).expect("check");
        assert_eq!(kinds(&report), vec![("missing_file", "file-1")]);
        assert_eq!(report.problems[0].label, "Lease");

        fs::remove_file(temp.files().join("lease.pdf")).expect("remove file");
        let report = check_vault(&connection, &temp.files(), None, false, None, &[]).expect("check");
        assert_eq!(kinds(&report), vec![("missing_file", "file-1")]);

        crate::vault::write_trashed_items(&mut connection, &["file-1".to_string()]).expect("trash");
        let report = check_vault(&connection, &temp.files(), None, false, None, &[]).expect("check");
        assert!(report.problems.is_empty(), "items in Trash are not reported again");
    }

    #[test]
    fn stray_files_are_moved_out_but_linked_files_never_are() {
        let temp = Temp::new("stray");
        let connection = vault_with_file(&temp);
        fs::write(temp.files().join("orphan.bin"), b"left over").expect("write stray");
        let report = check_vault(&connection, &temp.files(), None, false, None, &[]).expect("check");
        assert_eq!(kinds(&report), vec![("stray_file", "orphan.bin")]);

        let destination = temp.0.join("recovered");
        let moved = move_stray_files(
            &connection,
            &temp.files(),
            &["orphan.bin".to_string(), "lease.pdf".to_string(), "../kivo.db".to_string()],
            &destination,
        )
        .expect("move");
        assert_eq!(moved, 1);
        assert!(destination.join("orphan.bin").is_file());
        assert!(temp.files().join("lease.pdf").is_file(), "a linked file stays in place");
    }

    #[test]
    fn items_whose_sealed_data_cannot_be_read_are_reported() {
        let temp = Temp::new("damaged");
        let connection = vault_with_file(&temp);
        let key = [7u8; 32];
        crate::encryption::write_secret(
            &connection,
            &key,
            "note-1",
            &crate::encryption::ProtectedItem { title: Some("Groceries".into()), ..Default::default() },
        )
        .expect("seal note");
        crate::encryption::write_secret(
            &connection,
            &key,
            "file-1",
            &crate::encryption::ProtectedItem { title: Some("Lease".into()), ..Default::default() },
        )
        .expect("seal file");
        connection
            .execute("UPDATE item_secrets SET ciphertext = x'00' WHERE item_id = 'note-1'", [])
            .expect("damage note");

        let report = check_vault(&connection, &temp.files(), Some(&key), false, None, &[]).expect("check");
        assert_eq!(kinds(&report), vec![("damaged_item", "note-1")]);
    }
}

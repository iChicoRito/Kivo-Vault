//! Selective restore: pick notes, sources and files from a backup and add them
//! to the live vault as new copies. The backup is opened into a temp folder,
//! brought up to the current schema there, and read with its own key.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::Serialize;
use tauri::State;

use crate::backup::{self, BackupUnlock};
use crate::database::{apply_migrations, DatabaseState};
use crate::encryption::{self, ContentKeyState};
use crate::portability::{self, ImportReport};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupItem {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub collection: Option<String>,
    pub updated_at: String,
    /// The same address or file contents is already saved in an accessible
    /// place in the live vault. Restoring it anyway keeps both.
    pub already_saved: bool,
}

/// An opened backup. Dropping it deletes the temp copy and forgets the key.
struct OpenedBackup {
    stage: PathBuf,
    /// Where the backup's `files/` folder is: the temp copy for a sealed
    /// backup, the backup folder itself for a plain one.
    files_root: PathBuf,
    connection: Option<Connection>,
    keys: ContentKeyState,
    /// The backup's vault id, read before the temp copy is migrated.
    vault_uid: Option<String>,
}

impl Drop for OpenedBackup {
    fn drop(&mut self) {
        let _ = self.keys.clear();
        drop(self.connection.take());
        let _ = fs::remove_dir_all(&self.stage);
    }
}

impl OpenedBackup {
    fn connection(&self) -> &Connection {
        self.connection.as_ref().expect("open until dropped")
    }
}

/// Opens a backup with its Master Password, or (format 3) a content recovery
/// kit. A kit-opened backup keeps the recovered content key only inside the
/// returned value, for reading its encrypted items; it is cleared on drop.
fn open_backup(path: &Path, password: Option<&str>, recovery_key: Option<&str>) -> Result<OpenedBackup, String> {
    let info = backup::inspect_backup_at(path);
    if !info.valid {
        return Err(format!("This backup has problems: {}", info.problems.join("; ")));
    }
    let mut recovered = None;
    let (stage, files_root) = if info.encrypted {
        let unlock = match (recovery_key, password) {
            (Some(kit), _) => BackupUnlock::Recovery(kit),
            (None, Some(password)) => BackupUnlock::Password(password),
            (None, None) => return Err("Enter the Master Password this backup was made with.".into()),
        };
        let (stage, content_key) = backup::open_sealed_backup_with(path, &unlock)?;
        recovered = content_key;
        (stage.clone(), stage)
    } else {
        let stage = backup::temp_stage("pick")?;
        fs::create_dir_all(&stage).map_err(|error| error.to_string())?;
        if let Err(error) = fs::copy(path.join("kivo.db"), stage.join("kivo.db")) {
            let _ = fs::remove_dir_all(&stage);
            return Err(format!("Could not read the backup: {error}"));
        }
        (stage, path.to_path_buf())
    };
    let mut opened = OpenedBackup {
        connection: None,
        keys: ContentKeyState::default(),
        stage,
        files_root,
        vault_uid: None,
    };
    opened.vault_uid = backup::backup_vault_uid(&opened.stage.join("kivo.db"))?;
    // Only the temp copy is upgraded; the backup itself is never changed.
    let mut connection = Connection::open(opened.stage.join("kivo.db"))
        .map_err(|error| format!("Could not read the backup: {error}"))?;
    apply_migrations(&mut connection).map_err(|error| format!("Could not read the backup: {error}"))?;
    if encryption::is_enabled(&connection)? {
        let key = match (recovered.as_deref(), password) {
            // The kit opened this vault's own content key; make sure it fits.
            (Some(key), _) => {
                let (identity, check) = crate::key_slots::read_identity(&connection, crate::key_slots::VaultScope::Content)?
                    .ok_or(backup::WRONG_BACKUP_KIT)?;
                if !crate::key_slots::key_check_matches(&identity, key, &check) {
                    return Err(backup::WRONG_BACKUP_KIT.into());
                }
                *key
            }
            (None, Some(password)) => encryption::unlock(&connection, password)?.ok_or(backup::WRONG_BACKUP_PASSWORD)?,
            (None, None) => return Err("Enter the Master Password this backup was made with.".into()),
        };
        opened.keys.store(key)?;
    }
    opened.connection = Some(connection);
    Ok(opened)
}

/// Lists a backup's items. With `live`, each row also says whether the live
/// vault already holds the same source address or file contents.
pub(crate) fn list_backup_items(
    path: &Path,
    password: Option<&str>,
    recovery_key: Option<&str>,
    live: Option<(&DatabaseState, bool)>,
) -> Result<Vec<BackupItem>, String> {
    let opened = open_backup(path, password, recovery_key)?;
    if let Some((state, original)) = live {
        check_vault(&opened, state, original)?;
    }
    let live = live.map(|(state, _)| state);
    let items = portability::read_items_with_ids(opened.connection(), &opened.keys, None, &[])?;
    let guard = match live {
        Some(state) => Some(state.require_connection()?),
        None => None,
    };
    let checker = match (live, guard.as_ref().and_then(|guard| guard.as_ref())) {
        (Some(state), Some(connection)) => {
            // A locked live vault cannot be compared; rows then show no mark.
            match encryption::key_if_enabled(connection, state.content_key()) {
                Ok(key) => Some((state, connection, key, crate::database::locked_collection_ids(connection, state)?)),
                Err(_) => None,
            }
        }
        _ => None,
    };
    let backup_key = opened.keys.require_key().ok();
    Ok(items
        .into_iter()
        .map(|(id, item)| {
            let already_saved = checker.as_ref().is_some_and(|(state, connection, key, locked)| {
                match (item.kind.as_str(), &item.file) {
                    ("source", _) => item
                        .url
                        .as_deref()
                        .and_then(crate::duplicates::canonical_source_url)
                        .and_then(|canonical| {
                            crate::duplicates::find_source_matches(connection, key.as_ref(), locked, &canonical, None).ok()
                        })
                        .is_some_and(|found| !found.is_empty()),
                    ("file", Some(file)) => portability::read_source_file(
                        opened.connection(),
                        backup_key.as_ref(),
                        &opened.files_root,
                        &id,
                        file,
                    )
                    .ok()
                    .and_then(|bytes| {
                        crate::duplicates::find_file_matches(
                            connection,
                            &state.files_dir(),
                            key.as_ref(),
                            locked,
                            &crate::duplicates::hash_bytes(&bytes),
                            bytes.len() as i64,
                        )
                        .ok()
                    })
                    .is_some_and(|found| !found.is_empty()),
                    _ => false,
                }
            });
            BackupItem {
                id,
                kind: item.kind,
                title: if item.title.trim().is_empty() { "Untitled".into() } else { item.title },
                collection: item.collection,
                updated_at: item.updated_at,
                already_saved,
            }
        })
        .collect())
}

pub(crate) fn restore_backup_items(
    state: &DatabaseState,
    path: &Path,
    password: Option<&str>,
    recovery_key: Option<&str>,
    ids: &[String],
    original: bool,
) -> Result<ImportReport, String> {
    if ids.is_empty() {
        return Ok(ImportReport::default());
    }
    let opened = open_backup(path, password, recovery_key)?;
    check_vault(&opened, state, original)?;
    let mut connection = state.require_connection()?;
    portability::copy_items_from(
        connection.as_mut().expect("checked above"),
        &state.files_dir(),
        state.content_key(),
        opened.connection(),
        &opened.keys,
        &opened.files_root,
        ids,
    )
}

/// Items come back only into the vault the backup was made from.
fn check_vault(opened: &OpenedBackup, state: &DatabaseState, original: bool) -> Result<(), String> {
    let live_uid = {
        let guard = state.require_connection()?;
        crate::database::read_vault_uid(guard.as_ref().expect("checked above"))?
    };
    backup::check_backup_vault(opened.vault_uid.as_deref(), &live_uid, original)
}

/// A wrong password counts toward the same wrong-try wait as a full restore.
fn with_attempt<T>(state: &DatabaseState, result: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    state.check_attempt()?;
    let result = result();
    let wrong = matches!(&result, Err(error) if error.starts_with("That Master Password") || error.starts_with("That recovery key"));
    if wrong || result.is_ok() {
        state.record_attempt(!wrong);
    }
    result
}

#[tauri::command(async)]
pub fn list_backup_contents(
    path: String,
    password: Option<String>,
    recovery_key: Option<String>,
    state: State<'_, DatabaseState>,
    vaults: State<'_, crate::vaults::VaultsState>,
) -> Result<Vec<BackupItem>, String> {
    let original = vaults.open_is_original();
    with_attempt(&state, || {
        list_backup_items(Path::new(&path), password.as_deref(), recovery_key.as_deref(), Some((state.inner(), original)))
    })
}

#[tauri::command(async)]
pub fn restore_from_backup(
    path: String,
    password: Option<String>,
    recovery_key: Option<String>,
    ids: Vec<String>,
    state: State<'_, DatabaseState>,
    vaults: State<'_, crate::vaults::VaultsState>,
) -> Result<ImportReport, String> {
    let original = vaults.open_is_original();
    with_attempt(&state, || {
        restore_backup_items(&state, Path::new(&path), password.as_deref(), recovery_key.as_deref(), &ids, original)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PASSWORD: &str = "correct horse battery";

    struct Temp(PathBuf);

    impl Temp {
        fn new(label: &str) -> Self {
            let unique = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock is after the epoch")
                .as_nanos();
            Self(std::env::temp_dir().join(format!(
                "kivo-selective-{label}-{}-{unique}",
                std::process::id()
            )))
        }

        /// A vault in `<root>/<name>` with a note in "Work" and a file.
        fn vault(&self, name: &str) -> DatabaseState {
            let state = DatabaseState::new(self.0.join(name).join("kivo.db"), self.0.join(name).join("files"));
            state.initialize().expect("initialize vault");
            fs::create_dir_all(&state.files_dir()).expect("files folder");
            fs::create_dir_all(self.0.join("backups")).expect("backups folder");
            state
        }
    }

    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn seed(state: &DatabaseState) {
        let connection = state.require_connection().expect("connection");
        let connection = connection.as_ref().expect("initialized");
        connection
            .execute_batch(
                "INSERT INTO collections (id, name, sort_order, created_at)
                   VALUES ('work', 'Work', 99, '2026-01-01');
                 INSERT INTO items (id, kind, title, content, collection_id, tags, created_at, updated_at)
                   VALUES ('note-1', 'note', 'Plan', '<p>Ship it</p>', 'work', '[]', '2026-01-01', '2026-01-01'),
                          ('file-1', 'file', 'Lease', NULL, NULL, '[]', '2026-01-01', '2026-01-01');
                 INSERT INTO files (item_id, stored_name, original_name, byte_size, imported_at, encrypted)
                   VALUES ('file-1', 'lease.txt', 'lease.txt', 5, '2026-01-01', 0);",
            )
            .expect("seed items");
        fs::write(state.files_dir().join("lease.txt"), b"hello").expect("write file");
    }

    fn encrypt(state: &DatabaseState) {
        let mut connection = state.require_connection().expect("connection");
        let connection = connection.as_mut().expect("initialized");
        let verifier = crate::security::hash_secret(PASSWORD).expect("hash");
        crate::database::write_password_verifier(connection, &verifier).expect("verifier");
        encryption::enable(connection, &state.files_dir(), PASSWORD).expect("encrypt vault");
    }

    /// Makes `live` the same vault as `old`: a backup of `old` may restore into it.
    fn same_vault(old: &DatabaseState, live: &DatabaseState) {
        let uid = {
            let connection = old.require_connection().expect("connection");
            crate::database::read_vault_uid(connection.as_ref().expect("initialized")).expect("uid")
        };
        let connection = live.require_connection().expect("connection");
        connection
            .as_ref()
            .expect("initialized")
            .execute("UPDATE vault_identity SET uid = ?1 WHERE id = 1", [uid])
            .expect("same vault");
    }

    fn live_items(state: &DatabaseState) -> Vec<(String, portability::PortableItem)> {
        let connection = state.require_connection().expect("connection");
        portability::read_items_with_ids(connection.as_ref().expect("initialized"), state.content_key(), None, &[])
            .expect("read live items")
    }

    #[test]
    fn a_plain_backup_lists_its_items_and_restores_chosen_ones_as_copies() {
        let temp = Temp::new("plain");
        let old = temp.vault("old");
        seed(&old);
        let backup = {
            let connection = old.require_connection().expect("connection");
            backup::create_backup_in(connection.as_ref().expect("initialized"), &old.files_dir(), &temp.0.join("backups"))
                .expect("backup")
        };
        let backup_path = Path::new(&backup.path);

        let listed = list_backup_items(backup_path, None, None, None).expect("list");
        assert_eq!(listed.len(), 2);
        let plan = listed.iter().find(|item| item.id == "note-1").expect("note listed");
        assert_eq!((plan.title.as_str(), plan.collection.as_deref()), ("Plan", Some("Work")));

        let live = temp.vault("live");
        same_vault(&old, &live);
        let report = restore_backup_items(&live, backup_path, None, None, &["note-1".into(), "file-1".into()], false)
            .expect("restore");
        assert_eq!(report.imported, 2, "{:?}", report.skipped);
        let items = live_items(&live);
        let note = items.iter().find(|(_, item)| item.title == "Plan").expect("note restored");
        assert_ne!(note.0, "note-1", "restored items get new ids");
        assert_eq!(note.1.collection.as_deref(), Some("Work"));
        let (_, file) = items.iter().find(|(_, item)| item.title == "Lease").expect("file restored");
        let stored = &file.file.as_ref().expect("file record").stored_name;
        assert_eq!(fs::read(live.files_dir().join(stored)).expect("file bytes"), b"hello");
    }

    #[test]
    fn an_encrypted_backup_needs_its_password_and_its_files_are_decrypted_in_memory() {
        let temp = Temp::new("sealed");
        let old = temp.vault("old");
        seed(&old);
        encrypt(&old);
        let backup = {
            let connection = old.require_connection().expect("connection");
            backup::create_sealed_backup_in(
                connection.as_ref().expect("initialized"),
                &old.files_dir(),
                &temp.0.join("backups"),
                PASSWORD,
            )
            .expect("sealed backup")
        };
        let backup_path = Path::new(&backup.path);

        assert!(list_backup_items(backup_path, None, None, None).is_err());
        assert_eq!(
            list_backup_items(backup_path, Some("wrong password"), None, None).unwrap_err(),
            backup::WRONG_BACKUP_PASSWORD
        );
        let listed = list_backup_items(backup_path, Some(PASSWORD), None, None).expect("list");
        assert!(listed.iter().any(|item| item.title == "Plan"), "titles are decrypted");

        let live = temp.vault("live");
        same_vault(&old, &live);
        let report = restore_backup_items(&live, backup_path, Some(PASSWORD), None, &["file-1".into()], false)
            .expect("restore");
        assert_eq!(report.imported, 1, "{:?}", report.skipped);
        let items = live_items(&live);
        assert_eq!(items.len(), 1, "only the chosen item is restored");
        let stored = &items[0].1.file.as_ref().expect("file record").stored_name;
        assert_eq!(fs::read(live.files_dir().join(stored)).expect("file bytes"), b"hello");
    }

    #[test]
    fn the_temp_copy_is_deleted_when_the_backup_is_closed() {
        let temp = Temp::new("cleanup");
        let old = temp.vault("old");
        seed(&old);
        let backup = {
            let connection = old.require_connection().expect("connection");
            backup::create_backup_in(connection.as_ref().expect("initialized"), &old.files_dir(), &temp.0.join("backups"))
                .expect("backup")
        };
        let opened = open_backup(Path::new(&backup.path), None, None).expect("open");
        let stage = opened.stage.clone();
        assert!(stage.join("kivo.db").is_file());
        drop(opened);
        assert!(!stage.exists());
    }

    #[test]
    fn t24_listing_marks_items_the_live_vault_already_has() {
        let temp = Temp::new("already-saved");
        let old = temp.vault("old");
        seed(&old);
        let backup = {
            let connection = old.require_connection().expect("connection");
            backup::create_backup_in(connection.as_ref().expect("initialized"), &old.files_dir(), &temp.0.join("backups"))
                .expect("backup")
        };
        let backup_path = Path::new(&backup.path);

        // The live vault has the same file bytes under another name, and no note.
        let live = temp.vault("live");
        same_vault(&old, &live);
        {
            let connection = live.require_connection().expect("connection");
            connection
                .as_ref()
                .expect("initialized")
                .execute_batch(
                    "INSERT INTO items (id, kind, title, content, tags, created_at, updated_at)
                       VALUES ('copy', 'file', 'Copy', NULL, '[]', '2026-01-01', '2026-01-01');
                     INSERT INTO files (item_id, stored_name, original_name, byte_size, imported_at, encrypted)
                       VALUES ('copy', 'copy.txt', 'other-name.txt', 5, '2026-01-01', 0);",
                )
                .expect("seed live");
        }
        fs::write(live.files_dir().join("copy.txt"), b"hello").expect("write live file");

        let listed = list_backup_items(backup_path, None, None, Some((&live, false))).expect("list");
        let marked: Vec<(&str, bool)> = listed.iter().map(|item| (item.kind.as_str(), item.already_saved)).collect();
        assert!(marked.contains(&("file", true)));
        assert!(marked.contains(&("note", false)));

        // Restoring a marked row is an explicit choice: it still adds a copy.
        let file_id = listed.iter().find(|item| item.kind == "file").unwrap().id.clone();
        let report = restore_backup_items(&live, backup_path, None, None, &[file_id], false).expect("restore");
        assert_eq!(report.imported, 1);
    }

    #[test]
    fn t24_a_recovery_kit_lists_and_restores_items_from_a_new_encrypted_backup() {
        let temp = Temp::new("kit");
        let old = temp.vault("old");
        seed(&old);
        encrypt(&old);
        let draft = crate::recovery::begin_with_state(&old, "content", PASSWORD).expect("begin kit");
        crate::recovery::confirm_with_state(&old, &draft.token, &draft.recovery_key).expect("confirm kit");
        let backup = {
            let connection = old.require_connection().expect("connection");
            backup::create_sealed_backup_in(connection.as_ref().expect("initialized"), &old.files_dir(), &temp.0.join("backups"), PASSWORD)
                .expect("sealed backup")
        };
        let backup_path = Path::new(&backup.path);
        assert!(backup.recovery_available);

        let listed = list_backup_items(backup_path, None, Some(&draft.recovery_key), None).expect("list with the kit");
        assert!(listed.iter().any(|item| item.title == "Plan"), "encrypted titles open with the kit");

        let live = temp.vault("live");
        same_vault(&old, &live);
        let report = restore_backup_items(&live, backup_path, None, Some(&draft.recovery_key), &["note-1".into()], false)
            .expect("restore with the kit");
        assert_eq!(report.imported, 1, "{:?}", report.skipped);
        assert!(live_items(&live).iter().any(|(_, item)| item.title == "Plan"));

        let wrong = crate::key_slots::format_kit(crate::key_slots::VaultScope::Content, &"a".repeat(32), &"b".repeat(32), &[1; 32]);
        assert_eq!(list_backup_items(backup_path, None, Some(&wrong), None).err().as_deref(), Some(backup::WRONG_BACKUP_KIT));
    }
}

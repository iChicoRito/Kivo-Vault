#![allow(dead_code)]

// T24 phase 7: encrypted backups (format 3) that a content recovery kit can open.

#[path = "../src/backup.rs"]
mod backup;
#[path = "../src/database.rs"]
mod database;
#[path = "../src/encryption.rs"]
mod encryption;
#[path = "../src/key_slots.rs"]
mod key_slots;
#[path = "../src/security.rs"]
mod security;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use backup::{inspect_backup_at, open_sealed_backup_with, BackupUnlock, WRONG_BACKUP_KIT, WRONG_BACKUP_PASSWORD};
use key_slots::VaultScope;
use rusqlite::Connection;

const PASSWORD: &str = "master password";

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct Workspace(PathBuf);

impl Workspace {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "kivo-t24-rbackup-{}-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(path.join("app/files")).unwrap();
        fs::create_dir_all(path.join("backups")).unwrap();
        Self(path)
    }
    fn files(&self) -> PathBuf {
        self.0.join("app/files")
    }
    fn backups(&self) -> PathBuf {
        self.0.join("backups")
    }
    /// An app-locked vault with one note and one managed file.
    fn vault(&self, encrypted: bool) -> (Connection, Option<[u8; 32]>) {
        let mut connection = Connection::open(self.0.join("app/kivo.db")).unwrap();
        connection.pragma_update(None, "foreign_keys", "ON").unwrap();
        database::apply_migrations(&mut connection).unwrap();
        connection
            .execute_batch(
                "INSERT INTO items (id, kind, title, content, created_at, updated_at)
                   VALUES ('note', 'note', 'secret-title', '<p>private body</p>', 'now', 'now');
                 INSERT INTO items (id, kind, title, created_at, updated_at)
                   VALUES ('file', 'file', 'Doc', 'now', 'now');
                 INSERT INTO files (item_id, stored_name, original_name, byte_size, imported_at)
                   VALUES ('file', 'stored.bin', 'report.txt', 5, 'now');",
            )
            .unwrap();
        fs::write(self.files().join("stored.bin"), b"hello").unwrap();
        database::write_password_verifier(&mut connection, &security::hash_secret(PASSWORD).unwrap()).unwrap();
        let key = encrypted.then(|| encryption::enable(&mut connection, &self.files(), PASSWORD).unwrap());
        (connection, key)
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Sets up a content recovery kit the way phase 6 does, returning the kit text.
fn enroll(connection: &Connection) -> String {
    if !key_slots::has_slots(connection, VaultScope::Content).unwrap() {
        // App lock only: a lock key behind the same slots.
        key_slots::install_password_slot(connection, VaultScope::Content, &encryption::new_vault_key().unwrap(), PASSWORD).unwrap();
    }
    let key = key_slots::unlock_with_password(connection, VaultScope::Content, PASSWORD).unwrap().unwrap();
    let (identity, _) = key_slots::read_identity(connection, VaultScope::Content).unwrap().unwrap();
    let secret = encryption::new_vault_key().unwrap();
    let recovery_id = key_slots::new_hex_id().unwrap();
    let envelope = key_slots::wrap_with_secret(&identity, &recovery_id, &key, &secret).unwrap();
    key_slots::put_recovery_slot(connection, VaultScope::Content, &recovery_id, &envelope).unwrap();
    key_slots::format_kit(VaultScope::Content, &identity.vault_id, &recovery_id, &secret)
}

fn backup(workspace: &Workspace, connection: &Connection) -> PathBuf {
    let info = backup::create_sealed_backup_in(connection, &workspace.files(), &workspace.backups(), PASSWORD).unwrap();
    assert!(info.valid, "{:?}", info.problems);
    PathBuf::from(info.path)
}

fn header(path: &Path) -> serde_json::Value {
    serde_json::from_slice(&fs::read(path.join("backup.json")).unwrap()).unwrap()
}

fn opened_title(folder: &Path) -> String {
    let connection = Connection::open(folder.join("kivo.db")).unwrap();
    connection.query_row("SELECT title FROM items WHERE id='note'", [], |row| row.get(0)).unwrap()
}

#[test]
fn a_backup_without_a_kit_opens_with_its_password_only() {
    let workspace = Workspace::new();
    let (connection, _) = workspace.vault(false);
    let folder = backup(&workspace, &connection);

    assert_eq!(header(&folder)["format"], 3);
    let info = inspect_backup_at(&folder);
    assert!(info.encrypted && !info.recovery_available);
    assert_eq!(open_sealed_backup_with(&folder, &BackupUnlock::Password("wrong")).err().as_deref(), Some(WRONG_BACKUP_PASSWORD));
    let kit = key_slots::format_kit(VaultScope::Content, &"a".repeat(32), &"b".repeat(32), &[1; 32]);
    assert!(open_sealed_backup_with(&folder, &BackupUnlock::Recovery(&kit)).unwrap_err().contains("without a recovery kit"));

    let (opened, content_key) = open_sealed_backup_with(&folder, &BackupUnlock::Password(PASSWORD)).unwrap();
    assert!(content_key.is_none());
    assert_eq!(opened_title(&opened), "secret-title");
    assert_eq!(fs::read(opened.join("files/stored.bin")).unwrap(), b"hello");
    let _ = fs::remove_dir_all(opened);
}

#[test]
fn the_kit_active_at_backup_time_opens_it_without_the_password() {
    let workspace = Workspace::new();
    let (connection, _) = workspace.vault(false);
    let kit = enroll(&connection);
    let folder = backup(&workspace, &connection);

    assert!(inspect_backup_at(&folder).recovery_available);
    let text = fs::read_to_string(folder.join("backup.json")).unwrap();
    let secret_hex = kit.split(':').nth(4).unwrap();
    assert!(!text.contains(secret_hex), "the header never holds the recovery secret");

    let (opened, _) = open_sealed_backup_with(&folder, &BackupUnlock::Recovery(&kit)).unwrap();
    assert_eq!(opened_title(&opened), "secret-title");
    assert!(inspect_backup_at(&opened).valid, "every file authenticated and restorable");
    let _ = fs::remove_dir_all(opened);

    // The same backup still opens with its password.
    let (opened, _) = open_sealed_backup_with(&folder, &BackupUnlock::Password(PASSWORD)).unwrap();
    let _ = fs::remove_dir_all(opened);
}

#[test]
fn an_encrypted_vault_backup_gives_back_its_content_key_through_the_kit() {
    let workspace = Workspace::new();
    let (connection, key) = workspace.vault(true);
    let kit = enroll(&connection);
    let folder = backup(&workspace, &connection);

    let (opened, content_key) = open_sealed_backup_with(&folder, &BackupUnlock::Recovery(&kit)).unwrap();
    assert_eq!(*content_key.unwrap(), key.unwrap(), "the kit opens the snapshot's own data key");
    let restored = Connection::open(opened.join("kivo.db")).unwrap();
    let item = encryption::read_secret(&restored, &key.unwrap(), "note").unwrap();
    assert_eq!(item.content.as_deref(), Some("<p>private body</p>"));
    drop(restored);
    let _ = fs::remove_dir_all(opened);
}

#[test]
fn wrong_mismatched_or_tampered_kits_and_headers_never_open_it() {
    let workspace = Workspace::new();
    let (connection, _) = workspace.vault(false);
    let kit = enroll(&connection);
    let folder = backup(&workspace, &connection);
    let parsed = key_slots::parse_kit(&kit).unwrap();

    let wrong_secret = key_slots::format_kit(VaultScope::Content, &parsed.vault_id, &parsed.recovery_id, &[7; 32]);
    let other_vault = key_slots::format_kit(VaultScope::Content, &"c".repeat(32), &parsed.recovery_id, &parsed.secret);
    let password_kit = key_slots::format_kit(VaultScope::Passwords, &parsed.vault_id, &parsed.recovery_id, &parsed.secret);
    for bad in [&wrong_secret, &other_vault] {
        assert_eq!(open_sealed_backup_with(&folder, &BackupUnlock::Recovery(bad)).err().as_deref(), Some(WRONG_BACKUP_KIT));
    }
    assert!(open_sealed_backup_with(&folder, &BackupUnlock::Recovery(&password_kit)).is_err());

    // A route copied from another backup does not open this one's files.
    let second = backup(&workspace, &connection);
    let mut swapped = header(&second);
    swapped["recoveryRoute"] = header(&folder)["recoveryRoute"].clone();
    fs::write(second.join("backup.json"), swapped.to_string()).unwrap();
    assert!(open_sealed_backup_with(&second, &BackupUnlock::Recovery(&kit)).is_err());

    // A changed backup id breaks every file and the password wrapper.
    let mut moved = header(&folder);
    moved["backupId"] = "d".repeat(32).into();
    fs::write(folder.join("backup.json"), moved.to_string()).unwrap();
    assert!(open_sealed_backup_with(&folder, &BackupUnlock::Password(PASSWORD)).is_err());
    assert!(open_sealed_backup_with(&folder, &BackupUnlock::Recovery(&kit)).is_err());

    // Unknown header fields or formats are refused before any work.
    let mut extra = header(&second);
    extra["note"] = "hi".into();
    fs::write(second.join("backup.json"), extra.to_string()).unwrap();
    assert!(!inspect_backup_at(&second).valid);
    let mut future = header(&second);
    future.as_object_mut().unwrap().remove("note");
    future["format"] = 4.into();
    fs::write(second.join("backup.json"), future.to_string()).unwrap();
    assert!(!inspect_backup_at(&second).valid);
}

#[test]
fn a_flipped_byte_in_any_file_stops_the_open() {
    let workspace = Workspace::new();
    let (connection, _) = workspace.vault(false);
    let kit = enroll(&connection);
    let folder = backup(&workspace, &connection);
    let target = folder.join("files/stored.bin");
    let mut bytes = fs::read(&target).unwrap();
    *bytes.last_mut().unwrap() ^= 1;
    fs::write(&target, bytes).unwrap();

    assert_eq!(open_sealed_backup_with(&folder, &BackupUnlock::Recovery(&kit)).err().as_deref(), Some(WRONG_BACKUP_KIT));
    assert_eq!(open_sealed_backup_with(&folder, &BackupUnlock::Password(PASSWORD)).err().as_deref(), Some(WRONG_BACKUP_PASSWORD));
}

#[test]
fn archived_backups_follow_the_kit_that_was_active_when_they_were_made() {
    let workspace = Workspace::new();
    let (connection, _) = workspace.vault(false);
    let before_kit = backup(&workspace, &connection);
    let first_kit = enroll(&connection);
    let with_first = backup(&workspace, &connection);
    let second_kit = enroll(&connection);

    assert!(open_sealed_backup_with(&before_kit, &BackupUnlock::Recovery(&first_kit)).is_err(), "a kit cannot open a backup made before it");
    let (opened, _) = open_sealed_backup_with(&with_first, &BackupUnlock::Recovery(&first_kit)).unwrap();
    let _ = fs::remove_dir_all(opened);
    assert!(open_sealed_backup_with(&with_first, &BackupUnlock::Recovery(&second_kit)).is_err(), "a newer kit does not open an older backup");

    // Turning recovery off later does not change what an archived backup holds.
    key_slots::remove_recovery_slot(&connection, VaultScope::Content).unwrap();
    let (opened, _) = open_sealed_backup_with(&with_first, &BackupUnlock::Recovery(&first_kit)).unwrap();
    let _ = fs::remove_dir_all(opened);
}

#[test]
fn format_2_backups_still_open_with_their_password_but_never_with_a_kit() {
    let workspace = Workspace::new();
    let (connection, _) = workspace.vault(false);
    let kit = enroll(&connection);
    // Build a format 2 backup the way older Kivo did.
    let plain = backup::create_backup_in(&connection, &workspace.files(), &workspace.backups()).unwrap();
    let plain = PathBuf::from(plain.path);
    let sealed = workspace.backups().join("Old sealed backup");
    fs::create_dir_all(sealed.join("files")).unwrap();
    let salt = [9u8; 16];
    let key = encryption::derive_key(PASSWORD, &salt).unwrap();
    let seal = |source: &Path, target: &Path, name: &str| {
        let bytes = fs::read(source).unwrap();
        let aad = format!("kivo:backup:v1:{name}");
        fs::write(target, encryption::encrypt_bytes(&key, &bytes, aad.as_bytes()).unwrap()).unwrap();
    };
    seal(&plain.join("manifest.json"), &sealed.join("manifest.enc"), "manifest.enc");
    seal(&plain.join("kivo.db"), &sealed.join("kivo.db.enc"), "kivo.db.enc");
    seal(&plain.join("files/stored.bin"), &sealed.join("files/stored.bin"), "files/stored.bin");
    let header = serde_json::json!({
        "format": 2, "appVersion": "0.3.0", "createdAt": "2026-01-01",
        "salt": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, salt),
    });
    fs::write(sealed.join("backup.json"), header.to_string()).unwrap();

    let info = inspect_backup_at(&sealed);
    assert!(info.valid && info.encrypted && !info.recovery_available, "{:?}", info.problems);
    assert!(open_sealed_backup_with(&sealed, &BackupUnlock::Recovery(&kit)).unwrap_err().contains("before recovery kits"));
    assert_eq!(open_sealed_backup_with(&sealed, &BackupUnlock::Password("wrong")).err().as_deref(), Some(WRONG_BACKUP_PASSWORD));
    let (opened, _) = open_sealed_backup_with(&sealed, &BackupUnlock::Password(PASSWORD)).unwrap();
    assert_eq!(opened_title(&opened), "secret-title");
    let _ = fs::remove_dir_all(opened);
}

#![allow(dead_code)]

// T24 phase 5: the content vault on versioned key slots. Password-vault
// upgrade tests live in the `passwords.rs` module tests (its helpers are private).

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

use key_slots::VaultScope;
use rusqlite::{params, Connection};

const PASSWORD: &str = "content master password";
const NEXT: &str = "a brand new password";

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct Workspace(PathBuf);

impl Workspace {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "kivo-t24-slots-{}-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn db(&self) -> PathBuf {
        self.0.join("kivo.db")
    }
    fn files(&self) -> PathBuf {
        self.0.join("files")
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn open(path: &Path) -> Connection {
    let mut connection = Connection::open(path).unwrap();
    connection.pragma_update(None, "foreign_keys", "ON").unwrap();
    database::apply_migrations(&mut connection).unwrap();
    connection
}

/// An encrypted vault with one note, as created now (v1 slot).
fn encrypted_vault(workspace: &Workspace) -> [u8; 32] {
    let mut connection = open(&workspace.db());
    connection
        .execute_batch(
            "INSERT INTO items (id, kind, title, description, content, created_at, updated_at)
             VALUES ('note', 'note', 'Plan', 'summary', '<p>secret body</p>', '2026-01-01', '2026-01-01');",
        )
        .unwrap();
    fs::create_dir_all(workspace.files()).unwrap();
    database::write_password_verifier(&mut connection, &security::hash_secret(PASSWORD).unwrap()).unwrap();
    encryption::enable(&mut connection, &workspace.files(), PASSWORD).unwrap()
}

/// The same vault as an older Kivo stored it: no slots, key wrapped in `security`.
fn legacy_vault(workspace: &Workspace) -> [u8; 32] {
    let key = encrypted_vault(workspace);
    let connection = open(&workspace.db());
    key_slots::remove_scope(&connection, VaultScope::Content).unwrap();
    let wrapped = encryption::wrap_vault_key(&key, PASSWORD).unwrap();
    connection
        .execute(
            "UPDATE security SET encryption_salt=?1, wrapped_key=?2 WHERE id=1",
            params![wrapped.salt, wrapped.wrapped],
        )
        .unwrap();
    key
}

fn note_ciphertext(connection: &Connection) -> Vec<u8> {
    connection
        .query_row("SELECT ciphertext FROM item_secrets WHERE item_id='note'", [], |row| row.get(0))
        .unwrap()
}

fn legacy_columns(connection: &Connection) -> (Option<Vec<u8>>, Option<Vec<u8>>) {
    connection
        .query_row("SELECT encryption_salt, wrapped_key FROM security WHERE id=1", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .unwrap()
}

#[test]
fn new_encryption_uses_a_v1_slot_and_no_older_wrapper() {
    let workspace = Workspace::new();
    let key = encrypted_vault(&workspace);
    let connection = open(&workspace.db());

    assert!(key_slots::has_slots(&connection, VaultScope::Content).unwrap());
    assert_eq!(legacy_columns(&connection), (None, None));
    assert_eq!(encryption::unlock(&connection, PASSWORD).unwrap(), Some(key));
    assert_eq!(encryption::unlock(&connection, "wrong").unwrap(), None);
}

#[test]
fn an_older_vault_moves_to_a_slot_on_unlock_without_touching_records() {
    let workspace = Workspace::new();
    let key = legacy_vault(&workspace);
    let connection = open(&workspace.db());
    let before = note_ciphertext(&connection);
    assert!(!key_slots::has_slots(&connection, VaultScope::Content).unwrap());

    assert_eq!(encryption::unlock(&connection, PASSWORD).unwrap(), Some(key));

    assert!(key_slots::has_slots(&connection, VaultScope::Content).unwrap());
    assert_eq!(legacy_columns(&connection), (None, None), "the older wrapper is retired");
    assert_eq!(note_ciphertext(&connection), before, "records keep their ciphertext");
    drop(connection);

    let reopened = open(&workspace.db());
    let unlocked = encryption::unlock(&reopened, PASSWORD).unwrap().expect("unlocks through the slot");
    assert_eq!(unlocked, key);
    let item = encryption::read_secret(&reopened, &unlocked, "note").unwrap();
    assert_eq!(item.content.as_deref(), Some("<p>secret body</p>"));
}

#[test]
fn a_damaged_slot_fails_closed_and_never_falls_back_to_an_older_wrapper() {
    let workspace = Workspace::new();
    let key = encrypted_vault(&workspace);
    let connection = open(&workspace.db());
    // Put an older wrapper back, then damage the slot: unlock must still refuse.
    let wrapped = encryption::wrap_vault_key(&key, PASSWORD).unwrap();
    connection
        .execute(
            "UPDATE security SET encryption_salt=?1, wrapped_key=?2 WHERE id=1",
            params![wrapped.salt, wrapped.wrapped],
        )
        .unwrap();
    connection
        .execute("UPDATE vault_key_slots SET envelope_json='{\"version\":9}' WHERE scope='content'", [])
        .unwrap();

    assert!(encryption::unlock(&connection, PASSWORD).is_err());

    connection.execute("DELETE FROM vault_key_slots WHERE scope='content'", []).unwrap();
    assert!(encryption::unlock(&connection, PASSWORD).is_err(), "a missing slot is damage too");
}

#[test]
fn changing_the_password_rewraps_only_the_slot() {
    let workspace = Workspace::new();
    let key = encrypted_vault(&workspace);
    let mut connection = open(&workspace.db());
    let before = note_ciphertext(&connection);
    let identity_before = key_slots::read_identity(&connection, VaultScope::Content).unwrap().unwrap().0;

    encryption::change_password(&mut connection, PASSWORD, NEXT).unwrap();

    assert_eq!(encryption::unlock(&connection, NEXT).unwrap(), Some(key));
    assert_eq!(encryption::unlock(&connection, PASSWORD).unwrap(), None);
    assert_eq!(note_ciphertext(&connection), before);
    let identity_after = key_slots::read_identity(&connection, VaultScope::Content).unwrap().unwrap().0;
    assert_eq!(identity_after, identity_before, "same vault and key generation");
    assert!(encryption::change_password(&mut connection, PASSWORD, "again").is_err());
}

#[test]
fn changing_the_password_of_an_older_vault_leaves_no_old_password_route() {
    let workspace = Workspace::new();
    let key = legacy_vault(&workspace);
    let mut connection = open(&workspace.db());

    encryption::change_password(&mut connection, PASSWORD, NEXT).unwrap();

    assert_eq!(legacy_columns(&connection), (None, None));
    assert_eq!(encryption::unlock(&connection, NEXT).unwrap(), Some(key));
    assert_eq!(encryption::unlock(&connection, PASSWORD).unwrap(), None);
}

#[test]
fn turning_encryption_off_removes_the_content_slots() {
    let workspace = Workspace::new();
    encrypted_vault(&workspace);
    let mut connection = open(&workspace.db());

    encryption::disable(&mut connection, &workspace.files(), PASSWORD).unwrap();

    let rows: i64 = connection.query_row("SELECT COUNT(*) FROM vault_keys", [], |row| row.get(0)).unwrap();
    assert_eq!(rows, 0);
    let slots: i64 = connection.query_row("SELECT COUNT(*) FROM vault_key_slots", [], |row| row.get(0)).unwrap();
    assert_eq!(slots, 0);
}

#[test]
fn migration_20_adds_empty_key_tables_and_is_repeatable() {
    let mut connection = Connection::open_in_memory().unwrap();
    database::apply_migrations(&mut connection).unwrap();
    database::apply_migrations(&mut connection).unwrap();
    let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0)).unwrap();
    assert_eq!(version, 20);
    let rows: i64 = connection.query_row("SELECT COUNT(*) FROM vault_keys", [], |row| row.get(0)).unwrap();
    assert_eq!(rows, 0);
}

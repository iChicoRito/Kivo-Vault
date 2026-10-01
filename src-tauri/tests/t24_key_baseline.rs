#![allow(dead_code)]

// T24 phase 1 baseline: how the content vault behaves today, before key slots,
// recovery kits, or device unlock exist. Password-vault baselines live in the
// `passwords.rs` module tests because its storage helpers are private.

#[path = "../src/database.rs"]
mod database;
#[path = "../src/encryption.rs"]
mod encryption;
#[path = "../src/security.rs"]
mod security;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};

const PASSWORD: &str = "content master password";

static WORKSPACE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct Workspace(PathBuf);

impl Workspace {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "kivo-t24-baseline-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            WORKSPACE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
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
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .unwrap();
    database::apply_migrations(&mut connection).unwrap();
    connection
}

/// A note with one saved version and a managed file, then content encryption on.
fn encrypted_vault(workspace: &Workspace) -> [u8; 32] {
    let mut connection = open(&workspace.db());
    connection
        .execute_batch(
            "INSERT INTO items (id, kind, title, description, content, created_at, updated_at)
             VALUES ('note', 'note', 'Plan', 'summary', '<p>secret body</p>', '2026-01-01', '2026-01-01');
             INSERT INTO item_versions (id, item_id, title, content, created_at)
             VALUES ('v1', 'note', 'Plan draft', '<p>older body</p>', '2026-01-01');
             INSERT INTO items (id, kind, title, description, content, created_at, updated_at)
             VALUES ('file', 'file', 'Doc', '', NULL, '2026-01-01', '2026-01-01');
             INSERT INTO files (item_id, stored_name, original_name, byte_size, imported_at)
             VALUES ('file', 'stored.bin', 'report.pdf', 11, '2026-01-01');",
        )
        .unwrap();
    fs::create_dir_all(workspace.files()).unwrap();
    fs::write(workspace.files().join("stored.bin"), b"file secret").unwrap();
    database::write_password_verifier(&mut connection, &security::hash_secret(PASSWORD).unwrap())
        .unwrap();
    encryption::enable(&mut connection, &workspace.files(), PASSWORD).unwrap()
}

#[test]
fn encrypted_items_versions_and_files_stay_readable_after_reopening() {
    let workspace = Workspace::new();
    let key = encrypted_vault(&workspace);

    let connection = open(&workspace.db());
    let unlocked = encryption::unlock(&connection, PASSWORD)
        .unwrap()
        .expect("the right password unlocks the reopened vault");
    assert_eq!(unlocked, key);

    let item = encryption::read_secret(&connection, &unlocked, "note").unwrap();
    assert_eq!(item.content.as_deref(), Some("<p>secret body</p>"));
    assert_eq!(item.description, "summary");
    assert_eq!(item.title.as_deref(), Some("Plan"));
    assert_eq!(
        encryption::read_version(&connection, &unlocked, "v1").unwrap(),
        "<p>older body</p>"
    );
    let stored = fs::read(workspace.files().join("stored.bin")).unwrap();
    assert_ne!(stored, b"file secret", "managed bytes are ciphertext at rest");
    assert_eq!(
        encryption::decrypt_file(&unlocked, "file", &stored).unwrap(),
        b"file secret"
    );
    let file = encryption::read_secret(&connection, &unlocked, "file").unwrap();
    assert_eq!(file.file_name.as_deref(), Some("report.pdf"));
}

#[test]
fn wrong_content_password_installs_no_key() {
    let workspace = Workspace::new();
    encrypted_vault(&workspace);
    let connection = open(&workspace.db());
    let keys = encryption::ContentKeyState::default();

    assert_eq!(encryption::unlock(&connection, "wrong password").unwrap(), None);
    assert!(keys.require_key().is_err());
}

#[test]
fn altered_wrapped_key_does_not_unlock() {
    let workspace = Workspace::new();
    encrypted_vault(&workspace);
    let connection = open(&workspace.db());
    let mut wrapped: Vec<u8> = connection
        .query_row("SELECT wrapped_key FROM security WHERE id=1", [], |row| row.get(0))
        .unwrap();
    *wrapped.last_mut().unwrap() ^= 1;
    connection
        .execute("UPDATE security SET wrapped_key=?1 WHERE id=1", params![wrapped])
        .unwrap();

    assert!(encryption::unlock(&connection, PASSWORD).is_err());
}

#[test]
fn content_key_rejects_records_bound_to_another_item() {
    let workspace = Workspace::new();
    let key = encrypted_vault(&workspace);
    let connection = open(&workspace.db());
    // Swap the note's sealed row onto the file item: AAD binds it to its id.
    connection
        .execute_batch(
            "UPDATE item_secrets SET nonce=(SELECT nonce FROM item_secrets WHERE item_id='note'),
                 ciphertext=(SELECT ciphertext FROM item_secrets WHERE item_id='note')
             WHERE item_id='file'",
        )
        .unwrap();

    assert!(encryption::read_secret(&connection, &key, "file").is_err());
}

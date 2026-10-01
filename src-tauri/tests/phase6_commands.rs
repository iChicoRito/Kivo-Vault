#![allow(dead_code)]

#[path = "../src/backup.rs"]
mod backup;
#[path = "../src/database.rs"]
mod database;
#[path = "../src/duplicates.rs"]
mod duplicates;
#[path = "../src/encryption.rs"]
mod encryption;
#[path = "../src/portability.rs"]
mod portability;
#[path = "../src/security.rs"]
mod security;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use encryption::ContentKeyState;
use rusqlite::Connection;

static WORKSPACE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct Workspace(PathBuf);

impl Workspace {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "kivo-commands-{}-{}-{}",
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

    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn migrated(path: &Path) -> Connection {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut connection = Connection::open(path).unwrap();
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .unwrap();
    database::apply_migrations(&mut connection).unwrap();
    connection
}

fn seed_file_item(connection: &Connection, files: &Path) {
    fs::create_dir_all(files).unwrap();
    connection
        .execute(
            "INSERT INTO items (id, kind, title, description, content, created_at, updated_at)
             VALUES ('file', 'file', 'Doc', 'fd', NULL, '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO files (item_id, stored_name, original_name, byte_size, imported_at)
             VALUES ('file', 'stored.bin', 'original.bin', 5, '2026-01-01')",
            [],
        )
        .unwrap();
    fs::write(files.join("stored.bin"), b"hello").unwrap();
}

#[test]
fn import_json_creates_new_rows_and_reports_skipped_items() {
    let workspace = Workspace::new();
    let files = workspace.path("app/files");
    let mut connection = migrated(&workspace.path("app/kivo.db"));
    let root = workspace.path("import");
    fs::create_dir_all(root.join("files")).unwrap();

    let document = serde_json::json!({
        "format": 1,
        "collections": [{ "name": "Recipes" }],
        "items": [
            {
                "kind": "note", "title": "Imported", "description": "summary",
                "content": "body", "url": null, "collection": "Recipes",
                "tags": ["a"], "isFavorite": false, "isPinned": false,
                "createdAt": "2020-01-01", "updatedAt": "2020-01-01",
                "deletedAt": null, "file": null
            },
            {
                "kind": "password", "title": "secret", "description": "",
                "tags": [], "isFavorite": false, "isPinned": false,
                "createdAt": "", "updatedAt": ""
            },
            {
                "kind": "file", "title": "Missing", "description": "",
                "tags": [], "isFavorite": false, "isPinned": false,
                "createdAt": "", "updatedAt": "",
                "file": { "storedName": "gone.bin", "originalName": "gone.bin", "byteSize": 4 }
            }
        ]
    });
    let json_path = root.join("kivo-vault.json");
    fs::write(&json_path, serde_json::to_vec(&document).unwrap()).unwrap();

    let keys = ContentKeyState::default();
    let report = portability::import_json_into(&mut connection, &files, &keys, &json_path, &[]).unwrap();

    assert_eq!(
        report.skipped.len(),
        2,
        "password and missing-file items are skipped: {:?}",
        report.skipped
    );
    assert!(report.skipped.iter().all(|item| !item.reason.is_empty()));

    let rows: i64 = connection
        .query_row("SELECT COUNT(*) FROM items", [], |row| row.get(0))
        .unwrap();
    assert_eq!(rows, 1);

    let (id, description, content): (String, String, Option<String>) = connection
        .query_row("SELECT id, description, content FROM items", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .unwrap();
    assert_eq!(id.len(), 32, "new ids are generated, not reused");
    assert_eq!(description, "summary");
    assert_eq!(content.as_deref(), Some("body"));

    let collection: Option<String> = connection
        .query_row(
            "SELECT c.name FROM items i JOIN collections c ON c.id = i.collection_id",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(collection.as_deref(), Some("Recipes"));

    let indexed: i64 = connection
        .query_row("SELECT COUNT(*) FROM item_search", [], |row| row.get(0))
        .unwrap();
    assert_eq!(indexed, 1, "plaintext notes are indexed on import");
}

#[test]
fn export_vault_json_writes_files_and_refuses_while_locked() {
    let workspace = Workspace::new();
    let files = workspace.path("app/files");
    let mut connection = migrated(&workspace.path("app/kivo.db"));
    connection
        .execute(
            "INSERT INTO items (id, kind, title, description, content, created_at, updated_at)
             VALUES ('note', 'note', 'Note', 'd', 'body', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
    seed_file_item(&connection, &files);

    let keys = ContentKeyState::default();
    let plain_path = workspace.path("plain/kivo-vault.json");
    fs::create_dir_all(plain_path.parent().unwrap()).unwrap();
    portability::export_vault_into(&connection, &files, &keys, &plain_path, &[]).unwrap();

    let plain: serde_json::Value = serde_json::from_slice(&fs::read(&plain_path).unwrap()).unwrap();
    assert_eq!(plain["items"].as_array().unwrap().len(), 2);
    assert_eq!(
        fs::read(plain_path.parent().unwrap().join("files/stored.bin")).unwrap(),
        b"hello"
    );

    database::write_password_verifier(
        &mut connection,
        &security::hash_secret("master-pass").unwrap(),
    )
    .unwrap();
    let key = encryption::enable(&mut connection, &files, "master-pass").unwrap();

    keys.store(key).unwrap();
    let unlocked_path = workspace.path("unlocked/kivo-vault.json");
    fs::create_dir_all(unlocked_path.parent().unwrap()).unwrap();
    portability::export_vault_into(&connection, &files, &keys, &unlocked_path, &[]).unwrap();
    assert!(fs::read_to_string(&unlocked_path).unwrap().contains("body"));
    assert_eq!(
        fs::read(unlocked_path.parent().unwrap().join("files/stored.bin")).unwrap(),
        b"hello",
        "the exported file copy is decrypted in memory"
    );

    keys.clear().unwrap();
    let locked_path = workspace.path("locked/kivo-vault.json");
    fs::create_dir_all(locked_path.parent().unwrap()).unwrap();
    let error =
        portability::export_vault_into(&connection, &files, &keys, &locked_path, &[]).unwrap_err();
    assert!(
        error.contains("Vault is locked"),
        "unexpected error: {error}"
    );
    assert!(!locked_path.exists(), "a locked export writes nothing");
}

#[test]
fn import_json_encrypts_protected_fields_and_skips_the_index() {
    let workspace = Workspace::new();
    let files = workspace.path("app/files");
    let mut connection = migrated(&workspace.path("app/kivo.db"));
    database::write_password_verifier(
        &mut connection,
        &security::hash_secret("master-pass").unwrap(),
    )
    .unwrap();
    let key = encryption::enable(&mut connection, &files, "master-pass").unwrap();

    let root = workspace.path("import");
    fs::create_dir_all(&root).unwrap();
    let document = serde_json::json!({
        "format": 1,
        "collections": [],
        "items": [{
            "kind": "note", "title": "Protected", "description": "secret summary",
            "content": "secret body", "url": null, "collection": null,
            "tags": [], "isFavorite": false, "isPinned": false,
            "createdAt": "", "updatedAt": "", "deletedAt": null, "file": null
        }]
    });
    let json_path = root.join("kivo-vault.json");
    fs::write(&json_path, serde_json::to_vec(&document).unwrap()).unwrap();

    let keys = ContentKeyState::default();
    keys.store(key).unwrap();
    let report = portability::import_json_into(&mut connection, &files, &keys, &json_path, &[]).unwrap();
    assert!(report.skipped.is_empty(), "{:?}", report.skipped);

    let (id, description, content): (String, String, Option<String>) = connection
        .query_row("SELECT id, description, content FROM items", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .unwrap();
    assert_eq!(description, "", "protected columns stay empty at rest");
    assert_eq!(content, None);
    let protected = encryption::read_secret(&connection, &key, &id).unwrap();
    assert_eq!(protected.description, "secret summary");
    assert_eq!(protected.content.as_deref(), Some("secret body"));

    let indexed: i64 = connection
        .query_row("SELECT COUNT(*) FROM item_search", [], |row| row.get(0))
        .unwrap();
    assert_eq!(
        indexed, 0,
        "protected import never reaches the plaintext index"
    );
}

#[test]
fn restore_clears_the_content_key_and_reopens_the_connection() {
    let workspace = Workspace::new();
    let source_files = workspace.path("source/files");
    fs::create_dir_all(&source_files).unwrap();
    let source = migrated(&workspace.path("source/kivo.db"));
    source
        .execute(
            "INSERT INTO items (id, kind, title, created_at, updated_at)
             VALUES ('src', 'note', 'Restored', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
    let backup_path = workspace.path("backup");
    backup::create_backup_at(&source, &source_files, &backup_path, false).unwrap();
    drop(source);

    let live_root = workspace.path("live");
    let state = database::DatabaseState::new(live_root.join("kivo.db"), live_root.join("files"));
    state.initialize().unwrap();
    state
        .content_key()
        .store(encryption::new_vault_key().unwrap())
        .unwrap();
    assert!(state.content_key().require_key().is_ok());

    let summary = backup::restore_into(&state, &backup_path).unwrap();
    assert_eq!(summary.item_count, 1);
    assert!(
        state.content_key().require_key().is_err(),
        "restore drops the in-memory key"
    );

    let guard = state.require_connection().unwrap();
    let title: String = guard
        .as_ref()
        .unwrap()
        .query_row("SELECT title FROM items", [], |row| row.get(0))
        .unwrap();
    assert_eq!(
        title, "Restored",
        "the connection is reopened after restore"
    );
}

#[test]
fn create_backup_refuses_a_destination_inside_the_app_data_directory() {
    let workspace = Workspace::new();
    let files = workspace.path("app/files");
    fs::create_dir_all(&files).unwrap();
    let connection = migrated(&workspace.path("app/kivo.db"));

    let error = backup::create_backup_at(
        &connection,
        &files,
        &workspace.path("app/nested/backup"),
        false,
    )
    .unwrap_err();
    assert!(
        error.to_lowercase().contains("overlap"),
        "unexpected error: {error}"
    );
}

#[test]
fn t24_import_json_skips_addresses_and_files_already_saved() {
    let workspace = Workspace::new();
    let files = workspace.path("app/files");
    fs::create_dir_all(&files).unwrap();
    let mut connection = migrated(&workspace.path("app/kivo.db"));
    connection
        .execute(
            "INSERT INTO items (id, kind, title, description, url, created_at, updated_at)
             VALUES ('saved', 'source', 'Saved', '', 'https://example.com/a', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
    let root = workspace.path("import");
    fs::create_dir_all(root.join("files")).unwrap();
    fs::write(root.join("files/one.bin"), b"twin").unwrap();
    fs::write(root.join("files/two.bin"), b"twin").unwrap();

    let item = |kind: &str, title: &str, url: Option<&str>, file: Option<&str>| {
        serde_json::json!({
            "kind": kind, "title": title, "description": "", "content": null, "url": url,
            "collection": null, "tags": [], "isFavorite": false, "isPinned": false,
            "createdAt": "", "updatedAt": "", "deletedAt": null,
            "file": file.map(|name| serde_json::json!({ "storedName": name, "originalName": name, "byteSize": 4 }))
        })
    };
    let document = serde_json::json!({
        "format": 1,
        "collections": [],
        "items": [
            item("source", "Same page", Some("https://EXAMPLE.com/a"), None),
            item("source", "New page", Some("https://example.com/b"), None),
            item("source", "New page again", Some("https://example.com/b"), None),
            item("file", "First twin", None, Some("one.bin")),
            item("file", "Second twin", None, Some("two.bin")),
        ]
    });
    let json_path = root.join("kivo-vault.json");
    fs::write(&json_path, serde_json::to_vec(&document).unwrap()).unwrap();

    let report = portability::import_json_into(&mut connection, &files, &ContentKeyState::default(), &json_path, &[])
        .unwrap();

    assert_eq!(report.imported, 2, "{:?}", report.skipped);
    let skipped: Vec<&str> = report.skipped.iter().map(|entry| entry.title.as_str()).collect();
    assert_eq!(skipped, vec!["Same page", "New page again", "Second twin"]);
    assert!(report.skipped.iter().all(|entry| entry.reason == portability::ALREADY_SAVED));
    let digest: Vec<u8> = connection
        .query_row("SELECT content_digest FROM files", [], |row| row.get(0))
        .unwrap();
    assert_eq!(digest.len(), 32, "imported files get a fingerprint");
}

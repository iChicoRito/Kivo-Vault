#![allow(dead_code)]

#[path = "../src/backup.rs"]
mod backup;
#[path = "../src/database.rs"]
mod database;
#[path = "../src/encryption.rs"]
mod encryption;
#[path = "../src/security.rs"]
mod security;

use backup::{create_backup_at, create_backup_in, inspect_backup_at, restore_backup_at};
use rusqlite::Connection;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static WORKSPACE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct Workspace(PathBuf);
impl Workspace {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "kivo-backup-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            WORKSPACE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
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

fn seed(db: &Path, files: &Path, title: &str) -> Connection {
    fs::create_dir_all(files).unwrap();
    let conn = Connection::open(db).unwrap();
    conn.execute_batch("CREATE TABLE items (id TEXT, title TEXT); CREATE TABLE files (stored_name TEXT, original_name TEXT, byte_size INTEGER, encrypted INTEGER); CREATE TABLE credentials (id TEXT, secret TEXT); PRAGMA user_version = 12;").unwrap();
    conn.execute("INSERT INTO items VALUES ('1', ?1)", [title])
        .unwrap();
    conn.execute("INSERT INTO credentials VALUES ('1', 'private-token')", [])
        .unwrap();
    conn.execute(
        "INSERT INTO files VALUES ('abc.txt', 'original.txt', 5, 0)",
        [],
    )
    .unwrap();
    fs::write(files.join("abc.txt"), b"hello").unwrap();
    conn
}

#[test]
fn round_trip_includes_credentials_and_files_and_saves_current_vault() {
    let w = Workspace::new();
    let old_db = w.path("old/kivo.db");
    fs::create_dir_all(old_db.parent().unwrap()).unwrap();
    let old_files = w.path("old/files");
    let conn = seed(&old_db, &old_files, "original");
    let backup_path = w.path("backup");
    let info = create_backup_at(&conn, &old_files, &backup_path, false).unwrap();
    assert!(info.valid, "{:?}", info.problems);
    assert_eq!(
        (info.schema_version, info.item_count, info.file_count),
        (12, 1, 1)
    );
    assert!(inspect_backup_at(&backup_path).valid);
    drop(conn);

    let live_db = w.path("live/kivo.db");
    fs::create_dir_all(live_db.parent().unwrap()).unwrap();
    let live_files = w.path("live/files");
    drop(seed(&live_db, &live_files, "current"));
    let result = restore_backup_at(&backup_path, &live_db, &live_files).unwrap();
    assert_eq!((result.item_count, result.file_count), (1, 1));
    let restored = Connection::open(&live_db).unwrap();
    assert_eq!(
        restored
            .query_row("SELECT title FROM items", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "original"
    );
    assert_eq!(
        restored
            .query_row("SELECT secret FROM credentials", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "private-token"
    );
    assert_eq!(fs::read(live_files.join("abc.txt")).unwrap(), b"hello");
    assert!(Path::new(&result.safety_copy_path).join("kivo.db").exists());
}

#[test]
fn conflict_and_corruption_leave_live_vault_untouched() {
    let w = Workspace::new();
    let source_db = w.path("source/kivo.db");
    fs::create_dir_all(source_db.parent().unwrap()).unwrap();
    let source_files = w.path("source/files");
    let conn = seed(&source_db, &source_files, "source");
    let backup_path = w.path("backup");
    create_backup_at(&conn, &source_files, &backup_path, false).unwrap();
    assert!(create_backup_at(&conn, &source_files, &backup_path, false).is_err());
    fs::write(backup_path.join("files/abc.txt"), b"wrong").unwrap();
    let info = inspect_backup_at(&backup_path);
    assert!(!info.valid && !info.problems.is_empty());
    let live_db = w.path("live/kivo.db");
    fs::create_dir_all(live_db.parent().unwrap()).unwrap();
    let live_files = w.path("live/files");
    drop(seed(&live_db, &live_files, "current"));
    assert!(restore_backup_at(&backup_path, &live_db, &live_files).is_err());
    assert_eq!(
        Connection::open(&live_db)
            .unwrap()
            .query_row("SELECT title FROM items", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "current"
    );
    assert_eq!(fs::read(live_files.join("abc.txt")).unwrap(), b"hello");
    assert!(!w.path("live/kivo.db.pre-restore").exists());
}

#[test]
fn rejects_unsafe_names_and_destinations_inside_live_app() {
    let w = Workspace::new();
    let db = w.path("app/kivo.db");
    fs::create_dir_all(db.parent().unwrap()).unwrap();
    let files = w.path("app/files");
    let conn = seed(&db, &files, "source");
    assert!(create_backup_at(&conn, &files, &w.path("app/nested/backup"), false).is_err());
    conn.execute("UPDATE files SET stored_name = '../escape'", [])
        .unwrap();
    assert!(create_backup_at(&conn, &files, &w.path("safe"), false).is_err());
}

#[test]
fn inspect_rejects_newer_schema_and_manifest_traversal() {
    let w = Workspace::new();
    let db = w.path("app/kivo.db");
    fs::create_dir_all(db.parent().unwrap()).unwrap();
    let files = w.path("app/files");
    let conn = seed(&db, &files, "original");
    let backup_path = w.path("backup");
    create_backup_at(&conn, &files, &backup_path, false).unwrap();
    let manifest_path = backup_path.join("manifest.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    manifest["schemaVersion"] = 17.into();
    fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    assert!(inspect_backup_at(&backup_path)
        .problems
        .iter()
        .any(|p| p.contains("Unsupported schema")));
    manifest["schemaVersion"] = 12.into();
    manifest["files"][0]["storedName"] = "../escape".into();
    fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let info = inspect_backup_at(&backup_path);
    assert!(!info.valid && info.problems.iter().any(|p| p.contains("Unsafe")));
    assert!(!w.path("escape").exists());
}

#[test]
fn confirmed_replace_replaces_backup_not_live_vault() {
    let w = Workspace::new();
    let db = w.path("app/kivo.db");
    fs::create_dir_all(db.parent().unwrap()).unwrap();
    let files = w.path("app/files");
    let conn = seed(&db, &files, "first");
    let backup_path = w.path("backup");
    create_backup_at(&conn, &files, &backup_path, false).unwrap();
    conn.execute("UPDATE items SET title = 'second'", [])
        .unwrap();
    let info = create_backup_at(&conn, &files, &backup_path, true).unwrap();
    assert!(info.valid);
    assert_eq!(
        Connection::open(backup_path.join("kivo.db"))
            .unwrap()
            .query_row("SELECT title FROM items", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "second"
    );
    assert_eq!(
        conn.query_row("SELECT title FROM items", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "second"
    );
}

#[test]
fn a_phase_seven_vault_can_still_be_backed_up_and_inspected() {
    let w = Workspace::new();
    let db = w.path("app/kivo.db");
    fs::create_dir_all(db.parent().unwrap()).unwrap();
    let files = w.path("app/files");
    let conn = seed(&db, &files, "source");
    conn.execute_batch("PRAGMA user_version = 13;").unwrap();

    let backup_path = w.path("backup");
    let info = create_backup_at(&conn, &files, &backup_path, false).unwrap();
    assert_eq!(info.schema_version, 13);
    assert!(inspect_backup_at(&backup_path).valid);
}

#[test]
fn backup_into_an_existing_folder_makes_a_new_dated_folder_and_keeps_what_is_there() {
    let w = Workspace::new();
    let db = w.path("app/kivo.db");
    fs::create_dir_all(db.parent().unwrap()).unwrap();
    let files = w.path("app/files");
    let conn = seed(&db, &files, "original");
    let parent = w.path("Documents");
    fs::create_dir_all(&parent).unwrap();
    fs::write(parent.join("keep.txt"), b"mine").unwrap();

    let first = create_backup_in(&conn, &files, &parent).unwrap();
    let second = create_backup_in(&conn, &files, &parent).unwrap();

    assert!(first.valid && second.valid, "{:?} {:?}", first.problems, second.problems);
    assert_ne!(first.path, second.path);
    assert!(Path::new(&first.path).starts_with(&parent));
    assert!(Path::new(&first.path).file_name().unwrap().to_string_lossy().starts_with("Kivo Backup "));
    assert_eq!(fs::read(parent.join("keep.txt")).unwrap(), b"mine");
}

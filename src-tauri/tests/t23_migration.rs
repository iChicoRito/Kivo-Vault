use rusqlite::{params, Connection};

const MIGRATION: &str = include_str!("../migrations/0018_credential_history_and_clipboard.sql");

#[test]
fn t23_defaults_clipboard_off_and_versions_cascade_on_delete() {
    let connection = Connection::open_in_memory().unwrap();
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .unwrap();
    connection
        .execute_batch(
            "CREATE TABLE preferences (id INTEGER PRIMARY KEY, auto_lock_minutes INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE credentials (id TEXT PRIMARY KEY);
             INSERT INTO preferences (id) VALUES (1);
             INSERT INTO credentials (id) VALUES ('credential-1');",
        )
        .unwrap();

    connection.execute_batch(MIGRATION).unwrap();

    let clipboard: (i64, i64) = connection
        .query_row(
            "SELECT clipboard_clear_seconds, clipboard_exclude_history FROM preferences WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(clipboard, (0, 0), "clipboard handling is off by default");

    connection
        .execute(
            "INSERT INTO credential_versions (id, credential_id, created_at, data_nonce, data_ciphertext)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params!["version-1", "credential-1", "2026-01-01", vec![1u8], vec![2u8]],
        )
        .unwrap();
    connection
        .execute("DELETE FROM credentials WHERE id = 'credential-1'", [])
        .unwrap();
    let remaining: i64 = connection
        .query_row("SELECT count(*) FROM credential_versions", [], |row| row.get(0))
        .unwrap();
    assert_eq!(remaining, 0, "versions are removed with their credential");
}

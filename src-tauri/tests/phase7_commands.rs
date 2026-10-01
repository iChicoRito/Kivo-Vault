#![allow(dead_code)]

#[path = "../src/database.rs"]
mod database;
#[path = "../src/duplicates.rs"]
mod duplicates;
#[path = "../src/encryption.rs"]
mod encryption;
#[path = "../src/key_slots.rs"]
mod key_slots;
#[path = "../src/insights.rs"]
mod insights;
#[path = "../src/security.rs"]
mod security;
#[path = "../src/vault.rs"]
mod vault;

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use database::DatabaseState;
use rusqlite::{params, Connection, OptionalExtension};

static WORKSPACE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct Workspace(PathBuf);

impl Workspace {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "kivo-phase7-{label}-{}-{}-{}",
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

    fn state(&self) -> DatabaseState {
        DatabaseState::new(self.0.join("kivo.db"), self.0.join("files"))
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn complete_setup(state: &DatabaseState) {
    let mut guard = state.require_connection().unwrap();
    database::write_setup(
        guard.as_mut().unwrap(),
        &database::SetupInput {
            owner_name: "Ada".to_string(),
            vault_name: "Vault".to_string(),
            starter_collections: Vec::new(),
            password_verifier: None,
        },
    )
    .unwrap();
}

fn set_flags(state: &DatabaseState, semantic_search: bool, auto_tag: bool, summaries: bool) {
    let mut guard = state.require_connection().unwrap();
    let connection = guard.as_mut().unwrap();
    let mut preferences = database::read_preferences(connection).unwrap();
    preferences.semantic_search = semantic_search;
    preferences.auto_tag = auto_tag;
    preferences.summaries = summaries;
    database::write_preferences(connection, &preferences).unwrap();
}

fn with_connection(state: &DatabaseState, run: impl FnOnce(&Connection)) {
    let guard = state.require_connection().unwrap();
    run(guard.as_ref().unwrap());
}

fn insert_item(
    state: &DatabaseState,
    id: &str,
    kind: &str,
    title: &str,
    description: &str,
    content: Option<&str>,
    updated_at: &str,
) {
    with_connection(state, |connection| {
        connection
            .execute(
                "INSERT INTO items (id, kind, title, description, content, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, '2026-01-01T00:00:00.000Z', ?6)",
                params![id, kind, title, description, content, updated_at],
            )
            .unwrap();
    });
}

fn set_tags(state: &DatabaseState, id: &str, tags: &[&str]) {
    let json = serde_json::to_string(tags).unwrap();
    with_connection(state, |connection| {
        connection
            .execute(
                "UPDATE items SET tags = ?2 WHERE id = ?1",
                params![id, json],
            )
            .unwrap();
    });
}

fn set_favorite(state: &DatabaseState, id: &str, favorite: bool) {
    with_connection(state, |connection| {
        connection
            .execute(
                "UPDATE items SET is_favorite = ?2 WHERE id = ?1",
                params![id, i64::from(favorite)],
            )
            .unwrap();
    });
}

fn set_collection(state: &DatabaseState, id: &str, collection_id: &str) {
    with_connection(state, |connection| {
        connection
            .execute(
                "INSERT INTO collections (id, name, sort_order, created_at)
                 VALUES (?1, 'Shelf', 0, '2026-01-01T00:00:00.000Z')",
                params![collection_id],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE items SET collection_id = ?2 WHERE id = ?1",
                params![id, collection_id],
            )
            .unwrap();
    });
}

fn trash_item(state: &DatabaseState, id: &str) {
    with_connection(state, |connection| {
        connection
            .execute(
                "UPDATE items SET deleted_at = '2026-02-01T00:00:00.000Z' WHERE id = ?1",
                params![id],
            )
            .unwrap();
    });
}

fn count_rows(state: &DatabaseState, table: &str) -> i64 {
    let guard = state.require_connection().unwrap();
    guard
        .as_ref()
        .unwrap()
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .unwrap()
}

fn initialized_state(label: &str) -> (Workspace, DatabaseState) {
    let workspace = Workspace::new(label);
    let state = workspace.state();
    state.initialize().unwrap();
    complete_setup(&state);
    (workspace, state)
}

fn search_ids(
    state: &DatabaseState,
    query: &str,
    filter: Option<vault::ItemFilter>,
) -> Vec<String> {
    let input = insights::RelatedSearchInput {
        query: query.to_string(),
        filter,
    };
    insights::search_related_items_with_state(state, &input)
        .unwrap()
        .into_iter()
        .map(|result| result.item.id)
        .collect()
}

#[test]
fn turning_related_search_off_clears_stored_vectors() {
    let (_workspace, state) = initialized_state("off-switch");
    set_flags(&state, true, false, false);
    insert_item(
        &state,
        "note-1",
        "note",
        "Alpha budget",
        "",
        Some("<p>budget</p>"),
        "2026-01-01",
    );
    insights::reindex_items_with_state(&state).unwrap();
    assert_eq!(count_rows(&state, "item_vectors"), 1);

    set_flags(&state, false, false, false);
    assert_eq!(
        count_rows(&state, "item_vectors"),
        0,
        "turning the switch off deletes derived vectors in the same write"
    );
}

#[test]
fn every_feature_is_off_by_default_and_writes_nothing() {
    let (_workspace, state) = initialized_state("off");
    insert_item(
        &state,
        "note-off",
        "note",
        "Alpha",
        "description",
        Some("<p>Alpha body.</p>"),
        "2026-01-01",
    );

    let report = insights::reindex_items_with_state(&state).unwrap();
    assert_eq!(report.indexed, 0);
    assert_eq!(report.pending, 0);
    assert_eq!(count_rows(&state, "item_vectors"), 0);
    assert_eq!(count_rows(&state, "index_state"), 0);

    assert!(search_ids(&state, "alpha", None).is_empty());
    assert!(insights::suggest_tags_with_state(&state, "note-off")
        .unwrap()
        .is_empty());
    assert!(insights::summarize_item_with_state(&state, "note-off")
        .unwrap()
        .is_empty());
}

#[test]
fn reindex_builds_vectors_clears_flags_and_skips_files() {
    let (_workspace, state) = initialized_state("reindex");
    set_flags(&state, true, false, false);
    insert_item(
        &state,
        "note-1",
        "note",
        "Budget plan",
        "monthly budget",
        Some("<p>budget details</p>"),
        "2026-01-02",
    );
    insert_item(
        &state,
        "source-1",
        "source",
        "Budget link",
        "a source",
        None,
        "2026-01-01",
    );
    insert_item(
        &state,
        "file-1",
        "file",
        "Budget file",
        "",
        None,
        "2026-01-01",
    );
    with_connection(&state, |connection| {
        connection
            .execute(
                "INSERT INTO index_state (item_id, needs_index, updated_at)
                 VALUES ('note-1', 1, '2026-01-01T00:00:00.000Z')",
                [],
            )
            .unwrap();
    });

    let report = insights::reindex_items_with_state(&state).unwrap();
    assert_eq!(report.indexed, 2, "the note and the source are indexed");
    assert_eq!(report.pending, 0);
    assert_eq!(count_rows(&state, "item_vectors"), 2);

    let (needs_index, indexed_at): (i64, Option<String>) = {
        let guard = state.require_connection().unwrap();
        guard
            .as_ref()
            .unwrap()
            .query_row(
                "SELECT needs_index, indexed_at FROM index_state WHERE item_id = 'note-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap()
    };
    assert_eq!(needs_index, 0);
    assert!(indexed_at.is_some());

    let terms: String = {
        let guard = state.require_connection().unwrap();
        guard
            .as_ref()
            .unwrap()
            .query_row(
                "SELECT terms FROM item_vectors WHERE item_id = 'note-1'",
                [],
                |row| row.get(0),
            )
            .unwrap()
    };
    assert!(terms.contains("budget"), "stored terms: {terms}");

    let file_row: Option<i64> = {
        let guard = state.require_connection().unwrap();
        guard
            .as_ref()
            .unwrap()
            .query_row(
                "SELECT 1 FROM item_vectors WHERE item_id = 'file-1'",
                [],
                |row| row.get(0),
            )
            .optional()
            .unwrap()
    };
    assert!(file_row.is_none(), "files get no vector row");

    // A second run has nothing left to do.
    let second = insights::reindex_items_with_state(&state).unwrap();
    assert_eq!(second.indexed, 0);
    assert_eq!(second.pending, 0);
}

#[test]
fn search_applies_each_filter_field_and_never_returns_trashed_items() {
    let (_workspace, state) = initialized_state("search-filters");
    set_flags(&state, true, false, false);
    insert_item(
        &state,
        "note-a",
        "note",
        "Alpha budget",
        "",
        Some("<p>x</p>"),
        "2026-01-03",
    );
    insert_item(
        &state,
        "source-b",
        "source",
        "Alpha report",
        "",
        None,
        "2026-01-02",
    );
    insert_item(
        &state,
        "note-c",
        "note",
        "Alpha plan",
        "",
        Some("<p>x</p>"),
        "2026-01-01",
    );
    insert_item(
        &state,
        "note-d",
        "note",
        "Alpha favorite",
        "",
        Some("<p>x</p>"),
        "2026-01-04",
    );
    insert_item(
        &state,
        "note-t",
        "note",
        "Alpha trashed",
        "",
        Some("<p>x</p>"),
        "2026-01-05",
    );
    set_tags(&state, "source-b", &["Finance"]);
    set_collection(&state, "note-c", "col-1");
    set_favorite(&state, "note-d", true);
    trash_item(&state, "note-t");
    insights::reindex_items_with_state(&state).unwrap();

    assert_eq!(
        search_ids(&state, "alpha", None),
        vec!["note-d", "note-a", "source-b", "note-c"],
        "tied scores order by updated_at DESC and trashed rows stay out"
    );

    let by_kind = vault::ItemFilter {
        kind: Some("source".to_string()),
        ..Default::default()
    };
    assert_eq!(search_ids(&state, "alpha", Some(by_kind)), vec!["source-b"]);

    let by_tag = vault::ItemFilter {
        tag: Some("finance".to_string()),
        ..Default::default()
    };
    assert_eq!(
        search_ids(&state, "alpha", Some(by_tag)),
        vec!["source-b"],
        "tags compare case-insensitively"
    );

    let by_collection = vault::ItemFilter {
        collection_id: Some("col-1".to_string()),
        ..Default::default()
    };
    assert_eq!(
        search_ids(&state, "alpha", Some(by_collection)),
        vec!["note-c"]
    );

    let by_favorite = vault::ItemFilter {
        favorite: Some(true),
        ..Default::default()
    };
    assert_eq!(
        search_ids(&state, "alpha", Some(by_favorite)),
        vec!["note-d"]
    );

    // The query and trashed fields are ignored; trashed rows stay excluded.
    let ignored = vault::ItemFilter {
        query: Some("does-not-match".to_string()),
        trashed: Some(true),
        ..Default::default()
    };
    assert_eq!(
        search_ids(&state, "alpha", Some(ignored)),
        vec!["note-d", "note-a", "source-b", "note-c"]
    );
}

#[test]
fn search_returns_at_most_eight_results_newest_first_on_ties() {
    let (_workspace, state) = initialized_state("search-limit");
    set_flags(&state, true, false, false);
    for index in 0..9 {
        let id = format!("note-{index}");
        let updated = format!("2026-01-{:02}", index + 1);
        insert_item(&state, &id, "note", "Alpha", "", Some("<p>x</p>"), &updated);
    }
    insights::reindex_items_with_state(&state).unwrap();

    let ids = search_ids(&state, "alpha", None);
    assert_eq!(ids.len(), 8);
    assert_eq!(ids.first().map(String::as_str), Some("note-8"));
    assert_eq!(ids.last().map(String::as_str), Some("note-1"));
}

#[test]
fn suggest_tags_excludes_existing_tags_case_insensitively_and_never_writes() {
    let (_workspace, state) = initialized_state("suggest");
    set_flags(&state, false, true, false);
    insert_item(
        &state,
        "note-1",
        "note",
        "Rust rust",
        "",
        Some("<p>Rust crates crates cargo tests tools code</p>"),
        "2026-01-01",
    );
    set_tags(&state, "note-1", &["RUST"]);

    let suggestions = insights::suggest_tags_with_state(&state, "note-1").unwrap();
    assert_eq!(suggestions.len(), 5);
    assert!(
        !suggestions
            .iter()
            .any(|term| term.eq_ignore_ascii_case("rust")),
        "existing tags are excluded case-insensitively: {suggestions:?}"
    );
    assert!(suggestions.iter().any(|term| term == "crates"));
    assert!(suggestions.iter().any(|term| term == "cargo"));
    assert_eq!(
        count_rows(&state, "item_vectors"),
        0,
        "suggestions write nothing"
    );

    insert_item(&state, "file-1", "file", "Rust", "", None, "2026-01-01");
    assert!(insights::suggest_tags_with_state(&state, "file-1")
        .unwrap()
        .is_empty());

    insert_item(
        &state,
        "note-2",
        "note",
        "Alpha",
        "",
        Some("<p>Alpha</p>"),
        "2026-01-01",
    );
    trash_item(&state, "note-2");
    assert!(insights::suggest_tags_with_state(&state, "note-2")
        .unwrap()
        .is_empty());
}

#[test]
fn summarize_returns_note_sentences_in_reading_order_and_empty_for_others() {
    let (_workspace, state) = initialized_state("summarize");
    set_flags(&state, false, false, true);
    insert_item(
        &state,
        "note-1",
        "note",
        "Title",
        "",
        Some("<p>First sentence.</p><p>Second one here. Third one here.</p>"),
        "2026-01-01",
    );
    insert_item(
        &state,
        "source-1",
        "source",
        "Topic",
        "",
        None,
        "2026-01-01",
    );
    insert_item(&state, "file-1", "file", "File", "", None, "2026-01-01");

    assert_eq!(
        insights::summarize_item_with_state(&state, "note-1").unwrap(),
        vec!["First sentence.", "Second one here.", "Third one here."]
    );
    assert!(insights::summarize_item_with_state(&state, "source-1")
        .unwrap()
        .is_empty());
    assert!(insights::summarize_item_with_state(&state, "file-1")
        .unwrap()
        .is_empty());
    assert_eq!(count_rows(&state, "item_vectors"), 0);
}

#[test]
fn encryption_on_writes_no_vectors_and_locked_reads_return_empty() {
    let (_workspace, state) = initialized_state("encrypted");
    set_flags(&state, true, true, true);
    insert_item(
        &state,
        "note-1",
        "note",
        "Alpha",
        "secret description",
        Some("<p>Secret body. Budget words.</p>"),
        "2026-01-01",
    );

    let key = {
        let mut guard = state.require_connection().unwrap();
        let connection = guard.as_mut().unwrap();
        database::write_password_verifier(connection, &security::hash_secret("pass").unwrap())
            .unwrap();
        encryption::enable(connection, state.files_dir(), "pass").unwrap()
    };

    // The content now lives only in item_secrets; the vault starts locked.
    with_connection(&state, |connection| {
        connection
            .execute("UPDATE index_state SET needs_index = 1", [])
            .unwrap();
    });
    assert_eq!(
        count_rows(&state, "item_vectors"),
        0,
        "enabling encryption already cleared vectors"
    );

    let report = insights::reindex_items_with_state(&state).unwrap();
    assert_eq!(
        report.indexed, 0,
        "no vectors are written while encryption is on"
    );
    assert!(report.pending >= 1, "the item is still reported as waiting");
    assert_eq!(count_rows(&state, "item_vectors"), 0);

    assert!(insights::suggest_tags_with_state(&state, "note-1")
        .unwrap()
        .is_empty());
    assert!(insights::summarize_item_with_state(&state, "note-1")
        .unwrap()
        .is_empty());
    assert!(search_ids(&state, "alpha", None).is_empty());

    // Unlocking reads the decrypted text in memory for the read-only features.
    state.content_key().store(key).unwrap();
    let suggestions = insights::suggest_tags_with_state(&state, "note-1").unwrap();
    assert!(
        suggestions.iter().any(|term| term == "alpha"),
        "unlocked suggestions decrypt in memory: {suggestions:?}"
    );
    assert!(!insights::summarize_item_with_state(&state, "note-1")
        .unwrap()
        .is_empty());
    assert_eq!(search_ids(&state, "alpha", None), vec!["note-1"]);
    assert_eq!(count_rows(&state, "item_vectors"), 0);

    // Locking again hides the text and writes nothing.
    state.content_key().clear().unwrap();
    assert!(insights::suggest_tags_with_state(&state, "note-1")
        .unwrap()
        .is_empty());
    assert_eq!(count_rows(&state, "item_vectors"), 0);
}

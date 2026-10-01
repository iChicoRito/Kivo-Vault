use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::database::{
    ensure_collection_accessible, ensure_item_accessible, locked_collection_ids, locked_filter_sql,
    DatabaseState, PendingImport,
};
use crate::duplicates::{self, canonical_source_url};
use crate::encryption::{self, ProtectedItem};
use crate::security::{hash_secret, secret_matches};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDetails {
    pub original_name: String,
    pub byte_size: i64,
    pub imported_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub description: String,
    pub content: Option<String>,
    pub url: Option<String>,
    pub collection_id: Option<String>,
    pub is_favorite: bool,
    pub is_pinned: bool,
    pub deleted_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub tags: Vec<String>,
    pub file: Option<FileDetails>,
    pub file_missing: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemSummary {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub is_favorite: bool,
    pub is_pinned: bool,
    pub collection_id: Option<String>,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub file: Option<FileDetails>,
    pub file_missing: bool,
    /// Raw note body, so list cards can show a short text preview.
    pub content: Option<String>,
    pub match_snippet: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: String,
    pub name: String,
    pub sort_order: i64,
    pub created_at: String,
    pub icon: Option<String>,
    pub item_count: i64,
    pub protection: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub name: String,
    pub count: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexState {
    pub item_id: String,
    pub needs_index: bool,
    pub indexed_at: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemVersion {
    pub id: String,
    pub item_id: String,
    pub title: String,
    pub content: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemFilePreview {
    pub preview: String,
    pub mime: Option<String>,
    pub text: Option<String>,
    pub payload_base64: Option<String>,
    pub byte_size: i64,
    pub original_name: String,
    pub imported_at: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageGroup {
    pub label: String,
    pub count: i64,
    pub bytes: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageFile {
    pub item_id: String,
    pub title: String,
    pub original_name: String,
    pub byte_size: i64,
    pub imported_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageReport {
    pub total_bytes: i64,
    pub database_bytes: i64,
    pub file_bytes: i64,
    pub file_count: i64,
    pub groups: Vec<StorageGroup>,
    pub largest: Vec<StorageFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSummary {
    pub item_count: i64,
    pub note_count: i64,
    pub source_count: i64,
    pub file_count: i64,
    pub favorite_count: i64,
    pub collection_count: i64,
    pub tag_count: i64,
    pub trash_count: i64,
    pub file_bytes: i64,
    pub database_bytes: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemInput {
    pub id: Option<String>,
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub content: Option<String>,
    pub url: Option<String>,
    pub collection_id: Option<String>,
    pub is_favorite: Option<bool>,
    #[serde(default)]
    pub is_pinned: Option<bool>,
    /// `check` (default) refuses a source whose address is already saved;
    /// `keepBoth` saves it anyway. Validation and access checks still run.
    #[serde(default)]
    pub duplicate_policy: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateMatch {
    pub item: ItemSummary,
    /// `url` or `file-content`.
    pub reason: String,
}

/// What a capture command did. A duplicate saves nothing and names the items
/// it matched, with the collection-access epoch the answer belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum CaptureOutcome {
    #[serde(rename_all = "camelCase")]
    Saved { item: Item },
    #[serde(rename_all = "camelCase")]
    Duplicate {
        matches: Vec<DuplicateMatch>,
        access_epoch: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileImportPreview {
    pub token: String,
    pub original_name: String,
    pub byte_size: i64,
    pub matches: Vec<DuplicateMatch>,
    pub access_epoch: u64,
}

fn keeps_both(policy: Option<&str>) -> Result<bool, String> {
    match policy {
        None | Some("check") => Ok(false),
        Some("keepBoth") => Ok(true),
        Some(_) => Err("Unknown duplicate choice".to_string()),
    }
}

/// What `write_item` did: saved under an id, or stopped because the address
/// matches these live items. A stop writes nothing.
enum WriteOutcome {
    Saved(String),
    Duplicate(Vec<String>),
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemFilter {
    pub kind: Option<String>,
    pub collection_id: Option<String>,
    pub tag: Option<String>,
    pub favorite: Option<bool>,
    pub query: Option<String>,
    pub sort: Option<String>,
    #[serde(default)]
    pub trashed: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionInput {
    pub id: Option<String>,
    pub name: String,
    pub icon: Option<String>,
    pub protection: Option<String>,
    pub secret: Option<String>,
    /// The collection's present password or PIN. Required to remove or change
    /// the lock of a protected collection, even while it is unlocked.
    #[serde(default)]
    pub current_secret: Option<String>,
}

// The raw item row plus its optional file record, before tags and disk state join in.
struct StoredItem {
    id: String,
    kind: String,
    title: String,
    description: String,
    content: Option<String>,
    url: Option<String>,
    collection_id: Option<String>,
    is_favorite: bool,
    is_pinned: bool,
    deleted_at: Option<String>,
    created_at: String,
    updated_at: String,
    tags_json: String,
    original_name: Option<String>,
    byte_size: Option<i64>,
    imported_at: Option<String>,
    stored_name: Option<String>,
}

fn new_id(connection: &Connection) -> rusqlite::Result<String> {
    connection.query_row("SELECT lower(hex(randomblob(16)))", [], |row| row.get(0))
}

// `%` and `_` are LIKE wildcards, so a literal query escapes them and the SQL
// uses `ESCAPE '\'`. The backslash itself must be escaped first.
fn escaped_like_pattern(query: &str) -> String {
    let mut pattern = String::with_capacity(query.len() + 2);
    pattern.push('%');

    for character in query.chars() {
        if matches!(character, '\\' | '%' | '_') {
            pattern.push('\\');
        }

        pattern.push(character);
    }

    pattern.push('%');
    pattern
}

fn upsert_index_state(connection: &Connection, item_id: &str) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO index_state (item_id, needs_index, indexed_at, updated_at)
         VALUES (?1, 1, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(item_id) DO UPDATE SET
            needs_index = 1,
            indexed_at = NULL,
            status = 'pending',
            updated_at = excluded.updated_at",
        params![item_id],
    )?;

    Ok(())
}

// Tag names are stored as a JSON array in `items.tags`; a malformed value reads
// as no tags.
fn parse_tags(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default()
}

fn read_item(
    connection: &Connection,
    files_dir: &Path,
    id: &str,
) -> rusqlite::Result<Option<Item>> {
    let stored = connection
        .query_row(
            "SELECT i.id, i.kind, i.title, i.description, i.content, i.url,
                    i.collection_id, i.is_favorite, i.is_pinned, i.deleted_at,
                    i.created_at, i.updated_at,
                    f.original_name, f.byte_size, f.imported_at, f.stored_name, i.tags
             FROM items i
             LEFT JOIN files f ON f.item_id = i.id
             WHERE i.id = ?1",
            params![id],
            |row| {
                Ok(StoredItem {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    title: row.get(2)?,
                    description: row.get(3)?,
                    content: row.get(4)?,
                    url: row.get(5)?,
                    collection_id: row.get(6)?,
                    is_favorite: row.get::<_, i64>(7)? != 0,
                    is_pinned: row.get::<_, i64>(8)? != 0,
                    deleted_at: row.get(9)?,
                    created_at: row.get(10)?,
                    updated_at: row.get(11)?,
                    original_name: row.get(12)?,
                    byte_size: row.get(13)?,
                    imported_at: row.get(14)?,
                    stored_name: row.get(15)?,
                    tags_json: row.get(16)?,
                })
            },
        )
        .optional()?;

    let Some(stored) = stored else {
        return Ok(None);
    };

    let tags = parse_tags(&stored.tags_json);
    let is_file = stored.kind == "file";

    let file = if is_file {
        match (&stored.original_name, stored.byte_size, &stored.imported_at) {
            (Some(original_name), Some(byte_size), Some(imported_at)) => Some(FileDetails {
                original_name: original_name.clone(),
                byte_size,
                imported_at: imported_at.clone(),
            }),
            _ => None,
        }
    } else {
        None
    };

    let file_missing = is_file
        && stored
            .stored_name
            .as_deref()
            .map(|name| !files_dir.join(name).is_file())
            .unwrap_or(false);

    Ok(Some(Item {
        id: stored.id,
        kind: stored.kind,
        title: stored.title,
        description: stored.description,
        content: stored.content,
        url: stored.url,
        collection_id: stored.collection_id,
        is_favorite: stored.is_favorite,
        is_pinned: stored.is_pinned,
        deleted_at: stored.deleted_at,
        created_at: stored.created_at,
        updated_at: stored.updated_at,
        tags,
        file,
        file_missing,
    }))
}

// Used by list_items so a summary keeps the same file and file_missing
// answers everywhere. The column order is load-bearing.
const ITEM_SUMMARY_COLUMNS: &str = "i.id, i.kind, i.title, i.is_favorite, i.is_pinned,
            i.collection_id, i.updated_at, i.deleted_at,
            f.stored_name, f.original_name, f.byte_size, f.imported_at, i.content";

fn map_summary_row(row: &rusqlite::Row<'_>, files_dir: &Path) -> rusqlite::Result<ItemSummary> {
    let kind: String = row.get(1)?;
    let stored_name: Option<String> = row.get(8)?;
    let file_missing = kind == "file"
        && stored_name
            .as_deref()
            .map(|name| !files_dir.join(name).is_file())
            .unwrap_or(false);

    let original_name: Option<String> = row.get(9)?;
    let byte_size: Option<i64> = row.get(10)?;
    let imported_at: Option<String> = row.get(11)?;

    let file = match (original_name, byte_size, imported_at) {
        (Some(original_name), Some(byte_size), Some(imported_at)) => Some(FileDetails {
            original_name,
            byte_size,
            imported_at,
        }),
        _ => None,
    };

    Ok(ItemSummary {
        id: row.get(0)?,
        kind,
        title: row.get(2)?,
        is_favorite: row.get::<_, i64>(3)? != 0,
        is_pinned: row.get::<_, i64>(4)? != 0,
        collection_id: row.get(5)?,
        updated_at: row.get(6)?,
        deleted_at: row.get(7)?,
        file,
        file_missing,
        content: row.get(12)?,
        match_snippet: None,
    })
}

fn read_item_summaries(
    connection: &Connection,
    files_dir: &Path,
    filter: Option<&ItemFilter>,
    key: Option<&[u8; 32]>,
    locked: &[String],
) -> Result<Vec<ItemSummary>, String> {
    // Trashed listings flip the scope and always order by the deletion stamp.
    let trashed = filter.and_then(|filter| filter.trashed) == Some(true);
    let mut sql = format!(
        "SELECT {ITEM_SUMMARY_COLUMNS}
         FROM items i
         LEFT JOIN files f ON f.item_id = i.id
         WHERE i.deleted_at IS {}{}",
        if trashed { "NOT NULL" } else { "NULL" },
        locked_filter_sql("i.collection_id", locked)
    );
    let mut values: Vec<rusqlite::types::Value> = locked
        .iter()
        .cloned()
        .map(rusqlite::types::Value::Text)
        .collect();
    let mut matches = HashMap::new();

    if let Some(filter) = filter {
        if let Some(kind) = filter.kind.as_deref().filter(|value| !value.is_empty()) {
            sql.push_str(" AND i.kind = ?");
            values.push(rusqlite::types::Value::Text(kind.to_string()));
        }

        if let Some(collection_id) = filter
            .collection_id
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            sql.push_str(" AND i.collection_id = ?");
            values.push(rusqlite::types::Value::Text(collection_id.to_string()));
        }

        // With a key the names are sealed, so tag and text matching run in Rust
        // on the decrypted rows below.
        if let Some(tag) = filter
            .tag
            .as_deref()
            .filter(|value| !value.is_empty() && key.is_none())
        {
            sql.push_str(
                " AND EXISTS (SELECT 1 FROM json_each(i.tags)
                              WHERE value = ? COLLATE NOCASE)",
            );
            values.push(rusqlite::types::Value::Text(tag.to_string()));
        }

        if let Some(favorite) = filter.favorite {
            sql.push_str(" AND i.is_favorite = ?");
            values.push(rusqlite::types::Value::Integer(i64::from(favorite)));
        }

        if let Some(query) = filter
            .query
            .as_deref()
            .map(str::trim)
            .filter(|q| !q.is_empty() && key.is_none())
        {
            let phrase = format!("\"{}\"", query.replace('"', "\"\""));
            if let Ok(mut statement) = connection.prepare(
                "SELECT item_id, snippet(item_search, 3, '', '', '…', 12), bm25(item_search) FROM item_search WHERE item_search MATCH ?1"
            ) {
                if let Ok(rows) = statement.query_map(params![phrase], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, f64>(2)?))) {
                    matches = rows.flatten().map(|(id, snippet, rank)| (id, (snippet, rank))).collect();
                }
            }
            matches.retain(|id, _| {
                connection
                    .query_row(
                        "SELECT f.stored_name FROM files f WHERE f.item_id = ?1",
                        params![id],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()
                    .ok()
                    .flatten()
                    .is_none_or(|name| files_dir.join(name).is_file())
            });
            let pattern = escaped_like_pattern(query);
            sql.push_str(
                " AND (i.title LIKE ? ESCAPE '\\'
                    OR i.description LIKE ? ESCAPE '\\'
                    OR i.content LIKE ? ESCAPE '\\'
                    OR i.url LIKE ? ESCAPE '\\'
                    OR f.original_name LIKE ? ESCAPE '\\'
                    OR EXISTS (SELECT 1 FROM json_each(i.tags)
                               WHERE value LIKE ? ESCAPE '\\')
                    OR EXISTS (SELECT 1 FROM collections c
                               WHERE c.id = i.collection_id AND c.name LIKE ? ESCAPE '\\')",
            );

            for _ in 0..7 {
                values.push(rusqlite::types::Value::Text(pattern.clone()));
            }
            if !matches.is_empty() {
                sql.push_str(" OR i.id IN (");
                sql.push_str(&vec!["?"; matches.len()].join(","));
                sql.push(')');
                values.extend(matches.keys().cloned().map(rusqlite::types::Value::Text));
            }
            sql.push(')');
        }
    }

    let order = if trashed {
        "i.deleted_at DESC"
    } else {
        match filter.and_then(|filter| filter.sort.as_deref()) {
            Some("title") => "i.title COLLATE NOCASE ASC, i.updated_at DESC",
            Some("created") => "i.created_at DESC, i.updated_at DESC",
            Some("kind") => "i.kind ASC, i.updated_at DESC",
            _ => "i.updated_at DESC, i.title COLLATE NOCASE ASC",
        }
    };

    sql.push_str(" ORDER BY ");
    sql.push_str(order);

    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;

    let mut summaries = statement
        .query_map(rusqlite::params_from_iter(values.iter()), |row| {
            map_summary_row(row, files_dir)
        })
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<ItemSummary>>>()
        .map_err(|error| error.to_string())?;

    // The plaintext columns stay blank while encryption is on, so the shown
    // fields come from each item's secret, and the tag and text filters run
    // here on the decrypted values.
    if let Some(key) = key {
        let tag = filter
            .and_then(|filter| filter.tag.as_deref())
            .filter(|value| !value.is_empty())
            .map(str::to_lowercase);
        let query = filter
            .and_then(|filter| filter.query.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_lowercase);
        let collection_names: HashMap<String, String> = if query.is_some() {
            read_collections(connection, Some(key))
                .map_err(|error| error.to_string())?
                .into_iter()
                .map(|collection| (collection.id, collection.name))
                .collect()
        } else {
            HashMap::new()
        };

        let mut kept = Vec::with_capacity(summaries.len());
        for mut summary in summaries {
            let secret = encryption::read_secret(connection, key, &summary.id)?;
            if let Some(title) = secret.title {
                summary.title = title;
            }
            if let (Some(name), Some(file)) = (secret.file_name, summary.file.as_mut()) {
                file.original_name = name;
            }
            summary.content = secret.content;
            let tags = secret.tags.unwrap_or_default();

            if let Some(tag) = &tag {
                if !tags.iter().any(|value| value.to_lowercase() == *tag) {
                    continue;
                }
            }
            if let Some(query) = &query {
                let collection = summary
                    .collection_id
                    .as_ref()
                    .and_then(|id| collection_names.get(id));
                let found = [
                    Some(&summary.title),
                    Some(&secret.description),
                    summary.content.as_ref(),
                    secret.url.as_ref(),
                    summary.file.as_ref().map(|file| &file.original_name),
                    collection,
                ]
                .into_iter()
                .flatten()
                .chain(tags.iter())
                .any(|value| value.to_lowercase().contains(query.as_str()));
                if !found {
                    continue;
                }
            }
            kept.push(summary);
        }
        summaries = kept;

        if !trashed && filter.and_then(|filter| filter.sort.as_deref()) == Some("title") {
            summaries.sort_by_key(|summary| summary.title.to_lowercase());
        }
    }

    for summary in &mut summaries {
        if summary.file_missing {
            matches.remove(&summary.id);
        }
        summary.match_snippet = matches.get(&summary.id).map(|(text, _)| text.clone());
    }
    if !trashed
        && filter
            .and_then(|filter| filter.query.as_deref())
            .is_some_and(|q| !q.trim().is_empty())
        && filter.and_then(|filter| filter.sort.as_deref()).is_none()
    {
        summaries.sort_by(|a, b| {
            let rank = |item: &ItemSummary| {
                matches
                    .get(&item.id)
                    .map(|(_, rank)| *rank)
                    .unwrap_or(f64::INFINITY)
            };
            rank(a).total_cmp(&rank(b))
        });
    }
    Ok(summaries)
}

const COLLECTION_SELECT: &str = "SELECT c.id, c.name, c.sort_order, c.created_at, c.icon,
            (SELECT COUNT(*) FROM items i
             WHERE i.collection_id = c.id AND i.deleted_at IS NULL),
            c.protection, c.name_secret
     FROM collections c";

fn map_collection_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<(Collection, Option<Vec<u8>>)> {
    Ok((
        Collection {
            id: row.get(0)?,
            name: row.get(1)?,
            sort_order: row.get(2)?,
            created_at: row.get(3)?,
            icon: row.get(4)?,
            item_count: row.get(5)?,
            protection: row.get(6)?,
        },
        row.get(7)?,
    ))
}

// A sealed name opens with the key; without one the stored column is used.
fn open_collection(
    key: Option<&[u8; 32]>,
    (mut collection, sealed): (Collection, Option<Vec<u8>>),
) -> Result<Collection, String> {
    if let (Some(key), Some(sealed)) = (key, sealed) {
        collection.name = encryption::open_collection_name(key, &collection.id, &sealed)?;
    }
    Ok(collection)
}

fn read_collection(
    connection: &Connection,
    id: &str,
    key: Option<&[u8; 32]>,
) -> Result<Option<Collection>, String> {
    connection
        .query_row(
            &format!("{COLLECTION_SELECT} WHERE c.id = ?1"),
            params![id],
            map_collection_row,
        )
        .optional()
        .map_err(|error| error.to_string())?
        .map(|row| open_collection(key, row))
        .transpose()
}

fn read_collections(
    connection: &Connection,
    key: Option<&[u8; 32]>,
) -> Result<Vec<Collection>, String> {
    let mut statement = connection
        .prepare(&format!(
            "{COLLECTION_SELECT} ORDER BY c.sort_order ASC, c.name COLLATE NOCASE ASC"
        ))
        .map_err(|error| error.to_string())?;

    let rows = statement
        .query_map([], map_collection_row)
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;
    let mut collections = rows
        .into_iter()
        .map(|row| open_collection(key, row))
        .collect::<Result<Vec<_>, _>>()?;
    if key.is_some() {
        collections.sort_by(|a, b| {
            a.sort_order
                .cmp(&b.sort_order)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
    }

    Ok(collections)
}

// Item tags only. Password tags are encrypted with the rest of each credential,
// so they stay inside the Passwords page. An item only counts once per tag.
// With a key the tags are sealed, so they are counted from each live item's
// secret instead.
pub(crate) fn read_tags(connection: &Connection, key: Option<&[u8; 32]>) -> Result<Vec<Tag>, String> {
    if let Some(key) = key {
        let ids: Vec<String> = {
            let mut statement = connection
                .prepare("SELECT id FROM items WHERE deleted_at IS NULL")
                .map_err(|error| error.to_string())?;
            let ids = statement
                .query_map([], |row| row.get(0))
                .map_err(|error| error.to_string())?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|error| error.to_string())?;
            ids
        };
        // lowercase name -> (shown spelling, item count)
        let mut counts: HashMap<String, (String, i64)> = HashMap::new();
        for id in ids {
            let tags = encryption::read_secret(connection, key, &id)?
                .tags
                .unwrap_or_default();
            let mut seen = std::collections::HashSet::new();
            for tag in tags {
                let lower = tag.to_lowercase();
                if !seen.insert(lower.clone()) {
                    continue;
                }
                let entry = counts.entry(lower).or_insert((tag.clone(), 0));
                if tag < entry.0 {
                    entry.0 = tag;
                }
                entry.1 += 1;
            }
        }
        let mut tags: Vec<Tag> = counts
            .into_values()
            .map(|(name, count)| Tag { name, count })
            .collect();
        tags.sort_by_key(|tag| tag.name.to_lowercase());
        return Ok(tags);
    }

    read_plain_tags(connection).map_err(|error| error.to_string())
}

fn read_plain_tags(connection: &Connection) -> rusqlite::Result<Vec<Tag>> {
    let mut statement = connection.prepare(
        "SELECT MIN(value) AS name, COUNT(DISTINCT i.id) AS count
         FROM items i, json_each(i.tags)
         WHERE i.deleted_at IS NULL
         GROUP BY lower(value)
         ORDER BY MIN(value) COLLATE NOCASE ASC",
    )?;

    let tags = statement
        .query_map([], |row| {
            Ok(Tag {
                name: row.get(0)?,
                count: row.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<Tag>>>()?;

    Ok(tags)
}

fn read_index_state(connection: &Connection) -> rusqlite::Result<Vec<IndexState>> {
    let mut statement = connection.prepare(
        "SELECT item_id, needs_index, indexed_at, status
         FROM index_state
         ORDER BY updated_at DESC, item_id ASC",
    )?;

    let rows = statement
        .query_map([], |row| {
            Ok(IndexState {
                item_id: row.get(0)?,
                needs_index: row.get::<_, i64>(1)? != 0,
                indexed_at: row.get(2)?,
                status: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<IndexState>>>()?;

    Ok(rows)
}

fn plain_text(html: &str) -> String {
    let mut result = String::new();
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => {
                in_tag = true;
                result.push(' ');
            }
            '>' => in_tag = false,
            _ if !in_tag => result.push(ch),
            _ => {}
        }
    }
    result
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

fn insert_version(
    connection: &Connection,
    item_id: &str,
    title: &str,
    content: &str,
    key: Option<&[u8; 32]>,
) -> Result<(), String> {
    // The version id is the associated-data binding, so it is chosen before the
    // snapshot is encrypted and stored.
    let version_id = new_id(connection).map_err(|error| error.to_string())?;
    match key {
        Some(key) => {
            let encrypted = encryption::encrypt_version(key, &version_id, content)?;
            let sealed_title = encryption::seal_version_title(key, &version_id, title)?;
            connection
                .execute(
                    "INSERT INTO item_versions(id, item_id, title, content, encrypted_content, title_secret, created_at)
                     VALUES (?1, ?2, '', '', ?3, ?4, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                    params![version_id, item_id, encrypted, sealed_title],
                )
                .map_err(|error| error.to_string())?;
        }
        None => {
            connection
                .execute(
                    "INSERT INTO item_versions(id, item_id, title, content, created_at)
                     VALUES (?1, ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                    params![version_id, item_id, title, content],
                )
                .map_err(|error| error.to_string())?;
        }
    }
    connection
        .execute(
            "DELETE FROM item_versions WHERE item_id = ?1 AND id NOT IN
             (SELECT id FROM item_versions WHERE item_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 20)",
            params![item_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn read_versions(
    connection: &Connection,
    item_id: &str,
    key: Option<&[u8; 32]>,
) -> Result<Vec<ItemVersion>, String> {
    let mut statement = connection
        .prepare("SELECT id, item_id, title, content, encrypted_content, created_at, title_secret FROM item_versions WHERE item_id = ?1 ORDER BY created_at DESC, rowid DESC")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![item_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<Vec<u8>>>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<Vec<u8>>>(6)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;

    let mut versions = Vec::with_capacity(rows.len());
    for (id, item_id, title, content, encrypted, created_at, sealed_title) in rows {
        let content = match (key, encrypted) {
            (Some(key), Some(bytes)) => encryption::decrypt_version(key, &id, &bytes)?,
            _ => content,
        };
        let title = match (key, sealed_title) {
            (Some(key), Some(bytes)) => encryption::open_version_title(key, &id, &bytes)?,
            _ => title,
        };
        versions.push(ItemVersion {
            id,
            item_id,
            title,
            content,
            created_at,
        });
    }
    Ok(versions)
}

// Validation failures keep their exact user-facing text; SQL failures carry the
// same "Could not save the item" prefix as the phase-one commands.
fn write_item(
    connection: &mut Connection,
    input: &ItemInput,
    key: Option<&[u8; 32]>,
    duplicate_scope: Option<&[String]>,
) -> Result<WriteOutcome, String> {
    let title = input.title.trim().to_string();

    if title.is_empty() {
        return Err("Item title is required".to_string());
    }

    let is_update = input.id.is_some();

    // An existing item keeps its stored kind, content, and url. Only the fields
    // that belong to its kind are rewritten, so a file item can update its
    // metadata without gaining note or source data.
    let (id, kind, stored_content, stored_url) = match &input.id {
        Some(id) => {
            let stored: Option<(String, Option<String>, Option<String>)> = connection
                .query_row(
                    "SELECT kind, content, url FROM items WHERE id = ?1",
                    params![id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
                .map_err(|error| format!("Could not save the item: {error}"))?;

            let (stored_kind, mut stored_content, mut stored_url) =
                stored.ok_or_else(|| "Item was not found".to_string())?;

            if input.kind != stored_kind {
                return Err("Item type cannot change".to_string());
            }

            // While encryption is on the columns are blank; the previous values
            // live in item_secrets, so read them decrypted for the comparison,
            // the version snapshot, and a file item's kept content and url.
            if let Some(key) = key {
                let previous = encryption::read_secret(connection, key, id)
                    .map_err(|error| format!("Could not save the item: {error}"))?;
                stored_content = previous.content;
                stored_url = previous.url;
            }

            (id.clone(), stored_kind, stored_content, stored_url)
        }
        None => {
            match input.kind.as_str() {
                "note" | "source" => {}
                "file" => return Err("File items are created by import".to_string()),
                _ => return Err("Items must be notes, sources, or files".to_string()),
            }

            let id =
                new_id(connection).map_err(|error| format!("Could not save the item: {error}"))?;

            (id, input.kind.clone(), None, None)
        }
    };

    let collection_id = match &input.collection_id {
        Some(collection_id) => {
            let exists: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM collections WHERE id = ?1",
                    params![collection_id],
                    |row| row.get(0),
                )
                .map_err(|error| format!("Could not save the item: {error}"))?;

            if exists == 0 {
                return Err("Collection does not exist".to_string());
            }

            Some(collection_id.clone())
        }
        None => None,
    };

    let previous_canonical = stored_url.as_deref().and_then(canonical_source_url);

    let (content, url) = match kind.as_str() {
        "note" => (Some(input.content.clone().unwrap_or_default()), None),
        "source" => {
            let url = input.url.as_deref().unwrap_or("").trim();

            if url.is_empty() {
                return Err("Source items need a web address".to_string());
            }

            if !is_web_url(url) {
                return Err("Web addresses must start with http:// or https://".to_string());
            }

            (input.content.clone(), Some(url.to_string()))
        }
        _ => (stored_content.clone(), stored_url),
    };

    let description = input.description.clone();
    let is_favorite = i64::from(input.is_favorite.unwrap_or(false));
    let is_pinned = i64::from(input.is_pinned.unwrap_or(false));

    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not save the item: {error}"))?;

    // Checked inside the transaction, under the database lock, so nothing can
    // save the same address between the check and the write. An edit is only
    // checked when its address changes, and never against itself.
    if let (Some(locked), "source") = (duplicate_scope, kind.as_str()) {
        let canonical = url.as_deref().and_then(canonical_source_url);
        if let Some(canonical) = canonical.filter(|value| !is_update || previous_canonical.as_ref() != Some(value)) {
            let ids = duplicates::find_source_matches(
                &transaction,
                key,
                locked,
                &canonical,
                input.id.as_deref(),
            )?;
            if !ids.is_empty() {
                return Ok(WriteOutcome::Duplicate(ids));
            }
        }
    }

    let old_title = if kind == "note" && is_update {
        let column: String = transaction
            .query_row(
                "SELECT title FROM items WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .map_err(|error| format!("Could not save the item: {error}"))?;
        // A sealed title lives in the secret; the column is blank.
        let sealed = match key {
            Some(key) => encryption::read_secret(&transaction, key, &id)
                .map_err(|error| format!("Could not save the item: {error}"))?
                .title,
            None => None,
        };
        Some(sealed.unwrap_or(column))
    } else {
        None
    };
    if kind == "note" && is_update && stored_content != content {
        let previous = (
            old_title.as_deref().unwrap_or_default().to_string(),
            stored_content.as_deref().unwrap_or_default().to_string(),
        );
        let recent: i64 = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM item_versions WHERE item_id = ?1 AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 minutes'))",
            params![id], |row| row.get(0),
        ).map_err(|error| format!("Could not save the item: {error}"))?;
        if recent == 0 {
            insert_version(&transaction, &id, &previous.0, &previous.1, key)
                .map_err(|error| format!("Could not save the item: {error}"))?;
        }
    }

    if is_update {
        match key {
            Some(key) => {
                transaction
                    .execute(
                        "UPDATE items
                         SET title = '', description = '', content = NULL, url = NULL,
                             collection_id = ?1, is_favorite = ?2, is_pinned = ?3,
                             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                         WHERE id = ?4",
                        params![collection_id, is_favorite, is_pinned, id],
                    )
                    .map_err(|error| format!("Could not save the item: {error}"))?;
                encryption::write_secret(
                    &transaction,
                    key,
                    &id,
                    &ProtectedItem {
                        description: description.clone(),
                        content: content.clone(),
                        url: url.clone(),
                        title: Some(title.clone()),
                        ..Default::default()
                    },
                )
                .map_err(|error| format!("Could not save the item: {error}"))?;
            }
            None => {
                transaction
                    .execute(
                        "UPDATE items
                         SET title = ?1, description = ?2, content = ?3, url = ?4,
                             collection_id = ?5, is_favorite = ?6, is_pinned = ?7,
                             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                         WHERE id = ?8",
                        params![
                            title,
                            description,
                            content,
                            url,
                            collection_id,
                            is_favorite,
                            is_pinned,
                            id
                        ],
                    )
                    .map_err(|error| format!("Could not save the item: {error}"))?;
            }
        }
    } else {
        match key {
            Some(key) => {
                transaction
                    .execute(
                        "INSERT INTO items
                           (id, kind, title, description, content, url, collection_id, is_favorite,
                            is_pinned, created_at, updated_at)
                         VALUES (?1, ?2, '', '', NULL, NULL, ?3, ?4, ?5,
                                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                        params![id, kind, collection_id, is_favorite, is_pinned],
                    )
                    .map_err(|error| format!("Could not save the item: {error}"))?;
                encryption::write_secret(
                    &transaction,
                    key,
                    &id,
                    &ProtectedItem {
                        description: description.clone(),
                        content: content.clone(),
                        url: url.clone(),
                        title: Some(title.clone()),
                        tags: Some(Vec::new()),
                        ..Default::default()
                    },
                )
                .map_err(|error| format!("Could not save the item: {error}"))?;
            }
            None => {
                transaction
                    .execute(
                        "INSERT INTO items
                           (id, kind, title, description, content, url, collection_id, is_favorite,
                            is_pinned, created_at, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
                                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                        params![
                            id,
                            kind,
                            title,
                            description,
                            content,
                            url,
                            collection_id,
                            is_favorite,
                            is_pinned
                        ],
                    )
                    .map_err(|error| format!("Could not save the item: {error}"))?;
            }
        }
    }

    if key.is_some() {
        // Protected content never reaches the plaintext index. Drop any existing
        // row and mark the item dirty so a rebuild runs after an unlock.
        transaction
            .execute("DELETE FROM item_search WHERE item_id = ?1", params![id])
            .map_err(|error| format!("Could not save the item: {error}"))?;
        upsert_index_state(&transaction, &id)
            .map_err(|error| format!("Could not save the item: {error}"))?;
    } else if kind == "note"
        && (old_title.as_deref() != Some(title.as_str()) || stored_content != content)
    {
        transaction
            .execute("DELETE FROM item_search WHERE item_id = ?1", params![id])
            .map_err(|error| format!("Could not save the item: {error}"))?;
        transaction
            .execute(
                "INSERT INTO item_search(item_id, kind, title, body) VALUES (?1, 'note', ?2, ?3)",
                params![id, title, plain_text(content.as_deref().unwrap_or(""))],
            )
            .map_err(|error| format!("Could not save the item: {error}"))?;
        transaction.execute("INSERT INTO index_state(item_id, needs_index, indexed_at, updated_at, status) VALUES (?1, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'indexed') ON CONFLICT(item_id) DO UPDATE SET needs_index=0, indexed_at=excluded.indexed_at, updated_at=excluded.updated_at, status='indexed'", params![id]).map_err(|error| format!("Could not save the item: {error}"))?;
    } else if kind == "file" {
        transaction
            .execute(
                "UPDATE item_search SET title = ?2 WHERE item_id = ?1",
                params![id, title],
            )
            .map_err(|error| format!("Could not save the item: {error}"))?;
    } else {
        upsert_index_state(&transaction, &id)
            .map_err(|error| format!("Could not save the item: {error}"))?;
    }

    transaction
        .commit()
        .map_err(|error| format!("Could not save the item: {error}"))?;

    Ok(WriteOutcome::Saved(id))
}

fn replace_item_tags(
    connection: &mut Connection,
    item_id: &str,
    tags: &[String],
    key: Option<&[u8; 32]>,
) -> Result<Vec<String>, String> {
    let mut seen = std::collections::HashSet::new();
    let mut names = Vec::new();

    for tag in tags {
        let name = tag.trim();

        if name.is_empty() {
            continue;
        }

        // Case-insensitive dedupe, first spelling wins.
        if seen.insert(name.to_lowercase()) {
            names.push(name.to_string());
        }
    }

    let encoded = serde_json::to_string(&names)
        .map_err(|error| format!("Could not save the item tags: {error}"))?;

    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not save the item tags: {error}"))?;

    let exists: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM items WHERE id = ?1",
            params![item_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not save the item tags: {error}"))?;

    if exists == 0 {
        return Err("Item was not found".to_string());
    }

    // With a key the tags are sealed in the secret and the column stays empty.
    let column = match key {
        Some(key) => {
            let mut secret = encryption::read_secret(&transaction, key, item_id)
                .map_err(|error| format!("Could not save the item tags: {error}"))?;
            secret.tags = Some(names.clone());
            encryption::write_secret(&transaction, key, item_id, &secret)
                .map_err(|error| format!("Could not save the item tags: {error}"))?;
            "[]".to_string()
        }
        None => encoded,
    };
    transaction
        .execute(
            "UPDATE items
             SET tags = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?1",
            params![item_id, column],
        )
        .map_err(|error| format!("Could not save the item tags: {error}"))?;

    transaction
        .commit()
        .map_err(|error| format!("Could not save the item tags: {error}"))?;

    Ok(names)
}

fn write_item_pin(connection: &mut Connection, id: &str, pinned: bool) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not update the item: {error}"))?;

    let updated = transaction
        .execute(
            "UPDATE items SET is_pinned = ?1 WHERE id = ?2",
            params![i64::from(pinned), id],
        )
        .map_err(|error| format!("Could not update the item: {error}"))?;

    if updated == 0 {
        return Err("Item was not found".to_string());
    }

    transaction
        .commit()
        .map_err(|error| format!("Could not update the item: {error}"))
}

fn write_items_favorite(
    connection: &mut Connection,
    ids: &[String],
    favorite: bool,
) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }

    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not update the items: {error}"))?;

    for id in ids {
        transaction
            .execute(
                "UPDATE items SET is_favorite = ?1 WHERE id = ?2",
                params![i64::from(favorite), id],
            )
            .map_err(|error| format!("Could not update the items: {error}"))?;
    }

    transaction
        .commit()
        .map_err(|error| format!("Could not update the items: {error}"))
}

fn write_items_collection(
    connection: &mut Connection,
    ids: &[String],
    collection_id: Option<&str>,
) -> Result<(), String> {
    if let Some(collection_id) = collection_id {
        let exists: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM collections WHERE id = ?1",
                params![collection_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("Could not move the items: {error}"))?;

        if exists == 0 {
            return Err("Collection does not exist".to_string());
        }
    }

    if ids.is_empty() {
        return Ok(());
    }

    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not move the items: {error}"))?;

    for id in ids {
        transaction
            .execute(
                "UPDATE items SET collection_id = ?1 WHERE id = ?2 AND collection_id IS NOT ?1",
                params![collection_id, id],
            )
            .map_err(|error| format!("Could not move the items: {error}"))?;
    }

    transaction
        .commit()
        .map_err(|error| format!("Could not move the items: {error}"))
}

pub(crate) fn write_trashed_items(connection: &mut Connection, ids: &[String]) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }

    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not move the items to Trash: {error}"))?;

    for id in ids {
        let updated = transaction
            .execute(
                "UPDATE items
                 SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                 WHERE id = ?1 AND deleted_at IS NULL",
                params![id],
            )
            .map_err(|error| format!("Could not move the items to Trash: {error}"))?;

        if updated == 0 {
            continue;
        }
    }

    transaction
        .commit()
        .map_err(|error| format!("Could not move the items to Trash: {error}"))
}

fn write_restored_items(connection: &mut Connection, ids: &[String]) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }

    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not restore the items: {error}"))?;

    for id in ids {
        let updated = transaction
            .execute(
                "UPDATE items SET deleted_at = NULL
                 WHERE id = ?1 AND deleted_at IS NOT NULL",
                params![id],
            )
            .map_err(|error| format!("Could not restore the items: {error}"))?;

        if updated == 0 {
            continue;
        }
    }

    transaction
        .commit()
        .map_err(|error| format!("Could not restore the items: {error}"))
}

// Reads the managed names first, deletes the rows (files and index_state
// cascade), then removes the bytes best effort. An id that is not
// trashed is ignored, so a live item can never be destroyed through this path.
fn remove_items_permanently(
    connection: &mut Connection,
    files_dir: &Path,
    ids: &[String],
) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }

    let mut stored_names: Vec<String> = Vec::new();

    {
        let mut statement = connection
            .prepare(
                "SELECT f.stored_name
                 FROM files f
                 JOIN items i ON i.id = f.item_id
                 WHERE i.id = ?1 AND i.deleted_at IS NOT NULL",
            )
            .map_err(|error| format!("Could not delete the items: {error}"))?;

        for id in ids {
            let stored_name = statement
                .query_row(params![id], |row| row.get::<_, String>(0))
                .optional()
                .map_err(|error| format!("Could not delete the items: {error}"))?;

            if let Some(stored_name) = stored_name {
                stored_names.push(stored_name);
            }
        }
    }

    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not delete the items: {error}"))?;

    for id in ids {
        transaction.execute("DELETE FROM item_search WHERE item_id = ?1 AND EXISTS (SELECT 1 FROM items WHERE id = ?1 AND deleted_at IS NOT NULL)", params![id]).map_err(|error| format!("Could not delete the items: {error}"))?;
        transaction
            .execute(
                "DELETE FROM items WHERE id = ?1 AND deleted_at IS NOT NULL",
                params![id],
            )
            .map_err(|error| format!("Could not delete the items: {error}"))?;
    }

    transaction
        .commit()
        .map_err(|error| format!("Could not delete the items: {error}"))?;

    for stored_name in stored_names {
        let _ = fs::remove_file(files_dir.join(stored_name));
    }

    Ok(())
}

/// Resolves the requested protection into the value to store. `None` means the
/// caller did not mention protection, so an update leaves the stored value and
/// hash untouched. `Some((level, hash))` writes both.
fn resolve_collection_protection(
    protection: Option<&str>,
    secret: Option<&str>,
) -> Result<Option<(String, Option<String>)>, String> {
    match protection {
        None => Ok(None),
        Some("none") => Ok(Some(("none".to_string(), None))),
        Some(level @ ("password" | "pin")) => {
            let secret = secret.unwrap_or("").trim();

            if level == "password" {
                if secret.chars().count() < 4 {
                    return Err("Password must be at least 4 characters".to_string());
                }
            } else if secret.len() != 6
                || !secret.chars().all(|character| character.is_ascii_digit())
            {
                return Err("PIN must be 6 digits".to_string());
            }

            let hash = hash_secret(secret)?;

            Ok(Some((level.to_string(), Some(hash))))
        }
        Some(_) => Err("Collection protection is not supported".to_string()),
    }
}

fn write_collection(
    connection: &mut Connection,
    input: &CollectionInput,
) -> Result<String, String> {
    let name = input.name.trim().to_string();

    if name.is_empty() {
        return Err("Collection name is required".to_string());
    }

    let icon = input
        .icon
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    // Resolved before the transaction so a bad secret never opens one.
    let protection =
        resolve_collection_protection(input.protection.as_deref(), input.secret.as_deref())?;

    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not save the collection: {error}"))?;

    let duplicate: Option<String> = transaction
        .query_row(
            "SELECT id FROM collections WHERE name = ?1 COLLATE NOCASE",
            params![name],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Could not save the collection: {error}"))?;

    let id = match &input.id {
        Some(id) => {
            let exists: i64 = transaction
                .query_row(
                    "SELECT COUNT(*) FROM collections WHERE id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .map_err(|error| format!("Could not save the collection: {error}"))?;

            if exists == 0 {
                return Err("Collection was not found".to_string());
            }

            if duplicate
                .as_deref()
                .is_some_and(|duplicate| duplicate != id.as_str())
            {
                return Err("A collection with that name already exists".to_string());
            }

            match &protection {
                Some((level, hash)) => {
                    transaction
                        .execute(
                            "UPDATE collections
                             SET name = ?1, icon = ?2, protection = ?3, secret_hash = ?4
                             WHERE id = ?5",
                            params![name, icon, level, hash, id],
                        )
                        .map_err(|error| format!("Could not save the collection: {error}"))?;
                }
                None => {
                    transaction
                        .execute(
                            "UPDATE collections SET name = ?1, icon = ?2 WHERE id = ?3",
                            params![name, icon, id],
                        )
                        .map_err(|error| format!("Could not save the collection: {error}"))?;
                }
            }

            id.clone()
        }
        None => {
            if duplicate.is_some() {
                return Err("A collection with that name already exists".to_string());
            }

            let id = new_id(&transaction)
                .map_err(|error| format!("Could not save the collection: {error}"))?;

            // A create always stores a level, defaulting to an open collection.
            let (level, hash) = protection.unwrap_or_else(|| ("none".to_string(), None));

            transaction
                .execute(
                    "INSERT INTO collections
                       (id, name, sort_order, created_at, icon, protection, secret_hash)
                     VALUES (?1, ?2,
                             (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM collections),
                             strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?3, ?4, ?5)",
                    params![id, name, icon, level, hash],
                )
                .map_err(|error| format!("Could not save the collection: {error}"))?;

            id
        }
    };

    transaction
        .commit()
        .map_err(|error| format!("Could not save the collection: {error}"))?;

    Ok(id)
}

fn remove_collection(connection: &mut Connection, id: &str) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not delete the collection: {error}"))?;

    let deleted = transaction
        .execute("DELETE FROM collections WHERE id = ?1", params![id])
        .map_err(|error| format!("Could not delete the collection: {error}"))?;

    if deleted == 0 {
        return Err("Collection was not found".to_string());
    }

    transaction
        .commit()
        .map_err(|error| format!("Could not delete the collection: {error}"))
}

// The extension keeps ASCII letters and digits only, capped at ten characters.
fn filtered_extension(path: &Path) -> String {
    let Some(extension) = path.extension().and_then(|extension| extension.to_str()) else {
        return String::new();
    };

    extension
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .map(|character| character.to_ascii_lowercase())
        .take(10)
        .collect()
}

fn build_stored_name(id: &str, source: &Path) -> String {
    let extension = filtered_extension(source);

    if extension.is_empty() {
        id.to_string()
    } else {
        format!("{id}.{extension}")
    }
}

/// Where a new managed file's bytes come from: a staged plaintext copy that is
/// moved into place, or plaintext already in memory (decrypted from an
/// encrypted staging copy) that is sealed under the new item's id.
enum ManagedBytes<'a> {
    Staged(&'a Path),
    Plain(Vec<u8>),
}

#[allow(clippy::too_many_arguments)]
fn write_import(
    connection: &mut Connection,
    files_dir: &Path,
    bytes: ManagedBytes<'_>,
    original_name: &str,
    byte_size: i64,
    digest: &[u8; 32],
    collection_id: Option<&str>,
    key: Option<&[u8; 32]>,
) -> Result<String, String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not import the file: {error}"))?;

    let id = new_id(&transaction).map_err(|error| format!("Could not import the file: {error}"))?;
    let stored_name = build_stored_name(&id, Path::new(original_name));
    let target = files_dir.join(&stored_name);

    if target.exists() {
        return Err("A managed file with the same name already exists".to_string());
    }

    transaction
        .execute(
            "INSERT INTO items
               (id, kind, title, description, content, url, collection_id, is_favorite,
                created_at, updated_at)
             VALUES (?1, 'file', ?2, '', NULL, NULL, ?3, 0,
                     strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                     strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            params![id, original_name, collection_id],
        )
        .map_err(|error| format!("Could not import the file: {error}"))?;

    // Every item carries a secret row while encryption is on, even when its
    // protected fields are empty, so reads never miss the row.
    if let Some(key) = key {
        encryption::write_secret(
            &transaction,
            key,
            &id,
            &ProtectedItem {
                tags: Some(Vec::new()),
                ..Default::default()
            },
        )
        .map_err(|error| format!("Could not import the file: {error}"))?;
    }

    transaction
        .execute(
            "INSERT INTO files (item_id, stored_name, original_name, byte_size, imported_at, encrypted, content_digest)
             VALUES (?1, ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?5, ?6)",
            params![
                id,
                stored_name,
                original_name,
                byte_size,
                i64::from(key.is_some()),
                duplicates::seal_digest(key, &id, digest)?
            ],
        )
        .map_err(|error| format!("Could not import the file: {error}"))?;

    // The title and file name go into the secret before the commit.
    if let Some(key) = key {
        encryption::seal_all(&transaction, key)
            .map_err(|error| format!("Could not import the file: {error}"))?;
    }

    upsert_index_state(&transaction, &id)
        .map_err(|error| format!("Could not import the file: {error}"))?;

    // The transaction holds the rows; the bytes land on disk before the commit.
    // The plaintext size stays in `byte_size` even when the stored bytes are
    // encrypted.
    let write_result = match (key, bytes) {
        (Some(key), ManagedBytes::Plain(plain)) => {
            let encrypted = encryption::encrypt_file(key, &id, &plain)
                .map_err(|error| format!("Could not import the file: {error}"))?;
            fs::write(&target, &encrypted)
                .map_err(|error| format!("Could not copy file into managed storage: {error}"))
        }
        (None, ManagedBytes::Plain(plain)) => fs::write(&target, &plain)
            .map_err(|error| format!("Could not copy file into managed storage: {error}")),
        // Staging sits next to the managed folder, so a rename is the usual path.
        (None, ManagedBytes::Staged(staged)) => fs::rename(staged, &target)
            .or_else(|_| fs::copy(staged, &target).map(|_| ()))
            .map_err(|error| format!("Could not copy file into managed storage: {error}")),
        (Some(_), ManagedBytes::Staged(_)) => {
            return Err("This file was staged before encryption changed. Pick it again.".to_string())
        }
    };
    if let Err(error) = write_result {
        let _ = fs::remove_file(&target);
        return Err(error);
    }

    transaction
        .commit()
        .map_err(|error| format!("Could not import the file: {error}"))?;

    Ok(id)
}

fn ensure_items_accessible(
    connection: &Connection,
    state: &DatabaseState,
    ids: &[String],
) -> Result<(), String> {
    ids.iter()
        .try_for_each(|id| ensure_item_accessible(connection, state, id))
}

fn load_item_with_state(state: &DatabaseState, id: &str) -> Result<Item, String> {
    let connection = state.require_connection()?;
    let connection = connection.as_ref().expect("checked above");
    let key = encryption::key_if_enabled(connection, state.content_key())?;
    ensure_item_accessible(connection, state, id)?;

    let item = read_item(connection, state.files_dir(), id)
        .map_err(|error| format!("Could not read the item: {error}"))?;

    let Some(mut item) = item else {
        return Err("Item was not found".to_string());
    };

    // A missing key already returned "Vault is locked"; with it present the
    // protected values are decrypted in memory and never exposed as ciphertext.
    if let Some(key) = key.as_ref() {
        let secret = encryption::read_secret(connection, key, id)
            .map_err(|error| format!("Could not read the item: {error}"))?;
        item.description = secret.description;
        item.content = secret.content;
        item.url = secret.url;
        if let Some(title) = secret.title {
            item.title = title;
        }
        if let Some(tags) = secret.tags {
            item.tags = tags;
        }
        if let (Some(name), Some(file)) = (secret.file_name, item.file.as_mut()) {
            file.original_name = name;
        }
    }

    Ok(item)
}

fn list_items_with_state(
    state: &DatabaseState,
    filter: Option<&ItemFilter>,
) -> Result<Vec<ItemSummary>, String> {
    let connection = state.require_connection()?;
    let connection = connection.as_ref().expect("checked above");
    let key = encryption::key_if_enabled(connection, state.content_key())?;

    if let Some(collection_id) = filter
        .and_then(|filter| filter.collection_id.as_deref())
        .filter(|value| !value.is_empty())
    {
        ensure_collection_accessible(connection, state, collection_id)?;
    }
    let locked = locked_collection_ids(connection, state)?;

    read_item_summaries(connection, state.files_dir(), filter, key.as_ref(), &locked)
        .map_err(|error| format!("Could not list the items: {error}"))
}

#[allow(dead_code)]
pub(crate) const DUPLICATE_SOURCE: &str = "A source with this address is already saved";
#[allow(dead_code)]
pub(crate) const DUPLICATE_FILE: &str = "A file with the same contents is already saved";

/// Summaries for the items a duplicate check matched, with names decrypted.
/// Only called with ids that passed the locked-collection filter.
fn duplicate_matches(
    connection: &Connection,
    files_dir: &Path,
    key: Option<&[u8; 32]>,
    ids: &[String],
    reason: &str,
) -> Result<Vec<DuplicateMatch>, String> {
    let sql = format!(
        "SELECT {ITEM_SUMMARY_COLUMNS} FROM items i LEFT JOIN files f ON f.item_id = i.id WHERE i.id = ?1"
    );
    ids.iter()
        .map(|id| {
            let mut item = connection
                .query_row(&sql, params![id], |row| map_summary_row(row, files_dir))
                .map_err(|error| format!("Could not read a matching item: {error}"))?;
            if let Some(key) = key {
                let secret = encryption::read_secret(connection, key, id)?;
                if let Some(title) = secret.title {
                    item.title = title;
                }
                if let (Some(name), Some(file)) = (secret.file_name, item.file.as_mut()) {
                    file.original_name = name;
                }
                item.content = secret.content;
            }
            Ok(DuplicateMatch {
                item,
                reason: reason.to_string(),
            })
        })
        .collect()
}

/// Runs `check` against the current locked collections and returns its matches
/// with the access epoch they belong to. If a collection locks or unlocks while
/// it runs, the check runs again, so no answer names an item that just became
/// hidden.
fn current_matches(
    state: &DatabaseState,
    mut check: impl FnMut(&[String]) -> Result<Vec<DuplicateMatch>, String>,
    connection: &Connection,
) -> Result<(Vec<DuplicateMatch>, u64), String> {
    for _ in 0..3 {
        let epoch = state.access_epoch();
        let locked = locked_collection_ids(connection, state)?;
        let matches = check(&locked)?;
        if state.access_epoch() == epoch {
            return Ok((matches, epoch));
        }
    }
    Err("Collections changed while checking for duplicates. Try again.".to_string())
}

fn capture_item_with_state(state: &DatabaseState, input: &ItemInput) -> Result<CaptureOutcome, String> {
    let keep_both = keeps_both(input.duplicate_policy.as_deref())?;
    let id = {
        let mut guard = state.require_connection()?;
        let connection = guard.as_mut().expect("checked above");
        let key = encryption::key_if_enabled(connection, state.content_key())?;
        if let Some(id) = input.id.as_deref() {
            ensure_item_accessible(connection, state, id)?;
        }
        let epoch = state.access_epoch();
        let locked = locked_collection_ids(connection, state)?;
        let scope = if keep_both { None } else { Some(locked.as_slice()) };
        match write_item(connection, input, key.as_ref(), scope)? {
            WriteOutcome::Saved(id) => id,
            WriteOutcome::Duplicate(ids) => {
                let files_dir = state.files_dir();
                let (matches, access_epoch) = if state.access_epoch() == epoch {
                    (duplicate_matches(connection, files_dir, key.as_ref(), &ids, "url")?, epoch)
                } else {
                    let canonical = input.url.as_deref().and_then(canonical_source_url).unwrap_or_default();
                    current_matches(
                        state,
                        |locked| {
                            let ids = duplicates::find_source_matches(
                                connection,
                                key.as_ref(),
                                locked,
                                &canonical,
                                input.id.as_deref(),
                            )?;
                            duplicate_matches(connection, files_dir, key.as_ref(), &ids, "url")
                        },
                        connection,
                    )?
                };
                return Ok(CaptureOutcome::Duplicate { matches, access_epoch });
            }
        }
    };

    Ok(CaptureOutcome::Saved {
        item: load_item_with_state(state, &id)?,
    })
}

// Kept for Rust callers and tests that expect a plain item.
#[allow(dead_code)]
fn save_item_with_state(state: &DatabaseState, input: &ItemInput) -> Result<Item, String> {
    match capture_item_with_state(state, input)? {
        CaptureOutcome::Saved { item } => Ok(item),
        CaptureOutcome::Duplicate { .. } => Err(DUPLICATE_SOURCE.to_string()),
    }
}

fn set_item_tags_with_state(
    state: &DatabaseState,
    id: &str,
    tags: &[String],
) -> Result<Vec<String>, String> {
    let mut connection = state.require_connection()?;
    let connection = connection.as_mut().expect("checked above");
    ensure_item_accessible(connection, state, id)?;
    let key = encryption::key_if_enabled(connection, state.content_key())?;

    replace_item_tags(connection, id, tags, key.as_ref())
}

fn list_collections_with_state(state: &DatabaseState) -> Result<Vec<Collection>, String> {
    let connection = state.require_connection()?;
    let connection = connection.as_ref().expect("checked above");
    let key = encryption::key_if_enabled(connection, state.content_key())?;

    read_collections(connection, key.as_ref())
        .map_err(|error| format!("Could not list the collections: {error}"))
}

fn list_index_state_with_state(state: &DatabaseState) -> Result<Vec<IndexState>, String> {
    let connection = state.require_connection()?;

    read_index_state(connection.as_ref().expect("checked above"))
        .map_err(|error| format!("Could not list the index state: {error}"))
}

fn list_item_versions_with_state(
    state: &DatabaseState,
    item_id: &str,
) -> Result<Vec<ItemVersion>, String> {
    let connection = state.require_connection()?;
    let connection = connection.as_ref().expect("checked above");
    let key = encryption::key_if_enabled(connection, state.content_key())?;
    let kind: Option<String> = connection
        .query_row(
            "SELECT kind FROM items WHERE id = ?1",
            params![item_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Could not list versions: {error}"))?;
    if kind.as_deref() != Some("note") {
        return Err("Item is not a note".into());
    }
    ensure_item_accessible(connection, state, item_id)?;
    read_versions(connection, item_id, key.as_ref())
        .map_err(|error| format!("Could not list versions: {error}"))
}

fn restore_item_version_with_state(
    state: &DatabaseState,
    version_id: &str,
) -> Result<Item, String> {
    let id = {
        let mut guard = state.require_connection()?;
        let connection = guard.as_mut().expect("checked above");
        let key = encryption::key_if_enabled(connection, state.content_key())?;
        let tx = connection
            .transaction()
            .map_err(|error| format!("Could not restore version: {error}"))?;
        let version: Option<(String, String, String, Option<Vec<u8>>, Option<Vec<u8>>)> = tx.query_row(
            "SELECT v.item_id, v.title, v.content, v.encrypted_content, v.title_secret FROM item_versions v JOIN items i ON i.id = v.item_id WHERE v.id = ?1 AND i.kind = 'note' AND i.deleted_at IS NULL",
            params![version_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        ).optional().map_err(|error| format!("Could not restore version: {error}"))?;
        let (id, title, stored_content, encrypted, sealed_title) =
            version.ok_or_else(|| "Version was not found".to_string())?;
        ensure_item_accessible(&tx, state, &id)?;
        let title = match (&key, sealed_title) {
            (Some(key), Some(bytes)) => encryption::open_version_title(key, version_id, &bytes)
                .map_err(|error| format!("Could not restore version: {error}"))?,
            _ => title,
        };
        let content = match (&key, encrypted) {
            (Some(key), Some(bytes)) => encryption::decrypt_version(key, version_id, &bytes)
                .map_err(|error| format!("Could not restore version: {error}"))?,
            _ => stored_content,
        };
        let current_title: String = tx
            .query_row(
                "SELECT title FROM items WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .map_err(|error| format!("Could not restore version: {error}"))?;
        let current_secret = match &key {
            Some(key) => Some(
                encryption::read_secret(&tx, key, &id)
                    .map_err(|error| format!("Could not restore version: {error}"))?,
            ),
            None => None,
        };
        let current_title = current_secret
            .as_ref()
            .and_then(|secret| secret.title.clone())
            .unwrap_or(current_title);
        let current_content = match &current_secret {
            Some(secret) => secret.content.clone().unwrap_or_default(),
            None => tx
                .query_row(
                    "SELECT COALESCE(content, '') FROM items WHERE id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .map_err(|error| format!("Could not restore version: {error}"))?,
        };
        insert_version(&tx, &id, &current_title, &current_content, key.as_ref())
            .map_err(|error| format!("Could not restore version: {error}"))?;
        match &key {
            Some(key) => {
                let mut secret = encryption::read_secret(&tx, key, &id)
                    .map_err(|error| format!("Could not restore version: {error}"))?;
                secret.content = Some(content.clone());
                secret.title = Some(title.clone());
                encryption::write_secret(&tx, key, &id, &secret)
                    .map_err(|error| format!("Could not restore version: {error}"))?;
                tx.execute("UPDATE items SET title = '', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1", params![id]).map_err(|error| format!("Could not restore version: {error}"))?;
            }
            None => {
                tx.execute("UPDATE items SET title = ?2, content = ?3, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1", params![id, title, content]).map_err(|error| format!("Could not restore version: {error}"))?;
            }
        }
        if key.is_some() {
            tx.execute("DELETE FROM item_search WHERE item_id = ?1", params![id])
                .map_err(|error| format!("Could not restore version: {error}"))?;
            upsert_index_state(&tx, &id)
                .map_err(|error| format!("Could not restore version: {error}"))?;
        } else {
            tx.execute("DELETE FROM item_search WHERE item_id = ?1", params![id])
                .map_err(|error| format!("Could not restore version: {error}"))?;
            tx.execute(
                "INSERT INTO item_search(item_id, kind, title, body) VALUES (?1, 'note', ?2, ?3)",
                params![id, title, plain_text(&content)],
            )
            .map_err(|error| format!("Could not restore version: {error}"))?;
        }
        tx.commit()
            .map_err(|error| format!("Could not restore version: {error}"))?;
        id
    };
    load_item_with_state(state, &id)
}

fn read_item_file_with_state(state: &DatabaseState, id: &str) -> Result<ItemFilePreview, String> {
    let (path, original_name, byte_size, imported_at, encrypted, key) = {
        let connection = state.require_connection()?;
        let connection = connection.as_ref().expect("checked above");
        let key = encryption::key_if_enabled(connection, state.content_key())?;
        ensure_item_accessible(connection, state, id)?;
        let row: Option<(String, String, i64, String, i64)> = connection.query_row(
            "SELECT f.stored_name, f.original_name, f.byte_size, f.imported_at, f.encrypted FROM files f JOIN items i ON i.id = f.item_id WHERE i.id = ?1 AND i.kind = 'file' AND i.deleted_at IS NULL",
            params![id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        ).optional().map_err(|error| format!("Could not read the file: {error}"))?;
        let (stored, name, size, imported, encrypted) =
            row.ok_or_else(|| "File was not found".to_string())?;
        // A sealed name keeps its extension in the column, so the preview type
        // is the same; the real name comes from the secret.
        let name = match key.as_ref() {
            Some(key) => encryption::read_secret(connection, key, id)?
                .file_name
                .unwrap_or(name),
            None => name,
        };
        (
            state.files_dir().join(stored),
            name,
            size,
            imported,
            encrypted != 0,
            key,
        )
    };
    let actual_size = fs::metadata(&path)
        .map_err(|_| "The file is missing".to_string())?
        .len();
    let ext = Path::new(&original_name)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let (preview, mime) = match ext.as_str() {
        "txt" | "md" | "markdown" => ("text", Some("text/plain")),
        "png" => ("image", Some("image/png")),
        "jpg" | "jpeg" => ("image", Some("image/jpeg")),
        "gif" => ("image", Some("image/gif")),
        "webp" => ("image", Some("image/webp")),
        "pdf" => ("pdf", Some("application/pdf")),
        _ => ("unsupported", None),
    };
    // The stored size of an encrypted file is ciphertext; the plaintext size in
    // `byte_size` drives the 25 MB image and PDF rule.
    let too_large = (preview == "image" || preview == "pdf") && byte_size > 25 * 1024 * 1024;
    let preview = if too_large { "unsupported" } else { preview };
    let mut text = None;
    let mut payload_base64 = None;
    let mut truncated = false;
    if preview == "text" {
        if encrypted {
            let key = key.as_ref().ok_or_else(|| "Vault is locked".to_string())?;
            let stored =
                fs::read(&path).map_err(|error| format!("Could not read the file: {error}"))?;
            let mut bytes = encryption::decrypt_file(key, id, &stored)
                .map_err(|error| format!("Could not read the file: {error}"))?;
            truncated = bytes.len() > 1024 * 1024;
            bytes.truncate(1024 * 1024);
            text = Some(String::from_utf8_lossy(&bytes).into_owned());
        } else {
            use std::io::Read;
            let mut bytes = Vec::new();
            fs::File::open(&path)
                .and_then(|file| file.take(1024 * 1024 + 1).read_to_end(&mut bytes))
                .map_err(|error| format!("Could not read the file: {error}"))?;
            truncated = bytes.len() > 1024 * 1024;
            bytes.truncate(1024 * 1024);
            text = Some(String::from_utf8_lossy(&bytes).into_owned());
        }
    } else if preview == "image" || preview == "pdf" {
        let bytes = if encrypted {
            let key = key.as_ref().ok_or_else(|| "Vault is locked".to_string())?;
            let stored =
                fs::read(&path).map_err(|error| format!("Could not read the file: {error}"))?;
            encryption::decrypt_file(key, id, &stored)
                .map_err(|error| format!("Could not read the file: {error}"))?
        } else {
            fs::read(&path).map_err(|error| format!("Could not read the file: {error}"))?
        };
        payload_base64 = Some(base64::engine::general_purpose::STANDARD.encode(bytes));
    }
    Ok(ItemFilePreview {
        preview: preview.into(),
        mime: mime.map(str::to_string),
        text,
        payload_base64,
        byte_size: if encrypted {
            byte_size
        } else if actual_size <= i64::MAX as u64 {
            actual_size as i64
        } else {
            byte_size
        },
        original_name,
        imported_at,
        truncated,
    })
}

// A decrypted file opened by another application lives outside the vault. The
// item id keeps the name unique and the original name keeps it readable.
fn temp_file_name(id: &str, original_name: &str) -> String {
    let base = Path::new(original_name)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("file");
    let cleaned: String = base
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_' | ' ') {
                character
            } else {
                '_'
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches(|character| character == '.' || character == ' ');
    if cleaned.is_empty() {
        format!("{id}-file")
    } else {
        format!("{id}-{cleaned}")
    }
}

fn load_storage_report_with_state(state: &DatabaseState) -> Result<StorageReport, String> {
    let connection = state.require_connection()?;
    let connection = connection.as_ref().expect("checked above");
    let page_count: i64 = connection
        .query_row("PRAGMA page_count", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    let page_size: i64 = connection
        .query_row("PRAGMA page_size", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    let locked = locked_collection_ids(connection, state)?;
    let key = encryption::key_if_enabled(connection, state.content_key())?;
    let mut statement = connection.prepare("SELECT f.item_id, i.title, f.original_name, f.byte_size, f.imported_at, i.collection_id FROM files f JOIN items i ON i.id=f.item_id ORDER BY f.byte_size DESC, f.item_id ASC").map_err(|error| error.to_string())?;
    let rows: Vec<(StorageFile, Option<String>)> = statement
        .query_map([], |row| {
            Ok((
                StorageFile {
                    item_id: row.get(0)?,
                    title: row.get(1)?,
                    original_name: row.get(2)?,
                    byte_size: row.get(3)?,
                    imported_at: row.get(4)?,
                },
                row.get(5)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|error| error.to_string())?;
    // Sizes still count toward the totals; names of locked files stay out of
    // the largest-files list.
    let mut largest = Vec::new();
    let mut files = Vec::new();
    for (file, collection_id) in rows {
        let hidden = collection_id.is_some_and(|id| locked.contains(&id));
        if !hidden && largest.len() < 10 {
            let mut shown = file.clone();
            if let Some(key) = key.as_ref() {
                let secret = encryption::read_secret(connection, key, &shown.item_id)?;
                shown.title = secret.title.unwrap_or(shown.title);
                shown.original_name = secret.file_name.unwrap_or(shown.original_name);
            }
            largest.push(shown);
        }
        files.push(file);
    }
    let mut groups: Vec<StorageGroup> = ["Images", "PDFs", "Text", "Other"]
        .iter()
        .map(|label| StorageGroup {
            label: (*label).into(),
            count: 0,
            bytes: 0,
        })
        .collect();
    for file in &files {
        let ext = Path::new(&file.original_name)
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let index = match ext.as_str() {
            "png" | "jpg" | "jpeg" | "gif" | "webp" => 0,
            "pdf" => 1,
            "txt" | "md" | "markdown" => 2,
            _ => 3,
        };
        groups[index].count += 1;
        groups[index].bytes += file.byte_size;
    }
    let file_bytes = files.iter().map(|file| file.byte_size).sum();
    let database_bytes = page_count * page_size;
    Ok(StorageReport {
        total_bytes: database_bytes + file_bytes,
        database_bytes,
        file_bytes,
        file_count: files.len() as i64,
        groups,
        largest,
    })
}

fn set_item_pinned_with_state(
    state: &DatabaseState,
    id: &str,
    pinned: bool,
) -> Result<Item, String> {
    {
        let mut connection = state.require_connection()?;
        let connection = connection.as_mut().expect("checked above");
        ensure_item_accessible(connection, state, id)?;
        write_item_pin(connection, id, pinned)?;
    }

    load_item_with_state(state, id)
}

fn set_items_favorite_with_state(
    state: &DatabaseState,
    ids: &[String],
    favorite: bool,
) -> Result<(), String> {
    let mut connection = state.require_connection()?;
    let connection = connection.as_mut().expect("checked above");
    ensure_items_accessible(connection, state, ids)?;

    write_items_favorite(connection, ids, favorite)
}

// Moving into a locked collection reads nothing, so only the items' current
// collections must be open.
fn move_items_to_collection_with_state(
    state: &DatabaseState,
    ids: &[String],
    collection_id: Option<&str>,
) -> Result<(), String> {
    let mut connection = state.require_connection()?;
    let connection = connection.as_mut().expect("checked above");
    ensure_items_accessible(connection, state, ids)?;

    write_items_collection(connection, ids, collection_id)
}

fn trash_items_with_state(state: &DatabaseState, ids: &[String]) -> Result<(), String> {
    let mut connection = state.require_connection()?;
    let connection = connection.as_mut().expect("checked above");
    ensure_items_accessible(connection, state, ids)?;

    write_trashed_items(connection, ids)
}

fn restore_items_with_state(state: &DatabaseState, ids: &[String]) -> Result<(), String> {
    let mut connection = state.require_connection()?;
    let connection = connection.as_mut().expect("checked above");
    ensure_items_accessible(connection, state, ids)?;

    write_restored_items(connection, ids)
}

fn delete_items_permanently_with_state(
    state: &DatabaseState,
    ids: &[String],
) -> Result<(), String> {
    let mut connection = state.require_connection()?;
    let connection = connection.as_mut().expect("checked above");
    ensure_items_accessible(connection, state, ids)?;

    remove_items_permanently(connection, state.files_dir(), ids)
}

fn load_vault_summary_with_state(state: &DatabaseState) -> Result<VaultSummary, String> {
    let connection = state.require_connection()?;
    let connection = connection.as_ref().expect("checked above");

    let (
        item_count,
        note_count,
        source_count,
        file_count,
        favorite_count,
        collection_count,
        tag_count,
        trash_count,
        file_bytes,
    ): (i64, i64, i64, i64, i64, i64, i64, i64, i64) = connection
        .query_row(
            "SELECT
               (SELECT COUNT(*) FROM items WHERE deleted_at IS NULL),
               (SELECT COUNT(*) FROM items WHERE kind = 'note' AND deleted_at IS NULL),
               (SELECT COUNT(*) FROM items WHERE kind = 'source' AND deleted_at IS NULL),
               (SELECT COUNT(*) FROM items WHERE kind = 'file' AND deleted_at IS NULL),
               (SELECT COUNT(*) FROM items WHERE is_favorite = 1 AND deleted_at IS NULL),
               (SELECT COUNT(*) FROM collections),
               (SELECT COUNT(DISTINCT lower(value)) FROM items i, json_each(i.tags)
                WHERE i.deleted_at IS NULL),
               (SELECT COUNT(*) FROM items WHERE deleted_at IS NOT NULL),
               (SELECT COALESCE(SUM(byte_size), 0) FROM files)",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                ))
            },
        )
        .map_err(|error| format!("Could not read the vault summary: {error}"))?;
    // Sealed tags are counted from the secrets when the vault is open.
    let tag_count = match encryption::key_if_enabled(connection, state.content_key()).unwrap_or(None) {
        Some(key) => read_tags(connection, Some(&key))
            .map_err(|error| format!("Could not read the vault summary: {error}"))?
            .len() as i64,
        None => tag_count,
    };

    let page_count: i64 = connection
        .query_row("PRAGMA page_count", [], |row| row.get(0))
        .map_err(|error| format!("Could not read the vault summary: {error}"))?;
    let page_size: i64 = connection
        .query_row("PRAGMA page_size", [], |row| row.get(0))
        .map_err(|error| format!("Could not read the vault summary: {error}"))?;

    Ok(VaultSummary {
        item_count,
        note_count,
        source_count,
        file_count,
        favorite_count,
        collection_count,
        tag_count,
        trash_count,
        file_bytes,
        database_bytes: page_count * page_size,
    })
}

fn save_collection_with_state(
    state: &DatabaseState,
    input: &CollectionInput,
) -> Result<Collection, String> {
    let id = {
        let mut connection = state.require_connection()?;
        let connection = connection.as_mut().expect("checked above");
        // Renaming or changing the lock of a protected collection needs it open.
        if let Some(id) = input.id.as_deref() {
            // The right present secret proves access on its own, so a locked
            // collection can have its lock removed without unlocking it first.
            if !check_current_secret(connection, state, id, input)? {
                ensure_collection_accessible(connection, state, id)?;
            }
        }
        let key = encryption::key_if_enabled(connection, state.content_key())?;
        if let Some(key) = key.as_ref() {
            // Sealed names cannot be compared in SQL, so duplicates are
            // checked here on the decrypted names.
            let name = input.name.trim().to_lowercase();
            let taken = read_collections(connection, Some(key))?
                .into_iter()
                .any(|collection| {
                    Some(collection.id.as_str()) != input.id.as_deref()
                        && collection.name.trim().to_lowercase() == name
                });
            if taken && !name.is_empty() {
                return Err("A collection with that name already exists".to_string());
            }
        }
        let id = write_collection(connection, input)?;
        if let Some(key) = key.as_ref() {
            connection
                .execute(
                    "UPDATE collections SET name_secret = NULL WHERE id = ?1",
                    params![id],
                )
                .map_err(|error| format!("Could not save the collection: {error}"))?;
            encryption::seal_all(connection, key)?;
        }
        // Whoever just set a new secret knows it, so the collection stays open
        // for them until the app locks.
        if input.secret.is_some() {
            state.unlock_collection(&id);
        }
        id
    };

    let connection = state.require_connection()?;
    let connection = connection.as_ref().expect("checked above");
    let key = encryption::key_if_enabled(connection, state.content_key())?;
    let collection = read_collection(connection, &id, key.as_ref())
        .map_err(|error| format!("Could not read the collection: {error}"))?;

    collection.ok_or_else(|| "Collection was not found".to_string())
}

pub(crate) const CURRENT_SECRET_WRONG: &str = "The current password or PIN is not correct";

/// Removing or changing a collection's lock asks for its present secret, so
/// someone at an unlocked app cannot quietly strip the protection. A rename
/// alone (no protection in the input) does not ask. Returns true when the
/// secret was checked and matched.
fn check_current_secret(
    connection: &Connection,
    state: &DatabaseState,
    id: &str,
    input: &CollectionInput,
) -> Result<bool, String> {
    if input.protection.is_none() {
        return Ok(false);
    }
    let hash: Option<Option<String>> = connection
        .query_row(
            "SELECT secret_hash FROM collections WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Could not read the collection: {error}"))?;
    let Some(Some(hash)) = hash else {
        return Ok(false);
    };
    state.check_attempt()?;
    let matched = input
        .current_secret
        .as_deref()
        .is_some_and(|secret| secret_matches(secret.trim(), &hash));
    state.record_attempt(matched);
    if matched {
        Ok(true)
    } else {
        Err(CURRENT_SECRET_WRONG.to_string())
    }
}

fn delete_collection_with_state(state: &DatabaseState, id: &str) -> Result<(), String> {
    let mut connection = state.require_connection()?;
    let connection = connection.as_mut().expect("checked above");
    // Deleting would leave the items loose, so it needs the collection open.
    ensure_collection_accessible(connection, state, id)?;

    remove_collection(connection, id)
}

fn verify_collection_secret_with_state(
    state: &DatabaseState,
    id: &str,
    secret: &str,
) -> Result<bool, String> {
    let connection = state.require_connection()?;

    // A missing collection and a collection without a hash both answer false, so
    // the caller cannot tell a locked collection from a deleted one.
    let stored: Option<Option<String>> = connection
        .as_ref()
        .expect("checked above")
        .query_row(
            "SELECT secret_hash FROM collections WHERE id = ?1",
            params![id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| format!("Could not read the collection: {error}"))?;

    let matched = matches!(stored, Some(Some(hash)) if secret_matches(secret.trim(), &hash));
    if matched {
        state.unlock_collection(id);
    }

    Ok(matched)
}

fn list_tags_with_state(state: &DatabaseState) -> Result<Vec<Tag>, String> {
    let connection = state.require_connection()?;
    let connection = connection.as_ref().expect("checked above");
    let key = encryption::key_if_enabled(connection, state.content_key())?;

    read_tags(connection, key.as_ref())
        .map_err(|error| format!("Could not list the tags: {error}"))
}

// Resolves the managed file for a file item, rejecting a missing item, a
// non-file item, and a file that is no longer on disk.
// The item kind, managed name, encryption flag, and original name for a file.
type ManagedFileRow = (String, Option<String>, Option<i64>, Option<String>);

fn managed_file_path_with_state(state: &DatabaseState, id: &str) -> Result<PathBuf, String> {
    let (kind, stored_name, encrypted, original_name, key) = {
        let connection = state.require_connection()?;
        let connection = connection.as_ref().expect("checked above");
        let key = encryption::key_if_enabled(connection, state.content_key())?;
        ensure_item_accessible(connection, state, id)?;
        let row: Option<ManagedFileRow> = connection
            .query_row(
                "SELECT i.kind, f.stored_name, f.encrypted, f.original_name
                 FROM items i
                 LEFT JOIN files f ON f.item_id = i.id
                 WHERE i.id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(|error| format!("Could not read the item: {error}"))?;

        let (kind, stored_name, encrypted, original_name) =
            row.ok_or_else(|| "Item was not found".to_string())?;
        (kind, stored_name, encrypted, original_name, key)
    };

    if kind != "file" {
        return Err("This item is not a file".to_string());
    }

    let stored_name = stored_name.ok_or_else(|| "The file is missing".to_string())?;
    let path = state.files_dir().join(stored_name);

    if !path.is_file() {
        return Err("The file is missing".to_string());
    }

    // An encrypted file is opened through a decrypted temporary copy. The copy
    // sits outside the vault and the UI names that boundary.
    if encrypted == Some(1) {
        let key = key.as_ref().ok_or_else(|| "Vault is locked".to_string())?;
        let stored =
            fs::read(&path).map_err(|error| format!("Could not read the file: {error}"))?;
        let bytes = encryption::decrypt_file(key, id, &stored)
            .map_err(|error| format!("Could not read the file: {error}"))?;
        return write_temp_file(id, original_name.as_deref(), &bytes);
    }

    Ok(path)
}

/// Only web addresses are handed to the OS. Other schemes such as `file:` or
/// `ms-msdt:` can start programs.
fn is_web_url(url: &str) -> bool {
    let url = url.trim().to_ascii_lowercase();
    url.starts_with("https://") || url.starts_with("http://")
}

/// Largest file that can be imported while encryption is on.
const MAX_ENCRYPTED_IMPORT_BYTES: u64 = 1024 * 1024 * 1024;

/// File types Windows runs as programs or scripts when opened.
const RUNNABLE_EXTENSIONS: &[&str] = &[
    "exe", "com", "bat", "cmd", "msi", "msp", "msix", "appx", "appinstaller", "hta", "lnk",
    "url", "scr", "pif", "cpl", "js", "jse", "vbs", "vbe", "wsf", "wsh", "ps1", "psm1", "reg",
    "jar", "application", "gadget", "inf", "settingcontent-ms", "library-ms", "search-ms",
];

fn is_runnable(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            RUNNABLE_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
        })
}

fn write_temp_file(id: &str, original_name: Option<&str>, bytes: &[u8]) -> Result<PathBuf, String> {
    let dir = encryption::temp_dir();
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Could not prepare a temporary copy: {error}"))?;
    let path = dir.join(temp_file_name(id, original_name.unwrap_or("file")));
    fs::write(&path, bytes)
        .map_err(|error| format!("Could not prepare a temporary copy: {error}"))?;
    Ok(path)
}

fn source_url_with_state(state: &DatabaseState, id: &str) -> Result<String, String> {
    let connection = state.require_connection()?;
    let connection = connection.as_ref().expect("checked above");
    let key = encryption::key_if_enabled(connection, state.content_key())?;
    ensure_item_accessible(connection, state, id)?;

    let row: Option<(String, Option<String>)> = connection
        .query_row(
            "SELECT kind, url FROM items WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| format!("Could not read the item: {error}"))?;

    let (kind, stored_url) = row.ok_or_else(|| "Item was not found".to_string())?;

    if kind != "source" {
        return Err("This item is not a source".to_string());
    }

    let url = match key {
        Some(key) => {
            encryption::read_secret(connection, &key, id)
                .map_err(|error| format!("Could not read the item: {error}"))?
                .url
        }
        None => stored_url,
    };
    let url = url.unwrap_or_default();
    let url = url.trim();

    if url.is_empty() {
        return Err("This source has no web address".to_string());
    }

    if !is_web_url(url) {
        return Err("Only http and https addresses can be opened".to_string());
    }

    Ok(url.to_string())
}

/// How long a staged file waits for a decision.
const PENDING_IMPORT_TTL: std::time::Duration = std::time::Duration::from_secs(5 * 60);
const PENDING_GONE: &str = "This file is no longer ready to import. Pick it again.";

fn pending_aad(token: &str) -> Vec<u8> {
    format!("kivo:pending-import:v1:{token}").into_bytes()
}

fn random_token() -> Result<String, String> {
    let bytes = encryption::new_vault_key()?;
    Ok(bytes[..16].iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Copies the picked file into app-private staging and fingerprints the copy,
/// so later changes to the original cannot change what gets saved. Encrypted
/// vaults stage a sealed copy only. Runs without the database lock.
fn stage_file(
    state: &DatabaseState,
    source: &Path,
    token: &str,
    key: Option<&[u8; 32]>,
) -> Result<(PathBuf, i64, [u8; 32]), String> {
    let dir = state.staging_dir();
    fs::create_dir_all(&dir).map_err(|error| format!("Could not prepare the file: {error}"))?;
    let staged = dir.join(token);
    let result = (|| match key {
        Some(key) => {
            // Encryption reads the whole file into memory, so it has a ceiling.
            // ponytail: whole-file read; stream in chunks if larger files matter.
            let size = fs::metadata(source)
                .map_err(|error| format!("Could not read the source file: {error}"))?
                .len();
            if size > MAX_ENCRYPTED_IMPORT_BYTES {
                return Err("This file is too large to import while encryption is on".to_string());
            }
            let bytes =
                fs::read(source).map_err(|error| format!("Could not read the source file: {error}"))?;
            let digest = duplicates::hash_bytes(&bytes);
            let sealed = encryption::encrypt_bytes(key, &bytes, &pending_aad(token))?;
            fs::write(&staged, sealed).map_err(|error| format!("Could not prepare the file: {error}"))?;
            Ok((bytes.len() as u64, digest))
        }
        None => {
            let input = fs::File::open(source)
                .map_err(|error| format!("Could not read the source file: {error}"))?;
            let output = fs::File::create(&staged)
                .map_err(|error| format!("Could not prepare the file: {error}"))?;
            let (digest, size) = duplicates::hash_reader(TeeReader { input, output })
                .map_err(|error| format!("Could not prepare the file: {error}"))?;
            Ok((size, digest))
        }
    })();
    match result {
        Ok((size, digest)) => {
            let size = i64::try_from(size).map_err(|_| "Source file is too large".to_string())?;
            Ok((staged, size, digest))
        }
        Err(error) => {
            let _ = fs::remove_file(&staged);
            Err(error)
        }
    }
}

/// Writes everything it reads to `output`, so one pass both copies and hashes.
struct TeeReader {
    input: fs::File,
    output: fs::File,
}

impl std::io::Read for TeeReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let read = self.input.read(buffer)?;
        std::io::Write::write_all(&mut self.output, &buffer[..read])?;
        Ok(read)
    }
}

fn file_matches(
    state: &DatabaseState,
    connection: &Connection,
    key: Option<&[u8; 32]>,
    digest: &[u8; 32],
    byte_size: i64,
) -> Result<(Vec<DuplicateMatch>, u64), String> {
    current_matches(
        state,
        |locked| {
            let ids = duplicates::find_file_matches(
                connection,
                state.files_dir(),
                key,
                locked,
                digest,
                byte_size,
            )?;
            duplicate_matches(connection, state.files_dir(), key, &ids, "file-content")
        },
        connection,
    )
}

fn preview_file_import_with_state(
    state: &DatabaseState,
    source_path: &str,
) -> Result<FileImportPreview, String> {
    let source_path = source_path.trim();

    if source_path.is_empty() {
        return Err("Source file is required".to_string());
    }

    let source = Path::new(source_path);

    if !source.exists() {
        return Err("Source file was not found".to_string());
    }

    if !source.is_file() {
        return Err("Source must be a file".to_string());
    }

    let original_name = source
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| "Source file is required".to_string())?;

    let (key, generation) = {
        let guard = state.require_connection()?;
        let connection = guard.as_ref().expect("checked above");
        (
            encryption::key_if_enabled(connection, state.content_key())?,
            state.session_generation(),
        )
    };
    let token = random_token()?;
    let (staged, byte_size, digest) = stage_file(state, source, &token, key.as_ref())?;
    let pending = PendingImport {
        token: token.clone(),
        generation,
        created: std::time::Instant::now(),
        staged,
        encrypted: key.is_some(),
        original_name: original_name.clone(),
        byte_size,
        digest,
    };

    let guard = state.require_connection()?;
    let connection = guard.as_ref().expect("checked above");
    // Staging ran without the lock; a lock, restore, or encryption change in
    // the meantime makes this copy stale (dropping `pending` deletes it).
    if state.session_generation() != generation {
        return Err(PENDING_GONE.to_string());
    }
    let (matches, access_epoch) = file_matches(state, connection, key.as_ref(), &digest, byte_size)?;
    // One staged file at a time; a new preview replaces (and deletes) the old one.
    *state.pending_import()? = Some(pending);

    Ok(FileImportPreview {
        token,
        original_name,
        byte_size,
        matches,
        access_epoch,
    })
}

fn commit_file_import_with_state(
    state: &DatabaseState,
    token: &str,
    collection_id: Option<&str>,
    duplicate_policy: Option<&str>,
) -> Result<CaptureOutcome, String> {
    let keep_both = keeps_both(duplicate_policy)?;
    let id = {
        let mut guard = state.require_connection()?;
        let connection = guard.as_mut().expect("checked above");
        let key = encryption::key_if_enabled(connection, state.content_key())?;
        let mut slot = state.pending_import()?;
        let fresh = slot.as_ref().is_some_and(|pending| {
            pending.token == token
                && pending.generation == state.session_generation()
                && pending.created.elapsed() < PENDING_IMPORT_TTL
                && pending.encrypted == key.is_some()
        });
        if !fresh {
            if slot.as_ref().is_some_and(|pending| pending.token == token) {
                slot.take();
            }
            return Err(PENDING_GONE.to_string());
        }

        let collection_id = collection_id.filter(|value| !value.is_empty());
        if let Some(collection_id) = collection_id {
            let exists: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM collections WHERE id = ?1",
                    params![collection_id],
                    |row| row.get(0),
                )
                .map_err(|error| format!("Could not import the file: {error}"))?;
            if exists == 0 {
                return Err("Collection does not exist".to_string());
            }
            ensure_collection_accessible(connection, state, collection_id)?;
        }

        let (digest, byte_size) = {
            let pending = slot.as_ref().expect("checked above");
            (pending.digest, pending.byte_size)
        };
        if !keep_both {
            let (matches, access_epoch) =
                file_matches(state, connection, key.as_ref(), &digest, byte_size)?;
            if !matches.is_empty() {
                // The staged copy stays for the user's decision.
                return Ok(CaptureOutcome::Duplicate { matches, access_epoch });
            }
        }

        // Owning the pending import means it is deleted however this ends.
        let pending = slot.take().expect("checked above");
        fs::create_dir_all(state.files_dir())
            .map_err(|error| format!("Could not create the managed folder: {error}"))?;
        let bytes = match key.as_ref() {
            Some(key) => {
                let sealed = fs::read(&pending.staged).map_err(|_| PENDING_GONE.to_string())?;
                ManagedBytes::Plain(encryption::decrypt_bytes(key, &sealed, &pending_aad(token))?)
            }
            None => ManagedBytes::Staged(&pending.staged),
        };
        write_import(
            connection,
            state.files_dir(),
            bytes,
            &pending.original_name,
            pending.byte_size,
            &pending.digest,
            collection_id,
            key.as_ref(),
        )?
    };

    Ok(CaptureOutcome::Saved {
        item: load_item_with_state(state, &id)?,
    })
}

fn cancel_file_import_with_state(state: &DatabaseState, token: &str) -> Result<(), String> {
    let mut slot = state.pending_import()?;
    if slot.as_ref().is_some_and(|pending| pending.token == token) {
        slot.take();
    }
    Ok(())
}

/// The old one-step import, now the same checked flow: it refuses a file whose
/// contents are already saved instead of bypassing the duplicate check.
fn import_file_outcome(state: &DatabaseState, source_path: &str) -> Result<CaptureOutcome, String> {
    let preview = preview_file_import_with_state(state, source_path)?;
    commit_file_import_with_state(state, &preview.token, None, None)
}

// Kept for Rust callers and tests that expect a plain item.
#[allow(dead_code)]
fn import_file_with_state(state: &DatabaseState, source_path: &str) -> Result<Item, String> {
    match import_file_outcome(state, source_path)? {
        CaptureOutcome::Saved { item } => Ok(item),
        CaptureOutcome::Duplicate { .. } => {
            if let Ok(mut slot) = state.pending_import() {
                slot.take();
            }
            Err(DUPLICATE_FILE.to_string())
        }
    }
}

fn index_file_with_state(state: &DatabaseState, id: &str) -> Result<IndexState, String> {
    {
        // Extraction writes plaintext into item_search, which must stay empty
        // while encryption is on. Reject before touching any state.
        let connection = state.require_connection()?;
        if encryption::is_enabled(connection.as_ref().expect("checked above"))? {
            return Err("Encryption is on; PDF text indexing is unavailable".to_string());
        }
    }

    let path = {
        let connection = state.require_connection()?;
        let connection = connection.as_ref().expect("checked above");
        let stored: Option<String> = connection.query_row(
            "SELECT f.stored_name FROM files f JOIN items i ON i.id = f.item_id WHERE i.id = ?1 AND i.deleted_at IS NULL AND lower(f.original_name) LIKE '%.pdf'",
            params![id], |row| row.get(0),
        ).optional().map_err(|error| format!("Could not index PDF: {error}"))?;
        let stored = stored.ok_or_else(|| "Item is not a live PDF".to_string())?;
        connection.execute("UPDATE index_state SET needs_index=1, indexed_at=NULL, status='pending', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE item_id=?1", params![id]).map_err(|error| format!("Could not index PDF: {error}"))?;
        state.files_dir().join(stored)
    };

    // Extraction may take seconds; no database mutex is held while reading PDF bytes.
    let extracted = pdf_extract::extract_text(&path);
    let mut connection = state.require_connection()?;
    let connection = connection.as_mut().expect("checked above");
    let tx = connection
        .transaction()
        .map_err(|error| format!("Could not index PDF: {error}"))?;
    let live: Option<String> = tx.query_row(
        "SELECT f.stored_name FROM files f JOIN items i ON i.id=f.item_id WHERE i.id=?1 AND i.deleted_at IS NULL",
        params![id], |row| row.get(0),
    ).optional().map_err(|error| format!("Could not index PDF: {error}"))?;
    if live.as_deref().map(|name| state.files_dir().join(name)) != Some(path) {
        return Err("PDF was removed before indexing finished".into());
    }
    tx.execute("DELETE FROM item_search WHERE item_id=?1", params![id])
        .map_err(|error| format!("Could not index PDF: {error}"))?;
    let status = match &extracted {
        Ok(text) if !text.trim().is_empty() => "indexed",
        Ok(_) => "no_text",
        Err(_) => "failed",
    };
    if let Ok(text) = &extracted {
        if status == "indexed" {
            tx.execute("INSERT INTO item_search(item_id, kind, title, body) SELECT i.id, i.kind, i.title, ?2 FROM items i WHERE i.id=?1", params![id, text]).map_err(|error| format!("Could not index PDF: {error}"))?;
        }
    }
    tx.execute("UPDATE index_state SET status=?2, needs_index=?3, indexed_at=CASE WHEN ?2='indexed' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE item_id=?1", params![id, status, i64::from(status == "failed")]).map_err(|error| format!("Could not index PDF: {error}"))?;
    tx.commit()
        .map_err(|error| format!("Could not index PDF: {error}"))?;
    let state_row = read_index_state(connection)
        .map_err(|error| format!("Could not index PDF: {error}"))?
        .into_iter()
        .find(|row| row.item_id == id)
        .ok_or_else(|| "Index state was not found".to_string())?;
    extracted
        .map_err(|error| format!("Could not extract PDF text: {error}"))
        .map(|_| state_row)
}

/// Starts PDF text extraction for a newly saved file, off the calling thread.
fn index_new_pdf(app: &AppHandle, outcome: &CaptureOutcome) {
    let CaptureOutcome::Saved { item } = outcome else {
        return;
    };
    if item
        .file
        .as_ref()
        .is_some_and(|file| file.original_name.to_ascii_lowercase().ends_with(".pdf"))
    {
        let app = app.clone();
        let id = item.id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let result = index_file_with_state(app.state::<DatabaseState>().inner(), &id);
            let _ = app.emit("file-index-complete", serde_json::json!({"itemId": id, "status": result.as_ref().map(|row| row.status.as_str()).unwrap_or("failed")}));
        });
    }
}

fn run_blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> impl std::future::Future<Output = Result<T, String>> {
    async move {
        tauri::async_runtime::spawn_blocking(job)
            .await
            .map_err(|_| "Could not import the file".to_string())?
    }
}

#[tauri::command]
pub async fn import_file(source_path: String, app: AppHandle) -> Result<CaptureOutcome, String> {
    let worker = app.clone();
    let outcome = run_blocking(move || {
        let state = worker.state::<DatabaseState>();
        let outcome = import_file_outcome(state.inner(), &source_path);
        if matches!(outcome, Ok(CaptureOutcome::Duplicate { .. })) {
            if let Ok(mut slot) = state.pending_import() {
                slot.take();
            }
        }
        outcome
    })
    .await?;
    index_new_pdf(&app, &outcome);
    Ok(outcome)
}

#[tauri::command]
pub async fn preview_file_import(
    source_path: String,
    app: AppHandle,
) -> Result<FileImportPreview, String> {
    run_blocking(move || {
        preview_file_import_with_state(app.state::<DatabaseState>().inner(), &source_path)
    })
    .await
}

#[tauri::command]
pub async fn commit_file_import(
    token: String,
    collection_id: Option<String>,
    duplicate_policy: Option<String>,
    app: AppHandle,
) -> Result<CaptureOutcome, String> {
    let worker = app.clone();
    let outcome = run_blocking(move || {
        commit_file_import_with_state(
            worker.state::<DatabaseState>().inner(),
            &token,
            collection_id.as_deref(),
            duplicate_policy.as_deref(),
        )
    })
    .await?;
    index_new_pdf(&app, &outcome);
    Ok(outcome)
}

#[tauri::command]
pub fn cancel_file_import(token: String, state: State<'_, DatabaseState>) -> Result<(), String> {
    cancel_file_import_with_state(state.inner(), &token)
}

#[tauri::command]
pub async fn index_file(item_id: String, app: AppHandle) -> Result<IndexState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let result = index_file_with_state(app.state::<DatabaseState>().inner(), &item_id);
        let _ = app.emit("file-index-complete", serde_json::json!({"itemId": item_id, "status": result.as_ref().map(|row| row.status.as_str()).unwrap_or("failed")}));
        result
    }).await.map_err(|error| format!("Could not index PDF: {error}"))?
}

#[tauri::command]
pub fn save_item(input: ItemInput, state: State<'_, DatabaseState>) -> Result<CaptureOutcome, String> {
    capture_item_with_state(state.inner(), &input)
}

fn emit_access_changed(app: &AppHandle, state: &DatabaseState) {
    let _ = app.emit(
        "collection-access-changed",
        serde_json::json!({ "accessEpoch": state.access_epoch() }),
    );
}

#[tauri::command]
pub fn load_item(id: String, state: State<'_, DatabaseState>) -> Result<Item, String> {
    load_item_with_state(state.inner(), &id)
}

#[tauri::command]
pub fn list_items(
    filter: Option<ItemFilter>,
    state: State<'_, DatabaseState>,
) -> Result<Vec<ItemSummary>, String> {
    list_items_with_state(state.inner(), filter.as_ref())
}

#[tauri::command]
pub fn set_item_tags(
    id: String,
    tags: Vec<String>,
    state: State<'_, DatabaseState>,
) -> Result<Vec<String>, String> {
    set_item_tags_with_state(state.inner(), &id, &tags)
}

#[tauri::command]
pub fn list_collections(state: State<'_, DatabaseState>) -> Result<Vec<Collection>, String> {
    list_collections_with_state(state.inner())
}

#[tauri::command]
pub fn list_item_versions(
    item_id: String,
    state: State<'_, DatabaseState>,
) -> Result<Vec<ItemVersion>, String> {
    list_item_versions_with_state(state.inner(), &item_id)
}

#[tauri::command]
pub fn restore_item_version(
    version_id: String,
    state: State<'_, DatabaseState>,
) -> Result<Item, String> {
    restore_item_version_with_state(state.inner(), &version_id)
}

#[tauri::command]
pub fn read_item_file(
    id: String,
    state: State<'_, DatabaseState>,
) -> Result<ItemFilePreview, String> {
    read_item_file_with_state(state.inner(), &id)
}

#[tauri::command]
pub fn load_storage_report(state: State<'_, DatabaseState>) -> Result<StorageReport, String> {
    load_storage_report_with_state(state.inner())
}

#[tauri::command]
pub fn list_index_state(state: State<'_, DatabaseState>) -> Result<Vec<IndexState>, String> {
    list_index_state_with_state(state.inner())
}

#[tauri::command]
pub fn set_item_pinned(
    id: String,
    pinned: bool,
    state: State<'_, DatabaseState>,
) -> Result<Item, String> {
    set_item_pinned_with_state(state.inner(), &id, pinned)
}

#[tauri::command]
pub fn set_items_favorite(
    ids: Vec<String>,
    favorite: bool,
    state: State<'_, DatabaseState>,
) -> Result<(), String> {
    set_items_favorite_with_state(state.inner(), &ids, favorite)
}

#[tauri::command]
pub fn move_items_to_collection(
    ids: Vec<String>,
    collection_id: Option<String>,
    state: State<'_, DatabaseState>,
) -> Result<(), String> {
    move_items_to_collection_with_state(state.inner(), &ids, collection_id.as_deref())
}

#[tauri::command]
pub fn trash_items(ids: Vec<String>, state: State<'_, DatabaseState>) -> Result<(), String> {
    trash_items_with_state(state.inner(), &ids)
}

#[tauri::command]
pub fn restore_items(ids: Vec<String>, state: State<'_, DatabaseState>) -> Result<(), String> {
    restore_items_with_state(state.inner(), &ids)
}

#[tauri::command]
pub fn delete_items_permanently(
    ids: Vec<String>,
    state: State<'_, DatabaseState>,
) -> Result<(), String> {
    delete_items_permanently_with_state(state.inner(), &ids)
}

#[tauri::command]
pub fn load_vault_summary(state: State<'_, DatabaseState>) -> Result<VaultSummary, String> {
    load_vault_summary_with_state(state.inner())
}

#[tauri::command]
pub fn save_collection(
    input: CollectionInput,
    state: State<'_, DatabaseState>,
) -> Result<Collection, String> {
    save_collection_with_state(state.inner(), &input)
}

#[tauri::command]
pub fn delete_collection(id: String, state: State<'_, DatabaseState>) -> Result<(), String> {
    delete_collection_with_state(state.inner(), &id)
}

/// Closes a collection that was opened with its secret this session.
#[tauri::command]
pub fn lock_collection(id: String, app: AppHandle, state: State<'_, DatabaseState>) {
    state.lock_collection(&id);
    emit_access_changed(&app, state.inner());
}

#[tauri::command]
pub fn verify_collection_secret(
    id: String,
    secret: String,
    app: AppHandle,
    state: State<'_, DatabaseState>,
) -> Result<bool, String> {
    state.check_attempt()?;
    let matched = verify_collection_secret_with_state(state.inner(), &id, &secret)?;
    state.record_attempt(matched);
    if matched {
        emit_access_changed(&app, state.inner());
    }
    Ok(matched)
}

#[tauri::command]
pub fn list_tags(state: State<'_, DatabaseState>) -> Result<Vec<Tag>, String> {
    list_tags_with_state(state.inner())
}

#[tauri::command]
pub fn pick_file(app: AppHandle) -> Result<Option<String>, String> {
    Ok(app
        .dialog()
        .file()
        .blocking_pick_file()
        .map(|path| path.to_string()))
}

#[tauri::command]
pub fn pick_files(app: AppHandle) -> Result<Option<Vec<String>>, String> {
    Ok(app
        .dialog()
        .file()
        .blocking_pick_files()
        .map(|paths| paths.into_iter().map(|path| path.to_string()).collect()))
}

#[tauri::command]
pub fn open_item_file(
    id: String,
    app: AppHandle,
    state: State<'_, DatabaseState>,
) -> Result<(), String> {
    let path = managed_file_path_with_state(state.inner(), &id)?;

    if is_runnable(&path) {
        return Err(
            "Kivo does not open programs or scripts. Use Show in folder instead.".to_string(),
        );
    }

    app.opener()
        .open_path(path.to_string_lossy().to_string(), None::<&str>)
        .map_err(|error| format!("Could not open the file: {error}"))?;

    Ok(())
}

#[tauri::command]
pub fn reveal_item_file(
    id: String,
    app: AppHandle,
    state: State<'_, DatabaseState>,
) -> Result<(), String> {
    let path = managed_file_path_with_state(state.inner(), &id)?;

    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|error| format!("Could not reveal the file: {error}"))
}

#[tauri::command]
pub fn open_source_url(
    id: String,
    app: AppHandle,
    state: State<'_, DatabaseState>,
) -> Result<(), String> {
    let url = source_url_with_state(state.inner(), &id)?;

    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| format!("Could not open the address: {error}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use rusqlite::params;

    use super::*;

    // One temp root holds the database file and the managed folder so Drop can remove both.
    struct TempVault {
        root: PathBuf,
        database_path: PathBuf,
        files_dir: PathBuf,
    }

    impl TempVault {
        fn new(label: &str) -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock is after the Unix epoch")
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "kivo-vault-{label}-{}-{unique}",
                std::process::id()
            ));

            Self {
                database_path: root.join("kivo.db"),
                files_dir: root.join("files"),
                root,
            }
        }

        fn state(&self) -> DatabaseState {
            let state = DatabaseState::new(self.database_path.clone(), self.files_dir.clone());
            state.initialize().expect("initialize database");
            state
        }
    }

    impl Drop for TempVault {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn note_input(title: &str, content: &str) -> ItemInput {
        ItemInput {
            id: None,
            kind: "note".to_string(),
            title: title.to_string(),
            description: String::new(),
            content: Some(content.to_string()),
            url: None,
            collection_id: None,
            is_favorite: None,
            is_pinned: None,
            duplicate_policy: None,
        }
    }

    fn source_input(title: &str, url: &str) -> ItemInput {
        ItemInput {
            id: None,
            kind: "source".to_string(),
            title: title.to_string(),
            description: String::new(),
            content: None,
            url: Some(url.to_string()),
            collection_id: None,
            is_favorite: None,
            is_pinned: None,
            duplicate_policy: None,
        }
    }

    #[test]
    fn opening_a_source_refuses_a_stored_non_web_address() {
        let vault = TempVault::new("source-scheme");
        let state = vault.state();
        let saved = save_item_with_state(&state, &source_input("Site", "https://example.com"))
            .expect("save source");

        assert_eq!(
            source_url_with_state(&state, &saved.id).expect("web address opens"),
            "https://example.com"
        );

        // An import or an older version could have stored any scheme.
        state
            .require_connection()
            .expect("lock connection")
            .as_ref()
            .expect("connection")
            .execute(
                "UPDATE items SET url = 'ms-msdt:/id PCWDiagnostic' WHERE id = ?1",
                params![saved.id],
            )
            .expect("plant url");

        assert_eq!(
            source_url_with_state(&state, &saved.id).expect_err("scheme refused"),
            "Only http and https addresses can be opened"
        );
    }

    #[test]
    fn runnable_file_types_are_recognized() {
        for name in ["a.exe", "b.BAT", "c.lnk", "d.ps1", "e.hta", "f.JS", "g.url"] {
            assert!(is_runnable(Path::new(name)), "{name}");
        }
        for name in ["a.pdf", "b.png", "c.txt", "d.docx", "noextension"] {
            assert!(!is_runnable(Path::new(name)), "{name}");
        }
    }

    #[test]
    fn clear_temp_files_removes_decrypted_copies() {
        let path = write_temp_file("clear-test", Some("secret.txt"), b"plaintext").unwrap();
        assert!(path.is_file());

        encryption::clear_temp_files();

        assert!(!path.exists());
    }

    fn seed_collection(state: &DatabaseState, id: &str, name: &str, sort_order: i64) {
        let connection = state.require_connection().expect("lock connection");
        connection
            .as_ref()
            .expect("connection is initialized")
            .execute(
                "INSERT INTO collections (id, name, sort_order, created_at)
                 VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                params![id, name, sort_order],
            )
            .expect("seed collection");
    }

    fn titles(summaries: &[ItemSummary]) -> Vec<String> {
        summaries
            .iter()
            .map(|summary| summary.title.clone())
            .collect()
    }

    fn stored_name(state: &DatabaseState, item_id: &str) -> String {
        let connection = state.require_connection().expect("lock connection");
        connection
            .as_ref()
            .expect("connection is initialized")
            .query_row(
                "SELECT stored_name FROM files WHERE item_id = ?1",
                params![item_id],
                |row| row.get(0),
            )
            .expect("read stored name")
    }

    #[test]
    fn note_body_search_returns_snippet_and_updates_after_edit() {
        let vault = TempVault::new("fts-note");
        let state = vault.state();
        let saved = save_item_with_state(
            &state,
            &note_input("Plain title", "<p>uniqueorchid blooms</p>"),
        )
        .expect("save note");
        let filter = ItemFilter {
            query: Some("uniqueorchid".into()),
            ..Default::default()
        };
        let results = list_items_with_state(&state, Some(&filter)).expect("search");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, saved.id);
        assert!(results[0]
            .match_snippet
            .as_deref()
            .unwrap_or("")
            .contains("uniqueorchid"));

        let mut updated = note_input("Plain title", "<p>differentflower blooms</p>");
        updated.id = Some(saved.id);
        save_item_with_state(&state, &updated).expect("update");
        assert!(list_items_with_state(&state, Some(&filter))
            .expect("search old")
            .is_empty());
    }

    #[test]
    fn note_versions_snapshot_previous_body_and_restore_current_body() {
        let vault = TempVault::new("versions");
        let state = vault.state();
        let saved =
            save_item_with_state(&state, &note_input("First", "first body")).expect("create");
        let mut edit = note_input("Second", "second body");
        edit.id = Some(saved.id.clone());
        save_item_with_state(&state, &edit).expect("edit");
        let versions = list_item_versions_with_state(&state, &saved.id).expect("versions");
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].content, "first body");
        let restored = restore_item_version_with_state(&state, &versions[0].id).expect("restore");
        assert_eq!(restored.content.as_deref(), Some("first body"));
        assert!(list_item_versions_with_state(&state, &saved.id)
            .expect("versions after restore")
            .iter()
            .any(|v| v.content == "second body"));
    }

    #[test]
    fn rapid_note_saves_do_not_make_duplicate_snapshots() {
        let vault = TempVault::new("version-throttle");
        let state = vault.state();
        let note = save_item_with_state(&state, &note_input("Note", "first")).expect("create");
        for body in ["second", "third", "third"] {
            let mut input = note_input("Note", body);
            input.id = Some(note.id.clone());
            save_item_with_state(&state, &input).expect("save");
        }
        assert_eq!(
            list_item_versions_with_state(&state, &note.id)
                .expect("versions")
                .len(),
            1
        );
        let connection = state.require_connection().expect("connection");
        connection
            .as_ref()
            .unwrap()
            .execute(
                "UPDATE item_versions SET created_at='2020-01-01T00:00:00.000Z' WHERE item_id=?1",
                params![note.id],
            )
            .expect("age snapshot");
        drop(connection);
        let mut input = note_input("Note", "fourth");
        input.id = Some(note.id.clone());
        save_item_with_state(&state, &input).expect("save after five minutes");
        assert_eq!(
            list_item_versions_with_state(&state, &note.id)
                .expect("versions")
                .len(),
            2
        );
    }

    #[test]
    fn version_history_prunes_to_twenty_and_rejects_files() {
        let vault = TempVault::new("version-prune");
        let state = vault.state();
        let note = save_item_with_state(&state, &note_input("Note", "body")).expect("note");
        {
            let connection = state.require_connection().expect("connection");
            let connection = connection.as_ref().unwrap();
            for number in 0..25 {
                insert_version(
                    connection,
                    &note.id,
                    "Note",
                    &format!("version {number}"),
                    None,
                )
                .expect("snapshot");
            }
        }
        let versions = list_item_versions_with_state(&state, &note.id).expect("versions");
        assert_eq!(versions.len(), 20);
        assert_eq!(versions[0].content, "version 24");
        assert_eq!(versions[19].content, "version 5");
        let source = vault.root.join("binary.bin");
        fs::write(&source, b"binary").expect("fixture");
        let file = import_file_with_state(&state, &source.to_string_lossy()).expect("import");
        assert!(list_item_versions_with_state(&state, &file.id).is_err());
    }

    #[test]
    fn pdf_index_failure_sets_failed_status_without_locking_out_other_reads() {
        let vault = TempVault::new("pdf-failure");
        let state = vault.state();
        let source = vault.root.join("broken.pdf");
        fs::write(&source, b"not actually a PDF").expect("fixture");
        let item = import_file_with_state(&state, &source.to_string_lossy()).expect("import");
        assert!(index_file_with_state(&state, &item.id).is_err());
        let rows = list_index_state_with_state(&state).expect("index status");
        assert_eq!(rows[0].status, "failed");
        assert!(load_item_with_state(&state, &item.id).is_ok());
    }

    #[test]
    fn pdf_text_indexes_and_search_finds_body_only_term() {
        let vault = TempVault::new("pdf-search");
        let state = vault.state();
        let source = vault.root.join("report.pdf");
        let stream = "BT /F1 12 Tf 40 100 Td (quasarneedle) Tj ET";
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>".to_string(),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
            format!("<< /Length {} >>\nstream\n{}\nendstream", stream.len(), stream),
        ];
        let mut pdf = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (number, object) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", number + 1, object).as_bytes());
        }
        let xref = pdf.len();
        pdf.extend_from_slice(format!("xref\n0 6\n0000000000 65535 f \n{}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n", offsets.iter().map(|offset| format!("{offset:010} 00000 n \n")).collect::<String>(), xref).as_bytes());
        fs::write(&source, pdf).expect("write PDF fixture");
        let item = import_file_with_state(&state, &source.to_string_lossy()).expect("import PDF");
        assert_eq!(
            index_file_with_state(&state, &item.id)
                .expect("index PDF")
                .status,
            "indexed"
        );
        let results = list_items_with_state(
            &state,
            Some(&ItemFilter {
                query: Some("quasarneedle".into()),
                ..Default::default()
            }),
        )
        .expect("search PDF");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, item.id);
        assert!(results[0]
            .match_snippet
            .as_deref()
            .unwrap_or("")
            .contains("quasarneedle"));
    }

    #[test]
    fn preview_reads_managed_text_and_storage_groups_files() {
        let vault = TempVault::new("preview-storage");
        let state = vault.state();
        let source = vault.root.join("readme.md");
        fs::write(&source, b"private content").expect("fixture");
        let item = import_file_with_state(&state, &source.to_string_lossy()).expect("import");
        let preview = read_item_file_with_state(&state, &item.id).expect("preview");
        assert_eq!(preview.preview, "text");
        assert_eq!(preview.text.as_deref(), Some("private content"));
        assert!(preview.payload_base64.is_none());
        let report = load_storage_report_with_state(&state).expect("storage");
        assert_eq!(report.file_count, 1);
        assert_eq!(report.file_bytes, 15);
        assert_eq!(report.total_bytes, report.database_bytes + 15);
        assert_eq!(
            report
                .groups
                .iter()
                .find(|group| group.label == "Text")
                .unwrap()
                .count,
            1
        );
        assert_eq!(report.largest[0].item_id, item.id);
    }

    #[test]
    fn preview_truncates_large_text_instead_of_refusing_it() {
        let vault = TempVault::new("preview-large-text");
        let state = vault.state();
        let source = vault.root.join("large.txt");
        fs::write(&source, vec![b'x'; 26 * 1024 * 1024]).expect("fixture");
        let item = import_file_with_state(&state, &source.to_string_lossy()).expect("import");

        let preview = read_item_file_with_state(&state, &item.id).expect("preview");
        assert_eq!(preview.preview, "text");
        assert!(preview.truncated);
        assert_eq!(preview.text.unwrap().len(), 1024 * 1024);
    }

    #[test]
    fn saved_note_reads_back_with_its_fields() {
        let vault = TempVault::new("note-round-trip");
        let state = vault.state();

        let saved = save_item_with_state(&state, &note_input("  Grocery list  ", "milk and eggs"))
            .expect("save note");

        assert_eq!(saved.kind, "note");
        assert_eq!(saved.title, "Grocery list");
        assert_eq!(saved.description, "");
        assert_eq!(saved.content.as_deref(), Some("milk and eggs"));
        assert_eq!(saved.url, None);
        assert_eq!(saved.collection_id, None);
        assert!(!saved.is_favorite);
        assert!(saved.tags.is_empty());
        assert!(saved.file.is_none());
        assert!(!saved.file_missing);
        assert!(!saved.created_at.is_empty());
        assert!(!saved.updated_at.is_empty());

        let loaded = load_item_with_state(&state, &saved.id).expect("load note");
        assert_eq!(loaded, saved);
    }

    #[test]
    fn note_content_survives_a_restart() {
        let vault = TempVault::new("note-restart");
        let id = {
            let state = vault.state();
            save_item_with_state(&state, &note_input("Ideas", "first thought"))
                .expect("save note")
                .id
        };

        let state = vault.state();
        let loaded = load_item_with_state(&state, &id).expect("load after restart");
        assert_eq!(loaded.title, "Ideas");
        assert_eq!(loaded.content.as_deref(), Some("first thought"));
    }

    #[test]
    fn favorite_state_survives_a_restart() {
        let vault = TempVault::new("favorite-restart");
        let id = {
            let state = vault.state();
            let mut input = note_input("Pinned", "keep me");
            input.is_favorite = Some(true);
            save_item_with_state(&state, &input)
                .expect("save favorite")
                .id
        };

        let state = vault.state();
        let loaded = load_item_with_state(&state, &id).expect("load after restart");
        assert!(loaded.is_favorite);

        let mut input = note_input("Pinned", "keep me");
        input.id = Some(loaded.id.clone());
        input.is_favorite = Some(false);
        let updated = save_item_with_state(&state, &input).expect("clear favorite");
        assert!(!updated.is_favorite);
    }

    #[test]
    fn item_validation_messages_are_stable() {
        let vault = TempVault::new("item-validation");
        let state = vault.state();

        let error = save_item_with_state(&state, &note_input("   ", "body"))
            .expect_err("blank title rejected");
        assert_eq!(error, "Item title is required");

        let mut file_create = note_input("File", "body");
        file_create.kind = "file".to_string();
        let error = save_item_with_state(&state, &file_create).expect_err("file create rejected");
        assert_eq!(error, "File items are created by import");

        let mut alien = note_input("Alien", "body");
        alien.kind = "other".to_string();
        let error = save_item_with_state(&state, &alien).expect_err("unknown kind rejected");
        assert_eq!(error, "Items must be notes, sources, or files");

        let error = save_item_with_state(&state, &source_input("Article", "   "))
            .expect_err("blank url rejected");
        assert_eq!(error, "Source items need a web address");

        for url in ["file:///C:/Windows/System32/calc.exe", "ms-msdt:/id x", "javascript:x"] {
            let error = save_item_with_state(&state, &source_input("Bad", url))
                .expect_err("non-web url rejected");
            assert_eq!(error, "Web addresses must start with http:// or https://");
        }

        let saved = save_item_with_state(&state, &note_input("Stable", "body")).expect("save note");
        let mut change = note_input("Stable", "body");
        change.id = Some(saved.id.clone());
        change.kind = "source".to_string();
        change.url = Some("https://example.com".to_string());
        let error = save_item_with_state(&state, &change).expect_err("kind change rejected");
        assert_eq!(error, "Item type cannot change");
    }

    #[test]
    fn items_keep_a_valid_collection_and_reject_unknown_ones() {
        let vault = TempVault::new("collections");
        let state = vault.state();
        seed_collection(&state, "col-1", "Projects", 0);

        let mut input = note_input("Plan", "steps");
        input.collection_id = Some("col-1".to_string());
        let saved = save_item_with_state(&state, &input).expect("save with collection");
        assert_eq!(saved.collection_id.as_deref(), Some("col-1"));

        let loaded = load_item_with_state(&state, &saved.id).expect("load with collection");
        assert_eq!(loaded.collection_id.as_deref(), Some("col-1"));

        let mut unknown = note_input("Orphan", "steps");
        unknown.collection_id = Some("missing".to_string());
        let error =
            save_item_with_state(&state, &unknown).expect_err("unknown collection rejected");
        assert_eq!(error, "Collection does not exist");
    }

    #[test]
    fn tags_are_replaced_and_deduplicated_case_insensitively() {
        let vault = TempVault::new("tags");
        let state = vault.state();
        let saved = save_item_with_state(&state, &note_input("Tagged", "body")).expect("save note");

        let first = set_item_tags_with_state(
            &state,
            &saved.id,
            &[
                "Work".to_string(),
                "personal".to_string(),
                "work".to_string(),
                "   ".to_string(),
            ],
        )
        .expect("set tags");
        assert_eq!(first, vec!["Work".to_string(), "personal".to_string()]);

        let loaded = load_item_with_state(&state, &saved.id).expect("load tags");
        assert_eq!(
            loaded.tags,
            vec!["Work".to_string(), "personal".to_string()]
        );

        let second =
            set_item_tags_with_state(&state, &saved.id, &["Home".to_string()]).expect("replace");
        assert_eq!(second, vec!["Home".to_string()]);

        let loaded = load_item_with_state(&state, &saved.id).expect("load replaced tags");
        assert_eq!(loaded.tags, vec!["Home".to_string()]);

        // A replace stores exactly what was given; here the lower-case spelling wins.
        let third = set_item_tags_with_state(&state, &saved.id, &["home".to_string()])
            .expect("replace again");
        assert_eq!(third, vec!["home".to_string()]);

        let loaded = load_item_with_state(&state, &saved.id).expect("load lower-case tag");
        assert_eq!(loaded.tags, vec!["home".to_string()]);

        // list_tags folds the stored spelling into one case-insensitive row.
        let tags = list_tags_with_state(&state).expect("list tags");
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].name, "home");
        assert_eq!(tags[0].count, 1);
    }

    #[test]
    fn import_file_copies_bytes_and_records_them() {
        let vault = TempVault::new("import");
        let state = vault.state();

        let source = vault.root.join("report.txt");
        fs::write(&source, b"hello world").expect("write source file");

        let item = import_file_with_state(&state, &source.to_string_lossy()).expect("import file");

        assert_eq!(item.kind, "file");
        assert_eq!(item.title, "report.txt");
        assert_eq!(item.description, "");
        assert_eq!(item.content, None);
        assert_eq!(item.url, None);
        assert!(!item.is_favorite);
        assert!(!item.file_missing);

        let file = item.file.as_ref().expect("file details");
        assert_eq!(file.original_name, "report.txt");
        assert_eq!(file.byte_size, 11);
        assert!(!file.imported_at.is_empty());

        let name = stored_name(&state, &item.id);
        assert!(!name.contains('/'), "path separator leaked: {name}");
        assert!(!name.contains('\\'), "path separator leaked: {name}");
        assert!(name.ends_with(".txt"));

        let copied = fs::read(state.files_dir().join(&name)).expect("read copied file");
        assert_eq!(copied, b"hello world".to_vec());
    }

    #[test]
    fn import_rejects_missing_paths_and_directories() {
        let vault = TempVault::new("import-rejects");
        let state = vault.state();

        let missing = vault.root.join("does-not-exist.txt");
        let error = import_file_with_state(&state, &missing.to_string_lossy())
            .expect_err("missing source rejected");
        assert_eq!(error, "Source file was not found");

        let error = import_file_with_state(&state, &vault.root.to_string_lossy())
            .expect_err("directory source rejected");
        assert_eq!(error, "Source must be a file");

        let error = import_file_with_state(&state, "   ").expect_err("blank source rejected");
        assert_eq!(error, "Source file is required");
    }

    #[test]
    fn hostile_source_names_still_produce_safe_stored_names() {
        let vault = TempVault::new("hostile-name");
        let state = vault.state();

        let nested = vault.root.join("nested").join("deeper");
        fs::create_dir_all(&nested).expect("create source folder");
        let source = nested.join("evil name.TXT");
        fs::write(&source, b"payload").expect("write source file");

        // A path that walks through a parent folder but still resolves to the file.
        let twisting = vault
            .root
            .join("nested")
            .join("deeper")
            .join("..")
            .join("deeper")
            .join("evil name.TXT");

        let item = import_file_with_state(&state, &twisting.to_string_lossy()).expect("import");
        assert_eq!(item.title, "evil name.TXT");

        let name = stored_name(&state, &item.id);
        assert!(name.ends_with(".txt"), "unexpected stored name: {name}");
        assert!(!name.contains('/'), "path separator leaked: {name}");
        assert!(!name.contains('\\'), "path separator leaked: {name}");

        assert_eq!(
            filtered_extension(Path::new("..\\..\\evil name.TXT")),
            "txt"
        );
    }

    #[test]
    fn a_deleted_managed_file_reports_missing() {
        let vault = TempVault::new("missing-file");
        let state = vault.state();

        let source = vault.root.join("photo.png");
        fs::write(&source, b"pixels").expect("write source file");
        let item = import_file_with_state(&state, &source.to_string_lossy()).expect("import");

        let name = stored_name(&state, &item.id);
        fs::remove_file(state.files_dir().join(&name)).expect("delete managed file");

        let loaded = load_item_with_state(&state, &item.id).expect("load after delete");
        assert!(loaded.file_missing);
        assert_eq!(loaded.title, "photo.png");
        assert!(loaded.file.is_some());

        let summaries = list_items_with_state(&state, None).expect("list after delete");
        let summary = summaries
            .iter()
            .find(|summary| summary.id == item.id)
            .expect("summary present");
        assert!(summary.file_missing);
    }

    #[test]
    fn rename_and_move_keep_the_stored_file_name() {
        let vault = TempVault::new("rename-move");
        let state = vault.state();
        seed_collection(&state, "col-move", "Archive", 1);

        let source = vault.root.join("notes.txt");
        fs::write(&source, b"draft").expect("write source file");
        let item = import_file_with_state(&state, &source.to_string_lossy()).expect("import");

        let before = stored_name(&state, &item.id);

        let renamed = save_item_with_state(
            &state,
            &ItemInput {
                id: Some(item.id.clone()),
                kind: "file".to_string(),
                title: "Renamed file".to_string(),
                description: "moved".to_string(),
                content: None,
                url: None,
                collection_id: Some("col-move".to_string()),
                is_favorite: Some(true),
                is_pinned: None,
                duplicate_policy: None,
            },
        )
        .expect("rename and move");

        assert_eq!(renamed.title, "Renamed file");
        assert_eq!(renamed.description, "moved");
        assert_eq!(renamed.collection_id.as_deref(), Some("col-move"));
        assert!(renamed.is_favorite);
        assert!(!renamed.file_missing);

        let after = stored_name(&state, &item.id);
        assert_eq!(before, after, "the stored file name never changes");
    }

    #[test]
    fn deleting_a_collection_clears_the_item_collection() {
        let vault = TempVault::new("collection-delete");
        let state = vault.state();
        seed_collection(&state, "col-del", "Temporary", 0);

        let mut input = note_input("Kept", "body");
        input.collection_id = Some("col-del".to_string());
        let saved = save_item_with_state(&state, &input).expect("save with collection");

        {
            let connection = state.require_connection().expect("lock connection");
            connection
                .as_ref()
                .expect("connection is initialized")
                .execute("DELETE FROM collections WHERE id = 'col-del'", [])
                .expect("delete collection");
        }

        let loaded = load_item_with_state(&state, &saved.id).expect("load after collection delete");
        assert_eq!(loaded.collection_id, None);
        assert_eq!(loaded.title, "Kept");
    }

    #[test]
    fn list_items_returns_newest_first_with_summary_fields() {
        let vault = TempVault::new("list-items");
        let state = vault.state();

        let older = save_item_with_state(&state, &note_input("Older", "body")).expect("save older");
        let newer = save_item_with_state(&state, &note_input("Newer", "body")).expect("save newer");

        {
            let connection = state.require_connection().expect("lock connection");
            let connection = connection.as_ref().expect("connection is initialized");

            connection
                .execute(
                    "UPDATE items SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?1",
                    params![older.id],
                )
                .expect("age older item");
            connection
                .execute(
                    "UPDATE items SET updated_at = '2021-01-01T00:00:00.000Z' WHERE id = ?1",
                    params![newer.id],
                )
                .expect("age newer item");
        }

        let summaries = list_items_with_state(&state, None).expect("list items");
        assert_eq!(summaries.len(), 2);
        assert_eq!(summaries[0].id, newer.id);
        assert_eq!(summaries[1].id, older.id);
        assert_eq!(summaries[0].kind, "note");
        assert_eq!(summaries[0].title, "Newer");
        assert!(!summaries[0].is_favorite);
        assert_eq!(summaries[0].collection_id, None);
        assert_eq!(summaries[0].updated_at, "2021-01-01T00:00:00.000Z");
        assert_eq!(summaries[0].file, None);
        assert!(!summaries[0].file_missing);
    }

    #[test]
    fn list_items_summaries_include_file_details() {
        let vault = TempVault::new("summary-file");
        let state = vault.state();

        let source = vault.root.join("report.txt");
        fs::write(&source, b"hello world").expect("write source file");

        let item = import_file_with_state(&state, &source.to_string_lossy()).expect("import file");
        let summaries = list_items_with_state(&state, None).expect("list items");

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, item.id);
        let file = summaries[0].file.as_ref().expect("summary file details");
        assert_eq!(file.original_name, "report.txt");
        assert_eq!(file.byte_size, 11);
        assert!(!file.imported_at.is_empty());
        assert!(!summaries[0].file_missing);
    }

    #[test]
    fn source_items_store_and_reload_a_personal_note() {
        let vault = TempVault::new("source-note");
        let state = vault.state();

        let mut input = source_input("Rust", "https://www.rust-lang.org");
        input.content = Some("Read the book list".to_string());

        let saved = save_item_with_state(&state, &input).expect("save source");
        assert_eq!(saved.content.as_deref(), Some("Read the book list"));

        let loaded = load_item_with_state(&state, &saved.id).expect("load source");
        assert_eq!(loaded.content.as_deref(), Some("Read the book list"));
        assert_eq!(loaded.url.as_deref(), Some("https://www.rust-lang.org"));
    }

    #[test]
    fn list_collections_reads_onboarding_order() {
        let vault = TempVault::new("collection-order");
        let state = vault.state();

        seed_collection(&state, "c-2", "Zeta", 2);
        seed_collection(&state, "c-0", "Alpha", 0);
        seed_collection(&state, "c-1", "Beta", 1);

        let collections = list_collections_with_state(&state).expect("list collections");
        let names: Vec<&str> = collections
            .iter()
            .map(|collection| collection.name.as_str())
            .collect();

        assert_eq!(names, vec!["Alpha", "Beta", "Zeta"]);
        assert_eq!(collections[0].sort_order, 0);
        assert_eq!(collections[2].sort_order, 2);
        assert!(!collections[0].created_at.is_empty());
    }

    #[test]
    fn index_state_is_recorded_in_order() {
        let vault = TempVault::new("index-state");
        let state = vault.state();

        let saved =
            save_item_with_state(&state, &note_input("Indexed", "body")).expect("save note");

        let index_rows = list_index_state_with_state(&state).expect("list index state");
        assert_eq!(index_rows.len(), 1);
        assert_eq!(index_rows[0].item_id, saved.id);
        assert!(!index_rows[0].needs_index);
        assert_eq!(index_rows[0].status, "indexed");
        assert!(index_rows[0].indexed_at.is_some());

        {
            let connection = state.require_connection().expect("lock connection");
            connection
                .as_ref()
                .expect("connection is initialized")
                .execute(
                    "UPDATE index_state
                     SET indexed_at = '2026-01-02T03:04:05.000Z', needs_index = 0
                     WHERE item_id = ?1",
                    params![saved.id],
                )
                .expect("mark indexed");
        }

        let index_rows = list_index_state_with_state(&state).expect("list index state again");
        assert!(!index_rows[0].needs_index);
        assert_eq!(
            index_rows[0].indexed_at.as_deref(),
            Some("2026-01-02T03:04:05.000Z")
        );

        let mut update = note_input("Indexed", "body changed");
        update.id = Some(saved.id.clone());
        save_item_with_state(&state, &update).expect("update note");

        let index_rows = list_index_state_with_state(&state).expect("list after update");
        assert!(!index_rows[0].needs_index, "a note indexes during save");
    }

    #[test]
    fn list_items_filters_by_kind_collection_and_favorite() {
        let vault = TempVault::new("list-filter");
        let state = vault.state();
        seed_collection(&state, "col-a", "Alpha", 0);
        seed_collection(&state, "col-b", "Beta", 1);

        let mut in_alpha = note_input("Alpha note", "body");
        in_alpha.collection_id = Some("col-a".to_string());
        let alpha = save_item_with_state(&state, &in_alpha).expect("save alpha note");

        let mut favorited = note_input("Favorite note", "body");
        favorited.collection_id = Some("col-b".to_string());
        favorited.is_favorite = Some(true);
        let favorited = save_item_with_state(&state, &favorited).expect("save favorite note");

        let source = save_item_with_state(&state, &source_input("Site", "https://example.com"))
            .expect("save source");

        let mut filter = ItemFilter {
            kind: Some("note".to_string()),
            ..ItemFilter::default()
        };
        let notes = list_items_with_state(&state, Some(&filter)).expect("list notes");
        assert_eq!(notes.len(), 2);
        assert!(notes.iter().all(|summary| summary.kind == "note"));
        assert!(!notes.iter().any(|summary| summary.id == source.id));

        filter = ItemFilter {
            collection_id: Some("col-a".to_string()),
            ..ItemFilter::default()
        };
        let in_collection =
            list_items_with_state(&state, Some(&filter)).expect("list collection items");
        assert_eq!(in_collection.len(), 1);
        assert_eq!(in_collection[0].id, alpha.id);

        filter = ItemFilter {
            favorite: Some(true),
            ..ItemFilter::default()
        };
        let favorites = list_items_with_state(&state, Some(&filter)).expect("list favorites");
        assert_eq!(favorites.len(), 1);
        assert_eq!(favorites[0].id, favorited.id);

        filter = ItemFilter {
            kind: Some("note".to_string()),
            favorite: Some(true),
            ..ItemFilter::default()
        };
        let combined = list_items_with_state(&state, Some(&filter)).expect("list combined");
        assert_eq!(combined.len(), 1);
        assert_eq!(combined[0].id, favorited.id);
    }

    #[test]
    fn list_items_filters_by_tag() {
        let vault = TempVault::new("list-tag-filter");
        let state = vault.state();

        let tagged =
            save_item_with_state(&state, &note_input("Tagged", "body")).expect("save tagged");
        let untagged =
            save_item_with_state(&state, &note_input("Untagged", "body")).expect("save untagged");

        set_item_tags_with_state(&state, &tagged.id, &["Work".to_string()]).expect("set tag");

        // The filter matches a tag name case-insensitively.
        let filter = ItemFilter {
            tag: Some("work".to_string()),
            ..ItemFilter::default()
        };
        let filtered = list_items_with_state(&state, Some(&filter)).expect("list by tag");
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].id, tagged.id);
        assert!(!filtered.iter().any(|summary| summary.id == untagged.id));
    }

    #[test]
    fn list_items_query_escapes_like_wildcards() {
        let vault = TempVault::new("list-query");
        let state = vault.state();

        let percent =
            save_item_with_state(&state, &note_input("100% done", "body")).expect("save percent");
        let underscore =
            save_item_with_state(&state, &note_input("a_b note", "body")).expect("save underscore");
        let _decoy =
            save_item_with_state(&state, &note_input("1005 done", "body")).expect("save decoy");
        let _other =
            save_item_with_state(&state, &note_input("axb note", "body")).expect("save other");

        let filter = ItemFilter {
            query: Some("100%".to_string()),
            ..ItemFilter::default()
        };
        let found = list_items_with_state(&state, Some(&filter)).expect("percent query");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, percent.id);

        let filter = ItemFilter {
            query: Some("a_b".to_string()),
            ..ItemFilter::default()
        };
        let found = list_items_with_state(&state, Some(&filter)).expect("underscore query");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, underscore.id);

        // Every note shares the content "body", so a content query reaches all four.
        let filter = ItemFilter {
            query: Some("body".to_string()),
            ..ItemFilter::default()
        };
        let found = list_items_with_state(&state, Some(&filter)).expect("content query");
        assert_eq!(found.len(), 4);

        // The original file name is part of the search.
        let source_path = vault.root.join("quarterly-report.txt");
        fs::write(&source_path, b"data").expect("write source file");
        let file_item =
            import_file_with_state(&state, &source_path.to_string_lossy()).expect("import file");

        let filter = ItemFilter {
            query: Some("quarterly".to_string()),
            ..ItemFilter::default()
        };
        let found = list_items_with_state(&state, Some(&filter)).expect("file name query");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, file_item.id);
    }

    #[test]
    fn list_items_sorts_by_whitelisted_columns() {
        let vault = TempVault::new("list-sort");
        let state = vault.state();

        let beta = save_item_with_state(&state, &note_input("Beta", "b")).expect("save beta");
        let alpha = save_item_with_state(&state, &note_input("Alpha", "a")).expect("save alpha");
        let source = save_item_with_state(&state, &source_input("A source", "https://example.com"))
            .expect("save source");

        {
            let connection = state.require_connection().expect("lock connection");
            let connection = connection.as_ref().expect("connection is initialized");

            for (id, stamp) in [
                (&beta.id, "2020-01-01T00:00:00.000Z"),
                (&alpha.id, "2021-01-01T00:00:00.000Z"),
                (&source.id, "2022-01-01T00:00:00.000Z"),
            ] {
                connection
                    .execute(
                        "UPDATE items
                         SET created_at = ?2, updated_at = ?2
                         WHERE id = ?1",
                        params![id, stamp],
                    )
                    .expect("age item");
            }
        }

        let summaries = list_items_with_state(&state, None).expect("default sort");
        assert_eq!(titles(&summaries), vec!["A source", "Alpha", "Beta"]);

        for (sort, expected) in [
            ("title", vec!["A source", "Alpha", "Beta"]),
            ("created", vec!["A source", "Alpha", "Beta"]),
        ] {
            let filter = ItemFilter {
                sort: Some(sort.to_string()),
                ..ItemFilter::default()
            };
            let summaries = list_items_with_state(&state, Some(&filter)).expect("sorted summaries");
            assert_eq!(titles(&summaries), expected, "sort {sort}");
        }

        let filter = ItemFilter {
            sort: Some("kind".to_string()),
            ..ItemFilter::default()
        };
        let summaries = list_items_with_state(&state, Some(&filter)).expect("kind sort");
        assert_eq!(summaries[0].kind, "note");
        assert_eq!(summaries[1].kind, "note");
        assert_eq!(summaries[2].kind, "source");
    }

    #[test]
    fn trashed_items_leave_lists_and_counts() {
        let vault = TempVault::new("trash-excluded");
        let state = vault.state();
        seed_collection(&state, "col-live", "Live", 0);

        let mut kept_input = note_input("Kept", "body");
        kept_input.collection_id = Some("col-live".to_string());
        let kept = save_item_with_state(&state, &kept_input).expect("save kept");

        let mut trashed_input = note_input("Trashed", "body");
        trashed_input.collection_id = Some("col-live".to_string());
        let trashed = save_item_with_state(&state, &trashed_input).expect("save trashed");

        set_item_tags_with_state(&state, &trashed.id, &["Gone".to_string()]).expect("tag trashed");

        let collections = list_collections_with_state(&state).expect("counts before trash");
        let live = collections
            .iter()
            .find(|collection| collection.id == "col-live")
            .expect("live collection");
        assert_eq!(live.item_count, 2);

        trash_items_with_state(&state, std::slice::from_ref(&trashed.id)).expect("trash item");

        let summaries = list_items_with_state(&state, None).expect("list after trash");
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, kept.id);

        let collections = list_collections_with_state(&state).expect("counts after trash");
        let live = collections
            .iter()
            .find(|collection| collection.id == "col-live")
            .expect("live collection");
        assert_eq!(live.item_count, 1);

        // A trashed item's tags leave the list entirely.
        let tags = list_tags_with_state(&state).expect("tags after trash");
        assert!(tags.is_empty());

        // The row survives with its deleted_at stamp for the Phase 4 restore.
        let loaded = load_item_with_state(&state, &trashed.id).expect("load trashed item");
        assert!(loaded.deleted_at.is_some());
        assert!(!loaded.is_pinned);
    }

    #[test]
    fn pin_round_trips_through_save_and_toggle() {
        let vault = TempVault::new("pin");
        let state = vault.state();

        let saved = save_item_with_state(&state, &note_input("Pin me", "body")).expect("save note");
        assert!(!saved.is_pinned);

        let pinned = set_item_pinned_with_state(&state, &saved.id, true).expect("pin item");
        assert!(pinned.is_pinned);

        let loaded = load_item_with_state(&state, &saved.id).expect("load pinned");
        assert!(loaded.is_pinned);

        let summaries = list_items_with_state(&state, None).expect("list pinned");
        assert!(summaries[0].is_pinned);

        let mut update = note_input("Pin me", "body");
        update.id = Some(saved.id.clone());
        update.is_pinned = Some(true);
        let updated = save_item_with_state(&state, &update).expect("save with pin");
        assert!(updated.is_pinned);

        let unpinned = set_item_pinned_with_state(&state, &saved.id, false).expect("unpin item");
        assert!(!unpinned.is_pinned);

        let error =
            set_item_pinned_with_state(&state, "missing", true).expect_err("missing item rejected");
        assert_eq!(error, "Item was not found");
    }

    #[test]
    fn batch_favorite_changes_only_listed_items() {
        let vault = TempVault::new("batch-favorite");
        let state = vault.state();

        let first = save_item_with_state(&state, &note_input("First", "body")).expect("save first");
        let second =
            save_item_with_state(&state, &note_input("Second", "body")).expect("save second");
        let third = save_item_with_state(&state, &note_input("Third", "body")).expect("save third");

        set_items_favorite_with_state(&state, &[first.id.clone(), second.id.clone()], true)
            .expect("favorite two");

        let summaries = list_items_with_state(&state, None).expect("list items");
        let favorite_ids: Vec<&str> = summaries
            .iter()
            .filter(|summary| summary.is_favorite)
            .map(|summary| summary.id.as_str())
            .collect();
        assert_eq!(favorite_ids.len(), 2);
        assert!(favorite_ids.contains(&first.id.as_str()));
        assert!(favorite_ids.contains(&second.id.as_str()));
        assert!(!favorite_ids.contains(&third.id.as_str()));

        set_items_favorite_with_state(&state, std::slice::from_ref(&second.id), false)
            .expect("unfavorite one");
        let loaded = load_item_with_state(&state, &second.id).expect("load second");
        assert!(!loaded.is_favorite);
    }

    #[test]
    fn batch_move_assigns_and_clears_collections() {
        let vault = TempVault::new("batch-move");
        let state = vault.state();
        seed_collection(&state, "col-move-a", "Alpha", 0);

        let first = save_item_with_state(&state, &note_input("First", "body")).expect("save first");
        let second =
            save_item_with_state(&state, &note_input("Second", "body")).expect("save second");

        move_items_to_collection_with_state(
            &state,
            &[first.id.clone(), second.id.clone()],
            Some("col-move-a"),
        )
        .expect("move both");

        let loaded = load_item_with_state(&state, &first.id).expect("load first");
        assert_eq!(loaded.collection_id.as_deref(), Some("col-move-a"));

        move_items_to_collection_with_state(&state, std::slice::from_ref(&first.id), None)
            .expect("clear one");
        let loaded = load_item_with_state(&state, &first.id).expect("load cleared");
        assert_eq!(loaded.collection_id, None);

        let still = load_item_with_state(&state, &second.id).expect("load second");
        assert_eq!(still.collection_id.as_deref(), Some("col-move-a"));

        let error = move_items_to_collection_with_state(
            &state,
            std::slice::from_ref(&first.id),
            Some("missing-collection"),
        )
        .expect_err("unknown collection rejected");
        assert_eq!(error, "Collection does not exist");
    }

    #[test]
    fn trash_marks_items_deleted_and_is_idempotent() {
        let vault = TempVault::new("trash");
        let state = vault.state();

        let first = save_item_with_state(&state, &note_input("First", "body")).expect("save first");
        let second =
            save_item_with_state(&state, &note_input("Second", "body")).expect("save second");

        trash_items_with_state(&state, &[first.id.clone(), second.id.clone()]).expect("trash both");

        for id in [&first.id, &second.id] {
            let loaded = load_item_with_state(&state, id).expect("load trashed");
            assert!(loaded.deleted_at.is_some());
        }

        // Trashing an already-trashed item leaves it trashed.
        trash_items_with_state(&state, std::slice::from_ref(&first.id)).expect("trash again");

        let loaded = load_item_with_state(&state, &first.id).expect("load trashed again");
        assert!(loaded.deleted_at.is_some());
    }

    #[test]
    fn collections_carry_icon_and_live_item_count() {
        let vault = TempVault::new("collection-icon");
        let state = vault.state();

        let created = save_collection_with_state(
            &state,
            &CollectionInput {
                id: None,
                name: "  Projects  ".to_string(),
                icon: Some("  folder  ".to_string()),
                protection: None,
                secret: None,
                current_secret: None,
            },
        )
        .expect("create collection");

        assert_eq!(created.name, "Projects");
        assert_eq!(created.icon.as_deref(), Some("folder"));
        assert_eq!(created.item_count, 0);

        let mut input = note_input("In project", "body");
        input.collection_id = Some(created.id.clone());
        let item = save_item_with_state(&state, &input).expect("save item in collection");

        let collections = list_collections_with_state(&state).expect("list collections");
        let stored = collections
            .iter()
            .find(|collection| collection.id == created.id)
            .expect("stored collection");
        assert_eq!(stored.item_count, 1);
        assert_eq!(stored.icon.as_deref(), Some("folder"));

        trash_items_with_state(&state, std::slice::from_ref(&item.id)).expect("trash item");
        let collections = list_collections_with_state(&state).expect("list after trash");
        let stored = collections
            .iter()
            .find(|collection| collection.id == created.id)
            .expect("stored collection");
        assert_eq!(stored.item_count, 0);
    }

    #[test]
    fn save_collection_validates_and_renames() {
        let vault = TempVault::new("save-collection");
        let state = vault.state();

        let created = save_collection_with_state(
            &state,
            &CollectionInput {
                id: None,
                name: "Projects".to_string(),
                icon: None,
                protection: None,
                secret: None,
                current_secret: None,
            },
        )
        .expect("create collection");
        assert_eq!(created.sort_order, 0);

        let second = save_collection_with_state(
            &state,
            &CollectionInput {
                id: None,
                name: "Archive".to_string(),
                icon: None,
                protection: None,
                secret: None,
                current_secret: None,
            },
        )
        .expect("create second collection");
        assert_eq!(second.sort_order, 1);

        let error = save_collection_with_state(
            &state,
            &CollectionInput {
                id: None,
                name: "   ".to_string(),
                icon: None,
                protection: None,
                secret: None,
                current_secret: None,
            },
        )
        .expect_err("blank name rejected");
        assert_eq!(error, "Collection name is required");

        let error = save_collection_with_state(
            &state,
            &CollectionInput {
                id: None,
                name: "  projects  ".to_string(),
                icon: None,
                protection: None,
                secret: None,
                current_secret: None,
            },
        )
        .expect_err("duplicate name rejected");
        assert_eq!(error, "A collection with that name already exists");

        // Renaming a collection to its own name stays valid.
        let same = save_collection_with_state(
            &state,
            &CollectionInput {
                id: Some(created.id.clone()),
                name: "Projects".to_string(),
                icon: None,
                protection: None,
                secret: None,
                current_secret: None,
            },
        )
        .expect("same name rename");
        assert_eq!(same.name, "Projects");

        let renamed = save_collection_with_state(
            &state,
            &CollectionInput {
                id: Some(created.id.clone()),
                name: "Projects renamed".to_string(),
                icon: Some("star".to_string()),
                protection: None,
                secret: None,
                current_secret: None,
            },
        )
        .expect("rename collection");
        assert_eq!(renamed.name, "Projects renamed");
        assert_eq!(renamed.icon.as_deref(), Some("star"));

        let error = save_collection_with_state(
            &state,
            &CollectionInput {
                id: Some(created.id.clone()),
                name: "archive".to_string(),
                icon: None,
                protection: None,
                secret: None,
                current_secret: None,
            },
        )
        .expect_err("duplicate rename rejected");
        assert_eq!(error, "A collection with that name already exists");

        let error = save_collection_with_state(
            &state,
            &CollectionInput {
                id: Some("missing".to_string()),
                name: "Ghost".to_string(),
                icon: None,
                protection: None,
                secret: None,
                current_secret: None,
            },
        )
        .expect_err("missing collection rejected");
        assert_eq!(error, "Collection was not found");
    }

    #[test]
    fn delete_collection_keeps_its_items() {
        let vault = TempVault::new("delete-collection");
        let state = vault.state();

        let collection = save_collection_with_state(
            &state,
            &CollectionInput {
                id: None,
                name: "Temporary".to_string(),
                icon: None,
                protection: None,
                secret: None,
                current_secret: None,
            },
        )
        .expect("create collection");

        let mut input = note_input("Kept", "body");
        input.collection_id = Some(collection.id.clone());
        let item = save_item_with_state(&state, &input).expect("save item");

        delete_collection_with_state(&state, &collection.id).expect("delete collection");

        let loaded = load_item_with_state(&state, &item.id).expect("load item after delete");
        assert_eq!(loaded.collection_id, None);
        assert_eq!(loaded.title, "Kept");

        let collections = list_collections_with_state(&state).expect("list collections");
        assert!(collections.is_empty());

        let error = delete_collection_with_state(&state, &collection.id)
            .expect_err("missing collection rejected");
        assert_eq!(error, "Collection was not found");
    }

    #[test]
    fn list_tags_counts_live_items() {
        let vault = TempVault::new("tag-counts");
        let state = vault.state();

        let first = save_item_with_state(&state, &note_input("First", "body")).expect("save first");
        let second =
            save_item_with_state(&state, &note_input("Second", "body")).expect("save second");

        set_item_tags_with_state(&state, &first.id, &["Work".to_string()]).expect("tag first");
        set_item_tags_with_state(&state, &second.id, &["Work".to_string()]).expect("tag second");

        let tags = list_tags_with_state(&state).expect("list tags");
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].name, "Work");
        assert_eq!(tags[0].count, 2);

        trash_items_with_state(&state, std::slice::from_ref(&first.id)).expect("trash first");
        let tags = list_tags_with_state(&state).expect("list tags after trash");
        assert_eq!(tags[0].count, 1);
    }

    #[test]
    fn file_items_update_metadata_but_are_never_created_through_save() {
        let vault = TempVault::new("file-save");
        let state = vault.state();
        seed_collection(&state, "col-files", "Files", 0);

        let source = vault.root.join("report.txt");
        fs::write(&source, b"hello").expect("write source file");
        let item = import_file_with_state(&state, &source.to_string_lossy()).expect("import file");

        let updated = save_item_with_state(
            &state,
            &ItemInput {
                id: Some(item.id.clone()),
                kind: "file".to_string(),
                title: "Renamed report".to_string(),
                description: "updated metadata".to_string(),
                content: Some("must not be stored".to_string()),
                url: Some("https://example.com/must-not-be-stored".to_string()),
                collection_id: Some("col-files".to_string()),
                is_favorite: Some(true),
                is_pinned: Some(true),
                duplicate_policy: None,
            },
        )
        .expect("update file metadata");

        assert_eq!(updated.kind, "file");
        assert_eq!(updated.title, "Renamed report");
        assert_eq!(updated.description, "updated metadata");
        assert_eq!(updated.collection_id.as_deref(), Some("col-files"));
        assert!(updated.is_favorite);
        assert!(updated.is_pinned);
        assert_eq!(updated.content, None, "file content stays empty");
        assert_eq!(updated.url, None, "file url stays empty");
        assert_eq!(
            updated
                .file
                .as_ref()
                .map(|file| file.original_name.as_str()),
            Some("report.txt")
        );

        let error = save_item_with_state(
            &state,
            &ItemInput {
                id: None,
                kind: "file".to_string(),
                title: "New file".to_string(),
                description: String::new(),
                content: None,
                url: None,
                collection_id: None,
                is_favorite: None,
                is_pinned: None,
                duplicate_policy: None,
            },
        )
        .expect_err("file creation rejected");
        assert_eq!(error, "File items are created by import");
    }

    #[test]
    fn trashed_filter_returns_only_trashed_rows_newest_deleted_first() {
        let vault = TempVault::new("trashed-filter");
        let state = vault.state();

        let keep = save_item_with_state(&state, &note_input("Keep", "body")).expect("save keep");
        let old = save_item_with_state(&state, &note_input("Old", "body")).expect("save old");
        let new = save_item_with_state(&state, &note_input("New", "body")).expect("save new");

        trash_items_with_state(&state, &[old.id.clone(), new.id.clone()]).expect("trash two");

        {
            let connection = state.require_connection().expect("lock connection");
            let connection = connection.as_ref().expect("connection is initialized");

            for (id, stamp) in [
                (&old.id, "2020-01-01T00:00:00.000Z"),
                (&new.id, "2021-01-01T00:00:00.000Z"),
            ] {
                connection
                    .execute(
                        "UPDATE items SET deleted_at = ?2 WHERE id = ?1",
                        params![id, stamp],
                    )
                    .expect("stamp deleted_at");
            }
        }

        let filter = ItemFilter {
            trashed: Some(true),
            ..ItemFilter::default()
        };
        let trashed = list_items_with_state(&state, Some(&filter)).expect("list trashed");
        assert_eq!(titles(&trashed), vec!["New", "Old"]);
        assert!(trashed.iter().all(|summary| summary.deleted_at.is_some()));
        assert!(!trashed.iter().any(|summary| summary.id == keep.id));

        // A sort value never overrides the deletion order for a trashed listing.
        let filter = ItemFilter {
            trashed: Some(true),
            sort: Some("title".to_string()),
            ..ItemFilter::default()
        };
        let sorted = list_items_with_state(&state, Some(&filter)).expect("trashed with sort");
        assert_eq!(titles(&sorted), vec!["New", "Old"]);

        let live = list_items_with_state(&state, None).expect("list live");
        assert_eq!(titles(&live), vec!["Keep"]);
        assert!(live[0].deleted_at.is_none());
    }

    #[test]
    fn restore_clears_deleted_at() {
        let vault = TempVault::new("restore");
        let state = vault.state();

        let item = save_item_with_state(&state, &note_input("Restore me", "body")).expect("save");
        trash_items_with_state(&state, std::slice::from_ref(&item.id)).expect("trash");

        restore_items_with_state(&state, std::slice::from_ref(&item.id)).expect("restore");
        let loaded = load_item_with_state(&state, &item.id).expect("load restored");
        assert!(loaded.deleted_at.is_none());

        // A live item and an empty list restore without error.
        restore_items_with_state(&state, std::slice::from_ref(&item.id)).expect("restore again");
        restore_items_with_state(&state, &[]).expect("restore nothing");
    }

    #[test]
    fn delete_items_permanently_removes_trashed_rows_and_bytes_only() {
        let vault = TempVault::new("permanent-delete");
        let state = vault.state();

        let doomed_source = vault.root.join("doomed.txt");
        fs::write(&doomed_source, b"doomed bytes").expect("write doomed source");
        let doomed = import_file_with_state(&state, &doomed_source.to_string_lossy())
            .expect("import doomed");
        let doomed_name = stored_name(&state, &doomed.id);

        let kept_source = vault.root.join("kept.txt");
        fs::write(&kept_source, b"kept bytes").expect("write kept source");
        let kept =
            import_file_with_state(&state, &kept_source.to_string_lossy()).expect("import kept");
        let kept_name = stored_name(&state, &kept.id);

        let note = save_item_with_state(&state, &note_input("Note", "body")).expect("save note");

        trash_items_with_state(&state, &[doomed.id.clone(), note.id.clone()]).expect("trash two");

        delete_items_permanently_with_state(
            &state,
            &[doomed.id.clone(), note.id.clone(), kept.id.clone()],
        )
        .expect("delete permanently");

        assert!(!state.files_dir().join(&doomed_name).exists());
        assert!(state.files_dir().join(&kept_name).is_file());

        {
            let connection = state.require_connection().expect("lock connection");
            let connection = connection.as_ref().expect("connection is initialized");

            let rows = |id: &str| -> i64 {
                connection
                    .query_row(
                        "SELECT COUNT(*) FROM items WHERE id = ?1",
                        params![id],
                        |row| row.get(0),
                    )
                    .expect("count items")
            };

            assert_eq!(rows(&doomed.id), 0);
            assert_eq!(rows(&note.id), 0);
            assert_eq!(rows(&kept.id), 1, "a live id is ignored");

            let file_rows: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM files WHERE item_id = ?1",
                    params![doomed.id],
                    |row| row.get(0),
                )
                .expect("count file rows");
            assert_eq!(file_rows, 0, "the file row cascades with the item");
        }

        delete_items_permanently_with_state(&state, &[]).expect("delete nothing");
    }

    #[test]
    fn search_matches_tag_names_and_collection_names() {
        let vault = TempVault::new("search-names");
        let state = vault.state();
        seed_collection(&state, "col-recipes", "Recipes", 0);

        let mut in_collection = note_input("Plain title", "body");
        in_collection.collection_id = Some("col-recipes".to_string());
        let collection_item =
            save_item_with_state(&state, &in_collection).expect("save collection item");

        let tagged = save_item_with_state(&state, &note_input("Another title", "body"))
            .expect("save tagged");
        set_item_tags_with_state(&state, &tagged.id, &["Gardening".to_string()]).expect("set tag");

        let filter = ItemFilter {
            query: Some("Recipes".to_string()),
            ..ItemFilter::default()
        };
        let by_collection = list_items_with_state(&state, Some(&filter)).expect("collection query");
        assert_eq!(by_collection.len(), 1);
        assert_eq!(by_collection[0].id, collection_item.id);

        let filter = ItemFilter {
            query: Some("Gardening".to_string()),
            ..ItemFilter::default()
        };
        let by_tag = list_items_with_state(&state, Some(&filter)).expect("tag query");
        assert_eq!(by_tag.len(), 1);
        assert_eq!(by_tag[0].id, tagged.id);
    }

    #[test]
    fn load_vault_summary_counts_and_sizes_known_rows() {
        let vault = TempVault::new("vault-summary");
        let state = vault.state();
        seed_collection(&state, "col-sum", "Summary", 0);

        let mut favorite = note_input("Favorite note", "body");
        favorite.is_favorite = Some(true);
        let favorite_item = save_item_with_state(&state, &favorite).expect("save favorite note");

        let source = save_item_with_state(&state, &source_input("Site", "https://example.com"))
            .expect("save source");

        let first_source = vault.root.join("first.bin");
        fs::write(&first_source, b"12345").expect("write first file");
        let _first_file =
            import_file_with_state(&state, &first_source.to_string_lossy()).expect("import first");

        let second_source = vault.root.join("second.bin");
        fs::write(&second_source, b"1234567890").expect("write second file");
        let second_file = import_file_with_state(&state, &second_source.to_string_lossy())
            .expect("import second");

        // One live tag and one tag on a trashed item: the live name counts once.
        set_item_tags_with_state(&state, &favorite_item.id, &["News".to_string()])
            .expect("tag note");
        set_item_tags_with_state(&state, &source.id, &["News".to_string()]).expect("tag source");

        // Trash one source and one file so live counts and disk bytes diverge.
        trash_items_with_state(&state, &[source.id.clone(), second_file.id.clone()])
            .expect("trash two");

        let summary = load_vault_summary_with_state(&state).expect("load summary");

        assert_eq!(summary.collection_count, 1);
        assert_eq!(summary.tag_count, 1);
        assert_eq!(summary.trash_count, 2);
        assert_eq!(
            summary.item_count, 2,
            "the favorite note and first file stay live"
        );
        assert_eq!(summary.note_count, 1);
        assert_eq!(summary.source_count, 0, "the only source is trashed");
        assert_eq!(summary.file_count, 1, "the only live file remains");
        assert_eq!(summary.favorite_count, 1);
        assert_eq!(
            summary.file_bytes, 15,
            "trashed file bytes still occupy disk"
        );
        assert!(summary.database_bytes > 0);
    }

    fn collection_input(name: &str) -> CollectionInput {
        CollectionInput {
            id: None,
            name: name.to_string(),
            icon: None,
            protection: None,
            secret: None,
            current_secret: None,
        }
    }

    #[test]
    fn created_collection_with_a_password_stores_a_hash_and_never_returns_it() {
        let vault = TempVault::new("collection-password");
        let state = vault.state();

        let mut input = collection_input("Private");
        input.protection = Some("password".to_string());
        input.secret = Some("hunter2".to_string());
        let created = save_collection_with_state(&state, &input).expect("create protected");

        assert_eq!(created.protection, "password");

        let stored_hash: Option<String> = {
            let connection = state.require_connection().expect("lock connection");
            connection
                .as_ref()
                .expect("connection is initialized")
                .query_row(
                    "SELECT secret_hash FROM collections WHERE id = ?1",
                    params![created.id],
                    |row| row.get(0),
                )
                .expect("read hash")
        };
        let stored_hash = stored_hash.expect("hash stored");
        assert!(stored_hash.starts_with("$argon2id$"));
        assert_ne!(stored_hash, "hunter2");
        assert!(!stored_hash.contains("hunter2"));

        // The serialized collection carries the level only; the hash never leaves
        // the vault in a listing.
        let collections = list_collections_with_state(&state).expect("list collections");
        let json = serde_json::to_string(&collections).expect("serialize collections");
        assert!(!json.contains(&stored_hash));
        assert!(!json.contains("hunter2"));
        assert!(json.contains("password"));
    }

    #[test]
    fn verify_collection_secret_accepts_the_right_secret_only() {
        let vault = TempVault::new("collection-verify");
        let state = vault.state();

        let mut input = collection_input("Locked");
        input.protection = Some("pin".to_string());
        input.secret = Some("123456".to_string());
        let locked = save_collection_with_state(&state, &input).expect("create locked");

        assert!(verify_collection_secret_with_state(&state, &locked.id, "123456").expect("verify"));
        assert!(
            !verify_collection_secret_with_state(&state, &locked.id, "999999").expect("verify")
        );

        let open =
            save_collection_with_state(&state, &collection_input("Open")).expect("create open");
        assert!(!verify_collection_secret_with_state(&state, &open.id, "123456").expect("verify"));
        assert!(!verify_collection_secret_with_state(&state, "missing", "1234").expect("verify"));
    }

    #[test]
    fn a_locked_collection_hides_its_items_until_unlocked() {
        let vault = TempVault::new("collection-enforced");
        let state = vault.state();

        let mut input = collection_input("Private");
        input.protection = Some("pin".to_string());
        input.secret = Some("123456".to_string());
        let private = save_collection_with_state(&state, &input).expect("create locked");

        let mut hidden = note_input("Hidden note", "secret body");
        hidden.collection_id = Some(private.id.clone());
        let hidden = save_item_with_state(&state, &hidden).expect("save hidden");
        let open = save_item_with_state(&state, &note_input("Open note", "body")).expect("save");

        // The creator keeps it open; an app lock closes it.
        state.clear_unlocked_collections();

        let ids = |state: &DatabaseState| -> Vec<String> {
            list_items_with_state(state, None)
                .expect("list")
                .into_iter()
                .map(|item| item.id)
                .collect()
        };
        assert_eq!(ids(&state), vec![open.id.clone()]);

        let search = ItemFilter {
            query: Some("secret".to_string()),
            ..Default::default()
        };
        assert!(list_items_with_state(&state, Some(&search)).expect("search").is_empty());

        let in_collection = ItemFilter {
            collection_id: Some(private.id.clone()),
            ..Default::default()
        };
        for error in [
            list_items_with_state(&state, Some(&in_collection)).map(|_| ()).unwrap_err(),
            load_item_with_state(&state, &hidden.id).map(|_| ()).unwrap_err(),
            list_item_versions_with_state(&state, &hidden.id).map(|_| ()).unwrap_err(),
            trash_items_with_state(&state, std::slice::from_ref(&hidden.id)).unwrap_err(),
            move_items_to_collection_with_state(&state, std::slice::from_ref(&hidden.id), None)
                .unwrap_err(),
            delete_collection_with_state(&state, &private.id).unwrap_err(),
            save_collection_with_state(
                &state,
                &CollectionInput {
                    id: Some(private.id.clone()),
                    name: "Private".to_string(),
                    icon: None,
                    protection: Some("none".to_string()),
                    secret: None,
                    current_secret: None,
                },
            )
            .map(|_| ())
            .unwrap_err(),
        ] {
            // Removing the lock is refused for the missing current password
            // before the locked check; either refusal keeps it protected.
            assert!(
                error == crate::database::COLLECTION_LOCKED || error == CURRENT_SECRET_WRONG,
                "{error}"
            );
        }

        // Moving a loose item in reads nothing, so it is allowed while locked.
        move_items_to_collection_with_state(
            &state,
            std::slice::from_ref(&open.id),
            Some(&private.id),
        )
        .expect("move into locked collection");
        assert!(ids(&state).is_empty());

        assert!(!verify_collection_secret_with_state(&state, &private.id, "000000").unwrap());
        assert!(load_item_with_state(&state, &hidden.id).is_err());

        assert!(verify_collection_secret_with_state(&state, &private.id, "123456").unwrap());
        assert_eq!(ids(&state).len(), 2);
        assert_eq!(
            load_item_with_state(&state, &hidden.id).expect("open after unlock").content,
            Some("secret body".to_string())
        );

        state.clear_unlocked_collections();
        assert!(ids(&state).is_empty());
    }

    #[test]
    fn rename_without_protection_keeps_the_stored_hash() {
        let vault = TempVault::new("collection-keep-hash");
        let state = vault.state();

        let mut input = collection_input("Kept");
        input.protection = Some("password".to_string());
        input.secret = Some("secret-pass".to_string());
        let created = save_collection_with_state(&state, &input).expect("create protected");

        let renamed = save_collection_with_state(
            &state,
            &CollectionInput {
                id: Some(created.id.clone()),
                name: "Kept renamed".to_string(),
                icon: None,
                protection: None,
                secret: None,
                current_secret: None,
            },
        )
        .expect("rename");

        assert_eq!(renamed.name, "Kept renamed");
        assert_eq!(renamed.protection, "password");
        assert!(
            verify_collection_secret_with_state(&state, &created.id, "secret-pass")
                .expect("verify")
        );
    }

    #[test]
    fn clearing_protection_removes_the_hash() {
        let vault = TempVault::new("collection-clear");
        let state = vault.state();

        let mut input = collection_input("Clear me");
        input.protection = Some("password".to_string());
        input.secret = Some("secret-pass".to_string());
        let created = save_collection_with_state(&state, &input).expect("create protected");
        // Locked again, as after an app lock: the right password alone is enough.
        state.clear_unlocked_collections();

        // Unlocked is not enough: removing the lock needs the present password.
        for wrong in [None, Some("guess".to_string())] {
            let error = save_collection_with_state(
                &state,
                &CollectionInput {
                    id: Some(created.id.clone()),
                    name: "Clear me".to_string(),
                    icon: None,
                    protection: Some("none".to_string()),
                    secret: None,
                    current_secret: wrong,
                },
            )
            .unwrap_err();
            assert_eq!(error, CURRENT_SECRET_WRONG);
        }

        let cleared = save_collection_with_state(
            &state,
            &CollectionInput {
                id: Some(created.id.clone()),
                name: "Clear me".to_string(),
                icon: None,
                protection: Some("none".to_string()),
                secret: None,
                current_secret: Some("secret-pass".to_string()),
            },
        )
        .expect("clear protection");

        assert_eq!(cleared.protection, "none");

        {
            let connection = state.require_connection().expect("lock connection");
            let hash: Option<String> = connection
                .as_ref()
                .expect("connection is initialized")
                .query_row(
                    "SELECT secret_hash FROM collections WHERE id = ?1",
                    params![created.id],
                    |row| row.get(0),
                )
                .expect("read hash");
            assert_eq!(hash, None);
        }

        assert!(
            !verify_collection_secret_with_state(&state, &created.id, "secret-pass")
                .expect("verify")
        );
    }

    #[test]
    fn protection_validation_messages_are_stable() {
        let vault = TempVault::new("collection-protection-validation");
        let state = vault.state();

        let mut unknown = collection_input("Odd");
        unknown.protection = Some("biometric".to_string());
        let error = save_collection_with_state(&state, &unknown).expect_err("unknown rejected");
        assert_eq!(error, "Collection protection is not supported");

        let mut short = collection_input("Short");
        short.protection = Some("password".to_string());
        short.secret = Some("abc".to_string());
        let error = save_collection_with_state(&state, &short).expect_err("short password");
        assert_eq!(error, "Password must be at least 4 characters");

        for bad_pin in ["123", "12345", "1234567", "12a456", ""] {
            let mut bad = collection_input("Bad pin");
            bad.name = format!("Bad pin {bad_pin}");
            bad.protection = Some("pin".to_string());
            bad.secret = Some(bad_pin.to_string());
            let error = save_collection_with_state(&state, &bad).expect_err("bad pin rejected");
            assert_eq!(error, "PIN must be 6 digits");
        }

        // Nothing is written when validation fails.
        let collections = list_collections_with_state(&state).expect("list collections");
        assert!(collections.is_empty());
    }

    fn enable_content_encryption(state: &DatabaseState, password: &str) -> [u8; 32] {
        let key = {
            let mut connection = state.require_connection().expect("lock connection");
            let connection = connection.as_mut().expect("connection is initialized");
            crate::database::write_password_verifier(
                connection,
                &crate::security::hash_secret(password).expect("hash password"),
            )
            .expect("store password verifier");
            encryption::enable(connection, state.files_dir(), password).expect("enable encryption")
        };
        state.content_key().store(key).expect("store content key");
        key
    }

    #[test]
    fn names_are_sealed_while_encrypted_and_still_searchable() {
        let vault = TempVault::new("sealed-names");
        let state = vault.state();

        // Made before encryption, so enabling must seal them.
        let before = save_collection_with_state(&state, &collection_input("Travel plans"))
            .expect("create collection");
        let mut early = note_input("Zebra passport", "body");
        early.collection_id = Some(before.id.clone());
        let early = save_item_with_state(&state, &early).expect("save early note");
        set_item_tags_with_state(&state, &early.id, &["Visa".to_string()]).expect("tag early");
        let mut changed = note_input("Zebra passport", "new body");
        changed.id = Some(early.id.clone());
        changed.collection_id = Some(before.id.clone());
        save_item_with_state(&state, &changed).expect("make a version");

        enable_content_encryption(&state, "master-pass");

        // Made while encrypted.
        let late = save_item_with_state(&state, &note_input("Apple budget", "body"))
            .expect("save late note");
        set_item_tags_with_state(&state, &late.id, &["Money".to_string()]).expect("tag late");

        {
            let connection = state.require_connection().expect("lock connection");
            let connection = connection.as_ref().expect("connection is initialized");
            let readable: String = connection
                .query_row(
                    "SELECT (SELECT group_concat(title || tags, '|') FROM items)
                         || (SELECT group_concat(name, '|') FROM collections)
                         || COALESCE((SELECT group_concat(title, '|') FROM item_versions), '')",
                    [],
                    |row| row.get(0),
                )
                .expect("read raw names");
            for plain in ["Zebra", "Apple", "Visa", "Money", "Travel"] {
                assert!(!readable.contains(plain), "{plain} is stored readable: {readable}");
            }
        }

        // Everything still reads back and filters on the decrypted values.
        assert_eq!(load_item_with_state(&state, &early.id).unwrap().title, "Zebra passport");
        assert_eq!(load_item_with_state(&state, &late.id).unwrap().tags, vec!["Money"]);
        let collections = list_collections_with_state(&state).expect("list collections");
        assert_eq!(collections[0].name, "Travel plans");

        let sorted = list_items_with_state(
            &state,
            Some(&ItemFilter {
                sort: Some("title".to_string()),
                ..Default::default()
            }),
        )
        .expect("sort by title");
        assert_eq!(titles(&sorted), vec!["Apple budget", "Zebra passport"]);

        for (query, expected) in [("zebra", "Zebra passport"), ("travel", "Zebra passport"), ("money", "Apple budget")] {
            let found = list_items_with_state(
                &state,
                Some(&ItemFilter {
                    query: Some(query.to_string()),
                    ..Default::default()
                }),
            )
            .expect("search");
            assert_eq!(titles(&found), vec![expected], "query {query}");
        }
        let tagged = list_items_with_state(
            &state,
            Some(&ItemFilter {
                tag: Some("visa".to_string()),
                ..Default::default()
            }),
        )
        .expect("tag filter");
        assert_eq!(titles(&tagged), vec!["Zebra passport"]);

        let tags = list_tags_with_state(&state).expect("list tags");
        assert_eq!(
            tags.iter().map(|tag| tag.name.as_str()).collect::<Vec<_>>(),
            vec!["Money", "Visa"]
        );
        let versions = list_item_versions_with_state(&state, &early.id).expect("versions");
        assert_eq!(versions[0].title, "Zebra passport");

        // A duplicate name is still refused while names are sealed.
        assert_eq!(
            save_collection_with_state(&state, &collection_input("travel plans")).unwrap_err(),
            "A collection with that name already exists"
        );

        // Turning encryption off puts every name back in its column.
        {
            let mut connection = state.require_connection().expect("lock connection");
            let connection = connection.as_mut().expect("connection is initialized");
            encryption::disable(connection, state.files_dir(), "master-pass").expect("disable");
        }
        state.content_key().clear().expect("clear key");
        let connection = state.require_connection().expect("lock connection");
        let connection = connection.as_ref().expect("connection is initialized");
        let (title, tags): (String, String) = connection
            .query_row(
                "SELECT title, tags FROM items WHERE id = ?1",
                params![early.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read restored item");
        assert_eq!((title.as_str(), tags.as_str()), ("Zebra passport", "[\"Visa\"]"));
        let name: String = connection
            .query_row(
                "SELECT name FROM collections WHERE id = ?1",
                params![before.id],
                |row| row.get(0),
            )
            .expect("read restored collection");
        assert_eq!(name, "Travel plans");
    }

    #[test]
    fn encrypted_note_round_trips_without_plaintext_at_rest() {
        let vault = TempVault::new("encrypt-round-trip");
        let state = vault.state();
        enable_content_encryption(&state, "master-pass");

        let mut input = note_input("Secret title", "secret body");
        input.description = "private description".to_string();
        let saved = save_item_with_state(&state, &input).expect("save encrypted note");
        assert_eq!(saved.description, "private description");
        assert_eq!(saved.content.as_deref(), Some("secret body"));

        let loaded = load_item_with_state(&state, &saved.id).expect("load encrypted note");
        assert_eq!(loaded.description, "private description");
        assert_eq!(loaded.content.as_deref(), Some("secret body"));

        {
            let connection = state.require_connection().expect("lock connection");
            let connection = connection.as_ref().expect("connection is initialized");
            let (description, content, url): (String, Option<String>, Option<String>) = connection
                .query_row(
                    "SELECT description, content, url FROM items WHERE id = ?1",
                    params![saved.id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .expect("read stored item");
            assert_eq!(
                description, "",
                "the plaintext description column stays blank"
            );
            assert!(content.is_none());
            assert!(url.is_none());

            let secrets: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM item_secrets WHERE item_id = ?1",
                    params![saved.id],
                    |row| row.get(0),
                )
                .expect("count secrets");
            assert_eq!(secrets, 1);

            let search: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM item_search WHERE item_id = ?1",
                    params![saved.id],
                    |row| row.get(0),
                )
                .expect("count search rows");
            assert_eq!(search, 0, "protected content never reaches the index");

            let (needs_index, status): (i64, String) = connection
                .query_row(
                    "SELECT needs_index, status FROM index_state WHERE item_id = ?1",
                    params![saved.id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .expect("read index state");
            assert_eq!(needs_index, 1);
            assert_eq!(status, "pending");
        }
    }

    #[test]
    fn encrypted_reads_without_the_key_report_locked() {
        let vault = TempVault::new("encrypt-locked");
        let state = vault.state();
        enable_content_encryption(&state, "master-pass");
        let saved = save_item_with_state(&state, &note_input("Locked", "body")).expect("save note");
        state.content_key().clear().expect("drop key");

        assert_eq!(
            load_item_with_state(&state, &saved.id).expect_err("load while locked"),
            "Vault is locked"
        );
        assert_eq!(
            list_items_with_state(&state, None).expect_err("list while locked"),
            "Vault is locked"
        );
        assert_eq!(
            save_item_with_state(&state, &note_input("Another", "body"))
                .expect_err("save while locked"),
            "Vault is locked"
        );
    }

    #[test]
    fn encrypted_list_items_decrypts_summary_content() {
        let vault = TempVault::new("encrypt-list");
        let state = vault.state();
        enable_content_encryption(&state, "master-pass");
        let saved =
            save_item_with_state(&state, &note_input("Listed", "preview body")).expect("save note");

        let summaries = list_items_with_state(&state, None).expect("list items");
        let summary = summaries
            .iter()
            .find(|summary| summary.id == saved.id)
            .expect("summary present");
        assert_eq!(summary.content.as_deref(), Some("preview body"));
    }

    #[test]
    fn encrypted_versions_store_ciphertext_and_restore_plaintext() {
        let vault = TempVault::new("encrypt-versions");
        let state = vault.state();
        let key = enable_content_encryption(&state, "master-pass");
        let saved =
            save_item_with_state(&state, &note_input("First", "first body")).expect("create note");
        let mut edit = note_input("Second", "second body");
        edit.id = Some(saved.id.clone());
        save_item_with_state(&state, &edit).expect("edit note");

        {
            let connection = state.require_connection().expect("lock connection");
            let connection = connection.as_ref().expect("connection is initialized");
            let (version_id, content, encrypted): (String, String, Option<Vec<u8>>) = connection
                .query_row(
                    "SELECT id, content, encrypted_content FROM item_versions WHERE item_id = ?1",
                    params![saved.id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .expect("read version");
            assert_eq!(content, "", "the plaintext version column stays blank");
            let encrypted = encrypted.expect("version stored encrypted");
            assert!(!encrypted
                .windows("first body".len())
                .any(|window| window == b"first body"));
            assert_eq!(
                encryption::decrypt_version(&key, &version_id, &encrypted)
                    .expect("decrypt version"),
                "first body"
            );
        }

        let versions = list_item_versions_with_state(&state, &saved.id).expect("list versions");
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].content, "first body");

        let restored = restore_item_version_with_state(&state, &versions[0].id).expect("restore");
        assert_eq!(restored.content.as_deref(), Some("first body"));
        let versions = list_item_versions_with_state(&state, &saved.id).expect("versions after");
        assert!(versions
            .iter()
            .any(|version| version.content == "second body"));
    }

    #[test]
    fn a_protected_value_only_reads_under_its_own_item_id() {
        let vault = TempVault::new("encrypt-binding");
        let state = vault.state();
        let key = enable_content_encryption(&state, "master-pass");
        let first = save_item_with_state(&state, &note_input("One", "body one")).expect("first");
        let second = save_item_with_state(&state, &note_input("Two", "body two")).expect("second");

        {
            let connection = state.require_connection().expect("lock connection");
            let connection = connection.as_ref().expect("connection is initialized");
            let (nonce, ciphertext): (Vec<u8>, Vec<u8>) = connection
                .query_row(
                    "SELECT nonce, ciphertext FROM item_secrets WHERE item_id = ?1",
                    params![first.id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .expect("read first secret");
            // The same ciphertext cannot be read under another item id.
            connection
                .execute(
                    "UPDATE item_secrets SET nonce = ?2, ciphertext = ?3 WHERE item_id = ?1",
                    params![second.id, nonce, ciphertext],
                )
                .expect("move ciphertext");
            assert!(encryption::read_secret(connection, &key, &second.id).is_err());
        }
    }

    #[test]
    fn encrypted_file_import_stores_ciphertext_and_previews_plaintext() {
        let vault = TempVault::new("encrypt-file");
        let state = vault.state();
        enable_content_encryption(&state, "master-pass");
        let source = vault.root.join("secret.txt");
        fs::write(&source, b"private bytes").expect("write source");
        let item = import_file_with_state(&state, &source.to_string_lossy()).expect("import");

        let name = stored_name(&state, &item.id);
        let stored = fs::read(state.files_dir().join(&name)).expect("read stored bytes");
        assert!(
            !stored
                .windows(b"private bytes".len())
                .any(|window| window == b"private bytes"),
            "the managed file holds no plaintext"
        );
        {
            let connection = state.require_connection().expect("lock connection");
            let encrypted: i64 = connection
                .as_ref()
                .expect("connection is initialized")
                .query_row(
                    "SELECT encrypted FROM files WHERE item_id = ?1",
                    params![item.id],
                    |row| row.get(0),
                )
                .expect("read encrypted flag");
            assert_eq!(encrypted, 1);
        }

        let preview = read_item_file_with_state(&state, &item.id).expect("preview");
        assert_eq!(preview.preview, "text");
        assert_eq!(preview.text.as_deref(), Some("private bytes"));
        assert_eq!(preview.byte_size, 13);

        state.content_key().clear().expect("drop key");
        assert_eq!(
            read_item_file_with_state(&state, &item.id).expect_err("preview while locked"),
            "Vault is locked"
        );
    }

    #[test]
    fn disabling_encryption_restores_plaintext_reads() {
        let vault = TempVault::new("encrypt-disable");
        let state = vault.state();
        enable_content_encryption(&state, "master-pass");
        let saved = save_item_with_state(&state, &note_input("Disable", "disable body"))
            .expect("save note");

        {
            let mut connection = state.require_connection().expect("lock connection");
            encryption::disable(
                connection.as_mut().expect("connection is initialized"),
                state.files_dir(),
                "master-pass",
            )
            .expect("disable encryption");
        }
        state.content_key().clear().expect("drop key");

        let loaded = load_item_with_state(&state, &saved.id).expect("load plaintext note");
        assert_eq!(loaded.content.as_deref(), Some("disable body"));

        let connection = state.require_connection().expect("lock connection");
        let content: Option<String> = connection
            .as_ref()
            .expect("connection is initialized")
            .query_row(
                "SELECT content FROM items WHERE id = ?1",
                params![saved.id],
                |row| row.get(0),
            )
            .expect("read content column");
        assert_eq!(content.as_deref(), Some("disable body"));
    }

    // ---- T24 phase 3: duplicate detection before capture ----

    fn item_count(state: &DatabaseState) -> i64 {
        state
            .require_connection()
            .expect("lock connection")
            .as_ref()
            .expect("connection")
            .query_row("SELECT COUNT(*) FROM items", [], |row| row.get(0))
            .expect("count items")
    }

    fn write_source_file(vault: &TempVault, name: &str, bytes: &[u8]) -> String {
        let dir = vault.root.join("picked");
        fs::create_dir_all(&dir).expect("create picked folder");
        let path = dir.join(name);
        fs::write(&path, bytes).expect("write picked file");
        path.to_string_lossy().into_owned()
    }

    fn duplicate_ids(outcome: &CaptureOutcome) -> Vec<String> {
        match outcome {
            CaptureOutcome::Duplicate { matches, .. } => {
                matches.iter().map(|found| found.item.id.clone()).collect()
            }
            CaptureOutcome::Saved { .. } => Vec::new(),
        }
    }

    fn saved_item(outcome: CaptureOutcome) -> Item {
        match outcome {
            CaptureOutcome::Saved { item } => item,
            CaptureOutcome::Duplicate { .. } => panic!("expected a save, got a duplicate"),
        }
    }

    fn import_checked(state: &DatabaseState, path: &str) -> CaptureOutcome {
        let preview = preview_file_import_with_state(state, path).expect("preview");
        commit_file_import_with_state(state, &preview.token, None, None).expect("commit")
    }

    #[test]
    fn t24_repeated_source_address_is_caught_before_saving() {
        let vault = TempVault::new("dup-source");
        let state = vault.state();
        let first = save_item_with_state(&state, &source_input("First", "https://Example.com/a"))
            .expect("save first");

        let outcome = capture_item_with_state(&state, &source_input("Again", "https://example.com:443/a"))
            .expect("capture");
        assert_eq!(duplicate_ids(&outcome), vec![first.id.clone()]);
        if let CaptureOutcome::Duplicate { matches, .. } = &outcome {
            assert_eq!(matches[0].reason, "url");
            assert_eq!(matches[0].item.title, "First");
        }
        assert_eq!(item_count(&state), 1, "a duplicate saves nothing");

        // Different query, path case, or scheme is a different page.
        for other in ["https://example.com/A", "https://example.com/a?x=1", "http://example.com/a"] {
            saved_item(capture_item_with_state(&state, &source_input("Other", other)).expect("capture"));
        }

        let mut keep = source_input("Both", "https://example.com/a");
        keep.duplicate_policy = Some("keepBoth".to_string());
        saved_item(capture_item_with_state(&state, &keep).expect("keep both"));
        assert_eq!(item_count(&state), 5);

        let mut unknown = source_input("Bad", "https://new.example.com");
        unknown.duplicate_policy = Some("merge".to_string());
        assert!(capture_item_with_state(&state, &unknown).is_err());
    }

    #[test]
    fn t24_source_edits_skip_themselves_but_not_other_sources() {
        let vault = TempVault::new("dup-edit");
        let state = vault.state();
        let one = save_item_with_state(&state, &source_input("One", "https://one.example.com"))
            .expect("save one");
        let two = save_item_with_state(&state, &source_input("Two", "https://two.example.com"))
            .expect("save two");

        let mut rename = source_input("One renamed", "https://one.example.com");
        rename.id = Some(one.id.clone());
        saved_item(capture_item_with_state(&state, &rename).expect("rename keeps own url"));

        let mut collide = source_input("One", "https://two.example.com");
        collide.id = Some(one.id.clone());
        assert_eq!(
            duplicate_ids(&capture_item_with_state(&state, &collide).expect("capture")),
            vec![two.id.clone()]
        );
        assert_eq!(
            load_item_with_state(&state, &one.id).expect("load").url.as_deref(),
            Some("https://one.example.com"),
            "the refused edit changed nothing"
        );
    }

    #[test]
    fn t24_trash_and_locked_collections_reveal_no_matches() {
        let vault = TempVault::new("dup-hidden");
        let state = vault.state();
        let trashed = save_item_with_state(&state, &source_input("Old", "https://trash.example.com"))
            .expect("save");
        trash_items_with_state(&state, &[trashed.id.clone()]).expect("trash");

        let mut input = collection_input("Private");
        input.protection = Some("pin".to_string());
        input.secret = Some("123456".to_string());
        let private = save_collection_with_state(&state, &input).expect("create locked");
        let mut hidden = source_input("Hidden", "https://hidden.example.com");
        hidden.collection_id = Some(private.id.clone());
        save_item_with_state(&state, &hidden).expect("save hidden");
        let hidden_file = write_source_file(&vault, "secret.txt", b"hidden bytes");
        let preview = preview_file_import_with_state(&state, &hidden_file).expect("preview");
        commit_file_import_with_state(&state, &preview.token, Some(&private.id), None).expect("commit");
        state.lock_collection(&private.id);

        for url in ["https://trash.example.com", "https://hidden.example.com"] {
            saved_item(capture_item_with_state(&state, &source_input("New", url)).expect("capture"));
        }
        let again = write_source_file(&vault, "copy.txt", b"hidden bytes");
        let preview = preview_file_import_with_state(&state, &again).expect("preview");
        assert!(preview.matches.is_empty(), "a locked file is not revealed");

        // Saving into a locked collection is refused at commit.
        let other = write_source_file(&vault, "other.txt", b"other bytes");
        let preview = preview_file_import_with_state(&state, &other).expect("preview");
        assert!(commit_file_import_with_state(&state, &preview.token, Some(&private.id), Some("keepBoth")).is_err());
    }

    #[test]
    fn t24_file_contents_not_names_decide_duplicates() {
        let vault = TempVault::new("dup-file");
        let state = vault.state();
        let original = saved_item(import_checked(&state, &write_source_file(&vault, "report.pdf", b"same bytes")));

        let renamed = write_source_file(&vault, "renamed.bin", b"same bytes");
        let preview = preview_file_import_with_state(&state, &renamed).expect("preview");
        assert_eq!(preview.byte_size, 10);
        assert_eq!(preview.matches.len(), 1);
        assert_eq!(preview.matches[0].item.id, original.id);
        assert_eq!(preview.matches[0].reason, "file-content");
        assert_eq!(item_count(&state), 1, "preview saves nothing");

        // A conflict keeps the staged copy for the decision, then Keep both saves one item.
        let outcome = commit_file_import_with_state(&state, &preview.token, None, None).expect("commit");
        assert_eq!(duplicate_ids(&outcome), vec![original.id.clone()]);
        assert_eq!(item_count(&state), 1);
        let kept = saved_item(
            commit_file_import_with_state(&state, &preview.token, None, Some("keepBoth")).expect("keep both"),
        );
        assert_eq!(item_count(&state), 2);
        assert_eq!(kept.file.expect("file details").original_name, "renamed.bin");

        // Same name, different bytes: no match.
        let different = write_source_file(&vault, "report.pdf", b"other byte");
        assert!(preview_file_import_with_state(&state, &different).expect("preview").matches.is_empty());
    }

    #[test]
    fn t24_staged_copy_is_what_gets_saved_and_skip_leaves_nothing() {
        let vault = TempVault::new("dup-staged");
        let state = vault.state();
        let path = write_source_file(&vault, "note.txt", b"checked bytes");
        let preview = preview_file_import_with_state(&state, &path).expect("preview");
        fs::write(&path, b"changed after the check").expect("change original");

        let item = saved_item(commit_file_import_with_state(&state, &preview.token, None, None).expect("commit"));
        let stored = fs::read(state.files_dir().join(
            state
                .require_connection()
                .unwrap()
                .as_ref()
                .unwrap()
                .query_row("SELECT stored_name FROM files WHERE item_id = ?1", params![item.id], |row| {
                    row.get::<_, String>(0)
                })
                .unwrap(),
        ))
        .expect("read managed file");
        assert_eq!(stored, b"checked bytes");
        assert!(commit_file_import_with_state(&state, &preview.token, None, None).is_err(), "a token is used once");

        // Skip: cancel drops the staged copy and saves nothing.
        let skip = preview_file_import_with_state(&state, &write_source_file(&vault, "skip.txt", b"skip me"))
            .expect("preview");
        cancel_file_import_with_state(&state, &skip.token).expect("cancel");
        assert!(commit_file_import_with_state(&state, &skip.token, None, None).is_err());
        assert_eq!(item_count(&state), 1);
        assert_eq!(fs::read_dir(state.staging_dir()).map(|dir| dir.count()).unwrap_or(0), 0);
    }

    #[test]
    fn t24_lock_or_restore_invalidates_a_staged_file() {
        let vault = TempVault::new("dup-stale");
        let state = vault.state();
        let preview = preview_file_import_with_state(&state, &write_source_file(&vault, "a.txt", b"stale"))
            .expect("preview");
        state.advance_session();

        assert!(commit_file_import_with_state(&state, &preview.token, None, Some("keepBoth")).is_err());
        assert_eq!(item_count(&state), 0);
        assert_eq!(fs::read_dir(state.staging_dir()).map(|dir| dir.count()).unwrap_or(0), 0);
    }

    #[test]
    fn t24_older_files_get_fingerprints_when_first_checked() {
        let vault = TempVault::new("dup-backfill");
        let state = vault.state();
        let first = saved_item(import_checked(&state, &write_source_file(&vault, "old.txt", b"legacy bytes")));
        state
            .require_connection()
            .unwrap()
            .as_ref()
            .unwrap()
            .execute("UPDATE files SET content_digest = NULL", [])
            .unwrap();

        let preview = preview_file_import_with_state(&state, &write_source_file(&vault, "new.txt", b"legacy bytes"))
            .expect("preview");
        assert_eq!(preview.matches[0].item.id, first.id);
        let digest: Vec<u8> = state
            .require_connection()
            .unwrap()
            .as_ref()
            .unwrap()
            .query_row("SELECT content_digest FROM files WHERE item_id = ?1", params![first.id], |row| row.get(0))
            .unwrap();
        assert_eq!(digest, duplicates::hash_bytes(b"legacy bytes").to_vec());
    }

    #[test]
    fn t24_encrypted_fingerprints_stay_ciphertext_and_survive_toggling() {
        let vault = TempVault::new("dup-encrypted");
        let state = vault.state();
        let plain = saved_item(import_checked(&state, &write_source_file(&vault, "plain.txt", b"secret bytes")));
        enable_content_encryption(&state, "master-pass");

        let digest_of = |id: &str| -> Vec<u8> {
            state
                .require_connection()
                .unwrap()
                .as_ref()
                .unwrap()
                .query_row("SELECT content_digest FROM files WHERE item_id = ?1", params![id], |row| row.get(0))
                .unwrap()
        };
        let raw = duplicates::hash_bytes(b"secret bytes").to_vec();
        assert_ne!(digest_of(&plain.id), raw, "enabling encryption seals the old digest");

        // Encrypted imports stage no plaintext and still match the plain-era file.
        let preview = preview_file_import_with_state(&state, &write_source_file(&vault, "again.txt", b"secret bytes"))
            .expect("preview");
        let staged = fs::read(state.staging_dir().join(&preview.token)).expect("staged copy");
        assert!(!staged.windows(12).any(|part| part == b"secret bytes"), "staged copy is sealed");
        assert_eq!(preview.matches.len(), 1);
        let encrypted = saved_item(
            commit_file_import_with_state(&state, &preview.token, None, Some("keepBoth")).expect("keep both"),
        );
        assert_ne!(digest_of(&encrypted.id), raw);
        assert_eq!(
            duplicate_ids(&import_checked(&state, &write_source_file(&vault, "third.txt", b"secret bytes"))).len(),
            2
        );

        {
            let mut connection = state.require_connection().unwrap();
            encryption::disable(connection.as_mut().unwrap(), state.files_dir(), "master-pass").expect("disable");
        }
        state.content_key().clear().unwrap();
        assert_eq!(digest_of(&plain.id), raw);
        assert_eq!(digest_of(&encrypted.id), raw);
    }
}

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::database::DatabaseState;
use crate::encryption::{self, ContentKeyState};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileRecord {
    pub stored_name: String,
    pub original_name: String,
    pub byte_size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableItem {
    pub kind: String,
    pub title: String,
    pub description: String,
    pub content: Option<String>,
    pub url: Option<String>,
    pub collection: Option<String>,
    pub tags: Vec<String>,
    pub is_favorite: bool,
    pub is_pinned: bool,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub file: Option<FileRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CollectionRecord {
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VaultDocument {
    pub format: u32,
    pub collections: Vec<CollectionRecord>,
    pub items: Vec<PortableItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedItem {
    pub title: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct ImportReport {
    pub imported: usize,
    pub skipped: Vec<SkippedItem>,
    pub losses: Vec<String>,
}

fn supported(item: &PortableItem) -> Result<(), &'static str> {
    match item.kind.as_str() {
        "note" if item.file.is_none() => Ok(()),
        "source" if item.file.is_none() => Ok(()),
        "file" if item.file.is_some() => Ok(()),
        "note" | "source" => Err("This item type cannot contain a managed file"),
        "file" => Err("File item has no managed file reference"),
        _ => Err("Unsupported item type; credentials and passwords are excluded"),
    }
}

fn filter_items(document: &mut VaultDocument) -> ImportReport {
    let mut report = ImportReport::default();
    document.items.retain(|item| match supported(item) {
        Ok(()) => true,
        Err(reason) => {
            report.skipped.push(SkippedItem {
                title: item.title.clone(),
                reason: reason.into(),
            });
            false
        }
    });
    report
}

/// Only known item fields are serialized. No credential or password table is part of this format.
pub fn encode_json_with_report(document: &VaultDocument) -> Result<(String, ImportReport), String> {
    if document.format != 1 {
        return Err("Unsupported Kivo JSON format".into());
    }
    let mut document = document.clone();
    let mut report = filter_items(&mut document);
    report.losses.push("JSON does not include credentials, passwords, note version history, or collection icons and protection".into());
    report
        .losses
        .push("Managed file bytes live in the adjacent files/ folder, not inside JSON".into());
    Ok((
        serde_json::to_string_pretty(&document).map_err(|error| error.to_string())?,
        report,
    ))
}

#[allow(dead_code)]
pub fn encode_json(document: &VaultDocument) -> Result<String, String> {
    encode_json_with_report(document).map(|(json, _)| json)
}

/// Returns portable records, not persisted rows. The caller must assign fresh IDs on insert.
pub fn decode_json(input: &str) -> Result<(VaultDocument, ImportReport), String> {
    let mut document: VaultDocument =
        serde_json::from_str(input).map_err(|error| format!("Invalid Kivo JSON: {error}"))?;
    if document.format != 1 {
        return Err("Unsupported Kivo JSON format".into());
    }
    let report = filter_items(&mut document);
    Ok((document, report))
}

fn plain_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.ends_with(['.', ' '])
        && !name.chars().any(|c| {
            c.is_control() || matches!(c, '/' | '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*')
        })
        && !matches!(
            name.split('.')
                .next()
                .unwrap_or("")
                .to_ascii_uppercase()
                .as_str(),
            "CON"
                | "PRN"
                | "AUX"
                | "NUL"
                | "COM1"
                | "COM2"
                | "COM3"
                | "COM4"
                | "COM5"
                | "COM6"
                | "COM7"
                | "COM8"
                | "COM9"
                | "LPT1"
                | "LPT2"
                | "LPT3"
                | "LPT4"
                | "LPT5"
                | "LPT6"
                | "LPT7"
                | "LPT8"
                | "LPT9"
        )
}

fn file_ref_problem(
    file: &FileRecord,
    root: &Path,
    directory_ok: bool,
    seen: &mut HashSet<String>,
) -> Option<&'static str> {
    if !plain_name(&file.stored_name) {
        return Some("Unsafe managed file name");
    }
    if !seen.insert(file.stored_name.to_ascii_lowercase()) {
        return Some("Duplicate managed file name");
    }
    if !directory_ok {
        return Some("Missing or unsafe files directory");
    }
    let path = root.join("files").join(&file.stored_name);
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.file_type().is_file() => {
            Some("Managed file is not a regular file")
        }
        Ok(metadata) if metadata.len() != file.byte_size => {
            Some("Managed file size does not match JSON")
        }
        Ok(_) => None,
        Err(_) => Some("Managed file is missing or unreadable"),
    }
}

/// Validate paths before copying bytes. root/files must be a real directory, not a link.
/// Call immediately before each copy too, since filesystem contents can change after validation.
#[allow(dead_code)]
pub fn validate_file_refs(document: &VaultDocument, root: &Path) -> ImportReport {
    let mut report = ImportReport::default();
    let directory_ok =
        fs::symlink_metadata(root.join("files")).is_ok_and(|m| m.file_type().is_dir());
    let mut seen = HashSet::new();
    for item in &document.items {
        let Some(file) = &item.file else { continue };
        if let Some(reason) = file_ref_problem(file, root, directory_ok, &mut seen) {
            report.skipped.push(SkippedItem {
                title: item.title.clone(),
                reason: reason.into(),
            });
        }
    }
    report
}

const MARKDOWN_LOSSES: &[&str] = &[
    "Exact timestamps are not preserved on Markdown import",
    "Managed file bytes are not included in Markdown",
    "Rich formatting outside Markdown is not preserved",
];

/// Export note front matter with JSON-escaped scalar values (valid YAML double-quoted scalars).
pub fn export_markdown(item: &PortableItem) -> Result<(String, Vec<String>), String> {
    if item.kind != "note" {
        return Err("Only notes can be exported as Markdown".into());
    }
    let quoted = |value: &str| serde_json::to_string(value).map_err(|e| e.to_string());
    let mut text = format!(
        "---\ntitle: {}\ndescription: {}\n",
        quoted(&item.title)?,
        quoted(&item.description)?
    );
    if let Some(collection) = &item.collection {
        text.push_str(&format!("collection: {}\n", quoted(collection)?));
    }
    text.push_str(&format!(
        "tags: {}\n",
        serde_json::to_string(&item.tags).map_err(|e| e.to_string())?
    ));
    text.push_str(&format!(
        "isFavorite: {}\nisPinned: {}\n---\n",
        item.is_favorite, item.is_pinned
    ));
    text.push_str(item.content.as_deref().unwrap_or(""));
    Ok((text, MARKDOWN_LOSSES.iter().map(|s| (*s).into()).collect()))
}

/// Reads only front matter generated by export_markdown; ordinary Markdown becomes a note body.
pub fn parse_markdown(input: &str) -> Result<(PortableItem, ImportReport), String> {
    let mut item = PortableItem {
        kind: "note".into(),
        title: "Untitled".into(),
        description: String::new(),
        content: None,
        url: None,
        collection: None,
        tags: vec![],
        is_favorite: false,
        is_pinned: false,
        created_at: String::new(),
        updated_at: String::new(),
        deleted_at: None,
        file: None,
    };
    let body = if let Some(rest) = input.strip_prefix("---\n") {
        let (header, body) = rest
            .split_once("\n---\n")
            .ok_or("Unclosed Markdown front matter")?;
        let mut keys = HashSet::new();
        for line in header.lines() {
            let (key, value) = line
                .split_once(": ")
                .ok_or("Invalid Markdown front matter")?;
            if !keys.insert(key) {
                return Err("Duplicate Markdown front matter key".into());
            }
            match key {
                "title" => item.title = serde_json::from_str(value).map_err(|_| "Invalid title")?,
                "description" => {
                    item.description =
                        serde_json::from_str(value).map_err(|_| "Invalid description")?
                }
                "collection" => {
                    item.collection =
                        Some(serde_json::from_str(value).map_err(|_| "Invalid collection")?)
                }
                "tags" => item.tags = serde_json::from_str(value).map_err(|_| "Invalid tags")?,
                "isFavorite" => {
                    item.is_favorite = value.parse().map_err(|_| "Invalid favorite flag")?
                }
                "isPinned" => item.is_pinned = value.parse().map_err(|_| "Invalid pinned flag")?,
                _ => return Err(format!("Unsupported Markdown front matter key: {key}")),
            }
        }
        body
    } else {
        input
    };
    item.content = Some(body.into());
    Ok((
        item,
        ImportReport {
            losses: MARKDOWN_LOSSES.iter().map(|s| (*s).into()).collect(),
            ..Default::default()
        },
    ))
}

struct ItemRow {
    id: String,
    kind: String,
    title: String,
    description: String,
    content: Option<String>,
    url: Option<String>,
    collection: Option<String>,
    tags: String,
    is_favorite: i64,
    is_pinned: i64,
    created_at: String,
    updated_at: String,
    deleted_at: Option<String>,
    file: Option<FileRecord>,
}

fn export_parent(path: &Path) -> PathBuf {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn new_id(connection: &Connection) -> Result<String, String> {
    connection
        .query_row("SELECT lower(hex(randomblob(16)))", [], |row| row.get(0))
        .map_err(|error| format!("Could not create an item id: {error}"))
}

// Imported items keep their collection name. A missing collection is created so
// the name survives the round trip instead of being dropped.
fn resolve_collection(
    connection: &Connection,
    name: &str,
    key: Option<&[u8; 32]>,
) -> Result<String, String> {
    // Sealed names cannot be matched in SQL, so compare the decrypted ones.
    if let Some(key) = key {
        let mut statement = connection
            .prepare("SELECT id, name_secret FROM collections WHERE name_secret IS NOT NULL")
            .map_err(|error| format!("Could not read collections: {error}"))?;
        let sealed = statement
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?)))
            .map_err(|error| format!("Could not read collections: {error}"))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| format!("Could not read collections: {error}"))?;
        for (id, bytes) in sealed {
            if encryption::open_collection_name(key, &id, &bytes)? == name {
                return Ok(id);
            }
        }
    }
    if let Some(id) = connection
        .query_row(
            "SELECT id FROM collections WHERE name = ?1",
            params![name],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Could not read collections: {error}"))?
    {
        return Ok(id);
    }
    let id = new_id(connection)?;
    connection
        .execute(
            "INSERT INTO collections (id, name, sort_order, created_at)
             VALUES (?1, ?2, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM collections),
                     strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            params![id, name],
        )
        .map_err(|error| format!("Could not import collection: {error}"))?;
    Ok(id)
}

fn insert_item(
    connection: &Connection,
    key: Option<&[u8; 32]>,
    item: &PortableItem,
) -> Result<String, String> {
    let id = new_id(connection)?;
    let collection_id = match item.collection.as_deref().map(str::trim) {
        Some(name) if !name.is_empty() => Some(resolve_collection(connection, name, key)?),
        _ => None,
    };
    let tags = serde_json::to_string(&item.tags).map_err(|error| error.to_string())?;
    let title = if item.title.trim().is_empty() {
        "Untitled"
    } else {
        item.title.as_str()
    };
    // Protected values are written after the item row so the item_secrets
    // foreign key resolves, and the plaintext columns stay empty.
    let (description, content, url) = if key.is_some() {
        (String::new(), None, None)
    } else {
        (
            item.description.clone(),
            item.content.clone(),
            item.url.clone(),
        )
    };
    connection
        .execute(
            "INSERT INTO items
               (id, kind, title, description, content, url, collection_id, is_favorite, is_pinned,
                tags, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 0, ?8,
                     strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                     strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            params![
                id,
                item.kind,
                title,
                description,
                content,
                url,
                collection_id,
                tags
            ],
        )
        .map_err(|error| format!("Could not import item: {error}"))?;
    if let Some(key) = key {
        encryption::write_secret(
            connection,
            key,
            &id,
            &encryption::ProtectedItem {
                description: item.description.clone(),
                content: item.content.clone(),
                url: item.url.clone(),
                ..Default::default()
            },
        )?;
    }
    // Phase 5 index rule: notes only, and never while the value is protected.
    if key.is_none() && item.kind == "note" {
        connection
            .execute(
                "INSERT INTO item_search(item_id, kind, title, body) VALUES (?1, 'note', ?2, ?3)",
                params![id, title, item.content.as_deref().unwrap_or("")],
            )
            .map_err(|error| format!("Could not index imported item: {error}"))?;
    }
    connection
        .execute(
            "INSERT INTO index_state (item_id, needs_index, indexed_at, updated_at, status)
             VALUES (?1, 1, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'pending')
             ON CONFLICT(item_id) DO UPDATE SET
               needs_index = 1, indexed_at = NULL, status = 'pending',
               updated_at = excluded.updated_at",
            params![id],
        )
        .map_err(|error| format!("Could not index imported item: {error}"))?;
    Ok(id)
}

fn fresh_stored_name(connection: &Connection, original_name: &str) -> Result<String, String> {
    let id = new_id(connection)?;
    let extension = Path::new(original_name)
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 16
                && value.chars().all(|c| c.is_ascii_alphanumeric())
        });
    let name = match extension {
        Some(extension) => format!("{id}.{extension}"),
        None => id,
    };
    if !plain_name(&name) {
        return Err("Could not name the imported file".into());
    }
    Ok(name)
}

/// Imports are read into memory whole, so a size cap keeps a huge or hostile
/// file from exhausting it.
const MAX_IMPORT_TEXT_BYTES: u64 = 50 * 1024 * 1024;
const MAX_IMPORT_FILE_BYTES: u64 = 1024 * 1024 * 1024;
const TOO_LARGE: &str = "This file is too large to import";

fn read_import_text(path: &Path) -> Result<String, String> {
    let size = fs::metadata(path)
        .map_err(|error| format!("Could not read the file: {error}"))?
        .len();
    if size > MAX_IMPORT_TEXT_BYTES {
        return Err(TOO_LARGE.to_string());
    }
    fs::read_to_string(path).map_err(|error| format!("Could not read the file: {error}"))
}

fn read_import_bytes(root: &Path, file: &FileRecord) -> Result<Vec<u8>, &'static str> {
    if !plain_name(&file.stored_name) {
        return Err("Unsafe managed file name");
    }
    let path = root.join("files").join(&file.stored_name);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if !metadata.file_type().is_file() => {
            Err("Managed file is not a regular file")
        }
        Ok(metadata) if metadata.len() > MAX_IMPORT_FILE_BYTES => Err(TOO_LARGE),
        Ok(metadata) if metadata.len() != file.byte_size => {
            Err("Managed file size does not match JSON")
        }
        Ok(_) => fs::read(&path).map_err(|_| "Managed file is missing or unreadable"),
        Err(_) => Err("Managed file is missing or unreadable"),
    }
}

fn store_import_file(
    connection: &Connection,
    files_dir: &Path,
    key: Option<&[u8; 32]>,
    item_id: &str,
    root: &Path,
    file: &FileRecord,
) -> Result<(), String> {
    let bytes = read_import_bytes(root, file).map_err(str::to_string)?;
    let byte_size =
        i64::try_from(bytes.len()).map_err(|_| "Managed file is too large".to_string())?;
    let stored_name = fresh_stored_name(connection, &file.original_name)?;
    let (stored_bytes, encrypted) = match key {
        Some(key) => (encryption::encrypt_file(key, item_id, &bytes)?, true),
        None => (bytes, false),
    };
    fs::write(files_dir.join(&stored_name), &stored_bytes)
        .map_err(|error| format!("Could not write imported file: {error}"))?;
    connection
        .execute(
            "INSERT INTO files (item_id, stored_name, original_name, byte_size, imported_at, encrypted)
             VALUES (?1, ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?5)",
            params![
                item_id,
                stored_name,
                file.original_name,
                byte_size,
                i64::from(encrypted)
            ],
        )
        .map_err(|error| format!("Could not import file: {error}"))?;
    Ok(())
}

fn file_label(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// Imports Kivo JSON as brand-new items. Existing rows are never merged or
/// overwritten; unsupported or unreadable inputs are skipped with a reason.
pub(crate) fn import_json_into(
    connection: &mut Connection,
    files_dir: &Path,
    keys: &ContentKeyState,
    path: &Path,
) -> Result<ImportReport, String> {
    let input = read_import_text(path)?;
    let (document, mut report) = decode_json(&input)?;
    let root = export_parent(path);
    let directories_ok =
        fs::symlink_metadata(root.join("files")).is_ok_and(|m| m.file_type().is_dir());
    let key = encryption::key_if_enabled(connection, keys)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not start the import: {error}"))?;
    let mut seen = HashSet::new();
    for item in &document.items {
        if let Some(file) = &item.file {
            if let Some(reason) = file_ref_problem(file, &root, directories_ok, &mut seen) {
                report.skipped.push(SkippedItem {
                    title: item.title.clone(),
                    reason: reason.into(),
                });
                continue;
            }
        }
        let id = match insert_item(&transaction, key.as_ref(), item) {
            Ok(id) => id,
            Err(error) => {
                report.skipped.push(SkippedItem {
                    title: item.title.clone(),
                    reason: error,
                });
                continue;
            }
        };
        report.imported += 1;
        if let Some(file) = &item.file {
            if let Err(error) =
                store_import_file(&transaction, files_dir, key.as_ref(), &id, &root, file)
            {
                report.skipped.push(SkippedItem {
                    title: item.title.clone(),
                    reason: error,
                });
            }
        }
    }
    // Titles, tags, file and collection names are sealed before the commit.
    if let Some(key) = key.as_ref() {
        encryption::seal_all(&transaction, key)?;
    }
    transaction
        .commit()
        .map_err(|error| format!("Could not finish the import: {error}"))?;
    Ok(report)
}

/// Imports Markdown files as brand-new notes. Each file is independent: a bad
/// file is reported and skipped instead of failing the whole import.
pub(crate) fn import_markdown_into(
    connection: &mut Connection,
    keys: &ContentKeyState,
    paths: &[String],
) -> Result<ImportReport, String> {
    if paths.is_empty() {
        return Err("Choose at least one Markdown file".into());
    }
    let key = encryption::key_if_enabled(connection, keys)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not start the import: {error}"))?;
    let mut report = ImportReport::default();
    for path in paths {
        let text = match read_import_text(Path::new(path)) {
            Ok(text) => text,
            Err(error) => {
                report.skipped.push(SkippedItem {
                    title: file_label(path),
                    reason: error,
                });
                continue;
            }
        };
        let (item, item_report) = match parse_markdown(&text) {
            Ok(value) => value,
            Err(error) => {
                report.skipped.push(SkippedItem {
                    title: file_label(path),
                    reason: error,
                });
                continue;
            }
        };
        for loss in item_report.losses {
            if !report.losses.contains(&loss) {
                report.losses.push(loss);
            }
        }
        if let Err(error) = insert_item(&transaction, key.as_ref(), &item) {
            report.skipped.push(SkippedItem {
                title: file_label(path),
                reason: error,
            });
        } else {
            report.imported += 1;
        }
    }
    if let Some(key) = key.as_ref() {
        encryption::seal_all(&transaction, key)?;
    }
    transaction
        .commit()
        .map_err(|error| format!("Could not finish the import: {error}"))?;
    Ok(report)
}

/// Items of `locked` collections are left out; the caller decides whether that
/// is an error (one chosen item) or a count to report (whole vault). A whole
/// vault export also leaves out Trash.
fn read_items(
    connection: &Connection,
    keys: &ContentKeyState,
    only: Option<&str>,
    locked: &[String],
) -> Result<Vec<PortableItem>, String> {
    let key = encryption::key_if_enabled(connection, keys)?;
    let mut statement = connection
        .prepare(&format!(
            "SELECT i.id, i.kind, i.title, i.description, i.content, i.url, c.name, i.tags,
                    i.is_favorite, i.is_pinned, i.created_at, i.updated_at, i.deleted_at,
                    f.stored_name, f.original_name, f.byte_size
             FROM items i
             LEFT JOIN collections c ON c.id = i.collection_id
             LEFT JOIN files f ON f.item_id = i.id
             WHERE (i.id = ?1 OR (?1 IS NULL AND i.deleted_at IS NULL)){}
             ORDER BY i.created_at, i.id",
            crate::database::locked_filter_sql("i.collection_id", locked)
        ))
        .map_err(|error| format!("Could not read the vault: {error}"))?;
    let mut values = vec![match only {
        Some(id) => rusqlite::types::Value::Text(id.to_string()),
        None => rusqlite::types::Value::Null,
    }];
    values.extend(locked.iter().cloned().map(rusqlite::types::Value::Text));
    let rows = statement
        .query_map(rusqlite::params_from_iter(values.iter()), |row| {
            let file = match row.get::<_, Option<String>>(13)? {
                Some(stored_name) => Some(FileRecord {
                    stored_name,
                    original_name: row.get(14)?,
                    byte_size: row.get::<_, i64>(15)?.max(0) as u64,
                }),
                None => None,
            };
            Ok(ItemRow {
                id: row.get(0)?,
                kind: row.get(1)?,
                title: row.get(2)?,
                description: row.get(3)?,
                content: row.get(4)?,
                url: row.get(5)?,
                collection: row.get(6)?,
                tags: row.get(7)?,
                is_favorite: row.get(8)?,
                is_pinned: row.get(9)?,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
                deleted_at: row.get(12)?,
                file,
            })
        })
        .map_err(|error| format!("Could not read the vault: {error}"))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("Could not read the vault: {error}"))?;
    let mut items = Vec::with_capacity(rows.len());
    for mut row in rows {
        let mut tags: Vec<String> = serde_json::from_str(&row.tags).unwrap_or_default();
        let (description, content, url) = if let Some(key) = &key {
            let protected = encryption::read_secret(connection, key, &row.id)?;
            if let Some(title) = protected.title {
                row.title = title;
            }
            if let Some(sealed_tags) = protected.tags {
                tags = sealed_tags;
            }
            if let (Some(name), Some(file)) = (protected.file_name, row.file.as_mut()) {
                file.original_name = name;
            }
            // A sealed collection stores its id as the name; open the real one.
            if let Some(id) = row.collection.clone() {
                let sealed: Option<Vec<u8>> = connection
                    .query_row(
                        "SELECT name_secret FROM collections WHERE id = ?1",
                        params![id],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(|error| format!("Could not read the vault: {error}"))?
                    .flatten();
                if let Some(sealed) = sealed {
                    row.collection = Some(encryption::open_collection_name(key, &id, &sealed)?);
                }
            }
            (protected.description, protected.content, protected.url)
        } else {
            (row.description, row.content, row.url)
        };
        items.push(PortableItem {
            kind: row.kind,
            title: row.title,
            description,
            content,
            url,
            collection: row.collection,
            tags,
            is_favorite: row.is_favorite != 0,
            is_pinned: row.is_pinned != 0,
            created_at: row.created_at,
            updated_at: row.updated_at,
            deleted_at: row.deleted_at,
            file: row.file,
        });
    }
    Ok(items)
}

/// Export is read-only on the vault. A protected file is decrypted in memory so
/// the copy is portable; the stored bytes and source rows are never changed.
fn write_document(
    connection: &Connection,
    files_dir: &Path,
    keys: &ContentKeyState,
    document: &VaultDocument,
    path: &Path,
) -> Result<(), String> {
    let key = encryption::key_if_enabled(connection, keys)?;
    let (json, _report) = encode_json_with_report(document)?;
    let referenced: Vec<&FileRecord> = document
        .items
        .iter()
        .filter_map(|item| item.file.as_ref())
        .collect();
    if !referenced.is_empty() {
        let out = export_parent(path).join("files");
        fs::create_dir_all(&out)
            .map_err(|error| format!("Could not create the export files folder: {error}"))?;
        for file in referenced {
            if !plain_name(&file.stored_name) {
                return Err("A managed file has an unsafe name".into());
            }
            let bytes = fs::read(files_dir.join(&file.stored_name))
                .map_err(|_| format!("Could not read managed file: {}", file.stored_name))?;
            let bytes = match &key {
                Some(key) => {
                    let (item_id, encrypted): (String, i64) = connection
                        .query_row(
                            "SELECT item_id, encrypted FROM files WHERE stored_name = ?1",
                            params![file.stored_name],
                            |row| Ok((row.get(0)?, row.get(1)?)),
                        )
                        .map_err(|error| {
                            format!("Could not read managed file metadata: {error}")
                        })?;
                    if encrypted != 0 {
                        encryption::decrypt_file(key, &item_id, &bytes)?
                    } else {
                        bytes
                    }
                }
                None => bytes,
            };
            fs::write(out.join(&file.stored_name), bytes)
                .map_err(|error| format!("Could not write export file: {error}"))?;
        }
    }
    fs::write(path, json).map_err(|error| format!("Could not write the export: {error}"))
}

#[tauri::command]
pub fn pick_save_file(default_name: String, app: AppHandle) -> Result<Option<String>, String> {
    Ok(app
        .dialog()
        .file()
        .set_file_name(default_name)
        .blocking_save_file()
        .map(|path| path.to_string()))
}

#[tauri::command]
pub fn pick_folder_destination(app: AppHandle) -> Result<Option<String>, String> {
    Ok(app
        .dialog()
        .file()
        .blocking_pick_folder()
        .map(|path| path.to_string()))
}

#[tauri::command]
pub fn export_note_markdown(
    id: String,
    path: String,
    state: State<'_, DatabaseState>,
) -> Result<(), String> {
    let guard = state.require_connection()?;
    let connection = guard.as_ref().expect("checked above");
    crate::database::ensure_item_accessible(connection, &state, &id)?;
    let item = read_items(connection, state.content_key(), Some(&id), &[])?
        .into_iter()
        .next()
        .ok_or("That note no longer exists")?;
    let (text, _losses) = export_markdown(&item)?;
    fs::write(&path, text).map_err(|error| format!("Could not write the export: {error}"))
}

#[tauri::command]
pub fn export_items_json(
    ids: Vec<String>,
    path: String,
    state: State<'_, DatabaseState>,
) -> Result<(), String> {
    let guard = state.require_connection()?;
    let connection = guard.as_ref().expect("checked above");
    let keys = state.content_key();
    let mut items = Vec::new();
    for id in &ids {
        crate::database::ensure_item_accessible(connection, &state, id)?;
        if let Some(item) = read_items(connection, keys, Some(id), &[])?.into_iter().next() {
            items.push(item);
        }
    }
    let document = VaultDocument {
        format: 1,
        collections: Vec::new(),
        items,
    };
    write_document(
        connection,
        state.files_dir(),
        keys,
        &document,
        Path::new(&path),
    )
}

/// Writes `kivo-vault.json` and a sibling `files/` folder. Builds and decrypts
/// the whole document first, so a locked vault writes nothing. Items in
/// `locked` collections are left out; returns how many were skipped.
pub(crate) fn export_vault_into(
    connection: &Connection,
    files_dir: &Path,
    keys: &ContentKeyState,
    path: &Path,
    locked: &[String],
) -> Result<usize, String> {
    let skipped = if locked.is_empty() {
        0
    } else {
        connection
            .query_row(
                &format!(
                    "SELECT COUNT(*) FROM items WHERE deleted_at IS NULL AND collection_id IN ({})",
                    vec!["?"; locked.len()].join(",")
                ),
                rusqlite::params_from_iter(locked.iter()),
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| format!("Could not read the vault: {error}"))? as usize
    };
    let mut statement = connection
        .prepare("SELECT id, name, name_secret FROM collections ORDER BY sort_order, name")
        .map_err(|error| format!("Could not read collections: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<Vec<u8>>>(2)?,
            ))
        })
        .map_err(|error| format!("Could not read collections: {error}"))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("Could not read collections: {error}"))?;
    let key = encryption::key_if_enabled(connection, keys)?;
    let collections = rows
        .into_iter()
        .map(|(id, name, sealed)| match (key.as_ref(), sealed) {
            (Some(key), Some(sealed)) => encryption::open_collection_name(key, &id, &sealed)
                .map(|name| CollectionRecord { name }),
            _ => Ok(CollectionRecord { name }),
        })
        .collect::<Result<Vec<_>, String>>()?;
    let document = VaultDocument {
        format: 1,
        collections,
        items: read_items(connection, keys, None, locked)?,
    };
    write_document(connection, files_dir, keys, &document, path)?;
    Ok(skipped)
}

/// Returns how many items were left out because their collection is locked.
#[tauri::command]
pub fn export_vault_json(path: String, state: State<'_, DatabaseState>) -> Result<usize, String> {
    let guard = state.require_connection()?;
    let connection = guard.as_ref().expect("checked above");
    let locked = crate::database::locked_collection_ids(connection, &state)?;
    export_vault_into(
        connection,
        state.files_dir(),
        state.content_key(),
        Path::new(&path),
        &locked,
    )
}

#[tauri::command]
pub fn import_json(path: String, state: State<'_, DatabaseState>) -> Result<ImportReport, String> {
    let mut guard = state.require_connection()?;
    import_json_into(
        guard.as_mut().expect("checked above"),
        state.files_dir(),
        state.content_key(),
        Path::new(&path),
    )
}

#[tauri::command]
pub fn import_markdown(
    paths: Vec<String>,
    state: State<'_, DatabaseState>,
) -> Result<ImportReport, String> {
    let mut guard = state.require_connection()?;
    import_markdown_into(
        guard.as_mut().expect("checked above"),
        state.content_key(),
        &paths,
    )
}

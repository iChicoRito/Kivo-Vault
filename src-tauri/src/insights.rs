use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::database::DatabaseState;
use crate::vault::{ItemFilter, ItemSummary};

pub fn tokenize(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| word.chars().count() > 1 && !is_stopword(word))
        .map(str::to_owned)
        .collect()
}

fn is_stopword(word: &str) -> bool {
    matches!(
        word,
        "a" | "an"
            | "and"
            | "are"
            | "as"
            | "at"
            | "be"
            | "been"
            | "but"
            | "by"
            | "for"
            | "from"
            | "has"
            | "have"
            | "in"
            | "is"
            | "it"
            | "its"
            | "of"
            | "on"
            | "or"
            | "that"
            | "the"
            | "their"
            | "this"
            | "to"
            | "was"
            | "were"
            | "with"
            | "about"
    )
}

fn decode_entity(entity: &str) -> Option<char> {
    match entity {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" | "#39" => Some('\''),
        "nbsp" => Some(' '),
        "ndash" => Some('–'),
        "mdash" => Some('—'),
        "hellip" => Some('…'),
        "copy" => Some('©'),
        "reg" => Some('®'),
        _ => {
            let number = entity.strip_prefix('#')?;
            let value = if let Some(hex) = number
                .strip_prefix('x')
                .or_else(|| number.strip_prefix('X'))
            {
                u32::from_str_radix(hex, 16).ok()?
            } else {
                number.parse::<u32>().ok()?
            };
            if value == 0 {
                None
            } else {
                char::from_u32(value)
            }
        }
    }
}

fn line_break(out: &mut String) {
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
}

pub fn strip_html_to_text(html: &str) -> String {
    let mut out = String::new();
    let mut i = 0;
    let mut hidden: Option<String> = None;
    while i < html.len() {
        if html[i..].starts_with("<!--") {
            i = html[i + 4..]
                .find("-->")
                .map_or(html.len(), |end| i + 4 + end + 3);
            continue;
        }
        if html[i..].starts_with('<')
            && html[i + 1..]
                .chars()
                .next()
                .is_some_and(|ch| ch.is_ascii_alphabetic() || ch == '/' || ch == '!')
        {
            let mut end = i + 1;
            let mut quote = None;
            while end < html.len() {
                let ch = html[end..].chars().next().unwrap();
                if ch == '>' && quote.is_none() {
                    break;
                }
                if ch == '\'' || ch == '"' {
                    if quote == Some(ch) {
                        quote = None;
                    } else if quote.is_none() {
                        quote = Some(ch);
                    }
                }
                end += ch.len_utf8();
            }
            if end < html.len() {
                let tag = html[i + 1..end].trim();
                let closing = tag.starts_with('/');
                let name = tag
                    .trim_start_matches('/')
                    .split(|c: char| !c.is_ascii_alphanumeric())
                    .next()
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if let Some(ref blocked) = hidden {
                    if closing && name == *blocked {
                        hidden = None;
                    }
                } else if !closing && matches!(name.as_str(), "script" | "style") {
                    hidden = Some(name);
                } else if matches!(
                    name.as_str(),
                    "p" | "div"
                        | "br"
                        | "li"
                        | "h1"
                        | "h2"
                        | "h3"
                        | "h4"
                        | "h5"
                        | "h6"
                        | "section"
                        | "article"
                        | "tr"
                ) {
                    line_break(&mut out);
                }
                i = end + 1;
                continue;
            }
        }
        if html[i..].starts_with('&') && hidden.is_none() {
            if let Some(end) = html[i + 1..].find(';') {
                if end <= 12 {
                    if let Some(decoded) = decode_entity(&html[i + 1..i + 1 + end]) {
                        out.push(decoded);
                        i += end + 2;
                        continue;
                    }
                }
            }
        }
        let ch = html[i..].chars().next().unwrap();
        if hidden.is_none() {
            out.push(ch);
        }
        i += ch.len_utf8();
    }
    out.lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn weights(
    kind: &str,
    title: &str,
    description: &str,
    body: &str,
    tags: &[&str],
) -> HashMap<String, u32> {
    if kind != "note" && kind != "source" {
        return HashMap::new();
    }
    let mut terms = HashMap::new();
    for (text, weight) in [(title, 3), (description, 1)] {
        for term in tokenize(text) {
            *terms.entry(term).or_insert(0) += weight;
        }
    }
    for tag in tags {
        for term in tokenize(tag) {
            *terms.entry(term).or_insert(0) += 2;
        }
    }
    if kind == "note" {
        for term in tokenize(&strip_html_to_text(body)) {
            *terms.entry(term).or_insert(0) += 1;
        }
    }
    terms
}

/// Sorted strongest first (alphabetical on ties), ready for JSON storage as pairs.
pub fn build_vector(
    kind: &str,
    title: &str,
    description: &str,
    body: &str,
    tags: &[&str],
) -> Vec<(String, f64)> {
    let mut terms: Vec<_> = weights(kind, title, description, body, tags)
        .into_iter()
        .collect();
    terms.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let Some(max) = terms.first().map(|pair| pair.1 as f64) else {
        return Vec::new();
    };
    terms
        .into_iter()
        .take(64)
        .map(|(word, weight)| (word, weight as f64 / max))
        .collect()
}

pub struct RelatedCandidate<'a> {
    pub id: &'a str,
    pub updated_at: &'a str,
    pub terms: &'a [(String, f64)],
}

#[derive(Debug, PartialEq)]
pub struct RelatedMatch<'a> {
    pub id: &'a str,
    pub score: f64,
    pub matched_terms: Vec<String>,
}

pub fn rank_related<'a>(
    query: &str,
    candidates: &[RelatedCandidate<'a>],
    limit: usize,
) -> Vec<RelatedMatch<'a>> {
    let query_terms: HashSet<_> = tokenize(query).into_iter().collect();
    if query_terms.is_empty() || limit == 0 {
        return Vec::new();
    }
    let mut hits: Vec<_> = candidates
        .iter()
        .filter_map(|candidate| {
            let mut matching: Vec<_> = candidate
                .terms
                .iter()
                .filter(|(term, weight)| *weight > 0.0 && query_terms.contains(term))
                .collect();
            matching.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
            let score: f64 = matching.iter().map(|(_, weight)| *weight).sum();
            if score == 0.0 {
                return None;
            }
            Some((
                candidate.updated_at,
                RelatedMatch {
                    id: candidate.id,
                    score,
                    matched_terms: matching
                        .into_iter()
                        .take(3)
                        .map(|(term, _)| term.clone())
                        .collect(),
                },
            ))
        })
        .collect();
    hits.sort_by(|a, b| {
        b.1.score
            .total_cmp(&a.1.score)
            .then_with(|| b.0.cmp(a.0))
            .then_with(|| a.1.id.cmp(b.1.id))
    });
    hits.into_iter().take(limit).map(|(_, hit)| hit).collect()
}

pub fn suggest_tag_names(
    kind: &str,
    title: &str,
    description: &str,
    body: &str,
    existing_tags: &[&str],
) -> Vec<String> {
    let existing: HashSet<_> = existing_tags.iter().map(|tag| tag.to_lowercase()).collect();
    build_vector(kind, title, description, body, &[])
        .into_iter()
        .map(|(term, _)| term)
        .filter(|term| !existing.contains(term))
        .take(5)
        .collect()
}

pub fn summarize_note(kind: &str, html: &str) -> Vec<String> {
    if kind != "note" {
        return Vec::new();
    }
    let text = strip_html_to_text(html);
    let mut sentences = Vec::new();
    let mut start = 0;
    for (i, ch) in text.char_indices() {
        if matches!(ch, '.' | '?' | '!' | '\n') {
            let sentence = text[start..i + ch.len_utf8()].trim();
            if !sentence.is_empty() {
                sentences.push(sentence.to_owned());
            }
            start = i + ch.len_utf8();
        }
    }
    if !text[start..].trim().is_empty() {
        sentences.push(text[start..].trim().to_owned());
    }
    let counts = weights("note", "", "", html, &[]);
    let mut ranked: Vec<_> = sentences
        .into_iter()
        .enumerate()
        .map(|(index, sentence)| {
            let score: u32 = tokenize(&sentence)
                .into_iter()
                .map(|word| counts.get(&word).copied().unwrap_or(0))
                .sum();
            (index, score, sentence)
        })
        .collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    ranked.truncate(5);
    ranked.sort_by_key(|entry| entry.0);
    ranked
        .into_iter()
        .map(|(_, _, sentence)| sentence)
        .collect()
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
//
// All three optional features read the owner's own words and never change an
// item. Related search keeps one derived `item_vectors` row per supported item;
// tag suggestions and summaries compute in memory and write nothing.

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelatedSearchInput {
    pub query: String,
    pub filter: Option<ItemFilter>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelatedResult {
    pub item: ItemSummary,
    pub score: f64,
    pub matched_terms: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReindexReport {
    pub indexed: usize,
    pub pending: usize,
}

const RELATED_LIMIT: usize = 8;

fn feature_flag<F>(connection: &Connection, pick: F) -> Result<bool, String>
where
    F: Fn(&crate::database::Preferences) -> bool,
{
    let preferences = crate::database::read_preferences(connection)
        .map_err(|error| format!("Could not read preferences: {error}"))?;
    Ok(pick(&preferences))
}

// The vault key only exists while encryption is on and unlocked. A missing key
// while encryption is on means the feature answers empty instead of erroring.
fn content_key(connection: &Connection, state: &DatabaseState) -> Result<Option<[u8; 32]>, String> {
    match crate::encryption::key_if_enabled(connection, state.content_key()) {
        Ok(key) => Ok(key),
        Err(_) => Ok(None),
    }
}

type OwnedVector = (String, String, Vec<(String, f64)>);
type ItemTextRow = (
    String,
    String,
    String,
    Option<String>,
    String,
    Option<String>,
);

struct PendingRow {
    id: String,
    kind: String,
    title: String,
    description: String,
    content: Option<String>,
    tags: Vec<String>,
}

fn pending_rows(connection: &Connection) -> Result<Vec<PendingRow>, String> {
    let mut statement = connection
        .prepare(
            "SELECT i.id, i.kind, i.title, i.description, i.content, i.tags
             FROM items i
             LEFT JOIN index_state s ON s.item_id = i.id
             LEFT JOIN item_vectors v ON v.item_id = i.id
             WHERE i.deleted_at IS NULL
               AND i.kind IN ('note', 'source')
               AND (COALESCE(s.needs_index, 1) = 1 OR v.item_id IS NULL)",
        )
        .map_err(|error| format!("Could not read pending items: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
            ))
        })
        .map_err(|error| format!("Could not read pending items: {error}"))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("Could not read pending items: {error}"))?;
    Ok(rows
        .into_iter()
        .map(|(id, kind, title, description, content, tags)| PendingRow {
            id,
            kind,
            title,
            description,
            content,
            tags: serde_json::from_str(&tags).unwrap_or_default(),
        })
        .collect())
}

fn pending_vector_count(connection: &Connection) -> Result<usize, String> {
    connection
        .query_row(
            "SELECT COUNT(*)
             FROM items i
             LEFT JOIN index_state s ON s.item_id = i.id
             LEFT JOIN item_vectors v ON v.item_id = i.id
             WHERE i.deleted_at IS NULL
               AND i.kind IN ('note', 'source')
               AND (COALESCE(s.needs_index, 1) = 1 OR v.item_id IS NULL)",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count.max(0) as usize)
        .map_err(|error| format!("Could not read the index state: {error}"))
}

// Writes one `item_vectors` row and clears the index flag for each pending row.
// The caller chooses the transaction scope; a plain connection is used when a
// related search refreshes lazily.
fn store_pending(connection: &Connection, rows: &[PendingRow]) -> Result<usize, String> {
    for row in rows {
        let tags: Vec<&str> = row.tags.iter().map(String::as_str).collect();
        let terms = build_vector(
            &row.kind,
            &row.title,
            &row.description,
            row.content.as_deref().unwrap_or(""),
            &tags,
        );
        let terms = serde_json::to_string(&terms)
            .map_err(|_| "Could not build the item vector".to_string())?;
        connection
            .execute(
                "INSERT INTO item_vectors (item_id, terms, updated_at)
                 VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                 ON CONFLICT(item_id) DO UPDATE SET
                   terms = excluded.terms,
                   updated_at = excluded.updated_at",
                params![row.id, terms],
            )
            .map_err(|error| format!("Could not index the item: {error}"))?;
        connection
            .execute(
                "INSERT INTO index_state (item_id, needs_index, indexed_at, updated_at, status)
                 VALUES (?1, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'indexed')
                 ON CONFLICT(item_id) DO UPDATE SET
                   needs_index = 0,
                   indexed_at = excluded.indexed_at,
                   updated_at = excluded.updated_at,
                   status = 'indexed'",
                params![row.id],
            )
            .map_err(|error| format!("Could not index the item: {error}"))?;
    }
    Ok(rows.len())
}

fn refresh_pending_vectors(connection: &Connection) -> Result<usize, String> {
    let rows = pending_rows(connection)?;
    store_pending(connection, &rows)
}

fn read_vectors(connection: &Connection) -> Result<HashMap<String, Vec<(String, f64)>>, String> {
    let mut statement = connection
        .prepare("SELECT item_id, terms FROM item_vectors")
        .map_err(|error| format!("Could not read the item vectors: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("Could not read the item vectors: {error}"))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("Could not read the item vectors: {error}"))?;
    let mut vectors = HashMap::new();
    for (id, terms) in rows {
        if let Ok(parsed) = serde_json::from_str::<Vec<(String, f64)>>(&terms) {
            vectors.insert(id, parsed);
        }
    }
    Ok(vectors)
}

struct LiveItem {
    summary: ItemSummary,
    description: String,
    content: Option<String>,
    tags: Vec<String>,
}

// Reads live items with the filter fields Related search honors. The `query`
// and `trashed` filter fields are ignored, and trashed rows are never returned.
fn read_live_items(
    connection: &Connection,
    filter: Option<&ItemFilter>,
    locked: &[String],
) -> Result<Vec<LiveItem>, String> {
    let mut sql = format!(
        "SELECT i.id, i.kind, i.title, i.description, i.content, i.is_favorite, i.is_pinned,
                i.collection_id, i.updated_at, i.tags
         FROM items i
         WHERE i.deleted_at IS NULL{}",
        crate::database::locked_filter_sql("i.collection_id", locked)
    );
    let mut values: Vec<rusqlite::types::Value> = locked
        .iter()
        .cloned()
        .map(rusqlite::types::Value::Text)
        .collect();
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
        if let Some(tag) = filter.tag.as_deref().filter(|value| !value.is_empty()) {
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
    }
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("Could not search related items: {error}"))?;
    let rows = statement
        .query_map(rusqlite::params_from_iter(values.iter()), |row| {
            let tags_json: String = row.get(9)?;
            Ok(LiveItem {
                summary: ItemSummary {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    title: row.get(2)?,
                    is_favorite: row.get::<_, i64>(5)? != 0,
                    is_pinned: row.get::<_, i64>(6)? != 0,
                    collection_id: row.get(7)?,
                    updated_at: row.get(8)?,
                    deleted_at: None,
                    file: None,
                    file_missing: false,
                    content: None,
                    match_snippet: None,
                },
                description: row.get(3)?,
                content: row.get(4)?,
                tags: serde_json::from_str(&tags_json).unwrap_or_default(),
            })
        })
        .map_err(|error| format!("Could not search related items: {error}"))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("Could not search related items: {error}"))?;
    Ok(rows)
}

pub(crate) fn search_related_items_with_state(
    state: &DatabaseState,
    input: &RelatedSearchInput,
) -> Result<Vec<RelatedResult>, String> {
    let connection = state.require_connection()?;
    let connection = connection.as_ref().expect("checked above");
    if !feature_flag(connection, |preferences| preferences.semantic_search)? {
        return Ok(Vec::new());
    }
    let encrypted = crate::encryption::is_enabled(connection)?;
    let key = if encrypted {
        match content_key(connection, state)? {
            Some(key) => Some(key),
            // Encryption is on but locked: no plaintext to rank.
            None => return Ok(Vec::new()),
        }
    } else {
        None
    };

    let locked = crate::database::locked_collection_ids(connection, state)?;
    let items = read_live_items(connection, input.filter.as_ref(), &locked)?;
    let mut summaries: HashMap<String, ItemSummary> = HashMap::new();

    // While encryption is on, `item_vectors` must stay empty, so related search
    // derives the terms in memory from the decrypted rows instead.
    let mut owned: Vec<OwnedVector> = Vec::new();
    if encrypted {
        for item in items {
            let (description, content) = match key.as_ref() {
                Some(key) => {
                    match crate::encryption::read_secret(connection, key, &item.summary.id) {
                        Ok(protected) => (protected.description, protected.content),
                        Err(_) => continue,
                    }
                }
                None => (item.description.clone(), item.content.clone()),
            };
            let tags: Vec<&str> = item.tags.iter().map(String::as_str).collect();
            let terms = build_vector(
                &item.summary.kind,
                &item.summary.title,
                &description,
                content.as_deref().unwrap_or(""),
                &tags,
            );
            owned.push((
                item.summary.id.clone(),
                item.summary.updated_at.clone(),
                terms,
            ));
            summaries.insert(item.summary.id.clone(), item.summary);
        }
    } else {
        refresh_pending_vectors(connection)?;
        let vectors = read_vectors(connection)?;
        for item in items {
            if let Some(terms) = vectors.get(&item.summary.id) {
                owned.push((
                    item.summary.id.clone(),
                    item.summary.updated_at.clone(),
                    terms.clone(),
                ));
            }
            summaries.insert(item.summary.id.clone(), item.summary);
        }
    }

    let candidates: Vec<RelatedCandidate> = owned
        .iter()
        .map(|(id, updated_at, terms)| RelatedCandidate {
            id,
            updated_at,
            terms,
        })
        .collect();
    let hits = rank_related(&input.query, &candidates, RELATED_LIMIT);
    Ok(hits
        .into_iter()
        .filter_map(|hit| {
            let item = summaries.get(hit.id)?.clone();
            Some(RelatedResult {
                item,
                score: hit.score,
                matched_terms: hit.matched_terms,
            })
        })
        .collect())
}

pub(crate) fn reindex_items_with_state(state: &DatabaseState) -> Result<ReindexReport, String> {
    let mut connection = state.require_connection()?;
    let connection = connection.as_mut().expect("checked above");
    if !feature_flag(connection, |preferences| preferences.semantic_search)? {
        return Ok(ReindexReport {
            indexed: 0,
            pending: 0,
        });
    }
    // Encryption is on: derived vectors must never exist at rest. Reindex writes
    // nothing and leaves the flags alone, reporting what still waits.
    if crate::encryption::is_enabled(connection)? {
        return Ok(ReindexReport {
            indexed: 0,
            pending: pending_vector_count(connection)?,
        });
    }
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not start the index: {error}"))?;
    let rows = pending_rows(&transaction)?;
    let indexed = store_pending(&transaction, &rows)?;
    transaction
        .commit()
        .map_err(|error| format!("Could not finish the index: {error}"))?;
    Ok(ReindexReport {
        indexed,
        pending: 0,
    })
}

struct ItemText {
    kind: String,
    title: String,
    description: String,
    content: String,
    tags: Vec<String>,
}

// Reads one live item's text. Returns None for a missing or trashed item, and
// for a protected item whose vault is locked.
fn read_item_text(
    connection: &Connection,
    state: &DatabaseState,
    id: &str,
) -> Result<Option<ItemText>, String> {
    if crate::database::ensure_item_accessible(connection, state, id).is_err() {
        return Ok(None);
    }
    let row: Option<ItemTextRow> = connection
        .query_row(
            "SELECT kind, title, description, content, tags, deleted_at
             FROM items WHERE id = ?1",
            params![id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Could not read the item: {error}"))?;
    let Some((kind, title, description, content, tags, deleted_at)) = row else {
        return Ok(None);
    };
    if deleted_at.is_some() {
        return Ok(None);
    }
    let tags: Vec<String> = serde_json::from_str(&tags).unwrap_or_default();
    if !crate::encryption::is_enabled(connection)? {
        return Ok(Some(ItemText {
            kind,
            title,
            description,
            content: content.unwrap_or_default(),
            tags,
        }));
    }
    // Encryption is on: read the protected text in memory, or answer empty
    // while the vault is locked.
    let Some(key) = content_key(connection, state)? else {
        return Ok(None);
    };
    match crate::encryption::read_secret(connection, &key, id) {
        Ok(protected) => Ok(Some(ItemText {
            kind,
            title,
            description: protected.description,
            content: protected.content.unwrap_or_default(),
            tags,
        })),
        Err(_) => Ok(None),
    }
}

pub(crate) fn suggest_tags_with_state(
    state: &DatabaseState,
    item_id: &str,
) -> Result<Vec<String>, String> {
    let connection = state.require_connection()?;
    let connection = connection.as_ref().expect("checked above");
    if !feature_flag(connection, |preferences| preferences.auto_tag)? {
        return Ok(Vec::new());
    }
    let Some(item) = read_item_text(connection, state, item_id)? else {
        return Ok(Vec::new());
    };
    let tags: Vec<&str> = item.tags.iter().map(String::as_str).collect();
    Ok(suggest_tag_names(
        &item.kind,
        &item.title,
        &item.description,
        &item.content,
        &tags,
    ))
}

pub(crate) fn summarize_item_with_state(
    state: &DatabaseState,
    item_id: &str,
) -> Result<Vec<String>, String> {
    let connection = state.require_connection()?;
    let connection = connection.as_ref().expect("checked above");
    if !feature_flag(connection, |preferences| preferences.summaries)? {
        return Ok(Vec::new());
    }
    let Some(item) = read_item_text(connection, state, item_id)? else {
        return Ok(Vec::new());
    };
    Ok(summarize_note(&item.kind, &item.content))
}

#[tauri::command]
pub fn search_related_items(
    input: RelatedSearchInput,
    state: State<'_, DatabaseState>,
) -> Result<Vec<RelatedResult>, String> {
    search_related_items_with_state(state.inner(), &input)
}

#[tauri::command]
pub fn reindex_items(state: State<'_, DatabaseState>) -> Result<ReindexReport, String> {
    reindex_items_with_state(state.inner())
}

#[tauri::command]
pub fn suggest_tags(
    item_id: String,
    state: State<'_, DatabaseState>,
) -> Result<Vec<String>, String> {
    suggest_tags_with_state(state.inner(), &item_id)
}

#[tauri::command]
pub fn summarize_item(
    item_id: String,
    state: State<'_, DatabaseState>,
) -> Result<Vec<String>, String> {
    summarize_item_with_state(state.inner(), &item_id)
}

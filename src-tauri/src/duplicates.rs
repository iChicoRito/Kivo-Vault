use std::fs;
use std::io::{self, Read};
use std::path::Path;

use reqwest::Url;
use rusqlite::{params_from_iter, Connection};
use sha2::{Digest, Sha256};

use crate::database::locked_filter_sql;
use crate::encryption;

/// The form two source addresses are compared in. The URL parser lowercases
/// the scheme and host, drops default ports, and turns an empty path into `/`.
/// Path case, query order, fragments, and http versus https all stay as typed,
/// so only addresses that mean the same page match. `None` for anything that
/// is not a plain http(s) address.
pub(crate) fn canonical_source_url(raw: &str) -> Option<String> {
    let url = Url::parse(raw.trim()).ok()?;

    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return None;
    }

    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }

    Some(url.to_string())
}

/// SHA-256 and length of everything `reader` yields, read in chunks.
pub(crate) fn hash_reader(mut reader: impl Read) -> io::Result<([u8; 32], u64)> {
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut total = 0u64;

    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        total += read as u64;
    }

    Ok((hasher.finalize().into(), total))
}

pub(crate) fn hash_bytes(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// The stored form of a file digest: raw bytes while encryption is off,
/// sealed with the content key (bound to the item id) while it is on.
pub(crate) fn seal_digest(
    key: Option<&[u8; 32]>,
    item_id: &str,
    digest: &[u8; 32],
) -> Result<Vec<u8>, String> {
    match key {
        Some(key) => encryption::encrypt_bytes(key, digest, &encryption::file_digest_aad(item_id)),
        None => Ok(digest.to_vec()),
    }
}

fn open_digest(
    key: Option<&[u8; 32]>,
    encrypted: bool,
    item_id: &str,
    stored: &[u8],
) -> Result<[u8; 32], String> {
    let bytes = if encrypted {
        let key = key.ok_or_else(|| "Vault is locked".to_string())?;
        encryption::decrypt_bytes(key, stored, &encryption::file_digest_aad(item_id))?
    } else {
        stored.to_vec()
    };

    bytes
        .try_into()
        .map_err(|_| "A saved file fingerprint is damaged".to_string())
}

fn locked_values(locked: &[String]) -> Vec<rusqlite::types::Value> {
    locked
        .iter()
        .cloned()
        .map(rusqlite::types::Value::Text)
        .collect()
}

/// Live, accessible sources whose address means the same page as `canonical`.
/// Trash and locked collections never match. `exclude` is the source being
/// edited, so it never matches itself.
pub(crate) fn find_source_matches(
    connection: &Connection,
    key: Option<&[u8; 32]>,
    locked: &[String],
    canonical: &str,
    exclude: Option<&str>,
) -> Result<Vec<String>, String> {
    let fail = |error: rusqlite::Error| format!("Could not check for duplicates: {error}");
    let sql = format!(
        "SELECT id, url FROM items WHERE kind = 'source' AND deleted_at IS NULL{}",
        locked_filter_sql("collection_id", locked)
    );
    let mut statement = connection.prepare(&sql).map_err(fail)?;
    let rows = statement
        .query_map(params_from_iter(locked_values(locked)), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(fail)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(fail)?;

    let mut matches = Vec::new();
    for (id, column_url) in rows {
        if exclude == Some(id.as_str()) {
            continue;
        }
        let url = match key {
            Some(key) => encryption::read_secret(connection, key, &id)?.url,
            None => column_url,
        };
        if url.as_deref().and_then(canonical_source_url).as_deref() == Some(canonical) {
            matches.push(id);
        }
    }

    Ok(matches)
}

/// Live, accessible files with the same plaintext bytes. Only files of the same
/// size are read, and a file saved before fingerprints existed gets its digest
/// computed and stored the first time a same-size file is checked. A missing
/// managed file is skipped; damaged encrypted bytes are an error, never a
/// silent "no match".
pub(crate) fn find_file_matches(
    connection: &Connection,
    files_dir: &Path,
    key: Option<&[u8; 32]>,
    locked: &[String],
    digest: &[u8; 32],
    byte_size: i64,
) -> Result<Vec<String>, String> {
    let fail = |error: rusqlite::Error| format!("Could not check for duplicates: {error}");
    let sql = format!(
        "SELECT i.id, f.stored_name, f.encrypted, f.content_digest
         FROM files f JOIN items i ON i.id = f.item_id
         WHERE i.deleted_at IS NULL AND f.byte_size = ?{}",
        locked_filter_sql("i.collection_id", locked)
    );
    let mut values = vec![rusqlite::types::Value::Integer(byte_size)];
    values.extend(locked_values(locked));
    let mut statement = connection.prepare(&sql).map_err(fail)?;
    let rows = statement
        .query_map(params_from_iter(values), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)? != 0,
                row.get::<_, Option<Vec<u8>>>(3)?,
            ))
        })
        .map_err(fail)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(fail)?;

    let mut matches = Vec::new();
    for (id, stored_name, encrypted, stored_digest) in rows {
        let saved = match stored_digest {
            Some(stored) => open_digest(key, encrypted, &id, &stored)?,
            None => {
                // ponytail: reads same-size older files while the database lock is
                // held; move to a background pass if first checks get slow.
                let Some(computed) = digest_of_managed_file(files_dir, key, encrypted, &id, &stored_name)? else {
                    continue;
                };
                let sealed = seal_digest(if encrypted { key } else { None }, &id, &computed)?;
                connection
                    .execute(
                        "UPDATE files SET content_digest = ?2 WHERE item_id = ?1",
                        rusqlite::params![id, sealed],
                    )
                    .map_err(fail)?;
                computed
            }
        };
        if &saved == digest {
            matches.push(id);
        }
    }

    Ok(matches)
}

/// Digest of a managed file's plaintext, or `None` when the file is missing.
fn digest_of_managed_file(
    files_dir: &Path,
    key: Option<&[u8; 32]>,
    encrypted: bool,
    id: &str,
    stored_name: &str,
) -> Result<Option<[u8; 32]>, String> {
    let path = files_dir.join(stored_name);
    if !path.is_file() {
        return Ok(None);
    }

    if encrypted {
        let key = key.ok_or_else(|| "Vault is locked".to_string())?;
        let bytes = fs::read(&path).map_err(|error| format!("Could not read a saved file: {error}"))?;
        let plain = encryption::decrypt_file(key, id, &bytes)
            .map_err(|_| "A saved encrypted file is damaged".to_string())?;
        return Ok(Some(hash_bytes(&plain)));
    }

    let file = fs::File::open(&path).map_err(|error| format!("Could not read a saved file: {error}"))?;
    let (digest, _) = hash_reader(file).map_err(|error| format!("Could not read a saved file: {error}"))?;
    Ok(Some(digest))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_addresses_compare_by_meaning_not_spelling() {
        let same = [
            ("https://Example.COM", "https://example.com/"),
            ("  https://example.com/  ", "https://example.com/"),
            ("HTTPS://example.com:443/a", "https://example.com/a"),
            ("http://example.com:80/a", "http://example.com/a"),
        ];
        for (raw, expected) in same {
            assert_eq!(canonical_source_url(raw).as_deref(), Some(expected), "{raw}");
        }

        let different = [
            ("https://example.com/A", "https://example.com/a"),
            ("https://example.com/?a=1&b=2", "https://example.com/?b=2&a=1"),
            ("https://example.com/#one", "https://example.com/#two"),
            ("http://example.com/", "https://example.com/"),
            ("https://example.com:8443/", "https://example.com/"),
            ("https://example.com/?utm_source=x", "https://example.com/"),
        ];
        for (left, right) in different {
            assert_ne!(canonical_source_url(left), canonical_source_url(right), "{left} vs {right}");
        }
    }

    #[test]
    fn non_web_or_credential_addresses_have_no_canonical_form() {
        for raw in [
            "",
            "example.com",
            "ftp://example.com",
            "mailto:a@example.com",
            "https://user:pass@example.com",
            "https://user@example.com",
        ] {
            assert_eq!(canonical_source_url(raw), None, "{raw}");
        }
    }

    #[test]
    fn digests_round_trip_plain_and_sealed() {
        let digest = hash_bytes(b"same bytes");
        let key = encryption::new_vault_key().unwrap();

        let plain = seal_digest(None, "item", &digest).unwrap();
        assert_eq!(plain, digest.to_vec());
        assert_eq!(open_digest(None, false, "item", &plain).unwrap(), digest);

        let sealed = seal_digest(Some(&key), "item", &digest).unwrap();
        assert!(!sealed.windows(32).any(|part| part == digest), "no raw digest at rest");
        assert_eq!(open_digest(Some(&key), true, "item", &sealed).unwrap(), digest);
        assert!(open_digest(Some(&key), true, "other", &sealed).is_err(), "bound to its item");
        assert!(open_digest(None, true, "item", &sealed).is_err());
    }

    #[test]
    fn hashing_a_reader_matches_hashing_bytes() {
        let bytes = vec![7u8; 200_000];
        assert_eq!(hash_reader(&bytes[..]).unwrap(), (hash_bytes(&bytes), 200_000));
    }
}

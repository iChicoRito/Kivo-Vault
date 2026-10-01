#![allow(dead_code)]

#[path = "../src/database.rs"]
mod database;
#[path = "../src/duplicates.rs"]
mod duplicates;
#[path = "../src/encryption.rs"]
mod encryption;
#[path = "../src/key_slots.rs"]
mod key_slots;
#[path = "../src/portability.rs"]
mod portability;
#[path = "../src/security.rs"]
mod security;

use portability::{
    decode_json, encode_json, encode_json_with_report, export_markdown, parse_markdown,
    validate_file_refs, CollectionRecord, FileRecord, ImportReport, PortableItem, VaultDocument,
};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

fn note() -> PortableItem {
    PortableItem {
        kind: "note".into(),
        title: "Title: \"quoted\"".into(),
        description: "summary".into(),
        content: Some("# Body\n\ntext".into()),
        url: None,
        collection: Some("Recipes".into()),
        tags: vec!["a,b".into(), "second".into()],
        is_favorite: true,
        is_pinned: true,
        created_at: "2025-02-03T04:05:06Z".into(),
        updated_at: "2025-03-04T05:06:07Z".into(),
        deleted_at: None,
        file: None,
    }
}

fn document() -> VaultDocument {
    VaultDocument {
        format: 1,
        collections: vec![CollectionRecord {
            name: "Recipes".into(),
        }],
        items: vec![note()],
    }
}

static WORKSPACE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn workspace() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "kivo-portability-{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        WORKSPACE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&path).unwrap();
    path
}

#[test]
fn markdown_round_trip_preserves_supported_note_fields_and_reports_losses() {
    let (text, losses) = export_markdown(&note()).unwrap();
    assert!(text.starts_with("---\n"));
    assert!(losses.iter().any(|x| x.contains("timestamp")));
    assert!(losses.iter().any(|x| x.contains("file")));
    let (restored, report) = parse_markdown(&text).unwrap();
    assert_eq!(restored.title, note().title);
    assert_eq!(restored.tags, note().tags);
    assert_eq!(restored.content, note().content);
    assert_eq!(restored.collection, note().collection);
    assert_eq!(restored.created_at, "");
    assert!(!report.losses.is_empty());
    assert!(export_markdown(&PortableItem {
        kind: "file".into(),
        ..note()
    })
    .is_err());
}

#[test]
fn json_round_trip_preserves_metadata_but_excludes_credentials() {
    let json = encode_json(&document()).unwrap();
    assert!(!json.contains("credentials"));
    assert!(!json.contains("passwords"));
    let (restored, report) = decode_json(&json).unwrap();
    assert_eq!(restored, document());
    assert!(report.skipped.is_empty());
    assert!(report.losses.is_empty());
    assert!(decode_json(r#"{"format":2,"collections":[],"items":[]}"#).is_err());
    assert!(decode_json(
        r#"{"format":1,"collections":[],"items":[],"credentials":[{"secret":"private"}]}"#
    )
    .is_err());
}

#[test]
fn imported_file_paths_reject_traversal_absolute_reserved_and_symlinks() {
    let root = workspace();
    fs::create_dir(root.join("files")).unwrap();
    fs::write(root.join("files/safe.txt"), b"safe").unwrap();
    let mut doc = document();
    doc.items[0].kind = "file".into();
    doc.items[0].file = Some(FileRecord {
        stored_name: "safe.txt".into(),
        original_name: "original.txt".into(),
        byte_size: 4,
    });
    assert!(validate_file_refs(&doc, &root).skipped.is_empty());
    for name in [
        "../escape",
        "C:\\secret",
        "/root",
        "\\\\server\\file",
        "CON.txt",
        "folder/file",
        "missing.txt",
        "safe.txt:ads",
    ] {
        doc.items[0].file.as_mut().unwrap().stored_name = name.into();
        assert_eq!(validate_file_refs(&doc, &root).skipped.len(), 1, "{name}");
    }
    doc.items[0].file.as_mut().unwrap().stored_name = "safe.txt".into();
    doc.items[0].file.as_mut().unwrap().byte_size = 5;
    assert_eq!(validate_file_refs(&doc, &root).skipped.len(), 1);
    doc.items[0].file.as_mut().unwrap().byte_size = 4;
    doc.items.push(PortableItem {
        title: "duplicate".into(),
        ..doc.items[0].clone()
    });
    assert_eq!(
        validate_file_refs(&doc, &root).skipped[0].reason,
        "Duplicate managed file name"
    );
    doc.items.pop();
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_file(
            root.join("files/safe.txt"),
            root.join("files/link.txt"),
        )
        .unwrap();
        doc.items[0].file.as_mut().unwrap().stored_name = "link.txt".into();
        doc.items[0].file.as_mut().unwrap().byte_size = 4;
        assert_eq!(validate_file_refs(&doc, &root).skipped.len(), 1);
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn json_file_record_round_trip_does_not_read_or_change_source_bytes() {
    let root = workspace();
    fs::create_dir(root.join("files")).unwrap();
    fs::write(root.join("files/original.bin"), b"bytes").unwrap();
    let mut doc = document();
    doc.items[0].kind = "file".into();
    doc.items[0].file = Some(FileRecord {
        stored_name: "original.bin".into(),
        original_name: "photo.png".into(),
        byte_size: 5,
    });
    let (decoded, _) = decode_json(&encode_json(&doc).unwrap()).unwrap();
    assert_eq!(decoded, doc);
    assert!(validate_file_refs(&decoded, &root).skipped.is_empty());
    assert_eq!(fs::read(root.join("files/original.bin")).unwrap(), b"bytes");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn unsupported_items_are_skipped_with_reasons_and_valid_items_remain() {
    let mut doc = document();
    doc.items.push(PortableItem {
        kind: "password".into(),
        title: "secret".into(),
        ..note()
    });
    doc.items.push(PortableItem {
        kind: "file".into(),
        title: "no bytes".into(),
        ..note()
    });
    let (json, export_report) = encode_json_with_report(&doc).unwrap();
    assert!(!json.contains("secret"));
    assert_eq!(export_report.skipped.len(), 2);
    assert!(!export_report.losses.is_empty());
    let (imported, report): (VaultDocument, ImportReport) = decode_json(&json).unwrap();
    assert_eq!(imported.items.len(), 1);
    assert!(report.skipped.is_empty());
    let raw = serde_json::to_string(&doc).unwrap();
    let (_, report) = decode_json(&raw).unwrap();
    assert_eq!(report.skipped.len(), 2);
    assert!(report.skipped.iter().all(|s| !s.reason.is_empty()));
}

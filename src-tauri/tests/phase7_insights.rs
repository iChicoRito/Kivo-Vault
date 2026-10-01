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

use insights::{
    build_vector, rank_related, strip_html_to_text, suggest_tag_names, summarize_note,
    RelatedCandidate,
};

#[test]
fn html_text_decodes_entities_and_separates_nested_blocks() {
    assert_eq!(
        strip_html_to_text("<div>One <strong>A&amp;B</strong><p>Two &#x1F642; &#65; &nbsp; three</p><script>hidden</script><style>.x{}</style>Four<br>Five</div>"),
        "One A&B\nTwo 🙂 A three\nFour\nFive"
    );
    assert_eq!(
        strip_html_to_text("Text &bogus; &#0; &lt;ok&gt;"),
        "Text &bogus; &#0; <ok>"
    );
}

#[test]
fn html_text_keeps_plain_angle_brackets_and_quoted_attributes() {
    assert_eq!(
        strip_html_to_text("<p title=\"a > b\">2 < 3 &amp; 4 > 1</p>"),
        "2 < 3 & 4 > 1"
    );
}

#[test]
fn vector_weights_fields_normalizes_and_ignores_url_and_file() {
    let terms = build_vector("note", "Alpha alpha", "Beta", "<p>gamma</p>", &["BETA"]);
    assert_eq!(
        terms,
        vec![
            ("alpha".into(), 1.0),
            ("beta".into(), 0.5),
            ("gamma".into(), 1.0 / 6.0)
        ]
    );
    assert!(build_vector("file", "Alpha", "Beta", "gamma", &[]).is_empty());
    assert_eq!(
        build_vector("source", "Link", "Description", "hidden body", &[]).len(),
        2
    );
    assert!(insights::tokenize("The A café_2026 42 and KO").eq(&["café", "2026", "42", "ko"]));
}

#[test]
fn vector_keeps_only_top_64_terms() {
    let body = (0..70)
        .map(|i| format!("word{i}"))
        .collect::<Vec<_>>()
        .join(" ");
    let terms = build_vector("note", "headline", "", &body, &[]);
    assert_eq!(terms.len(), 64);
    assert_eq!(terms[0], ("headline".to_string(), 1.0));
}

#[test]
fn ranking_uses_shared_weights_then_recency_and_reports_context() {
    let first = build_vector("note", "alpha", "beta gamma", "", &[]);
    let second = build_vector("source", "alpha", "beta", "ignored", &[]);
    let none = build_vector("note", "delta", "", "", &[]);
    let rows = [
        RelatedCandidate {
            id: "old",
            updated_at: "2024-01-01",
            terms: &first,
        },
        RelatedCandidate {
            id: "new",
            updated_at: "2025-01-01",
            terms: &second,
        },
        RelatedCandidate {
            id: "none",
            updated_at: "2026-01-01",
            terms: &none,
        },
    ];
    let hits = rank_related("the ALPHA, beta! gamma", &rows, 2);
    assert_eq!(
        hits.iter().map(|hit| hit.id).collect::<Vec<_>>(),
        vec!["old", "new"]
    );
    assert_eq!(hits[0].matched_terms, vec!["alpha", "beta", "gamma"]);
    assert_eq!(rank_related("alpha", &rows, 1)[0].id, "new");
    assert!(rank_related("unmatched", &rows, 8).is_empty());
}

#[test]
fn suggestions_exclude_existing_tags_case_insensitively_and_limit_five() {
    let tags = suggest_tag_names(
        "note",
        "Rust rust",
        "",
        "<p>Rust crates crates cargo cargo tests tests tools tools code code spare</p>",
        &["RUST", "CrAtEs"],
    );
    assert_eq!(tags, vec!["cargo", "code", "tests", "tools", "spare"]);
    assert!(suggest_tag_names("file", "Rust", "", "Rust", &[]).is_empty());
    assert_eq!(
        suggest_tag_names("source", "Topic", "about topic", "hidden hidden", &[]),
        vec!["topic"]
    );
}

#[test]
fn summaries_choose_representative_sentences_in_reading_order() {
    let html = "<p>Quiet preface.</p><p>Rust search search matters. Search indexing matters!</p><p>Quiet epilogue?</p>";
    assert_eq!(
        summarize_note("note", html),
        vec![
            "Quiet preface.",
            "Rust search search matters.",
            "Search indexing matters!",
            "Quiet epilogue?"
        ]
    );
    assert_eq!(summarize_note("source", html), Vec::<String>::new());
    assert_eq!(
        summarize_note("note", "<p> &nbsp; </p>"),
        Vec::<String>::new()
    );
}

#[test]
fn summary_limits_to_five_and_preserves_original_order() {
    let body = "First. Second. Third. Fourth. Fifth. Sixth. Seventh.";
    assert_eq!(
        summarize_note("note", body),
        vec!["First.", "Second.", "Third.", "Fourth.", "Fifth."]
    );
}

#[test]
fn summary_prefers_repeated_topic_over_early_low_relevance_sentences() {
    let body = "Apple. Banana. Cherry. Date. Elderberry. Index search index. Search index matters.";
    assert_eq!(
        summarize_note("note", body),
        vec![
            "Apple.",
            "Banana.",
            "Cherry.",
            "Index search index.",
            "Search index matters."
        ]
    );
}

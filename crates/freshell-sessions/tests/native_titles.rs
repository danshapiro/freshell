//! Unified agent names (plan Task 3) — native title OBSERVATIONS at the parse
//! and index layer: Claude's custom/AI/agent/summary title records retained
//! SEPARATELY (every one an automatic observation downstream — public native
//! metadata carries no reliable human provenance), the targeted OpenCode
//! first-message lookup for already-named sessions, and the retained
//! OpenCode exact-ID database carried on the by-id hit.

use std::path::{Path, PathBuf};

use freshell_sessions::meta::ParsedSessionMeta;
use freshell_sessions::parse::{
    default_opencode_data_home, opencode_first_user_message_by_id, opencode_session_row_by_id,
    parse_session_content, ParseSessionOptions,
};
use freshell_sessions::resume_resolve::{resolve_resume_input, OpencodeByIdHit, ResolveDeps};

// ── Claude native title records, retained separately ────────────────────────────────

fn parse_lines(lines: &[&str]) -> ParsedSessionMeta {
    let content = lines.join("\n");
    parse_session_content(&content, &ParseSessionOptions::default())
}

/// The four native title record kinds retain their own fields, while the
/// DISPLAY chain (custom > agent > summary > first-message) is unchanged.
#[test]
fn claude_custom_ai_agent_and_summary_titles_are_retained_separately() {
    let meta = parse_lines(&[
        r#"{"type":"user","message":{"role":"user","content":"first real question"},"cwd":"/work/project","sessionId":"11111111-2222-3333-4444-555555555555"}"#,
        r#"{"type":"ai-title","title":"Claude's own summary title"}"#,
        r#"{"type":"agent-name","agentName":"The Agent Name"}"#,
        r#"{"type":"summary","summary":"A generated summary title"}"#,
        r#"{"type":"custom-title","customTitle":"The Native Rename"}"#,
    ]);
    // Retained SEPARATELY — one observation per record kind.
    assert_eq!(meta.custom_title.as_deref(), Some("The Native Rename"));
    assert_eq!(meta.ai_title.as_deref(), Some("Claude's own summary title"));
    assert_eq!(meta.agent_name_title.as_deref(), Some("The Agent Name"));
    assert_eq!(
        meta.summary_title.as_deref(),
        Some("A generated summary title")
    );
    // The display chain is UNCHANGED: custom-title wins.
    assert_eq!(meta.title.as_deref(), Some("The Native Rename"));
    assert!(meta.title_provider_generated);
    assert_eq!(meta.title_source.as_deref(), Some("provider-generated"));
    assert_eq!(
        meta.first_user_message.as_deref(),
        Some("first real question"),
        "the first-message observation is retained independently"
    );
}

/// An AI-generated title alone is retained as its own automatic observation
/// WITHOUT entering the display chain (the pre-Task-3 display behavior).
#[test]
fn claude_ai_title_is_retained_without_entering_the_display_chain() {
    let meta = parse_lines(&[
        r#"{"type":"user","message":{"role":"user","content":"derive my title"},"cwd":"/work/project"}"#,
        r#"{"type":"ai-title","aiTitle":"AI only title"}"#,
    ]);
    assert_eq!(meta.ai_title.as_deref(), Some("AI only title"));
    // The display title stays the first-message derivation; the AI title is
    // provenance for the naming pipeline, not a display override.
    assert_eq!(meta.title.as_deref(), Some("derive my title"));
    assert!(!meta.title_provider_generated);
}

/// A custom-title record equal to an own write stays an AUTOMATIC
/// observation — parse-level equality with a desired name can never prove a
/// human asked; only declared Freshell user intent promotes a record.
#[test]
fn claude_native_records_carry_no_intent_signal() {
    let meta = parse_lines(&[r#"{"type":"custom-title","customTitle":"same text as our write"}"#]);
    assert_eq!(meta.custom_title.as_deref(), Some("same text as our write"));
    // No provenance field exists on the parse layer that could promote this
    // to manual — the naming store decides rank, and the observation always
    // folds as provider-native (automatic).
    assert_eq!(meta.title_source.as_deref(), Some("provider-generated"));
}

// ── OpenCode: the targeted first-message lookup for named sessions ─────────────────

struct TmpDir(PathBuf);
impl TmpDir {
    fn new(label: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "freshell-native-titles-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        TmpDir(dir)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for TmpDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A real-shape opencode.db with one NAMED session and its first user
/// message (the same schema shape tests/opencode_first_message.rs builds).
fn named_session_db(dir: &Path) {
    let db = dir.join("opencode.db");
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute_batch(
        "CREATE TABLE session (
            id TEXT PRIMARY KEY, directory TEXT, title TEXT,
            time_created INTEGER, time_updated INTEGER, time_archived INTEGER,
            project_id TEXT, parent_id TEXT
         );
         CREATE TABLE message (
            id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
         CREATE TABLE part (
            id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);",
    )
    .unwrap();
    conn.execute(
        "INSERT INTO session VALUES ('ses_named', '/repo/x', 'A Real Name', 1000, 5000, NULL, NULL, NULL)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO message VALUES ('msg_1', 'ses_named', 1000, '{\"role\":\"user\"}')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO part VALUES ('prt_1', 'msg_1', 'ses_named', '{\"type\":\"text\",\"text\":\"how do I test this thing\"}')",
        [],
    )
    .unwrap();
}

/// OpenCode already-named sessions require a TARGETED first-message lookup
/// on eligibility: the bounded listing only carries first messages for
/// placeholder-titled rows, so the named row's message is read ON DEMAND
/// (one bounded query, never a full-history scan).
#[test]
fn opencode_named_first_message_lookup_is_targeted() {
    let dir = TmpDir::new("named");
    named_session_db(dir.path());

    let by_row = opencode_session_row_by_id(dir.path(), "ses_named")
        .expect("row query succeeds")
        .expect("the named row resolves");
    assert_eq!(by_row.title.as_deref(), Some("A Real Name"));

    // The targeted lookup reads the named session's first real user message.
    let first = opencode_first_user_message_by_id(dir.path(), "ses_named")
        .expect("targeted lookup succeeds")
        .expect("the named session has a first user message");
    assert_eq!(first, "how do I test this thing");

    // A missing session answers None, never an error.
    assert!(opencode_first_user_message_by_id(dir.path(), "ses_missing")
        .expect("missing is not an error")
        .is_none());
}

/// Name-reliability Task 5 review: a read that FAILED is an error, never
/// the "no user message" answer — the naming sweep remembers answers across
/// passes, so a failure reported as `None` would put off the session's
/// first-message name for the rest of the process's life. A database that
/// cannot be opened and a query that cannot run (here: no `message` table)
/// are both errors; a session with no user message stays `Ok(None)`.
#[test]
fn opencode_first_message_lookup_reports_a_failed_read_as_an_error() {
    let missing = TmpDir::new("no-db");
    assert!(
        opencode_first_user_message_by_id(missing.path(), "ses_named").is_err(),
        "no database: the read failed"
    );

    let broken = TmpDir::new("no-message-table");
    rusqlite::Connection::open(broken.path().join("opencode.db"))
        .unwrap()
        .execute_batch(
            "CREATE TABLE session (
                id TEXT PRIMARY KEY, directory TEXT, title TEXT,
                time_created INTEGER, time_updated INTEGER, time_archived INTEGER,
                project_id TEXT, parent_id TEXT
             );",
        )
        .unwrap();
    let failure = opencode_first_user_message_by_id(broken.path(), "ses_named")
        .expect_err("a query that cannot run is a failed read, not 'no user message'");
    assert!(
        failure.message.contains("no such table"),
        "the failure names what went wrong: {}",
        failure.message
    );

    let silent = TmpDir::new("no-user-message");
    named_session_db(silent.path());
    rusqlite::Connection::open(silent.path().join("opencode.db"))
        .unwrap()
        .execute_batch("DELETE FROM part; DELETE FROM message;")
        .unwrap();
    assert_eq!(
        opencode_first_user_message_by_id(silent.path(), "ses_named")
            .expect("a readable session with no user message is an answer"),
        None
    );
}

/// The retained exact-ID database on the by-id hit travels through the
/// resolve core WITHOUT leaking into any match output (it is internal
/// routing evidence, never user-facing).
#[test]
fn opencode_by_id_hit_carries_the_indexed_database_without_leaking_into_matches() {
    let hit = OpencodeByIdHit {
        session_id: "ses_0123456789abcdefghijklmnop".to_string(),
        cwd: Some("/repo/x".to_string()),
        title: Some("A Real Name".to_string()),
        last_activity_at: Some(5000),
        database: Some("/data/home/opencode/opencode.db".to_string()),
    };
    let deps = ResolveDeps {
        sessions: Some(&[]),
        session_types: &std::collections::HashMap::new(),
        locate_claude_transcript: None,
        opencode_session_by_id: Some(&|id: &str| {
            assert_eq!(id, "ses_0123456789abcdefghijklmnop");
            Ok(Some(OpencodeByIdHit {
                session_id: id.to_string(),
                cwd: hit.cwd.clone(),
                title: hit.title.clone(),
                last_activity_at: hit.last_activity_at,
                database: hit.database.clone(),
            }))
        }),
    };
    let outcome = resolve_resume_input("ses_0123456789abcdefghijklmnop", &deps);
    assert_eq!(outcome.matches.len(), 1);
    let serialized = serde_json::to_string(&outcome.matches[0]).unwrap();
    assert!(
        !serialized.contains("opencode.db"),
        "the retained database is internal routing evidence, never a match field: {serialized}"
    );
    assert_eq!(outcome.matches[0].title.as_deref(), Some("A Real Name"));
}

/// The ambient data home the locator uses is the SAME root the by-id row and
/// the targeted first-message lookup read — the indexed database the hit
/// carries is derived from, never recomputed from a session's directory.
#[test]
fn the_indexed_database_is_derived_from_the_locators_data_home() {
    let root = default_opencode_data_home();
    assert!(
        root.ends_with("opencode"),
        "the data home is the opencode data dir, not a session directory: {root:?}"
    );
}

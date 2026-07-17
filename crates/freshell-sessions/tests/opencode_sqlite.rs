//! Parity + degradation-class tests for the opencode `opencode.db` SQLite parser.
//!
//! There is no committed binary SQLite fixture, so each test builds a fixture DB with a
//! writable connection and then drives the READ-ONLY parser (`OpencodeProvider` /
//! `run_opencode_listing_query`), asserting the reference behavior from
//! `providers/opencode.ts` + `opencode-listing-query.ts`:
//!
//! - root filter (`parent_id IS NULL`) + archived filter (`time_archived IS NULL`)
//! - `ORDER BY time_updated DESC`
//! - the 3-views marker built from whichever of `part`/`message` exist (degrade to
//!   "unmarked" when neither exists, instead of `no such table`)
//! - rows without a cwd are skipped
//! - `project.worktree` -> `project_path`, else fall back to cwd
//! - degrade classes: `missing_db`, `empty_db`, `schema_missing_parent_id`

use freshell_sessions::parse::{
    run_opencode_listing_query, OpencodeDegrade, OpencodeProvider, THREE_VIEWS_MARKER_SQL_PATTERN,
};
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A real temp dir that removes itself on drop (the fixture DBs live under it).
struct TmpDir(PathBuf);
impl TmpDir {
    fn new() -> Self {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "freshell-sessions-oc-{}-{n}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        TmpDir(dir)
    }
}
impl std::ops::Deref for TmpDir {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}
impl Drop for TmpDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn create_full_schema(conn: &Connection) {
    conn.execute_batch(
        "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
         CREATE TABLE session (
            id TEXT PRIMARY KEY,
            directory TEXT,
            title TEXT,
            time_created INTEGER,
            time_updated INTEGER,
            time_archived INTEGER,
            project_id TEXT,
            parent_id TEXT
         );
         CREATE TABLE part (session_id TEXT, data TEXT);
         CREATE TABLE message (session_id TEXT, data TEXT);",
    )
    .unwrap();
}

#[test]
fn full_schema_lists_root_sessions_with_marker_and_ordering() {
    let dir = TmpDir::new();
    let db = dir.join("opencode.db");
    {
        let conn = Connection::open(&db).unwrap();
        create_full_schema(&conn);
        conn.execute("INSERT INTO project VALUES ('proj1', '/repo/worktree')", [])
            .unwrap();
        // root1: newest, marked 3-views via part.data, has a project worktree
        conn.execute(
            "INSERT INTO session VALUES ('ses_root1','/repo/cwd1','Root 1',1000,3000,NULL,'proj1',NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO part VALUES ('ses_root1','prefix <freshell-session-metadata origin=3-views> suffix')",
            [],
        )
        .unwrap();
        // root2: older, no project (project_path falls back to cwd), unmarked
        conn.execute(
            "INSERT INTO session VALUES ('ses_root2','/repo/cwd2','Root 2',1000,2000,NULL,NULL,NULL)",
            [],
        )
        .unwrap();
        // child of root1 -> excluded by root filter
        conn.execute(
            "INSERT INTO session VALUES ('ses_child','/repo/cwd3','Child',1000,4000,NULL,'proj1','ses_root1')",
            [],
        )
        .unwrap();
        // archived -> excluded
        conn.execute(
            "INSERT INTO session VALUES ('ses_arch','/repo/cwd4','Arch',1000,5000,9999,'proj1',NULL)",
            [],
        )
        .unwrap();
        // no cwd -> skipped in mapping
        conn.execute(
            "INSERT INTO session VALUES ('ses_nocwd',NULL,'NoCwd',1000,6000,NULL,NULL,NULL)",
            [],
        )
        .unwrap();
    }

    let provider = OpencodeProvider::new(dir.to_path_buf());
    let listing = provider.list_sessions(42).expect("read ok");

    assert!(
        listing.degrade.is_empty(),
        "no degrade for a healthy non-empty db: {:?}",
        listing.degrade
    );
    let ids: Vec<&str> = listing
        .sessions
        .iter()
        .map(|s| s.session_id.as_str())
        .collect();
    // root1 (updated 3000) before root2 (2000); child/archived/nocwd all excluded.
    assert_eq!(ids, vec!["ses_root1", "ses_root2"]);

    let root1 = &listing.sessions[0];
    assert_eq!(root1.project_path, "/repo/worktree");
    assert_eq!(root1.cwd, "/repo/cwd1");
    assert_eq!(root1.title.as_deref(), Some("Root 1"));
    assert_eq!(root1.created_at, Some(1000));
    assert_eq!(root1.last_activity_at, 3000);
    assert_eq!(root1.is_subagent, Some(true), "3-views marker -> subagent");
    assert_eq!(root1.is_non_interactive, Some(true));

    let root2 = &listing.sessions[1];
    assert_eq!(
        root2.project_path, "/repo/cwd2",
        "no worktree -> fall back to cwd"
    );
    assert_eq!(root2.is_subagent, None, "unmarked session");
    assert_eq!(root2.is_non_interactive, None);
}

#[test]
fn missing_parent_id_column_degrades_and_treats_all_as_roots() {
    let dir = TmpDir::new();
    let db = dir.join("opencode.db");
    {
        let conn = Connection::open(&db).unwrap();
        // No parent_id column, no part/message tables.
        conn.execute_batch(
            "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
             CREATE TABLE session (
                id TEXT PRIMARY KEY, directory TEXT, title TEXT,
                time_created INTEGER, time_updated INTEGER, time_archived INTEGER, project_id TEXT
             );",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session VALUES ('s1','/a','A',1,10,NULL,NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session VALUES ('s2','/b','B',1,20,NULL,NULL)",
            [],
        )
        .unwrap();
    }

    let provider = OpencodeProvider::new(dir.to_path_buf());
    let listing = provider.list_sessions(0).expect("read ok");
    assert!(listing
        .degrade
        .contains(&OpencodeDegrade::SchemaMissingParentId));
    // Both flat sessions are returned as roots, ordered by time_updated DESC.
    let ids: Vec<&str> = listing
        .sessions
        .iter()
        .map(|s| s.session_id.as_str())
        .collect();
    assert_eq!(ids, vec!["s2", "s1"]);
}

#[test]
fn neither_part_nor_message_table_degrades_to_unmarked_no_crash() {
    let dir = TmpDir::new();
    let db = dir.join("opencode.db");
    {
        let conn = Connection::open(&db).unwrap();
        // Core schema is always project+session; only part/message are optional.
        conn.execute_batch(
            "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
             CREATE TABLE session (
                id TEXT PRIMARY KEY, directory TEXT, title TEXT,
                time_created INTEGER, time_updated INTEGER, time_archived INTEGER,
                project_id TEXT, parent_id TEXT
             );",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session VALUES ('s1','/a','A',1,10,NULL,NULL,NULL)",
            [],
        )
        .unwrap();
    }

    // The listing query must NOT throw "no such table: part" — the marker expr degrades to 0.
    let conn = Connection::open(&db).unwrap();
    let result =
        run_opencode_listing_query(&conn, THREE_VIEWS_MARKER_SQL_PATTERN).expect("query ok");
    assert_eq!(result.rows.len(), 1);
    assert_eq!(result.rows[0].has_three_views_marker, Some(0));
}

#[test]
fn empty_db_reports_empty_degrade() {
    let dir = TmpDir::new();
    let db = dir.join("opencode.db");
    {
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
             CREATE TABLE session (
                id TEXT PRIMARY KEY, directory TEXT, title TEXT,
                time_created INTEGER, time_updated INTEGER, time_archived INTEGER,
                project_id TEXT, parent_id TEXT
             );",
        )
        .unwrap();
    }
    let provider = OpencodeProvider::new(dir.to_path_buf());
    let listing = provider.list_sessions(0).expect("read ok");
    assert!(listing.sessions.is_empty());
    assert!(listing.degrade.contains(&OpencodeDegrade::EmptyDb));
}

#[test]
fn missing_db_file_reports_missing_degrade_without_error() {
    let dir = TmpDir::new(); // no opencode.db created
    let provider = OpencodeProvider::new(dir.to_path_buf());
    let listing = provider
        .list_sessions(0)
        .expect("missing db is Ok(empty), not Err");
    assert!(listing.sessions.is_empty());
    assert_eq!(listing.degrade, vec![OpencodeDegrade::MissingDb]);
}

#[test]
fn provider_path_derivations_match_reference() {
    let provider = OpencodeProvider::new(PathBuf::from("/home/u/.local/share/opencode"));
    assert_eq!(
        provider.database_path(),
        PathBuf::from("/home/u/.local/share/opencode/opencode.db")
    );
    // watch-base = dirname(homeDir) = ~/.local/share
    assert_eq!(
        provider.session_watch_bases(),
        vec![PathBuf::from("/home/u/.local/share")]
    );
    assert_eq!(
        provider.session_roots(),
        vec![PathBuf::from("/home/u/.local/share/opencode/opencode.db")]
    );
}

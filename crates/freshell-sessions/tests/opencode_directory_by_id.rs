//! SYNC-06 resolve fallback: by-id `directory` (spawn cwd) lookup — a
//! bug-for-bug port of Node's `resolveOpencodeSessionRoots` walk
//! (`server/coding-cli/providers/opencode.ts:246-250, 265-267, 281,
//! 283-303`, consumed by `resolve-session.ts:59-85`):
//! - LEGACY schema (no `parent_id` column): EVERY requested id HITS with
//!   `directory: None` — Node's early return does no row query, so even a
//!   nonexistent id resolves and an existing row's directory is never read;
//! - MODERN schema: the requested row's OWN `directory` is kept only if
//!   truthy (empty string ⇒ `None`), then the parent chain is walked — a
//!   missing parent row or a cycle is a MISS despite the row existing.

use freshell_sessions::parse::{opencode_session_directory_by_id, OpencodeSessionDirectory};

fn temp_data_home(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "freshell-dir-by-id-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).expect("mkdir temp data home");
    dir
}

fn seed_schema(data_home: &std::path::Path) -> rusqlite::Connection {
    let conn = rusqlite::Connection::open(data_home.join("opencode.db")).expect("open fixture db");
    conn.execute_batch(
        "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
         CREATE TABLE session (
            id TEXT PRIMARY KEY, directory TEXT, title TEXT,
            time_created INTEGER, time_updated INTEGER, time_archived INTEGER,
            project_id TEXT, parent_id TEXT
         );",
    )
    .expect("create schema");
    conn
}

fn seed_legacy_schema(data_home: &std::path::Path) -> rusqlite::Connection {
    // The pre-`parent_id` opencode schema (identical minus that column).
    let conn = rusqlite::Connection::open(data_home.join("opencode.db")).expect("open fixture db");
    conn.execute_batch(
        "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
         CREATE TABLE session (
            id TEXT PRIMARY KEY, directory TEXT, title TEXT,
            time_created INTEGER, time_updated INTEGER, time_archived INTEGER,
            project_id TEXT
         );",
    )
    .expect("create legacy schema");
    conn
}

fn insert(conn: &rusqlite::Connection, id: &str, directory: Option<&str>, parent: Option<&str>) {
    conn.execute(
        "INSERT INTO session (id, directory, parent_id) VALUES (?1, ?2, ?3)",
        rusqlite::params![id, directory, parent],
    )
    .expect("insert row");
}

#[test]
fn child_hit_returns_the_childs_own_directory() {
    let home = temp_data_home("child");
    let conn = seed_schema(&home);
    insert(
        &conn,
        "ses_root0000000000000000000000",
        Some("/repo/root"),
        None,
    );
    insert(
        &conn,
        "ses_child000000000000000000000",
        Some("/repo/child"),
        Some("ses_root0000000000000000000000"),
    );
    // Node collects the REQUESTED row's directory (`opencode.ts:265-267`),
    // NOT the root's, then walks the chain to prove a root is reachable.
    let hit = opencode_session_directory_by_id(&home, "ses_child000000000000000000000")
        .expect("query ok");
    assert_eq!(
        hit,
        Some(OpencodeSessionDirectory {
            directory: Some("/repo/child".to_string())
        })
    );
}

#[test]
fn root_row_hits_with_its_directory() {
    let home = temp_data_home("root");
    let conn = seed_schema(&home);
    insert(
        &conn,
        "ses_plain000000000000000000000",
        Some("/repo/plain"),
        None,
    );
    let hit = opencode_session_directory_by_id(&home, "ses_plain000000000000000000000")
        .expect("query ok");
    assert_eq!(
        hit,
        Some(OpencodeSessionDirectory {
            directory: Some("/repo/plain".to_string())
        })
    );
}

#[test]
fn archived_row_still_resolves() {
    let home = temp_data_home("archived");
    let conn = seed_schema(&home);
    conn.execute(
        "INSERT INTO session (id, directory, time_archived) VALUES (?1, ?2, ?3)",
        rusqlite::params!["ses_arch0000000000000000000000", "/repo/old", 123_i64],
    )
    .expect("insert row");
    let hit = opencode_session_directory_by_id(&home, "ses_arch0000000000000000000000")
        .expect("query ok");
    assert_eq!(
        hit,
        Some(OpencodeSessionDirectory {
            directory: Some("/repo/old".to_string())
        })
    );
}

#[test]
fn missing_row_is_a_miss() {
    let home = temp_data_home("missing");
    let _conn = seed_schema(&home);
    let hit = opencode_session_directory_by_id(&home, "ses_missing0000000000000000000")
        .expect("query ok");
    assert_eq!(hit, None);
}

#[test]
fn orphaned_parent_chain_is_a_miss_despite_the_row_existing() {
    let home = temp_data_home("orphan");
    let conn = seed_schema(&home);
    insert(
        &conn,
        "ses_orphan00000000000000000000",
        Some("/repo/orphan"),
        Some("ses_gone00000000000000000000000"),
    );
    // Node's missing-parent guard (`opencode.ts:292-295`) marks the REQUESTED
    // id unresolved -> `resolve-session.ts:66` -> miss.
    let hit = opencode_session_directory_by_id(&home, "ses_orphan00000000000000000000")
        .expect("query ok");
    assert_eq!(hit, None);
}

#[test]
fn parent_cycle_is_a_miss() {
    let home = temp_data_home("cycle");
    let conn = seed_schema(&home);
    insert(
        &conn,
        "ses_cyca000000000000000000000a",
        Some("/repo/cyca"),
        Some("ses_cycb000000000000000000000b"),
    );
    insert(
        &conn,
        "ses_cycb000000000000000000000b",
        Some("/repo/cycb"),
        Some("ses_cyca000000000000000000000a"),
    );
    // Node's seen-set cycle guard (`opencode.ts:287-290`) -> miss.
    let hit = opencode_session_directory_by_id(&home, "ses_cyca000000000000000000000a")
        .expect("query ok");
    assert_eq!(hit, None);
}

#[test]
fn empty_string_directory_hits_with_directory_none() {
    let home = temp_data_home("emptydir");
    let conn = seed_schema(&home);
    insert(&conn, "ses_empty000000000000000000000", Some(""), None);
    // Truthy filter (`opencode.ts:265`): '' is dropped -> Node omits `cwd`.
    let hit = opencode_session_directory_by_id(&home, "ses_empty000000000000000000000")
        .expect("query ok");
    assert_eq!(hit, Some(OpencodeSessionDirectory { directory: None }));
}

#[test]
fn null_directory_hits_with_directory_none() {
    let home = temp_data_home("nulldir");
    let conn = seed_schema(&home);
    insert(&conn, "ses_dirless0000000000000000000", None, None);
    let hit = opencode_session_directory_by_id(&home, "ses_dirless0000000000000000000")
        .expect("query ok");
    assert_eq!(hit, Some(OpencodeSessionDirectory { directory: None }));
}

#[test]
fn legacy_schema_existing_id_hits_with_directory_none() {
    let home = temp_data_home("legacy");
    let conn = seed_legacy_schema(&home);
    conn.execute(
        "INSERT INTO session (id, directory) VALUES (?1, ?2)",
        rusqlite::params!["ses_legacy00000000000000000000", "/repo/legacy"],
    )
    .expect("insert row");
    // Node's early return (`opencode.ts:246-250`) never reads the row: the
    // directory exists in sqlite but `cwd` is still omitted on the wire.
    let hit = opencode_session_directory_by_id(&home, "ses_legacy00000000000000000000")
        .expect("query ok");
    assert_eq!(hit, Some(OpencodeSessionDirectory { directory: None }));
}

#[test]
fn legacy_schema_nonexistent_id_still_hits() {
    let home = temp_data_home("legacyghost");
    let _conn = seed_legacy_schema(&home);
    // Bug-for-bug: Node fabricates a hit with ZERO existence check on the
    // legacy schema (`opencode.ts:247-250` resolves every requested id).
    let hit = opencode_session_directory_by_id(&home, "ses_ghostleg000000000000000000")
        .expect("query ok");
    assert_eq!(hit, Some(OpencodeSessionDirectory { directory: None }));
}

#[test]
fn missing_db_file_is_ok_none() {
    let home = temp_data_home("nodb");
    let hit =
        opencode_session_directory_by_id(&home, "ses_root0000000000000000000000").expect("benign");
    assert_eq!(hit, None);
}

//! Hardened (#586) opencode exact-id lookup parity: mirrors
//! `server/coding-cli/providers/opencode-by-id-query.ts` — a DIRECT by-id
//! row query. Unlike the #583 parent-walk it includes ARCHIVED and CHILD
//! sessions, returns the full row (title/timestamps), and PROPAGATES read
//! errors (provider unavailable ≠ not found).

use freshell_sessions::parse::{opencode_session_row_by_id, OpencodeByIdRow};

fn temp_data_home(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "freshell-row-by-id-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).expect("mkdir temp data home");
    dir
}

/// The modern opencode schema the by-id query reads: `session` with title +
/// timestamps, plus the `project` table its LEFT JOIN pulls `worktree` from.
fn create_db(data_home: &std::path::Path) -> rusqlite::Connection {
    let conn = rusqlite::Connection::open(data_home.join("opencode.db")).expect("open fixture db");
    conn.execute_batch(
        "CREATE TABLE session (
            id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT,
            title TEXT, project_id TEXT, time_created INTEGER,
            time_updated INTEGER, time_archived INTEGER
         );
         CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);",
    )
    .expect("create schema");
    conn
}

#[allow(clippy::too_many_arguments)]
fn insert_session(
    conn: &rusqlite::Connection,
    id: &str,
    parent_id: Option<&str>,
    directory: Option<&str>,
    title: Option<&str>,
    project_id: Option<&str>,
    time_updated: Option<i64>,
    time_archived: Option<i64>,
) {
    conn.execute(
        "INSERT INTO session (id, parent_id, directory, title, project_id, time_updated, time_archived)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![id, parent_id, directory, title, project_id, time_updated, time_archived],
    )
    .expect("insert session row");
}

fn insert_project(conn: &rusqlite::Connection, id: &str, worktree: &str) {
    conn.execute(
        "INSERT INTO project (id, worktree) VALUES (?1, ?2)",
        rusqlite::params![id, worktree],
    )
    .expect("insert project row");
}

#[test]
fn resolves_a_root_row_with_full_metadata() {
    let home = temp_data_home("root");
    let conn = create_db(&home);
    insert_project(&conn, "prj_beta", "/repo");
    insert_session(
        &conn,
        "ses_beta0000000000000000000000",
        None,
        Some("/repo/beta"),
        Some("beta"),
        Some("prj_beta"),
        Some(1234),
        None,
    );
    let row =
        opencode_session_row_by_id(&home, "ses_beta0000000000000000000000").expect("query ok");
    assert_eq!(
        row,
        Some(OpencodeByIdRow {
            session_id: "ses_beta0000000000000000000000".to_string(),
            cwd: Some("/repo/beta".to_string()),
            title: Some("beta".to_string()),
            created_at: None,
            last_activity_at: Some(1234),
            project_path: Some("/repo".to_string()),
        })
    );
}

#[test]
fn resolves_a_child_row_the_listing_hides() {
    let home = temp_data_home("child");
    let conn = create_db(&home);
    insert_session(
        &conn,
        "ses_root0000000000000000000000",
        None,
        Some("/repo/root"),
        None,
        None,
        None,
        None,
    );
    insert_session(
        &conn,
        "ses_child000000000000000000000",
        Some("ses_root0000000000000000000000"),
        Some("/repo/child"),
        None,
        None,
        None,
        None,
    );
    // Direct row query — the CHILD id resolves with its OWN row, NO parent
    // walk (Node's query has no parent_id filter and never chases the chain).
    let row =
        opencode_session_row_by_id(&home, "ses_child000000000000000000000").expect("query ok");
    let row = row.expect("child row resolves");
    assert_eq!(row.session_id, "ses_child000000000000000000000");
    assert_eq!(row.cwd, Some("/repo/child".to_string()));
}

#[test]
fn resolves_an_archived_row() {
    let home = temp_data_home("archived");
    let conn = create_db(&home);
    insert_session(
        &conn,
        "ses_arch0000000000000000000000",
        None,
        Some("/repo/old"),
        None,
        None,
        None,
        Some(123),
    );
    // time_archived NOT NULL still resolves: the query matches the attach
    // arm, which has no archived filter.
    let row =
        opencode_session_row_by_id(&home, "ses_arch0000000000000000000000").expect("query ok");
    let row = row.expect("archived row resolves");
    assert_eq!(row.cwd, Some("/repo/old".to_string()));
}

#[test]
fn missing_row_is_ok_none() {
    let home = temp_data_home("missing");
    let _conn = create_db(&home);
    let row =
        opencode_session_row_by_id(&home, "ses_missing0000000000000000000").expect("query ok");
    assert_eq!(row, None);
}

#[test]
fn db_without_a_session_table_is_ok_none() {
    let home = temp_data_home("nosessiontable");
    let conn = rusqlite::Connection::open(home.join("opencode.db")).expect("open fixture db");
    conn.execute_batch("CREATE TABLE unrelated (id TEXT PRIMARY KEY);")
        .expect("create unrelated table");
    // Node: `if (!tableNames.has('session')) return null`.
    let row =
        opencode_session_row_by_id(&home, "ses_any00000000000000000000000").expect("query ok");
    assert_eq!(row, None);
}

#[test]
fn db_without_a_project_table_still_resolves_with_null_project_path() {
    let home = temp_data_home("noproject");
    let conn = rusqlite::Connection::open(home.join("opencode.db")).expect("open fixture db");
    conn.execute_batch(
        "CREATE TABLE session (
            id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT,
            title TEXT, project_id TEXT, time_created INTEGER,
            time_updated INTEGER, time_archived INTEGER
         );",
    )
    .expect("create session-only schema");
    insert_session(
        &conn,
        "ses_solo0000000000000000000000",
        None,
        Some("/repo/solo"),
        None,
        None,
        None,
        None,
    );
    // Node: `projectSelect = 'NULL'`, no JOIN — the row still resolves.
    let row =
        opencode_session_row_by_id(&home, "ses_solo0000000000000000000000").expect("query ok");
    let row = row.expect("row resolves without a project table");
    assert_eq!(row.project_path, None);
    assert_eq!(row.cwd, Some("/repo/solo".to_string()));
}

#[test]
fn missing_db_file_is_an_error_not_a_silent_miss() {
    let home = temp_data_home("nodb");
    // Node's DatabaseSync open throws SQLITE_CANTOPEN: the provider is
    // present-but-unreadable, and silence here is the incident class. The
    // code is INTERNAL — kept for structured logs and message fidelity; the
    // wire deliberately omits it for opencode (Node's worker boundary strips
    // `.code` before the wire — see Task 6).
    let err = opencode_session_row_by_id(&home, "ses_any00000000000000000000000")
        .expect_err("missing db file must be an error");
    assert_eq!(err.code.as_deref(), Some("SQLITE_CANTOPEN"));
}

#[test]
fn corrupt_db_file_is_an_error() {
    let home = temp_data_home("corrupt");
    std::fs::write(home.join("opencode.db"), [0xABu8; 64]).expect("write garbage");
    let err = opencode_session_row_by_id(&home, "ses_any00000000000000000000000")
        .expect_err("corrupt db file must be an error");
    assert_eq!(err.code.as_deref(), Some("SQLITE_NOTADB"));
}

#[test]
fn locked_db_is_an_error_after_the_busy_timeout() {
    // REAL contention proof for the load-bearing 500 ms busy timeout: a
    // second connection holds `BEGIN EXCLUSIVE` so the read-only open cannot
    // acquire the shared lock; the busy error surfaces as OpencodeByIdError
    // once the timeout expires.
    let home = temp_data_home("locked");
    let conn = create_db(&home);
    insert_session(
        &conn,
        "ses_lock0000000000000000000000",
        None,
        Some("/repo/lock"),
        None,
        None,
        None,
        None,
    );
    drop(conn);
    let writer = rusqlite::Connection::open(home.join("opencode.db")).expect("open writer");
    writer
        .execute_batch("BEGIN EXCLUSIVE")
        .expect("acquire exclusive lock");

    let started = std::time::Instant::now();
    let err = opencode_session_row_by_id(&home, "ses_lock0000000000000000000000")
        .expect_err("locked db must be an error");
    let elapsed = started.elapsed();
    assert_eq!(err.code.as_deref(), Some("SQLITE_BUSY"));
    // The timeout, not an instant failure: the busy handler retried for
    // ~500 ms before giving up.
    assert!(
        elapsed >= std::time::Duration::from_millis(400),
        "expected the ~500 ms busy timeout to elapse, took {elapsed:?}"
    );

    writer.execute_batch("ROLLBACK").expect("release lock");
}

#[test]
fn real_time_updated_is_floored_to_integer_ms() {
    let home = temp_data_home("realms");
    let conn = create_db(&home);
    conn.execute(
        "INSERT INTO session (id, time_updated) VALUES (?1, ?2)",
        rusqlite::params!["ses_real0000000000000000000000", 1234.9_f64],
    )
    .expect("insert REAL time_updated");
    let row =
        opencode_session_row_by_id(&home, "ses_real0000000000000000000000").expect("query ok");
    let row = row.expect("row resolves");
    assert_eq!(row.last_activity_at, Some(1234));
}

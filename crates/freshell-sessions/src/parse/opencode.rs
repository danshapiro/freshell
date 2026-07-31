//! OpenCode `opencode.db` SQLite listing parser.
//!
//! 1:1 port of `server/coding-cli/providers/opencode-listing-query.ts`
//! (`runOpencodeListingQuery`) + the row-mapping and degradation-class handling from
//! `OpencodeProvider.listSessionsDirect` (`providers/opencode.ts`). `node:sqlite` ->
//! `rusqlite` (bundled). The DB is opened READ-ONLY; the parser never writes.
//!
//! Degradation classes preserved (`missing_db`, `empty_db`, `schema_missing_parent_id`,
//! and the transient `read_error` re-throw that lets the indexer keep previously-listed
//! sessions instead of pruning the sidebar). `sqlite_unavailable` is intentionally
//! dropped: rusqlite is statically linked, so the "Node < 22.5" branch cannot occur.

use std::path::{Path, PathBuf};

use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OpenFlags};

pub const THREE_VIEWS_MARKER_SQL_PATTERN: &str = "%<freshell-session-metadata origin=3-views%";
const OPENCODE_DB_BUSY_TIMEOUT_MS: u64 = 5000;

/// The degradation states the listing can report once (mirrors
/// `OpencodeDatabaseMessageClass`, minus `sqlite_unavailable`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpencodeDegrade {
    MissingDb,
    EmptyDb,
    SchemaMissingParentId,
}

/// Transient read failure. The reference `listSessionsDirect` re-throws this so
/// `refreshDirectProvider` returns early WITHOUT pruning — the port surfaces it as `Err`
/// with the same "preserve cached sessions" contract.
#[derive(Debug)]
pub struct OpencodeReadError(pub String);

impl std::fmt::Display for OpencodeReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "opencode read_error: {}", self.0)
    }
}
impl std::error::Error for OpencodeReadError {}

/// Raw row shape (`OpencodeSessionRow` in `opencode-listing-query.ts`).
#[derive(Debug, Clone, PartialEq)]
pub struct OpencodeSessionRow {
    pub session_id: String,
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub created_at: Option<i64>,
    pub last_activity_at: Option<i64>,
    pub project_path: Option<String>,
    pub has_three_views_marker: Option<i64>,
}

/// `OpencodeListingResult`.
#[derive(Debug, Clone, PartialEq)]
pub struct OpencodeListingResult {
    pub rows: Vec<OpencodeSessionRow>,
    pub schema_missing_parent_id: bool,
}

/// A mapped session (subset of `CodingCliSession` the opencode direct-lister produces).
#[derive(Debug, Clone, PartialEq)]
pub struct OpencodeSession {
    pub session_id: String,
    pub project_path: String,
    pub cwd: String,
    pub title: Option<String>,
    pub created_at: Option<i64>,
    pub last_activity_at: i64,
    pub is_subagent: Option<bool>,
    pub is_non_interactive: Option<bool>,
}

/// Result of a direct listing pass, carrying the (once-)degrade signals for the caller
/// to log — the reference logs these inline via `logDatabaseStateOnce`.
#[derive(Debug, Clone, PartialEq)]
pub struct OpencodeListing {
    pub sessions: Vec<OpencodeSession>,
    pub degrade: Vec<OpencodeDegrade>,
}

fn to_opt_string(v: &SqlValue) -> Option<String> {
    match v {
        SqlValue::Text(s) => Some(s.clone()),
        _ => None,
    }
}

fn to_opt_i64(v: &SqlValue) -> Option<i64> {
    match v {
        SqlValue::Integer(i) => Some(*i),
        SqlValue::Real(f) if f.is_finite() => Some(*f as i64),
        _ => None,
    }
}

/// `runOpencodeListingQuery(dbPath, markerPattern)`.
///
/// Inspects whether `session` exposes `parent_id`, builds the 3-views marker check from
/// whichever of `part`/`message` exist (degrading to unmarked if neither exists, instead
/// of throwing `no such table`), runs the root-session listing, and returns raw rows.
pub fn run_opencode_listing_query(
    conn: &Connection,
    marker_pattern: &str,
) -> rusqlite::Result<OpencodeListingResult> {
    run_opencode_query_inner(conn, marker_pattern, None, None)
}

/// `opencode_locator`'s bounded row-diff read
/// (`docs/plans/2026-07-18-opencode-terminal-restore-spec.md` §5, Slice A): the SAME
/// root-session listing as [`run_opencode_listing_query`], additionally bounded to
/// `s.time_created >= floor_ms` with a `LIMIT` — avoids scanning the full (potentially
/// multi-GB, WAL-mode) `session` table on every locator poll tick.
pub fn run_opencode_candidate_query(
    conn: &Connection,
    marker_pattern: &str,
    floor_ms: i64,
    limit: i64,
) -> rusqlite::Result<OpencodeListingResult> {
    run_opencode_query_inner(conn, marker_pattern, Some(floor_ms), Some(limit))
}

fn run_opencode_query_inner(
    conn: &Connection,
    marker_pattern: &str,
    floor_ms: Option<i64>,
    limit: Option<i64>,
) -> rusqlite::Result<OpencodeListingResult> {
    conn.busy_timeout(std::time::Duration::from_millis(
        OPENCODE_DB_BUSY_TIMEOUT_MS,
    ))?;

    // PRAGMA table_info(session) -> hasParentId
    let has_parent_id = {
        let mut stmt = conn.prepare("PRAGMA table_info(session)")?;
        let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
        let mut found = false;
        for name in names {
            if name? == "parent_id" {
                found = true;
            }
        }
        found
    };
    let root_filter = if has_parent_id {
        "AND s.parent_id IS NULL"
    } else {
        ""
    };

    // Which optional tables exist (the marker can live in part.data and/or message.data).
    let table_names: std::collections::HashSet<String> = {
        let mut stmt = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut set = std::collections::HashSet::new();
        for r in rows {
            set.insert(r?);
        }
        set
    };

    let mut marker_clauses: Vec<&str> = Vec::new();
    let mut marker_params: Vec<String> = Vec::new();
    if table_names.contains("part") {
        marker_clauses
            .push("EXISTS (SELECT 1 FROM part pa WHERE pa.session_id = s.id AND pa.data LIKE ?)");
        marker_params.push(marker_pattern.to_string());
    }
    if table_names.contains("message") {
        marker_clauses
            .push("EXISTS (SELECT 1 FROM message m WHERE m.session_id = s.id AND m.data LIKE ?)");
        marker_params.push(marker_pattern.to_string());
    }
    let marker_expr = if marker_clauses.is_empty() {
        "0".to_string()
    } else {
        format!("({})", marker_clauses.join(" OR "))
    };

    // `floor_ms`/`limit` are internally-produced i64 values (never user/network
    // text), so formatting them directly into the SQL text is safe and keeps the
    // marker parameter list (the only untrusted-shaped input) untouched.
    let floor_clause = match floor_ms {
        Some(f) => format!("AND s.time_created >= {f}"),
        None => String::new(),
    };
    let limit_clause = match limit {
        Some(l) => format!("LIMIT {l}"),
        None => String::new(),
    };

    let sql = format!(
        "SELECT \
            s.id AS sessionId, \
            s.directory AS cwd, \
            s.title AS title, \
            s.time_created AS createdAt, \
            s.time_updated AS lastActivityAt, \
            p.worktree AS projectPath, \
            {marker_expr} AS hasThreeViewsMarker \
         FROM session s \
         LEFT JOIN project p ON p.id = s.project_id \
         WHERE s.time_archived IS NULL \
            {root_filter} \
            {floor_clause} \
         ORDER BY s.time_updated DESC \
         {limit_clause}"
    );

    let mut stmt = conn.prepare(&sql)?;
    let param_refs: Vec<&dyn rusqlite::ToSql> = marker_params
        .iter()
        .map(|p| p as &dyn rusqlite::ToSql)
        .collect();
    let rows_iter = stmt.query_map(param_refs.as_slice(), |row| {
        Ok(OpencodeSessionRow {
            session_id: match row.get::<_, SqlValue>(0)? {
                SqlValue::Text(s) => s,
                other => to_opt_string(&other).unwrap_or_default(),
            },
            cwd: to_opt_string(&row.get::<_, SqlValue>(1)?),
            title: to_opt_string(&row.get::<_, SqlValue>(2)?),
            created_at: to_opt_i64(&row.get::<_, SqlValue>(3)?),
            last_activity_at: to_opt_i64(&row.get::<_, SqlValue>(4)?),
            project_path: to_opt_string(&row.get::<_, SqlValue>(5)?),
            has_three_views_marker: to_opt_i64(&row.get::<_, SqlValue>(6)?),
        })
    })?;

    let mut rows = Vec::new();
    for r in rows_iter {
        rows.push(r?);
    }

    Ok(OpencodeListingResult {
        rows,
        schema_missing_parent_id: !has_parent_id,
    })
}

/// The read-only opencode provider (path derivation + direct listing).
pub struct OpencodeProvider {
    home_dir: PathBuf,
}

impl OpencodeProvider {
    pub fn new(home_dir: impl Into<PathBuf>) -> Self {
        Self {
            home_dir: home_dir.into(),
        }
    }

    /// `getDatabasePath` — `<homeDir>/opencode.db`.
    pub fn database_path(&self) -> PathBuf {
        self.home_dir.join("opencode.db")
    }

    /// `getWatchedDatabasePaths` — `[db, db-wal]`.
    pub fn watched_database_paths(&self) -> [PathBuf; 2] {
        let db = self.database_path();
        let wal = PathBuf::from(format!("{}-wal", db.display()));
        [db, wal]
    }

    /// `getSessionRoots` — `[db]`.
    pub fn session_roots(&self) -> Vec<PathBuf> {
        vec![self.database_path()]
    }

    /// `getSessionWatchBases` — `[dirname(homeDir)]`.
    pub fn session_watch_bases(&self) -> Vec<PathBuf> {
        vec![self
            .home_dir
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| self.home_dir.clone())]
    }

    /// `listSessionsDirect` — missing_db/empty_db/schema_missing_parent_id degrade inline,
    /// row-mapping skips rows without a cwd, and a query failure surfaces as `Err`
    /// (re-throw / preserve-cached semantics). `now_ms` is the injected clock the
    /// reference reads from `Date.now()`.
    /// Cheap per-sweep health probe: is the database still OPENABLE and its
    /// schema page READABLE through the exact open path [`Self::list_sessions`]
    /// uses? A missing db is healthy-absent (matching `list_sessions`'s
    /// `MissingDb` tolerance); a locked, `chmod`ed, or corrupted db errors.
    /// One `sqlite_master` count (a single page read) — never a full listing.
    pub fn health_check(&self) -> Result<(), OpencodeReadError> {
        let db_path = self.database_path();
        if !db_path.exists() {
            return Ok(());
        }
        let conn = Connection::open_with_flags(
            &db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
        )
        .map_err(|e| OpencodeReadError(e.to_string()))?;
        conn.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(()))
            .map_err(|e| OpencodeReadError(e.to_string()))
    }

    pub fn list_sessions(&self, now_ms: i64) -> Result<OpencodeListing, OpencodeReadError> {
        let db_path = self.database_path();
        let mut degrade = Vec::new();

        if !db_path.exists() {
            degrade.push(OpencodeDegrade::MissingDb);
            return Ok(OpencodeListing {
                sessions: Vec::new(),
                degrade,
            });
        }

        let conn = Connection::open_with_flags(
            &db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
        )
        .map_err(|e| OpencodeReadError(e.to_string()))?;

        let result = run_opencode_listing_query(&conn, THREE_VIEWS_MARKER_SQL_PATTERN)
            .map_err(|e| OpencodeReadError(e.to_string()))?;

        if result.schema_missing_parent_id {
            degrade.push(OpencodeDegrade::SchemaMissingParentId);
        }
        if result.rows.is_empty() {
            degrade.push(OpencodeDegrade::EmptyDb);
        }

        let mut sessions = Vec::new();
        for row in result.rows {
            let cwd = match row.cwd {
                Some(ref c) if !c.is_empty() => c.clone(),
                _ => continue,
            };
            // Reference: `row.projectPath || resolveGitRepoRoot(row.cwd)`. The git-root
            // collapse is applied by the indexer's project-path resolver (a later step);
            // when the DB already stores `p.worktree` (the common case) the result is the
            // worktree verbatim, which is what we return here.
            let project_path = row
                .project_path
                .filter(|p| !p.is_empty())
                .unwrap_or_else(|| cwd.clone());
            let is_three_views = row.has_three_views_marker == Some(1);
            sessions.push(OpencodeSession {
                session_id: row.session_id,
                project_path,
                cwd,
                title: row.title,
                created_at: row.created_at,
                last_activity_at: row.last_activity_at.unwrap_or(now_ms),
                is_subagent: if is_three_views { Some(true) } else { None },
                is_non_interactive: if is_three_views { Some(true) } else { None },
            });
        }

        Ok(OpencodeListing { sessions, degrade })
    }

    /// `opencode_locator`'s bounded row-diff read (spec §4.5/§5, Slice A): the
    /// raw root-session rows (id/cwd/created_at/marker — everything the locator
    /// needs to confirm/reject a candidate synchronously) filtered to
    /// `time_created >= floor_ms`, bounded by `limit`. Tolerates a missing DB
    /// (returns empty, no error — the locator has no separate degrade-reporting
    /// need the way `list_sessions` does for the sidebar).
    pub fn list_sessions_since(
        &self,
        floor_ms: i64,
        limit: i64,
    ) -> Result<Vec<OpencodeSessionRow>, OpencodeReadError> {
        let db_path = self.database_path();
        if !db_path.exists() {
            return Ok(Vec::new());
        }

        let conn = Connection::open_with_flags(
            &db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
        )
        .map_err(|e| OpencodeReadError(e.to_string()))?;

        let result =
            run_opencode_candidate_query(&conn, THREE_VIEWS_MARKER_SQL_PATTERN, floor_ms, limit)
                .map_err(|e| OpencodeReadError(e.to_string()))?;

        Ok(result.rows)
    }
}

/// Busy timeout for the existence probe's by-id lookup. Deliberately much
/// shorter than `OPENCODE_DB_BUSY_TIMEOUT_MS` (5000ms): `exists()` runs
/// synchronously on the reconcile path, once per pane — N panes x 5s of
/// WAL lock contention would stall every restart. A still-locked DB is a
/// transient read failure (`Err` => the probe answers Unknown and
/// reconcile's bounded deferral retries), not evidence of absence.
const EXISTENCE_BY_ID_BUSY_TIMEOUT_MS: u64 = 250;

/// Existence-probe by-id lookup: does `<data_home>/opencode.db` hold a
/// `session` row with this id?
///
/// Deliberately NO `parent_id` filter — the attach arm
/// (`opencode --session <id>` -> session.get by id) resolves CHILD
/// sessions the root-filtered listing hides — NO `directory` filter
/// (directory-less roots are real, attachable rows the listing drops at
/// mapping) — and NO `time_archived` filter: opencode's `Session.get`
/// has no archived filter and a live attach to an archived session
/// succeeds (validated against v1.18.9), so archived rows answer
/// `Ok(true)`. The query matches the ATTACH arm, not the listing: any
/// filter the attach arm lacks would answer "absent" for an attachable
/// session — the false-dead-session bug class this function removes.
/// Schema note: only `id` is referenced, so legacy schemas lacking
/// `time_archived` answer normally.
///
/// - `Ok(false)` for a missing DB file (opencode never ran here) or no
///   matching row;
/// - `Err` for ANY read failure (lock contention, corruption, io error,
///   schema variance). LOAD-BEARING: callers must treat `Err` as
///   "unknown", never "absent" — an absent-on-error would let WAL lock
///   contention adjudicate live sessions dead.
pub fn session_exists_by_id(data_home: &Path, session_id: &str) -> Result<bool, OpencodeReadError> {
    let db_path = data_home.join("opencode.db");
    if !db_path.exists() {
        return Ok(false);
    }
    let conn = Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|e| OpencodeReadError(e.to_string()))?;
    conn.busy_timeout(std::time::Duration::from_millis(
        EXISTENCE_BY_ID_BUSY_TIMEOUT_MS,
    ))
    .map_err(|e| OpencodeReadError(e.to_string()))?;
    match conn.query_row(
        "SELECT 1 FROM session WHERE id = ?1",
        rusqlite::params![session_id],
        |_| Ok(()),
    ) {
        Ok(()) => Ok(true),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
        Err(e) => Err(OpencodeReadError(e.to_string())),
    }
}

/// SHORT busy timeout (`opencode-by-id-query.ts:12`): a locked DB must fail
/// FAST — the failure surfaces as provider-unavailable, never "not found".
const OPENCODE_BYID_BUSY_TIMEOUT_MS: u64 = 500;

/// Code-PRESERVING error for the by-id query (the plain `OpencodeReadError`
/// stays for its other consumers). Node's thrown sqlite errors carry a
/// `.code` like `SQLITE_CANTOPEN` at the QUERY layer — but Node's production
/// worker boundary then STRIPS it (`opencode-by-id.worker.ts:41-42`
/// serializes only `{name, message}`; `opencode-by-id-runner.ts:103-106`
/// rebuilds the Error without `.code`), so the code never reaches the wire.
/// We keep the code HERE for structured logging and precise messages; the
/// production closure (Task 6 Step 3b) deliberately maps it to
/// `ProviderFailure { code: None, .. }` — wire parity is message-only for
/// opencode.
#[derive(Debug, Clone, PartialEq)]
pub struct OpencodeByIdError {
    pub code: Option<String>,
    pub message: String,
}

/// Map a rusqlite error to the Node-style `SQLITE_*` code name via
/// `rusqlite::Error::sqlite_error_code()` (available in the pinned 0.31.0).
fn by_id_err(e: rusqlite::Error) -> OpencodeByIdError {
    use rusqlite::ffi::ErrorCode as C;
    let code = e.sqlite_error_code().and_then(|c| match c {
        C::CannotOpen => Some("SQLITE_CANTOPEN"),
        C::DatabaseBusy => Some("SQLITE_BUSY"),
        C::DatabaseLocked => Some("SQLITE_LOCKED"),
        C::NotADatabase => Some("SQLITE_NOTADB"),
        C::PermissionDenied => Some("SQLITE_PERM"),
        C::ReadOnly => Some("SQLITE_READONLY"),
        _ => None,
    });
    OpencodeByIdError {
        code: code.map(str::to_string),
        message: e.to_string(),
    }
}

/// The hardened exact-id row (`OpencodeSessionRow` subset the by-id query
/// selects). `last_activity_at` floored to integer ms (REAL columns possible).
#[derive(Debug, Clone, PartialEq)]
pub struct OpencodeByIdRow {
    pub session_id: String,
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub created_at: Option<i64>,
    pub last_activity_at: Option<i64>,
    pub project_path: Option<String>,
}

/// Hardened (#586) exact-id lookup — 1:1 port of
/// `runOpencodeSessionByIdQuery` (`opencode-by-id-query.ts`). Deliberately
/// includes ARCHIVED and CHILD sessions: an exact id pasted by the user must
/// resolve even when the listing hides it. Errors PROPAGATE (a missing or
/// unreadable DB file is `Err`, matching Node's throwing `DatabaseSync`
/// open — provider unavailable ≠ not found).
pub fn opencode_session_row_by_id(
    data_home: &Path,
    session_id: &str,
) -> Result<Option<OpencodeByIdRow>, OpencodeByIdError> {
    let db_path = data_home.join("opencode.db");
    let conn = Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(by_id_err)?;
    conn.busy_timeout(std::time::Duration::from_millis(
        OPENCODE_BYID_BUSY_TIMEOUT_MS,
    ))
    .map_err(by_id_err)?;

    let table_names: std::collections::HashSet<String> = {
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .map_err(by_id_err)?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(by_id_err)?;
        let mut set = std::collections::HashSet::new();
        for r in rows {
            set.insert(r.map_err(by_id_err)?);
        }
        set
    };
    if !table_names.contains("session") {
        return Ok(None);
    }
    let has_project = table_names.contains("project");
    let project_select = if has_project { "p.worktree" } else { "NULL" };
    let project_join = if has_project {
        "LEFT JOIN project p ON p.id = s.project_id"
    } else {
        ""
    };
    let sql = format!(
        "SELECT s.id, s.directory, s.title, s.time_created, s.time_updated, \
         {project_select} FROM session s {project_join} WHERE s.id = ?1 LIMIT 1"
    );
    match conn.query_row(&sql, rusqlite::params![session_id], |row| {
        Ok(OpencodeByIdRow {
            session_id: match row.get::<_, SqlValue>(0)? {
                SqlValue::Text(s) => s,
                other => to_opt_string(&other).unwrap_or_default(),
            },
            cwd: to_opt_string(&row.get::<_, SqlValue>(1)?),
            title: to_opt_string(&row.get::<_, SqlValue>(2)?),
            created_at: to_opt_i64(&row.get::<_, SqlValue>(3)?),
            last_activity_at: to_opt_i64(&row.get::<_, SqlValue>(4)?),
            project_path: to_opt_string(&row.get::<_, SqlValue>(5)?),
        })
    }) {
        Ok(row) => Ok(Some(row)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(by_id_err(e)),
    }
}

/// `defaultOpencodeDataHome` — `$XDG_DATA_HOME/opencode` -> win `LOCALAPPDATA/opencode`
/// -> `~/.local/share/opencode`.
pub fn default_opencode_data_home() -> PathBuf {
    if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
        if !xdg.is_empty() {
            return PathBuf::from(xdg).join("opencode");
        }
    }
    #[cfg(windows)]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            if !local.is_empty() {
                return PathBuf::from(local).join("opencode");
            }
        }
        if let Some(home) = home_dir() {
            return home.join("AppData").join("Local").join("opencode");
        }
    }
    home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".local")
        .join("share")
        .join("opencode")
}

/// Node `os.homedir()` platform semantics (libuv `uv_os_homedir`): Windows
/// reads `USERPROFILE` (HOME is NEVER consulted); POSIX reads `HOME` when
/// set and non-empty, else the effective user's passwd-entry home
/// (`getpwuid_r`). Rust's `std::env::home_dir()` (un-deprecated since 1.87,
/// MSRV here is 1.96) implements exactly these platform rules, so this
/// delegates to it — same contract as `session_directory::provider_home()`
/// in `freshell-server`. An earlier interim version approximated this as
/// HOME-then-USERPROFILE on ALL platforms.
fn home_dir() -> Option<PathBuf> {
    std::env::home_dir()
}

#[cfg(test)]
mod home_dir_tests {
    use super::home_dir;
    use crate::HOME_ENV_TEST_LOCK;
    use std::path::PathBuf;

    // This helper feeds `default_opencode_data_home()`, which the resolve
    // route's opencode exact-id fallback resolves PER CALL — the same Node
    // `os.homedir()` platform contract as
    // `session_directory::provider_home()` in `freshell-server`: Windows
    // reads USERPROFILE (HOME never consulted); POSIX reads HOME when set
    // and non-empty, else the passwd-entry home (USERPROFILE never
    // consulted). Tests mutate real process env, so they serialize on the
    // crate-wide `HOME_ENV_TEST_LOCK` and save/restore each var.

    /// Save-and-restore guard for one env var; restores on drop, panic
    /// included (same shape as `main.rs`'s `EnvVarGuard` in
    /// `freshell-server`).
    struct EnvVarGuard {
        name: &'static str,
        saved: Option<std::ffi::OsString>,
    }

    impl EnvVarGuard {
        fn unset(name: &'static str) -> Self {
            let saved = std::env::var_os(name);
            std::env::remove_var(name);
            Self { name, saved }
        }

        fn set(name: &'static str, value: &str) -> Self {
            let saved = std::env::var_os(name);
            std::env::set_var(name, value);
            Self { name, saved }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            match self.saved.take() {
                Some(v) => std::env::set_var(self.name, v),
                None => std::env::remove_var(self.name),
            }
        }
    }

    /// The effective user's passwd-entry home (`getpwuid_r`) — the Node
    /// `os.homedir()` POSIX fallback when `HOME` is unset or empty.
    #[cfg(unix)]
    fn passwd_entry_home() -> PathBuf {
        use std::os::unix::ffi::OsStrExt;
        let uid = unsafe { libc::geteuid() };
        let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
        let mut buf = vec![0u8; 16 * 1024];
        let mut result: *mut libc::passwd = std::ptr::null_mut();
        let rc = unsafe {
            libc::getpwuid_r(
                uid,
                &mut pwd,
                buf.as_mut_ptr().cast::<libc::c_char>(),
                buf.len(),
                &mut result,
            )
        };
        assert_eq!(rc, 0, "getpwuid_r must succeed for the effective uid");
        assert!(!result.is_null(), "effective uid must have a passwd entry");
        let dir = unsafe { std::ffi::CStr::from_ptr(pwd.pw_dir) };
        PathBuf::from(std::ffi::OsStr::from_bytes(dir.to_bytes()))
    }

    #[cfg(unix)]
    #[test]
    fn unix_empty_home_uses_passwd_entry_never_userprofile() {
        let _lock = HOME_ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let _home = EnvVarGuard::set("HOME", "");
        let _userprofile = EnvVarGuard::set("USERPROFILE", "/Users/win-fixture");
        assert_eq!(
            home_dir(),
            Some(passwd_entry_home()),
            "an EMPTY HOME must behave like unset HOME: passwd-entry fallback, never USERPROFILE"
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_unset_home_ignores_userprofile_using_passwd_entry() {
        let _lock = HOME_ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let _home = EnvVarGuard::unset("HOME");
        let _userprofile = EnvVarGuard::set("USERPROFILE", "/Users/win-fixture");
        let resolved = home_dir();
        assert_ne!(
            resolved,
            Some(PathBuf::from("/Users/win-fixture")),
            "POSIX must NEVER consult USERPROFILE (Node os.homedir() reads it on Windows only)"
        );
        assert_eq!(
            resolved,
            Some(passwd_entry_home()),
            "with HOME unset, POSIX must resolve the passwd-entry home"
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_home_wins_when_both_are_set() {
        let _lock = HOME_ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let _home = EnvVarGuard::set("HOME", "/home/real");
        let _userprofile = EnvVarGuard::set("USERPROFILE", "/Users/win-fixture");
        assert_eq!(
            home_dir(),
            Some(PathBuf::from("/home/real")),
            "a set, non-empty HOME must win on POSIX (USERPROFILE is never consulted)"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_uses_userprofile_never_home() {
        let _lock = HOME_ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let _home = EnvVarGuard::set("HOME", "C:\\never-consulted");
        let _userprofile = EnvVarGuard::set("USERPROFILE", "C:\\Users\\win-fixture");
        assert_eq!(
            home_dir(),
            Some(PathBuf::from("C:\\Users\\win-fixture")),
            "Windows must read USERPROFILE and never consult HOME (Node os.homedir() parity)"
        );
    }
}

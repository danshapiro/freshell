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

/// A resume-resolve by-id fallback HIT: Node's `resolveOpencodeSessionRoots`
/// walk resolved the requested id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpencodeSessionDirectory {
    /// The requested row's OWN `directory` column — the SPAWN cwd opencode
    /// resumes in (`resolve-session.ts:77-84`: NOT the project root) — kept
    /// only when TRUTHY (`opencode.ts:265-267, 281`). `None` for an empty or
    /// NULL `directory` and for EVERY legacy-schema hit (Node's early return
    /// never reads the row). `None` ⇒ the wire match OMITS `cwd`.
    pub directory: Option<String>,
}

/// One row of the walk: `(directory, parent_id)` for an id, `None` = no row.
type SessionRow = (Option<String>, Option<String>);

fn fetch_session_row(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<SessionRow>, OpencodeReadError> {
    match conn.query_row(
        "SELECT directory, parent_id FROM session WHERE id = ?1",
        rusqlite::params![session_id],
        |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
            ))
        },
    ) {
        Ok(row) => Ok(Some(row)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(OpencodeReadError(e.to_string())),
    }
}

/// Resume-resolve by-id lookup — a bug-for-bug port of Node's
/// `OpencodeProvider.resolveOpencodeSessionRoots`
/// (`server/coding-cli/providers/opencode.ts:239-323`). NOTE the Node
/// consumer has since moved on: the RETIRED pre-#586 resolve consumed this
/// walk directly; hardened Node resolves opencode ids via
/// `resolve-session.ts` → `resolve-fallbacks.ts` → the by-id worker
/// (`providers/opencode-by-id-query.ts`, a DIRECT row query). This walk
/// remains the Rust resolve fallback's interim lookup — a recorded
/// divergence, see `resume_resolve.rs`. This is deliberately NOT the attach-arm
/// existence probe: Node walks the `parent_id` chain, and every quirk of
/// that walk is wire-observable, so all are replicated:
///
/// - LEGACY schema (`session` lacks `parent_id`, detected with the same
///   `PRAGMA table_info(session)` probe the listing uses): return a HIT with
///   `directory: None` for ANY requested id — Node returns early
///   (`opencode.ts:246-250`) with NO row query and NO existence check, so
///   even nonexistent ids hit and existing directories are never read.
/// - MODERN schema: fetch the requested row (missing row ⇒ `Ok(None)`);
///   keep its OWN `directory` only if non-empty (truthy filter,
///   `opencode.ts:265-267, 281`); then walk `parent_id` with a `seen` set —
///   a missing parent row (`opencode.ts:292-295`) or a cycle
///   (`opencode.ts:287-290`) marks the requested id unresolved ⇒ `Ok(None)`
///   even though the row exists; reaching a root (`parent_id` NULL) ⇒ HIT.
///
/// Same read-only open and short busy timeout as [`session_exists_by_id`].
/// `Err` for ANY read failure — the resolve endpoint treats `Err` as a miss
/// (empty matches), never a 5xx (Node likewise degrades: 3 retries then all
/// ids unresolved, `opencode.ts:239-322`).
pub fn opencode_session_directory_by_id(
    data_home: &Path,
    session_id: &str,
) -> Result<Option<OpencodeSessionDirectory>, OpencodeReadError> {
    let db_path = data_home.join("opencode.db");
    if !db_path.exists() {
        return Ok(None);
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

    // PRAGMA table_info(session) -> hasParentId (same detection as the
    // listing's `run_opencode_query_inner`).
    let has_parent_id = {
        let mut stmt = conn
            .prepare("PRAGMA table_info(session)")
            .map_err(|e| OpencodeReadError(e.to_string()))?;
        let names = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| OpencodeReadError(e.to_string()))?;
        let mut found = false;
        for name in names {
            if name.map_err(|e| OpencodeReadError(e.to_string()))? == "parent_id" {
                found = true;
            }
        }
        found
    };
    if !has_parent_id {
        // Node's legacy early return (`opencode.ts:246-250`): every requested
        // id resolves as its own root — no row query, no existence check, no
        // directory read. Bug-for-bug: nonexistent ids HIT, `cwd` omitted.
        return Ok(Some(OpencodeSessionDirectory { directory: None }));
    }

    let Some((directory, first_parent)) = fetch_session_row(&conn, session_id)? else {
        return Ok(None);
    };
    // Truthy filter (`opencode.ts:265-267, 281`): empty string ⇒ no cwd.
    let directory = directory.filter(|d| !d.is_empty());

    // Parent walk (`opencode.ts:283-303`): a missing parent or a cycle marks
    // the REQUESTED id unresolved (`resolve-session.ts:66`) ⇒ miss, even
    // though its own row exists and its directory was already collected.
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    seen.insert(session_id.to_string());
    let mut parent = first_parent;
    while let Some(current) = parent {
        if !seen.insert(current.clone()) {
            return Ok(None); // cycle guard (`opencode.ts:287-290`)
        }
        match fetch_session_row(&conn, &current)? {
            None => return Ok(None), // missing parent (`opencode.ts:292-295`)
            Some((_, next_parent)) => parent = next_parent,
        }
    }
    Ok(Some(OpencodeSessionDirectory { directory }))
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

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
}

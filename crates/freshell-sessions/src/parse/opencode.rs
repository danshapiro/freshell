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
         ORDER BY s.time_updated DESC"
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

//! `OpencodeLocator` — deterministic PTY↔session association for FRESH opencode
//! terminal panes. Sibling module to [`crate::amplifier_locator`]
//! (`docs/plans/2026-07-18-opencode-terminal-restore-spec.md`, §8: a
//! provider-parameterized locator was explicitly rejected — the two providers'
//! detection substrates share zero code).
//!
//! opencode 1.18.x persists sessions in a single SQLite DB
//! (`<data_home>/opencode.db`, WAL mode) — NOT one dir/file per session like
//! amplifier. A new session is a `session` table `INSERT`, not a new directory
//! appearing on disk. So instead of amplifier's directory-appearance +
//! bounded-`events.jsonl`-probe design, this locator does a **row-diff**: on a
//! fresh opencode PTY, arm at CREATE time (no `resumeSessionId`), remembering
//! the terminal's cwd and the arm timestamp; poll (bounded,
//! [`freshell_sessions::parse::opencode::OpencodeProvider::list_sessions_since`])
//! for a NEW root `session` row whose `directory` matches the pane cwd and
//! whose `time_created` lands in the correlation window.
//!
//! ## Why no probe-retry state machine (unlike amplifier)
//!
//! Amplifier's session dir starts empty and `events.jsonl` fills in over
//! several ticks (`session:start` then, later, `session:config`), so a
//! candidate can be `Pending` for a while before it's `Confirmed`/`Rejected`.
//! The opencode `session` row carries every field the locator needs (`id`,
//! `directory`, `parent_id`, `time_archived`, `time_created`, the 3-views
//! marker) in ONE row, all at once — a candidate is confirmed or rejected
//! **synchronously** from that single row, the moment it's observed. This is
//! a genuine simplification (spec §4.2), not a stripped-down port.
//!
//! ## Correlation window — spawn-anchored AND Enter-anchored (spec §4.4)
//!
//! opencode's own row-creation timing (at process spawn vs. lazily at the
//! first prompt) was **not verified** against a real interactive CLI (doing so
//! would require writing to the user's live, multi-GB `opencode.db` — out of
//! scope for a read-only investigation). The design is built to be robust to
//! EITHER timing:
//!
//! - The window's **lower bound is always `arm_ms − PRE_EPSILON_MS`**, never
//!   `Enter − PRE_EPSILON_MS` — this admits a row written any time between
//!   spawn and the first Enter (covers "row at TUI start").
//! - The window's **upper bound (deadline)** is `arm_ms + spawn_window_ms` if
//!   no Enter has been observed yet — a spawn-anchored fallback that lets a
//!   row-at-spawn resolve without ever waiting for input — or
//!   `first_submit_ms + window_ms` once [`OpencodeLocator::note_submit`] has
//!   been called, extending the deadline outward (`submit_ms >= arm_ms`, so
//!   this can only push the deadline later, never earlier).
//! - Any [`OpencodeLocator::tick`] outcome (bound / zero-candidate /
//!   ambiguous) marks the pending evaluation `resolved`; a LATER Enter still
//!   re-opens a fresh evaluation window for a terminal that hasn't been
//!   bound yet (mirrors amplifier's "keep watching" semantics).
//!
//! ## Idle short-circuit (armed-only polling)
//!
//! [`OpencodeLocator::tick`] performs **zero** SQLite reads whenever zero
//! terminals are armed — there is nothing a tick could resolve with no armed
//! terminal to correlate against. Mirrors
//! [`crate::amplifier_locator::AmplifierLocator::tick`]'s identical
//! short-circuit and rationale.
//!
//! ## Bounded reads only (never the full `session` table)
//!
//! `opencode.db` can be multi-gigabytes. Every read this locator issues is
//! [`freshell_sessions::parse::opencode::OpencodeProvider::list_sessions_since`]
//! (`time_created >= floor_ms LIMIT n`), never the unbounded `list_sessions`
//! the History sidebar uses. `floor_ms` is always a per-terminal window lower
//! bound (`arm_ms − PRE_EPSILON_MS`), so the query only ever touches recently
//! created rows.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use crate::parse::opencode::{OpencodeProvider, OpencodeSessionRow};

/// `WINDOW_MS` (mirrors `AMPLIFIER_DIR_APPEAR_WINDOW_MS`): how long after the
/// first Enter/submit a candidate session row may still appear and correlate.
/// Also reused (spec §4.4) as the spawn-anchored fallback duration when no
/// Enter has been observed yet.
pub const OPENCODE_WINDOW_MS: i64 = 2_000;

/// `PRE_EPSILON_MS` (mirrors `AMPLIFIER_DIR_PRE_EPSILON_MS`): a clock-jitter
/// allowance ONLY — how far BEFORE `arm_ms` an observed row's `time_created`
/// may still correlate. Anything older is a foreign/pre-existing session.
pub const OPENCODE_PRE_EPSILON_MS: i64 = 250;

/// Bounded candidate query cap (spec §4.5): a poll tick never scans the full
/// `session` table, only rows at/after each armed terminal's window floor.
const CANDIDATE_QUERY_LIMIT: i64 = 200;

/// A resolved PTY↔session association, ready for the caller (Slice B,
/// `crate::opencode_association` in `freshell-ws`) to bind + broadcast.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Located {
    pub terminal_id: String,
    pub session_id: String,
    pub cwd: String,
}

#[derive(Debug, Clone)]
struct Armed {
    cwd_normalized: String,
    /// When this terminal armed — the window's lower bound is ALWAYS
    /// `arm_ms - pre_epsilon_ms`, regardless of whether/when an Enter lands
    /// (spec §4.4).
    arm_ms: i64,
    /// Root session ids that already existed (within the arm-time bounded
    /// read) at arm time — never candidates for this terminal, independent
    /// of their `time_created` (spec §4.4: "the id-diff snapshot at arm is
    /// the primary safety... any id already present at arm can never bind").
    known_ids: HashSet<String>,
    /// Set by [`OpencodeLocator::note_submit`] on the first Enter; extends
    /// the deadline from the spawn-anchored fallback to the Enter-anchored
    /// bound. `None` until an Enter is observed.
    enter_ms: Option<i64>,
    /// Whether the current pending evaluation has already been drained by a
    /// `tick()` (bound / zero-candidate / ambiguous-refuse). A later
    /// `note_submit` re-opens a fresh evaluation for a still-armed terminal.
    resolved: bool,
}

#[derive(Default)]
struct Inner {
    armed: HashMap<String, Armed>,
}

/// Deterministic, poll-driven PTY↔session correlator for fresh opencode
/// terminals. See the module doc for the row-diff algorithm.
pub struct OpencodeLocator {
    provider: OpencodeProvider,
    window_ms: i64,
    pre_epsilon_ms: i64,
    /// Spawn-anchored fallback deadline duration (spec §4.4 proposes reusing
    /// `window_ms`; kept as a distinct field for clarity even though every
    /// constructor sets it equal to `window_ms`).
    spawn_window_ms: i64,
    inner: Mutex<Inner>,
    /// Counts every bounded `list_sessions_since` read this locator issues —
    /// test/diagnostic hook proving the idle short-circuit in
    /// [`OpencodeLocator::tick`] performs literally zero further DB reads
    /// while no terminal is armed (mirrors `AmplifierLocator::fs_scan_count`).
    db_scan_count: AtomicU64,
}

impl OpencodeLocator {
    /// `data_home` is `<XDG_DATA_HOME|LOCALAPPDATA|~/.local/share>/opencode`
    /// (mirrors `freshell_sessions::parse::opencode::default_opencode_data_home`);
    /// this reads exactly `<data_home>/opencode.db`, never a different root.
    pub fn new(data_home: PathBuf) -> Self {
        Self::with_config(data_home, OPENCODE_WINDOW_MS, OPENCODE_PRE_EPSILON_MS)
    }

    /// Test/diagnostic constructor with explicit window tuning. The
    /// spawn-anchored fallback duration reuses `window_ms` (spec §4.4).
    pub fn with_config(data_home: PathBuf, window_ms: i64, pre_epsilon_ms: i64) -> Self {
        Self {
            provider: OpencodeProvider::new(data_home),
            window_ms,
            pre_epsilon_ms,
            spawn_window_ms: window_ms,
            inner: Mutex::new(Inner::default()),
            db_scan_count: AtomicU64::new(0),
        }
    }

    /// How many terminals are currently armed (test/diagnostic hook).
    pub fn armed_count(&self) -> usize {
        self.lock().armed.len()
    }

    /// How many bounded `list_sessions_since` reads have run so far
    /// (test/diagnostic hook, mirrors `AmplifierLocator::fs_scan_count`).
    pub fn db_scan_count(&self) -> u64 {
        self.db_scan_count.load(Ordering::SeqCst)
    }

    /// Arm a terminal for Enter↔row correlation. Only fresh opencode panes
    /// arm: `mode == "opencode"`, `status_running`, no `resume_session_id`,
    /// and a non-empty `cwd`. Returns whether the terminal was newly armed.
    pub fn arm(
        &self,
        terminal_id: &str,
        mode: &str,
        status_running: bool,
        resume_session_id: Option<&str>,
        cwd: Option<&str>,
        now_ms: i64,
    ) -> bool {
        if mode != "opencode" || !status_running {
            return false;
        }
        if resume_session_id.is_some() {
            return false;
        }
        let Some(cwd) = cwd.filter(|c| !c.is_empty()) else {
            return false;
        };

        let mut inner = self.lock();
        if inner.armed.contains_key(terminal_id) {
            return false;
        }
        let floor_ms = now_ms - self.pre_epsilon_ms;
        let known_ids = self.snapshot_ids(floor_ms);
        inner.armed.insert(
            terminal_id.to_string(),
            Armed {
                cwd_normalized: normalize_cwd(cwd),
                arm_ms: now_ms,
                known_ids,
                enter_ms: None,
                resolved: false,
            },
        );
        true
    }

    /// Stop tracking a terminal (exit, or already resolved/bound).
    pub fn disarm(&self, terminal_id: &str) {
        self.lock().armed.remove(terminal_id);
    }

    /// Note a submit-shaped input (Enter) for an armed terminal at `at_ms`,
    /// (re-)opening a correlation evaluation. Mid-turn Enters never re-open a
    /// STILL-PENDING evaluation (mirrors amplifier's `note_submit`); a
    /// terminal whose previous evaluation already resolved (zero-candidate or
    /// ambiguous) gets a fresh Enter-anchored deadline. Returns whether an
    /// evaluation was (re)opened.
    pub fn note_submit(&self, terminal_id: &str, at_ms: i64) -> bool {
        let mut inner = self.lock();
        let Some(armed) = inner.armed.get_mut(terminal_id) else {
            return false;
        };
        if !armed.resolved && armed.enter_ms.is_some() {
            return false;
        }
        armed.enter_ms = Some(at_ms);
        armed.resolved = false;
        true
    }

    /// Drive one polling cycle at `now_ms`: resolve any armed terminal whose
    /// correlation deadline has passed. Returns every [`Located`] association
    /// resolved this tick (drains — never re-emitted).
    pub fn tick(&self, now_ms: i64) -> Vec<Located> {
        let mut inner = self.lock();
        if inner.armed.is_empty() {
            // Idle short-circuit (module doc): zero armed terminals means
            // zero possible windows to resolve, so skip ALL SQLite reads.
            return Vec::new();
        }
        self.resolve_windows(&mut inner, now_ms)
    }

    // -- internal helpers -----------------------------------------------

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().expect("opencode locator lock poisoned")
    }

    /// Bounded read (`list_sessions_since`), counted for the idle-short-
    /// circuit proof.
    fn query_candidates(&self, floor_ms: i64) -> Vec<OpencodeSessionRow> {
        self.db_scan_count.fetch_add(1, Ordering::SeqCst);
        self.provider
            .list_sessions_since(floor_ms, CANDIDATE_QUERY_LIMIT)
            .unwrap_or_default()
    }

    /// The arm-time "known ids" snapshot (spec §4.4): a bounded read at the
    /// SAME floor this terminal's own window will eventually use, so any
    /// root session id already visible at arm time can never bind to this
    /// terminal, regardless of its `time_created`.
    fn snapshot_ids(&self, floor_ms: i64) -> HashSet<String> {
        self.query_candidates(floor_ms)
            .into_iter()
            .map(|row| row.session_id)
            .collect()
    }

    /// Resolve every armed terminal whose correlation deadline has passed.
    fn resolve_windows(&self, inner: &mut Inner, now_ms: i64) -> Vec<Located> {
        let mut located = Vec::new();
        let terminal_ids: Vec<String> = inner.armed.keys().cloned().collect();

        for terminal_id in terminal_ids {
            let Some(armed) = inner.armed.get(&terminal_id) else {
                continue;
            };
            if armed.resolved {
                continue;
            }
            let deadline = match armed.enter_ms {
                Some(enter_ms) => enter_ms + self.window_ms,
                None => armed.arm_ms + self.spawn_window_ms,
            };
            if now_ms < deadline {
                continue;
            }

            let lower_bound = armed.arm_ms - self.pre_epsilon_ms;
            let cwd_normalized = armed.cwd_normalized.clone();
            let known_ids = armed.known_ids.clone();

            let rows = self.query_candidates(lower_bound);
            let matches: Vec<_> = rows
                .into_iter()
                .filter(|row| {
                    if known_ids.contains(&row.session_id) {
                        return false;
                    }
                    let Some(cwd) = row.cwd.as_deref() else {
                        return false;
                    };
                    if normalize_cwd(cwd) != cwd_normalized {
                        return false;
                    }
                    let Some(created) = row.created_at else {
                        return false;
                    };
                    if created < lower_bound || created > deadline {
                        return false;
                    }
                    if row.has_three_views_marker == Some(1) {
                        return false;
                    }
                    true
                })
                .collect();

            // Whatever the outcome, this evaluation is now resolved: a future
            // Enter may re-open a NEW one.
            if let Some(armed_mut) = inner.armed.get_mut(&terminal_id) {
                armed_mut.resolved = true;
            }

            if matches.is_empty() {
                // Empty Enter/spawn window: keep watching.
                continue;
            }
            if matches.len() > 1 {
                // Never guess: refuse and log (mirrors
                // `amplifier_locator.rs`'s ambiguity refusal).
                tracing::warn!(
                    terminal_id = %terminal_id,
                    candidates = ?matches.iter().map(|r| r.session_id.clone()).collect::<Vec<_>>(),
                    "opencode_locator_ambiguous: multiple cwd-confirmed opencode session rows within the correlation window; refusing to bind"
                );
                continue;
            }

            let row = &matches[0];
            located.push(Located {
                terminal_id: terminal_id.clone(),
                session_id: row.session_id.clone(),
                cwd: cwd_normalized,
            });
            // A successful location fully resolves this terminal: it never
            // needs to correlate again.
            inner.armed.remove(&terminal_id);
        }

        located
    }
}

/// Lexical cwd normalization (mirrors `amplifier_locator::normalize_cwd`):
/// trailing-slash / separator only — no realpath; `std::fs::canonicalize` is
/// used opportunistically where the path exists.
fn normalize_cwd(input: &str) -> String {
    if let Ok(real) = std::fs::canonicalize(input) {
        return real.to_string_lossy().into_owned();
    }
    let lexical = input.replace('\\', "/");
    let trimmed = lexical.trim_end_matches('/');
    if trimmed.is_empty() {
        "/".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::sync::atomic::{AtomicU64 as TestAtomicU64, Ordering as TestOrdering};

    static COUNTER: TestAtomicU64 = TestAtomicU64::new(0);

    fn unique_temp_dir(label: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, TestOrdering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "freshell-opencode-locator-test-{label}-{}-{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Create `<data_home>/opencode.db` with the real `session`/`project`
    /// schema (spec §3.2), open read-write for seeding.
    fn open_seed_db(data_home: &std::path::Path) -> Connection {
        std::fs::create_dir_all(data_home).unwrap();
        let conn = Connection::open(data_home.join("opencode.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
             CREATE TABLE session (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                parent_id TEXT,
                slug TEXT NOT NULL,
                directory TEXT NOT NULL,
                title TEXT NOT NULL,
                version TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL,
                time_archived INTEGER
             );",
        )
        .unwrap();
        conn
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_session(
        conn: &Connection,
        id: &str,
        cwd: &str,
        time_created: i64,
        parent_id: Option<&str>,
        time_archived: Option<i64>,
    ) {
        conn.execute(
            "INSERT INTO project (id, worktree) VALUES (?1, ?2)",
            rusqlite::params![format!("proj-{id}"), cwd],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session
                (id, project_id, parent_id, slug, directory, title, version,
                 time_created, time_updated, time_archived)
             VALUES (?1, ?2, ?3, ?1, ?4, ?1, 'test', ?5, ?5, ?6)",
            rusqlite::params![
                id,
                format!("proj-{id}"),
                parent_id,
                cwd,
                time_created,
                time_archived
            ],
        )
        .unwrap();
    }

    /// Insert a session ALSO carrying the 3-views marker (needs `part`).
    fn insert_three_views_session(conn: &Connection, id: &str, cwd: &str, time_created: i64) {
        insert_session(conn, id, cwd, time_created, None, None);
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS part (
                id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL
             );",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO part (id, session_id, data) VALUES (?1, ?2, ?3)",
            rusqlite::params![
                format!("{id}-part"),
                id,
                "<freshell-session-metadata origin=3-views>"
            ],
        )
        .unwrap();
    }

    // -- 1. fresh root row in window -> exactly one Located. --

    #[test]
    fn fresh_confirmed_row_in_window_resolves_to_located() {
        let home = unique_temp_dir("fresh");
        let db = open_seed_db(&home);
        let locator = OpencodeLocator::new(home.clone());

        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 1_000));
        assert!(locator.note_submit("t1", 1_100));

        insert_session(&db, "ses_fresh1", "/proj", 1_150, None, None);

        let located = locator.tick(1_100 + OPENCODE_WINDOW_MS + 1);
        assert_eq!(located.len(), 1);
        assert_eq!(located[0].terminal_id, "t1");
        assert_eq!(located[0].session_id, "ses_fresh1");
        let _ = std::fs::remove_dir_all(&home);
    }

    // -- 2. parent_id IS NOT NULL -> never a candidate. --

    #[test]
    fn row_with_parent_id_is_never_a_candidate() {
        let home = unique_temp_dir("parent-id");
        let db = open_seed_db(&home);
        let locator = OpencodeLocator::new(home.clone());

        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 0));
        assert!(locator.note_submit("t1", 100));
        insert_session(&db, "ses_child", "/proj", 150, Some("ses_parent"), None);

        let located = locator.tick(100 + OPENCODE_WINDOW_MS + 1);
        assert!(located.is_empty(), "subagent/child row must never bind");
        let _ = std::fs::remove_dir_all(&home);
    }

    // -- 3. time_archived IS NOT NULL -> never a candidate. --

    #[test]
    fn archived_row_is_never_a_candidate() {
        let home = unique_temp_dir("archived");
        let db = open_seed_db(&home);
        let locator = OpencodeLocator::new(home.clone());

        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 0));
        assert!(locator.note_submit("t1", 100));
        insert_session(&db, "ses_archived", "/proj", 150, None, Some(9_999));

        let located = locator.tick(100 + OPENCODE_WINDOW_MS + 1);
        assert!(located.is_empty(), "archived row must never bind");
        let _ = std::fs::remove_dir_all(&home);
    }

    // -- 4. 3-views marker -> never a candidate. --

    #[test]
    fn three_views_marked_row_is_never_a_candidate() {
        let home = unique_temp_dir("three-views");
        let db = open_seed_db(&home);
        let locator = OpencodeLocator::new(home.clone());

        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 0));
        assert!(locator.note_submit("t1", 100));
        insert_three_views_session(&db, "ses_3views", "/proj", 150);

        let located = locator.tick(100 + OPENCODE_WINDOW_MS + 1);
        assert!(located.is_empty(), "3-views-marked row must never bind");
        let _ = std::fs::remove_dir_all(&home);
    }

    // -- 5. cwd mismatch -> never a candidate. --

    #[test]
    fn foreign_cwd_row_is_never_a_candidate() {
        let home = unique_temp_dir("foreign-cwd");
        let db = open_seed_db(&home);
        let locator = OpencodeLocator::new(home.clone());

        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 0));
        assert!(locator.note_submit("t1", 100));
        insert_session(&db, "ses_other_cwd", "/other", 150, None, None);

        let located = locator.tick(100 + OPENCODE_WINDOW_MS + 1);
        assert!(located.is_empty(), "foreign-cwd row must never bind");
        let _ = std::fs::remove_dir_all(&home);
    }

    // -- 6. time_created before arm-epsilon (foreign/pre-existing) -> not matched. --

    #[test]
    fn row_predating_arm_by_more_than_pre_epsilon_is_not_matched() {
        let home = unique_temp_dir("predates-arm");
        let db = open_seed_db(&home);
        // Seed a pre-existing session well before this locator/terminal ever arms.
        insert_session(&db, "ses_ancient", "/proj", 100, None, None);
        let locator = OpencodeLocator::new(home.clone());

        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 5_000));
        assert!(locator.note_submit("t1", 5_100));

        let located = locator.tick(5_100 + OPENCODE_WINDOW_MS + 1);
        assert!(located.is_empty(), "pre-existing row must never bind");
        let _ = std::fs::remove_dir_all(&home);
    }

    // -- 6b. a foreign row created BEFORE arm, but still inside the
    // pre-epsilon allowance, is excluded ONLY by the arm-time known-ids
    // snapshot -- the eventual window's time bound (`arm_ms -
    // pre_epsilon_ms`) alone would admit it (unlike test 6's "ancient" row,
    // which predates arm by more than pre-epsilon and is excluded by the
    // time bound too). This isolates the known-ids snapshot as a guard in
    // its own right, not merely redundant with the time-window floor. --

    #[test]
    fn foreign_row_inside_pre_epsilon_but_before_arm_is_excluded_by_known_ids_snapshot_only() {
        let home = unique_temp_dir("known-ids-snapshot-only");
        let db = open_seed_db(&home);

        // Created at T-100ms, i.e. inside the 250ms pre-epsilon allowance
        // relative to the arm below (T=1_000) -- the window's time-bound
        // lower bound (arm_ms - pre_epsilon_ms = 750) does NOT exclude it.
        insert_session(&db, "ses_pre_arm_foreign", "/proj", 900, None, None);

        let locator = OpencodeLocator::new(home.clone());
        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 1_000));
        assert!(locator.note_submit("t1", 1_100));

        // The real session's row appears strictly after arm.
        insert_session(&db, "ses_real", "/proj", 1_500, None, None);

        let located = locator.tick(1_100 + OPENCODE_WINDOW_MS + 1);
        assert_eq!(
            located.len(),
            1,
            "only the post-arm row must resolve; the pre-arm foreign row \
             (inside pre-epsilon, but pre-dating arm) must never bind despite \
             satisfying the window's time bound"
        );
        assert_eq!(located[0].session_id, "ses_real");
        let _ = std::fs::remove_dir_all(&home);
    }

    // -- 7. two confirmed candidates in one window -> refuse + log, no bind. --

    #[test]
    fn two_confirmed_candidates_in_one_window_refuse_to_bind() {
        let home = unique_temp_dir("ambiguous");
        let db = open_seed_db(&home);
        let locator = OpencodeLocator::new(home.clone());

        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 0));
        assert!(locator.note_submit("t1", 100));
        insert_session(&db, "ses_a", "/proj", 150, None, None);
        insert_session(&db, "ses_b", "/proj", 160, None, None);

        let located = locator.tick(100 + OPENCODE_WINDOW_MS + 1);
        assert!(
            located.is_empty(),
            "ambiguous candidates must never be bound"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    // -- 8. zero candidates (empty Enter) -> keep watching, no bind. --

    #[test]
    fn zero_candidates_keeps_watching_without_disarming() {
        let home = unique_temp_dir("empty-enter");
        open_seed_db(&home);
        let locator = OpencodeLocator::new(home.clone());

        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 0));
        assert!(locator.note_submit("t1", 100));

        let located = locator.tick(100 + OPENCODE_WINDOW_MS + 1);
        assert!(located.is_empty());
        assert_eq!(
            locator.armed_count(),
            1,
            "an empty Enter must not disarm the terminal"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    // -- 9. resume/bound terminal -> never arms. --

    #[test]
    fn terminal_with_resume_session_id_never_arms() {
        let home = unique_temp_dir("resume");
        let locator = OpencodeLocator::new(home.clone());
        let armed = locator.arm(
            "t1",
            "opencode",
            true,
            Some("already-bound-session"),
            Some("/proj"),
            0,
        );
        assert!(!armed);
        assert_eq!(locator.armed_count(), 0);
        let _ = std::fs::remove_dir_all(&home);
    }

    // -- 10. non-opencode mode / not-running -> never arms. --

    #[test]
    fn non_opencode_mode_never_arms() {
        let home = unique_temp_dir("wrong-mode");
        let locator = OpencodeLocator::new(home.clone());
        let armed = locator.arm("t1", "amplifier", true, None, Some("/proj"), 0);
        assert!(!armed);
        assert_eq!(locator.armed_count(), 0);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn not_running_terminal_never_arms() {
        let home = unique_temp_dir("not-running");
        let locator = OpencodeLocator::new(home.clone());
        let armed = locator.arm("t1", "opencode", false, None, Some("/proj"), 0);
        assert!(!armed);
        assert_eq!(locator.armed_count(), 0);
        let _ = std::fs::remove_dir_all(&home);
    }

    // -- 11. disarm stops correlation entirely. --

    #[test]
    fn disarmed_terminal_never_resolves() {
        let home = unique_temp_dir("disarmed");
        let db = open_seed_db(&home);
        let locator = OpencodeLocator::new(home.clone());
        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 0));
        assert!(locator.note_submit("t1", 100));
        locator.disarm("t1");

        insert_session(&db, "ses_after_disarm", "/proj", 150, None, None);
        let located = locator.tick(100 + OPENCODE_WINDOW_MS + 1);

        assert!(located.is_empty());
        assert_eq!(locator.armed_count(), 0);
        let _ = std::fs::remove_dir_all(&home);
    }

    // -- 12. idle short-circuit: tick() while unarmed performs ZERO DB scans. --

    #[test]
    fn tick_while_unarmed_performs_zero_db_scans() {
        let home = unique_temp_dir("idle-no-scan");
        let locator = OpencodeLocator::new(home.clone());
        let baseline = locator.db_scan_count();
        assert_eq!(baseline, 0, "construction must not read the DB eagerly");

        for i in 0..5 {
            let located = locator.tick(i * 1_000);
            assert!(located.is_empty());
        }

        assert_eq!(
            locator.db_scan_count(),
            baseline,
            "tick() must not touch the DB while zero terminals are armed"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    // -- 13. row created while idle never binds to a terminal that arms
    // afterward; a row created strictly after arm still resolves. --

    #[test]
    fn row_created_while_idle_never_binds_but_post_arm_row_still_locates() {
        let home = unique_temp_dir("idle-then-arm");
        let db = open_seed_db(&home);
        let locator = OpencodeLocator::new(home.clone());

        assert!(locator.tick(0).is_empty()); // idle no-op
        insert_session(&db, "ses_idle_leftover", "/proj", 50, None, None);
        assert!(locator.tick(60).is_empty()); // still unarmed -- still a no-op

        // Idle->armed transition well after the leftover row's time_created,
        // so it's excluded both by the arm-time snapshot AND the time bound.
        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 5_000));
        assert!(locator.note_submit("t1", 5_100));

        insert_session(&db, "ses_post_arm", "/proj", 5_150, None, None);
        let located = locator.tick(5_100 + OPENCODE_WINDOW_MS + 1);

        assert_eq!(
            located.len(),
            1,
            "exactly the post-arm row must resolve, never the idle-leftover one"
        );
        assert_eq!(located[0].session_id, "ses_post_arm");
        let _ = std::fs::remove_dir_all(&home);
    }

    // -- 14. row-created-at-spawn (before any Enter) resolves via the
    // spawn-anchored window. --

    #[test]
    fn row_created_at_spawn_before_any_enter_resolves_via_spawn_window() {
        let home = unique_temp_dir("spawn-timing");
        let db = open_seed_db(&home);
        let locator = OpencodeLocator::new(home.clone());

        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 1_000));
        // The row appears shortly after spawn, well BEFORE any Enter.
        insert_session(&db, "ses_at_spawn", "/proj", 1_050, None, None);

        // No note_submit call at all -- the spawn-anchored fallback deadline
        // (arm_ms + spawn_window_ms) must resolve this on its own.
        let located = locator.tick(1_000 + OPENCODE_WINDOW_MS + 1);
        assert_eq!(located.len(), 1);
        assert_eq!(located[0].session_id, "ses_at_spawn");
        let _ = std::fs::remove_dir_all(&home);
    }

    // -- 15. row-created-lazily-at-first-Enter resolves via the
    // Enter-anchored window. --

    #[test]
    fn row_created_lazily_at_first_enter_resolves_via_enter_window() {
        let home = unique_temp_dir("enter-timing");
        let db = open_seed_db(&home);
        let locator = OpencodeLocator::new(home.clone());

        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 1_000));
        // A long delay before the user's first Enter -- longer than
        // spawn_window_ms, so only the Enter-anchored deadline can resolve
        // this (proves the spawn fallback isn't the only path).
        let enter_at = 1_000 + OPENCODE_WINDOW_MS + 500;
        assert!(locator.note_submit("t1", enter_at));
        insert_session(&db, "ses_at_enter", "/proj", enter_at + 50, None, None);

        let located = locator.tick(enter_at + OPENCODE_WINDOW_MS + 1);
        assert_eq!(located.len(), 1);
        assert_eq!(located[0].session_id, "ses_at_enter");
        let _ = std::fs::remove_dir_all(&home);
    }

    // -- 16. missing / empty DB -> tolerated, no panic, no bind. --

    #[test]
    fn tolerates_missing_db_and_locates_once_it_appears() {
        let home = unique_temp_dir("missing-db");
        // Deliberately do NOT create opencode.db before constructing.
        let locator = OpencodeLocator::new(home.clone());

        let located = locator.tick(0);
        assert!(located.is_empty());

        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 1));
        assert!(locator.note_submit("t1", 100));
        // Zero-candidate resolution against a still-missing DB must not panic.
        let located = locator.tick(100 + OPENCODE_WINDOW_MS + 1);
        assert!(located.is_empty());
        assert_eq!(locator.armed_count(), 1, "kept watching, never disarmed");

        // Now the DB appears (mirrors opencode's own lazy-create-on-first-run).
        let db = open_seed_db(&home);
        assert!(locator.note_submit("t1", 100 + OPENCODE_WINDOW_MS + 2));
        insert_session(
            &db,
            "ses_after_db_appears",
            "/proj",
            100 + OPENCODE_WINDOW_MS + 2 + 10,
            None,
            None,
        );
        let located = locator.tick(100 + 2 * OPENCODE_WINDOW_MS + 3);
        assert_eq!(located.len(), 1);
        assert_eq!(located[0].session_id, "ses_after_db_appears");
        let _ = std::fs::remove_dir_all(&home);
    }
}

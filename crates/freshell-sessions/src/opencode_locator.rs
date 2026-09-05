//! `OpencodeLocator` — deterministic PTY↔session association for FRESH opencode
//! terminal panes. Sibling module to the deleted `amplifier_locator` (kata qmpk)
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
//!   `enter_ms + window_ms` once [`OpencodeLocator::note_submit`] has opened
//!   (or re-opened) an evaluation, extending the deadline outward
//!   (`enter_ms >= arm_ms`, so this can only push the deadline later, never
//!   earlier). (`enter_ms` is the anchor of the CURRENT evaluation; the
//!   separate `first_submit_ms` field only feeds `probe_candidates`.)
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
//! the deleted `AmplifierLocator::tick`'s identical
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

/// `WINDOW_MS` (mirrors the deleted `AMPLIFIER_DIR_APPEAR_WINDOW_MS`, kata
/// qmpk): how long after the
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
    /// The FIRST Enter ever observed for this pane — never cleared while
    /// armed; distinguishes "the pane provably has (or soon will have) a
    /// session of its own" from "idle pane typed nothing" for
    /// [`OpencodeLocator::probe_candidates`]. (It is NOT the
    /// correlation-window driver — `enter_ms` keeps that role, including
    /// mid-turn re-open suppression.)
    first_submit_ms: Option<i64>,
    /// Whether the current pending evaluation has already been drained by a
    /// `tick()` (bound / zero-candidate / ambiguous-refuse). A later
    /// `note_submit` re-opens a fresh evaluation for a still-armed terminal.
    resolved: bool,
}

#[derive(Default)]
struct Inner {
    armed: HashMap<String, Armed>,
    /// First ms an evaluated window ended in an ambiguous or contested
    /// refusal for this terminal — the moment identity became RESOLVABLE
    /// but provably unattributable. Sole-candidate emissions never latch
    /// (a drain-side refusal of one is a FOREIGN session; plan-review R2).
    /// Also fed by [`OpencodeLocator::note_resolvable_evidence`] (the ws
    /// identity-invariant sweep's probe phase). Cleared only by
    /// [`OpencodeLocator::disarm`].
    resolvable_evidence_ms: HashMap<String, i64>,
    /// Last [`OpencodeLocator::probe_candidates`] read time per terminal
    /// (throttle; wall-clock ms — the probe is the one locator input whose
    /// caller, the ws identity sweep, runs in real time and supplies no
    /// synthetic clock); cleared by `disarm` alongside the other
    /// per-terminal state.
    last_probe_ms: HashMap<String, i64>,
}

/// Per-terminal probe throttle: at most one bounded candidate read this
/// often for an ever-submitted pane whose windows never latched evidence
/// (plan-review R2, finding 2 — an empty-Enter pane must never become a
/// permanent 2s read loop; the invariant sweep runs every 2s).
const PROBE_THROTTLE_MS: i64 = 60_000;

/// Deterministic, poll-driven PTY↔session correlator for fresh opencode
/// terminals. See the module doc for the row-diff algorithm.
pub struct OpencodeLocator {
    provider: OpencodeProvider,
    /// Retained copy of the data home for by-id reads
    /// ([`OpencodeLocator::classify_resume_target`]) — the original is
    /// consumed into the private `OpencodeProvider`, which exposes no
    /// accessor for it.
    data_home: PathBuf,
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
    /// while no terminal is armed (mirrors the deleted
    /// `AmplifierLocator::fs_scan_count`, kata qmpk).
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
            data_home: data_home.clone(),
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

    /// The first time an evaluated correlation window for this terminal
    /// ended in an ambiguous or contested refusal — a correlatable
    /// cwd-confirmed row existed and could not be attributed — plus any
    /// [`OpencodeLocator::note_resolvable_evidence`] latch (the ws
    /// identity-invariant sweep's probe phase): the moment the pane's
    /// identity became RESOLVABLE (danshapiro/freshell#702 gate input).
    /// `None` means nothing resolvable has ever existed for the pane
    /// (opencode writes its `session` row lazily at the first prompt, so
    /// pre-prompt panes are never evidence). Sole-candidate emissions are
    /// deliberately NOT evidence: the healthy bind discharges via the
    /// identity row, and a drain-side refusal of one
    /// (`session_bound_elsewhere` / `freshagent_*`) is a FOREIGN session.
    /// Cleared by [`OpencodeLocator::disarm`] (terminal exit). No I/O.
    pub fn identity_resolvable_since(&self, terminal_id: &str) -> Option<i64> {
        self.lock().resolvable_evidence_ms.get(terminal_id).copied()
    }

    /// How many bounded `list_sessions_since` reads have run so far
    /// (test/diagnostic hook, mirrors the deleted
    /// `AmplifierLocator::fs_scan_count`, kata qmpk).
    pub fn db_scan_count(&self) -> u64 {
        self.db_scan_count.load(Ordering::SeqCst)
    }

    /// Best-effort resume-target classification for the sidebar rail:
    /// `Some(true)` when the target row exists and has a parent (subagent),
    /// `Some(false)` for a definite root, `None` when unknown (missing
    /// DB/row, read error). Bounded by the 500ms by-id busy timeout; never
    /// panics. This is a READ for display classification only — it does not
    /// participate in association (the candidate SQL keeps refusing
    /// `parent_id` rows by design).
    pub fn classify_resume_target(&self, session_id: &str) -> Option<bool> {
        crate::parse::session_is_subagent_by_id(&self.data_home, session_id)
            .ok()
            .flatten()
    }

    /// The invariant sweep's queue-skip predicate (danshapiro/freshell#702,
    /// delta repair 4): whether an opencode row past the create-age grace
    /// should be QUEUED for the sweep's probe phase at all — armed AND no
    /// latched resolvable evidence AND ever-submitted
    /// (`first_submit_ms.is_some()`) AND outside the [`PROBE_THROTTLE_MS`]
    /// window since the last probe. ONE mutex lock, no I/O. The armed /
    /// ever-submitted / throttle guards mirror
    /// [`OpencodeLocator::probe_candidates`]' own (defense in depth — it
    /// still answers `None` with zero DB reads for the same classes even if
    /// a caller queues one anyway); the no-latched-evidence leg is the
    /// sweep's queueing rule (only latch-miss panes are ever queued). The
    /// predicate exists so a pane that can never yield candidates — the
    /// #702 idle never-submitted class — is never queued at all, sparing a
    /// per-sweep `spawn_blocking` round-trip that would only return `None`.
    pub fn probe_eligible(&self, terminal_id: &str, now_ms: i64) -> bool {
        let inner = self.lock();
        let Some(armed) = inner.armed.get(terminal_id) else {
            return false;
        };
        if inner.resolvable_evidence_ms.contains_key(terminal_id) {
            return false;
        }
        if armed.first_submit_ms.is_none() {
            return false;
        }
        inner
            .last_probe_ms
            .get(terminal_id)
            .is_none_or(|t| now_ms - t >= PROBE_THROTTLE_MS)
    }

    /// The READ half of the late-row probe (danshapiro/freshell#702, delta
    /// repair 2): for an ARMED terminal that has ever submitted, at most ONE
    /// bounded `list_sessions_since(arm_ms − pre_epsilon)` read per
    /// `PROBE_THROTTLE_MS`, returning every session id passing the same
    /// candidate filters `resolve_windows` applies (cwd match, no
    /// `parent_id` rows, no 3-views-marked rows, not in the arm-time
    /// `known_ids`, `time_created >= arm_ms − pre_epsilon`) with NO deadline
    /// (`deadline: None` — a late-landing row still counts).
    ///
    /// Availability exclusions (session claimed by a live-or-retired
    /// terminal, fresh-agent ledger rows, LIVE fresh-opencode sessions) and
    /// the evidence LATCH are deliberately NOT here — they are the caller's
    /// job so they can be applied against CURRENT async state AFTER this
    /// read: the ws identity-invariant sweep's probe phase runs this on the
    /// blocking pool, then awaits `has_live_session` per candidate (a live
    /// set snapshotted BEFORE this read is stale by construction —
    /// `handle_send` keys the fresh-opencode sessions map mid-tick), and
    /// only then calls [`OpencodeLocator::note_resolvable_evidence`].
    ///
    /// Returns `None` — with ZERO DB reads — when the terminal is unarmed,
    /// when it has never submitted (the #702 idle never-typed class has no
    /// session of its own, so nothing is attributable), when a probe ran
    /// within the throttle window, or when the terminal disarmed mid-probe
    /// (drop, never resurrect). Returns `Some(vec)` (possibly empty) only
    /// when the bounded read actually ran; the `last_probe_ms` throttle
    /// stamp is written ONLY for such attempted reads, and only when the
    /// terminal is still armed after the read. The throttle clock is the
    /// wall clock — this is the one locator entry point whose caller (the
    /// ws sweep) runs in real time, so it takes no synthetic `now`
    /// (unlike `arm` / `note_submit` / `tick`).
    pub fn probe_candidates(&self, terminal_id: &str) -> Option<Vec<String>> {
        let now_ms = wall_now_ms();
        let (armed, throttled) = {
            let inner = self.lock();
            (
                inner.armed.get(terminal_id).cloned(),
                inner
                    .last_probe_ms
                    .get(terminal_id)
                    .is_some_and(|t| now_ms - t < PROBE_THROTTLE_MS),
            )
        };
        if throttled {
            return None; // throttle before ANY DB read (R2 finding 2)
        }
        let armed = armed?;
        // Never typed: no session of its own exists — no read (the #702 idle
        // never-submitted class; nothing is attributable to the pane).
        armed.first_submit_ms?;
        let lower_bound = armed.arm_ms - self.pre_epsilon_ms;
        let candidates: Vec<String> = self
            .query_candidates(lower_bound) // OFF the lock: bounded read
            .into_iter()
            .filter(|row| {
                row_is_candidate(
                    row,
                    lower_bound,
                    None,
                    &armed.known_ids,
                    &armed.cwd_normalized,
                )
            })
            .map(|row| row.session_id)
            .collect();
        let mut inner = self.lock();
        if !inner.armed.contains_key(terminal_id) {
            // Disarmed mid-probe: the pane is gone — drop, never resurrect
            // (and never stamp the throttle for it).
            return None;
        }
        inner.last_probe_ms.insert(terminal_id.to_string(), now_ms);
        Some(candidates)
    }

    /// The LATCH half of the late-row probe (delta repair 2): called by the
    /// ws identity-invariant sweep's probe phase after a probe candidate
    /// survives every availability exclusion. Under the lock, if the
    /// terminal is still armed, record this as its FIRST
    /// resolvable-evidence time
    /// (`resolvable_evidence_ms.entry(...).or_insert(at_ms)` — first
    /// evidence wins, matching the window latch) and return the stored
    /// value. Returns `None` — dropping the evidence — when the terminal
    /// disarmed between the caller's read and this call: identity evidence
    /// must never resurrect for a gone pane. No I/O.
    pub fn note_resolvable_evidence(&self, terminal_id: &str, at_ms: i64) -> Option<i64> {
        let mut inner = self.lock();
        if !inner.armed.contains_key(terminal_id) {
            return None;
        }
        Some(
            *inner
                .resolvable_evidence_ms
                .entry(terminal_id.to_string())
                .or_insert(at_ms),
        )
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
                first_submit_ms: None,
                resolved: false,
            },
        );
        true
    }

    /// Stop tracking a terminal (exit, or already resolved/bound).
    pub fn disarm(&self, terminal_id: &str) {
        let mut inner = self.lock();
        inner.armed.remove(terminal_id);
        inner.resolvable_evidence_ms.remove(terminal_id);
        inner.last_probe_ms.remove(terminal_id);
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
        if armed.first_submit_ms.is_none() {
            armed.first_submit_ms = Some(at_ms);
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

        // Contested-cwd census over CONTENDERS -- armed terminals with an
        // in-flight (unresolved) evaluation window -- mirroring the codex
        // locator's cross-tick census (codex_locator.rs). One new session
        // row landing inside >=2 same-cwd windows is unattributable: without
        // this census whichever terminal evaluates first silently claims a
        // sibling pane's session (and the sibling could claim it too). A
        // resolved (or never-armed) same-cwd pane is NOT a contender, so an
        // idle sibling never starves a later solo Enter (the codex census's
        // P2 rule). Computed BEFORE the per-terminal loop so a terminal
        // resolving mid-loop still counts against its cwd-mates this tick.
        let mut cwd_counts: HashMap<String, usize> = HashMap::new();
        for a in inner.armed.values() {
            if !a.resolved {
                *cwd_counts.entry(a.cwd_normalized.clone()).or_insert(0) += 1;
            }
        }

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
                    row_is_candidate(
                        row,
                        lower_bound,
                        Some(deadline),
                        &known_ids,
                        &cwd_normalized,
                    )
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
                // the deleted `amplifier_locator.rs`'s ambiguity refusal).
                tracing::warn!(
                    terminal_id = %terminal_id,
                    candidates = ?matches.iter().map(|r| r.session_id.clone()).collect::<Vec<_>>(),
                    "opencode_locator_ambiguous: multiple cwd-confirmed opencode session rows within the correlation window; refusing to bind"
                );
                // Candidate-evidence latch: this refusal provably observed a
                // correlatable row it could not attribute. First evidence wins.
                inner
                    .resolvable_evidence_ms
                    .entry(terminal_id.clone())
                    .or_insert(now_ms);
                continue;
            }

            if cwd_counts.get(&cwd_normalized).copied().unwrap_or(0) >= 2 {
                // Contested cwd (see the census above): a sole candidate
                // visible to >=2 same-cwd in-flight windows is
                // unattributable — refuse (never guess). Refusal never
                // disarms: a later solo Enter re-evaluates.
                tracing::warn!(
                    terminal_id = %terminal_id,
                    session_id = %matches[0].session_id,
                    "opencode_locator_contested_cwd: >=2 contenders (in-flight evaluation windows) share this cwd; refusing to bind"
                );
                // Candidate-evidence latch: this refusal provably observed a
                // correlatable row it could not attribute. First evidence wins.
                inner
                    .resolvable_evidence_ms
                    .entry(terminal_id.clone())
                    .or_insert(now_ms);
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

/// The shared per-row candidate predicate for `resolve_windows` and
/// `probe_candidates`: a session row is a candidate for an armed terminal
/// when it is not in the arm-time `known_ids` snapshot, its cwd normalizes
/// to the terminal's cwd, its `time_created` is at/after `lower_bound`
/// (`arm_ms − pre_epsilon_ms`) and — when `deadline` is `Some` (the
/// correlation window; the probe passes `None` — no upper bound — so a
/// late-landing row still counts) — at/below it, and it carries no 3-views
/// marker. (`parent_id IS NULL` and `time_archived IS NULL` are refused
/// SQL-side by `list_sessions_since`; both callers go through
/// `query_candidates`.)
fn row_is_candidate(
    row: &OpencodeSessionRow,
    lower_bound: i64,
    deadline: Option<i64>,
    known_ids: &HashSet<String>,
    cwd_normalized: &str,
) -> bool {
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
    if created < lower_bound || deadline.is_some_and(|d| created > d) {
        return false;
    }
    if row.has_three_views_marker == Some(1) {
        return false;
    }
    true
}

/// Lexical cwd normalization (mirrors the deleted `amplifier_locator`'s):
/// trailing-slash / separator only — no realpath; `std::fs::canonicalize` is
/// used opportunistically where the path exists.
pub(crate) fn normalize_cwd(input: &str) -> String {
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

/// Wall-clock now in milliseconds — used ONLY by [`OpencodeLocator::probe_candidates`]'s
/// throttle (`last_probe_ms`), the one locator input whose caller (the ws
/// identity-invariant sweep) runs in real time and supplies no synthetic
/// clock (every other entry point — `arm` / `note_submit` / `tick` /
/// `note_resolvable_evidence` — takes its timestamps explicitly).
fn wall_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
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

    #[test]
    fn classify_resume_target_answers_child_root_unknown() {
        let home = unique_temp_dir("classify");
        let db = open_seed_db(&home);
        let locator = OpencodeLocator::new(home.clone());
        insert_session(&db, "ses_root", "/proj", 100, None, None);
        insert_session(&db, "ses_child", "/proj", 150, Some("ses_root"), None);

        assert_eq!(locator.classify_resume_target("ses_child"), Some(true));
        assert_eq!(locator.classify_resume_target("ses_root"), Some(false));
        assert_eq!(locator.classify_resume_target("ses_missing"), None);
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

    // -- 16b. contested cwd: ONE new row inside TWO armed same-cwd
    // terminals' windows must bind NEITHER (mirrors the codex locator's
    // contested-cwd census, codex_locator.rs). Without the census, pane A
    // silently claims pane B's session row AND pane B claims it too --
    // the same session id bound to two different panes. --

    #[test]
    fn one_row_inside_two_same_cwd_windows_binds_neither_terminal() {
        let home = unique_temp_dir("contested-cwd");
        let db = open_seed_db(&home);
        let locator = OpencodeLocator::new(home.clone());

        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 0));
        assert!(locator.arm("t2", "opencode", true, None, Some("/proj"), 10));
        assert!(locator.note_submit("t1", 100));
        assert!(locator.note_submit("t2", 150));

        // Pane t2's real session row -- created after BOTH arms, same cwd,
        // so it is a candidate inside BOTH evaluation windows.
        insert_session(&db, "ses_contested", "/proj", 200, None, None);

        let located = locator.tick(150 + OPENCODE_WINDOW_MS + 1);
        assert!(
            located.is_empty(),
            "a row claimable by >=2 same-cwd contenders is unattributable and \
             must bind NOBODY, got: {located:?}"
        );
        assert_eq!(
            locator.armed_count(),
            2,
            "contested refusal must not disarm (a later solo Enter re-evaluates)"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    // -- 16c. no starvation: an armed same-cwd sibling with NO in-flight
    // evaluation window (its spawn-anchored evaluation already resolved
    // empty) is NOT a contender -- a later solo Enter still binds. Mirrors
    // the codex census's contender definition (in-flight windows only;
    // codex_locator.rs P2 incident 2026-07-27). --

    #[test]
    fn solo_enter_still_binds_when_same_cwd_sibling_has_no_open_window() {
        let home = unique_temp_dir("census-no-starvation");
        let db = open_seed_db(&home);
        let locator = OpencodeLocator::new(home.clone());

        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 0));
        assert!(locator.arm("t2", "opencode", true, None, Some("/proj"), 10));
        // Both spawn-anchored evaluations resolve EMPTY (no rows yet).
        assert!(locator.tick(10 + OPENCODE_WINDOW_MS + 1).is_empty());
        assert_eq!(locator.armed_count(), 2);

        // Only t2 re-opens a window (solo Enter); its row appears inside it.
        let enter_at = 10_000;
        assert!(locator.note_submit("t2", enter_at));
        insert_session(&db, "ses_solo", "/proj", enter_at + 50, None, None);

        let located = locator.tick(enter_at + OPENCODE_WINDOW_MS + 1);
        assert_eq!(
            located.len(),
            1,
            "an idle armed sibling must not starve the solo contender"
        );
        assert_eq!(located[0].terminal_id, "t2");
        assert_eq!(located[0].session_id, "ses_solo");
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

    // -- 17. resolvable-evidence latch (issue #702): the invariant gate's
    // "a correlatable row provably existed" signal. --

    #[test]
    fn no_candidate_ever_seen_reports_no_evidence() {
        // The #702 false-fire class: a fresh pane whose user has not
        // submitted a prompt has NO session row anywhere (opencode writes it
        // lazily at first prompt) -- neither the empty spawn-anchored
        // evaluation nor a later empty Enter is resolvable identity.
        let home = unique_temp_dir("evidence-none");
        open_seed_db(&home);
        let locator = OpencodeLocator::new(home.clone());

        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 1_000));
        // Spawn-anchored window closes with zero candidates.
        assert!(locator.tick(1_000 + OPENCODE_WINDOW_MS + 1).is_empty());
        assert_eq!(locator.identity_resolvable_since("t1"), None);

        // An empty Enter (no row created) also yields no evidence.
        let enter_at = 10_000;
        assert!(locator.note_submit("t1", enter_at));
        assert!(locator.tick(enter_at + OPENCODE_WINDOW_MS + 1).is_empty());
        assert_eq!(locator.identity_resolvable_since("t1"), None);
        assert_eq!(locator.identity_resolvable_since("never-armed"), None);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn ambiguous_candidates_latch_resolvable_evidence() {
        let home = unique_temp_dir("evidence-ambiguous");
        let db = open_seed_db(&home);
        let locator = OpencodeLocator::new(home.clone());

        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 0));
        assert!(locator.note_submit("t1", 100));
        insert_session(&db, "ses_a", "/proj", 150, None, None);
        insert_session(&db, "ses_b", "/proj", 160, None, None);

        let evidence_at = 100 + OPENCODE_WINDOW_MS + 1;
        assert!(locator.tick(evidence_at).is_empty(), "still refused");
        assert_eq!(locator.identity_resolvable_since("t1"), Some(evidence_at));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn contested_cwd_latches_evidence_for_every_contender() {
        let home = unique_temp_dir("evidence-contested");
        let db = open_seed_db(&home);
        let locator = OpencodeLocator::new(home.clone());

        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 0));
        assert!(locator.arm("t2", "opencode", true, None, Some("/proj"), 10));
        assert!(locator.note_submit("t1", 100));
        assert!(locator.note_submit("t2", 150));
        insert_session(&db, "ses_contested", "/proj", 200, None, None);

        let evidence_at = 150 + OPENCODE_WINDOW_MS + 1;
        assert!(
            locator.tick(evidence_at).is_empty(),
            "contested: binds nobody"
        );
        assert_eq!(locator.identity_resolvable_since("t1"), Some(evidence_at));
        assert_eq!(locator.identity_resolvable_since("t2"), Some(evidence_at));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn located_emission_never_latches_evidence() {
        // Plan-review R2, finding 1: a sole-candidate emission is NOT this
        // pane's resolvable-identity evidence. The healthy bind discharges
        // via the identity row; a drain-side refusal of a sole candidate
        // (`session_bound_elsewhere`, `freshagent_*`) is a FOREIGN session —
        // latching it would false-alarm 10s later on a pane whose own row
        // may never have existed. Ambiguity/contested refusals are the only
        // window-latch producers.
        let home = unique_temp_dir("evidence-no-emission");
        let db = open_seed_db(&home);
        let locator = OpencodeLocator::new(home.clone());

        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 1_000));
        assert!(locator.note_submit("t1", 1_100));
        insert_session(&db, "ses_emitted", "/proj", 1_150, None, None);

        let located = locator.tick(1_100 + OPENCODE_WINDOW_MS + 1);
        assert_eq!(located.len(), 1);
        assert_eq!(locator.armed_count(), 0, "emission disarms");
        assert_eq!(
            locator.identity_resolvable_since("t1"),
            None,
            "a sole-candidate emission must never count as evidence"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn disarm_clears_resolvable_evidence() {
        let home = unique_temp_dir("evidence-disarm");
        let db = open_seed_db(&home);
        let locator = OpencodeLocator::new(home.clone());

        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 0));
        assert!(locator.note_submit("t1", 100));
        insert_session(&db, "ses_a", "/proj", 150, None, None);
        insert_session(&db, "ses_b", "/proj", 160, None, None); // ambiguous: stays armed, evidence latched
        let evidence_at = 100 + OPENCODE_WINDOW_MS + 1;
        assert!(locator.tick(evidence_at).is_empty());
        assert_eq!(locator.identity_resolvable_since("t1"), Some(evidence_at));

        locator.disarm("t1");
        assert_eq!(locator.identity_resolvable_since("t1"), None);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn disarm_clears_the_probe_throttle() {
        // An uncleared `last_probe_ms` would wrongly throttle a re-armed
        // same-id terminal for up to PROBE_THROTTLE_MS; disarm must clear it.
        let home = unique_temp_dir("evidence-disarm-throttle");
        open_seed_db(&home);
        let locator = OpencodeLocator::new(home.clone());

        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 0));
        assert!(locator.note_submit("t1", 100));
        let scans_before_probe = locator.db_scan_count();
        assert_eq!(locator.probe_candidates("t1"), Some(Vec::new()));
        assert!(
            locator.db_scan_count() > scans_before_probe,
            "the first probe performs its bounded read"
        );

        locator.disarm("t1");

        // Re-arm the same id and probe immediately: a fresh pane must pay
        // its own bounded read, never inherit the old pane's throttle.
        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 51_000));
        assert!(locator.note_submit("t1", 51_100));
        let scans_after_rearm = locator.db_scan_count();
        assert_eq!(locator.probe_candidates("t1"), Some(Vec::new()));
        assert!(
            locator.db_scan_count() > scans_after_rearm,
            "throttle from the disarmed pane must not survive into the re-armed one"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn resolvable_evidence_keeps_the_first_observation_time() {
        let home = unique_temp_dir("evidence-first-wins");
        let db = open_seed_db(&home);
        let locator = OpencodeLocator::new(home.clone());

        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 0));
        assert!(locator.note_submit("t1", 100));
        insert_session(&db, "ses_a", "/proj", 150, None, None);
        insert_session(&db, "ses_b", "/proj", 160, None, None); // ambiguous
        let first_at = 100 + OPENCODE_WINDOW_MS + 1;
        assert!(locator.tick(first_at).is_empty());

        // A later re-opened window also sees candidates; the FIRST time wins.
        insert_session(&db, "ses_c", "/proj", first_at + 10, None, None);
        assert!(locator.note_submit("t1", first_at + 50));
        let second_at = first_at + 50 + OPENCODE_WINDOW_MS + 1;
        let _ = locator.tick(second_at);
        assert_eq!(locator.identity_resolvable_since("t1"), Some(first_at));
        let _ = std::fs::remove_dir_all(&home);
    }

    // -- 18. probe_candidates + note_resolvable_evidence: closes the
    // signal-lost / late-row hole the window-latch cannot see (plan review
    // R1). `probe_candidates` is the READ half: the same bounded read and
    // locator-side candidate filters `resolve_windows` applies, with
    // `deadline: None`; availability exclusions and the evidence latch are
    // the ws caller's job (the identity-invariant sweep's async probe
    // phase, which re-checks live fresh-agent state AFTER this read).
    // `note_resolvable_evidence` is the LATCH half: first-evidence-wins,
    // dropped when the terminal disarmed mid-flight. Neither probes a
    // never-submitted pane; unarmed/never-submitted probes perform ZERO DB
    // reads. --

    #[test]
    fn probe_candidates_never_reads_for_unarmed_or_never_submitted_terminals() {
        let home = unique_temp_dir("probe-noread");
        let db = open_seed_db(&home);
        insert_session(&db, "ses_neighbor", "/proj", 150, None, None);
        let locator = OpencodeLocator::new(home.clone());
        assert!(locator.arm("t-idle", "opencode", true, None, Some("/proj"), 100));

        // arm() performs its own one-shot snapshot read; baseline AFTER it.
        let scans = locator.db_scan_count();
        // Never submitted => no probe, no DB read, no evidence (the #702
        // idle-neighbor case: a pane whose user typed nothing has no session
        // of its own, so nothing may be attributed to it).
        assert_eq!(locator.probe_candidates("t-idle"), None);
        assert_eq!(locator.probe_candidates("never-armed"), None);
        assert_eq!(
            locator.db_scan_count(),
            scans,
            "never-submitted/unarmed probes must perform zero DB reads"
        );
        assert_eq!(locator.identity_resolvable_since("t-idle"), None);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn probe_candidates_returns_a_late_row_for_a_submitted_pane() {
        let home = unique_temp_dir("probe-late-row");
        let db = open_seed_db(&home);
        let locator = OpencodeLocator::new(home.clone());

        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 1_000));
        assert!(locator.note_submit("t1", 1_100));
        // Window closed EMPTY (row not yet visible), then the row lands LATE —
        // after the 2s Enter-anchored deadline — with no further Enter (the
        // plan-review R1 hole).
        let closed_at = 1_100 + OPENCODE_WINDOW_MS + 1;
        assert!(locator.tick(closed_at).is_empty());
        assert_eq!(locator.identity_resolvable_since("t1"), None);
        insert_session(&db, "ses_late", "/proj", closed_at + 500, None, None);

        assert_eq!(
            locator.probe_candidates("t1"),
            Some(vec!["ses_late".to_string()]),
            "late row + submitted pane = a probe candidate (the caller decides availability)"
        );
        // The probe itself never latches evidence — the latch is the
        // caller's write (`note_resolvable_evidence`) once the caller's
        // availability exclusions pass.
        assert_eq!(locator.identity_resolvable_since("t1"), None);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn note_resolvable_evidence_latches_and_the_first_observation_wins() {
        let home = unique_temp_dir("note-first-wins");
        open_seed_db(&home);
        let locator = OpencodeLocator::new(home.clone());
        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 0));
        assert!(locator.note_submit("t1", 100));

        assert_eq!(locator.note_resolvable_evidence("t1", 50_000), Some(50_000));
        assert_eq!(locator.identity_resolvable_since("t1"), Some(50_000));
        // First evidence wins: a later note never overwrites the stored time.
        assert_eq!(locator.note_resolvable_evidence("t1", 60_000), Some(50_000));
        assert_eq!(locator.identity_resolvable_since("t1"), Some(50_000));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn note_resolvable_evidence_is_dropped_when_the_terminal_was_disarmed_mid_flight() {
        // The caller's DB read runs off the locator lock; a terminal that
        // disarmed (exit/bind) between the read and the latch must never
        // have evidence resurrected for it.
        let home = unique_temp_dir("note-disarmed");
        open_seed_db(&home);
        let locator = OpencodeLocator::new(home.clone());
        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 0));
        assert!(locator.note_submit("t1", 100));
        locator.disarm("t1");

        assert_eq!(locator.note_resolvable_evidence("t1", 50_000), None);
        assert_eq!(locator.identity_resolvable_since("t1"), None);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn probe_candidates_respects_locator_side_candidate_filters() {
        let home = unique_temp_dir("probe-filters");
        let db = open_seed_db(&home);
        insert_session(&db, "ses_pre_arm", "/proj", 50, None, None); // snapshotted at arm
        let locator = OpencodeLocator::new(home.clone());

        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 100));
        assert!(locator.note_submit("t1", 120));

        // Seeded AFTER arm so each row's exclusion is exercised by the probe
        // filter itself, not masked by the arm-time known_ids snapshot.
        insert_session(&db, "ses_wrong_cwd", "/other", 60_000, None, None);
        insert_session(&db, "ses_child", "/proj", 60_001, Some("ses_pre_arm"), None);
        insert_session(&db, "ses_archived", "/proj", 60_002, None, Some(60_003));
        insert_three_views_session(&db, "ses_3views", "/proj", 60_003);

        // Every row is excluded probe-side (known-at-arm snapshot, foreign
        // cwd, subagent parent, archived, 3-views marker): the probe DID
        // run and found no candidates (Some(vec![]), not None).
        assert_eq!(locator.probe_candidates("t1"), Some(Vec::new()));
        assert_eq!(locator.identity_resolvable_since("t1"), None);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn probe_candidates_after_empty_enter_reads_once_then_throttles() {
        // Plan-review R2, finding 2: a bare Enter on an empty prompt creates
        // no row. The first probe may read (bounded) and finds nothing; a
        // re-probe inside the throttle interval performs ZERO DB reads, so an
        // empty-Enter pane never degrades into a permanent 2s read loop.
        // (The throttle clock is the wall clock — `probe_candidates` takes
        // no synthetic `now` — so the two probes below land within the same
        // PROBE_THROTTLE_MS window by construction.)
        let home = unique_temp_dir("probe-throttle");
        open_seed_db(&home);
        let locator = OpencodeLocator::new(home.clone());

        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 0));
        assert!(locator.note_submit("t1", 100)); // bare Enter: window resolves empty
        assert!(locator.tick(100 + OPENCODE_WINDOW_MS + 1).is_empty());

        let scans_after_tick = locator.db_scan_count();
        assert_eq!(locator.probe_candidates("t1"), Some(Vec::new()));
        let scans_after_first_probe = locator.db_scan_count();
        assert!(
            scans_after_first_probe > scans_after_tick,
            "the first probe is allowed exactly one bounded read"
        );
        assert_eq!(locator.probe_candidates("t1"), None);
        assert_eq!(
            locator.db_scan_count(),
            scans_after_first_probe,
            "re-probe within the throttle interval performs no DB read"
        );
        assert_eq!(locator.identity_resolvable_since("t1"), None);
        let _ = std::fs::remove_dir_all(&home);
    }

    // -- 19. probe_eligible: the invariant sweep's queue-skip predicate
    // (issue #702, delta repair 4). Pure in-memory (one lock, no I/O);
    // mirrors the probe's armed/ever-submitted/throttle guards (plus the
    // sweep's latch-miss rule) so a pane that can never yield candidates is
    // never queued for probing at all. --

    #[test]
    fn probe_eligible_tracks_the_probe_guards() {
        let home = unique_temp_dir("probe-eligible");
        open_seed_db(&home);
        let locator = OpencodeLocator::new(home.clone());

        // Never armed => not eligible.
        assert!(!locator.probe_eligible("never-armed", 50_000));

        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 0));

        // Fresh arm, never submitted (the #702 idle class): NOT eligible —
        // the pane has no session of its own, so the sweep must never queue
        // it for a probe.
        assert!(!locator.probe_eligible("t1", 50_000));

        // Submitted and never probed (=> not throttled): eligible.
        assert!(locator.note_submit("t1", 100));
        assert!(locator.probe_eligible("t1", 50_000));

        // A probe read stamps the wall-clock throttle inside
        // `probe_candidates` (the one locator entry point that runs on real
        // time): within the throttle window the pane is not eligible again;
        // past it, it is.
        assert_eq!(locator.probe_candidates("t1"), Some(Vec::new()));
        let wall_now = wall_now_ms();
        assert!(!locator.probe_eligible("t1", wall_now));
        assert!(locator.probe_eligible("t1", wall_now + PROBE_THROTTLE_MS + 1));

        // Latched evidence (here via the ws phase's explicit note; a window
        // refusal latches identically): the gate already has its answer, so
        // the pane must never be queued for another probe.
        assert_eq!(locator.note_resolvable_evidence("t1", 60_000), Some(60_000));
        assert!(!locator.probe_eligible("t1", wall_now + PROBE_THROTTLE_MS + 1));

        // Disarmed (pane gone): not eligible.
        locator.disarm("t1");
        assert!(!locator.probe_eligible("t1", wall_now + PROBE_THROTTLE_MS + 1));
        let _ = std::fs::remove_dir_all(&home);
    }
}

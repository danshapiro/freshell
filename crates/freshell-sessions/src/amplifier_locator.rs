//! `AmplifierLocator` — deterministic PTY↔session association for FRESH
//! amplifier sessions. Rust port of the correlation core of
//! `server/coding-cli/amplifier-session-locator.ts` (`05c6b1fa`, #514), scoped
//! to the restore fix (`docs/plans/2026-07-18-amplifier-restore-spec.md`).
//!
//! Amplifier has no launcher-assigned session id and creates its session dir
//! LAZILY at the first prompt submit, so a running amplifier PTY's identity is
//! unknown at spawn time. This locator correlates the PTY's Enter-press with
//! the new session dir that appears under
//! `<amplifier_home>/projects/<slug>/sessions/<id>/`:
//!
//! 1. **Arm** a fresh amplifier terminal (no `resumeSessionId`) at create time:
//!    snapshot the currently-existing session dirs (never candidates for this
//!    terminal) and remember its cwd.
//! 2. On the terminal's first Enter/submit at time `t`, open a correlation
//!    window `[t - PRE_EPSILON_MS, t + WINDOW_MS]` (spec §2.2, `:66-83`).
//! 3. **Poll** (not `notify`/chokidar — see below) `<amplifier_home>/projects`
//!    for session dirs that didn't exist when first observed; probe each
//!    candidate's `events.jsonl` for a `session:start` (rejecting `parent_id`/
//!    `session:fork`/underscore-named subagent dirs) followed by a
//!    `session:config` record carrying `working_dir`/`project_dir`.
//! 4. At window close, resolve: exactly one cwd-confirmed candidate emits a
//!    [`Located`]; two or more refuse (never guess, logged); zero keeps
//!    watching.
//!
//! ## Why polling instead of a live filesystem watcher
//!
//! The reference uses chokidar. The spec (§4.2, Slice A) explicitly permits a
//! poll-based substitute ("polling is acceptable if the spec says so") and the
//! codebase already has a poll-based precedent for exactly this kind of
//! liveness gap: `freshell-server`'s `spawn_sessions_sweep`
//! (`crates/freshell-server/src/main.rs`) substitutes a `tokio::time::interval`
//! poll for a push notification for the same reason (`SessionIndex` has no
//! change-event source). Polling here has an added benefit: chokidar's
//! `ignoreInitial` create a one-tick "blind spot" for dirs created during the
//! watcher's own startup scan (finding J in the reference, requiring a
//! one-shot readdir rescan workaround); a poll loop has no such blind spot
//! because every tick already re-scans.
//!
//! All filesystem access is synchronous `std::fs` (matching this crate's
//! existing convention in `amplifier.rs`) and every entry point takes an
//! explicit `now_ms` so tests drive the correlation windows deterministically
//! without real sleeps.
//!
//! ## Idle short-circuit (armed-only watching)
//!
//! The reference only watches while `>= 1` armed terminal exists (its module
//! doc). This port matches that: [`AmplifierLocator::tick`] performs
//! **zero** filesystem I/O -- no `projects/` walk, no probe reads -- whenever
//! zero terminals are armed, rather than sweeping unconditionally forever.
//! There is nothing a tick could resolve with no armed terminal to
//! correlate against, so the early return is pure cost avoidance, not a
//! semantic change.
//!
//! This creates one hazard: while idle, `known_dirs` (the "already seen,
//! never re-probe" baseline) stops advancing, so it can miss a directory
//! that appears during the idle window. [`AmplifierLocator::arm`] closes
//! this on the idle\u2192armed transition (armed count `0 -> 1`) by re-baselining
//! `known_dirs` from a **fresh** disk read taken at that exact moment --
//! see `arm`'s doc comment for why this is belt-and-suspenders (binding
//! correctness never depended on `known_dirs` freshness in the first place;
//! the refresh's payoff is avoiding wasted probes of a potentially large
//! accumulated-while-idle set).
//!
//! The caller (`freshell_ws::amplifier_association::drain_and_associate`)
//! runs this synchronous, `std::fs`-touching `tick()` inside
//! `tokio::task::spawn_blocking` rather than directly on an async worker
//! thread -- mirroring `SessionIndex::snapshot`'s identical wrapping for the
//! analogous `spawn_sessions_sweep` poll (`crates/freshell-server/src/main.rs`).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// `AMPLIFIER_DIR_APPEAR_WINDOW_MS` (`amplifier-session-locator.ts:66`):
/// how long after Enter a session dir may still appear and correlate.
pub const AMPLIFIER_DIR_APPEAR_WINDOW_MS: i64 = 2_000;

/// `AMPLIFIER_DIR_PRE_EPSILON_MS` (`amplifier-session-locator.ts:75`): a
/// clock-jitter/event-reorder allowance ONLY — how far BEFORE the Enter press
/// an observed dir may still correlate. Anything older is a foreign session.
pub const AMPLIFIER_DIR_PRE_EPSILON_MS: i64 = 250;

/// Bounded probe read (`amplifier-session-locator.ts:78`): `session:start` +
/// `session:config` land in the first bytes of `events.jsonl`.
const PROBE_MAX_READ_BYTES: usize = 64 * 1024;

/// Discoveries older than `window_ms * this` can no longer match any window;
/// safe to prune (`amplifier-session-locator.ts:81`).
const DISCOVERY_RETENTION_WINDOWS: i64 = 5;

/// A resolved PTY↔session association, ready for the caller (Slice B,
/// `crate::amplifier_association` in `freshell-ws`) to bind + broadcast.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Located {
    pub terminal_id: String,
    pub session_id: String,
    pub events_path: PathBuf,
    pub session_dir: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DiscoveryState {
    Pending,
    Confirmed,
    Rejected,
}

#[derive(Debug, Clone)]
struct Discovery {
    dir: PathBuf,
    name: String,
    appeared_at_ms: i64,
    state: DiscoveryState,
    claimed: bool,
    session_id: Option<String>,
    cwd_normalized: Option<String>,
    deadline_at_ms: i64,
}

#[derive(Debug, Clone)]
struct Window {
    opened_at_ms: i64,
    resolved: bool,
}

#[derive(Debug, Clone)]
struct Armed {
    cwd_normalized: String,
    /// Session dirs that existed at arm time — never candidates for this
    /// terminal (`amplifier-session-locator.ts:128-129`).
    snapshot: HashSet<PathBuf>,
    window: Option<Window>,
}

#[derive(Default)]
struct Inner {
    armed: HashMap<String, Armed>,
    discoveries: HashMap<PathBuf, Discovery>,
    /// Every session dir ever admitted as a discovery (or seeded eagerly at
    /// construction, see [`AmplifierLocator::with_config`]) — the polling
    /// analog of chokidar's `ignoreInitial`, so a pre-existing dir is never
    /// (re-)probed. Kept even after its `Discovery` is pruned, so a stale dir
    /// is never rediscovered.
    known_dirs: HashSet<PathBuf>,
}

/// Deterministic, poll-driven PTY↔session correlator for fresh amplifier
/// terminals. See the module doc for the algorithm.
pub struct AmplifierLocator {
    projects_dir: PathBuf,
    window_ms: i64,
    pre_epsilon_ms: i64,
    probe_timeout_ms: i64,
    inner: Mutex<Inner>,
    /// Counts every call to `snapshot_session_dirs` -- the locator's one and
    /// only filesystem-touching primitive. Test/diagnostic hook (mirrors
    /// `armed_count`'s existing convention below): lets a test assert the
    /// idle short-circuit in [`AmplifierLocator::tick`] performs literally
    /// zero further disk I/O while no terminal is armed.
    fs_scan_count: std::sync::atomic::AtomicU64,
}

impl AmplifierLocator {
    /// `amplifier_home` is `<AMPLIFIER_HOME env, else <home>/.amplifier>`
    /// (mirrors `freshell_sessions::amplifier::amplifier_home`); this watches
    /// exactly `<amplifier_home>/projects`, never an ancestor.
    pub fn new(amplifier_home: PathBuf) -> Self {
        Self::with_config(
            amplifier_home,
            AMPLIFIER_DIR_APPEAR_WINDOW_MS,
            AMPLIFIER_DIR_PRE_EPSILON_MS,
        )
    }

    /// Test/diagnostic constructor with explicit window tuning.
    ///
    /// Seeds `known_dirs` from whatever session dirs already exist
    /// SYNCHRONOUSLY, right here at construction — mirroring chokidar's
    /// `ignoreInitial` baseline, which is captured at watcher-creation time,
    /// not lazily on the first poll. Seeding eagerly closes a real race: if
    /// seeding were deferred to the first `tick()` call, any session dir
    /// created between construction and that first tick (however small the
    /// window) would be wrongly folded into the "pre-existing" baseline and
    /// never treated as a new discovery — silently swallowing a legitimate
    /// association.
    pub fn with_config(amplifier_home: PathBuf, window_ms: i64, pre_epsilon_ms: i64) -> Self {
        let locator = Self {
            projects_dir: amplifier_home.join("projects"),
            window_ms,
            pre_epsilon_ms,
            probe_timeout_ms: window_ms * 2,
            inner: Mutex::new(Inner::default()),
            fs_scan_count: std::sync::atomic::AtomicU64::new(0),
        };
        let known_dirs = locator.snapshot_session_dirs();
        locator.lock().known_dirs = known_dirs;
        locator
    }

    /// The exact directory this locator polls — always `projects/` under its
    /// configured amplifier home, never an ancestor (inotify-exhaustion /
    /// `$HOME`-escape guard, `amplifier-session-locator.ts:367-386`).
    pub fn watch_path(&self) -> &Path {
        &self.projects_dir
    }

    /// How many terminals are currently armed (test/diagnostic hook).
    pub fn armed_count(&self) -> usize {
        self.lock().armed.len()
    }

    /// How many times `snapshot_session_dirs` has run so far (test/
    /// diagnostic hook, mirrors `armed_count` above). Proves the idle
    /// short-circuit in [`AmplifierLocator::tick`] performs zero further
    /// filesystem scans while no terminal is armed.
    pub fn fs_scan_count(&self) -> u64 {
        self.fs_scan_count.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Arm a terminal for Enter↔dir correlation. Only fresh amplifier panes
    /// arm (`amplifier-session-locator.ts:296-302`): `mode == "amplifier"`,
    /// `status_running`, no `resume_session_id`, and a non-empty `cwd`.
    /// Returns whether the terminal was newly armed.
    pub fn arm(
        &self,
        terminal_id: &str,
        mode: &str,
        status_running: bool,
        resume_session_id: Option<&str>,
        cwd: Option<&str>,
        now_ms: i64,
    ) -> bool {
        let _ = now_ms;
        if mode != "amplifier" || !status_running {
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
        let snapshot = self.snapshot_session_dirs();
        if inner.armed.is_empty() {
            // Idle->armed transition (armed count 0 -> 1): `tick()`
            // short-circuits with ZERO filesystem I/O while no terminal is
            // armed (module doc), so `known_dirs` may be stale -- missing
            // any directory that appeared during that idle window.
            // Re-baseline it now from THIS SAME fresh disk read (`extend`,
            // never shrink -- `known_dirs` is documented above to only
            // grow) so those dirs are treated as pre-existing rather than
            // spuriously surfacing as "new" discoveries (with a
            // probe-worthy but fabricated `appeared_at_ms` of "now") the
            // moment polling resumes on the next tick.
            //
            // Belt-and-suspenders, not the sole guard: even without this,
            // no such dir could ever WRONGLY bind to a terminal, because
            // `snapshot` above -- taken fresh, right here, independent of
            // `known_dirs` -- already excludes every dir that exists at
            // arm time via `armed.snapshot` below, exactly as every arm()
            // always has. The refresh's real payoff is avoiding wasted
            // probes (bounded `events.jsonl` reads) of a potentially large
            // accumulated-while-idle set.
            inner.known_dirs.extend(snapshot.iter().cloned());
        }
        inner.armed.insert(
            terminal_id.to_string(),
            Armed {
                cwd_normalized: normalize_cwd(cwd),
                snapshot,
                window: None,
            },
        );
        true
    }

    /// Stop tracking a terminal (exit, or already resolved/bound).
    pub fn disarm(&self, terminal_id: &str) {
        self.lock().armed.remove(terminal_id);
    }

    /// Note a submit-shaped input (Enter) for an armed terminal at `at_ms`,
    /// opening a new correlation window. Mid-turn Enters never re-arm
    /// anything while a window is still open (`:627-629`). Returns whether a
    /// window was (re)opened.
    pub fn note_submit(&self, terminal_id: &str, at_ms: i64) -> bool {
        let mut inner = self.lock();
        let Some(armed) = inner.armed.get_mut(terminal_id) else {
            return false;
        };
        if let Some(w) = &armed.window {
            if !w.resolved {
                return false;
            }
        }
        armed.window = Some(Window {
            opened_at_ms: at_ms,
            resolved: false,
        });
        true
    }

    /// Drive one polling cycle at `now_ms`: admit new session dirs as
    /// discoveries, probe pending discoveries, prune stale ones, and resolve
    /// any armed terminal whose correlation window has closed. Returns every
    /// [`Located`] association resolved this tick (drains — never re-emitted).
    pub fn tick(&self, now_ms: i64) -> Vec<Located> {
        let mut inner = self.lock();
        if inner.armed.is_empty() {
            // Idle short-circuit (module doc): zero armed terminals means
            // zero possible windows to resolve, so there is nothing this
            // poll could do. Skip ALL filesystem I/O entirely rather than
            // sweeping `projects/` unconditionally forever -- #514's
            // reference only watches while >= 1 armed terminal exists.
            // Safe: `arm()` always re-baselines `known_dirs` from a FRESH
            // disk read on the idle->armed transition (see its doc
            // comment), so resuming full scans on the very next armed
            // tick can never miss anything.
            return Vec::new();
        }
        self.scan_new_dirs(&mut inner, now_ms);
        self.probe_pending(&mut inner, now_ms);
        self.prune_discoveries(&mut inner, now_ms);
        self.resolve_windows(&mut inner, now_ms)
    }

    // -- internal helpers -----------------------------------------------

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().expect("amplifier locator lock poisoned")
    }

    /// Every existing top-level session dir (`projects/<slug>/sessions/<id>`,
    /// no `_` in the id) — never candidates for a terminal armed right now
    /// (`amplifier-session-locator.ts:331-361`). Tolerates a missing
    /// `projects/` dir entirely (lazily created by amplifier itself).
    fn snapshot_session_dirs(&self) -> HashSet<PathBuf> {
        self.fs_scan_count
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let mut out = HashSet::new();
        let Ok(slugs) = std::fs::read_dir(&self.projects_dir) else {
            return out;
        };
        for slug in slugs.flatten() {
            if !slug.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let sessions_dir = slug.path().join("sessions");
            let Ok(ids) = std::fs::read_dir(&sessions_dir) else {
                continue;
            };
            for id in ids.flatten() {
                if !id.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }
                out.insert(id.path());
            }
        }
        out
    }

    /// Admit any session dir not yet `known` as a pending [`Discovery`].
    /// `known_dirs` is seeded eagerly at construction (see
    /// [`AmplifierLocator::with_config`]), so every dir observed here that
    /// isn't already known is a genuinely new one (the polling analog of
    /// chokidar's `ignoreInitial: true` — pre-existing sessions are never
    /// probed).
    fn scan_new_dirs(&self, inner: &mut Inner, now_ms: i64) {
        let current = self.snapshot_session_dirs();
        for dir in current {
            if inner.known_dirs.contains(&dir) {
                continue;
            }
            inner.known_dirs.insert(dir.clone());
            let name = dir
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            // Underscore-named dirs are sub-session dirs: never candidates
            // (`amplifier-session-locator.ts:466-467`).
            if name.contains('_') {
                continue;
            }
            inner.discoveries.insert(
                dir.clone(),
                Discovery {
                    dir,
                    name,
                    appeared_at_ms: now_ms,
                    state: DiscoveryState::Pending,
                    claimed: false,
                    session_id: None,
                    cwd_normalized: None,
                    deadline_at_ms: now_ms + self.probe_timeout_ms,
                },
            );
        }
    }

    /// Bounded-read probe of each pending discovery's `events.jsonl`
    /// (`amplifier-session-locator.ts:518-586`): confirms, rejects, or
    /// (until the deadline) leaves pending for a later tick's retry.
    fn probe_pending(&self, inner: &mut Inner, now_ms: i64) {
        let pending: Vec<PathBuf> = inner
            .discoveries
            .values()
            .filter(|d| d.state == DiscoveryState::Pending)
            .map(|d| d.dir.clone())
            .collect();
        for dir in pending {
            let events_path = dir.join("events.jsonl");
            let outcome = probe_events_file(&events_path);
            let discovery = inner
                .discoveries
                .get_mut(&dir)
                .expect("just filtered from discoveries");
            match outcome {
                ProbeOutcome::NotReady => {
                    if now_ms >= discovery.deadline_at_ms {
                        discovery.state = DiscoveryState::Rejected;
                    }
                    // else: retry next tick (events.jsonl / session:config may
                    // still be landing, E1/E4 lag).
                }
                ProbeOutcome::Subagent | ProbeOutcome::UnexpectedFirstRecord => {
                    discovery.state = DiscoveryState::Rejected;
                }
                ProbeOutcome::Confirmed { session_id, cwd } => {
                    discovery.state = DiscoveryState::Confirmed;
                    discovery.session_id =
                        Some(session_id.unwrap_or_else(|| discovery.name.clone()));
                    discovery.cwd_normalized = Some(normalize_cwd(&cwd));
                }
            }
        }
    }

    /// Discoveries older than `windowMs * DISCOVERY_RETENTION_WINDOWS` can no
    /// longer match any window; drop them (`known_dirs` keeps them from ever
    /// being rediscovered).
    fn prune_discoveries(&self, inner: &mut Inner, now_ms: i64) {
        let cutoff = now_ms - self.window_ms * DISCOVERY_RETENTION_WINDOWS;
        inner.discoveries.retain(|_, d| d.appeared_at_ms >= cutoff);
    }

    /// Resolve every armed terminal whose correlation window has closed
    /// (`amplifier-session-locator.ts:652-745`).
    fn resolve_windows(&self, inner: &mut Inner, now_ms: i64) -> Vec<Located> {
        let mut located = Vec::new();
        let terminal_ids: Vec<String> = inner.armed.keys().cloned().collect();

        for terminal_id in terminal_ids {
            let Some(armed) = inner.armed.get(&terminal_id) else {
                continue;
            };
            let Some(window) = &armed.window else {
                continue;
            };
            if window.resolved || now_ms < window.opened_at_ms + self.window_ms {
                continue;
            }

            let lower_bound = window.opened_at_ms - self.pre_epsilon_ms;
            let upper_bound = window.opened_at_ms + self.window_ms;
            let snapshot = armed.snapshot.clone();
            let cwd_normalized = armed.cwd_normalized.clone();

            let eligible: Vec<PathBuf> = inner
                .discoveries
                .values()
                .filter(|d| {
                    !d.claimed
                        && d.state != DiscoveryState::Rejected
                        && !snapshot.contains(&d.dir)
                        && d.appeared_at_ms >= lower_bound
                        && d.appeared_at_ms <= upper_bound
                })
                .map(|d| d.dir.clone())
                .collect();

            // Metadata can arrive late: defer this window's resolution until
            // every eligible probe has settled (confirmed or rejected).
            // Probes self-terminate at their deadline, so this is bounded.
            let any_pending = eligible.iter().any(|dir| {
                inner
                    .discoveries
                    .get(dir)
                    .map(|d| d.state == DiscoveryState::Pending)
                    .unwrap_or(false)
            });
            if any_pending {
                continue;
            }

            let matches: Vec<PathBuf> = eligible
                .iter()
                .filter(|dir| {
                    inner
                        .discoveries
                        .get(*dir)
                        .map(|d| {
                            d.state == DiscoveryState::Confirmed
                                && d.cwd_normalized.as_deref() == Some(cwd_normalized.as_str())
                        })
                        .unwrap_or(false)
                })
                .cloned()
                .collect();

            // Whatever the outcome, this window is now resolved: a future
            // Enter may open a NEW window (mirrors `window.resolved = true`,
            // `amplifier-session-locator.ts:717`).
            if let Some(armed) = inner.armed.get_mut(&terminal_id) {
                if let Some(w) = armed.window.as_mut() {
                    w.resolved = true;
                }
            }

            if matches.is_empty() {
                // Empty-Enter writes nothing: keep watching.
                continue;
            }
            if matches.len() > 1 {
                // Never guess: refuse and log (`amplifier-session-locator.ts:725-734`).
                tracing::warn!(
                    terminal_id = %terminal_id,
                    candidates = ?matches,
                    "amplifier_locator_ambiguous: multiple cwd-confirmed amplifier session dirs within the correlation window; refusing to bind"
                );
                continue;
            }

            let dir = matches[0].clone();
            let Some(discovery) = inner.discoveries.get_mut(&dir) else {
                continue;
            };
            discovery.claimed = true;
            let session_id = discovery
                .session_id
                .clone()
                .unwrap_or_else(|| discovery.name.clone());
            located.push(Located {
                terminal_id: terminal_id.clone(),
                session_id,
                events_path: dir.join("events.jsonl"),
                session_dir: dir,
            });
            // A successful location fully resolves this terminal: it never
            // needs to correlate again.
            inner.armed.remove(&terminal_id);
        }

        located
    }
}

/// Lexical cwd normalization (trailing-slash / separator only — no realpath;
/// `std::fs::canonicalize` is used opportunistically where the path exists,
/// mirroring `normalizeRealCwd`'s "missing/virtual paths still participate
/// via lexical normalization" fallback, `amplifier-session-locator.ts:165-174`).
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

enum ProbeOutcome {
    /// `events.jsonl` doesn't exist yet, or the confirming record hasn't
    /// landed yet — retry until the discovery's deadline.
    NotReady,
    /// `session:start` carried a non-null `parent_id`, or a `session:fork`
    /// record was seen — a subagent session, never a candidate.
    Subagent,
    /// The file's first record isn't `session:start` at all.
    UnexpectedFirstRecord,
    /// A fresh top-level session, cwd-confirmed via `session:config`.
    Confirmed {
        session_id: Option<String>,
        cwd: String,
    },
}

/// Bounded read (`PROBE_MAX_READ_BYTES`) + line-by-line JSONL scan of one
/// candidate's `events.jsonl` (`amplifier-session-locator.ts:518-586`): the
/// first record must be `session:start` (rejecting `parent_id`); a later
/// `session:fork` also rejects; a later `session:config` with
/// `working_dir`/`project_dir` confirms the cwd.
fn probe_events_file(path: &Path) -> ProbeOutcome {
    use std::io::Read;

    let Ok(mut file) = std::fs::File::open(path) else {
        return ProbeOutcome::NotReady;
    };
    let mut buf = vec![0u8; PROBE_MAX_READ_BYTES];
    let Ok(n) = file.read(&mut buf) else {
        return ProbeOutcome::NotReady;
    };
    buf.truncate(n);
    if buf.is_empty() {
        return ProbeOutcome::NotReady;
    }
    let text = String::from_utf8_lossy(&buf);
    let mut lines = text.lines();

    let Some(first) = lines.next() else {
        return ProbeOutcome::NotReady;
    };
    let Ok(first_val) = serde_json::from_str::<serde_json::Value>(first) else {
        return ProbeOutcome::NotReady;
    };
    if first_val.get("event").and_then(serde_json::Value::as_str) != Some("session:start") {
        return ProbeOutcome::UnexpectedFirstRecord;
    }
    // `data.parent_id != null` (present AND not JSON null) marks a subagent
    // (mirrors `parse_amplifier_metadata`'s identical rule in `amplifier.rs`).
    if first_val
        .get("parent_id")
        .map(|v| !v.is_null())
        .unwrap_or(false)
    {
        return ProbeOutcome::Subagent;
    }

    let mut session_id = first_val
        .get("session_id")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);

    for line in lines {
        let Ok(val) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let event = val.get("event").and_then(serde_json::Value::as_str);
        if event == Some("session:fork") {
            return ProbeOutcome::Subagent;
        }
        if session_id.is_none() {
            session_id = val
                .get("session_id")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
        }
        if event == Some("session:config") {
            let cwd = val
                .get("working_dir")
                .and_then(serde_json::Value::as_str)
                .or_else(|| val.get("project_dir").and_then(serde_json::Value::as_str));
            if let Some(cwd) = cwd {
                return ProbeOutcome::Confirmed {
                    session_id,
                    cwd: cwd.to_string(),
                };
            }
        }
    }
    // session:config lags session:start (E4): keep polling.
    ProbeOutcome::NotReady
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_temp_dir(label: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "freshell-amplifier-locator-test-{label}-{}-{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_events(home: &Path, slug: &str, id: &str, lines: &[&str]) -> PathBuf {
        let dir = home.join("projects").join(slug).join("sessions").join(id);
        std::fs::create_dir_all(&dir).unwrap();
        let content = lines
            .iter()
            .map(|l| format!("{l}\n"))
            .collect::<Vec<_>>()
            .join("");
        std::fs::write(dir.join("events.jsonl"), content).unwrap();
        dir
    }

    /// The spec's fixture shape (§5.2): `session:start` then `session:config`
    /// carrying `working_dir`.
    fn fresh_session_lines(cwd: &str) -> Vec<String> {
        vec![
            r#"{"event":"session:start"}"#.to_string(),
            format!(r#"{{"event":"session:config","working_dir":"{cwd}"}}"#),
        ]
    }

    // -- fresh session:start + session:config{working_dir==pty cwd} inside
    // the Enter window -> one Located. --

    #[test]
    fn fresh_confirmed_dir_in_window_resolves_to_located() {
        let home = unique_temp_dir("fresh");
        let locator = AmplifierLocator::new(home.clone());

        assert!(locator.arm("t1", "amplifier", true, None, Some("/proj"), 1_000));
        locator.tick(1_000); // seed known_dirs (none exist yet)

        let lines = fresh_session_lines("/proj");
        let lines_ref: Vec<&str> = lines.iter().map(String::as_str).collect();
        write_events(&home, "proj", "sess-1", &lines_ref);

        assert!(locator.note_submit("t1", 1_100));
        // A poll shortly after the dir appears admits + confirms it (appeared_at
        // must land inside [1_100-250, 1_100+2000] = [850, 3_100] to be eligible).
        locator.tick(1_200);
        // Window closes at 1_100 + windowMs(2000) = 3_100.
        let located = locator.tick(3_101);

        assert_eq!(located.len(), 1);
        assert_eq!(located[0].terminal_id, "t1");
        assert_eq!(located[0].session_id, "sess-1");
        assert_eq!(
            located[0].session_dir,
            home.join("projects")
                .join("proj")
                .join("sessions")
                .join("sess-1")
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    // -- dir appears before Enter-250ms (foreign session) -> not matched. --

    #[test]
    fn dir_predating_enter_by_more_than_pre_epsilon_is_not_matched() {
        let home = unique_temp_dir("foreign");
        let locator = AmplifierLocator::new(home.clone());

        assert!(locator.arm("t1", "amplifier", true, None, Some("/proj"), 0));
        locator.tick(0); // seed

        // Dir appears at t=100 -- long before the eventual Enter at t=2000
        // (lower bound would be 2000-250=1750; 100 is well outside it).
        let lines = fresh_session_lines("/proj");
        let lines_ref: Vec<&str> = lines.iter().map(String::as_str).collect();
        write_events(&home, "proj", "foreign-sess", &lines_ref);
        locator.tick(100);

        assert!(locator.note_submit("t1", 2_000));
        let located = locator.tick(2_000 + AMPLIFIER_DIR_APPEAR_WINDOW_MS + 1);

        assert!(located.is_empty(), "foreign dir must never be a candidate");
        let _ = std::fs::remove_dir_all(&home);
    }

    // -- parent_id / session:fork / underscore dir (subagent) -> rejected. --

    #[test]
    fn parent_id_marks_subagent_and_is_never_a_candidate() {
        let home = unique_temp_dir("subagent-parent");
        let locator = AmplifierLocator::new(home.clone());
        assert!(locator.arm("t1", "amplifier", true, None, Some("/proj"), 0));
        locator.tick(0);

        write_events(
            &home,
            "proj",
            "sub-1",
            &[r#"{"event":"session:start","parent_id":"parent-xyz"}"#],
        );
        assert!(locator.note_submit("t1", 100));
        let located = locator.tick(100 + AMPLIFIER_DIR_APPEAR_WINDOW_MS + 1);

        assert!(located.is_empty(), "subagent dir must never bind");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn session_fork_marks_subagent_and_is_never_a_candidate() {
        let home = unique_temp_dir("subagent-fork");
        let locator = AmplifierLocator::new(home.clone());
        assert!(locator.arm("t1", "amplifier", true, None, Some("/proj"), 0));
        locator.tick(0);

        write_events(
            &home,
            "proj",
            "fork-1",
            &[
                r#"{"event":"session:start"}"#,
                r#"{"event":"session:fork"}"#,
                r#"{"event":"session:config","working_dir":"/proj"}"#,
            ],
        );
        assert!(locator.note_submit("t1", 100));
        let located = locator.tick(100 + AMPLIFIER_DIR_APPEAR_WINDOW_MS + 1);

        assert!(located.is_empty(), "forked (subagent) dir must never bind");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn underscore_named_dir_is_never_a_candidate() {
        let home = unique_temp_dir("underscore");
        let locator = AmplifierLocator::new(home.clone());
        assert!(locator.arm("t1", "amplifier", true, None, Some("/proj"), 0));
        locator.tick(0);

        let lines = fresh_session_lines("/proj");
        let lines_ref: Vec<&str> = lines.iter().map(String::as_str).collect();
        write_events(&home, "proj", "sub_session_1", &lines_ref);
        assert!(locator.note_submit("t1", 100));
        let located = locator.tick(100 + AMPLIFIER_DIR_APPEAR_WINDOW_MS + 1);

        assert!(located.is_empty(), "underscore-named dir must never bind");
        let _ = std::fs::remove_dir_all(&home);
    }

    // -- two cwd-confirmed candidates in one window -> refuse + log, no bind. --

    #[test]
    fn two_confirmed_candidates_in_one_window_refuse_to_bind() {
        let home = unique_temp_dir("ambiguous");
        let locator = AmplifierLocator::new(home.clone());
        assert!(locator.arm("t1", "amplifier", true, None, Some("/proj"), 0));
        locator.tick(0);

        let lines = fresh_session_lines("/proj");
        let lines_ref: Vec<&str> = lines.iter().map(String::as_str).collect();
        write_events(&home, "proj", "sess-a", &lines_ref);
        write_events(&home, "proj", "sess-b", &lines_ref);

        assert!(locator.note_submit("t1", 100));
        let located = locator.tick(100 + AMPLIFIER_DIR_APPEAR_WINDOW_MS + 1);

        assert!(
            located.is_empty(),
            "ambiguous candidates must never be bound"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    // -- zero candidates (empty Enter) -> keep watching, no bind. --

    #[test]
    fn zero_candidates_keeps_watching_without_disarming() {
        let home = unique_temp_dir("empty-enter");
        let locator = AmplifierLocator::new(home.clone());
        assert!(locator.arm("t1", "amplifier", true, None, Some("/proj"), 0));
        locator.tick(0);

        assert!(locator.note_submit("t1", 100));
        let located = locator.tick(100 + AMPLIFIER_DIR_APPEAR_WINDOW_MS + 1);

        assert!(located.is_empty());
        assert_eq!(
            locator.armed_count(),
            1,
            "an empty Enter must not disarm the terminal"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    // -- resume/bound terminal -> never arms. --

    #[test]
    fn terminal_with_resume_session_id_never_arms() {
        let home = unique_temp_dir("resume");
        let locator = AmplifierLocator::new(home.clone());
        let armed = locator.arm(
            "t1",
            "amplifier",
            true,
            Some("already-bound-session"),
            Some("/proj"),
            0,
        );
        assert!(!armed);
        assert_eq!(locator.armed_count(), 0);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn non_amplifier_mode_never_arms() {
        let home = unique_temp_dir("wrong-mode");
        let locator = AmplifierLocator::new(home.clone());
        let armed = locator.arm("t1", "codex", true, None, Some("/proj"), 0);
        assert!(!armed);
        assert_eq!(locator.armed_count(), 0);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn not_running_terminal_never_arms() {
        let home = unique_temp_dir("not-running");
        let locator = AmplifierLocator::new(home.clone());
        let armed = locator.arm("t1", "amplifier", false, None, Some("/proj"), 0);
        assert!(!armed);
        assert_eq!(locator.armed_count(), 0);
        let _ = std::fs::remove_dir_all(&home);
    }

    // -- watcher points only at projects/ (no ancestor escape); tolerates
    // lazily-created projects/. --

    #[test]
    fn watch_path_is_exactly_projects_dir_never_an_ancestor() {
        let home = unique_temp_dir("watch-path");
        let locator = AmplifierLocator::new(home.clone());
        assert_eq!(locator.watch_path(), home.join("projects"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn tolerates_missing_projects_dir_and_locates_once_it_appears() {
        let home = unique_temp_dir("lazy-projects");
        // Deliberately do NOT create home/projects before constructing.
        let locator = AmplifierLocator::new(home.clone());

        // First tick with no projects/ dir at all must not panic.
        let located = locator.tick(0);
        assert!(located.is_empty());

        assert!(locator.arm("t1", "amplifier", true, None, Some("/proj"), 1));

        let lines = fresh_session_lines("/proj");
        let lines_ref: Vec<&str> = lines.iter().map(String::as_str).collect();
        write_events(&home, "proj", "sess-lazy", &lines_ref);

        assert!(locator.note_submit("t1", 100));
        // A poll shortly after admits + confirms the newly-created dir.
        locator.tick(150);
        let located = locator.tick(100 + AMPLIFIER_DIR_APPEAR_WINDOW_MS + 1);

        assert_eq!(located.len(), 1);
        assert_eq!(located[0].session_id, "sess-lazy");
        let _ = std::fs::remove_dir_all(&home);
    }

    // -- disarm stops correlation entirely. --

    #[test]
    fn disarmed_terminal_never_resolves() {
        let home = unique_temp_dir("disarmed");
        let locator = AmplifierLocator::new(home.clone());
        assert!(locator.arm("t1", "amplifier", true, None, Some("/proj"), 0));
        locator.tick(0);
        assert!(locator.note_submit("t1", 100));
        locator.disarm("t1");

        let lines = fresh_session_lines("/proj");
        let lines_ref: Vec<&str> = lines.iter().map(String::as_str).collect();
        write_events(&home, "proj", "sess-after-disarm", &lines_ref);
        let located = locator.tick(100 + AMPLIFIER_DIR_APPEAR_WINDOW_MS + 1);

        assert!(located.is_empty());
        assert_eq!(locator.armed_count(), 0);
        let _ = std::fs::remove_dir_all(&home);
    }

    // -- idle short-circuit: tick() while unarmed performs ZERO filesystem
    // scans (the "always-on FS-walk tax" fix). --

    #[test]
    fn tick_while_unarmed_performs_zero_filesystem_scans() {
        let home = unique_temp_dir("idle-no-scan");
        let locator = AmplifierLocator::new(home.clone());
        // Construction already performed exactly one scan (seeding
        // `known_dirs`, `with_config`'s doc comment) -- capture that as the
        // baseline rather than assuming zero.
        let baseline = locator.fs_scan_count();

        // No terminal armed at any point below: every one of these ticks
        // must be a pure no-op, performing NO further scan whatsoever.
        for i in 0..5 {
            let located = locator.tick(i * 1_000);
            assert!(located.is_empty());
        }

        assert_eq!(
            locator.fs_scan_count(),
            baseline,
            "tick() must not touch the filesystem while zero terminals are armed"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    // -- arm-after-idle: a dir created while unarmed is NEVER a candidate
    // for a terminal that arms afterward; a dir created strictly AFTER
    // arming still resolves normally. Also proves the idle short-circuit
    // doesn't silently break the known_dirs baseline. --

    #[test]
    fn dir_created_while_idle_never_binds_but_post_arm_dir_still_locates() {
        let home = unique_temp_dir("idle-then-arm");
        let locator = AmplifierLocator::new(home.clone());

        // Idle period: zero terminals armed. tick() here is the
        // idle-short-circuit no-op proven above -- included to make
        // explicit that a leftover/foreign session dir appearing during
        // this window must never surface for whichever terminal arms next.
        assert!(locator.tick(0).is_empty());
        let idle_lines = fresh_session_lines("/proj");
        let idle_lines_ref: Vec<&str> = idle_lines.iter().map(String::as_str).collect();
        write_events(&home, "proj", "sess-idle-leftover", &idle_lines_ref);
        assert!(locator.tick(50).is_empty()); // still unarmed -- still a no-op

        // Idle->armed transition at t=1_000: arm()'s own fresh disk read
        // captures "sess-idle-leftover" as pre-existing (armed.snapshot),
        // and the known_dirs baseline refresh (arm()'s doc comment) means
        // the very next tick doesn't even re-admit it as a spurious
        // "new" discovery.
        assert!(locator.arm("t1", "amplifier", true, None, Some("/proj"), 1_000));

        // A genuinely NEW dir, created strictly AFTER arming -- this is
        // t1's real (lazily-created) session and must still resolve.
        assert!(locator.note_submit("t1", 1_100));
        let post_arm_lines = fresh_session_lines("/proj");
        let post_arm_lines_ref: Vec<&str> = post_arm_lines.iter().map(String::as_str).collect();
        write_events(&home, "proj", "sess-post-arm", &post_arm_lines_ref);

        locator.tick(1_200); // admit + confirm the post-arm dir
        let located = locator.tick(1_100 + AMPLIFIER_DIR_APPEAR_WINDOW_MS + 1);

        assert_eq!(
            located.len(),
            1,
            "exactly the post-arm dir must resolve, never the idle-leftover one"
        );
        assert_eq!(located[0].session_id, "sess-post-arm");
        let _ = std::fs::remove_dir_all(&home);
    }
}

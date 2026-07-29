//! Server-side codex terminal-pane session locator (Lane B2, campaign §2.3.2).
//!
//! Sibling of `opencode_locator` and the deleted `amplifier_locator` (a
//! provider-parameterized locator was explicitly rejected — the substrates
//! share zero code). Substrate: codex persists ONE JSONL rollout file per
//! session under a process-global sessions root
//! (`<CODEX_HOME|~/.codex>/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl`,
//! flat `<id>.jsonl` in tests). A new session is a NEW FILE — so the locator
//! does a snapshot-diff of the file set, not a row-diff.
//!
//! Codex-behavior facts below are validated against codex source @
//! rust-v0.145.0 and a 3,858-rollout corpus; a codex upgrade re-opens them.
//!
//! Deliberate deviations from the opencode locator, with rationale:
//! - Windows are ENTER-ANCHORED ONLY — no spawn window. Real codex defers
//!   rollout file creation until the first user prompt is recorded
//!   (`RolloutRecorder` defers to `persist()`, materialized via
//!   `ensure_rollout_materialized()`), so before the pane's first Enter every
//!   new same-cwd rollout is by construction FOREIGN. `arm()` takes the
//!   known-files snapshot immediately but schedules NO deadline until
//!   `note_submit`.
//! - NO `pre_epsilon_ms` and NO created-at time bound: filesystems have no
//!   reliable cross-platform creation time (mtime moves on every append).
//!   The `known_files` snapshot is the primary safety — a file
//!   already present in the snapshot can never bind to this terminal. The FILENAME
//!   timestamp and the dated `YYYY/MM/DD` dir are never used as filters
//!   either: both are precomputed at codex session construction and can
//!   predate on-disk creation by the entire user idle gap (the dir can even
//!   be "yesterday" across midnight). The full-tree snapshot-diff sidesteps
//!   both.
//! - FIRST-SUBMIT re-snapshot (A4 hardening): the first `note_submit`
//!   replaces `known_files` with a fresh scan — strictly safe because the
//!   pane's own rollout cannot exist before its first Enter, so everything
//!   that appeared between arm and the first Enter is foreign by
//!   construction. SOUNDNESS PRECONDITION: the caller completes the first
//!   `note_submit` BEFORE the Enter byte is written to the PTY (codex
//!   materializes the rollout in response to that very Enter) — the
//!   `codex_association` submit seam encodes this ordering. Later window
//!   re-opens NEVER re-snapshot: a >2 s Enter→creation latency is recovered
//!   by a later Enter only if the pane's own late file stays a candidate.
//! - Attribution disambiguator: the rollout's own first-line
//!   `session_meta.payload.cwd` is REQUIRED and must match the armed
//!   terminal's cwd (`SessionMeta.cwd` is non-optional at 0.145.0;
//!   3,858/3,858 real rollouts carry it — accepting a no-cwd line would be
//!   pure foreign attack surface). `payload.cwd` is the codex process's
//!   physical `getcwd` path recorded verbatim; equality holds because
//!   `normalize_cwd` opportunistically canonicalizes the pane side — that
//!   canonicalize is load-bearing for symlinked spawn dirs.
//! - Pending first-line grace: codex CREATES the file, then awaits git-info
//!   collection (subprocesses, 5 s timeout each, worst ~10 s) BEFORE writing
//!   the `session_meta` line. A NEW file whose first line is empty/incomplete
//!   is a PENDING candidate: re-probed each sweep up to
//!   `PENDING_FIRST_LINE_GRACE_MS`, and while ANY pending candidate exists
//!   this terminal binds NOTHING (bind-blocking — a readable foreign file
//!   must not win while the pane's own file sits in its git-info gap).
//!   Enter→creation latency beyond the 2 s window is mitigated by this grace
//!   plus window re-open on a later Enter.
//! - Contested-cwd refusal is CROSS-TICK: while ≥2 armed terminals share a
//!   normalized cwd, no candidate with that cwd binds for any of them.
//! - Ownership is proven ONLY by `payload.id` on line 1 — NEVER the filename
//!   (prefilter-grade at best), NEVER `payload.session_id` (fork/resume
//!   LINEAGE: matches a FOREIGN session in 54/144 sampled real rollouts) —
//!   same predicate as `freshell-ws`'s `first_line_owns`.
//! - Resumed codex sessions append to their EXISTING rollout file (no new
//!   file) — consistent with the arm gate refusing resume panes. Compressed
//!   artifacts (`.jsonl.zst`, present in 0.145.0 source) fail the `.jsonl`
//!   suffix filter; fresh sessions always write plain `.jsonl`.
//!
//! Zero cost when idle: scans happen only at arm, at the FIRST `note_submit`
//! (the re-snapshot), and at due Enter-anchored
//! evaluations (a pending candidate keeps its evaluation due, so re-probes
//! ride the same gate), proven by `fs_scan_count`. Callers run `arm()`,
//! `note_submit()`, and `tick()` inside `tokio::task::spawn_blocking` (cold
//! dentry cache is the one unmeasured tail — A6).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use crate::opencode_locator::normalize_cwd;

/// Correlation window after a submit (Enter-anchored deadline). There is NO
/// spawn-anchored window: real codex (0.145.0) creates the rollout file only
/// when the first user prompt is recorded, so before the pane's first Enter
/// every new same-cwd rollout is by construction foreign.
pub const CODEX_WINDOW_MS: i64 = 2_000;

/// Bounded re-probe grace for a NEW file whose first line is not yet
/// readable: codex creates the file, then awaits git-info collection
/// (subprocesses, 5 s timeout each, worst ~10 s) before writing the
/// `session_meta` line. Matches codex's worst case and the magnitude of the
/// existing `IDENTITY_RESOLUTION_GRACE_MS`.
pub const PENDING_FIRST_LINE_GRACE_MS: i64 = 10_000;

/// Bounded first-line read cap — real rollouts reach 152 MB; observed real
/// first lines are ≤ 22.4 KB. Mirrors `codex_reconcile.rs`.
const MAX_FIRST_LINE_BYTES: u64 = 1024 * 1024;

/// Bounded walk depth — `sessions/YYYY/MM/DD/` is depth 3; 5 mirrors
/// `locate_codex_rollout`.
const MAX_WALK_DEPTH: u8 = 5;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Located {
    pub terminal_id: String,
    pub thread_id: String,
    pub rollout_path: PathBuf,
    pub cwd: String,
}

#[derive(Debug, Clone)]
struct Armed {
    cwd_normalized: String,
    known_files: HashSet<PathBuf>,
    enter_ms: Option<i64>,
    resolved: bool,
    /// NEW files whose first line was empty/incomplete when probed, keyed to
    /// first-seen ms. While any un-expired entry exists, this terminal binds
    /// NOTHING (bind-blocking); entries older than
    /// `PENDING_FIRST_LINE_GRACE_MS` are merged into `known_files`
    /// (permanently excluded — fail toward refusal).
    pending_first_line: HashMap<PathBuf, i64>,
}

#[derive(Default)]
struct Inner {
    armed: HashMap<String, Armed>,
}

pub struct CodexLocator {
    sessions_root: PathBuf,
    window_ms: i64,
    inner: Mutex<Inner>,
    fs_scan_count: AtomicU64,
}

impl CodexLocator {
    pub fn new(sessions_root: PathBuf) -> Self {
        Self::with_config(sessions_root, CODEX_WINDOW_MS)
    }

    pub fn with_config(sessions_root: PathBuf, window_ms: i64) -> Self {
        Self {
            sessions_root,
            window_ms,
            inner: Mutex::new(Inner::default()),
            fs_scan_count: AtomicU64::new(0),
        }
    }

    pub fn armed_count(&self) -> usize {
        self.inner.lock().unwrap().armed.len()
    }

    pub fn fs_scan_count(&self) -> u64 {
        self.fs_scan_count.load(Ordering::SeqCst)
    }

    /// Admission rules (mirrors `OpencodeLocator::arm`): codex mode, running,
    /// NO resume id (the only already-bound gate — never a restore flag, so
    /// restore-created identity-less panes re-arm for free), non-empty cwd,
    /// not already armed. On success takes the arm-time known-files snapshot.
    /// Arming schedules NO deadline — windows open only on `note_submit`
    /// (Enter-anchored; see module doc).
    pub fn arm(
        &self,
        terminal_id: &str,
        mode: &str,
        status_running: bool,
        resume_session_id: Option<&str>,
        cwd: Option<&str>,
    ) -> bool {
        if mode != "codex" || !status_running || resume_session_id.is_some() {
            return false;
        }
        let Some(cwd) = cwd.filter(|c| !c.is_empty()) else {
            return false;
        };
        let mut inner = self.inner.lock().unwrap();
        if inner.armed.contains_key(terminal_id) {
            return false;
        }
        let known_files = self.scan_rollout_files();
        inner.armed.insert(
            terminal_id.to_string(),
            Armed {
                cwd_normalized: normalize_cwd(cwd),
                known_files,
                enter_ms: None,
                resolved: false,
                pending_first_line: HashMap::new(),
            },
        );
        true
    }

    pub fn disarm(&self, terminal_id: &str) {
        self.inner.lock().unwrap().armed.remove(terminal_id);
    }

    /// The FIRST submit is what opens a window at all (windows are
    /// Enter-anchored — arm schedules no deadline), and it RE-SNAPSHOTS
    /// `known_files` (see module doc: strictly safe because the pane's own
    /// rollout cannot exist before its first Enter; the caller must complete
    /// this call BEFORE the Enter byte reaches the PTY, and must run it on
    /// the blocking pool — the re-snapshot walks the sessions tree).
    /// Re-open semantics mirror
    /// opencode: a mid-turn Enter never re-opens a still-pending evaluation;
    /// a resolved (zero-candidate / ambiguous / contested) terminal gets a
    /// fresh Enter-anchored deadline. Re-opens NEVER re-snapshot.
    pub fn note_submit(&self, terminal_id: &str, at_ms: i64) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let Some(armed) = inner.armed.get_mut(terminal_id) else {
            return false;
        };
        if !armed.resolved && armed.enter_ms.is_some() {
            return false;
        }
        if armed.enter_ms.is_none() {
            // FIRST submit: everything that appeared between arm and this
            // Enter is foreign by construction (A1/A4) — replace the
            // snapshot. Holding the lock across the scan is deliberate and
            // bounded (warm walks are 7-9 ms — A6; callers are on the
            // blocking pool); it also keeps the re-snapshot atomic with the
            // window open.
            armed.known_files = self.scan_rollout_files();
        }
        armed.enter_ms = Some(at_ms);
        armed.resolved = false;
        true
    }

    /// A terminal is due only when an Enter-anchored deadline exists and has
    /// passed. No submit -> no window -> never evaluated (see module doc).
    fn due(&self, armed: &Armed, now_ms: i64) -> bool {
        matches!(armed.enter_ms, Some(enter_ms) if !armed.resolved && now_ms >= enter_ms + self.window_ms)
    }

    /// Evaluation at (or after) an Enter-anchored deadline. Outcomes:
    /// - any NEW file with an empty/incomplete first line (codex's
    ///   create→session_meta git-info gap) → PENDING: bind NOTHING for this
    ///   terminal, stay unresolved, re-probe each sweep up to
    ///   `PENDING_FIRST_LINE_GRACE_MS` (grace-expired files are permanently
    ///   excluded);
    /// - 0 candidates → keep watching (stays armed, `resolved = true`);
    /// - 2+ candidates for one terminal → WARN + refuse (never guess);
    /// - exactly one candidate but ≥2 ARMED terminals share this cwd → WARN +
    ///   refuse (contested cwd — cross-tick, so staggered deadlines can't
    ///   grab a sibling's rollout uncontested);
    /// - one candidate claimed by ≥2 terminals in the same tick → WARN +
    ///   refuse ALL claimants (defense-in-depth behind the cwd census);
    /// - exactly one clean match → emit `Located` and disarm. `tick()` drains.
    pub fn tick(&self, now_ms: i64) -> Vec<Located> {
        {
            let inner = self.inner.lock().unwrap();
            if inner.armed.is_empty() {
                return Vec::new();
            }
            if !inner.armed.values().any(|a| self.due(a, now_ms)) {
                return Vec::new();
            }
        }
        let current = self.scan_rollout_files();
        let mut inner = self.inner.lock().unwrap();

        // Cross-tick contested-cwd census over ALL armed terminals (not just
        // the due ones): two armed same-cwd panes are indistinguishable on
        // this substrate, whatever their deadlines.
        let mut cwd_counts: HashMap<String, usize> = HashMap::new();
        for a in inner.armed.values() {
            *cwd_counts.entry(a.cwd_normalized.clone()).or_insert(0) += 1;
        }

        // Pass 1: per-terminal candidate evaluation.
        let mut claims: Vec<(String, Located)> = Vec::new();
        for (terminal_id, armed) in inner.armed.iter_mut() {
            if !matches!(armed.enter_ms, Some(e) if !armed.resolved && now_ms >= e + self.window_ms)
            {
                continue;
            }
            let new_paths: Vec<PathBuf> = current.difference(&armed.known_files).cloned().collect();
            let mut matches: Vec<(PathBuf, RolloutMeta)> = Vec::new();
            let mut pending_blocking = false;
            for path in new_paths {
                match probe_rollout(&path) {
                    Probe::Candidate(meta) => {
                        armed.pending_first_line.remove(&path);
                        if normalize_cwd(&meta.cwd) == armed.cwd_normalized {
                            matches.push((path, meta));
                        }
                    }
                    Probe::NotYet => {
                        let first_seen = *armed
                            .pending_first_line
                            .entry(path.clone())
                            .or_insert(now_ms);
                        if now_ms - first_seen >= PENDING_FIRST_LINE_GRACE_MS {
                            // Grace exhausted: permanently excluded (fail
                            // toward refusal — A4 hardening 1).
                            armed.pending_first_line.remove(&path);
                            armed.known_files.insert(path);
                        } else {
                            pending_blocking = true;
                        }
                    }
                    Probe::Never => {}
                }
            }
            if pending_blocking {
                // A new file is still inside codex's create→session_meta gap
                // (git-info collection, worst ~10 s). It may be THIS pane's
                // rollout — binding any other candidate now could hand the
                // window to a foreign file while the true owner is unreadable.
                // Bind nothing, stay unresolved, re-probe next sweep.
                tracing::debug!(
                    terminal_id = %terminal_id,
                    "codex_locator_pending: new rollout first line not yet readable; deferring evaluation"
                );
                continue;
            }
            armed.resolved = true;
            match matches.len() {
                0 => {} // keep watching
                1 => {
                    if cwd_counts.get(&armed.cwd_normalized).copied().unwrap_or(0) >= 2 {
                        tracing::warn!(
                            terminal_id = %terminal_id,
                            "codex_locator_contested_cwd: >=2 armed terminals share this cwd; refusing to bind"
                        );
                    } else {
                        let (path, meta) = matches.remove(0);
                        claims.push((
                            terminal_id.clone(),
                            Located {
                                terminal_id: terminal_id.clone(),
                                thread_id: meta.thread_id,
                                rollout_path: path,
                                cwd: armed.cwd_normalized.clone(),
                            },
                        ));
                    }
                }
                n => {
                    tracing::warn!(
                        terminal_id = %terminal_id,
                        candidates = n,
                        "codex_locator_ambiguous: multiple new rollouts in one window; refusing to bind"
                    );
                }
            }
        }

        // Pass 2: same-tick cross-terminal conflict — the same rollout (or
        // thread id) claimed by two armed terminals in one tick is
        // unattributable. (Defense-in-depth: the contested-cwd census above
        // already refuses same-cwd claimants across ticks.)
        let mut located = Vec::new();
        for (terminal_id, candidate) in &claims {
            let contested = claims.iter().any(|(other_tid, other)| {
                other_tid != terminal_id
                    && (other.rollout_path == candidate.rollout_path
                        || other.thread_id == candidate.thread_id)
            });
            if contested {
                tracing::warn!(
                    terminal_id = %terminal_id,
                    thread_id = %candidate.thread_id,
                    "codex_locator_contested: rollout claimed by multiple armed terminals; refusing to bind"
                );
                continue;
            }
            located.push(candidate.clone());
        }
        for l in &located {
            inner.armed.remove(&l.terminal_id);
        }
        located
    }

    fn scan_rollout_files(&self) -> HashSet<PathBuf> {
        self.fs_scan_count.fetch_add(1, Ordering::SeqCst);
        fn walk(dir: &Path, depth: u8, out: &mut HashSet<PathBuf>) {
            if depth > MAX_WALK_DEPTH {
                return;
            }
            let Ok(entries) = std::fs::read_dir(dir) else {
                return; // missing/corrupt root tolerated, never a panic
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, depth + 1, out);
                } else if path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.ends_with(".jsonl"))
                    .unwrap_or(false)
                {
                    out.insert(path);
                }
            }
        }
        let mut out = HashSet::new();
        walk(&self.sessions_root, 0, &mut out);
        out
    }
}

struct RolloutMeta {
    thread_id: String,
    /// REQUIRED — `SessionMeta.cwd` is non-optional at codex 0.145.0
    /// (3,858/3,858 real rollouts carry it); a no-cwd first line is a
    /// foreign shape, never a candidate (A4 hardening).
    cwd: String,
}

/// Tri-state probe result. The distinction between `NotYet` and `Never` is
/// load-bearing: codex writes the whole session_meta line + '\n' in one
/// write-then-flush, so a COMPLETE (newline-terminated) line that fails the
/// candidate shape will never become one, while an empty file or a line
/// without its trailing newline is codex's create→meta gap (or a raced
/// write) — "not yet", not "never" (A3, validated).
enum Probe {
    /// Parseable `session_meta` with a bare-UUID `payload.id` AND a
    /// `payload.cwd` — a real candidate shape.
    Candidate(RolloutMeta),
    /// Empty file, transient open/read failure, or first line still missing
    /// its trailing newline — re-probe within the pending grace.
    NotYet,
    /// Complete first line that is not a codex session_meta candidate
    /// (non-JSON, wrong type, non-UUID id, missing cwd, oversized) — never
    /// a candidate; the locator stays silent on foreign files.
    Never,
}

/// Identity probe: bounded first-line read (see `Probe` for the tri-state
/// semantics).
fn probe_rollout(path: &Path) -> Probe {
    use std::io::{BufRead, Read};
    let Ok(file) = std::fs::File::open(path) else {
        return Probe::NotYet;
    };
    let mut reader = std::io::BufReader::new(file).take(MAX_FIRST_LINE_BYTES);
    let mut first_line = Vec::new();
    if reader.read_until(b'\n', &mut first_line).is_err() {
        return Probe::NotYet;
    }
    if first_line.len() as u64 >= MAX_FIRST_LINE_BYTES && !first_line.ends_with(b"\n") {
        return Probe::Never; // oversized: will never fit the cap
    }
    if first_line.is_empty() || !first_line.ends_with(b"\n") {
        return Probe::NotYet; // create→meta gap, or a raced partial write
    }
    let Ok(record) = serde_json::from_slice::<serde_json::Value>(&first_line) else {
        return Probe::Never;
    };
    if record.get("type").and_then(|v| v.as_str()) != Some("session_meta") {
        return Probe::Never;
    }
    let Some(thread_id) = record.pointer("/payload/id").and_then(|v| v.as_str()) else {
        return Probe::Never;
    };
    if !is_uuid_shaped(thread_id) {
        return Probe::Never;
    }
    let Some(cwd) = record.pointer("/payload/cwd").and_then(|v| v.as_str()) else {
        return Probe::Never; // cwd REQUIRED (A4 hardening)
    };
    Probe::Candidate(RolloutMeta {
        thread_id: thread_id.to_string(),
        cwd: cwd.to_string(),
    })
}

/// Bare hyphenated 36-char UUID shape gate (deliberate small duplicate of
/// `freshell-ws`'s predicate — this crate sits below it in the dep graph).
fn is_uuid_shaped(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (i, b) in bytes.iter().enumerate() {
        let is_hyphen_pos = matches!(i, 8 | 13 | 18 | 23);
        if is_hyphen_pos {
            if *b != b'-' {
                return false;
            }
        } else if !b.is_ascii_hexdigit() {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_DIR_COUNTER: AtomicU64 = AtomicU64::new(0);

    /// Same convention as opencode_locator.rs tests: no tempfile crate.
    fn unique_temp_dir(label: &str) -> PathBuf {
        let n = TEST_DIR_COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "freshell-codex-locator-test-{label}-{}-{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create test dir");
        dir
    }

    /// Write a rollout file whose FIRST line is the session_meta identity
    /// record, exactly the shape the real codex CLI writes
    /// (payload.id = identity; payload.cwd = the session's working dir).
    fn write_rollout(root: &Path, rel_dir: &str, thread_id: &str, cwd: Option<&str>) -> PathBuf {
        let dir = root.join(rel_dir);
        std::fs::create_dir_all(&dir).expect("create rollout dir");
        let file = dir.join(format!("rollout-2026-07-26T08-00-00-{thread_id}.jsonl"));
        let payload = match cwd {
            Some(c) => format!(r#"{{"id":"{thread_id}","cwd":"{c}"}}"#),
            None => format!(r#"{{"id":"{thread_id}"}}"#),
        };
        let line = format!(
            r#"{{"timestamp":"2026-07-26T08:00:00.000Z","type":"session_meta","payload":{payload}}}"#
        );
        std::fs::write(&file, format!("{line}\n")).expect("write rollout");
        file
    }

    const TID: &str = "11111111-2222-3333-4444-555555555555";

    #[test]
    fn fresh_rollout_after_first_enter_resolves_via_enter_window() {
        let root = unique_temp_dir("enter-happy");
        let cwd = root.join("project");
        std::fs::create_dir_all(&cwd).unwrap();
        let cwd_s = cwd.to_string_lossy().to_string();
        let locator = CodexLocator::new(root.clone());

        assert!(locator.arm("t1", "codex", true, None, Some(&cwd_s)));
        // No submit yet -> no deadline exists; nothing to evaluate.
        assert!(locator.tick(10_000).is_empty());
        // Enter at 20_000; the rollout appears AFTER the submit (real codex
        // materializes the file only when the first user prompt is recorded).
        assert!(locator.note_submit("t1", 20_000));
        let path = write_rollout(&root, "2026/07/26", TID, Some(&cwd_s));

        // Before the Enter-anchored deadline: nothing yet.
        assert!(locator.tick(20_000 + CODEX_WINDOW_MS - 1).is_empty());
        let located = locator.tick(20_000 + CODEX_WINDOW_MS);
        assert_eq!(
            located,
            vec![Located {
                terminal_id: "t1".into(),
                thread_id: TID.into(),
                rollout_path: path,
                cwd: crate::opencode_locator::normalize_cwd(&cwd_s),
            }]
        );
        // Success fully resolves and disarms; tick() drains.
        assert_eq!(locator.armed_count(), 0);
        assert!(locator.tick(20_000 + CODEX_WINDOW_MS + 1).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rollout_after_arm_without_submit_is_never_bound_and_never_scanned() {
        // A1 (validated): real codex creates the rollout ONLY at the first
        // user prompt, so before Enter every new same-cwd rollout is by
        // construction FOREIGN. With no submit there is NO window: the file
        // must never bind and no deadline scans may run.
        let root = unique_temp_dir("no-submit");
        let locator = CodexLocator::new(root.clone());
        assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
        assert_eq!(locator.fs_scan_count(), 1); // the arm snapshot
        write_rollout(&root, "2026/07/26", TID, Some("/tmp"));
        assert!(locator.tick(CODEX_WINDOW_MS).is_empty());
        assert!(locator.tick(100 * CODEX_WINDOW_MS).is_empty());
        assert_eq!(locator.armed_count(), 1);
        assert_eq!(locator.fs_scan_count(), 1); // still only the arm snapshot
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rollout_created_between_arm_and_first_enter_never_binds() {
        // A4 hardening (first-submit re-snapshot): Premise 7 guarantees the
        // pane's own rollout cannot exist before its first Enter, so EVERY
        // file that appears between arm and the first submit is foreign by
        // construction (freshagent sidecar, `codex exec`, codex outside
        // freshell in the same cwd). The FIRST note_submit re-snapshots
        // known_files, so a bare Enter (empty composer, trust dialog) can
        // never hand the window to that foreign file as a sole candidate.
        let root = unique_temp_dir("resnapshot");
        let locator = CodexLocator::new(root.clone());
        assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
        // Foreign rollout lands AFTER arm but BEFORE the first Enter.
        write_rollout(&root, "2026/07/26", TID, Some("/tmp"));
        assert!(locator.note_submit("t1", 1_000)); // first submit re-snapshots
        assert_eq!(locator.fs_scan_count(), 2); // arm + first-submit scans
        assert!(locator.tick(1_000 + CODEX_WINDOW_MS).is_empty());
        assert_eq!(locator.armed_count(), 1); // zero candidates → keep watching
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn arm_admission_gates() {
        let root = unique_temp_dir("gates");
        let locator = CodexLocator::new(root.clone());
        // wrong mode
        assert!(!locator.arm("t1", "opencode", true, None, Some("/tmp")));
        // not running
        assert!(!locator.arm("t1", "codex", false, None, Some("/tmp")));
        // resume id present — the ONLY already-bound gate (no restore flag)
        assert!(!locator.arm("t1", "codex", true, Some(TID), Some("/tmp")));
        // missing / empty cwd
        assert!(!locator.arm("t1", "codex", true, None, None));
        assert!(!locator.arm("t1", "codex", true, None, Some("")));
        // happy arm, then idempotent re-arm returns false
        assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
        assert!(!locator.arm("t1", "codex", true, None, Some("/tmp")));
        assert_eq!(locator.armed_count(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn disarmed_terminal_never_resolves() {
        let root = unique_temp_dir("disarm");
        let locator = CodexLocator::new(root.clone());
        assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
        assert!(locator.note_submit("t1", 0));
        write_rollout(&root, "2026/07/26", TID, Some("/tmp"));
        locator.disarm("t1");
        assert!(locator.tick(CODEX_WINDOW_MS + 1).is_empty());
        assert_eq!(locator.armed_count(), 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn tick_while_unarmed_performs_zero_fs_scans() {
        let root = unique_temp_dir("idle");
        let locator = CodexLocator::new(root.clone());
        // Construction must not scan eagerly either.
        assert_eq!(locator.fs_scan_count(), 0);
        assert!(locator.tick(10_000).is_empty());
        assert_eq!(locator.fs_scan_count(), 0);
        // Arming scans once (the known-files snapshot)…
        assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
        assert_eq!(locator.fs_scan_count(), 1);
        // …and a tick BEFORE any Enter-anchored deadline is due (here: no
        // submit at all, so no deadline exists) still scans nothing.
        let before = locator.fs_scan_count();
        assert!(locator.tick(1).is_empty());
        assert_eq!(locator.fs_scan_count(), before);
        let _ = std::fs::remove_dir_all(&root);
    }

    const TID2: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    #[test]
    fn rollout_present_at_arm_is_never_a_candidate() {
        let root = unique_temp_dir("snapshot");
        // File exists BEFORE arm — the known-files snapshot must exclude it
        // forever, regardless of any timing.
        write_rollout(&root, "2026/07/26", TID, Some("/tmp"));
        let locator = CodexLocator::new(root.clone());
        assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
        assert!(locator.note_submit("t1", 1_000));
        assert!(locator.tick(1_000 + CODEX_WINDOW_MS).is_empty());
        assert_eq!(locator.armed_count(), 1); // zero candidates → keep watching
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn foreign_cwd_rollout_is_never_a_candidate() {
        let root = unique_temp_dir("cwd");
        let locator = CodexLocator::new(root.clone());
        assert!(locator.arm("t1", "codex", true, None, Some("/home/me/project-a")));
        assert!(locator.note_submit("t1", 0));
        write_rollout(&root, "2026/07/26", TID, Some("/home/me/project-b"));
        assert!(locator.tick(CODEX_WINDOW_MS).is_empty());
        assert_eq!(locator.armed_count(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rollout_without_cwd_field_never_binds() {
        // cwd is REQUIRED (A4 hardening): `SessionMeta.cwd` is non-optional
        // at codex 0.145.0 and 3,858/3,858 + 500/500 real rollouts carry it.
        // A no-cwd first line is a foreign shape — accepting it would be
        // pure attack surface (a location-blind universal candidate).
        let root = unique_temp_dir("no-cwd");
        let locator = CodexLocator::new(root.clone());
        assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
        assert!(locator.note_submit("t1", 0));
        write_rollout(&root, "2026/07/26", TID, None);
        assert!(locator.tick(CODEX_WINDOW_MS).is_empty());
        assert_eq!(locator.armed_count(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn two_new_rollouts_in_one_window_refuse_to_bind() {
        let root = unique_temp_dir("ambiguous");
        let locator = CodexLocator::new(root.clone());
        assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
        assert!(locator.note_submit("t1", 0));
        write_rollout(&root, "2026/07/26", TID, Some("/tmp"));
        write_rollout(&root, "2026/07/26", TID2, Some("/tmp"));
        assert!(locator.tick(CODEX_WINDOW_MS).is_empty());
        // Refusal marks the evaluation resolved but stays armed…
        assert_eq!(locator.armed_count(), 1);
        // …and a later Enter re-opens a fresh window (both files are now
        // still absent from known_files, so still ambiguous — proves the
        // refusal is repeatable, never a guess).
        assert!(locator.note_submit("t1", CODEX_WINDOW_MS + 100));
        assert!(locator
            .tick(CODEX_WINDOW_MS + 100 + CODEX_WINDOW_MS)
            .is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn same_rollout_claimed_by_two_armed_terminals_refuses_both() {
        let root = unique_temp_dir("contested");
        let locator = CodexLocator::new(root.clone());
        // Two panes, SAME cwd, armed concurrently, submitting in the same
        // tick; ONE new rollout. The contested-cwd census refuses both
        // (Pass 2's same-tick claim check remains as defense-in-depth).
        assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
        assert!(locator.arm("t2", "codex", true, None, Some("/tmp")));
        assert!(locator.note_submit("t1", 0));
        assert!(locator.note_submit("t2", 0));
        write_rollout(&root, "2026/07/26", TID, Some("/tmp"));
        assert!(locator.tick(CODEX_WINDOW_MS).is_empty());
        assert_eq!(locator.armed_count(), 2);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn staggered_same_cwd_armed_terminals_never_bind_uncontested() {
        // Cross-tick contested guard (A4 hardening): ambiguity refusal must
        // not be same-tick-only. While ≥2 ARMED terminals share a normalized
        // cwd, NO candidate with that cwd binds for any of them — staggered
        // deadlines must not let pane A grab pane B's rollout uncontested.
        let root = unique_temp_dir("staggered");
        let locator = CodexLocator::new(root.clone());
        assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
        assert!(locator.arm("t2", "codex", true, None, Some("/tmp")));
        assert!(locator.note_submit("t1", 0));
        assert!(locator.note_submit("t2", 5_000));
        write_rollout(&root, "2026/07/26", TID, Some("/tmp"));
        // t1's deadline fires alone: contested cwd → refuse.
        assert!(locator.tick(CODEX_WINDOW_MS).is_empty());
        // t2's deadline: still contested → refuse.
        assert!(locator.tick(5_000 + CODEX_WINDOW_MS).is_empty());
        assert_eq!(locator.armed_count(), 2);
        // One pane exits (disarm); the survivor re-opens with a fresh Enter
        // and may now bind — re-evaluation is legitimate once uncontested.
        locator.disarm("t2");
        assert!(locator.note_submit("t1", 10_000));
        let located = locator.tick(10_000 + CODEX_WINDOW_MS);
        assert_eq!(located.len(), 1);
        assert_eq!(located[0].terminal_id, "t1");
        assert_eq!(located[0].thread_id, TID);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn zero_candidate_window_keeps_watching_and_later_enter_reopens() {
        let root = unique_temp_dir("reopen");
        let locator = CodexLocator::new(root.clone());
        assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
        assert!(locator.note_submit("t1", 0));
        // Window closes with zero candidates → keep watching (stays armed).
        assert!(locator.tick(CODEX_WINDOW_MS).is_empty());
        assert_eq!(locator.armed_count(), 1);
        // A later Enter re-opens; the rollout appears; resolves via the new
        // Enter-anchored window.
        let enter_at = 10 * CODEX_WINDOW_MS;
        assert!(locator.note_submit("t1", enter_at));
        write_rollout(&root, "2026/07/26", TID, Some("/tmp"));
        let located = locator.tick(enter_at + CODEX_WINDOW_MS);
        assert_eq!(located.len(), 1);
        assert_eq!(located[0].thread_id, TID);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn later_enter_reopen_keeps_the_first_submit_snapshot() {
        // Slow materialization (>2 s Enter→creation) is recovered by a later
        // Enter ONLY if re-opens never re-snapshot: the pane's own late
        // rollout appears between the first window's close and the second
        // Enter, and must STAY a candidate. Only the FIRST submit
        // re-snapshots (pinned via fs_scan_count).
        let root = unique_temp_dir("reopen-snapshot");
        let locator = CodexLocator::new(root.clone());
        assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
        assert!(locator.note_submit("t1", 0)); // first submit: re-snapshot
                                               // First window closes empty.
        assert!(locator.tick(CODEX_WINDOW_MS).is_empty());
        // The pane's own rollout lands LATE — after the window, before the
        // next Enter.
        write_rollout(&root, "2026/07/26", TID, Some("/tmp"));
        let scans_before = locator.fs_scan_count();
        assert!(locator.note_submit("t1", 10_000)); // re-open: NO re-snapshot
        assert_eq!(locator.fs_scan_count(), scans_before);
        let located = locator.tick(10_000 + CODEX_WINDOW_MS);
        assert_eq!(located.len(), 1);
        assert_eq!(located[0].thread_id, TID);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn mid_turn_enter_never_reopens_a_pending_evaluation() {
        let root = unique_temp_dir("midturn");
        let locator = CodexLocator::new(root.clone());
        assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
        assert!(locator.note_submit("t1", 100));
        // Second Enter while the first evaluation is still pending: no-op.
        assert!(!locator.note_submit("t1", 200));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn non_session_meta_or_malformed_first_line_is_never_a_candidate() {
        // COMPLETE (newline-terminated) garbage lines are `Probe::Never` —
        // not pending: codex writes the whole meta line + '\n' in one
        // write-then-flush, so a complete non-candidate line never becomes
        // one. (Empty/torn lines are the pending case — see the tests below.)
        let root = unique_temp_dir("badmeta");
        let locator = CodexLocator::new(root.clone());
        assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
        assert!(locator.note_submit("t1", 0));
        let dir = root.join("2026/07/26");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("rollout-2026-07-26T08-00-00-{TID}.jsonl")),
            format!(
                "{{\"type\":\"event_msg\",\"payload\":{{\"id\":\"{TID}\"}}}}
"
            ),
        )
        .unwrap();
        std::fs::write(
            dir.join(format!("rollout-2026-07-26T08-00-01-{TID2}.jsonl")),
            "not json at all\n",
        )
        .unwrap();
        assert!(locator.tick(CODEX_WINDOW_MS).is_empty());
        assert_eq!(locator.armed_count(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_first_line_file_is_pending_and_binds_once_meta_lands() {
        // A3 (validated): codex CREATES the rollout file, then awaits
        // git-info collection (subprocesses, 5 s timeout each, worst ~10 s)
        // BEFORE writing the session_meta first line. A deadline scan can
        // observe the empty file — it must be a re-probed PENDING candidate,
        // never dropped by a one-shot read.
        let root = unique_temp_dir("pending");
        let locator = CodexLocator::new(root.clone());
        assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
        assert!(locator.note_submit("t1", 0));
        let dir = root.join("2026/07/26");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(format!("rollout-2026-07-26T08-00-00-{TID}.jsonl"));
        std::fs::write(&file, "").unwrap(); // created, meta not yet written
                                            // Deadline scan: pending candidate → bind NOTHING, stay unresolved.
        assert!(locator.tick(CODEX_WINDOW_MS).is_empty());
        assert_eq!(locator.armed_count(), 1);
        // Meta line lands (well within grace); the next sweep binds it.
        // (write_rollout reuses the same filename — same ts, same TID.)
        write_rollout(&root, "2026/07/26", TID, Some("/tmp"));
        let located = locator.tick(CODEX_WINDOW_MS + 300);
        assert_eq!(located.len(), 1);
        assert_eq!(located[0].thread_id, TID);
        assert_eq!(locator.armed_count(), 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn readable_candidate_never_binds_while_another_new_file_is_pending() {
        // A4 (validated, CRITICAL): the pane's OWN rollout can sit
        // unreadable in the git-info gap while a FOREIGN same-cwd rollout is
        // already readable. Pending candidates are BIND-BLOCKING — the
        // readable file must not win the window.
        let root = unique_temp_dir("pending-block");
        let locator = CodexLocator::new(root.clone());
        assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
        assert!(locator.note_submit("t1", 0));
        // Pane's own file: created, first line not yet written.
        let dir = root.join("2026/07/26");
        std::fs::create_dir_all(&dir).unwrap();
        let own = dir.join(format!("rollout-2026-07-26T08-00-00-{TID}.jsonl"));
        std::fs::write(&own, "").unwrap();
        // Foreign file: fully readable, same cwd.
        write_rollout(&root, "2026/07/26", TID2, Some("/tmp"));
        // Deadline: NOTHING binds while the pending file exists.
        assert!(locator.tick(CODEX_WINDOW_MS).is_empty());
        assert_eq!(locator.armed_count(), 1);
        // Own meta line lands → TWO candidates → ambiguity refusal (fail
        // toward refusal, never a guess).
        write_rollout(&root, "2026/07/26", TID, Some("/tmp"));
        assert!(locator.tick(CODEX_WINDOW_MS + 300).is_empty());
        assert_eq!(locator.armed_count(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn pending_file_that_never_parses_expires_after_grace() {
        // Grace is bounded (A4 hardening 1): once PENDING_FIRST_LINE_GRACE_MS
        // elapses without a readable first line, the file is permanently
        // excluded and stops blocking; a surviving sole candidate may then
        // bind.
        let root = unique_temp_dir("pending-expiry");
        let locator = CodexLocator::new(root.clone());
        assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
        assert!(locator.note_submit("t1", 0));
        let dir = root.join("2026/07/26");
        std::fs::create_dir_all(&dir).unwrap();
        let own = dir.join(format!("rollout-2026-07-26T08-00-00-{TID}.jsonl"));
        std::fs::write(&own, "").unwrap(); // never gains a first line
        write_rollout(&root, "2026/07/26", TID2, Some("/tmp"));
        // First due scan sees the pending file (grace clock starts here).
        assert!(locator.tick(CODEX_WINDOW_MS).is_empty());
        // Still blocked just before grace expiry…
        assert!(locator
            .tick(CODEX_WINDOW_MS + PENDING_FIRST_LINE_GRACE_MS - 1)
            .is_empty());
        // …then the never-parsed file expires and the sole survivor binds.
        let located = locator.tick(CODEX_WINDOW_MS + PENDING_FIRST_LINE_GRACE_MS);
        assert_eq!(located.len(), 1);
        assert_eq!(located[0].thread_id, TID2);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_sessions_root_is_tolerated_and_resolves_once_it_appears() {
        let base = unique_temp_dir("missing-root");
        let root = base.join("does-not-exist-yet");
        let locator = CodexLocator::new(root.clone());
        // arm() scans the missing root — tolerated, never a panic.
        assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
        assert!(locator.note_submit("t1", 0));
        assert!(locator.tick(CODEX_WINDOW_MS).is_empty()); // no panic, keep watching
        assert_eq!(locator.armed_count(), 1);
        assert!(locator.note_submit("t1", 2 * CODEX_WINDOW_MS));
        write_rollout(&root, "2026/07/26", TID, Some("/tmp"));
        let located = locator.tick(3 * CODEX_WINDOW_MS);
        assert_eq!(located.len(), 1);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn flat_test_shape_rollout_resolves() {
        // locate_codex_rollout supports flat `<id>.jsonl`; the locator's walk
        // must too (integration fixtures seed this shape).
        let root = unique_temp_dir("flat");
        let locator = CodexLocator::new(root.clone());
        assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
        assert!(locator.note_submit("t1", 0));
        write_rollout(&root, ".", TID, Some("/tmp"));
        let located = locator.tick(CODEX_WINDOW_MS);
        assert_eq!(located.len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }
}

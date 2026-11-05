//! Server-side antigravity terminal-pane conversation locator (antigravity
//! plan Task 6).
//!
//! Sibling of `codex_locator` (same module shape: arm at create, a
//! submit-anchored evaluation window, a `tick()` the ws association sweep
//! drives on the blocking pool). Substrate: the antigravity CLI persists
//! ONE transcript per conversation under
//! `<antigravity_home>/brain/<conversationId>/.system_generated/logs/transcript.jsonl`
//! (the `AntigravityLayout` root). A new conversation is a NEW directory,
//! and an in-CLI `/resume <existing id>` (Google's documented conversation
//! switch) APPENDS the user's next prompt to the EXISTING conversation's
//! transcript as its LATEST user record — so ONE evidence rule covers BOTH
//! first-bind and rebind, with no separate fork-watch lane:
//!
//! A tick considers ONLY transcripts whose
//! - ownership record (`session_start` — the LABELED FAKE-CONTRACT
//!   anchor the e2e/rebind fakes append; real transcripts carry no
//!   ownership or workspace evidence, so transcript-driven identity
//!   binding does not engage on real-format sessions — a recorded
//!   limitation) carries a `conversationId` whose `workspacePaths`
//!   CONTAIN the pane's cwd (normalized), and whose
//! - LATEST user-authored record (`USER_INPUT{source:USER_EXPLICIT}` —
//!   the real binary v1.4.12 vocabulary; no `user_message` record
//!   exists) `content` EQUALS the pane's captured submit payload
//!   (normalized, bounded comparison — the FULL multi-line buffer a
//!   Ctrl+J prompt flushed at Enter, never just its last line), and
//!   whose
//! - MATCHING user record was written AT/AFTER that submit within a
//!   bounded BACKWARD tolerance (recency is proven by the matching
//!   record's OWN `created_at` — a later record of another type, e.g.
//!   a PLANNER_RESPONSE still streaming after the submit, never vouches
//!   for a user record written before it; a transcript whose matching
//!   record predates the submit by more than the tolerance can never
//!   match, which is what rejects re-typed old prompts and dead-launch
//!   late writes alike; unprovable timestamps fail toward refusal).
//!
//!   // The backward tolerance,
//!   // `ANTIGRAVITY_RECENCY_BACKWARD_TOLERANCE_MS` = 5 s — whole-delta
//!   // review round 3, Major 1: the registry writes input to the PTY
//!   // BEFORE timestamping the `ActivityEvent::Input` it feeds the
//!   // association (registry.rs writes, then stamps `at`), so the CLI
//!   // child — scheduled on another core — can process the prompt and
//!   // append its `USER_INPUT` record between those two operations,
//!   // with a `created_at` that legitimately PRECEDES our captured
//!   // submit timestamp. The strict `at >= submit` rule rejected the
//!   // pane's own conversation on every retry (the record can never get
//!   // newer). The tolerance is sized for the CROSS-PROCESS/CROSS-CLOCK
//!   // skew between the CLI's own timestamps and ours, not for the race
//!   // alone (which is µs–ms of write→stamp latency):
//!   //   - the same-host clock is shared, and the CLI's `created_at`
//!   //     granularity is BINARY-EVIDENCED at RFC3339 SECONDS (agy
//!   //     1.4.12; real-binary-transcript-evidence.md): a
//!   //     second-granularity stamp can predate the true write instant
//!   //     by up to ~1 s;
//!   //   - NTP slew/step adjustments between the two stamping instants
//!   //     add up to seconds in pathological cases;
//!   //   - 5 s covers both with wide margin (~50× the observed race
//!   //     scale) while staying 12× BELOW the 60 s pending-submit
//!   //     lifetime, so "awaiting the first record" ends long before
//!   //     the retry bound, and minutes/hours-old conversations remain
//!   //     decisively rejected — the tolerance covers skew, never
//!   //     history. The 5 s size is now evidence-backed, no longer a
//!   //     Stage-1 unknown.
//!
//! Outcomes per tick per pane: exactly one matching candidate == current id
//! ⇒ no-op (the ws association decides; the locator has no current-id
//! state); exactly one with a different id ⇒ first-bind OR rebind (again
//! the association's call — the SAME rule, not a separate mechanism);
//! ZERO matches ⇒ the submit STAYS PENDING and later ticks retry it
//! (whole-delta review round 2, Major 1: the CLI can write its first user
//! record after the first scan — slow startup, an auth flow — and the
//! recency rule already requires the matching record at/after the submit,
//! so a late write is exactly the case the window must catch; the retry
//! ends only at the bounded `ANTIGRAVITY_PENDING_SUBMIT_LIFETIME_MS`, by
//! a NEWER submit replacing the window, or by a bind); more than one ⇒
//! REFUSE all and warn `antigravity_association_refused
//! {reason:"ambiguous"}` — never a guess. Refusal never disarms: a later
//! solo submit re-opens the window and re-evaluates.
//!
//! REAL-BINARY record contract (corrected 2026-11-02 against real agy
//! 1.2.11 + 1.4.12 transcripts; evidence:
//! `.worktrees/.the-usual-logs/antigravity-transcript-validation/reports/
//! real-binary-transcript-evidence.md`): the transcript PATH and the
//! user-record vocabulary this module reads (`USER_INPUT` with
//! `content` + a SECOND-granularity RFC3339 `created_at`) are
//! real-binary-validated. The `session_start` ownership record it
//! anchors cwd/id evidence on is a LABELED FAKE-CONTRACT extension the
//! e2e/rebind fakes append — real transcripts carry no ownership or
//! workspace evidence, so transcript-driven identity binding does not
//! engage on real-format sessions (recorded limitation; the resume path
//! itself consults the path-anchored by-id locator, which parses no
//! records).
//!
//! Deliberate deviations from the codex locator, with rationale:
//! - NO file-set (known-files) baseline: codex's candidates are a
//!   snapshot DIFFERENCE (a new rollout file is identity evidence by
//!   itself), while antigravity's candidates are CONTENT-matched across
//!   every transcript in the root — the pane's own conversation is proved
//!   by the prompt text it just submitted, not by the file being new. The
//!   matching-record recency rule replaces the baseline: a transcript
//!   whose matching user record predates the submit can never match.
//! - NO separate fork lane: codex needs `watch_fork`/`tick_forks` because
//!   its first-bind rule (new file in cwd) cannot see an in-CLI switch;
//!   antigravity's unified rule catches BOTH the fresh conversation and
//!   the `/resume` switch with the same per-submit window.
//! - RE-OPEN ON EVERY ENTER: a new `note_submit` REPLACES an in-flight
//!   window (the latest Enter is the live prompt — the transcript's
//!   latest user record moves to it immediately), where codex keeps the
//!   first Enter's window. With content matching, holding an older
//!   captured line could only ever mismatch.
//! - mtime PREFILTER (never authoritative): a transcript whose file mtime
//!   is older than `submit_at - ANTIGRAVITY_RECENCY_BACKWARD_TOLERANCE_MS`
//!   cannot carry a record the recency rule would accept, so its
//!   head/tail probe is skipped; an mtime error or a coarse-grained clock
//!   falls through to the probe (conservative).
//! - Bounded reads: the ownership record is read from a 64 KiB head window
//!   (it is the first line in practice); the latest user record + newest
//!   record timestamp are read from a 256 KiB tail window. Residual: a
//!   matchable user record buried deeper than the tail bound cannot
//!   match — honest degradation (the matching record is the prompt the
//!   pane JUST submitted, which sits at the file's end).
//!
//! Zero cost when idle: scans happen only while at least one armed pane
//! has a due unresolved window, proven by `fs_scan_count`. Callers run
//! `arm()`, `note_submit()`, and `tick()` inside `tokio::task::
//! spawn_blocking` (same discipline as the codex locator).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use crate::opencode_locator::normalize_cwd;
use crate::provider_layout::{AntigravityLayout, ProviderLayout};
use crate::time::parse_timestamp_ms;

/// The per-terminal rate-limit window for the
/// `antigravity_association_unmatched` warn (round 7, Minor 1): a
/// misconfigured pane (an un-armed capture feed, a never-matching
/// schema) would otherwise warn on EVERY Enter; one line per terminal
/// per window keeps the failure diagnosable without burying the log.
/// Sized to the pending lifetime's own cadence — a genuinely unmatched
/// armed submit can expire at most once per
/// [`ANTIGRAVITY_PENDING_SUBMIT_LIFETIME_MS`], so the window never
/// hides a DISTINCT failure, only bursts.
pub const ANTIGRAVITY_UNMATCHED_LOG_INTERVAL_MS: i64 = 60_000;

/// Submit-anchored evaluation window: a pane's captured submit is
/// evaluated at (or after) `submit_at + WINDOW_MS` — the CLI writes the
/// user record when it processes the prompt, so the window gives it a
/// bounded head start (codex parity: `CODEX_WINDOW_MS`). A submit that
/// matches nothing STAYS pending (see
/// `ANTIGRAVITY_PENDING_SUBMIT_LIFETIME_MS`); the next Enter always
/// replaces the window regardless.
pub const ANTIGRAVITY_WINDOW_MS: i64 = 2_000;

/// Bounded retry lifetime for a pending submit that matched NOTHING on a
/// scan (whole-delta review round 2, Major 1): the submit STAYS pending
/// and later ticks re-evaluate it, so a transcript the CLI wrote late
/// (slow startup, an auth flow before the first user record) still
/// binds. The lifetime bounds the retry so a never-matching submit can
/// never pin a window forever or bind an UNRELATED future conversation
/// (the hazard needs a same-cwd transcript receiving an identical prompt
/// text within the lifetime). Chosen as 30× the 2 s window: long enough
/// to cover a CLI cold start plus a short unattended stall (the round-6
/// backoff lane spaces those retries out — ~46 walks per unmatched
/// submit at the production 150 ms sweep, see
/// [`ANTIGRAVITY_PENDING_RESCAN_CAP_MS`] — while keeping full-lifetime
/// coverage), short enough to sit well inside
/// the 120 s busy deadman — "awaiting the first record" ends before
/// "turn wedged" semantics begin. Beyond it the honest degradation is
/// the user re-submitting (the next Enter re-opens the window — the pane
/// self-heals on its next prompt).
pub const ANTIGRAVITY_PENDING_SUBMIT_LIFETIME_MS: i64 = 60_000;

/// The pending-retry BACKOFF LANE (whole-delta review round 6, Minor 1):
/// a submit that matched nothing stays pending for the full
/// [`ANTIGRAVITY_PENDING_SUBMIT_LIFETIME_MS`], and pre-fix the 150 ms
/// production sweep (`LOCATOR_SWEEP_INTERVAL`, freshell-server main.rs)
/// re-walked the WHOLE brain tree on every tick — ~387 walks per
/// unmatched submit (a slash command, an approval answer), growing with
/// conversation history. The lane bounds that cost with a stepped
/// rescan delay that is a PURE FUNCTION of the submit's age:
///
/// | age since the submit's Enter | rescan delay |
/// |---|---|
/// | < 4 s | 150 ms (the sweep's own cadence — the FAST head) |
/// | < 6 s | 300 ms |
/// | < 10 s | 600 ms |
/// | < 20 s | 1.2 s |
/// | < 40 s | 2.4 s |
/// | ≥ 40 s | 5 s (the cap) |
///
/// Why this shape: the common quick-start case (the CLI writes its user
/// record within ~1–2 s of the submit) keeps the FULL 150 ms cadence for
/// the first ~4 s, so a promptly-written record binds on the very next
/// sweep tick with zero added latency; only submits that stay unmatched
/// — which are exactly the submits that will probably NEVER match (slash
/// commands, approval answers) — pay the stretched spacing. 60 s TOTAL
/// COVERAGE IS PRESERVED BY CONSTRUCTION: the lane stretches the retry
/// interval but never cancels it before the lifetime bound, so a record
/// the CLI writes at ANY age before expiry is found within one cap
/// interval (worst-case discovery latency 5 s, only for submits older
/// than 40 s — already 2/3 through their lifetime). A NEWER
/// `note_submit` always resets the lane (its `last_scan` restarts at the
/// window). Total walks per unmatched submit at the production 150 ms
/// sweep: ~46 (vs ~387 pre-fix).
pub const ANTIGRAVITY_PENDING_RESCAN_CAP_MS: i64 = 5_000;

/// The fast head's bound: submits younger than this keep the sweep's own
/// 150 ms cadence.
pub const ANTIGRAVITY_PENDING_FAST_LANE_MS: i64 = 4_000;

/// The walk-count bound per unmatched submit over its full lifetime at
/// the production 150 ms sweep (~46 by the schedule above; the pin
/// carries headroom for schedule tuning without ever re-approaching the
/// pre-fix flat-cadence ~387).
pub const ANTIGRAVITY_PENDING_MAX_WALKS_PER_LIFETIME: u64 = 60;

/// The stepped rescan delay for a pending submit of `age_ms` (see
/// [`ANTIGRAVITY_PENDING_RESCAN_CAP_MS`]'s table).
fn pending_rescan_delay(age_ms: i64) -> i64 {
    if age_ms < ANTIGRAVITY_PENDING_FAST_LANE_MS {
        150
    } else if age_ms < 6_000 {
        300
    } else if age_ms < 10_000 {
        600
    } else if age_ms < 20_000 {
        1_200
    } else if age_ms < 40_000 {
        2_400
    } else {
        ANTIGRAVITY_PENDING_RESCAN_CAP_MS
    }
}

/// Bounded BACKWARD tolerance for the recency rule (whole-delta review
/// round 3, Major 1; whole-delta review round 4, Minor 1 moved the
/// CANONICAL constant to `freshell_protocol` so the activity tracker's
/// attach-baseline classification references the SAME number instead of
/// forking it): a matching user record whose own `created_at` is within
/// this window BEFORE the captured submit timestamp still counts as
/// at/after-that-submit. The registry writes input to the PTY BEFORE
/// timestamping the `ActivityEvent::Input` (registry.rs:3890,3931), so the
/// CLI child — on another core — can append its `USER_INPUT` record
/// between the write and our stamp, with a `created_at` that precedes the
/// submit. The bound covers cross-process/cross-clock skew (the CLI's own
/// `created_at` granularity is binary-evidenced at RFC3339 SECONDS — agy
/// 1.4.12, real-binary-transcript-evidence.md; NTP slew adds seconds), NOT
/// history: it is 12× below the 60 s pending lifetime, so minutes-old
/// conversations stay rejected. Full rationale in the module header and at
/// the canonical definition (`freshell_protocol::ANTIGRAVITY_RECENCY_BACKWARD_TOLERANCE_MS`).
/// The mtime prefilter uses the SAME constant — a prefilter tighter than
/// the tolerance would veto matches the recency rule itself accepts (never
/// authoritative in the wrong direction).
pub use freshell_protocol::ANTIGRAVITY_RECENCY_BACKWARD_TOLERANCE_MS;

/// Bounded submit-text comparison cap (chars, on both the captured line
/// and the record text) — prompts are bounded, never whole-paste dumps.
const MAX_SUBMIT_COMPARE_CHARS: usize = 4096;

/// Bounded head read for the ownership record (bytes).
const MAX_HEAD_BYTES: u64 = 64 * 1024;

/// Bounded tail read for the latest user record + newest record (bytes).
const MAX_TAIL_BYTES: u64 = 256 * 1024;

/// Walk depth for `brain/<conversationId>/.system_generated/logs/` — the
/// layout's own chain is depth 4; 5 tolerates a stray nesting level.
const MAX_WALK_DEPTH: u8 = 5;

/// One resolved pane → conversation match, drained by the ws association
/// sweep (which owns the guard ladder and the adoption/rebind tail).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AntigravityLocated {
    pub terminal_id: String,
    pub conversation_id: String,
    pub transcript_path: PathBuf,
    /// The captured submit's Enter `at` — the SUBMIT-ANCHORED baseline
    /// boundary for the activity lane's attach (whole-delta review round
    /// 2, Major 2): a settle already on disk when the lane attaches is
    /// HISTORICAL only when its own `at` predates this submit; a settle
    /// after it is a live turn end and rings. The match itself proved
    /// this submit armed the pane (content + recency), so it is the
    /// exact boundary the tracker needs.
    pub submit_at_ms: i64,
}

/// The pane's captured submit (the flushed line at the Enter byte).
#[derive(Debug, Clone, PartialEq, Eq)]
struct CapturedSubmit {
    text: String,
    at_ms: i64,
}

#[derive(Debug, Clone)]
struct Armed {
    cwd_normalized: String,
    /// The latest submit's captured line + the Enter's timestamp. `None`
    /// until the pane's first Enter; replaced by every later Enter.
    submit: Option<CapturedSubmit>,
    /// Whether the CURRENT window is finished evaluating. `true` (with
    /// `submit` still set) after a bind, an ambiguous/contested refusal,
    /// or the pending lifetime's expiry — the next `note_submit`
    /// re-opens. A zero-match evaluation leaves it `false`: the submit is
    /// PENDING and later ticks retry it (whole-delta review round 2).
    resolved: bool,
    /// When the lane last WALKED the tree for this window (round 6,
    /// Minor 1): `None` until the window's first scan (at the window
    /// bound), then stamped on every lane-legal scan. The next rescan is
    /// due once `pending_rescan_delay(age)` has elapsed since it. Reset
    /// to `None` by every `note_submit` (a new window starts at the
    /// fast head).
    last_scan_ms: Option<i64>,
}

#[derive(Default)]
struct Inner {
    armed: HashMap<String, Armed>,
}

pub struct AntigravityLocator {
    /// The brain root (`AntigravityLayout::session_root(<home>)`).
    root: PathBuf,
    window_ms: i64,
    inner: Mutex<Inner>,
    fs_scan_count: AtomicU64,
    /// The per-terminal last-emission timestamps of the
    /// `antigravity_association_unmatched` warn (round 7, Minor 1) —
    /// a SEPARATE mutex from `inner` so the tick's armed-loop can emit
    /// without borrowing conflicts. Cleaned by [`Self::disarm`].
    unmatched_log_ms: Mutex<HashMap<String, i64>>,
}

/// Normalize a prompt text for comparison: trim + bound. The trim is
/// EDGE-only — a multi-line payload's EMBEDDED newlines (Ctrl+J content)
/// survive, matching the transcript record's text through the identical
/// normalization on both sides.
fn normalize_prompt_text(text: &str) -> String {
    text.trim().chars().take(MAX_SUBMIT_COMPARE_CHARS).collect()
}

/// The `antigravity_association_unmatched` fingerprint (round 7, Minor
/// 1): the first 12 hex chars of the normalized submit's sha256 — a
/// CONTENT-FREE correlation key (Global Constraint 7 forbids prompt
/// contents in logs; the prefix still lets an operator recognize the
/// same never-matching prompt across lines). Same sha2 version the
/// ws/server crates already pin.
fn submit_fingerprint(text: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(text.as_bytes()))[..12].to_string()
}

impl AntigravityLocator {
    pub fn new(root: PathBuf) -> Self {
        Self::with_config(root, ANTIGRAVITY_WINDOW_MS)
    }

    pub fn with_config(root: PathBuf, window_ms: i64) -> Self {
        Self {
            root,
            window_ms,
            inner: Mutex::new(Inner::default()),
            fs_scan_count: AtomicU64::new(0),
            unmatched_log_ms: Mutex::new(HashMap::new()),
        }
    }

    pub fn armed_count(&self) -> usize {
        self.inner.lock().unwrap().armed.len()
    }

    pub fn fs_scan_count(&self) -> u64 {
        self.fs_scan_count.load(Ordering::SeqCst)
    }

    /// Arm a pane with its cwd (the ws association sweep resolves mode /
    /// managed / running gates against the registry before calling). A
    /// pane STAYS armed across adoption — the SAME rule must keep
    /// evaluating its later submits for the in-CLI switch forms. Idempotent
    /// per terminal; `false` for an empty cwd or an already-armed pane.
    pub fn arm(&self, terminal_id: &str, cwd: &str) -> bool {
        if terminal_id.is_empty() || cwd.trim().is_empty() {
            return false;
        }
        let mut inner = self.inner.lock().unwrap();
        if inner.armed.contains_key(terminal_id) {
            return false;
        }
        inner.armed.insert(
            terminal_id.to_string(),
            Armed {
                cwd_normalized: normalize_cwd(cwd),
                submit: None,
                resolved: false,
                last_scan_ms: None,
            },
        );
        true
    }

    pub fn disarm(&self, terminal_id: &str) {
        self.inner.lock().unwrap().armed.remove(terminal_id);
        self.unmatched_log_ms.lock().unwrap().remove(terminal_id);
    }

    /// Record the pane's captured submit line (the association feeds the
    /// hub's flushed line here) and open the evaluation window anchored at
    /// the Enter. REPLACES any in-flight window (see module doc). `false`
    /// for an un-armed pane or an empty (normalized-empty) line — an empty
    /// line can never match a user record's text. An un-armed pane's false
    /// return is LOGGED (round 7, Minor 1): the pane is tagged antigravity
    /// but its capture feed never armed (e.g. no registry cwd), so every
    /// submit is being dropped — a diagnosable misconfiguration, never a
    /// silent one. An empty line stays silent (a bare Enter is normal
    /// user behavior, not a failure).
    pub fn note_submit(&self, terminal_id: &str, line_text: &str, at_ms: i64) -> bool {
        let text = normalize_prompt_text(line_text);
        if text.is_empty() {
            return false;
        }
        let mut inner = self.inner.lock().unwrap();
        let Some(armed) = inner.armed.get_mut(terminal_id) else {
            drop(inner);
            self.warn_unmatched(terminal_id, &text, at_ms, "not_armed");
            return false;
        };
        armed.submit = Some(CapturedSubmit { text, at_ms });
        armed.resolved = false;
        // A NEW window restarts the backoff lane at its fast head (the
        // lane is per-window, not per-pane).
        armed.last_scan_ms = None;
        true
    }

    /// One evaluation pass over every due armed pane. Candidates are the
    /// transcripts matching the unified content+recency rule (see module
    /// doc). Outcomes: 0 matches → STAY PENDING (whole-delta review
    /// round 2, Major 1: a transcript the CLI writes LATE — slow
    /// startup, an auth flow before the first user record — still binds
    /// on a later tick; the submit expires after
    /// `ANTIGRAVITY_PENDING_SUBMIT_LIFETIME_MS`); 1 match → emit
    /// `AntigravityLocated` (the association decides no-op /
    /// first-bind / rebind); >= 2 matches → REFUSE and warn
    /// `antigravity_association_refused {reason:"ambiguous"}`; a
    /// conversation claimed by two panes in the same tick is refused for
    /// BOTH (the codex locator's same-tick cross-claim defense). `tick()`
    /// drains.
    ///
    /// The retry cost of a PENDING submit is bounded by the backoff lane
    /// (round 6, Minor 1; [`pending_rescan_delay`]): the FIRST scan runs
    /// at the window bound as before, and later rescans are due only
    /// once the lane's stepped delay (a pure function of the submit's
    /// age) has elapsed since the last walk. The walk itself is shared —
    /// one per tick that has at least one lane-due pane — and only the
    /// lane-due panes evaluate against it, so a pane's per-file probe
    /// cost also stays on its own lane. A pane past its pending lifetime
    /// resolves WITHOUT a walk (the observing tick is the end).
    pub fn tick(&self, now_ms: i64) -> Vec<AntigravityLocated> {
        let mut scan_ids: Vec<String> = Vec::new();
        {
            let mut inner = self.inner.lock().unwrap();
            for (terminal_id, armed) in inner.armed.iter_mut() {
                let Some(submit) = &armed.submit else {
                    continue;
                };
                if armed.resolved {
                    continue;
                }
                // The pending submit's bounded lifetime: a submit that
                // never matched is DROPPED once the lifetime elapses
                // (never pinning a window, never binding an unrelated
                // future conversation). Resolving at expiry needs NO
                // walk — this tick observes the end and the pane goes
                // quiet (zero fs cost again). The drop is LOGGED
                // (round 7, Minor 1): pre-fix this was the silent
                // path — a clean submit that matched nothing for its
                // whole lifetime vanished without a trace.
                if now_ms >= submit.at_ms + ANTIGRAVITY_PENDING_SUBMIT_LIFETIME_MS {
                    self.warn_unmatched(terminal_id, &submit.text, now_ms, "expired");
                    armed.resolved = true;
                    continue;
                }
                if now_ms < submit.at_ms + self.window_ms {
                    continue;
                }
                let lane_due = match armed.last_scan_ms {
                    // The window's FIRST scan: always due at the window
                    // bound (unchanged from the pre-lane behavior).
                    None => true,
                    // The backoff lane: the next rescan waits out the
                    // stepped delay for the submit's CURRENT age.
                    Some(last) => now_ms - last >= pending_rescan_delay(now_ms - submit.at_ms),
                };
                if lane_due {
                    armed.last_scan_ms = Some(now_ms);
                    scan_ids.push(terminal_id.clone());
                }
            }
            if scan_ids.is_empty() {
                return Vec::new(); // zero fs cost while no window is due
            }
        }
        let transcripts = self.scan_transcripts();
        let mut inner = self.inner.lock().unwrap();

        // Pass 1: per-pane candidate evaluation — ONLY the panes the lane
        // admitted this tick (a pane piggybacking another pane's walk
        // without being lane-due keeps its own lane for its next scan).
        let mut claims: Vec<(String, AntigravityLocated)> = Vec::new();
        for terminal_id in &scan_ids {
            let Some(armed) = inner.armed.get_mut(terminal_id) else {
                continue;
            };
            let Some(submit) = armed.submit.clone() else {
                continue;
            };
            if armed.resolved {
                continue;
            }
            let mut matches: Vec<AntigravityLocated> = Vec::new();
            for path in &transcripts {
                if !mtime_could_be_recent(path, submit.at_ms) {
                    continue;
                }
                let Some(summary) = probe_transcript(path) else {
                    continue;
                };
                let cwd_in_workspace = summary
                    .workspace_paths
                    .iter()
                    .any(|p| normalize_cwd(p) == armed.cwd_normalized);
                if !cwd_in_workspace {
                    continue;
                }
                if summary.latest_user_text != submit.text {
                    continue;
                }
                // Recency is proven by the MATCHING user record's own
                // timestamp, with a bounded BACKWARD tolerance (round 3,
                // Major 1): the registry writes the PTY bytes BEFORE
                // stamping the Input event, so the CLI child can record
                // the prompt between those operations — its `at` then
                // precedes the captured submit by the write→stamp latency
                // (plus CLI-stamp granularity and clock slew — the module
                // header's tolerance rationale). A transcript whose
                // matching record predates the submit by MORE than the
                // tolerance still never matches (re-typed old prompts,
                // dead-launch late writes), and a later record of another
                // type (an assistant record still streaming after the
                // submit) never vouches for it. Unprovable timestamps
                // (the matching record's own `at` unparseable) fail
                // toward refusal.
                match summary.latest_user_at {
                    Some(at) if at >= submit.at_ms - ANTIGRAVITY_RECENCY_BACKWARD_TOLERANCE_MS => {}
                    _ => continue,
                }
                matches.push(AntigravityLocated {
                    terminal_id: terminal_id.clone(),
                    conversation_id: summary.conversation_id,
                    transcript_path: path.clone(),
                    submit_at_ms: submit.at_ms,
                });
            }
            match matches.len() {
                // Zero matches: the submit STAYS PENDING — a later
                // lane-legal tick retries it (the review's late-write
                // case). Only the lifetime bound (checked above) or a
                // NEWER `note_submit` (which replaces the window and
                // resets the lane) ends the retry.
                0 => {} // keep watching (pending; the next Enter re-opens)
                1 => {
                    armed.resolved = true;
                    claims.push((terminal_id.clone(), matches.remove(0)));
                }
                n => {
                    armed.resolved = true;
                    tracing::warn!(
                        target: "freshell_sessions::antigravity_locator",
                        terminal_id = %terminal_id,
                        candidates = n,
                        event = "antigravity_association_refused",
                        reason = "ambiguous",
                        "antigravity_association_refused: multiple transcripts match the \
                         captured submit; refusing all (never a guess)"
                    );
                }
            }
        }

        // Pass 2: same-tick cross-claim — one conversation claimed by two
        // panes is unattributable even with content matching (identical
        // prompt texts); refuse both, never guess.
        let mut located = Vec::new();
        for (terminal_id, claim) in &claims {
            let contested = claims.iter().any(|(other_tid, other)| {
                other_tid != terminal_id && other.conversation_id == claim.conversation_id
            });
            if contested {
                tracing::warn!(
                    target: "freshell_sessions::antigravity_locator",
                    terminal_id = %terminal_id,
                    conversation_id = %claim.conversation_id,
                    event = "antigravity_association_refused",
                    reason = "contested",
                    "antigravity_association_refused: one conversation claimed by two \
                     panes in one tick; refusing both"
                );
                continue;
            }
            located.push(claim.clone());
        }
        located
    }

    /// Emit the rate-limited `antigravity_association_unmatched` WARN
    /// (round 7, Minor 1) — one line per terminal per
    /// [`ANTIGRAVITY_UNMATCHED_LOG_INTERVAL_MS`]. Carries the terminal
    /// id, the reason (`expired` — a pending window that matched nothing
    /// for its whole lifetime; `not_armed` — a submit on a pane whose
    /// capture feed never armed), and a content-free submit FINGERPRINT
    /// (a sha256 prefix): Global Constraint 7 forbids prompt CONTENT in
    /// logs, and the prefix still correlates repeat failures of the same
    /// prompt across lines. `at_ms` is the emission domain's timestamp
    /// (the submit's Enter time on the not_armed path, the observing
    /// tick's time on expiry) — pure, never a wall clock.
    fn warn_unmatched(&self, terminal_id: &str, text: &str, at_ms: i64, reason: &str) {
        let Ok(mut lane) = self.unmatched_log_ms.lock() else {
            return; // a poisoned lane never blocks the locator's work
        };
        if let Some(last) = lane.get(terminal_id) {
            if at_ms - last < ANTIGRAVITY_UNMATCHED_LOG_INTERVAL_MS {
                return;
            }
        }
        lane.insert(terminal_id.to_string(), at_ms);
        drop(lane);
        tracing::warn!(
            target: "freshell_sessions::antigravity_locator",
            terminal_id = %terminal_id,
            fingerprint = %submit_fingerprint(text),
            reason = reason,
            event = "antigravity_association_unmatched",
            "antigravity_association_unmatched: a clean captured submit matched \
             no transcript and was dropped — likely causes: the transcript's \
             ownership anchor missing from the store (real-format sessions \
             carry none, so binding never engages; see the module header), \
             the store root not holding the conversation (see \
             antigravity_store_root_resolved), or no session_start \
             workspacePath matching the pane's cwd; the pane re-arms on its \
             next clean submit"
        );
    }

    fn scan_transcripts(&self) -> Vec<PathBuf> {
        self.fs_scan_count.fetch_add(1, Ordering::SeqCst);
        fn walk(dir: &Path, depth: u8, out: &mut Vec<PathBuf>) {
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
                } else if AntigravityLayout.qualifies(&path) {
                    out.push(path);
                }
            }
        }
        let mut out = Vec::new();
        walk(&self.root, 0, &mut out);
        out
    }
}

/// mtime prefilter (never authoritative): a transcript not written since
/// `submit_at - ANTIGRAVITY_RECENCY_BACKWARD_TOLERANCE_MS` cannot carry a
/// record the recency rule would accept (the tolerance admits records
/// stamped slightly BEFORE the submit — the round 3 race — so the prefilter
/// must be at least as wide, or it would veto matches the rule accepts).
/// An mtime error or a coarse clock falls through to the probe.
fn mtime_could_be_recent(path: &Path, submit_at_ms: i64) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return true; // fall through: the probe decides
    };
    let Ok(modified) = meta.modified() else {
        return true;
    };
    let mtime_ms = modified
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    mtime_ms >= submit_at_ms - ANTIGRAVITY_RECENCY_BACKWARD_TOLERANCE_MS
}

/// The facts a candidate transcript must present (all extracted with
/// bounded reads; see module doc).
#[derive(Debug, Clone)]
struct TranscriptSummary {
    /// The FIRST `session_start` record's `conversationId` (the labeled
    /// fake-contract ownership anchor's id; the parser's determinism
    /// rule — later ownership records never reassign it).
    conversation_id: String,
    /// The `workspacePaths` of EVERY `session_start` record across the
    /// bounded head+tail windows (round 7, Minor 2: a resumed
    /// conversation appends later records — usually near the file's end
    /// — whose workspaces must still match the pane's cwd; the parser's
    /// first-record-as-primary display rule is untouched). Compared
    /// normalized.
    workspace_paths: Vec<String>,
    /// The LATEST user-authored record's text (normalized+bounded the same
    /// way the captured submit was) — read from the real `USER_INPUT`
    /// record's `content` (binary v1.4.12; no `user_message`/`text`
    /// record exists).
    latest_user_text: String,
    /// That SAME record's own `created_at` timestamp — recency is proven
    /// by the MATCHING record, never by a later record of another type
    /// (a still-streaming PLANNER_RESPONSE written after the submit must
    /// not vouch for a user record written before it). `None` when the
    /// matching record's own timestamp is unparseable — fails toward
    /// refusal.
    latest_user_at: Option<i64>,
}

/// Bounded probe of one transcript: the ownership record from the head
/// window, the latest user record's text + its own timestamp from the
/// tail window. `None` = not a candidate this tick (unreadable, no
/// ownership id, or no user record in the tail window) — a transient
/// state the next window re-probes; never a panic on malformed content.
fn probe_transcript(path: &Path) -> Option<TranscriptSummary> {
    use std::io::{Read, Seek, SeekFrom};

    // Ownership id + workspace paths from the head window. The id is
    // the FIRST `session_start` record's `conversationId` (the
    // parser's determinism rule — later ownership records never
    // reassign it). The workspacePaths are collected from EVERY
    // `session_start` record in the window (round 7, Minor 2): a
    // resumed conversation appends later `session_start` records whose
    // workspaces must still match the pane's cwd; the parser's
    // first-record-as-primary DISPLAY rule is untouched.
    let mut file = std::fs::File::open(path).ok()?;
    let mut head = Vec::new();
    {
        let mut limited = (&file).take(MAX_HEAD_BYTES);
        limited.read_to_end(&mut head).ok()?;
    }
    let head_text = String::from_utf8_lossy(&head);
    let mut conversation_id: Option<String> = None;
    let mut workspace_paths: Vec<String> = Vec::new();
    for line in head_text.lines() {
        let Ok(obj) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if obj.get("type").and_then(|v| v.as_str()) != Some("session_start") {
            continue;
        }
        if let Some(paths) = obj.get("workspacePaths").and_then(|v| v.as_array()) {
            for path in paths.iter().filter_map(|p| p.as_str()) {
                workspace_paths.push(path.to_string());
            }
        }
        if conversation_id.is_none() {
            if let Some(id) = obj
                .get("conversationId")
                .and_then(serde_json::Value::as_str)
                .filter(|s| !s.is_empty())
            {
                conversation_id = Some(id.to_string());
            }
        }
    }
    let conversation_id = conversation_id?;

    // Tail window: latest user record's text + that record's own
    // timestamp. Skip a potentially partial first line when the window
    // starts mid-line.
    let file_len = file.metadata().ok()?.len();
    let tail_start = file_len.saturating_sub(MAX_TAIL_BYTES);
    file.seek(SeekFrom::Start(tail_start)).ok()?;
    let mut tail = Vec::new();
    (&file).take(MAX_TAIL_BYTES).read_to_end(&mut tail).ok()?;
    let tail_text = String::from_utf8_lossy(&tail);
    let mut lines = tail_text.lines().peekable();
    if tail_start > 0 {
        lines.next(); // a fragment, unless the file is smaller than the bound
    }
    let mut latest_user_text: Option<String> = None;
    let mut latest_user_at: Option<i64> = None;
    for line in lines {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() {
            continue;
        }
        let Ok(obj) = serde_json::from_str::<serde_json::Value>(line) else {
            continue; // malformed / truncated mid-write tail lands here
        };
        let at = obj
            .get("created_at")
            .or_else(|| obj.get("startedAt"))
            .and_then(parse_timestamp_ms);
        if obj.get("type").and_then(|v| v.as_str()) == Some("session_start") {
            // Round 7, Minor 2: a resumed conversation's LATER
            // `session_start` records land at the file's END — usually
            // far past the head window — so their `workspacePaths` are
            // collected HERE too (the pane-cwd match considers every
            // record; the first-record id rule is decided above).
            if let Some(paths) = obj.get("workspacePaths").and_then(|v| v.as_array()) {
                for path in paths.iter().filter_map(|p| p.as_str()) {
                    workspace_paths.push(path.to_string());
                }
            }
        }
        if obj.get("type").and_then(|v| v.as_str()) == Some("USER_INPUT") {
            if let Some(text) = obj.get("content").and_then(serde_json::Value::as_str) {
                // Text and its OWN timestamp move together (unchanged
                // rule): recency is proven by the matching record.
                latest_user_text = Some(normalize_prompt_text(text));
                latest_user_at = at;
            }
        }
    }
    let latest_user_text = latest_user_text?;

    Some(TranscriptSummary {
        conversation_id,
        workspace_paths,
        latest_user_text,
        latest_user_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    fn unique_temp_dir(label: &str) -> std::path::PathBuf {
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "freshell-antigravity-locator-test-{label}-{}-{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn locator_for(label: &str) -> (AntigravityLocator, std::path::PathBuf) {
        let home = unique_temp_dir(label);
        let root = home.join("brain");
        std::fs::create_dir_all(&root).unwrap();
        (AntigravityLocator::new(root.clone()), root)
    }

    /// Write a transcript in the corrected record vocabulary: the
    /// labeled fake-contract `session_start` ownership anchor plus
    /// real-shaped `USER_INPUT` user records (binary v1.4.12 discipline:
    /// `source`/`status`/`step_index` + a `created_at` timestamp —
    /// numeric epoch-ms, the shared timestamp coercion's second accepted
    /// form; each record's step_index is unique per transcript).
    fn write_transcript(
        root: &Path,
        conv: &str,
        cwd: &str,
        records: &[(&str, i64)], // (content, created_at) USER_INPUT records
    ) -> PathBuf {
        let path = root
            .join(conv)
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut body = format!(
            r#"{{"type":"session_start","conversationId":"{conv}","workspacePaths":["{cwd}"],"startedAt":{start}}}"#,
            conv = conv,
            cwd = cwd,
            start = records.first().map(|r| r.1).unwrap_or(0),
        );
        for (step, (text, at)) in records.iter().enumerate() {
            body.push_str(&format!(
                "\n{{\"type\":\"USER_INPUT\",\"source\":\"USER_EXPLICIT\",\"status\":\"DONE\",\"step_index\":{step},\"created_at\":{at},\"content\":\"{text}\"}}",
            ));
        }
        body.push('\n');
        std::fs::write(&path, body).unwrap();
        path
    }

    const T0: i64 = 1_700_000_000_000;

    #[test]
    fn zero_cost_when_idle_and_zero_turn_never_scans() {
        let (locator, _root) = locator_for("idle");
        assert!(locator.arm("t1", "/tmp"));
        // No submit -> no window -> tick never scans.
        assert!(locator.tick(T0 + 10_000).is_empty());
        assert_eq!(locator.fs_scan_count(), 0, "no window -> zero fs cost");
        // A submit BEFORE the window elapses is not due yet either.
        assert!(locator.note_submit("t1", "hello", T0));
        assert!(locator.tick(T0 + 1_000).is_empty());
        assert_eq!(
            locator.fs_scan_count(),
            0,
            "not-yet-due window -> zero fs cost"
        );
    }

    #[test]
    fn first_submit_matches_the_own_conversation_transcript() {
        let (locator, root) = locator_for("first-bind");
        let cwd = "/tmp/agy-first";
        std::fs::create_dir_all(cwd).unwrap();
        locator.arm("t1", cwd);
        write_transcript(&root, "conv-own", cwd, &[("hello world", T0)]);
        assert!(locator.note_submit("t1", "hello world", T0));
        let located = locator.tick(T0 + ANTIGRAVITY_WINDOW_MS + 1);
        assert_eq!(located.len(), 1);
        assert_eq!(located[0].conversation_id, "conv-own");
        assert_eq!(located[0].terminal_id, "t1");
        assert_eq!(
            located[0].transcript_path,
            root.join("conv-own/.system_generated/logs/transcript.jsonl")
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Whole-delta review Major 2 pin: the comparison is the FULL
    /// normalized text on BOTH sides — a multi-line captured submit
    /// (Ctrl+J between the lines, joined by the ws capture into one
    /// buffer) binds the transcript whose user record carries both
    /// lines. The record's text embeds the newline JSON-escaped; both
    /// sides normalize through the same `normalize_prompt_text`, and the
    /// embedded newline survives it (only the edges trim).
    #[test]
    fn multiline_prompt_matches_the_full_user_record_text() {
        let (locator, root) = locator_for("multiline");
        let cwd = "/tmp/agy-multiline";
        std::fs::create_dir_all(cwd).unwrap();
        locator.arm("t1", cwd);
        // "line1\nline2" JSON-escaped inside the record text — the
        // candidate recorded form for a Ctrl+J prompt (Stage-1 candidate
        // contract: the exact byte the CLI writes for an in-prompt
        // newline is fixture-validated only).
        write_transcript(&root, "conv-multi", cwd, &[("line1\\nline2", T0)]);
        assert!(locator.note_submit("t1", "line1\nline2", T0));
        let located = locator.tick(T0 + ANTIGRAVITY_WINDOW_MS + 1);
        assert_eq!(
            located.len(),
            1,
            "a multi-line prompt binds the full-text record"
        );
        assert_eq!(located[0].conversation_id, "conv-multi");
        // Edge-trimming symmetry: leading/trailing newlines on either
        // side normalize away — a capture that picked up a stray edge
        // newline binds the same record text. The second match must be
        // tolerance-legal while the FIRST conversation's identical text
        // is NOT (its record predates the new submit by more than
        // ANTIGRAVITY_RECENCY_BACKWARD_TOLERANCE_MS — under the round-3
        // tolerance, two same-text records 10 ms apart would BOTH be
        // legitimate candidates and the pane must refuse them as
        // ambiguous, which the dedicated ambiguity test pins instead).
        let second_submit = T0 + 20_000;
        write_transcript(
            &root,
            "conv-multi-edge",
            cwd,
            &[("line1\\nline2", second_submit + 10)],
        );
        assert!(locator.note_submit("t1", "\nline1\nline2\n", second_submit));
        let located = locator.tick(second_submit + ANTIGRAVITY_WINDOW_MS + 1);
        assert_eq!(
            located.len(),
            1,
            "edge newlines trim away on both sides of the comparison"
        );
        assert_eq!(located[0].conversation_id, "conv-multi-edge");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_transcript_with_a_different_latest_user_text_never_matches() {
        let (locator, root) = locator_for("wrong-text");
        let cwd = "/tmp/agy-wrong-text";
        std::fs::create_dir_all(cwd).unwrap();
        locator.arm("t1", cwd);
        write_transcript(
            &root,
            "conv-decoy",
            cwd,
            &[("a completely different prompt", T0)],
        );
        assert!(locator.note_submit("t1", "the real prompt", T0 + 5));
        // The pane's OWN conversation (carrying the right text) must exist
        // too, or the refusal below could pass vacuously.
        write_transcript(&root, "conv-own", cwd, &[("the real prompt", T0 + 10)]);
        let located = locator.tick(T0 + 5 + ANTIGRAVITY_WINDOW_MS + 1);
        assert_eq!(
            located.len(),
            1,
            "only the content-matching transcript binds"
        );
        assert_eq!(located[0].conversation_id, "conv-own");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn recency_rejects_transcripts_whose_matching_user_record_predates_the_submit() {
        let (locator, root) = locator_for("recency");
        let cwd = "/tmp/agy-recency";
        std::fs::create_dir_all(cwd).unwrap();
        locator.arm("t1", cwd);
        // An OLD transcript whose latest user record carries exactly the
        // pane's re-typed prompt — that record predates the submit.
        write_transcript(&root, "conv-old", cwd, &[("re-typed old prompt", T0)]);
        assert!(locator.note_submit("t1", "re-typed old prompt", T0 + 60_000));
        // The pane's own fresh conversation (same text, written now).
        write_transcript(
            &root,
            "conv-own",
            cwd,
            &[("re-typed old prompt", T0 + 60_100)],
        );
        let located = locator.tick(T0 + 60_000 + ANTIGRAVITY_WINDOW_MS + 1);
        assert_eq!(
            located.len(),
            1,
            "the old transcript is rejected by recency"
        );
        assert_eq!(located[0].conversation_id, "conv-own");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Adversarial recency shape: the transcript's LATEST user record
    /// matches the submit text but was written BEFORE the submit, while a
    /// LATER record of another type (an assistant record still streaming)
    /// was written after it. Recency must be proven by the MATCHING user
    /// record's own timestamp — a newest-record-of-any-type check alone
    /// would let this foreign transcript through as the sole candidate.
    #[test]
    fn recency_requires_the_matching_user_records_own_timestamp_not_a_later_record() {
        let (locator, root) = locator_for("matching-recency");
        let cwd = "/tmp/agy-matching-recency";
        std::fs::create_dir_all(cwd).unwrap();
        locator.arm("t1", cwd);
        let path = root
            .join("conv-foreign")
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        // The foreign transcript: its latest user record (the matching
        // text) was written at T0, and a PLANNER_RESPONSE record written
        // at T0+60_050 keeps the file live AFTER the pane's submit.
        std::fs::write(
            &path,
            format!(
                concat!(
                    r#"{{"type":"session_start","conversationId":"conv-foreign","workspacePaths":["{cwd}"],"startedAt":{t0}}}"#,
                    "\n",
                    r#"{{"type":"USER_INPUT","source":"USER_EXPLICIT","status":"DONE","step_index":0,"created_at":{t0},"content":"identical prompt text"}}"#,
                    "\n",
                    r#"{{"type":"PLANNER_RESPONSE","source":"MODEL","status":"DONE","step_index":1,"created_at":{after},"content":"a reply still streaming"}}"#,
                    "\n",
                ),
                cwd = cwd,
                t0 = T0,
                after = T0 + 60_050,
            ),
        )
        .unwrap();
        // The pane submits the identical text at T0+60_000: AFTER the
        // matching user record, BEFORE the later assistant record.
        assert!(locator.note_submit("t1", "identical prompt text", T0 + 60_000));
        let located = locator.tick(T0 + 60_000 + ANTIGRAVITY_WINDOW_MS + 1);
        assert!(
            located.is_empty(),
            "a matching user record written BEFORE the submit is not a candidate, \
             even when a later non-user record postdates the submit: {located:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn ambiguous_matches_refuse_all_and_never_guess() {
        let (locator, root) = locator_for("ambiguous");
        let cwd = "/tmp/agy-ambiguous";
        std::fs::create_dir_all(cwd).unwrap();
        locator.arm("t1", cwd);
        assert!(locator.note_submit("t1", "duplicate prompt", T0));
        write_transcript(&root, "conv-a", cwd, &[("duplicate prompt", T0 + 100)]);
        write_transcript(&root, "conv-b", cwd, &[("duplicate prompt", T0 + 100)]);
        let located = locator.tick(T0 + ANTIGRAVITY_WINDOW_MS + 1);
        assert!(
            located.is_empty(),
            "two matching transcripts -> refuse all (never a guess)"
        );
        // The pane STAYS armed: a later solo submit re-opens evaluation.
        assert_eq!(locator.armed_count(), 1);
        assert!(locator.note_submit("t1", "solo follow up", T0 + 10_000));
        write_transcript(
            &root,
            "conv-a",
            cwd,
            &[
                ("duplicate prompt", T0 + 100),
                ("solo follow up", T0 + 10_100),
            ],
        );
        let located = locator.tick(T0 + 10_000 + ANTIGRAVITY_WINDOW_MS + 1);
        assert_eq!(located.len(), 1, "a later solo window resolves the pane");
        assert_eq!(located[0].conversation_id, "conv-a");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn cwd_mismatch_never_matches_even_with_identical_text() {
        let (locator, root) = locator_for("cwd");
        let cwd = "/tmp/agy-cwd";
        let other = "/tmp/agy-cwd-other";
        std::fs::create_dir_all(cwd).unwrap();
        std::fs::create_dir_all(other).unwrap();
        locator.arm("t1", cwd);
        assert!(locator.note_submit("t1", "shared prompt text", T0));
        write_transcript(
            &root,
            "conv-foreign",
            other,
            &[("shared prompt text", T0 + 100)],
        );
        let located = locator.tick(T0 + ANTIGRAVITY_WINDOW_MS + 1);
        assert!(
            located.is_empty(),
            "workspacePaths must CONTAIN the pane cwd"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn multi_workspace_paths_match_on_any_contained_cwd() {
        let (locator, root) = locator_for("multi-cwd");
        let primary = "/tmp/agy-multi-primary";
        let secondary = "/tmp/agy-multi-secondary";
        std::fs::create_dir_all(primary).unwrap();
        std::fs::create_dir_all(secondary).unwrap();
        locator.arm("t1", secondary);
        assert!(locator.note_submit("t1", "secondary prompt", T0));
        let path = root
            .join("conv-multi")
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            format!(
                concat!(
                    r#"{{"type":"session_start","conversationId":"conv-multi","workspacePaths":["{primary}","{secondary}"],"startedAt":{t0}}}"#,
                    "\n",
                    r#"{{"type":"USER_INPUT","source":"USER_EXPLICIT","status":"DONE","step_index":0,"created_at":{t0},"content":"secondary prompt"}}"#,
                    "\n",
                ),
                primary = primary,
                secondary = secondary,
                t0 = T0,
            ),
        )
        .unwrap();
        let located = locator.tick(T0 + ANTIGRAVITY_WINDOW_MS + 1);
        assert_eq!(located.len(), 1, "any contained workspacePath matches");
        assert_eq!(located[0].conversation_id, "conv-multi");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Round 7, Minor 2: the pane-cwd match considers EVERY
    /// `session_start` record's `workspacePaths`, not only the FIRST
    /// one. A resumed conversation APPENDS a later `session_start`
    /// record (the fake-contract ownership anchor's
    /// `{source:"resume"}` shape — real transcripts carry no ownership
    /// records at all; the fakes append them) whose `workspacePaths`
    /// name the RESUME cwd — which can differ from the first record's
    /// workspace (a CLI/MCP resume with a different `cwd`, an in-CLI
    /// `/resume` across workspaces). Pre-fix the head probe `break`ed
    /// at the first ownership record, so a pane whose cwd matched only
    /// a LATER record never bound (no activity lane, no
    /// in-CLI-switch rebind). The parser's first-record-as-primary
    /// DISPLAY rule is untouched — only the LOCATOR's match widens.
    ///
    /// Both directions: (a) a first-record workspace match still binds
    /// (pinned); (b) an ONLY-later-record workspace match now binds
    /// (the round-7 fix). The later record sits PAST the 64 KiB head
    /// window (a >64 KiB filler user record precedes it — the realistic
    /// resumed shape: the resume lands at the END of a long
    /// conversation), so (b) proves the TAIL window's collection.
    #[test]
    fn a_later_session_start_workspace_still_matches_the_pane_cwd() {
        // (a) FIRST-record match: pinned behavior, later record present.
        let (locator_a, root_a) = locator_for("later-start-first");
        let first_cwd = "/tmp/agy-later-first";
        let resumed_cwd = "/tmp/agy-later-resumed";
        std::fs::create_dir_all(first_cwd).unwrap();
        std::fs::create_dir_all(resumed_cwd).unwrap();
        write_resumed_transcript(
            &root_a,
            "conv-later-a",
            first_cwd,
            resumed_cwd,
            "first-record prompt",
        );
        locator_a.arm("t1", first_cwd);
        assert!(locator_a.note_submit("t1", "first-record prompt", T0));
        let located = locator_a.tick(T0 + ANTIGRAVITY_WINDOW_MS + 1);
        assert_eq!(
            located.len(),
            1,
            "a first-record workspace match still binds with a later session_start present"
        );
        assert_eq!(located[0].conversation_id, "conv-later-a");

        // (b) ONLY-later-record match: the round-7 fix. The pane's cwd
        // appears in NO record but the LATER session_start.
        let (locator_b, root_b) = locator_for("later-start-only");
        write_resumed_transcript(
            &root_b,
            "conv-later-b",
            first_cwd,
            resumed_cwd,
            "later-record prompt",
        );
        locator_b.arm("t1", resumed_cwd);
        assert!(locator_b.note_submit("t1", "later-record prompt", T0));
        let located = locator_b.tick(T0 + ANTIGRAVITY_WINDOW_MS + 1);
        assert_eq!(
            located.len(),
            1,
            "a workspace appearing only in a LATER session_start record binds the pane"
        );
        assert_eq!(located[0].conversation_id, "conv-later-b");
        assert_eq!(
            located[0].terminal_id, "t1",
            "the later-record match attributes the conversation to the pane"
        );

        let _ = std::fs::remove_dir_all(&root_a);
        let _ = std::fs::remove_dir_all(&root_b);
    }

    /// The resumed-conversation transcript shape for
    /// [`a_later_session_start_workspace_still_matches_the_pane_cwd`]:
    /// the fake-contract ownership anchor (workspace `first_cwd`), an
    /// over-64 KiB filler USER_INPUT record (pushing the resume past the
    /// head window), a LATER `session_start {source:"resume"}` anchor
    /// (workspace `resumed_cwd`), and the matching latest user record —
    /// all user records in the real binary vocabulary (step_index +
    /// created_at).
    fn write_resumed_transcript(
        root: &Path,
        conv: &str,
        first_cwd: &str,
        resumed_cwd: &str,
        latest_prompt: &str,
    ) -> PathBuf {
        let path = root
            .join(conv)
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        // A single >64 KiB JSON string line (no metacharacters — 'x's).
        let filler = "x".repeat(70 * 1024);
        let body = format!(
            concat!(
                r#"{{"type":"session_start","conversationId":"{conv}","workspacePaths":["{first}"],"startedAt":{t0}}}"#,
                "\n",
                r#"{{"type":"USER_INPUT","source":"USER_EXPLICIT","status":"DONE","step_index":0,"created_at":{t0a},"content":"{filler}"}}"#,
                "\n",
                r#"{{"type":"session_start","conversationId":"{conv}","workspacePaths":["{resumed}"],"startedAt":{t0b},"source":"resume"}}"#,
                "\n",
                r#"{{"type":"USER_INPUT","source":"USER_EXPLICIT","status":"DONE","step_index":1,"created_at":{t0c},"content":"{latest}"}}"#,
                "\n",
            ),
            conv = conv,
            first = first_cwd,
            resumed = resumed_cwd,
            filler = filler,
            latest = latest_prompt,
            t0 = T0,
            t0a = T0 + 100,
            t0b = T0 + 200,
            t0c = T0 + 500,
        );
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn a_later_enter_replaces_the_in_flight_window() {
        let (locator, root) = locator_for("reopen");
        let cwd = "/tmp/agy-reopen";
        std::fs::create_dir_all(cwd).unwrap();
        locator.arm("t1", cwd);
        assert!(locator.note_submit("t1", "first prompt", T0));
        // A second Enter BEFORE the first window resolves: the latest
        // Enter is the live prompt (the transcript's latest user record
        // has moved on) — the captured line is REPLACED, not held.
        assert!(locator.note_submit("t1", "second prompt", T0 + 500));
        write_transcript(
            &root,
            "conv-own",
            cwd,
            &[("first prompt", T0 + 100), ("second prompt", T0 + 600)],
        );
        let located = locator.tick(T0 + 500 + ANTIGRAVITY_WINDOW_MS + 1);
        assert_eq!(located.len(), 1);
        assert_eq!(located[0].conversation_id, "conv-own");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn same_tick_cross_claim_of_one_conversation_is_refused_for_both() {
        let (locator, root) = locator_for("cross-claim");
        let cwd = "/tmp/agy-cross-claim";
        std::fs::create_dir_all(cwd).unwrap();
        locator.arm("t1", cwd);
        locator.arm("t2", cwd);
        assert!(locator.note_submit("t1", "identical prompt", T0));
        assert!(locator.note_submit("t2", "identical prompt", T0));
        // One transcript with that text — claimed by both panes.
        write_transcript(&root, "conv-one", cwd, &[("identical prompt", T0 + 100)]);
        let located = locator.tick(T0 + ANTIGRAVITY_WINDOW_MS + 1);
        assert!(
            located.is_empty(),
            "one conversation claimed by two panes -> refused for both: {located:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_latest_user_record_wins_over_earlier_ones() {
        let (locator, root) = locator_for("latest-user");
        let cwd = "/tmp/agy-latest-user";
        std::fs::create_dir_all(cwd).unwrap();
        locator.arm("t1", cwd);
        // The transcript's FIRST user record is an old prompt; the LATEST
        // is the resumed conversation's prompt (the /resume form).
        write_transcript(
            &root,
            "conv-resumed",
            cwd,
            &[("the old prompt", T0), ("the resumed prompt", T0 + 1_000)],
        );
        assert!(locator.note_submit("t1", "the resumed prompt", T0 + 900));
        let located = locator.tick(T0 + 900 + ANTIGRAVITY_WINDOW_MS + 1);
        assert_eq!(located.len(), 1, "the LATEST user record is the evidence");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Whole-delta review round 2, Major 1: a submit whose first scan
    /// matched NOTHING must STAY PENDING — the CLI can write its first
    /// user record well after the scan (slow startup, an auth flow before
    /// the record lands), and the recency rule already requires the
    /// matching record at/after the submit, so a late write is exactly
    /// the case the window exists to catch. A resolved-on-first-scan
    /// locator would drop the pane's only chance to bind that
    /// conversation (losing exact identity and crash resume) unless the
    /// user submits again.
    #[test]
    fn an_unmatched_submit_stays_pending_and_binds_a_transcript_written_after_the_scan() {
        let (locator, root) = locator_for("pending-late-write");
        let cwd = "/tmp/agy-pending-late-write";
        std::fs::create_dir_all(cwd).unwrap();
        locator.arm("t1", cwd);
        assert!(locator.note_submit("t1", "slow start prompt", T0));
        // The first due scan finds NO transcript at all (the CLI has not
        // written its first user record yet — the review's slow-startup
        // shape). The submit must stay PENDING, not resolve.
        let located = locator.tick(T0 + ANTIGRAVITY_WINDOW_MS + 1);
        assert!(located.is_empty(), "nothing on disk yet — no bind");
        assert_eq!(locator.fs_scan_count(), 1);
        // The transcript is written AFTER that first scan (the record's
        // own `at` postdates the submit — recency holds).
        write_transcript(
            &root,
            "conv-late",
            cwd,
            &[("slow start prompt", T0 + 3_000)],
        );
        // A later tick re-evaluates the still-pending submit and BINDS.
        let located = locator.tick(T0 + 3_000 + ANTIGRAVITY_WINDOW_MS + 1);
        assert_eq!(
            located.len(),
            1,
            "a transcript first written after the scan still binds the pending submit: \
             {located:?}"
        );
        assert_eq!(located[0].conversation_id, "conv-late");
        assert_eq!(located[0].terminal_id, "t1");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The pending submit's bounded lifetime: a submit that never matched
    /// is dropped after `ANTIGRAVITY_PENDING_SUBMIT_LIFETIME_MS`, so it
    /// can never pin a window forever or bind an unrelated conversation
    /// written much later.
    #[test]
    fn an_expired_pending_submit_never_binds_a_much_later_write() {
        let (locator, root) = locator_for("pending-expiry");
        let cwd = "/tmp/agy-pending-expiry";
        std::fs::create_dir_all(cwd).unwrap();
        locator.arm("t1", cwd);
        assert!(locator.note_submit("t1", "never matched prompt", T0));
        // The first scan matches nothing; the submit stays pending.
        let located = locator.tick(T0 + ANTIGRAVITY_WINDOW_MS + 1);
        assert!(located.is_empty());
        // A transcript carrying that exact text is written LONG after the
        // lifetime has elapsed (an unrelated future conversation — the
        // hazard the bound exists to contain).
        let much_later = T0 + ANTIGRAVITY_PENDING_SUBMIT_LIFETIME_MS + 60_000;
        write_transcript(
            &root,
            "conv-unrelated",
            cwd,
            &[("never matched prompt", much_later)],
        );
        let located = locator.tick(much_later + ANTIGRAVITY_WINDOW_MS + 1);
        assert!(
            located.is_empty(),
            "an expired pending submit never binds a much-later write: {located:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Round 7, Minor 1: a clean submit that never binds must leave a
    /// diagnosable trace. Pre-fix both silent paths — the pending
    /// lifetime's expiry (`armed.resolved = true; continue;`) and
    /// `note_submit`'s false return for an UN-ARMED pane (e.g. no
    /// registry cwd) — dropped the submit with no log line, so the most
    /// likely real failure modes (the candidate schema mismatching, a
    /// wrong store root, a cwd mismatch) were invisible. The fix emits
    /// a rate-limited `antigravity_association_unmatched` WARN carrying
    /// the terminal id, the reason, and a content-free submit
    /// FINGERPRINT (a sha256 prefix — Global Constraint 7 forbids
    /// prompt CONTENT in logs, so the full prompt never appears).
    ///
    /// The expiry callsite is fired by this module's other tests without
    /// a subscriber (the tracing callsite interest cache is
    /// process-wide), so the capture is isolated in a child process
    /// exactly like
    /// `antigravity::tests::parse_failures_emit_antigravity_parse_failed_events`.
    #[test]
    fn unmatched_submits_emit_rate_limited_warn_events() {
        const CHILD_ENV: &str = "FRESHELL_ANTIGRAVITY_UNMATCHED_LOG_CAPTURE_CHILD";
        if std::env::var_os(CHILD_ENV).is_none() {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "antigravity_locator::tests::unmatched_submits_emit_rate_limited_warn_events",
                    "--nocapture",
                ])
                .env(CHILD_ENV, "1")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "isolated unmatched-submit log capture failed: {} {}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }

        use std::collections::BTreeMap;
        use std::sync::{Arc, Mutex as StdMutex};
        use tracing_subscriber::layer::SubscriberExt;
        #[derive(Clone)]
        struct Capture(Arc<StdMutex<Vec<BTreeMap<String, String>>>>);
        impl<S: tracing::Subscriber> tracing_subscriber::layer::Layer<S> for Capture {
            fn on_event(
                &self,
                event: &tracing::Event<'_>,
                _: tracing_subscriber::layer::Context<'_, S>,
            ) {
                struct Fields(BTreeMap<String, String>);
                impl tracing::field::Visit for Fields {
                    fn record_debug(
                        &mut self,
                        field: &tracing::field::Field,
                        value: &dyn std::fmt::Debug,
                    ) {
                        self.0.insert(field.name().into(), format!("{value:?}"));
                    }
                    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
                        self.0.insert(field.name().into(), value.into());
                    }
                }
                let mut fields = Fields(BTreeMap::new());
                event.record(&mut fields);
                if event.metadata().level() == &tracing::Level::WARN
                    && fields.0.get("event").map(String::as_str)
                        == Some("antigravity_association_unmatched")
                {
                    self.0.lock().unwrap().push(fields.0);
                }
            }
        }
        let events = Arc::new(StdMutex::new(Vec::new()));
        let subscriber = tracing_subscriber::registry().with(Capture(events.clone()));
        let _guard = tracing::subscriber::set_default(subscriber);

        // (1) A NORMAL BIND produces NO unmatched event.
        let (locator, root) = locator_for("unmatched-bind");
        let cwd = "/tmp/agy-unmatched-bind";
        std::fs::create_dir_all(cwd).unwrap();
        locator.arm("t-bind", cwd);
        write_transcript(&root, "conv-bind", cwd, &[("binding prompt", T0)]);
        assert!(locator.note_submit("t-bind", "binding prompt", T0));
        let located = locator.tick(T0 + ANTIGRAVITY_WINDOW_MS + 1);
        assert_eq!(located.len(), 1, "the pane binds its own conversation");
        assert!(
            events.lock().unwrap().is_empty(),
            "a normal bind emits no unmatched event"
        );

        // (2) EXPIRY: an armed pane's submit matches nothing for its
        // whole lifetime → exactly one WARN carrying the terminal id,
        // reason=expired, and a non-empty fingerprint.
        let unmatched_prompt = "never binds anywhere secret prompt";
        locator.arm("t1", "/tmp/agy-unmatched-expiry");
        assert!(locator.note_submit("t1", unmatched_prompt, T0));
        let expiry_tick = T0 + ANTIGRAVITY_PENDING_SUBMIT_LIFETIME_MS + 1;
        assert!(locator.tick(expiry_tick).is_empty());
        {
            let captured = events.lock().unwrap();
            assert_eq!(
                captured.len(),
                1,
                "the unmatched expiry emits exactly one warn: {captured:?}"
            );
            let event = &captured[0];
            assert_eq!(event.get("terminal_id").map(String::as_str), Some("t1"));
            assert_eq!(event.get("reason").map(String::as_str), Some("expired"));
            let fingerprint = event.get("fingerprint").cloned().unwrap_or_default();
            assert!(
                !fingerprint.is_empty(),
                "the event carries the submit fingerprint: {event:?}"
            );
            assert!(
                !event.values().any(|v| v.contains(unmatched_prompt)),
                "the full prompt text never appears in any field (privacy): {event:?}"
            );
        }

        // (3) The note_submit FALSE path (an UN-ARMED pane — e.g. no
        // registry cwd): its own per-terminal lane emits on its first
        // submit…
        assert!(!locator.note_submit("t9", "unarmed pane prompt", expiry_tick + 100));
        assert_eq!(
            events.lock().unwrap().len(),
            2,
            "the un-armed note_submit false path emits its own event"
        );
        {
            let captured = events.lock().unwrap();
            let event = &captured[1];
            assert_eq!(event.get("terminal_id").map(String::as_str), Some("t9"));
            assert_eq!(event.get("reason").map(String::as_str), Some("not_armed"));
        }
        // …and the RATE LIMIT coalesces a burst: a second un-armed submit
        // 100 ms later on the SAME pane emits nothing.
        assert!(!locator.note_submit("t9", "unarmed pane prompt again", expiry_tick + 200));
        assert_eq!(
            events.lock().unwrap().len(),
            2,
            "the per-terminal rate limit coalesces the burst"
        );
        // Past the 60 s lane window the pane may warn again (the
        // operator sees at most one line per terminal per window).
        assert!(!locator.note_submit("t9", "unarmed pane prompt third", expiry_tick + 60_300));
        assert_eq!(
            events.lock().unwrap().len(),
            3,
            "the lane re-arms after its window"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The re-typed-prompt rejection survives the pending retry: a NEWER
    /// submit still REPLACES an older pending one, so a transcript
    /// written late for the OLD submit's text (even recency-legal against
    /// the old Enter) can never bind through the superseded window —
    /// only the newest submit is live.
    #[test]
    fn a_superseding_submit_replaces_a_pending_window_before_a_late_write_binds() {
        let (locator, root) = locator_for("pending-superseded");
        let cwd = "/tmp/agy-pending-superseded";
        std::fs::create_dir_all(cwd).unwrap();
        locator.arm("t1", cwd);
        // Submit A matches nothing on its first scan and stays pending.
        assert!(locator.note_submit("t1", "re-typed prompt", T0));
        assert!(locator.tick(T0 + ANTIGRAVITY_WINDOW_MS + 1).is_empty());
        // Submit B (the same text re-typed, the review's adversarial
        // shape) REPLACES the pending window at T0 + 30 s.
        let submit_b = T0 + 30_000;
        assert!(locator.note_submit("t1", "re-typed prompt", submit_b));
        // A transcript whose matching record was written after A's Enter
        // but BEFORE B's lands on disk: recency-legal for the OLD pending
        // window, stale for the LIVE one. Only the newest submit may
        // bind, so this late write of A's conversation is rejected.
        write_transcript(&root, "conv-a", cwd, &[("re-typed prompt", T0 + 10_000)]);
        let located = locator.tick(submit_b + ANTIGRAVITY_WINDOW_MS + 1);
        assert!(
            located.is_empty(),
            "the superseded pending window never binds: {located:?}"
        );
        // The live window's own conversation (written at/after B) binds.
        // (Round 6: the tick times below follow the PRODUCTION sweep's
        // 150 ms cadence — B's window opened at submit_b + WINDOW + 1,
        // and the backoff lane's fast-head delay is one sweep interval,
        // so the binding tick is one sweep later. The pre-lane test
        // ticked +1/+2 ms apart, a shape the real sweep can't produce.)
        write_transcript(&root, "conv-b", cwd, &[("re-typed prompt", submit_b + 500)]);
        let located = locator.tick(submit_b + ANTIGRAVITY_WINDOW_MS + 151);
        assert_eq!(located.len(), 1, "the newest submit's window binds");
        assert_eq!(located[0].conversation_id, "conv-b");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Whole-delta review round 6, Minor 1 — the pending-retry cost is
    /// BOUNDED. A submit that never matches (a slash command, an approval
    /// answer) stays pending for the full 60 s lifetime, and pre-fix the
    /// 150 ms production sweep re-walked the WHOLE brain tree on every
    /// tick (~387 walks per such submit, growing with conversation
    /// history). The backoff LANE bounds the walk count while preserving
    /// the full-lifetime coverage: the first scan runs at the window as
    /// before, retries then space out on a stepped schedule (150 ms while
    /// the submit is younger than ~4 s — the common quick-start case
    /// where the CLI writes its user record promptly — doubling steps up
    /// to a 5 s cap), and the lane NEVER stops before the lifetime ends,
    /// so a record written at ANY age still binds (within one cap
    /// interval). This test simulates the production sweep EXACTLY (a
    /// tick every 150 ms across the whole lifetime) and pins the walk
    /// bound.
    #[test]
    fn an_unmatched_submit_retries_on_a_bounded_backoff_lane() {
        let (locator, root) = locator_for("backoff-lane");
        let cwd = "/tmp/agy-backoff-lane";
        std::fs::create_dir_all(cwd).unwrap();
        locator.arm("t1", cwd);
        // A slash command never produces a matching user record — the
        // review's worst case.
        assert!(locator.note_submit("t1", "/help", T0));
        // The production sweep's exact cadence, run across the full
        // lifetime plus a 1 s tail.
        let mut now = T0 + ANTIGRAVITY_WINDOW_MS + 1;
        while now <= T0 + ANTIGRAVITY_PENDING_SUBMIT_LIFETIME_MS + 1_000 {
            assert!(locator.tick(now).is_empty());
            now += 150;
        }
        let walks = locator.fs_scan_count();
        assert!(walks > 1, "the pending submit keeps retrying: {walks}");
        assert!(
            walks <= ANTIGRAVITY_PENDING_MAX_WALKS_PER_LIFETIME,
            "the backoff lane bounds the retry cost (~46 walks per unmatched \
             submit at the 150 ms sweep, vs ~387 at the pre-fix flat cadence): \
             {walks}"
        );
        // The pane resolved at expiry (the lifetime bound), so the lane is
        // quiet afterwards: further ticks cost zero walks.
        let before = locator.fs_scan_count();
        assert!(locator.tick(now + 10_000).is_empty());
        assert_eq!(
            locator.fs_scan_count(),
            before,
            "an expired pending submit never walks again"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The lane's FAST head: a YOUNG pending window keeps scanning at the
    /// sweep's own 150 ms cadence (the common quick-start case), so a
    /// record the CLI writes just after the first scan binds on the very
    /// next sweep tick.
    #[test]
    fn a_young_pending_window_keeps_the_fast_sweep_cadence() {
        let (locator, root) = locator_for("fast-lane");
        let cwd = "/tmp/agy-fast-lane";
        std::fs::create_dir_all(cwd).unwrap();
        locator.arm("t1", cwd);
        assert!(locator.note_submit("t1", "quick start prompt", T0));
        assert!(locator.tick(T0 + ANTIGRAVITY_WINDOW_MS + 1).is_empty());
        assert_eq!(locator.fs_scan_count(), 1);
        assert!(locator.tick(T0 + ANTIGRAVITY_WINDOW_MS + 151).is_empty());
        assert_eq!(
            locator.fs_scan_count(),
            2,
            "a young pending window retries at the sweep cadence"
        );
        // The CLI's record lands between the scans; the NEXT 150 ms tick
        // binds it.
        write_transcript(
            &root,
            "conv-quick",
            cwd,
            &[("quick start prompt", T0 + ANTIGRAVITY_WINDOW_MS + 100)],
        );
        let located = locator.tick(T0 + ANTIGRAVITY_WINDOW_MS + 301);
        assert_eq!(located.len(), 1, "the quick-start bind is not delayed");
        assert_eq!(located[0].conversation_id, "conv-quick");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The lane's COVERAGE: a record written LATE in the lifetime (the
    /// slow-startup / auth-flow shape) still binds within one cap
    /// interval — the backoff stretches the retry spacing, it never
    /// cancels the retry before the lifetime ends.
    #[test]
    fn a_record_written_late_in_the_lifetime_still_binds_within_the_cap() {
        let (locator, root) = locator_for("late-coverage");
        let cwd = "/tmp/agy-late-coverage";
        std::fs::create_dir_all(cwd).unwrap();
        locator.arm("t1", cwd);
        assert!(locator.note_submit("t1", "slow auth flow prompt", T0));
        // The first due scan matches nothing; the submit stays pending.
        assert!(locator.tick(T0 + ANTIGRAVITY_WINDOW_MS + 1).is_empty());
        // The CLI finally writes its user record at age 50 s.
        write_transcript(
            &root,
            "conv-late",
            cwd,
            &[("slow auth flow prompt", T0 + 50_000)],
        );
        // The next lane tick (one 5 s cap interval later, the lane's
        // worst-case discovery latency for an old submit) binds it —
        // 60 s total coverage is preserved.
        let located = locator.tick(T0 + 50_000 + ANTIGRAVITY_PENDING_RESCAN_CAP_MS + 1);
        assert_eq!(
            located.len(),
            1,
            "a record written at age 50 s still binds within one cap interval"
        );
        assert_eq!(located[0].conversation_id, "conv-late");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Whole-delta review round 3, Major 1 — the flush-before-timestamp
    /// race: the registry writes input to the PTY BEFORE timestamping the
    /// `ActivityEvent::Input` (registry.rs writes, then stamps `at`), so
    /// the CLI child — scheduled on another core — can process the prompt
    /// and record its `USER_INPUT` between those two operations. The
    /// transcript's matching record then carries a `created_at` that
    /// PRECEDES the captured submit timestamp by the write→stamp latency,
    /// and the old strict `at >= submit` rule rejected the pane's own
    /// conversation on every retry. The backward tolerance accepts that
    /// race: a matching record stamped within the tolerance BEFORE the
    /// submit binds.
    #[test]
    fn a_record_stamped_slightly_before_the_submit_binds_within_the_tolerance() {
        let (locator, root) = locator_for("race-tolerance");
        let cwd = "/tmp/agy-race-tolerance";
        std::fs::create_dir_all(cwd).unwrap();
        locator.arm("t1", cwd);
        // The race shape: the child recorded the prompt 500 ms BEFORE the
        // server's Input-event timestamp landed (the PTY write → child
        // write → server stamp ordering the review described).
        let submit_at = T0;
        write_transcript(
            &root,
            "conv-raced",
            cwd,
            &[("race prompt", submit_at - 500)],
        );
        assert!(locator.note_submit("t1", "race prompt", submit_at));
        let located = locator.tick(submit_at + ANTIGRAVITY_WINDOW_MS + 1);
        assert_eq!(
            located.len(),
            1,
            "a matching record stamped within the backward tolerance before \
             the submit is the pane's own conversation: {located:?}"
        );
        assert_eq!(located[0].conversation_id, "conv-raced");
        assert_eq!(located[0].submit_at_ms, submit_at);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The mtime prefilter must honor the FULL backward tolerance: a
    /// transcript whose matching record landed inside the tolerance (but
    /// before the prefilter's old 2 s cushion) has an mtime that predates
    /// `submit - 2 s`, and a prefilter tighter than the tolerance would
    /// veto a match the recency rule itself accepts.
    #[test]
    fn the_mtime_prefilter_honors_the_full_backward_tolerance() {
        let (locator, root) = locator_for("race-prefilter");
        let cwd = "/tmp/agy-race-prefilter";
        std::fs::create_dir_all(cwd).unwrap();
        locator.arm("t1", cwd);
        let submit_at = T0;
        // 3 s before the submit: inside the 5 s tolerance, OUTSIDE the old
        // 2 s mtime cushion — only a prefilter widened to the tolerance
        // lets this probe through.
        write_transcript(
            &root,
            "conv-prefilter",
            cwd,
            &[("prefilter prompt", submit_at - 3_000)],
        );
        assert!(locator.note_submit("t1", "prefilter prompt", submit_at));
        let located = locator.tick(submit_at + ANTIGRAVITY_WINDOW_MS + 1);
        assert_eq!(
            located.len(),
            1,
            "the prefilter never vetoes a match the tolerance accepts: {located:?}"
        );
        assert_eq!(located[0].conversation_id, "conv-prefilter");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The tolerance is BOUNDED: an old conversation (minutes old) whose
    /// latest user record happens to equal the pane's re-typed prompt is
    /// still rejected — the backward tolerance covers cross-process skew,
    /// not history (the forward pin guarding the other direction).
    #[test]
    fn a_transcript_from_minutes_before_the_submit_still_never_binds() {
        let (locator, root) = locator_for("race-old-still-rejected");
        let cwd = "/tmp/agy-race-old";
        std::fs::create_dir_all(cwd).unwrap();
        locator.arm("t1", cwd);
        // The old conversation: its matching record predates the submit by
        // far more than the tolerance.
        write_transcript(
            &root,
            "conv-old",
            cwd,
            &[("minutes old prompt", T0 - 300_000)],
        );
        assert!(locator.note_submit("t1", "minutes old prompt", T0));
        let located = locator.tick(T0 + ANTIGRAVITY_WINDOW_MS + 1);
        assert!(
            located.is_empty(),
            "a transcript from minutes before the submit is still rejected: {located:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn note_submit_normalizes_and_bounds_the_captured_line() {
        let (locator, _root) = locator_for("normalize");
        locator.arm("t1", "/tmp");
        assert!(locator.note_submit("t1", "  padded prompt  ", T0));
        assert!(
            !locator.note_submit("t1", "   ", T0),
            "whitespace-only never opens a window"
        );
        assert!(
            !locator.note_submit("t-unknown", "hello", T0),
            "un-armed panes are refused"
        );
        let long = "x".repeat(MAX_SUBMIT_COMPARE_CHARS + 100);
        assert!(locator.note_submit("t1", &long, T0));
        {
            // Scope the guard: note_submit re-locks the same (non-reentrant)
            // mutex below.
            let inner = locator.inner.lock().unwrap();
            let captured = inner
                .armed
                .get("t1")
                .and_then(|a| a.submit.as_ref())
                .expect("captured submit");
            assert_eq!(captured.text.chars().count(), MAX_SUBMIT_COMPARE_CHARS);
            assert_eq!(captured.text, "x".repeat(MAX_SUBMIT_COMPARE_CHARS));
        }
        assert!(
            locator.note_submit("t1", "padded prompt", T0 + 1),
            "a fresh submit replaces the bounded window"
        );
    }

    #[test]
    fn arm_is_idempotent_and_requires_a_cwd() {
        let (locator, _root) = locator_for("arm");
        assert!(locator.arm("t1", "/tmp"));
        assert!(
            !locator.arm("t1", "/tmp"),
            "already armed -> idempotent false"
        );
        assert!(!locator.arm("t2", ""), "empty cwd -> refused");
        assert!(!locator.arm("", "/tmp"), "empty terminal id -> refused");
        locator.disarm("t1");
        assert_eq!(locator.armed_count(), 0);
    }

    #[test]
    fn non_transcript_files_in_the_root_are_never_candidates() {
        let (locator, root) = locator_for("layout");
        let cwd = "/tmp/agy-layout";
        std::fs::create_dir_all(cwd).unwrap();
        locator.arm("t1", cwd);
        assert!(locator.note_submit("t1", "layout prompt", T0));
        // A cache file the layout explicitly excludes, plus a misplaced
        // transcript (wrong ancestor chain) — neither may ever bind.
        std::fs::create_dir_all(root.parent().unwrap().join("cache")).unwrap();
        std::fs::write(
            root.parent().unwrap().join("cache/last_conversations.json"),
            r#"{"type":"session_start","conversationId":"conv-cache","workspacePaths":["/tmp/agy-layout"],"startedAt":1}"#,
        )
        .unwrap();
        std::fs::create_dir_all(root.join("conv-misplaced/logs")).unwrap();
        std::fs::write(
            root.join("conv-misplaced/logs/transcript.jsonl"),
            format!(
                r#"{{"type":"session_start","conversationId":"conv-misplaced","workspacePaths":["{cwd}"],"startedAt":{T0}}}"#,
            ),
        )
        .unwrap();
        let located = locator.tick(T0 + ANTIGRAVITY_WINDOW_MS + 1);
        assert!(
            located.is_empty(),
            "only the layout's transcript chain qualifies"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn user_input_content_and_created_at_drive_the_latest_user_match() {
        // Real binary v1.4.12 vocabulary: the latest user record is a
        // USER_INPUT{source:USER_EXPLICIT, content, created_at} — no
        // user_message/text/at record exists (binary evidence). The
        // ownership anchor (session_start) stays the fake-contract cwd/id
        // evidence; the USER-record arm is real vocabulary.
        let dir = unique_temp_dir("user-input-record");
        let conv = "11111111-2222-3333-4444-555555555555";
        let logs = dir
            .join("brain")
            .join(conv)
            .join(".system_generated")
            .join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let transcript = logs.join("transcript.jsonl");
        std::fs::write(
            &transcript,
            concat!(
                r#"{"type":"session_start","conversationId":"11111111-2222-3333-4444-555555555555","workspacePaths":["/w"]}"#,
                "\n",
                r#"{"type":"GENERIC","source":"MODEL","status":"DONE","step_index":1,"created_at":"2026-10-29T20:00:02Z","content":"<noise>"}"#,
                "\n",
                r#"{"type":"USER_INPUT","source":"USER_EXPLICIT","status":"DONE","step_index":2,"created_at":"2026-10-29T20:00:03Z","content":"the real submitted prompt"}"#,
                "\n",
            ),
        )
        .unwrap();
        let summary = probe_transcript(&transcript).expect("the transcript binds");
        assert_eq!(summary.conversation_id, conv);
        // The tiny file sits inside BOTH bounded windows, so the anchor's
        // workspacePaths are collected once per window (the head+tail
        // overlap; the pane-cwd matcher's `.any()` is duplicate-tolerant).
        // The pin: the anchor's workspace IS surfaced for the cwd match.
        assert!(summary.workspace_paths.contains(&"/w".to_string()));
        assert_eq!(summary.latest_user_text, "the real submitted prompt");
        assert_eq!(summary.latest_user_at, Some(1_793_304_003_000));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

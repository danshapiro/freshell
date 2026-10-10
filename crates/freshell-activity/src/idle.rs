//! The NEW truly-idle gate (`terminal.idle`) — no legacy counterpart.
//!
//! Pinned wire contract: `{ terminalId, at (server epoch ms), reason:
//! 'grace' | 'queue-empty' }`, emitted ONCE per busy→truly-idle transition.
//!
//! Semantics (terminal.idle is never emitted after a HUMAN-REQUESTED stop;
//! it IS emitted for failed turns, non-human abort reasons (forward-compatible
//! — none emitted at codex <= 0.147), spontaneous death while engaged, and
//! approval pauses; see shared/ws-protocol.ts terminal.idle doc):
//! * a turn boundary (the provider's positive turn end) ARMS a grace window
//!   (default [`IDLE_GRACE_MS`] = 2000ms);
//! * new activity within the window EXTENDS it (amplifier: any events.jsonl
//!   append — post-complete background naming events mean "not truly idle
//!   yet"; claude/codex: a queued prompt auto-starting the next turn re-buses
//!   the terminal, which CANCELS the pending emission entirely);
//! * a busy re-entry cancels; the next boundary re-arms;
//! * the window lapsing emits exactly one `terminal.idle`; the reason is
//!   `queue-empty` when queue evidence accrued since the last emission (a
//!   boundary while the tracker still reported busy, or a codex
//!   busy→pending re-arm), else `grace`;
//! * a turn boundary while the tracker still reports busy/pending is a
//!   QUEUED turn: it records queue evidence and never arms mid-turn;
//! * subagent/tool completions inside a running turn never reach this gate
//!   (the trackers only report REAL turn boundaries);
//! * spontaneous death (exit removal while `is_engaged`): the gate itself
//!   never emits for a removed terminal. The hub reads `is_engaged` BEFORE
//!   removal and emits the exit-death bell directly. `is_engaged` deliberately
//!   excludes the input-only Pending state because a human `/quit`/`/exit`
//!   Enter from an idle pane is indistinguishable from a prompt submit
//!   (ringing there would bell the canonical human quit).
//!
//! Zero-polling: pure deadlines + `next_deadline()`; the hub arms a single
//! one-shot timer. No pending windows ⇒ no timers.
//!
//! # Accepted Residuals
//!
//! The following edge cases are accepted design trade-offs (not deferrals):
//! 1. (CLOSED for freshell-owned input by #612, 2026-08-06) Mid-turn
//!    `/quit`/Ctrl+D: codex sends NO `Op::Interrupt` on Ctrl+D, and the
//!    TUI's ~2s shutdown budget can exit before the abort evidence lands —
//!    could ring on a human force-quit of a visibly-working pane. User-typed
//!    quits through freshell's own input stream — /quit, /exit, Ctrl+D,
//!    Ctrl+C — now suppress the death bell via a 15s quit-intent marker
//!    (signal::classify_input; exact rules there, including bracketed-paste
//!    unwrapping — a PASTED /quit evaluated by a real Enter is detected —
//!    and the DECRQM exact-grammar skip for freshell's own synthetic
//!    replies). Remaining residual, adjudicated: /quit typed as literal
//!    prompt text followed by a crash within 15s is the one accepted
//!    false-suppress.
//! 2. Out-of-band `kill -9`/SIGTERM of the CLI by the user: observationally
//!    identical to a crash — rings; accepted. (#612, 2026-08-06)
//!    Adjudicated: out-of-band kill -9 RINGS (intended — a working agent
//!    killed externally is worth announcing).
//! 3. (CLOSED for freshell-owned input by #612, 2026-08-06) Claude/amplifier
//!    Enter-executed quits (`/exit`): input-driven Busy is those trackers'
//!    ONLY turn evidence, so it stays death-bell engagement — but the same
//!    15s quit-intent marker as entry 1 (signal::classify_input) now
//!    suppresses the bell when the quit line arrived through freshell's own
//!    input stream; same residual family as (1); accepted.
//! 4. Node 120s busy-deadman swallow (audit A17): a recovery window longer
//!    than `BUSY_DEADMAN_MS` demotes busy→unknown and `unknown` never arms the
//!    death bell — a MISSED bell (never a false ring); accepted.
//! 5. A SENT approval request auto-resolved server-side slower than ~2s rings
//!    once (decision 5); accepted.
//!  6. (CLOSED for lane-backed panes by #609, 2026-08-06) A busy root on
//!     the pane's own per-pane lane binds identity directly (KnownBusy) —
//!     first-turn deaths ring and the indefinite-candidate tail cannot
//!     form. Identity-by-construction holds because opencode v1.18.14
//!     creates sessions only client-initiated and internal features
//!     never mint ROOT sessions (title/summary run in-place; subagents
//!     are CHILDREN carrying parentID — child filtering in root
//!     resolution stays load-bearing). D4 unchanged:
//!     Candidate/Ambiguous/AwaitingAssociation still never death-ring.
//!     Residuals (adjudicated): externally-attached panes on a SHARED
//!     opencode endpoint have no lane and keep conservative silence;
//!     and `opencode run --attach http://127.0.0.1:<port>` against a
//!     pane's port can DELIBERATELY mint foreign busy roots — named,
//!     accepted (it requires local intent, and two busy roots still
//!     demote to Ambiguous, which stays honest-blue and death-silent).
//!  7. (ADJUDICATED by owner ruling 2026-08-05, #607) Unmanaged/PTY-only
//!     codex panes make NO approval-notification promise: when codex
//!     pauses for approval, such panes keep an honest busy light until
//!     the turn resumes or ends. The approval-pause guarantee (demote +
//!     attention boundary + death-bell engagement) is scoped to MANAGED
//!     proxy-lane panes (note_approval_requested/resolved). PTY
//!     text-parsing heuristics were considered and REJECTED (owner
//!     policy: no heuristics). Freshell-launched codex panes use the
//!     managed lane, so the unmanaged population is externally-attached
//!     panes only.
//!  8. (CLOSED by #608, 2026-08-06) SSE reconnect resyncs outstanding
//!     asks via GET /permission AND GET /question (disjoint pending
//!     stores at v1.18.14; both replayed BEFORE the snapshot), busy
//!     snapshots no longer clear an outstanding pause, and the fetched
//!     sets reconcile stale local pauses (instance-dispose drains with
//!     NO events — a locally-pending id absent from the listing is
//!     treated as replied, so pauses cannot wedge). The
//!     pending-attention bell survives connection blips.
//!     Ambiguous ownership stays bell-free. Child sessions
//!     unseen on-stream (reconnect gap, mid-turn attach) are recovered by the
//!     lane's HTTP root resolver (GET /session/{id} exposes parentID); only
//!     resolver FAILURE degrades to ambiguous (conservative silence), retried
//!     on the next occurrence.
//! 9. (RE-SCOPED by #604, 2026-08-06) permission.* and question.*
//!    families (v1 AND v2) are translated onto the same pause
//!    machinery, source-verified against opencode v1.18.14: TUI-driven
//!    turns emit the V1 names; v2 names fire only via /api/* routes
//!    (kept as forward-compat). Permission rejection has NO event type
//!    of its own — it arrives as *.replied with reply:"reject", which
//!    the replied translation drains. Residual: a FUTURE
//!    never-before-seen event family cannot be handled in advance —
//!    mitigated by the snapshot poll (turn lights stay correct
//!    regardless of stream vocabulary, #603) and the loud drift
//!    detector (#604); bells for a brand-new family stay deaf until
//!    vocabulary is updated (adjudicated: acceptable).
//! 10. Opencode abort window W1: an abort landing between the prompt loop-top
//!     and processor.create emits NO abort evidence at all before idle — a
//!     ms-scale window where a completion bell can ring on a human abort
//!     (window W2 is closed by the abort-marked message.updated fallback).
//! 11. Pathological opencode TUI quits — worker dispose exceeding the 5s
//!     hard-terminate cap, or a raw SIGTERM (no drain path) — can leave
//!     engagement set at spontaneous exit, so a death bell can ring on those
//!     rare human quits. Normal quit paths verified to abort+drain (all four
//!     quit inputs dispose runners via the abort path before exit); the
//!     wire-flush instant is unprovable from code but mitigated upstream by
//!     graceful SSE stream termination. (#612, 2026-08-06) The 15s
//!     quit-intent marker (signal::classify_input) now suppresses the death
//!     bell for quits observed on freshell's own input stream — the TTL
//!     covers slow TUI shutdowns including opencode's 5s dispose cap.
//!     Remaining residuals, adjudicated: TUI-menu quits driven by escape
//!     sequences produce no detectable byte sequence and stay
//!     agent-evidence-dependent; a paste that embeds its own newline after
//!     the quit line ("/exit\r…" INSIDE one paste) is treated as a
//!     multi-line blob, not a submit; a raw SIGTERM is out-of-band input
//!     and RINGS (entry 2's adjudication).
//! 12. (CLOSED by #603, 2026-08-06) The opencode busy deadman no longer
//!     drops the record on event silence: it verifies via GET
//!     /session/status through the lane and stays busy; a failed probe
//!     clears busy AND rings the attention boundary (owner ruling:
//!     verify-probe failure = crash/needs-attention).
//! 13. (NAMED by #606, 2026-08-06) An EARLY-ESC interrupt — ESC before
//!     any assistant output — writes NO transcript record at all
//!     (corpus-verified), so the JSONL truth source cannot distinguish
//!     it from a long silent tool call: the pane keeps an honest-stale
//!     blue until the user's next input, at which point the submit
//!     probe / deadman verify self-heals it. Accepted: no deterministic
//!     discriminator exists, and a stale blue that self-heals is the
//!     conservative direction (never a false green).

use std::collections::{HashMap, HashSet};

use freshell_protocol::TerminalIdleReason;

pub const IDLE_GRACE_MS: i64 = 2_000;

/// A due `terminal.idle` emission.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdleEmission {
    pub terminal_id: String,
    pub at: i64,
    pub reason: TerminalIdleReason,
}

/// Tracker phase kinds the gate distinguishes (legacy `isBusyPhase` plus the
/// codex `pending` special case that carries queue evidence).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdleGatePhase {
    Busy,
    Pending,
    Idle,
}

#[derive(Debug, Default)]
struct TerminalIdleState {
    /// Tracker reports busy-or-pending (legacy `isBusyPhase`).
    busy: bool,
    /// Tracker phase is specifically `pending` (codex submit gate).
    pending: bool,
    /// Queue evidence observed since the last emission (queued turn /
    /// re-armed submit). Selects the `queue-empty` reason.
    saw_queue_evidence: bool,
    /// Armed grace deadline, if any.
    deadline: Option<i64>,
}

#[derive(Debug)]
pub struct IdleGate {
    states: HashMap<String, TerminalIdleState>,
    /// Terminals whose stop was requested (Stage 2: LB-37): from the request
    /// until their exit they keep no gate state, so nothing arms, nothing is
    /// emitted and the death bell never rings for them.
    stopping: HashSet<String>,
    grace_ms: i64,
}

impl Default for IdleGate {
    /// Production constructs the gate via `HubInner: Default` — the default
    /// MUST carry the real grace window, not a zeroed one.
    fn default() -> Self {
        Self::new()
    }
}

impl IdleGate {
    pub fn new() -> Self {
        Self::with_grace_ms(IDLE_GRACE_MS)
    }

    pub fn with_grace_ms(grace_ms: i64) -> Self {
        Self {
            states: HashMap::new(),
            stopping: HashSet::new(),
            grace_ms,
        }
    }

    /// A tracker `Changed` upsert: record the phase edge. Busy/pending cancels
    /// any pending window; an idle report is INERT (no cancel, no arm —
    /// deadman/signal-loss idle flips never arm).
    pub fn note_phase(&mut self, terminal_id: &str, phase: IdleGatePhase) {
        if self.stopping.contains(terminal_id) {
            return;
        }
        let state = self.states.entry(terminal_id.to_string()).or_default();
        let next_busy = matches!(phase, IdleGatePhase::Busy | IdleGatePhase::Pending);
        if next_busy {
            // Codex busy->pending re-arm: a queued submit was consumed at the
            // turn clear — queue evidence (legacy truly-idle-emitter.ts:94-95).
            if state.busy && !state.pending && phase == IdleGatePhase::Pending {
                state.saw_queue_evidence = true;
            }
            state.deadline = None;
        }
        state.busy = next_busy;
        state.pending = phase == IdleGatePhase::Pending;
    }

    /// A positive turn boundary. While the tracker still reports busy this is
    /// a QUEUED turn (claude keeps phase Busy until in_flight drains): never
    /// arm mid-turn. Otherwise arm (or re-arm) the grace window.
    pub fn note_turn_boundary(&mut self, terminal_id: &str, at: i64) {
        if self.stopping.contains(terminal_id) {
            return;
        }
        let state = self.states.entry(terminal_id.to_string()).or_default();
        if state.busy {
            // Queued turn (claude in_flight ledger keeps phase busy until the
            // queue drains): record queue evidence, never arm
            // (legacy truly-idle-emitter.ts:114-118).
            state.saw_queue_evidence = true;
            return;
        }
        state.deadline = Some(at + self.grace_ms);
    }

    /// Provisional busy (submit-shaped PTY input / amplifier TurnBegan):
    /// cancel any pending emission — it was never truly idle. Does NOT set
    /// the busy flag: only confirmed tracker phase edges do that.
    pub fn note_busy(&mut self, terminal_id: &str) {
        if let Some(state) = self.states.get_mut(terminal_id) {
            state.deadline = None;
        }
    }

    /// New session-file activity while the window is pending (amplifier:
    /// events.jsonl appends): extend the window.
    pub fn note_activity(&mut self, terminal_id: &str, at: i64) {
        if let Some(state) = self.states.get_mut(terminal_id) {
            if let Some(deadline) = state.deadline.as_mut() {
                *deadline = (*deadline).max(at + self.grace_ms);
            }
        }
    }

    /// Terminal exited: drop ALL gate state for it (legacy remove semantics —
    /// never emit for a dead terminal), including its stop request.
    pub fn note_exit(&mut self, terminal_id: &str) {
        self.states.remove(terminal_id);
        self.stopping.remove(terminal_id);
    }

    /// A tracker removed the terminal's record (it is still running): drop
    /// its gate state. A stop request stays in force until the exit.
    pub fn note_removed(&mut self, terminal_id: &str) {
        self.states.remove(terminal_id);
    }

    /// The terminal's stop was requested (Stage 2: LB-37): its gate state
    /// (and any armed grace window) is dropped, and until its exit nothing
    /// arms for it and it is never engaged, so a requested stop produces no
    /// `terminal.idle` and no death bell. A crash never comes through here.
    pub fn note_stopping(&mut self, terminal_id: &str) {
        self.states.remove(terminal_id);
        self.stopping.insert(terminal_id.to_string());
    }

    /// Whether the terminal's stop was requested and it has not exited yet.
    pub fn is_stopping(&self, terminal_id: &str) -> bool {
        self.stopping.contains(terminal_id)
    }

    /// Engagement for the DEATH BELL (decision 3): true only for a CONFIRMED
    /// busy phase or an armed grace window. The codex input-only Pending
    /// submit gate is excluded — the Enter that executes a human /quit//exit
    /// is indistinguishable from a prompt submit in the input lane
    /// (signal.rs:36-38), so ringing on pending would bell the canonical
    /// human quit. Read by the hub's exit arm BEFORE `note_exit` drops the
    /// state: a spontaneous process death while engaged rings the bell.
    pub fn is_engaged(&self, terminal_id: &str) -> bool {
        if self.stopping.contains(terminal_id) {
            return false;
        }
        self.states
            .get(terminal_id)
            .map(|s| (s.busy && !s.pending) || s.deadline.is_some())
            .unwrap_or(false)
    }

    /// Emit every window whose deadline has lapsed (once each). A terminal
    /// that re-entered busy never emits (defensive second gate).
    pub fn expire(&mut self, at: i64) -> Vec<IdleEmission> {
        let mut emissions = Vec::new();
        for (terminal_id, state) in self.states.iter_mut() {
            let Some(deadline) = state.deadline else {
                continue;
            };
            if at < deadline {
                continue;
            }
            state.deadline = None;
            if state.busy {
                continue;
            }
            let reason = if state.saw_queue_evidence {
                TerminalIdleReason::QueueEmpty
            } else {
                TerminalIdleReason::Grace
            };
            state.saw_queue_evidence = false;
            emissions.push(IdleEmission {
                terminal_id: terminal_id.clone(),
                at,
                reason,
            });
        }
        emissions
    }

    /// Earliest pending deadline — `None` when no window is armed.
    pub fn next_deadline(&self) -> Option<i64> {
        self.states.values().filter_map(|s| s.deadline).min()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boundary_then_quiet_grace_emits_exactly_once() {
        let mut gate = IdleGate::new();
        gate.note_turn_boundary("t1", 100);
        assert!(gate.expire(100 + IDLE_GRACE_MS - 1).is_empty());
        let emissions = gate.expire(100 + IDLE_GRACE_MS);
        assert_eq!(
            emissions,
            vec![IdleEmission {
                terminal_id: "t1".into(),
                at: 100 + IDLE_GRACE_MS,
                reason: TerminalIdleReason::Grace
            }]
        );
        // Once per transition: nothing further without a new boundary.
        assert!(gate.expire(100 + 10 * IDLE_GRACE_MS).is_empty());
    }

    #[test]
    fn busy_reentry_cancels_the_pending_emission() {
        let mut gate = IdleGate::new();
        gate.note_turn_boundary("t1", 100);
        // A queued prompt started the next turn within the grace window.
        gate.note_busy("t1");
        assert!(gate.expire(100 + IDLE_GRACE_MS).is_empty());
        assert_eq!(gate.next_deadline(), None);
    }

    #[test]
    fn session_file_activity_extends_the_window() {
        let mut gate = IdleGate::new();
        gate.note_turn_boundary("t1", 100);
        // Post-complete background events (e.g. amplifier title generation)
        // keep pushing the deadline out.
        gate.note_activity("t1", 1_000);
        assert!(gate.expire(100 + IDLE_GRACE_MS).is_empty());
        let emissions = gate.expire(1_000 + IDLE_GRACE_MS);
        assert_eq!(emissions.len(), 1);
    }

    #[test]
    fn activity_without_a_pending_window_arms_nothing() {
        let mut gate = IdleGate::new();
        gate.note_activity("t1", 100);
        assert_eq!(gate.next_deadline(), None);
        assert!(gate.expire(100 + IDLE_GRACE_MS).is_empty());
    }

    #[test]
    fn exit_cancels() {
        let mut gate = IdleGate::new();
        gate.note_turn_boundary("t1", 100);
        gate.note_exit("t1");
        assert!(gate.expire(100 + IDLE_GRACE_MS).is_empty());
    }

    #[test]
    fn next_deadline_reflects_the_earliest_window() {
        let mut gate = IdleGate::new();
        assert_eq!(gate.next_deadline(), None);
        gate.note_turn_boundary("t1", 100);
        gate.note_turn_boundary("t2", 50);
        assert_eq!(gate.next_deadline(), Some(50 + IDLE_GRACE_MS));
        let emissions = gate.expire(50 + IDLE_GRACE_MS);
        assert_eq!(emissions.len(), 1);
        assert_eq!(gate.next_deadline(), Some(100 + IDLE_GRACE_MS));
    }

    #[test]
    fn turn_boundary_while_busy_never_arms() {
        let mut gate = IdleGate::new();
        gate.note_phase("t1", IdleGatePhase::Busy);
        // claude in_flight >= 2: BEL #1's boundary lands while the tracker
        // still reports Busy (busy->busy emits no Changed frame, so the gate's
        // busy flag persists from the FIRST busy upsert).
        gate.note_turn_boundary("t1", 100);
        assert_eq!(gate.next_deadline(), None);
        assert!(gate.expire(100 + 10 * IDLE_GRACE_MS).is_empty());
    }

    #[test]
    fn boundary_after_the_idle_flip_arms_normally() {
        let mut gate = IdleGate::new();
        gate.note_phase("t1", IdleGatePhase::Busy);
        // The final BEL: Changed(Idle) is processed BEFORE TurnComplete in the
        // same effect vector, so the gate sees not-busy at the boundary.
        gate.note_phase("t1", IdleGatePhase::Idle);
        gate.note_turn_boundary("t1", 100);
        assert_eq!(gate.next_deadline(), Some(100 + IDLE_GRACE_MS));
        assert_eq!(gate.expire(100 + IDLE_GRACE_MS).len(), 1);
    }

    #[test]
    fn idle_phase_report_is_inert() {
        // Deadman/signal-loss idle flips arrive WITHOUT a turn boundary and
        // never arm; they also never cancel an armed window (legacy parity).
        let mut gate = IdleGate::new();
        gate.note_phase("t1", IdleGatePhase::Idle);
        assert_eq!(gate.next_deadline(), None);
        gate.note_turn_boundary("t1", 100);
        gate.note_phase("t1", IdleGatePhase::Idle); // e.g. duplicate idle upsert
        assert_eq!(gate.next_deadline(), Some(100 + IDLE_GRACE_MS));
    }

    #[test]
    fn busy_phase_report_cancels_a_pending_window() {
        let mut gate = IdleGate::new();
        gate.note_turn_boundary("t1", 100);
        gate.note_phase("t1", IdleGatePhase::Busy);
        assert_eq!(gate.next_deadline(), None);
        assert!(gate.expire(100 + IDLE_GRACE_MS).is_empty());
    }

    #[test]
    fn pending_phase_counts_as_busy_for_the_boundary_gate() {
        let mut gate = IdleGate::new();
        gate.note_phase("t1", IdleGatePhase::Pending);
        gate.note_turn_boundary("t1", 100);
        assert_eq!(gate.next_deadline(), None);
    }

    #[test]
    fn a_second_boundary_rearms_the_full_window() {
        let mut gate = IdleGate::new();
        gate.note_turn_boundary("t1", 100);
        gate.note_turn_boundary("t1", 1_000);
        assert_eq!(gate.next_deadline(), Some(1_000 + IDLE_GRACE_MS));
        assert!(gate.expire(100 + IDLE_GRACE_MS).is_empty());
    }

    #[test]
    fn expire_never_emits_while_busy_even_with_a_stale_deadline() {
        // Defensive second gate (legacy handleGraceExpiry's busy guard): if a
        // deadline somehow survives into a busy phase, drop it silently.
        let mut gate = IdleGate::new();
        gate.note_turn_boundary("t1", 100);
        gate.note_phase("t1", IdleGatePhase::Pending); // cancels
        gate.note_turn_boundary("t1", 200); // busy -> refuses to arm
        assert!(gate.expire(200 + 10 * IDLE_GRACE_MS).is_empty());
    }

    #[test]
    fn boundary_while_busy_then_drain_emits_queue_empty() {
        let mut gate = IdleGate::new();
        gate.note_phase("t1", IdleGatePhase::Busy);
        gate.note_turn_boundary("t1", 100); // queued turn: evidence, no arm
        gate.note_phase("t1", IdleGatePhase::Idle); // queue drained
        gate.note_turn_boundary("t1", 200); // arms
        let emissions = gate.expire(200 + IDLE_GRACE_MS);
        assert_eq!(
            emissions,
            vec![IdleEmission {
                terminal_id: "t1".into(),
                at: 200 + IDLE_GRACE_MS,
                reason: TerminalIdleReason::QueueEmpty
            }]
        );
    }

    #[test]
    fn evidence_resets_after_an_emission() {
        let mut gate = IdleGate::new();
        gate.note_phase("t1", IdleGatePhase::Busy);
        gate.note_turn_boundary("t1", 100); // evidence
        gate.note_phase("t1", IdleGatePhase::Idle);
        gate.note_turn_boundary("t1", 200);
        let first = gate.expire(200 + IDLE_GRACE_MS);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].reason, TerminalIdleReason::QueueEmpty);
        // Next cycle without new evidence: plain grace.
        gate.note_phase("t1", IdleGatePhase::Busy);
        gate.note_phase("t1", IdleGatePhase::Idle);
        gate.note_turn_boundary("t1", 10_000);
        let emissions = gate.expire(10_000 + IDLE_GRACE_MS);
        assert_eq!(emissions[0].reason, TerminalIdleReason::Grace);
    }

    #[test]
    fn codex_busy_to_pending_rearm_counts_as_queue_evidence() {
        // Legacy truly-idle-emitter.ts:90-98 — a busy->pending transition is
        // the codex queued-submit-consumed-at-turn-clear signal.
        let mut gate = IdleGate::new();
        gate.note_phase("t1", IdleGatePhase::Busy);
        gate.note_phase("t1", IdleGatePhase::Pending); // re-arm: evidence
        gate.note_phase("t1", IdleGatePhase::Idle);
        gate.note_turn_boundary("t1", 100);
        let emissions = gate.expire(100 + IDLE_GRACE_MS);
        assert_eq!(emissions[0].reason, TerminalIdleReason::QueueEmpty);
    }

    #[test]
    fn pending_to_pending_is_not_queue_evidence() {
        // Only the busy&&!pending -> pending edge counts (legacy :94).
        let mut gate = IdleGate::new();
        gate.note_phase("t1", IdleGatePhase::Pending);
        gate.note_phase("t1", IdleGatePhase::Pending);
        gate.note_phase("t1", IdleGatePhase::Idle);
        gate.note_turn_boundary("t1", 100);
        assert_eq!(
            gate.expire(100 + IDLE_GRACE_MS)[0].reason,
            TerminalIdleReason::Grace
        );
    }

    #[test]
    fn exit_discards_queue_evidence_with_the_rest_of_the_state() {
        let mut gate = IdleGate::new();
        gate.note_phase("t1", IdleGatePhase::Busy);
        gate.note_turn_boundary("t1", 100); // evidence
        gate.note_exit("t1"); // legacy remove: whole state deleted
        gate.note_turn_boundary("t1", 200); // fresh terminal id reuse
        assert_eq!(
            gate.expire(200 + IDLE_GRACE_MS)[0].reason,
            TerminalIdleReason::Grace
        );
    }

    #[test]
    fn is_engaged_reflects_confirmed_busy_and_armed_deadlines_but_never_input_pending() {
        let mut gate = IdleGate::with_grace_ms(2_000);
        assert!(!gate.is_engaged("t1"), "unknown terminal is not engaged");
        gate.note_phase("t1", IdleGatePhase::Pending);
        assert!(
            !gate.is_engaged("t1"),
            "input-only pending is NOT death-bell engagement: the Enter that \
             executes /quit looks like a prompt submit (signal.rs:36-38) and \
             must not ring when the pty then exits (decision 3, audit A6)"
        );
        gate.note_phase("t1", IdleGatePhase::Busy);
        assert!(gate.is_engaged("t1"), "confirmed busy is engaged");
        gate.note_phase("t1", IdleGatePhase::Idle);
        assert!(
            !gate.is_engaged("t1"),
            "idle with no pending window is not engaged"
        );
        gate.note_turn_boundary("t1", 10_000); // arms deadline
        assert!(
            gate.is_engaged("t1"),
            "an armed grace window is engaged (a pending bell must survive death)"
        );
        gate.expire(20_000);
        assert!(!gate.is_engaged("t1"), "after emission nothing is engaged");
    }

    #[test]
    fn default_gate_uses_the_production_grace_window() {
        // HubInner is #[derive(Default)] (freshell-ws activity.rs), so
        // PRODUCTION constructs IdleGate::default(). A derived Default left
        // grace_ms == 0 — terminal.idle fired instantly at the boundary.
        let mut gate = IdleGate::default();
        gate.note_turn_boundary("t1", 100);
        assert!(
            gate.expire(100 + IDLE_GRACE_MS - 1).is_empty(),
            "the default gate must honor the full grace window"
        );
        assert_eq!(gate.expire(100 + IDLE_GRACE_MS).len(), 1);
    }

    #[test]
    fn a_stop_request_drops_the_window_and_nothing_arms_until_the_exit() {
        let mut gate = IdleGate::new();
        gate.note_turn_boundary("t1", 100);
        gate.note_stopping("t1");
        assert!(gate.is_stopping("t1"));
        assert_eq!(gate.next_deadline(), None, "the armed window is dropped");
        assert!(gate.expire(100 + 10 * IDLE_GRACE_MS).is_empty());

        gate.note_phase("t1", IdleGatePhase::Busy);
        assert!(
            !gate.is_engaged("t1"),
            "a stopping terminal is never engaged"
        );
        gate.note_phase("t1", IdleGatePhase::Idle);
        gate.note_turn_boundary("t1", 200);
        assert_eq!(
            gate.next_deadline(),
            None,
            "no boundary arms while stopping"
        );

        gate.note_removed("t1");
        gate.note_turn_boundary("t1", 300);
        assert_eq!(
            gate.next_deadline(),
            None,
            "a tracker removal does not lift the stop request"
        );

        gate.note_exit("t1");
        assert!(!gate.is_stopping("t1"), "the exit clears the stop request");
        gate.note_turn_boundary("t1", 400);
        assert_eq!(
            gate.next_deadline(),
            Some(400 + IDLE_GRACE_MS),
            "a terminal id reused after the exit behaves as before"
        );
    }
}

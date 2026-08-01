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
//! 1. Mid-turn `/quit`/Ctrl+D: codex sends NO `Op::Interrupt` on Ctrl+D, and
//!    the TUI's ~2s shutdown budget can exit before the abort evidence lands
//!    — may ring on a human force-quit of a visibly-working pane. No in-band
//!    discriminator exists; accepted.
//! 2. Out-of-band `kill -9`/SIGTERM of the CLI by the user: observationally
//!    identical to a crash — rings; accepted.
//! 3. Claude/amplifier Enter-executed quits (`/exit`): input-driven Busy is
//!    those trackers' ONLY turn evidence, so it stays death-bell engagement;
//!    same residual family as (1); accepted.
//! 4. Node 120s busy-deadman swallow (audit A17): a recovery window longer
//!    than `BUSY_DEADMAN_MS` demotes busy→unknown and `unknown` never arms the
//!    death bell — a MISSED bell (never a false ring); accepted.
//! 5. A SENT approval request auto-resolved server-side slower than ~2s rings
//!    once (decision 5); accepted.
//! 6. Node opencode death bells: deliberately excluded (noisy busy proxy) —
//!    follow-up. Rust opencode: no hub tracker exists — N/A.
//! 7. Unmanaged/PTY-only codex has no approval signal — documented limitation.

use std::collections::HashMap;

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
            grace_ms,
        }
    }

    /// A tracker `Changed` upsert: record the phase edge. Busy/pending cancels
    /// any pending window; an idle report is INERT (no cancel, no arm —
    /// deadman/signal-loss idle flips never arm).
    pub fn note_phase(&mut self, terminal_id: &str, phase: IdleGatePhase) {
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

    /// Terminal exited or was removed from a tracker: drop ALL gate state for
    /// it (legacy remove semantics — never emit for a dead terminal).
    pub fn note_exit(&mut self, terminal_id: &str) {
        self.states.remove(terminal_id);
    }

    /// Engagement for the DEATH BELL (decision 3): true only for a CONFIRMED
    /// busy phase or an armed grace window. The codex input-only Pending
    /// submit gate is excluded — the Enter that executes a human /quit//exit
    /// is indistinguishable from a prompt submit in the input lane
    /// (signal.rs:36-38), so ringing on pending would bell the canonical
    /// human quit. Read by the hub's exit arm BEFORE `note_exit` drops the
    /// state: a spontaneous process death while engaged rings the bell.
    pub fn is_engaged(&self, terminal_id: &str) -> bool {
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
}

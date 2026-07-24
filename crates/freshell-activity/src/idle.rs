//! The NEW truly-idle gate (`terminal.idle`) — no legacy counterpart.
//!
//! Pinned wire contract: `{ terminalId, at (server epoch ms), reason:
//! 'grace' | 'queue-empty' }`, emitted ONCE per busy→truly-idle transition.
//!
//! Semantics:
//! * a turn boundary (the provider's positive turn end) ARMS a grace window
//!   (default [`IDLE_GRACE_MS`] = 2000ms);
//! * new activity within the window EXTENDS it (amplifier: any events.jsonl
//!   append — post-complete background naming events mean "not truly idle
//!   yet"; claude/codex: a queued prompt auto-starting the next turn re-buses
//!   the terminal, which CANCELS the pending emission entirely);
//! * a busy re-entry cancels; the next boundary re-arms;
//! * the window lapsing emits exactly one `terminal.idle` with reason
//!   `grace` (per-CLI queued-prompt detection: where a CLI's queued-prompt
//!   state is undetectable, grace-window-only is the accepted fallback —
//!   every current lane uses `grace`);
//! * subagent/tool completions inside a running turn never reach this gate
//!   (the trackers only report REAL turn boundaries).
//!
//! Zero-polling: pure deadlines + `next_deadline()`; the hub arms a single
//! one-shot timer. No pending windows ⇒ no timers.

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

#[derive(Debug, Default)]
pub struct IdleGate {
    /// terminal id → grace deadline (armed at a turn boundary).
    pending: HashMap<String, i64>,
    grace_ms: i64,
}

impl IdleGate {
    pub fn new() -> Self {
        Self::with_grace_ms(IDLE_GRACE_MS)
    }

    pub fn with_grace_ms(grace_ms: i64) -> Self {
        Self {
            pending: HashMap::new(),
            grace_ms,
        }
    }

    /// A positive turn boundary: arm (or re-arm) the grace window.
    pub fn note_turn_boundary(&mut self, terminal_id: &str, at: i64) {
        self.pending
            .insert(terminal_id.to_string(), at + self.grace_ms);
    }

    /// The terminal re-entered busy (a queued prompt started the next turn):
    /// cancel any pending emission — it was never truly idle.
    pub fn note_busy(&mut self, terminal_id: &str) {
        self.pending.remove(terminal_id);
    }

    /// New session-file activity while the window is pending (amplifier:
    /// events.jsonl appends): extend the window — file writes mean the
    /// session is still doing something.
    pub fn note_activity(&mut self, terminal_id: &str, at: i64) {
        if let Some(deadline) = self.pending.get_mut(terminal_id) {
            *deadline = (*deadline).max(at + self.grace_ms);
        }
    }

    /// Terminal exited: never emit for a dead terminal.
    pub fn note_exit(&mut self, terminal_id: &str) {
        self.pending.remove(terminal_id);
    }

    /// Emit every window whose deadline has lapsed (once each).
    pub fn expire(&mut self, at: i64) -> Vec<IdleEmission> {
        let due: Vec<String> = self
            .pending
            .iter()
            .filter(|(_, &deadline)| at >= deadline)
            .map(|(id, _)| id.clone())
            .collect();
        let mut emissions = Vec::with_capacity(due.len());
        for terminal_id in due {
            self.pending.remove(&terminal_id);
            emissions.push(IdleEmission {
                terminal_id,
                at,
                reason: TerminalIdleReason::Grace,
            });
        }
        emissions
    }

    /// Earliest pending deadline — `None` when no window is armed.
    pub fn next_deadline(&self) -> Option<i64> {
        self.pending.values().copied().min()
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
}

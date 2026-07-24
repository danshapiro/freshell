//! Port of `server/coding-cli/turn-completion-ledger.ts` (frozen parity
//! reference).
//!
//! Provider-scoped turn-completion ledger, keyed by terminalId. Each tracker
//! owns one instance, so `completionSeq` stays scoped per provider per
//! terminal. Deliberately NO per-terminal cleanup on terminal removal (the
//! reference never clears these maps on noteExit/untrackTerminal): the
//! sequence stays monotonic if the same terminalId completes again after a
//! re-track, and the latest snapshot outlives the activity record so
//! late-attaching clients still receive it. This is exactly what makes
//! completions dedupe-able across a client reconnect: the client keys on
//! `(terminalId, completionSeq)`.

use std::collections::HashMap;

use freshell_protocol::TurnCompletionSnapshot;

#[derive(Debug, Default)]
pub struct TurnCompletionLedger {
    completion_seq_by_terminal_id: HashMap<String, i64>,
    /// Latest snapshot per terminal, kept in FIRST-completion order (the
    /// reference relies on JS `Map` insertion order).
    latest_order: Vec<String>,
    latest_by_terminal_id: HashMap<String, TurnCompletionSnapshot>,
}

impl TurnCompletionLedger {
    pub fn new() -> Self {
        Self::default()
    }

    /// Assign the next monotonic completionSeq for the terminal, remember the
    /// latest snapshot, and return the assigned seq.
    pub fn record_turn_completion(&mut self, terminal_id: &str, at: i64) -> i64 {
        let seq = self
            .completion_seq_by_terminal_id
            .get(terminal_id)
            .copied()
            .unwrap_or(0)
            + 1;
        self.completion_seq_by_terminal_id
            .insert(terminal_id.to_string(), seq);
        if !self.latest_by_terminal_id.contains_key(terminal_id) {
            self.latest_order.push(terminal_id.to_string());
        }
        self.latest_by_terminal_id.insert(
            terminal_id.to_string(),
            TurnCompletionSnapshot {
                terminal_id: terminal_id.to_string(),
                at,
                completion_seq: seq,
            },
        );
        seq
    }

    /// Latest completion snapshot per terminal, in first-completion order.
    pub fn list_latest_completions(&self) -> Vec<TurnCompletionSnapshot> {
        self.latest_order
            .iter()
            .filter_map(|id| self.latest_by_terminal_id.get(id).cloned())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seq_is_monotonic_per_terminal_and_survives_retrack() {
        let mut ledger = TurnCompletionLedger::new();
        assert_eq!(ledger.record_turn_completion("t1", 100), 1);
        assert_eq!(ledger.record_turn_completion("t1", 200), 2);
        // Another terminal has its own sequence.
        assert_eq!(ledger.record_turn_completion("t2", 150), 1);
        // "Re-track" changes nothing — no cleanup API exists, by design.
        assert_eq!(ledger.record_turn_completion("t1", 300), 3);
    }

    #[test]
    fn latest_completions_keep_first_completion_order_with_latest_values() {
        let mut ledger = TurnCompletionLedger::new();
        ledger.record_turn_completion("t1", 100);
        ledger.record_turn_completion("t2", 150);
        ledger.record_turn_completion("t1", 200);

        let latest = ledger.list_latest_completions();
        assert_eq!(latest.len(), 2);
        // t1 first (first to ever complete), but with its LATEST snapshot.
        assert_eq!(latest[0].terminal_id, "t1");
        assert_eq!(latest[0].at, 200);
        assert_eq!(latest[0].completion_seq, 2);
        assert_eq!(latest[1].terminal_id, "t2");
        assert_eq!(latest[1].completion_seq, 1);
    }
}

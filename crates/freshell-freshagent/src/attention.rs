//! The per-session attention clock and edge builders every fresh-agent lane
//! shares (design 2026-10-22 §3.2, §5.5; moved out of `codex.rs`).
//!
//! Every `freshAgent.turn.complete` / `freshAgent.turn.waiting` edge carries an
//! `at` that is strictly monotonic per session: the client folds edges under an
//! `at`-monotonic dedupe, so two edges in one millisecond, or an edge minted
//! after a backward wall-clock step, must still land strictly above the last
//! one. One [`AttentionClock`] per session gives every minting source (an
//! ordinary completion, a crash, a deadman fire) that single timeline, so the
//! sources can never collide or regress against each other. The clock lives in
//! memory only: it starts fresh after a server restart, the wall-clock regime
//! the AGENTS.md alert contract already accepts.

use std::sync::{Arc, Mutex as StdMutex};

use freshell_codex::next_monotonic_turn_complete_at;
use serde_json::{json, Value};

// `Date.now()`: epoch milliseconds, the clock's wall-clock input.
use crate::rollback_record::now_ms;

/// One session's strictly-monotonic attention clock (`Default` is a clock that
/// has minted nothing). Cheap to clone; every clone is the SAME timeline, so
/// the clock carries across a re-key or a death and resume by handing the
/// clone to the next record.
#[derive(Clone, Debug, Default)]
pub(crate) struct AttentionClock {
    /// The last `at` minted or observed (the floor every later mint clears).
    /// Shared as a bare cell because codex's subscription (the
    /// `freshell-codex` crate, which cannot name this type) mints its
    /// ordinary completions on the same cell.
    last: Arc<StdMutex<Option<i64>>>,
}

impl AttentionClock {
    /// Mint the next `at`: the wall clock, raised to one above the floor
    /// when the wall clock has not passed it.
    pub(crate) fn mint(&self) -> i64 {
        self.mint_with(now_ms())
    }

    fn mint_with(&self, now: i64) -> i64 {
        let mut last = self.last.lock().expect("attention clock lock");
        let at = next_monotonic_turn_complete_at(*last, now);
        *last = Some(at);
        at
    }

    /// Raise the floor to an `at` minted elsewhere for this session, so the
    /// next mint lands strictly above it. Never lowers the floor.
    #[allow(dead_code)] // consumed by the claude edge hub (design §5.5, C18)
    pub(crate) fn observe(&self, at: i64) {
        let mut last = self.last.lock().expect("attention clock lock");
        if last.is_none_or(|floor| at > floor) {
            *last = Some(at);
        }
    }

    /// The last `at` minted or observed; `None` for a fresh clock.
    #[allow(dead_code)] // consumed by the claude edge hub (design §5.5, C18)
    pub(crate) fn floor(&self) -> Option<i64> {
        *self.last.lock().expect("attention clock lock")
    }
}

/// Adopt an existing clock cell, sharing its timeline both ways. Codex keeps
/// each session's clock as the bare cell its `CodexSubscription` mints on.
impl From<Arc<StdMutex<Option<i64>>>> for AttentionClock {
    fn from(last: Arc<StdMutex<Option<i64>>>) -> Self {
        Self { last }
    }
}

/// The client's `freshAgent.turn.complete` edge (the inner event every lane
/// wraps in its `freshAgent.event` envelope).
pub(crate) fn turn_complete_event(session_id: &str, at: i64) -> Value {
    json!({ "type": "freshAgent.turn.complete", "sessionId": session_id, "at": at })
}

/// Mint the `at` of a `freshAgent.turn.complete` edge synthesized outside a
/// lane's ordinary completion path (a sidecar crash with a turn in flight, a
/// quiet-deadman fire) on the session's clock, and log the edge at info.
/// DIAG-01: ids, source and `at` only, never the turn's content. The caller
/// broadcasts the edge in its own envelope.
pub(crate) fn mint_synthesized_edge(
    clock: &AttentionClock,
    provider: &str,
    session_id: &str,
    source: &'static str,
) -> i64 {
    let at = clock.mint();
    tracing::info!(provider, session_id, source, at, "freshagent.turn.complete");
    at
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude_sidecar_io::test_capture::{capture, with_message};
    use serde_json::json;

    /// Design §10 C15: an `at` a clock has observed is a floor -- the next
    /// mint lands strictly above it even when the wall clock has not caught
    /// up, so an edge minted after a forwarded one never collides with it.
    #[test]
    fn mint_after_observe_lands_strictly_above_the_observed_at() {
        let clock = AttentionClock::default();
        let observed = now_ms() + 60_000;
        clock.observe(observed);
        assert_eq!(clock.mint(), observed + 1, "wall clock is behind T");
        assert_eq!(clock.floor(), Some(observed + 1));

        let clock = AttentionClock::default();
        clock.observe(5_000);
        assert_eq!(clock.mint_with(5_000), 5_001, "now == T");
        assert_eq!(clock.mint_with(4_990), 5_002, "now < T");
        assert_eq!(clock.mint_with(9_000), 9_000, "a later now is taken as is");
    }

    /// Design §11.2: strictly increasing across mints within one millisecond
    /// and after a backward wall-clock step.
    #[test]
    fn mints_strictly_increase_within_a_millisecond_and_across_a_backward_step() {
        let clock = AttentionClock::default();
        assert_eq!(clock.floor(), None, "a fresh clock has minted nothing");
        assert_eq!(clock.mint_with(1_000), 1_000);
        assert_eq!(clock.mint_with(1_000), 1_001, "same millisecond");
        assert_eq!(clock.mint_with(1_000), 1_002, "same millisecond again");
        assert_eq!(clock.mint_with(400), 1_003, "the wall clock stepped back");
        assert_eq!(clock.mint_with(2_000), 2_000);
        assert_eq!(clock.floor(), Some(2_000));
    }

    #[test]
    fn observe_never_lowers_the_floor() {
        let clock = AttentionClock::default();
        clock.observe(700);
        clock.observe(300);
        assert_eq!(clock.floor(), Some(700));
        assert_eq!(clock.mint_with(500), 701);
    }

    /// Design §11.2: the clock carries across re-keys and death/resume -- a
    /// clone handed to the next record is the SAME timeline, not a copy.
    #[test]
    fn a_cloned_clock_continues_the_same_timeline() {
        let clock = AttentionClock::default();
        let carried = clock.clone();
        assert_eq!(clock.mint_with(10), 10);
        assert_eq!(carried.mint_with(10), 11);
        carried.observe(50);
        assert_eq!(clock.mint_with(10), 51);
    }

    /// Codex's subscription (the `freshell-codex` crate) mints its ordinary
    /// completions directly on the session's clock cell; a clock adopted from
    /// that cell shares its timeline both ways.
    #[test]
    fn a_clock_adopted_from_a_shared_cell_shares_its_timeline() {
        let cell = Arc::new(StdMutex::new(None));
        let clock = AttentionClock::from(Arc::clone(&cell));
        *cell.lock().unwrap() = Some(100);
        assert_eq!(clock.mint_with(100), 101);
        assert_eq!(*cell.lock().unwrap(), Some(101));
    }

    #[test]
    fn turn_complete_event_is_the_client_edge_shape() {
        assert_eq!(
            turn_complete_event("s-1", 42),
            json!({ "type": "freshAgent.turn.complete", "sessionId": "s-1", "at": 42 })
        );
    }

    /// A synthesized edge (crash, deadman) mints on the session's clock and
    /// logs the edge at info with ids, source and `at` (DIAG-01: never
    /// content).
    #[test]
    fn mint_synthesized_edge_mints_on_the_clock_and_logs_the_edge() {
        let (events, _guard) = capture();
        let clock = AttentionClock::default();
        let observed = now_ms() + 60_000;
        clock.observe(observed);

        let at = mint_synthesized_edge(&clock, "codex", "thread-1", "quiet_deadman");

        assert_eq!(at, observed + 1);
        assert_eq!(clock.floor(), Some(at));
        let logged = with_message(&events, "freshagent.turn.complete");
        assert_eq!(logged.len(), 1, "{logged:?}");
        let event = &logged[0];
        assert_eq!(event.level, tracing::Level::INFO);
        assert_eq!(event.field("provider"), Some("codex"));
        assert_eq!(event.field("session_id"), Some("thread-1"));
        assert_eq!(event.field("source"), Some("quiet_deadman"));
        assert_eq!(event.field("at"), Some(at.to_string().as_str()));
    }
}

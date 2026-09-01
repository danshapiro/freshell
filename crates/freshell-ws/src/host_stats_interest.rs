//! Per-connection `hoststats.subscribe` interest registry (host-pressure pane,
//! `docs/plans/2026-08-25-host-pressure-pane.md` Task 9).
//!
//! Shape precedent: [`crate::subagent_interest::SubagentInterestRegistry`] —
//! a cheaply-cloneable `Arc` handle; interest set/remove/any/count ONLY, with
//! NO cadence JoinHandle ownership (the concrete collector in freshell-server
//! owns spawn/abort through its `set_active` callback; `terminal.rs` calls it
//! on the transitions this registry reports).
//!
//! Task 9 delivery targeting difference from the subagent registry: each
//! entry ALSO stores the connection's outbound [`FrameSink`] (the
//! per-connection sender `terminal.rs` already owns for its socket write
//! loop), captured at subscribe time. This is the plan's frozen delivery
//! contract: host-stats snapshots flow ONLY to subscribed connections via
//! their per-conn channels — NEVER via the shared `broadcast_tx` bus
//! (non-watchers get zero traffic). [`HostStatsInterestRegistry::senders`] is
//! the cadence task's read surface for that fan-out.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use freshell_terminal::FrameSink;

/// How a [`HostStatsInterestRegistry::set`]/[`HostStatsInterestRegistry::remove`]
/// mutated the interested-connection cardinality. `terminal.rs` maps
/// `BecameActive` -> `collector.set_active(true)` (0->1 spawns the cadence)
/// and `BecameIdle` -> `collector.set_active(false)` (1->0 aborts it).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InterestTransition {
    /// Cardinality unchanged (idempotent re-subscribe / unknown-id removal).
    Unchanged,
    /// 0 -> 1: the first interested connection arrived.
    BecameActive,
    /// -> 0: the last interested connection left.
    BecameIdle,
}

/// The shared interior: interested connection-id -> outbound sender map under
/// a lock, plus a lock-free mirror of its cardinality for cheap gate reads.
/// The two are always updated under the same lock acquisition, so `count`
/// can never drift from `subs.len()`.
#[derive(Default)]
struct Inner {
    subs: Mutex<HashMap<u64, FrameSink>>,
    count: Arc<AtomicUsize>,
}

/// A cheaply-cloneable handle to the per-connection host-stats interest map.
/// All clones share the one underlying map (like `SubagentInterestRegistry`).
#[derive(Clone, Default)]
pub struct HostStatsInterestRegistry {
    inner: Arc<Inner>,
}

impl HostStatsInterestRegistry {
    /// Declare (`Some(sink)`) or retract (`None`) this connection's
    /// host-stats interest. Re-subscribing overwrites the connection's LATEST
    /// sender (idempotent in cardinality, fresh sink). Reports the
    /// cardinality transition so the caller can drive the collector's
    /// `set_active` exactly on 0->1 / ->0 edges.
    pub fn set(&self, conn_id: u64, sink: Option<FrameSink>) -> InterestTransition {
        let mut guard = self.inner.subs.lock().unwrap();
        // `insert`/`remove` on the map give exact cardinality under the lock;
        // the count mirror is stored under the same lock acquisition, so it
        // can never drift from the map.
        let old_count = guard.len();
        match sink {
            Some(sink) => {
                guard.insert(conn_id, sink);
            }
            None => {
                guard.remove(&conn_id);
            }
        }
        let new_count = guard.len();
        self.inner.count.store(new_count, Ordering::SeqCst);
        if new_count == old_count {
            InterestTransition::Unchanged
        } else if old_count == 0 && new_count == 1 {
            InterestTransition::BecameActive
        } else if new_count == 0 {
            InterestTransition::BecameIdle
        } else {
            // 1->2, 2->1, ...: still active, no edge.
            InterestTransition::Unchanged
        }
    }

    /// Clear a connection's entry entirely (socket teardown + the
    /// `hoststats.unsubscribe` arm). Unknown ids are a no-op
    /// (`InterestTransition::Unchanged`).
    pub fn remove(&self, conn_id: u64) -> InterestTransition {
        self.set(conn_id, None)
    }

    /// True iff at least one connected client is currently interested.
    pub fn any(&self) -> bool {
        self.count() > 0
    }

    /// The lock-free cardinality mirror (e.g. teardown-edge checks).
    pub fn count(&self) -> usize {
        self.inner.count.load(Ordering::SeqCst)
    }

    /// Snapshot of the live per-connection outbound senders, in
    /// insertion-irrelevant order — the cadence task's delivery fan-out
    /// (Task 9 frozen contract: subscribed connections ONLY, never
    /// `broadcast_tx`). A conn whose socket is mid-teardown is removed
    /// BEFORE its sink can go stale because `terminal.rs`'s teardown block
    /// calls [`HostStatsInterestRegistry::remove`] under the same connection
    /// lifecycle.
    pub fn senders(&self) -> Vec<FrameSink> {
        let guard = self.inner.subs.lock().unwrap();
        guard.values().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn noop_sink() -> FrameSink {
        Arc::new(|_| {})
    }

    #[test]
    fn host_stats_interest_set_any_count_remove_semantics() {
        let r = HostStatsInterestRegistry::default();
        assert!(!r.any());
        assert_eq!(r.count(), 0);

        r.set(7, Some(noop_sink()));
        assert!(r.any());
        assert_eq!(r.count(), 1);
        // Idempotent re-subscribe: cardinality must NOT double-count (the
        // sink is overwritten, the set gains nothing).
        r.set(7, Some(noop_sink()));
        assert_eq!(r.count(), 1);

        r.set(9, Some(noop_sink()));
        assert_eq!(r.count(), 2);

        r.remove(7);
        assert!(r.any(), "other connection still interested");
        assert_eq!(r.count(), 1);
        r.remove(42); // unknown id is a no-op
        assert_eq!(r.count(), 1);
        r.remove(9);
        assert!(!r.any());
        assert_eq!(r.count(), 0);
    }

    #[test]
    fn host_stats_interest_reports_0_to_1_and_1_to_0_transitions() {
        let r = HostStatsInterestRegistry::default();
        // First arrival is the ->active edge; repeats are unchanged.
        assert_eq!(
            r.set(1, Some(noop_sink())),
            InterestTransition::BecameActive
        );
        assert_eq!(r.set(1, Some(noop_sink())), InterestTransition::Unchanged);
        assert_eq!(r.set(2, Some(noop_sink())), InterestTransition::Unchanged);
        // Removing one of two stays active; removing the last is ->idle.
        assert_eq!(r.remove(1), InterestTransition::Unchanged);
        assert_eq!(r.remove(2), InterestTransition::BecameIdle);
        // Teardown on an unknown id never fires an edge.
        assert_eq!(r.remove(2), InterestTransition::Unchanged);
    }

    #[test]
    fn host_stats_interest_senders_snapshots_live_sinks_only() {
        let r = HostStatsInterestRegistry::default();
        assert!(r.senders().is_empty());
        r.set(1, Some(noop_sink()));
        r.set(2, Some(noop_sink()));
        assert_eq!(r.senders().len(), 2);
        r.remove(1);
        assert_eq!(r.senders().len(), 1);
    }
}

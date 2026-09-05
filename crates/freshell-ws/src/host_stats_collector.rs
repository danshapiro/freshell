//! The host-stats collector TRAIT bridge for the freshell-ws crate
//! (`docs/plans/2026-08-25-host-pressure-pane.md` Task 9).
//!
//! Dependency direction is frozen: freshell-ws canNOT depend on
//! freshell-server. The concrete collector (cadences, `/proc` reads, refresh
//! budgets) lives in freshell-server (`host_stats.rs`); this crate owns ZERO
//! `/proc` knowledge and ZERO timers — it knows only the trait, so
//! `terminal.rs`'s `hoststats.*` dispatch can drive it and `main.rs` can
//! inject the concrete `Arc<dyn HostStatsCollector>` into [`WsState`].
//!
//! Lifecycle contract (mirrors Node's `HostStatsService` start/stop):
//! `terminal.rs` calls [`HostStatsCollector::set_active`] ONLY on the
//! interest registry's cardinality edges — `true` on 0->1 (the collector
//! spawns its two-tier cadence + drift sampler internally), `false` on ->0
//! (the collector aborts the JoinHandles — true zero-cost idle). The interest
//! registry itself never holds a JoinHandle.

use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use freshell_protocol::{HostStatsManual, HostStatsSnapshot};

use crate::host_stats_interest::HostStatsInterestRegistry;

/// The data returned by a successful [`HostStatsCollector::refresh`] — the
/// payload halves of `hoststats.refresh.response { ok:true, at, manual }`
/// (the response's `requestId` echo is the dispatcher's job).
#[derive(Debug, Clone, PartialEq)]
pub struct HostStatsRefreshOk {
    pub at: u64,
    pub manual: HostStatsManual,
}

/// The boxed future [`HostStatsCollector::refresh`] returns (object-safe
/// async without an async-trait dependency; borrows the collector so the
/// boxed Arc in `WsState` can be driven in place).
pub type HostStatsRefreshFuture<'a> =
    Pin<Box<dyn std::future::Future<Output = Result<HostStatsRefreshOk, String>> + Send + 'a>>;

/// The host-stats collector contract. The concrete implementation is
/// freshell-server's `HostStatsCollectorService`; freshell-ws tests install
/// fakes.
pub trait HostStatsCollector: Send + Sync {
    /// Cache read only — NEVER waits on I/O newer than the last tick (mirrors
    /// `HostStatsService.getSnapshot`; ticks write caches, snapshots read
    /// them). Fresh subscribers get this frame immediately on subscribe.
    fn snapshot(&self) -> HostStatsSnapshot;

    /// On-request manual data (process table, disks, inotify,
    /// thermals/battery). Single-flight with a connection-agnostic 1s
    /// post-completion cooldown (`Err("rate_limited")`); NEVER fails for data
    /// reasons — a failed section degrades to its zero-shape while the others
    /// complete. `deadline` is the cooperative per-section budget (the shared
    /// absolute deadline is `start + deadline`; Node `sectionBudgetMs`).
    fn refresh(&self, deadline: Duration) -> HostStatsRefreshFuture<'_>;

    /// Interest-transition callback: `true` (0->1 interested) spawns the
    /// cadence internally (one immediate fast tick so a fresh subscriber gets
    /// a shaped snapshot at once), `false` (->0) aborts it. Idempotent.
    fn set_active(&self, active: bool);
}

/// The `WsState.host_stats` sub-struct (Task 9's `WsState` literal sweep: the
/// sweep exceeded the ~6-site threshold, so BOTH new fields are wrapped here
/// and every legacy `WsState { ... }` literal gains exactly one
/// `host_stats: Default::default()` arm). This is the type the plan's crate
/// architecture bullet names "`HostStatsShare`": the share BETWEEN the ws
/// crate (interest bookkeeping + dispatch) and the injected concrete
/// collector.
///
/// `collector` is `None` ONLY in unit tests that never exercise host-stats
/// (like `WsState.activity`); on a real boot `freshell-server`'s `main.rs`
/// always wires the concrete collector. A `hoststats.refresh` with no
/// collector answers `{ ok:false, error:"host stats unavailable" }` (Node
/// parity when `this.hostStats` is unset); subscribe with no collector
/// records interest and sends no snapshot (Node `sendHostStatsSnapshot`'s
/// early return).
#[derive(Clone, Default)]
pub struct WsHostStatsState {
    /// Per-connection subscribe bookkeeping + the cadence delivery fan-out.
    pub interest: HostStatsInterestRegistry,
    /// The injected concrete collector (freshell-server); `None` in
    /// host-stats-free unit tests.
    pub collector: Option<Arc<dyn HostStatsCollector>>,
}

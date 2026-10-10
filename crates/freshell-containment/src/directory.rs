//! `UnitDirectory`: which unit is which pane — unit id <-> terminal id /
//! create-request id — plus each start's cancellation and settlement, the
//! killed-start memory, and the lifecycle hook through which lanes that
//! cannot depend on the WebSocket layer (the REST create) use the single
//! stop path. It holds handles only: lifecycle STATE lives in the owner
//! registry (`freshell-ownership`).
//!
//! A start is one slot. Its unit can change while it starts (each Codex
//! start attempt runs in a fresh unit, and a reattach swaps in the reopened
//! unit): [`UnitDirectory::replace_unit`] re-keys the slot, and its
//! cancellation and settlement go with it, so a wait begun under an earlier
//! unit id still follows the start. A start is settled once its members are
//! bound and their placement is confirmed (or its owner gave it up); until
//! then a stop cancels it. When a unit's stop reaches Gone, a settled
//! start's entry is removed at once and an unsettled one when its owner
//! settles it ([`UnitDirectory::note_gone`]).

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};

use tokio::sync::{watch, Notify};

use crate::unit::{AgentUnit, StopHandle, StopMode, StopReason};
use crate::{BoxFuture, UnitId};

/// One pane's unit and how to find it.
#[derive(Clone)]
pub struct UnitEntry {
    pub unit: AgentUnit,
    pub provider: String,
    pub mode: String,
    pub create_request_id: Option<String>,
    pub terminal_id: Option<String>,
}

impl std::fmt::Debug for UnitEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UnitEntry")
            .field("unit", &self.unit.id().as_str())
            .field("provider", &self.provider)
            .field("mode", &self.mode)
            .field("create_request_id", &self.create_request_id)
            .field("terminal_id", &self.terminal_id)
            .finish()
    }
}

/// A start its owner gives up (its create failed or was cancelled), handed
/// to the installed lifecycle by a lane that cannot depend on the WebSocket
/// layer ([`UnitDirectory::abandon_start`]).
pub struct AbandonedStart {
    /// The start as its owner knows it: the unit it runs in now, and the
    /// terminal it spawned, if any.
    pub entry: UnitEntry,
    /// The start's own base unit when it differs from `entry.unit` (stopped
    /// too).
    pub base: Option<AgentUnit>,
    /// Why the start is given up (the stop's initiator, for its log lines).
    pub initiator: String,
    /// What the start holds on its conversation (its ownership claim, its
    /// lease): dropped once the unit is Gone, before the start settles.
    pub claim: Option<Box<dyn std::any::Any + Send>>,
}

/// The single stop path and the start settlement, installed by the
/// WebSocket layer ([`UnitDirectory::set_lifecycle`]).
pub trait UnitLifecycle: Send + Sync {
    /// Starts (or joins) the stop of `entry`'s unit and returns its handle
    /// without waiting.
    fn stop(
        &self,
        entry: &UnitEntry,
        mode: StopMode,
        reason: StopReason,
        initiator: &str,
    ) -> StopHandle;

    /// Confirms the placement of a start's screen (`screen_pid`) and settles
    /// the start (or fails it), without waiting.
    fn settle_start(&self, entry: &UnitEntry, screen_pid: u32);

    /// Gives a start up without waiting: its unit (and a differing base
    /// unit) is stopped through the single stop path, a row that stop could
    /// not end (spawned after its Gone) is ended, and once the unit is Gone
    /// the start's claim is dropped, then the start is settled and its
    /// entry removed.
    fn abandon_start(&self, start: AbandonedStart);

    /// Whether a stop of `unit` has begun, as the owner registry sees it.
    /// The default reads the unit's own stop latch.
    fn is_stopping(&self, unit: &AgentUnit) -> bool {
        unit.stop_in_flight().is_some()
    }
}

/// A start's cancellation, kept with its slot across re-keys.
#[derive(Default)]
struct StartCancel {
    cancelled: AtomicBool,
    notify: Notify,
}

struct Slot {
    entry: UnitEntry,
    cancel: Arc<StartCancel>,
    settled: watch::Sender<bool>,
    /// The unit's stop reached Gone while the start was unsettled: the entry
    /// goes when the start settles.
    gone: bool,
}

type BindHook = Arc<dyn Fn(UnitEntry) + Send + Sync>;

/// How a managed (supervisor-owned) pane's launch ended, as a kill that
/// waited for it sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManagedStartOutcome {
    /// The launch registered its facade: the pane runs (a kill stops it as
    /// a running managed pane).
    Registered,
    /// The pane was killed while it launched: what the launch started was
    /// stopped, and the supervisor verified it.
    StoppedVerified,
    /// The start ended with nothing verified stopped (the supervisor's error,
    /// or "create abandoned" for a start dropped unfinished).
    StopFailed(String),
}

type ManagedStartMap = HashMap<String, watch::Sender<Option<ManagedStartOutcome>>>;

/// The managed panes whose launch is in flight, by create-request id. A
/// managed launch is a supervisor call, not a unit: a kill that names such a
/// pane (it has no terminal yet) waits here for how the launch ended instead
/// of answering "not found" while a soul may be starting (Stage 2: LB-13).
/// Shared by every lane through the [`UnitDirectory`].
#[derive(Default)]
pub struct ManagedStarts {
    starts: Arc<Mutex<ManagedStartMap>>,
}

impl ManagedStarts {
    /// Records the launch of `create_request_id` as in flight until the
    /// returned guard is finished or dropped.
    pub fn begin(&self, create_request_id: &str) -> ManagedStartGuard {
        let (tx, _) = watch::channel(None);
        lock(&self.starts).insert(create_request_id.to_string(), tx.clone());
        ManagedStartGuard {
            starts: self.starts.clone(),
            create_request_id: create_request_id.to_string(),
            tx,
            finished: false,
        }
    }

    /// Resolves with how the in-flight launch of `create_request_id` ended;
    /// `None` when no managed launch is in flight for it.
    pub fn settled(
        &self,
        create_request_id: &str,
    ) -> Option<BoxFuture<'static, ManagedStartOutcome>> {
        let mut rx = lock(&self.starts).get(create_request_id)?.subscribe();
        Some(Box::pin(async move {
            match rx.wait_for(Option::is_some).await {
                Ok(outcome) => outcome.clone().expect("waited for an outcome"),
                // Unreachable: a guard sends before it lets go of the sender.
                Err(_) => ManagedStartOutcome::StopFailed("create abandoned".to_string()),
            }
        }))
    }
}

/// One managed launch in flight ([`ManagedStarts::begin`]). Dropped
/// unfinished, it ends the start as `StopFailed("create abandoned")`.
pub struct ManagedStartGuard {
    starts: Arc<Mutex<ManagedStartMap>>,
    create_request_id: String,
    tx: watch::Sender<Option<ManagedStartOutcome>>,
    finished: bool,
}

impl ManagedStartGuard {
    /// Ends the start: every waiting kill gets `outcome`, and the launch is
    /// no longer in flight.
    pub fn finish(mut self, outcome: ManagedStartOutcome) {
        self.finish_inner(outcome);
    }

    fn finish_inner(&mut self, outcome: ManagedStartOutcome) {
        if self.finished {
            return;
        }
        self.finished = true;
        self.tx.send_replace(Some(outcome));
        let mut starts = lock(&self.starts);
        // A later start under the same id keeps its own entry.
        if starts
            .get(&self.create_request_id)
            .is_some_and(|tx| tx.same_channel(&self.tx))
        {
            starts.remove(&self.create_request_id);
        }
    }
}

impl Drop for ManagedStartGuard {
    fn drop(&mut self) {
        self.finish_inner(ManagedStartOutcome::StopFailed(
            "create abandoned".to_string(),
        ));
    }
}

/// Which unit is which pane; see the module docs.
#[derive(Default)]
pub struct UnitDirectory {
    slots: Mutex<HashMap<UnitId, Slot>>,
    on_bind: Mutex<Option<BindHook>>,
    /// Create-request ids whose start a kill ended, for the server's
    /// lifetime (Reopen mints a new id, so a killed id is never reused).
    killed: Mutex<HashSet<String>>,
    managed_starts: ManagedStarts,
    lifecycle: RwLock<Option<Arc<dyn UnitLifecycle>>>,
}

/// Locks ignoring poisoning: a panicking caller must never make every later
/// lookup panic too.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl UnitDirectory {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Fired whenever a unit is bound to its terminal: the WebSocket side
    /// starts the unit's watchers here, for units created by any lane.
    pub fn set_on_bind(&self, hook: Arc<dyn Fn(UnitEntry) + Send + Sync>) {
        *lock(&self.on_bind) = Some(hook);
    }

    /// Adds a pane's entry. An entry that already names its terminal (a
    /// unit held since boot) is a settled start; any other is a start in
    /// progress.
    pub fn register(&self, entry: UnitEntry) {
        let (settled, _) = watch::channel(entry.terminal_id.is_some());
        lock(&self.slots).insert(
            entry.unit.id().clone(),
            Slot {
                entry,
                cancel: Arc::default(),
                settled,
                gone: false,
            },
        );
    }

    /// Re-keys a start's slot to `new_unit` (a new start attempt's unit, or
    /// a reattach's reopened unit), keeping its ids, cancellation and
    /// settlement; an entry `new_unit` already had (registered at boot) is
    /// replaced by this start's. Returns the unit the slot named before;
    /// `None` when `old` has no slot.
    pub fn replace_unit(&self, old: &UnitId, new_unit: AgentUnit) -> Option<AgentUnit> {
        let mut slots = lock(&self.slots);
        let mut slot = slots.remove(old)?;
        let previous = std::mem::replace(&mut slot.entry.unit, new_unit);
        if let Some(displaced) = slots.insert(slot.entry.unit.id().clone(), slot) {
            // Its settle waiters see the sender close and stop waiting.
            drop(displaced);
        }
        Some(previous)
    }

    /// Records the terminal a start spawned, so a stop that began before the
    /// bind still ends that row and `by_terminal` finds the starting unit.
    /// It neither settles the start nor fires the bind hook.
    pub fn note_terminal(&self, unit_id: &UnitId, terminal_id: &str) {
        if let Some(slot) = lock(&self.slots).get_mut(unit_id) {
            slot.entry.terminal_id = Some(terminal_id.to_string());
        }
    }

    /// Records the unit's terminal and fires the bind hook. It does not
    /// settle the start.
    pub fn bind_terminal(&self, unit_id: &UnitId, terminal_id: &str) {
        let bound = lock(&self.slots).get_mut(unit_id).map(|slot| {
            slot.entry.terminal_id = Some(terminal_id.to_string());
            slot.entry.clone()
        });
        let hook = lock(&self.on_bind).clone();
        if let (Some(entry), Some(hook)) = (bound, hook) {
            hook(entry);
        }
    }

    pub fn get(&self, unit_id: &UnitId) -> Option<UnitEntry> {
        lock(&self.slots).get(unit_id).map(|s| s.entry.clone())
    }

    pub fn by_terminal(&self, terminal_id: &str) -> Option<UnitEntry> {
        lock(&self.slots)
            .values()
            .find(|s| s.entry.terminal_id.as_deref() == Some(terminal_id))
            .map(|s| s.entry.clone())
    }

    pub fn by_create_request(&self, create_request_id: &str) -> Option<UnitEntry> {
        lock(&self.slots)
            .values()
            .find(|s| s.entry.create_request_id.as_deref() == Some(create_request_id))
            .map(|s| s.entry.clone())
    }

    /// Drops the entry; its settle waiters are released and its cancel
    /// waiters keep waiting (a removed start is never cancelled again).
    pub fn remove(&self, unit_id: &UnitId) -> Option<UnitEntry> {
        let slot = lock(&self.slots).remove(unit_id)?;
        slot.settled.send_replace(true);
        Some(slot.entry)
    }

    /// The unit's stop reached Gone: a settled start's entry is removed now
    /// (true); an unsettled start keeps its entry for its owner, and the
    /// entry is removed when the start settles (false).
    pub fn note_gone(&self, unit_id: &UnitId) -> bool {
        let mut slots = lock(&self.slots);
        let Some(slot) = slots.get_mut(unit_id) else {
            return false;
        };
        if *slot.settled.borrow() {
            let slot = slots.remove(unit_id).expect("present");
            slot.settled.send_replace(true);
            return true;
        }
        slot.gone = true;
        false
    }

    /// True (and wakes every cancel wait) when the start was not yet
    /// settled.
    pub fn cancel_start(&self, unit_id: &UnitId) -> bool {
        let slots = lock(&self.slots);
        let Some(slot) = slots.get(unit_id) else {
            return false;
        };
        if *slot.settled.borrow() {
            return false;
        }
        slot.cancel.cancelled.store(true, Ordering::SeqCst);
        slot.cancel.notify.notify_waiters();
        true
    }

    pub fn start_cancelled(&self, unit_id: &UnitId) -> bool {
        lock(&self.slots)
            .get(unit_id)
            .is_some_and(|s| s.cancel.cancelled.load(Ordering::SeqCst))
    }

    /// Resolves when the start of `unit_id` (as it is keyed now; the wait
    /// follows a later re-key) is cancelled. Never resolves for an unknown
    /// unit.
    pub async fn wait_start_cancelled(&self, unit_id: &UnitId) {
        let Some(cancel) = lock(&self.slots).get(unit_id).map(|s| s.cancel.clone()) else {
            return std::future::pending().await;
        };
        loop {
            let notified = cancel.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if cancel.cancelled.load(Ordering::SeqCst) {
                return;
            }
            notified.await;
        }
    }

    /// Settles the start; a start whose unit already reached Gone
    /// ([`Self::note_gone`]) is removed.
    pub fn mark_start_settled(&self, unit_id: &UnitId) {
        let mut slots = lock(&self.slots);
        let Some(slot) = slots.get(unit_id) else {
            return;
        };
        slot.settled.send_replace(true);
        if slot.gone {
            slots.remove(unit_id);
        }
    }

    /// Whether the start is settled (an unknown unit counts as settled).
    pub fn start_is_settled(&self, unit_id: &UnitId) -> bool {
        lock(&self.slots)
            .get(unit_id)
            .is_none_or(|s| *s.settled.borrow())
    }

    /// Ready when the start (as keyed now; the wait follows a later re-key)
    /// is settled or its entry is gone; at once for an unknown unit.
    pub fn start_settled(&self, unit_id: &UnitId) -> BoxFuture<'static, ()> {
        let rx = lock(&self.slots)
            .get(unit_id)
            .map(|s| s.settled.subscribe());
        Box::pin(async move {
            let Some(mut rx) = rx else { return };
            let _ = rx.wait_for(|settled| *settled).await;
        })
    }

    /// Remembers that a kill ended the start of `create_request_id`.
    pub fn remember_killed_start(&self, create_request_id: &str) {
        lock(&self.killed).insert(create_request_id.to_string());
    }

    pub fn killed_start(&self, create_request_id: &str) -> bool {
        lock(&self.killed).contains(create_request_id)
    }

    /// The managed panes whose launch is in flight.
    pub fn managed_starts(&self) -> &ManagedStarts {
        &self.managed_starts
    }

    /// Installs the single stop path (the WebSocket layer's).
    pub fn set_lifecycle(&self, lifecycle: Arc<dyn UnitLifecycle>) {
        *self
            .lifecycle
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(lifecycle);
    }

    /// The installed lifecycle, if any.
    pub fn lifecycle(&self) -> Option<Arc<dyn UnitLifecycle>> {
        self.lifecycle
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Stops a registered unit through the installed lifecycle; `None` when
    /// the unit has no entry or no lifecycle is installed.
    pub fn stop_unit(
        &self,
        unit_id: &UnitId,
        mode: StopMode,
        reason: StopReason,
        initiator: &str,
    ) -> Option<StopHandle> {
        let entry = self.get(unit_id)?;
        let lifecycle = self.lifecycle()?;
        Some(lifecycle.stop(&entry, mode, reason, initiator))
    }

    /// Gives a start up through the installed lifecycle
    /// ([`UnitLifecycle::abandon_start`]); `Err` hands the start back when
    /// no lifecycle is installed.
    pub fn abandon_start(&self, start: AbandonedStart) -> Result<(), Box<AbandonedStart>> {
        match self.lifecycle() {
            Some(lifecycle) => {
                lifecycle.abandon_start(start);
                Ok(())
            }
            None => Err(Box::new(start)),
        }
    }

    /// Hands a registered start's screen to the installed lifecycle's
    /// placement settlement (a no-op without an entry or a lifecycle).
    pub fn settle_start(&self, unit_id: &UnitId, screen_pid: u32) {
        let (Some(entry), Some(lifecycle)) = (self.get(unit_id), self.lifecycle()) else {
            return;
        };
        lifecycle.settle_start(&entry, screen_pid);
    }

    pub fn all(&self) -> Vec<UnitEntry> {
        lock(&self.slots)
            .values()
            .map(|s| s.entry.clone())
            .collect()
    }
}

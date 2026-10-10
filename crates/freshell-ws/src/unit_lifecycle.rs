//! The pane-unit lifecycle: every coding-agent terminal pane is one
//! containment unit (its screen, its agent main process and everything they
//! start), and **every stop of such a pane runs through
//! [`stop_terminal_unit`]**. `terminal.exit`, `terminals.changed` and the
//! Vacant owner frames are published only at Gone (the unit's `on_gone`,
//! [`publish_gone`]), never when a stop is requested.
//!
//! Lifecycle STATE lives in the owner registry (Live / Stopping / Vacant =
//! the unit's Running / Stopping / Gone); the [`UnitDirectory`] only maps
//! units to panes and tracks each start's cancellation and settlement.
//!
//! A start ([`StartScope`]) creates the pane's unit (its record written
//! first), spawns the screen into it, pins the screen, and is settled only
//! once its members are bound and their placement is confirmed
//! ([`PLACEMENT_DEADLINE`]). A screen that exits before that is a typed
//! start failure, never an agent crash; any later unrequested screen exit
//! ends the whole unit (`AgentExited`). Nothing here waits for Gone on a
//! connection loop or a create worker: every such wait runs in a spawned
//! task.

use std::ops::Deref;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use freshell_codex::launch_plan::{CodexUnitServices, DirectoryUnitLifecycle, UnitSeed};
use freshell_containment::events::{self, UnitLogKeys};
use freshell_containment::{
    AbandonedStart, AgentUnit, Containment, ProcWatch, Sig, StopHandle, StopMode, StopReason,
    StopReport, StopRequest, UnitDirectory, UnitEntry, UnitId, UnitLabel, UnitLifecycle,
    UNCONFIRMED_AFTER,
};
use freshell_terminal::{UnitEnding, UnitScreenExit};
use tokio::sync::watch;

use crate::WsState;

/// A start's member still unplaced this long after its spawn is a typed
/// start failure.
pub const PLACEMENT_DEADLINE: Duration = freshell_containment::PLACEMENT_DEADLINE;

/// The unit services a server shares between its lanes: the directory (which
/// unit is which pane) and the containment that creates units.
#[derive(Clone)]
pub struct UnitServices {
    pub directory: Arc<UnitDirectory>,
    pub containment: Containment,
}

impl Default for UnitServices {
    /// A fresh directory over the process-global containment (or, where none
    /// was installed, a per-process tag-backend containment under the system
    /// temp directory).
    fn default() -> Self {
        Self {
            directory: UnitDirectory::new(),
            containment: freshell_containment::global_or_fallback_containment(),
        }
    }
}

impl Deref for UnitServices {
    type Target = UnitDirectory;

    fn deref(&self) -> &UnitDirectory {
        &self.directory
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `StopReason::AgentExited`'s report reason: a stop that stayed an agent
/// exit (no user kill took it over).
const AGENT_EXITED: &str = "agent-exited";

/// Whether a stop report's reason is a user's kill (Shift-X or a kill
/// command).
fn is_user_kill(reason: &str) -> bool {
    reason == StopReason::ShiftX.as_str() || reason == StopReason::KillCommand.as_str()
}

fn fresh_operation(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4())
}

/// One stop request of a terminal pane's unit.
#[derive(Debug, Clone)]
pub struct UnitStopCommand {
    pub mode: StopMode,
    pub reason: StopReason,
    pub initiator: String,
    /// The owner operation this request starts (a joining request adopts the
    /// operation of the stop in flight).
    pub operation_id: String,
    /// Remember the pane's create-request id as killed, so a late create
    /// for it is answered "stopped".
    pub record_stopped_pane: bool,
}

impl UnitStopCommand {
    /// How the pane's row ends: an agent exit keeps it `Exited` (a crash), a
    /// placement failure keeps it `Exited` silently, every requested stop
    /// removes it.
    pub fn ending(&self) -> UnitEnding {
        match self.reason {
            StopReason::AgentExited { exit_code } => UnitEnding::AgentExited {
                exit_code: exit_code.unwrap_or(1),
            },
            StopReason::PlacementFailed { exit_code } => UnitEnding::StartFailed {
                exit_code: exit_code.unwrap_or(1),
            },
            _ => UnitEnding::Requested,
        }
    }
}

/// The unit's log keys, from its label (the operation when one is known).
fn unit_keys(unit: &AgentUnit, operation_id: Option<&str>) -> UnitLogKeys {
    let label = unit.label();
    UnitLogKeys {
        unit_id: unit.id().as_str().to_string(),
        provider: label.provider,
        session_id: label.session_id,
        terminal_id: label.terminal_id,
        operation_id: operation_id.map(str::to_string),
    }
}

/// THE stop of a coding-agent terminal pane's unit (Stage 2: LB-25; R2).
/// Everything up to `unit.stop` runs synchronously, before the handle is
/// returned:
///
/// 1. join decision from the owner registry: a key of the unit already
///    Stopping makes this call a join under that key's operation;
/// 2. `begin_unit_stop` and one live `stopping` owner frame per key moved;
/// 3. the row's ending is marked;
/// 4. except for an agent exit, the activity hub is told the stop began
///    (no idle, turn-complete or death-bell edge until Gone);
/// 5. the start is cancelled, and a pane stop is remembered as killed;
/// 6. `unit.stop` with [`publish_gone`] as its `on_gone` (the containment
///    runs only the first request's; a Force join escalates, and a user
///    kill joining a weaker stop takes over its reason).
///
/// Must be called inside the tokio runtime.
pub fn stop_terminal_unit(state: &WsState, entry: &UnitEntry, cmd: UnitStopCommand) -> StopHandle {
    start_unit_stop(state, entry, cmd).handle
}

/// A stop request of a pane's unit, as [`start_unit_stop`] started it.
pub(crate) struct UnitStop {
    /// The unit's one stop (resolves at Gone).
    pub(crate) handle: StopHandle,
    /// Set once the keys THIS request moved to Stopping are released after
    /// Gone (`None` when it moved none).
    released: Option<watch::Receiver<bool>>,
}

impl UnitStop {
    /// Resolves at Gone, once every key this request moved to Stopping is
    /// released (never in the unconfirmed case).
    pub(crate) async fn released(self) -> StopReport {
        let report = self.handle.wait().await;
        if let Some(mut released) = self.released {
            let _ = released.wait_for(|released| *released).await;
        }
        report
    }
}

/// The pane's ids as the directory knows them now (a terminal noted after
/// `entry` was read is used).
struct StopTarget {
    unit_id: String,
    terminal_id: Option<String>,
    create_request_id: Option<String>,
}

fn stop_target(state: &WsState, entry: &UnitEntry) -> StopTarget {
    let current = state.units.get(entry.unit.id());
    StopTarget {
        unit_id: entry.unit.id().as_str().to_string(),
        terminal_id: current
            .as_ref()
            .and_then(|e| e.terminal_id.clone())
            .or_else(|| entry.terminal_id.clone()),
        create_request_id: current
            .as_ref()
            .and_then(|e| e.create_request_id.clone())
            .or_else(|| entry.create_request_id.clone()),
    }
}

/// [`stop_terminal_unit`], all six steps.
pub(crate) fn start_unit_stop(
    state: &WsState,
    entry: &UnitEntry,
    cmd: UnitStopCommand,
) -> UnitStop {
    let target = stop_target(state, entry);
    let operation_id = stop_operation(state, &entry.unit, &cmd.operation_id);
    let moved = move_unit_keys(state, &target, &operation_id, &cmd.initiator);
    launch_unit_stop(state, entry, &target, cmd, operation_id, moved)
}

/// Step 1. The join decision comes from the registry, not the unit's
/// latch: a key already Stopping names the unit's one stop operation. When
/// none is (the stop in flight began before any key was stamped with the
/// unit, so it moved none), the stop in flight names it: this call joins
/// that stop, whose Gone commits only its own operation. Otherwise the
/// caller's.
fn stop_operation(state: &WsState, unit: &AgentUnit, requested: &str) -> String {
    let unit_id = unit.id().as_str();
    state
        .ownership
        .as_ref()
        .and_then(|ownership| {
            ownership
                .keys_for_unit(unit_id)
                .into_iter()
                .find_map(|(_, state)| match state {
                    freshell_ownership::OwnershipState::Stopping { operation_id, .. } => {
                        Some(operation_id)
                    }
                    _ => None,
                })
        })
        .or_else(|| unit.stop_operation())
        .unwrap_or_else(|| requested.to_string())
}

/// Step 2. Every key the unit holds moves to Stopping; the live frame tells
/// every device (Decision 17). Returns the operations the keys THIS call
/// moved are Stopping under (the registry may have moved them under the
/// operation of a stop another call began a moment earlier).
fn move_unit_keys(
    state: &WsState,
    target: &StopTarget,
    operation_id: &str,
    initiator: &str,
) -> std::collections::BTreeSet<String> {
    let Some(ownership) = state.ownership.as_ref() else {
        return Default::default();
    };
    let moved = ownership.begin_unit_stop(&target.unit_id, operation_id, initiator, now_ms());
    let moved_keys: Vec<_> = moved.iter().filter(|key| !key.joined).collect();
    let moved_ops = if moved_keys.is_empty() {
        Default::default()
    } else {
        ownership
            .keys_for_unit(&target.unit_id)
            .into_iter()
            .filter(|(key, _)| moved_keys.iter().any(|moved| &moved.key == key))
            .filter_map(|(_, key_state)| match key_state {
                freshell_ownership::OwnershipState::Stopping { operation_id, .. } => {
                    Some(operation_id)
                }
                _ => None,
            })
            .collect()
    };
    for key in moved_keys {
        // A start whose terminal is not known yet names none.
        crate::identity_ownership::broadcast_terminal_owner_frame(
            state,
            &key.key.provider,
            &key.key.session_id,
            target.terminal_id.as_deref(),
            operation_id,
            key.generation,
            "stopping",
        );
    }
    moved_ops
}

/// Steps 3 to 6, then the release of the keys this request moved: the
/// stop's `on_gone` commits only the operation of the request that started
/// the stop, so a request that moved keys under another operation (a key
/// stamped with the unit after its stop's Gone commit, or two stops begun
/// at the same moment) commits them itself once the unit is Gone
/// (`commit_unit_stop` is idempotent: keys the Gone commit already released
/// are not touched again).
fn launch_unit_stop(
    state: &WsState,
    entry: &UnitEntry,
    target: &StopTarget,
    cmd: UnitStopCommand,
    operation_id: String,
    moved_ops: std::collections::BTreeSet<String>,
) -> UnitStop {
    let unit = entry.unit.clone();

    // 3. How the row ends (the first ending marked wins).
    let ending = cmd.ending();
    if let Some(tid) = target.terminal_id.as_deref() {
        state.registry.mark_ending(tid, ending);
    }

    // 4. Stop-start silence (Stage 2: LB-37): a crash is never routed here
    //    before Gone and still rings at its exit.
    if !matches!(ending, UnitEnding::AgentExited { .. }) {
        if let (Some(hub), Some(tid)) = (state.activity.as_ref(), target.terminal_id.as_deref()) {
            hub.note_stop_requested(tid);
        }
    }

    // 5. A stopped start never settles as running.
    state.units.cancel_start(unit.id());
    if cmd.record_stopped_pane {
        if let Some(crq) = target.create_request_id.as_deref() {
            state.units.remember_killed_start(crq);
        }
    }

    // 6. The one stop sequence.
    let gone_entry = UnitEntry {
        terminal_id: target.terminal_id.clone(),
        create_request_id: target.create_request_id.clone(),
        ..entry.clone()
    };
    let gone_state = state.clone();
    let gone_cmd = cmd.clone();
    let gone_operation = operation_id.clone();
    let on_gone: freshell_containment::GoneCallback = Box::new(move |report: StopReport| {
        Box::pin(publish_gone(
            gone_state,
            gone_entry,
            gone_cmd,
            gone_operation,
            report,
        ))
    });
    let handle = unit.stop(
        StopRequest::new(cmd.mode, cmd.reason.clone(), cmd.initiator.clone())
            .operation(operation_id)
            .on_gone(on_gone),
    );
    let released = (!moved_ops.is_empty()).then(|| {
        let (released_tx, released_rx) = watch::channel(false);
        let state = state.clone();
        let unit_id = unit.id().as_str().to_string();
        let gone = handle.clone();
        tokio::spawn(async move {
            gone.wait().await;
            for operation_id in &moved_ops {
                release_unit_keys(&state, &unit_id, operation_id);
            }
            released_tx.send_replace(true);
        });
        released_rx
    });
    UnitStop { handle, released }
}

/// Commits Vacant every key of the unit Stopping under `operation_id` and
/// broadcasts each release (only at Gone). Returns the keys released.
fn release_unit_keys(
    state: &WsState,
    unit_id: &str,
    operation_id: &str,
) -> Vec<freshell_ownership::UnitStopKey> {
    let Some(ownership) = state.ownership.as_ref() else {
        return Vec::new();
    };
    let released = ownership.commit_unit_stop(unit_id, operation_id);
    for key in &released {
        crate::identity_ownership::broadcast_vacant_frame(
            state,
            &key.key.provider,
            &key.key.session_id,
            operation_id,
            ownership.boot_epoch(),
            key.generation,
        );
    }
    released
}

/// Publishes a unit's Gone (its `on_gone`), in this order:
///
/// a. the entry is re-read (a terminal noted after the stop began is used),
///    and the crash event and the row's main conversation are read before
///    the row changes;
/// b. the row ends (`terminal.exit` to its subscribers, then its Gone hook);
/// c. a removed row is retired and `terminals.changed` broadcast;
/// d. the Codex launch is finished (proxy closed, sidecar record removed);
/// e. a settled start's directory entry is removed (an unsettled one goes
///    when its owner settles it, after the create released its claim);
/// f. every key the stop owns is committed Vacant and broadcast;
/// g. an agent exit that stayed an agent exit sends its crash event,
///    fenced with the main key's post-commit generation.
///
/// The containment releases the stop's waiters only after this returns.
pub(crate) async fn publish_gone(
    state: WsState,
    entry: UnitEntry,
    cmd: UnitStopCommand,
    operation_id: String,
    report: StopReport,
) {
    let unit_id = entry.unit.id().clone();
    // a.
    let terminal_id = state
        .units
        .get(&unit_id)
        .and_then(|e| e.terminal_id)
        .or_else(|| entry.terminal_id.clone());
    let ending = match terminal_id
        .as_deref()
        .and_then(|tid| state.registry.ending(tid))
        .unwrap_or_else(|| cmd.ending())
    {
        // A user kill that joined an agent exit took the stop over (its
        // reason is the report's): the row ends as a requested stop,
        // removed like every kill, never kept as a crashed-looking row.
        UnitEnding::AgentExited { .. } if is_user_kill(&report.reason) => UnitEnding::Requested,
        ending => ending,
    };
    let (crash, main_key) = match terminal_id.as_deref() {
        Some(tid) => {
            let crash = match ending {
                UnitEnding::AgentExited { exit_code } => {
                    crate::terminal::crash_event_for(&state, tid, exit_code)
                }
                _ => None,
            };
            let main_key = state
                .registry
                .retained_ownership_claim(tid)
                .map(|claim| claim.locator)
                .or_else(|| state.identity.session_ref_for(tid));
            (crash, main_key)
        }
        None => (None, None),
    };

    // b.
    if let Some(tid) = terminal_id.clone() {
        let registry = state.registry.clone();
        let _ = tokio::task::spawn_blocking(move || registry.complete_unit_end(&tid, ending)).await;
    }
    // c.
    if let (UnitEnding::Requested, Some(tid)) = (ending, terminal_id.as_deref()) {
        crate::terminal::after_terminal_removed(&state, tid);
    }
    // d.
    if let Some(tid) = terminal_id.as_deref() {
        freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::global()
            .finish_unit(tid)
            .await;
    }
    // e.
    state.units.note_gone(&unit_id);
    // f.
    let mut main_fence = None;
    for key in release_unit_keys(&state, unit_id.as_str(), &operation_id) {
        if main_key.as_ref().is_some_and(|main| {
            main.provider == key.key.provider && main.session_id == key.key.session_id
        }) {
            main_fence = state
                .ownership
                .as_ref()
                .map(|ownership| (ownership.boot_epoch(), key.generation));
        }
    }
    // g.
    if matches!(ending, UnitEnding::AgentExited { .. }) && report.reason == AGENT_EXITED {
        if let Some(mut crash) = crash {
            crash.observed_fence = main_fence;
            let _ = state.auto_resume_tx.send(crash);
        }
    }
}

/// The registry's handler for an unrequested screen exit of a unit row. It
/// runs on the PTY reader thread and only hands the exit to the runtime.
pub fn screen_exit_hook(
    state: WsState,
    rt: tokio::runtime::Handle,
) -> Arc<dyn Fn(UnitScreenExit) + Send + Sync> {
    Arc::new(move |exit: UnitScreenExit| {
        let state = state.clone();
        rt.spawn(async move { on_screen_exit(&state, exit) });
    })
}

/// An unrequested screen exit: before the start settled it is a typed start
/// failure (never a crash, never a screen restart); afterwards the whole
/// unit ends as an agent exit. The entry is found by UNIT id, so an exit
/// before the bind is not lost.
fn on_screen_exit(state: &WsState, exit: UnitScreenExit) {
    let Some(unit_id) = UnitId::parse(&exit.unit_id) else {
        tracing::warn!(target: "freshell_unit",
            event = "unit.screen_exit_unmatched",
            unit_id = %exit.unit_id,
            terminal_id = %exit.terminal_id,
            exit_code = exit.exit_code,
            "a unit row's screen exited under an unparsable unit id");
        return;
    };
    let Some(entry) = state.units.get(&unit_id) else {
        tracing::debug!(target: "freshell_unit",
            event = "unit.screen_exit_unmatched",
            unit_id = %exit.unit_id,
            terminal_id = %exit.terminal_id,
            exit_code = exit.exit_code,
            "a unit row's screen exited after its unit left the directory");
        return;
    };
    let entry = UnitEntry {
        terminal_id: Some(exit.terminal_id.clone()),
        ..entry
    };
    if entry.unit.stop_in_flight().is_some() {
        // The unit's own stop ended the screen (it signals the screen it
        // pinned): the exit is part of that stop, never a start failure or
        // a crash. A row whose ending that stop could not mark yet (it began
        // before the row was known) ends as the requested stop it is.
        state
            .registry
            .mark_ending(&exit.terminal_id, UnitEnding::Requested);
        let keys = unit_keys(&entry.unit, entry.unit.stop_operation().as_deref());
        tracing::debug!(target: "freshell_unit",
            event = "unit.screen_exit_in_stop",
            unit_id = %keys.unit_id,
            provider = %keys.provider,
            session_id = %keys.session_id.as_deref().unwrap_or(""),
            terminal_id = %exit.terminal_id,
            operation_id = %keys.operation_id.as_deref().unwrap_or(""),
            exit_code = exit.exit_code,
            "a unit row's screen exited during its unit's stop");
        return;
    }
    if !state.units.start_is_settled(&unit_id) {
        let operation_id = fresh_operation("unit-placement");
        let pid = entry.unit.screen().map(|w| w.pid()).unwrap_or(0);
        events::placement_failed(
            &unit_keys(&entry.unit, Some(&operation_id)),
            "screen",
            pid,
            Some(exit.exit_code),
            "the screen exited before its placement was confirmed",
        );
        let _ = stop_terminal_unit(
            state,
            &entry,
            UnitStopCommand {
                mode: StopMode::Force,
                reason: StopReason::PlacementFailed {
                    exit_code: Some(exit.exit_code),
                },
                initiator: "unit-placement".to_string(),
                operation_id,
                record_stopped_pane: false,
            },
        );
        return;
    }
    let _ = stop_terminal_unit(
        state,
        &entry,
        UnitStopCommand {
            mode: StopMode::Force,
            reason: StopReason::AgentExited {
                exit_code: Some(exit.exit_code),
            },
            initiator: "unit-screen-exit".to_string(),
            operation_id: fresh_operation("unit-exit"),
            record_stopped_pane: false,
        },
    );
}

/// The registry's handler for a kill of a unit row (the kill paths not yet
/// routed through the unit lifecycle: an idle reap, a handoff, a recovery,
/// a test): the whole unit is stopped (Force) through the single stop path,
/// and the row ends at Gone. `false` when the unit is not in the directory,
/// so the registry kills the row as before.
pub fn kill_hook(state: WsState, rt: tokio::runtime::Handle) -> freshell_terminal::UnitKillHook {
    Arc::new(move |terminal_id: &str, unit_id: &str, by: &'static str| {
        let Some(entry) = UnitId::parse(unit_id).and_then(|id| state.units.get(&id)) else {
            return false;
        };
        let reason = match by {
            "idle" => StopReason::Cleanup,
            "shutdown" => StopReason::ServerShutdown,
            _ => StopReason::KillCommand,
        };
        let _runtime = rt.enter();
        let _ = stop_terminal_unit(
            &state,
            &UnitEntry {
                terminal_id: Some(terminal_id.to_string()),
                ..entry
            },
            UnitStopCommand {
                mode: StopMode::Force,
                reason,
                initiator: format!("registry-kill-{by}"),
                operation_id: registry_kill_operation(&state, unit_id),
                record_stopped_pane: false,
            },
        );
        true
    })
}

/// The operation a registry kill stops a unit under. A key of the unit in
/// `Handoff` with this unit as its prior belongs to that handoff, which is
/// stopping its prior through this very kill: the stop runs under the
/// handoff's own operation, so the unit's stop leaves that key to the
/// handoff (it commits it to its target) instead of moving it to Stopping
/// under a new operation, which would make the handoff's commit stale.
/// Otherwise a fresh kill operation.
fn registry_kill_operation(state: &WsState, unit_id: &str) -> String {
    state
        .ownership
        .as_ref()
        .and_then(|ownership| {
            ownership.keys_for_unit(unit_id).into_iter().find_map(
                |(_, key_state)| match key_state {
                    freshell_ownership::OwnershipState::Handoff { operation_id, .. } => {
                        Some(operation_id)
                    }
                    _ => None,
                },
            )
        })
        .unwrap_or_else(|| fresh_operation("term-kill"))
}

/// The WebSocket implementation of the directory's [`UnitLifecycle`]: the
/// single stop path and the placement settlement, for lanes that cannot
/// depend on this crate (the REST create, the Codex seed).
pub fn lifecycle(state: WsState, rt: tokio::runtime::Handle) -> Arc<dyn UnitLifecycle> {
    Arc::new(WsUnitLifecycle { state, rt })
}

struct WsUnitLifecycle {
    state: WsState,
    rt: tokio::runtime::Handle,
}

impl UnitLifecycle for WsUnitLifecycle {
    fn stop(
        &self,
        entry: &UnitEntry,
        mode: StopMode,
        reason: StopReason,
        initiator: &str,
    ) -> StopHandle {
        let _runtime = self.rt.enter();
        stop_terminal_unit(
            &self.state,
            entry,
            UnitStopCommand {
                mode,
                reason,
                initiator: initiator.to_string(),
                operation_id: fresh_operation("unit-stop"),
                record_stopped_pane: false,
            },
        )
    }

    fn settle_start(&self, entry: &UnitEntry, screen_pid: u32) {
        self.rt.spawn(settle_placement(
            self.state.clone(),
            entry.unit.clone(),
            screen_pid,
            None,
        ));
    }

    /// The REST lane's start given up: the same abandonment as a
    /// [`StartScope`]'s (the row it names is ended even when the unit's stop
    /// reached Gone before the row was known).
    fn abandon_start(&self, start: AbandonedStart) {
        let AbandonedStart {
            entry,
            base,
            initiator,
            claim,
        } = start;
        let spawned_terminal = entry.terminal_id.clone();
        let entry = match self.state.units.get(entry.unit.id()) {
            Some(current) => UnitEntry {
                terminal_id: current.terminal_id.or(spawned_terminal.clone()),
                ..current
            },
            None => entry,
        };
        let base = base
            .filter(|base| base.id() != entry.unit.id())
            .map(|base| UnitEntry {
                unit: base,
                provider: entry.provider.clone(),
                mode: entry.mode.clone(),
                create_request_id: None,
                terminal_id: None,
            });
        abandon_now(
            &self.state,
            &self.rt,
            Abandonment {
                entry,
                base,
                spawned_terminal,
                initiator,
                claim,
                claim_relay: None,
            },
        );
    }

    /// A stop has begun when the unit's own stop is in flight or the owner
    /// registry holds any of its keys Stopping. Synchronous and never
    /// blocking: the Codex launch manager asks while holding its own lock.
    fn is_stopping(&self, unit: &AgentUnit) -> bool {
        unit.stop_in_flight().is_some()
            || self.state.ownership.as_ref().is_some_and(|ownership| {
                ownership
                    .keys_for_unit(unit.id().as_str())
                    .iter()
                    .any(|(_, state)| {
                        matches!(state, freshell_ownership::OwnershipState::Stopping { .. })
                    })
            })
    }
}

/// Installs the unit lifecycle on a state's registry (the screen-exit and
/// kill hooks, and the process start-time reader that lets a start pin its
/// screen by pid and start time) and directory (the single stop path).
/// `freshell-server` does this at boot; a start does it for a state built
/// without it (tests), so a unit row's screen exit is never lost.
/// Idempotent.
pub fn wire(state: &WsState, rt: &tokio::runtime::Handle) {
    if state.units.lifecycle().is_some() {
        return;
    }
    state.registry.set_process_start_reader(Arc::new(|pid| {
        freshell_containment::process::start_time(pid).ok()
    }));
    state
        .registry
        .set_unit_screen_exit_hook(screen_exit_hook(state.clone(), rt.clone()));
    state
        .registry
        .set_unit_kill_hook(kill_hook(state.clone(), rt.clone()));
    state
        .units
        .set_lifecycle(lifecycle(state.clone(), rt.clone()));
}

/// Who owns a start's settlement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScopePhase {
    /// The create is still running: it settles or abandons the start.
    Open,
    /// The create succeeded: the settlement task settles the start.
    Committed,
    /// The create gave the start up: its abandon task settles it.
    Abandoned,
}

/// Confirms `screen_pid`'s placement in `unit` (a one-shot read, on a
/// blocking thread).
async fn placement_confirmed(unit: &AgentUnit, screen_pid: u32) -> bool {
    let unit = unit.clone();
    tokio::task::spawn_blocking(move || unit.confirm_placement(screen_pid).is_ok())
        .await
        .unwrap_or(false)
}

/// The placement settlement of a start whose screen is bound: one placement
/// check at once; if it fails, a [`PLACEMENT_DEADLINE`] timer raced against
/// the start's cancellation (a stop) and one more check at the deadline. A
/// screen still unplaced then is a typed start failure. The start is then
/// settled when its create committed (`phase` None: already committed);
/// an abandoned create settles it itself.
async fn settle_placement(
    state: WsState,
    unit: AgentUnit,
    screen_pid: u32,
    phase: Option<watch::Receiver<ScopePhase>>,
) {
    if !placement_confirmed(&unit, screen_pid).await {
        let cancelled = state.units.wait_start_cancelled(unit.id());
        tokio::select! {
            _ = tokio::time::sleep(PLACEMENT_DEADLINE) => {
                if unit.stop_in_flight().is_none()
                    && !placement_confirmed(&unit, screen_pid).await
                    && unit.stop_in_flight().is_none()
                {
                    let operation_id = fresh_operation("unit-placement");
                    events::placement_failed(
                        &unit_keys(&unit, Some(&operation_id)),
                        "screen",
                        screen_pid,
                        None,
                        "the screen was still unplaced at the placement deadline",
                    );
                    if let Some(entry) = state.units.get(unit.id()) {
                        let _ = stop_terminal_unit(
                            &state,
                            &entry,
                            UnitStopCommand {
                                mode: StopMode::Force,
                                reason: StopReason::PlacementFailed { exit_code: None },
                                initiator: "unit-placement".to_string(),
                                operation_id,
                                record_stopped_pane: false,
                            },
                        );
                    }
                }
            }
            _ = cancelled => {}
        }
    }
    match phase {
        None => state.units.mark_start_settled(unit.id()),
        Some(mut phase) => {
            let settled_by = phase
                .wait_for(|phase| *phase != ScopePhase::Open)
                .await
                .map(|phase| *phase);
            if matches!(settled_by, Ok(ScopePhase::Committed)) {
                state.units.mark_start_settled(unit.id());
            }
        }
    }
}

/// What [`StartScope::spawned`] found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Spawned {
    /// The screen runs in a live unit: bind and continue.
    Running,
    /// The unit's stop already reached Gone before the start's row was
    /// known to it: abandon the start (its abandonment kills the screen
    /// through its pin and ends the row).
    AlreadyStopped,
}

/// A claim a start does not hold itself (the auto-resume hub's): if the
/// start is given up, the holder sends it here, and the start drops it once
/// its unit is Gone, before it settles. A relay closed without a claim is
/// not waited for.
pub type ClaimRelay = tokio::sync::oneshot::Receiver<Box<dyn std::any::Any + Send>>;

/// The screen `pid` the registry spawned for `terminal_id`, pinned by pid
/// AND the start time its row recorded at the spawn, before anything could
/// reap it (a pid alone could name a later process once the screen was
/// reaped). `Err` says why it could not be pinned.
fn pin_screen(state: &WsState, terminal_id: &str, pid: u32) -> Result<ProcWatch, String> {
    let start = state
        .registry
        .screen_start_time(terminal_id)
        .ok_or_else(|| {
            "no start time is recorded for the screen (it already exited)".to_string()
        })?;
    ProcWatch::open_expecting(pid, start).map_err(|error| error.to_string())
}

/// One start of a coding-agent terminal pane inside its unit (see the module
/// docs). A scope dropped without [`Self::commit`] or [`Self::abandon`] is
/// abandoned.
pub struct StartScope {
    state: WsState,
    rt: Option<tokio::runtime::Handle>,
    provider: String,
    mode: String,
    create_request_id: String,
    terminal_id: String,
    label: UnitLabel,
    base: AgentUnit,
    seed: OnceLock<Arc<DirectoryUnitLifecycle>>,
    spawned_terminal: Option<String>,
    screen_pid: Option<u32>,
    claim_relay: Option<ClaimRelay>,
    phase: watch::Sender<ScopePhase>,
    done: bool,
}

impl StartScope {
    /// Creates the pane's unit (its record, written before this returns,
    /// carries provider, mode, session id, create-request id and the
    /// preallocated terminal id) and registers the starting entry.
    pub fn begin(
        state: &WsState,
        provider: &str,
        mode: &str,
        create_request_id: &str,
        terminal_id: &str,
        session_id: Option<&str>,
    ) -> std::io::Result<StartScope> {
        let rt = tokio::runtime::Handle::try_current().ok();
        if let Some(rt) = rt.as_ref() {
            wire(state, rt);
        }
        let label = UnitLabel {
            provider: provider.to_string(),
            session_id: session_id.map(str::to_string),
            terminal_id: Some(terminal_id.to_string()),
            mode: mode.to_string(),
            create_request_id: Some(create_request_id.to_string()),
        };
        let base = state
            .units
            .containment
            .create_unit(UnitId::mint(), label.clone())?;
        state.units.register(UnitEntry {
            unit: base.clone(),
            provider: provider.to_string(),
            mode: mode.to_string(),
            create_request_id: Some(create_request_id.to_string()),
            terminal_id: None,
        });
        // A kill of this pane that found no start yet (it remembered the
        // create-request id first, then looked for a start) cancels the
        // start registered just now, so it never mints an attempt.
        if state.units.killed_start(create_request_id) {
            state.units.cancel_start(base.id());
        }
        Ok(StartScope {
            state: state.clone(),
            rt,
            provider: provider.to_string(),
            mode: mode.to_string(),
            create_request_id: create_request_id.to_string(),
            terminal_id: terminal_id.to_string(),
            label,
            base,
            seed: OnceLock::new(),
            spawned_terminal: None,
            screen_pid: None,
            claim_relay: None,
            phase: watch::channel(ScopePhase::Open).0,
            done: false,
        })
    }

    /// The unit the current attempt spawns into.
    pub fn unit(&self) -> AgentUnit {
        match self.seed.get() {
            Some(seed) => seed.current(),
            None => self.base.clone(),
        }
    }

    fn seed_lifecycle(&self) -> Arc<DirectoryUnitLifecycle> {
        self.seed
            .get_or_init(|| {
                DirectoryUnitLifecycle::new(self.state.units.directory.clone(), self.base.clone())
            })
            .clone()
    }

    /// The Codex seed: every start attempt's fresh unit takes over this
    /// start's directory entry before the attempt spawns anything, and a
    /// cancelled start mints no further attempt.
    pub fn seed(&self) -> UnitSeed {
        UnitSeed {
            services: CodexUnitServices {
                containment: self.state.units.containment.clone(),
                lifecycle: self.seed_lifecycle(),
            },
            label: self.label.clone(),
        }
    }

    /// The plan ended with `launch_unit` (a fresh attempt's unit, or a
    /// reattach's reopened unit): the start's entry names it from now on
    /// (an entry the reopened unit had since boot is replaced by this
    /// start's, with this create's ids), and the unused base unit is stopped
    /// through the single stop path.
    pub fn adopt_launch_unit(&mut self, launch_unit: Option<AgentUnit>) {
        self.seed_lifecycle().finish_planning(launch_unit);
    }

    /// The conversation claim of this start is held elsewhere (the
    /// auto-resume hub holds a respawn's): if the start is given up, the
    /// holder hands it over through `relay`, and it is dropped once the unit
    /// is Gone, before the start settles.
    pub fn release_claim_after_gone(&mut self, relay: ClaimRelay) {
        self.claim_relay = Some(relay);
    }

    /// Whether a stop cancelled this start.
    pub fn cancelled(&self) -> bool {
        let unit = self.unit();
        self.state.units.get(unit.id()).is_none() || self.state.units.start_cancelled(unit.id())
    }

    /// Resolves when a stop cancels this start.
    pub async fn wait_cancelled(&self) {
        let unit = self.unit();
        if self.state.units.get(unit.id()).is_none() {
            return;
        }
        self.state.units.wait_start_cancelled(unit.id()).await;
    }

    /// The screen `screen_pid` of `terminal_id` was spawned into the unit:
    /// it is pinned as the unit's screen by pid and start time (every later
    /// stop signals it directly) and the terminal is noted. Never waits:
    /// when the unit's stop already reached Gone it answers
    /// [`Spawned::AlreadyStopped`], and the start's abandonment (which the
    /// caller then runs) kills the screen through its pin and ends the row.
    pub fn spawned(&mut self, terminal_id: &str, screen_pid: u32) -> Spawned {
        let unit = self.unit();
        match pin_screen(&self.state, terminal_id, screen_pid) {
            Ok(watch) => unit.set_screen(watch),
            // An exit the screen already took reaches the screen-exit hook
            // as a start failure.
            Err(reason) => events::screen_unpinned(&unit_keys(&unit, None), screen_pid, &reason),
        }
        self.state.units.note_terminal(unit.id(), terminal_id);
        self.spawned_terminal = Some(terminal_id.to_string());
        self.screen_pid = Some(screen_pid);
        let gone = unit
            .stop_in_flight()
            .is_some_and(|handle| handle.try_report().is_some());
        if gone {
            Spawned::AlreadyStopped
        } else {
            Spawned::Running
        }
    }

    /// Binds the unit to its terminal (the bind hook fires) and starts the
    /// placement settlement for the screen.
    pub fn bind(&mut self) {
        let unit = self.unit();
        let terminal_id = self
            .spawned_terminal
            .clone()
            .unwrap_or_else(|| self.terminal_id.clone());
        let mut label = unit.label();
        if label.terminal_id.as_deref() != Some(terminal_id.as_str()) {
            label.terminal_id = Some(terminal_id.clone());
            unit.set_label(label);
        }
        self.state.units.bind_terminal(unit.id(), &terminal_id);
        if let Some(screen_pid) = self.screen_pid {
            let settlement = settle_placement(
                self.state.clone(),
                unit,
                screen_pid,
                Some(self.phase.subscribe()),
            );
            match self.rt.as_ref() {
                Some(rt) => {
                    rt.spawn(settlement);
                }
                None => {
                    tokio::spawn(settlement);
                }
            }
        }
    }

    /// The create succeeded: the settlement task settles the start once its
    /// placement is confirmed.
    pub fn commit(mut self) {
        self.done = true;
        self.phase.send_replace(ScopePhase::Committed);
    }

    /// The create gives the start up. Not async: the unit's stop (Force,
    /// `StartCancelled`; it joins a kill already in flight) begins now, and
    /// a spawned task waits for Gone, drops `claim` (the create's ownership
    /// claim, so the Starting key is released after Gone and before the
    /// start settles), then settles the start and removes its entry.
    pub fn abandon(mut self, claim: Option<Box<dyn std::any::Any + Send>>) {
        self.abandon_inner(claim);
    }

    fn abandon_inner(&mut self, claim: Option<Box<dyn std::any::Any + Send>>) {
        if self.done {
            return;
        }
        self.done = true;
        self.phase.send_replace(ScopePhase::Abandoned);
        let current = self.unit();
        let entry = self
            .state
            .units
            .get(current.id())
            .unwrap_or_else(|| UnitEntry {
                unit: current.clone(),
                provider: self.provider.clone(),
                mode: self.mode.clone(),
                create_request_id: Some(self.create_request_id.clone()),
                terminal_id: self.spawned_terminal.clone(),
            });
        let base = (self.base.id() != current.id()).then(|| UnitEntry {
            unit: self.base.clone(),
            provider: self.provider.clone(),
            mode: self.mode.clone(),
            create_request_id: None,
            terminal_id: None,
        });
        let abandonment = Abandonment {
            entry,
            base,
            spawned_terminal: self.spawned_terminal.clone(),
            initiator: "start-cancelled".to_string(),
            claim,
            claim_relay: self.claim_relay.take(),
        };
        match self
            .rt
            .clone()
            .or_else(|| tokio::runtime::Handle::try_current().ok())
        {
            Some(rt) => abandon_now(&self.state, &rt, abandonment),
            None => events::start_abandon_unscheduled(&unit_keys(&current, None)),
        }
    }
}

impl Drop for StartScope {
    fn drop(&mut self) {
        self.abandon_inner(None);
    }
}

/// A start given up: its unit (and a differing base unit), the row it
/// spawned, and what it holds on its conversation.
struct Abandonment {
    entry: UnitEntry,
    base: Option<UnitEntry>,
    spawned_terminal: Option<String>,
    initiator: String,
    claim: Option<Box<dyn std::any::Any + Send>>,
    claim_relay: Option<ClaimRelay>,
}

/// Gives a start up ([`StartScope::abandon`], and the directory's
/// `abandon_start` for the REST lane). The unit's stop (Force,
/// `StartCancelled`) begins NOW, before the caller's other holds drop: a
/// key stamped with the unit moves to Stopping first, so no claim dropped
/// after this call can vacate it before Gone. A spawned task (nothing here
/// waits) then waits for Gone, ends a row that stop could not end (a screen
/// spawned after Gone is killed through its pin), drops the claim (and a
/// relayed one), and only then settles the start and removes its entry.
fn abandon_now(state: &WsState, rt: &tokio::runtime::Handle, abandonment: Abandonment) {
    let Abandonment {
        entry,
        base,
        spawned_terminal,
        initiator,
        claim,
        claim_relay,
    } = abandonment;
    let command = || UnitStopCommand {
        mode: StopMode::Force,
        reason: StopReason::StartCancelled,
        initiator: initiator.clone(),
        operation_id: fresh_operation("unit-start-cancel"),
        record_stopped_pane: false,
    };
    let _runtime = rt.enter();
    let stop = stop_terminal_unit(state, &entry, command());
    let base_stop = base
        .as_ref()
        .map(|base| stop_terminal_unit(state, base, command()));
    let state = state.clone();
    let unit = entry.unit;
    rt.spawn(async move {
        stop.wait().await;
        if let Some(base_stop) = base_stop {
            base_stop.wait().await;
        }
        if let Some(terminal_id) = spawned_terminal.as_deref() {
            end_row_of_gone_unit(&state, &unit, terminal_id).await;
        }
        drop(claim);
        if let Some(relay) = claim_relay {
            if let Ok(relayed) = relay.await {
                drop(relayed);
            }
        }
        state.units.mark_start_settled(unit.id());
        state.units.remove(unit.id());
    });
}

/// A unit whose stop reached Gone before its row was known to the stop: the
/// screen is killed through its pin (when it still runs) and the row, if it
/// is still this unit's and still running, is ended and retired as a
/// requested stop. A row the stop's own Gone already ended (removed, or kept
/// `Exited` after a failed start) is left as it is. Runs only in an
/// abandonment's spawned task.
async fn end_row_of_gone_unit(state: &WsState, unit: &AgentUnit, terminal_id: &str) {
    if state.registry.unit_id_for(terminal_id).as_deref() != Some(unit.id().as_str())
        || !state.registry.is_pty_running(terminal_id)
    {
        return;
    }
    if let Some(screen) = unit.screen() {
        if !screen.has_exited() {
            let _ = screen.signal(Sig::Kill);
            let _ = tokio::time::timeout(UNCONFIRMED_AFTER, screen.exited()).await;
        }
    }
    state
        .registry
        .mark_ending(terminal_id, UnitEnding::Requested);
    let registry = state.registry.clone();
    let tid = terminal_id.to_string();
    let ended = tokio::task::spawn_blocking(move || {
        registry.complete_unit_end(&tid, UnitEnding::Requested)
    })
    .await
    .unwrap_or(false);
    if ended {
        crate::terminal::after_terminal_removed(state, terminal_id);
    }
}

/// Shift-X (`terminal.kill`) of a coding-agent pane in its unit, found by
/// terminal or by create-request id (a pane still starting, or the pane's
/// replacement after auto-resume). Never awaits a Gone wait: the stop is
/// begun synchronously and the acknowledgement runs in a spawned task.
///
/// 1. The observed fence of the fenced stop claim (Stage 2: LB-34): while
///    the unit has no key Stopping yet and its row holds a retained claim,
///    the fence the kill carries (else the retained stamp) and the retained
///    terminal must match the main key's current Live pair and owner, or
///    the kill is refused as stale and stops nothing (a delayed kill from
///    another device cannot stop an auto-resumed replacement). A unit
///    already stopping skips it: the kill joins (and escalates to Force).
/// 2. The durable pane close, unless the kill is a stuck restart (the pane
///    stays resumable); a failed close answers failure and stops nothing.
/// 3. The unit's stop (Force; `ShiftX`, or `StuckRestart`), which cancels a
///    start and remembers the pane's create-request id as killed.
/// 4. With a `requestId`, `terminal.killed{success}` is sent only at Gone,
///    after the keys the kill moved are released and the start settled
///    (a cancelled start settles once its create released its claims), by
///    a task dropped when the connection closes; the stop runs on.
pub(crate) async fn kill_unit(
    kill: freshell_protocol::TerminalKill,
    entry: UnitEntry,
    reply: crate::terminal::KillReply,
    state: &WsState,
    initiator: &str,
) -> bool {
    // A pane still starting has no noted terminal yet: the answer names the
    // terminal its start was allocated.
    let reply = reply.naming(
        entry
            .terminal_id
            .clone()
            .or_else(|| entry.unit.label().terminal_id)
            .as_deref(),
    );
    let stuck_recovery = kill.reason.as_deref() == Some("stuck-recovery");

    // 1.
    if let Some(refusal) = unit_kill_fence(state, &kill, &entry) {
        tracing::warn!(target: "freshell_unit",
            event = "unit.kill_refused",
            unit_id = %entry.unit.id(),
            provider = %entry.provider,
            session_id = %entry.unit.label().session_id.unwrap_or_default(),
            terminal_id = %entry.terminal_id.as_deref().unwrap_or(""),
            operation_id = "",
            reason = %refusal.reason(),
            "the kill names superseded ownership; nothing is stopped");
        return reply.send(refusal.into());
    }

    // 2. A pane still starting is closed under the terminal it was
    //    allocated.
    let mut persisted_despite_error = false;
    let close_terminal = entry
        .terminal_id
        .clone()
        .or_else(|| kill.terminal_id.clone())
        .or_else(|| entry.unit.label().terminal_id);
    if let (false, Some(close_terminal)) = (stuck_recovery, close_terminal.as_deref()) {
        let create_request_id = entry
            .create_request_id
            .as_deref()
            .or(kill.create_request_id.as_deref());
        match crate::terminal::durable_pane_close(state, close_terminal, create_request_id).await {
            crate::terminal::PaneClose::Recorded => {}
            crate::terminal::PaneClose::PersistedDespiteError => persisted_despite_error = true,
            crate::terminal::PaneClose::Failed => {
                return reply.send(crate::terminal::KillAnswer::close_failed());
            }
        }
    }

    // 3.
    let settled = state.units.start_settled(entry.unit.id());
    let (reason, initiator) = if stuck_recovery {
        (
            StopReason::StuckRestart,
            format!("{initiator}-stuck-recovery"),
        )
    } else {
        (StopReason::ShiftX, initiator.to_string())
    };
    let stop = start_unit_stop(
        state,
        &entry,
        UnitStopCommand {
            mode: StopMode::Force,
            reason,
            initiator,
            operation_id: fresh_operation("term-kill"),
            record_stopped_pane: !stuck_recovery,
        },
    );

    // 4.
    if reply.has_request_id() {
        reply.answer_when(async move {
            stop.released().await;
            settled.await;
            crate::terminal::KillAnswer::done_after_close(persisted_despite_error)
        });
    } else if persisted_despite_error {
        reply.send(crate::terminal::KillAnswer::done_after_close(true));
    }
    true
}

/// Step 1 of [`kill_unit`]: `Some(refusal)` when the kill's observed fence
/// (or the retained stamp) no longer names the pane's current owner. A unit
/// with a key Stopping is never fenced (the kill joins). Once the pane's row
/// holds a retained claim, the fence is checked against the main key's Live
/// pair and owner; before that (the pane, or its replacement, is still
/// starting), by [`starting_unit_kill_fence`].
fn unit_kill_fence(
    state: &WsState,
    kill: &freshell_protocol::TerminalKill,
    entry: &UnitEntry,
) -> Option<crate::terminal::KillRefusal> {
    let ownership = state.ownership.as_ref()?;
    let stopping = ownership
        .keys_for_unit(entry.unit.id().as_str())
        .iter()
        .any(|(_, key_state)| {
            matches!(
                key_state,
                freshell_ownership::OwnershipState::Stopping { .. }
            )
        });
    if stopping {
        return None;
    }
    let Some(retained) = entry
        .terminal_id
        .as_deref()
        .and_then(|terminal_id| state.registry.retained_ownership_claim(terminal_id))
    else {
        return starting_unit_kill_fence(ownership, kill, entry);
    };
    let observed = match crate::terminal::kill_observed_fence(kill, ownership, &retained) {
        Ok(observed) => observed,
        Err(refusal) => return Some(refusal),
    };
    let current = ownership.observe(&retained.locator.provider, &retained.locator.session_id);
    match &current.state {
        freshell_ownership::OwnershipState::Live {
            owner, generation, ..
        } => {
            let stale = observed.epoch != ownership.boot_epoch()
                || observed.generation != *generation
                || owner.terminal_id.as_deref() != Some(retained.terminal_id.as_str());
            stale.then(|| {
                crate::terminal::stale_kill_refusal(
                    &current.state,
                    ownership.boot_epoch(),
                    *generation,
                )
            })
        }
        _ => None,
    }
}

/// The fence of a kill reaching a unit that is still starting (its row holds
/// no retained claim yet), as for a Live pane (Task 13 review M3): an
/// observed pair the kill carries must be the current pair of the
/// conversation the unit is starting, while that conversation is Starting
/// or Live; otherwise the kill is refused as stale and cancels nothing (a
/// delayed kill from another device cannot cancel the start of an
/// auto-resumed or stuck-restart replacement). A kill carrying no pair has
/// no retained stamp to fall back to and is not fenced; nor is a start of a
/// fresh conversation (no session id yet).
fn starting_unit_kill_fence(
    ownership: &freshell_ownership::RuntimeOwnershipRegistry,
    kill: &freshell_protocol::TerminalKill,
    entry: &UnitEntry,
) -> Option<crate::terminal::KillRefusal> {
    let observed = match crate::terminal::kill_wire_fence(kill) {
        Ok(Some(observed)) => observed,
        Ok(None) => return None,
        Err(refusal) => return Some(refusal),
    };
    let session_id = entry.unit.label().session_id?;
    let current = ownership.observe(&entry.provider, &session_id);
    match &current.state {
        freshell_ownership::OwnershipState::Starting { .. }
        | freshell_ownership::OwnershipState::Live { .. } => {
            let stale =
                observed.epoch != current.epoch || observed.generation != current.generation;
            stale.then(|| {
                crate::terminal::stale_kill_refusal(
                    &current.state,
                    current.epoch,
                    current.generation,
                )
            })
        }
        _ => None,
    }
}

/// A kill named a terminal nothing runs for: `Ok(())` only when the owner
/// registry confirms nothing holds a conversation for it. A key held under
/// the terminal that is still settling (Stopping) is waited for (event
/// driven, `wait_settled`) and the check repeated; a key still Live under
/// it answers `Err("OWNER_WITHOUT_RUNTIME")` with ERROR
/// `unit.kill_inconsistent`. Without an owner registry, `Ok(())`. Only ever
/// awaited in a kill's spawned task.
pub async fn confirm_gone_for_unknown(state: &WsState, terminal_id: &str) -> Result<(), String> {
    let Some(ownership) = state.ownership.clone() else {
        return Ok(());
    };
    loop {
        let mut settling = None;
        for (key, key_state) in ownership.states_for_terminal(terminal_id) {
            match key_state {
                freshell_ownership::OwnershipState::Live { .. } => {
                    tracing::error!(target: "freshell_unit",
                        event = "unit.kill_inconsistent",
                        unit_id = "",
                        provider = %key.provider,
                        session_id = %key.session_id,
                        terminal_id = %terminal_id,
                        operation_id = "",
                        "a kill found no runtime for this terminal, but a conversation is still held Live under it");
                    return Err("OWNER_WITHOUT_RUNTIME".to_string());
                }
                freshell_ownership::OwnershipState::Stopping { .. }
                | freshell_ownership::OwnershipState::Starting { .. }
                | freshell_ownership::OwnershipState::Handoff { .. } => {
                    settling = Some(key);
                    break;
                }
                // Aliased keys hold no runtime; Vacant and Fenced keys are
                // settled.
                _ => {}
            }
        }
        let Some(key) = settling else {
            return Ok(());
        };
        ownership.wait_settled(&key.provider, &key.session_id).await;
    }
}

/// The unit row of `terminal_id`, stopped (Force) through the single stop
/// path; `None` when the terminal is not a unit row. For the create and
/// recovery paths that used to kill a row they just spawned.
pub(crate) fn stop_unit_row(
    state: &WsState,
    terminal_id: &str,
    reason: StopReason,
    initiator: &str,
    record_stopped_pane: bool,
) -> Option<StopHandle> {
    let entry = state.units.by_terminal(terminal_id)?;
    Some(stop_terminal_unit(
        state,
        &entry,
        UnitStopCommand {
            mode: StopMode::Force,
            reason,
            initiator: initiator.to_string(),
            operation_id: fresh_operation("term-kill"),
            record_stopped_pane,
        },
    ))
}

#[cfg(test)]
#[path = "unit_lifecycle_tests.rs"]
mod tests;

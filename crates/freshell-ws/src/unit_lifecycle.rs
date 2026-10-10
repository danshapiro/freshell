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
    AgentUnit, Containment, ProcWatch, Sig, StopHandle, StopMode, StopReason, StopReport,
    StopRequest, UnitDirectory, UnitEntry, UnitId, UnitLabel, UnitLifecycle, UNCONFIRMED_AFTER,
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
    let unit = entry.unit.clone();
    let unit_id = unit.id().as_str().to_string();
    let current = state.units.get(unit.id());
    let terminal_id = current
        .as_ref()
        .and_then(|e| e.terminal_id.clone())
        .or_else(|| entry.terminal_id.clone());
    let create_request_id = current
        .as_ref()
        .and_then(|e| e.create_request_id.clone())
        .or_else(|| entry.create_request_id.clone());

    // 1. The join decision comes from the registry, not the unit's latch.
    let operation_id = state
        .ownership
        .as_ref()
        .and_then(|ownership| {
            ownership
                .keys_for_unit(&unit_id)
                .into_iter()
                .find_map(|(_, state)| match state {
                    freshell_ownership::OwnershipState::Stopping { operation_id, .. } => {
                        Some(operation_id)
                    }
                    _ => None,
                })
        })
        .unwrap_or_else(|| cmd.operation_id.clone());

    // 2. Every key the unit holds moves to Stopping; the live frame tells
    //    every device (Decision 17).
    if let Some(ownership) = state.ownership.as_ref() {
        let moved = ownership.begin_unit_stop(&unit_id, &operation_id, &cmd.initiator, now_ms());
        for key in moved.iter().filter(|key| !key.joined) {
            crate::identity_ownership::broadcast_owner_frame(
                state,
                &key.key.provider,
                &key.key.session_id,
                terminal_id.as_deref().unwrap_or(""),
                &operation_id,
                key.generation,
                "stopping",
            );
        }
    }

    // 3. How the row ends (the first ending marked wins).
    let ending = cmd.ending();
    if let Some(tid) = terminal_id.as_deref() {
        state.registry.mark_ending(tid, ending);
    }

    // 4. Stop-start silence (Stage 2: LB-37): a crash is never routed here
    //    before Gone and still rings at its exit.
    if !matches!(ending, UnitEnding::AgentExited { .. }) {
        if let (Some(hub), Some(tid)) = (state.activity.as_ref(), terminal_id.as_deref()) {
            hub.note_stop_requested(tid);
        }
    }

    // 5. A stopped start never settles as running.
    state.units.cancel_start(unit.id());
    if cmd.record_stopped_pane {
        if let Some(crq) = create_request_id.as_deref() {
            state.units.remember_killed_start(crq);
        }
    }

    // 6. The one stop sequence.
    let gone_entry = UnitEntry {
        terminal_id: terminal_id.clone(),
        create_request_id: create_request_id.clone(),
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
    unit.stop(
        StopRequest::new(cmd.mode, cmd.reason.clone(), cmd.initiator.clone())
            .operation(operation_id)
            .on_gone(on_gone),
    )
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
    let ending = terminal_id
        .as_deref()
        .and_then(|tid| state.registry.ending(tid))
        .unwrap_or_else(|| cmd.ending());
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
    if let Some(ownership) = state.ownership.as_ref() {
        for key in ownership.commit_unit_stop(unit_id.as_str(), &operation_id) {
            crate::identity_ownership::broadcast_vacant_frame(
                &state,
                &key.key.provider,
                &key.key.session_id,
                &operation_id,
                ownership.boot_epoch(),
                key.generation,
            );
            if main_key.as_ref().is_some_and(|main| {
                main.provider == key.key.provider && main.session_id == key.key.session_id
            }) {
                main_fence = Some((ownership.boot_epoch(), key.generation));
            }
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
                operation_id: fresh_operation("term-kill"),
                record_stopped_pane: false,
            },
        );
        true
    })
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
/// kill hooks) and directory (the single stop path). `freshell-server` does this at boot;
/// a start does it for a state built without it (tests), so a unit row's
/// screen exit is never lost. Idempotent.
pub fn wire(state: &WsState, rt: &tokio::runtime::Handle) {
    if state.units.lifecycle().is_some() {
        return;
    }
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
    /// The unit's stop already reached Gone: the screen was killed and its
    /// row ended; abandon the start.
    AlreadyStopped,
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
    /// it is pinned as the unit's screen (every later stop signals it
    /// directly) and the terminal is noted. When the unit's stop already
    /// reached Gone, the screen is killed through its pin, its row is ended,
    /// and the start must be abandoned.
    pub async fn spawned(&mut self, terminal_id: &str, screen_pid: u32) -> Spawned {
        let unit = self.unit();
        match ProcWatch::open(screen_pid) {
            Ok(watch) => unit.set_screen(watch),
            // The screen already exited: its exit reaches the screen-exit
            // hook as a start failure.
            Err(error) => tracing::debug!(target: "freshell_unit",
                event = "unit.screen_unpinned",
                unit_id = %unit.id(),
                terminal_id,
                pid = screen_pid,
                error = %error,
                "the screen could not be pinned (it already exited)"),
        }
        self.state.units.note_terminal(unit.id(), terminal_id);
        self.spawned_terminal = Some(terminal_id.to_string());
        self.screen_pid = Some(screen_pid);
        let gone = unit
            .stop_in_flight()
            .is_some_and(|handle| handle.try_report().is_some());
        if !gone {
            return Spawned::Running;
        }
        end_row_of_gone_unit(&self.state, &unit, terminal_id).await;
        Spawned::AlreadyStopped
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

    /// The create gives the start up. Not async: a spawned task stops the
    /// unit (Force, `StartCancelled`; it joins a kill already in flight),
    /// waits for Gone, drops `claim` (the create's ownership claim, so the
    /// Starting key is released before the start settles), then settles the
    /// start and removes its entry.
    pub fn abandon(mut self, claim: Option<Box<dyn std::any::Any + Send>>) {
        self.abandon_inner(claim);
    }

    fn abandon_inner(&mut self, claim: Option<Box<dyn std::any::Any + Send>>) {
        if self.done {
            return;
        }
        self.done = true;
        self.phase.send_replace(ScopePhase::Abandoned);
        let state = self.state.clone();
        let current = self.unit();
        let base = self.base.clone();
        let entry = state.units.get(current.id()).unwrap_or_else(|| UnitEntry {
            unit: current.clone(),
            provider: self.provider.clone(),
            mode: self.mode.clone(),
            create_request_id: Some(self.create_request_id.clone()),
            terminal_id: self.spawned_terminal.clone(),
        });
        let detached_base = UnitEntry {
            unit: base.clone(),
            provider: self.provider.clone(),
            mode: self.mode.clone(),
            create_request_id: None,
            terminal_id: None,
        };
        let spawned_terminal = self.spawned_terminal.clone();
        let unit_id = current.id().clone();
        let task = async move {
            let command = || UnitStopCommand {
                mode: StopMode::Force,
                reason: StopReason::StartCancelled,
                initiator: "start-cancelled".to_string(),
                operation_id: fresh_operation("unit-start-cancel"),
                record_stopped_pane: false,
            };
            let stop = stop_terminal_unit(&state, &entry, command());
            let base_stop = (base.id() != current.id())
                .then(|| stop_terminal_unit(&state, &detached_base, command()));
            stop.wait().await;
            if let Some(base_stop) = base_stop {
                base_stop.wait().await;
            }
            if let Some(terminal_id) = spawned_terminal.as_deref() {
                end_row_of_gone_unit(&state, &current, terminal_id).await;
            }
            drop(claim);
            state.units.mark_start_settled(current.id());
            state.units.remove(current.id());
        };
        match self
            .rt
            .clone()
            .or_else(|| tokio::runtime::Handle::try_current().ok())
        {
            Some(rt) => {
                rt.spawn(task);
            }
            None => tracing::error!(target: "freshell_unit",
                event = "unit.start_abandon_unscheduled",
                unit_id = %unit_id,
                "an abandoned start could not be stopped (no runtime); its unit record \
                 stays for the next boot"),
        }
    }
}

impl Drop for StartScope {
    fn drop(&mut self) {
        self.abandon_inner(None);
    }
}

/// A unit whose stop reached Gone before its row was known to the stop: the
/// screen is killed through its pin (when it still runs) and the row, if it
/// is still this unit's and still running, is ended and retired as a
/// requested stop. A row the stop's own Gone already ended (removed, or kept
/// `Exited` after a failed start) is left as it is.
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

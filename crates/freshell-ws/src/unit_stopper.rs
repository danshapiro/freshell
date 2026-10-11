//! The WebSocket layer's [`PaneUnitStopper`]: the single stop path of a
//! terminal pane's unit ([`crate::unit_lifecycle`]) for the lanes that
//! cannot depend on this crate (the session handoff and the automation
//! routes in `freshell-freshagent`). `freshell-server` installs it with
//! `FreshAgentState::with_pane_unit_stopper`.

use freshell_containment::{StopMode, StopReason, StopReport};
use freshell_freshagent::PaneUnitStopper;
use futures_util::future::BoxFuture;

use crate::unit_lifecycle::UnitStopCommand;
use crate::WsState;

/// Stops a terminal pane's unit through
/// [`crate::unit_lifecycle::start_unit_stop_off_loop`] (Force) and resolves
/// at its Gone, once the keys the stop moved are released, with the stop's
/// report. A row outside any unit is killed the legacy way
/// ([`crate::terminal::kill_and_broadcast`]) and resolves `None` at once.
pub struct WsPaneUnitStopper {
    state: WsState,
}

impl WsPaneUnitStopper {
    pub fn new(state: WsState) -> Self {
        Self { state }
    }
}

/// The stop reason a stopper caller names.
fn stop_reason(reason: &str) -> StopReason {
    match reason {
        "handoff" => StopReason::Handoff,
        "respawn" => StopReason::Respawn,
        _ => StopReason::KillCommand,
    }
}

impl PaneUnitStopper for WsPaneUnitStopper {
    fn stop_terminal(
        &self,
        terminal_id: String,
        reason: &'static str,
        operation_id: Option<String>,
    ) -> BoxFuture<'static, Option<StopReport>> {
        let state = self.state.clone();
        Box::pin(async move {
            let Some(entry) = state.units.by_terminal(&terminal_id) else {
                crate::terminal::kill_and_broadcast(&state, &terminal_id);
                return None;
            };
            let command = UnitStopCommand {
                mode: StopMode::Force,
                reason: stop_reason(reason),
                initiator: format!("pane-stopper-{reason}"),
                operation_id: operation_id
                    .unwrap_or_else(|| format!("pane-stop-{}", uuid::Uuid::new_v4())),
                record_stopped_pane: false,
            };
            let stop =
                crate::unit_lifecycle::start_unit_stop_off_loop(&state, &entry, command).await;
            Some(stop.released().await)
        })
    }
}

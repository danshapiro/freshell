//! Name reliability (Task 10): the WebSocket door's side of the shared
//! terminal naming bind (`freshell_freshagent::terminal_name_binding`).
//!
//! [`IdentityNameBinder`] implements the bind's [`TerminalNameBinder`] over
//! this crate's identity registry — the table every rename route and name
//! projection resolves through. The thin wrappers below call the shared
//! helper from each WebSocket-side terminal row path (create, managed
//! adoption, auto-resume respawn), from the identity upsert's conversation
//! switch callers, and from the 2 s reconcile tick. `freshell-server` also
//! hands an [`IdentityNameBinder`] to the REST door, so both doors write the
//! SAME identity table through the same helper.

use std::sync::Arc;
use std::time::Duration;

use freshell_freshagent::naming::SessionNaming;
use freshell_freshagent::terminal_name_binding::{
    bind_terminal_naming_from_identity, follow_identity_name_ref, reconcile_terminal_names,
    NamingBindHint, NamingBindOutcome, TerminalNameBinder, TerminalNamesReconcile,
    TerminalNamesTick,
};
use freshell_protocol::session_names::SessionNameRef;

use crate::identity::TerminalIdentityRegistry;
use crate::WsState;

/// The reconcile tick's cadence (the naming tick's 2 s, `freshell-server`).
const RECONCILE_INTERVAL: Duration = Duration::from_secs(2);

/// The identity registry as the naming bind's door table.
#[derive(Clone, Debug)]
pub struct IdentityNameBinder {
    identity: TerminalIdentityRegistry,
}

impl IdentityNameBinder {
    pub fn new(identity: TerminalIdentityRegistry) -> Self {
        Self { identity }
    }
}

impl TerminalNameBinder for IdentityNameBinder {
    fn set_name_binding(
        &self,
        terminal_id: &str,
        name_ref: &SessionNameRef,
        naming_handle: Option<&str>,
    ) {
        self.identity.set_name_binding(
            terminal_id,
            Some(name_ref.clone()),
            naming_handle.map(str::to_string),
        );
    }

    fn name_ref_of(&self, terminal_id: &str) -> Option<SessionNameRef> {
        self.identity.name_ref_for(terminal_id)
    }

    fn naming_handle_of(&self, terminal_id: &str) -> Option<String> {
        self.identity.naming_handle_of(terminal_id)
    }

    fn durable_session_of(&self, terminal_id: &str) -> Option<(String, String)> {
        self.identity
            .session_ref_for(terminal_id)
            .map(|locator| (locator.provider, locator.session_id))
    }
}

/// `getModeLabel` from a mode and the registered CLI specs (the same label
/// `terminal.rs`'s `mode_label` reads off a resolved launch): `"Shell"` for
/// shell, the spec label otherwise, else the capitalized mode.
pub fn mode_title(cli_commands: &[freshell_platform::CliCommandSpec], mode: &str) -> String {
    if mode == "shell" {
        return "Shell".to_string();
    }
    match cli_commands.iter().find(|spec| spec.name == mode) {
        Some(spec) if !spec.label.is_empty() => spec.label.clone(),
        _ => {
            let mut chars = mode.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        }
    }
}

/// The WebSocket door's naming authority and identity table.
fn door(state: &WsState) -> (Option<Arc<dyn SessionNaming>>, IdentityNameBinder) {
    (
        state.identity.naming(),
        IdentityNameBinder::new(state.identity.clone()),
    )
}

/// Bind one WebSocket-side terminal row through the shared helper.
pub(crate) async fn bind_ws_terminal_naming(
    state: &WsState,
    terminal_id: &str,
    hint: NamingBindHint,
) -> NamingBindOutcome {
    let (sink, binder) = door(state);
    bind_terminal_naming_from_identity(sink.as_ref(), &state.registry, &binder, terminal_id, hint)
        .await
}

/// Bind a managed facade row the supervisor just handed back (reconcile or
/// compatibility adoption after a web restart): the soul's native session
/// is the durable target when it has one. A zero-turn soul's native session
/// may be prospective (Claude's preallocated `--session-id`) with no record
/// yet; `naming_handle`, the pane's persisted pre-durable handle, then lets
/// the row rejoin the pending record that holds the pane's name.
pub(crate) async fn bind_adopted_managed_row(
    state: &WsState,
    descriptor: &freshell_terminal::registry::ManagedTerminalDescriptor,
    naming_handle: Option<String>,
) -> NamingBindOutcome {
    let hint = NamingBindHint {
        mode: descriptor.mode.clone(),
        cwd: Some(descriptor.cwd.clone()),
        resume_session_id: descriptor.resume_session_id.clone(),
        naming_handle,
        fallback_title: mode_title(&state.cli_commands, &descriptor.mode),
    };
    bind_ws_terminal_naming(state, &descriptor.terminal_id, hint).await
}

/// A terminal's naming handle while its binding is STILL that pending
/// handle (not yet transferred onto a durable session). A transferred
/// handle is spent — it resolves to the old session's record — so it is
/// never answered. Retired identities still answer (a crashed row's).
pub(crate) fn still_pending_handle(state: &WsState, terminal_id: &str) -> Option<String> {
    match state.identity.name_ref_for(terminal_id) {
        Some(SessionNameRef::Pending { id }) => Some(id),
        _ => None,
    }
}

/// The reconcile pre-pass's managed adoption: reconstruct the supervisor's
/// facade for `terminal_id` (titled by its mode, never "Shell") and bind its
/// saved name. `naming_handle` is the pane's persisted pre-durable handle
/// (the reconcile entry's): a zero-turn soul's native session has no record
/// yet, and its name still lives under that handle. Answers whether a
/// managed row now exists for the id.
pub(crate) async fn adopt_managed_row_for_reconcile(
    state: &WsState,
    terminal_id: &str,
    create_request_id: Option<String>,
    naming_handle: Option<String>,
) -> Result<bool, String> {
    let adopted = state
        .registry
        .adopt_managed_for_reconcile(terminal_id, create_request_id, |mode| {
            mode_title(&state.cli_commands, mode)
        })
        .await?;
    if adopted {
        if let Some(descriptor) = state.registry.managed_descriptor(terminal_id) {
            bind_adopted_managed_row(state, &descriptor, naming_handle).await;
        }
    }
    Ok(adopted)
}

/// The conversation-switch follow-up: call right after an identity upsert
/// that may have retargeted this terminal onto a new durable session. The
/// registry binding follows the identity ref and the row adopts the new
/// session's record (or its mode label when none exists yet).
pub async fn follow_identity_switch(state: &WsState, terminal_id: &str) {
    let Some(mode) = state.registry.mode_of(terminal_id) else {
        return;
    };
    let (sink, binder) = door(state);
    let fallback = mode_title(&state.cli_commands, &mode);
    follow_identity_name_ref(
        sink.as_ref(),
        &state.registry,
        &binder,
        terminal_id,
        &fallback,
    )
    .await;
}

/// One reconcile pass over every terminal row (the tick's body; `pub` so
/// tests drive it deterministically). `tick` is the memory the passes share
/// (the empty-answer back-off).
pub async fn reconcile_terminal_naming(
    state: &WsState,
    tick: &TerminalNamesTick,
) -> TerminalNamesReconcile {
    let (sink, binder) = door(state);
    let cli_commands = Arc::clone(&state.cli_commands);
    let label = move |mode: &str| mode_title(&cli_commands, mode);
    reconcile_terminal_names(sink.as_ref(), &state.registry, &binder, &label, tick).await
}

/// Spawned once by `freshell-server` boot: the 2 s terminal-naming reconcile
/// tick (moved bindings, unbound scoped rows, empty name caches).
pub fn spawn_terminal_naming_reconcile(state: WsState) {
    tokio::spawn(async move {
        let memory = TerminalNamesTick::default();
        let mut tick = tokio::time::interval(RECONCILE_INTERVAL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            let report = reconcile_terminal_naming(&state, &memory).await;
            if report != TerminalNamesReconcile::default() {
                tracing::info!(
                    target: "freshell_ws::naming",
                    moved = report.moved,
                    bound = report.bound,
                    filled = report.filled,
                    "session_names.terminal_naming_reconciled"
                );
            }
        }
    });
}

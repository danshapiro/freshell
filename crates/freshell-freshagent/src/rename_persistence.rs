//! Task 16 (`PATCH /api/panes/:id`, kills D10): the syncable-terminal rename
//! persistence seam + the best-effort cascade
//! (`persistSyncableTerminalRename`, `server/agent-api/router.ts:649-693`).
//!
//! The trait is the `configStore` seam: `freshell-server`'s `main.rs`
//! implements it over the live settings store (`patch_terminal_override` /
//! `patch_session_override`) and injects it via
//! [`crate::FreshAgentState::with_rename_persistence`]. `None` == Node's own
//! `!configStore` guard (`router.ts:668`): the rename itself still lands in
//! the layout store, only the persistence cascade is skipped.

use std::sync::atomic::Ordering;

use serde_json::{json, Value};

use crate::layout_store::PaneSnapshot;
use crate::FreshAgentState;

/// The one boxed-future alias this crate's object-safe persistence seam needs.
pub type BoxFuture<T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send>>;

/// `configStore`'s two `persistSyncableTerminalRename` writes
/// (`router.ts:681-683`), as an injectable seam so this crate never depends on
/// `freshell-server`'s settings store. Both are best-effort: implementations
/// swallow their own IO failures (the store's writes are themselves
/// best-effort), matching the original's try/catch semantics.
pub trait RenamePersistence: Send + Sync {
    /// `configStore.patchTerminalOverride(terminalId, {titleOverride})` (`router.ts:681`).
    fn patch_terminal_override_title(&self, terminal_id: &str, title: &str) -> BoxFuture<()>;
    /// key = "provider:sessionId". The write is a USER rename: the live
    /// implementation (`main.rs::SettingsRenamePersistence`) finalizes
    /// `titleSource:'user'` alongside the title — a deliberate divergence
    /// from Node's plain `{titleOverride}` patch
    /// (persistSyncableTerminalRename, router.ts:679-681), ledgered as
    /// EDEV-10: an unfinalized rung lets the auto-title sweep's
    /// first-message pass permanently steal a rename that lands before the
    /// session finalizes.
    fn patch_session_override_title(&self, key: &str, title: &str) -> BoxFuture<()>;
}

/// `SYNCABLE_TERMINAL_MODES` (`server/agent-api/router.ts:57-63`): the coding-CLI
/// terminal modes whose pane rename cascades into terminal/session overrides.
pub const SYNCABLE_TERMINAL_MODES: [&str; 5] = ["claude", "codex", "opencode", "gemini", "kimi"];

/// `persistSyncableTerminalRename(paneSnapshot, title)` (`router.ts:649-693`):
/// the best-effort cascade run after a successful pane rename. Reads the
/// PRE-rename [`PaneSnapshot`]; every step is best-effort (nothing here can
/// fail the already-committed rename).
///
/// Provider+sessionId resolution is REGISTRY-FIRST (Node's preference order,
/// `router.ts:658-676`; validator-A10): the terminal registry's session
/// binding — the metadata a locator association writes back server-side with
/// zero client involvement — wins over paneContent's `resumeSessionId`.
/// Additionally this port reads `paneContent.sessionRef` as an EXPLICIT
/// intentional superset (Node never reads sessionRef, `router.ts:655`/`:676`)
/// — ledgered as EDEV-11 in `port/oracle/DEVIATIONS.md`.
pub(crate) async fn persist_syncable_terminal_rename(
    state: &FreshAgentState,
    snapshot: &PaneSnapshot,
    title: &str,
) {
    // Node gates the WHOLE cascade on `configStore` being present
    // (`router.ts:668`): unwired persistence == no cascade.
    let Some(persistence) = state.rename_persistence.as_ref() else {
        return;
    };
    let Some(terminal_id) = snapshot.terminal_id.as_deref() else {
        return;
    };
    let pane_content = snapshot.pane_content.as_ref();
    let pane_mode = pane_content
        .and_then(|content| content.get("mode"))
        .and_then(Value::as_str);

    // The registry's live (mode, resume/session id) binding for this terminal
    // — the `terminalMetadata`/`registry.get(tid)` equivalent (validator-A10).
    let binding = state
        .terminal_registry
        .as_ref()
        .and_then(|registry| registry.session_binding_of(terminal_id));

    // `modeCandidates` (`router.ts:659-666`): paneContent.mode → registry mode;
    // first candidate in SYNCABLE_TERMINAL_MODES wins, else no cascade.
    let Some(mode) = pane_mode
        .into_iter()
        .chain(binding.as_ref().map(|(mode, _)| mode.as_str()))
        .find(|candidate| SYNCABLE_TERMINAL_MODES.contains(candidate))
        .map(str::to_string)
    else {
        return;
    };

    // `patchTerminalOverride` → `registry.updateTitle` (`router.ts:681-682`).
    persistence
        .patch_terminal_override_title(terminal_id, title)
        .await;
    if let Some(registry) = state.terminal_registry.as_ref() {
        registry.update_title(terminal_id, title);
    }

    // provider+sessionId (`router.ts:676-677`): registry binding first, then
    // paneContent.resumeSessionId, then the sessionRef superset (EDEV-11).
    let registry_session = binding
        .and_then(|(_, session_id)| session_id)
        .map(|session_id| (mode.clone(), session_id));
    let resume_session = pane_content
        .and_then(|content| content.get("resumeSessionId"))
        .and_then(Value::as_str)
        .map(|session_id| (mode.clone(), session_id.to_string()));
    let session_ref = pane_content
        .and_then(|content| content.get("sessionRef"))
        .and_then(|locator| {
            Some((
                locator.get("provider")?.as_str()?.to_string(),
                locator.get("sessionId")?.as_str()?.to_string(),
            ))
        });
    if let Some((provider, session_id)) = registry_session.or(resume_session).or(session_ref) {
        // `makeSessionKey(provider, sessionId)` = "provider:sessionId".
        persistence
            .patch_session_override_title(&format!("{provider}:{session_id}"), title)
            .await;
    }

    // `wsHandler.broadcastTerminalsChanged()` (`router.ts:690`) — bump the
    // SHARED handler-scoped revision + send, same wire shape as
    // `crates/freshell-server/src/terminals.rs:1057-1061`.
    match state.terminals_revision.as_ref() {
        Some(counter) => {
            let revision = counter.fetch_add(1, Ordering::SeqCst) + 1;
            let frame = json!({ "type": "terminals.changed", "revision": revision }).to_string();
            let _ = state.broadcast_tx.send(frame);
        }
        None => tracing::warn!(
            terminal_id,
            "pane rename cascade: terminals_revision unwired; skipping terminals.changed broadcast"
        ),
    }
}

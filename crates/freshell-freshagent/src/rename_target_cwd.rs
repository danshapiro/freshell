//! Name-reliability Task 4 (LB-B8): the best-known folder of a pane rename's
//! target, so an automation rename to the target's own folder name is
//! classified as a derived label (and refused) by the naming store.
//!
//! A terminal pane's folder is its terminal row's cwd (the shared registry);
//! a fresh-agent pane's is the folder its session was created in (the pane
//! content's `initialCwd`). `None` when neither is known: the store then
//! recognizes folder-free labels only.

use serde_json::Value;

use crate::FreshAgentState;

/// The folder a rename through the pane (or its tab) should be classified
/// with.
pub(crate) fn pane_rename_cwd(state: &FreshAgentState, pane_id: &str) -> Option<String> {
    let snapshot = state.layout.get_pane_snapshot(pane_id)?;
    let content = snapshot.pane_content.as_ref()?;
    content_rename_cwd(state, content)
}

fn content_rename_cwd(state: &FreshAgentState, content: &Value) -> Option<String> {
    let from_terminal = content
        .get("terminalId")
        .and_then(Value::as_str)
        .and_then(|terminal_id| {
            state
                .terminal_registry
                .as_ref()
                .and_then(|registry| registry.probe(terminal_id))
                .and_then(|row| row.cwd)
        });
    from_terminal
        .or_else(|| {
            content
                .get("initialCwd")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .filter(|cwd| !cwd.trim().is_empty())
}

//! Carry a REST-driven conversation rekey into its headless pane identity.

use crate::{FreshAgentState, PaneEntry};

impl FreshAgentState {
    pub(crate) fn reconcile_rest_send_session(
        &self,
        pane_id: &str,
        accepted: &PaneEntry,
        before: &str,
        after: &str,
    ) {
        if before == after || after.is_empty() {
            return;
        }
        let updated = self.layout.rekey_agent_pane_if_current(
            pane_id,
            &accepted.provider,
            &accepted.session_type,
            before,
            after,
        );
        tracing::info!(
            event = "freshagent.rest_lane.send_identity",
            pane_id,
            provider = accepted.provider,
            before,
            after,
            layout_updated = updated
        );
        if !updated && self.layout.get_pane_snapshot(pane_id).is_some() {
            return;
        }
        let mut panes = self.panes.lock().expect("panes mutex");
        if let Some(pane) = panes.get_mut(pane_id).filter(|pane| {
            pane.provider == accepted.provider
                && pane.session_type == accepted.session_type
                && pane.durable_id.as_deref().unwrap_or(&pane.placeholder_id) == before
        }) {
            pane.placeholder_id = after.into();
            pane.durable_id = Some(after.into());
        }
    }
}

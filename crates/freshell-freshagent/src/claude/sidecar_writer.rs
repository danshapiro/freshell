//! A failed stdin write ends only the runtime that owned that writer. Keep its
//! session registered until stdout EOF performs normal death/attention handling.

use super::FreshClaudeState;

impl FreshClaudeState {
    pub(super) fn watch_writer_failure(
        &self,
        map_key: &str,
        ownership_id: &str,
        fault: tokio::sync::oneshot::Receiver<String>,
    ) {
        let state = self.clone();
        let map_key = map_key.to_string();
        let ownership_id = ownership_id.to_string();
        tokio::spawn(async move {
            let Ok(cause) = fault.await else { return };
            let mut sessions = state.sessions.lock().await;
            let Some(session) = sessions
                .get_mut(&map_key)
                .filter(|session| session.ownership_id == ownership_id)
            else {
                return;
            };
            let result = session.child.start_kill();
            tracing::warn!(provider = "claude", session_id = %map_key,
                ownership_id = %ownership_id, cause = %cause,
                kill_error = result.err().map(|error| error.to_string()),
                "freshagent.claude.sidecar_writer_ended_runtime");
        });
    }
}

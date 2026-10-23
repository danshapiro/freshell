//! Durable one-shot notice for a freshclaude turn stopped by server restart.

use super::{FreshClaudeState, PROVIDER};
use std::time::Duration;

const SHUTDOWN_MARK_BUDGET: Duration = Duration::from_millis(500);
const RESTART_INTERRUPTED_CODE: &str = "TURN_INTERRUPTED_BY_RESTART";
const RESTART_INTERRUPTED_MESSAGE: &str =
    "The server restarted while this turn was running. The turn was stopped. Send a message to continue.";

impl FreshClaudeState {
    /// Persist an owed turn before its live sidecar is torn down. Shutdown
    /// cannot wait indefinitely on disk I/O, so a slow or failed marker write
    /// is logged and the server continues stopping.
    pub(super) async fn mark_turn_interrupted_for_shutdown(&self, session_id: &str) {
        let Some(sink) = self.identity_sink() else {
            return;
        };
        let at_ms = crate::rollback_record::now_ms();
        match tokio::time::timeout(
            SHUTDOWN_MARK_BUDGET,
            sink.mark_turn_interrupted(PROVIDER, session_id, at_ms),
        )
        .await
        {
            Ok(Ok(true)) => tracing::info!(
                target: "freshell_freshagent::claude",
                event = "freshagent.claude.restart_interrupt_persisted",
                session_id,
                at_ms,
                "an owed turn was recorded for the next attach"
            ),
            Ok(Ok(false)) => tracing::warn!(
                target: "freshell_freshagent::claude",
                event = "freshagent.claude.restart_interrupt_row_missing",
                session_id,
                "an owed turn had no bound fresh-agent row for its restart marker"
            ),
            Ok(Err(error)) => tracing::error!(
                target: "freshell_freshagent::claude",
                event = "freshagent.claude.restart_interrupt_persist_failed",
                session_id,
                error = %error,
                "the restart interruption marker could not be persisted"
            ),
            Err(_) => tracing::error!(
                target: "freshell_freshagent::claude",
                event = "freshagent.claude.restart_interrupt_persist_timed_out",
                session_id,
                budget_ms = SHUTDOWN_MARK_BUDGET.as_millis() as u64,
                "the restart interruption marker exceeded its shutdown budget"
            ),
        }
    }

    /// Consume and report the marker only after the create/attach acknowledgement
    /// has been sent. The ledger serializes the consume, so concurrent
    /// acknowledgements can produce at most one notice.
    pub(super) async fn notify_turn_interrupted_after_ack(
        &self,
        session_id: &str,
        session_type: &str,
    ) {
        let Some(sink) = self.identity_sink() else {
            return;
        };
        match sink.take_turn_interrupted(PROVIDER, session_id).await {
            Ok(Some(at_ms)) => {
                self.emit_fresh_agent_error(
                    session_id,
                    session_type,
                    RESTART_INTERRUPTED_CODE,
                    RESTART_INTERRUPTED_MESSAGE,
                );
                tracing::info!(
                    target: "freshell_freshagent::claude",
                    event = "freshagent.claude.restart_interrupt_notified",
                    session_id,
                    interrupted_at_ms = at_ms,
                    "the interrupted-turn notice followed a successful acknowledgement"
                );
            }
            Ok(None) => {}
            Err(error) => tracing::error!(
                target: "freshell_freshagent::claude",
                event = "freshagent.claude.restart_interrupt_consume_failed",
                session_id,
                error = %error,
                "the restart interruption marker was retained for a later acknowledgement"
            ),
        }
    }
}

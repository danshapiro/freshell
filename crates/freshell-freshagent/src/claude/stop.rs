//! The user's Stop (core-runtime design §5.4, C18; G03, G06): the latch lives in
//! the session's turn ledger (`claude_turns.rs`), and this side writes the
//! interrupts it asks for.
//!
//! Every interrupt carries a `stopId` the sidecar echoes on its receipt
//! (`sdk.interrupt_settled`), so the latch reads only its own receipt. Each Stop
//! decision is logged as `freshagent.claude.stop` at info: `sent` (with its
//! target), `idle` (nothing owed, nothing sent), `reissued` (with the re-send
//! case and count), `unsent` (the write failed) and `refused` (the CLI refused).

use serde_json::json;

use super::{FreshClaudeState, PROVIDER};
use crate::claude_turns::StopReissue;

const TARGET: &str = "freshell_freshagent::claude";

impl FreshClaudeState {
    /// Stop the live session `map_key` (the body of [`Self::handle_interrupt`]).
    /// Returns `false` when no live session is registered under it.
    pub(super) async fn stop_live_session(
        &self,
        map_key: &str,
        session_type: &str,
        request_id: &Option<String>,
    ) -> bool {
        let mut sessions = self.sessions.lock().await;
        let Some(session) = sessions.get_mut(map_key) else {
            return false;
        };
        let stamp = session.identity.current();
        let stop_id = uuid::Uuid::new_v4().to_string();
        // Latched under the ledger lock before the write: the receipt and the
        // stopped turn's result can come back before this task runs again.
        let armed = session
            .ledger
            .lock()
            .expect("turn ledger lock")
            .stop(stop_id.clone(), request_id.clone());
        let Some(armed) = armed else {
            tracing::info!(target: TARGET, provider = PROVIDER, session_id = %stamp,
                session_type, outcome = "idle",
                "freshagent.claude.stop");
            return true;
        };
        tracing::info!(target: TARGET, provider = PROVIDER, session_id = %stamp,
            session_type, stop_id = %stop_id, outcome = "sent",
            target = armed.target.as_str(), commands = ?armed.commands,
            "freshagent.claude.stop");
        // Address the sidecar by ITS id for this session (== the map key for
        // created sessions; differs for resumed-on-attach sessions, Task 6).
        let request = json!({
            "type": "interrupt",
            "sessionId": session.sidecar_session_id,
            "stopId": stop_id,
        });
        let writer = session.stdin.clone();
        let ledger = session.ledger.clone();
        drop(sessions);
        if let Err(error) = writer.write(&request).await {
            ledger
                .lock()
                .expect("turn ledger lock")
                .stop_unsent(&stop_id);
            tracing::warn!(target: TARGET, provider = PROVIDER, session_id = %stamp,
                session_type, stop_id = %stop_id, outcome = "unsent", cause = %error,
                "freshagent.claude.stop");
            self.emit_stop_failure(&stamp, session_type, request_id, &error);
        }
        true
    }

    /// Send a latched Stop again (design §5.4): it missed a command the CLI was
    /// still starting, which now runs. Written only to the incarnation that
    /// asked (`ownership_id`): recovery reuses the durable session id but gives
    /// the replacement process a different ownership id.
    pub(super) async fn reissue_stop(
        &self,
        map_key: &str,
        ownership_id: &str,
        stamp: &str,
        session_type: &str,
        reissue: &StopReissue,
    ) {
        tracing::info!(target: TARGET, provider = PROVIDER, session_id = %stamp,
            session_type, stop_id = %reissue.stop_id, outcome = "reissued",
            case = reissue.case.as_str(), target = %reissue.target,
            reissues = reissue.reissues,
            "freshagent.claude.stop");
        let mut sessions = self.sessions.lock().await;
        let Some(session) = sessions
            .get_mut(map_key)
            .filter(|session| session.ownership_id == ownership_id)
        else {
            return;
        };
        let request = json!({
            "type": "interrupt",
            "sessionId": session.sidecar_session_id,
            "stopId": reissue.reissue_id,
        });
        let writer = session.stdin.clone();
        let ledger = session.ledger.clone();
        drop(sessions);
        if let Err(error) = writer.write(&request).await {
            ledger
                .lock()
                .expect("turn ledger lock")
                .stop_unsent(&reissue.stop_id);
            tracing::warn!(target: TARGET, provider = PROVIDER, session_id = %stamp,
                session_type, stop_id = %reissue.stop_id, outcome = "unsent",
                cause = %error,
                "freshagent.claude.stop");
            self.emit_stop_failure(stamp, session_type, &reissue.request_id, &error);
        }
    }

    /// The CLI refused the latched Stop's interrupt: the latch is disarmed and
    /// the turn keeps running (it rings when it ends).
    pub(super) fn report_stop_refused(
        &self,
        stamp: &str,
        session_type: &str,
        stop_id: &str,
        request_id: &Option<String>,
        message: &str,
    ) {
        tracing::warn!(target: TARGET, provider = PROVIDER, session_id = %stamp,
            session_type, stop_id = %stop_id, outcome = "refused",
            "freshagent.claude.stop");
        self.emit_stop_failure(stamp, session_type, request_id, message);
    }

    fn emit_stop_failure(
        &self,
        stamp: &str,
        session_type: &str,
        request_id: &Option<String>,
        message: &str,
    ) {
        let kind = if session_type == "kilroy" {
            freshell_protocol::SessionType::Kilroy
        } else {
            freshell_protocol::SessionType::Freshclaude
        };
        self.emit_control_error(stamp, kind, request_id, "CLAUDE_INTERRUPT_FAILED", message);
    }
}

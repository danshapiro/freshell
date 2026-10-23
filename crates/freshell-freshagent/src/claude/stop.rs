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

use super::{write_line, FreshClaudeState, PROVIDER};
use crate::claude_turns::StopReissue;

const TARGET: &str = "freshell_freshagent::claude";

impl FreshClaudeState {
    /// Stop the live session `map_key` (the body of [`Self::handle_interrupt`]).
    /// Returns `false` when no live session is registered under it.
    pub(super) async fn stop_live_session(&self, map_key: &str, session_type: &str) -> bool {
        let mut sessions = self.sessions.lock().await;
        let Some(session) = sessions.get_mut(map_key) else {
            return false;
        };
        let stamp = session
            .broadcast_id
            .lock()
            .expect("broadcast id lock")
            .clone();
        let stop_id = uuid::Uuid::new_v4().to_string();
        // Latched under the ledger lock before the write: the receipt and the
        // stopped turn's result can come back before this task runs again.
        let armed = session
            .ledger
            .lock()
            .expect("turn ledger lock")
            .stop(stop_id.clone());
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
        if let Err(error) = write_line(&mut session.stdin, &request).await {
            session
                .ledger
                .lock()
                .expect("turn ledger lock")
                .stop_unsent(&stop_id);
            drop(sessions);
            tracing::warn!(target: TARGET, provider = PROVIDER, session_id = %stamp,
                session_type, stop_id = %stop_id, outcome = "unsent", cause = %error,
                "freshagent.claude.stop");
            self.send_error(&None, "CLAUDE_INTERRUPT_FAILED", &error);
        }
        true
    }

    /// Send a latched Stop again (design §5.4): it missed a command the CLI was
    /// still starting, which now runs. Written only to the incarnation that
    /// asked (`sidecar_session_id`): a session re-registered under the same key
    /// since is not this Stop's.
    pub(super) async fn reissue_stop(
        &self,
        map_key: &str,
        sidecar_session_id: &str,
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
            .filter(|session| session.sidecar_session_id == sidecar_session_id)
        else {
            return;
        };
        let request = json!({
            "type": "interrupt",
            "sessionId": sidecar_session_id,
            "stopId": reissue.reissue_id,
        });
        if let Err(error) = write_line(&mut session.stdin, &request).await {
            tracing::warn!(target: TARGET, provider = PROVIDER, session_id = %stamp,
                session_type, stop_id = %reissue.stop_id, outcome = "unsent",
                cause = %error,
                "freshagent.claude.stop");
        }
    }

    /// The CLI refused the latched Stop's interrupt: the latch is disarmed and
    /// the turn keeps running (it rings when it ends).
    pub(super) fn log_stop_refused(&self, stamp: &str, session_type: &str, stop_id: &str) {
        tracing::warn!(target: TARGET, provider = PROVIDER, session_id = %stamp,
            session_type, stop_id = %stop_id, outcome = "refused",
            "freshagent.claude.stop");
    }
}

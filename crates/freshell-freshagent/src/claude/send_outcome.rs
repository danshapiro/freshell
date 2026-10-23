//! What a claude send answered (core-runtime design §9.3, I2), and how a send the
//! sidecar refused is taken back (C16).
//!
//! [`FreshClaudeState::handle_send`] answers every send on the WS bus
//! (`freshAgent.send.accepted`, or a request `error`) and also returns the answer
//! as a [`ClaudeSendOutcome`], so an in-process caller (the REST/MCP agent API) can
//! act on it without reading the bus. A refusal's request error is sent by
//! [`FreshClaudeState::refuse_send`], which builds the outcome from the same code
//! and message, so the two never disagree; the WS dispatcher ignores the value.

use std::sync::atomic::Ordering;

use super::{retire_rejected_send, FreshClaudeState, TurnTracker, PROVIDER};
use crate::claude_turns::SendRejection;

/// The code a sender sees for a send the sidecar refused (`sdk.send.rejected`).
const SEND_REJECTED: &str = "CLAUDE_SEND_REJECTED";

/// The answer to one claude `freshAgent.send`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaudeSendOutcome {
    /// The sidecar has the message (`freshAgent.send.accepted` was broadcast).
    Accepted {
        /// The id of the live session the message went to (the sessions-map key; a
        /// send that waited behind an undo goes to the replacement).
        session_key: String,
        /// The uuid the message runs under: the turn id its user line lands with.
        submitted_turn_id: String,
    },
    /// The message was not sent; the sender got a request error with this code.
    Refused { code: String, message: String },
}

impl FreshClaudeState {
    /// Refuse a send: the request error the sender sees, and the same refusal as
    /// the outcome.
    pub(super) fn refuse_send(
        &self,
        request_id: &Option<String>,
        code: &str,
        message: &str,
    ) -> ClaudeSendOutcome {
        self.send_error(request_id, code, message);
        ClaudeSendOutcome::Refused {
            code: code.to_string(),
            message: message.to_string(),
        }
    }

    /// Whether the live session `id` (its pane id or its durable id) is working on
    /// a turn; `None` when no live session answers to it (an unknown id, or a
    /// session that ended).
    pub async fn session_busy(&self, id: &str) -> Option<bool> {
        let key = self.resolve_session_key(id).await?;
        let sessions = self.sessions.lock().await;
        let session = sessions.get(&key)?;
        Some(session.in_turn.load(Ordering::SeqCst))
    }

    /// The sidecar refused a send before the CLI saw it (`sdk.send.rejected`, for
    /// example an image Claude cannot read); the session lives on. Take the send
    /// back: retire the op it armed, so the session is not left busy waiting for a
    /// turn that never runs, and tell the sender. A send with a request gets the
    /// request error the client's owned-send path turns into "Message not sent:
    /// <reason>" with the text back in the composer; a compact (no request) gets a
    /// nested `freshAgent.error` on the session. A uuid this session does not
    /// remember is logged and changes nothing.
    pub(super) fn take_back_rejected_send(
        &self,
        in_turn: &std::sync::atomic::AtomicBool,
        turn_tracker: &std::sync::Mutex<TurnTracker>,
        session_id: &str,
        session_type: &str,
        rejection: &SendRejection,
    ) {
        let SendRejection {
            uuid,
            code,
            message,
        } = rejection;
        let uuid = uuid.as_deref();
        let send = uuid.and_then(|uuid| retire_rejected_send(in_turn, turn_tracker, uuid));
        let Some(send) = send else {
            tracing::warn!(target: "freshell_freshagent::claude",
                provider = PROVIDER, session_id, session_type, uuid, code = %code,
                event = "freshagent.claude.send_rejected",
                known = false,
                "the sidecar rejected a send this session does not remember");
            return;
        };
        tracing::warn!(target: "freshell_freshagent::claude",
            provider = PROVIDER, session_id, session_type, uuid = %send.uuid,
            request_id = send.request_id.as_deref(), kind = send.kind.as_str(), code = %code,
            busy = in_turn.load(Ordering::SeqCst),
            event = "freshagent.claude.send_rejected",
            known = true,
            "the sidecar rejected a send; it is taken back");
        match send.request_id {
            Some(request_id) => self.send_error(&Some(request_id), SEND_REJECTED, message),
            None => self.emit_fresh_agent_error(session_id, session_type, SEND_REJECTED, message),
        }
    }
}

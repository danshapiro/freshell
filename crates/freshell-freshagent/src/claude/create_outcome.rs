//! What a claude create answered (core-runtime design §9.3, I1).
//!
//! [`FreshClaudeState::handle_create`] answers every create on the WS bus
//! (`freshAgent.created` or `freshAgent.create.failed`) and also returns the
//! answer as a [`ClaudeCreateOutcome`], so an in-process caller (the REST/MCP agent
//! API) can act on it without reading the bus. A failed create's frame is built
//! from its outcome, so the two can never disagree; the WS dispatcher ignores the
//! value.

use freshell_protocol::{FreshAgentCreateFailed, ServerMessage, SessionLocator};

use crate::ownership_lane::TerminalOwnerFields;

/// The answer to one claude `freshAgent.create`.
#[derive(Debug, Clone, PartialEq)]
pub enum ClaudeCreateOutcome {
    /// A session runs: the one this create started, or the live one it adopted.
    Created {
        /// The id the pane addresses the session by (`freshAgent.created.sessionId`).
        session_id: String,
        /// The durable conversation, when known (a resume or an adopted session).
        session_ref: Option<SessionLocator>,
    },
    /// No session runs for this create.
    Failed {
        code: String,
        message: String,
        /// `Some(true)` when the client should retry the same create.
        retryable: Option<bool>,
        /// The runtime that owns the session instead, when the refusal names one.
        owner: Option<TerminalOwnerFields>,
    },
}

impl ClaudeCreateOutcome {
    /// The `freshAgent.create.failed` frame answering `request_id` for a failed
    /// create; `None` for a created one.
    pub(super) fn create_failed_frame(&self, request_id: &str) -> Option<ServerMessage> {
        let Self::Failed {
            code,
            message,
            retryable,
            owner,
        } = self
        else {
            return None;
        };
        Some(ServerMessage::FreshAgentCreateFailed(
            FreshAgentCreateFailed {
                owner_kind: owner.as_ref().map(|o| o.owner_kind.to_string()),
                owner_generation: owner.as_ref().map(|o| o.owner_generation),
                owner_epoch: owner.as_ref().map(|o| o.owner_epoch),
                code: code.clone(),
                message: message.clone(),
                request_id: request_id.to_string(),
                retryable: *retryable,
            },
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failed_outcome_is_its_create_failed_frame() {
        let refused = ClaudeCreateOutcome::Failed {
            code: "SESSION_RESERVED".into(),
            message: "Another resume for this session is in flight".into(),
            retryable: Some(true),
            owner: Some(TerminalOwnerFields {
                owner_kind: "terminal",
                owner_generation: 4,
                owner_epoch: 9,
            }),
        };
        assert_eq!(
            serde_json::to_value(refused.create_failed_frame("req-1").unwrap()).unwrap(),
            serde_json::json!({
                "type": "freshAgent.create.failed",
                "code": "SESSION_RESERVED",
                "message": "Another resume for this session is in flight",
                "requestId": "req-1",
                "retryable": true,
                "ownerKind": "terminal",
                "ownerGeneration": 4,
                "ownerEpoch": 9,
            })
        );

        // No retry hint and no owner: neither key is on the wire.
        let failed = ClaudeCreateOutcome::Failed {
            code: "CLAUDE_CREATE_FAILED".into(),
            message: "boom".into(),
            retryable: None,
            owner: None,
        };
        assert_eq!(
            serde_json::to_value(failed.create_failed_frame("req-2").unwrap()).unwrap(),
            serde_json::json!({
                "type": "freshAgent.create.failed",
                "code": "CLAUDE_CREATE_FAILED",
                "message": "boom",
                "requestId": "req-2",
            })
        );

        let created = ClaudeCreateOutcome::Created {
            session_id: "s".into(),
            session_ref: None,
        };
        assert!(created.create_failed_frame("req-3").is_none());
    }
}

//! freshclaude turn accounting (docs/plans/2026-10-22-freshclaude-core-runtime.md
//! §3.2, §5.1, §5.2).
//!
//! C16: every send the server writes to the sidecar carries a uuid the server
//! minted ([`mint_send_uuid`]). The sidecar puts it on the SDKUserMessage, so the
//! CLI reports the command's lifecycle under it and writes the user line with it:
//! it is the turn id the snapshot shows and the `submittedTurnId` of
//! `freshAgent.send.accepted`. [`RecentSends`] remembers the recent sends, so a
//! fact the sidecar reports for one send (a rejection) finds the request that
//! made it. The sidecar forwards the CLI's lifecycle facts ([`SidecarFact`]);
//! they are never client content. Until the turn ledger folds them (C17) the
//! server logs them, and acts only on a rejected send.

use std::collections::VecDeque;

use serde_json::Value;

/// A fresh uuid for one send: the id the CLI keeps for the command and its user
/// line (the canonical lowercase v4 form, as the CLI writes it).
pub(crate) fn mint_send_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// What a send asks the CLI to do: run a turn, or compact (`/compact`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SendKind {
    Turn,
    Compact,
}

impl SendKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Turn => "turn",
            Self::Compact => "compact",
        }
    }
}

/// One send the server wrote to the sidecar.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SentCommand {
    /// The uuid the server minted for it ([`mint_send_uuid`]).
    pub(crate) uuid: String,
    /// The client request that made it (`None` for a compact, which has no ack).
    pub(crate) request_id: Option<String>,
    pub(crate) kind: SendKind,
}

/// The sends a session wrote most recently, by uuid. The sidecar answers a send
/// it refuses at once (`sdk.send.rejected`), so a short memory is enough; the
/// oldest send is forgotten first.
#[derive(Debug, Default)]
pub(crate) struct RecentSends {
    sends: VecDeque<SentCommand>,
}

impl RecentSends {
    /// How many sends are remembered.
    pub(crate) const LIMIT: usize = 64;

    /// Remember a send before it is written (the sidecar may answer it before
    /// the writer gets to run again).
    pub(crate) fn record(&mut self, send: SentCommand) {
        self.sends.retain(|known| known.uuid != send.uuid);
        self.sends.push_back(send);
        while self.sends.len() > Self::LIMIT {
            self.sends.pop_front();
        }
    }

    /// The send with this uuid, which is then forgotten.
    pub(crate) fn take(&mut self, uuid: &str) -> Option<SentCommand> {
        let at = self.sends.iter().position(|send| send.uuid == uuid)?;
        self.sends.remove(at)
    }

    /// Forget a send that was never written.
    pub(crate) fn forget(&mut self, uuid: &str) {
        self.take(uuid);
    }
}

/// A sent command's lifecycle state (`sdk.command`, T8). `Replayed` is the
/// sidecar's: the CLI took the command as a user message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CommandState {
    Queued,
    Started,
    Completed,
    Cancelled,
    Discarded,
    Replayed,
}

impl CommandState {
    fn parse(state: &str) -> Option<Self> {
        Some(match state {
            "queued" => Self::Queued,
            "started" => Self::Started,
            "completed" => Self::Completed,
            "cancelled" => Self::Cancelled,
            "discarded" => Self::Discarded,
            "replayed" => Self::Replayed,
            _ => return None,
        })
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Started => "started",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
            Self::Discarded => "discarded",
            Self::Replayed => "replayed",
        }
    }
}

/// Whether the CLI is working (`sdk.session.state`, T9).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SessionState {
    Running,
    Idle,
    RequiresAction,
}

impl SessionState {
    fn parse(state: &str) -> Option<Self> {
        Some(match state {
            "running" => Self::Running,
            "idle" => Self::Idle,
            "requires_action" => Self::RequiresAction,
            _ => return None,
        })
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Idle => "idle",
            Self::RequiresAction => "requires_action",
        }
    }
}

/// What a heartbeat reports progress on (`sdk.heartbeat`, T17).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HeartbeatKind {
    Tool,
    Task,
    Retry,
}

impl HeartbeatKind {
    fn parse(kind: &str) -> Option<Self> {
        Some(match kind {
            "tool" => Self::Tool,
            "task" => Self::Task,
            "retry" => Self::Retry,
            _ => return None,
        })
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Tool => "tool",
            Self::Task => "task",
            Self::Retry => "retry",
        }
    }
}

/// A send the sidecar refused before the CLI saw it (`sdk.send.rejected`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SendRejection {
    /// The uuid of the refused send (`None` when the send had no valid one).
    pub(crate) uuid: Option<String>,
    /// The sidecar's reason code (`INVALID_IMAGE`, `INVALID_SEND`).
    pub(crate) code: String,
    /// Why, in words the sender can read.
    pub(crate) message: String,
}

/// The reason a rejected send gives when the sidecar named none.
pub(crate) const REJECTED_SEND_FALLBACK_MESSAGE: &str =
    "Claude could not take this message. Send it again.";

/// A fact the sidecar forwards for the server's turn accounting (design §5.1).
/// None of these is client content: they are never broadcast.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SidecarFact {
    /// A sent command's lifecycle (`sdk.command`).
    Command { uuid: String, state: CommandState },
    /// The CLI started or stopped working (`sdk.session.state`).
    SessionState(SessionState),
    /// A model request started (`sdk.status requesting`): turn evidence.
    Requesting,
    /// A status ended (`sdk.status null`, T15): a compaction's outcome, or the
    /// permission mode the CLI is in now.
    StatusEnded {
        compact_result: Option<String>,
        compact_error: Option<String>,
        permission_mode: Option<String>,
    },
    /// Liveness (`sdk.heartbeat`).
    Heartbeat {
        kind: HeartbeatKind,
        tool_use_id: Option<String>,
        elapsed_ms: Option<u64>,
    },
    /// The sidecar refused a send before the CLI saw it (`sdk.send.rejected`).
    SendRejected(SendRejection),
}

impl SidecarFact {
    /// The fact a sidecar stdout line carries, if it carries one. A status the
    /// client shows (`compacting`, and the legacy `running`/`idle`) is not a
    /// fact here: it is still forwarded as content.
    pub(crate) fn from_line(line: &Value) -> Option<Self> {
        let text = |key: &str| line.get(key).and_then(Value::as_str).map(str::to_string);
        match line.get("type")?.as_str()? {
            "sdk.command" => Some(Self::Command {
                uuid: text("uuid")?,
                state: CommandState::parse(line.get("state")?.as_str()?)?,
            }),
            "sdk.session.state" => Some(Self::SessionState(SessionState::parse(
                line.get("state")?.as_str()?,
            )?)),
            "sdk.status" => match line.get("status")? {
                Value::Null => Some(Self::StatusEnded {
                    compact_result: text("compactResult"),
                    compact_error: text("compactError"),
                    permission_mode: text("permissionMode"),
                }),
                Value::String(status) if status == "requesting" => Some(Self::Requesting),
                _ => None,
            },
            "sdk.heartbeat" => Some(Self::Heartbeat {
                kind: HeartbeatKind::parse(line.get("kind")?.as_str()?)?,
                tool_use_id: text("toolUseId"),
                elapsed_ms: line
                    .get("elapsedMs")
                    .and_then(Value::as_f64)
                    .filter(|ms| ms.is_finite() && *ms >= 0.0)
                    .map(|ms| ms.round() as u64),
            }),
            "sdk.send.rejected" => Some(Self::SendRejected(SendRejection {
                uuid: text("uuid"),
                code: text("code").unwrap_or_else(|| "INVALID_SEND".to_string()),
                message: text("message")
                    .unwrap_or_else(|| REJECTED_SEND_FALLBACK_MESSAGE.to_string()),
            })),
            _ => None,
        }
    }

    /// Log a lifecycle fact at debug (ids and states only). A rejected send is
    /// logged where it is handled, with the request it takes back.
    pub(crate) fn log(&self, session_id: &str, session_type: &str) {
        const TARGET: &str = "freshell_freshagent::claude";
        match self {
            Self::Command { uuid, state } => tracing::debug!(target: TARGET,
                provider = "claude", session_id, session_type, uuid = %uuid,
                state = state.as_str(), "freshagent.claude.command"),
            Self::SessionState(state) => tracing::debug!(target: TARGET,
                provider = "claude", session_id, session_type, state = state.as_str(),
                "freshagent.claude.session_state"),
            Self::Requesting => tracing::debug!(target: TARGET,
                provider = "claude", session_id, session_type, status = "requesting",
                "freshagent.claude.status_fact"),
            Self::StatusEnded {
                compact_result,
                compact_error,
                permission_mode,
            } => tracing::debug!(target: TARGET,
                provider = "claude", session_id, session_type, status = "ended",
                compact_result = compact_result.as_deref(),
                compact_error = compact_error.as_deref(),
                permission_mode = permission_mode.as_deref(),
                "freshagent.claude.status_fact"),
            Self::Heartbeat {
                kind,
                tool_use_id,
                elapsed_ms,
            } => tracing::debug!(target: TARGET,
                provider = "claude", session_id, session_type, kind = kind.as_str(),
                tool_use_id = tool_use_id.as_deref(), elapsed_ms = *elapsed_ms,
                "freshagent.claude.heartbeat"),
            Self::SendRejected(_) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_send_uuid_is_a_fresh_v4_uuid() {
        let first = mint_send_uuid();
        let parsed = uuid::Uuid::parse_str(&first).expect("a uuid");
        assert_eq!(parsed.get_version_num(), 4);
        assert_eq!(
            first,
            parsed.hyphenated().to_string(),
            "the canonical lowercase form"
        );
        assert_ne!(first, mint_send_uuid());
    }

    fn sent(uuid: &str, kind: SendKind) -> SentCommand {
        SentCommand {
            uuid: uuid.to_string(),
            request_id: Some(format!("request-{uuid}")),
            kind,
        }
    }

    #[test]
    fn recent_sends_find_a_send_once_by_its_uuid() {
        let mut sends = RecentSends::default();
        sends.record(sent("a", SendKind::Turn));
        sends.record(sent("b", SendKind::Compact));
        assert_eq!(sends.take("b"), Some(sent("b", SendKind::Compact)));
        assert_eq!(sends.take("b"), None, "a send is found once");
        assert_eq!(sends.take("zzz"), None, "a uuid the server never sent");
        assert_eq!(sends.take("a"), Some(sent("a", SendKind::Turn)));
    }

    #[test]
    fn recent_sends_forget_the_oldest_beyond_their_limit() {
        let mut sends = RecentSends::default();
        for n in 0..=RecentSends::LIMIT {
            sends.record(sent(&n.to_string(), SendKind::Turn));
        }
        assert_eq!(sends.take("0"), None, "the oldest is forgotten");
        assert!(sends.take("1").is_some());
        assert!(sends.take(&RecentSends::LIMIT.to_string()).is_some());
    }

    #[test]
    fn a_forgotten_send_is_not_found() {
        let mut sends = RecentSends::default();
        sends.record(sent("a", SendKind::Turn));
        sends.forget("a");
        assert_eq!(sends.take("a"), None);
    }

    #[test]
    fn command_lifecycle_facts_parse() {
        for (state, expected) in [
            ("queued", CommandState::Queued),
            ("started", CommandState::Started),
            ("completed", CommandState::Completed),
            ("cancelled", CommandState::Cancelled),
            ("discarded", CommandState::Discarded),
            ("replayed", CommandState::Replayed),
        ] {
            assert_eq!(
                SidecarFact::from_line(&json!({
                    "type": "sdk.command", "sessionId": "s", "uuid": "u", "state": state,
                })),
                Some(SidecarFact::Command {
                    uuid: "u".into(),
                    state: expected,
                }),
            );
        }
        // A state this server does not know is not a fact it can fold.
        assert_eq!(
            SidecarFact::from_line(
                &json!({ "type": "sdk.command", "uuid": "u", "state": "paused" })
            ),
            None
        );
        assert_eq!(
            SidecarFact::from_line(&json!({ "type": "sdk.command", "state": "queued" })),
            None
        );
    }

    #[test]
    fn session_state_facts_parse() {
        for (state, expected) in [
            ("running", SessionState::Running),
            ("idle", SessionState::Idle),
            ("requires_action", SessionState::RequiresAction),
        ] {
            assert_eq!(
                SidecarFact::from_line(&json!({ "type": "sdk.session.state", "state": state })),
                Some(SidecarFact::SessionState(expected)),
            );
        }
        assert_eq!(
            SidecarFact::from_line(&json!({ "type": "sdk.session.state", "state": "asleep" })),
            None
        );
    }

    #[test]
    fn a_status_end_and_a_model_request_are_facts_but_the_statuses_clients_show_are_not() {
        assert_eq!(
            SidecarFact::from_line(&json!({
                "type": "sdk.status", "status": null, "compactResult": "failed",
                "compactError": "Not enough messages to compact.", "permissionMode": "plan",
            })),
            Some(SidecarFact::StatusEnded {
                compact_result: Some("failed".into()),
                compact_error: Some("Not enough messages to compact.".into()),
                permission_mode: Some("plan".into()),
            }),
        );
        assert_eq!(
            SidecarFact::from_line(&json!({ "type": "sdk.status", "status": null })),
            Some(SidecarFact::StatusEnded {
                compact_result: None,
                compact_error: None,
                permission_mode: None,
            }),
        );
        assert_eq!(
            SidecarFact::from_line(&json!({ "type": "sdk.status", "status": "requesting" })),
            Some(SidecarFact::Requesting),
        );
        for shown in ["compacting", "running", "idle"] {
            assert_eq!(
                SidecarFact::from_line(&json!({ "type": "sdk.status", "status": shown })),
                None,
                "{shown} is a status the client shows"
            );
        }
        assert_eq!(
            SidecarFact::from_line(&json!({ "type": "sdk.status" })),
            None
        );
    }

    #[test]
    fn heartbeat_facts_parse() {
        assert_eq!(
            SidecarFact::from_line(&json!({
                "type": "sdk.heartbeat", "kind": "tool", "toolUseId": "toolu_1", "elapsedMs": 30000,
            })),
            Some(SidecarFact::Heartbeat {
                kind: HeartbeatKind::Tool,
                tool_use_id: Some("toolu_1".into()),
                elapsed_ms: Some(30_000),
            }),
        );
        assert_eq!(
            SidecarFact::from_line(&json!({ "type": "sdk.heartbeat", "kind": "retry" })),
            Some(SidecarFact::Heartbeat {
                kind: HeartbeatKind::Retry,
                tool_use_id: None,
                elapsed_ms: None,
            }),
        );
        assert_eq!(
            SidecarFact::from_line(&json!({ "type": "sdk.heartbeat", "kind": "task" })),
            Some(SidecarFact::Heartbeat {
                kind: HeartbeatKind::Task,
                tool_use_id: None,
                elapsed_ms: None,
            }),
        );
        assert_eq!(
            SidecarFact::from_line(&json!({ "type": "sdk.heartbeat", "kind": "pulse" })),
            None
        );
    }

    #[test]
    fn a_rejected_send_parses_with_or_without_its_uuid() {
        assert_eq!(
            SidecarFact::from_line(&json!({
                "type": "sdk.send.rejected", "sessionId": "s", "uuid": "u",
                "code": "INVALID_IMAGE", "message": "Claude cannot read image/svg+xml as an image.",
            })),
            Some(SidecarFact::SendRejected(SendRejection {
                uuid: Some("u".into()),
                code: "INVALID_IMAGE".into(),
                message: "Claude cannot read image/svg+xml as an image.".into(),
            })),
        );
        assert_eq!(
            SidecarFact::from_line(&json!({ "type": "sdk.send.rejected", "uuid": null })),
            Some(SidecarFact::SendRejected(SendRejection {
                uuid: None,
                code: "INVALID_SEND".into(),
                message: REJECTED_SEND_FALLBACK_MESSAGE.into(),
            })),
        );
    }

    #[test]
    fn content_and_control_lines_are_not_facts() {
        for line in [
            json!({ "type": "sdk.result", "subtype": "success" }),
            json!({ "type": "sdk.assistant", "content": [] }),
            json!({ "type": "sdk.turn.complete", "at": 1 }),
            json!({ "type": "sdk.interrupt_settled", "ok": true, "stillQueued": [] }),
            json!({ "type": "created", "requestId": "r" }),
        ] {
            assert_eq!(SidecarFact::from_line(&line), None, "{line}");
        }
    }
}

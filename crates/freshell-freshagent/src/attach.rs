//! Request-scoped attach result capture shared by the provider handlers.

use freshell_protocol::{
    FreshAgentAttach, FreshAgentAttachFailed, FreshAgentAttached, FreshAgentEvent,
    FreshAgentEvent as EventEnvelope, ServerMessage, SessionLocator,
};
use serde_json::Value;
use std::future::Future;
use std::sync::{Arc, Mutex};

tokio::task_local! {
    static ATTACH_MESSAGES: Arc<Mutex<Vec<ServerMessage>>>;
}

#[derive(Debug, Clone)]
pub struct AttachFailure {
    pub code: String,
    pub message: String,
    pub retryable: Option<bool>,
    pub owner_kind: Option<String>,
    pub owner_generation: Option<u64>,
    pub owner_epoch: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct AttachOwner {
    pub kind: String,
    pub generation: u64,
    pub epoch: u64,
}

#[derive(Debug, Clone)]
pub enum AttachOutcome {
    Attached {
        status: String,
        snapshot: Option<Value>,
        owner: Option<AttachOwner>,
        legacy_messages: Vec<ServerMessage>,
    },
    Failed {
        failure: AttachFailure,
        legacy_messages: Vec<ServerMessage>,
    },
}

impl AttachOutcome {
    pub fn from_messages(messages: Vec<ServerMessage>) -> Self {
        for message in &messages {
            if let Some(failure) = failure_from_message(message) {
                return Self::Failed {
                    failure,
                    legacy_messages: messages,
                };
            }
        }

        Self::attached_from_replay_for_session(None, messages)
    }

    /// Build a successful requester outcome from already-projected replay
    /// frames. A historical error event is still part of the replay and does
    /// not mean that the attach itself failed.
    pub fn attached_from_replay_for_session(
        session_id: Option<&str>,
        messages: Vec<ServerMessage>,
    ) -> Self {
        let snapshot = messages.iter().rev().find_map(|message| match message {
            ServerMessage::FreshAgentEvent(FreshAgentEvent { event, .. })
                if matches!(
                    event.get("type").and_then(Value::as_str),
                    Some(
                        "freshAgent.session.snapshot"
                            | "freshAgent.status"
                            | "freshAgent.host.backpressure"
                            | "freshAgent.host.journal.reset"
                    )
                ) =>
            {
                Some(event.clone())
            }
            _ => None,
        });
        let status = messages
            .iter()
            .rev()
            .find_map(|message| match message {
                ServerMessage::FreshAgentEvent(FreshAgentEvent { event, .. }) => event
                    .get("status")
                    .or_else(|| {
                        event
                            .get("retainedState")
                            .and_then(|retained| retained.get("snapshot"))
                            .and_then(|snapshot| snapshot.get("status"))
                    })
                    .and_then(Value::as_str),
                _ => None,
            })
            .filter(|status| matches!(*status, "running" | "idle"))
            .unwrap_or("unknown")
            .to_string();

        let snapshot = snapshot.or_else(|| {
            if status == "unknown" {
                return None;
            }
            session_id.map(|session_id| {
                serde_json::json!({
                    "type": "freshAgent.session.snapshot",
                    "sessionId": session_id,
                    "status": status,
                })
            })
        });

        Self::Attached {
            status,
            snapshot,
            owner: None,
            legacy_messages: messages,
        }
    }

    pub fn with_status_snapshot(self, session_id: &str, current_status: &str) -> Self {
        match self {
            AttachOutcome::Attached {
                status,
                snapshot,
                owner,
                legacy_messages,
            } if snapshot.is_none() => AttachOutcome::Attached {
                status: if matches!(current_status, "running" | "idle") {
                    current_status.to_string()
                } else {
                    status
                },
                snapshot: Some(serde_json::json!({
                    "type": "freshAgent.session.snapshot",
                    "sessionId": session_id,
                    "status": current_status,
                })),
                owner,
                legacy_messages,
            },
            outcome => outcome,
        }
    }

    pub fn with_current_owner(self, snapshot: freshell_ownership::OwnershipSnapshot) -> Self {
        let owner = match snapshot.state {
            freshell_ownership::OwnershipState::Live {
                owner, generation, ..
            } => Some(AttachOwner {
                kind: match owner.kind {
                    freshell_ownership::RuntimeOwnerKind::Terminal => "terminal",
                    freshell_ownership::RuntimeOwnerKind::FreshAgent => "fresh-agent",
                }
                .to_string(),
                generation,
                epoch: snapshot.epoch,
            }),
            _ => None,
        };
        match self {
            AttachOutcome::Attached {
                status,
                snapshot,
                legacy_messages,
                ..
            } => AttachOutcome::Attached {
                status,
                snapshot,
                owner,
                legacy_messages,
            },
            AttachOutcome::Failed {
                mut failure,
                legacy_messages,
            } => {
                if let Some(owner) = owner {
                    failure.owner_kind = Some(owner.kind);
                    failure.owner_generation = Some(owner.generation);
                    failure.owner_epoch = Some(owner.epoch);
                }
                AttachOutcome::Failed {
                    failure,
                    legacy_messages,
                }
            }
        }
    }

    /// Adapt a typed provider result into one modern requester result, or the
    /// exact captured event frames for an ID-free legacy request. Negotiation
    /// is applied by the WS connection's outer reply sink.
    pub fn requester_messages(attach: &FreshAgentAttach, outcome: Self) -> Vec<ServerMessage> {
        let provider = serde_json::to_value(attach.provider)
            .ok()
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap_or_else(|| "unknown".to_string());
        let session_type = serde_json::to_value(attach.session_type)
            .ok()
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap_or_else(|| "unknown".to_string());

        if let Some(request_id) = attach.request_id.as_ref() {
            let operation_id = Some(request_id.clone());
            return match outcome {
                AttachOutcome::Attached {
                    status,
                    snapshot,
                    owner,
                    legacy_messages,
                } => {
                    let session_id =
                        resolved_session_id(attach, snapshot.as_ref(), &legacy_messages);
                    let session_ref = Some(SessionLocator {
                        provider: provider.clone(),
                        session_id: session_id.clone(),
                    });
                    let mut messages = attach_side_messages(&legacy_messages, snapshot.as_ref());
                    messages.push(ServerMessage::FreshAgentAttached(FreshAgentAttached {
                        request_id: request_id.clone(),
                        view_id: attach.view_id.clone(),
                        provider,
                        session_id,
                        session_type,
                        session_ref,
                        status,
                        snapshot,
                        operation_id,
                        retryable: Some(false),
                        owner_kind: owner.as_ref().map(|owner| owner.kind.clone()),
                        owner_generation: owner.as_ref().map(|owner| owner.generation),
                        owner_epoch: owner.as_ref().map(|owner| owner.epoch),
                    }));
                    messages
                }
                AttachOutcome::Failed {
                    failure,
                    legacy_messages,
                } => {
                    let mut messages = attach_side_messages(&legacy_messages, None);
                    let session_id = resolved_session_id(attach, None, &legacy_messages);
                    let session_ref = Some(SessionLocator {
                        provider: provider.clone(),
                        session_id: session_id.clone(),
                    });
                    messages.push(ServerMessage::FreshAgentAttachFailed(
                        FreshAgentAttachFailed {
                            request_id: request_id.clone(),
                            view_id: attach.view_id.clone(),
                            provider: provider.clone(),
                            session_id,
                            session_type: session_type.clone(),
                            session_ref,
                            status: "failed".into(),
                            code: failure.code,
                            message: failure.message,
                            operation_id,
                            retryable: failure.retryable,
                            owner_kind: failure.owner_kind,
                            owner_generation: failure.owner_generation,
                            owner_epoch: failure.owner_epoch,
                        },
                    ));
                    messages
                }
            };
        }

        match outcome {
            AttachOutcome::Attached {
                legacy_messages, ..
            }
            | AttachOutcome::Failed {
                legacy_messages, ..
            } if !legacy_messages.is_empty() => legacy_messages,
            AttachOutcome::Failed { failure, .. } => {
                vec![ServerMessage::FreshAgentEvent(EventEnvelope {
                    event: serde_json::json!({
                        "type": "freshAgent.error",
                        "sessionId": attach.session_id,
                        "code": failure.code,
                        "message": failure.message,
                    }),
                    provider,
                    session_id: attach.session_id.clone(),
                    session_type,
                })]
            }
            AttachOutcome::Attached { .. } => Vec::new(),
        }
    }
}

fn resolved_session_id(
    attach: &FreshAgentAttach,
    snapshot: Option<&Value>,
    messages: &[ServerMessage],
) -> String {
    let mut session_id = attach.session_id.clone();
    for message in messages {
        if let ServerMessage::FreshAgentSessionMaterialized(materialized) = message {
            if materialized.previous_session_id == session_id {
                session_id.clone_from(&materialized.session_id);
            }
        }
    }
    if session_id == attach.session_id {
        if let Some(session_ref) = attach.session_ref.as_ref() {
            session_id.clone_from(&session_ref.session_id);
        }
    }
    snapshot
        .and_then(|event| event.get("sessionId"))
        .and_then(Value::as_str)
        .filter(|snapshot_id| !snapshot_id.is_empty())
        .unwrap_or(&session_id)
        .to_string()
}

/// Preserve requester-only companion frames such as durable re-key and
/// effective settings while folding the chosen snapshot/error into the one
/// correlated result. Historical snapshots remain ordered before the final
/// acknowledgement, which carries the latest one.
fn attach_side_messages(
    messages: &[ServerMessage],
    snapshot: Option<&Value>,
) -> Vec<ServerMessage> {
    let snapshot_index = snapshot.and_then(|snapshot| {
        messages.iter().rposition(|message| match message {
            ServerMessage::FreshAgentEvent(FreshAgentEvent { event, .. }) => event == snapshot,
            _ => false,
        })
    });
    messages
        .iter()
        .enumerate()
        .filter(|(index, message)| {
            let selected_snapshot = Some(*index) == snapshot_index;
            !selected_snapshot && !is_attach_error(message)
        })
        .map(|(_, message)| message.clone())
        .collect()
}

fn is_attach_error(message: &ServerMessage) -> bool {
    matches!(message, ServerMessage::Error(_))
        || matches!(message,
            ServerMessage::FreshAgentEvent(FreshAgentEvent { event, .. })
                if event.get("type").and_then(Value::as_str) == Some("freshAgent.error")
        )
}

pub async fn capture_attach_messages<T>(
    future: impl Future<Output = T>,
) -> (T, Vec<ServerMessage>) {
    let messages = Arc::new(Mutex::new(Vec::new()));
    let output = ATTACH_MESSAGES.scope(Arc::clone(&messages), future).await;
    let messages = messages
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    (output, messages)
}

/// Capture only events that settle an attach. Canonical status, materialization,
/// and provider output stay on the normal shared broadcast path.
pub fn capture_attach_message(message: &ServerMessage) -> bool {
    let is_attach_result = match message {
        ServerMessage::FreshAgentEvent(frame) => matches!(
            frame.event.get("type").and_then(Value::as_str),
            Some("freshAgent.session.snapshot" | "freshAgent.error")
        ),
        ServerMessage::Error(_) => true,
        _ => false,
    };
    if !is_attach_result {
        return false;
    }
    ATTACH_MESSAGES
        .try_with(|messages| {
            messages
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(message.clone());
        })
        .is_ok()
}

fn failure_from_message(message: &ServerMessage) -> Option<AttachFailure> {
    match message {
        ServerMessage::FreshAgentEvent(frame)
            if frame.event.get("type").and_then(Value::as_str) == Some("freshAgent.error") =>
        {
            let event = &frame.event;
            Some(AttachFailure {
                code: event
                    .get("code")
                    .and_then(Value::as_str)
                    .unwrap_or("ATTACH_FAILED")
                    .to_string(),
                message: event
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("The Freshagent session could not be attached.")
                    .to_string(),
                retryable: event.get("retryable").and_then(Value::as_bool),
                owner_kind: event
                    .get("ownerKind")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                owner_generation: event.get("ownerGeneration").and_then(Value::as_u64),
                owner_epoch: event.get("ownerEpoch").and_then(Value::as_u64),
            })
        }
        ServerMessage::Error(error) => {
            let value = serde_json::to_value(error).ok()?;
            Some(AttachFailure {
                code: value
                    .get("code")
                    .and_then(Value::as_str)
                    .unwrap_or("ATTACH_FAILED")
                    .to_string(),
                message: error.message.clone(),
                retryable: error.retry_after_ms.map(|_| true),
                owner_kind: error.owner_kind.clone(),
                owner_generation: error.owner_generation,
                owner_epoch: error.owner_epoch,
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use freshell_protocol::{AgentProvider, FreshAgentSessionMaterialized, SessionType};

    fn attach(request_id: Option<&str>) -> FreshAgentAttach {
        FreshAgentAttach {
            provider: AgentProvider::Claude,
            session_id: "placeholder".into(),
            session_type: SessionType::Freshclaude,
            request_id: request_id.map(str::to_string),
            view_id: Some("view-mobile".into()),
            cwd: None,
            observed_epoch: None,
            observed_generation: None,
            resume_session_id: None,
            session_ref: None,
            tab_id: None,
            pane_id: None,
        }
    }

    fn materialized() -> ServerMessage {
        ServerMessage::FreshAgentSessionMaterialized(FreshAgentSessionMaterialized {
            previous_session_id: "placeholder".into(),
            provider: "claude".into(),
            session_id: "native-session".into(),
            session_type: "freshclaude".into(),
            session_ref: Some(SessionLocator {
                provider: "claude".into(),
                session_id: "native-session".into(),
            }),
            session_name: None,
            name_ref: None,
        })
    }

    fn snapshot(session_id: &str, status: &str) -> ServerMessage {
        ServerMessage::FreshAgentEvent(FreshAgentEvent {
            event: serde_json::json!({
                "type": "freshAgent.session.snapshot",
                "sessionId": session_id,
                "status": status,
            }),
            provider: "claude".into(),
            session_id: session_id.into(),
            session_type: "freshclaude".into(),
        })
    }

    #[test]
    fn modern_attach_keeps_materialization_and_settings_with_one_correlated_snapshot() {
        let snapshot_event = serde_json::json!({
            "type": "freshAgent.session.snapshot",
            "sessionId": "native-session",
            "status": "running",
        });
        let metadata = ServerMessage::FreshAgentEvent(FreshAgentEvent {
            event: serde_json::json!({ "type": "freshAgent.session.metadata", "model": "m" }),
            provider: "claude".into(),
            session_id: "native-session".into(),
            session_type: "freshclaude".into(),
        });
        let outcome = AttachOutcome::Attached {
            status: "running".into(),
            snapshot: Some(snapshot_event.clone()),
            owner: None,
            legacy_messages: vec![
                materialized(),
                snapshot("native-session", "running"),
                metadata,
            ],
        };

        let messages = AttachOutcome::requester_messages(&attach(Some("attach-7")), outcome);
        assert_eq!(messages.len(), 3);
        assert!(matches!(
            messages[0],
            ServerMessage::FreshAgentSessionMaterialized(_)
        ));
        assert!(matches!(
            &messages[1],
            ServerMessage::FreshAgentEvent(frame)
                if frame.event["type"] == "freshAgent.session.metadata"
        ));
        let ServerMessage::FreshAgentAttached(attached) = &messages[2] else {
            panic!("the final reply must be the correlated attach result: {messages:?}");
        };
        assert_eq!(attached.request_id, "attach-7");
        assert_eq!(attached.view_id.as_deref(), Some("view-mobile"));
        assert_eq!(attached.session_id, "native-session");
        assert_eq!(
            attached.session_ref.as_ref().unwrap().session_id,
            "native-session"
        );
        assert_eq!(attached.snapshot.as_ref(), Some(&snapshot_event));
        assert_eq!(
            messages
                .iter()
                .filter(|message| matches!(
                    message,
                    ServerMessage::FreshAgentEvent(frame)
                        if frame.event["type"] == "freshAgent.session.snapshot"
                ))
                .count(),
            0,
            "the attached frame carries the snapshot exactly once"
        );
    }

    #[test]
    fn legacy_attach_keeps_its_event_frames_and_modern_failure_is_requester_scoped() {
        let error = ServerMessage::FreshAgentEvent(FreshAgentEvent {
            event: serde_json::json!({
                "type": "freshAgent.error",
                "code": "SESSION_RESERVED",
                "message": "reserved",
            }),
            provider: "claude".into(),
            session_id: "native-session".into(),
            session_type: "freshclaude".into(),
        });
        let legacy_outcome = AttachOutcome::Attached {
            status: "idle".into(),
            snapshot: None,
            owner: None,
            legacy_messages: vec![materialized(), snapshot("native-session", "idle")],
        };
        let legacy = AttachOutcome::requester_messages(&attach(None), legacy_outcome.clone());
        assert_eq!(
            legacy,
            vec![materialized(), snapshot("native-session", "idle")]
        );

        let failed = AttachOutcome::from_messages(vec![materialized(), error]);
        let modern = AttachOutcome::requester_messages(&attach(Some("attach-8")), failed);
        assert_eq!(modern.len(), 2);
        assert!(matches!(
            modern[0],
            ServerMessage::FreshAgentSessionMaterialized(_)
        ));
        assert!(matches!(
            &modern[1],
            ServerMessage::FreshAgentAttachFailed(failed)
                if failed.request_id == "attach-8"
                    && failed.code == "SESSION_RESERVED"
                    && failed.session_id == "native-session"
                    && failed.session_ref.as_ref().is_some_and(|session_ref| session_ref.session_id == "native-session")
        ));
    }
}

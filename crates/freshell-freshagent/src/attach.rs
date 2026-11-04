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
            if let Some(failure) = failure_from_message(message)
                .filter(|failure| !is_nonfatal_warning_code(&failure.code))
            {
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

    /// Identity named by this outcome after provider materialization or
    /// recovery, resolved from its snapshot and requester-only side frames.
    pub fn resolved_session_id(&self, attach: &FreshAgentAttach) -> String {
        match self {
            AttachOutcome::Attached {
                snapshot,
                legacy_messages,
                ..
            } => resolved_session_id(attach, snapshot.as_ref(), legacy_messages),
            AttachOutcome::Failed {
                legacy_messages, ..
            } => resolved_session_id(attach, None, legacy_messages),
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
                    // Keep an earlier replay snapshot in place when a later
                    // state-changing frame follows it. Moving it into the
                    // final ack would reapply old state after newer events.
                    let preserve_snapshot_order = snapshot.as_ref().is_some_and(|snapshot| {
                        snapshot_has_later_state_change(&legacy_messages, snapshot)
                    });
                    let (status, snapshot) = if preserve_snapshot_order {
                        ("unknown".to_string(), None)
                    } else {
                        (status, snapshot)
                    };
                    let session_id =
                        resolved_session_id(attach, snapshot.as_ref(), &legacy_messages);
                    let session_ref = Some(SessionLocator {
                        provider: provider.clone(),
                        session_id: session_id.clone(),
                    });
                    let mut messages =
                        attach_side_messages(&legacy_messages, snapshot.as_ref(), None);
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
                    let mut messages = attach_side_messages(&legacy_messages, None, Some(&failure));
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
/// effective settings. The selected snapshot is folded into the correlated
/// result only when later replay frames cannot change its state.
fn attach_side_messages(
    messages: &[ServerMessage],
    snapshot: Option<&Value>,
    settlement_failure: Option<&AttachFailure>,
) -> Vec<ServerMessage> {
    let snapshot_index = snapshot.and_then(|snapshot| replay_snapshot_index(messages, snapshot));
    // Providers enrich the typed outcome with the current owner after
    // capturing its settlement event. Match its stable error identity and
    // remove the last matching event, since an operation's settlement follows
    // any earlier canonical history with the same error.
    let settlement_index = settlement_failure.and_then(|failure| {
        messages
            .iter()
            .rposition(|message| failure_matches(message, failure))
    });
    messages
        .iter()
        .enumerate()
        .filter_map(|(index, message)| {
            if Some(index) == snapshot_index {
                return None;
            }
            if Some(index) == settlement_index {
                return None;
            }
            Some(message.clone())
        })
        .collect()
}

fn replay_snapshot_index(messages: &[ServerMessage], snapshot: &Value) -> Option<usize> {
    messages.iter().rposition(|message| match message {
        ServerMessage::FreshAgentEvent(FreshAgentEvent { event, .. }) => event == snapshot,
        _ => false,
    })
}

fn snapshot_has_later_state_change(messages: &[ServerMessage], snapshot: &Value) -> bool {
    let Some(snapshot_index) = replay_snapshot_index(messages, snapshot) else {
        return false;
    };
    messages
        .iter()
        .skip(snapshot_index + 1)
        .any(|message| !is_snapshot_safe_trailing_frame(message))
}

fn is_snapshot_safe_trailing_frame(message: &ServerMessage) -> bool {
    matches!(
        message,
        ServerMessage::FreshAgentEvent(FreshAgentEvent { event, .. })
            if event.get("type").and_then(Value::as_str) == Some("freshAgent.session.metadata")
    )
}

fn failure_matches(message: &ServerMessage, failure: &AttachFailure) -> bool {
    failure_from_message(message).is_some_and(|candidate| {
        candidate.code == failure.code && candidate.message == failure.message
    })
}

fn is_nonfatal_warning_code(code: &str) -> bool {
    matches!(code, "SETTINGS_RESET" | "THREAD_MEMORY_LOST")
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
        ServerMessage::FreshAgentEvent(frame) => {
            match frame.event.get("type").and_then(Value::as_str) {
                Some("freshAgent.session.snapshot") => true,
                Some("freshAgent.error") => !frame
                    .event
                    .get("code")
                    .and_then(Value::as_str)
                    .is_some_and(is_nonfatal_warning_code),
                _ => false,
            }
        }
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

    #[test]
    fn modern_replay_preserves_historical_provider_errors_in_order() {
        let historical_error = ServerMessage::FreshAgentEvent(FreshAgentEvent {
            event: serde_json::json!({
                "type": "freshAgent.error",
                "sessionId": "native-session",
                "code": "PROVIDER_WARNING",
                "message": "a retained provider warning",
            }),
            provider: "claude".into(),
            session_id: "native-session".into(),
            session_type: "freshclaude".into(),
        });
        let latest_snapshot = serde_json::json!({
            "type": "freshAgent.session.snapshot",
            "sessionId": "native-session",
            "status": "idle",
        });
        let replay_snapshot = ServerMessage::FreshAgentEvent(FreshAgentEvent {
            event: latest_snapshot.clone(),
            provider: "claude".into(),
            session_id: "native-session".into(),
            session_type: "freshclaude".into(),
        });
        let outcome = AttachOutcome::attached_from_replay_for_session(
            Some("native-session"),
            vec![historical_error.clone(), replay_snapshot],
        );

        let messages = AttachOutcome::requester_messages(&attach(Some("attach-9")), outcome);
        assert_eq!(
            messages.len(),
            2,
            "the historical error and ack each arrive once"
        );
        assert_eq!(messages[0], historical_error);
        assert!(matches!(
            &messages[1],
            ServerMessage::FreshAgentAttached(attached)
                if attached.request_id == "attach-9"
                    && attached.snapshot.as_ref() == Some(&latest_snapshot)
        ));
    }

    #[test]
    fn modern_replay_keeps_an_earlier_snapshot_before_later_errors() {
        let running_snapshot = snapshot("native-session", "running");
        let warning = ServerMessage::FreshAgentEvent(FreshAgentEvent {
            event: serde_json::json!({
                "type": "freshAgent.error",
                "sessionId": "native-session",
                "code": "PROVIDER_WARNING",
                "message": "an earlier retained warning",
            }),
            provider: "claude".into(),
            session_id: "native-session".into(),
            session_type: "freshclaude".into(),
        });
        let hard_error = ServerMessage::FreshAgentEvent(FreshAgentEvent {
            event: serde_json::json!({
                "type": "freshAgent.error",
                "sessionId": "native-session",
                "code": "PROVIDER_ERROR",
                "message": "the retained session is no longer available",
            }),
            provider: "claude".into(),
            session_id: "native-session".into(),
            session_type: "freshclaude".into(),
        });
        let outcome = AttachOutcome::attached_from_replay_for_session(
            Some("native-session"),
            vec![
                running_snapshot.clone(),
                warning.clone(),
                hard_error.clone(),
            ],
        );

        let messages = AttachOutcome::requester_messages(&attach(Some("attach-order")), outcome);

        assert_eq!(
            messages.len(),
            4,
            "one settlement follows the ordered replay: {messages:?}"
        );
        assert_eq!(messages[0], running_snapshot);
        assert_eq!(messages[1], warning);
        assert_eq!(messages[2], hard_error);
        assert!(matches!(
            &messages[3],
            ServerMessage::FreshAgentAttached(attached)
                if attached.request_id == "attach-order"
                    && attached.status == "unknown"
                    && attached.snapshot.is_none()
        ));
        assert_eq!(
            messages
                .iter()
                .filter(|message| matches!(message, ServerMessage::FreshAgentAttached(_)))
                .count(),
            1,
            "the replay has exactly one requester-scoped settlement"
        );
    }

    #[test]
    fn reservation_attach_result_preserves_provider_error_wire_shape() {
        let provider_error = ServerMessage::FreshAgentEvent(FreshAgentEvent {
            event: serde_json::json!({
                "type": "freshAgent.error",
                "sessionId": "native-session",
                "code": "SESSION_RESERVED",
                "message": "another lifecycle operation is in progress",
            }),
            provider: "codex".into(),
            session_id: "native-session".into(),
            session_type: "freshcodex".into(),
        });
        let outcome = AttachOutcome::from_messages(vec![provider_error]);

        let messages = AttachOutcome::requester_messages(&attach(Some("attach-reserved")), outcome);
        let ServerMessage::FreshAgentAttachFailed(failed) = messages.last().unwrap() else {
            panic!("reservation must settle as one typed failure: {messages:?}");
        };
        let wire = serde_json::to_value(failed).unwrap();
        assert_eq!(failed.code, "SESSION_RESERVED");
        assert_eq!(failed.retryable, None);
        assert!(
            wire.get("retryable").is_none(),
            "the default provider error omits retryable: {wire}"
        );

        let terminal_outcome = AttachOutcome::Failed {
            failure: AttachFailure {
                code: "SESSION_RESERVED".into(),
                message: "a terminal owns this session".into(),
                retryable: None,
                owner_kind: Some("terminal".into()),
                owner_generation: Some(8),
                owner_epoch: Some(4),
            },
            legacy_messages: Vec::new(),
        };
        let terminal_messages =
            AttachOutcome::requester_messages(&attach(Some("attach-terminal")), terminal_outcome);
        let ServerMessage::FreshAgentAttachFailed(terminal) = terminal_messages.last().unwrap()
        else {
            panic!("terminal refusal must remain a typed failure: {terminal_messages:?}");
        };
        assert_eq!(terminal.owner_kind.as_deref(), Some("terminal"));
        assert_eq!(terminal.retryable, None);
    }

    #[test]
    fn failed_attach_removes_the_settlement_after_an_identical_historical_error() {
        let attach = attach(Some("attach-identical-error"));
        let historical = ServerMessage::FreshAgentEvent(FreshAgentEvent {
            provider: "claude".into(),
            session_id: "placeholder".into(),
            session_type: "freshclaude".into(),
            event: serde_json::json!({
                "type":"freshAgent.error",
                "sessionId":"placeholder",
                "code":"SESSION_RESERVED",
                "message":"retry after owner settles",
            }),
        });
        let settlement = ServerMessage::FreshAgentEvent(FreshAgentEvent {
            provider: "claude".into(),
            session_id: "placeholder".into(),
            session_type: "freshclaude".into(),
            event: serde_json::json!({
                "type":"freshAgent.error",
                "sessionId":"placeholder",
                "code":"SESSION_RESERVED",
                "message":"retry after owner settles",
                "ownerKind":"terminal",
                "ownerGeneration":8,
                "ownerEpoch":4,
            }),
        });
        let outcome = AttachOutcome::Failed {
            failure: AttachFailure {
                code: "SESSION_RESERVED".into(),
                message: "retry after owner settles".into(),
                retryable: Some(true),
                owner_kind: Some("terminal".into()),
                owner_generation: Some(8),
                owner_epoch: Some(4),
            },
            legacy_messages: vec![historical.clone(), settlement],
        };

        let messages = AttachOutcome::requester_messages(&attach, outcome);

        assert_eq!(
            messages.len(),
            2,
            "history and typed result only: {messages:?}"
        );
        assert_eq!(
            messages[0], historical,
            "the canonical event remains in order"
        );
        assert!(matches!(
            &messages[1],
            ServerMessage::FreshAgentAttachFailed(failed)
                if failed.request_id == "attach-identical-error"
                    && failed.code == "SESSION_RESERVED"
        ));
    }

    #[tokio::test]
    async fn settings_reset_warning_does_not_settle_or_leave_the_shared_broadcast_path() {
        let warning = ServerMessage::FreshAgentEvent(FreshAgentEvent {
            event: serde_json::json!({
                "type": "freshAgent.error",
                "sessionId": "native-session",
                "code": "SETTINGS_RESET",
                "message": "reconfirm settings",
            }),
            provider: "codex".into(),
            session_id: "native-session".into(),
            session_type: "freshcodex".into(),
        });

        let (captured_value, captured_messages) =
            capture_attach_messages(async { capture_attach_message(&warning) }).await;
        assert!(
            !captured_value,
            "a canonical settings warning must continue through the shared broadcast path"
        );
        assert!(captured_messages.is_empty());
        let outcome = AttachOutcome::from_messages(vec![snapshot("native-session", "idle")]);
        let messages = AttachOutcome::requester_messages(&attach(Some("attach-10")), outcome);
        assert!(messages.iter().any(|message| matches!(
            message,
            ServerMessage::FreshAgentAttached(attached)
                if attached.request_id == "attach-10" && attached.status == "idle"
        )));
        assert!(!messages
            .iter()
            .any(|message| matches!(message, ServerMessage::FreshAgentAttachFailed(_))));
    }
}

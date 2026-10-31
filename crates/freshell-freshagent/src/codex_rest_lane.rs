//! REST automation of the existing, ownership-bearing Codex runtime.

use crate::codex::turn_state::NativeSettlement;
use crate::codex::{
    CodexCreateOutcome, CodexSendOutcome, CodexSnapshotError, CodexTurnEvent, FreshCodexState,
};
use crate::rest_lane::*;
use freshell_protocol::{
    AgentProvider, FreshAgentCreate, FreshAgentSend, SessionLocator, SessionType,
};
use std::sync::Arc;
use std::time::Duration;

pub struct CodexRestLane {
    state: FreshCodexState,
    enabled: Arc<dyn Fn() -> bool + Send + Sync>,
}

impl CodexRestLane {
    pub fn new(state: FreshCodexState, enabled: Arc<dyn Fn() -> bool + Send + Sync>) -> Self {
        Self { state, enabled }
    }
}

fn codex_identity(provider: &str, session_type: &str) -> Result<(), RestLaneError> {
    if provider == "codex" && session_type == "freshcodex" {
        return Ok(());
    }
    Err(RestLaneError::new(
        RestLaneErrorKind::BadRequest,
        "INVALID_REQUEST",
        "the local Codex lane supports freshcodex sessions",
    ))
}

fn failure(
    code: String,
    message: String,
    retryable: Option<bool>,
    owner: Option<crate::ownership_lane::TerminalOwnerFields>,
) -> RestLaneError {
    let kind = match code.as_str() {
        "SESSION_RESERVED" | "STALE_CLAIM" | "CODEX_DELIVERY_AMBIGUOUS" => {
            RestLaneErrorKind::Conflict
        }
        "SESSION_NOT_FOUND" => RestLaneErrorKind::NotFound,
        code if code.starts_with("INVALID_") => RestLaneErrorKind::BadRequest,
        _ => RestLaneErrorKind::Unavailable,
    };
    let mut error = RestLaneError::new(kind, code, message);
    error.retryable = retryable;
    error.owner = owner;
    error
}

#[async_trait::async_trait]
impl FreshAgentRestLane for CodexRestLane {
    async fn abandon_create(
        &self,
        request: &RestLaneCreate,
        created: &RestLaneCreated,
    ) -> Result<(), RestLaneError> {
        codex_identity(&request.provider, &request.session_type)?;
        if let Some(ownership_id) = created.cleanup_token.as_deref() {
            self.state
                .abandon_created_runtime(&created.session_id, ownership_id)
                .await?;
        }
        Ok(())
    }

    async fn snapshot(
        &self,
        request: RestLaneSnapshot,
    ) -> Result<Option<serde_json::Value>, RestLaneSnapshotError> {
        codex_identity(&request.provider, &request.session_type)
            .map_err(|_| RestLaneSnapshotError::OwnershipUnavailable)?;
        self.state.get_snapshot(&request.session_id, None).await.map(Some).map_err(|error| {
            tracing::warn!(event="freshagent.codex.rest_lane.snapshot_failed", session_id=%request.session_id, error=%error);
            RestLaneSnapshotError::ManagedUnavailable
        })
    }

    async fn capture(
        &self,
        request: RestLaneCapture,
    ) -> Result<RestLaneCaptureResult, RestLaneCaptureError> {
        codex_identity(&request.provider, &request.session_type)
            .map_err(|_| RestLaneCaptureError::Unsupported)?;
        // A headless turn need not publish text-item events. The existing exact
        // snapshot path hydrates native saved history and merges retained live
        // fragments, including its finite unavailable/interrupted states.
        let snapshot = self.state.get_snapshot(&request.session_id, None).await.map_err(|error| {
            tracing::warn!(event="freshagent.codex.rest_lane.capture_failed", session_id=%request.session_id, error=%error);
            match error { CodexSnapshotError::NotFound => RestLaneCaptureError::NotFound, _ => RestLaneCaptureError::Unavailable }
        })?;
        if snapshot["extensions"]["codex"]["ownerKind"] == "vacant"
            && snapshot["turns"].as_array().is_some_and(Vec::is_empty)
        {
            return Err(RestLaneCaptureError::NotFound);
        }
        let (text, truncated) = freshell_agent_runtime::snapshot_text::render_snapshot_text(
            &snapshot,
            request.max_bytes.min(256 * 1024),
        );
        tracing::info!(event="freshagent.codex.rest_lane.capture", session_id=%request.session_id, bytes=text.len(), truncated);
        Ok(RestLaneCaptureResult {
            native_session_id: snapshot["threadId"]
                .as_str()
                .unwrap_or(&request.session_id)
                .into(),
            session_id: request.session_id,
            text,
            truncated,
        })
    }

    async fn create_agent(
        self: Arc<Self>,
        request: RestLaneCreate,
    ) -> Result<RestLaneCreated, RestLaneError> {
        codex_identity(&request.provider, &request.session_type)?;
        if !(self.enabled)() {
            return Err(RestLaneError::new(
                RestLaneErrorKind::Forbidden,
                "FRESH_AGENT_DISABLED",
                "fresh agents are disabled",
            ));
        }
        let outcome = self
            .state
            .handle_create(
                FreshAgentCreate {
                    provider: Some(AgentProvider::Codex),
                    session_type: SessionType::Freshcodex,
                    request_id: request.request_id,
                    cwd: request.cwd,
                    model: request.model,
                    effort: request.effort,
                    collaboration_mode: request.collaboration_mode,
                    model_selection: request.model_selection,
                    sandbox: request.sandbox,
                    permission_mode: request.permission_mode,
                    plugins: request.plugins,
                    session_ref: request.native_session_id.map(|session_id| SessionLocator {
                        provider: "codex".into(),
                        session_id,
                    }),
                    tab_id: request.tab_id,
                    pane_id: request.pane_id,
                    naming_handle: request.naming_handle,
                    observed_epoch: request.observed_epoch,
                    observed_generation: request.observed_generation,
                    legacy_restore_context: None,
                    resume_session_id: None,
                },
                None,
            )
            .await;
        match outcome {
            CodexCreateOutcome::Created {
                session_id,
                session_ref,
                cleanup_ownership_id,
                name_ref,
            } => {
                let effective_settings = self
                    .state
                    .created_rest_settings(&session_id, cleanup_ownership_id.as_deref())
                    .await;
                if effective_settings.is_none() {
                    if let Some(owner) = cleanup_ownership_id.as_deref() {
                        self.state
                            .abandon_created_runtime(&session_id, owner)
                            .await?;
                    }
                    return Err(failure(
                        "CODEX_CREATE_CHANGED".into(),
                        "the owning Codex runtime changed before its pane could be published"
                            .into(),
                        Some(true),
                        None,
                    ));
                }
                Ok(RestLaneCreated {
                    session_id,
                    session_ref,
                    cleanup_token: cleanup_ownership_id,
                    effective_settings,
                    name_ref,
                })
            }
            CodexCreateOutcome::Failed {
                code,
                message,
                retryable,
                owner,
            } => Err(failure(code, message, retryable, owner)),
        }
    }

    async fn send_agent(&self, request: RestLaneSend) -> Result<RestLaneSendResult, RestLaneError> {
        codex_identity(&request.provider, &request.session_type)?;
        if request
            .text
            .bytes()
            .all(|byte| matches!(byte, b'\r' | b'\n'))
        {
            return Ok(RestLaneSendResult {
                session_id: request.session_id,
                completed: true,
                noop: true,
                ..Default::default()
            });
        }
        let text = request
            .text
            .strip_suffix(['\r', '\n'])
            .unwrap_or(&request.text)
            .to_string();
        // Fast native turns can settle before the dispatch future returns.
        let mut events = self.state.subscribe_turn_events();
        let deadline = tokio::time::Instant::now() + Duration::from_millis(request.timeout_ms);
        match self
            .state
            .handle_send(FreshAgentSend {
                provider: AgentProvider::Codex,
                session_type: SessionType::Freshcodex,
                session_id: request.session_id.clone(),
                request_id: Some(request.request_id.clone()),
                text,
                cwd: None,
                images: None,
                settings: None,
                checkpoint_intent: None,
                observed_epoch: request.observed_epoch,
                observed_generation: request.observed_generation,
            })
            .await
        {
            CodexSendOutcome::Accepted {
                session_id,
                submitted_turn_id,
                incarnation_id,
                ..
            } => {
                let settled = tokio::time::timeout_at(deadline, async {
                    loop {
                        match events.recv().await {
                            Ok(CodexTurnEvent::Settled { session_id: settled_session, turn_id, incarnation_id: settled_incarnation, request_ids, outcome, source })
                                if settled_session == session_id && turn_id.as_deref() == Some(&submitted_turn_id)
                                    && settled_incarnation == incarnation_id && request_ids.iter().any(|id| id == &request.request_id) => {
                                tracing::info!(event="freshagent.codex.rest_lane.settled", session_id=%session_id, native_turn_id=%submitted_turn_id, incarnation_id=%incarnation_id, request_id=%request.request_id, outcome=?outcome, source=?source);
                                break Ok(outcome);
                            }
                            Ok(_) => {}
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => tracing::warn!(event="freshagent.codex.rest_lane.events_lagged", session_id=%session_id, request_id=%request.request_id, skipped),
                            Err(tokio::sync::broadcast::error::RecvError::Closed) => break Err(failure("FRESH_AGENT_EVENTS_UNAVAILABLE".into(), "Codex turn events are unavailable".into(), None, None)),
                        }
                    }
                }).await;
                let completed = match settled {
                    Ok(Ok(NativeSettlement::Completed)) => true,
                    Err(_) => false,
                    Ok(Ok(outcome)) => {
                        let (code, message) = match outcome {
                            NativeSettlement::Interrupted => (
                                "CODEX_TURN_INTERRUPTED",
                                "the submitted Codex turn was interrupted",
                            ),
                            NativeSettlement::Failed => {
                                ("CODEX_TURN_FAILED", "the submitted Codex turn failed")
                            }
                            NativeSettlement::OwnedExit => (
                                "FRESH_AGENT_SESSION_ENDED",
                                "the owned Codex runtime exited before the turn completed",
                            ),
                            NativeSettlement::Completed => unreachable!(),
                        };
                        let mut error = failure(code.into(), message.into(), Some(false), None);
                        error.kind = RestLaneErrorKind::Conflict;
                        error.correlation = Some(Box::new(RestLaneErrorCorrelation {
                            session_id: Some(session_id),
                            request_id: Some(request.request_id),
                            incarnation_id: Some(incarnation_id),
                            submitted_turn_id: Some(submitted_turn_id),
                        }));
                        return Err(error);
                    }
                    Ok(Err(error)) => return Err(error),
                };
                tracing::info!(event="freshagent.codex.rest_lane.send", session_id=%session_id, native_turn_id=%submitted_turn_id, incarnation_id=%incarnation_id, request_id=%request.request_id, completed);
                Ok(RestLaneSendResult {
                    session_id,
                    submitted_turn_id: Some(submitted_turn_id),
                    completed,
                    noop: false,
                })
            }
            CodexSendOutcome::Refused {
                code,
                message,
                retryable,
                owner,
            } => Err(failure(code, message, retryable, owner)),
            CodexSendOutcome::Ambiguous {
                session_id,
                request_id,
                incarnation_id,
                code,
                message,
            } => {
                let mut error = failure(code, message, Some(false), None);
                error.correlation = Some(Box::new(RestLaneErrorCorrelation {
                    session_id: Some(session_id),
                    request_id: Some(request_id),
                    incarnation_id: Some(incarnation_id),
                    ..Default::default()
                }));
                Err(error)
            }
        }
    }
}

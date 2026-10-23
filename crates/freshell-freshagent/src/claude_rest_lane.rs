//! REST control of the same Claude runtime used by WebSocket panes.

use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::claude_edges::ClaudeTurnEvent;
use crate::claude_snapshot::ClaudeSnapshotError;
use crate::rest_lane::*;
use crate::{ClaudeCreateOutcome, ClaudeSendOutcome, FreshClaudeState};
use freshell_protocol::{
    AgentProvider, FreshAgentCreate, FreshAgentSend, SessionLocator, SessionType,
};

pub struct ClaudeRestLane {
    state: FreshClaudeState,
    enabled: Arc<dyn Fn() -> bool + Send + Sync>,
}

impl ClaudeRestLane {
    pub fn new(state: FreshClaudeState, enabled: Arc<dyn Fn() -> bool + Send + Sync>) -> Self {
        Self { state, enabled }
    }

    async fn create(&self, request: RestLaneCreate) -> Result<RestLaneCreated, RestLaneError> {
        let session_type = claude_session_type(&request.provider, &request.session_type)?;
        if !(self.enabled)() {
            return Err(RestLaneError::new(
                RestLaneErrorKind::Forbidden,
                "FRESH_AGENT_DISABLED",
                "fresh agents are disabled",
            ));
        }
        let session_ref = request.native_session_id.map(|session_id| SessionLocator {
            provider: "claude".into(),
            session_id,
        });
        match self
            .state
            .handle_create(
                FreshAgentCreate {
                    request_id: request.request_id,
                    provider: Some(AgentProvider::Claude),
                    session_type,
                    cwd: request.cwd,
                    model: request.model,
                    model_selection: request.model_selection,
                    permission_mode: request.permission_mode,
                    effort: request.effort,
                    plugins: request.plugins,
                    session_ref,
                    sandbox: request.sandbox,
                    tab_id: request.tab_id,
                    pane_id: request.pane_id,
                    naming_handle: request.naming_handle,
                    observed_epoch: None,
                    observed_generation: None,
                    legacy_restore_context: None,
                    resume_session_id: None,
                },
                None,
            )
            .await
        {
            ClaudeCreateOutcome::Created {
                session_id,
                session_ref,
            } => Ok(RestLaneCreated {
                session_id,
                session_ref,
            }),
            ClaudeCreateOutcome::Failed {
                code,
                message,
                retryable,
                owner,
            } => {
                let mut error = RestLaneError::new(create_error_kind(&code), code, message);
                error.retryable = retryable;
                error.owner = owner;
                Err(error)
            }
        }
    }

    async fn send(&self, request: &RestLaneSend) -> Result<RestLaneSendResult, RestLaneError> {
        let session_type = claude_session_type(&request.provider, &request.session_type)?;
        if request
            .text
            .bytes()
            .all(|byte| matches!(byte, b'\r' | b'\n'))
        {
            return Ok(RestLaneSendResult {
                session_id: request.session_id.clone(),
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
        // A short turn may settle before handle_send returns its acceptance.
        let mut events = self.state.subscribe_turn_events();
        let accepted = self
            .state
            .handle_send(FreshAgentSend {
                provider: AgentProvider::Claude,
                session_id: request.session_id.clone(),
                session_type,
                text,
                request_id: Some(request.request_id.clone()),
                cwd: None,
                images: None,
                settings: None,
                observed_epoch: None,
                observed_generation: None,
                checkpoint_intent: None,
            })
            .await;
        let (session_key, submitted_turn_id, ownership_id) = match accepted {
            ClaudeSendOutcome::Accepted {
                session_key,
                submitted_turn_id,
                ownership_id,
            } => (session_key, submitted_turn_id, ownership_id),
            ClaudeSendOutcome::Refused { code, message } => return Err(send_error(code, message)),
        };
        let completed = wait_for_turn(
            &mut events,
            &session_key,
            &ownership_id,
            &request.request_id,
            &submitted_turn_id,
            Duration::from_millis(request.timeout_ms),
        )
        .await?;
        Ok(RestLaneSendResult {
            session_id: request.session_id.clone(),
            completed,
            submitted_turn_id: Some(submitted_turn_id),
            noop: false,
        })
    }
}

#[async_trait::async_trait]
impl FreshAgentRestLane for ClaudeRestLane {
    async fn create_agent(
        self: Arc<Self>,
        request: RestLaneCreate,
    ) -> Result<RestLaneCreated, RestLaneError> {
        let started = Instant::now();
        let request_id = request.request_id.clone();
        let session_type = request.session_type.clone();
        let result = self.create(request).await;
        match &result {
            Ok(created) => tracing::info!(
                event = "freshagent.claude.rest_lane.create",
                request_id,
                session_type,
                session_id = created.session_id,
                outcome = "created",
                elapsed_ms = started.elapsed().as_millis() as u64
            ),
            Err(error) => tracing::warn!(
                event = "freshagent.claude.rest_lane.create",
                request_id,
                session_type,
                code = error.code,
                outcome = "refused",
                elapsed_ms = started.elapsed().as_millis() as u64
            ),
        }
        result
    }

    async fn send_agent(&self, request: RestLaneSend) -> Result<RestLaneSendResult, RestLaneError> {
        let started = Instant::now();
        let result = self.send(&request).await;
        match &result {
            Ok(sent) => tracing::info!(
                event = "freshagent.claude.rest_lane.send",
                session_id = request.session_id,
                request_id = request.request_id,
                submitted_turn_id = sent.submitted_turn_id.as_deref(),
                completed = sent.completed,
                noop = sent.noop,
                waited_ms = started.elapsed().as_millis() as u64
            ),
            Err(error) => tracing::warn!(
                event = "freshagent.claude.rest_lane.send",
                session_id = request.session_id,
                request_id = request.request_id,
                code = error.code,
                outcome = "refused",
                waited_ms = started.elapsed().as_millis() as u64
            ),
        }
        result
    }

    async fn capture(
        &self,
        request: RestLaneCapture,
    ) -> Result<RestLaneCaptureResult, RestLaneCaptureError> {
        claude_session_type(&request.provider, &request.session_type)
            .map_err(|_| RestLaneCaptureError::Unsupported)?;
        let snapshot = match self
            .state
            .disk_snapshot(&request.session_type, &request.session_id)
            .await
        {
            Ok(snapshot) => snapshot,
            Err(ClaudeSnapshotError::NotFound)
                if self.state.has_live_session(&request.session_id).await =>
            {
                serde_json::json!({"turns":[]})
            }
            Err(ClaudeSnapshotError::NotFound) => return Err(RestLaneCaptureError::NotFound),
            Err(ClaudeSnapshotError::Io(error)) => {
                tracing::warn!(
                    event = "freshagent.claude.rest_lane.capture",
                    session_id = request.session_id,
                    outcome = "unreadable",
                    error
                );
                return Err(RestLaneCaptureError::Unavailable);
            }
        };
        let (text, truncated) = freshell_agent_runtime::snapshot_text::render_snapshot_text(
            &snapshot,
            request.max_bytes.min(256 * 1024),
        );
        tracing::info!(
            event = "freshagent.claude.rest_lane.capture",
            session_id = request.session_id,
            outcome = "captured",
            bytes = text.len(),
            truncated
        );
        Ok(RestLaneCaptureResult {
            session_id: request.session_id.clone(),
            native_session_id: request.session_id,
            text,
            truncated,
        })
    }
}

fn claude_session_type(provider: &str, session_type: &str) -> Result<SessionType, RestLaneError> {
    match (provider, session_type) {
        ("claude", "freshclaude") => Ok(SessionType::Freshclaude),
        ("claude", "kilroy") => Ok(SessionType::Kilroy),
        _ => Err(RestLaneError::new(
            RestLaneErrorKind::BadRequest,
            "INVALID_REQUEST",
            "the local Claude lane supports freshclaude and kilroy sessions",
        )),
    }
}

fn create_error_kind(code: &str) -> RestLaneErrorKind {
    match code {
        "SESSION_RESERVED" | "SESSION_ID_IN_USE" | "STALE_CLAIM" | "SESSION_BUSY" => {
            RestLaneErrorKind::Conflict
        }
        "CONVERSATION_NOT_FOUND" | "RESUME_POINT_NOT_FOUND" => RestLaneErrorKind::NotFound,
        "FRESH_AGENT_CREATE_FAILED" | "CLAUDE_CREATE_FAILED" | "SIDECAR_PROTOCOL_MISMATCH" => {
            RestLaneErrorKind::Unavailable
        }
        code if code.starts_with("INVALID_") => RestLaneErrorKind::BadRequest,
        code if code.starts_with("CLAUDE_SIDECAR_") => RestLaneErrorKind::Unavailable,
        _ => RestLaneErrorKind::Internal,
    }
}

fn retryable_conflict(code: &str, message: &str) -> RestLaneError {
    let mut error = RestLaneError::new(RestLaneErrorKind::Conflict, code, message);
    error.retryable = Some(true);
    error.retry_after_ms = Some(250);
    error
}

fn send_error(code: String, message: String) -> RestLaneError {
    match code.as_str() {
        "SESSION_NOT_FOUND" | "INVALID_SESSION_ID" => retryable_conflict(
            "FRESH_AGENT_SESSION_NOT_LIVE",
            "Claude is not running for this session; attach the pane and retry",
        ),
        "SESSION_BUSY" | "SESSION_RESERVED" | "STALE_CLAIM" => retryable_conflict(&code, &message),
        "CLAUDE_SEND_FAILED" | "CLAUDE_SETTINGS_FAILED" => {
            RestLaneError::new(RestLaneErrorKind::Unavailable, code, message)
        }
        code if code.starts_with("INVALID_") => {
            RestLaneError::new(RestLaneErrorKind::BadRequest, code, message)
        }
        _ => RestLaneError::new(RestLaneErrorKind::Internal, code, message),
    }
}

async fn wait_for_turn(
    events: &mut tokio::sync::broadcast::Receiver<ClaudeTurnEvent>,
    session_key: &str,
    ownership_id: &str,
    request_id: &str,
    submitted_turn_id: &str,
    budget: Duration,
) -> Result<bool, RestLaneError> {
    let waited = tokio::time::timeout(budget, async {
        loop {
            match events.recv().await {
                Ok(ClaudeTurnEvent::Settled {
                    session_key: settled_key,
                    retired_request_ids,
                    retired_command_ids,
                    ..
                }) if settled_key == session_key
                    && retired_request_ids
                        .iter()
                        .any(|retired| retired == request_id)
                    && retired_command_ids
                        .iter()
                        .any(|retired| retired == submitted_turn_id) =>
                {
                    return Ok(true)
                }
                Ok(ClaudeTurnEvent::Ended {
                    ownership_id: ended_owner,
                    reason,
                    ..
                }) if ended_owner == ownership_id => {
                    tracing::warn!(
                        event = "freshagent.claude.rest_lane.send_ended",
                        session_key,
                        request_id,
                        submitted_turn_id,
                        reason
                    );
                    return Err(retryable_conflict(
                        "FRESH_AGENT_SESSION_ENDED",
                        "Claude stopped before this turn completed; attach the pane and retry",
                    ));
                }
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => tracing::warn!(
                    event = "freshagent.claude.rest_lane.send_lagged",
                    session_key,
                    request_id,
                    skipped
                ),
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    return Err(RestLaneError::new(
                        RestLaneErrorKind::Unavailable,
                        "FRESH_AGENT_EVENTS_UNAVAILABLE",
                        "Claude turn events are unavailable",
                    ))
                }
            }
        }
    })
    .await;
    waited.unwrap_or(Ok(false))
}

#[cfg(test)]
#[path = "claude_rest_lane_tests.rs"]
mod tests;

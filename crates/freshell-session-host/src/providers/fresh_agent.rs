//! Host-owned adapters around the existing provider implementations.
//!
//! Each session-host process serves exactly one soul. Consequently the
//! `FreshAgentState` held here gives OpenCode one `opencode serve` process per
//! soul rather than the web server's legacy shared daemon.

use async_trait::async_trait;
use freshell_agent_runtime::host_actor::{
    DispatchAck, DispatchFailure, FreshAgentHostActor, FreshAgentProfile, FreshAgentTransport,
    TransportStart,
};
use freshell_freshagent::{FreshAgentState, FreshClaudeState, FreshCodexState, FreshOpencodeState};
use freshell_protocol::{
    AgentProvider, FreshAgentApprovalRespond, FreshAgentCreate, FreshAgentInterrupt,
    FreshAgentQuestionRespond, FreshAgentSend, FreshAgentSendSettings, SessionLocator, SessionType,
    StringOrNumber,
};
use freshell_runtime_protocol::{
    AgentEvent, FreshAgentFixtureTransport, FreshAgentLaunchSpec, FreshProvider, RequestId,
};
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio::sync::{broadcast, mpsc, watch, Mutex};

const CREATE_TIMEOUT: Duration = Duration::from_secs(50);
// OpenCode's bounded cold start can consume 20s of health probing plus a 30s
// request budget before the correlated acceptance edge exists. Stay below the
// supervisor's 60s hosted-agent command envelope while covering that bound.
const SEND_ACK_TIMEOUT: Duration = Duration::from_secs(55);
const EVENT_CHANNEL_CAPACITY: usize = 256;

enum ProviderState {
    Claude(FreshClaudeState),
    Codex(FreshCodexState),
    Opencode {
        runtime: FreshOpencodeState,
        owner: FreshAgentState,
    },
}

struct HostedTransport {
    provider: FreshProvider,
    state: ProviderState,
    profile: std::sync::Mutex<Option<FreshAgentProfile>>,
    session_id: Mutex<Option<String>>,
    created_rx: Mutex<watch::Receiver<Option<Result<String, ()>>>>,
    native_rx: Mutex<watch::Receiver<Option<String>>>,
    send_outcomes: broadcast::Sender<(String, bool)>,
    event_rx: std::sync::Mutex<Option<mpsc::Receiver<AgentEvent>>>,
}

pub(crate) async fn open_hosted_fresh_agent(
    _incarnation_state_dir: &std::path::Path,
    launch: FreshAgentLaunchSpec,
) -> Result<Arc<FreshAgentHostActor>, String> {
    let profile = FreshAgentProfile {
        provider: launch.provider.clone(),
        runtime_variant: launch.runtime_variant,
        cwd: launch.cwd,
        model: launch.model,
        effort: launch.effort,
        permission_mode: launch.permission_mode,
        sandbox: launch.sandbox,
        provider_store_id: launch.provider_store_id,
        native_session_id: launch.native_session_id,
    };
    let transport: Arc<dyn FreshAgentTransport> = match launch.fixture_transport {
        None => HostedTransport::new(launch.provider).await,
        Some(FreshAgentFixtureTransport::Deterministic) => {
            deterministic_transport(&profile, launch.run_as_uid, launch.run_as_gid).await?
        }
    };
    // This path is on the soul's provider volume, not the incarnation runtime
    // directory. It therefore preserves the one-writer command and decision
    // journal across a session-host replacement without sharing state between
    // souls.
    FreshAgentHostActor::open(
        "/home/freshell/provider/.freshell-host-actor",
        profile,
        transport,
    )
    .await
    .map_err(|error| error.to_string())
}

#[cfg(feature = "fresh-agent-fixtures")]
async fn deterministic_transport(
    profile: &FreshAgentProfile,
    run_as_uid: u32,
    run_as_gid: u32,
) -> Result<Arc<dyn FreshAgentTransport>, String> {
    Ok(
        super::deterministic_fresh_agent::DeterministicFreshAgentTransport::open(
            "/home/freshell/provider/.freshell-fixture",
            profile,
            run_as_uid,
            run_as_gid,
        )
        .await?,
    )
}

#[cfg(not(feature = "fresh-agent-fixtures"))]
async fn deterministic_transport(
    _profile: &FreshAgentProfile,
    _run_as_uid: u32,
    _run_as_gid: u32,
) -> Result<Arc<dyn FreshAgentTransport>, String> {
    Err("deterministic fresh-agent transport is absent from this session-host build".into())
}

impl HostedTransport {
    async fn new(provider: FreshProvider) -> Arc<Self> {
        let (broadcast_tx, broadcast_rx) = broadcast::channel(1024);
        let broadcast_tx = Arc::new(broadcast_tx);
        let state = match provider {
            FreshProvider::Claude | FreshProvider::Kilroy => {
                ProviderState::Claude(FreshClaudeState::new(Arc::clone(&broadcast_tx)))
            }
            FreshProvider::Codex => ProviderState::Codex(FreshCodexState::new(
                Arc::new("host-internal".into()),
                Arc::clone(&broadcast_tx),
                json!({"freshAgent":{"enabled":true}}),
            )),
            FreshProvider::Opencode => {
                let owner = FreshAgentState::new(
                    Arc::new("host-internal".into()),
                    Arc::clone(&broadcast_tx),
                );
                ProviderState::Opencode {
                    runtime: FreshOpencodeState::new(owner.clone()),
                    owner,
                }
            }
        };
        let (created_tx, created_rx) = watch::channel(None);
        let (native_tx, native_rx) = watch::channel(None);
        let (event_tx, event_rx) = mpsc::channel(EVENT_CHANNEL_CAPACITY);
        let (send_outcomes, _) = broadcast::channel(64);
        spawn_broadcast_bridge(
            provider.clone(),
            broadcast_rx,
            created_tx,
            native_tx,
            event_tx,
            send_outcomes.clone(),
        );
        Arc::new(Self {
            provider,
            state,
            profile: std::sync::Mutex::new(None),
            session_id: Mutex::new(None),
            created_rx: Mutex::new(created_rx),
            native_rx: Mutex::new(native_rx),
            send_outcomes,
            event_rx: std::sync::Mutex::new(Some(event_rx)),
        })
    }

    fn provider_wire(&self) -> AgentProvider {
        match self.provider {
            FreshProvider::Claude | FreshProvider::Kilroy => AgentProvider::Claude,
            FreshProvider::Codex => AgentProvider::Codex,
            FreshProvider::Opencode => AgentProvider::Opencode,
        }
    }

    fn session_type(&self) -> SessionType {
        match self.provider {
            FreshProvider::Claude => SessionType::Freshclaude,
            FreshProvider::Kilroy => SessionType::Kilroy,
            FreshProvider::Codex => SessionType::Freshcodex,
            FreshProvider::Opencode => SessionType::Freshopencode,
        }
    }

    async fn wait_created(&self) -> Result<String, String> {
        let mut receiver = self.created_rx.lock().await;
        tokio::time::timeout(CREATE_TIMEOUT, async {
            loop {
                if let Some(result) = receiver.borrow().clone() {
                    return result.map_err(|_| "provider create rejected".to_string());
                }
                receiver
                    .changed()
                    .await
                    .map_err(|_| "provider create channel closed".to_string())?;
            }
        })
        .await
        .map_err(|_| "provider create timed out".to_string())?
    }

    async fn wait_exact_native(&self, expected: &str) -> Result<String, String> {
        let mut receiver = self.native_rx.lock().await;
        tokio::time::timeout(CREATE_TIMEOUT, async {
            loop {
                if let Some(observed) = receiver.borrow().clone() {
                    return if observed == expected {
                        Ok(observed)
                    } else {
                        Err("provider resumed a different native session".into())
                    };
                }
                receiver
                    .changed()
                    .await
                    .map_err(|_| "provider identity channel closed".to_string())?;
            }
        })
        .await
        .map_err(|_| "provider did not verify resumed native identity".to_string())?
    }
}

#[async_trait]
impl FreshAgentTransport for HostedTransport {
    async fn start(&self, profile: &FreshAgentProfile) -> Result<TransportStart, String> {
        *self.profile.lock().expect("profile lock") = Some(profile.clone());
        let session_ref = profile
            .native_session_id
            .as_ref()
            .map(|session_id| SessionLocator {
                provider: match self.provider {
                    FreshProvider::Claude | FreshProvider::Kilroy => "claude",
                    FreshProvider::Codex => "codex",
                    FreshProvider::Opencode => "opencode",
                }
                .into(),
                session_id: session_id.clone(),
            });
        let create = FreshAgentCreate {
            request_id: format!("host-create-{}", uuid::Uuid::new_v4()),
            session_type: self.session_type(),
            cwd: Some(profile.cwd.clone()),
            effort: profile.effort.clone(),
            legacy_restore_context: None,
            model: profile.model.clone(),
            model_selection: None,
            permission_mode: profile.permission_mode.clone(),
            plugins: None,
            provider: Some(self.provider_wire()),
            resume_session_id: None,
            sandbox: profile.sandbox.as_deref().and_then(parse_sandbox),
            session_ref,
            tab_id: None,
        };
        match &self.state {
            ProviderState::Claude(state) => state.handle_create(create, None).await,
            ProviderState::Codex(state) => state.handle_create(create, None).await,
            ProviderState::Opencode { runtime, .. } => runtime.handle_create(create, None).await,
        }
        let session_id = self.wait_created().await?;
        *self.session_id.lock().await = Some(session_id.clone());
        let native_session_id = match profile.native_session_id.as_deref() {
            Some(expected) => Some(self.wait_exact_native(expected).await?),
            None if matches!(self.provider, FreshProvider::Codex) => Some(session_id),
            None if matches!(self.provider, FreshProvider::Claude | FreshProvider::Kilroy) => {
                let mut receiver = self.native_rx.lock().await;
                Some(
                    tokio::time::timeout(CREATE_TIMEOUT, async {
                        loop {
                            if let Some(observed) = receiver.borrow().clone() {
                                return Ok::<_, String>(observed);
                            }
                            receiver
                                .changed()
                                .await
                                .map_err(|_| "provider identity channel closed".to_string())?;
                        }
                    })
                    .await
                    .map_err(|_| "provider did not materialize native identity".to_string())??,
                )
            }
            None => None,
        };
        Ok(TransportStart { native_session_id })
    }

    async fn dispatch(
        &self,
        request_id: &RequestId,
        text: &str,
        profile: &FreshAgentProfile,
    ) -> Result<DispatchAck, DispatchFailure> {
        let session_id = self
            .session_id
            .lock()
            .await
            .clone()
            .ok_or_else(|| DispatchFailure {
                message: "fresh-agent session is not started".into(),
                acceptance_ambiguous: false,
            })?;
        *self.profile.lock().expect("profile lock") = Some(profile.clone());
        let profile = profile.clone();
        let mut outcomes = self.send_outcomes.subscribe();
        let send = FreshAgentSend {
            provider: self.provider_wire(),
            session_id,
            session_type: self.session_type(),
            text: text.to_string(),
            cwd: Some(profile.cwd.clone()),
            images: None,
            request_id: Some(request_id.as_str().to_string()),
            settings: Some(FreshAgentSendSettings {
                cwd: Some(profile.cwd),
                effort: profile.effort,
                model: profile.model,
                permission_mode: profile.permission_mode,
                sandbox: profile.sandbox.as_deref().and_then(parse_sandbox),
            }),
        };
        match &self.state {
            ProviderState::Claude(state) => state.handle_send(send).await,
            ProviderState::Codex(state) => state.handle_send(send).await,
            ProviderState::Opencode { runtime, .. } => runtime.handle_send(send).await,
        }
        match tokio::time::timeout(SEND_ACK_TIMEOUT, async {
            loop {
                match outcomes.recv().await {
                    Ok((observed, accepted)) if observed == request_id.as_str() => {
                        return Ok(accepted)
                    }
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => {
                        return Err("provider event stream closed")
                    }
                }
            }
        })
        .await
        {
            Ok(Ok(true)) => Ok(DispatchAck {
                provider_ack_id: Some(request_id.as_str().to_string()),
            }),
            Ok(Ok(false)) => Err(DispatchFailure {
                message: "provider rejected input before acceptance".into(),
                acceptance_ambiguous: false,
            }),
            Ok(Err(message)) => Err(DispatchFailure {
                message: message.into(),
                acceptance_ambiguous: true,
            }),
            Err(_) => Err(DispatchFailure {
                message: "provider acceptance acknowledgement timed out".into(),
                acceptance_ambiguous: true,
            }),
        }
    }

    async fn resolve_permission(
        &self,
        decision_id: &str,
        decision: Value,
    ) -> Result<(), DispatchFailure> {
        let session_id = self
            .session_id
            .lock()
            .await
            .clone()
            .ok_or_else(|| DispatchFailure {
                message: "fresh-agent session is not started".into(),
                acceptance_ambiguous: false,
            })?;
        let request_id = StringOrNumber::Str(decision_id.to_string());
        if let Some(answers) = decision.get("answers").and_then(Value::as_object) {
            let answers = answers
                .iter()
                .filter_map(|(key, value)| value.as_str().map(|value| (key.clone(), value.into())))
                .collect::<BTreeMap<_, _>>();
            let message = FreshAgentQuestionRespond {
                provider: self.provider_wire(),
                session_id,
                session_type: self.session_type(),
                answers,
                request_id,
                cwd: None,
            };
            match &self.state {
                ProviderState::Claude(state) => state.handle_question_respond(message).await,
                ProviderState::Codex(state) => state.handle_question_respond(message).await,
                ProviderState::Opencode { .. } => {
                    return Err(DispatchFailure {
                        message: "provider has no question flow".into(),
                        acceptance_ambiguous: false,
                    });
                }
            }
        } else {
            let message = FreshAgentApprovalRespond {
                provider: self.provider_wire(),
                session_id,
                session_type: self.session_type(),
                decision,
                request_id,
                cwd: None,
            };
            match &self.state {
                ProviderState::Claude(state) => state.handle_approval_respond(message).await,
                ProviderState::Codex(state) => state.handle_approval_respond(message).await,
                ProviderState::Opencode { .. } => {
                    return Err(DispatchFailure {
                        message: "provider has no approval flow".into(),
                        acceptance_ambiguous: false,
                    });
                }
            }
        }
        Ok(())
    }

    async fn interrupt(&self) -> Result<(), String> {
        let session_id = self
            .session_id
            .lock()
            .await
            .clone()
            .ok_or_else(|| "fresh-agent session is not started".to_string())?;
        let message = FreshAgentInterrupt {
            provider: self.provider_wire(),
            session_id,
            session_type: self.session_type(),
            cwd: None,
        };
        match &self.state {
            ProviderState::Claude(state) => state.handle_interrupt(message).await,
            ProviderState::Codex(state) => state.handle_interrupt(message).await,
            ProviderState::Opencode { runtime, .. } => runtime.handle_interrupt(message).await,
        }
        Ok(())
    }

    async fn is_live(&self) -> bool {
        let Some(session_id) = self.session_id.lock().await.clone() else {
            return false;
        };
        match &self.state {
            ProviderState::Claude(state) => state.has_live_session(&session_id).await,
            ProviderState::Codex(state) => state.has_live_session(&session_id).await,
            ProviderState::Opencode { runtime, .. } => runtime.has_live_session(&session_id).await,
        }
    }

    async fn stop(self: Arc<Self>) -> Result<(), String> {
        match &self.state {
            ProviderState::Claude(state) => state.shutdown().await,
            ProviderState::Codex(state) => state.shutdown().await,
            ProviderState::Opencode { owner, .. } => owner.shutdown().await,
        }
        Ok(())
    }

    fn take_event_stream(&self) -> Option<mpsc::Receiver<AgentEvent>> {
        self.event_rx.lock().expect("event receiver lock").take()
    }
}

fn spawn_broadcast_bridge(
    provider: FreshProvider,
    mut receiver: broadcast::Receiver<String>,
    created: watch::Sender<Option<Result<String, ()>>>,
    native: watch::Sender<Option<String>>,
    events: mpsc::Sender<AgentEvent>,
    send_outcomes: broadcast::Sender<(String, bool)>,
) {
    tokio::spawn(async move {
        let mut dropped = 0u64;
        loop {
            let frame = match receiver.recv().await {
                Ok(frame) => frame,
                Err(broadcast::error::RecvError::Lagged(count)) => {
                    dropped = dropped.saturating_add(count);
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => break,
            };
            let Ok(value) = serde_json::from_str::<Value>(&frame) else {
                continue;
            };
            if let Some(outcome) = parse_send_outcome(&value) {
                let _ = send_outcomes.send(outcome);
            }
            if value.get("type").and_then(Value::as_str) == Some("freshAgent.create.failed") {
                let _ = created.send(Some(Err(())));
            }
            if value.get("type").and_then(Value::as_str) == Some("freshAgent.created") {
                if let Some(session_id) = value.get("sessionId").and_then(Value::as_str) {
                    let _ = created.send(Some(Ok(session_id.to_string())));
                    if matches!(provider, FreshProvider::Codex)
                        || (matches!(provider, FreshProvider::Opencode)
                            && session_id.starts_with("ses_"))
                    {
                        let _ = native.send(Some(session_id.to_string()));
                    }
                }
            }
            if value.get("type").and_then(Value::as_str) == Some("freshAgent.session.materialized")
            {
                if let Some(session_id) = value.get("sessionId").and_then(Value::as_str) {
                    let _ = native.send(Some(session_id.to_string()));
                    if events
                        .send(AgentEvent::Started {
                            native_session_id: session_id.to_string(),
                        })
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
            let mut captured_decision = false;
            if let Some(event) = value.get("event") {
                let event_type = event
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if event_type == "sdk.session.init" {
                    if let Some(session_id) = event
                        .get("cliSessionId")
                        .or_else(|| event.get("sessionId"))
                        .and_then(Value::as_str)
                    {
                        let _ = native.send(Some(session_id.to_string()));
                        if events
                            .send(AgentEvent::Started {
                                native_session_id: session_id.to_string(),
                            })
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                }
                if event_type.contains("permission.request")
                    || event_type.contains("question.request")
                {
                    if let Some(request_id) = event.get("requestId").and_then(|value| match value {
                        Value::String(value) => Some(value.clone()),
                        Value::Number(value) => Some(value.to_string()),
                        _ => None,
                    }) {
                        if events
                            .send(AgentEvent::PermissionRequested {
                                decision_id: request_id,
                                payload: event.clone(),
                            })
                            .await
                            .is_err()
                        {
                            break;
                        }
                        captured_decision = true;
                    }
                }
            }
            if dropped > 0 {
                if events
                    .try_send(AgentEvent::Provider {
                        payload: json!({"type":"freshAgent.host.backpressure","dropped":dropped}),
                    })
                    .is_ok()
                {
                    dropped = 0;
                }
            }
            if captured_decision {
                continue;
            }
            if events
                .try_send(AgentEvent::Provider { payload: value })
                .is_err()
            {
                dropped = dropped.saturating_add(1);
            }
        }
    });
}

fn parse_sandbox(value: &str) -> Option<freshell_protocol::Sandbox> {
    match value {
        "read-only" | "readOnly" | "readonly" => Some(freshell_protocol::Sandbox::ReadOnly),
        "workspace-write" | "workspaceWrite" | "workspacewrite" => {
            Some(freshell_protocol::Sandbox::WorkspaceWrite)
        }
        "danger-full-access" | "dangerFullAccess" | "dangerfullaccess" => {
            Some(freshell_protocol::Sandbox::DangerFullAccess)
        }
        _ => None,
    }
}

fn parse_send_outcome(value: &Value) -> Option<(String, bool)> {
    let event_type = value.get("type")?.as_str()?;
    let request_id = value.get("requestId").and_then(|value| match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    })?;
    match event_type {
        "freshAgent.send.accepted" => Some((request_id, true)),
        "error" => Some((request_id, false)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn send_acceptance_parser_is_correlated_and_fail_closed() {
        assert_eq!(
            parse_send_outcome(&json!({
                "type":"freshAgent.send.accepted",
                "requestId":"request-1"
            })),
            Some(("request-1".into(), true))
        );
        assert_eq!(
            parse_send_outcome(&json!({"type":"error","requestId":"request-1"})),
            Some(("request-1".into(), false))
        );
        assert_eq!(
            parse_send_outcome(&json!({"type":"freshAgent.send.accepted"})),
            None
        );
    }

    #[test]
    fn persisted_sandbox_names_materialize_on_initial_provider_create() {
        assert_eq!(
            parse_sandbox("read-only"),
            Some(freshell_protocol::Sandbox::ReadOnly)
        );
        assert_eq!(
            parse_sandbox("workspace-write"),
            Some(freshell_protocol::Sandbox::WorkspaceWrite)
        );
        assert_eq!(
            parse_sandbox("danger-full-access"),
            Some(freshell_protocol::Sandbox::DangerFullAccess)
        );
        assert_eq!(parse_sandbox("unknown"), None);
    }
}

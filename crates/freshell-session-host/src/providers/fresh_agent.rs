//! Host-owned adapters around the existing provider implementations.
//!
//! Each session-host process serves exactly one soul. Consequently the
//! `FreshAgentState` held here gives OpenCode one `opencode serve` process per
//! soul rather than the web server's legacy shared daemon.

use async_trait::async_trait;
use freshell_agent_runtime::host_actor::{
    DispatchAck, DispatchFailure, ForkTransition, FreshAgentHostActor, FreshAgentOperation,
    FreshAgentProfile, FreshAgentTransport, OperationAck, OperationFailure, OperationFailureKind,
    TransportStart,
};
use freshell_freshagent::rollback_record::{RollbackDirection, RollbackModeReq, RollbackRequest};
use freshell_freshagent::{FreshAgentState, FreshClaudeState, FreshCodexState, FreshOpencodeState};
use freshell_protocol::{
    AgentProvider, FreshAgentApprovalRespond, FreshAgentCompact, FreshAgentCreate, FreshAgentFork,
    FreshAgentInterrupt, FreshAgentKill, FreshAgentQuestionRespond, FreshAgentSend,
    FreshAgentSendSettings, ServerMessage, SessionLocator, SessionType, StringOrNumber,
};
use freshell_runtime_protocol::{
    AgentEvent, FreshAgentCapture, FreshAgentFixtureTransport, FreshAgentLaunchSpec,
    FreshAgentRollbackDirection, FreshAgentRollbackMode, FreshProvider, RequestId,
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    sync::Arc,
    time::Duration,
};
use tokio::sync::{broadcast, mpsc, oneshot, watch, Mutex};

const CREATE_TIMEOUT: Duration = Duration::from_secs(50);
// OpenCode's bounded cold start can consume 20s of health probing plus a 30s
// request budget before the correlated acceptance edge exists. Stay below the
// supervisor's 60s hosted-agent command envelope while covering that bound.
const SEND_ACK_TIMEOUT: Duration = Duration::from_secs(55);
const FORK_TIMEOUT: Duration = Duration::from_secs(55);
const RETIRE_TIMEOUT: Duration = Duration::from_secs(20);
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
    kill_outcomes: broadcast::Sender<(String, bool)>,
    suppressed_kills: Arc<std::sync::Mutex<HashSet<String>>>,
    event_tx: mpsc::Sender<AgentEvent>,
    event_rx: std::sync::Mutex<Option<mpsc::Receiver<AgentEvent>>>,
}

pub(crate) async fn open_hosted_fresh_agent(
    incarnation_state_dir: &std::path::Path,
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
    // Actor command/decision state is trusted control-plane state. Never put
    // it under provider-owned HOME: provider code must not be able to mutate
    // idempotency or permission decisions. The incarnation runtime directory
    // survives a host-process restart; cross-incarnation recovery is fenced by
    // the supervisor journal plus exact provider-native state.
    FreshAgentHostActor::open(
        hosted_actor_state_dir(incarnation_state_dir),
        profile,
        transport,
    )
    .await
    .map_err(|error| error.to_string())
}

fn hosted_actor_state_dir(incarnation_state_dir: &std::path::Path) -> std::path::PathBuf {
    incarnation_state_dir.join("fresh-agent")
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
        let (kill_outcomes, _) = broadcast::channel(64);
        let suppressed_kills = Arc::new(std::sync::Mutex::new(HashSet::new()));
        spawn_broadcast_bridge(
            provider.clone(),
            broadcast_rx,
            created_tx,
            native_tx,
            event_tx.clone(),
            send_outcomes.clone(),
            kill_outcomes.clone(),
            Arc::clone(&suppressed_kills),
        );
        Arc::new(Self {
            provider,
            state,
            profile: std::sync::Mutex::new(None),
            session_id: Mutex::new(None),
            created_rx: Mutex::new(created_rx),
            native_rx: Mutex::new(native_rx),
            send_outcomes,
            kill_outcomes,
            suppressed_kills,
            event_tx,
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

    async fn provider_session_is_live(&self, session_id: &str) -> bool {
        match &self.state {
            ProviderState::Claude(state) => state.has_live_session(session_id).await,
            ProviderState::Codex(state) => state.has_live_session(session_id).await,
            ProviderState::Opencode { runtime, .. } => runtime.has_live_session(session_id).await,
        }
    }

    async fn retire_provider_session(&self, session_id: &str) -> Result<(), DispatchFailure> {
        let mut outcomes = self.kill_outcomes.subscribe();
        self.suppressed_kills
            .lock()
            .expect("suppressed kill lock")
            .insert(session_id.to_string());
        let message = FreshAgentKill {
            provider: self.provider_wire(),
            session_id: session_id.to_string(),
            session_type: self.session_type(),
            cwd: self
                .profile
                .lock()
                .expect("profile lock")
                .as_ref()
                .map(|profile| profile.cwd.clone()),
        };
        match &self.state {
            ProviderState::Claude(state) => state.handle_kill(message).await,
            ProviderState::Codex(state) => state.handle_kill(message).await,
            ProviderState::Opencode { runtime, .. } => runtime.handle_kill(message).await,
        }
        let observed = tokio::time::timeout(RETIRE_TIMEOUT, async {
            loop {
                match outcomes.recv().await {
                    Ok((id, success)) if id == session_id => return Some(success),
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => return None,
                }
            }
        })
        .await
        .ok()
        .flatten();
        let live = self.provider_session_is_live(session_id).await;
        if !live {
            self.suppressed_kills
                .lock()
                .expect("suppressed kill lock")
                .remove(session_id);
            return Ok(());
        }
        self.suppressed_kills
            .lock()
            .expect("suppressed kill lock")
            .remove(session_id);
        Err(DispatchFailure {
            message: match observed {
                Some(false) => "provider-native session retirement was refused",
                _ => "provider-native session retirement could not be verified",
            }
            .into(),
            acceptance_ambiguous: observed.is_none(),
        })
    }

    async fn current_native_id(&self) -> Result<String, String> {
        if let Some(native) = self.native_rx.lock().await.borrow().clone() {
            return Ok(native);
        }
        let profile_native = self
            .profile
            .lock()
            .expect("profile lock")
            .as_ref()
            .and_then(|profile| profile.native_session_id.clone());
        match profile_native {
            Some(native) => Ok(native),
            None => self
                .session_id
                .lock()
                .await
                .clone()
                .ok_or_else(|| "fresh-agent session is not started".to_string()),
        }
    }

    async fn snapshot_value(&self) -> Result<Value, String> {
        let native_id = self.current_native_id().await?;
        let cwd = self
            .profile
            .lock()
            .expect("profile lock")
            .as_ref()
            .map(|profile| profile.cwd.clone());
        match &self.state {
            ProviderState::Claude(state) => {
                state.get_snapshot(self.session_type(), &native_id).await
            }
            ProviderState::Codex(state) => state
                .get_snapshot(&native_id, cwd.as_deref())
                .await
                .map_err(|_| "codex snapshot unavailable".to_string()),
            ProviderState::Opencode { owner, .. } => owner
                .get_opencode_snapshot(&native_id, cwd.as_deref())
                .await
                .map_err(|_| "opencode snapshot unavailable".to_string()),
        }
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

    async fn fork(
        &self,
        request_id: &RequestId,
        parent_session_id: &str,
        input: Option<Value>,
    ) -> Result<ForkTransition, DispatchFailure> {
        let current = self
            .session_id
            .lock()
            .await
            .clone()
            .ok_or_else(|| DispatchFailure {
                message: "fresh-agent session is not started".into(),
                acceptance_ambiguous: false,
            })?;
        if current != parent_session_id {
            return Err(DispatchFailure {
                message: "provider-native fork parent no longer matches the owned session".into(),
                acceptance_ambiguous: false,
            });
        }
        if matches!(self.provider, FreshProvider::Claude | FreshProvider::Kilroy) {
            return Err(DispatchFailure {
                message: "provider-native conversation fork is unsupported".into(),
                acceptance_ambiguous: false,
            });
        }
        let message = FreshAgentFork {
            provider: self.provider_wire(),
            session_id: current.clone(),
            session_type: self.session_type(),
            input,
            request_id: Some(request_id.as_str().to_string()),
            cwd: self
                .profile
                .lock()
                .expect("profile lock")
                .as_ref()
                .map(|profile| profile.cwd.clone()),
            tab_id: None,
        };
        let (sender, receiver) = oneshot::channel::<ServerMessage>();
        let slot = Arc::new(std::sync::Mutex::new(Some(sender)));
        let sink_slot = Arc::clone(&slot);
        let sink: freshell_terminal::FrameSink = Arc::new(move |frame| {
            if let Some(sender) = sink_slot.lock().expect("fork reply lock").take() {
                let _ = sender.send(frame);
            }
        });
        match &self.state {
            ProviderState::Codex(state) => state.handle_fork(message, None, sink).await,
            ProviderState::Opencode { runtime, .. } => {
                runtime.handle_fork(message, None, sink).await
            }
            ProviderState::Claude(_) => unreachable!("unsupported providers returned above"),
        }
        let forked = match tokio::time::timeout(FORK_TIMEOUT, receiver).await {
            Ok(Ok(ServerMessage::FreshAgentForked(forked))) => forked,
            Ok(Ok(_)) => {
                return Err(DispatchFailure {
                    message: "provider-native fork did not return a fork transition".into(),
                    acceptance_ambiguous: true,
                })
            }
            Ok(Err(_)) | Err(_) => {
                return Err(DispatchFailure {
                    message: "provider-native fork acknowledgement was not observed".into(),
                    acceptance_ambiguous: true,
                })
            }
        };
        if forked.parent_session_id != current
            || forked.session_id.is_empty()
            || forked.session_id == current
            || forked.provider
                != match self.provider {
                    FreshProvider::Claude | FreshProvider::Kilroy => "claude",
                    FreshProvider::Codex => "codex",
                    FreshProvider::Opencode => "opencode",
                }
            || forked.session_type
                != match self.provider {
                    FreshProvider::Claude => "freshclaude",
                    FreshProvider::Kilroy => "kilroy",
                    FreshProvider::Codex => "freshcodex",
                    FreshProvider::Opencode => "freshopencode",
                }
        {
            return Err(DispatchFailure {
                message: "provider-native fork returned mismatched ownership identity".into(),
                acceptance_ambiguous: true,
            });
        }
        let child = forked.session_id;
        if let Err(parent_error) = self.retire_provider_session(&current).await {
            // Best-effort transactional rollback: if the child can be retired and
            // the parent is still live, the provider-native branch did not become
            // the current product state and a safe explicit retry is possible.
            let child_rollback = self.retire_provider_session(&child).await;
            let parent_still_live = self.provider_session_is_live(&current).await;
            return Err(DispatchFailure {
                message: "provider-native fork could not retire its previous branch".into(),
                acceptance_ambiguous: parent_error.acceptance_ambiguous
                    || child_rollback.is_err()
                    || !parent_still_live,
            });
        }
        *self.session_id.lock().await = Some(child.clone());
        Ok(ForkTransition {
            parent_session_id: current,
            child_session_id: child,
            parent_retired_by_runtime: true,
        })
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

    async fn supports_operation(&self, operation: &FreshAgentOperation) -> Result<bool, String> {
        match operation {
            FreshAgentOperation::Compact { .. } => Ok(true),
            FreshAgentOperation::Rollback {
                direction: FreshAgentRollbackDirection::Redo,
                ..
            } if matches!(self.provider, FreshProvider::Codex) => Ok(false),
            FreshAgentOperation::Rollback { .. } => {
                let snapshot = self.snapshot_value().await?;
                Ok(operation_supported_by_snapshot(operation, &snapshot))
            }
        }
    }

    async fn dispatch_operation(
        &self,
        request_id: &RequestId,
        operation: &FreshAgentOperation,
    ) -> Result<OperationAck, OperationFailure> {
        let session_id = self
            .session_id
            .lock()
            .await
            .clone()
            .ok_or_else(|| OperationFailure {
                kind: OperationFailureKind::Rejected,
                message: "fresh-agent session is not started".into(),
                acceptance_ambiguous: false,
            })?;
        let mut observed_native = None;
        match operation {
            FreshAgentOperation::Compact { instructions, cwd } => {
                let message = FreshAgentCompact {
                    request_id: Some(request_id.as_str().to_string()),
                    provider: self.provider_wire(),
                    session_id,
                    session_type: self.session_type(),
                    cwd: cwd.clone(),
                    instructions: instructions.clone(),
                };
                match &self.state {
                    ProviderState::Claude(state) => state.handle_compact(message).await,
                    ProviderState::Codex(state) => state.handle_compact(message).await,
                    ProviderState::Opencode { runtime, .. } => {
                        runtime.handle_compact(message).await
                    }
                }
            }
            FreshAgentOperation::Rollback {
                direction,
                mode,
                turn_id,
                cwd,
            } => {
                let operation = RollbackRequest {
                    direction: match direction {
                        FreshAgentRollbackDirection::Undo => RollbackDirection::Undo,
                        FreshAgentRollbackDirection::Redo => RollbackDirection::Redo,
                    },
                    mode: match mode {
                        FreshAgentRollbackMode::Step => RollbackModeReq::Step,
                        FreshAgentRollbackMode::ToTurn => RollbackModeReq::ToTurn,
                    },
                    turn_id: turn_id.clone(),
                    session_id,
                    session_type: self.session_type(),
                    provider: self.provider_wire(),
                    request_id: request_id.as_str().to_string(),
                    cwd: cwd.clone(),
                };
                let captured = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
                let captured_sink = Arc::clone(&captured);
                let sink: freshell_terminal::FrameSink = Arc::new(move |frame| {
                    if let Ok(value) = serde_json::to_value(frame) {
                        captured_sink.lock().expect("rollback frames").push(value);
                    }
                });
                match &self.state {
                    ProviderState::Claude(state) => state.handle_rollback(operation, sink).await,
                    ProviderState::Codex(state) => state.handle_rollback(operation, sink).await,
                    ProviderState::Opencode { runtime, .. } => {
                        runtime.handle_rollback(operation, sink).await
                    }
                }
                let frames = captured.lock().expect("rollback frames").clone();
                for payload in &frames {
                    let _ = self
                        .event_tx
                        .send(AgentEvent::Provider {
                            payload: payload.clone(),
                        })
                        .await;
                }
                if let Some(code) = frames.iter().find_map(find_operation_error_code) {
                    return Err(OperationFailure {
                        kind: if code == "UNSUPPORTED_CAPABILITY" {
                            OperationFailureKind::Unsupported
                        } else {
                            OperationFailureKind::Rejected
                        },
                        message: "provider rejected hosted rollback".into(),
                        acceptance_ambiguous: false,
                    });
                }
                observed_native = frames.iter().find_map(find_operation_session_id);
            }
        }
        Ok(OperationAck {
            provider_ack_id: Some(request_id.as_str().to_string()),
            native_session_id: observed_native,
        })
    }

    async fn snapshot(&self) -> Result<Value, String> {
        self.snapshot_value().await
    }

    async fn capture(&self, max_bytes: usize) -> Result<FreshAgentCapture, String> {
        let snapshot = self.snapshot_value().await?;
        let native_session_id = self.current_native_id().await?;
        let presentation_session_id = snapshot
            .get("sessionId")
            .or_else(|| snapshot.get("threadId"))
            .and_then(Value::as_str)
            .unwrap_or(&native_session_id)
            .to_string();
        let (text, truncated) = render_snapshot_text(&snapshot, max_bytes);
        Ok(FreshAgentCapture {
            provider: self.provider.clone(),
            session_type: session_type_wire(self.session_type()).into(),
            presentation_session_id,
            native_session_id,
            text,
            truncated,
        })
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
    kill_outcomes: broadcast::Sender<(String, bool)>,
    suppressed_kills: Arc<std::sync::Mutex<HashSet<String>>>,
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
            if value.get("type").and_then(Value::as_str) == Some("freshAgent.killed") {
                if let (Some(session_id), Some(success)) = (
                    value.get("sessionId").and_then(Value::as_str),
                    value.get("success").and_then(Value::as_bool),
                ) {
                    let _ = kill_outcomes.send((session_id.to_string(), success));
                    if suppressed_kills
                        .lock()
                        .expect("suppressed kill lock")
                        .remove(session_id)
                    {
                        continue;
                    }
                }
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

fn session_type_wire(session_type: SessionType) -> &'static str {
    match session_type {
        SessionType::Freshclaude => "freshclaude",
        SessionType::Freshcodex => "freshcodex",
        SessionType::Kilroy => "kilroy",
        SessionType::Freshopencode => "freshopencode",
    }
}

fn operation_supported_by_snapshot(operation: &FreshAgentOperation, snapshot: &Value) -> bool {
    let capability = match operation {
        FreshAgentOperation::Compact { .. } => return true,
        FreshAgentOperation::Rollback {
            direction: FreshAgentRollbackDirection::Undo,
            ..
        } => "undo",
        FreshAgentOperation::Rollback {
            direction: FreshAgentRollbackDirection::Redo,
            ..
        } => "redo",
    };
    snapshot
        .get("capabilities")
        .and_then(|value| value.get(capability))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn find_operation_error_code(value: &Value) -> Option<&str> {
    if value.get("type").and_then(Value::as_str) == Some("freshAgent.error") {
        return value.get("code").and_then(Value::as_str);
    }
    match value {
        Value::Object(object) => object.values().find_map(find_operation_error_code),
        Value::Array(values) => values.iter().find_map(find_operation_error_code),
        _ => None,
    }
}

fn find_operation_session_id(value: &Value) -> Option<String> {
    if matches!(
        value.get("type").and_then(Value::as_str),
        Some("freshAgent.rolledBack") | Some("freshAgent.redone")
    ) {
        return value
            .get("newSessionId")
            .or_else(|| value.get("sessionId"))
            .and_then(Value::as_str)
            .map(str::to_string);
    }
    match value {
        Value::Object(object) => object.values().find_map(find_operation_session_id),
        Value::Array(values) => values.iter().find_map(find_operation_session_id),
        _ => None,
    }
}

fn render_snapshot_text(snapshot: &Value, max_bytes: usize) -> (String, bool) {
    let mut output = String::new();
    if let Some(turns) = snapshot.get("turns").and_then(Value::as_array) {
        for turn in turns {
            let role = turn
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or("assistant");
            let mut body = Vec::new();
            if let Some(items) = turn.get("items").and_then(Value::as_array) {
                for item in items {
                    if let Some(text) = item.get("text").and_then(Value::as_str) {
                        body.push(text);
                    } else if let Some(command) = item.get("command").and_then(Value::as_str) {
                        body.push(command);
                    } else if let Some(result) = item.get("output").and_then(Value::as_str) {
                        body.push(result);
                    }
                }
            }
            if body.is_empty() {
                if let Some(summary) = turn.get("summary").and_then(Value::as_str) {
                    body.push(summary);
                }
            }
            if !body.is_empty() {
                output.push_str(role);
                output.push_str(": ");
                output.push_str(&body.join("\n"));
                output.push('\n');
            }
        }
    }
    if output.len() <= max_bytes {
        return (output, false);
    }
    let mut boundary = max_bytes;
    while boundary > 0 && !output.is_char_boundary(boundary) {
        boundary -= 1;
    }
    output.truncate(boundary);
    (output, true)
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
    fn trusted_actor_state_is_incarnation_scoped_and_outside_provider_home() {
        let runtime = std::path::Path::new("/run/freshell/incarnation-owned");
        let actor = hosted_actor_state_dir(runtime);
        assert_eq!(actor, runtime.join("fresh-agent"));
        assert!(!actor.starts_with("/home/freshell/provider"));
    }

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

    #[tokio::test]
    async fn lazy_opencode_snapshot_is_writable_before_any_provider_send() {
        let transport = HostedTransport::new(FreshProvider::Opencode).await;
        let profile = FreshAgentProfile {
            provider: FreshProvider::Opencode,
            runtime_variant: "opencode-per-soul-http".into(),
            cwd: std::env::current_dir()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            model: Some("opencode/big-pickle".into()),
            effort: None,
            permission_mode: None,
            sandbox: None,
            provider_store_id: "isolated-test".into(),
            native_session_id: None,
        };
        // Create only allocates an in-memory placeholder; no paid provider or
        // process is started. The snapshot must unlock the real first-send UI.
        let started = transport.start(&profile).await.unwrap();
        assert!(started.native_session_id.is_none());
        let snapshot = transport.snapshot().await.unwrap();
        assert_eq!(snapshot["capabilities"]["send"], true);
        assert_eq!(snapshot["provider"], "opencode");
        assert_eq!(snapshot["sessionType"], "freshopencode");
        assert!(snapshot["threadId"]
            .as_str()
            .unwrap()
            .starts_with("freshopencode-"));
        assert!(snapshot["turns"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn operation_support_matrix_matches_each_hosted_provider() {
        let compact = FreshAgentOperation::Compact {
            instructions: None,
            cwd: None,
        };
        let undo = FreshAgentOperation::Rollback {
            direction: FreshAgentRollbackDirection::Undo,
            mode: FreshAgentRollbackMode::Step,
            turn_id: None,
            cwd: None,
        };
        let redo = FreshAgentOperation::Rollback {
            direction: FreshAgentRollbackDirection::Redo,
            mode: FreshAgentRollbackMode::Step,
            turn_id: None,
            cwd: None,
        };
        for provider in [
            FreshProvider::Claude,
            FreshProvider::Kilroy,
            FreshProvider::Codex,
            FreshProvider::Opencode,
        ] {
            let transport = HostedTransport::new(provider.clone()).await;
            assert_eq!(
                transport.supports_operation(&compact).await,
                Ok(true),
                "{provider:?} compact"
            );
            if provider == FreshProvider::Codex {
                assert_eq!(transport.supports_operation(&redo).await, Ok(false));
            }
            assert!(operation_supported_by_snapshot(
                &undo,
                &json!({"capabilities":{"undo":true,"redo":provider != FreshProvider::Codex}})
            ));
            assert_eq!(
                operation_supported_by_snapshot(
                    &redo,
                    &json!({"capabilities":{"undo":true,"redo":provider != FreshProvider::Codex}})
                ),
                provider != FreshProvider::Codex
            );
        }
    }

    #[test]
    fn rollback_reply_error_parser_handles_nested_event_envelopes() {
        let payload = json!({
            "type":"freshAgent.event",
            "event":{"type":"freshAgent.error","code":"UNSUPPORTED_CAPABILITY"}
        });
        assert_eq!(
            find_operation_error_code(&payload),
            Some("UNSUPPORTED_CAPABILITY")
        );
        assert_eq!(find_operation_error_code(&json!({"type":"ok"})), None);
        assert_eq!(
            find_operation_session_id(&json!({
                "type":"freshAgent.event",
                "event":{
                    "type":"freshAgent.rolledBack",
                    "sessionId":"old-native",
                    "newSessionId":"new-native"
                }
            })),
            Some("new-native".into())
        );
    }

    #[test]
    fn snapshot_text_renderer_is_plain_and_utf8_bounded() {
        let snapshot = json!({"turns":[
            {"role":"user","summary":"ignored","items":[{"kind":"text","text":"héllo"}]},
            {"role":"assistant","summary":"world","items":[]}
        ]});
        let (full, truncated) = render_snapshot_text(&snapshot, 100);
        assert_eq!(full, "user: héllo\nassistant: world\n");
        assert!(!truncated);
        let (short, truncated) = render_snapshot_text(&snapshot, 8);
        assert!(short.len() <= 8);
        assert!(short.is_char_boundary(short.len()));
        assert!(truncated);
    }
}

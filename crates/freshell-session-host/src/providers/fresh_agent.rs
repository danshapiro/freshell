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
use freshell_codex::launch_plan::CodexSidecarLaunchContext;
use freshell_freshagent::rollback_record::{RollbackDirection, RollbackModeReq, RollbackRequest};
use freshell_freshagent::{FreshAgentState, FreshClaudeState, FreshCodexState, FreshOpencodeState};
use freshell_protocol::{
    AgentProvider, FreshAgentApprovalRespond, FreshAgentCompact, FreshAgentCreate, FreshAgentFork,
    FreshAgentInterrupt, FreshAgentKill, FreshAgentQuestionRespond, FreshAgentSend,
    FreshAgentSendSettings, ServerMessage, SessionLocator, SessionType, StringOrNumber,
};
use freshell_runtime_protocol::{
    AgentEvent, FreshAgentCapture, FreshAgentFixtureTransport, FreshAgentLaunchSpec,
    FreshAgentRollbackDirection, FreshAgentRollbackMode, FreshProvider, ProviderLaunchContext,
    ProviderPreparation, RequestId,
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
const HOST_ACTOR_STATE_DIR: &str = "/run/freshell-host-actor";

enum ProviderState {
    Claude(FreshClaudeState),
    Codex(FreshCodexState),
    Opencode {
        runtime: Box<FreshOpencodeState>,
        owner: Box<FreshAgentState>,
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
    #[cfg(test)]
    test_delegate: Option<Arc<dyn FreshAgentTransport>>,
}

pub(crate) async fn open_hosted_fresh_agent(
    _incarnation_state_dir: &std::path::Path,
    launch: FreshAgentLaunchSpec,
) -> Result<Arc<FreshAgentHostActor>, String> {
    let profile = profile_from_launch(&launch);
    let transport: Arc<dyn FreshAgentTransport> = match launch.fixture_transport {
        None => {
            HostedTransport::new_with_context(
                launch.provider,
                profile.provider_launch_context.as_ref(),
            )
            .await
        }
        Some(FreshAgentFixtureTransport::Deterministic) => {
            deterministic_transport(&profile, launch.run_as_uid, launch.run_as_gid).await?
        }
    };
    // The supervisor mounts one protected, per-soul directory here across
    // incarnations. The provider-owned HOME cannot hold the host's command
    // and decision journal: the provider can change HOME permissions.
    FreshAgentHostActor::open(HOST_ACTOR_STATE_DIR, profile, transport)
        .await
        .map_err(|error| error.to_string())
}

fn profile_from_launch(launch: &FreshAgentLaunchSpec) -> FreshAgentProfile {
    FreshAgentProfile {
        provider: launch.provider.clone(),
        runtime_variant: launch.runtime_variant.clone(),
        cwd: launch.cwd.clone(),
        model: launch.model.clone(),
        effort: launch.effort.clone(),
        permission_mode: launch.permission_mode.clone(),
        sandbox: launch.sandbox.clone(),
        provider_store_id: launch.provider_store_id.clone(),
        native_session_id: launch.native_session_id.clone(),
        plugins: launch.plugins.clone(),
        model_selection: launch.model_selection.clone(),
        session_ref: launch.session_ref.clone(),
        provider_launch_context: launch.provider_launch_context.clone(),
        provider_secret_references: launch.provider_secret_references.clone(),
    }
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
    #[cfg(test)]
    async fn new(provider: FreshProvider) -> Arc<Self> {
        Self::new_with_context(provider, None).await
    }

    async fn new_with_context(
        provider: FreshProvider,
        context: Option<&ProviderLaunchContext>,
    ) -> Arc<Self> {
        let (broadcast_tx, broadcast_rx) = broadcast::channel(1024);
        let broadcast_tx = Arc::new(broadcast_tx);
        let state = match provider {
            FreshProvider::Claude | FreshProvider::Kilroy => {
                ProviderState::Claude(FreshClaudeState::new(Arc::clone(&broadcast_tx)))
            }
            FreshProvider::Codex => {
                let sidecar_args = context
                    .and_then(|context| match &context.preparation {
                        ProviderPreparation::Codex { sidecar_args, .. } => {
                            Some(sidecar_args.clone())
                        }
                        _ => None,
                    })
                    .unwrap_or_default();
                ProviderState::Codex(
                    FreshCodexState::new(
                        Arc::new("host-internal".into()),
                        Arc::clone(&broadcast_tx),
                        json!({"freshAgent":{"enabled":true}}),
                    )
                    .with_sidecar_launch_context(CodexSidecarLaunchContext {
                        config_args: sidecar_args,
                        env: Default::default(),
                    }),
                )
            }
            FreshProvider::Opencode => {
                let owner = FreshAgentState::new(
                    Arc::new("host-internal".into()),
                    Arc::clone(&broadcast_tx),
                );
                ProviderState::Opencode {
                    runtime: Box::new(FreshOpencodeState::new(owner.clone())),
                    owner: Box::new(owner),
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
            BroadcastBridgeOutputs {
                created: created_tx,
                native: native_tx,
                events: event_tx.clone(),
                send_outcomes: send_outcomes.clone(),
                kill_outcomes: kill_outcomes.clone(),
                suppressed_kills: Arc::clone(&suppressed_kills),
            },
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
            #[cfg(test)]
            test_delegate: None,
        })
    }

    #[cfg(test)]
    async fn with_test_delegate(
        provider: FreshProvider,
        delegate: Arc<dyn FreshAgentTransport>,
    ) -> Arc<Self> {
        let mut hosted = Self::new_with_context(provider, None).await;
        Arc::get_mut(&mut hosted)
            .expect("new hosted transport has one owner")
            .test_delegate = Some(delegate);
        hosted
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
            observed_epoch: None,
            observed_generation: None,
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
        #[cfg(test)]
        if let Some(delegate) = self.test_delegate.as_ref() {
            // Exercise the production hosted create builder even when the
            // lower provider handler is replaced by the recorder.
            let _provider_create = create_request_for_profile(profile);
            return delegate.start(profile).await;
        }
        *self.profile.lock().expect("profile lock") = Some(profile.clone());
        let create = create_request_for_profile(profile);
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
        #[cfg(test)]
        if let Some(delegate) = self.test_delegate.as_ref() {
            return delegate.dispatch(request_id, text, profile).await;
        }
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
            observed_epoch: None,
            observed_generation: None,
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
        #[cfg(test)]
        if let Some(delegate) = self.test_delegate.as_ref() {
            return delegate.fork(request_id, parent_session_id, input).await;
        }
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
            observed_epoch: None,
            observed_generation: None,
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
        #[cfg(test)]
        if let Some(delegate) = self.test_delegate.as_ref() {
            return delegate.resolve_permission(decision_id, decision).await;
        }
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
        #[cfg(test)]
        if let Some(delegate) = self.test_delegate.as_ref() {
            return delegate.interrupt().await;
        }
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
        #[cfg(test)]
        if let Some(delegate) = self.test_delegate.as_ref() {
            return delegate.supports_operation(operation).await;
        }
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
        #[cfg(test)]
        if let Some(delegate) = self.test_delegate.as_ref() {
            return delegate.dispatch_operation(request_id, operation).await;
        }
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
                    observed_epoch: None,
                    observed_generation: None,
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
                    observed_epoch: None,
                    observed_generation: None,
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

    async fn capture(&self, max_bytes: usize) -> Result<FreshAgentCapture, String> {
        #[cfg(test)]
        if let Some(delegate) = self.test_delegate.as_ref() {
            return delegate.capture(max_bytes).await;
        }
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
        #[cfg(test)]
        if let Some(delegate) = self.test_delegate.as_ref() {
            return delegate.is_live().await;
        }
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
        #[cfg(test)]
        if let Some(delegate) = self.test_delegate.as_ref() {
            return Arc::clone(delegate).stop().await;
        }
        match &self.state {
            ProviderState::Claude(state) => state.shutdown().await,
            ProviderState::Codex(state) => state.shutdown().await,
            ProviderState::Opencode { owner, .. } => owner.shutdown().await,
        }
        Ok(())
    }

    fn take_event_stream(&self) -> Option<mpsc::Receiver<AgentEvent>> {
        #[cfg(test)]
        if let Some(delegate) = self.test_delegate.as_ref() {
            return delegate.take_event_stream();
        }
        self.event_rx.lock().expect("event receiver lock").take()
    }
}

fn create_request_for_profile(profile: &FreshAgentProfile) -> FreshAgentCreate {
    let (provider, session_type, provider_name) = match profile.provider {
        FreshProvider::Claude => (AgentProvider::Claude, SessionType::Freshclaude, "claude"),
        FreshProvider::Kilroy => (AgentProvider::Claude, SessionType::Kilroy, "claude"),
        FreshProvider::Codex => (AgentProvider::Codex, SessionType::Freshcodex, "codex"),
        FreshProvider::Opencode => (
            AgentProvider::Opencode,
            SessionType::Freshopencode,
            "opencode",
        ),
    };
    FreshAgentCreate {
        request_id: format!("host-create-{}", uuid::Uuid::new_v4()),
        observed_epoch: None,
        observed_generation: None,
        naming_handle: None,
        session_type,
        cwd: Some(profile.cwd.clone()),
        effort: profile.effort.clone(),
        legacy_restore_context: None,
        model: profile.model.clone(),
        model_selection: profile.model_selection.as_ref().map(|selection| {
            selection
                .as_ref()
                .map(|selection| freshell_protocol::ModelSelection {
                    kind: selection.kind.clone(),
                    model_id: selection.model_id.clone(),
                })
        }),
        permission_mode: profile.permission_mode.clone(),
        plugins: profile.plugins.clone(),
        provider: Some(provider),
        resume_session_id: None,
        sandbox: profile.sandbox.as_deref().and_then(parse_sandbox),
        session_ref: profile
            .session_ref
            .as_ref()
            .map(|reference| SessionLocator {
                provider: reference.provider.clone(),
                session_id: reference.session_id.clone(),
            })
            .or_else(|| {
                profile
                    .native_session_id
                    .as_ref()
                    .map(|session_id| SessionLocator {
                        provider: provider_name.into(),
                        session_id: session_id.clone(),
                    })
            }),
        tab_id: None,
    }
}

struct BroadcastBridgeOutputs {
    created: watch::Sender<Option<Result<String, ()>>>,
    native: watch::Sender<Option<String>>,
    events: mpsc::Sender<AgentEvent>,
    send_outcomes: broadcast::Sender<(String, bool)>,
    kill_outcomes: broadcast::Sender<(String, bool)>,
    suppressed_kills: Arc<std::sync::Mutex<HashSet<String>>>,
}

fn spawn_broadcast_bridge(
    provider: FreshProvider,
    mut receiver: broadcast::Receiver<String>,
    outputs: BroadcastBridgeOutputs,
) {
    let BroadcastBridgeOutputs {
        created,
        native,
        events,
        send_outcomes,
        kill_outcomes,
        suppressed_kills,
    } = outputs;
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
            if dropped > 0
                && events
                    .try_send(AgentEvent::Provider {
                        payload: json!({"type":"freshAgent.host.backpressure","dropped":dropped}),
                    })
                    .is_ok()
            {
                dropped = 0;
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

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct TransportObservation {
        route: String,
        operation: String,
        input: Value,
        result: String,
    }

    #[derive(Default)]
    struct ParityTrace {
        route: std::sync::Mutex<String>,
        observations: std::sync::Mutex<Vec<TransportObservation>>,
        native_session_id: std::sync::Mutex<Option<String>>,
    }

    impl ParityTrace {
        fn record(&self, operation: &str, input: Value, result: impl Into<String>) {
            self.observations
                .lock()
                .unwrap()
                .push(TransportObservation {
                    route: self.route.lock().unwrap().clone(),
                    operation: operation.into(),
                    input,
                    result: result.into(),
                });
        }

        fn rows(&self, route: &str) -> Vec<TransportObservation> {
            self.observations
                .lock()
                .unwrap()
                .iter()
                .filter(|row| row.route == route)
                .cloned()
                .collect()
        }
    }

    /// Deterministic implementation of the shared provider transport
    /// interface. The direct fixture calls this boundary directly; the hosted
    /// fixture drives it through the production HostedTransport wrapper and
    /// FreshAgentHostActor via the test delegate seam.
    struct ParityFixtureTransport {
        provider: FreshProvider,
        trace: Arc<ParityTrace>,
    }

    impl ParityFixtureTransport {
        fn native_id(&self, profile: &FreshAgentProfile) -> String {
            self.trace
                .native_session_id
                .lock()
                .unwrap()
                .clone()
                .or_else(|| profile.native_session_id.clone())
                .unwrap_or_else(|| format!("native-{}", self.provider.as_str()))
        }

        fn supports(&self, operation: &FreshAgentOperation) -> bool {
            let supported = !matches!(
                (self.provider.clone(), operation),
                (
                    FreshProvider::Codex,
                    FreshAgentOperation::Rollback {
                        direction: FreshAgentRollbackDirection::Redo,
                        ..
                    }
                )
            );
            let name = match operation {
                FreshAgentOperation::Compact { .. } => "compact",
                FreshAgentOperation::Rollback {
                    direction: FreshAgentRollbackDirection::Undo,
                    ..
                } => "rollback_undo",
                FreshAgentOperation::Rollback {
                    direction: FreshAgentRollbackDirection::Redo,
                    ..
                } => "rollback_redo",
            };
            self.trace.record(
                name,
                json!({"phase":"support","operation":name}),
                if supported {
                    "supported"
                } else {
                    "unsupported"
                },
            );
            supported
        }

        fn unsupported(&self, operation: &str) -> bool {
            matches!(
                (self.provider.clone(), operation),
                (FreshProvider::Claude, "fork")
                    | (FreshProvider::Opencode, "approval" | "question")
            )
        }
    }

    #[async_trait]
    impl FreshAgentTransport for ParityFixtureTransport {
        async fn start(&self, profile: &FreshAgentProfile) -> Result<TransportStart, String> {
            let native_session_id = self.native_id(profile);
            let expected = profile.native_session_id.as_deref();
            let result = if expected.is_some_and(|expected| expected != native_session_id) {
                "identity_mismatch"
            } else {
                *self.trace.native_session_id.lock().unwrap() = Some(native_session_id.clone());
                "ok"
            };
            let mut provider_context = serde_json::to_value(&profile.provider_launch_context)
                .expect("provider context serializes");
            if let Some(context) = provider_context.as_object_mut() {
                context.remove("mcpCapability");
            }
            let provider_mcp_enabled =
                profile
                    .provider_launch_context
                    .as_ref()
                    .is_some_and(|context| match &context.preparation {
                        ProviderPreparation::Claude { mcp_args } => !mcp_args.is_empty(),
                        ProviderPreparation::Codex {
                            tui_args,
                            sidecar_args,
                        } => !tui_args.is_empty() || !sidecar_args.is_empty(),
                        ProviderPreparation::Opencode {
                            tui_config,
                            project_config,
                            ..
                        } => {
                            tui_config.is_some()
                                || project_config
                                    .iter()
                                    .any(|file| file.relative_path.contains("freshell-mcp"))
                        }
                        ProviderPreparation::Amplifier { .. } => false,
                    });
            let recorded_result = if result == "identity_mismatch" {
                result.to_string()
            } else {
                format!("native:{native_session_id}")
            };
            self.trace.record(
                "create_resume",
                json!({
                    "provider": self.provider.as_str(),
                    "cwd": profile.cwd,
                    "model": profile.model,
                    "effort": profile.effort,
                    "permissionMode": profile.permission_mode,
                    "sandbox": profile.sandbox,
                    "plugins": profile.plugins,
                    "modelSelection": profile.model_selection,
                    "sessionRef": profile.session_ref,
                    "providerLaunchContext": provider_context,
                    "providerMcpEnabled": provider_mcp_enabled,
                    "providerMcpCapability": if provider_mcp_enabled { "present" } else { "absent" },
                    "providerSecretReferences": profile.provider_secret_references,
                    "nativeSessionId": profile.native_session_id,
                }),
                recorded_result,
            );
            if result == "identity_mismatch" {
                return Err("fixture resumed a different native identity".into());
            }
            Ok(TransportStart {
                native_session_id: Some(native_session_id),
            })
        }

        async fn dispatch(
            &self,
            request_id: &RequestId,
            text: &str,
            _profile: &FreshAgentProfile,
        ) -> Result<DispatchAck, DispatchFailure> {
            self.trace.record(
                "send",
                json!({"requestId":request_id.as_str(),"text":text}),
                format!("accepted:{}", request_id.as_str()),
            );
            Ok(DispatchAck {
                provider_ack_id: Some(request_id.as_str().into()),
            })
        }

        async fn resolve_permission(
            &self,
            decision_id: &str,
            decision: Value,
        ) -> Result<(), DispatchFailure> {
            let operation = if decision.get("answers").is_some() {
                "question"
            } else {
                "approval"
            };
            let unsupported = self.unsupported(operation);
            self.trace.record(
                operation,
                json!({"decisionId":decision_id,"decision":decision}),
                if unsupported {
                    String::from("unsupported")
                } else {
                    String::from("resolved")
                },
            );
            if unsupported {
                return Err(DispatchFailure {
                    message: format!("fixture provider does not support {operation}"),
                    acceptance_ambiguous: false,
                });
            }
            Ok(())
        }

        async fn fork(
            &self,
            request_id: &RequestId,
            parent_session_id: &str,
            input: Option<Value>,
        ) -> Result<ForkTransition, DispatchFailure> {
            let unsupported = self.unsupported("fork");
            if unsupported {
                self.trace.record(
                    "fork",
                    json!({"requestId":request_id.as_str(),"parentSessionId":parent_session_id,"input":input}),
                    "unsupported",
                );
                return Err(DispatchFailure {
                    message: "fixture provider-native fork is unsupported".into(),
                    acceptance_ambiguous: false,
                });
            }
            let child = format!("{parent_session_id}-fork");
            self.trace.record(
                "fork",
                json!({"requestId":request_id.as_str(),"parentSessionId":parent_session_id,"input":input}),
                format!("child:{child}"),
            );
            *self.trace.native_session_id.lock().unwrap() = Some(child.clone());
            Ok(ForkTransition {
                parent_session_id: parent_session_id.into(),
                child_session_id: child,
                parent_retired_by_runtime: true,
            })
        }

        async fn interrupt(&self) -> Result<(), String> {
            self.trace.record("interrupt", json!({}), "ok");
            Ok(())
        }

        async fn supports_operation(
            &self,
            operation: &FreshAgentOperation,
        ) -> Result<bool, String> {
            Ok(self.supports(operation))
        }

        async fn dispatch_operation(
            &self,
            request_id: &RequestId,
            operation: &FreshAgentOperation,
        ) -> Result<OperationAck, OperationFailure> {
            let unsupported = !self.supports(operation);
            self.trace.record(
                match operation {
                    FreshAgentOperation::Compact { .. } => "compact",
                    FreshAgentOperation::Rollback {
                        direction: FreshAgentRollbackDirection::Undo,
                        ..
                    } => "rollback_undo",
                    FreshAgentOperation::Rollback {
                        direction: FreshAgentRollbackDirection::Redo,
                        ..
                    } => "rollback_redo",
                },
                json!({"requestId":request_id.as_str(),"operation":operation}),
                if unsupported {
                    "unsupported".to_string()
                } else {
                    format!("acked:{}", request_id.as_str())
                },
            );
            if unsupported {
                return Err(OperationFailure {
                    kind: OperationFailureKind::Unsupported,
                    message: "fixture provider operation is unsupported".into(),
                    acceptance_ambiguous: false,
                });
            }
            Ok(OperationAck {
                provider_ack_id: Some(request_id.as_str().into()),
                native_session_id: None,
            })
        }

        async fn capture(
            &self,
            max_bytes: usize,
        ) -> Result<freshell_runtime_protocol::FreshAgentCapture, String> {
            let capture = freshell_runtime_protocol::FreshAgentCapture {
                provider: self.provider.clone(),
                session_type: format!("fresh{}", self.provider.as_str()),
                presentation_session_id: "presentation".into(),
                native_session_id: self
                    .trace
                    .native_session_id
                    .lock()
                    .unwrap()
                    .clone()
                    .unwrap_or_else(|| format!("native-{}", self.provider.as_str())),
                text: "fixture transcript".into(),
                truncated: false,
            };
            self.trace.record(
                "capture",
                json!({"maxBytes":max_bytes}),
                format!("captured:{}:{}", capture.native_session_id, capture.text),
            );
            Ok(capture)
        }

        async fn stop(self: Arc<Self>) -> Result<(), String> {
            self.trace.record("restart", json!({"stop":true}), "ok");
            Ok(())
        }

        fn take_event_stream(&self) -> Option<mpsc::Receiver<AgentEvent>> {
            None
        }
    }

    fn parity_profile(provider: FreshProvider) -> FreshAgentProfile {
        let preparation = match provider {
            FreshProvider::Claude => ProviderPreparation::Claude {
                mcp_args: Vec::new(),
            },
            FreshProvider::Codex => ProviderPreparation::Codex {
                tui_args: Vec::new(),
                sidecar_args: Vec::new(),
            },
            FreshProvider::Opencode => ProviderPreparation::Opencode {
                project_config: Vec::new(),
                tui_config: None,
                tui_source: None,
                inline_config: false,
            },
            FreshProvider::Kilroy => unreachable!(),
        };
        FreshAgentProfile {
            provider: provider.clone(),
            runtime_variant: provider.as_str().into(),
            cwd: "/workspace".into(),
            model: Some("fixture-model".into()),
            effort: Some("low".into()),
            permission_mode: Some("default".into()),
            sandbox: Some("workspace-write".into()),
            provider_store_id: format!("soul-{}", provider.as_str()),
            native_session_id: Some(format!("native-{}", provider.as_str())),
            plugins: Some(vec!["fixture-plugin".into()]),
            model_selection: Some(Some(freshell_runtime_protocol::ProviderModelSelection {
                kind: "exact".into(),
                model_id: "fixture-model".into(),
            })),
            session_ref: Some(freshell_runtime_protocol::ProviderSessionReference {
                provider: provider.as_str().into(),
                session_id: format!("native-{}", provider.as_str()),
            }),
            provider_launch_context: Some(ProviderLaunchContext {
                preparation,
                mcp_capability: None,
                config: vec![freshell_runtime_protocol::ProviderConfigReference {
                    root: freshell_runtime_protocol::ProviderConfigRoot::UserProvider,
                    relative_path: "settings.json".into(),
                    provider_relative_path: format!(".{}/settings.json", provider.as_str()),
                    format: "json".into(),
                }],
            }),
            provider_secret_references: vec![freshell_runtime_protocol::ProviderSecretReference {
                source_path: "/run/freshell-secrets/onecli/env".into(),
                profile: match provider {
                    FreshProvider::Claude => {
                        freshell_runtime_protocol::ProviderSecretProfile::ClaudeOnecliEnvironment
                    }
                    FreshProvider::Codex => {
                        freshell_runtime_protocol::ProviderSecretProfile::CodexOnecliEnvironment
                    }
                    FreshProvider::Opencode => {
                        freshell_runtime_protocol::ProviderSecretProfile::OpencodeOnecliEnvironment
                    }
                    FreshProvider::Kilroy => unreachable!(),
                },
            }],
        }
    }

    fn semantic_operations() -> Vec<FreshAgentOperation> {
        vec![
            FreshAgentOperation::Compact {
                instructions: Some("compact instructions".into()),
                cwd: Some("/workspace".into()),
            },
            FreshAgentOperation::Rollback {
                direction: FreshAgentRollbackDirection::Undo,
                mode: FreshAgentRollbackMode::Step,
                turn_id: Some("turn-1".into()),
                cwd: Some("/workspace".into()),
            },
            FreshAgentOperation::Rollback {
                direction: FreshAgentRollbackDirection::Redo,
                mode: FreshAgentRollbackMode::Step,
                turn_id: Some("turn-1".into()),
                cwd: Some("/workspace".into()),
            },
        ]
    }

    fn parity_direct_create(profile: &FreshAgentProfile) -> FreshAgentCreate {
        FreshAgentCreate {
            request_id: format!("direct-create-{}", profile.provider.as_str()),
            observed_epoch: Some(7),
            observed_generation: Some(3),
            naming_handle: Some("display-only-name-handle".into()),
            session_type: match profile.provider {
                FreshProvider::Claude => SessionType::Freshclaude,
                FreshProvider::Codex => SessionType::Freshcodex,
                FreshProvider::Opencode => SessionType::Freshopencode,
                FreshProvider::Kilroy => unreachable!(),
            },
            cwd: Some(profile.cwd.clone()),
            effort: profile.effort.clone(),
            legacy_restore_context: None,
            model: profile.model.clone(),
            model_selection: profile.model_selection.as_ref().map(|selection| {
                selection
                    .as_ref()
                    .map(|selection| freshell_protocol::ModelSelection {
                        kind: selection.kind.clone(),
                        model_id: selection.model_id.clone(),
                    })
            }),
            permission_mode: profile.permission_mode.clone(),
            plugins: profile.plugins.clone(),
            provider: Some(match profile.provider {
                FreshProvider::Claude => AgentProvider::Claude,
                FreshProvider::Codex => AgentProvider::Codex,
                FreshProvider::Opencode => AgentProvider::Opencode,
                FreshProvider::Kilroy => unreachable!(),
            }),
            resume_session_id: None,
            sandbox: profile.sandbox.as_deref().and_then(parse_sandbox),
            session_ref: profile
                .session_ref
                .as_ref()
                .map(|reference| SessionLocator {
                    provider: reference.provider.clone(),
                    session_id: reference.session_id.clone(),
                }),
            tab_id: Some("display-only-tab".into()),
        }
    }

    fn direct_profile_from_create(
        message: &FreshAgentCreate,
        provider_context: &FreshAgentProfile,
    ) -> FreshAgentProfile {
        let mut profile = provider_context.clone();
        profile.cwd = message.cwd.clone().unwrap();
        profile.model = message.model.clone();
        profile.effort = message.effort.clone();
        profile.permission_mode = message.permission_mode.clone();
        profile.sandbox = message
            .sandbox
            .as_ref()
            .and_then(|sandbox| serde_json::to_value(sandbox).ok())
            .and_then(|value| value.as_str().map(str::to_string));
        profile.plugins = message.plugins.clone();
        profile.model_selection = message.model_selection.as_ref().map(|selection| {
            selection.as_ref().map(
                |selection| freshell_runtime_protocol::ProviderModelSelection {
                    kind: selection.kind.clone(),
                    model_id: selection.model_id.clone(),
                },
            )
        });
        profile.session_ref = message.session_ref.as_ref().map(|reference| {
            freshell_runtime_protocol::ProviderSessionReference {
                provider: reference.provider.clone(),
                session_id: reference.session_id.clone(),
            }
        });
        profile.native_session_id = profile
            .session_ref
            .as_ref()
            .map(|reference| reference.session_id.clone());
        profile
    }

    fn parity_hosted_profile(profile: &FreshAgentProfile) -> FreshAgentProfile {
        let session_type = match profile.provider {
            FreshProvider::Claude => "freshclaude",
            FreshProvider::Codex => "freshcodex",
            FreshProvider::Opencode => "freshopencode",
            FreshProvider::Kilroy => unreachable!(),
        };
        let launch: FreshAgentLaunchSpec = serde_json::from_value(json!({
            "sessionId":"presentation", "provider":profile.provider,
            "sessionType":session_type, "runtimeVariant":profile.runtime_variant,
            "providerStoreId":profile.provider_store_id, "cwd":profile.cwd,
            "workspacePath":profile.cwd, "runAsUid":65534, "runAsGid":0,
            "model":profile.model, "effort":profile.effort,
            "permissionMode":profile.permission_mode, "sandbox":profile.sandbox,
            "nativeSessionId":profile.native_session_id, "plugins":profile.plugins,
            "modelSelection":profile.model_selection, "sessionRef":profile.session_ref,
            "providerLaunchContext":profile.provider_launch_context,
            "providerSecretReferences":profile.provider_secret_references,
        }))
        .unwrap();
        let mut hosted = profile_from_launch(&launch);
        hosted
            .provider_launch_context
            .as_mut()
            .unwrap()
            .mcp_capability = Some(freshell_runtime_protocol::McpCapabilityReference {
            grant_id: "grant-fixture-managed".into(),
            endpoint: "http://mcp.example.test:3344".into(),
            provider_relative_path: ".freshell/freshell-mcp.json".into(),
            host_gateway_address: None,
        });
        hosted
    }

    async fn run_direct_transport_matrix(
        transport: Arc<ParityFixtureTransport>,
        profile: &mut FreshAgentProfile,
    ) {
        transport.start(profile).await.unwrap();
        transport
            .dispatch(
                &RequestId::parse("matrix-send").unwrap(),
                "fixture prompt",
                profile,
            )
            .await
            .unwrap();
        transport.interrupt().await.unwrap();
        for (id, decision) in [
            ("approval-1", json!({"allow":true})),
            ("question-1", json!({"answers":{"q":"a"}})),
        ] {
            let result = transport.resolve_permission(id, decision).await;
            assert_eq!(
                result.is_err(),
                transport.unsupported(if id.starts_with("approval") {
                    "approval"
                } else {
                    "question"
                })
            );
        }
        for (index, operation) in semantic_operations().iter().enumerate() {
            if transport.supports_operation(operation).await.unwrap() {
                transport
                    .dispatch_operation(
                        &RequestId::parse(format!("semantic-{index}")).unwrap(),
                        operation,
                    )
                    .await
                    .unwrap();
            }
        }
        transport.capture(4096).await.unwrap();
        let fork = transport
            .fork(
                &RequestId::parse("fork-1").unwrap(),
                profile.native_session_id.as_deref().unwrap(),
                Some(json!({"atTurnId":"turn-1"})),
            )
            .await;
        if let Ok(transition) = fork {
            profile.native_session_id = Some(transition.child_session_id.clone());
            if let Some(reference) = profile.session_ref.as_mut() {
                reference.session_id = transition.child_session_id;
            }
        }
        Arc::clone(&transport).stop().await.unwrap();
        transport.start(profile).await.unwrap();
    }

    async fn run_hosted_actor_matrix(
        transport: Arc<HostedTransport>,
        fixture: &ParityFixtureTransport,
        profile: FreshAgentProfile,
        state_dir: &std::path::Path,
    ) {
        let actor = FreshAgentHostActor::open(state_dir, profile, transport.clone())
            .await
            .unwrap();
        actor
            .dispatch(
                RequestId::parse("matrix-send").unwrap(),
                "fixture prompt".into(),
                None,
            )
            .await
            .unwrap();
        actor.interrupt().await.unwrap();
        for (id, decision) in [
            ("approval-1", json!({"allow":true})),
            ("question-1", json!({"answers":{"q":"a"}})),
        ] {
            actor
                .record_permission(id.into(), json!({"requestId":id}))
                .await
                .unwrap();
            let result = actor.resolve_permission(id, decision).await;
            assert_eq!(
                result.is_err(),
                fixture.unsupported(if id.starts_with("approval") {
                    "approval"
                } else {
                    "question"
                })
            );
        }
        for (index, operation) in semantic_operations().into_iter().enumerate() {
            let result = actor
                .semantic_operation(
                    RequestId::parse(format!("semantic-{index}")).unwrap(),
                    operation,
                )
                .await;
            let unsupported = (fixture.provider == FreshProvider::Codex) && index == 2;
            assert_eq!(result.is_err(), unsupported);
            if unsupported {
                assert!(matches!(
                    result,
                    Err(freshell_agent_runtime::host_actor::ActorError::UnsupportedOperation)
                ));
            }
        }
        actor.capture(4096).await.unwrap();
        let profile_after_fork = actor.profile().await;
        let fork = actor
            .fork(
                RequestId::parse("fork-1").unwrap(),
                profile_after_fork.native_session_id.clone().unwrap(),
                Some(json!({"atTurnId":"turn-1"})),
            )
            .await;
        assert_eq!(
            fork.is_err(),
            fixture.provider == FreshProvider::Claude,
            "Claude keeps its provider-native unsupported fork result"
        );
        let resumed_profile = actor.profile().await;
        let expected_native = resumed_profile.native_session_id.clone();
        actor.stop().await.unwrap();
        let resumed = FreshAgentHostActor::open(state_dir, resumed_profile, transport)
            .await
            .unwrap();
        assert_eq!(resumed.profile().await.native_session_id, expected_native);
    }

    #[tokio::test]
    async fn direct_and_hosted_provider_transport_operations_have_matching_rows() {
        for provider in [
            FreshProvider::Claude,
            FreshProvider::Codex,
            FreshProvider::Opencode,
        ] {
            let seed_profile = parity_profile(provider.clone());
            let direct_create = parity_direct_create(&seed_profile);
            let direct_profile = direct_profile_from_create(&direct_create, &seed_profile);
            let hosted_profile = parity_hosted_profile(&seed_profile);
            let mut direct_wire = serde_json::to_value(direct_create).unwrap();
            let mut hosted_wire =
                serde_json::to_value(create_request_for_profile(&hosted_profile)).unwrap();
            for field in [
                "requestId",
                "namingHandle",
                "tabId",
                "observedEpoch",
                "observedGeneration",
            ] {
                direct_wire.as_object_mut().unwrap().remove(field);
                hosted_wire.as_object_mut().unwrap().remove(field);
            }
            assert_eq!(
                direct_wire, hosted_wire,
                "provider create request differs for {provider:?}"
            );
            let mut hosted_provider_profile = hosted_profile.clone();
            hosted_provider_profile
                .provider_launch_context
                .as_mut()
                .unwrap()
                .mcp_capability = None;
            assert_eq!(
                direct_profile, hosted_provider_profile,
                "provider-visible profile differs for {provider:?}"
            );
            let profile = direct_profile;
            let trace = Arc::new(ParityTrace::default());
            *trace.route.lock().unwrap() = "direct".into();
            let direct_transport = Arc::new(ParityFixtureTransport {
                provider: provider.clone(),
                trace: Arc::clone(&trace),
            });
            let mut direct_profile = profile.clone();
            run_direct_transport_matrix(Arc::clone(&direct_transport), &mut direct_profile).await;

            *trace.route.lock().unwrap() = "hosted".into();
            *trace.native_session_id.lock().unwrap() = profile.native_session_id.clone();
            let hosted_fixture = Arc::clone(&direct_transport);
            let hosted_transport =
                HostedTransport::with_test_delegate(provider.clone(), hosted_fixture.clone()).await;
            let dir = tempfile::tempdir().unwrap();
            run_hosted_actor_matrix(
                hosted_transport,
                &hosted_fixture,
                hosted_profile.clone(),
                dir.path(),
            )
            .await;

            let direct_rows = trace.rows("direct");
            let hosted_rows = trace.rows("hosted");
            let project = |rows: Vec<TransportObservation>| {
                rows.into_iter()
                    .map(|row| (row.operation, row.input, row.result))
                    .collect::<Vec<_>>()
            };
            assert_eq!(
                project(direct_rows.clone()),
                project(hosted_rows.clone()),
                "direct and hosted provider calls/results differ for {provider:?}"
            );
            for route_rows in [&direct_rows, &hosted_rows] {
                let create = route_rows
                    .iter()
                    .find(|row| row.operation == "create_resume")
                    .expect("fixture records the actual provider create/resume edge");
                assert_eq!(create.input["providerMcpEnabled"], false);
                assert_eq!(create.input["providerMcpCapability"], "absent");
            }
            assert!(direct_rows.iter().any(|row| row.operation == "approval"));
            assert!(direct_rows.iter().any(|row| row.operation == "question"));
            assert!(direct_rows
                .iter()
                .any(|row| row.operation == "rollback_undo"));
            assert!(direct_rows.iter().any(|row| row.operation == "capture"));
            for operation in [
                "create_resume",
                "send",
                "interrupt",
                "approval",
                "question",
                "compact",
                "rollback_undo",
                "rollback_redo",
                "capture",
                "fork",
                "restart",
            ] {
                assert!(
                    direct_rows.iter().any(|row| row.operation == operation),
                    "missing direct operation row {operation} for {provider:?}"
                );
            }
            let create_rows = direct_rows
                .iter()
                .filter(|row| row.operation == "create_resume")
                .collect::<Vec<_>>();
            assert_eq!(
                create_rows.len(),
                2,
                "create and exact resume are both recorded"
            );
            assert_eq!(
                create_rows[0].input["nativeSessionId"],
                format!("native-{}", provider.as_str())
            );
            let resumed_native = if provider == FreshProvider::Claude {
                format!("native-{}", provider.as_str())
            } else {
                format!("native-{}-fork", provider.as_str())
            };
            assert_eq!(create_rows[1].input["nativeSessionId"], resumed_native);
            if provider == FreshProvider::Claude {
                assert!(direct_rows
                    .iter()
                    .any(|row| row.operation == "fork" && row.result == "unsupported"));
            }
            if provider == FreshProvider::Opencode {
                assert!(direct_rows
                    .iter()
                    .any(|row| row.operation == "approval" && row.result == "unsupported"));
                assert!(direct_rows
                    .iter()
                    .any(|row| row.operation == "question" && row.result == "unsupported"));
            }
            if provider == FreshProvider::Codex {
                assert!(direct_rows
                    .iter()
                    .any(|row| row.operation == "rollback_redo"
                        && row.input["phase"] == "support"
                        && row.result == "unsupported"));
            }

            let direct_mcp_enabled = match profile
                .provider_launch_context
                .as_ref()
                .unwrap()
                .preparation
            {
                ProviderPreparation::Claude { ref mcp_args } => !mcp_args.is_empty(),
                ProviderPreparation::Codex {
                    ref tui_args,
                    ref sidecar_args,
                } => !tui_args.is_empty() || !sidecar_args.is_empty(),
                ProviderPreparation::Opencode {
                    ref tui_config,
                    ref project_config,
                    ..
                } => {
                    tui_config.is_some()
                        || project_config
                            .iter()
                            .any(|file| file.relative_path.contains("freshell-mcp"))
                }
                ProviderPreparation::Amplifier { .. } => false,
            };
            assert!(
                !direct_mcp_enabled,
                "direct provider route has no generated Freshell MCP today"
            );
            assert!(hosted_profile
                .provider_launch_context
                .as_ref()
                .unwrap()
                .mcp_capability
                .is_some());
            assert!(profile
                .provider_launch_context
                .as_ref()
                .unwrap()
                .mcp_capability
                .is_none());
            let hosted_mcp_enabled = match hosted_profile
                .provider_launch_context
                .as_ref()
                .unwrap()
                .preparation
            {
                ProviderPreparation::Claude { ref mcp_args } => !mcp_args.is_empty(),
                ProviderPreparation::Codex {
                    ref tui_args,
                    ref sidecar_args,
                } => !tui_args.is_empty() || !sidecar_args.is_empty(),
                ProviderPreparation::Opencode {
                    ref tui_config,
                    ref project_config,
                    ..
                } => {
                    tui_config.is_some()
                        || project_config
                            .iter()
                            .any(|file| file.relative_path.contains("freshell-mcp"))
                }
                ProviderPreparation::Amplifier { .. } => false,
            };
            assert_eq!(
                direct_mcp_enabled, hosted_mcp_enabled,
                "hosted provider MCP must match direct absence"
            );
        }
    }

    #[test]
    fn fresh_agent_provider_context_round_trip() {
        for provider in [
            FreshProvider::Claude,
            FreshProvider::Codex,
            FreshProvider::Opencode,
        ] {
            let preparation = match provider {
                FreshProvider::Claude => ProviderPreparation::Claude {
                    mcp_args: Vec::new(),
                },
                FreshProvider::Codex => ProviderPreparation::Codex {
                    tui_args: Vec::new(),
                    sidecar_args: vec!["-c".into(), "fixture_option=true".into()],
                },
                FreshProvider::Opencode => ProviderPreparation::Opencode {
                    project_config: Vec::new(),
                    tui_config: None,
                    tui_source: None,
                    inline_config: false,
                },
                FreshProvider::Kilroy => unreachable!(),
            };
            let profile = FreshAgentProfile {
                provider: provider.clone(),
                runtime_variant: provider.as_str().into(),
                cwd: "/workspace".into(),
                model: Some("model-a".into()),
                effort: Some("high".into()),
                permission_mode: Some("default".into()),
                sandbox: Some("workspace-write".into()),
                provider_store_id: "store".into(),
                native_session_id: Some("exact-native".into()),
                plugins: Some(vec!["plugin-a".into()]),
                model_selection: Some(Some(freshell_runtime_protocol::ProviderModelSelection {
                    kind: "model".into(), model_id: "model-a".into(),
                })),
                session_ref: Some(freshell_runtime_protocol::ProviderSessionReference {
                    provider: provider.as_str().into(), session_id: "exact-native".into(),
                }),
                provider_launch_context: Some(ProviderLaunchContext {
                    preparation,
                    mcp_capability: None,
                    config: vec![freshell_runtime_protocol::ProviderConfigReference {
                        root: freshell_runtime_protocol::ProviderConfigRoot::UserProvider,
                        relative_path: "settings.json".into(),
                        provider_relative_path: "provider/settings.json".into(),
                        format: "json".into(),
                    }],
                }),
                provider_secret_references: vec![freshell_runtime_protocol::ProviderSecretReference {
                    source_path: "/run/freshell-secrets/onecli".into(),
                    profile: match provider {
                        FreshProvider::Claude => freshell_runtime_protocol::ProviderSecretProfile::ClaudeOnecliEnvironment,
                        FreshProvider::Codex => freshell_runtime_protocol::ProviderSecretProfile::CodexOnecliEnvironment,
                        FreshProvider::Opencode => freshell_runtime_protocol::ProviderSecretProfile::OpencodeOnecliEnvironment,
                        FreshProvider::Kilroy => unreachable!(),
                    },
                }],
            };
            let launch: FreshAgentLaunchSpec = serde_json::from_value(json!({
                "sessionId":"presentation", "provider":provider, "sessionType":match provider {
                    FreshProvider::Claude => "freshclaude", FreshProvider::Codex => "freshcodex",
                    FreshProvider::Opencode => "freshopencode", FreshProvider::Kilroy => unreachable!(),
                },
                "runtimeVariant":profile.runtime_variant, "providerStoreId":profile.provider_store_id,
                "cwd":profile.cwd, "workspacePath":"/workspace", "runAsUid":65534, "runAsGid":0,
                "model":profile.model, "effort":profile.effort, "permissionMode":profile.permission_mode,
                "sandbox":profile.sandbox, "nativeSessionId":profile.native_session_id,
                "plugins":profile.plugins, "modelSelection":profile.model_selection,
                "sessionRef":profile.session_ref, "providerLaunchContext":profile.provider_launch_context,
                "providerSecretReferences":profile.provider_secret_references,
            })).unwrap();
            assert_eq!(profile_from_launch(&launch), profile);
            let created = create_request_for_profile(&profile);
            assert_eq!(created.plugins, profile.plugins);
            assert_eq!(
                created
                    .model_selection
                    .as_ref()
                    .and_then(|value| value.as_ref())
                    .map(|value| value.model_id.as_str()),
                Some("model-a")
            );
            assert_eq!(
                created
                    .session_ref
                    .as_ref()
                    .map(|value| value.session_id.as_str()),
                Some("exact-native")
            );
            assert!(created.naming_handle.is_none());
            assert!(created.tab_id.is_none());
            assert!(created.resume_session_id.is_none());
            assert!(created.observed_epoch.is_none());
            assert!(created.observed_generation.is_none());
            // Provider-only context is carried beside the provider create wire
            // request. Pin the full observable shape here so a hosted start
            // cannot silently lose ordinary config, TUI, MCP, or OneCLI
            // references while the public FreshAgentCreate remains equal.
            let context = profile.provider_launch_context.as_ref().unwrap();
            assert_eq!(context.config.len(), 1);
            assert_eq!(context.config[0].relative_path, "settings.json");
            assert_eq!(
                context.config[0].provider_relative_path,
                "provider/settings.json"
            );
            assert_eq!(profile.provider_secret_references.len(), 1);
            assert_eq!(
                profile.provider_secret_references[0].source_path,
                "/run/freshell-secrets/onecli"
            );
            assert!(serde_json::to_string(&profile)
                .unwrap()
                .find("fixture-secret-byte")
                .is_none());
            match (&provider, &context.preparation) {
                (FreshProvider::Claude, ProviderPreparation::Claude { mcp_args }) => {
                    assert!(
                        mcp_args.is_empty(),
                        "direct fresh Claude adds no Freshell MCP"
                    );
                }
                (
                    FreshProvider::Codex,
                    ProviderPreparation::Codex {
                        tui_args,
                        sidecar_args,
                    },
                ) => {
                    assert!(
                        tui_args.is_empty(),
                        "direct fresh Codex adds no Freshell TUI MCP"
                    );
                    assert_eq!(sidecar_args, &["-c", "fixture_option=true"]);
                }
                (
                    FreshProvider::Opencode,
                    ProviderPreparation::Opencode {
                        project_config,
                        tui_config,
                        inline_config,
                        ..
                    },
                ) => {
                    assert!(project_config.is_empty());
                    assert!(tui_config.is_none());
                    assert!(!inline_config);
                }
                _ => panic!("provider preparation did not match provider {provider:?}"),
            }
            let mut replayed = profile.clone();
            replayed.provider_store_id = "other-lifecycle-id".into();
            let other_create = create_request_for_profile(&replayed);
            let mut first = serde_json::to_value(created).unwrap();
            let mut second = serde_json::to_value(other_create).unwrap();
            first.as_object_mut().unwrap().remove("requestId");
            second.as_object_mut().unwrap().remove("requestId");
            assert_eq!(first, second);
            let direct: FreshAgentCreate = serde_json::from_value(json!({
                "requestId":"direct-lifecycle-id", "provider":provider.as_str(),
                "sessionType":match provider {
                    FreshProvider::Claude => "freshclaude", FreshProvider::Codex => "freshcodex",
                    FreshProvider::Opencode => "freshopencode", FreshProvider::Kilroy => unreachable!(),
                },
                "cwd":"/workspace", "model":"model-a", "effort":"high",
                "permissionMode":"default", "sandbox":"workspace-write",
                "plugins":["plugin-a"], "modelSelection":{"kind":"model","modelId":"model-a"},
                "sessionRef":{"provider":provider.as_str(),"sessionId":"exact-native"},
                "namingHandle":"display-only", "tabId":"display-tab",
                "observedEpoch":3, "observedGeneration":2,
            })).unwrap();
            let mut direct = serde_json::to_value(direct).unwrap();
            for transient in [
                "requestId",
                "namingHandle",
                "tabId",
                "observedEpoch",
                "observedGeneration",
            ] {
                direct.as_object_mut().unwrap().remove(transient);
            }
            assert_eq!(
                first, direct,
                "hosted provider create differs from direct {provider:?}"
            );
        }
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

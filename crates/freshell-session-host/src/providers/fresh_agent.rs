//! Host-owned adapters around the existing provider implementations.
//!
//! Each session-host process serves exactly one soul. Consequently the
//! `FreshAgentState` held here gives OpenCode one `opencode serve` process per
//! soul rather than the web server's legacy shared daemon.

use async_trait::async_trait;
use freshell_agent_runtime::host_actor::{
    DispatchAck, DispatchFailure, ForkTransition, FreshAgentHostActor, FreshAgentOperation,
    FreshAgentProfile, FreshAgentTransport, NativeDispatchIdentity, OperationAck, OperationFailure,
    OperationFailureKind, TransportStart,
};
use freshell_agent_runtime::snapshot_text::render_snapshot_text;
use freshell_codex::launch_plan::CodexSidecarLaunchContext;
use freshell_freshagent::rollback_record::{RollbackDirection, RollbackModeReq, RollbackRequest};
use freshell_freshagent::{FreshAgentState, FreshClaudeState, FreshCodexState, FreshOpencodeState};
use freshell_protocol::{
    AgentProvider, FreshAgentApprovalRespond, FreshAgentCheckpointIntent, FreshAgentCompact,
    FreshAgentConfigure, FreshAgentCreate, FreshAgentElicitationRespond, FreshAgentFork,
    FreshAgentInterrupt, FreshAgentKill, FreshAgentQuestionRespond, FreshAgentSend,
    FreshAgentSendSettings, ServerMessage, SessionLocator, SessionType, StringOrNumber,
};
use freshell_runtime_protocol::{
    AgentEvent, FreshAgentCapture, FreshAgentFixtureTransport, FreshAgentLaunchSpec,
    FreshAgentNativeNameError, FreshAgentNativeNameOperation, FreshAgentNativeNameReply,
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

const CREATE_TIMEOUT: Duration = freshell_platform::provider_startup::HOSTED_CREATE_WAIT;
// OpenCode's bounded cold start can consume 20s of health probing plus a 30s
// request budget before the correlated acceptance edge exists. Stay below the
// supervisor's 60s hosted-agent command envelope while covering that bound.
const SEND_ACK_TIMEOUT: Duration = Duration::from_secs(55);
const FORK_TIMEOUT: Duration = Duration::from_secs(55);
const RETIRE_TIMEOUT: Duration = Duration::from_secs(20);
const EVENT_CHANNEL_CAPACITY: usize = 256;
const HOST_ACTOR_STATE_DIR: &str = "/run/freshell-host-actor";

#[cfg(test)]
trait HostedTransportTestDelegate: FreshAgentTransport {
    fn record_provider_create(&self, create: &FreshAgentCreate);
}

enum ProviderState {
    Claude(FreshClaudeState),
    Codex(FreshCodexState),
    Opencode {
        runtime: Box<FreshOpencodeState>,
        owner: Box<FreshAgentState>,
    },
}

/// One current native producer, with a short buffer for a supported operation
/// whose native init can precede its acknowledged ownership transition.
#[derive(Default)]
struct HostedNativeIdentity {
    launch: Option<freshell_runtime_protocol::NativeIdentityLaunch>,
    producer_launch: Option<freshell_runtime_protocol::NativeIdentityLaunch>,
    root: Option<String>,
    pending: bool,
    candidates: BTreeMap<String, Value>,
    evidence: Option<Value>,
    rejected_parent: Option<HostedParentProof>,
    // The latest verified clear authorizes only the current root.
    clear_parent: Option<String>,
}

struct HostedParentProof {
    launch: freshell_runtime_protocol::NativeIdentityLaunch,
    producer_launch: freshell_runtime_protocol::NativeIdentityLaunch,
    root: String,
    evidence: Value,
}

#[derive(PartialEq)]
enum NativeProofReception {
    Published,
    Buffered,
    Rejected,
}

impl HostedNativeIdentity {
    fn current_parent_proof(&self, new_query: bool) -> Option<HostedParentProof> {
        let launch = self.launch.as_ref()?;
        let producer_launch = self.producer_launch.as_ref()?;
        let root = self.root.as_ref()?;
        let evidence = self.evidence.as_ref()?;
        if evidence["nativeSessionId"].as_str() != Some(root.as_str())
            || evidence["launch"] != json!(launch)
            || (new_query
                && (evidence["providerEvidence"]["launch"] != json!(producer_launch)
                    || evidence["queryGeneration"]
                        .as_u64()
                        .is_none_or(|generation| generation == 0)))
        {
            return None;
        }
        Some(HostedParentProof {
            launch: launch.clone(),
            producer_launch: producer_launch.clone(),
            root: root.clone(),
            evidence: evidence.clone(),
        })
    }

    fn invalidate_current_query(&mut self) {
        self.evidence = None;
        self.candidates.clear();
        self.rejected_parent = None;
    }

    fn begin(
        &mut self,
        new_query: bool,
    ) -> Result<Option<freshell_runtime_protocol::NativeIdentityLaunch>, String> {
        if self.pending {
            return Err("native identity transition is unsettled".into());
        }
        let mut producer = self.launch.clone();
        if new_query {
            if let Some(launch) = producer.as_mut() {
                launch.evidence_revision = launch
                    .evidence_revision
                    .checked_add(1)
                    .ok_or("native identity revision exhausted")?;
                // This is authorization for one supported native operation,
                // not an observed or requested child identity.
                launch.requested_native_session_id = None;
            }
        }
        self.rejected_parent = self.current_parent_proof(new_query);
        self.producer_launch = producer.clone();
        self.pending = true;
        self.candidates.clear();
        self.evidence = None;
        Ok(producer)
    }

    fn reject_before_native_transition(
        &mut self,
        parent: &str,
        transition_launch: &Option<freshell_runtime_protocol::NativeIdentityLaunch>,
        code: &str,
        provider: &FreshProvider,
    ) -> bool {
        // These rollback codes precede each handler's native mutation. A fork
        // has a separate correlated pre-child refusal marker at its boundary.
        let before_mutation = match provider {
            FreshProvider::Claude | FreshProvider::Kilroy | FreshProvider::Opencode => {
                matches!(
                    code,
                    "INVALID_ROLLBACK_TARGET" | "NOTHING_TO_UNDO" | "REDO_UNAVAILABLE"
                )
            }
            FreshProvider::Codex => matches!(code, "INVALID_ROLLBACK_TARGET" | "NOTHING_TO_UNDO"),
        };
        if !before_mutation {
            self.rejected_parent = None;
            return false;
        }
        self.restore_unchanged_parent(parent, transition_launch)
    }

    fn restore_unchanged_parent(
        &mut self,
        parent: &str,
        transition_launch: &Option<freshell_runtime_protocol::NativeIdentityLaunch>,
    ) -> bool {
        let Some(prior) = self.rejected_parent.take() else {
            return false;
        };
        if !self.pending
            || self.root.as_deref() != Some(parent)
            || prior.root != parent
            || self.launch.as_ref() != Some(&prior.launch)
            || &self.producer_launch != transition_launch
            || !self.candidates.is_empty()
            || self.evidence.is_some()
        {
            return false;
        }
        self.producer_launch = Some(prior.producer_launch);
        self.evidence = Some(prior.evidence);
        self.pending = false;
        true
    }

    fn observe_parent_query_change(&mut self, event: &Value) {
        let Some(prior) = self.rejected_parent.as_ref() else {
            return;
        };
        let (binding, loading) = match event["type"].as_str() {
            Some("freshAgent.session.loading") => (&event["nativeBinding"], true),
            Some("freshAgent.session.init") => (&event["nativeIdentityEvidence"], false),
            _ => return,
        };
        if binding["launch"] == json!(prior.producer_launch)
            && (binding["queryGeneration"].as_u64() > prior.evidence["queryGeneration"].as_u64()
                || (!loading && event["cliSessionId"].as_str() != Some(prior.root.as_str())))
        {
            self.rejected_parent = None;
        }
    }

    fn observe(&mut self, root: &str, evidence: Value) -> NativeProofReception {
        if root.is_empty() || root.chars().any(char::is_control) {
            return NativeProofReception::Rejected;
        }
        if self.pending {
            self.rejected_parent = None;
            // Keep early native proof until the correlated operation ACK picks
            // its actual child. Unsolicited data cannot publish readiness.
            if self.candidates.len() < EVENT_CHANNEL_CAPACITY || self.candidates.contains_key(root)
            {
                self.candidates.insert(root.into(), evidence);
            }
            return NativeProofReception::Buffered;
        }
        let clear = evidence["source"] == "clear"
            && self.root.as_deref().is_some_and(|current| {
                current != root && evidence["previousNativeSessionId"].as_str() == Some(current)
            })
            && self.evidence.as_ref().is_some_and(|prior| {
                prior["providerEvidence"]["launch"] == evidence["launch"]
                    && prior["queryGeneration"].as_u64().is_some_and(|generation| {
                        generation > 0 && Some(generation) == evidence["queryGeneration"].as_u64()
                    })
            });
        if clear {
            self.clear_parent = self.root.clone();
        } else if self.root.as_deref().is_some_and(|current| current != root)
            || (self.clear_parent.is_none()
                && self
                    .launch
                    .as_ref()
                    .and_then(|launch| launch.requested_native_session_id.as_deref())
                    .is_some_and(|expected| expected != root))
        {
            return NativeProofReception::Rejected;
        }
        self.root = Some(root.into());
        self.evidence = Some(self.bind_evidence(root, evidence));
        NativeProofReception::Published
    }

    fn bind_evidence(&self, root: &str, evidence: Value) -> Value {
        let mut bound = json!({"nativeSessionId":root,"providerEvidence":evidence});
        if let Some(launch) = self.launch.as_ref() {
            bound["launch"] = json!(launch);
        } else if let Some(launch) = bound["providerEvidence"].get("launch").cloned() {
            bound["launch"] = launch;
        }
        if let Some(parent) = self.clear_parent.as_ref() {
            bound["nativeClear"] = json!({"previousNativeSessionId":parent,"nativeSessionId":root});
        }
        // Keep the native query generation available to the existing bounded
        // pending-approval consumer; the full original proof remains nested.
        if let Some(generation) = bound["providerEvidence"].get("queryGeneration").cloned() {
            bound["queryGeneration"] = generation;
        }
        bound
    }

    fn acknowledge(&mut self, root: &str, response_evidence: Option<Value>) -> Result<(), String> {
        if !self.pending || root.is_empty() || root.chars().any(char::is_control) {
            return Err("invalid native identity transition acknowledgement".into());
        }
        if self.root.as_deref() != Some(root) {
            self.clear_parent = None;
            if let Some(launch) = self.launch.as_mut() {
                launch.evidence_revision = launch
                    .evidence_revision
                    .checked_add(1)
                    .ok_or("native identity revision exhausted")?;
                launch.requested_native_session_id = Some(root.into());
            }
        }
        self.root = Some(root.into());
        self.pending = false;
        self.rejected_parent = None;
        let evidence = response_evidence.or_else(|| self.candidates.remove(root));
        self.candidates.clear();
        self.evidence = evidence.map(|evidence| self.bind_evidence(root, evidence));
        Ok(())
    }
}

struct HostedTransport {
    provider: FreshProvider,
    state: ProviderState,
    /// The providers' own outbound stream (the bridge relays it into the
    /// journal); an operation subscribes to read the provider's answer.
    provider_frames: Arc<broadcast::Sender<String>>,
    profile: std::sync::Mutex<Option<FreshAgentProfile>>,
    session_id: Arc<Mutex<Option<String>>>,
    created_rx: Mutex<watch::Receiver<Option<Result<String, String>>>>,
    // Native runtime that produced the current create/fork/rollback proof.
    // Runtime identity alone never supplies native observation.
    native_incarnation: Mutex<Option<String>>,
    prepared_native_checkpoints: std::sync::Mutex<Option<Vec<Value>>>,
    native_rx: Mutex<watch::Receiver<Option<String>>>,
    /// The native identity's writer, shared with the bridge: a claude fork
    /// points it at the child the moment the transition is known (the bridge
    /// announces only an id it has not recorded, so the child's first turn
    /// announces nothing new).
    native_tx: watch::Sender<Option<String>>,
    native_identity: Arc<std::sync::Mutex<HostedNativeIdentity>>,
    send_outcomes: broadcast::Sender<(String, bool)>,
    kill_outcomes: broadcast::Sender<(String, bool)>,
    suppressed_kills: Arc<std::sync::Mutex<HashSet<String>>>,
    event_tx: mpsc::Sender<AgentEvent>,
    event_rx: std::sync::Mutex<Option<mpsc::Receiver<AgentEvent>>>,
    _bridge: BroadcastBridgeTasks,
    #[cfg(test)]
    test_delegate: Option<Arc<dyn HostedTransportTestDelegate>>,
}

pub(crate) async fn open_hosted_fresh_agent(
    _incarnation_state_dir: &std::path::Path,
    launch: FreshAgentLaunchSpec,
) -> Result<Arc<FreshAgentHostActor>, freshell_agent_runtime::host_actor::ActorError> {
    let profile = profile_from_launch(&launch);
    let transport: Arc<dyn FreshAgentTransport> = match launch.fixture_transport {
        None => {
            let transport = HostedTransport::new_with_context(
                launch.provider,
                profile.provider_launch_context.as_ref(),
            )
            .await;
            if let ProviderState::Codex(state) = &transport.state {
                let (uid, gid) = (launch.run_as_uid, launch.run_as_gid);
                state.set_naming_rollout_probe(Arc::new(move |home, thread| {
                    Box::pin(super::codex::naming_rollout(home, thread, uid, gid))
                }));
                state.set_sidecar_cleanup_probe(Arc::new(move |recorded| {
                    Box::pin(super::codex::cleanup_sidecar(recorded, uid, gid))
                }));
            }
            transport
        }
        Some(FreshAgentFixtureTransport::Deterministic) => {
            deterministic_transport(&profile, launch.run_as_uid, launch.run_as_gid)
                .await
                .map_err(freshell_agent_runtime::host_actor::ActorError::Transport)?
        }
    };
    // The supervisor mounts one protected, per-soul directory here across
    // incarnations. The provider-owned HOME cannot hold the host's command
    // and decision journal: the provider can change HOME permissions.
    open_actor_for_transport(
        HOST_ACTOR_STATE_DIR,
        profile,
        transport,
        launch.fixture_transport,
    )
    .await
}

async fn open_actor_for_transport(
    state_dir: impl Into<std::path::PathBuf>,
    profile: FreshAgentProfile,
    transport: Arc<dyn FreshAgentTransport>,
    fixture_transport: Option<FreshAgentFixtureTransport>,
) -> Result<Arc<FreshAgentHostActor>, freshell_agent_runtime::host_actor::ActorError> {
    match fixture_transport {
        Some(FreshAgentFixtureTransport::Deterministic) => {
            FreshAgentHostActor::open_deterministic_fixture(state_dir, profile, transport).await
        }
        None => FreshAgentHostActor::open(state_dir, profile, transport).await,
    }
}

fn profile_from_launch(launch: &FreshAgentLaunchSpec) -> FreshAgentProfile {
    FreshAgentProfile {
        naming_handle: launch.naming_handle.clone(),
        collaboration_mode: launch.collaboration_mode.clone(),
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

    /// A claude/kilroy transport whose sidecars get exactly `environment` (the
    /// freshell-freshagent `test-support` seam): the real sidecar over a simulator.
    #[cfg(test)]
    async fn with_claude_sidecar_environment(
        provider: FreshProvider,
        environment: Vec<(String, String)>,
        context: Option<&ProviderLaunchContext>,
    ) -> Arc<Self> {
        let mut transport = Self::new_with_context(provider, context).await;
        let hosted = Arc::get_mut(&mut transport).expect("new transport has one owner");
        let ProviderState::Claude(state) = &mut hosted.state else {
            panic!("the fixture requires a Claude runtime");
        };
        *state = state.clone().with_sidecar_environment(environment);
        transport
    }

    async fn new_with_context(
        provider: FreshProvider,
        context: Option<&ProviderLaunchContext>,
    ) -> Arc<Self> {
        let (broadcast_tx, broadcast_rx) = broadcast::channel(1024);
        let broadcast_tx = Arc::new(broadcast_tx);
        let state = match provider {
            FreshProvider::Claude | FreshProvider::Kilroy => {
                let hosted_mcp = context.is_some_and(|context| {
                    matches!(
                        &context.preparation,
                        ProviderPreparation::Claude { mcp_args } if !mcp_args.is_empty()
                    )
                });
                ProviderState::Claude(
                    FreshClaudeState::new(Arc::clone(&broadcast_tx))
                        .with_hosted_mcp(hosted_mcp)
                        .with_managed_forks(),
                )
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
                        provider_exec_profile: true,
                        config_args: sidecar_args,
                        env: Default::default(),
                    })
                    .with_hosted_naming_events(),
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
        Self::from_parts(provider, state, broadcast_tx, broadcast_rx)
    }

    /// The transport around a provider `state` that publishes its frames on
    /// `broadcast_tx`; they arrive on `broadcast_rx`.
    fn from_parts(
        provider: FreshProvider,
        state: ProviderState,
        broadcast_tx: Arc<broadcast::Sender<String>>,
        broadcast_rx: broadcast::Receiver<String>,
    ) -> Arc<Self> {
        let (created_tx, created_rx) = watch::channel(None);
        let (native_tx, native_rx) = watch::channel(None);
        let (native_evidence_tx, _) = watch::channel(None);
        let native_identity = Arc::new(std::sync::Mutex::new(HostedNativeIdentity::default()));
        let (event_tx, event_rx) = mpsc::channel(EVENT_CHANNEL_CAPACITY);
        let (send_outcomes, _) = broadcast::channel(64);
        let (kill_outcomes, _) = broadcast::channel(64);
        let suppressed_kills = Arc::new(std::sync::Mutex::new(HashSet::new()));
        let session_id = Arc::new(Mutex::new(None));
        let bridge = spawn_broadcast_bridge(
            provider.clone(),
            broadcast_rx,
            BroadcastBridgeOutputs {
                owned_session: Some(session_id.clone()),
                retained_codex: match &state {
                    ProviderState::Codex(state) => Some(state.clone()),
                    _ => None,
                },
                created: created_tx,
                native: native_tx.clone(),
                native_evidence: native_evidence_tx,
                native_identity: Arc::clone(&native_identity),
                events: event_tx.clone(),
                send_outcomes: send_outcomes.clone(),
                kill_outcomes: kill_outcomes.clone(),
                suppressed_kills: Arc::clone(&suppressed_kills),
                #[cfg(test)]
                refusal_observer: None,
            },
        );
        Arc::new(Self {
            provider,
            state,
            provider_frames: broadcast_tx,
            profile: std::sync::Mutex::new(None),
            session_id,
            native_incarnation: Mutex::new(None),
            prepared_native_checkpoints: std::sync::Mutex::new(None),
            created_rx: Mutex::new(created_rx),
            native_rx: Mutex::new(native_rx),
            native_tx,
            native_identity,
            send_outcomes,
            kill_outcomes,
            suppressed_kills,
            event_tx,
            event_rx: std::sync::Mutex::new(Some(event_rx)),
            _bridge: bridge,
            #[cfg(test)]
            test_delegate: None,
        })
    }

    #[cfg(test)]
    async fn with_test_delegate(
        provider: FreshProvider,
        delegate: Arc<dyn HostedTransportTestDelegate>,
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

    async fn provider_session_id(&self) -> Option<String> {
        if matches!(self.provider, FreshProvider::Claude | FreshProvider::Kilroy) {
            let identity = self.native_identity.lock().expect("native identity lock");
            if let Some(root) = identity.root.as_ref() {
                return Some(root.clone());
            }
        }
        self.session_id.lock().await.clone()
    }

    async fn wait_created(&self) -> Result<String, String> {
        let mut receiver = self.created_rx.lock().await;
        tokio::time::timeout(CREATE_TIMEOUT, async {
            loop {
                if let Some(result) = receiver.borrow().clone() {
                    return result;
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

    async fn provider_session_incarnation(&self, session_id: &str) -> Option<String> {
        match &self.state {
            ProviderState::Claude(_) => None,
            ProviderState::Codex(state) => state.live_session_incarnation(session_id).await,
            ProviderState::Opencode { runtime, owner } => {
                if !runtime.has_live_session(session_id).await {
                    return None;
                }
                let manager = owner.opencode_shared_handle().lock().await.clone()?;
                manager.ownership_id().await.filter(|id| !id.is_empty())
            }
        }
    }

    async fn remember_native_runtime(&self, session_id: &str) {
        let incarnation = self.provider_session_incarnation(session_id).await;
        *self.native_incarnation.lock().await = incarnation;
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
        {
            let identity = self.native_identity.lock().expect("native identity lock");
            if identity.pending {
                return Err("native identity transition is unsettled".into());
            }
            if let Some(root) = identity.root.as_ref() {
                if identity.evidence.is_none() {
                    return Err("current native identity has not been observed".into());
                }
                // A correlated operation may consume buffered native proof
                // before another watch event. Its settled root owns reads.
                return Ok(root.clone());
            }
        }
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
                .provider_session_id()
                .await
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
    async fn prepare_native_readiness(&self) -> Result<(), String> {
        let ProviderState::Claude(state) = &self.state else {
            return Ok(());
        };
        let observed_root = {
            let identity = self.native_identity.lock().expect("native identity lock");
            if identity.pending {
                return Err("native identity transition is unsettled".into());
            }
            identity.root.clone()
        };
        let session_id = observed_root
            .or(self.provider_session_id().await)
            .ok_or("fresh-agent session is not started")?;
        *self.session_id.lock().await = Some(session_id.clone());
        let recovering = !state.has_live_session(&session_id).await;
        let previous_generation = {
            let mut identity = self.native_identity.lock().expect("native identity lock");
            let generation = identity
                .evidence
                .as_ref()
                .and_then(|proof| proof["queryGeneration"].as_u64())
                .unwrap_or(0);
            if recovering {
                identity.invalidate_current_query();
            }
            generation
        };
        if recovering {
            self.native_tx.send_replace(None);
        }
        let cwd = self
            .profile
            .lock()
            .expect("profile lock")
            .as_ref()
            .map(|profile| profile.cwd.clone());
        state
            .prepare_managed_native_session(&session_id, self.session_type(), cwd.as_deref())
            .await?;
        let mut native = self.native_rx.lock().await;
        tokio::time::timeout(CREATE_TIMEOUT, async {
            loop {
                let ready = {
                    let identity = self.native_identity.lock().expect("native identity lock");
                    !identity.pending
                        && identity.root.as_ref() == Some(&session_id)
                        && native.borrow().as_ref() == Some(&session_id)
                        && identity.evidence.as_ref().is_some_and(|proof| {
                            !recovering
                                || proof["queryGeneration"]
                                    .as_u64()
                                    .is_some_and(|generation| generation > previous_generation)
                        })
                };
                if ready {
                    return Ok(());
                }
                native
                    .changed()
                    .await
                    .map_err(|_| "provider identity channel closed".to_string())?;
            }
        })
        .await
        .map_err(|_| "provider did not reobserve the current native query".to_string())?
    }

    async fn restore_claude_fork_state(
        &self,
        context: freshell_agent_runtime::host_actor::ClaudeForkState,
    ) -> Result<(), String> {
        match &self.state {
            ProviderState::Claude(state) => state.restore_managed_fork_state(context).await,
            _ => Err("Claude fork state belongs to another provider".into()),
        }
    }
    async fn claude_fork_state(
        &self,
    ) -> Option<freshell_agent_runtime::host_actor::ClaudeForkState> {
        match &self.state {
            ProviderState::Claude(state) => state.managed_fork_state().await,
            _ => None,
        }
    }
    async fn disable_claude_fork_recovery(
        &self,
        destroys_redo: bool,
    ) -> Result<Option<freshell_agent_runtime::host_actor::ClaudeForkState>, String> {
        match &self.state {
            ProviderState::Claude(state) => {
                state.disable_managed_fork_recovery(destroys_redo).await
            }
            _ => Ok(None),
        }
    }
    async fn prepare_native_permission_recovery(
        &self,
        checkpoints: Vec<Value>,
    ) -> Result<(), String> {
        if checkpoints.len() > 32 {
            return Err("too many pending native checkpoints".into());
        }
        *self
            .prepared_native_checkpoints
            .lock()
            .expect("checkpoint lock") = Some(checkpoints);
        Ok(())
    }

    async fn resume_native_permission_recovery(&self) -> Result<(), DispatchFailure> {
        let reject = |message: &str| DispatchFailure {
            message: message.into(),
            acceptance_ambiguous: false,
        };
        let checkpoints = self
            .prepared_native_checkpoints
            .lock()
            .expect("checkpoint lock")
            .take()
            .ok_or_else(|| {
                reject("native recovery release is not prepared or was already attempted")
            })?;
        if checkpoints.is_empty() {
            return Ok(());
        }
        let session_id = self
            .provider_session_id()
            .await
            .ok_or_else(|| reject("current native session is unavailable"))?;
        let evidence = self
            .native_identity_evidence()
            .await
            .ok_or_else(|| reject("current native query is not observed"))?;
        let evidence = evidence.get("providerEvidence").unwrap_or(&evidence);
        let binding =
            json!({"launch":evidence["launch"],"queryGeneration":evidence["queryGeneration"]});
        let ProviderState::Claude(state) = &self.state else {
            return Err(reject(
                "provider does not support native approval continuation",
            ));
        };
        state
            .resume_native_checkpoint_checked(
                &session_id,
                self.session_type(),
                checkpoints,
                binding,
            )
            .await
            .map_err(|failure| DispatchFailure {
                message: failure.message,
                acceptance_ambiguous: failure.acceptance_ambiguous,
            })
    }

    async fn native_identity_evidence(&self) -> Option<Value> {
        #[cfg(test)]
        if let Some(delegate) = self.test_delegate.as_ref() {
            return delegate.native_identity_evidence().await;
        }
        let current = self.provider_session_id().await?;
        let native = if matches!(self.provider, FreshProvider::Claude | FreshProvider::Kilroy) {
            self.native_rx.lock().await.borrow().clone()?
        } else {
            current
        };
        let identity = self.native_identity.lock().expect("native identity lock");
        if identity.pending || identity.root.as_ref() != Some(&native) {
            return None;
        }
        identity.evidence.clone()
    }
    async fn start(&self, profile: &FreshAgentProfile) -> Result<TransportStart, String> {
        #[cfg(test)]
        if let Some(delegate) = self.test_delegate.as_ref() {
            // Capture the actual hosted request before the provider handler is
            // replaced by the recorder. This is the same value the production
            // branch below passes to `handle_create`.
            let provider_create = create_request_for_profile(profile);
            delegate.record_provider_create(&provider_create);
            return delegate.start(profile).await;
        }
        *self.profile.lock().expect("profile lock") = Some(profile.clone());
        let create = create_request_for_profile(profile);
        match &self.state {
            // The answer also rides the bus (`wait_created` below reads it).
            ProviderState::Claude(state) => {
                state.handle_create(create, None).await;
            }
            ProviderState::Codex(state) => {
                if let freshell_freshagent::codex::CodexCreateOutcome::Failed {
                    code,
                    message,
                    ..
                } = state.handle_create(create, None).await
                {
                    return Err(format!("{code}: {message}"));
                }
            }
            ProviderState::Opencode { runtime, .. } => {
                tokio::time::timeout(
                    CREATE_TIMEOUT,
                    runtime.prepare_managed_native_session(create),
                )
                .await
                .map_err(|_| "native OpenCode bootstrap timed out".to_string())??;
            }
        }
        let session_id = self.wait_created().await?;
        *self.session_id.lock().await = Some(session_id.clone());
        let native_session_id = match profile.native_session_id.as_deref() {
            Some(expected) => Some(self.wait_exact_native(expected).await?),
            None if matches!(self.provider, FreshProvider::Codex) => {
                Some(self.wait_exact_native(&session_id).await?)
            }
            None if matches!(self.provider, FreshProvider::Claude | FreshProvider::Kilroy) => {
                // The real SDK starts MCP/configuration before its first user
                // turn but publishes system/init identity only with that turn.
                // The bridge captures the native identity when it arrives.
                let launch_bound = self
                    .native_identity
                    .lock()
                    .expect("native identity lock")
                    .launch
                    .is_some();
                if launch_bound {
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
                        .map_err(|_| {
                            "provider did not materialize native identity".to_string()
                        })??,
                    )
                } else {
                    let observed = self.native_rx.lock().await.borrow().clone();
                    if observed.is_none() {
                        tracing::info!(
                            event = "provider.identity.awaiting_first_turn",
                            stage = "host_create",
                            runtime_variant = %profile.runtime_variant,
                            native_identity = "unrecorded",
                            "provider started before native identity materialization"
                        );
                    }
                    observed
                }
            }
            None if matches!(self.provider, FreshProvider::Opencode) => {
                Some(self.wait_exact_native(&session_id).await?)
            }
            None => None,
        };
        if matches!(self.provider, FreshProvider::Claude | FreshProvider::Kilroy) {
            // The Claude adapter's live registration is indexed by the native
            // UUID. The temporary SDK create key is not a live-session lookup.
            if let Some(native) = native_session_id.as_ref() {
                *self.session_id.lock().await = Some(native.clone());
            }
        }
        self.remember_native_runtime(&session_id).await;
        Ok(TransportStart { native_session_id })
    }

    async fn dispatch(
        &self,
        request_id: &RequestId,
        text: &str,
        profile: &FreshAgentProfile,
    ) -> Result<DispatchAck, DispatchFailure> {
        self.dispatch_with_checkpoint_identity(request_id, text, profile, None)
            .await
    }

    async fn dispatch_with_checkpoint_identity(
        &self,
        request_id: &RequestId,
        text: &str,
        profile: &FreshAgentProfile,
        logical_attempt_id: Option<&str>,
    ) -> Result<DispatchAck, DispatchFailure> {
        let settings = freshell_runtime_protocol::FreshAgentTurnSettings {
            collaboration_mode: profile.collaboration_mode.clone(),
            cwd: Some(profile.cwd.clone()),
            model: profile.model.clone(),
            effort: Some(profile.effort.clone()),
            permission_mode: profile.effective_permission_mode().map(str::to_owned),
            sandbox: profile.sandbox.clone(),
        };
        self.dispatch_with_turn_settings(
            request_id,
            text,
            profile,
            Some(&settings),
            logical_attempt_id,
        )
        .await
    }

    async fn dispatch_with_turn_settings(
        &self,
        request_id: &RequestId,
        text: &str,
        profile: &FreshAgentProfile,
        requested: Option<&freshell_runtime_protocol::FreshAgentTurnSettings>,
        logical_attempt_id: Option<&str>,
    ) -> Result<DispatchAck, DispatchFailure> {
        #[cfg(test)]
        if let Some(delegate) = self.test_delegate.as_ref() {
            return delegate.dispatch(request_id, text, profile).await;
        }
        let session_id = self
            .provider_session_id()
            .await
            .ok_or_else(|| DispatchFailure {
                message: "fresh-agent session is not started".into(),
                acceptance_ambiguous: false,
            })?;
        *self.profile.lock().expect("profile lock") = Some(profile.clone());
        let permission_mode = profile.effective_permission_mode().map(str::to_owned);
        let profile = profile.clone();
        let settings = if self.provider == FreshProvider::Codex {
            requested.map(provider_send_settings)
        } else {
            Some(FreshAgentSendSettings {
                collaboration_mode: profile.collaboration_mode,
                cwd: Some(profile.cwd),
                effort: profile.effort.map(Some),
                model: profile.model,
                permission_mode,
                sandbox: profile.sandbox.as_deref().and_then(parse_sandbox),
            })
        };
        let mut outcomes = self.send_outcomes.subscribe();
        let send = FreshAgentSend {
            observed_epoch: None,
            observed_generation: None,
            provider: self.provider_wire(),
            session_id: session_id.clone(),
            session_type: self.session_type(),
            text: text.to_string(),
            cwd: settings.as_ref().and_then(|settings| settings.cwd.clone()),
            images: None,
            request_id: Some(request_id.as_str().to_string()),
            settings,
            checkpoint_intent: logical_attempt_id.map(|logical_attempt_id| {
                FreshAgentCheckpointIntent {
                    logical_attempt_id: logical_attempt_id.to_string(),
                    workspace: None,
                }
            }),
        };
        match &self.state {
            // Legacy providers expose acceptance through their existing bus.
            ProviderState::Claude(state) => {
                state.handle_send(send).await;
            }
            ProviderState::Codex(state) => {
                use freshell_freshagent::codex::CodexSendOutcome;
                return match state.handle_send(send).await {
                    CodexSendOutcome::Accepted {
                        session_id: native,
                        submitted_turn_id,
                        incarnation_id,
                        pending_naming_handle,
                    } => {
                        let mut current = self.session_id.lock().await;
                        if current.as_deref() != Some(session_id.as_str()) {
                            return Err(DispatchFailure {
                                message: "native send source changed after acceptance".into(),
                                acceptance_ambiguous: true,
                            });
                        }
                        {
                            let mut identity =
                                self.native_identity.lock().expect("native identity lock");
                            if identity.pending
                                || identity
                                    .root
                                    .as_deref()
                                    .is_some_and(|root| root != session_id)
                            {
                                return Err(DispatchFailure {
                                    message: "native identity source changed after acceptance"
                                        .into(),
                                    acceptance_ambiguous: true,
                                });
                            }
                            if native != session_id {
                                // Only the typed native turn-start acceptance can
                                // settle a recovered root. Later Started frames
                                // still cannot revive the retired producer.
                                identity
                                    .begin(false)
                                    .and_then(|_| {
                                        identity.acknowledge(
                                            &native,
                                            Some(json!({"source":"native_turn_start_ack",
                                                "requestId":request_id.as_str(),
                                                "nativeSessionId":native,
                                                "incarnationId":incarnation_id})),
                                        )
                                    })
                                    .map_err(|message| DispatchFailure {
                                        message,
                                        acceptance_ambiguous: true,
                                    })?;
                            }
                        }
                        *current = Some(native.clone());
                        if let Some(profile) = self.profile.lock().expect("profile lock").as_mut() {
                            profile.native_session_id = Some(native.clone());
                            profile.naming_handle = pending_naming_handle.clone();
                            if let Some(reference) = profile.session_ref.as_mut() {
                                reference.session_id = native.clone();
                            }
                        }
                        self.native_tx.send_replace(Some(native.clone()));
                        tracing::info!(request_id=%request_id,native_session_id=%native,native_incarnation_id=%incarnation_id,"freshagent.host.native_dispatch_accepted");
                        Ok(DispatchAck {
                            provider_ack_id: Some(submitted_turn_id),
                            native_identity: Some(NativeDispatchIdentity {
                                previous_native_session_id: session_id,
                                native_session_id: native,
                                pending_naming_handle,
                            }),
                        })
                    }
                    CodexSendOutcome::Refused { code, message, .. } => Err(DispatchFailure {
                        message: format!("{code}: {message}"),
                        acceptance_ambiguous: false,
                    }),
                    CodexSendOutcome::Ambiguous { code, message, .. } => Err(DispatchFailure {
                        message: format!("{code}: {message}"),
                        acceptance_ambiguous: true,
                    }),
                };
            }
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
                native_identity: None,
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
            .provider_session_id()
            .await
            .ok_or_else(|| DispatchFailure {
                message: "fresh-agent session is not started".into(),
                acceptance_ambiguous: false,
            })?;
        // The actor names the parent by its native id. A claude session's own
        // id here is the sidecar's (`created.sessionId`), so the parent is the
        // owned session when either names it.
        let claude = matches!(self.provider, FreshProvider::Claude | FreshProvider::Kilroy);
        let owned = current == parent_session_id
            || (claude
                && self.current_native_id().await.ok().as_deref() == Some(parent_session_id));
        if !owned {
            return Err(DispatchFailure {
                message: "provider-native fork parent no longer matches the owned session".into(),
                acceptance_ambiguous: false,
            });
        }
        let next_launch = self
            .native_identity
            .lock()
            .expect("native identity lock")
            .begin(claude)
            .map_err(|message| DispatchFailure {
                message,
                acceptance_ambiguous: false,
            })?;
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
            ProviderState::Claude(state) => {
                state
                    .handle_fork_with_native_launch(
                        message,
                        None,
                        sink,
                        next_launch.as_ref().map(|launch| json!(launch)),
                    )
                    .await
            }
            ProviderState::Codex(state) => state.handle_fork(message, None, sink).await,
            ProviderState::Opencode { runtime, .. } => {
                runtime.handle_fork(message, None, sink).await
            }
        }
        let forked = match tokio::time::timeout(FORK_TIMEOUT, receiver).await {
            Ok(Ok(ServerMessage::FreshAgentForked(forked))) => forked,
            Ok(Ok(ServerMessage::FreshAgentEvent(event))) if claude => {
                let code = event.event["code"].as_str().unwrap_or_default();
                let correlated_unchanged = event.provider == "claude"
                    && event.session_id == current
                    && event.session_type
                        == if self.provider == FreshProvider::Kilroy {
                            "kilroy"
                        } else {
                            "freshclaude"
                        }
                    && event.event["type"] == "freshAgent.error"
                    && event.event["sessionId"] == current
                    && event.event["requestId"].as_str() == Some(request_id.as_str())
                    && event.event["nativeParentUnchanged"] == true
                    && matches!(
                        code,
                        "BUSY_TURN" | "FORK_IN_PROGRESS" | "FORK_REFUSED" | "INTERNAL_ERROR"
                    );
                let restored = correlated_unchanged
                    && self.provider_session_id().await.as_deref() == Some(current.as_str())
                    && self.provider_session_is_live(&current).await
                    && self
                        .native_identity
                        .lock()
                        .expect("native identity lock")
                        .restore_unchanged_parent(&current, &next_launch);
                crate::emit_environment_event(json!({
                    "severity":if restored {"info"} else {"warn"},
                    "event":"host.native_identity.fork_rejected", "provider":self.provider.as_str(),
                    "requestId":request_id.as_str(), "code":code, "parentProofRestored":restored,
                    "launch":next_launch,
                }));
                return Err(DispatchFailure {
                    message: "provider rejected hosted fork".into(),
                    acceptance_ambiguous: !restored,
                });
            }
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
            || forked.request_id.as_deref() != Some(request_id.as_str())
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
        let evidence = json!({"source":"provider_native_fork_ack","requestId":forked.request_id,
            "parentSessionId":forked.parent_session_id,"nativeSessionId":forked.session_id});
        let child = forked.session_id;
        if let Err(parent_error) = self.retire_provider_session(&current).await {
            // Best-effort transactional rollback: if the child can be retired and
            // the parent is still live, the provider-native branch did not become
            // the current product state and a safe explicit retry is possible.
            let child_rollback = self.retire_provider_session(&child).await;
            let parent_still_live = self.provider_session_is_live(&current).await;
            let mut acceptance_ambiguous =
                parent_error.acceptance_ambiguous || child_rollback.is_err() || !parent_still_live;
            if !acceptance_ambiguous {
                acceptance_ambiguous = self
                    .native_identity
                    .lock()
                    .expect("native identity lock")
                    .acknowledge(
                        &current,
                        Some(json!({"source":"provider_native_fork_reverted",
                        "requestId":request_id.as_str(),"nativeSessionId":current})),
                    )
                    .is_err();
            }
            return Err(DispatchFailure {
                message: "provider-native fork could not retire its previous branch".into(),
                acceptance_ambiguous,
            });
        }
        if !self.provider_session_is_live(&child).await {
            return Err(DispatchFailure {
                message: "native fork child is no longer owned".into(),
                acceptance_ambiguous: true,
            });
        }
        *self.session_id.lock().await = Some(child.clone());
        if claude {
            // The child is the native session from here: snapshots, captures and
            // a later fork address it before its first turn names it.
            let _ = self.native_tx.send(Some(child.clone()));
        }
        self.remember_native_runtime(&child).await;
        self.native_identity
            .lock()
            .expect("native identity lock")
            .acknowledge(&child, (!claude).then_some(evidence))
            .map_err(|message| DispatchFailure {
                message,
                acceptance_ambiguous: true,
            })?;
        Ok(ForkTransition {
            parent_session_id: parent_session_id.to_string(),
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
            .provider_session_id()
            .await
            .ok_or_else(|| DispatchFailure {
                message: "fresh-agent session is not started".into(),
                acceptance_ambiguous: false,
            })?;
        let request_id = StringOrNumber::Str(decision_id.to_string());
        if let Some(elicitation) = decision.get("elicitation") {
            let message = FreshAgentElicitationRespond {
                provider: self.provider_wire(),
                session_id,
                session_type: self.session_type(),
                request_id,
                cwd: None,
                action: serde_json::from_value(elicitation["action"].clone()).map_err(|_| {
                    DispatchFailure {
                        message: "invalid elicitation action".into(),
                        acceptance_ambiguous: false,
                    }
                })?,
                content: serde_json::from_value(elicitation["content"].clone()).map_err(|_| {
                    DispatchFailure {
                        message: "invalid elicitation content".into(),
                        acceptance_ambiguous: false,
                    }
                })?,
            };
            return match &self.state {
                ProviderState::Codex(state) => {
                    if state.try_handle_elicitation_respond(message).await {
                        Ok(())
                    } else {
                        Err(DispatchFailure { message:"Codex did not accept this elicitation response; the request remains pending.".into(), acceptance_ambiguous:false })
                    }
                }
                _ => Err(DispatchFailure {
                    message: "provider has no elicitation flow".into(),
                    acceptance_ambiguous: false,
                }),
            };
        }
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
                ProviderState::Claude(state) => state
                    .dispatch_question_checked(message)
                    .await
                    .map_err(|failure| DispatchFailure {
                        message: failure.message,
                        acceptance_ambiguous: failure.acceptance_ambiguous,
                    })?,
                ProviderState::Codex(state) => {
                    if !state.try_handle_question_respond(message).await {
                        return Err(DispatchFailure {message:"Codex did not accept this question answer; the request remains pending.".into(),acceptance_ambiguous:false});
                    }
                }
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
                ProviderState::Claude(state) => state
                    .dispatch_approval_checked(message)
                    .await
                    .map_err(|failure| DispatchFailure {
                        message: failure.message,
                        acceptance_ambiguous: failure.acceptance_ambiguous,
                    })?,
                ProviderState::Codex(state) => {
                    if !state.try_handle_approval_respond(message).await {
                        return Err(DispatchFailure {message:"Codex did not accept this approval decision; the request remains pending.".into(),acceptance_ambiguous:false});
                    }
                }
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
            .provider_session_id()
            .await
            .ok_or_else(|| "fresh-agent session is not started".to_string())?;
        let message = FreshAgentInterrupt {
            request_id: None,
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
            FreshAgentOperation::Compact { .. } | FreshAgentOperation::Configure { .. } => Ok(true),
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
            .provider_session_id()
            .await
            .ok_or_else(|| OperationFailure {
                kind: OperationFailureKind::Rejected,
                message: "fresh-agent session is not started".into(),
                acceptance_ambiguous: false,
            })?;
        let mut observed_native = None;
        let new_query = matches!(self.provider, FreshProvider::Claude | FreshProvider::Kilroy);
        let mut operation_evidence = None;
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
            FreshAgentOperation::Configure { settings } => {
                // The provider answers on its own event stream, which the
                // bridge relays to every device: a converged
                // `freshAgent.session.metadata`, or an error when it refuses
                // the live apply (the actor has already saved the intent for
                // the next send). Each provider emits that answer before its
                // configure handler returns, so a receiver opened first
                // sees it.
                let mut answers = self.provider_frames.subscribe();
                let message = FreshAgentConfigure {
                    provider: self.provider_wire(),
                    session_id: session_id.clone(),
                    session_type: self.session_type(),
                    cwd: settings.cwd.clone(),
                    request_id: Some(request_id.as_str().to_string()),
                    settings: provider_send_settings(settings),
                };
                match &self.state {
                    ProviderState::Claude(state) => state.handle_configure(message).await,
                    ProviderState::Codex(state) => state.handle_configure(message).await,
                    ProviderState::Opencode { runtime, .. } => {
                        runtime.handle_configure(message).await
                    }
                }
                if let Some(code) = configure_refusal_code(&mut answers, &session_id, request_id) {
                    crate::emit_environment_event(json!({
                        "severity": "warn",
                        "event": "fresh_agent.configure.provider_refused",
                        "stage": "session_host",
                        "provider": self.provider.as_str(),
                        "request_id": request_id.as_str(),
                        "code": code,
                    }));
                    return Err(OperationFailure {
                        kind: OperationFailureKind::Rejected,
                        message: format!("provider refused the live configure ({code})"),
                        acceptance_ambiguous: false,
                    });
                }
            }
            FreshAgentOperation::Rollback {
                direction,
                mode,
                turn_id,
                cwd,
            } => {
                let prior_incarnation = self.native_incarnation.lock().await.clone();
                let before_incarnation = self.provider_session_incarnation(&session_id).await;
                let next_launch = self
                    .native_identity
                    .lock()
                    .expect("native identity lock")
                    .begin(new_query)
                    .map_err(|message| OperationFailure {
                        kind: OperationFailureKind::Rejected,
                        message,
                        acceptance_ambiguous: false,
                    })?;
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
                    session_id: session_id.clone(),
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
                    ProviderState::Claude(state) => {
                        state
                            .handle_rollback_with_native_launch(
                                operation,
                                sink,
                                next_launch.as_ref().map(|launch| json!(launch)),
                            )
                            .await
                    }
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
                    let parent_is_live = frames.iter().any(|frame| {
                        find_correlated_rollback_error(frame, request_id.as_str(), &session_id)
                            == Some(code)
                    }) && self.provider_session_id().await.as_ref()
                        == Some(&session_id)
                        && self.provider_session_is_live(&session_id).await;
                    let same_runtime = new_query
                        || (prior_incarnation.is_some()
                            && before_incarnation == prior_incarnation
                            && self.provider_session_incarnation(&session_id).await
                                == prior_incarnation);
                    let restored = parent_is_live
                        && same_runtime
                        && self
                            .native_identity
                            .lock()
                            .expect("native identity lock")
                            .reject_before_native_transition(
                                &session_id,
                                &next_launch,
                                code,
                                &self.provider,
                            );
                    crate::emit_environment_event(
                        json!({"severity":if restored {"info"} else {"warn"},
                            "event":"host.native_identity.rollback_rejected", "provider":self.provider.as_str(),
                            "requestId":request_id.as_str(), "code":code, "parentProofRestored":restored,
                            "launch":next_launch}),
                    );
                    return Err(OperationFailure {
                        kind: if code == "UNSUPPORTED_CAPABILITY" {
                            OperationFailureKind::Unsupported
                        } else {
                            OperationFailureKind::Rejected
                        },
                        message: "provider rejected hosted rollback".into(),
                        acceptance_ambiguous: !restored,
                    });
                }
                observed_native = frames
                    .iter()
                    .find_map(|frame| find_operation_session_id(frame, request_id.as_str()));
                let Some(root) = observed_native.as_ref() else {
                    return Err(OperationFailure {
                        kind: OperationFailureKind::Rejected,
                        message: "native rollback did not acknowledge its current root".into(),
                        acceptance_ambiguous: true,
                    });
                };
                if !self.provider_session_is_live(root).await {
                    return Err(OperationFailure {
                        kind: OperationFailureKind::Rejected,
                        message: "native rollback root is no longer owned".into(),
                        acceptance_ambiguous: true,
                    });
                }
                if !new_query {
                    operation_evidence = Some(
                        json!({"source":"native_rollback_ack", "requestId":request_id.as_str(), "nativeSessionId":root}),
                    );
                }
                *self.session_id.lock().await = Some(root.clone());
                self.remember_native_runtime(root).await;
                self.native_identity
                    .lock()
                    .expect("native identity lock")
                    .acknowledge(root, operation_evidence)
                    .map_err(|message| OperationFailure {
                        kind: OperationFailureKind::Rejected,
                        message,
                        acceptance_ambiguous: true,
                    })?;
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

    async fn retained_state(&self) -> Result<Option<Value>, String> {
        let ProviderState::Codex(state) = &self.state else {
            return Ok(None);
        };
        let native_id = self.session_id.lock().await.clone();
        match native_id {
            Some(id) => state
                .retained_state(&id)
                .await
                .map(Some)
                .map_err(|error| format!("codex retained state unavailable: {error:?}")),
            None => Ok(None),
        }
    }

    async fn snapshot(&self) -> Result<Value, String> {
        #[cfg(test)]
        if let Some(delegate) = self.test_delegate.as_ref() {
            return delegate.snapshot().await;
        }
        let mut snapshot = self.snapshot_value().await?;
        // The native getter's vacant fallback means its captured HTTP read
        // failed; tracking the session does not make that empty result live.
        if self.provider == FreshProvider::Opencode
            && snapshot["extensions"]["opencode"]["ownerKind"] == "vacant"
        {
            return Err("opencode snapshot unavailable".into());
        }
        let provider = if self.provider == FreshProvider::Kilroy {
            "claude"
        } else {
            self.provider.as_str()
        };
        snapshot["extensions"][provider]["statusFromLiveState"] = serde_json::json!(true);
        Ok(snapshot)
    }

    async fn model_catalog(&self, cwd: Option<&str>) -> Result<Value, String> {
        let before = self.current_native_id().await?;
        let ProviderState::Codex(state) = &self.state else {
            return Err("model catalog requires a bound Codex runtime".into());
        };
        let value = state
            .model_catalog(
                freshell_freshagent::model_capabilities::CodexCatalogContext {
                    session_id: before.clone(),
                    session_ref: None,
                    cwd: cwd.map(str::to_string),
                    observed_epoch: None,
                    observed_generation: None,
                },
            )
            .await
            .map_err(|error| format!("{}: {}", error.code, error.message))?;
        if self.current_native_id().await? != before {
            return Err("model catalog source changed".into());
        }
        Ok(value)
    }

    async fn native_name(
        &self,
        native_session_id: &str,
        codex_home: &str,
        operation: &FreshAgentNativeNameOperation,
    ) -> FreshAgentNativeNameReply {
        let unavailable = || {
            FreshAgentNativeNameReply::Failed(FreshAgentNativeNameError::Unavailable {
                message: "no current root-matched native naming connection".into(),
            })
        };
        if self.current_native_id().await.as_deref() != Ok(native_session_id) {
            return unavailable();
        }
        let ProviderState::Codex(state) = &self.state else {
            return unavailable();
        };
        let Some(client) = state.management_client_for_root(codex_home).await else {
            return unavailable();
        };
        // The probe inspects existing authority only; it sends no native RPC.
        let result = match operation {
            FreshAgentNativeNameOperation::Probe => return FreshAgentNativeNameReply::Available,
            FreshAgentNativeNameOperation::Read => client
                .read_thread_metadata(native_session_id)
                .await
                .and_then(|value| {
                    if value["thread"]["id"].as_str() != Some(native_session_id) {
                        return Err(
                            freshell_codex::app_server::CodexAppServerError::InvalidResponse {
                                method: "thread/read".into(),
                                detail: "native metadata names another thread".into(),
                            },
                        );
                    }
                    Ok(FreshAgentNativeNameReply::Title(
                        freshell_codex::protocol::thread_name_from_result(&value),
                    ))
                }),
            FreshAgentNativeNameOperation::Write { title } => client
                .set_thread_name(native_session_id, title)
                .await
                .map(|()| FreshAgentNativeNameReply::Renamed),
        };
        if self.current_native_id().await.as_deref() != Ok(native_session_id) {
            return FreshAgentNativeNameReply::Failed(FreshAgentNativeNameError::Closed);
        }
        result.unwrap_or_else(|error| {
            use freshell_codex::app_server::CodexAppServerError as Error;
            let failure_kind = match &error {
                Error::Rpc { .. } => "rpc",
                Error::Timeout { .. } => "timeout",
                Error::Closed { .. } => "closed",
                Error::Transport { .. } => "transport",
                Error::InvalidResponse { .. } => "invalid_response",
            };
            tracing::warn!(
                provider = "codex",
                native_session_id,
                failure_kind,
                "freshagent.codex.native_name_failed"
            );
            FreshAgentNativeNameReply::Failed(match error {
                Error::Rpc { error, .. } => FreshAgentNativeNameError::Rpc {
                    code: error.code,
                    message: error.message,
                },
                Error::Timeout { timeout_ms, .. } => {
                    FreshAgentNativeNameError::Timeout { timeout_ms }
                }
                Error::Closed { .. } => FreshAgentNativeNameError::Closed,
                Error::Transport { message, .. } => {
                    FreshAgentNativeNameError::Transport { message }
                }
                Error::InvalidResponse { detail, .. } => {
                    FreshAgentNativeNameError::InvalidResponse { detail }
                }
            })
        })
    }

    async fn read_child(&self, child_thread_id: &str) -> Result<Value, String> {
        #[cfg(test)]
        if let Some(delegate) = self.test_delegate.as_ref() {
            return delegate.read_child(child_thread_id).await;
        }
        let parent = self.current_native_id().await?;
        match &self.state {
            ProviderState::Codex(state) => state
                .read_child(&parent, child_thread_id, None, None)
                .await
                .map_err(|error| format!("codex child observation unavailable: {error:?}")),
            _ => Err("provider does not expose child observation".into()),
        }
    }

    async fn registered_snapshot_identity(&self) -> Option<String> {
        if self.provider != FreshProvider::Opencode
            || self.native_rx.lock().await.borrow().is_some()
            || self
                .profile
                .lock()
                .unwrap()
                .as_ref()?
                .native_session_id
                .is_some()
        {
            return None;
        }
        let session_id = self.provider_session_id().await?;
        let ProviderState::Opencode { runtime, .. } = &self.state else {
            return None;
        };
        if !runtime.has_live_session(&session_id).await
            || self.native_rx.lock().await.borrow().is_some()
        {
            return None;
        }
        Some(session_id)
    }

    async fn is_live(&self) -> bool {
        #[cfg(test)]
        if let Some(delegate) = self.test_delegate.as_ref() {
            return delegate.is_live().await;
        }
        let Some(session_id) = self.provider_session_id().await else {
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
        {
            let mut identity = self.native_identity.lock().expect("native identity lock");
            identity.pending = true;
            identity.invalidate_current_query();
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

fn provider_send_settings(
    settings: &freshell_runtime_protocol::FreshAgentTurnSettings,
) -> FreshAgentSendSettings {
    FreshAgentSendSettings {
        collaboration_mode: settings.collaboration_mode.clone(),
        cwd: settings.cwd.clone(),
        model: settings.model.clone(),
        effort: settings.effort.clone(),
        permission_mode: settings.permission_mode.clone(),
        sandbox: settings.sandbox.as_deref().and_then(parse_sandbox),
    }
}

#[cfg(test)]
fn effective_permission_mode(profile: &FreshAgentProfile) -> Option<String> {
    profile.effective_permission_mode().map(str::to_owned)
}

#[cfg(test)]
fn send_settings_for_profile(profile: &FreshAgentProfile) -> FreshAgentSendSettings {
    FreshAgentSendSettings {
        cwd: Some(profile.cwd.clone()),
        collaboration_mode: profile.collaboration_mode.clone(),
        effort: Some(profile.effort.clone()),
        model: profile.model.clone(),
        permission_mode: effective_permission_mode(profile),
        sandbox: profile.sandbox.as_deref().and_then(parse_sandbox),
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
        collaboration_mode: profile.collaboration_mode.clone(),
        pane_id: None,
        request_id: format!("host-create-{}", uuid::Uuid::new_v4()),
        observed_epoch: None,
        observed_generation: None,
        naming_handle: profile.naming_handle.clone(),
        session_type,
        cwd: Some(profile.cwd.clone()),
        effort: if profile.provider == FreshProvider::Codex {
            Some(profile.effort.clone())
        } else {
            profile.effort.clone().map(Some)
        },
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
        permission_mode: profile.effective_permission_mode().map(str::to_owned),
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
    owned_session: Option<Arc<Mutex<Option<String>>>>,
    retained_codex: Option<FreshCodexState>,
    created: watch::Sender<Option<Result<String, String>>>,
    native: watch::Sender<Option<String>>,
    native_evidence: watch::Sender<Option<Value>>,
    native_identity: Arc<std::sync::Mutex<HostedNativeIdentity>>,
    events: mpsc::Sender<AgentEvent>,
    send_outcomes: broadcast::Sender<(String, bool)>,
    kill_outcomes: broadcast::Sender<(String, bool)>,
    suppressed_kills: Arc<std::sync::Mutex<HashSet<String>>>,
    #[cfg(test)]
    refusal_observer: Option<mpsc::Sender<Value>>,
}

fn publish_native_identity(
    identity: &std::sync::Mutex<HostedNativeIdentity>,
    root: &str,
    evidence: Value,
    native: &watch::Sender<Option<String>>,
    native_evidence: &watch::Sender<Option<Value>>,
) -> NativeProofReception {
    let mut identity = identity.lock().expect("native identity lock");
    let reception = identity.observe(root, evidence);
    if reception != NativeProofReception::Published {
        return reception;
    }
    native_evidence.send_replace(identity.evidence.clone());
    let _ = native.send(Some(root.into()));
    NativeProofReception::Published
}

struct BroadcastBridgeTasks {
    recovery: tokio::task::JoinHandle<()>,
    forward: tokio::task::JoinHandle<()>,
}

impl Drop for BroadcastBridgeTasks {
    fn drop(&mut self) {
        self.recovery.abort();
        self.forward.abort();
    }
}

fn spawn_broadcast_bridge(
    provider: FreshProvider,
    mut receiver: broadcast::Receiver<String>,
    outputs: BroadcastBridgeOutputs,
) -> BroadcastBridgeTasks {
    let expected_launch = freshell_platform::managed_child_secrets::snapshot()
        .and_then(|environment| environment.get(super::native_identity::LAUNCH_ENV).cloned())
        .and_then(|value| {
            serde_json::from_str::<freshell_runtime_protocol::NativeIdentityLaunch>(&value).ok()
        });
    let BroadcastBridgeOutputs {
        owned_session,
        retained_codex,
        created,
        native,
        native_evidence,
        native_identity,
        events,
        send_outcomes,
        kill_outcomes,
        suppressed_kills,
        #[cfg(test)]
        refusal_observer,
    } = outputs;
    // claude/kilroy: the native identity is announced once per distinct id
    // (design §7.3). `freshAgent.created` names a resumed conversation (the CLI
    // booted it before the sidecar answered); a fresh one is named by its first
    // turn's init or by `materialized`. Every later turn's init repeats the same
    // id and announces nothing. The identity watch records the id last
    // announced (a fork's transport records its child there, C14).
    let claude = matches!(provider, FreshProvider::Claude | FreshProvider::Kilroy);
    {
        let mut identity = native_identity.lock().expect("native identity lock");
        identity.launch = expected_launch.clone();
        identity.producer_launch = expected_launch;
    }
    // One coalesced recovery slot, independent of later provider traffic.
    let (recovery, mut recovery_rx) = watch::channel(None::<Value>);
    let recovery_events = events.clone();
    let recovery_native = native.clone();
    let recovery_provider = provider.clone();
    let mut retained_changes = retained_codex
        .as_ref()
        .map(|state| state.subscribe_retained_state(""));
    let recovery_task = tokio::spawn(async move {
        loop {
            let loss = tokio::select! {
                result = recovery_rx.changed() => { if result.is_err() {break;} true },
                _ = async { match &mut retained_changes { Some(changes) => { let _ = changes.changed().await; }, None => std::future::pending::<()>().await } } => false,
                _ = recovery_events.closed() => break,
            };
            if !loss && recovery_events.capacity() > 0 {
                continue;
            }
            let Ok(permit) = recovery_events.reserve().await else {
                break;
            };
            let mut payload = recovery_rx.borrow_and_update().clone();
            if let Some(changes) = &mut retained_changes {
                changes.borrow_and_update();
            }
            let mut pending = Vec::new();
            if let Some(state) = &retained_codex {
                let owned = match &owned_session {
                    Some(session) => session.lock().await.clone(),
                    None => None,
                };
                if let Some(session_id) = owned.or_else(|| recovery_native.borrow().clone()) {
                    match state.retained_state(&session_id).await {
                        Ok(retained) => {
                            pending = retained["pendingControls"]
                                .as_array()
                                .cloned()
                                .unwrap_or_default();
                            let dropped = payload
                                .as_ref()
                                .and_then(|frame| frame["event"]["dropped"].as_u64())
                                .unwrap_or(1);
                            let mut frame = bridge_recovery_frame(
                                &recovery_provider,
                                "freshcodex",
                                retained["snapshot"]["threadId"]
                                    .as_str()
                                    .unwrap_or(&session_id),
                                dropped,
                            );
                            frame["event"]["retainedState"] = retained;
                            payload = Some(frame);
                        }
                        Err(error) => {
                            tracing::warn!(provider=recovery_provider.as_str(),session_id,error=?error,"freshagent.host.retained_source_unavailable")
                        }
                    }
                }
            }
            let Some(payload) = payload else { continue };
            tracing::warn!(
                provider = recovery_provider.as_str(),
                session_id = payload["sessionId"].as_str().unwrap_or_default(),
                dropped = payload["event"]["dropped"].as_u64().unwrap_or_default(),
                retained = payload["event"]["retainedState"].is_object(),
                "freshagent.host.bridge_recovered"
            );
            permit.send(AgentEvent::Provider { payload });
            for payload in pending {
                if let Some(decision_id) = payload["requestId"].as_str() {
                    if recovery_events
                        .send(AgentEvent::PermissionRequested {
                            decision_id: decision_id.to_owned(),
                            payload,
                        })
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
            }
        }
    });
    let forward_task = tokio::spawn(async move {
        let mut dropped = 0u64;
        let mut last_route: Option<(String, String)> = None;
        let mut native_query_generation = 0u64;
        let mut closed_query_generation = 0u64;
        let mut query_launch = None;
        loop {
            let frame = match receiver.recv().await {
                Ok(frame) => frame,
                Err(broadcast::error::RecvError::Lagged(count)) => {
                    dropped = dropped.saturating_add(count);
                    if let Some((session_id, session_type)) = &last_route {
                        recovery.send_replace(Some(bridge_recovery_frame(
                            &provider,
                            session_type,
                            session_id,
                            dropped,
                        )));
                        dropped = 0;
                    }
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => break,
            };
            let Ok(value) = serde_json::from_str::<Value>(&frame) else {
                continue;
            };
            if let (Some(session_id), Some(session_type)) =
                (value["sessionId"].as_str(), value["sessionType"].as_str())
            {
                last_route = Some((session_id.to_owned(), session_type.to_owned()));
            }
            let expected_launch = native_identity
                .lock()
                .expect("native identity lock")
                .producer_launch
                .clone();
            if query_launch != expected_launch {
                query_launch = expected_launch.clone();
                closed_query_generation = 0;
                native_query_generation = native_identity
                    .lock()
                    .expect("native identity lock")
                    .evidence
                    .as_ref()
                    .and_then(|proof| proof["queryGeneration"].as_u64())
                    .unwrap_or(0);
            }
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
                let code = value
                    .get("code")
                    .and_then(Value::as_str)
                    .unwrap_or("PROVIDER_CREATE_FAILED");
                let message = value
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("provider create rejected");
                let _ = created.send(Some(Err(format!("{code}: {message}"))));
            }
            if value.get("type").and_then(Value::as_str) == Some("freshAgent.created") {
                if let Some(session_id) = value.get("sessionId").and_then(Value::as_str) {
                    if claude {
                        if let Some(native_id) = claude_session_ref_id(&value) {
                            if !announce_native(native_id, &native, &events).await {
                                break;
                            }
                        }
                    }
                    let _ = created.send(Some(Ok(session_id.to_string())));
                    if matches!(provider, FreshProvider::Codex) {
                        publish_native_identity(
                            &native_identity,
                            session_id,
                            json!({"nativeSessionId":session_id,"source":"native_app_server_create"}),
                            &native,
                            &native_evidence,
                        );
                    }
                }
            }
            if value.get("type").and_then(Value::as_str) == Some("freshAgent.session.materialized")
            {
                if let Some(session_id) = value.get("sessionId").and_then(Value::as_str) {
                    if claude {
                        if !announce_native(session_id, &native, &events).await {
                            break;
                        }
                    } else if publish_native_identity(
                        &native_identity,
                        session_id,
                        json!({"nativeSessionId":session_id,"source":"native_session_materialized"}),
                        &native,
                        &native_evidence,
                    ) == NativeProofReception::Published
                        && events
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
                native_identity
                    .lock()
                    .expect("native identity lock")
                    .observe_parent_query_change(event);
                let event_type = event
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if event_type == "freshAgent.session.loading"
                    && matches!(provider, FreshProvider::Claude | FreshProvider::Kilroy)
                {
                    let binding = &event["nativeBinding"];
                    let launch = serde_json::from_value::<
                        freshell_runtime_protocol::NativeIdentityLaunch,
                    >(binding["launch"].clone())
                    .ok();
                    let current = native_evidence.borrow().clone();
                    let current_launch = expected_launch.clone().or_else(|| {
                        current.as_ref().and_then(|evidence| {
                            serde_json::from_value::<
                                    freshell_runtime_protocol::NativeIdentityLaunch,
                                >(evidence["launch"].clone())
                                .ok()
                        })
                    });
                    if launch.is_some() && launch == current_launch {
                        if let Some(generation) = binding["queryGeneration"]
                            .as_u64()
                            .filter(|generation| *generation > native_query_generation)
                        {
                            native_query_generation = generation;
                            {
                                let mut identity =
                                    native_identity.lock().expect("native identity lock");
                                identity.invalidate_current_query();
                            }
                            let _ = native.send(None);
                            native_evidence.send_replace(None);
                        }
                    }
                }
                if event_type == "freshAgent.session.closed" && claude {
                    let binding = &event["nativeBinding"];
                    let generation = event["queryGeneration"].as_u64();
                    let matches_launch = serde_json::from_value::<
                        freshell_runtime_protocol::NativeIdentityLaunch,
                    >(binding["launch"].clone())
                    .ok()
                    .is_some_and(|launch| Some(&launch) == expected_launch.as_ref());
                    let closed = {
                        let mut identity = native_identity.lock().expect("native identity lock");
                        if matches_launch
                            && !identity.pending
                            && generation.is_some_and(|generation| {
                                generation > 0
                                    && generation == native_query_generation
                                    && Some(generation) == binding["queryGeneration"].as_u64()
                            })
                            && event["nativeSessionId"]
                                .as_str()
                                .is_some_and(|root| identity.root.as_deref() == Some(root))
                        {
                            identity.invalidate_current_query();
                            true
                        } else {
                            false
                        }
                    };
                    if closed {
                        closed_query_generation = generation.unwrap();
                        native.send_replace(None);
                        native_evidence.send_replace(None);
                    }
                }
                if event_type == "freshAgent.session.init" {
                    let generation = event["nativeIdentityEvidence"]["queryGeneration"].as_u64();
                    if generation.is_some_and(|generation| {
                        generation < native_query_generation
                            || generation <= closed_query_generation
                    }) || (expected_launch.is_some()
                        && generation.is_none_or(|generation| generation == 0))
                    {
                        continue;
                    }
                    if let Some(expected) = expected_launch.as_ref() {
                        let evidence = &event["nativeIdentityEvidence"];
                        let actual = serde_json::from_value::<
                            freshell_runtime_protocol::NativeIdentityLaunch,
                        >(evidence["launch"].clone());
                        let digest = evidence["digest"].as_str().unwrap_or_default();
                        if actual.as_ref().ok() != Some(expected)
                            || digest.len() != 64
                            || !digest.bytes().all(|byte| byte.is_ascii_hexdigit())
                        {
                            continue;
                        }
                    }
                    let mut refused = true;
                    if let Some(session_id) = event
                        .get("cliSessionId")
                        .and_then(Value::as_str)
                        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
                    {
                        let was_announced = native.borrow().as_deref() == Some(session_id);
                        let reception = publish_native_identity(&native_identity, session_id,
                            event.get("nativeIdentityEvidence").cloned().unwrap_or_else(||json!({"nativeSessionId":session_id,"source":"native_sdk_system_init"})),
                            &native, &native_evidence);
                        refused = reception == NativeProofReception::Rejected;
                        if reception != NativeProofReception::Rejected {
                            if let Some(generation) = generation {
                                native_query_generation = generation;
                            }
                        }
                        if reception == NativeProofReception::Published
                            && (!claude || !was_announced)
                            && events
                                .send(AgentEvent::Started {
                                    native_session_id: session_id.to_string(),
                                })
                                .await
                                .is_err()
                        {
                            break;
                        }
                    }
                    if refused && matches!(provider, FreshProvider::Claude | FreshProvider::Kilroy)
                    {
                        // Report the actual normalized receiver decision, never
                        // provider prose, local presentation keys or bodies.
                        let reason = match event.get("cliSessionId").and_then(Value::as_str) {
                            None => "missing_cli_session_id",
                            Some(id) if event["sessionId"].as_str() == Some(id) => {
                                "local_placeholder_id"
                            }
                            Some(id) if uuid::Uuid::parse_str(id).is_err() => {
                                "invalid_cli_session_id"
                            }
                            Some(_) => "wrong_native_root",
                        };
                        let launch = expected_launch.clone().or_else(|| {
                            serde_json::from_value::<
                            freshell_runtime_protocol::NativeIdentityLaunch,
                        >(event["nativeIdentityEvidence"]["launch"].clone()).ok()
                        });
                        let record = json!({"severity":"warn","event":"host.native_identity.refused",
                            "provider":provider.as_str(),"reason":reason,"launch":launch,
                            "normalizedEventType":"freshAgent.session.init",
                            "nativeEvidenceDigest":event["nativeIdentityEvidence"]["digest"].as_str()
                                .filter(|digest| digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())),
                            "nativeEvidenceSource":event["nativeIdentityEvidence"]["source"].as_str()
                                .filter(|source| matches!(*source, "startup" | "resume" | "clear" | "fork")),
                            "queryGeneration":generation,"nativeReceiverPublished":false,
                            "nativeReceiverContainsIdentity":native.borrow().is_some()});
                        crate::emit_environment_event(record.clone());
                        #[cfg(test)]
                        if let Some(observer) = refusal_observer.as_ref() {
                            let _ = observer.try_send(record);
                        }
                        // A normalized clear can advance the actor's delayed
                        // projection. A clear refused by this native owner must
                        // therefore remain diagnostic only. Buffered operation
                        // candidates still settle through their correlated ACK.
                        if event["nativeIdentityEvidence"]["source"] == "clear" {
                            continue;
                        }
                    }
                }
                if event_type == "freshAgent.native.loaded" && provider == FreshProvider::Opencode {
                    if let Some(root) =
                        event
                            .get("nativeSessionId")
                            .and_then(Value::as_str)
                            .filter(|root| {
                                expected_launch
                                    .as_ref()
                                    .and_then(|launch| {
                                        launch.requested_native_session_id.as_deref()
                                    })
                                    .is_none_or(|expected| expected == *root)
                            })
                    {
                        if publish_native_identity(
                            &native_identity,
                            root,
                            event["evidence"].clone(),
                            &native,
                            &native_evidence,
                        ) == NativeProofReception::Published
                            && events
                                .send(AgentEvent::Started {
                                    native_session_id: root.into(),
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
                    || event_type == "freshAgent.elicitation.request"
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
            if captured_decision {
                continue;
            }
            if events
                .try_send(AgentEvent::Provider {
                    payload: value.clone(),
                })
                .is_err()
            {
                dropped = dropped.saturating_add(1);
            }
            if dropped > 0 {
                if let Some(session_id) = value["sessionId"].as_str() {
                    recovery.send_replace(Some(bridge_recovery_frame(
                        &provider,
                        value["sessionType"].as_str().unwrap_or("freshcodex"),
                        session_id,
                        dropped,
                    )));
                    dropped = 0;
                }
            }
        }
    });
    BroadcastBridgeTasks {
        recovery: recovery_task,
        forward: forward_task,
    }
}

fn bridge_recovery_frame(
    provider: &FreshProvider,
    session_type: &str,
    session_id: &str,
    dropped: u64,
) -> Value {
    json!({"type":"freshAgent.event", "provider":if matches!(provider, FreshProvider::Kilroy) {"claude"} else {provider.as_str()},
        "sessionType":session_type,"sessionId":session_id,"event":{"type":"freshAgent.host.backpressure","dropped":dropped}})
}

/// The claude conversation a `freshAgent.created` names in its `sessionRef`.
fn claude_session_ref_id(created: &Value) -> Option<&str> {
    let reference = created.get("sessionRef")?;
    (reference.get("provider").and_then(Value::as_str) == Some("claude"))
        .then(|| reference.get("sessionId").and_then(Value::as_str))
        .flatten()
        .filter(|id| !id.is_empty())
}

/// Publish `native_id` as the session's native identity and send one
/// `AgentEvent::Started` for it, unless it is the id last announced. False once
/// the event receiver is gone.
async fn announce_native(
    native_id: &str,
    native: &watch::Sender<Option<String>>,
    events: &mpsc::Sender<AgentEvent>,
) -> bool {
    if native.borrow().as_deref() == Some(native_id) {
        return true;
    }
    let _ = native.send(Some(native_id.to_string()));
    events
        .send(AgentEvent::Started {
            native_session_id: native_id.to_string(),
        })
        .await
        .is_ok()
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
        FreshAgentOperation::Compact { .. } | FreshAgentOperation::Configure { .. } => return true,
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

/// The code of the error a provider answered a configure with, if any: a
/// `freshAgent.error` for the configured session, or a top-level `error`
/// correlated to the configure's request id (the unknown-session answer).
fn configure_refusal_code(
    answers: &mut broadcast::Receiver<String>,
    session_id: &str,
    request_id: &RequestId,
) -> Option<String> {
    loop {
        let frame = match answers.try_recv() {
            Ok(frame) => frame,
            Err(broadcast::error::TryRecvError::Lagged(_)) => continue,
            Err(_) => return None,
        };
        let Ok(value) = serde_json::from_str::<Value>(&frame) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) == Some("error")
            && value.get("requestId").and_then(Value::as_str) == Some(request_id.as_str())
        {
            return Some(
                value
                    .get("code")
                    .and_then(Value::as_str)
                    .unwrap_or("error")
                    .to_string(),
            );
        }
        if value.get("sessionId").and_then(Value::as_str) != Some(session_id) {
            continue;
        }
        if let Some(code) = value
            .get("event")
            .filter(|event| event.get("type").and_then(Value::as_str) == Some("freshAgent.error"))
            .and_then(|event| event.get("code"))
            .and_then(Value::as_str)
        {
            return Some(code.to_string());
        }
    }
}

fn find_correlated_rollback_error<'a>(
    value: &'a Value,
    request_id: &str,
    parent: &str,
) -> Option<&'a str> {
    if value["type"] == "freshAgent.error"
        && value["requestId"] == request_id
        && value["sessionId"] == parent
        && value["rollback"] == true
    {
        return value["code"].as_str();
    }
    value
        .get("event")
        .and_then(|event| find_correlated_rollback_error(event, request_id, parent))
}

fn find_operation_session_id(value: &Value, request_id: &str) -> Option<String> {
    if matches!(
        value.get("type").and_then(Value::as_str),
        Some("freshAgent.rolledBack") | Some("freshAgent.redone")
    ) && value.get("requestId").and_then(Value::as_str) == Some(request_id)
    {
        return value
            .get("newSessionId")
            .or_else(|| value.get("sessionId"))
            .and_then(Value::as_str)
            .map(str::to_string);
    }
    match value {
        Value::Object(object) => object
            .values()
            .find_map(|value| find_operation_session_id(value, request_id)),
        Value::Array(values) => values
            .iter()
            .find_map(|value| find_operation_session_id(value, request_id)),
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

// Native provider fixtures and opaque cleanup fixtures share one process view.
#[cfg(test)]
pub(super) static NATIVE_PROVIDER_FIXTURE_LOCK: Mutex<()> = Mutex::const_new(());

#[cfg(test)]
mod tests {
    use super::*;
    use freshell_freshagent::session_lease::CondemnedRuntimeIdentity;

    #[tokio::test]
    async fn task6_dropping_transport_closes_its_owned_bridge_without_more_provider_frames() {
        let _lock = NATIVE_PROVIDER_FIXTURE_LOCK.lock().await;
        let transport = HostedTransport::new(FreshProvider::Codex).await;
        let mut events = transport.take_event_stream().unwrap();
        // No native process/session was started. Dropping this transport must
        // release its producers even when the consumer is still waiting.
        drop(transport);
        let final_event = tokio::time::timeout(Duration::from_millis(300), events.recv())
            .await
            .expect("owned bridge must close without another provider frame");
        assert!(final_event.is_none());
    }

    // The real host actor drains the tested bridge; startup is already complete
    // in the native fixture, so this adapter only hands over its owned stream.
    struct StartedBridgeTransport {
        native: String,
        events: std::sync::Mutex<Option<mpsc::Receiver<AgentEvent>>>,
    }

    #[async_trait]
    impl FreshAgentTransport for StartedBridgeTransport {
        async fn start(&self, _: &FreshAgentProfile) -> Result<TransportStart, String> {
            Ok(TransportStart {
                native_session_id: Some(self.native.clone()),
            })
        }
        async fn dispatch(
            &self,
            _: &RequestId,
            _: &str,
            _: &FreshAgentProfile,
        ) -> Result<DispatchAck, DispatchFailure> {
            unreachable!()
        }
        async fn resolve_permission(&self, _: &str, _: Value) -> Result<(), DispatchFailure> {
            Err(DispatchFailure {
                message: "this actor does not own that decision".into(),
                acceptance_ambiguous: false,
            })
        }
        async fn interrupt(&self) -> Result<(), String> {
            unreachable!()
        }
        async fn stop(self: Arc<Self>) -> Result<(), String> {
            Ok(())
        }
        fn take_event_stream(&self) -> Option<mpsc::Receiver<AgentEvent>> {
            self.events.lock().unwrap().take()
        }
    }

    #[tokio::test]
    async fn task6_recovery_does_not_journal_another_sessions_pending_decision() {
        let mut fixture = native_codex_fixture(json!({"recordTurns":true,"serverRequestsByPrompt":{"ask":{"id":71,"method":"item/tool/requestUserInput","params":{"isBlocking":true,"questions":[{"id":"choice","header":"Choice","question":"Other session only?","options":null}]}}}})).await;
        let transport = fixture.transport.clone();
        transport.start(&fixture.profile).await.unwrap();
        transport
            .dispatch(
                &RequestId::parse("other-pending").unwrap(),
                "ask",
                &fixture.profile,
            )
            .await
            .unwrap();
        let other_control = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let frame: Value =
                    serde_json::from_str(&fixture.diagnostic.recv().await.unwrap()).unwrap();
                if frame["event"]["type"] == "freshAgent.question.request" {
                    break frame["event"].clone();
                }
            }
        })
        .await
        .unwrap();
        let ProviderState::Codex(state) = &transport.state else {
            unreachable!()
        };
        let state = state.clone();
        let mut owned_profile = fixture.profile.clone();
        owned_profile.native_session_id = Some("thread-owned-2".into());
        state
            .handle_create(create_request_for_profile(&owned_profile), None)
            .await;
        assert!(
            state.retained_state("thread-owned-2").await.is_ok(),
            "both native sessions must actually be registered"
        );
        state.handle_kill(serde_json::from_value(json!({"provider":"codex","sessionType":"freshcodex","sessionId":"thread-owned-2"})).unwrap()).await;
        assert!(state.retained_state("thread-owned-2").await.is_err());
        assert_eq!(
            state.retained_state("thread-new-1").await.unwrap()["pendingControls"][0],
            other_control
        );

        let (bus, receiver) = broadcast::channel(8);
        let (events, stream) = mpsc::channel(1);
        events
            .send(AgentEvent::Provider {
                payload: json!({"occupied":true}),
            })
            .await
            .unwrap();
        let (native, _) = watch::channel(Some("thread-owned-2".into()));
        let (created, _) = watch::channel(None);
        let bridge = spawn_broadcast_bridge(
            FreshProvider::Codex,
            receiver,
            BroadcastBridgeOutputs {
                native_evidence: watch::channel(None).0,
                native_identity: Arc::new(std::sync::Mutex::new(HostedNativeIdentity::default())),
                refusal_observer: None,
                owned_session: None,
                retained_codex: Some(state.clone()),
                created,
                native,
                events: events.clone(),
                send_outcomes: broadcast::channel(8).0,
                kill_outcomes: broadcast::channel(8).0,
                suppressed_kills: Arc::new(std::sync::Mutex::new(HashSet::new())),
            },
        );
        bus.send(json!({"type":"freshAgent.event","provider":"codex","sessionType":"freshcodex","sessionId":"thread-owned-2","event":{"type":"freshAgent.notice","message":"last dropped frame"}}).to_string()).unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;
        let actor = FreshAgentHostActor::open(
            fixture.dir.path().join("isolated-actor"),
            owned_profile,
            Arc::new(StartedBridgeTransport {
                native: "thread-owned-2".into(),
                events: std::sync::Mutex::new(Some(stream)),
            }),
        )
        .await
        .unwrap();
        tokio::time::timeout(Duration::from_secs(3),async {
            loop {
                if actor.read_events(0,256).await.events.iter().any(|entry|matches!(&entry.event,AgentEvent::Provider {payload} if payload["event"]["type"]=="freshAgent.host.backpressure")) {break;}
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.expect("capacity alone must settle the final lost frame");
        // No later provider frame is emitted. Allow the recovered durable-control
        // conversion to finish, then inspect the actual actor journal/decision API.
        tokio::time::sleep(Duration::from_millis(100)).await;
        let batch = actor.read_events(0, 256).await;
        let resolution = actor
            .resolve_permission(
                other_control["requestId"].as_str().unwrap(),
                json!({"answers":{"choice":"wrong actor"}}),
            )
            .await;
        drop(bridge);
        drop(events);
        actor.stop().await.unwrap();
        transport.stop().await.unwrap();
        assert!(!batch.events.iter().any(|entry|matches!(&entry.event,AgentEvent::PermissionRequested {..})),"another registered source must never become this actor's durable pending decision: {batch:?}");
        assert!(
            matches!(
                resolution,
                Err(freshell_agent_runtime::host_actor::ActorError::UnknownDecision)
            ),
            "the foreign decision must not exist in this actor: {resolution:?}"
        );
        assert!(!batch.events.iter().any(|entry|matches!(&entry.event,AgentEvent::Provider {payload} if payload["event"]["retainedState"]["snapshot"]["threadId"]=="thread-new-1")),"a recovery marker cannot carry another source's transcript");
    }

    struct NativeCodexFixture {
        transport: Arc<HostedTransport>,
        profile: FreshAgentProfile,
        diagnostic: broadcast::Receiver<String>,
        dir: tempfile::TempDir,
        _exec_dir: tempfile::TempDir,
        _environment: NativeCodexFixtureEnvironment,
    }

    // Keep restoration and its lock together even when a fixture is destructured
    // into local bindings. Fields drop in declaration order, so the snapshot is
    // restored before another fixture may acquire the environment lock.
    struct NativeCodexFixtureEnvironment {
        _snapshot: SnapshotProviderEnv,
        _lock: tokio::sync::MutexGuard<'static, ()>,
    }

    async fn native_codex_fixture(mut behavior: Value) -> NativeCodexFixture {
        behavior
            .as_object_mut()
            .unwrap()
            .entry("echoRequestedModel")
            .or_insert(json!(true));
        let _lock = NATIVE_PROVIDER_FIXTURE_LOCK.lock().await;
        let dir = tempfile::tempdir().unwrap();
        let boot_log = dir.path().join("native-boots.jsonl");
        let startup_error_log = dir.path().join("native-startup-errors.jsonl");
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs")
            .canonicalize()
            .unwrap();
        let keys = [
            "CODEX_CMD",
            "CODEX_HOME",
            "FAKE_CODEX_APP_SERVER_BEHAVIOR",
            "FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES",
        ];
        let _environment = SnapshotProviderEnv(
            keys.iter()
                .map(|key| (*key, std::env::var_os(key)))
                .collect(),
        );
        let exec_dir = match std::env::var_os("FRESHELL_TEST_EXECUTABLE_TMP_DIR") {
            Some(directory) => tempfile::tempdir_in(directory),
            None => tempfile::tempdir(),
        }
        .expect("owned executable fixture directory");
        let wrapper = exec_dir.path().join("codex.mjs");
        std::fs::write(
            &wrapper,
            format!(
                r#"#!/usr/bin/env node
import fs from 'node:fs'
const stat = fs.readFileSync('/proc/self/stat', 'utf8').split(') ').pop().split(' ')
fs.appendFileSync({}, JSON.stringify({{pid:process.pid,startTime:Number(stat[19]),ownershipId:process.env.FRESHELL_CODEX_SIDECAR_ID}})+'\n')
try {{
  await import({});
}} catch (error) {{
  try {{
    fs.appendFileSync({}, JSON.stringify({{message:error?.message ?? String(error),stack:error?.stack ?? null}})+'\n')
  }} catch {{}}
  throw error
}}
"#,
                serde_json::to_string(&boot_log).unwrap(),
                serde_json::to_string(&fixture).unwrap(),
                serde_json::to_string(&startup_error_log).unwrap()
            ),
        )
        .unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        std::env::set_var("CODEX_CMD", wrapper);
        let codex_home = dir.path().join("codex-home");
        std::fs::create_dir_all(&codex_home).unwrap();
        std::env::set_var("CODEX_HOME", codex_home);
        std::env::set_var("FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES", "1");
        std::env::set_var("FAKE_CODEX_APP_SERVER_BEHAVIOR", behavior.to_string());
        let transport = HostedTransport::new(FreshProvider::Codex).await;
        let mut profile = parity_profile(FreshProvider::Codex);
        profile.cwd = dir.path().to_string_lossy().into();
        profile.native_session_id = None;
        profile.session_ref = None;
        profile.plugins = None;
        profile.provider_launch_context = None;
        profile.provider_secret_references.clear();
        profile.model = Some("gpt-5.3-codex-spark".into());
        profile.model_selection = None;
        profile.effort = None;
        profile.permission_mode = Some("never".into());
        let diagnostic = transport.provider_frames.subscribe();
        NativeCodexFixture {
            transport,
            profile,
            diagnostic,
            dir,
            _exec_dir: exec_dir,
            _environment: NativeCodexFixtureEnvironment {
                _snapshot: _environment,
                _lock,
            },
        }
    }

    fn native_boots(fixture: &NativeCodexFixture) -> Vec<Value> {
        std::fs::read_to_string(fixture.dir.path().join("native-boots.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn native_boot_is_live(boot: &Value) -> bool {
        freshell_codex::sidecar_store::proc_starttime(boot["pid"].as_i64().unwrap() as i32)
            == boot["startTime"].as_u64()
    }

    async fn wait_for_native_exit(
        fixture: &NativeCodexFixture,
        boot: &Value,
        deadline: tokio::time::Instant,
    ) -> Result<(), tokio::time::error::Elapsed> {
        tokio::time::timeout_at(deadline, async {
            while native_boot_is_live(boot) || fixture.transport.is_live().await {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
    }

    #[tokio::test]
    async fn hosted_codex_start_keeps_native_thread_failure_without_adopting_or_sending() {
        let logs = tempfile::tempdir().unwrap();
        let log = logs.path().join("startup-requests.jsonl");
        let fixture = native_codex_fixture(json!({
            "appendRequestLogPath":log,
            "overrides":{"thread/start":{"error":{
                "code":-32602,"message":"fixture rejected native startup"
            }}}
        }))
        .await;
        let result = fixture.transport.start(&fixture.profile).await;
        let accepted_session = fixture.transport.provider_session_id().await;
        let native_proof = fixture.transport.native_identity_evidence().await;
        let boots = native_boots(&fixture);
        let expected_native_start_refusal = result
            .as_ref()
            .is_err_and(|error| error.starts_with("CODEX_THREAD_START_FAILED:"));
        if !expected_native_start_refusal || !log.exists() {
            let startup_errors =
                std::fs::read_to_string(fixture.dir.path().join("native-startup-errors.jsonl"))
                    .unwrap_or_else(|error| format!("<startup diagnostics unavailable: {error}>"));
            eprintln!(
                "{}",
                json!({
                    "severity": "error",
                    "event": "test.codex_native_startup_failure",
                    "result": format!("{result:?}"),
                    "boots": &boots,
                    "startupErrors": startup_errors,
                    "requestLogExists": log.exists()
                })
            );
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        let mut native_writers_reaped = true;
        for boot in &boots {
            native_writers_reaped &= wait_for_native_exit(&fixture, boot, deadline).await.is_ok();
        }
        // Finish the fixture even if the startup refusal or reaping regresses.
        fixture.transport.clone().stop().await.unwrap();
        let requests = std::fs::read_to_string(log)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        let error =
            result.expect_err("a rejected native start cannot acknowledge an owned session");
        assert!(error.starts_with("CODEX_THREAD_START_FAILED:"), "{error}");
        assert!(error.contains("fixture rejected native startup"), "{error}");
        assert!(accepted_session.is_none());
        assert!(native_proof.is_none());
        assert_eq!(
            boots.len(),
            1,
            "a refusal cannot retry into another process"
        );
        assert!(
            native_writers_reaped,
            "the failed startup must reap its own native writer"
        );
        for method in ["initialize", "thread/start"] {
            assert_eq!(
                requests
                    .iter()
                    .filter(|row| row["method"] == method)
                    .count(),
                1
            );
        }
        assert!(
            !requests.iter().any(|row| matches!(
                row["method"].as_str(),
                Some("turn/start" | "thread/resume" | "thread/fork")
            )),
            "refused creation cannot send input or adopt another conversation: {requests:?}"
        );
    }

    async fn read_native_thread(
        fixture: &NativeCodexFixture,
        original: &str,
        deadline: tokio::time::Instant,
    ) -> Value {
        let ProviderState::Codex(state) = &fixture.transport.state else {
            unreachable!()
        };
        let client = state
            .management_client_for_root(fixture.dir.path().join("codex-home").to_str().unwrap())
            .await
            .unwrap();
        tokio::time::timeout_at(deadline, client.read_thread(original, true))
            .await
            .unwrap()
            .expect("armed native must answer a real read_thread RPC")
    }

    struct NativeExitGate {
        ready: std::path::PathBuf,
        release: std::path::PathBuf,
    }

    impl NativeExitGate {
        fn new(directory: &std::path::Path) -> Self {
            Self {
                ready: directory.join("native-exit-ready"),
                release: directory.join("native-exit-release"),
            }
        }

        fn behavior(&self) -> Value {
            json!({"readyPath":self.ready,"releasePath":self.release})
        }

        async fn armed(&self, boot: &Value, deadline: tokio::time::Instant) -> Value {
            tokio::time::timeout_at(deadline, async {
                loop {
                    assert!(native_boot_is_live(boot),
                        "native process physically exited while its exit release was absent: {boot}");
                    if let Ok(bytes) = std::fs::read(&self.ready) {
                        let ready: Value = serde_json::from_slice(&bytes).unwrap();
                        assert_eq!(ready["pid"], boot["pid"]);
                        assert_eq!(ready["ownershipId"], boot["ownershipId"]);
                        assert!(!self.release.exists());
                        return ready;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            }).await.expect("native exit must arm within the existing lifecycle budget")
        }

        fn release(&self) {
            std::fs::write(&self.release, b"release").unwrap();
        }
    }

    impl Drop for NativeExitGate {
        fn drop(&mut self) {
            // Failure cleanup releases only this fixture's waiting executable.
            let _ = std::fs::write(&self.release, b"release");
        }
    }

    #[tokio::test]
    async fn task010_native_thread_start_exit_gate_holds_until_release() {
        assert_native_exit_gate(true).await;
    }

    #[tokio::test]
    async fn task010_native_turn_start_exit_gate_holds_until_release() {
        assert_native_exit_gate(false).await;
    }

    async fn assert_native_exit_gate(pending: bool) {
        let logs = tempfile::tempdir().unwrap();
        let gate = NativeExitGate::new(logs.path());
        let method = if pending {
            "thread/start"
        } else {
            "turn/start"
        };
        let fixture = native_codex_fixture(json!({"recordTurns":true,
            "exitProcessAfterMethodsOnce":[method],"processExitGate":gate.behavior()}))
        .await;
        let actor = FreshAgentHostActor::open(
            fixture.dir.path().join("physical-exit-gate-actor"),
            fixture.profile.clone(),
            fixture.transport.clone(),
        )
        .await
        .unwrap();
        let original = actor.profile().await.native_session_id.unwrap();
        if !pending {
            actor
                .dispatch(
                    RequestId::parse("gate-first-input").unwrap(),
                    "first native input".into(),
                    None,
                )
                .await
                .unwrap();
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let boots = native_boots(&fixture);
        assert_eq!(boots.len(), 1, "the real native executable boots once");
        let boot = &boots[0];
        let ready = gate.armed(boot, deadline).await;
        assert_eq!(ready["method"], method);
        assert_eq!(ready["threadId"], original);
        let native = read_native_thread(&fixture, &original, deadline).await;
        assert_eq!(native["thread"]["id"], original);
        assert_eq!(
            native["thread"]["turns"].as_array().unwrap().len(),
            usize::from(!pending)
        );
        assert!(native_boot_is_live(boot));
        assert!(fixture.transport.is_live().await);
        assert!(!gate.release.exists());
        gate.release();
        wait_for_native_exit(&fixture, boot, deadline)
            .await
            .expect("released native incarnation must physically exit");
        actor.stop().await.unwrap();
    }

    #[tokio::test]
    async fn task010_failed_resume_confirms_its_owned_tree_before_minting_again() {
        let logs = tempfile::tempdir().unwrap();
        let marker = logs.path().join("original-native-exit");
        let fixture = native_codex_fixture(json!({"recordTurns":true,
            "exitProcessAfterMethodsOnce":["turn/start"],"exitProcessAfterMethodsOnceMarkerPath":marker,
            "overrides":{"thread/resume":{"error":{"code":-32600,"message":"no rollout found for thread id old-owned-native"}}}
        })).await;
        let actor = FreshAgentHostActor::open(
            fixture.dir.path().join("owned-tree-actor"),
            fixture.profile.clone(),
            fixture.transport.clone(),
        )
        .await
        .unwrap();
        actor
            .dispatch(
                RequestId::parse("first-before-exit").unwrap(),
                "first native input".into(),
                None,
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while fixture.transport.is_live().await {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the original owned executable must exit");
        let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs")
            .canonicalize()
            .unwrap();
        let ready = logs.path().join("failed-resume-descendant.ready");
        let wrapper = fixture._exec_dir.path().join("failed-resume-tree.mjs");
        let parameters = json!({"source":source,"marker":logs.path().join("resume-sidecar-seen"),
            "ready":ready,"output":logs.path().join("failed-resume-descendant.log"),"port":logs.path().join("failed-resume-descendant.port"),"replacement":uuid::Uuid::new_v4().to_string()});
        let script = r#"#!/usr/bin/env node
import fs from 'node:fs'
import {spawn} from 'node:child_process'
const parameters=PARAMETERS
if(!fs.existsSync(parameters.marker)){
  fs.writeFileSync(parameters.marker,'first resume attempt')
  const child=spawn(process.execPath,[parameters.source,'fake-durable-writer',parameters.output,parameters.ready,parameters.port],{
    env:{...process.env,FAKE_CODEX_WRITER_IGNORE_SIGTERM:'1'},stdio:'ignore'})
  child.unref()
  const deadline=Date.now()+5000
  while(!fs.existsSync(parameters.ready)){
    if(child.exitCode!==null||Date.now()>deadline)throw Error('Owned failed-resume descendant did not become ready')
    await new Promise(resolve=>setTimeout(resolve,10))
  }
}
const behavior=JSON.parse(process.env.FAKE_CODEX_APP_SERVER_BEHAVIOR)
behavior.threadStartThreadId=parameters.replacement
process.env.FAKE_CODEX_APP_SERVER_BEHAVIOR=JSON.stringify(behavior)
await import(parameters.source)
"#.replace("PARAMETERS", &parameters.to_string());
        std::fs::write(&wrapper, script).unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        std::env::set_var("CODEX_CMD", wrapper);
        let recovery = tokio::time::timeout(
            Duration::from_secs(10),
            actor.dispatch(
                RequestId::parse("recover-after-missing-rollout").unwrap(),
                "recovery native input".into(),
                None,
            ),
        )
        .await;
        let pid = std::fs::read_to_string(&ready)
            .unwrap()
            .trim()
            .parse::<i32>()
            .unwrap();
        let surviving_start = freshell_codex::sidecar_store::proc_starttime(pid);
        actor.stop().await.unwrap();
        // This test's marked persistent descendant has no natural exit. Clean
        // only its exact captured incarnation before asserting the result.
        if let Some(start) = surviving_start {
            if freshell_codex::sidecar_store::proc_starttime(pid) == Some(start) {
                unsafe {
                    libc::kill(pid, libc::SIGKILL);
                }
            }
        }
        recovery
            .expect("owned recovery must settle")
            .expect("native recovery input must be accepted");
        assert!(surviving_start.is_none(), "the failed resume's owned descendant must be confirmed terminal before mint-new acceptance");
    }

    #[tokio::test]
    async fn task010_unknown_owned_cleanup_retains_claim_and_never_replays_input() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        let logs = tempfile::tempdir().unwrap();
        let requests = logs.path().join("native-requests.jsonl");
        let mut behavior = json!({"recordTurns":true,"appendRequestLogPath":requests,
            "exitProcessAfterMethodsOnce":["turn/start"],"exitProcessAfterMethodsOnceMarkerPath":logs.path().join("original-exit"),
            "overrides":{"thread/resume":{"error":{"code":-32600,"message":"no rollout found for thread id thread-new-1"}}}
        });
        let fixture = native_codex_fixture(behavior.clone()).await;
        let actor = FreshAgentHostActor::open(
            fixture.dir.path().join("unknown-cleanup-actor"),
            fixture.profile.clone(),
            fixture.transport.clone(),
        )
        .await
        .unwrap();
        // The original watcher already owns its local confirmation primitive.
        // Only the subsequently spawned failed-resume tree sees this outage.
        let ProviderState::Codex(state) = &fixture.transport.state else {
            unreachable!()
        };
        let available = Arc::new(AtomicBool::new(false));
        let attempts = Arc::new(AtomicUsize::new(0));
        state.set_sidecar_cleanup_probe(Arc::new({
            let available = available.clone();
            let attempts = attempts.clone();
            move |recorded| {
                let available = available.clone();
                let attempts = attempts.clone();
                Box::pin(async move {
                    attempts.fetch_add(1, Ordering::SeqCst);
                    if !available.load(Ordering::SeqCst) {
                        return Err("owned cleanup temporarily unavailable".into());
                    }
                    Ok(
                        freshell_freshagent::session_lease::kill_and_confirm_recorded_tree_dead(
                            &recorded,
                            freshell_codex::durability::CODEX_SIDECAR_OWNERSHIP_ENV,
                        )
                        .await,
                    )
                })
            }
        }));
        actor
            .dispatch(
                RequestId::parse("original-input").unwrap(),
                "original accepted input".into(),
                None,
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while fixture.transport.is_live().await {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        behavior["threadStartThreadId"] = json!(uuid::Uuid::new_v4().to_string());
        std::env::set_var("FAKE_CODEX_APP_SERVER_BEHAVIOR", behavior.to_string());
        let refused = tokio::time::timeout(
            Duration::from_secs(5),
            actor.dispatch(
                RequestId::parse("cleanup-refused-input").unwrap(),
                "must never be replayed".into(),
                None,
            ),
        )
        .await
        .unwrap();
        assert!(
            refused.is_err(),
            "unconfirmed cleanup must refuse recovery: {refused:?}"
        );
        assert!(attempts.load(Ordering::SeqCst) > 0);
        assert!(
            state
                .leases()
                .peek_kill_handle("codex", "thread-new-1")
                .is_some(),
            "the failed resume must retain its exact owned claim"
        );
        let read_requests = || {
            std::fs::read_to_string(&requests)
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str::<Value>(line).unwrap())
                .collect::<Vec<_>>()
        };
        let before = read_requests();
        assert_eq!(
            before
                .iter()
                .filter(|row| row["method"] == "thread/start")
                .count(),
            1,
            "unknown cleanup must not mint a replacement"
        );
        assert_eq!(
            before
                .iter()
                .filter(|row| row["method"] == "turn/start")
                .count(),
            1,
            "refused input must never reach native work"
        );
        available.store(true, Ordering::SeqCst);
        tokio::time::timeout(Duration::from_secs(5), async {
            while state
                .leases()
                .peek_kill_handle("codex", "thread-new-1")
                .is_some()
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("only positive exact-owned confirmation may release the claim");
        actor
            .dispatch(
                RequestId::parse("new-explicit-recovery-input").unwrap(),
                "new explicit input after confirmation".into(),
                None,
            )
            .await
            .unwrap();
        actor.stop().await.unwrap();
        let after = read_requests();
        assert_eq!(
            after
                .iter()
                .filter(|row| row["method"] == "thread/start")
                .count(),
            2
        );
        let turns = after
            .iter()
            .filter(|row| row["method"] == "turn/start")
            .collect::<Vec<_>>();
        assert_eq!(
            turns.len(),
            2,
            "only original and new explicit inputs may be dispatched"
        );
        assert!(!turns
            .iter()
            .any(|row| row.to_string().contains("must never be replayed")));
        assert!(turns[1]
            .to_string()
            .contains("new explicit input after confirmation"));
    }

    struct NativeCodexCleanupReadiness {
        available: Arc<std::sync::atomic::AtomicBool>,
        original: Arc<std::sync::Mutex<Option<CondemnedRuntimeIdentity>>>,
        capture: oneshot::Receiver<(String, CondemnedRuntimeIdentity)>,
        callbacks: Arc<std::sync::Mutex<Vec<Value>>>,
        ready: watch::Receiver<Option<CondemnedRuntimeIdentity>>,
    }

    fn native_cleanup_evidence(recorded: &CondemnedRuntimeIdentity) -> Value {
        serde_json::to_value(recorded).unwrap()
    }

    impl NativeCodexCleanupReadiness {
        fn withheld(fixture: &NativeCodexFixture, pending: bool) -> Self {
            use std::sync::atomic::{AtomicBool, Ordering};
            let ProviderState::Codex(state) = &fixture.transport.state else {
                unreachable!()
            };
            let available = Arc::new(AtomicBool::new(false));
            let original = Arc::new(std::sync::Mutex::new(None::<CondemnedRuntimeIdentity>));
            let callbacks = Arc::new(std::sync::Mutex::new(Vec::new()));
            let (capture_tx, capture) = oneshot::channel();
            let capture_tx = std::sync::Mutex::new(Some(capture_tx));
            state.set_sidecar_capture_observer_for_tests(Arc::new(move |thread_id, recorded| {
                if let Some(sender) = capture_tx.lock().unwrap().take() {
                    let _ = sender.send((thread_id.to_owned(), recorded.clone()));
                }
            }));
            let (ready_tx, ready) = watch::channel(None);
            state.set_sidecar_cleanup_probe(Arc::new({
                let available = available.clone();
                let original = original.clone();
                let callbacks = callbacks.clone();
                move |recorded| {
                    let available = available.clone();
                    let original = original.clone();
                    let callbacks = callbacks.clone();
                    let ready_tx = ready_tx.clone();
                    Box::pin(async move {
                        callbacks
                            .lock()
                            .unwrap()
                            .push(native_cleanup_evidence(&recorded));
                        let is_original = {
                            let first = original.lock().expect("original owned identity");
                            let same = first.as_ref().is_some_and(|first| {
                                native_cleanup_evidence(first) == native_cleanup_evidence(&recorded)
                            });
                            if first
                                .as_ref()
                                .is_some_and(|first| first.ownership_id == recorded.ownership_id)
                                && !same
                            {
                                return Err("the original watcher record changed".into());
                            }
                            same
                        };
                        let withheld = !available.load(Ordering::SeqCst);
                        let confirmed = if withheld {
                            false
                        } else {
                            freshell_freshagent::session_lease::kill_and_confirm_recorded_tree_dead(
                                &recorded,
                                freshell_codex::durability::CODEX_SIDECAR_OWNERSHIP_ENV,
                            )
                            .await
                        };
                        eprintln!(
                            "{}",
                            json!({"event":"freshcodex.test.owned_cleanup_probe",
                            "severity":if confirmed {"info"} else {"warn"}, "pending":pending,
                            "identity":native_cleanup_evidence(&recorded),
                            "isOriginal":is_original,"withheld":withheld,"confirmed":confirmed})
                        );
                        if confirmed && is_original {
                            ready_tx.send_replace(Some(recorded));
                        }
                        if withheld {
                            Err("controlled original teardown proof unavailable".into())
                        } else {
                            Ok(confirmed)
                        }
                    })
                }
            }));
            Self {
                available,
                original,
                capture,
                callbacks,
                ready,
            }
        }

        async fn observe_original(
            &mut self,
            session_id: &str,
            boot: &Value,
            require_complete: bool,
            deadline: tokio::time::Instant,
        ) -> CondemnedRuntimeIdentity {
            // Receive once, never filter or recapture an incomplete original.
            let (thread_id, recorded) = tokio::time::timeout_at(deadline, &mut self.capture)
                .await
                .unwrap()
                .expect("exact watcher capture notification");
            assert_eq!(thread_id, session_id);
            assert_eq!(json!(recorded.pid), boot["pid"]);
            assert_eq!(json!(recorded.ownership_id), boot["ownershipId"]);
            if let Some(start) = recorded.start_time {
                assert_eq!(json!(start), boot["startTime"]);
            }
            if require_complete {
                assert!(
                    recorded.capture_complete,
                    "first original capture must be complete before exit release: {}",
                    native_cleanup_evidence(&recorded)
                );
                let start = recorded.start_time.expect("live original start time");
                assert!(recorded.tree.contains(&(recorded.pid as i32, start)));
                assert!(native_boot_is_live(boot));
            }
            let mut original = self.original.lock().unwrap();
            assert!(original.is_none());
            *original = Some(recorded.clone());
            recorded
        }

        fn evidence(&self) -> Value {
            let original = self.original.lock().expect("original owned identity");
            json!({"original":original.as_ref().map(native_cleanup_evidence),
                "callbacks":*self.callbacks.lock().unwrap(),
                "confirmed":self.ready.borrow().as_ref().map(native_cleanup_evidence)})
        }

        async fn assert_original_remains_unconfirmed(
            &self,
            state: &FreshCodexState,
            session_id: &str,
            deadline: tokio::time::Instant,
        ) {
            let before = self.callbacks.lock().unwrap().len();
            assert!(!tokio::time::timeout_at(
                deadline,
                state.confirm_fenced_prior_dead(session_id)
            )
            .await
            .unwrap());
            let callbacks = self.callbacks.lock().unwrap();
            assert!(
                callbacks.len() > before,
                "false must come from actual original cleanup, not a missing prior"
            );
            let original = self.original.lock().unwrap();
            let original = native_cleanup_evidence(original.as_ref().unwrap());
            assert!(callbacks[before..]
                .iter()
                .all(|recorded| *recorded == original));
            eprintln!(
                "{}",
                json!({"event":"freshcodex.test.original_remains_unconfirmed",
                "severity":"info","identity":original,"callbackDelta":callbacks.len()-before})
            );
        }

        async fn allow_and_wait(
            &mut self,
            state: &FreshCodexState,
            session_id: &str,
            pending: bool,
            deadline: tokio::time::Instant,
        ) {
            self.available
                .store(true, std::sync::atomic::Ordering::SeqCst);
            // This existing lifecycle operation clears ownership only after
            // actual confirmation. It never starts native work or replays input.
            let readiness = tokio::time::timeout_at(deadline, async {
                let confirmed = state.confirm_fenced_prior_dead(session_id).await;
                eprintln!(
                    "{}",
                    json!({"event":"freshcodex.test.cleanup_readiness",
                    "severity":"info","pending":pending,"confirmReturned":confirmed,
                    "evidence":self.evidence()})
                );
                // A detached confirmer may have already completed the same
                // record, so the exact original proof is the readiness oracle.
                loop {
                    if self.ready.borrow().is_some() {
                        return;
                    }
                    self.ready
                        .changed()
                        .await
                        .expect("owned cleanup proof stream");
                }
            })
            .await;
            assert!(
                readiness.is_ok(),
                "positive exact-owned readiness required; pending={pending}; evidence={}",
                self.evidence()
            );
        }
    }

    #[tokio::test]
    async fn task010_native_mint_ack_updates_actor_before_snapshot_and_second_send() {
        for pending in [false, true] {
            assert_native_mint_ack(pending).await;
        }
    }

    #[tokio::test]
    async fn task010_ungated_initial_native_exit_retains_claim_and_never_replays_input() {
        let logs = tempfile::tempdir().unwrap();
        let requests = logs.path().join("ungated-requests.jsonl");
        let original = uuid::Uuid::new_v4().to_string();
        // Deliberately no exit gate: this is the genuine initial-capture race.
        let fixture = native_codex_fixture(json!({"threadStartThreadId":original,
            "recordTurns":true,"appendRequestLogPath":requests,
            "exitProcessAfterMethodsOnce":["thread/start"]}))
        .await;
        let mut cleanup = NativeCodexCleanupReadiness::withheld(&fixture, true);
        let mut profile = fixture.profile.clone();
        profile.naming_handle = Some("pending-ungated-recovery".into());
        let actor = FreshAgentHostActor::open(
            fixture.dir.path().join("ungated-actor"),
            profile,
            fixture.transport.clone(),
        )
        .await
        .unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let before = actor.profile().await;
        assert_eq!(before.native_session_id.as_deref(), Some(original.as_str()));
        let boots = native_boots(&fixture);
        assert_eq!(boots.len(), 1);
        let boot = &boots[0];
        let captured = cleanup
            .observe_original(&original, boot, false, deadline)
            .await;
        wait_for_native_exit(&fixture, boot, deadline)
            .await
            .expect("ungated original incarnation must physically exit");
        let ProviderState::Codex(state) = &fixture.transport.state else {
            unreachable!()
        };
        // Fresh create has no in-flight resume/watchdog lease. Its actual
        // unconfirmed ownership is the exact condemned record, not a new lease.
        let initial_handle = state.leases().peek_kill_handle("codex", &original);
        assert!(initial_handle.is_none());
        cleanup
            .assert_original_remains_unconfirmed(state, &original, deadline)
            .await;
        let refused = tokio::time::timeout_at(
            deadline,
            actor.dispatch(
                RequestId::parse("ungated-explicit-refused-input").unwrap(),
                "ungated input must never reach native work".into(),
                None,
            ),
        )
        .await
        .unwrap();
        assert!(
            matches!(refused,
            Err(freshell_agent_runtime::host_actor::ActorError::Transport(ref message))
                if message.starts_with("SESSION_RESERVED:")),
            "{refused:?}"
        );
        assert_eq!(actor.profile().await, before);
        assert_eq!(
            state.leases().peek_kill_handle("codex", &original),
            initial_handle
        );
        cleanup
            .assert_original_remains_unconfirmed(state, &original, deadline)
            .await;
        assert!(!cleanup.available.load(std::sync::atomic::Ordering::SeqCst));
        assert!(cleanup.ready.borrow().is_none());
        let callbacks = cleanup.callbacks.lock().unwrap().clone();
        assert!(
            !callbacks.is_empty(),
            "the unavailable original proof must actually run"
        );
        assert!(callbacks
            .iter()
            .all(|recorded| *recorded == native_cleanup_evidence(&captured)));
        assert_eq!(
            native_boots(&fixture),
            boots,
            "refusal must not boot a replacement executable"
        );
        let rows = std::fs::read_to_string(&requests).unwrap();
        let requests = rows
            .lines()
            .map(|row| serde_json::from_str::<Value>(row).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            requests
                .iter()
                .filter(|row| row["method"] == "thread/start")
                .count(),
            1
        );
        assert!(!requests
            .iter()
            .any(|row| row["method"] == "thread/resume" || row["method"] == "turn/start"));
        assert!(!rows.contains("ungated input must never reach native work"));
        assert!(!fixture.dir.path().join("codex-home/sessions").exists());
        assert!(!fixture.dir.path().join("codex-home/fake-turns").exists());
        eprintln!(
            "{}",
            json!({"event":"freshcodex.test.ungated_initial_exit_refused",
            "severity":"info","identity":native_cleanup_evidence(&captured),
            "boot":boot,"physicalExit":true,"nativeBoots":boots.len(),"nativeTurns":0})
        );
        actor.stop().await.unwrap();
    }

    async fn assert_native_mint_ack(pending: bool) {
        eprintln!(
            "{}",
            json!({"event":"freshcodex.test.native_mint_ack_case",
            "severity":"info","pending":pending,"phase":"start"})
        );
        let logs = tempfile::tempdir().unwrap();
        let gate = NativeExitGate::new(logs.path());
        let log = logs.path().join("recovery-requests.jsonl");
        let original_id = uuid::Uuid::new_v4().to_string();
        let replacement_id = uuid::Uuid::new_v4().to_string();
        let behavior = json!({
            "threadStartThreadId":original_id,"recordTurns":true,"echoRequestedModel":true,"appendRequestLogPath":log,
            "exitProcessAfterMethodsOnce":[if pending {"thread/start"} else {"turn/start"}],
            "processExitGate":gate.behavior(),
            "exitProcessAfterMethodsOnceMarkerPath":logs.path().join("first-native-exit"),
            "overrides":{"thread/resume":{"error":{"code":-32600,"message":"no rollout found for thread id original-native"}}}
        });
        let fixture = native_codex_fixture(behavior.clone()).await;
        let mut cleanup = NativeCodexCleanupReadiness::withheld(&fixture, pending);
        let qualified_behavior = |id: &str| {
            let mut behavior = behavior.clone();
            behavior["threadStartThreadId"] = json!(id);
            behavior["writeRolloutOnMethods"] = json!({"turn/start": {
                "path": fixture.dir.path().join("codex-home/sessions").join(format!("rollout-{id}.jsonl")),
                "record": {"type":"session_meta","payload":{"id":id,"cwd":fixture.profile.cwd}}
            }});
            behavior
        };
        // Qualified 0.164 writes the exact initial header before completion.
        // Use the existing owned opt-in; shared fake defaults stay unchanged.
        std::env::set_var(
            "FAKE_CODEX_APP_SERVER_BEHAVIOR",
            qualified_behavior(&original_id).to_string(),
        );
        let mut profile = fixture.profile.clone();
        profile.naming_handle = pending.then(|| "pending-initial-recovery".into());
        profile.effort = Some("xhigh".into());
        profile.collaboration_mode = Some("plan".into());
        profile.sandbox = Some("read-only".into());
        let actor = FreshAgentHostActor::open(
            fixture.dir.path().join("recovery-actor"),
            profile.clone(),
            fixture.transport.clone(),
        )
        .await
        .unwrap();
        let original = actor.profile().await.native_session_id.unwrap();
        assert_eq!(original, original_id);
        if !pending {
            actor
                .dispatch(
                    RequestId::parse("before-native-exit").unwrap(),
                    "first native input".into(),
                    None,
                )
                .await
                .unwrap();
        }
        // Keep the original five-second lifecycle budget for both exit
        // and readiness; no accepted recovery dispatch is retried.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let boots = native_boots(&fixture);
        assert_eq!(boots.len(), 1);
        let boot = &boots[0];
        let captured = cleanup
            .observe_original(&original, boot, true, deadline)
            .await;
        let armed = gate.armed(boot, deadline).await;
        assert_eq!(armed["threadId"], original);
        let ProviderState::Codex(state) = &fixture.transport.state else {
            unreachable!()
        };
        let native = read_native_thread(&fixture, &original, deadline).await;
        let turns = native["thread"]["turns"].as_array().unwrap();
        let configured_rollout = fixture
            .dir
            .path()
            .join("codex-home/sessions")
            .join(format!("rollout-{original}.jsonl"));
        let prospective_rollout = std::path::Path::new(native["thread"]["path"].as_str().unwrap());
        let turn_store = fixture
            .dir
            .path()
            .join("codex-home/fake-turns")
            .join(format!("{original}.json"));
        let before_exit = std::fs::read_to_string(&log).unwrap();
        let rows = before_exit
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            rows.iter()
                .filter(|row| row["method"] == "thread/start")
                .count(),
            1
        );
        assert_eq!(
            rows.iter()
                .filter(|row| row["method"] == "turn/start")
                .count(),
            usize::from(!pending)
        );
        assert_eq!(turns.len(), usize::from(!pending));
        assert_eq!(actor.profile().await.naming_handle, profile.naming_handle);
        if pending {
            assert!(!configured_rollout.exists());
            assert!(!prospective_rollout.exists());
            assert!(!turn_store.exists());
            let retained = state.retained_state(&original).await.unwrap();
            assert_eq!(retained["snapshot"]["threadId"], original);
            assert!(
                retained["snapshot"]["extensions"]["codex"]["hostedNamingFacts"]
                    .as_array()
                    .is_none_or(|facts| !facts
                        .iter()
                        .any(|fact| fact["kind"] == "acquisition" || fact["kind"] == "transition"))
            );
        } else {
            assert!(configured_rollout.exists());
            assert!(prospective_rollout.exists());
            let persisted: Value =
                serde_json::from_slice(&std::fs::read(&turn_store).unwrap()).unwrap();
            assert_eq!(persisted.as_array().unwrap().len(), 1);
            assert!(persisted.to_string().contains("first native input"));
        }
        assert!(native_boot_is_live(boot));
        assert!(!gate.release.exists());
        eprintln!(
            "{}",
            json!({"event":"freshcodex.test.original_before_exit_release",
            "severity":"info","pending":pending,"identity":native_cleanup_evidence(&captured),
            "nativeTurns":turns.len(),"configuredHeader":configured_rollout.exists(),
            "prospectiveHeader":prospective_rollout.exists(),"turnStore":turn_store.exists()})
        );
        gate.release();
        let exited = wait_for_native_exit(&fixture, boot, deadline).await;
        eprintln!(
            "{}",
            json!({"event":"freshcodex.test.native_exit",
            "severity":"info","pending":pending,"exited":exited.is_ok(),
            "evidence":cleanup.evidence()})
        );
        assert!(
            exited.is_ok(),
            "the owned native executable must actually exit; pending={pending}"
        );

        let refused = tokio::time::timeout_at(
            deadline,
            actor.dispatch(
                RequestId::parse("before-cleanup-proof").unwrap(),
                "unconfirmed cleanup must not reach native work".into(),
                None,
            ),
        )
        .await;
        eprintln!(
            "{}",
            json!({"event":"freshcodex.test.recovery_before_proof",
            "severity":"info","pending":pending,"result":format!("{refused:?}"),
            "evidence":cleanup.evidence()})
        );
        assert!(
            matches!(refused,
            Ok(Err(freshell_agent_runtime::host_actor::ActorError::Transport(ref message)))
                if message.starts_with("SESSION_RESERVED:")),
            "unconfirmed teardown must refuse; pending={pending}; result={refused:?}"
        );
        let before_proof = std::fs::read_to_string(&log).unwrap();
        let rows = before_proof
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            rows.iter()
                .filter(|row| row["method"] == "thread/start")
                .count(),
            1,
            "no replacement writer before proof; pending={pending}"
        );
        assert_eq!(
            rows.iter()
                .filter(|row| row["method"] == "turn/start")
                .count(),
            usize::from(!pending),
            "refused input must not reach native work; pending={pending}"
        );
        assert!(!before_proof.contains("unconfirmed cleanup must not reach native work"));
        let ProviderState::Codex(state) = &fixture.transport.state else {
            unreachable!()
        };
        eprintln!(
            "{}",
            json!({"event":"freshcodex.test.pre_proof_guards_passed",
            "severity":"info","pending":pending,"noReplacementWriter":true,"noReplay":true,
            "nativeRequests":rows.iter().map(|row|json!({"method":row["method"],
                "threadId":row["params"]["threadId"]})).collect::<Vec<_>>(),
            "evidence":cleanup.evidence()})
        );
        cleanup
            .allow_and_wait(state, &original, pending, deadline)
            .await;
        std::env::set_var(
            "FAKE_CODEX_APP_SERVER_BEHAVIOR",
            qualified_behavior(&replacement_id).to_string(),
        );
        let recovery = actor
            .dispatch(
                RequestId::parse("recover-native").unwrap(),
                "recover native input".into(),
                None,
            )
            .await;
        eprintln!(
            "{}",
            json!({"event":"freshcodex.test.recovery_after_proof",
            "severity":"info","pending":pending,"result":format!("{recovery:?}"),
            "evidence":cleanup.evidence()})
        );
        recovery.unwrap();
        let recovered = actor.profile().await;
        let native = recovered.native_session_id.clone().unwrap();
        assert_ne!(native, original,"the typed successful mint-new result must update durable actor identity before dispatch returns");
        assert_eq!(recovered.naming_handle, profile.naming_handle);
        assert_eq!(recovered.model, profile.model);
        assert_eq!(recovered.effort, profile.effort);
        assert_eq!(recovered.collaboration_mode, profile.collaboration_mode);
        assert_eq!(recovered.sandbox, profile.sandbox);
        assert!(actor
            .observe_native_identity("arbitrary-started".into())
            .await
            .is_err());
        assert!(actor
            .observe_native_identity(original.clone())
            .await
            .is_err());
        assert!(actor.read_events(0, 256).await.events.iter().all(|entry| !matches!(&entry.event,AgentEvent::Started{native_session_id} if native_session_id != &native)),"historical Started must not re-key durable inventory after a trusted command transition");
        assert_eq!(fixture.transport.current_native_id().await.unwrap(), native);
        let proof = actor.observed_native_identity_evidence().await.unwrap();
        assert_eq!(proof["nativeSessionId"], native);
        assert_eq!(proof["providerEvidence"]["source"], "native_turn_start_ack");
        assert_eq!(proof["providerEvidence"]["requestId"], "recover-native");
        let snapshot = actor.snapshot().await.unwrap();
        assert_eq!(snapshot["threadId"], native);
        actor
            .dispatch(
                RequestId::parse("second-current-native").unwrap(),
                "second current native input".into(),
                None,
            )
            .await
            .unwrap();
        assert_eq!(
            actor.profile().await.native_session_id.as_deref(),
            Some(native.as_str())
        );
        assert_eq!(actor.snapshot().await.unwrap()["threadId"], native);
        let naming_snapshot = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let snapshot = actor.snapshot().await.unwrap();
                let has_proof = snapshot["extensions"]["codex"]["hostedNamingFacts"]
                    .as_array()
                    .is_some_and(|facts| {
                        facts.iter().any(|fact| {
                            fact["kind"] == if pending { "transition" } else { "acquisition" }
                        })
                    });
                if snapshot["status"] == "idle" && has_proof {
                    break snapshot;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        let naming_snapshot = match naming_snapshot {
            Ok(snapshot) => snapshot,
            Err(_) => actor.snapshot().await.unwrap(),
        };
        actor.stop().await.unwrap();
        assert_eq!(
            naming_snapshot["status"], "idle",
            "recovered native turn must actually settle"
        );
        let fact = naming_snapshot["extensions"]["codex"]["hostedNamingFacts"]
            .as_array()
            .and_then(|facts| {
                facts
                    .iter()
                    .find(|fact| fact["kind"] == if pending { "transition" } else { "acquisition" })
            })
            .expect("the verified recovered native source must retain its naming acquisition");
        assert_eq!(fact["data"]["target"]["sessionId"], native);
        let acquisition = if pending {
            assert_eq!(
                fact["data"]["transition"]["reason"],
                "InitialMaterialization"
            );
            assert_eq!(
                fact["data"]["transition"]["pending"],
                "pending-initial-recovery"
            );
            &fact["data"]["transition"]["acquisition"]
        } else {
            &fact["data"]["acquisition"]
        };
        assert_eq!(acquisition["persistence"], "verified");
        assert_eq!(acquisition["location"]["nativeThreadId"], native);
        let rows = std::fs::read_to_string(log)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            rows.iter()
                .filter(|row| row["method"] == "thread/start")
                .count(),
            2,
            "only the initial thread and explicit native missing-history fallback may create"
        );
        let resume = rows
            .iter()
            .position(|row| {
                row["method"] == "thread/resume" && row["params"]["threadId"] == original
            })
            .expect("old native id must actually attempt resume");
        let replacement = rows
            .iter()
            .rposition(|row| row["method"] == "thread/start")
            .unwrap();
        assert!(
            resume < replacement,
            "native missing-history refusal must precede mint-new"
        );
        let starts = rows
            .iter()
            .filter(|row| row["method"] == "turn/start")
            .collect::<Vec<_>>();
        assert_eq!(
            starts.len(),
            if pending { 2 } else { 3 },
            "no accepted input may be replayed"
        );
        assert!(
            !starts.iter().any(|row| row
                .to_string()
                .contains("unconfirmed cleanup must not reach native work")),
            "refused input must never be replayed after proof; pending={pending}"
        );
        if !pending {
            assert_eq!(starts[0]["params"]["threadId"], original);
        }
        for row in &starts[usize::from(!pending)..] {
            assert_eq!(row["params"]["threadId"], native);
            assert_eq!(row["params"]["effort"], "xhigh");
            assert_eq!(row["params"]["collaborationMode"]["mode"], "plan");
            assert_eq!(row["params"]["sandboxPolicy"]["type"], "readOnly");
        }
    }

    /// Observer-boundary qualification, separate from public creation: the
    /// release CLI's explicitly ephemeral parent/child contract is receipt16.
    /// No application start parameter or native ephemerality is rewritten here.
    #[tokio::test]
    async fn task010_hosted_ephemeral_child_is_finite_and_never_becomes_a_writer() {
        let log = tempfile::NamedTempFile::new().unwrap();
        let parent = json!({"id":"thread-new-1","ephemeral":true,"status":{"type":"active"},"turns":[{"id":"registered-child-turn","status":"inProgress","items":[{"id":"spawn","type":"collabAgentToolCall","tool":"spawnAgent","status":"completed","senderThreadId":"thread-new-1","receiverThreadIds":["ephemeral-child"],"agentsStates":{}}]}]});
        let child = json!({"id":"ephemeral-child","parentThreadId":"thread-new-1","ephemeral":true,"status":{"type":"active"},"turns":[]});
        let fixture = native_codex_fixture(json!({"appendRequestLogPath":log.path(),"threadTurns":parent["turns"],"threadReadResults":{"thread-new-1":parent,"ephemeral-child":child}})).await;
        let actor = FreshAgentHostActor::open(
            fixture.dir.path().join("ephemeral-observer-actor"),
            fixture.profile.clone(),
            fixture.transport.clone(),
        )
        .await
        .unwrap();
        let profile = actor.profile().await;
        let before = std::fs::read_to_string(log.path()).unwrap();
        assert!(actor.read_child("unregistered-child").await.is_err());
        for _ in 0..2 {
            let value = actor.read_child("ephemeral-child").await.unwrap();
            assert_eq!(
                value,
                json!({"parentThreadId":"thread-new-1","childThreadId":"ephemeral-child","status":"unavailable","reason":"ephemeral_history_unavailable","retryable":false})
            );
        }
        assert_eq!(actor.profile().await, profile);
        let after = std::fs::read_to_string(log.path()).unwrap();
        let rows: Vec<Value> = after
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let baseline: Vec<Value> = before
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(
            rows.iter()
                .filter(|row| row["method"] == "thread/start")
                .count(),
            baseline
                .iter()
                .filter(|row| row["method"] == "thread/start")
                .count()
        );
        assert_eq!(
            rows.iter()
                .filter(|row| row["params"]["threadId"] == "ephemeral-child")
                .count(),
            2
        );
        assert!(rows
            .iter()
            .filter(|row| row["params"]["threadId"] == "ephemeral-child")
            .all(|row| row["method"] == "thread/read" && row["params"]["includeTurns"] == true));
        assert!(!rows
            .iter()
            .any(|row| row["params"]["threadId"] == "unregistered-child"));
        // A final native read still reports true; observation did not persist,
        // resume, configure, send to, stop or relabel the child.
        let ProviderState::Codex(state) = &fixture.transport.state else {
            panic!("Codex fixture")
        };
        let native = state
            .management_client_for_root(&fixture.dir.path().join("codex-home").to_string_lossy())
            .await
            .unwrap()
            .read_thread_metadata("ephemeral-child")
            .await
            .unwrap();
        assert_eq!(native["thread"]["ephemeral"], true);
        assert_eq!(native["thread"]["parentThreadId"], "thread-new-1");
        actor.stop().await.unwrap();
    }

    #[tokio::test]
    async fn task010_codex_native_name_uses_only_current_root_matched_metadata_methods() {
        let log = tempfile::NamedTempFile::new().unwrap();
        let fixture = native_codex_fixture(json!({"recordTurns":true,"appendRequestLogPath":log.path(),
            "overrides":{"thread/read":{"result":{"thread":{"id":"thread-new-1","name":"Native saved title"}}},"thread/name/set":{"result":{}}}})).await;
        let actor = FreshAgentHostActor::open(
            fixture.dir.path().join("name-actor"),
            fixture.profile.clone(),
            fixture.transport.clone(),
        )
        .await
        .unwrap();
        let home = fixture
            .dir
            .path()
            .join("codex-home")
            .to_string_lossy()
            .into_owned();
        let requests = || {
            std::fs::read_to_string(log.path())
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str::<Value>(line).unwrap())
                .collect::<Vec<_>>()
        };
        let before = requests().len();
        for (native, root) in [
            ("foreign-thread", home.as_str()),
            ("thread-new-1", "/wrong/root"),
        ] {
            assert!(matches!(
                actor
                    .native_name(
                        native,
                        root,
                        &FreshAgentNativeNameOperation::Write {
                            title: "Must not apply".into()
                        }
                    )
                    .await,
                FreshAgentNativeNameReply::Failed(FreshAgentNativeNameError::Unavailable { .. })
            ));
        }
        assert_eq!(
            requests().len(),
            before,
            "stale targets perform no native work"
        );
        assert_eq!(
            actor
                .native_name("thread-new-1", &home, &FreshAgentNativeNameOperation::Probe)
                .await,
            FreshAgentNativeNameReply::Available
        );
        assert_eq!(
            requests().len(),
            before,
            "capability probing is read-only and sends no native RPC"
        );
        assert_eq!(
            actor
                .native_name("thread-new-1", &home, &FreshAgentNativeNameOperation::Read)
                .await,
            FreshAgentNativeNameReply::Title(Some("Native saved title".into()))
        );
        assert_eq!(
            actor
                .native_name(
                    "thread-new-1",
                    &home,
                    &FreshAgentNativeNameOperation::Write {
                        title: "Manual title".into()
                    }
                )
                .await,
            FreshAgentNativeNameReply::Renamed
        );
        let after = requests();
        assert_eq!(
            after[before..]
                .iter()
                .map(|row| row["method"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["thread/read", "thread/name/set"]
        );
        assert_eq!(
            after[before]["params"],
            json!({"threadId":"thread-new-1","includeTurns":false})
        );
        assert_eq!(
            after[before + 1]["params"],
            json!({"threadId":"thread-new-1","name":"Manual title"})
        );
        actor.stop().await.unwrap();
    }

    #[tokio::test]
    async fn task010_codex_verified_naming_survives_event_replay_in_retained_source() {
        let mut fixture = native_codex_fixture(json!({"recordTurns":true})).await;
        let native_id = uuid::Uuid::new_v4().to_string();
        let rollout = fixture
            .dir
            .path()
            .join("codex-home/sessions")
            .join(format!("rollout-{native_id}.jsonl"));
        std::env::set_var("FAKE_CODEX_APP_SERVER_BEHAVIOR", json!({"recordTurns":true,"echoRequestedModel":true,
            "threadStartThreadId":native_id,"writeRolloutOnMethods":{"turn/start":{"path":rollout,
                "record":{"type":"session_meta","payload":{"id":native_id,"cwd":fixture.profile.cwd}}}}
        }).to_string());
        fixture.profile.naming_handle = Some("managed-native-name".into());
        let actor = FreshAgentHostActor::open(
            fixture.dir.path().join("naming-actor"),
            fixture.profile.clone(),
            fixture.transport.clone(),
        )
        .await
        .unwrap();
        let observed = tokio::time::timeout(Duration::from_secs(10), async {
            actor
                .dispatch(
                    RequestId::parse("managed-naming-first").unwrap(),
                    "Name the managed conversation".into(),
                    None,
                )
                .await
                .unwrap();
            loop {
                let snapshot = actor.snapshot().await.unwrap();
                let facts = &snapshot["extensions"]["codex"]["hostedNamingFacts"];
                if snapshot["status"] == "idle"
                    && facts
                        .as_array()
                        .is_some_and(|facts| facts.iter().any(|fact| fact["kind"] == "transition"))
                {
                    break (snapshot, actor.read_events(0, 256).await);
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        actor.stop().await.unwrap();
        let (snapshot, events) =
            observed.expect("verified naming must remain available without another provider token");
        let facts = snapshot["extensions"]["codex"]["hostedNamingFacts"]
            .as_array()
            .unwrap();
        assert_eq!(facts.len(), 2);
        let activity = facts
            .iter()
            .find(|fact| fact["kind"] == "activity")
            .unwrap();
        assert_eq!(
            activity["data"]["target"],
            json!({"kind":"pending","id":"managed-native-name"})
        );
        assert_eq!(
            activity["data"]["first_user_message"],
            "Name the managed conversation"
        );
        let transition = facts
            .iter()
            .find(|fact| fact["kind"] == "transition")
            .unwrap();
        assert_eq!(
            transition["data"]["target"],
            json!({"kind":"session","provider":"codex","sessionId":native_id})
        );
        assert_eq!(
            transition["data"]["transition"]["acquisition"]["persistence"],
            "verified"
        );
        assert_eq!(
            transition["data"]["transition"]["pending"],
            "managed-native-name"
        );
        assert!(events.events.iter().any(|entry| matches!(&entry.event,AgentEvent::Provider {payload} if payload["event"]["type"] == freshell_freshagent::naming::HOSTED_CODEX_NAMING_EVENT)));
    }

    #[tokio::test]
    async fn task008_settings_native_echo_survives_managed_next_send_and_reopen() {
        let logs = tempfile::tempdir().unwrap();
        let log = logs.path().join("native-effective.jsonl");
        let native_cwd = logs.path().join("native-cwd");
        std::fs::create_dir(&native_cwd).unwrap();
        let mut fixture = native_codex_fixture(json!({
            "appendRequestLogPath":log, "recordTurns":true,
            "effectiveThreadSettings":{"model":"provider-current","reasoningEffort":"low",
                "cwd":native_cwd,"sandbox":{"type":"readOnly"},"approvalPolicy":"on-request"}
        }))
        .await;
        fixture.profile.effort = Some("ultra".into());
        fixture.profile.collaboration_mode = Some("plan".into());
        let state_dir = fixture.dir.path().join("native-effective-actor");
        let actor = FreshAgentHostActor::open(
            &state_dir,
            fixture.profile.clone(),
            fixture.transport.clone(),
        )
        .await
        .unwrap();
        let startup = actor.snapshot().await.unwrap();
        actor
            .dispatch(
                RequestId::parse("native-effective-first").unwrap(),
                "native effective first send".into(),
                None,
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            while actor.snapshot().await.unwrap()["status"] != "idle" {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let profile = actor.profile().await;
        actor.stop().await.unwrap();
        let resumed = FreshAgentHostActor::open(
            &state_dir,
            profile,
            HostedTransport::new(FreshProvider::Codex).await,
        )
        .await
        .unwrap();
        resumed
            .dispatch(
                RequestId::parse("native-effective-resumed").unwrap(),
                "native effective resumed send".into(),
                None,
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            while resumed.snapshot().await.unwrap()["status"] != "idle" {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        // An explicit per-send choice still wins even when it equals the old
        // launch intent: equality of profiles is not absence of a request.
        resumed.dispatch(RequestId::parse("native-effective-explicit").unwrap(), "explicit old selection".into(), Some(serde_json::from_value(json!({
            "model":fixture.profile.model,"cwd":fixture.profile.cwd,"sandbox":"workspace-write","permissionMode":"never"
        })).unwrap())).await.unwrap();
        resumed.stop().await.unwrap();
        let requests: Vec<Value> = std::fs::read_to_string(log)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let starts: Vec<_> = requests
            .iter()
            .filter(|row| row["method"] == "turn/start")
            .map(|row| &row["params"])
            .collect();
        assert_eq!(
            startup["settings"]["model"], "provider-current",
            "the owning provider already exposes its native-effective settings"
        );
        assert_eq!(starts.len(), 3);
        assert_eq!(starts[2]["model"], fixture.profile.model.unwrap());
        assert_eq!(starts[2]["cwd"], fixture.profile.cwd);
        assert_eq!(starts[2]["sandboxPolicy"]["type"], "workspaceWrite");
        assert_eq!(starts[2]["approvalPolicy"], "never");
        assert_eq!(starts[..2].iter().map(|params| json!({"model":params["model"],"cwd":params["cwd"],"sandbox":params["sandboxPolicy"]["type"],"approval":params["approvalPolicy"],"effort":params["effort"],"mode":params["collaborationMode"]["mode"]})).collect::<Vec<_>>(), vec![json!({"model":"provider-current","cwd":native_cwd,"sandbox":"readOnly","approval":"on-request","effort":"ultra","mode":"plan"});2], "unchanged host intent must not put stale requested settings back over native echoes");
    }

    #[tokio::test]
    async fn task008_settings_managed_actor_forwards_and_recovers_native_plan_defaults() {
        let logs = tempfile::tempdir().unwrap();
        let log = logs.path().join("settings-requests.jsonl");
        let fixture =
            native_codex_fixture(json!({"appendRequestLogPath":log,"recordTurns":true})).await;
        let state_dir = fixture.dir.path().join("settings-actor");
        let actor = FreshAgentHostActor::open(
            &state_dir,
            fixture.profile.clone(),
            fixture.transport.clone(),
        )
        .await
        .unwrap();
        let cwd = fixture.dir.path().join("next");
        std::fs::create_dir(&cwd).unwrap();
        actor.configure(RequestId::parse("managed-settings").unwrap(), serde_json::from_value(json!({"model":"provider-current","effort":"ultra","cwd":cwd,"sandbox":"read-only","permissionMode":"on-request","collaborationMode":"plan"})).unwrap()).await.unwrap();
        actor
            .dispatch(
                RequestId::parse("managed-plan").unwrap(),
                "managed plan".into(),
                None,
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if actor.snapshot().await.unwrap()["status"] == "idle" {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        actor
            .configure(
                RequestId::parse("managed-native-default").unwrap(),
                serde_json::from_value(json!({"effort":null})).unwrap(),
            )
            .await
            .unwrap();
        actor
            .dispatch(
                RequestId::parse("managed-native-default-send").unwrap(),
                "native default effort".into(),
                None,
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            while actor.snapshot().await.unwrap()["status"] != "idle" {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let profile = actor.profile().await;
        actor.stop().await.unwrap();
        let resumed = FreshAgentHostActor::open(
            &state_dir,
            profile,
            HostedTransport::new(FreshProvider::Codex).await,
        )
        .await
        .unwrap();
        resumed
            .dispatch(
                RequestId::parse("managed-plan-reload").unwrap(),
                "managed plan after reload".into(),
                None,
            )
            .await
            .unwrap();
        let recovered = serde_json::to_value(resumed.profile().await).unwrap();
        resumed.stop().await.unwrap();
        let requests: Vec<Value> = std::fs::read_to_string(log)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let starts: Vec<_> = requests
            .iter()
            .filter(|row| row["method"] == "turn/start")
            .collect();
        assert_eq!(starts.len(), 3);
        assert_eq!(
            starts
                .iter()
                .map(|row| row["params"]["effort"].clone())
                .collect::<Vec<_>>(),
            vec![json!("ultra"), Value::Null, Value::Null]
        );
        for (index, row) in starts.into_iter().enumerate() {
            assert_eq!(
                row["params"]["collaborationMode"],
                json!({"mode":"plan","settings":{"model":"provider-current","reasoning_effort":if index == 0 {json!("ultra")} else {Value::Null},"developer_instructions":null}})
            );
            assert_eq!(row["params"]["cwd"], json!(cwd));
            assert_eq!(row["params"]["sandboxPolicy"]["type"], "readOnly");
            assert_eq!(row["params"]["approvalPolicy"], "on-request");
        }
        assert_eq!(recovered["collaborationMode"], "plan");
    }

    #[tokio::test]
    async fn model_catalog_uses_the_same_initialized_native_actor_process_without_a_turn() {
        let logs = tempfile::tempdir().unwrap();
        let log = logs.path().join("requests.jsonl");
        let fixture=native_codex_fixture(json!({"appendRequestLogPath":log,"modelCatalogPages":[
            {"data":[{"id":"catalog-record","model":"gpt-6.1-sol","displayName":"Native Sol","supportedReasoningEfforts":[{"reasoningEffort":"xhigh"}],"defaultReasoningEffort":"xhigh","inputModalities":["text","image"]}],"nextCursor":"1"},
            {"data":[{"id":"record-current","model":"provider-current","displayName":"Provider Current","supportedReasoningEfforts":[{"reasoningEffort":"ultra"}],"defaultReasoningEffort":"ultra","inputModalities":["text"]}],"nextCursor":null},
        ]})).await;
        let actor = FreshAgentHostActor::open(
            fixture.dir.path().join("catalog-actor"),
            fixture.profile.clone(),
            fixture.transport.clone(),
        )
        .await
        .unwrap();
        let before = actor.profile().await;
        // Ordinary creation queues its created + idle snapshot frames. Join
        // that existing startup boundary before testing a read-only operation.
        tokio::time::timeout(Duration::from_secs(10),async {
            loop {
                if actor.read_events(0,256).await.events.iter().any(|entry|matches!(&entry.event,
                    AgentEvent::Provider {payload} if payload["event"]["type"]=="freshAgent.session.snapshot"
                    && payload["event"]["status"]=="idle" && payload["sessionId"].as_str()==before.native_session_id.as_deref())) {break;}
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.expect("ordinary native creation reaches its idle snapshot");
        let head = actor.read_events(0, 256).await.head;
        let value = actor.model_catalog(Some(&before.cwd)).await.unwrap();
        let after = actor.profile().await;
        let after_events = actor.read_events(head, 256).await;
        let after_head = after_events.head;
        actor.stop().await.unwrap();
        let requests = std::fs::read_to_string(log)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(value[0]["id"], "gpt-6.1-sol");
        assert_eq!(value[1]["id"], "provider-current");
        assert_eq!(value[1]["defaultEffort"], "ultra");
        assert_eq!(before.native_session_id, after.native_session_id);
        assert_eq!(before.model, after.model);
        assert_eq!(
            head, after_head,
            "events during catalog read: {:?}",
            after_events.events
        );
        assert_eq!(
            requests
                .iter()
                .filter(|r| r["method"] == "initialize")
                .count(),
            1
        );
        assert_eq!(
            requests
                .iter()
                .filter(|r| r["method"] == "thread/start")
                .count(),
            1
        );
        assert_eq!(
            requests
                .iter()
                .filter(|r| r["method"] == "model/list")
                .count(),
            2
        );
        assert!(!requests.iter().any(|r| r["method"] == "turn/start"
            || r["method"] == "thread/resume"
            || r["method"] == "thread/fork"));
    }

    #[tokio::test]
    async fn task6_production_actor_owns_native_forwarding_through_fork_without_factory_handles() {
        let NativeCodexFixture {
            transport,
            profile,
            diagnostic: _,
            dir,
            _exec_dir,
            _environment,
        } = native_codex_fixture(json!({"recordTurns":true})).await;
        // Move the factory's only transport handle into the real production
        // actor. No direct fixture handle can keep its bridge guard alive.
        let actor = FreshAgentHostActor::open(dir.path().join("actor"), profile, transport)
            .await
            .unwrap();
        let parent = actor.profile().await.native_session_id.unwrap();
        for (request, text, expected_rows) in [
            ("parent-send", "actor parent turn", 2),
            ("child-send", "actor child turn", 4),
        ] {
            let before = actor.read_events(0, 256).await.head;
            actor
                .dispatch(RequestId::parse(request).unwrap(), text.into(), None)
                .await
                .unwrap();
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    let batch = actor.read_events(before, 256).await;
                    if batch.events.iter().any(|entry| matches!(&entry.event,
                        AgentEvent::Provider {payload} if payload["event"]["type"] == "freshAgent.turn.complete")) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("the actor must retain its bridge through native completion");
            let snapshot = actor.snapshot().await.unwrap();
            assert_eq!(
                snapshot["turns"].as_array().unwrap().len(),
                expected_rows,
                "{snapshot}"
            );
            assert_eq!(snapshot["status"], "idle");
            if request == "parent-send" {
                let fork = actor
                    .fork(
                        RequestId::parse("actor-fork").unwrap(),
                        parent.clone(),
                        None,
                    )
                    .await
                    .unwrap();
                assert_ne!(fork.child_session_id, parent);
                assert_eq!(
                    actor.profile().await.native_session_id,
                    Some(fork.child_session_id)
                );
            }
        }
        actor.stop().await.unwrap();
    }

    async fn task5_durable_native_control(
        method: &str,
        params: Value,
        event_type: &str,
        invalid_answer: Value,
        valid_answer: Value,
    ) {
        let mut fixture = native_codex_fixture(json!({"recordTurns":true,"serverRequestsByPrompt":{"ask":{"id":41,"method":method,"params":params}}})).await;
        let transport = fixture.transport.clone();
        let profile = fixture.profile.clone();
        let dir = &fixture.dir;
        let diagnostic = &mut fixture.diagnostic;
        let actor = FreshAgentHostActor::open(dir.path().join("actor"), profile, transport.clone())
            .await
            .unwrap_or_else(|error| {
                let mut frames = Vec::new();
                while let Ok(frame) = diagnostic.try_recv() {
                    frames.push(frame);
                }
                panic!("hosted native fixture startup failed: {error:?}; {frames:?}")
            });
        actor
            .dispatch(RequestId::parse("ask-native").unwrap(), "ask".into(), None)
            .await
            .unwrap_or_else(|error| {
                let mut frames = Vec::new();
                while let Ok(frame) = diagnostic.try_recv() {
                    frames.push(frame);
                }
                panic!("hosted native fixture send failed: {error:?}; {frames:?}")
            });
        let pending=tokio::time::timeout(Duration::from_secs(5),async {
            loop {
                if let Some(event)=actor.read_events(0,256).await.events.into_iter().find(|entry| matches!(&entry.event, AgentEvent::PermissionRequested {payload,..} if payload["type"]==event_type)) {break event;}
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.expect("native elicitation must enter the durable pending-decision path before a user click");
        let AgentEvent::PermissionRequested {
            decision_id,
            payload,
        } = pending.event
        else {
            unreachable!()
        };
        assert_eq!(payload["providerRequest"]["id"], 41);
        // Reading from a reconnect's cursor yields the exact same public/native IDs.
        assert!(actor.read_events(0,256).await.events.iter().any(|entry| matches!(&entry.event,AgentEvent::PermissionRequested{decision_id:id,payload:p} if id==&decision_id && p==&payload)));
        let invalid = actor.resolve_permission(&decision_id, invalid_answer).await;
        assert!(
            invalid.is_err(),
            "an invalid native answer must not resolve its durable decision"
        );
        assert!(!actor.read_events(0,256).await.events.iter().any(|entry|matches!(&entry.event,AgentEvent::DecisionResolved{decision_id:id} if id==&decision_id)));
        actor
            .resolve_permission(&decision_id, valid_answer.clone())
            .await
            .unwrap();
        actor
            .resolve_permission(&decision_id, valid_answer)
            .await
            .unwrap();
        actor.stop().await.unwrap();
    }

    #[tokio::test]
    async fn task5_durable_native_elicitation_survives_reconnect_and_invalid_answer() {
        task5_durable_native_control("mcpServer/elicitation/request",json!({"serverName":"contract","mode":"form","message":"Hosted form","requestedSchema":{"type":"object","properties":{"count":{"type":"integer","minimum":1}},"required":["count"]}}),"freshAgent.elicitation.request",json!({"elicitation":{"action":"accept","content":{"count":0}}}),json!({"elicitation":{"action":"accept","content":{"count":2}}})).await;
    }
    #[tokio::test]
    async fn task5_durable_native_question_keeps_a_rejected_answer_pending() {
        task5_durable_native_control("item/tool/requestUserInput",json!({"isBlocking":false,"questions":[{"id":"choice","header":"Choice","question":"Pick","isOther":false,"options":[{"label":"A","description":"Alpha"}]}]}),"freshAgent.question.request",json!({"answers":{"choice":"unoffered"}}),json!({"answers":{"choice":"A"}})).await;
    }
    #[tokio::test]
    async fn task5_durable_native_approval_keeps_an_unoffered_decision_pending() {
        task5_durable_native_control(
            "item/commandExecution/requestApproval",
            json!({"availableDecisions":["cancel"]}),
            "freshAgent.permission.request",
            json!({"behavior":"allow"}),
            json!({"nativeDecision":"cancel"}),
        )
        .await;
    }

    #[tokio::test]
    async fn task6_final_loss_recovers_native_retained_transcript_and_attention() {
        let mut fixture =
            native_codex_fixture(json!({"recordTurns":true,"liveTranscript":true})).await;
        let transport = fixture.transport.clone();
        let profile = fixture.profile.clone();
        let diagnostic = &mut fixture.diagnostic;
        transport.start(&profile).await.unwrap();
        let mut events = transport.take_event_stream().unwrap();
        while events.try_recv().is_ok() {}
        while transport
            .event_tx
            .try_send(AgentEvent::Provider {
                payload: json!({"occupied":true}),
            })
            .is_ok()
        {}
        transport
            .dispatch(
                &RequestId::parse("retained-send").unwrap(),
                "retained prompt",
                &profile,
            )
            .await
            .unwrap();
        let mut accepted = None;
        let completion = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let frame: Value = serde_json::from_str(&diagnostic.recv().await.unwrap()).unwrap();
                if frame["type"] == "freshAgent.send.accepted"
                    && frame["requestId"] == "retained-send"
                {
                    accepted = Some(frame.clone());
                }
                if frame["event"]["type"] == "freshAgent.turn.complete" {
                    break frame["event"]["at"].clone();
                }
            }
        })
        .await
        .unwrap();
        // There are no more native frames; only draining the bounded output
        // channel is allowed to drive recovery of this final completion.
        tokio::time::sleep(Duration::from_millis(50)).await;
        let recovered = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if let Some(AgentEvent::Provider { payload }) = events.recv().await {
                    if payload["event"]["type"] == "freshAgent.host.backpressure" {
                        break payload;
                    }
                }
            }
        })
        .await
        .unwrap();
        let snapshot = &recovered["event"]["retainedState"]["snapshot"];
        let marks = &recovered["event"]["retainedState"]["attentionMarks"];
        let retained = serde_json::to_string(snapshot).unwrap();
        let native_id = transport.session_id.lock().await.clone().unwrap();
        transport.clone().stop().await.unwrap();
        let accepted = accepted.expect(
            "the real ordinary send must emit its correlated native receipt before completion",
        );
        assert_eq!(accepted["sessionId"], native_id);
        assert!(accepted["submittedTurnId"]
            .as_str()
            .is_some_and(|id| !id.is_empty()));
        assert!(
            retained.contains("Native streaming fragment and final answer"),
            "recover exact event-owned body without thread/read: {recovered}"
        );
        assert_eq!(snapshot["threadId"], native_id);
        assert_eq!(marks[0]["lastTurnCompleteAt"], completion);
        assert_eq!(
            snapshot["extensions"]["codex"]["projection"]["turnOutputStates"]
                .as_object()
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn task6_fork_recovery_uses_transport_owner_after_a_lost_native_identity_edge() {
        let mut fixture =
            native_codex_fixture(json!({"recordTurns":true,"liveTranscript":true})).await;
        let transport = fixture.transport.clone();
        let parent = transport
            .start(&fixture.profile)
            .await
            .unwrap()
            .native_session_id
            .unwrap();
        let mut events = transport.take_event_stream().unwrap();
        let child = transport
            .fork(&RequestId::parse("recovery-fork").unwrap(), &parent, None)
            .await
            .unwrap()
            .child_session_id;
        // The explicit fork already committed the child owner. Simulate losing
        // its native identity frame while keeping the old watch value.
        transport.native_tx.send_replace(Some(parent));
        while events.try_recv().is_ok() {}
        while transport
            .event_tx
            .try_send(AgentEvent::Provider {
                payload: json!({"occupied":true}),
            })
            .is_ok()
        {}
        transport
            .dispatch(
                &RequestId::parse("child-final-send").unwrap(),
                "child output",
                &fixture.profile,
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let frame: Value =
                    serde_json::from_str(&fixture.diagnostic.recv().await.unwrap()).unwrap();
                if frame["sessionId"].as_str() == Some(child.as_str())
                    && frame["event"]["type"] == "freshAgent.turn.complete"
                {
                    break;
                }
            }
        })
        .await
        .expect("observe the child's final native edge before releasing capacity");
        let recovered = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if let Some(AgentEvent::Provider { payload }) = events.recv().await {
                    if payload["event"]["retainedState"].is_object() {
                        break payload["event"]["retainedState"].clone();
                    }
                }
            }
        })
        .await;
        transport.stop().await.unwrap();
        let recovered = recovered.expect(
            "a committed fork owner must recover its final output without another provider frame",
        );
        assert_eq!(recovered["snapshot"]["threadId"], child);
        assert!(recovered["snapshot"]
            .to_string()
            .contains("Native streaming fragment and final answer"));
    }

    #[tokio::test]
    async fn task6_journal_reset_reads_authoritative_source_after_final_native_frame() {
        let mut fixture =
            native_codex_fixture(json!({"recordTurns":true,"liveTranscript":true})).await;
        let transport = fixture.transport.clone();
        let profile = fixture.profile.clone();
        let dir = &fixture.dir;
        let diagnostic = &mut fixture.diagnostic;
        let actor = FreshAgentHostActor::open_with_bounds(
            dir.path().join("actor"),
            profile,
            transport.clone(),
            256 * 1024,
            8,
        )
        .await
        .unwrap();
        actor
            .dispatch(
                RequestId::parse("reset-send").unwrap(),
                "retained prompt".into(),
                None,
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let frame: Value = serde_json::from_str(&diagnostic.recv().await.unwrap()).unwrap();
                if frame["event"]["type"] == "freshAgent.turn.complete" {
                    break;
                }
            }
        })
        .await
        .unwrap();
        for index in 0..20 {
            actor
                .record_event(AgentEvent::Provider {
                    payload: json!({"noise":index}),
                })
                .await
                .unwrap();
        }
        let batch = actor.read_events(1, 8).await;
        assert!(batch.reset_required);
        let batch = serde_json::to_value(batch).unwrap();
        actor.stop().await.unwrap();
        assert!(serde_json::to_string(&batch["retainedState"]["snapshot"]).unwrap().contains("Native streaming fragment and final answer"), "journal reset must read the provider source even after its history was evicted: {batch}");
        assert!(
            batch["retainedState"]["attentionMarks"][0]["lastTurnCompleteAt"]
                .as_i64()
                .is_some()
        );
    }

    async fn task6_recover_final_native_question(blocking: Option<bool>) {
        let witness = tempfile::tempdir().unwrap();
        let operations = witness.path().join("native-operations.jsonl");
        let behavior = if let Some(blocking) = blocking {
            json!({"recordTurns":true,"liveTranscript":true,"appendThreadOperationLogPath":operations,"serverRequestsByPrompt":{"ask":{"id":51,"method":"item/tool/requestUserInput","params":{"isBlocking":blocking,"questions":[{"id":"choice","header":"Choice","question":"Where?","options":null}]}}}})
        } else {
            json!({"appendThreadOperationLogPath":operations,"overrides":{"turn/start":{"result":{"turn":{"id":"ongoing-turn","status":"inProgress"}}}},"notificationsAfterMethods":{"turn/start":[{"method":"turn/started","params":{"threadId":"thread-new-1","turn":{"id":"ongoing-turn","status":"inProgress"}}},{"method":"item/completed","params":{"threadId":"thread-new-1","turnId":"ongoing-turn","item":{"id":"async-final","type":"agentMessage","text":"Ongoing work with an async question","delivery":"async","questions":[{"title":"Where?","options":["Staging"]}]}}}]}})
        };
        let mut fixture = native_codex_fixture(behavior).await;
        let transport = fixture.transport.clone();
        transport.start(&fixture.profile).await.unwrap();
        let mut events = transport.take_event_stream().unwrap();
        while events.try_recv().is_ok() {}
        let reads_before = std::fs::read_to_string(&operations)
            .unwrap_or_default()
            .lines()
            .filter(|line| line.contains("thread/read"))
            .count();
        while transport
            .event_tx
            .try_send(AgentEvent::Provider {
                payload: json!({"occupied":true}),
            })
            .is_ok()
        {}
        transport
            .dispatch(
                &RequestId::parse("final-question").unwrap(),
                "ask",
                &fixture.profile,
            )
            .await
            .unwrap();
        let kind = if blocking.is_some() {
            "freshAgent.turn.waiting"
        } else {
            "freshAgent.question.available"
        };
        let at = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let frame: Value =
                    serde_json::from_str(&fixture.diagnostic.recv().await.unwrap()).unwrap();
                if frame["event"]["type"] == kind {
                    break frame["event"]["at"].clone();
                }
            }
        })
        .await
        .unwrap();
        // No native frames follow the final waiting/action edge. Only releasing
        // downstream capacity can restore the dropped content and current control.
        tokio::time::sleep(Duration::from_millis(50)).await;
        let (recovery, decisions) = tokio::time::timeout(Duration::from_secs(3), async {
            let mut recovery = None;
            let mut decisions = std::collections::BTreeMap::new();
            loop {
                match events.recv().await.unwrap() {
                    AgentEvent::Provider { payload }
                        if payload["event"]["retainedState"].is_object() =>
                    {
                        recovery = Some(payload["event"]["retainedState"].clone())
                    }
                    AgentEvent::PermissionRequested {
                        decision_id,
                        payload,
                    } => {
                        decisions.insert(decision_id, payload);
                    }
                    _ => {}
                }
                if let Some(recovery) =
                    recovery.take_if(|_| blocking.is_none() || !decisions.is_empty())
                {
                    break (recovery, decisions);
                }
            }
        })
        .await
        .expect("the final native question must recover without another provider frame");
        let reads_after = std::fs::read_to_string(&operations)
            .unwrap_or_default()
            .lines()
            .filter(|line| line.contains("thread/read"))
            .count();
        let mut drained = None;
        if blocking.is_some() {
            let decision = decisions.keys().next().unwrap();
            transport
                .resolve_permission(decision, json!({"answers":{"choice":"Staging"}}))
                .await
                .unwrap();
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    let frame: Value =
                        serde_json::from_str(&fixture.diagnostic.recv().await.unwrap()).unwrap();
                    if frame["event"]["type"] == "freshAgent.turn.complete" {
                        break;
                    }
                }
            })
            .await
            .unwrap();
            drained = transport.retained_state().await.unwrap();
        }
        transport.clone().stop().await.unwrap();
        assert_eq!(
            reads_after, reads_before,
            "bridge recovery must not invoke native history merely to repair loss"
        );
        assert_eq!(recovery["snapshot"]["status"], "running");
        let mark = &recovery["attentionMarks"][0];
        assert!(mark.get("lastTurnCompleteAt").is_none());
        if let Some(blocking) = blocking {
            assert_eq!(mark["lastWaitingAt"], at);
            assert_eq!(recovery["pendingControls"].as_array().unwrap().len(), 1);
            assert_eq!(recovery["pendingControls"][0]["isBlocking"], blocking);
            assert_eq!(
                decisions.len(),
                1,
                "duplicate recovery deliveries retain one actual decision identity"
            );
            assert_eq!(
                decisions.values().next().unwrap()["providerRequest"]["id"],
                51
            );
            assert!(drained.unwrap()["attentionMarks"][0].get("lastWaitingAt").is_none(),"the recovered question remains answerable and its final awaited drain clears waiting");
        } else {
            assert_eq!(mark["lastQuestionAvailableAt"], at);
            assert!(mark.get("lastWaitingAt").is_none());
            assert!(recovery["pendingControls"].as_array().unwrap().is_empty());
            assert!(
                decisions.is_empty(),
                "async transcript content must never become a durable permission decision"
            );
            assert!(serde_json::to_string(&recovery["snapshot"])
                .unwrap()
                .contains("Ongoing work with an async question"));
        }
    }

    #[tokio::test]
    async fn task6_final_false_flag_question_recovers_an_answerable_decision() {
        task6_recover_final_native_question(Some(false)).await;
    }
    #[tokio::test]
    async fn task6_final_blocking_question_recovers_an_answerable_decision() {
        task6_recover_final_native_question(Some(true)).await;
    }
    #[tokio::test]
    async fn task6_final_async_content_recovers_without_a_permission_or_waiting() {
        task6_recover_final_native_question(None).await;
    }

    #[tokio::test]
    async fn task6_final_completion_overrides_cached_active_native_history_without_an_rpc() {
        let witness = tempfile::tempdir().unwrap();
        let release = witness.path().join("release-turn");
        let operations = witness.path().join("operations.jsonl");
        let mut fixture=native_codex_fixture(json!({"recordTurns":true,"liveTranscript":true,"waitForTurnReleasePath":release,"appendThreadOperationLogPath":operations})).await;
        let transport = fixture.transport.clone();
        transport.start(&fixture.profile).await.unwrap();
        let mut events = transport.take_event_stream().unwrap();
        transport
            .dispatch(
                &RequestId::parse("cached-active").unwrap(),
                "run",
                &fixture.profile,
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let frame: Value =
                    serde_json::from_str(&fixture.diagnostic.recv().await.unwrap()).unwrap();
                if frame["event"]["type"] == "freshAgent.transcript.patch"
                    && frame.to_string().contains("Native streaming fragment")
                {
                    break;
                }
            }
        })
        .await
        .unwrap();
        let active = transport.snapshot().await.unwrap();
        assert_eq!(
            active["status"], "running",
            "precondition: exact native history was cached while genuinely active"
        );
        let reads_before = std::fs::read_to_string(&operations)
            .unwrap()
            .lines()
            .filter(|line| line.contains("thread/read"))
            .count();
        while events.try_recv().is_ok() {}
        while transport
            .event_tx
            .try_send(AgentEvent::Provider {
                payload: json!({"occupied":true}),
            })
            .is_ok()
        {}
        std::fs::write(&release, b"complete native turn").unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let frame: Value =
                    serde_json::from_str(&fixture.diagnostic.recv().await.unwrap()).unwrap();
                if frame["event"]["type"] == "freshAgent.turn.complete" {
                    break;
                }
            }
        })
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        let recovered = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if let Some(AgentEvent::Provider { payload }) = events.recv().await {
                    if payload["event"]["retainedState"].is_object() {
                        break payload["event"]["retainedState"].clone();
                    }
                }
            }
        })
        .await
        .unwrap();
        let reads_after = std::fs::read_to_string(operations)
            .unwrap()
            .lines()
            .filter(|line| line.contains("thread/read"))
            .count();
        transport.clone().stop().await.unwrap();
        assert_eq!(reads_after, reads_before);
        assert_eq!(
            recovered["snapshot"]["status"], "idle",
            "a final completion is authoritative over an earlier active native read: {recovered}"
        );
        assert_eq!(recovered["snapshot"]["capabilities"]["send"], true);
        assert_eq!(recovered["snapshot"]["capabilities"]["interrupt"], false);
    }

    #[tokio::test]
    async fn task6_upstream_lag_ending_in_a_control_recovers_without_later_frames() {
        let (bus, rx) = broadcast::channel(1);
        let (created, _) = watch::channel(None);
        let (native, _) = watch::channel(Some("thread-upstream".to_string()));
        let (events, mut event_rx) = mpsc::channel(1);
        events
            .send(AgentEvent::Provider {
                payload: json!({"occupied":true}),
            })
            .await
            .unwrap();
        let (send_outcomes, _) = broadcast::channel(8);
        let (kill_outcomes, _) = broadcast::channel(8);
        let _bridge = spawn_broadcast_bridge(
            FreshProvider::Codex,
            rx,
            BroadcastBridgeOutputs {
                native_evidence: watch::channel(None).0,
                native_identity: Arc::new(std::sync::Mutex::new(HostedNativeIdentity::default())),
                refusal_observer: None,
                owned_session: None,
                retained_codex: None,
                created,
                native,
                events,
                send_outcomes,
                kill_outcomes,
                suppressed_kills: Arc::new(std::sync::Mutex::new(HashSet::new())),
            },
        );
        let request = |id: &str| {
            json!({"type":"freshAgent.event","provider":"codex","sessionType":"freshcodex","sessionId":"thread-upstream","event":{"type":"freshAgent.question.request","requestId":id}}).to_string()
        };
        bus.send(request("first-control")).unwrap();
        // The first durable conversion waits for the full downstream queue.
        tokio::time::sleep(Duration::from_millis(50)).await;
        for _ in 0..10 {
            bus.send(request("final-control")).unwrap();
        }
        let recovered = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if let Some(AgentEvent::Provider { payload }) = event_rx.recv().await {
                    if payload["event"]["type"] == "freshAgent.host.backpressure" {
                        break payload;
                    }
                }
            }
        })
        .await;
        assert!(recovered.is_ok(),"lag before the journal must recover even when the last retained frame is a durable control and the provider becomes silent");
    }

    #[tokio::test]
    async fn task6_final_dropped_frame_recovers_without_another_provider_frame() {
        let (bus, rx) = broadcast::channel(8);
        let (created, _) = watch::channel(None);
        let (native, _) = watch::channel(Some("thread-final".to_string()));
        let (events, mut event_rx) = mpsc::channel(1);
        events
            .send(AgentEvent::Provider {
                payload: json!({"occupied":true}),
            })
            .await
            .unwrap();
        let (send_outcomes, _) = broadcast::channel(8);
        let (kill_outcomes, _) = broadcast::channel(8);
        let _bridge = spawn_broadcast_bridge(
            FreshProvider::Codex,
            rx,
            BroadcastBridgeOutputs {
                native_evidence: watch::channel(None).0,
                native_identity: Arc::new(std::sync::Mutex::new(HostedNativeIdentity::default())),
                refusal_observer: None,
                owned_session: None,
                retained_codex: None,
                created,
                native,
                events,
                send_outcomes,
                kill_outcomes,
                suppressed_kills: Arc::new(std::sync::Mutex::new(HashSet::new())),
            },
        );
        bus.send(json!({"type":"freshAgent.event","provider":"codex","sessionType":"freshcodex","sessionId":"thread-final","event":{"type":"freshAgent.turn.complete","at":100}}).to_string()).unwrap();
        // Leave capacity unavailable while the bridge consumes its only input.
        tokio::time::sleep(Duration::from_millis(50)).await;
        event_rx.recv().await.unwrap();
        let recovery = tokio::time::timeout(Duration::from_secs(2), event_rx.recv())
            .await
            .expect("a final drop must independently await capacity and recover")
            .unwrap();
        let AgentEvent::Provider { payload } = recovery else {
            panic!("routed recovery event")
        };
        assert_eq!(payload["type"], "freshAgent.event");
        assert_eq!(payload["provider"], "codex");
        assert_eq!(payload["sessionType"], "freshcodex");
        assert_eq!(payload["sessionId"], "thread-final");
        assert_eq!(payload["event"]["type"], "freshAgent.host.backpressure");
    }

    #[tokio::test]
    async fn only_typed_deterministic_transport_retains_fixture_decisions_on_replacement() {
        for fixture_transport in [None, Some(FreshAgentFixtureTransport::Deterministic)] {
            let directory = tempfile::tempdir().unwrap();
            let profile = parity_profile(FreshProvider::Claude);
            let trace = Arc::new(ParityTrace::default());
            let transport = Arc::new(ParityFixtureTransport {
                provider: FreshProvider::Claude,
                trace: trace.clone(),
            });
            let actor = open_actor_for_transport(
                directory.path(),
                profile.clone(),
                transport.clone(),
                fixture_transport,
            )
            .await
            .unwrap();
            actor.record_permission("retained-fixture".into(), json!({
                "type":"freshAgent.permission.request", "requestId":"retained-fixture",
                "subtype":"fixture", "tool":{"name":"Read","input":{"file_path":"fixture-only"}}
            })).await.unwrap();
            drop(actor);
            let actor =
                open_actor_for_transport(directory.path(), profile, transport, fixture_transport)
                    .await
                    .unwrap();
            let result = actor
                .resolve_permission("retained-fixture", json!({"behavior":"allow"}))
                .await;
            if fixture_transport.is_some() {
                assert_eq!(result, Ok(()));
                assert_eq!(
                    trace
                        .observations
                        .lock()
                        .unwrap()
                        .iter()
                        .filter(|row| row.operation == "approval")
                        .count(),
                    1
                );
            } else {
                assert_eq!(
                    result,
                    Err(freshell_agent_runtime::host_actor::ActorError::UnknownDecision)
                );
                assert_eq!(
                    trace
                        .observations
                        .lock()
                        .unwrap()
                        .iter()
                        .filter(|row| row.operation == "approval")
                        .count(),
                    0
                );
            }
        }
    }

    struct SnapshotProviderEnv(Vec<(&'static str, Option<std::ffi::OsString>)>);
    impl Drop for SnapshotProviderEnv {
        fn drop(&mut self) {
            for (key, value) in &self.0 {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

    #[tokio::test]
    async fn normalized_native_init_field_refusals_are_typed_and_body_free() {
        for provider in [FreshProvider::Claude, FreshProvider::Kilroy] {
            for (id, reason) in [
                (None, "missing_cli_session_id"),
                (Some("local-presentation-key"), "local_placeholder_id"),
                (Some("invalid-native-id"), "invalid_cli_session_id"),
            ] {
                let (sender, receiver) = broadcast::channel(16);
                let (created, _) = watch::channel(None);
                let (native, native_rx) = watch::channel(None);
                let (native_evidence, evidence_rx) = watch::channel(None);
                let (events, mut event_rx) = mpsc::channel(16);
                let (send_outcomes, _) = broadcast::channel(16);
                let (kill_outcomes, _) = broadcast::channel(16);
                let (observer, mut observations) = mpsc::channel(16);
                let _bridge = spawn_broadcast_bridge(
                    provider.clone(),
                    receiver,
                    BroadcastBridgeOutputs {
                        owned_session: None,
                        retained_codex: None,
                        created,
                        native,
                        native_evidence,
                        native_identity: Arc::new(std::sync::Mutex::new(
                            HostedNativeIdentity::default(),
                        )),
                        events,
                        send_outcomes,
                        kill_outcomes,
                        suppressed_kills: Arc::new(std::sync::Mutex::new(HashSet::new())),
                        refusal_observer: Some(observer),
                    },
                );
                let launch = freshell_platform::managed_child_secrets::snapshot()
                    .and_then(|environment| environment.get(super::super::native_identity::LAUNCH_ENV).cloned())
                    .map(|value| serde_json::from_str::<Value>(&value).unwrap())
                    .unwrap_or(json!({"incarnationId":"current","launchNonce":"current-nonce","evidenceRevision":0,"executionGeneration":1,"requestedNativeSessionId":null}));
                let mut event = json!({"type":"freshAgent.session.init","sessionId":"local-presentation-key",
                    "message":"excluded private provider content", "nativeIdentityEvidence":{"launch":launch,"digest":"a".repeat(64),"source":"startup","queryGeneration":1}});
                if let Some(id) = id {
                    event["cliSessionId"] = json!(id);
                }
                sender
                    .send(json!({"type":"freshAgent.event","event":event}).to_string())
                    .unwrap();
                let record = tokio::time::timeout(Duration::from_secs(1), observations.recv())
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(record["event"], "host.native_identity.refused");
                assert_eq!(record["reason"], reason);
                assert_eq!(record["severity"], "warn");
                assert_eq!(record["provider"], provider.as_str());
                assert_eq!(record["launch"], launch);
                assert_eq!(record["nativeEvidenceDigest"], "a".repeat(64));
                assert_eq!(record["queryGeneration"], 1);
                assert_eq!(record["normalizedEventType"], "freshAgent.session.init");
                assert_eq!(record["nativeReceiverPublished"], false);
                assert!(!record
                    .to_string()
                    .contains("excluded private provider content"));
                assert!(!record.to_string().contains("local-presentation-key"));
                assert!(native_rx.borrow().is_none());
                assert!(evidence_rx.borrow().is_none());
                assert!(matches!(
                    event_rx.recv().await,
                    Some(AgentEvent::Provider { .. })
                ));
            }
        }
    }

    #[tokio::test]
    async fn native_query_loading_withdraws_the_previous_current_host_observation() {
        let (sender, receiver) = broadcast::channel(16);
        let (created, _) = watch::channel(None);
        let (native, native_rx) = watch::channel(None);
        let (native_evidence, evidence_rx) = watch::channel(None);
        let (events, mut event_rx) = mpsc::channel(16);
        let (send_outcomes, _) = broadcast::channel(16);
        let (kill_outcomes, _) = broadcast::channel(16);
        let _bridge = spawn_broadcast_bridge(
            FreshProvider::Claude,
            receiver,
            BroadcastBridgeOutputs {
                owned_session: None,
                retained_codex: None,
                created,
                native,
                native_evidence,
                native_identity: Arc::new(std::sync::Mutex::new(HostedNativeIdentity::default())),
                events,
                send_outcomes,
                kill_outcomes,
                suppressed_kills: Arc::new(std::sync::Mutex::new(HashSet::new())),
                refusal_observer: None,
            },
        );
        let launch = freshell_platform::managed_child_secrets::snapshot()
            .and_then(|environment| {
                environment
                    .get(super::super::native_identity::LAUNCH_ENV)
                    .cloned()
            })
            .map(|value| serde_json::from_str::<Value>(&value).unwrap())
            .unwrap_or(
                json!({"incarnationId":"current","launchNonce":"current-nonce",
                "evidenceRevision":0,"executionGeneration":1,"requestedNativeSessionId":null}),
            );
        let root = launch["requestedNativeSessionId"]
            .as_str()
            .unwrap_or("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        sender.send(json!({"type":"freshAgent.event","event":{"type":"freshAgent.session.init",
            "cliSessionId":root,"nativeIdentityEvidence":{"launch":launch,"digest":"a".repeat(64),"queryGeneration":1}}}).to_string()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            while !matches!(event_rx.recv().await, Some(AgentEvent::Started { .. })) {}
        })
        .await
        .unwrap();
        assert_eq!(native_rx.borrow().as_deref(), Some(root));
        assert!(evidence_rx.borrow().is_some());
        sender
            .send(
                json!({"type":"freshAgent.event","event":{"type":"freshAgent.session.loading",
            "nativeBinding":{"launch":launch,"queryGeneration":2}}})
                .to_string(),
            )
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if let Some(AgentEvent::Provider { payload }) = event_rx.recv().await {
                    if payload["event"]["type"] == "freshAgent.session.loading" {
                        break;
                    }
                }
            }
        })
        .await
        .unwrap();
        assert!(
            native_rx.borrow().is_none(),
            "old query identity cannot authorize the new loading query"
        );
        assert!(
            evidence_rx.borrow().is_none(),
            "old receipt must also be withdrawn"
        );
        sender.send(json!({"type":"freshAgent.event","event":{"type":"freshAgent.session.init",
            "cliSessionId":root,"nativeIdentityEvidence":{"launch":launch,"digest":"a".repeat(64),"queryGeneration":1}}}).to_string()).unwrap();
        sender
            .send(
                json!({"type":"freshAgent.event","event":{"type":"query-test-ordering-barrier"}})
                    .to_string(),
            )
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if let Some(AgentEvent::Provider { payload }) = event_rx.recv().await {
                    if payload["event"]["type"] == "query-test-ordering-barrier" {
                        break;
                    }
                }
            }
        })
        .await
        .unwrap();
        assert!(
            native_rx.borrow().is_none(),
            "a late previous-query init cannot refill the withdrawn gate"
        );
        sender.send(json!({"type":"freshAgent.event","event":{"type":"freshAgent.session.init",
            "cliSessionId":root,"nativeIdentityEvidence":{"launch":launch,"digest":"b".repeat(64),"queryGeneration":2}}}).to_string()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            while !matches!(event_rx.recv().await, Some(AgentEvent::Started { .. })) {}
        })
        .await
        .unwrap();
        assert_eq!(native_rx.borrow().as_deref(), Some(root));
        assert_eq!(evidence_rx.borrow().as_ref().unwrap()["queryGeneration"], 2);
    }

    async fn drain_native_bridge(
        sender: &broadcast::Sender<String>,
        events: &mut mpsc::Receiver<AgentEvent>,
    ) {
        sender
            .send(
                json!({"type":"freshAgent.event","event":{"type":"proof-ordering-barrier"}})
                    .to_string(),
            )
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
                while let Some(event) = events.recv().await {
                    if matches!(event, AgentEvent::Provider { payload } if payload["event"]["type"] == "proof-ordering-barrier") { return; }
                }
                panic!("bridge exited before barrier");
            }).await.unwrap();
    }

    #[tokio::test]
    async fn claude_public_rekey_requires_actual_clear_and_keeps_its_proven_lineage() {
        use freshell_runtime_protocol::NativeIdentityLaunch;
        const PARENT: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        const CHILD: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        const WRONG: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        let (sender, receiver) = broadcast::channel(32);
        let (created, _) = watch::channel(None);
        let (native, native_rx) = watch::channel(None);
        let (native_evidence, _) = watch::channel(None);
        let (events, mut event_rx) = mpsc::channel(32);
        let (send_outcomes, _) = broadcast::channel(16);
        let (kill_outcomes, _) = broadcast::channel(16);
        let identity = Arc::new(std::sync::Mutex::new(HostedNativeIdentity::default()));
        let mut transport = HostedTransport::new_with_context(FreshProvider::Claude, None).await;
        let owned = Arc::get_mut(&mut transport).unwrap();
        owned.native_identity = identity.clone();
        owned.native_rx = Mutex::new(native_rx);
        owned.native_tx = native.clone();
        *owned.session_id.lock().await = Some("presentation-parent".into());
        let _bridge = spawn_broadcast_bridge(
            FreshProvider::Claude,
            receiver,
            BroadcastBridgeOutputs {
                owned_session: None,
                retained_codex: None,
                created,
                native,
                native_evidence,
                native_identity: identity.clone(),
                events,
                send_outcomes,
                kill_outcomes,
                suppressed_kills: Arc::new(std::sync::Mutex::new(HashSet::new())),
                refusal_observer: None,
            },
        );
        let launch: NativeIdentityLaunch = serde_json::from_value(json!({
            "incarnationId":"clear-incarnation", "launchNonce":"clear-nonce", "evidenceRevision":7,
            "executionGeneration":3, "requestedNativeSessionId":PARENT,
        }))
        .unwrap();
        {
            let mut identity = identity.lock().unwrap();
            identity.launch = Some(launch.clone());
            identity.producer_launch = Some(launch.clone());
        }
        let init = |root: &str, source: &str, prior: Option<&str>, generation: u64| {
            json!({
            "type":"freshAgent.event", "event":{"type":"freshAgent.session.init", "sessionId":"presentation-parent",
            "cliSessionId":root, "nativeIdentityEvidence":{"launch":launch, "digest":"a".repeat(64),
            "source":source, "previousNativeSessionId":prior, "queryGeneration":generation}},
        }).to_string()
        };
        sender.send(init(PARENT, "resume", None, 1)).unwrap();
        drain_native_bridge(&sender, &mut event_rx).await;
        assert_eq!(
            transport.native_identity_evidence().await.unwrap()["nativeSessionId"],
            PARENT
        );
        sender
            .send(
                json!({"type":"freshAgent.created", "sessionId":"presentation-child",
            "sessionRef":{"provider":"claude", "sessionId":CHILD}})
                .to_string(),
            )
            .unwrap();
        drain_native_bridge(&sender, &mut event_rx).await;
        assert!(
            transport.native_identity_evidence().await.is_none(),
            "the public child identity is provisional"
        );
        sender.send(init(CHILD, "startup", None, 1)).unwrap();
        sender.send(init(CHILD, "clear", Some(WRONG), 1)).unwrap();
        drain_native_bridge(&sender, &mut event_rx).await;
        assert_eq!(
            identity.lock().unwrap().root.as_deref(),
            Some(PARENT),
            "unrelated or wrong-parent proof cannot move the root"
        );
        sender.send(init(CHILD, "clear", Some(PARENT), 1)).unwrap();
        drain_native_bridge(&sender, &mut event_rx).await;
        let cleared = transport
            .native_identity_evidence()
            .await
            .expect("an actual same-producer clear qualifies the new root");
        assert_eq!(cleared["nativeSessionId"], CHILD);
        assert_eq!(
            transport.provider_session_id().await.as_deref(),
            Some(CHILD),
            "commands and liveness must address the verified cleared native owner"
        );
        assert_eq!(
            cleared["launch"],
            json!(launch),
            "clear keeps the launched producer identity"
        );
        sender
            .send(
                json!({"type":"freshAgent.event", "event":{"type":"freshAgent.session.loading",
            "nativeBinding":{"launch":launch,"queryGeneration":2}}})
                .to_string(),
            )
            .unwrap();
        drain_native_bridge(&sender, &mut event_rx).await;
        assert!(transport.native_identity_evidence().await.is_none());
        sender.send(init(CHILD, "resume", None, 2)).unwrap();
        drain_native_bridge(&sender, &mut event_rx).await;
        let resumed = transport
            .native_identity_evidence()
            .await
            .expect("the next query can resume the proven cleared root");
        assert_eq!(
            resumed["providerEvidence"]["source"], "resume",
            "retain the actual native source"
        );
        assert_eq!(resumed["nativeSessionId"], CHILD);
        assert_eq!(resumed["launch"], json!(launch));
        let closed = |root: &str, generation: u64| {
            json!({"type":"freshAgent.event", "event":{
            "type":"freshAgent.session.closed", "nativeSessionId":root, "queryGeneration":generation,
            "nativeBinding":{"launch":launch,"queryGeneration":generation}, "reason":"stream_error",
        }}).to_string()
        };
        sender.send(closed(WRONG, 2)).unwrap();
        sender.send(closed(CHILD, 1)).unwrap();
        drain_native_bridge(&sender, &mut event_rx).await;
        assert!(
            transport.native_identity_evidence().await.is_some(),
            "a stale or unrelated close cannot revoke this query"
        );
        sender.send(closed(CHILD, 2)).unwrap();
        drain_native_bridge(&sender, &mut event_rx).await;
        assert!(
            transport.native_identity_evidence().await.is_none(),
            "a closed current query has no live authority"
        );
        sender.send(init(CHILD, "resume", None, 2)).unwrap();
        drain_native_bridge(&sender, &mut event_rx).await;
        assert!(
            transport.native_identity_evidence().await.is_none(),
            "late init from the closed query cannot restore authority"
        );
        sender
            .send(
                json!({"type":"freshAgent.event", "event":{"type":"freshAgent.session.loading",
            "nativeBinding":{"launch":launch,"queryGeneration":3}}})
                .to_string(),
            )
            .unwrap();
        sender.send(init(CHILD, "resume", None, 3)).unwrap();
        drain_native_bridge(&sender, &mut event_rx).await;
        assert!(
            transport.native_identity_evidence().await.is_some(),
            "a newly observed query resumes the proven root"
        );
    }

    #[tokio::test]
    async fn native_rollback_bridge_correlates_early_delayed_and_replaced_query_proof() {
        use freshell_runtime_protocol::NativeIdentityLaunch;
        const PARENT: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        const CHILD: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        const WRONG: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        for arrival in ["early", "delayed", "replaced-query"] {
            let (sender, receiver) = broadcast::channel(32);
            let (created, _) = watch::channel(None);
            let (native, native_rx) = watch::channel(None);
            let (native_evidence, _evidence_rx) = watch::channel(None);
            let (events, mut event_rx) = mpsc::channel(32);
            let (send_outcomes, _) = broadcast::channel(16);
            let (kill_outcomes, _) = broadcast::channel(16);
            let identity = Arc::new(std::sync::Mutex::new(HostedNativeIdentity::default()));
            let mut transport =
                HostedTransport::new_with_context(FreshProvider::Claude, None).await;
            let owned = Arc::get_mut(&mut transport).unwrap();
            owned.native_identity = identity.clone();
            owned.native_rx = Mutex::new(native_rx);
            let _bridge = spawn_broadcast_bridge(
                FreshProvider::Claude,
                receiver,
                BroadcastBridgeOutputs {
                    owned_session: None,
                    retained_codex: None,
                    created,
                    native,
                    native_evidence,
                    native_identity: identity.clone(),
                    events,
                    send_outcomes,
                    kill_outcomes,
                    suppressed_kills: Arc::new(std::sync::Mutex::new(HashSet::new())),
                    refusal_observer: None,
                },
            );
            let parent_launch: NativeIdentityLaunch = serde_json::from_value(json!({
                "incarnationId":"transition-incarnation","launchNonce":"transition-nonce",
                "evidenceRevision":7,"executionGeneration":3,"requestedNativeSessionId":PARENT
            }))
            .unwrap();
            {
                let mut identity = identity.lock().unwrap();
                identity.launch = Some(parent_launch.clone());
                identity.producer_launch = Some(parent_launch.clone());
            }
            let init = |root: &str, launch: &NativeIdentityLaunch, generation: u64| {
                json!({
                "type":"freshAgent.event","event":{"type":"freshAgent.session.init","cliSessionId":root,
                "nativeIdentityEvidence":{"launch":launch,"digest":"a".repeat(64),"source":"startup","queryGeneration":generation}}
            }).to_string()
            };
            sender.send(init(PARENT, &parent_launch, 1)).unwrap();
            drain_native_bridge(&sender, &mut event_rx).await;
            assert!(identity.lock().unwrap().evidence.is_some());
            let next = identity.lock().unwrap().begin(true).unwrap().unwrap();
            assert_eq!(
                next.requested_native_session_id, None,
                "next launch is intent, not native proof"
            );
            sender.send(init(CHILD, &parent_launch, 1)).unwrap();
            for field in [
                "incarnationId",
                "launchNonce",
                "evidenceRevision",
                "executionGeneration",
            ] {
                let mut stale = json!(next);
                stale[field] = if field.ends_with("Id") || field.ends_with("Nonce") {
                    json!("stale")
                } else {
                    json!(0)
                };
                let stale: NativeIdentityLaunch = serde_json::from_value(stale).unwrap();
                sender.send(init(CHILD, &stale, 1)).unwrap();
            }
            sender.send(init(WRONG, &next, 1)).unwrap();
            if arrival != "delayed" {
                sender.send(init(CHILD, &next, 1)).unwrap();
            }
            if arrival == "replaced-query" {
                sender.send(json!({"type":"freshAgent.event","event":{"type":"freshAgent.session.loading",
                    "nativeBinding":{"launch":next,"queryGeneration":2}}}).to_string()).unwrap();
            }
            drain_native_bridge(&sender, &mut event_rx).await;
            assert!(
                transport.current_native_id().await.is_err(),
                "{arrival}: unsettled reads cannot reuse the startup parent's watch value"
            );
            {
                let mut state = identity.lock().unwrap();
                assert!(
                    state.evidence.is_none(),
                    "early child proof cannot authorize input before native ACK"
                );
                assert_eq!(state.root.as_deref(), Some(PARENT));
                state.acknowledge(CHILD, None).unwrap();
                assert_eq!(
                    state.evidence.is_some(),
                    arrival == "early",
                    "{arrival}: only this query's acknowledged child may publish"
                );
                assert_eq!(
                    state
                        .launch
                        .as_ref()
                        .unwrap()
                        .requested_native_session_id
                        .as_deref(),
                    Some(CHILD)
                );
                assert_eq!(state.launch.as_ref().unwrap().evidence_revision, 8);
            }
            assert_eq!(
                transport.current_native_id().await.ok().as_deref(),
                (arrival == "early").then_some(CHILD),
                "{arrival}: buffered current proof must serve the acknowledged child; absent proof remains fenced"
            );
            let generation = if arrival == "replaced-query" { 2 } else { 1 };
            sender.send(init(PARENT, &next, generation + 10)).unwrap();
            sender
                .send(init(CHILD, &parent_launch, generation + 10))
                .unwrap();
            sender.send(init(CHILD, &next, generation)).unwrap();
            drain_native_bridge(&sender, &mut event_rx).await;
            assert_eq!(transport.current_native_id().await.unwrap(), CHILD);
            let state = identity.lock().unwrap();
            let evidence = state
                .evidence
                .as_ref()
                .expect("current delayed native proof");
            assert_eq!(evidence["nativeSessionId"], CHILD);
            assert_eq!(evidence["queryGeneration"], generation);
            assert_eq!(evidence["launch"], json!(state.launch));
        }
    }

    #[tokio::test]
    async fn rejected_rollback_never_restores_changed_query_launch_or_stop() {
        use freshell_runtime_protocol::NativeIdentityLaunch;
        const PARENT: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        const CHILD: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        for case in [
            "unchanged",
            "loading-parent",
            "replaced-parent",
            "loading-child",
            "child-proof",
            "changed-launch",
            "wrong-operation",
            "unobserved",
            "generic-error",
            "timeout",
            "stop",
        ] {
            let (sender, receiver) = broadcast::channel(32);
            let (created, _) = watch::channel(None);
            let (native, native_rx) = watch::channel(None);
            let (native_evidence, _evidence_rx) = watch::channel(None);
            let (events, mut event_rx) = mpsc::channel(32);
            let (send_outcomes, _) = broadcast::channel(16);
            let (kill_outcomes, _) = broadcast::channel(16);
            let mut transport = HostedTransport::new(FreshProvider::Claude).await;
            let identity = Arc::new(std::sync::Mutex::new(HostedNativeIdentity::default()));
            let owned = Arc::get_mut(&mut transport).unwrap();
            owned.native_identity = identity.clone();
            owned.native_rx = Mutex::new(native_rx);
            *owned.session_id.lock().await = Some(PARENT.into());
            let _bridge = spawn_broadcast_bridge(
                FreshProvider::Claude,
                receiver,
                BroadcastBridgeOutputs {
                    owned_session: None,
                    retained_codex: None,
                    created,
                    native,
                    native_evidence,
                    native_identity: identity.clone(),
                    events,
                    send_outcomes,
                    kill_outcomes,
                    suppressed_kills: Arc::new(std::sync::Mutex::new(HashSet::new())),
                    refusal_observer: None,
                },
            );
            let launch: NativeIdentityLaunch = serde_json::from_value(json!({
                "incarnationId":"rejection-incarnation","launchNonce":"rejection-nonce",
                "evidenceRevision":7,"executionGeneration":3,"requestedNativeSessionId":PARENT
            }))
            .unwrap();
            {
                let mut identity = identity.lock().unwrap();
                identity.launch = Some(launch.clone());
                identity.producer_launch = Some(launch.clone());
            }
            let init = |root: &str, launch: &NativeIdentityLaunch, generation: u64| {
                json!({
                "type":"freshAgent.event","event":{"type":"freshAgent.session.init", "cliSessionId":root,
                "nativeIdentityEvidence":{"launch":launch,"digest":"a".repeat(64),"queryGeneration":generation}}
            }).to_string()
            };
            sender.send(init(PARENT, &launch, 3)).unwrap();
            drain_native_bridge(&sender, &mut event_rx).await;
            let prior = transport.native_identity_evidence().await.unwrap();
            if case == "unobserved" {
                identity.lock().unwrap().evidence = None;
            }
            let mut next = identity.lock().unwrap().begin(true).unwrap();
            // Exercise the launch reset even if this operation receives no
            // native lifecycle event before its correlated refusal.
            drain_native_bridge(&sender, &mut event_rx).await;
            match case {
                "loading-parent" | "loading-child" => {
                    let (binding, generation) = if case == "loading-parent" {
                        (&launch, 4)
                    } else {
                        (next.as_ref().unwrap(), 1)
                    };
                    sender.send(json!({"type":"freshAgent.event","event":{"type":"freshAgent.session.loading",
                        "nativeBinding":{"launch":binding,"queryGeneration":generation}}}).to_string()).unwrap();
                }
                "replaced-parent" => {
                    sender.send(init(PARENT, &launch, 4)).unwrap();
                }
                "child-proof" => {
                    sender.send(init(CHILD, next.as_ref().unwrap(), 1)).unwrap();
                }
                "changed-launch" => {
                    identity
                        .lock()
                        .unwrap()
                        .launch
                        .as_mut()
                        .unwrap()
                        .execution_generation += 1;
                }
                "wrong-operation" => {
                    next.as_mut().unwrap().evidence_revision += 1;
                }
                "stop" => {
                    transport.clone().stop().await.unwrap();
                }
                _ => {}
            }
            drain_native_bridge(&sender, &mut event_rx).await;
            let code = match case {
                "generic-error" => "INTERNAL_ERROR",
                "timeout" => "BUSY_TURN",
                _ => "INVALID_ROLLBACK_TARGET",
            };
            let restored = identity.lock().unwrap().reject_before_native_transition(
                PARENT,
                &next,
                code,
                &FreshProvider::Claude,
            );
            assert_eq!(restored, case == "unchanged", "{case}");
            if restored {
                sender.send(init(PARENT, &launch, 2)).unwrap();
                drain_native_bridge(&sender, &mut event_rx).await;
                assert_eq!(
                    transport.native_identity_evidence().await,
                    Some(prior),
                    "previous-query proof must stay stale after rejection"
                );
                assert_eq!(transport.current_native_id().await.unwrap(), PARENT);
            } else {
                assert!(
                    transport.native_identity_evidence().await.is_none(),
                    "{case}"
                );
                assert!(transport.current_native_id().await.is_err(), "{case}");
                assert!(
                    identity.lock().unwrap().begin(true).is_err(),
                    "{case}: an unsettled operation cannot dispatch another query"
                );
            }
        }
    }

    #[tokio::test]
    async fn hosted_claude_rejected_rollback_preserves_current_parent_and_followup() {
        let _lock = NATIVE_PROVIDER_FIXTURE_LOCK.lock().await;
        let keys = [
            "HOME",
            "CLAUDE_HOME",
            "CLAUDE_CONFIG_DIR",
            "FRESHELL_CLAUDE_SIDECAR",
            "FRESHELL_CLAUDE_SDK_QUERY_MODULE",
            "FRESHELL_NATIVE_IDENTITY_LAUNCH",
            "FRESHELL_PROVIDER_RUN_AS_UID",
            "FRESHELL_PROVIDER_RUN_AS_GID",
            "FRESHELL_SIDECAR_TEST_CHECKPOINT",
            "FRESHELL_SIDECAR_TEST_NATIVE_EXIT_DELAY",
        ];
        let _restore = SnapshotProviderEnv(
            keys.iter()
                .map(|key| (*key, std::env::var_os(key)))
                .collect(),
        );
        for key in keys {
            std::env::remove_var(key);
        }
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        const PARENT: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let launch: freshell_runtime_protocol::NativeIdentityLaunch =
            serde_json::from_value(json!({
                "incarnationId":"rejection-incarnation", "launchNonce":"rejection-nonce",
                "evidenceRevision":7, "executionGeneration":3, "requestedNativeSessionId":PARENT
            }))
            .unwrap();
        for provider in [FreshProvider::Claude, FreshProvider::Kilroy] {
            for followup in ["input", "undo", "retired"] {
                let owned = tempfile::tempdir().unwrap();
                let config = owned.path().join(".claude");
                let project = config.join("projects/-owned");
                std::fs::create_dir_all(&project).unwrap();
                let anchors: Vec<_> = (0..4).map(|_| uuid::Uuid::new_v4().to_string()).collect();
                let content: String = (0..4).map(|i| format!("{}\n", json!({
                    "type":if i % 2 == 0 {"user"} else {"assistant"}, "uuid":anchors[i],
                    "parentUuid":if i == 0 {None} else {Some(&anchors[i-1])}, "sessionId":PARENT,
                    "cwd":project, "message":{"role":if i % 2 == 0 {"user"} else {"assistant"},
                    "content":[{"type":"text","text":format!("controlled turn {i}")}]}
                }))).collect();
                let source = project.join(format!("{PARENT}.jsonl"));
                std::fs::write(&source, &content).unwrap();
                std::env::set_var("HOME", owned.path());
                std::env::set_var("CLAUDE_HOME", &config);
                std::env::set_var("CLAUDE_CONFIG_DIR", &config);
                std::env::set_var(
                    "FRESHELL_CLAUDE_SIDECAR",
                    repo.join("crates/freshell-claude-sidecar/index.mjs"),
                );
                let query_module = owned.path().join("query.mjs");
                let input_receipt = owned.path().join("input-received");
                let query_receipt = owned.path().join("queries.jsonl");
                let unavailable = owned.path().join("query-unavailable");
                std::fs::write(&query_module, format!(
                    "import {{ appendFile }} from 'node:fs/promises';\nimport {{ appendFileSync, existsSync }} from 'node:fs';\nimport {{ query as controlledQuery }} from {};\nexport function query(args) {{ const options = {{...args.options, sessionId:args.options.sessionId ?? args.options.resume}}; appendFileSync({}, JSON.stringify({{nativeSessionId:options.sessionId,pid:process.pid}}) + '\\n'); if (existsSync({})) throw new Error('owned replacement query unavailable'); const prompt = (async function* () {{ for await (const message of args.prompt) {{ await appendFile({}, options.sessionId + '\\n'); yield message; }} }})(); return controlledQuery({{...args, prompt, options}}) }}\n",
                    json!(repo.join("test/unit/claude-sidecar/fixtures/native-startup-query.mjs")), json!(query_receipt), json!(unavailable), json!(input_receipt))).unwrap();
                std::env::set_var("FRESHELL_CLAUDE_SDK_QUERY_MODULE", &query_module);
                std::env::set_var("FRESHELL_NATIVE_IDENTITY_LAUNCH", json!(launch).to_string());
                if followup == "input" {
                    std::env::remove_var("FRESHELL_SIDECAR_TEST_CHECKPOINT");
                    std::env::remove_var("FRESHELL_SIDECAR_TEST_NATIVE_EXIT_DELAY");
                } else {
                    // The managed fork requires an observed native child exit.
                    // This existing fixture owns a controlled no-model child.
                    std::env::set_var("FRESHELL_SIDECAR_TEST_CHECKPOINT", "1");
                    std::env::set_var("FRESHELL_SIDECAR_TEST_NATIVE_EXIT_DELAY", "1");
                }
                let transport = HostedTransport::new(provider.clone()).await;
                {
                    let mut identity = transport.native_identity.lock().unwrap();
                    identity.launch = Some(launch.clone());
                    identity.producer_launch = Some(launch.clone());
                }
                let mut profile = parity_profile(FreshProvider::Claude);
                profile.provider = provider.clone();
                if provider == FreshProvider::Kilroy {
                    profile.runtime_variant = "kilroy".into();
                }
                profile.cwd = project.to_string_lossy().into();
                profile.native_session_id = Some(PARENT.into());
                profile.session_ref = None;
                profile.provider_launch_context = None;
                profile.provider_secret_references.clear();
                profile.plugins = None;
                let result: Result<(), String> = async {
                    let actor = FreshAgentHostActor::open(owned.path().join("actor"), profile, transport.clone())
                        .await.map_err(|error| error.to_string())?;
                    let before = crate::fresh_native_observation(&launch, &actor).await.ok_or("initial parent observation missing")?;
                    let proof = actor.observed_native_identity_evidence().await.ok_or("initial proof missing")?;
                    let snapshot = actor.snapshot().await.map_err(|error| error.to_string())?;
                    if snapshot["capabilities"]["undo"] != true { return Err("setup must support Undo".into()); }
                    for (index, turn_id) in [None, Some("stale-turn-id".into())].into_iter().enumerate() {
                        let rejected = actor.semantic_operation(RequestId::parse(format!("invalid-target-{index}")).unwrap(),
                            FreshAgentOperation::Rollback { direction:FreshAgentRollbackDirection::Undo,
                                mode:FreshAgentRollbackMode::ToTurn, turn_id, cwd:None }).await;
                        if !matches!(rejected, Err(freshell_agent_runtime::host_actor::ActorError::Transport(_))) {
                            return Err(format!("target must be rejected by the actual handler: {rejected:?}"));
                        }
                        if !transport.provider_session_is_live(PARENT).await { return Err("rejected target retired the parent".into()); }
                        let after = crate::fresh_native_observation(&launch, &actor).await
                            .ok_or("rejected rollback erased unchanged parent's host observation")?;
                        if before != after || actor.observed_native_identity_evidence().await != Some(proof.clone()) {
                            return Err("rejected rollback changed parent/query proof".into());
                        }
                        actor.snapshot().await.map_err(|error| error.to_string())?;
                        let capture = actor.capture(4096).await.map_err(|error| error.to_string())?;
                        if capture.native_session_id != PARENT || !capture.text.contains("controlled turn 0") {
                            return Err("rejected rollback broke parent capture".into());
                        }
                    }
                    let redo = transport.dispatch_operation(&RequestId::parse("redo-unavailable").unwrap(),
                        &FreshAgentOperation::Rollback { direction:FreshAgentRollbackDirection::Redo,
                            mode:FreshAgentRollbackMode::Step, turn_id:None, cwd:None }).await;
                    if !matches!(redo, Err(OperationFailure { acceptance_ambiguous:false, .. }))
                        || crate::fresh_native_observation(&launch, &actor).await != Some(before.clone()) {
                        return Err("unavailable Redo did not preserve the current parent".into());
                    }
                    if followup == "input" {
                        let inputs_before = std::fs::read_to_string(&input_receipt).unwrap_or_default();
                        actor.dispatch(RequestId::parse("parent-input-after-refusal").unwrap(), "controlled input".into(), None)
                            .await.map_err(|error| error.to_string())?;
                        let inputs_after = tokio::time::timeout(Duration::from_secs(3), async {
                            loop {
                                let receipt = std::fs::read_to_string(&input_receipt).unwrap_or_default();
                                if receipt.len() > inputs_before.len() { break receipt; }
                                tokio::time::sleep(Duration::from_millis(10)).await;
                            }
                        }).await.map_err(|_| "parent query did not receive the subsequent input")?;
                        if inputs_after != format!("{inputs_before}{PARENT}\n") {
                            return Err("subsequent input reached another query root".into());
                        }
                        let busy = actor.semantic_operation(RequestId::parse("busy-refusal").unwrap(),
                            FreshAgentOperation::Rollback { direction:FreshAgentRollbackDirection::Undo,
                                mode:FreshAgentRollbackMode::Step, turn_id:None, cwd:None }).await;
                        if !matches!(busy, Err(freshell_agent_runtime::host_actor::ActorError::AmbiguousDispatch)) {
                            return Err(format!("busy native query must refuse rollback: {busy:?}"));
                        }
                        if crate::fresh_native_observation(&launch, &actor).await.is_some() {
                            return Err("ambiguous busy/timeout refusal restored parent proof".into());
                        }
                    } else {
                        let undo = actor.semantic_operation(RequestId::parse("valid-undo-after-refusal").unwrap(),
                            FreshAgentOperation::Rollback { direction:FreshAgentRollbackDirection::Undo,
                                mode:FreshAgentRollbackMode::Step, turn_id:None, cwd:None }).await;
                        if let Err(error) = undo {
                            tokio::time::timeout(Duration::from_secs(1), async {
                                loop {
                                    if actor.read_events(0, 256).await.events.iter().any(|entry| matches!(&entry.event,
                                        AgentEvent::Provider {payload} if payload["event"]["requestId"] == "valid-undo-after-refusal")) { break; }
                                    tokio::task::yield_now().await;
                                }
                            }).await.ok();
                            let detail: Vec<_> = actor.read_events(0, 256).await.events.iter().filter_map(|entry|
                                match &entry.event { AgentEvent::Provider {payload} if find_operation_error_code(payload).is_some() => Some(payload.clone()), _ => None }).collect();
                            return Err(format!("subsequent legitimate Undo failed: {error}; {detail:?}"));
                        }
                        let child = actor.profile().await.native_session_id.ok_or("missing child")?;
                        if child == PARENT { return Err("legitimate Undo did not change root".into()); }
                        let mut child_launch = launch.clone();
                        child_launch.evidence_revision += 1;
                        child_launch.requested_native_session_id = Some(child.clone());
                        tokio::time::timeout(Duration::from_secs(3), async {
                            while crate::fresh_native_observation(&child_launch, &actor).await.is_none() {
                                tokio::time::sleep(Duration::from_millis(10)).await;
                            }
                        }).await.map_err(|_| "subsequent child proof missing")?;
                        if followup == "retired" {
                            let queries: Vec<Value> = std::fs::read_to_string(&query_receipt)
                                .map_err(|error| error.to_string())?.lines()
                                .map(|line| serde_json::from_str(line).unwrap()).collect();
                            let child_pid = queries.iter().rev()
                                .find(|query| query["nativeSessionId"] == child)
                                .and_then(|query| query["pid"].as_i64())
                                .ok_or("owned child process was not recorded")? as i32;
                            let parent_pid = queries.iter()
                                .find(|query| query["nativeSessionId"] == PARENT)
                                .and_then(|query| query["pid"].as_i64())
                                .ok_or("owned parent process was not recorded")? as i32;
                            // The pane's former id deliberately aliases its
                            // replacement. Actual writer retirement is the old
                            // recorded process being reaped, not that alias
                            // ceasing to resolve the live child.
                            if child_pid == parent_pid || unsafe { libc::kill(parent_pid, 0) } == 0 {
                                return Err("successful Undo must reap its original writer".into());
                            }
                            // The child is proven current and the parent is
                            // already retired. Fail only that owned runtime,
                            // then make any attempted exact recovery refuse
                            // before it can consume a new input.
                            std::fs::write(&unavailable, "").map_err(|error| error.to_string())?;
                            if unsafe { libc::kill(child_pid, libc::SIGKILL) } != 0 {
                                return Err("could not fail the exact owned child".into());
                            }
                            tokio::time::timeout(Duration::from_secs(3), async {
                                while transport.provider_session_is_live(&child).await {
                                    tokio::time::sleep(Duration::from_millis(10)).await;
                                }
                            }).await.map_err(|_| "owned child failure was not observed")?;
                            let old_parent_live = transport.provider_session_is_live(PARENT).await;
                            let current_proof = crate::fresh_native_observation(&child_launch, &actor).await.is_some();
                            let captured_root = actor.capture(4096).await.ok().map(|capture| capture.native_session_id);
                            let accepted_input = actor.dispatch(RequestId::parse("retired-parent-input").unwrap(), "must not run".into(), None).await.is_ok();
                            if old_parent_live || current_proof
                                || captured_root.as_deref().is_some_and(|root| root != child)
                                || accepted_input || transport.provider_session_is_live(PARENT).await {
                                return Err(format!("post-retirement failure revived the old parent: parent_live={old_parent_live}, proof={current_proof}, capture_root={captured_root:?}, input_accepted={accepted_input}"));
                            }
                            if !std::fs::read_to_string(&input_receipt).unwrap_or_default().is_empty()
                                || std::fs::read_to_string(&source).map_err(|error| error.to_string())? != content {
                                return Err("post-retirement failure replayed input or changed native history".into());
                            }
                            return Ok(());
                        }
                        if actor.capture(4096).await.map_err(|error| error.to_string())?.native_session_id != child {
                            return Err("subsequent legitimate child capture broke".into());
                        }
                        let child_before = crate::fresh_native_observation(&child_launch, &actor).await;
                        let invalid_child = actor.semantic_operation(RequestId::parse("child-invalid-target").unwrap(),
                            FreshAgentOperation::Rollback { direction:FreshAgentRollbackDirection::Undo,
                                mode:FreshAgentRollbackMode::ToTurn, turn_id:Some("stale-child-turn".into()), cwd:None }).await;
                        if !matches!(invalid_child, Err(freshell_agent_runtime::host_actor::ActorError::Transport(_)))
                            || crate::fresh_native_observation(&child_launch, &actor).await != child_before
                            || actor.capture(4096).await.map_err(|error| error.to_string())?.native_session_id != child {
                            return Err("rejected child operation lost its settled producer or parent-backed capture".into());
                        }
                    }
                    if std::fs::read_to_string(&source).map_err(|error| error.to_string())? != content {
                        return Err("controlled parent history changed".into());
                    }
                    Ok(())
                }.await;
                // Join the owned sidecar even on the expected product RED.
                transport.clone().stop().await.unwrap();
                assert!(!transport.is_live().await);
                result.unwrap();
            }
        }
    }

    #[tokio::test]
    async fn rejected_non_claude_rollback_never_restores_changed_proof_or_stop() {
        for provider in [FreshProvider::Codex, FreshProvider::Opencode] {
            for case in [
                "unchanged",
                "late-parent-proof",
                "child-proof",
                "changed-launch",
                "wrong-operation",
                "unobserved",
                "generic-error",
                "timeout",
                "stop",
            ] {
                let (sender, receiver) = broadcast::channel(32);
                let (created, _) = watch::channel(None);
                let (native, native_rx) = watch::channel(None);
                let (native_evidence, _) = watch::channel(None);
                let (events, mut event_rx) = mpsc::channel(32);
                let (send_outcomes, _) = broadcast::channel(16);
                let (kill_outcomes, _) = broadcast::channel(16);
                let mut transport = HostedTransport::new(provider.clone()).await;
                let identity = Arc::new(std::sync::Mutex::new(HostedNativeIdentity::default()));
                let owned = Arc::get_mut(&mut transport).unwrap();
                owned.native_identity = identity.clone();
                owned.native_rx = Mutex::new(native_rx);
                *owned.session_id.lock().await = Some("current-root".into());
                let _bridge = spawn_broadcast_bridge(
                    provider.clone(),
                    receiver,
                    BroadcastBridgeOutputs {
                        owned_session: None,
                        retained_codex: None,
                        created,
                        native,
                        native_evidence,
                        native_identity: identity.clone(),
                        events,
                        send_outcomes,
                        kill_outcomes,
                        suppressed_kills: Arc::new(std::sync::Mutex::new(HashSet::new())),
                        refusal_observer: None,
                    },
                );
                let launch = serde_json::from_value(json!({"incarnationId":"refusal-incarnation",
                    "launchNonce":"refusal-nonce", "evidenceRevision":3, "executionGeneration":2,
                    "requestedNativeSessionId":"current-root"}))
                .unwrap();
                {
                    let mut identity = identity.lock().unwrap();
                    identity.launch = Some(launch);
                    identity.producer_launch = identity.launch.clone();
                }
                let materialized = |root: &str| {
                    json!({"type":"freshAgent.session.materialized", "sessionId":root}).to_string()
                };
                sender.send(materialized("current-root")).unwrap();
                drain_native_bridge(&sender, &mut event_rx).await;
                let prior = transport.native_identity_evidence().await.unwrap();
                if case == "unobserved" {
                    identity.lock().unwrap().evidence = None;
                }
                let mut next = identity.lock().unwrap().begin(false).unwrap();
                match case {
                    "late-parent-proof" => {
                        sender.send(materialized("current-root")).unwrap();
                    }
                    "child-proof" => {
                        sender.send(materialized("other-root")).unwrap();
                    }
                    "changed-launch" => {
                        identity
                            .lock()
                            .unwrap()
                            .launch
                            .as_mut()
                            .unwrap()
                            .execution_generation += 1;
                    }
                    "wrong-operation" => {
                        next.as_mut().unwrap().evidence_revision += 1;
                    }
                    "stop" => {
                        transport.clone().stop().await.unwrap();
                    }
                    _ => {}
                }
                drain_native_bridge(&sender, &mut event_rx).await;
                let code = match case {
                    "generic-error" => "INTERNAL_ERROR",
                    "timeout" => "BUSY_TURN",
                    _ => "INVALID_ROLLBACK_TARGET",
                };
                let restored = identity.lock().unwrap().reject_before_native_transition(
                    "current-root",
                    &next,
                    code,
                    &provider,
                );
                assert_eq!(restored, case == "unchanged", "{provider:?} {case}");
                if restored {
                    assert_eq!(transport.native_identity_evidence().await, Some(prior));
                    assert_eq!(transport.current_native_id().await.unwrap(), "current-root");
                } else {
                    assert!(
                        transport.native_identity_evidence().await.is_none(),
                        "{provider:?} {case}"
                    );
                    assert!(
                        transport.current_native_id().await.is_err(),
                        "{provider:?} {case}"
                    );
                    assert!(
                        identity.lock().unwrap().begin(false).is_err(),
                        "{provider:?} {case}"
                    );
                }
                transport.stop().await.unwrap();
            }
        }
    }

    async fn send_controlled_native_turn(
        actor: &FreshAgentHostActor,
        request: &str,
    ) -> Result<(), String> {
        let completed = |events: freshell_runtime_protocol::AgentEventBatch| {
            events
                .events
                .iter()
                .filter(|entry| {
                    matches!(&entry.event,
                AgentEvent::Provider { payload }
                    if payload["event"]["type"] == "freshAgent.turn.complete")
                })
                .count()
        };
        let before = completed(actor.read_events(0, 256).await);
        actor
            .dispatch(RequestId::parse(request).unwrap(), request.into(), None)
            .await
            .map_err(|error| error.to_string())?;
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if completed(actor.read_events(0, 256).await) > before {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .map_err(|_| "controlled native turn did not finish".to_string())
    }

    fn rollback_to(turn_id: Option<String>) -> FreshAgentOperation {
        FreshAgentOperation::Rollback {
            direction: FreshAgentRollbackDirection::Undo,
            mode: FreshAgentRollbackMode::ToTurn,
            turn_id,
            cwd: None,
        }
    }

    async fn exercise_non_claude_rejected_rollback(provider: FreshProvider, case: &str) {
        let _lock = NATIVE_PROVIDER_FIXTURE_LOCK.lock().await;
        let owned = crate::tests::executable_fixture();
        let keys = [
            "HOME",
            "XDG_DATA_HOME",
            "CODEX_HOME",
            "CODEX_CMD",
            "OPENCODE_CMD",
            "OPENCODE_DB",
            "FAKE_CODEX_APP_SERVER_BEHAVIOR",
            "FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES",
            "FAKE_OPENCODE_AUDIT_LOG",
            "FAKE_OPENCODE_SNAPSHOT_READ_FAILURE_MARKER",
            "FAKE_OPENCODE_SELF_EXIT_MARKER",
            "FAKE_OPENCODE_HANG_SESSION_CREATE",
            "FAKE_OPENCODE_PROMPT_ERROR",
            "FAKE_OPENCODE_TOOL_ERROR",
            "FAKE_OPENCODE_TUI_PARITY",
            "FAKE_OPENCODE_BUSY_AT_LAUNCH",
            "FAKE_OPENCODE_REQUIRE_DIRECTORY_ROUTE",
            "FAKE_OPENCODE_PROJECT_CWD",
            "FRESHELL_NATIVE_IDENTITY_LAUNCH",
        ];
        let _restore = SnapshotProviderEnv(
            keys.iter()
                .map(|key| (*key, std::env::var_os(key)))
                .collect(),
        );
        for key in keys {
            std::env::remove_var(key);
        }
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let native_log = owned.path().join("native-operations.jsonl");
        let failed_read = owned.path().join("fail-native-read");
        let process_log = owned.path().join("native-processes.jsonl");
        std::env::set_var("HOME", owned.path());
        std::env::set_var("XDG_DATA_HOME", owned.path().join("data"));
        std::env::set_var("CODEX_HOME", owned.path().join(".codex"));
        std::env::set_var(
            "CODEX_CMD",
            format!(
                "node {}",
                repo.join("test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs")
                    .display()
            ),
        );
        std::env::set_var("FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES", "1");
        std::env::set_var(
            "FAKE_CODEX_APP_SERVER_BEHAVIOR",
            json!({
                "recordTurns":true, "appendThreadOperationLogPath":native_log,
                "exitProcessAfterMethodsOnce":["thread/name/set"]
            })
            .to_string(),
        );
        std::env::set_var(
            "OPENCODE_CMD",
            repo.join("test/e2e-browser/fixtures/fake-opencode.cjs"),
        );
        std::env::set_var("FAKE_OPENCODE_AUDIT_LOG", &native_log);
        std::env::set_var("FAKE_OPENCODE_SNAPSHOT_READ_FAILURE_MARKER", &failed_read);
        {
            // Fault exactly AFTER the controlled provider applied its mutation,
            // before Codex's RPC reply or OpenCode's post-verify read. The real
            // native handlers must classify this as ambiguous, never cancelled.
            let fault = owned.path().join("after-native-mutation.cjs");
            std::fs::write(&fault, format!(
                "const fs = require('node:fs'); const append = fs.appendFileSync;\nappend({}, JSON.stringify({{pid:process.pid}}) + '\\n');\nfs.appendFileSync = function(file, bytes, ...args) {{ const result = append.call(this, file, bytes, ...args); if ({} && String(file) === {}) {{ const row = JSON.parse(String(bytes)); if (row.method === 'thread/revert') process.exit(0); if (row.event === 'reverted') fs.writeFileSync({}, 'fail post-verify read'); }} return result; }};\n",
                json!(process_log), case == "post-mutation-failure", json!(native_log), json!(failed_read))).unwrap();
            let script = match provider {
                FreshProvider::Codex => {
                    repo.join("test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs")
                }
                FreshProvider::Opencode => repo.join("test/e2e-browser/fixtures/fake-opencode.cjs"),
                _ => unreachable!(),
            };
            if provider == FreshProvider::Codex {
                std::env::set_var(
                    "CODEX_CMD",
                    format!("node --require {} {}", fault.display(), script.display()),
                );
            } else {
                let wrapper = owned.path().join("opencode-fault.cjs");
                std::fs::write(
                    &wrapper,
                    format!(
                        "#!/usr/bin/env node\nrequire({}); require({});\n",
                        json!(fault),
                        json!(script)
                    ),
                )
                .unwrap();
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o700))
                        .unwrap();
                }
                std::env::set_var("OPENCODE_CMD", wrapper);
            }
        }
        let launch: freshell_runtime_protocol::NativeIdentityLaunch =
            serde_json::from_value(json!({
                "incarnationId":"all-provider-refusal", "launchNonce":"all-provider-refusal-nonce",
                "evidenceRevision":5, "executionGeneration":2, "requestedNativeSessionId":null
            }))
            .unwrap();
        let transport = HostedTransport::new(provider.clone()).await;
        {
            let mut identity = transport.native_identity.lock().unwrap();
            identity.launch = Some(launch.clone());
            identity.producer_launch = Some(launch.clone());
        }
        let result: Result<(), String> = async {
            let profile = FreshAgentProfile {
                naming_handle: None,
                collaboration_mode: None,
                provider: provider.clone(),
                runtime_variant: format!("fresh{}", provider.as_str()),
                cwd: owned.path().to_string_lossy().into(),
                model: None,
                effort: None,
                permission_mode: None,
                sandbox: None,
                provider_store_id: "owned-refusal-store".into(),
                native_session_id: None,
                plugins: None,
                model_selection: None,
                session_ref: None,
                provider_launch_context: None,
                provider_secret_references: vec![],
            };
            let actor =
                FreshAgentHostActor::open(owned.path().join("actor"), profile, transport.clone())
                    .await
                    .map_err(|error| error.to_string())?;
            send_controlled_native_turn(&actor, "seed-first-turn").await?;
            send_controlled_native_turn(&actor, "seed-second-turn").await?;
            let native = actor
                .profile()
                .await
                .native_session_id
                .ok_or("initial native root missing")?;
            let before = crate::fresh_native_observation(&launch, &actor)
                .await
                .ok_or("initial host proof missing")?;
            let proof = actor
                .observed_native_identity_evidence()
                .await
                .ok_or("initial evidence missing")?;
            // The first verified native read releases completed event buffers.
            // Settle that read before comparing complete snapshots around a
            // refused operation, while proving its transcript stayed exact.
            let first_snapshot = actor.snapshot().await.map_err(|error| error.to_string())?;
            let snapshot = actor.snapshot().await.map_err(|error| error.to_string())?;
            if first_snapshot["turns"] != snapshot["turns"] {
                return Err(format!(
                    "settling native history changed turn bodies: {}",
                    json!({"before":first_snapshot["turns"],"after":snapshot["turns"]})
                ));
            }
            if snapshot["capabilities"]["undo"] != true {
                return Err("controlled live conversation must support Undo".into());
            }
            if case != "unchanged" {
                let original_incarnation = transport
                    .provider_session_incarnation(&native)
                    .await
                    .ok_or("live native incarnation missing")?;
                match case {
                    "dead-runtime" => match &transport.state {
                        ProviderState::Codex(state) => state.shutdown().await,
                        ProviderState::Opencode { owner, .. } => owner.shutdown().await,
                        _ => unreachable!(),
                    },
                    "recovered-runtime" => match &transport.state {
                        ProviderState::Codex(state) => {
                            let home = owned.path().join(".codex").to_string_lossy().into_owned();
                            let client = state
                                .management_client_for_root(&home)
                                .await
                                .ok_or("missing live app-server client")?;
                            client
                                .set_thread_name(&native, "owned-runtime-recovery")
                                .await
                                .map_err(|error| error.to_string())?;
                            tokio::time::timeout(Duration::from_secs(5), async {
                                while state.has_live_session(&native).await {
                                    tokio::time::sleep(Duration::from_millis(10)).await;
                                }
                            })
                            .await
                            .map_err(|_| "controlled native exit was not observed")?;
                            if state.live_session_incarnation(&native).await.is_some() {
                                return Err(
                                    "exited native client retained a live incarnation".into()
                                );
                            }
                            // The actual rollback handler's ensure-alive will now
                            // resume the SAME root in a different app-server.
                        }
                        _ => unreachable!(),
                    },
                    "replaced-runtime" => match &transport.state {
                        ProviderState::Codex(state) => {
                            state.shutdown().await;
                            state
                                .handle_create(
                                    create_request_for_profile(&actor.profile().await),
                                    None,
                                )
                                .await;
                        }
                        ProviderState::Opencode { owner, runtime } => {
                            owner.shutdown().await;
                            let profile = actor.profile().await;
                            runtime
                                .prepare_managed_native_session(create_request_for_profile(
                                    &profile,
                                ))
                                .await?;
                        }
                        _ => unreachable!(),
                    },
                    "post-mutation-failure" => {}
                    _ => unreachable!(),
                }
                let operation = if case == "post-mutation-failure" {
                    FreshAgentOperation::Rollback {
                        direction: FreshAgentRollbackDirection::Undo,
                        mode: FreshAgentRollbackMode::Step,
                        turn_id: None,
                        cwd: None,
                    }
                } else if case == "dead-runtime" {
                    // This handler refusal happens before an attempted restart.
                    rollback_to(None)
                } else {
                    rollback_to(Some("msg_missing_after_recovery".into()))
                };
                let direct = matches!(case, "dead-runtime" | "recovered-runtime")
                    || (provider == FreshProvider::Codex && case == "replaced-runtime");
                if direct {
                    // The host cannot admit these after its liveness/observation
                    // check. Exercise the adapter's own race/recovery fence too.
                    let failed = transport
                        .dispatch_operation(
                            &RequestId::parse("fenced-refusal").unwrap(),
                            &operation,
                        )
                        .await;
                    if !matches!(
                        failed,
                        Err(OperationFailure {
                            acceptance_ambiguous: true,
                            ..
                        })
                    ) {
                        return Err(format!(
                            "uncertain or changed runtime must stay fenced: {failed:?}"
                        ));
                    }
                } else {
                    let failed = actor
                        .semantic_operation(RequestId::parse("fenced-refusal").unwrap(), operation)
                        .await;
                    if !matches!(
                        failed,
                        Err(freshell_agent_runtime::host_actor::ActorError::AmbiguousDispatch)
                    ) {
                        return Err(format!(
                            "actor must retain ambiguous native transition: {failed:?}"
                        ));
                    }
                }
                if crate::fresh_native_observation(&launch, &actor)
                    .await
                    .is_some()
                    || actor.snapshot().await.is_ok()
                    || actor.capture(4096).await.is_ok()
                    || (!direct
                        && actor
                            .dispatch(
                                RequestId::parse("must-not-reach-native").unwrap(),
                                "fenced input".into(),
                                None,
                            )
                            .await
                            .is_ok())
                {
                    return Err(
                        "changed runtime or ambiguous mutation revived the old native proof".into(),
                    );
                }
                if matches!(case, "replaced-runtime" | "recovered-runtime") {
                    let current = transport
                        .provider_session_incarnation(&native)
                        .await
                        .ok_or("same-root replacement must actually be live")?;
                    if current == original_incarnation {
                        return Err("test failed to replace the actual native runtime".into());
                    }
                }
                if case == "post-mutation-failure" {
                    let operations: Vec<Value> = std::fs::read_to_string(&native_log)
                        .map_err(|error| error.to_string())?
                        .lines()
                        .map(serde_json::from_str)
                        .collect::<Result<_, _>>()
                        .map_err(|error| error.to_string())?;
                    if operations
                        .iter()
                        .filter(|row| {
                            row["method"] == "thread/revert" || row["event"] == "reverted"
                        })
                        .count()
                        != 1
                    {
                        return Err("fault must follow an actual controlled native mutation".into());
                    }
                    match &transport.state {
                        ProviderState::Codex(_) => {
                            let saved: Value = serde_json::from_slice(
                                &std::fs::read(
                                    owned
                                        .path()
                                        .join(".codex/fake-turns")
                                        .join(format!("{native}.json")),
                                )
                                .map_err(|error| error.to_string())?,
                            )
                            .map_err(|error| error.to_string())?;
                            if saved.as_array().map(Vec::len) != Some(1) {
                                return Err(
                                    "native revert did not actually remove the second turn".into(),
                                );
                            }
                        }
                        ProviderState::Opencode { owner, .. } => {
                            std::fs::remove_file(&failed_read)
                                .map_err(|error| error.to_string())?;
                            let current = owner
                                .get_opencode_snapshot(&native, Some(&actor.profile().await.cwd))
                                .await
                                .map_err(|error| error.to_string())?;
                            if current["turns"].as_array().map(Vec::len)
                                >= snapshot["turns"].as_array().map(Vec::len)
                            {
                                return Err(
                                    "native revert did not actually hide the second turn".into()
                                );
                            }
                        }
                        _ => unreachable!(),
                    }
                }
                return Ok(());
            }
            let mut targets = vec![None, Some("msg_stale_target".into())];
            if provider == FreshProvider::Opencode {
                targets.push(
                    snapshot["turns"]
                        .as_array()
                        .and_then(|turns| turns.iter().find(|turn| turn["role"] == "assistant"))
                        .and_then(|turn| turn["id"].as_str().or_else(|| turn["turnId"].as_str()))
                        .map(str::to_string),
                );
                if targets.last().unwrap().is_none() {
                    return Err("assistant target setup missing".into());
                }
            }
            for (index, target) in targets.into_iter().enumerate() {
                let request = RequestId::parse(format!("rejected-target-{index}")).unwrap();
                let rejected = actor
                    .semantic_operation(request.clone(), rollback_to(target))
                    .await;
                if !matches!(
                    rejected,
                    Err(freshell_agent_runtime::host_actor::ActorError::Transport(_))
                ) {
                    return Err(format!(
                        "actual provider must reject invalid target: {rejected:?}"
                    ));
                }
                if !transport.provider_session_is_live(&native).await {
                    return Err("refused target retired the session".into());
                }
                if crate::fresh_native_observation(&launch, &actor).await != Some(before.clone())
                    || actor.observed_native_identity_evidence().await != Some(proof.clone())
                {
                    return Err("rejected rollback erased unchanged native host observation".into());
                }
                let after = actor.snapshot().await.map_err(|error| error.to_string())?;
                if after != snapshot {
                    return Err(format!(
                        "rejected rollback changed native snapshot: {}",
                        json!({"before":snapshot,"after":after})
                    ));
                }
                let capture = actor
                    .capture(4096)
                    .await
                    .map_err(|error| error.to_string())?;
                if capture.native_session_id != native || !capture.text.contains("seed-first-turn")
                {
                    return Err("rejected rollback broke current session capture".into());
                }
            }
            if provider == FreshProvider::Opencode {
                let unavailable = transport
                    .dispatch_operation(
                        &RequestId::parse("redo-without-history").unwrap(),
                        &FreshAgentOperation::Rollback {
                            direction: FreshAgentRollbackDirection::Redo,
                            mode: FreshAgentRollbackMode::Step,
                            turn_id: None,
                            cwd: None,
                        },
                    )
                    .await;
                if !matches!(
                    unavailable,
                    Err(OperationFailure {
                        acceptance_ambiguous: false,
                        ..
                    })
                ) || crate::fresh_native_observation(&launch, &actor).await != Some(before)
                {
                    return Err(
                        "pre-mutation unavailable Redo must preserve current OpenCode proof".into(),
                    );
                }
            }
            send_controlled_native_turn(&actor, "input-after-refusal").await?;
            let after_input = actor.snapshot().await.map_err(|error| error.to_string())?;
            if !actor
                .capture(4096)
                .await
                .map_err(|error| error.to_string())?
                .text
                .contains("input-after-refusal")
            {
                return Err("subsequent input did not reach the actual native handler".into());
            }
            let undo = FreshAgentOperation::Rollback {
                direction: FreshAgentRollbackDirection::Undo,
                mode: FreshAgentRollbackMode::Step,
                turn_id: None,
                cwd: None,
            };
            actor
                .semantic_operation(
                    RequestId::parse("legitimate-undo-after-refusal").unwrap(),
                    undo,
                )
                .await
                .map_err(|error| format!("later legitimate Undo failed: {error}"))?;
            let after_undo = actor.snapshot().await.map_err(|error| error.to_string())?;
            if after_undo["turns"].as_array().map(Vec::len)
                >= after_input["turns"].as_array().map(Vec::len)
                || actor.profile().await.native_session_id.as_deref() != Some(&native)
                || crate::fresh_native_observation(&launch, &actor)
                    .await
                    .is_none()
            {
                return Err(
                    "legitimate Undo did not retain current native identity and remove its tail"
                        .into(),
                );
            }
            let after_operation_proof = actor.observed_native_identity_evidence().await;
            let refused = actor
                .semantic_operation(
                    RequestId::parse("rejected-after-undo").unwrap(),
                    rollback_to(Some("msg_old_tail".into())),
                )
                .await;
            if !matches!(
                refused,
                Err(freshell_agent_runtime::host_actor::ActorError::Transport(_))
            ) || actor.observed_native_identity_evidence().await != after_operation_proof
                || actor.capture(4096).await.is_err()
            {
                return Err(
                    "refusal after native rollback acknowledgement lost current proof".into(),
                );
            }
            let operations: Vec<Value> = std::fs::read_to_string(&native_log)
                .map_err(|error| error.to_string())?
                .lines()
                .map(serde_json::from_str)
                .collect::<Result<_, _>>()
                .map_err(|error| error.to_string())?;
            if operations
                .iter()
                .filter(|row| row["method"] == "thread/revert" || row["event"] == "reverted")
                .count()
                != 1
            {
                return Err("rejected targets must not dispatch native history mutation".into());
            }
            Ok(())
        }
        .await;
        transport
            .clone()
            .stop()
            .await
            .expect("join the exact owned native fixture before reporting failure");
        let pids: Vec<u32> = std::fs::read_to_string(&process_log)
            .unwrap_or_default()
            .lines()
            .map(|line| {
                serde_json::from_str::<Value>(line).unwrap()["pid"]
                    .as_u64()
                    .unwrap() as u32
            })
            .collect();
        #[cfg(unix)]
        for pid in &pids {
            tokio::time::timeout(Duration::from_secs(5), async {
                while unsafe { libc::kill(*pid as libc::pid_t, 0) } == 0 {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("the exact recorded controlled native process must be reaped");
        }
        eprintln!(
            "{}",
            json!({"severity":"info", "event":"test.hosted_rollback.native_processes_closed",
            "provider":provider.as_str(), "case":case, "pids":pids})
        );
        result.unwrap();
    }

    #[tokio::test]
    async fn hosted_codex_rejected_rollback_preserves_current_native_session() {
        exercise_non_claude_rejected_rollback(FreshProvider::Codex, "unchanged").await;
    }

    #[tokio::test]
    async fn hosted_opencode_rejected_rollback_preserves_current_native_session() {
        exercise_non_claude_rejected_rollback(FreshProvider::Opencode, "unchanged").await;
    }

    #[tokio::test]
    async fn hosted_codex_rollback_fences_replaced_dead_and_ambiguous_runtime() {
        for case in [
            "replaced-runtime",
            "recovered-runtime",
            "dead-runtime",
            "post-mutation-failure",
        ] {
            exercise_non_claude_rejected_rollback(FreshProvider::Codex, case).await;
        }
    }

    #[tokio::test]
    async fn hosted_opencode_rollback_fences_replaced_dead_and_ambiguous_runtime() {
        for case in ["replaced-runtime", "dead-runtime", "post-mutation-failure"] {
            exercise_non_claude_rejected_rollback(FreshProvider::Opencode, case).await;
        }
    }

    #[tokio::test]
    async fn native_provider_create_failure_keeps_the_existing_typed_diagnostic() {
        let (sender, receiver) = broadcast::channel(16);
        let (created, mut created_rx) = watch::channel(None);
        let (native, _) = watch::channel(None);
        let (native_evidence, _) = watch::channel(None);
        let (events, _events_rx) = mpsc::channel(16);
        let (send_outcomes, _) = broadcast::channel(16);
        let (kill_outcomes, _) = broadcast::channel(16);
        let _bridge = spawn_broadcast_bridge(
            FreshProvider::Claude,
            receiver,
            BroadcastBridgeOutputs {
                owned_session: None,
                retained_codex: None,
                created,
                native,
                native_evidence,
                native_identity: Arc::new(std::sync::Mutex::new(HostedNativeIdentity::default())),
                events,
                send_outcomes,
                kill_outcomes,
                suppressed_kills: Arc::new(std::sync::Mutex::new(HashSet::new())),
                refusal_observer: None,
            },
        );
        sender
            .send(
                json!({"type":"freshAgent.create.failed", "code":"CLAUDE_CREATE_FAILED",
            "message":"current native launch signal is unwritable"})
                .to_string(),
            )
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), created_rx.changed())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::to_value(created_rx.borrow().clone()).unwrap(),
            json!({"Err":"CLAUDE_CREATE_FAILED: current native launch signal is unwritable"})
        );
    }

    #[tokio::test]
    async fn claude_native_worker_exit_ends_host_liveness_without_another_send() {
        let _lock = NATIVE_PROVIDER_FIXTURE_LOCK.lock().await;
        let root = tempfile::tempdir().unwrap();
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let keys = [
            "HOME",
            "CLAUDE_HOME",
            "CLAUDE_CONFIG_DIR",
            "FRESHELL_CLAUDE_SIDECAR",
            "FRESHELL_CLAUDE_SDK_QUERY_MODULE",
        ];
        let _restore = SnapshotProviderEnv(
            keys.iter()
                .map(|key| (*key, std::env::var_os(key)))
                .collect(),
        );
        let module = root.path().join("native-query.mjs");
        // The production bridge consumes a controlled SDK iterator backed by a
        // real native protocol process. Kill only this exact recorded child.
        std::fs::write(&module, r#"
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
export function query({ prompt, options }) {
  const native = options.resume ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const worker = spawn(process.execPath, ['-e', `
    const readline = require('node:readline');
    const native = process.argv[1];
    const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
    emit({type:'system',subtype:'init',session_id:native,tools:[]});
    readline.createInterface({input:process.stdin}).on('line', (line) => {
      if (JSON.parse(line).message.content[0].text === '__end_native_query__') process.exit(0);
      emit({type:'result',subtype:'success',session_id:native,is_error:false});
    });
  `, native], { cwd: options.cwd, signal: options.abortController.signal, stdio: ['pipe', 'pipe', 'pipe'] })
  worker.on('error', () => {})
  appendFileSync(join(options.cwd, 'native-launches.jsonl'), JSON.stringify({pid:worker.pid,bridgePid:process.pid,resume:options.resume ?? null}) + '\n')
  const exit = new Promise(resolve => worker.once('exit', (code, signal) => resolve({code,signal})))
  const lines = createInterface({input:worker.stdout})
  const iterator = (async function* () {
    for await (const line of lines) yield JSON.parse(line)
    const result = await exit
    if (result.signal || result.code) throw new Error('controlled native worker exited')
  })()
  void (async () => {
    for await (const message of prompt) {
      process.stdout.write(JSON.stringify({type:'sdk.session.closed',sessionId:'previous-sidecar-session',queryGeneration:1,reason:'stream_error'}) + '\n')
      appendFileSync(join(options.cwd, 'native-inputs.jsonl'), JSON.stringify({pid:worker.pid}) + '\n')
      if (!worker.stdin.destroyed) worker.stdin.write(JSON.stringify(message) + '\n')
    }
  })()
  return Object.assign(iterator, {
    initializationResult: async () => ({}), supportedCommands: async () => [],
    close: () => worker.kill(), interrupt: async () => {},
  })
}
"#).unwrap();
        for (key, value) in [
            ("HOME", root.path().to_path_buf()),
            ("CLAUDE_HOME", root.path().join(".claude")),
            ("CLAUDE_CONFIG_DIR", root.path().join(".claude")),
            (
                "FRESHELL_CLAUDE_SIDECAR",
                repo.join("crates/freshell-claude-sidecar/index.mjs"),
            ),
            ("FRESHELL_CLAUDE_SDK_QUERY_MODULE", module),
        ] {
            std::env::set_var(key, value);
        }
        let mut profile = parity_profile(FreshProvider::Claude);
        profile.cwd = root.path().to_string_lossy().into();
        profile.native_session_id = Some("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into());
        profile.session_ref = None;
        profile.provider_launch_context = None;
        profile.provider_secret_references.clear();
        profile.plugins = None;
        let transport = HostedTransport::new(FreshProvider::Claude).await;
        let actor_dir = root.path().join("actor");
        let actor = FreshAgentHostActor::open(&actor_dir, profile.clone(), transport.clone())
            .await
            .unwrap();
        assert_eq!(
            actor.profile().await.native_session_id,
            profile.native_session_id
        );
        let host = Arc::new(crate::HostState {
            incarnation_id: freshell_runtime_protocol::IncarnationId::new(),
            host_boot_id: freshell_runtime_protocol::HostBootId::new(),
            state_dir: root.path().to_path_buf(),
            secret: b"owned-lifecycle-test".to_vec(),
            requested_limits: freshell_runtime_protocol::RuntimeLimits {
                cpu_milli: 500,
                memory_bytes: 128 * 1024 * 1024,
                swap_bytes: 0,
                pids_max: 32,
            },
            control_fence: std::sync::Mutex::new(crate::HostControlFence::default()),
            persisted: Mutex::new(crate::PersistedHostState::default()),
            child: Mutex::new(None),
            pty: Mutex::new(None),
            fresh_agent: Mutex::new(Some(actor.clone())),
            fresh_native_command: Mutex::new(()),
            provider_config_paths: crate::ProviderConfigPaths::default(),
            opencode_transfer_mount: root.path().join("transfer"),
            bootstrap_root: root.path().join("bootstrap"),
        });
        let status = || {
            crate::dispatch(
                freshell_runtime_protocol::Envelope {
                    protocol_version: freshell_runtime_protocol::CONTROL_PROTOCOL_VERSION,
                    request_id: RequestId::new(),
                    role: freshell_runtime_protocol::ControlRole::Supervisor,
                    auth: Some(freshell_runtime_protocol::host_proof(
                        &host.secret,
                        "command-auth",
                        &host.host_boot_id,
                        &host.incarnation_id,
                    )),
                    body: freshell_runtime_protocol::HostCommand::Status {
                        incarnation_id: host.incarnation_id.clone(),
                    },
                },
                &host,
            )
        };
        actor
            .dispatch(RequestId::new(), "controlled ordinary turn".into(), None)
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if actor.read_events(0, 64).await.events.iter().any(|entry|
                    matches!(entry.event, AgentEvent::Provider { ref payload } if payload["event"]["type"] == "freshAgent.result")) { break; }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.unwrap();
        assert!(
            matches!(
                status().await.unwrap(),
                freshell_runtime_protocol::HostResult::Status { exited: false, .. }
            ),
            "a completed idle turn must retain the native query"
        );
        let launches = || {
            std::fs::read_to_string(root.path().join("native-launches.jsonl"))
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str::<Value>(line).unwrap())
                .collect::<Vec<_>>()
        };
        let before = launches();
        assert_eq!(before.len(), 1);
        let pid = before[0]["pid"].as_i64().unwrap() as i32;
        assert_eq!(unsafe { libc::kill(pid, libc::SIGKILL) }, 0);
        let detected = tokio::time::timeout(Duration::from_secs(3), async {
            while actor.is_live().await {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .is_ok();
        let crashed_status = status().await.unwrap();
        // A v2 SDK stream end deliberately exits its sidecar after flushing
        // sdk.stream.ended. Observe its complete reap rather than requiring a
        // bridge with no native session to remain running.
        let bridge_reaped = tokio::time::timeout(Duration::from_secs(3), async {
            while unsafe { libc::kill(before[0]["bridgePid"].as_i64().unwrap() as i32, 0) } == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .is_ok();
        let after = launches();
        let input_count = std::fs::read_to_string(root.path().join("native-inputs.jsonl"))
            .unwrap()
            .lines()
            .count();
        host.fresh_agent
            .lock()
            .await
            .take()
            .unwrap()
            .stop()
            .await
            .unwrap();
        drop(actor);
        assert!(
            detected,
            "native SDK worker death must reach host liveness without another send"
        );
        assert!(
            bridge_reaped,
            "an ended SDK stream must reap its now-sessionless Node bridge"
        );
        assert!(
            matches!(
                crashed_status,
                freshell_runtime_protocol::HostResult::Status { exited: true, .. }
            ),
            "the actual host Status contract must reject reattachment to the ended query"
        );
        assert_eq!(
            after, before,
            "death detection must not create a session or replay input"
        );
        assert_eq!(input_count, 1);
        let resumed = HostedTransport::new(FreshProvider::Claude).await;
        let recovered = FreshAgentHostActor::open(&actor_dir, profile.clone(), resumed.clone())
            .await
            .unwrap();
        assert_eq!(
            recovered.profile().await.native_session_id,
            profile.native_session_id
        );
        assert!(recovered.is_live().await);
        assert_eq!(
            launches()[1]["resume"],
            profile.native_session_id.clone().unwrap()
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join("native-inputs.jsonl"))
                .unwrap()
                .lines()
                .count(),
            1,
            "exact native resume does not replay the accepted prompt"
        );
        recovered
            .dispatch(RequestId::new(), "__end_native_query__".into(), None)
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while recovered.is_live().await {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("ordinary native EOF also ends the query lifetime");
        recovered.clone().stop().await.unwrap();
        assert!(
            !recovered.is_live().await,
            "ordinary Stop remains authoritative"
        );
    }

    #[tokio::test]
    async fn hosted_claude_reestablishes_closed_native_query_before_one_original_send() {
        let _lock = NATIVE_PROVIDER_FIXTURE_LOCK.lock().await;
        const NATIVE: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let owned = tempfile::tempdir().unwrap();
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let keys = [
            "HOME",
            "CLAUDE_HOME",
            "CLAUDE_CONFIG_DIR",
            "FRESHELL_CLAUDE_SIDECAR",
            "FRESHELL_CLAUDE_SDK_QUERY_MODULE",
            "FRESHELL_NATIVE_IDENTITY_LAUNCH",
            "FRESHELL_SIDECAR_TEST_CHECKPOINT",
            "FRESHELL_SIDECAR_TEST_NATIVE_EXIT_DELAY",
            "FRESHELL_SIDECAR_TEST_TRANSCRIPT",
            "FRESHELL_SIDECAR_TEST_END_FIRST_QUERY_MARKER",
            "FRESHELL_SIDECAR_TEST_END_QUERY_TRIGGER",
            "FRESHELL_SIDECAR_TEST_NATIVE_INPUT_LOG",
            "FRESHELL_PROVIDER_RUN_AS_UID",
            "FRESHELL_PROVIDER_RUN_AS_GID",
        ];
        let _restore = SnapshotProviderEnv(
            keys.iter()
                .map(|key| (*key, std::env::var_os(key)))
                .collect(),
        );
        for key in keys {
            std::env::remove_var(key);
        }
        let config = owned.path().join(".claude");
        let project = config.join("projects/-owned");
        std::fs::create_dir_all(&project).unwrap();
        let transcript = project.join(format!("{NATIVE}.jsonl"));
        std::fs::write(&transcript, format!("{}\n", json!({"type":"user", "uuid":uuid::Uuid::new_v4().to_string(),
            "sessionId":NATIVE,"cwd":owned.path(),"message":{"role":"user","content":[{"type":"text","text":"retained seed"}]}}))).unwrap();
        let marker = owned.path().join("first-query.jsonl");
        let trigger = owned.path().join("end-first-query");
        let input_log = owned.path().join("native-inputs.jsonl");
        let launch: freshell_runtime_protocol::NativeIdentityLaunch =
            serde_json::from_value(json!({
                "incarnationId":"owned-readiness", "launchNonce":"owned-readiness-nonce",
                "evidenceRevision":2,"executionGeneration":3,"requestedNativeSessionId":NATIVE,
            }))
            .unwrap();
        for (key, value) in [
            ("HOME", owned.path().to_path_buf()),
            ("CLAUDE_HOME", config.clone()),
            ("CLAUDE_CONFIG_DIR", config),
            (
                "FRESHELL_CLAUDE_SIDECAR",
                repo.join("crates/freshell-claude-sidecar/index.mjs"),
            ),
            (
                "FRESHELL_CLAUDE_SDK_QUERY_MODULE",
                repo.join("test/unit/claude-sidecar/fixtures/native-startup-query.mjs"),
            ),
            ("FRESHELL_SIDECAR_TEST_TRANSCRIPT", transcript.clone()),
            (
                "FRESHELL_SIDECAR_TEST_END_FIRST_QUERY_MARKER",
                marker.clone(),
            ),
            ("FRESHELL_SIDECAR_TEST_END_QUERY_TRIGGER", trigger.clone()),
            ("FRESHELL_SIDECAR_TEST_NATIVE_INPUT_LOG", input_log.clone()),
        ] {
            std::env::set_var(key, value);
        }
        std::env::set_var("FRESHELL_NATIVE_IDENTITY_LAUNCH", json!(launch).to_string());
        let mut profile = parity_profile(FreshProvider::Claude);
        profile.cwd = owned.path().to_string_lossy().into();
        profile.native_session_id = Some(NATIVE.into());
        profile.session_ref = None;
        profile.provider_launch_context = None;
        profile.provider_secret_references.clear();
        profile.plugins = None;
        let transport = HostedTransport::new(FreshProvider::Claude).await;
        {
            // This test process is not the managed host bootstrap: install the
            // same private launch binding that production supplies to its bridge.
            let mut identity = transport.native_identity.lock().unwrap();
            identity.launch = Some(launch.clone());
            identity.producer_launch = Some(launch.clone());
        }
        let actor =
            FreshAgentHostActor::open(owned.path().join("actor"), profile, transport.clone())
                .await
                .unwrap();
        let result: Result<(), String> = async {
            tokio::time::timeout(Duration::from_secs(8), async {
                while crate::fresh_native_observation(&launch, &actor)
                    .await
                    .is_none()
                {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .map_err(|_| "initial actual native proof missing")?;
            let before = actor.observed_native_identity_evidence().await.unwrap();
            let refused = actor
                .fork(
                    RequestId::new(),
                    NATIVE.into(),
                    Some(json!({"atTurnId":"missing-native-turn"})),
                )
                .await;
            if !matches!(
                refused,
                Err(freshell_agent_runtime::host_actor::ActorError::Transport(_))
            ) {
                return Err(format!(
                    "an unchanged-parent fork refusal must remain usable: {refused:?}"
                ));
            }
            if actor.observed_native_identity_evidence().await.as_ref() != Some(&before)
                || crate::fresh_native_observation(&launch, &actor)
                    .await
                    .is_none()
            {
                return Err("fork refusal discarded the unchanged parent's native proof".into());
            }

            let retained = std::fs::read(&transcript).map_err(|error|error.to_string())?;
            std::fs::write(&transcript, [0xff]).map_err(|error|error.to_string())?;
            let unreadable = actor.fork(RequestId::new(), NATIVE.into(), None).await;
            std::fs::write(&transcript, retained).map_err(|error|error.to_string())?;
            if !matches!(unreadable, Err(freshell_agent_runtime::host_actor::ActorError::Transport(_)))
                || actor.observed_native_identity_evidence().await.as_ref() != Some(&before) {
                return Err(format!("a pre-child history read failure must preserve the unchanged live parent: {unreadable:?}"));
            }
            let generation = before["queryGeneration"]
                .as_u64()
                .ok_or("initial query generation missing")?;
            std::fs::write(&trigger, b"end this owned query").map_err(|error| error.to_string())?;
            tokio::time::timeout(Duration::from_secs(8), async {
                while transport.provider_session_is_live(NATIVE).await
                    || transport.native_identity_evidence().await.is_some()
                {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .map_err(|_| "native query closure must withdraw actual input authority")?;
            if input_log.exists() {
                return Err("readiness must not send a user message".into());
            }
            let mut host = crate::tests::test_host_state();
            Arc::get_mut(&mut host).unwrap().incarnation_id = launch.incarnation_id.clone();
            host.persisted.lock().await.native_identity_launch = Some(launch.clone());
            host.persisted.lock().await.max_execution_generation = launch.execution_generation;
            *host.fresh_agent.lock().await = Some(actor.clone());
            crate::dispatch(
                crate::tests::authenticated_host_envelope(
                    &host,
                    freshell_runtime_protocol::HostCommand::FreshAgentPrepareNative {
                        incarnation_id: launch.incarnation_id.clone(),
                    },
                ),
                &host,
            )
            .await
            .map_err(|error| error.message)?;
            let proof = actor
                .observed_native_identity_evidence()
                .await
                .ok_or("recovery returned without actual native proof")?;
            if proof["queryGeneration"]
                .as_u64()
                .is_none_or(|next| next <= generation)
                || proof["nativeSessionId"] != NATIVE
                || crate::fresh_native_observation(&launch, &actor)
                    .await
                    .is_none()
            {
                return Err(
                    "recovery must reobserve the exact root in a newer native query".into(),
                );
            }
            let ready_snapshot = actor.snapshot().await.map_err(|error| error.to_string())?;
            if ready_snapshot["status"] != "idle" || ready_snapshot["capabilities"]["send"] != true {
                return Err(format!("recovered native query must publish an idle, sendable snapshot: {ready_snapshot:?}"));
            }
            if input_log.exists() {
                return Err("zero-message recovery replayed input".into());
            }
            actor
                .dispatch(RequestId::new(), "one original send".into(), None)
                .await
                .map_err(|error| error.to_string())?;
            let rows: Vec<Value> = tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    // appendFile opens the receipt before its asynchronous
                    // write completes. File existence is not SDK consumption
                    // evidence; wait for a complete JSONL record instead.
                    let receipt = std::fs::read_to_string(&input_log).unwrap_or_default();
                    if receipt.ends_with('\n') {
                        break receipt
                            .lines()
                            .map(|line| serde_json::from_str(line).unwrap())
                            .collect();
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .map_err(|_| "original send did not reach recovered native query")?;
            if rows.len() != 1
                || rows[0]["nativeSessionId"] != NATIVE
                || rows[0]["text"][0]["text"] != "one original send"
            {
                return Err(format!(
                    "the recovered native query received unexpected input: {rows:?}"
                ));
            }
            let first: Value =
                serde_json::from_str(std::fs::read_to_string(&marker).unwrap().trim()).unwrap();
            if rows[0]["pid"] == first["pid"] {
                return Err("input reached the retired SDK child".into());
            }
            Ok(())
        }
        .await;
        actor.stop().await.unwrap();
        result.unwrap();
    }

    #[tokio::test]
    async fn actual_claude_clear_backlog_replays_in_order_and_reopens_current_root() {
        let _lock = NATIVE_PROVIDER_FIXTURE_LOCK.lock().await;
        const PARENT: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        const FIRST: &str = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
        const CURRENT: &str = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
        const REFUSED: &str = "ffffffff-ffff-4fff-8fff-ffffffffffff";
        let owned = tempfile::tempdir().unwrap();
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let keys = [
            "HOME",
            "CLAUDE_HOME",
            "CLAUDE_CONFIG_DIR",
            "FRESHELL_CLAUDE_SIDECAR",
            "FRESHELL_CLAUDE_SDK_QUERY_MODULE",
            "FRESHELL_NATIVE_IDENTITY_LAUNCH",
            "FRESHELL_SIDECAR_TEST_CHECKPOINT",
            "FRESHELL_SIDECAR_TEST_NATIVE_CLEAR",
            "FRESHELL_SIDECAR_TEST_TRANSCRIPT",
            "FRESHELL_SIDECAR_TEST_NATIVE_INPUT_LOG",
            "FRESHELL_PROVIDER_RUN_AS_UID",
            "FRESHELL_PROVIDER_RUN_AS_GID",
        ];
        let _restore = SnapshotProviderEnv(
            keys.iter()
                .map(|key| (*key, std::env::var_os(key)))
                .collect(),
        );
        for key in keys {
            std::env::remove_var(key);
        }
        let config = owned.path().join(".claude");
        let project = config.join("projects/-owned");
        std::fs::create_dir_all(&project).unwrap();
        for root in [PARENT, FIRST, CURRENT] {
            let row = format!(
                "{}\n",
                json!({"type":"user", "uuid":uuid::Uuid::new_v4().to_string(),
                "sessionId":root, "cwd":owned.path(), "message":{"role":"user","content":"owned seed"}})
            );
            std::fs::write(project.join(format!("{root}.jsonl")), &row).unwrap();
            std::fs::write(owned.path().join(format!("{root}.jsonl")), row).unwrap();
        }
        let input_log = owned.path().join("native-inputs.jsonl");
        for (key, value) in [
            ("HOME", owned.path().to_path_buf()),
            ("CLAUDE_HOME", config.clone()),
            ("CLAUDE_CONFIG_DIR", config),
            (
                "FRESHELL_CLAUDE_SIDECAR",
                repo.join("crates/freshell-claude-sidecar/index.mjs"),
            ),
            (
                "FRESHELL_CLAUDE_SDK_QUERY_MODULE",
                repo.join("test/unit/claude-sidecar/fixtures/native-startup-query.mjs"),
            ),
            (
                "FRESHELL_SIDECAR_TEST_TRANSCRIPT",
                project.join(format!("{PARENT}.jsonl")),
            ),
            ("FRESHELL_SIDECAR_TEST_NATIVE_INPUT_LOG", input_log.clone()),
        ] {
            std::env::set_var(key, value);
        }
        std::env::set_var("FRESHELL_SIDECAR_TEST_CHECKPOINT", "1");
        std::env::set_var("FRESHELL_SIDECAR_TEST_NATIVE_CLEAR", "1");
        let launch: freshell_runtime_protocol::NativeIdentityLaunch =
            serde_json::from_value(json!({
                "incarnationId":"owned-clear-backlog", "launchNonce":"owned-clear-backlog-nonce",
                "evidenceRevision":2, "executionGeneration":3, "requestedNativeSessionId":PARENT,
            }))
            .unwrap();
        std::env::set_var("FRESHELL_NATIVE_IDENTITY_LAUNCH", json!(launch).to_string());
        let mut profile = parity_profile(FreshProvider::Claude);
        profile.cwd = owned.path().to_string_lossy().into();
        profile.native_session_id = Some(PARENT.into());
        profile.session_ref = None;
        profile.provider_launch_context = None;
        profile.provider_secret_references.clear();
        profile.plugins = None;
        profile.permission_mode = Some("default".into());
        let transport = HostedTransport::new(FreshProvider::Claude).await;
        {
            let mut identity = transport.native_identity.lock().unwrap();
            identity.launch = Some(launch.clone());
            identity.producer_launch = Some(launch.clone());
        }
        // Withhold only the consumer. The actual SDK, native hooks and bridge
        // remain live, so the actor reads current proof C while replaying B.
        let mut held = transport.take_event_stream().unwrap();
        let actor_dir = owned.path().join("actor");
        let actor = FreshAgentHostActor::open(&actor_dir, profile.clone(), transport.clone())
            .await
            .unwrap();
        for (index, expected) in [FIRST, CURRENT].into_iter().enumerate() {
            transport
                .dispatch(&RequestId::new(), "/clear", &profile)
                .await
                .unwrap();
            tokio::time::timeout(Duration::from_secs(8), async {
                loop {
                    if transport
                        .native_identity_evidence()
                        .await
                        .is_some_and(|proof| {
                            proof["nativeSessionId"] == expected
                                && proof["providerEvidence"]["source"] == "clear"
                        })
                    {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap_or_else(|_| {
                panic!(
                    "actual native clear {} did not publish {expected}",
                    index + 1
                )
            });
        }
        let current_proof = transport.native_identity_evidence().await.unwrap();
        assert_eq!(
            actor.profile().await.native_session_id.as_deref(),
            Some(PARENT)
        );
        let mut refused = current_proof["providerEvidence"].clone();
        refused["previousNativeSessionId"] = json!(CURRENT);
        refused["queryGeneration"] = json!(current_proof["queryGeneration"].as_u64().unwrap() + 1);
        transport.provider_frames.send(json!({"type":"freshAgent.event", "provider":"claude", "sessionType":"freshclaude", "sessionId":REFUSED,
            "event":{"type":"freshAgent.session.init","sessionId":REFUSED,"cliSessionId":REFUSED,"nativeIdentityEvidence":refused}}).to_string()).unwrap();
        transport.provider_frames.send(json!({"type":"freshAgent.event", "provider":"claude", "sessionType":"freshclaude", "sessionId":CURRENT,
            "event":{"type":"probe.clear-backlog.drained"}}).to_string()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(event) = held.recv().await {
                let done = matches!(&event, AgentEvent::Provider { payload } if payload["event"]["type"] == "probe.clear-backlog.drained");
                match event {
                    AgentEvent::Started { native_session_id } => { let _ = actor.observe_native_identity(native_session_id).await; }
                    event => { actor.record_event(event).await.unwrap(); }
                }
                if done { break; }
            }
        }).await.expect("the real bridge stream must drain in admitted order");
        let observed = actor.profile().await;
        let journal = actor.read_events(0, 256).await;
        if let ProviderState::Claude(state) = &transport.state {
            state.shutdown().await;
        }
        drop(actor);
        assert_eq!(
            observed.native_session_id.as_deref(),
            Some(CURRENT),
            "delayed native init events must advance the actor through both actual clears"
        );
        assert!(!journal.events.iter().any(|row| matches!(&row.event, AgentEvent::Provider { payload }
            if payload["event"]["type"] == "freshAgent.session.init" && payload["event"]["cliSessionId"] == REFUSED)),
            "a clear init refused by the host must not acquire actor authority");

        let mut replacement_launch = launch;
        replacement_launch.evidence_revision += 1;
        replacement_launch.requested_native_session_id = Some(CURRENT.into());
        std::env::set_var(
            "FRESHELL_NATIVE_IDENTITY_LAUNCH",
            json!(replacement_launch).to_string(),
        );
        std::env::set_var(
            "FRESHELL_SIDECAR_TEST_TRANSCRIPT",
            project.join(format!("{CURRENT}.jsonl")),
        );
        let replacement = HostedTransport::new(FreshProvider::Claude).await;
        {
            let mut identity = replacement.native_identity.lock().unwrap();
            identity.launch = Some(replacement_launch.clone());
            identity.producer_launch = Some(replacement_launch);
        }
        let reopened = FreshAgentHostActor::open(&actor_dir, observed, replacement.clone())
            .await
            .unwrap();
        assert_eq!(
            reopened.profile().await.native_session_id.as_deref(),
            Some(CURRENT)
        );
        reopened
            .dispatch(
                RequestId::new(),
                "one original input after delayed clear".into(),
                None,
            )
            .await
            .unwrap();
        let consumed = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let rows: Vec<Value> = std::fs::read_to_string(&input_log)
                    .unwrap_or_default()
                    .lines()
                    .map(|line| serde_json::from_str(line).unwrap())
                    .collect();
                if rows.len() >= 3 {
                    break rows;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        if let ProviderState::Claude(state) = &replacement.state {
            state.shutdown().await;
        }
        let consumed = consumed.expect("the actual SDK must consume the original input");
        assert_eq!(
            consumed.len(),
            3,
            "two explicit clears and one original input; consumed rows: {consumed:#?}"
        );
        assert_eq!(consumed[2]["nativeSessionId"], CURRENT);
        assert_eq!(
            consumed[2]["text"][0]["text"],
            "one original input after delayed clear"
        );
        assert!(
            !owned.path().join("effect-count").exists(),
            "no permission was released"
        );
    }

    #[tokio::test]
    async fn claude_checkpoint_continuation_failure_ends_host_liveness() {
        // Runs in the disposable sandbox: the production sidecar owns and
        // closes synthetic native children, never an operator's SDK process.
        let _lock = NATIVE_PROVIDER_FIXTURE_LOCK.lock().await;
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let keys = [
            "HOME",
            "CLAUDE_HOME",
            "CLAUDE_CONFIG_DIR",
            "FRESHELL_CLAUDE_SIDECAR",
            "FRESHELL_CLAUDE_SDK_QUERY_MODULE",
            "FRESHELL_NATIVE_IDENTITY_LAUNCH",
            "FRESHELL_SIDECAR_TEST_CHECKPOINT",
            "FRESHELL_SIDECAR_TEST_NATIVE_EXIT_DELAY",
            "FRESHELL_SIDECAR_TEST_CONTINUATION_FAILURE",
        ];
        let _restore = SnapshotProviderEnv(
            keys.iter()
                .map(|key| (*key, std::env::var_os(key)))
                .collect(),
        );
        for scenario in [
            "close-timeout",
            "close-error",
            "query-setup",
            "native-startup",
        ] {
            let owned = tempfile::tempdir().unwrap();
            let native = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
            std::fs::write(
                owned.path().join("native.jsonl"),
                format!("{{\"type\":\"system\",\"sessionId\":\"{native}\"}}\n"),
            )
            .unwrap();
            std::env::set_var("HOME", owned.path());
            std::env::set_var("CLAUDE_HOME", owned.path().join(".claude"));
            std::env::set_var("CLAUDE_CONFIG_DIR", owned.path().join(".claude"));
            std::env::set_var(
                "FRESHELL_CLAUDE_SIDECAR",
                repo.join("crates/freshell-claude-sidecar/index.mjs"),
            );
            std::env::set_var(
                "FRESHELL_CLAUDE_SDK_QUERY_MODULE",
                repo.join("test/unit/claude-sidecar/fixtures/native-startup-query.mjs"),
            );
            std::env::set_var("FRESHELL_SIDECAR_TEST_CHECKPOINT", "1");
            std::env::set_var("FRESHELL_SIDECAR_TEST_NATIVE_EXIT_DELAY", "1");
            std::env::set_var("FRESHELL_SIDECAR_TEST_CONTINUATION_FAILURE", scenario);
            std::env::set_var(
                "FRESHELL_NATIVE_IDENTITY_LAUNCH",
                json!({
                    "incarnationId":"owned-incarnation", "launchNonce":"owned-nonce",
                    "evidenceRevision":1,"executionGeneration":1,"requestedNativeSessionId":native,
                })
                .to_string(),
            );
            let mut profile = parity_profile(FreshProvider::Claude);
            profile.cwd = owned.path().to_string_lossy().into();
            profile.native_session_id = Some(native.into());
            profile.session_ref = None;
            profile.provider_launch_context = None;
            profile.provider_secret_references.clear();
            profile.plugins = None;
            profile.permission_mode = Some("default".into());
            let transport = HostedTransport::new(FreshProvider::Claude).await;
            let actor =
                FreshAgentHostActor::open(owned.path().join("actor"), profile, transport.clone())
                    .await
                    .unwrap();
            actor
                .dispatch(RequestId::new(), "owned checkpoint operation".into(), None)
                .await
                .unwrap();
            // Loading a replacement briefly makes native readiness false.
            // Wait for actual terminal publication, not that intermediate
            // state, within the original native-close failure budget.
            let failed_turn = tokio::time::timeout(Duration::from_secs(8), async {
                loop {
                    let events = actor.read_events(0, 128).await.events;
                    let completed = events.iter().any(|row| {
                        matches!(&row.event, AgentEvent::Provider { payload }
                            if payload["event"]["type"] == "freshAgent.turn.complete")
                    });
                    let exited = events.iter().any(|row| {
                        matches!(&row.event, AgentEvent::Provider { payload }
                            if payload["event"]["type"] == "freshAgent.status"
                                && payload["event"]["status"] == "exited")
                    });
                    let failed = events.iter().any(|row| {
                        matches!(&row.event, AgentEvent::Provider { payload }
                            if payload["event"]["type"] == "freshAgent.error"
                                && payload["event"]["code"] == "SIDECAR_EXITED")
                    });
                    // Claude's v2 attention edge carries no result verdict.
                    // An owed turn ending without a result is reported by its
                    // edge together with the exited state and failure banner.
                    if completed && exited && failed && !actor.is_live().await {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .is_ok();
            let detected = !actor.is_live().await;
            let events = actor.read_events(0, 128).await.events;
            if let ProviderState::Claude(state) = &transport.state {
                state.shutdown().await;
            }
            assert!(
                detected,
                "{scenario}: failed continuation must end host liveness without another send"
            );
            assert!(
                failed_turn,
                "{scenario}: accepted turn must settle as failed; frames={:?}",
                events
                    .iter()
                    .filter_map(|row| match &row.event {
                        AgentEvent::Provider { payload } => Some(json!({
                        "type":payload["event"]["type"], "status":payload["event"]["status"],
                        "code":payload["event"]["code"]})),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
            );
            assert!(
                events
                    .iter()
                    .any(|row| matches!(&row.event, AgentEvent::Provider { payload }
                if payload["event"]["type"] == "freshAgent.error")),
                "{scenario}: the actual failure must reach the host's event stream"
            );
            assert!(!owned.path().join("effect-count").exists());
        }
    }

    #[tokio::test]
    async fn managed_provider_claude_native_identity_uses_actual_adapter_event_name() {
        let (bus, rx) = broadcast::channel(8);
        let (created, _) = watch::channel(None);
        let (native, mut identity) = watch::channel(None);
        let (native_evidence, _) = watch::channel(None);
        let (events, mut event_rx) = mpsc::channel(8);
        let (send_outcomes, _) = broadcast::channel(8);
        let (kill_outcomes, _) = broadcast::channel(8);
        let _bridge = spawn_broadcast_bridge(
            FreshProvider::Claude,
            rx,
            BroadcastBridgeOutputs {
                owned_session: None,
                retained_codex: None,
                created,
                native,
                native_evidence,
                native_identity: Arc::new(std::sync::Mutex::new(HostedNativeIdentity::default())),
                refusal_observer: None,
                events,
                send_outcomes,
                kill_outcomes,
                suppressed_kills: Arc::new(std::sync::Mutex::new(HashSet::new())),
            },
        );
        bus.send(json!({"type":"freshAgent.event","sessionId":"owned-placeholder",
            "event":{"type":"freshAgent.session.init","cliSessionId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "nativeIdentityEvidence":{"launch":{"incarnationId":"fixture-current","launchNonce":"fixture-current-nonce","evidenceRevision":0,"executionGeneration":1,"requestedNativeSessionId":null},"digest":"a".repeat(64),"source":"startup","queryGeneration":1}}}).to_string()).unwrap();
        let received = tokio::time::timeout(Duration::from_millis(250), identity.changed()).await;
        assert!(
            received.is_ok(),
            "the actual Claude adapter identity must reach the host"
        );
        assert_eq!(
            identity.borrow().as_deref(),
            Some("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        );
        assert!(
            matches!(event_rx.recv().await, Some(AgentEvent::Started { native_session_id })
            if native_session_id == "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        );
    }

    #[tokio::test]
    async fn managed_provider_fresh_claude_sends_only_fixed_hosted_mcp_selection() {
        let _lock = NATIVE_PROVIDER_FIXTURE_LOCK.lock().await;
        let context = ProviderLaunchContext {
            preparation: ProviderPreparation::Claude {
                mcp_args: vec!["--mcp-config".into(), ".claude/freshell-mcp.json".into()],
            },
            mcp_capability: None,
            config: vec![],
            prepared_inputs: None,
        };
        for (selected, deferred_identity, expected_identity) in [
            (true, false, None),
            (false, false, None),
            (true, true, None),
            (true, false, Some("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")),
        ] {
            let conversations: Vec<&str> = expected_identity.into_iter().collect();
            let claude = SimulatedClaude::start_with(
                &conversations,
                selected.then_some(&context),
                vec![("FRESHELL_HOSTED_FRESH_AGENT".into(), "claude".into())],
            )
            .await;
            let mut profile = claude.profile(expected_identity);
            profile.model = deferred_identity.then(|| "deferred-identity".into());
            profile.provider_launch_context = selected.then_some(context.clone());
            let started =
                tokio::time::timeout(Duration::from_secs(20), claude.transport.start(&profile))
                    .await
                    .expect("Claude create cannot wait for the first model turn")
                    .unwrap();
            let queries = claude.ledger_rows("query");
            assert_eq!(queries.len(), 1, "one actual SDK query boots the runtime");
            let observed = &queries[0]["options"];
            if let Some(expected) = expected_identity {
                assert_eq!(started.native_session_id.as_deref(), Some(expected));
                assert_eq!(observed["resume"], expected);
            }
            if deferred_identity {
                assert_eq!(
                    started.native_session_id.as_deref(),
                    observed["sessionId"].as_str()
                );
            }
            assert!(
                claude.ledger_rows("prompt").is_empty(),
                "identity never needs a prompt"
            );
            if selected {
                assert_eq!(
                    observed["mcpServers"],
                    json!({
                        "freshell": {"command":"node", "args":["/opt/freshell-mcp/server.js"]}
                    }),
                    "accepted hosted selection reaches the real SDK as the fixed recipe"
                );
                assert!(observed["mcpServers"]["freshell"].get("env").is_none());
            } else {
                assert!(
                    observed.get("mcpServers").is_none(),
                    "unselected context enables no recipe"
                );
            }
            Arc::clone(&claude.transport).stop().await.unwrap();
        }
    }

    /// A hosted claude transport running the REAL sidecar over the CLI simulator
    /// (`test/fixtures/claude-cli-sim/query.mjs`), with an isolated HOME whose
    /// CLAUDE_CONFIG_DIR holds a transcript for each id in `conversations`.
    struct SimulatedClaude {
        root: tempfile::TempDir,
        project: std::path::PathBuf,
        ledger: std::path::PathBuf,
        transport: Arc<HostedTransport>,
        // Callers hold OPENCODE_SNAPSHOT_ENV_LOCK for this fixture's lifetime.
        // Restore the reader's roots after the other fixture fields drop.
        _store_environment: SnapshotProviderEnv,
    }

    impl SimulatedClaude {
        async fn start(conversations: &[&str]) -> Self {
            Self::start_with(conversations, None, vec![]).await
        }

        async fn start_with(
            conversations: &[&str],
            context: Option<&ProviderLaunchContext>,
            extra_environment: Vec<(String, String)>,
        ) -> Self {
            let root = tempfile::tempdir().unwrap();
            let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
            let home = root.path().join("home");
            let workspace = root.path().join("workspace");
            let config = home.join(".claude");
            let project_slug: String = workspace
                .to_string_lossy()
                .chars()
                .map(|value| {
                    if value.is_ascii_alphanumeric() {
                        value
                    } else {
                        '-'
                    }
                })
                .collect();
            let project = config.join("projects").join(project_slug);
            std::fs::create_dir_all(&workspace).unwrap();
            std::fs::create_dir_all(&project).unwrap();
            for id in conversations {
                let line = json!({ "type": "user", "uuid": uuid::Uuid::new_v4().to_string(), "parentUuid": null,
                    "sessionId": id, "cwd": workspace, "message": { "role": "user", "content": "hello" } });
                std::fs::write(project.join(format!("{id}.jsonl")), format!("{line}\n")).unwrap();
            }
            let store_environment = SnapshotProviderEnv(
                ["HOME", "CLAUDE_HOME", "CLAUDE_CONFIG_DIR"]
                    .into_iter()
                    .map(|key| (key, std::env::var_os(key)))
                    .collect(),
            );
            // Production's Rust history reader and SDK child share one HOME.
            // The sidecar-only environment seam does not change Rust's roots.
            std::env::set_var("HOME", &home);
            std::env::set_var("CLAUDE_HOME", &config);
            std::env::set_var("CLAUDE_CONFIG_DIR", &config);
            let launch: freshell_runtime_protocol::NativeIdentityLaunch =
                serde_json::from_value(json!({
                    "incarnationId":"owned-simulated-claude", "launchNonce":uuid::Uuid::new_v4().to_string(),
                    "evidenceRevision":1, "executionGeneration":1,
                    "requestedNativeSessionId":conversations.first(),
                }))
                .unwrap();
            let ledger = root.path().join("sim-ledger.jsonl");
            let text = |path: &std::path::Path| path.to_string_lossy().into_owned();
            let tmp = root.path().join("tmp");
            std::fs::create_dir_all(&tmp).unwrap();
            std::fs::write(root.path().join("active"), "").unwrap();
            let mut environment = vec![
                ("HOME".to_string(), text(&home)),
                ("TMPDIR".into(), text(&tmp)),
                (
                    "FRESHELL_TEST_CLAUDE_RUNTIME_GUARD".into(),
                    text(&root.path().join("active")),
                ),
                (
                    "FRESHELL_TEST_CLAUDE_RESPOND_LOG".into(),
                    text(&root.path().join("requests.jsonl")),
                ),
                (
                    "PATH".to_string(),
                    std::env::var("PATH").unwrap_or_default(),
                ),
                ("LANG".to_string(), "C.UTF-8".to_string()),
                ("CLAUDE_CONFIG_DIR".to_string(), text(&config)),
                (
                    "FRESHELL_NATIVE_IDENTITY_LAUNCH".to_string(),
                    json!(launch).to_string(),
                ),
                (
                    "FRESHELL_CLAUDE_SDK_QUERY_MODULE".to_string(),
                    freshell_platform::opencode_plugin::plugin_file_spec(
                        &repo.join("test/integration/providers/claude-sdk-for-rust-runtime.mjs"),
                    ),
                ),
                ("FRESHELL_CLAUDE_SIM_LEDGER".to_string(), text(&ledger)),
            ];
            environment.extend(extra_environment);
            let transport = HostedTransport::with_claude_sidecar_environment(
                FreshProvider::Claude,
                environment,
                context,
            )
            .await;
            {
                // Mirror the managed host's private launch binding; the real
                // SessionStart hook still supplies all native identity proof.
                let mut identity = transport.native_identity.lock().unwrap();
                identity.launch = Some(launch.clone());
                identity.producer_launch = Some(launch);
            }
            Self {
                root,
                project,
                ledger,
                transport,
                _store_environment: store_environment,
            }
        }

        fn profile(&self, resume: Option<&str>) -> FreshAgentProfile {
            FreshAgentProfile {
                naming_handle: None,
                collaboration_mode: None,
                provider: FreshProvider::Claude,
                runtime_variant: "freshclaude".into(),
                cwd: self.root.path().join("workspace").to_string_lossy().into(),
                model: None,
                effort: None,
                permission_mode: None,
                sandbox: None,
                provider_store_id: "owned-store".into(),
                native_session_id: resume.map(str::to_owned),
                plugins: None,
                model_selection: None,
                session_ref: None,
                provider_launch_context: None,
                provider_secret_references: vec![],
            }
        }

        /// The simulator's ledger rows of one kind (`query`, `boot`, `prompt`, ...).
        fn ledger_rows(&self, kind: &str) -> Vec<Value> {
            std::fs::read_to_string(&self.ledger)
                .unwrap_or_default()
                .lines()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .filter(|row| row["kind"] == kind)
                .collect()
        }

        fn assert_resume_parent(&self, options: &Value, native: &str) {
            let selector = options["resume"].as_str().expect("a resume selector");
            let transcript = self.project.join(format!("{native}.jsonl"));
            assert!(
                selector == native || std::path::Path::new(selector) == transcript,
                "the SDK must resume the exact owned parent: {options}"
            );
        }
    }

    /// The hosted claude resume `start` resolves from `freshAgent.created`'s
    /// `sessionRef` (design §7.3): the sidecar answers `created` once the CLI booted
    /// the conversation, so no prompt is needed. The bridge announces the native
    /// identity once (a turn's init does not announce it again).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_claude_resume_start_resolves_from_created_with_no_prompt() {
        // The sidecar entry is resolved from this process's environment, which
        // other tests here set: hold their lock.
        let _lock = NATIVE_PROVIDER_FIXTURE_LOCK.lock().await;
        let conversation = "4b0e8f6a-1d2c-4e3f-9a5b-6c7d8e9f0a1b";
        let claude = SimulatedClaude::start(&[conversation]).await;
        let mut events = claude.transport.take_event_stream().expect("event stream");
        let profile = claude.profile(Some(conversation));

        let started =
            tokio::time::timeout(Duration::from_secs(20), claude.transport.start(&profile))
                .await
                .expect("a claude resume start must not wait for a prompt")
                .expect("the resume start succeeds");
        assert_eq!(started.native_session_id.as_deref(), Some(conversation));
        assert_eq!(
            claude.ledger_rows("boot").len(),
            1,
            "the CLI booted the conversation"
        );
        assert!(
            claude.ledger_rows("prompt").is_empty(),
            "no prompt was needed"
        );

        // A turn's init names the same conversation: it is not announced again.
        claude
            .transport
            .dispatch(
                &RequestId::parse("resume-turn").unwrap(),
                "hello again",
                &profile,
            )
            .await
            .expect("the send is accepted");
        let mut announced = Vec::new();
        tokio::time::timeout(Duration::from_secs(20), async {
            while let Some(event) = events.recv().await {
                match event {
                    AgentEvent::Started { native_session_id } => announced.push(native_session_id),
                    AgentEvent::Provider { payload }
                        if payload["event"]["type"] == "freshAgent.turn.complete" =>
                    {
                        break
                    }
                    _ => {}
                }
            }
        })
        .await
        .expect("the turn completes");
        assert_eq!(announced, vec![conversation.to_string()]);
        Arc::clone(&claude.transport).stop().await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_fresh_claude_start_resolves_its_uuid_before_any_prompt() {
        let _lock = NATIVE_PROVIDER_FIXTURE_LOCK.lock().await;
        let claude = SimulatedClaude::start(&[]).await;
        let mut events = claude.transport.take_event_stream().expect("event stream");
        let profile = claude.profile(None);
        let started =
            tokio::time::timeout(Duration::from_secs(20), claude.transport.start(&profile))
                .await
                .expect("fresh start cannot wait for a prompt")
                .expect("fresh start succeeds");
        let durable = started
            .native_session_id
            .expect("identity is known at create");
        assert!(uuid::Uuid::parse_str(&durable).is_ok(), "{durable}");
        assert!(claude.ledger_rows("prompt").is_empty());
        let query = claude.ledger_rows("query");
        assert_eq!(query.len(), 1);
        assert_eq!(query[0]["options"]["sessionId"], durable);
        claude
            .transport
            .dispatch(
                &RequestId::parse("fresh-first-turn").unwrap(),
                "the first prompt",
                &profile,
            )
            .await
            .unwrap();
        let mut announced = Vec::new();
        tokio::time::timeout(Duration::from_secs(20), async {
            while let Some(event) = events.recv().await {
                match event {
                    AgentEvent::Started { native_session_id } => announced.push(native_session_id),
                    AgentEvent::Provider { payload }
                        if payload["event"]["type"] == "freshAgent.turn.complete" =>
                    {
                        break
                    }
                    _ => {}
                }
            }
        })
        .await
        .expect("the turn completes");
        assert_eq!(announced, vec![durable]);
        Arc::clone(&claude.transport).stop().await.unwrap();
    }

    /// G15 on the hosted lane: every start carries the pane's plugins, and an
    /// undo starts a replacement CLI. The hosted session host keeps no pane
    /// ledger, so the replacement must take the live session's settings
    /// (plugins, model, effort), not the ledger's (nothing), or the replacement
    /// and every later turn run without the pane's plugins (a boot-only
    /// option). (Redo needs the durable rollback record, which only a lane with
    /// a ledger keeps.)
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_hosted_claude_undo_keeps_the_panes_plugins_and_model() {
        let _lock = NATIVE_PROVIDER_FIXTURE_LOCK.lock().await;
        let conversation = "6d1f0a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b";
        let claude = SimulatedClaude::start(&[conversation]).await;
        let plugin = claude.root.path().join("workspace/.claude/plugins/review");
        std::fs::create_dir_all(&plugin).unwrap();
        let plugin = plugin.to_string_lossy().to_string();
        let mut profile = claude.profile(Some(conversation));
        profile.plugins = Some(vec![plugin.clone()]);
        profile.model = Some("opus".into());
        profile.effort = Some("high".into());
        tokio::time::timeout(Duration::from_secs(20), claude.transport.start(&profile))
            .await
            .expect("the resume start answers")
            .expect("the resume start succeeds");
        let plugins = json!([{ "type": "local", "path": plugin }]);
        let start = claude.ledger_rows("query")[0]["options"].clone();
        assert_eq!(start["plugins"], plugins, "{start}");

        tokio::time::timeout(
            Duration::from_secs(20),
            claude.transport.dispatch_operation(
                &RequestId::parse("undo-1").unwrap(),
                &FreshAgentOperation::Rollback {
                    direction: FreshAgentRollbackDirection::Undo,
                    mode: FreshAgentRollbackMode::Step,
                    turn_id: None,
                    cwd: None,
                },
            ),
        )
        .await
        .expect("the undo answers")
        .expect("the undo succeeds");
        let rows = claude.ledger_rows("query");
        assert_eq!(rows.len(), 2, "the undo booted one replacement");
        let replacement = rows[1]["options"].clone();
        assert_eq!(replacement["plugins"], plugins, "{replacement}");
        assert_eq!(replacement["model"], "opus", "{replacement}");
        assert_eq!(replacement["effort"], "high", "{replacement}");
        Arc::clone(&claude.transport).stop().await.unwrap();
    }

    /// C14 (G09): a hosted claude fork routes to `FreshClaudeState::handle_fork`. The
    /// transition arrives once the CLI booted the child as a lazy fork of the parent
    /// (no prompt), keyed by the native ids the actor holds; the runtime retires the
    /// parent; from then on the transport addresses the child: its snapshot is the
    /// child's, and the next turn runs in the child under the child's id with no
    /// second identity announcement (the actor records the child at the fork).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_claude_fork_boots_the_child_retires_the_parent_and_runs_the_next_turn_there() {
        let _lock = NATIVE_PROVIDER_FIXTURE_LOCK.lock().await;
        let conversation = "6d1f0a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b";
        let claude = SimulatedClaude::start(&[conversation]).await;
        let mut events = claude.transport.take_event_stream().expect("event stream");
        let profile = claude.profile(Some(conversation));
        tokio::time::timeout(Duration::from_secs(20), claude.transport.start(&profile))
            .await
            .expect("the resume start answers")
            .expect("the resume start succeeds");

        let transition = tokio::time::timeout(
            Duration::from_secs(20),
            claude
                .transport
                .fork(&RequestId::parse("fork-1").unwrap(), conversation, None),
        )
        .await
        .expect("a claude fork must not wait for a prompt")
        .expect("the fork succeeds");
        assert_eq!(transition.parent_session_id, conversation);
        assert!(transition.parent_retired_by_runtime);
        let child = transition.child_session_id.clone();
        assert!(
            uuid::Uuid::parse_str(&child).is_ok() && child != conversation,
            "{child}"
        );
        let boot = claude
            .ledger_rows("query")
            .into_iter()
            .map(|row| row["options"].clone())
            .find(|options| options["sessionId"] == child.as_str())
            .expect("the CLI booted the child");
        assert_eq!(boot["forkSession"], true, "{boot}");
        claude.assert_resume_parent(&boot, conversation);
        assert!(
            claude.ledger_rows("prompt").is_empty(),
            "no prompt was needed"
        );
        assert!(
            !claude
                .transport
                .provider_session_is_live(conversation)
                .await
        );
        assert!(claude.transport.provider_session_is_live(&child).await);
        let snapshot = claude.transport.snapshot().await.expect("a snapshot");
        assert_eq!(snapshot["sessionId"], child.as_str(), "{snapshot}");

        // The child has no transcript yet; a fork of it forks the parent at the
        // same point (source collapse), with no ledger to record the child's
        // genesis on this lane.
        let second = tokio::time::timeout(
            Duration::from_secs(20),
            claude
                .transport
                .fork(&RequestId::parse("fork-2").unwrap(), &child, None),
        )
        .await
        .expect("the second fork answers")
        .expect("a pending child forks");
        assert_eq!(second.parent_session_id, child);
        let grandchild = second.child_session_id.clone();
        let boot = claude
            .ledger_rows("query")
            .into_iter()
            .map(|row| row["options"].clone())
            .find(|options| options["sessionId"] == grandchild.as_str())
            .expect("the CLI booted the second child");
        claude.assert_resume_parent(&boot, conversation);
        let child = grandchild;

        let mut child_profile = profile.clone();
        child_profile.native_session_id = Some(child.clone());
        claude
            .transport
            .dispatch(
                &RequestId::parse("fork-turn").unwrap(),
                "after the fork",
                &child_profile,
            )
            .await
            .expect("the send is accepted");
        let mut announced = Vec::new();
        tokio::time::timeout(Duration::from_secs(20), async {
            while let Some(event) = events.recv().await {
                match event {
                    AgentEvent::Started { native_session_id } => announced.push(native_session_id),
                    AgentEvent::Provider { payload }
                        if payload["event"]["type"] == "freshAgent.turn.complete" =>
                    {
                        break
                    }
                    _ => {}
                }
            }
        })
        .await
        .expect("the child's turn completes");
        assert_eq!(
            announced,
            vec![conversation.to_string()],
            "only the resumed parent is announced by the bridge"
        );
        let prompt = claude
            .ledger_rows("prompt")
            .into_iter()
            .find(|row| row["text"] == "after the fork")
            .expect("the turn ran");
        assert_eq!(prompt["sessionId"], child.as_str(), "{prompt}");
        Arc::clone(&claude.transport).stop().await.unwrap();
    }

    /// A hosted claude resume of a conversation the CLI does not have fails at start:
    /// the boot is refused (`create.failed`), so no session is reported started.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_claude_resume_start_of_a_missing_conversation_fails() {
        let _lock = NATIVE_PROVIDER_FIXTURE_LOCK.lock().await;
        let claude = SimulatedClaude::start(&[]).await;
        let profile = claude.profile(Some("9c8b7a6f-5e4d-4c3b-8a2f-1e0d9c8b7a6f"));
        let started =
            tokio::time::timeout(Duration::from_secs(20), claude.transport.start(&profile))
                .await
                .expect("the refused boot answers promptly");
        assert!(started.is_err(), "a refused resume boot fails the start");
        Arc::clone(&claude.transport).stop().await.unwrap();
    }

    /// What one hosted Claude configure produced: the actor's answer, the
    /// durable profile afterwards, every configure line the production sidecar
    /// received, the provider event named `settled_on` once it reached the
    /// host journal, and the whole journal at that point.
    struct HostedClaudeConfigure {
        outcome: Result<
            freshell_runtime_protocol::CommandState,
            freshell_agent_runtime::host_actor::ActorError,
        >,
        profile: FreshAgentProfile,
        applied: Vec<Value>,
        settled: Option<Value>,
        events: Vec<AgentEvent>,
    }

    /// Runs one configure through the real `FreshClaudeState` behind a hosted
    /// actor whose profile starts on sonnet/low. The real sidecar applies SDK
    /// settings; the refusal case injects an error at the SDK setModel boundary.
    async fn hosted_claude_configure(
        settings: freshell_runtime_protocol::FreshAgentTurnSettings,
        reject_model: bool,
        settled_on: &str,
    ) -> HostedClaudeConfigure {
        let _lock = NATIVE_PROVIDER_FIXTURE_LOCK.lock().await;
        let dir = tempfile::tempdir().unwrap();
        let claude = SimulatedClaude::start_with(
            &[],
            None,
            if reject_model {
                vec![("FRESHELL_TEST_CLAUDE_REJECT_MODEL".into(), "opus".into())]
            } else {
                vec![]
            },
        )
        .await;
        let transport = claude.transport.clone();
        let profile = FreshAgentProfile {
            naming_handle: None,
            collaboration_mode: None,
            provider: FreshProvider::Claude,
            runtime_variant: "freshclaude".into(),
            cwd: claude
                .root
                .path()
                .join("workspace")
                .to_string_lossy()
                .into(),
            model: Some("sonnet".into()),
            effort: Some("low".into()),
            permission_mode: Some("default".into()),
            sandbox: None,
            provider_store_id: "owned-store".into(),
            native_session_id: None,
            plugins: None,
            model_selection: None,
            session_ref: None,
            provider_launch_context: None,
            provider_secret_references: vec![],
        };
        let actor = FreshAgentHostActor::open(dir.path().join("actor"), profile, transport.clone())
            .await
            .unwrap();

        let outcome = actor
            .configure(RequestId::parse("hosted-configure-1").unwrap(), settings)
            .await;
        let settled = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let events = actor.read_events(0, 256).await.events;
                if let Some(event) = events.iter().find_map(|entry| match &entry.event {
                    AgentEvent::Provider { payload } if payload["event"]["type"] == settled_on => {
                        Some(payload["event"].clone())
                    }
                    _ => None,
                }) {
                    break event;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .ok();
        let profile = actor.profile().await;
        let events = actor
            .read_events(0, 256)
            .await
            .events
            .into_iter()
            .map(|entry| entry.event)
            .collect();
        let applied = std::fs::read_to_string(claude.root.path().join("requests.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .filter(|request| request["type"] == "configure")
            .collect();
        Arc::clone(&transport).stop().await.unwrap();
        HostedClaudeConfigure {
            outcome,
            profile,
            applied,
            settled,
            events,
        }
    }

    #[tokio::test]
    async fn hosted_claude_configure_applies_live_and_relays_the_session_metadata_frame() {
        let run = hosted_claude_configure(
            freshell_runtime_protocol::FreshAgentTurnSettings {
                model: Some("opus".into()),
                effort: Some(Some("high".into())),
                ..Default::default()
            },
            false,
            "freshAgent.session.metadata",
        )
        .await;

        assert_eq!(
            run.outcome.unwrap(),
            freshell_runtime_protocol::CommandState::ProviderAcked
        );
        assert_eq!(run.profile.model.as_deref(), Some("opus"));
        assert_eq!(
            run.applied.len(),
            1,
            "one live configure reaches the sidecar"
        );
        assert_eq!(run.applied[0]["settings"]["model"], "opus");
        assert_eq!(run.applied[0]["settings"]["effort"], "high");
        let metadata = run
            .settled
            .expect("the provider's metadata frame reaches the host journal");
        assert_eq!(metadata["sessionId"], run.applied[0]["sessionId"]);
        assert_eq!(
            metadata["sessionId"].as_str(),
            run.profile.native_session_id.as_deref()
        );
        assert_eq!(metadata["model"], "opus");
        assert_eq!(metadata["effort"], "high");
    }

    /// The model selector's Default row is a model change with no effort.
    /// Claude clears the effort live; the durable profile, which every later
    /// send restates, must end on that same effort.
    #[tokio::test]
    async fn hosted_claude_configure_to_the_default_effort_persists_the_effort_claude_reports() {
        let run = hosted_claude_configure(
            freshell_runtime_protocol::FreshAgentTurnSettings {
                model: Some("opus".into()),
                ..Default::default()
            },
            false,
            "freshAgent.session.metadata",
        )
        .await;

        assert_eq!(
            run.outcome.unwrap(),
            freshell_runtime_protocol::CommandState::ProviderAcked
        );
        let metadata = run
            .settled
            .expect("the provider's metadata frame reaches the host journal");
        assert_eq!(metadata["model"], "opus");
        assert_eq!(run.profile.model.as_deref(), Some("opus"));
        assert_eq!(
            run.profile.effort.as_ref().map(|effort| json!(effort)),
            metadata
                .get("effort")
                .filter(|value| !value.is_null())
                .cloned(),
            "the durable effort equals the effort the live session reports"
        );
        assert!(run.profile.effort.is_none());
    }

    /// Claude refuses the live apply (here the sidecar cannot set the
    /// model). The intent stays saved for the next send, the provider's own
    /// error reaches the journal for every device, and the command journal
    /// records the refusal instead of a provider acknowledgement.
    #[tokio::test]
    async fn hosted_claude_configure_refused_live_keeps_the_intent_and_journals_the_refusal() {
        let run = hosted_claude_configure(
            freshell_runtime_protocol::FreshAgentTurnSettings {
                model: Some("opus".into()),
                effort: Some(Some("high".into())),
                ..Default::default()
            },
            true,
            "freshAgent.error",
        )
        .await;

        assert_eq!(
            run.outcome.unwrap(),
            freshell_runtime_protocol::CommandState::Cancelled
        );
        assert_eq!(run.applied.len(), 1, "the live apply was attempted once");
        let refusal = run
            .settled
            .expect("the provider's refusal reaches the host journal");
        assert_eq!(refusal["code"], "CLAUDE_SETTINGS_FAILED");
        assert_eq!(run.profile.model.as_deref(), Some("opus"));
        assert_eq!(run.profile.effort.as_deref(), Some("high"));
        assert!(
            run.events.iter().any(|event| matches!(
                event,
                AgentEvent::CommandOutcome {
                    request_id,
                    state: freshell_runtime_protocol::CommandState::Cancelled,
                } if request_id.as_str() == "hosted-configure-1"
            )),
            "the command journal records the refused live apply: {:?}",
            run.events
        );
    }

    #[test]
    fn configure_refusal_is_read_only_from_answers_to_this_configure() {
        let request_id = RequestId::parse("configure-answer").unwrap();
        let refusal = |frames: &[Value]| {
            let (sender, mut answers) = broadcast::channel(16);
            for frame in frames {
                sender.send(frame.to_string()).unwrap();
            }
            configure_refusal_code(&mut answers, "session-a", &request_id)
        };
        let nested_error = |session: &str, code: &str| {
            json!({"type":"freshAgent.event","provider":"codex","sessionId":session,
                "sessionType":"freshcodex","event":{"type":"freshAgent.error","sessionId":session,
                "code":code,"message":"refused"}})
        };
        let metadata = json!({"type":"freshAgent.event","provider":"claude","sessionId":"session-a",
            "sessionType":"freshclaude","event":{"type":"freshAgent.session.metadata",
            "sessionId":"session-a","model":"opus"}});

        assert_eq!(
            refusal(std::slice::from_ref(&metadata)),
            None,
            "a converged apply"
        );
        assert_eq!(
            refusal(&[nested_error("session-b", "INVALID_EFFORT")]),
            None,
            "another session's error"
        );
        assert_eq!(
            refusal(&[
                json!({"type":"error","requestId":"another-request","code":"INTERNAL_ERROR"})
            ]),
            None,
            "another request's error"
        );
        assert_eq!(
            refusal(&[metadata, nested_error("session-a", "INVALID_EFFORT")]).as_deref(),
            Some("INVALID_EFFORT")
        );
        assert_eq!(
            refusal(&[json!({"type":"error","requestId":"configure-answer",
                "code":"INTERNAL_ERROR","message":"SESSION_NOT_FOUND: claude session not found"})])
            .as_deref(),
            Some("INTERNAL_ERROR"),
            "the unknown-session answer is correlated by request id"
        );
    }

    #[tokio::test]
    async fn normalized_claude_init_reaches_current_host_native_receiver() {
        let _lock = NATIVE_PROVIDER_FIXTURE_LOCK.lock().await;
        let root = tempfile::tempdir().unwrap();
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let keys = [
            "HOME",
            "CLAUDE_HOME",
            "CLAUDE_CONFIG_DIR",
            "FRESHELL_CLAUDE_SIDECAR",
            "FRESHELL_CLAUDE_SDK_QUERY_MODULE",
            "FRESHELL_NATIVE_IDENTITY_LAUNCH",
            "FRESHELL_SIDECAR_TEST_TRANSCRIPT",
        ];
        let _restore = SnapshotProviderEnv(
            keys.iter()
                .map(|key| (*key, std::env::var_os(key)))
                .collect(),
        );
        std::env::set_var("HOME", root.path());
        std::env::set_var("CLAUDE_HOME", root.path().join(".claude"));
        std::env::set_var("CLAUDE_CONFIG_DIR", root.path().join(".claude"));
        std::env::set_var(
            "FRESHELL_CLAUDE_SIDECAR",
            repo.join("crates/freshell-claude-sidecar/index.mjs")
                .canonicalize()
                .unwrap(),
        );
        std::env::set_var(
            "FRESHELL_CLAUDE_SDK_QUERY_MODULE",
            repo.join("test/unit/claude-sidecar/fixtures/native-startup-query.mjs")
                .canonicalize()
                .unwrap(),
        );
        let native = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let transcript = root.path().join("native.jsonl");
        std::fs::write(
            &transcript,
            format!("{{\"type\":\"system\",\"sessionId\":\"{native}\"}}\n"),
        )
        .unwrap();
        std::env::set_var("FRESHELL_SIDECAR_TEST_TRANSCRIPT", &transcript);
        let launch = json!({"incarnationId":"normalized-init","launchNonce":"normalized-init-nonce",
            "evidenceRevision":0,"executionGeneration":1,"requestedNativeSessionId":native});
        std::env::set_var("FRESHELL_NATIVE_IDENTITY_LAUNCH", launch.to_string());
        for provider in [FreshProvider::Claude, FreshProvider::Kilroy] {
            let transport = HostedTransport::new(provider.clone()).await;
            let mut profile = parity_profile(FreshProvider::Claude);
            profile.provider = provider;
            profile.cwd = root.path().to_string_lossy().into();
            profile.native_session_id = Some("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into());
            profile.session_ref = None;
            profile.provider_launch_context = None;
            profile.provider_secret_references.clear();
            profile.plugins = None;
            let ProviderState::Claude(state) = &transport.state else {
                unreachable!()
            };
            let started = transport.start(&profile).await.unwrap();
            let created = transport.wait_created().await.unwrap();
            assert_eq!(started.native_session_id, profile.native_session_id);
            let observed_live = transport.is_live().await;
            let mut receiver = transport.native_rx.lock().await.clone();
            // The create ACK can announce the native UUID before the separate
            // stdout consumer publishes its normalized native-init evidence.
            let (native, observed_evidence) = tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    let native = receiver.borrow().clone();
                    let evidence = transport.native_identity_evidence().await;
                    if native.is_some() && evidence.is_some() {
                        return (native, evidence);
                    }
                    if receiver.changed().await.is_err() {
                        return (None, None);
                    }
                }
            })
            .await
            .unwrap_or((None, None));
            state.shutdown().await;
            assert!(
                observed_live,
                "the observed native session must remain a live host transport after startup"
            );
            assert!(observed_evidence.is_some());
            let evidence = observed_evidence.unwrap();
            assert_eq!(evidence["nativeSessionId"], native.clone().unwrap());
            assert_eq!(evidence["launch"], launch);
            assert_eq!(evidence["providerEvidence"]["launch"], launch);
            assert_eq!(evidence["providerEvidence"]["source"], "resume");
            assert!(evidence["queryGeneration"]
                .as_u64()
                .is_some_and(|generation| generation > 0
                    && Some(generation)
                        == evidence["providerEvidence"]["queryGeneration"].as_u64()));
            assert!(evidence["providerEvidence"]["digest"]
                .as_str()
                .is_some_and(|digest| digest.len() == 64
                    && digest.bytes().all(|byte| byte.is_ascii_hexdigit())));
            assert_eq!(
                created,
                profile.native_session_id.clone().unwrap(),
                "the v2 runtime registers under the exact native conversation UUID"
            );
            assert_eq!(native,profile.native_session_id,
                "production sidecar sdk.session.init must pass the actual upstream normalizer and reach the host");
        }
    }

    #[tokio::test]
    async fn hosted_checkpoint_recovery_stages_without_input_and_releases_current_native_ask_once()
    {
        let _lock = NATIVE_PROVIDER_FIXTURE_LOCK.lock().await;
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let keys = [
            "HOME",
            "CLAUDE_HOME",
            "CLAUDE_CONFIG_DIR",
            "FRESHELL_CLAUDE_SIDECAR",
            "FRESHELL_CLAUDE_SDK_QUERY_MODULE",
            "FRESHELL_NATIVE_IDENTITY_LAUNCH",
            "FRESHELL_SIDECAR_TEST_CHECKPOINT",
            "FRESHELL_SIDECAR_TEST_NATIVE_REQUEST_ID",
        ];
        let _restore = SnapshotProviderEnv(
            keys.iter()
                .map(|key| (*key, std::env::var_os(key)))
                .collect(),
        );
        for provider in [FreshProvider::Claude, FreshProvider::Kilroy] {
            let owned = tempfile::tempdir().unwrap();
            let native = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
            std::fs::write(
                owned.path().join("native.jsonl"),
                format!("{{\"type\":\"system\",\"sessionId\":\"{native}\"}}\n"),
            )
            .unwrap();
            std::env::set_var("HOME", owned.path());
            std::env::set_var("CLAUDE_HOME", owned.path().join(".claude"));
            std::env::set_var("CLAUDE_CONFIG_DIR", owned.path().join(".claude"));
            std::env::set_var(
                "FRESHELL_CLAUDE_SIDECAR",
                repo.join("crates/freshell-claude-sidecar/index.mjs"),
            );
            std::env::set_var(
                "FRESHELL_CLAUDE_SDK_QUERY_MODULE",
                repo.join("test/unit/claude-sidecar/fixtures/native-startup-query.mjs"),
            );
            std::env::set_var("FRESHELL_SIDECAR_TEST_CHECKPOINT", "1");
            std::env::set_var(
                "FRESHELL_NATIVE_IDENTITY_LAUNCH",
                json!({"incarnationId":"current","launchNonce":"current-nonce",
                "evidenceRevision":0,"executionGeneration":1,"requestedNativeSessionId":native})
                .to_string(),
            );
            let mut profile = parity_profile(FreshProvider::Claude);
            profile.provider = provider.clone();
            profile.cwd = owned.path().to_string_lossy().into();
            profile.native_session_id = Some(native.into());
            profile.session_ref = None;
            profile.provider_launch_context = None;
            profile.provider_secret_references.clear();
            profile.plugins = None;
            profile.permission_mode = Some("default".into());
            std::env::set_var("FRESHELL_SIDECAR_TEST_NATIVE_REQUEST_ID", "native-old");
            let original = HostedTransport::new(provider.clone()).await;
            let mut original_events = original.take_event_stream().unwrap();
            original.start(&profile).await.unwrap();
            original
                .dispatch(
                    &RequestId::parse("original-operation").unwrap(),
                    "owned original operation",
                    &profile,
                )
                .await
                .unwrap();
            let checkpoint = tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    if let Some(AgentEvent::PermissionRequested { payload, .. }) =
                        original_events.recv().await
                    {
                        break payload["nativeCheckpoint"].clone();
                    }
                }
            })
            .await
            .unwrap();
            if let ProviderState::Claude(state) = &original.state {
                state.shutdown().await;
            }
            std::env::set_var("FRESHELL_SIDECAR_TEST_NATIVE_REQUEST_ID", "native-new");
            let current = HostedTransport::new(provider).await;
            let mut events = current.take_event_stream().unwrap();
            current
                .prepare_native_permission_recovery(vec![checkpoint.clone()])
                .await
                .unwrap();
            current.start(&profile).await.unwrap();
            let before = std::fs::read(owned.path().join("native.jsonl")).unwrap();
            let receipt = current.resume_native_permission_recovery().await;
            let recovered = tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    if let Some(AgentEvent::PermissionRequested { payload, .. }) =
                        events.recv().await
                    {
                        break payload;
                    }
                }
            })
            .await;
            let duplicate = current.resume_native_permission_recovery().await;
            if let ProviderState::Claude(state) = &current.state {
                state.shutdown().await;
            }
            assert!(
                receipt.is_ok(),
                "current exact checkpoint release must be checked: {receipt:?}"
            );
            let recovered = recovered
                .expect("explicit hosted release must surface the same current native ask");
            assert_eq!(recovered["nativeCheckpoint"], checkpoint);
            assert_eq!(recovered["nativeRequestId"], "native-new");
            assert!(
                duplicate.is_err(),
                "staged recovery release cannot run twice"
            );
            assert_eq!(
                std::fs::read(owned.path().join("native.jsonl")).unwrap(),
                before,
                "parked native ask must not execute or rewrite history"
            );
            assert!(!owned.path().join("effect-count").exists());
        }
    }

    #[tokio::test]
    async fn hosted_actor_checkpoint_recovery_preserves_the_created_root_and_current_card() {
        let _lock = NATIVE_PROVIDER_FIXTURE_LOCK.lock().await;
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let keys = [
            "HOME",
            "CLAUDE_HOME",
            "CLAUDE_CONFIG_DIR",
            "FRESHELL_CLAUDE_SIDECAR",
            "FRESHELL_CLAUDE_SDK_QUERY_MODULE",
            "FRESHELL_NATIVE_IDENTITY_LAUNCH",
            "FRESHELL_SIDECAR_TEST_CHECKPOINT",
            "FRESHELL_SIDECAR_TEST_NATIVE_REQUEST_ID",
            "FRESHELL_SIDECAR_TEST_NATIVE_PROJECT",
        ];
        let _restore = SnapshotProviderEnv(
            keys.iter()
                .map(|key| (*key, std::env::var_os(key)))
                .collect(),
        );
        for provider in [FreshProvider::Claude, FreshProvider::Kilroy] {
            let owned = tempfile::tempdir().unwrap();
            // Both fresh and exact-resume queries use the allocated UUID's
            // actual transcript, including the zero-message continuation.
            std::env::set_var("FRESHELL_SIDECAR_TEST_NATIVE_PROJECT", owned.path());
            std::env::set_var("HOME", owned.path());
            std::env::set_var("CLAUDE_HOME", owned.path().join(".claude"));
            std::env::set_var("CLAUDE_CONFIG_DIR", owned.path().join(".claude"));
            std::env::set_var(
                "FRESHELL_CLAUDE_SIDECAR",
                repo.join("crates/freshell-claude-sidecar/index.mjs"),
            );
            std::env::set_var(
                "FRESHELL_CLAUDE_SDK_QUERY_MODULE",
                repo.join("test/unit/claude-sidecar/fixtures/native-startup-query.mjs"),
            );
            std::env::set_var("FRESHELL_SIDECAR_TEST_CHECKPOINT", "1");
            std::env::set_var(
                "FRESHELL_NATIVE_IDENTITY_LAUNCH",
                json!({"incarnationId":"current","launchNonce":"current-nonce",
                "evidenceRevision":0,"executionGeneration":1,"requestedNativeSessionId":null})
                .to_string(),
            );
            let mut profile = parity_profile(FreshProvider::Claude);
            profile.provider = provider.clone();
            profile.cwd = owned.path().to_string_lossy().into();
            profile.native_session_id = None;
            profile.session_ref = None;
            profile.provider_launch_context = None;
            profile.provider_secret_references.clear();
            profile.plugins = None;
            profile.permission_mode = Some("default".into());
            std::env::set_var("FRESHELL_SIDECAR_TEST_NATIVE_REQUEST_ID", "native-old");
            let original = HostedTransport::new(provider.clone()).await;
            {
                // Production installs this binding in private child secrets.
                // This isolated transport fixture supplies the same explicit
                // identity without initializing process-global credentials.
                let launch: freshell_runtime_protocol::NativeIdentityLaunch = serde_json::from_str(
                    &std::env::var("FRESHELL_NATIVE_IDENTITY_LAUNCH").unwrap(),
                )
                .unwrap();
                let mut identity = original.native_identity.lock().unwrap();
                identity.launch = Some(launch.clone());
                identity.producer_launch = Some(launch);
            }
            let actor_dir = owned.path().join("actor");
            let actor = FreshAgentHostActor::open(&actor_dir, profile.clone(), original.clone())
                .await
                .unwrap();
            let native = actor.profile().await.native_session_id.unwrap();
            assert!(
                uuid::Uuid::parse_str(&native).is_ok(),
                "fresh creation allocates the actual native UUID"
            );
            let transcript = owned.path().join(format!("{native}.jsonl"));
            actor
                .dispatch(
                    RequestId::parse("original-operation").unwrap(),
                    "owned original operation".into(),
                    None,
                )
                .await
                .unwrap();
            let old_card_result = tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    if let Some(payload) =
                        actor
                            .read_events(0, 128)
                            .await
                            .events
                            .iter()
                            .find_map(|row| {
                                if let AgentEvent::PermissionRequested { payload, .. } = &row.event
                                {
                                    Some(payload.clone())
                                } else {
                                    None
                                }
                            })
                    {
                        break payload;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await;
            let old_card = match old_card_result {
                Ok(card) => card,
                Err(error) => {
                    let events = actor.read_events(0, 128).await;
                    original.clone().stop().await.unwrap();
                    panic!("native checkpoint card was not exposed: {error}; events={events:?}");
                }
            };
            let checkpoint = old_card["nativeCheckpoint"].clone();
            assert!(actor.is_live().await,
                "the ended query preceding native checkpoint continuation must not close its current replacement");
            profile = actor.profile().await;
            assert_eq!(profile.native_session_id.as_deref(), Some(native.as_str()));
            if let ProviderState::Claude(state) = &original.state {
                state.shutdown().await;
            }
            drop(actor);
            tokio::task::yield_now().await;
            std::env::set_var(
                "FRESHELL_NATIVE_IDENTITY_LAUNCH",
                json!({"incarnationId":"current","launchNonce":"current-nonce",
                "evidenceRevision":0,"executionGeneration":1,"requestedNativeSessionId":native})
                .to_string(),
            );
            std::env::set_var("FRESHELL_SIDECAR_TEST_NATIVE_REQUEST_ID", "native-new");
            let current = HostedTransport::new(provider).await;
            {
                // Production installs this binding in private child secrets.
                // This isolated transport fixture supplies the same explicit
                // identity without initializing process-global credentials.
                let launch: freshell_runtime_protocol::NativeIdentityLaunch = serde_json::from_str(
                    &std::env::var("FRESHELL_NATIVE_IDENTITY_LAUNCH").unwrap(),
                )
                .unwrap();
                let mut identity = current.native_identity.lock().unwrap();
                identity.launch = Some(launch.clone());
                identity.producer_launch = Some(launch);
            }
            let actor = FreshAgentHostActor::open(&actor_dir, profile.clone(), current.clone())
                .await
                .unwrap();
            assert!(
                !current
                    .prepared_native_checkpoints
                    .lock()
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .is_empty(),
                "actual saved actor must register its native checkpoint before startup"
            );
            let before = std::fs::read(&transcript).unwrap();
            let receipt = actor.resume_pending_native_permissions().await;
            let recovered = tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    if let Some(payload) = actor
                        .read_events(0, 128)
                        .await
                        .events
                        .iter()
                        .rev()
                        .find_map(|row| {
                            if let AgentEvent::PermissionRequested { payload, .. } = &row.event {
                                if payload["nativeRequestId"] == "native-new" {
                                    return Some(payload.clone());
                                }
                            }
                            None
                        })
                    {
                        break payload;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await;
            let identity_before_repeat = (
                actor.observed_native_session_id().await,
                actor.observed_native_identity_evidence().await,
            );
            let duplicate = actor.resume_pending_native_permissions().await;
            let identity_after_repeat = (
                actor.observed_native_session_id().await,
                actor.observed_native_identity_evidence().await,
            );
            if let ProviderState::Claude(state) = &current.state {
                state.shutdown().await;
            }
            drop(actor);
            assert!(
                receipt.is_ok(),
                "current exact checkpoint release must be checked: {receipt:?}"
            );
            let recovered = recovered
                .expect("explicit hosted release must surface the same current native ask");
            assert_eq!(recovered["nativeCheckpoint"], checkpoint);
            assert_eq!(recovered["nativeRequestId"], "native-new");
            assert!(
                duplicate.is_ok(),
                "settled actor release must succeed without a second native continuation: {duplicate:?}"
            );
            assert_eq!(identity_before_repeat.0.as_deref(), Some(native.as_str()));
            assert!(identity_before_repeat.1.is_some());
            assert_eq!(identity_after_repeat, identity_before_repeat);
            assert_eq!(
                std::fs::read(&transcript).unwrap(),
                before,
                "parked native ask must not execute or rewrite history"
            );
            assert!(!owned.path().join("effect-count").exists());
        }
    }

    #[tokio::test]
    async fn actual_opencode_bootstrap_materializes_once_before_send_and_reuses_owned_native_http_session(
    ) {
        let _lock = NATIVE_PROVIDER_FIXTURE_LOCK.lock().await;
        let dir = tempfile::tempdir().unwrap();
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../test/e2e-browser/fixtures/fake-opencode.cjs")
            .canonicalize()
            .unwrap();
        let audit = dir.path().join("native-audit.jsonl");
        let keys = [
            "OPENCODE_CMD",
            "HOME",
            "XDG_DATA_HOME",
            "FAKE_OPENCODE_AUDIT_LOG",
        ];
        let _env = SnapshotProviderEnv(
            keys.iter()
                .map(|key| (*key, std::env::var_os(key)))
                .collect(),
        );
        std::env::set_var("OPENCODE_CMD", fixture);
        std::env::set_var("HOME", dir.path());
        std::env::set_var("XDG_DATA_HOME", dir.path().join("data"));
        std::env::set_var("FAKE_OPENCODE_AUDIT_LOG", &audit);
        let transport = HostedTransport::new_with_context(FreshProvider::Opencode, None).await;
        let profile = FreshAgentProfile {
            naming_handle: None,
            collaboration_mode: None,
            provider: FreshProvider::Opencode,
            runtime_variant: "freshopencode".into(),
            cwd: dir.path().to_string_lossy().into(),
            model: None,
            effort: None,
            permission_mode: None,
            sandbox: None,
            provider_store_id: "owned-store".into(),
            native_session_id: None,
            plugins: None,
            model_selection: None,
            session_ref: None,
            provider_launch_context: None,
            provider_secret_references: vec![],
        };
        let actor = FreshAgentHostActor::open(dir.path().join("actor"), profile, transport.clone())
            .await
            .unwrap();
        let registered = transport.session_id.lock().await.clone().unwrap();
        let pre = actor.snapshot().await;
        let spawned_before_send = audit.exists();
        let before_send_rows: Vec<Value> = std::fs::read_to_string(&audit)
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let first = actor
            .dispatch_with_checkpoint_identity(
                RequestId::parse("first-owned-send").unwrap(),
                "First owned prompt".into(),
                None,
                Some("managed-opencode-attempt-1".into()),
            )
            .await;
        let checkpoint_identity = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let events = actor.read_events(0, 256).await.events;
                if let Some(payload) = events.iter().find_map(|entry| match &entry.event {
                    AgentEvent::Provider { payload }
                        if payload["event"]["type"] == "checkpointTurnIdentity" =>
                    {
                        Some(payload.clone())
                    }
                    _ => None,
                }) {
                    break payload;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        let identity = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let Some(native) = actor.profile().await.native_session_id {
                    break native;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        let live = actor.snapshot().await;
        let second = actor
            .dispatch(
                RequestId::parse("second-owned-send").unwrap(),
                "Second owned prompt".into(),
                None,
            )
            .await;
        let observed_prompts = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let count = std::fs::read_to_string(&audit)
                    .unwrap_or_default()
                    .lines()
                    .filter(|line| {
                        serde_json::from_str::<Value>(line)
                            .is_ok_and(|row| row["event"] == "prompt_async")
                    })
                    .count();
                if count == 2 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
        let final_native = actor.profile().await.native_session_id;
        transport.stop().await.unwrap();
        let checkpoint_identity = match checkpoint_identity {
            Ok(payload) => payload,
            Err(_) => panic!(
                "hosted OpenCode send must preserve checkpoint identity through the provider; actor events: {:#?}; fixture audit: {}",
                actor.read_events(0, 256).await,
                std::fs::read_to_string(&audit).unwrap_or_default()
            ),
        };
        let rows: Vec<Value> = std::fs::read_to_string(&audit)
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert!(
            spawned_before_send,
            "managed startup must initialize the native daemon before input"
        );
        assert_eq!(pre.unwrap()["threadId"], registered);
        assert_eq!(
            before_send_rows
                .iter()
                .filter(|row| row["event"] == "session_created")
                .count(),
            1
        );
        assert_eq!(
            before_send_rows
                .iter()
                .filter(|row| row["event"] == "prompt_async")
                .count(),
            0
        );
        first.unwrap();
        second.unwrap();
        assert_eq!(
            checkpoint_identity["event"]["logicalAttemptId"],
            "managed-opencode-attempt-1"
        );
        assert_eq!(
            checkpoint_identity["event"]["requestId"],
            "first-owned-send"
        );
        assert!(checkpoint_identity["event"]["nativeTurnId"]
            .as_str()
            .is_some_and(|id| id.starts_with("msg_")));
        observed_prompts.unwrap();
        let identity_receipt_count = actor
            .read_events(0, 256)
            .await
            .events
            .iter()
            .filter(|entry| {
                matches!(
                    &entry.event,
                    AgentEvent::Provider { payload }
                        if payload["event"]["type"] == "checkpointTurnIdentity"
                )
            })
            .count();
        assert_eq!(
            identity_receipt_count, 1,
            "the second legacy send must not create a checkpoint identity receipt"
        );
        let native = identity.unwrap();
        assert_eq!(live.unwrap()["threadId"], native);
        assert_eq!(final_native.as_deref(), Some(native.as_str()));
        assert_eq!(
            rows.iter()
                .filter(|row| row["event"] == "session_created")
                .count(),
            1
        );
        assert_eq!(
            rows.iter()
                .filter(|row| row["event"] == "prompt_async" && row["sessionId"] == native)
                .count(),
            2
        );
    }

    #[tokio::test]
    async fn actual_opencode_snapshot_read_failure_preserves_owned_native_identity() {
        let _lock = NATIVE_PROVIDER_FIXTURE_LOCK.lock().await;
        let dir = tempfile::tempdir().unwrap();
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../test/e2e-browser/fixtures/fake-opencode.cjs")
            .canonicalize()
            .unwrap();
        let audit = dir.path().join("native-audit.jsonl");
        let marker = dir.path().join("snapshot-read-failure");
        let keys = [
            "OPENCODE_CMD",
            "HOME",
            "XDG_DATA_HOME",
            "OPENCODE_DB",
            "FAKE_OPENCODE_AUDIT_LOG",
            "FAKE_OPENCODE_SNAPSHOT_READ_FAILURE_MARKER",
            "FAKE_OPENCODE_SELF_EXIT_MARKER",
            "FAKE_OPENCODE_HANG_SESSION_CREATE",
            "FAKE_OPENCODE_PROMPT_ERROR",
            "FAKE_OPENCODE_TOOL_ERROR",
            "FAKE_OPENCODE_TUI_PARITY",
            "FAKE_OPENCODE_BUSY_AT_LAUNCH",
            "FAKE_OPENCODE_REQUIRE_DIRECTORY_ROUTE",
            "FAKE_OPENCODE_PROJECT_CWD",
        ];
        let _env = SnapshotProviderEnv(
            keys.iter()
                .map(|key| (*key, std::env::var_os(key)))
                .collect(),
        );
        for key in keys {
            std::env::remove_var(key);
        }
        std::env::set_var("OPENCODE_CMD", fixture);
        std::env::set_var("HOME", dir.path());
        std::env::set_var("XDG_DATA_HOME", dir.path().join(".local/share"));
        std::env::set_var("FAKE_OPENCODE_AUDIT_LOG", &audit);
        std::env::set_var("FAKE_OPENCODE_SNAPSHOT_READ_FAILURE_MARKER", &marker);
        std::env::set_var("FAKE_OPENCODE_REQUIRE_DIRECTORY_ROUTE", "1");
        std::env::set_var("FAKE_OPENCODE_PROJECT_CWD", dir.path());
        let transport = HostedTransport::new_with_context(FreshProvider::Opencode, None).await;
        let read_audit = || -> Result<Vec<Value>, String> {
            std::fs::read_to_string(&audit)
                .map_err(|error| error.to_string())?
                .lines()
                .map(serde_json::from_str)
                .collect::<Result<_, _>>()
                .map_err(|error| error.to_string())
        };
        // Capture every outcome, then join the owned fixture before asserting,
        // including the product RED and setup-error paths.
        let observed: Result<Value, String> = async {
            let profile = FreshAgentProfile {
                naming_handle: None,
                collaboration_mode: None,
                provider: FreshProvider::Opencode, runtime_variant: "freshopencode".into(),
                cwd: dir.path().to_string_lossy().into(), model: None, effort: None,
                permission_mode: None, sandbox: None, provider_store_id: "owned-store".into(),
                native_session_id: None, plugins: None, model_selection: None, session_ref: None,
                provider_launch_context: None, provider_secret_references: vec![],
            };
            let actor = FreshAgentHostActor::open(dir.path().join("actor"), profile, transport.clone())
                .await.map_err(|error| error.to_string())?;
            let registered = transport.session_id.lock().await.clone().ok_or("missing registration")?;
            let pre = actor.snapshot().await.map_err(|error| error.to_string())?;
            let spawned_before_send = audit.exists();
            actor.dispatch(RequestId::parse("read-failure-owned-send").unwrap(),
                "Owned conversation before unavailable read".into(), None)
                .await.map_err(|error| error.to_string())?;
            let live = tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    if let Ok(snapshot) = actor.snapshot().await {
                        if snapshot["turns"].as_array().is_some_and(|turns| !turns.is_empty())
                            && serde_json::to_string(&snapshot).unwrap().contains("Fake OpenCode response:") {
                            break snapshot;
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            }).await.map_err(|_| "native prompt did not complete".to_string())?;
            let native = actor.profile().await.native_session_id.ok_or("missing native identity")?;
            tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    if actor.read_events(0, 256).await.events.iter().any(|entry|
                        matches!(&entry.event, AgentEvent::Provider { payload }
                            if payload["sessionId"] == native && payload["event"]["type"] == "freshAgent.turn.complete")) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            }).await.map_err(|_| "actor did not journal native turn completion".to_string())?;
            let journal_path = dir.path().join("actor/fresh-agent-state.json");
            let journal_before = std::fs::read(&journal_path).map_err(|error| error.to_string())?;
            let profile_before = actor.profile().await;
            let db_path = dir.path().join(".local/share/opencode/opencode.db");
            let source_before = std::fs::read(&db_path).map_err(|error| error.to_string())?;
            let ProviderState::Opencode { owner, runtime } = &transport.state else { unreachable!() };
            let launched = read_audit()?;
            let empty_native = launched.iter().find(|row| row["event"] == "launch")
                .and_then(|row| row["rootSessionId"].as_str()).ok_or("missing seeded native empty session")?;
            let healthy_empty = owner.get_opencode_snapshot(empty_native, Some(&profile_before.cwd))
                .await.map_err(|error| error.to_string())?;
            let history_before = freshell_freshagent::native_history::read("opencode", dir.path(), &native)?;
            std::fs::write(&marker, b"fail native snapshot reads").map_err(|error| error.to_string())?;
            let fallback = owner.get_opencode_snapshot(&native, Some(&profile_before.cwd))
                .await.map_err(|error| error.to_string())?;
            let tracked = runtime.has_live_session(&native).await;
            let unavailable = actor.snapshot().await;
            let failures = read_audit()?;
            std::fs::remove_file(&marker).map_err(|error| error.to_string())?;
            let recovered = actor.snapshot().await.map_err(|error| error.to_string())?;
            let history_after = freshell_freshagent::native_history::read("opencode", dir.path(), &native)?;
            let journal_unchanged = std::fs::read(&journal_path).map_err(|error| error.to_string())? == journal_before;
            let source_unchanged = std::fs::read(&db_path).map_err(|error| error.to_string())? == source_before;
            let profile_unchanged = actor.profile().await == profile_before;
            let rows = read_audit()?;
            Ok(json!({ "pre":pre, "registered":registered, "spawnedBeforeSend":spawned_before_send,
                "native":native, "live":live, "healthyEmpty":healthy_empty, "fallback":fallback, "tracked":tracked,
                "unavailable":unavailable.is_err(), "unavailableResult":format!("{unavailable:?}"),
                "recovered":recovered, "historyBefore":history_before, "historyAfter":history_after,
                "journalUnchanged":journal_unchanged, "sourceUnchanged":source_unchanged,
                "profileUnchanged":profile_unchanged, "rows":rows, "failureRows":failures }))
        }.await;
        // Also clear a marker left by any preparation failure before teardown.
        let _ = std::fs::remove_file(&marker);
        let stopped = transport.stop().await;
        stopped.expect("join exact owned OpenCode fixture shutdown");
        let observed =
            observed.expect("establish actual native HTTP read failure and healthy recovery");
        assert_eq!(observed["pre"]["threadId"], observed["registered"]);
        assert_eq!(observed["pre"]["capabilities"]["send"], true);
        assert_eq!(observed["spawnedBeforeSend"], true);
        assert_eq!(observed["live"]["threadId"], observed["native"]);
        assert!(observed["healthyEmpty"]["turns"]
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(observed["healthyEmpty"]["capabilities"]["send"], true);
        assert!(observed["healthyEmpty"]["extensions"]["opencode"]["ownerKind"].is_null());
        assert_eq!(observed["tracked"], true);
        assert_eq!(observed["fallback"]["threadId"], observed["native"]);
        assert_eq!(
            observed["fallback"]["extensions"]["opencode"]["ownerKind"],
            "vacant"
        );
        assert!(observed["fallback"]["turns"].as_array().unwrap().is_empty());
        assert!(observed["fallback"]["extensions"]["opencode"]["nativeHistoryAvailable"].is_null());
        let rows = observed["rows"].as_array().unwrap();
        let serving = rows
            .iter()
            .find(|row| row["event"] == "listen")
            .expect("native server listening");
        let failed: Vec<_> = observed["failureRows"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|row| row["event"] == "snapshot_read_failed")
            .collect();
        assert!(
            failed.len() >= 2,
            "getter and actor must both execute the failed native HTTP read"
        );
        for row in failed {
            assert_eq!(row["sessionId"], observed["native"]);
            assert_eq!(row["routeDirectory"], dir.path().to_string_lossy().as_ref());
            assert_eq!(row["pid"], serving["pid"]);
        }
        assert_eq!(
            rows.iter().filter(|row| row["event"] == "listen").count(),
            1
        );
        assert_eq!(
            rows.iter()
                .filter(|row| row["event"] == "session_created")
                .count(),
            1
        );
        assert_eq!(
            rows.iter()
                .filter(|row| row["event"] == "prompt_async")
                .count(),
            1
        );
        assert!(!rows
            .iter()
            .any(|row| row["event"] == "self_exit" || row["event"] == "shutdown"));
        assert_eq!(observed["recovered"]["threadId"], observed["native"]);
        assert_eq!(
            observed["recovered"]["extensions"]["opencode"]["statusFromLiveState"],
            true
        );
        assert_eq!(observed["historyBefore"], observed["historyAfter"]);
        assert_eq!(observed["historyAfter"]["threadId"], observed["native"]);
        assert_eq!(observed["historyAfter"]["capabilities"]["send"], false);
        assert_eq!(
            observed["historyAfter"]["extensions"]["opencode"]["nativeHistoryAvailable"],
            true
        );
        assert_eq!(observed["journalUnchanged"], true);
        assert_eq!(observed["sourceUnchanged"], true);
        assert_eq!(observed["profileUnchanged"], true);
        assert_eq!(
            observed["unavailable"], true,
            "vacant native fallback must not certify live truth: {}",
            observed["unavailableResult"]
        );
    }

    #[tokio::test]
    async fn actual_opencode_zero_turn_snapshot_keeps_pre_input_native_identity_without_prompt() {
        let _lock = NATIVE_PROVIDER_FIXTURE_LOCK.lock().await;
        let dir = tempfile::tempdir().unwrap();
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../test/e2e-browser/fixtures/fake-opencode.cjs")
            .canonicalize()
            .unwrap();
        let keys = [
            "OPENCODE_CMD",
            "HOME",
            "XDG_DATA_HOME",
            "OPENCODE_DB",
            "FAKE_OPENCODE_AUDIT_LOG",
            "FAKE_OPENCODE_SNAPSHOT_READ_FAILURE_MARKER",
            "FAKE_OPENCODE_SELF_EXIT_MARKER",
            "FAKE_OPENCODE_HANG_SESSION_CREATE",
            "FAKE_OPENCODE_PROMPT_ERROR",
            "FAKE_OPENCODE_TOOL_ERROR",
            "FAKE_OPENCODE_TUI_PARITY",
            "FAKE_OPENCODE_BUSY_AT_LAUNCH",
            "FAKE_OPENCODE_REQUIRE_DIRECTORY_ROUTE",
            "FAKE_OPENCODE_PROJECT_CWD",
        ];
        let _env = SnapshotProviderEnv(
            keys.iter()
                .map(|key| (*key, std::env::var_os(key)))
                .collect(),
        );
        for key in keys {
            std::env::remove_var(key);
        }
        let audit = dir.path().join("native-audit.jsonl");
        std::env::set_var("OPENCODE_CMD", fixture);
        std::env::set_var("HOME", dir.path());
        std::env::set_var("XDG_DATA_HOME", dir.path().join("data"));
        std::env::set_var("FAKE_OPENCODE_AUDIT_LOG", &audit);
        let transport = HostedTransport::new_with_context(FreshProvider::Opencode, None).await;
        let profile = FreshAgentProfile {
            naming_handle: None,
            collaboration_mode: None,
            provider: FreshProvider::Opencode,
            runtime_variant: "freshopencode".into(),
            cwd: dir.path().to_string_lossy().into(),
            model: None,
            effort: None,
            permission_mode: None,
            sandbox: None,
            provider_store_id: "owned-store".into(),
            native_session_id: None,
            plugins: None,
            model_selection: None,
            session_ref: None,
            provider_launch_context: None,
            provider_secret_references: vec![],
        };
        let actor = FreshAgentHostActor::open(dir.path(), profile, transport.clone())
            .await
            .unwrap();
        let registered = transport.session_id.lock().await.clone().unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if actor.read_events(0, 256).await.events.iter().any(|entry| {
                    matches!(&entry.event,AgentEvent::Provider {payload}
                        if payload["event"]["type"]=="freshAgent.native.loaded")
                }) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("journal the genuine managed startup load before testing snapshot purity");
        let before = std::fs::read(dir.path().join("fresh-agent-state.json")).unwrap();
        let result = actor.snapshot().await;
        let after = std::fs::read(dir.path().join("fresh-agent-state.json")).unwrap();
        let native = actor.profile().await.native_session_id;
        let fork = actor.fork(RequestId::new(), registered.clone(), None).await;
        let fork_evidence = actor.observed_native_identity_evidence().await;
        let fork_snapshot = actor.snapshot().await;
        let fork_capture = actor.capture(1024).await;
        transport.stop().await.unwrap();
        let snapshot = result.expect("registered zero-turn OpenCode is live snapshot truth");
        assert_eq!(snapshot["threadId"], registered);
        assert_eq!(snapshot["sessionType"], "freshopencode");
        assert_eq!(snapshot["provider"], "opencode");
        assert_eq!(snapshot["capabilities"]["send"], true);
        assert!(snapshot["turns"].as_array().unwrap().is_empty());
        assert_eq!(
            snapshot["extensions"]["opencode"]["statusFromLiveState"],
            true
        );
        assert_eq!(native.as_deref(), Some(registered.as_str()));
        let fork = fork.expect("controlled native HTTP fork succeeds without a prompt");
        assert_eq!(
            fork_snapshot.expect("snapshot reads the acknowledged native child")["threadId"],
            fork.child_session_id
        );
        assert_eq!(
            fork_capture
                .expect("capture reads the acknowledged native child")
                .native_session_id,
            fork.child_session_id
        );
        assert_eq!(
            fork_evidence
                .as_ref()
                .and_then(|value| value.get("nativeSessionId"))
                .and_then(Value::as_str),
            Some(fork.child_session_id.as_str()),
            "the real hosted fork path must replace its retired-parent producer evidence"
        );
        let rows: Vec<Value> = std::fs::read_to_string(&audit)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(
            rows.iter()
                .filter(|row| row["event"] == "session_created")
                .count(),
            1
        );
        assert_eq!(
            rows.iter()
                .filter(|row| row["event"] == "prompt_async")
                .count(),
            0
        );
        assert!(
            after == before,
            "a zero-turn snapshot must not write the settled actor journal"
        );
    }

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
        fn record_provider_create(&self, create: &FreshAgentCreate) {
            self.trace.record(
                "provider_create_request",
                serde_json::to_value(create).expect("provider create serializes"),
                "submitted",
            );
        }

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
                FreshAgentOperation::Configure { .. } => "configure",
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
                (FreshProvider::Opencode, "approval" | "question")
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
                            ..
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
                native_identity: None,
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
            // Every provider forks natively (claude since C14).
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
                    FreshAgentOperation::Configure { .. } => "configure",
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

    impl HostedTransportTestDelegate for ParityFixtureTransport {
        fn record_provider_create(&self, create: &FreshAgentCreate) {
            ParityFixtureTransport::record_provider_create(self, create);
        }
    }

    #[test]
    fn prepared_codex_approval_intent_reaches_create_without_becoming_explicit() {
        let mut profile = parity_profile(FreshProvider::Codex);
        profile.permission_mode = None;
        let mut context =
            serde_json::to_value(profile.provider_launch_context.as_ref().unwrap()).unwrap();
        context["preparation"]["codex"]["approval_default"] = json!({
            "policy":"untrusted", "logicalSource":"/original/.codex/config.toml",
            "canonicalSource":"/original/.codex/config.toml", "sourceSha256":"a".repeat(64)
        });
        profile.provider_launch_context = Some(
            serde_json::from_value(context)
                .expect("prepared native policy descriptor must survive the protocol boundary"),
        );
        for permission_mode in [None, Some("default".to_string())] {
            profile.permission_mode = permission_mode.clone();
            assert_eq!(
                create_request_for_profile(&profile)
                    .permission_mode
                    .as_deref(),
                Some("untrusted")
            );
            assert_eq!(
                send_settings_for_profile(&profile)
                    .permission_mode
                    .as_deref(),
                Some("untrusted")
            );
            assert_eq!(
                profile.permission_mode, permission_mode,
                "inherited policy must remain distinguishable from explicit settings"
            );
            let replayed: FreshAgentProfile =
                serde_json::from_slice(&serde_json::to_vec(&profile).unwrap()).unwrap();
            assert_eq!(
                create_request_for_profile(&replayed)
                    .permission_mode
                    .as_deref(),
                Some("untrusted")
            );
        }
        profile.permission_mode = Some("never".into());
        assert_eq!(
            create_request_for_profile(&profile)
                .permission_mode
                .as_deref(),
            Some("never")
        );
    }

    fn parity_profile(provider: FreshProvider) -> FreshAgentProfile {
        let preparation = match provider {
            FreshProvider::Claude => ProviderPreparation::Claude {
                mcp_args: Vec::new(),
            },
            FreshProvider::Codex => ProviderPreparation::Codex {
                approval_default: None,
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
            naming_handle: None,
            collaboration_mode: None,
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
                prepared_inputs: None,
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
                provider_relative_path: None,
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
            FreshAgentOperation::Configure {
                settings: freshell_runtime_protocol::FreshAgentTurnSettings {
                    collaboration_mode: None,
                    cwd: None,
                    model: Some("fixture-configured-model".into()),
                    effort: Some(Some("high".into())),
                    permission_mode: Some("acceptEdits".into()),
                    sandbox: None,
                },
            },
        ]
    }

    fn direct_ingress_create(profile: &FreshAgentProfile) -> FreshAgentCreate {
        let session_type = match profile.provider {
            FreshProvider::Claude => "freshclaude",
            FreshProvider::Codex => "freshcodex",
            FreshProvider::Opencode => "freshopencode",
            FreshProvider::Kilroy => unreachable!(),
        };
        let provider = match profile.provider {
            FreshProvider::Claude => AgentProvider::Claude,
            FreshProvider::Codex => AgentProvider::Codex,
            FreshProvider::Opencode => AgentProvider::Opencode,
            FreshProvider::Kilroy => unreachable!(),
        };
        // Model the direct route's decoded wire message, then pass it through
        // the same shared ingress helper used by the live WebSocket handler.
        let create = serde_json::from_value(json!({
            "requestId": format!("direct-create-{}", profile.provider.as_str()),
            "observedEpoch": 7,
            "observedGeneration": 3,
            "namingHandle": "display-only-name-handle",
            "sessionType": session_type,
            "cwd": profile.cwd,
            "effort": profile.effort,
            "model": profile.model,
            "modelSelection": profile.model_selection.as_ref().map(|selection| selection.as_ref().map(|selection| json!({
                "kind": selection.kind,
                "modelId": selection.model_id,
            }))),
            "permissionMode": if profile.provider == FreshProvider::Codex
                && profile.permission_mode.as_deref() == Some("default") {
                    None
                } else {
                    profile.permission_mode.clone()
                },
            "plugins": profile.plugins,
            "provider": provider,
            "sandbox": profile.sandbox.as_deref().and_then(parse_sandbox),
            "sessionRef": profile.session_ref.as_ref().map(|reference| json!({
                "provider": reference.provider,
                "sessionId": reference.session_id,
            })),
            "tabId": "display-only-tab",
        }))
        .expect("direct route wire request deserializes");
        freshell_protocol::direct_provider_create(create)
            .expect("fixture uses the direct provider ingress")
    }

    fn direct_profile_from_create(
        message: &FreshAgentCreate,
        provider_context: &FreshAgentProfile,
    ) -> FreshAgentProfile {
        let mut profile = provider_context.clone();
        profile.cwd = message.cwd.clone().unwrap();
        profile.model = message.model.clone();
        profile.effort = message.effort.clone().flatten();
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
        let direct_create = direct_ingress_create(profile);
        transport.record_provider_create(&direct_create);
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
            // The direct route stores configured settings on the live
            // session, so its later resume launches with them.
            if let FreshAgentOperation::Configure { settings } = operation {
                profile.apply_configure_settings(settings);
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
        let direct_resume_create = direct_ingress_create(profile);
        transport.record_provider_create(&direct_resume_create);
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
        let transition = fork.expect("every provider forks natively (claude since C14)");
        assert_eq!(
            actor.profile().await.native_session_id.as_deref(),
            Some(transition.child_session_id.as_str()),
            "the actor follows the fork to its child"
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
            let direct_create = direct_ingress_create(&seed_profile);
            let direct_profile = direct_profile_from_create(&direct_create, &seed_profile);
            let hosted_profile = parity_hosted_profile(&seed_profile);
            let mut hosted_provider_profile = hosted_profile.clone();
            hosted_provider_profile
                .provider_launch_context
                .as_mut()
                .unwrap()
                .mcp_capability = None;
            hosted_provider_profile.permission_mode =
                effective_permission_mode(&hosted_provider_profile);
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
                hosted_provider_profile.clone(),
                dir.path(),
            )
            .await;

            let direct_rows = trace.rows("direct");
            let hosted_rows = trace.rows("hosted");
            let normalized_create_requests = |rows: &[TransportObservation]| {
                rows.iter()
                    .filter(|row| row.operation == "provider_create_request")
                    .map(|row| {
                        let mut request = row.input.clone();
                        for field in [
                            "requestId",
                            "namingHandle",
                            "tabId",
                            "observedEpoch",
                            "observedGeneration",
                        ] {
                            request.as_object_mut().unwrap().remove(field);
                        }
                        request
                    })
                    .collect::<Vec<_>>()
            };
            assert_eq!(
                normalized_create_requests(&direct_rows),
                normalized_create_requests(&hosted_rows),
                "actual direct-ingress and HostedTransport create requests differ for {provider:?}"
            );
            let project = |rows: Vec<TransportObservation>| {
                rows.into_iter()
                    .filter(|row| row.operation != "provider_create_request")
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
                "configure",
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
            let resumed_native = format!("native-{}-fork", provider.as_str());
            assert_eq!(
                create_rows[1].input["nativeSessionId"], resumed_native,
                "the restart resumes the fork's child"
            );
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
                    ..
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
                    ..
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
            if let Ok(directory) = std::env::var("FRESHELL_PROVIDER_PARITY_ROWS_DIR") {
                let provider_rows = |rows: &[TransportObservation]| {
                    rows.iter()
                        .map(|row| {
                            let mut input = row.input.clone();
                            if row.operation == "provider_create_request" {
                                for field in [
                                    "requestId",
                                    "namingHandle",
                                    "tabId",
                                    "observedEpoch",
                                    "observedGeneration",
                                ] {
                                    input.as_object_mut().unwrap().remove(field);
                                }
                            }
                            json!({"operation": row.operation, "input": input, "result": row.result})
                        })
                        .collect::<Vec<_>>()
                };
                let evidence = json!({
                    "provider": provider.as_str(),
                    "direct": {"profile": profile, "operations": provider_rows(&direct_rows), "mcpExposed": direct_mcp_enabled},
                    "managed": {"profile": hosted_provider_profile, "operations": provider_rows(&hosted_rows), "mcpExposed": hosted_mcp_enabled},
                    "recovery": {
                        "replacementObserved": create_rows.len() == 2,
                        "sameNativeSession": create_rows[1].input["nativeSessionId"] == resumed_native,
                    },
                });
                std::fs::create_dir_all(&directory).unwrap();
                std::fs::write(
                    std::path::Path::new(&directory)
                        .join(format!("fresh-{}.json", provider.as_str())),
                    serde_json::to_vec(&evidence).unwrap(),
                )
                .unwrap();
            }
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
                    approval_default: None,
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
                naming_handle: None,
                collaboration_mode: None,
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
            prepared_inputs: None,
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
                    provider_relative_path: None,
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
                        ..
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
                "permissionMode":effective_permission_mode(&profile), "sandbox":"workspace-write",
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

    #[test]
    fn hosted_codex_create_uses_provider_default_for_default_permission_mode() {
        let profile = parity_profile(FreshProvider::Codex);

        assert_eq!(
            create_request_for_profile(&profile).permission_mode,
            None,
            "the UI's default sentinel is not a Codex approval policy"
        );
        assert_eq!(
            send_settings_for_profile(&profile).permission_mode,
            None,
            "Codex send settings must keep using its provider default"
        );

        for policy in ["untrusted", "on-failure", "on-request", "never"] {
            let mut explicit = profile.clone();
            explicit.permission_mode = Some(policy.into());
            assert_eq!(
                create_request_for_profile(&explicit)
                    .permission_mode
                    .as_deref(),
                Some(policy)
            );
            assert_eq!(
                send_settings_for_profile(&explicit)
                    .permission_mode
                    .as_deref(),
                Some(policy)
            );
        }

        for provider in [
            FreshProvider::Claude,
            FreshProvider::Opencode,
            FreshProvider::Kilroy,
        ] {
            let mut other = parity_profile(if provider == FreshProvider::Kilroy {
                FreshProvider::Claude
            } else {
                provider.clone()
            });
            other.provider = provider;
            assert_eq!(
                create_request_for_profile(&other)
                    .permission_mode
                    .as_deref(),
                Some("default"),
                "non-Codex provider defaults remain unchanged"
            );
            assert_eq!(
                send_settings_for_profile(&other).permission_mode.as_deref(),
                Some("default")
            );
        }
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
            find_operation_session_id(
                &json!({
                    "type":"freshAgent.event",
                    "event":{
                        "type":"freshAgent.rolledBack",
                        "requestId":"current-operation",
                        "sessionId":"old-native",
                        "newSessionId":"new-native"
                    }
                }),
                "current-operation"
            ),
            Some("new-native".into())
        );
        assert_eq!(
            find_operation_session_id(
                &json!({"type":"freshAgent.redone", "requestId":"previous-operation", "newSessionId":"stale-child"}),
                "current-operation"
            ),
            None
        );
    }
}

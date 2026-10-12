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
        let Some(prior) = self.rejected_parent.take() else {
            return false;
        };
        // All admitted codes precede the respective handler's first native
        // mutation. Codex can respawn before validation, so the caller must
        // also establish the unchanged native process. Never infer rejection
        // from generic errors, RPC failures or Claude's quiesce timeout.
        let before_mutation = match provider {
            FreshProvider::Claude | FreshProvider::Kilroy | FreshProvider::Opencode => {
                matches!(
                    code,
                    "INVALID_ROLLBACK_TARGET" | "NOTHING_TO_UNDO" | "REDO_UNAVAILABLE"
                )
            }
            FreshProvider::Codex => matches!(code, "INVALID_ROLLBACK_TARGET" | "NOTHING_TO_UNDO"),
        };
        if !before_mutation
            || !self.pending
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
        if self.root.as_deref().is_some_and(|current| current != root)
            || self
                .launch
                .as_ref()
                .and_then(|launch| launch.requested_native_session_id.as_deref())
                .is_some_and(|expected| expected != root)
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
    profile: std::sync::Mutex<Option<FreshAgentProfile>>,
    session_id: Mutex<Option<String>>,
    // Native runtime that produced the current create/fork/rollback proof.
    // Runtime identity alone never supplies native observation.
    native_incarnation: Mutex<Option<String>>,
    prepared_native_checkpoints: std::sync::Mutex<Option<Vec<Value>>>,
    created_rx: Mutex<watch::Receiver<Option<Result<String, String>>>>,
    native_rx: Mutex<watch::Receiver<Option<String>>>,
    native_identity: Arc<std::sync::Mutex<HostedNativeIdentity>>,
    send_outcomes: broadcast::Sender<(String, bool)>,
    kill_outcomes: broadcast::Sender<(String, bool)>,
    suppressed_kills: Arc<std::sync::Mutex<HashSet<String>>>,
    event_tx: mpsc::Sender<AgentEvent>,
    event_rx: std::sync::Mutex<Option<mpsc::Receiver<AgentEvent>>>,
    #[cfg(test)]
    test_delegate: Option<Arc<dyn HostedTransportTestDelegate>>,
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
    open_actor_for_transport(
        HOST_ACTOR_STATE_DIR,
        profile,
        transport,
        launch.fixture_transport,
    )
    .await
    .map_err(|error| error.to_string())
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
            FreshProvider::Claude | FreshProvider::Kilroy => ProviderState::Claude(
                FreshClaudeState::new(Arc::clone(&broadcast_tx)).with_managed_forks(),
            ),
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
        let (native_evidence_tx, _) = watch::channel(None);
        let native_identity = Arc::new(std::sync::Mutex::new(HostedNativeIdentity::default()));
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
            profile: std::sync::Mutex::new(None),
            session_id: Mutex::new(None),
            native_incarnation: Mutex::new(None),
            prepared_native_checkpoints: std::sync::Mutex::new(None),
            created_rx: Mutex::new(created_rx),
            native_rx: Mutex::new(native_rx),
            native_identity,
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
            .session_id
            .lock()
            .await
            .clone()
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
        let current = self.session_id.lock().await.clone()?;
        let identity = self.native_identity.lock().expect("native identity lock");
        if identity.pending || identity.root.as_ref() != Some(&current) {
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
            ProviderState::Claude(state) => state.handle_create(create, None).await,
            ProviderState::Codex(state) => state.handle_create(create, None).await,
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
            None if matches!(self.provider, FreshProvider::Opencode) => {
                Some(self.wait_exact_native(&session_id).await?)
            }
            None => None,
        };
        if matches!(self.provider, FreshProvider::Claude | FreshProvider::Kilroy) {
            // The Claude adapter's live registration is indexed by the native
            // UUID. The temporary SDK create key is not a live-session lookup.
            *self.session_id.lock().await = native_session_id.clone();
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
        self.native_identity
            .lock()
            .expect("native identity lock")
            .begin(false)
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
        self.remember_native_runtime(&child).await;
        self.native_identity
            .lock()
            .expect("native identity lock")
            .acknowledge(&child, Some(evidence))
            .map_err(|message| DispatchFailure {
                message,
                acceptance_ambiguous: true,
            })?;
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
                ProviderState::Claude(state) => state
                    .dispatch_question_checked(message)
                    .await
                    .map_err(|failure| DispatchFailure {
                        message: failure.message,
                        acceptance_ambiguous: failure.acceptance_ambiguous,
                    })?,
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
                ProviderState::Claude(state) => state
                    .dispatch_approval_checked(message)
                    .await
                    .map_err(|failure| DispatchFailure {
                        message: failure.message,
                        acceptance_ambiguous: failure.acceptance_ambiguous,
                    })?,
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
                    }) && self.session_id.lock().await.as_ref()
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
        let session_id = self.session_id.lock().await.clone()?;
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
        pane_id: None,
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

fn spawn_broadcast_bridge(
    provider: FreshProvider,
    mut receiver: broadcast::Receiver<String>,
    outputs: BroadcastBridgeOutputs,
) {
    let expected_launch = freshell_platform::managed_child_secrets::snapshot()
        .and_then(|environment| environment.get(super::native_identity::LAUNCH_ENV).cloned())
        .and_then(|value| {
            serde_json::from_str::<freshell_runtime_protocol::NativeIdentityLaunch>(&value).ok()
        });
    let BroadcastBridgeOutputs {
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
    {
        let mut identity = native_identity.lock().expect("native identity lock");
        identity.launch = expected_launch.clone();
        identity.producer_launch = expected_launch;
    }
    tokio::spawn(async move {
        let mut dropped = 0u64;
        let mut native_query_generation = 0u64;
        let mut query_launch = None;
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
            let expected_launch = native_identity
                .lock()
                .expect("native identity lock")
                .producer_launch
                .clone();
            if query_launch != expected_launch {
                query_launch = expected_launch.clone();
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
                && matches!(provider, FreshProvider::Codex | FreshProvider::Opencode)
            {
                if let Some(session_id) = value.get("sessionId").and_then(Value::as_str) {
                    if publish_native_identity(
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
                if event_type == "freshAgent.session.init" {
                    let generation = event["nativeIdentityEvidence"]["queryGeneration"].as_u64();
                    if generation.is_some_and(|generation| generation < native_query_generation)
                        || (expected_launch.is_some()
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
                    if let Some(session_id) = event
                        .get("cliSessionId")
                        .and_then(Value::as_str)
                        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
                        .filter(|id| {
                            expected_launch
                                .as_ref()
                                .and_then(|launch| launch.requested_native_session_id.as_deref())
                                .is_none_or(|expected| expected == *id)
                        })
                    {
                        let reception = publish_native_identity(&native_identity, session_id,
                            event.get("nativeIdentityEvidence").cloned().unwrap_or_else(||json!({"nativeSessionId":session_id,"source":"native_sdk_system_init"})),
                            &native, &native_evidence);
                        if reception != NativeProofReception::Rejected {
                            if let Some(generation) = generation {
                                native_query_generation = generation;
                            }
                        }
                        if reception == NativeProofReception::Published
                            && events
                                .send(AgentEvent::Started {
                                    native_session_id: session_id.to_string(),
                                })
                                .await
                                .is_err()
                        {
                            break;
                        }
                    } else if matches!(provider, FreshProvider::Claude | FreshProvider::Kilroy) {
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
                                .filter(|source| matches!(*source, "startup" | "resume")),
                            "queryGeneration":generation,"nativeReceiverPublished":false,
                            "nativeReceiverContainsIdentity":native.borrow().is_some()});
                        crate::emit_environment_event(record.clone());
                        #[cfg(test)]
                        if let Some(observer) = refusal_observer.as_ref() {
                            let _ = observer.try_send(record);
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

    static OPENCODE_SNAPSHOT_ENV_LOCK: Mutex<()> = Mutex::const_new(());

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
                spawn_broadcast_bridge(
                    provider.clone(),
                    receiver,
                    BroadcastBridgeOutputs {
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
        spawn_broadcast_bridge(
            FreshProvider::Claude,
            receiver,
            BroadcastBridgeOutputs {
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
            spawn_broadcast_bridge(
                FreshProvider::Claude,
                receiver,
                BroadcastBridgeOutputs {
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
            spawn_broadcast_bridge(
                FreshProvider::Claude,
                receiver,
                BroadcastBridgeOutputs {
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
        let _lock = OPENCODE_SNAPSHOT_ENV_LOCK.lock().await;
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
                std::fs::write(&query_module, format!(
                    "import {{ appendFile }} from 'node:fs/promises';\nimport {{ query as controlledQuery }} from {};\nexport function query(args) {{ const options = {{...args.options, sessionId:args.options.sessionId ?? args.options.resume}}; const prompt = (async function* () {{ for await (const message of args.prompt) {{ await appendFile({}, options.sessionId + '\\n'); yield message; }} }})(); return controlledQuery({{...args, prompt, options}}) }}\n",
                    json!(repo.join("test/unit/claude-sidecar/fixtures/native-startup-query.mjs")), json!(input_receipt))).unwrap();
                std::env::set_var("FRESHELL_CLAUDE_SDK_QUERY_MODULE", &query_module);
                std::env::set_var("FRESHELL_NATIVE_IDENTITY_LAUNCH", json!(launch).to_string());
                if followup != "undo" {
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
                        if followup == "retired" {
                            if !matches!(undo, Err(freshell_agent_runtime::host_actor::ActorError::AmbiguousDispatch))
                                || transport.provider_session_is_live(PARENT).await
                                || crate::fresh_native_observation(&launch, &actor).await.is_some()
                                || actor.capture(4096).await.is_ok()
                                || actor.dispatch(RequestId::parse("retired-parent-input").unwrap(), "must not run".into(), None).await.is_ok() {
                                return Err("post-retirement failure revived the old parent".into());
                            }
                            return Ok(());
                        }
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
                spawn_broadcast_bridge(
                    provider.clone(),
                    receiver,
                    BroadcastBridgeOutputs {
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
        let _lock = OPENCODE_SNAPSHOT_ENV_LOCK.lock().await;
        let owned = tempfile::tempdir().unwrap();
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
            let snapshot = actor.snapshot().await.map_err(|error| error.to_string())?;
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
                if actor.snapshot().await.map_err(|error| error.to_string())? != snapshot {
                    return Err("rejected rollback changed native snapshot".into());
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
        spawn_broadcast_bridge(
            FreshProvider::Claude,
            receiver,
            BroadcastBridgeOutputs {
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
        let _lock = OPENCODE_SNAPSHOT_ENV_LOCK.lock().await;
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
        let bridge_still_live =
            unsafe { libc::kill(before[0]["bridgePid"].as_i64().unwrap() as i32, 0) } == 0;
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
            "native SDK worker death must reach host liveness while its bridge stdout remains open"
        );
        assert!(
            bridge_still_live,
            "native death detection must not kill the healthy Node bridge"
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
    async fn normalized_claude_init_reaches_current_host_native_receiver() {
        let _lock = OPENCODE_SNAPSHOT_ENV_LOCK.lock().await;
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
            repo.join("test/unit/claude-sidecar/fixtures/settings-query-module.mjs")
                .canonicalize()
                .unwrap(),
        );
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
            let observed_evidence = transport.native_identity_evidence().await;
            let mut receiver = transport.native_rx.lock().await;
            let native = tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    if let Some(native) = receiver.borrow().clone() {
                        return Some(native);
                    }
                    if receiver.changed().await.is_err() {
                        return None;
                    }
                }
            })
            .await
            .unwrap_or(None);
            drop(receiver);
            state.shutdown().await;
            assert!(
                observed_live,
                "the observed native session must remain a live host transport after startup"
            );
            assert!(observed_evidence.is_some());
            assert_ne!(
                created,
                profile.native_session_id.clone().unwrap(),
                "local key is separate"
            );
            assert_eq!(native,profile.native_session_id,
                "production sidecar sdk.session.init must pass the actual upstream normalizer and reach the host");
        }
    }

    #[tokio::test]
    async fn hosted_checkpoint_recovery_stages_without_input_and_releases_current_native_ask_once()
    {
        let _lock = OPENCODE_SNAPSHOT_ENV_LOCK.lock().await;
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
        let _lock = OPENCODE_SNAPSHOT_ENV_LOCK.lock().await;
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
            profile.native_session_id = None;
            profile.session_ref = None;
            profile.provider_launch_context = None;
            profile.provider_secret_references.clear();
            profile.plugins = None;
            profile.permission_mode = Some("default".into());
            std::env::set_var("FRESHELL_SIDECAR_TEST_NATIVE_REQUEST_ID", "native-old");
            let original = HostedTransport::new(provider.clone()).await;
            let actor_dir = owned.path().join("actor");
            let actor = FreshAgentHostActor::open(&actor_dir, profile.clone(), original.clone())
                .await
                .unwrap();
            actor
                .dispatch(
                    RequestId::parse("original-operation").unwrap(),
                    "owned original operation".into(),
                    None,
                )
                .await
                .unwrap();
            let old_card = tokio::time::timeout(Duration::from_secs(3), async {
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
            .await
            .unwrap();
            let checkpoint = old_card["nativeCheckpoint"].clone();
            assert!(actor.is_live().await,
                "the ended query preceding native checkpoint continuation must not close its current replacement");
            profile = actor.profile().await;
            assert_eq!(profile.native_session_id.as_deref(), Some(native));
            if let ProviderState::Claude(state) = &original.state {
                state.shutdown().await;
            }
            drop(actor);
            tokio::task::yield_now().await;
            std::env::set_var("FRESHELL_SIDECAR_TEST_NATIVE_REQUEST_ID", "native-new");
            let current = HostedTransport::new(provider).await;
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
            let before = std::fs::read(owned.path().join("native.jsonl")).unwrap();
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
            assert_eq!(identity_before_repeat.0.as_deref(), Some(native));
            assert!(identity_before_repeat.1.is_some());
            assert_eq!(identity_after_repeat, identity_before_repeat);
            assert_eq!(
                std::fs::read(owned.path().join("native.jsonl")).unwrap(),
                before,
                "parked native ask must not execute or rewrite history"
            );
            assert!(!owned.path().join("effect-count").exists());
        }
    }

    #[tokio::test]
    async fn actual_opencode_bootstrap_materializes_once_before_send_and_reuses_owned_native_http_session(
    ) {
        let _lock = OPENCODE_SNAPSHOT_ENV_LOCK.lock().await;
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
            .dispatch(
                RequestId::parse("first-owned-send").unwrap(),
                "First owned prompt".into(),
                None,
            )
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
        observed_prompts.unwrap();
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
        let _lock = OPENCODE_SNAPSHOT_ENV_LOCK.lock().await;
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
        let _lock = OPENCODE_SNAPSHOT_ENV_LOCK.lock().await;
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

    impl HostedTransportTestDelegate for ParityFixtureTransport {
        fn record_provider_create(&self, create: &FreshAgentCreate) {
            ParityFixtureTransport::record_provider_create(self, create);
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
            "permissionMode": profile.permission_mode,
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
            let direct_create = direct_ingress_create(&seed_profile);
            let direct_profile = direct_profile_from_create(&direct_create, &seed_profile);
            let hosted_profile = parity_hosted_profile(&seed_profile);
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

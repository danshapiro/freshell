//! Durable, provider-neutral ownership for one fresh-agent conversation.
//!
//! The actor lives in the per-soul session host. A web gateway owns only an
//! event cursor; dropping that cursor cannot drop the provider transport.

use async_trait::async_trait;
pub use freshell_runtime_protocol::{
    AgentEvent, AgentEventBatch as EventBatch, AgentJournalEvent as JournalEvent, FreshProvider,
};
use freshell_runtime_protocol::{
    CommandState, FreshAgentCapture, FreshAgentRollbackDirection, FreshAgentRollbackMode,
    FreshAgentTurnSettings, RequestId,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::Mutex;

pub const DEFAULT_EVENT_BYTES: usize = 4 * 1024 * 1024;
pub const DEFAULT_EVENT_COUNT: usize = 4_096;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentProfile {
    pub provider: FreshProvider,
    pub runtime_variant: String,
    pub cwd: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<String>,
    pub sandbox: Option<String>,
    pub provider_store_id: String,
    pub native_session_id: Option<String>,
}

impl FreshAgentProfile {
    pub fn validate(&self) -> Result<(), ActorError> {
        if self.runtime_variant.is_empty()
            || self.cwd.is_empty()
            || self.provider_store_id.is_empty()
            || self.native_session_id.as_deref().is_some_and(str::is_empty)
        {
            return Err(ActorError::InvalidProfile);
        }
        if [
            self.model.as_deref(),
            self.effort.as_deref(),
            self.permission_mode.as_deref(),
            self.sandbox.as_deref(),
        ]
        .into_iter()
        .flatten()
        .any(|value| value.len() > 256 || value.chars().any(char::is_control))
        {
            return Err(ActorError::InvalidProfile);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportStart {
    /// Zero-turn Claude/OpenCode sessions may not have materialized a durable
    /// provider identity yet. The event pump records it before it is exposed
    /// as durable inventory.
    pub native_session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatchAck {
    pub provider_ack_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperationAck {
    pub provider_ack_id: Option<String>,
    /// Some rollback implementations materialize a new provider-native
    /// conversation while retaining the Freshell presentation identity.
    pub native_session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatchFailure {
    pub message: String,
    /// True when the request crossed the transport's acceptance boundary or
    /// the transport cannot prove that it did not.
    pub acceptance_ambiguous: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkTransition {
    pub parent_session_id: String,
    pub child_session_id: String,
    /// True only after the provider-owned parent writer/session has been
    /// retired inside this same soul. This lets the web avoid translating a
    /// provider-native branch operation into a destructive whole-soul stop.
    pub parent_retired_by_runtime: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationFailureKind {
    Unsupported,
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperationFailure {
    pub kind: OperationFailureKind,
    pub message: String,
    pub acceptance_ambiguous: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub enum FreshAgentOperation {
    Compact {
        instructions: Option<String>,
        cwd: Option<String>,
    },
    Rollback {
        direction: FreshAgentRollbackDirection,
        mode: FreshAgentRollbackMode,
        turn_id: Option<String>,
        cwd: Option<String>,
    },
}

#[async_trait]
pub trait FreshAgentTransport: Send + Sync {
    async fn start(&self, profile: &FreshAgentProfile) -> Result<TransportStart, String>;
    async fn dispatch(
        &self,
        request_id: &RequestId,
        text: &str,
        profile: &FreshAgentProfile,
    ) -> Result<DispatchAck, DispatchFailure>;
    async fn resolve_permission(
        &self,
        decision_id: &str,
        decision: Value,
    ) -> Result<(), DispatchFailure>;
    /// Branch the provider-native conversation inside this owned soul. Providers
    /// without a native fork surface return a deterministic unsupported error.
    async fn fork(
        &self,
        _request_id: &RequestId,
        _parent_session_id: &str,
        _input: Option<Value>,
    ) -> Result<ForkTransition, DispatchFailure> {
        Err(DispatchFailure {
            message: "provider-native conversation fork is unsupported".into(),
            acceptance_ambiguous: false,
        })
    }
    async fn interrupt(&self) -> Result<(), String>;
    async fn supports_operation(&self, _operation: &FreshAgentOperation) -> Result<bool, String> {
        Ok(false)
    }
    async fn dispatch_operation(
        &self,
        _request_id: &RequestId,
        _operation: &FreshAgentOperation,
    ) -> Result<OperationAck, OperationFailure> {
        Err(OperationFailure {
            kind: OperationFailureKind::Unsupported,
            message: "provider does not support this operation".into(),
            acceptance_ambiguous: false,
        })
    }
    async fn capture(&self, _max_bytes: usize) -> Result<FreshAgentCapture, String> {
        Err("provider does not expose a hosted snapshot".into())
    }
    /// Whether this actor still owns a usable provider enclosure. Provider
    /// adapters may self-heal a child internally; they should report false
    /// only when no live owned session remains.
    async fn is_live(&self) -> bool {
        true
    }
    async fn stop(self: Arc<Self>) -> Result<(), String>;
    fn take_event_stream(&self) -> Option<tokio::sync::mpsc::Receiver<AgentEvent>>;
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ActorError {
    #[error("fresh-agent profile is incomplete")]
    InvalidProfile,
    #[error("another writer owns this fresh-agent host state")]
    WriterBusy,
    #[error("fresh-agent native identity mismatch")]
    NativeIdentityMismatch,
    #[error("request id was reused with different content")]
    RequestConflict,
    #[error("command dispatch is ambiguous and will not be replayed")]
    AmbiguousDispatch,
    #[error("provider does not support this operation")]
    UnsupportedOperation,
    #[error("permission request is unknown")]
    UnknownDecision,
    #[error("permission request is already resolved")]
    DecisionAlreadyResolved,
    #[error("provider transport failed: {0}")]
    Transport(String),
    #[error("durable fresh-agent state failed: {0}")]
    Persistence(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedCommand {
    payload_digest: String,
    state: CommandState,
    provider_ack_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    operation_failure: Option<OperationFailureKind>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum DecisionState {
    Pending,
    Dispatching,
    Resolved,
    Ambiguous,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedDecision {
    payload: Value,
    state: DecisionState,
    response_digest: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedActorState {
    schema_version: u32,
    profile: FreshAgentProfile,
    commands: BTreeMap<String, PersistedCommand>,
    #[serde(default)]
    completed_forks: BTreeMap<String, ForkTransition>,
    decisions: BTreeMap<String, PersistedDecision>,
    events: VecDeque<JournalEvent>,
    event_bytes: usize,
    next_sequence: u64,
    retained_from: u64,
}

impl PersistedActorState {
    fn new(profile: FreshAgentProfile) -> Self {
        Self {
            schema_version: 1,
            profile,
            commands: BTreeMap::new(),
            completed_forks: BTreeMap::new(),
            decisions: BTreeMap::new(),
            events: VecDeque::new(),
            event_bytes: 0,
            next_sequence: 1,
            retained_from: 1,
        }
    }
}

struct WriterLock {
    file: File,
}

impl WriterLock {
    fn acquire(path: &Path) -> Result<Self, ActorError> {
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(path)
            .map_err(persist)?;
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
            if result != 0 {
                return Err(ActorError::WriterBusy);
            }
        }
        Ok(Self { file })
    }
}

impl Drop for WriterLock {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            unsafe { libc::flock(self.file.as_raw_fd(), libc::LOCK_UN) };
        }
    }
}

pub struct FreshAgentHostActor {
    state_dir: PathBuf,
    transport: Arc<dyn FreshAgentTransport>,
    state: Mutex<PersistedActorState>,
    dispatch_lock: Mutex<()>,
    event_byte_cap: usize,
    event_count_cap: usize,
    _writer_lock: WriterLock,
}

impl FreshAgentHostActor {
    pub async fn open(
        state_dir: impl Into<PathBuf>,
        profile: FreshAgentProfile,
        transport: Arc<dyn FreshAgentTransport>,
    ) -> Result<Arc<Self>, ActorError> {
        Self::open_with_bounds(
            state_dir,
            profile,
            transport,
            DEFAULT_EVENT_BYTES,
            DEFAULT_EVENT_COUNT,
        )
        .await
    }

    pub async fn open_with_bounds(
        state_dir: impl Into<PathBuf>,
        profile: FreshAgentProfile,
        transport: Arc<dyn FreshAgentTransport>,
        event_byte_cap: usize,
        event_count_cap: usize,
    ) -> Result<Arc<Self>, ActorError> {
        profile.validate()?;
        if event_byte_cap == 0 || event_count_cap == 0 {
            return Err(ActorError::InvalidProfile);
        }
        let state_dir = state_dir.into();
        fs::create_dir_all(&state_dir).map_err(persist)?;
        let writer_lock = WriterLock::acquire(&state_dir.join("fresh-agent-writer.lock"))?;
        let state_path = state_dir.join("fresh-agent-state.json");
        let mut state = if state_path.exists() {
            let bytes = fs::read(&state_path).map_err(persist)?;
            let mut loaded: PersistedActorState =
                serde_json::from_slice(&bytes).map_err(persist)?;
            let mut expected_profile = profile.clone();
            if expected_profile.native_session_id.is_none() {
                expected_profile.native_session_id = loaded.profile.native_session_id.clone();
            }
            if loaded.profile != expected_profile {
                return Err(ActorError::NativeIdentityMismatch);
            }
            for command in loaded.commands.values_mut() {
                if matches!(command.state, CommandState::Dispatching) {
                    command.state = CommandState::Ambiguous;
                }
            }
            for decision in loaded.decisions.values_mut() {
                if matches!(decision.state, DecisionState::Dispatching) {
                    decision.state = DecisionState::Ambiguous;
                }
            }
            loaded
        } else {
            PersistedActorState::new(profile)
        };

        let started = transport
            .start(&state.profile)
            .await
            .map_err(ActorError::Transport)?;
        if let Some(expected) = state.profile.native_session_id.as_deref() {
            if started.native_session_id.as_deref() != Some(expected) {
                return Err(ActorError::NativeIdentityMismatch);
            }
        } else if let Some(native_session_id) = started.native_session_id {
            state.profile.native_session_id = Some(native_session_id.clone());
            push_event_bounded(
                &mut state,
                AgentEvent::Started { native_session_id },
                event_byte_cap,
                event_count_cap,
            )?;
        }
        write_state(&state_dir, &state)?;
        let actor = Arc::new(Self {
            state_dir,
            transport: Arc::clone(&transport),
            state: Mutex::new(state),
            dispatch_lock: Mutex::new(()),
            event_byte_cap,
            event_count_cap,
            _writer_lock: writer_lock,
        });
        if let Some(mut events) = transport.take_event_stream() {
            let weak = Arc::downgrade(&actor);
            tokio::spawn(async move {
                while let Some(event) = events.recv().await {
                    let Some(actor) = weak.upgrade() else { break };
                    match event {
                        AgentEvent::Started { native_session_id } => {
                            let _ = actor.observe_native_identity(native_session_id).await;
                        }
                        AgentEvent::PermissionRequested {
                            decision_id,
                            payload,
                        } => {
                            let _ = actor.record_permission(decision_id, payload).await;
                        }
                        event => {
                            let _ = actor.record_event(event).await;
                        }
                    }
                }
            });
        }
        Ok(actor)
    }

    pub async fn profile(&self) -> FreshAgentProfile {
        self.state.lock().await.profile.clone()
    }

    pub async fn observe_native_identity(
        &self,
        native_session_id: String,
    ) -> Result<(), ActorError> {
        if native_session_id.is_empty() {
            return Err(ActorError::NativeIdentityMismatch);
        }
        let mut state = self.state.lock().await;
        match state.profile.native_session_id.as_deref() {
            Some(existing) if existing != native_session_id => {
                return Err(ActorError::NativeIdentityMismatch)
            }
            Some(_) => return Ok(()),
            None => state.profile.native_session_id = Some(native_session_id.clone()),
        }
        push_event_bounded(
            &mut state,
            AgentEvent::Started { native_session_id },
            self.event_byte_cap,
            self.event_count_cap,
        )?;
        write_state(&self.state_dir, &state)
    }

    pub async fn dispatch(
        &self,
        request_id: RequestId,
        text: String,
        settings: Option<FreshAgentTurnSettings>,
    ) -> Result<CommandState, ActorError> {
        // One provider conversation has one ordered input lane. Keep the
        // durability transition and provider acceptance boundary within the
        // same fence so concurrent gateways cannot become double writers.
        let _dispatch_guard = self.dispatch_lock.lock().await;
        let command_material = serde_json::to_vec(&(text.as_str(), &settings)).map_err(persist)?;
        let digest = digest(&command_material);
        let dispatch_profile;
        {
            let mut state = self.state.lock().await;
            if let Some(existing) = state.commands.get(request_id.as_str()) {
                if existing.payload_digest != digest {
                    return Err(ActorError::RequestConflict);
                }
                return match existing.state {
                    CommandState::Ambiguous | CommandState::Dispatching | CommandState::Queued => {
                        Err(ActorError::AmbiguousDispatch)
                    }
                    other => Ok(other),
                };
            }
            if let Some(settings) = settings {
                apply_turn_settings(&mut state.profile, settings);
                state.profile.validate()?;
            }
            dispatch_profile = state.profile.clone();
            state.commands.insert(
                request_id.as_str().to_string(),
                PersistedCommand {
                    payload_digest: digest,
                    state: CommandState::Queued,
                    provider_ack_id: None,
                    operation_failure: None,
                },
            );
            write_protected_payload(&self.state_dir, &request_id, text.as_bytes())?;
            write_state(&self.state_dir, &state)?;
            state
                .commands
                .get_mut(request_id.as_str())
                .expect("inserted")
                .state = CommandState::Dispatching;
            write_state(&self.state_dir, &state)?;
        }

        let result = self
            .transport
            .dispatch(&request_id, &text, &dispatch_profile)
            .await;
        let mut state = self.state.lock().await;
        let command = state
            .commands
            .get_mut(request_id.as_str())
            .expect("durable command");
        match result {
            Ok(ack) => {
                command.provider_ack_id = ack.provider_ack_id;
                command.state = CommandState::ProviderAcked;
                push_event_bounded(
                    &mut state,
                    AgentEvent::CommandOutcome {
                        request_id,
                        state: CommandState::ProviderAcked,
                    },
                    self.event_byte_cap,
                    self.event_count_cap,
                )?;
                write_state(&self.state_dir, &state)?;
                Ok(CommandState::ProviderAcked)
            }
            Err(failure) => {
                command.state = if failure.acceptance_ambiguous {
                    CommandState::Ambiguous
                } else {
                    CommandState::Cancelled
                };
                let outcome = command.state;
                push_event_bounded(
                    &mut state,
                    AgentEvent::CommandOutcome {
                        request_id,
                        state: outcome,
                    },
                    self.event_byte_cap,
                    self.event_count_cap,
                )?;
                write_state(&self.state_dir, &state)?;
                if failure.acceptance_ambiguous {
                    Err(ActorError::AmbiguousDispatch)
                } else {
                    Err(ActorError::Transport(failure.message))
                }
            }
        }
    }

    pub async fn fork(
        &self,
        request_id: RequestId,
        parent_session_id: String,
        input: Option<Value>,
    ) -> Result<ForkTransition, ActorError> {
        let _dispatch_guard = self.dispatch_lock.lock().await;
        let command_material =
            serde_json::to_vec(&("provider_native_fork", &input)).map_err(persist)?;
        let payload_digest = digest(&command_material);
        {
            let mut state = self.state.lock().await;
            if let Some(existing) = state.commands.get(request_id.as_str()) {
                if existing.payload_digest != payload_digest {
                    return Err(ActorError::RequestConflict);
                }
                return match existing.state {
                    CommandState::Completed | CommandState::ProviderAcked => state
                        .completed_forks
                        .get(request_id.as_str())
                        .cloned()
                        .ok_or_else(|| {
                            ActorError::Persistence(
                                "completed fork is missing its durable transition".into(),
                            )
                        }),
                    CommandState::Ambiguous | CommandState::Dispatching | CommandState::Queued => {
                        Err(ActorError::AmbiguousDispatch)
                    }
                    _ => Err(ActorError::Transport(
                        "provider-native fork was previously rejected".into(),
                    )),
                };
            }
            if state.profile.native_session_id.as_deref() != Some(parent_session_id.as_str()) {
                return Err(ActorError::NativeIdentityMismatch);
            }
            state.commands.insert(
                request_id.as_str().to_string(),
                PersistedCommand {
                    payload_digest,
                    state: CommandState::Dispatching,
                    provider_ack_id: None,
                    operation_failure: None,
                },
            );
            // The input contains only provider branch position/settings, not a
            // prompt. It is still persisted under the protected command lane so
            // a lost acknowledgement cannot issue a second native fork.
            write_protected_payload(
                &self.state_dir,
                &request_id,
                serde_json::to_vec(&(parent_session_id.as_str(), &input))
                    .map_err(persist)?
                    .as_slice(),
            )?;
            write_state(&self.state_dir, &state)?;
        }

        let result = self
            .transport
            .fork(&request_id, &parent_session_id, input)
            .await;
        let mut state = self.state.lock().await;
        match result {
            Ok(transition) => {
                if transition.parent_session_id != parent_session_id
                    || transition.child_session_id.is_empty()
                    || transition.child_session_id == parent_session_id
                    || transition.child_session_id.chars().any(char::is_control)
                    || !transition.parent_retired_by_runtime
                {
                    if let Some(command) = state.commands.get_mut(request_id.as_str()) {
                        command.state = CommandState::Ambiguous;
                    }
                    write_state(&self.state_dir, &state)?;
                    return Err(ActorError::AmbiguousDispatch);
                }
                state.profile.native_session_id = Some(transition.child_session_id.clone());
                if let Some(command) = state.commands.get_mut(request_id.as_str()) {
                    command.provider_ack_id = Some(transition.child_session_id.clone());
                    command.state = CommandState::Completed;
                }
                state
                    .completed_forks
                    .insert(request_id.as_str().to_string(), transition.clone());
                push_event_bounded(
                    &mut state,
                    AgentEvent::Started {
                        native_session_id: transition.child_session_id.clone(),
                    },
                    self.event_byte_cap,
                    self.event_count_cap,
                )?;
                push_event_bounded(
                    &mut state,
                    AgentEvent::CommandOutcome {
                        request_id,
                        state: CommandState::Completed,
                    },
                    self.event_byte_cap,
                    self.event_count_cap,
                )?;
                write_state(&self.state_dir, &state)?;
                Ok(transition)
            }
            Err(failure) => {
                if let Some(command) = state.commands.get_mut(request_id.as_str()) {
                    command.state = if failure.acceptance_ambiguous {
                        CommandState::Ambiguous
                    } else {
                        CommandState::Cancelled
                    };
                }
                write_state(&self.state_dir, &state)?;
                if failure.acceptance_ambiguous {
                    Err(ActorError::AmbiguousDispatch)
                } else {
                    Err(ActorError::Transport(failure.message))
                }
            }
        }
    }

    pub async fn semantic_operation(
        &self,
        request_id: RequestId,
        operation: FreshAgentOperation,
    ) -> Result<CommandState, ActorError> {
        let _dispatch_guard = self.dispatch_lock.lock().await;
        let material = serde_json::to_vec(&operation).map_err(persist)?;
        let payload_digest = digest(&material);
        {
            let state = self.state.lock().await;
            if let Some(existing) = state.commands.get(request_id.as_str()) {
                if existing.payload_digest != payload_digest {
                    return Err(ActorError::RequestConflict);
                }
                return match (existing.state, existing.operation_failure) {
                    (CommandState::Cancelled, Some(OperationFailureKind::Unsupported)) => {
                        Err(ActorError::UnsupportedOperation)
                    }
                    (CommandState::Cancelled, Some(OperationFailureKind::Rejected)) => Err(
                        ActorError::Transport("provider previously rejected operation".into()),
                    ),
                    (
                        CommandState::Ambiguous | CommandState::Dispatching | CommandState::Queued,
                        _,
                    ) => Err(ActorError::AmbiguousDispatch),
                    (other, _) => Ok(other),
                };
            }
        }
        if !self
            .transport
            .supports_operation(&operation)
            .await
            .map_err(|_| ActorError::Transport("provider capability check failed".into()))?
        {
            return Err(ActorError::UnsupportedOperation);
        }
        {
            let mut state = self.state.lock().await;
            state.commands.insert(
                request_id.as_str().to_string(),
                PersistedCommand {
                    payload_digest,
                    state: CommandState::Queued,
                    provider_ack_id: None,
                    operation_failure: None,
                },
            );
            write_protected_payload(&self.state_dir, &request_id, &material)?;
            write_state(&self.state_dir, &state)?;
            state
                .commands
                .get_mut(request_id.as_str())
                .expect("inserted semantic operation")
                .state = CommandState::Dispatching;
            write_state(&self.state_dir, &state)?;
        }

        let result = self
            .transport
            .dispatch_operation(&request_id, &operation)
            .await;
        let mut state = self.state.lock().await;
        let (outcome, native_session_id) = {
            let command = state
                .commands
                .get_mut(request_id.as_str())
                .expect("durable semantic operation");
            match result {
                Ok(ack) => {
                    command.provider_ack_id = ack.provider_ack_id;
                    command.state = CommandState::ProviderAcked;
                    (Ok(CommandState::ProviderAcked), ack.native_session_id)
                }
                Err(failure) => {
                    command.state = if failure.acceptance_ambiguous {
                        CommandState::Ambiguous
                    } else {
                        CommandState::Cancelled
                    };
                    command.operation_failure = Some(failure.kind);
                    let error = if failure.acceptance_ambiguous {
                        ActorError::AmbiguousDispatch
                    } else if failure.kind == OperationFailureKind::Unsupported {
                        ActorError::UnsupportedOperation
                    } else {
                        ActorError::Transport(failure.message)
                    };
                    (Err(error), None)
                }
            }
        };
        if let Some(native_session_id) = native_session_id {
            if state.profile.native_session_id.as_deref() != Some(&native_session_id) {
                state.profile.native_session_id = Some(native_session_id.clone());
                push_event_bounded(
                    &mut state,
                    AgentEvent::Started { native_session_id },
                    self.event_byte_cap,
                    self.event_count_cap,
                )?;
            }
        }
        let command_state = state
            .commands
            .get(request_id.as_str())
            .expect("durable semantic operation")
            .state;
        push_event_bounded(
            &mut state,
            AgentEvent::CommandOutcome {
                request_id,
                state: command_state,
            },
            self.event_byte_cap,
            self.event_count_cap,
        )?;
        write_state(&self.state_dir, &state)?;
        outcome
    }

    pub async fn capture(&self, max_bytes: usize) -> Result<FreshAgentCapture, ActorError> {
        let max_bytes = max_bytes.clamp(1, 256 * 1024);
        self.transport
            .capture(max_bytes)
            .await
            .map_err(ActorError::Transport)
    }

    pub async fn record_event(&self, event: AgentEvent) -> Result<u64, ActorError> {
        let mut state = self.state.lock().await;
        let sequence =
            push_event_bounded(&mut state, event, self.event_byte_cap, self.event_count_cap)?;
        write_state(&self.state_dir, &state)?;
        Ok(sequence)
    }

    pub async fn record_permission(
        &self,
        decision_id: String,
        payload: Value,
    ) -> Result<u64, ActorError> {
        let mut state = self.state.lock().await;
        if let Some(existing) = state.decisions.get(&decision_id) {
            if existing.payload != payload {
                return Err(ActorError::RequestConflict);
            }
            return state
                .events
                .iter()
                .rev()
                .find_map(|entry| match &entry.event {
                    AgentEvent::PermissionRequested {
                        decision_id: existing_id,
                        ..
                    } if existing_id == &decision_id => Some(entry.sequence),
                    _ => None,
                })
                .ok_or_else(|| ActorError::Persistence("decision event is missing".into()));
        }
        let prospective = JournalEvent {
            sequence: state.next_sequence,
            event: AgentEvent::PermissionRequested {
                decision_id: decision_id.clone(),
                payload: payload.clone(),
            },
        };
        let pending_ids = pending_decision_ids(&state);
        let protected_bytes = state
            .events
            .iter()
            .filter(|entry| event_is_pending_decision(entry, &pending_ids))
            .map(|entry| serde_json::to_vec(entry).map(|bytes| bytes.len()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(persist)?
            .into_iter()
            .sum::<usize>();
        let prospective_bytes = serde_json::to_vec(&prospective).map_err(persist)?.len();
        if pending_ids.len() >= self.event_count_cap
            || protected_bytes.saturating_add(prospective_bytes) > self.event_byte_cap
        {
            return Err(ActorError::Persistence(
                "pending decision journal capacity exceeded".into(),
            ));
        }
        state.decisions.insert(
            decision_id.clone(),
            PersistedDecision {
                payload: payload.clone(),
                state: DecisionState::Pending,
                response_digest: None,
            },
        );
        let sequence = push_event_bounded(
            &mut state,
            AgentEvent::PermissionRequested {
                decision_id,
                payload,
            },
            self.event_byte_cap,
            self.event_count_cap,
        )?;
        write_state(&self.state_dir, &state)?;
        Ok(sequence)
    }

    pub async fn resolve_permission(
        &self,
        decision_id: &str,
        decision: Value,
    ) -> Result<(), ActorError> {
        let response_digest = digest(&serde_json::to_vec(&decision).map_err(persist)?);
        {
            let mut state = self.state.lock().await;
            let pending = state
                .decisions
                .get_mut(decision_id)
                .ok_or(ActorError::UnknownDecision)?;
            match pending.state {
                DecisionState::Pending => {}
                DecisionState::Resolved
                    if pending.response_digest.as_deref() == Some(&response_digest) =>
                {
                    return Ok(())
                }
                DecisionState::Resolved => return Err(ActorError::DecisionAlreadyResolved),
                DecisionState::Dispatching | DecisionState::Ambiguous => {
                    return Err(ActorError::AmbiguousDispatch)
                }
            }
            pending.state = DecisionState::Dispatching;
            pending.response_digest = Some(response_digest);
            write_state(&self.state_dir, &state)?;
        }
        let result = self
            .transport
            .resolve_permission(decision_id, decision)
            .await;
        let mut state = self.state.lock().await;
        let pending = state
            .decisions
            .get_mut(decision_id)
            .expect("pending decision");
        match result {
            Ok(()) => {
                pending.state = DecisionState::Resolved;
                push_event_bounded(
                    &mut state,
                    AgentEvent::DecisionResolved {
                        decision_id: decision_id.to_string(),
                    },
                    self.event_byte_cap,
                    self.event_count_cap,
                )?;
                write_state(&self.state_dir, &state)
            }
            Err(failure) => {
                pending.state = if failure.acceptance_ambiguous {
                    DecisionState::Ambiguous
                } else {
                    DecisionState::Pending
                };
                write_state(&self.state_dir, &state)?;
                if failure.acceptance_ambiguous {
                    Err(ActorError::AmbiguousDispatch)
                } else {
                    Err(ActorError::Transport(failure.message))
                }
            }
        }
    }

    pub async fn read_events(&self, after: u64, max_events: usize) -> EventBatch {
        let state = self.state.lock().await;
        let max_events = max_events.clamp(1, self.event_count_cap);
        EventBatch {
            retained_from: state.retained_from,
            head: state.next_sequence.saturating_sub(1),
            reset_required: after.saturating_add(1) < state.retained_from,
            events: state
                .events
                .iter()
                .filter(|event| event.sequence > after)
                .take(max_events)
                .cloned()
                .collect(),
        }
    }

    pub async fn interrupt(&self) -> Result<(), ActorError> {
        self.transport
            .interrupt()
            .await
            .map_err(ActorError::Transport)?;
        self.record_event(AgentEvent::Interrupted).await?;
        Ok(())
    }

    pub async fn is_live(&self) -> bool {
        self.transport.is_live().await
    }

    /// Only the session host's supervisor-controlled stop path may call this.
    pub async fn stop(self: Arc<Self>) -> Result<(), ActorError> {
        Arc::clone(&self.transport)
            .stop()
            .await
            .map_err(ActorError::Transport)
    }
}

fn apply_turn_settings(profile: &mut FreshAgentProfile, settings: FreshAgentTurnSettings) {
    if let Some(value) = settings.cwd {
        profile.cwd = value;
    }
    if let Some(value) = settings.model {
        profile.model = Some(value);
    }
    if let Some(value) = settings.effort {
        profile.effort = Some(value);
    }
    if let Some(value) = settings.permission_mode {
        profile.permission_mode = Some(value);
    }
    if let Some(value) = settings.sandbox {
        profile.sandbox = Some(value);
    }
}

fn push_event_bounded(
    state: &mut PersistedActorState,
    event: AgentEvent,
    byte_cap: usize,
    count_cap: usize,
) -> Result<u64, ActorError> {
    let sequence = state.next_sequence;
    state.next_sequence = state.next_sequence.saturating_add(1);
    let entry = JournalEvent { sequence, event };
    let bytes = serde_json::to_vec(&entry).map_err(persist)?.len();
    state.event_bytes = state.event_bytes.saturating_add(bytes);
    state.events.push_back(entry);
    while state.events.len() > count_cap || state.event_bytes > byte_cap {
        let pending_ids = pending_decision_ids(state);
        let Some(index) = state
            .events
            .iter()
            .position(|entry| !event_is_pending_decision(entry, &pending_ids))
        else {
            break;
        };
        let removed = state.events.remove(index).expect("event index exists");
        state.event_bytes = state
            .event_bytes
            .saturating_sub(serde_json::to_vec(&removed).map_err(persist)?.len());
        state.retained_from = removed.sequence.saturating_add(1);
    }
    Ok(sequence)
}

fn pending_decision_ids(state: &PersistedActorState) -> BTreeSet<String> {
    state
        .decisions
        .iter()
        .filter_map(|(decision_id, decision)| {
            matches!(decision.state, DecisionState::Pending).then(|| decision_id.clone())
        })
        .collect()
}

fn event_is_pending_decision(entry: &JournalEvent, pending_ids: &BTreeSet<String>) -> bool {
    matches!(
        &entry.event,
        AgentEvent::PermissionRequested { decision_id, .. } if pending_ids.contains(decision_id)
    )
}

fn write_state(state_dir: &Path, state: &PersistedActorState) -> Result<(), ActorError> {
    let bytes = serde_json::to_vec(state).map_err(persist)?;
    atomic_write(&state_dir.join("fresh-agent-state.json"), &bytes)
}

fn write_protected_payload(
    state_dir: &Path,
    request_id: &RequestId,
    bytes: &[u8],
) -> Result<(), ActorError> {
    let dir = state_dir.join("fresh-agent-commands");
    fs::create_dir_all(&dir).map_err(persist)?;
    let name = digest(request_id.as_str().as_bytes());
    atomic_write(&dir.join(format!("{name}.input")), bytes)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), ActorError> {
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut options = OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&tmp).map_err(persist)?;
    file.write_all(bytes).map_err(persist)?;
    file.sync_all().map_err(persist)?;
    fs::rename(&tmp, path).map_err(persist)?;
    if let Some(parent) = path.parent() {
        File::open(parent)
            .and_then(|dir| dir.sync_all())
            .map_err(persist)?;
    }
    Ok(())
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn persist(error: impl std::fmt::Display) -> ActorError {
    ActorError::Persistence(error.to_string())
}

#[cfg(test)]
#[path = "host_actor_tests.rs"]
mod tests;

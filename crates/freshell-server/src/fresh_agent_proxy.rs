#![cfg(feature = "managed-runtime-v1")]

//! Opt-in external gateway from the retained fresh-agent wire to the
//! supervisor/session-host actor. This module owns no provider process.

use freshell_freshagent::naming::{admit_pending_projection, session_projection, SessionNaming};
use freshell_freshagent::rest_lane::{
    FreshAgentRestLane, RestLaneCapture, RestLaneCaptureError, RestLaneCaptureResult,
    RestLaneCreate, RestLaneCreated, RestLaneError, RestLaneErrorKind, RestLaneSend,
    RestLaneSendResult,
};
use freshell_protocol::session_names::NamedProvider;
use freshell_protocol::{
    AgentProvider, FreshAgentCreateFailed, FreshAgentCreated, FreshAgentEvent, FreshAgentForked,
    FreshAgentKilled, FreshAgentRecoveryStopped, FreshAgentSend, ServerMessage, SessionLocator,
    SessionType, StringOrNumber,
};
use freshell_runtime_client::RuntimeClient;
use freshell_runtime_protocol::{
    AgentEvent, DesiredState, FreshAgentFixtureTransport, FreshAgentLaunchSpec,
    FreshAgentRollbackDirection, FreshAgentRollbackMode, FreshProvider, LaunchRequest, RequestId,
    RuntimeErrorCode, RuntimeLimits, RuntimeProfile, SoulId, StopOutcome,
};
use freshell_ws::hosted_fresh_agent::{HostedFreshAgentCommand, HostedFreshAgentGateway};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
    sync::OnceLock,
    time::Duration,
};
use tokio::sync::{broadcast, Mutex};

const OPT_IN_ENV: &str = "FRESHELL_MANAGED_FRESH_AGENT_V1";
const FIXTURE_MODES_ENV: &str = "FRESHELL_MANAGED_FRESH_AGENT_FIXTURE_MODES";
const PROVIDER_UID: u32 = 65_534;
const PROVIDER_GID: u32 = 0;

pub(crate) fn context_for_fresh_provider(
    provider_launch_context: Option<freshell_runtime_protocol::ProviderLaunchContext>,
) -> Option<freshell_runtime_protocol::ProviderLaunchContext> {
    provider_launch_context
}

pub(crate) struct HostedFreshAgentProxy {
    client: RuntimeClient,
    broadcast: Arc<broadcast::Sender<String>>,
    aliases: Mutex<HashMap<(String, String), SoulId>>,
    presentation_ids: Mutex<HashMap<SoulId, String>>,
    pollers: Mutex<HashSet<SoulId>>,
    fixture_modes: HashSet<String>,
    naming: OnceLock<Arc<dyn SessionNaming>>,
    checkpoint_barrier:
        OnceLock<Arc<dyn freshell_ws::checkpoint_barrier::FreshAgentCheckpointBarrier>>,
    ownership: OnceLock<Arc<freshell_ownership::RuntimeOwnershipRegistry>>,
}

struct RollbackInvocation {
    provider: AgentProvider,
    session_id: String,
    session_type: SessionType,
    request_id: String,
    direction: FreshAgentRollbackDirection,
    mode: Option<freshell_protocol::RollbackMode>,
    turn_id: Option<String>,
    cwd: Option<String>,
}

impl HostedFreshAgentProxy {
    pub(crate) fn from_opt_in(
        client: Option<RuntimeClient>,
        broadcast: Arc<broadcast::Sender<String>>,
    ) -> Result<Option<Arc<Self>>, String> {
        if std::env::var(OPT_IN_ENV).ok().as_deref() != Some("1") {
            return Ok(None);
        }
        let client = client.ok_or_else(|| {
            format!("{OPT_IN_ENV}=1 requires an available managed runtime controller")
        })?;
        let fixture_modes = configured_fixture_modes()?;
        // Codex reports authenticated accepted-input and verified acquisition
        // facts to the shared authority. The other hosted provider lanes
        // still have no first-message/materialization naming feed.
        tracing::warn!(
            target: "freshell_server::session_names",
            flag = OPT_IN_ENV,
            providers = "claude,opencode",
            "session_names.hosted_fresh_agent_naming_incomplete: hosted Claude and OpenCode \
             sessions keep their create-time name only (no first-message or AI naming)"
        );
        Ok(Some(Arc::new(Self {
            client,
            broadcast,
            aliases: Mutex::new(HashMap::new()),
            presentation_ids: Mutex::new(HashMap::new()),
            pollers: Mutex::new(HashSet::new()),
            fixture_modes,
            naming: OnceLock::new(),
            checkpoint_barrier: OnceLock::new(),
            ownership: OnceLock::new(),
        })))
    }

    pub(crate) fn set_checkpoint_barrier(
        &self,
        barrier: Arc<dyn freshell_ws::checkpoint_barrier::FreshAgentCheckpointBarrier>,
    ) {
        let _ = self.checkpoint_barrier.set(barrier);
    }

    pub(crate) fn set_ownership(
        &self,
        ownership: Arc<freshell_ownership::RuntimeOwnershipRegistry>,
    ) {
        let _ = self.ownership.set(ownership);
    }

    fn post_barrier_admission(&self, message: &FreshAgentSend) -> Result<(), &'static str> {
        let (epoch, generation) = match (message.observed_epoch, message.observed_generation) {
            (None, None) => return Ok(()),
            (Some(epoch), Some(generation)) => (epoch, generation),
            _ => return Err("fresh-agent ownership fence is incomplete"),
        };
        let Some(ownership) = self.ownership.get() else {
            return Ok(());
        };
        let provider = provider_wire(&message.provider);
        let canonical_id = ownership.resolve_canonical(&provider, &message.session_id);
        let current = ownership.observe(&provider, &canonical_id);
        if current.epoch != epoch || current.generation != generation {
            return Err("fresh-agent session changed while the checkpoint was being captured");
        }
        match current.state {
            freshell_ownership::OwnershipState::Live { owner, .. }
                if owner.kind == freshell_ownership::RuntimeOwnerKind::FreshAgent =>
            {
                Ok(())
            }
            _ => Err("fresh-agent session is no longer available for this send"),
        }
    }

    async fn dispatch_send(&self, message: FreshAgentSend) {
        let provider = message.provider;
        let session_id = message.session_id.clone();
        let session_type = message.session_type;
        let checkpoint_logical_attempt_id = message
            .checkpoint_intent
            .as_ref()
            .map(|intent| intent.logical_attempt_id.clone());
        if let Err(reason) = self.post_barrier_admission(&message) {
            self.error_event_code(
                &provider,
                &session_id,
                session_type,
                "FRESH_AGENT_STALE_SESSION",
                reason,
            );
            return;
        }
        let request_id = message
            .request_id
            .as_deref()
            .and_then(|value| RequestId::parse(value.to_string()).ok())
            .unwrap_or_default();
        let result = match self
            .resolve_soul(&provider, session_type, &session_id)
            .await
        {
            Some(soul) => {
                let settings = turn_settings(message.settings, message.cwd);
                self.client
                    .fresh_agent_send(
                        request_id,
                        soul,
                        message.text,
                        settings,
                        checkpoint_logical_attempt_id,
                    )
                    .await
                    .map(|_| ())
            }
            None => Err(freshell_runtime_client::ClientError::UnexpectedResult),
        };
        if result.is_err() {
            self.error_event(
                &provider,
                &session_id,
                session_type,
                "managed fresh-agent input was not accepted",
            );
        }
    }

    pub(crate) fn set_session_naming(&self, naming: Arc<dyn SessionNaming>) {
        let _ = self.naming.set(naming);
    }

    async fn handle(self: Arc<Self>, command: HostedFreshAgentCommand) {
        match command {
            HostedFreshAgentCommand::Create(message) => {
                let request_id = message.request_id.clone();
                if let Err(mut error) = self.create(message).await {
                    tracing::warn!(request_id, code=%error.code, "fresh_agent.create.failed");
                    if error.code == "FRESH_AGENT_UNAVAILABLE" {
                        error.code = "FRESH_AGENT_CREATE_FAILED".into();
                        error.message = "managed fresh-agent host could not be created".into();
                        error.retryable = Some(true);
                    }
                    self.send(ServerMessage::FreshAgentCreateFailed(
                        FreshAgentCreateFailed {
                            code: error.code,
                            message: error.message,
                            request_id,
                            retryable: error.retryable,
                            owner_kind: None,
                            owner_generation: None,
                            owner_epoch: None,
                        },
                    ));
                }
            }
            HostedFreshAgentCommand::Attach(message) => {
                if let Some(soul) = self
                    .resolve_soul(&message.provider, message.session_type, &message.session_id)
                    .await
                {
                    let provider_name = provider_wire(&message.provider);
                    let session_type = session_type_wire(message.session_type);
                    let started = self
                        .start_poller(
                            soul.clone(),
                            provider_name.clone(),
                            message.session_id.clone(),
                            session_type.clone(),
                        )
                        .await;
                    if !started {
                        self.replay_once(soul, &provider_name, &message.session_id, &session_type)
                            .await;
                    }
                } else {
                    self.error_event(
                        &message.provider,
                        &message.session_id,
                        message.session_type,
                        "managed fresh-agent soul was not found",
                    );
                }
            }
            HostedFreshAgentCommand::Send(message) => {
                if message.checkpoint_intent.is_some() {
                    if let Some(barrier) = self.checkpoint_barrier.get() {
                        let proxy = Arc::clone(&self);
                        let capture_send = message.clone();
                        let forward = Box::pin(async move { proxy.dispatch_send(message).await });
                        Arc::clone(barrier)
                            .barrier_and_forward(capture_send, forward)
                            .await;
                    } else {
                        self.dispatch_send(message).await;
                    }
                } else {
                    self.dispatch_send(message).await;
                }
            }
            HostedFreshAgentCommand::Interrupt(message) => {
                let result = match self
                    .resolve_soul(&message.provider, message.session_type, &message.session_id)
                    .await
                {
                    Some(soul) => self.client.fresh_agent_interrupt(soul).await,
                    None => Err(freshell_runtime_client::ClientError::UnexpectedResult),
                };
                if result.is_err() {
                    self.error_event(
                        &message.provider,
                        &message.session_id,
                        message.session_type,
                        "managed fresh-agent interrupt failed",
                    );
                }
            }
            HostedFreshAgentCommand::Configure(message) => {
                let request_id = message
                    .request_id
                    .as_deref()
                    .and_then(|value| RequestId::parse(value.to_string()).ok())
                    .unwrap_or_default();
                let settings =
                    turn_settings(Some(message.settings), message.cwd).unwrap_or_default();
                // The provider converges every device through its own
                // `freshAgent.session.metadata` frame (or refuses with its own
                // session-scoped error) on the host event relay; only a
                // failure to reach the soul is answered here.
                let result = match self
                    .resolve_soul(&message.provider, message.session_type, &message.session_id)
                    .await
                {
                    Some(soul) => self
                        .client
                        .fresh_agent_configure(request_id.clone(), soul, settings)
                        .await
                        .map(|_| ()),
                    None => Err(freshell_runtime_client::ClientError::UnexpectedResult),
                };
                if let Err(error) = result {
                    tracing::warn!(
                        event = "fresh_agent.configure.failed",
                        provider = %provider_wire(&message.provider),
                        session_id = %message.session_id,
                        request_id = %request_id,
                        code = operation_error_code(&error),
                        "managed fresh-agent configure was not accepted"
                    );
                    self.operation_error_event(
                        &message.provider,
                        &message.session_id,
                        message.session_type,
                        &error,
                        "managed fresh-agent configure was not accepted",
                    );
                }
            }
            HostedFreshAgentCommand::Kill(message) => {
                let success = if let Some(soul) = self
                    .resolve_soul(&message.provider, message.session_type, &message.session_id)
                    .await
                {
                    matches!(self.client.stop(soul).await, Ok(StopOutcome::VerifiedEmpty))
                } else {
                    false
                };
                self.send(ServerMessage::FreshAgentKilled(FreshAgentKilled {
                    provider: provider_wire(&message.provider),
                    session_id: message.session_id,
                    session_type: session_type_wire(message.session_type),
                    success,
                    code: None,
                    message: None,
                }));
            }
            HostedFreshAgentCommand::RecoveryStop(message) => {
                self.send(ServerMessage::FreshAgentRecoveryStopped(
                    FreshAgentRecoveryStopped {
                        request_id: message.request_id,
                        provider: provider_wire(&message.provider),
                        session_id: message.session_id,
                        session_type: session_type_wire(message.session_type),
                        success: false,
                        code: Some("UNSUPPORTED_CAPABILITY".to_string()),
                        message: Some(
                            "managed fresh-agent recovery stop is unavailable".to_string(),
                        ),
                    },
                ));
            }
            HostedFreshAgentCommand::Approval(message) => {
                self.resolve_decision(
                    message.provider,
                    message.session_id,
                    message.session_type,
                    decision_id(message.request_id),
                    message.decision,
                )
                .await;
            }
            HostedFreshAgentCommand::Elicitation(message) => {
                if message.provider != AgentProvider::Codex {
                    self.error_event_code(
                        &message.provider,
                        &message.session_id,
                        message.session_type,
                        "UNSUPPORTED_CAPABILITY",
                        "MCP elicitation is not supported for this provider.",
                    );
                    return;
                }
                self.resolve_decision(message.provider, message.session_id, message.session_type, decision_id(message.request_id),
                    serde_json::json!({"elicitation":{"action":message.action,"content":message.content}})).await;
            }
            HostedFreshAgentCommand::Question(message) => {
                self.resolve_decision(
                    message.provider,
                    message.session_id,
                    message.session_type,
                    decision_id(message.request_id),
                    serde_json::json!({"answers":message.answers}),
                )
                .await;
            }
            HostedFreshAgentCommand::Compact(message) => {
                let request_id = message
                    .request_id
                    .as_deref()
                    .and_then(|value| RequestId::parse(value.to_string()).ok())
                    .unwrap_or_default();
                let result = match self
                    .resolve_soul(&message.provider, message.session_type, &message.session_id)
                    .await
                {
                    Some(soul) => self
                        .client
                        .fresh_agent_compact(
                            request_id,
                            soul,
                            message.instructions.clone(),
                            message.cwd.clone(),
                        )
                        .await
                        .map(|_| ()),
                    None => Err(freshell_runtime_client::ClientError::UnexpectedResult),
                };
                if let Err(error) = result {
                    self.operation_error_event(
                        &message.provider,
                        &message.session_id,
                        message.session_type,
                        &error,
                        "managed fresh-agent compact was not accepted",
                    );
                }
            }
            HostedFreshAgentCommand::Fork(message) => {
                let provider = message.provider;
                let session_id = message.session_id.clone();
                let session_type = message.session_type;
                let request_id = message
                    .request_id
                    .as_deref()
                    .and_then(|value| RequestId::parse(value.to_string()).ok())
                    .unwrap_or_default();
                let result = match self
                    .resolve_soul(&provider, session_type, &session_id)
                    .await
                {
                    Some(soul) => self
                        .client
                        .fresh_agent_fork(
                            request_id,
                            soul.clone(),
                            session_id.clone(),
                            message.input,
                        )
                        .await
                        .map(|transition| (soul, transition)),
                    None => Err(freshell_runtime_client::ClientError::UnexpectedResult),
                };
                match result {
                    Ok((soul, transition)) => {
                        let provider_name = provider_wire(&provider);
                        {
                            let mut aliases = self.aliases.lock().await;
                            aliases.retain(|(mapped_provider, _), mapped_soul| {
                                mapped_provider != &provider_name || mapped_soul != &soul
                            });
                            aliases.insert(
                                (provider_name.clone(), transition.child_session_id.clone()),
                                soul.clone(),
                            );
                        }
                        self.presentation_ids
                            .lock()
                            .await
                            .insert(soul, transition.child_session_id.clone());
                        self.send(ServerMessage::FreshAgentForked(FreshAgentForked {
                            request_id: message.request_id,
                            parent_session_id: transition.parent_session_id,
                            session_id: transition.child_session_id.clone(),
                            session_type: session_type_wire(session_type),
                            provider: provider_wire(&provider),
                            runtime_provider: provider_wire(&provider),
                            parent_retired_by_runtime: Some(transition.parent_retired_by_runtime),
                            session_ref: Some(SessionLocator {
                                provider: provider_wire(&provider),
                                session_id: transition.child_session_id,
                            }),
                        }));
                    }
                    Err(_) => self.error_event(
                        &provider,
                        &session_id,
                        session_type,
                        "managed provider-native fork failed without creating another soul",
                    ),
                }
            }
            HostedFreshAgentCommand::Undo(message) => {
                self.rollback(RollbackInvocation {
                    provider: message.provider,
                    session_id: message.session_id,
                    session_type: message.session_type,
                    request_id: message.request_id,
                    direction: FreshAgentRollbackDirection::Undo,
                    mode: message.mode,
                    turn_id: message.turn_id,
                    cwd: message.cwd,
                })
                .await;
            }
            HostedFreshAgentCommand::Redo(message) => {
                self.rollback(RollbackInvocation {
                    provider: message.provider,
                    session_id: message.session_id,
                    session_type: message.session_type,
                    request_id: message.request_id,
                    direction: FreshAgentRollbackDirection::Redo,
                    mode: message.mode,
                    turn_id: message.turn_id,
                    cwd: message.cwd,
                })
                .await;
            }
        }
    }

    async fn create(
        self: &Arc<Self>,
        message: freshell_protocol::FreshAgentCreate,
    ) -> Result<Option<(SoulId, u64)>, RestLaneError> {
        let provider = fresh_provider(&message.provider, message.session_type).ok_or(())?;
        let public_provider = fresh_provider_wire(&provider);
        if let Some(session_ref) = message.session_ref.as_ref() {
            if session_ref.provider != public_provider {
                return Err(().into());
            }
            let inventory = self.client.inventory().await.map_err(|_| ())?;
            let view = inventory
                .into_iter()
                .rev()
                .find(|view| resume_view_matches(view, provider.as_str(), &session_ref.session_id));
            if let Some(view) = view {
                let public_session_id = session_ref.session_id.clone();
                let projection = session_projection(
                    &self.naming.get().cloned(),
                    named_provider(&provider),
                    &public_session_id,
                )
                .await;
                let soul = view.soul_id;
                let provider_name = public_provider.to_string();
                let canonical_session_id = view.fresh_agent_session_id;
                {
                    let mut aliases = self.aliases.lock().await;
                    aliases.insert(
                        (provider_name.clone(), public_session_id.clone()),
                        soul.clone(),
                    );
                    if let Some(canonical_session_id) = canonical_session_id {
                        aliases.insert((provider_name.clone(), canonical_session_id), soul.clone());
                    }
                }
                self.send(ServerMessage::FreshAgentCreated(FreshAgentCreated {
                    provider: provider_name.clone(),
                    request_id: message.request_id,
                    runtime_provider: provider.as_str().into(),
                    session_id: public_session_id.clone(),
                    session_type: session_type_wire(message.session_type),
                    session_ref: Some(SessionLocator {
                        provider: provider_name.clone(),
                        session_id: public_session_id.clone(),
                    }),
                    session_name: projection.as_ref().map(|(_, record)| record.clone()),
                    name_ref: projection.map(|(reference, _)| reference),
                }));
                let started = self
                    .start_poller(
                        soul.clone(),
                        provider_name,
                        public_session_id.clone(),
                        session_type_wire(message.session_type),
                    )
                    .await;
                if !started {
                    self.replay_once(
                        soul,
                        public_provider,
                        &public_session_id,
                        &session_type_wire(message.session_type),
                    )
                    .await;
                }
                return Ok(None);
            }
        }
        let cwd = canonical_cwd(message.cwd.as_deref()).map_err(|_| ())?;
        let workspace = workspace_root(&cwd);
        let soul = stable_soul_id(provider.as_str(), &message.request_id).map_err(|_| ())?;
        let public_session_id = presentation_id_for_create(
            &provider,
            &message.request_id,
            message
                .session_ref
                .as_ref()
                .map(|value| value.session_id.as_str()),
        );
        let native_session_id = message
            .session_ref
            .as_ref()
            .map(|value| value.session_id.clone());
        let session_type = session_type_wire(message.session_type);
        let request_id = stable_request_id(&message.request_id).map_err(|_| ())?;
        let provider_bootstrap_files = Vec::new();
        let mut provider_secret_references =
            crate::managed_provider_bootstrap::named_provider_onecli_references(
                provider.native_provider(),
            )
            .map_err(|_| ())?;
        let (mcp_capability, mut provider_launch_context) = if provider == FreshProvider::Opencode {
            let home = std::env::var_os("HOME")
                .map(std::path::PathBuf::from)
                .ok_or(())?;
            let original = |name: &str| std::env::var(name).ok();
            let prepared = crate::managed_provider_references::prepare_managed_opencode(
                crate::managed_provider_references::OpencodePreparation {
                    client: &self.client,
                    soul: &soul,
                    creation_seed: &message.request_id,
                    home: &home,
                    cwd: &cwd,
                    workspace: &workspace,
                    original: &original,
                    references: provider_secret_references,
                    auth_authority: None,
                    selected_sources: None,
                    accepted_global_root: None,
                    selected_resource_roots: None,
                    native_source_flags: None,
                    rebind_enabled: None,
                    inherited_inline: None,
                    inline_edits: Some(freshell_platform::opencode_config::OwnedConfigEdits {
                        disable_snapshots: true,
                        ..Default::default()
                    }),
                },
            )
            .await
            .map_err(|error| {
                tracing::warn!(event="fresh_agent.create.provider_inputs_failed",%error);
            })?;
            provider_secret_references = prepared.references;
            let capability = prepared.context.mcp_capability.clone().ok_or(())?;
            (capability, Some(prepared.context))
        } else if provider == FreshProvider::Codex {
            let home = std::env::var_os("HOME")
                .map(std::path::PathBuf::from)
                .ok_or(())?;
            let original = |name: &str| std::env::var(name).ok();
            let context = crate::managed_provider_references::codex::prepare_managed(
                crate::managed_provider_references::codex::CodexPreparation {
                    native_source_runtime:
                        freshell_platform::codex_inputs::NativeSourceRuntime::AppServer,
                    client: &self.client,
                    soul: &soul,
                    creation_seed: &message.request_id,
                    home: &home,
                    cwd: &cwd,
                    workspace: &workspace,
                    original: &original,
                    args: &[],
                    references: &provider_secret_references,
                },
            )
            .await
            .map_err(|error| {
                tracing::warn!(event="fresh_agent.create.provider_inputs_failed", provider="codex", request_id=%message.request_id, code=?error.code, message=%error.message);
                let configuration = error.code == RuntimeErrorCode::InvalidRequest;
                let mut refusal = RestLaneError::new(
                    if configuration { RestLaneErrorKind::BadRequest } else { RestLaneErrorKind::Unavailable },
                    if configuration { "INVALID_REQUEST" } else { "CODEX_PREPARATION_UNAVAILABLE" },
                    error.message,
                );
                refusal.retryable = Some(!configuration);
                refusal
            })?;
            (context.mcp_capability.clone().ok_or(())?, Some(context))
        } else if matches!(provider, FreshProvider::Claude | FreshProvider::Kilroy) {
            let home = std::env::var_os("HOME")
                .map(std::path::PathBuf::from)
                .ok_or(())?;
            let original = |name: &str| std::env::var(name).ok();
            let context = crate::managed_provider_references::claude::prepare_managed(
                crate::managed_provider_references::claude::ClaudePreparation {
                    native_source_runtime:
                        freshell_platform::claude_inputs::NativeSourceRuntime::Sdk,
                    reservation_provider: provider.as_str(),
                    git_common_dir: git_common_dir(&workspace).as_deref(),
                    selected_settings: None,
                    client: &self.client,
                    soul: &soul,
                    creation_seed: &message.request_id,
                    home: &home,
                    cwd: &cwd,
                    workspace: &workspace,
                    original: &original,
                    args: &[],
                    plugins: message.plugins.as_deref().unwrap_or_default(),
                    references: &provider_secret_references,
                },
            )
            .await
            .map_err(|error| {
                tracing::warn!(event="fresh_agent.create.provider_inputs_failed",%error);
            })?;
            (context.mcp_capability.clone().ok_or(())?, Some(context))
        } else {
            let mcp_capability = crate::managed_mcp_capability::issue_mcp_capability(
                &soul,
                provider.as_str(),
                crate::managed_mcp_capability::OpencodeEphemeralInput {
                    cwd: Some(&cwd),
                    workspace: Some(&workspace),
                    ..Default::default()
                },
            )
            .map_err(|error| {
                tracing::warn!(%error, "fresh_agent.create.capability_failed");
            })?;
            let provider_launch_context =
                crate::managed_provider_bootstrap::provider_launch_context_for_managed_at(
                    provider.as_str(),
                    &workspace,
                    &cwd,
                    Some(mcp_capability.clone()),
                )
                .map_err(|error| {
                    tracing::warn!(event="fresh_agent.create.provider_environment_failed", %error);
                })?;
            (mcp_capability, provider_launch_context)
        };
        provider_launch_context = context_for_fresh_provider(provider_launch_context);
        let launch = FreshAgentLaunchSpec {
            naming_handle: (provider == FreshProvider::Codex)
                .then(|| message.naming_handle.clone())
                .flatten(),
            collaboration_mode: message.collaboration_mode.clone(),
            session_id: public_session_id.clone(),
            provider: provider.clone(),
            session_type: session_type.clone(),
            runtime_variant: runtime_variant(&provider).into(),
            provider_store_id: soul.to_string(),
            cwd: cwd.to_string_lossy().into_owned(),
            workspace_path: workspace.to_string_lossy().into_owned(),
            git_common_dir: git_common_dir(&workspace)
                .map(|value| value.to_string_lossy().into_owned()),
            run_as_uid: PROVIDER_UID,
            run_as_gid: PROVIDER_GID,
            model: message.model.clone(),
            effort: message.effort.clone().flatten(),
            permission_mode: message.permission_mode.clone(),
            sandbox: message
                .sandbox
                .and_then(|value| serde_json::to_value(value).ok())
                .and_then(|value| value.as_str().map(str::to_string)),
            native_session_id: native_session_id.clone(),
            plugins: message.plugins.clone(),
            model_selection: message.model_selection.as_ref().map(|selection| {
                selection.as_ref().map(|selection| {
                    freshell_runtime_protocol::ProviderModelSelection {
                        kind: selection.kind.clone(),
                        model_id: selection.model_id.clone(),
                    }
                })
            }),
            session_ref: message.session_ref.as_ref().map(|reference| {
                freshell_runtime_protocol::ProviderSessionReference {
                    provider: reference.provider.clone(),
                    session_id: reference.session_id.clone(),
                }
            }),
            fixture_transport: self
                .fixture_modes
                .contains(&session_type)
                .then_some(FreshAgentFixtureTransport::Deterministic),
            provider_bootstrap_files,
            provider_secret_references,
            provider_launch_context,
        };
        let project_key = format!("project-{}", stable_hex(&workspace.to_string_lossy()));
        let request = LaunchRequest {
            soul_id: soul.clone(),
            provider: provider.as_str().into(),
            provider_store_id: soul.to_string(),
            creation_seed_ref: message.request_id.clone(),
            limits: RuntimeLimits {
                cpu_milli: 2000,
                memory_bytes: 4 * 1024 * 1024 * 1024,
                swap_bytes: 0,
                pids_max: 512,
            },
            profile: RuntimeProfile::DefaultAgent,
            project_key: project_key.clone(),
            native_session_id: native_session_id.clone(),
            fixture: None,
            terminal: None,
            fresh_agent: Some(launch),
            view_intent: Some(crate::managed_view_intent::automatic_primary_view_request(
                project_key,
                message.tab_id.clone(),
                None,
            )),
            expected_control_epoch: None,
        };
        let launched = if provider == FreshProvider::Opencode {
            let home = std::env::var_os("HOME").map(PathBuf::from).ok_or(())?;
            let original = |name: &str| std::env::var(name).ok();
            let references = request
                .fresh_agent
                .as_ref()
                .unwrap()
                .provider_secret_references
                .iter()
                .filter(|r| !r.profile.is_configuration_file())
                .cloned()
                .collect();
            crate::managed_provider_references::launch_initial_opencode(
                crate::managed_provider_references::OpencodePreparation {
                    client: &self.client,
                    soul: &soul,
                    creation_seed: &message.request_id,
                    home: &home,
                    cwd: &cwd,
                    workspace: &workspace,
                    original: &original,
                    references,
                    auth_authority: None,
                    selected_sources: None,
                    accepted_global_root: None,
                    selected_resource_roots: None,
                    native_source_flags: None,
                    rebind_enabled: None,
                    inherited_inline: None,
                    inline_edits: Some(freshell_platform::opencode_config::OwnedConfigEdits {
                        disable_snapshots: true,
                        ..Default::default()
                    }),
                },
                request_id,
                request,
            )
            .await
            .map_err(|error| {
                tracing::warn!(event="fresh_agent.create.initial_opencode_failed",%error);
            })?
        } else {
            self.client
                .launch(request_id, request)
                .await
                .map_err(|error| {
                    // A failed reply cannot establish that this exact
                    // preparation was never accepted. Preserve its journal and
                    // stage for existing same-conversation reconciliation.
                    tracing::warn!(event="provider.inputs.initial_launch.unconfirmed",
                        provider=provider.as_str(),soul_id=%soul,
                        grant_id=%mcp_capability.grant_id,
                        stage="controller",operation="launch",%error,
                        "Retain provider inputs until dispatch outcome is confirmed");
                })?
        };
        let cleanup_receipt = (soul.clone(), launched.view.intent_revision);
        let naming_projection = match message.naming_handle.as_deref() {
            Some(handle) if !handle.trim().is_empty() => {
                admit_pending_projection(
                    &self.naming.get().cloned(),
                    handle,
                    named_provider(&provider),
                    message.cwd.as_deref(),
                )
                .await
            }
            _ => None,
        };
        self.send(ServerMessage::FreshAgentCreated(FreshAgentCreated {
            provider: public_provider.into(),
            request_id: message.request_id.clone(),
            runtime_provider: provider.as_str().into(),
            session_id: public_session_id.clone(),
            session_type: session_type.clone(),
            session_ref: launched
                .view
                .native_session_id
                .map(|session_id| SessionLocator {
                    provider: public_provider.into(),
                    session_id,
                }),
            name_ref: naming_projection
                .as_ref()
                .map(|(reference, _)| reference.clone()),
            session_name: naming_projection.map(|(_, record)| record),
        }));
        self.aliases.lock().await.insert(
            (public_provider.into(), public_session_id.clone()),
            soul.clone(),
        );
        self.start_poller(
            soul,
            public_provider.into(),
            public_session_id,
            session_type,
        )
        .await;
        Ok(Some(cleanup_receipt))
    }

    async fn resolve_decision(
        &self,
        provider: AgentProvider,
        session_id: String,
        session_type: SessionType,
        decision_id: String,
        decision: serde_json::Value,
    ) {
        let result = match self
            .resolve_soul(&provider, session_type, &session_id)
            .await
        {
            Some(soul) => self
                .client
                .fresh_agent_resolve(soul, decision_id, decision)
                .await
                .map(|_| ()),
            None => Err(freshell_runtime_client::ClientError::UnexpectedResult),
        };
        if result.is_err() {
            self.error_event(
                &provider,
                &session_id,
                session_type,
                "managed fresh-agent decision was not accepted",
            );
        }
    }

    async fn rollback(&self, invocation: RollbackInvocation) {
        let RollbackInvocation {
            provider,
            session_id,
            session_type,
            request_id,
            direction,
            mode,
            turn_id,
            cwd,
        } = invocation;
        let parsed_request_id = RequestId::parse(request_id);
        let result = match (
            parsed_request_id,
            self.resolve_soul(&provider, session_type, &session_id)
                .await,
        ) {
            (Ok(request_id), Some(soul)) => self
                .client
                .fresh_agent_rollback(
                    request_id,
                    soul,
                    direction,
                    match mode {
                        Some(freshell_protocol::RollbackMode::ToTurn) => {
                            FreshAgentRollbackMode::ToTurn
                        }
                        Some(freshell_protocol::RollbackMode::Step) | None => {
                            FreshAgentRollbackMode::Step
                        }
                    },
                    turn_id,
                    cwd,
                )
                .await
                .map(|_| ()),
            _ => Err(freshell_runtime_client::ClientError::UnexpectedResult),
        };
        if let Err(error) = result {
            self.operation_error_event(
                &provider,
                &session_id,
                session_type,
                &error,
                "managed fresh-agent rollback was not accepted",
            );
        }
    }

    async fn resolve_soul(
        &self,
        provider: &AgentProvider,
        session_type: SessionType,
        session_id: &str,
    ) -> Option<SoulId> {
        let public_provider = provider_wire(provider);
        let runtime_provider = fresh_provider(&Some(*provider), session_type)?;
        if let Some(soul) = self
            .aliases
            .lock()
            .await
            .get(&(public_provider.clone(), session_id.to_string()))
            .cloned()
        {
            return Some(soul);
        }
        let inventory = self.client.inventory().await.ok()?;
        let view = inventory.into_iter().rev().find(|view| {
            view.desired_state == DesiredState::Running
                && view.provider.as_deref() == Some(runtime_provider.as_str())
                && (view.fresh_agent_session_id.as_deref() == Some(session_id)
                    || view.native_session_id.as_deref() == Some(session_id))
        })?;
        self.aliases.lock().await.insert(
            (public_provider, session_id.to_string()),
            view.soul_id.clone(),
        );
        Some(view.soul_id)
    }

    async fn start_poller(
        self: &Arc<Self>,
        soul: SoulId,
        provider: String,
        presentation_session_id: String,
        session_type: String,
    ) -> bool {
        self.presentation_ids
            .lock()
            .await
            .entry(soul.clone())
            .or_insert_with(|| presentation_session_id.clone());
        if !self.pollers.lock().await.insert(soul.clone()) {
            return false;
        }
        let proxy = Arc::clone(self);
        tokio::spawn(async move {
            let mut cursor = 0;
            let mut retained_through = 0;
            let mut source_before = if provider == "codex" {
                proxy.current_source(&soul).await
            } else {
                None
            };
            loop {
                match proxy
                    .client
                    .fresh_agent_events(soul.clone(), cursor, 128)
                    .await
                {
                    Ok(batch) => {
                        if batch.retained_state.is_some() || cursor < retained_through {
                            let after = proxy.current_source(&soul).await;
                            let valid = retained_batch_matches_source(
                                source_before.as_ref(),
                                after.as_ref(),
                                batch.retained_state.as_ref(),
                            );
                            source_before = after;
                            if !valid {
                                tracing::warn!(provider, soul_id=%soul, "freshagent.gateway.retained_source_changed");
                                cursor = 0;
                                retained_through = 0;
                                tokio::time::sleep(Duration::from_millis(50)).await;
                                continue;
                            }
                        }
                        if let Some(retained) = batch.retained_state {
                            let presentation = proxy
                                .presentation_ids
                                .lock()
                                .await
                                .get(&soul)
                                .cloned()
                                .unwrap_or_else(|| presentation_session_id.clone());
                            proxy
                                .forward_retained(
                                    retained,
                                    &provider,
                                    &presentation,
                                    &session_type,
                                    if batch.reset_required {
                                        "freshAgent.host.journal.reset"
                                    } else {
                                        "freshAgent.host.backpressure"
                                    },
                                )
                                .await;
                            // Projection and controls are covered, but request receipts
                            // still have to drain through every bounded journal page.
                            retained_through = retained_through.max(batch.head);
                        } else if batch.reset_required {
                            proxy.send(ServerMessage::FreshAgentEvent(FreshAgentEvent {
                                event: serde_json::json!({
                                    "type":"freshAgent.host.journal.reset",
                                    "retainedFrom":batch.retained_from,
                                }),
                                provider: provider.clone(),
                                session_id: presentation_session_id.clone(),
                                session_type: session_type.clone(),
                            }));
                        }
                        if batch.events.is_empty() {
                            cursor = cursor.max(batch.head);
                        }
                        for event in batch.events {
                            cursor = cursor.max(event.sequence);
                            if event.sequence <= retained_through
                                && !is_request_receipt(&event.event)
                            {
                                continue;
                            }
                            // Provider-native identity is nested provider state. The public
                            // routing alias changes only through an explicit same-soul fork
                            // transition or durable inventory reconciliation, never merely
                            // because initial startup observed a native ID.
                            let current_presentation = proxy
                                .presentation_ids
                                .lock()
                                .await
                                .get(&soul)
                                .cloned()
                                .unwrap_or_else(|| presentation_session_id.clone());
                            proxy
                                .forward_host_event(
                                    event.event,
                                    &provider,
                                    &current_presentation,
                                    &session_type,
                                )
                                .await;
                        }
                    }
                    Err(_) => {
                        let still_running =
                            proxy.client.inventory().await.ok().is_some_and(|views| {
                                views.into_iter().any(|view| {
                                    view.soul_id == soul
                                        && view.desired_state == DesiredState::Running
                                })
                            });
                        if !still_running {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(500)).await;
                    }
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            proxy.pollers.lock().await.remove(&soul);
            proxy.presentation_ids.lock().await.remove(&soul);
        });
        true
    }

    async fn current_source(
        &self,
        soul: &SoulId,
    ) -> Option<freshell_runtime_protocol::RuntimeView> {
        self.client
            .inventory()
            .await
            .ok()?
            .into_iter()
            .rev()
            .find(|view| {
                &view.soul_id == soul
                    && view.desired_state == DesiredState::Running
                    && view.launch_state == freshell_runtime_protocol::LaunchState::Running
            })
    }

    async fn forward_retained(
        &self,
        mut retained: serde_json::Value,
        provider: &str,
        presentation: &str,
        session_type: &str,
        event_type: &str,
    ) {
        let native = retained["snapshot"]["threadId"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        if provider == "codex" {
            if let Some(facts) = retained["snapshot"]["extensions"]["codex"]
                .as_object_mut()
                .and_then(|extension| extension.remove("hostedNamingFacts"))
            {
                let facts = facts.as_array().into_iter().flatten();
                // A retained accepted input may precede its admission fact.
                // Bind/admit first, then fold that same idempotent input.
                for fact in facts
                    .clone()
                    .filter(|fact| fact["kind"] != "activity")
                    .chain(facts.filter(|fact| fact["kind"] == "activity"))
                {
                    self.fold_hosted_codex_naming(presentation, &native, fact.clone())
                        .await;
                }
            }
        }
        retained["source"]["nativeSessionId"] = retained["snapshot"]["threadId"].clone();
        if let Some(ownership) = self.ownership.get() {
            let canonical = ownership.resolve_canonical(provider, presentation);
            let owner = ownership.observe(provider, &canonical);
            retained["source"]["ownerEpoch"] = serde_json::json!(owner.epoch);
            retained["source"]["ownerGeneration"] = serde_json::json!(owner.generation);
        }
        freshell_agent_runtime::snapshot_projection::project_hosted_rest_snapshot(
            &mut retained["snapshot"],
            provider,
            session_type,
        );
        for mark in retained["attentionMarks"]
            .as_array_mut()
            .into_iter()
            .flatten()
        {
            mark["sessionId"] = serde_json::json!(presentation);
        }
        self.send(ServerMessage::FreshAgentEvent(FreshAgentEvent {
            provider: provider.into(),
            session_type: session_type.into(),
            session_id: presentation.into(),
            event: serde_json::json!({"type":event_type,"retainedState":retained}),
        }));
        for payload in retained["pendingControls"].as_array().into_iter().flatten() {
            self.forward_host_event(
                AgentEvent::PermissionRequested {
                    decision_id: payload["requestId"].as_str().unwrap_or_default().into(),
                    payload: payload.clone(),
                },
                provider,
                presentation,
                session_type,
            )
            .await;
        }
    }

    async fn replay_once(
        &self,
        soul: SoulId,
        provider: &str,
        presentation_session_id: &str,
        session_type: &str,
    ) {
        let mut before = if provider == "codex" {
            self.current_source(&soul).await
        } else {
            None
        };
        let mut cursor = 0;
        let mut replay_through = None;
        let mut retained_through = 0;
        loop {
            let Ok(batch) = self
                .client
                .fresh_agent_events(soul.clone(), cursor, 4096)
                .await
            else {
                return;
            };
            let replay_through = *replay_through.get_or_insert(batch.head);
            if batch.retained_state.is_some() || cursor < retained_through {
                let after = self.current_source(&soul).await;
                let valid = retained_batch_matches_source(
                    before.as_ref(),
                    after.as_ref(),
                    batch.retained_state.as_ref(),
                );
                before = after;
                if !valid {
                    return;
                }
            }
            if let Some(retained) = batch.retained_state {
                self.forward_retained(
                    retained,
                    provider,
                    presentation_session_id,
                    session_type,
                    "freshAgent.host.backpressure",
                )
                .await;
                retained_through = retained_through.max(batch.head);
            }
            if batch.events.is_empty() {
                return;
            }
            for event in batch.events {
                if event.sequence > replay_through {
                    return;
                }
                cursor = cursor.max(event.sequence);
                if event.sequence > retained_through || is_request_receipt(&event.event) {
                    self.forward_host_event(
                        event.event,
                        provider,
                        presentation_session_id,
                        session_type,
                    )
                    .await;
                }
            }
            if cursor >= replay_through {
                return;
            }
        }
    }

    async fn forward_host_event(
        &self,
        event: AgentEvent,
        provider: &str,
        presentation_session_id: &str,
        session_type: &str,
    ) {
        match event {
            AgentEvent::Provider { mut payload } => {
                if payload["event"]["type"]
                    == freshell_freshagent::naming::HOSTED_CODEX_NAMING_EVENT
                {
                    if provider == "codex" {
                        let native = payload["sessionId"].as_str().unwrap_or_default();
                        self.fold_hosted_codex_naming(
                            presentation_session_id,
                            native,
                            payload["event"]["fact"].clone(),
                        )
                        .await;
                    }
                    return;
                }
                if payload.get("type").and_then(serde_json::Value::as_str)
                    == Some("freshAgent.created")
                {
                    return;
                }
                rewrite_presentation_id(&mut payload, presentation_session_id);
                freshell_agent_runtime::snapshot_projection::project_hosted_snapshot(
                    &mut payload,
                    provider,
                    session_type,
                );
                if let Ok(frame) = serde_json::to_string(&payload) {
                    let _ = self.broadcast.send(frame);
                }
            }
            AgentEvent::PermissionRequested { payload, .. } => {
                self.send(ServerMessage::FreshAgentEvent(FreshAgentEvent {
                    event: payload,
                    provider: provider.into(),
                    session_id: presentation_session_id.into(),
                    session_type: session_type.into(),
                }));
            }
            _ => {}
        }
    }

    async fn fold_hosted_codex_naming(
        &self,
        presentation: &str,
        native_id: &str,
        value: serde_json::Value,
    ) {
        use freshell_freshagent::naming::{HostedCodexNamingFact, NameTransitionReason};
        use freshell_protocol::native_location::{
            NativeEvidenceKind, NativeLocation, NativePersistence,
        };
        use freshell_protocol::session_names::{NamedProvider, SessionNameRef};
        if native_id.is_empty() {
            return;
        }
        let Some(soul) = self
            .resolve_soul(&AgentProvider::Codex, SessionType::Freshcodex, presentation)
            .await
        else {
            return;
        };
        let current = self.current_source(&soul).await;
        if current
            .as_ref()
            .and_then(|view| view.native_session_id.as_deref())
            != Some(native_id)
        {
            tracing::warn!(
                provider = "codex",
                session_id = presentation,
                native_session_id = native_id,
                "freshagent.gateway.naming_source_changed"
            );
            return;
        }
        let fact = match serde_json::from_value::<HostedCodexNamingFact>(value) {
            Ok(fact) => fact,
            Err(error) => {
                tracing::warn!(provider="codex", native_session_id=native_id, %error, "freshagent.gateway.invalid_naming_fact");
                return;
            }
        };
        let sink = self.naming.get().cloned();
        match fact {
            HostedCodexNamingFact::Acquisition {
                target,
                acquisition,
                cwd,
            } => {
                let expected = SessionNameRef::Session {
                    provider: NamedProvider::Codex,
                    session_id: native_id.into(),
                };
                let location_matches = matches!(&acquisition.location,
                    NativeLocation::Codex { codex_home, native_thread_id: Some(id), rollout_path: Some(path), .. }
                    if !codex_home.is_empty() && id == native_id && !path.is_empty());
                if target != expected
                    || !location_matches
                    || acquisition.persistence != NativePersistence::Verified
                    || acquisition.evidence != NativeEvidenceKind::PersistedMetadata
                {
                    tracing::warn!(
                        provider = "codex",
                        native_session_id = native_id,
                        "freshagent.gateway.naming_source_mismatch"
                    );
                    return;
                }
                if let Some(sink) = sink {
                    if let Err(error) = sink.ensure_session(target.clone(), cwd).await {
                        freshell_freshagent::naming::log_name_error(
                            "ensure_session",
                            &target,
                            &error,
                        );
                        return;
                    }
                    let after_admission = self.current_source(&soul).await;
                    if !current
                        .as_ref()
                        .zip(after_admission.as_ref())
                        .is_some_and(|(before, after)| rest::same_snapshot_source(before, after))
                    {
                        tracing::warn!(
                            provider = "codex",
                            session_id = presentation,
                            native_session_id = native_id,
                            "freshagent.gateway.naming_source_changed"
                        );
                        return;
                    }
                    if let Err(error) = sink.record_acquisition(target.clone(), acquisition).await {
                        freshell_freshagent::naming::log_name_error(
                            "record_acquisition",
                            &target,
                            &error,
                        );
                    }
                    let after_acquisition = self.current_source(&soul).await;
                    if !current
                        .as_ref()
                        .zip(after_acquisition.as_ref())
                        .is_some_and(|(before, after)| rest::same_snapshot_source(before, after))
                    {
                        tracing::warn!(
                            provider = "codex",
                            session_id = presentation,
                            native_session_id = native_id,
                            "freshagent.gateway.naming_source_changed"
                        );
                    }
                }
            }
            HostedCodexNamingFact::Activity(input) => {
                let valid_target = match &input.target {
                    SessionNameRef::Pending { id } => !id.is_empty(),
                    SessionNameRef::Session {
                        provider,
                        session_id,
                    } => *provider == NamedProvider::Codex && session_id == native_id,
                };
                if valid_target && input.mode == "freshcodex" {
                    if let Some(sink) = sink {
                        if let Err(error) = sink.activity(input.clone()).await {
                            freshell_freshagent::naming::log_name_error(
                                "activity",
                                &input.target,
                                &error,
                            );
                        }
                    }
                }
            }
            HostedCodexNamingFact::Transition { target, transition } => {
                let expected = SessionNameRef::Session {
                    provider: NamedProvider::Codex,
                    session_id: native_id.into(),
                };
                let location_matches = matches!(&transition.acquisition.location, NativeLocation::Codex { native_thread_id:Some(id), .. } if id == native_id);
                if target != expected
                    || !location_matches
                    || transition.reason != NameTransitionReason::InitialMaterialization
                    || transition.acquisition.persistence != NativePersistence::Verified
                {
                    tracing::warn!(
                        provider = "codex",
                        native_session_id = native_id,
                        "freshagent.gateway.naming_source_mismatch"
                    );
                    return;
                }
                freshell_freshagent::naming::fold_identity_transition(&sink, &transition, target)
                    .await;
            }
        }
    }

    fn error_event(
        &self,
        provider: &AgentProvider,
        session_id: &str,
        session_type: SessionType,
        message: &str,
    ) {
        self.error_event_code(
            provider,
            session_id,
            session_type,
            "MANAGED_FRESH_AGENT_ERROR",
            message,
        );
    }

    fn operation_error_event(
        &self,
        provider: &AgentProvider,
        session_id: &str,
        session_type: SessionType,
        error: &freshell_runtime_client::ClientError,
        fallback: &str,
    ) {
        let code = operation_error_code(error);
        self.error_event_code(provider, session_id, session_type, code, fallback);
    }

    fn error_event_code(
        &self,
        provider: &AgentProvider,
        session_id: &str,
        session_type: SessionType,
        code: &str,
        message: &str,
    ) {
        self.send(ServerMessage::FreshAgentEvent(FreshAgentEvent {
            event: fresh_agent_error_payload(code, message),
            provider: provider_wire(provider),
            session_id: session_id.into(),
            session_type: session_type_wire(session_type),
        }));
    }

    fn send(&self, message: ServerMessage) {
        if let Ok(frame) = serde_json::to_string(&message) {
            let _ = self.broadcast.send(frame);
        }
    }
}

fn named_provider(provider: &FreshProvider) -> NamedProvider {
    match provider {
        FreshProvider::Claude | FreshProvider::Kilroy => NamedProvider::Claude,
        FreshProvider::Codex => NamedProvider::Codex,
        FreshProvider::Opencode => NamedProvider::Opencode,
    }
}

impl HostedFreshAgentGateway for HostedFreshAgentProxy {
    fn attention_marks(
        &self,
    ) -> Pin<Box<dyn Future<Output = Vec<freshell_protocol::FreshAgentAttentionMark>> + Send + '_>>
    {
        Box::pin(async move {
            let Ok(views) = self.client.inventory().await else {
                return Vec::new();
            };
            let mut marks = Vec::new();
            for before in views.into_iter().filter(|view| {
                view.provider.as_deref() == Some("codex")
                    && view.fresh_agent_session_type.as_deref() == Some("freshcodex")
                    && view.desired_state == DesiredState::Running
            }) {
                let Ok(batch) = self
                    .client
                    .fresh_agent_events(before.soul_id.clone(), 0, 1)
                    .await
                else {
                    continue;
                };
                let Some(retained) = batch.retained_state else {
                    continue;
                };
                let Some(after) = self.current_source(&before.soul_id).await else {
                    continue;
                };
                if !same_retained_host(&before, &after)
                    || !retained_matches_view(&retained, &before)
                    || !retained_matches_view(&retained, &after)
                {
                    continue;
                }
                let presentation = self
                    .presentation_ids
                    .lock()
                    .await
                    .get(&before.soul_id)
                    .cloned()
                    .or(before.fresh_agent_session_id.clone())
                    .or(before.native_session_id.clone());
                let Some(presentation) = presentation else {
                    continue;
                };
                if let Ok(current) = serde_json::from_value::<
                    Vec<freshell_protocol::FreshAgentAttentionMark>,
                >(retained["attentionMarks"].clone())
                {
                    marks.extend(
                        current
                            .into_iter()
                            .filter(|mark| {
                                mark.provider == "codex" && mark.session_type == "freshcodex"
                            })
                            .map(|mut mark| {
                                mark.session_id = presentation.clone();
                                mark
                            }),
                    );
                }
            }
            marks
        })
    }
    fn dispatch(
        self: Arc<Self>,
        command: HostedFreshAgentCommand,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'static>> {
        Box::pin(async move { self.handle(command).await })
    }
}

#[path = "fresh_agent_proxy_naming.rs"]
mod native_naming;
#[path = "fresh_agent_proxy_rest.rs"]
mod rest;
#[cfg(test)]
use rest::provider_event_completes_turn;

fn resume_view_matches(
    view: &freshell_runtime_protocol::RuntimeView,
    provider: &str,
    session_id: &str,
) -> bool {
    resume_identity_matches(
        view.desired_state,
        view.provider.as_deref(),
        view.native_session_id.as_deref(),
        view.fresh_agent_session_id.as_deref(),
        provider,
        session_id,
    )
}

fn resume_identity_matches(
    desired_state: DesiredState,
    actual_provider: Option<&str>,
    native_session_id: Option<&str>,
    presentation_session_id: Option<&str>,
    expected_provider: &str,
    expected_session_id: &str,
) -> bool {
    desired_state == DesiredState::Running
        && actual_provider == Some(expected_provider)
        && (native_session_id == Some(expected_session_id)
            || presentation_session_id == Some(expected_session_id))
}

fn fresh_provider(
    provider: &Option<AgentProvider>,
    session_type: SessionType,
) -> Option<FreshProvider> {
    match (provider.as_ref()?, session_type) {
        (AgentProvider::Claude, SessionType::Freshclaude) => Some(FreshProvider::Claude),
        (AgentProvider::Claude, SessionType::Kilroy) => Some(FreshProvider::Kilroy),
        (AgentProvider::Codex, SessionType::Freshcodex) => Some(FreshProvider::Codex),
        (AgentProvider::Opencode, SessionType::Freshopencode) => Some(FreshProvider::Opencode),
        _ => None,
    }
}

fn rest_agent_identity(
    provider: &str,
    session_type: &str,
) -> Result<(AgentProvider, SessionType), ()> {
    match (provider, session_type) {
        ("claude", "freshclaude") => Ok((AgentProvider::Claude, SessionType::Freshclaude)),
        ("claude", "kilroy") => Ok((AgentProvider::Claude, SessionType::Kilroy)),
        ("codex", "freshcodex") => Ok((AgentProvider::Codex, SessionType::Freshcodex)),
        ("opencode", "freshopencode") => Ok((AgentProvider::Opencode, SessionType::Freshopencode)),
        _ => Err(()),
    }
}

fn turn_settings(
    settings: Option<freshell_protocol::FreshAgentSendSettings>,
    cwd: Option<String>,
) -> Option<freshell_runtime_protocol::FreshAgentTurnSettings> {
    let mut settings = settings.map(
        |settings| freshell_runtime_protocol::FreshAgentTurnSettings {
            collaboration_mode: settings.collaboration_mode,
            cwd: settings.cwd,
            model: settings.model,
            effort: settings.effort,
            permission_mode: settings.permission_mode,
            sandbox: settings
                .sandbox
                .and_then(|value| serde_json::to_value(value).ok())
                .and_then(|value| value.as_str().map(str::to_string)),
        },
    );
    if let Some(cwd) = cwd {
        settings
            .get_or_insert_with(Default::default)
            .cwd
            .get_or_insert(cwd);
    }
    settings
}

fn runtime_variant(provider: &FreshProvider) -> &'static str {
    match provider {
        FreshProvider::Claude => "claude-agent-sdk",
        FreshProvider::Kilroy => "kilroy-claude-agent-sdk",
        FreshProvider::Codex => "codex-app-server",
        FreshProvider::Opencode => "opencode-per-soul-http",
    }
}

fn fresh_provider_wire(provider: &FreshProvider) -> &'static str {
    match provider {
        FreshProvider::Kilroy => "claude",
        other => other.as_str(),
    }
}

#[cfg(any(test, feature = "managed-fresh-agent-fixtures"))]
fn parse_fixture_modes(raw: &str) -> Result<HashSet<String>, String> {
    const MODES: [&str; 4] = ["freshclaude", "kilroy", "freshcodex", "freshopencode"];
    if raw.is_empty() {
        return Err(format!("{FIXTURE_MODES_ENV} must not be empty"));
    }
    let mut selected = HashSet::new();
    for mode in raw.split(',') {
        if mode.trim() != mode || !MODES.contains(&mode) {
            return Err(format!(
                "{FIXTURE_MODES_ENV} contains non-exact fresh-agent mode {mode:?}"
            ));
        }
        if !selected.insert(mode.to_string()) {
            return Err(format!(
                "{FIXTURE_MODES_ENV} contains duplicate mode {mode:?}"
            ));
        }
    }
    Ok(selected)
}

#[cfg(feature = "managed-fresh-agent-fixtures")]
fn configured_fixture_modes() -> Result<HashSet<String>, String> {
    std::env::var(FIXTURE_MODES_ENV)
        .ok()
        .map(|raw| parse_fixture_modes(&raw))
        .transpose()
        .map(|value| value.unwrap_or_default())
}

#[cfg(not(feature = "managed-fresh-agent-fixtures"))]
fn configured_fixture_modes() -> Result<HashSet<String>, String> {
    if std::env::var_os(FIXTURE_MODES_ENV).is_some() {
        return Err(format!(
            "{FIXTURE_MODES_ENV} requires a server built with managed-fresh-agent-fixtures"
        ));
    }
    Ok(HashSet::new())
}

fn provider_wire(provider: &AgentProvider) -> String {
    match provider {
        AgentProvider::Claude => "claude",
        AgentProvider::Codex => "codex",
        AgentProvider::Opencode => "opencode",
        AgentProvider::Amplifier => "amplifier",
    }
    .into()
}

fn session_type_wire(session_type: SessionType) -> String {
    match session_type {
        SessionType::Freshclaude => "freshclaude",
        SessionType::Freshcodex => "freshcodex",
        SessionType::Freshopencode => "freshopencode",
        SessionType::Kilroy => "kilroy",
    }
    .into()
}

fn decision_id(value: StringOrNumber) -> String {
    match value {
        StringOrNumber::Str(value) => value,
        StringOrNumber::Num(value) => value.to_string(),
    }
}

fn operation_error_code(error: &freshell_runtime_client::ClientError) -> &'static str {
    match error.runtime_code() {
        Some(RuntimeErrorCode::UnsupportedOperation) => "UNSUPPORTED_CAPABILITY",
        Some(RuntimeErrorCode::OperationImplementationUnavailable) => "IMPLEMENTATION_UNAVAILABLE",
        Some(RuntimeErrorCode::CommandAmbiguous) => "COMMAND_AMBIGUOUS",
        Some(RuntimeErrorCode::RequestIdConflict) => "REQUEST_ID_CONFLICT",
        _ => "MANAGED_FRESH_AGENT_ERROR",
    }
}

fn fresh_agent_error_payload(code: &str, message: &str) -> serde_json::Value {
    serde_json::json!({
        "type":"freshAgent.error",
        "code":code,
        "message":message,
    })
}

fn same_retained_host(
    before: &freshell_runtime_protocol::RuntimeView,
    after: &freshell_runtime_protocol::RuntimeView,
) -> bool {
    before.soul_id == after.soul_id
        && before.incarnation_id == after.incarnation_id
        && before.host_boot_id == after.host_boot_id
}

/// Retained projection/control state does not carry request acknowledgements.
/// Keep only these receipts when superseding the journal's display prefix.
fn is_request_receipt(event: &AgentEvent) -> bool {
    let AgentEvent::Provider { payload } = event else {
        return false;
    };
    let receipt = if payload["type"] == "freshAgent.event"
        && matches!(
            payload["event"]["type"].as_str(),
            Some(
                "checkpointTurnIdentity"
                    | "freshAgent.rolledBack"
                    | "freshAgent.redone"
                    | "freshAgent.error"
            )
        ) {
        &payload["event"]
    } else if matches!(
        payload["type"].as_str(),
        Some("freshAgent.send.accepted" | "error" | "freshAgent.checkpoint.outcome")
    ) {
        payload
    } else {
        return false;
    };
    receipt["requestId"]
        .as_str()
        .is_some_and(|id| !id.is_empty())
}

fn retained_batch_matches_source(
    before: Option<&freshell_runtime_protocol::RuntimeView>,
    after: Option<&freshell_runtime_protocol::RuntimeView>,
    retained: Option<&serde_json::Value>,
) -> bool {
    before.zip(after).is_some_and(|(before, after)| {
        same_retained_host(before, after)
            && before.native_session_id == after.native_session_id
            && retained.is_none_or(|retained| {
                retained_matches_view(retained, before) && retained_matches_view(retained, after)
            })
    })
}

fn retained_matches_view(
    retained: &serde_json::Value,
    view: &freshell_runtime_protocol::RuntimeView,
) -> bool {
    retained["source"]["soulId"].as_str() == Some(view.soul_id.as_str())
        && retained["source"]["incarnationId"].as_str() == Some(view.incarnation_id.as_str())
        && view
            .host_boot_id
            .as_ref()
            .is_some_and(|boot| retained["source"]["hostBootId"].as_str() == Some(boot.as_str()))
        && retained["snapshot"]["provider"] == "codex"
        && retained["snapshot"]["sessionType"] == "freshcodex"
        && retained["snapshot"]["threadId"].as_str() == view.native_session_id.as_deref()
}

fn rewrite_presentation_id(payload: &mut serde_json::Value, presentation_id: &str) {
    let Some(object) = payload.as_object_mut() else {
        return;
    };
    let event_type = object
        .get("type")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    match event_type.as_deref() {
        Some("freshAgent.session.materialized") => {
            object.insert("previousSessionId".into(), presentation_id.into());
        }
        Some(value) if value.starts_with("freshAgent.") => {
            object.insert("sessionId".into(), presentation_id.into());
            if value == "freshAgent.created" {
                if let Some(session_ref) = object
                    .get_mut("sessionRef")
                    .and_then(serde_json::Value::as_object_mut)
                {
                    session_ref.insert("sessionId".into(), presentation_id.into());
                }
            }
        }
        _ => {}
    }
    // Provider broadcasts can be either a raw freshAgent.* frame or a
    // ServerMessage::FreshAgentEvent envelope. Rewrite the nested event too;
    // materialization still preserves the newly observed native identity by
    // changing only previousSessionId in its own arm above.
    for child in object.values_mut() {
        rewrite_presentation_id(child, presentation_id);
    }
}

fn stable_hex(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))[..32].to_string()
}

fn presentation_id_for_create(
    provider: &FreshProvider,
    request_id: &str,
    native_session_id: Option<&str>,
) -> String {
    native_session_id
        .map(str::to_owned)
        .unwrap_or_else(|| format!("managed-{}-{}", provider.as_str(), stable_hex(request_id)))
}

fn stable_soul_id(provider: &str, request_id: &str) -> Result<SoulId, String> {
    SoulId::parse(format!("soul-fresh-{provider}-{}", stable_hex(request_id)))
        .map_err(|error| error.to_string())
}

fn stable_request_id(request_id: &str) -> Result<RequestId, String> {
    RequestId::parse(format!("request-fresh-{}", stable_hex(request_id)))
        .map_err(|error| error.to_string())
}

fn canonical_cwd(cwd: Option<&str>) -> Result<PathBuf, String> {
    let path = cwd
        .map(PathBuf::from)
        .unwrap_or(std::env::current_dir().map_err(|error| error.to_string())?);
    let path = std::fs::canonicalize(&path).map_err(|error| error.to_string())?;
    path.is_dir()
        .then_some(path)
        .ok_or_else(|| "managed fresh-agent cwd is not a directory".into())
}

fn workspace_root(cwd: &Path) -> PathBuf {
    git_stdout(cwd, &["rev-parse", "--show-toplevel"])
        .and_then(|value| std::fs::canonicalize(value.trim()).ok())
        .filter(|value| value.is_dir())
        .unwrap_or_else(|| cwd.to_path_buf())
}

fn git_common_dir(workspace: &Path) -> Option<PathBuf> {
    let raw = PathBuf::from(git_stdout(workspace, &["rev-parse", "--git-common-dir"])?.trim());
    let candidate = if raw.is_absolute() {
        raw
    } else {
        workspace.join(raw)
    };
    std::fs::canonicalize(candidate)
        .ok()
        .filter(|value| value.is_dir())
}

fn git_stdout(cwd: &Path, args: &[&str]) -> Option<String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(test)]
#[path = "fresh_agent_proxy_tests.rs"]
mod tests;

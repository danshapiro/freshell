#![cfg(feature = "managed-runtime-v1")]

//! Opt-in external gateway from the retained fresh-agent wire to the
//! supervisor/session-host actor. This module owns no provider process.

use freshell_freshagent::hosted_rest::{
    HostedFreshAgentRestGateway, HostedRestCapture, HostedRestCaptureError,
    HostedRestCaptureResult, HostedRestCreate, HostedRestCreated, HostedRestSend,
    HostedRestSendResult,
};
use freshell_protocol::{
    AgentProvider, FreshAgentCreateFailed, FreshAgentCreated, FreshAgentEvent, FreshAgentForked,
    FreshAgentKilled, ServerMessage, SessionLocator, SessionType, StringOrNumber,
};
use freshell_runtime_client::RuntimeClient;
use freshell_runtime_protocol::{
    AgentEvent, DesiredState, FreshAgentLaunchSpec, FreshAgentRollbackDirection,
    FreshAgentRollbackMode, FreshProvider, LaunchRequest, ProviderBootstrapFile, RequestId,
    RuntimeErrorCode, RuntimeLimits, RuntimeProfile, SoulId, StopOutcome, ViewIntentKind,
    ViewIntentRequest, ViewVisibilityIntent,
};
use freshell_ws::hosted_fresh_agent::{HostedFreshAgentCommand, HostedFreshAgentGateway};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
    time::Duration,
};
use tokio::sync::{broadcast, Mutex};

const OPT_IN_ENV: &str = "FRESHELL_MANAGED_FRESH_AGENT_V1";
const PROVIDER_UID: u32 = 65_534;
const PROVIDER_GID: u32 = 0;

pub(crate) struct HostedFreshAgentProxy {
    client: RuntimeClient,
    broadcast: Arc<broadcast::Sender<String>>,
    aliases: Mutex<HashMap<(String, String), SoulId>>,
    presentation_ids: Mutex<HashMap<SoulId, String>>,
    pollers: Mutex<HashSet<SoulId>>,
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
        Ok(Some(Arc::new(Self {
            client,
            broadcast,
            aliases: Mutex::new(HashMap::new()),
            presentation_ids: Mutex::new(HashMap::new()),
            pollers: Mutex::new(HashSet::new()),
        })))
    }

    async fn handle(self: Arc<Self>, command: HostedFreshAgentCommand) {
        match command {
            HostedFreshAgentCommand::Create(message) => {
                let request_id = message.request_id.clone();
                if self.create(message).await.is_err() {
                    self.send(ServerMessage::FreshAgentCreateFailed(
                        FreshAgentCreateFailed {
                            code: "FRESH_AGENT_CREATE_FAILED".into(),
                            message: "managed fresh-agent host could not be created".into(),
                            request_id,
                            retryable: Some(true),
                        },
                    ));
                }
            }
            HostedFreshAgentCommand::Attach(message) => {
                if let Some(soul) = self
                    .resolve_soul(&message.provider, &message.session_id)
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
                let provider = message.provider.clone();
                let session_id = message.session_id.clone();
                let session_type = message.session_type;
                let request_id = message
                    .request_id
                    .as_deref()
                    .and_then(|value| RequestId::parse(value.to_string()).ok())
                    .unwrap_or_else(RequestId::new);
                let result = match self.resolve_soul(&provider, &session_id).await {
                    Some(soul) => {
                        let settings = turn_settings(message.settings, message.cwd);
                        self.client
                            .fresh_agent_send(request_id, soul, message.text, settings)
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
            HostedFreshAgentCommand::Interrupt(message) => {
                let result = match self
                    .resolve_soul(&message.provider, &message.session_id)
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
            HostedFreshAgentCommand::Kill(message) => {
                let success = if let Some(soul) = self
                    .resolve_soul(&message.provider, &message.session_id)
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
                }));
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
                    .unwrap_or_else(RequestId::new);
                let result = match self
                    .resolve_soul(&message.provider, &message.session_id)
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
                let provider = message.provider.clone();
                let session_id = message.session_id.clone();
                let session_type = message.session_type;
                let request_id = message
                    .request_id
                    .as_deref()
                    .and_then(|value| RequestId::parse(value.to_string()).ok())
                    .unwrap_or_else(RequestId::new);
                let result = match self.resolve_soul(&provider, &session_id).await {
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
                self.rollback(
                    message.provider,
                    message.session_id,
                    message.session_type,
                    message.request_id,
                    FreshAgentRollbackDirection::Undo,
                    message.mode,
                    message.turn_id,
                    message.cwd,
                )
                .await;
            }
            HostedFreshAgentCommand::Redo(message) => {
                self.rollback(
                    message.provider,
                    message.session_id,
                    message.session_type,
                    message.request_id,
                    FreshAgentRollbackDirection::Redo,
                    message.mode,
                    message.turn_id,
                    message.cwd,
                )
                .await;
            }
        }
    }

    async fn create(
        self: &Arc<Self>,
        message: freshell_protocol::FreshAgentCreate,
    ) -> Result<(), ()> {
        let provider = fresh_provider(&message.provider, message.session_type).ok_or(())?;
        if let Some(session_ref) = message.session_ref.as_ref() {
            if session_ref.provider != provider.as_str() {
                return Err(());
            }
            let inventory = self.client.inventory().await.map_err(|_| ())?;
            let view = inventory
                .into_iter()
                .rev()
                .find(|view| resume_view_matches(view, provider.as_str(), &session_ref.session_id))
                .ok_or(())?;
            let public_session_id = session_ref.session_id.clone();
            let soul = view.soul_id;
            let provider_name = provider.as_str().to_string();
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
                runtime_provider: provider_name.clone(),
                session_id: public_session_id.clone(),
                session_type: session_type_wire(message.session_type),
                session_ref: Some(SessionLocator {
                    provider: provider_name.clone(),
                    session_id: public_session_id.clone(),
                }),
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
                    provider.as_str(),
                    &public_session_id,
                    &session_type_wire(message.session_type),
                )
                .await;
            }
            return Ok(());
        }
        let cwd = canonical_cwd(message.cwd.as_deref()).map_err(|_| ())?;
        let workspace = workspace_root(&cwd);
        let soul = stable_soul_id(provider.as_str(), &message.request_id).map_err(|_| ())?;
        let public_session_id = message
            .session_ref
            .as_ref()
            .map(|value| value.session_id.clone())
            .unwrap_or_else(|| {
                format!(
                    "managed-{}-{}",
                    provider.as_str(),
                    stable_hex(&message.request_id)
                )
            });
        let native_session_id = message
            .session_ref
            .as_ref()
            .map(|value| value.session_id.clone());
        let session_type = session_type_wire(message.session_type);
        let launch = FreshAgentLaunchSpec {
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
            effort: message.effort.clone(),
            permission_mode: message.permission_mode.clone(),
            sandbox: message
                .sandbox
                .and_then(|value| serde_json::to_value(value).ok())
                .and_then(|value| value.as_str().map(str::to_string)),
            native_session_id: native_session_id.clone(),
            provider_bootstrap_files: provider_bootstrap_files(&provider).map_err(|_| ())?,
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
            native_session_id,
            fixture: None,
            terminal: None,
            fresh_agent: Some(launch),
            view_intent: Some(ViewIntentRequest {
                owner_id: String::new(),
                workspace_id: project_key,
                kind: ViewIntentKind::AutomaticPrimary,
                preferred_tab_id: message.tab_id.clone(),
                preferred_pane_id: None,
                title: Some(format!("{} agent", provider.as_str())),
                placement_group: None,
                visibility: ViewVisibilityIntent::Visible,
            }),
            expected_control_epoch: None,
        };
        self.client
            .launch(
                stable_request_id(&message.request_id).map_err(|_| ())?,
                request,
            )
            .await
            .map_err(|_| ())?;
        self.aliases.lock().await.insert(
            (provider.as_str().into(), public_session_id.clone()),
            soul.clone(),
        );
        self.start_poller(
            soul,
            provider.as_str().into(),
            public_session_id,
            session_type,
        )
        .await;
        Ok(())
    }

    async fn resolve_decision(
        &self,
        provider: AgentProvider,
        session_id: String,
        session_type: SessionType,
        decision_id: String,
        decision: serde_json::Value,
    ) {
        let result = match self.resolve_soul(&provider, &session_id).await {
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

    async fn rollback(
        &self,
        provider: AgentProvider,
        session_id: String,
        session_type: SessionType,
        request_id: String,
        direction: FreshAgentRollbackDirection,
        mode: Option<freshell_protocol::RollbackMode>,
        turn_id: Option<String>,
        cwd: Option<String>,
    ) {
        let parsed_request_id = RequestId::parse(request_id);
        let result = match (
            parsed_request_id,
            self.resolve_soul(&provider, &session_id).await,
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

    async fn resolve_soul(&self, provider: &AgentProvider, session_id: &str) -> Option<SoulId> {
        let provider = provider_wire(provider);
        if let Some(soul) = self
            .aliases
            .lock()
            .await
            .get(&(provider.clone(), session_id.to_string()))
            .cloned()
        {
            return Some(soul);
        }
        let inventory = self.client.inventory().await.ok()?;
        let view = inventory.into_iter().rev().find(|view| {
            view.desired_state == DesiredState::Running
                && view.provider.as_deref() == Some(provider.as_str())
                && (view.fresh_agent_session_id.as_deref() == Some(session_id)
                    || view.native_session_id.as_deref() == Some(session_id))
        })?;
        self.aliases
            .lock()
            .await
            .insert((provider, session_id.to_string()), view.soul_id.clone());
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
            loop {
                match proxy
                    .client
                    .fresh_agent_events(soul.clone(), cursor, 128)
                    .await
                {
                    Ok(batch) => {
                        if batch.reset_required {
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
                        for event in batch.events {
                            cursor = cursor.max(event.sequence);
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
                            proxy.forward_host_event(
                                event.event,
                                &provider,
                                &current_presentation,
                                &session_type,
                            );
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

    async fn replay_once(
        &self,
        soul: SoulId,
        provider: &str,
        presentation_session_id: &str,
        session_type: &str,
    ) {
        let Ok(batch) = self.client.fresh_agent_events(soul, 0, 4096).await else {
            return;
        };
        for event in batch.events {
            self.forward_host_event(event.event, provider, presentation_session_id, session_type);
        }
    }

    fn forward_host_event(
        &self,
        event: AgentEvent,
        provider: &str,
        presentation_session_id: &str,
        session_type: &str,
    ) {
        match event {
            AgentEvent::Provider { mut payload } => {
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

impl HostedFreshAgentGateway for HostedFreshAgentProxy {
    fn dispatch(
        self: Arc<Self>,
        command: HostedFreshAgentCommand,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'static>> {
        Box::pin(async move { self.handle(command).await })
    }
}

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

fn turn_settings(
    settings: Option<freshell_protocol::FreshAgentSendSettings>,
    cwd: Option<String>,
) -> Option<freshell_runtime_protocol::FreshAgentTurnSettings> {
    let mut settings = settings.map(
        |settings| freshell_runtime_protocol::FreshAgentTurnSettings {
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
            .get_or_insert(freshell_runtime_protocol::FreshAgentTurnSettings {
                cwd: None,
                model: None,
                effort: None,
                permission_mode: None,
                sandbox: None,
            })
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

fn provider_bootstrap_files(
    provider: &FreshProvider,
) -> Result<Vec<ProviderBootstrapFile>, String> {
    let home = std::env::var("HOME")
        .ok()
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let (override_key, fallback, relative) = match provider {
        FreshProvider::Claude | FreshProvider::Kilroy => (
            "FRESHELL_MANAGED_CLAUDE_CREDENTIAL_FILE",
            home.map(|value| value.join(".claude/.credentials.json")),
            ".claude/.credentials.json",
        ),
        FreshProvider::Codex => (
            "FRESHELL_MANAGED_CODEX_AUTH_FILE",
            home.map(|value| value.join(".codex/auth.json")),
            ".codex/auth.json",
        ),
        FreshProvider::Opencode => (
            "FRESHELL_MANAGED_OPENCODE_AUTH_FILE",
            home.map(|value| value.join(".local/share/opencode/auth.json")),
            ".local/share/opencode/auth.json",
        ),
    };
    let candidate = std::env::var(override_key)
        .ok()
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or(fallback)
        .filter(|value| value.is_file());
    let Some(candidate) = candidate else {
        return Ok(Vec::new());
    };
    let source_path = std::fs::canonicalize(candidate)
        .map_err(|_| "provider credential reference is unreadable".to_string())?;
    Ok(vec![ProviderBootstrapFile {
        source_path: source_path.to_string_lossy().into_owned(),
        provider_relative_path: relative.into(),
    }])
}

#[cfg(test)]
#[path = "fresh_agent_proxy_tests.rs"]
mod tests;

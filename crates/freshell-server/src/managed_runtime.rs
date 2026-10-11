#![cfg(feature = "managed-runtime-v1")]

use freshell_runtime_client::{ClientError, RuntimeClient};
use freshell_runtime_protocol::{
    CleanupState, DesiredState, LaunchRequest, LaunchState, RecoveryBlockReason, RecoveryOutcome,
    RecoveryProbe, RecoveryResult, RecoveryState, RecoveryTrigger, RequestId, RuntimeErrorCode,
    RuntimeLimits, RuntimeProfile, RuntimeView, SoulId, StopOutcome, TerminalLaunchSpec,
    ViewIntentKind, ViewIntentRequest, ViewVisibilityIntent,
};
use freshell_terminal::registry::{
    ManagedLifecycle, ManagedLifecycleState, ManagedOutputChunk, ManagedOutputCompletion,
    ManagedOutputRead, ManagedTerminalController, ManagedTerminalDescriptor, ManagedTerminalFuture,
    ManagedTerminalLaunch,
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
};
use tokio::sync::Mutex;

#[path = "managed_output_validation.rs"]
mod managed_output_validation;

#[derive(Debug, Clone)]
enum RecoveryPublication {
    Recovering {
        previous: Option<Box<RecoveryResult>>,
    },
    Finished(Box<RecoveryResult>),
    Failed {
        code: RuntimeErrorCode,
        previous: Option<Box<RecoveryResult>>,
    },
}
impl RecoveryPublication {
    fn result(&self) -> Option<&RecoveryResult> {
        match self {
            Self::Finished(result) => Some(result),
            Self::Recovering { previous } | Self::Failed { previous, .. } => previous.as_deref(),
        }
    }
}
#[derive(Debug, Clone)]
struct SoulRecoverySlot {
    sequence: u64,
    task_in_flight: bool,
    // Durable supervisor generation, independent of the local task sequence.
    incarnation_id: Option<String>,
    terminal_id: Option<String>,
    intent_revision: Option<u64>,
    evidence_revision: Option<u64>,
    publication: RecoveryPublication,
    observed_epoch: Option<String>,
    observed_exit_code: Option<i64>,
    observed_completion: Option<ManagedOutputCompletion>,
}
struct RecoveryObservation {
    terminal_id: String,
    incarnation_id: String,
    epoch: String,
    exit_code: Option<i64>,
    completion: Option<ManagedOutputCompletion>,
}
impl SoulRecoverySlot {
    fn observe(&mut self, observation: RecoveryObservation) {
        self.terminal_id = Some(observation.terminal_id);
        self.incarnation_id = Some(observation.incarnation_id);
        self.observed_epoch = Some(observation.epoch);
        self.observed_exit_code = observation.exit_code;
        self.observed_completion = observation.completion;
    }
}
#[derive(Default)]
struct ManagedRecoveryState {
    slots: Mutex<HashMap<String, SoulRecoverySlot>>,
}

fn wire_label(value: &impl serde::Serialize) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default()
}
fn recovery_summary(view: &RuntimeView) -> freshell_protocol::ManagedRecoverySummary {
    freshell_protocol::ManagedRecoverySummary {
        desired_state: wire_label(&view.desired_state),
        recovery_state: wire_label(&view.recovery_state),
        reason: view.recovery_reason.clone(),
        attempt_id: view.recovery_attempt_id.as_ref().map(ToString::to_string),
        incident_id: view.incident_id.as_ref().map(ToString::to_string),
        durability_state: wire_label(&view.durability_state),
        allocation_state: wire_label(&view.allocation_state),
    }
}
fn lifecycle(publication: &RecoveryPublication) -> ManagedLifecycle {
    let mut summary = publication
        .result()
        .map(|result| recovery_summary(&result.view));
    if let RecoveryPublication::Failed { code, .. } = publication {
        let summary = summary.get_or_insert_with(|| freshell_protocol::ManagedRecoverySummary {
            desired_state: wire_label(&DesiredState::Running),
            recovery_state: wire_label(&RecoveryState::Blocked),
            reason: None,
            attempt_id: None,
            incident_id: None,
            durability_state: wire_label(&freshell_runtime_protocol::DurabilityState::Unknown),
            allocation_state: wire_label(&freshell_runtime_protocol::AllocationState::Allocated),
        });
        summary.recovery_state = wire_label(&RecoveryState::Blocked);
        summary.reason = Some(wire_label(code).to_ascii_lowercase());
    }
    let state = match publication {
        RecoveryPublication::Recovering { .. } => ManagedLifecycleState::Recovering,
        RecoveryPublication::Failed { .. } => ManagedLifecycleState::Blocked,
        RecoveryPublication::Finished(result) => match result.outcome {
            RecoveryOutcome::AlreadyLive
            | RecoveryOutcome::Reattached
            | RecoveryOutcome::Replaced => ManagedLifecycleState::Running,
            RecoveryOutcome::Lost | RecoveryOutcome::Stopped
                if result.view.cleanup_state == CleanupState::VerifiedEmpty =>
            {
                ManagedLifecycleState::Ended
            }
            _ => ManagedLifecycleState::Blocked,
        },
    };
    ManagedLifecycle {
        state,
        recovery_summary: summary,
    }
}
fn classified_cause(publication: &RecoveryPublication) -> String {
    match publication {
        RecoveryPublication::Failed { code, .. } => wire_label(code),
        RecoveryPublication::Recovering { .. } => "recovering".into(),
        RecoveryPublication::Finished(result) => result
            .probe
            .as_ref()
            .map(|probe| match probe {
                RecoveryProbe::Blocked { reason, .. } => wire_label(reason),
                RecoveryProbe::DefinitivelyUnavailable { .. } => "verified_unavailable".into(),
                _ => "continuity_verified".into(),
            })
            .unwrap_or_else(|| {
                result.view.recovery_reason.clone().unwrap_or_else(|| {
                    match result.outcome {
                        RecoveryOutcome::AlreadyLive
                        | RecoveryOutcome::Reattached
                        | RecoveryOutcome::Replaced => "continuity_verified",
                        RecoveryOutcome::Lost => "verified_unavailable",
                        RecoveryOutcome::Stopped => "stopped",
                        RecoveryOutcome::Blocked => "blocked",
                    }
                    .into()
                })
            }),
    }
}
fn transition(
    soul: &str,
    from: Option<&RecoveryPublication>,
    to: &RecoveryPublication,
    terminal: Option<&str>,
    incarnation: Option<&str>,
) {
    let old = from.map(lifecycle);
    let new = lifecycle(to);
    let cause = classified_cause(to);
    if old.as_ref().map(|l| &l.state) == Some(&new.state)
        && from.map(classified_cause).as_deref() == Some(cause.as_str())
    {
        return;
    }
    let result = to.result();
    tracing::info!(event="managed_runtime.recovery_transition",soul_id=soul,
        terminal_id=result.and_then(|r|r.view.terminal_id.as_deref()).or(terminal),
        incarnation_id=result.map(|r|r.view.incarnation_id.as_str()).or(incarnation),
        attempt_id=result.and_then(|r|r.attempt_id.as_ref()).map(|id|id.as_str()),
        incident_id=result.and_then(|r|r.incident_id.as_ref()).map(|id|id.as_str()),
        from=old.map(|l|format!("{:?}",l.state)).unwrap_or_else(||"unobserved".into()),
        to=?new.state,outcome=result.map(|r|wire_label(&r.outcome)),cause,"Managed recovery state changed");
}
#[derive(Clone)]
pub struct ServerManagedRuntimeController {
    client: RuntimeClient,
    recovery: Arc<ManagedRecoveryState>,
}

impl ServerManagedRuntimeController {
    pub async fn from_env() -> Result<Option<Arc<Self>>, String> {
        if std::env::var("FRESHELL_MANAGED_RUNTIME_V1").ok().as_deref() != Some("1") {
            return Ok(None);
        }
        freshell_agent_runtime::process_qualification_policy()?;
        let socket = std::env::var("FRESHELL_RUNTIME_CONTROL_SOCKET").map_err(|_| {
            "FRESHELL_MANAGED_RUNTIME_V1=1 requires FRESHELL_RUNTIME_CONTROL_SOCKET".to_string()
        })?;
        let secret = std::env::var("FRESHELL_RUNTIME_CONTROL_SECRET_FILE").map_err(|_| {
            "FRESHELL_MANAGED_RUNTIME_V1=1 requires FRESHELL_RUNTIME_CONTROL_SECRET_FILE"
                .to_string()
        })?;
        let client = RuntimeClient::from_secret_file(socket, secret)
            .await
            .map_err(|e| format!("managed runtime client: {e}"))?;
        client
            .health()
            .await
            .map_err(|e| format!("managed runtime supervisor health: {e}"))?;
        let controller = Arc::new(Self {
            client,
            recovery: Arc::new(ManagedRecoveryState::default()),
        });
        Ok(Some(controller))
    }

    pub fn runtime_client(&self) -> RuntimeClient {
        self.client.clone()
    }

    async fn recovery_in_flight(&self, soul_id: &str) -> bool {
        self.recovery
            .slots
            .lock()
            .await
            .get(soul_id)
            .is_some_and(|slot| slot.task_in_flight)
    }

    async fn hydrate(&self, view: RuntimeView) {
        let mut slots = self.recovery.slots.lock().await;
        if slots.get(view.soul_id.as_str()).is_some_and(|slot| {
            slot.task_in_flight
                || slot
                    .intent_revision
                    .is_some_and(|revision| revision > view.intent_revision)
                || slot
                    .evidence_revision
                    .is_some_and(|revision| revision > view.evidence_revision)
        }) {
            return;
        }
        let result = RecoveryResult {
            outcome: match view.recovery_state {
                RecoveryState::Live => RecoveryOutcome::AlreadyLive,
                RecoveryState::Recovering => RecoveryOutcome::Blocked,
                RecoveryState::Blocked => RecoveryOutcome::Blocked,
                RecoveryState::Lost => RecoveryOutcome::Lost,
                RecoveryState::Stopped => RecoveryOutcome::Stopped,
            },
            attempt_id: view.recovery_attempt_id.clone(),
            incident_id: view.incident_id.clone(),
            prior_incarnation_id: view.prior_incarnation_id.clone(),
            expected_native_session_id: view.native_session_id.clone(),
            observed_native_session_id: view.native_session_id.clone(),
            probe: None,
            view: view.clone(),
        };
        let publication = if view.recovery_state == RecoveryState::Recovering {
            RecoveryPublication::Recovering {
                previous: Some(Box::new(result)),
            }
        } else {
            RecoveryPublication::Finished(Box::new(result))
        };
        if let Some(slot) = slots.get_mut(view.soul_id.as_str()) {
            transition(
                view.soul_id.as_str(),
                Some(&slot.publication),
                &publication,
                view.terminal_id.as_deref(),
                Some(view.incarnation_id.as_str()),
            );
            slot.incarnation_id = Some(view.incarnation_id.to_string());
            slot.terminal_id = view.terminal_id.clone();
            slot.intent_revision = Some(view.intent_revision);
            slot.evidence_revision = Some(view.evidence_revision);
            slot.publication = publication;
        } else {
            transition(
                view.soul_id.as_str(),
                None,
                &publication,
                view.terminal_id.as_deref(),
                Some(view.incarnation_id.as_str()),
            );
            slots.insert(
                view.soul_id.to_string(),
                SoulRecoverySlot {
                    sequence: 0,
                    task_in_flight: false,
                    incarnation_id: Some(view.incarnation_id.to_string()),
                    terminal_id: view.terminal_id.clone(),
                    intent_revision: Some(view.intent_revision),
                    evidence_revision: Some(view.evidence_revision),
                    publication,
                    observed_epoch: None,
                    observed_exit_code: None,
                    observed_completion: None,
                },
            );
        }
    }

    async fn begin_recovery(&self, soul: &SoulId, manual: bool) -> Option<u64> {
        self.begin_recovery_observed(soul, manual, None).await
    }

    async fn begin_recovery_observed(
        &self,
        soul: &SoulId,
        manual: bool,
        observation: Option<RecoveryObservation>,
    ) -> Option<u64> {
        let mut slots = self.recovery.slots.lock().await;
        if let Some(slot) = slots.get_mut(soul.as_str()) {
            if let Some(observation) = observation {
                slot.observe(observation);
            }
            if slot.task_in_flight {
                return None;
            }
            if !manual && lifecycle(&slot.publication).state != ManagedLifecycleState::Running {
                return None;
            }
            let sequence = slot.sequence.checked_add(1)?;
            let publication = RecoveryPublication::Recovering {
                previous: slot.publication.result().cloned().map(Box::new),
            };
            transition(
                soul.as_str(),
                Some(&slot.publication),
                &publication,
                slot.terminal_id.as_deref(),
                slot.incarnation_id.as_deref(),
            );
            slot.sequence = sequence;
            slot.task_in_flight = true;
            slot.publication = publication;
            Some(sequence)
        } else {
            let publication = RecoveryPublication::Recovering { previous: None };
            let mut slot = SoulRecoverySlot {
                sequence: 1,
                task_in_flight: true,
                incarnation_id: None,
                terminal_id: None,
                intent_revision: None,
                evidence_revision: None,
                publication,
                observed_epoch: None,
                observed_exit_code: None,
                observed_completion: None,
            };
            if let Some(observation) = observation {
                slot.observe(observation);
            }
            transition(
                soul.as_str(),
                None,
                &slot.publication,
                slot.terminal_id.as_deref(),
                slot.incarnation_id.as_deref(),
            );
            slots.insert(soul.to_string(), slot);
            Some(1)
        }
    }

    async fn publish_recovery(
        &self,
        soul: &SoulId,
        sequence: u64,
        result: &Result<RecoveryResult, ClientError>,
    ) {
        let mut slots = self.recovery.slots.lock().await;
        let Some(slot) = slots.get_mut(soul.as_str()) else {
            return;
        };
        if slot.sequence != sequence
            || !slot.task_in_flight
            || !matches!(slot.publication, RecoveryPublication::Recovering { .. })
        {
            return;
        }
        let publication = match result {
            Ok(result) => RecoveryPublication::Finished(Box::new(result.clone())),
            Err(error) => RecoveryPublication::Failed {
                code: error
                    .runtime_code()
                    .unwrap_or(RuntimeErrorCode::HostUnreachable),
                previous: slot.publication.result().cloned().map(Box::new),
            },
        };
        if let Ok(result) = result {
            slot.incarnation_id = Some(result.view.incarnation_id.to_string());
            slot.terminal_id = result.view.terminal_id.clone();
            slot.intent_revision = Some(result.view.intent_revision);
            slot.evidence_revision = Some(result.view.evidence_revision);
        }
        transition(
            soul.as_str(),
            Some(&slot.publication),
            &publication,
            slot.terminal_id.as_deref(),
            slot.incarnation_id.as_deref(),
        );
        slot.publication = publication;
        slot.task_in_flight = false;
    }

    async fn schedule_recovery(
        &self,
        soul: SoulId,
        trigger: RecoveryTrigger,
        observation: Option<RecoveryObservation>,
    ) {
        let Some(sequence) = self
            .begin_recovery_observed(&soul, false, observation)
            .await
        else {
            return;
        };
        let controller = self.clone();
        tokio::spawn(async move {
            if let Some(delay) = managed_recovery_test_delay() {
                tokio::time::sleep(delay).await;
            }
            let result = recover_with_policy(&controller.client, soul.clone(), trigger).await;
            controller.publish_recovery(&soul, sequence, &result).await;
        });
    }

    pub async fn retry_with_request_id(
        &self,
        request: RequestId,
        soul: SoulId,
        revision: u64,
    ) -> Result<RecoveryResult, ClientError> {
        let sequence = self.begin_recovery(&soul, true).await.ok_or_else(|| {
            ClientError::Runtime(
                RuntimeErrorCode::InvalidRequest,
                "recovery is already in progress".into(),
            )
        })?;
        let result = self
            .client
            .recover_expected_with_request_id(
                request,
                soul.clone(),
                RecoveryTrigger::ManualRetry,
                Some(revision),
            )
            .await;
        self.publish_recovery(&soul, sequence, &result).await;
        result
    }
}

impl ManagedTerminalController for ServerManagedRuntimeController {
    fn lifecycle_observation<'a>(
        &'a self,
        terminal: &'a ManagedTerminalDescriptor,
    ) -> ManagedTerminalFuture<'a, Option<ManagedLifecycle>> {
        Box::pin(async move {
            self.recovery
                .slots
                .lock()
                .await
                .get(&terminal.soul_id)
                .map(|slot| lifecycle(&slot.publication))
        })
    }

    fn lookup_terminal<'a>(
        &'a self,
        terminal_id: &'a str,
        create_request_id: Option<String>,
    ) -> ManagedTerminalFuture<'a, Result<Option<ManagedTerminalDescriptor>, String>> {
        Box::pin(async move {
            let views = self
                .client
                .inventory()
                .await
                .map_err(|error| error.to_string())?;
            let Some(view) = views
                .iter()
                .rev()
                .find(|view| view.terminal_id.as_deref() == Some(terminal_id))
            else {
                return Ok(None);
            };
            self.hydrate(view.clone()).await;
            managed_descriptor_from_view(view, create_request_id).map(Some)
        })
    }

    fn launch<'a>(
        &'a self,
        request: ManagedTerminalLaunch,
    ) -> ManagedTerminalFuture<'a, Result<ManagedTerminalDescriptor, String>> {
        Box::pin(async move {
            let create_key = request
                .create_request_id
                .as_deref()
                .unwrap_or(&request.terminal_id);
            let soul_id = stable_soul_id(create_key)?;
            let cwd = canonical_cwd(request.spec.cwd.as_deref())?;
            let workspace = workspace_root(&cwd);
            let (run_as_uid, run_as_gid) = (MANAGED_PROVIDER_UID, MANAGED_PROVIDER_GID);
            let git_common_dir = git_common_dir(&workspace);
            let project_key = stable_project_key(&workspace);
            let inventory = self.client.inventory().await.map_err(|e| e.to_string())?;
            if let Some(descriptor) = reused_running_descriptor(
                &inventory,
                &soul_id,
                &request.terminal_id,
                request.create_request_id.clone(),
            )? {
                return Ok(descriptor);
            }
            // Phase 2 persists the launch spec in the supervisor registry.
            // Persist ONLY an explicit non-secret allowlist — never the web
            // server's resolved child environment wholesale (which can carry
            // AUTH_TOKEN, provider API keys, cloud credentials, proxy creds, ...).
            let env = managed_provider_env(&request.mode, &request.env);
            let mut provider_secret_references = {
                crate::managed_provider_bootstrap::named_provider_onecli_references(&request.mode)?
            };
            let selected_claude_settings = (request.mode == "claude")
                .then(|| {
                    freshell_platform::claude_inputs::selected_settings_argument(&request.spec.args)
                        .map(|value| {
                            if value.len()
                                > freshell_platform::claude_inputs::MAX_NATIVE_SETTINGS_BYTES
                            {
                                Err("Claude --settings exceeds native 2 MiB limit")
                            } else {
                                Ok(value.to_owned())
                            }
                        })
                })
                .flatten()
                .transpose()?;
            let args = managed_provider_args(&request.mode, request.spec.args)?;
            let request_id = stable_request_id(create_key)?;
            let opencode_input = crate::managed_mcp_capability::OpencodeEphemeralInput {
                cwd: Some(&cwd),
                workspace: Some(&workspace),
                ..Default::default()
            };
            let (mcp_capability, provider_launch_context) = if request.mode == "opencode" {
                let home = original_provider_home(&request.env)?;
                let original = |name: &str| {
                    request
                        .env
                        .get(name)
                        .cloned()
                        .or_else(|| std::env::var(name).ok())
                };
                let prepared = crate::managed_provider_references::prepare_managed_opencode(
                    crate::managed_provider_references::OpencodePreparation {
                        client: &self.client,
                        soul: &soul_id,
                        creation_seed: create_key,
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
                        inline_edits: None,
                    },
                )
                .await?;
                provider_secret_references = prepared.references;
                (
                    prepared.context.mcp_capability.clone(),
                    Some(prepared.context),
                )
            } else if request.mode == "codex" {
                let home = original_provider_home(&request.env)?;
                let original = |name: &str| {
                    request
                        .env
                        .get(name)
                        .cloned()
                        .or_else(|| std::env::var(name).ok())
                };
                let context = crate::managed_provider_references::codex::prepare_managed(
                    crate::managed_provider_references::codex::CodexPreparation {
                        client: &self.client,
                        soul: &soul_id,
                        creation_seed: create_key,
                        home: &home,
                        cwd: &cwd,
                        workspace: &workspace,
                        original: &original,
                        args: &args,
                        references: &provider_secret_references,
                    },
                )
                .await?;
                (context.mcp_capability.clone(), Some(context))
            } else if request.mode == "claude" {
                let home = original_provider_home(&request.env)?;
                let original = |name: &str| {
                    request
                        .env
                        .get(name)
                        .cloned()
                        .or_else(|| std::env::var(name).ok())
                };
                let context = crate::managed_provider_references::claude::prepare_managed(
                    crate::managed_provider_references::claude::ClaudePreparation {
                        native_source_runtime:
                            freshell_platform::claude_inputs::NativeSourceRuntime::Terminal,
                        reservation_provider: "claude",
                        git_common_dir: git_common_dir.as_deref(),
                        selected_settings: selected_claude_settings.as_deref(),
                        client: &self.client,
                        soul: &soul_id,
                        creation_seed: create_key,
                        home: &home,
                        cwd: &cwd,
                        workspace: &workspace,
                        original: &original,
                        args: &args,
                        plugins: &[],
                        references: &provider_secret_references,
                    },
                )
                .await?;
                (context.mcp_capability.clone(), Some(context))
            } else if request.mode == "amplifier" {
                let home = original_provider_home(&request.env)?;
                let context = crate::managed_provider_references::amplifier::prepare_managed(
                    crate::managed_provider_references::amplifier::AmplifierPreparation {
                        client: &self.client,
                        soul: &soul_id,
                        creation_seed: create_key,
                        home: &home,
                        cwd: &cwd,
                        workspace: &workspace,
                        references: &provider_secret_references,
                    },
                )
                .await?;
                (context.mcp_capability.clone(), Some(context))
            } else {
                let mcp_capability = matches!(
                    request.mode.as_str(),
                    "claude" | "codex" | "opencode" | "amplifier"
                )
                .then(|| {
                    crate::managed_mcp_capability::issue_mcp_capability(
                        &soul_id,
                        &request.mode,
                        opencode_input,
                    )
                })
                .transpose()?;
                let provider_launch_context =
                    crate::managed_provider_bootstrap::provider_launch_context_for_managed_at(
                        &request.mode,
                        &workspace,
                        &cwd,
                        mcp_capability.clone(),
                    )?;
                (mcp_capability, provider_launch_context)
            };
            if mcp_capability.is_some() && provider_launch_context.is_none() {
                if let Some(capability) = &mcp_capability {
                    let _ =
                        crate::managed_mcp_capability::revoke_mcp_capability(&capability.grant_id);
                }
                return Err("managed provider preparation unavailable".into());
            }
            let launch = LaunchRequest {
                soul_id: soul_id.clone(),
                provider: request.mode.clone(),
                provider_store_id: soul_id.to_string(),
                creation_seed_ref: create_key.to_string(),
                limits: RuntimeLimits {
                    cpu_milli: 2000,
                    memory_bytes: 4 * 1024 * 1024 * 1024,
                    swap_bytes: 0,
                    pids_max: 512,
                },
                profile: RuntimeProfile::DefaultAgent,
                project_key: project_key.clone(),
                native_session_id: request.resume_session_id.clone(),
                fixture: None,
                fresh_agent: None,
                terminal: Some(TerminalLaunchSpec {
                    terminal_id: request.terminal_id.clone(),
                    stream_id: request.stream_id.clone(),
                    mode: request.mode.clone(),
                    program: request.spec.program,
                    args,
                    env,
                    cwd: cwd.to_string_lossy().into_owned(),
                    run_as_uid,
                    run_as_gid,
                    cols: request.spec.cols,
                    rows: request.spec.rows,
                    project_key: project_key.clone(),
                    workspace_path: workspace.to_string_lossy().into_owned(),
                    git_common_dir: git_common_dir.map(|p| p.to_string_lossy().into_owned()),
                    create_request_id: request.create_request_id.clone(),
                    resume_session_id: request.resume_session_id.clone(),
                    provider_model: request.provider_model.clone(),
                    provider_reasoning_effort: request.provider_reasoning_effort.clone(),
                    provider_sandbox: request.provider_sandbox.clone(),
                    provider_permission_mode: request.provider_permission_mode.clone(),
                    provider_bootstrap_files: Vec::new(),
                    provider_secret_references,
                    provider_launch_context,
                }),
                view_intent: Some(ViewIntentRequest {
                    owner_id: String::new(),
                    workspace_id: project_key.clone(),
                    kind: ViewIntentKind::AutomaticPrimary,
                    preferred_tab_id: request.view_tab_id.clone(),
                    preferred_pane_id: request.view_pane_id.clone(),
                    title: Some(format!("{} agent", provider_label(&request.mode))),
                    placement_group: None,
                    visibility: ViewVisibilityIntent::Visible,
                }),
                expected_control_epoch: None,
            };
            let result = if request.mode == "opencode" {
                let home = original_provider_home(&request.env)?;
                let original = |name: &str| {
                    request
                        .env
                        .get(name)
                        .cloned()
                        .or_else(|| std::env::var(name).ok())
                };
                let references = launch
                    .terminal
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
                        soul: &soul_id,
                        creation_seed: create_key,
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
                        inline_edits: None,
                    },
                    request_id,
                    launch,
                )
                .await?
            } else {
                match self.client.launch(request_id, launch).await {
                    Ok(result) => result,
                    Err(error) => {
                        // Launch may have bound/dispatched this generation
                        // before its reply was lost or completion failed. The
                        // existing ownership journal must survive reconciliation.
                        tracing::warn!(event="provider.inputs.initial_launch.unconfirmed",
                            provider=%request.mode,soul_id=%soul_id,
                            grant_id=mcp_capability.as_ref().map(|c|c.grant_id.as_str()),
                            stage="controller",operation="launch",%error,
                            "Retain provider inputs until dispatch outcome is confirmed");
                        return Err(error.to_string());
                    }
                }
            };
            self.hydrate(result.view.clone()).await;
            Ok(ManagedTerminalDescriptor {
                soul_id: result.view.soul_id.to_string(),
                incarnation_id: result.view.incarnation_id.to_string(),
                terminal_id: request.terminal_id,
                stream_id: request.stream_id,
                mode: request.mode,
                cwd: cwd.to_string_lossy().into_owned(),
                resume_session_id: request.resume_session_id,
                create_request_id: request.create_request_id,
            })
        })
    }

    fn input<'a>(
        &'a self,
        terminal: ManagedTerminalDescriptor,
        data: String,
    ) -> ManagedTerminalFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let soul_key = terminal.soul_id;
            let soul = SoulId::parse(&soul_key).map_err(|e| e.to_string())?;
            if self
                .recovery
                .slots
                .lock()
                .await
                .get(&soul_key)
                .is_some_and(|slot| {
                    lifecycle(&slot.publication).state != ManagedLifecycleState::Running
                })
            {
                return Err(
                    "managed runtime is not running; input was not dispatched; use explicit retry"
                        .into(),
                );
            }
            self.client
                .input(RequestId::new(), soul, data)
                .await
                .map_err(|e| e.to_string())?;
            Ok(())
        })
    }

    fn resize<'a>(
        &'a self,
        terminal: ManagedTerminalDescriptor,
        cols: u16,
        rows: u16,
    ) -> ManagedTerminalFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let soul = SoulId::parse(terminal.soul_id).map_err(|e| e.to_string())?;
            self.client
                .resize(soul, cols, rows)
                .await
                .map_err(|e| e.to_string())
        })
    }

    fn stop<'a>(
        &'a self,
        terminal: ManagedTerminalDescriptor,
    ) -> ManagedTerminalFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let soul_key = terminal.soul_id;
            let soul = SoulId::parse(&soul_key).map_err(|e| e.to_string())?;
            match self
                .client
                .stop(soul.clone())
                .await
                .map_err(|e| e.to_string())?
            {
                StopOutcome::VerifiedEmpty => {
                    crate::managed_mcp_capability::revoke_soul_capabilities(&soul)?;
                    let views = self
                        .client
                        .inventory()
                        .await
                        .map_err(|error| error.to_string())?;
                    if let Some(view) = views
                        .into_iter()
                        .rev()
                        .find(|view| view.soul_id.as_str() == soul_key)
                    {
                        self.hydrate(view).await;
                    }
                    Ok(())
                }
                other => Err(format!(
                    "managed runtime stop not verified empty: {other:?}"
                )),
            }
        })
    }

    fn read_output<'a>(
        &'a self,
        terminal: ManagedTerminalDescriptor,
        after_seq: i64,
        max_bytes: u64,
    ) -> ManagedTerminalFuture<'a, Result<ManagedOutputRead, String>> {
        Box::pin(async move {
            let soul_key = terminal.soul_id.clone();
            let soul = SoulId::parse(&soul_key).map_err(|e| e.to_string())?;
            let output = match self
                .client
                .read_output_for_epoch(
                    soul.clone(),
                    after_seq.max(0) as u64,
                    max_bytes,
                    Some(terminal.stream_id.clone()),
                )
                .await
            {
                Ok(output) => output,
                Err(error) if recoverable_host_error(&error) => {
                    self.schedule_recovery(soul, RecoveryTrigger::HostUnreachable, None)
                        .await;
                    return Err("managed retained output unavailable".into());
                }
                Err(error) => return Err(error.to_string()),
            };
            managed_output_validation::validate(&output, &terminal.terminal_id)?;
            let mut observation = self
                .recovery
                .slots
                .lock()
                .await
                .get(&soul_key)
                .map(|slot| lifecycle(&slot.publication));
            // Keep the actual EOF/epoch before scheduling recovery. Neither a
            // recovery verdict nor a later flag may change this sampled head.
            let completion = output.exited.then(|| ManagedOutputCompletion {
                stream_epoch: output.stream_epoch.clone(),
                incarnation_id: output.incarnation_id.to_string(),
                head_seq: output.head_seq as i64,
                exit_code: output.exit_code,
            });
            {
                let mut slots = self.recovery.slots.lock().await;
                if let Some(slot) = slots.get_mut(&soul_key) {
                    slot.observed_epoch = Some(output.stream_epoch.clone());
                    slot.observed_exit_code = output.exit_code;
                    slot.observed_completion = completion.clone();
                }
            }
            if output.exited
                && observation
                    .as_ref()
                    .is_none_or(|l| l.state == ManagedLifecycleState::Running)
            {
                self.schedule_recovery(
                    soul.clone(),
                    RecoveryTrigger::ProviderExit,
                    Some(RecoveryObservation {
                        terminal_id: terminal.terminal_id.clone(),
                        incarnation_id: output.incarnation_id.to_string(),
                        epoch: output.stream_epoch.clone(),
                        exit_code: output.exit_code,
                        completion: completion.clone(),
                    }),
                )
                .await;
                observation = self
                    .recovery
                    .slots
                    .lock()
                    .await
                    .get(&soul_key)
                    .map(|slot| lifecycle(&slot.publication));
            }
            let observation = observation.unwrap_or(ManagedLifecycle {
                state: ManagedLifecycleState::Running,
                recovery_summary: None,
            });
            let ended = observation.state == ManagedLifecycleState::Ended;
            Ok(ManagedOutputRead {
                lifecycle: Some(observation),
                completion: ended.then_some(completion).flatten(),
                stream_epoch: Some(output.stream_epoch.clone()),
                incarnation_id: Some(output.incarnation_id.to_string()),
                // Replacement starts a new durable output epoch. Force the
                // consumer to reset its cursor instead of interpreting the new
                // incarnation as a gap in the old stream.
                reset_required: output.reset_required || output.stream_epoch != terminal.stream_id,
                truncated: output.truncated,
                retained_from_seq: output.retained_from_seq.min(i64::MAX as u64) as i64,
                head_seq: output.head_seq.min(i64::MAX as u64) as i64,
                exit_code: if ended && output.exited {
                    output.exit_code
                } else {
                    None
                },
                native_session_id: output.native_session_id,
                chunks: output
                    .frames
                    .into_iter()
                    .map(|frame| ManagedOutputChunk {
                        seq_start: frame.seq_start.min(i64::MAX as u64) as i64,
                        seq_end: frame.seq_end.min(i64::MAX as u64) as i64,
                        data: frame.data,
                    })
                    .collect(),
            })
        })
    }
}

fn managed_recovery_test_delay() -> Option<std::time::Duration> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var("FRESHELL_MANAGED_RECOVERY_TEST_DELAY_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|delay| *delay > 0 && *delay <= 10_000)
        .map(std::time::Duration::from_millis)
}

fn recoverable_host_error(error: &ClientError) -> bool {
    matches!(
        error.runtime_code(),
        Some(
            RuntimeErrorCode::HostUnreachable
                | RuntimeErrorCode::HostAuthenticationFailed
                | RuntimeErrorCode::BackendUnavailable
        )
    )
}

const AUTOMATIC_RECOVERY_RETRY_DELAYS: [std::time::Duration; 2] = [
    std::time::Duration::from_secs(2),
    std::time::Duration::from_secs(10),
];

async fn recover_with_policy(
    client: &RuntimeClient,
    soul: SoulId,
    trigger: RecoveryTrigger,
) -> Result<RecoveryResult, ClientError> {
    let mut last_result = None;
    let mut last_error = None;
    for attempt in 0..=AUTOMATIC_RECOVERY_RETRY_DELAYS.len() {
        if attempt > 0 {
            tokio::time::sleep(AUTOMATIC_RECOVERY_RETRY_DELAYS[attempt - 1]).await;
        }
        match client.recover(soul.clone(), trigger).await {
            Ok(result) => {
                if !automatic_retryable(&result) {
                    return Ok(result);
                }
                last_result = Some(result);
            }
            Err(error) => last_error = Some(error),
        }
    }
    if last_result.is_some() {
        return client.recover(soul, RecoveryTrigger::RetryExhausted).await;
    }
    Err(last_error.unwrap_or(ClientError::UnexpectedResult))
}

fn automatic_retryable(result: &RecoveryResult) -> bool {
    if result.outcome != RecoveryOutcome::Blocked {
        return false;
    }
    matches!(
        result.probe.as_ref(),
        Some(RecoveryProbe::Blocked {
            reason: RecoveryBlockReason::RateLimited
                | RecoveryBlockReason::CapabilityPending
                | RecoveryBlockReason::ProviderUnavailable
                | RecoveryBlockReason::StoreUnreadable
                | RecoveryBlockReason::WorkspaceUnavailable
                | RecoveryBlockReason::InsufficientResources
                | RecoveryBlockReason::OldRuntimeNotEmpty,
            ..
        })
    )
}

fn managed_descriptor_from_view(
    view: &RuntimeView,
    reconcile_create_request_id: Option<String>,
) -> Result<ManagedTerminalDescriptor, String> {
    let terminal_id = view
        .terminal_id
        .clone()
        .ok_or_else(|| "managed runtime view has no terminal id".to_string())?;
    let stream_id = view
        .terminal_stream_id
        .clone()
        .ok_or_else(|| format!("managed terminal {terminal_id} has no durable stream id"))?;
    let mode = view
        .terminal_mode
        .clone()
        .or_else(|| view.provider.clone())
        .ok_or_else(|| format!("managed terminal {terminal_id} has no durable mode"))?;
    let cwd = view
        .terminal_cwd
        .clone()
        .ok_or_else(|| format!("managed terminal {terminal_id} has no durable cwd"))?;
    Ok(ManagedTerminalDescriptor {
        soul_id: view.soul_id.to_string(),
        incarnation_id: view.incarnation_id.to_string(),
        terminal_id,
        stream_id,
        mode,
        cwd,
        resume_session_id: view
            .native_session_id
            .clone()
            .or_else(|| view.terminal_resume_session_id.clone()),
        create_request_id: reconcile_create_request_id
            .or_else(|| view.terminal_create_request_id.clone()),
    })
}

fn reusable_running_view(
    views: &[RuntimeView],
    soul_id: &SoulId,
    terminal_id: &str,
) -> Result<Option<RuntimeView>, String> {
    let matching: Vec<&RuntimeView> = views
        .iter()
        .filter(|view| &view.soul_id == soul_id)
        .collect();
    if matching.is_empty() {
        return Ok(None);
    }
    let running: Vec<&RuntimeView> = matching
        .iter()
        .copied()
        .filter(|view| view.launch_state == LaunchState::Running)
        .collect();
    if running.len() != 1 {
        return Err(format!(
            "managed soul {} exists but has {} running incarnations; refusing a replacement launch",
            soul_id.as_str(),
            running.len()
        ));
    }
    let view = running[0];
    if view.terminal_id.as_deref() != Some(terminal_id) {
        return Err(format!(
            "managed soul {} is already bound to terminal {:?}, not {terminal_id}",
            soul_id.as_str(),
            view.terminal_id
        ));
    }
    Ok(Some(view.clone()))
}

/// Reconstruct a retry result exclusively from the already-committed runtime
/// view. A web crash after launch but before acknowledgment can retry with a
/// newly assembled request whose stream/native identity is stale or absent;
/// only the durable view identifies the one existing writer.
fn reused_running_descriptor(
    views: &[RuntimeView],
    soul_id: &SoulId,
    terminal_id: &str,
    reconcile_create_request_id: Option<String>,
) -> Result<Option<ManagedTerminalDescriptor>, String> {
    reusable_running_view(views, soul_id, terminal_id)?
        .as_ref()
        .map(|view| managed_descriptor_from_view(view, reconcile_create_request_id))
        .transpose()
}

fn managed_env_allowlist(
    source: &std::collections::BTreeMap<String, String>,
) -> std::collections::BTreeMap<String, String> {
    const ALLOWED: &[&str] = &[
        "PATH",
        "SHELL",
        "TERM",
        "COLORTERM",
        "LANG",
        "LC_ALL",
        "TMPDIR",
        "FRESHELL",
        "FRESHELL_TERMINAL_ID",
        "FRESHELL_TAB_ID",
        "FRESHELL_PANE_ID",
        "PROMPT_TOOLKIT_NO_CPR",
    ];
    source
        .iter()
        .filter(|(key, _)| ALLOWED.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

fn original_provider_home(
    request: &std::collections::BTreeMap<String, String>,
) -> Result<PathBuf, &'static str> {
    request
        .get("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .ok_or("managed provider HOME unavailable")
}

fn managed_provider_env(
    mode: &str,
    source: &std::collections::BTreeMap<String, String>,
) -> std::collections::BTreeMap<String, String> {
    let mut env = managed_env_allowlist(source);
    // Never persist the web host's PATH into a pinned workload image. It may
    // contain host-only homes, version-manager shims, or credential helpers.
    let runtime_path = if mode == "amplifier" {
        // The pinned image installs Amplifier's native module installer here.
        "/opt/uv/bin:/usr/local/bin:/usr/bin:/bin"
    } else {
        "/usr/local/bin:/usr/bin:/bin"
    };
    env.insert("PATH".into(), runtime_path.into());
    if mode == "amplifier" {
        // Native module activation may install package dependencies. Its
        // interpreter stays in the pinned image; new packages belong to this
        // soul's writable HOME and are visible to that same interpreter.
        env.insert(
            "UV_CONFIG_FILE".into(),
            "/home/freshell/provider/.freshell/amplifier/uv.toml".into(),
        );
        env.insert(
            "PYTHONPATH".into(),
            "/home/freshell/provider/.freshell/amplifier/python-packages".into(),
        );
    }
    // Provider state belongs to this soul's Docker volume, not the web
    // server's inherited HOME. These paths are inside the workload.
    env.insert("HOME".into(), "/home/freshell/provider".into());
    env.insert(
        "CLAUDE_HOME".into(),
        "/home/freshell/provider/.claude".into(),
    );
    env.insert(
        "CLAUDE_CONFIG_DIR".into(),
        "/home/freshell/provider/.claude".into(),
    );
    env.insert("CODEX_HOME".into(), "/home/freshell/provider/.codex".into());
    env.insert(
        "XDG_DATA_HOME".into(),
        "/home/freshell/provider/.local/share".into(),
    );
    env.insert(
        "XDG_CONFIG_HOME".into(),
        "/home/freshell/provider/.config".into(),
    );
    env.insert(
        "AMPLIFIER_HOME".into(),
        "/home/freshell/provider/.amplifier".into(),
    );
    env.insert(
        "FRESHELL_AMPLIFIER_HOME".into(),
        "/home/freshell/provider/.amplifier".into(),
    );
    if mode == "opencode" {
        env.insert("TMPDIR".into(), "/run/opencode-tmp".into());
        if let Some(value) = source
            .get("FRESHELL_OPENCODE_REBIND")
            .filter(|value| matches!(value.as_str(), "0" | "false"))
        {
            env.insert("FRESHELL_OPENCODE_REBIND".into(), value.clone());
        }
        // Arbitrary inline JSON can carry credentials in values such as MCP
        // command arguments. It is staged beside the private incarnation grant,
        // never serialized into the supervisor's durable launch environment.
        if let Some(permission) = source
            .get("FRESHELL_MANAGED_OPENCODE_BASH_PERMISSION")
            .map(String::as_str)
            .filter(|value| matches!(*value, "ask" | "allow" | "deny"))
        {
            env.insert(
                "FRESHELL_MANAGED_OPENCODE_BASH_PERMISSION".into(),
                permission.into(),
            );
        }
    }
    env
}

fn managed_provider_args(mode: &str, args: Vec<String>) -> Result<Vec<String>, String> {
    let settings = (mode == "claude").then(|| {
        freshell_platform::cli_launch::claude_settings_json(
            freshell_platform::cli_launch::ProviderTarget::Unix,
        )
    });
    freshell_runtime_protocol::durable_managed_terminal_args(mode, args, settings.as_deref())
        .map_err(|error| error.message)
}

fn provider_label(provider: &str) -> &str {
    match provider {
        "claude" => "Claude",
        "codex" => "Codex",
        "opencode" => "OpenCode",
        "amplifier" => "Amplifier",
        "shell" => "Shell",
        other => other,
    }
}

fn stable_soul_id(key: &str) -> Result<SoulId, String> {
    SoulId::parse(format!("soul-terminal-{}", stable_hex(key))).map_err(|e| e.to_string())
}
fn stable_request_id(key: &str) -> Result<RequestId, String> {
    RequestId::parse(format!("request-terminal-{}", stable_hex(key))).map_err(|e| e.to_string())
}
fn stable_project_key(path: &Path) -> String {
    format!("project-{}", stable_hex(&path.to_string_lossy()))
}
fn stable_hex(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))[..32].to_string()
}

const MANAGED_PROVIDER_UID: u32 = 65_534;
const MANAGED_PROVIDER_GID: u32 = 0;

fn canonical_cwd(cwd: Option<&str>) -> Result<PathBuf, String> {
    let path = cwd
        .map(PathBuf::from)
        .unwrap_or(std::env::current_dir().map_err(|e| e.to_string())?);
    let path =
        std::fs::canonicalize(&path).map_err(|e| format!("managed cwd {}: {e}", path.display()))?;
    if !path.is_dir() {
        return Err(format!(
            "managed cwd is not a directory: {}",
            path.display()
        ));
    }
    Ok(path)
}

fn workspace_root(cwd: &Path) -> PathBuf {
    git_stdout(cwd, &["rev-parse", "--show-toplevel"])
        .and_then(|raw| std::fs::canonicalize(raw.trim()).ok())
        .filter(|p| p.is_dir())
        .unwrap_or_else(|| cwd.to_path_buf())
}

fn git_common_dir(workspace: &Path) -> Option<PathBuf> {
    let raw = git_stdout(workspace, &["rev-parse", "--git-common-dir"])?;
    let raw = PathBuf::from(raw.trim());
    let candidate = if raw.is_absolute() {
        raw
    } else {
        workspace.join(raw)
    };
    std::fs::canonicalize(candidate).ok().filter(|p| p.is_dir())
}

fn git_stdout(cwd: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
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
mod tests {
    use super::*;
    #[cfg(unix)]
    mod lifecycle_directory {
        include!("tests/managed_runtime_lifecycle_tests.rs");
    }
    pub(super) mod transitions {
        include!("tests/managed_recovery_transition_tests.rs");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn shell_terminal_ended_facade_retains_output() {
        use freshell_runtime_protocol::*;
        let root = tempfile::tempdir().unwrap();
        let socket = root.path().join("retained.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let soul = SoulId::new();
        let incarnation = IncarnationId::new();
        let view: RuntimeView = serde_json::from_value(serde_json::json!({
            "soulId":soul,"incarnationId":incarnation,"launchState":"stopped",
            "cleanupState":"verified_empty","intentRevision":1,"executionGeneration":1,
            "terminalId":"ended-shell","terminalStreamId":"actual-host-epoch",
            "terminalMode":"shell","terminalCwd":"/workspace",
            "desiredState":"running","recoveryState":"lost",
            "recoveryReason":"non_resumable_terminal_ended",
            "nativeSessionId":"identity-retained"
        }))
        .unwrap();
        let (shutdown, mut stop) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            loop {
                let mut peer = tokio::select! {
                    _ = &mut stop => break,
                    accepted = listener.accept() => accepted.unwrap().0,
                };
                let request: Envelope<AdminCommand> = read_frame(&mut peer).await.unwrap();
                let result = match request.body {
                    AdminCommand::Health => AdminResult::Health {
                        control_epoch: 1,
                        installation_id: InstallationId::new(),
                    },
                    AdminCommand::Inventory => AdminResult::Inventory(vec![view.clone()]),
                    AdminCommand::TerminalReadOutput(_) => {
                        AdminResult::TerminalOutput(RuntimeOutputBatch {
                            incarnation_id: incarnation.clone(),
                            terminal_id: "ended-shell".into(),
                            stream_epoch: "actual-host-epoch".into(),
                            retained_from_seq: 1,
                            head_seq: 1,
                            reset_required: false,
                            truncated: false,
                            exited: true,
                            completion: None,
                            exit_code: Some(17),
                            native_session_id: Some("identity-retained".into()),
                            frames: vec![RuntimeOutputFrame {
                                terminal_id: "ended-shell".into(),
                                stream_epoch: "actual-host-epoch".into(),
                                seq_start: 1,
                                seq_end: 1,
                                data: "final shell diagnostic".into(),
                            }],
                        })
                    }
                    other => panic!("read-only reconnect must not recover or launch: {other:?}"),
                };
                write_frame(
                    &mut peer,
                    &AdminReply {
                        request_id: request.request_id,
                        result: Ok(result),
                    },
                )
                .await
                .unwrap();
            }
        });
        let controller = ServerManagedRuntimeController {
            client: RuntimeClient::new(&socket, "synthetic-retained"),
            recovery: Arc::new(ManagedRecoveryState::default()),
        };
        let descriptor = controller
            .lookup_terminal("ended-shell", None)
            .await
            .unwrap();
        let read = if let Some(descriptor) = &descriptor {
            Some(controller.read_output(descriptor.clone(), 0, 65536).await)
        } else {
            None
        };
        shutdown.send(()).unwrap();
        task.await.unwrap();
        let descriptor =
            descriptor.expect("verified ended shell keeps its exact facade on cold reconnect");
        assert_eq!(
            descriptor.resume_session_id.as_deref(),
            Some("identity-retained")
        );
        let read = read.unwrap().expect("ended shell output remains readable");
        assert_eq!(read.chunks[0].data, "final shell diagnostic");
        assert_eq!(read.exit_code, Some(17));
    }
    #[cfg(unix)]
    mod recovery_budget {
        include!("tests/managed_recovery_budget_tests.rs");
    }

    #[test]
    fn managed_env_drops_server_and_provider_secrets() {
        let source = [
            ("PATH", "/usr/local/bin:/usr/bin"),
            ("TERM", "xterm-256color"),
            ("FRESHELL_TERMINAL_ID", "t1"),
            ("FRESHELL_TOKEN", "web-secret"),
            ("AUTH_TOKEN", "web-secret-2"),
            ("ANTHROPIC_API_KEY", "provider-secret"),
            ("CLAUDE_CODE_OAUTH_TOKEN", "provider-oauth"),
            ("AWS_SECRET_ACCESS_KEY", "cloud-secret"),
        ]
        .into_iter()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect();
        let filtered = managed_env_allowlist(&source);
        assert_eq!(
            filtered.get("PATH").map(String::as_str),
            Some("/usr/local/bin:/usr/bin")
        );
        assert_eq!(
            filtered.get("FRESHELL_TERMINAL_ID").map(String::as_str),
            Some("t1")
        );
        for key in [
            "FRESHELL_TOKEN",
            "AUTH_TOKEN",
            "ANTHROPIC_API_KEY",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "AWS_SECRET_ACCESS_KEY",
        ] {
            assert!(!filtered.contains_key(key), "secret key leaked: {key}");
        }
    }

    #[test]
    fn running_soul_is_reused_before_launch_payload_rehash_and_mismatches_fail_closed() {
        let soul = SoulId::parse("soul-terminal-test").unwrap();
        let running = freshell_runtime_protocol::RuntimeView {
            soul_id: soul.clone(),
            incarnation_id: freshell_runtime_protocol::IncarnationId::new(),
            launch_state: freshell_runtime_protocol::LaunchState::Running,
            cleanup_state: freshell_runtime_protocol::CleanupState::None,
            intent_revision: 1,
            container_id: Some("a".repeat(64)),
            host_boot_id: Some(freshell_runtime_protocol::HostBootId::new()),
            execution_generation: 1,
            effective_limits: None,
            configured_limits: None,
            view_intent_revision: None,
            terminal_id: Some("terminal-stable".into()),
            terminal_stream_id: Some("stream-stable".into()),
            terminal_mode: Some("opencode".into()),
            terminal_cwd: Some("/workspace".into()),
            terminal_create_request_id: Some("create-stable".into()),
            terminal_resume_session_id: Some("request-time-session".into()),
            fresh_agent_session_id: None,
            fresh_agent_create_request_id: None,
            fresh_agent_session_type: None,
            fresh_agent_runtime_variant: None,
            project_key: Some("project-test".into()),
            profile: Some(RuntimeProfile::DefaultAgent),
            desired_state: freshell_runtime_protocol::DesiredState::Running,
            recovery_state: freshell_runtime_protocol::RecoveryState::Live,
            durability_state: freshell_runtime_protocol::DurabilityState::Unknown,
            allocation_state: freshell_runtime_protocol::AllocationState::Allocated,
            provider: Some("opencode".into()),
            native_session_id: Some("provider-materialized-session".into()),
            recovery_reason: None,
            incident_id: None,
            prior_incarnation_id: None,
            recovery_attempt_id: None,
            evidence_revision: 0,
            successful_recoveries_in_window: 0,
        };
        let descriptor = managed_descriptor_from_view(&running, Some("reconcile-create".into()))
            .expect("durable managed descriptor");
        assert_eq!(descriptor.terminal_id, "terminal-stable");
        assert_eq!(descriptor.stream_id, "stream-stable");
        assert_eq!(
            descriptor.create_request_id.as_deref(),
            Some("reconcile-create")
        );
        let reused =
            reusable_running_view(std::slice::from_ref(&running), &soul, "terminal-stable")
                .unwrap()
                .expect("running soul should be reused");
        assert_eq!(reused.incarnation_id, running.incarnation_id);

        let descriptor = reused_running_descriptor(
            std::slice::from_ref(&running),
            &soul,
            "terminal-stable",
            Some("retry-after-web-crash".into()),
        )
        .unwrap()
        .expect("launch-before-ack retry reuses the existing writer");
        assert_eq!(
            descriptor.incarnation_id,
            running.incarnation_id.to_string()
        );
        assert_eq!(descriptor.stream_id, "stream-stable");
        assert_eq!(
            descriptor.resume_session_id.as_deref(),
            Some("provider-materialized-session")
        );
        assert_eq!(
            descriptor.create_request_id.as_deref(),
            Some("retry-after-web-crash")
        );

        assert!(
            reusable_running_view(std::slice::from_ref(&running), &soul, "terminal-other").is_err()
        );
        let mut stopped = running;
        stopped.launch_state = freshell_runtime_protocol::LaunchState::Stopped;
        assert!(reusable_running_view(&[stopped], &soul, "terminal-stable").is_err());
    }

    #[test]
    fn managed_opencode_env_uses_soul_state_and_drops_host_config_paths() {
        let source = [
            ("PATH", "/usr/local/bin:/usr/bin"),
            ("OPENCODE_CONFIG_CONTENT", r#"{"secret":"do-not-persist"}"#),
            (
                "OPENCODE_TUI_CONFIG",
                "/home/user/.freshell/opencode/tui.json",
            ),
            ("OPENCODE_API_KEY", "provider-secret"),
        ]
        .into_iter()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect();
        let env = managed_provider_env("opencode", &source);
        assert_eq!(
            env.get("HOME").map(String::as_str),
            Some("/home/freshell/provider")
        );
        assert_eq!(
            env.get("XDG_DATA_HOME").map(String::as_str),
            Some("/home/freshell/provider/.local/share")
        );
        assert_eq!(
            env.get("XDG_CONFIG_HOME").map(String::as_str),
            Some("/home/freshell/provider/.config")
        );
        assert!(!env.contains_key("OPENCODE_CONFIG_CONTENT"));
        assert_eq!(
            env.get("TMPDIR").map(String::as_str),
            Some("/run/opencode-tmp")
        );
        assert!(!env.contains_key("OPENCODE_TUI_CONFIG"));
        assert!(!env.contains_key("OPENCODE_API_KEY"));
        assert!(!env.values().any(|value| value.contains("do-not-persist")));
    }

    #[test]
    fn managed_opencode_inline_plugin_configuration_is_child_only() {
        let source = std::collections::BTreeMap::from([
            (
                "OPENCODE_CONFIG_CONTENT".into(),
                r#"{"plugin":["file:///workspace/plugin.ts"],"snapshot":true,"maxTokens":8192}"#
                    .into(),
            ),
            ("FRESHELL_OPENCODE_REBIND".into(), "0".into()),
        ]);
        let env = managed_provider_env("opencode", &source);
        assert!(!env.contains_key("OPENCODE_CONFIG_CONTENT"));
        assert_eq!(
            env.get("FRESHELL_OPENCODE_REBIND").map(String::as_str),
            Some("0")
        );
    }

    #[test]
    fn managed_opencode_does_not_filter_inline_json_by_field_name() {
        let source = std::collections::BTreeMap::from([(
            "OPENCODE_CONFIG_CONTENT".into(),
            r#"{"plugin":["file:///workspace/plugin.ts"],"provider":{"apiKey":"raw-secret","model":"ordinary-model"}}"#.into(),
        )]);
        let env = managed_provider_env("opencode", &source);
        assert!(!env.contains_key("OPENCODE_CONFIG_CONTENT"));
        assert!(!env.values().any(|value| value.contains("raw-secret")));
    }

    #[test]
    fn managed_opencode_never_persists_nested_inline_secret_values() {
        let source = std::collections::BTreeMap::from([(
            "OPENCODE_CONFIG_CONTENT".into(),
            r#"{"mcp":{"vendor":{"type":"local","command":["tool","--token","nested-secret-byte"]}},"provider":{"endpoint":"https://nested-secret-byte.example"}}"#.into(),
        )]);
        let env = managed_provider_env("opencode", &source);
        let serialized = serde_json::to_string(&env).unwrap();
        assert!(!serialized.contains("nested-secret-byte"));
        assert!(!env.contains_key("OPENCODE_CONFIG_CONTENT"));
    }

    #[test]
    fn managed_opencode_permission_policy_is_sanitized_and_persistable() {
        for allowed in ["ask", "allow", "deny"] {
            let source = std::collections::BTreeMap::from([(
                "FRESHELL_MANAGED_OPENCODE_BASH_PERMISSION".to_string(),
                allowed.to_string(),
            )]);
            let env = managed_provider_env("opencode", &source);
            assert_eq!(
                env.get("FRESHELL_MANAGED_OPENCODE_BASH_PERMISSION")
                    .map(String::as_str),
                Some(allowed)
            );
        }

        let source = std::collections::BTreeMap::from([(
            "FRESHELL_MANAGED_OPENCODE_BASH_PERMISSION".to_string(),
            "ask-with-secret-text".to_string(),
        )]);
        let env = managed_provider_env("opencode", &source);
        assert!(!env.contains_key("OPENCODE_CONFIG_CONTENT"));
        assert!(!env.values().any(|value| value.contains("secret-text")));
    }

    #[test]
    fn managed_opencode_bash_policy_preserves_other_ordinary_permissions() {
        let source = std::collections::BTreeMap::from([
            (
                "OPENCODE_CONFIG_CONTENT".into(),
                r#"{"permission":{"read":"allow"}}"#.into(),
            ),
            (
                "FRESHELL_MANAGED_OPENCODE_BASH_PERMISSION".into(),
                "ask".into(),
            ),
        ]);
        let env = managed_provider_env("opencode", &source);
        assert!(!env.contains_key("OPENCODE_CONFIG_CONTENT"));
        assert_eq!(
            env.get("FRESHELL_MANAGED_OPENCODE_BASH_PERMISSION")
                .map(String::as_str),
            Some("ask")
        );
    }

    #[test]
    fn managed_claude_strips_web_bound_mcp_tempfile_only() {
        let args = vec![
            "--settings".into(),
            freshell_platform::cli_launch::claude_settings_json(
                freshell_platform::cli_launch::ProviderTarget::Unix,
            ),
            "--mcp-config".into(),
            "/tmp/freshell-mcp/t1.json".into(),
            "--session-id".into(),
            "s1".into(),
        ];
        assert_eq!(
            managed_provider_args("claude", args).unwrap(),
            vec![
                "--settings".to_string(),
                freshell_platform::cli_launch::claude_settings_json(
                    freshell_platform::cli_launch::ProviderTarget::Unix,
                ),
                "--session-id".to_string(),
                "s1".to_string(),
            ]
        );
    }

    #[test]
    fn managed_terminal_argument_path_rejects_credential_flags_before_persistence() {
        for mode in ["claude", "codex", "opencode", "amplifier"] {
            for arguments in [
                vec!["--api-key", "fixture-secret-bytes"],
                vec!["--api-key=fixture-secret-bytes"],
            ] {
                assert!(
                    managed_provider_args(
                        mode,
                        arguments.into_iter().map(str::to_string).collect()
                    )
                    .is_err(),
                    "{mode}"
                );
            }
        }
    }
}

#[cfg(all(test, unix))]
#[path = "managed_output_rpc_tests.rs"]
mod managed_output_rpc_tests;

#[cfg(all(test, unix))]
#[path = "managed_runtime_opencode_replan_tests.rs"]
mod opencode_replan_tests;

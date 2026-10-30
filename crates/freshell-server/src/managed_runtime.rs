#![cfg(feature = "managed-runtime-v1")]

use freshell_runtime_client::{ClientError, RuntimeClient};
use freshell_runtime_protocol::{
    CleanupState, DesiredState, IncarnationId, LaunchRequest, LaunchState, OpenCodeTransferChunk,
    OpenCodeTransferDescriptor, OpenCodeTransferFile, OpenCodeTransferResult, RecoveryOutcome,
    RecoveryProbe, RecoveryResult, RecoveryState, RecoveryTrigger, RequestId, RuntimeErrorCode,
    RuntimeLimits, RuntimeProfile, RuntimeView, SoulId, StopOutcome, TerminalLaunchSpec,
    MAX_OPENCODE_TRANSFER_CHUNK_BYTES, OPENCODE_TRANSFER_DESTINATION_DB,
};
use freshell_terminal::registry::{
    ManagedLifecycle, ManagedLifecycleState, ManagedOutputChunk, ManagedOutputCompletion,
    ManagedOutputRead, ManagedTerminalController, ManagedTerminalDescriptor, ManagedTerminalFuture,
    ManagedTerminalInputError, ManagedTerminalLaunch,
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};
use tokio::sync::Mutex;
use tokio::{
    fs::File as TokioFile,
    io::{AsyncReadExt, AsyncSeekExt},
};
use uuid::Uuid;

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
    // While recovering, this is the task token. Otherwise it is the last
    // local publication or inventory-read token accepted for this soul.
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
    generation_clock: AtomicU64,
}
impl ManagedRecoveryState {
    fn next_generation(&self) -> u64 {
        self.next_generation_after(0)
    }

    fn next_generation_after(&self, minimum: u64) -> u64 {
        loop {
            let current = self.generation_clock.load(Ordering::Relaxed);
            let next = current.max(minimum).saturating_add(1);
            if self
                .generation_clock
                .compare_exchange_weak(current, next, Ordering::Relaxed, Ordering::Relaxed)
                .is_ok()
            {
                return next;
            }
        }
    }
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

    #[cfg(test)]
    async fn hydrate(&self, view: RuntimeView) {
        let generation = self.recovery.next_generation();
        self.hydrate_at_generation(view, generation).await;
    }

    async fn blocked_recovery(&self, soul_id: &str) -> Result<Option<String>, String> {
        let needs_refresh = self
            .recovery
            .slots
            .lock()
            .await
            .get(soul_id)
            .is_some_and(|slot| {
                !slot.task_in_flight
                    && lifecycle(&slot.publication).state != ManagedLifecycleState::Running
            });
        if !needs_refresh {
            return Ok(None);
        }
        let inventory_generation = self.recovery.next_generation();
        let views = self
            .client
            .inventory()
            .await
            .map_err(|error| error.to_string())?;
        let current = views
            .into_iter()
            .rev()
            .find(|view| view.soul_id.as_str() == soul_id)
            .ok_or_else(|| "managed soul is no longer in supervisor inventory".to_string())?;
        self.hydrate_at_generation(current.clone(), inventory_generation)
            .await;
        Ok(matches!(
            current.recovery_state,
            RecoveryState::Blocked
                | RecoveryState::Lost
                | RecoveryState::Stopped
                | RecoveryState::DataRepairComplete
        )
        .then(|| {
            current
                .recovery_reason
                .clone()
                .unwrap_or_else(|| "managed soul recovery is blocked".into())
        }))
    }

    async fn hydrate_at_generation(&self, view: RuntimeView, generation: u64) {
        let mut slots = self.recovery.slots.lock().await;
        if slots.get(view.soul_id.as_str()).is_some_and(|slot| {
            slot.task_in_flight
                || slot.sequence > generation
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
                RecoveryState::Stopped | RecoveryState::DataRepairComplete => {
                    RecoveryOutcome::Stopped
                }
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
            slot.sequence = generation;
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
                    sequence: generation,
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
            let sequence = self.recovery.next_generation_after(slot.sequence);
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
            let sequence = self.recovery.next_generation();
            let mut slot = SoulRecoverySlot {
                sequence,
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
            Some(sequence)
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
        let published_generation = self.recovery.next_generation_after(sequence);
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
        slot.sequence = published_generation;
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
            let result = controller.client.recover(soul.clone(), trigger).await;
            controller.publish_recovery(&soul, sequence, &result).await;
        });
    }

    pub async fn retry_with_request_id(
        &self,
        request: RequestId,
        soul: SoulId,
        revision: u64,
    ) -> Result<RecoveryResult, ClientError> {
        let sequence =
            self.begin_recovery(&soul, true)
                .await
                .ok_or_else(|| ClientError::Runtime {
                    code: RuntimeErrorCode::InvalidRequest,
                    message: "recovery is already in progress".into(),
                    diagnostic_code: None,
                    fresh_agent_provider_start_diagnostic: None,
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
            let inventory_generation = self.recovery.next_generation();
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
            self.hydrate_at_generation(view.clone(), inventory_generation)
                .await;
            managed_descriptor_from_view(view, create_request_id).map(Some)
        })
    }

    fn launch<'a>(
        &'a self,
        request: ManagedTerminalLaunch,
    ) -> ManagedTerminalFuture<
        'a,
        Result<ManagedTerminalDescriptor, freshell_terminal::registry::ManagedTerminalLaunchError>,
    > {
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
            let mut pending_opencode_transfer = if request.mode == "opencode" {
                match request.resume_session_id.as_deref() {
                    Some(native_session_id) => Some(
                        stage_opencode_resume_bundle(
                            &self.client,
                            native_session_id,
                            &workspace,
                            &soul_id,
                            create_key,
                        )
                        .await?,
                    ),
                    None => None,
                }
            } else {
                None
            };
            let opencode_transfer = pending_opencode_transfer
                .as_ref()
                .map(|pending| pending.descriptor.clone());
            let opencode_transfer_attempt_id = pending_opencode_transfer
                .as_ref()
                .map(|pending| pending.attempt_id().to_owned());
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
                    opencode_transfer,
                    opencode_transfer_attempt_id,
                    opencode_adoption: None,
                }),
                view_intent: Some(crate::managed_view_intent::automatic_primary_view_request(
                    project_key.clone(),
                    request.view_tab_id.clone(),
                    request.view_pane_id.clone(),
                )),
                expected_control_epoch: None,
            };
            // A view returned by this launch may arrive after a concurrent
            // recovery publication. Reserve its ordering before dispatch so
            // that a later local publication remains authoritative.
            let launch_generation = self.recovery.next_generation();
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
                        return Err(error.to_string().into());
                    }
                }
            };
            if let Some(pending) = pending_opencode_transfer.as_mut() {
                pending.disarm();
            }
            self.hydrate_at_generation(result.view.clone(), launch_generation)
                .await;
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
    ) -> ManagedTerminalFuture<'a, Result<(), ManagedTerminalInputError>> {
        Box::pin(async move {
            let soul_key = terminal.soul_id;
            let soul = SoulId::parse(&soul_key).map_err(|e| e.to_string())?;
            if self.recovery_in_flight(&soul_key).await {
                return Err(ManagedTerminalInputError::RecoveryPending);
            }
            if self.blocked_recovery(&soul_key).await?.is_some() {
                // New user input is an explicit retry/repair signal. Re-arm the
                // persisted flap ceiling and prove continuity before accepting
                // any bytes; never substitute a fresh provider session.
                let sequence = self
                    .begin_recovery(&soul, true)
                    .await
                    .ok_or(ManagedTerminalInputError::RecoveryPending)?;
                let result = self
                    .client
                    .recover(soul.clone(), RecoveryTrigger::ManualRetry)
                    .await;
                self.publish_recovery(&soul, sequence, &result).await;
                let recovered = result.map_err(managed_terminal_input_error)?;
                match recovered.outcome {
                    RecoveryOutcome::Reattached
                    | RecoveryOutcome::Replaced
                    | RecoveryOutcome::AlreadyLive => {}
                    _ => {
                        return Err(if recovery_pending(&recovered) {
                            ManagedTerminalInputError::RecoveryPending
                        } else {
                            ManagedTerminalInputError::RecoveryBlocked
                        });
                    }
                }
            }
            self.client
                .input(RequestId::new(), soul, data)
                .await
                .map_err(managed_terminal_input_error)?;
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
                    let inventory_generation = self.recovery.next_generation();
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
                        self.hydrate_at_generation(view, inventory_generation).await;
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
            // The observer may have recovered independently of our last cached
            // verdict. Failed inventory refresh must not discard readable output.
            if let Err(error) = self.blocked_recovery(&soul_key).await {
                tracing::warn!(
                    event = "managed_runtime.lifecycle_refresh_failed",
                    soul_id = %soul_key,
                    error = %error,
                    "managed lifecycle inventory refresh failed"
                );
            }
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
                codex_activity: output.codex_activity,
                opencode_activity: output.opencode_activity,
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

fn managed_terminal_input_error(error: ClientError) -> ManagedTerminalInputError {
    match error.runtime_code() {
        Some(RuntimeErrorCode::RecoveryInProgress) => ManagedTerminalInputError::RecoveryPending,
        Some(RuntimeErrorCode::RecoveryBlocked | RuntimeErrorCode::RecoveryRetryBudget) => {
            ManagedTerminalInputError::RecoveryBlocked
        }
        _ => ManagedTerminalInputError::Unavailable(error.to_string()),
    }
}

fn recovery_pending(result: &RecoveryResult) -> bool {
    if result.outcome != RecoveryOutcome::Blocked {
        return false;
    }
    matches!(
        result.probe.as_ref(),
        Some(RecoveryProbe::Blocked {
            retry_hint: freshell_runtime_protocol::RetryHint {
                automatic_after_ms: Some(_),
                ..
            },
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

async fn stage_opencode_resume_bundle(
    client: &RuntimeClient,
    root_session_id: &str,
    workspace: &Path,
    destination_store_id: &SoulId,
    create_key: &str,
) -> Result<PendingOpenCodeTransfer, String> {
    let (target_image_ref, target_schema, target_build_receipt) = client
        .opencode_transfer_target()
        .await
        .map_err(|error| format!("OpenCode transfer target is unavailable: {error}"))?;
    let workspace_for_export = workspace.to_path_buf();
    let root_for_export = root_session_id.to_string();
    let snapshot = tokio::task::spawn_blocking(move || {
        let inventory = freshell_sessions::opencode_transfer::HostOpenCodeInventory::from_process_environment_discovering_channels()
            .map_err(|error| freshell_sessions::opencode_transfer::TransferError::Blocked(error.to_string()))?
            .with_trusted_mount_for_selected_session(workspace_for_export);
        freshell_sessions::opencode_transfer::export_exact_session(
            &inventory,
            &root_for_export,
            freshell_sessions::opencode_transfer::ExportOptions::default(),
        )
    })
    .await
    .map_err(|error| format!("OpenCode exact-session export did not settle: {error}"))?
    .map_err(|error| error.to_string())?;
    let manifest = snapshot.manifest();
    if manifest.provider_schema != target_schema {
        return Err("OpenCode source schema is incompatible with the pinned runtime image".into());
    }
    let transfer_identity = format!(
        "{create_key}:{}:{}:{}",
        manifest.generation,
        manifest.source_store_id,
        destination_store_id.as_str()
    );
    let transfer_id = format!("opencode-transfer-{}", stable_hex(&transfer_identity));
    let incarnation_id = IncarnationId::parse(format!(
        "incarnation-opencode-{}",
        stable_hex(&transfer_identity)
    ))
    .map_err(|error| error.to_string())?;
    let file = OpenCodeTransferFile {
        index: 0,
        relative_path: "payload.json".into(),
        size_bytes: manifest.payload_bytes,
        sha256: manifest.payload_sha256.clone(),
    };
    let mut descriptor = OpenCodeTransferDescriptor {
        transfer_id,
        provider: "opencode".into(),
        source_store_id: manifest.source_store_id.clone(),
        root_session_id: manifest.root_session_id.clone(),
        source_generation: manifest.generation.clone(),
        provider_schema: manifest.provider_schema.clone(),
        source_schema_fingerprint: manifest.source_schema_fingerprint.clone(),
        migration_journal_fingerprint: manifest.migration_journal_fingerprint.clone(),
        destination_store_id: destination_store_id.to_string(),
        destination_database_path: OPENCODE_TRANSFER_DESTINATION_DB.into(),
        target_image_ref,
        target_build_receipt,
        incarnation_id: incarnation_id.to_string(),
        manifest_json: serde_json::to_string(manifest)
            .map_err(|error| format!("encode OpenCode transfer manifest: {error}"))?,
        files: vec![file],
        total_bytes: manifest.payload_bytes,
        bundle_sha256: String::new(),
    };
    descriptor.bundle_sha256 = freshell_runtime_protocol::opencode_transfer_bundle_digest(
        &descriptor.manifest_json,
        &descriptor.files,
    );
    descriptor
        .validate()
        .map_err(|error| format!("OpenCode transfer descriptor is invalid: {}", error.message))?;

    let payload = TokioFile::from_std(
        snapshot
            .open_payload()
            .map_err(|error| format!("OpenCode exact-session payload is unavailable: {error}"))?,
    );
    stage_opencode_transfer_payload(client, descriptor, payload).await
}

async fn stage_opencode_transfer_payload(
    client: &RuntimeClient,
    descriptor: OpenCodeTransferDescriptor,
    mut payload: TokioFile,
) -> Result<PendingOpenCodeTransfer, String> {
    let attempt_id = Uuid::new_v4().simple().to_string();
    let mut abort_on_drop = OpenCodeTransferAbortOnDrop::new(
        client.clone(),
        descriptor.transfer_id.clone(),
        attempt_id.clone(),
    );
    let result = async {
        let begin_result = client
            .opencode_transfer_begin(descriptor.clone(), attempt_id.clone())
            .await
            .map_err(|error| format!("OpenCode transfer staging could not begin: {error}"))?;
        let (mut sequence, mut offset) = match begin_result {
            OpenCodeTransferResult::Started {
                next_sequence,
                file_offsets,
            } => {
                let [file_offset] = file_offsets.as_slice() else {
                    return Err("OpenCode staging returned unexpected file offsets".into());
                };
                if file_offset.file_index != 0 {
                    return Err("OpenCode staging returned an unexpected payload file".into());
                }
                (next_sequence, file_offset.next_offset)
            }
            OpenCodeTransferResult::Queued { transfer_id } => {
                if transfer_id != descriptor.transfer_id {
                    return Err("OpenCode staging queued a different transfer".into());
                }
                match client
                    .opencode_transfer_wait_for_capacity(transfer_id, attempt_id.clone())
                    .await
                    .map_err(|error| {
                        format!("OpenCode transfer capacity wait did not settle: {error}")
                    })? {
                    OpenCodeTransferResult::Started {
                        next_sequence,
                        file_offsets,
                    } => {
                        let [file_offset] = file_offsets.as_slice() else {
                            return Err("OpenCode staging returned unexpected file offsets".into());
                        };
                        if file_offset.file_index != 0 {
                            return Err(
                                "OpenCode staging returned an unexpected payload file".into()
                            );
                        }
                        (next_sequence, file_offset.next_offset)
                    }
                    _ => return Err("OpenCode capacity wait returned an unexpected result".into()),
                }
            }
            _ => return Err("OpenCode staging returned an unexpected begin result".into()),
        };
        let expected_sequence = offset.div_ceil(MAX_OPENCODE_TRANSFER_CHUNK_BYTES as u64);
        if offset > descriptor.total_bytes || sequence != expected_sequence {
            return Err("OpenCode staging resume cursor is inconsistent".into());
        }
        if offset != descriptor.total_bytes
            && offset % MAX_OPENCODE_TRANSFER_CHUNK_BYTES as u64 != 0
        {
            return Err("OpenCode staging resume offset is not chunk aligned".into());
        }

        payload
            .seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|error| format!("OpenCode payload seek failed: {error}"))?;
        while offset < descriptor.total_bytes {
            let remaining = descriptor.total_bytes - offset;
            let chunk_size = remaining.min(MAX_OPENCODE_TRANSFER_CHUNK_BYTES as u64) as usize;
            let mut data = vec![0; chunk_size];
            payload
                .read_exact(&mut data)
                .await
                .map_err(|error| format!("OpenCode payload read failed: {error}"))?;
            let chunk = OpenCodeTransferChunk {
                transfer_id: descriptor.transfer_id.clone(),
                attempt_id: attempt_id.clone(),
                sequence,
                file_index: 0,
                offset,
                sha256: format!("{:x}", Sha256::digest(&data)),
                data,
            };
            match client
                .opencode_transfer_chunk(chunk)
                .await
                .map_err(|error| format!("OpenCode transfer chunk was rejected: {error}"))?
            {
                OpenCodeTransferResult::ChunkStored { sequence: stored } if stored == sequence => {}
                _ => return Err("OpenCode staging returned an unexpected chunk result".into()),
            }
            offset += chunk_size as u64;
            sequence += 1;
        }
        match client
            .opencode_transfer_finalize(descriptor.transfer_id.clone(), attempt_id.clone())
            .await
            .map_err(|error| format!("OpenCode transfer could not be finalized: {error}"))?
        {
            OpenCodeTransferResult::Ready { transfer_id }
                if transfer_id == descriptor.transfer_id =>
            {
                Ok(descriptor.clone())
            }
            _ => Err("OpenCode staging did not return the ready transfer".into()),
        }
    }
    .await;

    match result {
        Ok(descriptor) => Ok(PendingOpenCodeTransfer {
            descriptor,
            abort_on_drop,
        }),
        Err(error) => {
            abort_on_drop.abort().await;
            Err(error)
        }
    }
}

struct PendingOpenCodeTransfer {
    descriptor: OpenCodeTransferDescriptor,
    abort_on_drop: OpenCodeTransferAbortOnDrop,
}

impl PendingOpenCodeTransfer {
    fn attempt_id(&self) -> &str {
        &self.abort_on_drop.attempt_id
    }

    fn disarm(&mut self) {
        self.abort_on_drop.disarm();
    }
}

struct OpenCodeTransferAbortOnDrop {
    client: RuntimeClient,
    transfer_id: String,
    attempt_id: String,
    armed: bool,
}

impl OpenCodeTransferAbortOnDrop {
    fn new(client: RuntimeClient, transfer_id: String, attempt_id: String) -> Self {
        Self {
            client,
            transfer_id,
            attempt_id,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }

    async fn abort(&mut self) {
        if self.armed {
            let _ = self
                .client
                .opencode_transfer_abort(self.transfer_id.clone(), self.attempt_id.clone())
                .await;
            self.armed = false;
        }
    }
}

impl Drop for OpenCodeTransferAbortOnDrop {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let (Ok(handle), client, transfer_id, attempt_id) = (
            tokio::runtime::Handle::try_current(),
            self.client.clone(),
            self.transfer_id.clone(),
            self.attempt_id.clone(),
        ) else {
            return;
        };
        handle.spawn(async move {
            let _ = client
                .opencode_transfer_abort(transfer_id, attempt_id)
                .await;
        });
    }
}

fn managed_provider_env(
    mode: &str,
    source: &std::collections::BTreeMap<String, String>,
) -> std::collections::BTreeMap<String, String> {
    let mut env = managed_env_allowlist(source);
    // The workload has a browser PTY even when the web server was launched
    // without a terminal. Codex otherwise waits for confirmation at startup.
    if env
        .get("TERM")
        .is_none_or(|term| term.is_empty() || term == "dumb")
    {
        env.insert("TERM".into(), "xterm-256color".into());
    }
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
        env.insert(
            "OPENCODE_DB".into(),
            "/home/freshell/provider/.local/share/opencode/opencode.db".into(),
        );
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
    use freshell_runtime_protocol::{
        read_frame, write_frame, AdminReply, AdminResult, ControlRole, Envelope,
        OpenCodeTransferAction, OpenCodeTransferFile, OpenCodeTransferFileOffset, RuntimeError,
        RuntimeErrorCode,
    };
    use std::collections::HashSet;
    use tokio::net::{UnixListener, UnixStream};
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
                            codex_activity: None,
                            opencode_activity: None,
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

    mod recovery_integration {
        use super::*;
        use freshell_runtime_protocol::{
            host_proof, AdminCommand, CommandState, DockerDaemonId, FixtureKind, HostBootId,
            HostCommand, HostReply, HostResult, RecoveryState, RuntimeOutputBatch,
            RuntimeOutputFrame,
        };
        use freshell_supervisor::{
            backend::{
                BackendCreated, BackendError, BackendInspection, BackendRuntimeState,
                CreateRuntimeSpec, RuntimeBackend,
            },
            registry::{BackendCreatedRecord, LaunchPreparation, OwnedRuntimeHandle, Registry},
            service::{Supervisor, SupervisorConfig},
        };
        use std::sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            Mutex as StdMutex,
        };
        use tokio::{
            sync::Notify,
            task::JoinHandle,
            time::{timeout, Duration},
        };

        #[derive(Default)]
        struct ReplyGate {
            hold_next: AtomicBool,
            ready: Notify,
            release: Notify,
            recover_calls: AtomicUsize,
            manual_calls: AtomicUsize,
            exhausted_calls: AtomicUsize,
        }

        #[derive(Clone, Debug, PartialEq)]
        struct InputObservation {
            incarnation_id: IncarnationId,
            native_session_id: String,
            data: String,
            intent_revision: u64,
            recovery_state: String,
            command_state: String,
        }

        struct RecoveryBackend {
            provider_home: PathBuf,
            failure: AtomicUsize,
            creates: AtomicUsize,
            reads: Arc<AtomicUsize>,
            inputs: Arc<StdMutex<Vec<InputObservation>>>,
            hosts: StdMutex<Vec<JoinHandle<()>>>,
        }
        impl Drop for RecoveryBackend {
            fn drop(&mut self) {
                for host in self.hosts.get_mut().unwrap().drain(..) {
                    host.abort();
                }
            }
        }
        #[async_trait::async_trait]
        impl RuntimeBackend for RecoveryBackend {
            async fn inspect(
                &self,
                handle: &OwnedRuntimeHandle,
            ) -> Result<BackendInspection, BackendError> {
                match self.failure.load(Ordering::SeqCst) {
                    1 => {
                        return Err(BackendError::Unavailable(
                            "private test dependency unavailable".into(),
                        ))
                    }
                    2 => {
                        return Err(BackendError::OwnershipMismatch(
                            "private test ownership mismatch".into(),
                        ))
                    }
                    _ => {}
                }
                Ok(BackendInspection {
                    state: if handle.runtime_dir().join("stopped").exists() {
                        BackendRuntimeState::Exited
                    } else if handle.runtime_dir().join("created").exists() {
                        BackendRuntimeState::Running
                    } else {
                        BackendRuntimeState::Missing
                    },
                    configured_limits: handle.requested_limits(),
                })
            }
            async fn create_stopped(
                &self,
                spec: &CreateRuntimeSpec,
            ) -> Result<BackendCreated, BackendError> {
                self.creates.fetch_add(1, Ordering::SeqCst);
                let container = format!("web-retry-{}", spec.incarnation_id);
                std::fs::write(spec.runtime_dir.join("created"), &container).unwrap();
                Ok(BackendCreated {
                    daemon_id: DockerDaemonId::new(),
                    container_id: container,
                    immutable_config_digest: "private-retry".into(),
                })
            }
            async fn start_host(&self, handle: &OwnedRuntimeHandle) -> Result<(), BackendError> {
                let listener = UnixListener::bind(handle.runtime_dir().join("host.sock")).unwrap();
                let secret = std::fs::read(handle.runtime_dir().join("secret")).unwrap();
                let incarnation = handle.incarnation_id().clone();
                let original = handle.container_id() == "web-retry-original";
                let limits = handle.requested_limits();
                let provider_home = self.provider_home.clone();
                let reads = self.reads.clone();
                let inputs = self.inputs.clone();
                let task = tokio::spawn(async move {
                    let boot = HostBootId::new();
                    let mut generation = u64::from(original);
                    loop {
                        let (mut stream, _) = listener.accept().await.unwrap();
                        let request: Envelope<HostCommand> = read_frame(&mut stream).await.unwrap();
                        let native: serde_json::Value = serde_json::from_slice(
                            &std::fs::read(provider_home.join("native-session-state.json"))
                                .unwrap(),
                        )
                        .unwrap();
                        let native = native["sessionId"].as_str().unwrap().to_owned();
                        let result = match request.body {
                            HostCommand::Hello {
                                incarnation_id,
                                challenge,
                            } => HostResult::Hello {
                                proof: host_proof(&secret, &challenge, &boot, &incarnation_id),
                                host_boot_id: boot.clone(),
                                capabilities: vec![],
                                effective_limits: limits,
                            },
                            HostCommand::GrantExecution {
                                execution_generation,
                                resume_spec,
                                ..
                            } => {
                                assert_eq!(
                                    resume_spec.unwrap().provider_session.native_session_id,
                                    native
                                );
                                generation = execution_generation;
                                HostResult::GrantAccepted {
                                    host_boot_id: boot.clone(),
                                    worker_pid: 42,
                                    worker_launch_count: 1,
                                    fixture_evidence: serde_json::json!({}),
                                    native_session_id: Some(native),
                                    native_identity_observation: None,
                                    opencode_transfer_receipt: None,
                                    opencode_adoption: Default::default(),
                                }
                            }
                            HostCommand::Status { .. } => HostResult::Status {
                                host_boot_id: boot.clone(),
                                worker_pid: Some(42),
                                worker_launch_count: 1,
                                max_control_epoch: 1,
                                max_execution_generation: generation,
                                fixture_evidence: serde_json::json!({}),
                                exited: original,
                                native_session_id: Some(native),
                                native_identity_observation: None,
                                opencode_transfer_receipt: None,
                                opencode_adoption: Default::default(),
                            },
                            HostCommand::ProbeRecovery { resume_spec, .. } => {
                                let spec = resume_spec.unwrap();
                                assert!(matches!(
                                    freshell_agent_runtime::probe_provider_store(
                                        &provider_home,
                                        &spec
                                    ),
                                    freshell_agent_runtime::ProviderStoreProbe::Ready { .. }
                                ));
                                HostResult::RecoveryProbe(RecoveryProbe::ResumeReady {
                                    evidence_revision: spec.evidence_revision,
                                    resume_spec: spec,
                                })
                            }
                            HostCommand::TerminalReadOutput { .. } if original => {
                                write_frame(
                                    &mut stream,
                                    &HostReply {
                                        request_id: request.request_id,
                                        result: Err(RuntimeError::new(
                                            RuntimeErrorCode::HostUnreachable,
                                            "private original output transport unavailable",
                                        )),
                                    },
                                )
                                .await
                                .unwrap();
                                continue;
                            }
                            HostCommand::TerminalReadOutput { .. } => {
                                reads.fetch_add(1, Ordering::SeqCst);
                                let epoch = incarnation.to_string();
                                HostResult::TerminalOutput(RuntimeOutputBatch {
                                    completion: None,
                                    incarnation_id: incarnation.clone(),
                                    terminal_id: "web-retry-terminal".into(),
                                    codex_activity: None,
                                    opencode_activity: None,
                                    stream_epoch: epoch.clone(),
                                    retained_from_seq: 1,
                                    head_seq: 1,
                                    reset_required: true,
                                    truncated: false,
                                    exited: false,
                                    exit_code: None,
                                    native_session_id: Some(native),
                                    frames: vec![RuntimeOutputFrame {
                                        terminal_id: "web-retry-terminal".into(),
                                        stream_epoch: epoch,
                                        seq_start: 1,
                                        seq_end: 1,
                                        data: "recovered output".into(),
                                    }],
                                })
                            }
                            HostCommand::TerminalInput {
                                incarnation_id,
                                request_id,
                                data,
                            } => {
                                let connection = rusqlite::Connection::open(
                                    provider_home
                                        .parent()
                                        .unwrap()
                                        .join("registry/runtime.sqlite3"),
                                )
                                .unwrap();
                                let (intent_revision, recovery_state, command_state) = connection
                                    .query_row(
                                        "SELECT s.intent_revision,s.recovery_state,c.state FROM souls s JOIN input_commands c ON c.soul_id=s.soul_id WHERE c.request_id=?1",
                                        [request_id.as_str()],
                                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                                    )
                                    .unwrap();
                                inputs.lock().unwrap().push(InputObservation {
                                    incarnation_id,
                                    native_session_id: native,
                                    data,
                                    intent_revision,
                                    recovery_state,
                                    command_state,
                                });
                                HostResult::TerminalInput {
                                    state: CommandState::Completed,
                                }
                            }
                            HostCommand::Stop { .. } => HostResult::Stopped,
                            other => panic!("unexpected recovery integration command: {other:?}"),
                        };
                        write_frame(
                            &mut stream,
                            &HostReply {
                                request_id: request.request_id,
                                result: Ok(result),
                            },
                        )
                        .await
                        .unwrap();
                    }
                });
                self.hosts.lock().unwrap().push(task);
                Ok(())
            }
            async fn request_stop(
                &self,
                handle: &OwnedRuntimeHandle,
                _: u64,
            ) -> Result<(), BackendError> {
                if handle.runtime_dir().exists() {
                    std::fs::write(handle.runtime_dir().join("stopped"), b"stopped").unwrap();
                }
                Ok(())
            }
            async fn force_stop(&self, handle: &OwnedRuntimeHandle) -> Result<(), BackendError> {
                self.request_stop(handle, 0).await
            }
            async fn verify_empty(
                &self,
                handle: &OwnedRuntimeHandle,
            ) -> Result<bool, BackendError> {
                Ok(!handle.runtime_dir().join("created").exists()
                    || handle.runtime_dir().join("stopped").exists())
            }
            async fn read_limits(
                &self,
                handle: &OwnedRuntimeHandle,
            ) -> Result<RuntimeLimits, BackendError> {
                Ok(handle.requested_limits())
            }
            async fn enable_long_lived(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
                Ok(())
            }
            async fn list_known(
                &self,
                handles: &[OwnedRuntimeHandle],
            ) -> Result<Vec<(IncarnationId, BackendInspection)>, BackendError> {
                let mut result = vec![];
                for handle in handles {
                    result.push((handle.incarnation_id().clone(), self.inspect(handle).await?));
                }
                Ok(result)
            }
        }

        struct RecoveryFixture {
            dir: tempfile::TempDir,
            supervisor: Supervisor,
            backend: Arc<RecoveryBackend>,
            controller: ServerManagedRuntimeController,
            terminal: ManagedTerminalDescriptor,
            soul: SoulId,
            gate: Arc<ReplyGate>,
            ipc: Option<JoinHandle<()>>,
        }
        impl Drop for RecoveryFixture {
            fn drop(&mut self) {
                if let Some(ipc) = self.ipc.take() {
                    ipc.abort();
                }
            }
        }
        impl RecoveryFixture {
            async fn new() -> Self {
                let dir = tempfile::tempdir().unwrap();
                let registry = Registry::open(dir.path().join("registry"), None).unwrap();
                let soul = SoulId::new();
                let limits = RuntimeLimits {
                    cpu_milli: 1000,
                    memory_bytes: 128 * 1024 * 1024,
                    swap_bytes: 0,
                    pids_max: 64,
                };
                let prepared = registry
                    .prepare_launch(LaunchPreparation {
                        soul_id: soul.clone(),
                        provider: "native-session-fixture".into(),
                        provider_store_id: "web-retry-store".into(),
                        native_session_id: None,
                        creation_seed_ref: "web-retry-seed".into(),
                        request_id: RequestId::new(),
                        payload_digest: "web-retry".into(),
                        requested_limits: limits,
                        profile: RuntimeProfile::Custom,
                        project_key: "web-retry".into(),
                        fixture: Some(FixtureKind::NativeSession),
                        terminal: Some(serde_json::from_value(serde_json::json!({
                            "terminalId":"web-retry-terminal", "streamId":"original-stream",
                            "mode":"native-session-fixture", "program":"/usr/bin/true",
                            "env":{"HOME":"/home/freshell/provider"},
                            "cwd":dir.path(), "workspacePath":dir.path(), "projectKey":"web-retry",
                            "runAsUid":65534, "runAsGid":0, "cols":80, "rows":24
                        })).unwrap()),
                        fresh_agent: None,
                        view_intent: None,
                        admission: Default::default(),
                    })
                    .await
                    .unwrap();
                let runtime = dir
                    .path()
                    .join("runtime")
                    .join(prepared.incarnation_id.as_str());
                std::fs::create_dir_all(&runtime).unwrap();
                std::fs::write(runtime.join("secret"), b"private-host-secret").unwrap();
                std::fs::write(runtime.join("stopped"), b"stopped").unwrap();
                // The original enclosure has ended. Retained polling observes
                // its owned empty spool while backend recovery waits.
                use freshell_runtime_protocol::terminal_spool::{
                    TerminalExitObservation, TerminalSpoolCompletion, TerminalSpoolDescriptor,
                    SPOOL_COMPLETION_FILE, SPOOL_CURRENT_FILE, SPOOL_DESCRIPTOR_FILE,
                };
                let descriptor = TerminalSpoolDescriptor {
                    schema_version: 1,
                    incarnation_id: prepared.incarnation_id.clone(),
                    terminal_id: "web-retry-terminal".into(),
                    stream_epoch: "original-stream-retained".into(),
                    segment_limit_bytes: 1024,
                };
                let completion = TerminalSpoolCompletion {
                    incarnation_id: descriptor.incarnation_id.clone(),
                    terminal_id: descriptor.terminal_id.clone(),
                    stream_epoch: descriptor.stream_epoch.clone(),
                    retained_from_seq: 1,
                    head_seq: 0,
                    exit: TerminalExitObservation::Known { code: 0 },
                };
                std::fs::write(
                    runtime.join(SPOOL_DESCRIPTOR_FILE),
                    serde_json::to_vec(&descriptor).unwrap(),
                )
                .unwrap();
                std::fs::write(
                    runtime.join(SPOOL_COMPLETION_FILE),
                    serde_json::to_vec(&completion).unwrap(),
                )
                .unwrap();
                std::fs::write(runtime.join(SPOOL_CURRENT_FILE), b"").unwrap();
                registry
                    .commit_created(
                        prepared.incarnation_id.clone(),
                        BackendCreatedRecord {
                            daemon_id: DockerDaemonId::new(),
                            container_id: "web-retry-original".into(),
                            image_ref: "private-test-image".into(),
                            runtime_dir: runtime,
                            host_binary_path: std::env::current_exe().unwrap(),
                            immutable_config_digest: "private-test".into(),
                            launch_policy: None,
                        },
                    )
                    .await
                    .unwrap();
                registry
                    .commit_execution_grant(
                        prepared.incarnation_id.clone(),
                        HostBootId::new(),
                        limits,
                    )
                    .await
                    .unwrap();
                registry
                    .mark_running(prepared.incarnation_id.clone())
                    .await
                    .unwrap();
                registry
                    .record_native_session(
                        soul.clone(),
                        prepared.incarnation_id.clone(),
                        "web-retry-root".into(),
                    )
                    .await
                    .unwrap();
                let mut context = registry.recovery_context(soul.clone()).await.unwrap();
                // Use the deterministic native-session fixture adapter for
                // resume evidence; the terminal spec separately owns output.
                context.terminal = None;
                let resume =
                    freshell_supervisor::resume_catalog::exact_resume_candidate(&context, None)
                        .unwrap()
                        .unwrap();
                registry
                    .store_verified_resume_spec(soul.clone(), resume)
                    .await
                    .unwrap();
                let provider_home = dir.path().join("provider");
                std::fs::create_dir(&provider_home).unwrap();
                std::fs::write(
                    provider_home.join("native-session-state.json"),
                    b"{\"sessionId\":\"web-retry-root\",\"history\":[\"synthetic\"]}",
                )
                .unwrap();
                let backend = Arc::new(RecoveryBackend {
                    provider_home,
                    failure: AtomicUsize::new(0),
                    creates: AtomicUsize::new(0),
                    reads: Arc::new(AtomicUsize::new(0)),
                    inputs: Arc::new(StdMutex::new(vec![])),
                    hosts: StdMutex::new(vec![]),
                });
                backend
                    .start_host(
                        &registry
                            .owned_handle(prepared.incarnation_id.clone())
                            .await
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                let socket = dir.path().join("control.sock");
                let supervisor = Supervisor::new(
                    registry,
                    backend.clone(),
                    SupervisorConfig {
                        runtime_root: dir.path().join("runtime"),
                        control_socket_path: socket.clone(),
                        host_binary_path: std::env::current_exe().unwrap(),
                        image_ref: format!("sha256:{}", "a".repeat(64)),
                        test_run_id: "web-recovery-integration".into(),
                        control_secret: "private-test-secret".into(),
                        lifecycle_log: dir.path().join("lifecycle.jsonl"),
                        admission: Default::default(),
                    },
                )
                .unwrap();
                let listener = UnixListener::bind(&socket).unwrap();
                let service = supervisor.clone();
                let gate = Arc::new(ReplyGate::default());
                let listener_gate = gate.clone();
                let ipc = tokio::spawn(async move {
                    let mut clients = tokio::task::JoinSet::new();
                    loop {
                        tokio::select! {
                            accepted = listener.accept() => {
                                let (mut stream, _) = accepted.unwrap();
                                let service = service.clone();
                                let gate = listener_gate.clone();
                                clients.spawn(async move {
                                    let request: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
                                    let recovery = matches!(&request.body, AdminCommand::Recover(_));
                                    if let AdminCommand::Recover(request) = &request.body {
                                        gate.recover_calls.fetch_add(1, Ordering::SeqCst);
                                        if request.trigger == RecoveryTrigger::ManualRetry { gate.manual_calls.fetch_add(1, Ordering::SeqCst); }
                                        if request.trigger == RecoveryTrigger::RetryExhausted { gate.exhausted_calls.fetch_add(1, Ordering::SeqCst); }
                                    }
                                    let reply = service.dispatch(request).await;
                                    if recovery && gate.hold_next.swap(false, Ordering::SeqCst) {
                                        gate.ready.notify_one();
                                        gate.release.notified().await;
                                    }
                                    write_frame(&mut stream, &reply).await.unwrap();
                                });
                            }
                            result = clients.join_next(), if !clients.is_empty() => { result.unwrap().unwrap(); }
                        }
                    }
                });
                let controller = ServerManagedRuntimeController {
                    client: RuntimeClient::new(&socket, "private-test-secret"),
                    recovery: Arc::new(ManagedRecoveryState::default()),
                };
                let terminal = ManagedTerminalDescriptor {
                    soul_id: soul.to_string(),
                    incarnation_id: prepared.incarnation_id.to_string(),
                    terminal_id: "web-retry-terminal".into(),
                    stream_id: "original-stream".into(),
                    mode: "native-session-fixture".into(),
                    cwd: dir.path().to_string_lossy().into_owned(),
                    resume_session_id: Some("web-retry-root".into()),
                    create_request_id: None,
                };
                Self {
                    dir,
                    supervisor,
                    backend,
                    controller,
                    terminal,
                    soul,
                    gate,
                    ipc: Some(ipc),
                }
            }
            async fn wait_for_request(&self) {
                timeout(Duration::from_secs(1), async {
                    while self.gate.recover_calls.load(Ordering::SeqCst) == 0
                        || self.controller.recovery_in_flight(self.soul.as_str()).await
                    {
                        tokio::task::yield_now().await;
                    }
                })
                .await
                .expect("the web request must settle without owning supervisor retry delays");
            }
            fn attempts(&self) -> u64 {
                rusqlite::Connection::open(self.dir.path().join("registry/runtime.sqlite3"))
                    .unwrap()
                    .query_row("SELECT COUNT(*) FROM recovery_attempts", [], |row| {
                        row.get(0)
                    })
                    .unwrap()
            }
            async fn close(&mut self) {
                if let Some(ipc) = self.ipc.take() {
                    ipc.abort();
                    assert!(ipc.await.unwrap_err().is_cancelled());
                }
                let hosts: Vec<_> = self.backend.hosts.lock().unwrap().drain(..).collect();
                for host in hosts {
                    host.abort();
                    assert!(host.await.unwrap_err().is_cancelled());
                }
            }
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn observer_retry_reaches_web_output_without_input() {
            let mut fixture = Box::pin(RecoveryFixture::new()).await;
            fixture.backend.failure.store(1, Ordering::SeqCst);
            Box::pin(fixture.supervisor.observe_once()).await.unwrap();
            assert_eq!(fixture.attempts(), 1);
            fixture
                .controller
                .read_output(fixture.terminal.clone(), 0, 4096)
                .await
                .unwrap();
            fixture.wait_for_request().await;
            let pending = fixture
                .controller
                .read_output(fixture.terminal.clone(), 0, 4096)
                .await;
            assert_eq!(
                fixture.attempts(),
                1,
                "web polling cannot spend the supervisor's pending attempt"
            );
            fixture.backend.failure.store(0, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(2_100)).await;
            Box::pin(fixture.supervisor.observe_once()).await.unwrap();
            let current = fixture
                .supervisor
                .registry()
                .recovery_context(fixture.soul.clone())
                .await
                .unwrap();
            assert_eq!(
                current.recovery_state,
                RecoveryState::Live,
                "supervisor must independently recover first; lifecycle: {}",
                std::fs::read_to_string(fixture.dir.path().join("lifecycle.jsonl")).unwrap()
            );
            assert_eq!(current.successful_recoveries_in_window, 1);
            assert_eq!(current.native_session_id.as_deref(), Some("web-retry-root"));
            let output = fixture
                .controller
                .read_output(fixture.terminal.clone(), 0, 4096)
                .await
                .expect(
                    "observer recovery must clear a stale web block without input or manual retry",
                );
            assert_eq!(output.chunks[0].data, "recovered output");
            assert_eq!(
                output.lifecycle.as_ref().unwrap().state,
                ManagedLifecycleState::Running,
                "successful automatic recovery must restore a usable pane lifecycle"
            );
            assert_eq!(
                output
                    .lifecycle
                    .as_ref()
                    .unwrap()
                    .recovery_summary
                    .as_ref()
                    .unwrap()
                    .recovery_state,
                "live"
            );
            assert_eq!(
                fixture.controller.recovery.slots.lock().await[fixture.soul.as_str()]
                    .incarnation_id
                    .as_deref(),
                Some(current.prior_handle.incarnation_id().as_str()),
                "reconciliation must select the current incarnation from retained inventory"
            );
            assert!(
                fixture
                    .controller
                    .begin_recovery(&fixture.soul, false)
                    .await
                    .is_some(),
                "the next automatic recovery must not be rejected by the stale cached block"
            );
            assert!(pending
                .expect("pending recovery keeps the pane attached")
                .chunks
                .is_empty());
            assert_eq!(fixture.backend.creates.load(Ordering::SeqCst), 1);
            assert_eq!(fixture.attempts(), 2);
            assert_eq!(fixture.gate.exhausted_calls.load(Ordering::SeqCst), 0);
            fixture.close().await;
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn web_recovery_request_does_not_own_retry_delays() {
            let mut fixture = Box::pin(RecoveryFixture::new()).await;
            fixture.backend.failure.store(1, Ordering::SeqCst);
            fixture
                .controller
                .read_output(fixture.terminal.clone(), 0, 4096)
                .await
                .unwrap();
            fixture.wait_for_request().await;
            assert_eq!(fixture.attempts(), 1);
            assert_eq!(fixture.gate.recover_calls.load(Ordering::SeqCst), 1);
            assert_eq!(fixture.gate.exhausted_calls.load(Ordering::SeqCst), 0);
            fixture.close().await;
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn current_policy_block_survives_but_late_old_intent_reply_does_not() {
            let mut fixture = Box::pin(RecoveryFixture::new()).await;
            fixture.backend.failure.store(2, Ordering::SeqCst);
            Box::pin(fixture.supervisor.observe_once()).await.unwrap();
            // Hold the first automatically admitted request after its policy
            // verdict. A cached block correctly refuses another automatic task.
            fixture.gate.hold_next.store(true, Ordering::SeqCst);
            fixture
                .controller
                .read_output(fixture.terminal.clone(), 0, 4096)
                .await
                .unwrap();
            timeout(Duration::from_secs(1), fixture.gate.ready.notified())
                .await
                .unwrap();
            fixture.backend.failure.store(0, Ordering::SeqCst);
            let blocked = fixture.controller.client.inventory().await.unwrap();
            let current = blocked
                .iter()
                .rev()
                .find(|view| view.soul_id == fixture.soul)
                .unwrap();
            assert_eq!(
                current.recovery_state,
                RecoveryState::Blocked,
                "repairing a dependency alone cannot erase a current policy block"
            );
            assert_eq!(fixture.backend.creates.load(Ordering::SeqCst), 0);
            let revision = fixture
                .supervisor
                .registry()
                .recovery_context(fixture.soul.clone())
                .await
                .unwrap()
                .intent_revision;
            let current = fixture
                .controller
                .client
                .recover_expected(
                    fixture.soul.clone(),
                    RecoveryTrigger::ManualRetry,
                    Some(revision),
                )
                .await
                .unwrap();
            assert_eq!(current.outcome, RecoveryOutcome::Replaced);
            assert_eq!(current.view.intent_revision, revision + 1);
            fixture.gate.release.notify_one();
            fixture.wait_for_request().await;
            let output = fixture
                .controller
                .read_output(fixture.terminal.clone(), 0, 4096)
                .await
                .expect("late old-intent reply cannot hide the current live output");
            assert_eq!(output.chunks[0].data, "recovered output");
            assert_eq!(
                output.lifecycle.unwrap().state,
                ManagedLifecycleState::Running
            );
            assert_eq!(fixture.backend.creates.load(Ordering::SeqCst), 1);
            assert!(fixture.backend.inputs.lock().unwrap().is_empty());
            fixture.close().await;
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn newer_policy_block_survives_output_poll_until_deliberate_input_recovers() {
            let mut fixture = Box::pin(RecoveryFixture::new()).await;
            fixture.backend.failure.store(2, Ordering::SeqCst);
            Box::pin(fixture.supervisor.observe_once()).await.unwrap();
            fixture
                .controller
                .read_output(fixture.terminal.clone(), 0, 4096)
                .await
                .unwrap();
            fixture.wait_for_request().await;
            assert!(fixture
                .controller
                .blocked_recovery(fixture.soul.as_str())
                .await
                .unwrap()
                .is_some());
            let revision = fixture
                .supervisor
                .registry()
                .recovery_context(fixture.soul.clone())
                .await
                .unwrap()
                .intent_revision;
            // The public retry route delegates directly to RuntimeClient, so
            // its newer result does not enter the controller's local cache.
            let newer = fixture
                .controller
                .runtime_client()
                .recover_expected_with_request_id(
                    RequestId::new(),
                    fixture.soul.clone(),
                    RecoveryTrigger::ManualRetry,
                    Some(revision),
                )
                .await
                .unwrap();
            assert_eq!(newer.outcome, RecoveryOutcome::Blocked);
            assert_eq!(newer.view.intent_revision, revision + 1);
            assert!(!recovery_pending(&newer));
            assert_eq!(fixture.attempts(), 2);
            assert_eq!(fixture.backend.creates.load(Ordering::SeqCst), 0);
            let newer_message = newer.view.recovery_reason.unwrap();
            let blocked_output = fixture
                .controller
                .read_output(fixture.terminal.clone(), 0, 4096)
                .await
                .unwrap();
            let blocked_lifecycle = blocked_output.lifecycle.unwrap();
            assert_eq!(blocked_lifecycle.state, ManagedLifecycleState::Blocked);
            assert_eq!(
                blocked_lifecycle
                    .recovery_summary
                    .unwrap()
                    .reason
                    .as_deref(),
                Some(newer_message.as_str())
            );
            let retained_block = fixture
                .controller
                .blocked_recovery(fixture.soul.as_str())
                .await
                .unwrap();
            assert_eq!(fixture.gate.recover_calls.load(Ordering::SeqCst), 2);
            assert!(fixture.backend.inputs.lock().unwrap().is_empty());

            fixture.backend.failure.store(0, Ordering::SeqCst);
            let input = fixture
                .controller
                .input(fixture.terminal.clone(), "deliberate input".into())
                .await;
            let current = fixture
                .supervisor
                .registry()
                .recovery_context(fixture.soul.clone())
                .await
                .unwrap();
            let connection =
                rusqlite::Connection::open(fixture.dir.path().join("registry/runtime.sqlite3"))
                    .unwrap();
            let attempts: Vec<(u64, String, bool)> = connection
                .prepare("SELECT intent_revision,verdict,finished_at IS NOT NULL FROM recovery_attempts ORDER BY intent_revision")
                .unwrap()
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            let completed_inputs: u64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM input_commands WHERE state='completed'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            drop(connection);
            fixture.close().await;

            assert_eq!(
                retained_block,
                Some(newer_message),
                "output polling must retain the newer block for deliberate retry; input result: {input:?}"
            );
            input.expect("deliberate input must recover the blocked soul before dispatch");
            assert_eq!(current.intent_revision, revision + 2);
            assert_eq!(current.recovery_state, RecoveryState::Live);
            assert_eq!(current.native_session_id.as_deref(), Some("web-retry-root"));
            assert_eq!(current.successful_recoveries_in_window, 1);
            assert_eq!(
                attempts,
                vec![
                    (revision, "blocked".into(), true),
                    (revision + 1, "blocked".into(), true),
                    (revision + 2, "succeeded".into(), true),
                ]
            );
            assert_eq!(fixture.gate.recover_calls.load(Ordering::SeqCst), 3);
            assert_eq!(fixture.gate.manual_calls.load(Ordering::SeqCst), 2);
            assert_eq!(fixture.gate.exhausted_calls.load(Ordering::SeqCst), 0);
            assert_eq!(fixture.backend.creates.load(Ordering::SeqCst), 1);
            assert_eq!(completed_inputs, 1);
            assert_eq!(
                *fixture.backend.inputs.lock().unwrap(),
                vec![InputObservation {
                    incarnation_id: current.prior_handle.incarnation_id().clone(),
                    native_session_id: "web-retry-root".into(),
                    data: "deliberate input".into(),
                    intent_revision: revision + 2,
                    recovery_state: "live".into(),
                    command_state: "dispatching".into(),
                }]
            );
        }
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
            native_identity_observation: None,
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
    fn managed_terminal_environment_replaces_headless_host_terminal_types() {
        for mode in ["codex", "opencode", "claude", "amplifier"] {
            for inherited in [None, Some(""), Some("dumb")] {
                let source = inherited
                    .map(|term| ("TERM".to_string(), term.to_string()))
                    .into_iter()
                    .collect();
                let environment = managed_provider_env(mode, &source);
                assert_eq!(
                    environment.get("TERM").map(String::as_str),
                    Some("xterm-256color"),
                    "{mode} browser PTY must not inherit {inherited:?} from a headless host"
                );
            }
            let source = [("TERM".to_string(), "screen-256color".to_string())].into();
            assert_eq!(
                managed_provider_env(mode, &source)
                    .get("TERM")
                    .map(String::as_str),
                Some("screen-256color")
            );
        }
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
            "4a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d".into(),
        ];
        assert_eq!(
            managed_provider_args("claude", args).unwrap(),
            vec![
                "--settings".to_string(),
                freshell_platform::cli_launch::claude_settings_json(
                    freshell_platform::cli_launch::ProviderTarget::Unix,
                ),
                "--session-id".to_string(),
                "4a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d".to_string(),
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

    #[tokio::test]
    async fn failed_connected_transfer_sends_abort_before_returning() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("control.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let client = RuntimeClient::new(&socket, "0123456789abcdef");
        let payload_bytes = b"synthetic-payload";
        let payload_path = dir.path().join("payload.json");
        std::fs::write(&payload_path, payload_bytes).unwrap();
        let descriptor = transfer_test_descriptor(payload_bytes, "transfer-client-error");
        let expected_id = descriptor.transfer_id.clone();

        let supervisor = tokio::spawn(async move {
            let mut reserved = HashSet::new();
            let mut current_attempt = None;
            for expected in ["begin", "chunk", "abort"] {
                let (mut stream, request) = accept_control_request(&listener).await;
                assert_eq!(request.role, ControlRole::Web);
                let (actual, result) = match request.body {
                    freshell_runtime_protocol::AdminCommand::OpenCodeTransfer(
                        OpenCodeTransferAction::Begin {
                            descriptor,
                            attempt_id,
                        },
                    ) => {
                        assert_eq!(expected, "begin");
                        reserved.insert(descriptor.transfer_id.clone());
                        current_attempt = Some(attempt_id);
                        (
                            "begin",
                            Ok(AdminResult::OpenCodeTransfer(
                                OpenCodeTransferResult::Started {
                                    next_sequence: 0,
                                    file_offsets: vec![OpenCodeTransferFileOffset {
                                        file_index: 0,
                                        next_offset: 0,
                                    }],
                                },
                            )),
                        )
                    }
                    freshell_runtime_protocol::AdminCommand::OpenCodeTransfer(
                        OpenCodeTransferAction::Chunk(chunk),
                    ) => {
                        assert_eq!(expected, "chunk");
                        assert!(reserved.contains(&chunk.transfer_id));
                        assert_eq!(current_attempt.as_ref(), Some(&chunk.attempt_id));
                        (
                            "chunk",
                            Err(RuntimeError::new(
                                RuntimeErrorCode::InvalidRequest,
                                "synthetic chunk rejection",
                            )),
                        )
                    }
                    freshell_runtime_protocol::AdminCommand::OpenCodeTransfer(
                        OpenCodeTransferAction::Abort {
                            transfer_id,
                            attempt_id,
                        },
                    ) => {
                        assert_eq!(expected, "abort");
                        assert_eq!(transfer_id, expected_id);
                        assert_eq!(current_attempt.as_ref(), Some(&attempt_id));
                        assert!(reserved.remove(&transfer_id));
                        (
                            "abort",
                            Ok(AdminResult::OpenCodeTransfer(
                                OpenCodeTransferResult::Aborted { transfer_id },
                            )),
                        )
                    }
                    other => panic!("unexpected transfer action: {other:?}"),
                };
                assert_eq!(actual, expected);
                write_frame(
                    &mut stream,
                    &AdminReply {
                        request_id: request.request_id,
                        result,
                    },
                )
                .await
                .unwrap();
            }
            assert!(reserved.is_empty(), "abort should release staged quota");
        });

        let payload = TokioFile::open(payload_path).await.unwrap();
        let result = stage_opencode_transfer_payload(&client, descriptor, payload).await;
        assert!(result.is_err());
        supervisor.await.unwrap();
    }

    #[tokio::test]
    async fn finalized_transfer_drop_before_launch_registration_sends_abort() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("control.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let client = RuntimeClient::new(&socket, "0123456789abcdef");
        let payload_bytes = b"synthetic-finalized-payload";
        let payload_path = dir.path().join("payload.json");
        std::fs::write(&payload_path, payload_bytes).unwrap();
        let descriptor = transfer_test_descriptor(payload_bytes, "transfer-finalized-drop");
        let expected_id = descriptor.transfer_id.clone();
        let supervisor_expected_id = expected_id.clone();

        let supervisor = tokio::spawn(async move {
            let mut current_attempt = None;
            let mut ready = false;
            for expected in ["begin", "wait", "chunk", "finalize", "abort"] {
                let (mut stream, request) = accept_control_request(&listener).await;
                let (actual, result) = match request.body {
                    freshell_runtime_protocol::AdminCommand::OpenCodeTransfer(
                        OpenCodeTransferAction::Begin {
                            descriptor,
                            attempt_id,
                        },
                    ) => {
                        assert_eq!(expected, "begin");
                        assert_eq!(descriptor.transfer_id, supervisor_expected_id);
                        current_attempt = Some(attempt_id);
                        (
                            "begin",
                            Ok(AdminResult::OpenCodeTransfer(
                                OpenCodeTransferResult::Queued {
                                    transfer_id: descriptor.transfer_id,
                                },
                            )),
                        )
                    }
                    freshell_runtime_protocol::AdminCommand::OpenCodeTransfer(
                        OpenCodeTransferAction::WaitForCapacity {
                            transfer_id,
                            attempt_id,
                        },
                    ) => {
                        assert_eq!(expected, "wait");
                        assert_eq!(transfer_id, supervisor_expected_id);
                        assert_eq!(current_attempt.as_ref(), Some(&attempt_id));
                        (
                            "wait",
                            Ok(AdminResult::OpenCodeTransfer(
                                OpenCodeTransferResult::Started {
                                    next_sequence: 0,
                                    file_offsets: vec![OpenCodeTransferFileOffset {
                                        file_index: 0,
                                        next_offset: 0,
                                    }],
                                },
                            )),
                        )
                    }
                    freshell_runtime_protocol::AdminCommand::OpenCodeTransfer(
                        OpenCodeTransferAction::Chunk(chunk),
                    ) => {
                        assert_eq!(expected, "chunk");
                        assert_eq!(chunk.transfer_id, supervisor_expected_id);
                        assert_eq!(current_attempt.as_ref(), Some(&chunk.attempt_id));
                        (
                            "chunk",
                            Ok(AdminResult::OpenCodeTransfer(
                                OpenCodeTransferResult::ChunkStored {
                                    sequence: chunk.sequence,
                                },
                            )),
                        )
                    }
                    freshell_runtime_protocol::AdminCommand::OpenCodeTransfer(
                        OpenCodeTransferAction::Finalize {
                            transfer_id,
                            attempt_id,
                        },
                    ) => {
                        assert_eq!(expected, "finalize");
                        assert_eq!(transfer_id, supervisor_expected_id);
                        assert_eq!(current_attempt.as_ref(), Some(&attempt_id));
                        ready = true;
                        (
                            "finalize",
                            Ok(AdminResult::OpenCodeTransfer(
                                OpenCodeTransferResult::Ready { transfer_id },
                            )),
                        )
                    }
                    freshell_runtime_protocol::AdminCommand::OpenCodeTransfer(
                        OpenCodeTransferAction::Abort {
                            transfer_id,
                            attempt_id,
                        },
                    ) => {
                        assert_eq!(expected, "abort");
                        assert!(
                            ready,
                            "the pending launch owner must remain armed after finalize"
                        );
                        assert_eq!(transfer_id, supervisor_expected_id);
                        assert_eq!(current_attempt.as_ref(), Some(&attempt_id));
                        ready = false;
                        (
                            "abort",
                            Ok(AdminResult::OpenCodeTransfer(
                                OpenCodeTransferResult::Aborted { transfer_id },
                            )),
                        )
                    }
                    other => panic!("unexpected transfer action: {other:?}"),
                };
                assert_eq!(actual, expected);
                write_frame(
                    &mut stream,
                    &AdminReply {
                        request_id: request.request_id,
                        result,
                    },
                )
                .await
                .unwrap();
            }
            assert!(
                !ready,
                "pre-registration abort should release the ready stage"
            );
        });

        let payload = TokioFile::open(payload_path).await.unwrap();
        let pending = stage_opencode_transfer_payload(&client, descriptor, payload)
            .await
            .unwrap();
        assert_eq!(pending.descriptor.transfer_id, expected_id);
        drop(pending); // Models a local launch preparation failure before registration.
        tokio::time::timeout(std::time::Duration::from_secs(5), supervisor)
            .await
            .expect("dropping the pending owner should send a matching abort")
            .unwrap();
    }

    #[tokio::test]
    async fn cancelling_connected_transfer_sends_supervisor_abort() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("control.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let client = RuntimeClient::new(&socket, "0123456789abcdef");
        let payload_bytes = b"synthetic-payload";
        let payload_path = dir.path().join("payload.json");
        std::fs::write(&payload_path, payload_bytes).unwrap();
        let descriptor = transfer_test_descriptor(payload_bytes, "transfer-client-cancel");
        let expected_id = descriptor.transfer_id.clone();
        let (chunk_seen_tx, chunk_seen_rx) = tokio::sync::oneshot::channel();

        let supervisor = tokio::spawn(async move {
            let mut reserved = HashSet::new();
            let (mut stream, begin) = accept_control_request(&listener).await;
            let freshell_runtime_protocol::AdminCommand::OpenCodeTransfer(
                OpenCodeTransferAction::Begin {
                    descriptor,
                    attempt_id,
                },
            ) = begin.body
            else {
                panic!("expected transfer begin");
            };
            reserved.insert(descriptor.transfer_id.clone());
            let current_attempt = attempt_id;
            write_frame(
                &mut stream,
                &AdminReply {
                    request_id: begin.request_id,
                    result: Ok(AdminResult::OpenCodeTransfer(
                        OpenCodeTransferResult::Started {
                            next_sequence: 0,
                            file_offsets: vec![OpenCodeTransferFileOffset {
                                file_index: 0,
                                next_offset: 0,
                            }],
                        },
                    )),
                },
            )
            .await
            .unwrap();

            let (_chunk_stream, chunk) = accept_control_request(&listener).await;
            let freshell_runtime_protocol::AdminCommand::OpenCodeTransfer(
                OpenCodeTransferAction::Chunk(chunk),
            ) = chunk.body
            else {
                panic!("expected transfer chunk");
            };
            assert!(reserved.contains(&chunk.transfer_id));
            assert_eq!(current_attempt, chunk.attempt_id);
            chunk_seen_tx.send(()).unwrap();

            let (mut stream, abort) = accept_control_request(&listener).await;
            let freshell_runtime_protocol::AdminCommand::OpenCodeTransfer(
                OpenCodeTransferAction::Abort {
                    transfer_id,
                    attempt_id,
                },
            ) = abort.body
            else {
                panic!("expected transfer abort after cancellation");
            };
            assert_eq!(transfer_id, expected_id);
            assert_eq!(current_attempt, attempt_id);
            assert!(reserved.remove(&transfer_id));
            write_frame(
                &mut stream,
                &AdminReply {
                    request_id: abort.request_id,
                    result: Ok(AdminResult::OpenCodeTransfer(
                        OpenCodeTransferResult::Aborted { transfer_id },
                    )),
                },
            )
            .await
            .unwrap();
            assert!(reserved.is_empty(), "abort should release staged quota");
        });

        let payload = TokioFile::open(payload_path).await.unwrap();
        let transfer_client = client.clone();
        let transfer = tokio::spawn(async move {
            stage_opencode_transfer_payload(&transfer_client, descriptor, payload).await
        });
        chunk_seen_rx.await.unwrap();
        transfer.abort();
        assert!(transfer
            .await
            .err()
            .is_some_and(|error| error.is_cancelled()));
        tokio::time::timeout(std::time::Duration::from_secs(5), supervisor)
            .await
            .expect("supervisor should receive the cancellation abort")
            .unwrap();
    }

    async fn accept_control_request(
        listener: &UnixListener,
    ) -> (
        UnixStream,
        Envelope<freshell_runtime_protocol::AdminCommand>,
    ) {
        let (mut stream, _) = listener.accept().await.unwrap();
        let request = read_frame(&mut stream).await.unwrap();
        (stream, request)
    }

    fn transfer_test_descriptor(payload: &[u8], transfer_id: &str) -> OpenCodeTransferDescriptor {
        let source_store_id = "b".repeat(64);
        let source_generation = "e".repeat(64);
        let source_schema_fingerprint = "c".repeat(64);
        let migration_journal_fingerprint = "d".repeat(64);
        let target_image_ref = format!("sha256:{}", "a".repeat(64));
        let payload_sha256 = format!("{:x}", Sha256::digest(payload));
        let files = vec![OpenCodeTransferFile {
            index: 0,
            relative_path: "payload.json".into(),
            size_bytes: payload.len() as u64,
            sha256: payload_sha256.clone(),
        }];
        let manifest_json = serde_json::json!({
            "version": 1,
            "provider_schema": "opencode-1.18.21",
            "root_session_id": "ses_exact",
            "source_store_id": source_store_id,
            "source_schema_fingerprint": source_schema_fingerprint,
            "migration_journal_fingerprint": migration_journal_fingerprint,
            "generation": source_generation,
            "assets": [],
            "payload_bytes": payload.len(),
            "payload_sha256": payload_sha256,
            "rows": []
        })
        .to_string();
        let descriptor = OpenCodeTransferDescriptor {
            transfer_id: transfer_id.into(),
            provider: "opencode".into(),
            source_store_id,
            root_session_id: "ses_exact".into(),
            source_generation,
            provider_schema: "opencode-1.18.21".into(),
            source_schema_fingerprint,
            migration_journal_fingerprint,
            destination_store_id: "soul-test".into(),
            destination_database_path: freshell_runtime_protocol::OPENCODE_TRANSFER_DESTINATION_DB
                .into(),
            target_build_receipt: freshell_runtime_protocol::opencode_target_build_receipt(
                &target_image_ref,
                "opencode-1.18.21",
            ),
            target_image_ref,
            incarnation_id: "incarnation-test-transfer".into(),
            bundle_sha256: freshell_runtime_protocol::opencode_transfer_bundle_digest(
                &manifest_json,
                &files,
            ),
            manifest_json,
            files,
            total_bytes: payload.len() as u64,
        };
        descriptor.validate().unwrap();
        descriptor
    }
}

#[cfg(all(test, unix))]
#[path = "managed_output_rpc_tests.rs"]
mod managed_output_rpc_tests;

#[cfg(all(test, unix))]
#[path = "managed_runtime_opencode_replan_tests.rs"]
mod opencode_replan_tests;

#[cfg(all(test, unix))]
#[path = "managed_launch_view_title_tests.rs"]
mod launch_view_title_tests;

#[cfg(all(test, unix))]
#[path = "managed_input_rpc_tests.rs"]
mod managed_input_rpc_tests;

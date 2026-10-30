use crate::{
    admission::AdmissionPolicy,
    backend::{
        host_actor_state_dir, BackendError, CreateRuntimeSpec, DockerEngineBackend, RuntimeBackend,
    },
    opencode_transfer::{OpenCodeTransferStaging, StagingLimits},
    registry::{
        stable_provider_volume_name, BackendCreatedRecord, ExecutionGrantRecord,
        InputJournalDisposition, LaunchPreparation, PreparedLaunch, RecoveryWriteFence, Registry,
        RegistryError,
    },
};
use freshell_runtime_protocol::{
    host_proof, read_frame, write_frame, AdminCommand, AdminReply, AdminResult, CommandState,
    ControlRole, Envelope, FixtureKind, FreshAgentLaunchSpec, HostBootId, HostCommand, HostReply,
    HostResult, IncarnationId, IncidentId, LaunchResult, LaunchState, LimitApplication,
    OpenCodeTransferAction, OpenCodeTransferReadinessReceipt, OpenCodeTransferResult, RequestId,
    ResumeSpec, RuntimeError, RuntimeErrorCode, RuntimeLimits, RuntimeMetrics, RuntimeOutputBatch,
    RuntimeView, SoulId, StopOutcome, TerminalLaunchSpec, UpdateLimitsResult,
    CONTROL_PROTOCOL_VERSION,
};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex as StdMutex, OnceLock,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{UnixListener, UnixStream},
    sync::Mutex,
    time::{sleep, Duration, Instant},
};

/// Private cause information retained before the public runtime error projection.
struct ClassifiedFailure {
    error: RuntimeError,
    category: &'static str,
    http_status: Option<u16>,
}

impl ClassifiedFailure {
    fn timeout(error: RuntimeError) -> Self {
        Self {
            error,
            category: "timeout",
            http_status: None,
        }
    }

    fn backend(error: BackendError) -> Self {
        let (category, http_status) = backend_failure_category(&error);
        Self {
            error: map_backend(error),
            category,
            http_status,
        }
    }
}

impl From<RuntimeError> for ClassifiedFailure {
    fn from(error: RuntimeError) -> Self {
        let category = match error.code {
            RuntimeErrorCode::HostUnreachable | RuntimeErrorCode::BackendUnavailable => {
                "unavailable"
            }
            RuntimeErrorCode::HostAuthenticationFailed => "authentication_failed",
            RuntimeErrorCode::OwnershipMismatch => "ownership_mismatch",
            _ => "runtime_error",
        };
        Self {
            error,
            category,
            http_status: None,
        }
    }
}

fn backend_failure_category(error: &BackendError) -> (&'static str, Option<u16>) {
    match error {
        BackendError::Unavailable(_) => ("unavailable", None),
        BackendError::OwnershipMismatch(_) => ("ownership_mismatch", None),
        BackendError::PolicyMismatch(_) => ("policy_mismatch", None),
        BackendError::DockerHttp { status, .. } => ("docker_http", Some(*status)),
        BackendError::Malformed(_) => ("malformed_response", None),
        BackendError::InvalidConfig(_) => ("invalid_config", None),
        BackendError::StoppedRepair(_) => ("stopped_repair", None),
    }
}

#[derive(Clone)]
pub struct SupervisorConfig {
    pub runtime_root: PathBuf,
    pub control_socket_path: PathBuf,
    pub host_binary_path: PathBuf,
    pub image_ref: String,
    pub test_run_id: String,
    pub control_secret: String,
    pub lifecycle_log: PathBuf,
    pub admission: AdmissionPolicy,
}

pub(crate) struct LaunchWorkload {
    pub(crate) soul_id: SoulId,
    pub(crate) fixture: Option<FixtureKind>,
    pub(crate) terminal: Option<TerminalLaunchSpec>,
    pub(crate) fresh_agent: Option<FreshAgentLaunchSpec>,
    pub(crate) resume_spec: Option<ResumeSpec>,
}

impl LaunchWorkload {
    // Ordinary and imported terminals share the native TUI loader. Choosing
    // its readiness budget supplies no adoption or identity evidence.
    pub(crate) fn opencode_tui_readiness_required(&self, provider: &str) -> bool {
        provider == "opencode"
            && self.fresh_agent.is_none()
            && self
                .terminal
                .as_ref()
                .is_some_and(|terminal| terminal.mode == "opencode" && terminal.validate().is_ok())
    }
}

struct McpCapabilityRequest<'a> {
    action: &'a str,
    soul_id: &'a SoulId,
    incarnation_id: Option<&'a IncarnationId>,
    grant_id: Option<&'a str>,
    provider: Option<&'a str>,
    tui_source: Option<&'a freshell_runtime_protocol::ProviderConfigReference>,
    workspace: Option<&'a str>,
    auth_lookup_authority: Option<&'a str>,
    claude_recovery_source: Option<&'a freshell_runtime_protocol::ClaudeRecoverySourceBinding>,
    cwd: Option<&'a str>,
    prior_context: Option<&'a freshell_runtime_protocol::ProviderLaunchContext>,
    provider_secret_references: Option<&'a [freshell_runtime_protocol::ProviderSecretReference]>,
    provider_path_inputs: Option<&'a freshell_runtime_protocol::ProviderPathInputs>,
}

#[derive(Clone)]
struct AuthLookupAuthority {
    start: crate::registry::RecoveryStart,
    expires: Instant,
}
struct AuthLookupScope {
    authorities: Arc<StdMutex<HashMap<String, AuthLookupAuthority>>>,
    key: String,
}

#[path = "claude_source_observation.rs"]
mod claude_source_observation;
#[cfg(test)]
#[path = "native_auth_lookup_tests.rs"]
mod native_auth_lookup_tests;
#[cfg(test)]
#[path = "provider_callback_budget_tests.rs"]
mod provider_callback_budget_tests;
#[cfg(test)]
#[path = "provider_preparation_tests.rs"]
mod provider_preparation_tests;
impl Drop for AuthLookupScope {
    fn drop(&mut self) {
        self.authorities
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.key);
    }
}

type ProviderPathInputBindings = HashMap<
    (SoulId, String),
    (
        freshell_runtime_protocol::ProviderPathInputs,
        Option<Instant>,
    ),
>;
pub(crate) type LiveResumeEvidenceKey = (String, String, Option<String>);

#[derive(Clone)]
pub struct Supervisor {
    pub(crate) registry: Registry,
    pub(crate) backend: Arc<dyn RuntimeBackend>,
    pub(crate) config: Arc<SupervisorConfig>,
    pub(crate) opencode_transfer_staging: Arc<OpenCodeTransferStaging>,
    /// Serializes a ready-stage launch claim plus registry preparation with
    /// cleanup's registry snapshot and filesystem reclamation.
    pub(crate) opencode_transfer_lifecycle_lock: Arc<Mutex<()>>,
    /// Recovery and input dispatch serialize per soul, while unrelated souls
    /// remain independently recoverable. Stop commits its durable intent before
    /// waiting for this lock so it can invalidate an in-flight operation.
    pub(crate) recovery_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    /// Bounds repeated provider-store probes for an unchanged live identity.
    pub(crate) live_resume_evidence_attempts: Arc<Mutex<HashMap<LiveResumeEvidenceKey, Instant>>>,
    auth_lookup_authorities: Arc<StdMutex<HashMap<String, AuthLookupAuthority>>>,
    provider_path_inputs: Arc<StdMutex<ProviderPathInputBindings>>,
    /// Reply budgets for supervisor→session-host commands, read once.
    pub(crate) host_command_budgets: HostCommandBudgets,
    pub(crate) provider_callback_budgets: ProviderCallbackBudgets,
}

impl Supervisor {
    pub fn new(
        registry: Registry,
        backend: Arc<dyn RuntimeBackend>,
        config: SupervisorConfig,
    ) -> Result<Self, RuntimeError> {
        if !config.image_ref.starts_with("sha256:") {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                "runtime image must be pinned by sha256",
            ));
        }
        std::fs::create_dir_all(&config.runtime_root)
            .map_err(|e| RuntimeError::new(RuntimeErrorCode::RegistryFailure, e.to_string()))?;
        let canonical_root = std::fs::canonicalize(&config.runtime_root).map_err(|e| {
            RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                format!("runtime root: {e}"),
            )
        })?;
        let canonical_binary = std::fs::canonicalize(&config.host_binary_path).map_err(|e| {
            RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                format!("host binary: {e}"),
            )
        })?;
        if !canonical_binary.is_file() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                "host binary is not a file",
            ));
        }
        let mut config = config;
        config.runtime_root = canonical_root;
        config.host_binary_path = canonical_binary;
        let opencode_transfer_staging =
            OpenCodeTransferStaging::new(&config.runtime_root, StagingLimits::production())
                .map_err(|error| {
                    RuntimeError::new(
                        RuntimeErrorCode::RegistryFailure,
                        format!("initialize OpenCode transfer staging: {error}"),
                    )
                })?;
        lifecycle_secrets()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(config.lifecycle_log.clone(), config.control_secret.clone());
        Ok(Self {
            registry,
            backend,
            config: Arc::new(config),
            opencode_transfer_staging: Arc::new(opencode_transfer_staging),
            opencode_transfer_lifecycle_lock: Arc::new(Mutex::new(())),
            recovery_locks: Arc::new(Mutex::new(HashMap::new())),
            live_resume_evidence_attempts: Arc::new(Mutex::new(HashMap::new())),
            auth_lookup_authorities: Arc::new(StdMutex::new(HashMap::new())),
            provider_path_inputs: Arc::new(StdMutex::new(HashMap::new())),
            host_command_budgets: HostCommandBudgets::from_env(),
            provider_callback_budgets: ProviderCallbackBudgets::default(),
        })
    }

    pub fn registry(&self) -> &Registry {
        &self.registry
    }

    pub(crate) async fn lifecycle_lock(&self, soul_id: &SoulId) -> Arc<Mutex<()>> {
        let mut locks = self.recovery_locks.lock().await;
        Arc::clone(
            locks
                .entry(soul_id.as_str().to_string())
                .or_insert_with(|| Arc::new(Mutex::new(()))),
        )
    }

    /// Retry cleanup for receipt-confirmed stages after startup or a prior
    /// cleanup interruption. The registry is the authority for active
    /// prepared/retry references.
    ///
    /// The registry snapshot and filesystem removal are separate operations.
    /// A concurrent launch cannot add a valid reference to the same ready
    /// stage in between: its descriptor pins the transfer to a unique
    /// incarnation, which the registry will not prepare twice. A different
    /// descriptor reusing the transfer ID cannot consume the existing ready
    /// bundle, and begin/reclaim serialize under the staging lock.
    pub async fn cleanup_opencode_transfer_staging(&self) -> Result<usize, RuntimeError> {
        let _lifecycle_guard = self.opencode_transfer_lifecycle_lock.lock().await;
        self.recover_opencode_transfer_receipts().await;
        let references = self
            .registry
            .opencode_transfer_stage_references()
            .await
            .map_err(map_registry)?;
        let referenced_transfer_ids = references.keys().cloned().collect::<HashSet<_>>();
        let staging = Arc::clone(&self.opencode_transfer_staging);
        tokio::task::spawn_blocking(move || {
            staging.reconcile_registering_ready(&references)?;
            let abandoned = staging.reclaim_abandoned_partials()?;
            let expired_ready = staging.reclaim_abandoned_ready(&referenced_transfer_ids)?;
            let receipt_released = staging.reclaim_release_eligible(&referenced_transfer_ids)?;
            Ok(abandoned + expired_ready + receipt_released)
        })
        .await
        .map_err(|error| {
            RuntimeError::new(
                RuntimeErrorCode::RegistryFailure,
                format!("OpenCode stage cleanup worker did not settle: {error}"),
            )
        })?
        .map_err(map_opencode_transfer)
    }

    /// Recover the narrow crash window where the host persisted a receipt and
    /// accepted the grant, but the supervisor stopped before writing its
    /// release marker. Host status is authenticated with the same per-runtime
    /// secret as grant delivery, and the marker remains pinned while the
    /// registry still says the launch is starting.
    async fn recover_opencode_transfer_receipts(&self) {
        let candidates = match self.registry.opencode_transfer_receipt_candidates().await {
            Ok(candidates) => candidates,
            Err(error) => {
                append_event(
                    &self.config.lifecycle_log,
                    "supervisor.opencode_transfer_receipt_recovery_failed",
                    serde_json::json!({"stage":"load_candidates","error":error.to_string()}),
                );
                return;
            }
        };
        for incarnation_id in candidates {
            let result = self
                .recover_opencode_transfer_receipt(&incarnation_id)
                .await;
            if let Err(error) = result {
                append_event(
                    &self.config.lifecycle_log,
                    "supervisor.opencode_transfer_receipt_recovery_deferred",
                    serde_json::json!({"incarnationId":incarnation_id,"error":error.message}),
                );
            }
        }
    }

    async fn recover_opencode_transfer_receipt(
        &self,
        incarnation_id: &IncarnationId,
    ) -> Result<(), RuntimeError> {
        let handle = self
            .registry
            .owned_handle(incarnation_id.clone())
            .await
            .map_err(map_registry)?;
        let Some(terminal) = handle.terminal() else {
            return Ok(());
        };
        let Some(descriptor) = terminal.opencode_transfer.as_ref() else {
            return Ok(());
        };
        let host = self
            .authenticate_host(handle.incarnation_id(), handle.runtime_dir())
            .await?;
        let status = self
            .host_status(handle.incarnation_id().clone(), handle.runtime_dir(), &host)
            .await?;
        let Some(receipt) = status.opencode_transfer_receipt else {
            return Ok(());
        };
        let Some(receipt) = validate_opencode_transfer_receipt(
            Some(descriptor),
            Some((terminal.run_as_uid, terminal.run_as_gid)),
            Some(receipt),
        )?
        else {
            return Ok(());
        };
        let staging = Arc::clone(&self.opencode_transfer_staging);
        let descriptor = descriptor.clone();
        tokio::task::spawn_blocking(move || staging.mark_release_eligible(&descriptor, &receipt))
            .await
            .map_err(|error| {
                RuntimeError::new(
                    RuntimeErrorCode::RegistryFailure,
                    format!("OpenCode receipt recovery worker did not settle: {error}"),
                )
            })?
            .map_err(map_opencode_transfer)?;
        Ok(())
    }

    pub async fn dispatch(&self, envelope: Envelope<AdminCommand>) -> AdminReply {
        let request_id = envelope.request_id.clone();
        // The command switch retains provider/recovery futures of different
        // sizes. Poll it on the heap rather than nesting that whole state in
        // this outer reply future on the runtime worker's stack.
        let result = Box::pin(self.dispatch_inner(envelope)).await;
        AdminReply { request_id, result }
    }

    async fn dispatch_inner(
        &self,
        envelope: Envelope<AdminCommand>,
    ) -> Result<AdminResult, RuntimeError> {
        if envelope.protocol_version != CONTROL_PROTOCOL_VERSION {
            return Err(RuntimeError::new(
                RuntimeErrorCode::ProtocolVersionMismatch,
                "unsupported supervisor protocol version",
            ));
        }
        if envelope.role != ControlRole::Web {
            return Err(RuntimeError::new(
                RuntimeErrorCode::UnauthorizedRole,
                "web-control socket accepts web role only",
            ));
        }
        if envelope.auth.as_deref() != Some(self.config.control_secret.as_str()) {
            return Err(RuntimeError::new(
                RuntimeErrorCode::UnauthorizedRole,
                "invalid web-control credential",
            ));
        }
        match envelope.body {
            AdminCommand::Recover(request) => {
                self.registry
                    .assert_epoch(request.expected_control_epoch)
                    .map_err(map_registry)?;
                // Recovery must not retain the general command switch's
                // unrelated provider futures on the worker's polling stack.
                Box::pin(self.recover(request))
                    .await
                    .map(AdminResult::Recovery)
            }
            _ => Box::pin(self.dispatch_non_recovery(envelope)).await,
        }
    }

    async fn dispatch_non_recovery(
        &self,
        envelope: Envelope<AdminCommand>,
    ) -> Result<AdminResult, RuntimeError> {
        match envelope.body {
            AdminCommand::ReserveProviderInputs(request) => {
                self.registry
                    .assert_epoch(request.expected_control_epoch)
                    .map_err(map_registry)?;
                let lock = self.lifecycle_lock(&request.soul_id).await;
                let _held = lock.lock().await;
                let reservation = self
                    .registry
                    .reserve_initial_inputs(
                        request,
                        self.config.image_ref.clone(),
                        self.config.host_binary_path.clone(),
                    )
                    .await
                    .map_err(map_registry)?;
                let observation = tokio::time::timeout(
                    Duration::from_secs(10),
                    self.backend.observe_initial_auth_volume(&reservation),
                )
                .await
                .map_err(|_| {
                    RuntimeError::new(
                        RuntimeErrorCode::HostUnreachable,
                        "initial auth source observation timed out",
                    )
                })?
                .map_err(|_| {
                    RuntimeError::new(
                        RuntimeErrorCode::HostUnreachable,
                        "initial auth source observation failed; retry preparation",
                    )
                })?;
                self.registry
                    .record_initial_observation(reservation, observation)
                    .await
                    .map(AdminResult::ProviderInputReservation)
                    .map_err(map_registry)
            }
            AdminCommand::BindProviderPathInputs(request) => {
                self.registry
                    .assert_epoch(request.expected_control_epoch)
                    .map_err(map_registry)?;
                let invalid = || {
                    RuntimeError::new(RuntimeErrorCode::InvalidRequest,"provider path input binding has invalid or changed generation; reprepare before dispatch")
                };
                let id = request
                    .generation_id
                    .strip_prefix("grant-")
                    .ok_or_else(invalid)?;
                uuid::Uuid::parse_str(id).map_err(|_| invalid())?;
                let mut bindings = self
                    .provider_path_inputs
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                bindings.retain(|_, (_, expires)| {
                    expires.is_none_or(|expires| expires > Instant::now())
                });
                let key = (request.soul_id, request.generation_id);
                if request.inputs.is_empty() {
                    bindings.remove(&key);
                } else if let Some((prior, _)) = bindings.get(&key) {
                    if prior != &request.inputs {
                        return Err(invalid());
                    }
                } else {
                    if bindings
                        .iter()
                        .any(|((soul, _), (_, expires))| *soul == key.0 && expires.is_some())
                    {
                        return Err(invalid());
                    }
                    bindings.insert(
                        key,
                        (
                            request.inputs,
                            Some(Instant::now() + Duration::from_secs(600)),
                        ),
                    );
                }
                Ok(AdminResult::ProviderPathInputsBound)
            }
            AdminCommand::NativeAuthLookup(request) => {
                self.registry
                    .assert_epoch(request.expected_control_epoch)
                    .map_err(map_registry)?;
                self.lookup_native_auth(request)
                    .await
                    .map(AdminResult::NativeAuthLookup)
            }
            AdminCommand::ObserveClaudeSources(request) => {
                self.registry
                    .assert_epoch(request.expected_control_epoch)
                    .map_err(map_registry)?;
                self.observe_claude_sources(*request)
                    .await
                    .map(AdminResult::ClaudeSourceObservation)
            }
            AdminCommand::Health => Ok(AdminResult::Health {
                control_epoch: self.registry.control_epoch(),
                installation_id: self.registry.installation_id().clone(),
            }),
            AdminCommand::OpenCodeTransfer(action) => {
                let result = match action {
                    OpenCodeTransferAction::TargetInfo => OpenCodeTransferResult::TargetInfo {
                        image_ref: self.config.image_ref.clone(),
                        provider_schema: "opencode-1.18.21".into(),
                        build_receipt: freshell_runtime_protocol::opencode_target_build_receipt(
                            &self.config.image_ref,
                            "opencode-1.18.21",
                        ),
                    },
                    OpenCodeTransferAction::Begin {
                        descriptor,
                        attempt_id,
                    } => {
                        let _lifecycle_guard = self.opencode_transfer_lifecycle_lock.lock().await;
                        if descriptor.target_image_ref != self.config.image_ref {
                            return Err(RuntimeError::new(
                                RuntimeErrorCode::RecoveryWrongIdentity,
                                "OpenCode transfer target image does not match the supervisor runtime image",
                            ));
                        }
                        if self
                            .opencode_transfer_staging
                            .ready_registration_needs_reconciliation(&descriptor.transfer_id)
                            .map_err(map_opencode_transfer)?
                        {
                            let references = self
                                .registry
                                .opencode_transfer_stage_references()
                                .await
                                .map_err(map_registry)?;
                            self.opencode_transfer_staging
                                .reconcile_registering_ready(&references)
                                .map_err(map_opencode_transfer)?;
                        }
                        match self
                            .opencode_transfer_staging
                            .begin_from_filesystem(&descriptor, &attempt_id)
                            .map_err(map_opencode_transfer)?
                        {
                            crate::opencode_transfer::StagingStart::Started {
                                next_sequence,
                                file_offsets,
                            } => OpenCodeTransferResult::Started {
                                next_sequence,
                                file_offsets,
                            },
                            crate::opencode_transfer::StagingStart::Queued => {
                                OpenCodeTransferResult::Queued {
                                    transfer_id: descriptor.transfer_id,
                                }
                            }
                        }
                    }
                    OpenCodeTransferAction::WaitForCapacity {
                        transfer_id,
                        attempt_id,
                    } => match self
                        .opencode_transfer_staging
                        .wait_for_capacity(&transfer_id, &attempt_id)
                        .await
                        .map_err(map_opencode_transfer)?
                    {
                        crate::opencode_transfer::StagingStart::Started {
                            next_sequence,
                            file_offsets,
                        } => OpenCodeTransferResult::Started {
                            next_sequence,
                            file_offsets,
                        },
                        crate::opencode_transfer::StagingStart::Queued => {
                            return Err(RuntimeError::new(
                                RuntimeErrorCode::RegistryFailure,
                                "capacity wait returned before a queue entry was promoted",
                            ));
                        }
                    },
                    OpenCodeTransferAction::Chunk(chunk) => {
                        let sequence = chunk.sequence;
                        self.opencode_transfer_staging
                            .write_chunk(&chunk)
                            .map_err(map_opencode_transfer)?;
                        OpenCodeTransferResult::ChunkStored { sequence }
                    }
                    OpenCodeTransferAction::Finalize {
                        transfer_id,
                        attempt_id,
                    } => {
                        self.opencode_transfer_staging
                            .finalize(&transfer_id, &attempt_id)
                            .map_err(map_opencode_transfer)?;
                        OpenCodeTransferResult::Ready { transfer_id }
                    }
                    OpenCodeTransferAction::Abort {
                        transfer_id,
                        attempt_id,
                    } => {
                        let _lifecycle_guard = self.opencode_transfer_lifecycle_lock.lock().await;
                        let references = self
                            .registry
                            .opencode_transfer_stage_references()
                            .await
                            .map_err(map_registry)?;
                        let referenced_transfer_ids =
                            references.keys().cloned().collect::<HashSet<_>>();
                        self.opencode_transfer_staging
                            .abort_with_references(
                                &transfer_id,
                                &attempt_id,
                                &referenced_transfer_ids,
                            )
                            .map_err(map_opencode_transfer)?;
                        OpenCodeTransferResult::Aborted { transfer_id }
                    }
                };
                Ok(AdminResult::OpenCodeTransfer(result))
            }
            AdminCommand::Inventory => Ok(AdminResult::Inventory(
                self.registry.inventory().await.map_err(map_registry)?,
            )),
            AdminCommand::InventorySnapshot => Ok(AdminResult::InventorySnapshot(
                self.registry
                    .inventory_snapshot()
                    .await
                    .map_err(map_registry)?,
            )),
            AdminCommand::QualificationWriterClaim(request) => {
                Ok(AdminResult::QualificationWriterClaim(
                    crate::qualification_evidence::writer_claim_evidence(&self.registry, request)
                        .await
                        .map_err(map_registry)?,
                ))
            }
            AdminCommand::PendingViewProjections(request) => {
                self.registry
                    .assert_epoch(request.expected_control_epoch)
                    .map_err(map_registry)?;
                Ok(AdminResult::PendingViewProjections(
                    self.registry
                        .pending_view_projections(request.limit)
                        .await
                        .map_err(map_registry)?,
                ))
            }
            AdminCommand::AcknowledgeViewProjection(request) => {
                self.registry
                    .assert_epoch(request.expected_control_epoch)
                    .map_err(map_registry)?;
                self.registry
                    .acknowledge_view_projection(request.event_id)
                    .await
                    .map_err(map_registry)?;
                Ok(AdminResult::ViewProjectionAcknowledged)
            }
            AdminCommand::UpdateViewVisibility(request) => {
                self.registry
                    .assert_epoch(request.expected_control_epoch)
                    .map_err(map_registry)?;
                let view = self
                    .registry
                    .update_view_visibility(
                        request.view_id,
                        request.visibility,
                        request.expected_revision,
                        request.expected_soul_intent_revision,
                    )
                    .await
                    .map_err(map_registry)?;
                Ok(AdminResult::ViewIntent(view))
            }
            AdminCommand::UpsertViewIntent(request) => {
                self.registry
                    .assert_epoch(request.expected_control_epoch)
                    .map_err(map_registry)?;
                let view = self
                    .registry
                    .upsert_view_intent(request)
                    .await
                    .map_err(map_registry)?;
                Ok(AdminResult::ViewIntent(view))
            }
            AdminCommand::UpdateLimits(request) => {
                self.registry
                    .assert_epoch(request.expected_control_epoch)
                    .map_err(map_registry)?;
                let configured_limits = request.limits.validate()?;
                let view = self
                    .registry
                    .update_configured_limits(
                        request.soul_id,
                        configured_limits,
                        request.expected_intent_revision,
                    )
                    .await
                    .map_err(map_registry)?;
                Ok(AdminResult::UpdateLimits(UpdateLimitsResult {
                    effective_limits: view.effective_limits,
                    view,
                    application: LimitApplication::NextIncarnation,
                    configured_limits,
                }))
            }
            AdminCommand::PendingNotices(request) => {
                self.registry
                    .assert_epoch(request.expected_control_epoch)
                    .map_err(map_registry)?;
                Ok(AdminResult::PendingNotices(
                    self.registry
                        .pending_notices(request.profile_id, request.limit)
                        .await
                        .map_err(map_registry)?,
                ))
            }
            AdminCommand::NoticeReceipt(request) => {
                self.registry
                    .assert_epoch(request.expected_control_epoch)
                    .map_err(map_registry)?;
                self.registry
                    .record_notice_receipt(request.notice_id, request.profile_id, request.state)
                    .await
                    .map_err(map_registry)?;
                Ok(AdminResult::NoticeReceiptRecorded)
            }
            AdminCommand::IncidentSummary(request) => {
                self.registry
                    .assert_epoch(request.expected_control_epoch)
                    .map_err(map_registry)?;
                Ok(AdminResult::IncidentSummary(
                    self.registry
                        .loss_incident_summary(request.incident_id)
                        .await
                        .map_err(map_registry)?,
                ))
            }
            AdminCommand::PreflightLostSouls(request) => self
                .preflight_lost_souls(request)
                .await
                .map(AdminResult::PreflightLostSouls),
            AdminCommand::RestoreLostSouls(request) => {
                self.registry
                    .assert_epoch(request.expected_control_epoch)
                    .map_err(map_registry)?;
                request.validate_payload()?;
                self.restore_lost_souls(envelope.request_id, request)
                    .await
                    .map(AdminResult::RestoreLostSouls)
            }
            AdminCommand::MetricsSnapshot => Ok(AdminResult::MetricsSnapshot(
                self.registry
                    .runtime_metrics_snapshot()
                    .await
                    .map_err(map_registry)?,
            )),
            AdminCommand::MigrationPlan(request) => {
                let image_verified = self.config.image_ref.starts_with("sha256:")
                    && self.config.image_ref.len() == "sha256:".len() + 64;
                Ok(AdminResult::MigrationPlan(
                    self.registry
                        .plan_or_apply_migration(request, true, image_verified)
                        .await
                        .map_err(map_registry)?,
                ))
            }
            AdminCommand::RepairAudit(request) => Ok(AdminResult::RepairAudit(
                self.registry
                    .repair_audit(request)
                    .await
                    .map_err(map_registry)?,
            )),
            AdminCommand::Launch(request) => {
                self.registry
                    .assert_epoch(request.expected_control_epoch)
                    .map_err(map_registry)?;
                self.launch(envelope.request_id, *request)
                    .await
                    .map(AdminResult::Launch)
            }
            AdminCommand::Stop(request) => {
                self.registry
                    .assert_epoch(request.expected_control_epoch)
                    .map_err(map_registry)?;
                let (outcome, view) = self
                    .stop(request.soul_id, request.expected_intent_revision)
                    .await?;
                Ok(AdminResult::Stop { outcome, view })
            }
            AdminCommand::TerminalInput(request) => {
                self.registry
                    .assert_epoch(request.expected_control_epoch)
                    .map_err(map_registry)?;
                let state = self
                    .terminal_input(envelope.request_id, request.soul_id, request.data)
                    .await?;
                Ok(AdminResult::TerminalInput { state })
            }
            AdminCommand::TerminalResize(request) => {
                self.registry
                    .assert_epoch(request.expected_control_epoch)
                    .map_err(map_registry)?;
                self.terminal_resize(request.soul_id, request.cols, request.rows)
                    .await?;
                Ok(AdminResult::TerminalResize)
            }
            AdminCommand::TerminalReadOutput(request) => {
                self.registry
                    .assert_epoch(request.expected_control_epoch)
                    .map_err(map_registry)?;
                let output = self
                    .terminal_read_output(
                        request.soul_id,
                        request.after_seq,
                        request.max_bytes,
                        request.expected_stream_epoch,
                    )
                    .await?;
                Ok(AdminResult::TerminalOutput(output))
            }
            AdminCommand::FreshAgentSend(request) => {
                self.registry
                    .assert_epoch(request.expected_control_epoch)
                    .map_err(map_registry)?;
                let state = self
                    .fresh_agent_send(
                        envelope.request_id,
                        request.soul_id,
                        request.text,
                        request.settings,
                        request.checkpoint_logical_attempt_id,
                    )
                    .await?;
                Ok(AdminResult::FreshAgentCommand { state })
            }
            AdminCommand::FreshAgentFork(request) => {
                self.registry
                    .assert_epoch(request.expected_control_epoch)
                    .map_err(map_registry)?;
                let result = self
                    .fresh_agent_fork(
                        envelope.request_id,
                        request.soul_id,
                        request.parent_session_id,
                        request.input,
                    )
                    .await?;
                Ok(AdminResult::FreshAgentFork(result))
            }
            AdminCommand::FreshAgentCompact(request) => {
                self.registry
                    .assert_epoch(request.expected_control_epoch)
                    .map_err(map_registry)?;
                let state = self
                    .fresh_agent_compact(
                        envelope.request_id,
                        request.soul_id,
                        request.instructions,
                        request.cwd,
                    )
                    .await?;
                Ok(AdminResult::FreshAgentCommand { state })
            }
            AdminCommand::FreshAgentConfigure(request) => {
                self.registry
                    .assert_epoch(request.expected_control_epoch)
                    .map_err(map_registry)?;
                let state = self
                    .fresh_agent_configure(envelope.request_id, request.soul_id, request.settings)
                    .await?;
                Ok(AdminResult::FreshAgentCommand { state })
            }
            AdminCommand::FreshAgentRollback(request) => {
                self.registry
                    .assert_epoch(request.expected_control_epoch)
                    .map_err(map_registry)?;
                let state = self
                    .fresh_agent_rollback(envelope.request_id, request)
                    .await?;
                Ok(AdminResult::FreshAgentCommand { state })
            }
            AdminCommand::FreshAgentCapture(request) => {
                self.registry
                    .assert_epoch(request.expected_control_epoch)
                    .map_err(map_registry)?;
                Ok(AdminResult::FreshAgentCapture(
                    self.fresh_agent_capture(request.soul_id, request.max_bytes)
                        .await?,
                ))
            }
            AdminCommand::FreshAgentReadSnapshot(request) => {
                self.registry
                    .assert_epoch(request.expected_control_epoch)
                    .map_err(map_registry)?;
                Ok(AdminResult::FreshAgentSnapshot(
                    self.fresh_agent_snapshot(request.soul_id).await?,
                ))
            }
            AdminCommand::FreshAgentResolve(request) => {
                self.registry
                    .assert_epoch(request.expected_control_epoch)
                    .map_err(map_registry)?;
                let state = self
                    .fresh_agent_resolve(request.soul_id, request.decision_id, request.decision)
                    .await?;
                Ok(AdminResult::FreshAgentCommand { state })
            }
            AdminCommand::FreshAgentInterrupt(request) => {
                self.registry
                    .assert_epoch(request.expected_control_epoch)
                    .map_err(map_registry)?;
                self.fresh_agent_interrupt(request.soul_id).await?;
                Ok(AdminResult::FreshAgentInterrupted)
            }
            AdminCommand::FreshAgentPrepareNative(request) => {
                self.registry
                    .assert_epoch(request.expected_control_epoch)
                    .map_err(map_registry)?;
                self.fresh_agent_prepare_native(request.soul_id).await?;
                Ok(AdminResult::FreshAgentCommand {
                    state: CommandState::Completed,
                })
            }
            AdminCommand::FreshAgentReadHistory(request) => {
                self.registry
                    .assert_epoch(request.expected_control_epoch)
                    .map_err(map_registry)?;
                let context = self
                    .registry
                    .recovery_context(request.soul_id)
                    .await
                    .map_err(map_registry)?;
                let handle = &context.prior_handle;
                let agent = handle.fresh_agent().ok_or_else(|| {
                    RuntimeError::new(
                        RuntimeErrorCode::InvalidRequest,
                        "soul is not a fresh agent",
                    )
                })?;
                let native_id = context.native_session_id.as_deref().ok_or_else(|| {
                    RuntimeError::new(
                        RuntimeErrorCode::InvalidRequest,
                        "saved native session identity unavailable",
                    )
                })?;
                let mut snapshot = self
                    .backend
                    .read_native_history(
                        handle,
                        agent.provider.as_str(),
                        native_id,
                        &self.config.host_binary_path,
                    )
                    .await
                    .map_err(map_backend)?;
                // Kilroy uses the Claude transcript contract, with its own session type.
                let wire_provider =
                    if agent.provider == freshell_runtime_protocol::FreshProvider::Kilroy {
                        "claude"
                    } else {
                        agent.provider.as_str()
                    };
                if snapshot["threadId"].as_str() != Some(native_id)
                    || snapshot["provider"].as_str() != Some(wire_provider)
                {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::OwnershipMismatch,
                        "native history identity mismatch",
                    ));
                }
                // Presentation context comes from the persisted owned launch.
                // It does not assert provider identity, LIVE, or loss evidence.
                snapshot["managedDirectory"] = serde_json::json!({
                    "incarnationId": handle.incarnation_id(),
                    "cwd": agent.cwd,
                    "workspacePath": agent.workspace_path,
                    "gitCommonDir": agent.git_common_dir,
                    "sessionType": agent.session_type,
                });
                Ok(AdminResult::FreshAgentHistory(snapshot))
            }
            AdminCommand::FreshAgentReadEvents(request) => {
                self.registry
                    .assert_epoch(request.expected_control_epoch)
                    .map_err(map_registry)?;
                let events = self
                    .fresh_agent_read_events(
                        request.soul_id,
                        request.after_sequence,
                        request.max_events,
                    )
                    .await?;
                Ok(AdminResult::FreshAgentEvents(events))
            }
            AdminCommand::RuntimeMetrics(request) => {
                self.registry
                    .assert_epoch(request.expected_control_epoch)
                    .map_err(map_registry)?;
                let metrics = self.runtime_metrics(request.soul_id).await?;
                Ok(AdminResult::RuntimeMetrics(metrics))
            }
            AdminCommand::ProbeRecovery(request) => {
                self.registry
                    .assert_epoch(request.expected_control_epoch)
                    .map_err(map_registry)?;
                self.probe_recovery(request.soul_id)
                    .await
                    .map(AdminResult::RecoveryProbe)
            }
            AdminCommand::Recover(_) => {
                unreachable!("recovery is dispatched before the general command switch")
            }
        }
    }

    /// Register a recovery scope for nested lookups made inside one
    /// provider-preparation callback. It lives as long as the supervisor waits
    /// for that callback (`lifetime`) and is removed when the callback ends.
    fn auth_lookup_scope(
        &self,
        start: &crate::registry::RecoveryStart,
        lifetime: Duration,
    ) -> AuthLookupScope {
        let key = uuid::Uuid::new_v4().to_string();
        let mut authorities = self
            .auth_lookup_authorities
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        authorities.retain(|_, authority| authority.expires > Instant::now());
        authorities.insert(
            key.clone(),
            AuthLookupAuthority {
                start: start.clone(),
                expires: Instant::now() + lifetime,
            },
        );
        AuthLookupScope {
            authorities: self.auth_lookup_authorities.clone(),
            key,
        }
    }

    async fn lookup_native_auth(
        &self,
        request: freshell_runtime_protocol::NativeAuthLookupRequest,
    ) -> Result<freshell_runtime_protocol::NativeAuthValues, RuntimeError> {
        let denied = || {
            RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                "native auth lookup requires the current provider preparation attempt",
            )
        };
        freshell_platform::native_auth_exchange::validate_keys(&request.keys)
            .map_err(|_| denied())?;
        if request.attempt_authority.len() != 36 {
            return Err(denied());
        }
        if let Some((reservation, expected)) = self
            .registry
            .initial_input_reservation(request.soul_id.clone(), request.attempt_authority.clone())
            .await
            .map_err(map_registry)?
        {
            if reservation.provider != "opencode"
                || reservation.image_ref != self.config.image_ref
                || reservation.binary != self.config.host_binary_path
            {
                return Err(denied());
            }
            let observed = tokio::time::timeout(
                Duration::from_secs(10),
                self.backend.observe_initial_auth_volume(&reservation),
            )
            .await
            .map_err(|_| {
                RuntimeError::new(
                    RuntimeErrorCode::HostUnreachable,
                    "initial auth revalidation timed out",
                )
            })?
            .map_err(|_| {
                RuntimeError::new(
                    RuntimeErrorCode::HostUnreachable,
                    "initial auth source changed; reprepare before dispatch",
                )
            })?;
            if observed != expected
                || self
                    .registry
                    .initial_input_reservation(
                        request.soul_id.clone(),
                        request.attempt_authority.clone(),
                    )
                    .await
                    .map_err(map_registry)?
                    .is_none()
            {
                return Err(denied());
            }
            let values = match expected {
                freshell_runtime_protocol::InitialAuthVolumeObservation::Absent { .. } => {
                    std::collections::BTreeMap::new()
                }
                freshell_runtime_protocol::InitialAuthVolumeObservation::OwnedUndispatched {
                    incarnation_id,
                    ..
                } => {
                    // Preparation may already have installed a typed auth file
                    // before refusing the input selection. Read the exact owned
                    // quiescent store rather than inventing native-auth absence.
                    let lock = self.lifecycle_lock(&request.soul_id).await;
                    let _held = lock.lock().await;
                    if self
                        .registry
                        .initial_input_reservation(
                            request.soul_id.clone(),
                            request.attempt_authority.clone(),
                        )
                        .await
                        .map_err(map_registry)?
                        .is_none()
                    {
                        return Err(denied());
                    };
                    let prior = self
                        .registry
                        .owned_handle(incarnation_id)
                        .await
                        .map_err(map_registry)?;
                    let values = tokio::time::timeout(
                        Duration::from_secs(25),
                        self.backend.read_native_auth(
                            &prior,
                            &request.keys,
                            &self.config.host_binary_path,
                        ),
                    )
                    .await
                    .map_err(|_| {
                        RuntimeError::new(
                            RuntimeErrorCode::HostUnreachable,
                            "initial replan native auth lookup timed out",
                        )
                    })?
                    .map_err(|_| {
                        RuntimeError::new(
                            RuntimeErrorCode::HostUnreachable,
                            "initial replan native auth lookup unavailable",
                        )
                    })?;
                    if self
                        .registry
                        .initial_input_reservation(
                            request.soul_id.clone(),
                            request.attempt_authority.clone(),
                        )
                        .await
                        .map_err(map_registry)?
                        .is_none()
                    {
                        return Err(denied());
                    };
                    values
                }
            };
            return Ok(freshell_runtime_protocol::NativeAuthValues(values));
        }
        let authority = {
            let authorities = self
                .auth_lookup_authorities
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            authorities
                .get(&request.attempt_authority)
                .filter(|authority| authority.expires > Instant::now())
                .cloned()
                .ok_or_else(denied)?
        };
        if authority.start.context.soul_id != request.soul_id
            || authority.start.context.provider != "opencode"
            || !self
                .registry
                .validate_auth_lookup_attempt(authority.start.clone())
                .await
                .map_err(map_registry)?
        {
            return Err(denied());
        }
        // The recovery owner already holds the soul lock. This operation uses
        // its short-lived authority and drops the map/registry locks before IPC.
        let values = tokio::time::timeout(
            Duration::from_secs(25),
            self.backend.read_native_auth(
                &authority.start.context.prior_handle,
                &request.keys,
                &self.config.host_binary_path,
            ),
        )
        .await
        .map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::HostUnreachable,
                "native auth lookup timed out",
            )
        })?
        .map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::HostUnreachable,
                "native auth owned lookup failed",
            )
        })?;
        freshell_platform::native_auth_exchange::validate_selected(&request.keys, &values)
            .map_err(|_| denied())?;
        if !self
            .registry
            .validate_auth_lookup_attempt(authority.start)
            .await
            .map_err(map_registry)?
        {
            return Err(denied());
        }
        Ok(freshell_runtime_protocol::NativeAuthValues(values))
    }

    async fn launch(
        &self,
        request_id: RequestId,
        request: freshell_runtime_protocol::LaunchRequest,
    ) -> Result<LaunchResult, RuntimeError> {
        let lifecycle_lock = self.lifecycle_lock(&request.soul_id).await;
        let _guard = lifecycle_lock.lock().await;
        let limits = request.limits.validate()?;
        request.validate_workload()?;
        if !release_qualified_workload(
            &request.provider,
            request.fixture.is_some(),
            request.terminal.is_some(),
            request.fresh_agent.as_ref(),
        ) {
            return Err(RuntimeError::new(
                RuntimeErrorCode::UnsupportedWorkload,
                format!(
                    "provider {} is adapter-ready but not release-qualified for managed ownership",
                    request.provider
                ),
            ));
        }
        crate::limits::verify_profile(request.profile, limits).map_err(|message| {
            RuntimeError::new(RuntimeErrorCode::InvalidRuntimeLimits, message)
        })?;
        let payload_digest = semantic_launch_digest(&request)?;
        let transfer_claim = request.terminal.as_ref().and_then(|terminal| {
            terminal.opencode_transfer.as_ref().map(|descriptor| {
                (
                    descriptor.clone(),
                    terminal.opencode_transfer_attempt_id.clone(),
                )
            })
        });
        let transfer_claim_guard = if transfer_claim.is_some() {
            Some(self.opencode_transfer_lifecycle_lock.lock().await)
        } else {
            None
        };
        if let Some((descriptor, attempt_id)) = &transfer_claim {
            let attempt_id = attempt_id.as_deref().ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::InvalidRequest,
                    "OpenCode transfer launch has no staging attempt",
                )
            })?;
            let references = self
                .registry
                .opencode_transfer_stage_references()
                .await
                .map_err(map_registry)?;
            let already_referenced = self
                .opencode_transfer_staging
                .has_exact_registry_reference(&references, descriptor)
                .map_err(map_opencode_transfer)?;
            let staging = Arc::clone(&self.opencode_transfer_staging);
            let descriptor = descriptor.clone();
            let attempt_id = attempt_id.to_owned();
            tokio::task::spawn_blocking(move || {
                staging.mark_launch_registering(&descriptor, &attempt_id, already_referenced)
            })
            .await
            .map_err(|error| {
                RuntimeError::new(
                    RuntimeErrorCode::RegistryFailure,
                    format!("OpenCode launch-claim worker did not settle: {error}"),
                )
            })?
            .map_err(map_opencode_transfer)?;
        }

        let preparation = LaunchPreparation {
            soul_id: request.soul_id.clone(),
            provider: request.provider.clone(),
            provider_store_id: request.provider_store_id.clone(),
            native_session_id: request.native_session_id.clone(),
            creation_seed_ref: request.creation_seed_ref.clone(),
            request_id: request_id.clone(),
            payload_digest,
            requested_limits: limits,
            profile: request.profile,
            project_key: request.project_key.clone(),
            fixture: request.fixture,
            terminal: request.terminal.clone(),
            fresh_agent: request.fresh_agent.clone(),
            view_intent: request.view_intent.clone(),
            admission: self.config.admission,
        };
        let prepared = match self.registry.prepare_launch(preparation).await {
            Ok(prepared) => {
                if let Some((descriptor, attempt_id)) = &transfer_claim {
                    let attempt_id = attempt_id
                        .as_deref()
                        .expect("validated OpenCode transfer has a staging attempt");
                    let staging = Arc::clone(&self.opencode_transfer_staging);
                    let descriptor = descriptor.clone();
                    let attempt_id = attempt_id.to_owned();
                    tokio::task::spawn_blocking(move || {
                        staging.mark_launch_claimed(&descriptor, &attempt_id)
                    })
                    .await
                    .map_err(|error| {
                        RuntimeError::new(
                            RuntimeErrorCode::RegistryFailure,
                            format!("OpenCode registered-claim worker did not settle: {error}"),
                        )
                    })?
                    .map_err(map_opencode_transfer)?;
                }
                prepared
            }
            Err(error) => {
                if let Some((descriptor, attempt_id)) = &transfer_claim {
                    if let Some(attempt_id) = attempt_id.as_deref() {
                        if let Ok(references) =
                            self.registry.opencode_transfer_stage_references().await
                        {
                            let staging = Arc::clone(&self.opencode_transfer_staging);
                            let descriptor = descriptor.clone();
                            let attempt_id = attempt_id.to_owned();
                            if staging
                                .has_exact_registry_reference(&references, &descriptor)
                                .unwrap_or(false)
                            {
                                let _ = tokio::task::spawn_blocking(move || {
                                    staging.mark_launch_claimed(&descriptor, &attempt_id)
                                })
                                .await;
                            } else if !references.contains_key(&descriptor.transfer_id) {
                                let _ = tokio::task::spawn_blocking(move || {
                                    staging.restore_unregistered_pending(&descriptor, &attempt_id)
                                })
                                .await;
                            }
                        }
                    }
                }
                return Err(map_registry(error));
            }
        };
        drop(transfer_claim_guard);
        append_event(
            &self.config.lifecycle_log,
            "supervisor.launch_prepared",
            serde_json::json!({"soulId":prepared.soul_id,"incarnationId":prepared.incarnation_id,"existingRequest":prepared.existing_request,"state":prepared.state}),
        );
        crash_if("after_prepare");

        self.activate_prepared(
            prepared,
            LaunchWorkload {
                soul_id: request.soul_id,
                fixture: request.fixture,
                terminal: request.terminal,
                fresh_agent: request.fresh_agent,
                resume_spec: None,
            },
            limits,
        )
        .await
    }

    pub(crate) async fn activate_prepared(
        &self,
        prepared: PreparedLaunch,
        workload: LaunchWorkload,
        limits: RuntimeLimits,
    ) -> Result<LaunchResult, RuntimeError> {
        let fence = self
            .registry
            .recovery_write_fence(workload.soul_id.clone())
            .await
            .map_err(map_registry)?;
        self.activate_prepared_observed(prepared, workload, limits, fence)
            .await
            .map(|(result, _)| result)
    }

    pub(crate) fn activate_prepared_observed(
        &self,
        prepared: PreparedLaunch,
        workload: LaunchWorkload,
        limits: RuntimeLimits,
        fence: RecoveryWriteFence,
    ) -> impl std::future::Future<Output = Result<(LaunchResult, RecoveryWriteFence), RuntimeError>>
           + Send
           + '_ {
        // Construct the large activation state here so recovery callers only
        // retain the boxed future while polling host replies and registry I/O.
        Box::pin(self.activate_prepared_observed_inner(prepared, workload, limits, fence))
    }

    async fn activate_prepared_observed_inner(
        &self,
        prepared: PreparedLaunch,
        workload: LaunchWorkload,
        limits: RuntimeLimits,
        mut fence: RecoveryWriteFence,
    ) -> Result<(LaunchResult, RecoveryWriteFence), RuntimeError> {
        let mut state = prepared.state;
        if let Some(capability) = workload
            .terminal
            .as_ref()
            .and_then(|terminal| terminal.provider_launch_context.as_ref())
            .or_else(|| {
                workload
                    .fresh_agent
                    .as_ref()
                    .and_then(|agent| agent.provider_launch_context.as_ref())
            })
            .and_then(|context| context.mcp_capability.as_ref())
        {
            self.notify_mcp_capability(
                "activate",
                &capability.endpoint,
                &prepared.soul_id,
                &prepared.incarnation_id,
                &capability.grant_id,
            )
            .await
            .map_err(|error| {
                self.activation_failure(&prepared, state, "capability_pending", error)
            })?;
        }
        if state == LaunchState::Prepared {
            let runtime_dir = self.ensure_incarnation_dir(&prepared).map_err(|error| {
                self.activation_failure(&prepared, state, "ensure_runtime_directory", error)
            })?;
            let opencode_transfer_dir = workload
                .terminal
                .as_ref()
                .and_then(|terminal| terminal.opencode_transfer.as_ref())
                .map(|descriptor| {
                    self.opencode_transfer_staging
                        .verify_ready(descriptor)
                        .map_err(map_opencode_transfer)
                })
                .transpose()
                .map_err(|error| {
                    self.activation_failure(&prepared, state, "verify_opencode_transfer", error)
                })?;
            if workload.fresh_agent.is_some() {
                ensure_host_actor_state_dir(
                    &self.config.runtime_root,
                    self.registry.installation_id(),
                    &prepared.soul_id,
                )
                .map_err(|error| {
                    self.activation_failure(&prepared, state, "ensure_host_actor_directory", error)
                })?;
            }
            let created = self
                .backend
                .create_stopped(&CreateRuntimeSpec {
                    prior_provider_owner: self
                        .registry
                        .prior_provider_owner(prepared.incarnation_id.clone())
                        .await
                        .map_err(map_registry)?,
                    initial_input_reservation: self
                        .registry
                        .bound_input_reservation(prepared.incarnation_id.clone())
                        .await
                        .map_err(map_registry)
                        .map_err(|error| {
                            self.activation_failure(
                                &prepared,
                                state,
                                "revalidate_initial_provider_source",
                                error,
                            )
                        })?,
                    installation_id: self.registry.installation_id().clone(),
                    soul_id: prepared.soul_id.clone(),
                    incarnation_id: prepared.incarnation_id.clone(),
                    image_ref: self.config.image_ref.clone(),
                    host_binary_path: self.config.host_binary_path.clone(),
                    runtime_dir: runtime_dir.clone(),
                    limits,
                    test_run_id: self.config.test_run_id.clone(),
                    terminal: workload.terminal.clone(),
                    fresh_agent: workload.fresh_agent.clone(),
                    opencode_transfer_dir,
                    provider_volume_name: stable_provider_volume_name(
                        self.registry.installation_id(),
                        &prepared.soul_id,
                    ),
                })
                .await
                .map_err(|error| {
                    self.activation_failure_from_backend(
                        &prepared,
                        state,
                        "create_stopped_runtime",
                        error,
                    )
                })?;
            append_event(
                &self.config.lifecycle_log,
                "supervisor.container_created_stopped",
                serde_json::json!({"incarnationId":prepared.incarnation_id,"containerId":created.container_id,"daemonId":created.daemon_id}),
            );
            crash_if("after_docker_create");
            self.registry
                .commit_created(
                    prepared.incarnation_id.clone(),
                    BackendCreatedRecord {
                        daemon_id: created.daemon_id,
                        container_id: created.container_id,
                        image_ref: self.config.image_ref.clone(),
                        runtime_dir,
                        host_binary_path: self.config.host_binary_path.clone(),
                        immutable_config_digest: created.immutable_config_digest,
                        launch_policy: Some(
                            freshell_runtime_protocol::RuntimeLaunchPolicy::ProviderVolumeV1,
                        ),
                    },
                )
                .await
                .map_err(map_registry)
                .map_err(|error| {
                    self.activation_failure(&prepared, state, "commit_backend_identity", error)
                })?;
            state = LaunchState::Created;
            crash_if("after_created_commit");
        }

        let handle = self
            .registry
            .owned_handle(prepared.incarnation_id.clone())
            .await
            .map_err(map_registry)
            .map_err(|error| {
                self.activation_failure(&prepared, state, "load_owned_handle", error)
            })?;

        if state == LaunchState::Running {
            let authenticated = self
                .authenticate_host(handle.incarnation_id(), handle.runtime_dir())
                .await
                .map_err(|error| {
                    self.activation_failure(&prepared, state, "authenticate_running_host", error)
                })?;
            let status = self
                .host_status(
                    handle.incarnation_id().clone(),
                    handle.runtime_dir(),
                    &authenticated,
                )
                .await
                .map_err(|error| {
                    self.activation_failure(&prepared, state, "read_running_host_status", error)
                })?;
            self.complete_pending_provider_preparation(&handle).await?;
            return self
                .launch_result_from_status(
                    prepared.incarnation_id.clone(),
                    workload.soul_id.clone(),
                    authenticated,
                    status,
                    fence,
                )
                .await
                .map_err(|error| {
                    self.activation_failure(&prepared, state, "adopt_running_worker", error)
                });
        }
        if matches!(
            state,
            LaunchState::Stopping | LaunchState::Stopped | LaunchState::Failed
        ) {
            let error = RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                format!("launch request is bound to incarnation in state {state:?}"),
            );
            return Err(self.activation_failure(
                &prepared,
                state,
                "reject_terminal_lifecycle_state",
                error,
            ));
        }

        if state == LaunchState::Created {
            self.backend
                .start_host(&handle)
                .await
                .map_err(map_backend)
                .map_err(|error| {
                    self.activation_failure(&prepared, state, "start_session_host", error)
                })?;
            append_event(
                &self.config.lifecycle_log,
                "supervisor.host_started",
                serde_json::json!({"incarnationId":handle.incarnation_id(),"containerId":handle.container_id()}),
            );
            crash_if("after_host_start");
        }

        let authenticated = self
            .authenticate_host(handle.incarnation_id(), handle.runtime_dir())
            .await
            .map_err(|error| {
                self.activation_failure(&prepared, state, "authenticate_started_host", error)
            })?;
        crash_if("before_grant_commit");
        let grant = self
            .registry
            .commit_execution_grant(
                handle.incarnation_id().clone(),
                authenticated.host_boot_id.clone(),
                authenticated.effective_limits,
            )
            .await
            .map_err(map_registry)
            .map_err(|error| {
                self.activation_failure(&prepared, state, "commit_execution_grant", error)
            })?;
        state = LaunchState::Starting;
        crash_if("after_grant_commit");
        self.backend
            .enable_long_lived(&handle)
            .await
            .map_err(map_backend)
            .map_err(|error| {
                self.activation_failure(&prepared, state, "enable_long_lived_runtime", error)
            })?;
        // Grant delivery retains its own launch context while decoding replies.
        let grant_result =
            Box::pin(self.send_grant(&handle, &workload, &authenticated, &grant)).await;
        let mut accepted = match grant_result {
            Ok(accepted) => accepted,
            Err(error)
                if error.code == RuntimeErrorCode::ProviderInputsChanged
                    && workload.resume_spec.is_none() =>
            {
                // The typed refusal alone cannot authorize redispatch: verify
                // this exact boot has never crossed its durable grant fence.
                self.settle_rejected_initial_inputs(&handle, &authenticated, &grant)
                    .await?;
                return Err(self.activation_failure(
                    &prepared,
                    state,
                    "provider_inputs_changed_before_dispatch",
                    error,
                ));
            }
            Err(error) => {
                let codex_pre_worker_failure = match error.diagnostic_code {
                    Some(
                        freshell_runtime_protocol::RuntimeDiagnosticCode::CodexAppServerStartFailed,
                    ) => Some("CODEX_APP_SERVER_START_FAILED"),
                    Some(
                        freshell_runtime_protocol::RuntimeDiagnosticCode::CodexProxyStartFailed,
                    ) => Some("CODEX_PROXY_START_FAILED"),
                    Some(
                        freshell_runtime_protocol::RuntimeDiagnosticCode::FreshAgentProviderStartFailed,
                    ) if handle.fresh_agent().is_some_and(|agent| {
                        agent.provider == freshell_runtime_protocol::FreshProvider::Codex
                    }) => Some("FRESH_AGENT_PROVIDER_START_FAILED"),
                    _ => None,
                };
                if let Some(failure_reason) = codex_pre_worker_failure {
                    self.settle_known_codex_pre_worker_failure(
                        &prepared,
                        &handle,
                        &grant,
                        failure_reason,
                    )
                    .await;
                }
                return Err(self.activation_failure(
                    &prepared,
                    state,
                    "deliver_execution_grant",
                    error,
                ));
            }
        };
        let native_context = self
            .registry
            .recovery_context(workload.soul_id.clone())
            .await
            .map_err(map_registry)?;
        let requires_native_observation = workload.fixture.is_none()
            && matches!(
                native_context.provider.as_str(),
                "claude" | "kilroy" | "codex" | "opencode" | "amplifier"
            )
            && !workload.fresh_agent.as_ref().is_some_and(|agent| {
                crate::registry::deterministic_fresh_agent_fixture(&native_context.provider, agent)
            });
        if requires_native_observation {
            let wait = Box::pin(self.wait_for_native_startup(
                &workload,
                handle.incarnation_id(),
                &native_context,
                prepared.intent_revision,
            ))
            .await;
            let observed = match wait {
                crate::recovery::NativeIdentityWait::Observed {
                    native_session_id, ..
                } => native_session_id,
                crate::recovery::NativeIdentityWait::HostUnavailable {
                    transient: Some(_), ..
                } => {
                    return Err(self.activation_failure(
                        &prepared,
                        state,
                        "verify_native_startup",
                        RuntimeError::new(
                            RuntimeErrorCode::HostUnreachable,
                            "native startup host transport unavailable",
                        ),
                    ));
                }
                crate::recovery::NativeIdentityWait::StopIntent { .. }
                | crate::recovery::NativeIdentityWait::IntentChanged { .. } => {
                    return Err(self.activation_failure(
                        &prepared,
                        state,
                        "verify_native_startup",
                        RuntimeError::new(
                            RuntimeErrorCode::StaleIntentRevision,
                            "durable intent changed during native startup",
                        ),
                    ));
                }
                _ => {
                    return Err(self.activation_failure(
                        &prepared,
                        state,
                        "verify_native_startup",
                        RuntimeError::new(
                            RuntimeErrorCode::RecoveryBlocked,
                            "current native provider startup observation is unavailable",
                        ),
                    ))
                }
            };
            // Recheck the still-live current child before publication. This
            // path retains the original write fence; waiting does not publish
            // a root or adopt a newer revision on this activation's behalf.
            let current = self
                .registry
                .recovery_context(workload.soul_id.clone())
                .await
                .map_err(map_registry)?;
            let status = self
                .host_status(
                    handle.incarnation_id().clone(),
                    handle.runtime_dir(),
                    &authenticated,
                )
                .await?;
            let observation = crate::recovery::current_native_observation(&current, &status)
                .filter(|observation| !status.exited && observation.native_session_id == observed)
                .cloned()
                .ok_or_else(|| {
                    self.activation_failure(
                        &prepared,
                        state,
                        "verify_native_startup",
                        RuntimeError::new(
                            RuntimeErrorCode::RecoveryBlocked,
                            "current native provider changed during startup",
                        ),
                    )
                })?;
            accepted.native_session_id = Some(observed);
            accepted.native_identity_observation = Some(observation);
        }
        if let (Some(terminal), Some(receipt)) = (
            workload.terminal.as_ref(),
            accepted.opencode_transfer_receipt.as_ref(),
        ) {
            if let Some(descriptor) = terminal.opencode_transfer.as_ref() {
                let staging = Arc::clone(&self.opencode_transfer_staging);
                let descriptor = descriptor.clone();
                let transfer_id = descriptor.transfer_id.clone();
                let receipt = receipt.clone();
                if let Err(error) = tokio::task::spawn_blocking(move || {
                    staging.mark_release_eligible(&descriptor, &receipt)
                })
                .await
                .map_err(|error| {
                    RuntimeError::new(
                        RuntimeErrorCode::RegistryFailure,
                        format!("OpenCode stage marker worker did not settle: {error}"),
                    )
                })
                .and_then(|result| result.map_err(map_opencode_transfer))
                {
                    append_event(
                        &self.config.lifecycle_log,
                        "supervisor.opencode_transfer_release_marker_deferred",
                        serde_json::json!({"incarnationId":handle.incarnation_id(),"transferId":transfer_id,"error":error.message}),
                    );
                }
            }
        }
        crash_if("after_grant_delivery");
        if let Some(native_session_id) = accepted.native_session_id.as_ref() {
            fence = self
                .registry
                .record_native_session_fenced(
                    workload.soul_id.clone(),
                    handle.incarnation_id().clone(),
                    native_session_id.clone(),
                    fence,
                )
                .await
                .map_err(map_registry)
                .map_err(|error| {
                    self.activation_failure(&prepared, state, "record_native_identity", error)
                })?;
        }
        if let Some(observation) =
            accepted
                .native_identity_observation
                .as_ref()
                .filter(|observation| {
                    accepted.native_session_id.as_deref()
                        == Some(observation.native_session_id.as_str())
                })
        {
            self.registry
                .record_native_identity_observation(
                    workload.soul_id.clone(),
                    observation.clone(),
                    fence.clone(),
                )
                .await
                .map_err(map_registry)
                .map_err(|error| {
                    self.activation_failure(&prepared, state, "record_native_observation", error)
                })?;
        }
        fence = self
            .registry
            .mark_running_observed_with_provider_preparation(
                workload.soul_id.clone(),
                handle.incarnation_id().clone(),
                fence,
                workload.resume_spec.is_none(),
            )
            .await
            .map_err(map_registry)
            .map_err(|error| {
                self.activation_failure(&prepared, state, "commit_running_state", error)
            })?;
        if let Err(error) = self.cleanup_opencode_transfer_staging().await {
            append_event(
                &self.config.lifecycle_log,
                "supervisor.opencode_transfer_cleanup_deferred",
                serde_json::json!({"incarnationId":handle.incarnation_id(),"error":error.message}),
            );
        }
        if workload.resume_spec.is_none() {
            self.complete_pending_provider_preparation(&handle)
                .await
                .map_err(|error| {
                    self.activation_failure(&prepared, state, "commit_provider_inputs", error)
                })?;
        }
        append_event(
            &self.config.lifecycle_log,
            "supervisor.launch_running",
            serde_json::json!({"soulId":workload.soul_id,"incarnationId":handle.incarnation_id(),"containerId":handle.container_id(),"workerPid":accepted.worker_pid,"workerLaunchCount":accepted.worker_launch_count}),
        );
        let view = find_view(&self.registry, handle.incarnation_id())
            .await
            .map_err(|error| {
                self.activation_failure(&prepared, state, "load_running_view", error)
            })?;
        Ok((
            LaunchResult {
                view,
                worker_pid: accepted.worker_pid,
                worker_launch_count: accepted.worker_launch_count,
                host_boot_id: accepted.host_boot_id,
                effective_limits: authenticated.effective_limits,
                fixture_evidence: accepted.fixture_evidence,
            },
            fence,
        ))
    }

    async fn settle_rejected_initial_inputs(
        &self,
        handle: &crate::registry::OwnedRuntimeHandle,
        host: &AuthenticatedHost,
        grant: &crate::registry::ExecutionGrantRecord,
    ) -> Result<(), RuntimeError> {
        let unavailable = || {
            RuntimeError::new(
                RuntimeErrorCode::HostUnreachable,
                "initial provider input rejection is unconfirmed; retain ownership and reconcile",
            )
        };
        self.registry
            .validate_rejected_initial_inputs(handle.incarnation_id().clone())
            .await
            .map_err(|_| unavailable())?;
        let status = self
            .send_authenticated_host_command(
                handle.incarnation_id().clone(),
                handle.runtime_dir(),
                host,
                HostCommand::Status {
                    incarnation_id: handle.incarnation_id().clone(),
                },
            )
            .await
            .map_err(|_| unavailable())?;
        let never_dispatched = matches!(
            status,
            HostResult::Status {
                host_boot_id,
                worker_pid: None,
                worker_launch_count: 0,
                max_execution_generation,
                native_session_id: None,
                ..
            } if host_boot_id == grant.host_boot_id
                && max_execution_generation < grant.execution_generation
        );
        if !never_dispatched {
            return Err(unavailable());
        }
        self.backend
            .request_stop(handle, 2)
            .await
            .map_err(|_| unavailable())?;
        if !self
            .verify_empty_with_budget(handle, Duration::from_secs(3))
            .await
            .map_err(|_| unavailable())?
        {
            return Err(unavailable());
        };
        Box::pin(self.await_running_startup(
            handle.soul_id(),
            "rejected_provider_inputs_cleanup",
            self.backend.discard_stopped_provider_inputs(handle),
        ))
        .await?
        .map_err(|_| unavailable())?;
        self.registry
            .settle_rejected_initial_inputs(handle.incarnation_id().clone())
            .await
            .map_err(|_| unavailable())?;
        append_event(
            &self.config.lifecycle_log,
            "supervisor.provider_inputs.initial_replan_ready",
            serde_json::json!({"severity":"info","soulId":handle.soul_id(),"incarnationId":handle.incarnation_id(),"operation":"settle_unconsumed_generation"}),
        );
        Ok(())
    }

    fn activation_failure(
        &self,
        prepared: &PreparedLaunch,
        state: LaunchState,
        stage: &'static str,
        error: RuntimeError,
    ) -> RuntimeError {
        self.record_activation_failure(prepared, state, stage, error, None)
    }

    fn activation_failure_from_backend(
        &self,
        prepared: &PreparedLaunch,
        state: LaunchState,
        stage: &'static str,
        error: BackendError,
    ) -> RuntimeError {
        let diagnostic = backend_failure_diagnostic(&error);
        self.record_activation_failure(prepared, state, stage, map_backend(error), Some(diagnostic))
    }

    fn record_activation_failure(
        &self,
        prepared: &PreparedLaunch,
        state: LaunchState,
        stage: &'static str,
        error: RuntimeError,
        backend_failure: Option<serde_json::Value>,
    ) -> RuntimeError {
        let mut data = activation_failure_data(prepared, state, stage, &error);
        if let Some(backend_failure) = backend_failure {
            data["backendFailure"] = backend_failure;
        }
        append_event(
            &self.config.lifecycle_log,
            "supervisor.activation_failed",
            data,
        );
        error
    }

    async fn settle_known_codex_pre_worker_failure(
        &self,
        prepared: &PreparedLaunch,
        handle: &crate::registry::OwnedRuntimeHandle,
        grant: &ExecutionGrantRecord,
        failure_reason: &'static str,
    ) {
        let codex_workload = handle
            .terminal()
            .is_some_and(|terminal| terminal.mode == "codex")
            || handle.fresh_agent().is_some_and(|agent| {
                agent.provider == freshell_runtime_protocol::FreshProvider::Codex
            });
        if !codex_workload || !self.stop_and_verify_empty_codex_runtime(handle).await {
            return;
        }

        match self
            .registry
            .fail_codex_pre_worker_start(handle.clone(), prepared.intent_revision, grant.clone())
            .await
        {
            Ok(()) => append_event(
                &self.config.lifecycle_log,
                "supervisor.codex_pre_worker_failure_settled",
                serde_json::json!({
                    "severity":"info",
                    "soulId":handle.soul_id(),
                    "incarnationId":handle.incarnation_id(),
                    "intentRevision":prepared.intent_revision,
                    "executionGeneration":grant.execution_generation,
                    "controlEpoch":grant.control_epoch,
                    "failureReason":failure_reason,
                    "cleanup":"verified_empty",
                }),
            ),
            Err(error) => {
                let registry_error = map_registry(error);
                append_event(
                    &self.config.lifecycle_log,
                    "supervisor.codex_pre_worker_failure_settlement_deferred",
                    serde_json::json!({
                        "severity":"warning",
                        "soulId":handle.soul_id(),
                        "incarnationId":handle.incarnation_id(),
                        "intentRevision":prepared.intent_revision,
                        "executionGeneration":grant.execution_generation,
                        "controlEpoch":grant.control_epoch,
                        "reason":"registry_fence_changed",
                        "errorCode":registry_error.code,
                        "cleanup":"verified_empty",
                    }),
                );
            }
        }
    }

    /// A classified Codex pre-worker provider-start failure is emitted before
    /// the worker can be trusted to exist. Reclaim only that incarnation's
    /// exact owned container, and only after a backend inspection proves it
    /// empty. Docker stop/kill applies to every helper in that container too.
    async fn stop_and_verify_empty_codex_runtime(
        &self,
        handle: &crate::registry::OwnedRuntimeHandle,
    ) -> bool {
        let initial = self
            .verify_empty_before_classified(handle, Instant::now() + Duration::from_secs(3))
            .await;
        match initial {
            Ok(true) => return true,
            Ok(false) => {}
            Err(failure) => {
                self.codex_cleanup_stage_failed(handle, "initial_empty_inspection", &failure);
                return false;
            }
        }

        match tokio::time::timeout(Duration::from_secs(3), self.backend.request_stop(handle, 2))
            .await
        {
            Ok(Ok(())) => {}
            Ok(Err(error)) => self.codex_cleanup_stage_failed(
                handle,
                "graceful_stop",
                &ClassifiedFailure::backend(error),
            ),
            Err(_) => self.codex_cleanup_stage_failed(
                handle,
                "graceful_stop",
                &ClassifiedFailure::timeout(RuntimeError::new(
                    RuntimeErrorCode::BackendUnavailable,
                    "Codex pre-worker cleanup stop timed out",
                )),
            ),
        }

        match self
            .verify_empty_with_budget_classified(handle, Duration::from_secs(3))
            .await
        {
            Ok(true) => return true,
            Ok(false) => {}
            Err(failure) => {
                self.codex_cleanup_stage_failed(handle, "graceful_empty_inspection", &failure);
            }
        }

        match tokio::time::timeout(Duration::from_secs(3), self.backend.force_stop(handle)).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => self.codex_cleanup_stage_failed(
                handle,
                "force_stop",
                &ClassifiedFailure::backend(error),
            ),
            Err(_) => self.codex_cleanup_stage_failed(
                handle,
                "force_stop",
                &ClassifiedFailure::timeout(RuntimeError::new(
                    RuntimeErrorCode::BackendUnavailable,
                    "Codex pre-worker cleanup force stop timed out",
                )),
            ),
        }

        match self
            .verify_empty_with_budget_classified(handle, Duration::from_secs(3))
            .await
        {
            Ok(true) => true,
            Ok(false) => {
                self.codex_cleanup_stage_failed(
                    handle,
                    "force_empty_inspection",
                    &ClassifiedFailure {
                        error: RuntimeError::new(
                            RuntimeErrorCode::BackendUnavailable,
                            "runtime remained active after exact cleanup",
                        ),
                        category: "not_empty",
                        http_status: None,
                    },
                );
                false
            }
            Err(failure) => {
                self.codex_cleanup_stage_failed(handle, "force_empty_inspection", &failure);
                false
            }
        }
    }

    fn codex_cleanup_stage_failed(
        &self,
        handle: &crate::registry::OwnedRuntimeHandle,
        stage: &str,
        failure: &ClassifiedFailure,
    ) {
        append_event(
            &self.config.lifecycle_log,
            "supervisor.codex_pre_worker_cleanup_stage_failed",
            serde_json::json!({
                "severity":"warning",
                "soulId":handle.soul_id(),
                "incarnationId":handle.incarnation_id(),
                "stage":stage,
                "errorCategory":failure.category,
                "errorCode":failure.error.code,
                "httpStatus":failure.http_status,
            }),
        );
    }

    async fn terminal_input(
        &self,
        request_id: RequestId,
        soul_id: SoulId,
        data: String,
    ) -> Result<CommandState, RuntimeError> {
        if data.len() > freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES / 2 {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                "terminal input exceeds control-frame budget",
            ));
        }
        // Input dispatch and recovery are mutually exclusive.  The registry
        // journal is committed before host IPC so a response loss becomes an
        // explicit AMBIGUOUS outcome rather than an automatic prompt resend.
        let lifecycle_lock = self.lifecycle_lock(&soul_id).await;
        let _lifecycle_guard = lifecycle_lock.lock().await;
        let (disposition, incarnation_id) = self
            .registry
            .begin_input(soul_id.clone(), request_id.clone(), data.as_bytes(), None)
            .await
            .map_err(map_registry)?;
        match disposition {
            InputJournalDisposition::Completed => return Ok(CommandState::Completed),
            InputJournalDisposition::Ambiguous => return Ok(CommandState::Ambiguous),
            InputJournalDisposition::Dispatch => {}
        }
        let handle = self
            .registry
            .owned_handle(incarnation_id)
            .await
            .map_err(map_registry)?;
        self.registry
            .mark_input_dispatching(soul_id.clone(), request_id.clone())
            .await
            .map_err(map_registry)?;
        let host = match self
            .authenticate_host(handle.incarnation_id(), handle.runtime_dir())
            .await
        {
            Ok(host) => host,
            Err(error) => {
                self.registry
                    .mark_input_ambiguous(soul_id, request_id)
                    .await
                    .map_err(map_registry)?;
                return Err(error);
            }
        };
        let response = self
            .send_authenticated_host_command(
                handle.incarnation_id().clone(),
                handle.runtime_dir(),
                &host,
                HostCommand::TerminalInput {
                    incarnation_id: handle.incarnation_id().clone(),
                    request_id: request_id.clone(),
                    data,
                },
            )
            .await;
        match response {
            Ok(HostResult::TerminalInput {
                state: CommandState::Completed,
            }) => {
                self.registry
                    .mark_input_completed(soul_id, request_id)
                    .await
                    .map_err(map_registry)?;
                Ok(CommandState::Completed)
            }
            Ok(HostResult::TerminalInput { state }) => {
                self.registry
                    .mark_input_ambiguous(soul_id, request_id)
                    .await
                    .map_err(map_registry)?;
                Ok(state)
            }
            Ok(_) => {
                self.registry
                    .mark_input_ambiguous(soul_id, request_id)
                    .await
                    .map_err(map_registry)?;
                Err(RuntimeError::new(
                    RuntimeErrorCode::HostAuthenticationFailed,
                    "unexpected terminal input reply",
                ))
            }
            Err(error) => {
                self.registry
                    .mark_input_ambiguous(soul_id, request_id)
                    .await
                    .map_err(map_registry)?;
                Err(error)
            }
        }
    }

    async fn terminal_resize(
        &self,
        soul_id: SoulId,
        cols: u16,
        rows: u16,
    ) -> Result<(), RuntimeError> {
        let handle = self
            .registry
            .active_handle_for_soul(soul_id)
            .await
            .map_err(map_registry)?;
        let host = self
            .authenticate_host(handle.incarnation_id(), handle.runtime_dir())
            .await?;
        match self
            .send_authenticated_host_command(
                handle.incarnation_id().clone(),
                handle.runtime_dir(),
                &host,
                HostCommand::TerminalResize {
                    incarnation_id: handle.incarnation_id().clone(),
                    cols,
                    rows,
                },
            )
            .await?
        {
            HostResult::TerminalResize => Ok(()),
            _ => Err(RuntimeError::new(
                RuntimeErrorCode::HostAuthenticationFailed,
                "unexpected terminal resize reply",
            )),
        }
    }

    async fn fresh_agent_send(
        &self,
        request_id: RequestId,
        soul_id: SoulId,
        text: String,
        settings: Option<freshell_runtime_protocol::FreshAgentTurnSettings>,
        checkpoint_logical_attempt_id: Option<String>,
    ) -> Result<CommandState, RuntimeError> {
        if text.len() > freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES / 2 {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                "fresh-agent input exceeds control-frame budget",
            ));
        }
        let lifecycle_lock = self.lifecycle_lock(&soul_id).await;
        let _lifecycle_guard = lifecycle_lock.lock().await;
        let settings_correlation = match checkpoint_logical_attempt_id.as_deref() {
            Some(logical_attempt_id) => {
                serde_json::to_vec(&(settings.as_ref(), logical_attempt_id))
            }
            None => serde_json::to_vec(&settings),
        }
        .map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                "fresh-agent settings could not be correlated",
            )
        })?;
        match self
            .registry
            .recorded_input_outcome(
                soul_id.clone(),
                request_id.clone(),
                text.as_bytes(),
                Some(&settings_correlation),
            )
            .await
            .map_err(map_registry)?
        {
            Some(InputJournalDisposition::Completed) => return Ok(CommandState::Completed),
            Some(InputJournalDisposition::Ambiguous) => return Ok(CommandState::Ambiguous),
            Some(InputJournalDisposition::Dispatch) | None => {}
        }
        let active = self
            .registry
            .active_handle_for_soul(soul_id.clone())
            .await
            .map_err(map_registry)?;
        if active.fresh_agent().is_none() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::UnsupportedWorkload,
                "soul is not a hosted fresh-agent",
            ));
        }
        let host = self
            .authenticate_current_fresh_host(&soul_id, &active)
            .await?;
        let (disposition, incarnation_id) = self
            .registry
            .begin_fresh_input(
                soul_id.clone(),
                request_id.clone(),
                text.as_bytes(),
                &settings_correlation,
                settings.clone(),
            )
            .await
            .map_err(map_registry)?;
        match disposition {
            InputJournalDisposition::Completed => return Ok(CommandState::Completed),
            InputJournalDisposition::Ambiguous => return Ok(CommandState::Ambiguous),
            InputJournalDisposition::Dispatch => {}
        }
        let handle = self
            .registry
            .owned_handle(incarnation_id)
            .await
            .map_err(map_registry)?;
        self.registry
            .mark_input_dispatching(soul_id.clone(), request_id.clone())
            .await
            .map_err(map_registry)?;
        let fence = self
            .registry
            .recovery_write_fence(soul_id.clone())
            .await
            .map_err(map_registry)?;
        let response = self
            .send_authenticated_host_command(
                handle.incarnation_id().clone(),
                handle.runtime_dir(),
                &host,
                HostCommand::FreshAgentSend {
                    incarnation_id: handle.incarnation_id().clone(),
                    request_id: request_id.clone(),
                    text,
                    settings,
                    checkpoint_logical_attempt_id,
                },
            )
            .await;
        match response {
            Ok(HostResult::FreshAgentCommand {
                state: CommandState::ProviderAcked | CommandState::Completed,
                native_session_id,
                ..
            }) => {
                if let Some(native_session_id) = native_session_id {
                    self.registry
                        .record_native_session_fenced(
                            soul_id.clone(),
                            handle.incarnation_id().clone(),
                            native_session_id,
                            fence,
                        )
                        .await
                        .map_err(map_registry)?;
                }
                self.registry
                    .mark_input_completed(soul_id, request_id)
                    .await
                    .map_err(map_registry)?;
                Ok(CommandState::ProviderAcked)
            }
            Ok(HostResult::FreshAgentCommand { state, .. }) => {
                self.registry
                    .mark_input_ambiguous(soul_id, request_id)
                    .await
                    .map_err(map_registry)?;
                Ok(state)
            }
            Ok(_) => {
                self.registry
                    .mark_input_ambiguous(soul_id, request_id)
                    .await
                    .map_err(map_registry)?;
                Err(RuntimeError::new(
                    RuntimeErrorCode::HostAuthenticationFailed,
                    "unexpected fresh-agent command reply",
                ))
            }
            Err(error) => {
                self.registry
                    .mark_input_ambiguous(soul_id, request_id)
                    .await
                    .map_err(map_registry)?;
                Err(error)
            }
        }
    }

    async fn authenticate_current_fresh_host(
        &self,
        soul_id: &SoulId,
        active: &crate::registry::OwnedRuntimeHandle,
    ) -> Result<AuthenticatedHost, RuntimeError> {
        let host = self
            .authenticate_host(active.incarnation_id(), active.runtime_dir())
            .await?;
        let mut status = self
            .host_status(active.incarnation_id().clone(), active.runtime_dir(), &host)
            .await?;
        let mut current = self
            .registry
            .recovery_context(soul_id.clone())
            .await
            .map_err(map_registry)?;
        let fixture = current.fresh_agent.as_ref().is_some_and(|agent| {
            crate::registry::deterministic_fresh_agent_fixture(&current.provider, agent)
        });
        let can_prepare = !fixture
            && matches!(current.provider.as_str(), "claude" | "kilroy")
            && current.desired_state == freshell_runtime_protocol::DesiredState::Running
            && current.prior_handle.incarnation_id() == active.incarnation_id()
            && current.native_session_id.is_some()
            && status
                .native_session_id
                .as_ref()
                .is_none_or(|root| Some(root) == current.native_session_id.as_ref())
            && current
                .native_identity_launch
                .as_ref()
                .is_some_and(|launch| {
                    launch.incarnation_id == *active.incarnation_id()
                        && launch.launch_nonce == active.launch_nonce().as_str()
                        && launch.execution_generation == status.max_execution_generation
                })
            && [
                "native-identity-observation-v1",
                "fresh-agent-native-readiness-v1",
            ]
            .iter()
            .all(|required| {
                host.capabilities
                    .iter()
                    .any(|capability| capability == required)
            });
        if can_prepare
            && (status.exited
                || crate::recovery::current_native_observation(&current, &status).is_none())
        {
            let before = current.write_fence();
            let result = self
                .await_running_startup(
                    soul_id,
                    "prepare_fresh_native_readiness",
                    self.send_authenticated_host_command(
                        active.incarnation_id().clone(),
                        active.runtime_dir(),
                        &host,
                        HostCommand::FreshAgentPrepareNative {
                            incarnation_id: active.incarnation_id().clone(),
                        },
                    ),
                )
                .await??;
            if !matches!(
                result,
                HostResult::FreshAgentCommand {
                    state: CommandState::Completed | CommandState::ProviderAcked,
                    ..
                }
            ) {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::HostAuthenticationFailed,
                    "unexpected fresh-agent native readiness reply",
                ));
            }
            status = self
                .host_status(active.incarnation_id().clone(), active.runtime_dir(), &host)
                .await?;
            current = self
                .registry
                .recovery_context(soul_id.clone())
                .await
                .map_err(map_registry)?;
            if current.write_fence() != before {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::StaleIntentRevision,
                    "fresh-agent owner or intent changed during native readiness",
                ));
            }
        }
        if current.desired_state != freshell_runtime_protocol::DesiredState::Running
            || current.prior_handle.incarnation_id() != active.incarnation_id()
            || status.exited
            || (!fixture
                && (!host
                    .capabilities
                    .iter()
                    .any(|capability| capability == "native-identity-observation-v1")
                    || crate::recovery::current_native_observation(&current, &status).is_none()))
        {
            append_event(
                &self.config.lifecycle_log,
                "fresh_agent.input_native_identity_unsettled",
                serde_json::json!({"severity":"warn","soulId":soul_id,"incarnationId":active.incarnation_id()}),
            );
            return Err(RuntimeError::new(
                RuntimeErrorCode::RecoveryBlocked,
                "fresh-agent input requires the current committed native identity",
            ));
        }
        Ok(host)
    }

    async fn fresh_agent_prepare_native(&self, soul_id: SoulId) -> Result<(), RuntimeError> {
        let lifecycle_lock = self.lifecycle_lock(&soul_id).await;
        let _guard = lifecycle_lock.lock().await;
        let active = self
            .registry
            .active_handle_for_soul(soul_id.clone())
            .await
            .map_err(map_registry)?;
        if active.fresh_agent().is_none() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::UnsupportedWorkload,
                "soul is not a hosted fresh-agent",
            ));
        }
        self.authenticate_current_fresh_host(&soul_id, &active)
            .await?;
        Ok(())
    }

    async fn fresh_agent_fork(
        &self,
        request_id: RequestId,
        soul_id: SoulId,
        presentation_parent_session_id: String,
        input: Option<serde_json::Value>,
    ) -> Result<freshell_runtime_protocol::FreshAgentForkResult, RuntimeError> {
        let lifecycle_lock = self.lifecycle_lock(&soul_id).await;
        let _lifecycle_guard = lifecycle_lock.lock().await;
        let context = self
            .registry
            .recovery_context(soul_id.clone())
            .await
            .map_err(map_registry)?;
        let parent_native = context.native_session_id.clone().ok_or_else(|| {
            RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                "fresh-agent native identity is not materialized",
            )
        })?;
        let fence = context.write_fence();
        let handle = context.prior_handle;
        if handle.fresh_agent().is_none() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::UnsupportedWorkload,
                "soul is not a hosted fresh-agent",
            ));
        }
        let host = self
            .authenticate_host(handle.incarnation_id(), handle.runtime_dir())
            .await?;
        let transition = match self
            .send_authenticated_host_command(
                handle.incarnation_id().clone(),
                handle.runtime_dir(),
                &host,
                HostCommand::FreshAgentFork {
                    incarnation_id: handle.incarnation_id().clone(),
                    request_id,
                    parent_session_id: parent_native.clone(),
                    input,
                },
            )
            .await?
        {
            HostResult::FreshAgentFork(result) => result,
            _ => {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::HostAuthenticationFailed,
                    "unexpected fresh-agent fork reply",
                ))
            }
        };
        let already_applied = classify_fresh_agent_fork_transition(&parent_native, &transition)?;
        if !already_applied {
            self.registry
                .transition_native_session_with_claude_fork_fenced(
                    soul_id.clone(),
                    handle.incarnation_id().clone(),
                    &parent_native,
                    &transition.child_session_id,
                    fence,
                    transition.claude_fork.clone(),
                )
                .await
                .map_err(map_registry)?;
        }
        // Re-materialize exact resume evidence for the child immediately. A
        // successful fork never leaves the soul recoverable only as its parent.
        self.observe_fresh_native_transition(
            &soul_id,
            handle.incarnation_id(),
            context.intent_revision,
        )
        .await?;
        let _ = self.probe_recovery_locked(soul_id).await;
        Ok(freshell_runtime_protocol::FreshAgentForkResult {
            claude_fork: None,
            parent_session_id: presentation_parent_session_id,
            child_session_id: transition.child_session_id,
            parent_retired_by_runtime: true,
        })
    }

    async fn observe_fresh_native_transition(
        &self,
        soul_id: &SoulId,
        incarnation_id: &IncarnationId,
        intent_revision: u64,
    ) -> Result<(), RuntimeError> {
        use crate::recovery::NativeIdentityWait;
        let wait = self
            .wait_for_native_identity(
                soul_id,
                incarnation_id,
                intent_revision,
                crate::recovery::native_identity_wait_timeout(false),
                true,
            )
            .await;
        match wait {
            NativeIdentityWait::Observed { .. } => Ok(()),
            NativeIdentityWait::StopIntent { .. } | NativeIdentityWait::IntentChanged { .. } => {
                Err(RuntimeError::new(
                    RuntimeErrorCode::StaleIntentRevision,
                    "durable intent changed during native root transition",
                ))
            }
            _ => Err(RuntimeError::new(
                RuntimeErrorCode::RecoveryBlocked,
                "current native child observation is unavailable after the acknowledged transition",
            )),
        }
    }

    async fn fresh_agent_compact(
        &self,
        request_id: RequestId,
        soul_id: SoulId,
        instructions: Option<String>,
        cwd: Option<String>,
    ) -> Result<CommandState, RuntimeError> {
        let lifecycle_lock = self.lifecycle_lock(&soul_id).await;
        let _lifecycle_guard = lifecycle_lock.lock().await;
        let handle = self
            .registry
            .active_handle_for_soul(soul_id.clone())
            .await
            .map_err(map_registry)?;
        if handle.fresh_agent().is_none() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::UnsupportedWorkload,
                "soul is not a hosted fresh-agent",
            ));
        }
        let host = self
            .authenticate_current_fresh_host(&soul_id, &handle)
            .await?;
        let context = self
            .registry
            .recovery_context(soul_id.clone())
            .await
            .map_err(map_registry)?;
        let fence = context
            .write_fence()
            .for_incarnation(handle.incarnation_id().clone());
        self.registry
            .disable_claude_fork_recovery_fenced(soul_id.clone(), fence)
            .await
            .map_err(map_registry)?;
        match self
            .send_authenticated_host_command(
                handle.incarnation_id().clone(),
                handle.runtime_dir(),
                &host,
                HostCommand::FreshAgentCompact {
                    incarnation_id: handle.incarnation_id().clone(),
                    request_id,
                    instructions,
                    cwd,
                },
            )
            .await?
        {
            HostResult::FreshAgentCommand {
                state,
                native_session_id,
                claude_fork,
            } => {
                self.commit_fresh_native_operation(&context, &host, native_session_id, claude_fork)
                    .await?;
                Ok(state)
            }
            _ => Err(RuntimeError::new(
                RuntimeErrorCode::HostAuthenticationFailed,
                "unexpected fresh-agent compact reply",
            )),
        }
    }

    /// Persists the settings as the soul's recovery profile, then asks the
    /// owning host to persist and apply them live, so a recovered incarnation
    /// launches with exactly the profile the host actor holds. The host is
    /// authenticated first: a host that is already gone never saves the
    /// configure, so the recovery profile must not save it either.
    async fn fresh_agent_configure(
        &self,
        request_id: RequestId,
        soul_id: SoulId,
        settings: freshell_runtime_protocol::FreshAgentTurnSettings,
    ) -> Result<CommandState, RuntimeError> {
        let lifecycle_lock = self.lifecycle_lock(&soul_id).await;
        let _lifecycle_guard = lifecycle_lock.lock().await;
        let handle = self
            .registry
            .active_handle_for_soul(soul_id.clone())
            .await
            .map_err(map_registry)?;
        if handle.fresh_agent().is_none() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::UnsupportedWorkload,
                "soul is not a hosted fresh-agent",
            ));
        }
        let host = self
            .authenticate_host(handle.incarnation_id(), handle.runtime_dir())
            .await?;
        self.registry
            .configure_fresh_agent_settings(
                soul_id,
                handle.incarnation_id().clone(),
                settings.clone(),
            )
            .await
            .map_err(map_registry)?;
        match self
            .send_authenticated_host_command(
                handle.incarnation_id().clone(),
                handle.runtime_dir(),
                &host,
                HostCommand::FreshAgentConfigure {
                    incarnation_id: handle.incarnation_id().clone(),
                    request_id,
                    settings,
                },
            )
            .await?
        {
            HostResult::FreshAgentCommand { state, .. } => Ok(state),
            _ => Err(RuntimeError::new(
                RuntimeErrorCode::HostAuthenticationFailed,
                "unexpected fresh-agent configure reply",
            )),
        }
    }

    async fn commit_fresh_native_operation(
        &self,
        context: &crate::registry::RecoveryContext,
        host: &AuthenticatedHost,
        native_session_id: Option<String>,
        claude_fork: Option<freshell_runtime_protocol::ClaudeForkRecipe>,
    ) -> Result<(), RuntimeError> {
        let update = classify_fresh_agent_operation_identity(
            context.native_session_id.as_deref(),
            native_session_id.as_deref(),
        )?;
        let handle = &context.prior_handle;
        let fence = context.write_fence();
        match update {
            FreshAgentNativeIdentityUpdate::Unchanged => return Ok(()),
            FreshAgentNativeIdentityUpdate::Record => {
                self.registry
                    .record_native_session_fenced(
                        context.soul_id.clone(),
                        handle.incarnation_id().clone(),
                        native_session_id.clone().expect("record requires root"),
                        fence,
                    )
                    .await
                    .map_err(map_registry)?;
            }
            FreshAgentNativeIdentityUpdate::Transition => {
                let clear = if matches!(context.provider.as_str(), "claude" | "kilroy")
                    && host
                        .capabilities
                        .iter()
                        .any(|capability| capability == "native-identity-observation-v1")
                {
                    let status = self
                        .host_status(handle.incarnation_id().clone(), handle.runtime_dir(), host)
                        .await?;
                    current_claude_clear_observation(context, &status)
                        .filter(|proof| {
                            Some(proof.native_session_id.as_str()) == native_session_id.as_deref()
                        })
                        .cloned()
                } else {
                    None
                };
                let parent = context
                    .native_session_id
                    .as_deref()
                    .expect("transition requires parent");
                let child = native_session_id
                    .as_deref()
                    .expect("transition requires child");
                if let Some(clear) = clear {
                    self.registry
                        .transition_claude_clear_fenced(
                            context.soul_id.clone(),
                            handle.incarnation_id().clone(),
                            parent,
                            child,
                            fence,
                            clear,
                        )
                        .await
                        .map_err(map_registry)?;
                } else {
                    self.registry
                        .transition_native_session_with_claude_fork_fenced(
                            context.soul_id.clone(),
                            handle.incarnation_id().clone(),
                            parent,
                            child,
                            fence,
                            claude_fork,
                        )
                        .await
                        .map_err(map_registry)?;
                }
            }
        }
        // The previous checkpoint names the old root. Observe the acknowledged
        // current child before making it available for another operation.
        self.observe_fresh_native_transition(
            &context.soul_id,
            handle.incarnation_id(),
            context.intent_revision,
        )
        .await?;
        let _ = self.probe_recovery_locked(context.soul_id.clone()).await;
        Ok(())
    }

    async fn fresh_agent_rollback(
        &self,
        request_id: RequestId,
        request: freshell_runtime_protocol::FreshAgentRollbackRequest,
    ) -> Result<CommandState, RuntimeError> {
        let soul_id = request.soul_id;
        let lifecycle_lock = self.lifecycle_lock(&soul_id).await;
        let _lifecycle_guard = lifecycle_lock.lock().await;
        let context = self
            .registry
            .recovery_context(soul_id.clone())
            .await
            .map_err(map_registry)?;
        let handle = context.prior_handle.clone();
        if handle.fresh_agent().is_none() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::UnsupportedWorkload,
                "soul is not a hosted fresh-agent",
            ));
        }
        let host = self
            .authenticate_host(handle.incarnation_id(), handle.runtime_dir())
            .await?;
        match self
            .send_authenticated_host_command(
                handle.incarnation_id().clone(),
                handle.runtime_dir(),
                &host,
                HostCommand::FreshAgentRollback {
                    incarnation_id: handle.incarnation_id().clone(),
                    request_id,
                    direction: request.direction,
                    mode: request.mode,
                    turn_id: request.turn_id,
                    cwd: request.cwd,
                },
            )
            .await?
        {
            HostResult::FreshAgentCommand {
                state,
                native_session_id,
                claude_fork,
            } => {
                self.commit_fresh_native_operation(&context, &host, native_session_id, claude_fork)
                    .await?;
                Ok(state)
            }
            _ => Err(RuntimeError::new(
                RuntimeErrorCode::HostAuthenticationFailed,
                "unexpected fresh-agent rollback reply",
            )),
        }
    }

    async fn fresh_agent_capture(
        &self,
        soul_id: SoulId,
        max_bytes: u32,
    ) -> Result<freshell_runtime_protocol::FreshAgentCapture, RuntimeError> {
        let handle = self
            .registry
            .active_handle_for_soul(soul_id)
            .await
            .map_err(map_registry)?;
        let Some(fresh_agent) = handle.fresh_agent() else {
            return Err(RuntimeError::new(
                RuntimeErrorCode::UnsupportedWorkload,
                "soul is not a hosted fresh-agent",
            ));
        };
        let presentation_session_id = fresh_agent.session_id.clone();
        let host = self
            .authenticate_host(handle.incarnation_id(), handle.runtime_dir())
            .await?;
        match self
            .send_authenticated_host_command(
                handle.incarnation_id().clone(),
                handle.runtime_dir(),
                &host,
                HostCommand::FreshAgentCapture {
                    incarnation_id: handle.incarnation_id().clone(),
                    max_bytes: max_bytes.clamp(1, 256 * 1024),
                },
            )
            .await?
        {
            HostResult::FreshAgentCapture(mut capture) => {
                capture.presentation_session_id = presentation_session_id;
                Ok(capture)
            }
            _ => Err(RuntimeError::new(
                RuntimeErrorCode::HostAuthenticationFailed,
                "unexpected fresh-agent capture reply",
            )),
        }
    }

    async fn fresh_agent_snapshot(
        &self,
        soul_id: SoulId,
    ) -> Result<serde_json::Value, RuntimeError> {
        let lifecycle_lock = self.lifecycle_lock(&soul_id).await;
        let _guard = lifecycle_lock.lock().await;
        let handle = self
            .registry
            .active_handle_for_soul(soul_id.clone())
            .await
            .map_err(map_registry)?;
        let agent = handle.fresh_agent().ok_or_else(|| {
            RuntimeError::new(
                RuntimeErrorCode::UnsupportedWorkload,
                "soul is not a hosted fresh-agent",
            )
        })?;
        let provider = if agent.provider == freshell_runtime_protocol::FreshProvider::Kilroy {
            "claude"
        } else {
            agent.provider.as_str()
        };
        let host = self
            .authenticate_host(handle.incarnation_id(), handle.runtime_dir())
            .await?;
        let result = self
            .send_authenticated_host_command(
                handle.incarnation_id().clone(),
                handle.runtime_dir(),
                &host,
                HostCommand::FreshAgentReadSnapshot {
                    incarnation_id: handle.incarnation_id().clone(),
                },
            )
            .await?;
        let HostResult::FreshAgentSnapshot(snapshot) = result else {
            return Err(RuntimeError::new(
                RuntimeErrorCode::HostAuthenticationFailed,
                "unexpected fresh-agent snapshot reply",
            ));
        };
        let current = self
            .registry
            .active_handle_for_soul(soul_id)
            .await
            .map_err(map_registry)?;
        if current.incarnation_id() != handle.incarnation_id() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::OwnershipMismatch,
                "fresh-agent snapshot owner changed",
            ));
        }
        if snapshot["provider"].as_str() != Some(provider) {
            return Err(RuntimeError::new(
                RuntimeErrorCode::OwnershipMismatch,
                "fresh-agent snapshot provider mismatch",
            ));
        }
        Ok(snapshot)
    }

    async fn fresh_agent_resolve(
        &self,
        soul_id: SoulId,
        decision_id: String,
        decision: serde_json::Value,
    ) -> Result<CommandState, RuntimeError> {
        let lifecycle_lock = self.lifecycle_lock(&soul_id).await;
        let _lifecycle_guard = lifecycle_lock.lock().await;
        let handle = self
            .registry
            .active_handle_for_soul(soul_id.clone())
            .await
            .map_err(map_registry)?;
        let host = self
            .authenticate_current_fresh_host(&soul_id, &handle)
            .await?;
        let fence = self
            .registry
            .recovery_write_fence(soul_id.clone())
            .await
            .map_err(map_registry)?
            .for_incarnation(handle.incarnation_id().clone());
        self.registry
            .disable_claude_fork_recovery_fenced(soul_id.clone(), fence)
            .await
            .map_err(map_registry)?;
        match self
            .send_authenticated_host_command(
                handle.incarnation_id().clone(),
                handle.runtime_dir(),
                &host,
                HostCommand::FreshAgentResolve {
                    incarnation_id: handle.incarnation_id().clone(),
                    decision_id,
                    decision,
                },
            )
            .await?
        {
            HostResult::FreshAgentCommand { state, .. } => Ok(state),
            _ => Err(RuntimeError::new(
                RuntimeErrorCode::HostAuthenticationFailed,
                "unexpected fresh-agent decision reply",
            )),
        }
    }

    async fn fresh_agent_interrupt(&self, soul_id: SoulId) -> Result<(), RuntimeError> {
        let lifecycle_lock = self.lifecycle_lock(&soul_id).await;
        let _lifecycle_guard = lifecycle_lock.lock().await;
        let handle = self
            .registry
            .active_handle_for_soul(soul_id)
            .await
            .map_err(map_registry)?;
        let host = self
            .authenticate_host(handle.incarnation_id(), handle.runtime_dir())
            .await?;
        match self
            .send_authenticated_host_command(
                handle.incarnation_id().clone(),
                handle.runtime_dir(),
                &host,
                HostCommand::FreshAgentInterrupt {
                    incarnation_id: handle.incarnation_id().clone(),
                },
            )
            .await?
        {
            HostResult::FreshAgentInterrupted => Ok(()),
            _ => Err(RuntimeError::new(
                RuntimeErrorCode::HostAuthenticationFailed,
                "unexpected fresh-agent interrupt reply",
            )),
        }
    }

    async fn fresh_agent_read_events(
        &self,
        soul_id: SoulId,
        after_sequence: u64,
        max_events: u32,
    ) -> Result<freshell_runtime_protocol::AgentEventBatch, RuntimeError> {
        let lifecycle_lock = self.lifecycle_lock(&soul_id).await;
        let _guard = lifecycle_lock.lock().await;
        let context = self
            .registry
            .recovery_context(soul_id.clone())
            .await
            .map_err(map_registry)?;
        let handle = context.prior_handle.clone();
        let mut fence = context.write_fence();
        let mut current_native = context.native_session_id.clone();
        let host = self
            .authenticate_host(handle.incarnation_id(), handle.runtime_dir())
            .await?;
        match self
            .send_authenticated_host_command(
                handle.incarnation_id().clone(),
                handle.runtime_dir(),
                &host,
                HostCommand::FreshAgentReadEvents {
                    incarnation_id: handle.incarnation_id().clone(),
                    after_sequence,
                    max_events: max_events.clamp(1, 4096),
                },
            )
            .await?
        {
            HostResult::FreshAgentEvents(events) => {
                let mut observed_current_start = false;
                let latest_start =
                    events
                        .events
                        .iter()
                        .rev()
                        .find_map(|event| match &event.event {
                            freshell_runtime_protocol::AgentEvent::Started {
                                native_session_id,
                            } => Some(native_session_id.as_str()),
                            _ => None,
                        });
                if matches!(context.provider.as_str(), "claude" | "kilroy")
                    && host
                        .capabilities
                        .iter()
                        .any(|capability| capability == "native-identity-observation-v1")
                    && latest_start.is_some()
                    && latest_start != current_native.as_deref()
                {
                    let status = self
                        .host_status(handle.incarnation_id().clone(), handle.runtime_dir(), &host)
                        .await?;
                    if let Some(observation) = current_claude_clear_observation(&context, &status)
                        .filter(|observation| {
                            Some(observation.native_session_id.as_str()) == latest_start
                        })
                    {
                        fence = self
                            .registry
                            .transition_claude_clear_fenced(
                                soul_id.clone(),
                                handle.incarnation_id().clone(),
                                current_native
                                    .as_deref()
                                    .expect("clear has an existing native root"),
                                &observation.native_session_id,
                                fence,
                                observation.clone(),
                            )
                            .await
                            .map_err(map_registry)?;
                        current_native = Some(observation.native_session_id.clone());
                        observed_current_start = true;
                    }
                }
                for event in &events.events {
                    if let freshell_runtime_protocol::AgentEvent::Started { native_session_id } =
                        &event.event
                    {
                        // The retained journal includes the original start
                        // after an in-soul fork. Replaying that parent is not
                        // a new provider observation or authority to undo the
                        // committed child; leave it readable as history.
                        if current_native
                            .as_deref()
                            .is_some_and(|current| current != native_session_id)
                        {
                            continue;
                        }
                        fence = self
                            .registry
                            .record_native_session_fenced(
                                soul_id.clone(),
                                handle.incarnation_id().clone(),
                                native_session_id.clone(),
                                fence,
                            )
                            .await
                            .map_err(map_registry)?;
                        current_native = Some(native_session_id.clone());
                        observed_current_start = true;
                        // The host journal is the durable identity edge for
                        // fresh agents. Materialize recovery evidence at the
                        // same boundary instead of waiting for a terminal
                        // output read that these workloads never perform.
                    }
                }
                if observed_current_start {
                    let _ = self.probe_recovery_locked(soul_id.clone()).await;
                }
                Ok(events)
            }
            _ => Err(RuntimeError::new(
                RuntimeErrorCode::HostAuthenticationFailed,
                "unexpected fresh-agent events reply",
            )),
        }
    }

    async fn terminal_read_output(
        &self,
        soul_id: SoulId,
        after_seq: u64,
        max_bytes: u64,
        expected_stream_epoch: Option<String>,
    ) -> Result<RuntimeOutputBatch, RuntimeError> {
        let mut timing = TerminalOutputReadTiming::new(&self.config.lifecycle_log, &soul_id);
        let source = self
            .registry
            .retained_output_source(soul_id.clone())
            .await
            .map_err(map_registry)?;
        crate::retained_output::validate_source(&source, &self.config.runtime_root)
            .map_err(|error| RuntimeError::new(RuntimeErrorCode::OwnershipMismatch, error))?;
        // Recovery authority is needed only if this batch introduces a native
        // identity. Its bookkeeping is not ownership of already accepted output.
        let observation_fence = self.registry.recovery_write_fence(soul_id.clone()).await;
        timing.phase("host_read");
        // A read starting after Stop reads accepted spool bytes directly.
        // Stop intent alone is not EOF; only an actual completion record or
        // the exact incarnation's persisted verified-empty state can end it.
        let retained_only = source.stopped || source.verified_empty;
        let live = if retained_only {
            None
        } else {
            Some(
                async {
                    let host = self
                        .authenticate_host(&source.incarnation_id, &source.runtime_dir)
                        .await?;
                    self.send_authenticated_host_command(
                        source.incarnation_id.clone(),
                        &source.runtime_dir,
                        &host,
                        HostCommand::TerminalReadOutput {
                            incarnation_id: source.incarnation_id.clone(),
                            after_seq,
                            max_bytes,
                            expected_stream_epoch: expected_stream_epoch.clone(),
                        },
                    )
                    .await
                }
                .await,
            )
        };
        let output = match live {
            Some(Ok(HostResult::TerminalOutput(output))) => output,
            Some(Ok(_)) => {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::HostAuthenticationFailed,
                    "unexpected terminal output reply",
                ));
            }
            None | Some(Err(_)) => {
                timing.phase("retained_fallback");
                // This capability is used only for read-only emptiness
                // verification, never input, kill or replacement dispatch.
                let verified_empty = if retained_only {
                    source.verified_empty
                } else {
                    let handle = self
                        .registry
                        .owned_handle(source.incarnation_id.clone())
                        .await
                        .map_err(map_registry)?;
                    self.backend.verify_empty(&handle).await.unwrap_or(false)
                };
                let retained_source = source.clone();
                tokio::task::spawn_blocking(move || {
                    crate::retained_output::read(
                        retained_source,
                        after_seq,
                        max_bytes,
                        expected_stream_epoch,
                        verified_empty,
                    )
                })
                .await
                .map_err(|_| {
                    RuntimeError::new(
                        RuntimeErrorCode::HostUnreachable,
                        "retained output reader failed",
                    )
                })?
                .map_err(|error| RuntimeError::new(RuntimeErrorCode::HostUnreachable, error))?
            }
        };
        timing.phase("owner_validation");
        let current = self.registry.retained_output_source(soul_id.clone()).await;
        if current.as_ref().ok().is_none_or(|current| {
            !source.accepts_output(current, output.native_session_id.as_deref())
        }) || output.incarnation_id != source.incarnation_id
            || output.terminal_id != source.terminal_id
        {
            append_event(
                &self.config.lifecycle_log,
                "supervisor.terminal_output.owner_changed",
                serde_json::json!({
                    "severity":"warn", "soulId":soul_id,
                    "sourceIncarnationId":source.incarnation_id,
                    "currentIncarnationId":current.as_ref().ok().map(|source| &source.incarnation_id),
                    "replyIncarnationId":output.incarnation_id,
                    "sourceFence":source.read_fence,
                    "currentFence":current.as_ref().ok().map(|source| &source.read_fence),
                    "terminalMatches":output.terminal_id == source.terminal_id,
                }),
            );
            return Err(RuntimeError::new(
                RuntimeErrorCode::OwnershipMismatch,
                "terminal output owner changed during host read",
            ));
        }
        let current = current.map_err(map_registry)?;
        if let Some(native_session_id) = output
            .native_session_id
            .as_ref()
            .filter(|observed| current.native_session_id.as_ref() != Some(*observed))
        {
            timing.phase("identity_write_custody");
            let lifecycle_lock = self.lifecycle_lock(&soul_id).await;
            let _guard = lifecycle_lock.lock().await;
            timing.phase("identity_observation");
            let current = self
                .registry
                .retained_output_source(soul_id.clone())
                .await
                .map_err(map_registry)?;
            if !source.accepts_output(&current, Some(native_session_id)) {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::OwnershipMismatch,
                    "terminal native identity owner changed before observation",
                ));
            }
            if current.native_session_id.as_ref() != Some(native_session_id) {
                let context = self.registry.recovery_context(soul_id.clone()).await;
                let context = match (observation_fence.as_ref(), context) {
                    (Ok(before), Ok(current))
                        if before == &current.write_fence()
                            && current.prior_handle.incarnation_id() == &source.incarnation_id =>
                    {
                        current
                    }
                    _ => {
                        return Err(RuntimeError::new(
                            RuntimeErrorCode::OwnershipMismatch,
                            "terminal native identity authority changed during host read",
                        ))
                    }
                };
                // Generation/boot ownership is rechecked under lifecycle
                // custody; the transaction validates the complete write fence.
                // No provider probe or helper belongs to this observation.
                if matches!(context.provider.as_str(), "claude" | "kilroy")
                    && context.native_session_id.is_some()
                {
                    let handle = &context.prior_handle;
                    let host = self
                        .authenticate_host(handle.incarnation_id(), handle.runtime_dir())
                        .await?;
                    if !host
                        .capabilities
                        .iter()
                        .any(|capability| capability == "native-identity-observation-v1")
                    {
                        return Err(RuntimeError::new(
                            RuntimeErrorCode::RecoveryBlocked,
                            "the changed Claude root requires native identity observation support",
                        ));
                    }
                    let status = self
                        .host_status(source.incarnation_id.clone(), handle.runtime_dir(), &host)
                        .await?;
                    let observation = current_claude_clear_observation(&context, &status)
                        .filter(|observation| observation.native_session_id == *native_session_id)
                        .ok_or_else(|| {
                            RuntimeError::new(RuntimeErrorCode::RecoveryBlocked,
                            "the changed Claude root requires its current native clear observation")
                        })?;
                    self.registry
                        .transition_claude_clear_fenced(
                            soul_id.clone(),
                            source.incarnation_id.clone(),
                            context
                                .native_session_id
                                .as_deref()
                                .expect("clear has existing root"),
                            native_session_id,
                            context.write_fence(),
                            observation.clone(),
                        )
                        .await
                        .map_err(map_registry)?;
                } else {
                    record_terminal_identity_observation(
                        &self.registry,
                        &context,
                        native_session_id,
                    )
                    .await?;
                }
            }
        }
        timing.phase("complete");
        Ok(output)
    }

    async fn runtime_metrics(&self, soul_id: SoulId) -> Result<RuntimeMetrics, RuntimeError> {
        let handle = self
            .registry
            .active_handle_for_soul(soul_id)
            .await
            .map_err(map_registry)?;
        let host = self
            .authenticate_host(handle.incarnation_id(), handle.runtime_dir())
            .await?;
        match self
            .send_authenticated_host_command(
                handle.incarnation_id().clone(),
                handle.runtime_dir(),
                &host,
                HostCommand::RuntimeMetrics {
                    incarnation_id: handle.incarnation_id().clone(),
                },
            )
            .await?
        {
            HostResult::RuntimeMetrics(metrics) => Ok(metrics),
            _ => Err(RuntimeError::new(
                RuntimeErrorCode::HostAuthenticationFailed,
                "unexpected runtime metrics reply",
            )),
        }
    }

    async fn notify_mcp_capability(
        &self,
        action: &str,
        endpoint: &str,
        soul_id: &SoulId,
        incarnation_id: &IncarnationId,
        grant_id: &str,
    ) -> Result<(), RuntimeError> {
        if endpoint
            .strip_prefix("http://host.docker.internal:")
            .and_then(|value| value.parse::<u16>().ok())
            .filter(|port| *port != 0)
            .is_none()
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                "invalid managed MCP endpoint",
            ));
        }
        if !matches!(action, "activate" | "revoke" | "commit" | "abort") {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                "invalid managed MCP action",
            ));
        }
        let response = self
            .mcp_capability_callback(McpCapabilityRequest {
                action,
                soul_id,
                incarnation_id: Some(incarnation_id),
                grant_id: Some(grant_id),
                provider: None,
                tui_source: None,
                workspace: None,
                auth_lookup_authority: None,
                claude_recovery_source: None,
                cwd: None,
                prior_context: None,
                provider_secret_references: None,
                provider_path_inputs: None,
            })
            .await?;
        if response != b"ok" {
            return Err(RuntimeError::new(
                RuntimeErrorCode::RecoveryBlocked,
                "capability_pending: server rejected scoped grant",
            ));
        }
        if matches!(action, "abort" | "revoke") {
            self.provider_path_inputs
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&(soul_id.clone(), grant_id.into()));
        }
        Ok(())
    }

    /// Retry only a durable acceptance proof for this immutable incarnation.
    /// Running alone never authorizes completion of a resumed generation.
    pub(crate) fn complete_pending_provider_preparation<'a>(
        &'a self,
        handle: &'a crate::registry::OwnedRuntimeHandle,
    ) -> impl std::future::Future<Output = Result<(), RuntimeError>> + Send + 'a {
        // Recovery embeds this operation on several branches. Keep the large
        // provider completion future off the ordinary control-worker stack.
        Box::pin(async move {
            if !self
                .registry
                .provider_preparation_is_pending(handle.incarnation_id().clone())
                .await
                .map_err(map_registry)?
            {
                return Ok(());
            }
            if let Err(error) = Box::pin(self.await_running_startup(
                handle.soul_id(),
                "provider_preparation_cleanup",
                Box::pin(self.commit_provider_preparation(handle)),
            ))
            .await?
            {
                append_event(
                    &self.config.lifecycle_log,
                    "supervisor.provider_preparation.pending",
                    serde_json::json!({
                        "severity":"error", "soulId":handle.soul_id(), "incarnationId":handle.incarnation_id(),
                        "operation":"complete_accepted_generation", "errorCode":error.code,
                    }),
                );
                return Err(error);
            }
            self.registry
                .mark_provider_preparation_complete(handle.incarnation_id().clone())
                .await
                .map_err(map_registry)?;
            append_event(
                &self.config.lifecycle_log,
                "supervisor.provider_preparation.completed",
                serde_json::json!({
                    "severity":"info", "soulId":handle.soul_id(), "incarnationId":handle.incarnation_id(),
                }),
            );
            Ok(())
        })
    }

    async fn commit_provider_preparation(
        &self,
        handle: &crate::registry::OwnedRuntimeHandle,
    ) -> Result<(), RuntimeError> {
        let context = handle
            .terminal()
            .and_then(|terminal| terminal.provider_launch_context.as_ref())
            .or_else(|| {
                handle
                    .fresh_agent()
                    .and_then(|agent| agent.provider_launch_context.as_ref())
            });
        if let Some(capability) = context.and_then(|context| context.mcp_capability.as_ref()) {
            self.notify_mcp_capability(
                "commit",
                &capability.endpoint,
                handle.soul_id(),
                handle.incarnation_id(),
                &capability.grant_id,
            )
            .await?;
        }
        if context
            .and_then(|context| context.prepared_inputs.as_ref())
            .is_some()
        {
            self.backend
                .commit_prepared_inputs(handle)
                .await
                .map_err(map_backend)?;
            // The pending flag is armed atomically with initial acceptance or
            // exact verified recovery success. Healthy retries preserve those
            // gates while finishing interrupted release/retirement.
            let generation = |owner: &crate::registry::OwnedRuntimeHandle| {
                owner
                    .terminal()
                    .and_then(|spec| spec.provider_launch_context.as_ref())
                    .or_else(|| {
                        owner
                            .fresh_agent()
                            .and_then(|spec| spec.provider_launch_context.as_ref())
                    })
                    .and_then(|context| context.prepared_inputs.as_ref())
                    .map(|inputs| inputs.generation_id.clone())
            };
            let current_generation = generation(handle);
            let mut prior = self
                .registry
                .prior_provider_owner(handle.incarnation_id().clone())
                .await
                .map_err(map_registry)?;
            while let Some(owner) = prior {
                // A failed start may have replayed the current preparation.
                // Retirement must reach its distinct earlier generation.
                if current_generation.is_some() && generation(&owner) == current_generation {
                    prior = self
                        .registry
                        .prior_provider_owner(owner.incarnation_id().clone())
                        .await
                        .map_err(map_registry)?;
                    continue;
                }
                self.backend
                    .retire_prior_prepared_inputs(handle, &owner)
                    .await
                    .map_err(map_backend)?;
                break;
            }
        }
        if let Some(inputs) = context.and_then(|context| context.prepared_inputs.as_ref()) {
            self.commit_provider_path_inputs(handle.soul_id(), &inputs.generation_id);
        }
        Ok(())
    }

    fn bound_provider_path_inputs(
        &self,
        soul_id: &SoulId,
        generation_id: Option<&str>,
    ) -> freshell_runtime_protocol::ProviderPathInputs {
        generation_id
            .and_then(|generation| {
                self.provider_path_inputs
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .get(&(soul_id.clone(), generation.into()))
                    .filter(|(_, expires)| expires.is_none_or(|expires| expires > Instant::now()))
                    .map(|(inputs, _)| inputs.clone())
            })
            .unwrap_or_default()
    }

    fn commit_provider_path_inputs(&self, soul_id: &SoulId, generation_id: &str) {
        let mut bindings = self
            .provider_path_inputs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let current = (soul_id.clone(), generation_id.to_string());
        // The controller has retired the prior generation only after acceptance.
        // Keep the current selection process-local for replacement, with no
        // preparation timeout once it belongs to the accepted running context.
        bindings.retain(|key, _| key.0 != *soul_id || *key == current);
        if let Some((_, expires)) = bindings.get_mut(&current) {
            *expires = None;
        }
    }

    fn claude_recovery_source_binding(
        &self,
        start: &crate::registry::RecoveryStart,
        scope_key: &str,
        context: &freshell_runtime_protocol::ProviderLaunchContext,
    ) -> Result<freshell_runtime_protocol::ClaudeRecoverySourceBinding, RuntimeError> {
        use sha2::Digest;
        let unavailable = || {
            RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                "Claude prior source generation unavailable; retain inputs and reprepare",
            )
        };
        let saved = start
            .context
            .prior_handle
            .terminal()
            .and_then(|spec| spec.provider_launch_context.as_ref())
            .or_else(|| {
                start
                    .context
                    .prior_handle
                    .fresh_agent()
                    .and_then(|spec| spec.provider_launch_context.as_ref())
            })
            .ok_or_else(unavailable)?;
        context.validate("claude")?;
        let inputs = context.prepared_inputs.as_ref().ok_or_else(unavailable)?;
        if saved
            .prepared_inputs
            .as_ref()
            .map(|inputs| inputs.generation_id.as_str())
            != Some(inputs.generation_id.as_str())
        {
            return Err(unavailable());
        }
        let authority = freshell_runtime_protocol::ClaudeSourceAuthority::RecoveryAttempt {
            attempt_id: scope_key.into(),
        };
        let raw = freshell_runtime_protocol::bounded_json_bytes(
            &authority,
            freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES,
        )
        .map_err(|_| unavailable())?;
        let binding = freshell_runtime_protocol::ClaudeRecoverySourceBinding {
            provider: start.context.provider.clone(),
            git_common_dir: start
                .context
                .prior_handle
                .terminal()
                .and_then(|spec| spec.git_common_dir.clone())
                .or_else(|| {
                    start
                        .context
                        .prior_handle
                        .fresh_agent()
                        .and_then(|spec| spec.git_common_dir.clone())
                }),
            authority_sha256: format!("{:x}", sha2::Sha256::digest(raw)),
            registry_attempt_id: start.attempt_id.clone(),
            intent_revision: start.context.intent_revision,
            prior_generation_id: inputs.generation_id.clone(),
        };
        binding.validate()?;
        Ok(binding)
    }

    pub(crate) async fn issue_replacement_mcp_capability(
        &self,
        start: &crate::registry::RecoveryStart,
        provider: &str,
        context: &freshell_runtime_protocol::ProviderLaunchContext,
        references: &[freshell_runtime_protocol::ProviderSecretReference],
        cwd: &str,
        workspace: &str,
    ) -> Result<freshell_runtime_protocol::PreparedProviderContext, RuntimeError> {
        let tui_source = match &context.preparation {
            freshell_runtime_protocol::ProviderPreparation::Opencode { tui_source, .. } => {
                tui_source.as_ref()
            }
            _ => None,
        };
        let claude_recovery =
            provider == "claude" && matches!(start.context.provider.as_str(), "claude" | "kilroy");
        let scope = self.auth_lookup_scope(
            start,
            self.provider_callback_budgets.for_callback(claude_recovery),
        );
        let claude_recovery_source = if claude_recovery {
            Some(self.claude_recovery_source_binding(start, &scope.key, context)?)
        } else {
            None
        };
        let path_inputs = self.bound_provider_path_inputs(
            &start.context.soul_id,
            context
                .prepared_inputs
                .as_ref()
                .map(|inputs| inputs.generation_id.as_str()),
        );
        let response = self
            .mcp_capability_callback(McpCapabilityRequest {
                action: "issue",
                soul_id: &start.context.soul_id,
                incarnation_id: None,
                grant_id: None,
                provider: Some(provider),
                tui_source,
                workspace: Some(workspace),
                auth_lookup_authority: Some(&scope.key),
                claude_recovery_source: claude_recovery_source.as_ref(),
                cwd: Some(cwd),
                prior_context: Some(context),
                provider_secret_references: Some(references),
                provider_path_inputs: Some(&path_inputs),
            })
            .await?;
        let prepared: freshell_runtime_protocol::PreparedProviderContext =
            serde_json::from_slice(&response).map_err(|_| {
                RuntimeError::new(
                    RuntimeErrorCode::RecoveryBlocked,
                    "capability_pending: server returned an invalid exact provider preparation",
                )
            })?;
        // This callback refreshes an existing execution capability. A valid
        // generic preparation without one cannot satisfy that operation.
        if prepared.provider_launch_context.mcp_capability.is_none()
            || prepared.validate(provider).is_err()
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::RecoveryBlocked,
                "capability_pending: server returned an invalid exact provider preparation",
            ));
        }
        Ok(prepared)
    }

    async fn mcp_capability_callback(
        &self,
        request: McpCapabilityRequest<'_>,
    ) -> Result<Vec<u8>, RuntimeError> {
        if self.config.control_secret.contains(['\r', '\n']) {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                "invalid managed runtime control secret",
            ));
        }
        let body = freshell_runtime_protocol::bounded_json_bytes(
            &serde_json::json!({
                "action": request.action,
                "controlSecret": self.config.control_secret,
                "soulId": request.soul_id,
                "incarnationId": request.incarnation_id,
                "grantId": request.grant_id,
                "provider": request.provider,
                "tuiSource": request.tui_source,
                "workspace": request.workspace,
                "authLookupAuthority": request.auth_lookup_authority,
                "claudeRecoverySource": request.claude_recovery_source,
                "cwd":request.cwd,
                "priorContext":request.prior_context,
                "providerSecretReferences":request.provider_secret_references,
                "providerPathInputs":request.provider_path_inputs,
            }),
            freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES,
        )
        .map_err(|error| RuntimeError::new(RuntimeErrorCode::InvalidRequest, error.to_string()))?;
        let callback_socket = self.config.control_socket_path.with_file_name("mcp.sock");
        let exchange = async {
            let mut socket = UnixStream::connect(&callback_socket).await?;
            socket.write_all(&body).await?;
            socket.shutdown().await?;
            let mut response = Vec::new();
            (&mut socket)
                .take((freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES + 1) as u64)
                .read_to_end(&mut response)
                .await?;
            if response.len() > freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES {
                return Err(std::io::Error::other(
                    "provider preparation reply exceeds limit",
                ));
            }
            Ok::<_, std::io::Error>(response)
        };
        let budget = self
            .provider_callback_budgets
            .for_callback(request.claude_recovery_source.is_some());
        // Recovery composes several large native request futures. Keep this
        // exchange and intent polling off its nested poll stack.
        let bounded = Box::pin(tokio::time::timeout(budget, exchange));
        let response = if request.action == "issue" {
            Box::pin(self.await_running_startup(request.soul_id, "provider_preparation", bounded))
                .await?
        } else {
            bounded.await
        }
        .map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::HostUnreachable,
                format!(
                    "capability_pending: server callback timed out after {}ms",
                    budget.as_millis()
                ),
            )
        })?
        .map_err(|error| {
            RuntimeError::new(
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::Other
                        | std::io::ErrorKind::InvalidInput
                        | std::io::ErrorKind::InvalidData
                ) {
                    RuntimeErrorCode::RecoveryBlocked
                } else {
                    RuntimeErrorCode::HostUnreachable
                },
                format!("capability_pending: server callback unavailable: {error}"),
            )
        })?;
        Ok(response)
    }

    /// Stop commits its intent before acquiring lifecycle ownership. Observe
    /// that transaction while awaiting preparation so Stop need not wait for a
    /// startup budget before it can perform its normal owned teardown.
    pub(crate) async fn await_running_startup<T>(
        &self,
        soul_id: &SoulId,
        stage: &'static str,
        operation: impl std::future::Future<Output = T>,
    ) -> Result<T, RuntimeError> {
        tokio::pin!(operation);
        loop {
            let context = self
                .registry
                .recovery_context(soul_id.clone())
                .await
                .map_err(map_registry)?;
            if context.desired_state != freshell_runtime_protocol::DesiredState::Running {
                append_event(
                    &self.config.lifecycle_log,
                    "supervisor.startup.interrupted",
                    serde_json::json!({
                        "severity":"info", "soulId":soul_id, "intentRevision":context.intent_revision,
                        "stage":stage, "reason":"stopped_intent"
                    }),
                );
                return Err(RuntimeError::new(
                    RuntimeErrorCode::StaleIntentRevision,
                    "startup interrupted by stopped intent",
                ));
            }
            tokio::select! {
                result = &mut operation => return Ok(result),
                _ = sleep(Duration::from_millis(100)) => {}
            }
        }
    }

    async fn stop(
        &self,
        soul_id: SoulId,
        expected_intent_revision: Option<u64>,
    ) -> Result<(StopOutcome, RuntimeView), RuntimeError> {
        // Intent (including retry cancellation) commits before waiting for
        // provider work. The returned handle carries that transaction's fence.
        let handle = self
            .registry
            .begin_stop_expected(soul_id.clone(), expected_intent_revision)
            .await
            .map_err(map_registry)?;
        self.stop_event("supervisor.stop_committed", &handle, "info", "stop_intent");
        self.stop_event(
            "supervisor.recovery_retry.cancelled",
            &handle,
            "info",
            "stop_intent",
        );
        stop_crash_boundary("ordinary_stop_after_intent");
        let lifecycle_lock = self.lifecycle_lock(&soul_id).await;
        let _lifecycle_guard = lifecycle_lock.lock().await;
        let outcome = self.finish_stop_handle(&handle).await?;
        let view = find_view(&self.registry, handle.incarnation_id()).await?;
        Ok((outcome, view))
    }

    fn stop_event(
        &self,
        event: &str,
        handle: &crate::registry::OwnedRuntimeHandle,
        severity: &str,
        reason: &str,
    ) {
        let fence = handle.stop_fence().ok();
        append_event(
            &self.config.lifecycle_log,
            event,
            serde_json::json!({
                "severity":severity, "soulId":handle.soul_id(), "incarnationId":handle.incarnation_id(),
                "intentRevision":fence.map(|fence| fence.intent_revision),
                "executionGeneration":fence.map(|fence| fence.execution_generation),
                "controlEpoch":self.registry.control_epoch(), "reason":reason,
            }),
        );
    }

    /// The caller owns the lifecycle lock. This continues the captured Stop;
    /// it never commits another intent or enters Running recovery.
    pub(crate) async fn finish_stop_handle(
        &self,
        handle: &crate::registry::OwnedRuntimeHandle,
    ) -> Result<StopOutcome, RuntimeError> {
        let progress = self
            .registry
            .stop_progress(handle)
            .await
            .map_err(map_registry)?;
        if progress.settled {
            return progress.outcome.ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::RegistryFailure,
                    "settled Stop has no outcome",
                )
            });
        }
        self.stop_event(
            "supervisor.stop_continuation",
            handle,
            "info",
            "pending_stop",
        );
        let outcome = if progress.outcome == Some(StopOutcome::VerifiedEmpty) {
            StopOutcome::VerifiedEmpty
        } else {
            let outcome = self.terminate_for_ordinary_stop(handle).await?;
            if outcome == StopOutcome::VerifiedEmpty {
                stop_crash_boundary("ordinary_stop_after_empty");
            }
            // The same transaction persists the typed outcome, releases the
            // writer, and records the exact pending revoke before external IO.
            self.registry
                .record_ordinary_stop_outcome(handle, outcome)
                .await
                .map_err(map_registry)?;
            stop_crash_boundary("ordinary_stop_after_outcome");
            outcome
        };
        if outcome == StopOutcome::VerifiedEmpty {
            let current = self
                .registry
                .stop_progress(handle)
                .await
                .map_err(map_registry)?;
            if !current.settled {
                if let Some((endpoint, grant)) = current.capability {
                    match self
                        .notify_mcp_capability(
                            "revoke",
                            &endpoint,
                            handle.soul_id(),
                            handle.incarnation_id(),
                            &grant,
                        )
                        .await
                    {
                        Ok(()) => {
                            self.registry
                                .acknowledge_stop_revoke(handle, &endpoint, &grant)
                                .await
                                .map_err(map_registry)?;
                            self.stop_event(
                                "supervisor.stop_revoke_settled",
                                handle,
                                "info",
                                "acknowledged",
                            );
                        }
                        Err(error) => {
                            self.stop_event(
                                "supervisor.stop_revoke_pending",
                                handle,
                                "warning",
                                &format!("{:?}", error.code),
                            );
                        }
                    }
                }
            }
        }
        self.stop_event(
            "supervisor.stop_outcome",
            handle,
            if outcome == StopOutcome::VerifiedEmpty {
                "info"
            } else {
                "warning"
            },
            match outcome {
                StopOutcome::VerifiedEmpty => "verified_empty",
                StopOutcome::BackendUnavailable => "backend_unavailable",
                StopOutcome::TerminationUnconfirmed => "termination_unconfirmed",
                StopOutcome::BlockedOwnership => "blocked_ownership",
            },
        );
        Ok(outcome)
    }

    async fn terminate_for_ordinary_stop(
        &self,
        handle: &crate::registry::OwnedRuntimeHandle,
    ) -> Result<StopOutcome, RuntimeError> {
        // Qualified absence is sufficient; a failed inspection never is.
        self.registry
            .stop_progress(handle)
            .await
            .map_err(map_registry)?;
        match self
            .verify_empty_before_classified(handle, Instant::now() + Duration::from_secs(3))
            .await
        {
            Ok(true) => return Ok(StopOutcome::VerifiedEmpty),
            Ok(false) => {}
            Err(error) => {
                self.stop_runtime_stage_failed(handle, "initial_empty_inspection", &error);
                return Ok(stop_verification_outcome(error.error));
            }
        }
        match self
            .authenticate_host_classified(handle.incarnation_id(), handle.runtime_dir())
            .await
        {
            Ok(authenticated) => {
                self.registry
                    .stop_progress(handle)
                    .await
                    .map_err(map_registry)?;
                if let Err(error) = self
                    .send_host_stop_classified(
                        handle.incarnation_id().clone(),
                        handle.runtime_dir(),
                        &authenticated,
                    )
                    .await
                {
                    self.stop_runtime_stage_failed(handle, "host_stop", &error);
                }
            }
            Err(error) => self.stop_runtime_stage_failed(handle, "host_authentication", &error),
        }
        self.registry
            .stop_progress(handle)
            .await
            .map_err(map_registry)?;
        // Docker's grace parameter bounds termination inside Docker. Allow
        // ownership inspection and HTTP overhead beyond that grace while
        // keeping the whole future finite so silence releases our lock.
        let grace_seconds = 2;
        let request_budget = Duration::from_secs(grace_seconds) + Duration::from_secs(1);
        let graceful = tokio::time::timeout(
            request_budget,
            self.backend.request_stop(handle, grace_seconds),
        )
        .await;
        if let Err(error) =
            self.stop_request_result(handle, "graceful_stop", graceful, "graceful Stop timed out")
        {
            // A concurrently removed exact enclosure can return 404 to Stop.
            // It still needs the backend's qualified empty observation.
            self.registry
                .stop_progress(handle)
                .await
                .map_err(map_registry)?;
            return Ok(
                match self
                    .verify_empty_before_classified(handle, Instant::now() + Duration::from_secs(3))
                    .await
                {
                    Ok(true) => StopOutcome::VerifiedEmpty,
                    Err(inspection_error) => {
                        self.stop_runtime_stage_failed(
                            handle,
                            "graceful_failure_empty_inspection",
                            &inspection_error,
                        );
                        if inspection_error.error.code == RuntimeErrorCode::OwnershipMismatch {
                            StopOutcome::BlockedOwnership
                        } else {
                            stop_backend_outcome(error)
                        }
                    }
                    Ok(false) => stop_backend_outcome(error),
                },
            );
        }
        stop_crash_boundary("ordinary_stop_after_graceful");
        match self
            .verify_empty_with_budget_classified(handle, Duration::from_secs(3))
            .await
        {
            Ok(true) => return Ok(StopOutcome::VerifiedEmpty),
            Ok(false) => {}
            Err(error) => {
                self.stop_runtime_stage_failed(handle, "graceful_empty_inspection", &error);
                return Ok(stop_verification_outcome(error.error));
            }
        }
        self.registry
            .stop_progress(handle)
            .await
            .map_err(map_registry)?;
        let forced =
            tokio::time::timeout(Duration::from_secs(3), self.backend.force_stop(handle)).await;
        if let Err(error) =
            self.stop_request_result(handle, "force_stop", forced, "force Stop timed out")
        {
            return Ok(stop_backend_outcome(error));
        }
        Ok(
            match self
                .verify_empty_with_budget_classified(handle, Duration::from_secs(3))
                .await
            {
                Ok(true) => StopOutcome::VerifiedEmpty,
                Ok(false) => {
                    self.stop_stage_failed(
                        handle,
                        "force_empty_inspection",
                        "not_empty",
                        None,
                        None,
                    );
                    StopOutcome::TerminationUnconfirmed
                }
                Err(error) => {
                    self.stop_runtime_stage_failed(handle, "force_empty_inspection", &error);
                    stop_verification_outcome(error.error)
                }
            },
        )
    }

    fn stop_stage_failed(
        &self,
        handle: &crate::registry::OwnedRuntimeHandle,
        stage: &str,
        category: &str,
        code: Option<RuntimeErrorCode>,
        status: Option<u16>,
    ) {
        let fence = handle.stop_fence().ok();
        append_event(
            &self.config.lifecycle_log,
            "supervisor.stop_stage_failed",
            serde_json::json!({
                "severity":"warning", "soulId":handle.soul_id(), "incarnationId":handle.incarnation_id(),
                "intentRevision":fence.map(|f| f.intent_revision), "executionGeneration":fence.map(|f| f.execution_generation),
                "controlEpoch":self.registry.control_epoch(), "stage":stage, "errorCategory":category,
                "errorCode":code, "httpStatus":status,
            }),
        );
    }

    fn stop_runtime_stage_failed(
        &self,
        handle: &crate::registry::OwnedRuntimeHandle,
        stage: &str,
        failure: &ClassifiedFailure,
    ) {
        self.stop_stage_failed(
            handle,
            stage,
            failure.category,
            Some(failure.error.code),
            failure.http_status,
        );
    }

    fn stop_request_result(
        &self,
        handle: &crate::registry::OwnedRuntimeHandle,
        stage: &str,
        result: Result<Result<(), BackendError>, tokio::time::error::Elapsed>,
        timeout_message: &str,
    ) -> Result<(), BackendError> {
        match result {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => {
                let (category, status) = backend_failure_category(&error);
                self.stop_stage_failed(handle, stage, category, None, status);
                Err(error)
            }
            Err(_) => {
                self.stop_stage_failed(handle, stage, "timeout", None, None);
                Err(BackendError::Unavailable(timeout_message.into()))
            }
        }
    }

    pub(crate) async fn verify_empty_with_budget(
        &self,
        handle: &crate::registry::OwnedRuntimeHandle,
        budget: Duration,
    ) -> Result<bool, RuntimeError> {
        self.verify_empty_with_budget_classified(handle, budget)
            .await
            .map_err(|failure| failure.error)
    }

    async fn verify_empty_with_budget_classified(
        &self,
        handle: &crate::registry::OwnedRuntimeHandle,
        budget: Duration,
    ) -> Result<bool, ClassifiedFailure> {
        let deadline = Instant::now() + budget;
        loop {
            if self
                .verify_empty_before_classified(handle, deadline)
                .await?
            {
                return Ok(true);
            }
            tokio::time::sleep_until((Instant::now() + Duration::from_millis(100)).min(deadline))
                .await;
            if Instant::now() >= deadline {
                return Ok(false);
            }
        }
    }

    async fn verify_empty_before_classified(
        &self,
        handle: &crate::registry::OwnedRuntimeHandle,
        deadline: Instant,
    ) -> Result<bool, ClassifiedFailure> {
        // Every observation shares the remaining window. A hung read cannot
        // outlive it, and repeated observations cannot renew the budget.
        tokio::time::timeout_at(deadline, self.backend.verify_empty(handle))
            .await
            .map_err(|_| {
                ClassifiedFailure::timeout(RuntimeError::new(
                    RuntimeErrorCode::BackendUnavailable,
                    "Stop empty inspection timed out",
                ))
            })?
            .map_err(ClassifiedFailure::backend)
    }

    pub(crate) fn ensure_incarnation_dir(
        &self,
        prepared: &PreparedLaunch,
    ) -> Result<PathBuf, RuntimeError> {
        let runtime_dir = self
            .config
            .runtime_root
            .join(prepared.incarnation_id.as_str());
        if runtime_dir.exists() {
            let canonical = std::fs::canonicalize(&runtime_dir).map_err(io_runtime)?;
            if !canonical.starts_with(&self.config.runtime_root) {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::OwnershipMismatch,
                    "incarnation directory escaped runtime root",
                ));
            }
        } else {
            std::fs::create_dir(&runtime_dir).map_err(io_runtime)?;
        }
        let secret_path = runtime_dir.join("secret");
        if !secret_path.exists() {
            let secret = format!(
                "{}{}{}{}",
                uuid::Uuid::new_v4(),
                uuid::Uuid::new_v4(),
                uuid::Uuid::new_v4(),
                uuid::Uuid::new_v4()
            );
            write_secret_durable(&secret_path, secret.as_bytes()).map_err(io_runtime)?;
        }
        std::fs::canonicalize(runtime_dir).map_err(io_runtime)
    }

    pub(crate) async fn authenticate_host(
        &self,
        incarnation_id: &IncarnationId,
        runtime_dir: &Path,
    ) -> Result<AuthenticatedHost, RuntimeError> {
        self.authenticate_host_classified(incarnation_id, runtime_dir)
            .await
            .map_err(|failure| failure.error)
    }

    async fn authenticate_host_classified(
        &self,
        incarnation_id: &IncarnationId,
        runtime_dir: &Path,
    ) -> Result<AuthenticatedHost, ClassifiedFailure> {
        let socket = runtime_dir.join("host.sock");
        let secret = std::fs::read(runtime_dir.join("secret")).map_err(io_runtime)?;
        let challenge = uuid::Uuid::new_v4().to_string();
        let deadline = Instant::now() + Duration::from_secs(8);
        // The connect retry tolerates a host that has not bound its socket
        // yet. Once connected, the reply itself is bounded by the same budget
        // every other host command uses: a host that accepts and then goes
        // silent is HostUnreachable, never an unbounded wait.
        let budget = self.host_command_budgets.control;
        loop {
            match UnixStream::connect(&socket).await {
                Ok(mut stream) => {
                    let envelope = Envelope::new(
                        RequestId::new(),
                        ControlRole::Supervisor,
                        HostCommand::Hello {
                            incarnation_id: incarnation_id.clone(),
                            challenge: challenge.clone(),
                        },
                    );
                    let reply =
                        exchange_host_frame_classified(&mut stream, &envelope, budget, &socket)
                            .await?;
                    match reply.result? {
                        HostResult::Hello {
                            host_boot_id,
                            proof,
                            effective_limits,
                            capabilities,
                        } => {
                            let expected =
                                host_proof(&secret, &challenge, &host_boot_id, incarnation_id);
                            if proof != expected {
                                return Err(RuntimeError::new(
                                    RuntimeErrorCode::HostAuthenticationFailed,
                                    "session host challenge proof mismatch",
                                )
                                .into());
                            }
                            return Ok(AuthenticatedHost {
                                host_boot_id,
                                secret,
                                effective_limits,
                                capabilities,
                            });
                        }
                        _ => {
                            return Err(RuntimeError::new(
                                RuntimeErrorCode::HostAuthenticationFailed,
                                "unexpected hello reply",
                            )
                            .into())
                        }
                    }
                }
                Err(_) if Instant::now() < deadline => sleep(Duration::from_millis(100)).await,
                Err(error) => {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::HostUnreachable,
                        format!("host socket {} unavailable: {error}", socket.display()),
                    )
                    .into())
                }
            }
        }
    }

    async fn send_grant(
        &self,
        handle: &crate::registry::OwnedRuntimeHandle,
        workload: &LaunchWorkload,
        host: &AuthenticatedHost,
        grant: &ExecutionGrantRecord,
    ) -> Result<AcceptedGrant, RuntimeError> {
        let incarnation_id = handle.incarnation_id().clone();
        let preparation = workload
            .terminal
            .as_ref()
            .and_then(|launch| launch.provider_launch_context.as_ref())
            .or_else(|| {
                workload
                    .fresh_agent
                    .as_ref()
                    .and_then(|launch| launch.provider_launch_context.as_ref())
            })
            .and_then(|context| context.prepared_inputs.as_ref());
        let provider_path_inputs = self.bound_provider_path_inputs(
            &workload.soul_id,
            preparation.map(|inputs| inputs.generation_id.as_str()),
        );
        let identity_context = self
            .registry
            .recovery_context(workload.soul_id.clone())
            .await
            .map_err(map_registry)?;
        let native_identity_launch = self
            .registry
            .bind_native_identity_launch(freshell_runtime_protocol::NativeIdentityLaunch {
                incarnation_id: incarnation_id.clone(),
                launch_nonce: handle.launch_nonce().as_str().into(),
                evidence_revision: identity_context.evidence_revision,
                execution_generation: grant.execution_generation,
                requested_native_session_id: workload
                    .resume_spec
                    .as_ref()
                    .map(|spec| spec.provider_session.native_session_id.clone())
                    .or(identity_context.native_session_id.clone()),
            })
            .await
            .map_err(map_registry)?;
        let command = HostCommand::GrantExecution {
            native_identity_launch: Some(native_identity_launch.clone()),
            incarnation_id: incarnation_id.clone(),
            soul_id: workload.soul_id.clone(),
            host_boot_id: grant.host_boot_id.clone(),
            control_epoch: grant.control_epoch,
            execution_generation: grant.execution_generation,
            grant_id: grant.grant_id.clone(),
            fixture: workload.fixture,
            provider_path_inputs,
            terminal: workload.terminal.clone().map(Box::new),
            fresh_agent: workload.fresh_agent.clone().map(Box::new),
            resume_spec: workload.resume_spec.clone().map(Box::new),
            dispatch_budget_ms: None,
        };
        match self
            .send_authenticated_host_command(incarnation_id, handle.runtime_dir(), host, command)
            .await?
        {
            HostResult::GrantAccepted {
                native_identity_observation,
                host_boot_id,
                worker_pid,
                worker_launch_count,
                fixture_evidence,
                native_session_id,
                opencode_transfer_receipt,
                ..
            } => {
                let observed_root = native_identity_observation
                    .as_ref()
                    .filter(|observation| {
                        observation.matches_launch(&native_identity_launch)
                            && observation.matches_provider(
                                &identity_context.provider,
                                workload.fresh_agent.is_some(),
                            )
                    })
                    .map(|observation| observation.native_session_id.clone());
                // Fixture roots are presentation identity only. Ordinary
                // providers still need current matching native evidence.
                let fixture_root = if native_identity_observation.is_none()
                    && host_boot_id == host.host_boot_id
                    && workload.fresh_agent.as_ref().is_some_and(|agent| {
                        identity_context.fresh_agent.as_ref() == Some(agent)
                            && crate::registry::deterministic_fresh_agent_fixture(
                                &identity_context.provider,
                                agent,
                            )
                    }) {
                    native_session_id.filter(|root| {
                        !root.is_empty()
                            && !root.chars().any(char::is_control)
                            && native_identity_launch
                                .requested_native_session_id
                                .as_deref()
                                .is_none_or(|requested| requested == root)
                    })
                } else {
                    None
                };
                Ok(AcceptedGrant {
                    host_boot_id,
                    worker_pid,
                    worker_launch_count,
                    fixture_evidence,
                    native_session_id: observed_root.or(fixture_root),
                    native_identity_observation,
                    opencode_transfer_receipt: validate_opencode_transfer_receipt(
                        workload
                            .terminal
                            .as_ref()
                            .and_then(|terminal| terminal.opencode_transfer.as_ref()),
                        workload.terminal.as_ref().and_then(|terminal| {
                            terminal
                                .opencode_transfer
                                .as_ref()
                                .map(|_| (terminal.run_as_uid, terminal.run_as_gid))
                        }),
                        opencode_transfer_receipt,
                    )?,
                })
            }
            _ => Err(RuntimeError::new(
                RuntimeErrorCode::HostAuthenticationFailed,
                "unexpected grant reply",
            )),
        }
    }

    async fn wait_for_native_startup(
        &self,
        workload: &LaunchWorkload,
        incarnation_id: &IncarnationId,
        context: &crate::registry::RecoveryContext,
        intent_revision: u64,
    ) -> crate::recovery::NativeIdentityWait {
        use crate::recovery::NativeIdentityWait;
        let opencode_readiness = workload.opencode_tui_readiness_required(&context.provider);
        let result = self
            .wait_for_native_identity(
                &workload.soul_id,
                incarnation_id,
                intent_revision,
                crate::recovery::native_identity_wait_timeout(opencode_readiness),
                false,
            )
            .await;
        let (outcome, adoption_pending, elapsed_ms) = match &result {
            NativeIdentityWait::Observed { elapsed_ms, .. } => ("observed", false, elapsed_ms),
            NativeIdentityWait::ProviderExited { elapsed_ms } => {
                ("provider_exited", false, elapsed_ms)
            }
            NativeIdentityWait::HostUnavailable { elapsed_ms, .. } => {
                ("host_unavailable", false, elapsed_ms)
            }
            NativeIdentityWait::TimedOut {
                adoption_pending,
                elapsed_ms,
            } => ("timed_out", *adoption_pending, elapsed_ms),
            NativeIdentityWait::StopIntent { elapsed_ms } => ("stop_intent", false, elapsed_ms),
            NativeIdentityWait::IntentChanged { elapsed_ms } => {
                ("intent_changed", false, elapsed_ms)
            }
        };
        append_event(
            &self.config.lifecycle_log,
            "supervisor.native_startup_wait_finished",
            serde_json::json!({
                "severity": if matches!(outcome, "observed" | "stop_intent" | "intent_changed") { "info" } else { "warning" },
                "soulId": workload.soul_id, "incarnationId": incarnation_id, "provider": context.provider,
                "intentRevision": intent_revision, "evidenceRevision": context.evidence_revision,
                "executionGeneration": context.native_identity_launch.as_ref().map(|launch| launch.execution_generation),
                "launchNonce": context.native_identity_launch.as_ref().map(|launch| &launch.launch_nonce),
                "outcome": outcome, "reason": outcome, "adoptionPending": adoption_pending, "elapsedMs": elapsed_ms,
                "waitClass": if opencode_readiness { "opencode_tui" } else { "ordinary" },
            }),
        );
        result
    }

    pub(crate) async fn host_status(
        &self,
        incarnation_id: IncarnationId,
        runtime_dir: &Path,
        host: &AuthenticatedHost,
    ) -> Result<HostStatus, RuntimeError> {
        match self
            .send_authenticated_host_command(
                incarnation_id.clone(),
                runtime_dir,
                host,
                HostCommand::Status { incarnation_id },
            )
            .await?
        {
            HostResult::Status {
                native_identity_observation,
                max_execution_generation,
                host_boot_id,
                worker_pid,
                worker_launch_count,
                fixture_evidence,
                exited,
                native_session_id,
                opencode_adoption,
                opencode_transfer_receipt,
                ..
            } => Ok(HostStatus {
                native_identity_observation,
                max_execution_generation,
                host_boot_id,
                worker_pid,
                worker_launch_count,
                fixture_evidence,
                exited,
                native_session_id,
                opencode_adoption,
                opencode_transfer_receipt,
            }),
            _ => Err(RuntimeError::new(
                RuntimeErrorCode::HostAuthenticationFailed,
                "unexpected status reply",
            )),
        }
    }

    pub(crate) async fn send_host_stop(
        &self,
        incarnation_id: IncarnationId,
        runtime_dir: &Path,
        host: &AuthenticatedHost,
    ) -> Result<(), RuntimeError> {
        self.send_host_stop_classified(incarnation_id, runtime_dir, host)
            .await
            .map_err(|failure| failure.error)
    }

    async fn send_host_stop_classified(
        &self,
        incarnation_id: IncarnationId,
        runtime_dir: &Path,
        host: &AuthenticatedHost,
    ) -> Result<(), ClassifiedFailure> {
        let view = find_view(&self.registry, &incarnation_id).await?;
        match self
            .send_authenticated_host_command_classified(
                incarnation_id.clone(),
                runtime_dir,
                host,
                HostCommand::Stop {
                    incarnation_id,
                    control_epoch: self.registry.control_epoch(),
                    execution_generation: view.execution_generation,
                },
            )
            .await?
        {
            HostResult::Stopped => Ok(()),
            _ => Err(RuntimeError::new(
                RuntimeErrorCode::HostAuthenticationFailed,
                "unexpected stop reply",
            )
            .into()),
        }
    }

    pub(crate) async fn send_authenticated_host_command(
        &self,
        incarnation_id: IncarnationId,
        runtime_dir: &Path,
        host: &AuthenticatedHost,
        command: HostCommand,
    ) -> Result<HostResult, RuntimeError> {
        self.send_authenticated_host_command_classified(incarnation_id, runtime_dir, host, command)
            .await
            .map_err(|failure| failure.error)
    }

    async fn send_authenticated_host_command_classified(
        &self,
        incarnation_id: IncarnationId,
        runtime_dir: &Path,
        host: &AuthenticatedHost,
        command: HostCommand,
    ) -> Result<HostResult, ClassifiedFailure> {
        let startup_soul = match &command {
            HostCommand::GrantExecution { soul_id, .. } => Some(soul_id.clone()),
            _ => None,
        };
        let budget = self.host_command_budgets.for_command(&command);
        let command = with_host_dispatch_budget(command, budget);
        let mut envelope = Envelope::new(RequestId::new(), ControlRole::Supervisor, command);
        envelope.auth = Some(host_proof(
            &host.secret,
            "command-auth",
            &host.host_boot_id,
            &incarnation_id,
        ));
        let socket_path = runtime_dir.join("host.sock");
        let exchange = Box::pin(request_host_reply_classified(
            &socket_path,
            &envelope,
            budget,
        ));
        let reply = if let Some(soul) = startup_soul {
            Box::pin(self.await_running_startup(&soul, "execution_grant", exchange)).await??
        } else {
            exchange.await?
        };
        reply.result.map_err(Into::into)
    }

    pub(crate) async fn launch_result_from_status(
        &self,
        incarnation_id: IncarnationId,
        soul_id: SoulId,
        host: AuthenticatedHost,
        status: HostStatus,
        mut fence: RecoveryWriteFence,
    ) -> Result<(LaunchResult, RecoveryWriteFence), RuntimeError> {
        if status.host_boot_id != host.host_boot_id {
            return Err(RuntimeError::new(
                RuntimeErrorCode::HostAuthenticationFailed,
                "status host boot mismatch",
            ));
        }
        let worker_pid = status.worker_pid.ok_or_else(|| {
            RuntimeError::new(
                RuntimeErrorCode::HostUnreachable,
                "RUNNING incarnation has no worker",
            )
        })?;
        if let Some(native_session_id) = status.native_session_id.as_ref() {
            fence = self
                .registry
                .record_native_session_fenced(
                    soul_id,
                    incarnation_id.clone(),
                    native_session_id.clone(),
                    fence,
                )
                .await
                .map_err(map_registry)?;
        }
        let view = find_view(&self.registry, &incarnation_id).await?;
        Ok((
            LaunchResult {
                view,
                worker_pid,
                worker_launch_count: status.worker_launch_count,
                host_boot_id: host.host_boot_id,
                effective_limits: host.effective_limits,
                fixture_evidence: status.fixture_evidence,
            },
            fence,
        ))
    }
}

/// Slow reads need their owning stage in the normal lifecycle diagnostics.
/// Healthy reads do not emit an event, and no provider payload is retained.
struct TerminalOutputReadTiming<'a> {
    log: &'a Path,
    soul: &'a SoulId,
    started: Instant,
    phase_started: Instant,
    phase: &'static str,
    phases: Vec<(&'static str, u64)>,
}

impl<'a> TerminalOutputReadTiming<'a> {
    fn new(log: &'a Path, soul: &'a SoulId) -> Self {
        let started = Instant::now();
        Self {
            log,
            soul,
            started,
            phase_started: started,
            phase: "source_snapshot",
            phases: Vec::new(),
        }
    }

    fn phase(&mut self, phase: &'static str) {
        self.phases.push((
            self.phase,
            self.phase_started
                .elapsed()
                .as_millis()
                .min(u128::from(u64::MAX)) as u64,
        ));
        self.phase = phase;
        self.phase_started = Instant::now();
    }
}

impl Drop for TerminalOutputReadTiming<'_> {
    fn drop(&mut self) {
        if self.started.elapsed() < Duration::from_millis(400) {
            return;
        }
        append_event(
            self.log,
            "supervisor.terminal_output.slow_read",
            serde_json::json!({
                "severity":"warn", "soulId":self.soul,
                "elapsedMs":self.started.elapsed().as_millis() as u64,
                "phase":self.phase,
                "phaseElapsedMs":self.phase_started.elapsed().as_millis() as u64,
                "phasesMs":self.phases.iter().copied().collect::<std::collections::BTreeMap<_,_>>(),
            }),
        );
    }
}

fn current_claude_clear_observation<'a>(
    context: &crate::registry::RecoveryContext,
    status: &'a HostStatus,
) -> Option<&'a freshell_runtime_protocol::NativeIdentityObservation> {
    let launch = context.native_identity_launch.as_ref()?;
    let observation = status.native_identity_observation.as_ref()?;
    (!status.exited
        && observation.source == freshell_runtime_protocol::NativeIdentitySource::ClaudeNativeClear
        && observation.matches_provider(&context.provider, context.fresh_agent.is_some())
        && observation.matches_launch(launch)
        && observation.incarnation_id == *context.prior_handle.incarnation_id()
        && launch.launch_nonce == context.prior_handle.launch_nonce().as_str()
        && launch.execution_generation == status.max_execution_generation
        && status.native_session_id.as_deref() == Some(observation.native_session_id.as_str())
        && context
            .native_session_id
            .as_deref()
            .is_some_and(|root| root != observation.native_session_id))
    .then_some(observation)
}

pub(crate) async fn record_terminal_identity_observation(
    registry: &Registry,
    context: &crate::registry::RecoveryContext,
    native_session_id: &str,
) -> Result<(), RuntimeError> {
    let incarnation = context.prior_handle.incarnation_id().clone();
    let fence = context.write_fence();
    if let Some(prior) = context
        .native_session_id
        .as_deref()
        .filter(|prior| *prior != native_session_id)
    {
        if !matches!(context.provider.as_str(), "claude" | "opencode") {
            return Err(map_registry(RegistryError::NativeIdentityConflict));
        }
        registry
            .transition_native_session_fenced(
                context.soul_id.clone(),
                incarnation,
                prior,
                native_session_id,
                fence,
            )
            .await
            .map_err(map_registry)?;
    } else {
        registry
            .record_native_session_fenced(
                context.soul_id.clone(),
                incarnation,
                native_session_id.into(),
                fence,
            )
            .await
            .map_err(map_registry)?;
    }
    Ok(())
}

fn ensure_host_actor_state_dir(
    runtime_root: &Path,
    installation_id: &freshell_runtime_protocol::InstallationId,
    soul_id: &SoulId,
) -> Result<PathBuf, RuntimeError> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let actor_dir = host_actor_state_dir(runtime_root, installation_id, soul_id);
    let souls_dir = actor_dir.parent().and_then(Path::parent).ok_or_else(|| {
        RuntimeError::new(
            RuntimeErrorCode::InvalidRequest,
            "invalid actor storage path",
        )
    })?;
    let soul_dir = actor_dir.parent().expect("actor dir has soul parent");
    for directory in [souls_dir, soul_dir, actor_dir.as_path()] {
        match std::fs::symlink_metadata(directory) {
            Ok(metadata) => {
                if !metadata.is_dir()
                    || metadata.file_type().is_symlink()
                    || metadata.uid() != unsafe { libc::geteuid() }
                    || metadata.permissions().mode() & 0o777 != 0o700
                {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::OwnershipMismatch,
                        format!(
                            "host actor storage ownership changed: {}",
                            directory.display()
                        ),
                    ));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(directory).map_err(io_runtime)?;
                std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))
                    .map_err(io_runtime)?;
            }
            Err(error) => return Err(io_runtime(error)),
        }
    }
    let canonical = std::fs::canonicalize(&actor_dir).map_err(io_runtime)?;
    if canonical != actor_dir {
        return Err(RuntimeError::new(
            RuntimeErrorCode::OwnershipMismatch,
            "host actor storage escaped its soul path",
        ));
    }
    Ok(canonical)
}

#[derive(Clone)]
pub(crate) struct AuthenticatedHost {
    pub(crate) capabilities: Vec<String>,
    host_boot_id: HostBootId,
    secret: Vec<u8>,
    effective_limits: RuntimeLimits,
}
pub(crate) struct AcceptedGrant {
    native_identity_observation: Option<freshell_runtime_protocol::NativeIdentityObservation>,
    host_boot_id: HostBootId,
    worker_pid: u32,
    worker_launch_count: u64,
    fixture_evidence: serde_json::Value,
    native_session_id: Option<String>,
    opencode_transfer_receipt: Option<OpenCodeTransferReadinessReceipt>,
}
pub(crate) struct HostStatus {
    pub(crate) max_execution_generation: u64,
    pub(crate) native_identity_observation:
        Option<freshell_runtime_protocol::NativeIdentityObservation>,
    pub(crate) host_boot_id: HostBootId,
    pub(crate) worker_pid: Option<u32>,
    pub(crate) worker_launch_count: u64,
    pub(crate) fixture_evidence: serde_json::Value,
    pub(crate) exited: bool,
    pub(crate) native_session_id: Option<String>,
    pub(crate) opencode_adoption: freshell_runtime_protocol::OpenCodeAdoptionStatus,
    pub(crate) opencode_transfer_receipt: Option<OpenCodeTransferReadinessReceipt>,
}

pub async fn serve_control(supervisor: Supervisor, socket_path: &Path) -> Result<(), String> {
    if let Err(error) = supervisor.resume_pending_stopped_repair_withdrawals().await {
        append_event(
            &supervisor.config.lifecycle_log,
            "supervisor.stopped_repair_withdrawal_startup_deferred",
            serde_json::json!({"error":error.message}),
        );
    }
    if let Some(parent) = socket_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if socket_path.exists() {
        std::fs::remove_file(socket_path).map_err(|e| e.to_string())?;
    }
    let listener = UnixListener::bind(socket_path).map_err(|e| e.to_string())?;
    set_mode(socket_path, 0o600)?;
    append_event(
        &supervisor.config.lifecycle_log,
        "supervisor.ready",
        serde_json::json!({"installationId":supervisor.registry.installation_id(),"controlEpoch":supervisor.registry.control_epoch(),"socket":socket_path}),
    );
    let cleanup_supervisor = supervisor.clone();
    tokio::spawn(async move {
        if let Err(error) = cleanup_supervisor.cleanup_opencode_transfer_staging().await {
            append_event(
                &cleanup_supervisor.config.lifecycle_log,
                "supervisor.opencode_transfer_startup_cleanup_deferred",
                serde_json::json!({"error":error.message}),
            );
        }
    });
    let staging_cleanup_supervisor = supervisor.clone();
    tokio::spawn(async move {
        loop {
            sleep(Duration::from_secs(5 * 60)).await;
            if let Err(error) = staging_cleanup_supervisor
                .cleanup_opencode_transfer_staging()
                .await
            {
                append_event(
                    &staging_cleanup_supervisor.config.lifecycle_log,
                    "supervisor.opencode_transfer_cleanup_deferred",
                    serde_json::json!({"error":error.message}),
                );
            }
        }
    });
    loop {
        let (stream, _) = listener.accept().await.map_err(|e| e.to_string())?;
        tokio::spawn(serve_control_connection(supervisor.clone(), stream));
    }
}

/// Answers the one request a control connection carries.
///
/// The connection lets go of its supervisor handle before it writes the
/// reply. A client holding its answer may then hand the registry to a
/// successor at once: this connection no longer keeps the registry owned,
/// however long its worker is descheduled before the task finishes.
async fn serve_control_connection<S>(supervisor: Supervisor, mut stream: S)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let envelope: Result<Envelope<AdminCommand>, _> = read_frame(&mut stream).await;
    let reply = match envelope {
        Ok(envelope) => supervisor.dispatch(envelope).await,
        Err(error) => AdminReply {
            request_id: RequestId::new(),
            result: Err(RuntimeError::new(
                if matches!(error, freshell_runtime_protocol::FrameError::TooLarge) {
                    RuntimeErrorCode::FrameTooLarge
                } else {
                    RuntimeErrorCode::InvalidRequest
                },
                error.to_string(),
            )),
        },
    };
    drop(supervisor);
    let limit = if matches!(
        reply.result,
        Ok(AdminResult::FreshAgentHistory(_) | AdminResult::FreshAgentSnapshot(_))
    ) {
        freshell_runtime_protocol::MAX_NATIVE_HISTORY_FRAME_BYTES
    } else {
        freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES
    };
    let _ = freshell_runtime_protocol::write_frame_with_limit(&mut stream, &reply, limit).await;
}

/// The Docker backend. Its helper retry and late-cleanup events go to the
/// supervisor's lifecycle JSONL.
pub fn default_backend(
    socket: impl Into<PathBuf>,
    lifecycle_log: impl Into<PathBuf>,
) -> Arc<dyn RuntimeBackend> {
    Arc::new(DockerEngineBackend::new(socket).with_lifecycle_log(lifecycle_log))
}

/// Default bound on one supervisor→session-host control round trip.
///
/// The supervisor is the sole runtime authority; a session host is an
/// untrusted workload boundary. An unresponsive (or maliciously silent) host
/// must never be able to hold an authoritative transaction — above all
/// `stop` — open forever. Exceeding the budget is a typed, recoverable
/// `HostUnreachable`, after which the caller proceeds through the
/// Docker-level path it already owns.
pub(crate) const DEFAULT_HOST_COMMAND_TIMEOUT_MS: u64 = 10_000;

pub(crate) const HOST_COMMAND_TIMEOUT_ENV: &str = "FRESHELL_RUNTIME_HOST_COMMAND_TIMEOUT_MS";
pub(crate) const DEFAULT_FRESH_AGENT_COMMAND_TIMEOUT_MS: u64 = 60_000;
pub(crate) const FRESH_AGENT_COMMAND_TIMEOUT_ENV: &str =
    "FRESHELL_RUNTIME_FRESH_AGENT_COMMAND_TIMEOUT_MS";

/// Default wait for a terminal execution grant's reply.
///
/// A terminal grant is not a control round trip: it is the native dispatch
/// boundary. Before the host can reply it projects the selected provider
/// inputs and starts the provider, and some of those steps have long bounds of
/// their own. One Codex app-server start may take up to 45 s
/// (`freshell_codex::launch_lifecycle::SIDECAR_START_BUDGET`) and a terminal
/// start retries it up to five times (about 251 s worst case); an exact
/// resume first runs the provider-owned config refresh (25 s, plus up to 32 s
/// of projection recovery). No fixed wait covers every such sum, so this is a
/// policy bound on one dispatch, roughly ten times a healthy one (4-6 s
/// measured with a 4,200-file selected plugin). The host is told its share of
/// it with the grant ([`host_dispatch_budget`]) and stops there itself,
/// refusing typed and naming the stage it was in, so the supervisor never
/// abandons a dispatch the host is still working on; the recovery policy then
/// decides whether a fresh incarnation tries again.
pub(crate) const DEFAULT_TERMINAL_DISPATCH_TIMEOUT_MS: u64 = 60_000;
pub(crate) const TERMINAL_DISPATCH_TIMEOUT_ENV: &str =
    "FRESHELL_RUNTIME_TERMINAL_DISPATCH_TIMEOUT_MS";

/// Resolve the round-trip budget. Absent, unparseable, or zero configuration
/// falls back to the default: the failure direction is always a bounded wait,
/// never an unbounded one.
pub(crate) fn host_command_budget(configured: Option<&str>) -> Duration {
    configured
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|ms| *ms > 0)
        .map(Duration::from_millis)
        .unwrap_or(Duration::from_millis(DEFAULT_HOST_COMMAND_TIMEOUT_MS))
}

pub(crate) fn fresh_agent_command_budget(configured: Option<&str>) -> Duration {
    configured
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|ms| *ms > 0)
        .map(Duration::from_millis)
        .unwrap_or(Duration::from_millis(
            DEFAULT_FRESH_AGENT_COMMAND_TIMEOUT_MS,
        ))
}

pub(crate) fn terminal_dispatch_budget(configured: Option<&str>) -> Duration {
    configured
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|ms| *ms > 0)
        .map(Duration::from_millis)
        .unwrap_or(Duration::from_millis(DEFAULT_TERMINAL_DISPATCH_TIMEOUT_MS))
}

/// The part of an execution grant's wait the supervisor reserves for the
/// reply itself: the frame round trip, plus a synchronous host stage (the
/// provider projection, the provider-owned refresh) that cannot be cut at the
/// deadline and is only noticed when it returns.
pub(crate) const GRANT_REPLY_ALLOWANCE: Duration = Duration::from_secs(5);

/// How long the host may spend dispatching a grant the supervisor waits
/// `wait` for: the wait less [`GRANT_REPLY_ALLOWANCE`], and never less than
/// half of it, so a short configured wait still leaves the host time to work.
pub(crate) fn host_dispatch_budget(wait: Duration) -> Duration {
    wait.saturating_sub(GRANT_REPLY_ALLOWANCE).max(wait / 2)
}

/// Tell the host the dispatch budget of a grant from the wait that bounds its
/// reply, so the host refuses typed before the supervisor gives up on it.
fn with_host_dispatch_budget(mut command: HostCommand, wait: Duration) -> HostCommand {
    if let HostCommand::GrantExecution {
        dispatch_budget_ms, ..
    } = &mut command
    {
        *dispatch_budget_ms =
            Some(u64::try_from(host_dispatch_budget(wait).as_millis()).unwrap_or(u64::MAX));
    }
    command
}

/// How long the supervisor waits for a session host's reply, by what
/// answering the command makes the host do. Resolved once from the
/// environment when the supervisor starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct HostCommandBudgets {
    /// One control round trip: hello, status, stop, terminal I/O, probes.
    pub(crate) control: Duration,
    /// A terminal execution grant: provider preparation plus native dispatch.
    pub(crate) terminal_dispatch: Duration,
    /// A fresh-agent execution grant or turn operation.
    pub(crate) fresh_agent: Duration,
    terminal_dispatch_override: Option<Duration>,
    fresh_agent_override: Option<Duration>,
}

impl HostCommandBudgets {
    pub(crate) fn from_env() -> Self {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    pub(crate) fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Self {
        let terminal = lookup(TERMINAL_DISPATCH_TIMEOUT_ENV);
        let fresh = lookup(FRESH_AGENT_COMMAND_TIMEOUT_ENV);
        let configured = |value: Option<&str>| {
            value
                .and_then(|value| value.trim().parse::<u64>().ok())
                .filter(|ms| *ms > 0)
                .map(Duration::from_millis)
        };
        Self {
            control: host_command_budget(lookup(HOST_COMMAND_TIMEOUT_ENV).as_deref()),
            terminal_dispatch: terminal_dispatch_budget(terminal.as_deref()),
            fresh_agent: fresh_agent_command_budget(fresh.as_deref()),
            terminal_dispatch_override: configured(terminal.as_deref()),
            fresh_agent_override: configured(fresh.as_deref()),
        }
    }

    pub(crate) fn for_command(&self, command: &HostCommand) -> Duration {
        if let Some(startup) = grant_startup_budget(command) {
            return if matches!(
                command,
                HostCommand::GrantExecution {
                    fresh_agent: Some(_),
                    ..
                }
            ) {
                self.fresh_agent_override
                    .unwrap_or(startup.max(self.fresh_agent))
            } else {
                self.terminal_dispatch_override
                    .unwrap_or(startup.max(self.terminal_dispatch))
            };
        }
        if uses_fresh_agent_command_budget(command) {
            self.fresh_agent
        } else if matches!(
            command,
            HostCommand::GrantExecution {
                terminal: Some(_),
                ..
            }
        ) {
            self.terminal_dispatch
        } else {
            self.control
        }
    }
}

/// Room between the end of a Claude source read, its owned cleanup included,
/// and the end of the supervisor's wait for it: the reply's slack. Outside a
/// recovery an observation therefore waits the fixed reader's whole bounded
/// retry ([`crate::backend::CLAUDE_SOURCE_READER_RETRY`], 90s) plus this.
pub(crate) const CLAUDE_SOURCE_REPLY_SLACK: Duration = Duration::from_secs(5);

/// One Claude source observation whose fixed reader succeeds on its first
/// attempt: that attempt, its owned cleanup and the reply slack (35s).
pub(crate) const CLAUDE_SOURCE_FIRST_ATTEMPT_BUDGET: Duration = Duration::from_secs(
    crate::backend::CLAUDE_SOURCE_READER_RETRY.attempt.as_secs()
        + crate::backend::CLAUDE_SOURCE_READER_RETRY.cleanup.as_secs()
        + CLAUDE_SOURCE_REPLY_SLACK.as_secs(),
);

/// Wait for one provider-preparation callback to the web server, covering the
/// web server's own work for it (selecting and copying the provider's inputs).
pub(crate) const PROVIDER_CALLBACK_BUDGET: Duration = Duration::from_secs(35);

/// Wait for a Claude recovery's `issue` callback. Before it answers,
/// the web server observes the current Claude sources and then the candidate
/// projection, back to back, each through this supervisor. The wait covers
/// the callback's own work plus two observations whose readers succeed on
/// their first attempt ([`CLAUDE_SOURCE_FIRST_ATTEMPT_BUDGET`]). The candidate
/// also projects the frozen prior inputs and the new ordinary inputs, each
/// within the existing provider refresh bound. A reader
/// that needs a retry runs inside what is left of the recovery scope, which
/// lives exactly as long as this wait: the supervisor ends every recovery
/// observation, its owned cleanup included, a reply slack before the scope
/// does, so a retry never outlives the callback it serves.
pub(crate) const CLAUDE_RECOVERY_CALLBACK_BUDGET: Duration = Duration::from_secs(
    PROVIDER_CALLBACK_BUDGET.as_secs()
        + 2 * CLAUDE_SOURCE_FIRST_ATTEMPT_BUDGET.as_secs()
        + 2 * freshell_platform::provider_startup::PROVIDER_REFRESH_RUN.as_secs(),
);

/// How long the supervisor waits for a provider-preparation callback. The
/// recovery scope a callback carries lives exactly as long, so a nested
/// lookup made inside the callback's wait never finds its scope expired.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ProviderCallbackBudgets {
    pub(crate) ordinary: Duration,
    pub(crate) claude_recovery: Duration,
}

impl Default for ProviderCallbackBudgets {
    fn default() -> Self {
        Self {
            ordinary: PROVIDER_CALLBACK_BUDGET,
            claude_recovery: CLAUDE_RECOVERY_CALLBACK_BUDGET,
        }
    }
}

impl ProviderCallbackBudgets {
    pub(crate) fn for_callback(&self, claude_recovery: bool) -> Duration {
        if claude_recovery {
            self.claude_recovery
        } else {
            self.ordinary
        }
    }
}

fn grant_startup_budget(command: &HostCommand) -> Option<Duration> {
    if let HostCommand::GrantExecution {
        terminal,
        fresh_agent,
        ..
    } = command
    {
        let provider = terminal
            .as_ref()
            .map(|spec| spec.mode.as_str())
            .or_else(|| {
                fresh_agent
                    .as_ref()
                    .map(|spec| spec.provider.native_provider())
            });
        if let Some(provider) = provider.filter(|provider| {
            matches!(
                *provider,
                "codex" | "opencode" | "claude" | "amplifier" | "kilroy"
            )
        }) {
            use freshell_platform::provider_startup as startup;
            // Preparation, final selection/auth readers, then actual native
            // dispatch complete before GrantAccepted may carry a worker PID.
            let readers = if matches!(provider, "claude" | "kilroy" | "opencode") {
                startup::PROVIDER_METADATA_READ_RUN + startup::PROVIDER_METADATA_READ_CLEANUP
            } else {
                Duration::ZERO
            };
            let native = if fresh_agent.is_some() {
                let bootstrap = match provider {
                    "codex" => freshell_codex::launch_plan::managed_fresh_startup_budget(),
                    "claude" | "kilroy" => startup::CLAUDE_SIDECAR_CREATE,
                    "opencode" => startup::HOSTED_CREATE_WAIT,
                    _ => Duration::ZERO,
                };
                bootstrap + startup::HOSTED_CREATE_WAIT * 2
            } else if provider == "codex" {
                freshell_codex::launch_plan::managed_sidecar_startup_budget()
            } else {
                Duration::ZERO
            };
            let startup = Duration::from_millis(DEFAULT_HOST_COMMAND_TIMEOUT_MS)
                + startup::provider_refresh_completion_budget()
                + startup::PROVIDER_ENDPOINT_WAIT
                + readers
                + native;
            return Some(startup);
        }
    }
    None
}

fn map_host_frame_error(error: freshell_runtime_protocol::FrameError) -> RuntimeError {
    let code = match error {
        freshell_runtime_protocol::FrameError::Io(_) => RuntimeErrorCode::HostUnreachable,
        _ => RuntimeErrorCode::HostAuthenticationFailed,
    };
    RuntimeError::new(code, error.to_string()).with_diagnostic_code(
        freshell_runtime_protocol::RuntimeDiagnosticCode::HostCommandFrameFailed,
    )
}

/// One bounded framed request/reply against a session host's control socket.
/// Connect, write, and read all share the single budget so a host that accepts
/// the connection and then goes silent cannot extend the wait.
#[cfg(test)]
async fn request_host_reply(
    socket_path: &Path,
    envelope: &Envelope<HostCommand>,
    budget: Duration,
) -> Result<HostReply, RuntimeError> {
    request_host_reply_classified(socket_path, envelope, budget)
        .await
        .map_err(|failure| failure.error)
}

async fn request_host_reply_classified(
    socket_path: &Path,
    envelope: &Envelope<HostCommand>,
    budget: Duration,
) -> Result<HostReply, ClassifiedFailure> {
    let unreachable = |message: String| {
        RuntimeError::new(RuntimeErrorCode::HostUnreachable, message).with_diagnostic_code(
            freshell_runtime_protocol::RuntimeDiagnosticCode::HostSocketConnectFailed,
        )
    };
    let socket_display = socket_path.display().to_string();
    tokio::time::timeout(budget, async {
        let mut stream = UnixStream::connect(socket_path)
            .await
            .map_err(|error| unreachable(error.to_string()))?;
        write_frame(&mut stream, envelope)
            .await
            .map_err(map_host_frame_error)?;
        let reply_limit = if matches!(envelope.body, HostCommand::FreshAgentReadSnapshot { .. }) {
            freshell_runtime_protocol::MAX_NATIVE_HISTORY_FRAME_BYTES
        } else {
            freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES
        };
        let reply: HostReply =
            freshell_runtime_protocol::read_frame_with_limit(&mut stream, reply_limit)
                .await
                .map_err(map_host_frame_error)?;
        Ok::<_, ClassifiedFailure>(reply)
    })
    .await
    .unwrap_or_else(|_| {
        Err(ClassifiedFailure::timeout(
            RuntimeError::new(
                RuntimeErrorCode::HostUnreachable,
                format!(
                    "session host {socket_display} timed out after {}ms",
                    budget.as_millis()
                ),
            )
            .with_diagnostic_code(
                freshell_runtime_protocol::RuntimeDiagnosticCode::HostCommandTimeout,
            ),
        ))
    })
}

/// Bounded write/read on an already-connected host stream. Connecting is the
/// caller's business (the hello handshake retries a not-yet-bound socket);
/// the conversation itself is bounded exactly like every other host command.
async fn exchange_host_frame_classified(
    stream: &mut UnixStream,
    envelope: &Envelope<HostCommand>,
    budget: Duration,
    socket_path: &Path,
) -> Result<HostReply, ClassifiedFailure> {
    let socket_display = socket_path.display().to_string();
    tokio::time::timeout(budget, async {
        write_frame(stream, envelope)
            .await
            .map_err(map_host_frame_error)?;
        let reply: HostReply = read_frame(stream).await.map_err(map_host_frame_error)?;
        Ok::<_, ClassifiedFailure>(reply)
    })
    .await
    .unwrap_or_else(|_| {
        Err(ClassifiedFailure::timeout(
            RuntimeError::new(
                RuntimeErrorCode::HostUnreachable,
                format!(
                    "session host {socket_display} timed out after {}ms",
                    budget.as_millis()
                ),
            )
            .with_diagnostic_code(
                freshell_runtime_protocol::RuntimeDiagnosticCode::HostCommandTimeout,
            ),
        ))
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FreshAgentNativeIdentityUpdate {
    Unchanged,
    Record,
    Transition,
}

fn classify_fresh_agent_operation_identity(
    current_native: Option<&str>,
    observed_native: Option<&str>,
) -> Result<FreshAgentNativeIdentityUpdate, RuntimeError> {
    let Some(observed_native) = observed_native else {
        return Ok(FreshAgentNativeIdentityUpdate::Unchanged);
    };
    if observed_native.is_empty() || observed_native.chars().any(char::is_control) {
        return Err(RuntimeError::new(
            RuntimeErrorCode::OwnershipMismatch,
            "fresh-agent operation returned an invalid native session identity",
        ));
    }
    match current_native {
        None => Ok(FreshAgentNativeIdentityUpdate::Record),
        Some(current) if current == observed_native => {
            Ok(FreshAgentNativeIdentityUpdate::Unchanged)
        }
        Some(_) => Ok(FreshAgentNativeIdentityUpdate::Transition),
    }
}

fn classify_fresh_agent_fork_transition(
    current_native: &str,
    transition: &freshell_runtime_protocol::FreshAgentForkResult,
) -> Result<bool, RuntimeError> {
    if transition.parent_session_id.is_empty()
        || transition.child_session_id.is_empty()
        || transition.parent_session_id == transition.child_session_id
        || !transition.parent_retired_by_runtime
    {
        return Err(RuntimeError::new(
            RuntimeErrorCode::OwnershipMismatch,
            "fresh-agent fork did not prove a valid in-soul parent-to-child transition",
        ));
    }
    if current_native == transition.parent_session_id {
        return Ok(false);
    }
    if current_native == transition.child_session_id {
        return Ok(true);
    }
    Err(RuntimeError::new(
        RuntimeErrorCode::OwnershipMismatch,
        "fresh-agent fork transition does not match the current native session",
    ))
}

fn release_qualified_workload(
    provider: &str,
    is_fixture: bool,
    has_terminal: bool,
    fresh_agent: Option<&FreshAgentLaunchSpec>,
) -> bool {
    is_fixture
        || fresh_agent.is_some_and(|agent| {
            agent.provider.as_str() == provider
                && (crate::registry::deterministic_fresh_agent_fixture(provider, agent)
                    || freshell_agent_runtime::managed_native_fresh_agent_enabled(
                        &agent.provider,
                        &agent.session_type,
                    ))
        })
        || (has_terminal && freshell_agent_runtime::managed_provider_enabled(provider))
}

/// Host commands that wait on a provider (a turn, a compaction, a settings
/// apply, a rollback, a launch) get the long fresh-agent budget instead of
/// the control budget.
pub(crate) fn uses_fresh_agent_command_budget(command: &HostCommand) -> bool {
    matches!(
        command,
        HostCommand::FreshAgentPrepareNative { .. }
            | HostCommand::FreshAgentSend { .. }
            | HostCommand::FreshAgentCompact { .. }
            | HostCommand::FreshAgentConfigure { .. }
            | HostCommand::FreshAgentRollback { .. }
            | HostCommand::GrantExecution {
                fresh_agent: Some(_),
                ..
            }
    )
}

#[cfg(test)]
#[path = "fresh_agent_configure_tests.rs"]
mod fresh_agent_configure_tests;

fn validate_opencode_transfer_receipt(
    descriptor: Option<&freshell_runtime_protocol::OpenCodeTransferDescriptor>,
    provider_identity: Option<(u32, u32)>,
    receipt: Option<OpenCodeTransferReadinessReceipt>,
) -> Result<Option<OpenCodeTransferReadinessReceipt>, RuntimeError> {
    match (descriptor, provider_identity, receipt) {
        (None, None, None) => Ok(None),
        (Some(descriptor), Some((uid, gid)), Some(receipt))
            if receipt.matches_descriptor(descriptor)
                && receipt.provider_uid == uid
                && receipt.provider_gid == gid =>
        {
            Ok(Some(receipt))
        }
        _ => Err(RuntimeError::new(
            RuntimeErrorCode::HostAuthenticationFailed,
            "host grant acknowledgement has no matching OpenCode readiness receipt",
        )),
    }
}

#[cfg(test)]
mod grant_identity_tests {
    use super::*;
    use freshell_runtime_protocol::{
        FreshAgentFixtureTransport, FreshProvider, NativeIdentityObservation, NativeIdentitySource,
    };
    use rusqlite::{params, Connection};

    #[tokio::test]
    async fn authenticated_grant_root_preserves_native_proof_and_typed_fixture_binding() {
        for case in [
            "ordinary-raw",
            "current-proof",
            "wrong-nonce",
            "wrong-revision",
            "wrong-incarnation",
            "wrong-source",
            "wrong-proof-root",
            "fixture",
            "absent-root",
            "empty-root",
            "control-root",
            "wrong-requested-root",
            "wrong-mode",
            "wrong-provider",
            "wrong-profile",
            "wrong-boot",
            "fixture-stale-proof",
            "untyped-evidence",
            "bad-auth",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let registry = Registry::open(dir.path().join("registry"), None).unwrap();
            let soul = SoulId::new();
            let prepared = crate::registry::tests::materialize_fresh_runtime(
                &registry,
                soul.clone(),
                dir.path(),
            )
            .await;
            let runtime = dir.path().join("owned-host");
            std::fs::create_dir(&runtime).unwrap();
            std::fs::write(runtime.join("secret"), b"synthetic-secret").unwrap();
            let mut agent = registry
                .recovery_context(soul.clone())
                .await
                .unwrap()
                .fresh_agent
                .unwrap();
            let fixture = matches!(
                case,
                "fixture"
                    | "absent-root"
                    | "empty-root"
                    | "control-root"
                    | "wrong-requested-root"
                    | "wrong-mode"
                    | "wrong-provider"
                    | "wrong-profile"
                    | "wrong-boot"
                    | "fixture-stale-proof"
            );
            agent.fixture_transport = fixture.then_some(FreshAgentFixtureTransport::Deterministic);
            if case == "wrong-mode" {
                agent.session_type = "freshcodex".into();
            }
            if case == "wrong-provider" {
                agent.provider = FreshProvider::Codex;
                agent.session_type = "freshcodex".into();
            }
            let conn = Connection::open(dir.path().join("registry/runtime.sqlite3")).unwrap();
            conn.execute("UPDATE incarnations SET runtime_dir=?1,fresh_agent_spec=?2,fixture_kind=NULL,launch_state='created' WHERE incarnation_id=?3",
                params![runtime.to_string_lossy(), serde_json::to_string(&agent).unwrap(), prepared.incarnation_id.as_str()]).unwrap();
            if matches!(case, "wrong-requested-root" | "wrong-proof-root") {
                conn.execute(
                    "UPDATE souls SET native_session_id='requested-root' WHERE soul_id=?1",
                    [soul.as_str()],
                )
                .unwrap();
            }
            let supervisor = crate::recovery::tests::supervisor_with_runtime_state(
                &dir,
                registry.clone(),
                crate::backend::BackendRuntimeState::Running,
            );
            let handle = registry
                .owned_handle(prepared.incarnation_id.clone())
                .await
                .unwrap();
            let listener = UnixListener::bind(runtime.join("host.sock")).unwrap();
            let expected_handle = handle.clone();
            // Controlled proof shapes test admission, not native qualification.
            let responder = tokio::spawn(async move {
                let boot = HostBootId::new();
                let mut reply_observation = None;
                for step in 0..if case == "bad-auth" { 1 } else { 2 } {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let request: Envelope<HostCommand> = read_frame(&mut socket).await.unwrap();
                    assert_eq!(request.role, ControlRole::Supervisor);
                    let result = match request.body {
                        HostCommand::Hello {
                            incarnation_id,
                            challenge,
                        } if step == 0 => {
                            assert_eq!(&incarnation_id, expected_handle.incarnation_id());
                            HostResult::Hello {
                                proof: if case == "bad-auth" {
                                    "invalid-proof".into()
                                } else {
                                    host_proof(
                                        b"synthetic-secret",
                                        &challenge,
                                        &boot,
                                        &incarnation_id,
                                    )
                                },
                                host_boot_id: boot.clone(),
                                capabilities: vec![],
                                effective_limits: expected_handle.requested_limits(),
                            }
                        }
                        HostCommand::GrantExecution {
                            incarnation_id,
                            soul_id,
                            host_boot_id,
                            control_epoch,
                            execution_generation,
                            native_identity_launch,
                            fresh_agent,
                            ..
                        } if step == 1 => {
                            assert_eq!(&incarnation_id, expected_handle.incarnation_id());
                            assert_eq!(&soul_id, expected_handle.soul_id());
                            assert_eq!(host_boot_id, boot);
                            assert!(control_epoch > 0 && execution_generation > 0);
                            if case == "wrong-profile" {
                                assert_ne!(fresh_agent.as_deref(), expected_handle.fresh_agent());
                            } else {
                                assert_eq!(fresh_agent.as_deref(), expected_handle.fresh_agent());
                            }
                            assert_eq!(
                                request.auth.as_deref(),
                                Some(
                                    host_proof(
                                        b"synthetic-secret",
                                        "command-auth",
                                        &boot,
                                        &incarnation_id
                                    )
                                    .as_str()
                                )
                            );
                            let launch = native_identity_launch.unwrap();
                            assert_eq!(
                                launch.launch_nonce,
                                expected_handle.launch_nonce().as_str()
                            );
                            assert_eq!(launch.execution_generation, execution_generation);
                            if case == "current-proof"
                                || case == "fixture-stale-proof"
                                || case.starts_with("wrong-") && !fixture
                            {
                                let mut observation = NativeIdentityObservation {
                                    native_session_id: "proof-root".into(),
                                    incarnation_id: incarnation_id.clone(),
                                    launch_nonce: launch.launch_nonce,
                                    evidence_revision: launch.evidence_revision,
                                    source: NativeIdentitySource::FreshProviderHandshake,
                                    evidence_digest: "a".repeat(64),
                                };
                                match case {
                                    "wrong-nonce" | "fixture-stale-proof" => {
                                        observation.launch_nonce = "another-launch".into()
                                    }
                                    "wrong-revision" => observation.evidence_revision += 1,
                                    "wrong-incarnation" => {
                                        observation.incarnation_id = IncarnationId::new()
                                    }
                                    "wrong-source" => {
                                        observation.source = NativeIdentitySource::ClaudeNativeEvent
                                    }
                                    _ => {}
                                }
                                reply_observation = Some(observation);
                            }
                            HostResult::GrantAccepted {
                                host_boot_id: if case == "wrong-boot" {
                                    HostBootId::new()
                                } else {
                                    boot.clone()
                                },
                                worker_pid: 123,
                                worker_launch_count: 1,
                                fixture_evidence: serde_json::json!({"fixtureTransport":"deterministic"}),
                                native_session_id: match case {
                                    "absent-root" => None,
                                    "empty-root" => Some(String::new()),
                                    "control-root" => Some("invalid\nroot".into()),
                                    _ => Some("raw-root".into()),
                                },
                                native_identity_observation: reply_observation.clone(),
                                opencode_transfer_receipt: None,
                                opencode_adoption: Default::default(),
                            }
                        }
                        _ => panic!(
                            "grant consumer must not dispatch input, Status or provider probes"
                        ),
                    };
                    write_frame(
                        &mut socket,
                        &HostReply {
                            request_id: request.request_id,
                            result: Ok(result),
                        },
                    )
                    .await
                    .unwrap();
                }
                reply_observation
            });
            let authenticated = supervisor
                .authenticate_host(handle.incarnation_id(), handle.runtime_dir())
                .await;
            if case == "bad-auth" {
                assert!(matches!(
                    authenticated,
                    Err(RuntimeError {
                        code: RuntimeErrorCode::HostAuthenticationFailed,
                        ..
                    })
                ));
                tokio::time::timeout(Duration::from_secs(5), responder)
                    .await
                    .unwrap()
                    .unwrap();
                assert!(registry
                    .recovery_context(soul)
                    .await
                    .unwrap()
                    .native_identity_launch
                    .is_none());
                continue;
            }
            let host = authenticated.unwrap();
            let grant = registry
                .commit_execution_grant(
                    handle.incarnation_id().clone(),
                    host.host_boot_id.clone(),
                    handle.requested_limits(),
                )
                .await
                .unwrap();
            // Issuing the initialization grant already makes provider execution
            // uncertain. The grant consumer must preserve that post-grant state.
            let was_never_dispatched = registry
                .recovery_context(soul.clone())
                .await
                .unwrap()
                .never_dispatched;
            assert!(
                !was_never_dispatched,
                "{case}: an issued grant is not pristine"
            );
            if case == "wrong-profile" {
                agent.model = Some("changed-unregistered-profile".into());
            }
            let workload = LaunchWorkload {
                soul_id: soul.clone(),
                fixture: None,
                terminal: None,
                fresh_agent: Some(agent),
                resume_spec: None,
            };
            let accepted = supervisor
                .send_grant(&handle, &workload, &host, &grant)
                .await
                .unwrap();
            let observation = tokio::time::timeout(Duration::from_secs(5), responder)
                .await
                .unwrap()
                .unwrap();
            let expected = match case {
                "fixture" => Some("raw-root"),
                "current-proof" => Some("proof-root"),
                _ => None,
            };
            assert_eq!(accepted.native_session_id.as_deref(), expected, "{case}");
            assert_eq!(accepted.native_identity_observation, observation, "{case}");
            let context = registry.recovery_context(soul).await.unwrap();
            assert_eq!(context.never_dispatched, was_never_dispatched);
            assert_eq!(context.accepted_command_count, 0);
            assert_eq!(context.completed_command_count, 0);
            assert!(UnixStream::connect(runtime.join("host.sock"))
                .await
                .is_err());
            let mut stale_grant = grant.clone();
            stale_grant.execution_generation += 1;
            let stale = supervisor
                .send_grant(&handle, &workload, &host, &stale_grant)
                .await;
            assert!(matches!(
                stale,
                Err(RuntimeError {
                    code: RuntimeErrorCode::RegistryFailure,
                    ..
                })
            ));
        }
    }
}

#[cfg(test)]
mod host_actor_storage_tests {
    use super::ensure_host_actor_state_dir;
    use freshell_runtime_protocol::{InstallationId, SoulId};
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn actor_state_is_private_per_soul_and_survives_incarnation_replacement() {
        let root = tempfile::tempdir().unwrap();
        let installation = InstallationId::parse("installation-one").unwrap();
        let first = SoulId::parse("soul-first").unwrap();
        let second = SoulId::parse("soul-second").unwrap();

        let first_dir = ensure_host_actor_state_dir(root.path(), &installation, &first).unwrap();
        let journal = first_dir.join("fresh-agent-state.json");
        std::fs::write(&journal, b"durable actor state").unwrap();
        let reopened = ensure_host_actor_state_dir(root.path(), &installation, &first).unwrap();
        let second_dir = ensure_host_actor_state_dir(root.path(), &installation, &second).unwrap();
        let other_installation = InstallationId::parse("installation-two").unwrap();
        let other_install_dir =
            ensure_host_actor_state_dir(root.path(), &other_installation, &first).unwrap();

        assert_eq!(first_dir, reopened);
        assert_eq!(std::fs::read(journal).unwrap(), b"durable actor state");
        assert_ne!(first_dir, second_dir);
        assert_ne!(first_dir, other_install_dir);
        assert_eq!(
            std::fs::metadata(&first_dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&second_dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }

    #[test]
    fn actor_state_rejects_a_symlink_into_another_soul() {
        let root = tempfile::tempdir().unwrap();
        let installation = InstallationId::parse("installation-one").unwrap();
        let first = SoulId::parse("soul-first").unwrap();
        let second = SoulId::parse("soul-second").unwrap();
        let first_dir = ensure_host_actor_state_dir(root.path(), &installation, &first).unwrap();
        let second_dir = super::host_actor_state_dir(root.path(), &installation, &second);
        std::fs::create_dir_all(second_dir.parent().unwrap()).unwrap();
        std::fs::set_permissions(
            second_dir.parent().unwrap(),
            std::fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        std::os::unix::fs::symlink(&first_dir, &second_dir).unwrap();

        assert!(ensure_host_actor_state_dir(root.path(), &installation, &second).is_err());
    }
}

#[cfg(test)]
mod opencode_transfer_receipt_tests {
    use super::validate_opencode_transfer_receipt;
    use freshell_runtime_protocol::{
        OpenCodeTransferDescriptor, OpenCodeTransferFile, OpenCodeTransferReadinessReceipt,
        RuntimeErrorCode,
    };

    fn descriptor() -> OpenCodeTransferDescriptor {
        OpenCodeTransferDescriptor {
            transfer_id: "transfer-one".into(),
            provider: "opencode".into(),
            source_store_id: "a".repeat(64),
            root_session_id: "root-session".into(),
            source_generation: "b".repeat(64),
            provider_schema: "opencode-1.18.21".into(),
            source_schema_fingerprint: "c".repeat(64),
            migration_journal_fingerprint: "d".repeat(64),
            destination_store_id: "soul-one".into(),
            destination_database_path: ".local/share/opencode/opencode.db".into(),
            target_image_ref: "sha256:test".into(),
            target_build_receipt: "e".repeat(64),
            incarnation_id: "incarnation-one".into(),
            manifest_json: "{}".into(),
            files: vec![OpenCodeTransferFile {
                index: 0,
                relative_path: "manifest.json".into(),
                size_bytes: 2,
                sha256: "f".repeat(64),
            }],
            total_bytes: 2,
            bundle_sha256: "0".repeat(64),
        }
    }

    fn receipt() -> OpenCodeTransferReadinessReceipt {
        OpenCodeTransferReadinessReceipt {
            transfer_id: "transfer-one".into(),
            destination_store_id: "soul-one".into(),
            root_session_id: "root-session".into(),
            source_generation: "b".repeat(64),
            provider_uid: 1000,
            provider_gid: 1000,
            structural_sha256: "1".repeat(64),
            reader_receipt_sha256: "2".repeat(64),
        }
    }

    #[test]
    fn grant_requires_exact_receipt_and_provider_identity_for_transfers() {
        let descriptor = descriptor();
        let accepted = validate_opencode_transfer_receipt(
            Some(&descriptor),
            Some((1000, 1000)),
            Some(receipt()),
        )
        .expect("matching post-revalidation receipt should authorize release eligibility");
        assert!(accepted.is_some());

        for invalid in [
            None,
            Some(OpenCodeTransferReadinessReceipt {
                transfer_id: "other-transfer".into(),
                ..receipt()
            }),
            Some(OpenCodeTransferReadinessReceipt {
                provider_uid: 1001,
                ..receipt()
            }),
            Some(OpenCodeTransferReadinessReceipt {
                provider_gid: 1001,
                ..receipt()
            }),
        ] {
            let error =
                validate_opencode_transfer_receipt(Some(&descriptor), Some((1000, 1000)), invalid)
                    .expect_err("missing or misbound receipt must reject grant acceptance");
            assert_eq!(error.code, RuntimeErrorCode::HostAuthenticationFailed);
        }
    }

    #[test]
    fn receipt_without_a_transfer_descriptor_is_rejected() {
        let error = validate_opencode_transfer_receipt(None, None, Some(receipt()))
            .expect_err("unexpected transfer receipt must be rejected");
        assert_eq!(error.code, RuntimeErrorCode::HostAuthenticationFailed);
        assert!(validate_opencode_transfer_receipt(None, None, None)
            .unwrap()
            .is_none());
    }
}

#[cfg(test)]
mod host_ipc_timeout_tests {
    use super::{
        fresh_agent_command_budget, host_command_budget, request_host_reply,
        terminal_dispatch_budget, DEFAULT_FRESH_AGENT_COMMAND_TIMEOUT_MS,
        DEFAULT_HOST_COMMAND_TIMEOUT_MS, DEFAULT_TERMINAL_DISPATCH_TIMEOUT_MS,
    };
    use freshell_runtime_protocol::{
        ControlRole, Envelope, HostCommand, IncarnationId, RequestId, RuntimeErrorCode,
    };
    use std::time::{Duration, Instant};
    use tokio::net::UnixListener;

    #[tokio::test]
    async fn snapshot_host_reply_preserves_large_history_and_controls_stay_bounded() {
        for snapshot_read in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            let socket = dir.path().join("host.sock");
            let listener = UnixListener::bind(&socket).unwrap();
            let expected = serde_json::json!({"threadId":"native-large", "turns":[{"text":"x".repeat(2 * freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES)}]});
            let sent = expected.clone();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let envelope: Envelope<HostCommand> =
                    freshell_runtime_protocol::read_frame(&mut stream)
                        .await
                        .unwrap();
                freshell_runtime_protocol::write_frame_with_limit(
                    &mut stream,
                    &freshell_runtime_protocol::HostReply {
                        request_id: envelope.request_id,
                        result: Ok(freshell_runtime_protocol::HostResult::FreshAgentSnapshot(
                            sent,
                        )),
                    },
                    freshell_runtime_protocol::MAX_NATIVE_HISTORY_FRAME_BYTES,
                )
                .await
            });
            let id = IncarnationId::parse("large-incarnation").unwrap();
            let command = if snapshot_read {
                HostCommand::FreshAgentReadSnapshot { incarnation_id: id }
            } else {
                HostCommand::Status { incarnation_id: id }
            };
            let reply = request_host_reply(
                &socket,
                &Envelope::new(RequestId::new(), ControlRole::Supervisor, command),
                Duration::from_secs(10),
            )
            .await;
            let _ = server.await.unwrap();
            if snapshot_read {
                assert!(
                    matches!(reply.unwrap().result.unwrap(), freshell_runtime_protocol::HostResult::FreshAgentSnapshot(value) if value == expected)
                );
            } else {
                assert_eq!(
                    reply.unwrap_err().code,
                    RuntimeErrorCode::HostAuthenticationFailed
                );
            }
        }
    }

    /// A session host that accepts the connection and then never answers must
    /// NOT be able to hold the supervisor's authoritative stop hostage. The
    /// supervisor owns the runtime; an unresponsive workload is a bounded,
    /// typed `HostUnreachable`, after which the Docker-level stop still runs.
    #[tokio::test]
    async fn an_accepted_but_unanswered_host_command_fails_within_its_budget() {
        let dir = tempfile::tempdir().unwrap();
        let socket_path = dir.path().join("host.sock");
        let listener = UnixListener::bind(&socket_path).unwrap();
        // Accept and hold the connection open forever without replying.
        let accepted = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(3_600)).await;
            drop(stream);
        });

        let envelope = Envelope::new(
            RequestId::new(),
            ControlRole::Supervisor,
            HostCommand::Status {
                incarnation_id: IncarnationId::parse("incarnation-timeout-test").unwrap(),
            },
        );
        let started = Instant::now();
        let error = request_host_reply(&socket_path, &envelope, Duration::from_millis(300))
            .await
            .expect_err("an unanswered host must not block forever");
        let elapsed = started.elapsed();

        assert_eq!(error.code, RuntimeErrorCode::HostUnreachable);
        assert!(
            error.message.contains("timed out"),
            "the error must say the host timed out, not something generic: {}",
            error.message
        );
        assert!(
            elapsed < Duration::from_secs(5),
            "the budget must bound the wait, took {elapsed:?}"
        );
        accepted.abort();
    }

    #[test]
    fn the_host_command_budget_is_bounded_and_overridable() {
        // Absent/garbage/zero configuration falls back to the safe default
        // rather than becoming an unbounded wait.
        assert_eq!(
            host_command_budget(None),
            Duration::from_millis(DEFAULT_HOST_COMMAND_TIMEOUT_MS)
        );
        assert_eq!(
            host_command_budget(Some("not-a-number")),
            Duration::from_millis(DEFAULT_HOST_COMMAND_TIMEOUT_MS)
        );
        assert_eq!(
            host_command_budget(Some("0")),
            Duration::from_millis(DEFAULT_HOST_COMMAND_TIMEOUT_MS)
        );
        assert_eq!(host_command_budget(Some("250")), Duration::from_millis(250));
        assert_eq!(
            fresh_agent_command_budget(None),
            Duration::from_millis(DEFAULT_FRESH_AGENT_COMMAND_TIMEOUT_MS)
        );
        assert_eq!(
            fresh_agent_command_budget(Some("750")),
            Duration::from_millis(750)
        );
        assert_eq!(
            terminal_dispatch_budget(None),
            Duration::from_millis(DEFAULT_TERMINAL_DISPATCH_TIMEOUT_MS)
        );
        assert_eq!(
            terminal_dispatch_budget(Some("0")),
            Duration::from_millis(DEFAULT_TERMINAL_DISPATCH_TIMEOUT_MS)
        );
        assert_eq!(
            terminal_dispatch_budget(Some("900")),
            Duration::from_millis(900)
        );
    }
}

#[cfg(test)]
mod host_command_budget_tests {
    use super::{
        default_backend, host_dispatch_budget, AuthenticatedHost, HostCommandBudgets, Supervisor,
        SupervisorConfig, FRESH_AGENT_COMMAND_TIMEOUT_ENV, HOST_COMMAND_TIMEOUT_ENV,
        TERMINAL_DISPATCH_TIMEOUT_ENV,
    };
    use crate::registry::Registry;
    use freshell_runtime_protocol::{
        read_frame, write_frame, Envelope, GrantId, HostBootId, HostCommand, HostReply, HostResult,
        IncarnationId, RequestId, RuntimeErrorCode, RuntimeLimits, SoulId, TerminalLaunchSpec,
    };
    use std::path::Path;
    use std::sync::{Arc, Mutex as StdMutex};
    use std::time::{Duration, Instant};
    use tokio::net::UnixListener;

    fn limits() -> RuntimeLimits {
        RuntimeLimits {
            cpu_milli: 500,
            memory_bytes: 64 * 1024 * 1024,
            swap_bytes: 0,
            pids_max: 32,
        }
    }

    /// Distinct budgets per command class, so a test can tell which one a
    /// command was held to.
    fn budgets(
        control_ms: &'static str,
        terminal_ms: &'static str,
        fresh_ms: &'static str,
    ) -> HostCommandBudgets {
        HostCommandBudgets::from_lookup(move |name| {
            match name {
                HOST_COMMAND_TIMEOUT_ENV => Some(control_ms),
                TERMINAL_DISPATCH_TIMEOUT_ENV => Some(terminal_ms),
                FRESH_AGENT_COMMAND_TIMEOUT_ENV => Some(fresh_ms),
                _ => None,
            }
            .map(str::to_string)
        })
    }

    fn supervisor(root: &Path, budgets: HostCommandBudgets) -> Supervisor {
        let registry = Registry::open(root.join("registry"), None).unwrap();
        let host_binary_path = root.join("synthetic-host");
        std::fs::write(&host_binary_path, "synthetic-host-artifact").unwrap();
        let mut supervisor = Supervisor::new(
            registry,
            default_backend(
                root.join("absent-docker.sock"),
                root.join("lifecycle.jsonl"),
            ),
            SupervisorConfig {
                runtime_root: root.join("runtime"),
                control_socket_path: root.join("control.sock"),
                host_binary_path,
                image_ref: format!("sha256:{}", "a".repeat(64)),
                test_run_id: "host-command-budgets".into(),
                control_secret: "synthetic-control-secret".into(),
                lifecycle_log: root.join("lifecycle.jsonl"),
                admission: crate::admission::AdmissionPolicy::default(),
            },
        )
        .unwrap();
        supervisor.host_command_budgets = budgets;
        supervisor
    }

    fn terminal_grant(incarnation_id: &IncarnationId, root: &Path) -> HostCommand {
        let terminal: TerminalLaunchSpec = serde_json::from_value(serde_json::json!({
            "terminalId":"terminal-dispatch-budget","streamId":"stream-dispatch-budget",
            "mode":"codex","program":"codex","args":[],"env":{"HOME":"/home/freshell/provider"},
            "cwd":root,"runAsUid":65534,"runAsGid":0,"cols":80,"rows":24,
            "projectKey":"project-dispatch-budget","workspacePath":root,
        }))
        .unwrap();
        HostCommand::GrantExecution {
            native_identity_launch: None,
            incarnation_id: incarnation_id.clone(),
            soul_id: SoulId::new(),
            host_boot_id: HostBootId::new(),
            control_epoch: 1,
            execution_generation: 1,
            grant_id: GrantId::new(),
            fixture: None,
            provider_path_inputs: Default::default(),
            terminal: Some(Box::new(terminal)),
            fresh_agent: None,
            resume_spec: None,
            dispatch_budget_ms: None,
        }
    }

    type Received = Arc<StdMutex<Vec<HostCommand>>>;

    /// A synthetic host that answers every command after `delay` (or never),
    /// recording each command it received.
    fn slow_host(
        runtime_dir: &Path,
        delay: Option<Duration>,
    ) -> (tokio::task::JoinHandle<()>, Received) {
        let listener = UnixListener::bind(runtime_dir.join("host.sock")).unwrap();
        let received = Received::default();
        let record = received.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let record = record.clone();
                tokio::spawn(async move {
                    let envelope: Envelope<HostCommand> = read_frame(&mut stream).await.unwrap();
                    record.lock().unwrap().push(envelope.body.clone());
                    let Some(delay) = delay else {
                        tokio::time::sleep(Duration::from_secs(3_600)).await;
                        return;
                    };
                    tokio::time::sleep(delay).await;
                    let result = match envelope.body {
                        HostCommand::GrantExecution { host_boot_id, .. } => {
                            HostResult::GrantAccepted {
                                host_boot_id,
                                worker_pid: 4321,
                                worker_launch_count: 1,
                                fixture_evidence: serde_json::json!({}),
                                native_session_id: None,
                                native_identity_observation: None,
                                opencode_adoption: Default::default(),
                                opencode_transfer_receipt: None,
                            }
                        }
                        _ => HostResult::Stopped,
                    };
                    let _ = write_frame(
                        &mut stream,
                        &HostReply {
                            request_id: envelope.request_id,
                            result: Ok(result),
                        },
                    )
                    .await;
                });
            }
        });
        (task, received)
    }

    fn authenticated() -> AuthenticatedHost {
        AuthenticatedHost {
            capabilities: Vec::new(),
            host_boot_id: HostBootId::new(),
            secret: b"synthetic-host-secret".to_vec(),
            effective_limits: limits(),
        }
    }

    /// A terminal grant is the native dispatch boundary: the host prepares
    /// provider inputs and starts the provider (Codex's app-server alone may
    /// take up to its 45-second start budget) before it can reply. The
    /// supervisor must not abandon that dispatch at the short control
    /// round-trip bound, while ordinary control commands keep that bound.
    #[tokio::test]
    async fn terminal_grant_waits_for_dispatch_while_control_commands_stay_short() {
        let root = tempfile::tempdir().unwrap();
        let runtime_dir = root.path().join("incarnation");
        std::fs::create_dir_all(&runtime_dir).unwrap();
        let supervisor = supervisor(root.path(), budgets("200", "5000", "9000"));
        let (host, _) = slow_host(&runtime_dir, Some(Duration::from_millis(700)));
        let incarnation_id = IncarnationId::new();

        let granted = supervisor
            .send_authenticated_host_command(
                incarnation_id.clone(),
                &runtime_dir,
                &authenticated(),
                terminal_grant(&incarnation_id, root.path()),
            )
            .await;
        assert!(
            matches!(granted, Ok(HostResult::GrantAccepted { .. })),
            "a terminal dispatch slower than one control round trip must be accepted: {granted:?}"
        );

        let status = supervisor
            .send_authenticated_host_command(
                incarnation_id.clone(),
                &runtime_dir,
                &authenticated(),
                HostCommand::Status {
                    incarnation_id: incarnation_id.clone(),
                },
            )
            .await
            .expect_err("a control round trip keeps its short bound");
        assert_eq!(status.code, RuntimeErrorCode::HostUnreachable);
        assert!(
            status.message.contains("timed out after 200ms"),
            "{}",
            status.message
        );
        host.abort();
    }

    /// The longer dispatch bound is still a bound: a host that accepts a
    /// terminal grant and goes silent cannot hold the activation open.
    #[tokio::test]
    async fn silent_host_cannot_hold_a_terminal_grant_past_its_dispatch_budget() {
        let root = tempfile::tempdir().unwrap();
        let runtime_dir = root.path().join("incarnation");
        std::fs::create_dir_all(&runtime_dir).unwrap();
        let supervisor = supervisor(root.path(), budgets("100", "400", "9000"));
        let (host, _) = slow_host(&runtime_dir, None);
        let incarnation_id = IncarnationId::new();
        let started = Instant::now();
        let error = supervisor
            .send_authenticated_host_command(
                incarnation_id.clone(),
                &runtime_dir,
                &authenticated(),
                terminal_grant(&incarnation_id, root.path()),
            )
            .await
            .expect_err("a silent host must not hold a terminal grant forever");
        assert_eq!(error.code, RuntimeErrorCode::HostUnreachable);
        assert!(
            error.message.contains("timed out after 400ms"),
            "{}",
            error.message
        );
        assert!(started.elapsed() < Duration::from_secs(5));
        host.abort();
    }

    /// Terminal grants, fresh-agent operations, and control round trips are
    /// each held to their own configured budget: none borrows another's.
    #[tokio::test]
    async fn each_command_class_is_held_to_its_own_budget() {
        let root = tempfile::tempdir().unwrap();
        let runtime_dir = root.path().join("incarnation");
        std::fs::create_dir_all(&runtime_dir).unwrap();
        let supervisor = supervisor(root.path(), budgets("100", "300", "700"));
        let (host, _) = slow_host(&runtime_dir, None);
        let incarnation_id = IncarnationId::new();
        let host_auth = authenticated();
        let send = |command| {
            supervisor.send_authenticated_host_command(
                incarnation_id.clone(),
                &runtime_dir,
                &host_auth,
                command,
            )
        };

        let terminal = send(terminal_grant(&incarnation_id, root.path()))
            .await
            .expect_err("a silent host times out");
        let fresh_agent = send(HostCommand::FreshAgentSend {
            incarnation_id: incarnation_id.clone(),
            request_id: RequestId::new(),
            text: "synthetic turn".into(),
            settings: None,
            checkpoint_logical_attempt_id: None,
        })
        .await
        .expect_err("a silent host times out");
        let control = send(HostCommand::Status {
            incarnation_id: incarnation_id.clone(),
        })
        .await
        .expect_err("a silent host times out");

        for (error, budget) in [(&terminal, 300), (&fresh_agent, 700), (&control, 100)] {
            assert_eq!(error.code, RuntimeErrorCode::HostUnreachable);
            assert!(
                error
                    .message
                    .contains(&format!("timed out after {budget}ms")),
                "{}",
                error.message
            );
        }
        host.abort();
    }

    /// A grant tells the host how long it has to dispatch, derived from the
    /// wait that bounds its reply, so the host refuses before the supervisor
    /// gives up on it.
    #[tokio::test]
    async fn terminal_grant_tells_the_host_its_dispatch_budget() {
        let root = tempfile::tempdir().unwrap();
        let runtime_dir = root.path().join("incarnation");
        std::fs::create_dir_all(&runtime_dir).unwrap();
        let supervisor = supervisor(root.path(), budgets("100", "300", "700"));
        let (host, received) = slow_host(&runtime_dir, Some(Duration::from_millis(10)));
        let incarnation_id = IncarnationId::new();

        supervisor
            .send_authenticated_host_command(
                incarnation_id.clone(),
                &runtime_dir,
                &authenticated(),
                terminal_grant(&incarnation_id, root.path()),
            )
            .await
            .expect("the grant is accepted");

        let granted_budget = received
            .lock()
            .unwrap()
            .iter()
            .find_map(|command| match command {
                HostCommand::GrantExecution {
                    dispatch_budget_ms, ..
                } => Some(*dispatch_budget_ms),
                _ => None,
            })
            .expect("the host received the grant");
        assert_eq!(
            granted_budget,
            Some(150),
            "the host is told the terminal wait less its reply allowance"
        );
        host.abort();
    }

    /// The host's dispatch budget leaves the supervisor a reply allowance of
    /// five seconds, never more than half of the wait.
    #[test]
    fn host_dispatch_budget_leaves_a_reply_allowance() {
        assert_eq!(
            host_dispatch_budget(Duration::from_secs(60)),
            Duration::from_secs(55)
        );
        assert_eq!(
            host_dispatch_budget(Duration::from_secs(10)),
            Duration::from_secs(5)
        );
        assert_eq!(
            host_dispatch_budget(Duration::from_millis(400)),
            Duration::from_millis(200)
        );
    }
}

#[cfg(test)]
mod release_scope_tests {
    use super::{
        activation_failure_data, append_event, classify_fresh_agent_fork_transition,
        classify_fresh_agent_operation_identity, lifecycle_secrets, release_qualified_workload,
        FreshAgentNativeIdentityUpdate,
    };
    use crate::registry::PreparedLaunch;
    use freshell_runtime_protocol::{
        FreshAgentForkResult, IncarnationId, LaunchNonce, LaunchState, RuntimeError,
        RuntimeErrorCode, SoulId,
    };

    #[test]
    fn provider_fresh_launch_digest_rejects_changed_prepared_workload() {
        let mut request: freshell_runtime_protocol::LaunchRequest = serde_json::from_value(
            serde_json::json!({
                "soulId": SoulId::new(), "provider":"claude", "providerStoreId":"synthetic-store",
                "creationSeedRef":"synthetic-seed", "limits": {"cpuMilli":1000,"memoryBytes":1073741824,"swapBytes":0,"pidsMax":128},
                "freshAgent": {
                    "sessionId":"synthetic-session", "provider":"claude", "sessionType":"freshclaude",
                    "runtimeVariant":"claude-sdk-sidecar", "providerStoreId":"synthetic-store",
                    "cwd":"/synthetic/workspace", "workspacePath":"/synthetic/workspace",
                    "runAsUid":65534, "runAsGid":0, "model":"synthetic-model"
                }
            })
        ).unwrap();
        let original = super::semantic_launch_digest(&request).unwrap();
        request.fresh_agent.as_mut().unwrap().model = Some("changed-model".into());
        assert_ne!(
            original,
            super::semantic_launch_digest(&request).unwrap(),
            "changed fresh workload must not coalesce with the previous immutable launch"
        );
        request.fresh_agent.as_mut().unwrap().model = Some("synthetic-model".into());
        assert_eq!(original, super::semantic_launch_digest(&request).unwrap());
    }

    #[test]
    fn semantic_operation_identity_classifies_record_transition_and_replay() {
        assert_eq!(
            classify_fresh_agent_operation_identity(None, None).unwrap(),
            FreshAgentNativeIdentityUpdate::Unchanged
        );
        assert_eq!(
            classify_fresh_agent_operation_identity(None, Some("native-one")).unwrap(),
            FreshAgentNativeIdentityUpdate::Record
        );
        assert_eq!(
            classify_fresh_agent_operation_identity(Some("native-parent"), Some("native-child"))
                .unwrap(),
            FreshAgentNativeIdentityUpdate::Transition
        );
        assert_eq!(
            classify_fresh_agent_operation_identity(Some("native-child"), Some("native-child"))
                .unwrap(),
            FreshAgentNativeIdentityUpdate::Unchanged,
            "an exact retry after registry commit must be idempotent",
        );
        assert!(classify_fresh_agent_operation_identity(
            Some("native-parent"),
            Some("bad\nidentity")
        )
        .is_err());
    }

    #[test]
    fn fork_transition_accepts_first_apply_and_exact_idempotent_replay_only() {
        let transition = FreshAgentForkResult {
            claude_fork: None,
            parent_session_id: "native-parent".into(),
            child_session_id: "native-child".into(),
            parent_retired_by_runtime: true,
        };
        assert!(
            !classify_fresh_agent_fork_transition("native-parent", &transition).unwrap(),
            "parent current means registry transition still needs applying",
        );
        assert!(
            classify_fresh_agent_fork_transition("native-child", &transition).unwrap(),
            "child current means this request already committed and may replay",
        );
        assert!(classify_fresh_agent_fork_transition("foreign", &transition).is_err());
        let unsafe_transition = FreshAgentForkResult {
            parent_retired_by_runtime: false,
            ..transition
        };
        assert!(classify_fresh_agent_fork_transition("native-parent", &unsafe_transition).is_err());
    }

    #[test]
    fn direct_terminal_launch_cannot_bypass_live_qualification_scope() {
        for provider in ["shell", "claude", "codex", "opencode"] {
            assert!(release_qualified_workload(provider, false, true, None));
        }
        for provider in ["amplifier", "gemini", "kimi"] {
            assert!(
                !release_qualified_workload(provider, false, true, None),
                "{provider}"
            );
        }
        assert!(release_qualified_workload(
            "native-session-fixture",
            true,
            false,
            None
        ));
        for (provider, mode) in [
            ("claude", "freshclaude"),
            ("codex", "freshcodex"),
            ("opencode", "freshopencode"),
            ("kilroy", "kilroy"),
        ] {
            let mut agent: freshell_runtime_protocol::FreshAgentLaunchSpec =
                serde_json::from_value(serde_json::json!({
                    "sessionId":"public-test", "provider":provider, "sessionType":mode,
                    "runtimeVariant":"owned-test-variant", "providerStoreId":"soul-test",
                    "cwd":"/workspace", "workspacePath":"/workspace", "runAsUid":65534,"runAsGid":0
                }))
                .unwrap();
            assert_eq!(
                release_qualified_workload(provider, false, false, Some(&agent)),
                provider != "kilroy"
            );
            assert!(!release_qualified_workload(
                "other",
                false,
                false,
                Some(&agent)
            ));
            agent.fixture_transport =
                Some(freshell_runtime_protocol::FreshAgentFixtureTransport::Deterministic);
            assert!(release_qualified_workload(
                provider,
                false,
                false,
                Some(&agent)
            ));
            agent.session_type = "mismatched-mode".into();
            assert!(!release_qualified_workload(
                provider,
                false,
                false,
                Some(&agent)
            ));
        }
    }

    #[tokio::test]
    async fn release_qualified_workload_candidate_uses_normal_launch_admission() {
        let dir = tempfile::tempdir().unwrap();
        let registry = crate::registry::Registry::open(dir.path().join("registry"), None).unwrap();
        let supervisor = crate::recovery::tests::missing_supervisor(&dir, registry.clone());
        for (provider, mode) in [
            ("shell", None),
            ("claude", None),
            ("codex", None),
            ("opencode", None),
            ("claude", Some("freshclaude")),
            ("codex", Some("freshcodex")),
            ("opencode", Some("freshopencode")),
            ("amplifier", None),
            ("kilroy", Some("kilroy")),
        ] {
            let mut value = serde_json::json!({
                "soulId":format!("soul-candidate-{}", mode.unwrap_or(provider)), "provider":provider,
                "providerStoreId":"synthetic-store", "creationSeedRef":"synthetic-seed",
                "profile":"default_agent",
                "limits":{"cpuMilli":2000,"memoryBytes":1073741824,"swapBytes":0,"pidsMax":512}
            });
            if let Some(mode) = mode {
                value["freshAgent"] = serde_json::json!({"sessionId":"synthetic-public", "provider":provider,
                    "sessionType":mode, "runtimeVariant":"synthetic-runtime", "providerStoreId":"synthetic-store",
                    "cwd":"/workspace", "workspacePath":"/workspace", "runAsUid":65534,"runAsGid":0});
            } else {
                value["terminal"] = serde_json::json!({"terminalId":"synthetic-terminal", "streamId":"synthetic-stream",
                    "mode":provider, "program":provider, "cwd":"/workspace", "workspacePath":"/workspace",
                    "runAsUid":65534,"runAsGid":0,"cols":80,"rows":24,"projectKey":"synthetic"});
            }
            let request = serde_json::from_value(value).unwrap();
            let error = supervisor
                .launch(freshell_runtime_protocol::RequestId::new(), request)
                .await
                .unwrap_err();
            assert_eq!(
                error.code,
                if ["amplifier", "kilroy"].contains(&provider) {
                    RuntimeErrorCode::UnsupportedWorkload
                } else {
                    // An admitted route must reach normal resource-profile validation.
                    // The deliberate mismatch avoids starting any provider or backend.
                    RuntimeErrorCode::InvalidRuntimeLimits
                },
                "{provider}/{mode:?}: {}",
                error.message
            );
        }
        assert!(registry.inventory().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn release_qualified_workload_rejects_native_kilroy_before_allocation() {
        let dir = tempfile::tempdir().unwrap();
        let registry = crate::registry::Registry::open(dir.path().join("registry"), None).unwrap();
        let supervisor = crate::recovery::tests::missing_supervisor(&dir, registry.clone());
        let request: freshell_runtime_protocol::LaunchRequest = serde_json::from_value(serde_json::json!({
            "soulId":"soul-excluded-kilroy", "provider":"kilroy", "providerStoreId":"soul-excluded-kilroy",
            "creationSeedRef":"excluded-kilroy", "limits":{"cpuMilli":2000,"memoryBytes":1073741824,"swapBytes":0,"pidsMax":512},
            "freshAgent":{"sessionId":"public-kilroy", "provider":"kilroy", "sessionType":"kilroy",
                "runtimeVariant":"kilroy-claude-agent-sdk", "providerStoreId":"soul-excluded-kilroy",
                "cwd":"/workspace", "workspacePath":"/workspace", "runAsUid":65534,"runAsGid":0}
        })).unwrap();
        let mut mismatched = request.clone();
        mismatched.fresh_agent.as_mut().unwrap().session_type = "freshclaude".into();
        let error = supervisor
            .launch(freshell_runtime_protocol::RequestId::new(), mismatched)
            .await
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::InvalidRequest);
        let error = supervisor
            .launch(freshell_runtime_protocol::RequestId::new(), request)
            .await
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::UnsupportedWorkload);
        assert!(registry.inventory().await.unwrap().is_empty());
    }

    #[test]
    fn lifecycle_redaction_uses_the_secret_registered_for_each_log_path() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("first.jsonl");
        let second = dir.path().join("second.jsonl");
        lifecycle_secrets()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(first.clone(), "first-secret-value".into());
        lifecycle_secrets()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(second.clone(), "second-secret-value".into());
        append_event(
            &first,
            "test",
            serde_json::json!({"value":"first-secret-value"}),
        );
        append_event(
            &second,
            "test",
            serde_json::json!({"value":"second-secret-value"}),
        );
        let first_log = std::fs::read_to_string(first).unwrap();
        let second_log = std::fs::read_to_string(second).unwrap();
        assert!(!first_log.contains("first-secret-value"));
        assert!(!second_log.contains("second-secret-value"));
        assert!(first_log.contains("***REDACTED***"));
        assert!(second_log.contains("***REDACTED***"));
    }

    #[test]
    fn activation_failure_diagnostic_names_the_exact_stage_and_redacts_detail() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("activation.jsonl");
        let secret = "activation-secret-never-persist";
        lifecycle_secrets()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(log.clone(), secret.into());
        let prepared = PreparedLaunch {
            soul_id: SoulId::new(),
            incarnation_id: IncarnationId::new(),
            launch_nonce: LaunchNonce::new(),
            state: LaunchState::Created,
            intent_revision: 7,
            existing_request: false,
        };
        let error = RuntimeError::new(
            RuntimeErrorCode::HostUnreachable,
            format!("prepare provider bootstrap failed: {secret}"),
        )
        .with_diagnostic_code(
            freshell_runtime_protocol::RuntimeDiagnosticCode::ProviderStatePrepareFailed,
        );

        append_event(
            &log,
            "supervisor.activation_failed",
            activation_failure_data(
                &prepared,
                LaunchState::Starting,
                "deliver_execution_grant",
                &error,
            ),
        );

        let contents = std::fs::read_to_string(log).unwrap();
        assert!(!contents.contains(secret));
        let event: serde_json::Value = serde_json::from_str(contents.trim()).unwrap();
        assert_eq!(event["event"], "supervisor.activation_failed");
        assert_eq!(event["data"]["stage"], "deliver_execution_grant");
        assert_eq!(event["data"]["launchState"], "starting");
        assert_eq!(event["data"]["errorCode"], "HOST_UNREACHABLE");
        assert_eq!(event["data"]["errorClass"], "runtime_activation_failed");
        assert_eq!(
            event["data"]["failureReason"],
            "PROVIDER_STATE_PREPARE_FAILED"
        );
        assert!(event["data"].get("errorMessage").is_none());
        assert!(!contents.contains("prepare provider bootstrap failed"));
    }

    #[test]
    fn codex_prepare_stage_diagnostics_reach_the_body_free_failure_reason() {
        let prepared = PreparedLaunch {
            soul_id: SoulId::new(),
            incarnation_id: IncarnationId::new(),
            launch_nonce: LaunchNonce::new(),
            state: LaunchState::Created,
            intent_revision: 7,
            existing_request: false,
        };
        let cases = [
            (
                freshell_runtime_protocol::RuntimeDiagnosticCode::CodexConfigPlanningFailed,
                "CODEX_CONFIG_PLANNING_FAILED",
            ),
            (
                freshell_runtime_protocol::RuntimeDiagnosticCode::CodexAppServerStartFailed,
                "CODEX_APP_SERVER_START_FAILED",
            ),
            (
                freshell_runtime_protocol::RuntimeDiagnosticCode::CodexProxyStartFailed,
                "CODEX_PROXY_START_FAILED",
            ),
        ];

        for (diagnostic_code, expected_reason) in cases {
            let error = RuntimeError::new(
                RuntimeErrorCode::HostUnreachable,
                "private local preparation detail",
            )
            .with_diagnostic_code(diagnostic_code);
            let data = activation_failure_data(
                &prepared,
                LaunchState::Starting,
                "deliver_execution_grant",
                &error,
            );

            assert_eq!(data["failureReason"], expected_reason);
            assert!(data.get("errorMessage").is_none());
            assert!(!data
                .to_string()
                .contains("private local preparation detail"));
        }
    }
}

#[cfg(test)]
mod activation_backend_diagnostic_tests {
    use super::*;
    use freshell_runtime_protocol::{LaunchRequest, RuntimeProfile};

    #[cfg(unix)]
    #[tokio::test]
    async fn create_stopped_backend_diagnostic_preserves_real_preflight_refusal() {
        for missing in ["host", "workspace"] {
            let dir = tempfile::tempdir().unwrap();
            let binary = dir.path().join("host");
            std::fs::write(&binary, b"never executed test host").unwrap();
            let socket = dir.path().join("docker.sock");
            let listener = UnixListener::bind(&socket).unwrap();
            let registry = Registry::open(dir.path().join("registry"), None).unwrap();
            let supervisor = Supervisor::new(
                registry.clone(),
                Arc::new(DockerEngineBackend::new(&socket)),
                SupervisorConfig {
                    runtime_root: dir.path().join("runtime"),
                    control_socket_path: dir.path().join("control.sock"),
                    host_binary_path: binary.clone(),
                    image_ref: format!("sha256:{}", "a".repeat(64)),
                    test_run_id: "activation-backend-diagnostic".into(),
                    control_secret: "private-diagnostic-control-secret".into(),
                    lifecycle_log: dir.path().join("lifecycle.jsonl"),
                    admission: AdmissionPolicy::default(),
                },
            )
            .unwrap();
            if missing == "host" {
                std::fs::remove_file(&binary).unwrap();
            }
            let soul = SoulId::new();
            let workspace = dir.path().join("missing-workspace");
            let terminal = (missing == "workspace").then(|| {
                serde_json::from_value(serde_json::json!({
                    "terminalId":"diagnostic-terminal","streamId":"diagnostic-stream",
                    "mode":"shell","program":"sh","cwd":workspace,"workspacePath":workspace,
                    "runAsUid":65534,"runAsGid":0,"cols":80,"rows":24,"projectKey":"diagnostic-project"
                }))
                .unwrap()
            });
            let error = supervisor
                .launch(
                    RequestId::new(),
                    LaunchRequest {
                        soul_id: soul.clone(),
                        provider: if terminal.is_some() {
                            "shell"
                        } else {
                            "fixture"
                        }
                        .into(),
                        provider_store_id: "diagnostic-store".into(),
                        creation_seed_ref: "diagnostic-seed".into(),
                        limits: RuntimeLimits {
                            cpu_milli: 500,
                            memory_bytes: 64 * 1024 * 1024,
                            swap_bytes: 0,
                            pids_max: 32,
                        },
                        profile: RuntimeProfile::Custom,
                        project_key: "diagnostic-project".into(),
                        native_session_id: None,
                        fixture: terminal.is_none().then_some(FixtureKind::Heartbeat),
                        terminal,
                        fresh_agent: None,
                        view_intent: None,
                        expected_control_epoch: None,
                    },
                )
                .await
                .expect_err("real backend preflight must fail before Docker create");
            assert_eq!(error.code, RuntimeErrorCode::RecoveryBlocked);
            assert!(error.message.contains(if missing == "host" {
                "host binary:"
            } else {
                "workspace:"
            }));
            assert!(
                tokio::time::timeout(Duration::from_millis(30), listener.accept())
                    .await
                    .is_err()
            );
            let views = registry.inventory().await.unwrap();
            assert_eq!(views.len(), 1);
            assert!(views[0].container_id.is_none());
            let text = std::fs::read_to_string(&supervisor.config.lifecycle_log).unwrap();
            let events: Vec<serde_json::Value> = text
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
            let backend = events
                .iter()
                .find(|event| event["event"] == "supervisor.activation_failed")
                .expect("the exact preflight cause must survive in the existing lifecycle log");
            assert_eq!(backend["data"]["severity"], "error");
            assert_eq!(backend["data"]["soulId"], soul.as_str());
            assert_eq!(
                backend["data"]["incarnationId"],
                views[0].incarnation_id.as_str()
            );
            assert_eq!(backend["data"]["intentRevision"], views[0].intent_revision);
            assert_eq!(backend["data"]["launchState"], "prepared");
            assert_eq!(backend["data"]["stage"], "create_stopped_runtime");
            assert_eq!(backend["data"]["backendFailure"]["kind"], "invalid_config");
            assert_eq!(
                error.message,
                format!(
                    "runtime backend configuration rejected: {}",
                    backend["data"]["backendFailure"]["detail"]
                        .as_str()
                        .unwrap()
                )
            );
            assert!(!text.contains(&supervisor.config.control_secret));
            assert!(events
                .iter()
                .any(|event| event["event"] == "supervisor.activation_failed"
                    && event["data"]["stage"] == "create_stopped_runtime"
                    && event["data"]["errorCode"] == "RECOVERY_BLOCKED"));
        }
    }

    #[test]
    fn create_stopped_backend_diagnostic_preserves_categories_and_redacts_control_secret() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("diagnostic.jsonl");
        let control_secret = "private-diagnostic-control-secret";
        let binary = dir.path().join("host");
        std::fs::write(&binary, b"owned diagnostic fixture").unwrap();
        let supervisor = Supervisor::new(
            Registry::open(dir.path().join("registry"), None).unwrap(),
            default_backend(dir.path().join("absent-docker.sock"), log.clone()),
            SupervisorConfig {
                runtime_root: dir.path().join("runtime"),
                control_socket_path: dir.path().join("control.sock"),
                host_binary_path: binary,
                image_ref: format!("sha256:{}", "a".repeat(64)),
                test_run_id: "diagnostic-categories".into(),
                control_secret: control_secret.into(),
                lifecycle_log: log.clone(),
                admission: AdmissionPolicy::default(),
            },
        )
        .unwrap();
        let prepared = PreparedLaunch {
            soul_id: SoulId::new(),
            incarnation_id: IncarnationId::new(),
            launch_nonce: freshell_runtime_protocol::LaunchNonce::new(),
            state: LaunchState::Prepared,
            intent_revision: 7,
            existing_request: false,
        };
        for error in [
            BackendError::DockerHttp {
                status: 403,
                body: "arbitrary-private-provider-response".into(),
            },
            BackendError::Malformed("arbitrary-private-parser-payload".into()),
            BackendError::Unavailable("arbitrary-private-transport-payload".into()),
            BackendError::InvalidConfig(format!("host binary: {control_secret}")),
        ] {
            supervisor.activation_failure_from_backend(
                &prepared,
                LaunchState::Prepared,
                "create_stopped_runtime",
                error,
            );
        }
        let text = std::fs::read_to_string(log).unwrap();
        assert!(!text.contains(control_secret));
        let events: Vec<serde_json::Value> = text
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        for (event, kind) in
            events
                .iter()
                .zip(["docker_http", "malformed", "unavailable", "invalid_config"])
        {
            assert_eq!(event["data"]["backendFailure"]["kind"], kind);
        }
        assert_eq!(events[0]["data"]["backendFailure"]["httpStatus"], 403);
        assert_eq!(
            events[3]["data"]["backendFailure"]["detail"],
            "host binary: ***REDACTED***"
        );
        assert!(!text.contains(prepared.launch_nonce.as_str()));
    }
}

#[cfg(test)]
mod codex_pre_worker_retry_tests {
    use super::*;
    use crate::backend::{BackendCreated, BackendInspection, BackendRuntimeState};
    use freshell_runtime_protocol::{
        DockerDaemonId, FreshAgentProviderStartDiagnostic, LaunchRequest,
        NativeIdentityObservation, NativeIdentitySource, RuntimeDiagnosticCode, RuntimeProfile,
    };
    use std::{
        collections::HashMap,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Mutex as StdMutex,
        },
    };

    #[derive(Clone, Copy)]
    enum FirstGrantOutcome {
        CodexAppServerStartFailed,
        CodexProxyStartFailed,
        FreshAgentProviderStartFailed,
        WorkerMayHaveStarted,
    }

    #[derive(Clone, Copy)]
    enum HostOutcome {
        CodexAppServerStartFailed,
        CodexProxyStartFailed,
        FreshAgentProviderStartFailed,
        WorkerMayHaveStarted,
        Running,
    }

    struct RuntimeRecord {
        incarnation_id: IncarnationId,
        state: BackendRuntimeState,
        attempt: usize,
        host: Option<tokio::task::JoinHandle<()>>,
    }

    #[derive(Default)]
    struct Counts {
        creates: AtomicUsize,
        grants: AtomicUsize,
        workers: AtomicUsize,
        possible_workers: AtomicUsize,
        stop_requests: AtomicUsize,
        force_stops: AtomicUsize,
        empty_checks: AtomicUsize,
    }

    struct FakeBackend {
        first_grant: FirstGrantOutcome,
        counts: Arc<Counts>,
        runtimes: StdMutex<HashMap<String, RuntimeRecord>>,
        stop_targets: StdMutex<Vec<(IncarnationId, String)>>,
        empty_targets: StdMutex<Vec<(IncarnationId, String)>>,
        cleanup_steps: StdMutex<Vec<(String, IncarnationId, String)>>,
    }

    impl FakeBackend {
        fn new(first_grant: FirstGrantOutcome) -> Self {
            Self {
                first_grant,
                counts: Arc::new(Counts::default()),
                runtimes: StdMutex::new(HashMap::new()),
                stop_targets: StdMutex::new(Vec::new()),
                empty_targets: StdMutex::new(Vec::new()),
                cleanup_steps: StdMutex::new(Vec::new()),
            }
        }

        fn outcome_for(&self, attempt: usize) -> HostOutcome {
            if attempt != 1 {
                return HostOutcome::Running;
            }
            match self.first_grant {
                FirstGrantOutcome::CodexAppServerStartFailed => {
                    HostOutcome::CodexAppServerStartFailed
                }
                FirstGrantOutcome::CodexProxyStartFailed => HostOutcome::CodexProxyStartFailed,
                FirstGrantOutcome::FreshAgentProviderStartFailed => {
                    HostOutcome::FreshAgentProviderStartFailed
                }
                FirstGrantOutcome::WorkerMayHaveStarted => HostOutcome::WorkerMayHaveStarted,
            }
        }

        fn runtime_state(
            &self,
            handle: &crate::registry::OwnedRuntimeHandle,
        ) -> Result<BackendRuntimeState, BackendError> {
            let runtimes = self.runtimes.lock().unwrap();
            let record = runtimes
                .get(handle.container_id())
                .ok_or_else(|| BackendError::OwnershipMismatch("unknown test container".into()))?;
            if &record.incarnation_id != handle.incarnation_id() {
                return Err(BackendError::OwnershipMismatch(
                    "test container incarnation changed".into(),
                ));
            }
            Ok(record.state)
        }

        async fn stop_exact(
            &self,
            handle: &crate::registry::OwnedRuntimeHandle,
        ) -> Result<(), BackendError> {
            let host = {
                let mut runtimes = self.runtimes.lock().unwrap();
                let record = runtimes.get_mut(handle.container_id()).ok_or_else(|| {
                    BackendError::OwnershipMismatch("unknown test container".into())
                })?;
                if &record.incarnation_id != handle.incarnation_id() {
                    return Err(BackendError::OwnershipMismatch(
                        "test container incarnation changed".into(),
                    ));
                }
                record.host.take()
            };
            if let Some(host) = host {
                host.abort();
                let _ = host.await;
            }
            self.runtimes
                .lock()
                .unwrap()
                .get_mut(handle.container_id())
                .expect("checked test container")
                .state = BackendRuntimeState::Exited;
            Ok(())
        }
    }

    impl Drop for FakeBackend {
        fn drop(&mut self) {
            for record in self.runtimes.get_mut().unwrap().values_mut() {
                if let Some(host) = record.host.take() {
                    host.abort();
                }
            }
        }
    }

    #[async_trait::async_trait]
    impl RuntimeBackend for FakeBackend {
        async fn create_stopped(
            &self,
            spec: &CreateRuntimeSpec,
        ) -> Result<BackendCreated, BackendError> {
            let attempt = self.counts.creates.fetch_add(1, Ordering::SeqCst) + 1;
            let container_id = format!("{:064x}", attempt);
            self.runtimes.lock().unwrap().insert(
                container_id.clone(),
                RuntimeRecord {
                    incarnation_id: spec.incarnation_id.clone(),
                    state: BackendRuntimeState::Created,
                    attempt,
                    host: None,
                },
            );
            Ok(BackendCreated {
                daemon_id: DockerDaemonId::new(),
                container_id,
                immutable_config_digest: format!("fake-runtime-config-{attempt}"),
            })
        }

        async fn start_host(
            &self,
            handle: &crate::registry::OwnedRuntimeHandle,
        ) -> Result<(), BackendError> {
            let (attempt, limits) = {
                let mut runtimes = self.runtimes.lock().unwrap();
                let record = runtimes.get_mut(handle.container_id()).ok_or_else(|| {
                    BackendError::OwnershipMismatch("unknown test container".into())
                })?;
                if &record.incarnation_id != handle.incarnation_id() {
                    return Err(BackendError::OwnershipMismatch(
                        "test container incarnation changed".into(),
                    ));
                }
                record.state = BackendRuntimeState::Running;
                (record.attempt, handle.requested_limits())
            };
            let socket_path = handle.runtime_dir().join("host.sock");
            let listener = UnixListener::bind(&socket_path)
                .map_err(|error| BackendError::Unavailable(error.to_string()))?;
            let secret = std::fs::read(handle.runtime_dir().join("secret"))
                .map_err(|error| BackendError::Unavailable(error.to_string()))?;
            let incarnation = handle.incarnation_id().clone();
            let outcome = self.outcome_for(attempt);
            let counts = Arc::clone(&self.counts);
            let host = tokio::spawn(async move {
                serve_fake_host(listener, secret, incarnation, limits, outcome, counts).await;
            });
            self.runtimes
                .lock()
                .unwrap()
                .get_mut(handle.container_id())
                .expect("checked test container")
                .host = Some(host);
            Ok(())
        }

        async fn inspect(
            &self,
            handle: &crate::registry::OwnedRuntimeHandle,
        ) -> Result<BackendInspection, BackendError> {
            Ok(BackendInspection {
                state: self.runtime_state(handle)?,
                configured_limits: handle.requested_limits(),
            })
        }

        async fn request_stop(
            &self,
            handle: &crate::registry::OwnedRuntimeHandle,
            grace_seconds: u64,
        ) -> Result<(), BackendError> {
            assert_eq!(grace_seconds, 2);
            self.counts.stop_requests.fetch_add(1, Ordering::SeqCst);
            self.stop_targets.lock().unwrap().push((
                handle.incarnation_id().clone(),
                handle.container_id().to_owned(),
            ));
            self.cleanup_steps.lock().unwrap().push((
                "request_stop".into(),
                handle.incarnation_id().clone(),
                handle.container_id().to_owned(),
            ));
            self.stop_exact(handle).await
        }

        async fn force_stop(
            &self,
            handle: &crate::registry::OwnedRuntimeHandle,
        ) -> Result<(), BackendError> {
            self.counts.force_stops.fetch_add(1, Ordering::SeqCst);
            self.stop_exact(handle).await
        }

        async fn verify_empty(
            &self,
            handle: &crate::registry::OwnedRuntimeHandle,
        ) -> Result<bool, BackendError> {
            self.counts.empty_checks.fetch_add(1, Ordering::SeqCst);
            self.empty_targets.lock().unwrap().push((
                handle.incarnation_id().clone(),
                handle.container_id().to_owned(),
            ));
            self.cleanup_steps.lock().unwrap().push((
                "verify_empty".into(),
                handle.incarnation_id().clone(),
                handle.container_id().to_owned(),
            ));
            Ok(matches!(
                self.runtime_state(handle)?,
                BackendRuntimeState::Missing
                    | BackendRuntimeState::Created
                    | BackendRuntimeState::Exited
                    | BackendRuntimeState::Dead
            ))
        }

        async fn list_known(
            &self,
            handles: &[crate::registry::OwnedRuntimeHandle],
        ) -> Result<Vec<(IncarnationId, BackendInspection)>, BackendError> {
            let mut result = Vec::with_capacity(handles.len());
            for handle in handles {
                result.push((handle.incarnation_id().clone(), self.inspect(handle).await?));
            }
            Ok(result)
        }

        async fn read_limits(
            &self,
            handle: &crate::registry::OwnedRuntimeHandle,
        ) -> Result<RuntimeLimits, BackendError> {
            Ok(handle.requested_limits())
        }

        async fn enable_long_lived(
            &self,
            _handle: &crate::registry::OwnedRuntimeHandle,
        ) -> Result<(), BackendError> {
            Ok(())
        }
    }

    async fn serve_fake_host(
        listener: UnixListener,
        secret: Vec<u8>,
        incarnation: IncarnationId,
        limits: RuntimeLimits,
        outcome: HostOutcome,
        counts: Arc<Counts>,
    ) {
        let boot = HostBootId::new();
        let mut grant_epoch = 0;
        let mut execution_generation = 0;
        let mut observation = None;
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let Ok(request) = read_frame::<_, Envelope<HostCommand>>(&mut socket).await else {
                return;
            };
            let result = match request.body {
                HostCommand::Hello {
                    incarnation_id: requested_incarnation,
                    challenge,
                } => {
                    if requested_incarnation != incarnation {
                        return;
                    }
                    Ok(HostResult::Hello {
                        proof: host_proof(&secret, &challenge, &boot, &incarnation),
                        host_boot_id: boot.clone(),
                        capabilities: vec!["native-identity-observation-v1".into()],
                        effective_limits: limits,
                    })
                }
                HostCommand::GrantExecution {
                    control_epoch,
                    execution_generation: generation,
                    native_identity_launch,
                    ..
                } => {
                    counts.grants.fetch_add(1, Ordering::SeqCst);
                    match outcome {
                        HostOutcome::CodexAppServerStartFailed => Err(RuntimeError::new(
                            RuntimeErrorCode::HostUnreachable,
                            "synthetic-private-codex-output-marker",
                        )
                        .with_diagnostic_code(RuntimeDiagnosticCode::CodexAppServerStartFailed)),
                        HostOutcome::CodexProxyStartFailed => Err(RuntimeError::new(
                            RuntimeErrorCode::HostUnreachable,
                            "synthetic-private-codex-proxy-output-marker",
                        )
                        .with_diagnostic_code(RuntimeDiagnosticCode::CodexProxyStartFailed)),
                        HostOutcome::FreshAgentProviderStartFailed => Err(RuntimeError::new(
                            RuntimeErrorCode::HostUnreachable,
                            "hosted fresh-agent provider failed to start",
                        )
                        .with_diagnostic_code(RuntimeDiagnosticCode::FreshAgentProviderStartFailed)
                        .with_fresh_agent_provider_start_diagnostic(
                            FreshAgentProviderStartDiagnostic::Authentication,
                        )),
                        HostOutcome::WorkerMayHaveStarted => {
                            counts.possible_workers.fetch_add(1, Ordering::SeqCst);
                            return;
                        }
                        HostOutcome::Running => {
                            let Some(launch) = native_identity_launch else {
                                return;
                            };
                            if launch.incarnation_id != incarnation {
                                return;
                            }
                            grant_epoch = control_epoch;
                            execution_generation = generation;
                            let current = NativeIdentityObservation {
                                native_session_id: "synthetic-codex-session".into(),
                                incarnation_id: incarnation.clone(),
                                launch_nonce: launch.launch_nonce,
                                evidence_revision: launch.evidence_revision,
                                source: NativeIdentitySource::CodexAppServer,
                                evidence_digest: "b".repeat(64),
                            };
                            observation = Some(current.clone());
                            counts.workers.fetch_add(1, Ordering::SeqCst);
                            Ok(HostResult::GrantAccepted {
                                host_boot_id: boot.clone(),
                                worker_pid: 42,
                                worker_launch_count: 1,
                                fixture_evidence: serde_json::json!({}),
                                native_session_id: Some(current.native_session_id.clone()),
                                native_identity_observation: Some(current),
                                opencode_transfer_receipt: None,
                                opencode_adoption: Default::default(),
                            })
                        }
                    }
                }
                HostCommand::Status { .. } => Ok(HostResult::Status {
                    host_boot_id: boot.clone(),
                    worker_pid: Some(42),
                    worker_launch_count: 1,
                    max_control_epoch: grant_epoch,
                    max_execution_generation: execution_generation,
                    fixture_evidence: serde_json::json!({}),
                    exited: false,
                    native_session_id: observation
                        .as_ref()
                        .map(|value| value.native_session_id.clone()),
                    native_identity_observation: observation.clone(),
                    opencode_transfer_receipt: None,
                    opencode_adoption: Default::default(),
                }),
                _ => return,
            };
            if write_frame(
                &mut socket,
                &HostReply {
                    request_id: request.request_id,
                    result,
                },
            )
            .await
            .is_err()
            {
                return;
            }
        }
    }

    fn supervisor(dir: &Path, backend: Arc<FakeBackend>) -> Supervisor {
        Supervisor::new(
            Registry::open(dir.join("registry"), None).unwrap(),
            backend,
            SupervisorConfig {
                runtime_root: dir.join("runtime"),
                control_socket_path: dir.join("control.sock"),
                host_binary_path: std::env::current_exe().unwrap(),
                image_ref: format!("sha256:{}", "a".repeat(64)),
                test_run_id: "codex-pre-worker-retry".into(),
                control_secret: "synthetic-pre-worker-control-secret".into(),
                lifecycle_log: dir.join("lifecycle.jsonl"),
                admission: AdmissionPolicy::default(),
            },
        )
        .unwrap()
    }

    fn launch_request(soul_id: SoulId) -> LaunchRequest {
        serde_json::from_value(serde_json::json!({
            "soulId": soul_id,
            "provider": "codex",
            "providerStoreId": "synthetic-codex-store",
            "creationSeedRef": "synthetic-codex-create",
            "nativeSessionId": "synthetic-codex-session",
            "limits": {
                "cpuMilli": 500,
                "memoryBytes": 67108864,
                "swapBytes": 0,
                "pidsMax": 32
            },
            "profile": RuntimeProfile::Custom,
            "projectKey": "codex-pre-worker-retry",
            "terminal": {
                "terminalId": "synthetic-codex-terminal",
                "streamId": "synthetic-codex-stream",
                "mode": "codex",
                "program": "codex",
                "cwd": "/workspace",
                "workspacePath": "/workspace",
                "runAsUid": 65534,
                "runAsGid": 0,
                "cols": 80,
                "rows": 24,
                "projectKey": "codex-pre-worker-retry"
            }
        }))
        .unwrap()
    }

    fn fresh_agent_launch_request(soul_id: SoulId, provider: &str) -> LaunchRequest {
        let session_type = match provider {
            "codex" => "freshcodex",
            "claude" => "freshclaude",
            _ => panic!("unsupported fresh-agent fixture provider: {provider}"),
        };
        serde_json::from_value(serde_json::json!({
            "soulId": soul_id,
            "provider": provider,
            "providerStoreId": format!("synthetic-{provider}-store"),
            "creationSeedRef": format!("synthetic-{provider}-create"),
            "limits": {
                "cpuMilli": 500,
                "memoryBytes": 67108864,
                "swapBytes": 0,
                "pidsMax": 32
            },
            "profile": RuntimeProfile::Custom,
            "projectKey": "fresh-agent-pre-worker-retry",
            "freshAgent": {
                "sessionId": format!("synthetic-{provider}-session"),
                "provider": provider,
                "sessionType": session_type,
                "runtimeVariant": "owned-test-variant",
                "providerStoreId": format!("synthetic-{provider}-store"),
                "cwd": "/workspace",
                "workspacePath": "/workspace",
                "runAsUid": 65534,
                "runAsGid": 0
            }
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn verified_codex_pre_worker_failure_allows_one_ordinary_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let backend = Arc::new(FakeBackend::new(
            FirstGrantOutcome::CodexAppServerStartFailed,
        ));
        let supervisor = supervisor(dir.path(), Arc::clone(&backend));
        let soul = SoulId::new();

        let error = supervisor
            .launch(RequestId::new(), launch_request(soul.clone()))
            .await
            .expect_err("the injected pre-worker Codex startup failure should surface");
        assert_eq!(error.code, RuntimeErrorCode::HostUnreachable);
        assert_eq!(
            error.diagnostic_code,
            Some(RuntimeDiagnosticCode::CodexAppServerStartFailed)
        );
        let failed_attempt = supervisor.registry.inventory().await.unwrap();
        assert_eq!(failed_attempt.len(), 1);
        assert_eq!(failed_attempt[0].launch_state, LaunchState::Failed);
        assert_eq!(
            failed_attempt[0].cleanup_state,
            freshell_runtime_protocol::CleanupState::VerifiedEmpty
        );
        let conn = rusqlite::Connection::open(supervisor.registry.database_path()).unwrap();
        let (command_state, writer_claims, reservations): (String, u64, u64) = conn
            .query_row(
                "SELECT (SELECT state FROM commands WHERE incarnation_id=?1), (SELECT COUNT(*) FROM writer_claims WHERE incarnation_id=?1), (SELECT COUNT(*) FROM admission_reservations WHERE incarnation_id=?1)",
                [failed_attempt[0].incarnation_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(command_state, "failed");
        assert_eq!(writer_claims, 0);
        assert_eq!(reservations, 0);

        let result = supervisor
            .launch(RequestId::new(), launch_request(soul.clone()))
            .await
            .unwrap_or_else(|error| {
                panic!(
                    "a verified pre-worker failure should permit a new ordinary launch: {:?}",
                    error.code
                )
            });
        assert_eq!(result.view.launch_state, LaunchState::Running);
        assert_eq!(result.worker_launch_count, 1);
        assert_eq!(backend.counts.creates.load(Ordering::SeqCst), 2);
        assert_eq!(backend.counts.grants.load(Ordering::SeqCst), 2);
        assert_eq!(backend.counts.workers.load(Ordering::SeqCst), 1);
        assert_eq!(backend.counts.possible_workers.load(Ordering::SeqCst), 0);
        assert_eq!(backend.counts.stop_requests.load(Ordering::SeqCst), 1);
        assert_eq!(backend.counts.force_stops.load(Ordering::SeqCst), 0);
        assert_eq!(backend.counts.empty_checks.load(Ordering::SeqCst), 2);

        let views = supervisor.registry.inventory().await.unwrap();
        assert_eq!(views.len(), 2);
        let failed = views
            .iter()
            .find(|view| view.incarnation_id != result.view.incarnation_id)
            .unwrap();
        assert_eq!(failed.launch_state, LaunchState::Failed);
        assert_eq!(
            failed.cleanup_state,
            freshell_runtime_protocol::CleanupState::VerifiedEmpty
        );
        assert_eq!(
            backend.stop_targets.lock().unwrap().as_slice(),
            &[(
                failed.incarnation_id.clone(),
                failed.container_id.clone().unwrap(),
            )]
        );

        let lifecycle = std::fs::read_to_string(&supervisor.config.lifecycle_log).unwrap();
        let events = lifecycle
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .collect::<Vec<_>>();
        let failure = events
            .iter()
            .find(|event| event["event"] == "supervisor.activation_failed")
            .expect("the failure retains its existing lifecycle event");
        assert_eq!(failure["data"]["stage"], "deliver_execution_grant");
        assert_eq!(failure["data"]["launchState"], "starting");
        assert_eq!(
            failure["data"]["failureReason"],
            "CODEX_APP_SERVER_START_FAILED"
        );
        assert!(failure["data"].get("errorMessage").is_none());
        assert!(!lifecycle.contains("synthetic-private-codex-output-marker"));
    }

    #[tokio::test]
    async fn verified_codex_proxy_pre_worker_failure_allows_one_ordinary_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let backend = Arc::new(FakeBackend::new(FirstGrantOutcome::CodexProxyStartFailed));
        let supervisor = supervisor(dir.path(), Arc::clone(&backend));
        let soul = SoulId::new();

        let error = supervisor
            .launch(RequestId::new(), launch_request(soul.clone()))
            .await
            .expect_err("the injected pre-worker Codex proxy failure should surface");
        assert_eq!(error.code, RuntimeErrorCode::HostUnreachable);
        assert_eq!(
            error.diagnostic_code,
            Some(RuntimeDiagnosticCode::CodexProxyStartFailed)
        );
        let failed_attempt = supervisor.registry.inventory().await.unwrap();
        assert_eq!(failed_attempt.len(), 1);
        assert_eq!(failed_attempt[0].launch_state, LaunchState::Failed);
        assert_eq!(
            failed_attempt[0].cleanup_state,
            freshell_runtime_protocol::CleanupState::VerifiedEmpty
        );

        let replacement = supervisor
            .launch(RequestId::new(), launch_request(soul))
            .await
            .unwrap_or_else(|error| {
                panic!(
                    "a verified pre-worker proxy failure should permit a new ordinary launch: {:?}",
                    error.code
                )
            });
        assert_eq!(replacement.view.launch_state, LaunchState::Running);
        assert_eq!(replacement.worker_launch_count, 1);
        assert_eq!(backend.counts.creates.load(Ordering::SeqCst), 2);
        assert_eq!(backend.counts.grants.load(Ordering::SeqCst), 2);
        assert_eq!(backend.counts.workers.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn fresh_agent_codex_provider_start_failure_settles_after_exact_empty_check() {
        let dir = tempfile::tempdir().unwrap();
        let backend = Arc::new(FakeBackend::new(
            FirstGrantOutcome::FreshAgentProviderStartFailed,
        ));
        let supervisor = supervisor(dir.path(), Arc::clone(&backend));
        let soul = SoulId::new();

        let error = supervisor
            .launch(RequestId::new(), fresh_agent_launch_request(soul, "codex"))
            .await
            .expect_err("the injected fresh Codex provider start failure should surface");
        assert_eq!(error.code, RuntimeErrorCode::HostUnreachable);
        assert_eq!(
            error.diagnostic_code,
            Some(RuntimeDiagnosticCode::FreshAgentProviderStartFailed)
        );
        let views = supervisor.registry.inventory().await.unwrap();
        assert_eq!(views.len(), 1);
        let failed = &views[0];
        assert_eq!(failed.launch_state, LaunchState::Failed);
        assert_eq!(
            failed.cleanup_state,
            freshell_runtime_protocol::CleanupState::VerifiedEmpty
        );
        let exact_target = (
            failed.incarnation_id.clone(),
            failed.container_id.clone().unwrap(),
        );
        assert_eq!(
            backend.stop_targets.lock().unwrap().as_slice(),
            std::slice::from_ref(&exact_target)
        );
        assert_eq!(
            backend.empty_targets.lock().unwrap().as_slice(),
            &[exact_target.clone(), exact_target.clone()]
        );
        assert_eq!(
            backend.cleanup_steps.lock().unwrap().as_slice(),
            &[
                (
                    "verify_empty".into(),
                    exact_target.0.clone(),
                    exact_target.1.clone()
                ),
                (
                    "request_stop".into(),
                    exact_target.0.clone(),
                    exact_target.1.clone()
                ),
                (
                    "verify_empty".into(),
                    exact_target.0.clone(),
                    exact_target.1.clone()
                ),
            ]
        );

        let conn = rusqlite::Connection::open(supervisor.registry.database_path()).unwrap();
        let (writer_claims, reservations): (u64, u64) = conn
            .query_row(
                "SELECT (SELECT COUNT(*) FROM writer_claims WHERE incarnation_id=?1), (SELECT COUNT(*) FROM admission_reservations WHERE incarnation_id=?1)",
                [failed.incarnation_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(writer_claims, 0);
        assert_eq!(reservations, 0);
        let lifecycle = std::fs::read_to_string(&supervisor.config.lifecycle_log).unwrap();
        let settled = lifecycle
            .lines()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .find(|event| event["event"] == "supervisor.codex_pre_worker_failure_settled")
            .expect("the verified failure has a structured settlement event");
        assert_eq!(
            settled["data"]["failureReason"],
            "FRESH_AGENT_PROVIDER_START_FAILED"
        );
    }

    #[tokio::test]
    async fn fresh_agent_non_codex_provider_start_failure_skips_codex_cleanup() {
        let dir = tempfile::tempdir().unwrap();
        let backend = Arc::new(FakeBackend::new(
            FirstGrantOutcome::FreshAgentProviderStartFailed,
        ));
        let supervisor = supervisor(dir.path(), Arc::clone(&backend));

        let error = supervisor
            .launch(
                RequestId::new(),
                fresh_agent_launch_request(SoulId::new(), "claude"),
            )
            .await
            .expect_err("the injected fresh Claude provider start failure should surface");
        assert_eq!(
            error.diagnostic_code,
            Some(RuntimeDiagnosticCode::FreshAgentProviderStartFailed)
        );
        assert_eq!(backend.counts.stop_requests.load(Ordering::SeqCst), 0);
        assert_eq!(backend.counts.empty_checks.load(Ordering::SeqCst), 0);
        assert!(backend.stop_targets.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn ambiguous_codex_grant_keeps_the_incarnation_non_replaceable() {
        let dir = tempfile::tempdir().unwrap();
        let backend = Arc::new(FakeBackend::new(FirstGrantOutcome::WorkerMayHaveStarted));
        let supervisor = supervisor(dir.path(), Arc::clone(&backend));
        let soul = SoulId::new();

        let error = supervisor
            .launch(RequestId::new(), launch_request(soul.clone()))
            .await
            .expect_err("the fake host drops an ambiguous grant response");
        assert_eq!(error.code, RuntimeErrorCode::HostUnreachable);
        assert_eq!(
            error.diagnostic_code,
            Some(RuntimeDiagnosticCode::HostCommandFrameFailed)
        );
        let retry = supervisor
            .launch(RequestId::new(), launch_request(soul))
            .await
            .expect_err("uncertain worker existence must retain the active incarnation");
        assert_ne!(retry.code, RuntimeErrorCode::HostUnreachable);
        assert_eq!(backend.counts.creates.load(Ordering::SeqCst), 1);
        assert_eq!(backend.counts.grants.load(Ordering::SeqCst), 1);
        assert_eq!(backend.counts.workers.load(Ordering::SeqCst), 0);
        assert_eq!(backend.counts.possible_workers.load(Ordering::SeqCst), 1);
        assert_eq!(backend.counts.stop_requests.load(Ordering::SeqCst), 0);
        assert_eq!(backend.counts.force_stops.load(Ordering::SeqCst), 0);
        assert_eq!(backend.counts.empty_checks.load(Ordering::SeqCst), 0);
        let views = supervisor.registry.inventory().await.unwrap();
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].launch_state, LaunchState::Starting);
    }
}

#[cfg(test)]
mod stop_intent_order_tests {
    use super::*;
    use crate::{
        admission::AdmissionPolicy,
        registry::{BackendCreatedRecord, LaunchPreparation},
    };
    use freshell_runtime_protocol::{
        DockerDaemonId, HostBootId, RuntimeLimits, RuntimeProfile, SoulId,
    };
    use rusqlite::Connection;
    use std::sync::Arc;

    #[tokio::test]
    async fn stop_commits_intent_while_waiting_for_the_soul_coordinator() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path().join("registry"), None).unwrap();
        let soul = SoulId::new();
        let limits = RuntimeLimits {
            cpu_milli: 500,
            memory_bytes: 64 * 1024 * 1024,
            swap_bytes: 0,
            pids_max: 32,
        };
        let prepared = registry
            .prepare_launch(LaunchPreparation {
                soul_id: soul.clone(),
                provider: "fixture".into(),
                provider_store_id: "store-stop-order".into(),
                native_session_id: None,
                creation_seed_ref: "seed".into(),
                request_id: RequestId::new(),
                payload_digest: "stop-order-test".into(),
                requested_limits: limits,
                profile: RuntimeProfile::Custom,
                project_key: "stop-order-test".into(),
                fixture: None,
                terminal: None,
                fresh_agent: None,
                view_intent: None,
                admission: AdmissionPolicy::default(),
            })
            .await
            .unwrap();
        registry
            .commit_created(
                prepared.incarnation_id.clone(),
                BackendCreatedRecord {
                    daemon_id: DockerDaemonId::new(),
                    container_id: "stop-order-container".into(),
                    image_ref: "stop-order-image".into(),
                    runtime_dir: dir.path().join("runtime"),
                    host_binary_path: dir.path().join("runtime/session-host"),
                    immutable_config_digest: "stop-order-config".into(),
                    launch_policy: None,
                },
            )
            .await
            .unwrap();
        registry
            .commit_execution_grant(prepared.incarnation_id.clone(), HostBootId::new(), limits)
            .await
            .unwrap();
        registry
            .mark_running(prepared.incarnation_id)
            .await
            .unwrap();
        let supervisor = Supervisor::new(
            registry.clone(),
            Arc::new(DockerEngineBackend::new(
                dir.path().join("unused-docker.sock"),
            )),
            SupervisorConfig {
                runtime_root: dir.path().join("runtime"),
                control_socket_path: dir.path().join("control.sock"),
                host_binary_path: std::env::current_exe().unwrap(),
                image_ref: format!("sha256:{}", "a".repeat(64)),
                test_run_id: "stop-order-test".into(),
                control_secret: "synthetic-test-secret".into(),
                lifecycle_log: dir.path().join("lifecycle.jsonl"),
                admission: AdmissionPolicy::default(),
            },
        )
        .unwrap();

        let lifecycle_lock = supervisor.lifecycle_lock(&soul).await;
        let held = lifecycle_lock.lock().await;
        let stopping = {
            let supervisor = supervisor.clone();
            let soul = soul.clone();
            tokio::spawn(async move { supervisor.stop(soul, None).await })
        };
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if registry
                    .recovery_context(soul.clone())
                    .await
                    .unwrap()
                    .desired_state
                    == freshell_runtime_protocol::DesiredState::Stopped
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("Stop intent should not wait behind provider/recovery work");
        assert!(
            !stopping.is_finished(),
            "cleanup must still wait until the in-flight operation releases the coordinator"
        );
        stopping.abort();
        drop(held);

        let conn = Connection::open(registry.database_path()).unwrap();
        let (desired, state): (String, String) = conn
            .query_row(
                "SELECT desired_state,recovery_state FROM souls WHERE soul_id=?1",
                rusqlite::params![soul.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((desired.as_str(), state.as_str()), ("stopped", "stopped"));
    }
}

fn semantic_launch_digest(
    request: &freshell_runtime_protocol::LaunchRequest,
) -> Result<String, RuntimeError> {
    let mut terminal = request.terminal.clone();
    if let Some(terminal) = &mut terminal {
        // A fresh staging attempt is transport ownership, not a different
        // launch. Retries for the same stable request retain idempotency.
        terminal.opencode_transfer_attempt_id = None;
    }
    let value = serde_json::json!({
        "soulId": request.soul_id,
        "provider": request.provider,
        "providerStoreId": request.provider_store_id,
        "creationSeedRef": request.creation_seed_ref,
        "limits": request.limits,
        "profile": request.profile,
        "projectKey": request.project_key,
        "nativeSessionId": request.native_session_id,
        "fixture": request.fixture,
        "terminal": terminal,
        "freshAgent": request.fresh_agent,
    });
    let bytes = serde_json::to_vec(&value)
        .map_err(|e| RuntimeError::new(RuntimeErrorCode::InvalidRequest, e.to_string()))?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

#[cfg(test)]
mod opencode_launch_digest_tests {
    use super::semantic_launch_digest;
    use freshell_runtime_protocol::LaunchRequest;

    fn request() -> LaunchRequest {
        serde_json::from_value(serde_json::json!({
            "soulId": "soul-transfer-retry",
            "provider": "opencode",
            "providerStoreId": "soul-transfer-retry",
            "creationSeedRef": "stable-create-key",
            "limits": {
                "cpuMilli": 2000,
                "memoryBytes": 4096,
                "swapBytes": 0,
                "pidsMax": 512
            },
            "nativeSessionId": "native-session",
            "terminal": {
                "terminalId": "terminal-one",
                "streamId": "stream-one",
                "mode": "opencode",
                "program": "/usr/bin/opencode",
                "cwd": "/workspace",
                "runAsUid": 65534,
                "runAsGid": 0,
                "cols": 80,
                "rows": 24,
                "projectKey": "project-one",
                "workspacePath": "/workspace",
                "resumeSessionId": "native-session",
                "opencodeTransfer": {
                    "transferId": "transfer-one",
                    "provider": "opencode",
                    "sourceStoreId": "a".repeat(64),
                    "rootSessionId": "native-session",
                    "sourceGeneration": "b".repeat(64),
                    "providerSchema": "opencode-1.18.21",
                    "sourceSchemaFingerprint": "c".repeat(64),
                    "migrationJournalFingerprint": "d".repeat(64),
                    "destinationStoreId": "soul-transfer-retry",
                    "destinationDatabasePath": ".local/share/opencode/opencode.db",
                    "targetImageRef": format!("sha256:{}", "e".repeat(64)),
                    "targetBuildReceipt": "f".repeat(64),
                    "incarnationId": "incarnation-one",
                    "manifestJson": "{}",
                    "files": [{
                        "index": 0,
                        "relativePath": "payload.json",
                        "sizeBytes": 0,
                        "sha256": "0".repeat(64)
                    }],
                    "totalBytes": 0,
                    "bundleSha256": "1".repeat(64)
                },
                "opencodeTransferAttemptId": "a".repeat(32)
            }
        }))
        .unwrap()
    }

    #[test]
    fn a_new_staging_attempt_keeps_the_same_launch_idempotency_digest() {
        let first = request();
        let mut retry = first.clone();
        retry
            .terminal
            .as_mut()
            .unwrap()
            .opencode_transfer_attempt_id = Some("b".repeat(32));

        assert_eq!(
            semantic_launch_digest(&first).unwrap(),
            semantic_launch_digest(&retry).unwrap()
        );
        retry.terminal.as_mut().unwrap().resume_session_id = Some("other-session".into());
        assert_ne!(
            semantic_launch_digest(&first).unwrap(),
            semantic_launch_digest(&retry).unwrap(),
            "stable launch intent must remain part of the digest"
        );
    }
}

#[cfg(test)]
mod opencode_transfer_restart_tests {
    use super::*;
    use freshell_runtime_protocol::{
        opencode_target_build_receipt, opencode_transfer_bundle_digest, OpenCodeTransferChunk,
        OpenCodeTransferDescriptor, OpenCodeTransferFile,
    };
    use rusqlite::{params, Connection};

    const ATTEMPT_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const ATTEMPT_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    #[tokio::test]
    async fn recovery_dispatch_validates_controls_before_reservation() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path().join("registry"), None).unwrap();
        let soul = SoulId::new();
        crate::registry::tests::materialize_test_runtime(&registry, soul.clone()).await;
        let context = registry.recovery_context(soul.clone()).await.unwrap();
        let supervisor = crate::recovery::tests::missing_supervisor(&dir, registry);
        for (case, expected) in [
            ("protocol", RuntimeErrorCode::ProtocolVersionMismatch),
            ("role", RuntimeErrorCode::UnauthorizedRole),
            ("credential", RuntimeErrorCode::UnauthorizedRole),
            ("epoch", RuntimeErrorCode::StaleControlEpoch),
            ("intent", RuntimeErrorCode::StaleIntentRevision),
        ] {
            let mut envelope = Envelope::new(
                RequestId::new(),
                if case == "role" {
                    ControlRole::Runtime
                } else {
                    ControlRole::Web
                },
                AdminCommand::Recover(freshell_runtime_protocol::RecoverRequest {
                    soul_id: soul.clone(),
                    trigger: freshell_runtime_protocol::RecoveryTrigger::ManualRetry,
                    expected_intent_revision: Some(
                        context.intent_revision + u64::from(case == "intent"),
                    ),
                    // Earlier invalid controls must reject before the stale epoch.
                    expected_control_epoch: Some(
                        supervisor.registry.control_epoch() + u64::from(case != "intent"),
                    ),
                }),
            );
            envelope.auth = Some(
                if case == "credential" {
                    "invalid"
                } else {
                    "synthetic-secret"
                }
                .into(),
            );
            if case == "protocol" {
                envelope.protocol_version += 1;
            }
            let request_id = envelope.request_id.clone();
            let reply = supervisor.dispatch(envelope).await;
            assert_eq!(reply.request_id, request_id);
            assert_eq!(reply.result.unwrap_err().code, expected, "{case}");
            let current = supervisor
                .registry
                .recovery_context(soul.clone())
                .await
                .unwrap();
            assert_eq!(current.intent_revision, context.intent_revision, "{case}");
            assert!(current.recovery_attempt_id.is_none(), "{case}");
            assert!(
                supervisor
                    .registry
                    .recovery_retry(soul.clone(), context.intent_revision)
                    .await
                    .unwrap()
                    .is_none(),
                "{case}"
            );
        }
    }

    #[tokio::test]
    async fn fresh_acknowledged_input_retry_survives_unreachable_host() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path().join("registry"), None).unwrap();
        let soul = SoulId::new();
        let prepared =
            crate::registry::tests::materialize_fresh_runtime(&registry, soul.clone(), dir.path())
                .await;
        let runtime = dir.path().join("owned-host");
        std::fs::create_dir(&runtime).unwrap();
        std::fs::write(runtime.join("secret"), b"synthetic-secret").unwrap();
        Connection::open(dir.path().join("registry/runtime.sqlite3"))
            .unwrap()
            .execute(
                "UPDATE incarnations SET runtime_dir=?1 WHERE incarnation_id=?2",
                params![runtime.to_string_lossy(), prepared.incarnation_id.as_str()],
            )
            .unwrap();
        let request = RequestId::new();
        let correlation =
            serde_json::to_vec(&Option::<freshell_runtime_protocol::FreshAgentTurnSettings>::None)
                .unwrap();
        registry
            .begin_input(
                soul.clone(),
                request.clone(),
                b"already acknowledged",
                Some(&correlation),
            )
            .await
            .unwrap();
        registry
            .mark_input_completed(soul.clone(), request.clone())
            .await
            .unwrap();
        // The registry still exposes the accepted incarnation after its
        // control socket disappears. A retry reads the durable result and
        // must not contact or re-send to that failed host.
        registry.active_handle_for_soul(soul.clone()).await.unwrap();
        let supervisor = crate::recovery::tests::supervisor_with_runtime_state(
            &dir,
            registry.clone(),
            crate::backend::BackendRuntimeState::Running,
        );
        for expected in [CommandState::Completed, CommandState::Ambiguous] {
            if expected == CommandState::Ambiguous {
                registry
                    .mark_input_ambiguous(soul.clone(), request.clone())
                    .await
                    .unwrap();
            }
            assert_eq!(
                supervisor
                    .fresh_agent_send(
                        request.clone(),
                        soul.clone(),
                        "already acknowledged".into(),
                        None,
                        None,
                    )
                    .await
                    .unwrap(),
                expected,
            );
        }
        assert_eq!(
            supervisor
                .fresh_agent_send(
                    request.clone(),
                    soul.clone(),
                    "changed request".into(),
                    None,
                    None,
                )
                .await
                .unwrap_err()
                .code,
            RuntimeErrorCode::RequestIdConflict,
        );
        let new_request = RequestId::new();
        assert!(supervisor
            .fresh_agent_send(
                new_request.clone(),
                soul.clone(),
                "new input".into(),
                None,
                None
            )
            .await
            .is_err());
        let conn = Connection::open(dir.path().join("registry/runtime.sqlite3")).unwrap();
        assert!(!conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM input_commands WHERE soul_id=?1 AND request_id=?2)",
            params![soul.as_str(), new_request.as_str()],
            |row| row.get::<_, bool>(0),
        ).unwrap(), "unavailable host must not admit a new replayable request");
        let queued_request = RequestId::new();
        registry
            .begin_input(
                soul.clone(),
                queued_request.clone(),
                b"queued input",
                Some(&correlation),
            )
            .await
            .unwrap();
        assert!(supervisor
            .fresh_agent_send(
                queued_request.clone(),
                soul.clone(),
                "queued input".into(),
                None,
                None
            )
            .await
            .is_err());
        assert_eq!(
            conn.query_row(
                "SELECT state FROM input_commands WHERE soul_id=?1 AND request_id=?2",
                params![soul.as_str(), queued_request.as_str()],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "queued"
        );
    }

    #[tokio::test]
    async fn fresh_native_transition_must_commit_before_input_and_recovery_probe() {
        use freshell_runtime_protocol::{
            NativeIdentityLaunch, NativeIdentityObservation, NativeIdentitySource, RecoveryProbe,
        };
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path().join("registry"), None).unwrap();
        let soul = SoulId::new();
        let prepared =
            crate::registry::tests::materialize_fresh_runtime(&registry, soul.clone(), dir.path())
                .await;
        let runtime = dir.path().join("owned-host");
        std::fs::create_dir(&runtime).unwrap();
        std::fs::write(runtime.join("secret"), b"synthetic-secret").unwrap();
        let conn = Connection::open(dir.path().join("registry/runtime.sqlite3")).unwrap();
        conn.execute(
            "UPDATE incarnations SET runtime_dir=?1,execution_generation=1 WHERE incarnation_id=?2",
            params![runtime.to_string_lossy(), prepared.incarnation_id.as_str()],
        )
        .unwrap();
        registry
            .record_native_session(
                soul.clone(),
                prepared.incarnation_id.clone(),
                "native-parent".into(),
            )
            .await
            .unwrap();
        let context = registry.recovery_context(soul.clone()).await.unwrap();
        let parent_launch = NativeIdentityLaunch {
            incarnation_id: prepared.incarnation_id.clone(),
            launch_nonce: context.prior_handle.launch_nonce().as_str().into(),
            evidence_revision: 7,
            execution_generation: 1,
            requested_native_session_id: Some("native-parent".into()),
        };
        registry
            .bind_native_identity_launch(parent_launch.clone())
            .await
            .unwrap();
        let proof = |root: &str, revision: u64| NativeIdentityObservation {
            native_session_id: root.into(),
            incarnation_id: prepared.incarnation_id.clone(),
            launch_nonce: parent_launch.launch_nonce.clone(),
            evidence_revision: revision,
            source: NativeIdentitySource::FreshProviderHandshake,
            evidence_digest: "a".repeat(64),
        };
        let parent_proof = proof("native-parent", 7);
        let child_proof = proof("native-child", 8);
        let current_proof = Arc::new(std::sync::Mutex::new(Some(child_proof.clone())));
        let worker_present = Arc::new(AtomicBool::new(true));
        let inputs = Arc::new(AtomicUsize::new(0));
        let listener = UnixListener::bind(runtime.join("host.sock")).unwrap();
        let responder = {
            let current_proof = current_proof.clone();
            let worker_present = worker_present.clone();
            let inputs = inputs.clone();
            tokio::spawn(async move {
                let boot = HostBootId::new();
                loop {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let request: Envelope<HostCommand> = read_frame(&mut socket).await.unwrap();
                    let result = match request.body {
                        HostCommand::Hello {
                            incarnation_id,
                            challenge,
                        } => HostResult::Hello {
                            proof: host_proof(
                                b"synthetic-secret",
                                &challenge,
                                &boot,
                                &incarnation_id,
                            ),
                            host_boot_id: boot.clone(),
                            capabilities: vec![
                                "owned-provider-config-v1".into(),
                                "provider-store-probe-v1".into(),
                                "native-identity-observation-v1".into(),
                            ],
                            effective_limits: context.requested_limits,
                        },
                        HostCommand::Status { .. } => {
                            let observation = current_proof.lock().unwrap().clone();
                            HostResult::Status {
                                native_session_id: observation
                                    .as_ref()
                                    .map(|proof| proof.native_session_id.clone()),
                                native_identity_observation: observation,
                                host_boot_id: boot.clone(),
                                worker_pid: worker_present.load(Ordering::SeqCst).then_some(123),
                                worker_launch_count: 1,
                                max_control_epoch: 1,
                                max_execution_generation: 1,
                                fixture_evidence: serde_json::json!({}),
                                exited: false,
                                opencode_transfer_receipt: None,
                                opencode_adoption: Default::default(),
                            }
                        }
                        HostCommand::FreshAgentSend { .. } => {
                            inputs.fetch_add(1, Ordering::SeqCst);
                            HostResult::FreshAgentCommand {
                                state: CommandState::ProviderAcked,
                                native_session_id: Some("native-child".into()),
                                claude_fork: None,
                            }
                        }
                        HostCommand::FreshAgentFork { .. } => HostResult::FreshAgentFork(
                            freshell_runtime_protocol::FreshAgentForkResult {
                                claude_fork: None,
                                parent_session_id: "native-parent".into(),
                                child_session_id: "native-child".into(),
                                parent_retired_by_runtime: true,
                            },
                        ),
                        HostCommand::FreshAgentReadEvents { after_sequence, .. } => {
                            assert_eq!(after_sequence, 0, "web restart replays the host journal");
                            HostResult::FreshAgentEvents(
                                freshell_runtime_protocol::AgentEventBatch {
                                    retained_from: 1,
                                    head: 2,
                                    reset_required: false,
                                    events: ["native-parent", "native-child"]
                                        .into_iter()
                                        .enumerate()
                                        .map(|(index, native_session_id)| {
                                            freshell_runtime_protocol::AgentJournalEvent {
                                                sequence: index as u64 + 1,
                                                event:
                                                    freshell_runtime_protocol::AgentEvent::Started {
                                                        native_session_id: native_session_id.into(),
                                                    },
                                            }
                                        })
                                        .collect(),
                                },
                            )
                        }
                        HostCommand::ProbeRecovery {
                            resume_spec: Some(spec),
                            ..
                        } => HostResult::RecoveryProbe(RecoveryProbe::ResumeReady {
                            evidence_revision: spec.evidence_revision,
                            resume_spec: spec,
                        }),
                        other => panic!("unexpected controlled host command {other:?}"),
                    };
                    write_frame(
                        &mut socket,
                        &HostReply {
                            request_id: request.request_id,
                            result: Ok(result),
                        },
                    )
                    .await
                    .unwrap();
                }
            })
        };
        let supervisor = crate::recovery::tests::supervisor_with_runtime_state(
            &dir,
            registry.clone(),
            crate::backend::BackendRuntimeState::Running,
        );
        assert!(supervisor
            .fresh_agent_send(
                RequestId::new(),
                soul.clone(),
                "blocked child input".into(),
                None,
                None,
            )
            .await
            .is_err());
        assert_eq!(
            inputs.load(Ordering::SeqCst),
            0,
            "uncommitted native child cannot receive a prompt"
        );
        assert_eq!(
            supervisor
                .fresh_agent_resolve(
                    soul.clone(),
                    "uncommitted-decision".into(),
                    serde_json::json!({"behavior":"allow"})
                )
                .await
                .unwrap_err()
                .code,
            RuntimeErrorCode::RecoveryBlocked,
            "tool permission input also waits for the registry commit"
        );
        assert_eq!(
            supervisor
                .fresh_agent_compact(RequestId::new(), soul.clone(), None, None)
                .await
                .unwrap_err()
                .code,
            RuntimeErrorCode::RecoveryBlocked,
            "provider compaction also waits for the registry commit"
        );
        let transition = supervisor
            .fresh_agent_fork(RequestId::new(), soul.clone(), "native-parent".into(), None)
            .await
            .unwrap();
        assert_eq!(transition.child_session_id, "native-child");
        let replay = supervisor
            .fresh_agent_read_events(soul.clone(), 0, 128)
            .await
            .expect("historical parent Started must not block the committed child's journal");
        assert_eq!(replay.events.len(), 2);
        assert_eq!(replay.head, 2);
        assert_eq!(
            registry
                .recovery_context(soul.clone())
                .await
                .unwrap()
                .native_session_id
                .as_deref(),
            Some("native-child"),
            "historical Started must not replace the committed native identity"
        );
        let probe = supervisor
            .probe_recovery_locked(soul.clone())
            .await
            .unwrap();
        assert!(
            matches!(probe, RecoveryProbe::ReattachReady { .. }),
            "current child proof should reach actual probe policy: {probe:?}"
        );
        assert!(supervisor
            .fresh_agent_send(
                RequestId::new(),
                soul.clone(),
                "rejected settings input".into(),
                Some(freshell_runtime_protocol::FreshAgentTurnSettings {
                    cwd: Some(
                        dir.path()
                            .join("missing-cwd")
                            .to_string_lossy()
                            .into_owned()
                    ),
                    model: None,
                    effort: None,
                    permission_mode: None,
                    sandbox: None,
                }),
                None,
            )
            .await
            .is_err());
        assert_eq!(inputs.load(Ordering::SeqCst), 0);
        assert!(
            registry
                .claim_next_queued_input(soul.clone(), prepared.incarnation_id.clone())
                .await
                .unwrap()
                .is_none(),
            "a rejected settings request must not enter recovery's replay queue"
        );
        assert_eq!(
            supervisor
                .fresh_agent_send(
                    RequestId::new(),
                    soul.clone(),
                    "current child input".into(),
                    None,
                    None,
                )
                .await
                .unwrap(),
            CommandState::ProviderAcked
        );
        assert_eq!(inputs.load(Ordering::SeqCst), 1);
        worker_present.store(false, Ordering::SeqCst);
        assert!(matches!(
            supervisor
                .probe_recovery_locked(soul.clone())
                .await
                .unwrap(),
            RecoveryProbe::Blocked {
                path: freshell_runtime_protocol::RecoveryPath::Reattach,
                reason: freshell_runtime_protocol::RecoveryBlockReason::ProviderUnavailable,
                retry_hint: freshell_runtime_protocol::RetryHint {
                    automatic_after_ms: Some(2_000),
                    ..
                },
                ..
            }
        ));
        worker_present.store(true, Ordering::SeqCst);
        for stale in [Some(parent_proof), None] {
            *current_proof.lock().unwrap() = stale;
            assert!(supervisor
                .fresh_agent_send(
                    RequestId::new(),
                    soul.clone(),
                    "stale input".into(),
                    None,
                    None,
                )
                .await
                .is_err());
            assert_eq!(inputs.load(Ordering::SeqCst), 1);
            assert!(!matches!(
                supervisor
                    .probe_recovery_locked(soul.clone())
                    .await
                    .unwrap(),
                RecoveryProbe::ReattachReady { .. }
            ));
        }
        responder.abort();
        let _ = responder.await;
    }

    fn descriptor() -> OpenCodeTransferDescriptor {
        let payload = b"12345678";
        let source_store_id = "b".repeat(64);
        let source_schema_fingerprint = "c".repeat(64);
        let migration_journal_fingerprint = "d".repeat(64);
        let source_generation = "e".repeat(64);
        let target_image_ref = format!("sha256:{}", "a".repeat(64));
        let payload_sha256 = format!("{:x}", Sha256::digest(payload));
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
        let files = vec![OpenCodeTransferFile {
            index: 0,
            relative_path: "payload.json".into(),
            size_bytes: payload.len() as u64,
            sha256: payload_sha256,
        }];
        OpenCodeTransferDescriptor {
            transfer_id: "transfer-read-error-fence".into(),
            provider: "opencode".into(),
            source_store_id,
            root_session_id: "ses_exact".into(),
            source_generation,
            provider_schema: "opencode-1.18.21".into(),
            source_schema_fingerprint,
            migration_journal_fingerprint,
            destination_store_id: "soul-exact".into(),
            destination_database_path: ".local/share/opencode/opencode.db".into(),
            target_build_receipt: opencode_target_build_receipt(
                &target_image_ref,
                "opencode-1.18.21",
            ),
            target_image_ref,
            incarnation_id: "incarnation-test".into(),
            bundle_sha256: opencode_transfer_bundle_digest(&manifest_json, &files),
            manifest_json,
            files,
            total_bytes: payload.len() as u64,
        }
    }

    #[tokio::test]
    async fn terminal_opencode_readiness_waits_for_current_observation() {
        use crate::recovery::NativeIdentityWait;
        use freshell_runtime_protocol::{
            NativeIdentityLaunch, NativeIdentityObservation, NativeIdentitySource,
            OpenCodeAdoptionBaseline, OpenCodeAdoptionStatus,
        };
        for case in [
            "ordinary",
            "ordinary-create",
            "initial",
            "saved",
            "ordinary-exact",
            "fresh-opencode",
            "other-provider",
            "wrong-mode",
            "invalid",
            "stop",
            "stale-intent",
            "provider-exit",
            "host-failure",
            "unobserved",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let registry = Registry::open(dir.path().join("registry"), None).unwrap();
            let soul = SoulId::new();
            let prepared =
                crate::registry::tests::materialize_test_runtime(&registry, soul.clone()).await;
            let runtime = dir.path().join("owned-host");
            std::fs::create_dir(&runtime).unwrap();
            std::fs::write(runtime.join("secret"), b"synthetic-secret").unwrap();
            let conn = Connection::open(dir.path().join("registry/runtime.sqlite3")).unwrap();
            conn.execute("UPDATE incarnations SET runtime_dir=?1,execution_generation=1,fixture_kind=NULL WHERE incarnation_id=?2",
                params![runtime.to_string_lossy(), prepared.incarnation_id.as_str()]).unwrap();
            conn.execute(
                "UPDATE souls SET provider='opencode' WHERE soul_id=?1",
                [soul.as_str()],
            )
            .unwrap();
            if case == "other-provider" {
                conn.execute(
                    "UPDATE souls SET provider='codex' WHERE soul_id=?1",
                    [soul.as_str()],
                )
                .unwrap();
            }
            if case != "ordinary-create" {
                registry
                    .record_native_session(
                        soul.clone(),
                        prepared.incarnation_id.clone(),
                        "ses_exact".into(),
                    )
                    .await
                    .unwrap();
            }
            let context = registry.recovery_context(soul.clone()).await.unwrap();
            let binding = registry
                .bind_native_identity_launch(NativeIdentityLaunch {
                    incarnation_id: prepared.incarnation_id.clone(),
                    launch_nonce: context.prior_handle.launch_nonce().as_str().into(),
                    evidence_revision: context.evidence_revision,
                    execution_generation: 1,
                    requested_native_session_id: (case != "ordinary-create")
                        .then(|| "ses_exact".into()),
                })
                .await
                .unwrap();
            let context = registry.recovery_context(soul.clone()).await.unwrap();
            let mut terminal: TerminalLaunchSpec = serde_json::from_value(serde_json::json!({
                "terminalId":"terminal-import", "streamId":"stream-import", "mode":"opencode", "program":"opencode",
                "cwd":"/workspace", "workspacePath":"/workspace", "projectKey":"owned-import",
                "runAsUid":65534, "runAsGid":0, "cols":80, "rows":24,
                "env":{"HOME":"/home/freshell/provider"}, "resumeSessionId":"ses_exact",
                "opencodeTransfer":descriptor(), "opencodeTransferAttemptId":ATTEMPT_A,
            })).unwrap();
            terminal.validate().unwrap();
            let mut saved = None;
            if matches!(case, "saved" | "ordinary-exact") {
                let mut spec = freshell_agent_runtime::build_resume_spec(
                    freshell_agent_runtime::ResumeSpecInput {
                        provider: "opencode",
                        provider_store_id: &context.provider_store_id,
                        native_session_id: "ses_exact",
                        terminal: &terminal,
                        provider_version: Some("1.18.21".into()),
                        creation_seed_ref: context.creation_seed_ref.clone(),
                        checkpoint_revision: 0,
                        evidence_revision: context.evidence_revision,
                        never_dispatched: false,
                    },
                )
                .unwrap();
                if case == "saved" {
                    spec.opencode_adoption_baseline =
                        Some(OpenCodeAdoptionBaseline::from_descriptor(descriptor()).unwrap());
                }
                saved = Some(spec);
            }
            if !matches!(case, "initial" | "wrong-mode" | "invalid") {
                terminal.opencode_transfer = None;
                terminal.opencode_transfer_attempt_id = None;
            } else if case == "wrong-mode" {
                terminal.mode = "claude".into();
                assert!(terminal.validate().is_err());
            } else if case == "invalid" {
                terminal.opencode_transfer.as_mut().unwrap().bundle_sha256 = "invalid".into();
                assert!(terminal.validate().is_err());
            }
            let fresh_agent = (case == "fresh-opencode").then(|| {
                serde_json::from_value(serde_json::json!({
                "sessionId":"fresh-readiness", "provider":"opencode", "sessionType":"freshopencode",
                "runtimeVariant":"opencode-mcp", "providerStoreId":context.provider_store_id,
                "cwd":"/workspace", "workspacePath":"/workspace", "runAsUid":65534, "runAsGid":0
            })).unwrap()
            });
            let workload = LaunchWorkload {
                soul_id: soul.clone(),
                fixture: None,
                terminal: (case != "fresh-opencode").then_some(terminal),
                fresh_agent,
                resume_spec: saved,
            };
            let supervisor = crate::recovery::tests::missing_supervisor(&dir, registry.clone());
            let observation = NativeIdentityObservation {
                native_session_id: "ses_exact".into(),
                incarnation_id: binding.incarnation_id.clone(),
                launch_nonce: binding.launch_nonce.clone(),
                evidence_revision: binding.evidence_revision,
                source: if case == "fresh-opencode" {
                    NativeIdentitySource::FreshProviderHandshake
                } else if case == "other-provider" {
                    NativeIdentitySource::CodexAppServer
                } else {
                    NativeIdentitySource::OpencodeTui
                },
                evidence_digest: "a".repeat(64),
            };
            let listener = UnixListener::bind(runtime.join("host.sock")).unwrap();
            let limits = context.requested_limits;
            let started = Instant::now();
            let responder = tokio::spawn(async move {
                let boot = HostBootId::new();
                loop {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let request: Envelope<HostCommand> = read_frame(&mut socket).await.unwrap();
                    let elapsed = started.elapsed();
                    let observed = if elapsed < Duration::from_millis(250) {
                        None
                    } else {
                        let mut current = observation.clone();
                        if case == "unobserved" || elapsed < Duration::from_secs(9) {
                            match (elapsed.as_millis() / 250) % 3 {
                                0 => current.launch_nonce = "previous-launch".into(),
                                1 => current.evidence_revision += 1,
                                _ if case != "ordinary-create" => {
                                    current.native_session_id = "ses_wrong".into()
                                }
                                _ => current.incarnation_id = IncarnationId::new(),
                            }
                        }
                        Some(current)
                    };
                    let result = match request.body {
                        HostCommand::Hello {
                            incarnation_id,
                            challenge,
                        } => HostResult::Hello {
                            proof: host_proof(
                                b"synthetic-secret",
                                &challenge,
                                &boot,
                                &incarnation_id,
                            ),
                            host_boot_id: boot.clone(),
                            capabilities: vec!["native-identity-observation-v1".into()],
                            effective_limits: limits,
                        },
                        HostCommand::Status { .. } if case == "host-failure" => {
                            write_frame(
                                &mut socket,
                                &HostReply {
                                    request_id: request.request_id,
                                    result: Err(RuntimeError::new(
                                        RuntimeErrorCode::HostUnreachable,
                                        "owned host unavailable",
                                    )),
                                },
                            )
                            .await
                            .unwrap();
                            continue;
                        }
                        HostCommand::Status { .. } => HostResult::Status {
                            native_identity_observation: observed,
                            host_boot_id: boot.clone(),
                            worker_pid: Some(123),
                            worker_launch_count: 1,
                            max_control_epoch: 1,
                            max_execution_generation: 1,
                            fixture_evidence: serde_json::json!({}),
                            exited: case == "provider-exit"
                                && elapsed >= Duration::from_millis(250),
                            native_session_id: Some("ses_exact".into()),
                            opencode_transfer_receipt: None,
                            opencode_adoption: if matches!(case, "initial" | "saved") {
                                OpenCodeAdoptionStatus::AwaitingObservation
                            } else {
                                OpenCodeAdoptionStatus::NotRequired
                            },
                        },
                        _ => panic!("unexpected native wait command"),
                    };
                    write_frame(
                        &mut socket,
                        &HostReply {
                            request_id: request.request_id,
                            result: Ok(result),
                        },
                    )
                    .await
                    .unwrap();
                }
            });
            let cancellation = if matches!(case, "stop" | "stale-intent") {
                let registry = registry.clone();
                let soul = soul.clone();
                let database = dir.path().join("registry/runtime.sqlite3");
                Some(tokio::spawn(async move {
                    sleep(Duration::from_millis(250)).await;
                    if case == "stop" {
                        registry.begin_stop(soul).await.unwrap();
                    } else {
                        Connection::open(database).unwrap().execute(
                        "UPDATE souls SET intent_revision=intent_revision+1 WHERE soul_id=?1", [soul.as_str()]).unwrap();
                    }
                }))
            } else {
                None
            };
            let result = supervisor
                .wait_for_native_startup(
                    &workload,
                    &prepared.incarnation_id,
                    &context,
                    prepared.intent_revision,
                )
                .await;
            if let Some(cancellation) = cancellation {
                cancellation.await.unwrap();
            }
            responder.abort();
            assert!(responder.await.unwrap_err().is_cancelled());
            if matches!(
                case,
                "initial" | "saved" | "ordinary" | "ordinary-create" | "ordinary-exact"
            ) {
                assert!(
                    matches!(result, NativeIdentityWait::Observed { .. }),
                    "{case}: {result:?}"
                );
                if let NativeIdentityWait::Observed { elapsed_ms, .. } = &result {
                    assert!(*elapsed_ms >= 9_000);
                }
            } else if case == "stop" {
                assert!(
                    matches!(result, NativeIdentityWait::StopIntent { .. }),
                    "{result:?}"
                );
            } else if case == "stale-intent" {
                assert!(
                    matches!(result, NativeIdentityWait::IntentChanged { .. }),
                    "{result:?}"
                );
            } else if case == "provider-exit" {
                assert!(
                    matches!(result, NativeIdentityWait::ProviderExited { .. }),
                    "{result:?}"
                );
            } else if case == "host-failure" {
                assert!(
                    matches!(result, NativeIdentityWait::HostUnavailable { .. }),
                    "{result:?}"
                );
            } else if case == "unobserved" {
                assert!(matches!(
                    result,
                    NativeIdentityWait::TimedOut {
                        adoption_pending: false,
                        ..
                    }
                ));
                assert!(started.elapsed() >= Duration::from_secs(180));
                assert!(started.elapsed() < Duration::from_secs(190));
            } else {
                assert!(
                    matches!(result, NativeIdentityWait::TimedOut { .. }),
                    "{case}: {result:?}"
                );
                assert!(
                    started.elapsed() < Duration::from_secs(9),
                    "ordinary wait must end before the delayed observation"
                );
            }
            if matches!(
                case,
                "stop" | "stale-intent" | "provider-exit" | "host-failure"
            ) {
                assert!(
                    started.elapsed() < Duration::from_secs(2),
                    "prompt cancellation: {case}"
                );
            }
            let persisted: Option<String> = conn
                .query_row(
                    "SELECT native_identity_observation FROM incarnations WHERE incarnation_id=?1",
                    [prepared.incarnation_id.as_str()],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(
                persisted.is_none(),
                "waiting cannot publish outside the activation transaction"
            );
        }
    }

    #[tokio::test]
    async fn native_startup_failure_records_its_typed_subtype_without_host_error_details() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path().join("registry"), None).unwrap();
        let soul = SoulId::new();
        let prepared =
            crate::registry::tests::materialize_test_runtime(&registry, soul.clone()).await;
        let conn = Connection::open(dir.path().join("registry/runtime.sqlite3")).unwrap();
        conn.execute(
            "UPDATE souls SET provider='opencode' WHERE soul_id=?1",
            [soul.as_str()],
        )
        .unwrap();
        conn.execute(
            "UPDATE incarnations SET fixture_kind=NULL,runtime_dir=?1 WHERE incarnation_id=?2",
            params![
                dir.path().join("private-native-detail").to_string_lossy(),
                prepared.incarnation_id.as_str()
            ],
        )
        .unwrap();
        let context = registry.recovery_context(soul.clone()).await.unwrap();
        let workload = LaunchWorkload {
            soul_id: soul.clone(),
            fixture: None,
            terminal: None,
            fresh_agent: None,
            resume_spec: None,
        };
        let supervisor = crate::recovery::tests::missing_supervisor(&dir, registry);
        let result = supervisor
            .wait_for_native_startup(
                &workload,
                &prepared.incarnation_id,
                &context,
                prepared.intent_revision,
            )
            .await;
        assert!(matches!(
            result,
            crate::recovery::NativeIdentityWait::HostUnavailable { .. }
        ));
        let text = std::fs::read_to_string(dir.path().join("lifecycle.jsonl")).unwrap();
        let event = text
            .lines()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .find(|event| event["event"] == "supervisor.native_startup_wait_finished")
            .unwrap();
        assert_eq!(event["data"]["outcome"], "host_unavailable");
        assert_eq!(event["data"]["waitClass"], "ordinary");
        assert_eq!(event["data"]["soulId"], soul.as_str());
        assert_eq!(
            event["data"]["incarnationId"],
            prepared.incarnation_id.as_str()
        );
        assert_eq!(event["data"]["severity"], "warning");
        assert!(!text.contains("private-native-detail"));
        assert!(event["data"]["message"].is_null());
    }

    fn chunk(descriptor: &OpenCodeTransferDescriptor) -> OpenCodeTransferChunk {
        let data = b"12345678".to_vec();
        OpenCodeTransferChunk {
            transfer_id: descriptor.transfer_id.clone(),
            attempt_id: ATTEMPT_A.into(),
            sequence: 0,
            file_index: 0,
            offset: 0,
            sha256: format!("{:x}", Sha256::digest(&data)),
            data,
        }
    }

    fn supervisor(dir: &tempfile::TempDir, registry: Registry) -> Supervisor {
        Supervisor::new(
            registry,
            Arc::new(DockerEngineBackend::new(
                dir.path().join("unused-docker.sock"),
            )),
            SupervisorConfig {
                runtime_root: dir.path().join("runtime"),
                control_socket_path: dir.path().join("control.sock"),
                host_binary_path: std::env::current_exe().unwrap(),
                image_ref: format!("sha256:{}", "a".repeat(64)),
                test_run_id: "restart-reconcile-test".into(),
                control_secret: "synthetic-test-secret".into(),
                lifecycle_log: dir.path().join("lifecycle.jsonl"),
                admission: AdmissionPolicy::default(),
            },
        )
        .unwrap()
    }

    async fn begin_as_retry(
        supervisor: &Supervisor,
        descriptor: OpenCodeTransferDescriptor,
    ) -> Result<AdminResult, RuntimeError> {
        let mut envelope = Envelope::new(
            RequestId::new(),
            ControlRole::Web,
            AdminCommand::OpenCodeTransfer(OpenCodeTransferAction::Begin {
                descriptor: Box::new(descriptor),
                attempt_id: ATTEMPT_B.into(),
            }),
        );
        envelope.auth = Some("synthetic-test-secret".into());
        supervisor.dispatch(envelope).await.result
    }

    #[tokio::test]
    async fn registry_reference_read_error_does_not_release_registering_stage() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path().join("registry"), None).unwrap();
        let prepared = registry
            .prepare_launch(LaunchPreparation {
                soul_id: SoulId::new(),
                provider: "fixture".into(),
                provider_store_id: "store".into(),
                native_session_id: None,
                creation_seed_ref: "seed".into(),
                request_id: RequestId::new(),
                payload_digest: "test-read-error".into(),
                requested_limits: RuntimeLimits {
                    cpu_milli: 500,
                    memory_bytes: 64 * 1024 * 1024,
                    swap_bytes: 0,
                    pids_max: 32,
                },
                profile: freshell_runtime_protocol::RuntimeProfile::Custom,
                project_key: "test-project".into(),
                fixture: None,
                terminal: None,
                fresh_agent: None,
                view_intent: None,
                admission: AdmissionPolicy::default(),
            })
            .await
            .unwrap();
        let connection = Connection::open(registry.database_path()).unwrap();
        connection
            .execute(
                "UPDATE incarnations SET terminal_spec=?1 WHERE incarnation_id=?2",
                params![
                    serde_json::json!({
                        "opencodeTransfer": {"transferId": "transfer-read-error-fence"}
                    })
                    .to_string(),
                    prepared.incarnation_id.as_str()
                ],
            )
            .unwrap();
        drop(connection);

        let supervisor = supervisor(&dir, registry);
        let descriptor = descriptor();
        let staging = &supervisor.opencode_transfer_staging;
        staging.begin(&descriptor, ATTEMPT_A, 8).unwrap();
        staging.write_chunk(&chunk(&descriptor)).unwrap();
        staging
            .finalize(&descriptor.transfer_id, ATTEMPT_A)
            .unwrap();
        staging
            .mark_launch_registering(&descriptor, ATTEMPT_A, false)
            .unwrap();

        let error = begin_as_retry(&supervisor, descriptor.clone())
            .await
            .expect_err("an unreadable reference snapshot must fail Begin closed");
        assert_eq!(error.code, RuntimeErrorCode::RegistryFailure);
        assert!(
            staging.begin(&descriptor, ATTEMPT_B, 8).is_err(),
            "without a complete registry snapshot the previous registering attempt stays fenced"
        );
    }

    #[tokio::test]
    async fn begin_recovers_an_unreferenced_registering_stage_before_the_first_retry() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path().join("registry"), None).unwrap();
        let supervisor = supervisor(&dir, registry);
        let descriptor = descriptor();
        let staging = &supervisor.opencode_transfer_staging;
        staging.begin(&descriptor, ATTEMPT_A, 8).unwrap();
        staging.write_chunk(&chunk(&descriptor)).unwrap();
        staging
            .finalize(&descriptor.transfer_id, ATTEMPT_A)
            .unwrap();
        staging
            .mark_launch_registering(&descriptor, ATTEMPT_A, false)
            .unwrap();

        let result = begin_as_retry(&supervisor, descriptor)
            .await
            .expect("an empty, readable registry snapshot permits a fresh attempt");
        assert!(matches!(
            result,
            AdminResult::OpenCodeTransfer(OpenCodeTransferResult::Started {
                next_sequence: 1,
                ..
            })
        ));
    }
}

async fn find_view(
    registry: &Registry,
    incarnation_id: &IncarnationId,
) -> Result<RuntimeView, RuntimeError> {
    registry
        .inventory()
        .await
        .map_err(map_registry)?
        .into_iter()
        .find(|view| &view.incarnation_id == incarnation_id)
        .ok_or_else(|| {
            RuntimeError::new(
                RuntimeErrorCode::UnknownIncarnation,
                incarnation_id.to_string(),
            )
        })
}

fn map_opencode_transfer(error: crate::opencode_transfer::StagingError) -> RuntimeError {
    let code = match &error {
        crate::opencode_transfer::StagingError::InvalidDescriptor(_) => {
            RuntimeErrorCode::InvalidRequest
        }
        crate::opencode_transfer::StagingError::Capacity(_) => RuntimeErrorCode::BlockedResource,
        crate::opencode_transfer::StagingError::InvalidState(_)
        | crate::opencode_transfer::StagingError::Io(_)
        | crate::opencode_transfer::StagingError::Metadata(_) => RuntimeErrorCode::RegistryFailure,
    };
    RuntimeError::new(code, error.to_string())
}

fn map_registry(error: RegistryError) -> RuntimeError {
    let code = match &error {
        RegistryError::Busy => RuntimeErrorCode::RegistryBusy,
        RegistryError::RequestConflict | RegistryError::InputConflict => {
            RuntimeErrorCode::RequestIdConflict
        }
        RegistryError::StaleControlEpoch { .. } => RuntimeErrorCode::StaleControlEpoch,
        RegistryError::StaleIntentRevision { .. } => RuntimeErrorCode::StaleIntentRevision,
        RegistryError::LossCertificationBlocked(_) => RuntimeErrorCode::LossCertificationBlocked,
        RegistryError::IncidentPersistenceFailed(_) | RegistryError::IncidentNotFound(_) => {
            RuntimeErrorCode::IncidentPersistenceFailed
        }
        RegistryError::NoticeNotFound(_) => RuntimeErrorCode::NoticeNotFound,
        RegistryError::MigrationBlocked(_) => RuntimeErrorCode::MigrationBlocked,
        RegistryError::RepairBlocked(_) => RuntimeErrorCode::RepairBlocked,
        RegistryError::UnknownSoul(_) => RuntimeErrorCode::UnknownSoul,
        RegistryError::UnknownIncarnation(_) => RuntimeErrorCode::UnknownIncarnation,
        RegistryError::BlockedResource { .. } => RuntimeErrorCode::BlockedResource,
        RegistryError::FaultInjected(_) => RuntimeErrorCode::FaultInjected,
        _ => RuntimeErrorCode::RegistryFailure,
    };
    RuntimeError::new(code, error.to_string())
}

pub(crate) fn map_backend(error: BackendError) -> RuntimeError {
    let code = match &error {
        BackendError::OwnershipMismatch(_) => RuntimeErrorCode::OwnershipMismatch,
        error if crate::recovery_retry::TransientRecoveryFailure::from_backend(error).is_some() => {
            RuntimeErrorCode::BackendUnavailable
        }
        _ => RuntimeErrorCode::RecoveryBlocked,
    };
    RuntimeError::new(code, error.to_string())
}

fn backend_failure_diagnostic(error: &BackendError) -> serde_json::Value {
    let (kind, http_status, detail) = match error {
        BackendError::Unavailable(detail) => ("unavailable", None, detail.as_str()),
        BackendError::OwnershipMismatch(detail) => ("ownership_mismatch", None, detail.as_str()),
        BackendError::PolicyMismatch(detail) => ("policy_mismatch", None, detail.as_str()),
        BackendError::StoppedRepair(_) => {
            ("stopped_repair", None, "stopped OpenCode repair failed")
        }
        BackendError::DockerHttp { status, body } => ("docker_http", Some(*status), body.as_str()),
        BackendError::Malformed(detail) => ("malformed", None, detail.as_str()),
        BackendError::InvalidConfig(detail) => ("invalid_config", None, detail.as_str()),
    };
    const MAX_DETAIL_CHARS: usize = 512;
    let redacted = freshell_runtime_observability::scrub(detail, "");
    let detail_truncated = redacted.chars().count() > MAX_DETAIL_CHARS;
    let detail = redacted
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .take(MAX_DETAIL_CHARS)
        .collect::<String>();
    serde_json::json!({
        "kind": kind,
        "httpStatus": http_status,
        "detail": detail,
        "detailTruncated": detail_truncated,
    })
}

fn io_runtime(error: std::io::Error) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::RegistryFailure, error.to_string())
}

fn write_secret_durable(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    if let Some(parent) = path.parent() {
        std::fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}

static LIFECYCLE_SECRETS: OnceLock<StdMutex<HashMap<PathBuf, String>>> = OnceLock::new();
static LIFECYCLE_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static LIFECYCLE_MONOTONIC_NANOS: AtomicU64 = AtomicU64::new(0);
static LIFECYCLE_STARTED: OnceLock<Instant> = OnceLock::new();
static LIFECYCLE_WRITE_LOCK: StdMutex<()> = StdMutex::new(());

fn lifecycle_secrets() -> &'static StdMutex<HashMap<PathBuf, String>> {
    LIFECYCLE_SECRETS.get_or_init(|| StdMutex::new(HashMap::new()))
}

pub(crate) fn append_event(path: &Path, event: &str, data: serde_json::Value) {
    let _incident_coordinator = crate::loss_report::incident_file_coordinator();
    let _write_guard = LIFECYCLE_WRITE_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    append_event_locked(path, event, data);
}

/// Append an incident-bearing lifecycle event only while the exact incident
/// still exists. The registry read and append share the retraction coordinator,
/// so a delayed finalizer cannot recreate a withdrawn event after file cleanup.
pub(crate) async fn append_incident_event_if_current(
    registry: &Registry,
    path: &Path,
    event: &str,
    data: serde_json::Value,
    incident_id: IncidentId,
) -> Result<bool, RegistryError> {
    let path = path.to_path_buf();
    let event = event.to_string();
    registry
        .run_blocking(move |conn| {
            use rusqlite::OptionalExtension;

            let _incident_coordinator = crate::loss_report::incident_file_coordinator();
            let _write_guard = LIFECYCLE_WRITE_LOCK
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let generation: Option<i64> = conn
                .query_row(
                    "SELECT updated_at FROM loss_incidents WHERE incident_id=?1",
                    rusqlite::params![incident_id.as_str()],
                    |row| row.get(0),
                )
                .optional()?;
            let Some(generation) = generation else {
                return Ok(false);
            };
            let mut data = data;
            if let Some(object) = data.as_object_mut() {
                object.insert(
                    "incidentGeneration".into(),
                    serde_json::Value::from(generation),
                );
            }
            append_event_locked(&path, &event, data);
            Ok(true)
        })
        .await
}

fn append_event_locked(path: &Path, event: &str, data: serde_json::Value) {
    let sequence = LIFECYCLE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let sampled_nanos = LIFECYCLE_STARTED
        .get_or_init(Instant::now)
        .elapsed()
        .as_nanos()
        .min(u128::from(u64::MAX)) as u64;
    let prior_nanos = LIFECYCLE_MONOTONIC_NANOS.load(Ordering::Relaxed);
    let monotonic_nanos = sampled_nanos.max(prior_nanos.saturating_add(1));
    LIFECYCLE_MONOTONIC_NANOS.store(monotonic_nanos, Ordering::Relaxed);
    let line = serde_json::json!({
        "at": now_millis(),
        "sequence": sequence,
        "monotonicNanos": monotonic_nanos,
        "processId": std::process::id(),
        "event": event,
        "data": data,
    });
    match freshell_runtime_observability::RotatingJsonlWriter::create(
        path,
        10 * 1024 * 1024,
        4,
        lifecycle_secrets()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(path)
            .cloned()
            .unwrap_or_default(),
    ) {
        Ok(writer) => {
            if let Err(error) = writer.write_json(&line).and_then(|_| writer.sync_all()) {
                eprintln!("supervisor lifecycle event write failed: {error}");
            }
        }
        Err(error) => eprintln!("supervisor lifecycle log unavailable: {error}"),
    }
}

fn activation_failure_data(
    prepared: &PreparedLaunch,
    state: LaunchState,
    stage: &'static str,
    error: &RuntimeError,
) -> serde_json::Value {
    let mut data = serde_json::json!({
        "severity":"error",
        "soulId": prepared.soul_id,
        "incarnationId": prepared.incarnation_id,
        "intentRevision": prepared.intent_revision,
        "launchState": state,
        "stage": stage,
        "errorCode": error.code,
        "errorClass": "runtime_activation_failed",
    });
    if let Some(reason) = error.diagnostic_code {
        data["failureReason"] = serde_json::json!(reason);
    }
    data
}

fn set_mode(path: &Path, mode: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

#[cfg(feature = "runtime-test-faults")]
pub(crate) fn crash_if(point: &'static str) {
    if std::env::var("FRESHELL_RUNTIME_CRASH_POINT")
        .ok()
        .as_deref()
        == Some(point)
    {
        eprintln!("{{\"event\":\"supervisor.test_crash\",\"point\":\"{point}\"}}");
        std::process::abort();
    }
}
#[cfg(not(feature = "runtime-test-faults"))]
pub(crate) fn crash_if(_point: &'static str) {}

fn stop_crash_boundary(point: &'static str) {
    crash_if(point);
    #[cfg(test)]
    interrupted_transaction_tests::crash_boundary(point);
}

fn stop_backend_outcome(error: BackendError) -> StopOutcome {
    match error {
        BackendError::OwnershipMismatch(_) => StopOutcome::BlockedOwnership,
        BackendError::Unavailable(_) => StopOutcome::BackendUnavailable,
        _ => StopOutcome::TerminationUnconfirmed,
    }
}

fn stop_verification_outcome(error: RuntimeError) -> StopOutcome {
    match error.code {
        RuntimeErrorCode::OwnershipMismatch => StopOutcome::BlockedOwnership,
        RuntimeErrorCode::BackendUnavailable => StopOutcome::BackendUnavailable,
        _ => StopOutcome::TerminationUnconfirmed,
    }
}

#[cfg(test)]
mod interrupted_transaction_tests {
    use super::*;
    use crate::{backend::*, registry::OwnedRuntimeHandle};
    use freshell_runtime_protocol::{
        CleanupState, DesiredState, OpenCodeAdoptionStatus, RuntimeDiagnosticCode, RuntimeLimits,
    };
    use rusqlite::{params, Connection};
    use std::{io::Write, os::unix::process::ExitStatusExt};

    fn sandbox_only() {
        assert_eq!(
            std::env::var("FRESHELL_SANDBOX_MODE").as_deref(),
            Ok("runtime-suite")
        );
        assert!(Path::new("/.dockerenv").exists());
    }

    pub(super) fn crash_boundary(point: &str) {
        if std::env::var("FRESHELL_STOP_TEST_CRASH").ok().as_deref() != Some(point) {
            return;
        }
        sandbox_only();
        let root = PathBuf::from(std::env::var_os("FRESHELL_STOP_TEST_ROOT").unwrap());
        std::fs::write(root.join("crash-boundary"), point).unwrap();
        eprintln!("reached actual Stop boundary: {point}");
        std::process::abort();
    }

    fn record(root: &Path, action: &str, target: &str) {
        writeln!(
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(root.join(action))
                .unwrap(),
            "{target}"
        )
        .unwrap();
    }

    fn count(root: &Path, action: &str) -> usize {
        std::fs::read_to_string(root.join(action))
            .unwrap_or_default()
            .lines()
            .count()
    }

    fn stop_failure_events(supervisor: &Supervisor) -> Vec<serde_json::Value> {
        std::fs::read_to_string(&supervisor.config.lifecycle_log)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .filter(|event: &serde_json::Value| event["event"] == "supervisor.stop_stage_failed")
            .collect()
    }

    async fn assert_pending_stop_custody(supervisor: &Supervisor, root: &Path) {
        let mut handles = supervisor.registry.pending_stop_handles().await.unwrap();
        assert_eq!(handles.len(), 1);
        let handle = handles.remove(0);
        assert!(
            !supervisor
                .registry
                .stop_progress(&handle)
                .await
                .unwrap()
                .settled
        );
        assert_retained(supervisor, root, 2).await;
    }

    struct StopBackend {
        root: PathBuf,
    }

    impl StopBackend {
        fn mode(&self) -> String {
            std::fs::read_to_string(self.root.join("mode")).unwrap_or_else(|_| "graceful".into())
        }
        fn check(&self, handle: &OwnedRuntimeHandle) -> Result<(), BackendError> {
            if self.mode() == "unavailable" {
                return Err(BackendError::Unavailable(
                    "synthetic backend offline".into(),
                ));
            }
            if self.mode() == "mismatch" {
                return Err(BackendError::OwnershipMismatch(
                    "synthetic labels differ".into(),
                ));
            }
            assert_eq!(
                std::fs::read_to_string(self.root.join("container")).unwrap(),
                handle.container_id()
            );
            Ok(())
        }
    }

    #[async_trait::async_trait]
    impl RuntimeBackend for StopBackend {
        async fn inspect(
            &self,
            handle: &OwnedRuntimeHandle,
        ) -> Result<BackendInspection, BackendError> {
            self.check(handle)?;
            Ok(BackendInspection {
                state: if self.mode() == "removed" {
                    BackendRuntimeState::Missing
                } else if self.root.join("empty").exists() {
                    BackendRuntimeState::Exited
                } else {
                    BackendRuntimeState::Running
                },
                configured_limits: handle.requested_limits(),
            })
        }
        async fn create_stopped(
            &self,
            _: &CreateRuntimeSpec,
        ) -> Result<BackendCreated, BackendError> {
            record(&self.root, "creates", "unexpected");
            panic!("Stop must never create a replacement")
        }
        async fn start_host(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
            record(&self.root, "starts", "unexpected");
            panic!("Stop must never start a provider")
        }
        async fn request_stop(
            &self,
            handle: &OwnedRuntimeHandle,
            graceful: u64,
        ) -> Result<(), BackendError> {
            self.check(handle)?;
            assert_eq!(graceful, 2);
            record(&self.root, "graceful", handle.container_id());
            pause(&self.root, "graceful_return").await;
            if self.mode() == "graceful" {
                std::fs::write(self.root.join("empty"), b"empty").unwrap();
            }
            if self.mode() == "removed" {
                return Err(BackendError::DockerHttp {
                    status: 404,
                    body: "exact enclosure absent".into(),
                });
            }
            Ok(())
        }
        async fn force_stop(&self, handle: &OwnedRuntimeHandle) -> Result<(), BackendError> {
            self.check(handle)?;
            record(&self.root, "force", handle.container_id());
            pause(&self.root, "force_return").await;
            if self.mode() != "surviving" {
                std::fs::write(self.root.join("empty"), b"empty").unwrap();
            }
            Ok(())
        }
        async fn verify_empty(&self, handle: &OwnedRuntimeHandle) -> Result<bool, BackendError> {
            self.check(handle)?;
            let empty = self.root.join("empty").exists() || self.mode() == "removed";
            if empty {
                pause(&self.root, "empty_observed").await;
            }
            Ok(empty)
        }
        async fn read_limits(
            &self,
            handle: &OwnedRuntimeHandle,
        ) -> Result<RuntimeLimits, BackendError> {
            Ok(handle.requested_limits())
        }
        async fn enable_long_lived(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
            panic!("Stop cannot enable execution")
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

    fn open(root: &Path) -> Supervisor {
        Supervisor::new(
            Registry::open(root.join("registry"), None).unwrap(),
            Arc::new(StopBackend { root: root.into() }),
            SupervisorConfig {
                runtime_root: root.join("runtime"),
                control_socket_path: root.join("control.sock"),
                host_binary_path: std::env::current_exe().unwrap(),
                image_ref: format!("sha256:{}", "a".repeat(64)),
                test_run_id: "ordinary-stop".into(),
                control_secret: "synthetic-secret".into(),
                lifecycle_log: root.join("lifecycle.jsonl"),
                admission: Default::default(),
            },
        )
        .unwrap()
    }

    async fn seed(supervisor: &Supervisor, root: &Path, capability: bool) -> SoulId {
        let soul = SoulId::new();
        let prepared = crate::registry::tests::materialize_fresh_runtime(
            &supervisor.registry,
            soul.clone(),
            root,
        )
        .await;
        let runtime = root.join("runtime").join(prepared.incarnation_id.as_str());
        std::fs::create_dir_all(&runtime).unwrap();
        std::fs::write(runtime.join("secret"), b"synthetic-secret").unwrap();
        let conn = Connection::open(supervisor.registry.database_path()).unwrap();
        let mut agent: freshell_runtime_protocol::FreshAgentLaunchSpec = serde_json::from_str(
            &conn
                .query_row(
                    "SELECT fresh_agent_spec FROM incarnations WHERE incarnation_id=?1",
                    [prepared.incarnation_id.as_str()],
                    |r| r.get::<_, String>(0),
                )
                .unwrap(),
        )
        .unwrap();
        if capability {
            agent.provider_launch_context =
                Some(freshell_runtime_protocol::ProviderLaunchContext {
                    prepared_inputs: None,
                    preparation: freshell_runtime_protocol::ProviderPreparation::Claude {
                        mcp_args: vec![],
                    },
                    mcp_capability: Some(freshell_runtime_protocol::McpCapabilityReference {
                        grant_id: "stop-exact-grant".into(),
                        endpoint: "http://host.docker.internal:3456".into(),
                        provider_relative_path: ".freshell/capability.json".into(),
                        host_gateway_address: None,
                    }),
                    config: vec![],
                });
        }
        conn.execute(
            "UPDATE incarnations SET runtime_dir=?1,fresh_agent_spec=?2 WHERE incarnation_id=?3",
            params![
                runtime.to_string_lossy(),
                serde_json::to_string(&agent).unwrap(),
                prepared.incarnation_id.as_str()
            ],
        )
        .unwrap();
        supervisor
            .registry
            .record_native_session(
                soul.clone(),
                prepared.incarnation_id.clone(),
                "stop-retained-root".into(),
            )
            .await
            .unwrap();
        std::fs::create_dir_all(root.join("provider")).unwrap();
        std::fs::write(
            root.join("provider/history.jsonl"),
            b"{\"root\":\"stop-retained-root\",\"turn\":\"synthetic retained history\"}\n",
        )
        .unwrap();
        std::fs::write(root.join("soul"), soul.as_str()).unwrap();
        std::fs::write(
            root.join("container"),
            format!("container-{}", prepared.incarnation_id),
        )
        .unwrap();
        let fingerprint: (String,String,String,u64,u64,u64) = conn.query_row(
            "SELECT provider_store_id,provider_volume_name,native_session_id,evidence_revision,native_import_revision,successful_recoveries_in_window FROM souls WHERE soul_id=?1", [soul.as_str()], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).unwrap();
        std::fs::write(
            root.join("identity.json"),
            serde_json::to_vec(&fingerprint).unwrap(),
        )
        .unwrap();
        // Observe actual writes after fixture setup; no injected success flags.
        conn.execute_batch("CREATE TABLE stop_test_effects(kind TEXT NOT NULL);
            CREATE TRIGGER stop_test_new_incarnation AFTER INSERT ON incarnations BEGIN INSERT INTO stop_test_effects VALUES('replacement'); END;
            CREATE TRIGGER stop_test_new_writer AFTER INSERT ON writer_claims BEGIN INSERT INTO stop_test_effects VALUES('writer'); END;
            CREATE TRIGGER stop_test_new_grant AFTER UPDATE OF execution_generation,grant_id ON incarnations WHEN NEW.execution_generation!=OLD.execution_generation OR NEW.grant_id IS NOT OLD.grant_id BEGIN INSERT INTO stop_test_effects VALUES('execution_grant'); END;
            CREATE TRIGGER stop_test_new_recovery AFTER INSERT ON recovery_attempts BEGIN INSERT INTO stop_test_effects VALUES('recovery'); END;").unwrap();
        soul
    }

    fn startup_terminal_command(
        soul: SoulId,
        incarnation: IncarnationId,
        boot: HostBootId,
    ) -> HostCommand {
        let terminal: TerminalLaunchSpec = serde_json::from_value(serde_json::json!({
            "terminalId":"startup-terminal", "streamId":"startup-stream", "mode":"opencode",
            "program":"opencode", "cwd":"/workspace", "workspacePath":"/workspace",
            "projectKey":"startup", "runAsUid":65534, "runAsGid":0, "cols":80, "rows":24
        }))
        .unwrap();
        HostCommand::GrantExecution {
            dispatch_budget_ms: None,
            native_identity_launch: None,
            incarnation_id: incarnation,
            soul_id: soul,
            host_boot_id: boot,
            control_epoch: 1,
            execution_generation: 1,
            grant_id: freshell_runtime_protocol::GrantId::new(),
            fixture: None,
            provider_path_inputs: Default::default(),
            terminal: Some(Box::new(terminal)),
            fresh_agent: None,
            resume_spec: None,
        }
    }

    fn startup_issue_request(soul: &SoulId) -> McpCapabilityRequest<'_> {
        McpCapabilityRequest {
            action: "issue",
            soul_id: soul,
            incarnation_id: None,
            grant_id: None,
            provider: Some("claude"),
            tui_source: None,
            workspace: Some("/workspace"),
            auth_lookup_authority: None,
            claude_recovery_source: None,
            cwd: Some("/workspace"),
            prior_context: None,
            provider_secret_references: None,
            provider_path_inputs: None,
        }
    }

    async fn startup_host_peer(
        handle: &OwnedRuntimeHandle,
        delay: Duration,
        fail: bool,
        began: tokio::sync::mpsc::UnboundedSender<()>,
    ) -> tokio::task::JoinHandle<()> {
        let listener = UnixListener::bind(handle.runtime_dir().join("host.sock")).unwrap();
        let secret = std::fs::read(handle.runtime_dir().join("secret")).unwrap();
        let boot = HostBootId::new();
        let limits = handle.requested_limits();
        tokio::spawn(async move {
            let mut requests = tokio::task::JoinSet::new();
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let secret = secret.clone();
                let boot = boot.clone();
                let began = began.clone();
                requests.spawn(async move {
                    let request: Envelope<HostCommand> = read_frame(&mut stream).await.unwrap();
                    if !matches!(&request.body, HostCommand::Hello { .. }) {
                        assert_eq!(
                            request.auth.as_deref(),
                            Some(
                                host_proof(
                                    &secret,
                                    "command-auth",
                                    &boot,
                                    match &request.body {
                                        HostCommand::GrantExecution { incarnation_id, .. }
                                        | HostCommand::Stop { incarnation_id, .. } =>
                                            incarnation_id,
                                        _ => unreachable!(),
                                    }
                                )
                                .as_str()
                            )
                        );
                    }
                    let result = match request.body {
                        HostCommand::Hello {
                            incarnation_id,
                            challenge,
                        } => Ok(HostResult::Hello {
                            host_boot_id: boot.clone(),
                            proof: host_proof(&secret, &challenge, &boot, &incarnation_id),
                            capabilities: vec![],
                            effective_limits: limits,
                        }),
                        HostCommand::Stop { .. } => Ok(HostResult::Stopped),
                        HostCommand::GrantExecution { .. } => {
                            began.send(()).unwrap();
                            sleep(delay).await;
                            if fail {
                                Err(RuntimeError::new(
                                    RuntimeErrorCode::HostUnreachable,
                                    "synthetic startup preparation failed",
                                )
                                .with_diagnostic_code(
                                    RuntimeDiagnosticCode::ProviderLaunchPrepareFailed,
                                ))
                            } else {
                                Ok(HostResult::GrantAccepted {
                                    native_identity_observation: None,
                                    host_boot_id: boot,
                                    worker_pid: 123,
                                    worker_launch_count: 1,
                                    fixture_evidence: serde_json::json!({}),
                                    native_session_id: None,
                                    opencode_transfer_receipt: None,
                                    opencode_adoption: OpenCodeAdoptionStatus::NotRequired,
                                })
                            }
                        }
                        other => panic!("unexpected startup peer command: {other:?}"),
                    };
                    let _ = write_frame(
                        &mut stream,
                        &HostReply {
                            request_id: request.request_id,
                            result,
                        },
                    )
                    .await;
                });
            }
        })
    }

    #[tokio::test]
    async fn startup_reply_budget_composes_existing_operations_and_keeps_controls_short() {
        let budget = |command: &HostCommand, terminal: Option<&str>, fresh: Option<&str>| {
            HostCommandBudgets::from_lookup(|name| match name {
                TERMINAL_DISPATCH_TIMEOUT_ENV => terminal.map(str::to_owned),
                FRESH_AGENT_COMMAND_TIMEOUT_ENV => fresh.map(str::to_owned),
                _ => None,
            })
            .for_command(command)
        };
        let incarnation = IncarnationId::new();
        let mut command =
            startup_terminal_command(SoulId::new(), incarnation.clone(), HostBootId::new());
        for (provider, seconds) in [
            ("opencode", 109),
            ("claude", 109),
            ("amplifier", 84),
            ("codex", 365),
            ("shell", 60),
        ] {
            let HostCommand::GrantExecution {
                terminal: Some(terminal),
                ..
            } = &mut command
            else {
                unreachable!()
            };
            terminal.mode = provider.into();
            assert_eq!(budget(&command, None, None), Duration::from_secs(seconds));
            assert_eq!(
                budget(&command, Some("100"), None),
                Duration::from_millis(100)
            );
            assert_eq!(
                budget(&command, Some("0"), None),
                Duration::from_secs(seconds)
            );
        }
        let root = tempfile::tempdir().unwrap();
        let supervisor = open(root.path());
        let soul = seed(&supervisor, root.path(), false).await;
        let owner = supervisor
            .registry
            .active_handle_for_soul(soul)
            .await
            .unwrap();
        let mut launch = owner.fresh_agent().unwrap().clone();
        for (provider, millis) in [
            (freshell_runtime_protocol::FreshProvider::Claude, 254_000),
            (freshell_runtime_protocol::FreshProvider::Opencode, 259_000),
            (freshell_runtime_protocol::FreshProvider::Codex, 264_150),
        ] {
            launch.provider = provider;
            let HostCommand::GrantExecution {
                terminal,
                fresh_agent,
                ..
            } = &mut command
            else {
                unreachable!()
            };
            *terminal = None;
            *fresh_agent = Some(Box::new(launch.clone()));
            assert_eq!(budget(&command, None, None), Duration::from_millis(millis));
            assert_eq!(
                budget(&command, None, Some("100")),
                Duration::from_millis(100)
            );
        }
        for control in [
            HostCommand::Status {
                incarnation_id: incarnation.clone(),
            },
            HostCommand::Stop {
                incarnation_id: incarnation,
                control_epoch: 1,
                execution_generation: 1,
            },
        ] {
            assert_eq!(budget(&control, None, None), Duration::from_secs(10));
        }
    }

    #[tokio::test]
    async fn startup_terminal_grant_waits_beyond_control_budget_for_real_completion() {
        for fail in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let supervisor = open(root.path());
            let soul = seed(&supervisor, root.path(), false).await;
            let handle = supervisor
                .registry
                .active_handle_for_soul(soul.clone())
                .await
                .unwrap();
            let (tx, mut began) = tokio::sync::mpsc::unbounded_channel();
            let peer = startup_host_peer(&handle, Duration::from_secs(11), fail, tx).await;
            let host = supervisor
                .authenticate_host(handle.incarnation_id(), handle.runtime_dir())
                .await
                .unwrap();
            let result = supervisor
                .send_authenticated_host_command(
                    handle.incarnation_id().clone(),
                    handle.runtime_dir(),
                    &host,
                    startup_terminal_command(
                        soul,
                        handle.incarnation_id().clone(),
                        host.host_boot_id.clone(),
                    ),
                )
                .await;
            began.recv().await.unwrap();
            peer.abort();
            let _ = peer.await;
            if fail {
                let error = result.unwrap_err();
                assert_eq!(error.code, RuntimeErrorCode::HostUnreachable);
                assert_eq!(
                    error.diagnostic_code,
                    Some(RuntimeDiagnosticCode::ProviderLaunchPrepareFailed)
                );
            } else {
                assert!(
                    matches!(
                        result,
                        Ok(HostResult::GrantAccepted {
                            worker_pid: 123,
                            ..
                        })
                    ),
                    "{result:?}"
                );
            }
        }
    }

    #[tokio::test]
    async fn startup_callback_waits_for_both_native_observation_operations() {
        let root = tempfile::tempdir().unwrap();
        let supervisor = open(root.path());
        let soul = seed(&supervisor, root.path(), false).await;
        let listener = UnixListener::bind(root.path().join("mcp.sock")).unwrap();
        let peer = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut body = Vec::new();
            stream.read_to_end(&mut body).await.unwrap();
            sleep(Duration::from_secs(36)).await;
            let _ = stream.write_all(b"prepared-complete").await;
        });
        let result = supervisor
            .mcp_capability_callback(startup_issue_request(&soul))
            .await;
        peer.abort();
        let _ = peer.await;
        assert_eq!(result.unwrap(), b"prepared-complete");
    }

    #[tokio::test]
    async fn startup_stop_interrupts_preparation_and_grant_waits_before_teardown() {
        for phase in ["callback", "grant"] {
            let root = tempfile::tempdir().unwrap();
            let supervisor = Arc::new(open(root.path()));
            let soul = seed(&supervisor, root.path(), false).await;
            let handle = supervisor
                .registry
                .active_handle_for_soul(soul.clone())
                .await
                .unwrap();
            let (tx, mut began) = tokio::sync::mpsc::unbounded_channel();
            let host_peer =
                startup_host_peer(&handle, Duration::from_secs(3600), false, tx.clone()).await;
            let callback = if phase == "callback" {
                let listener = UnixListener::bind(root.path().join("mcp.sock")).unwrap();
                Some(tokio::spawn(async move {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let mut body = Vec::new();
                    stream.read_to_end(&mut body).await.unwrap();
                    tx.send(()).unwrap();
                    sleep(Duration::from_secs(3600)).await;
                }))
            } else {
                None
            };
            let owner = supervisor.clone();
            let owned_soul = soul.clone();
            let startup = tokio::spawn(async move {
                let lock = owner.lifecycle_lock(&owned_soul).await;
                let _held = lock.lock().await;
                if phase == "callback" {
                    owner
                        .mcp_capability_callback(startup_issue_request(&owned_soul))
                        .await
                        .map(|_| ())
                } else {
                    let host = owner
                        .authenticate_host(handle.incarnation_id(), handle.runtime_dir())
                        .await
                        .unwrap();
                    owner
                        .send_authenticated_host_command(
                            handle.incarnation_id().clone(),
                            handle.runtime_dir(),
                            &host,
                            startup_terminal_command(
                                owned_soul,
                                handle.incarnation_id().clone(),
                                host.host_boot_id.clone(),
                            ),
                        )
                        .await
                        .map(|_| ())
                }
            });
            began.recv().await.unwrap();
            let stopped = tokio::time::timeout(
                Duration::from_secs(2),
                supervisor.stop(soul.clone(), Some(1)),
            )
            .await;
            host_peer.abort();
            let _ = host_peer.await;
            if let Some(callback) = callback {
                callback.abort();
                let _ = callback.await;
            }
            if stopped.is_err() {
                startup.abort();
                let _ = startup.await;
                panic!("Stop remained behind {phase} startup");
            }
            assert_eq!(stopped.unwrap().unwrap().0, StopOutcome::VerifiedEmpty);
            assert_eq!(
                startup.await.unwrap().unwrap_err().code,
                RuntimeErrorCode::StaleIntentRevision
            );
            assert_eq!(
                supervisor
                    .registry
                    .recovery_context(soul)
                    .await
                    .unwrap()
                    .desired_state,
                DesiredState::Stopped
            );
            assert_eq!(count(root.path(), "graceful"), 1);
            assert_eq!(count(root.path(), "creates"), 0);
            assert_eq!(count(root.path(), "starts"), 0);
        }
    }

    fn soul(root: &Path) -> SoulId {
        SoulId::parse(std::fs::read_to_string(root.join("soul")).unwrap()).unwrap()
    }

    async fn docker_fixture(
        supervisor: &mut Supervisor,
        root: &Path,
        created: bool,
    ) -> crate::backend::tests::StopDockerFixture {
        let view = supervisor.registry.inventory().await.unwrap().remove(0);
        let conn = Connection::open(supervisor.registry.database_path()).unwrap();
        if created {
            // The replacement owns its container and retained soul history,
            // but has not received an execution grant or started its host.
            conn.execute(
                "UPDATE incarnations SET launch_state='created',execution_generation=0,grant_id=NULL WHERE incarnation_id=?1",
                [view.incarnation_id.as_str()],
            ).unwrap();
        }
        let handle = supervisor
            .registry
            .owned_handle(view.incarnation_id)
            .await
            .unwrap();
        let fixture = crate::backend::tests::StopDockerFixture::new(root, &handle).await;
        conn.execute(
            "UPDATE incarnations SET immutable_config_digest=?1 WHERE incarnation_id=?2",
            params![fixture.digest, handle.incarnation_id().as_str()],
        )
        .unwrap();
        // Setup is finished. Keep all execution/write counters active during
        // Stop, reopen and observer continuation.
        conn.execute("DELETE FROM stop_test_effects", []).unwrap();
        supervisor.backend = Arc::new(fixture.backend.clone());
        if !created {
            fixture.state.lock().unwrap().inspection["State"] = serde_json::json!({
                "Status":"running","Running":true,"Paused":false,"Restarting":false
            });
        }
        fixture
    }

    #[tokio::test]
    async fn docker_created_is_qualified_empty_without_starting_or_weakening_ownership() {
        let dir = tempfile::tempdir().unwrap();
        let mut supervisor = open(dir.path());
        seed(&supervisor, dir.path(), false).await;
        let fixture = docker_fixture(&mut supervisor, dir.path(), true).await;
        let view = supervisor.registry.inventory().await.unwrap().remove(0);
        let handle = supervisor
            .registry
            .owned_handle(view.incarnation_id.clone())
            .await
            .unwrap();
        assert_eq!(
            fixture.backend.inspect(&handle).await.unwrap().state,
            BackendRuntimeState::Created
        );
        fixture.backend.request_stop(&handle, 2).await.unwrap();
        fixture.backend.force_stop(&handle).await.unwrap();
        assert_eq!(
            fixture.backend.inspect(&handle).await.unwrap().state,
            BackendRuntimeState::Created
        );
        let created_empty = fixture.backend.verify_empty(&handle).await.unwrap();
        let owned = fixture.state.lock().unwrap().inspection.clone();
        for (state, expected) in [
            (
                serde_json::json!({"Status":"running","Running":true}),
                BackendRuntimeState::Running,
            ),
            (
                serde_json::json!({"Status":"created","Running":true}),
                BackendRuntimeState::Running,
            ),
            (
                serde_json::json!({"Status":"paused","Running":true,"Paused":true}),
                BackendRuntimeState::Paused,
            ),
            (
                serde_json::json!({"Status":"restarting","Restarting":true}),
                BackendRuntimeState::Restarting,
            ),
        ] {
            fixture.state.lock().unwrap().inspection["State"] = state;
            assert_eq!(
                fixture.backend.inspect(&handle).await.unwrap().state,
                expected
            );
            assert!(!fixture.backend.verify_empty(&handle).await.unwrap());
        }
        fixture.state.lock().unwrap().inspection = owned.clone();
        for pointer in [
            "/Id",
            "/Image",
            "/Config/Labels/com.freshell.soul-id",
            "/Mounts/0/Source",
        ] {
            *fixture
                .state
                .lock()
                .unwrap()
                .inspection
                .pointer_mut(pointer)
                .unwrap() = serde_json::json!("foreign");
            assert!(matches!(
                fixture.backend.verify_empty(&handle).await,
                Err(BackendError::OwnershipMismatch(_))
            ));
            fixture.state.lock().unwrap().inspection = owned.clone();
        }
        fixture.state.lock().unwrap().daemon_id = "foreign-daemon".into();
        assert!(matches!(
            fixture.backend.verify_empty(&handle).await,
            Err(BackendError::OwnershipMismatch(_))
        ));
        fixture.state.lock().unwrap().daemon_id = handle.daemon_id().to_string();
        let conn = Connection::open(supervisor.registry.database_path()).unwrap();
        conn.execute(
            "UPDATE incarnations SET immutable_config_digest='tampered' WHERE incarnation_id=?1",
            [view.incarnation_id.as_str()],
        )
        .unwrap();
        let tampered = supervisor
            .registry
            .owned_handle(view.incarnation_id)
            .await
            .unwrap();
        assert!(matches!(
            fixture.backend.verify_empty(&tampered).await,
            Err(BackendError::OwnershipMismatch(_))
        ));
        assert!(!fixture
            .state
            .lock()
            .unwrap()
            .requests
            .iter()
            .any(|r| r.contains("/start") || r.contains("/create")));
        fixture.close().await;
        assert!(created_empty, "an exactly owned, never-started Created enclosure has no workload even after no-op stop/kill");
    }

    #[tokio::test]
    async fn exited_unless_stopped_container_is_suppressed_before_settlement() {
        let dir = tempfile::tempdir().unwrap();
        let mut supervisor = open(dir.path());
        let id = seed(&supervisor, dir.path(), false).await;
        let fixture = docker_fixture(&mut supervisor, dir.path(), false).await;
        let view = supervisor.registry.inventory().await.unwrap().remove(0);
        let handle = supervisor
            .registry
            .owned_handle(view.incarnation_id.clone())
            .await
            .unwrap();
        {
            let mut state = fixture.state.lock().unwrap();
            state.inspection["State"] = serde_json::json!({
                "Status":"exited","Running":false,"Paused":false,"Restarting":false
            });
            state.inspection["HostConfig"]["RestartPolicy"] = serde_json::json!({
                "Name":"unless-stopped","MaximumRetryCount":0
            });
        }
        assert!(
            !fixture.backend.verify_empty(&handle).await.unwrap(),
            "an exited container with restart enabled is not yet safe to settle"
        );

        let (outcome, _) = supervisor.stop(id, Some(1)).await.unwrap();

        assert_eq!(outcome, StopOutcome::VerifiedEmpty);
        let (update_request, update_body) = fixture
            .state
            .lock()
            .unwrap()
            .restart_updates
            .first()
            .cloned()
            .expect("cleanup must disable the container's restart policy");
        assert_eq!(
            update_request,
            format!(
                "POST /v1.47/containers/{}/update HTTP/1.1",
                handle.container_id()
            )
        );
        assert_eq!(
            update_body,
            serde_json::json!({
                "RestartPolicy":{"Name":"no","MaximumRetryCount":0}
            })
        );
        {
            let state = fixture.state.lock().unwrap();
            assert_eq!(
                state.inspection["HostConfig"]["RestartPolicy"]["Name"],
                "no"
            );
            let final_inspection = format!(
                "GET /v1.47/containers/{}/json HTTP/1.1",
                handle.container_id()
            );
            assert_eq!(
                state.requests.last().map(String::as_str),
                Some(final_inspection.as_str()),
                "the exact owned container must be inspected after restart suppression"
            );
        }

        assert!(supervisor
            .registry
            .pending_stop_handles()
            .await
            .unwrap()
            .is_empty());
        let conn = Connection::open(supervisor.registry.database_path()).unwrap();
        let claims: (u64, u64) = conn
            .query_row(
                "SELECT (SELECT COUNT(*) FROM writer_claims WHERE incarnation_id=?1), \
                        (SELECT COUNT(*) FROM admission_reservations WHERE incarnation_id=?1)",
                [handle.incarnation_id().as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(claims, (0, 0));
        fixture.close().await;
    }

    #[tokio::test]
    async fn exited_unless_stopped_container_stays_pending_without_policy_confirmation() {
        let dir = tempfile::tempdir().unwrap();
        let mut supervisor = open(dir.path());
        let id = seed(&supervisor, dir.path(), false).await;
        let fixture = docker_fixture(&mut supervisor, dir.path(), false).await;
        {
            let mut state = fixture.state.lock().unwrap();
            state.inspection["State"] = serde_json::json!({
                "Status":"exited","Running":false,"Paused":false,"Restarting":false
            });
            state.inspection["HostConfig"]["RestartPolicy"] = serde_json::json!({
                "Name":"unless-stopped","MaximumRetryCount":0
            });
            state.apply_restart_update = false;
        }

        let (outcome, _) = supervisor.stop(id, Some(1)).await.unwrap();

        assert_ne!(outcome, StopOutcome::VerifiedEmpty);
        assert_eq!(
            fixture.state.lock().unwrap().inspection["HostConfig"]["RestartPolicy"]["Name"],
            "unless-stopped"
        );
        assert_eq!(
            fixture.state.lock().unwrap().restart_updates.len(),
            1,
            "a successful update response without a verified policy change must fail closed"
        );
        assert_eq!(
            supervisor
                .registry
                .pending_stop_handles()
                .await
                .unwrap()
                .len(),
            1,
            "the Stop intent must remain pending while restart remains enabled"
        );
        fixture.close().await;
    }

    #[tokio::test]
    async fn stop_stays_pending_when_exact_container_remains_running() {
        let dir = tempfile::tempdir().unwrap();
        let mut supervisor = open(dir.path());
        let id = seed(&supervisor, dir.path(), false).await;
        let fixture = docker_fixture(&mut supervisor, dir.path(), false).await;
        let view = supervisor.registry.inventory().await.unwrap().remove(0);
        let handle = supervisor
            .registry
            .owned_handle(view.incarnation_id)
            .await
            .unwrap();
        fixture.state.lock().unwrap().inspection["HostConfig"]["RestartPolicy"] =
            serde_json::json!({"Name":"unless-stopped","MaximumRetryCount":0});

        let (outcome, _) = supervisor.stop(id, Some(1)).await.unwrap();

        assert_eq!(outcome, StopOutcome::TerminationUnconfirmed);
        {
            let state = fixture.state.lock().unwrap();
            assert_eq!(
                state.inspection["HostConfig"]["RestartPolicy"]["Name"],
                "no"
            );
            assert_eq!(
                state
                    .restart_updates
                    .first()
                    .map(|(request, _)| request.as_str()),
                Some(
                    format!(
                        "POST /v1.47/containers/{}/update HTTP/1.1",
                        handle.container_id()
                    )
                    .as_str()
                )
            );
            assert_eq!(state.inspection["State"]["Running"], true);
        }
        assert_eq!(
            supervisor
                .registry
                .pending_stop_handles()
                .await
                .unwrap()
                .len(),
            1,
            "an active exact container must keep the Stop pending"
        );
        fixture.close().await;
    }

    #[tokio::test]
    async fn ordinary_stop_docker_created_reopen_preserves_history_and_settles_exact_revoke() {
        // Capability configuration is process-wide. Keep this production
        // ownership test independent of other tests' configured directories.
        // The child runs this exact non-destructive test, with its own tempdir.
        const CHILD: &str = "FRESHELL_DOCKER_CREATED_TEST_CHILD";
        if std::env::var(CHILD).as_deref() != Ok("1") {
            let output = tokio::task::spawn_blocking(|| {
                std::process::Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", "service::interrupted_transaction_tests::ordinary_stop_docker_created_reopen_preserves_history_and_settles_exact_revoke", "--nocapture"])
                    .env(CHILD, "1")
                    .env_remove("FRESHELL_RUNTIME_CAPABILITY_DIR")
                    .output().unwrap()
            }).await.unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        tokio::time::timeout(Duration::from_secs(30), complete_docker_created_stop())
            .await
            .unwrap();
    }

    async fn complete_docker_created_stop() {
        let dir = tempfile::tempdir().unwrap();
        let mut supervisor = open(dir.path());
        let id = seed(&supervisor, dir.path(), true).await;
        let grants = dir.path().join("mcp-capabilities");
        std::fs::create_dir(&grants).unwrap();
        std::fs::create_dir_all(dir.path().join("provider-roots/grant-stop-docker")).unwrap();
        let capability_file = grants.join("grant-stop-docker.json");
        std::fs::write(&capability_file, b"synthetic exact capability").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&capability_file, std::fs::Permissions::from_mode(0o600))
                .unwrap();
        }
        crate::backend::docker::configure_capability_dir(&dir.path().join("control.sock")).unwrap();
        Connection::open(supervisor.registry.database_path()).unwrap().execute(
            "UPDATE incarnations SET fresh_agent_spec=replace(fresh_agent_spec,'stop-exact-grant','grant-stop-docker')",[]
        ).unwrap();
        let fixture = docker_fixture(&mut supervisor, dir.path(), true).await;
        let stopped = supervisor.registry.begin_stop(id).await.unwrap();
        let revision = stopped.stop_fence().unwrap().intent_revision;
        drop(supervisor);
        let mut supervisor = open(dir.path());
        supervisor.backend = Arc::new(fixture.backend.clone());
        let revoke = callback_with_grant(dir.path(), b"ok", "grant-stop-docker").await;
        supervisor.reconcile_startup().await.unwrap();
        let progress = supervisor.registry.stop_progress(&stopped).await.unwrap();
        assert_eq!(progress.outcome, Some(StopOutcome::VerifiedEmpty));
        assert!(progress.settled);
        assert_eq!(count(dir.path(), "revokes"), 1);
        assert_retained(&supervisor, dir.path(), revision).await;
        let conn = Connection::open(supervisor.registry.database_path()).unwrap();
        let (generation, writers): (u64,u64) = conn.query_row(
            "SELECT execution_generation,(SELECT count(*) FROM writer_claims WHERE soul_id=?1) FROM incarnations WHERE incarnation_id=?2",
            params![stopped.soul_id().as_str(),stopped.incarnation_id().as_str()],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert_eq!((generation, writers), (0, 0));
        assert_eq!(
            fixture.backend.inspect(&stopped).await.unwrap().state,
            BackendRuntimeState::Created
        );
        supervisor.observe_once().await.unwrap();
        assert_eq!(count(dir.path(), "revokes"), 1);
        assert!(supervisor
            .registry
            .pending_stop_handles()
            .await
            .unwrap()
            .is_empty());
        assert!(fixture
            .state
            .lock()
            .unwrap()
            .requests
            .iter()
            .all(|r| r.starts_with("GET ")));
        close(revoke).await;
        fixture.close().await;
    }

    #[tokio::test]
    async fn ordinary_stop_failure_diagnostics_preserve_outcome_and_pending_intent() {
        for (mode, expected, code) in [
            (
                "unavailable",
                StopOutcome::BackendUnavailable,
                "BACKEND_UNAVAILABLE",
            ),
            (
                "mismatch",
                StopOutcome::BlockedOwnership,
                "OWNERSHIP_MISMATCH",
            ),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let supervisor = open(dir.path());
            let id = seed(&supervisor, dir.path(), false).await;
            std::fs::write(dir.path().join("mode"), mode).unwrap();
            let (outcome, view) = supervisor.stop(id, Some(1)).await.unwrap();
            assert_eq!(outcome, expected);
            assert_eq!(view.intent_revision, 2);
            let handle = supervisor
                .registry
                .pending_stop_handles()
                .await
                .unwrap()
                .remove(0);
            assert!(
                !supervisor
                    .registry
                    .stop_progress(&handle)
                    .await
                    .unwrap()
                    .settled
            );
            assert_retained(&supervisor, dir.path(), 2).await;
            let text = std::fs::read_to_string(&supervisor.config.lifecycle_log).unwrap();
            let events = stop_failure_events(&supervisor);
            assert_eq!(events.len(), 1);
            assert_eq!(events[0]["data"]["stage"], "initial_empty_inspection");
            assert_eq!(events[0]["data"]["errorCode"], code);
            assert_eq!(events[0]["data"]["intentRevision"], 2);
            assert_eq!(
                events[0]["data"]["incarnationId"],
                handle.incarnation_id().as_str()
            );
            assert_eq!(events[0]["data"]["severity"], "warning");
            assert!(!text.contains("synthetic backend offline"));
            assert!(!text.contains("synthetic labels differ"));
        }
    }

    #[tokio::test]
    async fn ordinary_stop_inspection_origin_diagnostics_preserve_pending_custody() {
        for category in ["docker_http", "unavailable"] {
            let dir = tempfile::tempdir().unwrap();
            let mut supervisor = open(dir.path());
            let id = seed(&supervisor, dir.path(), false).await;
            let fixture = docker_fixture(&mut supervisor, dir.path(), false).await;
            fixture.close().await;
            let mut peer = None;
            if category == "docker_http" {
                let path = dir.path().join("docker-stop.sock");
                std::fs::remove_file(&path).unwrap();
                let listener = UnixListener::bind(path).unwrap();
                let view = supervisor.registry.inventory().await.unwrap().remove(0);
                let handle = supervisor
                    .registry
                    .owned_handle(view.incarnation_id)
                    .await
                    .unwrap();
                let daemon_id = handle.daemon_id().to_owned();
                peer = Some(tokio::spawn(async move {
                    loop {
                        let (mut stream, _) = listener.accept().await.unwrap();
                        let mut header = Vec::new();
                        while !header.ends_with(b"\r\n\r\n") {
                            header.push(stream.read_u8().await.unwrap());
                        }
                        let header = String::from_utf8(header).unwrap();
                        let (status, body) = if header.starts_with("GET /v1.47/info ") {
                            (200, serde_json::json!({"ID":daemon_id}).to_string())
                        } else {
                            assert!(header.contains("/json HTTP/1.1"));
                            (500, "private inspection failure body".into())
                        };
                        stream.write_all(format!("HTTP/1.1 {status} OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
                    }
                }));
            }
            let (outcome, view) = supervisor.stop(id, Some(1)).await.unwrap();
            if let Some(peer) = peer {
                close(peer).await;
            }
            assert_eq!(outcome, StopOutcome::BackendUnavailable);
            assert_eq!(view.intent_revision, 2);
            assert_pending_stop_custody(&supervisor, dir.path()).await;
            let events = stop_failure_events(&supervisor);
            assert_eq!(events.len(), 1);
            assert_eq!(events[0]["data"]["stage"], "initial_empty_inspection");
            assert_eq!(events[0]["data"]["errorCategory"], category);
            assert_eq!(
                events[0]["data"]["httpStatus"],
                if category == "docker_http" {
                    serde_json::json!(500)
                } else {
                    serde_json::Value::Null
                }
            );
            assert!(!std::fs::read_to_string(&supervisor.config.lifecycle_log)
                .unwrap()
                .contains("private inspection failure body"));
        }
    }

    #[tokio::test]
    async fn ordinary_stop_host_origin_diagnostics_preserve_fallback_and_pending_custody() {
        const CHILD: &str = "FRESHELL_STOP_HOST_ORIGIN_CHILD";
        const NAME: &str = "service::interrupted_transaction_tests::ordinary_stop_host_origin_diagnostics_preserve_fallback_and_pending_custody";
        if std::env::var(CHILD).as_deref() != Ok("1") {
            let output = tokio::task::spawn_blocking(|| {
                std::process::Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", NAME, "--nocapture"])
                    .env(CHILD, "1")
                    .env(HOST_COMMAND_TIMEOUT_ENV, "100")
                    .env_remove("FRESHELL_RUNTIME_CAPABILITY_DIR")
                    .output()
                    .unwrap()
            })
            .await
            .unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        for stage in ["host_authentication", "host_stop"] {
            for category in ["timeout", "unavailable"] {
                let dir = tempfile::tempdir().unwrap();
                let mut supervisor = open(dir.path());
                let id = seed(&supervisor, dir.path(), false).await;
                let fixture = docker_fixture(&mut supervisor, dir.path(), false).await;
                fixture.state.lock().unwrap().silence = Some("graceful_request");
                let view = supervisor.registry.inventory().await.unwrap().remove(0);
                let handle = supervisor
                    .registry
                    .owned_handle(view.incarnation_id)
                    .await
                    .unwrap();
                let listener = UnixListener::bind(handle.runtime_dir().join("host.sock")).unwrap();
                let limits = handle.requested_limits();
                let peer = tokio::spawn(async move {
                    let boot = HostBootId::new();
                    loop {
                        let (mut stream, _) = listener.accept().await.unwrap();
                        let request: Envelope<HostCommand> = read_frame(&mut stream).await.unwrap();
                        let failing = if stage == "host_authentication" {
                            matches!(request.body, HostCommand::Hello { .. })
                        } else {
                            matches!(request.body, HostCommand::Stop { .. })
                        };
                        if failing {
                            if category == "timeout" {
                                let mut bytes = vec![];
                                stream.read_to_end(&mut bytes).await.unwrap();
                            }
                            continue;
                        }
                        let HostCommand::Hello {
                            incarnation_id,
                            challenge,
                        } = request.body
                        else {
                            panic!("unexpected command")
                        };
                        write_frame(
                            &mut stream,
                            &HostReply {
                                request_id: request.request_id,
                                result: Ok(HostResult::Hello {
                                    host_boot_id: boot.clone(),
                                    proof: host_proof(
                                        b"synthetic-secret",
                                        &challenge,
                                        &boot,
                                        &incarnation_id,
                                    ),
                                    effective_limits: limits,
                                    capabilities: vec![],
                                }),
                            },
                        )
                        .await
                        .unwrap();
                    }
                });
                let (outcome, view) = supervisor.stop(id, Some(1)).await.unwrap();
                close(peer).await;
                fixture.close().await;
                assert_eq!(outcome, StopOutcome::BackendUnavailable);
                assert_eq!(view.intent_revision, 2);
                assert_pending_stop_custody(&supervisor, dir.path()).await;
                let failures = stop_failure_events(&supervisor);
                let failure = failures
                    .iter()
                    .find(|event| event["data"]["stage"] == stage)
                    .unwrap();
                assert_eq!(
                    failure["data"]["errorCategory"], category,
                    "{stage}: {category}"
                );
                assert_eq!(
                    failure["data"]["errorCode"],
                    serde_json::json!(RuntimeErrorCode::HostUnreachable)
                );
                assert!(failure["data"]["httpStatus"].is_null());
                assert!(failures
                    .iter()
                    .any(|event| event["data"]["stage"] == "graceful_stop"));
            }
        }
    }

    #[tokio::test]
    async fn ordinary_stop_keeps_legacy_host_custody_and_requires_known_capabilities() {
        for (caps, expected) in [
            (
                vec!["CHOWN", "SETGID", "SETUID"],
                StopOutcome::VerifiedEmpty,
            ),
            (
                vec!["CHOWN", "KILL", "SETGID", "SETUID"],
                StopOutcome::VerifiedEmpty,
            ),
            (
                vec!["CHOWN", "KILL", "SETGID", "SETUID", "SYS_ADMIN"],
                StopOutcome::BlockedOwnership,
            ),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let mut supervisor = open(dir.path());
            let id = seed(&supervisor, dir.path(), false).await;
            let fixture = docker_fixture(&mut supervisor, dir.path(), false).await;
            {
                let mut state = fixture.state.lock().unwrap();
                state.inspection["HostConfig"]["CapAdd"] = serde_json::json!(caps);
                state.stop_response_overhead = Some(Duration::ZERO);
            }
            let fixture_host = host(&supervisor, dir.path()).await;
            let (outcome, view) = supervisor.stop(id, Some(1)).await.unwrap();
            assert_eq!(outcome, expected);
            assert_eq!(view.intent_revision, 2);
            assert_retained(&supervisor, dir.path(), 2).await;
            let requests = fixture.state.lock().unwrap().requests.clone();
            let writers: u64 = Connection::open(supervisor.registry.database_path())
                .unwrap()
                .query_row("SELECT count(*) FROM writer_claims", [], |r| r.get(0))
                .unwrap();
            if expected == StopOutcome::VerifiedEmpty {
                assert_eq!(writers, 0);
                assert_eq!(
                    requests
                        .iter()
                        .filter(|request| request.contains("/stop?t=2 "))
                        .count(),
                    1
                );
                assert!(supervisor
                    .registry
                    .pending_stop_handles()
                    .await
                    .unwrap()
                    .is_empty());
            } else {
                assert_eq!(writers, 1);
                assert!(requests.iter().all(|request| request.starts_with("GET ")));
                assert_pending_stop_custody(&supervisor, dir.path()).await;
            }
            close(fixture_host).await;
            fixture.close().await;
        }
    }

    #[tokio::test]
    async fn ordinary_stop_docker_grace_includes_http_overhead() {
        let dir = tempfile::tempdir().unwrap();
        let mut supervisor = open(dir.path());
        let id = seed(&supervisor, dir.path(), false).await;
        let fixture = docker_fixture(&mut supervisor, dir.path(), false).await;
        fixture.state.lock().unwrap().stop_response_overhead = Some(Duration::from_millis(250));
        let fixture_host = host(&supervisor, dir.path()).await;
        let lock = supervisor.lifecycle_lock(&id).await;
        // The real HTTP peer remains Running until it consumes the requested
        // Docker grace plus transport overhead; no observer retries this Stop.
        let (outcome, view) = supervisor.stop(id, Some(1)).await.unwrap();
        let conn = Connection::open(supervisor.registry.database_path()).unwrap();
        let progress: (u64, String, bool) = conn
            .query_row("SELECT intent_revision,outcome,settled FROM ordinary_stops WHERE incarnation_id=?1",
                [view.incarnation_id.as_str()], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        let writers: u64 = conn
            .query_row("SELECT count(*) FROM writer_claims", [], |r| r.get(0))
            .unwrap();
        let (requests, completed_stops) = {
            let state = fixture.state.lock().unwrap();
            (state.requests.clone(), state.completed_stops)
        };
        assert_retained(&supervisor, dir.path(), 2).await;
        close(fixture_host).await;
        fixture.close().await;

        assert_eq!(outcome, StopOutcome::VerifiedEmpty);
        assert_eq!(view.cleanup_state, CleanupState::VerifiedEmpty);
        assert_eq!(progress, (2, "verified_empty".into(), true));
        assert!(supervisor
            .registry
            .pending_stop_handles()
            .await
            .unwrap()
            .is_empty());
        assert!(lock.try_lock().is_ok());
        assert_eq!(completed_stops, 1);
        assert_eq!(
            requests.iter().filter(|r| r.contains("/stop?t=2 ")).count(),
            1
        );
        assert!(!requests
            .iter()
            .any(|r| r.contains("/kill?") || r.contains("/start") || r.contains("/create")));
        assert_eq!(writers, 0);
    }

    #[derive(Clone, Copy, Debug)]
    enum DueRecoverySilenceCase {
        Reserved,
        OpenCodePreflight,
        ForegroundStop,
    }

    async fn run_due_recovery_docker_silence(case: DueRecoverySilenceCase) {
        let test_name = match case {
            DueRecoverySilenceCase::Reserved => "service::interrupted_transaction_tests::due_recovery_docker_silence_settles_retry_and_releases_stop",
            DueRecoverySilenceCase::OpenCodePreflight => "service::interrupted_transaction_tests::due_recovery_docker_silence_settles_retry_after_opencode_preflight",
            DueRecoverySilenceCase::ForegroundStop => "service::interrupted_transaction_tests::due_recovery_docker_silence_does_not_block_foreground_stop",
        };
        // Match the ordinary Stop fixture's existing process boundary: a
        // foreign registry's synchronous logging cannot spend this case's
        // real Docker deadlines. All actors for one case remain together.
        if run_docker_stop_test_child("FRESHELL_RECOVERY_SILENCE_TEST_CHILD", test_name).await {
            return;
        }
        match case {
            DueRecoverySilenceCase::Reserved => due_recovery_silence_settlement(false).await,
            DueRecoverySilenceCase::OpenCodePreflight => {
                due_recovery_silence_settlement(true).await
            }
            DueRecoverySilenceCase::ForegroundStop => complete_due_recovery_foreground_stop().await,
        }
    }

    #[tokio::test]
    async fn due_recovery_docker_silence_settles_retry_and_releases_stop() {
        run_due_recovery_docker_silence(DueRecoverySilenceCase::Reserved).await;
    }

    #[tokio::test]
    async fn due_recovery_docker_silence_settles_retry_after_opencode_preflight() {
        run_due_recovery_docker_silence(DueRecoverySilenceCase::OpenCodePreflight).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn due_recovery_docker_silence_is_independent_of_foreign_registry_logging() {
        // Isolate the deliberate foreign lock holder from the broad test process.
        if run_docker_stop_test_child(
            "FRESHELL_RECOVERY_SILENCE_COORDINATOR_TEST_CHILD",
            "service::interrupted_transaction_tests::due_recovery_docker_silence_is_independent_of_foreign_registry_logging",
        ).await {
            return;
        }
        let foreign = tempfile::tempdir().unwrap();
        let foreign_registry = Registry::open(foreign.path().join("registry"), None).unwrap();
        let (held_tx, held_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let holder = std::thread::spawn(move || {
            let _registry = foreign_registry;
            let _coordinator = crate::loss_report::incident_file_coordinator();
            held_tx.send(()).unwrap();
            matches!(
                release_rx.recv_timeout(Duration::from_secs(180)),
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected)
            )
        });
        held_rx.await.unwrap();
        let mut release = Some(release_tx);
        for case in [
            DueRecoverySilenceCase::Reserved,
            DueRecoverySilenceCase::OpenCodePreflight,
            DueRecoverySilenceCase::ForegroundStop,
        ] {
            let mut running = tokio::spawn(run_due_recovery_docker_silence(case));
            // Each case retains its original 25/5/20-second behavior deadlines.
            // This only bounds the regression's deliberate foreign-lock hold.
            let result = tokio::time::timeout(Duration::from_secs(35), &mut running).await;
            let (completed_while_held, joined) = match result {
                Ok(joined) => (true, joined),
                Err(_) => {
                    drop(release.take());
                    (false, running.await)
                }
            };
            if !completed_while_held || joined.is_err() {
                drop(release.take());
                let held_until_release = holder.join().unwrap();
                panic!("{case:?} foreign logging interference: completedWhileHeld={completed_while_held}, heldUntilRelease={held_until_release}, result={joined:?}");
            }
        }
        drop(release);
        assert!(
            holder.join().unwrap(),
            "foreign lock must remain held through all three cases"
        );
    }

    async fn due_recovery_silence_settlement(preflight: bool) {
        let dir = tempfile::tempdir().unwrap();
        let (supervisor, fixture, soul) = silent_due_recovery(dir.path(), preflight).await;
        let lifecycle = supervisor.lifecycle_lock(&soul).await;
        let mut observing = {
            let supervisor = supervisor.clone();
            tokio::spawn(async move { supervisor.observe_once().await })
        };
        if wait_for_silent_recovery_requests(&fixture, 1)
            .await
            .is_err()
        {
            observing.abort();
            let _ = observing.await;
            let diagnostic = silent_recovery_diagnostic(&fixture, &lifecycle);
            fixture.close().await;
            panic!("recovery must reach the real Docker socket: {diagnostic}");
        }
        let observed = tokio::time::timeout(Duration::from_secs(25), &mut observing).await;
        if observed.is_err() {
            observing.abort();
            let _ = observing.await;
            let diagnostic = silent_recovery_diagnostic(&fixture, &lifecycle);
            fixture.close().await;
            panic!("silent Docker must settle the observer: {diagnostic}");
        }
        observed
            .expect("silent Docker must release the observer through typed settlement")
            .unwrap()
            .unwrap();
        assert!(
            lifecycle.try_lock().is_ok(),
            "completed recovery must release the lifecycle lock"
        );
        let retry = supervisor
            .registry
            .recovery_retry(soul.clone(), 1)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(retry.attempt_count, if preflight { 2 } else { 1 });
        assert_eq!(
            retry.next_due_at_ms,
            Some(if preflight { 12_000 } else { 2_000 })
        );
        assert!(retry.reserved_attempt_id.is_none());
        assert_eq!(retry.last_reason, "backend_unavailable");
        let context = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        assert_eq!(
            context.recovery_state,
            freshell_runtime_protocol::RecoveryState::Blocked
        );
        assert!(context.recovery_attempt_id.is_none());
        let conn = Connection::open(supervisor.registry.database_path()).unwrap();
        let unfinished: u64 = conn
            .query_row(
                "SELECT count(*) FROM recovery_attempts WHERE finished_at IS NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            unfinished, 0,
            "a timed-out dependency cannot strand its reservation"
        );
        let evidence: String = conn
            .query_row(
                "SELECT evidence_ref FROM recovery_attempts ORDER BY rowid DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(evidence.contains("timed out"), "{evidence}");
        assert_eq!(
            fixture
                .state
                .lock()
                .unwrap()
                .requests
                .iter()
                .filter(|request| request.contains("/json "))
                .count(),
            if preflight { 2 } else { 1 }
        );
        let requests = fixture.state.lock().unwrap().requests.len();
        tokio::time::timeout(Duration::from_secs(2), supervisor.observe_once())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            fixture.state.lock().unwrap().requests.len(),
            requests,
            "backoff must keep the next observer pass from repeating Docker work"
        );
        let inspection_count = if preflight { 2 } else { 1 };
        let mut stopping = {
            let supervisor = supervisor.clone();
            let soul = soul.clone();
            tokio::spawn(async move { supervisor.stop(soul, Some(1)).await })
        };
        // As in the ordinary Stop socket case, start the dependency budget
        // when the peer accepts this Stop's inspection, after intent setup.
        if wait_for_silent_recovery_requests(&fixture, inspection_count + 1)
            .await
            .is_err()
        {
            stopping.abort();
            let _ = stopping.await;
            let diagnostic = silent_recovery_diagnostic(&fixture, &lifecycle);
            fixture.close().await;
            panic!("Stop must reach its own Docker inspection: {diagnostic}");
        }
        let stopped = tokio::time::timeout(Duration::from_secs(5), &mut stopping).await;
        if stopped.is_err() {
            stopping.abort();
            let _ = stopping.await;
            let diagnostic = silent_recovery_diagnostic(&fixture, &lifecycle);
            fixture.close().await;
            panic!("Stop dependency must settle within its original budget: {diagnostic}");
        }
        let (outcome, view) = stopped.unwrap().unwrap().unwrap();
        assert_eq!(outcome, StopOutcome::BackendUnavailable);
        assert_ne!(view.cleanup_state, CleanupState::VerifiedEmpty);
        assert!(lifecycle.try_lock().is_ok());
        finish_silent_recovery_stop(
            &supervisor,
            fixture,
            &soul,
            &lifecycle,
            inspection_count + 1,
        )
        .await;
    }

    #[tokio::test]
    async fn due_recovery_docker_silence_does_not_block_foreground_stop() {
        run_due_recovery_docker_silence(DueRecoverySilenceCase::ForegroundStop).await;
    }

    async fn complete_due_recovery_foreground_stop() {
        let dir = tempfile::tempdir().unwrap();
        let (supervisor, fixture, soul) = silent_due_recovery(dir.path(), false).await;
        let lifecycle = supervisor.lifecycle_lock(&soul).await;
        let mut observing = {
            let supervisor = supervisor.clone();
            tokio::spawn(async move { supervisor.observe_once().await })
        };
        if wait_for_silent_recovery_requests(&fixture, 1)
            .await
            .is_err()
        {
            observing.abort();
            let _ = observing.await;
            let diagnostic = silent_recovery_diagnostic(&fixture, &lifecycle);
            fixture.close().await;
            panic!("recovery must reach the real Docker socket: {diagnostic}");
        }
        let mut stopping = {
            let supervisor = supervisor.clone();
            let soul = soul.clone();
            tokio::spawn(async move { supervisor.stop(soul, Some(1)).await })
        };
        tokio::time::timeout(Duration::from_secs(2), async {
            while supervisor
                .registry
                .recovery_context(soul.clone())
                .await
                .unwrap()
                .desired_state
                != DesiredState::Stopped
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(
            lifecycle.try_lock().is_err(),
            "recovery owns the lock while Docker is silent"
        );
        assert!(!stopping.is_finished());
        let completed = tokio::time::timeout(Duration::from_secs(20), async {
            let observed = (&mut observing).await.unwrap();
            let stopped = (&mut stopping).await.unwrap();
            (observed, stopped)
        })
        .await;
        if completed.is_err() {
            observing.abort();
            stopping.abort();
            let _ = observing.await;
            let _ = stopping.await;
            let diagnostic = silent_recovery_diagnostic(&fixture, &lifecycle);
            fixture.close().await;
            panic!("Docker silence cannot retain recovery's lock: {diagnostic}");
        }
        let (observed, stopped) =
            completed.expect("Docker silence cannot retain recovery's lock indefinitely");
        observed.unwrap();
        let (outcome, view) = stopped.unwrap();
        assert_eq!(outcome, StopOutcome::BackendUnavailable);
        assert_ne!(view.cleanup_state, CleanupState::VerifiedEmpty);
        assert!(lifecycle.try_lock().is_ok());
        assert!(supervisor
            .registry
            .recovery_retry(soul.clone(), 1)
            .await
            .unwrap()
            .is_none());
        let verdict: String = Connection::open(supervisor.registry.database_path())
            .unwrap()
            .query_row(
                "SELECT verdict FROM recovery_attempts ORDER BY rowid DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(verdict, "cancelled");
        finish_silent_recovery_stop(&supervisor, fixture, &soul, &lifecycle, 2).await;
    }

    async fn silent_due_recovery(
        root: &Path,
        preflight: bool,
    ) -> (Supervisor, crate::backend::tests::StopDockerFixture, SoulId) {
        use crate::recovery_retry::TransientRecoveryFailure;
        use std::sync::atomic::{AtomicI64, Ordering};
        let mut supervisor = open(root);
        let clock = Arc::new(AtomicI64::new(0));
        supervisor.registry.retry_clock = Some(clock.clone());
        let soul = seed(&supervisor, root, false).await;
        if preflight {
            let context = supervisor
                .registry
                .recovery_context(soul.clone())
                .await
                .unwrap();
            let mut agent = context.fresh_agent.unwrap();
            agent.provider = freshell_runtime_protocol::FreshProvider::Opencode;
            agent.session_type = "freshopencode".into();
            agent.runtime_variant = "opencode-http-v1".into();
            let conn = Connection::open(supervisor.registry.database_path()).unwrap();
            conn.execute(
                "UPDATE souls SET provider='opencode' WHERE soul_id=?1",
                [soul.as_str()],
            )
            .unwrap();
            conn.execute(
                "UPDATE incarnations SET fresh_agent_spec=?1 WHERE incarnation_id=?2",
                params![
                    serde_json::to_string(&agent).unwrap(),
                    context.prior_handle.incarnation_id().as_str()
                ],
            )
            .unwrap();
        }
        let reserved = supervisor
            .registry
            .reserve_due_recovery_retry(soul.clone(), 1, 0)
            .await
            .unwrap()
            .unwrap();
        if preflight {
            let context = supervisor
                .registry
                .recovery_context(soul.clone())
                .await
                .unwrap();
            supervisor
                .registry
                .mark_recovery_blocked_with_retry(
                    soul.clone(),
                    reserved.reserved_attempt_id,
                    freshell_runtime_protocol::RecoveryBlockReason::ProviderUnavailable,
                    vec!["synthetic prior dependency outage".into()],
                    context.write_fence(),
                    Some(TransientRecoveryFailure::Backend),
                )
                .await
                .unwrap();
            clock.store(2_000, Ordering::SeqCst);
        }
        let fixture = docker_fixture(&mut supervisor, root, false).await;
        fixture.state.lock().unwrap().silence = Some("initial_inspect");
        (supervisor, fixture, soul)
    }

    async fn wait_for_silent_recovery_requests(
        fixture: &crate::backend::tests::StopDockerFixture,
        count: usize,
    ) -> Result<(), tokio::time::error::Elapsed> {
        tokio::time::timeout(Duration::from_secs(5), async {
            while fixture
                .state
                .lock()
                .unwrap()
                .requests
                .iter()
                .filter(|request| request.contains("/json "))
                .count()
                < count
            {
                tokio::task::yield_now().await;
            }
        })
        .await
    }

    async fn wait_for_silent_recovery_disconnects(
        fixture: &crate::backend::tests::StopDockerFixture,
        count: usize,
    ) -> Result<(), tokio::time::error::Elapsed> {
        tokio::time::timeout(Duration::from_secs(1), async {
            while fixture.state.lock().unwrap().disconnected < count {
                tokio::task::yield_now().await;
            }
        })
        .await
    }

    fn silent_recovery_diagnostic(
        fixture: &crate::backend::tests::StopDockerFixture,
        lifecycle: &Arc<Mutex<()>>,
    ) -> serde_json::Value {
        let state = fixture.state.lock().unwrap();
        serde_json::json!({
            "severity":"debug", "event":"test.due_recovery_silence.transport",
            "acceptedInspections":state.requests.iter().filter(|request| request.contains("/json ")).count(),
            "silentEofCount":state.disconnected,
            "firstInspectionElapsedMs":state.first_inspection_at.map(|at| at.elapsed().as_millis()),
            "firstSilentEofElapsedMs":state.first_silent_eof_at.zip(state.first_inspection_at).map(|(eof, accepted)| eof.duration_since(accepted).as_millis()),
            "lifecycleLockHeld":lifecycle.try_lock().is_err(),
        })
    }

    async fn finish_silent_recovery_stop(
        supervisor: &Supervisor,
        fixture: crate::backend::tests::StopDockerFixture,
        soul: &SoulId,
        lifecycle: &Arc<Mutex<()>>,
        inspections: usize,
    ) {
        let disconnected = wait_for_silent_recovery_disconnects(&fixture, inspections).await;
        let diagnostic = silent_recovery_diagnostic(&fixture, lifecycle);
        assert_eq!(
            supervisor
                .registry
                .pending_stop_handles()
                .await
                .unwrap()
                .len(),
            1,
            "silence must retain pending cleanup, never claim verified empty"
        );
        {
            let mut state = fixture.state.lock().unwrap();
            state.silence = None;
            state.inspection["State"] = serde_json::json!({"Status":"created","Running":false,"Paused":false,"Restarting":false});
        }
        tokio::time::timeout(Duration::from_secs(5), supervisor.observe_once())
            .await
            .expect("a later observer pass can finish the same Stop intent")
            .unwrap();
        let context = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        assert_eq!(context.desired_state, DesiredState::Stopped);
        assert_eq!(context.intent_revision, 2);
        assert!(supervisor
            .registry
            .pending_stop_handles()
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            supervisor.registry.inventory().await.unwrap()[0].cleanup_state,
            CleanupState::VerifiedEmpty
        );
        assert!(!fixture
            .state
            .lock()
            .unwrap()
            .requests
            .iter()
            .any(|request| request.contains("/start ") || request.contains("/create")));
        fixture.close().await;
        assert!(
            disconnected.is_ok(),
            "all silent transports must close: {diagnostic}"
        );
        eprintln!("{diagnostic}");
    }

    #[tokio::test]
    async fn ordinary_stop_docker_silence_releases_lock_and_retries_same_intent() {
        run_ordinary_stop_docker_silence().await;
    }

    async fn run_ordinary_stop_docker_silence() {
        // Each registry has its own Docker peer and files, but lifecycle writes
        // share process-wide incident/rotation locks. A foreign test registry
        // must not consume this fixture's actual backend-completion budgets.
        if run_docker_stop_test_child(
            "FRESHELL_DOCKER_SILENCE_TEST_CHILD",
            "service::interrupted_transaction_tests::ordinary_stop_docker_silence_releases_lock_and_retries_same_intent",
        ).await {
            return;
        }
        complete_ordinary_stop_docker_silence().await;
    }

    async fn run_docker_stop_test_child(child_env: &'static str, test_name: &'static str) -> bool {
        if std::env::var(child_env).as_deref() == Ok("1") {
            return false;
        }
        let output = tokio::task::spawn_blocking(move || {
            std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", test_name, "--nocapture"])
                .env(child_env, "1")
                .env_remove("FRESHELL_RUNTIME_CAPABILITY_DIR")
                .output()
                .unwrap()
        })
        .await
        .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            String::from_utf8_lossy(&output.stdout)
                .contains("test result: ok. 1 passed; 0 failed; 0 ignored;"),
            "exact Docker case must execute one test: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        eprint!("{}", String::from_utf8_lossy(&output.stderr));
        true
    }

    async fn complete_ordinary_stop_docker_silence() {
        let mut failures = Vec::new();
        for point in [
            "initial_inspect",
            "graceful_request",
            "graceful_observation",
            "force_request",
            "force_observation",
            "error_observation",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let mut supervisor = open(dir.path());
            let id = seed(&supervisor, dir.path(), false).await;
            let fixture = docker_fixture(&mut supervisor, dir.path(), false).await;
            fixture.state.lock().unwrap().silence = Some(point);
            let fixture_host = host(&supervisor, dir.path()).await;
            let lock = supervisor.lifecycle_lock(&id).await;
            let mut stopping = {
                let supervisor = supervisor.clone();
                let id = id.clone();
                tokio::spawn(async move { supervisor.stop(id, Some(1)).await })
            };
            // Measure the backend budget from an actual accepted inspection.
            // Parallel suite setup can queue SQLite intent commits before any
            // backend future exists; that is not time spent awaiting Docker.
            tokio::time::timeout(Duration::from_secs(15), async {
                while !fixture
                    .state
                    .lock()
                    .unwrap()
                    .requests
                    .iter()
                    .any(|r| r.contains("/json "))
                {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            let limit = Duration::from_secs(if point.starts_with("force_") { 7 } else { 4 });
            let result = tokio::time::timeout(limit, &mut stopping).await;
            if result.is_err() {
                // The timeout does not own/cancel the foreground Stop. Prove
                // that it is still the old lock holder, then reap our task.
                let lock_held = lock.try_lock().is_err();
                assert!(lock_held);
                let (accepted_at, transport) = {
                    let state = fixture.state.lock().unwrap();
                    let sampled_at = std::time::Instant::now();
                    let accepted_at = state.first_inspection_at;
                    (
                        accepted_at,
                        serde_json::json!({
                            "acceptedInspectionElapsedMs": accepted_at.map(|at| sampled_at.duration_since(at).as_secs_f64() * 1000.0),
                            "firstSilentEofElapsedMs": state.first_silent_eof_at.zip(accepted_at).map(|(eof, accepted)| eof.duration_since(accepted).as_secs_f64() * 1000.0),
                            "disconnected": state.disconnected,
                            "lifecycleLockHeld": lock_held,
                        }),
                    )
                };
                // This independent reader never uses the Registry's writable
                // connection setup or extends the original Stop deadline.
                // Its snapshot can be later than the transport/lock sample.
                let database = supervisor.registry.database_path().to_path_buf();
                let soul = id.as_str().to_owned();
                let mut reader = tokio::task::spawn_blocking(move || {
                    let started_at = std::time::Instant::now();
                    let projection = (|| -> rusqlite::Result<serde_json::Value> {
                        let connection = Connection::open_with_flags(
                            database,
                            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
                        )?;
                        connection.busy_timeout(Duration::from_millis(25))?;
                        connection.pragma_update(None, "query_only", true)?;
                        connection.query_row(
                            "SELECT p.incarnation_id,p.outcome,p.settled,p.intent_revision,p.execution_generation,w.count \
                             FROM (SELECT count(*) AS count FROM writer_claims WHERE soul_id=?1) w \
                             LEFT JOIN ordinary_stops p ON p.soul_id=?1 AND p.intent_revision=2",
                            [soul],
                            |row| {
                                let incarnation: Option<String> = row.get(0)?;
                                Ok(serde_json::json!({
                                    "status":"observed", "rowPresent":incarnation.is_some(),
                                    "incarnationId":incarnation,
                                    "outcome":row.get::<_, Option<String>>(1)?,
                                    "settled":row.get::<_, Option<bool>>(2)?,
                                    "intentRevision":row.get::<_, Option<u64>>(3)?,
                                    "executionGeneration":row.get::<_, Option<u64>>(4)?,
                                    "writerCount":row.get::<_, u64>(5)?,
                                }))
                            },
                        )
                    })();
                    serde_json::json!({
                        "readStartedElapsedMs":accepted_at.map(|at| started_at.duration_since(at).as_secs_f64() * 1000.0),
                        "readFinishedElapsedMs":accepted_at.map(|at| at.elapsed().as_secs_f64() * 1000.0),
                        "projection":projection.unwrap_or_else(|_| serde_json::json!({"status":"unknown","reason":"query_error"})),
                    })
                });
                let read = tokio::time::timeout(Duration::from_millis(100), &mut reader).await;
                let reader_pending = read.is_err();
                let registry = match read {
                    Ok(Ok(snapshot)) => snapshot,
                    Ok(Err(_)) => {
                        serde_json::json!({"status":"unknown","reason":"reader_join_error"})
                    }
                    Err(_) => serde_json::json!({"status":"unknown","reason":"read_timeout"}),
                };
                stopping.abort();
                let _ = stopping.await;
                close(fixture_host).await;
                fixture.close().await;
                // A timed-out blocking read remains owned: join it before the
                // fixture directory is dropped, but keep its snapshot UNKNOWN.
                if reader_pending {
                    let _ = reader.await;
                }
                eprintln!(
                    "{}",
                    serde_json::json!({
                        "severity":"error", "event":"test.ordinary_stop.failure_stage",
                        "soulId":id, "phase":point, "resultDeadlineMs":limit.as_millis(),
                        "registryReadDeadlineMs":100, "transport":transport, "registry":registry,
                    })
                );
                failures.push(format!(
                    "{point}: foreground Stop retained its lifecycle lock beyond {limit:?}"
                ));
                continue;
            }
            let (outcome, view) = result.unwrap().unwrap().unwrap();
            let expected = if point == "error_observation" {
                StopOutcome::TerminationUnconfirmed
            } else {
                StopOutcome::BackendUnavailable
            };
            assert_eq!(outcome, expected, "{point}");
            let failures = stop_failure_events(&supervisor);
            let stage = match point {
                "initial_inspect" => "initial_empty_inspection",
                "graceful_request" | "error_observation" => "graceful_stop",
                "graceful_observation" => "graceful_empty_inspection",
                "force_request" => "force_stop",
                "force_observation" => "force_empty_inspection",
                _ => unreachable!(),
            };
            assert!(
                failures.iter().any(|event| event["data"]["stage"] == stage),
                "{point}: missing failed stage"
            );
            if point == "error_observation" {
                assert!(failures
                    .iter()
                    .any(|event| event["data"]["stage"] == "graceful_failure_empty_inspection"));
                assert_eq!(failures[0]["data"]["errorCategory"], "docker_http");
                assert_eq!(failures[0]["data"]["httpStatus"], 500);
            } else {
                let failure = failures
                    .iter()
                    .find(|event| event["data"]["stage"] == stage)
                    .unwrap();
                assert_eq!(failure["data"]["errorCategory"], "timeout", "{point}");
                assert!(failure["data"]["httpStatus"].is_null());
            }
            assert_eq!(view.intent_revision, 2);
            assert_eq!(view.cleanup_state, CleanupState::TerminationUnconfirmed);
            assert!(
                lock.try_lock().is_ok(),
                "{point}: completed Stop must release the original lock"
            );
            let handle = supervisor
                .registry
                .pending_stop_handles()
                .await
                .unwrap()
                .remove(0);
            let progress = supervisor.registry.stop_progress(&handle).await.unwrap();
            assert_eq!(progress.outcome, Some(expected));
            assert!(!progress.settled);
            assert_retained(&supervisor, dir.path(), 2).await;
            tokio::time::timeout(Duration::from_secs(1), async {
                while fixture.state.lock().unwrap().disconnected == 0 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            {
                let mut state = fixture.state.lock().unwrap();
                state.silence = None;
                state.inspection["State"] = serde_json::json!({"Status":"exited","Running":false});
            }
            tokio::time::timeout(Duration::from_secs(2), supervisor.observe_once())
                .await
                .unwrap()
                .unwrap();
            let progress = supervisor.registry.stop_progress(&handle).await.unwrap();
            assert_eq!(progress.outcome, Some(StopOutcome::VerifiedEmpty));
            assert!(progress.settled);
            assert!(supervisor
                .registry
                .pending_stop_handles()
                .await
                .unwrap()
                .is_empty());
            assert_retained(&supervisor, dir.path(), 2).await;
            let writers: u64 = Connection::open(supervisor.registry.database_path())
                .unwrap()
                .query_row("SELECT count(*) FROM writer_claims", [], |r| r.get(0))
                .unwrap();
            assert_eq!(writers, 0);
            assert!(!fixture
                .state
                .lock()
                .unwrap()
                .requests
                .iter()
                .any(|r| r.contains("/start") || r.contains("/create")));
            eprintln!("bounded silent Docker {point}; same-intent observer completion verified");
            close(fixture_host).await;
            fixture.close().await;
        }
        assert!(
            failures.is_empty(),
            "unbounded Stop backend futures: {failures:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ordinary_stop_docker_silence_is_independent_of_foreign_registry_logging() {
        // The regression's deliberate lock holder also needs its own process:
        // it must not introduce the same contention into unrelated tests.
        if run_docker_stop_test_child(
            "FRESHELL_DOCKER_SILENCE_COORDINATOR_TEST_CHILD",
            "service::interrupted_transaction_tests::ordinary_stop_docker_silence_is_independent_of_foreign_registry_logging",
        ).await {
            return;
        }
        let foreign = tempfile::tempdir().unwrap();
        let foreign_registry = Registry::open(foreign.path().join("registry"), None).unwrap();
        let (held_tx, held_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let holder = std::thread::spawn(move || {
            let _registry = foreign_registry;
            let _coordinator = crate::loss_report::incident_file_coordinator();
            held_tx.send(()).unwrap();
            // Always release this test's lock, including on a failed child.
            // This is only the holder's deadlock escape; the original six
            // backend deadlines still run unchanged inside the child.
            matches!(
                release_rx.recv_timeout(Duration::from_secs(180)),
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected)
            )
        });
        held_rx.await.unwrap();
        let result = tokio::spawn(run_ordinary_stop_docker_silence()).await;
        drop(release_tx);
        assert!(
            holder.join().unwrap(),
            "foreign coordinator must remain held until every phase completes"
        );
        result.expect("foreign registry logging must not consume the Stop fixture's budgets");
    }

    async fn host(supervisor: &Supervisor, root: &Path) -> tokio::task::JoinHandle<()> {
        let view = supervisor.registry.inventory().await.unwrap().remove(0);
        let handle = supervisor
            .registry
            .owned_handle(view.incarnation_id)
            .await
            .unwrap();
        let socket = handle.runtime_dir().join("host.sock");
        if socket.exists() {
            std::fs::remove_file(&socket).unwrap();
        }
        let listener = UnixListener::bind(socket).unwrap();
        let root = root.to_path_buf();
        tokio::spawn(async move {
            let boot = HostBootId::new();
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request: Envelope<HostCommand> = read_frame(&mut socket).await.unwrap();
                let result = match request.body {
                    HostCommand::Hello {
                        incarnation_id,
                        challenge,
                    } => {
                        assert_eq!(&incarnation_id, handle.incarnation_id());
                        pause(&root, "host_authenticated").await;
                        HostResult::Hello {
                            host_boot_id: boot.clone(),
                            proof: host_proof(
                                b"synthetic-secret",
                                &challenge,
                                &boot,
                                &incarnation_id,
                            ),
                            effective_limits: handle.requested_limits(),
                            capabilities: vec![],
                        }
                    }
                    HostCommand::Stop { .. } => {
                        record(&root, "host_stops", handle.container_id());
                        pause(&root, "host_stopped").await;
                        HostResult::Stopped
                    }
                    _ => panic!("ordinary Stop cannot issue execution or recovery IPC"),
                };
                write_frame(
                    &mut socket,
                    &HostReply {
                        request_id: request.request_id,
                        result: Ok(result),
                    },
                )
                .await
                .unwrap();
            }
        })
    }

    async fn pause(root: &Path, point: &str) {
        if std::fs::read_to_string(root.join("pause-at"))
            .ok()
            .as_deref()
            == Some(point)
        {
            std::fs::write(root.join("pause-reached"), point).unwrap();
            tokio::time::timeout(Duration::from_secs(10), async {
                while !root.join("pause-release").exists() {
                    sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
        }
    }

    async fn callback(root: &Path, response: &'static [u8]) -> tokio::task::JoinHandle<()> {
        callback_with_grant(root, response, "stop-exact-grant").await
    }

    async fn callback_with_grant(
        root: &Path,
        response: &'static [u8],
        grant: &'static str,
    ) -> tokio::task::JoinHandle<()> {
        let path = root.join("mcp.sock");
        if path.exists() {
            std::fs::remove_file(&path).unwrap();
        }
        let listener = tokio::net::UnixListener::bind(path).unwrap();
        let root = root.to_path_buf();
        tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut body = vec![];
                socket.read_to_end(&mut body).await.unwrap();
                let request: serde_json::Value = serde_json::from_slice(&body).unwrap();
                assert_eq!(request["action"], "revoke");
                assert_eq!(request["grantId"], grant);
                assert_eq!(request["soulId"], soul(&root).as_str());
                let incarnation: String = Connection::open(root.join("registry/runtime.sqlite3"))
                    .unwrap()
                    .query_row(
                        "SELECT incarnation_id FROM incarnations WHERE soul_id=?1",
                        [soul(&root).as_str()],
                        |r| r.get(0),
                    )
                    .unwrap();
                assert_eq!(request["incarnationId"], incarnation);
                record(&root, "revokes", request["grantId"].as_str().unwrap());
                pause(&root, "revoke_sent").await;
                socket.write_all(response).await.unwrap();
            }
        })
    }

    async fn close(task: tokio::task::JoinHandle<()>) {
        task.abort();
        let _ = task.await;
    }

    async fn crash_child(root: &Path, point: &str, resume: bool) {
        let marker = root.join("crash-boundary");
        if marker.exists() {
            std::fs::remove_file(&marker).unwrap();
        }
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "service::interrupted_transaction_tests::interrupted_transaction_child",
                "--ignored",
                "--nocapture",
            ])
            .env("FRESHELL_STOP_TEST_ROOT", root)
            .env("FRESHELL_STOP_TEST_CRASH", point)
            .env("FRESHELL_STOP_TEST_RESUME", if resume { "1" } else { "0" })
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(45);
        while child.try_wait().unwrap().is_none() {
            if Instant::now() >= deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("owned Stop child timed out at {point}");
            }
            sleep(Duration::from_millis(20)).await;
        }
        let output = child.wait_with_output().unwrap();
        assert_eq!(
            output.status.signal(),
            Some(libc::SIGABRT),
            "expected actual boundary abort: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(std::fs::read_to_string(marker).unwrap(), point);
        eprintln!("verified interrupted Stop: {point}");
    }

    #[tokio::test]
    #[ignore = "subprocess fixture; disposable runtime-suite only"]
    async fn interrupted_transaction_child() {
        let Some(root) = std::env::var_os("FRESHELL_STOP_TEST_ROOT") else {
            return;
        };
        sandbox_only();
        let root = PathBuf::from(root);
        let supervisor = open(&root);
        let fixture_host = host(&supervisor, &root).await;
        if std::env::var("FRESHELL_STOP_TEST_RESUME").as_deref() == Ok("1") {
            supervisor.reconcile_startup().await.unwrap();
        } else {
            supervisor.stop(soul(&root), None).await.unwrap();
        }
        close(fixture_host).await;
        panic!("Stop boundary was not reached");
    }

    async fn assert_retained(supervisor: &Supervisor, root: &Path, revision: u64) {
        let conn = Connection::open(supervisor.registry.database_path()).unwrap();
        let fingerprint: (String,String,String,u64,u64,u64) = conn.query_row(
            "SELECT provider_store_id,provider_volume_name,native_session_id,evidence_revision,native_import_revision,successful_recoveries_in_window FROM souls WHERE soul_id=?1", [soul(root).as_str()], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).unwrap();
        assert_eq!(
            serde_json::to_vec(&fingerprint).unwrap(),
            std::fs::read(root.join("identity.json")).unwrap()
        );
        assert_eq!(
            std::fs::read(root.join("provider/history.jsonl")).unwrap(),
            b"{\"root\":\"stop-retained-root\",\"turn\":\"synthetic retained history\"}\n"
        );
        let view = supervisor.registry.inventory().await.unwrap().remove(0);
        assert_eq!(view.desired_state, DesiredState::Stopped);
        assert_eq!(view.intent_revision, revision);
        assert_eq!(
            conn.query_row("SELECT count(*) FROM incarnations", [], |r| r
                .get::<_, u64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM recovery_attempts", [], |r| r
                .get::<_, u64>(0))
                .unwrap(),
            0
        );
        assert_eq!(count(root, "creates"), 0);
        assert_eq!(count(root, "starts"), 0);
        assert_eq!(
            conn.query_row("SELECT count(*) FROM stop_test_effects", [], |r| r
                .get::<_, u64>(0))
                .unwrap(),
            0
        );
        for action in ["host_stops", "graceful", "force"] {
            for target in std::fs::read_to_string(root.join(action))
                .unwrap_or_default()
                .lines()
            {
                assert_eq!(
                    target,
                    std::fs::read_to_string(root.join("container")).unwrap()
                );
            }
        }
    }

    #[tokio::test]
    #[ignore = "destructive crash matrix; disposable runtime-suite only"]
    async fn ordinary_stop_crash_boundary_matrix() {
        sandbox_only();
        let mut failures = vec![];
        let points = [
            "ordinary_stop_after_intent",
            "ordinary_stop_after_graceful",
            "ordinary_stop_after_empty",
            "ordinary_stop_after_outcome",
        ];
        for point in points {
            let dir = tempfile::tempdir().unwrap();
            let supervisor = open(dir.path());
            seed(&supervisor, dir.path(), true).await;
            if point == "ordinary_stop_after_empty" {
                std::fs::write(dir.path().join("mode"), b"force").unwrap();
            }
            drop(supervisor);
            crash_child(dir.path(), point, false).await;
            let callback = callback(dir.path(), b"ok").await;
            let supervisor = open(dir.path());
            let fixture_host = host(&supervisor, dir.path()).await;
            if point == "ordinary_stop_after_empty" {
                assert_eq!(count(dir.path(), "force"), 1);
            }
            assert_retained(&supervisor, dir.path(), 2).await;
            supervisor.reconcile_startup().await.unwrap();
            supervisor.observe_once().await.unwrap();
            assert_retained(&supervisor, dir.path(), 2).await;
            let view = supervisor.registry.inventory().await.unwrap().remove(0);
            if view.cleanup_state != CleanupState::VerifiedEmpty
                || count(dir.path(), "revokes") != 1
            {
                failures.push(format!(
                    "{point}: {:?}, revokes={}",
                    view.cleanup_state,
                    count(dir.path(), "revokes")
                ));
            }
            close(callback).await;
            close(fixture_host).await;
        }
        assert_eq!(points.len(), 4);
        assert!(
            failures.is_empty(),
            "interrupted Stop did not continue: {failures:?}"
        );
    }

    #[tokio::test]
    #[ignore = "destructive crash matrix; disposable runtime-suite only"]
    async fn ordinary_stop_crash_unresolved_and_stale_matrix() {
        sandbox_only();
        let cases = [
            ("unavailable", CleanupState::TerminationUnconfirmed),
            ("surviving", CleanupState::TerminationUnconfirmed),
            ("mismatch", CleanupState::BlockedOwnership),
            ("removed", CleanupState::VerifiedEmpty),
        ];
        let mut failures = vec![];
        for (mode, expected) in cases {
            let dir = tempfile::tempdir().unwrap();
            let supervisor = open(dir.path());
            seed(&supervisor, dir.path(), false).await;
            drop(supervisor);
            crash_child(dir.path(), "ordinary_stop_after_intent", false).await;
            std::fs::write(dir.path().join("mode"), mode).unwrap();
            let supervisor = open(dir.path());
            let fixture_host = host(&supervisor, dir.path()).await;
            supervisor.reconcile_startup().await.unwrap();
            let view = supervisor.registry.inventory().await.unwrap().remove(0);
            if view.cleanup_state != expected {
                failures.push(format!("{mode}: {:?}", view.cleanup_state));
            }
            assert_retained(&supervisor, dir.path(), 2).await;
            let handle = supervisor
                .registry
                .pending_stop_handles()
                .await
                .unwrap()
                .pop();
            if mode == "removed" {
                assert!(handle.is_none());
                assert_eq!(count(dir.path(), "host_stops"), 0);
                assert_eq!(count(dir.path(), "graceful"), 0);
            } else {
                let progress = supervisor
                    .registry
                    .stop_progress(&handle.unwrap())
                    .await
                    .unwrap();
                assert_eq!(
                    progress.outcome,
                    Some(match mode {
                        "unavailable" => StopOutcome::BackendUnavailable,
                        "mismatch" => StopOutcome::BlockedOwnership,
                        _ => StopOutcome::TerminationUnconfirmed,
                    })
                );
                assert!(!progress.settled);
            }
            close(fixture_host).await;
        }
        // A later Stop is committed while the first caller waits for the lock.
        let dir = tempfile::tempdir().unwrap();
        let supervisor = open(dir.path());
        let id = seed(&supervisor, dir.path(), false).await;
        let lock = supervisor.lifecycle_lock(&id).await;
        let guard = lock.lock().await;
        let waiting = {
            let supervisor = supervisor.clone();
            let id = id.clone();
            tokio::spawn(async move { supervisor.stop(id, Some(1)).await })
        };
        tokio::time::timeout(Duration::from_secs(2), async {
            while supervisor.registry.inventory().await.unwrap()[0].intent_revision != 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        supervisor
            .registry
            .begin_stop_expected(id, Some(2))
            .await
            .unwrap();
        drop(guard);
        let result = waiting.await.unwrap();
        if result.is_ok() || count(dir.path(), "graceful") != 0 {
            failures.push("old same-incarnation Stop signaled after a newer intent".into());
        }
        assert_retained(&supervisor, dir.path(), 3).await;
        assert!(
            failures.is_empty(),
            "Stop continuation or fence missing: {failures:?}"
        );
        for point in [
            "host_authenticated",
            "host_stopped",
            "graceful_return",
            "force_return",
            "empty_observed",
            "revoke_sent",
        ] {
            stale_during_effect(point).await;
        }
        let dir = tempfile::tempdir().unwrap();
        let supervisor = open(dir.path());
        let id = SoulId::new();
        let old =
            crate::registry::tests::materialize_test_runtime(&supervisor.registry, id.clone())
                .await;
        let stale = supervisor.registry.begin_stop(id.clone()).await.unwrap();
        supervisor
            .registry
            .mark_stop_outcome(old.incarnation_id, StopOutcome::VerifiedEmpty)
            .await
            .unwrap();
        let new = crate::registry::tests::materialize_test_runtime(&supervisor.registry, id).await;
        assert!(supervisor.finish_stop_handle(&stale).await.is_err());
        assert_eq!(count(dir.path(), "graceful"), 0);
        assert_eq!(
            supervisor
                .registry
                .owned_handle(new.incarnation_id)
                .await
                .unwrap()
                .container_id(),
            supervisor
                .registry
                .inventory()
                .await
                .unwrap()
                .iter()
                .find(|v| v.launch_state == LaunchState::Running)
                .unwrap()
                .container_id
                .as_deref()
                .unwrap()
        );
    }

    async fn stale_during_effect(point: &str) {
        let dir = tempfile::tempdir().unwrap();
        let supervisor = open(dir.path());
        let id = seed(&supervisor, dir.path(), true).await;
        let fixture_host = host(&supervisor, dir.path()).await;
        let callback = callback(dir.path(), b"ok").await;
        std::fs::write(dir.path().join("pause-at"), point).unwrap();
        if matches!(point, "graceful_return" | "force_return") {
            std::fs::write(dir.path().join("mode"), b"force").unwrap();
        }
        let stale = supervisor.registry.begin_stop(id.clone()).await.unwrap();
        let waiting = {
            let supervisor = supervisor.clone();
            let handle = stale.clone();
            tokio::spawn(async move {
                let lock = supervisor.lifecycle_lock(handle.soul_id()).await;
                let _guard = lock.lock().await;
                supervisor.finish_stop_handle(&handle).await
            })
        };
        tokio::time::timeout(Duration::from_secs(12), async {
            while !dir.path().join("pause-reached").exists() {
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        supervisor
            .registry
            .begin_stop_expected(id, Some(2))
            .await
            .unwrap();
        std::fs::write(dir.path().join("pause-release"), b"release").unwrap();
        assert!(
            waiting.await.unwrap().is_err(),
            "stale {point} must not settle the new intent"
        );
        assert_eq!(
            supervisor.registry.inventory().await.unwrap()[0].cleanup_state,
            if point == "revoke_sent" {
                CleanupState::VerifiedEmpty
            } else {
                CleanupState::Requested
            }
        );
        if point == "host_authenticated" {
            assert_eq!(count(dir.path(), "host_stops"), 0);
        }
        if matches!(point, "host_authenticated" | "host_stopped") {
            assert_eq!(count(dir.path(), "graceful"), 0);
        }
        if point == "graceful_return" {
            assert_eq!(count(dir.path(), "force"), 0);
        }
        assert_eq!(
            count(dir.path(), "revokes"),
            usize::from(point == "revoke_sent")
        );
        assert!(supervisor
            .registry
            .record_ordinary_stop_outcome(&stale, StopOutcome::VerifiedEmpty)
            .await
            .is_err());
        assert!(supervisor
            .registry
            .acknowledge_stop_revoke(
                &stale,
                "http://host.docker.internal:3456",
                "stop-exact-grant"
            )
            .await
            .is_err());
        assert_retained(&supervisor, dir.path(), 3).await;
        close(callback).await;
        close(fixture_host).await;
    }

    #[tokio::test]
    #[ignore = "destructive migration/revocation matrix; disposable runtime-suite only"]
    async fn ordinary_stop_crash_migration_and_revoke() {
        sandbox_only();
        let dir = tempfile::tempdir().unwrap();
        let supervisor = open(dir.path());
        seed(&supervisor, dir.path(), true).await;
        drop(supervisor);
        crash_child(dir.path(), "ordinary_stop_after_intent", false).await;
        // Same executable pre-Task-6 fixture technique as the schema14 retry
        // fixture: retain real data/Stop intent, remove only the newer schema.
        let conn = Connection::open(dir.path().join("registry/runtime.sqlite3")).unwrap();
        conn.execute_batch(
            "DROP TABLE IF EXISTS ordinary_stops; UPDATE installation SET schema_version=15;",
        )
        .unwrap();
        drop(conn);
        crash_child(dir.path(), "ordinary_stop_after_outcome", true).await;
        let rejected = callback(dir.path(), b"not-acknowledged").await;
        let supervisor = open(dir.path());
        supervisor.reconcile_startup().await.unwrap();
        assert_eq!(count(dir.path(), "revokes"), 1);
        close(rejected).await;
        drop(supervisor);
        let acknowledged = callback(dir.path(), b"ok").await;
        let supervisor = open(dir.path());
        supervisor.reconcile_startup().await.unwrap();
        supervisor.observe_once().await.unwrap();
        assert_eq!(
            count(dir.path(), "revokes"),
            2,
            "same grant retries until positive acknowledgement, then settles once"
        );
        assert_retained(&supervisor, dir.path(), 2).await;
        assert_eq!(
            supervisor.registry.inventory().await.unwrap()[0].cleanup_state,
            CleanupState::VerifiedEmpty
        );
        close(acknowledged).await;
        drop(supervisor);
        let supervisor = open(dir.path());
        assert!(supervisor
            .registry
            .pending_stop_handles()
            .await
            .unwrap()
            .is_empty());
        supervisor.observe_once().await.unwrap();
        assert_eq!(count(dir.path(), "revokes"), 2);

        for completed in [false, true] {
            for capability in [false, true] {
                legacy_stop_case(completed, capability).await;
            }
        }

        // No committed container means no signal/empty authority, even though
        // durable Stop still cancels intent before reporting the refusal.
        let dir = tempfile::tempdir().unwrap();
        let supervisor = open(dir.path());
        let id = seed(&supervisor, dir.path(), true).await;
        let conn = Connection::open(supervisor.registry.database_path()).unwrap();
        conn.execute("UPDATE incarnations SET launch_state='prepared',container_id=NULL,docker_daemon_id=NULL WHERE soul_id=?1", [id.as_str()]).unwrap();
        assert!(supervisor.registry.begin_stop(id).await.is_err());
        supervisor.reconcile_startup().await.unwrap();
        let view = supervisor.registry.inventory().await.unwrap().remove(0);
        assert_eq!(view.intent_revision, 2);
        assert_eq!(view.cleanup_state, CleanupState::BlockedOwnership);
        assert_eq!(count(dir.path(), "revokes"), 0);
        assert_eq!(count(dir.path(), "graceful"), 0);
    }

    async fn legacy_stop_case(completed: bool, capability: bool) {
        let dir = tempfile::tempdir().unwrap();
        let supervisor = open(dir.path());
        let id = seed(&supervisor, dir.path(), capability).await;
        let handle = supervisor.registry.begin_stop(id).await.unwrap();
        if completed {
            supervisor
                .registry
                .mark_stop_outcome(handle.incarnation_id().clone(), StopOutcome::VerifiedEmpty)
                .await
                .unwrap();
            std::fs::write(dir.path().join("empty"), b"empty").unwrap();
        }
        let conn = Connection::open(supervisor.registry.database_path()).unwrap();
        conn.execute_batch("DROP TABLE ordinary_stops; UPDATE installation SET schema_version=15;")
            .unwrap();
        drop(conn);
        drop(supervisor);
        let supervisor = open(dir.path());
        let fixture_host = host(&supervisor, dir.path()).await;
        let callback = callback(dir.path(), b"ok").await;
        supervisor.reconcile_startup().await.unwrap();
        supervisor.observe_once().await.unwrap();
        assert_retained(&supervisor, dir.path(), 2).await;
        assert_eq!(
            supervisor.registry.inventory().await.unwrap()[0].cleanup_state,
            CleanupState::VerifiedEmpty
        );
        assert!(supervisor
            .registry
            .pending_stop_handles()
            .await
            .unwrap()
            .is_empty());
        assert_eq!(count(dir.path(), "revokes"), usize::from(capability));
        assert_eq!(count(dir.path(), "graceful"), usize::from(!completed));
        close(fixture_host).await;
        close(callback).await;
    }
}

#[cfg(test)]
mod native_observation_ipc_tests {
    use super::*;
    use rusqlite::{params, Connection};

    async fn run_native_observation_test_child(test_name: &'static str) -> bool {
        const CHILD_ENV: &str = "FRESHELL_NATIVE_OBSERVATION_IPC_TEST_CHILD";
        if std::env::var(CHILD_ENV).as_deref() == Ok(test_name) {
            return false;
        }
        let output = tokio::task::spawn_blocking(move || {
            std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", test_name, "--nocapture"])
                .env(CHILD_ENV, test_name)
                .env_remove("FRESHELL_RUNTIME_CAPABILITY_DIR")
                .output()
                .unwrap()
        })
        .await
        .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        true
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn status_probe_fixture_is_independent_of_foreign_registry_logging() {
        // Keep the deliberately held process-wide lock out of other tests.
        if run_native_observation_test_child(
            "service::native_observation_ipc_tests::status_probe_fixture_is_independent_of_foreign_registry_logging",
        )
        .await
        {
            return;
        }
        let foreign = tempfile::tempdir().unwrap();
        let foreign_registry = Registry::open(foreign.path().join("registry"), None).unwrap();
        let (held_tx, held_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let holder = std::thread::spawn(move || {
            let _registry = foreign_registry;
            let _coordinator = crate::loss_report::incident_file_coordinator();
            held_tx.send(()).unwrap();
            matches!(
                release_rx.recv_timeout(Duration::from_secs(30)),
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected)
            )
        });
        held_rx.await.unwrap();
        let mut fixture = tokio::spawn(run_status_probe_fence_test());
        let result = tokio::time::timeout(Duration::from_secs(15), &mut fixture).await;
        drop(release_tx);
        assert!(
            holder.join().unwrap(),
            "foreign coordinator must remain held until the fixture completes"
        );
        if result.is_err() {
            // Release the owned lock and join the pending fixture before failing.
            let _ = fixture.await;
        }
        result
            .expect("foreign registry logging consumed the native IPC fixture's deadline")
            .expect("native IPC fixture failed");
    }

    #[tokio::test]
    async fn pending_terminal_output_io_does_not_block_replacement_and_refuses_late_output() {
        for stall_hello in [false, true] {
            for native_session_id in [None, Some("ses_old".to_string())] {
                pending_terminal_output_case(stall_hello, native_session_id, "incarnation", false)
                    .await;
            }
        }
    }

    #[tokio::test]
    async fn terminal_output_remains_readable_across_healthy_reattach() {
        tokio::time::timeout(
            Duration::from_secs(5),
            pending_terminal_output_case(false, None, "settled_recovery", false),
        )
        .await
        .expect("same-owner reattach must leave output readable");
    }

    #[tokio::test]
    async fn terminal_output_does_not_wait_for_same_owner_recovery_custody() {
        for native in [None, Some("ses_known".into())] {
            let known = native.is_some();
            tokio::time::timeout(
                Duration::from_secs(5),
                pending_terminal_output_case(false, native, "long_recovery", known),
            )
            .await
            .expect("accepted output must remain readable while recovery owns lifecycle custody");
        }
    }

    #[tokio::test]
    async fn terminal_output_read_before_healthy_reattach_finishes_during_recovery() {
        for native in [None, Some("ses_known".into())] {
            let known = native.is_some();
            tokio::time::timeout(
                Duration::from_secs(5),
                pending_terminal_output_case(false, native, "settled_recovery_after_read", known),
            )
            .await
            .expect("a healthy reattach during host IO must leave output readable");
        }
    }

    #[tokio::test]
    async fn terminal_output_preserves_read_ownership_and_fences_new_identity_writes() {
        for native_session_id in [None, Some("ses_observed".to_string())] {
            for change in [
                "control_epoch",
                "intent_revision",
                "identity_revision",
                "evidence_revision",
                "native_import_revision",
                "recovery_attempt_id",
                "execution_generation",
                "host_boot_id",
                "stop_intent",
                "reply_incarnation",
                "reply_terminal",
                "unchanged",
            ] {
                pending_terminal_output_case(false, native_session_id.clone(), change, false).await;
            }
        }
    }

    #[tokio::test]
    async fn terminal_output_with_known_identity_ignores_only_recovery_bookkeeping() {
        for change in [
            "control_epoch",
            "evidence_revision",
            "native_import_revision",
            "recovery_attempt_id",
            "intent_revision",
            "identity_revision",
            "stop_intent",
        ] {
            pending_terminal_output_case(false, Some("ses_known".into()), change, true).await;
        }
    }

    #[tokio::test]
    async fn terminal_output_accepts_only_an_independently_resolved_matching_native_root() {
        for change in ["resolved_matching_root", "resolved_other_root"] {
            pending_terminal_output_case(false, Some("ses_observed".into()), change, false).await;
        }
    }

    #[tokio::test]
    async fn terminal_native_identity_write_revalidates_generation_after_lifecycle_custody() {
        for change in [
            "pending_identity_generation",
            "pending_identity_boot",
            "pending_identity_stop",
        ] {
            pending_terminal_output_case(false, Some("ses_observed".into()), change, false).await;
        }
    }

    async fn pending_terminal_output_case(
        stall_hello: bool,
        native_session_id: Option<String>,
        change: &'static str,
        already_known: bool,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path().join("registry"), None).unwrap();
        let soul = SoulId::new();
        let old = crate::registry::tests::materialize_test_runtime(&registry, soul.clone()).await;
        let runtime = dir.path().join("runtime").join(old.incarnation_id.as_str());
        std::fs::create_dir_all(&runtime).unwrap();
        std::fs::write(runtime.join("secret"), b"synthetic-secret").unwrap();
        Connection::open(registry.database_path())
            .unwrap()
            .execute(
                "UPDATE incarnations SET runtime_dir=?1,terminal_spec=?2 WHERE incarnation_id=?3",
                params![runtime.to_string_lossy(), serde_json::json!({
                    "terminalId":"terminal-old", "streamId":"epoch-old", "mode":"shell", "program":"/bin/sh",
                    "cwd":"/synthetic", "runAsUid":65534, "runAsGid":0, "cols":80, "rows":24,
                    "projectKey":"synthetic", "workspacePath":"/synthetic"
                }).to_string(), old.incarnation_id.as_str()],
            )
            .unwrap();
        let observed_native = native_session_id.clone();
        if already_known {
            registry
                .record_native_session(
                    soul.clone(),
                    old.incarnation_id.clone(),
                    native_session_id.clone().unwrap(),
                )
                .await
                .unwrap();
        }
        let supervisor = crate::recovery::tests::missing_supervisor(&dir, registry.clone());
        let limits = registry
            .recovery_context(soul.clone())
            .await
            .unwrap()
            .requested_limits;
        let listener = UnixListener::bind(runtime.join("host.sock")).unwrap();
        let (pending_tx, mut pending_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let mut release_tx = Some(release_tx);
        let responder = tokio::spawn(async move {
            let boot = HostBootId::new();
            let (mut hello, _) = listener.accept().await.unwrap();
            let request: Envelope<HostCommand> = read_frame(&mut hello).await.unwrap();
            let HostCommand::Hello {
                incarnation_id,
                challenge,
            } = request.body
            else {
                panic!("expected handshake")
            };
            let mut pending_tx = Some(pending_tx);
            let mut release_rx = Some(release_rx);
            if stall_hello {
                pending_tx.take().unwrap().send(()).unwrap();
                release_rx.take().unwrap().await.unwrap();
            }
            write_frame(
                &mut hello,
                &HostReply {
                    request_id: request.request_id,
                    result: Ok(HostResult::Hello {
                        proof: host_proof(b"synthetic-secret", &challenge, &boot, &incarnation_id),
                        host_boot_id: boot.clone(),
                        capabilities: vec![],
                        effective_limits: limits,
                    }),
                },
            )
            .await
            .unwrap();
            let (mut output, _) = listener.accept().await.unwrap();
            let request: Envelope<HostCommand> = read_frame(&mut output).await.unwrap();
            assert!(matches!(
                request.body,
                HostCommand::TerminalReadOutput { .. }
            ));
            assert_eq!(
                request.auth,
                Some(host_proof(
                    b"synthetic-secret",
                    "command-auth",
                    &boot,
                    &incarnation_id,
                ))
            );
            if !stall_hello {
                pending_tx.take().unwrap().send(()).unwrap();
                release_rx.take().unwrap().await.unwrap();
            }
            write_frame(
                &mut output,
                &HostReply {
                    request_id: request.request_id,
                    result: Ok(HostResult::TerminalOutput(RuntimeOutputBatch {
                        completion: None,
                        incarnation_id: if change == "reply_incarnation" {
                            IncarnationId::new()
                        } else {
                            incarnation_id
                        },
                        terminal_id: if change == "reply_terminal" {
                            "terminal-other".into()
                        } else {
                            "terminal-old".into()
                        },
                        codex_activity: None,
                        opencode_activity: None,
                        stream_epoch: "epoch-old".into(),
                        retained_from_seq: 0,
                        head_seq: 4,
                        reset_required: false,
                        truncated: false,
                        exited: false,
                        exit_code: None,
                        native_session_id,
                        frames: vec![freshell_runtime_protocol::RuntimeOutputFrame {
                            terminal_id: "terminal-old".into(),
                            stream_epoch: "epoch-old".into(),
                            seq_start: 0,
                            seq_end: 4,
                            data: "live".into(),
                        }],
                    })),
                },
            )
            .await
            .unwrap();
        });
        let mut responder = Some(responder);
        let settling_lifecycle = supervisor.lifecycle_lock(&soul).await;
        let pending_identity_write = change.starts_with("pending_identity_");
        let settling_guard =
            if matches!(change, "settled_recovery" | "long_recovery") || pending_identity_write {
                let guard = settling_lifecycle.lock().await;
                if !pending_identity_write {
                    reserve_output_reattach(&registry, &soul).await;
                }
                Some(guard)
            } else {
                None
            };
        let mut read = {
            let supervisor = supervisor.clone();
            let soul = soul.clone();
            tokio::spawn(async move { supervisor.terminal_read_output(soul, 0, 4096, None).await })
        };
        let mut early_read = None;
        let mut read_was_responsive = false;
        let mut resolved_revisions = None;
        let mut identity_write_was_fenced = false;
        if let Some(guard) = settling_guard {
            // A temporary recovery reservation does not change ownership of
            // the last accepted terminal's read-only output.
            if change == "long_recovery" || pending_identity_write {
                release_tx.take().unwrap().send(()).unwrap();
                if let Ok(read) = tokio::time::timeout(Duration::from_millis(450), &mut read).await
                {
                    read_was_responsive = true;
                    early_read = Some(read.unwrap());
                } else if pending_identity_write {
                    identity_write_was_fenced = true;
                }
            } else {
                let _ = tokio::time::timeout(Duration::from_millis(50), &mut pending_rx).await;
            }
            if pending_identity_write {
                let conn = Connection::open(registry.database_path()).unwrap();
                match change {
                    "pending_identity_generation" => {
                        conn.execute("UPDATE incarnations SET execution_generation=execution_generation+1 WHERE incarnation_id=?1", [old.incarnation_id.as_str()]).unwrap();
                    }
                    "pending_identity_boot" => {
                        conn.execute(
                            "UPDATE incarnations SET host_boot_id=?2 WHERE incarnation_id=?1",
                            params![old.incarnation_id.as_str(), HostBootId::new().as_str()],
                        )
                        .unwrap();
                    }
                    "pending_identity_stop" => {
                        registry.begin_stop(soul.clone()).await.unwrap();
                    }
                    _ => unreachable!(),
                }
            } else {
                settle_output_reattach(&registry, &soul, &old.incarnation_id).await;
            }
            drop(guard);
        } else {
            pending_rx.await.unwrap();
        }
        let lifecycle = supervisor.lifecycle_lock(&soul).await;
        let replacement_guard =
            tokio::time::timeout(Duration::from_millis(250), lifecycle.lock()).await;
        let replacement_was_unblocked = replacement_guard.is_ok();
        if let Ok(_guard) = replacement_guard {
            if change == "settled_recovery_after_read" {
                reserve_output_reattach(&registry, &soul).await;
                release_tx.take().unwrap().send(()).unwrap();
                responder.take().unwrap().await.unwrap();
                if let Ok(read) = tokio::time::timeout(Duration::from_millis(450), &mut read).await
                {
                    read_was_responsive = true;
                    early_read = Some(read.unwrap());
                }
                settle_output_reattach(&registry, &soul, &old.incarnation_id).await;
            } else if change == "stop_intent" {
                registry.begin_stop(soul.clone()).await.unwrap();
            } else if matches!(change, "resolved_matching_root" | "resolved_other_root") {
                registry
                    .record_native_session(
                        soul.clone(),
                        old.incarnation_id.clone(),
                        if change == "resolved_matching_root" {
                            observed_native.clone().unwrap()
                        } else {
                            "ses_other".into()
                        },
                    )
                    .await
                    .unwrap();
                let resolved = registry.recovery_context(soul.clone()).await.unwrap();
                resolved_revisions = Some((resolved.identity_revision, resolved.evidence_revision));
            } else if change == "incarnation" {
                registry
                    .mark_stop_outcome(old.incarnation_id.clone(), StopOutcome::VerifiedEmpty)
                    .await
                    .unwrap();
                crate::registry::tests::materialize_test_runtime(&registry, soul.clone()).await;
            } else if change == "control_epoch" {
                Connection::open(registry.database_path())
                    .unwrap()
                    .execute("UPDATE installation SET control_epoch=control_epoch+1", [])
                    .unwrap();
            } else if matches!(change, "execution_generation" | "host_boot_id") {
                let (update, value) = if change == "execution_generation" {
                    ("execution_generation=execution_generation+1", String::new())
                } else {
                    ("host_boot_id=?2", HostBootId::new().as_str().to_string())
                };
                let conn = Connection::open(registry.database_path()).unwrap();
                let sql = format!("UPDATE incarnations SET {update} WHERE incarnation_id=?1");
                if change == "execution_generation" {
                    conn.execute(&sql, params![old.incarnation_id.as_str()])
                        .unwrap();
                } else {
                    conn.execute(&sql, params![old.incarnation_id.as_str(), value])
                        .unwrap();
                }
            } else if !matches!(
                change,
                "unchanged"
                    | "reply_incarnation"
                    | "reply_terminal"
                    | "settled_recovery"
                    | "long_recovery"
                    | "pending_identity_generation"
                    | "pending_identity_boot"
                    | "pending_identity_stop"
            ) {
                let update = match change {
                    "intent_revision" => "intent_revision=intent_revision+1",
                    "identity_revision" => "identity_revision=identity_revision+1",
                    "evidence_revision" => "evidence_revision=evidence_revision+1",
                    "native_import_revision" => "native_import_revision=native_import_revision+1",
                    "recovery_attempt_id" => "recovery_attempt_id='recovery-other'",
                    _ => panic!("unknown fixture mutation"),
                };
                Connection::open(registry.database_path())
                    .unwrap()
                    .execute(
                        &format!("UPDATE souls SET {update} WHERE soul_id=?1"),
                        params![soul.as_str()],
                    )
                    .unwrap();
            }
        }
        if let Some(release) = release_tx {
            release.send(()).unwrap();
        }
        let result = match early_read {
            Some(result) => result,
            None => tokio::time::timeout(Duration::from_secs(5), read)
                .await
                .unwrap()
                .unwrap(),
        };
        if let Some(responder) = responder {
            responder.await.unwrap();
        }
        assert!(
            replacement_was_unblocked,
            "read-only host IO must not retain lifecycle custody (hello={stall_hello})"
        );
        if pending_identity_write {
            assert!(
                identity_write_was_fenced,
                "a new native identity must wait for lifecycle write authority"
            );
        }
        let read_accepted = matches!(
            change,
            "unchanged"
                | "settled_recovery"
                | "settled_recovery_after_read"
                | "long_recovery"
                | "resolved_matching_root"
        ) || ((observed_native.is_none() || already_known)
            && matches!(
                change,
                "control_epoch"
                    | "evidence_revision"
                    | "native_import_revision"
                    | "recovery_attempt_id"
            ));
        if read_accepted {
            let output = result.unwrap();
            assert_eq!(output.incarnation_id, old.incarnation_id);
            assert_eq!(output.stream_epoch, "epoch-old");
            assert_eq!(output.head_seq, 4);
            assert_eq!(output.frames.len(), 1);
            assert_eq!(output.frames[0].data, "live");
            assert_eq!(output.frames[0].seq_end, 4);
        } else {
            assert_eq!(
                result.unwrap_err().code,
                RuntimeErrorCode::OwnershipMismatch,
                "changed {change} output must be refused after actual host IPC"
            );
        }
        let current = registry.recovery_context(soul).await.unwrap();
        assert_eq!(
            current.native_session_id,
            if change == "resolved_other_root" {
                Some("ses_other".into())
            } else if already_known || read_accepted {
                observed_native
            } else {
                None
            },
            "only a current, fully fenced observation may publish a new native root"
        );
        if let Some(revisions) = resolved_revisions {
            assert_eq!(
                (current.identity_revision, current.evidence_revision),
                revisions,
                "reading an independently resolved root must not rewrite its evidence"
            );
        }
        if matches!(change, "long_recovery" | "settled_recovery_after_read") {
            assert!(
                read_was_responsive,
                "ready accepted output must not wait behind recovery past the replay budget"
            );
        }
    }

    async fn reserve_output_reattach(registry: &Registry, soul: &SoulId) {
        let before = registry.recovery_context(soul.clone()).await.unwrap();
        let retry = registry
            .reserve_due_recovery_retry(soul.clone(), before.intent_revision, 0)
            .await
            .unwrap()
            .unwrap();
        assert!(retry.reserved_attempt_id.is_some());
    }

    async fn settle_output_reattach(
        registry: &Registry,
        soul: &SoulId,
        incarnation: &IncarnationId,
    ) {
        let context = registry.recovery_context(soul.clone()).await.unwrap();
        assert!(context.recovery_attempt_id.is_some());
        registry
            .mark_recovery_live(soul.clone(), incarnation.clone(), context.write_fence())
            .await
            .unwrap();
        let settled = registry.recovery_context(soul.clone()).await.unwrap();
        assert!(settled.recovery_attempt_id.is_none());
        assert_eq!(settled.prior_handle.incarnation_id(), incarnation);
    }

    #[tokio::test]
    async fn delayed_terminal_ipc_cannot_reverse_identity_or_bind_an_old_incarnation() {
        for replace_incarnation in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let registry = Registry::open(dir.path().join("registry"), None).unwrap();
            let soul = SoulId::new();
            let prepared =
                crate::registry::tests::materialize_test_runtime(&registry, soul.clone()).await;
            let runtime = dir
                .path()
                .join("runtime")
                .join(prepared.incarnation_id.as_str());
            std::fs::create_dir_all(&runtime).unwrap();
            std::fs::write(runtime.join("secret"), b"synthetic-secret").unwrap();
            let conn = Connection::open(dir.path().join("registry/runtime.sqlite3")).unwrap();
            conn.execute(
                "UPDATE incarnations SET runtime_dir=?1,terminal_spec=?2 WHERE incarnation_id=?3",
                params![runtime.to_string_lossy(), serde_json::json!({
                    "terminalId":"terminal", "streamId":"stream", "mode":"shell", "program":"/bin/sh",
                    "cwd":"/synthetic", "runAsUid":65534, "runAsGid":0, "cols":80, "rows":24,
                    "projectKey":"synthetic", "workspacePath":"/synthetic"
                }).to_string(), prepared.incarnation_id.as_str()],
            )
            .unwrap();
            if !replace_incarnation {
                let terminal: TerminalLaunchSpec = serde_json::from_value(serde_json::json!({
                    "terminalId":"terminal", "streamId":"stream", "mode":"opencode", "program":"opencode",
                    "cwd":"/synthetic", "runAsUid":65534, "runAsGid":0, "cols":80, "rows":24,
                    "projectKey":"synthetic", "workspacePath":"/synthetic"
                })).unwrap();
                conn.execute(
                    "UPDATE souls SET provider='opencode' WHERE soul_id=?1",
                    params![soul.as_str()],
                )
                .unwrap();
                conn.execute(
                    "UPDATE incarnations SET terminal_spec=?1 WHERE incarnation_id=?2",
                    params![
                        serde_json::to_string(&terminal).unwrap(),
                        prepared.incarnation_id.as_str()
                    ],
                )
                .unwrap();
                registry
                    .record_native_session(
                        soul.clone(),
                        prepared.incarnation_id.clone(),
                        "ses_A".into(),
                    )
                    .await
                    .unwrap();
            }
            let supervisor = crate::recovery::tests::missing_supervisor(&dir, registry.clone());
            let listener = UnixListener::bind(runtime.join("host.sock")).unwrap();
            let source = registry.recovery_context(soul.clone()).await.unwrap();
            let responder = {
                let registry = registry.clone();
                let soul = soul.clone();
                tokio::spawn(async move {
                    let (mut hello, _) = listener.accept().await.unwrap();
                    let request: Envelope<HostCommand> = read_frame(&mut hello).await.unwrap();
                    let HostCommand::Hello {
                        incarnation_id,
                        challenge,
                    } = request.body
                    else {
                        panic!("expected handshake")
                    };
                    let boot = HostBootId::new();
                    write_frame(
                        &mut hello,
                        &HostReply {
                            request_id: request.request_id,
                            result: Ok(HostResult::Hello {
                                proof: host_proof(
                                    b"synthetic-secret",
                                    &challenge,
                                    &boot,
                                    &incarnation_id,
                                ),
                                host_boot_id: boot,
                                capabilities: vec![],
                                effective_limits: source.requested_limits,
                            }),
                        },
                    )
                    .await
                    .unwrap();
                    let (mut output, _) = listener.accept().await.unwrap();
                    let request: Envelope<HostCommand> = read_frame(&mut output).await.unwrap();
                    assert!(matches!(
                        request.body,
                        HostCommand::TerminalReadOutput { .. }
                    ));
                    if replace_incarnation {
                        registry
                            .mark_stop_outcome(incarnation_id.clone(), StopOutcome::VerifiedEmpty)
                            .await
                            .unwrap();
                        crate::registry::tests::materialize_test_runtime(&registry, soul.clone())
                            .await;
                    } else {
                        registry
                            .transition_native_session_fenced(
                                soul,
                                incarnation_id.clone(),
                                "ses_A",
                                "ses_B",
                                source.write_fence(),
                            )
                            .await
                            .unwrap();
                    }
                    write_frame(
                        &mut output,
                        &HostReply {
                            request_id: request.request_id,
                            result: Ok(HostResult::TerminalOutput(RuntimeOutputBatch {
                                completion: None,
                                incarnation_id,
                                terminal_id: "terminal".into(),
                                codex_activity: None,
                                opencode_activity: None,
                                stream_epoch: "epoch".into(),
                                retained_from_seq: 0,
                                head_seq: 0,
                                reset_required: false,
                                truncated: false,
                                exited: false,
                                exit_code: None,
                                native_session_id: Some("ses_A".into()),
                                frames: vec![],
                            })),
                        },
                    )
                    .await
                    .unwrap();
                })
            };
            let mut request = Envelope::new(
                RequestId::new(),
                ControlRole::Web,
                AdminCommand::TerminalReadOutput(
                    freshell_runtime_protocol::TerminalReadOutputRequest {
                        soul_id: soul.clone(),
                        after_seq: 0,
                        max_bytes: 4096,
                        expected_stream_epoch: None,
                        expected_control_epoch: None,
                    },
                ),
            );
            request.auth = Some(supervisor.config.control_secret.clone());
            let result = tokio::time::timeout(Duration::from_secs(5), supervisor.dispatch(request))
                .await
                .unwrap();
            responder.await.unwrap();
            assert!(
                result.result.is_err(),
                "a late response must retain its pre-IPC fence"
            );
            let current = registry.recovery_context(soul).await.unwrap();
            if replace_incarnation {
                assert_ne!(
                    current.prior_handle.incarnation_id(),
                    &prepared.incarnation_id
                );
                assert_eq!(current.native_session_id, None);
            } else {
                assert_eq!(current.native_session_id.as_deref(), Some("ses_B"));
            }
        }
    }
    #[tokio::test]
    async fn unreachable_legacy_host_with_exact_recorded_root_requires_compatibility_without_saved_recipe(
    ) {
        use freshell_runtime_protocol::{RecoveryBlockReason, RecoveryProbe};
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path().join("registry"), None).unwrap();
        let soul = SoulId::new();
        let launch =
            crate::registry::tests::materialize_test_runtime(&registry, soul.clone()).await;
        let runtime = dir.path().join("unreachable-host");
        std::fs::create_dir(&runtime).unwrap();
        std::fs::write(runtime.join("secret"), b"synthetic-secret").unwrap();
        let conn = Connection::open(dir.path().join("registry/runtime.sqlite3")).unwrap();
        conn.execute("UPDATE souls SET provider='opencode',native_session_id='ses_legacy_exact' WHERE soul_id=?1",params![soul.as_str()]).unwrap();
        conn.execute(
            "UPDATE incarnations SET runtime_dir=?1,fixture_kind=NULL WHERE incarnation_id=?2",
            params![runtime.to_string_lossy(), launch.incarnation_id.as_str()],
        )
        .unwrap();
        let supervisor = crate::recovery::tests::supervisor_with_runtime_state(
            &dir,
            registry.clone(),
            crate::backend::BackendRuntimeState::Running,
        );
        assert!(registry
            .recovery_context(soul.clone())
            .await
            .unwrap()
            .resume_spec
            .is_none());
        let probe = supervisor.probe_recovery(soul.clone()).await.unwrap();
        // Without any terminal adapter this remains blocked; host reachability
        // must not bypass current-image compatibility or authorize a new root.
        assert!(
            matches!(
                probe,
                RecoveryProbe::Blocked {
                    reason: RecoveryBlockReason::ImplementationUnavailable,
                    ..
                }
            ),
            "{probe:?}"
        );
        assert_eq!(
            registry
                .recovery_context(soul)
                .await
                .unwrap()
                .native_session_id
                .as_deref(),
            Some("ses_legacy_exact")
        );
        assert!(std::fs::read_to_string(dir.path().join("lifecycle.jsonl"))
            .unwrap()
            .contains("retained_host_unreachable"));
    }

    #[tokio::test]
    async fn capability_unknown_retained_host_cannot_publish_status_identity_or_reattach() {
        use freshell_runtime_protocol::{RecoveryBlockReason, RecoveryProbe};
        for capabilities in [
            vec![],
            vec!["owned-provider-config-v1".into()],
            vec!["provider-store-probe-v1".into()],
        ] {
            let dir = tempfile::tempdir().unwrap();
            let registry = Registry::open(dir.path().join("registry"), None).unwrap();
            let soul = SoulId::new();
            let launch =
                crate::registry::tests::materialize_test_runtime(&registry, soul.clone()).await;
            let runtime = dir.path().join("host");
            std::fs::create_dir(&runtime).unwrap();
            std::fs::write(runtime.join("secret"), b"synthetic-secret").unwrap();
            let conn = Connection::open(dir.path().join("registry/runtime.sqlite3")).unwrap();
            conn.execute(
                "UPDATE souls SET provider='opencode' WHERE soul_id=?1",
                params![soul.as_str()],
            )
            .unwrap();
            conn.execute(
                "UPDATE incarnations SET runtime_dir=?1,fixture_kind=NULL WHERE incarnation_id=?2",
                params![runtime.to_string_lossy(), launch.incarnation_id.as_str()],
            )
            .unwrap();
            let supervisor = crate::recovery::tests::supervisor_with_runtime_state(
                &dir,
                registry.clone(),
                crate::backend::BackendRuntimeState::Running,
            );
            let listener = UnixListener::bind(runtime.join("host.sock")).unwrap();
            let requested_limits = registry
                .recovery_context(soul.clone())
                .await
                .unwrap()
                .requested_limits;
            let responder = tokio::spawn(async move {
                let boot = HostBootId::new();
                loop {
                    let Ok(Ok((mut socket, _))) =
                        tokio::time::timeout(Duration::from_secs(1), listener.accept()).await
                    else {
                        break;
                    };
                    let request: Envelope<HostCommand> = read_frame(&mut socket).await.unwrap();
                    let result = match request.body {
                        HostCommand::Hello {
                            incarnation_id,
                            challenge,
                        } => HostResult::Hello {
                            proof: host_proof(
                                b"synthetic-secret",
                                &challenge,
                                &boot,
                                &incarnation_id,
                            ),
                            host_boot_id: boot.clone(),
                            capabilities: capabilities.clone(),
                            effective_limits: requested_limits,
                        },
                        HostCommand::Status { .. } => HostResult::Status {
                            native_identity_observation: None,
                            host_boot_id: boot.clone(),
                            worker_pid: Some(123),
                            worker_launch_count: 1,
                            max_control_epoch: 1,
                            max_execution_generation: 1,
                            fixture_evidence: serde_json::json!({}),
                            exited: false,
                            native_session_id: Some("ses_unqualified_status".into()),
                            opencode_transfer_receipt: None,
                            opencode_adoption: Default::default(),
                        },
                        HostCommand::ProbeRecovery { .. } => {
                            HostResult::RecoveryProbe(crate::recovery::tests::absent_native_probe())
                        }
                        _ => panic!("unexpected host command"),
                    };
                    write_frame(
                        &mut socket,
                        &HostReply {
                            request_id: request.request_id,
                            result: Ok(result),
                        },
                    )
                    .await
                    .unwrap();
                }
            });
            let probe = supervisor.probe_recovery(soul.clone()).await.unwrap();
            responder.await.unwrap();
            let preserved = registry.recovery_context(soul).await.unwrap();
            assert_eq!(
                preserved.native_session_id, None,
                "unknown feature semantics cannot certify status identity"
            );
            assert!(
                matches!(
                    probe,
                    RecoveryProbe::Blocked {
                        reason: RecoveryBlockReason::CapabilityPending,
                        ..
                    }
                ),
                "{probe:?}"
            );
            assert_eq!(
                preserved.prior_handle.incarnation_id(),
                &launch.incarnation_id
            );
        }
    }

    #[tokio::test]
    async fn status_id_prevents_seed_and_late_probe_cannot_authorize_reattach() {
        run_status_probe_fence_test().await;
    }

    async fn run_status_probe_fence_test() {
        use freshell_runtime_protocol::{
            RecoverRequest, RecoveryPath, RecoveryProbe, RecoveryTrigger,
        };

        // These IPC deadlines measure this registry's host exchange, not
        // process-wide incident logging held by a different test registry.
        if run_native_observation_test_child(
            "service::native_observation_ipc_tests::status_id_prevents_seed_and_late_probe_cannot_authorize_reattach",
        )
        .await
        {
            return;
        }
        for delayed_reattach in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let registry = Registry::open(dir.path().join("registry"), None).unwrap();
            let soul = SoulId::new();
            let launch =
                crate::registry::tests::materialize_test_runtime(&registry, soul.clone()).await;
            let runtime = dir.path().join("host");
            std::fs::create_dir(&runtime).unwrap();
            std::fs::write(runtime.join("secret"), b"synthetic-secret").unwrap();
            let db_path = dir.path().join("registry/runtime.sqlite3");
            let conn = Connection::open(&db_path).unwrap();
            conn.execute(
                "UPDATE souls SET provider='native-session-fixture' WHERE soul_id=?1",
                params![soul.as_str()],
            )
            .unwrap();
            conn.execute("UPDATE incarnations SET runtime_dir=?1,fixture_kind='native_session' WHERE incarnation_id=?2", params![runtime.to_string_lossy(), launch.incarnation_id.as_str()]).unwrap();
            drop(conn);
            let supervisor = crate::recovery::tests::supervisor_with_runtime_state(
                &dir,
                registry.clone(),
                crate::backend::BackendRuntimeState::Running,
            );
            let listener = UnixListener::bind(runtime.join("host.sock")).unwrap();
            let captured = registry.recovery_context(soul.clone()).await.unwrap();
            assert!(captured.never_dispatched);
            let initial_import_revision = captured.native_import_revision;
            let expected_incarnation = launch.incarnation_id.clone();
            let provider_home = dir.path().join("inspected-provider-home");
            std::fs::create_dir(&provider_home).unwrap();
            let (pending_tx, pending_rx) = tokio::sync::oneshot::channel();
            let (release_tx, release_rx) = tokio::sync::oneshot::channel();
            let responder = tokio::spawn(async move {
                let boot = HostBootId::new();
                let mut pending_tx = Some(pending_tx);
                let mut release_rx = Some(release_rx);
                for step in 0..3 {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let request: Envelope<HostCommand> = read_frame(&mut socket).await.unwrap();
                    assert_eq!(request.role, ControlRole::Supervisor);
                    assert_eq!(request.protocol_version, CONTROL_PROTOCOL_VERSION);
                    if step > 0 {
                        assert_eq!(
                            request.auth,
                            Some(host_proof(
                                b"synthetic-secret",
                                "command-auth",
                                &boot,
                                &expected_incarnation,
                            ))
                        );
                    }
                    let result = match request.body {
                        HostCommand::Hello {
                            incarnation_id,
                            challenge,
                        } if step == 0 => {
                            assert_eq!(incarnation_id, expected_incarnation);
                            HostResult::Hello {
                                proof: host_proof(
                                    b"synthetic-secret",
                                    &challenge,
                                    &boot,
                                    &incarnation_id,
                                ),
                                host_boot_id: boot.clone(),
                                capabilities: vec![],
                                effective_limits: captured.requested_limits,
                            }
                        }
                        HostCommand::Status { incarnation_id } if step == 1 => {
                            assert_eq!(incarnation_id, expected_incarnation);
                            HostResult::Status {
                                native_identity_observation: None,
                                host_boot_id: boot.clone(),
                                worker_pid: Some(123),
                                worker_launch_count: 1,
                                max_control_epoch: 1,
                                max_execution_generation: 1,
                                fixture_evidence: serde_json::json!({}),
                                exited: !delayed_reattach,
                                native_session_id: Some("ses_from_status".into()),
                                opencode_transfer_receipt: None,
                                opencode_adoption: Default::default(),
                            }
                        }
                        HostCommand::ProbeRecovery {
                            incarnation_id,
                            resume_spec,
                            creation_seed_ref,
                            never_dispatched,
                            run_as_uid,
                            run_as_gid,
                        } if step == 2 => {
                            assert_eq!(incarnation_id, expected_incarnation);
                            assert_eq!(creation_seed_ref, captured.creation_seed_ref);
                            assert_eq!(never_dispatched, captured.never_dispatched);
                            assert_eq!((run_as_uid, run_as_gid), (0, 0));
                            let native = resume_spec.expect("status identity must bind the probe");
                            assert_eq!(native.provider_session.provider, captured.provider);
                            assert_eq!(
                                native.provider_session.provider_store_id,
                                captured.provider_store_id
                            );
                            assert_eq!(
                                native.provider_session.native_session_id,
                                "ses_from_status"
                            );
                            pending_tx.take().unwrap().send(()).unwrap();
                            release_rx.take().unwrap().await.unwrap();
                            let freshell_agent_runtime::ProviderStoreProbe::DefinitivelyUnavailable {
                                reason,
                                evidence,
                                store_state,
                                negative_paths,
                            } = freshell_agent_runtime::probe_provider_store(&provider_home, &native)
                            else {
                                panic!("the owned empty fixture store must be definitively inspected")
                            };
                            HostResult::RecoveryProbe(RecoveryProbe::DefinitivelyUnavailable {
                                path: RecoveryPath::NativeResume,
                                reason,
                                evidence,
                                store_state,
                                negative_paths,
                            })
                        }
                        _ => panic!("unexpected recovery protocol step"),
                    };
                    write_frame(
                        &mut socket,
                        &HostReply {
                            request_id: request.request_id,
                            result: Ok(result),
                        },
                    )
                    .await
                    .unwrap();
                }
            });
            let operation = {
                let supervisor = supervisor.clone();
                let soul = soul.clone();
                tokio::spawn(async move {
                    if delayed_reattach {
                        let result = tokio::time::timeout(
                            Duration::from_secs(5),
                            supervisor.recover(RecoverRequest {
                                soul_id: soul.clone(),
                                trigger: RecoveryTrigger::ProviderExit,
                                expected_intent_revision: None,
                                expected_control_epoch: None,
                            }),
                        )
                        .await
                        .unwrap();
                        let error = result.expect_err(
                            "late probe cannot reattach using newer registry revisions",
                        );
                        assert_eq!(error.code, RuntimeErrorCode::RegistryFailure);
                        assert!(error.message.contains("stale recovery write fence"));
                    } else {
                        let result = tokio::time::timeout(
                            Duration::from_secs(5),
                            supervisor.probe_recovery(soul),
                        )
                        .await
                        .unwrap()
                        .unwrap();
                        assert!(
                            matches!(
                                result,
                                RecoveryProbe::DefinitivelyUnavailable {
                                    path: RecoveryPath::NativeResume,
                                    ..
                                }
                            ),
                            "status materialization must defeat stale seed readiness: {result:?}"
                        );
                    }
                })
            };
            tokio::time::timeout(Duration::from_secs(5), pending_rx)
                .await
                .expect("host must receive the native-store probe")
                .unwrap();
            let pending = registry.recovery_context(soul.clone()).await.unwrap();
            assert_eq!(
                pending.native_session_id.as_deref(),
                Some("ses_from_status")
            );
            assert_eq!(pending.native_import_revision, initial_import_revision);
            assert!(!pending.never_dispatched);
            assert!(
                !operation.is_finished(),
                "the probe response is still withheld"
            );
            if delayed_reattach {
                let soul = soul.clone();
                registry
                    .run_blocking(move |conn| {
                        assert_eq!(
                            conn.execute(
                                "UPDATE souls SET native_import_revision=native_import_revision+1,recovery_state='blocked' WHERE soul_id=?1",
                                params![soul.as_str()],
                            )?,
                            1
                        );
                        Ok(())
                    })
                    .await
                    .unwrap();
            }
            release_tx.send(()).unwrap();
            operation.await.unwrap();
            responder.await.unwrap();
            if delayed_reattach {
                let current = registry.recovery_context(soul.clone()).await.unwrap();
                assert_eq!(
                    current.recovery_state,
                    freshell_runtime_protocol::RecoveryState::Blocked
                );
                assert_eq!(current.native_import_revision, initial_import_revision + 1);
                assert_eq!(
                    current.prior_handle.incarnation_id(),
                    &launch.incarnation_id
                );
            }
            assert_eq!(
                registry
                    .recovery_context(soul)
                    .await
                    .unwrap()
                    .native_session_id
                    .as_deref(),
                Some("ses_from_status")
            );
        }
    }
}

#[cfg(test)]
mod backend_create_current_main_tests {
    use super::*;
    use freshell_runtime_protocol::LaunchNonce;
    #[test]
    fn backend_create_failure_records_bounded_redacted_backend_cause() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("backend-create-failure.jsonl");
        let process_secret = "supervisor-control-secret";
        let host_binary_path = dir.path().join("synthetic-host");
        std::fs::write(&host_binary_path, "synthetic-host-artifact").unwrap();
        let supervisor = super::Supervisor::new(
            crate::registry::Registry::open(dir.path().join("registry"), None).unwrap(),
            super::default_backend(dir.path().join("absent-docker.sock"), log.clone()),
            super::SupervisorConfig {
                runtime_root: dir.path().join("runtime"),
                control_socket_path: dir.path().join("control.sock"),
                host_binary_path,
                image_ref: format!("sha256:{}", "a".repeat(64)),
                test_run_id: "backend-failure-diagnostic".into(),
                control_secret: process_secret.into(),
                lifecycle_log: log.clone(),
                admission: crate::admission::AdmissionPolicy::default(),
            },
        )
        .unwrap();
        let prepared = PreparedLaunch {
            soul_id: SoulId::new(),
            incarnation_id: IncarnationId::new(),
            launch_nonce: LaunchNonce::new(),
            state: LaunchState::Prepared,
            intent_revision: 3,
            existing_request: false,
        };
        let provider_secret = "sk-abcdefghijklmnopqrstuvwx";
        let backend_error = BackendError::DockerHttp {
            status: 400,
            body: format!(
                r#"{{"message":"invalid mount config {process_secret}","token":"{provider_secret}","detail":"{}"}}"#,
                "x".repeat(700),
            ),
        };
        let error = supervisor.activation_failure_from_backend(
            &prepared,
            LaunchState::Prepared,
            "create_stopped_runtime",
            backend_error,
        );
        assert_eq!(error.code, RuntimeErrorCode::RecoveryBlocked);

        let contents = std::fs::read_to_string(&log).unwrap();
        assert!(!contents.contains(process_secret));
        assert!(!contents.contains(provider_secret));
        let event: serde_json::Value = serde_json::from_str(contents.trim()).unwrap();
        assert_eq!(event["data"]["stage"], "create_stopped_runtime");
        assert_eq!(event["data"]["backendFailure"]["kind"], "docker_http");
        assert_eq!(event["data"]["backendFailure"]["httpStatus"], 400);
        let detail = event["data"]["backendFailure"]["detail"].as_str().unwrap();
        assert!(detail.contains("invalid mount config"));
        assert!(detail.contains("***REDACTED***"));
        assert!(detail.chars().count() <= 512);
        assert_eq!(event["data"]["backendFailure"]["detailTruncated"], true);
    }
}

#[cfg(test)]
mod control_connection_tests {
    use super::{default_backend, serve_control_connection, Supervisor, SupervisorConfig};
    use crate::registry::Registry;
    use freshell_runtime_protocol::{
        read_frame, AdminCommand, AdminReply, AdminResult, ControlRole, Envelope, RequestId,
        RuntimeErrorCode,
    };
    use std::path::{Path, PathBuf};
    use std::pin::Pin;
    use std::sync::{Arc, Mutex as StdMutex};
    use std::task::{Context, Poll};
    use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, DuplexStream, ReadBuf};

    /// What a cold open of the registry returned when the reply was written.
    type ReopenAtReply = Arc<StdMutex<Option<Result<(), String>>>>;

    /// The supervisor end of a control connection. When the reply starts to
    /// go out, it cold-opens the registry, as a successor would once the
    /// client holds its answer, and records whether that open was refused.
    struct ReopenOnReply {
        stream: DuplexStream,
        registry_root: PathBuf,
        reopened: ReopenAtReply,
    }

    impl AsyncRead for ReopenOnReply {
        fn poll_read(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            Pin::new(&mut self.stream).poll_read(cx, buf)
        }
    }

    impl AsyncWrite for ReopenOnReply {
        fn poll_write(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            let mut reopened = self.reopened.lock().unwrap();
            if reopened.is_none() {
                *reopened = Some(
                    Registry::open(&self.registry_root, None)
                        .map(drop)
                        .map_err(|error| format!("{error:?}")),
                );
            }
            drop(reopened);
            Pin::new(&mut self.stream).poll_write(cx, buf)
        }

        fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Pin::new(&mut self.stream).poll_flush(cx)
        }

        fn poll_shutdown(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
        ) -> Poll<std::io::Result<()>> {
            Pin::new(&mut self.stream).poll_shutdown(cx)
        }
    }

    fn supervisor(root: &Path, registry_root: &Path) -> Supervisor {
        let host_binary_path = root.join("synthetic-host");
        std::fs::write(&host_binary_path, "synthetic-host-artifact").unwrap();
        Supervisor::new(
            Registry::open(registry_root, None).unwrap(),
            default_backend(
                root.join("absent-docker.sock"),
                root.join("lifecycle.jsonl"),
            ),
            SupervisorConfig {
                runtime_root: root.join("runtime"),
                control_socket_path: root.join("control.sock"),
                host_binary_path,
                image_ref: format!("sha256:{}", "a".repeat(64)),
                test_run_id: "control-connection".into(),
                control_secret: "synthetic-control-secret".into(),
                lifecycle_log: root.join("lifecycle.jsonl"),
                admission: crate::admission::AdmissionPolicy::default(),
            },
        )
        .unwrap()
    }

    /// A control client that has read its reply may hand the registry to a
    /// successor at once: the connection that answered it must already have
    /// let go of the supervisor, and with it the registry ownership, before
    /// the reply went out. Otherwise the successor's open is refused as Busy
    /// whenever the connection's worker is descheduled between writing the
    /// reply and finishing.
    #[tokio::test]
    async fn control_connection_releases_supervisor_before_it_replies() {
        let valid_request = || {
            let mut envelope =
                Envelope::new(RequestId::new(), ControlRole::Web, AdminCommand::Health);
            envelope.auth = Some("synthetic-control-secret".into());
            serde_json::to_vec(&envelope).unwrap()
        };
        for (request, answered) in [
            (valid_request(), true),
            (b"not a control envelope".to_vec(), false),
        ] {
            let temp = tempfile::tempdir().unwrap();
            let registry_root = temp.path().join("registry");
            // The connection holds the only handle to this supervisor.
            let supervisor = supervisor(temp.path(), &registry_root);
            let (mut client, server) = tokio::io::duplex(64 * 1024);
            let reopened = ReopenAtReply::default();
            let connection = tokio::spawn(serve_control_connection(
                supervisor,
                ReopenOnReply {
                    stream: server,
                    registry_root: registry_root.clone(),
                    reopened: reopened.clone(),
                },
            ));

            client
                .write_all(&(request.len() as u32).to_be_bytes())
                .await
                .unwrap();
            client.write_all(&request).await.unwrap();
            let reply: AdminReply = read_frame(&mut client).await.unwrap();
            if answered {
                assert!(
                    matches!(reply.result, Ok(AdminResult::Health { .. })),
                    "the supervisor answers a valid request"
                );
            } else {
                assert_eq!(
                    reply.result.unwrap_err().code,
                    RuntimeErrorCode::InvalidRequest
                );
            }
            connection.await.unwrap();

            assert_eq!(
                reopened.lock().unwrap().take(),
                Some(Ok(())),
                "the registry must be free for a successor by the time the reply is written"
            );
        }
    }
}

#[cfg(test)]
#[path = "native_clear_service_tests.rs"]
mod native_clear_service_tests;

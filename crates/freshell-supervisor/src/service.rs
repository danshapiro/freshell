use crate::{
    admission::AdmissionPolicy,
    backend::{BackendError, CreateRuntimeSpec, DockerEngineBackend, RuntimeBackend},
    registry::{
        stable_provider_volume_name, BackendCreatedRecord, ExecutionGrantRecord,
        InputJournalDisposition, LaunchPreparation, PreparedLaunch, Registry, RegistryError,
    },
};
use freshell_runtime_protocol::{
    host_proof, read_frame, write_frame, AdminCommand, AdminReply, AdminResult, CommandState,
    ControlRole, Envelope, FixtureKind, HostBootId, HostCommand, HostReply, HostResult,
    IncarnationId, LaunchResult, LaunchState, LimitApplication, RequestId, ResumeSpec,
    RuntimeError, RuntimeErrorCode, RuntimeLimits, RuntimeMetrics, RuntimeOutputBatch, RuntimeView,
    SoulId, StopOutcome, TerminalLaunchSpec, UpdateLimitsResult, CONTROL_PROTOCOL_VERSION,
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex as StdMutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::{
    net::{UnixListener, UnixStream},
    sync::Mutex,
    time::{sleep, Duration, Instant},
};

#[derive(Clone)]
pub struct SupervisorConfig {
    pub runtime_root: PathBuf,
    pub host_binary_path: PathBuf,
    pub image_ref: String,
    pub test_run_id: String,
    pub control_secret: String,
    pub lifecycle_log: PathBuf,
    pub admission: AdmissionPolicy,
}

#[derive(Clone)]
pub struct Supervisor {
    pub(crate) registry: Registry,
    pub(crate) backend: Arc<dyn RuntimeBackend>,
    pub(crate) config: Arc<SupervisorConfig>,
    /// Recovery and input dispatch serialize per soul, while unrelated souls
    /// remain independently recoverable. Stop intentionally does not take this
    /// lock: its durable intent revision must be able to preempt recovery.
    pub(crate) recovery_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
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
        lifecycle_secrets()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(config.lifecycle_log.clone(), config.control_secret.clone());
        Ok(Self {
            registry,
            backend,
            config: Arc::new(config),
            recovery_locks: Arc::new(Mutex::new(HashMap::new())),
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

    pub async fn dispatch(&self, envelope: Envelope<AdminCommand>) -> AdminReply {
        let request_id = envelope.request_id.clone();
        let result = self.dispatch_inner(envelope).await;
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
            AdminCommand::Health => Ok(AdminResult::Health {
                control_epoch: self.registry.control_epoch(),
                installation_id: self.registry.installation_id().clone(),
            }),
            AdminCommand::Inventory => Ok(AdminResult::Inventory(
                self.registry.inventory().await.map_err(map_registry)?,
            )),
            AdminCommand::InventorySnapshot => Ok(AdminResult::InventorySnapshot(
                self.registry
                    .inventory_snapshot()
                    .await
                    .map_err(map_registry)?,
            )),
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
                    .terminal_read_output(request.soul_id, request.after_seq, request.max_bytes)
                    .await?;
                Ok(AdminResult::TerminalOutput(output))
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
            AdminCommand::Recover(request) => {
                self.registry
                    .assert_epoch(request.expected_control_epoch)
                    .map_err(map_registry)?;
                self.recover(request).await.map(AdminResult::Recovery)
            }
        }
    }

    async fn launch(
        &self,
        request_id: RequestId,
        request: freshell_runtime_protocol::LaunchRequest,
    ) -> Result<LaunchResult, RuntimeError> {
        let limits = request.limits.validate()?;
        request.validate_workload()?;
        if !release_qualified_workload(
            &request.provider,
            request.fixture.is_some(),
            request.terminal.is_some(),
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
        let prepared = self
            .registry
            .prepare_launch(LaunchPreparation {
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
                view_intent: request.view_intent.clone(),
                admission: self.config.admission,
            })
            .await
            .map_err(map_registry)?;
        append_event(
            &self.config.lifecycle_log,
            "supervisor.launch_prepared",
            serde_json::json!({"soulId":prepared.soul_id,"incarnationId":prepared.incarnation_id,"existingRequest":prepared.existing_request,"state":prepared.state}),
        );
        crash_if("after_prepare");

        self.activate_prepared(
            prepared,
            request.soul_id,
            request.fixture,
            request.terminal,
            None,
            limits,
        )
        .await
    }

    pub(crate) async fn activate_prepared(
        &self,
        prepared: PreparedLaunch,
        soul_id: SoulId,
        fixture: Option<FixtureKind>,
        terminal: Option<TerminalLaunchSpec>,
        resume_spec: Option<ResumeSpec>,
        limits: RuntimeLimits,
    ) -> Result<LaunchResult, RuntimeError> {
        let mut state = prepared.state;
        if state == LaunchState::Prepared {
            let runtime_dir = self.ensure_incarnation_dir(&prepared).map_err(|error| {
                self.activation_failure(&prepared, state, "ensure_runtime_directory", error)
            })?;
            let created = self
                .backend
                .create_stopped(&CreateRuntimeSpec {
                    installation_id: self.registry.installation_id().clone(),
                    soul_id: prepared.soul_id.clone(),
                    incarnation_id: prepared.incarnation_id.clone(),
                    image_ref: self.config.image_ref.clone(),
                    host_binary_path: self.config.host_binary_path.clone(),
                    runtime_dir: runtime_dir.clone(),
                    limits,
                    test_run_id: self.config.test_run_id.clone(),
                    terminal: terminal.clone(),
                    provider_volume_name: stable_provider_volume_name(
                        self.registry.installation_id(),
                        &prepared.soul_id,
                    ),
                })
                .await
                .map_err(map_backend)
                .map_err(|error| {
                    self.activation_failure(&prepared, state, "create_stopped_runtime", error)
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
            return self
                .launch_result_from_status(
                    prepared.incarnation_id.clone(),
                    soul_id,
                    authenticated,
                    status,
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
        let accepted = self
            .send_grant(
                &handle,
                soul_id.clone(),
                fixture,
                terminal,
                resume_spec,
                &authenticated,
                &grant,
            )
            .await
            .map_err(|error| {
                self.activation_failure(&prepared, state, "deliver_execution_grant", error)
            })?;
        crash_if("after_grant_delivery");
        self.registry
            .mark_running(handle.incarnation_id().clone())
            .await
            .map_err(map_registry)
            .map_err(|error| {
                self.activation_failure(&prepared, state, "commit_running_state", error)
            })?;
        append_event(
            &self.config.lifecycle_log,
            "supervisor.launch_running",
            serde_json::json!({"soulId":soul_id,"incarnationId":handle.incarnation_id(),"containerId":handle.container_id(),"workerPid":accepted.worker_pid,"workerLaunchCount":accepted.worker_launch_count}),
        );
        let view = find_view(&self.registry, handle.incarnation_id())
            .await
            .map_err(|error| {
                self.activation_failure(&prepared, state, "load_running_view", error)
            })?;
        Ok(LaunchResult {
            view,
            worker_pid: accepted.worker_pid,
            worker_launch_count: accepted.worker_launch_count,
            host_boot_id: accepted.host_boot_id,
            effective_limits: authenticated.effective_limits,
            fixture_evidence: accepted.fixture_evidence,
        })
    }

    fn activation_failure(
        &self,
        prepared: &PreparedLaunch,
        state: LaunchState,
        stage: &'static str,
        error: RuntimeError,
    ) -> RuntimeError {
        append_event(
            &self.config.lifecycle_log,
            "supervisor.activation_failed",
            activation_failure_data(prepared, state, stage, &error),
        );
        error
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
            .begin_input(soul_id.clone(), request_id.clone(), data.as_bytes())
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

    async fn terminal_read_output(
        &self,
        soul_id: SoulId,
        after_seq: u64,
        max_bytes: u64,
    ) -> Result<RuntimeOutputBatch, RuntimeError> {
        let handle = self
            .registry
            .active_handle_for_soul(soul_id.clone())
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
                HostCommand::TerminalReadOutput {
                    incarnation_id: handle.incarnation_id().clone(),
                    after_seq,
                    max_bytes,
                },
            )
            .await?
        {
            HostResult::TerminalOutput(output) => {
                if let Some(native_session_id) = output.native_session_id.as_ref() {
                    self.registry
                        .record_native_session(
                            soul_id.clone(),
                            handle.incarnation_id().clone(),
                            native_session_id.clone(),
                        )
                        .await
                        .map_err(map_registry)?;
                    // Materialize durable resume evidence while the soul-local
                    // store is still reachable. Repeated probes are idempotent.
                    let _ = self.probe_recovery(soul_id.clone()).await;
                }
                Ok(output)
            }
            _ => Err(RuntimeError::new(
                RuntimeErrorCode::HostAuthenticationFailed,
                "unexpected terminal output reply",
            )),
        }
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

    async fn stop(
        &self,
        soul_id: SoulId,
        expected_intent_revision: Option<u64>,
    ) -> Result<(StopOutcome, RuntimeView), RuntimeError> {
        // The durable stop intent is committed before any IPC or Docker signal.
        let handle = self
            .registry
            .begin_stop_expected(soul_id.clone(), expected_intent_revision)
            .await
            .map_err(map_registry)?;
        append_event(
            &self.config.lifecycle_log,
            "supervisor.stop_committed",
            serde_json::json!({"soulId":soul_id,"incarnationId":handle.incarnation_id(),"containerId":handle.container_id()}),
        );

        if let Ok(authenticated) = self
            .authenticate_host(handle.incarnation_id(), handle.runtime_dir())
            .await
        {
            let _ = self
                .send_host_stop(
                    handle.incarnation_id().clone(),
                    handle.runtime_dir(),
                    &authenticated,
                )
                .await;
        }

        let outcome = match self.backend.request_stop(&handle, 2).await {
            Ok(()) => match self
                .verify_empty_with_budget(&handle, Duration::from_secs(3))
                .await
            {
                Ok(true) => StopOutcome::VerifiedEmpty,
                Ok(false) => match self.backend.force_stop(&handle).await {
                    Ok(()) => match self
                        .verify_empty_with_budget(&handle, Duration::from_secs(3))
                        .await
                    {
                        Ok(true) => StopOutcome::VerifiedEmpty,
                        Ok(false) => StopOutcome::TerminationUnconfirmed,
                        Err(error) if error.code == RuntimeErrorCode::OwnershipMismatch => {
                            StopOutcome::BlockedOwnership
                        }
                        Err(_) => StopOutcome::TerminationUnconfirmed,
                    },
                    Err(BackendError::OwnershipMismatch(_)) => StopOutcome::BlockedOwnership,
                    Err(_) => StopOutcome::TerminationUnconfirmed,
                },
                Err(error) if error.code == RuntimeErrorCode::OwnershipMismatch => {
                    StopOutcome::BlockedOwnership
                }
                Err(_) => StopOutcome::TerminationUnconfirmed,
            },
            Err(BackendError::OwnershipMismatch(_)) => StopOutcome::BlockedOwnership,
            // A request that reached Docker but failed is not proof that the
            // workload stopped. Preserve ownership evidence as unconfirmed;
            // reserve BackendUnavailable for callers that cannot reach the
            // backend even for inspection/retry semantics.
            Err(BackendError::DockerHttp { .. }) => StopOutcome::TerminationUnconfirmed,
            Err(BackendError::Unavailable(_)) => StopOutcome::BackendUnavailable,
            Err(_) => StopOutcome::TerminationUnconfirmed,
        };
        self.registry
            .mark_stop_outcome(handle.incarnation_id().clone(), outcome)
            .await
            .map_err(map_registry)?;
        append_event(
            &self.config.lifecycle_log,
            "supervisor.stop_outcome",
            serde_json::json!({"soulId":soul_id,"incarnationId":handle.incarnation_id(),"outcome":outcome}),
        );
        let view = find_view(&self.registry, handle.incarnation_id()).await?;
        Ok((outcome, view))
    }

    pub(crate) async fn verify_empty_with_budget(
        &self,
        handle: &crate::registry::OwnedRuntimeHandle,
        budget: Duration,
    ) -> Result<bool, RuntimeError> {
        let deadline = Instant::now() + budget;
        loop {
            match self.backend.verify_empty(handle).await {
                Ok(true) => return Ok(true),
                Ok(false) => {}
                Err(BackendError::OwnershipMismatch(message)) => {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::OwnershipMismatch,
                        message,
                    ))
                }
                Err(error) => return Err(map_backend(error)),
            }
            if Instant::now() >= deadline {
                return Ok(false);
            }
            sleep(Duration::from_millis(100)).await;
        }
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
        let socket = runtime_dir.join("host.sock");
        let secret = std::fs::read(runtime_dir.join("secret")).map_err(io_runtime)?;
        let challenge = uuid::Uuid::new_v4().to_string();
        let deadline = Instant::now() + Duration::from_secs(8);
        // The connect retry tolerates a host that has not bound its socket
        // yet. Once connected, the reply itself is bounded by the same budget
        // every other host command uses: a host that accepts and then goes
        // silent is HostUnreachable, never an unbounded wait.
        let budget = host_command_budget(std::env::var(HOST_COMMAND_TIMEOUT_ENV).ok().as_deref());
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
                        exchange_host_frame(&mut stream, &envelope, budget, &socket).await?;
                    match reply.result? {
                        HostResult::Hello {
                            host_boot_id,
                            proof,
                            effective_limits,
                            ..
                        } => {
                            let expected =
                                host_proof(&secret, &challenge, &host_boot_id, incarnation_id);
                            if proof != expected {
                                return Err(RuntimeError::new(
                                    RuntimeErrorCode::HostAuthenticationFailed,
                                    "session host challenge proof mismatch",
                                ));
                            }
                            return Ok(AuthenticatedHost {
                                host_boot_id,
                                secret,
                                effective_limits,
                            });
                        }
                        _ => {
                            return Err(RuntimeError::new(
                                RuntimeErrorCode::HostAuthenticationFailed,
                                "unexpected hello reply",
                            ))
                        }
                    }
                }
                Err(_) if Instant::now() < deadline => sleep(Duration::from_millis(100)).await,
                Err(error) => {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::HostUnreachable,
                        format!("host socket {} unavailable: {error}", socket.display()),
                    ))
                }
            }
        }
    }

    async fn send_grant(
        &self,
        handle: &crate::registry::OwnedRuntimeHandle,
        soul_id: SoulId,
        fixture: Option<FixtureKind>,
        terminal: Option<TerminalLaunchSpec>,
        resume_spec: Option<ResumeSpec>,
        host: &AuthenticatedHost,
        grant: &ExecutionGrantRecord,
    ) -> Result<AcceptedGrant, RuntimeError> {
        let incarnation_id = handle.incarnation_id().clone();
        let command = HostCommand::GrantExecution {
            incarnation_id: incarnation_id.clone(),
            soul_id,
            host_boot_id: grant.host_boot_id.clone(),
            control_epoch: grant.control_epoch,
            execution_generation: grant.execution_generation,
            grant_id: grant.grant_id.clone(),
            fixture,
            terminal: terminal.map(Box::new),
            resume_spec: resume_spec.map(Box::new),
        };
        match self
            .send_authenticated_host_command(incarnation_id, handle.runtime_dir(), host, command)
            .await?
        {
            HostResult::GrantAccepted {
                host_boot_id,
                worker_pid,
                worker_launch_count,
                fixture_evidence,
            } => Ok(AcceptedGrant {
                host_boot_id,
                worker_pid,
                worker_launch_count,
                fixture_evidence,
            }),
            _ => Err(RuntimeError::new(
                RuntimeErrorCode::HostAuthenticationFailed,
                "unexpected grant reply",
            )),
        }
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
                host_boot_id,
                worker_pid,
                worker_launch_count,
                fixture_evidence,
                exited,
                native_session_id,
                ..
            } => Ok(HostStatus {
                host_boot_id,
                worker_pid,
                worker_launch_count,
                fixture_evidence,
                exited,
                native_session_id,
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
        let view = find_view(&self.registry, &incarnation_id).await?;
        match self
            .send_authenticated_host_command(
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
            )),
        }
    }

    pub(crate) async fn send_authenticated_host_command(
        &self,
        incarnation_id: IncarnationId,
        runtime_dir: &Path,
        host: &AuthenticatedHost,
        command: HostCommand,
    ) -> Result<HostResult, RuntimeError> {
        let mut envelope = Envelope::new(RequestId::new(), ControlRole::Supervisor, command);
        envelope.auth = Some(host_proof(
            &host.secret,
            "command-auth",
            &host.host_boot_id,
            &incarnation_id,
        ));
        let reply = request_host_reply(
            &runtime_dir.join("host.sock"),
            &envelope,
            host_command_budget(std::env::var(HOST_COMMAND_TIMEOUT_ENV).ok().as_deref()),
        )
        .await?;
        reply.result
    }

    pub(crate) async fn launch_result_from_status(
        &self,
        incarnation_id: IncarnationId,
        _soul_id: SoulId,
        host: AuthenticatedHost,
        status: HostStatus,
    ) -> Result<LaunchResult, RuntimeError> {
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
        let view = find_view(&self.registry, &incarnation_id).await?;
        Ok(LaunchResult {
            view,
            worker_pid,
            worker_launch_count: status.worker_launch_count,
            host_boot_id: host.host_boot_id,
            effective_limits: host.effective_limits,
            fixture_evidence: status.fixture_evidence,
        })
    }
}

#[derive(Clone)]
pub(crate) struct AuthenticatedHost {
    host_boot_id: HostBootId,
    secret: Vec<u8>,
    effective_limits: RuntimeLimits,
}
pub(crate) struct AcceptedGrant {
    host_boot_id: HostBootId,
    worker_pid: u32,
    worker_launch_count: u64,
    fixture_evidence: serde_json::Value,
}
pub(crate) struct HostStatus {
    pub(crate) host_boot_id: HostBootId,
    pub(crate) worker_pid: Option<u32>,
    pub(crate) worker_launch_count: u64,
    pub(crate) fixture_evidence: serde_json::Value,
    pub(crate) exited: bool,
    pub(crate) native_session_id: Option<String>,
}

pub async fn serve_control(supervisor: Supervisor, socket_path: &Path) -> Result<(), String> {
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
    loop {
        let (mut stream, _) = listener.accept().await.map_err(|e| e.to_string())?;
        let supervisor = supervisor.clone();
        tokio::spawn(async move {
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
            let _ = write_frame(&mut stream, &reply).await;
        });
    }
}

pub fn default_backend(socket: impl Into<PathBuf>) -> Arc<dyn RuntimeBackend> {
    Arc::new(DockerEngineBackend::new(socket))
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

/// One bounded framed request/reply against a session host's control socket.
/// Connect, write, and read all share the single budget so a host that accepts
/// the connection and then goes silent cannot extend the wait.
pub(crate) async fn request_host_reply(
    socket_path: &Path,
    envelope: &Envelope<HostCommand>,
    budget: Duration,
) -> Result<HostReply, RuntimeError> {
    let unreachable =
        |message: String| RuntimeError::new(RuntimeErrorCode::HostUnreachable, message);
    let socket_display = socket_path.display().to_string();
    tokio::time::timeout(budget, async {
        let mut stream = UnixStream::connect(socket_path)
            .await
            .map_err(|error| unreachable(error.to_string()))?;
        write_frame(&mut stream, envelope)
            .await
            .map_err(|error| unreachable(error.to_string()))?;
        let reply: HostReply = read_frame(&mut stream)
            .await
            .map_err(|error| unreachable(error.to_string()))?;
        Ok(reply)
    })
    .await
    .unwrap_or_else(|_| {
        Err(unreachable(format!(
            "session host {socket_display} timed out after {}ms",
            budget.as_millis()
        )))
    })
}

/// Bounded write/read on an already-connected host stream. Connecting is the
/// caller's business (the hello handshake retries a not-yet-bound socket);
/// the conversation itself is bounded exactly like every other host command.
pub(crate) async fn exchange_host_frame(
    stream: &mut UnixStream,
    envelope: &Envelope<HostCommand>,
    budget: Duration,
    socket_path: &Path,
) -> Result<HostReply, RuntimeError> {
    let unreachable =
        |message: String| RuntimeError::new(RuntimeErrorCode::HostUnreachable, message);
    let socket_display = socket_path.display().to_string();
    tokio::time::timeout(budget, async {
        write_frame(stream, envelope)
            .await
            .map_err(|error| unreachable(error.to_string()))?;
        let reply: HostReply = read_frame(stream)
            .await
            .map_err(|error| unreachable(error.to_string()))?;
        Ok(reply)
    })
    .await
    .unwrap_or_else(|_| {
        Err(unreachable(format!(
            "session host {socket_display} timed out after {}ms",
            budget.as_millis()
        )))
    })
}

fn release_qualified_workload(provider: &str, is_fixture: bool, has_terminal: bool) -> bool {
    is_fixture || !has_terminal || freshell_agent_runtime::managed_provider_enabled(provider)
}

#[cfg(test)]
mod host_ipc_timeout_tests {
    use super::{host_command_budget, request_host_reply, DEFAULT_HOST_COMMAND_TIMEOUT_MS};
    use freshell_runtime_protocol::{
        ControlRole, Envelope, HostCommand, IncarnationId, RequestId, RuntimeErrorCode,
    };
    use std::time::{Duration, Instant};
    use tokio::net::UnixListener;

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
    }
}

#[cfg(test)]
mod release_scope_tests {
    use super::{
        activation_failure_data, append_event, lifecycle_secrets, release_qualified_workload,
    };
    use crate::registry::PreparedLaunch;
    use freshell_runtime_protocol::{
        IncarnationId, LaunchNonce, LaunchState, RuntimeError, RuntimeErrorCode, SoulId,
    };

    #[test]
    fn direct_terminal_launch_cannot_bypass_live_qualification_scope() {
        assert!(release_qualified_workload("shell", false, true));
        assert!(release_qualified_workload("opencode", false, true));
        for provider in ["claude", "codex", "amplifier", "gemini", "kimi"] {
            assert!(
                !release_qualified_workload(provider, false, true),
                "{provider}"
            );
        }
        assert!(release_qualified_workload(
            "native-session-fixture",
            true,
            false
        ));
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
        assert!(event["data"]["errorMessage"]
            .as_str()
            .unwrap()
            .contains("***REDACTED***"));
    }
}

fn semantic_launch_digest(
    request: &freshell_runtime_protocol::LaunchRequest,
) -> Result<String, RuntimeError> {
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
        "terminal": request.terminal,
    });
    let bytes = serde_json::to_vec(&value)
        .map_err(|e| RuntimeError::new(RuntimeErrorCode::InvalidRequest, e.to_string()))?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
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

fn map_backend(error: BackendError) -> RuntimeError {
    let code = match &error {
        BackendError::OwnershipMismatch(_) => RuntimeErrorCode::OwnershipMismatch,
        BackendError::Unavailable(_) | BackendError::DockerHttp { .. } => {
            RuntimeErrorCode::BackendUnavailable
        }
        _ => RuntimeErrorCode::BackendUnavailable,
    };
    RuntimeError::new(code, error.to_string())
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

fn lifecycle_secrets() -> &'static StdMutex<HashMap<PathBuf, String>> {
    LIFECYCLE_SECRETS.get_or_init(|| StdMutex::new(HashMap::new()))
}

pub(crate) fn append_event(path: &Path, event: &str, data: serde_json::Value) {
    let line = serde_json::json!({
        "at": now_millis(),
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
    serde_json::json!({
        "soulId": prepared.soul_id,
        "incarnationId": prepared.incarnation_id,
        "intentRevision": prepared.intent_revision,
        "launchState": state,
        "stage": stage,
        "errorCode": error.code,
        "errorMessage": error.message,
    })
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

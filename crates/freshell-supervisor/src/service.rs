use crate::{
    backend::{BackendError, CreateRuntimeSpec, DockerEngineBackend, RuntimeBackend},
    registry::{
        BackendCreatedRecord, ExecutionGrantRecord, LaunchPreparation, PreparedLaunch, Registry,
        RegistryError,
    },
};
use freshell_runtime_protocol::{
    host_proof, read_frame, write_frame, AdminCommand, AdminReply, AdminResult, ControlRole,
    Envelope, FixtureKind, HostBootId, HostCommand, HostReply, HostResult, IncarnationId,
    LaunchResult, LaunchState, RequestId, RuntimeError, RuntimeErrorCode, RuntimeLimits,
    RuntimeView, SoulId, StopOutcome, CONTROL_PROTOCOL_VERSION,
};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::{
    net::{UnixListener, UnixStream},
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
}

#[derive(Clone)]
pub struct Supervisor {
    registry: Registry,
    backend: Arc<dyn RuntimeBackend>,
    config: Arc<SupervisorConfig>,
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
        Ok(Self {
            registry,
            backend,
            config: Arc::new(config),
        })
    }

    pub fn registry(&self) -> &Registry {
        &self.registry
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
            AdminCommand::Launch(request) => {
                self.registry
                    .assert_epoch(request.expected_control_epoch)
                    .map_err(map_registry)?;
                self.launch(envelope.request_id, request)
                    .await
                    .map(AdminResult::Launch)
            }
            AdminCommand::Stop(request) => {
                self.registry
                    .assert_epoch(request.expected_control_epoch)
                    .map_err(map_registry)?;
                let (outcome, view) = self.stop(request.soul_id).await?;
                Ok(AdminResult::Stop { outcome, view })
            }
        }
    }

    async fn launch(
        &self,
        request_id: RequestId,
        request: freshell_runtime_protocol::LaunchRequest,
    ) -> Result<LaunchResult, RuntimeError> {
        let limits = request.limits.validate()?;
        let payload_digest = semantic_launch_digest(&request)?;
        let prepared = self
            .registry
            .prepare_launch(LaunchPreparation {
                soul_id: request.soul_id.clone(),
                provider: request.provider.clone(),
                provider_store_id: request.provider_store_id.clone(),
                creation_seed_ref: request.creation_seed_ref.clone(),
                request_id: request_id.clone(),
                payload_digest,
                requested_limits: limits,
            })
            .await
            .map_err(map_registry)?;
        append_event(
            &self.config.lifecycle_log,
            "supervisor.launch_prepared",
            serde_json::json!({"soulId":prepared.soul_id,"incarnationId":prepared.incarnation_id,"existingRequest":prepared.existing_request,"state":prepared.state}),
        );
        crash_if("after_prepare");

        let mut state = prepared.state;
        if state == LaunchState::Prepared {
            let runtime_dir = self.ensure_incarnation_dir(&prepared)?;
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
                })
                .await
                .map_err(map_backend)?;
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
                .map_err(map_registry)?;
            state = LaunchState::Created;
            crash_if("after_created_commit");
        }

        let handle = self
            .registry
            .owned_handle(prepared.incarnation_id.clone())
            .await
            .map_err(map_registry)?;

        if state == LaunchState::Running {
            let authenticated = self
                .authenticate_host(&handle.incarnation_id().clone(), handle.runtime_dir())
                .await?;
            let status = self
                .host_status(
                    handle.incarnation_id().clone(),
                    handle.runtime_dir(),
                    &authenticated,
                )
                .await?;
            return self
                .launch_result_from_status(
                    prepared.incarnation_id,
                    request.soul_id,
                    authenticated,
                    status,
                )
                .await;
        }
        if state == LaunchState::Stopping
            || state == LaunchState::Stopped
            || state == LaunchState::Failed
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                format!("launch request is bound to incarnation in state {state:?}"),
            ));
        }

        if state == LaunchState::Created {
            self.backend
                .start_host(&handle)
                .await
                .map_err(map_backend)?;
            append_event(
                &self.config.lifecycle_log,
                "supervisor.host_started",
                serde_json::json!({"incarnationId":handle.incarnation_id(),"containerId":handle.container_id()}),
            );
            crash_if("after_host_start");
        }

        let authenticated = self
            .authenticate_host(handle.incarnation_id(), handle.runtime_dir())
            .await?;
        crash_if("before_grant_commit");
        let grant = self
            .registry
            .commit_execution_grant(
                handle.incarnation_id().clone(),
                authenticated.host_boot_id.clone(),
                authenticated.effective_limits,
            )
            .await
            .map_err(map_registry)?;
        crash_if("after_grant_commit");
        self.backend
            .enable_long_lived(&handle)
            .await
            .map_err(map_backend)?;
        let accepted = self
            .send_grant(
                handle.incarnation_id().clone(),
                request.soul_id.clone(),
                request.fixture,
                handle.runtime_dir(),
                &authenticated,
                &grant,
            )
            .await?;
        crash_if("after_grant_delivery");
        self.registry
            .mark_running(handle.incarnation_id().clone())
            .await
            .map_err(map_registry)?;
        append_event(
            &self.config.lifecycle_log,
            "supervisor.launch_running",
            serde_json::json!({"soulId":request.soul_id,"incarnationId":handle.incarnation_id(),"containerId":handle.container_id(),"workerPid":accepted.worker_pid,"workerLaunchCount":accepted.worker_launch_count}),
        );
        let view = find_view(&self.registry, handle.incarnation_id()).await?;
        Ok(LaunchResult {
            view,
            worker_pid: accepted.worker_pid,
            worker_launch_count: accepted.worker_launch_count,
            host_boot_id: accepted.host_boot_id,
            effective_limits: authenticated.effective_limits,
            fixture_evidence: accepted.fixture_evidence,
        })
    }

    async fn stop(&self, soul_id: SoulId) -> Result<(StopOutcome, RuntimeView), RuntimeError> {
        // The durable stop intent is committed before any IPC or Docker signal.
        let handle = self
            .registry
            .begin_stop(soul_id.clone())
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

    async fn verify_empty_with_budget(
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

    fn ensure_incarnation_dir(&self, prepared: &PreparedLaunch) -> Result<PathBuf, RuntimeError> {
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

    async fn authenticate_host(
        &self,
        incarnation_id: &IncarnationId,
        runtime_dir: &Path,
    ) -> Result<AuthenticatedHost, RuntimeError> {
        let socket = runtime_dir.join("host.sock");
        let secret = std::fs::read(runtime_dir.join("secret")).map_err(io_runtime)?;
        let challenge = uuid::Uuid::new_v4().to_string();
        let deadline = Instant::now() + Duration::from_secs(8);
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
                    write_frame(&mut stream, &envelope).await.map_err(|e| {
                        RuntimeError::new(RuntimeErrorCode::HostUnreachable, e.to_string())
                    })?;
                    let reply: HostReply = read_frame(&mut stream).await.map_err(|e| {
                        RuntimeError::new(RuntimeErrorCode::HostUnreachable, e.to_string())
                    })?;
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
        incarnation_id: IncarnationId,
        soul_id: SoulId,
        fixture: FixtureKind,
        runtime_dir: &Path,
        host: &AuthenticatedHost,
        grant: &ExecutionGrantRecord,
    ) -> Result<AcceptedGrant, RuntimeError> {
        let command = HostCommand::GrantExecution {
            incarnation_id: incarnation_id.clone(),
            soul_id,
            host_boot_id: grant.host_boot_id.clone(),
            control_epoch: grant.control_epoch,
            execution_generation: grant.execution_generation,
            grant_id: grant.grant_id.clone(),
            fixture,
        };
        match self
            .send_authenticated_host_command(incarnation_id, runtime_dir, host, command)
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

    async fn host_status(
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
                ..
            } => Ok(HostStatus {
                host_boot_id,
                worker_pid,
                worker_launch_count,
                fixture_evidence,
            }),
            _ => Err(RuntimeError::new(
                RuntimeErrorCode::HostAuthenticationFailed,
                "unexpected status reply",
            )),
        }
    }

    async fn send_host_stop(
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

    async fn send_authenticated_host_command(
        &self,
        incarnation_id: IncarnationId,
        runtime_dir: &Path,
        host: &AuthenticatedHost,
        command: HostCommand,
    ) -> Result<HostResult, RuntimeError> {
        let mut stream = UnixStream::connect(runtime_dir.join("host.sock"))
            .await
            .map_err(|e| RuntimeError::new(RuntimeErrorCode::HostUnreachable, e.to_string()))?;
        let mut envelope = Envelope::new(RequestId::new(), ControlRole::Supervisor, command);
        envelope.auth = Some(host_proof(
            &host.secret,
            "command-auth",
            &host.host_boot_id,
            &incarnation_id,
        ));
        write_frame(&mut stream, &envelope)
            .await
            .map_err(|e| RuntimeError::new(RuntimeErrorCode::HostUnreachable, e.to_string()))?;
        let reply: HostReply = read_frame(&mut stream)
            .await
            .map_err(|e| RuntimeError::new(RuntimeErrorCode::HostUnreachable, e.to_string()))?;
        reply.result
    }

    async fn launch_result_from_status(
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
struct AuthenticatedHost {
    host_boot_id: HostBootId,
    secret: Vec<u8>,
    effective_limits: RuntimeLimits,
}
struct AcceptedGrant {
    host_boot_id: HostBootId,
    worker_pid: u32,
    worker_launch_count: u64,
    fixture_evidence: serde_json::Value,
}
struct HostStatus {
    host_boot_id: HostBootId,
    worker_pid: Option<u32>,
    worker_launch_count: u64,
    fixture_evidence: serde_json::Value,
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

fn semantic_launch_digest(
    request: &freshell_runtime_protocol::LaunchRequest,
) -> Result<String, RuntimeError> {
    let value = serde_json::json!({
        "soulId": request.soul_id,
        "provider": request.provider,
        "providerStoreId": request.provider_store_id,
        "creationSeedRef": request.creation_seed_ref,
        "limits": request.limits,
        "fixture": request.fixture,
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
        RegistryError::RequestConflict => RuntimeErrorCode::RequestIdConflict,
        RegistryError::StaleControlEpoch { .. } => RuntimeErrorCode::StaleControlEpoch,
        RegistryError::UnknownSoul(_) => RuntimeErrorCode::UnknownSoul,
        RegistryError::UnknownIncarnation(_) => RuntimeErrorCode::UnknownIncarnation,
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

fn append_event(path: &Path, event: &str, data: serde_json::Value) {
    let Some(parent) = path.parent() else {
        return;
    };
    if std::fs::create_dir_all(parent).is_err() {
        return;
    }
    let line =
        match serde_json::to_vec(&serde_json::json!({"at":now_millis(),"event":event,"data":data}))
        {
            Ok(line) => line,
            Err(_) => return,
        };
    use std::io::Write;
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = file.write_all(&line);
        let _ = file.write_all(b"\n");
        let _ = file.sync_data();
    }
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
fn crash_if(point: &'static str) {
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
fn crash_if(_point: &'static str) {}

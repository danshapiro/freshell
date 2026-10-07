mod command_journal;
mod control;
mod output_journal;
mod provider_secret_resolution;
mod providers;
mod pty;
mod retained_store;

use freshell_agent_runtime::prepare_terminal_for_resume;
use freshell_runtime_protocol::{
    host_proof, read_frame, write_frame, ControlRole, Envelope, FixtureKind, FreshAgentLaunchSpec,
    GrantId, HostBootId, HostCommand, HostReply, HostResult, IncarnationId,
    OpenCodeAdoptionBaseline, OpenCodeAdoptionExpectation, OpenCodeAdoptionStatus,
    OpenCodeTransferDescriptor, OpenCodeTransferReadinessReceipt, OpenCodeVerifiedRootTail,
    ProviderBootstrapFile, RecoveryProbe, ResumeSpec, RuntimeError, RuntimeErrorCode,
    RuntimeLimits, RuntimeMetrics, SoulId, TerminalLaunchSpec, CONTROL_PROTOCOL_VERSION,
    MAX_OPENCODE_TRANSFER_MANIFEST_BYTES,
};
use pty::HostedPty;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::{
    net::{UnixListener, UnixStream},
    process::{Child, Command},
    sync::Mutex,
    time::{sleep, Duration},
};

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct PersistedHostState {
    host_boot_id: Option<HostBootId>,
    max_control_epoch: u64,
    max_execution_generation: u64,
    grant_id: Option<GrantId>,
    worker_pid: Option<u32>,
    worker_launch_count: u64,
    fixture_evidence: serde_json::Value,
    #[serde(default)]
    opencode_transfer_receipt: Option<OpenCodeTransferReadinessReceipt>,
}

struct HostState {
    incarnation_id: IncarnationId,
    host_boot_id: HostBootId,
    state_dir: PathBuf,
    secret: Vec<u8>,
    requested_limits: RuntimeLimits,
    persisted: Mutex<PersistedHostState>,
    child: Mutex<Option<Child>>,
    pty: Mutex<Option<HostedPty>>,
    fresh_agent: Mutex<Option<Arc<freshell_agent_runtime::host_actor::FreshAgentHostActor>>>,
    provider_config_paths: ProviderConfigPaths,
    opencode_transfer_mount: PathBuf,
    bootstrap_root: PathBuf,
}

struct SpawnedTerminalPty {
    pid: u32,
    terminal_id: String,
    stream_epoch: String,
    hosted: Option<HostedPty>,
}

#[async_trait::async_trait]
trait GrantExecutionEffects: Sync {
    async fn open_fresh_agent(
        &self,
        state_dir: &Path,
        launch: FreshAgentLaunchSpec,
    ) -> Result<Arc<freshell_agent_runtime::host_actor::FreshAgentHostActor>, String> {
        providers::open_hosted_fresh_agent(state_dir, launch).await
    }

    fn run_opencode_provider_helper(
        &self,
        terminal: &TerminalLaunchSpec,
        descriptor: &OpenCodeTransferDescriptor,
        workspace_root: &Path,
        cwd: &Path,
        worker: &str,
        payload_path: Option<&Path>,
    ) -> Result<Vec<u8>, String>;

    async fn spawn_terminal_pty(
        &self,
        state_dir: &Path,
        incarnation_id: &IncarnationId,
        terminal: &TerminalLaunchSpec,
        child_env: std::collections::BTreeMap<String, String>,
        codex: Option<providers::PreparedCodexLaunch>,
    ) -> Result<SpawnedTerminalPty, RuntimeError>;
}

struct SystemGrantExecutionEffects;

#[async_trait::async_trait]
impl GrantExecutionEffects for SystemGrantExecutionEffects {
    fn run_opencode_provider_helper(
        &self,
        terminal: &TerminalLaunchSpec,
        descriptor: &OpenCodeTransferDescriptor,
        workspace_root: &Path,
        cwd: &Path,
        worker: &str,
        payload_path: Option<&Path>,
    ) -> Result<Vec<u8>, String> {
        run_opencode_provider_helper(
            terminal,
            descriptor,
            workspace_root,
            cwd,
            worker,
            payload_path,
        )
    }

    async fn spawn_terminal_pty(
        &self,
        state_dir: &Path,
        incarnation_id: &IncarnationId,
        terminal: &TerminalLaunchSpec,
        child_env: std::collections::BTreeMap<String, String>,
        codex: Option<providers::PreparedCodexLaunch>,
    ) -> Result<SpawnedTerminalPty, RuntimeError> {
        let opencode_adoption_revalidator = opencode_adoption_revalidator(terminal);
        let hosted = HostedPty::spawn(
            state_dir,
            incarnation_id.clone(),
            terminal,
            child_env,
            codex,
            opencode_adoption_revalidator,
        )
        .await
        .map_err(|error| {
            RuntimeError::new(
                RuntimeErrorCode::HostUnreachable,
                format!("spawn managed terminal: {error}"),
            )
        })?;
        Ok(SpawnedTerminalPty {
            pid: hosted.pid(),
            terminal_id: hosted.terminal_id().to_owned(),
            stream_epoch: hosted.stream_epoch().to_owned(),
            hosted: Some(hosted),
        })
    }
}

fn opencode_adoption_revalidator(
    terminal: &TerminalLaunchSpec,
) -> Option<pty::OpenCodeAdoptionRevalidator> {
    terminal.opencode_adoption.as_ref()?;
    let terminal = terminal.clone();
    Some(Arc::new(move |baseline: &OpenCodeAdoptionBaseline| {
        baseline.validate().map_err(|error| error.message)?;
        let launch_expectation = terminal
            .opencode_adoption
            .as_ref()
            .ok_or("OpenCode adoption expectation disappeared")?;
        if terminal.mode != "opencode"
            || baseline != &launch_expectation.baseline
            || baseline.descriptor.provider != "opencode"
            || baseline.descriptor.destination_database_path != ".local/share/opencode/opencode.db"
        {
            return Err("OpenCode adoption baseline does not match its launch".into());
        }
        let provider_home = terminal
            .env
            .get("HOME")
            .map(PathBuf::from)
            .ok_or("OpenCode provider home is unavailable")?;
        let paths = plan_opencode_reader_paths_at(
            &terminal.env,
            Path::new(&terminal.workspace_path),
            Path::new(&terminal.cwd),
            &provider_home,
        )?;
        let output = run_opencode_provider_helper(
            &terminal,
            &baseline.descriptor,
            &paths.workspace,
            &paths.cwd,
            "opencode-current-evidence-worker",
            None,
        )?;
        serde_json::from_slice(&output)
            .map_err(|_| "provider evidence worker returned invalid OpenCode evidence".into())
    }))
}

#[derive(Clone)]
struct ProviderConfigPaths {
    private_mount: PathBuf,
    provider_home: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OpenCodeTransferPhase {
    ProviderHomePrepared,
    StageVerified,
    ImportCompleted,
    StructuralVerified,
    ImportReceiptDurable,
    ProviderIdentityReaderVerified,
    ReceiptsDurable,
    ReceiptsRevalidated,
    GrantConsumed,
    PtySpawned,
}

#[derive(Default)]
struct OpenCodeTransferGate {
    phases: Vec<OpenCodeTransferPhase>,
}

impl OpenCodeTransferGate {
    fn advance(&mut self, next: OpenCodeTransferPhase) -> Result<(), String> {
        let expected = self.expected_next();
        if expected != Some(next) {
            return Err(format!(
                "OpenCode transfer phase out of order: expected {expected:?}, received {next:?}"
            ));
        }
        self.phases.push(next);
        Ok(())
    }

    fn ensure_next(&self, next: OpenCodeTransferPhase) -> Result<(), String> {
        let expected = self.expected_next();
        if expected != Some(next) {
            return Err(format!(
                "OpenCode transfer phase out of order: expected {expected:?}, received {next:?}"
            ));
        }
        Ok(())
    }

    fn run_step<T>(
        &mut self,
        phase: OpenCodeTransferPhase,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        self.ensure_next(phase)?;
        let result = action()?;
        self.advance(phase)?;
        Ok(result)
    }

    fn ensure_pty_spawn_allowed(&self) -> Result<(), String> {
        if self.phases.last() == Some(&OpenCodeTransferPhase::GrantConsumed) {
            Ok(())
        } else {
            Err(
                "OpenCode PTY spawn is blocked until transfer receipts and grant are durable"
                    .into(),
            )
        }
    }

    #[cfg(test)]
    fn phases(&self) -> &[OpenCodeTransferPhase] {
        &self.phases
    }

    fn expected_next(&self) -> Option<OpenCodeTransferPhase> {
        use OpenCodeTransferPhase::*;
        match self.phases.last() {
            None => Some(ProviderHomePrepared),
            Some(ProviderHomePrepared) => Some(StageVerified),
            Some(StageVerified) => Some(ImportCompleted),
            Some(ImportCompleted) => Some(StructuralVerified),
            Some(StructuralVerified) => Some(ImportReceiptDurable),
            Some(ImportReceiptDurable) => Some(ProviderIdentityReaderVerified),
            Some(ProviderIdentityReaderVerified) => Some(ReceiptsDurable),
            Some(ReceiptsDurable) => Some(ReceiptsRevalidated),
            Some(ReceiptsRevalidated) => Some(GrantConsumed),
            Some(GrantConsumed) => Some(PtySpawned),
            Some(PtySpawned) => None,
        }
    }
}

const OPENCODE_TRANSFER_READINESS_PHASES: [OpenCodeTransferPhase; 8] = [
    OpenCodeTransferPhase::ProviderHomePrepared,
    OpenCodeTransferPhase::StageVerified,
    OpenCodeTransferPhase::ImportCompleted,
    OpenCodeTransferPhase::StructuralVerified,
    OpenCodeTransferPhase::ImportReceiptDurable,
    OpenCodeTransferPhase::ProviderIdentityReaderVerified,
    OpenCodeTransferPhase::ReceiptsDurable,
    OpenCodeTransferPhase::ReceiptsRevalidated,
];

fn run_opencode_transfer_readiness_sequence(
    gate: &mut OpenCodeTransferGate,
    mut perform: impl FnMut(OpenCodeTransferPhase) -> Result<(), String>,
) -> Result<(), String> {
    for phase in OPENCODE_TRANSFER_READINESS_PHASES {
        gate.run_step(phase, || perform(phase))?;
    }
    Ok(())
}

async fn run_opencode_transfer_pty_spawn<T, Fut>(
    gate: &mut OpenCodeTransferGate,
    spawn: impl FnOnce() -> Fut,
) -> Result<T, RuntimeError>
where
    Fut: std::future::Future<Output = Result<T, RuntimeError>>,
{
    gate.ensure_pty_spawn_allowed()
        .map_err(opencode_transfer_phase_error)?;
    let spawned = spawn().await?;
    gate.advance(OpenCodeTransferPhase::PtySpawned)
        .map_err(opencode_transfer_phase_error)?;
    Ok(spawned)
}

fn opencode_transfer_phase_error(error: String) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::HostUnreachable, error)
}

impl Default for ProviderConfigPaths {
    fn default() -> Self {
        Self {
            private_mount: PathBuf::from("/run/freshell-private"),
            provider_home: PathBuf::from("/home/freshell/provider"),
        }
    }
}

/// A managed session host runs inside a CPU-capped container, so
/// `available_parallelism()` routinely reports 1. A single-worker runtime
/// makes the control plane share one thread with every workload task: any
/// long synchronous step (a large output batch, a durable journal fsync, a
/// provider store probe) stalls the supervisor's control connection, and the
/// supervisor cannot tell that apart from a dead host. Keep a small floor so
/// a control command — above all `Stop` — always has a worker available, and
/// a ceiling so a host on a large machine does not spawn a pointless thread
/// per core inside a half-CPU cgroup.
pub(crate) const HOST_MIN_WORKER_THREADS: usize = 4;
pub(crate) const HOST_MAX_WORKER_THREADS: usize = 8;

pub(crate) fn host_worker_threads(available_parallelism: usize) -> usize {
    available_parallelism.clamp(HOST_MIN_WORKER_THREADS, HOST_MAX_WORKER_THREADS)
}

fn main() {
    let available = std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(1);
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(host_worker_threads(available))
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!(
                "{}",
                serde_json::json!({"severity":"error","event":"session_host.fatal","error":format!("runtime: {error}")})
            );
            std::process::exit(1);
        }
    };
    let code = match runtime.block_on(run()) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!(
                "{{\"severity\":\"error\",\"event\":\"session_host.fatal\",\"error\":{}}}",
                serde_json::to_string(&error).unwrap_or_else(|_| "\"unknown\"".into())
            );
            1
        }
    };
    std::process::exit(code);
}

async fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("serve") => serve(&args[2..]).await,
        Some("worker") => worker(&args[2..]).await,
        Some("retained-opencode-store-worker") => retained_store::run(&args[2..]),
        Some("provider-census-only") => {
            let spec: freshell_runtime_protocol::ResumeSpec = serde_json::from_str(args.get(2).ok_or("missing native census request")?)
                .map_err(|_| "invalid native census request")?;
            if spec.provider_home != freshell_agent_runtime::PROVIDER_HOME { return Err("native census requires the canonical provider home".into()); }
            let result = freshell_agent_runtime::probe_provider_store(Path::new(&spec.provider_home), &spec);
            serde_json::to_writer(std::io::stdout(), &result).map_err(|error| format!("encode native census: {error}"))
        }
        Some("native-history-only") => {
            let snapshot = freshell_freshagent::native_history::read(
                &required_arg(&args[2..], "--provider")?,
                Path::new(&required_arg(&args[2..], "--provider-home")?),
                &required_arg(&args[2..], "--session-id")?,
            )?;
            println!("{snapshot}");
            Ok(())
        }
        Some("fixture-child") => fixture_child(&args[2..]).await,
        #[cfg(feature = "fresh-agent-fixtures")]
        Some("fresh-agent-fixture-worker") => providers::run_fresh_agent_fixture_worker(&args[2..]).await,
        #[cfg(feature = "fresh-agent-fixtures")]
        Some("fresh-agent-fixture-state-worker") => providers::run_fresh_agent_fixture_state_worker(&args[2..]),
        Some("opencode-identity-worker") => pty::run_opencode_identity_worker(&args[2..]),
        Some("provider-probe-worker") => providers::run_probe_worker(&args[2..]),
        Some("refresh-provider-config") => refresh_provider_config_worker(&args[2..]),
        Some("publish-provider-files") => {
            if args.len()!=4 { return Err("publish-provider-files requires stage and provider HOME".into()); }
            publish_provider_files(Path::new(&args[2]),Path::new(&args[3]))
        },
        Some("opencode-import-worker") => run_opencode_import_worker(&args[2..]),
        Some("opencode-reader-probe") => run_opencode_reader_probe(&args[2..]),
        Some("opencode-stopped-repair-worker") => {
            run_opencode_stopped_repair_worker(&args[2..])
        }
        Some("opencode-current-evidence-worker") => {
            run_opencode_current_evidence_worker(&args[2..])
        }
        Some("prepare-provider-features") => {
            if let Some(selector) = providers::run_provider_features_worker(&args[2..])? {
                println!("{}", selector.display());
            }
            Ok(())
        }
        _ => Err("usage: freshell-session-host <serve|worker|fixture-child|fresh-agent-fixture-worker|opencode-identity-worker|provider-probe-worker|refresh-provider-config|opencode-import-worker|opencode-reader-probe|opencode-stopped-repair-worker|opencode-current-evidence-worker> ...".into()),
    }
}

async fn serve(args: &[String]) -> Result<(), String> {
    let socket_path = required_arg(args, "--control-socket")?;
    let state_dir = PathBuf::from(required_arg(args, "--state-dir")?);
    let secret_file = PathBuf::from(required_arg(args, "--secret-file")?);
    let incarnation_id =
        IncarnationId::parse(required_arg(args, "--incarnation-id")?).map_err(|e| e.to_string())?;
    let requested_limits: RuntimeLimits =
        serde_json::from_str(&required_arg(args, "--requested-limits")?)
            .map_err(|e| format!("invalid requested limits: {e}"))?;

    std::fs::create_dir_all(&state_dir).map_err(|e| e.to_string())?;
    set_mode(&state_dir, 0o700)?;
    let secret = std::fs::read(&secret_file).map_err(|e| format!("read secret: {e}"))?;
    if secret.len() < 16 {
        return Err("incarnation secret is too short".into());
    }
    let host_boot_id = HostBootId::new();
    let persisted = PersistedHostState {
        host_boot_id: Some(host_boot_id.clone()),
        ..Default::default()
    };
    write_state(&state_dir, &persisted)?;
    append_event_with_secret(
        &state_dir,
        &secret,
        "host.boot",
        serde_json::json!({"hostBootId":host_boot_id,"incarnationId":incarnation_id}),
    )?;

    let socket = PathBuf::from(socket_path);
    if socket.exists() {
        std::fs::remove_file(&socket).map_err(|e| e.to_string())?;
    }
    let listener = UnixListener::bind(&socket).map_err(|e| format!("bind host socket: {e}"))?;
    set_mode(&socket, 0o600)?;

    let state = Arc::new(HostState {
        incarnation_id,
        host_boot_id,
        state_dir,
        secret,
        requested_limits,
        persisted: Mutex::new(persisted),
        child: Mutex::new(None),
        pty: Mutex::new(None),
        fresh_agent: Mutex::new(None),
        provider_config_paths: ProviderConfigPaths::default(),
        opencode_transfer_mount: PathBuf::from(OPENCODE_TRANSFER_MOUNT),
        bootstrap_root: PathBuf::from("/run/freshell-bootstrap"),
    });

    loop {
        let (stream, _) = listener.accept().await.map_err(|e| e.to_string())?;
        let state = state.clone();
        tokio::spawn(async move {
            if let Err(error) = handle_connection(stream, state.clone()).await {
                let _ = append_event_with_secret(
                    &state.state_dir,
                    &state.secret,
                    "host.connection_error",
                    serde_json::json!({"error":error}),
                );
            }
        });
    }
}

async fn handle_connection(mut stream: UnixStream, state: Arc<HostState>) -> Result<(), String> {
    let envelope: Envelope<HostCommand> =
        read_frame(&mut stream).await.map_err(|e| e.to_string())?;
    let request_id = envelope.request_id.clone();
    let result = dispatch(envelope, &state).await;
    if let Err(error) = &result {
        let _ = append_event_with_secret(
            &state.state_dir,
            &state.secret,
            "host.command_failed",
            serde_json::json!({"errorCode":error.code,"message":error.message}),
        );
    }
    let limit = if matches!(result, Ok(HostResult::FreshAgentSnapshot(_))) {
        freshell_runtime_protocol::MAX_NATIVE_HISTORY_FRAME_BYTES
    } else {
        freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES
    };
    freshell_runtime_protocol::write_frame_with_limit(
        &mut stream,
        &HostReply { request_id, result },
        limit,
    )
    .await
    .map_err(|e| e.to_string())
}

async fn dispatch(
    envelope: Envelope<HostCommand>,
    state: &Arc<HostState>,
) -> Result<HostResult, RuntimeError> {
    dispatch_with_effects(envelope, state, &SystemGrantExecutionEffects).await
}

async fn dispatch_with_effects(
    envelope: Envelope<HostCommand>,
    state: &Arc<HostState>,
    effects: &dyn GrantExecutionEffects,
) -> Result<HostResult, RuntimeError> {
    if envelope.protocol_version != CONTROL_PROTOCOL_VERSION {
        return Err(RuntimeError::new(
            RuntimeErrorCode::ProtocolVersionMismatch,
            "unsupported host protocol version",
        ));
    }
    if envelope.role != ControlRole::Supervisor {
        return Err(RuntimeError::new(
            RuntimeErrorCode::UnauthorizedRole,
            "host accepts supervisor role only",
        ));
    }

    match envelope.body {
        HostCommand::Hello {
            incarnation_id,
            challenge,
        } => {
            ensure_incarnation(&incarnation_id, state)?;
            let limits = read_effective_limits(state.requested_limits);
            Ok(HostResult::Hello {
                host_boot_id: state.host_boot_id.clone(),
                proof: host_proof(
                    &state.secret,
                    &challenge,
                    &state.host_boot_id,
                    &state.incarnation_id,
                ),
                capabilities: vec![
                    "owned-provider-config-v1".into(),
                    "provider-store-probe-v1".into(),
                    "opencode-adoption-observation-v1".into(),
                    "grant-v1".into(),
                    "stop-v1".into(),
                    "security-probe-v1".into(),
                    "terminal-v1".into(),
                    "output-replay-v1".into(),
                    "runtime-metrics-v1".into(),
                    "fresh-agent-v1".into(),
                ],
                effective_limits: limits,
            })
        }
        command => {
            control::authenticate_command(
                &state.secret,
                &state.host_boot_id,
                &state.incarnation_id,
                envelope.auth.as_deref(),
            )?;
            match command {
                HostCommand::GrantExecution {
                    incarnation_id,
                    soul_id,
                    host_boot_id,
                    control_epoch,
                    execution_generation,
                    grant_id,
                    fixture,
                    terminal,
                    fresh_agent,
                    resume_spec,
                } => {
                    ensure_incarnation(&incarnation_id, state)?;
                    if host_boot_id != state.host_boot_id {
                        return Err(RuntimeError::new(
                            RuntimeErrorCode::StaleExecutionGrant,
                            "execution grant belongs to another host boot",
                        ));
                    }
                    grant_execution(
                        state,
                        GrantExecutionRequest {
                            soul_id,
                            control_epoch,
                            execution_generation,
                            grant_id,
                            fixture,
                            terminal: terminal.map(|terminal| *terminal),
                            fresh_agent: fresh_agent.map(|agent| *agent),
                            resume_spec: resume_spec.map(|resume_spec| *resume_spec),
                        },
                        effects,
                    )
                    .await
                }
                HostCommand::Stop {
                    incarnation_id,
                    control_epoch,
                    execution_generation,
                } => {
                    ensure_incarnation(&incarnation_id, state)?;
                    let persisted = state.persisted.lock().await.clone();
                    if control_epoch < persisted.max_control_epoch
                        || execution_generation < persisted.max_execution_generation
                    {
                        return Err(RuntimeError::new(
                            RuntimeErrorCode::StaleExecutionGrant,
                            "stale stop generation",
                        ));
                    }
                    if let Some(child) = state.child.lock().await.as_mut() {
                        let _ = child.start_kill();
                    }
                    if let Some(mut pty) = state.pty.lock().await.take() {
                        pty.stop().await;
                    }
                    if let Some(agent) = state.fresh_agent.lock().await.take() {
                        let _ = agent.stop().await;
                    }
                    append_event_with_secret(&state.state_dir, &state.secret, "host.stop_requested", serde_json::json!({"controlEpoch":control_epoch,"executionGeneration":execution_generation})).ok();
                    Ok(HostResult::Stopped)
                }
                HostCommand::SecurityProbe { incarnation_id } => {
                    ensure_incarnation(&incarnation_id, state)?;
                    Ok(HostResult::SecurityProbe(security_probe(&state.state_dir)))
                }
                HostCommand::Status { incarnation_id } => {
                    ensure_incarnation(&incarnation_id, state)?;
                    let persisted = state.persisted.lock().await.clone();
                    let mut evidence = persisted.fixture_evidence;
                    let mut exited = false;
                    let mut native_session_id = None;
                    let mut opencode_adoption = OpenCodeAdoptionStatus::NotRequired;
                    if let Some(pty) = state.pty.lock().await.as_ref() {
                        exited = pty.exited();
                        native_session_id = pty.native_session_id();
                        opencode_adoption = pty.opencode_adoption_status();
                        evidence = serde_json::json!({
                            "workload":"terminal",
                            "terminalId":pty.terminal_id(),
                            "streamEpoch":pty.stream_epoch(),
                            "headSeq":pty.head_seq(),
                            "spoolBytes":pty.spool_bytes(),
                            "exited":exited,
                            "exitCode":pty.exit_code(),
                            "nativeSessionId":native_session_id,
                        });
                    } else if let Some(agent) = state.fresh_agent.lock().await.as_ref() {
                        exited = !agent.is_live().await;
                        native_session_id = agent.profile().await.native_session_id;
                        evidence = serde_json::json!({
                            "workload":"fresh-agent",
                            "nativeSessionId":native_session_id,
                            "exited":exited,
                        });
                    } else if let Some(child) = state.child.lock().await.as_mut() {
                        exited = child
                            .try_wait()
                            .map_err(|error| {
                                RuntimeError::new(
                                    RuntimeErrorCode::HostUnreachable,
                                    error.to_string(),
                                )
                            })?
                            .is_some();
                        let native_state =
                            Path::new("/home/freshell/provider").join("native-session-state.json");
                        if native_state.is_file() {
                            native_session_id = std::fs::read(&native_state)
                                .ok()
                                .and_then(|bytes| {
                                    serde_json::from_slice::<serde_json::Value>(&bytes).ok()
                                })
                                .and_then(|value| {
                                    value
                                        .get("sessionId")
                                        .and_then(serde_json::Value::as_str)
                                        .map(str::to_string)
                                });
                        }
                    }
                    Ok(HostResult::Status {
                        host_boot_id: state.host_boot_id.clone(),
                        worker_pid: persisted.worker_pid,
                        worker_launch_count: persisted.worker_launch_count,
                        max_control_epoch: persisted.max_control_epoch,
                        max_execution_generation: persisted.max_execution_generation,
                        fixture_evidence: evidence,
                        exited,
                        native_session_id,
                        opencode_transfer_receipt: persisted.opencode_transfer_receipt.clone(),
                        opencode_adoption,
                    })
                }
                HostCommand::TerminalInput {
                    incarnation_id,
                    request_id,
                    data,
                } => {
                    ensure_incarnation(&incarnation_id, state)?;
                    let mut pty = state.pty.lock().await;
                    let pty = pty.as_mut().ok_or_else(|| {
                        RuntimeError::new(
                            RuntimeErrorCode::UnsupportedWorkload,
                            "incarnation is not a managed terminal",
                        )
                    })?;
                    let state = pty.write_input(&request_id, &data)?;
                    Ok(HostResult::TerminalInput { state })
                }
                HostCommand::TerminalResize {
                    incarnation_id,
                    cols,
                    rows,
                } => {
                    ensure_incarnation(&incarnation_id, state)?;
                    let mut pty = state.pty.lock().await;
                    pty.as_mut()
                        .ok_or_else(|| {
                            RuntimeError::new(
                                RuntimeErrorCode::UnsupportedWorkload,
                                "incarnation is not a managed terminal",
                            )
                        })?
                        .resize(cols, rows)?;
                    Ok(HostResult::TerminalResize)
                }
                HostCommand::TerminalReadOutput {
                    incarnation_id,
                    after_seq,
                    max_bytes,
                    expected_stream_epoch,
                } => {
                    ensure_incarnation(&incarnation_id, state)?;
                    let pty = state.pty.lock().await;
                    let batch = pty
                        .as_ref()
                        .ok_or_else(|| {
                            RuntimeError::new(
                                RuntimeErrorCode::UnsupportedWorkload,
                                "incarnation is not a managed terminal",
                            )
                        })?
                        .read_output(
                            incarnation_id,
                            after_seq,
                            max_bytes,
                            expected_stream_epoch.as_deref(),
                        )?;
                    Ok(HostResult::TerminalOutput(batch))
                }
                HostCommand::FreshAgentSend {
                    incarnation_id,
                    request_id,
                    text,
                    settings,
                } => {
                    ensure_incarnation(&incarnation_id, state)?;
                    let actor = state
                        .fresh_agent
                        .lock()
                        .await
                        .clone()
                        .ok_or_else(unsupported_fresh_agent)?;
                    let command_state = actor
                        .dispatch(request_id, text, settings)
                        .await
                        .map_err(map_actor_error)?;
                    let native_session_id = actor.profile().await.native_session_id;
                    Ok(HostResult::FreshAgentCommand {
                        state: command_state,
                        native_session_id,
                    })
                }
                HostCommand::FreshAgentFork {
                    incarnation_id,
                    request_id,
                    parent_session_id,
                    input,
                } => {
                    ensure_incarnation(&incarnation_id, state)?;
                    let actor = state
                        .fresh_agent
                        .lock()
                        .await
                        .clone()
                        .ok_or_else(unsupported_fresh_agent)?;
                    let transition = actor
                        .fork(request_id, parent_session_id, input)
                        .await
                        .map_err(map_actor_error)?;
                    Ok(HostResult::FreshAgentFork(
                        freshell_runtime_protocol::FreshAgentForkResult {
                            parent_session_id: transition.parent_session_id,
                            child_session_id: transition.child_session_id,
                            parent_retired_by_runtime: transition.parent_retired_by_runtime,
                        },
                    ))
                }
                HostCommand::FreshAgentCompact {
                    incarnation_id,
                    request_id,
                    instructions,
                    cwd,
                } => {
                    ensure_incarnation(&incarnation_id, state)?;
                    let actor = state
                        .fresh_agent
                        .lock()
                        .await
                        .clone()
                        .ok_or_else(unsupported_fresh_agent)?;
                    let command_state = actor
                        .semantic_operation(
                            request_id,
                            freshell_agent_runtime::host_actor::FreshAgentOperation::Compact {
                                instructions,
                                cwd,
                            },
                        )
                        .await
                        .map_err(map_actor_error)?;
                    Ok(HostResult::FreshAgentCommand {
                        state: command_state,
                        native_session_id: actor.profile().await.native_session_id,
                    })
                }
                HostCommand::FreshAgentRollback {
                    incarnation_id,
                    request_id,
                    direction,
                    mode,
                    turn_id,
                    cwd,
                } => {
                    ensure_incarnation(&incarnation_id, state)?;
                    let actor = state
                        .fresh_agent
                        .lock()
                        .await
                        .clone()
                        .ok_or_else(unsupported_fresh_agent)?;
                    let command_state = actor
                        .semantic_operation(
                            request_id,
                            freshell_agent_runtime::host_actor::FreshAgentOperation::Rollback {
                                direction,
                                mode,
                                turn_id,
                                cwd,
                            },
                        )
                        .await
                        .map_err(map_actor_error)?;
                    Ok(HostResult::FreshAgentCommand {
                        state: command_state,
                        native_session_id: actor.profile().await.native_session_id,
                    })
                }
                HostCommand::FreshAgentCapture {
                    incarnation_id,
                    max_bytes,
                } => {
                    ensure_incarnation(&incarnation_id, state)?;
                    let actor = state
                        .fresh_agent
                        .lock()
                        .await
                        .clone()
                        .ok_or_else(unsupported_fresh_agent)?;
                    Ok(HostResult::FreshAgentCapture(
                        actor
                            .capture(max_bytes as usize)
                            .await
                            .map_err(map_actor_error)?,
                    ))
                }
                HostCommand::FreshAgentReadSnapshot { incarnation_id } => {
                    ensure_incarnation(&incarnation_id, state)?;
                    let actor = state
                        .fresh_agent
                        .lock()
                        .await
                        .clone()
                        .ok_or_else(unsupported_fresh_agent)?;
                    Ok(HostResult::FreshAgentSnapshot(
                        actor.snapshot().await.map_err(map_actor_error)?,
                    ))
                }
                HostCommand::FreshAgentResolve {
                    incarnation_id,
                    decision_id,
                    decision,
                } => {
                    ensure_incarnation(&incarnation_id, state)?;
                    let actor = state
                        .fresh_agent
                        .lock()
                        .await
                        .clone()
                        .ok_or_else(unsupported_fresh_agent)?;
                    actor
                        .resolve_permission(&decision_id, decision)
                        .await
                        .map_err(map_actor_error)?;
                    let native_session_id = actor.profile().await.native_session_id;
                    Ok(HostResult::FreshAgentCommand {
                        state: freshell_runtime_protocol::CommandState::Completed,
                        native_session_id,
                    })
                }
                HostCommand::FreshAgentInterrupt { incarnation_id } => {
                    ensure_incarnation(&incarnation_id, state)?;
                    let actor = state
                        .fresh_agent
                        .lock()
                        .await
                        .clone()
                        .ok_or_else(unsupported_fresh_agent)?;
                    actor.interrupt().await.map_err(map_actor_error)?;
                    Ok(HostResult::FreshAgentInterrupted)
                }
                HostCommand::FreshAgentReadEvents {
                    incarnation_id,
                    after_sequence,
                    max_events,
                } => {
                    ensure_incarnation(&incarnation_id, state)?;
                    let actor = state
                        .fresh_agent
                        .lock()
                        .await
                        .clone()
                        .ok_or_else(unsupported_fresh_agent)?;
                    let events = actor
                        .read_events(after_sequence, (max_events as usize).clamp(1, 4096))
                        .await;
                    Ok(HostResult::FreshAgentEvents(events))
                }
                HostCommand::RuntimeMetrics { incarnation_id } => {
                    ensure_incarnation(&incarnation_id, state)?;
                    Ok(HostResult::RuntimeMetrics(read_runtime_metrics()))
                }
                HostCommand::ProbeRecovery {
                    incarnation_id,
                    resume_spec,
                    creation_seed_ref,
                    never_dispatched,
                    run_as_uid,
                    run_as_gid,
                } => {
                    ensure_incarnation(&incarnation_id, state)?;
                    let probe = match resume_spec {
                        Some(spec) => providers::probe_resume(*spec, run_as_uid, run_as_gid).await,
                        None if never_dispatched => RecoveryProbe::PristineSeedReady {
                            seed: creation_seed_ref,
                            never_dispatched_proof: format!(
                                "{}:command-journal-empty",
                                state.incarnation_id
                            ),
                        },
                        None => freshell_agent_runtime::unverified_native_probe(),
                    };
                    Ok(HostResult::RecoveryProbe(probe))
                }
                HostCommand::Hello { .. } => unreachable!(),
            }
        }
    }
}

fn unsupported_fresh_agent() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::UnsupportedWorkload,
        "incarnation is not a hosted fresh-agent",
    )
}

fn map_actor_error(error: freshell_agent_runtime::host_actor::ActorError) -> RuntimeError {
    use freshell_agent_runtime::host_actor::ActorError;
    let code = match error {
        ActorError::RequestConflict => RuntimeErrorCode::RequestIdConflict,
        ActorError::AmbiguousDispatch => RuntimeErrorCode::CommandAmbiguous,
        ActorError::NativeIdentityMismatch => RuntimeErrorCode::RecoveryWrongIdentity,
        ActorError::UnknownDecision | ActorError::DecisionAlreadyResolved => {
            RuntimeErrorCode::InvalidRequest
        }
        ActorError::WriterBusy => RuntimeErrorCode::OwnershipMismatch,
        ActorError::UnsupportedOperation => RuntimeErrorCode::UnsupportedOperation,
        ActorError::InvalidProfile => RuntimeErrorCode::InvalidRequest,
        ActorError::Transport(_) | ActorError::Persistence(_) => RuntimeErrorCode::HostUnreachable,
    };
    // Provider error strings may contain request bodies, environment values,
    // or credentials. Keep the control payload typed and deliberately opaque.
    RuntimeError::new(code, "hosted fresh-agent command failed")
}

fn ensure_incarnation(
    incarnation_id: &IncarnationId,
    state: &HostState,
) -> Result<(), RuntimeError> {
    if incarnation_id != &state.incarnation_id {
        return Err(RuntimeError::new(
            RuntimeErrorCode::OwnershipMismatch,
            "incarnation mismatch",
        ));
    }
    Ok(())
}

struct GrantExecutionRequest {
    soul_id: SoulId,
    control_epoch: u64,
    execution_generation: u64,
    grant_id: GrantId,
    fixture: Option<FixtureKind>,
    terminal: Option<TerminalLaunchSpec>,
    fresh_agent: Option<FreshAgentLaunchSpec>,
    resume_spec: Option<ResumeSpec>,
}

async fn grant_execution(
    state: &Arc<HostState>,
    request: GrantExecutionRequest,
    effects: &dyn GrantExecutionEffects,
) -> Result<HostResult, RuntimeError> {
    let GrantExecutionRequest {
        soul_id,
        control_epoch,
        execution_generation,
        grant_id,
        fixture,
        terminal,
        fresh_agent,
        resume_spec,
    } = request;
    let mut persisted = state.persisted.lock().await;
    let mut transfer_prepared_terminal = None;
    let mut transfer_phase_gate = None;
    let mut transfer_readiness_receipt = None;
    if control_epoch < persisted.max_control_epoch
        || execution_generation < persisted.max_execution_generation
    {
        return Err(RuntimeError::new(
            RuntimeErrorCode::StaleExecutionGrant,
            "stale execution grant",
        ));
    }
    if let Some(existing) = persisted.grant_id.as_ref() {
        if existing == &grant_id {
            if let Some(pid) = persisted.worker_pid {
                let actor = state.fresh_agent.lock().await.clone();
                let native_session_id = match actor {
                    Some(actor) => actor.profile().await.native_session_id,
                    None => None,
                };
                return Ok(HostResult::GrantAccepted {
                    host_boot_id: state.host_boot_id.clone(),
                    worker_pid: pid,
                    worker_launch_count: persisted.worker_launch_count,
                    fixture_evidence: persisted.fixture_evidence.clone(),
                    native_session_id,
                    opencode_transfer_receipt: persisted.opencode_transfer_receipt.clone(),
                    opencode_adoption: state
                        .pty
                        .lock()
                        .await
                        .as_ref()
                        .map(HostedPty::opencode_adoption_status)
                        .unwrap_or_else(|| {
                            adoption_status_for_required(
                                terminal
                                    .as_ref()
                                    .is_some_and(|terminal| terminal.opencode_adoption.is_some()),
                            )
                        }),
                });
            }
            return Err(RuntimeError::new(
                RuntimeErrorCode::StaleExecutionGrant,
                "grant was durably consumed but worker launch did not complete",
            ));
        }
        return Err(RuntimeError::new(
            RuntimeErrorCode::StaleExecutionGrant,
            "host boot already consumed a different grant",
        ));
    }

    let needs_opencode_adoption = terminal
        .as_ref()
        .is_some_and(|terminal| terminal.opencode_transfer.is_some())
        || resume_spec
            .as_ref()
            .is_some_and(|resume| resume.opencode_adoption_baseline.is_some());
    if needs_opencode_adoption {
        let durable_readiness_receipt = persisted.opencode_transfer_receipt.clone();
        drop(persisted);
        let mut preflight_terminal = match (terminal.as_ref(), resume_spec.as_ref()) {
            (Some(terminal), Some(resume)) => prepare_terminal_for_resume(terminal, resume)
                .map_err(|error| error.runtime_error())?,
            (Some(terminal), None) => terminal.clone(),
            (None, _) => unreachable!("transfer was checked on a terminal"),
        };
        if resume_spec.is_none() {
            let mut phase_gate = OpenCodeTransferGate::default();
            transfer_readiness_receipt = run_opencode_transfer_readiness(
                state,
                &soul_id,
                &mut preflight_terminal,
                &mut phase_gate,
                effects,
            )?;
            transfer_phase_gate = Some(phase_gate);
        }
        prepare_opencode_adoption_expectation(
            state,
            &soul_id,
            &mut preflight_terminal,
            resume_spec.as_ref(),
            transfer_readiness_receipt
                .as_ref()
                .or(durable_readiness_receipt.as_ref()),
            effects,
        )?;
        transfer_prepared_terminal = Some(preflight_terminal.clone());
        persisted = state.persisted.lock().await;
        if control_epoch < persisted.max_control_epoch
            || execution_generation < persisted.max_execution_generation
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::StaleExecutionGrant,
                "stale execution grant",
            ));
        }
        if let Some(existing) = persisted.grant_id.as_ref() {
            if existing == &grant_id {
                if let Some(pid) = persisted.worker_pid {
                    return Ok(HostResult::GrantAccepted {
                        host_boot_id: state.host_boot_id.clone(),
                        worker_pid: pid,
                        worker_launch_count: persisted.worker_launch_count,
                        fixture_evidence: persisted.fixture_evidence.clone(),
                        native_session_id: None,
                        opencode_transfer_receipt: persisted.opencode_transfer_receipt.clone(),
                        opencode_adoption: state
                            .pty
                            .lock()
                            .await
                            .as_ref()
                            .map(HostedPty::opencode_adoption_status)
                            .unwrap_or_else(|| {
                                adoption_status_for_required(
                                    terminal.as_ref().is_some_and(|terminal| {
                                        terminal.opencode_adoption.is_some()
                                    }),
                                )
                            }),
                    });
                }
                return Err(RuntimeError::new(
                    RuntimeErrorCode::StaleExecutionGrant,
                    "grant was durably consumed but worker launch did not complete",
                ));
            }
            return Err(RuntimeError::new(
                RuntimeErrorCode::StaleExecutionGrant,
                "host boot already consumed a different grant",
            ));
        }
    }

    if let Some(gate) = transfer_phase_gate.as_ref() {
        gate.ensure_next(OpenCodeTransferPhase::GrantConsumed)
            .map_err(opencode_transfer_phase_error)?;
    }
    persisted.max_control_epoch = control_epoch;
    persisted.max_execution_generation = execution_generation;
    persisted.grant_id = Some(grant_id.clone());
    persisted.worker_pid = None;
    if let Some(receipt) = transfer_readiness_receipt {
        persisted.opencode_transfer_receipt = Some(receipt);
    }
    write_state(&state.state_dir, &persisted).map_err(registry_like_error)?;
    #[cfg(test)]
    opencode_host_crash_checkpoint("grant.after_state_persist_before_pty");
    if let Some(gate) = transfer_phase_gate.as_mut() {
        gate.advance(OpenCodeTransferPhase::GrantConsumed)
            .expect("OpenCode transfer grant phase was prevalidated");
    }

    let opencode_adoption_required = terminal
        .as_ref()
        .is_some_and(|terminal| terminal.opencode_adoption.is_some());
    let (pid, evidence, native_session_id) = match (fixture, terminal, fresh_agent) {
        (Some(fixture), None, None) => {
            let exe = std::env::current_exe()
                .map_err(|e| RuntimeError::new(RuntimeErrorCode::HostUnreachable, e.to_string()))?;
            let fixture_name = match fixture {
                FixtureKind::Heartbeat => "heartbeat",
                FixtureKind::DescendantSpawner => "descendants",
                FixtureKind::CpuBurner => "cpu_burner",
                FixtureKind::MemoryAllocator => "memory_allocator",
                FixtureKind::NativeSession => "native_session",
                FixtureKind::SecurityProbe => "security",
            };
            let mut command = Command::new(exe);
            command
                .arg("worker")
                .arg("--fixture")
                .arg(fixture_name)
                .arg("--state-dir")
                .arg(&state.state_dir)
                .arg("--soul-id")
                .arg(soul_id.as_str())
                .arg("--provider-state-dir")
                .arg("/home/freshell/provider")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            if fixture == FixtureKind::NativeSession {
                if let Some(resume) = resume_spec.as_ref() {
                    command
                        .arg("--resume-session-id")
                        .arg(&resume.provider_session.native_session_id);
                }
            }
            let child = command.spawn().map_err(|e| {
                RuntimeError::new(
                    RuntimeErrorCode::HostUnreachable,
                    format!("spawn fixture: {e}"),
                )
            })?;
            let pid = child.id().ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::HostUnreachable,
                    "fixture child has no pid",
                )
            })?;
            *state.child.lock().await = Some(child);
            let evidence = if fixture == FixtureKind::SecurityProbe {
                security_probe(&state.state_dir)
            } else {
                serde_json::json!({"fixture":fixture_name})
            };
            (pid, evidence, None)
        }
        (None, Some(terminal), None) => {
            let exact_resume = resume_spec.is_some();
            let mut terminal = match transfer_prepared_terminal.take() {
                Some(prepared) => prepared,
                None => match resume_spec.as_ref() {
                    Some(resume) => prepare_terminal_for_resume(&terminal, resume)
                        .map_err(|error| error.runtime_error())?,
                    None => terminal,
                },
            };
            // First boot transfers the durable provider-home inode to the
            // unprivileged provider. An exact-resume host lacks FOWNER and
            // DAC_OVERRIDE, so it stages current approved config and asks a
            // provider-owned helper to refresh only that projection. Docker's
            // ownership proof pins the same soul-scoped volume on replacement.
            if !exact_resume && terminal.opencode_transfer.is_none() {
                prepare_provider_state_for_fresh_launch(&mut terminal)?;
            } else if exact_resume {
                refresh_provider_context(
                    terminal.provider_launch_context.as_ref(),
                    &terminal.mode,
                    &terminal.workspace_path,
                    terminal.run_as_uid,
                    terminal.run_as_gid,
                    &state.provider_config_paths,
                )
                .map_err(|error| {
                    provider_config_publication_error(
                        state,
                        &soul_id,
                        control_epoch,
                        execution_generation,
                        &terminal.mode,
                        resume_spec.as_ref(),
                        error,
                    )
                })?;
            }
            let resolved_secrets = provider_secret_resolution::resolve_child_secrets(
                &terminal.mode,
                &terminal.provider_secret_references,
                Path::new("/run/freshell-secrets"),
            )
            .map_err(|error| {
                RuntimeError::new(
                    RuntimeErrorCode::HostUnreachable,
                    format!("resolve managed provider credentials: {error}"),
                )
            })?;
            prepare_provider_files(
                &terminal.mode,
                &resolved_secrets.provider_files,
                terminal.run_as_uid,
                terminal.run_as_gid,
            )
            .map_err(|error| {
                RuntimeError::new(
                    RuntimeErrorCode::HostUnreachable,
                    format!("prepare OneCLI provider files: {error}"),
                )
            })?;
            let prepared = providers::prepare_terminal(terminal, &resolved_secrets.environment)
                .await
                .map_err(|error| {
                    RuntimeError::new(
                        RuntimeErrorCode::HostUnreachable,
                        format!("prepare managed provider: {error}"),
                    )
                })?;
            let terminal = prepared.terminal;
            let spawn = || {
                effects.spawn_terminal_pty(
                    &state.state_dir,
                    &state.incarnation_id,
                    &terminal,
                    prepared.child_env,
                    prepared.codex,
                )
            };
            let launched = match transfer_phase_gate.as_mut() {
                Some(gate) => run_opencode_transfer_pty_spawn(gate, spawn).await?,
                None => spawn().await?,
            };
            let pid = launched.pid;
            if let Some(transfer) = terminal.opencode_transfer.as_ref() {
                let _ = append_event_with_secret(
                    &state.state_dir,
                    &state.secret,
                    "host.opencode_transfer.pty_spawned",
                    serde_json::json!({
                        "transferId": transfer.transfer_id,
                        "workerPid": pid,
                    }),
                );
            }
            let evidence = serde_json::json!({
                "workload":"terminal",
                "terminalId": launched.terminal_id,
                "streamEpoch": launched.stream_epoch,
                "cwd":terminal.cwd,
                "mode":terminal.mode,
            });
            if let Some(hosted) = launched.hosted {
                *state.pty.lock().await = Some(hosted);
            }
            (pid, evidence, None)
        }
        (None, None, Some(mut launch)) => {
            let exact_resume = resume_spec.is_some();
            if let Some(resume) = resume_spec.as_ref() {
                if resume.provider_session.native_session_id.is_empty()
                    || resume.provider_session.provider != launch.provider.as_str()
                    || resume.provider_session.provider_store_id != launch.provider_store_id
                    || resume.mode != launch.session_type
                    || resume.runtime_variant != launch.runtime_variant
                    || launch
                        .native_session_id
                        .as_ref()
                        .is_some_and(|native| native != &resume.provider_session.native_session_id)
                {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::RecoveryWrongIdentity,
                        "fresh-agent resume identity does not match the persisted launch profile",
                    ));
                }
                launch.native_session_id = Some(resume.provider_session.native_session_id.clone());
                launch.model = resume.model.clone();
                launch.effort = resume.reasoning_effort.clone();
                launch.permission_mode = resume.permission_mode.clone();
                launch.cwd = resume.cwd.clone();
            }
            if !exact_resume {
                prepare_provider_bootstrap_files(
                    launch.provider.as_str(),
                    &launch.provider_bootstrap_files,
                    launch.run_as_uid,
                    launch.run_as_gid,
                )
                .map_err(|error| {
                    RuntimeError::new(
                        RuntimeErrorCode::HostUnreachable,
                        format!("prepare hosted provider bootstrap: {error}"),
                    )
                })?;
                prepare_provider_context(
                    launch.provider_launch_context.as_ref(),
                    launch.provider.as_str(),
                    &launch.workspace_path,
                    launch.run_as_uid,
                    launch.run_as_gid,
                )
                .map_err(|error| {
                    RuntimeError::new(
                        RuntimeErrorCode::HostUnreachable,
                        format!("prepare hosted provider config: {error}"),
                    )
                })?;
            } else {
                refresh_provider_context(
                    launch.provider_launch_context.as_ref(),
                    launch.provider.as_str(),
                    &launch.workspace_path,
                    launch.run_as_uid,
                    launch.run_as_gid,
                    &state.provider_config_paths,
                )
                .map_err(|error| {
                    provider_config_publication_error(
                        state,
                        &soul_id,
                        control_epoch,
                        execution_generation,
                        launch.provider.as_str(),
                        resume_spec.as_ref(),
                        error,
                    )
                })?;
            }
            let mut resolved_secrets = provider_secret_resolution::resolve_child_secrets(
                launch.provider.as_str(),
                &launch.provider_secret_references,
                Path::new("/run/freshell-secrets"),
            )
            .map_err(|error| {
                RuntimeError::new(
                    RuntimeErrorCode::HostUnreachable,
                    format!("resolve hosted OneCLI grant: {error}"),
                )
            })?;
            prepare_provider_files(
                launch.provider.as_str(),
                &resolved_secrets.provider_files,
                launch.run_as_uid,
                launch.run_as_gid,
            )
            .map_err(|error| {
                RuntimeError::new(
                    RuntimeErrorCode::HostUnreachable,
                    format!("prepare hosted OneCLI provider files: {error}"),
                )
            })?;
            providers::prepare_fresh_agent_child_environment(
                &launch,
                &mut resolved_secrets.environment,
            )
            .map_err(|error| RuntimeError::new(RuntimeErrorCode::HostUnreachable, error))?;
            freshell_platform::managed_child_secrets::install(resolved_secrets.environment)
                .map_err(|error| RuntimeError::new(RuntimeErrorCode::HostUnreachable, error))?;
            let actor = effects
                .open_fresh_agent(&state.state_dir, launch.clone())
                .await
                .map_err(|error| {
                    RuntimeError::new(
                        RuntimeErrorCode::HostUnreachable,
                        format!("hosted fresh-agent provider failed to start: {error}"),
                    )
                })?;
            let profile = actor.profile().await;
            let native_session_id = profile.native_session_id.clone();
            let evidence = serde_json::json!({
                "workload":"fresh-agent",
                "provider":launch.provider.as_str(),
                "sessionType":launch.session_type,
                "runtimeVariant":profile.runtime_variant,
                "nativeSessionId":profile.native_session_id,
            });
            *state.fresh_agent.lock().await = Some(actor);
            (std::process::id(), evidence, native_session_id)
        }
        _ => {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                "execution grant must carry exactly one fixture, terminal, or fresh-agent workload",
            ));
        }
    };

    persisted.worker_launch_count += 1;
    persisted.worker_pid = Some(pid);
    persisted.fixture_evidence = evidence;
    write_state(&state.state_dir, &persisted).map_err(registry_like_error)?;
    append_event_with_secret(&state.state_dir, &state.secret, "host.grant_consumed", serde_json::json!({"grantId":grant_id,"workerPid":pid,"workerLaunchCount":persisted.worker_launch_count,"controlEpoch":control_epoch,"executionGeneration":execution_generation})).ok();

    let opencode_adoption = state
        .pty
        .lock()
        .await
        .as_ref()
        .map(HostedPty::opencode_adoption_status)
        .unwrap_or_else(|| adoption_status_for_required(opencode_adoption_required));
    Ok(HostResult::GrantAccepted {
        host_boot_id: state.host_boot_id.clone(),
        worker_pid: pid,
        worker_launch_count: persisted.worker_launch_count,
        fixture_evidence: persisted.fixture_evidence.clone(),
        native_session_id,
        opencode_transfer_receipt: persisted.opencode_transfer_receipt.clone(),
        opencode_adoption,
    })
}

fn adoption_status_for_required(required: bool) -> OpenCodeAdoptionStatus {
    if required {
        OpenCodeAdoptionStatus::AwaitingObservation
    } else {
        OpenCodeAdoptionStatus::NotRequired
    }
}

fn provider_config_publication_error(
    state: &HostState,
    soul_id: &SoulId,
    control_epoch: u64,
    execution_generation: u64,
    provider: &str,
    resume: Option<&ResumeSpec>,
    error: String,
) -> RuntimeError {
    // Classification comes from this publication boundary, never from native
    // error wording. The event carries fenced references, not raw diagnostics.
    append_event_with_secret(
        &state.state_dir,
        &state.secret,
        "host.provider_config_publication_blocked",
        serde_json::json!({
            "severity":"warn", "soulId":soul_id, "incarnationId":state.incarnation_id,
            "controlEpoch":control_epoch, "executionGeneration":execution_generation,
            "provider":provider, "reason":"selected_dependency_unavailable",
            "providerSession":resume.map(|resume| &resume.provider_session),
            "evidenceRevision":resume.map(|resume| resume.evidence_revision),
            "checkpointRevision":resume.map(|resume| resume.checkpoint_revision),
        }),
    )
    .ok();
    RuntimeError::new(
        RuntimeErrorCode::HostUnreachable,
        format!("capability_pending: provider configuration publication failed: {error}"),
    )
}

const OPENCODE_TRANSFER_MOUNT: &str = "/run/freshell-opencode-transfer";
const OPENCODE_PROVIDER_HOME: &str = "/home/freshell/provider";
const MAX_OPENCODE_RECEIPT_BYTES: usize = 64 * 1024;

#[derive(Clone)]
struct OpencodeReaderPaths {
    home: PathBuf,
    xdg_data_home: PathBuf,
    xdg_config_home: PathBuf,
    database: PathBuf,
    workspace: PathBuf,
    cwd: PathBuf,
}

fn installed_store_reader_context(
    paths: &OpencodeReaderPaths,
    provider_uid: u32,
    provider_gid: u32,
) -> freshell_agent_runtime::opencode_transfer::InstalledStoreReaderContext<'_> {
    freshell_agent_runtime::opencode_transfer::InstalledStoreReaderContext {
        database_path: &paths.database,
        workspace_root: &paths.workspace,
        provider_uid,
        provider_gid,
        home: &paths.home,
        xdg_data_home: &paths.xdg_data_home,
        xdg_config_home: &paths.xdg_config_home,
        cwd: &paths.cwd,
    }
}

fn validate_opencode_reader_paths(
    env: &std::collections::BTreeMap<String, String>,
    workspace_root: &Path,
    expected_cwd: &Path,
) -> Result<OpencodeReaderPaths, String> {
    validate_opencode_reader_paths_at(
        env,
        workspace_root,
        expected_cwd,
        Path::new(OPENCODE_PROVIDER_HOME),
    )
}

fn validate_opencode_reader_paths_at(
    env: &std::collections::BTreeMap<String, String>,
    workspace_root: &Path,
    expected_cwd: &Path,
    provider_home: &Path,
) -> Result<OpencodeReaderPaths, String> {
    let paths = plan_opencode_reader_paths_at(env, workspace_root, expected_cwd, provider_home)?;
    for path in [
        &paths.home,
        &paths.xdg_data_home,
        &paths.xdg_config_home,
        &paths.database,
    ] {
        reject_symlink_components(path)?;
    }
    Ok(paths)
}

/// Construct the provider paths needed by the host to invoke an identity
/// helper. This deliberately does not traverse the provider home: after
/// ownership handoff it is mode 0700 for the provider UID, while the host has
/// no DAC override capability. The helper calls
/// `validate_opencode_reader_paths_at` as that UID before accessing any path.
fn plan_opencode_reader_paths_at(
    env: &std::collections::BTreeMap<String, String>,
    workspace_root: &Path,
    expected_cwd: &Path,
    provider_home: &Path,
) -> Result<OpencodeReaderPaths, String> {
    if !provider_home.is_absolute()
        || provider_home
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("OpenCode provider HOME must be an absolute normalized path".into());
    }
    let xdg_data_home = provider_home.join(".local/share");
    let xdg_config_home = provider_home.join(".config");
    let database = xdg_data_home.join("opencode/opencode.db");
    let expected = [
        ("HOME", provider_home),
        ("XDG_DATA_HOME", xdg_data_home.as_path()),
        ("XDG_CONFIG_HOME", xdg_config_home.as_path()),
        ("OPENCODE_DB", database.as_path()),
    ];
    for (name, value) in expected {
        if env.get(name).map(String::as_str) != Some(value.to_string_lossy().as_ref()) {
            return Err(format!(
                "OpenCode provider environment has an unexpected {name}"
            ));
        }
    }
    let workspace = std::fs::canonicalize(workspace_root)
        .map_err(|error| format!("OpenCode workspace is unavailable: {error}"))?;
    let cwd = std::fs::canonicalize(expected_cwd)
        .map_err(|error| format!("OpenCode working directory is unavailable: {error}"))?;
    if !workspace.is_dir() || !cwd.is_dir() || !cwd.starts_with(&workspace) {
        return Err("OpenCode working directory is outside its workspace".into());
    }
    let paths = OpencodeReaderPaths {
        home: provider_home.to_path_buf(),
        xdg_data_home,
        xdg_config_home,
        database,
        workspace,
        cwd,
    };
    Ok(paths)
}

fn reject_symlink_components(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("OpenCode provider path must be absolute".into());
    }
    let components = path.components().collect::<Vec<_>>();
    let mut current = PathBuf::new();
    for (index, component) in components.iter().enumerate() {
        if matches!(
            component,
            std::path::Component::ParentDir | std::path::Component::CurDir
        ) {
            return Err("OpenCode provider path contains a relative component".into());
        }
        current.push(component.as_os_str());
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("OpenCode provider path contains a symbolic link".into());
            }
            Ok(metadata) if index + 1 < components.len() && !metadata.is_dir() => {
                return Err("OpenCode provider path crosses a non-directory".into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(format!("OpenCode provider path cannot be checked: {error}")),
        }
    }
    Ok(())
}

fn validate_opencode_helper_identity(uid: u32, gid: u32) -> Result<(), String> {
    #[cfg(unix)]
    if unsafe { libc::geteuid() } != uid || unsafe { libc::getegid() } != gid {
        return Err("OpenCode history helper did not run as the provider identity".into());
    }
    #[cfg(not(unix))]
    return Err("OpenCode history helper requires Unix provider identity support".into());
    Ok(())
}

fn run_opencode_import_worker(args: &[String]) -> Result<(), String> {
    let (workspace_root, expected_cwd, uid, gid) = opencode_helper_args(args)?;
    validate_opencode_helper_identity(uid, gid)?;
    let env = std::env::vars().collect::<std::collections::BTreeMap<_, _>>();
    let paths = validate_opencode_reader_paths(&env, &workspace_root, &expected_cwd)?;
    if std::env::current_dir().map_err(|error| error.to_string())? != paths.cwd {
        return Err("OpenCode importer cwd differs from the requested provider cwd".into());
    }

    let mut stdin = io::stdin().lock();
    let descriptor = read_opencode_descriptor_frame(&mut stdin)?;
    if descriptor.destination_database_path != ".local/share/opencode/opencode.db" {
        return Err("OpenCode import destination path is unsupported".into());
    }
    let receipt = {
        let mut payload = (&mut stdin).take(descriptor.files[0].size_bytes);
        freshell_agent_runtime::opencode_transfer::import_bundle_payload(
            &descriptor,
            &mut payload,
            &paths.database,
            &paths.workspace,
        )
        .map_err(|_| "provider-identity OpenCode import failed".to_string())?
    };
    let mut trailing = [0_u8; 1];
    if stdin
        .read(&mut trailing)
        .map_err(|error| error.to_string())?
        != 0
    {
        return Err("OpenCode import stream contains trailing bytes".into());
    }
    write_opencode_helper_result(&receipt)
}

fn run_opencode_reader_probe(args: &[String]) -> Result<(), String> {
    let (workspace_root, expected_cwd, uid, gid) = opencode_helper_args(args)?;
    validate_opencode_helper_identity(uid, gid)?;
    let env = std::env::vars().collect::<std::collections::BTreeMap<_, _>>();
    let paths = validate_opencode_reader_paths(&env, &workspace_root, &expected_cwd)?;
    if std::env::current_dir().map_err(|error| error.to_string())? != paths.cwd {
        return Err("OpenCode reader cwd differs from the requested provider cwd".into());
    }

    let mut stdin = io::stdin().lock();
    let descriptor = read_opencode_descriptor_frame(&mut stdin)?;
    let mut trailing = [0_u8; 1];
    if stdin
        .read(&mut trailing)
        .map_err(|error| error.to_string())?
        != 0
    {
        return Err("OpenCode reader probe received trailing bytes".into());
    }
    let reader_context = installed_store_reader_context(&paths, uid, gid);
    let receipt = freshell_agent_runtime::opencode_transfer::verify_installed_store(
        &descriptor,
        &reader_context,
    )
    .map_err(|_| {
        "provider-identity OpenCode reader could not read the installed history".to_string()
    })?;
    write_opencode_helper_result(&receipt)
}

/// Revalidate an already-imported OpenCode store from the provider identity.
/// This is read-only and is deliberately separate from the import worker so
/// a resume can never turn stale evidence into another import.
fn run_opencode_current_evidence_worker(args: &[String]) -> Result<(), String> {
    let (workspace_root, expected_cwd, uid, gid) = opencode_helper_args(args)?;
    validate_opencode_helper_identity(uid, gid)?;
    let env = std::env::vars().collect::<std::collections::BTreeMap<_, _>>();
    let paths = validate_opencode_reader_paths(&env, &workspace_root, &expected_cwd)?;
    if std::env::current_dir().map_err(|error| error.to_string())? != paths.cwd {
        return Err("OpenCode evidence cwd differs from the requested provider cwd".into());
    }

    let mut stdin = io::stdin().lock();
    let descriptor = read_opencode_descriptor_frame(&mut stdin)?;
    if descriptor.destination_database_path != ".local/share/opencode/opencode.db" {
        return Err("OpenCode evidence database path is unsupported".into());
    }
    let mut trailing = [0_u8; 1];
    if stdin
        .read(&mut trailing)
        .map_err(|error| error.to_string())?
        != 0
    {
        return Err("OpenCode evidence worker received trailing bytes".into());
    }
    let evidence = freshell_agent_runtime::opencode_transfer::verify_current_store(
        &descriptor,
        &paths.database,
        &paths.workspace,
    )
    .map_err(|error| format!("provider-identity OpenCode evidence verification failed: {error}"))?;
    write_opencode_helper_result(&evidence)
}

fn opencode_helper_args(args: &[String]) -> Result<(PathBuf, PathBuf, u32, u32), String> {
    if args.len() != 8 {
        return Err(
            "OpenCode helper requires workspace, cwd, provider uid, and provider gid".into(),
        );
    }
    if args[0] != "--workspace-root"
        || args[2] != "--expected-cwd"
        || args[4] != "--provider-uid"
        || args[6] != "--provider-gid"
    {
        return Err("OpenCode helper arguments are invalid".into());
    }
    let uid = args[5]
        .parse::<u32>()
        .map_err(|_| "OpenCode provider uid is invalid")?;
    let gid = args[7]
        .parse::<u32>()
        .map_err(|_| "OpenCode provider gid is invalid")?;
    if uid == 0 {
        return Err("OpenCode provider uid cannot be root".into());
    }
    Ok((PathBuf::from(&args[1]), PathBuf::from(&args[3]), uid, gid))
}

fn read_opencode_descriptor_frame(
    reader: &mut impl Read,
) -> Result<OpenCodeTransferDescriptor, String> {
    let mut length = [0; 4];
    reader
        .read_exact(&mut length)
        .map_err(|_| "OpenCode transfer descriptor frame is truncated".to_string())?;
    let length = u32::from_be_bytes(length) as usize;
    let max_length = MAX_OPENCODE_TRANSFER_MANIFEST_BYTES + 16 * 1024;
    if length == 0 || length > max_length {
        return Err("OpenCode transfer descriptor frame exceeds its bound".into());
    }
    let mut bytes = vec![0; length];
    reader
        .read_exact(&mut bytes)
        .map_err(|_| "OpenCode transfer descriptor frame is truncated".to_string())?;
    let descriptor: OpenCodeTransferDescriptor =
        serde_json::from_slice(&bytes).map_err(|_| "OpenCode transfer descriptor is invalid")?;
    descriptor
        .validate()
        .map_err(|_| "OpenCode transfer descriptor is invalid")?;
    Ok(descriptor)
}

fn write_opencode_descriptor_frame(
    writer: &mut impl Write,
    descriptor: &OpenCodeTransferDescriptor,
) -> Result<(), String> {
    let bytes = serde_json::to_vec(descriptor).map_err(|_| "encode OpenCode transfer metadata")?;
    let max_length = MAX_OPENCODE_TRANSFER_MANIFEST_BYTES + 16 * 1024;
    if bytes.is_empty() || bytes.len() > max_length {
        return Err("OpenCode transfer metadata exceeds its bound".into());
    }
    let length =
        u32::try_from(bytes.len()).map_err(|_| "OpenCode transfer metadata is too large")?;
    writer
        .write_all(&length.to_be_bytes())
        .and_then(|_| writer.write_all(&bytes))
        .map_err(|_| "write OpenCode transfer metadata to provider helper".to_string())
}

fn write_opencode_helper_result(value: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|_| "encode OpenCode helper receipt")?;
    if bytes.len() > MAX_OPENCODE_RECEIPT_BYTES {
        return Err("OpenCode helper receipt exceeds its bound".into());
    }
    let mut stdout = io::stdout().lock();
    stdout
        .write_all(&bytes)
        .and_then(|_| stdout.write_all(b"\n"))
        .and_then(|_| stdout.flush())
        .map_err(|_| "write OpenCode helper receipt".to_string())
}

#[derive(Default)]
struct OpenCodeTransferProgress {
    paths: Option<OpencodeReaderPaths>,
    payload_path: Option<PathBuf>,
    import_receipt: Option<freshell_agent_runtime::opencode_transfer::ImportReceipt>,
    reader_receipt: Option<freshell_agent_runtime::opencode_transfer::InstalledStoreReadable>,
    readiness_receipt: Option<OpenCodeTransferReadinessReceipt>,
}

fn run_opencode_transfer_readiness(
    state: &HostState,
    soul_id: &SoulId,
    terminal: &mut TerminalLaunchSpec,
    phase_gate: &mut OpenCodeTransferGate,
    effects: &dyn GrantExecutionEffects,
) -> Result<Option<OpenCodeTransferReadinessReceipt>, RuntimeError> {
    if terminal.opencode_transfer.is_none() {
        return Ok(None);
    }
    let mut progress = OpenCodeTransferProgress::default();
    run_opencode_transfer_readiness_sequence(phase_gate, |phase| {
        perform_opencode_transfer_phase(state, soul_id, terminal, &mut progress, phase, effects)
    })
    .map_err(|error| {
        RuntimeError::new(
            RuntimeErrorCode::HostUnreachable,
            format!("OpenCode history import/readability preflight failed: {error}"),
        )
    })
    .map(|()| progress.readiness_receipt)
}

/// Build the launch-scoped adoption gate from a fresh read of the installed
/// provider store. This deliberately runs after import receipts on a first
/// transfer and independently on every exact resume; it never stages or
/// imports data itself.
fn prepare_opencode_adoption_expectation(
    state: &HostState,
    soul_id: &SoulId,
    terminal: &mut TerminalLaunchSpec,
    resume_spec: Option<&ResumeSpec>,
    readiness_receipt: Option<&OpenCodeTransferReadinessReceipt>,
    effects: &dyn GrantExecutionEffects,
) -> Result<(), RuntimeError> {
    let baseline = match resume_spec.and_then(|resume| resume.opencode_adoption_baseline.as_ref()) {
        Some(baseline) => {
            baseline.validate()?;
            if terminal
                .opencode_transfer
                .as_ref()
                .is_some_and(|descriptor| descriptor != &baseline.descriptor)
            {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::OwnershipMismatch,
                    "OpenCode terminal and resume baselines disagree",
                ));
            }
            baseline.clone()
        }
        None => {
            let descriptor = terminal.opencode_transfer.as_ref().ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::InvalidRequest,
                    "OpenCode adoption has no transfer baseline",
                )
            })?;
            freshell_runtime_protocol::OpenCodeAdoptionBaseline {
                descriptor: descriptor.clone(),
                manifest_sha256: sha256_hex(descriptor.manifest_json.as_bytes()),
            }
        }
    };
    let descriptor = &baseline.descriptor;
    descriptor.validate()?;
    if terminal.mode != "opencode"
        || descriptor.provider != "opencode"
        || descriptor.destination_store_id != soul_id.as_str()
        || descriptor.destination_database_path != ".local/share/opencode/opencode.db"
        || terminal.resume_session_id.as_deref() != Some(descriptor.root_session_id.as_str())
    {
        return Err(RuntimeError::new(
            RuntimeErrorCode::OwnershipMismatch,
            "OpenCode adoption baseline does not match this provider launch",
        ));
    }
    if let Some(resume) = resume_spec {
        if resume.provider_session.provider != "opencode"
            || resume.provider_session.provider_store_id != descriptor.destination_store_id
            || resume.provider_session.native_session_id != descriptor.root_session_id
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::OwnershipMismatch,
                "OpenCode exact resume does not match the imported store and root session",
            ));
        }
    }
    if readiness_receipt.is_some_and(|receipt| {
        receipt.transfer_id != descriptor.transfer_id
            || receipt.destination_store_id != descriptor.destination_store_id
            || receipt.root_session_id != descriptor.root_session_id
            || receipt.source_generation != descriptor.source_generation
            || receipt.provider_uid != terminal.run_as_uid
            || receipt.provider_gid != terminal.run_as_gid
    }) {
        return Err(RuntimeError::new(
            RuntimeErrorCode::OwnershipMismatch,
            "OpenCode readiness receipt does not match the exact provider identity and baseline",
        ));
    }

    let paths = plan_opencode_reader_paths_at(
        &terminal.env,
        Path::new(&terminal.workspace_path),
        Path::new(&terminal.cwd),
        &state.provider_config_paths.provider_home,
    )
    .map_err(|error| {
        RuntimeError::new(
            RuntimeErrorCode::HostUnreachable,
            format!("OpenCode current-store adoption preflight failed: {error}"),
        )
    })?;
    let output = effects
        .run_opencode_provider_helper(
            terminal,
            descriptor,
            &paths.workspace,
            &paths.cwd,
            "opencode-current-evidence-worker",
            None,
        )
        .map_err(|error| {
            RuntimeError::new(
                RuntimeErrorCode::HostUnreachable,
                format!("OpenCode current-store adoption preflight failed: {error}"),
            )
        })?;
    let evidence: freshell_agent_runtime::opencode_transfer::CurrentOpenCodeEvidence =
        serde_json::from_slice(&output).map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::HostUnreachable,
                "OpenCode current-store adoption evidence is malformed",
            )
        })?;
    if evidence.version != 1
        || evidence.transfer_id != descriptor.transfer_id
        || evidence.destination_store_id != descriptor.destination_store_id
        || evidence.root_session_id != descriptor.root_session_id
        || evidence.import_generation != descriptor.source_generation
        || evidence.row_count == 0
    {
        return Err(RuntimeError::new(
            RuntimeErrorCode::HostUnreachable,
            "OpenCode current-store evidence does not match the imported baseline",
        ));
    }

    let root_tail = match evidence.root_tail {
        freshell_agent_runtime::opencode_transfer::VerifiedRootTail::Message { message_id } => {
            OpenCodeVerifiedRootTail::Message { message_id }
        }
        freshell_agent_runtime::opencode_transfer::VerifiedRootTail::QualifiedEmpty => {
            OpenCodeVerifiedRootTail::QualifiedEmpty
        }
    };
    let expectation = OpenCodeAdoptionExpectation {
        baseline: baseline.clone(),
        root_session_id: evidence.root_session_id,
        root_tail,
        evidence_generation: evidence.evidence_generation,
        incarnation_id: state.incarnation_id.clone(),
        launch_nonce: uuid::Uuid::new_v4().simple().to_string(),
    };
    expectation.validate()?;
    append_event_with_secret(
        &state.state_dir,
        &state.secret,
        "host.opencode_adoption.expectation_prepared",
        serde_json::json!({
            "transferId": descriptor.transfer_id,
            "evidenceGeneration": expectation.evidence_generation,
            "incarnationId": expectation.incarnation_id,
            "providerUid": terminal.run_as_uid,
            "providerGid": terminal.run_as_gid,
        }),
    )
    .map_err(|_| {
        RuntimeError::new(
            RuntimeErrorCode::RegistryFailure,
            "OpenCode adoption expectation could not be recorded",
        )
    })?;
    terminal.opencode_adoption = Some(expectation);
    Ok(())
}

fn perform_opencode_transfer_phase(
    state: &HostState,
    soul_id: &SoulId,
    terminal: &mut TerminalLaunchSpec,
    progress: &mut OpenCodeTransferProgress,
    phase: OpenCodeTransferPhase,
    effects: &dyn GrantExecutionEffects,
) -> Result<(), String> {
    if phase == OpenCodeTransferPhase::ProviderHomePrepared {
        let transfer_id = terminal
            .opencode_transfer
            .as_ref()
            .ok_or("OpenCode transfer descriptor is unavailable")?
            .transfer_id
            .clone();
        prepare_provider_state_for_opencode_transfer_at(
            terminal,
            &state.provider_config_paths,
            &state.bootstrap_root,
        )
        .map_err(|error| error.message)?;
        append_event_with_secret(
            &state.state_dir,
            &state.secret,
            "host.opencode_transfer.provider_home_prepared",
            serde_json::json!({
                "transferId": transfer_id,
                "providerUid": terminal.run_as_uid,
                "providerGid": terminal.run_as_gid,
            }),
        )
        .map_err(|_| "OpenCode provider state preparation could not be recorded")?;
        return Ok(());
    }
    let descriptor = terminal
        .opencode_transfer
        .as_ref()
        .ok_or("OpenCode transfer descriptor is unavailable")?;
    match phase {
        OpenCodeTransferPhase::ProviderHomePrepared => unreachable!("handled above"),
        OpenCodeTransferPhase::StageVerified => {
            descriptor
                .validate()
                .map_err(|_| "OpenCode transfer descriptor is invalid")?;
            if terminal.mode != "opencode"
                || descriptor.destination_store_id != soul_id.as_str()
                || descriptor.incarnation_id != state.incarnation_id.as_str()
                || terminal.resume_session_id.as_deref()
                    != Some(descriptor.root_session_id.as_str())
            {
                return Err("OpenCode transfer identity does not match this launch".into());
            }
            let paths = plan_opencode_reader_paths_at(
                &terminal.env,
                Path::new(&terminal.workspace_path),
                Path::new(&terminal.cwd),
                &state.provider_config_paths.provider_home,
            )?;
            if descriptor.destination_database_path != ".local/share/opencode/opencode.db" {
                return Err("OpenCode transfer database binding is unsupported".into());
            }
            let staged_directory = state.opencode_transfer_mount.as_path();
            let metadata = std::fs::symlink_metadata(staged_directory)
                .map_err(|error| format!("OpenCode transfer mount is unavailable: {error}"))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::{MetadataExt, PermissionsExt};
                if metadata.file_type().is_symlink()
                    || !metadata.is_dir()
                    || metadata.uid() != unsafe { libc::geteuid() }
                    || metadata.permissions().mode() & 0o222 != 0
                {
                    return Err(
                        "OpenCode transfer mount is not a root-owned read-only directory".into(),
                    );
                }
            }
            progress.payload_path = Some(
                freshell_agent_runtime::opencode_transfer::verify_staged_bundle(
                    descriptor,
                    staged_directory,
                )
                .map_err(|_| "OpenCode transfer stage does not match its descriptor")?,
            );
            progress.paths = Some(paths);
            append_event_with_secret(
                &state.state_dir,
                &state.secret,
                "host.opencode_transfer.stage_verified",
                serde_json::json!({
                    "transferId": descriptor.transfer_id,
                    "sourceGeneration": descriptor.source_generation,
                }),
            )
            .map_err(|_| "OpenCode transfer stage verification could not be recorded")?;
        }
        OpenCodeTransferPhase::ImportCompleted => {
            let paths = progress
                .paths
                .as_ref()
                .ok_or("OpenCode transfer paths are unavailable")?;
            let payload_path = progress
                .payload_path
                .as_ref()
                .ok_or("OpenCode transfer payload is unavailable")?;
            let import_output = effects.run_opencode_provider_helper(
                terminal,
                descriptor,
                &paths.workspace,
                &paths.cwd,
                "opencode-import-worker",
                Some(payload_path),
            )?;
            progress.import_receipt = Some(
                serde_json::from_slice(&import_output)
                    .map_err(|_| "provider importer returned an invalid receipt")?,
            );
        }
        OpenCodeTransferPhase::StructuralVerified => {
            let paths = progress
                .paths
                .as_ref()
                .ok_or("OpenCode transfer paths are unavailable")?;
            let import_receipt = progress
                .import_receipt
                .as_ref()
                .ok_or("OpenCode import receipt is unavailable")?;
            validate_import_receipt_binding(import_receipt, descriptor, paths)?;
        }
        OpenCodeTransferPhase::ImportReceiptDurable => {
            let import_receipt = progress
                .import_receipt
                .as_ref()
                .ok_or("OpenCode import receipt is unavailable")?;
            persist_opencode_receipt(
                &state.state_dir,
                &format!("opencode-{}-import.json", descriptor.transfer_id),
                import_receipt,
            )?;
            append_event_with_secret(
                &state.state_dir,
                &state.secret,
                "host.opencode_transfer.import_receipt_durable",
                serde_json::json!({
                    "transferId": descriptor.transfer_id,
                    "rowCount": import_receipt.row_count,
                    "assetCount": import_receipt.asset_count,
                    "structuralSha256": import_receipt.structural_sha256,
                }),
            )
            .map_err(|_| "OpenCode import receipt could not be recorded")?;
        }
        OpenCodeTransferPhase::ProviderIdentityReaderVerified => {
            let paths = progress
                .paths
                .as_ref()
                .ok_or("OpenCode transfer paths are unavailable")?;
            let import_receipt = progress
                .import_receipt
                .as_ref()
                .ok_or("OpenCode import receipt is unavailable")?;
            let reader_output = effects.run_opencode_provider_helper(
                terminal,
                descriptor,
                &paths.workspace,
                &paths.cwd,
                "opencode-reader-probe",
                None,
            )?;
            let reader_receipt: freshell_agent_runtime::opencode_transfer::InstalledStoreReadable =
                serde_json::from_slice(&reader_output)
                    .map_err(|_| "provider reader returned an invalid receipt")?;
            validate_reader_receipt_binding(
                &reader_receipt,
                descriptor,
                paths,
                terminal.run_as_uid,
                terminal.run_as_gid,
                import_receipt,
            )?;
            append_event_with_secret(
                &state.state_dir,
                &state.secret,
                "host.opencode_transfer.provider_identity_reader_verified",
                serde_json::json!({
                    "transferId": descriptor.transfer_id,
                    "providerUid": reader_receipt.provider_uid,
                    "providerGid": reader_receipt.provider_gid,
                    "structuralSha256": reader_receipt.structural_sha256,
                }),
            )
            .map_err(|_| "OpenCode provider-reader verification could not be recorded")?;
            progress.reader_receipt = Some(reader_receipt);
        }
        OpenCodeTransferPhase::ReceiptsDurable => {
            let reader_receipt = progress
                .reader_receipt
                .as_ref()
                .ok_or("OpenCode provider-reader receipt is unavailable")?;
            persist_opencode_receipt(
                &state.state_dir,
                &format!("opencode-{}-readable.json", descriptor.transfer_id),
                reader_receipt,
            )?;
            append_event_with_secret(
                &state.state_dir,
                &state.secret,
                "host.opencode_transfer.receipts_durable",
                serde_json::json!({
                    "transferId": descriptor.transfer_id,
                    "providerUid": terminal.run_as_uid,
                    "providerGid": terminal.run_as_gid,
                    "structuralSha256": reader_receipt.structural_sha256,
                }),
            )
            .map_err(|_| "OpenCode transfer receipts could not be recorded")?;
        }
        OpenCodeTransferPhase::ReceiptsRevalidated => {
            progress.readiness_receipt = Some(revalidate_opencode_transfer_receipts(
                state, terminal, effects,
            )?);
        }
        OpenCodeTransferPhase::GrantConsumed | OpenCodeTransferPhase::PtySpawned => {
            return Err("launch phase is outside OpenCode transfer readiness".into());
        }
    }
    Ok(())
}

/// Reopens the durable receipts and repeats the body-free reader probe before
/// the grant is consumed. A failed recheck therefore leaves no worker/PTY and
/// allows the supervisor to retry the same prepared incarnation.
fn revalidate_opencode_transfer_receipts(
    state: &HostState,
    terminal: &TerminalLaunchSpec,
    effects: &dyn GrantExecutionEffects,
) -> Result<OpenCodeTransferReadinessReceipt, String> {
    let descriptor = terminal
        .opencode_transfer
        .as_ref()
        .ok_or("OpenCode transfer descriptor is unavailable")?;
    descriptor
        .validate()
        .map_err(|_| "OpenCode transfer descriptor is invalid")?;
    if terminal.mode != "opencode"
        || descriptor.incarnation_id != state.incarnation_id.as_str()
        || terminal.resume_session_id.as_deref() != Some(descriptor.root_session_id.as_str())
    {
        return Err("OpenCode transfer identity does not match this launch".into());
    }
    let paths = plan_opencode_reader_paths_at(
        &terminal.env,
        Path::new(&terminal.workspace_path),
        Path::new(&terminal.cwd),
        &state.provider_config_paths.provider_home,
    )?;
    let receipt = revalidate_opencode_transfer_receipts_with_reader(
        &state.state_dir,
        descriptor,
        &paths,
        terminal.run_as_uid,
        terminal.run_as_gid,
        || {
            let reader_output = effects.run_opencode_provider_helper(
                terminal,
                descriptor,
                &paths.workspace,
                &paths.cwd,
                "opencode-reader-probe",
                None,
            )?;
            serde_json::from_slice(&reader_output)
                .map_err(|_| "provider reader returned an invalid revalidation receipt".to_string())
        },
    )?;
    append_event_with_secret(
        &state.state_dir,
        &state.secret,
        "host.opencode_transfer.receipts_revalidated",
        serde_json::json!({
            "transferId": descriptor.transfer_id,
            "providerUid": terminal.run_as_uid,
            "providerGid": terminal.run_as_gid,
            "structuralSha256": receipt.structural_sha256,
        }),
    )
    .map_err(|_| "OpenCode durable receipts could not be revalidated")?;
    Ok(receipt)
}

fn revalidate_opencode_transfer_receipts_with_reader(
    state_dir: &Path,
    descriptor: &OpenCodeTransferDescriptor,
    paths: &OpencodeReaderPaths,
    uid: u32,
    gid: u32,
    read_current: impl FnOnce() -> Result<
        freshell_agent_runtime::opencode_transfer::InstalledStoreReadable,
        String,
    >,
) -> Result<OpenCodeTransferReadinessReceipt, String> {
    let import_receipt: freshell_agent_runtime::opencode_transfer::ImportReceipt =
        read_opencode_receipt(
            state_dir,
            &format!("opencode-{}-import.json", descriptor.transfer_id),
        )?;
    validate_import_receipt_binding(&import_receipt, descriptor, paths)?;
    let readable_receipt: freshell_agent_runtime::opencode_transfer::InstalledStoreReadable =
        read_opencode_receipt(
            state_dir,
            &format!("opencode-{}-readable.json", descriptor.transfer_id),
        )?;
    validate_reader_receipt_binding(
        &readable_receipt,
        descriptor,
        paths,
        uid,
        gid,
        &import_receipt,
    )?;
    let current_receipt = read_current()?;
    if current_receipt != readable_receipt {
        return Err("installed OpenCode store changed after its durable receipt".into());
    }
    let reader_receipt_sha256 = sha256_hex(
        &serde_json::to_vec(&current_receipt)
            .map_err(|_| "provider-reader receipt could not be fingerprinted")?,
    );
    Ok(OpenCodeTransferReadinessReceipt {
        transfer_id: descriptor.transfer_id.clone(),
        destination_store_id: descriptor.destination_store_id.clone(),
        root_session_id: descriptor.root_session_id.clone(),
        source_generation: descriptor.source_generation.clone(),
        provider_uid: current_receipt.provider_uid,
        provider_gid: current_receipt.provider_gid,
        structural_sha256: current_receipt.structural_sha256.clone(),
        reader_receipt_sha256,
    })
}

fn sha256_hex(value: &[u8]) -> String {
    Sha256::digest(value)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn run_opencode_provider_helper(
    terminal: &TerminalLaunchSpec,
    descriptor: &OpenCodeTransferDescriptor,
    workspace_root: &Path,
    cwd: &Path,
    worker: &str,
    payload_path: Option<&Path>,
) -> Result<Vec<u8>, String> {
    let process_context = ProviderProcessContext {
        environment: &terminal.env,
        uid: terminal.run_as_uid,
        gid: terminal.run_as_gid,
    };
    run_opencode_provider_helper_with_env(
        &process_context,
        descriptor,
        workspace_root,
        cwd,
        worker,
        payload_path,
    )
}

struct ProviderProcessContext<'a> {
    environment: &'a std::collections::BTreeMap<String, String>,
    uid: u32,
    gid: u32,
}

fn run_opencode_provider_helper_with_env(
    process_context: &ProviderProcessContext<'_>,
    descriptor: &OpenCodeTransferDescriptor,
    workspace_root: &Path,
    cwd: &Path,
    worker: &str,
    payload_path: Option<&Path>,
) -> Result<Vec<u8>, String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let mut command = std::process::Command::new("/usr/bin/setpriv");
    command
        .args(provider_identity_args(
            process_context.uid,
            process_context.gid,
        ))
        .arg(executable)
        .arg(worker)
        .arg("--workspace-root")
        .arg(workspace_root)
        .arg("--expected-cwd")
        .arg(cwd)
        .arg("--provider-uid")
        .arg(process_context.uid.to_string())
        .arg("--provider-gid")
        .arg(process_context.gid.to_string())
        .current_dir(cwd)
        .env_clear()
        .envs(process_context.environment)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|_| "could not start the provider-identity OpenCode helper".to_string())?;
    let write_result = (|| -> Result<(), String> {
        let mut stdin = child
            .stdin
            .take()
            .ok_or("provider helper stdin is unavailable")?;
        write_opencode_descriptor_frame(&mut stdin, descriptor)?;
        if let Some(payload_path) = payload_path {
            let mut payload = std::fs::File::open(payload_path)
                .map_err(|_| "verified OpenCode stage payload could not be opened")?;
            let copied = io::copy(&mut payload, &mut stdin)
                .map_err(|_| "OpenCode payload could not be streamed to the provider helper")?;
            if copied != descriptor.files[0].size_bytes {
                return Err("OpenCode staged payload size changed during handoff".into());
            }
        }
        stdin
            .flush()
            .map_err(|_| "OpenCode provider helper input could not be flushed")?;
        Ok(())
    })();
    let output = child
        .wait_with_output()
        .map_err(|_| "OpenCode provider helper did not settle")?;
    write_result?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr)
            .trim()
            .chars()
            .take(512)
            .collect::<String>();
        return Err(format!(
            "provider-identity OpenCode helper exited with status {}{}",
            output.status,
            if detail.is_empty() {
                String::new()
            } else {
                format!(": {detail}")
            }
        ));
    }
    if output.stdout.len() > MAX_OPENCODE_RECEIPT_BYTES {
        return Err("provider-identity OpenCode helper receipt exceeds its bound".into());
    }
    Ok(output.stdout)
}

fn run_opencode_stopped_repair_worker(args: &[String]) -> Result<(), String> {
    if args.len() != 10
        || args[0] != "--stage-dir"
        || args[2] != "--workspace-root"
        || args[4] != "--expected-cwd"
        || args[6] != "--provider-uid"
        || args[8] != "--provider-gid"
    {
        return Err("stopped OpenCode repair helper arguments are invalid".into());
    }
    let stage_dir = PathBuf::from(&args[1]);
    let workspace = PathBuf::from(&args[3]);
    let cwd = PathBuf::from(&args[5]);
    let uid = args[7]
        .parse::<u32>()
        .map_err(|_| "OpenCode provider uid is invalid")?;
    let gid = args[9]
        .parse::<u32>()
        .map_err(|_| "OpenCode provider gid is invalid")?;
    if uid == 0 {
        return Err("OpenCode provider uid cannot be root".into());
    }
    let stage_metadata = std::fs::symlink_metadata(&stage_dir)
        .map_err(|_| "OpenCode repair stage is unavailable")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if stage_metadata.file_type().is_symlink()
            || !stage_metadata.is_dir()
            || stage_metadata.uid() != 0
            || stage_metadata.permissions().mode() & 0o222 != 0
        {
            return Err("OpenCode repair stage is not a root-owned read-only directory".into());
        }
    }
    let descriptor_path = stage_dir.join("descriptor.json");
    let descriptor_metadata = std::fs::symlink_metadata(&descriptor_path)
        .map_err(|_| "OpenCode repair descriptor is unavailable")?;
    if descriptor_metadata.file_type().is_symlink() || !descriptor_metadata.is_file() {
        return Err("OpenCode repair descriptor is not a regular file".into());
    }
    let descriptor: OpenCodeTransferDescriptor = serde_json::from_slice(
        &std::fs::read(&descriptor_path)
            .map_err(|_| "OpenCode repair descriptor cannot be read")?,
    )
    .map_err(|_| "OpenCode repair descriptor is invalid")?;
    descriptor
        .validate()
        .map_err(|_| "OpenCode repair descriptor is invalid")?;
    let payload_path =
        freshell_agent_runtime::opencode_transfer::verify_staged_bundle(&descriptor, &stage_dir)
            .map_err(|_| "OpenCode repair stage does not match its descriptor")?;
    let provider_env = std::env::vars().collect::<std::collections::BTreeMap<_, _>>();
    let paths = plan_opencode_reader_paths_at(
        &provider_env,
        &workspace,
        &cwd,
        Path::new(OPENCODE_PROVIDER_HOME),
    )?;
    if std::env::current_dir().map_err(|_| "repair helper working directory is unavailable")?
        != paths.cwd
    {
        return Err("OpenCode repair helper cwd differs from the requested provider cwd".into());
    }

    let import_output = run_opencode_provider_helper_with_env(
        &ProviderProcessContext {
            environment: &provider_env,
            uid,
            gid,
        },
        &descriptor,
        &paths.workspace,
        &paths.cwd,
        "opencode-import-worker",
        Some(&payload_path),
    )?;
    let imported: freshell_agent_runtime::opencode_transfer::ImportReceipt =
        serde_json::from_slice(&import_output)
            .map_err(|_| "provider importer returned an invalid repair receipt")?;
    validate_import_receipt_binding(&imported, &descriptor, &paths)?;

    let reader_output = run_opencode_provider_helper_with_env(
        &ProviderProcessContext {
            environment: &provider_env,
            uid,
            gid,
        },
        &descriptor,
        &paths.workspace,
        &paths.cwd,
        "opencode-reader-probe",
        None,
    )?;
    let readable: freshell_agent_runtime::opencode_transfer::InstalledStoreReadable =
        serde_json::from_slice(&reader_output)
            .map_err(|_| "provider reader returned an invalid repair receipt")?;
    validate_reader_receipt_binding(&readable, &descriptor, &paths, uid, gid, &imported)?;

    let receipt = serde_json::json!({
        "imported": imported,
        "readable": readable,
    });
    let bytes = serde_json::to_vec(&receipt)
        .map_err(|_| "stopped OpenCode repair receipts could not be encoded")?;
    if bytes.len() > MAX_OPENCODE_RECEIPT_BYTES {
        return Err("stopped OpenCode repair receipts exceed their bound".into());
    }
    println!("{}", String::from_utf8(bytes).expect("JSON is UTF-8"));
    Ok(())
}

fn validate_import_receipt_binding(
    receipt: &freshell_agent_runtime::opencode_transfer::ImportReceipt,
    descriptor: &OpenCodeTransferDescriptor,
    paths: &OpencodeReaderPaths,
) -> Result<(), String> {
    let manifest: freshell_sessions::opencode_transfer::OpenCodeTransferManifest =
        serde_json::from_str(&descriptor.manifest_json)
            .map_err(|_| "OpenCode manifest cannot be revalidated")?;
    let logical_database = Path::new(&descriptor.destination_database_path);
    if descriptor.destination_database_path != ".local/share/opencode/opencode.db"
        || logical_database.is_absolute()
        || logical_database
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
        || paths.xdg_data_home != paths.home.join(".local/share")
        || paths.xdg_config_home != paths.home.join(".config")
        || paths.database != paths.home.join(logical_database)
        || paths.database != paths.xdg_data_home.join("opencode/opencode.db")
    {
        return Err("provider database path does not match the exact transfer destination".into());
    }
    if receipt.version != 1
        || receipt.transfer_id != descriptor.transfer_id
        || receipt.destination_store_id != descriptor.destination_store_id
        || receipt.destination_database_path != descriptor.destination_database_path
        || receipt.root_session_id != descriptor.root_session_id
        || receipt.source_store_id != descriptor.source_store_id
        || receipt.source_generation != descriptor.source_generation
        || receipt.source_schema_fingerprint != descriptor.source_schema_fingerprint
        || receipt.migration_journal_fingerprint != descriptor.migration_journal_fingerprint
        || receipt.target_image_ref != descriptor.target_image_ref
        || receipt.target_build_receipt != descriptor.target_build_receipt
        || receipt.bundle_sha256 != descriptor.bundle_sha256
        || receipt.row_count != manifest.row_count as u64
        || receipt.asset_count != manifest.assets.len() as u64
        || !is_lower_hex_64(&receipt.structural_sha256)
    {
        return Err("provider importer receipt does not bind to the transfer".into());
    }
    Ok(())
}

fn validate_reader_receipt_binding(
    receipt: &freshell_agent_runtime::opencode_transfer::InstalledStoreReadable,
    descriptor: &OpenCodeTransferDescriptor,
    paths: &OpencodeReaderPaths,
    uid: u32,
    gid: u32,
    import: &freshell_agent_runtime::opencode_transfer::ImportReceipt,
) -> Result<(), String> {
    if receipt.version != 1
        || receipt.transfer_id != descriptor.transfer_id
        || receipt.destination_store_id != descriptor.destination_store_id
        || receipt.root_session_id != descriptor.root_session_id
        || receipt.source_generation != descriptor.source_generation
        || receipt.target_image_ref != descriptor.target_image_ref
        || receipt.target_build_receipt != descriptor.target_build_receipt
        || receipt.provider_uid != uid
        || receipt.provider_gid != gid
        || receipt.home != paths.home.to_string_lossy()
        || receipt.xdg_data_home != paths.xdg_data_home.to_string_lossy()
        || receipt.xdg_config_home != paths.xdg_config_home.to_string_lossy()
        || receipt.opencode_db != paths.database.to_string_lossy()
        || receipt.cwd != paths.cwd.to_string_lossy()
        || receipt.row_count != import.row_count
        || receipt.asset_count != import.asset_count
        || receipt.structural_sha256 != import.structural_sha256
    {
        return Err("provider reader receipt does not match the imported baseline".into());
    }
    Ok(())
}

fn is_lower_hex_64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn persist_opencode_receipt<T>(state_dir: &Path, name: &str, receipt: &T) -> Result<(), String>
where
    T: Serialize + serde::de::DeserializeOwned + PartialEq,
{
    let metadata = std::fs::symlink_metadata(state_dir).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("OpenCode receipt directory is not a real directory".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() != unsafe { libc::geteuid() } {
            return Err("OpenCode receipt directory is not owned by the session host".into());
        }
        std::fs::set_permissions(state_dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    let target = state_dir.join(name);
    match std::fs::symlink_metadata(&target) {
        Ok(existing_meta) => {
            if existing_meta.file_type().is_symlink() || !existing_meta.is_file() {
                return Err("OpenCode durable receipt is not a regular file".into());
            }
            let existing = serde_json::from_slice::<T>(
                &std::fs::read(&target).map_err(|error| error.to_string())?,
            )
            .map_err(|_| "OpenCode durable receipt is invalid")?;
            return if &existing == receipt {
                Ok(())
            } else {
                Err("OpenCode durable receipt conflicts with revalidated state".into())
            };
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    let bytes = serde_json::to_vec(receipt).map_err(|_| "encode OpenCode durable receipt")?;
    if bytes.len() > MAX_OPENCODE_RECEIPT_BYTES {
        return Err("OpenCode durable receipt exceeds its bound".into());
    }
    let temporary = state_dir.join(format!(
        ".{name}.tmp-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let write_result = (|| -> Result<(), String> {
        let mut file = options
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(&bytes).map_err(|error| error.to_string())?;
        #[cfg(test)]
        opencode_host_crash_checkpoint(&format!("receipt.{}.after_temp_write", receipt_kind(name)));
        file.sync_all().map_err(|error| error.to_string())?;
        #[cfg(test)]
        opencode_host_crash_checkpoint(&format!("receipt.{}.after_temp_sync", receipt_kind(name)));
        set_mode(&temporary, 0o400)?;
        match std::fs::hard_link(&temporary, &target) {
            Ok(()) => {
                #[cfg(test)]
                opencode_host_crash_checkpoint(&format!(
                    "receipt.{}.after_link",
                    receipt_kind(name)
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let metadata =
                    std::fs::symlink_metadata(&target).map_err(|read| read.to_string())?;
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err("OpenCode durable receipt is not a regular file".into());
                }
                let existing = serde_json::from_slice::<T>(
                    &std::fs::read(&target).map_err(|read| read.to_string())?,
                )
                .map_err(|_| "OpenCode durable receipt is invalid")?;
                if &existing != receipt {
                    return Err("OpenCode durable receipt conflicts with revalidated state".into());
                }
            }
            Err(error) => return Err(error.to_string()),
        }
        std::fs::remove_file(&temporary).map_err(|error| error.to_string())?;
        #[cfg(test)]
        opencode_host_crash_checkpoint(&format!(
            "receipt.{}.after_temp_remove",
            receipt_kind(name)
        ));
        std::fs::File::open(state_dir)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| error.to_string())?;
        #[cfg(test)]
        opencode_host_crash_checkpoint(&format!(
            "receipt.{}.after_directory_sync",
            receipt_kind(name)
        ));
        Ok(())
    })();
    if write_result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    write_result
}

#[cfg(test)]
fn receipt_kind(name: &str) -> &'static str {
    if name.ends_with("-import.json") {
        "import"
    } else if name.ends_with("-readable.json") {
        "readable"
    } else {
        "other"
    }
}

#[cfg(test)]
fn opencode_host_crash_checkpoint(point: &str) {
    if std::env::var("FRESHELL_OPENCODE_HOST_CRASH_POINT").as_deref() == Ok(point) {
        unsafe {
            libc::kill(libc::getpid(), libc::SIGKILL);
        }
        std::process::abort();
    }
}

fn read_opencode_receipt<T>(state_dir: &Path, name: &str) -> Result<T, String>
where
    T: serde::de::DeserializeOwned,
{
    let path = state_dir.join(name);
    let metadata = std::fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("OpenCode durable receipt is not a regular file".into());
    }
    if metadata.len() > MAX_OPENCODE_RECEIPT_BYTES as u64 {
        return Err("OpenCode durable receipt exceeds its bound".into());
    }
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|_| "OpenCode durable receipt is invalid".into())
}

fn prepare_provider_state_for_fresh_launch(
    terminal: &mut TerminalLaunchSpec,
) -> Result<(), RuntimeError> {
    prepare_provider_state_for_fresh_launch_at(
        terminal,
        &ProviderConfigPaths::default(),
        Path::new("/run/freshell-bootstrap"),
    )
}

fn prepare_provider_state_for_opencode_transfer_at(
    terminal: &mut TerminalLaunchSpec,
    paths: &ProviderConfigPaths,
    bootstrap_root: &Path,
) -> Result<bool, RuntimeError> {
    if terminal.mode != "opencode" || terminal.opencode_transfer.is_none() {
        return Err(RuntimeError::new(
            RuntimeErrorCode::InvalidRequest,
            "provider-home history preparation requires an OpenCode transfer",
        ));
    }
    let metadata = std::fs::symlink_metadata(&paths.provider_home).map_err(|error| {
        RuntimeError::new(
            RuntimeErrorCode::HostUnreachable,
            format!("OpenCode provider HOME is unavailable: {error}"),
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(RuntimeError::new(
            RuntimeErrorCode::HostUnreachable,
            "OpenCode provider HOME is not a real directory",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() == terminal.run_as_uid
            && metadata.gid() == terminal.run_as_gid
            && metadata.permissions().mode() & 0o777 == 0o700
        {
            // A prior attempt completed the provider-state handoff. The owner
            // is assigned last by preparation, so this is also the retry marker.
            return Ok(false);
        }
    }

    prepare_provider_state_for_fresh_launch_at(terminal, paths, bootstrap_root)?;
    Ok(true)
}

fn prepare_provider_state_for_fresh_launch_at(
    terminal: &mut TerminalLaunchSpec,
    paths: &ProviderConfigPaths,
    bootstrap_root: &Path,
) -> Result<(), RuntimeError> {
    prepare_provider_state_before_bootstrap_with(
        terminal,
        |terminal| {
            let mut created = providers::prepare_provider_state_before_bootstrap_at(
                terminal,
                &paths.provider_home,
                &paths.private_mount.join("user-provider"),
            )?;
            match write_provider_bootstrap_files(
                &terminal.mode,
                &terminal.provider_bootstrap_files,
                &paths.provider_home,
                bootstrap_root,
            ) {
                Ok(bootstrap) => created.extend(bootstrap),
                Err(error) => {
                    rollback_created_provider_paths(&created);
                    return Err(error);
                }
            }
            Ok(created)
        },
        |terminal, created| {
            transfer_created_paths(
                &terminal.mode,
                &paths.provider_home,
                created,
                terminal.run_as_uid,
                terminal.run_as_gid,
            )
        },
        |terminal| prepare_provider_context_for_fresh_launch(terminal, paths),
    )
}

fn prepare_provider_state_before_bootstrap_with(
    terminal: &mut TerminalLaunchSpec,
    prepare_state: impl FnOnce(&mut TerminalLaunchSpec) -> Result<Vec<PathBuf>, String>,
    transfer_state: impl FnOnce(&TerminalLaunchSpec, &[PathBuf]) -> Result<(), String>,
    prepare_context: impl FnOnce(&TerminalLaunchSpec) -> Result<(), String>,
) -> Result<(), RuntimeError> {
    let created = prepare_state(terminal).map_err(|error| {
        RuntimeError::new(
            RuntimeErrorCode::HostUnreachable,
            format!("prepare managed provider state: {error}"),
        )
    })?;
    transfer_state(terminal, &created).map_err(|error| {
        RuntimeError::new(
            RuntimeErrorCode::HostUnreachable,
            format!("transfer managed provider state: {error}"),
        )
    })?;
    prepare_context(terminal).map_err(|error| {
        RuntimeError::new(
            RuntimeErrorCode::HostUnreachable,
            format!("prepare provider config: {error}"),
        )
    })
}

fn transfer_created_paths(
    provider: &str,
    home: &Path,
    created: &[PathBuf],
    uid: u32,
    gid: u32,
) -> Result<(), String> {
    let mut paths = created
        .iter()
        .cloned()
        .collect::<std::collections::BTreeSet<_>>();
    if paths.len() > freshell_platform::provider_environment::CopyLimits::default().max_entries {
        return Err(format!(
            "created provider paths exceed shared entry bound: observed {}, permitted 100000",
            paths.len()
        ));
    }
    for path in &paths {
        if !path.starts_with(home)
            || path
                .strip_prefix(home)
                .map_err(|error| error.to_string())?
                .components()
                .any(|part| !matches!(part, std::path::Component::Normal(_)))
        {
            return Err("created provider ownership path is outside the physical HOME".into());
        }
        std::fs::symlink_metadata(path).map_err(|error| {
            format!("inspect created provider path {}: {error}", path.display())
        })?;
        // The leaf may be a selected link, but no traversed parent may be one.
        for parent in path
            .parent()
            .into_iter()
            .flat_map(Path::ancestors)
            .take_while(|parent| parent.starts_with(home))
        {
            if std::fs::symlink_metadata(parent)
                .map_err(|error| error.to_string())?
                .file_type()
                .is_symlink()
            {
                return Err("created ownership path has a symbolic-link parent".into());
            }
        }
    }
    let started = std::time::Instant::now();
    let entries = paths.len();
    emit_environment_event(serde_json::json!({
        "severity": "info", "event": "provider.environment.ownership.started",
        "stage": "session_host", "provider": provider, "entries": entries
    }));
    let mut ordered = std::mem::take(&mut paths).into_iter().collect::<Vec<_>>();
    ordered.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for path in ordered {
        set_owner(&path, uid, gid).inspect_err(|error| {
            emit_environment_event(serde_json::json!({
                "severity": "error", "event": "provider.environment.ownership.failed",
                "stage": "session_host", "provider": provider,
                "relative_path": path.strip_prefix(home).unwrap_or(Path::new("")),
                "elapsed_ms": started.elapsed().as_millis() as u64,
                "operation": "lchown", "target_uid": uid, "target_gid": gid,
                "error": error
            }));
        })?;
    }
    emit_environment_event(serde_json::json!({
        "severity": "info", "event": "provider.environment.ownership.completed",
        "stage": "session_host", "provider": provider, "entries": entries,
        "elapsed_ms": started.elapsed().as_millis() as u64
    }));
    Ok(())
}

fn prepare_provider_bootstrap_files(
    provider: &str,
    files: &[ProviderBootstrapFile],
    run_as_uid: u32,
    run_as_gid: u32,
) -> Result<(), String> {
    let home = Path::new("/home/freshell/provider");
    let created = write_provider_bootstrap_files(
        provider,
        files,
        home,
        Path::new("/run/freshell-bootstrap"),
    )?;
    transfer_created_paths(provider, home, &created, run_as_uid, run_as_gid)
}

fn rollback_created_provider_paths(paths: &[PathBuf]) {
    let mut paths = paths.iter().collect::<Vec<_>>();
    paths.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for path in paths {
        if let Ok(metadata) = std::fs::symlink_metadata(path) {
            if metadata.is_dir() {
                let _ = std::fs::remove_dir(path);
            } else {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}
fn write_provider_bootstrap_files(
    provider: &str,
    files: &[ProviderBootstrapFile],
    home: &Path,
    source_root: &Path,
) -> Result<Vec<PathBuf>, String> {
    write_provider_bootstrap_files_with_publish(
        provider,
        files,
        home,
        source_root,
        |source, destination| std::fs::rename(source, destination),
    )
}

fn write_provider_bootstrap_files_with_publish(
    provider: &str,
    files: &[ProviderBootstrapFile],
    home: &Path,
    source_root: &Path,
    mut publish: impl FnMut(&Path, &Path) -> std::io::Result<()>,
) -> Result<Vec<PathBuf>, String> {
    use freshell_platform::provider_environment::CopySelection;
    if !std::fs::symlink_metadata(home)
        .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
    {
        return Err("managed provider HOME volume is not mounted as a physical directory".into());
    }
    // This writer runs only during trusted initial preparation, before HOME
    // ownership is handed to the provider. Refresh preserves the initialized root.
    set_mode(home, 0o700)?;
    let mut destinations = Vec::with_capacity(files.len());
    for file in files {
        let relative = Path::new(&file.provider_relative_path);
        if relative.as_os_str().is_empty()
            || relative
                .components()
                .any(|part| !matches!(part, std::path::Component::Normal(_)))
        {
            return Err("provider bootstrap destination is unsafe".into());
        }
        let mut parent = home.to_path_buf();
        for part in relative.parent().into_iter().flat_map(Path::components) {
            parent.push(part.as_os_str());
            match std::fs::symlink_metadata(&parent) {
                Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
                Ok(_) => {
                    return Err("provider bootstrap parent must be a physical directory".into())
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
            }
        }
        let destination = home.join(relative);
        match std::fs::symlink_metadata(&destination) {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {}
            Ok(_) => return Err("provider bootstrap destination must be a regular file".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        if destinations.iter().any(|other: &PathBuf| {
            destination.starts_with(other) || other.starts_with(&destination)
        }) {
            return Err("provider bootstrap destinations overlap".into());
        }
        destinations.push(destination);
    }
    let selections = files
        .iter()
        .enumerate()
        .map(|(index, file)| {
            let source = source_root.join(format!("provider-{index}"));
            let metadata = std::fs::symlink_metadata(&source)
                .map_err(|_| "provider bootstrap input is unavailable")?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err("provider bootstrap input must be a regular file".to_owned());
            }
            Ok(CopySelection {
                source: std::fs::canonicalize(source)
                    .map_err(|_| "provider bootstrap input is unavailable")?,
                destination_relative: file.provider_relative_path.clone().into(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let publication = freshell_platform::provider_environment::stage_environment_with_publication(
        &selections,
        home,
        &[],
        Default::default(),
        &mut publish,
    )
    .map_err(|error| error.to_string())?;
    let mut paths = publication
        .created_paths()
        .iter()
        .map(|path| home.join(path))
        .collect::<Vec<_>>();
    publication.commit().map_err(|error| error.to_string())?;
    paths.push(home.to_owned());
    emit_environment_event(
        serde_json::json!({"severity":"info","event":"provider.bootstrap.published","provider":provider,"entries":paths.len()}),
    );
    Ok(paths)
}

// Preparation produces at most start/completion (or failure) records per copy,
// never per-file events. Keep protocol stdout exclusively for its existing uses.
fn emit_environment_event(event: serde_json::Value) {
    use std::io::Write;
    let line = freshell_runtime_observability::scrub(&event.to_string(), "");
    let _ = writeln!(std::io::stderr().lock(), "{line}");
}

fn copy_environment_with_events(
    stage: &str,
    provider: &str,
    selections: &[freshell_platform::provider_environment::CopySelection],
    destination: &Path,
    excluded: &[PathBuf],
) -> Result<
    freshell_platform::provider_environment::CopyReport,
    freshell_platform::provider_environment::CopyError,
> {
    let started = std::time::Instant::now();
    emit_environment_event(serde_json::json!({
        "severity": "info", "event": "provider.environment.copy.started",
        "stage": stage, "provider": provider, "selections": selections.len()
    }));
    let report = freshell_platform::provider_environment::copy_environment(
        selections,
        destination,
        excluded,
        Default::default(),
    )
    .inspect_err(|error| {
        emit_environment_event(serde_json::json!({
            "severity": "error", "event": "provider.environment.copy.failed",
            "stage": stage, "provider": provider,
            "relative_path": error.relative_path, "operation": error.operation,
            "limit_kind": error.limit_kind, "observed": error.observed,
            "permitted": error.permitted, "corrective_message": error.corrective_message,
            "elapsed_ms": started.elapsed().as_millis() as u64
        }));
    })?;
    emit_environment_event(serde_json::json!({
        "severity": "info", "event": "provider.environment.copy.completed",
        "stage": stage, "provider": provider, "entries": report.entries,
        "bytes": report.bytes, "elapsed_ms": started.elapsed().as_millis() as u64
    }));
    Ok(report)
}

fn copy_provider_config_references(
    context: &freshell_runtime_protocol::ProviderLaunchContext,
    provider: &str,
    workspace: &Path,
    user_provider_root: &Path,
    provider_home: &Path,
    run_as_uid: u32,
    run_as_gid: u32,
) -> Result<(), String> {
    copy_provider_config_references_with_ownership(
        context,
        provider,
        workspace,
        user_provider_root,
        provider_home,
        (run_as_uid, run_as_gid),
    )
}

fn copy_provider_config_references_with_ownership(
    context: &freshell_runtime_protocol::ProviderLaunchContext,
    provider: &str,
    workspace: &Path,
    user_provider_root: &Path,
    provider_home: &Path,
    run_as: (u32, u32),
) -> Result<(), String> {
    use freshell_platform::provider_environment::CopySelection;
    use freshell_runtime_protocol::ProviderConfigRoot;
    context.validate(provider).map_err(|error| error.message)?;
    let selections = provider_config_references(context)
        .into_iter()
        .map(|reference| {
            let root = match reference.root {
                ProviderConfigRoot::Workspace => workspace.to_path_buf(),
                ProviderConfigRoot::UserProvider => user_provider_root.to_path_buf(),
                ProviderConfigRoot::Ephemeral => user_provider_root.join("ephemeral"),
            };
            CopySelection {
                source: root.join(&reference.relative_path),
                destination_relative: reference.provider_relative_path.clone().into(),
            }
        })
        .collect::<Vec<_>>();
    let excluded = provider_credential_sources(user_provider_root);
    let report = copy_environment_with_events(
        "session_host",
        provider,
        &selections,
        provider_home,
        &excluded,
    )
    .map_err(|error| error.to_string())?;
    let projected = report
        .projected_paths
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect::<std::collections::BTreeSet<_>>();
    let mut ownership_paths = report
        .projected_paths
        .into_iter()
        .map(|path| provider_home.join(path))
        .collect::<Vec<_>>();
    ownership_paths.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for path in ownership_paths {
        set_owner(&path, run_as.0, run_as.1)?;
    }
    let manifest = write_projection_manifest(provider_home, &projected)?;
    set_owner(&manifest, run_as.0, run_as.1)?;
    Ok(())
}
fn provider_credential_sources(root: &Path) -> Vec<PathBuf> {
    [
        ".credentials.json",
        "auth.json",
        "keys.env",
        ".env",
        "credentials",
        "secrets",
        "token.json",
    ]
    .into_iter()
    .filter_map(|name| std::fs::canonicalize(root.join(name)).ok())
    .collect()
}

const PROVIDER_PROJECTION_MANIFEST: &str = ".freshell-config-projection.json";

fn write_projection_manifest(
    provider_home: &Path,
    entries: &std::collections::BTreeSet<String>,
) -> Result<PathBuf, String> {
    let manifest = provider_home.join(PROVIDER_PROJECTION_MANIFEST);
    let temporary = provider_home.join(format!(
        "{PROVIDER_PROJECTION_MANIFEST}.tmp-{}",
        std::process::id()
    ));
    std::fs::write(
        &temporary,
        serde_json::to_vec(entries).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    set_mode(&temporary, 0o600)?;
    std::fs::rename(&temporary, &manifest).map_err(|error| error.to_string())?;
    Ok(manifest)
}

fn read_projection_manifest(
    provider_home: &Path,
) -> Result<std::collections::BTreeSet<String>, String> {
    match std::fs::read(provider_home.join(PROVIDER_PROJECTION_MANIFEST)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Default::default()),
        Err(error) => Err(error.to_string()),
    }
}

fn provider_config_references(
    context: &freshell_runtime_protocol::ProviderLaunchContext,
) -> Vec<&freshell_runtime_protocol::ProviderConfigReference> {
    let mut references = context.config.iter().collect::<Vec<_>>();
    if let freshell_runtime_protocol::ProviderPreparation::Opencode {
        project_config,
        tui_config,
        ..
    } = &context.preparation
    {
        references.extend(project_config.iter());
        references.extend(tui_config.iter());
    }
    references
}

fn refresh_provider_context(
    context: Option<&freshell_runtime_protocol::ProviderLaunchContext>,
    provider: &str,
    workspace: &str,
    run_as_uid: u32,
    run_as_gid: u32,
    paths: &ProviderConfigPaths,
) -> Result<(), String> {
    let Some(context) = context else {
        return Ok(());
    };
    let private_mount = &paths.private_mount;
    let user_root = private_mount.join("user-provider");
    if provider_config_references(context).iter().any(|reference| {
        reference.root == freshell_runtime_protocol::ProviderConfigRoot::UserProvider
    }) && !user_root.is_dir()
    {
        return Err("provider user config mount is unavailable".into());
    }
    refresh_provider_config_references(
        context,
        provider,
        Path::new(workspace),
        &user_root,
        &paths.provider_home,
        run_as_uid,
        run_as_gid,
    )
}

fn refresh_provider_config_references(
    context: &freshell_runtime_protocol::ProviderLaunchContext,
    provider: &str,
    workspace: &Path,
    user_provider_root: &Path,
    provider_home: &Path,
    run_as_uid: u32,
    run_as_gid: u32,
) -> Result<(), String> {
    context.validate(provider).map_err(|error| error.message)?;
    let stage = tempfile::tempdir().map_err(|error| error.to_string())?;
    let projection = stage.path().join("projection");
    std::fs::create_dir(&projection).map_err(|error| error.to_string())?;
    copy_provider_config_references(
        context,
        provider,
        workspace,
        user_provider_root,
        &projection,
        unsafe { libc::geteuid() },
        unsafe { libc::getegid() },
    )?;
    let destinations = provider_config_references(context)
        .iter()
        .map(|reference| reference.provider_relative_path.clone())
        .collect::<Vec<_>>();
    std::fs::write(
        stage.path().join("manifest.json"),
        serde_json::to_vec(&destinations).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    std::fs::write(
        stage.path().join("provider.json"),
        serde_json::to_vec(provider).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    allow_provider_read_stage(stage.path(), run_as_gid)?;
    if run_as_uid == unsafe { libc::geteuid() } && run_as_gid == unsafe { libc::getegid() } {
        return apply_staged_provider_config(stage.path(), provider_home);
    }
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let status = std::process::Command::new("/usr/bin/setpriv")
        .args(provider_identity_args(run_as_uid, run_as_gid))
        .arg(exe)
        .arg("refresh-provider-config")
        .arg(stage.path())
        .arg(provider_home)
        .status()
        .map_err(|error| format!("provider-owned config refresh failed to start: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "provider-owned config refresh failed with status {status}"
        ))
    }
}

fn provider_identity_args(uid: u32, gid: u32) -> Vec<String> {
    let group_option = if uid == unsafe { libc::geteuid() } && gid == unsafe { libc::getegid() } {
        "--keep-groups"
    } else {
        "--clear-groups"
    };
    vec![
        "--reuid".into(),
        uid.to_string(),
        "--regid".into(),
        gid.to_string(),
        group_option.into(),
        "--no-new-privs".into(),
        "--".into(),
    ]
}

fn allow_provider_read_stage(path: &Path, gid: u32) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;

    set_owner(path, unsafe { libc::geteuid() }, gid)?;
    if metadata.file_type().is_symlink() {
        return Ok(());
    }
    if metadata.is_dir() {
        set_mode(path, 0o750)?;
        for entry in std::fs::read_dir(path).map_err(|error| error.to_string())? {
            allow_provider_read_stage(&entry.map_err(|error| error.to_string())?.path(), gid)?;
        }
    } else if metadata.is_file() {
        {
            use std::os::unix::fs::PermissionsExt;
            set_mode(
                path,
                freshell_platform::provider_environment::provider_read_stage_mode(
                    metadata.permissions().mode(),
                ),
            )?;
        }
    } else {
        return Err("staged provider config must be a regular file or directory".into());
    }
    Ok(())
}

fn refresh_provider_config_worker(args: &[String]) -> Result<(), String> {
    if args.len() != 2 {
        return Err("refresh-provider-config requires stage and provider home".into());
    }
    apply_staged_provider_config(Path::new(&args[0]), Path::new(&args[1]))
}

fn apply_staged_provider_config(stage: &Path, provider_home: &Path) -> Result<(), String> {
    let destinations: Vec<String> = serde_json::from_slice(
        &std::fs::read(stage.join("manifest.json")).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let projection = stage.join("projection");
    let previous = read_projection_manifest(provider_home)?;
    let current = read_projection_manifest(&projection)?;
    let mut paths = Vec::with_capacity(destinations.len());
    for relative in destinations
        .iter()
        .chain(previous.iter())
        .chain(current.iter())
    {
        let path = Path::new(relative);
        if path.as_os_str().is_empty()
            || path.is_absolute()
            || path
                .components()
                .any(|part| !matches!(part, std::path::Component::Normal(_)))
        {
            return Err("provider config refresh destination is unsafe".into());
        }
        // Destination selections are logical graph routes, and may traverse a
        // selected skills alias. The common copier resolves those routes from
        // the staged graph, then validates every physical publication parent.
        // Manifest entries instead name physical inodes used for stale removal.
        if previous.contains(relative) || current.contains(relative) {
            let mut parent = provider_home.to_path_buf();
            for part in path.parent().into_iter().flat_map(Path::components) {
                parent.push(part.as_os_str());
                if std::fs::symlink_metadata(&parent)
                    .is_ok_and(|metadata| metadata.file_type().is_symlink())
                {
                    return Err(
                        "provider config refresh physical parent cannot be a symlink".into(),
                    );
                }
            }
        }
        if destinations
            .iter()
            .any(|destination| destination == relative)
        {
            paths.push(path.to_path_buf());
        }
    }
    paths.sort();
    paths.dedup();
    paths.sort_by_key(|path| path.components().count());
    let selections = paths
        .iter()
        .map(
            |path| freshell_platform::provider_environment::CopySelection {
                source: projection.join(path),
                destination_relative: path.clone(),
            },
        )
        .collect::<Vec<_>>();
    let provider = match std::fs::read(stage.join("provider.json")) {
        Ok(bytes) => serde_json::from_slice::<String>(&bytes).map_err(|error| error.to_string())?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => "unknown".into(),
        Err(error) => return Err(error.to_string()),
    };
    if !matches!(
        provider.as_str(),
        "claude" | "codex" | "opencode" | "amplifier" | "unknown"
    ) {
        return Err("provider config refresh provider is unsupported".into());
    }
    let mut selections = selections;
    selections.push(freshell_platform::provider_environment::CopySelection {
        source: projection.join(PROVIDER_PROJECTION_MANIFEST),
        destination_relative: PROVIDER_PROJECTION_MANIFEST.into(),
    });
    let mut publication=freshell_platform::provider_environment::stage_environment(&selections,provider_home,&[],Default::default()).inspect_err(|error| {
        emit_environment_event(serde_json::json!({"severity":"error","event":"provider.environment.copy.failed","stage":"provider_publication","provider":provider,"relative_path":error.relative_path,"operation":error.operation,"limit_kind":error.limit_kind,"corrective_message":error.corrective_message}));
    }).map_err(|error|error.to_string())?;
    let mut stale = previous.difference(&current).collect::<Vec<_>>();
    stale.sort_by_key(|path| std::cmp::Reverse(Path::new(path).components().count()));
    for relative in stale {
        publication
            .remove_obsolete(Path::new(relative))
            .map_err(|error| error.to_string())?;
    }
    let report = publication.commit().map_err(|error| error.to_string())?;
    emit_environment_event(
        serde_json::json!({"severity":"info","event":"provider.environment.copy.completed","stage":"provider_publication","provider":provider,"entries":report.entries,"bytes":report.bytes}),
    );
    Ok(())
}

fn prepare_provider_context(
    context: Option<&freshell_runtime_protocol::ProviderLaunchContext>,
    provider: &str,
    workspace: &str,
    run_as_uid: u32,
    run_as_gid: u32,
) -> Result<(), String> {
    prepare_provider_context_at(
        context,
        provider,
        workspace,
        run_as_uid,
        run_as_gid,
        &ProviderConfigPaths::default(),
    )
}
fn prepare_provider_context_for_fresh_launch(
    terminal: &TerminalLaunchSpec,
    paths: &ProviderConfigPaths,
) -> Result<(), String> {
    prepare_provider_context_at(
        terminal.provider_launch_context.as_ref(),
        &terminal.mode,
        &terminal.workspace_path,
        terminal.run_as_uid,
        terminal.run_as_gid,
        paths,
    )
}
fn prepare_provider_context_at(
    context: Option<&freshell_runtime_protocol::ProviderLaunchContext>,
    provider: &str,
    workspace: &str,
    run_as_uid: u32,
    run_as_gid: u32,
    paths: &ProviderConfigPaths,
) -> Result<(), String> {
    let Some(context) = context else {
        return Ok(());
    };
    let user_root = paths.private_mount.join("user-provider");
    if provider_config_references(context).iter().any(|reference| {
        reference.root == freshell_runtime_protocol::ProviderConfigRoot::UserProvider
    }) && !user_root.is_dir()
    {
        return Err("provider user config mount is unavailable".into());
    }
    if user_root.exists() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let metadata =
                std::fs::symlink_metadata(&user_root).map_err(|error| error.to_string())?;
            if metadata.file_type().is_symlink()
                || metadata.uid() != unsafe { libc::geteuid() }
                || metadata.gid() != unsafe { libc::getegid() }
            {
                return Err("provider input bind does not map to trusted uid/group 0; stage with the same supported rootless daemon account and retry".into());
            }
        }
    }
    // The trusted host's private bind parent permits provider group 0 traversal
    // without exposing the separate private control/grant directories.
    if paths.private_mount.exists() {
        let metadata =
            std::fs::symlink_metadata(&paths.private_mount).map_err(|error| error.to_string())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("provider private bind parent must be a trusted physical directory".into());
        }
        set_owner(&paths.private_mount, unsafe { libc::geteuid() }, unsafe {
            libc::getegid()
        })?;
        set_mode(&paths.private_mount, 0o710)?;
    }
    refresh_provider_config_references(
        context,
        provider,
        Path::new(workspace),
        &user_root,
        &paths.provider_home,
        run_as_uid,
        run_as_gid,
    )
}

fn prepare_provider_files(
    provider: &str,
    provider_files: &[(&str, Vec<u8>)],
    run_as_uid: u32,
    run_as_gid: u32,
) -> Result<(), String> {
    prepare_provider_files_at(
        provider,
        provider_files,
        run_as_uid,
        run_as_gid,
        Path::new("/home/freshell/provider"),
        Path::new("/tmp/freshell-provider-auth"),
    )
}

fn prepare_provider_files_at(
    _provider: &str,
    provider_files: &[(&str, Vec<u8>)],
    run_as_uid: u32,
    run_as_gid: u32,
    home: &Path,
    auth_dir: &Path,
) -> Result<(), String> {
    // No new publication grants authority over credentials already retained
    // in the exact provider volume (including the Kilroy bootstrap exception).
    if provider_files.is_empty() {
        return Ok(());
    }
    std::fs::create_dir_all(auth_dir).map_err(|_| "provider secret stage is unavailable")?;
    set_mode(auth_dir, 0o711)?;
    let attempt = tempfile::Builder::new()
        .prefix("provider-inputs-")
        .tempdir_in(auth_dir)
        .map_err(|_| "provider secret attempt cannot be staged")?;
    let stage = attempt.path();
    set_mode(stage, 0o711)?;
    let mut relatives = Vec::with_capacity(provider_files.len());
    for (index, (relative, contents)) in provider_files.iter().enumerate() {
        if !matches!(
            *relative,
            ".claude/.credentials.json"
                | ".codex/auth.json"
                | ".local/share/opencode/auth.json"
                | ".amplifier/keys.env"
                | ".config/onecli/gateway-ca.pem"
        ) {
            return Err("unsupported provider secret publication path".into());
        }
        let target = stage.join(format!("provider-{index}"));
        let temporary = stage.join(format!(".provider-{index}-{}", std::process::id()));
        let mut options = std::fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|_| "provider secret input cannot be created")?;
        file.write_all(contents)
            .and_then(|()| file.sync_all())
            .map_err(|_| "provider secret input cannot be synchronized")?;
        std::fs::rename(&temporary, &target)
            .map_err(|_| "provider secret input cannot be published")?;
        set_mode(&target, 0o600)?;
        set_owner(&target, run_as_uid, run_as_gid)?;
        relatives.push(*relative);
    }
    let manifest = stage.join("provider-files.json");
    let temporary = stage.join(format!(".provider-files-{}", std::process::id()));
    std::fs::write(
        &temporary,
        serde_json::to_vec(&relatives).map_err(|_| "encode provider publication metadata")?,
    )
    .map_err(|_| "write provider publication metadata")?;
    set_mode(&temporary, 0o640)?;
    std::fs::rename(&temporary, &manifest).map_err(|_| "publish provider publication metadata")?;
    if run_as_uid == unsafe { libc::geteuid() } && run_as_gid == unsafe { libc::getegid() } {
        return publish_provider_files(stage, home);
    }
    let executable =
        std::env::current_exe().map_err(|_| "provider publication helper is unavailable")?;
    run_provider_path_command(
        run_as_uid,
        run_as_gid,
        executable
            .to_str()
            .ok_or("provider publication helper path is invalid")?,
        &[
            "publish-provider-files",
            stage
                .to_str()
                .ok_or("provider secret stage path is invalid")?,
            home.to_str().ok_or("provider HOME path is invalid")?,
        ],
    )
}

fn publish_provider_files(stage: &Path, home: &Path) -> Result<(), String> {
    let manifest = std::fs::read(stage.join("provider-files.json"))
        .map_err(|_| "provider publication metadata is unavailable")?;
    if manifest.len() > 4096 {
        return Err("provider publication metadata exceeds its bound".into());
    }
    let relatives: Vec<String> = serde_json::from_slice(&manifest)
        .map_err(|_| "provider publication metadata is invalid")?;
    if relatives.is_empty() || relatives.len() > 16 {
        return Err("provider publication count is invalid".into());
    }
    let mut seen = std::collections::BTreeSet::new();
    let selections = relatives
        .iter()
        .enumerate()
        .map(|(index, relative)| {
            if !matches!(
                relative.as_str(),
                ".claude/.credentials.json"
                    | ".codex/auth.json"
                    | ".local/share/opencode/auth.json"
                    | ".amplifier/keys.env"
                    | ".config/onecli/gateway-ca.pem"
            ) || !seen.insert(relative)
            {
                return Err("provider publication destination is invalid or duplicated".to_owned());
            }
            Ok(freshell_platform::provider_environment::CopySelection {
                source: stage.join(format!("provider-{index}")),
                destination_relative: relative.into(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    freshell_platform::provider_environment::copy_environment(
        &selections,
        home,
        &[],
        Default::default(),
    )
    .map_err(|error| error.to_string())?;
    emit_environment_event(
        serde_json::json!({"severity":"info","event":"provider.secret_files.published","entries":relatives.len(),"provider_uid":unsafe{libc::geteuid()},"provider_gid":unsafe{libc::getegid()}}),
    );
    Ok(())
}

fn run_provider_path_command(
    uid: u32,
    gid: u32,
    program: &str,
    args: &[&str],
) -> Result<(), String> {
    let status = std::process::Command::new("/usr/bin/setpriv")
        .args(provider_identity_args(uid, gid))
        .arg(program)
        .args(args)
        .status()
        .map_err(|error| format!("provider-owned auth path operation failed to start: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "provider-owned auth path operation failed with status {status}"
        ))
    }
}

#[cfg(test)]
fn copy_provider_config_entry(
    _source_root: &Path,
    source: &Path,
    destination: &Path,
    copied: &mut Vec<PathBuf>,
    entries: &mut usize,
    _depth: usize,
) -> Result<(), String> {
    use freshell_platform::provider_environment::{copy_environment, CopyLimits, CopySelection};
    let root = destination
        .parent()
        .ok_or("provider destination has no parent")?;
    let report = copy_environment(
        &[CopySelection {
            source: source.to_owned(),
            destination_relative: destination
                .file_name()
                .ok_or("provider destination has no name")?
                .into(),
        }],
        root,
        &[],
        CopyLimits::default(),
    )
    .map_err(|error| error.to_string())?;
    *entries += report.entries;
    copied.extend(
        report
            .projected_paths
            .into_iter()
            .map(|path| root.join(path)),
    );
    Ok(())
}

#[cfg(unix)]
fn set_owner(path: &Path, uid: u32, gid: u32) -> Result<(), String> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let path_c = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| format!("path contains NUL: {}", path.display()))?;
    // SAFETY: path_c is NUL terminated and remains alive for the call.
    let rc = unsafe { libc::lchown(path_c.as_ptr(), uid, gid) };
    if rc == 0 {
        #[cfg(test)]
        tests::created_path_ownership::OPERATIONS
            .with(|operations| operations.borrow_mut().push(path.to_path_buf()));
        Ok(())
    } else {
        Err(format!(
            "chown {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        ))
    }
}

#[cfg(not(unix))]
fn set_owner(_path: &Path, _uid: u32, _gid: u32) -> Result<(), String> {
    Err("managed provider uid/gid isolation requires Unix".into())
}

fn registry_like_error(error: String) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::RegistryFailure, error)
}

async fn worker(args: &[String]) -> Result<(), String> {
    let fixture = required_arg(args, "--fixture")?;
    let state_dir = PathBuf::from(required_arg(args, "--state-dir")?);
    let provider_state_dir = optional_arg(args, "--provider-state-dir")
        .map(PathBuf::from)
        .unwrap_or_else(|| state_dir.clone());
    let resume_session_id = optional_arg(args, "--resume-session-id");
    let soul = required_arg(args, "--soul-id")?;
    match fixture.as_str() {
        "heartbeat" => heartbeat_worker(&state_dir, &soul).await,
        "descendants" => descendant_worker(&state_dir).await,
        "cpu_burner" => cpu_burner_worker(&state_dir).await,
        "memory_allocator" => memory_allocator_worker(&state_dir).await,
        "native_session" => {
            native_session_worker(
                &state_dir,
                &provider_state_dir,
                &soul,
                resume_session_id.as_deref(),
            )
            .await
        }
        "security" => security_worker(&state_dir).await,
        _ => Err(format!("unknown fixture {fixture}")),
    }
}

async fn heartbeat_worker(state_dir: &Path, soul: &str) -> Result<(), String> {
    loop {
        let value = serde_json::json!({"pid":std::process::id(),"soulId":soul,"at":now_millis()});
        atomic_write(
            &state_dir.join("heartbeat.json"),
            &serde_json::to_vec(&value).map_err(|e| e.to_string())?,
        )?;
        sleep(Duration::from_millis(100)).await;
    }
}

async fn cpu_burner_worker(state_dir: &Path) -> Result<(), String> {
    const WORKERS: usize = 4;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut child_pids = Vec::with_capacity(WORKERS);
    for _ in 0..WORKERS {
        let child = Command::new(&exe)
            .arg("fixture-child")
            .arg("--state-dir")
            .arg(state_dir)
            .arg("--cpu-burn")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        child_pids.push(child.id().unwrap_or(0));
        std::mem::forget(child);
    }
    let value = serde_json::json!({
        "workerPid": std::process::id(),
        "burnerPids": child_pids,
        "boundedWorkers": WORKERS,
    });
    atomic_write(
        &state_dir.join("cpu-burner.json"),
        &serde_json::to_vec(&value).map_err(|e| e.to_string())?,
    )?;
    loop {
        sleep(Duration::from_secs(60)).await;
    }
}

async fn memory_allocator_worker(state_dir: &Path) -> Result<(), String> {
    const BYTES: usize = 32 * 1024 * 1024;
    let mut allocation = vec![0_u8; BYTES];
    for offset in (0..allocation.len()).step_by(4096) {
        allocation[offset] = (offset / 4096) as u8;
    }
    let value = serde_json::json!({
        "workerPid": std::process::id(),
        "allocatedBytes": BYTES,
        "touched": true,
    });
    atomic_write(
        &state_dir.join("memory-allocator.json"),
        &serde_json::to_vec(&value).map_err(|e| e.to_string())?,
    )?;
    loop {
        std::hint::black_box(allocation.as_ptr());
        sleep(Duration::from_secs(60)).await;
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "snake_case")]
enum NativeFixtureRequest {
    Create,
    Resume { session_id: String },
    Remember { key: String, value: String },
    Recall { key: String },
    Checkpoint,
    History,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NativeFixtureState {
    session_id: String,
    history: Vec<String>,
    #[serde(default)]
    memory: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    checkpoint_revision: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeFixtureResponse {
    ok: bool,
    session_id: Option<String>,
    history: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    checkpoint_revision: Option<u64>,
    error: Option<String>,
}

async fn native_session_worker(
    state_dir: &Path,
    provider_state_dir: &Path,
    soul: &str,
    resume_session_id: Option<&str>,
) -> Result<(), String> {
    std::fs::create_dir_all(provider_state_dir).map_err(|error| error.to_string())?;
    let state_path = provider_state_dir.join("native-session-state.json");
    if let Some(expected) = resume_session_id {
        let (mut persisted, restored_revision) = if state_path.exists() {
            (read_native_fixture_state(&state_path)?, None)
        } else if let Some((revision, checkpoint)) =
            read_latest_native_fixture_checkpoint(provider_state_dir)?
        {
            (checkpoint, Some(revision))
        } else {
            return Err(format!(
                "native recovery expected {expected}, but durable provider state and verified checkpoints are absent"
            ));
        };
        if persisted.session_id != expected {
            return Err(format!(
                "native recovery expected {expected}, durable state belongs to {}",
                persisted.session_id
            ));
        }
        if let Some(revision) = restored_revision {
            persisted
                .history
                .push(format!("checkpoint_restore:{revision}"));
            // Restore into the primary path without consuming the retained
            // checkpoint. The source remains available for diagnostics.
            write_native_fixture_state(&state_path, &persisted)?;
        }
        persisted.history.push("automatic_resume".into());
        write_native_fixture_state(&state_path, &persisted)?;
    }

    let socket_path = state_dir.join("native.sock");
    if socket_path.exists() {
        std::fs::remove_file(&socket_path).map_err(|e| e.to_string())?;
    }
    let listener = UnixListener::bind(&socket_path).map_err(|e| e.to_string())?;
    set_mode(&socket_path, 0o600)?;
    atomic_write(
        &state_dir.join("native-session-ready.json"),
        &serde_json::to_vec(&serde_json::json!({
            "socket":"native.sock",
            "soulId":soul,
            "providerStateDir":provider_state_dir,
            "resumedSessionId":resume_session_id,
        }))
        .map_err(|e| e.to_string())?,
    )?;
    loop {
        let (mut stream, _) = listener.accept().await.map_err(|e| e.to_string())?;
        let request: NativeFixtureRequest =
            read_frame(&mut stream).await.map_err(|e| e.to_string())?;
        let response = handle_native_fixture_request(provider_state_dir, soul, request)?;
        write_frame(&mut stream, &response)
            .await
            .map_err(|e| e.to_string())?;
    }
}

fn handle_native_fixture_request(
    provider_state_dir: &Path,
    soul: &str,
    request: NativeFixtureRequest,
) -> Result<NativeFixtureResponse, String> {
    let state_path = provider_state_dir.join("native-session-state.json");
    match request {
        NativeFixtureRequest::Create => {
            let state = if state_path.exists() {
                read_native_fixture_state(&state_path)?
            } else {
                let state = NativeFixtureState {
                    session_id: format!("fixture-native-{soul}"),
                    history: vec!["create".into()],
                    memory: std::collections::BTreeMap::new(),
                    checkpoint_revision: 0,
                };
                write_native_fixture_state(&state_path, &state)?;
                state
            };
            Ok(native_fixture_ok(state))
        }
        NativeFixtureRequest::Resume { session_id } => {
            if !state_path.exists() {
                return Ok(native_fixture_error("session state does not exist"));
            }
            let mut state = read_native_fixture_state(&state_path)?;
            if state.session_id != session_id {
                return Ok(native_fixture_error("native session id mismatch"));
            }
            state.history.push("resume".into());
            write_native_fixture_state(&state_path, &state)?;
            Ok(native_fixture_ok(state))
        }
        NativeFixtureRequest::Remember { key, value } => {
            if !state_path.exists() {
                return Ok(native_fixture_error("session state does not exist"));
            }
            let mut state = read_native_fixture_state(&state_path)?;
            state.memory.insert(key.clone(), value);
            state.history.push(format!("remember:{key}"));
            write_native_fixture_state(&state_path, &state)?;
            Ok(native_fixture_ok(state))
        }
        NativeFixtureRequest::Recall { key } => {
            if !state_path.exists() {
                return Ok(native_fixture_error("session state does not exist"));
            }
            let state = read_native_fixture_state(&state_path)?;
            let value = state.memory.get(&key).cloned();
            let mut response = native_fixture_ok(state);
            response.value = value;
            Ok(response)
        }
        NativeFixtureRequest::Checkpoint => {
            if !state_path.exists() {
                return Ok(native_fixture_error("session state does not exist"));
            }
            let mut state = read_native_fixture_state(&state_path)?;
            state.checkpoint_revision = state
                .checkpoint_revision
                .checked_add(1)
                .ok_or_else(|| "native fixture checkpoint revision overflow".to_string())?;
            let revision = state.checkpoint_revision;
            state.history.push(format!("checkpoint:{revision}"));
            write_native_fixture_state(&state_path, &state)?;
            write_native_fixture_checkpoint(provider_state_dir, revision, &state)?;
            let mut response = native_fixture_ok(state);
            response.checkpoint_revision = Some(revision);
            Ok(response)
        }
        NativeFixtureRequest::History => {
            if !state_path.exists() {
                return Ok(native_fixture_error("session state does not exist"));
            }
            Ok(native_fixture_ok(read_native_fixture_state(&state_path)?))
        }
    }
}

fn read_native_fixture_state(path: &Path) -> Result<NativeFixtureState, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

fn write_native_fixture_state(path: &Path, state: &NativeFixtureState) -> Result<(), String> {
    atomic_write(
        path,
        &serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?,
    )
}

fn native_fixture_checkpoint_dir(provider_state_dir: &Path) -> PathBuf {
    provider_state_dir.join(".freshell/checkpoints/native-session")
}

fn write_native_fixture_checkpoint(
    provider_state_dir: &Path,
    revision: u64,
    state: &NativeFixtureState,
) -> Result<(), String> {
    let directory = native_fixture_checkpoint_dir(provider_state_dir);
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    atomic_write(
        &directory.join(format!("{revision}.json")),
        &serde_json::to_vec_pretty(state).map_err(|error| error.to_string())?,
    )
}

fn read_latest_native_fixture_checkpoint(
    provider_state_dir: &Path,
) -> Result<Option<(u64, NativeFixtureState)>, String> {
    let directory = native_fixture_checkpoint_dir(provider_state_dir);
    if !directory.is_dir() {
        return Ok(None);
    }
    let mut latest: Option<(u64, PathBuf)> = None;
    for entry in std::fs::read_dir(&directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_file()
        {
            continue;
        }
        let path = entry.path();
        let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        let Ok(revision) = stem.parse::<u64>() else {
            continue;
        };
        if latest
            .as_ref()
            .is_none_or(|(current, _)| revision > *current)
        {
            latest = Some((revision, entry.path()));
        }
    }
    let Some((revision, path)) = latest else {
        return Ok(None);
    };
    let state = read_native_fixture_state(&path)?;
    if state.checkpoint_revision != revision {
        return Err(format!(
            "checkpoint {} records revision {}",
            path.display(),
            state.checkpoint_revision
        ));
    }
    Ok(Some((revision, state)))
}

fn native_fixture_ok(state: NativeFixtureState) -> NativeFixtureResponse {
    let checkpoint_revision = (state.checkpoint_revision > 0).then_some(state.checkpoint_revision);
    NativeFixtureResponse {
        ok: true,
        session_id: Some(state.session_id),
        history: state.history,
        value: None,
        checkpoint_revision,
        error: None,
    }
}

fn native_fixture_error(message: &str) -> NativeFixtureResponse {
    NativeFixtureResponse {
        ok: false,
        session_id: None,
        history: Vec::new(),
        value: None,
        checkpoint_revision: None,
        error: Some(message.into()),
    }
}

async fn descendant_worker(state_dir: &Path) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let child = Command::new(exe)
        .arg("fixture-child")
        .arg("--state-dir")
        .arg(state_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let child_pid = child.id().unwrap_or(0);
    let value = serde_json::json!({"workerPid":std::process::id(),"childPid":child_pid});
    atomic_write(
        &state_dir.join("descendants.json"),
        &serde_json::to_vec(&value).map_err(|e| e.to_string())?,
    )?;
    std::mem::forget(child);
    loop {
        sleep(Duration::from_secs(60)).await;
    }
}

async fn fixture_child(args: &[String]) -> Result<(), String> {
    let state_dir = PathBuf::from(required_arg(args, "--state-dir")?);
    if args.iter().any(|arg| arg == "--cpu-burn") {
        let mut value = 0_u64;
        loop {
            value = value.wrapping_mul(6364136223846793005).wrapping_add(1);
            std::hint::black_box(value);
        }
    }
    #[cfg(unix)]
    unsafe {
        libc::setsid();
    }
    // The grandchild is the leaf. Check before spawning so the fixture
    // produces exactly one detached descendant instead of an accidental
    // unbounded recursive process chain.
    if args.iter().any(|arg| arg == "--grandchild") {
        loop {
            sleep(Duration::from_secs(60)).await;
        }
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let grandchild = Command::new(exe)
        .arg("fixture-child")
        .arg("--state-dir")
        .arg(&state_dir)
        .arg("--grandchild")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let value = serde_json::json!({"sessionLeaderPid":std::process::id(),"grandchildPid":grandchild.id().unwrap_or(0)});
    atomic_write(
        &state_dir.join("fixture-tree.json"),
        &serde_json::to_vec(&value).map_err(|e| e.to_string())?,
    )?;
    std::mem::forget(grandchild);
    loop {
        sleep(Duration::from_secs(60)).await;
    }
}

async fn security_worker(state_dir: &Path) -> Result<(), String> {
    let evidence = security_probe(state_dir);
    atomic_write(
        &state_dir.join("security.json"),
        &serde_json::to_vec(&evidence).map_err(|e| e.to_string())?,
    )?;
    loop {
        sleep(Duration::from_secs(60)).await;
    }
}

fn security_probe(state_dir: &Path) -> serde_json::Value {
    let docker_paths = [
        "/var/run/docker.sock",
        "/run/docker.sock",
        "/run/user/1001/docker.sock",
    ];
    let docker_visible = docker_paths.iter().any(|path| Path::new(path).exists());
    let registry_visible = Path::new("/var/lib/freshell-supervisor/runtime.sqlite3").exists();
    let admin_visible = Path::new("/run/freshell-supervisor/supervisor.sock").exists();
    let own_socket_visible = state_dir.join("host.sock").exists();
    let pid_one = std::fs::read("/proc/1/cmdline")
        .ok()
        .map(|bytes| String::from_utf8_lossy(&bytes).replace('\0', " "))
        .unwrap_or_default();
    serde_json::json!({
        "dockerSocketVisible":docker_visible,
        "registryVisible":registry_visible,
        "adminSocketVisible":admin_visible,
        "ownSocketVisible":own_socket_visible,
        "pidOne":pid_one,
    })
}

fn read_runtime_metrics() -> RuntimeMetrics {
    let cpu = std::fs::read_to_string("/sys/fs/cgroup/cpu.stat").unwrap_or_default();
    let memory_events = std::fs::read_to_string("/sys/fs/cgroup/memory.events").unwrap_or_default();
    RuntimeMetrics {
        cpu_usage_usec: keyed_u64(&cpu, "usage_usec"),
        cpu_throttled_usec: keyed_u64(&cpu, "throttled_usec"),
        cpu_nr_throttled: keyed_u64(&cpu, "nr_throttled"),
        memory_current_bytes: read_limit("/sys/fs/cgroup/memory.current").unwrap_or(0),
        memory_peak_bytes: read_limit("/sys/fs/cgroup/memory.peak").unwrap_or(0),
        memory_oom: keyed_u64(&memory_events, "oom"),
        memory_oom_kill: keyed_u64(&memory_events, "oom_kill"),
        pids_current: read_limit("/sys/fs/cgroup/pids.current").unwrap_or(0),
        pids_max: read_limit("/sys/fs/cgroup/pids.max").unwrap_or(0),
    }
}

fn keyed_u64(input: &str, key: &str) -> u64 {
    input
        .lines()
        .find_map(|line| {
            let mut parts = line.split_whitespace();
            (parts.next()? == key)
                .then(|| parts.next()?.parse().ok())
                .flatten()
        })
        .unwrap_or(0)
}

fn read_effective_limits(fallback: RuntimeLimits) -> RuntimeLimits {
    RuntimeLimits {
        cpu_milli: read_cpu_milli().unwrap_or(fallback.cpu_milli),
        memory_bytes: read_limit("/sys/fs/cgroup/memory.max").unwrap_or(fallback.memory_bytes),
        swap_bytes: read_limit("/sys/fs/cgroup/memory.swap.max").unwrap_or(fallback.swap_bytes),
        pids_max: read_limit("/sys/fs/cgroup/pids.max").unwrap_or(fallback.pids_max),
    }
}

fn read_cpu_milli() -> Option<u64> {
    let raw = std::fs::read_to_string("/sys/fs/cgroup/cpu.max").ok()?;
    let mut parts = raw.split_whitespace();
    let quota = parts.next()?;
    let period: u64 = parts.next()?.parse().ok()?;
    if quota == "max" {
        return None;
    }
    let quota: u64 = quota.parse().ok()?;
    Some(quota.saturating_mul(1000) / period.max(1))
}

fn read_limit(path: &str) -> Option<u64> {
    let raw = std::fs::read_to_string(path).ok()?;
    let raw = raw.trim();
    if raw == "max" {
        None
    } else {
        raw.parse().ok()
    }
}

fn write_state(state_dir: &Path, state: &PersistedHostState) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?;
    atomic_write(&state_dir.join("host-state.json"), &bytes)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    {
        let mut options = std::fs::OpenOptions::new();
        options.create(true).write(true).truncate(true);
        let mut file = options.open(&tmp).map_err(|e| e.to_string())?;
        use std::io::Write;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        #[cfg(test)]
        if path
            .file_name()
            .is_some_and(|name| name == "host-state.json")
        {
            opencode_host_crash_checkpoint("state.after_temp_write");
        }
        file.sync_all().map_err(|e| e.to_string())?;
        #[cfg(test)]
        if path
            .file_name()
            .is_some_and(|name| name == "host-state.json")
        {
            opencode_host_crash_checkpoint("state.after_temp_sync");
        }
    }
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    #[cfg(test)]
    if path
        .file_name()
        .is_some_and(|name| name == "host-state.json")
    {
        opencode_host_crash_checkpoint("state.after_rename");
    }
    if let Some(parent) = path.parent() {
        std::fs::File::open(parent)
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
        #[cfg(test)]
        if path
            .file_name()
            .is_some_and(|name| name == "host-state.json")
        {
            opencode_host_crash_checkpoint("state.after_directory_sync");
        }
    }
    Ok(())
}

pub(crate) fn append_event(
    state_dir: &Path,
    event: &str,
    data: serde_json::Value,
) -> Result<(), String> {
    append_event_with_secret(state_dir, b"", event, data)
}

fn append_event_with_secret(
    state_dir: &Path,
    process_secret: &[u8],
    event: &str,
    data: serde_json::Value,
) -> Result<(), String> {
    let path = state_dir.join("host-lifecycle.jsonl");
    let writer = freshell_runtime_observability::RotatingJsonlWriter::create(
        path,
        2 * 1024 * 1024,
        2,
        String::from_utf8_lossy(process_secret).into_owned(),
    )
    .map_err(|error| error.to_string())?;
    writer
        .write_json(&serde_json::json!({
            "at": now_millis(),
            "event": event,
            "data": data,
        }))
        .and_then(|_| writer.sync_all())
        .map_err(|error| error.to_string())
}

fn optional_arg(args: &[String], key: &str) -> Option<String> {
    args.iter()
        .position(|arg| arg == key)
        .and_then(|index| args.get(index + 1))
        .cloned()
}

fn required_arg(args: &[String], key: &str) -> Result<String, String> {
    optional_arg(args, key).ok_or_else(|| format!("missing {key}"))
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

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    #[test]
    fn provider_config_failed_secret_source_attempt_cleans_only_its_inputs_and_retries() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let inputs = root.path().join("inputs");
        std::fs::create_dir(&home).unwrap();
        std::fs::create_dir(&inputs).unwrap();
        std::fs::write(inputs.join("unrelated"), "preserve").unwrap();
        let uid = unsafe { libc::geteuid() };
        let gid = unsafe { libc::getegid() };
        assert!(prepare_provider_files_at(
            "codex",
            &[
                (".codex/auth.json", b"first".to_vec()),
                ("unsupported", vec![])
            ],
            uid,
            gid,
            &home,
            &inputs
        )
        .is_err());
        assert_eq!(
            std::fs::read_dir(&inputs).unwrap().count(),
            1,
            "failed source staging must not leave private attempt files"
        );
        assert_eq!(
            std::fs::read(inputs.join("unrelated")).unwrap(),
            b"preserve"
        );
        prepare_provider_files_at(
            "codex",
            &[(".codex/auth.json", b"retry".to_vec())],
            uid,
            gid,
            &home,
            &inputs,
        )
        .unwrap();
        assert_eq!(
            std::fs::read(home.join(".codex/auth.json")).unwrap(),
            b"retry"
        );
        assert_eq!(std::fs::read_dir(&inputs).unwrap().count(), 1);
    }

    #[test]
    fn provider_config_typed_codex_auth_and_ca_publish_as_private_owner_files() {
        use freshell_runtime_protocol::{ProviderSecretProfile, ProviderSecretReference};
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let root = tempfile::tempdir().unwrap();
        let mounts = root.path().join("mounts");
        let home = root.path().join("home");
        std::fs::create_dir(&mounts).unwrap();
        std::fs::create_dir(&home).unwrap();
        std::fs::write(
            mounts.join("provider-0"),
            "HTTPS_PROXY=http://192.0.2.10:10255\n",
        )
        .unwrap();
        std::fs::write(mounts.join("provider-1"),r#"{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{"id_token":"fixture-id","access_token":"fixture-access","refresh_token":"fixture-refresh","account_id":"fixture-account"},"last_refresh":"2026-10-06T00:00:00Z"}"#).unwrap();
        std::fs::write(mounts.join("provider-2"), "fixture-ca").unwrap();
        let refs = [
            ProviderSecretProfile::CodexOnecliEnvironment,
            ProviderSecretProfile::CodexOnecliAuthFile,
            ProviderSecretProfile::CodexOnecliCaFile,
        ]
        .map(|profile| ProviderSecretReference {
            source_path: String::new(),
            profile,
        });
        let resolved =
            provider_secret_resolution::resolve_child_secrets("codex", &refs, &mounts).unwrap();
        assert_eq!(
            resolved
                .environment
                .get("SSL_CERT_FILE")
                .map(String::as_str),
            Some("/home/freshell/provider/.config/onecli/gateway-ca.pem")
        );
        assert!(!resolved.environment.contains_key("OPENAI_API_KEY"));
        prepare_provider_files_at(
            "codex",
            &resolved.provider_files,
            unsafe { libc::geteuid() },
            unsafe { libc::getegid() },
            &home,
            &root.path().join("inputs"),
        )
        .unwrap();
        for (relative, bytes) in &resolved.provider_files {
            let file = home.join(relative);
            let metadata = std::fs::symlink_metadata(&file).unwrap();
            assert!(
                metadata.is_file() && !metadata.file_type().is_symlink(),
                "provider native auth and CA must be regular owned files"
            );
            assert_eq!(metadata.uid(), unsafe { libc::geteuid() });
            assert_eq!(metadata.gid(), unsafe { libc::getegid() });
            assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
            assert_eq!(std::fs::read(&file).unwrap(), *bytes);
            std::fs::write(&file, bytes).expect("provider owns native refresh publication");
        }
    }

    #[cfg(unix)]
    #[test]
    fn provider_config_bootstrap_failure_preserves_prior_inode_and_siblings() {
        use std::os::unix::fs::MetadataExt;
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let inputs = root.path().join("inputs");
        std::fs::create_dir_all(home.join("selected")).unwrap();
        std::fs::create_dir(&inputs).unwrap();
        let prior = home.join("selected/first");
        std::fs::write(&prior, "prior-config").unwrap();
        std::fs::write(home.join("sibling"), "durable-sibling").unwrap();
        let inode = std::fs::metadata(&prior).unwrap().ino();
        let sibling = std::fs::metadata(home.join("sibling")).unwrap().ino();
        std::fs::write(inputs.join("provider-0"), "replacement").unwrap();
        let files = ["selected/first", "selected/second"].map(|relative| ProviderBootstrapFile {
            source_path: String::new(),
            provider_relative_path: relative.into(),
        });
        assert!(write_provider_bootstrap_files("codex", &files, &home, &inputs).is_err());
        assert_eq!(std::fs::read(&prior).unwrap(), b"prior-config");
        assert_eq!(std::fs::metadata(&prior).unwrap().ino(), inode);
        assert_eq!(
            std::fs::metadata(home.join("sibling")).unwrap().ino(),
            sibling
        );
        assert_eq!(
            std::fs::read(home.join("sibling")).unwrap(),
            b"durable-sibling"
        );
    }

    #[cfg(unix)]
    #[test]
    fn provider_config_failed_selected_refresh_preserves_original_projection() {
        use std::os::unix::fs::{symlink, MetadataExt};
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let stage = root.path().join("stage");
        std::fs::create_dir_all(home.join("skills")).unwrap();
        std::fs::create_dir_all(stage.join("projection/skills")).unwrap();
        std::fs::write(home.join("skills/old"), "prior-script").unwrap();
        std::fs::write(home.join("skills/sibling"), "sibling").unwrap();
        std::fs::write(
            home.join(PROVIDER_PROJECTION_MANIFEST),
            r#"["skills","skills/old"]"#,
        )
        .unwrap();
        let prior = std::fs::metadata(home.join("skills/old")).unwrap().ino();
        std::fs::write(stage.join("manifest.json"), r#"["skills"]"#).unwrap();
        std::fs::write(
            stage.join("projection").join(PROVIDER_PROJECTION_MANIFEST),
            r#"["skills","skills/missing"]"#,
        )
        .unwrap();
        symlink("absent", stage.join("projection/skills/missing")).unwrap();
        assert!(apply_staged_provider_config(&stage, &home).is_err());
        assert_eq!(
            std::fs::read(home.join("skills/old")).unwrap(),
            b"prior-script"
        );
        assert_eq!(
            std::fs::metadata(home.join("skills/old")).unwrap().ino(),
            prior
        );
        assert_eq!(
            std::fs::read(home.join("skills/sibling")).unwrap(),
            b"sibling"
        );
    }
    use super::*;

    #[test]
    fn provider_secret_config_copy_preserves_settings_and_rejects_auth_files() {
        use freshell_runtime_protocol::{
            ProviderConfigReference, ProviderConfigRoot, ProviderLaunchContext, ProviderPreparation,
        };
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("user-provider");
        let destination = root.path().join("soul-home");
        std::fs::create_dir_all(source.join("plugins")).unwrap();
        std::fs::create_dir_all(&destination).unwrap();
        std::fs::write(source.join("settings.json"), b"{\"theme\":\"dark\"}").unwrap();
        std::fs::write(source.join(".credentials.json"), b"test-secret-value").unwrap();
        std::fs::write(source.join("plugins/ordinary.js"), b"export default {};").unwrap();
        std::fs::write(source.join("plugins/auth.json"), b"test-secret-value").unwrap();
        let context = ProviderLaunchContext {
            preparation: ProviderPreparation::Claude {
                mcp_args: Vec::new(),
            },
            mcp_capability: None,
            config: vec![
                ProviderConfigReference {
                    root: ProviderConfigRoot::UserProvider,
                    relative_path: "settings.json".into(),
                    provider_relative_path: ".claude/settings.json".into(),
                    format: "json".into(),
                },
                ProviderConfigReference {
                    root: ProviderConfigRoot::UserProvider,
                    relative_path: "plugins".into(),
                    provider_relative_path: ".claude/plugins".into(),
                    format: "directory".into(),
                },
            ],
        };
        copy_provider_config_references(
            &context,
            "claude",
            root.path(),
            &source,
            &destination,
            unsafe { libc::geteuid() },
            unsafe { libc::getegid() },
        )
        .unwrap();
        assert_eq!(
            std::fs::read(destination.join(".claude/settings.json")).unwrap(),
            b"{\"theme\":\"dark\"}"
        );
        assert!(destination.join(".claude/plugins/ordinary.js").is_file());
        assert_eq!(
            std::fs::read(destination.join(".claude/plugins/auth.json")).unwrap(),
            b"test-secret-value"
        );
        assert!(!destination.join(".claude/.credentials.json").exists());

        assert!(copy_provider_config_references(
            &context,
            "unapproved",
            root.path(),
            &source,
            &destination,
            unsafe { libc::geteuid() },
            unsafe { libc::getegid() }
        )
        .is_err());
        let mut forbidden = context;
        forbidden.config[0].relative_path = ".credentials.json".into();
        assert!(copy_provider_config_references(
            &forbidden,
            "claude",
            root.path(),
            &source,
            &destination,
            unsafe { libc::geteuid() },
            unsafe { libc::getegid() }
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn provider_config_projects_selected_external_resources_without_escaping_home() {
        use freshell_runtime_protocol::{
            ProviderConfigReference, ProviderConfigRoot, ProviderLaunchContext, ProviderPreparation,
        };
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        let outside = root.path().join("outside");
        let destination = root.path().join("provider-home");
        std::fs::create_dir_all(workspace.join("inside")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::create_dir_all(&destination).unwrap();
        std::fs::write(workspace.join("inside/opencode.json"), b"inside").unwrap();
        std::fs::write(outside.join("opencode.json"), b"selected-outside-resource").unwrap();
        symlink(&outside, workspace.join(".opencode")).unwrap();
        symlink(workspace.join("inside"), workspace.join("linked-inside")).unwrap();
        let context = ProviderLaunchContext {
            preparation: ProviderPreparation::Opencode {
                project_config: vec![
                    ProviderConfigReference {
                        root: ProviderConfigRoot::Workspace,
                        relative_path: ".opencode/opencode.json".into(),
                        provider_relative_path: ".config/opencode/project/escaped.json".into(),
                        format: "json".into(),
                    },
                    ProviderConfigReference {
                        root: ProviderConfigRoot::Workspace,
                        relative_path: "linked-inside/opencode.json".into(),
                        provider_relative_path: ".config/opencode/project/allowed.json".into(),
                        format: "json".into(),
                    },
                ],
                tui_config: None,
                tui_source: None,
                inline_config: false,
            },
            mcp_capability: None,
            config: Vec::new(),
        };
        copy_provider_config_references(
            &context,
            "opencode",
            &workspace,
            root.path(),
            &destination,
            unsafe { libc::geteuid() },
            unsafe { libc::getegid() },
        )
        .unwrap();
        assert_eq!(
            std::fs::read(destination.join(".config/opencode/project/escaped.json")).unwrap(),
            b"selected-outside-resource"
        );
        assert_eq!(
            std::fs::read(outside.join("opencode.json")).unwrap(),
            b"selected-outside-resource"
        );
        let projected =
            std::fs::canonicalize(destination.join(".config/opencode/project/escaped.json"))
                .unwrap();
        assert!(projected.starts_with(&destination));
        assert_eq!(
            std::fs::read(destination.join(".config/opencode/project/allowed.json")).unwrap(),
            b"inside"
        );
    }

    #[test]
    fn exact_resume_refreshes_changed_config_and_removes_stale_projection() {
        use freshell_runtime_protocol::{
            ProviderConfigReference, ProviderConfigRoot, ProviderLaunchContext, ProviderPreparation,
        };
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("user-provider");
        let destination = root.path().join("provider-home");
        std::fs::create_dir_all(source.join("plugins")).unwrap();
        std::fs::create_dir_all(&destination).unwrap();
        std::fs::write(source.join("settings.json"), b"first").unwrap();
        std::fs::write(source.join("plugins/old.js"), b"old").unwrap();
        let mut context = ProviderLaunchContext {
            preparation: ProviderPreparation::Claude {
                mcp_args: Vec::new(),
            },
            mcp_capability: None,
            config: vec![
                ProviderConfigReference {
                    root: ProviderConfigRoot::UserProvider,
                    relative_path: "settings.json".into(),
                    provider_relative_path: ".claude/settings.json".into(),
                    format: "json".into(),
                },
                ProviderConfigReference {
                    root: ProviderConfigRoot::UserProvider,
                    relative_path: "plugins".into(),
                    provider_relative_path: ".claude/plugins".into(),
                    format: "directory".into(),
                },
            ],
        };
        let uid = unsafe { libc::geteuid() };
        let gid = unsafe { libc::getegid() };
        copy_provider_config_references(
            &context,
            "claude",
            root.path(),
            &source,
            &destination,
            uid,
            gid,
        )
        .unwrap();
        std::fs::write(
            destination.join(".claude/plugins/provider-created.js"),
            b"durable",
        )
        .unwrap();
        std::fs::write(source.join("settings.json"), b"second").unwrap();
        std::fs::remove_file(source.join("plugins/old.js")).unwrap();
        std::fs::write(source.join("plugins/new.js"), b"new").unwrap();
        refresh_provider_config_references(
            &context,
            "claude",
            root.path(),
            &source,
            &destination,
            uid,
            gid,
        )
        .unwrap();
        let child_output = std::process::Command::new("/usr/bin/cat")
            .arg(destination.join(".claude/settings.json"))
            .output()
            .unwrap();
        assert!(child_output.status.success());
        assert_eq!(child_output.stdout, b"second");
        assert!(!destination.join(".claude/plugins/old.js").exists());
        assert_eq!(
            std::fs::read(destination.join(".claude/plugins/new.js")).unwrap(),
            b"new"
        );
        assert_eq!(
            std::fs::read(destination.join(".claude/plugins/provider-created.js")).unwrap(),
            b"durable"
        );
        std::fs::remove_file(source.join("settings.json")).unwrap();
        assert!(
            refresh_provider_config_references(
                &context,
                "claude",
                root.path(),
                &source,
                &destination,
                uid,
                gid
            )
            .is_err(),
            "a vanished selected dependency must preserve the last complete projection"
        );
        assert_eq!(
            std::fs::read(destination.join(".claude/settings.json")).unwrap(),
            b"second"
        );
        // The producer's next selected generation deliberately omits the
        // removed optional file; this authorizes retiring its old projection.
        context
            .config
            .retain(|reference| reference.relative_path != "settings.json");
        refresh_provider_config_references(
            &context,
            "claude",
            root.path(),
            &source,
            &destination,
            uid,
            gid,
        )
        .unwrap();
        assert!(!destination.join(".claude/settings.json").exists());
    }

    #[test]
    fn provider_identity_command_uses_clear_groups_only_when_switching_identity() {
        let uid = unsafe { libc::geteuid() };
        let gid = unsafe { libc::getegid() };
        assert!(provider_identity_args(uid, gid).contains(&"--keep-groups".into()));
        assert!(
            provider_identity_args(uid.saturating_add(1), gid).contains(&"--clear-groups".into())
        );
    }
    use async_trait::async_trait;
    use freshell_agent_runtime::host_actor::{
        DispatchAck, DispatchFailure, FreshAgentOperation, FreshAgentProfile, FreshAgentTransport,
        OperationAck, OperationFailure, TransportStart,
    };
    use freshell_runtime_protocol::{
        AgentEvent, FreshAgentCapture, FreshAgentRollbackDirection, FreshAgentRollbackMode,
        FreshProvider, RequestId,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct RpcFixtureTransport {
        dispatches: AtomicUsize,
        decisions: AtomicUsize,
        operations: AtomicUsize,
        captures: AtomicUsize,
        stops: AtomicUsize,
    }

    #[async_trait]
    impl FreshAgentTransport for RpcFixtureTransport {
        async fn start(&self, _profile: &FreshAgentProfile) -> Result<TransportStart, String> {
            Ok(TransportStart {
                native_session_id: Some("fixture-native-thread".into()),
            })
        }

        async fn dispatch(
            &self,
            request_id: &RequestId,
            _text: &str,
            _profile: &FreshAgentProfile,
        ) -> Result<DispatchAck, DispatchFailure> {
            self.dispatches.fetch_add(1, Ordering::SeqCst);
            Ok(DispatchAck {
                provider_ack_id: Some(request_id.to_string()),
            })
        }

        async fn resolve_permission(
            &self,
            _decision_id: &str,
            _decision: serde_json::Value,
        ) -> Result<(), DispatchFailure> {
            self.decisions.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        async fn interrupt(&self) -> Result<(), String> {
            Ok(())
        }

        async fn supports_operation(
            &self,
            _operation: &FreshAgentOperation,
        ) -> Result<bool, String> {
            Ok(true)
        }

        async fn dispatch_operation(
            &self,
            request_id: &RequestId,
            _operation: &FreshAgentOperation,
        ) -> Result<OperationAck, OperationFailure> {
            self.operations.fetch_add(1, Ordering::SeqCst);
            Ok(OperationAck {
                provider_ack_id: Some(request_id.to_string()),
                native_session_id: Some("fixture-native-thread".into()),
            })
        }

        async fn capture(&self, max_bytes: usize) -> Result<FreshAgentCapture, String> {
            self.captures.fetch_add(1, Ordering::SeqCst);
            Ok(FreshAgentCapture {
                provider: FreshProvider::Claude,
                session_type: "freshclaude".into(),
                presentation_session_id: "fixture-public-thread".into(),
                native_session_id: "fixture-native-thread".into(),
                text: "user: fixture"[..max_bytes.min(13)].into(),
                truncated: max_bytes < 13,
            })
        }

        async fn snapshot(&self) -> Result<serde_json::Value, String> {
            Ok(
                serde_json::json!({"threadId":"fixture-native-thread","provider":"claude",
                "sessionType":"freshclaude","status":"idle","turns":[{"turnId":"retained-rpc-turn","text":"x".repeat(2 * freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES)}]}),
            )
        }

        async fn stop(self: Arc<Self>) -> Result<(), String> {
            self.stops.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        fn take_event_stream(&self) -> Option<tokio::sync::mpsc::Receiver<AgentEvent>> {
            None
        }
    }

    /// The control plane must keep a worker even inside a half-CPU cgroup
    /// where `available_parallelism()` reports 1. Without the floor, one
    /// long synchronous workload step wedges the supervisor's Stop command
    /// and the host looks dead when it is merely busy.
    #[test]
    fn the_session_host_runtime_keeps_a_worker_floor_for_control_commands() {
        assert_eq!(host_worker_threads(1), HOST_MIN_WORKER_THREADS);
        assert_eq!(host_worker_threads(2), HOST_MIN_WORKER_THREADS);
        assert_eq!(
            host_worker_threads(HOST_MIN_WORKER_THREADS),
            HOST_MIN_WORKER_THREADS
        );
        assert_eq!(host_worker_threads(6), 6);
        assert_eq!(host_worker_threads(256), HOST_MAX_WORKER_THREADS);
    }

    #[test]
    fn effective_limits_fall_back_when_host_is_unbounded() {
        let fallback = RuntimeLimits {
            cpu_milli: 777,
            memory_bytes: 123_456_789,
            swap_bytes: 12,
            pids_max: 44,
        };
        let limits = read_effective_limits(fallback);
        assert!(limits.cpu_milli > 0);
        assert!(limits.memory_bytes > 0);
        assert!(limits.pids_max > 0);
    }

    #[tokio::test]
    async fn authenticated_fresh_agent_rpc_keeps_one_host_owned_transport_until_explicit_stop() {
        let state = test_host_state();
        let transport = Arc::new(RpcFixtureTransport {
            dispatches: AtomicUsize::new(0),
            decisions: AtomicUsize::new(0),
            operations: AtomicUsize::new(0),
            captures: AtomicUsize::new(0),
            stops: AtomicUsize::new(0),
        });
        let actor = freshell_agent_runtime::host_actor::FreshAgentHostActor::open(
            state.state_dir.join("rpc-fixture-agent"),
            FreshAgentProfile {
                provider: FreshProvider::Claude,
                runtime_variant: "fixture-sdk".into(),
                cwd: "/workspace".into(),
                model: Some("fixture-model".into()),
                effort: Some("low".into()),
                permission_mode: Some("ask".into()),
                sandbox: None,
                provider_store_id: "fixture-store".into(),
                native_session_id: None,
                plugins: None,
                model_selection: None,
                session_ref: None,
                provider_launch_context: None,
                provider_secret_references: Vec::new(),
            },
            transport.clone(),
        )
        .await
        .unwrap();
        actor
            .record_permission("permission-1".into(), serde_json::json!({"tool":"shell"}))
            .await
            .unwrap();
        *state.fresh_agent.lock().await = Some(actor);

        let request_id = RequestId::parse("rpc-command-one").unwrap();
        let result = dispatch(
            authenticated_host_envelope(
                &state,
                HostCommand::FreshAgentSend {
                    incarnation_id: state.incarnation_id.clone(),
                    request_id: request_id.clone(),
                    text: "perform fixture work".into(),
                    settings: None,
                },
            ),
            &state,
        )
        .await
        .unwrap();
        assert!(matches!(
            result,
            HostResult::FreshAgentCommand {
                state: freshell_runtime_protocol::CommandState::ProviderAcked,
                native_session_id: Some(ref native),
            }
            if native == "fixture-native-thread"
        ));

        // A gateway reconnect is only a new cursor. The same request and the
        // same decision are idempotent at the host-owned actor.
        let batch = dispatch(
            authenticated_host_envelope(
                &state,
                HostCommand::FreshAgentReadEvents {
                    incarnation_id: state.incarnation_id.clone(),
                    after_sequence: 0,
                    max_events: 32,
                },
            ),
            &state,
        )
        .await
        .unwrap();
        assert!(matches!(batch, HostResult::FreshAgentEvents(_)));
        let compact_id = RequestId::parse("rpc-compact-one").unwrap();
        for _ in 0..2 {
            let compact = dispatch(
                authenticated_host_envelope(
                    &state,
                    HostCommand::FreshAgentCompact {
                        incarnation_id: state.incarnation_id.clone(),
                        request_id: compact_id.clone(),
                        instructions: Some("retain decisions".into()),
                        cwd: Some("/workspace".into()),
                    },
                ),
                &state,
            )
            .await
            .unwrap();
            assert!(matches!(
                compact,
                HostResult::FreshAgentCommand {
                    state: freshell_runtime_protocol::CommandState::ProviderAcked,
                    ..
                }
            ));
        }
        let rollback = dispatch(
            authenticated_host_envelope(
                &state,
                HostCommand::FreshAgentRollback {
                    incarnation_id: state.incarnation_id.clone(),
                    request_id: RequestId::parse("rpc-undo-one").unwrap(),
                    direction: FreshAgentRollbackDirection::Undo,
                    mode: FreshAgentRollbackMode::Step,
                    turn_id: None,
                    cwd: None,
                },
            ),
            &state,
        )
        .await
        .unwrap();
        assert!(matches!(rollback, HostResult::FreshAgentCommand { .. }));
        let before_snapshot = transport.dispatches.load(Ordering::SeqCst);
        let (mut client_stream, server_stream) = UnixStream::pair().unwrap();
        let serving = tokio::spawn(handle_connection(server_stream, state.clone()));
        write_frame(
            &mut client_stream,
            &authenticated_host_envelope(
                &state,
                HostCommand::FreshAgentReadSnapshot {
                    incarnation_id: state.incarnation_id.clone(),
                },
            ),
        )
        .await
        .unwrap();
        let snapshot: HostReply = freshell_runtime_protocol::read_frame_with_limit(
            &mut client_stream,
            freshell_runtime_protocol::MAX_NATIVE_HISTORY_FRAME_BYTES,
        )
        .await
        .unwrap();
        serving.await.unwrap().unwrap();
        assert!(
            matches!(snapshot.result.unwrap(), HostResult::FreshAgentSnapshot(value)
            if value["threadId"] == "fixture-native-thread" && value["turns"][0]["turnId"] == "retained-rpc-turn"
            && value["turns"][0]["text"].as_str().unwrap().len() == 2 * freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES)
        );
        assert_eq!(transport.dispatches.load(Ordering::SeqCst), before_snapshot);
        assert_eq!(transport.stops.load(Ordering::SeqCst), 0);
        let capture = dispatch(
            authenticated_host_envelope(
                &state,
                HostCommand::FreshAgentCapture {
                    incarnation_id: state.incarnation_id.clone(),
                    max_bytes: 1024,
                },
            ),
            &state,
        )
        .await
        .unwrap();
        assert!(matches!(
            capture,
            HostResult::FreshAgentCapture(FreshAgentCapture {
                native_session_id,
                ..
            }) if native_session_id == "fixture-native-thread"
        ));
        for _ in 0..2 {
            dispatch(
                authenticated_host_envelope(
                    &state,
                    HostCommand::FreshAgentResolve {
                        incarnation_id: state.incarnation_id.clone(),
                        decision_id: "permission-1".into(),
                        decision: serde_json::json!({"behavior":"allow"}),
                    },
                ),
                &state,
            )
            .await
            .unwrap();
        }
        assert_eq!(transport.dispatches.load(Ordering::SeqCst), 1);
        assert_eq!(transport.decisions.load(Ordering::SeqCst), 1);
        assert_eq!(transport.operations.load(Ordering::SeqCst), 2);
        assert_eq!(transport.captures.load(Ordering::SeqCst), 1);
        assert_eq!(transport.stops.load(Ordering::SeqCst), 0);

        dispatch(
            authenticated_host_envelope(
                &state,
                HostCommand::Stop {
                    incarnation_id: state.incarnation_id.clone(),
                    control_epoch: 1,
                    execution_generation: 1,
                },
            ),
            &state,
        )
        .await
        .unwrap();
        assert_eq!(transport.stops.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn native_session_fixture_requires_exact_resume_identity_and_persists_history() {
        let dir = tempfile_like_dir();
        let created =
            handle_native_fixture_request(&dir, "soul-test", NativeFixtureRequest::Create).unwrap();
        assert!(created.ok);
        let session_id = created.session_id.clone().unwrap();
        assert_eq!(created.history, vec!["create"]);

        let wrong = handle_native_fixture_request(
            &dir,
            "soul-test",
            NativeFixtureRequest::Resume {
                session_id: "wrong-session".into(),
            },
        )
        .unwrap();
        assert!(!wrong.ok);

        let resumed = handle_native_fixture_request(
            &dir,
            "soul-test",
            NativeFixtureRequest::Resume {
                session_id: session_id.clone(),
            },
        )
        .unwrap();
        assert!(resumed.ok);
        assert_eq!(resumed.session_id.as_deref(), Some(session_id.as_str()));
        assert_eq!(resumed.history, vec!["create", "resume"]);

        let history =
            handle_native_fixture_request(&dir, "soul-test", NativeFixtureRequest::History)
                .unwrap();
        assert_eq!(history.history, vec!["create", "resume"]);
    }

    #[tokio::test]
    async fn dispatch_rejects_wrong_role_before_any_host_mutation() {
        let state = test_host_state();
        let envelope = Envelope {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            request_id: freshell_runtime_protocol::RequestId::new(),
            role: ControlRole::Web,
            auth: None,
            body: HostCommand::Stop {
                incarnation_id: state.incarnation_id.clone(),
                control_epoch: 1,
                execution_generation: 1,
            },
        };
        let error = dispatch(envelope, &state).await.unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::UnauthorizedRole);
        let persisted = state.persisted.lock().await.clone();
        assert_eq!(persisted.max_control_epoch, 0);
        assert!(persisted.grant_id.is_none());
        assert!(state.child.lock().await.is_none());
    }

    #[tokio::test]
    async fn dispatch_rejects_stale_execution_generation_without_stopping_anything() {
        let state = test_host_state();
        {
            let mut persisted = state.persisted.lock().await;
            persisted.max_control_epoch = 7;
            persisted.max_execution_generation = 9;
        }
        let envelope = authenticated_host_envelope(
            &state,
            HostCommand::Stop {
                incarnation_id: state.incarnation_id.clone(),
                control_epoch: 7,
                execution_generation: 8,
            },
        );
        let error = dispatch(envelope, &state).await.unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::StaleExecutionGrant);
        assert!(state.child.lock().await.is_none());
    }

    #[tokio::test]
    async fn grant_from_another_host_boot_is_rejected_before_consumption() {
        let state = test_host_state();
        let envelope = authenticated_host_envelope(
            &state,
            HostCommand::GrantExecution {
                incarnation_id: state.incarnation_id.clone(),
                soul_id: SoulId::new(),
                host_boot_id: HostBootId::new(),
                control_epoch: 1,
                execution_generation: 1,
                grant_id: GrantId::new(),
                fixture: Some(FixtureKind::Heartbeat),
                terminal: None,
                fresh_agent: None,
                resume_spec: None,
            },
        );
        let error = dispatch(envelope, &state).await.unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::StaleExecutionGrant);
        let persisted = state.persisted.lock().await.clone();
        assert!(persisted.grant_id.is_none());
        assert_eq!(persisted.worker_launch_count, 0);
    }

    #[tokio::test]
    async fn command_for_another_incarnation_is_rejected_before_mutation() {
        let state = test_host_state();
        let envelope = authenticated_host_envelope(
            &state,
            HostCommand::Stop {
                incarnation_id: IncarnationId::new(),
                control_epoch: 1,
                execution_generation: 1,
            },
        );
        let error = dispatch(envelope, &state).await.unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::OwnershipMismatch);
        assert!(state.child.lock().await.is_none());
    }

    struct ConfigPublicationGrantEffects {
        opens: AtomicUsize,
    }

    #[async_trait]
    impl GrantExecutionEffects for ConfigPublicationGrantEffects {
        fn run_opencode_provider_helper(
            &self,
            _: &TerminalLaunchSpec,
            _: &OpenCodeTransferDescriptor,
            _: &Path,
            _: &Path,
            _: &str,
            _: Option<&Path>,
        ) -> Result<Vec<u8>, String> {
            panic!("fresh publication must not run a terminal helper")
        }

        async fn spawn_terminal_pty(
            &self,
            _: &Path,
            _: &IncarnationId,
            _: &TerminalLaunchSpec,
            _: std::collections::BTreeMap<String, String>,
            _: Option<providers::PreparedCodexLaunch>,
        ) -> Result<SpawnedTerminalPty, RuntimeError> {
            panic!("fresh publication must not spawn a PTY")
        }

        async fn open_fresh_agent(
            &self,
            state_dir: &Path,
            launch: FreshAgentLaunchSpec,
        ) -> Result<Arc<freshell_agent_runtime::host_actor::FreshAgentHostActor>, String> {
            self.opens.fetch_add(1, Ordering::SeqCst);
            let transport = Arc::new(RpcFixtureTransport {
                dispatches: AtomicUsize::new(0),
                decisions: AtomicUsize::new(0),
                operations: AtomicUsize::new(0),
                captures: AtomicUsize::new(0),
                stops: AtomicUsize::new(0),
            });
            freshell_agent_runtime::host_actor::FreshAgentHostActor::open(
                state_dir.join("publication-agent"),
                FreshAgentProfile {
                    provider: FreshProvider::Claude,
                    runtime_variant: launch.runtime_variant,
                    cwd: launch.cwd,
                    model: launch.model,
                    effort: launch.effort,
                    permission_mode: launch.permission_mode,
                    sandbox: launch.sandbox,
                    provider_store_id: launch.provider_store_id,
                    native_session_id: launch.native_session_id,
                    plugins: launch.plugins,
                    model_selection: launch.model_selection,
                    session_ref: launch.session_ref,
                    provider_launch_context: launch.provider_launch_context,
                    provider_secret_references: launch.provider_secret_references,
                },
                transport,
            )
            .await
            .map_err(|error| error.to_string())
        }
    }

    #[tokio::test]
    async fn provider_config_fresh_exact_resume_grant_blocks_before_transport_and_repairs() {
        use freshell_runtime_protocol::{
            ProviderConfigReference, ProviderConfigRoot, ProviderLaunchContext, ProviderPreparation,
        };
        use std::os::unix::fs::MetadataExt;
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("provider-home");
        std::fs::create_dir(&home).unwrap();
        let source = root.path().join("opencode.json");
        std::fs::write(&source, br#"{"theme":"prior"}"#).unwrap();
        let context = ProviderLaunchContext {
            preparation: ProviderPreparation::Claude {
                mcp_args: Vec::new(),
            },
            mcp_capability: None,
            config: vec![ProviderConfigReference {
                root: ProviderConfigRoot::Workspace,
                relative_path: "opencode.json".into(),
                provider_relative_path: ".claude/settings.json".into(),
                format: "json".into(),
            }],
        };
        let uid = unsafe { libc::geteuid() };
        let gid = unsafe { libc::getegid() };
        assert_ne!(
            uid, 0,
            "default regression uses the current unprivileged filesystem identity"
        );
        copy_provider_config_references(
            &context,
            "claude",
            root.path(),
            root.path(),
            &home,
            uid,
            gid,
        )
        .unwrap();
        let projection = home.join(".claude/settings.json");
        let inode = std::fs::metadata(&projection).unwrap().ino();
        let manifest = std::fs::read(home.join(".freshell-config-projection.json")).unwrap();
        let database = home.join("native-store.sqlite3");
        let connection = rusqlite::Connection::open(&database).unwrap();
        connection.execute_batch("CREATE TABLE session(id TEXT PRIMARY KEY); INSERT INTO session VALUES('fixture-native-thread');").unwrap();
        drop(connection);
        let store_bytes = std::fs::read(&database).unwrap();
        let store_inode = std::fs::metadata(&database).unwrap().ino();
        let mut state = test_host_state();
        Arc::get_mut(&mut state).unwrap().provider_config_paths = ProviderConfigPaths {
            private_mount: root.path().join("private"),
            provider_home: home.clone(),
        };
        let launch = FreshAgentLaunchSpec {
            session_id: "fresh-fixture".into(),
            provider: freshell_runtime_protocol::FreshProvider::Claude,
            session_type: "freshclaude".into(),
            runtime_variant: "sdk".into(),
            provider_store_id: "store-fresh-config".into(),
            cwd: root.path().to_string_lossy().into_owned(),
            workspace_path: root.path().to_string_lossy().into_owned(),
            git_common_dir: None,
            run_as_uid: uid,
            run_as_gid: gid,
            model: None,
            effort: None,
            permission_mode: None,
            sandbox: None,
            native_session_id: Some("fixture-native-thread".into()),
            plugins: None,
            model_selection: None,
            session_ref: None,
            fixture_transport: None,
            provider_bootstrap_files: Vec::new(),
            provider_secret_references: Vec::new(),
            provider_launch_context: Some(context.clone()),
        };
        let resume = ResumeSpec {
            schema_version: freshell_runtime_protocol::RESUME_SPEC_SCHEMA_VERSION,
            provider_session: freshell_runtime_protocol::ProviderSessionRef {
                provider: "claude".into(),
                provider_store_id: launch.provider_store_id.clone(),
                native_session_id: launch.native_session_id.clone().unwrap(),
            },
            mode: launch.session_type.clone(),
            runtime_variant: launch.runtime_variant.clone(),
            fixture_transport: None,
            opencode_adoption_baseline: None,
            program: "opencode".into(),
            resume_argv: Vec::new(),
            provider_home: home.to_string_lossy().into_owned(),
            provider_volume: None,
            cwd: launch.cwd.clone(),
            workspace_path: launch.workspace_path.clone(),
            project_key: None,
            runtime_profile: None,
            environment: Default::default(),
            model: None,
            reasoning_effort: None,
            permission_mode: None,
            image_ref: None,
            provider_version: None,
            credential_references: Vec::new(),
            identity_provenance: freshell_runtime_protocol::IdentityProvenance::ProviderObserved,
            durable_position: Default::default(),
            checkpoint_references: Vec::new(),
            creation_seed_ref: "seed-fresh-config".into(),
            checkpoint_revision: 3,
            allocation_state: freshell_runtime_protocol::AllocationState::VerifiedDurable,
            evidence_revision: 5,
            never_dispatched: false,
        };
        let soul = SoulId::new();
        let effects = ConfigPublicationGrantEffects {
            opens: AtomicUsize::new(0),
        };
        let hidden = root.path().join("unavailable");
        std::fs::rename(&source, &hidden).unwrap();
        let error = dispatch_with_effects(
            authenticated_host_envelope(
                &state,
                HostCommand::GrantExecution {
                    incarnation_id: state.incarnation_id.clone(),
                    soul_id: soul.clone(),
                    host_boot_id: state.host_boot_id.clone(),
                    control_epoch: 7,
                    execution_generation: 9,
                    grant_id: GrantId::new(),
                    fixture: None,
                    terminal: None,
                    fresh_agent: Some(Box::new(launch.clone())),
                    resume_spec: Some(Box::new(resume.clone())),
                },
            ),
            &state,
            &effects,
        )
        .await
        .expect_err("selected publication must refuse the fresh execution grant");
        assert_eq!(error.code, RuntimeErrorCode::HostUnreachable);
        assert!(
            error
                .message
                .starts_with("capability_pending: provider configuration publication failed:"),
            "CAPABILITY_PENDING must not depend on native error text: {}",
            error.message
        );
        assert_eq!(state.persisted.lock().await.worker_launch_count, 0);
        assert!(state.persisted.lock().await.worker_pid.is_none());
        assert!(state.child.lock().await.is_none());
        assert!(state.pty.lock().await.is_none());
        assert!(state.fresh_agent.lock().await.is_none());
        assert_eq!(
            effects.opens.load(Ordering::SeqCst),
            0,
            "blocked publication must not even attempt transport open"
        );
        assert_eq!(std::fs::read(&projection).unwrap(), br#"{"theme":"prior"}"#);
        assert_eq!(std::fs::metadata(&projection).unwrap().ino(), inode);
        assert_eq!(
            std::fs::read(home.join(".freshell-config-projection.json")).unwrap(),
            manifest
        );
        assert_eq!(std::fs::read(&database).unwrap(), store_bytes);
        assert_eq!(std::fs::metadata(&database).unwrap().ino(), store_inode);
        let events = std::fs::read_to_string(state.state_dir.join("host-lifecycle.jsonl")).unwrap();
        let event = events
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .find(|value| value["event"] == "host.provider_config_publication_blocked")
            .expect("fresh refusal must emit the shared fenced publication event");
        let data = &event["data"];
        assert_eq!(data["severity"], "warn");
        assert_eq!(data["soulId"], soul.to_string());
        assert_eq!(data["incarnationId"], state.incarnation_id.to_string());
        assert_eq!(data["controlEpoch"], 7);
        assert_eq!(data["executionGeneration"], 9);
        assert_eq!(data["provider"], "claude");
        assert_eq!(data["reason"], "selected_dependency_unavailable");
        assert_eq!(
            data["providerSession"],
            serde_json::to_value(&resume.provider_session).unwrap()
        );
        assert_eq!(data["evidenceRevision"], 5);
        assert_eq!(data["checkpointRevision"], 3);
        assert!(
            !events.contains(root.path().to_str().unwrap()),
            "event must not include raw filesystem diagnostics"
        );
        std::fs::rename(&hidden, &source).unwrap(); // repair only the selected fixture dependency
                                                    // A consumed failed grant stays fenced. Its replacement host retries
                                                    // the same saved session/context/HOME with only the dependency repaired.
        let mut repaired = test_host_state();
        Arc::get_mut(&mut repaired).unwrap().provider_config_paths =
            state.provider_config_paths.clone();
        let result = dispatch_with_effects(
            authenticated_host_envelope(
                &repaired,
                HostCommand::GrantExecution {
                    incarnation_id: repaired.incarnation_id.clone(),
                    soul_id: soul.clone(),
                    host_boot_id: repaired.host_boot_id.clone(),
                    control_epoch: 8,
                    execution_generation: 10,
                    grant_id: GrantId::new(),
                    fixture: None,
                    terminal: None,
                    fresh_agent: Some(Box::new(launch)),
                    resume_spec: Some(Box::new(resume)),
                },
            ),
            &repaired,
            &effects,
        )
        .await
        .expect("repaired selected publication must accept the replacement fresh grant");
        assert!(matches!(
            result,
            HostResult::GrantAccepted {
                worker_launch_count: 1,
                ..
            }
        ));
        assert_eq!(effects.opens.load(Ordering::SeqCst), 1);
        assert_eq!(repaired.persisted.lock().await.worker_launch_count, 1);
        assert_eq!(
            std::fs::read(&projection).unwrap(),
            std::fs::read(&source).unwrap()
        );
        assert_eq!(std::fs::read(&database).unwrap(), store_bytes);
        assert_eq!(std::fs::metadata(&database).unwrap().ino(), store_inode);
        assert!(state.fresh_agent.lock().await.is_none());
        let actor = repaired.fresh_agent.lock().await.take().unwrap();
        actor.stop().await.unwrap();
    }

    #[tokio::test]
    async fn exact_resume_grant_reuses_provider_home_and_launches_one_real_worker() {
        use freshell_runtime_protocol::{
            ProviderConfigReference, ProviderConfigRoot, ProviderLaunchContext, ProviderPreparation,
        };
        use std::os::unix::fs::PermissionsExt;

        let workspace = tempfile::tempdir().unwrap();
        std::fs::set_permissions(workspace.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        let provider_home = workspace.path().join("provider-home");
        let source_config = workspace.path().join("opencode.json");
        let child_output = workspace.path().join("child-effective-config");
        std::fs::create_dir(&provider_home).unwrap();
        std::fs::write(&source_config, br#"{"model":"first"}"#).unwrap();
        let context = ProviderLaunchContext {
            preparation: ProviderPreparation::Opencode {
                project_config: vec![ProviderConfigReference {
                    root: ProviderConfigRoot::Workspace,
                    relative_path: "opencode.json".into(),
                    provider_relative_path: ".config/opencode/opencode.json".into(),
                    format: "json".into(),
                }],
                tui_config: None,
                tui_source: None,
                inline_config: false,
            },
            mcp_capability: None,
            config: Vec::new(),
        };
        let current_uid = unsafe { libc::geteuid() };
        let current_gid = unsafe { libc::getegid() };
        if current_uid == 0 {
            // The separate setpriv integration test covers provider-UID refresh.
            return;
        }
        copy_provider_config_references(
            &context,
            "opencode",
            workspace.path(),
            workspace.path(),
            &provider_home,
            current_uid,
            current_gid,
        )
        .unwrap();
        std::fs::write(&source_config, br#"{"model":"second"}"#).unwrap();
        let mut state = test_host_state();
        Arc::get_mut(&mut state).unwrap().provider_config_paths = ProviderConfigPaths {
            private_mount: workspace.path().join("private-mount"),
            provider_home: provider_home.clone(),
        };
        let launcher = workspace.path().join("exact-resume-provider");
        std::fs::write(
            &launcher,
            "#!/bin/sh\ncat \"$TEST_CONFIG_PATH\" > \"$TEST_OUTPUT_PATH.tmp\" && mv \"$TEST_OUTPUT_PATH.tmp\" \"$TEST_OUTPUT_PATH\"\nexec sleep 60\n",
        )
        .unwrap();
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755)).unwrap();
        let run_as_uid = current_uid;
        let native_session_id = "ses_exact_recovery";
        let environment = std::collections::BTreeMap::from([
            ("HOME".into(), "/home/freshell/provider".into()),
            ("PATH".into(), "/usr/bin:/bin".into()),
            // This test covers exact-resume grant and provider-home reuse. The
            // separate provider tests exercise rebind preparation; the test
            // harness binary cannot act as the session-host feature worker.
            ("FRESHELL_OPENCODE_REBIND".into(), "0".into()),
            (
                "TEST_CONFIG_PATH".into(),
                provider_home
                    .join(".config/opencode/opencode.json")
                    .to_string_lossy()
                    .into_owned(),
            ),
            (
                "TEST_OUTPUT_PATH".into(),
                child_output.to_string_lossy().into_owned(),
            ),
        ]);
        let terminal = TerminalLaunchSpec {
            terminal_id: "terminal-exact-resume".into(),
            stream_id: "stream-exact-resume".into(),
            mode: "opencode".into(),
            program: launcher.to_string_lossy().into_owned(),
            args: vec!["--continue".into(), "--model".into(), "free-model".into()],
            env: environment.clone(),
            cwd: workspace.path().to_string_lossy().into_owned(),
            run_as_uid,
            run_as_gid: current_gid,
            cols: 80,
            rows: 24,
            project_key: "project-exact-resume".into(),
            workspace_path: workspace.path().to_string_lossy().into_owned(),
            git_common_dir: None,
            create_request_id: Some("create-exact-resume".into()),
            resume_session_id: None,
            provider_model: Some("free-model".into()),
            provider_reasoning_effort: None,
            provider_sandbox: None,
            provider_permission_mode: None,
            provider_bootstrap_files: Vec::new(),
            provider_secret_references: Vec::new(),
            provider_launch_context: Some(context),
            opencode_transfer: None,
            opencode_transfer_attempt_id: None,
            opencode_adoption: None,
        };
        let resume_spec = ResumeSpec {
            schema_version: freshell_runtime_protocol::RESUME_SPEC_SCHEMA_VERSION,
            provider_session: freshell_runtime_protocol::ProviderSessionRef {
                provider: "opencode".into(),
                provider_store_id: "store-exact-resume".into(),
                native_session_id: native_session_id.into(),
            },
            mode: "opencode".into(),
            runtime_variant: "managed_terminal_pty".into(),
            fixture_transport: None,
            opencode_adoption_baseline: None,
            program: launcher.to_string_lossy().into_owned(),
            resume_argv: vec!["--continue".into(), "--model".into(), "free-model".into()],
            provider_home: "/home/freshell/provider".into(),
            provider_volume: None,
            cwd: workspace.path().to_string_lossy().into_owned(),
            workspace_path: workspace.path().to_string_lossy().into_owned(),
            project_key: Some("project-exact-resume".into()),
            runtime_profile: None,
            environment,
            model: Some("free-model".into()),
            reasoning_effort: None,
            permission_mode: None,
            image_ref: None,
            provider_version: Some("test".into()),
            credential_references: Vec::new(),
            identity_provenance: freshell_runtime_protocol::IdentityProvenance::ProviderObserved,
            durable_position: freshell_runtime_protocol::DurablePosition::default(),
            checkpoint_references: Vec::new(),
            creation_seed_ref: "seed-exact-resume".into(),
            checkpoint_revision: 0,
            allocation_state: freshell_runtime_protocol::AllocationState::VerifiedDurable,
            evidence_revision: 1,
            never_dispatched: false,
        };
        let exact_launch = prepare_terminal_for_resume(&terminal, &resume_spec).unwrap();
        assert!(exact_launch
            .args
            .windows(2)
            .any(|pair| pair == ["--session", native_session_id]));
        assert!(!exact_launch.args.iter().any(|arg| arg == "--continue"));
        let mut blocked_state = test_host_state();
        Arc::get_mut(&mut blocked_state)
            .unwrap()
            .provider_config_paths = ProviderConfigPaths {
            private_mount: workspace.path().join("private-mount"),
            provider_home: provider_home.clone(),
        };
        let hidden_source = workspace.path().join("source-unavailable");
        std::fs::rename(&source_config, &hidden_source).unwrap();
        let denied = authenticated_host_envelope(
            &blocked_state,
            HostCommand::GrantExecution {
                incarnation_id: blocked_state.incarnation_id.clone(),
                soul_id: SoulId::new(),
                host_boot_id: blocked_state.host_boot_id.clone(),
                control_epoch: 1,
                execution_generation: 1,
                grant_id: GrantId::new(),
                fixture: None,
                terminal: Some(Box::new(terminal.clone())),
                fresh_agent: None,
                resume_spec: Some(Box::new(resume_spec.clone())),
            },
        );
        let failure = dispatch(denied, &blocked_state)
            .await
            .expect_err("missing selected configuration must refuse execution");
        assert_eq!(failure.code, RuntimeErrorCode::HostUnreachable);
        assert!(
            failure
                .message
                .starts_with("capability_pending: provider configuration publication failed:"),
            "configuration refusal needs a recoverable preparation classification: {}",
            failure.message
        );
        assert_eq!(blocked_state.persisted.lock().await.worker_launch_count, 0);
        assert!(blocked_state.pty.lock().await.is_none());
        assert_eq!(
            std::fs::read(provider_home.join(".config/opencode/opencode.json")).unwrap(),
            br#"{"model":"first"}"#
        );
        std::fs::rename(&hidden_source, &source_config).unwrap();
        let envelope = authenticated_host_envelope(
            &state,
            HostCommand::GrantExecution {
                incarnation_id: state.incarnation_id.clone(),
                soul_id: SoulId::new(),
                host_boot_id: state.host_boot_id.clone(),
                control_epoch: 1,
                execution_generation: 1,
                grant_id: GrantId::new(),
                fixture: None,
                terminal: Some(Box::new(terminal)),
                fresh_agent: None,
                resume_spec: Some(Box::new(resume_spec)),
            },
        );

        let result = dispatch(envelope, &state)
            .await
            .expect("the exact-resume grant must launch");
        assert!(matches!(
            result,
            HostResult::GrantAccepted {
                worker_launch_count: 1,
                ..
            }
        ));
        assert_eq!(state.persisted.lock().await.worker_launch_count, 1);
        assert!(state.pty.lock().await.is_some());
        let mut observed = None;
        for _ in 0..100 {
            if let Ok(value) = std::fs::read(&child_output) {
                observed = Some(value);
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert_eq!(
            observed.as_deref(),
            Some(br#"{"model":"second"}"#.as_slice())
        );
        let mut launched_pty = state.pty.lock().await.take();
        if let Some(mut pty) = launched_pty.take() {
            pty.stop().await;
        }
    }

    #[test]
    fn security_probe_never_treats_own_socket_as_admin_authority() {
        let dir = tempfile_like_dir();
        std::fs::write(dir.join("host.sock"), b"").unwrap();
        let value = security_probe(&dir);
        assert_eq!(value["ownSocketVisible"], true);
    }

    #[tokio::test]
    async fn dispatched_missing_identity_probe_preserves_host_state() {
        let state = test_host_state();
        let retained = state.state_dir.join("retained-output");
        std::fs::write(&retained, "existing output").unwrap();
        let result = dispatch(
            authenticated_host_envelope(
                &state,
                HostCommand::ProbeRecovery {
                    incarnation_id: state.incarnation_id.clone(),
                    resume_spec: None,
                    creation_seed_ref: "retained-seed".into(),
                    never_dispatched: false,
                    run_as_uid: 65534,
                    run_as_gid: 0,
                },
            ),
            &state,
        )
        .await
        .unwrap();
        assert!(
            matches!(
                result,
                HostResult::RecoveryProbe(RecoveryProbe::Blocked {
                    reason: freshell_runtime_protocol::RecoveryBlockReason::StoreUnreadable,
                    ..
                })
            ),
            "{result:?}"
        );
        assert_eq!(
            std::fs::read_to_string(retained).unwrap(),
            "existing output"
        );
        assert!(state.pty.lock().await.is_none());
        assert!(state.fresh_agent.lock().await.is_none());
    }

    fn test_host_state() -> Arc<HostState> {
        Arc::new(HostState {
            incarnation_id: IncarnationId::new(),
            host_boot_id: HostBootId::new(),
            state_dir: tempfile_like_dir(),
            secret: b"0123456789abcdef0123456789abcdef".to_vec(),
            requested_limits: RuntimeLimits {
                cpu_milli: 500,
                memory_bytes: 128 * 1024 * 1024,
                swap_bytes: 0,
                pids_max: 64,
            },
            persisted: Mutex::new(PersistedHostState::default()),
            child: Mutex::new(None),
            pty: Mutex::new(None),
            fresh_agent: Mutex::new(None),
            provider_config_paths: ProviderConfigPaths::default(),
            opencode_transfer_mount: PathBuf::from(OPENCODE_TRANSFER_MOUNT),
            bootstrap_root: PathBuf::from("/run/freshell-bootstrap"),
        })
    }

    #[test]
    fn opencode_reader_environment_must_select_the_exact_database_and_workspace_cwd() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        let cwd = workspace.join("project");
        let outside = root.path().join("outside");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let workspace = std::fs::canonicalize(workspace).unwrap();
        let cwd = std::fs::canonicalize(cwd).unwrap();
        let mut env = std::collections::BTreeMap::from([
            ("HOME".into(), "/home/freshell/provider".into()),
            (
                "XDG_DATA_HOME".into(),
                "/home/freshell/provider/.local/share".into(),
            ),
            (
                "XDG_CONFIG_HOME".into(),
                "/home/freshell/provider/.config".into(),
            ),
            (
                "OPENCODE_DB".into(),
                "/home/freshell/provider/.local/share/opencode/opencode.db".into(),
            ),
        ]);
        assert!(validate_opencode_reader_paths(&env, &workspace, &cwd).is_ok());

        env.insert("OPENCODE_DB".into(), "/tmp/other.db".into());
        assert!(validate_opencode_reader_paths(&env, &workspace, &cwd).is_err());

        env.insert(
            "OPENCODE_DB".into(),
            "/home/freshell/provider/.local/share/opencode/opencode.db".into(),
        );
        assert!(validate_opencode_reader_paths(&env, &workspace, &outside).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn host_can_plan_provider_paths_without_traversing_the_private_provider_home() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        let private_home = root.path().join("provider-home");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir(&private_home).unwrap();
        std::fs::set_permissions(&private_home, std::fs::Permissions::from_mode(0o000)).unwrap();
        let env = std::collections::BTreeMap::from([
            ("HOME".into(), private_home.to_string_lossy().into_owned()),
            (
                "XDG_DATA_HOME".into(),
                private_home
                    .join(".local/share")
                    .to_string_lossy()
                    .into_owned(),
            ),
            (
                "XDG_CONFIG_HOME".into(),
                private_home.join(".config").to_string_lossy().into_owned(),
            ),
            (
                "OPENCODE_DB".into(),
                private_home
                    .join(".local/share/opencode/opencode.db")
                    .to_string_lossy()
                    .into_owned(),
            ),
        ]);

        let planned = plan_opencode_reader_paths_at(&env, &workspace, &workspace, &private_home);
        let strict_check =
            validate_opencode_reader_paths_at(&env, &workspace, &workspace, &private_home);
        std::fs::set_permissions(&private_home, std::fs::Permissions::from_mode(0o700)).unwrap();

        assert!(
            planned.is_ok(),
            "host path planning must not inspect provider-owned paths"
        );
        assert!(
            strict_check.is_err(),
            "the provider-identity helper performs the strict check"
        );
    }

    #[cfg(unix)]
    #[test]
    fn durable_opencode_receipts_are_idempotent_bounded_and_conflict_rejecting() {
        use std::os::unix::fs::symlink;

        #[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
        struct Receipt {
            transfer_id: String,
            row_count: u64,
        }

        let state_dir = tempfile::tempdir().unwrap();
        let receipt = Receipt {
            transfer_id: "synthetic-transfer".into(),
            row_count: 12,
        };
        persist_opencode_receipt(state_dir.path(), "import.json", &receipt).unwrap();
        persist_opencode_receipt(state_dir.path(), "import.json", &receipt).unwrap();
        assert_eq!(
            read_opencode_receipt::<Receipt>(state_dir.path(), "import.json").unwrap(),
            receipt
        );

        let conflict = Receipt {
            row_count: 13,
            ..receipt.clone()
        };
        assert!(persist_opencode_receipt(state_dir.path(), "import.json", &conflict).is_err());

        let outside = state_dir.path().join("outside.json");
        std::fs::write(
            &outside,
            br#"{"transfer_id":"synthetic-transfer","row_count":12}"#,
        )
        .unwrap();
        symlink(&outside, state_dir.path().join("linked.json")).unwrap();
        assert!(read_opencode_receipt::<Receipt>(state_dir.path(), "linked.json").is_err());
        assert!(persist_opencode_receipt(state_dir.path(), "linked.json", &receipt).is_err());
    }

    #[test]
    fn opencode_transfer_phase_order_blocks_grant_and_pty_until_receipts_revalidate() {
        let mut gate = OpenCodeTransferGate::default();
        assert!(gate
            .run_step(OpenCodeTransferPhase::GrantConsumed, || Ok(()))
            .is_err());
        assert!(gate.ensure_pty_spawn_allowed().is_err());

        let mut performed = Vec::new();
        run_opencode_transfer_readiness_sequence(&mut gate, |phase| {
            performed.push(phase);
            Ok(())
        })
        .unwrap();
        assert_eq!(performed, OPENCODE_TRANSFER_READINESS_PHASES);
        assert_eq!(gate.phases(), OPENCODE_TRANSFER_READINESS_PHASES);
        assert!(gate.ensure_pty_spawn_allowed().is_err());
        gate.advance(OpenCodeTransferPhase::GrantConsumed).unwrap();
        gate.ensure_pty_spawn_allowed().unwrap();
        gate.advance(OpenCodeTransferPhase::PtySpawned).unwrap();
        assert_eq!(
            gate.phases(),
            &[
                OpenCodeTransferPhase::ProviderHomePrepared,
                OpenCodeTransferPhase::StageVerified,
                OpenCodeTransferPhase::ImportCompleted,
                OpenCodeTransferPhase::StructuralVerified,
                OpenCodeTransferPhase::ImportReceiptDurable,
                OpenCodeTransferPhase::ProviderIdentityReaderVerified,
                OpenCodeTransferPhase::ReceiptsDurable,
                OpenCodeTransferPhase::ReceiptsRevalidated,
                OpenCodeTransferPhase::GrantConsumed,
                OpenCodeTransferPhase::PtySpawned,
            ]
        );

        let mut blocked = OpenCodeTransferGate::default();
        let mut blocked_performed = Vec::new();
        assert!(
            run_opencode_transfer_readiness_sequence(&mut blocked, |phase| {
                blocked_performed.push(phase);
                if phase == OpenCodeTransferPhase::ProviderIdentityReaderVerified {
                    return Err("synthetic provider reader failure".into());
                }
                Ok(())
            })
            .is_err()
        );
        assert_eq!(blocked_performed, OPENCODE_TRANSFER_READINESS_PHASES[..6]);
        assert!(blocked
            .advance(OpenCodeTransferPhase::GrantConsumed)
            .is_err());
        assert!(blocked.ensure_pty_spawn_allowed().is_err());
    }

    #[tokio::test]
    async fn durable_souls_rehearsal_host_cannot_spawn_before_native_readiness() {
        let mut gate = OpenCodeTransferGate::default();
        let mut callbacks = 0;
        for phase in OPENCODE_TRANSFER_READINESS_PHASES {
            assert!(run_opencode_transfer_pty_spawn(&mut gate, || {
                callbacks += 1;
                async { Ok(()) }
            })
            .await
            .is_err());
            assert_eq!(
                callbacks, 0,
                "a missing native readiness phase must not call the PTY boundary"
            );
            gate.advance(phase).unwrap();
        }
        assert!(run_opencode_transfer_pty_spawn(&mut gate, || {
            callbacks += 1;
            async { Ok(()) }
        })
        .await
        .is_err());
        assert_eq!(
            callbacks, 0,
            "verified native data still needs the exact execution grant"
        );
        gate.advance(OpenCodeTransferPhase::GrantConsumed).unwrap();
        run_opencode_transfer_pty_spawn(&mut gate, || {
            callbacks += 1;
            async { Ok(()) }
        })
        .await
        .unwrap();
        assert_eq!(callbacks, 1);
        assert_eq!(
            gate.phases().last(),
            Some(&OpenCodeTransferPhase::PtySpawned)
        );
        assert!(run_opencode_transfer_pty_spawn(&mut gate, || {
            callbacks += 1;
            async { Ok(()) }
        })
        .await
        .is_err());
        assert_eq!(callbacks, 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn production_grant_joins_staging_backend_mount_readiness_and_pty_for_synthetic_history()
    {
        let success = run_joined_synthetic_transfer(None).await.unwrap();
        assert!(
            matches!(
                &success.result,
                Ok(HostResult::GrantAccepted {
                    worker_launch_count: 1,
                    ..
                })
            ),
            "first imported grant result: {:?}",
            success.result
        );
        let receipt = success
            .state
            .persisted
            .try_lock()
            .expect("grant handler released persisted state")
            .opencode_transfer_receipt
            .clone()
            .expect("the current provider-reader receipt must reach grant consumption");
        assert_eq!(receipt.transfer_id, "synthetic-transfer");
        assert_eq!(receipt.provider_uid, unsafe { libc::geteuid() });
        assert_eq!(receipt.provider_gid, unsafe { libc::getegid() });
        assert_eq!(receipt.structural_sha256.len(), 64);
        assert_eq!(receipt.reader_receipt_sha256.len(), 64);
        let adoption = success
            .adoption_expectation
            .lock()
            .unwrap()
            .clone()
            .expect("the first imported launch must get an adoption gate");
        assert_eq!(adoption.incarnation_id, success.state.incarnation_id);
        assert_eq!(adoption.root_session_id, "ses_synthetictransfersession");
        assert_eq!(adoption.evidence_generation.len(), 64);
        assert_eq!(
            adoption.baseline.descriptor.transfer_id,
            "synthetic-transfer"
        );
        assert_eq!(adoption.baseline.manifest_sha256.len(), 64);
        adoption.validate().unwrap();
        assert!(success
            .pty_callback_invoked
            .load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(
            *success.events.lock().unwrap(),
            ["import", "reader", "reader", "current", "pty"]
        );
        assert!(success
            .root
            .path()
            .join("opencode-transfers/synthetic-transfer.ready")
            .is_dir());

        for injected_failure in [
            SyntheticTransferFailure::Mount,
            SyntheticTransferFailure::Import,
            SyntheticTransferFailure::Reader,
            SyntheticTransferFailure::CurrentEvidenceRead,
            SyntheticTransferFailure::CurrentEvidenceMismatch,
            SyntheticTransferFailure::CurrentEvidenceGenerationMismatch,
        ] {
            let attempt = run_joined_synthetic_transfer(Some(injected_failure))
                .await
                .unwrap();
            assert!(attempt.result.is_err());
            assert!(attempt
                .state
                .persisted
                .try_lock()
                .expect("failed grant handler released persisted state")
                .grant_id
                .is_none());
            assert!(
                !attempt
                    .pty_callback_invoked
                    .load(std::sync::atomic::Ordering::SeqCst),
                "transfer failures must stop before the actual grant handler's PTY boundary"
            );
            assert!(!attempt.events.lock().unwrap().contains(&"pty"));
        }

        let mut invalid_mounts = success.mount_inspection.clone();
        invalid_mounts[0]["RW"] = serde_json::Value::Bool(true);
        assert!(
            freshell_supervisor::backend::verify_opencode_transfer_mount_inspection(
                &invalid_mounts,
                Some(&success.mount_plan),
            )
            .is_err()
        );

        let resumed = run_synthetic_exact_resume(&success, None, false)
            .await
            .unwrap();
        assert!(matches!(
            &resumed.result,
            Ok(HostResult::GrantAccepted {
                worker_launch_count: 1,
                ..
            })
        ));
        assert_eq!(*resumed.events.lock().unwrap(), ["current", "pty"]);
        assert!(resumed
            .pty_callback_invoked
            .load(std::sync::atomic::Ordering::SeqCst));
        let resume_adoption = resumed
            .adoption_expectation
            .lock()
            .unwrap()
            .clone()
            .expect("exact resume must get a new adoption gate");
        assert_eq!(resume_adoption.incarnation_id, resumed.state.incarnation_id);
        assert_ne!(resume_adoption.incarnation_id, adoption.incarnation_id);
        assert_ne!(resume_adoption.launch_nonce, adoption.launch_nonce);
        assert_eq!(resume_adoption.root_tail, adoption.root_tail);
        assert_eq!(
            resume_adoption.evidence_generation,
            adoption.evidence_generation
        );
        let preserved = resumed
            .state
            .persisted
            .try_lock()
            .expect("resumed grant handler released persisted state")
            .opencode_transfer_receipt
            .clone()
            .expect("exact resume must preserve the original import readiness receipt");
        assert_eq!(preserved, receipt);

        let resumed_from_repaired_legacy = run_synthetic_exact_resume(&success, None, true)
            .await
            .unwrap();
        assert!(
            matches!(
                &resumed_from_repaired_legacy.result,
                Ok(HostResult::GrantAccepted {
                    worker_launch_count: 1,
                    ..
                })
            ),
            "baseline-only repaired resume failed: {:#?}",
            resumed_from_repaired_legacy.result
        );
        assert_eq!(
            *resumed_from_repaired_legacy.events.lock().unwrap(),
            ["current", "pty"],
            "repaired legacy resume verifies the installed store without import or staging"
        );
        assert!(resumed_from_repaired_legacy
            .pty_callback_invoked
            .load(std::sync::atomic::Ordering::SeqCst));
        let repaired_adoption = resumed_from_repaired_legacy
            .adoption_expectation
            .lock()
            .unwrap()
            .clone()
            .expect("repaired legacy resume must receive a fresh TUI adoption gate");
        assert_eq!(
            repaired_adoption.incarnation_id,
            resumed_from_repaired_legacy.state.incarnation_id
        );
        assert_ne!(repaired_adoption.launch_nonce, adoption.launch_nonce);

        for failure in [
            SyntheticTransferFailure::CurrentEvidenceRead,
            SyntheticTransferFailure::CurrentEvidenceMismatch,
            SyntheticTransferFailure::CurrentEvidenceGenerationMismatch,
            SyntheticTransferFailure::ReadinessIdentityMismatch,
            SyntheticTransferFailure::SavedBaselineMismatch,
        ] {
            let blocked = run_synthetic_exact_resume(&success, Some(failure), true)
                .await
                .unwrap();
            assert!(
                blocked.result.is_err(),
                "baseline-only {failure:?} must block"
            );
            assert!(blocked
                .state
                .persisted
                .try_lock()
                .expect("blocked baseline-only resume released persisted state")
                .grant_id
                .is_none());
            assert!(
                !blocked
                    .pty_callback_invoked
                    .load(std::sync::atomic::Ordering::SeqCst),
                "baseline-only failures must stop before PTY spawn"
            );
            assert!(!blocked.events.lock().unwrap().contains(&"pty"));
            if matches!(
                failure,
                SyntheticTransferFailure::ReadinessIdentityMismatch
                    | SyntheticTransferFailure::SavedBaselineMismatch
            ) {
                assert!(blocked.events.lock().unwrap().is_empty());
            } else {
                assert!(blocked.events.lock().unwrap().contains(&"current"));
            }
        }

        for failure in [
            SyntheticTransferFailure::CurrentEvidenceRead,
            SyntheticTransferFailure::CurrentEvidenceMismatch,
            SyntheticTransferFailure::CurrentEvidenceGenerationMismatch,
            SyntheticTransferFailure::ReadinessIdentityMismatch,
        ] {
            let blocked = run_synthetic_exact_resume(&success, Some(failure), false)
                .await
                .unwrap();
            assert!(blocked.result.is_err());
            assert!(blocked
                .state
                .persisted
                .try_lock()
                .expect("blocked exact resume released persisted state")
                .grant_id
                .is_none());
            assert!(!blocked
                .pty_callback_invoked
                .load(std::sync::atomic::Ordering::SeqCst));
            if failure == SyntheticTransferFailure::ReadinessIdentityMismatch {
                assert!(blocked.events.lock().unwrap().is_empty());
            } else {
                assert_eq!(*blocked.events.lock().unwrap(), ["current"]);
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn opencode_provider_paths_reject_symlink_components() {
        let root = tempfile::tempdir().unwrap();
        let real = root.path().join("provider-real");
        std::fs::create_dir_all(&real).unwrap();
        let linked = root.path().join("provider-link");
        std::os::unix::fs::symlink(&real, &linked).unwrap();
        assert!(
            reject_symlink_components(&linked.join(".local/share/opencode/opencode.db")).is_err()
        );
        assert!(reject_symlink_components(&real.join(".local/share/opencode/opencode.db")).is_ok());
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum SyntheticTransferFailure {
        Mount,
        Import,
        Reader,
        CurrentEvidenceRead,
        CurrentEvidenceMismatch,
        CurrentEvidenceGenerationMismatch,
        ReadinessIdentityMismatch,
        SavedBaselineMismatch,
    }

    struct SyntheticGateAttempt {
        root: tempfile::TempDir,
        state: Arc<HostState>,
        result: Result<HostResult, RuntimeError>,
        events: Arc<std::sync::Mutex<Vec<&'static str>>>,
        pty_callback_invoked: Arc<std::sync::atomic::AtomicBool>,
        adoption_expectation: Arc<std::sync::Mutex<Option<OpenCodeAdoptionExpectation>>>,
        mount_plan: freshell_supervisor::backend::OpenCodeTransferMountPlan,
        mount_inspection: Vec<serde_json::Value>,
    }

    struct SyntheticResumeAttempt {
        state: Arc<HostState>,
        result: Result<HostResult, RuntimeError>,
        events: Arc<std::sync::Mutex<Vec<&'static str>>>,
        pty_callback_invoked: Arc<std::sync::atomic::AtomicBool>,
        adoption_expectation: Arc<std::sync::Mutex<Option<OpenCodeAdoptionExpectation>>>,
    }

    struct SyntheticCapacity(u64);

    impl freshell_agent_runtime::opencode_transfer::DestinationCapacityProvider for SyntheticCapacity {
        fn available_bytes(&self, _existing_directory: &Path) -> io::Result<u64> {
            Ok(self.0)
        }
    }

    struct SyntheticGrantExecutionEffects {
        failure: Option<SyntheticTransferFailure>,
        expected_grant_id: GrantId,
        events: Arc<std::sync::Mutex<Vec<&'static str>>>,
        pty_callback_invoked: Arc<std::sync::atomic::AtomicBool>,
        adoption_expectation: Arc<std::sync::Mutex<Option<OpenCodeAdoptionExpectation>>>,
        pty_marker: Option<PathBuf>,
    }

    #[async_trait::async_trait]
    impl GrantExecutionEffects for SyntheticGrantExecutionEffects {
        fn run_opencode_provider_helper(
            &self,
            terminal: &TerminalLaunchSpec,
            descriptor: &OpenCodeTransferDescriptor,
            workspace_root: &Path,
            cwd: &Path,
            worker: &str,
            payload_path: Option<&Path>,
        ) -> Result<Vec<u8>, String> {
            use freshell_agent_runtime::opencode_transfer::{
                import_bundle_payload_with_capacity, verify_installed_store,
            };

            match worker {
                "opencode-import-worker" => {
                    self.events.lock().unwrap().push("import");
                    let payload_path =
                        payload_path.ok_or("import worker needs a staged payload")?;
                    let capacity = SyntheticCapacity(
                        if self.failure == Some(SyntheticTransferFailure::Import) {
                            0
                        } else {
                            u64::MAX
                        },
                    );
                    let receipt = import_bundle_payload_with_capacity(
                        descriptor,
                        std::fs::File::open(payload_path).map_err(|error| error.to_string())?,
                        Path::new(&terminal.env["OPENCODE_DB"]),
                        workspace_root,
                        &capacity,
                    )
                    .map_err(|error| error.to_string())?;
                    serde_json::to_vec(&receipt).map_err(|error| error.to_string())
                }
                "opencode-reader-probe" => {
                    self.events.lock().unwrap().push("reader");
                    let home = Path::new(&terminal.env["HOME"]);
                    let paths = validate_opencode_reader_paths_at(
                        &terminal.env,
                        workspace_root,
                        cwd,
                        home,
                    )?;
                    let uid = if self.failure == Some(SyntheticTransferFailure::Reader) {
                        terminal.run_as_uid.wrapping_add(1)
                    } else {
                        terminal.run_as_uid
                    };
                    let receipt = verify_installed_store(
                        descriptor,
                        &installed_store_reader_context(&paths, uid, terminal.run_as_gid),
                    )
                    .map_err(|error| error.to_string())?;
                    serde_json::to_vec(&receipt).map_err(|error| error.to_string())
                }
                "opencode-current-evidence-worker" => {
                    self.events.lock().unwrap().push("current");
                    if self.failure == Some(SyntheticTransferFailure::CurrentEvidenceRead) {
                        return Err("synthetic provider current-evidence read failure".into());
                    }
                    let mut evidence =
                        freshell_agent_runtime::opencode_transfer::verify_current_store(
                            descriptor,
                            Path::new(&terminal.env["OPENCODE_DB"]),
                            workspace_root,
                        )
                        .map_err(|error| error.to_string())?;
                    if self.failure == Some(SyntheticTransferFailure::CurrentEvidenceMismatch) {
                        evidence.root_session_id = "ses_mismatched-root".into();
                    }
                    if self.failure
                        == Some(SyntheticTransferFailure::CurrentEvidenceGenerationMismatch)
                    {
                        evidence.import_generation = "stale-source-generation".into();
                    }
                    serde_json::to_vec(&evidence).map_err(|error| error.to_string())
                }
                _ => Err("unexpected synthetic OpenCode helper worker".into()),
            }
        }

        async fn spawn_terminal_pty(
            &self,
            state_dir: &Path,
            incarnation_id: &IncarnationId,
            terminal: &TerminalLaunchSpec,
            _child_env: std::collections::BTreeMap<String, String>,
            _codex: Option<providers::PreparedCodexLaunch>,
        ) -> Result<SpawnedTerminalPty, RuntimeError> {
            let call_order = self.events.lock().unwrap().clone();
            if !matches!(
                call_order.as_slice(),
                ["import", "reader", "reader", "current"] | ["current"]
            ) {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::HostUnreachable,
                    "PTY callback ran before provider current-evidence verification",
                ));
            }
            let adoption = terminal.opencode_adoption.as_ref().ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::HostUnreachable,
                    "PTY callback ran without a verified OpenCode adoption expectation",
                )
            })?;
            adoption.validate()?;
            if &adoption.incarnation_id != incarnation_id {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::HostUnreachable,
                    "PTY callback received an adoption expectation for another incarnation",
                ));
            }
            *self.adoption_expectation.lock().unwrap() = Some(adoption.clone());
            let persisted: PersistedHostState =
                serde_json::from_slice(&std::fs::read(state_dir.join("host-state.json")).map_err(
                    |error| RuntimeError::new(RuntimeErrorCode::RegistryFailure, error.to_string()),
                )?)
                .map_err(|error| {
                    RuntimeError::new(RuntimeErrorCode::RegistryFailure, error.to_string())
                })?;
            if persisted.grant_id.as_ref() != Some(&self.expected_grant_id) {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::StaleExecutionGrant,
                    "PTY callback ran before durable grant consumption",
                ));
            }
            let descriptor = terminal
                .opencode_transfer
                .as_ref()
                .unwrap_or(&adoption.baseline.descriptor);
            let receipt = persisted
                .opencode_transfer_receipt
                .as_ref()
                .ok_or_else(|| {
                    RuntimeError::new(
                        RuntimeErrorCode::HostUnreachable,
                        "PTY callback ran without a persisted readiness receipt",
                    )
                })?;
            if receipt.transfer_id != descriptor.transfer_id
                || receipt.root_session_id != descriptor.root_session_id
                || receipt.source_generation != descriptor.source_generation
            {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::HostUnreachable,
                    "PTY callback received a stale transfer readiness receipt",
                ));
            }
            let imported =
                read_opencode_receipt::<freshell_agent_runtime::opencode_transfer::ImportReceipt>(
                    state_dir,
                    &format!("opencode-{}-import.json", descriptor.transfer_id),
                )
                .map_err(|error| RuntimeError::new(RuntimeErrorCode::RegistryFailure, error))?;
            let readable = read_opencode_receipt::<
                freshell_agent_runtime::opencode_transfer::InstalledStoreReadable,
            >(
                state_dir,
                &format!("opencode-{}-readable.json", descriptor.transfer_id),
            )
            .map_err(|error| RuntimeError::new(RuntimeErrorCode::RegistryFailure, error))?;
            if imported.transfer_id != descriptor.transfer_id
                || imported.root_session_id != descriptor.root_session_id
                || imported.source_generation != descriptor.source_generation
                || imported.row_count == 0
                || readable.transfer_id != descriptor.transfer_id
                || readable.root_session_id != descriptor.root_session_id
                || readable.source_generation != descriptor.source_generation
                || readable.row_count != imported.row_count
                || readable.structural_sha256 != imported.structural_sha256
            {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::HostUnreachable,
                    "PTY callback received receipts for stale or empty history",
                ));
            }
            let database =
                rusqlite::Connection::open(&terminal.env["OPENCODE_DB"]).map_err(|error| {
                    RuntimeError::new(
                        RuntimeErrorCode::RegistryFailure,
                        format!("open synthetic provider database at PTY boundary: {error}"),
                    )
                })?;
            let message = database
                .query_row(
                    "SELECT data FROM message WHERE id = ?1",
                    ["synthetic-message"],
                    |row| row.get::<_, String>(0),
                )
                .map_err(|error| {
                    RuntimeError::new(
                        RuntimeErrorCode::RegistryFailure,
                        format!("read synthetic history at PTY boundary: {error}"),
                    )
                })?;
            if message != r#"{"text":"synthetic message body is test-only"}"# {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::HostUnreachable,
                    "PTY callback did not receive the synthetic conversation history",
                ));
            }
            self.events.lock().unwrap().push("pty");
            if let Some(marker) = &self.pty_marker {
                std::fs::write(marker, b"synthetic PTY callback invoked").map_err(|error| {
                    RuntimeError::new(RuntimeErrorCode::RegistryFailure, error.to_string())
                })?;
            }
            self.pty_callback_invoked
                .store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(SpawnedTerminalPty {
                pid: 4242,
                terminal_id: terminal.terminal_id.clone(),
                stream_epoch: terminal.stream_id.clone(),
                hosted: None,
            })
        }
    }

    async fn dispatch_synthetic_fixture_from_root(
        root: &Path,
        execution_generation: u64,
        pty_marker: PathBuf,
    ) -> Result<
        (
            Result<HostResult, RuntimeError>,
            Arc<std::sync::Mutex<Vec<&'static str>>>,
            Arc<std::sync::atomic::AtomicBool>,
        ),
        String,
    > {
        let descriptor: OpenCodeTransferDescriptor = serde_json::from_slice(
            &std::fs::read(root.join("opencode-transfer-descriptor.json"))
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        let terminal: TerminalLaunchSpec = serde_json::from_slice(
            &std::fs::read(root.join("opencode-terminal.json"))
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        let incarnation_id =
            IncarnationId::parse("synthetic-incarnation").map_err(|error| error.to_string())?;
        let soul_id = SoulId::parse("synthetic-soul").map_err(|error| error.to_string())?;
        let host_boot_id = HostBootId::new();
        let home = PathBuf::from(&terminal.env["HOME"]);
        let state = Arc::new(HostState {
            incarnation_id: incarnation_id.clone(),
            host_boot_id: host_boot_id.clone(),
            state_dir: root.join("host-state"),
            secret: b"synthetic-host-secret-0123456789abcdef".to_vec(),
            requested_limits: RuntimeLimits {
                cpu_milli: 500,
                memory_bytes: 128 * 1024 * 1024,
                swap_bytes: 0,
                pids_max: 64,
            },
            persisted: Mutex::new(PersistedHostState {
                host_boot_id: Some(host_boot_id.clone()),
                ..PersistedHostState::default()
            }),
            child: Mutex::new(None),
            pty: Mutex::new(None),
            fresh_agent: Mutex::new(None),
            provider_config_paths: ProviderConfigPaths {
                private_mount: root.join("private"),
                provider_home: home,
            },
            opencode_transfer_mount: root
                .join("opencode-transfers")
                .join(format!("{}.ready", descriptor.transfer_id)),
            bootstrap_root: root.join("bootstrap"),
        });
        let grant_id = GrantId::new();
        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let pty_callback_invoked = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let adoption_expectation = Arc::new(std::sync::Mutex::new(None));
        let effects = SyntheticGrantExecutionEffects {
            failure: None,
            expected_grant_id: grant_id.clone(),
            events: events.clone(),
            pty_callback_invoked: pty_callback_invoked.clone(),
            adoption_expectation: adoption_expectation.clone(),
            pty_marker: Some(pty_marker),
        };
        let envelope = authenticated_host_envelope(
            &state,
            HostCommand::GrantExecution {
                incarnation_id,
                soul_id,
                host_boot_id,
                control_epoch: 1,
                execution_generation,
                grant_id,
                fixture: None,
                terminal: Some(Box::new(terminal)),
                fresh_agent: None,
                resume_spec: None,
            },
        );
        let result = dispatch_with_effects(envelope, &state, &effects).await;
        Ok((result, events, pty_callback_invoked))
    }

    async fn run_joined_synthetic_transfer(
        failure: Option<SyntheticTransferFailure>,
    ) -> Result<SyntheticGateAttempt, String> {
        use freshell_runtime_protocol::{
            opencode_target_build_receipt, opencode_transfer_bundle_digest, OpenCodeTransferChunk,
            OpenCodeTransferFile, MAX_OPENCODE_TRANSFER_CHUNK_BYTES,
        };
        use freshell_sessions::opencode_transfer::{
            export_exact_session, ExportOptions, HostOpenCodeInventory,
        };
        use freshell_supervisor::opencode_transfer::{OpenCodeTransferStaging, StagingLimits};
        use sha2::{Digest, Sha256};

        let root = tempfile::tempdir().map_err(|error| error.to_string())?;
        let workspace = root.path().join("workspace");
        std::fs::create_dir_all(&workspace).map_err(|error| error.to_string())?;
        let source_database = root.path().join("source.sqlite");
        let source =
            rusqlite::Connection::open(&source_database).map_err(|error| error.to_string())?;
        source
            .execute_batch(freshell_sessions::opencode_transfer::pinned_destination_schema_sql())
            .map_err(|error| error.to_string())?;
        for migration in freshell_sessions::opencode_transfer::pinned_destination_migration_ids() {
            source
                .execute(
                    "INSERT INTO migration (id,time_completed) VALUES (?1,0)",
                    [migration],
                )
                .map_err(|error| error.to_string())?;
        }
        source
            .execute(
                "INSERT INTO project (id,worktree,time_created,time_updated,sandboxes) VALUES (?1,?2,1,1,'{}')",
                rusqlite::params!["synthetic-project", workspace.to_string_lossy()],
            )
            .map_err(|error| error.to_string())?;
        source
            .execute(
                "INSERT INTO session (id,project_id,slug,directory,title,version,time_created,time_updated) VALUES (?1,?2,?3,?4,?5,?6,1,1)",
                rusqlite::params![
                    "ses_synthetictransfersession",
                    "synthetic-project",
                    "synthetic-slug",
                    workspace.to_string_lossy(),
                    "synthetic history",
                    "1.18.21"
                ],
            )
            .map_err(|error| error.to_string())?;
        source
            .execute(
                "INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (?1,?2,1,1,?3)",
                rusqlite::params![
                    "synthetic-message",
                    "ses_synthetictransfersession",
                    r#"{"text":"synthetic message body is test-only"}"#
                ],
            )
            .map_err(|error| error.to_string())?;
        drop(source);

        let snapshot = export_exact_session(
            &HostOpenCodeInventory::new(source_database)
                .with_trusted_mount_for_selected_session(workspace.clone()),
            "ses_synthetictransfersession",
            ExportOptions::new(root.path().join("extraction")),
        )
        .map_err(|error| error.to_string())?;
        let mut payload = Vec::new();
        std::io::copy(
            &mut snapshot.open_payload().map_err(|error| error.to_string())?,
            &mut payload,
        )
        .map_err(|error| error.to_string())?;
        let manifest_json =
            serde_json::to_string(snapshot.manifest()).map_err(|error| error.to_string())?;
        let target_image_ref = format!("sha256:{}", "a".repeat(64));
        let files = vec![OpenCodeTransferFile {
            index: 0,
            relative_path: "payload.json".into(),
            size_bytes: payload.len() as u64,
            sha256: hex::encode(Sha256::digest(&payload)),
        }];
        let mut descriptor = OpenCodeTransferDescriptor {
            transfer_id: "synthetic-transfer".into(),
            provider: "opencode".into(),
            source_store_id: snapshot.manifest().source_store_id.clone(),
            root_session_id: "ses_synthetictransfersession".into(),
            source_generation: snapshot.manifest().generation.clone(),
            provider_schema: snapshot.manifest().provider_schema.clone(),
            source_schema_fingerprint: snapshot.manifest().source_schema_fingerprint.clone(),
            migration_journal_fingerprint: snapshot
                .manifest()
                .migration_journal_fingerprint
                .clone(),
            destination_store_id: "synthetic-soul".into(),
            destination_database_path: ".local/share/opencode/opencode.db".into(),
            target_image_ref: target_image_ref.clone(),
            target_build_receipt: opencode_target_build_receipt(
                &target_image_ref,
                "opencode-1.18.21",
            ),
            incarnation_id: "synthetic-incarnation".into(),
            manifest_json,
            files,
            total_bytes: payload.len() as u64,
            bundle_sha256: String::new(),
        };
        descriptor.bundle_sha256 =
            opencode_transfer_bundle_digest(&descriptor.manifest_json, &descriptor.files);
        descriptor.validate().map_err(|error| error.message)?;

        let staging = OpenCodeTransferStaging::new(root.path(), StagingLimits::production())
            .map_err(|error| error.to_string())?;
        let attempt_id = "cccccccccccccccccccccccccccccccc";
        staging
            .begin(&descriptor, attempt_id, u64::MAX)
            .map_err(|error| error.to_string())?;
        for (sequence, bytes) in payload
            .chunks(MAX_OPENCODE_TRANSFER_CHUNK_BYTES)
            .enumerate()
        {
            let offset = sequence * MAX_OPENCODE_TRANSFER_CHUNK_BYTES;
            let chunk = OpenCodeTransferChunk {
                transfer_id: descriptor.transfer_id.clone(),
                attempt_id: attempt_id.into(),
                sequence: sequence as u64,
                file_index: 0,
                offset: offset as u64,
                data: bytes.to_vec(),
                sha256: hex::encode(Sha256::digest(bytes)),
            };
            staging
                .write_chunk(&chunk)
                .map_err(|error| error.to_string())?;
        }
        let ready = staging
            .finalize(&descriptor.transfer_id, attempt_id)
            .map_err(|error| error.to_string())?;

        let home = root.path().join("provider-home");
        let xdg_data_home = home.join(".local/share");
        let xdg_config_home = home.join(".config");
        std::fs::create_dir_all(&home).map_err(|error| error.to_string())?;
        std::fs::create_dir_all(&xdg_config_home).map_err(|error| error.to_string())?;
        let bootstrap_root = root.path().join("bootstrap");
        std::fs::create_dir_all(&bootstrap_root).map_err(|error| error.to_string())?;
        let state_dir = root.path().join("host-state");
        std::fs::create_dir(&state_dir).map_err(|error| error.to_string())?;
        let incarnation_id =
            IncarnationId::parse("synthetic-incarnation").map_err(|error| error.to_string())?;
        let soul_id = SoulId::parse("synthetic-soul").map_err(|error| error.to_string())?;
        let provider_uid = unsafe { libc::geteuid() };
        let provider_gid = unsafe { libc::getegid() };
        let state = Arc::new(HostState {
            incarnation_id: incarnation_id.clone(),
            host_boot_id: HostBootId::new(),
            state_dir,
            secret: b"synthetic-host-secret-0123456789abcdef".to_vec(),
            requested_limits: RuntimeLimits {
                cpu_milli: 500,
                memory_bytes: 128 * 1024 * 1024,
                swap_bytes: 0,
                pids_max: 64,
            },
            persisted: Mutex::new(PersistedHostState::default()),
            child: Mutex::new(None),
            pty: Mutex::new(None),
            fresh_agent: Mutex::new(None),
            provider_config_paths: ProviderConfigPaths {
                private_mount: root.path().join("private"),
                provider_home: home.clone(),
            },
            opencode_transfer_mount: if failure == Some(SyntheticTransferFailure::Mount) {
                root.path().join("missing-transfer-mount")
            } else {
                ready.clone()
            },
            bootstrap_root,
        });
        let terminal = TerminalLaunchSpec {
            terminal_id: "synthetic-terminal".into(),
            stream_id: "synthetic-stream".into(),
            mode: "opencode".into(),
            program: "opencode".into(),
            args: vec!["--session".into(), descriptor.root_session_id.clone()],
            env: std::collections::BTreeMap::from([
                ("HOME".into(), home.to_string_lossy().into_owned()),
                (
                    "XDG_DATA_HOME".into(),
                    xdg_data_home.to_string_lossy().into_owned(),
                ),
                (
                    "XDG_CONFIG_HOME".into(),
                    xdg_config_home.to_string_lossy().into_owned(),
                ),
                (
                    "OPENCODE_DB".into(),
                    xdg_data_home
                        .join("opencode/opencode.db")
                        .to_string_lossy()
                        .into_owned(),
                ),
                ("FRESHELL_OPENCODE_REBIND".into(), "0".into()),
                ("PATH".into(), "/usr/bin:/bin".into()),
            ]),
            cwd: workspace.to_string_lossy().into_owned(),
            run_as_uid: provider_uid,
            run_as_gid: provider_gid,
            cols: 80,
            rows: 24,
            project_key: "synthetic-project".into(),
            workspace_path: workspace.to_string_lossy().into_owned(),
            git_common_dir: None,
            create_request_id: Some("synthetic-create".into()),
            resume_session_id: Some(descriptor.root_session_id.clone()),
            provider_model: None,
            provider_reasoning_effort: None,
            provider_sandbox: None,
            provider_permission_mode: None,
            provider_bootstrap_files: Vec::new(),
            provider_secret_references: Vec::new(),
            provider_launch_context: None,
            opencode_transfer: Some(descriptor.clone()),
            opencode_transfer_attempt_id: Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into()),
            opencode_adoption: None,
        };
        std::fs::write(
            root.path().join("opencode-transfer-descriptor.json"),
            serde_json::to_vec(&descriptor).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        std::fs::write(
            root.path().join("opencode-terminal.json"),
            serde_json::to_vec(&terminal).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        let runtime_dir = root.path().join("runtime");
        std::fs::create_dir(&runtime_dir).map_err(|error| error.to_string())?;
        let image_ref = descriptor.target_image_ref.clone();
        let backend_spec = freshell_supervisor::backend::CreateRuntimeSpec {
            installation_id: freshell_runtime_protocol::InstallationId::parse(
                "synthetic-installation",
            )
            .map_err(|error| error.to_string())?,
            soul_id: soul_id.clone(),
            incarnation_id: incarnation_id.clone(),
            image_ref,
            host_binary_path: root.path().join("freshell-session-host"),
            runtime_dir,
            limits: state.requested_limits,
            test_run_id: "synthetic-only".into(),
            terminal: Some(terminal.clone()),
            fresh_agent: None,
            opencode_transfer_dir: Some(ready.clone()),
            provider_volume_name: "freshell-provider-synthetic".into(),
        };
        let mount_plan = freshell_supervisor::backend::opencode_transfer_mount_plan(&backend_spec)
            .map_err(|error| error.to_string())?
            .ok_or("backend omitted the descriptor-bound transfer mount")?;
        let mount_inspection = vec![serde_json::json!({
            "Source": mount_plan.source,
            "Destination": freshell_supervisor::backend::OpenCodeTransferMountPlan::DESTINATION,
            "RW": false,
        })];
        freshell_supervisor::backend::verify_opencode_transfer_mount_inspection(
            &mount_inspection,
            Some(&mount_plan),
        )
        .map_err(|error| error.to_string())?;
        if mount_plan.docker_bind()
            != format!("{}:/run/freshell-opencode-transfer:ro", ready.display())
        {
            return Err("production backend mount bind differs from the staged bundle".into());
        }

        let grant_id = GrantId::new();
        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let pty_callback_invoked = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let adoption_expectation = Arc::new(std::sync::Mutex::new(None));
        let effects = SyntheticGrantExecutionEffects {
            failure,
            expected_grant_id: grant_id.clone(),
            events: events.clone(),
            pty_callback_invoked: pty_callback_invoked.clone(),
            adoption_expectation: adoption_expectation.clone(),
            pty_marker: None,
        };
        let envelope = authenticated_host_envelope(
            &state,
            HostCommand::GrantExecution {
                incarnation_id,
                soul_id,
                host_boot_id: state.host_boot_id.clone(),
                control_epoch: 1,
                execution_generation: 1,
                grant_id,
                fixture: None,
                terminal: Some(Box::new(terminal)),
                fresh_agent: None,
                resume_spec: None,
            },
        );
        let result = dispatch_with_effects(envelope, &state, &effects).await;
        Ok(SyntheticGateAttempt {
            root,
            state,
            result,
            events,
            pty_callback_invoked,
            adoption_expectation,
            mount_plan,
            mount_inspection,
        })
    }

    async fn run_synthetic_exact_resume(
        imported: &SyntheticGateAttempt,
        failure: Option<SyntheticTransferFailure>,
        stopped_repair_baseline: bool,
    ) -> Result<SyntheticResumeAttempt, String> {
        let root = imported.root.path();
        let descriptor: OpenCodeTransferDescriptor = serde_json::from_slice(
            &std::fs::read(root.join("opencode-transfer-descriptor.json"))
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        let mut terminal: TerminalLaunchSpec = serde_json::from_slice(
            &std::fs::read(root.join("opencode-terminal.json"))
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        let mut preserved_receipt = imported
            .state
            .persisted
            .try_lock()
            .map_err(|_| "prior synthetic grant state is still locked")?
            .opencode_transfer_receipt
            .clone();
        if failure == Some(SyntheticTransferFailure::ReadinessIdentityMismatch) {
            if let Some(receipt) = preserved_receipt.as_mut() {
                receipt.provider_uid = receipt.provider_uid.wrapping_add(1);
            }
        }
        let incarnation_id = IncarnationId::parse("synthetic-resume-incarnation")
            .map_err(|error| error.to_string())?;
        let soul_id = SoulId::parse("synthetic-soul").map_err(|error| error.to_string())?;
        let host_boot_id = HostBootId::new();
        let state_dir = root.join("host-state");
        let persisted_state_path = state_dir.join("host-state.json");
        if persisted_state_path.exists() {
            std::fs::remove_file(persisted_state_path).map_err(|error| error.to_string())?;
        }
        let home = PathBuf::from(&terminal.env["HOME"]);
        let state = Arc::new(HostState {
            incarnation_id: incarnation_id.clone(),
            host_boot_id: host_boot_id.clone(),
            state_dir,
            secret: b"synthetic-host-secret-0123456789abcdef".to_vec(),
            requested_limits: RuntimeLimits {
                cpu_milli: 500,
                memory_bytes: 128 * 1024 * 1024,
                swap_bytes: 0,
                pids_max: 64,
            },
            persisted: Mutex::new(PersistedHostState {
                host_boot_id: Some(host_boot_id.clone()),
                opencode_transfer_receipt: preserved_receipt,
                ..PersistedHostState::default()
            }),
            child: Mutex::new(None),
            pty: Mutex::new(None),
            fresh_agent: Mutex::new(None),
            provider_config_paths: ProviderConfigPaths {
                private_mount: root.join("private"),
                provider_home: home,
            },
            // A resume must not inspect or consume the staging mount.
            opencode_transfer_mount: root.join("missing-transfer-mount"),
            bootstrap_root: root.join("bootstrap"),
        });

        let mut resume_spec = ResumeSpec {
            schema_version: freshell_runtime_protocol::RESUME_SPEC_SCHEMA_VERSION,
            provider_session: freshell_runtime_protocol::ProviderSessionRef {
                provider: "opencode".into(),
                provider_store_id: descriptor.destination_store_id.clone(),
                native_session_id: descriptor.root_session_id.clone(),
            },
            mode: "opencode".into(),
            runtime_variant: "managed_terminal_pty".into(),
            fixture_transport: None,
            opencode_adoption_baseline: None,
            program: terminal.program.clone(),
            resume_argv: Vec::new(),
            provider_home: terminal.env["HOME"].clone(),
            provider_volume: None,
            cwd: terminal.cwd.clone(),
            workspace_path: terminal.workspace_path.clone(),
            project_key: Some(terminal.project_key.clone()),
            runtime_profile: None,
            environment: terminal.env.clone(),
            model: None,
            reasoning_effort: None,
            permission_mode: None,
            image_ref: Some(descriptor.target_image_ref.clone()),
            provider_version: Some("opencode-1.18.21".into()),
            credential_references: Vec::new(),
            identity_provenance: freshell_runtime_protocol::IdentityProvenance::Imported,
            durable_position: freshell_runtime_protocol::DurablePosition::default(),
            checkpoint_references: Vec::new(),
            creation_seed_ref: "synthetic-seed".into(),
            checkpoint_revision: 0,
            allocation_state: freshell_runtime_protocol::AllocationState::VerifiedDurable,
            evidence_revision: 1,
            never_dispatched: false,
        };
        if stopped_repair_baseline {
            let baseline = freshell_runtime_protocol::OpenCodeAdoptionBaseline {
                manifest_sha256: sha256_hex(descriptor.manifest_json.as_bytes()),
                descriptor: descriptor.clone(),
            };
            baseline.validate().map_err(|error| error.message)?;
            // Model a schema-7 terminal and resume row: neither had the later
            // transfer fields or the pinned OpenCode database override.
            terminal.opencode_transfer = None;
            terminal.opencode_transfer_attempt_id = None;
            terminal.opencode_adoption = None;
            terminal.resume_session_id = None;
            terminal.env.remove("OPENCODE_DB");
            resume_spec.opencode_adoption_baseline = Some(baseline);
            let provider_home = terminal.env["HOME"].clone();
            resume_spec
                .environment
                .insert("HOME".into(), provider_home.clone());
            resume_spec.environment.insert(
                "XDG_DATA_HOME".into(),
                format!("{provider_home}/.local/share"),
            );
            resume_spec
                .environment
                .insert("XDG_CONFIG_HOME".into(), format!("{provider_home}/.config"));
            resume_spec.environment.insert(
                "OPENCODE_DB".into(),
                format!("{provider_home}/.local/share/opencode/opencode.db"),
            );
            if failure == Some(SyntheticTransferFailure::SavedBaselineMismatch) {
                resume_spec
                    .opencode_adoption_baseline
                    .as_mut()
                    .expect("stopped repair test includes an adoption baseline")
                    .manifest_sha256 = "0".repeat(64);
            }
        }
        let grant_id = GrantId::new();
        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let pty_callback_invoked = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let adoption_expectation = Arc::new(std::sync::Mutex::new(None));
        let effects = SyntheticGrantExecutionEffects {
            failure,
            expected_grant_id: grant_id.clone(),
            events: events.clone(),
            pty_callback_invoked: pty_callback_invoked.clone(),
            adoption_expectation: adoption_expectation.clone(),
            pty_marker: None,
        };
        let envelope = authenticated_host_envelope(
            &state,
            HostCommand::GrantExecution {
                incarnation_id,
                soul_id,
                host_boot_id,
                control_epoch: 2,
                execution_generation: 2,
                grant_id,
                fixture: None,
                terminal: Some(Box::new(terminal)),
                fresh_agent: None,
                resume_spec: Some(Box::new(resume_spec)),
            },
        );
        let result = dispatch_with_effects(envelope, &state, &effects).await;
        Ok(SyntheticResumeAttempt {
            state,
            result,
            events,
            pty_callback_invoked,
            adoption_expectation,
        })
    }

    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "process-kill recovery test; run only through scripts/sandbox-test.sh"]
    async fn opencode_host_restarts_at_receipt_and_pre_pty_durable_boundaries() {
        use std::{
            os::unix::{fs::PermissionsExt, process::ExitStatusExt},
            process::Command,
        };

        const ROOT_ENV: &str = "FRESHELL_OPENCODE_HOST_CRASH_ROOT";
        const POINT_ENV: &str = "FRESHELL_OPENCODE_HOST_CRASH_POINT";
        let points = [
            "receipt.import.after_temp_write",
            "receipt.import.after_temp_sync",
            "receipt.import.after_link",
            "receipt.import.after_temp_remove",
            "receipt.import.after_directory_sync",
            "receipt.readable.after_temp_write",
            "receipt.readable.after_temp_sync",
            "receipt.readable.after_link",
            "receipt.readable.after_temp_remove",
            "receipt.readable.after_directory_sync",
            "state.after_temp_write",
            "state.after_temp_sync",
            "state.after_rename",
            "state.after_directory_sync",
            "grant.after_state_persist_before_pty",
        ];
        let executable = std::env::current_exe().expect("resolve this test executable");

        for point in points {
            let attempt = run_joined_synthetic_transfer(Some(SyntheticTransferFailure::Reader))
                .await
                .expect("prepare exact synthetic source, stage, and committed import");
            assert!(
                attempt.result.is_err(),
                "initial reader failure blocks: {point}"
            );
            assert!(!attempt
                .pty_callback_invoked
                .load(std::sync::atomic::Ordering::SeqCst));
            let root = attempt.root.path().to_path_buf();
            let state_dir = root.join("host-state");
            let import_name = "opencode-synthetic-transfer-import.json";
            if point.starts_with("receipt.import.") {
                std::fs::remove_file(state_dir.join(import_name))
                    .expect("start with no durable import receipt for publication crash");
            }

            let child = Command::new(&executable)
                .args([
                    "--exact",
                    "tests::opencode_host_transfer_crash_child",
                    "--ignored",
                    "--nocapture",
                ])
                .env(ROOT_ENV, &root)
                .env(POINT_ENV, point)
                .status()
                .expect("spawn synthetic host crash child");
            assert_eq!(
                child.signal(),
                Some(libc::SIGKILL),
                "child must be killed at {point}; exit={child:?}"
            );
            assert!(
                !root.join("synthetic-pty-invoked").exists(),
                "a crash before the PTY callback must not invoke the provider"
            );

            let state_path = state_dir.join("host-state.json");
            let state_should_be_published = matches!(
                point,
                "state.after_rename"
                    | "state.after_directory_sync"
                    | "grant.after_state_persist_before_pty"
            );
            assert_eq!(
                state_path.is_file(),
                state_should_be_published,
                "host grant/readiness state is either absent or atomically complete at {point}"
            );
            if state_should_be_published {
                let persisted: PersistedHostState =
                    serde_json::from_slice(&std::fs::read(&state_path).unwrap())
                        .expect("published host state must parse completely");
                assert!(persisted.grant_id.is_some());
                assert!(persisted.worker_pid.is_none());
                let receipt = persisted
                    .opencode_transfer_receipt
                    .expect("registry readiness receipt is part of the same durable state");
                assert_eq!(receipt.transfer_id, "synthetic-transfer");
                assert_eq!(receipt.root_session_id, "ses_synthetictransfersession");
            }

            let marker = root.join("synthetic-pty-invoked");
            let (result, events, pty_called) =
                dispatch_synthetic_fixture_from_root(&root, 2, marker.clone())
                    .await
                    .unwrap();
            assert!(matches!(
                result,
                Ok(HostResult::GrantAccepted {
                    worker_launch_count: 1,
                    ..
                })
            ));
            assert_eq!(
                *events.lock().unwrap(),
                ["import", "reader", "reader", "current", "pty"]
            );
            assert!(pty_called.load(std::sync::atomic::Ordering::SeqCst));
            assert!(
                marker.is_file(),
                "retry reaches PTY only after revalidation"
            );
        }

        for (crash_point, receipt_name, field, stale_value, expected_events) in [
            (
                "receipt.import.after_directory_sync",
                "opencode-synthetic-transfer-import.json",
                "sourceGeneration",
                "f".repeat(64),
                vec!["import"],
            ),
            (
                "receipt.readable.after_directory_sync",
                "opencode-synthetic-transfer-readable.json",
                "providerUid",
                u32::MAX.to_string(),
                vec!["import", "reader"],
            ),
        ] {
            let attempt = run_joined_synthetic_transfer(Some(SyntheticTransferFailure::Reader))
                .await
                .expect("prepare another exact synthetic transfer");
            let root = attempt.root.path().to_path_buf();
            if crash_point.starts_with("receipt.import.") {
                std::fs::remove_file(
                    root.join("host-state/opencode-synthetic-transfer-import.json"),
                )
                .expect("make this a receipt-publication crash rather than an idempotent replay");
            }
            let child = Command::new(&executable)
                .args([
                    "--exact",
                    "tests::opencode_host_transfer_crash_child",
                    "--ignored",
                    "--nocapture",
                ])
                .env(ROOT_ENV, &root)
                .env(POINT_ENV, crash_point)
                .status()
                .expect("spawn receipt publication crash child");
            assert_eq!(
                child.signal(),
                Some(libc::SIGKILL),
                "child must be killed at {crash_point}; exit={child:?}"
            );

            let receipt_path = root.join("host-state").join(receipt_name);
            let mut receipt: serde_json::Value = serde_json::from_slice(
                &std::fs::read(&receipt_path).expect("receipt publication is durable"),
            )
            .expect("durable receipt parses before synthetic tampering");
            #[cfg(unix)]
            std::fs::set_permissions(&receipt_path, std::fs::Permissions::from_mode(0o600))
                .expect("allow the synthetic test to write a conflicting receipt");
            receipt[field] = serde_json::Value::String(stale_value);
            std::fs::write(
                &receipt_path,
                serde_json::to_vec(&receipt).expect("encode synthetic stale receipt"),
            )
            .expect("write the conflicting synthetic receipt");
            #[cfg(unix)]
            std::fs::set_permissions(&receipt_path, std::fs::Permissions::from_mode(0o400))
                .expect("restore receipt read-only mode");

            let marker = root.join("synthetic-pty-invoked");
            let (result, events, pty_called) =
                dispatch_synthetic_fixture_from_root(&root, 2, marker.clone())
                    .await
                    .unwrap();
            assert!(
                result.is_err(),
                "a stale/conflicting {field} cannot authorize readiness"
            );
            assert_eq!(*events.lock().unwrap(), expected_events);
            assert!(!pty_called.load(std::sync::atomic::Ordering::SeqCst));
            assert!(!marker.exists(), "stale receipt must not reach PTY");
            assert!(
                !root.join("host-state/host-state.json").exists(),
                "a failed stale-receipt retry must not consume a grant or persist readiness"
            );
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "child fixture for opencode_host_restarts_at_receipt_and_pre_pty_durable_boundaries"]
    async fn opencode_host_transfer_crash_child() {
        const ROOT_ENV: &str = "FRESHELL_OPENCODE_HOST_CRASH_ROOT";
        let Some(root) = std::env::var_os(ROOT_ENV).map(PathBuf::from) else {
            return;
        };
        let marker = root.join("synthetic-pty-invoked");
        let (result, _, _) = dispatch_synthetic_fixture_from_root(&root, 1, marker)
            .await
            .unwrap();
        assert!(matches!(result, Ok(HostResult::GrantAccepted { .. })));
        unreachable!("the selected readiness or pre-PTY checkpoint must kill this child process");
    }

    #[cfg(unix)]
    #[test]
    fn opencode_transfer_provider_preparation_is_retryable_and_does_not_run_provider_or_open_db() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        let provider_home = root.path().join("provider-home");
        let bootstrap_root = root.path().join("bootstrap");
        let side_effect = root.path().join("provider-was-run");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&provider_home).unwrap();
        std::fs::set_permissions(&provider_home, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::create_dir(&bootstrap_root).unwrap();
        std::fs::write(
            bootstrap_root.join("provider-0"),
            b"synthetic approved bootstrap config",
        )
        .unwrap();
        let launcher = root.path().join("provider-launcher");
        std::fs::write(
            &launcher,
            format!("#!/bin/sh\ntouch '{}'\n", side_effect.display()),
        )
        .unwrap();
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755)).unwrap();
        let uid = unsafe { libc::geteuid() };
        let gid = unsafe { libc::getegid() };
        let mut terminal: TerminalLaunchSpec = serde_json::from_value(serde_json::json!({
            "terminalId":"opencode-transfer-prep",
            "streamId":"opencode-transfer-prep-stream",
            "mode":"opencode",
            "program":launcher,
            "args":["--continue"],
            "cwd":workspace,
            "runAsUid":uid,
            "runAsGid":gid,
            "cols":80,
            "rows":24,
            "projectKey":"synthetic-project",
            "workspacePath":workspace,
            "resumeSessionId":"ses_synthetic",
            "providerBootstrapFiles":[{
                "sourcePath":"synthetic-only",
                "providerRelativePath":".config/opencode/opencode.json"
            }]
        }))
        .unwrap();
        terminal.opencode_transfer = Some(OpenCodeTransferDescriptor {
            transfer_id: "synthetic-transfer".into(),
            provider: "opencode".into(),
            source_store_id: "synthetic-source".into(),
            root_session_id: "ses_synthetic".into(),
            source_generation: "synthetic-generation".into(),
            provider_schema: "opencode-1.18.21".into(),
            source_schema_fingerprint: "synthetic-schema".into(),
            migration_journal_fingerprint: "synthetic-migrations".into(),
            destination_store_id: "synthetic-soul".into(),
            destination_database_path: ".local/share/opencode/opencode.db".into(),
            target_image_ref: format!("sha256:{}", "a".repeat(64)),
            target_build_receipt: "synthetic-build".into(),
            incarnation_id: "incarnation-synthetic".into(),
            manifest_json: "{}".into(),
            files: Vec::new(),
            total_bytes: 0,
            bundle_sha256: "synthetic-bundle".into(),
        });
        let paths = ProviderConfigPaths {
            private_mount: root.path().join("private-mount"),
            provider_home: provider_home.clone(),
        };

        let prepared =
            prepare_provider_state_for_opencode_transfer_at(&mut terminal, &paths, &bootstrap_root)
                .expect("first transfer attempt should prepare the empty provider home");
        assert!(prepared);
        assert_eq!(
            std::fs::metadata(&provider_home).unwrap().uid(),
            uid,
            "preparation must finish by handing the provider HOME to the provider UID"
        );
        assert_eq!(
            std::fs::read(provider_home.join(".config/opencode/opencode.json")).unwrap(),
            b"synthetic approved bootstrap config"
        );
        assert!(
            !provider_home
                .join(".local/share/opencode/opencode.db")
                .exists(),
            "provider preparation must not open or create OPENCODE_DB"
        );
        assert!(
            !side_effect.exists(),
            "preparation must not run the provider launcher"
        );

        let retry =
            prepare_provider_state_for_opencode_transfer_at(&mut terminal, &paths, &bootstrap_root)
                .expect("a retry after durable home ownership must be a no-op");
        assert!(!retry);
        assert_eq!(
            std::fs::metadata(&provider_home)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert!(!side_effect.exists());
    }

    fn authenticated_host_envelope(state: &HostState, body: HostCommand) -> Envelope<HostCommand> {
        Envelope {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            request_id: freshell_runtime_protocol::RequestId::new(),
            role: ControlRole::Supervisor,
            auth: Some(host_proof(
                &state.secret,
                "command-auth",
                &state.host_boot_id,
                &state.incarnation_id,
            )),
            body,
        }
    }

    fn tempfile_like_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("freshell-host-test-{}", uuid_like()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn uuid_like() -> String {
        format!("{}-{}", std::process::id(), now_millis())
    }

    pub(crate) mod created_path_ownership {
        use super::*;
        use std::{
            cell::RefCell,
            collections::BTreeSet,
            os::unix::fs::{symlink, PermissionsExt},
            process::Command,
        };
        thread_local! {pub(crate) static OPERATIONS: RefCell<Vec<PathBuf>> = const {RefCell::new(Vec::new())};}
        fn handoff(home: &Path, ledger: &[PathBuf]) -> Result<(), String> {
            transfer_created_paths(
                "amplifier",
                home,
                ledger,
                unsafe { libc::geteuid() },
                unsafe { libc::getegid() },
            )
        }
        #[test]
        fn initial_home_becomes_private_before_handoff_and_refresh_keeps_its_inode() {
            use std::os::unix::fs::MetadataExt;
            let root = tempfile::tempdir().unwrap();
            let home = root.path().join("provider");
            std::fs::create_dir(&home).unwrap();
            std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o755)).unwrap();
            std::fs::write(home.join("provider-sibling"), "durable").unwrap();
            let inode = std::fs::metadata(&home).unwrap().ino();
            let sibling = std::fs::metadata(home.join("provider-sibling")).unwrap();
            let inputs = root.path().join("inputs");
            std::fs::create_dir(&inputs).unwrap();
            let ledger = write_provider_bootstrap_files("codex", &[], &home, &inputs).unwrap();
            handoff(&home, &ledger).unwrap();
            let initialized = std::fs::metadata(&home).unwrap();
            assert_eq!(initialized.mode() & 0o777, 0o700);
            assert_eq!(initialized.ino(), inode);
            assert_eq!(initialized.uid(), unsafe { libc::geteuid() });
            assert_eq!(initialized.gid(), unsafe { libc::getegid() });
            let stage = root.path().join("stage");
            std::fs::create_dir_all(stage.join("projection")).unwrap();
            std::fs::write(stage.join("manifest.json"), "[]").unwrap();
            std::fs::write(
                stage.join("projection").join(PROVIDER_PROJECTION_MANIFEST),
                "[]",
            )
            .unwrap();
            apply_staged_provider_config(&stage, &home).unwrap();
            let refreshed = std::fs::metadata(&home).unwrap();
            assert_eq!(
                (
                    refreshed.ino(),
                    refreshed.uid(),
                    refreshed.gid(),
                    refreshed.mode()
                ),
                (
                    initialized.ino(),
                    initialized.uid(),
                    initialized.gid(),
                    initialized.mode()
                )
            );
            assert_eq!(
                std::fs::metadata(home.join("provider-sibling"))
                    .unwrap()
                    .ino(),
                sibling.ino()
            );
            assert_eq!(
                std::fs::read(home.join("provider-sibling")).unwrap(),
                b"durable"
            );
        }
        #[test]
        fn all_selected_entries_above_ten_thousand_remain_runnable() {
            let root = tempfile::tempdir().unwrap();
            let source = root.path().join("source");
            std::fs::create_dir(&source).unwrap();
            for index in 0..10_005 {
                std::fs::write(source.join(format!("resource-{index}")), "nonce").unwrap();
            }
            std::fs::write(source.join("run"), "#!/bin/sh\nprintf runnable").unwrap();
            std::fs::set_permissions(source.join("run"), std::fs::Permissions::from_mode(0o700))
                .unwrap();
            let home = root.path().join("provider");
            freshell_platform::provider_environment::copy_environment(
                &[freshell_platform::provider_environment::CopySelection {
                    source,
                    destination_relative: "selected".into(),
                }],
                &home,
                &[],
                Default::default(),
            )
            .unwrap();
            let ensured = freshell_sessions::amplifier_stub::ensure_session(
                &home.join(".amplifier"),
                "new-session",
                root.path().to_str().unwrap(),
                "terminal",
            )
            .unwrap();
            let inputs = root.path().join("bootstrap-inputs");
            std::fs::create_dir(&inputs).unwrap();
            std::fs::write(inputs.join("provider-0"), "{}").unwrap();
            let mut ledger = ensured.created_paths;
            ledger.extend(
                write_provider_bootstrap_files(
                    "amplifier",
                    &[ProviderBootstrapFile {
                        source_path: inputs.join("provider-0").to_string_lossy().into_owned(),
                        provider_relative_path: "bootstrap/config.json".into(),
                    }],
                    &home,
                    &inputs,
                )
                .unwrap(),
            );
            assert!(ledger.contains(&home.join("bootstrap/config.json")));
            assert!(ledger.contains(&home.join("bootstrap")));
            handoff(&home, &ledger).unwrap();
            assert_eq!(
                std::fs::read_dir(home.join("selected")).unwrap().count(),
                10_006
            );
            let output = Command::new(home.join("selected/run")).output().unwrap();
            assert!(output.status.success());
            assert_eq!(output.stdout, b"runnable");
        }
        #[test]
        fn adopted_state_and_siblings_grant_no_recursive_authority() {
            let root = tempfile::tempdir().unwrap();
            let home = root.path().join("provider");
            let amplifier = home.join(".amplifier");
            std::fs::create_dir_all(&amplifier).unwrap();
            std::fs::write(amplifier.join("sibling"), "sentinel").unwrap();
            let first = freshell_sessions::amplifier_stub::ensure_session(
                &amplifier,
                "adopted",
                root.path().to_str().unwrap(),
                "terminal",
            )
            .unwrap();
            let adopted = freshell_sessions::amplifier_stub::ensure_session(
                &amplifier,
                "adopted",
                root.path().to_str().unwrap(),
                "terminal",
            )
            .unwrap();
            assert!(!adopted.created);
            OPERATIONS.with(|operations| operations.borrow_mut().clear());
            handoff(&home, &adopted.created_paths).unwrap();
            OPERATIONS.with(|operations| {
                assert!(
                    operations.borrow().is_empty(),
                    "adoption cannot transfer sibling or stub ownership: {:?}",
                    *operations.borrow()
                )
            });
            assert_eq!(
                std::fs::read(amplifier.join("sibling")).unwrap(),
                b"sentinel"
            );
            assert!(first.session_dir.exists());
        }
        #[test]
        fn partial_bootstrap_failure_leaves_no_created_ownership_authority() {
            let root = tempfile::tempdir().unwrap();
            let home = root.path().join("provider");
            let inputs = root.path().join("inputs");
            std::fs::create_dir(&home).unwrap();
            std::fs::create_dir(&inputs).unwrap();
            std::fs::write(home.join("sibling"), "sentinel").unwrap();
            std::fs::write(inputs.join("provider-0"), "{}").unwrap();
            let files = [
                ProviderBootstrapFile {
                    source_path: "fixture".into(),
                    provider_relative_path: "bootstrap/first.json".into(),
                },
                ProviderBootstrapFile {
                    source_path: "missing-fixture".into(),
                    provider_relative_path: "bootstrap/second.json".into(),
                },
            ];
            assert!(write_provider_bootstrap_files("amplifier", &files, &home, &inputs).is_err());
            assert!(!home.join("bootstrap").exists());
            assert_eq!(std::fs::read(home.join("sibling")).unwrap(), b"sentinel");
        }

        #[test]
        fn bootstrap_later_input_failure_preserves_existing_leaf_and_allows_retry() {
            use std::os::unix::fs::MetadataExt;
            let root = tempfile::tempdir().unwrap();
            let home = root.path().join("provider");
            let inputs = root.path().join("inputs");
            std::fs::create_dir_all(home.join("bootstrap")).unwrap();
            std::fs::create_dir(&inputs).unwrap();
            let first = home.join("bootstrap/first.json");
            let sibling = home.join("bootstrap/sibling");
            std::fs::write(&first, "prior-config").unwrap();
            std::fs::set_permissions(&first, std::fs::Permissions::from_mode(0o640)).unwrap();
            std::fs::write(&sibling, "provider-sibling").unwrap();
            let before = std::fs::metadata(&first).unwrap();
            let sibling_before = std::fs::metadata(&sibling).unwrap();
            std::fs::write(inputs.join("provider-0"), "new-config").unwrap();
            let files = [
                ProviderBootstrapFile {
                    source_path: "fixture".into(),
                    provider_relative_path: "bootstrap/first.json".into(),
                },
                ProviderBootstrapFile {
                    source_path: "fixture".into(),
                    provider_relative_path: "bootstrap/second.json".into(),
                },
            ];
            assert!(write_provider_bootstrap_files("amplifier", &files, &home, &inputs).is_err());
            assert_eq!(
                std::fs::read(&first).expect("prior config must survive failed bootstrap"),
                b"prior-config"
            );
            let after = std::fs::metadata(&first).unwrap();
            assert_eq!(
                (after.ino(), after.uid(), after.gid(), after.mode()),
                (before.ino(), before.uid(), before.gid(), before.mode())
            );
            assert_eq!(std::fs::read(&sibling).unwrap(), b"provider-sibling");
            assert_eq!(
                std::fs::metadata(&sibling).unwrap().ino(),
                sibling_before.ino()
            );
            assert!(!home.join("bootstrap/second.json").exists());
            std::fs::write(inputs.join("provider-1"), "second-config").unwrap();
            let owned =
                write_provider_bootstrap_files("amplifier", &files, &home, &inputs).unwrap();
            assert!(
                owned.contains(&first),
                "replacement inode needs exact ownership handoff"
            );
            assert!(!owned.contains(&sibling));
            assert!(!owned.contains(&home.join("bootstrap")));
            assert_eq!(std::fs::read(&first).unwrap(), b"new-config");
            assert_eq!(
                std::fs::read(home.join("bootstrap/second.json")).unwrap(),
                b"second-config"
            );
            assert_eq!(std::fs::read(&sibling).unwrap(), b"provider-sibling");
        }

        #[test]
        fn bootstrap_late_publication_failure_restores_replacements_and_removes_only_new_paths() {
            use std::os::unix::fs::MetadataExt;
            let root = tempfile::tempdir().unwrap();
            let home = root.path().join("provider");
            let inputs = root.path().join("inputs");
            std::fs::create_dir_all(home.join("bootstrap")).unwrap();
            std::fs::create_dir(&inputs).unwrap();
            let first = home.join("bootstrap/first.json");
            let last = home.join("bootstrap/zz-last.json");
            let sibling = home.join("bootstrap/sibling");
            for (path, bytes, mode) in [
                (&first, "prior-first", 0o640),
                (&last, "prior-last", 0o700),
                (&sibling, "provider-sibling", 0o600),
            ] {
                std::fs::write(path, bytes).unwrap();
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
            }
            let metadata = |path: &Path| {
                let value = std::fs::metadata(path).unwrap();
                (value.ino(), value.uid(), value.gid(), value.mode())
            };
            let before = [metadata(&first), metadata(&last), metadata(&sibling)];
            let files = [
                "bootstrap/first.json",
                "bootstrap/middle-created/second.json",
                "bootstrap/zz-last.json",
            ]
            .map(|relative| ProviderBootstrapFile {
                source_path: "fixture".into(),
                provider_relative_path: relative.into(),
            });
            for index in 0..files.len() {
                std::fs::write(
                    inputs.join(format!("provider-{index}")),
                    format!("new-{index}"),
                )
                .unwrap();
            }
            let mut published = 0;
            let failure = write_provider_bootstrap_files_with_publish(
                "amplifier",
                &files,
                &home,
                &inputs,
                |source, destination| {
                    published += 1;
                    if published == 3 {
                        assert_eq!(
                            std::fs::read(&first).unwrap(),
                            b"new-0",
                            "first replacement was actually published before failure"
                        );
                        assert_eq!(
                            std::fs::read(home.join("bootstrap/middle-created/second.json"))
                                .unwrap(),
                            b"new-1"
                        );
                        return Err(std::io::Error::other("synthetic late publication failure"));
                    }
                    std::fs::rename(source, destination)
                },
            );
            assert!(failure.unwrap_err().contains("publish_leaf"));
            assert_eq!(published, 3);
            assert_eq!(std::fs::read(&first).unwrap(), b"prior-first");
            assert_eq!(std::fs::read(&last).unwrap(), b"prior-last");
            assert_eq!(std::fs::read(&sibling).unwrap(), b"provider-sibling");
            assert_eq!(
                [metadata(&first), metadata(&last), metadata(&sibling)],
                before
            );
            assert!(!home.join("bootstrap/middle-created").exists());
            assert_eq!(
                std::fs::read_dir(&home).unwrap().count(),
                1,
                "attempt staging/backup paths must be cleaned"
            );
            let owned =
                write_provider_bootstrap_files("amplifier", &files, &home, &inputs).unwrap();
            assert!(owned.contains(&first));
            assert!(owned.contains(&last));
            assert!(owned.contains(&home.join("bootstrap/middle-created")));
            assert!(!owned.contains(&home.join("bootstrap")));
            assert!(!owned.contains(&sibling));
            assert_eq!(std::fs::read(&first).unwrap(), b"new-0");
            assert_eq!(std::fs::read(&last).unwrap(), b"new-2");
            assert_eq!(metadata(&sibling), before[2]);
        }

        #[test]
        fn physical_handoff_records_only_created_inodes_and_never_follows_links() {
            let root = tempfile::tempdir().unwrap();
            let home = root.path().join("provider");
            std::fs::create_dir(&home).unwrap();
            let outside = root.path().join("outside");
            std::fs::write(&outside, "sentinel").unwrap();
            use std::os::unix::fs::MetadataExt;
            let before = std::fs::metadata(&outside).unwrap();
            let leaf = home.join("bootstrap.json");
            std::fs::write(&leaf, "{}").unwrap();
            let link = home.join("selected-link");
            symlink(&outside, &link).unwrap();
            let ledger = vec![leaf.clone(), link.clone(), home.clone()];
            OPERATIONS.with(|operations| operations.borrow_mut().clear());
            handoff(&home, &ledger).unwrap();
            OPERATIONS.with(|operations| {
                let operations = operations.borrow();
                assert_eq!(
                    operations.iter().cloned().collect::<BTreeSet<_>>(),
                    ledger.into_iter().collect()
                );
                assert_eq!(operations.last(), Some(&home));
            });
            assert_eq!(std::fs::read(&outside).unwrap(), b"sentinel");
            let after = std::fs::metadata(&outside).unwrap();
            assert_eq!(
                (after.uid(), after.gid(), after.ctime(), after.ctime_nsec()),
                (
                    before.uid(),
                    before.gid(),
                    before.ctime(),
                    before.ctime_nsec()
                ),
                "physical lchown must leave the target inode untouched"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn provider_config_absent_new_auth_preserves_verified_native_credential_inode() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("provider");
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        let auth = home.join(".codex/auth.json");
        std::fs::write(&auth, b"existing-selected-onecli-auth").unwrap();
        std::fs::set_permissions(&auth, std::fs::Permissions::from_mode(0o400)).unwrap();
        let before = std::fs::metadata(&auth).unwrap();
        prepare_provider_files_at(
            "codex",
            &[],
            unsafe { libc::geteuid() },
            unsafe { libc::getegid() },
            &home,
            &root.path().join("auth-stage"),
        )
        .unwrap();
        let after=std::fs::metadata(&auth).expect("empty new references cannot remove credentials already qualified in the exact provider volume");
        assert_eq!(
            (after.ino(), after.mode(), after.uid(), after.gid()),
            (before.ino(), before.mode(), before.uid(), before.gid())
        );
        assert_eq!(
            std::fs::read(&auth).unwrap(),
            b"existing-selected-onecli-auth"
        );
    }

    #[test]
    fn provider_config_selected_amplifier_bundle_binds_new_seed_and_preserves_existing_metadata() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("provider");
        let selected = root.path().join("selected");
        std::fs::create_dir(&home).unwrap();
        std::fs::create_dir(&selected).unwrap();
        std::fs::write(
            selected.join("settings.yaml"),
            "bundle:\n  active: selected-ordinary\n",
        )
        .unwrap();
        let mut terminal:TerminalLaunchSpec=serde_json::from_value(serde_json::json!({"terminalId":"bundle-seed","streamId":"stream","mode":"amplifier","program":"amplifier","args":[],"cwd":root.path(),"runAsUid":unsafe{libc::geteuid()},"runAsGid":unsafe{libc::getegid()},"cols":80,"rows":24,"projectKey":"project","workspacePath":root.path(),"resumeSessionId":"exact-seed","providerLaunchContext":{"preparation":{"amplifier":{"bundle":"default","resume_args":[]}},"config":[{"root":"user_provider","relativePath":"settings.yaml","providerRelativePath":".amplifier/settings.yaml","format":"yaml"}]}})).unwrap();
        let ledger =
            providers::prepare_provider_state_before_bootstrap_at(&mut terminal, &home, &selected)
                .unwrap();
        let metadata = ledger
            .iter()
            .find(|path| path.file_name().is_some_and(|name| name == "metadata.json"))
            .unwrap();
        let bytes = std::fs::read(metadata).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            value["bundle"], "selected-ordinary",
            "a new native seed must use the selected global settings before projection"
        );
        std::fs::write(selected.join("settings.yaml"), "bundle:\n  active: other\n").unwrap();
        assert!(providers::prepare_provider_state_before_bootstrap_at(
            &mut terminal,
            &home,
            &selected
        )
        .unwrap()
        .is_empty());
        assert_eq!(
            std::fs::read(metadata).unwrap(),
            bytes,
            "an exact existing session retains its native metadata"
        );
    }

    #[cfg(unix)]
    #[test]
    fn provider_config_first_amplifier_launch_transfers_exact_created_state_before_copy() {
        use freshell_runtime_protocol::{
            ProviderConfigReference, ProviderConfigRoot, ProviderLaunchContext, ProviderPreparation,
        };
        use std::{cell::Cell, process::Command};
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("provider");
        let private = root.path().join("private");
        let source = private.join("user-provider");
        std::fs::create_dir_all(source.join("skills/fixture")).unwrap();
        std::fs::create_dir(&home).unwrap();
        std::fs::write(
            source.join("skills/fixture/run"),
            "#!/bin/sh\nprintf runnable",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            source.join("skills/fixture/run"),
            std::fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        let mut terminal:TerminalLaunchSpec=serde_json::from_value(serde_json::json!({"terminalId":"first-amplifier","streamId":"stream","mode":"amplifier","program":"amplifier","args":[],"cwd":root.path(),"runAsUid":unsafe{libc::geteuid()},"runAsGid":unsafe{libc::getegid()},"cols":80,"rows":24,"projectKey":"project","workspacePath":root.path(),"resumeSessionId":"session"})).unwrap();
        terminal.provider_launch_context = Some(ProviderLaunchContext {
            preparation: ProviderPreparation::Amplifier {
                bundle: "default".into(),
                resume_args: Vec::new(),
            },
            mcp_capability: None,
            config: vec![ProviderConfigReference {
                root: ProviderConfigRoot::UserProvider,
                relative_path: "skills".into(),
                provider_relative_path: ".amplifier/skills".into(),
                format: "directory".into(),
            }],
        });
        let handed_off = Cell::new(false);
        prepare_provider_state_before_bootstrap_with(
            &mut terminal,
            |terminal| {
                let ensured = freshell_sessions::amplifier_stub::ensure_session(
                    &home.join(".amplifier"),
                    "session",
                    &terminal.cwd,
                    &terminal.terminal_id,
                )
                .map_err(|error| error.to_string())?;
                let mut ledger = ensured.created_paths;
                ledger.push(home.clone());
                Ok(ledger)
            },
            |terminal, ledger| {
                assert!(!home.join(".amplifier/skills").exists());
                transfer_created_paths(
                    &terminal.mode,
                    &home,
                    ledger,
                    terminal.run_as_uid,
                    terminal.run_as_gid,
                )?;
                handed_off.set(true);
                Ok(())
            },
            |terminal| {
                assert!(handed_off.get());
                prepare_provider_context_for_fresh_launch(
                    terminal,
                    &ProviderConfigPaths {
                        private_mount: private.clone(),
                        provider_home: home.clone(),
                    },
                )
            },
        )
        .unwrap();
        let output = Command::new(home.join(".amplifier/skills/fixture/run"))
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"runnable");
    }

    #[cfg(unix)]
    #[test]
    fn provider_config_two_stage_script_is_runnable() {
        use std::{os::unix::fs::PermissionsExt, process::Command};
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("run"), "#!/bin/sh\nprintf resource-nonce\n").unwrap();
        std::fs::set_permissions(source.join("run"), std::fs::Permissions::from_mode(0o700))
            .unwrap();
        let stage = root.path().join("stage");
        let home = root.path().join("home");
        copy_provider_config_entry(&source, &source, &stage, &mut Vec::new(), &mut 0, 0).unwrap();
        copy_provider_config_entry(&stage, &stage, &home, &mut Vec::new(), &mut 0, 0).unwrap();
        let output = Command::new(home.join("run"))
            .output()
            .expect("two-stage executable spawn");
        assert!(output.status.success());
        assert_eq!(output.stdout, b"resource-nonce");
    }

    #[test]
    fn provider_config_copy_preserves_package_resources_and_rejects_selected_credentials() {
        use freshell_runtime_protocol::{
            ProviderConfigReference, ProviderConfigRoot, ProviderLaunchContext, ProviderPreparation,
        };
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("user-provider");
        let destination = root.path().join("soul-home");
        std::fs::create_dir_all(source.join("plugins")).unwrap();
        std::fs::create_dir_all(&destination).unwrap();
        std::fs::write(source.join("settings.json"), b"{\"theme\":\"dark\"}").unwrap();
        std::fs::write(source.join(".credentials.json"), b"test-secret-value").unwrap();
        std::fs::write(source.join("plugins/ordinary.js"), b"export default {};").unwrap();
        std::fs::write(source.join("plugins/auth.json"), b"test-secret-value").unwrap();
        let context = ProviderLaunchContext {
            preparation: ProviderPreparation::Claude {
                mcp_args: Vec::new(),
            },
            mcp_capability: None,
            config: vec![
                ProviderConfigReference {
                    root: ProviderConfigRoot::UserProvider,
                    relative_path: "settings.json".into(),
                    provider_relative_path: ".claude/settings.json".into(),
                    format: "json".into(),
                },
                ProviderConfigReference {
                    root: ProviderConfigRoot::UserProvider,
                    relative_path: "plugins".into(),
                    provider_relative_path: ".claude/plugins".into(),
                    format: "directory".into(),
                },
            ],
        };
        copy_provider_config_references(
            &context,
            "claude",
            root.path(),
            &source,
            &destination,
            unsafe { libc::geteuid() },
            unsafe { libc::getegid() },
        )
        .unwrap();
        assert_eq!(
            std::fs::read(destination.join(".claude/settings.json")).unwrap(),
            b"{\"theme\":\"dark\"}"
        );
        assert!(destination.join(".claude/plugins/ordinary.js").is_file());
        assert_eq!(
            std::fs::read(destination.join(".claude/plugins/auth.json")).unwrap(),
            b"test-secret-value"
        );
        assert!(!destination.join(".claude/.credentials.json").exists());

        assert!(copy_provider_config_references(
            &context,
            "unapproved",
            root.path(),
            &source,
            &destination,
            unsafe { libc::geteuid() },
            unsafe { libc::getegid() }
        )
        .is_err());
        let mut forbidden = context;
        forbidden.config[0].relative_path = ".credentials.json".into();
        assert!(copy_provider_config_references(
            &forbidden,
            "claude",
            root.path(),
            &source,
            &destination,
            unsafe { libc::geteuid() },
            unsafe { libc::getegid() }
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn provider_config_copy_keeps_selected_external_and_in_root_resources() {
        use freshell_runtime_protocol::{
            ProviderConfigReference, ProviderConfigRoot, ProviderLaunchContext, ProviderPreparation,
        };
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        let outside = root.path().join("outside");
        let destination = root.path().join("provider-home");
        std::fs::create_dir_all(workspace.join("inside")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::create_dir_all(&destination).unwrap();
        std::fs::write(workspace.join("inside/opencode.json"), b"inside").unwrap();
        std::fs::write(outside.join("opencode.json"), b"outside-secret").unwrap();
        symlink(&outside, workspace.join(".opencode")).unwrap();
        symlink(workspace.join("inside"), workspace.join("linked-inside")).unwrap();
        let context = ProviderLaunchContext {
            preparation: ProviderPreparation::Opencode {
                project_config: vec![
                    ProviderConfigReference {
                        root: ProviderConfigRoot::Workspace,
                        relative_path: ".opencode/opencode.json".into(),
                        provider_relative_path: ".config/opencode/project/escaped.json".into(),
                        format: "json".into(),
                    },
                    ProviderConfigReference {
                        root: ProviderConfigRoot::Workspace,
                        relative_path: "linked-inside/opencode.json".into(),
                        provider_relative_path: ".config/opencode/project/allowed.json".into(),
                        format: "json".into(),
                    },
                ],
                tui_config: None,
                tui_source: None,
                inline_config: false,
            },
            mcp_capability: None,
            config: Vec::new(),
        };
        copy_provider_config_references(
            &context,
            "opencode",
            &workspace,
            root.path(),
            &destination,
            unsafe { libc::geteuid() },
            unsafe { libc::getegid() },
        )
        .unwrap();
        assert_eq!(
            std::fs::read(destination.join(".config/opencode/project/escaped.json")).unwrap(),
            b"outside-secret"
        );
        assert_eq!(
            std::fs::read(destination.join(".config/opencode/project/allowed.json")).unwrap(),
            b"inside"
        );
    }

    #[cfg(unix)]
    #[test]
    fn provider_config_failed_staged_resource_preserves_previous_projection_and_retry() {
        use std::os::unix::fs::{symlink, MetadataExt};
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let stage = root.path().join("stage");
        std::fs::create_dir_all(home.join("skills")).unwrap();
        std::fs::create_dir_all(stage.join("projection/skills")).unwrap();
        std::fs::write(home.join("skills/old"), "prior-nonce").unwrap();
        std::fs::write(home.join("skills/sibling"), "sibling-nonce").unwrap();
        std::fs::write(
            home.join(PROVIDER_PROJECTION_MANIFEST),
            r#"["skills","skills/old"]"#,
        )
        .unwrap();
        std::fs::write(
            stage.join("projection").join(PROVIDER_PROJECTION_MANIFEST),
            r#"["skills","skills/new"]"#,
        )
        .unwrap();
        std::fs::write(stage.join("manifest.json"), r#"["skills"]"#).unwrap();
        symlink("missing", stage.join("projection/skills/new")).unwrap();
        let before = std::fs::metadata(&home).unwrap().ino();
        assert!(apply_staged_provider_config(&stage, &home).is_err());
        assert_eq!(
            std::fs::read(home.join("skills/old"))
                .expect("prior projection must survive failed staging"),
            b"prior-nonce"
        );
        assert_eq!(
            read_projection_manifest(&home).unwrap(),
            ["skills".to_owned(), "skills/old".to_owned()]
                .into_iter()
                .collect()
        );
        assert_eq!(
            std::fs::read(home.join("skills/sibling")).unwrap(),
            b"sibling-nonce"
        );
        std::fs::remove_file(stage.join("projection/skills/new")).unwrap();
        std::fs::write(stage.join("projection/skills/new"), "new-nonce").unwrap();
        apply_staged_provider_config(&stage, &home).unwrap();
        assert_eq!(std::fs::metadata(&home).unwrap().ino(), before);
        assert!(!home.join("skills/old").exists());
        assert_eq!(
            std::fs::read(home.join("skills/new")).unwrap(),
            b"new-nonce"
        );
        assert_eq!(
            std::fs::read(home.join("skills/sibling")).unwrap(),
            b"sibling-nonce"
        );
    }

    #[test]
    fn provider_config_exact_resume_refreshes_changes_and_removes_stale_projection() {
        use freshell_runtime_protocol::{
            ProviderConfigReference, ProviderConfigRoot, ProviderLaunchContext, ProviderPreparation,
        };
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("user-provider");
        let destination = root.path().join("provider-home");
        std::fs::create_dir_all(source.join("plugins")).unwrap();
        std::fs::create_dir_all(&destination).unwrap();
        std::fs::write(source.join("settings.json"), b"first").unwrap();
        std::fs::write(source.join("plugins/old.js"), b"old").unwrap();
        let mut context = ProviderLaunchContext {
            preparation: ProviderPreparation::Claude {
                mcp_args: Vec::new(),
            },
            mcp_capability: None,
            config: vec![
                ProviderConfigReference {
                    root: ProviderConfigRoot::UserProvider,
                    relative_path: "settings.json".into(),
                    provider_relative_path: ".claude/settings.json".into(),
                    format: "json".into(),
                },
                ProviderConfigReference {
                    root: ProviderConfigRoot::UserProvider,
                    relative_path: "plugins".into(),
                    provider_relative_path: ".claude/plugins".into(),
                    format: "directory".into(),
                },
            ],
        };
        let uid = unsafe { libc::geteuid() };
        let gid = unsafe { libc::getegid() };
        copy_provider_config_references(
            &context,
            "claude",
            root.path(),
            &source,
            &destination,
            uid,
            gid,
        )
        .unwrap();
        std::fs::write(
            destination.join(".claude/plugins/provider-created.js"),
            b"durable",
        )
        .unwrap();
        std::fs::write(source.join("settings.json"), b"second").unwrap();
        std::fs::remove_file(source.join("plugins/old.js")).unwrap();
        std::fs::write(source.join("plugins/new.js"), b"new").unwrap();
        refresh_provider_config_references(
            &context,
            "claude",
            root.path(),
            &source,
            &destination,
            uid,
            gid,
        )
        .unwrap();
        let child_output = std::process::Command::new("/usr/bin/cat")
            .arg(destination.join(".claude/settings.json"))
            .output()
            .unwrap();
        assert!(child_output.status.success());
        assert_eq!(child_output.stdout, b"second");
        assert!(!destination.join(".claude/plugins/old.js").exists());
        assert_eq!(
            std::fs::read(destination.join(".claude/plugins/new.js")).unwrap(),
            b"new"
        );
        assert_eq!(
            std::fs::read(destination.join(".claude/plugins/provider-created.js")).unwrap(),
            b"durable"
        );
        std::fs::remove_file(source.join("settings.json")).unwrap();
        let error = refresh_provider_config_references(
            &context,
            "claude",
            root.path(),
            &source,
            &destination,
            uid,
            gid,
        )
        .unwrap_err();
        assert!(error.contains("settings.json") && error.contains("repair"));
        assert_eq!(
            std::fs::read(destination.join(".claude/settings.json")).unwrap(),
            b"second"
        );
        assert_eq!(
            std::fs::read(destination.join(".claude/plugins/provider-created.js")).unwrap(),
            b"durable"
        );
        context
            .config
            .retain(|reference| reference.relative_path != "settings.json");
        refresh_provider_config_references(
            &context,
            "claude",
            root.path(),
            &source,
            &destination,
            uid,
            gid,
        )
        .unwrap();
        assert!(!destination.join(".claude/settings.json").exists());
    }

    #[cfg(unix)]
    #[test]
    fn provider_config_codex_linked_skills_and_discovery_survive_repeated_resume() {
        use freshell_platform::provider_environment::{copy_environment, CopySelection};
        use freshell_runtime_protocol::{
            ProviderConfigReference, ProviderConfigRoot, ProviderLaunchContext, ProviderPreparation,
        };
        use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
        let root = tempfile::tempdir().unwrap();
        let original = root.path().join("original");
        let external = root.path().join("external-skills");
        let discovered = original.join(".agents/skills");
        for directory in [&external, &discovered] {
            std::fs::create_dir_all(directory.join("fixture/scripts")).unwrap();
            std::fs::write(directory.join("fixture/SKILL.md"), "fixture").unwrap();
            std::fs::write(directory.join("fixture/resource"), "resource-nonce\n").unwrap();
            let script = directory.join("fixture/scripts/run");
            std::fs::write(
                &script,
                "#!/bin/sh\ncat \"$(dirname \"$0\")/../resource\"\n",
            )
            .unwrap();
            std::fs::set_permissions(script, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        std::fs::create_dir_all(original.join(".codex")).unwrap();
        symlink(&external, original.join(".codex/skills")).unwrap();
        let controller = root.path().join("controller");
        copy_environment(
            &[
                CopySelection {
                    source: original.join(".codex/skills"),
                    destination_relative: "skills".into(),
                },
                CopySelection {
                    source: discovered,
                    destination_relative: "freshell-discovered-agents".into(),
                },
            ],
            &controller,
            &[],
            Default::default(),
        )
        .unwrap();
        let context = ProviderLaunchContext {
            preparation: ProviderPreparation::Codex {
                tui_args: vec![],
                sidecar_args: vec![],
            },
            mcp_capability: None,
            config: [
                ("skills", ".codex/skills"),
                (
                    "freshell-discovered-agents",
                    ".codex/skills/freshell-discovered-agents",
                ),
                (".freshell/resources", ".freshell/resources"),
            ]
            .into_iter()
            .map(|(source, destination)| ProviderConfigReference {
                root: ProviderConfigRoot::UserProvider,
                relative_path: source.into(),
                provider_relative_path: destination.into(),
                format: "directory".into(),
            })
            .collect(),
        };
        let home = root.path().join("provider");
        std::fs::create_dir(&home).unwrap();
        let uid = unsafe { libc::geteuid() };
        let gid = unsafe { libc::getegid() };
        copy_provider_config_references(
            &context,
            "codex",
            root.path(),
            &controller,
            &home,
            uid,
            gid,
        )
        .unwrap();
        assert!(std::fs::symlink_metadata(home.join(".codex/skills"))
            .unwrap()
            .file_type()
            .is_symlink());
        let sibling = home.join(".codex/skills/provider-sibling");
        std::fs::write(&sibling, "durable-nonce").unwrap();
        let inode = std::fs::metadata(&sibling).unwrap().ino();
        for _ in 0..3 {
            refresh_provider_config_references(
                &context,
                "codex",
                root.path(),
                &controller,
                &home,
                uid,
                gid,
            )
            .unwrap();
            for relative in [
                ".codex/skills/fixture/scripts/run",
                ".codex/skills/freshell-discovered-agents/fixture/scripts/run",
            ] {
                let output = std::process::Command::new(home.join(relative))
                    .output()
                    .unwrap();
                assert!(output.status.success(), "{output:?}");
                assert_eq!(output.stdout, b"resource-nonce\n");
            }
            assert_eq!(std::fs::metadata(&sibling).unwrap().ino(), inode);
            assert_eq!(std::fs::read(&sibling).unwrap(), b"durable-nonce");
        }
    }

    #[cfg(unix)]
    #[test]
    fn provider_config_unplanned_parent_alias_does_not_modify_outside_target() {
        use std::os::unix::fs::{symlink, MetadataExt};
        let root = tempfile::tempdir().unwrap();
        let outside = root.path().join("outside");
        let home = root.path().join("home");
        let stage = root.path().join("stage");
        std::fs::create_dir(&outside).unwrap();
        std::fs::create_dir(&home).unwrap();
        std::fs::create_dir_all(stage.join("projection/.codex/skills")).unwrap();
        std::fs::write(outside.join("sentinel"), "unchanged").unwrap();
        let inode = std::fs::metadata(outside.join("sentinel")).unwrap().ino();
        symlink(&outside, home.join(".codex")).unwrap();
        std::fs::write(stage.join("manifest.json"), r#"[".codex/skills"]"#).unwrap();
        std::fs::write(
            stage.join("projection").join(PROVIDER_PROJECTION_MANIFEST),
            r#"[".codex",".codex/skills"]"#,
        )
        .unwrap();
        assert!(apply_staged_provider_config(&stage, &home).is_err());
        assert_eq!(
            std::fs::metadata(outside.join("sentinel")).unwrap().ino(),
            inode
        );
        assert_eq!(
            std::fs::read(outside.join("sentinel")).unwrap(),
            b"unchanged"
        );
        assert!(!outside.join("skills").exists());
    }

    #[test]
    fn provider_config_spawned_host_preparation_emits_safe_jsonl() {
        // Re-exec an existing behavior test so the production preparation and
        // ownership helpers run in a fresh process with no tracing subscriber.
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "tests::provider_config_first_amplifier_launch_transfers_exact_created_state_before_copy", "--nocapture"])
            .output().unwrap();
        assert!(output.status.success(), "{output:?}");
        let events = std::str::from_utf8(&output.stderr)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .collect::<Vec<_>>();
        for name in [
            "provider.environment.ownership.started",
            "provider.environment.ownership.completed",
            "provider.environment.copy.started",
            "provider.environment.copy.completed",
        ] {
            let event = events
                .iter()
                .find(|event| event["event"] == name && event["stage"] == "session_host")
                .expect("spawned preparation must emit each event");
            assert_eq!(event["provider"], "amplifier");
        }
        // The existing selected-resource failure regression runs both a real
        // successful copy and a missing selected input in the fresh process.
        let failed = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "tests::provider_config_exact_resume_refreshes_changes_and_removes_stale_projection", "--nocapture"])
            .output().unwrap();
        assert!(failed.status.success(), "{failed:?}");
        let events = std::str::from_utf8(&failed.stderr)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .collect::<Vec<_>>();
        let event = events
            .iter()
            .find(|event| {
                event["event"] == "provider.environment.copy.failed"
                    && event["stage"] == "session_host"
            })
            .expect("spawned failed preparation must emit typed error");
        assert_eq!(event["provider"], "claude");
        assert_eq!(event["relative_path"], ".claude/settings.json");
        assert_eq!(event["operation"], "select");
        assert!(event["corrective_message"]
            .as_str()
            .unwrap()
            .contains("repair"));
        assert!(event["elapsed_ms"].as_u64().is_some());
    }
}

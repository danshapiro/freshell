mod command_journal;
mod control;
mod output_journal;
mod provider_secret_resolution;
mod providers;
mod pty;

use freshell_agent_runtime::prepare_terminal_for_resume;
use freshell_runtime_protocol::{
    host_proof, read_frame, write_frame, ControlRole, Envelope, FixtureKind, FreshAgentLaunchSpec,
    GrantId, HostBootId, HostCommand, HostReply, HostResult, IncarnationId,
    OpenCodeTransferDescriptor, OpenCodeTransferReadinessReceipt, ProviderBootstrapFile,
    RecoveryPath, RecoveryProbe, ResumeSpec, RuntimeError, RuntimeErrorCode, RuntimeLimits,
    RuntimeMetrics, SoulId, TerminalLaunchSpec, CONTROL_PROTOCOL_VERSION,
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
            eprintln!("{{\"event\":\"session_host.fatal\",\"error\":\"runtime: {error}\"}}");
            std::process::exit(1);
        }
    };
    let code = match runtime.block_on(run()) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!(
                "{{\"event\":\"session_host.fatal\",\"error\":{}}}",
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
        Some("opencode-import-worker") => run_opencode_import_worker(&args[2..]),
        Some("opencode-reader-probe") => run_opencode_reader_probe(&args[2..]),
        Some("prepare-provider-features") => providers::run_provider_features_worker(&args[2..]),
        _ => Err("usage: freshell-session-host <serve|worker|fixture-child|fresh-agent-fixture-worker|opencode-identity-worker|provider-probe-worker|refresh-provider-config|opencode-import-worker|opencode-reader-probe> ...".into()),
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
                    if let Some(pty) = state.pty.lock().await.as_ref() {
                        exited = pty.exited();
                        native_session_id = pty.native_session_id();
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
                        None => RecoveryProbe::DefinitivelyUnavailable {
                            path: RecoveryPath::NativeResume,
                            reason: "no durable native identity or checkpoint is recorded".into(),
                            evidence: vec![state.state_dir.display().to_string()],
                            store_state: freshell_runtime_protocol::EvidenceStoreState::Missing,
                        },
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

    if terminal
        .as_ref()
        .is_some_and(|terminal| terminal.opencode_transfer.is_some())
    {
        drop(persisted);
        let mut preflight_terminal = match (terminal.as_ref(), resume_spec.as_ref()) {
            (Some(terminal), Some(resume)) => prepare_terminal_for_resume(terminal, resume)
                .map_err(|error| error.runtime_error())?,
            (Some(terminal), None) => terminal.clone(),
            (None, _) => unreachable!("transfer was checked on a terminal"),
        };
        let mut phase_gate = OpenCodeTransferGate::default();
        transfer_readiness_receipt = run_opencode_transfer_readiness(
            state,
            &soul_id,
            &mut preflight_terminal,
            &mut phase_gate,
        )?;
        transfer_prepared_terminal = Some(preflight_terminal.clone());
        transfer_phase_gate = Some(phase_gate);
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
    persisted.opencode_transfer_receipt = transfer_readiness_receipt;
    write_state(&state.state_dir, &persisted).map_err(registry_like_error)?;
    if let Some(gate) = transfer_phase_gate.as_mut() {
        gate.advance(OpenCodeTransferPhase::GrantConsumed)
            .expect("OpenCode transfer grant phase was prevalidated");
    }

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
                .map_err(|error| RuntimeError::new(RuntimeErrorCode::HostUnreachable, error))?;
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
            let spawn = || async {
                HostedPty::spawn(
                    &state.state_dir,
                    state.incarnation_id.clone(),
                    &terminal,
                    prepared.child_env,
                    prepared.codex,
                )
                .await
                .map_err(|e| {
                    RuntimeError::new(
                        RuntimeErrorCode::HostUnreachable,
                        format!("spawn managed terminal: {e}"),
                    )
                })
            };
            let hosted = match transfer_phase_gate.as_mut() {
                Some(gate) => run_opencode_transfer_pty_spawn(gate, spawn).await?,
                None => spawn().await?,
            };
            let pid = hosted.pid();
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
                "terminalId": hosted.terminal_id(),
                "streamEpoch": hosted.stream_epoch(),
                "cwd":terminal.cwd,
                "mode":terminal.mode,
            });
            *state.pty.lock().await = Some(hosted);
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
                prepare_provider_bootstrap_files(
                    &launch.provider_bootstrap_files,
                    launch.run_as_uid,
                    launch.run_as_gid,
                )
                .map_err(|error| {
                    RuntimeError::new(
                        RuntimeErrorCode::HostUnreachable,
                        format!("prepare hosted fresh-agent provider state failed: {error}"),
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
                .map_err(|error| RuntimeError::new(RuntimeErrorCode::HostUnreachable, error))?;
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
            let actor = providers::open_hosted_fresh_agent(&state.state_dir, launch.clone())
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

    Ok(HostResult::GrantAccepted {
        host_boot_id: state.host_boot_id.clone(),
        worker_pid: pid,
        worker_launch_count: persisted.worker_launch_count,
        fixture_evidence: persisted.fixture_evidence.clone(),
        native_session_id,
        opencode_transfer_receipt: persisted.opencode_transfer_receipt.clone(),
    })
}

const OPENCODE_TRANSFER_MOUNT: &str = "/run/freshell-opencode-transfer";
const OPENCODE_PROVIDER_HOME: &str = "/home/freshell/provider";
const OPENCODE_PROVIDER_DB: &str = "/home/freshell/provider/.local/share/opencode/opencode.db";
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
    let expected = [
        ("HOME", OPENCODE_PROVIDER_HOME),
        ("XDG_DATA_HOME", "/home/freshell/provider/.local/share"),
        ("XDG_CONFIG_HOME", "/home/freshell/provider/.config"),
        ("OPENCODE_DB", OPENCODE_PROVIDER_DB),
    ];
    for (name, value) in expected {
        if env.get(name).map(String::as_str) != Some(value) {
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
        home: PathBuf::from(OPENCODE_PROVIDER_HOME),
        xdg_data_home: PathBuf::from("/home/freshell/provider/.local/share"),
        xdg_config_home: PathBuf::from("/home/freshell/provider/.config"),
        database: PathBuf::from(OPENCODE_PROVIDER_DB),
        workspace,
        cwd,
    };
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
) -> Result<Option<OpenCodeTransferReadinessReceipt>, RuntimeError> {
    if terminal.opencode_transfer.is_none() {
        return Ok(None);
    }
    let mut progress = OpenCodeTransferProgress::default();
    run_opencode_transfer_readiness_sequence(phase_gate, |phase| {
        perform_opencode_transfer_phase(state, soul_id, terminal, &mut progress, phase)
    })
    .map_err(|error| {
        RuntimeError::new(
            RuntimeErrorCode::HostUnreachable,
            format!("OpenCode history import/readability preflight failed: {error}"),
        )
    })
    .map(|()| progress.readiness_receipt)
}

fn perform_opencode_transfer_phase(
    state: &HostState,
    soul_id: &SoulId,
    terminal: &mut TerminalLaunchSpec,
    progress: &mut OpenCodeTransferProgress,
    phase: OpenCodeTransferPhase,
) -> Result<(), String> {
    if phase == OpenCodeTransferPhase::ProviderHomePrepared {
        let transfer_id = terminal
            .opencode_transfer
            .as_ref()
            .ok_or("OpenCode transfer descriptor is unavailable")?
            .transfer_id
            .clone();
        prepare_provider_state_for_opencode_transfer(terminal).map_err(|error| error.message)?;
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
            let paths = validate_opencode_reader_paths(
                &terminal.env,
                Path::new(&terminal.workspace_path),
                Path::new(&terminal.cwd),
            )?;
            if descriptor.destination_database_path != ".local/share/opencode/opencode.db" {
                return Err("OpenCode transfer database binding is unsupported".into());
            }
            let staged_directory = Path::new(OPENCODE_TRANSFER_MOUNT);
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
            let import_output = run_opencode_provider_helper(
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
            let reader_output = run_opencode_provider_helper(
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
            progress.readiness_receipt =
                Some(revalidate_opencode_transfer_receipts(state, terminal)?);
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
    let paths = validate_opencode_reader_paths(
        &terminal.env,
        Path::new(&terminal.workspace_path),
        Path::new(&terminal.cwd),
    )?;
    let receipt = revalidate_opencode_transfer_receipts_with_reader(
        &state.state_dir,
        descriptor,
        &paths,
        terminal.run_as_uid,
        terminal.run_as_gid,
        || {
            let reader_output = run_opencode_provider_helper(
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
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let mut command = std::process::Command::new("/usr/bin/setpriv");
    command
        .args(provider_identity_args(
            terminal.run_as_uid,
            terminal.run_as_gid,
        ))
        .arg(executable)
        .arg(worker)
        .arg("--workspace-root")
        .arg(workspace_root)
        .arg("--expected-cwd")
        .arg(cwd)
        .arg("--provider-uid")
        .arg(terminal.run_as_uid.to_string())
        .arg("--provider-gid")
        .arg(terminal.run_as_gid.to_string())
        .current_dir(cwd)
        .env_clear()
        .envs(&terminal.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
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
        return Err(format!(
            "provider-identity OpenCode helper exited with status {}",
            output.status
        ));
    }
    if output.stdout.len() > MAX_OPENCODE_RECEIPT_BYTES {
        return Err("provider-identity OpenCode helper receipt exceeds its bound".into());
    }
    Ok(output.stdout)
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
        file.sync_all().map_err(|error| error.to_string())?;
        set_mode(&temporary, 0o400)?;
        match std::fs::hard_link(&temporary, &target) {
            Ok(()) => {}
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
        std::fs::File::open(state_dir)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| error.to_string())?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    write_result
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

fn prepare_provider_state_for_opencode_transfer(
    terminal: &mut TerminalLaunchSpec,
) -> Result<(), RuntimeError> {
    prepare_provider_state_for_opencode_transfer_at(
        terminal,
        &ProviderConfigPaths::default(),
        Path::new("/run/freshell-bootstrap"),
    )
    .map(|_| ())
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
        providers::prepare_provider_state_before_bootstrap,
        transfer_host_created_provider_state,
        |terminal| prepare_provider_context_for_fresh_launch(terminal, paths),
    )?;
    prepare_provider_bootstrap_files_at(
        &terminal.provider_bootstrap_files,
        terminal.run_as_uid,
        terminal.run_as_gid,
        &paths.provider_home,
        bootstrap_root,
    )
    .map_err(|error| {
        RuntimeError::new(
            RuntimeErrorCode::HostUnreachable,
            format!("prepare provider bootstrap: {error}"),
        )
    })
}

fn prepare_provider_state_before_bootstrap_with(
    terminal: &mut TerminalLaunchSpec,
    prepare_state: impl FnOnce(&mut TerminalLaunchSpec) -> Result<(), String>,
    transfer_state: impl FnOnce(&TerminalLaunchSpec) -> Result<(), String>,
    prepare_context: impl FnOnce(&TerminalLaunchSpec) -> Result<(), String>,
) -> Result<(), RuntimeError> {
    prepare_state(terminal).map_err(|error| {
        RuntimeError::new(
            RuntimeErrorCode::HostUnreachable,
            format!("prepare managed provider state: {error}"),
        )
    })?;
    prepare_context(terminal).map_err(|error| {
        RuntimeError::new(
            RuntimeErrorCode::HostUnreachable,
            format!("prepare provider config: {error}"),
        )
    })?;
    transfer_state(terminal).map_err(|error| {
        RuntimeError::new(
            RuntimeErrorCode::HostUnreachable,
            format!("transfer managed provider state: {error}"),
        )
    })
}

fn transfer_host_created_provider_state(terminal: &TerminalLaunchSpec) -> Result<(), String> {
    if terminal.mode != "amplifier" {
        return Ok(());
    }
    let root = Path::new("/home/freshell/provider/.amplifier");
    if !root.exists() {
        return Ok(());
    }
    transfer_owned_tree(root, terminal.run_as_uid, terminal.run_as_gid, 10_000)
}

fn transfer_owned_tree(root: &Path, uid: u32, gid: u32, max_entries: usize) -> Result<(), String> {
    let root = std::fs::canonicalize(root)
        .map_err(|error| format!("canonicalize {}: {error}", root.display()))?;
    let mut stack = vec![root.clone()];
    let mut paths = Vec::new();
    while let Some(path) = stack.pop() {
        if paths.len() >= max_entries {
            return Err(format!(
                "provider state tree exceeded the {max_entries}-entry ownership bound"
            ));
        }
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|error| format!("inspect {}: {error}", path.display()))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "provider state ownership transfer refuses symlink {}",
                path.display()
            ));
        }
        if !path.starts_with(&root) {
            return Err(format!(
                "provider state ownership transfer escaped {}",
                root.display()
            ));
        }
        paths.push(path.clone());
        if metadata.is_dir() {
            for entry in std::fs::read_dir(&path)
                .map_err(|error| format!("read {}: {error}", path.display()))?
            {
                let entry = entry.map_err(|error| error.to_string())?;
                stack.push(entry.path());
            }
        }
    }
    // Children first, so the trusted host never loses traversal rights before
    // all exact host-created files have been transferred.
    paths.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for path in paths {
        set_owner(&path, uid, gid)?;
    }
    Ok(())
}

fn prepare_provider_bootstrap_files(
    files: &[ProviderBootstrapFile],
    run_as_uid: u32,
    run_as_gid: u32,
) -> Result<(), String> {
    prepare_provider_bootstrap_files_at(
        files,
        run_as_uid,
        run_as_gid,
        Path::new("/home/freshell/provider"),
        Path::new("/run/freshell-bootstrap"),
    )
}

fn prepare_provider_bootstrap_files_at(
    files: &[ProviderBootstrapFile],
    run_as_uid: u32,
    run_as_gid: u32,
    home: &Path,
    bootstrap_root: &Path,
) -> Result<(), String> {
    if !home.is_dir() {
        return Err("managed provider HOME volume is not mounted".into());
    }

    // Keep directories root-owned until every bootstrap file is durable. The
    // trusted host deliberately lacks DAC_OVERRIDE/FOWNER, so chowning a 0700
    // parent early would lock the host out before later files are copied.
    set_mode(home, 0o700)?;
    let mut provider_dirs = std::collections::BTreeSet::new();
    provider_dirs.insert(home.to_path_buf());

    for (index, file) in files.iter().enumerate() {
        let source = bootstrap_root.join(format!("provider-{index}"));
        let relative = PathBuf::from(&file.provider_relative_path);
        if file.provider_relative_path.is_empty()
            || relative.is_absolute()
            || relative
                .components()
                .any(|component| !matches!(component, std::path::Component::Normal(_)))
        {
            return Err("provider bootstrap destination is unsafe".into());
        }
        let destination = home.join(&relative);
        if !destination.starts_with(home) {
            return Err("provider bootstrap destination escaped HOME".into());
        }
        if let Some(relative_parent) = relative.parent() {
            let mut current = home.to_path_buf();
            for component in relative_parent.components() {
                if let std::path::Component::Normal(component) = component {
                    current.push(component);
                    std::fs::create_dir_all(&current).map_err(|error| error.to_string())?;
                    set_mode(&current, 0o700)?;
                    provider_dirs.insert(current.clone());
                }
            }
        }
        let bytes = std::fs::read(&source)
            .map_err(|error| format!("read {}: {error}", source.display()))?;
        let tmp = destination.with_extension(format!("freshell-tmp-{}", std::process::id()));
        let mut options = std::fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        use std::io::Write as _;
        let mut out = options
            .open(&tmp)
            .map_err(|error| format!("create {}: {error}", tmp.display()))?;
        out.write_all(&bytes).map_err(|error| error.to_string())?;
        out.sync_all().map_err(|error| error.to_string())?;
        set_mode(&tmp, 0o600)?;
        std::fs::rename(&tmp, &destination).map_err(|error| error.to_string())?;
        set_owner(&destination, run_as_uid, run_as_gid)?;
        if let Some(parent) = destination.parent() {
            let _ = std::fs::File::open(parent).and_then(|dir| dir.sync_all());
        }
    }

    // Once all file writes are complete, transfer directory ownership from
    // deepest to shallowest; HOME is last. No trusted-host filesystem access
    // under provider HOME is required after this point.
    let mut provider_dirs = provider_dirs.into_iter().collect::<Vec<_>>();
    provider_dirs.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for dir in provider_dirs {
        set_owner(&dir, run_as_uid, run_as_gid)?;
    }
    Ok(())
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
        ProviderConfigOwnership::Immediate,
    )
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ProviderConfigOwnership {
    Immediate,
    DeferAmplifierTree,
}

fn copy_provider_config_references_with_ownership(
    context: &freshell_runtime_protocol::ProviderLaunchContext,
    provider: &str,
    workspace: &Path,
    user_provider_root: &Path,
    provider_home: &Path,
    run_as: (u32, u32),
    ownership: ProviderConfigOwnership,
) -> Result<(), String> {
    use freshell_runtime_protocol::ProviderConfigRoot;
    let (run_as_uid, run_as_gid) = run_as;
    context.validate(provider).map_err(|error| error.message)?;
    let mut copied = Vec::new();
    let mut entries = 0usize;
    for reference in provider_config_references(context) {
        let source_root = match reference.root {
            ProviderConfigRoot::Workspace => workspace.to_path_buf(),
            ProviderConfigRoot::UserProvider => user_provider_root.to_path_buf(),
            ProviderConfigRoot::Ephemeral => user_provider_root.join("ephemeral"),
        };
        let source = source_root.join(&reference.relative_path);
        let destination = provider_home.join(&reference.provider_relative_path);
        if !destination.starts_with(provider_home) || !source.starts_with(&source_root) {
            return Err("provider config escaped its approved root".into());
        }
        copy_provider_config_entry(
            &source_root,
            &source,
            &destination,
            &mut copied,
            &mut entries,
            0,
        )?;
    }
    let projected = copied
        .iter()
        .filter_map(|path| path.strip_prefix(provider_home).ok())
        .filter(|path| !path.as_os_str().is_empty())
        .map(|path| path.to_string_lossy().into_owned())
        .collect::<std::collections::BTreeSet<_>>();
    // A projected file can create several parent directories. Transfer all
    // of them, including `.freshell` above an OpenCode TUI source, so the
    // provider can create sibling state such as session-switch signals.
    let mut ownership_paths = std::collections::BTreeSet::new();
    for path in copied {
        for ancestor in path.ancestors() {
            if ancestor == provider_home {
                break;
            }
            if ancestor.starts_with(provider_home) {
                ownership_paths.insert(ancestor.to_path_buf());
            }
        }
    }
    let mut ownership_paths = ownership_paths.into_iter().collect::<Vec<_>>();
    ownership_paths.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for path in ownership_paths {
        // Amplifier's first launch transfers the complete stub and projected
        // config in one bounded walk. Chowning a selected 0700 directory here
        // would make that later walk fail without DAC_OVERRIDE.
        if should_transfer_projected_path(&path, provider_home, ownership) {
            set_owner(&path, run_as_uid, run_as_gid)?;
        }
    }
    let manifest = write_projection_manifest(provider_home, &projected)?;
    set_owner(&manifest, run_as_uid, run_as_gid)?;
    Ok(())
}

fn should_transfer_projected_path(
    path: &Path,
    provider_home: &Path,
    ownership: ProviderConfigOwnership,
) -> bool {
    ownership != ProviderConfigOwnership::DeferAmplifierTree
        || !path.starts_with(provider_home.join(".amplifier"))
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
    if metadata.file_type().is_symlink() {
        return Err("staged provider config cannot be a symlink".into());
    }
    set_owner(path, unsafe { libc::geteuid() }, gid)?;
    if metadata.is_dir() {
        set_mode(path, 0o750)?;
        for entry in std::fs::read_dir(path).map_err(|error| error.to_string())? {
            allow_provider_read_stage(&entry.map_err(|error| error.to_string())?.path(), gid)?;
        }
    } else if metadata.is_file() {
        set_mode(path, 0o640)?;
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
            || path.components().any(|part| {
                part.as_os_str()
                    .to_str()
                    .is_some_and(is_provider_secret_component)
            })
        {
            return Err("provider config refresh destination is unsafe".into());
        }
        let mut parent = provider_home.to_path_buf();
        for part in path.parent().into_iter().flat_map(Path::components) {
            parent.push(part.as_os_str());
            if std::fs::symlink_metadata(&parent)
                .is_ok_and(|metadata| metadata.file_type().is_symlink())
            {
                return Err("provider config refresh parent cannot be a symlink".into());
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
    let mut stale = previous.difference(&current).collect::<Vec<_>>();
    stale.sort_by_key(|path| std::cmp::Reverse(Path::new(path).components().count()));
    for relative in stale {
        let destination = provider_home.join(relative);
        if let Ok(metadata) = std::fs::symlink_metadata(&destination) {
            if metadata.is_dir() {
                match std::fs::remove_dir(&destination) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::DirectoryNotEmpty => {}
                    Err(error) => return Err(error.to_string()),
                }
            } else {
                std::fs::remove_file(&destination).map_err(|error| error.to_string())?;
            }
        }
    }
    paths.sort_by_key(|path| path.components().count());
    let mut copied = Vec::new();
    let mut entries = 0;
    for path in &paths {
        let destination = provider_home.join(path);
        let source = projection.join(path);
        if source.exists() {
            copy_provider_config_entry(
                &projection,
                &source,
                &destination,
                &mut copied,
                &mut entries,
                0,
            )?;
        }
    }
    write_projection_manifest(provider_home, &current)?;
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
        ProviderConfigOwnership::Immediate,
    )
}

fn prepare_provider_context_for_fresh_launch(
    terminal: &TerminalLaunchSpec,
    paths: &ProviderConfigPaths,
) -> Result<(), String> {
    let ownership = first_launch_config_ownership(&terminal.mode);
    prepare_provider_context_at(
        terminal.provider_launch_context.as_ref(),
        &terminal.mode,
        &terminal.workspace_path,
        terminal.run_as_uid,
        terminal.run_as_gid,
        paths,
        ownership,
    )
}

fn first_launch_config_ownership(provider: &str) -> ProviderConfigOwnership {
    if provider == "amplifier" {
        ProviderConfigOwnership::DeferAmplifierTree
    } else {
        ProviderConfigOwnership::Immediate
    }
}

fn prepare_provider_context_at(
    context: Option<&freshell_runtime_protocol::ProviderLaunchContext>,
    provider: &str,
    workspace: &str,
    run_as_uid: u32,
    run_as_gid: u32,
    paths: &ProviderConfigPaths,
    ownership: ProviderConfigOwnership,
) -> Result<(), String> {
    let private_mount_parent = &paths.private_mount;
    if !private_mount_parent.exists() {
        if context.is_some_and(|context| {
            provider_config_references(context).iter().any(|reference| {
                reference.root == freshell_runtime_protocol::ProviderConfigRoot::UserProvider
            })
        }) {
            return Err("provider user config mount is unavailable".into());
        }
        if let Some(context) = context {
            return copy_provider_config_references_with_ownership(
                context,
                provider,
                Path::new(workspace),
                private_mount_parent,
                &paths.provider_home,
                (run_as_uid, run_as_gid),
                ownership,
            );
        }
        return Ok(());
    }
    std::fs::create_dir_all(private_mount_parent).map_err(|error| error.to_string())?;
    set_mode(private_mount_parent, 0o700)?;
    if let Some(context) = context {
        copy_provider_config_references_with_ownership(
            context,
            provider,
            Path::new(workspace),
            &private_mount_parent.join("user-provider"),
            &paths.provider_home,
            (run_as_uid, run_as_gid),
            ownership,
        )?;
    }
    Ok(())
}

fn prepare_provider_files(
    provider: &str,
    provider_files: &[(&str, Vec<u8>)],
    run_as_uid: u32,
    run_as_gid: u32,
) -> Result<(), String> {
    let auth_dir = Path::new("/tmp/freshell-provider-auth");
    std::fs::create_dir_all(auth_dir).map_err(|error| error.to_string())?;
    set_mode(auth_dir, 0o711)?;
    let home = Path::new("/home/freshell/provider");
    if !home.exists() && provider_files.is_empty() {
        return Ok(());
    }
    let legacy_relative = match provider {
        "claude" => Some(".claude/.credentials.json"),
        "codex" => Some(".codex/auth.json"),
        "opencode" => Some(".local/share/opencode/auth.json"),
        _ => None,
    };
    if let Some(relative) = legacy_relative {
        let destination = home.join(relative);
        // A pre-OneCLI soul can contain a raw bootstrap copy. The provider
        // uid owns the durable HOME and removes that copy before any child runs.
        run_provider_path_command(
            run_as_uid,
            run_as_gid,
            "/usr/bin/rm",
            &[
                "-f",
                "--",
                destination.to_str().ok_or("auth path is not UTF-8")?,
            ],
        )?;
    }
    for (index, (relative, contents)) in provider_files.iter().enumerate() {
        let destination = home.join(relative);
        let target = auth_dir.join(format!("provider-{index}"));
        let temporary = auth_dir.join(format!("provider-{index}-tmp-{}", std::process::id()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        use std::io::Write as _;
        let mut file = options
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(contents)
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        std::fs::rename(&temporary, &target).map_err(|error| error.to_string())?;
        set_mode(&target, 0o600)?;
        set_owner(&target, run_as_uid, run_as_gid)?;
        let parent = destination.parent().ok_or("auth file has no parent")?;
        run_provider_path_command(
            run_as_uid,
            run_as_gid,
            "/usr/bin/mkdir",
            &["-p", "--", parent.to_str().ok_or("auth path is not UTF-8")?],
        )?;
        run_provider_path_command(
            run_as_uid,
            run_as_gid,
            "/usr/bin/ln",
            &[
                "-sfnT",
                "--",
                target.to_str().ok_or("auth path is not UTF-8")?,
                destination.to_str().ok_or("auth path is not UTF-8")?,
            ],
        )?;
    }
    Ok(())
}

fn run_provider_path_command(
    uid: u32,
    gid: u32,
    program: &str,
    args: &[&str],
) -> Result<(), String> {
    let status = std::process::Command::new("/usr/bin/setpriv")
        .args([
            "--reuid",
            &uid.to_string(),
            "--regid",
            &gid.to_string(),
            "--clear-groups",
            "--no-new-privs",
            "--",
            program,
        ])
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

fn copy_provider_config_entry(
    source_root: &Path,
    source: &Path,
    destination: &Path,
    copied: &mut Vec<PathBuf>,
    entries: &mut usize,
    depth: usize,
) -> Result<(), String> {
    if depth > 32 || *entries >= 4096 {
        return Err("provider config copy exceeds bounds".into());
    }
    *entries += 1;
    if source.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .is_some_and(is_provider_secret_component)
    }) {
        return Err("provider config references a credential path".into());
    }
    let Some(source) = resolve_provider_config_source(source_root, source)? else {
        return Ok(());
    };
    if source.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .is_some_and(is_provider_secret_component)
    }) {
        return Err("provider config resolves to a credential path".into());
    }
    let metadata = std::fs::metadata(&source)
        .map_err(|error| format!("provider config source unavailable: {error}"))?;
    if let Ok(existing) = std::fs::symlink_metadata(destination) {
        if existing.file_type().is_symlink() {
            return Err("provider config destination cannot be a symlink".into());
        }
    }
    if metadata.is_dir() {
        std::fs::create_dir_all(destination).map_err(|error| error.to_string())?;
        set_mode(destination, 0o700)?;
        copied.push(destination.to_path_buf());
        for entry in std::fs::read_dir(&source).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let name = entry.file_name();
            if name.to_str().is_some_and(is_provider_secret_component) {
                continue;
            }
            copy_provider_config_entry(
                source_root,
                &entry.path(),
                &destination.join(name),
                copied,
                entries,
                depth + 1,
            )?;
        }
    } else if metadata.is_file() {
        if metadata.len() > 16 * 1024 * 1024 {
            return Err("provider config file exceeds bounds".into());
        }
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            copied.push(parent.to_path_buf());
        }
        std::fs::copy(&source, destination).map_err(|error| error.to_string())?;
        set_mode(destination, 0o600)?;
        copied.push(destination.to_path_buf());
    } else {
        return Err("provider config source is not a regular file or directory".into());
    }
    Ok(())
}

/// Follow ordinary config symlinks only while every traversed component stays
/// inside its approved root. External links and vanished entries are omitted.
fn resolve_provider_config_source(root: &Path, source: &Path) -> Result<Option<PathBuf>, String> {
    let canonical_root = std::fs::canonicalize(root)
        .map_err(|error| format!("provider config root unavailable: {error}"))?;
    let relative = source
        .strip_prefix(root)
        .map_err(|_| "provider config escaped its approved root")?;
    let mut current = canonical_root.clone();
    for component in relative.components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            return Err("provider config path is unsafe".into());
        }
        current.push(component.as_os_str());
        current = match std::fs::canonicalize(&current) {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("provider config source unavailable: {error}")),
        };
        if !current.starts_with(&canonical_root) {
            tracing::warn!(
                event = "provider.config.skipped_symlink_escape",
                "provider config symlink leaves approved root"
            );
            return Ok(None);
        }
    }
    Ok(Some(current))
}

fn is_provider_secret_component(value: &str) -> bool {
    matches!(
        value.to_ascii_lowercase().as_str(),
        ".credentials.json"
            | "auth.json"
            | "keys.env"
            | ".env"
            | "credentials"
            | "secrets"
            | "token.json"
    )
}

#[cfg(unix)]
fn set_owner(path: &Path, uid: u32, gid: u32) -> Result<(), String> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let path_c = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| format!("path contains NUL: {}", path.display()))?;
    // SAFETY: path_c is NUL terminated and remains alive for the call.
    let rc = unsafe { libc::chown(path_c.as_ptr(), uid, gid) };
    if rc == 0 {
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
        file.sync_all().map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::File::open(parent)
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
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
        assert!(!destination.join(".claude/plugins/auth.json").exists());
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
    fn provider_config_copy_keeps_in_root_symlinks_and_skips_escaping_intermediate_link() {
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
        assert!(!destination
            .join(".config/opencode/project/escaped.json")
            .exists());
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
            "#!/bin/sh\ncat \"$TEST_CONFIG_PATH\" > \"$TEST_OUTPUT_PATH\"\nexec sleep 60\n",
        )
        .unwrap();
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755)).unwrap();
        let run_as_uid = current_uid;
        let native_session_id = "ses_exact_recovery";
        let environment = std::collections::BTreeMap::from([
            ("HOME".into(), "/home/freshell/provider".into()),
            ("PATH".into(), "/usr/bin:/bin".into()),
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
    async fn opencode_transfer_production_runner_orders_readiness_before_pty_callback() {
        let mut gate = OpenCodeTransferGate::default();
        let mut phases = Vec::new();
        run_opencode_transfer_readiness_sequence(&mut gate, |phase| {
            phases.push(phase);
            Ok(())
        })
        .unwrap();
        gate.run_step(OpenCodeTransferPhase::GrantConsumed, || Ok(()))
            .unwrap();
        let mut pty_spawned = false;
        let result = run_opencode_transfer_pty_spawn(&mut gate, || async {
            pty_spawned = true;
            Ok::<_, RuntimeError>("synthetic-pty")
        })
        .await
        .unwrap();

        assert_eq!(result, "synthetic-pty");
        assert!(pty_spawned);
        assert_eq!(phases, OPENCODE_TRANSFER_READINESS_PHASES);
        assert_eq!(
            gate.phases().last(),
            Some(&OpenCodeTransferPhase::PtySpawned)
        );

        let mut blocked_gate = OpenCodeTransferGate::default();
        let mut blocked_phases = Vec::new();
        assert!(
            run_opencode_transfer_readiness_sequence(&mut blocked_gate, |phase| {
                blocked_phases.push(phase);
                if phase == OpenCodeTransferPhase::ProviderIdentityReaderVerified {
                    return Err("synthetic provider reader failure".into());
                }
                Ok(())
            })
            .is_err()
        );
        let mut forbidden_pty_spawned = false;
        assert!(
            run_opencode_transfer_pty_spawn(&mut blocked_gate, || async {
                forbidden_pty_spawned = true;
                Ok::<_, RuntimeError>(())
            })
            .await
            .is_err()
        );
        assert!(!forbidden_pty_spawned);
        assert_eq!(blocked_phases, OPENCODE_TRANSFER_READINESS_PHASES[..6]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn supervisor_staging_and_real_receipts_gate_grant_and_pty_for_synthetic_history() {
        let success = run_joined_synthetic_transfer(None).await.unwrap();
        assert_eq!(
            success.failed_phase, None,
            "success path failed: {:?}",
            success.readiness_error
        );
        let receipt = success
            .readiness_receipt
            .expect("the exact staged import and reader receipts must reach the grant gate");
        assert_eq!(receipt.transfer_id, "synthetic-transfer");
        assert_eq!(receipt.provider_uid, unsafe { libc::geteuid() });
        assert_eq!(receipt.provider_gid, unsafe { libc::getegid() });
        assert_eq!(receipt.structural_sha256.len(), 64);
        assert_eq!(receipt.reader_receipt_sha256.len(), 64);
        assert_eq!(success.failed_phase, None);
        assert!(success.grant_consumed);
        assert!(success.pty_callback_invoked);

        for injected_failure in [
            SyntheticTransferFailure::Mount,
            SyntheticTransferFailure::Import,
            SyntheticTransferFailure::Reader,
            SyntheticTransferFailure::DatabasePath,
        ] {
            let attempt = run_joined_synthetic_transfer(Some(injected_failure))
                .await
                .unwrap();
            assert!(attempt.readiness_receipt.is_none());
            let expected_phase = match injected_failure {
                SyntheticTransferFailure::Mount => OpenCodeTransferPhase::StageVerified,
                SyntheticTransferFailure::Import => OpenCodeTransferPhase::ImportCompleted,
                SyntheticTransferFailure::Reader => {
                    OpenCodeTransferPhase::ProviderIdentityReaderVerified
                }
                SyntheticTransferFailure::DatabasePath => OpenCodeTransferPhase::StructuralVerified,
            };
            assert_eq!(attempt.failed_phase, Some(expected_phase));
            assert!(attempt.readiness_error.is_some());
            assert!(!attempt.grant_consumed);
            assert!(
                !attempt.pty_callback_invoked,
                "a transfer failure must not reach the PTY callback"
            );
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

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum SyntheticTransferFailure {
        Mount,
        Import,
        Reader,
        DatabasePath,
    }

    struct SyntheticGateAttempt {
        readiness_receipt: Option<OpenCodeTransferReadinessReceipt>,
        failed_phase: Option<OpenCodeTransferPhase>,
        readiness_error: Option<String>,
        grant_consumed: bool,
        pty_callback_invoked: bool,
    }

    struct SyntheticCapacity(u64);

    impl freshell_agent_runtime::opencode_transfer::DestinationCapacityProvider for SyntheticCapacity {
        fn available_bytes(&self, _existing_directory: &Path) -> io::Result<u64> {
            Ok(self.0)
        }
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
                    "synthetic-transfer-session",
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
                    "synthetic-transfer-session",
                    r#"{"text":"synthetic message body is test-only"}"#
                ],
            )
            .map_err(|error| error.to_string())?;
        drop(source);

        let snapshot = export_exact_session(
            &HostOpenCodeInventory::new(source_database)
                .with_trusted_mount_for_selected_session(workspace.clone()),
            "synthetic-transfer-session",
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
            root_session_id: "synthetic-transfer-session".into(),
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
        staging
            .begin(&descriptor, u64::MAX)
            .map_err(|error| error.to_string())?;
        for (sequence, bytes) in payload
            .chunks(MAX_OPENCODE_TRANSFER_CHUNK_BYTES)
            .enumerate()
        {
            let offset = sequence * MAX_OPENCODE_TRANSFER_CHUNK_BYTES;
            let chunk = OpenCodeTransferChunk {
                transfer_id: descriptor.transfer_id.clone(),
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
            .finalize(&descriptor.transfer_id)
            .map_err(|error| error.to_string())?;

        let home = root.path().join("provider-home");
        let xdg_data_home = home.join(".local/share");
        let xdg_config_home = home.join(".config");
        std::fs::create_dir_all(&home).map_err(|error| error.to_string())?;
        std::fs::create_dir_all(&xdg_config_home).map_err(|error| error.to_string())?;
        let paths = OpencodeReaderPaths {
            home: home.clone(),
            xdg_data_home: xdg_data_home.clone(),
            xdg_config_home: xdg_config_home.clone(),
            database: xdg_data_home.join("opencode/opencode.db"),
            workspace: workspace.clone(),
            cwd: workspace,
        };
        let state_dir = root.path().join("host-state");
        std::fs::create_dir(&state_dir).map_err(|error| error.to_string())?;
        let provider_uid = unsafe { libc::geteuid() };
        let provider_gid = unsafe { libc::getegid() };
        let mut payload_path = None;
        let mut import_receipt = None;
        let mut reader_receipt = None;
        let mut readiness_receipt = None;
        let mut failed_phase = None;
        let mut current_phase = None;
        let mut gate = OpenCodeTransferGate::default();
        let readiness = run_opencode_transfer_readiness_sequence(&mut gate, |phase| {
            current_phase = Some(phase);
            let result = match phase {
                OpenCodeTransferPhase::ProviderHomePrepared => Ok(()),
                OpenCodeTransferPhase::StageVerified => {
                    let selected_stage = if failure == Some(SyntheticTransferFailure::Mount) {
                        root.path().join("missing-stage")
                    } else {
                        ready.clone()
                    };
                    freshell_agent_runtime::opencode_transfer::verify_staged_bundle(
                        &descriptor,
                        &selected_stage,
                    )
                    .map(|path| payload_path = Some(path))
                    .map_err(|error| error.to_string())
                }
                OpenCodeTransferPhase::ImportCompleted => {
                    let source = std::fs::File::open(
                        payload_path
                            .as_ref()
                            .ok_or("verified stage payload is absent")?,
                    )
                    .map_err(|error| error.to_string())?;
                    let capacity = if failure == Some(SyntheticTransferFailure::Import) {
                        SyntheticCapacity(0)
                    } else {
                        SyntheticCapacity(u64::MAX)
                    };
                    freshell_agent_runtime::opencode_transfer::import_bundle_payload_with_capacity(
                        &descriptor,
                        source,
                        &paths.database,
                        &paths.workspace,
                        &capacity,
                    )
                    .map(|receipt| import_receipt = Some(receipt))
                    .map_err(|error| error.to_string())
                }
                OpenCodeTransferPhase::StructuralVerified => {
                    let mut verified_paths = paths.clone();
                    if failure == Some(SyntheticTransferFailure::DatabasePath) {
                        verified_paths.database = root
                            .path()
                            .join("provider-home-sibling/.local/share/opencode/opencode.db");
                    }
                    validate_import_receipt_binding(
                        import_receipt.as_ref().ok_or("import receipt is absent")?,
                        &descriptor,
                        &verified_paths,
                    )
                }
                OpenCodeTransferPhase::ImportReceiptDurable => persist_opencode_receipt(
                    &state_dir,
                    &format!("opencode-{}-import.json", descriptor.transfer_id),
                    import_receipt.as_ref().ok_or("import receipt is absent")?,
                ),
                OpenCodeTransferPhase::ProviderIdentityReaderVerified => {
                    let uid = if failure == Some(SyntheticTransferFailure::Reader) {
                        provider_uid.wrapping_add(1)
                    } else {
                        provider_uid
                    };
                    let reader_context = installed_store_reader_context(&paths, uid, provider_gid);
                    freshell_agent_runtime::opencode_transfer::verify_installed_store(
                        &descriptor,
                        &reader_context,
                    )
                    .map(|receipt| reader_receipt = Some(receipt))
                    .map_err(|error| error.to_string())
                }
                OpenCodeTransferPhase::ReceiptsDurable => persist_opencode_receipt(
                    &state_dir,
                    &format!("opencode-{}-readable.json", descriptor.transfer_id),
                    reader_receipt.as_ref().ok_or("reader receipt is absent")?,
                ),
                OpenCodeTransferPhase::ReceiptsRevalidated => {
                    let receipt = revalidate_opencode_transfer_receipts_with_reader(
                        &state_dir,
                        &descriptor,
                        &paths,
                        provider_uid,
                        provider_gid,
                        || {
                            let reader_context =
                                installed_store_reader_context(&paths, provider_uid, provider_gid);
                            freshell_agent_runtime::opencode_transfer::verify_installed_store(
                                &descriptor,
                                &reader_context,
                            )
                            .map_err(|error| error.to_string())
                        },
                    )?;
                    readiness_receipt = Some(receipt);
                    Ok(())
                }
                OpenCodeTransferPhase::GrantConsumed | OpenCodeTransferPhase::PtySpawned => Err(
                    "grant and PTY phases must be reached through their production gates".into(),
                ),
            };
            if result.is_err() {
                failed_phase = Some(phase);
            }
            result
        });
        let readiness_error = readiness.err();
        if readiness_error.is_some() && failed_phase.is_none() {
            failed_phase = current_phase;
        }
        let mut grant_consumed = false;
        let mut pty_callback_invoked = false;
        if readiness_error.is_none() {
            gate.run_step(OpenCodeTransferPhase::GrantConsumed, || {
                if readiness_receipt.is_none() {
                    return Err("exact transfer receipts were not revalidated".into());
                }
                grant_consumed = true;
                Ok(())
            })
            .map_err(|error| error.to_string())?;
            run_opencode_transfer_pty_spawn(&mut gate, || async {
                pty_callback_invoked = true;
                Ok::<_, RuntimeError>(())
            })
            .await
            .map_err(|error| error.message)?;
        }
        Ok(SyntheticGateAttempt {
            readiness_receipt,
            failed_phase,
            readiness_error,
            grant_consumed,
            pty_callback_invoked,
        })
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

    #[test]
    fn host_created_provider_tree_transfers_exact_paths_and_refuses_symlinks() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let tree = dir.path().join("provider/.amplifier/projects/p/sessions/s");
        std::fs::create_dir_all(&tree).unwrap();
        std::fs::write(tree.join("metadata.json"), b"{}").unwrap();
        transfer_owned_tree(
            &dir.path().join("provider/.amplifier"),
            unsafe { libc::geteuid() },
            unsafe { libc::getegid() },
            32,
        )
        .unwrap();

        let outside = dir.path().join("outside");
        std::fs::write(&outside, b"sentinel").unwrap();
        symlink(&outside, tree.join("escape")).unwrap();
        let error = transfer_owned_tree(
            &dir.path().join("provider/.amplifier"),
            unsafe { libc::geteuid() },
            unsafe { libc::getegid() },
            32,
        )
        .unwrap_err();
        assert!(error.contains("refuses symlink"));
        assert_eq!(std::fs::read(&outside).unwrap(), b"sentinel");
    }

    #[cfg(unix)]
    #[test]
    fn first_amplifier_launch_transfers_stub_and_projected_config_together() {
        use freshell_runtime_protocol::{
            ProviderConfigReference, ProviderConfigRoot, ProviderLaunchContext, ProviderPreparation,
        };
        use std::{cell::Cell, os::unix::fs::PermissionsExt, process::Command};

        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        let user_provider_root = root.path().join("private/user-provider");
        let provider_home = root.path().join("provider");
        let amplifier_home = provider_home.join(".amplifier");
        let paths = ProviderConfigPaths {
            private_mount: root.path().join("private"),
            provider_home: provider_home.clone(),
        };
        let selected_bundle = user_provider_root.join("bundles/ordinary");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&selected_bundle).unwrap();
        std::fs::create_dir_all(&provider_home).unwrap();
        std::fs::write(selected_bundle.join("bundle.yaml"), b"name: ordinary\n").unwrap();
        std::fs::write(selected_bundle.join("auth.json"), b"fixture-secret").unwrap();

        let context = ProviderLaunchContext {
            preparation: ProviderPreparation::Amplifier {
                bundle: "default".into(),
                resume_args: Vec::new(),
            },
            mcp_capability: None,
            config: vec![ProviderConfigReference {
                root: ProviderConfigRoot::UserProvider,
                relative_path: "bundles".into(),
                provider_relative_path: ".amplifier/bundles".into(),
                format: "directory".into(),
            }],
        };
        let mut terminal: TerminalLaunchSpec = serde_json::from_value(serde_json::json!({
            "terminalId":"amplifier-first-launch", "streamId":"amplifier-stream",
            "mode":"amplifier", "program":"amplifier", "args":[],
            "cwd":workspace, "runAsUid":unsafe { libc::geteuid() },
            "runAsGid":unsafe { libc::getegid() }, "cols":80, "rows":24,
            "projectKey":"amplifier-project", "workspacePath":workspace,
            "resumeSessionId":"session-first-launch"
        }))
        .unwrap();
        terminal.provider_launch_context = Some(context);

        // Docker's host has CHOWN but no DAC_OVERRIDE. Once the selected
        // bundle is provider-owned and 0700, that host cannot walk it. The
        // fixture uses one OS uid, so model the distinct host/provider DAC
        // identities while the callbacks perform the real stub, ownership
        // transfer, and config projection operations.
        let provider_only_bundle = Cell::new(false);
        let ownership_transferred = Cell::new(false);
        prepare_provider_state_before_bootstrap_with(
            &mut terminal,
            |terminal| {
                freshell_sessions::amplifier_stub::ensure_session(
                    &amplifier_home,
                    terminal.resume_session_id.as_deref().unwrap(),
                    &terminal.cwd,
                    &terminal.terminal_id,
                )
                .map(|_| ())
                .map_err(|error| error.to_string())
            },
            |terminal| {
                if provider_only_bundle.get() {
                    return Err("host cannot traverse provider-owned 0700 bundle".into());
                }
                transfer_owned_tree(
                    &amplifier_home,
                    terminal.run_as_uid,
                    terminal.run_as_gid,
                    10_000,
                )?;
                ownership_transferred.set(true);
                Ok(())
            },
            |terminal| {
                if ownership_transferred.get() {
                    return Err("host cannot project into a provider-owned Amplifier home".into());
                }
                prepare_provider_context_for_fresh_launch(terminal, &paths)?;
                let projected = amplifier_home.join("bundles");
                assert_eq!(
                    std::fs::metadata(&projected).unwrap().permissions().mode() & 0o777,
                    0o700
                );
                provider_only_bundle.set(should_transfer_projected_path(
                    &projected,
                    &provider_home,
                    first_launch_config_ownership(&terminal.mode),
                ));
                Ok(())
            },
        )
        .expect("a first Amplifier launch must transfer state after an accessible projection");

        let projected_bundle = amplifier_home.join("bundles/ordinary/bundle.yaml");
        assert!(ownership_transferred.get());
        assert!(!amplifier_home.join("bundles/ordinary/auth.json").exists());
        let output = Command::new("/usr/bin/setpriv")
            .args([
                "--reuid",
                &terminal.run_as_uid.to_string(),
                "--regid",
                &terminal.run_as_gid.to_string(),
                "--keep-groups",
                "--no-new-privs",
                "--",
                "cat",
            ])
            .arg(&projected_bundle)
            .output()
            .unwrap();
        assert!(output.status.success(), "provider child: {output:?}");
        assert_eq!(output.stdout, b"name: ordinary\n");
        assert!(amplifier_home.join("projects").is_dir());
    }
}

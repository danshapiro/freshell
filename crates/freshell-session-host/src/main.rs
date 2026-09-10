mod command_journal;
mod control;
mod output_journal;
mod provider_secret_resolution;
mod providers;
mod pty;

use freshell_agent_runtime::prepare_terminal_for_resume;
use freshell_runtime_protocol::{
    host_proof, read_frame, write_frame, ControlRole, Envelope, FixtureKind, FreshAgentLaunchSpec,
    GrantId, HostBootId, HostCommand, HostReply, HostResult, IncarnationId, ProviderBootstrapFile,
    RecoveryPath, RecoveryProbe, ResumeSpec, RuntimeError, RuntimeErrorCode, RuntimeLimits,
    RuntimeMetrics, SoulId, TerminalLaunchSpec, CONTROL_PROTOCOL_VERSION,
};
use pty::HostedPty;
use serde::{Deserialize, Serialize};
use std::{
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
        Some("fixture-child") => fixture_child(&args[2..]).await,
        #[cfg(feature = "fresh-agent-fixtures")]
        Some("fresh-agent-fixture-worker") => providers::run_fresh_agent_fixture_worker(&args[2..]).await,
        Some("opencode-identity-worker") => pty::run_opencode_identity_worker(&args[2..]),
        Some("provider-probe-worker") => providers::run_probe_worker(&args[2..]),
        _ => Err("usage: freshell-session-host <serve|worker|fixture-child|fresh-agent-fixture-worker|opencode-identity-worker|provider-probe-worker> ...".into()),
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
    write_frame(&mut stream, &HostReply { request_id, result })
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
                        soul_id,
                        control_epoch,
                        execution_generation,
                        grant_id,
                        fixture,
                        terminal.map(|terminal| *terminal),
                        fresh_agent.map(|agent| *agent),
                        resume_spec.map(|resume_spec| *resume_spec),
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
                        .ok_or_else(|| unsupported_fresh_agent())?;
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
                        .ok_or_else(|| unsupported_fresh_agent())?;
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
                        .ok_or_else(|| unsupported_fresh_agent())?;
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
                        .ok_or_else(|| unsupported_fresh_agent())?;
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
                        .ok_or_else(|| unsupported_fresh_agent())?;
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

async fn grant_execution(
    state: &Arc<HostState>,
    soul_id: SoulId,
    control_epoch: u64,
    execution_generation: u64,
    grant_id: GrantId,
    fixture: Option<FixtureKind>,
    terminal: Option<TerminalLaunchSpec>,
    fresh_agent: Option<FreshAgentLaunchSpec>,
    resume_spec: Option<ResumeSpec>,
) -> Result<HostResult, RuntimeError> {
    let mut persisted = state.persisted.lock().await;
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

    persisted.max_control_epoch = control_epoch;
    persisted.max_execution_generation = execution_generation;
    persisted.grant_id = Some(grant_id.clone());
    persisted.worker_pid = None;
    write_state(&state.state_dir, &persisted).map_err(registry_like_error)?;

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
            let mut terminal = match resume_spec.as_ref() {
                Some(resume) => prepare_terminal_for_resume(&terminal, resume)
                    .map_err(|error| error.runtime_error())?,
                None => terminal,
            };
            // First boot transfers the durable provider-home inode to the
            // unprivileged provider. An exact-resume host deliberately lacks
            // FOWNER/DAC_OVERRIDE, and must consume that verified store as-is:
            // re-running bootstrap would both violate the store boundary and
            // fail before worker launch. Docker's ownership proof pins the
            // same soul-scoped volume on this replacement.
            if !exact_resume {
                prepare_provider_state_for_fresh_launch(&mut terminal)?;
            }
            let prepared = providers::prepare_terminal(terminal)
                .await
                .map_err(|error| {
                    RuntimeError::new(
                        RuntimeErrorCode::HostUnreachable,
                        format!("prepare managed provider: {error}"),
                    )
                })?;
            let terminal = prepared.terminal;
            let child_secret_env = provider_secret_resolution::resolve_child_environment(&terminal)
                .map_err(|error| {
                    RuntimeError::new(
                        RuntimeErrorCode::HostUnreachable,
                        format!("resolve managed provider credentials: {error}"),
                    )
                })?;
            let hosted = HostedPty::spawn(
                &state.state_dir,
                state.incarnation_id.clone(),
                &terminal,
                child_secret_env,
                prepared.codex,
            )
            .await
            .map_err(|e| {
                RuntimeError::new(
                    RuntimeErrorCode::HostUnreachable,
                    format!("spawn managed terminal: {e}"),
                )
            })?;
            let pid = hosted.pid();
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
                prepare_provider_bootstrap_files(
                    &launch.provider_bootstrap_files,
                    launch.run_as_uid,
                    launch.run_as_gid,
                )
                .map_err(|_| {
                    RuntimeError::new(
                        RuntimeErrorCode::HostUnreachable,
                        "prepare hosted fresh-agent provider state failed",
                    )
                })?;
            }
            let actor = providers::open_hosted_fresh_agent(&state.state_dir, launch.clone())
                .await
                .map_err(|_| {
                    RuntimeError::new(
                        RuntimeErrorCode::HostUnreachable,
                        "hosted fresh-agent provider failed to start",
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
    })
}

fn prepare_provider_state_for_fresh_launch(
    terminal: &mut TerminalLaunchSpec,
) -> Result<(), RuntimeError> {
    providers::prepare_provider_state_before_bootstrap(terminal).map_err(|error| {
        RuntimeError::new(
            RuntimeErrorCode::HostUnreachable,
            format!("prepare managed provider state: {error}"),
        )
    })?;
    transfer_host_created_provider_state(terminal).map_err(|error| {
        RuntimeError::new(
            RuntimeErrorCode::HostUnreachable,
            format!("transfer managed provider state: {error}"),
        )
    })?;
    prepare_provider_bootstrap_files(
        &terminal.provider_bootstrap_files,
        terminal.run_as_uid,
        terminal.run_as_gid,
    )
    .map_err(|error| {
        RuntimeError::new(
            RuntimeErrorCode::HostUnreachable,
            format!("prepare provider bootstrap: {error}"),
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
    let home = PathBuf::from("/home/freshell/provider");
    if home != Path::new("/home/freshell/provider") {
        return Err("managed provider HOME must be /home/freshell/provider".into());
    }
    if !home.is_dir() {
        return Err("managed provider HOME volume is not mounted".into());
    }

    // Keep directories root-owned until every bootstrap file is durable. The
    // trusted host deliberately lacks DAC_OVERRIDE/FOWNER, so chowning a 0700
    // parent early would lock the host out before later files are copied.
    set_mode(&home, 0o700)?;
    let mut provider_dirs = std::collections::BTreeSet::new();
    provider_dirs.insert(home.clone());

    for (index, file) in files.iter().enumerate() {
        let source = PathBuf::from(format!("/run/freshell-bootstrap/provider-{index}"));
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
        if !destination.starts_with(&home) {
            return Err("provider bootstrap destination escaped HOME".into());
        }
        if let Some(relative_parent) = relative.parent() {
            let mut current = home.clone();
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
        assert!(HOST_MIN_WORKER_THREADS >= 2, "one worker is never enough");
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
        use std::os::unix::fs::PermissionsExt;

        let state = test_host_state();
        let workspace = tempfile::tempdir().unwrap();
        std::fs::set_permissions(workspace.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        let launcher = workspace.path().join("exact-resume-provider");
        std::fs::write(&launcher, "#!/bin/sh\nexec sleep 60\n").unwrap();
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755)).unwrap();
        let current_uid = unsafe { libc::geteuid() };
        let current_gid = unsafe { libc::getegid() };
        let run_as_uid = if current_uid == 0 {
            65_534
        } else {
            current_uid
        };
        let native_session_id = "ses_exact_recovery";
        let environment = std::collections::BTreeMap::from([
            ("HOME".into(), "/home/freshell/provider".into()),
            ("PATH".into(), "/usr/bin:/bin".into()),
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
            provider_bootstrap_files: vec![freshell_runtime_protocol::ProviderBootstrapFile {
                // Exact recovery consumes the copy already in the durable
                // provider volume; this first-boot source must not be read.
                source_path: "/source-is-deliberately-absent".into(),
                provider_relative_path: ".local/share/opencode/auth.json".into(),
            }],
            provider_secret_references: Vec::new(),
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
        })
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
}

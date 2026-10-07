mod command_journal;
mod control;
mod output_journal;
mod provider_input_preparation;
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
    provider_config_paths: ProviderConfigPaths,
}

#[derive(Clone)]
struct ProviderConfigPaths {
    private_mount: PathBuf,
    provider_home: PathBuf,
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
        Some("native-auth-only") if args.len() == 2 => {
            verify_private_helper_namespace(
                Path::new("/home/freshell/provider"),
                Path::new("/run/freshell-auth-exchange/reply.sock"),
            )?;
            freshell_platform::native_auth_exchange::serve(
                Path::new("/home/freshell/provider"),
                Path::new("/run/freshell-auth-exchange/reply.sock"),
            ).map_err(str::to_owned)
        }
        Some("publish-provider-inputs") if args.len() == 2 => {
            verify_private_helper_namespace(
                Path::new("/run/freshell-input-files"),
                Path::new("/run/freshell-input-exchange/reply.sock"),
            )?;
            freshell_platform::provider_input_exchange::serve(
                Path::new("/run/freshell-input-files"),
                Path::new("/run/freshell-input-exchange/reply.sock"),
            ).map_err(str::to_owned)
        }
        Some("prepare-provider-mountpoints") if args.len() == 2 => {
            if unsafe { libc::geteuid() } != 0 || unsafe { libc::getegid() } != 0 {
                return Err("provider mountpoint helper requires the fixed host identity".into());
            }
            freshell_platform::provider_mountpoints::serve(
                Path::new("/home/freshell/provider"),
                Path::new("/run/freshell-input-exchange/reply.sock"),
            ).map_err(str::to_owned)
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
        Some("prepare-provider-features") => providers::run_provider_features_worker(&args[2..]),
        Some("prepare-amplifier-state") => providers::run_amplifier_state_worker(&args[2..]),
        _ => Err("usage: freshell-session-host <serve|worker|fixture-child|fresh-agent-fixture-worker|opencode-identity-worker|provider-probe-worker|refresh-provider-config> ...".into()),
    }
}

fn verify_private_helper_namespace(root: &Path, socket: &Path) -> Result<(), String> {
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    let invalid = || "private provider helper namespace mapping is unavailable".to_string();
    if unsafe { libc::geteuid() } != 65534 || unsafe { libc::getegid() } != 0 {
        return Err(invalid());
    }
    let root_meta = std::fs::symlink_metadata(root).map_err(|_| invalid())?;
    let directory =
        std::fs::symlink_metadata(socket.parent().ok_or_else(invalid)?).map_err(|_| invalid())?;
    let endpoint = std::fs::symlink_metadata(socket).map_err(|_| invalid())?;
    if !root_meta.is_dir()
        || root_meta.uid() != 65534
        || root_meta.gid() != 0
        || root_meta.mode() & 0o777 != 0o700
        || !directory.is_dir()
        || directory.uid() != 0
        || directory.gid() != 0
        || directory.mode() & 0o777 != 0o710
        || !endpoint.file_type().is_socket()
        || endpoint.uid() != 0
        || endpoint.gid() != 0
        || endpoint.mode() & 0o777 != 0o660
    {
        return Err(invalid());
    }
    Ok(())
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
                    provider_path_inputs,
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
                            provider_path_inputs,
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
    provider_path_inputs: freshell_runtime_protocol::ProviderPathInputs,
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
        provider_path_inputs,
        terminal,
        fresh_agent,
        resume_spec,
    } = request;
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

    // Resolve every mounted grant once before consuming the execution grant.
    // A changed source selection remains a pre-dispatch preparation failure.
    let source = terminal
        .as_ref()
        .map(|launch| {
            (
                launch.mode.as_str(),
                launch.provider_secret_references.as_slice(),
                launch.provider_launch_context.as_ref(),
            )
        })
        .or_else(|| {
            fresh_agent.as_ref().map(|launch| {
                (
                    launch.provider.native_provider(),
                    launch.provider_secret_references.as_slice(),
                    launch.provider_launch_context.as_ref(),
                )
            })
        });
    let mut prepared_secrets = if let Some((provider, references, context)) = source {
        let mut secrets = provider_secret_resolution::resolve_child_secrets(
            provider,
            references,
            Path::new("/run/freshell-secrets"),
        )
        .map_err(|error| {
            RuntimeError::new(
                RuntimeErrorCode::HostUnreachable,
                format!("resolve managed provider credentials: {error}"),
            )
        })?;
        if matches!(provider, "opencode" | "codex" | "claude" | "amplifier") {
            let generated = provider_input_preparation::prepare(
                context,
                &mut secrets,
                &provider_path_inputs,
                &state
                    .provider_config_paths
                    .private_mount
                    .join("user-provider"),
                &state.provider_config_paths.provider_home,
            )
            .map_err(|error| {
                RuntimeError::new(
                    if error.starts_with("configuration reference selection changed") {
                        RuntimeErrorCode::ProviderInputsChanged
                    } else {
                        RuntimeErrorCode::HostUnreachable
                    },
                    error,
                )
            })?;
            secrets.environment.extend(generated);
        } else if !provider_path_inputs.is_empty() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                "private source input binding belongs to another provider",
            ));
        }
        Some(secrets)
    } else {
        if !provider_path_inputs.is_empty() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                "private source input binding has no provider workload",
            ));
        }
        None
    };

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
            // unprivileged provider. An exact-resume host lacks FOWNER and
            // DAC_OVERRIDE, so it stages current approved config and asks a
            // provider-owned helper to refresh only that projection. Docker's
            // ownership proof pins the same soul-scoped volume on replacement.
            if !exact_resume {
                prepare_provider_state_for_fresh_launch(&mut terminal)?;
            } else {
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
            let resolved_secrets = prepared_secrets.take().ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::HostUnreachable,
                    "prepared terminal credentials unavailable",
                )
            })?;
            prepare_provider_files(
                &terminal.mode,
                &resolved_secrets.provider_files,
                &resolved_secrets.configuration_files,
                terminal.run_as_uid,
                terminal.run_as_gid,
                terminal
                    .provider_launch_context
                    .as_ref()
                    .and_then(|context| context.prepared_inputs.as_ref())
                    .is_some_and(|inputs| inputs.indexed_files.is_some()),
            )
            .map_err(|error| {
                RuntimeError::new(
                    RuntimeErrorCode::HostUnreachable,
                    format!("prepare OneCLI provider files: {error}"),
                )
            })?;
            let prepared = providers::prepare_terminal(
                terminal,
                &resolved_secrets.environment,
                resolved_secrets.opencode_plan.as_ref(),
                resolved_secrets.claude_settings_argument.as_deref(),
            )
            .await
            .map_err(|error| {
                RuntimeError::new(
                    RuntimeErrorCode::HostUnreachable,
                    format!("prepare managed provider: {error}"),
                )
            })?;
            let terminal = prepared.terminal;
            let hosted = HostedPty::spawn(
                &state.state_dir,
                state.incarnation_id.clone(),
                &terminal,
                prepared.child_env,
                prepared.codex,
                prepared.claude_settings,
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
                    launch.provider.native_provider(),
                    &launch.provider_bootstrap_files,
                    launch.run_as_uid,
                    launch.run_as_gid,
                    launch
                        .provider_launch_context
                        .as_ref()
                        .is_some_and(|context| context.prepared_inputs.is_some()),
                )
                .map_err(|error| {
                    RuntimeError::new(
                        RuntimeErrorCode::HostUnreachable,
                        format!("prepare hosted fresh-agent provider state failed: {error}"),
                    )
                })?;
                prepare_provider_context(
                    launch.provider_launch_context.as_ref(),
                    launch.provider.native_provider(),
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
                    launch.provider.native_provider(),
                    &launch.workspace_path,
                    launch.run_as_uid,
                    launch.run_as_gid,
                    &state.provider_config_paths,
                )
                .map_err(|error| RuntimeError::new(RuntimeErrorCode::HostUnreachable, error))?;
            }
            let mut resolved_secrets = prepared_secrets.take().ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::HostUnreachable,
                    "prepared fresh-agent credentials unavailable",
                )
            })?;
            prepare_provider_files(
                launch.provider.native_provider(),
                &resolved_secrets.provider_files,
                &resolved_secrets.configuration_files,
                launch.run_as_uid,
                launch.run_as_gid,
                launch
                    .provider_launch_context
                    .as_ref()
                    .and_then(|context| context.prepared_inputs.as_ref())
                    .is_some_and(|inputs| inputs.indexed_files.is_some()),
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
                resolved_secrets.opencode_plan.as_ref(),
            )
            .await
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
    })
}

fn prepare_provider_state_for_fresh_launch(
    terminal: &mut TerminalLaunchSpec,
) -> Result<(), RuntimeError> {
    if terminal.mode == "amplifier"
        && terminal.provider_bootstrap_files.is_empty()
        && terminal
            .provider_launch_context
            .as_ref()
            .is_some_and(|context| context.prepared_inputs.is_some())
    {
        // Selected configuration must be available before the native stub
        // records the active bundle. All new state is born under the provider
        // identity; no pre-existing HOME ownership is acquired by the host.
        verify_initialized_provider_home(
            Path::new("/home/freshell/provider"),
            terminal.run_as_uid,
            terminal.run_as_gid,
        )
        .and_then(|_| {
            prepare_provider_context_for_fresh_launch(terminal, &ProviderConfigPaths::default())
        })
        .and_then(|_| providers::prepare_amplifier_state_as_owner(terminal))
        .map_err(|error| {
            RuntimeError::new(
                RuntimeErrorCode::HostUnreachable,
                format!("prepare managed Amplifier state: {error}"),
            )
        })?;
        return Ok(());
    }
    prepare_provider_state_before_bootstrap_with(
        terminal,
        |terminal| {
            let mut created = providers::prepare_provider_state_before_bootstrap(terminal)?;
            let bootstrap = if terminal.provider_bootstrap_files.is_empty()
                && terminal
                    .provider_launch_context
                    .as_ref()
                    .is_some_and(|context| context.prepared_inputs.is_some())
            {
                verify_initialized_provider_home(
                    Path::new("/home/freshell/provider"),
                    terminal.run_as_uid,
                    terminal.run_as_gid,
                )
            } else {
                write_provider_bootstrap_files(
                    &terminal.mode,
                    &terminal.provider_bootstrap_files,
                    Path::new("/home/freshell/provider"),
                    Path::new("/run/freshell-bootstrap"),
                )
            };
            match bootstrap {
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
                Path::new("/home/freshell/provider"),
                created,
                terminal.run_as_uid,
                terminal.run_as_gid,
            )
        },
        |terminal| {
            prepare_provider_context_for_fresh_launch(terminal, &ProviderConfigPaths::default())
        },
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
    initialized: bool,
) -> Result<(), String> {
    let home = Path::new("/home/freshell/provider");
    let created = if initialized && files.is_empty() {
        verify_initialized_provider_home(home, run_as_uid, run_as_gid)
    } else {
        write_provider_bootstrap_files(provider, files, home, Path::new("/run/freshell-bootstrap"))
    }?;
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
struct BootstrapPublication {
    provider: String,
    home: PathBuf,
    // Every newly published inode needs ownership handoff, including replacements.
    owned_paths: std::collections::BTreeSet<PathBuf>,
    // Only newly created pathnames grant removal authority on failure.
    new_paths: Vec<PathBuf>,
    replacements: Vec<(PathBuf, PathBuf)>,
}
impl BootstrapPublication {
    fn reserve(&self, path: &Path) -> Result<(), String> {
        let observed = self
            .owned_paths
            .len()
            .checked_add(usize::from(!self.owned_paths.contains(path)))
            .and_then(|entries| entries.checked_add(1)) // mounted HOME handoff
            .ok_or("created path accounting overflow")?;
        if observed > freshell_platform::provider_environment::CopyLimits::default().max_entries {
            return Err(format!("created provider paths exceed shared entry bound: observed {observed}, permitted 100000"));
        }
        Ok(())
    }
}
impl Drop for BootstrapPublication {
    fn drop(&mut self) {
        rollback_created_provider_paths(&self.new_paths);
        for (destination, backup) in self.replacements.iter().rev() {
            if let Err(error) = std::fs::rename(backup, destination) {
                emit_environment_event(serde_json::json!({
                    "severity": "error", "event": "provider.bootstrap.rollback.failed",
                    "stage": "session_host", "provider": self.provider,
                    "operation": "restore_replacement",
                    "relative_path": destination.strip_prefix(&self.home).unwrap_or(Path::new("")),
                    "error_kind": format!("{:?}", error.kind()), "os_error": error.raw_os_error()
                }));
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

fn verify_initialized_provider_home(
    home: &Path,
    uid: u32,
    gid: u32,
) -> Result<Vec<PathBuf>, String> {
    use std::os::unix::fs::MetadataExt;
    let metadata =
        std::fs::symlink_metadata(home).map_err(|_| "initialized provider HOME unavailable")?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != uid
        || metadata.gid() != gid
        || metadata.mode() & 0o777 != 0o700
        || std::fs::canonicalize(home).map_err(|_| "initialized provider HOME unavailable")? != home
    {
        return Err("initialized provider HOME physical ownership changed".into());
    }
    Ok(Vec::new())
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
    // Read and bound every input before changing any selected destination. Both
    // staged files and replacement backups remain on the mounted HOME filesystem.
    let stage = tempfile::Builder::new()
        .prefix(".freshell-bootstrap-")
        .tempdir_in(home)
        .map_err(|error| error.to_string())?;
    let selections = files
        .iter()
        .enumerate()
        .map(|(index, _)| {
            let source = source_root.join(format!("provider-{index}"));
            if !std::fs::metadata(&source)
                .map_err(|error| error.to_string())?
                .is_file()
            {
                return Err("provider bootstrap input must be a regular file".to_owned());
            }
            Ok(CopySelection {
                source: std::fs::canonicalize(source).map_err(|error| error.to_string())?,
                destination_relative: format!("provider-{index}").into(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    copy_environment_with_events(
        "bootstrap_inputs",
        provider,
        &selections,
        &stage.path().join("inputs"),
        &[],
    )
    .map_err(|error| error.to_string())?;
    let mut created = BootstrapPublication {
        provider: provider.into(),
        home: home.into(),
        owned_paths: std::collections::BTreeSet::new(),
        new_paths: Vec::new(),
        replacements: Vec::new(),
    };
    for (index, destination) in destinations.iter().enumerate() {
        let relative = destination
            .strip_prefix(home)
            .map_err(|error| error.to_string())?;
        let mut parent = home.to_path_buf();
        for part in relative.parent().into_iter().flat_map(Path::components) {
            parent.push(part.as_os_str());
            match std::fs::symlink_metadata(&parent) {
                Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
                Ok(_) => {
                    return Err("provider bootstrap parent must be a physical directory".into())
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    created.reserve(&parent)?;
                    std::fs::create_dir(&parent).map_err(|error| error.to_string())?;
                    created.owned_paths.insert(parent.clone());
                    created.new_paths.push(parent.clone());
                    set_mode(&parent, 0o700)?;
                }
                Err(error) => return Err(error.to_string()),
            }
        }
        created.reserve(destination)?;
        let replacement = match std::fs::symlink_metadata(destination) {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => true,
            Ok(_) => return Err("provider bootstrap destination must be a regular file".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(error.to_string()),
        };
        let input = stage.path().join(format!("inputs/provider-{index}"));
        set_mode(&input, 0o600)?;
        // Sync each complete input before publishing it, as the prior writer did.
        std::fs::File::open(&input)
            .and_then(|file| file.sync_all())
            .map_err(|error| error.to_string())?;
        if replacement {
            let backup = stage.path().join(format!("backup-{index}"));
            std::fs::rename(destination, &backup).map_err(|error| error.to_string())?;
            created.replacements.push((destination.clone(), backup));
        }
        publish(&input, destination).map_err(|error| error.to_string())?;
        created.owned_paths.insert(destination.clone());
        if !replacement {
            created.new_paths.push(destination.clone());
        }
    }
    // Committing leaves only the exact new inode ownership ledger. Backups are
    // attempt-owned and disappear with the stage; adopted parents are excluded.
    created.new_paths.clear();
    created.replacements.clear();
    let mut paths = std::mem::take(&mut created.owned_paths);
    paths.insert(home.to_owned());
    Ok(paths.into_iter().collect())
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
    copy_environment_with_events_for_mounts(stage, provider, selections, destination, excluded, &[])
}

fn copy_environment_with_events_for_mounts(
    stage: &str,
    provider: &str,
    selections: &[freshell_platform::provider_environment::CopySelection],
    destination: &Path,
    excluded: &[PathBuf],
    mounted_directories: &[PathBuf],
) -> Result<
    freshell_platform::provider_environment::CopyReport,
    freshell_platform::provider_environment::CopyError,
> {
    let started = std::time::Instant::now();
    emit_environment_event(serde_json::json!({
        "severity": "info", "event": "provider.environment.copy.started",
        "stage": stage, "provider": provider, "selections": selections.len()
    }));
    let report = freshell_platform::provider_environment::copy_environment_for_mounts(
        selections,
        destination,
        excluded,
        Default::default(),
        mounted_directories,
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

fn copy_provider_config_references_with_ownership(
    context: &freshell_runtime_protocol::ProviderLaunchContext,
    provider: &str,
    workspace: &Path,
    user_provider_root: &Path,
    provider_home: &Path,
    final_home: &Path,
    run_as: (u32, u32),
) -> Result<(), String> {
    use freshell_platform::provider_environment::CopySelection;
    use freshell_runtime_protocol::ProviderConfigRoot;
    context.validate(provider).map_err(|error| error.message)?;
    let mut selections = provider_config_references(context)
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
    selections.extend(
        context
            .prepared_inputs
            .iter()
            .flat_map(|inputs| &inputs.resource_mounts)
            .map(|unit| CopySelection {
                source: user_provider_root.join(&unit.stage_relative_path),
                destination_relative: unit.provider_relative_path.clone().into(),
            }),
    );
    let protected = private_bound_destinations(context);
    let mut excluded = provider_credential_sources(user_provider_root);
    for selection in &selections {
        for relative in &protected {
            if let Ok(suffix) = Path::new(relative).strip_prefix(&selection.destination_relative) {
                if let Ok(source) = std::fs::canonicalize(selection.source.join(suffix)) {
                    excluded.push(source);
                }
            }
        }
    }
    let mounted = if provider_home == final_home {
        resource_mount_roots(context)
    } else {
        Vec::new()
    };
    let report = copy_environment_with_events_for_mounts(
        "session_host",
        provider,
        &selections,
        provider_home,
        &excluded,
        &mounted,
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

fn resource_mount_roots(
    context: &freshell_runtime_protocol::ProviderLaunchContext,
) -> Vec<PathBuf> {
    context
        .prepared_inputs
        .iter()
        .flat_map(|inputs| &inputs.resource_mounts)
        .map(|root| PathBuf::from(&root.provider_relative_path))
        .collect()
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

fn private_bound_destinations(
    context: &freshell_runtime_protocol::ProviderLaunchContext,
) -> std::collections::BTreeSet<String> {
    let home = Path::new("/home/freshell/provider");
    let mut protected = context
        .prepared_inputs
        .iter()
        .flat_map(|inputs| {
            inputs
                .config_binds
                .iter()
                .map(|bind| bind.effective_destination.as_str())
                .chain(inputs.indexed_files.iter().flat_map(|files| {
                    files
                        .aliases
                        .iter()
                        .map(|alias| alias.effective_destination.as_str())
                }))
        })
        .filter_map(|destination| {
            Path::new(destination)
                .strip_prefix(home)
                .ok()
                .and_then(Path::to_str)
                .map(str::to_owned)
        })
        .collect::<std::collections::BTreeSet<_>>();
    if let Some(inputs) = &context.prepared_inputs {
        for destination in inputs
            .config_binds
            .iter()
            .map(|bind| &bind.effective_destination)
            .chain(inputs.indexed_files.iter().flat_map(|files| {
                files
                    .aliases
                    .iter()
                    .map(|alias| &alias.effective_destination)
            }))
        {
            for unit in &inputs.resource_mounts {
                if let Ok(relative) =
                    Path::new(destination).strip_prefix(&unit.effective_destination)
                {
                    protected.insert(
                        Path::new(&unit.provider_relative_path)
                            .join(relative)
                            .to_string_lossy()
                            .into_owned(),
                    );
                }
            }
        }
    }
    protected
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
    copy_provider_config_references_with_ownership(
        context,
        provider,
        workspace,
        user_provider_root,
        &projection,
        provider_home,
        (unsafe { libc::geteuid() }, unsafe { libc::getegid() }),
    )?;
    let mut destinations = provider_config_references(context)
        .iter()
        .map(|reference| reference.provider_relative_path.clone())
        .collect::<Vec<_>>();
    destinations.extend(
        context
            .prepared_inputs
            .iter()
            .flat_map(|inputs| &inputs.resource_mounts)
            .map(|unit| unit.provider_relative_path.clone()),
    );
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
    std::fs::write(
        stage.path().join("private-mountpoints.json"),
        serde_json::to_vec(&private_bound_destinations(context))
            .map_err(|_| "private mountpoint metadata invalid")?,
    )
    .map_err(|_| "private mountpoint metadata write failed")?;
    let mounted = freshell_runtime_protocol::bounded_json_bytes(
        &resource_mount_roots(context),
        freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES,
    )
    .map_err(|_| "resource mountpoint metadata profile exceeded")?;
    std::fs::write(stage.path().join("resource-mountpoints.json"), mounted)
        .map_err(|_| "resource mountpoint metadata write failed")?;
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
    let protected: std::collections::BTreeSet<String> =
        match std::fs::read(stage.join("private-mountpoints.json")) {
            Ok(bytes) => {
                serde_json::from_slice(&bytes).map_err(|_| "private mountpoint metadata invalid")?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Default::default(),
            Err(_) => return Err("private mountpoint metadata unavailable".into()),
        };
    if protected.iter().any(|relative| {
        Path::new(relative).as_os_str().is_empty()
            || Path::new(relative)
                .components()
                .any(|part| !matches!(part, std::path::Component::Normal(_)))
    }) {
        return Err("private mountpoint metadata has an invalid relative path".into());
    }
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
    let mounted: Vec<PathBuf> = {
        use std::io::Read;
        match std::fs::File::open(stage.join("resource-mountpoints.json")) {
            Ok(file) => {
                let mut bytes = Vec::new();
                file.take(freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES as u64 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| "resource mountpoint metadata read failed")?;
                if bytes.len() > freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES {
                    return Err("resource mountpoint metadata profile exceeded".into());
                }
                serde_json::from_slice(&bytes)
                    .map_err(|_| "resource mountpoint metadata invalid")?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(_) => return Err("resource mountpoint metadata unavailable".into()),
        }
    };
    if mounted.iter().any(|path| {
        !path.starts_with(".freshell/provider-roots")
            || path
                .components()
                .any(|part| !matches!(part, std::path::Component::Normal(_)))
    }) {
        return Err("resource mountpoint metadata has an invalid owned root".into());
    }
    copy_environment_with_events_for_mounts(
        "provider_publication",
        &provider,
        &selections,
        provider_home,
        &[],
        &mounted,
    )
    .map_err(|error| error.to_string())?;
    let mut stale = previous.difference(&current).collect::<Vec<_>>();
    stale.sort_by_key(|path| std::cmp::Reverse(Path::new(path).components().count()));
    for relative in stale {
        if protected.contains(relative) {
            continue;
        }
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
    _provider: &str,
    provider_files: &[(&str, Vec<u8>)],
    configuration_files: &[(String, PathBuf)],
    run_as_uid: u32,
    run_as_gid: u32,
    indexed_configuration: bool,
) -> Result<(), String> {
    prepare_provider_files_at(
        Path::new("/home/freshell/provider"),
        Path::new("/tmp/freshell-provider-auth"),
        provider_files,
        configuration_files,
        run_as_uid,
        run_as_gid,
        indexed_configuration,
    )
}

fn prepare_provider_files_at(
    home: &Path,
    auth_dir: &Path,
    provider_files: &[(&str, Vec<u8>)],
    configuration_files: &[(String, PathBuf)],
    run_as_uid: u32,
    run_as_gid: u32,
    indexed_configuration: bool,
) -> Result<(), String> {
    if provider_files.is_empty() && configuration_files.is_empty() {
        return Ok(());
    }
    if !provider_files.is_empty() || !indexed_configuration {
        std::fs::create_dir_all(auth_dir).map_err(|error| error.to_string())?;
        set_mode(auth_dir, 0o711)?;
    }
    // Retain native auth until a matching typed grant has been written and
    // owned. The final destination replacement occurs only for that grant.
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
    let mut aggregate = 0u64;
    for (index, (relative, source)) in configuration_files.iter().enumerate() {
        let destination = home.join(relative);
        if indexed_configuration {
            let metadata = std::fs::symlink_metadata(source)
                .map_err(|_| "indexed configuration-file mount unavailable")?;
            if !metadata.is_file() {
                return Err("indexed configuration-file mount is not regular".into());
            }
            let bytes = count_configuration_bytes_as_provider(source, run_as_uid, run_as_gid)?;
            aggregate = aggregate
                .checked_add(bytes)
                .ok_or("indexed configuration-file size overflow")?;
            if bytes > 16 * 1024 * 1024 || aggregate > 32 * 1024 * 1024 {
                return Err("indexed configuration-file actual bytes exceed profile".into());
            }
            publish_configuration_link(&destination, source, run_as_uid, run_as_gid)?;
            continue;
        }
        let target = auth_dir.join(format!("configuration-{index}"));
        let temporary = auth_dir.join(format!(
            "configuration-{index}-tmp-{}",
            uuid::Uuid::new_v4()
        ));
        let result = (|| {
            use std::io::Read;
            use std::os::unix::fs::OpenOptionsExt;
            let input = std::fs::File::open(source)
                .map_err(|_| "configuration-file grant is unavailable")?;
            let mut output = std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(&temporary)
                .map_err(|_| "configuration-file publication failed")?;
            let bytes = std::io::copy(&mut input.take(16 * 1024 * 1024 + 1), &mut output)
                .map_err(|_| "configuration-file publication read failed")?;
            aggregate = aggregate
                .checked_add(bytes)
                .ok_or("configuration-file size overflow")?;
            if bytes > 16 * 1024 * 1024 || aggregate > 32 * 1024 * 1024 {
                return Err("configuration-file grant exceeds per-source or aggregate limit");
            }
            output
                .sync_all()
                .map_err(|_| "configuration-file publication sync failed")?;
            set_owner(&temporary, run_as_uid, run_as_gid)
                .map_err(|_| "configuration-file ownership failed")?;
            std::fs::rename(&temporary, &target)
                .map_err(|_| "configuration-file publication failed")?;
            publish_configuration_link(&destination, &target, run_as_uid, run_as_gid)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result.map_err(str::to_string)?;
    }
    Ok(())
}

fn count_configuration_bytes_as_provider(
    source: &Path,
    uid: u32,
    gid: u32,
) -> Result<u64, &'static str> {
    let limit = 16 * 1024 * 1024 + 1;
    if uid == unsafe { libc::geteuid() } && gid == unsafe { libc::getegid() } {
        use std::io::Read;
        return std::io::copy(
            &mut std::fs::File::open(source)
                .map_err(|_| "indexed configuration-file mount unreadable")?
                .take(limit),
            &mut std::io::sink(),
        )
        .map_err(|_| "indexed configuration-file read failed");
    }
    // The indexed publisher owns 0600 files as the provider identity. Keep
    // actual-byte validation under that identity; pipe bytes only to a sink.
    let mut command = std::process::Command::new("/usr/bin/setpriv");
    command
        .args(provider_identity_args(uid, gid))
        .args([
            "/usr/bin/head",
            "-c",
            "16777217",
            "--",
            source
                .to_str()
                .ok_or("indexed configuration-file path is not UTF-8")?,
        ])
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(target_os = "linux")]
    freshell_platform::provider_exec::check_command(&command, false, &["/usr/bin/head"])
        .map_err(|_| "indexed configuration-file provider exec profile invalid")?;
    let mut child = command
        .spawn()
        .map_err(|_| "indexed configuration-file provider read failed to start")?;
    let bytes = std::io::copy(
        &mut child
            .stdout
            .take()
            .ok_or("indexed configuration-file private stream unavailable")?,
        &mut std::io::sink(),
    )
    .map_err(|_| "indexed configuration-file provider read failed")?;
    if !child
        .wait()
        .map_err(|_| "indexed configuration-file provider read failed")?
        .success()
    {
        return Err("indexed configuration-file provider read failed");
    }
    Ok(bytes)
}

fn publish_configuration_link(
    destination: &Path,
    target: &Path,
    uid: u32,
    gid: u32,
) -> Result<(), &'static str> {
    let parent = destination
        .parent()
        .ok_or("configuration-file destination has no parent")?;
    run_provider_path_command(
        uid,
        gid,
        "/usr/bin/mkdir",
        &[
            "-p",
            "--",
            parent
                .to_str()
                .ok_or("configuration-file parent is not UTF-8")?,
        ],
    )
    .map_err(|_| "configuration-file parent creation failed")?;
    run_provider_path_command(
        uid,
        gid,
        "/usr/bin/ln",
        &[
            "-sfnT",
            "--",
            target
                .to_str()
                .ok_or("configuration-file target is not UTF-8")?,
            destination
                .to_str()
                .ok_or("configuration-file destination is not UTF-8")?,
        ],
    )
    .map_err(|_| "configuration-file link publication failed")
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
            "lchown {}: {}",
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
    fn copy_provider_config_references(
        context: &freshell_runtime_protocol::ProviderLaunchContext,
        provider: &str,
        workspace: &std::path::Path,
        user_provider_root: &std::path::Path,
        provider_home: &std::path::Path,
        run_as_uid: u32,
        run_as_gid: u32,
    ) -> Result<(), String> {
        super::copy_provider_config_references_with_ownership(
            context,
            provider,
            workspace,
            user_provider_root,
            provider_home,
            provider_home,
            (run_as_uid, run_as_gid),
        )
    }

    fn executable_fixture() -> tempfile::TempDir {
        match std::env::var_os("FRESHELL_TEST_EXECUTABLE_TMP_DIR") {
            Some(directory) => tempfile::tempdir_in(directory),
            None => tempfile::tempdir(),
        }
        .expect("owned executable fixture directory")
    }
    #[test]
    fn provider_config_precreated_home_needs_no_empty_bootstrap_handoff() {
        use super::*;
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        std::fs::create_dir(&home).unwrap();
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(home.join("retained"), "retained-provider-state").unwrap();
        let before = std::fs::metadata(&home).unwrap();
        let (uid, gid) = unsafe { (libc::geteuid(), libc::getegid()) };
        let ledger = verify_initialized_provider_home(&home, uid, gid).unwrap();
        assert!(ledger.is_empty(),"an already initialized HOME must not be put in the trusted initial ownership ledger again");
        let after = std::fs::metadata(&home).unwrap();
        assert_eq!(
            (after.ino(), after.uid(), after.gid(), after.mode()),
            (before.ino(), before.uid(), before.gid(), before.mode())
        );
        assert_eq!(
            std::fs::read_to_string(home.join("retained")).unwrap(),
            "retained-provider-state"
        );
    }
    #[test]
    fn provider_native_auth_survives_without_matching_typed_replacement() {
        use super::*;
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let auth = home.join(".local/share/opencode/auth.json");
        std::fs::create_dir_all(auth.parent().unwrap()).unwrap();
        let native = r#"{"native":{"type":"api","key":"durable-nonce"}}"#;
        std::fs::write(&auth, native).unwrap();
        let uid = unsafe { libc::geteuid() };
        let gid = unsafe { libc::getegid() };
        prepare_provider_files_at(
            &home,
            &root.path().join("empty-auth"),
            &[],
            &[],
            uid,
            gid,
            false,
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(&auth).unwrap(), native);
        prepare_provider_files_at(
            &home,
            &root.path().join("ca-only"),
            &[(".freshell/opencode/ca.pem", b"synthetic-ca".to_vec())],
            &[],
            uid,
            gid,
            false,
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(&auth).unwrap(), native);
        let replacement = b"{\"typed\":true}";
        prepare_provider_files_at(
            &home,
            &root.path().join("typed-auth"),
            &[(".local/share/opencode/auth.json", replacement.to_vec())],
            &[],
            uid,
            gid,
            false,
        )
        .unwrap();
        assert_eq!(std::fs::read(&auth).unwrap(), replacement);
        assert!(std::fs::symlink_metadata(&auth)
            .unwrap()
            .file_type()
            .is_symlink());
    }
    use super::*;

    #[cfg(unix)]
    #[test]
    fn provider_secret_indexed_configuration_consumer_keeps_the_mounted_inode_without_a_second_copy(
    ) {
        use sha2::{Digest, Sha256};
        use std::os::unix::fs::MetadataExt;
        let fixture = tempfile::tempdir().unwrap();
        let home = fixture.path().join("home");
        let private = fixture.path().join("legacy-private-copy");
        let mounted = fixture.path().join("published-index-0");
        std::fs::create_dir(&home).unwrap();
        std::fs::write(&mounted, b"PRIVATE_INDEXED_GENERATION_SENTINEL").unwrap();
        let (uid, gid) = unsafe { (libc::geteuid(), libc::getegid()) };
        prepare_provider_files_at(
            &home,
            &private,
            &[],
            &[(".freshell/references/0".into(), mounted.clone())],
            uid,
            gid,
            true,
        )
        .unwrap();
        let selected = home.join(".freshell/references/0");
        let receipt=std::process::Command::new("node").env_clear()
            .env("PATH",std::env::var_os("PATH").unwrap())
            .args(["-e","process.stdout.write(require('crypto').createHash('sha256').update(require('fs').readFileSync(process.argv[1])).digest('hex'))"])
            .arg(&selected).output().unwrap();
        assert!(receipt.status.success());
        assert_eq!(
            String::from_utf8(receipt.stdout).unwrap(),
            format!(
                "{:x}",
                Sha256::digest(b"PRIVATE_INDEXED_GENERATION_SENTINEL")
            )
        );
        assert_eq!(
            std::fs::metadata(&selected).unwrap().ino(),
            std::fs::metadata(&mounted).unwrap().ino()
        );
        assert_eq!(std::fs::read_link(&selected).unwrap(), mounted);
        assert!(
            !private.exists(),
            "indexed publication must not make another private payload copy"
        );
    }

    #[cfg(unix)]
    #[test]
    fn provider_config_two_stage_script_is_runnable() {
        use std::{os::unix::fs::PermissionsExt, process::Command};
        let root = executable_fixture();
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
    fn provider_config_external_mount_preserves_cross_root_dependency_resolution() {
        use freshell_runtime_protocol::*;
        let owned = tempfile::tempdir().unwrap();
        let stage = owned.path().join("stage");
        let home = owned.path().join("home");
        let native = owned.path().join("native-directory");
        std::fs::create_dir_all(stage.join("node_modules/transport-only")).unwrap();
        std::fs::create_dir_all(stage.join(".freshell/resource-units/root-0")).unwrap();
        std::fs::create_dir_all(&native).unwrap();
        std::fs::write(
            stage.join("node_modules/transport-only/nonce"),
            "cross-root-dependency-nonce",
        )
        .unwrap();
        std::os::unix::fs::symlink(
            "../../../node_modules",
            stage.join(".freshell/resource-units/root-0/node_modules"),
        )
        .unwrap();
        let capability = McpCapabilityReference {
            grant_id: format!("grant-{}", uuid::Uuid::new_v4()),
            endpoint: "http://host.docker.internal:1234".into(),
            provider_relative_path: ".freshell/mcp-capability.json".into(),
            host_gateway_address: None,
        };
        let context = ProviderLaunchContext {
            config: vec![ProviderConfigReference {
                root: ProviderConfigRoot::UserProvider,
                relative_path: "node_modules".into(),
                provider_relative_path: ".config/opencode/node_modules".into(),
                format: "directory".into(),
            }],
            preparation: ProviderPreparation::Opencode {
                project_config: vec![],
                tui_config: None,
                tui_source: None,
                inline_config: false,
            },
            prepared_inputs: Some(PreparedProviderInputs {
                generation_id: capability.grant_id.clone(),
                initial_auth_reservation: None,
                manifest: ProviderInputManifestReference {
                    relative_path: ".freshell/input-manifest.json".into(),
                    sha256: "a".repeat(64),
                    source_count: 0,
                    alias_count: 0,
                    recipe_count: 0,
                },
                config_binds: vec![],
                indexed_files: None,
                resource_mounts: vec![ProviderResourceMount {
                    stage_relative_path: ".freshell/resource-units/root-0".into(),
                    provider_relative_path: ".freshell/provider-roots/root-0".into(),
                    logical_destination: native.to_str().unwrap().into(),
                    effective_destination: native.to_str().unwrap().into(),
                    kind: ProviderResourceKind::Directory,
                }],
            }),
            mcp_capability: Some(capability),
        };
        copy_provider_config_references(
            &context,
            "opencode",
            owned.path(),
            &stage,
            &home,
            unsafe { libc::geteuid() },
            unsafe { libc::getegid() },
        )
        .unwrap();
        let link =
            std::fs::read_link(home.join(".freshell/provider-roots/root-0/node_modules")).unwrap();
        // A volume subpath is mounted at `native`, so this link is evaluated
        // from that discovery parent rather than its physical soul parent.
        let selected = native.join(link).join("transport-only/nonce");
        assert_eq!(
            std::fs::read_to_string(selected).unwrap(),
            "cross-root-dependency-nonce"
        );
        std::fs::write(
            stage.join("node_modules/transport-only/nonce"),
            "cross-root-refreshed-nonce",
        )
        .unwrap();
        refresh_provider_config_references(
            &context,
            "opencode",
            owned.path(),
            &stage,
            &home,
            unsafe { libc::geteuid() },
            unsafe { libc::getegid() },
        )
        .unwrap();
        let link =
            std::fs::read_link(home.join(".freshell/provider-roots/root-0/node_modules")).unwrap();
        assert_eq!(
            std::fs::read_to_string(native.join(link).join("transport-only/nonce")).unwrap(),
            "cross-root-refreshed-nonce"
        );
    }

    #[test]
    fn provider_config_selected_resource_root_populates_and_refreshes_stable_soul_directory() {
        use freshell_runtime_protocol::*;
        use std::os::unix::fs::MetadataExt;
        let owned = tempfile::tempdir().unwrap();
        let source = owned.path().join("stage");
        let home = owned.path().join("home");
        let unit = source.join(".freshell/resource-units/root-0");
        let destination = home.join(".freshell/provider-roots/root-0");
        std::fs::create_dir_all(unit.join("node_modules/dependency")).unwrap();
        std::fs::create_dir_all(&destination).unwrap();
        std::fs::write(
            unit.join("node_modules/dependency/index.js"),
            "dependency-initial",
        )
        .unwrap();
        std::fs::write(destination.join("native-owned-sibling"), "preserved").unwrap();
        let inode = std::fs::metadata(&destination).unwrap().ino();
        let capability = McpCapabilityReference {
            grant_id: format!("grant-{}", uuid::Uuid::new_v4()),
            endpoint: "http://host.docker.internal:1234".into(),
            provider_relative_path: ".freshell/mcp-capability.json".into(),
            host_gateway_address: None,
        };
        let context = ProviderLaunchContext {
            prepared_inputs: Some(PreparedProviderInputs {
                generation_id: capability.grant_id.clone(),
                initial_auth_reservation: None,
                manifest: ProviderInputManifestReference {
                    relative_path: ".freshell/input-manifest.json".into(),
                    sha256: "a".repeat(64),
                    source_count: 0,
                    alias_count: 0,
                    recipe_count: 0,
                },
                config_binds: vec![],
                resource_mounts: vec![ProviderResourceMount {
                    stage_relative_path: ".freshell/resource-units/root-0".into(),
                    provider_relative_path: ".freshell/provider-roots/root-0".into(),
                    logical_destination: "/synthetic/outside/.opencode".into(),
                    effective_destination: "/synthetic/outside/.opencode".into(),
                    kind: ProviderResourceKind::Directory,
                }],
                indexed_files: None,
            }),
            mcp_capability: Some(capability),
            config: vec![],
            preparation: ProviderPreparation::Opencode {
                project_config: vec![],
                tui_config: None,
                tui_source: None,
                inline_config: false,
            },
        };
        let uid = unsafe { libc::geteuid() };
        let gid = unsafe { libc::getegid() };
        refresh_provider_config_references(
            &context,
            "opencode",
            owned.path(),
            &source,
            &home,
            uid,
            gid,
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(destination.join("node_modules/dependency/index.js")).unwrap(),
            "dependency-initial"
        );
        std::fs::write(
            unit.join("node_modules/dependency/index.js"),
            "dependency-refreshed",
        )
        .unwrap();
        refresh_provider_config_references(
            &context,
            "opencode",
            owned.path(),
            &source,
            &home,
            uid,
            gid,
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(destination.join("node_modules/dependency/index.js")).unwrap(),
            "dependency-refreshed"
        );
        assert_eq!(std::fs::metadata(&destination).unwrap().ino(), inode);
        assert_eq!(
            std::fs::read_to_string(destination.join("native-owned-sibling")).unwrap(),
            "preserved"
        );
    }

    #[test]
    fn provider_config_directory_copy_and_refresh_leave_private_bound_leaf_untouched() {
        use freshell_runtime_protocol::*;
        use std::os::unix::fs::MetadataExt;
        let owned = tempfile::tempdir().unwrap();
        let source = owned.path().join("stage");
        let home = owned.path().join("home");
        std::fs::create_dir_all(source.join("nested")).unwrap();
        std::fs::create_dir_all(home.join(".config/opencode/nested")).unwrap();
        std::fs::write(
            source.join("nested/opencode.json"),
            "ordinary-copy-must-exclude-this",
        )
        .unwrap();
        std::fs::write(source.join("nested/resource"), "ordinary-resource").unwrap();
        let leaf = home.join(".config/opencode/nested/opencode.json");
        std::fs::write(&leaf, "private-bound-leaf").unwrap();
        let inode = std::fs::metadata(&leaf).unwrap().ino();
        let capability = McpCapabilityReference {
            grant_id: format!("grant-{}", uuid::Uuid::new_v4()),
            endpoint: "http://host.docker.internal:1234".into(),
            provider_relative_path: ".freshell/mcp-capability.json".into(),
            host_gateway_address: None,
        };
        let context = ProviderLaunchContext {
            prepared_inputs: Some(PreparedProviderInputs {
                generation_id: capability.grant_id.clone(),
                initial_auth_reservation: None,
                manifest: ProviderInputManifestReference {
                    relative_path: ".freshell/input-manifest.json".into(),
                    sha256: "a".repeat(64),
                    source_count: 0,
                    alias_count: 0,
                    recipe_count: 0,
                },
                config_binds: vec![ProviderConfigBind {
                    source_relative_path: ".freshell/templates/source-0".into(),
                    logical_destination:
                        "/home/freshell/provider/.config/opencode/nested/opencode.json".into(),
                    effective_destination:
                        "/home/freshell/provider/.config/opencode/nested/opencode.json".into(),
                }],
                resource_mounts: vec![],
                indexed_files: None,
            }),
            mcp_capability: Some(capability),
            preparation: ProviderPreparation::Opencode {
                project_config: vec![],
                tui_config: None,
                tui_source: None,
                inline_config: false,
            },
            config: vec![ProviderConfigReference {
                root: ProviderConfigRoot::UserProvider,
                relative_path: "nested".into(),
                provider_relative_path: ".config/opencode/nested".into(),
                format: "directory".into(),
            }],
        };
        let (uid, gid) = unsafe { (libc::geteuid(), libc::getegid()) };
        copy_provider_config_references(
            &context,
            "opencode",
            owned.path(),
            &source,
            &home,
            uid,
            gid,
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(&leaf).unwrap(),
            "private-bound-leaf",
            "ordinary directory copy must exclude private bound files"
        );
        assert_eq!(std::fs::metadata(&leaf).unwrap().ino(), inode);
        assert_eq!(
            std::fs::read_to_string(home.join(".config/opencode/nested/resource")).unwrap(),
            "ordinary-resource"
        );
        let protected = ".config/opencode/nested/opencode.json";
        let mut previous = read_projection_manifest(&home).unwrap();
        previous.insert(protected.into());
        write_projection_manifest(&home, &previous).unwrap();
        std::fs::write(source.join("nested/resource"), "new-resource").unwrap();
        refresh_provider_config_references(
            &context,
            "opencode",
            owned.path(),
            &source,
            &home,
            uid,
            gid,
        )
        .unwrap();
        assert_eq!(std::fs::metadata(&leaf).unwrap().ino(), inode);
        assert_eq!(
            std::fs::read_to_string(&leaf).unwrap(),
            "private-bound-leaf"
        );
        assert!(!read_projection_manifest(&home).unwrap().contains(protected));
        assert_eq!(
            std::fs::read_to_string(home.join(".config/opencode/nested/resource")).unwrap(),
            "new-resource"
        );
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
            prepared_inputs: None,
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
            prepared_inputs: None,
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
            prepared_inputs: None,
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
        let root = executable_fixture();
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
            prepared_inputs: None,
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
    async fn provider_secret_missing_prepared_source_does_not_consume_execution_grant() {
        let state = test_host_state();
        let generation = format!("grant-{}", uuid::Uuid::new_v4());
        let terminal:TerminalLaunchSpec=serde_json::from_value(serde_json::json!({
            "terminalId":"synthetic-preparation","streamId":"synthetic-stream","mode":"opencode","program":"/usr/bin/true","args":[],"env":{},
            "cwd":"/tmp","workspacePath":"/tmp","runAsUid":65534,"runAsGid":0,"cols":80,"rows":24,"projectKey":"synthetic",
            "providerLaunchContext":{"preparation":{"opencode":{"project_config":[],"inline_config":false}},
                "mcpCapability":{"grantId":generation,"endpoint":"http://host.docker.internal:4000","providerRelativePath":".freshell/mcp-capability.json"},
                "preparedInputs":{"generationId":generation,"manifest":{"relativePath":".freshell/input-manifest.json","sha256":"a".repeat(64),"sourceCount":0,"aliasCount":0,"recipeCount":0}}}
        })).unwrap();
        let result = grant_execution(
            &state,
            GrantExecutionRequest {
                soul_id: SoulId::new(),
                control_epoch: 1,
                execution_generation: 1,
                grant_id: GrantId::new(),
                fixture: None,
                provider_path_inputs: Default::default(),
                terminal: Some(terminal),
                fresh_agent: None,
                resume_spec: None,
            },
        )
        .await;
        assert!(result.is_err());
        let persisted = state.persisted.lock().await;
        assert!(persisted.grant_id.is_none(),"source preflight failure must leave the grant unconsumed and safe to reprepare before dispatch");
        assert_eq!(persisted.worker_launch_count, 0);
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
                provider_path_inputs: Default::default(),
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

        // runtime-suite /tmp is deliberately non-executable. Its existing
        // cargo target volume is the owned executable-fixture filesystem.
        let workspace = executable_fixture();
        std::fs::set_permissions(workspace.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        let provider_home = workspace.path().join("provider-home");
        let source_config = workspace.path().join("opencode.json");
        let child_output = workspace.path().join("child-effective-config");
        std::fs::create_dir(&provider_home).unwrap();
        std::fs::write(&source_config, br#"{"model":"first"}"#).unwrap();
        let context = ProviderLaunchContext {
            prepared_inputs: None,
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
            "#!/bin/sh\nset -e\ncat \"$TEST_CONFIG_PATH\" > \"$TEST_OUTPUT_PATH.tmp\"\nmv \"$TEST_OUTPUT_PATH.tmp\" \"$TEST_OUTPUT_PATH\"\nexec sleep 60\n",
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
                provider_path_inputs: Default::default(),
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
        let mut launched_pty = state.pty.lock().await.take();
        let mut diagnostics = None;
        if let Some(mut pty) = launched_pty.take() {
            diagnostics = Some(pty.read_output(state.incarnation_id.clone(), 0, 64 * 1024, None));
            pty.stop().await;
        }
        assert_eq!(
            observed.as_deref(),
            Some(br#"{"model":"second"}"#.as_slice()),
            "synthetic provider fixture output: {diagnostics:?}",
        );
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
            let root = super::executable_fixture();
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
            let last = home.join("bootstrap/last.json");
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
                "new-parent/second.json",
                "bootstrap/last.json",
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
                            std::fs::read(home.join("new-parent/second.json")).unwrap(),
                            b"new-1"
                        );
                        return Err(std::io::Error::other("synthetic late publication failure"));
                    }
                    std::fs::rename(source, destination)
                },
            );
            assert!(failure
                .unwrap_err()
                .contains("synthetic late publication failure"));
            assert_eq!(published, 3);
            assert_eq!(std::fs::read(&first).unwrap(), b"prior-first");
            assert_eq!(std::fs::read(&last).unwrap(), b"prior-last");
            assert_eq!(std::fs::read(&sibling).unwrap(), b"provider-sibling");
            assert_eq!(
                [metadata(&first), metadata(&last), metadata(&sibling)],
                before
            );
            assert!(!home.join("new-parent").exists());
            assert_eq!(
                std::fs::read_dir(&home).unwrap().count(),
                1,
                "attempt staging/backup paths must be cleaned"
            );
            let owned =
                write_provider_bootstrap_files("amplifier", &files, &home, &inputs).unwrap();
            assert!(owned.contains(&first));
            assert!(owned.contains(&last));
            assert!(owned.contains(&home.join("new-parent")));
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
    fn provider_config_first_amplifier_launch_transfers_exact_created_state_before_copy() {
        use freshell_runtime_protocol::{
            ProviderConfigReference, ProviderConfigRoot, ProviderLaunchContext, ProviderPreparation,
        };
        use std::{cell::Cell, process::Command};
        let root = executable_fixture();
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
            prepared_inputs: None,
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
}

mod command_journal;
mod control;
mod output_journal;
mod pty;

use freshell_runtime_protocol::{
    host_proof, read_frame, write_frame, ControlRole, Envelope, FixtureKind, GrantId, HostBootId,
    HostCommand, HostReply, HostResult, IncarnationId, RuntimeError, RuntimeErrorCode,
    RuntimeLimits, RuntimeMetrics, SoulId, TerminalLaunchSpec, CONTROL_PROTOCOL_VERSION,
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
}

#[tokio::main]
async fn main() {
    let code = match run().await {
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
        Some("opencode-identity-worker") => pty::run_opencode_identity_worker(&args[2..]),
        _ => Err("usage: freshell-session-host <serve|worker|fixture-child|opencode-identity-worker> ...".into()),
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
    append_event(
        &state_dir,
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
    });

    loop {
        let (stream, _) = listener.accept().await.map_err(|e| e.to_string())?;
        let state = state.clone();
        tokio::spawn(async move {
            if let Err(error) = handle_connection(stream, state.clone()).await {
                let _ = append_event(
                    &state.state_dir,
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
                    if let Some(pty) = state.pty.lock().await.as_mut() {
                        pty.stop();
                    }
                    append_event(&state.state_dir, "host.stop_requested", serde_json::json!({"controlEpoch":control_epoch,"executionGeneration":execution_generation})).ok();
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
                    if let Some(pty) = state.pty.lock().await.as_ref() {
                        evidence = serde_json::json!({
                            "workload":"terminal",
                            "terminalId":pty.terminal_id(),
                            "streamEpoch":pty.stream_epoch(),
                            "headSeq":pty.head_seq(),
                            "spoolBytes":pty.spool_bytes(),
                            "exited":pty.exited(),
                            "exitCode":pty.exit_code(),
                        });
                    }
                    Ok(HostResult::Status {
                        host_boot_id: state.host_boot_id.clone(),
                        worker_pid: persisted.worker_pid,
                        worker_launch_count: persisted.worker_launch_count,
                        max_control_epoch: persisted.max_control_epoch,
                        max_execution_generation: persisted.max_execution_generation,
                        fixture_evidence: evidence,
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
                        .read_output(incarnation_id, after_seq, max_bytes)?;
                    Ok(HostResult::TerminalOutput(batch))
                }
                HostCommand::RuntimeMetrics { incarnation_id } => {
                    ensure_incarnation(&incarnation_id, state)?;
                    Ok(HostResult::RuntimeMetrics(read_runtime_metrics()))
                }
                HostCommand::Hello { .. } => unreachable!(),
            }
        }
    }
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
                return Ok(HostResult::GrantAccepted {
                    host_boot_id: state.host_boot_id.clone(),
                    worker_pid: pid,
                    worker_launch_count: persisted.worker_launch_count,
                    fixture_evidence: persisted.fixture_evidence.clone(),
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

    let (pid, evidence) = match (fixture, terminal) {
        (Some(fixture), None) => {
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
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
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
            (pid, evidence)
        }
        (None, Some(terminal)) => {
            prepare_provider_bootstrap_files(&terminal).map_err(|error| {
                RuntimeError::new(
                    RuntimeErrorCode::HostUnreachable,
                    format!("prepare provider bootstrap: {error}"),
                )
            })?;
            let hosted =
                HostedPty::spawn(&state.state_dir, state.incarnation_id.clone(), &terminal)
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
            (pid, evidence)
        }
        _ => {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                "execution grant must carry exactly one fixture or terminal workload",
            ));
        }
    };

    persisted.worker_launch_count += 1;
    persisted.worker_pid = Some(pid);
    persisted.fixture_evidence = evidence;
    write_state(&state.state_dir, &persisted).map_err(registry_like_error)?;
    append_event(&state.state_dir, "host.grant_consumed", serde_json::json!({"grantId":grant_id,"workerPid":pid,"workerLaunchCount":persisted.worker_launch_count,"controlEpoch":control_epoch,"executionGeneration":execution_generation})).ok();

    Ok(HostResult::GrantAccepted {
        host_boot_id: state.host_boot_id.clone(),
        worker_pid: pid,
        worker_launch_count: persisted.worker_launch_count,
        fixture_evidence: persisted.fixture_evidence.clone(),
    })
}

fn prepare_provider_bootstrap_files(terminal: &TerminalLaunchSpec) -> Result<(), String> {
    let home = terminal
        .env
        .get("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "managed provider requires terminal HOME".to_string())?;
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

    for (index, file) in terminal.provider_bootstrap_files.iter().enumerate() {
        let source = PathBuf::from(format!("/run/freshell-bootstrap/provider-{index}"));
        let relative = PathBuf::from(&file.provider_relative_path);
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
        set_owner(&destination, terminal.run_as_uid, terminal.run_as_gid)?;
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
        set_owner(&dir, terminal.run_as_uid, terminal.run_as_gid)?;
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
    let soul = required_arg(args, "--soul-id")?;
    match fixture.as_str() {
        "heartbeat" => heartbeat_worker(&state_dir, &soul).await,
        "descendants" => descendant_worker(&state_dir).await,
        "cpu_burner" => cpu_burner_worker(&state_dir).await,
        "memory_allocator" => memory_allocator_worker(&state_dir).await,
        "native_session" => native_session_worker(&state_dir, &soul).await,
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
    History,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NativeFixtureState {
    session_id: String,
    history: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeFixtureResponse {
    ok: bool,
    session_id: Option<String>,
    history: Vec<String>,
    error: Option<String>,
}

async fn native_session_worker(state_dir: &Path, soul: &str) -> Result<(), String> {
    let socket_path = state_dir.join("native.sock");
    if socket_path.exists() {
        std::fs::remove_file(&socket_path).map_err(|e| e.to_string())?;
    }
    let listener = UnixListener::bind(&socket_path).map_err(|e| e.to_string())?;
    set_mode(&socket_path, 0o600)?;
    atomic_write(
        &state_dir.join("native-session-ready.json"),
        &serde_json::to_vec(&serde_json::json!({"socket":"native.sock","soulId":soul}))
            .map_err(|e| e.to_string())?,
    )?;
    loop {
        let (mut stream, _) = listener.accept().await.map_err(|e| e.to_string())?;
        let request: NativeFixtureRequest =
            read_frame(&mut stream).await.map_err(|e| e.to_string())?;
        let response = handle_native_fixture_request(state_dir, soul, request)?;
        write_frame(&mut stream, &response)
            .await
            .map_err(|e| e.to_string())?;
    }
}

fn handle_native_fixture_request(
    state_dir: &Path,
    soul: &str,
    request: NativeFixtureRequest,
) -> Result<NativeFixtureResponse, String> {
    let state_path = state_dir.join("native-session-state.json");
    match request {
        NativeFixtureRequest::Create => {
            let state = if state_path.exists() {
                read_native_fixture_state(&state_path)?
            } else {
                let state = NativeFixtureState {
                    session_id: format!("fixture-native-{soul}"),
                    history: vec!["create".into()],
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

fn native_fixture_ok(state: NativeFixtureState) -> NativeFixtureResponse {
    NativeFixtureResponse {
        ok: true,
        session_id: Some(state.session_id),
        history: state.history,
        error: None,
    }
}

fn native_fixture_error(message: &str) -> NativeFixtureResponse {
    NativeFixtureResponse {
        ok: false,
        session_id: None,
        history: Vec::new(),
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

fn append_event(state_dir: &Path, event: &str, data: serde_json::Value) -> Result<(), String> {
    let path = state_dir.join("host-lifecycle.jsonl");
    let line =
        serde_json::to_vec(&serde_json::json!({"at":now_millis(),"event":event,"data":data}))
            .map_err(|e| e.to_string())?;
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(&line)
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|e| e.to_string())?;
    file.sync_data().map_err(|e| e.to_string())
}

fn required_arg(args: &[String], key: &str) -> Result<String, String> {
    args.iter()
        .position(|arg| arg == key)
        .and_then(|index| args.get(index + 1))
        .cloned()
        .ok_or_else(|| format!("missing {key}"))
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
}

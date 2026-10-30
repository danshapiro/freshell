mod claude_source_observation;
mod codex_activity;
mod command_journal;
mod control;
mod native_auth_reader;
mod opencode_activity;
mod output_journal;
mod provider_input_preparation;
mod provider_secret_resolution;
mod providers;
mod pty;
mod retained_store;
#[cfg(all(test, feature = "managed-stop-contract-tests"))]
mod stop_contract_tests;

use freshell_agent_runtime::prepare_terminal_for_resume;
use freshell_runtime_protocol::{
    host_proof, read_frame, write_frame, ControlRole, Envelope, FixtureKind, FreshAgentLaunchSpec,
    GrantId, HostBootId, HostCommand, HostReply, HostResult, IncarnationId,
    OpenCodeAdoptionBaseline, OpenCodeAdoptionExpectation, OpenCodeAdoptionStatus,
    OpenCodeTransferDescriptor, OpenCodeTransferReadinessReceipt, OpenCodeVerifiedRootTail,
    ProviderBootstrapFile, RecoveryPath, RecoveryProbe, ResumeSpec, RuntimeDiagnosticCode,
    RuntimeError, RuntimeErrorCode, RuntimeLimits, RuntimeMetrics, SoulId, TerminalLaunchSpec,
    CONTROL_PROTOCOL_VERSION, MAX_OPENCODE_TRANSFER_MANIFEST_BYTES,
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
    #[serde(default)]
    native_identity_launch: Option<freshell_runtime_protocol::NativeIdentityLaunch>,
    host_boot_id: Option<HostBootId>,
    max_control_epoch: u64,
    max_execution_generation: u64,
    grant_id: Option<GrantId>,
    #[serde(default)]
    provider: Option<String>,
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
    control_fence: std::sync::Mutex<HostControlFence>,
    persisted: Mutex<PersistedHostState>,
    child: Mutex<Option<Child>>,
    pty: Mutex<Option<HostedPty>>,
    fresh_agent: Mutex<Option<Arc<freshell_agent_runtime::host_actor::FreshAgentHostActor>>>,
    fresh_native_command: Mutex<()>,
    provider_config_paths: ProviderConfigPaths,
    opencode_transfer_mount: PathBuf,
    bootstrap_root: PathBuf,
}

// Preparation can hold the durable-state lock across blocking provider work.
// Keep authenticated Stop admission independent of that lock. This fence is
// boot-local; the supervisor owns durable stopped intent and enclosure teardown.
#[derive(Default)]
struct HostControlFence {
    max_control_epoch: u64,
    max_execution_generation: u64,
    stopped: bool,
}

impl From<&PersistedHostState> for HostControlFence {
    fn from(persisted: &PersistedHostState) -> Self {
        Self {
            max_control_epoch: persisted.max_control_epoch,
            max_execution_generation: persisted.max_execution_generation,
            stopped: false,
        }
    }
}

impl HostControlFence {
    fn validate_generation(&self, epoch: u64, generation: u64) -> Result<(), RuntimeError> {
        if epoch < self.max_control_epoch || generation < self.max_execution_generation {
            return Err(RuntimeError::new(
                RuntimeErrorCode::StaleExecutionGrant,
                "stale host command generation",
            ));
        }
        Ok(())
    }

    fn admit_grant(&mut self, epoch: u64, generation: u64) -> Result<(), RuntimeError> {
        self.ensure_running(epoch, generation)?;
        self.max_control_epoch = epoch;
        self.max_execution_generation = generation;
        Ok(())
    }

    fn stop(&mut self, epoch: u64, generation: u64) -> Result<(), RuntimeError> {
        self.validate_generation(epoch, generation)?;
        self.max_control_epoch = epoch;
        self.max_execution_generation = generation;
        self.stopped = true;
        Ok(())
    }

    fn ensure_running(&self, epoch: u64, generation: u64) -> Result<(), RuntimeError> {
        self.validate_generation(epoch, generation)?;
        if self.stopped {
            return Err(RuntimeError::new(
                RuntimeErrorCode::StaleExecutionGrant,
                "host startup was stopped",
            ));
        }
        Ok(())
    }
}

struct SpawnedTerminalPty {
    pid: u32,
    terminal_id: String,
    stream_epoch: String,
    hosted: Option<HostedPty>,
}

#[async_trait::async_trait]
trait GrantExecutionEffects: Sync {
    async fn prepare_terminal(
        &self,
        terminal: TerminalLaunchSpec,
        child_secret_env: &std::collections::BTreeMap<String, String>,
        prepared_opencode_plan: Option<&freshell_platform::opencode_config::OpencodeConfigPlan>,
        selected_claude_settings: Option<&str>,
    ) -> Result<providers::PreparedTerminal, providers::ProviderLaunchPreparationError> {
        providers::prepare_terminal(
            terminal,
            child_secret_env,
            prepared_opencode_plan,
            selected_claude_settings,
        )
        .await
    }

    async fn start_terminal_sidecar(
        &self,
        prepared: providers::PreparedTerminal,
    ) -> Result<providers::PreparedTerminal, providers::ProviderLaunchPreparationError> {
        providers::start_terminal_sidecar(prepared).await
    }

    async fn prepare_fresh_agent_child_environment(
        &self,
        launch: &FreshAgentLaunchSpec,
        environment: &mut std::collections::BTreeMap<String, String>,
        prepared_opencode_plan: Option<&freshell_platform::opencode_config::OpencodeConfigPlan>,
    ) -> Result<(), String> {
        providers::prepare_fresh_agent_child_environment(
            launch,
            environment,
            prepared_opencode_plan,
        )
        .await
    }

    async fn open_fresh_agent(
        &self,
        state_dir: &Path,
        launch: FreshAgentLaunchSpec,
    ) -> Result<
        Arc<freshell_agent_runtime::host_actor::FreshAgentHostActor>,
        freshell_agent_runtime::host_actor::ActorError,
    > {
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
        claude_settings: Option<String>,
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
        claude_settings: Option<String>,
    ) -> Result<SpawnedTerminalPty, RuntimeError> {
        let opencode_adoption_revalidator = opencode_adoption_revalidator(terminal);
        let hosted = HostedPty::spawn(
            state_dir,
            incarnation_id.clone(),
            terminal,
            child_env,
            codex,
            claude_settings,
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
        Some("observe-claude-sources") if args.len() == 2 => claude_source_observation::serve_stdio(),
        Some("native-auth-stdio") if args.len() == 2 => native_auth_reader::serve_stdio(),
        Some("observe-claude-sources-private") if args.len() == 2 => {
            verify_private_helper_namespace(
                Path::new("/home/freshell/provider"),
                Path::new("/run/freshell-source-exchange/reply.sock"),
            )?;
            claude_source_observation::serve_private()
        }
        Some("project-claude-candidate-private") if args.len() == 2 => {
            claude_source_observation::serve_candidate_private()
        }
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
        Some("retained-opencode-store-worker") => retained_store::run(&args[2..]),
        Some("provider-census-only") => {
            let spec: freshell_runtime_protocol::ResumeSpec = serde_json::from_str(args.get(2).ok_or("missing native census request")?)
                .map_err(|_| "invalid native census request")?;
            if spec.provider_home != freshell_agent_runtime::PROVIDER_HOME { return Err("native census requires the canonical provider home".into()); }
            let result = freshell_agent_runtime::probe_provider_store(Path::new(&spec.provider_home), &spec);
            serde_json::to_writer(std::io::stdout(), &result).map_err(|error| format!("encode native census: {error}"))
        }
        Some("native-history-only") if args.iter().any(|arg| arg == "--if-large") => {
            if required_arg(&args[2..], "--provider")? != "codex" { return Err("optional retained display only supports Codex".into()); }
            let snapshot=freshell_freshagent::native_history::read_large_codex_display(
                Path::new(&required_arg(&args[2..], "--codex-home")?),
                &required_arg(&args[2..], "--session-id")?,
            )?;
            serde_json::to_writer(std::io::stdout(), &snapshot).map_err(|error| error.to_string())
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
        Some("native-identity-read") => providers::native_identity::run_signal_read_worker(&args[2..]),
        Some("provider-probe-worker") => providers::run_probe_worker(&args[2..]),
        Some("claude-history-read-worker") => freshell_freshagent::claude::run_claude_history_read_worker(),
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
        Some("prepare-amplifier-state") => providers::run_amplifier_state_worker(&args[2..]),
        _ => Err("usage: freshell-session-host <serve|worker|fixture-child|fresh-agent-fixture-worker|opencode-identity-worker|provider-probe-worker|refresh-provider-config|opencode-import-worker|opencode-reader-probe|opencode-stopped-repair-worker|opencode-current-evidence-worker> ...".into()),
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
    set_mode(&state_dir, 0o700)?;
    let secret = std::fs::read(&secret_file).map_err(|e| format!("read secret: {e}"))?;
    if secret.len() < 16 {
        return Err("incarnation secret is too short".into());
    }
    let host_boot_id = HostBootId::new();
    let mut persisted = match std::fs::read(state_dir.join("host-state.json")) {
        Ok(bytes) => serde_json::from_slice::<PersistedHostState>(&bytes)
            .map_err(|error| format!("read durable host state: {error}"))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => PersistedHostState::default(),
        Err(error) => return Err(format!("read durable host state: {error}")),
    };
    persisted.host_boot_id = Some(host_boot_id.clone());
    write_state(&state_dir, &persisted)?;
    append_event_with_secret(
        &state_dir,
        &secret,
        "host.boot",
        serde_json::json!({"hostBootId":host_boot_id,"incarnationId":incarnation_id}),
    )?;
    let (provider_run_as_uid, provider_run_as_gid) = provider_run_as_identity();
    emit_operator_home_readiness(
        &state_dir,
        &secret,
        provider_run_as_uid,
        provider_run_as_gid,
    );

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
        control_fence: std::sync::Mutex::new(HostControlFence::from(&persisted)),
        persisted: Mutex::new(persisted),
        child: Mutex::new(None),
        pty: Mutex::new(None),
        fresh_agent: Mutex::new(None),
        fresh_native_command: Mutex::new(()),
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
                    "native-identity-observation-v1".into(),
                    "fresh-agent-native-readiness-v1".into(),
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
                    native_identity_launch,
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
                    dispatch_budget_ms,
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
                            native_identity_launch,
                            soul_id,
                            control_epoch,
                            execution_generation,
                            grant_id,
                            fixture,
                            provider_path_inputs,
                            terminal: terminal.map(|terminal| *terminal),
                            fresh_agent: fresh_agent.map(|agent| *agent),
                            resume_spec: resume_spec.map(|resume_spec| *resume_spec),
                            dispatch_budget: dispatch_budget_ms.map(Duration::from_millis),
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
                    state
                        .control_fence
                        .lock()
                        .unwrap()
                        .stop(control_epoch, execution_generation)?;
                    stop_hosted_workloads(state).await;
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
                    let mut native_identity_observation = None;
                    let mut opencode_adoption = OpenCodeAdoptionStatus::NotRequired;
                    if let Some(pty) = state.pty.lock().await.as_ref() {
                        exited = pty.exited();
                        native_identity_observation = pty.native_identity_observation();
                        native_session_id = native_identity_observation
                            .as_ref()
                            .map(|o| o.native_session_id.clone());
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
                        if let Some(launch) = persisted.native_identity_launch.as_ref() {
                            native_identity_observation =
                                fresh_native_observation(launch, agent).await;
                        }
                        native_session_id = native_identity_observation
                            .as_ref()
                            .map(|o| o.native_session_id.clone());
                        #[cfg(feature = "fresh-agent-fixtures")]
                        if evidence["fixtureTransport"] == "deterministic" {
                            // The explicit transport fixture can report its raw
                            // synthetic root while its native observation stays absent.
                            native_session_id = agent.observed_native_session_id().await;
                        }
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
                    } else if persisted.grant_id.is_some()
                        || persisted.worker_pid.is_some()
                        || persisted.worker_launch_count > 0
                    {
                        // After a host boot, persisted initialization/PID
                        // metadata cannot establish ownership or liveness of
                        // an in-memory worker. It also cannot prove its end.
                        return Err(RuntimeError::new(
                            RuntimeErrorCode::HostUnreachable,
                            "initialization was recorded but worker liveness is unconfirmed; preserve the incarnation and inspect it before retry",
                        ));
                    }
                    Ok(HostResult::Status {
                        native_identity_observation,
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
                    let state = pty::write_hosted_input(&state.pty, &request_id, &data).await?;
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
                HostCommand::FreshAgentPrepareNative { incarnation_id } => {
                    let _native_command = state.fresh_native_command.lock().await;
                    ensure_incarnation(&incarnation_id, state)?;
                    ensure_current_fresh_native_observation(state).await?;
                    let persisted = state.persisted.lock().await.clone();
                    let observation = current_native_observation(state, &persisted)
                        .await
                        .ok_or_else(|| {
                            RuntimeError::new(
                                RuntimeErrorCode::RecoveryWrongIdentity,
                                "native readiness returned without current provider proof",
                            )
                        })?;
                    let actor = state
                        .fresh_agent
                        .lock()
                        .await
                        .clone()
                        .ok_or_else(unsupported_fresh_agent)?;
                    Ok(HostResult::FreshAgentCommand {
                        state: freshell_runtime_protocol::CommandState::ProviderAcked,
                        claude_fork: actor.claude_fork_recipe().await,
                        native_session_id: Some(observation.native_session_id),
                    })
                }
                HostCommand::FreshAgentResumePending { incarnation_id } => {
                    let _native_command = state.fresh_native_command.lock().await;
                    ensure_incarnation(&incarnation_id, state)?;
                    ensure_current_fresh_native_observation(state).await?;
                    let actor = state
                        .fresh_agent
                        .lock()
                        .await
                        .clone()
                        .ok_or_else(unsupported_fresh_agent)?;
                    actor
                        .resume_pending_native_permissions()
                        .await
                        .map_err(map_actor_error)?;
                    let persisted = state.persisted.lock().await.clone();
                    let native_session_id = current_native_observation(state, &persisted)
                        .await
                        .map(|observation| observation.native_session_id);
                    Ok(HostResult::FreshAgentCommand {
                        claude_fork: actor.claude_fork_recipe().await,
                        state: freshell_runtime_protocol::CommandState::ProviderAcked,
                        native_session_id,
                    })
                }
                HostCommand::FreshAgentSend {
                    incarnation_id,
                    request_id,
                    text,
                    settings,
                    checkpoint_logical_attempt_id,
                } => {
                    ensure_incarnation(&incarnation_id, state)?;
                    let _native_command = state.fresh_native_command.lock().await;
                    ensure_current_fresh_native_observation(state).await?;
                    let actor = state
                        .fresh_agent
                        .lock()
                        .await
                        .clone()
                        .ok_or_else(unsupported_fresh_agent)?;
                    let command_state = actor
                        .dispatch_with_checkpoint_identity(
                            request_id,
                            text,
                            settings,
                            checkpoint_logical_attempt_id,
                        )
                        .await
                        .map_err(map_actor_error)?;
                    let native_session_id = actor.profile().await.native_session_id;
                    Ok(HostResult::FreshAgentCommand {
                        claude_fork: actor.claude_fork_recipe().await,
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
                    let _native_command = state.fresh_native_command.lock().await;
                    ensure_current_fresh_native_observation(state).await?;
                    let actor = state
                        .fresh_agent
                        .lock()
                        .await
                        .clone()
                        .ok_or_else(unsupported_fresh_agent)?;
                    let prior_native = actor.profile().await.native_session_id;
                    let transition = actor
                        .fork(request_id, parent_session_id, input)
                        .await
                        .map_err(map_actor_error)?;
                    commit_fresh_native_transition(state, &actor, prior_native.as_deref()).await?;
                    Ok(HostResult::FreshAgentFork(
                        freshell_runtime_protocol::FreshAgentForkResult {
                            claude_fork: actor.claude_fork_recipe().await,
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
                    let _native_command = state.fresh_native_command.lock().await;
                    ensure_current_fresh_native_observation(state).await?;
                    let actor = state
                        .fresh_agent
                        .lock()
                        .await
                        .clone()
                        .ok_or_else(unsupported_fresh_agent)?;
                    let prior_native = actor.profile().await.native_session_id;
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
                    commit_fresh_native_transition(state, &actor, prior_native.as_deref()).await?;
                    Ok(HostResult::FreshAgentCommand {
                        claude_fork: actor.claude_fork_recipe().await,
                        state: command_state,
                        native_session_id: actor.profile().await.native_session_id,
                    })
                }
                HostCommand::FreshAgentConfigure {
                    incarnation_id,
                    request_id,
                    settings,
                } => {
                    ensure_incarnation(&incarnation_id, state)?;
                    let actor = state
                        .fresh_agent
                        .lock()
                        .await
                        .clone()
                        .ok_or_else(unsupported_fresh_agent)?;
                    let outcome = actor
                        .configure(request_id.clone(), settings)
                        .await
                        .map_err(map_actor_error);
                    emit_environment_event(configure_outcome_event(&request_id, &outcome));
                    Ok(HostResult::FreshAgentCommand {
                        state: outcome?,
                        claude_fork: actor.claude_fork_recipe().await,
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
                    let _native_command = state.fresh_native_command.lock().await;
                    ensure_current_fresh_native_observation(state).await?;
                    let actor = state
                        .fresh_agent
                        .lock()
                        .await
                        .clone()
                        .ok_or_else(unsupported_fresh_agent)?;
                    let prior_native = actor.profile().await.native_session_id;
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
                    commit_fresh_native_transition(state, &actor, prior_native.as_deref()).await?;
                    Ok(HostResult::FreshAgentCommand {
                        claude_fork: actor.claude_fork_recipe().await,
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
                    let _native_command = state.fresh_native_command.lock().await;
                    ensure_incarnation(&incarnation_id, state)?;
                    ensure_current_fresh_native_observation(state).await?;
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
                        claude_fork: actor.claude_fork_recipe().await,
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
                        None => {
                            probe_without_identity(state, creation_seed_ref, never_dispatched)
                                .await?
                        }
                    };
                    Ok(HostResult::RecoveryProbe(probe))
                }
                HostCommand::Hello { .. } => unreachable!(),
            }
        }
    }
}

async fn probe_without_identity(
    state: &HostState,
    seed: String,
    never_dispatched: bool,
) -> Result<RecoveryProbe, RuntimeError> {
    use freshell_runtime_protocol::{EvidenceStoreState, RecoveryBlockReason, RetryHint};
    let persisted = state.persisted.lock().await.clone();
    let provider = persisted.provider.as_deref().or_else(|| {
        persisted
            .fixture_evidence
            .get("mode")
            .and_then(serde_json::Value::as_str)
    });
    let shell_policy = provider.is_some_and(|provider| {
        freshell_agent_runtime::recovery_paths(provider)
            .is_some_and(|paths| !paths.contains(&RecoveryPath::NativeResume))
    });
    let initialization_undispatched = persisted.grant_id.is_none()
        && persisted.worker_launch_count == 0
        && persisted.worker_pid.is_none();
    if never_dispatched && (initialization_undispatched || shell_policy) {
        return Ok(RecoveryProbe::PristineSeedReady {
            seed,
            never_dispatched_proof: format!(
                "{}:input-and-initialization-undispatched",
                state.incarnation_id
            ),
        });
    }
    if shell_policy
        && state
            .pty
            .lock()
            .await
            .as_ref()
            .is_some_and(HostedPty::exited)
    {
        return Ok(RecoveryProbe::DefinitivelyUnavailable {
            path: RecoveryPath::Reattach,
            reason: "shell provider process ended after dispatch".into(),
            evidence: vec![format!("incarnationId={}", state.incarnation_id)],
            store_state: EvidenceStoreState::NotApplicable,
            negative_paths: Vec::new(),
        });
    }
    if !shell_policy {
        return Ok(freshell_agent_runtime::unverified_native_probe());
    }
    Ok(RecoveryProbe::Blocked {
        path: RecoveryPath::Reattach,
        reason:RecoveryBlockReason::AmbiguousIdentity,
        retry_hint:RetryHint {automatic_after_ms:None,manual_retry:true,repair:Some(if shell_policy {"verify the exact shell process has ended, then retry"} else {"capture the exact native identity and inspect its provider stores, then retry"}.into())},
        evidence:vec![if shell_policy {"shell process termination is unconfirmed"} else {"native identity is unrecorded; required provider-store absence has not been established"}.into()],
    })
}

fn unsupported_fresh_agent() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::UnsupportedWorkload,
        "incarnation is not a hosted fresh-agent",
    )
}

/// The JSONL event for one hosted configure, named for what happened to the
/// settings. Every `Ok` state means the actor saved them for the next send;
/// only `ProviderAcked` means the provider also applied them live.
fn configure_outcome_event(
    request_id: &freshell_runtime_protocol::RequestId,
    outcome: &Result<freshell_runtime_protocol::CommandState, RuntimeError>,
) -> serde_json::Value {
    use freshell_runtime_protocol::CommandState;
    let (severity, event) = match outcome {
        Ok(CommandState::ProviderAcked) => ("info", "fresh_agent.configure.applied"),
        Ok(CommandState::Completed) => ("info", "fresh_agent.configure.staged"),
        Ok(_) => ("warn", "fresh_agent.configure.live_apply_refused"),
        Err(_) => ("warn", "fresh_agent.configure.failed"),
    };
    let mut logged = serde_json::json!({
        "severity": severity,
        "event": event,
        "stage": "session_host",
        "request_id": request_id.as_str(),
    });
    match outcome {
        Ok(state) => logged["state"] = serde_json::json!(state),
        Err(error) => logged["code"] = serde_json::json!(error.code),
    }
    logged
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
        ActorError::ProviderStartFailed { .. }
        | ActorError::Transport(_)
        | ActorError::Persistence(_) => RuntimeErrorCode::HostUnreachable,
    };
    // Provider error strings may contain request bodies, environment values,
    // or credentials. Keep the control payload typed and deliberately opaque.
    RuntimeError::new(code, "hosted fresh-agent command failed")
}

fn map_fresh_agent_open_error(
    error: freshell_agent_runtime::host_actor::ActorError,
) -> RuntimeError {
    use freshell_agent_runtime::host_actor::ActorError;
    match error {
        ActorError::ProviderStartFailed { diagnostic } => RuntimeError::new(
            RuntimeErrorCode::HostUnreachable,
            format!(
                "hosted fresh-agent provider failed to start (startup diagnostic: {diagnostic})"
            ),
        )
        .with_diagnostic_code(RuntimeDiagnosticCode::FreshAgentProviderStartFailed)
        .with_fresh_agent_provider_start_diagnostic(diagnostic.into()),
        _ => RuntimeError::new(
            RuntimeErrorCode::HostUnreachable,
            "hosted fresh-agent provider failed to start",
        )
        .with_diagnostic_code(RuntimeDiagnosticCode::FreshAgentOpenFailed),
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
    native_identity_launch: Option<freshell_runtime_protocol::NativeIdentityLaunch>,
    /// The supervisor's bound on this dispatch; see [`GrantStageTimeline`].
    dispatch_budget: Option<Duration>,
}

/// Wall-clock breakdown of one execution grant, and its dispatch budget.
///
/// The supervisor sends the budget with the grant and waits a fixed reply
/// allowance longer than it for the reply. The host, not the supervisor's
/// wait, therefore ends a dispatch that runs long: every awaited stage runs
/// inside the budget, the native dispatch boundary is never crossed once the
/// budget is spent (the grant stays unconsumed), and the refusal names the
/// stage the budget ran out before. A synchronous stage (the provider
/// projection, the provider-owned config refresh) cannot be interrupted; the
/// host notices when it returns, before the next stage starts.
///
/// The breakdown names the stage that spent the time, for every outcome, so
/// a slow dispatch is diagnosable after the container is gone.
struct GrantStageTimeline {
    started: std::time::Instant,
    stage_started: std::time::Instant,
    stages: Vec<(&'static str, u128)>,
    budget: Option<Duration>,
    exhausted_before: Option<&'static str>,
}

impl GrantStageTimeline {
    fn start(budget: Option<Duration>) -> Self {
        let now = std::time::Instant::now();
        Self {
            started: now,
            stage_started: now,
            stages: Vec::new(),
            budget,
            exhausted_before: None,
        }
    }

    fn deadline(&self) -> Option<std::time::Instant> {
        self.budget.map(|budget| self.started + budget)
    }

    fn budget_exhausted(&mut self, stage: &'static str) -> RuntimeError {
        self.exhausted_before = Some(stage);
        RuntimeError::new(
            RuntimeErrorCode::HostUnreachable,
            format!(
                "execution grant spent its {}ms dispatch budget before {stage} completed",
                self.budget.unwrap_or_default().as_millis()
            ),
        )
    }

    /// Refuse to begin `stage` once the dispatch budget is spent.
    fn ensure_budget(&mut self, stage: &'static str) -> Result<(), RuntimeError> {
        match self.deadline() {
            Some(deadline) if std::time::Instant::now() >= deadline => {
                Err(self.budget_exhausted(stage))
            }
            _ => Ok(()),
        }
    }

    /// Run one awaited dispatch stage inside the budget and record it.
    async fn run<T>(
        &mut self,
        stage: &'static str,
        work: impl std::future::Future<Output = Result<T, RuntimeError>>,
    ) -> Result<T, RuntimeError> {
        self.ensure_budget(stage)?;
        let result = match self.deadline() {
            Some(deadline) => {
                match tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), work).await
                {
                    Ok(result) => result,
                    Err(_) => Err(self.budget_exhausted(stage)),
                }
            }
            None => work.await,
        };
        if result.is_ok() {
            self.completed(stage);
        }
        result
    }

    fn completed(&mut self, stage: &'static str) {
        let now = std::time::Instant::now();
        self.stages
            .push((stage, now.duration_since(self.stage_started).as_millis()));
        self.stage_started = now;
    }

    fn event(&self, grant_id: &GrantId, outcome: Result<(), &RuntimeError>) -> serde_json::Value {
        serde_json::json!({
            "severity": if outcome.is_ok() { "info" } else { "warn" },
            "event": "host.grant_timing",
            "grantId": grant_id,
            "outcome": if outcome.is_ok() { "accepted" } else { "refused" },
            "errorCode": outcome.err().map(|error| error.code),
            "totalMs": self.started.elapsed().as_millis(),
            "budgetMs": self.budget.map(|budget| budget.as_millis()),
            "budgetExhaustedBefore": self.exhausted_before,
            "stages": self
                .stages
                .iter()
                .map(|(stage, ms)| serde_json::json!({"stage": stage, "ms": ms}))
                .collect::<Vec<_>>(),
        })
    }
}

async fn stop_hosted_workloads(state: &HostState) {
    if let Some(child) = state.child.lock().await.as_mut() {
        let _ = child.start_kill();
    }
    if let Some(mut pty) = state.pty.lock().await.take() {
        pty.stop().await;
    }
    if let Some(agent) = state.fresh_agent.lock().await.take() {
        let _ = agent.stop().await;
    }
}

fn ensure_grant_running(
    state: &HostState,
    epoch: u64,
    generation: u64,
) -> Result<(), RuntimeError> {
    state
        .control_fence
        .lock()
        .unwrap()
        .ensure_running(epoch, generation)
}

async fn cleanup_startup_sidecar(
    state: &HostState,
    sidecar: Option<&Arc<freshell_codex::launch_lifecycle::CodexLaunchSidecar>>,
) {
    if let Some(sidecar) = sidecar {
        if let Err(error) = sidecar.shutdown().await {
            append_event_with_secret(
                &state.state_dir,
                &state.secret,
                "host.startup_cleanup_failed",
                serde_json::json!({"severity":"error", "stage":"codex_sidecar", "error":error}),
            )
            .ok();
        }
    }
}

async fn grant_accepted_result(
    state: &HostState,
    persisted: &PersistedHostState,
    opencode_adoption_required: bool,
    control_epoch: u64,
    execution_generation: u64,
) -> Result<HostResult, RuntimeError> {
    let worker_pid = persisted.worker_pid.ok_or_else(|| {
        RuntimeError::new(
            RuntimeErrorCode::StaleExecutionGrant,
            "grant was durably consumed but worker launch did not complete",
        )
    })?;
    let opencode_adoption = state
        .pty
        .lock()
        .await
        .as_ref()
        .map(HostedPty::opencode_adoption_status)
        .unwrap_or_else(|| adoption_status_for_required(opencode_adoption_required));
    let native_identity_observation = current_native_observation(state, persisted).await;
    let native_session_id =
        published_grant_native_session_id(state, persisted, native_identity_observation.as_ref())
            .await;
    // Every path, including an idempotent reply, must pass the Stop fence
    // after its final await and before accepting a worker PID.
    ensure_grant_running(state, control_epoch, execution_generation)?;
    Ok(HostResult::GrantAccepted {
        native_session_id,
        native_identity_observation,
        host_boot_id: state.host_boot_id.clone(),
        worker_pid,
        worker_launch_count: persisted.worker_launch_count,
        fixture_evidence: persisted.fixture_evidence.clone(),
        opencode_transfer_receipt: persisted.opencode_transfer_receipt.clone(),
        opencode_adoption,
    })
}

async fn grant_execution(
    state: &Arc<HostState>,
    request: GrantExecutionRequest,
    effects: &dyn GrantExecutionEffects,
) -> Result<HostResult, RuntimeError> {
    let grant_id = request.grant_id.clone();
    let mut timeline = GrantStageTimeline::start(request.dispatch_budget);
    let result = grant_execution_stages(state, request, effects, &mut timeline).await;
    let event = timeline.event(&grant_id, result.as_ref().map(|_| ()));
    emit_environment_event(event.clone());
    append_event_with_secret(&state.state_dir, &state.secret, "host.grant_timing", event).ok();
    result
}

async fn grant_execution_stages(
    state: &Arc<HostState>,
    request: GrantExecutionRequest,
    effects: &dyn GrantExecutionEffects,
    timeline: &mut GrantStageTimeline,
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
        dispatch_budget: _,
        native_identity_launch,
    } = request;
    let provider = terminal
        .as_ref()
        .map(|terminal| terminal.mode.clone())
        .or_else(|| {
            fresh_agent
                .as_ref()
                .map(|agent| agent.provider.native_provider().to_string())
        })
        .or_else(|| {
            fixture.map(|fixture| {
                if fixture == FixtureKind::NativeSession {
                    "native-session-fixture"
                } else {
                    "phase1-fixture"
                }
                .to_string()
            })
        });
    let mut persisted = state.persisted.lock().await;
    state
        .control_fence
        .lock()
        .unwrap()
        .admit_grant(control_epoch, execution_generation)?;
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
            return grant_accepted_result(
                state,
                &persisted,
                terminal
                    .as_ref()
                    .is_some_and(|terminal| terminal.opencode_adoption.is_some()),
                control_epoch,
                execution_generation,
            )
            .await;
        }
        return Err(RuntimeError::new(
            RuntimeErrorCode::StaleExecutionGrant,
            "host boot already consumed a different grant",
        ));
    }
    timeline.completed("admit");

    if let Some(binding) = native_identity_launch.as_ref() {
        if binding.incarnation_id != state.incarnation_id
            || binding.execution_generation != execution_generation
            || binding.launch_nonce.is_empty()
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::RecoveryWrongIdentity,
                "native observation launch binding does not match the current grant",
            ));
        }
    }
    let native_launch_json = native_identity_launch
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| registry_like_error(error.to_string()))?;

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
            &mut preflight_terminal,
            resume_spec.as_ref(),
            transfer_readiness_receipt
                .as_ref()
                .or(durable_readiness_receipt.as_ref()),
            effects,
        )?;
        transfer_prepared_terminal = Some(preflight_terminal.clone());
        persisted = state.persisted.lock().await;
        ensure_grant_running(state, control_epoch, execution_generation)?;
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
                return grant_accepted_result(
                    state,
                    &persisted,
                    terminal
                        .as_ref()
                        .is_some_and(|terminal| terminal.opencode_adoption.is_some()),
                    control_epoch,
                    execution_generation,
                )
                .await;
            }
            return Err(RuntimeError::new(
                RuntimeErrorCode::StaleExecutionGrant,
                "host boot already consumed a different grant",
            ));
        }
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
                (launch.run_as_uid, launch.run_as_gid),
            )
        })
        .or_else(|| {
            fresh_agent.as_ref().map(|launch| {
                (
                    launch.provider.native_provider(),
                    launch.provider_secret_references.as_slice(),
                    launch.provider_launch_context.as_ref(),
                    (launch.run_as_uid, launch.run_as_gid),
                )
            })
        });
    let mut prepared_secrets = if let Some((provider, references, context, identity)) = source {
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
            .with_diagnostic_code(RuntimeDiagnosticCode::ProviderSecretResolutionFailed)
        })?;
        timeline.completed("resolve_secrets");
        if matches!(provider, "opencode" | "codex" | "claude" | "amplifier") {
            let generated = timeline
                .run("prepare_provider_inputs", async {
                    provider_input_preparation::prepare_for_identity(
                        context,
                        &mut secrets,
                        &provider_path_inputs,
                        &state
                            .provider_config_paths
                            .private_mount
                            .join("user-provider"),
                        &state.provider_config_paths.provider_home,
                        identity,
                    )
                    .await
                    .map_err(|error| {
                        RuntimeError::new(
                            if error.starts_with("configuration reference selection changed") {
                                RuntimeErrorCode::ProviderInputsChanged
                            } else {
                                RuntimeErrorCode::HostUnreachable
                            },
                            error,
                        )
                    })
                })
                .await?;
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

    // Selection-affecting projection and provider preparation can still fail
    // safely. Persist consumption only at the native dispatch boundary; once
    // spawning is attempted, uncertain delivery must never authorize a replay.
    let consume_grant = |persisted: &mut PersistedHostState| {
        // Serialize Stop with the actual durable consumption boundary, without
        // making Stop wait for the rest of preparation or native startup.
        let fence = state.control_fence.lock().unwrap();
        fence.ensure_running(control_epoch, execution_generation)?;
        persisted.max_control_epoch = control_epoch;
        persisted.native_identity_launch = native_identity_launch.clone();
        persisted.max_execution_generation = execution_generation;
        persisted.grant_id = Some(grant_id.clone());
        persisted.provider = provider.clone();
        persisted.worker_pid = None;
        if let Some(receipt) = transfer_readiness_receipt.clone() {
            persisted.opencode_transfer_receipt = Some(receipt);
        }
        let result = write_state(&state.state_dir, persisted).map_err(registry_like_error);
        #[cfg(test)]
        if result.is_ok() {
            opencode_host_crash_checkpoint("grant.after_state_persist_before_pty");
        }
        result
    };

    let opencode_adoption_required = terminal
        .as_ref()
        .is_some_and(|terminal| terminal.opencode_adoption.is_some());
    let (pid, evidence, _native_session_id) = match (fixture, terminal, fresh_agent) {
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
            timeline.ensure_budget("consume_grant")?;
            consume_grant(&mut persisted)?;
            ensure_grant_running(state, control_epoch, execution_generation)?;
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
            timeline.completed("spawn_worker");
            let evidence = if fixture == FixtureKind::SecurityProbe {
                security_probe(&state.state_dir)
            } else {
                serde_json::json!({"fixture":fixture_name})
            };
            (pid, evidence, None)
        }
        (None, Some(terminal), None) => {
            ensure_grant_running(state, control_epoch, execution_generation)?;
            let exact_resume = resume_spec.is_some();
            let mut terminal = match transfer_prepared_terminal.take() {
                Some(prepared) => prepared,
                None => match resume_spec.as_ref() {
                    Some(resume) => prepare_terminal_for_resume(&terminal, resume)
                        .map_err(|error| error.runtime_error())?,
                    None => terminal,
                },
            };
            let resolved_secrets = prepared_secrets.take().ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::HostUnreachable,
                    "prepared terminal credentials unavailable",
                )
            })?;
            let prepare_files = |terminal: &TerminalLaunchSpec| {
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
            };
            // First boot transfers the durable provider-home inode to the
            // unprivileged provider. An exact-resume host lacks FOWNER and
            // DAC_OVERRIDE, so it stages current approved config and asks a
            // provider-owned helper to refresh only that projection. Docker's
            // ownership proof pins the same soul-scoped volume on replacement.
            if !exact_resume && terminal.opencode_transfer.is_none() {
                prepare_provider_state_for_fresh_launch(&mut terminal, prepare_files).map_err(
                    |error| {
                        error
                            .with_diagnostic_code(RuntimeDiagnosticCode::ProviderStatePrepareFailed)
                    },
                )?;
            } else {
                prepare_files(&terminal).map_err(|error| {
                    RuntimeError::new(
                        RuntimeErrorCode::HostUnreachable,
                        format!("prepare OneCLI provider files: {error}"),
                    )
                    .with_diagnostic_code(RuntimeDiagnosticCode::ProviderFilesPrepareFailed)
                })?;
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
            timeline.completed("prepare_provider_state");
            ensure_grant_running(state, control_epoch, execution_generation)?;
            let mut prepared = timeline
                .run("prepare_terminal", async {
                    effects
                        .prepare_terminal(
                            terminal,
                            &resolved_secrets.environment,
                            resolved_secrets.opencode_plan.as_ref(),
                            resolved_secrets.claude_settings_argument.as_deref(),
                        )
                        .await
                        .map_err(|error| {
                            let diagnostic = error.diagnostic_code_or(
                                RuntimeDiagnosticCode::ProviderLaunchPrepareFailed,
                            );
                            RuntimeError::new(
                                RuntimeErrorCode::HostUnreachable,
                                format!("prepare managed provider: {error}"),
                            )
                            .with_diagnostic_code(diagnostic)
                        })
                })
                .await?;
            timeline
                .run(
                    "verify_claude_sources",
                    claude_source_observation::verify_final(
                        prepared.terminal.provider_launch_context.as_ref(),
                        &state
                            .provider_config_paths
                            .private_mount
                            .join("user-provider"),
                        Path::new(&prepared.terminal.cwd),
                        &state.provider_config_paths.provider_home,
                        prepared.terminal.run_as_uid,
                        prepared.terminal.run_as_gid,
                        freshell_platform::claude_inputs::NativeSourceRuntime::Terminal,
                    ),
                )
                .await?;
            if let Some(binding) = native_launch_json.as_ref() {
                prepared.child_env.insert(
                    providers::native_identity::LAUNCH_ENV.into(),
                    binding.clone(),
                );
            }
            if let Some(gate) = transfer_phase_gate.as_ref() {
                gate.ensure_next(OpenCodeTransferPhase::GrantConsumed)
                    .map_err(opencode_transfer_phase_error)?;
            }
            timeline.ensure_budget("consume_grant")?;
            consume_grant(&mut persisted)?;
            timeline.completed("consume_grant");
            if let Some(gate) = transfer_phase_gate.as_mut() {
                gate.advance(OpenCodeTransferPhase::GrantConsumed)
                    .expect("OpenCode transfer grant phase was prevalidated");
            }
            ensure_grant_running(state, control_epoch, execution_generation)?;
            let prepared = timeline
                .run("start_sidecar", async {
                    effects
                        .start_terminal_sidecar(prepared)
                        .await
                        .map_err(|error| {
                            let diagnostic = error.diagnostic_code_or(
                                RuntimeDiagnosticCode::ProviderLaunchPrepareFailed,
                            );
                            RuntimeError::new(RuntimeErrorCode::HostUnreachable, error.to_string())
                                .with_diagnostic_code(diagnostic)
                        })
                })
                .await?;
            if let Err(error) = ensure_grant_running(state, control_epoch, execution_generation) {
                cleanup_startup_sidecar(state, prepared.codex.as_ref().map(|codex| &codex.sidecar))
                    .await;
                return Err(error);
            }
            let sidecar = prepared.codex.as_ref().map(|codex| codex.sidecar.clone());
            let terminal = prepared.terminal;
            let spawn = || {
                effects.spawn_terminal_pty(
                    &state.state_dir,
                    &state.incarnation_id,
                    &terminal,
                    prepared.child_env,
                    prepared.codex,
                    prepared.claude_settings,
                )
            };
            let launched = timeline
                .run("spawn_worker", async {
                    match transfer_phase_gate.as_mut() {
                        Some(gate) => run_opencode_transfer_pty_spawn(gate, spawn).await,
                        None => spawn().await.map_err(|error| {
                            error.with_diagnostic_code(
                                RuntimeDiagnosticCode::ProviderProcessSpawnFailed,
                            )
                        }),
                    }
                })
                .await;
            if let Err(error) = ensure_grant_running(state, control_epoch, execution_generation) {
                if let Ok(SpawnedTerminalPty {
                    hosted: Some(mut hosted),
                    ..
                }) = launched
                {
                    hosted.stop().await;
                }
                cleanup_startup_sidecar(state, sidecar.as_ref()).await;
                return Err(error);
            }
            let launched = match launched {
                Ok(launched) => launched,
                Err(error) => {
                    cleanup_startup_sidecar(state, sidecar.as_ref()).await;
                    return Err(error);
                }
            };
            let pid = launched.pid;
            if let Some(transfer) = terminal.opencode_transfer.as_ref() {
                let _ = append_event_with_secret(
                    &state.state_dir,
                    &state.secret,
                    "host.opencode_transfer.pty_spawned",
                    serde_json::json!({"transferId": transfer.transfer_id, "workerPid": pid}),
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
            ensure_grant_running(state, control_epoch, execution_generation)?;
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
            let mut resolved_secrets = prepared_secrets.take().ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::HostUnreachable,
                    "prepared fresh-agent credentials unavailable",
                )
            })?;
            let prepare_files = || {
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
                    .with_diagnostic_code(RuntimeDiagnosticCode::ProviderFilesPrepareFailed)
                })?;
                Ok::<(), RuntimeError>(())
            };
            if !exact_resume {
                prepare_fresh_provider_state_with_files_at(
                    &launch,
                    &state.provider_config_paths,
                    Path::new("/run/freshell-bootstrap"),
                    prepare_files,
                )
                .map_err(|error| {
                    RuntimeError::new(
                        RuntimeErrorCode::HostUnreachable,
                        format!("prepare hosted provider state: {error}"),
                    )
                    .with_diagnostic_code(
                        freshell_runtime_protocol::RuntimeDiagnosticCode::ProviderStatePrepareFailed,
                    )
                })?;
            } else {
                prepare_files()?;
                refresh_provider_context(
                    launch.provider_launch_context.as_ref(),
                    launch.provider.native_family(),
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
            timeline
                .run("prepare_provider_state", async {
                    effects
                        .prepare_fresh_agent_child_environment(
                            &launch,
                            &mut resolved_secrets.environment,
                            resolved_secrets.opencode_plan.as_ref(),
                        )
                        .await
                        .map_err(|error| {
                            RuntimeError::new(RuntimeErrorCode::HostUnreachable, error)
                                .with_diagnostic_code(
                                    RuntimeDiagnosticCode::ProviderChildEnvironmentPrepareFailed,
                                )
                        })
                })
                .await?;
            ensure_grant_running(state, control_epoch, execution_generation)?;
            timeline
                .run(
                    "verify_claude_sources",
                    claude_source_observation::verify_final(
                        launch.provider_launch_context.as_ref(),
                        &state
                            .provider_config_paths
                            .private_mount
                            .join("user-provider"),
                        Path::new(&launch.cwd),
                        &state.provider_config_paths.provider_home,
                        launch.run_as_uid,
                        launch.run_as_gid,
                        freshell_platform::claude_inputs::NativeSourceRuntime::Sdk,
                    ),
                )
                .await?;
            if let Some(binding) = native_launch_json.as_ref() {
                resolved_secrets.environment.insert(
                    providers::native_identity::LAUNCH_ENV.into(),
                    binding.clone(),
                );
            }
            timeline.ensure_budget("consume_grant")?;
            consume_grant(&mut persisted)?;
            timeline.completed("consume_grant");
            freshell_platform::managed_child_secrets::install(resolved_secrets.environment)
                .map_err(|error| {
                    RuntimeError::new(RuntimeErrorCode::HostUnreachable, error)
                        .with_diagnostic_code(
                            RuntimeDiagnosticCode::ProviderChildEnvironmentInstallFailed,
                        )
                })?;
            ensure_grant_running(state, control_epoch, execution_generation)?;
            let actor = timeline
                .run("start_fresh_agent", async {
                    effects
                        .open_fresh_agent(&state.state_dir, launch.clone())
                        .await
                        .map_err(map_fresh_agent_open_error)
                })
                .await?;
            if let Err(error) = ensure_grant_running(state, control_epoch, execution_generation) {
                let _ = actor.stop().await;
                return Err(error);
            }
            let profile = actor.profile().await;
            let native_session_id = actor.observed_native_session_id().await;
            let evidence = serde_json::json!({
                "workload":"fresh-agent",
                "provider":launch.provider.as_str(),
                "sessionType":launch.session_type,
                "runtimeVariant":profile.runtime_variant,
                "nativeSessionId":profile.native_session_id,
                "fixtureTransport":launch.fixture_transport,
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

    if let Err(error) = ensure_grant_running(state, control_epoch, execution_generation) {
        stop_hosted_workloads(state).await;
        return Err(error);
    }
    persisted.worker_launch_count += 1;
    persisted.worker_pid = Some(pid);
    persisted.fixture_evidence = evidence;
    write_state(&state.state_dir, &persisted).map_err(registry_like_error)?;
    append_event_with_secret(&state.state_dir, &state.secret, "host.grant_consumed", serde_json::json!({"grantId":grant_id,"workerPid":pid,"workerLaunchCount":persisted.worker_launch_count,"controlEpoch":control_epoch,"executionGeneration":execution_generation})).ok();

    let accepted = grant_accepted_result(
        state,
        &persisted,
        opencode_adoption_required,
        control_epoch,
        execution_generation,
    )
    .await;
    if accepted.is_err() {
        persisted.worker_pid = None;
        write_state(&state.state_dir, &persisted).map_err(registry_like_error)?;
        stop_hosted_workloads(state).await;
    }
    accepted
}

async fn published_grant_native_session_id(
    state: &HostState,
    persisted: &PersistedHostState,
    observation: Option<&freshell_runtime_protocol::NativeIdentityObservation>,
) -> Option<String> {
    if let Some(observation) = observation {
        return Some(observation.native_session_id.clone());
    }
    #[cfg(feature = "fresh-agent-fixtures")]
    if persisted.fixture_evidence["fixtureTransport"] == "deterministic" {
        // Match Status's explicit fixture identity contract. A live observed
        // synthetic root is a presentation reference, never native proof.
        let actor = state.fresh_agent.lock().await.clone()?;
        return actor.observed_native_session_id().await;
    }
    #[cfg(not(feature = "fresh-agent-fixtures"))]
    let _ = (state, persisted);
    None
}

async fn current_native_observation(
    state: &HostState,
    persisted: &PersistedHostState,
) -> Option<freshell_runtime_protocol::NativeIdentityObservation> {
    if let Some(pty) = state.pty.lock().await.as_ref() {
        return pty.native_identity_observation();
    }
    let launch = persisted.native_identity_launch.as_ref()?;
    let actor = state.fresh_agent.lock().await.clone()?;
    fresh_native_observation(launch, &actor).await
}

async fn fresh_native_observation(
    launch: &freshell_runtime_protocol::NativeIdentityLaunch,
    actor: &freshell_agent_runtime::host_actor::FreshAgentHostActor,
) -> Option<freshell_runtime_protocol::NativeIdentityObservation> {
    let native = actor.observed_native_session_id().await?;
    let evidence = actor.observed_native_identity_evidence().await?;
    if actor.profile().await.native_session_id.as_deref() != Some(native.as_str())
        || evidence["nativeSessionId"].as_str() != Some(native.as_str())
        || evidence.get("launch").is_some_and(|value| {
            serde_json::from_value::<freshell_runtime_protocol::NativeIdentityLaunch>(value.clone())
                .as_ref()
                .ok()
                != Some(launch)
        })
    {
        return None;
    }
    let source = if matches!(
        actor.profile().await.provider,
        freshell_runtime_protocol::FreshProvider::Claude
            | freshell_runtime_protocol::FreshProvider::Kilroy
    ) && evidence["nativeClear"]["nativeSessionId"].as_str()
        == Some(native.as_str())
        && evidence["nativeClear"]["previousNativeSessionId"]
            .as_str()
            .is_some_and(|parent| !parent.is_empty() && parent != native)
    {
        freshell_runtime_protocol::NativeIdentitySource::ClaudeNativeClear
    } else {
        freshell_runtime_protocol::NativeIdentitySource::FreshProviderHandshake
    };
    providers::native_identity::bind_provider_observation(launch, &native, source, &evidence)
}

async fn commit_fresh_native_transition(
    state: &HostState,
    actor: &Arc<freshell_agent_runtime::host_actor::FreshAgentHostActor>,
    parent: Option<&str>,
) -> Result<(), RuntimeError> {
    let child = actor.profile().await.native_session_id;
    if child.as_deref() == parent {
        return Ok(());
    }
    let refuse = || {
        RuntimeError::new(
            RuntimeErrorCode::RecoveryWrongIdentity,
            "native root transition lost its current host binding",
        )
    };
    let child = child.ok_or_else(refuse)?;
    if actor.observed_native_session_id().await.as_deref() != Some(child.as_str())
        || !state
            .fresh_agent
            .lock()
            .await
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, actor))
    {
        return Err(refuse());
    }
    let evidence = actor
        .observed_native_identity_evidence()
        .await
        .ok_or_else(refuse)?;
    let provider = actor.profile().await.provider;
    let mut persisted = state.persisted.lock().await;
    let Some(mut launch) = persisted.native_identity_launch.clone() else {
        return if cfg!(feature = "fresh-agent-fixtures")
            && persisted.fixture_evidence["fixtureTransport"] == "deterministic"
        {
            Ok(())
        } else {
            Err(refuse())
        };
    };
    if launch.incarnation_id != state.incarnation_id
        || launch.execution_generation != persisted.max_execution_generation
    {
        return Err(refuse());
    }
    if matches!(
        provider,
        freshell_runtime_protocol::FreshProvider::Claude
            | freshell_runtime_protocol::FreshProvider::Kilroy
    ) && evidence["launch"] == serde_json::json!(launch)
        && evidence["nativeSessionId"].as_str() == Some(child.as_str())
        && evidence["nativeClear"]["previousNativeSessionId"].as_str() == parent
        && evidence["nativeClear"]["nativeSessionId"].as_str() == Some(child.as_str())
    {
        // The actual clear changes the root within the current producer. Its
        // typed status observation lets the supervisor commit that same edge.
        return Ok(());
    }
    launch.evidence_revision = launch.evidence_revision.checked_add(1).ok_or_else(refuse)?;
    launch.requested_native_session_id = Some(child.clone());
    if evidence["nativeSessionId"].as_str() != Some(child.as_str())
        || serde_json::from_value::<freshell_runtime_protocol::NativeIdentityLaunch>(
            evidence["launch"].clone(),
        )
        .as_ref()
        .ok()
            != Some(&launch)
    {
        return Err(refuse());
    }
    let mut updated = persisted.clone();
    updated.native_identity_launch = Some(launch);
    write_state(&state.state_dir, &updated).map_err(registry_like_error)?;
    *persisted = updated;
    append_event_with_secret(&state.state_dir, &state.secret, "host.native_identity.transition_committed",
        serde_json::json!({"severity":"info","incarnationId":state.incarnation_id,
        "executionGeneration":persisted.max_execution_generation,
        "evidenceRevision":persisted.native_identity_launch.as_ref().map(|launch|launch.evidence_revision)})).ok();
    Ok(())
}

async fn ensure_current_fresh_native_observation(state: &HostState) -> Result<(), RuntimeError> {
    let persisted = state.persisted.lock().await.clone();
    // The typed deterministic transport exists only in the explicit fixture
    // build. Its counters never certify native mode readiness.
    if cfg!(feature = "fresh-agent-fixtures")
        && persisted.fixture_evidence["fixtureTransport"] == "deterministic"
    {
        return Ok(());
    }
    if current_native_observation(state, &persisted)
        .await
        .is_some()
    {
        return Ok(());
    }
    let actor = state.fresh_agent.lock().await.clone();
    if let Some(actor) = actor {
        actor
            .prepare_native_readiness()
            .await
            .map_err(map_actor_error)?;
        let current = state.persisted.lock().await.clone();
        if current.native_identity_launch == persisted.native_identity_launch
            && current.max_execution_generation == persisted.max_execution_generation
            && current_native_observation(state, &current).await.is_some()
        {
            return Ok(());
        }
    }
    append_event_with_secret(
        &state.state_dir,
        &state.secret,
        "host.native_input.refused",
        serde_json::json!({"severity":"warn","incarnationId":state.incarnation_id,
            "executionGeneration":persisted.max_execution_generation,
            "controlEpoch":persisted.max_control_epoch,"reason":"NATIVE_IDENTITY_UNOBSERVED"}),
    )
    .ok();
    Err(RuntimeError::new(
        RuntimeErrorCode::RecoveryWrongIdentity,
        "current native provider observation is unavailable",
    ))
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

/// Only fixed categories and numeric system codes leave the private worker stderr.
#[derive(Default)]
struct OpencodeRepairFailure {
    stage: &'static str,
    class: &'static str,
    io_kind: Option<String>,
    errno: Option<i32>,
    sqlite_code: Option<i32>,
    child_exit: Option<i32>,
    child_signal: Option<i32>,
}

impl OpencodeRepairFailure {
    fn at(stage: &'static str) -> Self {
        Self {
            stage,
            class: "validation",
            ..Self::default()
        }
    }

    fn io(&mut self, error: &io::Error) {
        self.class = "io";
        self.io_kind = Some(format!("{:?}", error.kind()));
        self.errno = error.raw_os_error();
    }

    fn import(&mut self, error: &freshell_agent_runtime::opencode_transfer::OpenCodeImportError) {
        use freshell_agent_runtime::opencode_transfer::OpenCodeImportError;
        match error {
            OpenCodeImportError::Io(error) => self.io(error),
            OpenCodeImportError::Sqlite(error) => {
                self.class = "sqlite";
                if let Some(code) = error.sqlite_error() {
                    self.sqlite_code = Some(code.extended_code);
                }
            }
            OpenCodeImportError::Blocked(_) => self.class = "blocked",
            OpenCodeImportError::Metadata(_) => self.class = "metadata",
        }
    }

    fn emit(&self) {
        eprintln!(
            "{}",
            serde_json::json!({
                "severity":"error", "event":"session_host.opencode_repair.failed",
                "stage":self.stage, "errorClass":self.class, "ioKind":self.io_kind,
                "errno":self.errno, "sqliteCode":self.sqlite_code,
                "childExit":self.child_exit, "childSignal":self.child_signal,
            })
        );
    }
}

fn with_opencode_repair_diagnostics(
    operation: impl FnOnce(&mut OpencodeRepairFailure) -> Result<(), String>,
) -> Result<(), String> {
    let mut failure = OpencodeRepairFailure::at("stage_validation");
    let result = operation(&mut failure);
    if result.is_err() {
        failure.emit();
    }
    result
}

fn run_opencode_import_worker(args: &[String]) -> Result<(), String> {
    with_opencode_repair_diagnostics(|failure| run_opencode_import_worker_inner(args, failure))
}

fn run_opencode_import_worker_inner(
    args: &[String],
    failure: &mut OpencodeRepairFailure,
) -> Result<(), String> {
    let (workspace_root, expected_cwd, uid, gid) = opencode_helper_args(args)?;
    validate_opencode_helper_identity(uid, gid)?;
    let env = std::env::vars().collect::<std::collections::BTreeMap<_, _>>();
    let paths = validate_opencode_reader_paths(&env, &workspace_root, &expected_cwd)?;
    if std::env::current_dir().map_err(|error| {
        failure.io(&error);
        error.to_string()
    })? != paths.cwd
    {
        return Err("OpenCode importer cwd differs from the requested provider cwd".into());
    }

    failure.stage = "input_stream";
    let mut stdin = io::stdin().lock();
    let descriptor = read_opencode_descriptor_frame(&mut stdin, Some(failure))?;
    if descriptor.destination_database_path != ".local/share/opencode/opencode.db" {
        return Err("OpenCode import destination path is unsupported".into());
    }
    failure.stage = "import";
    let receipt = {
        let mut payload = (&mut stdin).take(descriptor.files[0].size_bytes);
        freshell_agent_runtime::opencode_transfer::import_bundle_payload(
            &descriptor,
            &mut payload,
            &paths.database,
            &paths.workspace,
        )
        .map_err(|error| {
            failure.import(&error);
            "provider-identity OpenCode import failed".to_string()
        })?
    };
    failure.stage = "input_stream";
    let mut trailing = [0_u8; 1];
    if stdin.read(&mut trailing).map_err(|error| {
        failure.io(&error);
        error.to_string()
    })? != 0
    {
        return Err("OpenCode import stream contains trailing bytes".into());
    }
    failure.stage = "receipt_validation";
    write_opencode_helper_result(&receipt, Some(failure))
}

fn run_opencode_reader_probe(args: &[String]) -> Result<(), String> {
    with_opencode_repair_diagnostics(|failure| run_opencode_reader_probe_inner(args, failure))
}

fn run_opencode_reader_probe_inner(
    args: &[String],
    failure: &mut OpencodeRepairFailure,
) -> Result<(), String> {
    let (workspace_root, expected_cwd, uid, gid) = opencode_helper_args(args)?;
    validate_opencode_helper_identity(uid, gid)?;
    let env = std::env::vars().collect::<std::collections::BTreeMap<_, _>>();
    let paths = validate_opencode_reader_paths(&env, &workspace_root, &expected_cwd)?;
    if std::env::current_dir().map_err(|error| {
        failure.io(&error);
        error.to_string()
    })? != paths.cwd
    {
        return Err("OpenCode reader cwd differs from the requested provider cwd".into());
    }

    failure.stage = "input_stream";
    let mut stdin = io::stdin().lock();
    let descriptor = read_opencode_descriptor_frame(&mut stdin, Some(failure))?;
    let mut trailing = [0_u8; 1];
    if stdin.read(&mut trailing).map_err(|error| {
        failure.io(&error);
        error.to_string()
    })? != 0
    {
        return Err("OpenCode reader probe received trailing bytes".into());
    }
    failure.stage = "reader";
    let reader_context = installed_store_reader_context(&paths, uid, gid);
    let receipt = freshell_agent_runtime::opencode_transfer::verify_installed_store(
        &descriptor,
        &reader_context,
    )
    .map_err(|error| {
        failure.import(&error);
        "provider-identity OpenCode reader could not read the installed history".to_string()
    })?;
    failure.stage = "receipt_validation";
    write_opencode_helper_result(&receipt, Some(failure))
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
    let descriptor = read_opencode_descriptor_frame(&mut stdin, None)?;
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
    write_opencode_helper_result(&evidence, None)
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
    mut failure: Option<&mut OpencodeRepairFailure>,
) -> Result<OpenCodeTransferDescriptor, String> {
    let mut length = [0; 4];
    reader.read_exact(&mut length).map_err(|error| {
        if let Some(failure) = failure.as_deref_mut() {
            failure.io(&error);
        }
        "OpenCode transfer descriptor frame is truncated".to_string()
    })?;
    let length = u32::from_be_bytes(length) as usize;
    let max_length = MAX_OPENCODE_TRANSFER_MANIFEST_BYTES + 16 * 1024;
    if length == 0 || length > max_length {
        return Err("OpenCode transfer descriptor frame exceeds its bound".into());
    }
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes).map_err(|error| {
        if let Some(failure) = failure {
            failure.io(&error);
        }
        "OpenCode transfer descriptor frame is truncated".to_string()
    })?;
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
    failure: Option<&mut OpencodeRepairFailure>,
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
        .map_err(|error| {
            if let Some(failure) = failure {
                failure.io(&error);
            }
            "write OpenCode transfer metadata to provider helper".to_string()
        })
}

fn write_opencode_helper_result(
    value: &impl Serialize,
    failure: Option<&mut OpencodeRepairFailure>,
) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|_| "encode OpenCode helper receipt")?;
    if bytes.len() > MAX_OPENCODE_RECEIPT_BYTES {
        return Err("OpenCode helper receipt exceeds its bound".into());
    }
    let mut stdout = io::stdout().lock();
    stdout
        .write_all(&bytes)
        .and_then(|_| stdout.write_all(b"\n"))
        .and_then(|_| stdout.flush())
        .map_err(|error| {
            if let Some(failure) = failure {
                failure.io(&error);
            }
            "write OpenCode helper receipt".to_string()
        })
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
        || descriptor.destination_database_path != ".local/share/opencode/opencode.db"
        || terminal.resume_session_id.as_deref() != Some(descriptor.root_session_id.as_str())
    {
        return Err(RuntimeError::new(
            RuntimeErrorCode::OwnershipMismatch,
            "OpenCode adoption baseline does not match this provider launch",
        ));
    }
    // A stopped repair can retain a provider-store ID distinct from its soul.
    // Bind exact resumes to that durable store and root; first transfers have
    // already checked their soul/incarnation binding in StageVerified.
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
        None,
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
    mut failure: Option<&mut OpencodeRepairFailure>,
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
    let mut child = command.spawn().map_err(|error| {
        if let Some(failure) = failure.as_deref_mut() {
            failure.stage = "identity_spawn";
            failure.io(&error);
        }
        "could not start the provider-identity OpenCode helper".to_string()
    })?;
    let worker_stage = if worker == "opencode-reader-probe" {
        "reader"
    } else {
        "import"
    };
    if let Some(failure) = failure.as_deref_mut() {
        failure.stage = "input_stream";
    }
    let write_result = (|| -> Result<(), String> {
        let mut stdin = child
            .stdin
            .take()
            .ok_or("provider helper stdin is unavailable")?;
        write_opencode_descriptor_frame(&mut stdin, descriptor, failure.as_deref_mut())?;
        if let Some(payload_path) = payload_path {
            let mut payload = std::fs::File::open(payload_path).map_err(|error| {
                if let Some(failure) = failure.as_deref_mut() {
                    failure.io(&error);
                }
                "verified OpenCode stage payload could not be opened"
            })?;
            let copied = io::copy(&mut payload, &mut stdin).map_err(|error| {
                if let Some(failure) = failure.as_deref_mut() {
                    failure.io(&error);
                }
                "OpenCode payload could not be streamed to the provider helper"
            })?;
            if copied != descriptor.files[0].size_bytes {
                return Err("OpenCode staged payload size changed during handoff".into());
            }
        }
        stdin.flush().map_err(|error| {
            if let Some(failure) = failure.as_deref_mut() {
                failure.io(&error);
            }
            "OpenCode provider helper input could not be flushed"
        })?;
        Ok(())
    })();
    let output = child.wait_with_output();
    // Only the stopped diagnostic caller changes failure precedence. The
    // ordinary live helper keeps its existing wait-then-write error contract.
    if failure.is_some() {
        write_result.as_ref().map_err(Clone::clone)?;
    }
    let output = output.map_err(|error| {
        if let Some(failure) = failure.as_deref_mut() {
            failure.stage = worker_stage;
            failure.io(&error);
        }
        "OpenCode provider helper did not settle"
    })?;
    write_result?;
    if !output.status.success() {
        if let Some(failure) = failure.as_deref_mut() {
            failure.stage = worker_stage;
            failure.class = "process";
            failure.child_exit = output.status.code();
            #[cfg(unix)]
            {
                use std::os::unix::process::ExitStatusExt;
                failure.child_signal = output.status.signal();
            }
            // The child is this binary; admit only its typed numeric/category record.
            for record in String::from_utf8_lossy(&output.stderr)
                .lines()
                .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            {
                if record["event"] == "session_host.opencode_repair.failed" {
                    match record["errorClass"].as_str() {
                        Some("io") => failure.class = "io",
                        Some("sqlite") => failure.class = "sqlite",
                        Some("blocked") => failure.class = "blocked",
                        Some("metadata") => failure.class = "metadata",
                        Some("validation") => failure.class = "validation",
                        _ => continue,
                    }
                    failure.stage = match record["stage"].as_str() {
                        Some("stage_validation") => "stage_validation",
                        Some("identity_spawn") => "identity_spawn",
                        Some("input_stream") => "input_stream",
                        Some("import") => "import",
                        Some("reader") => "reader",
                        Some("receipt_validation") => "receipt_validation",
                        _ => worker_stage,
                    };
                    failure.io_kind = match record["ioKind"].as_str() {
                        Some("PermissionDenied") => Some("PermissionDenied".into()),
                        Some("NotFound") => Some("NotFound".into()),
                        Some("BrokenPipe") => Some("BrokenPipe".into()),
                        Some("StorageFull") => Some("StorageFull".into()),
                        Some(_) => Some("Other".into()),
                        None => None,
                    };
                    failure.errno = record["errno"].as_i64().and_then(|n| i32::try_from(n).ok());
                    failure.sqlite_code = record["sqliteCode"]
                        .as_i64()
                        .and_then(|n| i32::try_from(n).ok());
                    break;
                }
            }
        }
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
        if let Some(failure) = failure {
            failure.stage = "receipt_validation";
            failure.class = "validation";
        }
        return Err("provider-identity OpenCode helper receipt exceeds its bound".into());
    }
    Ok(output.stdout)
}

fn run_opencode_stopped_repair_worker(args: &[String]) -> Result<(), String> {
    with_opencode_repair_diagnostics(|failure| {
        run_opencode_stopped_repair_worker_inner(args, failure)
    })
}

fn run_opencode_stopped_repair_worker_inner(
    args: &[String],
    failure: &mut OpencodeRepairFailure,
) -> Result<(), String> {
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
    let stage_metadata = std::fs::symlink_metadata(&stage_dir).map_err(|error| {
        failure.io(&error);
        "OpenCode repair stage is unavailable"
    })?;
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
    let (descriptor, payload_path) = read_opencode_stopped_repair_stage(&stage_dir, failure)?;
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

    failure.stage = "import";
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
        Some(failure),
    )?;
    failure.stage = "receipt_validation";
    let imported: freshell_agent_runtime::opencode_transfer::ImportReceipt =
        serde_json::from_slice(&import_output)
            .map_err(|_| "provider importer returned an invalid repair receipt")?;
    validate_import_receipt_binding(&imported, &descriptor, &paths)?;

    failure.stage = "reader";
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
        Some(failure),
    )?;
    failure.stage = "receipt_validation";
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

#[derive(Deserialize)]
struct OpencodeRepairStageMetadata {
    descriptor: OpenCodeTransferDescriptor,
}

fn read_opencode_stopped_repair_stage(
    stage_dir: &Path,
    failure: &mut OpencodeRepairFailure,
) -> Result<(OpenCodeTransferDescriptor, PathBuf), String> {
    let descriptor_path = stage_dir.join("descriptor.json");
    let descriptor_metadata = std::fs::symlink_metadata(&descriptor_path).map_err(|error| {
        failure.io(&error);
        "OpenCode repair descriptor is unavailable"
    })?;
    if descriptor_metadata.file_type().is_symlink() || !descriptor_metadata.is_file() {
        return Err("OpenCode repair descriptor is not a regular file".into());
    }
    let metadata: OpencodeRepairStageMetadata =
        serde_json::from_slice(&std::fs::read(&descriptor_path).map_err(|error| {
            failure.io(&error);
            "OpenCode repair descriptor cannot be read"
        })?)
        .map_err(|_| "OpenCode repair descriptor is invalid")?;
    let descriptor = metadata.descriptor;
    descriptor
        .validate()
        .map_err(|_| "OpenCode repair descriptor is invalid")?;
    let payload_path =
        freshell_agent_runtime::opencode_transfer::verify_staged_bundle(&descriptor, stage_dir)
            .map_err(|error| {
                failure.import(&error);
                "OpenCode repair stage does not match its descriptor"
            })?;
    Ok((descriptor, payload_path))
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
        || receipt.asset_count != manifest.asset_count() as u64
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
    prepare_files: impl Fn(&TerminalLaunchSpec) -> Result<(), String>,
) -> Result<(), RuntimeError> {
    prepare_provider_state_for_fresh_launch_at(
        terminal,
        &ProviderConfigPaths::default(),
        Path::new("/run/freshell-bootstrap"),
        prepare_files,
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
            // A prior attempt completed the HOME handoff, but selected config
            // publication runs afterward and may still need to be retried.
            refresh_provider_context(
                terminal.provider_launch_context.as_ref(),
                &terminal.mode,
                &terminal.workspace_path,
                terminal.run_as_uid,
                terminal.run_as_gid,
                paths,
            )
            .map_err(|error| {
                RuntimeError::new(
                    RuntimeErrorCode::HostUnreachable,
                    format!("prepare provider config: {error}"),
                )
            })?;
            return Ok(false);
        }
    }

    prepare_provider_state_for_fresh_launch_at(terminal, paths, bootstrap_root, |_| Ok(()))?;
    Ok(true)
}

fn prepare_provider_state_for_fresh_launch_at(
    terminal: &mut TerminalLaunchSpec,
    paths: &ProviderConfigPaths,
    bootstrap_root: &Path,
    prepare_files: impl Fn(&TerminalLaunchSpec) -> Result<(), String>,
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
            &paths.provider_home,
            terminal.run_as_uid,
            terminal.run_as_gid,
        )
        .and_then(|_| prepare_files(terminal))
        .and_then(|_| prepare_provider_context_for_fresh_launch(terminal, paths))
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
            let mut created = providers::prepare_provider_state_before_bootstrap_at(
                terminal,
                &paths.provider_home,
                &paths.private_mount.join("user-provider"),
            )?;
            let bootstrap = if terminal.provider_bootstrap_files.is_empty()
                && terminal
                    .provider_launch_context
                    .as_ref()
                    .is_some_and(|context| context.prepared_inputs.is_some())
            {
                verify_initialized_provider_home(
                    &paths.provider_home,
                    terminal.run_as_uid,
                    terminal.run_as_gid,
                )
            } else {
                write_provider_bootstrap_files(
                    &terminal.mode,
                    &terminal.provider_bootstrap_files,
                    &paths.provider_home,
                    bootstrap_root,
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
                &paths.provider_home,
                created,
                terminal.run_as_uid,
                terminal.run_as_gid,
            )
        },
        |terminal| {
            prepare_files(terminal)?;
            prepare_provider_context_for_fresh_launch(terminal, paths)
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

fn prepare_fresh_provider_state_with_files_at(
    launch: &FreshAgentLaunchSpec,
    paths: &ProviderConfigPaths,
    bootstrap_root: &Path,
    prepare_files: impl Fn() -> Result<(), RuntimeError>,
) -> Result<(), String> {
    let home = &paths.provider_home;
    let metadata = std::fs::symlink_metadata(home).map_err(|error| error.to_string())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("managed provider HOME must be a physical directory".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() == launch.run_as_uid
            && metadata.gid() == launch.run_as_gid
            && metadata.permissions().mode() & 0o777 == 0o700
        {
            // Initial preparation assigns HOME ownership last. Preparation can
            // then fail before a native session exists; retry only the selected
            // context publication without replaying bootstrap or native state.
            emit_environment_event(serde_json::json!({
                "severity": "info", "event": "provider.environment.ownership.reused",
                "stage": "session_host", "provider": launch.provider.as_str(),
                "provider_uid": launch.run_as_uid, "provider_gid": launch.run_as_gid
            }));
            verify_initialized_provider_home(home, launch.run_as_uid, launch.run_as_gid)?;
            prepare_files().map_err(|error| error.message)?;
            return refresh_provider_context(
                launch.provider_launch_context.as_ref(),
                launch.provider.native_family(),
                &launch.workspace_path,
                launch.run_as_uid,
                launch.run_as_gid,
                paths,
            );
        }
        if launch.native_session_id.is_some() && metadata.uid() == launch.run_as_uid {
            return Err("selected provider HOME ownership handoff is incomplete".into());
        }
        if metadata.uid() != unsafe { libc::geteuid() }
            || metadata.gid() != unsafe { libc::getegid() }
        {
            return Err(
                "provider HOME is not owned by the selected provider or initial host".into(),
            );
        }
    }
    let created = write_provider_bootstrap_files(
        launch.provider.as_str(),
        &launch.provider_bootstrap_files,
        home,
        bootstrap_root,
    )?;
    prepare_files().map_err(|error| error.message)?;
    transfer_created_paths(
        launch.provider.as_str(),
        home,
        &created,
        launch.run_as_uid,
        launch.run_as_gid,
    )?;
    prepare_fresh_provider_context_at(launch, paths)
}

#[cfg(test)]
fn prepare_fresh_provider_state_at(
    launch: &FreshAgentLaunchSpec,
    paths: &ProviderConfigPaths,
    bootstrap_root: &Path,
) -> Result<(), String> {
    prepare_fresh_provider_state_with_files_at(launch, paths, bootstrap_root, || Ok(()))
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

fn create_codex_home_if_absent(home: &Path) -> Result<Option<PathBuf>, String> {
    // Codex requires an explicitly configured CODEX_HOME to exist before
    // startup, even without config or credentials. Return only a new root
    // for ownership handoff; an existing native store keeps its identity.
    let codex_home = home.join(".codex");
    match std::fs::symlink_metadata(&codex_home) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(None),
        Ok(_) => Err("managed CODEX_HOME must be a physical directory".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir(&codex_home).map_err(|error| error.to_string())?;
            set_mode(&codex_home, 0o700)?;
            Ok(Some(codex_home))
        }
        Err(error) => Err(error.to_string()),
    }
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
    if provider == "codex" {
        paths.extend(create_codex_home_if_absent(home)?);
    }
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
    copy_environment_with_events_for_mounts(
        stage,
        provider,
        selections,
        destination,
        excluded,
        MountedResourceOptions {
            mounted_roots: &[],
            preserve_existing_mounted_files: &[],
        },
    )
}

#[derive(Clone, Copy)]
struct MountedResourceOptions<'a> {
    mounted_roots: &'a [PathBuf],
    preserve_existing_mounted_files: &'a [PathBuf],
}

fn copy_environment_with_events_for_mounts(
    stage: &str,
    provider: &str,
    selections: &[freshell_platform::provider_environment::CopySelection],
    destination: &Path,
    excluded: &[PathBuf],
    resource_options: MountedResourceOptions<'_>,
) -> Result<
    freshell_platform::provider_environment::CopyReport,
    freshell_platform::provider_environment::CopyError,
> {
    copy_environment_with_events_using(stage, provider, selections, || {
        freshell_platform::provider_environment::copy_environment_for_mounts_preserving_files(
            selections,
            destination,
            excluded,
            Default::default(),
            resource_options.mounted_roots,
            resource_options.preserve_existing_mounted_files,
        )
    })
}

fn copy_environment_with_events_excluding_subtree_for_mounts(
    stage: &str,
    provider: &str,
    selections: &[freshell_platform::provider_environment::CopySelection],
    destination: &Path,
    excluded: &[PathBuf],
    excluded_subtree: &Path,
    resource_options: MountedResourceOptions<'_>,
) -> Result<
    freshell_platform::provider_environment::CopyReport,
    freshell_platform::provider_environment::CopyError,
> {
    copy_environment_with_events_using(stage, provider, selections, || {
        freshell_platform::provider_environment::copy_environment_excluding_subtree_for_mounts_preserving_files(
            selections,
            destination,
            excluded,
            excluded_subtree,
            Default::default(),
            resource_options.mounted_roots,
            resource_options.preserve_existing_mounted_files,
        )
    })
}

fn copy_environment_with_events_using<F>(
    stage: &str,
    provider: &str,
    selections: &[freshell_platform::provider_environment::CopySelection],
    copy: F,
) -> Result<
    freshell_platform::provider_environment::CopyReport,
    freshell_platform::provider_environment::CopyError,
>
where
    F: FnOnce() -> Result<
        freshell_platform::provider_environment::CopyReport,
        freshell_platform::provider_environment::CopyError,
    >,
{
    let started = std::time::Instant::now();
    emit_environment_event(serde_json::json!({
        "severity": "info", "event": "provider.environment.copy.started",
        "stage": stage, "provider": provider, "selections": selections.len()
    }));
    let report = copy().inspect_err(|error| {
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

fn workspace_suffix_under_resource(resource_root: &Path, workspace: &Path) -> Option<PathBuf> {
    let suffix = workspace
        .strip_prefix(resource_root)
        .ok()
        .map(Path::to_path_buf)
        .or_else(|| {
            let resource_root = std::fs::canonicalize(resource_root).ok()?;
            let workspace = std::fs::canonicalize(workspace).ok()?;
            workspace
                .strip_prefix(resource_root)
                .ok()
                .map(Path::to_path_buf)
        })?;
    (!suffix.as_os_str().is_empty()).then(|| suffix.to_path_buf())
}

fn managed_provider_reference_alias_index(
    link: &Path,
    destination: &Path,
    provider_home: &Path,
) -> Option<u16> {
    fn normalized(path: &Path) -> Option<PathBuf> {
        if !path.is_absolute() {
            return None;
        }
        let mut result = PathBuf::new();
        for component in path.components() {
            match component {
                std::path::Component::RootDir => result.push("/"),
                std::path::Component::Normal(part) => result.push(part),
                std::path::Component::CurDir => {}
                std::path::Component::ParentDir => {
                    if !result.pop() || result.as_os_str().is_empty() {
                        return None;
                    }
                }
                std::path::Component::Prefix(_) => return None,
            }
        }
        Some(result)
    }

    fn index_under(path: &Path, root: &Path) -> Option<u16> {
        let suffix = path.strip_prefix(root).ok()?;
        let mut components = suffix.components();
        let index = match components.next()? {
            std::path::Component::Normal(value) => value.to_str()?.parse().ok()?,
            _ => return None,
        };
        components.next().is_none().then_some(index)
    }

    let target = if link.is_absolute() {
        normalized(link)?
    } else {
        let parent = std::fs::canonicalize(destination.parent()?).ok()?;
        normalized(&parent.join(link))?
    };
    let runtime_references = Path::new("/home/freshell/provider/.freshell/references");
    if let Some(index) = index_under(&target, runtime_references) {
        return Some(index);
    }
    let provider_home = std::fs::canonicalize(provider_home).ok()?;
    index_under(&target, &provider_home.join(".freshell/references"))
}

fn install_provider_resource_reference_aliases(
    context: &freshell_runtime_protocol::ProviderLaunchContext,
    provider_home: &Path,
) -> Result<(Vec<PathBuf>, Vec<PathBuf>), String> {
    use freshell_runtime_protocol::ProviderResourceKind;

    let mut installed = Vec::new();
    let mut removed = Vec::new();
    for mount in context
        .prepared_inputs
        .iter()
        .flat_map(|inputs| &inputs.resource_mounts)
    {
        if mount.reference_aliases.is_empty() && mount.retired_reference_aliases.is_empty() {
            continue;
        }
        if mount.kind != ProviderResourceKind::Directory {
            return Err("provider reference aliases require a directory resource".into());
        }
        let mount_relative = Path::new(&mount.provider_relative_path);
        if mount_relative.is_absolute()
            || mount_relative
                .components()
                .any(|part| !matches!(part, std::path::Component::Normal(_)))
        {
            return Err("provider reference alias mount path is unsafe".into());
        }
        let mount_root = provider_home.join(mount_relative);
        if !std::fs::metadata(&mount_root).is_ok_and(|metadata| metadata.is_dir()) {
            return Err("provider reference alias resource directory is unavailable".into());
        }
        let canonical_provider_home = std::fs::canonicalize(provider_home)
            .map_err(|_| "provider reference alias provider HOME is unavailable")?;
        let canonical_mount_root = std::fs::canonicalize(&mount_root)
            .map_err(|_| "provider reference alias resource directory is unavailable")?;
        if !canonical_mount_root.starts_with(&canonical_provider_home) {
            return Err("provider reference alias resource directory escapes provider HOME".into());
        }
        for retired in &mount.retired_reference_aliases {
            let relative = Path::new(retired);
            if relative.as_os_str().is_empty()
                || relative.is_absolute()
                || relative
                    .components()
                    .any(|part| !matches!(part, std::path::Component::Normal(_)))
            {
                return Err("retired provider reference alias path is unsafe".into());
            }
            let destination = mount_root.join(relative);
            let parent = destination
                .parent()
                .ok_or("retired provider reference alias has no parent directory")?;
            let canonical_parent = match std::fs::canonicalize(parent) {
                Ok(parent) => parent,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => {
                    return Err(
                        "retired provider reference alias parent directory is unavailable".into(),
                    )
                }
            };
            if !canonical_parent.starts_with(&canonical_mount_root) {
                return Err(
                    "retired provider reference alias parent directory escapes its resource".into(),
                );
            }
            match std::fs::symlink_metadata(&destination) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    let link = std::fs::read_link(&destination)
                        .map_err(|_| "retired provider reference alias could not be inspected")?;
                    if managed_provider_reference_alias_index(&link, &destination, provider_home)
                        .is_some()
                    {
                        std::fs::remove_file(&destination)
                            .map_err(|_| "retired provider reference alias could not be removed")?;
                        removed.push(PathBuf::from(&mount.provider_relative_path).join(relative));
                    }
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => {
                    return Err(
                        "retired provider reference alias path could not be inspected".into(),
                    )
                }
            }
        }
        for alias in &mount.reference_aliases {
            let relative = Path::new(&alias.relative_path);
            if relative.as_os_str().is_empty()
                || relative.is_absolute()
                || relative
                    .components()
                    .any(|part| !matches!(part, std::path::Component::Normal(_)))
            {
                return Err("provider reference alias path is unsafe".into());
            }
            let reference_relative =
                PathBuf::from(format!(".freshell/references/{}", alias.reference_index));
            let reference = provider_home.join(&reference_relative);
            if !std::fs::metadata(&reference).is_ok_and(|metadata| metadata.is_file()) {
                return Err("provider reference alias target is unavailable".into());
            }
            let destination = mount_root.join(relative);
            let parent = destination
                .parent()
                .ok_or("provider reference alias has no parent directory")?;
            if !std::fs::metadata(parent).is_ok_and(|metadata| metadata.is_dir()) {
                return Err("provider reference alias parent directory is unavailable".into());
            }
            let canonical_parent = std::fs::canonicalize(parent)
                .map_err(|_| "provider reference alias parent directory is unavailable")?;
            if !canonical_parent.starts_with(&canonical_mount_root) {
                return Err(
                    "provider reference alias parent directory escapes its resource".into(),
                );
            }
            let runtime_reference = PathBuf::from(format!(
                "/home/freshell/provider/.freshell/references/{}",
                alias.reference_index
            ));
            match std::fs::symlink_metadata(&destination) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    let link = std::fs::read_link(&destination)
                        .map_err(|_| "provider reference alias could not be inspected")?;
                    if link == runtime_reference {
                        installed.push(PathBuf::from(&mount.provider_relative_path).join(relative));
                        continue;
                    }
                    if managed_provider_reference_alias_index(&link, &destination, provider_home)
                        .is_some()
                    {
                        std::fs::remove_file(&destination)
                            .map_err(|_| "provider reference alias could not be replaced")?;
                        removed.push(PathBuf::from(&mount.provider_relative_path).join(relative));
                    } else {
                        return Err(
                            "provider reference alias conflicts with an existing link".into()
                        );
                    }
                }
                Ok(_) => {
                    return Err(
                        "provider reference alias would replace an existing resource".into(),
                    )
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err("provider reference alias path could not be inspected".into()),
            }

            std::os::unix::fs::symlink(&runtime_reference, &destination)
                .map_err(|_| "provider reference alias could not be created")?;
            installed.push(PathBuf::from(&mount.provider_relative_path).join(relative));
        }
    }
    Ok((installed, removed))
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderResourceReferenceAliasPlan {
    active: Vec<ProviderResourceReferenceAliasInstall>,
    retired: Vec<ProviderResourceReferenceAliasRetirement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderResourceReferenceAliasInstall {
    mount_root: String,
    relative_path: String,
    reference_index: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderResourceReferenceAliasRetirement {
    mount_root: String,
    relative_path: String,
}

impl ProviderResourceReferenceAliasInstall {
    fn provider_path(&self) -> PathBuf {
        Path::new(&self.mount_root).join(&self.relative_path)
    }
}

impl ProviderResourceReferenceAliasRetirement {
    fn provider_path(&self) -> PathBuf {
        Path::new(&self.mount_root).join(&self.relative_path)
    }
}

fn provider_resource_reference_alias_plan(
    context: &freshell_runtime_protocol::ProviderLaunchContext,
) -> Result<ProviderResourceReferenceAliasPlan, String> {
    use freshell_runtime_protocol::ProviderResourceKind;

    let mut plan = ProviderResourceReferenceAliasPlan::default();
    let mut paths = std::collections::BTreeSet::new();
    for mount in context
        .prepared_inputs
        .iter()
        .flat_map(|inputs| &inputs.resource_mounts)
    {
        if mount.reference_aliases.is_empty() && mount.retired_reference_aliases.is_empty() {
            continue;
        }
        if mount.kind != ProviderResourceKind::Directory {
            return Err("provider reference aliases require a directory resource".into());
        }
        for alias in &mount.reference_aliases {
            let path = Path::new(&alias.relative_path);
            if path.as_os_str().is_empty()
                || path.is_absolute()
                || path
                    .components()
                    .any(|part| !matches!(part, std::path::Component::Normal(_)))
            {
                return Err("provider reference alias path is unsafe".into());
            }
            let provider_path = Path::new(&mount.provider_relative_path).join(path);
            if !paths.insert(provider_path.to_string_lossy().into_owned()) {
                return Err("provider reference alias paths overlap".into());
            }
            plan.active.push(ProviderResourceReferenceAliasInstall {
                mount_root: mount.provider_relative_path.clone(),
                relative_path: alias.relative_path.clone(),
                reference_index: alias.reference_index,
            });
        }
        for relative in &mount.retired_reference_aliases {
            let path = Path::new(relative);
            if path.as_os_str().is_empty()
                || path.is_absolute()
                || path
                    .components()
                    .any(|part| !matches!(part, std::path::Component::Normal(_)))
            {
                return Err("provider reference alias path is unsafe".into());
            }
            let provider_path = Path::new(&mount.provider_relative_path).join(path);
            if !paths.insert(provider_path.to_string_lossy().into_owned()) {
                return Err("provider reference alias paths overlap".into());
            }
            plan.retired.push(ProviderResourceReferenceAliasRetirement {
                mount_root: mount.provider_relative_path.clone(),
                relative_path: relative.clone(),
            });
        }
    }
    plan.active.sort_by_key(|alias| alias.provider_path());
    plan.retired.sort_by_key(|alias| alias.provider_path());
    provider_resource_reference_alias_paths(&plan)?;
    Ok(plan)
}

fn provider_resource_reference_alias_paths(
    plan: &ProviderResourceReferenceAliasPlan,
) -> Result<std::collections::BTreeSet<String>, String> {
    let resource_roots = Path::new(".freshell/provider-roots");
    let mut paths = std::collections::BTreeSet::new();
    let mut parsed = Vec::new();
    for (mount_root, relative_path) in plan
        .active
        .iter()
        .map(|alias| (alias.mount_root.as_str(), alias.relative_path.as_str()))
        .chain(
            plan.retired
                .iter()
                .map(|alias| (alias.mount_root.as_str(), alias.relative_path.as_str())),
        )
    {
        let mount_root = Path::new(mount_root);
        let relative_path = Path::new(relative_path);
        let safe_relative = |path: &Path| {
            !path.as_os_str().is_empty()
                && !path.is_absolute()
                && path
                    .components()
                    .all(|part| matches!(part, std::path::Component::Normal(_)))
        };
        if !safe_relative(mount_root)
            || !mount_root.starts_with(resource_roots)
            || mount_root.components().count() <= resource_roots.components().count()
            || !safe_relative(relative_path)
        {
            return Err("provider reference alias metadata has an invalid path".into());
        }
        let path = mount_root.join(relative_path);
        let path = path
            .to_str()
            .ok_or("provider reference alias path is not UTF-8")?
            .to_owned();
        if !paths.insert(path.clone()) {
            return Err("provider reference alias paths overlap".into());
        }
        parsed.push(PathBuf::from(path));
    }
    for (index, path) in parsed.iter().enumerate() {
        if parsed
            .iter()
            .skip(index + 1)
            .any(|other| path != other && (path.starts_with(other) || other.starts_with(path)))
        {
            return Err("provider reference alias paths overlap".into());
        }
    }
    Ok(paths)
}

fn provider_reference_alias_overlaps_selected_paths(
    plan: &ProviderResourceReferenceAliasPlan,
    selected: &std::collections::BTreeSet<String>,
) -> bool {
    plan.active.iter().any(|alias| {
        let alias_path = alias.provider_path();
        selected
            .iter()
            .any(|path| Path::new(path).starts_with(&alias_path))
    })
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
    use freshell_platform::provider_environment::{
        copy_environment_excluding_subtree, CopySelection,
    };
    use freshell_runtime_protocol::ProviderConfigRoot;
    context.validate(provider).map_err(|error| error.message)?;
    let previous_projection = if provider == "opencode" && provider_home != final_home {
        Some(read_projection_manifest(final_home)?)
    } else {
        None
    };
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
                destination_relative: physical_provider_destination(
                    context,
                    &reference.provider_relative_path,
                ),
            }
        })
        .collect::<Vec<_>>();
    let config_selection_count = selections.len();
    let resource_mounts = context
        .prepared_inputs
        .iter()
        .flat_map(|inputs| &inputs.resource_mounts)
        .collect::<Vec<_>>();
    let mut recovered_writable_files = std::collections::BTreeMap::<PathBuf, PathBuf>::new();
    if let Some(previous) = previous_projection.as_ref() {
        for unit in &resource_mounts {
            let recovered =
                match nested_writable_file_recovery_source(context, unit, previous, final_home) {
                    Ok(recovered) => recovered,
                    Err(error) => {
                        emit_nested_writable_file_recovery_failure(provider, unit, error);
                        return Err(format!(
                            "provider resource {} ({}) could not be recovered: {}",
                            unit.provider_relative_path,
                            unit.stage_relative_path,
                            error.message()
                        ));
                    }
                };
            let Some(source) = recovered else {
                continue;
            };
            let identity = PathBuf::from(&unit.provider_relative_path);
            if recovered_writable_files
                .get(&identity)
                .is_some_and(|existing| existing != &source)
            {
                let error = NestedWritableFileRecoveryFailure::AmbiguousAliasSources;
                emit_nested_writable_file_recovery_failure(provider, unit, error);
                return Err(format!(
                    "provider resource {} ({}) could not be recovered: {}",
                    unit.provider_relative_path,
                    unit.stage_relative_path,
                    error.message()
                ));
            }
            recovered_writable_files.insert(identity, source);
        }
    }
    let mut resource_selections = Vec::new();
    for unit in resource_mounts {
        let staged_source = user_provider_root.join(&unit.stage_relative_path);
        let source = recovered_writable_files
            .get(Path::new(&unit.provider_relative_path))
            .cloned()
            .unwrap_or(staged_source);
        resource_selections.push(CopySelection {
            source,
            destination_relative: unit.provider_relative_path.clone().into(),
        });
    }
    selections.extend(resource_selections);
    let protected = private_bound_destinations(context);
    let mut excluded = provider_credential_sources(user_provider_root);
    // A prepared config leaf is the selected view of the raw file still held
    // by its complete resource directory. Copy that view at its typed physical
    // destination, retaining every other resource and the shared conflict policy.
    for config in &selections[..config_selection_count] {
        if !std::fs::metadata(&config.source).is_ok_and(|metadata| metadata.is_file()) {
            continue;
        }
        let Ok(selected_source) = std::fs::canonicalize(&config.source) else {
            continue;
        };
        for resource in &selections[config_selection_count..] {
            let Ok(suffix) = config
                .destination_relative
                .strip_prefix(&resource.destination_relative)
            else {
                continue;
            };
            if suffix.as_os_str().is_empty() {
                continue;
            }
            let original = resource.source.join(suffix);
            if !std::fs::metadata(&original).is_ok_and(|metadata| metadata.is_file()) {
                continue;
            }
            if let Ok(original) = std::fs::canonicalize(original) {
                if original != selected_source {
                    excluded.push(original);
                }
            }
        }
    }
    for selection in &selections {
        for relative in &protected {
            if let Ok(suffix) = Path::new(relative).strip_prefix(&selection.destination_relative) {
                if let Ok(source) = std::fs::canonicalize(selection.source.join(suffix)) {
                    excluded.push(source);
                }
            }
        }
    }
    let mut _filtered_resource_sources = Vec::new();
    let mut filtered_resource_sources = std::collections::BTreeMap::<PathBuf, PathBuf>::new();
    for (resource_index, unit) in context
        .prepared_inputs
        .iter()
        .flat_map(|inputs| &inputs.resource_mounts)
        .enumerate()
    {
        let resource_selection_index = config_selection_count + resource_index;
        let selection = selections
            .get_mut(resource_selection_index)
            .ok_or("provider resource selection is incomplete")?;
        if unit.kind != freshell_runtime_protocol::ProviderResourceKind::Directory {
            continue;
        }
        let Some(workspace_suffix) =
            workspace_suffix_under_resource(Path::new(&unit.logical_destination), workspace)
        else {
            continue;
        };
        let nested_workspace = selection.source.join(workspace_suffix);
        let Ok(canonical_nested_workspace) = std::fs::canonicalize(&nested_workspace) else {
            // A current controller stage has already filtered this subtree.
            continue;
        };
        let Ok(canonical_source) = std::fs::canonicalize(&selection.source) else {
            return Err("selected provider resource source is unavailable".into());
        };
        if canonical_nested_workspace == canonical_source {
            continue;
        }
        if let Some(filtered_source) = filtered_resource_sources.get(&canonical_source) {
            selection.source = filtered_source.clone();
            continue;
        }

        let scratch = tempfile::tempdir().map_err(|error| error.to_string())?;
        let destination_root = scratch.path().join("filtered-resource");
        let resource_source_leaf = selection
            .source
            .file_name()
            .map(|leaf| leaf.to_string_lossy().into_owned())
            .unwrap_or_default();
        let resource_destination_leaf = Path::new(&unit.logical_destination)
            .file_name()
            .map(|leaf| leaf.to_string_lossy().into_owned())
            .unwrap_or_default();
        let started = std::time::Instant::now();
        emit_environment_event(serde_json::json!({
            "severity": "info", "event": "provider.environment.copy.started",
            "stage": "session_host", "provider": provider,
            "resource_stage_path": unit.stage_relative_path,
            "resource_source_leaf": resource_source_leaf,
            "resource_destination_leaf": resource_destination_leaf
        }));
        let report = copy_environment_excluding_subtree(
            &[CopySelection {
                source: selection.source.clone(),
                destination_relative: "resource".into(),
            }],
            &destination_root,
            &excluded,
            &canonical_nested_workspace,
            Default::default(),
        );
        let report = match report {
            Ok(report) => report,
            Err(error) => {
                emit_environment_event(serde_json::json!({
                    "severity": "error", "event": "provider.environment.copy.failed",
                    "stage": "session_host", "provider": provider,
                    "operation": error.operation,
                    "relative_path": error.relative_path,
                    "resource_stage_path": unit.stage_relative_path,
                    "resource_source_leaf": resource_source_leaf,
                    "resource_destination_leaf": resource_destination_leaf,
                    "limit_kind": error.limit_kind, "observed": error.observed,
                    "permitted": error.permitted,
                    "elapsed_ms": started.elapsed().as_millis() as u64,
                    "corrective_message": error.corrective_message
                }));
                return Err(format!(
                    "failed to exclude workspace from provider resource: {error}"
                ));
            }
        };
        emit_environment_event(serde_json::json!({
            "severity": "info", "event": "provider.environment.copy.completed",
            "stage": "session_host", "provider": provider,
            "resource_stage_path": unit.stage_relative_path,
            "resource_source_leaf": resource_source_leaf,
            "resource_destination_leaf": resource_destination_leaf,
            "entries": report.entries, "bytes": report.bytes,
            "elapsed_ms": started.elapsed().as_millis() as u64
        }));
        selection.source = destination_root.join("resource");
        filtered_resource_sources.insert(canonical_source, selection.source.clone());
        _filtered_resource_sources.push(scratch);
    }
    for (resource_index, _) in context
        .prepared_inputs
        .iter()
        .flat_map(|inputs| &inputs.resource_mounts)
        .enumerate()
    {
        let resource_selection_index = config_selection_count + resource_index;
        let selection = selections
            .get_mut(resource_selection_index)
            .ok_or("provider resource selection is incomplete")?;
        if let Ok(canonical_source) = std::fs::canonicalize(&selection.source) {
            if let Some(filtered_source) = filtered_resource_sources.get(&canonical_source) {
                selection.source = filtered_source.clone();
            }
        }
    }
    let mounted = if provider_home == final_home {
        resource_mount_roots(context)
    } else {
        Vec::new()
    };
    let preserve_existing_mounted_files = if provider_home == final_home {
        let previous = read_projection_manifest(final_home)?;
        writable_resource_mount_roots(context)
            .into_iter()
            .filter(|path| {
                path.to_str()
                    .is_some_and(|relative| previous.contains(relative))
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let report = if matches!(provider, "opencode" | "codex") {
        copy_environment_with_events_excluding_subtree_for_mounts(
            "session_host",
            provider,
            &selections,
            provider_home,
            &excluded,
            workspace,
            MountedResourceOptions {
                mounted_roots: &mounted,
                preserve_existing_mounted_files: &preserve_existing_mounted_files,
            },
        )
    } else {
        copy_environment_with_events_for_mounts(
            "session_host",
            provider,
            &selections,
            provider_home,
            &excluded,
            MountedResourceOptions {
                mounted_roots: &mounted,
                preserve_existing_mounted_files: &preserve_existing_mounted_files,
            },
        )
    }
    .map_err(|error| error.to_string())?;
    let (reference_aliases, removed_reference_aliases) = if provider_home == final_home {
        install_provider_resource_reference_aliases(context, provider_home)?
    } else {
        (Vec::new(), Vec::new())
    };
    let mut projected = report
        .projected_paths
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect::<std::collections::BTreeSet<_>>();
    for path in removed_reference_aliases {
        projected.remove(&path.to_string_lossy().into_owned());
    }
    projected.extend(
        reference_aliases
            .iter()
            .map(|path| path.to_string_lossy().into_owned()),
    );
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

fn writable_resource_mount_roots(
    context: &freshell_runtime_protocol::ProviderLaunchContext,
) -> Vec<PathBuf> {
    context
        .prepared_inputs
        .iter()
        .flat_map(|inputs| &inputs.resource_mounts)
        .filter(|mount| {
            mount.kind == freshell_runtime_protocol::ProviderResourceKind::File && mount.writable
        })
        .map(|mount| PathBuf::from(&mount.provider_relative_path))
        .collect()
}

#[derive(Clone, Copy)]
enum NestedWritableFileRecoveryFailure {
    PriorStateUnavailable,
    PriorResourceDeleted,
    PriorResourceUnavailable,
    PriorResourceEscapedProjection,
    PriorResourceNotOwned,
    PriorResourceNotFile,
    AmbiguousDirectoryOwners,
    AmbiguousAliasSources,
}

impl NestedWritableFileRecoveryFailure {
    fn code(self) -> &'static str {
        match self {
            Self::PriorStateUnavailable => "prior_provider_state_unavailable",
            Self::PriorResourceDeleted => "prior_resource_deleted",
            Self::PriorResourceUnavailable => "prior_resource_unavailable",
            Self::PriorResourceEscapedProjection => "target_outside_projection",
            Self::PriorResourceNotOwned => "target_not_owned",
            Self::PriorResourceNotFile => "target_not_file",
            Self::AmbiguousDirectoryOwners => "ambiguous_directory_owners",
            Self::AmbiguousAliasSources => "ambiguous_alias_sources",
        }
    }

    fn message(self) -> &'static str {
        match self {
            Self::PriorStateUnavailable => "prior provider state is unavailable",
            Self::PriorResourceDeleted => "prior nested writable resource was deleted",
            Self::PriorResourceUnavailable => "prior nested writable resource is unavailable",
            Self::PriorResourceEscapedProjection => {
                "prior nested writable resource escaped provider state"
            }
            Self::PriorResourceNotOwned => "prior nested writable resource target is not owned",
            Self::PriorResourceNotFile => "prior nested writable resource is not a regular file",
            Self::AmbiguousDirectoryOwners => {
                "prior nested writable resource has ambiguous directory owners"
            }
            Self::AmbiguousAliasSources => {
                "resource aliases resolve to different prior runtime files"
            }
        }
    }
}

fn emit_nested_writable_file_recovery_failure(
    provider: &str,
    mount: &freshell_runtime_protocol::ProviderResourceMount,
    error: NestedWritableFileRecoveryFailure,
) {
    emit_environment_event(serde_json::json!({
        "severity": "error",
        "event": "provider.inputs.recovery.failed",
        "stage": "session_host",
        "provider": provider,
        "operation": "recover_nested_writable_file",
        "reason": error.code(),
        "resource_stage_path": mount.stage_relative_path,
        "provider_relative_path": mount.provider_relative_path,
        "corrective_message": "retain provider inputs and repair the resource selection before retrying"
    }));
}

fn nested_writable_file_recovery_source(
    context: &freshell_runtime_protocol::ProviderLaunchContext,
    mount: &freshell_runtime_protocol::ProviderResourceMount,
    previous: &std::collections::BTreeSet<String>,
    previous_home: &Path,
) -> Result<Option<PathBuf>, NestedWritableFileRecoveryFailure> {
    use freshell_runtime_protocol::ProviderResourceKind;
    if mount.kind != ProviderResourceKind::File || !mount.writable {
        return Ok(None);
    }
    let mount_relative = Path::new(&mount.provider_relative_path);
    if mount_relative.as_os_str().is_empty() || previous.contains(&mount.provider_relative_path) {
        return Ok(None);
    }
    let mount_destination = Path::new(&mount.effective_destination);
    if !mount_destination.is_absolute() {
        return Ok(None);
    }
    let canonical_home = std::fs::canonicalize(previous_home)
        .map_err(|_| NestedWritableFileRecoveryFailure::PriorStateUnavailable)?;
    let mut candidates = Vec::<(usize, PathBuf)>::new();
    for directory in context
        .prepared_inputs
        .iter()
        .flat_map(|inputs| &inputs.resource_mounts)
        .filter(|candidate| candidate.kind == ProviderResourceKind::Directory)
    {
        let directory_destination = Path::new(&directory.effective_destination);
        if !directory_destination.is_absolute() {
            continue;
        }
        let Ok(suffix) = mount_destination.strip_prefix(directory_destination) else {
            continue;
        };
        if suffix.as_os_str().is_empty() {
            continue;
        }
        let prior_relative = Path::new(&directory.provider_relative_path).join(suffix);
        let prior_text = prior_relative.to_string_lossy().into_owned();
        if !previous.contains(&prior_text) {
            continue;
        }
        let prior_path = previous_home.join(&prior_relative);
        let canonical = match std::fs::canonicalize(&prior_path) {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(NestedWritableFileRecoveryFailure::PriorResourceDeleted)
            }
            Err(_) => return Err(NestedWritableFileRecoveryFailure::PriorResourceUnavailable),
        };
        let canonical_relative = canonical
            .strip_prefix(&canonical_home)
            .map_err(|_| NestedWritableFileRecoveryFailure::PriorResourceEscapedProjection)?;
        if !previous.contains(&canonical_relative.to_string_lossy().into_owned()) {
            return Err(NestedWritableFileRecoveryFailure::PriorResourceNotOwned);
        }
        let metadata = std::fs::metadata(&canonical)
            .map_err(|_| NestedWritableFileRecoveryFailure::PriorResourceUnavailable)?;
        if !metadata.is_file() {
            return Err(NestedWritableFileRecoveryFailure::PriorResourceNotFile);
        }
        candidates.push((directory_destination.components().count(), canonical));
    }
    candidates.sort_by_key(|(depth, path)| (std::cmp::Reverse(*depth), path.clone()));
    let Some((depth, source)) = candidates.first().cloned() else {
        return Ok(None);
    };
    if candidates
        .iter()
        .skip(1)
        .take_while(|(candidate_depth, _)| *candidate_depth == depth)
        .any(|(_, candidate)| candidate != &source)
    {
        return Err(NestedWritableFileRecoveryFailure::AmbiguousDirectoryOwners);
    }
    Ok(Some(source))
}

// A resource's native HOME alias is a separate volume-subpath mount. Publish
// through its declared physical HOME path, where the transaction and journal
// share a filesystem. Every selected source still goes through the copier.
fn physical_provider_destination(
    context: &freshell_runtime_protocol::ProviderLaunchContext,
    relative: &str,
) -> PathBuf {
    use freshell_runtime_protocol::ProviderResourceKind;
    let destination = Path::new(relative);
    context
        .prepared_inputs
        .iter()
        .flat_map(|inputs| &inputs.resource_mounts)
        .filter_map(|unit| {
            let alias = Path::new(&unit.effective_destination)
                .strip_prefix("/home/freshell/provider")
                .ok()?;
            if alias.as_os_str().is_empty() {
                return None;
            }
            let suffix = destination.strip_prefix(alias).ok()?;
            if unit.kind == ProviderResourceKind::File && !suffix.as_os_str().is_empty() {
                return None;
            }
            Some((
                alias.components().count(),
                if suffix.as_os_str().is_empty() {
                    PathBuf::from(&unit.provider_relative_path)
                } else {
                    Path::new(&unit.provider_relative_path).join(suffix)
                },
            ))
        })
        .max_by_key(|(depth, _)| *depth)
        .map_or_else(|| destination.to_path_buf(), |(_, physical)| physical)
}

fn protected_resource_alias_entries(
    context: &freshell_runtime_protocol::ProviderLaunchContext,
    entries: &std::collections::BTreeSet<String>,
) -> Vec<String> {
    let aliases = context
        .prepared_inputs
        .iter()
        .flat_map(|inputs| &inputs.resource_mounts)
        .filter_map(|unit| {
            Path::new(&unit.effective_destination)
                .strip_prefix("/home/freshell/provider")
                .ok()
                .filter(|alias| !alias.as_os_str().is_empty())
        })
        .collect::<Vec<_>>();
    entries
        .iter()
        .filter(move |relative| {
            aliases
                .iter()
                .any(|alias| Path::new(relative).starts_with(alias))
        })
        .cloned()
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
const PROVIDER_PROJECTION_TRANSACTION_PREFIX: &str = ".freshell-provider-transaction-";
const PROVIDER_PROJECTION_TRANSACTION_JOURNAL: &str = "transaction.json";
const PROVIDER_PROJECTION_TRANSACTION_JOURNAL_TEMP: &str = "transaction.json.tmp";
const PROVIDER_PROJECTION_TRANSACTION_MANIFEST_BACKUP: &str = "manifest.backup";
// Ordinary disk metadata shares the resource-manifest profile. The control
// pipe's 1 MiB limit does not reduce these provider-filesystem views.
const MAX_PROJECTION_METADATA_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ProviderProjectionTransactionPhase {
    Preparing,
    Publishing,
    Committed,
    RolledBack,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum ProviderProjectionOriginalNode {
    Missing,
    File { in_place: bool },
    Directory { mode: u32 },
    Symlink,
    Other,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProviderProjectionTransactionEntry {
    relative: String,
    original: ProviderProjectionOriginalNode,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProviderProjectionTransactionJournal {
    version: u32,
    phase: ProviderProjectionTransactionPhase,
    manifest_existed: bool,
    entries: Vec<ProviderProjectionTransactionEntry>,
}

fn lock_provider_projection(provider_home: &Path) -> Result<std::fs::File, String> {
    use std::os::unix::fs::OpenOptionsExt;
    use std::os::unix::io::AsRawFd;

    let metadata = std::fs::symlink_metadata(provider_home)
        .map_err(|_| "provider projection HOME unavailable; retain inputs and repair")?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("provider projection HOME must be a physical directory".into());
    }
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(provider_home)
        .map_err(|_| "provider projection lock unavailable; retain inputs and repair")?;
    loop {
        let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
        if result == 0 {
            return Ok(file);
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::Interrupted {
            return Err(format!(
                "provider projection lock unavailable; retain inputs and repair: {error}"
            ));
        }
    }
}

#[derive(Debug)]
enum ProviderProjectionJournalWriteError {
    BeforePublish(String),
    PublishedButUnconfirmed(String),
}

impl std::fmt::Display for ProviderProjectionJournalWriteError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BeforePublish(cause) | Self::PublishedButUnconfirmed(cause) => {
                formatter.write_str(cause)
            }
        }
    }
}

fn write_provider_projection_transaction_journal(
    transaction: &Path,
    journal: &ProviderProjectionTransactionJournal,
) -> Result<(), ProviderProjectionJournalWriteError> {
    write_provider_projection_transaction_journal_with_sync(transaction, journal, |path| {
        std::fs::File::open(path)?.sync_all()
    })
}

fn write_provider_projection_transaction_journal_with_sync(
    transaction: &Path,
    journal: &ProviderProjectionTransactionJournal,
    sync_transaction_directory: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Result<(), ProviderProjectionJournalWriteError> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let bytes =
        freshell_runtime_protocol::bounded_json_bytes(journal, MAX_PROJECTION_METADATA_BYTES)
            .map_err(|_| {
                ProviderProjectionJournalWriteError::BeforePublish(
                    "provider transaction journal exceeds 64 MiB".into(),
                )
            })?;
    let temporary = transaction.join(PROVIDER_PROJECTION_TRANSACTION_JOURNAL_TEMP);
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|error| {
            ProviderProjectionJournalWriteError::BeforePublish(format!(
                "provider transaction journal stage unavailable: {error}"
            ))
        })?;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(|error| {
            ProviderProjectionJournalWriteError::BeforePublish(format!(
                "provider transaction journal write unavailable: {error}"
            ))
        })?;
    std::fs::rename(
        &temporary,
        transaction.join(PROVIDER_PROJECTION_TRANSACTION_JOURNAL),
    )
    .map_err(|error| {
        ProviderProjectionJournalWriteError::BeforePublish(format!(
            "provider transaction journal publish unavailable: {error}"
        ))
    })?;
    sync_transaction_directory(transaction).map_err(|error| {
        ProviderProjectionJournalWriteError::PublishedButUnconfirmed(format!(
            "provider transaction journal was published but its directory sync failed: {error}"
        ))
    })
}

fn provider_projection_relative_path(relative: &str) -> Result<&Path, String> {
    let path = Path::new(relative);
    if relative.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err("provider transaction contains an unsafe destination".into());
    }
    Ok(path)
}

fn provider_projection_original_node(
    home: &Path,
    relative: &str,
    in_place: bool,
) -> Result<ProviderProjectionOriginalNode, String> {
    use std::os::unix::fs::PermissionsExt;

    let path = provider_projection_relative_path(relative)?;
    match std::fs::symlink_metadata(home.join(path)) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(ProviderProjectionOriginalNode::Missing)
        }
        Err(_) => Err(format!(
            "provider transaction destination {relative} could not be inspected"
        )),
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Ok(ProviderProjectionOriginalNode::Symlink)
        }
        Ok(metadata) if metadata.is_file() => Ok(ProviderProjectionOriginalNode::File { in_place }),
        Ok(metadata) if metadata.is_dir() => Ok(ProviderProjectionOriginalNode::Directory {
            mode: metadata.permissions().mode() & 0o7777,
        }),
        Ok(_) => Ok(ProviderProjectionOriginalNode::Other),
    }
}

fn projection_transaction_path(transaction: &Path, relative: &str) -> Result<PathBuf, String> {
    Ok(transaction
        .join("backup")
        .join(provider_projection_relative_path(relative)?))
}

fn projection_path_parent_is_physical(home: &Path, relative: &Path) -> Result<(), String> {
    let mut parent = home.to_path_buf();
    for component in relative.parent().into_iter().flat_map(Path::components) {
        parent.push(component.as_os_str());
        match std::fs::symlink_metadata(&parent) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => {
                return Err("provider transaction destination parent is not a physical directory; retain inputs and repair".into())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(_) => {
                return Err("provider transaction destination parent unavailable; retain inputs and repair".into())
            }
        }
    }
    Ok(())
}

fn remove_provider_projection_node(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("provider transaction recovery destination unavailable".into()),
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            std::fs::remove_dir(path).map_err(|error| {
                format!("provider transaction recovery directory is not empty: {error}")
            })
        }
        Ok(_) => std::fs::remove_file(path)
            .map_err(|_| "provider transaction recovery destination could not be removed".into()),
    }
}

fn provider_projection_backup_exists(transaction: &Path, relative: &str) -> Result<bool, String> {
    let backup = projection_transaction_path(transaction, relative)?;
    match std::fs::symlink_metadata(&backup) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("provider transaction backup unavailable; retain inputs and repair".into()),
    }
}

fn sync_provider_projection_directory(path: &Path) -> Result<(), String> {
    std::fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| {
            format!(
                "provider projection directory flush failed for {}: {error}",
                path.display()
            )
        })
}

fn sync_provider_projection_tree(root: &Path) -> Result<(), String> {
    sync_provider_projection_tree_with(root, &|path| std::fs::File::open(path)?.sync_all())
}

/// Concurrent flushes per projection durability barrier. Every flush is one
/// journal commit when issued alone; overlapping flushes of independent nodes
/// let the filesystem commit them together, so a selected environment with
/// thousands of files (an installed plugin's node_modules) costs a handful of
/// commits instead of one per file. Measured on the qualification host's
/// ext4 volume, 4,200 files took 13.4 s one at a time and 1.4 s at 16.
const PROVIDER_PROJECTION_SYNC_WORKERS: usize = 16;

/// Make every node of a staged projection durable before the transaction
/// advances. Symlinks are never followed. Each node is still flushed exactly
/// once with a full `fsync`; only their order is relaxed, which the
/// transaction does not depend on because it waits for the whole barrier.
fn sync_provider_projection_tree_with(
    root: &Path,
    sync_node: &(impl Fn(&Path) -> std::io::Result<()> + Sync),
) -> Result<(), String> {
    let mut nodes = Vec::new();
    collect_provider_projection_sync_nodes(root, &mut nodes)?;
    flush_provider_projection_nodes(&nodes, sync_node)
}

fn collect_provider_projection_sync_nodes(
    root: &Path,
    nodes: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(root).map_err(|error| {
        format!(
            "provider projection sync inspect {}: {error}",
            root.display()
        )
    })?;
    if metadata.file_type().is_symlink() {
        return Ok(());
    }
    if metadata.is_dir() {
        for entry in std::fs::read_dir(root)
            .map_err(|error| format!("provider projection sync read {}: {error}", root.display()))?
        {
            let entry = entry.map_err(|error| {
                format!("provider projection sync read {}: {error}", root.display())
            })?;
            collect_provider_projection_sync_nodes(&entry.path(), nodes)?;
        }
    }
    nodes.push(root.to_path_buf());
    Ok(())
}

fn flush_provider_projection_nodes(
    nodes: &[PathBuf],
    sync_node: &(impl Fn(&Path) -> std::io::Result<()> + Sync),
) -> Result<(), String> {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    let next = AtomicUsize::new(0);
    let failed = AtomicBool::new(false);
    let failure = std::sync::Mutex::new(None::<String>);
    let flush = || {
        while !failed.load(Ordering::Acquire) {
            let Some(path) = nodes.get(next.fetch_add(1, Ordering::Relaxed)) else {
                return;
            };
            if let Err(error) = sync_node(path) {
                failed.store(true, Ordering::Release);
                failure
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .get_or_insert_with(|| {
                        format!(
                            "provider projection flush failed for {}: {error}",
                            path.display()
                        )
                    });
                return;
            }
        }
    };
    std::thread::scope(|scope| {
        // The calling thread always takes part, so the barrier completes even
        // when the container's pid budget refuses additional threads.
        for _ in 1..PROVIDER_PROJECTION_SYNC_WORKERS.min(nodes.len()) {
            if std::thread::Builder::new()
                .name("projection-sync".into())
                .spawn_scoped(scope, flush)
                .is_err()
            {
                break;
            }
        }
        flush();
    });
    match failure
        .into_inner()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
    {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

fn sync_provider_projection_file(path: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        format!(
            "provider projection sync inspect {}: {error}",
            path.display()
        )
    })?;
    if metadata.is_file() && !metadata.file_type().is_symlink() {
        std::fs::File::open(path)
            .and_then(|file| file.sync_all())
            .map_err(|error| {
                format!(
                    "provider projection file flush failed for {}: {error}",
                    path.display()
                )
            })?;
    }
    Ok(())
}

fn sync_provider_projection_directories(
    home: &Path,
    entries: &[ProviderProjectionTransactionEntry],
) -> Result<(), String> {
    use std::collections::BTreeSet;

    let mut directories = BTreeSet::new();
    directories.insert(home.to_path_buf());
    for entry in entries {
        let relative = provider_projection_relative_path(&entry.relative)?;
        let mut candidate = home.join(relative);
        loop {
            if let Ok(metadata) = std::fs::symlink_metadata(&candidate) {
                if metadata.is_dir() && !metadata.file_type().is_symlink() {
                    directories.insert(candidate.clone());
                }
            }
            if candidate == home {
                break;
            }
            let Some(parent) = candidate.parent() else {
                break;
            };
            if !parent.starts_with(home) {
                break;
            }
            candidate = parent.to_path_buf();
        }
    }
    for directory in directories {
        sync_provider_projection_directory(&directory)?;
    }
    Ok(())
}

fn restore_provider_projection_manifest(
    transaction: &Path,
    home: &Path,
    manifest_existed: bool,
) -> Result<(), String> {
    use std::io::Write;

    let destination = home.join(PROVIDER_PROJECTION_MANIFEST);
    if !manifest_existed {
        match std::fs::symlink_metadata(&destination) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                std::fs::remove_file(destination)
                    .map_err(|_| "provider projection manifest rollback failed; retain inputs and repair".to_owned())?;
                sync_provider_projection_directory(home)
                    .map_err(|_| "provider projection manifest rollback sync unavailable".to_owned())?;
                return Ok(());
            }
            _ => return Err("provider projection manifest rollback found an unsafe path; retain inputs and repair".into()),
        }
    }
    let bytes = crate::provider_input_preparation::read_private(
        transaction,
        PROVIDER_PROJECTION_TRANSACTION_MANIFEST_BACKUP,
        MAX_PROJECTION_METADATA_BYTES,
    )
    .map_err(|_| "provider projection manifest backup unavailable; retain inputs and repair")?;
    if let Ok(metadata) = std::fs::symlink_metadata(&destination) {
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err("provider projection manifest rollback found an unsafe path; retain inputs and repair".into());
        }
    }
    let mut temporary = tempfile::Builder::new()
        .prefix(".freshell-provider-manifest-restore-")
        .tempfile_in(home)
        .map_err(|_| "provider projection manifest rollback stage unavailable")?;
    temporary
        .write_all(&bytes)
        .and_then(|()| temporary.as_file().sync_all())
        .map_err(|_| "provider projection manifest rollback write unavailable")?;
    temporary
        .persist(&destination)
        .map_err(|_| "provider projection manifest rollback publish unavailable")?;
    sync_provider_projection_directory(home)
        .map_err(|_| "provider projection manifest rollback sync unavailable")?;
    Ok(())
}

fn recover_provider_projection_transaction(
    transaction: &Path,
    home: &Path,
    journal: &ProviderProjectionTransactionJournal,
) -> Result<(), String> {
    use std::{collections::BTreeSet, fs, os::unix::fs::PermissionsExt};

    if journal.version != 1 {
        return Err(
            "provider transaction journal version is unsupported; retain inputs and repair".into(),
        );
    }
    let mut seen = BTreeSet::new();
    for entry in &journal.entries {
        provider_projection_relative_path(&entry.relative)?;
        if !seen.insert(entry.relative.as_str()) {
            return Err(
                "provider transaction journal has duplicate destinations; retain inputs and repair"
                    .into(),
            );
        }
    }
    let mut entries = journal.entries.iter().collect::<Vec<_>>();
    entries.sort_by_key(|entry| {
        std::cmp::Reverse(
            provider_projection_relative_path(&entry.relative)
                .map(|path| path.components().count())
                .unwrap_or(0),
        )
    });

    // A prior directory can now be an installed file. Remove those replacement
    // leaves before walking deeper entries, since their former children have a
    // non-directory parent until the old directory is rebuilt below.
    let mut replaced_directories = journal
        .entries
        .iter()
        .filter(|entry| {
            matches!(
                entry.original,
                ProviderProjectionOriginalNode::Directory { .. }
            )
        })
        .collect::<Vec<_>>();
    replaced_directories.sort_by_key(|entry| {
        provider_projection_relative_path(&entry.relative)
            .map(|path| path.components().count())
            .unwrap_or(usize::MAX)
    });
    for entry in replaced_directories {
        let relative = provider_projection_relative_path(&entry.relative)?;
        projection_path_parent_is_physical(home, relative)?;
        let destination = home.join(relative);
        if let Ok(metadata) = fs::symlink_metadata(&destination) {
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                remove_provider_projection_node(&destination)?;
            }
        }
    }

    // Remove paths that did not exist before publication and clear new file
    // nodes that replaced old directories. Only empty directories are removed;
    // an unexpected provider-created descendant leaves recovery fail-closed.
    for entry in &entries {
        let relative = provider_projection_relative_path(&entry.relative)?;
        projection_path_parent_is_physical(home, relative)?;
        let path = home.join(relative);
        match entry.original {
            ProviderProjectionOriginalNode::Missing => remove_provider_projection_node(&path)?,
            ProviderProjectionOriginalNode::Directory { .. } => {}
            ProviderProjectionOriginalNode::File { .. }
            | ProviderProjectionOriginalNode::Symlink
            | ProviderProjectionOriginalNode::Other => {
                if provider_projection_backup_exists(transaction, &entry.relative)?
                    && fs::symlink_metadata(&path).is_ok_and(|metadata| {
                        metadata.is_dir() && !metadata.file_type().is_symlink()
                    })
                {
                    remove_provider_projection_node(&path)?;
                }
            }
        }
    }

    // Parent directories must exist before backed-up files are restored. Their
    // recorded modes also undo the publication's temporary 0700 directory mode.
    let mut directories = journal
        .entries
        .iter()
        .filter_map(|entry| {
            if let ProviderProjectionOriginalNode::Directory { mode } = entry.original {
                Some((entry, mode))
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    directories.sort_by_key(|(entry, _)| {
        provider_projection_relative_path(&entry.relative)
            .map(|path| path.components().count())
            .unwrap_or(usize::MAX)
    });
    for (entry, mode) in directories {
        let relative = provider_projection_relative_path(&entry.relative)?;
        projection_path_parent_is_physical(home, relative)?;
        let destination = home.join(relative);
        match fs::symlink_metadata(&destination) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&destination)
                    .map_err(|_| "provider transaction recovery directory could not be restored")?;
            }
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            _ => return Err("provider transaction recovery directory has an unsafe type; retain inputs and repair".into()),
        }
        fs::set_permissions(destination, fs::Permissions::from_mode(mode))
            .map_err(|_| "provider transaction recovery directory mode could not be restored")?;
    }

    for entry in &journal.entries {
        let relative = provider_projection_relative_path(&entry.relative)?;
        projection_path_parent_is_physical(home, relative)?;
        let destination = home.join(relative);
        let backup = projection_transaction_path(transaction, &entry.relative)?;
        let has_backup = provider_projection_backup_exists(transaction, &entry.relative)?;
        match entry.original {
            ProviderProjectionOriginalNode::Missing => {}
            ProviderProjectionOriginalNode::Directory { .. } => {}
            ProviderProjectionOriginalNode::File { in_place } if has_backup => {
                if in_place {
                    let metadata = fs::symlink_metadata(&destination).map_err(|_| {
                        "provider mounted projection file disappeared during recovery"
                    })?;
                    if !metadata.is_file() || metadata.file_type().is_symlink() {
                        return Err(
                            "provider mounted projection file has an unsafe type during recovery"
                                .into(),
                        );
                    }
                    replace_mounted_projection_file(&backup, &destination)?;
                } else {
                    if fs::symlink_metadata(&destination).is_ok_and(|metadata| {
                        metadata.is_dir() && !metadata.file_type().is_symlink()
                    }) {
                        remove_provider_projection_node(&destination)?;
                    }
                    fs::rename(&backup, &destination)
                        .map_err(|_| "provider transaction file backup could not be restored; retain inputs and repair")?;
                }
            }
            ProviderProjectionOriginalNode::File { in_place: true } => {
                return Err(
                    "provider mounted projection backup is missing; retain inputs and repair"
                        .into(),
                )
            }
            ProviderProjectionOriginalNode::File { in_place: false } => {
                let metadata = fs::symlink_metadata(&destination).map_err(|_| {
                    "provider transaction original file is missing; retain inputs and repair"
                })?;
                if !metadata.is_file() || metadata.file_type().is_symlink() {
                    return Err("provider transaction original file has an unsafe type; retain inputs and repair".into());
                }
            }
            ProviderProjectionOriginalNode::Symlink if has_backup => {
                fs::rename(&backup, &destination)
                    .map_err(|_| "provider transaction link backup could not be restored; retain inputs and repair")?;
            }
            ProviderProjectionOriginalNode::Symlink => {
                if !fs::symlink_metadata(&destination)
                    .is_ok_and(|metadata| metadata.file_type().is_symlink())
                {
                    return Err(
                        "provider transaction original link is missing; retain inputs and repair"
                            .into(),
                    );
                }
            }
            ProviderProjectionOriginalNode::Other if has_backup => {
                fs::rename(&backup, &destination)
                    .map_err(|_| "provider transaction node backup could not be restored; retain inputs and repair")?;
            }
            ProviderProjectionOriginalNode::Other => {
                if fs::symlink_metadata(&destination).is_err() {
                    return Err(
                        "provider transaction original node is missing; retain inputs and repair"
                            .into(),
                    );
                }
            }
        }
    }
    restore_provider_projection_manifest(transaction, home, journal.manifest_existed)?;
    sync_provider_projection_directories(home, &journal.entries)?;
    sync_provider_projection_tree(&transaction.join("backup"))?;
    let mut rolled_back = journal.clone();
    rolled_back.phase = ProviderProjectionTransactionPhase::RolledBack;
    write_provider_projection_transaction_journal(transaction, &rolled_back)
        .map_err(|error| format!("provider rollback completion could not be recorded: {error}"))?;
    Ok(())
}

fn cleanup_provider_projection_transaction(
    transaction: &Path,
    provider_home: &Path,
    expected_phase: ProviderProjectionTransactionPhase,
) -> Result<(), String> {
    use std::fs;

    let journal_path = transaction.join(PROVIDER_PROJECTION_TRANSACTION_JOURNAL);
    let bytes = crate::provider_input_preparation::read_private(
        transaction,
        PROVIDER_PROJECTION_TRANSACTION_JOURNAL,
        MAX_PROJECTION_METADATA_BYTES,
    )
    .map_err(|_| "provider transaction cleanup journal unavailable; retain inputs and repair")?;
    let journal: ProviderProjectionTransactionJournal = serde_json::from_slice(&bytes)
        .map_err(|_| "provider transaction cleanup journal invalid; retain inputs and repair")?;
    if journal.phase != expected_phase
        || !matches!(
            journal.phase,
            ProviderProjectionTransactionPhase::Preparing
                | ProviderProjectionTransactionPhase::Committed
                | ProviderProjectionTransactionPhase::RolledBack
        )
    {
        return Err(
            "provider transaction cleanup phase is not durable; retain inputs and repair".into(),
        );
    }

    for entry in fs::read_dir(transaction).map_err(|_| {
        "provider transaction cleanup inventory unavailable; retain inputs and repair"
    })? {
        let entry = entry.map_err(|_| {
            "provider transaction cleanup inventory unavailable; retain inputs and repair"
        })?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name == PROVIDER_PROJECTION_TRANSACTION_JOURNAL {
            continue;
        }
        if name != "desired"
            && name != "backup"
            && name != PROVIDER_PROJECTION_TRANSACTION_MANIFEST_BACKUP
            && name != PROVIDER_PROJECTION_MANIFEST
            && name != PROVIDER_PROJECTION_TRANSACTION_JOURNAL_TEMP
            && !name.starts_with(".freshell-config-projection-")
        {
            return Err(format!(
                "unexpected provider transaction cleanup entry {}; retain inputs and repair",
                entry.path().display()
            ));
        }
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|_| {
            "provider transaction cleanup entry could not be inspected; retain inputs and repair"
        })?;
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            fs::remove_dir_all(&path).map_err(|_| {
                "provider transaction payload cleanup failed; retain inputs and repair"
            })?;
        } else {
            fs::remove_file(&path).map_err(|_| {
                "provider transaction payload cleanup failed; retain inputs and repair"
            })?;
        }
    }

    // Keep the phase record until every backup and staged input deletion is
    // durable. Recovery can then repeat cleanup without trying to replay it.
    sync_provider_projection_directory(transaction)?;
    fs::remove_file(&journal_path)
        .map_err(|_| "provider transaction journal cleanup failed; retain inputs and repair")?;
    sync_provider_projection_directory(transaction)?;
    fs::remove_dir(transaction)
        .map_err(|_| "provider transaction directory cleanup failed; retain inputs and repair")?;
    sync_provider_projection_directory(provider_home)?;
    Ok(())
}

fn cleanup_orphaned_provider_refresh_stages(
    provider_home: &Path,
    preserved_stage: Option<&Path>,
) -> Result<(), String> {
    use std::fs;

    let mut removed = false;
    for entry in fs::read_dir(provider_home)
        .map_err(|_| "provider refresh stage inventory unavailable; retain inputs and repair")?
    {
        let entry = entry.map_err(|_| {
            "provider refresh stage inventory unavailable; retain inputs and repair"
        })?;
        if !entry
            .file_name()
            .to_string_lossy()
            .starts_with(".freshell-provider-refresh-")
            || preserved_stage.is_some_and(|stage| stage == entry.path())
        {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path()).map_err(|_| {
            "provider refresh stage could not be inspected; retain inputs and repair"
        })?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(
                "provider refresh stage has an unsafe type; retain inputs and repair".into(),
            );
        }
        fs::remove_dir_all(entry.path()).map_err(|_| {
            "orphaned provider refresh stage cleanup failed; retain inputs and repair"
        })?;
        removed = true;
    }
    if removed {
        sync_provider_projection_directory(provider_home)?;
    }
    Ok(())
}

fn recover_provider_projection_transactions(provider_home: &Path) -> Result<(), String> {
    let result = recover_provider_projection_transactions_inner(provider_home);
    if let Err(cause) = &result {
        emit_environment_event(serde_json::json!({
            "severity": "error",
            "event": "provider.projection.transaction.recovery_failed",
            "stage": "recovery",
            "cause": cause,
        }));
    }
    result
}

fn recover_provider_projection_transactions_inner(provider_home: &Path) -> Result<(), String> {
    let mut transactions = Vec::new();
    for entry in std::fs::read_dir(provider_home).map_err(|_| {
        "provider projection HOME unavailable during recovery; retain inputs and repair"
    })? {
        let entry = entry
            .map_err(|_| "provider transaction inventory unavailable; retain inputs and repair")?;
        let name = entry.file_name();
        if !name
            .to_string_lossy()
            .starts_with(PROVIDER_PROJECTION_TRANSACTION_PREFIX)
        {
            continue;
        }
        let metadata = std::fs::symlink_metadata(entry.path())
            .map_err(|_| "provider transaction could not be inspected; retain inputs and repair")?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(
                "provider transaction path has an unsafe type; retain inputs and repair".into(),
            );
        }
        transactions.push(entry.path());
    }
    transactions.sort();

    let mut publishing = Vec::new();
    for transaction in &transactions {
        let journal_path = transaction.join(PROVIDER_PROJECTION_TRANSACTION_JOURNAL);
        let bytes = match crate::provider_input_preparation::read_private(
            transaction,
            PROVIDER_PROJECTION_TRANSACTION_JOURNAL,
            MAX_PROJECTION_METADATA_BYTES,
        ) {
            Ok(bytes) => Some(bytes),
            Err(_) if !journal_path.exists() => None,
            Err(_) => {
                return Err("provider transaction journal invalid; retain inputs and repair".into())
            }
        };
        let Some(bytes) = bytes else {
            let mut contents = std::fs::read_dir(transaction).map_err(|_| {
                "provider transaction inventory unavailable; retain inputs and repair"
            })?;
            let safe_initial_stage = contents.by_ref().all(|entry| {
                let Ok(entry) = entry else { return false };
                if entry.file_name() != PROVIDER_PROJECTION_TRANSACTION_JOURNAL_TEMP {
                    return false;
                }
                std::fs::symlink_metadata(entry.path())
                    .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
            });
            if !safe_initial_stage {
                return Err(
                    "unrecognized provider transaction remains; retain inputs and repair".into(),
                );
            }
            if transaction
                .join(PROVIDER_PROJECTION_TRANSACTION_JOURNAL_TEMP)
                .exists()
            {
                std::fs::remove_file(
                    transaction.join(PROVIDER_PROJECTION_TRANSACTION_JOURNAL_TEMP),
                )
                .map_err(|_| {
                    "provider initial transaction stage cleanup failed; retain inputs and repair"
                })?;
            }
            std::fs::remove_dir(transaction).map_err(|_| {
                "provider initial transaction stage cleanup failed; retain inputs and repair"
            })?;
            sync_provider_projection_directory(provider_home)?;
            continue;
        };
        let journal: ProviderProjectionTransactionJournal = serde_json::from_slice(&bytes)
            .map_err(|_| "provider transaction journal invalid; retain inputs and repair")?;
        if journal.version != 1 {
            return Err(
                "provider transaction journal version is unsupported; retain inputs and repair"
                    .into(),
            );
        }
        match journal.phase {
            ProviderProjectionTransactionPhase::Preparing => {
                cleanup_provider_projection_transaction(
                    transaction,
                    provider_home,
                    ProviderProjectionTransactionPhase::Preparing,
                )?;
            }
            ProviderProjectionTransactionPhase::Committed
            | ProviderProjectionTransactionPhase::RolledBack => {
                // A visible commit/rollback journal is not a confirmed state
                // until its containing directory flush succeeds. Retry that
                // flush before deleting the backups that make the phase safe.
                sync_provider_projection_directory(transaction)?;
                cleanup_provider_projection_transaction(transaction, provider_home, journal.phase)?;
            }
            ProviderProjectionTransactionPhase::Publishing => {
                publishing.push((transaction, journal))
            }
        }
    }
    if publishing.len() > 1 {
        return Err(
            "multiple interrupted provider publications require repair; retain inputs".into(),
        );
    }
    if let Some((transaction, journal)) = publishing.pop() {
        emit_environment_event(
            serde_json::json!({"severity":"warn","event":"provider.projection.transaction.recovery_started","stage":"recovery","transaction":transaction.file_name().and_then(|name| name.to_str())}),
        );
        recover_provider_projection_transaction(transaction, provider_home, &journal)?;
        cleanup_provider_projection_transaction(
            transaction,
            provider_home,
            ProviderProjectionTransactionPhase::RolledBack,
        )?;
        emit_environment_event(
            serde_json::json!({"severity":"info","event":"provider.projection.transaction.recovered","stage":"recovery"}),
        );
    }
    Ok(())
}

fn read_projection_metadata(root: &Path, relative: &str) -> Result<Option<Vec<u8>>, String> {
    match std::fs::symlink_metadata(root.join(relative)) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err("provider projection metadata unavailable; retain inputs and repair".into())
        }
        Ok(_) => {}
    }
    crate::provider_input_preparation::read_private(root, relative, MAX_PROJECTION_METADATA_BYTES)
        .map(Some)
        .map_err(|reason| {
            tracing::warn!(event="provider.inputs.projection_metadata.blocked",stage="session_host",
                operation="read",relative_path=relative,permitted_bytes=MAX_PROJECTION_METADATA_BYTES,
                cause=%reason,"Provider projection metadata unavailable or exceeds its profile");
            format!("provider projection metadata {relative}: {reason} (64 MiB limit); retain inputs and repair")
        })
}

fn write_projection_manifest(
    provider_home: &Path,
    entries: &std::collections::BTreeSet<String>,
) -> Result<PathBuf, String> {
    use std::io::Write;
    let manifest = provider_home.join(PROVIDER_PROJECTION_MANIFEST);
    let bytes =
        freshell_runtime_protocol::bounded_json_bytes(entries, MAX_PROJECTION_METADATA_BYTES)
            .map_err(|_| {
                tracing::warn!(
                    event = "provider.inputs.projection_metadata.blocked",
                    stage = "session_host",
                    operation = "serialize",
                    relative_path = PROVIDER_PROJECTION_MANIFEST,
                    permitted_bytes = MAX_PROJECTION_METADATA_BYTES,
                    "Provider projection metadata exceeds its profile"
                );
                "provider projection metadata exceeds 64 MiB; retain inputs and repair".to_owned()
            })?;
    let published: Result<(), std::io::Error> = (|| {
        // Keep incomplete metadata private and remove it on every write or
        // rename failure. Only the complete file replaces the prior manifest.
        let mut temporary = tempfile::Builder::new()
            .prefix(".freshell-config-projection-")
            .tempfile_in(provider_home)?;
        temporary.write_all(&bytes)?;
        temporary.as_file().sync_all()?;
        temporary.persist(&manifest).map_err(|error| error.error)?;
        #[cfg(unix)]
        std::fs::File::open(provider_home)?.sync_all()?;
        Ok(())
    })();
    published.map_err(|cause| {
        tracing::warn!(event="provider.inputs.projection_metadata.blocked",stage="session_host",
            operation="publish",relative_path=PROVIDER_PROJECTION_MANIFEST,cause=%cause,
            "Provider projection metadata publication failed; retain inputs and repair");
        format!(
            "provider projection metadata publication failed: {cause}; retain inputs and repair"
        )
    })?;
    Ok(manifest)
}

fn read_projection_manifest(
    provider_home: &Path,
) -> Result<std::collections::BTreeSet<String>, String> {
    match read_projection_metadata(provider_home, PROVIDER_PROJECTION_MANIFEST)? {
        Some(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| "provider projection metadata invalid".into()),
        None => Ok(Default::default()),
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
    let user_root = prepare_provider_input_mount(context, paths)?;
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
    if run_as_uid != unsafe { libc::geteuid() } || run_as_gid != unsafe { libc::getegid() } {
        return refresh_provider_config_as_provider(
            context,
            provider,
            workspace,
            user_provider_root,
            provider_home,
            run_as_uid,
            run_as_gid,
        );
    }
    refresh_provider_config_with_mounted_context(
        context,
        context,
        provider,
        workspace,
        user_provider_root,
        provider_home,
    )
}

fn refresh_provider_config_with_mounted_context(
    context: &freshell_runtime_protocol::ProviderLaunchContext,
    mounted_context: &freshell_runtime_protocol::ProviderLaunchContext,
    provider: &str,
    workspace: &Path,
    user_provider_root: &Path,
    provider_home: &Path,
) -> Result<(), String> {
    context.validate(provider).map_err(|error| error.message)?;
    mounted_context
        .validate(provider)
        .map_err(|error| error.message)?;
    let _projection_lock = lock_provider_projection(provider_home)?;
    recover_provider_projection_transactions(provider_home)?;
    cleanup_orphaned_provider_refresh_stages(provider_home, None)?;
    let stage = tempfile::Builder::new()
        .prefix(".freshell-provider-refresh-")
        .tempdir_in(provider_home)
        .map_err(|error| error.to_string())?;
    refresh_provider_config_in_stage_locked(
        context,
        mounted_context,
        provider,
        workspace,
        user_provider_root,
        provider_home,
        stage,
    )
}

#[cfg(test)]
fn refresh_provider_config_in_stage(
    context: &freshell_runtime_protocol::ProviderLaunchContext,
    provider: &str,
    workspace: &Path,
    user_provider_root: &Path,
    provider_home: &Path,
    stage: tempfile::TempDir,
) -> Result<(), String> {
    let _projection_lock = lock_provider_projection(provider_home)?;
    recover_provider_projection_transactions(provider_home)?;
    cleanup_orphaned_provider_refresh_stages(provider_home, Some(stage.path()))?;
    refresh_provider_config_in_stage_locked(
        context,
        context,
        provider,
        workspace,
        user_provider_root,
        provider_home,
        stage,
    )
}

fn refresh_provider_config_in_stage_locked(
    context: &freshell_runtime_protocol::ProviderLaunchContext,
    mounted_context: &freshell_runtime_protocol::ProviderLaunchContext,
    provider: &str,
    workspace: &Path,
    user_provider_root: &Path,
    provider_home: &Path,
    stage: tempfile::TempDir,
) -> Result<(), String> {
    let projection = stage.path().join("projection");
    // This is a new private tree. Let the copier publish it as one root;
    // precreating it selects per-leaf durable replacement of an existing HOME.
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
        .map(|reference| {
            physical_provider_destination(context, &reference.provider_relative_path)
                .to_string_lossy()
                .into_owned()
        })
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
        freshell_runtime_protocol::bounded_json_bytes(&destinations, MAX_PROJECTION_METADATA_BYTES)
            .map_err(|_| "provider projection destinations exceed 64 MiB")?,
    )
    .map_err(|error| error.to_string())?;
    std::fs::write(
        stage.path().join("provider.json"),
        freshell_runtime_protocol::bounded_json_bytes(&provider, MAX_PROJECTION_METADATA_BYTES)
            .map_err(|_| "provider projection identity exceeds 64 MiB")?,
    )
    .map_err(|error| error.to_string())?;
    // Legacy manifests may name native aliases. Those entries confer no stale
    // removal authority across a mount boundary; retain their files and inodes.
    // Store only exact protected entries in the existing bounded metadata.
    let mut protected = private_bound_destinations(context);
    let previous = read_projection_manifest(provider_home)?;
    let current = read_projection_manifest(&projection)?;
    let preserved_writable_files = writable_resource_mount_roots(context)
        .into_iter()
        .filter(|path| {
            path.to_str()
                .is_some_and(|relative| previous.contains(relative))
        })
        .map(|path| path.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    protected.extend(protected_resource_alias_entries(context, &previous));
    protected.extend(protected_resource_alias_entries(context, &current));
    std::fs::write(
        stage.path().join("private-mountpoints.json"),
        freshell_runtime_protocol::bounded_json_bytes(&protected, MAX_PROJECTION_METADATA_BYTES)
            .map_err(|_| "private mountpoint metadata exceeds 64 MiB")?,
    )
    .map_err(|_| "private mountpoint metadata write failed")?;
    let mounted = freshell_runtime_protocol::bounded_json_bytes(
        &resource_mount_roots(mounted_context),
        MAX_PROJECTION_METADATA_BYTES,
    )
    .map_err(|_| "resource mountpoint metadata profile exceeded")?;
    std::fs::write(stage.path().join("resource-mountpoints.json"), mounted)
        .map_err(|_| "resource mountpoint metadata write failed")?;
    let preserved = freshell_runtime_protocol::bounded_json_bytes(
        &preserved_writable_files,
        MAX_PROJECTION_METADATA_BYTES,
    )
    .map_err(|_| "preserved writable resource metadata profile exceeded")?;
    std::fs::write(
        stage.path().join("preserved-writable-resource-files.json"),
        preserved,
    )
    .map_err(|_| "preserved writable resource metadata write failed")?;
    let reference_aliases = provider_resource_reference_alias_plan(context)?;
    let reference_alias_metadata = freshell_runtime_protocol::bounded_json_bytes(
        &reference_aliases,
        MAX_PROJECTION_METADATA_BYTES,
    )
    .map_err(|_| "provider reference alias metadata profile exceeded")?;
    std::fs::write(
        stage.path().join("resource-reference-aliases.json"),
        reference_alias_metadata,
    )
    .map_err(|_| "provider reference alias metadata write failed")?;
    let workspace = matches!(provider, "opencode" | "codex")
        .then(|| std::fs::canonicalize(workspace))
        .transpose()
        .map_err(|_| "provider refresh mounted workspace is unavailable")?;
    // This process already prepared the complete graph as the provider UID.
    // Keep its private modes and consume that owned stage in the transaction.
    apply_staged_provider_config_locked(
        stage.path(),
        provider_home,
        workspace.as_deref(),
        Some(PreparedProviderProjection {
            root: projection,
            projected_paths: current,
        }),
    )
}

#[cfg(test)]
fn record_provider_resource_reference_aliases(
    context: &freshell_runtime_protocol::ProviderLaunchContext,
    provider_home: &Path,
) -> Result<(), String> {
    let (aliases, removed_aliases) =
        install_provider_resource_reference_aliases(context, provider_home)?;
    if aliases.is_empty() && removed_aliases.is_empty() {
        return Ok(());
    }
    let mut projected = read_projection_manifest(provider_home)?;
    for path in removed_aliases {
        projected.remove(&path.to_string_lossy().into_owned());
    }
    projected.extend(
        aliases
            .into_iter()
            .map(|path| path.to_string_lossy().into_owned()),
    );
    let manifest = write_projection_manifest(provider_home, &projected)?;
    set_owner(&manifest, unsafe { libc::geteuid() }, unsafe {
        libc::getegid()
    })?;
    Ok(())
}

fn refresh_provider_config_as_provider(
    context: &freshell_runtime_protocol::ProviderLaunchContext,
    provider: &str,
    workspace: &Path,
    user_provider_root: &Path,
    provider_home: &Path,
    uid: u32,
    gid: u32,
) -> Result<(), String> {
    use std::io::{Seek, Write};
    // Only bounded control metadata uses temporary memory. The child performs
    // the complete ordinary transaction on disk as the actual provider UID.
    let bytes = freshell_runtime_protocol::bounded_json_bytes(
        context,
        freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES,
    )
    .map_err(|_| "provider-owned refresh control metadata exceeds its profile")?;
    let mut input = tempfile::tempfile().map_err(|_| "provider-owned refresh input unavailable")?;
    input
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .and_then(|()| input.write_all(&bytes))
        .and_then(|()| input.rewind())
        .map_err(|_| "provider-owned refresh input incomplete")?;
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let transaction = uuid::Uuid::new_v4().to_string();
    let stage = provider_home.join(format!(".freshell-provider-refresh-{transaction}"));
    let mut child = std::process::Command::new("/usr/bin/setpriv")
        .args(provider_identity_args(uid, gid))
        .arg(exe)
        .arg("refresh-provider-config")
        .arg("--prepare")
        .arg(provider)
        .arg(workspace)
        .arg(user_provider_root)
        .arg(provider_home)
        .arg(&transaction)
        .env_clear()
        .stdin(std::process::Stdio::from(input))
        .stdout(std::process::Stdio::null())
        .spawn()
        .map_err(|error| format!("provider-owned config refresh failed to start: {error}"))?;
    let status = wait_for_provider_config_refresh(
        &mut child,
        provider,
        uid,
        gid,
        freshell_platform::provider_startup::PROVIDER_REFRESH_RUN,
        &stage,
    );
    match status {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => {
            let cause = format!("provider-owned config refresh failed with status {status}");
            recover_provider_projection_as_provider(provider_home, uid, gid).map_err(
                |recovery| format!("{cause}; interrupted projection recovery failed: {recovery}"),
            )?;
            Err(cause)
        }
        Err(cause) if cause.contains("provider-owned config refresh timed out") => {
            recover_provider_projection_as_provider(provider_home, uid, gid).map_err(
                |recovery| format!("{cause}; interrupted projection recovery failed: {recovery}"),
            )?;
            Err(cause)
        }
        Err(cause) => Err(cause),
    }
}

fn recover_provider_projection_as_provider(
    provider_home: &Path,
    uid: u32,
    gid: u32,
) -> Result<(), String> {
    let executable = std::env::current_exe()
        .map_err(|_| "provider projection recovery executable unavailable")?;
    let status = std::process::Command::new("/usr/bin/setpriv")
        .args(provider_identity_args(uid, gid))
        .args([
            "/usr/bin/timeout".to_owned(),
            format!(
                "--kill-after={}s",
                freshell_platform::provider_startup::PROVIDER_REFRESH_RECOVERY_KILL.as_secs()
            ),
            format!(
                "{}s",
                freshell_platform::provider_startup::PROVIDER_REFRESH_RECOVERY_RUN.as_secs()
            ),
        ])
        .arg(executable)
        .args(["refresh-provider-config", "--recover"])
        .arg(provider_home)
        .env_clear()
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|_| "provider projection recovery failed to start")?;
    if status.success() {
        emit_environment_event(
            serde_json::json!({"severity":"info","event":"provider.projection.transaction.timeout_recovered","stage":"recovery"}),
        );
        Ok(())
    } else {
        emit_environment_event(
            serde_json::json!({"severity":"error","event":"provider.projection.transaction.timeout_recovery_failed","stage":"recovery","status":status.to_string()}),
        );
        Err(format!(
            "provider projection recovery exited with status {status}"
        ))
    }
}

fn wait_for_provider_config_refresh(
    child: &mut std::process::Child,
    provider: &str,
    uid: u32,
    gid: u32,
    timeout: std::time::Duration,
    stage: &Path,
) -> Result<std::process::ExitStatus, String> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                cleanup_provider_refresh_stage(stage, uid, gid)?;
                return Ok(status);
            }
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Err(_) => {
                tracing::warn!(event="provider.inputs.refresh.completion_unavailable", provider, stage="session_host", "Provider-owned ordinary refresh wait ownership was not confirmed; retain inputs and repair");
                return Err("provider-owned config refresh completion unavailable; retain inputs and repair".into());
            }
            Ok(None) => {
                // The restricted root host has no CAP_KILL. Signal only this
                // unreaped child through its existing provider identity.
                let pid = child.id().to_string();
                let termination =
                    run_provider_refresh_cleanup(uid, gid, "/usr/bin/kill", &["-KILL", "--", &pid]);
                let cleanup_deadline = std::time::Instant::now()
                    + freshell_platform::provider_startup::PROVIDER_REFRESH_JOIN;
                loop {
                    match child.try_wait() {
                        Ok(Some(_)) => {
                            cleanup_provider_refresh_stage(stage, uid, gid)?;
                            break;
                        }
                        Ok(None) if std::time::Instant::now() < cleanup_deadline => {
                            std::thread::sleep(std::time::Duration::from_millis(20));
                        }
                        _ => {
                            tracing::warn!(event="provider.inputs.refresh.cleanup_failed", provider, stage="session_host", worker_pid=%pid, termination_succeeded=termination.is_ok(), "Provider-owned ordinary refresh join was not confirmed");
                            return Err("provider-owned config refresh cleanup unavailable; retain inputs and repair".into());
                        }
                    }
                }
                return Err(
                    "provider-owned config refresh timed out; retain inputs and retry".into(),
                );
            }
        }
    }
}

fn cleanup_provider_refresh_stage(stage: &Path, uid: u32, gid: u32) -> Result<(), String> {
    let stage = stage
        .to_str()
        .ok_or("provider refresh transaction path is not UTF-8")?;
    // This path is one newly generated transaction, never an accepted provider
    // projection. The UID worker is joined before its directory can be removed.
    run_provider_refresh_cleanup(uid, gid, "/usr/bin/rm", &["-rf", "--", stage]).map_err(|_| {
        "provider-owned refresh transaction cleanup unavailable; retain inputs and repair".into()
    })
}

fn run_provider_refresh_cleanup(
    uid: u32,
    gid: u32,
    program: &str,
    args: &[&str],
) -> Result<(), String> {
    let status = std::process::Command::new("/usr/bin/setpriv")
        .args(provider_identity_args(uid, gid))
        .args([
            "/usr/bin/timeout".to_owned(),
            format!(
                "--kill-after={}s",
                freshell_platform::provider_startup::PROVIDER_REFRESH_CLEANUP_KILL.as_secs()
            ),
            format!(
                "{}s",
                freshell_platform::provider_startup::PROVIDER_REFRESH_CLEANUP_RUN.as_secs()
            ),
            program.to_owned(),
        ])
        .args(args)
        .env_clear()
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|_| "provider refresh cleanup failed to start")?;
    if status.success() {
        Ok(())
    } else {
        Err("provider refresh cleanup failed or timed out".into())
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

fn refresh_provider_config_worker(args: &[String]) -> Result<(), String> {
    if args.len() == 2 && args[0] == "--recover" {
        let provider_home = Path::new(&args[1]);
        let _projection_lock = lock_provider_projection(provider_home)?;
        recover_provider_projection_transactions(provider_home)?;
        return cleanup_orphaned_provider_refresh_stages(provider_home, None);
    }
    if args.len() == 6 && args[0] == "--prepare" {
        use std::io::Read;
        let mut input = std::io::stdin().lock();
        let mut header = [0; 4];
        input
            .read_exact(&mut header)
            .map_err(|_| "provider refresh control header unavailable")?;
        let length = u32::from_be_bytes(header) as usize;
        if length > freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES {
            return Err("provider refresh control metadata exceeds its profile".into());
        }
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(length)
            .map_err(|_| "provider refresh control allocation unavailable")?;
        bytes.resize(length, 0);
        input
            .read_exact(&mut bytes)
            .map_err(|_| "provider refresh control input incomplete")?;
        let mut trailing = [0];
        if input
            .read(&mut trailing)
            .map_err(|_| "provider refresh control completion unavailable")?
            != 0
        {
            return Err("provider refresh control input has trailing metadata".into());
        }
        let context: freshell_runtime_protocol::ProviderLaunchContext =
            serde_json::from_slice(&bytes)
                .map_err(|_| "provider refresh control metadata invalid")?;
        context.validate(&args[1]).map_err(|error| error.message)?;
        let transaction =
            uuid::Uuid::parse_str(&args[5]).map_err(|_| "provider refresh transaction invalid")?;
        if transaction.get_version_num() != 4 || transaction.to_string() != args[5] {
            return Err("provider refresh transaction invalid".into());
        }
        let provider_home = Path::new(&args[4]);
        let _projection_lock = lock_provider_projection(provider_home)?;
        recover_provider_projection_transactions(provider_home)?;
        cleanup_orphaned_provider_refresh_stages(provider_home, None)?;
        let name = format!(".freshell-provider-refresh-{transaction}");
        let stage = tempfile::Builder::new()
            .prefix(&name)
            .rand_bytes(0)
            .tempdir_in(provider_home)
            .map_err(|error| {
                format!("provider refresh transaction creation unavailable: {error}")
            })?;
        return refresh_provider_config_in_stage_locked(
            &context,
            &context,
            &args[1],
            Path::new(&args[2]),
            Path::new(&args[3]),
            Path::new(&args[4]),
            stage,
        );
    }
    if args.len() != 2 {
        return Err("refresh-provider-config requires stage and provider home".into());
    }
    apply_staged_provider_config(Path::new(&args[0]), Path::new(&args[1]))
}

fn apply_staged_provider_config(stage: &Path, provider_home: &Path) -> Result<(), String> {
    let _projection_lock = lock_provider_projection(provider_home)?;
    recover_provider_projection_transactions(provider_home)?;
    cleanup_orphaned_provider_refresh_stages(provider_home, None)?;
    apply_staged_provider_config_locked(stage, provider_home, None, None)
}

fn apply_staged_provider_config_locked(
    stage: &Path,
    provider_home: &Path,
    workspace: Option<&Path>,
    prepared: Option<PreparedProviderProjection>,
) -> Result<(), String> {
    let destinations: Vec<String> = serde_json::from_slice(
        &read_projection_metadata(stage, "manifest.json")?
            .ok_or("provider projection destinations unavailable")?,
    )
    .map_err(|_| "provider projection destinations invalid")?;
    let projection = stage.join("projection");
    let previous = read_projection_manifest(provider_home)?;
    let current = read_projection_manifest(&projection)?;
    if prepared
        .as_ref()
        .is_some_and(|prepared| prepared.root != projection || prepared.projected_paths != current)
    {
        return Err("prepared provider projection does not match its completed stage".into());
    }
    let mut protected: std::collections::BTreeSet<String> =
        match read_projection_metadata(stage, "private-mountpoints.json")? {
            Some(bytes) => {
                serde_json::from_slice(&bytes).map_err(|_| "private mountpoint metadata invalid")?
            }
            None => Default::default(),
        };
    let reference_aliases: ProviderResourceReferenceAliasPlan =
        match read_projection_metadata(stage, "resource-reference-aliases.json")? {
            Some(bytes) => serde_json::from_slice(&bytes)
                .map_err(|_| "provider reference alias metadata invalid")?,
            None => Default::default(),
        };
    let reference_alias_paths = provider_resource_reference_alias_paths(&reference_aliases)?;
    if provider_reference_alias_overlaps_selected_paths(&reference_aliases, &current) {
        return Err("provider reference alias overlaps a selected resource file".into());
    }
    protected.retain(|relative| !reference_alias_paths.contains(relative));
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
        if !protected.contains(relative)
            && (previous.contains(relative) || current.contains(relative))
        {
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
    // The manifest names a physical graph, including targets discovered through
    // selected links. Select its shared resource root as a unit so those targets
    // retain their recorded paths rather than being relocated as new externals.
    if current.contains(".freshell/resources") {
        paths.push(".freshell/resources".into());
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
    let provider = match read_projection_metadata(stage, "provider.json")? {
        Some(bytes) => serde_json::from_slice::<String>(&bytes)
            .map_err(|_| "provider projection identity invalid")?,
        None => "unknown".into(),
    };
    if !matches!(
        provider.as_str(),
        "claude" | "codex" | "opencode" | "amplifier" | "unknown"
    ) {
        return Err("provider config refresh provider is unsupported".into());
    }
    let mounted: Vec<PathBuf> =
        match read_projection_metadata(stage, "resource-mountpoints.json")? {
            Some(bytes) => serde_json::from_slice(&bytes)
                .map_err(|_| "resource mountpoint metadata invalid")?,
            None => Vec::new(),
        };
    if mounted.iter().any(|path| {
        !path.starts_with(".freshell/provider-roots")
            || path
                .components()
                .any(|part| !matches!(part, std::path::Component::Normal(_)))
    }) {
        return Err("resource mountpoint metadata has an invalid owned root".into());
    }
    if reference_aliases
        .active
        .iter()
        .map(|alias| Path::new(&alias.mount_root))
        .chain(
            reference_aliases
                .retired
                .iter()
                .map(|alias| Path::new(&alias.mount_root)),
        )
        .any(|root| !mounted.iter().any(|mounted_root| mounted_root == root))
    {
        return Err("provider reference alias is outside its mounted resource".into());
    }
    let preserve_existing_mounted_files: Vec<PathBuf> =
        match read_projection_metadata(stage, "preserved-writable-resource-files.json")? {
            Some(bytes) => serde_json::from_slice::<Vec<String>>(&bytes)
                .map_err(|_| "preserved writable resource metadata invalid")?
                .into_iter()
                .map(PathBuf::from)
                .collect(),
            None => Vec::new(),
        };
    if preserve_existing_mounted_files.iter().any(|path| {
        !path.starts_with(".freshell/provider-roots")
            || path
                .components()
                .any(|part| !matches!(part, std::path::Component::Normal(_)))
            || !mounted.contains(path)
    }) {
        return Err("preserved writable resource metadata has an invalid exact file".into());
    }
    publish_provider_projection(
        ProviderProjection {
            provider: &provider,
            workspace,
            selections: &selections,
            home: provider_home,
            previous: &previous,
            current: &current,
            protected: &protected,
            mounted: &mounted,
            preserve_existing_mounted_files: &preserve_existing_mounted_files,
            reference_aliases,
        },
        prepared,
        |source, destination| std::fs::rename(source, destination),
    )
}

struct ProviderProjection<'a> {
    provider: &'a str,
    workspace: Option<&'a Path>,
    selections: &'a [freshell_platform::provider_environment::CopySelection],
    home: &'a Path,
    previous: &'a std::collections::BTreeSet<String>,
    current: &'a std::collections::BTreeSet<String>,
    protected: &'a std::collections::BTreeSet<String>,
    mounted: &'a [PathBuf],
    preserve_existing_mounted_files: &'a [PathBuf],
    reference_aliases: ProviderResourceReferenceAliasPlan,
}

struct PreparedProviderProjection {
    root: PathBuf,
    projected_paths: std::collections::BTreeSet<String>,
}

// One provider-owned transaction covers replacement, stale removal and manifest
// publication. Its private stage and backups live on HOME's filesystem; only
// exact manifest leaves move, so shared directories keep native children.
#[cfg(test)]
fn publish_provider_projection_with_manifest(
    projection: ProviderProjection<'_>,
    publish_manifest: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), String> {
    publish_provider_projection(projection, None, publish_manifest)
}

fn publish_provider_projection(
    projection: ProviderProjection<'_>,
    prepared: Option<PreparedProviderProjection>,
    publish_manifest: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), String> {
    let ProviderProjection {
        provider,
        workspace,
        selections,
        home,
        previous,
        current,
        protected,
        mounted,
        preserve_existing_mounted_files,
        reference_aliases,
    } = projection;
    use std::{collections::BTreeMap, fs, os::unix::fs::PermissionsExt};
    let reference_alias_paths = provider_resource_reference_alias_paths(&reference_aliases)?;
    if provider_reference_alias_overlaps_selected_paths(&reference_aliases, current) {
        return Err("provider reference alias overlaps a selected resource file".into());
    }
    preflight_provider_reference_aliases(home, &reference_aliases, current)?;
    let active_alias_paths = reference_aliases
        .active
        .iter()
        .map(|alias| alias.provider_path().to_string_lossy().into_owned())
        .collect::<std::collections::BTreeSet<_>>();
    let retired_alias_paths = reference_aliases
        .retired
        .iter()
        .map(|alias| alias.provider_path().to_string_lossy().into_owned())
        .collect::<std::collections::BTreeSet<_>>();
    let mut transactional_alias_paths = reference_alias_paths;
    transactional_alias_paths.retain(|relative| {
        active_alias_paths.contains(relative)
            || (retired_alias_paths.contains(relative) && !current.contains(relative))
    });
    let mut manifest_current = current.clone();
    manifest_current.extend(active_alias_paths.iter().cloned());
    for relative in &retired_alias_paths {
        if !current.contains(relative) {
            manifest_current.remove(relative);
        }
    }
    emit_environment_event(
        serde_json::json!({"severity":"info","event":"provider.projection.transaction.started","provider":provider,"stage":"stage","previous_entries":previous.len(),"desired_entries":manifest_current.len()}),
    );
    let previous_manifest = read_projection_metadata(home, PROVIDER_PROJECTION_MANIFEST)?;
    let transaction = tempfile::Builder::new()
        .prefix(PROVIDER_PROJECTION_TRANSACTION_PREFIX)
        .tempdir_in(home)
        .map_err(|error| format!("provider transaction stage: {error}"))?;
    let transaction_path = transaction.keep();
    sync_provider_projection_directory(home)?;
    let mut journal = ProviderProjectionTransactionJournal {
        version: 1,
        phase: ProviderProjectionTransactionPhase::Preparing,
        manifest_existed: previous_manifest.is_some(),
        entries: Vec::new(),
    };
    write_provider_projection_transaction_journal(&transaction_path, &journal)
        .map_err(|error| error.to_string())?;
    let desired = transaction_path.join("desired");
    let backup = transaction_path.join("backup");
    fs::create_dir(&backup).map_err(|error| error.to_string())?;
    let staged = (|| {
        let actual = if let Some(prepared) = prepared {
            if &prepared.projected_paths != current {
                return Err("prepared provider projection paths changed before publication".into());
            }
            // The complete private tree was copied and validated under this
            // HOME's projection lock. Move it into the existing transaction;
            // its final data/directory flushes and rollback remain below.
            fs::rename(&prepared.root, &desired)
                .map_err(|error| format!("provider transaction consume prepared stage: {error}"))?;
            emit_environment_event(serde_json::json!({
                "severity":"info","event":"provider.projection.prepared.reused",
                "provider":provider,"stage":"stage","entries":prepared.projected_paths.len()
            }));
            prepared.projected_paths
        } else {
            let report = if let Some(workspace) = workspace {
                copy_environment_with_events_excluding_subtree_for_mounts(
                    "provider_publication",
                    provider,
                    selections,
                    &desired,
                    &[],
                    workspace,
                    MountedResourceOptions {
                        mounted_roots: &[],
                        preserve_existing_mounted_files: &[],
                    },
                )
            } else {
                copy_environment_with_events(
                    "provider_publication",
                    provider,
                    selections,
                    &desired,
                    &[],
                )
            }
            .map_err(|error| error.to_string())?;
            report
                .projected_paths
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect::<std::collections::BTreeSet<_>>()
        };
        if &actual != current {
            return Err(
                "provider projection manifest does not describe the complete selected environment"
                    .into(),
            );
        }
        // Serialize, write and sync the complete manifest before changing HOME.
        let manifest = write_projection_manifest(&transaction_path, &manifest_current)?;
        // Links crossing mounted resource boundaries must still resolve in the
        // final HOME graph, not relative to the independent alias mount.
        for relative in current {
            let source = desired.join(relative);
            if fs::symlink_metadata(&source)
                .map_err(|error| error.to_string())?
                .file_type()
                .is_symlink()
            {
                let target = fs::read_link(&source).map_err(|error| error.to_string())?;
                let physical = fs::canonicalize(&source).map_err(|error| error.to_string())?;
                let target_relative = match physical.strip_prefix(&desired) {
                    Ok(relative) => relative,
                    Err(_)
                        if workspace.is_some_and(|workspace| {
                            freshell_platform::provider_environment::is_workspace_mount_alias(
                                &physical, workspace,
                            )
                        }) =>
                    {
                        continue;
                    }
                    Err(_) => {
                        return Err("staged resource link escapes its complete projection".into())
                    }
                };
                if mounted.iter().any(|root| {
                    Path::new(relative).starts_with(root) && !target_relative.starts_with(root)
                }) {
                    fs::remove_file(&source).map_err(|error| error.to_string())?;
                    std::os::unix::fs::symlink(home.join(target_relative), &source)
                        .map_err(|error| error.to_string())?;
                } else if target.is_absolute() {
                    return Err(
                        "staged resource link must resolve within the selected projection".into(),
                    );
                }
            }
        }
        Ok(manifest)
    })();
    let manifest = match staged {
        Ok(manifest) => manifest,
        Err(cause) => {
            emit_environment_event(
                serde_json::json!({"severity":"error","event":"provider.projection.transaction.failed","provider":provider,"stage":"stage","cause":cause}),
            );
            if let Err(cleanup_cause) = cleanup_provider_projection_transaction(
                &transaction_path,
                home,
                ProviderProjectionTransactionPhase::Preparing,
            ) {
                return Err(format!(
                    "{cause}; staged transaction cleanup failed: {cleanup_cause}; retain backup {}",
                    transaction_path.display()
                ));
            }
            return Err(cause);
        }
    };
    let mut old = BTreeMap::new();
    let mut incoming = BTreeMap::new();
    let prepared: Result<(), String> = (|| {
        for relative in previous.union(current) {
            if protected.contains(relative) || transactional_alias_paths.contains(relative) {
                continue;
            }
            match fs::symlink_metadata(home.join(relative)) {
                Ok(metadata) => {
                    old.insert(relative.clone(), metadata);
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!("provider transaction inspect {relative}: {error}"))
                }
            }
            if current.contains(relative) {
                let metadata = fs::symlink_metadata(desired.join(relative))
                    .map_err(|error| error.to_string())?;
                if let Some(existing) = old.get(relative) {
                    let shared_directory = existing.is_dir() && metadata.is_dir();
                    if !shared_directory
                        && !previous.contains(relative)
                        && !mounted.contains(&PathBuf::from(relative))
                    {
                        return Err(format!("provider transaction destination {relative} is provider-created; retain it and repair the selected path"));
                    }
                    if existing.is_dir() && !metadata.is_dir() {
                        validate_owned_projection_descendants(home, Path::new(relative), previous)?;
                    }
                }
                incoming.insert(relative.clone(), metadata);
            }
        }
        // Mounted files keep their inode. Back up their complete prior contents
        // before any mutation, with the same shared copy byte profile.
        for (relative, metadata) in &old {
            if metadata.is_file() {
                sync_provider_projection_file(&home.join(relative))?;
            }
        }
        let limits = freshell_platform::provider_environment::CopyLimits::default();
        let mut bytes = 0u64;
        for (relative, metadata) in &old {
            if mounted.contains(&PathBuf::from(relative))
                && metadata.is_file()
                && !preserve_existing_mounted_files.contains(&PathBuf::from(relative))
            {
                bytes = bytes
                    .checked_add(metadata.len())
                    .ok_or("provider mounted backup byte accounting overflow")?;
                if metadata.len() > limits.max_file_bytes || bytes > limits.max_total_bytes {
                    return Err(format!(
                        "provider mounted backup {relative} exceeds shared resource byte limits"
                    ));
                }
                let saved = backup.join(relative);
                fs::create_dir_all(saved.parent().ok_or("backup parent unavailable")?)
                    .map_err(|error| error.to_string())?;
                fs::copy(home.join(relative), &saved)
                    .map_err(|error| format!("provider transaction backup {relative}: {error}"))?;
                fs::File::open(&saved)
                    .and_then(|file| file.sync_all())
                    .map_err(|error| {
                        format!("provider transaction backup sync {relative}: {error}")
                    })?;
            }
        }
        Ok(())
    })();
    if let Err(cause) = prepared {
        emit_environment_event(
            serde_json::json!({"severity":"error","event":"provider.projection.transaction.failed","provider":provider,"stage":"validate","cause":cause}),
        );
        if let Err(cleanup_cause) = cleanup_provider_projection_transaction(
            &transaction_path,
            home,
            ProviderProjectionTransactionPhase::Preparing,
        ) {
            return Err(format!(
                "{cause}; staged transaction cleanup failed: {cleanup_cause}; retain backup {}",
                transaction_path.display()
            ));
        }
        return Err(cause);
    }
    if let Some(bytes) = previous_manifest.as_deref() {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let saved_manifest = transaction_path.join(PROVIDER_PROJECTION_TRANSACTION_MANIFEST_BACKUP);
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(saved_manifest)
            .map_err(|_| "provider transaction manifest backup unavailable")?;
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|_| "provider transaction manifest backup write unavailable")?;
    }
    let mut touched_paths = std::collections::BTreeSet::new();
    touched_paths.extend(
        previous
            .union(current)
            .filter(|relative| {
                !protected.contains(*relative) && !transactional_alias_paths.contains(*relative)
            })
            .cloned(),
    );
    touched_paths.extend(transactional_alias_paths.iter().cloned());
    journal.entries = touched_paths
        .into_iter()
        .map(|relative| {
            let in_place = mounted.contains(&PathBuf::from(&relative))
                && incoming
                    .get(&relative)
                    .is_some_and(|metadata| metadata.is_file())
                && old
                    .get(&relative)
                    .is_some_and(|metadata| metadata.is_file())
                && !(preserve_existing_mounted_files.contains(&PathBuf::from(&relative))
                    && previous.contains(&relative));
            Ok(ProviderProjectionTransactionEntry {
                original: provider_projection_original_node(home, &relative, in_place)?,
                relative,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    sync_provider_projection_tree(&transaction_path)?;
    sync_provider_projection_directory(home)?;
    journal.phase = ProviderProjectionTransactionPhase::Publishing;
    write_provider_projection_transaction_journal(&transaction_path, &journal)
        .map_err(|error| error.to_string())?;
    let mut moved = Vec::<String>::new();
    let mut installed = Vec::<String>::new();
    let publication: Result<(), String> = (|| {
        for (relative, metadata) in &old {
            if metadata.is_dir() || !previous.contains(relative) || protected.contains(relative) {
                continue;
            }
            if mounted.contains(&PathBuf::from(relative)) {
                continue;
            }
            let saved = backup.join(relative);
            fs::create_dir_all(saved.parent().ok_or("backup parent unavailable")?)
                .map_err(|error| error.to_string())?;
            fs::rename(home.join(relative), saved)
                .map_err(|error| format!("provider transaction backup {relative}: {error}"))?;
            moved.push(relative.clone());
        }
        backup_provider_reference_aliases(home, current, &reference_aliases, &backup, &mut moved)?;
        // The old nodes and their backups must be durable before any new node
        // is installed. Recovery can then restore the prior projection even
        // after a machine crash during publication.
        sync_provider_projection_tree(&backup)?;
        sync_provider_projection_directories(home, &journal.entries)?;
        let mut directories = old
            .iter()
            .filter(|(_, metadata)| metadata.is_dir())
            .collect::<Vec<_>>();
        directories
            .sort_by_key(|(path, _)| std::cmp::Reverse(Path::new(path).components().count()));
        for (relative, _) in directories {
            if !previous.contains(relative)
                || protected.contains(relative)
                || incoming
                    .get(relative)
                    .is_some_and(|metadata| metadata.is_dir())
                || mounted.contains(&PathBuf::from(relative))
            {
                continue;
            }
            match fs::remove_dir(home.join(relative)) {
                Ok(()) => {}
                Err(error)
                    if error.kind() == std::io::ErrorKind::DirectoryNotEmpty
                        && !incoming.contains_key(relative) => {}
                Err(error) => {
                    return Err(format!(
                        "provider transaction remove directory {relative}: {error}"
                    ))
                }
            }
        }
        let mut nodes = incoming.iter().collect::<Vec<_>>();
        nodes.sort_by_key(|(path, _)| Path::new(path).components().count());
        for (relative, metadata) in nodes {
            let destination = home.join(relative);
            if metadata.is_dir() {
                if !destination.exists() {
                    fs::create_dir(&destination).map_err(|error| {
                        format!("provider transaction create {relative}: {error}")
                    })?;
                    fs::set_permissions(&destination, fs::Permissions::from_mode(0o700))
                        .map_err(|error| error.to_string())?;
                }
            } else if mounted.contains(&PathBuf::from(relative)) {
                if !metadata.is_file()
                    || !old.get(relative).is_some_and(|metadata| metadata.is_file())
                {
                    return Err(format!(
                        "provider transaction mounted file {relative} must retain a regular inode"
                    ));
                }
                if preserve_existing_mounted_files.contains(&PathBuf::from(relative))
                    && previous.contains(relative)
                {
                    continue;
                }
                replace_mounted_projection_file(&desired.join(relative), &destination)?;
            } else {
                fs::rename(desired.join(relative), &destination)
                    .map_err(|error| format!("provider transaction install {relative}: {error}"))?;
                installed.push(relative.clone());
            }
        }
        publish_provider_reference_aliases(
            home,
            current,
            &reference_aliases,
            &backup,
            &mut moved,
            &mut installed,
        )?;
        publish_manifest(&manifest, &home.join(PROVIDER_PROJECTION_MANIFEST))
            .map_err(|error| format!("provider transaction publish manifest: {error}"))?;
        sync_provider_projection_directories(home, &journal.entries)?;
        sync_provider_projection_tree(&backup)?;
        Ok(())
    })();
    if let Err(cause) = publication {
        let rollback = recover_provider_projection_transaction(&transaction_path, home, &journal);
        emit_environment_event(
            serde_json::json!({"severity":if rollback.is_ok(){"info"}else{"error"},"event":"provider.projection.transaction.rollback","provider":provider,"stage":"rollback","restored":moved.len(),"removed":installed.len(),"successful":rollback.is_ok()}),
        );
        emit_environment_event(
            serde_json::json!({"severity":"error","event":"provider.projection.transaction.failed","provider":provider,"stage":"publish","cause":cause}),
        );
        if let Err(rollback_cause) = rollback {
            return Err(format!(
                "{cause}; rollback failed: {rollback_cause}; retain backup {} and repair",
                transaction_path.display()
            ));
        }
        if let Err(cleanup_cause) = cleanup_provider_projection_transaction(
            &transaction_path,
            home,
            ProviderProjectionTransactionPhase::RolledBack,
        ) {
            return Err(format!(
                "{cause}; prior projection restored but backup cleanup failed: {cleanup_cause}; retain backup {}",
                transaction_path.display()
            ));
        }
        return Err(cause);
    }
    journal.phase = ProviderProjectionTransactionPhase::Committed;
    match write_provider_projection_transaction_journal(&transaction_path, &journal) {
        Ok(()) => {}
        Err(ProviderProjectionJournalWriteError::PublishedButUnconfirmed(cause)) => {
            emit_environment_event(serde_json::json!({
                "severity": "error",
                "event": "provider.projection.transaction.commit_uncertain",
                "provider": provider,
                "stage": "commit",
                "cause": cause,
                "transaction": transaction_path.display().to_string(),
            }));
            return Err(format!(
                "{cause}; provider projection is installed but commit durability is unconfirmed; retain backup {} and repair",
                transaction_path.display()
            ));
        }
        Err(ProviderProjectionJournalWriteError::BeforePublish(cause)) => {
            let rollback =
                recover_provider_projection_transaction(&transaction_path, home, &journal);
            if let Err(rollback_cause) = rollback {
                return Err(format!(
                    "{cause}; provider projection recovery failed: {rollback_cause}; retain backup {} and repair",
                    transaction_path.display()
                ));
            }
            if let Err(cleanup_cause) = cleanup_provider_projection_transaction(
                &transaction_path,
                home,
                ProviderProjectionTransactionPhase::RolledBack,
            ) {
                return Err(format!(
                    "{cause}; prior projection restored but backup cleanup failed: {cleanup_cause}; retain backup {}",
                    transaction_path.display()
                ));
            }
            return Err(format!(
                "{cause}; prior provider projection restored; retain inputs and retry"
            ));
        }
    }
    emit_environment_event(
        serde_json::json!({"severity":"info","event":"provider.projection.transaction.committed","provider":provider,"stage":"commit","installed":installed.len(),"retired":moved.len()}),
    );
    if let Err(error) = cleanup_provider_projection_transaction(
        &transaction_path,
        home,
        ProviderProjectionTransactionPhase::Committed,
    ) {
        emit_environment_event(
            serde_json::json!({"severity":"error","event":"provider.projection.transaction.cleanup_failed","provider":provider,"stage":"cleanup","cause":error.to_string()}),
        );
        // Publication has committed. Cleanup failure is observable but cannot
        // retroactively turn the complete environment into a failed refresh.
    }
    Ok(())
}

fn preflight_provider_reference_aliases(
    home: &Path,
    plan: &ProviderResourceReferenceAliasPlan,
    current: &std::collections::BTreeSet<String>,
) -> Result<(), String> {
    for alias in &plan.active {
        let relative = alias.provider_path();
        let reference = home.join(format!(".freshell/references/{}", alias.reference_index));
        for parent in [home.join(".freshell"), home.join(".freshell/references")] {
            match std::fs::symlink_metadata(&parent) {
                Ok(metadata) if metadata.is_dir() => {}
                Ok(_) => return Err("provider reference alias target parent is unsafe".into()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Err("provider reference alias target is unavailable".into())
                }
                Err(_) => return Err("provider reference alias target is unavailable".into()),
            }
        }
        if !std::fs::metadata(&reference).is_ok_and(|metadata| metadata.is_file()) {
            return Err("provider reference alias target is unavailable".into());
        }
        if !provider_reference_alias_parent_available(home, &relative, current)? {
            return Err("provider reference alias parent directory is unavailable".into());
        }
        let destination = home.join(&relative);
        match std::fs::symlink_metadata(&destination) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                let link = std::fs::read_link(&destination)
                    .map_err(|_| "provider reference alias could not be inspected")?;
                let runtime_reference = PathBuf::from(format!(
                    "/home/freshell/provider/.freshell/references/{}",
                    alias.reference_index
                ));
                if link != runtime_reference
                    && managed_provider_reference_alias_index(&link, &destination, home).is_none()
                {
                    return Err("provider reference alias conflicts with an existing link".into());
                }
            }
            Ok(_) => {
                return Err(format!(
                    "provider-created resource blocks provider reference alias {}; retain it and repair the selected path",
                    relative.display()
                ))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("provider reference alias path could not be inspected".into()),
        }
    }
    for alias in &plan.retired {
        let relative = alias.provider_path();
        let _ = provider_reference_alias_parent_available(home, &relative, current)?;
    }
    Ok(())
}

fn provider_reference_alias_parent_available(
    home: &Path,
    relative: &Path,
    current: &std::collections::BTreeSet<String>,
) -> Result<bool, String> {
    let parent = relative
        .parent()
        .ok_or("provider reference alias has no parent directory")?;
    let mut prefix = PathBuf::new();
    for component in parent.components() {
        prefix.push(component.as_os_str());
        let absolute = home.join(&prefix);
        match std::fs::symlink_metadata(&absolute) {
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => return Err("provider reference alias parent directory is unsafe".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let prefix = prefix
                    .to_str()
                    .ok_or("provider reference alias path is not UTF-8")?;
                return Ok(current.contains(prefix));
            }
            Err(_) => return Err("provider reference alias parent directory is unavailable".into()),
        }
    }
    Ok(true)
}

fn backup_provider_reference_aliases(
    home: &Path,
    current: &std::collections::BTreeSet<String>,
    plan: &ProviderResourceReferenceAliasPlan,
    backup: &Path,
    moved: &mut Vec<String>,
) -> Result<(), String> {
    for alias in &plan.active {
        let relative = alias.provider_path();
        if !provider_reference_alias_parent_available(home, &relative, current)? {
            continue;
        }
        let destination = home.join(&relative);
        let existing = match std::fs::symlink_metadata(&destination) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                Some(std::fs::read_link(&destination).map_err(|_| {
                    "provider reference alias could not be inspected"
                })?)
            }
            Ok(_) => {
                return Err(format!(
                    "provider-created resource blocks provider reference alias {}; retain it and repair the selected path",
                    relative.display()
                ))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return Err("provider reference alias path could not be inspected".into()),
        };
        let Some(link) = existing else { continue };
        let target = PathBuf::from(format!(
            "/home/freshell/provider/.freshell/references/{}",
            alias.reference_index
        ));
        if link == target {
            continue;
        }
        if managed_provider_reference_alias_index(&link, &destination, home).is_none() {
            return Err("provider reference alias conflicts with an existing link".into());
        }
        let relative_string = relative
            .to_str()
            .ok_or("provider reference alias path is not UTF-8")?
            .to_owned();
        let saved = backup.join(&relative);
        std::fs::create_dir_all(saved.parent().ok_or("backup parent unavailable")?)
            .map_err(|error| error.to_string())?;
        std::fs::rename(&destination, saved)
            .map_err(|error| format!("provider reference alias backup: {error}"))?;
        moved.push(relative_string);
    }
    for alias in &plan.retired {
        let relative = alias.provider_path();
        let relative_string = relative
            .to_str()
            .ok_or("provider reference alias path is not UTF-8")?
            .to_owned();
        if current.contains(&relative_string)
            || !provider_reference_alias_parent_available(home, &relative, current)?
        {
            continue;
        }
        let destination = home.join(&relative);
        let link = match std::fs::symlink_metadata(&destination) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                std::fs::read_link(&destination)
                    .map_err(|_| "retired provider reference alias could not be inspected")?
            }
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                return Err("retired provider reference alias path could not be inspected".into())
            }
        };
        if managed_provider_reference_alias_index(&link, &destination, home).is_none() {
            continue;
        }
        let saved = backup.join(&relative);
        std::fs::create_dir_all(saved.parent().ok_or("backup parent unavailable")?)
            .map_err(|error| error.to_string())?;
        std::fs::rename(&destination, saved)
            .map_err(|error| format!("retired provider reference alias backup: {error}"))?;
        moved.push(relative_string);
    }
    Ok(())
}

fn publish_provider_reference_aliases(
    home: &Path,
    current: &std::collections::BTreeSet<String>,
    plan: &ProviderResourceReferenceAliasPlan,
    backup: &Path,
    moved: &mut Vec<String>,
    installed: &mut Vec<String>,
) -> Result<(), String> {
    for alias in &plan.active {
        let relative = alias.provider_path();
        let relative_string = relative
            .to_str()
            .ok_or("provider reference alias path is not UTF-8")?
            .to_owned();
        if !provider_reference_alias_parent_available(home, &relative, current)? {
            return Err("provider reference alias parent directory is unavailable".into());
        }
        let destination = home.join(&relative);
        let target = PathBuf::from(format!(
            "/home/freshell/provider/.freshell/references/{}",
            alias.reference_index
        ));
        match std::fs::symlink_metadata(&destination) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                let link = std::fs::read_link(&destination)
                    .map_err(|_| "provider reference alias could not be inspected")?;
                if link == target {
                    continue;
                }
                if managed_provider_reference_alias_index(&link, &destination, home).is_none() {
                    return Err("provider reference alias conflicts with an existing link".into());
                }
                let saved = backup.join(&relative);
                std::fs::create_dir_all(saved.parent().ok_or("backup parent unavailable")?)
                    .map_err(|error| error.to_string())?;
                std::fs::rename(&destination, saved)
                    .map_err(|error| format!("provider reference alias backup: {error}"))?;
                moved.push(relative_string.clone());
            }
            Ok(_) => {
                return Err(format!(
                    "provider-created resource blocks provider reference alias {}; retain it and repair the selected path",
                    relative.display()
                ))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("provider reference alias path could not be inspected".into()),
        }
        std::os::unix::fs::symlink(&target, &destination)
            .map_err(|error| format!("provider reference alias could not be created: {error}"))?;
        installed.push(relative_string);
    }
    for alias in &plan.retired {
        let relative = alias.provider_path();
        let relative_string = relative
            .to_str()
            .ok_or("provider reference alias path is not UTF-8")?
            .to_owned();
        if current.contains(&relative_string)
            || !provider_reference_alias_parent_available(home, &relative, current)?
        {
            continue;
        }
        let destination = home.join(&relative);
        let link = match std::fs::symlink_metadata(&destination) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                std::fs::read_link(&destination)
                    .map_err(|_| "retired provider reference alias could not be inspected")?
            }
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                return Err("retired provider reference alias path could not be inspected".into())
            }
        };
        if managed_provider_reference_alias_index(&link, &destination, home).is_none() {
            continue;
        }
        let saved = backup.join(&relative);
        std::fs::create_dir_all(saved.parent().ok_or("backup parent unavailable")?)
            .map_err(|error| error.to_string())?;
        std::fs::rename(&destination, saved)
            .map_err(|error| format!("retired provider reference alias backup: {error}"))?;
        moved.push(relative_string);
    }
    Ok(())
}

fn validate_owned_projection_descendants(
    home: &Path,
    relative: &Path,
    previous: &std::collections::BTreeSet<String>,
) -> Result<(), String> {
    for entry in std::fs::read_dir(home.join(relative)).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let child = relative.join(entry.file_name());
        if !previous.contains(
            child
                .to_str()
                .ok_or("provider projection path is not UTF-8")?,
        ) {
            return Err(format!("provider transaction incompatible replacement {} contains provider-created descendants", relative.display()));
        }
        if std::fs::symlink_metadata(entry.path())
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            validate_owned_projection_descendants(home, &child, previous)?;
        }
    }
    Ok(())
}

fn replace_mounted_projection_file(source: &Path, destination: &Path) -> Result<(), String> {
    replace_mounted_projection_file_with_sync(source, destination, |file| file.sync_all())
}

fn replace_mounted_projection_file_with_sync(
    source: &Path,
    destination: &Path,
    mut sync_file: impl FnMut(&std::fs::File) -> std::io::Result<()>,
) -> Result<(), String> {
    use std::{fs, io::Write};
    let mut input = fs::File::open(source).map_err(|error| error.to_string())?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(destination)
        .map_err(|error| error.to_string())?;
    std::io::copy(&mut input, &mut output).map_err(|error| error.to_string())?;
    output.flush().map_err(|error| error.to_string())?;
    sync_file(&output).map_err(|error| error.to_string())?;
    fs::set_permissions(
        destination,
        fs::metadata(source)
            .map_err(|error| error.to_string())?
            .permissions(),
    )
    .map_err(|error| error.to_string())?;
    sync_file(&output).map_err(|error| format!("failed to flush mounted projection mode: {error}"))
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
fn prepare_provider_input_mount(
    context: &freshell_runtime_protocol::ProviderLaunchContext,
    paths: &ProviderConfigPaths,
) -> Result<PathBuf, String> {
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
    Ok(user_root)
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
    let user_root = prepare_provider_input_mount(context, paths)?;
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
    if !configuration_files.is_empty() && !indexed_configuration {
        std::fs::create_dir_all(auth_dir).map_err(|error| error.to_string())?;
        set_mode(auth_dir, 0o711)?;
    }
    prepare_native_provider_files_at(provider_files, run_as_uid, run_as_gid, home, auth_dir)?;
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
    let temporary = parent.join(format!(".freshell-file-link-{}", uuid::Uuid::new_v4()));
    let temporary_name = temporary
        .to_str()
        .ok_or("configuration-file temporary path is not UTF-8")?;
    run_provider_path_command(
        uid,
        gid,
        "/usr/bin/ln",
        &[
            "-sT",
            "--",
            target
                .to_str()
                .ok_or("configuration-file target is not UTF-8")?,
            temporary_name,
        ],
    )
    .map_err(|_| "configuration-file link staging failed")?;
    let published = run_provider_path_command(
        uid,
        gid,
        "/usr/bin/mv",
        &[
            "-fT",
            "--",
            temporary_name,
            destination
                .to_str()
                .ok_or("configuration-file destination is not UTF-8")?,
        ],
    );
    if published.is_err() {
        run_provider_path_command(uid, gid, "/usr/bin/rm", &["-f", "--", temporary_name])
            .map_err(|_| "configuration-file failed link cleanup failed")?;
    }
    published.map_err(|_| "configuration-file link publication failed")
}

fn prepare_native_provider_files_at(
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

#[cfg(unix)]
fn child_can_traverse(
    mode_bits: u32,
    owner_uid: u32,
    owner_gid: u32,
    child_uid: u32,
    child_gid: u32,
) -> bool {
    let class_bits = if child_uid == owner_uid {
        (mode_bits >> 6) & 0o7
    } else if child_gid == owner_gid {
        (mode_bits >> 3) & 0o7
    } else {
        mode_bits & 0o7
    };
    class_bits & 0o1 != 0
}

fn provider_run_as_identity() -> (u32, u32) {
    provider_run_as_identity_from(|key| std::env::var(key).ok())
}

/// The provider child identity from `FRESHELL_PROVIDER_RUN_AS_UID`/`_GID`,
/// defaulting per field to the managed-runtime child (65534:0). The lookup is
/// injected so tests cover the set-and-parseable path without a
/// process-wide env race.
fn provider_run_as_identity_from(lookup: impl Fn(&str) -> Option<String>) -> (u32, u32) {
    let parse = |key: &str| lookup(key).and_then(|value| value.parse().ok());
    (
        parse("FRESHELL_PROVIDER_RUN_AS_UID").unwrap_or(65_534),
        parse("FRESHELL_PROVIDER_RUN_AS_GID").unwrap_or(0),
    )
}

#[cfg(unix)]
fn emit_operator_home_readiness(
    state_dir: &Path,
    process_secret: &[u8],
    run_as_uid: u32,
    run_as_gid: u32,
) {
    let home = match (
        std::env::var_os("FRESHELL_OPERATOR_HOME_MOUNT"),
        std::env::var_os("FRESHELL_OPERATOR_HOME"),
    ) {
        (Some(_), Some(home)) => PathBuf::from(home),
        _ => return,
    };
    let data = match std::fs::metadata(&home) {
        Ok(metadata) => {
            use std::os::unix::fs::MetadataExt;
            let mode = metadata.mode() & 0o7777;
            serde_json::json!({
                "path": home.to_string_lossy(),
                "present": true,
                "uid": metadata.uid(),
                "gid": metadata.gid(),
                "mode": format!("{:04o}", mode),
                "home_root_traversable_by_child": child_can_traverse(
                    mode,
                    metadata.uid(),
                    metadata.gid(),
                    run_as_uid,
                    run_as_gid,
                ),
            })
        }
        Err(_) => serde_json::json!({
            "path": home.to_string_lossy(),
            "present": false,
        }),
    };
    let _ = append_event_with_secret(state_dir, process_secret, "operator_home_readiness", data);
}

#[cfg(not(unix))]
fn emit_operator_home_readiness(
    _state_dir: &Path,
    _process_secret: &[u8],
    _run_as_uid: u32,
    _run_as_gid: u32,
) {
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

fn prepare_fresh_provider_context_at(
    launch: &FreshAgentLaunchSpec,
    paths: &ProviderConfigPaths,
) -> Result<(), String> {
    prepare_provider_context_at(
        launch.provider_launch_context.as_ref(),
        launch.provider.native_family(),
        &launch.workspace_path,
        launch.run_as_uid,
        launch.run_as_gid,
        paths,
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn fresh_agent_open_errors_expose_only_a_closed_failure_category() {
        use freshell_agent_runtime::host_actor::{ActorError, ProviderStartDiagnostic};
        use freshell_runtime_protocol::{
            FreshAgentProviderStartDiagnostic, RuntimeDiagnosticCode, RuntimeErrorCode,
        };

        let provider_start = super::map_fresh_agent_open_error(ActorError::ProviderStartFailed {
            diagnostic: ProviderStartDiagnostic::Authentication,
        });
        assert_eq!(provider_start.code, RuntimeErrorCode::HostUnreachable);
        assert_eq!(
            provider_start.diagnostic_code,
            Some(RuntimeDiagnosticCode::FreshAgentProviderStartFailed)
        );
        assert_eq!(
            provider_start.fresh_agent_provider_start_diagnostic,
            Some(FreshAgentProviderStartDiagnostic::Authentication)
        );
        assert_eq!(
            provider_start.message,
            "hosted fresh-agent provider failed to start (startup diagnostic: authentication)"
        );

        let secret_detail = "private-provider-output-should-not-cross-the-host-boundary";
        let other = super::map_fresh_agent_open_error(ActorError::Transport(secret_detail.into()));
        assert_eq!(other.code, RuntimeErrorCode::HostUnreachable);
        assert_eq!(
            other.diagnostic_code,
            Some(RuntimeDiagnosticCode::FreshAgentOpenFailed)
        );
        assert_eq!(other.message, "hosted fresh-agent provider failed to start");
        assert!(!other.message.contains(secret_detail));
    }

    #[cfg(unix)]
    #[test]
    fn stopped_repair_descriptor_io_keeps_system_category() {
        let mut failure = super::OpencodeRepairFailure::at("input_stream");
        assert!(
            super::read_opencode_descriptor_frame(&mut std::io::empty(), Some(&mut failure))
                .is_err()
        );
        assert_eq!(failure.class, "io");
        assert_eq!(failure.io_kind.as_deref(), Some("UnexpectedEof"));
        struct FailedWriter;
        impl std::io::Write for FailedWriter {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::from_raw_os_error(32))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let descriptor: super::OpenCodeTransferDescriptor = serde_json::from_value(serde_json::json!({
            "transferId":"synthetic", "provider":"opencode", "sourceStoreId":"source", "rootSessionId":"root",
            "sourceGeneration":"generation", "providerSchema":"schema", "sourceSchemaFingerprint":"fingerprint",
            "migrationJournalFingerprint":"migration", "destinationStoreId":"destination", "destinationDatabasePath":"database",
            "targetImageRef":"image", "targetBuildReceipt":"receipt", "incarnationId":"incarnation", "manifestJson":"{}",
            "files":[], "totalBytes":0, "bundleSha256":"digest"
        })).unwrap();
        assert!(super::write_opencode_descriptor_frame(
            &mut FailedWriter,
            &descriptor,
            Some(&mut failure)
        )
        .is_err());
        assert_eq!(failure.io_kind.as_deref(), Some("BrokenPipe"));
        assert_eq!(failure.errno, Some(32));
    }

    #[test]
    fn stopped_repair_import_reader_error_classes_emit_without_bodies() {
        use freshell_agent_runtime::opencode_transfer::OpenCodeImportError;
        if std::env::var_os("FRESHELL_TEST_STOPPED_DIAGNOSTIC_CHILD").is_some() {
            let missing = tempfile::tempdir().unwrap();
            let io = std::fs::File::open(missing.path().join("private-body-secret-sentinel"))
                .unwrap_err();
            let database = rusqlite::Connection::open_in_memory().unwrap();
            let sqlite = database
                .execute("SELECT private_body_secret_sentinel FROM absent_table", [])
                .unwrap_err();
            for (stage, error) in [
                ("import", OpenCodeImportError::Io(io)),
                ("reader", OpenCodeImportError::Sqlite(sqlite)),
                (
                    "import",
                    OpenCodeImportError::Blocked("private-body-secret-sentinel".into()),
                ),
                (
                    "reader",
                    OpenCodeImportError::Metadata("private-body-secret-sentinel".into()),
                ),
            ] {
                let mut failure = super::OpencodeRepairFailure::at(stage);
                failure.import(&error);
                failure.emit();
            }
            return;
        }
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::stopped_repair_import_reader_error_classes_emit_without_bodies",
                "--nocapture",
            ])
            .env("FRESHELL_TEST_STOPPED_DIAGNOSTIC_CHILD", "1")
            .output()
            .unwrap();
        assert!(output.status.success());
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert!(!stderr.contains("private-body-secret-sentinel"));
        let events: Vec<serde_json::Value> = stderr
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(events.len(), 4);
        for (event, class) in events.iter().zip(["io", "sqlite", "blocked", "metadata"]) {
            assert_eq!(event["event"], "session_host.opencode_repair.failed");
            assert_eq!(event["errorClass"], class);
        }
        assert_eq!(events[0]["stage"], "import");
        assert_eq!(events[0]["ioKind"], "NotFound");
        assert_eq!(events[0]["errno"], 2);
        assert_eq!(events[1]["stage"], "reader");
        assert_eq!(events[1]["sqliteCode"], 1);
    }

    #[test]
    fn stopped_repair_invalid_stage_emits_body_free_failure() {
        if std::env::var_os("FRESHELL_TEST_STOPPED_DIAGNOSTIC_CHILD").is_some() {
            assert!(super::run_opencode_stopped_repair_worker(&[
                "private-body-secret-sentinel".into()
            ])
            .is_err());
            let temp = tempfile::tempdir().unwrap();
            let args = vec![
                "--stage-dir".into(),
                temp.path()
                    .join("private-body-secret-sentinel")
                    .to_string_lossy()
                    .into_owned(),
                "--workspace-root".into(),
                temp.path().to_string_lossy().into_owned(),
                "--expected-cwd".into(),
                temp.path().to_string_lossy().into_owned(),
                "--provider-uid".into(),
                "65534".into(),
                "--provider-gid".into(),
                "0".into(),
            ];
            assert!(super::run_opencode_stopped_repair_worker(&args).is_err());
            return;
        }
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::stopped_repair_invalid_stage_emits_body_free_failure",
                "--nocapture",
            ])
            .env("FRESHELL_TEST_STOPPED_DIAGNOSTIC_CHILD", "1")
            .output()
            .unwrap();
        assert!(output.status.success());
        let stderr = String::from_utf8(output.stderr).unwrap();
        let events: Vec<serde_json::Value> = stderr
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect();
        assert_eq!(events.len(), 2);
        assert_eq!(events[1]["stage"], "stage_validation");
        assert_eq!(events[1]["errorClass"], "io");
        assert_eq!(events[1]["ioKind"], "NotFound");
        assert_eq!(events[1]["errno"], 2);
        let event = stderr
            .lines()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .find(|event| event["event"] == "session_host.opencode_repair.failed")
            .expect("actual stopped-worker validation failure must emit its safe stage");
        assert_eq!(event["severity"], "error");
        assert_eq!(event["stage"], "stage_validation");
        assert_eq!(event["errorClass"], "validation");
        assert!(!stderr.contains("private-body-secret-sentinel"));
    }

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
            &home,
            &inputs,
            &[
                (".codex/auth.json", b"first".to_vec()),
                ("unsupported", vec![])
            ],
            &[],
            uid,
            gid,
            false,
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
            &home,
            &inputs,
            &[(".codex/auth.json", b"retry".to_vec())],
            &[],
            uid,
            gid,
            false,
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
            provider_relative_path: None,

            source_path: "/private/typed-native-fixture".into(),
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
            &home,
            &root.path().join("inputs"),
            &resolved.provider_files,
            &[],
            unsafe { libc::geteuid() },
            unsafe { libc::getegid() },
            false,
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

    fn kilroy_typed_launch(workspace: &Path) -> FreshAgentLaunchSpec {
        serde_json::from_value(serde_json::json!({
            "sessionId":"kilroy-presentation", "provider":"kilroy", "sessionType":"kilroy",
            "runtimeVariant":"claude-sdk-sidecar", "providerStoreId":"kilroy-store",
            "cwd":workspace, "workspacePath":workspace,
            "runAsUid":unsafe {libc::geteuid()}, "runAsGid":unsafe {libc::getegid()},
            "providerLaunchContext":{"preparation":{"claude":{"mcp_args":[]}}, "config":[]},
            "providerSecretReferences":[{"sourcePath":"/private/claude.env", "profile":"claude_onecli_environment"},
              {"sourcePath":"/private/claude-ca.pem", "profile":"claude_onecli_ca_file"}]
        })).unwrap()
    }

    #[test]
    fn kilroy_host_resolves_only_native_claude_typed_environment_and_ca() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("provider-0"), "CLAUDE_CODE_OAUTH_TOKEN=fixture-oauth\nHTTPS_PROXY=http://192.0.2.10:10255\nNODE_EXTRA_CA_CERTS=/home/freshell/provider/.config/onecli/gateway-ca.pem\n").unwrap();
        std::fs::write(root.path().join("provider-1"), "fixture-ca").unwrap();
        let mut launch = kilroy_typed_launch(root.path());
        let resolved = provider_secret_resolution::resolve_child_secrets(
            launch.provider.native_provider(),
            &launch.provider_secret_references,
            root.path(),
        )
        .unwrap();
        assert_eq!(
            resolved
                .environment
                .get("CLAUDE_CODE_OAUTH_TOKEN")
                .map(String::as_str),
            Some("fixture-oauth")
        );
        assert_eq!(
            resolved.provider_files,
            vec![(".config/onecli/gateway-ca.pem", b"fixture-ca".to_vec())]
        );
        assert_eq!(launch.provider.as_str(), "kilroy");
        launch.provider_secret_references[0].profile =
            freshell_runtime_protocol::ProviderSecretProfile::CodexOnecliEnvironment;
        assert!(provider_secret_resolution::resolve_child_secrets(
            launch.provider.native_provider(),
            &launch.provider_secret_references,
            root.path()
        )
        .is_err());
    }

    #[test]
    fn kilroy_host_prepares_native_claude_context_without_changing_mode() {
        let root = tempfile::tempdir().unwrap();
        let private = root.path().join("private");
        let source = private.join("user-provider");
        let home = root.path().join("home");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir(&home).unwrap();
        let bytes = br#"{"permissions":{"ask":["Bash"]}}"#;
        std::fs::write(source.join("settings.json"), bytes).unwrap();
        let mut launch = kilroy_typed_launch(root.path());
        launch
            .provider_launch_context
            .as_mut()
            .unwrap()
            .config
            .push(freshell_runtime_protocol::ProviderConfigReference {
                root: freshell_runtime_protocol::ProviderConfigRoot::UserProvider,
                relative_path: "settings.json".into(),
                provider_relative_path: ".claude/settings.json".into(),
                format: "json".into(),
            });
        let paths = ProviderConfigPaths {
            private_mount: private,
            provider_home: home.clone(),
        };
        prepare_fresh_provider_context_at(&launch, &paths).unwrap();
        assert_eq!(
            std::fs::read(home.join(".claude/settings.json")).unwrap(),
            bytes
        );
        assert_eq!(launch.provider.as_str(), "kilroy");
        assert_eq!(launch.session_type, "kilroy");
        let refreshed = br#"{"permissions":{"deny":["Bash"]}}"#;
        std::fs::write(source.join("settings.json"), refreshed).unwrap();
        refresh_provider_context(
            launch.provider_launch_context.as_ref(),
            launch.provider.native_family(),
            &launch.workspace_path,
            launch.run_as_uid,
            launch.run_as_gid,
            &paths,
        )
        .unwrap();
        assert_eq!(
            std::fs::read(home.join(".claude/settings.json")).unwrap(),
            refreshed
        );
        launch.provider_launch_context.as_mut().unwrap().preparation =
            freshell_runtime_protocol::ProviderPreparation::Codex {
                tui_args: Vec::new(),
                sidecar_args: Vec::new(),
            };
        assert!(prepare_fresh_provider_context_at(&launch, &paths).is_err());
        assert_eq!(
            std::fs::read(home.join(".claude/settings.json")).unwrap(),
            refreshed
        );
    }

    #[cfg(unix)]
    #[test]
    fn fresh_selected_native_home_refreshes_completed_handoff_without_bootstrap() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let history = home.join(".claude/projects/work/native.jsonl");
        std::fs::create_dir_all(history.parent().unwrap()).unwrap();
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(&history, b"retained native history\n").unwrap();
        let before = std::fs::metadata(&history).unwrap();
        let selected = br#"{"permissions":{"deny":["Bash"]}}"#;
        std::fs::write(root.path().join("settings.json"), selected).unwrap();
        let mut launch = kilroy_typed_launch(root.path());
        launch.native_session_id = Some("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into());
        launch.provider_bootstrap_files = vec![ProviderBootstrapFile {
            source_path: "already-consumed-bootstrap".into(),
            provider_relative_path: ".claude/settings.json".into(),
        }];
        launch.provider_launch_context.as_mut().unwrap().config =
            vec![freshell_runtime_protocol::ProviderConfigReference {
                root: freshell_runtime_protocol::ProviderConfigRoot::Workspace,
                relative_path: "settings.json".into(),
                provider_relative_path: ".claude/settings.json".into(),
                format: "json".into(),
            }];
        let paths = ProviderConfigPaths {
            private_mount: root.path().join("private"),
            provider_home: home.clone(),
        };
        prepare_fresh_provider_state_at(&launch, &paths, &root.path().join("absent-bootstrap"))
            .unwrap();
        assert_eq!(
            std::fs::read(home.join(".claude/settings.json")).unwrap(),
            selected
        );
        assert_eq!(
            std::fs::read(&history).unwrap(),
            b"retained native history\n"
        );
        assert_eq!(std::fs::metadata(&history).unwrap().ino(), before.ino());
        assert_eq!(std::fs::metadata(&home).unwrap().mode() & 0o777, 0o700);

        launch.provider_launch_context.as_mut().unwrap().preparation =
            freshell_runtime_protocol::ProviderPreparation::Codex {
                tui_args: Vec::new(),
                sidecar_args: Vec::new(),
            };
        assert!(prepare_fresh_provider_state_at(
            &launch,
            &paths,
            &root.path().join("absent-bootstrap")
        )
        .is_err());
        assert_eq!(
            std::fs::read(home.join(".claude/settings.json")).unwrap(),
            selected
        );
        assert_eq!(std::fs::metadata(&history).unwrap().ino(), before.ino());
    }

    #[cfg(unix)]
    #[test]
    fn fresh_selected_native_home_refuses_incomplete_or_indirect_handoff() {
        use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
        for case in ["mode", "group", "symlink", "file"] {
            let root = tempfile::tempdir().unwrap();
            let real_home = root.path().join("home");
            std::fs::create_dir(&real_home).unwrap();
            std::fs::set_permissions(&real_home, std::fs::Permissions::from_mode(0o700)).unwrap();
            let history = real_home.join("history");
            std::fs::write(&history, b"unchanged").unwrap();
            let before = std::fs::metadata(&history).unwrap();
            let mut launch = kilroy_typed_launch(root.path());
            launch.native_session_id = Some("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into());
            let home = match case {
                "mode" => {
                    std::fs::set_permissions(&real_home, std::fs::Permissions::from_mode(0o750))
                        .unwrap();
                    real_home.clone()
                }
                "group" => {
                    launch.run_as_gid = launch.run_as_gid.wrapping_add(1);
                    real_home.clone()
                }
                "symlink" => {
                    let link = root.path().join("linked-home");
                    symlink(&real_home, &link).unwrap();
                    link
                }
                "file" => history.clone(),
                _ => unreachable!(),
            };
            let mode = std::fs::metadata(&real_home).unwrap().mode();
            let paths = ProviderConfigPaths {
                private_mount: root.path().join("private"),
                provider_home: home,
            };
            assert!(
                prepare_fresh_provider_state_at(&launch, &paths, &root.path().join("bootstrap"))
                    .is_err(),
                "{case}"
            );
            assert_eq!(std::fs::read(&history).unwrap(), b"unchanged", "{case}");
            assert_eq!(
                std::fs::metadata(&history).unwrap().ino(),
                before.ino(),
                "{case}"
            );
            assert_eq!(
                std::fs::metadata(&real_home).unwrap().mode(),
                mode,
                "{case}"
            );
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
        native_evidence: std::sync::Mutex<Option<serde_json::Value>>,
        dispatches: AtomicUsize,
        checkpoint_attempts: std::sync::Mutex<Vec<Option<String>>>,
        decisions: AtomicUsize,
        operations: AtomicUsize,
        captures: AtomicUsize,
        stops: AtomicUsize,
    }

    #[async_trait]
    impl FreshAgentTransport for RpcFixtureTransport {
        async fn native_identity_evidence(&self) -> Option<serde_json::Value> {
            self.native_evidence.lock().unwrap().clone()
        }
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

        async fn dispatch_with_checkpoint_identity(
            &self,
            request_id: &RequestId,
            _text: &str,
            _profile: &FreshAgentProfile,
            logical_attempt_id: Option<&str>,
        ) -> Result<DispatchAck, DispatchFailure> {
            self.dispatches.fetch_add(1, Ordering::SeqCst);
            self.checkpoint_attempts
                .lock()
                .unwrap()
                .push(logical_attempt_id.map(str::to_owned));
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

        async fn fork(
            &self,
            _request_id: &RequestId,
            parent_session_id: &str,
            _input: Option<serde_json::Value>,
        ) -> Result<freshell_agent_runtime::host_actor::ForkTransition, DispatchFailure> {
            self.operations.fetch_add(1, Ordering::SeqCst);
            self.publish_child_observation();
            Ok(freshell_agent_runtime::host_actor::ForkTransition {
                parent_session_id: parent_session_id.into(),
                child_session_id: "fixture-native-child".into(),
                parent_retired_by_runtime: true,
            })
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
            operation: &FreshAgentOperation,
        ) -> Result<OperationAck, OperationFailure> {
            self.operations.fetch_add(1, Ordering::SeqCst);
            let changed = matches!(operation, FreshAgentOperation::Rollback { turn_id: Some(turn), .. } if turn == "reroot");
            let cleared = matches!(operation, FreshAgentOperation::Compact { instructions: Some(instructions), .. } if instructions == "clear");
            if changed {
                self.publish_child_observation();
            } else if cleared {
                let mut evidence = self.native_evidence.lock().unwrap();
                let proof = evidence.as_mut().unwrap();
                proof["nativeSessionId"] = serde_json::json!("fixture-native-child");
                proof["nativeClear"] = serde_json::json!({
                    "previousNativeSessionId":"fixture-native-thread", "nativeSessionId":"fixture-native-child",
                });
            }
            Ok(OperationAck {
                provider_ack_id: Some(request_id.to_string()),
                native_session_id: Some(
                    if changed || cleared {
                        "fixture-native-child"
                    } else {
                        "fixture-native-thread"
                    }
                    .into(),
                ),
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

    impl RpcFixtureTransport {
        fn publish_child_observation(&self) {
            let mut evidence = self.native_evidence.lock().unwrap();
            let value = evidence.as_mut().unwrap();
            value["nativeSessionId"] = serde_json::json!("fixture-native-child");
            value["launch"]["evidenceRevision"] =
                serde_json::json!(value["launch"]["evidenceRevision"].as_u64().unwrap() + 1);
            value["launch"]["requestedNativeSessionId"] = serde_json::json!("fixture-native-child");
        }
    }

    #[tokio::test]
    async fn native_root_transition_updates_host_status_and_input_binding() {
        for (exact_parent, after_clear) in [(false, false), (true, false), (true, true)] {
            for operation in ["undo", "fork", "clear"] {
                let fork = operation == "fork";
                let clear = operation == "clear";
                let state = test_host_state();
                let binding = freshell_runtime_protocol::NativeIdentityLaunch {
                    incarnation_id: state.incarnation_id.clone(),
                    launch_nonce: "root-transition-rpc".into(),
                    evidence_revision: 7,
                    execution_generation: 1,
                    requested_native_session_id: exact_parent.then(|| {
                        if after_clear {
                            "retired-native-thread"
                        } else {
                            "fixture-native-thread"
                        }
                        .into()
                    }),
                };
                state.persisted.lock().await.native_identity_launch = Some(binding.clone());
                state.persisted.lock().await.max_execution_generation = 1;
                let mut proof = serde_json::json!({"launch":binding,"nativeSessionId":"fixture-native-thread","queryGeneration":1});
                if after_clear {
                    proof["nativeClear"] = serde_json::json!({
                        "previousNativeSessionId":"retired-native-thread", "nativeSessionId":"fixture-native-thread",
                    });
                }
                let transport = Arc::new(RpcFixtureTransport {
                    native_evidence: std::sync::Mutex::new(Some(proof)),
                    dispatches: AtomicUsize::new(0),
                    checkpoint_attempts: std::sync::Mutex::new(Vec::new()),
                    decisions: AtomicUsize::new(0),
                    operations: AtomicUsize::new(0),
                    captures: AtomicUsize::new(0),
                    stops: AtomicUsize::new(0),
                });
                let actor = freshell_agent_runtime::host_actor::FreshAgentHostActor::open(
                    state.state_dir.join("transition-agent"),
                    FreshAgentProfile {
                        provider: if clear || after_clear {
                            FreshProvider::Claude
                        } else {
                            FreshProvider::Codex
                        },
                        runtime_variant: "fixture-sdk".into(),
                        cwd: "/workspace".into(),
                        model: None,
                        effort: None,
                        permission_mode: None,
                        sandbox: None,
                        provider_store_id: "fixture-store".into(),
                        native_session_id: exact_parent.then(|| "fixture-native-thread".into()),
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
                *state.fresh_agent.lock().await = Some(actor.clone());
                let command = if fork {
                    HostCommand::FreshAgentFork {
                        incarnation_id: state.incarnation_id.clone(),
                        request_id: RequestId::new(),
                        parent_session_id: "fixture-native-thread".into(),
                        input: None,
                    }
                } else if clear {
                    HostCommand::FreshAgentCompact {
                        incarnation_id: state.incarnation_id.clone(),
                        request_id: RequestId::new(),
                        instructions: Some("clear".into()),
                        cwd: None,
                    }
                } else {
                    HostCommand::FreshAgentRollback {
                        incarnation_id: state.incarnation_id.clone(),
                        request_id: RequestId::new(),
                        direction: FreshAgentRollbackDirection::Undo,
                        mode: FreshAgentRollbackMode::ToTurn,
                        turn_id: Some("reroot".into()),
                        cwd: None,
                    }
                };
                dispatch(authenticated_host_envelope(&state, command), &state)
                    .await
                    .unwrap();
                let status = dispatch(
                    authenticated_host_envelope(
                        &state,
                        HostCommand::Status {
                            incarnation_id: state.incarnation_id.clone(),
                        },
                    ),
                    &state,
                )
                .await
                .unwrap();
                let HostResult::Status {
                    native_session_id,
                    native_identity_observation,
                    ..
                } = status
                else {
                    panic!("status")
                };
                assert_eq!(
                    native_session_id.as_deref(),
                    Some("fixture-native-child"),
                    "operation={operation} exact={exact_parent} after_clear={after_clear}"
                );
                let observation = native_identity_observation.unwrap();
                assert_eq!(
                    observation.evidence_revision,
                    if clear { 7 } else { 8 },
                    "clear keeps the launched producer; explicit native operations advance it"
                );
                assert!(observation.matches_launch(
                    state
                        .persisted
                        .lock()
                        .await
                        .native_identity_launch
                        .as_ref()
                        .unwrap()
                ));
                dispatch(
                    authenticated_host_envelope(
                        &state,
                        HostCommand::FreshAgentSend {
                            checkpoint_logical_attempt_id: None,

                            incarnation_id: state.incarnation_id.clone(),
                            request_id: RequestId::new(),
                            text: "child input".into(),
                            settings: None,
                        },
                    ),
                    &state,
                )
                .await
                .unwrap();
                assert_eq!(transport.dispatches.load(Ordering::SeqCst), 1);
                // A delayed parent producer must never reopen input for the child.
                *transport.native_evidence.lock().unwrap() = Some(
                    serde_json::json!({"launch":binding,"nativeSessionId":"fixture-native-thread","queryGeneration":1}),
                );
                assert!(ensure_current_fresh_native_observation(&state)
                    .await
                    .is_err());
                actor.stop().await.unwrap();
            }
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
    async fn fresh_agent_input_refuses_a_withdrawn_current_native_observation_before_journaling() {
        let state = test_host_state();
        let binding = freshell_runtime_protocol::NativeIdentityLaunch {
            incarnation_id: state.incarnation_id.clone(),
            launch_nonce: "current-rpc-native".into(),
            evidence_revision: 0,
            execution_generation: 1,
            requested_native_session_id: Some("fixture-native-thread".into()),
        };
        state.persisted.lock().await.native_identity_launch = Some(binding.clone());
        let transport = Arc::new(RpcFixtureTransport {
            native_evidence: std::sync::Mutex::new(Some(
                serde_json::json!({"launch":binding,"nativeSessionId":"fixture-native-thread","queryGeneration":1}),
            )),
            dispatches: AtomicUsize::new(0),
            checkpoint_attempts: std::sync::Mutex::new(Vec::new()),
            decisions: AtomicUsize::new(0),
            operations: AtomicUsize::new(0),
            captures: AtomicUsize::new(0),
            stops: AtomicUsize::new(0),
        });
        let actor = freshell_agent_runtime::host_actor::FreshAgentHostActor::open(
            state.state_dir.join("current-native-rpc-agent"),
            FreshAgentProfile {
                provider: FreshProvider::Claude,
                runtime_variant: "fixture-sdk".into(),
                cwd: "/workspace".into(),
                model: None,
                effort: None,
                permission_mode: None,
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
        *state.fresh_agent.lock().await = Some(actor.clone());
        let persisted = state.persisted.lock().await.clone();
        assert!(current_native_observation(&state, &persisted)
            .await
            .is_some());
        *transport.native_evidence.lock().unwrap() = None;
        assert_eq!(
            actor.profile().await.native_session_id.as_deref(),
            Some("fixture-native-thread")
        );
        let result = dispatch(
            authenticated_host_envelope(
                &state,
                HostCommand::FreshAgentSend {
                    checkpoint_logical_attempt_id: None,

                    incarnation_id: state.incarnation_id.clone(),
                    request_id: RequestId::parse("withdrawn-rpc-send").unwrap(),
                    text: "must not reach native input".into(),
                    settings: None,
                },
            ),
            &state,
        )
        .await;
        assert!(
            matches!(
                result,
                Err(RuntimeError {
                    code: RuntimeErrorCode::RecoveryWrongIdentity,
                    ..
                })
            ),
            "retained address without current provider evidence must refuse: {result:?}"
        );
        assert_eq!(transport.dispatches.load(Ordering::SeqCst), 0);
        assert!(!actor
            .read_events(0, 32)
            .await
            .events
            .iter()
            .any(|event| serde_json::to_string(event)
                .unwrap()
                .contains("withdrawn-rpc-send")));
        actor.stop().await.unwrap();
    }

    #[tokio::test]
    async fn authenticated_fresh_agent_rpc_keeps_one_host_owned_transport_until_explicit_stop() {
        let state = test_host_state();
        let binding = freshell_runtime_protocol::NativeIdentityLaunch {
            incarnation_id: state.incarnation_id.clone(),
            launch_nonce: "rpc-fixture-current".into(),
            evidence_revision: 0,
            execution_generation: 1,
            requested_native_session_id: Some("fixture-native-thread".into()),
        };
        state.persisted.lock().await.native_identity_launch = Some(binding.clone());
        let transport = Arc::new(RpcFixtureTransport {
            native_evidence: std::sync::Mutex::new(Some(
                serde_json::json!({"launch":binding,"nativeSessionId":"fixture-native-thread","queryGeneration":1}),
            )),
            dispatches: AtomicUsize::new(0),
            checkpoint_attempts: std::sync::Mutex::new(Vec::new()),
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

        let (mut release_client, release_server) = UnixStream::pair().unwrap();
        let serving_release = tokio::spawn(handle_connection(release_server, state.clone()));
        write_frame(
            &mut release_client,
            &authenticated_host_envelope(
                &state,
                HostCommand::FreshAgentResumePending {
                    incarnation_id: state.incarnation_id.clone(),
                },
            ),
        )
        .await
        .unwrap();
        let release: HostReply = freshell_runtime_protocol::read_frame(&mut release_client)
            .await
            .unwrap();
        serving_release.await.unwrap().unwrap();
        assert!(
            matches!(
                release.result,
                Ok(HostResult::FreshAgentCommand {
                    state: freshell_runtime_protocol::CommandState::ProviderAcked,
                    ..
                })
            ),
            "authenticated internal release must return a checked dispatch receipt: {:?}",
            release.result
        );

        let request_id = RequestId::parse("rpc-command-one").unwrap();
        let result = dispatch(
            authenticated_host_envelope(
                &state,
                HostCommand::FreshAgentSend {
                    incarnation_id: state.incarnation_id.clone(),
                    request_id: request_id.clone(),
                    text: "perform fixture work".into(),
                    settings: None,
                    checkpoint_logical_attempt_id: Some("managed-attempt-rpc-1".into()),
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
                ..
            }
            if native == "fixture-native-thread"
        ));

        assert_eq!(
            *transport.checkpoint_attempts.lock().unwrap(),
            vec![Some("managed-attempt-rpc-1".into())]
        );

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
            *state.control_fence.lock().unwrap() = HostControlFence::from(&*persisted);
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
                provider_path_inputs: Default::default(),

                native_identity_launch: None,
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
                dispatch_budget_ms: None,
            },
        );
        let error = dispatch(envelope, &state).await.unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::StaleExecutionGrant);
        let persisted = state.persisted.lock().await.clone();
        assert!(persisted.grant_id.is_none());
        assert_eq!(persisted.worker_launch_count, 0);
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum StartupStopBoundary {
        Preparation,
        PreparationFailure,
        Sidecar,
        SidecarFailure,
        PtySpawn,
        FreshOpen,
    }

    #[derive(Default)]
    struct StartupStopGate {
        entered: tokio::sync::Notify,
        released: std::sync::Mutex<bool>,
        release: std::sync::Condvar,
    }

    impl StartupStopGate {
        fn wait(&self) {
            self.entered.notify_one();
            let guard = self.released.lock().unwrap();
            drop(
                self.release
                    .wait_while(guard, |released| !*released)
                    .unwrap(),
            );
        }

        fn release(&self) {
            *self.released.lock().unwrap() = true;
            self.release.notify_all();
        }
    }

    struct StartupStopRuntime {
        gate: Arc<StartupStopGate>,
        failure: bool,
        stops: AtomicUsize,
    }

    impl freshell_codex::launch_lifecycle::CodexLaunchRuntime for StartupStopRuntime {
        fn ensure_ready(
            &self,
            _: Option<String>,
        ) -> freshell_codex::app_server::BoxFuture<
            '_,
            Result<freshell_codex::launch_lifecycle::CodexRuntimeReady, String>,
        > {
            Box::pin(async move {
                self.gate.wait();
                if self.failure {
                    Err("owned test sidecar readiness failed".into())
                } else {
                    Ok(freshell_codex::launch_lifecycle::CodexRuntimeReady {
                        ws_url: "ws://127.0.0.1:1".into(),
                    })
                }
            })
        }

        fn update_ownership_metadata(
            &self,
            _: String,
            _: u64,
        ) -> freshell_codex::app_server::BoxFuture<'_, Result<(), String>> {
            Box::pin(async { Ok(()) })
        }

        fn shutdown(&self) -> freshell_codex::app_server::BoxFuture<'_, Result<(), String>> {
            Box::pin(async move {
                self.stops.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
        }
    }

    struct StartupStopEffects {
        boundary: StartupStopBoundary,
        gate: Arc<StartupStopGate>,
        runtime: Arc<StartupStopRuntime>,
        spawns: AtomicUsize,
        actor:
            std::sync::Mutex<Option<Arc<freshell_agent_runtime::host_actor::FreshAgentHostActor>>>,
    }

    #[async_trait]
    impl GrantExecutionEffects for StartupStopEffects {
        async fn open_fresh_agent(
            &self,
            state_dir: &Path,
            launch: FreshAgentLaunchSpec,
        ) -> Result<
            Arc<freshell_agent_runtime::host_actor::FreshAgentHostActor>,
            freshell_agent_runtime::host_actor::ActorError,
        > {
            let actor = ConfigPublicationGrantEffects {
                opens: AtomicUsize::new(0),
                native_evidence: None,
            }
            .open_fresh_agent(state_dir, launch)
            .await?;
            *self.actor.lock().unwrap() = Some(actor.clone());
            self.gate.wait();
            Ok(actor)
        }
        async fn prepare_terminal(
            &self,
            terminal: TerminalLaunchSpec,
            env: &std::collections::BTreeMap<String, String>,
            plan: Option<&freshell_platform::opencode_config::OpencodeConfigPlan>,
            settings: Option<&str>,
        ) -> Result<providers::PreparedTerminal, providers::ProviderLaunchPreparationError>
        {
            let prepared = providers::prepare_terminal(terminal, env, plan, settings).await?;
            if matches!(
                self.boundary,
                StartupStopBoundary::Preparation | StartupStopBoundary::PreparationFailure
            ) {
                // Deliberately do not yield, as with the provider-owned refresh.
                self.gate.wait();
            }
            if self.boundary == StartupStopBoundary::PreparationFailure {
                return Err("owned test preparation failed".into());
            }
            Ok(prepared)
        }

        async fn start_terminal_sidecar(
            &self,
            mut prepared: providers::PreparedTerminal,
        ) -> Result<providers::PreparedTerminal, providers::ProviderLaunchPreparationError>
        {
            if matches!(
                self.boundary,
                StartupStopBoundary::Sidecar | StartupStopBoundary::SidecarFailure
            ) {
                use freshell_codex::launch_lifecycle::{
                    CodexLaunchPlanner, CodexLaunchRuntime, CodexRuntimeFactory,
                };
                let runtime = self.runtime.clone();
                let factory: CodexRuntimeFactory = Box::new(move |_| {
                    let runtime = runtime.clone();
                    Box::pin(async move { runtime as Arc<dyn CodexLaunchRuntime> })
                });
                let launched = CodexLaunchPlanner::new(factory)
                    .plan_create(&freshell_codex::launch_plan::CodexLaunchPlanInput::default())
                    .await
                    .map_err(|error| error.to_string())?;
                prepared.codex = Some(providers::PreparedCodexLaunch {
                    sidecar: launched.sidecar,
                    events: launched.events,
                    remote_args: freshell_codex::launch_plan::codex_remote_args(
                        &launched.remote_ws_url,
                    )
                    .unwrap(),
                });
            }
            Ok(prepared)
        }

        fn run_opencode_provider_helper(
            &self,
            _: &TerminalLaunchSpec,
            _: &OpenCodeTransferDescriptor,
            _: &Path,
            _: &Path,
            _: &str,
            _: Option<&Path>,
        ) -> Result<Vec<u8>, String> {
            panic!("Codex startup must not use the OpenCode helper")
        }

        async fn spawn_terminal_pty(
            &self,
            _: &Path,
            _: &IncarnationId,
            terminal: &TerminalLaunchSpec,
            _: std::collections::BTreeMap<String, String>,
            codex: Option<providers::PreparedCodexLaunch>,
            _: Option<String>,
        ) -> Result<SpawnedTerminalPty, RuntimeError> {
            self.spawns.fetch_add(1, Ordering::SeqCst);
            if self.boundary == StartupStopBoundary::PtySpawn {
                self.gate.wait();
            }
            if let Some(codex) = codex {
                codex.sidecar.shutdown().await.unwrap();
            }
            Ok(SpawnedTerminalPty {
                pid: 4242,
                terminal_id: terminal.terminal_id.clone(),
                stream_epoch: terminal.stream_id.clone(),
                hosted: None,
            })
        }
    }

    fn startup_stop_effects(boundary: StartupStopBoundary) -> Arc<StartupStopEffects> {
        let gate = Arc::new(StartupStopGate::default());
        Arc::new(StartupStopEffects {
            boundary,
            gate: gate.clone(),
            runtime: Arc::new(StartupStopRuntime {
                gate,
                failure: boundary == StartupStopBoundary::SidecarFailure,
                stops: AtomicUsize::new(0),
            }),
            spawns: AtomicUsize::new(0),
            actor: std::sync::Mutex::new(None),
        })
    }

    async fn startup_stop_over_socket(
        state: Arc<HostState>,
        command: HostCommand,
    ) -> Result<HostResult, RuntimeError> {
        let (mut client, server) = UnixStream::pair().unwrap();
        let envelope = authenticated_host_envelope(&state, command);
        let serving = tokio::spawn(handle_connection(server, state));
        write_frame(&mut client, &envelope).await.unwrap();
        let reply: HostReply = read_frame(&mut client).await.unwrap();
        serving.await.unwrap().unwrap();
        reply.result
    }

    fn startup_stop_grant(state: &HostState, root: &Path) -> HostCommand {
        let uid = unsafe { libc::geteuid() };
        let gid = unsafe { libc::getegid() };
        let terminal = serde_json::from_value(serde_json::json!({
            "terminalId":"stop-startup", "streamId":"stop-startup", "mode":"codex",
            "program":"/unused-owned-fixture", "args":[], "env":{}, "cwd":root,
            "workspacePath":root, "runAsUid":uid, "runAsGid":gid,
            "cols":80, "rows":24, "projectKey":"stop-startup"
        }))
        .unwrap();
        let resume = serde_json::from_value(serde_json::json!({
            "providerSession":{"provider":"codex","providerStoreId":"stop-startup","nativeSessionId":"ses_owned_stop_startup"},
            "mode":"codex", "runtimeVariant":"managed_terminal_pty", "program":"/unused-owned-fixture", "resumeArgv":[],
            "providerHome":"/home/freshell/provider", "cwd":root, "workspacePath":root,
            "identityProvenance":"provider_observed", "durablePosition":{}, "creationSeedRef":"owned-startup",
            "checkpointRevision":0, "allocationState":"verified_durable", "evidenceRevision":1,"neverDispatched":false
        })).unwrap();
        HostCommand::GrantExecution {
            incarnation_id: state.incarnation_id.clone(),
            soul_id: SoulId::new(),
            host_boot_id: state.host_boot_id.clone(),
            control_epoch: 7,
            execution_generation: 9,
            grant_id: GrantId::new(),
            fixture: None,
            terminal: Some(Box::new(terminal)),
            fresh_agent: None,
            resume_spec: Some(Box::new(resume)),
            native_identity_launch: None,
            provider_path_inputs: Default::default(),
            dispatch_budget_ms: None,
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn authenticated_stop_fences_blocked_startup_and_owned_sidecar_completion() {
        for boundary in [
            StartupStopBoundary::Preparation,
            StartupStopBoundary::PreparationFailure,
            StartupStopBoundary::Sidecar,
            StartupStopBoundary::SidecarFailure,
            StartupStopBoundary::PtySpawn,
        ] {
            let root = tempfile::tempdir().unwrap();
            let state = test_host_state();
            let command = startup_stop_grant(&state, root.path());
            let effects = startup_stop_effects(boundary);
            let gate = &effects.gate;
            let starting = {
                let state = state.clone();
                let command = command.clone();
                let effects = effects.clone();
                tokio::spawn(async move {
                    dispatch_with_effects(
                        authenticated_host_envelope(&state, command),
                        &state,
                        effects.as_ref(),
                    )
                    .await
                })
            };
            tokio::time::timeout(Duration::from_secs(5), gate.entered.notified())
                .await
                .unwrap();
            assert!(
                !starting.is_finished(),
                "{boundary:?}: no PID accepted before preparation/spawn completes"
            );
            let stopping = startup_stop_over_socket(
                state.clone(),
                HostCommand::Stop {
                    incarnation_id: state.incarnation_id.clone(),
                    control_epoch: 7,
                    execution_generation: 9,
                },
            );
            tokio::pin!(stopping);
            let stopped_promptly =
                tokio::time::timeout(Duration::from_millis(500), &mut stopping).await;
            let responsive = stopped_promptly.is_ok();
            gate.release();
            let started = tokio::time::timeout(Duration::from_secs(5), starting)
                .await
                .unwrap()
                .unwrap();
            let stopped = match stopped_promptly {
                Ok(result) => result,
                Err(_) => stopping.await,
            };
            assert!(matches!(stopped, Ok(HostResult::Stopped)));
            assert!(
                responsive,
                "{boundary:?}: Stop must not wait for preparation's persisted lock"
            );
            assert!(
                started.is_err(),
                "{boundary:?}: stopped startup must not return GrantAccepted"
            );
            let persisted = state.persisted.lock().await.clone();
            assert!(persisted.worker_pid.is_none(), "{boundary:?}");
            assert_eq!(persisted.worker_launch_count, 0, "{boundary:?}");
            let consumed = !matches!(
                boundary,
                StartupStopBoundary::Preparation | StartupStopBoundary::PreparationFailure
            );
            assert_eq!(persisted.grant_id.is_some(), consumed, "{boundary:?}");
            assert_eq!(
                effects.spawns.load(Ordering::SeqCst),
                usize::from(boundary == StartupStopBoundary::PtySpawn),
                "{boundary:?}"
            );
            assert_eq!(
                effects.runtime.stops.load(Ordering::SeqCst),
                usize::from(matches!(
                    boundary,
                    StartupStopBoundary::Sidecar | StartupStopBoundary::SidecarFailure
                )),
                "{boundary:?}: owned sidecar cleanup"
            );
            let error = dispatch_with_effects(
                authenticated_host_envelope(&state, command),
                &state,
                effects.as_ref(),
            )
            .await
            .unwrap_err();
            assert_eq!(
                error.code,
                RuntimeErrorCode::StaleExecutionGrant,
                "{boundary:?}: Stop/consumption prevents replay"
            );
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn stale_and_unauthenticated_stop_leave_current_startup_and_duplicate_grant_intact() {
        let root = tempfile::tempdir().unwrap();
        let state = test_host_state();
        let command = startup_stop_grant(&state, root.path());
        let effects = startup_stop_effects(StartupStopBoundary::Preparation);
        let starting = {
            let state = state.clone();
            let command = command.clone();
            let effects = effects.clone();
            tokio::spawn(async move {
                dispatch_with_effects(
                    authenticated_host_envelope(&state, command),
                    &state,
                    effects.as_ref(),
                )
                .await
            })
        };
        tokio::time::timeout(Duration::from_secs(5), effects.gate.entered.notified())
            .await
            .unwrap();
        let mut results = Vec::new();
        for (epoch, generation, incarnation, auth, expected) in [
            (
                6,
                9,
                state.incarnation_id.clone(),
                true,
                RuntimeErrorCode::StaleExecutionGrant,
            ),
            (
                7,
                8,
                state.incarnation_id.clone(),
                true,
                RuntimeErrorCode::StaleExecutionGrant,
            ),
            (
                7,
                9,
                IncarnationId::new(),
                true,
                RuntimeErrorCode::OwnershipMismatch,
            ),
            (
                7,
                9,
                state.incarnation_id.clone(),
                false,
                RuntimeErrorCode::HostAuthenticationFailed,
            ),
        ] {
            let mut envelope = authenticated_host_envelope(
                &state,
                HostCommand::Stop {
                    incarnation_id: incarnation,
                    control_epoch: epoch,
                    execution_generation: generation,
                },
            );
            if !auth {
                envelope.auth = None;
            }
            results.push((
                expected,
                tokio::time::timeout(Duration::from_millis(500), dispatch(envelope, &state)).await,
            ));
        }
        effects.gate.release();
        let accepted = tokio::time::timeout(Duration::from_secs(5), starting)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        for (expected, result) in results {
            assert_eq!(result.unwrap().unwrap_err().code, expected);
        }
        assert!(matches!(
            accepted,
            HostResult::GrantAccepted {
                worker_pid: 4242,
                worker_launch_count: 1,
                ..
            }
        ));
        let duplicate = dispatch_with_effects(
            authenticated_host_envelope(&state, command),
            &state,
            effects.as_ref(),
        )
        .await
        .unwrap();
        assert!(matches!(
            duplicate,
            HostResult::GrantAccepted {
                worker_pid: 4242,
                worker_launch_count: 1,
                ..
            }
        ));
        assert_eq!(effects.spawns.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn authenticated_stop_before_grant_prevents_dispatch_in_the_same_boot() {
        let root = tempfile::tempdir().unwrap();
        let state = test_host_state();
        let effects = startup_stop_effects(StartupStopBoundary::Preparation);
        let stopped = startup_stop_over_socket(
            state.clone(),
            HostCommand::Stop {
                incarnation_id: state.incarnation_id.clone(),
                control_epoch: 7,
                execution_generation: 9,
            },
        )
        .await
        .unwrap();
        assert!(matches!(stopped, HostResult::Stopped));
        let error = dispatch_with_effects(
            authenticated_host_envelope(&state, startup_stop_grant(&state, root.path())),
            &state,
            effects.as_ref(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::StaleExecutionGrant);
        let persisted = state.persisted.lock().await;
        assert!(persisted.grant_id.is_none());
        assert!(persisted.worker_pid.is_none());
        assert_eq!(persisted.worker_launch_count, 0);
        assert_eq!(effects.spawns.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn authenticated_stop_cleans_fresh_actor_opened_after_stop_acknowledgement() {
        if run_in_fresh_host_test_process(
            "tests::authenticated_stop_cleans_fresh_actor_opened_after_stop_acknowledgement",
        ) {
            return;
        }
        let root = tempfile::tempdir().unwrap();
        let mut state = test_host_state();
        let home = root.path().join("home");
        std::fs::create_dir(&home).unwrap();
        Arc::get_mut(&mut state).unwrap().provider_config_paths = ProviderConfigPaths {
            private_mount: root.path().join("private"),
            provider_home: home,
        };
        let mut command = startup_stop_grant(&state, root.path());
        if let HostCommand::GrantExecution {
            terminal,
            fresh_agent,
            resume_spec,
            ..
        } = &mut command
        {
            *terminal = None;
            *resume_spec = None;
            *fresh_agent = Some(Box::new(serde_json::from_value(serde_json::json!({
                "sessionId":"owned-stop-startup", "provider":"claude", "sessionType":"freshclaude",
                "runtimeVariant":"freshclaude", "providerStoreId":"owned-stop-startup", "cwd":root.path(),
                "workspacePath":root.path(), "runAsUid":unsafe { libc::geteuid() }, "runAsGid":unsafe { libc::getegid() },
            })).unwrap()));
        }
        let effects = startup_stop_effects(StartupStopBoundary::FreshOpen);
        let starting = {
            let state = state.clone();
            let command = command.clone();
            let effects = effects.clone();
            tokio::spawn(async move {
                dispatch_with_effects(
                    authenticated_host_envelope(&state, command),
                    &state,
                    effects.as_ref(),
                )
                .await
            })
        };
        tokio::time::timeout(Duration::from_secs(5), effects.gate.entered.notified())
            .await
            .unwrap();
        let stop = tokio::time::timeout(
            Duration::from_millis(500),
            startup_stop_over_socket(
                state.clone(),
                HostCommand::Stop {
                    incarnation_id: state.incarnation_id.clone(),
                    control_epoch: 7,
                    execution_generation: 9,
                },
            ),
        )
        .await;
        effects.gate.release();
        let started = tokio::time::timeout(Duration::from_secs(5), starting)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(stop.unwrap().unwrap(), HostResult::Stopped));
        assert_eq!(
            started.unwrap_err().code,
            RuntimeErrorCode::StaleExecutionGrant
        );
        let actor = effects.actor.lock().unwrap().clone().unwrap();
        assert!(
            !actor.is_live().await,
            "locally owned late actor must receive stop"
        );
        assert!(state.fresh_agent.lock().await.is_none());
        let persisted = state.persisted.lock().await;
        assert!(persisted.grant_id.is_some());
        assert!(persisted.worker_pid.is_none());
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

    #[cfg(feature = "fresh-agent-fixtures")]
    struct FixtureRootGrantEffects {
        opens: AtomicUsize,
    }

    #[cfg(feature = "fresh-agent-fixtures")]
    #[async_trait]
    impl GrantExecutionEffects for FixtureRootGrantEffects {
        async fn prepare_fresh_agent_child_environment(
            &self,
            launch: &FreshAgentLaunchSpec,
            environment: &mut std::collections::BTreeMap<String, String>,
            prepared_opencode_plan: Option<&freshell_platform::opencode_config::OpencodeConfigPlan>,
        ) -> Result<(), String> {
            if launch.provider == FreshProvider::Opencode {
                assert_eq!(
                    launch.fixture_transport,
                    Some(freshell_runtime_protocol::FreshAgentFixtureTransport::Deterministic)
                );
                assert!(environment.is_empty());
                // The native feature worker needs an enclosure filesystem and
                // executable. This test owns only the deterministic actor/store.
                Ok(())
            } else {
                providers::prepare_fresh_agent_child_environment(
                    launch,
                    environment,
                    prepared_opencode_plan,
                )
                .await
            }
        }

        fn run_opencode_provider_helper(
            &self,
            _: &TerminalLaunchSpec,
            _: &OpenCodeTransferDescriptor,
            _: &Path,
            _: &Path,
            _: &str,
            _: Option<&Path>,
        ) -> Result<Vec<u8>, String> {
            panic!("fixture fresh grant must not run a terminal helper")
        }

        async fn spawn_terminal_pty(
            &self,
            _: &Path,
            _: &IncarnationId,
            _: &TerminalLaunchSpec,
            _: std::collections::BTreeMap<String, String>,
            _: Option<providers::PreparedCodexLaunch>,
            _: Option<String>,
        ) -> Result<SpawnedTerminalPty, RuntimeError> {
            panic!("fixture fresh grant must not spawn a PTY")
        }

        async fn open_fresh_agent(
            &self,
            state_dir: &Path,
            launch: FreshAgentLaunchSpec,
        ) -> Result<
            Arc<freshell_agent_runtime::host_actor::FreshAgentHostActor>,
            freshell_agent_runtime::host_actor::ActorError,
        > {
            self.opens.fetch_add(1, Ordering::SeqCst);
            let profile = FreshAgentProfile {
                provider: launch.provider,
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
            };
            let transport =
                providers::deterministic_fresh_agent::DeterministicFreshAgentTransport::open(
                    state_dir.join("fixture-provider"),
                    &profile,
                    launch.run_as_uid,
                    launch.run_as_gid,
                )
                .await
                .map_err(freshell_agent_runtime::host_actor::ActorError::Transport)?;
            freshell_agent_runtime::host_actor::FreshAgentHostActor::open_deterministic_fixture(
                state_dir.join("fixture-actor"),
                profile,
                transport,
            )
            .await
        }
    }

    #[cfg(feature = "fresh-agent-fixtures")]
    fn fixture_grant_host(root: &Path) -> Arc<HostState> {
        let mut state = test_host_state();
        let host = Arc::get_mut(&mut state).unwrap();
        // Replace only the empty directory just created by this test helper;
        // all actual grant/actor/provider files belong to the TempDir owner.
        std::fs::remove_dir(&host.state_dir).unwrap();
        host.state_dir = root.join("host");
        std::fs::create_dir(&host.state_dir).unwrap();
        host.provider_config_paths.provider_home = root.join("home");
        std::fs::create_dir(&host.provider_config_paths.provider_home).unwrap();
        state
    }

    #[cfg(feature = "fresh-agent-fixtures")]
    fn fixture_root_grant(
        state: &HostState,
        provider: FreshProvider,
        grant_id: GrantId,
    ) -> HostCommand {
        let session_type = match provider {
            FreshProvider::Claude => "freshclaude",
            FreshProvider::Kilroy => "kilroy",
            FreshProvider::Codex => "freshcodex",
            FreshProvider::Opencode => "freshopencode",
        };
        let launch: FreshAgentLaunchSpec = serde_json::from_value(serde_json::json!({
            "sessionId":"original-fixture-presentation", "provider":provider,
            "sessionType":session_type, "runtimeVariant":session_type,
            "providerStoreId":"fixture-grant-store", "cwd":state.state_dir,
            "workspacePath":state.state_dir, "runAsUid":unsafe { libc::getuid() },
            "runAsGid":unsafe { libc::getgid() }, "fixtureTransport":"deterministic"
        }))
        .unwrap();
        HostCommand::GrantExecution {
            provider_path_inputs: Default::default(),

            native_identity_launch: None,
            incarnation_id: state.incarnation_id.clone(),
            soul_id: SoulId::new(),
            host_boot_id: state.host_boot_id.clone(),
            control_epoch: 7,
            execution_generation: 9,
            grant_id,
            fixture: None,
            terminal: None,
            fresh_agent: Some(Box::new(launch)),
            resume_spec: None,
            dispatch_budget_ms: None,
        }
    }

    #[cfg(feature = "fresh-agent-fixtures")]
    #[tokio::test]
    async fn fixture_grant_publishes_actual_root_initial_and_idempotent_all_four() {
        // A session host installs one immutable child environment per process.
        // Exercise each allocation in its own process, just like real hosts.
        const PROVIDER_ENV: &str = "FRESHELL_FIXTURE_GRANT_TEST_PROVIDER";
        let selected = std::env::var(PROVIDER_ENV).ok();
        if selected.is_none() {
            for provider in ["claude", "kilroy", "codex", "opencode"] {
                let status = std::process::Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", "tests::fixture_grant_publishes_actual_root_initial_and_idempotent_all_four", "--nocapture"])
                    .env(PROVIDER_ENV, provider).status().unwrap();
                assert!(status.success(), "actual {provider} fixture grant failed");
            }
            return;
        }
        let mut observations = Vec::new();
        for provider in [
            FreshProvider::Claude,
            FreshProvider::Kilroy,
            FreshProvider::Codex,
            FreshProvider::Opencode,
        ] {
            if selected.as_deref() != Some(provider.as_str()) {
                continue;
            }
            let root = tempfile::tempdir().unwrap();
            let state = fixture_grant_host(root.path());
            let effects = FixtureRootGrantEffects {
                opens: AtomicUsize::new(0),
            };
            let command = fixture_root_grant(&state, provider.clone(), GrantId::new());
            for invalid_binding in [
                freshell_runtime_protocol::NativeIdentityLaunch {
                    incarnation_id: IncarnationId::new(),
                    launch_nonce: "fixture-grant".into(),
                    evidence_revision: 0,
                    execution_generation: 9,
                    requested_native_session_id: None,
                },
                freshell_runtime_protocol::NativeIdentityLaunch {
                    incarnation_id: state.incarnation_id.clone(),
                    launch_nonce: "fixture-grant".into(),
                    evidence_revision: 0,
                    execution_generation: 8,
                    requested_native_session_id: None,
                },
                freshell_runtime_protocol::NativeIdentityLaunch {
                    incarnation_id: state.incarnation_id.clone(),
                    launch_nonce: String::new(),
                    evidence_revision: 0,
                    execution_generation: 9,
                    requested_native_session_id: None,
                },
            ] {
                let mut invalid = command.clone();
                if let HostCommand::GrantExecution {
                    native_identity_launch,
                    ..
                } = &mut invalid
                {
                    *native_identity_launch = Some(invalid_binding);
                }
                let error = dispatch_with_effects(
                    authenticated_host_envelope(&state, invalid),
                    &state,
                    &effects,
                )
                .await
                .unwrap_err();
                assert_eq!(error.code, RuntimeErrorCode::RecoveryWrongIdentity);
                assert!(state.persisted.lock().await.grant_id.is_none());
                assert_eq!(effects.opens.load(Ordering::SeqCst), 0);
            }
            let initial = dispatch_with_effects(
                authenticated_host_envelope(&state, command.clone()),
                &state,
                &effects,
            )
            .await;
            let actor = state.fresh_agent.lock().await.clone().unwrap_or_else(|| {
                panic!("actual {provider:?} grant must start the deterministic actor: {initial:?}")
            });
            let observed = actor
                .observed_native_session_id()
                .await
                .expect("actual live fixture root");
            let replay = dispatch_with_effects(
                authenticated_host_envelope(&state, command.clone()),
                &state,
                &effects,
            )
            .await;
            let status = dispatch(
                authenticated_host_envelope(
                    &state,
                    HostCommand::Status {
                        incarnation_id: state.incarnation_id.clone(),
                    },
                ),
                &state,
            )
            .await;
            let mut refusals = Vec::new();
            for field in ["epoch", "generation", "grant", "boot", "incarnation"] {
                let mut invalid = command.clone();
                if let HostCommand::GrantExecution {
                    control_epoch,
                    execution_generation,
                    grant_id,
                    host_boot_id,
                    incarnation_id,
                    ..
                } = &mut invalid
                {
                    match field {
                        "epoch" => *control_epoch -= 1,
                        "generation" => *execution_generation -= 1,
                        "grant" => *grant_id = GrantId::new(),
                        "boot" => *host_boot_id = HostBootId::new(),
                        "incarnation" => *incarnation_id = IncarnationId::new(),
                        _ => unreachable!(),
                    }
                }
                refusals.push((
                    field,
                    dispatch_with_effects(
                        authenticated_host_envelope(&state, invalid),
                        &state,
                        &effects,
                    )
                    .await,
                ));
            }
            let same_actor = Arc::ptr_eq(&actor, state.fresh_agent.lock().await.as_ref().unwrap());
            let replay_root = actor.observed_native_session_id().await;
            let native_evidence = actor.observed_native_identity_evidence().await;
            actor.clone().stop().await.unwrap();
            assert!(
                !actor.is_live().await,
                "owned fixture worker must be stopped"
            );
            assert!(same_actor);
            assert_eq!(replay_root.as_ref(), Some(&observed));
            assert!(native_evidence.is_none());
            assert!(
                matches!(status.unwrap(), HostResult::Status { native_session_id: Some(ref native), native_identity_observation: None, .. } if native == &observed),
                "fixture grant and status must publish the same actual root"
            );
            for (field, result) in refusals {
                assert_eq!(
                    result.unwrap_err().code,
                    if field == "incarnation" {
                        RuntimeErrorCode::OwnershipMismatch
                    } else {
                        RuntimeErrorCode::StaleExecutionGrant
                    }
                );
            }
            let provider_state: serde_json::Value = serde_json::from_slice(
                &std::fs::read(
                    state
                        .state_dir
                        .join("fixture-provider/provider-native-state.json"),
                )
                .unwrap(),
            )
            .unwrap();
            assert_eq!(provider_state["dispatchCount"], 0);
            assert_eq!(provider_state["completionCount"], 0);
            assert_eq!(effects.opens.load(Ordering::SeqCst), 1);
            assert_eq!(state.persisted.lock().await.worker_launch_count, 1);
            let stopped = dispatch_with_effects(
                authenticated_host_envelope(&state, command.clone()),
                &state,
                &effects,
            )
            .await;
            state.fresh_agent.lock().await.take();
            let absent = dispatch_with_effects(
                authenticated_host_envelope(&state, command),
                &state,
                &effects,
            )
            .await;
            observations.push((provider, observed, initial, replay, stopped, absent));
        }
        for (provider, observed, initial, replay, stopped, absent) in observations {
            for result in [initial, replay] {
                match result.unwrap() {
                    HostResult::GrantAccepted {
                        native_session_id,
                        native_identity_observation,
                        worker_launch_count,
                        ..
                    } => {
                        assert_eq!(
                            native_session_id.as_ref(),
                            Some(&observed),
                            "grant must publish actual {provider:?} fixture root"
                        );
                        assert!(
                            native_identity_observation.is_none(),
                            "fixture root cannot certify native identity"
                        );
                        assert_eq!(worker_launch_count, 1);
                    }
                    other => panic!("unexpected fixture grant result: {other:?}"),
                }
            }
            for result in [stopped, absent] {
                assert!(matches!(
                    result.unwrap(),
                    HostResult::GrantAccepted {
                        native_session_id: None,
                        native_identity_observation: None,
                        worker_launch_count: 1,
                        ..
                    }
                ));
            }
        }
    }

    #[cfg(feature = "fresh-agent-fixtures")]
    #[tokio::test]
    async fn fixture_grant_nonfixture_raw_root_does_not_publish_native_authority() {
        const CHILD_ENV: &str = "FRESHELL_NONFIXTURE_GRANT_TEST_CHILD";
        let selected = std::env::var(CHILD_ENV).ok();
        if selected.is_none() {
            for proof in ["absent", "current", "wrong-root", "wrong-launch"] {
                let status = std::process::Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", "tests::fixture_grant_nonfixture_raw_root_does_not_publish_native_authority", "--nocapture"])
                    .env(CHILD_ENV, proof).status().unwrap();
                assert!(
                    status.success(),
                    "nonfixture proof boundary failed: {proof}"
                );
            }
            return;
        }
        let root = tempfile::tempdir().unwrap();
        let state = fixture_grant_host(root.path());
        let mut command = fixture_root_grant(&state, FreshProvider::Claude, GrantId::new());
        let binding = freshell_runtime_protocol::NativeIdentityLaunch {
            incarnation_id: state.incarnation_id.clone(),
            launch_nonce: "nonfixture-grant".into(),
            evidence_revision: 0,
            execution_generation: 9,
            requested_native_session_id: None,
        };
        if let HostCommand::GrantExecution {
            fresh_agent,
            native_identity_launch,
            ..
        } = &mut command
        {
            fresh_agent.as_mut().unwrap().fixture_transport = None;
            *native_identity_launch = Some(binding.clone());
        }
        let mut native_evidence = serde_json::json!({"launch":binding,"nativeSessionId":"fixture-native-thread","queryGeneration":1});
        if selected.as_deref() == Some("wrong-root") {
            native_evidence["nativeSessionId"] = serde_json::json!("another-root");
        }
        if selected.as_deref() == Some("wrong-launch") {
            native_evidence["launch"]["launchNonce"] = serde_json::json!("another-launch");
        }
        let expects_proof = selected.as_deref() == Some("current");
        let effects = ConfigPublicationGrantEffects {
            opens: AtomicUsize::new(0),
            native_evidence: (selected.as_deref() != Some("absent")).then_some(native_evidence),
        };
        let initial = dispatch_with_effects(
            authenticated_host_envelope(&state, command.clone()),
            &state,
            &effects,
        )
        .await;
        let actor = state.fresh_agent.lock().await.clone().unwrap();
        let raw = actor.observed_native_session_id().await;
        let evidence = actor.observed_native_identity_evidence().await;
        let replay = dispatch_with_effects(
            authenticated_host_envelope(&state, command),
            &state,
            &effects,
        )
        .await;
        actor.clone().stop().await.unwrap();
        assert!(!actor.is_live().await);
        state.fresh_agent.lock().await.take();
        assert_eq!(raw.as_deref(), Some("fixture-native-thread"));
        assert_eq!(evidence.is_some(), selected.as_deref() != Some("absent"));
        assert_eq!(effects.opens.load(Ordering::SeqCst), 1);
        for result in [initial, replay] {
            match result.unwrap() {
                HostResult::GrantAccepted {
                    native_session_id,
                    native_identity_observation,
                    worker_launch_count,
                    ..
                } => {
                    assert_eq!(
                        native_session_id.as_deref(),
                        expects_proof.then_some("fixture-native-thread")
                    );
                    assert_eq!(native_identity_observation.is_some(), expects_proof);
                    if let Some(observation) = native_identity_observation {
                        assert!(observation.matches_launch(&binding));
                    }
                    assert_eq!(worker_launch_count, 1);
                }
                other => panic!("unexpected nonfixture grant result: {other:?}"),
            }
        }
        let journal: serde_json::Value = serde_json::from_slice(
            &std::fs::read(
                state
                    .state_dir
                    .join("publication-agent/fresh-agent-state.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(journal["commands"], serde_json::json!({}));
    }

    struct ConfigPublicationGrantEffects {
        opens: AtomicUsize,
        native_evidence: Option<serde_json::Value>,
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
            _: Option<String>,
        ) -> Result<SpawnedTerminalPty, RuntimeError> {
            panic!("fresh publication must not spawn a PTY")
        }

        async fn open_fresh_agent(
            &self,
            state_dir: &Path,
            launch: FreshAgentLaunchSpec,
        ) -> Result<
            Arc<freshell_agent_runtime::host_actor::FreshAgentHostActor>,
            freshell_agent_runtime::host_actor::ActorError,
        > {
            self.opens.fetch_add(1, Ordering::SeqCst);
            let transport = Arc::new(RpcFixtureTransport {
                native_evidence: std::sync::Mutex::new(self.native_evidence.clone()),
                dispatches: AtomicUsize::new(0),
                checkpoint_attempts: std::sync::Mutex::new(Vec::new()),
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
        }
    }

    #[tokio::test]
    async fn provider_config_fresh_exact_resume_grant_blocks_before_transport_and_repairs() {
        if run_in_fresh_host_test_process(
            "tests::provider_config_fresh_exact_resume_grant_blocks_before_transport_and_repairs",
        ) {
            return;
        }
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
            prepared_inputs: None,

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
            claude_fork: None,
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
            native_evidence: None,
        };
        let hidden = root.path().join("unavailable");
        std::fs::rename(&source, &hidden).unwrap();
        let error = dispatch_with_effects(
            authenticated_host_envelope(
                &state,
                HostCommand::GrantExecution {
                    provider_path_inputs: Default::default(),

                    native_identity_launch: None,
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
                    dispatch_budget_ms: None,
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
                    provider_path_inputs: Default::default(),

                    native_identity_launch: None,
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
                    dispatch_budget_ms: None,
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
    async fn hosted_provider_uses_image_path_and_preserves_explicit_path() {
        use std::os::unix::fs::PermissionsExt;
        if std::env::var_os("FRESHELL_NATIVE_PATH_TEST_ROOT").is_none() {
            let root = executable_fixture();
            for (directory, marker) in [
                ("image-bin", "image-path"),
                ("selected-bin", "selected-path"),
            ] {
                let bin = root.path().join(directory);
                std::fs::create_dir(&bin).unwrap();
                let executable = bin.join("owned-provider-fixture");
                std::fs::write(
                    &executable,
                    format!("#!/bin/sh\nprintf '{marker}\\n'\nprintf 'home=%s\\n' \"$HOME\"\n"),
                )
                .unwrap();
                std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755))
                    .unwrap();
                std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
            let output = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "tests::hosted_provider_uses_image_path_and_preserves_explicit_path",
                    "--nocapture",
                ])
                .env("FRESHELL_NATIVE_PATH_TEST_ROOT", root.path())
                .env(
                    "PATH",
                    format!("{}:/usr/bin:/bin", root.path().join("image-bin").display()),
                )
                .output()
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
        let root = PathBuf::from(std::env::var_os("FRESHELL_NATIVE_PATH_TEST_ROOT").unwrap());
        for (path_override, home_override, expected) in [
            (None, true, "image-path"),
            (Some(root.join("selected-bin")), true, "selected-path"),
            (None, false, "image-path"),
        ] {
            let state = test_host_state();
            let uid = unsafe { libc::geteuid() };
            let mut env: std::collections::BTreeMap<String, String> =
                std::collections::BTreeMap::from([(
                    "HOME".into(),
                    root.to_string_lossy().into_owned(),
                )]);
            if let Some(path) = path_override {
                env.insert("PATH".into(), path.to_string_lossy().into_owned());
            }
            if !home_override {
                env.remove("HOME");
            }
            let launch: TerminalLaunchSpec = serde_json::from_value(serde_json::json!({
                "terminalId":"native-path", "streamId":"native-path", "mode":"claude", "program":"owned-provider-fixture", "args":[],
                "cwd":root, "workspacePath":root, "projectKey":"owned-path", "cols":80, "rows":24,
                "runAsUid":if uid==0 {65534} else {uid}, "runAsGid":unsafe {libc::getegid()}, "env":env
            })).unwrap();
            let pty = HostedPty::spawn(
                &state.state_dir,
                state.incarnation_id.clone(),
                &launch,
                Default::default(),
                None,
                None,
                None,
            )
            .await
            .unwrap();
            for _ in 0..100 {
                if pty.exited() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            assert!(pty.exited());
            let output = pty
                .read_output(state.incarnation_id.clone(), 0, 65536, None)
                .unwrap();
            assert_eq!(pty.exit_code(), 0);
            assert!(output
                .frames
                .iter()
                .any(|frame| frame.data.contains(expected)));
            let expected_home = if home_override {
                root.to_string_lossy().into_owned()
            } else {
                "/home/freshell/provider".into()
            };
            assert!(output
                .frames
                .iter()
                .any(|frame| frame.data.contains(&format!("home={expected_home}"))));
        }
    }

    #[tokio::test]
    async fn managed_codex_default_spawn_skips_native_update_gate_for_create_and_resume() {
        use std::os::unix::fs::PermissionsExt;
        let root = executable_fixture();
        let program = root.path().join("owned-native-startup");
        std::fs::write(&program, r#"#!/usr/bin/python3
import sys
args=sys.argv[1:]
updates=[args[i+1] for i,arg in enumerate(args[:-1]) if arg=='-c' and args[i+1].startswith('check_for_update_on_startup=')]
if len(updates)>1:
 print('duplicate-update-setting');sys.exit(9)
if updates!=['check_for_update_on_startup=false']:
 print('native-update-input-gate');sys.exit(7)
if '--model' not in args or args[args.index('--model')+1]!='gpt-5.6-luna':
 print('selected-model-lost');sys.exit(8)
if 'resume' in args and args[args.index('resume')+1]!='owned-native-root':
 print('resume-root-lost');sys.exit(8)
print('native-startup-without-update-input')
"#).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        let config = root.path().join("selected-native-config");
        std::fs::write(&config, b"ordinary selected profile remains untouched\n").unwrap();
        for (mode, managed, resume, caller_setting, expected_exit) in [
            ("codex", true, false, false, 0),
            ("codex", true, true, false, 0),
            ("codex", true, true, true, 0),
            ("codex", false, false, false, 7),
            ("codex", false, true, true, 0),
            ("shell", true, false, false, 7),
        ] {
            let state = test_host_state();
            let mut args = vec!["--model", "gpt-5.6-luna"];
            if caller_setting {
                args.extend(["-c", "check_for_update_on_startup=false"]);
            }
            if resume {
                args.extend(["resume", "owned-native-root"]);
            }
            let launch: TerminalLaunchSpec = serde_json::from_value(serde_json::json!({
                "terminalId":"owned-update", "streamId":"owned-update", "mode":mode, "program":program,
                "args":args, "cwd":root.path(), "workspacePath":root.path(), "projectKey":"owned-update",
                "cols":80, "rows":24, "runAsUid":unsafe {libc::geteuid()}, "runAsGid":unsafe {libc::getegid()},
                "env":{"HOME":root.path(),"PATH":"/usr/bin:/bin"}
            })).unwrap();
            let binding = freshell_runtime_protocol::NativeIdentityLaunch {
                incarnation_id: state.incarnation_id.clone(),
                launch_nonce: "owned-update-launch".into(),
                evidence_revision: 0,
                execution_generation: 1,
                requested_native_session_id: None,
            };
            let child_env = if managed {
                std::collections::BTreeMap::from([(
                    providers::native_identity::LAUNCH_ENV.into(),
                    serde_json::to_string(&binding).unwrap(),
                )])
            } else {
                Default::default()
            };
            let pty = HostedPty::spawn(
                &state.state_dir,
                state.incarnation_id.clone(),
                &launch,
                child_env,
                None,
                None,
                None,
            )
            .await
            .unwrap();
            for _ in 0..100 {
                if pty.exited() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            assert!(pty.exited(), "owned child must finish without user input");
            let output = pty
                .read_output(state.incarnation_id.clone(), 0, 65536, None)
                .unwrap();
            assert_eq!(
                pty.exit_code(),
                expected_exit,
                "mode={mode} managed={managed} resume={resume} caller={caller_setting}: {output:?}"
            );
            assert!(output
                .frames
                .iter()
                .any(|frame| frame.data.contains(if expected_exit == 0 {
                    "native-startup-without-update-input"
                } else {
                    "native-update-input-gate"
                })));
            assert_eq!(
                std::fs::read(&config).unwrap(),
                b"ordinary selected profile remains untouched\n"
            );
            assert!(
                pty.native_identity_observation().is_none(),
                "controlled child is not provider identity evidence"
            );
        }
    }

    #[tokio::test]
    async fn managed_opencode_default_spawn_keeps_image_pin_before_native_startup() {
        use std::os::unix::fs::PermissionsExt;
        let root = executable_fixture();
        let program = root.path().join("owned-opencode-startup");
        std::fs::write(&program, r#"#!/usr/bin/python3
import os,sys
args=sys.argv[1:]
if '--model' not in args or args[args.index('--model')+1]!='openai/gpt-5.6-luna':sys.exit(8)
if '--session' in args and args[args.index('--session')+1]!='ses_ownedroot':sys.exit(9)
print('native-startup-without-update-input' if os.environ.get('OPENCODE_DISABLE_AUTOUPDATE')=='true' else 'native-update-input-gate')
sys.exit(0 if os.environ.get('OPENCODE_DISABLE_AUTOUPDATE')=='true' else 7)
"#).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        let config = root.path().join("ordinary-native-settings");
        std::fs::write(&config, b"selected ordinary settings\n").unwrap();
        for (mode, managed, resume, caller_setting, expected_exit) in [
            ("opencode", true, false, None, 0),
            ("opencode", true, true, None, 0),
            ("opencode", true, true, Some("false"), 0),
            ("opencode", true, false, Some("true"), 0),
            ("opencode", false, false, None, 7),
            ("opencode", false, true, Some("false"), 7),
            ("opencode", false, true, Some("true"), 0),
            ("shell", true, false, None, 7),
        ] {
            let state = test_host_state();
            let mut args = vec!["--model", "openai/gpt-5.6-luna"];
            if resume {
                args.extend(["--session", "ses_ownedroot"]);
            }
            let mut launch: TerminalLaunchSpec = serde_json::from_value(serde_json::json!({
                "terminalId":"owned-pinned-startup", "streamId":"owned-pinned-startup", "mode":mode, "program":program,
                "args":args, "cwd":root.path(), "workspacePath":root.path(), "projectKey":"owned-pinned-startup",
                "cols":80, "rows":24, "runAsUid":unsafe {libc::geteuid()}, "runAsGid":unsafe {libc::getegid()},
                "env":{"HOME":root.path(),"PATH":"/usr/bin:/bin"}, "resumeSessionId":resume.then_some("ses_ownedroot")
            })).unwrap();
            if let Some(setting) = caller_setting {
                launch
                    .env
                    .insert("OPENCODE_DISABLE_AUTOUPDATE".into(), setting.into());
            }
            let binding = freshell_runtime_protocol::NativeIdentityLaunch {
                incarnation_id: state.incarnation_id.clone(),
                launch_nonce: "owned-pinned-launch".into(),
                evidence_revision: 0,
                execution_generation: 1,
                requested_native_session_id: resume.then(|| "ses_ownedroot".into()),
            };
            let child_env = if managed {
                std::collections::BTreeMap::from([(
                    providers::native_identity::LAUNCH_ENV.into(),
                    serde_json::to_string(&binding).unwrap(),
                )])
            } else {
                Default::default()
            };
            let pty = HostedPty::spawn(
                &state.state_dir,
                state.incarnation_id.clone(),
                &launch,
                child_env,
                None,
                None,
                None,
            )
            .await
            .unwrap();
            for _ in 0..100 {
                if pty.exited() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            assert!(pty.exited(), "owned child must finish before input");
            let output = pty
                .read_output(state.incarnation_id.clone(), 0, 65536, None)
                .unwrap();
            assert_eq!(pty.exit_code(), expected_exit, "mode={mode} managed={managed} resume={resume} caller={caller_setting:?}: {output:?}");
            assert!(output
                .frames
                .iter()
                .any(|frame| frame.data.contains(if expected_exit == 0 {
                    "native-startup-without-update-input"
                } else {
                    "native-update-input-gate"
                })));
            assert_eq!(
                std::fs::read(&config).unwrap(),
                b"selected ordinary settings\n"
            );
            assert!(
                pty.native_identity_observation().is_none(),
                "controlled child supplies no native identity proof"
            );
        }
    }

    #[tokio::test]
    async fn controlled_claude_parity_uses_configured_current_native_channels_before_input() {
        use std::os::unix::fs::PermissionsExt;
        let node = std::process::Command::new("node")
            .args(["-p", "process.execPath"])
            .output()
            .unwrap();
        assert!(node.status.success());
        let node = String::from_utf8(node.stdout).unwrap().trim().to_string();
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        for case in [
            "startup",
            "resume",
            "missing-settings",
            "disabled-hooks",
            "wrong-root",
            "stale-launch",
        ] {
            let owned = executable_fixture();
            // The shared parity child also reads its selected executable
            // resource. Supply this test's actual owned consumer before asking
            // it to exercise the native startup channels.
            let resource = owned.path().join(".claude/plugins/parity-environment");
            std::fs::create_dir_all(&resource).unwrap();
            let command = resource.join("command");
            std::fs::write(&command, "#!/bin/sh\nprintf '{}\\n'\n").unwrap();
            std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o700)).unwrap();
            let root = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
            let actual = if case == "wrong-root" {
                "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
            } else {
                root
            };
            let provider = owned.path().join("parity-claude");
            let source = owned.path().join("source");
            std::fs::create_dir(&source).unwrap();
            let producer = source.join("parity-claude");
            std::fs::copy(
                repo.join("test/fixtures/providers/parity-provider.mjs"),
                &producer,
            )
            .unwrap();
            std::fs::write(
                &provider,
                format!(
                    "#!/bin/sh\nexec '{}' '{}' \"$@\"\n",
                    node,
                    producer.display()
                ),
            )
            .unwrap();
            std::fs::set_permissions(&provider, std::fs::Permissions::from_mode(0o755)).unwrap();
            let module = repo
                .join("crates/freshell-claude-sidecar/native-session-channel.mjs")
                .canonicalize()
                .unwrap();
            let binary = owned.path().join("bin");
            std::fs::create_dir(&binary).unwrap();
            let wrapper = binary.join("node");
            let state = test_host_state();
            let binding = freshell_runtime_protocol::NativeIdentityLaunch {
                incarnation_id: state.incarnation_id.clone(),
                launch_nonce: format!("parity-{case}"),
                evidence_revision: 2,
                execution_generation: 1,
                requested_native_session_id: Some(root.into()),
            };
            let stale = if case == "stale-launch" {
                let mut previous = binding.clone();
                previous.launch_nonce = "previous-launch".into();
                format!(
                    "export FRESHELL_NATIVE_IDENTITY_LAUNCH='{}'\n",
                    serde_json::to_string(&previous).unwrap()
                )
            } else {
                String::new()
            };
            std::fs::write(
                &wrapper,
                format!(
                    "#!/bin/sh\nshift\n{stale}exec '{}' '{}' \"$@\"\n",
                    node,
                    module.display()
                ),
            )
            .unwrap();
            std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
            if case == "disabled-hooks" {
                std::fs::create_dir_all(owned.path().join(".claude")).unwrap();
                std::fs::write(
                    owned.path().join(".claude/settings.json"),
                    r#"{"disableAllHooks":true}"#,
                )
                .unwrap();
            }
            let resume = case != "startup";
            let mut args = vec![];
            if case != "missing-settings" {
                args.extend([
                    "--settings".into(),
                    freshell_platform::cli_launch::claude_settings_json(
                        freshell_platform::cli_launch::ProviderTarget::Unix,
                    ),
                ]);
            }
            args.extend([
                if resume { "--resume" } else { "--session-id" }.into(),
                actual.into(),
                "--model".into(),
                "selected-fixture-model".into(),
            ]);
            let launch: TerminalLaunchSpec = serde_json::from_value(serde_json::json!({
                "terminalId":"controlled-parity", "streamId":"controlled-parity", "mode":"claude",
                "program":provider, "args":args, "resumeSessionId":if resume { Some(root) } else { None },
                "cwd":owned.path(), "workspacePath":owned.path(), "projectKey":"owned-controlled-parity", "cols":80,"rows":24,
                "runAsUid":unsafe {libc::geteuid()}, "runAsGid":unsafe {libc::getegid()},
                "env":{"HOME":owned.path(),"PATH":format!("{}:{}",binary.display(),std::env::var("PATH").unwrap())}
            })).unwrap();
            let pty = HostedPty::spawn(
                &state.state_dir,
                state.incarnation_id.clone(),
                &launch,
                std::collections::BTreeMap::from([(
                    providers::native_identity::LAUNCH_ENV.into(),
                    serde_json::to_string(&binding).unwrap(),
                )]),
                None,
                None,
                None,
            )
            .await
            .unwrap();
            *state.pty.lock().await = Some(pty);
            let signal = owned.path().join(format!(
                ".freshell/native-identity/parity-{case}/statusline-loaded.json"
            ));
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
            while !signal.exists() && std::time::Instant::now() < deadline {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            // Observe the completed configured commands through the real host gate.
            let status = dispatch(
                authenticated_host_envelope(
                    &state,
                    HostCommand::Status {
                        incarnation_id: state.incarnation_id.clone(),
                    },
                ),
                &state,
            )
            .await
            .unwrap();
            let mut pty = state.pty.lock().await.take().unwrap();
            let output = pty.read_output(state.incarnation_id.clone(), 0, 65536, None);
            pty.stop().await;
            assert!(
                !owned.path().join(".claude/projects").exists(),
                "controlled startup must not invent a transcript or user turn"
            );
            if case == "disabled-hooks" {
                assert!(signal.exists());
                assert!(!signal.with_file_name("session-start.json").exists());
            }
            if case == "stale-launch" {
                let published: serde_json::Value =
                    serde_json::from_slice(&std::fs::read(&signal).unwrap()).unwrap();
                assert_eq!(published["launch"]["launchNonce"], "previous-launch");
            }
            match case {
                "startup" | "resume" => assert!(
                    matches!(status,HostResult::Status { native_session_id:Some(ref id), native_identity_observation:Some(ref observation),.. }
                    if id==root && observation.native_session_id==root && observation.launch_nonce==binding.launch_nonce),
                    "configured current producer did not reach host gate: {case}: {status:?}; {output:?}"
                ),
                _ => assert!(
                    matches!(
                        status,
                        HostResult::Status {
                            native_session_id: None,
                            native_identity_observation: None,
                            ..
                        }
                    ),
                    "missing/wrong native response must stay unobserved: {case}: {status:?}"
                ),
            }
        }
    }

    #[tokio::test]
    async fn managed_nonadoption_opencode_status_requires_current_native_loader() {
        use std::os::unix::fs::PermissionsExt;
        for resume in [false, true] {
            let owned = executable_fixture();
            let program = owned.path().join("controlled-native-provider");
            std::fs::write(&program, "#!/bin/sh\nexec sleep 60\n").unwrap();
            std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
            let state = test_host_state();
            let root = "ses_hostroot1";
            let binding = freshell_runtime_protocol::NativeIdentityLaunch {
                incarnation_id: state.incarnation_id.clone(),
                launch_nonce: "nonadoption-native-current".into(),
                evidence_revision: 3,
                execution_generation: 2,
                requested_native_session_id: resume.then(|| root.into()),
            };
            let launch: TerminalLaunchSpec = serde_json::from_value(serde_json::json!({
            "terminalId":"nonadoption-opencode", "streamId":"nonadoption-opencode", "mode":"opencode",
            "program":program, "args":if resume {vec!["--session",root]} else {vec![]}, "resumeSessionId":resume.then_some(root),
            "cwd":owned.path(), "workspacePath":owned.path(), "projectKey":"controlled-native-loader",
            "cols":80, "rows":24, "runAsUid":unsafe {libc::geteuid()}, "runAsGid":unsafe {libc::getegid()},
            "env":{"HOME":owned.path(),"PATH":"/usr/bin:/bin","XDG_DATA_HOME":owned.path().join(".local/share")}
        })).unwrap();
            let pty = HostedPty::spawn(
                &state.state_dir,
                state.incarnation_id.clone(),
                &launch,
                std::collections::BTreeMap::from([(
                    providers::native_identity::LAUNCH_ENV.into(),
                    serde_json::to_string(&binding).unwrap(),
                )]),
                None,
                None,
                None,
            )
            .await
            .unwrap();
            *state.pty.lock().await = Some(pty);
            let directory = owned
                .path()
                .join(".freshell/native-identity/nonadoption-native-current");
            std::fs::create_dir_all(&directory).unwrap();
            let file = directory.join("opencode-loaded.json");
            let native = serde_json::json!({"source":"opencode-tui-native-loader","session_id":root,
            "parent_id":null,"hydrated":true,"messages_read":"empty_confirmed","active_message_count":0,"tail_message_id":null});
            let mut wrong = binding.clone();
            wrong.launch_nonce = "previous-native-launch".into();
            let mut variants = vec![
                (
                    "stale launch",
                    serde_json::json!({"launch":wrong,"native":native}),
                    false,
                ),
                (
                    "wrong root",
                    serde_json::json!({"launch":binding,"native":{"session_id":if resume {"ses_otherroot"} else {"local_placeholder"},"source":"opencode-tui-native-loader",
                "parent_id":null,"hydrated":true,"messages_read":"empty_confirmed","active_message_count":0,"tail_message_id":null}}),
                    false,
                ),
                (
                    "current native loader",
                    serde_json::json!({"launch":binding,"native":native}),
                    true,
                ),
            ];
            for (case, field, value) in [
                ("wrong source", "source", serde_json::json!("route-only")),
                ("parent root", "parent_id", serde_json::json!("ses_parent1")),
                ("not hydrated", "hydrated", serde_json::json!(false)),
                (
                    "failed native read",
                    "messages_read",
                    serde_json::json!("failed"),
                ),
                (
                    "wrong count type",
                    "active_message_count",
                    serde_json::json!("0"),
                ),
                (
                    "nonempty claimed empty",
                    "active_message_count",
                    serde_json::json!(1),
                ),
                (
                    "empty claimed message",
                    "tail_message_id",
                    serde_json::json!("msg_invented1"),
                ),
            ] {
                let mut refused = native.clone();
                refused[field] = value;
                variants.push((
                    case,
                    serde_json::json!({"launch":binding,"native":refused}),
                    false,
                ));
            }
            for (case, field, value) in [
                ("old revision", "evidenceRevision", serde_json::json!(2)),
                (
                    "old execution generation",
                    "executionGeneration",
                    serde_json::json!(1),
                ),
                (
                    "old incarnation",
                    "incarnationId",
                    serde_json::json!("incarnation-previous"),
                ),
            ] {
                let mut refused = serde_json::to_value(&binding).unwrap();
                refused[field] = value;
                variants.push((
                    case,
                    serde_json::json!({"launch":refused,"native":native}),
                    false,
                ));
            }
            let mut results = Vec::new();
            for (case, value, accepted) in variants {
                std::fs::write(&file, serde_json::to_vec(&value).unwrap()).unwrap();
                let status = dispatch(
                    authenticated_host_envelope(
                        &state,
                        HostCommand::Status {
                            incarnation_id: state.incarnation_id.clone(),
                        },
                    ),
                    &state,
                )
                .await
                .unwrap();
                let input = dispatch(
                    authenticated_host_envelope(
                        &state,
                        HostCommand::TerminalInput {
                            incarnation_id: state.incarnation_id.clone(),
                            request_id: RequestId::new(),
                            data: "controlled input".into(),
                        },
                    ),
                    &state,
                )
                .await;
                results.push((case, status, input, accepted));
            }
            state.pty.lock().await.take().unwrap().stop().await;
            for (case, status, input, accepted) in results {
                let HostResult::Status {
                    native_identity_observation,
                    native_session_id,
                    opencode_adoption,
                    ..
                } = status
                else {
                    panic!("actual host status required")
                };
                assert_eq!(native_identity_observation.is_some(), accepted, "{case}");
                assert_eq!(
                    native_session_id.as_deref(),
                    accepted.then_some(root),
                    "{case}"
                );
                assert_eq!(opencode_adoption, OpenCodeAdoptionStatus::NotRequired);
                if accepted {
                    assert!(
                        matches!(
                            input,
                            Ok(HostResult::TerminalInput {
                                state: freshell_runtime_protocol::CommandState::Completed
                            })
                        ),
                        "{case}: {input:?}"
                    );
                } else {
                    assert_eq!(
                        input.unwrap_err().code,
                        RuntimeErrorCode::RecoveryBlocked,
                        "{case}"
                    );
                }
            }
        }
    }

    #[tokio::test]
    async fn requested_identity_is_not_provider_observation() {
        use std::os::unix::fs::PermissionsExt;
        let root = executable_fixture();
        let native_root = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        let history = root.path().join(format!("{native_root}.jsonl"));
        let original = serde_json::json!({"type":"user", "sessionId":native_root,
            "message":{"role":"user","content":"owned fixture history"}})
        .to_string();
        std::fs::write(&history, &original).unwrap();
        let program = root.path().join("provider");
        std::fs::write(&program, "#!/bin/sh\nexec sleep 60\n").unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        let state = test_host_state();
        let launch: TerminalLaunchSpec = serde_json::from_value(serde_json::json!({
            "terminalId":"requested-identity", "streamId":"requested-identity", "mode":"claude",
            "program":program, "args":["--resume",native_root],
            "resumeSessionId":native_root, "cwd":root.path(), "workspacePath":root.path(),
            "projectKey":"owned-identity", "cols":80, "rows":24,
            "runAsUid":unsafe {libc::geteuid()}, "runAsGid":unsafe {libc::getegid()},
            "env":{"HOME":root.path(),"PATH":"/usr/bin:/bin"}
        }))
        .unwrap();
        let pty = HostedPty::spawn(
            &state.state_dir,
            state.incarnation_id.clone(),
            &launch,
            std::collections::BTreeMap::new(),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        *state.pty.lock().await = Some(pty);
        let status = dispatch(
            authenticated_host_envelope(
                &state,
                HostCommand::Status {
                    incarnation_id: state.incarnation_id.clone(),
                },
            ),
            &state,
        )
        .await
        .unwrap();
        let mut pty = state.pty.lock().await.take().unwrap();
        pty.stop().await;
        assert_eq!(std::fs::read_to_string(&history).unwrap(), original);
        assert!(
            matches!(
                status,
                HostResult::Status {
                    native_identity_observation: None,
                    native_session_id: None,
                    ..
                }
            ),
            "requested root and retained transcript must not fill native observation: {status:?}"
        );
        let binding = freshell_runtime_protocol::NativeIdentityLaunch {
            incarnation_id: state.incarnation_id.clone(),
            launch_nonce: "current-native-launch".into(),
            evidence_revision: 2,
            execution_generation: 1,
            requested_native_session_id: Some(native_root.into()),
        };
        let mut launch = launch;
        launch.args.extend([
            "--settings".into(),
            freshell_platform::cli_launch::claude_settings_json(
                freshell_platform::cli_launch::ProviderTarget::Unix,
            ),
        ]);
        let pty = HostedPty::spawn(
            &state.state_dir,
            state.incarnation_id.clone(),
            &launch,
            std::collections::BTreeMap::from([(
                providers::native_identity::LAUNCH_ENV.into(),
                serde_json::to_string(&binding).unwrap(),
            )]),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        *state.pty.lock().await = Some(pty);
        let directory = root
            .path()
            .join(".freshell/native-identity/current-native-launch");
        std::fs::create_dir_all(&directory).unwrap();
        let file = directory.join("session-start.json");
        let native = serde_json::json!({"hook_event_name":"SessionStart","session_id":native_root,"source":"resume",
            "cwd":root.path(),"transcript_path":history});
        let mut variants = vec![];
        let mut wrong = binding.clone();
        wrong.launch_nonce = "old-launch".into();
        variants.push((
            "old nonce",
            serde_json::json!({"launch":wrong,"native":native}),
            false,
        ));
        let mut wrong = binding.clone();
        wrong.evidence_revision += 1;
        variants.push((
            "wrong revision",
            serde_json::json!({"launch":wrong,"native":native}),
            false,
        ));
        variants.push(("fork source",serde_json::json!({"launch":binding,"native":{"hook_event_name":"SessionStart","session_id":native_root,"source":"fork"}}),false));
        variants.push((
            "start without completed restoration",
            serde_json::json!({"launch":binding,"native":native}),
            false,
        ));
        variants.push((
            "current",
            serde_json::json!({"launch":binding,"native":native}),
            true,
        ));
        for name in [
            "loaded wrong nonce",
            "loaded wrong root",
            "loaded wrong transcript",
            "loaded wrong version",
            "loaded wrong workspace",
            "loaded missing model",
            "loaded missing context",
            "loaded missing usage",
        ] {
            variants.push((
                name,
                serde_json::json!({"launch":binding,"native":native}),
                false,
            ));
        }
        let mut outcomes = vec![];
        for (name, value, expected) in variants {
            if name == "current" || name.starts_with("loaded ") {
                let mut loaded = serde_json::json!({"launch":binding,"native":{"session_id":native_root,
                    "transcript_path":history,"version":"2.1.263","model":{"id":"claude-haiku-4-5-20251001"},
                    "workspace":{"current_dir":root.path()},"context_window":{"context_window_size":200000,"current_usage":null}}});
                match name {
                    "loaded wrong nonce" => {
                        loaded["launch"]["launchNonce"] = serde_json::json!("old")
                    }
                    "loaded wrong root" => {
                        loaded["native"]["session_id"] =
                            serde_json::json!("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
                    }
                    "loaded wrong transcript" => {
                        loaded["native"]["transcript_path"] =
                            serde_json::json!("/other/native.jsonl")
                    }
                    "loaded wrong version" => {
                        loaded["native"]["version"] = serde_json::json!("2.1.237")
                    }
                    "loaded wrong workspace" => {
                        loaded["native"]["workspace"]["current_dir"] = serde_json::json!("/other")
                    }
                    "loaded missing model" => loaded["native"]["model"] = serde_json::Value::Null,
                    "loaded missing context" => {
                        loaded["native"]["context_window"] = serde_json::Value::Null
                    }
                    "loaded missing usage" => {
                        loaded["native"]["context_window"]
                            .as_object_mut()
                            .unwrap()
                            .remove("current_usage");
                    }
                    _ => {}
                }
                std::fs::write(directory.join("statusline-loaded.json"), loaded.to_string())
                    .unwrap();
            }
            std::fs::write(&file, value.to_string()).unwrap();
            let result = dispatch(
                authenticated_host_envelope(
                    &state,
                    HostCommand::Status {
                        incarnation_id: state.incarnation_id.clone(),
                    },
                ),
                &state,
            )
            .await
            .unwrap();
            outcomes.push((
                name,
                expected,
                matches!(
                    result,
                    HostResult::Status {
                        native_identity_observation: Some(_),
                        native_session_id: Some(_),
                        ..
                    }
                ),
            ));
        }
        state.pty.lock().await.take().unwrap().stop().await;
        for (name, expected, observed) in outcomes {
            assert_eq!(observed, expected, "native current host signal {name}");
        }
    }

    #[tokio::test]
    async fn exact_resume_grant_reuses_provider_home_and_launches_one_real_worker() {
        use freshell_runtime_protocol::{
            ProviderConfigReference, ProviderConfigRoot, ProviderLaunchContext, ProviderPreparation,
        };
        use std::os::unix::fs::PermissionsExt;

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
            claude_fork: None,
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
                provider_path_inputs: Default::default(),

                native_identity_launch: None,
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
                dispatch_budget_ms: None,
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
                provider_path_inputs: Default::default(),

                native_identity_launch: None,
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
                dispatch_budget_ms: Some(60_000),
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
        let timing = grant_timing_events(&state.state_dir);
        assert_eq!(timing.len(), 1, "one dispatch records one timing event");
        assert_eq!(timing[0]["outcome"], "accepted");
        let stages = timing[0]["stages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|stage| stage["stage"].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            stages,
            [
                "admit",
                "resolve_secrets",
                "prepare_provider_inputs",
                "prepare_provider_state",
                "prepare_terminal",
                "verify_claude_sources",
                "consume_grant",
                "start_sidecar",
                "spawn_worker",
            ],
            "the accepted terminal dispatch names every stage it spent time in"
        );
        assert!(timing[0]["totalMs"].as_u64().is_some());
        assert_eq!(timing[0]["budgetMs"], 60_000);
        assert_eq!(timing[0]["budgetExhaustedBefore"], serde_json::Value::Null);
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
            "synthetic provider fixture output: {diagnostics:?}"
        );
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

    fn run_in_fresh_host_test_process(test_name: &str) -> bool {
        // Real fresh hosts install one immutable child environment per process.
        // Keep independent test allocations in their own processes as well.
        const CHILD_ENV: &str = "FRESHELL_FRESH_HOST_TEST_CHILD";
        if let Some(selected) = std::env::var_os(CHILD_ENV) {
            assert_eq!(
                selected.to_str(),
                Some(test_name),
                "isolated fresh host must run only its selected test"
            );
            return false;
        }
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", test_name, "--nocapture"])
            .env(CHILD_ENV, test_name)
            .status()
            .expect("start isolated fresh host test");
        assert!(
            status.success(),
            "isolated fresh host test failed: {test_name}"
        );
        true
    }

    pub(super) fn test_host_state() -> Arc<HostState> {
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
            control_fence: std::sync::Mutex::new(HostControlFence::default()),
            persisted: Mutex::new(PersistedHostState::default()),
            child: Mutex::new(None),
            pty: Mutex::new(None),
            fresh_agent: Mutex::new(None),
            fresh_native_command: Mutex::new(()),
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

    #[cfg(unix)]
    #[tokio::test]
    async fn baseline_only_distinct_provider_store_and_soul_resume_keeps_exact_identity_fences() {
        let imported = run_joined_synthetic_transfer(None).await.unwrap();
        assert!(imported.result.is_ok());
        let original = imported
            .adoption_expectation
            .lock()
            .unwrap()
            .clone()
            .unwrap();
        let soul_id = SoulId::parse("synthetic-repaired-soul").unwrap();
        assert_ne!(
            original.baseline.descriptor.destination_store_id,
            soul_id.as_str()
        );

        for baseline_only in [false, true] {
            // Descriptor-carrying resumes reject a conflicting root during
            // terminal preparation; baseline-only resumes bind it during
            // adoption preparation instead. Preserve both refusal paths.
            let wrong_root_code = if baseline_only {
                RuntimeErrorCode::OwnershipMismatch
            } else {
                RuntimeErrorCode::InvalidRequest
            };
            let resumed =
                run_synthetic_exact_resume_for_soul(&imported, None, baseline_only, &soul_id)
                    .await
                    .unwrap();
            assert!(
                matches!(
                    &resumed.result,
                    Ok(HostResult::GrantAccepted {
                        worker_launch_count: 1,
                        ..
                    })
                ),
                "distinct store/soul exact resume (baseline-only={baseline_only}): {:?}",
                resumed.result
            );
            assert_eq!(*resumed.events.lock().unwrap(), ["current", "pty"]);
            assert!(resumed
                .pty_callback_invoked
                .load(std::sync::atomic::Ordering::SeqCst));
            let adoption = resumed
                .adoption_expectation
                .lock()
                .unwrap()
                .clone()
                .unwrap();
            assert_eq!(adoption.baseline, original.baseline);
            assert_eq!(adoption.root_session_id, original.root_session_id);
            assert_eq!(adoption.evidence_generation, original.evidence_generation);
            assert_eq!(adoption.incarnation_id, resumed.state.incarnation_id);
            assert_ne!(adoption.launch_nonce, original.launch_nonce);
            let persisted = resumed.state.persisted.try_lock().unwrap();
            assert_eq!(persisted.max_execution_generation, 2);
            assert_eq!(persisted.worker_launch_count, 1);
            drop(persisted);

            for (failure, code, helper_read) in [
                (
                    SyntheticTransferFailure::ExactResumeStoreMismatch,
                    RuntimeErrorCode::OwnershipMismatch,
                    false,
                ),
                (
                    SyntheticTransferFailure::ExactResumeRootMismatch,
                    wrong_root_code,
                    false,
                ),
                (
                    SyntheticTransferFailure::ReadinessStoreMismatch,
                    RuntimeErrorCode::OwnershipMismatch,
                    false,
                ),
                (
                    SyntheticTransferFailure::ReadinessRootMismatch,
                    RuntimeErrorCode::OwnershipMismatch,
                    false,
                ),
                (
                    SyntheticTransferFailure::ReadinessIdentityMismatch,
                    RuntimeErrorCode::OwnershipMismatch,
                    false,
                ),
                (
                    SyntheticTransferFailure::ReadinessGidMismatch,
                    RuntimeErrorCode::OwnershipMismatch,
                    false,
                ),
                (
                    SyntheticTransferFailure::CurrentEvidenceRead,
                    RuntimeErrorCode::HostUnreachable,
                    true,
                ),
                (
                    SyntheticTransferFailure::CurrentEvidenceMismatch,
                    RuntimeErrorCode::HostUnreachable,
                    true,
                ),
                (
                    SyntheticTransferFailure::CurrentEvidenceStoreMismatch,
                    RuntimeErrorCode::HostUnreachable,
                    true,
                ),
                (
                    SyntheticTransferFailure::CurrentEvidenceGenerationMismatch,
                    RuntimeErrorCode::HostUnreachable,
                    true,
                ),
            ] {
                let blocked = run_synthetic_exact_resume_for_soul(
                    &imported,
                    Some(failure),
                    baseline_only,
                    &soul_id,
                )
                .await
                .unwrap();
                assert_eq!(
                    blocked.result.as_ref().unwrap_err().code,
                    code,
                    "{failure:?}, baseline-only={baseline_only}"
                );
                let persisted = blocked.state.persisted.try_lock().unwrap();
                assert!(persisted.grant_id.is_none());
                assert_eq!(persisted.worker_launch_count, 0);
                assert!(!blocked
                    .pty_callback_invoked
                    .load(std::sync::atomic::Ordering::SeqCst));
                assert!(blocked.adoption_expectation.lock().unwrap().is_none());
                assert_eq!(
                    blocked.events.lock().unwrap().as_slice(),
                    if helper_read {
                        &["current"][..]
                    } else {
                        &[][..]
                    }
                );
            }
        }
        let blocked = run_synthetic_exact_resume_for_soul(
            &imported,
            Some(SyntheticTransferFailure::SavedBaselineMismatch),
            true,
            &soul_id,
        )
        .await
        .unwrap();
        assert!(blocked.result.is_err());
        let persisted = blocked.state.persisted.try_lock().unwrap();
        assert!(persisted.grant_id.is_none());
        assert_eq!(persisted.worker_launch_count, 0);
        assert!(!blocked
            .pty_callback_invoked
            .load(std::sync::atomic::Ordering::SeqCst));
        assert!(blocked.adoption_expectation.lock().unwrap().is_none());
        assert!(blocked.events.lock().unwrap().is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn baseline_only_resume_failure_retry_preserves_installed_history_and_current_tail() {
        let imported = run_joined_synthetic_transfer(None).await.unwrap();
        assert!(imported.result.is_ok());
        let descriptor: OpenCodeTransferDescriptor = serde_json::from_slice(
            &std::fs::read(
                imported
                    .root
                    .path()
                    .join("opencode-transfer-descriptor.json"),
            )
            .unwrap(),
        )
        .unwrap();
        let terminal: TerminalLaunchSpec = serde_json::from_slice(
            &std::fs::read(imported.root.path().join("opencode-terminal.json")).unwrap(),
        )
        .unwrap();
        let baseline = OpenCodeAdoptionBaseline {
            manifest_sha256: sha256_hex(descriptor.manifest_json.as_bytes()),
            descriptor: descriptor.clone(),
        };
        let import_receipt_file = imported
            .root
            .path()
            .join("host-state/opencode-synthetic-transfer-import.json");
        let readable_receipt_file = imported
            .root
            .path()
            .join("host-state/opencode-synthetic-transfer-readable.json");
        let original_receipt = std::fs::read(&import_receipt_file).unwrap();
        let original_readable = std::fs::read(&readable_receipt_file).unwrap();
        for failure in [
            SyntheticTransferFailure::CurrentEvidenceRead,
            SyntheticTransferFailure::CurrentEvidenceMismatch,
            SyntheticTransferFailure::CurrentEvidenceGenerationMismatch,
            SyntheticTransferFailure::ReadinessIdentityMismatch,
            SyntheticTransferFailure::SavedBaselineMismatch,
        ] {
            let blocked = run_synthetic_exact_resume(&imported, Some(failure), true)
                .await
                .unwrap();
            assert!(blocked.result.is_err(), "{failure:?}");
            assert!(blocked
                .state
                .persisted
                .try_lock()
                .unwrap()
                .grant_id
                .is_none());
            assert!(!blocked
                .pty_callback_invoked
                .load(std::sync::atomic::Ordering::SeqCst));
            assert!(blocked.adoption_expectation.lock().unwrap().is_none());
            assert!(!blocked.events.lock().unwrap().contains(&"import"));
            assert!(!blocked.events.lock().unwrap().contains(&"pty"));
            let retry = run_synthetic_exact_resume(&imported, None, true)
                .await
                .unwrap();
            assert!(
                retry.result.is_ok(),
                "retry after {failure:?}: {:?}",
                retry.result
            );
            assert_eq!(*retry.events.lock().unwrap(), ["current", "pty"]);
            let adoption = retry.adoption_expectation.lock().unwrap().clone().unwrap();
            assert_eq!(adoption.baseline, baseline);
            assert_eq!(adoption.root_session_id, descriptor.root_session_id);
            assert_eq!(adoption.incarnation_id, retry.state.incarnation_id);
            assert_eq!(
                adoption.root_tail,
                OpenCodeVerifiedRootTail::Message {
                    message_id: "synthetic-message".into()
                }
            );
            assert_eq!(
                std::fs::read(&import_receipt_file).unwrap(),
                original_receipt
            );
            assert_eq!(
                std::fs::read(&readable_receipt_file).unwrap(),
                original_readable
            );
        }
        // Ordinary native progress changes the current tail while the saved
        // import baseline continues to protect the original history.
        let database = rusqlite::Connection::open(&terminal.env["OPENCODE_DB"]).unwrap();
        let info = serde_json::json!({"id":"msg_current_tail","sessionID":descriptor.root_session_id,
            "role":"user","time":{"created":2},"agent":"build","model":{"providerID":"synthetic","modelID":"synthetic"}});
        let mut message_data = info.as_object().unwrap().clone();
        message_data.remove("id");
        message_data.remove("sessionID");
        database.execute("INSERT INTO event_sequence(aggregate_id,seq,owner_id) VALUES (?1,0,'synthetic-current-owner')",[descriptor.root_session_id.as_str()]).unwrap();
        database.execute("INSERT INTO event(id,aggregate_id,seq,type,data) VALUES ('evt_current_tail',?1,0,'message.updated.1',?2)",
            rusqlite::params![descriptor.root_session_id,serde_json::json!({"sessionID":descriptor.root_session_id,"info":info}).to_string()]).unwrap();
        database.execute("INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES ('msg_current_tail',?1,2,2,?2)",
            rusqlite::params![descriptor.root_session_id, serde_json::Value::Object(message_data).to_string()]).unwrap();
        drop(database);
        let progressed = run_synthetic_exact_resume(&imported, None, true)
            .await
            .unwrap();
        assert!(
            progressed.result.is_ok(),
            "current native tail: {:?}",
            progressed.result
        );
        let adoption = progressed
            .adoption_expectation
            .lock()
            .unwrap()
            .clone()
            .unwrap();
        assert_eq!(adoption.baseline, baseline);
        assert_eq!(
            adoption.root_tail,
            OpenCodeVerifiedRootTail::Message {
                message_id: "msg_current_tail".into()
            }
        );
        assert_eq!(*progressed.events.lock().unwrap(), ["current", "pty"]);
        let database = rusqlite::Connection::open(&terminal.env["OPENCODE_DB"]).unwrap();
        assert_eq!(
            database
                .query_row(
                    "SELECT data FROM message WHERE id='synthetic-message'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            r#"{"text":"synthetic message body is test-only"}"#
        );
        assert_eq!(
            database
                .query_row(
                    "SELECT count(*) FROM message WHERE session_id=?1",
                    [descriptor.root_session_id],
                    |row| row.get::<_, u32>(0)
                )
                .unwrap(),
            2
        );
    }

    #[tokio::test]
    async fn baseline_only_unavailable_saved_undo_preserves_native_reference() {
        use freshell_sessions::opencode_transfer::{
            saved_snapshot_summary, OpenCodeTransferManifest, SavedSnapshotAvailability,
            SavedSnapshotReference, SavedSnapshotSummary,
        };

        let fixture =
            stage_synthetic_opencode_transfer_history(SyntheticTransferHistory::UnavailableUndo)
                .unwrap();
        let manifest: OpenCodeTransferManifest =
            serde_json::from_str(&fixture.descriptor.manifest_json).unwrap();
        let payload: serde_json::Value = serde_json::from_reader(
            std::fs::File::open(fixture.ready.join("entry-0000.bin")).unwrap(),
        )
        .unwrap();
        let references: Vec<SavedSnapshotReference> =
            serde_json::from_value(payload["saved_snapshots"].clone()).unwrap();
        assert_eq!(references.len(), 1);
        let reference = &references[0];
        assert_eq!(
            reference.availability,
            SavedSnapshotAvailability::UnavailableInQualifiedLocations
        );
        assert!(reference.objects.is_empty());
        assert_eq!(
            saved_snapshot_summary(&manifest),
            SavedSnapshotSummary::QualifiedReferences {
                retained_closure_count: 0,
                unavailable_reference_count: 1,
            }
        );
        let imported = run_joined_synthetic_transfer_from_stage(fixture, None)
            .await
            .unwrap();
        assert!(imported.result.is_ok(), "{:?}", imported.result);
        let root = imported.root.path();
        let receipt: freshell_agent_runtime::opencode_transfer::ImportReceipt =
            serde_json::from_slice(
                &std::fs::read(root.join("host-state/opencode-synthetic-transfer-import.json"))
                    .unwrap(),
            )
            .unwrap();
        assert_eq!(
            receipt.saved_snapshot_summary,
            saved_snapshot_summary(&manifest)
        );
        let database = root.join("provider-home/.local/share/opencode/opencode.db");
        let preserved = [
            root.join("source.sqlite"),
            root.join("opencode-transfer-descriptor.json"),
            root.join("host-state/opencode-synthetic-transfer-import.json"),
            root.join("host-state/opencode-synthetic-transfer-readable.json"),
            database.clone(),
        ]
        .map(|path| {
            let bytes = std::fs::read(&path).unwrap();
            (path, bytes)
        });
        let resumed = run_synthetic_exact_resume(&imported, None, true)
            .await
            .unwrap();
        assert!(resumed.result.is_ok(), "{:?}", resumed.result);
        assert_eq!(*resumed.events.lock().unwrap(), ["current", "pty"]);
        let original = imported
            .adoption_expectation
            .lock()
            .unwrap()
            .clone()
            .unwrap();
        let current = resumed
            .adoption_expectation
            .lock()
            .unwrap()
            .clone()
            .unwrap();
        assert_eq!(current.baseline, original.baseline);
        assert_ne!(current.launch_nonce, original.launch_nonce);
        assert_eq!(
            current.root_tail,
            OpenCodeVerifiedRootTail::Message {
                message_id: "msg_undo_before".into()
            }
        );
        let connection = rusqlite::Connection::open(&database).unwrap();
        let saved: String = connection
            .query_row(
                "SELECT revert FROM session WHERE id=?1",
                [&reference.session_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&saved).unwrap(),
            serde_json::json!({"messageID":"msg_undo_boundary","snapshot":reference.tree})
        );
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM message", [], |row| row
                    .get::<_, u32>(0))
                .unwrap(),
            2
        );
        assert!(!database.parent().unwrap().join("snapshot").exists());
        for (path, bytes) in preserved {
            assert_eq!(std::fs::read(path).unwrap(), bytes);
        }
    }

    #[tokio::test]
    async fn baseline_only_resume_allows_missing_workspace_asset_and_retries_unreadable_store() {
        for case in ["store", "asset", "pre_pty_log"] {
            let missing_asset = case == "asset";
            let fixture = stage_synthetic_opencode_transfer_with_asset(missing_asset).unwrap();
            let imported = run_joined_synthetic_transfer_from_stage(fixture, None)
                .await
                .unwrap();
            assert!(imported.result.is_ok());
            let root = imported.root.path();
            let database = root.join("provider-home/.local/share/opencode/opencode.db");
            let preserved = [
                root.join("source.sqlite"),
                root.join("opencode-transfer-descriptor.json"),
                root.join("host-state/opencode-synthetic-transfer-import.json"),
                root.join("host-state/opencode-synthetic-transfer-readable.json"),
                database.clone(),
            ]
            .map(|path| {
                let bytes = std::fs::read(&path).unwrap();
                (path, bytes)
            });
            let unavailable = match case {
                "asset" => imported.root.workspace.join("saved-prompt.txt"),
                "pre_pty_log" => root.join("host-state/host-lifecycle.jsonl"),
                _ => database,
            };
            let retained = unavailable.with_extension("retained");
            std::fs::rename(&unavailable, &retained).unwrap();
            if case == "pre_pty_log" {
                std::fs::create_dir(&unavailable).unwrap();
            }
            let attempt = run_synthetic_exact_resume(&imported, None, true)
                .await
                .unwrap();
            if case == "asset" {
                assert!(attempt.result.is_ok(), "{:?}", attempt.result);
                assert!(attempt.state.persisted.lock().await.grant_id.is_some());
                assert_eq!(*attempt.events.lock().unwrap(), ["current", "pty"]);
                assert!(attempt
                    .pty_callback_invoked
                    .load(std::sync::atomic::Ordering::SeqCst));
                assert!(attempt.adoption_expectation.lock().unwrap().is_some());
                assert!(
                    !unavailable.exists(),
                    "resume must not recreate workspace files"
                );
                assert_eq!(
                    std::fs::read(&retained).unwrap(),
                    b"fictional saved prompt asset"
                );
            } else {
                assert!(attempt.result.is_err(), "{case}");
                assert!(attempt.state.persisted.lock().await.grant_id.is_none());
                assert_eq!(*attempt.events.lock().unwrap(), ["current"]);
                assert!(!attempt
                    .pty_callback_invoked
                    .load(std::sync::atomic::Ordering::SeqCst));
                assert!(attempt.adoption_expectation.lock().unwrap().is_none());
            }
            assert!(!root.join("missing-transfer-mount").exists());
            if case == "pre_pty_log" {
                std::fs::remove_dir(&unavailable).unwrap();
            }
            std::fs::rename(&retained, &unavailable).unwrap();
            let retry = run_synthetic_exact_resume(&imported, None, true)
                .await
                .unwrap();
            assert!(retry.result.is_ok(), "explicit retry: {:?}", retry.result);
            assert_eq!(*retry.events.lock().unwrap(), ["current", "pty"]);
            let current = retry.adoption_expectation.lock().unwrap().clone().unwrap();
            let original = imported
                .adoption_expectation
                .lock()
                .unwrap()
                .clone()
                .unwrap();
            assert_eq!(current.baseline, original.baseline);
            assert_eq!(current.root_session_id, original.root_session_id);
            assert_eq!(current.evidence_generation, original.evidence_generation);
            assert_ne!(current.launch_nonce, original.launch_nonce);
            for (path, bytes) in preserved {
                assert_eq!(std::fs::read(path).unwrap(), bytes);
            }
        }
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
        ReadinessStoreMismatch,
        ReadinessRootMismatch,
        ReadinessGidMismatch,
        ExactResumeStoreMismatch,
        ExactResumeRootMismatch,
        CurrentEvidenceStoreMismatch,
        SavedBaselineMismatch,
    }

    struct SyntheticGateAttempt {
        root: SyntheticOpencodeStage,
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
                    if self.failure == Some(SyntheticTransferFailure::CurrentEvidenceStoreMismatch)
                    {
                        evidence.destination_store_id = "synthetic-wrong-store".into();
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
            _claude_settings: Option<String>,
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
            let (message_id, expected_message) = if adoption.root_tail
                == (OpenCodeVerifiedRootTail::Message {
                    message_id: "msg_undo_before".into(),
                }) {
                ("msg_undo_before", synthetic_undo_message(2).to_string())
            } else {
                (
                    "synthetic-message",
                    r#"{"text":"synthetic message body is test-only"}"#.to_string(),
                )
            };
            let message = database
                .query_row(
                    "SELECT data FROM message WHERE id = ?1",
                    [message_id],
                    |row| row.get::<_, String>(0),
                )
                .map_err(|error| {
                    RuntimeError::new(
                        RuntimeErrorCode::RegistryFailure,
                        format!("read synthetic history at PTY boundary: {error}"),
                    )
                })?;
            if message != expected_message {
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
        let state_dir = root.join("host-state");
        let mut persisted = match std::fs::read(state_dir.join("host-state.json")) {
            Ok(bytes) => serde_json::from_slice::<PersistedHostState>(&bytes)
                .map_err(|error| format!("read durable host state: {error}"))?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => PersistedHostState::default(),
            Err(error) => return Err(format!("read durable host state: {error}")),
        };
        persisted.host_boot_id = Some(host_boot_id.clone());
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
            control_fence: std::sync::Mutex::new(HostControlFence::from(&persisted)),
            persisted: Mutex::new(persisted),
            child: Mutex::new(None),
            pty: Mutex::new(None),
            fresh_agent: Mutex::new(None),
            fresh_native_command: Mutex::new(()),
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
                provider_path_inputs: Default::default(),

                native_identity_launch: None,
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
                dispatch_budget_ms: None,
            },
        );
        let result = dispatch_with_effects(envelope, &state, &effects).await;
        Ok((result, events, pty_callback_invoked))
    }

    struct SyntheticOpencodeStage {
        root: tempfile::TempDir,
        workspace: PathBuf,
        descriptor: OpenCodeTransferDescriptor,
        ready: PathBuf,
        source_database: PathBuf,
        rich_roots: Vec<String>,
    }

    impl SyntheticOpencodeStage {
        fn path(&self) -> &Path {
            self.root.path()
        }
    }

    impl Drop for SyntheticOpencodeStage {
        fn drop(&mut self) {
            use std::os::unix::fs::PermissionsExt;
            // Finalization makes this owned fixture read-only. Restore directory
            // write access so TempDir can remove it even on an assertion failure.
            std::fs::set_permissions(&self.ready, std::fs::Permissions::from_mode(0o700))
                .expect("make owned synthetic stage removable");
        }
    }

    fn stage_synthetic_opencode_transfer() -> Result<SyntheticOpencodeStage, String> {
        stage_synthetic_opencode_transfer_with_asset(false)
    }

    fn stage_synthetic_opencode_transfer_with_asset(
        referenced_asset: bool,
    ) -> Result<SyntheticOpencodeStage, String> {
        stage_synthetic_opencode_transfer_history(if referenced_asset {
            SyntheticTransferHistory::Asset
        } else {
            SyntheticTransferHistory::Default
        })
    }

    enum SyntheticTransferHistory {
        Default,
        Asset,
        UnavailableUndo,
        Rich,
        ExistingRich {
            database: PathBuf,
            workspace: PathBuf,
            session_id: String,
        },
    }

    fn synthetic_undo_message(created: i64) -> serde_json::Value {
        serde_json::json!({
            "role": "user",
            "agent": "build",
            "model": {"providerID":"provider-one", "modelID":"model-one"},
            "time": {"created": created},
        })
    }

    fn stage_synthetic_opencode_transfer_history(
        history: SyntheticTransferHistory,
    ) -> Result<SyntheticOpencodeStage, String> {
        use freshell_runtime_protocol::{
            opencode_target_build_receipt, opencode_transfer_bundle_digest, OpenCodeTransferChunk,
            OpenCodeTransferFile, MAX_OPENCODE_TRANSFER_CHUNK_BYTES,
        };
        use freshell_sessions::opencode_transfer::{
            export_exact_session, ExportOptions, HostOpenCodeInventory,
        };
        use freshell_supervisor::opencode_transfer::{OpenCodeTransferStaging, StagingLimits};
        use sha2::{Digest, Sha256};

        let root = tempfile::Builder::new()
            .prefix("task007-stage-envelope-")
            .tempdir()
            .map_err(|error| error.to_string())?;
        let mut workspace = root.path().join("workspace");
        std::fs::create_dir_all(&workspace).map_err(|error| error.to_string())?;
        let mut source_database = root.path().join("source.sqlite");
        let mut rich_roots = Vec::new();
        let session_id = if let SyntheticTransferHistory::ExistingRich {
            database,
            workspace: source_workspace,
            session_id,
        } = &history
        {
            source_database = database.clone();
            workspace = source_workspace.clone();
            session_id.clone()
        } else if matches!(history, SyntheticTransferHistory::Rich) {
            let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
            let seeded = std::process::Command::new("node")
                .current_dir(&repo)
                .args(["--import", "tsx", "--input-type=module", "-e", r#"
import {seedManagedOpenCodeSource} from './scripts/testing/runtime-sandbox.ts';
const source=seedManagedOpenCodeSource({repoRoot:process.cwd(),databasePath:process.argv[1],workspace:process.argv[2],nonce:'fictional-rich-task007',batch:'stopped-repair-seven-roots'});
process.stdout.write(JSON.stringify(source.families.map(f=>f.rootId)));
"#])
                .arg(&source_database).arg(&workspace).output().map_err(|e|e.to_string())?;
            if !seeded.status.success() {
                return Err(String::from_utf8_lossy(&seeded.stderr).into());
            }
            rich_roots =
                serde_json::from_slice::<Vec<String>>(&seeded.stdout).map_err(|e| e.to_string())?;
            rich_roots[0].clone()
        } else {
            let source =
                rusqlite::Connection::open(&source_database).map_err(|error| error.to_string())?;
            source
                .execute_batch(
                    freshell_sessions::opencode_transfer::pinned_destination_schema_sql(),
                )
                .map_err(|error| error.to_string())?;
            for migration in
                freshell_sessions::opencode_transfer::pinned_destination_migration_ids()
            {
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
            if matches!(history, SyntheticTransferHistory::UnavailableUndo) {
                source
                    .execute("DELETE FROM message", [])
                    .map_err(|error| error.to_string())?;
                for (id, created) in [("msg_undo_before", 2), ("msg_undo_boundary", 3)] {
                    source.execute(
                    "INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (?1,'ses_synthetictransfersession',?2,?2,?3)",
                    rusqlite::params![id, created, synthetic_undo_message(created).to_string()],
                ).map_err(|error| error.to_string())?;
                }
                source.execute(
                "UPDATE session SET revert=?1 WHERE id='ses_synthetictransfersession'",
                [serde_json::json!({"messageID":"msg_undo_boundary","snapshot":"1234567890abcdef1234567890abcdef12345678"}).to_string()],
            ).map_err(|error| error.to_string())?;
            }
            if matches!(history, SyntheticTransferHistory::Asset) {
                let asset = workspace.join("saved-prompt.txt");
                std::fs::write(&asset, b"fictional saved prompt asset")
                    .map_err(|error| error.to_string())?;
                source.execute(
                "INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES ('synthetic-file-part','synthetic-message','ses_synthetictransfersession',1,1,?1)",
                [serde_json::json!({"type":"file","mime":"text/plain","url":format!("file://{}",asset.display())}).to_string()],
            ).map_err(|error| error.to_string())?;
            }
            drop(source);

            "ses_synthetictransfersession".to_string()
        };

        let snapshot = export_exact_session(
            &HostOpenCodeInventory::new(source_database.clone())
                .with_trusted_mount_for_selected_session(workspace.clone()),
            &session_id,
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
            root_session_id: session_id,
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

        Ok(SyntheticOpencodeStage {
            root,
            workspace,
            descriptor,
            ready,
            source_database,
            rich_roots,
        })
    }

    #[test]
    fn stopped_repair_stage_reads_real_supervisor_envelope() {
        let fixture = stage_synthetic_opencode_transfer().unwrap();
        let root_path = fixture.root.path().to_path_buf();
        let mut failure = super::OpencodeRepairFailure::at("stage_validation");
        let (actual, payload) =
            super::read_opencode_stopped_repair_stage(&fixture.ready, &mut failure)
                .expect("real finalized supervisor stage must be accepted by the stopped host");
        assert_eq!(actual, fixture.descriptor);
        assert_eq!(payload, fixture.ready.join("entry-0000.bin"));
        assert_eq!(
            hex::encode(Sha256::digest(std::fs::read(payload).unwrap())),
            fixture.descriptor.files[0].sha256
        );
        drop(fixture);
        assert!(!root_path.exists(), "owned stage must be removed");
    }

    #[cfg(unix)]
    #[test]
    fn stopped_repair_installed_generation_uses_actual_export_import_and_node_comparison() {
        use freshell_agent_runtime::opencode_transfer::{
            import_bundle_payload, verify_installed_store, InstalledStoreReaderContext,
        };
        use freshell_sessions::opencode_transfer::{
            export_exact_session, ExportOptions, HostOpenCodeInventory,
        };
        let rich =
            stage_synthetic_opencode_transfer_history(SyntheticTransferHistory::Rich).unwrap();
        let roots = &rich.rich_roots;
        assert_eq!(roots.len(), 7);
        // All seven families use one source store, followed by the original
        // pinned-schema compatibility fixture. Each gets its own staged bundle/HOME.
        for (index, history) in roots
            .iter()
            .map(|session_id| SyntheticTransferHistory::ExistingRich {
                database: rich.source_database.clone(),
                workspace: rich.workspace.clone(),
                session_id: session_id.clone(),
            })
            .chain(std::iter::once(SyntheticTransferHistory::Default))
            .enumerate()
        {
            let fixture = stage_synthetic_opencode_transfer_history(history).unwrap();
            let descriptor = &fixture.descriptor;
            let home = fixture.root.path().join("destination-home");
            let data = home.join(".local/share");
            let config = home.join(".config");
            std::fs::create_dir_all(&config).unwrap();
            let database = data.join("opencode/opencode.db");
            let imported = import_bundle_payload(
                descriptor,
                std::fs::File::open(fixture.ready.join("entry-0000.bin")).unwrap(),
                &database,
                &fixture.workspace,
            )
            .unwrap();
            let reader = InstalledStoreReaderContext {
                database_path: &database,
                workspace_root: &fixture.workspace,
                provider_uid: unsafe { libc::geteuid() },
                provider_gid: unsafe { libc::getegid() },
                home: &home,
                xdg_data_home: &data,
                xdg_config_home: &config,
                cwd: &fixture.workspace,
            };
            let readable = verify_installed_store(descriptor, &reader).unwrap();
            assert_eq!(readable.source_generation, descriptor.source_generation);
            assert_eq!(readable.structural_sha256, imported.structural_sha256);
            let source_database = fixture.source_database.clone();
            let export = |database: &Path, name: &str| {
                export_exact_session(
                    &HostOpenCodeInventory::new(database.to_path_buf())
                        .with_trusted_mount_for_selected_session(fixture.workspace.clone()),
                    &descriptor.root_session_id,
                    ExportOptions::new(fixture.root.path().join(name)),
                )
                .unwrap()
                .manifest()
                .clone()
            };
            let installed = export(&database, "installed-extraction");
            assert_ne!(installed.generation, descriptor.source_generation);
            assert_eq!(installed.row_count as u64, readable.row_count);
            if index != 7 {
                assert_eq!(readable.row_count, 332);
                assert_ne!(
                    installed.source_schema_fingerprint,
                    descriptor.source_schema_fingerprint
                );
                assert_ne!(
                    installed.migration_journal_fingerprint,
                    descriptor.migration_journal_fingerprint
                );
            }
            let connection = rusqlite::Connection::open(&database).unwrap();
            for (table, column, predicate) in [
                ("session", "title", "id"),
                ("message", "data", "session_id"),
                ("todo", "content", "session_id"),
            ] {
                if index == 7 && table == "todo" {
                    continue;
                }
                let original: String = connection
                    .query_row(
                        &format!("SELECT {column} FROM {table} WHERE {predicate}=?1 LIMIT 1"),
                        [&descriptor.root_session_id],
                        |row| row.get(0),
                    )
                    .unwrap();
                // Update just one selected row and retain exactly the same counts.
                let change = format!("UPDATE {table} SET {column}=?1 WHERE rowid=(SELECT rowid FROM {table} WHERE {predicate}=?2 LIMIT 1)");
                let changed = if table == "message" {
                    let mut value: serde_json::Value = serde_json::from_str(&original).unwrap();
                    value["fictionalMutation"] = serde_json::json!(true);
                    value.to_string()
                } else {
                    "fictional changed row".to_string()
                };
                connection
                    .execute(
                        &change,
                        rusqlite::params![changed, descriptor.root_session_id],
                    )
                    .unwrap();
                assert!(
                    verify_installed_store(descriptor, &reader).is_ok(),
                    "current readable {table} data does not need historical mutation proof"
                );
                let actual: String = connection
                    .query_row(
                        &format!("SELECT {column} FROM {table} WHERE {predicate}=?1 LIMIT 1"),
                        [&descriptor.root_session_id],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(actual, changed);
                assert_eq!(
                    export(&database, &format!("{table}-changed")).row_count,
                    installed.row_count
                );
                if table == "message" {
                    connection
                        .execute(&change, rusqlite::params!["{", descriptor.root_session_id])
                        .unwrap();
                    assert!(
                        verify_installed_store(descriptor, &reader).is_err(),
                        "unreadable current native JSON must still be refused"
                    );
                }
                connection
                    .execute(
                        &change,
                        rusqlite::params![original, descriptor.root_session_id],
                    )
                    .unwrap();
                assert!(verify_installed_store(descriptor, &reader).is_ok());
            }
            if index != 7 {
                let child: String = connection
                    .query_row(
                        "SELECT id FROM session WHERE parent_id=?1 LIMIT 1",
                        [&descriptor.root_session_id],
                        |row| row.get(0),
                    )
                    .unwrap();
                connection
                    .execute("UPDATE session SET parent_id=NULL WHERE id=?1", [&child])
                    .unwrap();
                assert!(verify_installed_store(descriptor, &reader).is_err());
                connection
                    .execute(
                        "UPDATE session SET parent_id=?1 WHERE id=?2",
                        rusqlite::params![descriptor.root_session_id, child],
                    )
                    .unwrap();
                assert!(verify_installed_store(descriptor, &reader).is_ok());
                connection.execute("INSERT INTO todo(session_id,position,content,status,priority,time_created,time_updated) VALUES(?1,999,'unreceipted','pending','low',1,1)", [&descriptor.root_session_id]).unwrap();
                assert!(
                    verify_installed_store(descriptor, &reader).is_err(),
                    "extra selected closure row must be refused"
                );
                connection
                    .execute(
                        "DELETE FROM todo WHERE session_id=?1 AND position=999",
                        [&descriptor.root_session_id],
                    )
                    .unwrap();
                assert!(verify_installed_store(descriptor, &reader).is_ok());
            }
            drop(connection);
            let source = rusqlite::Connection::open(&source_database).unwrap();
            let title: String = source
                .query_row(
                    "SELECT title FROM session WHERE id=?1",
                    [&descriptor.root_session_id],
                    |row| row.get(0),
                )
                .unwrap();
            source
                .execute(
                    "UPDATE session SET title='changed source title' WHERE id=?1",
                    [&descriptor.root_session_id],
                )
                .unwrap();
            let changed_source = export(&source_database, "source-changed");
            assert_ne!(changed_source.generation, descriptor.source_generation);
            assert_eq!(changed_source.row_count, installed.row_count);
            source
                .execute(
                    "UPDATE session SET title=?1 WHERE id=?2",
                    rusqlite::params![title, descriptor.root_session_id],
                )
                .unwrap();
            drop(source);
            assert_eq!(
                export(&source_database, "source-restored").generation,
                descriptor.source_generation
            );
            assert_eq!(
                export(&database, "installed-restored").generation,
                installed.generation
            );
            let environment = serde_json::json!({"providerUid":readable.provider_uid,"providerGid":readable.provider_gid,
                "home":readable.home,"xdgDataHome":readable.xdg_data_home,"xdgConfigHome":readable.xdg_config_home,
                "opencodeDb":readable.opencode_db,"cwd":readable.cwd});
            let baseline = serde_json::json!({"destinationStoreId":imported.destination_store_id,
                "bundleSha256":imported.bundle_sha256,"structuralSha256":imported.structural_sha256,
                "rowCount":imported.row_count,"assetCount":imported.asset_count,"providerUid":readable.provider_uid,
                "providerGid":readable.provider_gid,"readerEnvironmentSha256":hex::encode(Sha256::digest(serde_json::to_vec(&environment).unwrap()))});
            let facts = fixture.root.path().join("generation-facts.json");
            std::fs::write(&facts, serde_json::to_vec(&serde_json::json!({
                "descriptor":descriptor,"baseline":baseline,"readable":readable,
                "sourceDatabase":source_database,"destinationDatabase":database,"rich":index != 7,
                "originalManifestJson":descriptor.manifest_json,"installedManifestJson":serde_json::to_string(&installed).unwrap(),
            })).unwrap()).unwrap();
            let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
            let result = std::process::Command::new("node").current_dir(&repo)
                .args(["--import", "tsx", "--input-type=module", "-e", r#"
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {task007ValidateInstalledRead, TASK007_BATCH_STORE_PROBE} from './scripts/testing/runtime-sandbox.ts';
const f=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
const original=JSON.parse(f.originalManifestJson), installed=JSON.parse(f.installedManifestJson);
assert.notEqual(original.generation,installed.generation);
if(f.rich){
  assert.notEqual(original.source_schema_fingerprint,installed.source_schema_fingerprint);
  assert.notEqual(original.migration_journal_fingerprint,installed.migration_journal_fingerprint);
}
assert.deepEqual(task007ValidateInstalledRead(f.descriptor,f.baseline,f.readable),f.readable);
const graph=database=>JSON.parse(execFileSync(process.execPath,['--no-warnings','-e',TASK007_BATCH_STORE_PROBE,database,f.descriptor.rootSessionId],{encoding:'utf8'}));
const source=graph(f.sourceDatabase),destination=graph(f.destinationDatabase);
assert.deepEqual(destination.history,source.history);
assert.deepEqual(destination.parents,source.parents);
assert.deepEqual(destination.excludedSourceSentinels,[]);
if(f.rich) assert.equal(source.excludedSourceSentinels.length,7);
for(const [key,value] of Object.entries({sourceGeneration:'f'.repeat(64),rootSessionId:'ses_foreign',destinationStoreId:'foreign',structuralSha256:'0'.repeat(64),cwd:'/foreign'})){
  assert.throws(()=>task007ValidateInstalledRead(f.descriptor,f.baseline,{...f.readable,[key]:value}));
}
console.log('actual library export/import/full-row reader and Node semantic binding passed');
"#]).arg(&facts).output().unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
        }
    }

    #[test]
    fn stopped_repair_stage_rejects_invalid_envelopes_and_tampered_files() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        for case in [
            "malformed_json",
            "bare_descriptor",
            "missing_descriptor",
            "invalid_descriptor",
            "descriptor_manifest_mismatch",
            "wrong_ready",
            "tampered_payload",
            "descriptor_symlink",
            "ready_symlink",
            "payload_symlink",
            "stage_symlink",
            "unlisted_file",
        ] {
            let fixture = stage_synthetic_opencode_transfer().unwrap();
            let root_path = fixture.root.path().to_path_buf();
            let destination = root_path.join("provider-home/.local/share/opencode/opencode.db");
            let unrelated = root_path.join("unrelated");
            std::fs::write(&unrelated, b"preserve").unwrap();
            let source_before = std::fs::read(root_path.join("source.sqlite")).unwrap();
            let descriptor_path = fixture.ready.join("descriptor.json");
            let mut stage_path = fixture.ready.clone();
            // Mutate only this fictional owned stage, then restore its published modes.
            std::fs::set_permissions(&fixture.ready, std::fs::Permissions::from_mode(0o700))
                .unwrap();
            let replace = |path: &Path, bytes: &[u8]| {
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
                std::fs::write(path, bytes).unwrap();
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o400)).unwrap();
            };
            match case {
                "malformed_json" => replace(&descriptor_path, b"{"),
                "bare_descriptor" => replace(
                    &descriptor_path,
                    &serde_json::to_vec(&fixture.descriptor).unwrap(),
                ),
                "missing_descriptor" => replace(&descriptor_path, b"{}"),
                "invalid_descriptor" | "descriptor_manifest_mismatch" => {
                    let mut descriptor = fixture.descriptor.clone();
                    if case == "invalid_descriptor" {
                        descriptor.provider = "codex".into();
                    } else {
                        descriptor.root_session_id = "ses_differentroot".into();
                    }
                    replace(
                        &descriptor_path,
                        &serde_json::to_vec(&serde_json::json!({"descriptor": descriptor}))
                            .unwrap(),
                    );
                }
                "wrong_ready" => replace(&fixture.ready.join("READY"), b"wrong-digest"),
                "tampered_payload" => {
                    let path = fixture.ready.join("entry-0000.bin");
                    let mut payload = std::fs::read(&path).unwrap();
                    payload[0] ^= 1;
                    replace(&path, &payload);
                }
                "descriptor_symlink" | "ready_symlink" | "payload_symlink" => {
                    let name = match case {
                        "descriptor_symlink" => "descriptor.json",
                        "ready_symlink" => "READY",
                        _ => "entry-0000.bin",
                    };
                    let path = fixture.ready.join(name);
                    let target = root_path.join("symlink-target");
                    std::fs::rename(&path, &target).unwrap();
                    symlink(target, path).unwrap();
                }
                "stage_symlink" => {
                    stage_path = root_path.join("stage-link");
                    symlink(&fixture.ready, &stage_path).unwrap();
                }
                "unlisted_file" => std::fs::write(fixture.ready.join("extra"), b"extra").unwrap(),
                _ => unreachable!(),
            }
            std::fs::set_permissions(&fixture.ready, std::fs::Permissions::from_mode(0o500))
                .unwrap();
            let mut failure = super::OpencodeRepairFailure::at("stage_validation");
            assert!(
                super::read_opencode_stopped_repair_stage(&stage_path, &mut failure).is_err(),
                "must refuse {case}"
            );
            assert!(
                !destination.exists(),
                "{case} must not install a provider database"
            );
            assert_eq!(
                std::fs::read(root_path.join("source.sqlite")).unwrap(),
                source_before,
                "{case} must preserve the source"
            );
            assert_eq!(std::fs::read(unrelated).unwrap(), b"preserve");
            drop(fixture);
            assert!(!root_path.exists(), "{case} owned stage must be removed");
        }
    }

    async fn run_joined_synthetic_transfer(
        failure: Option<SyntheticTransferFailure>,
    ) -> Result<SyntheticGateAttempt, String> {
        let fixture = stage_synthetic_opencode_transfer()?;
        run_joined_synthetic_transfer_from_stage(fixture, failure).await
    }

    async fn run_joined_synthetic_transfer_from_stage(
        fixture: SyntheticOpencodeStage,
        failure: Option<SyntheticTransferFailure>,
    ) -> Result<SyntheticGateAttempt, String> {
        let root = &fixture.root;
        let workspace = fixture.workspace.clone();
        let descriptor = fixture.descriptor.clone();
        let ready = fixture.ready.clone();
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
            control_fence: std::sync::Mutex::new(HostControlFence::default()),
            persisted: Mutex::new(PersistedHostState::default()),
            child: Mutex::new(None),
            pty: Mutex::new(None),
            fresh_agent: Mutex::new(None),
            fresh_native_command: Mutex::new(()),
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
            initial_input_reservation: None,
            prior_provider_owner: None,
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
                provider_path_inputs: Default::default(),

                native_identity_launch: None,
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
                dispatch_budget_ms: None,
            },
        );
        let result = dispatch_with_effects(envelope, &state, &effects).await;
        Ok(SyntheticGateAttempt {
            root: fixture,
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
        run_synthetic_exact_resume_for_soul(
            imported,
            failure,
            stopped_repair_baseline,
            &SoulId::parse("synthetic-soul").map_err(|error| error.to_string())?,
        )
        .await
    }

    async fn run_synthetic_exact_resume_for_soul(
        imported: &SyntheticGateAttempt,
        failure: Option<SyntheticTransferFailure>,
        stopped_repair_baseline: bool,
        soul_id: &SoulId,
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
        if let Some(receipt) = preserved_receipt.as_mut() {
            match failure {
                Some(SyntheticTransferFailure::ReadinessIdentityMismatch) => {
                    receipt.provider_uid = receipt.provider_uid.wrapping_add(1);
                }
                Some(SyntheticTransferFailure::ReadinessGidMismatch) => {
                    receipt.provider_gid = receipt.provider_gid.wrapping_add(1);
                }
                Some(SyntheticTransferFailure::ReadinessStoreMismatch) => {
                    receipt.destination_store_id = "synthetic-wrong-store".into();
                }
                Some(SyntheticTransferFailure::ReadinessRootMismatch) => {
                    receipt.root_session_id = "ses_mismatched-root".into();
                }
                _ => {}
            }
        }
        let incarnation_id = IncarnationId::parse("synthetic-resume-incarnation")
            .map_err(|error| error.to_string())?;
        let soul_id = soul_id.clone();
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
            control_fence: std::sync::Mutex::new(HostControlFence::default()),
            persisted: Mutex::new(PersistedHostState {
                host_boot_id: Some(host_boot_id.clone()),
                opencode_transfer_receipt: preserved_receipt,
                ..PersistedHostState::default()
            }),
            child: Mutex::new(None),
            pty: Mutex::new(None),
            fresh_agent: Mutex::new(None),
            fresh_native_command: Mutex::new(()),
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
            claude_fork: None,
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
        if failure == Some(SyntheticTransferFailure::ExactResumeStoreMismatch) {
            resume_spec.provider_session.provider_store_id = "synthetic-wrong-store".into();
        }
        if failure == Some(SyntheticTransferFailure::ExactResumeRootMismatch) {
            resume_spec.provider_session.native_session_id = "ses_mismatched-root".into();
        }
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
                provider_path_inputs: Default::default(),

                native_identity_launch: None,
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
                dispatch_budget_ms: None,
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
            if state_should_be_published {
                let error = result.expect_err("a durably consumed grant must fence another launch");
                assert_eq!(error.code, RuntimeErrorCode::StaleExecutionGrant);
                assert!(events.lock().unwrap().is_empty());
                assert!(!pty_called.load(std::sync::atomic::Ordering::SeqCst));
                assert!(
                    !marker.exists(),
                    "restart must not reach PTY after grant consumption"
                );
            } else {
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

    pub(super) fn authenticated_host_envelope(
        state: &HostState,
        body: HostCommand,
    ) -> Envelope<HostCommand> {
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
        tempfile::Builder::new()
            .prefix("freshell-host-test-")
            .tempdir()
            .unwrap()
            .keep()
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
        fn empty_codex_state_supports_provider_startup_for_terminal_and_fresh_launches() {
            for fresh in [false, true] {
                let root = tempfile::tempdir().unwrap();
                let home = root.path().join("provider");
                std::fs::create_dir(&home).unwrap();
                // This same-UID fixture represents storage before handoff;
                // provider-owned 0700 would instead describe a completed retry.
                std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o755)).unwrap();
                let paths = ProviderConfigPaths {
                    private_mount: root.path().join("private"),
                    provider_home: home.clone(),
                };
                let uid = unsafe { libc::geteuid() };
                let gid = unsafe { libc::getegid() };
                if fresh {
                    let launch: FreshAgentLaunchSpec = serde_json::from_value(serde_json::json!({
                        "sessionId":"codex-startup", "provider":"codex",
                        "sessionType":"freshcodex", "runtimeVariant":"codex-app-server",
                        "providerStoreId":"codex-store", "cwd":root.path(),
                        "workspacePath":root.path(), "runAsUid":uid, "runAsGid":gid
                    }))
                    .unwrap();
                    prepare_fresh_provider_state_at(&launch, &paths, &root.path().join("inputs"))
                        .unwrap();
                } else {
                    let mut terminal: TerminalLaunchSpec =
                        serde_json::from_value(serde_json::json!({
                            "terminalId":"codex-startup", "streamId":"codex-stream",
                            "mode":"codex", "program":"codex", "cwd":root.path(),
                            "runAsUid":uid, "runAsGid":gid, "cols":80, "rows":24,
                            "projectKey":"codex-startup", "workspacePath":root.path()
                        }))
                        .unwrap();
                    prepare_provider_state_for_fresh_launch_at(
                        &mut terminal,
                        &paths,
                        &root.path().join("inputs"),
                        |_| Ok(()),
                    )
                    .unwrap();
                }

                // An explicit CODEX_HOME must already exist when Codex starts.
                // Exercise the child boundary and native-store writability,
                // with no config projection or credential file to create it.
                let codex_home = home.join(".codex");
                let started = Command::new("sh")
                    .args([
                        "-c",
                        "cd \"$CODEX_HOME\" && mkdir sessions && printf native-started > sessions/startup",
                    ])
                    .env("CODEX_HOME", &codex_home)
                    .output()
                    .unwrap();
                assert!(
                    started.status.success(),
                    "{} launch cannot start with an explicit CODEX_HOME: {}",
                    if fresh { "fresh" } else { "terminal" },
                    String::from_utf8_lossy(&started.stderr)
                );
                assert_eq!(
                    std::fs::read(codex_home.join("sessions/startup")).unwrap(),
                    b"native-started"
                );
                assert_eq!(
                    std::fs::metadata(&codex_home).unwrap().permissions().mode() & 0o777,
                    0o700
                );
            }
        }

        #[test]
        fn codex_initialization_preserves_an_existing_native_home_and_history() {
            use std::os::unix::fs::MetadataExt;
            let root = tempfile::tempdir().unwrap();
            let home = root.path().join("provider");
            let codex_home = home.join(".codex");
            std::fs::create_dir_all(codex_home.join("sessions")).unwrap();
            std::fs::set_permissions(&codex_home, std::fs::Permissions::from_mode(0o750)).unwrap();
            let history = codex_home.join("sessions/existing.jsonl");
            std::fs::write(&history, b"retained-native-history").unwrap();
            let before = std::fs::metadata(&codex_home).unwrap();
            let history_inode = std::fs::metadata(&history).unwrap().ino();

            let created =
                write_provider_bootstrap_files("codex", &[], &home, &root.path().join("inputs"))
                    .unwrap();
            assert!(!created.contains(&codex_home));
            let after = std::fs::metadata(&codex_home).unwrap();
            assert_eq!(
                (after.ino(), after.uid(), after.gid(), after.mode()),
                (before.ino(), before.uid(), before.gid(), before.mode())
            );
            assert_eq!(std::fs::metadata(&history).unwrap().ino(), history_inode);
            assert_eq!(std::fs::read(history).unwrap(), b"retained-native-history");
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
            &home,
            &root.path().join("auth-stage"),
            &[],
            &[],
            unsafe { libc::geteuid() },
            unsafe { libc::getegid() },
            false,
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

    #[cfg(unix)]
    #[test]
    fn provider_config_two_stage_script_is_runnable() {
        use std::os::unix::fs::PermissionsExt;
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
        let output = execute_fixture_with_transient_text_file_busy_retry(&home.join("run"))
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

    #[cfg(unix)]
    #[test]
    #[ignore = "process-kill recovery test; run only through scripts/sandbox-test.sh"]
    fn provider_config_refresh_recovers_manifest_before_removing_stale_paths() {
        use std::{
            os::unix::process::ExitStatusExt,
            process::{Child, Command},
        };
        const ROOT_ENV: &str = "FRESHELL_PROVIDER_CONFIG_CRASH_ROOT";
        const PUBLISH_REACHED: &str = "provider-manifest-published";

        if let Some(root) = std::env::var_os(ROOT_ENV) {
            let root = PathBuf::from(root);
            let home = root.join("home");

            let source = root.join("interrupted-input");
            let reached = root.join(PUBLISH_REACHED);
            std::fs::write(&source, b"intermediate-provider-file").unwrap();
            let previous = read_projection_manifest(&home).unwrap();
            let current = std::collections::BTreeSet::from([
                "managed".to_owned(),
                "managed/intermediate".to_owned(),
            ]);
            let selections = [freshell_platform::provider_environment::CopySelection {
                source,
                destination_relative: "managed/intermediate".into(),
            }];
            let _ = publish_provider_projection_with_manifest(
                ProviderProjection {
                    provider: "codex",
                    workspace: None,
                    selections: &selections,
                    home: &home,
                    previous: &previous,
                    current: &current,
                    protected: &std::collections::BTreeSet::new(),
                    mounted: &[],
                    preserve_existing_mounted_files: &[],
                    reference_aliases: Default::default(),
                },
                |from, to| {
                    std::fs::rename(from, to)?;
                    std::fs::write(&reached, b"published").unwrap();
                    loop {
                        std::thread::park_timeout(std::time::Duration::from_secs(10));
                    }
                },
            );
            panic!("child should be killed after replacing the projection manifest");
        }

        struct ChildGuard(Child);
        impl Drop for ChildGuard {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        std::fs::create_dir_all(home.join("managed")).unwrap();
        std::fs::write(home.join("managed/old"), b"prior-managed-file").unwrap();
        std::fs::write(
            home.join(PROVIDER_PROJECTION_MANIFEST),
            r#"["managed","managed/old"]"#,
        )
        .unwrap();

        let mut child = ChildGuard(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "tests::provider_config_refresh_recovers_manifest_before_removing_stale_paths",
                    "--ignored",
                    "--nocapture",
                ])
                .env(ROOT_ENV, root.path())
                .spawn()
                .unwrap(),
        );
        let reached = root.path().join(PUBLISH_REACHED);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !reached.exists() {
            if let Some(status) = child.0.try_wait().unwrap() {
                panic!("publisher exited before replacing the manifest: {status}");
            }
            assert!(
                std::time::Instant::now() < deadline,
                "publisher did not replace the manifest before timeout"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        child.0.kill().unwrap();
        assert_eq!(child.0.wait().unwrap().signal(), Some(libc::SIGKILL));

        let stage = root.path().join("next-stage");
        std::fs::create_dir_all(stage.join("projection/managed")).unwrap();
        std::fs::write(stage.join("manifest.json"), r#"["managed","managed/new"]"#).unwrap();
        std::fs::write(
            stage.join("projection").join(PROVIDER_PROJECTION_MANIFEST),
            r#"["managed","managed/new"]"#,
        )
        .unwrap();
        std::fs::write(stage.join("projection/managed/new"), b"new-managed-file").unwrap();

        apply_staged_provider_config(&stage, &home).unwrap();

        assert!(!home.join("managed/old").exists());
        assert!(!home.join("managed/intermediate").exists());
        assert_eq!(
            std::fs::read(home.join("managed/new")).unwrap(),
            b"new-managed-file"
        );
        assert_eq!(
            read_projection_manifest(&home).unwrap(),
            ["managed".to_owned(), "managed/new".to_owned()]
                .into_iter()
                .collect()
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
    fn provider_config_codex_prepared_workspace_skill_keeps_complete_projection_on_refresh() {
        use freshell_platform::provider_environment::{
            copy_environment_excluding_subtree, CopySelection,
        };
        use freshell_runtime_protocol::*;
        use std::os::unix::fs::{symlink, MetadataExt};
        let root = executable_fixture();
        let workspace = root.path().join("repository/.worktrees/workspace");
        let skills = workspace.join(".codex/skills");
        let skill = workspace.join(".claude/skills/probe");
        let controller = root.path().join("controller");
        let home = root.path().join("provider");
        for directory in [
            &skills,
            &skill,
            &workspace.join("node_modules/probe-dependency"),
            &controller.join(".freshell/resources"),
            &home.join(".freshell/provider-roots/root-0"),
        ] {
            std::fs::create_dir_all(directory).unwrap();
        }
        std::fs::write(workspace.join("package.json"), r#"{"type":"commonjs"}"#).unwrap();
        std::fs::write(skill.join("SKILL.md"), "selected workspace skill").unwrap();
        std::fs::write(skill.join("retired-resource"), "initial-resource-nonce").unwrap();
        std::fs::write(
            skill.join("run.cjs"),
            "process.stdout.write(require('probe-dependency'));",
        )
        .unwrap();
        std::fs::write(
            workspace.join("node_modules/probe-dependency/index.js"),
            "module.exports='workspace-dependency-nonce';",
        )
        .unwrap();
        symlink("../../.claude/skills/probe", skills.join("probe")).unwrap();
        copy_environment_excluding_subtree(
            &[
                CopySelection {
                    source: controller.join(".freshell/resources"),
                    destination_relative: ".freshell/resources".into(),
                },
                CopySelection {
                    source: skills,
                    destination_relative: ".freshell/resource-units/root-0".into(),
                },
            ],
            &controller,
            &[],
            &workspace,
            Default::default(),
        )
        .unwrap();
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
                    logical_destination: workspace.join(".codex/skills").to_str().unwrap().into(),
                    effective_destination: workspace.join(".codex/skills").to_str().unwrap().into(),
                    kind: ProviderResourceKind::Directory,
                    writable: false,
                    reference_aliases: vec![],
                    retired_reference_aliases: vec![],
                }],
                indexed_files: None,
            }),
            mcp_capability: Some(capability),
            // Ordinary preparation describes its resource units; additional
            // linked targets are discovered by the shared copier.
            config: vec![],
            preparation: ProviderPreparation::Codex {
                tui_args: vec![],
                sidecar_args: vec![],
            },
        };
        let (uid, gid) = unsafe { (libc::geteuid(), libc::getegid()) };
        let refresh = || {
            refresh_provider_config_references(
                &context,
                "codex",
                &workspace,
                &controller,
                &home,
                uid,
                gid,
            )
            .unwrap();
        };
        refresh();
        let sibling = home.join(".freshell/provider-roots/root-0/provider-created");
        std::fs::write(&sibling, "durable-sibling-nonce").unwrap();
        let inode = std::fs::metadata(&sibling).unwrap().ino();
        let initial_manifest = read_projection_manifest(&home).unwrap();
        for refreshed in [false, true] {
            if refreshed {
                let selected = controller.join(".freshell/resource-units/root-0/probe");
                std::fs::write(
                    selected.join("run.cjs"),
                    "process.stdout.write(require('probe-dependency')+':refreshed');",
                )
                .unwrap();
                std::fs::remove_file(selected.join("retired-resource")).unwrap();
                std::fs::write(selected.join("new-resource"), "refreshed-resource-nonce").unwrap();
            }
            refresh();
            let output = std::process::Command::new("node")
                .arg(home.join(".freshell/provider-roots/root-0/probe/run.cjs"))
                .output()
                .unwrap();
            assert!(output.status.success(), "{output:?}");
            let selected = home.join(".freshell/provider-roots/root-0/probe");
            if refreshed {
                assert_eq!(output.stdout, b"workspace-dependency-nonce:refreshed");
                assert!(!selected.join("retired-resource").exists());
                assert_eq!(
                    std::fs::read(selected.join("new-resource")).unwrap(),
                    b"refreshed-resource-nonce"
                );
            } else {
                assert_eq!(output.stdout, b"workspace-dependency-nonce");
                assert_eq!(read_projection_manifest(&home).unwrap(), initial_manifest);
            }
            assert_eq!(std::fs::read(&sibling).unwrap(), b"durable-sibling-nonce");
            assert_eq!(std::fs::metadata(&sibling).unwrap().ino(), inode);
        }
    }

    #[cfg(unix)]
    #[test]
    fn provider_config_linked_resource_projection_still_refuses_incomplete_manifest() {
        use freshell_platform::provider_environment::{copy_environment, CopySelection};
        use std::collections::BTreeSet;
        let root = tempfile::tempdir().unwrap();
        let original = root.path().join("original");
        let skill = root.path().join("external/skill");
        let stage = root.path().join("stage");
        let projection = stage.join("projection");
        let home = root.path().join("home");
        for directory in [&original, &skill, &stage, &home] {
            std::fs::create_dir_all(directory).unwrap();
        }
        std::fs::write(skill.join("SKILL.md"), "selected skill").unwrap();
        std::fs::write(skill.join("resource"), "selected-resource-nonce").unwrap();
        std::os::unix::fs::symlink(&skill, original.join("skill")).unwrap();
        let report = copy_environment(
            &[CopySelection {
                source: original,
                destination_relative: "skills".into(),
            }],
            &projection,
            &[],
            Default::default(),
        )
        .unwrap();
        let complete = report
            .projected_paths
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect::<BTreeSet<_>>();
        std::fs::write(stage.join("manifest.json"), r#"["skills"]"#).unwrap();
        write_projection_manifest(&projection, &complete).unwrap();
        apply_staged_provider_config(&stage, &home).unwrap();
        let prior_manifest = std::fs::read(home.join(PROVIDER_PROJECTION_MANIFEST)).unwrap();
        let selected = complete
            .iter()
            .find(|path| path.ends_with("/resource"))
            .unwrap();
        for omit_actual in [true, false] {
            let mut incomplete = complete.clone();
            if omit_actual {
                incomplete.remove(selected);
            } else {
                incomplete.insert(".freshell/resources/unavailable-selected-file".into());
            }
            write_projection_manifest(&projection, &incomplete).unwrap();
            let error = apply_staged_provider_config(&stage, &home).unwrap_err();
            assert_eq!(
                error,
                "provider projection manifest does not describe the complete selected environment"
            );
            assert_eq!(
                std::fs::read(home.join(PROVIDER_PROJECTION_MANIFEST)).unwrap(),
                prior_manifest
            );
            assert_eq!(
                std::fs::read(home.join("skills/skill/resource")).unwrap(),
                b"selected-resource-nonce"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn provider_config_codex_nested_workspace_does_not_inherit_parent_install_on_refresh() {
        use freshell_platform::provider_environment::{
            copy_environment_excluding_subtree, CopySelection,
        };
        use freshell_runtime_protocol::{
            ProviderConfigReference, ProviderConfigRoot, ProviderLaunchContext, ProviderPreparation,
        };
        let root = executable_fixture();
        let repository = root.path().join("parent-repository");
        let workspace = repository.join(".worktrees/workspace");
        let skills = workspace.join(".codex/skills");
        let skill = workspace.join(".claude/skills/probe");
        let controller = root.path().join("controller");
        let home = root.path().join("provider");
        for directory in [
            &skills,
            &skill,
            &workspace.join("node_modules/probe-dependency"),
            &repository.join("node_modules"),
            &home,
        ] {
            std::fs::create_dir_all(directory).unwrap();
        }
        std::fs::write(skill.join("SKILL.md"), "selected workspace skill").unwrap();
        std::fs::write(
            skill.join("run.cjs"),
            "process.stdout.write(require('probe-dependency'));",
        )
        .unwrap();
        std::fs::write(
            workspace.join("node_modules/probe-dependency/index.js"),
            "module.exports='workspace-dependency-nonce';",
        )
        .unwrap();
        std::fs::File::create(repository.join("node_modules/unrelated-parent-binary"))
            .unwrap()
            .set_len(
                freshell_platform::provider_environment::CopyLimits::default().max_file_bytes + 1,
            )
            .unwrap();
        std::os::unix::fs::symlink("../../.claude/skills/probe", skills.join("probe")).unwrap();
        copy_environment_excluding_subtree(
            &[CopySelection {
                source: skills,
                destination_relative: "skills".into(),
            }],
            &controller,
            &[],
            &workspace,
            Default::default(),
        )
        .expect("the prepared generation must not import the enclosing repository's modules");
        let context = ProviderLaunchContext {
            config: [
                ("skills", ".codex/skills"),
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
            preparation: ProviderPreparation::Codex {
                tui_args: vec![],
                sidecar_args: vec![],
            },
            mcp_capability: None,
            prepared_inputs: None,
        };
        let (uid, gid) = unsafe { (libc::geteuid(), libc::getegid()) };
        copy_provider_config_references(
            &context,
            "codex",
            &workspace,
            &controller,
            &home,
            uid,
            gid,
        )
        .unwrap();
        let sibling = home.join(".codex/skills/provider-created");
        std::fs::write(&sibling, "durable-sibling-nonce").unwrap();
        for _ in 0..2 {
            refresh_provider_config_references(
                &context,
                "codex",
                &workspace,
                &controller,
                &home,
                uid,
                gid,
            )
            .unwrap();
            let output = std::process::Command::new("node")
                .arg(home.join(".codex/skills/probe/run.cjs"))
                .output()
                .unwrap();
            assert!(output.status.success(), "{output:?}");
            assert_eq!(output.stdout, b"workspace-dependency-nonce");
            assert_eq!(std::fs::read(&sibling).unwrap(), b"durable-sibling-nonce");
        }
    }

    #[cfg(unix)]
    #[test]
    fn provider_config_codex_keeps_workspace_node_lookup_mounted_across_refresh() {
        use freshell_runtime_protocol::{
            ProviderConfigReference, ProviderConfigRoot, ProviderLaunchContext, ProviderPreparation,
        };
        let root = executable_fixture();
        let workspace = root.path().join("workspace");
        let modules = workspace.join("packages/tool/node_modules");
        let controller = root.path().join("controller");
        let skill = controller.join("skills/probe");
        let home = root.path().join("provider");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::create_dir_all(modules.join("probe-dependency")).unwrap();
        std::fs::create_dir(&home).unwrap();
        std::fs::write(skill.join("SKILL.md"), "selected skill").unwrap();
        std::fs::write(
            skill.join("run.cjs"),
            "process.stdout.write(require('probe-dependency'));",
        )
        .unwrap();
        std::fs::write(
            modules.join("probe-dependency/index.js"),
            "module.exports='mounted-dependency-nonce';",
        )
        .unwrap();
        std::fs::File::create(modules.join("unrelated-binary"))
            .unwrap()
            .set_len(
                freshell_platform::provider_environment::CopyLimits::default().max_file_bytes + 1,
            )
            .unwrap();
        std::os::unix::fs::symlink(&modules, skill.join("node_modules")).unwrap();
        let context = ProviderLaunchContext {
            config: vec![ProviderConfigReference {
                root: ProviderConfigRoot::UserProvider,
                relative_path: "skills".into(),
                provider_relative_path: ".codex/skills".into(),
                format: "directory".into(),
            }],
            preparation: ProviderPreparation::Codex {
                tui_args: vec![],
                sidecar_args: vec![],
            },
            mcp_capability: None,
            prepared_inputs: None,
        };
        let (uid, gid) = unsafe { (libc::geteuid(), libc::getegid()) };
        copy_provider_config_references(
            &context,
            "codex",
            &workspace,
            &controller,
            &home,
            uid,
            gid,
        )
        .expect("a mounted dependency lookup must not copy unrelated workspace packages");
        for _ in 0..2 {
            refresh_provider_config_references(
                &context,
                "codex",
                &workspace,
                &controller,
                &home,
                uid,
                gid,
            )
            .unwrap();
            let output = std::process::Command::new("node")
                .arg(home.join(".codex/skills/probe/run.cjs"))
                .output()
                .unwrap();
            assert!(output.status.success(), "{output:?}");
            assert_eq!(output.stdout, b"mounted-dependency-nonce");
        }
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
                let output =
                    execute_fixture_with_transient_text_file_busy_retry(&home.join(relative))
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

        let redaction_root = tempfile::tempdir().unwrap();
        let redaction_root_text = redaction_root.path().to_string_lossy().into_owned();
        let recovery = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::provider_config_recovery_preserves_written_writable_file_and_refreshes_read_only_file",
                "--nocapture",
            ])
            .env("TMPDIR", redaction_root.path())
            .env("TMP", redaction_root.path())
            .env("TEMP", redaction_root.path())
            .output()
            .unwrap();
        assert!(recovery.status.success(), "{recovery:?}");
        let recovery_stderr = std::str::from_utf8(&recovery.stderr).unwrap();
        let recovery_events = recovery_stderr
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .collect::<Vec<_>>();
        let recovery_failures = recovery_events
            .iter()
            .filter(|event| event["event"] == "provider.inputs.recovery.failed")
            .collect::<Vec<_>>();
        assert_eq!(
            recovery_failures.len(),
            1,
            "a blocked writable-file recovery must produce one resource-specific diagnostic"
        );
        let recovery_failure = recovery_failures[0];
        assert_eq!(recovery_failure["severity"], "error");
        assert_eq!(recovery_failure["stage"], "session_host");
        assert_eq!(recovery_failure["provider"], "opencode");
        assert_eq!(
            recovery_failure["operation"],
            "recover_nested_writable_file"
        );
        assert_eq!(recovery_failure["reason"], "prior_resource_deleted");
        assert_eq!(
            recovery_failure["resource_stage_path"],
            ".freshell/resource-units/deleted/source"
        );
        assert_eq!(
            recovery_failure["provider_relative_path"],
            ".freshell/provider-roots/deleted/source"
        );
        assert!(
            !recovery_stderr.contains("stale host seed")
                && !recovery_stderr.contains(&redaction_root_text),
            "recovery diagnostics must not expose fixture contents or temporary host paths"
        );

        #[cfg(unix)]
        {
            let filtered = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "tests::provider_config_workspace_filter_failure_emits_safe_jsonl",
                    "--nocapture",
                ])
                .output()
                .unwrap();
            assert!(filtered.status.success(), "{filtered:?}");
            let event = std::str::from_utf8(&filtered.stderr)
                .unwrap()
                .lines()
                .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
                .find(|event| {
                    event["event"] == "provider.environment.copy.failed"
                        && event["stage"] == "session_host"
                })
                .expect("nested-workspace filtering failures emit the standard copy failure event");
            assert_eq!(event["provider"], "opencode");
            assert_eq!(event["operation"], "resolve");
            assert_eq!(event["relative_path"], "resource/dangling-resource");
            assert_eq!(
                event["resource_stage_path"],
                ".freshell/resource-units/root-test"
            );
            assert_eq!(event["resource_source_leaf"], "root-test");
            assert_eq!(event["resource_destination_leaf"], "external");
            assert!(event["corrective_message"]
                .as_str()
                .unwrap()
                .contains("repair"));
            assert!(event["elapsed_ms"].as_u64().is_some());
        }
    }

    #[path = "probe_recovery_tests.rs"]
    mod probe_recovery;

    #[test]
    fn committed_journal_directory_sync_failure_is_not_treated_as_pre_publish() {
        use super::*;
        use std::io;

        let transaction = tempfile::tempdir().unwrap();
        let journal = ProviderProjectionTransactionJournal {
            version: 1,
            phase: ProviderProjectionTransactionPhase::Committed,
            manifest_existed: false,
            entries: Vec::new(),
        };

        let error = write_provider_projection_transaction_journal_with_sync(
            transaction.path(),
            &journal,
            |_| Err(io::Error::other("injected directory flush failure")),
        )
        .unwrap_err();

        assert!(matches!(
            error,
            ProviderProjectionJournalWriteError::PublishedButUnconfirmed(_)
        ));
        let published: ProviderProjectionTransactionJournal = serde_json::from_slice(
            &std::fs::read(
                transaction
                    .path()
                    .join(PROVIDER_PROJECTION_TRANSACTION_JOURNAL),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            published.phase,
            ProviderProjectionTransactionPhase::Committed
        );
    }

    #[cfg(unix)]
    #[test]
    fn mounted_projection_mode_is_flushed_after_permissions_change() {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source");
        let destination = directory.path().join("mounted");
        std::fs::write(&source, b"provider state").unwrap();
        std::fs::write(&destination, b"old state").unwrap();
        std::fs::set_permissions(&source, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::set_permissions(&destination, std::fs::Permissions::from_mode(0o644)).unwrap();
        let mut observed_modes = Vec::new();

        replace_mounted_projection_file_with_sync(&source, &destination, |file| {
            file.sync_all()?;
            observed_modes.push(std::fs::metadata(&destination)?.permissions().mode() & 0o777);
            Ok(())
        })
        .unwrap();

        assert_eq!(std::fs::read(&destination).unwrap(), b"provider state");
        assert_eq!(observed_modes, vec![0o644, 0o600]);
    }

    #[cfg(unix)]
    #[test]
    fn provider_projection_sync_walk_flushes_files_and_directories_without_following_links() {
        use std::os::unix::fs::symlink;

        let tree = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let nested = tree.path().join("nested");
        std::fs::create_dir(&nested).unwrap();
        let file = nested.join("provider.json");
        std::fs::write(&file, "projected provider state").unwrap();
        let outside_file = outside.path().join("outside.json");
        std::fs::write(&outside_file, "outside state").unwrap();
        symlink(&outside_file, nested.join("outside-link.json")).unwrap();

        let synced = std::sync::Mutex::new(Vec::new());
        super::sync_provider_projection_tree_with(tree.path(), &|path| {
            synced.lock().unwrap().push(path.to_path_buf());
            Ok(())
        })
        .unwrap();
        let synced = synced.into_inner().unwrap();

        assert!(synced.contains(&file));
        assert!(synced.contains(&nested));
        assert!(synced.contains(&tree.path().to_path_buf()));
        assert!(
            !synced.contains(&outside_file),
            "sync traversal must not follow provider-controlled symlinks"
        );
    }

    /// A selected provider environment can hold thousands of files (an
    /// installed plugin's node_modules). Each flush is one journal commit, so
    /// flushing them one at a time inside the execution grant made a healthy
    /// 4,200-file projection take 8-13 s and miss the grant reply. Flushes of
    /// independent nodes must overlap, and every node is still flushed once.
    #[cfg(unix)]
    #[test]
    fn provider_projection_sync_walk_overlaps_flushes_of_independent_nodes() {
        use std::collections::BTreeSet;
        use std::sync::atomic::{AtomicUsize, Ordering};

        let tree = tempfile::tempdir().unwrap();
        let entries = tree.path().join("node_modules/parity-installed/entries");
        std::fs::create_dir_all(&entries).unwrap();
        for index in 0..32 {
            std::fs::write(
                entries.join(format!("entry-{index}.cjs")),
                "module.exports=1\n",
            )
            .unwrap();
        }
        let in_flight = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let synced = std::sync::Mutex::new(Vec::new());
        super::sync_provider_projection_tree_with(tree.path(), &|path| {
            let now = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(now, Ordering::SeqCst);
            std::thread::sleep(std::time::Duration::from_millis(25));
            synced.lock().unwrap().push(path.to_path_buf());
            in_flight.fetch_sub(1, Ordering::SeqCst);
            Ok(())
        })
        .unwrap();

        let synced = synced.into_inner().unwrap();
        let unique = synced.iter().collect::<BTreeSet<_>>();
        assert_eq!(synced.len(), 32 + 4, "32 files, 3 directories and the root");
        assert_eq!(
            unique.len(),
            synced.len(),
            "each node is flushed exactly once"
        );
        assert!(
            peak.load(Ordering::SeqCst) > 1,
            "independent flushes must overlap instead of running one at a time"
        );
    }

    #[cfg(unix)]
    #[test]
    fn provider_projection_sync_walk_reports_the_node_whose_flush_failed() {
        let tree = tempfile::tempdir().unwrap();
        for index in 0..16 {
            std::fs::write(tree.path().join(format!("file-{index}")), "state").unwrap();
        }
        let failing = tree.path().join("file-7");
        let error = super::sync_provider_projection_tree_with(tree.path(), &|path| {
            if path == failing {
                Err(std::io::Error::other("synthetic flush failure"))
            } else {
                Ok(())
            }
        })
        .unwrap_err();
        assert!(
            error.contains(&failing.display().to_string())
                && error.contains("synthetic flush failure"),
            "{error}"
        );
    }

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

    fn opencode_resource_mount(
        id: &str,
        logical_destination: &str,
        effective_destination: &str,
        kind: freshell_runtime_protocol::ProviderResourceKind,
        writable: bool,
    ) -> freshell_runtime_protocol::ProviderResourceMount {
        let file = kind == freshell_runtime_protocol::ProviderResourceKind::File;
        freshell_runtime_protocol::ProviderResourceMount {
            stage_relative_path: if file {
                format!(".freshell/resource-units/{id}/source")
            } else {
                format!(".freshell/resource-units/{id}")
            },
            provider_relative_path: if file {
                format!(".freshell/provider-roots/{id}/source")
            } else {
                format!(".freshell/provider-roots/{id}")
            },
            logical_destination: logical_destination.into(),
            effective_destination: effective_destination.into(),
            kind,
            writable,
            reference_aliases: vec![],
            retired_reference_aliases: vec![],
        }
    }

    fn opencode_context_with_mounts(
        resource_mounts: Vec<freshell_runtime_protocol::ProviderResourceMount>,
    ) -> freshell_runtime_protocol::ProviderLaunchContext {
        use freshell_runtime_protocol::*;
        let capability = McpCapabilityReference {
            grant_id: "grant-managed-provider-recovery-test".into(),
            endpoint: "http://host.docker.internal:1234".into(),
            provider_relative_path: ".freshell/mcp-capability.json".into(),
            host_gateway_address: None,
        };
        ProviderLaunchContext {
            config: vec![],
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
                resource_mounts,
            }),
            mcp_capability: Some(capability),
        }
    }

    #[cfg(unix)]
    #[test]
    fn provider_resource_reference_alias_links_to_private_reference_without_copying_it() {
        use freshell_runtime_protocol::{
            IndexedProviderFileAlias, IndexedProviderFiles, ProviderResourceKind,
            ProviderResourceReferenceAlias,
        };

        let owned = tempfile::tempdir().unwrap();
        let provider_home = owned.path().join("provider");
        let user_provider_root = owned.path().join("prepared");
        let resource_stage = user_provider_root.join(".freshell/resource-units/mcp-project");
        let resource_root = provider_home.join(".freshell/provider-roots/mcp-project");
        let workspace = owned.path().join("workspace");
        std::fs::create_dir_all(&resource_stage).unwrap();
        std::fs::create_dir_all(&provider_home).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(provider_home.join(".freshell/references")).unwrap();
        std::fs::write(resource_stage.join("server.mjs"), "console.log('ready')\n").unwrap();
        let private_reference = owned.path().join("private-reference-0");
        std::fs::write(&private_reference, "MANAGED_ALIAS_SECRET=private-value\n").unwrap();
        // Indexed configuration references point into the read-only secret mount at runtime.
        std::os::unix::fs::symlink(
            &private_reference,
            provider_home.join(".freshell/references/0"),
        )
        .unwrap();
        let mut mount = opencode_resource_mount(
            "mcp-project",
            "/opt/mcp-project",
            "/opt/mcp-project",
            ProviderResourceKind::Directory,
            false,
        );
        mount.reference_aliases = vec![ProviderResourceReferenceAlias {
            relative_path: ".env".into(),
            reference_index: 0,
        }];
        let mut context = opencode_context_with_mounts(vec![mount]);
        let inputs = context.prepared_inputs.as_mut().unwrap();
        inputs.manifest.source_count = 1;
        inputs.manifest.alias_count = 1;
        inputs.indexed_files = Some(IndexedProviderFiles {
            volume_name: "freshell-inputs-aaaaaaaaaaaaaaaaaaaaaaaa".into(),
            aliases: vec![IndexedProviderFileAlias {
                source_id: 0,
                logical_destination: "/fixture/private-reference".into(),
                effective_destination: "/fixture/private-reference".into(),
            }],
            staged_source_paths: None,
        });

        let stage = tempfile::tempdir_in(&provider_home).unwrap();
        super::refresh_provider_config_in_stage(
            &context,
            "opencode",
            &workspace,
            &user_provider_root,
            &provider_home,
            stage,
        )
        .unwrap();
        let alias = resource_root.join(".env");
        assert!(std::fs::symlink_metadata(&alias)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            std::fs::read_to_string(provider_home.join(".freshell/references/0")).unwrap(),
            "MANAGED_ALIAS_SECRET=private-value\n"
        );
        assert!(
            std::fs::symlink_metadata(provider_home.join(".freshell/references/0"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(
            std::fs::read_link(&alias).unwrap(),
            PathBuf::from("/home/freshell/provider/.freshell/references/0")
        );
        assert!(super::read_projection_manifest(&provider_home)
            .unwrap()
            .contains(".freshell/provider-roots/mcp-project/.env"));
    }

    #[cfg(unix)]
    #[test]
    fn failed_reference_alias_refresh_preserves_the_previous_provider_projection() {
        use freshell_runtime_protocol::{
            ProviderConfigReference, ProviderConfigRoot, ProviderResourceKind,
            ProviderResourceReferenceAlias,
        };

        let owned = tempfile::tempdir().unwrap();
        let provider_home = owned.path().join("provider");
        let user_provider_root = owned.path().join("prepared");
        let workspace = owned.path().join("workspace");
        let resource_stage = user_provider_root.join(".freshell/resource-units/mcp-project");
        let resource_root = provider_home.join(".freshell/provider-roots/mcp-project");
        std::fs::create_dir_all(&resource_stage).unwrap();
        std::fs::create_dir_all(&resource_root).unwrap();
        std::fs::create_dir_all(provider_home.join(".opencode")).unwrap();
        std::fs::create_dir_all(provider_home.join(".freshell/references")).unwrap();
        std::fs::create_dir_all(user_provider_root.join("references")).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(user_provider_root.join("settings.json"), b"new config").unwrap();
        std::fs::write(user_provider_root.join("references/0"), b"new secret").unwrap();
        std::fs::write(resource_stage.join("server.mjs"), b"new resource").unwrap();
        std::fs::write(
            provider_home.join(".opencode/settings.json"),
            b"prior config",
        )
        .unwrap();
        std::fs::write(
            provider_home.join(".freshell/references/0"),
            b"prior secret",
        )
        .unwrap();
        std::fs::write(resource_root.join("server.mjs"), b"prior resource").unwrap();
        // A provider-created file blocks the requested managed alias. The
        // refresh must fail without publishing its config or resource updates.
        std::fs::write(resource_root.join(".env"), b"provider-owned file").unwrap();
        super::write_projection_manifest(
            &provider_home,
            &[
                ".opencode/settings.json".to_owned(),
                ".freshell/references/0".to_owned(),
                ".freshell/provider-roots/mcp-project".to_owned(),
                ".freshell/provider-roots/mcp-project/server.mjs".to_owned(),
            ]
            .into_iter()
            .collect(),
        )
        .unwrap();

        let mut mount = opencode_resource_mount(
            "mcp-project",
            "/opt/mcp-project",
            "/opt/mcp-project",
            ProviderResourceKind::Directory,
            false,
        );
        mount.reference_aliases = vec![ProviderResourceReferenceAlias {
            relative_path: ".env".into(),
            reference_index: 0,
        }];
        let mut context = opencode_context_with_mounts(vec![mount]);
        context.config = vec![
            ProviderConfigReference {
                root: ProviderConfigRoot::UserProvider,
                relative_path: "settings.json".into(),
                provider_relative_path: ".opencode/settings.json".into(),
                format: "json".into(),
            },
            ProviderConfigReference {
                root: ProviderConfigRoot::UserProvider,
                relative_path: "references/0".into(),
                provider_relative_path: ".freshell/references/0".into(),
                format: "text".into(),
            },
        ];
        let inputs = context.prepared_inputs.as_mut().unwrap();
        inputs.manifest.source_count = 1;
        inputs.manifest.alias_count = 1;
        inputs.indexed_files = Some(freshell_runtime_protocol::IndexedProviderFiles {
            volume_name: "freshell-inputs-aaaaaaaaaaaaaaaaaaaaaaaa".into(),
            aliases: vec![freshell_runtime_protocol::IndexedProviderFileAlias {
                source_id: 0,
                logical_destination: "/fixture/private-reference".into(),
                effective_destination: "/fixture/private-reference".into(),
            }],
            staged_source_paths: None,
        });

        let stage = tempfile::tempdir_in(&provider_home).unwrap();
        let error = super::refresh_provider_config_in_stage(
            &context,
            "opencode",
            &workspace,
            &user_provider_root,
            &provider_home,
            stage,
        )
        .expect_err("a provider-owned alias collision must reject the full refresh");

        assert!(error.contains("provider-created"), "{error}");
        assert_eq!(
            std::fs::read(provider_home.join(".opencode/settings.json")).unwrap(),
            b"prior config"
        );
        assert_eq!(
            std::fs::read(provider_home.join(".freshell/references/0")).unwrap(),
            b"prior secret"
        );
        assert_eq!(
            std::fs::read(resource_root.join("server.mjs")).unwrap(),
            b"prior resource"
        );
        assert_eq!(
            std::fs::read(resource_root.join(".env")).unwrap(),
            b"provider-owned file"
        );
        assert!(super::read_projection_manifest(&provider_home)
            .unwrap()
            .contains(".freshell/provider-roots/mcp-project/server.mjs"));
    }

    #[cfg(unix)]
    #[test]
    fn provider_resource_reference_alias_rebinds_a_reused_reference_index() {
        use freshell_runtime_protocol::{ProviderResourceKind, ProviderResourceReferenceAlias};

        let owned = tempfile::tempdir().unwrap();
        let provider_home = owned.path().join("provider");
        let resource_root = provider_home.join(".freshell/provider-roots/mcp-project");
        std::fs::create_dir_all(&resource_root).unwrap();
        std::fs::create_dir_all(provider_home.join(".freshell/references")).unwrap();
        std::fs::write(provider_home.join(".freshell/references/0"), "old secret\n").unwrap();
        std::fs::write(provider_home.join(".freshell/references/1"), "new secret\n").unwrap();
        let mut mount = opencode_resource_mount(
            "mcp-project",
            "/opt/mcp-project",
            "/opt/mcp-project",
            ProviderResourceKind::Directory,
            false,
        );
        mount.reference_aliases = vec![ProviderResourceReferenceAlias {
            relative_path: ".env".into(),
            reference_index: 0,
        }];
        let first_context = opencode_context_with_mounts(vec![mount.clone()]);
        super::install_provider_resource_reference_aliases(&first_context, &provider_home).unwrap();

        mount.reference_aliases[0].reference_index = 1;
        let second_context = opencode_context_with_mounts(vec![mount]);
        super::install_provider_resource_reference_aliases(&second_context, &provider_home)
            .expect("an old managed reference alias must be replaceable when its index changes");

        assert_eq!(
            std::fs::read_link(resource_root.join(".env")).unwrap(),
            PathBuf::from("/home/freshell/provider/.freshell/references/1")
        );
    }

    #[cfg(unix)]
    #[test]
    fn provider_resource_reference_alias_retirement_removes_stale_managed_link() {
        use freshell_runtime_protocol::ProviderResourceKind;

        let owned = tempfile::tempdir().unwrap();
        let provider_home = owned.path().join("provider");
        let resource_root = provider_home.join(".freshell/provider-roots/mcp-project");
        std::fs::create_dir_all(&resource_root).unwrap();
        let alias = resource_root.join(".env");
        std::os::unix::fs::symlink("/home/freshell/provider/.freshell/references/7", &alias)
            .unwrap();
        let relative_alias = ".freshell/provider-roots/mcp-project/.env".to_owned();
        super::write_projection_manifest(
            &provider_home,
            &std::collections::BTreeSet::from([relative_alias.clone()]),
        )
        .unwrap();
        let mut mount = opencode_resource_mount(
            "mcp-project",
            "/opt/mcp-project",
            "/opt/mcp-project",
            ProviderResourceKind::Directory,
            false,
        );
        mount.retired_reference_aliases = vec![".env".into()];
        let context = opencode_context_with_mounts(vec![mount]);

        super::record_provider_resource_reference_aliases(&context, &provider_home).unwrap();

        assert!(
            std::fs::symlink_metadata(&alias).unwrap_err().kind() == std::io::ErrorKind::NotFound
        );
        assert!(!super::read_projection_manifest(&provider_home)
            .unwrap()
            .contains(&relative_alias));
    }

    #[cfg(unix)]
    #[test]
    fn provider_resource_reference_alias_refuses_to_replace_resource_content() {
        use freshell_runtime_protocol::{ProviderResourceKind, ProviderResourceReferenceAlias};

        let owned = tempfile::tempdir().unwrap();
        let provider_home = owned.path().join("provider");
        let resource_root = provider_home.join(".freshell/provider-roots/mcp-project");
        std::fs::create_dir_all(&resource_root).unwrap();
        std::fs::create_dir_all(provider_home.join(".freshell/references")).unwrap();
        std::fs::write(provider_home.join(".freshell/references/0"), "secret\n").unwrap();
        std::fs::write(resource_root.join(".env"), "ordinary resource\n").unwrap();
        let mut mount = opencode_resource_mount(
            "mcp-project",
            "/opt/mcp-project",
            "/opt/mcp-project",
            ProviderResourceKind::Directory,
            false,
        );
        mount.reference_aliases = vec![ProviderResourceReferenceAlias {
            relative_path: ".env".into(),
            reference_index: 0,
        }];
        let context = opencode_context_with_mounts(vec![mount]);

        let error = super::install_provider_resource_reference_aliases(&context, &provider_home)
            .expect_err("an alias cannot overwrite an unrelated resource file");
        assert!(error.contains("replace an existing resource"));
        assert_eq!(
            std::fs::read_to_string(resource_root.join(".env")).unwrap(),
            "ordinary resource\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn provider_resource_reference_alias_cannot_escape_through_parent_symlink() {
        use freshell_runtime_protocol::{ProviderResourceKind, ProviderResourceReferenceAlias};

        let owned = tempfile::tempdir().unwrap();
        let provider_home = owned.path().join("provider");
        let resource_root = provider_home.join(".freshell/provider-roots/mcp-project");
        let outside = owned.path().join("outside");
        std::fs::create_dir_all(&resource_root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::create_dir_all(provider_home.join(".freshell/references")).unwrap();
        std::fs::write(provider_home.join(".freshell/references/0"), "secret\n").unwrap();
        std::os::unix::fs::symlink(&outside, resource_root.join("nested")).unwrap();
        std::os::unix::fs::symlink(
            "/home/freshell/provider/.freshell/references/0",
            outside.join(".env"),
        )
        .unwrap();
        let mut mount = opencode_resource_mount(
            "mcp-project",
            "/opt/mcp-project",
            "/opt/mcp-project",
            ProviderResourceKind::Directory,
            false,
        );
        mount.reference_aliases = vec![ProviderResourceReferenceAlias {
            relative_path: "nested/.env".into(),
            reference_index: 0,
        }];
        mount.retired_reference_aliases = vec!["nested/.env".into()];
        let context = opencode_context_with_mounts(vec![mount]);

        let error = super::install_provider_resource_reference_aliases(&context, &provider_home)
            .expect_err("an alias parent must remain inside its managed resource directory");
        assert!(error.contains("parent directory"));
        assert!(std::fs::symlink_metadata(outside.join(".env")).is_ok());
    }

    #[test]
    fn provider_config_recovery_migrates_nested_writable_file_under_external_directory() {
        use freshell_runtime_protocol::ProviderResourceKind;

        let owned = tempfile::tempdir().unwrap();
        let user_root = owned.path().join("provider");
        let workspace = owned.path().join("workspace");
        let home = owned.path().join("home");
        let directory_source = user_root.join(".freshell/resource-units/external-directory");
        let file_source = user_root.join(".freshell/resource-units/external-state/source");
        let directory_relative = PathBuf::from(".freshell/provider-roots/external-directory");
        let file_relative = PathBuf::from(".freshell/provider-roots/external-state/source");
        std::fs::create_dir_all(&directory_source).unwrap();
        std::fs::create_dir_all(file_source.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(directory_source.join("state.json"), "external seed").unwrap();
        std::fs::write(directory_source.join("ordinary.json"), "ordinary seed").unwrap();
        std::fs::write(&file_source, "stale exact seed").unwrap();

        let directory = opencode_resource_mount(
            "external-directory",
            "/opt/provider-mcp",
            "/opt/provider-mcp",
            ProviderResourceKind::Directory,
            false,
        );
        let initial = opencode_context_with_mounts(vec![directory.clone()]);
        let (uid, gid) = unsafe { (libc::geteuid(), libc::getegid()) };
        copy_provider_config_references(
            &initial, "opencode", &workspace, &user_root, &home, uid, gid,
        )
        .unwrap();
        use std::io::Write;
        std::fs::OpenOptions::new()
            .append(true)
            .open(home.join(&directory_relative).join("state.json"))
            .unwrap()
            .write_all(b" + runtime state")
            .unwrap();
        std::fs::write(
            directory_source.join("state.json"),
            "external refreshed seed",
        )
        .unwrap();
        std::fs::write(
            directory_source.join("ordinary.json"),
            "ordinary refreshed seed",
        )
        .unwrap();
        std::fs::create_dir_all(home.join(file_relative.parent().unwrap())).unwrap();
        std::fs::write(home.join(&file_relative), "").unwrap();

        let writable = opencode_resource_mount(
            "external-state",
            "/opt/provider-mcp/state.json",
            "/opt/provider-mcp/state.json",
            ProviderResourceKind::File,
            true,
        );
        let refresh = opencode_context_with_mounts(vec![directory, writable]);
        refresh_provider_config_references(
            &refresh, "opencode", &workspace, &user_root, &home, uid, gid,
        )
        .unwrap();

        assert_eq!(
            std::fs::read(home.join(&file_relative)).unwrap(),
            b"external seed + runtime state",
            "new exact writable mounts under external directories must inherit prior runtime data"
        );
        assert_eq!(
            std::fs::read(home.join(&directory_relative).join("state.json")).unwrap(),
            b"external refreshed seed",
            "the directory projection must still refresh independently"
        );
        assert_eq!(
            std::fs::read(home.join(&directory_relative).join("ordinary.json")).unwrap(),
            b"ordinary refreshed seed"
        );
    }

    #[test]
    fn provider_config_recovery_uses_one_source_for_resource_aliases() {
        use freshell_runtime_protocol::ProviderResourceKind;

        let owned = tempfile::tempdir().unwrap();
        let user_root = owned.path().join("provider");
        let workspace = owned.path().join("workspace");
        let home = owned.path().join("home");
        let directory_source = user_root.join(".freshell/resource-units/aliased-directory");
        let file_source = user_root.join(".freshell/resource-units/aliased-state/source");
        let directory_relative = PathBuf::from(".freshell/provider-roots/aliased-directory");
        let file_relative = PathBuf::from(".freshell/provider-roots/aliased-state/source");
        std::fs::create_dir_all(&directory_source).unwrap();
        std::fs::create_dir_all(file_source.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(directory_source.join("state.json"), "alias seed").unwrap();
        std::fs::write(&file_source, "stale alias seed").unwrap();
        let directory = opencode_resource_mount(
            "aliased-directory",
            "/workspace/mcp",
            "/home/freshell/provider/mcp",
            ProviderResourceKind::Directory,
            false,
        );
        let initial = opencode_context_with_mounts(vec![directory.clone()]);
        let (uid, gid) = unsafe { (libc::geteuid(), libc::getegid()) };
        copy_provider_config_references(
            &initial, "opencode", &workspace, &user_root, &home, uid, gid,
        )
        .unwrap();
        use std::io::Write;
        std::fs::OpenOptions::new()
            .append(true)
            .open(home.join(&directory_relative).join("state.json"))
            .unwrap()
            .write_all(b" + runtime state")
            .unwrap();
        std::fs::create_dir_all(home.join(file_relative.parent().unwrap())).unwrap();
        std::fs::write(home.join(&file_relative), "").unwrap();

        let primary_alias = opencode_resource_mount(
            "aliased-state",
            "/workspace/mcp/state.json",
            "/home/freshell/provider/mcp/state.json",
            ProviderResourceKind::File,
            true,
        );
        let original_path_alias = opencode_resource_mount(
            "aliased-state",
            "/external/input/state.json",
            "/external/input/state.json",
            ProviderResourceKind::File,
            true,
        );
        let refresh =
            opencode_context_with_mounts(vec![directory, primary_alias, original_path_alias]);
        refresh_provider_config_references(
            &refresh, "opencode", &workspace, &user_root, &home, uid, gid,
        )
        .unwrap();

        assert_eq!(
            std::fs::read(home.join(&file_relative)).unwrap(),
            b"alias seed + runtime state",
            "aliases of one physical writable root must all use its recovered runtime source"
        );
    }

    pub(crate) fn executable_fixture() -> tempfile::TempDir {
        match std::env::var_os("FRESHELL_TEST_EXECUTABLE_TMP_DIR") {
            Some(directory) => tempfile::tempdir_in(directory),
            None => tempfile::tempdir(),
        }
        .expect("owned executable fixture directory")
    }

    /// Run a fixture executable a test has just written, retrying the
    /// transient ETXTBSY a concurrently forking test thread can cause (see the
    /// test below). Every other outcome, and a refusal that outlasts the short
    /// deadline, is returned as is.
    fn execute_fixture_with_transient_text_file_busy_retry(
        path: &Path,
    ) -> std::io::Result<std::process::Output> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
        loop {
            match std::process::Command::new(path).output() {
                Err(error)
                    if error.raw_os_error() == Some(libc::ETXTBSY)
                        && std::time::Instant::now() < deadline =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                result => return result,
            }
        }
    }

    /// Another test thread that forks while a fixture is still open for
    /// writing hands its child a copy of that write descriptor until the child
    /// execs, and exec of a file open for writing fails with ETXTBSY. Running
    /// a fixture must outlast that transient refusal.
    #[test]
    fn fixture_execution_outlasts_a_transient_text_file_busy() {
        use std::os::unix::fs::PermissionsExt;
        let root = executable_fixture();
        let script = root.path().join("run");
        std::fs::write(&script, "#!/bin/sh\nprintf busy-nonce\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let writer = std::fs::OpenOptions::new()
            .write(true)
            .open(&script)
            .unwrap();
        let release = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(50));
            drop(writer);
        });

        let output = execute_fixture_with_transient_text_file_busy_retry(&script)
            .expect("the fixture runs once no write descriptor remains");

        release.join().unwrap();
        assert!(output.status.success(), "{output:?}");
        assert_eq!(output.stdout, b"busy-nonce");
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
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let auth = home.join(".local/share/opencode/auth.json");
        std::fs::create_dir_all(auth.parent().unwrap()).unwrap();
        let native = r#"{"native":{"type":"api","key":"durable-nonce"}}"#;
        std::fs::write(&auth, native).unwrap();
        std::fs::set_permissions(&auth, std::fs::Permissions::from_mode(0o600)).unwrap();
        let before = std::fs::symlink_metadata(&auth).unwrap();
        let uid = unsafe { libc::geteuid() };
        let gid = unsafe { libc::getegid() };
        for (stage, files) in [
            ("empty-auth", Vec::new()),
            (
                "ca-only",
                vec![(".config/onecli/gateway-ca.pem", b"synthetic-ca".to_vec())],
            ),
        ] {
            prepare_provider_files_at(
                &home,
                &root.path().join(stage),
                &files,
                &[],
                uid,
                gid,
                false,
            )
            .unwrap();
            let after = std::fs::symlink_metadata(&auth).unwrap();
            assert!(after.is_file() && !after.file_type().is_symlink());
            assert_eq!(
                (after.ino(), after.uid(), after.gid(), after.mode()),
                (before.ino(), before.uid(), before.gid(), before.mode())
            );
            assert_eq!(std::fs::read_to_string(&auth).unwrap(), native);
        }
        assert_eq!(
            std::fs::read(home.join(".config/onecli/gateway-ca.pem")).unwrap(),
            b"synthetic-ca"
        );
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
        let after = std::fs::symlink_metadata(&auth).unwrap();
        assert!(after.is_file() && !after.file_type().is_symlink());
        assert_eq!(
            (after.uid(), after.gid(), after.mode() & 0o777),
            (uid, gid, 0o600)
        );
        assert_eq!(std::fs::read(&auth).unwrap(), replacement);
    }

    #[test]
    fn provider_config_refresh_recovers_interrupted_projection_before_next_refresh() {
        use super::*;
        use std::{fs, os::unix::fs::PermissionsExt};

        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let transaction = home.join(".freshell-provider-transaction-interrupted");
        let backup = transaction.join("backup");
        let stage = root.path().join("stage");
        fs::create_dir_all(home.join("skills")).unwrap();
        fs::create_dir_all(backup.join("skills")).unwrap();
        fs::create_dir_all(stage.join("projection/skills")).unwrap();
        fs::set_permissions(home.join("skills"), fs::Permissions::from_mode(0o751)).unwrap();
        fs::write(home.join("skills/command"), b"new-resource").unwrap();
        fs::write(home.join("skills/new"), b"new-owned").unwrap();
        fs::write(home.join("skills/provider-created"), b"native-state").unwrap();
        fs::write(backup.join("skills/command"), b"old-resource").unwrap();
        fs::write(backup.join("skills/stale"), b"prior-owned").unwrap();
        let previous = std::collections::BTreeSet::from([
            "skills".to_owned(),
            "skills/command".to_owned(),
            "skills/stale".to_owned(),
        ]);
        let current = std::collections::BTreeSet::from([
            "skills".to_owned(),
            "skills/command".to_owned(),
            "skills/new".to_owned(),
        ]);
        let previous_manifest =
            freshell_runtime_protocol::bounded_json_bytes(&previous, MAX_PROJECTION_METADATA_BYTES)
                .unwrap();
        let current_manifest =
            freshell_runtime_protocol::bounded_json_bytes(&current, MAX_PROJECTION_METADATA_BYTES)
                .unwrap();
        fs::write(transaction.join("manifest.backup"), &previous_manifest).unwrap();
        fs::write(home.join(PROVIDER_PROJECTION_MANIFEST), &current_manifest).unwrap();
        let entries = serde_json::json!([
            { "relative": "skills", "original": { "kind": "directory", "mode": 0o751 } },
            { "relative": "skills/command", "original": { "kind": "file", "in_place": false } },
            { "relative": "skills/stale", "original": { "kind": "file", "in_place": false } },
            { "relative": "skills/new", "original": { "kind": "missing" } }
        ]);
        fs::write(
            transaction.join(PROVIDER_PROJECTION_TRANSACTION_JOURNAL),
            serde_json::to_vec(&serde_json::json!({
                "version": 1,
                "phase": "publishing",
                "manifestExisted": true,
                "entries": entries,
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(stage.join("projection/skills/command"), b"latest-resource").unwrap();
        fs::write(stage.join("projection/skills/new"), b"latest-new-owned").unwrap();
        write_projection_manifest(&stage.join("projection"), &current).unwrap();
        fs::write(
            stage.join("manifest.json"),
            serde_json::to_vec(&["skills"]).unwrap(),
        )
        .unwrap();

        apply_staged_provider_config(&stage, &home).unwrap();

        assert_eq!(
            fs::read(home.join("skills/command")).unwrap(),
            b"latest-resource"
        );
        assert!(!home.join("skills/stale").exists());
        assert_eq!(
            fs::read(home.join("skills/provider-created")).unwrap(),
            b"native-state"
        );
        assert_eq!(
            fs::read(home.join("skills/new")).unwrap(),
            b"latest-new-owned"
        );
        assert_eq!(
            fs::metadata(home.join("skills"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o751
        );
        assert_eq!(
            fs::read(home.join(PROVIDER_PROJECTION_MANIFEST)).unwrap(),
            current_manifest
        );
        assert!(!transaction.exists());
    }

    #[cfg(unix)]
    #[test]
    fn provider_config_refresh_recovery_restores_mounted_inode_and_reference_alias() {
        use super::*;
        use std::{
            fs,
            os::unix::fs::{symlink, MetadataExt},
        };

        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let transaction = home.join(".freshell-provider-transaction-mounted");
        let backup = transaction.join("backup/.freshell/provider-roots/mcp-project");
        let resource = home.join(".freshell/provider-roots/mcp-project");
        let references = home.join(".freshell/references");
        fs::create_dir_all(&resource).unwrap();
        fs::create_dir_all(&references).unwrap();
        fs::create_dir_all(&backup).unwrap();
        fs::write(references.join("0"), b"new reference").unwrap();
        fs::write(references.join("1"), b"old reference").unwrap();
        let mounted_file = resource.join("state.json");
        fs::write(&mounted_file, b"new mounted state").unwrap();
        let original_inode = fs::metadata(&mounted_file).unwrap().ino();
        fs::write(backup.join("state.json"), b"old mounted state").unwrap();
        symlink(
            "/home/freshell/provider/.freshell/references/0",
            resource.join(".env"),
        )
        .unwrap();
        symlink(
            "/home/freshell/provider/.freshell/references/1",
            backup.join(".env"),
        )
        .unwrap();
        fs::write(resource.join("new-file"), b"uncommitted").unwrap();
        let previous = std::collections::BTreeSet::from([
            ".freshell".to_owned(),
            ".freshell/provider-roots".to_owned(),
            ".freshell/provider-roots/mcp-project".to_owned(),
            ".freshell/provider-roots/mcp-project/state.json".to_owned(),
            ".freshell/provider-roots/mcp-project/.env".to_owned(),
        ]);
        let current = std::collections::BTreeSet::from([
            ".freshell".to_owned(),
            ".freshell/provider-roots".to_owned(),
            ".freshell/provider-roots/mcp-project".to_owned(),
            ".freshell/provider-roots/mcp-project/state.json".to_owned(),
            ".freshell/provider-roots/mcp-project/.env".to_owned(),
            ".freshell/provider-roots/mcp-project/new-file".to_owned(),
        ]);
        let previous_manifest =
            freshell_runtime_protocol::bounded_json_bytes(&previous, MAX_PROJECTION_METADATA_BYTES)
                .unwrap();
        let current_manifest =
            freshell_runtime_protocol::bounded_json_bytes(&current, MAX_PROJECTION_METADATA_BYTES)
                .unwrap();
        fs::write(
            transaction.join(PROVIDER_PROJECTION_TRANSACTION_MANIFEST_BACKUP),
            &previous_manifest,
        )
        .unwrap();
        fs::write(home.join(PROVIDER_PROJECTION_MANIFEST), current_manifest).unwrap();
        let entries = serde_json::json!([
            { "relative": ".freshell", "original": { "kind": "directory", "mode": 0o700 } },
            { "relative": ".freshell/provider-roots", "original": { "kind": "directory", "mode": 0o700 } },
            { "relative": ".freshell/provider-roots/mcp-project", "original": { "kind": "directory", "mode": 0o700 } },
            { "relative": ".freshell/provider-roots/mcp-project/state.json", "original": { "kind": "file", "in_place": true } },
            { "relative": ".freshell/provider-roots/mcp-project/.env", "original": { "kind": "symlink" } },
            { "relative": ".freshell/provider-roots/mcp-project/new-file", "original": { "kind": "missing" } }
        ]);
        fs::write(
            transaction.join(PROVIDER_PROJECTION_TRANSACTION_JOURNAL),
            serde_json::to_vec(&serde_json::json!({
                "version": 1,
                "phase": "publishing",
                "manifestExisted": true,
                "entries": entries,
            }))
            .unwrap(),
        )
        .unwrap();

        recover_provider_projection_transactions(&home).unwrap();

        assert_eq!(fs::read(&mounted_file).unwrap(), b"old mounted state");
        assert_eq!(fs::metadata(&mounted_file).unwrap().ino(), original_inode);
        assert_eq!(
            fs::read_link(resource.join(".env")).unwrap(),
            Path::new("/home/freshell/provider/.freshell/references/1")
        );
        assert!(!resource.join("new-file").exists());
        assert_eq!(
            fs::read(home.join(PROVIDER_PROJECTION_MANIFEST)).unwrap(),
            previous_manifest
        );
        assert!(!transaction.exists());
    }

    #[test]
    fn provider_projection_recovery_cleans_a_rolled_back_transaction_without_replaying_it() {
        use super::*;
        use std::fs;

        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let transaction = home.join(format!(
            "{PROVIDER_PROJECTION_TRANSACTION_PREFIX}rolled-back"
        ));
        fs::create_dir_all(transaction.join("desired/partial")).unwrap();
        fs::create_dir_all(&home).unwrap();
        fs::write(transaction.join("desired/partial/file"), b"staged residue").unwrap();
        fs::write(
            transaction.join(PROVIDER_PROJECTION_TRANSACTION_JOURNAL),
            serde_json::to_vec(&serde_json::json!({
                "version": 1,
                "phase": "rolled_back",
                "manifestExisted": false,
                "entries": [
                    { "relative": "mounted/state.json", "original": { "kind": "file", "in_place": true } }
                ],
            }))
            .unwrap(),
        )
        .unwrap();

        recover_provider_projection_transactions(&home).unwrap();

        assert!(
            !transaction.exists(),
            "a rollback-complete journal makes leftover stage data safe to remove"
        );
    }

    #[test]
    fn provider_refresh_recovery_removes_an_interrupted_private_stage() {
        use super::*;
        use std::fs;

        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let abandoned = home.join(".freshell-provider-refresh-interrupted");
        fs::create_dir_all(&abandoned).unwrap();
        fs::write(
            abandoned.join("private-config.json"),
            b"partial selected config",
        )
        .unwrap();
        fs::create_dir_all(home.join("unrelated-state")).unwrap();

        let _projection_lock = lock_provider_projection(&home).unwrap();
        recover_provider_projection_transactions(&home).unwrap();
        cleanup_orphaned_provider_refresh_stages(&home, None).unwrap();

        assert!(
            !abandoned.exists(),
            "a later refresh removes private staging data left by a killed worker"
        );
        assert!(home.join("unrelated-state").is_dir());
    }

    #[test]
    fn provider_projection_recovery_restores_children_after_directory_becomes_file() {
        use super::*;
        use std::{fs, os::unix::fs::PermissionsExt};

        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let transaction = home.join(".freshell-provider-transaction-directory-change");
        let backup = transaction.join("backup/skills");
        fs::create_dir_all(home.join("skills")).unwrap();
        fs::create_dir_all(&backup).unwrap();
        fs::set_permissions(home.join("skills"), fs::Permissions::from_mode(0o751)).unwrap();
        fs::write(backup.join("command"), b"prior executable").unwrap();
        fs::remove_dir(home.join("skills")).unwrap();
        fs::write(home.join("skills"), b"replacement file").unwrap();
        let previous =
            std::collections::BTreeSet::from(["skills".to_owned(), "skills/command".to_owned()]);
        let previous_manifest =
            freshell_runtime_protocol::bounded_json_bytes(&previous, MAX_PROJECTION_METADATA_BYTES)
                .unwrap();
        fs::write(
            transaction.join(PROVIDER_PROJECTION_TRANSACTION_MANIFEST_BACKUP),
            &previous_manifest,
        )
        .unwrap();
        fs::write(home.join(PROVIDER_PROJECTION_MANIFEST), b"[\"skills\"]").unwrap();
        fs::write(
            transaction.join(PROVIDER_PROJECTION_TRANSACTION_JOURNAL),
            serde_json::to_vec(&serde_json::json!({
                "version": 1,
                "phase": "publishing",
                "manifestExisted": true,
                "entries": [
                    { "relative": "skills", "original": { "kind": "directory", "mode": 0o751 } },
                    { "relative": "skills/command", "original": { "kind": "file", "in_place": false } }
                ],
            }))
            .unwrap(),
        )
        .unwrap();

        recover_provider_projection_transactions(&home).unwrap();

        assert_eq!(
            fs::read(home.join("skills/command")).unwrap(),
            b"prior executable"
        );
        assert_eq!(
            fs::metadata(home.join("skills"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o751
        );
        assert_eq!(
            fs::read(home.join(PROVIDER_PROJECTION_MANIFEST)).unwrap(),
            previous_manifest
        );
        assert!(!transaction.exists());
    }

    #[test]
    fn provider_projection_lock_serializes_refreshes_for_one_home() {
        use super::*;
        use std::sync::mpsc;

        let home = tempfile::tempdir().unwrap();
        let first = lock_provider_projection(home.path()).unwrap();
        let (started_tx, started_rx) = mpsc::channel();
        let (acquired_tx, acquired_rx) = mpsc::channel();
        let second_home = home.path().to_path_buf();
        let second = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            let _lock = lock_provider_projection(&second_home).unwrap();
            acquired_tx.send(()).unwrap();
        });

        started_rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .expect("second refresh attempted to acquire the shared lock");
        assert!(acquired_rx
            .recv_timeout(std::time::Duration::from_millis(100))
            .is_err());
        drop(first);
        acquired_rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .expect("second refresh proceeds after the first releases the lock");
        second.join().unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn prepared_provider_projection_reuses_payload_and_retains_transaction_guarantees() {
        use std::{
            collections::BTreeSet,
            ffi::CString,
            fs,
            io::Read,
            os::{fd::FromRawFd, unix::fs::PermissionsExt},
        };

        for fail_manifest in [false, true] {
            let root = executable_fixture();
            let home = root.path().join("home");
            let selected = root.path().join("selected");
            fs::create_dir_all(home.join("skills")).unwrap();
            fs::create_dir(&selected).unwrap();
            fs::write(home.join("skills/command"), b"prior command").unwrap();
            fs::write(home.join("skills/stale"), b"prior selected resource").unwrap();
            fs::write(home.join("skills/native-session"), b"native history").unwrap();
            fs::write(selected.join("dependency"), b"new-resource").unwrap();
            fs::write(
                selected.join("command"),
                "#!/bin/sh\ncat \"$(dirname \"$0\")/dependency\"\n",
            )
            .unwrap();
            fs::set_permissions(selected.join("command"), fs::Permissions::from_mode(0o751))
                .unwrap();
            std::os::unix::fs::symlink("command", selected.join("alias")).unwrap();
            let previous = BTreeSet::from([
                "skills".into(),
                "skills/command".into(),
                "skills/stale".into(),
            ]);
            write_projection_manifest(&home, &previous).unwrap();
            let prior_manifest = fs::read(home.join(PROVIDER_PROJECTION_MANIFEST)).unwrap();
            let prepared = home.join("prepared");
            let report = freshell_platform::provider_environment::copy_environment(
                &[freshell_platform::provider_environment::CopySelection {
                    source: selected,
                    destination_relative: "skills".into(),
                }],
                &prepared,
                &[],
                Default::default(),
            )
            .unwrap();
            let current = report
                .projected_paths
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect::<BTreeSet<_>>();
            // Observe real payload reads, including cached reads. Filesystem
            // access-time policy cannot hide a redundant second copy.
            let fd = unsafe { libc::inotify_init1(libc::IN_CLOEXEC | libc::IN_NONBLOCK) };
            assert!(fd >= 0);
            let mut observer = unsafe { fs::File::from_raw_fd(fd) };
            let payload = CString::new(
                prepared
                    .join("skills/dependency")
                    .as_os_str()
                    .as_encoded_bytes(),
            )
            .unwrap();
            assert!(unsafe { libc::inotify_add_watch(fd, payload.as_ptr(), libc::IN_ACCESS) } >= 0);
            let selections = [freshell_platform::provider_environment::CopySelection {
                source: prepared.join("skills"),
                destination_relative: "skills".into(),
            }];
            let result = publish_provider_projection(
                ProviderProjection {
                    provider: "amplifier",
                    workspace: None,
                    selections: &selections,
                    home: &home,
                    previous: &previous,
                    current: &current,
                    protected: &BTreeSet::new(),
                    mounted: &[],
                    preserve_existing_mounted_files: &[],
                    reference_aliases: Default::default(),
                },
                Some(PreparedProviderProjection {
                    root: prepared,
                    projected_paths: current.clone(),
                }),
                |source, destination| {
                    assert!(!home.join("skills/stale").exists());
                    assert!(home.join("skills/dependency").exists());
                    if fail_manifest {
                        Err(std::io::Error::other(
                            "injected manifest publication failure",
                        ))
                    } else {
                        fs::rename(source, destination)
                    }
                },
            );
            let mut events = [0u8; 4096];
            match observer.read(&mut events) {
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Ok(length) => {
                    let mut offset = 0;
                    while offset + 16 <= length {
                        let mask =
                            u32::from_ne_bytes(events[offset + 4..offset + 8].try_into().unwrap());
                        let name_length = u32::from_ne_bytes(
                            events[offset + 12..offset + 16].try_into().unwrap(),
                        );
                        assert_eq!(
                            mask & libc::IN_ACCESS,
                            0,
                            "publication must reuse prepared payload, including during rollback"
                        );
                        offset += 16 + name_length as usize;
                    }
                    assert_eq!(offset, length);
                }
                other => panic!("owned payload read observer failed: {other:?}"),
            }
            assert_eq!(
                fs::read(home.join("skills/native-session")).unwrap(),
                b"native history"
            );
            if fail_manifest {
                assert!(result.unwrap_err().contains("publish manifest"));
                assert_eq!(
                    fs::read(home.join("skills/command")).unwrap(),
                    b"prior command"
                );
                assert_eq!(
                    fs::read(home.join("skills/stale")).unwrap(),
                    b"prior selected resource"
                );
                assert!(!home.join("skills/dependency").exists());
                assert_eq!(
                    fs::read(home.join(PROVIDER_PROJECTION_MANIFEST)).unwrap(),
                    prior_manifest
                );
            } else {
                result.unwrap();
                let consumer = std::process::Command::new(home.join("skills/alias"))
                    .output()
                    .unwrap();
                assert!(consumer.status.success());
                assert_eq!(consumer.stdout, b"new-resource");
                assert_eq!(
                    fs::metadata(home.join("skills/command"))
                        .unwrap()
                        .permissions()
                        .mode()
                        & 0o777,
                    0o711
                );
                assert_eq!(read_projection_manifest(&home).unwrap(), current);
            }
        }
    }

    #[test]
    fn provider_config_manifest_rename_failure_restores_every_published_leaf() {
        use std::{collections::BTreeSet, fs, os::unix::fs::PermissionsExt};
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let selected = root.path().join("selected");
        fs::create_dir_all(home.join("skills")).unwrap();
        fs::create_dir(&selected).unwrap();
        fs::write(
            home.join("skills/command"),
            "#!/bin/sh\nprintf old-resource",
        )
        .unwrap();
        fs::set_permissions(
            home.join("skills/command"),
            fs::Permissions::from_mode(0o751),
        )
        .unwrap();
        fs::write(home.join("skills/stale"), "prior-owned").unwrap();
        fs::write(home.join("skills/provider-created"), "native-state").unwrap();
        fs::write(selected.join("command"), "#!/bin/sh\nprintf new-resource").unwrap();
        fs::set_permissions(selected.join("command"), fs::Permissions::from_mode(0o751)).unwrap();
        fs::write(selected.join("new"), "new-owned").unwrap();
        let previous = BTreeSet::from([
            "skills".into(),
            "skills/command".into(),
            "skills/stale".into(),
        ]);
        let current = BTreeSet::from([
            "skills".into(),
            "skills/command".into(),
            "skills/new".into(),
        ]);
        write_projection_manifest(&home, &previous).unwrap();
        let before = fs::read(home.join(PROVIDER_PROJECTION_MANIFEST)).unwrap();
        let occupied = root.path().join("occupied");
        fs::create_dir(&occupied).unwrap();
        let selections = [freshell_platform::provider_environment::CopySelection {
            source: selected,
            destination_relative: "skills".into(),
        }];
        let result = publish_provider_projection_with_manifest(
            ProviderProjection {
                provider: "codex",
                workspace: None,
                selections: &selections,
                home: &home,
                previous: &previous,
                current: &current,
                protected: &BTreeSet::new(),
                mounted: &[],
                preserve_existing_mounted_files: &[],
                reference_aliases: Default::default(),
            },
            |source, _destination| {
                // This callback occupies only the final publication boundary. The
                // preceding production filesystem operations all execute normally.
                assert_eq!(
                    fs::read(home.join("skills/command")).unwrap(),
                    b"#!/bin/sh\nprintf new-resource"
                );
                assert!(!home.join("skills/stale").exists());
                assert!(home.join("skills/new").exists());
                fs::rename(source, &occupied)
            },
        );
        let error = result.unwrap_err();
        assert!(error.contains("publish manifest"), "{error}");
        assert_eq!(
            fs::read(home.join("skills/command")).unwrap(),
            b"#!/bin/sh\nprintf old-resource"
        );
        assert_eq!(
            fs::metadata(home.join("skills/command"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o751
        );
        assert_eq!(fs::read(home.join("skills/stale")).unwrap(), b"prior-owned");
        assert_eq!(
            fs::read(home.join("skills/provider-created")).unwrap(),
            b"native-state"
        );
        assert!(!home.join("skills/new").exists());
        assert_eq!(
            fs::read(home.join(PROVIDER_PROJECTION_MANIFEST)).unwrap(),
            before
        );
        assert!(!fs::read_dir(&home).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".freshell-provider-transaction-")));
    }

    #[cfg(unix)]
    #[test]
    fn provider_reference_aliases_roll_back_with_projection_when_manifest_publish_fails() {
        use std::{collections::BTreeSet, fs, os::unix::fs::symlink};

        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let selected = root.path().join("selected");
        let resource_relative = Path::new(".freshell/provider-roots/mcp-project");
        let resource_root = home.join(resource_relative);
        fs::create_dir_all(&resource_root).unwrap();
        fs::create_dir_all(home.join(".freshell/references")).unwrap();
        fs::create_dir(&selected).unwrap();
        fs::write(home.join(".freshell/references/0"), "new reference").unwrap();
        fs::write(home.join(".freshell/references/1"), "prior reference").unwrap();
        fs::write(resource_root.join("server.mjs"), "prior resource").unwrap();
        symlink(
            "/home/freshell/provider/.freshell/references/1",
            resource_root.join(".env"),
        )
        .unwrap();
        symlink(
            "/home/freshell/provider/.freshell/references/1",
            resource_root.join(".oldenv"),
        )
        .unwrap();
        fs::write(selected.join("server.mjs"), "new resource").unwrap();

        let alias = resource_relative
            .join(".env")
            .to_string_lossy()
            .into_owned();
        let retired = resource_relative
            .join(".oldenv")
            .to_string_lossy()
            .into_owned();
        let previous = BTreeSet::from([
            ".freshell".into(),
            ".freshell/provider-roots".into(),
            resource_relative.to_string_lossy().into_owned(),
            resource_relative
                .join("server.mjs")
                .to_string_lossy()
                .into_owned(),
            alias.clone(),
            retired.clone(),
        ]);
        let current = BTreeSet::from([
            ".freshell".into(),
            ".freshell/provider-roots".into(),
            resource_relative.to_string_lossy().into_owned(),
            resource_relative
                .join("server.mjs")
                .to_string_lossy()
                .into_owned(),
        ]);
        write_projection_manifest(&home, &previous).unwrap();
        let prior_manifest = fs::read(home.join(PROVIDER_PROJECTION_MANIFEST)).unwrap();
        let selections = [freshell_platform::provider_environment::CopySelection {
            source: selected,
            destination_relative: resource_relative.to_path_buf(),
        }];
        let reference_aliases = ProviderResourceReferenceAliasPlan {
            active: vec![ProviderResourceReferenceAliasInstall {
                mount_root: resource_relative.to_string_lossy().into_owned(),
                relative_path: ".env".into(),
                reference_index: 0,
            }],
            retired: vec![ProviderResourceReferenceAliasRetirement {
                mount_root: resource_relative.to_string_lossy().into_owned(),
                relative_path: ".oldenv".into(),
            }],
        };

        let result = publish_provider_projection_with_manifest(
            ProviderProjection {
                provider: "opencode",
                workspace: None,
                selections: &selections,
                home: &home,
                previous: &previous,
                current: &current,
                protected: &BTreeSet::new(),
                mounted: &[],
                preserve_existing_mounted_files: &[],
                reference_aliases,
            },
            |_source, _destination| {
                assert_eq!(
                    fs::read(resource_root.join("server.mjs")).unwrap(),
                    b"new resource"
                );
                assert_eq!(
                    fs::read_link(resource_root.join(".env")).unwrap(),
                    Path::new("/home/freshell/provider/.freshell/references/0")
                );
                assert!(!resource_root.join(".oldenv").exists());
                Err(std::io::Error::other("injected manifest publish failure"))
            },
        );

        assert!(result.unwrap_err().contains("publish manifest"));
        assert_eq!(
            fs::read(resource_root.join("server.mjs")).unwrap(),
            b"prior resource"
        );
        assert_eq!(
            fs::read_link(resource_root.join(".env")).unwrap(),
            Path::new("/home/freshell/provider/.freshell/references/1")
        );
        assert_eq!(
            fs::read_link(resource_root.join(".oldenv")).unwrap(),
            Path::new("/home/freshell/provider/.freshell/references/1")
        );
        assert_eq!(
            fs::read(home.join(PROVIDER_PROJECTION_MANIFEST)).unwrap(),
            prior_manifest
        );
        assert!(!fs::read_dir(&home).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".freshell-provider-transaction-")));
    }

    #[test]
    fn provider_native_auth_failed_replacement_retains_prior_usable_destination() {
        use std::{
            fs,
            os::unix::fs::{MetadataExt, PermissionsExt},
        };
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let auth_dir = root.path().join("auth");
        let relative = ".local/share/opencode/auth.json";
        let auth = home.join(relative);
        fs::create_dir_all(auth.parent().unwrap()).unwrap();
        let uid = unsafe { libc::geteuid() };
        let gid = unsafe { libc::getegid() };
        prepare_provider_files_at(
            &home,
            &auth_dir,
            &[(relative, b"prior-typed-auth".to_vec())],
            &[],
            uid,
            gid,
            false,
        )
        .unwrap();
        let prior = fs::symlink_metadata(&auth).unwrap();
        assert!(prior.is_file() && !prior.file_type().is_symlink());
        fs::write(auth_dir.join("unrelated"), b"preserve").unwrap();
        fs::set_permissions(auth.parent().unwrap(), fs::Permissions::from_mode(0o500)).unwrap();
        let failed = prepare_provider_files_at(
            &home,
            &auth_dir,
            &[(relative, b"replacement-auth".to_vec())],
            &[],
            uid,
            gid,
            false,
        );
        fs::set_permissions(auth.parent().unwrap(), fs::Permissions::from_mode(0o700)).unwrap();
        assert!(failed.is_err());
        let after = fs::symlink_metadata(&auth).unwrap();
        assert!(after.is_file() && !after.file_type().is_symlink());
        assert_eq!(
            (after.ino(), after.uid(), after.gid(), after.mode()),
            (prior.ino(), prior.uid(), prior.gid(), prior.mode())
        );
        assert_eq!(
            fs::read(&auth).unwrap(),
            b"prior-typed-auth",
            "failed selected auth publication changed the old destination's contents"
        );
        assert_eq!(fs::read(auth_dir.join("unrelated")).unwrap(), b"preserve");
        assert_eq!(
            fs::read_dir(&auth_dir).unwrap().count(),
            1,
            "failed auth publication must remove only its attempt resources"
        );
        prepare_provider_files_at(
            &home,
            &auth_dir,
            &[(relative, b"replacement-auth".to_vec())],
            &[],
            uid,
            gid,
            false,
        )
        .unwrap();
        assert_eq!(fs::read(&auth).unwrap(), b"replacement-auth");
        assert_eq!(fs::read_dir(&auth_dir).unwrap().count(), 1);
    }

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
                    writable: false,
                    reference_aliases: vec![],
                    retired_reference_aliases: vec![],
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
    fn provider_config_recovery_preserves_written_writable_file_and_refreshes_read_only_file() {
        use freshell_runtime_protocol::*;
        let owned = tempfile::tempdir().unwrap();
        let source_root = owned.path().join("source");
        let user_root = source_root.join("provider");
        let workspace = owned.path().join("workspace");
        let home = owned.path().join("home");
        let directory_source = user_root.join(".freshell/resource-units/directory");
        let directory_relative = PathBuf::from(".freshell/provider-roots/directory");
        let preserved_source = user_root.join(".freshell/resource-units/preserved/source");
        let writable_source = user_root.join(".freshell/resource-units/writable/source");
        let readonly_source = user_root.join(".freshell/resource-units/readonly/source");
        let deleted_source = user_root.join(".freshell/resource-units/deleted/source");
        let preserved_relative = PathBuf::from(".freshell/provider-roots/preserved/source");
        let writable_relative = PathBuf::from(".freshell/provider-roots/writable/source");
        let readonly_relative = PathBuf::from(".freshell/provider-roots/readonly/source");
        std::fs::create_dir_all(&directory_source).unwrap();
        std::fs::create_dir_all(preserved_source.parent().unwrap()).unwrap();
        std::fs::create_dir_all(writable_source.parent().unwrap()).unwrap();
        std::fs::create_dir_all(readonly_source.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(home.join(&directory_relative)).unwrap();
        std::fs::create_dir_all(home.join(preserved_relative.parent().unwrap())).unwrap();
        std::fs::create_dir_all(home.join(writable_relative.parent().unwrap())).unwrap();
        std::fs::create_dir_all(home.join(readonly_relative.parent().unwrap())).unwrap();
        std::fs::write(directory_source.join("state.txt"), "directory seed").unwrap();
        std::fs::write(
            directory_source.join("removed.txt"),
            "deleted directory seed",
        )
        .unwrap();
        std::fs::write(&preserved_source, "preserved seed").unwrap();
        std::fs::write(&writable_source, "writable seed").unwrap();
        std::fs::write(&readonly_source, "readonly seed").unwrap();
        // Resource roots exist as physical placeholders before initial
        // publication, just as their Docker volume subpath mounts do.
        std::fs::write(home.join(&preserved_relative), "").unwrap();
        std::fs::write(home.join(&writable_relative), "").unwrap();
        std::fs::write(home.join(&readonly_relative), "").unwrap();
        let capability = McpCapabilityReference {
            grant_id: format!("grant-{}", uuid::Uuid::new_v4()),
            endpoint: "http://host.docker.internal:1234".into(),
            provider_relative_path: ".freshell/mcp-capability.json".into(),
            host_gateway_address: None,
        };
        let mut context = ProviderLaunchContext {
            config: vec![],
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
                resource_mounts: vec![
                    ProviderResourceMount {
                        stage_relative_path: ".freshell/resource-units/directory".into(),
                        provider_relative_path: directory_relative.to_string_lossy().into_owned(),
                        logical_destination: "/home/freshell/provider/mcp".into(),
                        effective_destination: "/home/freshell/provider/mcp".into(),
                        kind: ProviderResourceKind::Directory,
                        writable: false,
                        reference_aliases: vec![],
                        retired_reference_aliases: vec![],
                    },
                    ProviderResourceMount {
                        stage_relative_path: ".freshell/resource-units/preserved/source".into(),
                        provider_relative_path: preserved_relative.to_string_lossy().into_owned(),
                        logical_destination: "/home/freshell/provider/mcp/preserved.txt".into(),
                        effective_destination: "/home/freshell/provider/mcp/preserved.txt".into(),
                        kind: ProviderResourceKind::File,
                        writable: true,
                        reference_aliases: vec![],
                        retired_reference_aliases: vec![],
                    },
                    ProviderResourceMount {
                        stage_relative_path: ".freshell/resource-units/readonly/source".into(),
                        provider_relative_path: readonly_relative.to_string_lossy().into_owned(),
                        logical_destination: "/home/freshell/provider/mcp/reference.txt".into(),
                        effective_destination: "/home/freshell/provider/mcp/reference.txt".into(),
                        kind: ProviderResourceKind::File,
                        writable: false,
                        reference_aliases: vec![],
                        retired_reference_aliases: vec![],
                    },
                ],
            }),
            mcp_capability: Some(capability),
        };
        let (uid, gid) = unsafe { (libc::geteuid(), libc::getegid()) };
        copy_provider_config_references(
            &context, "opencode", &workspace, &user_root, &home, uid, gid,
        )
        .unwrap();
        assert_eq!(
            std::fs::read(home.join(&directory_relative).join("state.txt")).unwrap(),
            b"directory seed"
        );
        use std::io::Write;
        std::fs::OpenOptions::new()
            .append(true)
            .open(home.join(&preserved_relative))
            .unwrap()
            .write_all(b" + exact runtime state")
            .unwrap();
        std::fs::OpenOptions::new()
            .append(true)
            .open(home.join(&directory_relative).join("state.txt"))
            .unwrap()
            .write_all(b" + runtime state")
            .unwrap();
        std::fs::write(
            directory_source.join("state.txt"),
            "refreshed directory seed",
        )
        .unwrap();
        std::fs::write(&preserved_source, "refreshed preserved seed").unwrap();
        std::fs::write(&writable_source, "refreshed writable seed").unwrap();
        std::fs::write(&readonly_source, "refreshed readonly seed").unwrap();
        context
            .prepared_inputs
            .as_mut()
            .unwrap()
            .resource_mounts
            .push(ProviderResourceMount {
                stage_relative_path: ".freshell/resource-units/writable/source".into(),
                provider_relative_path: writable_relative.to_string_lossy().into_owned(),
                logical_destination: "/home/freshell/provider/mcp/state.txt".into(),
                effective_destination: "/home/freshell/provider/mcp/state.txt".into(),
                kind: ProviderResourceKind::File,
                writable: true,
                reference_aliases: vec![],
                retired_reference_aliases: vec![],
            });

        refresh_provider_config_references(
            &context, "opencode", &workspace, &user_root, &home, uid, gid,
        )
        .unwrap();

        assert_eq!(
            std::fs::read(home.join(&directory_relative).join("state.txt")).unwrap(),
            b"refreshed directory seed",
            "the selected directory's ordinary children must still refresh"
        );
        assert_eq!(
            std::fs::read(home.join(&writable_relative)).unwrap(),
            b"directory seed + runtime state",
            "adding an exact writable mount must migrate the prior directory-backed runtime data"
        );
        assert_eq!(
            std::fs::read(home.join(&preserved_relative)).unwrap(),
            b"preserved seed + exact runtime state",
            "an existing exact writable mount must keep its runtime data across refresh"
        );
        assert_eq!(
            std::fs::read(home.join(&readonly_relative)).unwrap(),
            b"refreshed readonly seed",
            "read-only inputs still refresh from their selected source"
        );

        // If a new exact writable mount replaces a directory child that the
        // provider deleted, recovery must not silently restore stale staged
        // contents from the original host source.
        std::fs::create_dir_all(deleted_source.parent().unwrap()).unwrap();
        std::fs::write(&deleted_source, "stale host seed").unwrap();
        let deleted_relative = PathBuf::from(".freshell/provider-roots/deleted/source");
        std::fs::create_dir_all(home.join(deleted_relative.parent().unwrap())).unwrap();
        std::fs::write(home.join(&deleted_relative), "").unwrap();
        std::fs::remove_file(home.join(&directory_relative).join("removed.txt")).unwrap();
        context
            .prepared_inputs
            .as_mut()
            .unwrap()
            .resource_mounts
            .push(ProviderResourceMount {
                stage_relative_path: ".freshell/resource-units/deleted/source".into(),
                provider_relative_path: deleted_relative.to_string_lossy().into_owned(),
                logical_destination: "/home/freshell/provider/mcp/removed.txt".into(),
                effective_destination: "/home/freshell/provider/mcp/removed.txt".into(),
                kind: ProviderResourceKind::File,
                writable: true,
                reference_aliases: vec![],
                retired_reference_aliases: vec![],
            });
        let recovery = refresh_provider_config_references(
            &context, "opencode", &workspace, &user_root, &home, uid, gid,
        );
        assert!(
            matches!(recovery, Err(ref error) if error.contains("was deleted")),
            "deleted prior writable state must block recovery instead of restoring stale source"
        );
        assert_eq!(
            std::fs::read(home.join(&deleted_relative)).unwrap(),
            b"",
            "blocked recovery must not restore stale host content into the mount placeholder"
        );
    }

    #[test]
    fn provider_config_resource_projection_excludes_workspace_nested_in_package_root() {
        use freshell_runtime_protocol::*;
        let owned = tempfile::tempdir().unwrap();
        let user_root = owned.path().join("source");
        let package = owned.path().join("external");
        let workspace = package.join("project");
        let unit = user_root.join(".freshell/resource-units/root-0");
        let provider_home = owned.path().join("home");
        let provider_resource = provider_home.join(".freshell/provider-roots/root-0");
        let linked_package = unit.join("project/packages/worker-package");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(unit.join("tools")).unwrap();
        std::fs::create_dir_all(&linked_package).unwrap();
        std::os::unix::fs::symlink(
            "../project/packages/worker-package/server.mjs",
            unit.join("tools/server.mjs"),
        )
        .unwrap();
        std::fs::write(linked_package.join("package.json"), r#"{"type":"module"}"#).unwrap();
        std::fs::write(
            linked_package.join("schema.json"),
            r#"{"nonce":"session-host-linked-sibling-loaded"}"#,
        )
        .unwrap();
        std::fs::write(
            linked_package.join("server.mjs"),
            "import { readFileSync } from 'node:fs';\nconst schema = JSON.parse(readFileSync(new URL('./schema.json', import.meta.url), 'utf8'));\nprocess.stdout.write(schema.nonce + '\\n');\n",
        )
        .unwrap();
        std::fs::write(unit.join("schema.json"), "package asset\n").unwrap();
        std::fs::write(
            unit.join("project/workspace-data.txt"),
            "mounted workspace\n",
        )
        .unwrap();
        let capability = McpCapabilityReference {
            grant_id: format!("grant-{}", uuid::Uuid::new_v4()),
            endpoint: "http://host.docker.internal:1234".into(),
            provider_relative_path: ".freshell/mcp-capability.json".into(),
            host_gateway_address: None,
        };
        let context = ProviderLaunchContext {
            config: vec![],
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
                resource_mounts: vec![
                    ProviderResourceMount {
                        stage_relative_path: ".freshell/resource-units/root-0".into(),
                        provider_relative_path: ".freshell/provider-roots/root-0".into(),
                        logical_destination: package.to_string_lossy().into_owned(),
                        effective_destination: package.to_string_lossy().into_owned(),
                        kind: ProviderResourceKind::Directory,
                        writable: false,
                        reference_aliases: vec![],
                        retired_reference_aliases: vec![],
                    },
                    ProviderResourceMount {
                        stage_relative_path: ".freshell/resource-units/root-0".into(),
                        provider_relative_path: ".freshell/provider-roots/root-0".into(),
                        logical_destination: "/home/freshell/.config/opencode".into(),
                        effective_destination: "/home/freshell/provider/.config/opencode".into(),
                        kind: ProviderResourceKind::Directory,
                        writable: false,
                        reference_aliases: vec![],
                        retired_reference_aliases: vec![],
                    },
                ],
            }),
            mcp_capability: Some(capability),
        };
        let (uid, gid) = unsafe { (libc::geteuid(), libc::getegid()) };

        copy_provider_config_references(
            &context,
            "opencode",
            &workspace,
            &user_root,
            &provider_home,
            uid,
            gid,
        )
        .unwrap();

        assert!(provider_resource.join("tools/server.mjs").is_file());
        assert_eq!(
            std::fs::read_to_string(provider_resource.join("schema.json")).unwrap(),
            "package asset\n"
        );
        assert!(
            !provider_resource.join("project").exists(),
            "session-host projection must not copy workspace data from a stale package unit"
        );

        let hidden = owned.path().join("source-hidden");
        std::fs::rename(&user_root, &hidden).unwrap();
        let output = std::process::Command::new("node")
            .arg(provider_resource.join("tools/server.mjs"))
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .output();
        std::fs::rename(&hidden, &user_root).unwrap();
        let output = output.unwrap();
        assert!(output.status.success(), "{output:?}");
        assert_eq!(output.stdout, b"session-host-linked-sibling-loaded\n");
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
        // The selected template is the prepared view; its containing resource
        // unit still supplies the original, unprepared config leaf.
        std::fs::write(unit.join("opencode.jsonc"), r#"{"rules":"raw-resource"}"#).unwrap();
        let selected_config = source.join(".freshell/selected-config.json");
        std::fs::write(&selected_config, r#"{"rules":"prepared-initial"}"#).unwrap();
        std::fs::write(destination.join("native-owned-sibling"), "preserved").unwrap();
        let inode = std::fs::metadata(&destination).unwrap().ino();
        let alias = home.join(".config/opencode");
        std::fs::create_dir_all(&alias).unwrap();
        std::fs::write(alias.join("provider-state"), "native-alias-state").unwrap();
        let alias_inode = std::fs::metadata(&alias).unwrap().ino();
        // The native alias is a separate volume-subpath mount. A prior logical
        // manifest must not authorize publication or stale removal through it.
        write_projection_manifest(
            &home,
            &std::collections::BTreeSet::from([
                ".config/opencode".into(),
                ".config/opencode/provider-state".into(),
            ]),
        )
        .unwrap();
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
                    logical_destination: "/home/freshell/provider/.config/opencode".into(),
                    effective_destination: "/home/freshell/provider/.config/opencode".into(),
                    kind: ProviderResourceKind::Directory,
                    writable: false,
                    reference_aliases: vec![],
                    retired_reference_aliases: vec![],
                }],
                indexed_files: None,
            }),
            mcp_capability: Some(capability),
            config: vec![
                ProviderConfigReference {
                    root: ProviderConfigRoot::UserProvider,
                    relative_path: ".freshell/resource-units/root-0".into(),
                    provider_relative_path: ".config/opencode".into(),
                    format: "directory".into(),
                },
                ProviderConfigReference {
                    root: ProviderConfigRoot::UserProvider,
                    relative_path: ".freshell/selected-config.json".into(),
                    provider_relative_path: ".config/opencode/opencode.jsonc".into(),
                    format: "jsonc".into(),
                },
            ],
            preparation: ProviderPreparation::Opencode {
                project_config: vec![],
                tui_config: None,
                tui_source: None,
                inline_config: false,
            },
        };
        let uid = unsafe { libc::geteuid() };
        let gid = unsafe { libc::getegid() };
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
        let config = destination.join("opencode.jsonc");
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&std::fs::read(&config).unwrap()).unwrap()
                ["rules"],
            "prepared-initial"
        );
        // Initial publication writes its current manifest. Restore the legacy
        // alias entries so refresh still exercises their lack of authority over
        // the separately mounted native alias and its provider-created state.
        let mut legacy = read_projection_manifest(&home).unwrap();
        legacy.extend([
            ".config/opencode".to_string(),
            ".config/opencode/provider-state".to_string(),
        ]);
        write_projection_manifest(&home, &legacy).unwrap();
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
        std::fs::write(&selected_config, r#"{"rules":"prepared-refreshed"}"#).unwrap();
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
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&std::fs::read(&config).unwrap()).unwrap()
                ["rules"],
            "prepared-refreshed"
        );
        assert_eq!(std::fs::metadata(&destination).unwrap().ino(), inode);
        assert_eq!(std::fs::metadata(&alias).unwrap().ino(), alias_inode);
        assert_eq!(
            std::fs::read_to_string(alias.join("provider-state")).unwrap(),
            "native-alias-state"
        );
        assert!(!read_projection_manifest(&home)
            .unwrap()
            .iter()
            .any(|entry| Path::new(entry).starts_with(".config/opencode")));
        assert_eq!(
            std::fs::read_to_string(destination.join("native-owned-sibling")).unwrap(),
            "preserved"
        );
        // A valid resource unit cannot mask a missing independently selected
        // configuration reference, even when both map to the same physical root.
        let manifest = std::fs::read(home.join(PROVIDER_PROJECTION_MANIFEST)).unwrap();
        let mut missing = context.clone();
        missing.config[1].relative_path = ".freshell/missing-selected-config".into();
        assert!(refresh_provider_config_references(
            &missing,
            "opencode",
            owned.path(),
            &source,
            &home,
            uid,
            gid,
        )
        .is_err());
        assert_eq!(
            std::fs::read(home.join(PROVIDER_PROJECTION_MANIFEST)).unwrap(),
            manifest
        );
        assert_eq!(
            std::fs::read_to_string(destination.join("node_modules/dependency/index.js")).unwrap(),
            "dependency-refreshed"
        );
        assert_eq!(std::fs::metadata(&destination).unwrap().ino(), inode);
        assert_eq!(std::fs::metadata(&alias).unwrap().ino(), alias_inode);
        assert_eq!(
            std::fs::read_to_string(alias.join("provider-state")).unwrap(),
            "native-alias-state"
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
    fn provider_config_projection_metadata_writer_preserves_prior_on_oversize() {
        let home = tempfile::tempdir().unwrap();
        let accepted = ["skills/prior".to_owned()].into_iter().collect();
        let path = write_projection_manifest(home.path(), &accepted).unwrap();
        let before = std::fs::read(&path).unwrap();
        let oversized = ["x".repeat(64 * 1024 * 1024)].into_iter().collect();
        assert!(write_projection_manifest(home.path(), &oversized).is_err());
        assert_eq!(std::fs::read(path).unwrap(), before);
        assert_eq!(
            std::fs::read_dir(home.path()).unwrap().count(),
            1,
            "failed metadata publication must not leave a temporary file"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn provider_config_projection_metadata_writer_cleans_failed_publication() {
        const CHILD: &str = "FRESHELL_TEST_PROJECTION_WRITE_FAILURE_CHILD";
        const TEST: &str =
            "tests::provider_config_projection_metadata_writer_cleans_failed_publication";
        if std::env::var_os(CHILD).is_none() {
            let mut failed = Vec::new();
            for case in ["write", "rename"] {
                let output = std::process::Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", TEST, "--nocapture"])
                    .env(CHILD, case)
                    .output()
                    .unwrap();
                assert!(String::from_utf8_lossy(&output.stdout)
                    .contains("projection_write_failure_fixture_ready"));
                eprintln!(
                    "projection_write_failure_child_result {}",
                    serde_json::json!({
                        "case":case,
                        "success":output.status.success(),
                        "temporaryMetadataRemaining":String::from_utf8_lossy(&output.stderr)
                            .contains("left temporary metadata")
                    })
                );
                if !output.status.success() {
                    failed.push(case);
                }
            }
            assert!(failed.is_empty(), "projection metadata failure must preserve prior metadata and remove owned temporary files: {failed:?}");
            return;
        }
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        let accepted = ["skills/prior".to_owned()].into_iter().collect();
        let manifest = write_projection_manifest(home.path(), &accepted).unwrap();
        let before = std::fs::read(&manifest).unwrap();
        let incoming = [
            "skills/new-resource".to_owned(),
            "skills/next-resource".to_owned(),
        ]
        .into_iter()
        .collect();
        println!("projection_write_failure_fixture_ready");
        if std::env::var(CHILD).unwrap() == "write" {
            let mut previous = libc::rlimit {
                rlim_cur: 0,
                rlim_max: 0,
            };
            assert_eq!(
                unsafe { libc::getrlimit(libc::RLIMIT_FSIZE, &mut previous) },
                0
            );
            let restricted = libc::rlimit {
                rlim_cur: 16,
                rlim_max: previous.rlim_max,
            };
            let old_signal = unsafe { libc::signal(libc::SIGXFSZ, libc::SIG_IGN) };
            assert_eq!(
                unsafe { libc::setrlimit(libc::RLIMIT_FSIZE, &restricted) },
                0
            );
            let result = write_projection_manifest(home.path(), &incoming);
            assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_FSIZE, &previous) }, 0);
            unsafe {
                libc::signal(libc::SIGXFSZ, old_signal);
            }
            assert!(result.is_err());
            assert!(std::fs::read(&manifest).unwrap() == before);
            assert_eq!(
                std::fs::read_dir(home.path()).unwrap().count(),
                1,
                "failed publication left temporary metadata"
            );
        }

        // A rename failure must clean the fully written temporary too, without
        // replacing the occupied destination or its provider-owned contents.
        std::fs::remove_file(&manifest).unwrap();
        std::fs::create_dir(&manifest).unwrap();
        let sibling = manifest.join("provider-owned");
        std::fs::write(&sibling, b"owned-metadata-sibling-nonce").unwrap();
        assert!(write_projection_manifest(home.path(), &incoming).is_err());
        assert_eq!(
            std::fs::read_dir(home.path()).unwrap().count(),
            1,
            "failed rename left temporary metadata"
        );
        assert_eq!(
            std::fs::read(&sibling).unwrap(),
            b"owned-metadata-sibling-nonce"
        );
        std::fs::remove_file(sibling).unwrap();
        std::fs::remove_dir(&manifest).unwrap();
        write_projection_manifest(home.path(), &incoming).unwrap();
        assert_eq!(read_projection_manifest(home.path()).unwrap(), incoming);
        assert_eq!(
            std::fs::metadata(&manifest).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(std::fs::read_dir(home.path()).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn provider_config_projection_metadata_rejects_oversize_before_read_and_publication() {
        use crate::provider_input_preparation::{
            private_read_observation::Observation, read_private,
        };
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let stage = owned.path().join("stage");
        std::fs::create_dir_all(home.join("skills")).unwrap();
        std::fs::create_dir_all(stage.join("projection/skills")).unwrap();
        let fixtures = [
            (
                home.join(PROVIDER_PROJECTION_MANIFEST),
                br#"["skills","skills/old"]"#.as_slice(),
            ),
            (
                stage.join("projection").join(PROVIDER_PROJECTION_MANIFEST),
                br#"["skills","skills/new"]"#.as_slice(),
            ),
            (stage.join("manifest.json"), br#"["skills"]"#.as_slice()),
            (stage.join("private-mountpoints.json"), b"[]".as_slice()),
            (stage.join("resource-mountpoints.json"), b"[]".as_slice()),
            (stage.join("provider.json"), br#""claude""#.as_slice()),
        ];
        for (path, bytes) in &fixtures {
            std::fs::write(path, bytes).unwrap();
        }
        std::fs::write(home.join("skills/old"), b"prior-projection-nonce").unwrap();
        std::fs::write(home.join("skills/sibling"), b"native-sibling-nonce").unwrap();
        std::fs::write(
            stage.join("projection/skills/new"),
            b"current-projection-nonce",
        )
        .unwrap();
        for (path, original) in &fixtures {
            let reads = Observation::start(path);
            assert_eq!(
                read_private(
                    path.parent().unwrap(),
                    path.file_name().unwrap().to_str().unwrap(),
                    MAX_PROJECTION_METADATA_BYTES,
                )
                .unwrap(),
                *original
            );
            assert!(
                reads.calls() > 0,
                "fixture must observe actual payload reads"
            );
            drop(reads);
            let file = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(path)
                .unwrap();
            file.set_len(64 * 1024 * 1024 + 1).unwrap();
            drop(file);
            let reads = Observation::start(path);
            assert!(apply_staged_provider_config(&stage, &home).is_err());
            assert_eq!(
                reads.calls(),
                0,
                "oversized ordinary metadata payload was read: {}",
                path.display()
            );
            assert_eq!(
                std::fs::read(home.join("skills/old")).unwrap(),
                b"prior-projection-nonce"
            );
            assert_eq!(
                std::fs::read(home.join("skills/sibling")).unwrap(),
                b"native-sibling-nonce"
            );
            assert!(!home.join("skills/new").exists());
            std::fs::write(path, original).unwrap();
        }
        // The disk profile is 64 MiB, independently of the private control
        // frame. JSON whitespace remains an admitted ordinary metadata view.
        let resource_metadata = stage.join("resource-mountpoints.json");
        let mut padded = vec![b' '; 64 * 1024 * 1024];
        padded[..2].copy_from_slice(b"[]");
        std::fs::write(resource_metadata, &padded).unwrap();
        drop(padded);
        apply_staged_provider_config(&stage, &home).unwrap();
        assert!(!home.join("skills/old").exists());
        assert_eq!(
            std::fs::read(home.join("skills/new")).unwrap(),
            b"current-projection-nonce"
        );
        assert_eq!(
            std::fs::read(home.join("skills/sibling")).unwrap(),
            b"native-sibling-nonce"
        );
    }

    #[cfg(unix)]
    #[test]
    fn provider_config_resume_validates_private_input_parent_before_copy() {
        use freshell_runtime_protocol::{
            ProviderConfigReference, ProviderConfigRoot, ProviderLaunchContext, ProviderPreparation,
        };
        let root = tempfile::tempdir().unwrap();
        let real_private = root.path().join("real-private");
        let private = root.path().join("private");
        let home = root.path().join("home");
        std::fs::create_dir_all(real_private.join("user-provider")).unwrap();
        std::fs::create_dir(&home).unwrap();
        std::fs::write(
            real_private.join("user-provider/settings.json"),
            b"new-config",
        )
        .unwrap();
        std::fs::create_dir(home.join(".claude")).unwrap();
        std::fs::write(home.join(".claude/settings.json"), b"accepted-config").unwrap();
        std::os::unix::fs::symlink(&real_private, &private).unwrap();
        let context = ProviderLaunchContext {
            prepared_inputs: None,
            preparation: ProviderPreparation::Claude {
                mcp_args: Vec::new(),
            },
            mcp_capability: None,
            config: vec![ProviderConfigReference {
                root: ProviderConfigRoot::UserProvider,
                relative_path: "settings.json".into(),
                provider_relative_path: ".claude/settings.json".into(),
                format: "json".into(),
            }],
        };
        let error = refresh_provider_context(
            Some(&context),
            "claude",
            root.path().to_str().unwrap(),
            unsafe { libc::geteuid() },
            unsafe { libc::getegid() },
            &ProviderConfigPaths {
                private_mount: private,
                provider_home: home.clone(),
            },
        )
        .expect_err("resume must validate the same physical private parent as initial preparation");
        assert!(error.contains("trusted physical directory"));
        assert_eq!(
            std::fs::read(home.join(".claude/settings.json")).unwrap(),
            b"accepted-config"
        );
        assert_eq!(
            std::fs::read(real_private.join("user-provider/settings.json")).unwrap(),
            b"new-config"
        );
        assert!(std::fs::read_dir(&home).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".freshell-provider-refresh-")));
    }

    #[cfg(unix)]
    #[test]
    fn provider_config_workspace_filter_failure_emits_safe_jsonl() {
        use freshell_runtime_protocol::*;

        let owned = tempfile::tempdir().unwrap();
        let external = owned.path().join("external");
        let workspace = external.join("project");
        let user_root = owned.path().join("source");
        let unit = user_root.join(".freshell/resource-units/root-test");
        std::fs::create_dir_all(unit.join("project")).unwrap();
        std::os::unix::fs::symlink("missing-target", unit.join("dangling-resource")).unwrap();
        let capability = McpCapabilityReference {
            grant_id: format!("grant-{}", uuid::Uuid::new_v4()),
            endpoint: "http://host.docker.internal:1234".into(),
            provider_relative_path: ".freshell/mcp-capability.json".into(),
            host_gateway_address: None,
        };
        let context = ProviderLaunchContext {
            config: vec![],
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
                    stage_relative_path: ".freshell/resource-units/root-test".into(),
                    provider_relative_path: ".freshell/provider-roots/root-test".into(),
                    logical_destination: external.to_string_lossy().into_owned(),
                    effective_destination: external.to_string_lossy().into_owned(),
                    kind: ProviderResourceKind::Directory,
                    writable: false,
                    reference_aliases: vec![],
                    retired_reference_aliases: vec![],
                }],
            }),
            mcp_capability: Some(capability),
        };

        let error = copy_provider_config_references(
            &context,
            "opencode",
            &workspace,
            &user_root,
            &owned.path().join("provider-home"),
            unsafe { libc::geteuid() },
            unsafe { libc::getegid() },
        )
        .unwrap_err();
        assert!(
            error.contains("failed to exclude workspace from provider resource"),
            "{error}"
        );
    }

    #[test]
    fn provider_config_worker_timeout_removes_owned_stage_after_join() {
        use super::*;
        use std::time::{Duration, Instant};
        const STAGE_ENV: &str = "FRESHELL_TEST_PROVIDER_REFRESH_STAGE";
        if let Some(stage) = std::env::var_os(STAGE_ENV) {
            let stage = PathBuf::from(stage);
            std::fs::create_dir(&stage).unwrap();
            std::fs::write(stage.join("partial"), b"selected ordinary resource").unwrap();
            std::thread::sleep(Duration::from_secs(30));
            return;
        }
        let root = tempfile::tempdir().unwrap();
        let stage = root.path().join(format!(
            ".freshell-provider-refresh-{}",
            uuid::Uuid::new_v4()
        ));
        let retained = root.path().join("retained-state");
        std::fs::write(&retained, b"previous accepted projection").unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::provider_config_worker_timeout_removes_owned_stage_after_join",
            ])
            .env(STAGE_ENV, &stage)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let ready_deadline = Instant::now() + Duration::from_secs(2);
        while !stage.join("partial").is_file() {
            if Instant::now() >= ready_deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("owned worker did not create its transaction stage");
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let started = Instant::now();
        let error = wait_for_provider_config_refresh(
            &mut child,
            "claude",
            unsafe { libc::geteuid() },
            unsafe { libc::getegid() },
            Duration::from_millis(30),
            &stage,
        )
        .unwrap_err();
        assert!(error.contains("timed out"), "{error}");
        assert!(
            child.try_wait().unwrap().is_some(),
            "owned worker must be joined"
        );
        assert!(started.elapsed() < Duration::from_secs(6));
        assert_eq!(
            std::fs::read(retained).unwrap(),
            b"previous accepted projection"
        );
        assert!(
            !stage.exists(),
            "joined timed-out worker left an ordinary transaction stage"
        );
    }

    #[test]
    fn provider_config_worker_unconfirmed_termination_preserves_stage() {
        use super::*;
        use std::time::{Duration, Instant};
        let root = tempfile::tempdir().unwrap();
        let stage = root.path().join(format!(
            ".freshell-provider-refresh-{}",
            uuid::Uuid::new_v4()
        ));
        let retained = root.path().join("retained-state");
        std::fs::write(&retained, b"previous accepted projection").unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::provider_config_worker_timeout_removes_owned_stage_after_join",
            ])
            .env("FRESHELL_TEST_PROVIDER_REFRESH_STAGE", &stage)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let ready_deadline = Instant::now() + Duration::from_secs(2);
        while !stage.join("partial").is_file() {
            if Instant::now() >= ready_deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("owned worker did not create its transaction stage");
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let started = Instant::now();
        // The strict sandbox user cannot adopt this different UID. Exercise a
        // real failed signal operation, rather than mocking a joined worker.
        let outcome = wait_for_provider_config_refresh(
            &mut child,
            "claude",
            unsafe { libc::geteuid() } + 1,
            unsafe { libc::getegid() },
            Duration::from_millis(30),
            &stage,
        );
        let elapsed = started.elapsed();
        let worker_alive = child.try_wait().unwrap().is_none();
        let stage_retained = stage.join("partial").is_file();
        let accepted = std::fs::read(&retained).unwrap();
        // The test itself owns the exact child and can signal it as its actual
        // UID. Join before assertions even when the production outcome is wrong.
        if worker_alive {
            child.kill().unwrap();
        }
        child.wait().unwrap();
        let error = outcome.unwrap_err();
        assert!(error.contains("cleanup unavailable"), "{error}");
        assert!(worker_alive, "unconfirmed worker must remain observable");
        assert!(stage_retained, "unconfirmed worker inputs must be retained");
        assert_eq!(accepted, b"previous accepted projection");
        assert!(
            elapsed < Duration::from_secs(6),
            "uncertain cleanup must settle finitely"
        );
    }

    #[test]
    fn provider_config_worker_lost_wait_ownership_returns_incomplete_evidence() {
        use super::*;
        let root = tempfile::tempdir().unwrap();
        let stage = root.path().join(format!(
            ".freshell-provider-refresh-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&stage).unwrap();
        std::fs::write(stage.join("retained"), b"uncertain ordinary transaction").unwrap();
        let mut child = std::process::Command::new("/usr/bin/true").spawn().unwrap();
        let mut exit = 0;
        // Reap only the child this test created, through another real waiter.
        // The Child handle can no longer prove that its old PID is owned.
        assert_eq!(
            unsafe { libc::waitpid(child.id() as libc::pid_t, &mut exit, 0) },
            child.id() as libc::pid_t
        );
        let error = wait_for_provider_config_refresh(
            &mut child,
            "claude",
            unsafe { libc::geteuid() },
            unsafe { libc::getegid() },
            std::time::Duration::from_millis(30),
            &stage,
        )
        .unwrap_err();
        assert!(error.contains("completion unavailable"), "{error}");
        assert_eq!(
            std::fs::read(stage.join("retained")).unwrap(),
            b"uncertain ordinary transaction"
        );
    }

    #[tokio::test]
    async fn authenticated_fresh_agent_configure_rpc_persists_settings_through_the_host_actor() {
        let state = test_host_state();
        let transport = Arc::new(RpcFixtureTransport {
            native_evidence: std::sync::Mutex::new(None),
            dispatches: AtomicUsize::new(0),
            checkpoint_attempts: std::sync::Mutex::new(Vec::new()),
            decisions: AtomicUsize::new(0),
            operations: AtomicUsize::new(0),
            captures: AtomicUsize::new(0),
            stops: AtomicUsize::new(0),
        });
        let actor = freshell_agent_runtime::host_actor::FreshAgentHostActor::open(
            state.state_dir.join("rpc-configure-agent"),
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
        *state.fresh_agent.lock().await = Some(Arc::clone(&actor));
        let configure = || {
            authenticated_host_envelope(
                &state,
                HostCommand::FreshAgentConfigure {
                    incarnation_id: state.incarnation_id.clone(),
                    request_id: RequestId::parse("rpc-configure-one").unwrap(),
                    settings: freshell_runtime_protocol::FreshAgentTurnSettings {
                        cwd: None,
                        model: Some("opus".into()),
                        effort: Some("high".into()),
                        permission_mode: None,
                        sandbox: None,
                    },
                },
            )
        };

        for _ in 0..2 {
            let result = dispatch(configure(), &state).await.unwrap();
            assert!(matches!(
                result,
                HostResult::FreshAgentCommand {
                    state: freshell_runtime_protocol::CommandState::ProviderAcked,
                    native_session_id: Some(ref native),
                    ..
                } if native == "fixture-native-thread"
            ));
        }
        let profile = actor.profile().await;
        assert_eq!(profile.model.as_deref(), Some("opus"));
        assert_eq!(profile.effort.as_deref(), Some("high"));
        assert_eq!(profile.permission_mode.as_deref(), Some("ask"));
        assert_eq!(
            transport.operations.load(Ordering::SeqCst),
            1,
            "a retried configure request is applied once"
        );
        assert_eq!(transport.dispatches.load(Ordering::SeqCst), 0);
    }

    /// Re-runs one test of this binary in a fresh process (which, like the
    /// production host, installs no tracing subscriber) and returns the
    /// JSONL events it wrote to stderr. Lines that are not JSON (a provider
    /// child's own stderr) are skipped.
    fn spawned_test_events(test: &str) -> Vec<serde_json::Value> {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", test, "--nocapture"])
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        String::from_utf8_lossy(&output.stderr)
            .lines()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .collect()
    }

    #[test]
    fn hosted_configure_outcomes_are_logged_as_jsonl_with_severity() {
        let applied = spawned_test_events(
            "tests::authenticated_fresh_agent_configure_rpc_persists_settings_through_the_host_actor",
        );
        let event = applied
            .iter()
            .find(|event| event["event"] == "fresh_agent.configure.applied")
            .unwrap_or_else(|| panic!("an applied configure is logged: {applied:?}"));
        assert_eq!(event["severity"], "info");
        assert_eq!(event["stage"], "session_host");
        assert_eq!(event["request_id"], "rpc-configure-one");

        let refused = spawned_test_events(
            "providers::fresh_agent::tests::hosted_claude_configure_refused_live_keeps_the_intent_and_journals_the_refusal",
        );
        let event = refused
            .iter()
            .find(|event| event["event"] == "fresh_agent.configure.provider_refused")
            .unwrap_or_else(|| panic!("a refused live apply is logged: {refused:?}"));
        assert_eq!(event["severity"], "warn");
        assert_eq!(event["provider"], "claude");
        assert_eq!(event["request_id"], "hosted-configure-1");
        assert_eq!(event["code"], "CLAUDE_SETTINGS_FAILED");
        assert!(
            refused
                .iter()
                .all(|event| event["event"] != "fresh_agent.configure.applied"),
            "a refused live apply is never logged as applied: {refused:?}"
        );
    }

    #[test]
    fn hosted_configure_outcome_events_name_what_happened_to_the_settings() {
        use freshell_runtime_protocol::CommandState;
        let request_id = RequestId::parse("configure-log").unwrap();
        for (outcome, severity, event) in [
            (
                Ok(CommandState::ProviderAcked),
                "info",
                "fresh_agent.configure.applied",
            ),
            (
                Ok(CommandState::Completed),
                "info",
                "fresh_agent.configure.staged",
            ),
            (
                Ok(CommandState::Cancelled),
                "warn",
                "fresh_agent.configure.live_apply_refused",
            ),
            (
                Err(RuntimeError::new(
                    RuntimeErrorCode::InvalidRequest,
                    "hosted fresh-agent command failed",
                )),
                "warn",
                "fresh_agent.configure.failed",
            ),
        ] {
            let logged = configure_outcome_event(&request_id, &outcome);
            assert_eq!(logged["severity"], severity, "{outcome:?}");
            assert_eq!(logged["event"], event, "{outcome:?}");
            assert_eq!(logged["stage"], "session_host");
            assert_eq!(logged["request_id"], "configure-log");
        }
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
                native_identity_launch: None,

                soul_id: SoulId::new(),
                control_epoch: 1,
                execution_generation: 1,
                grant_id: GrantId::new(),
                fixture: None,
                provider_path_inputs: Default::default(),
                terminal: Some(terminal),
                fresh_agent: None,
                resume_spec: None,
                dispatch_budget: None,
            },
            &SystemGrantExecutionEffects,
        )
        .await;
        assert!(result.is_err());
        let persisted = state.persisted.lock().await;
        assert!(persisted.grant_id.is_none(),"source preflight failure must leave the grant unconsumed and safe to reprepare before dispatch");
        assert_eq!(persisted.worker_launch_count, 0);
    }

    #[tokio::test]
    async fn provider_secret_projection_failure_keeps_grant_retryable_and_prior_inputs() {
        for route in ["terminal", "fresh"] {
            let owned = tempfile::tempdir().unwrap();
            let home = owned.path().join("provider-home");
            std::fs::create_dir_all(home.join(".config/opencode")).unwrap();
            let prior = home.join(".config/opencode/opencode.json");
            std::fs::write(&prior, b"prior-accepted-source").unwrap();
            let context = freshell_runtime_protocol::ProviderLaunchContext {
                preparation: freshell_runtime_protocol::ProviderPreparation::Opencode {
                    project_config: vec![freshell_runtime_protocol::ProviderConfigReference {
                        root: freshell_runtime_protocol::ProviderConfigRoot::Workspace,
                        relative_path: "opencode.json".into(),
                        provider_relative_path: ".config/opencode/opencode.json".into(),
                        format: "json".into(),
                    }],
                    tui_config: None,
                    tui_source: None,
                    inline_config: false,
                },
                prepared_inputs: None,
                mcp_capability: None,
                config: Vec::new(),
            };
            context.validate("opencode").unwrap();
            let mut state = test_host_state();
            Arc::get_mut(&mut state).unwrap().provider_config_paths = ProviderConfigPaths {
                private_mount: owned.path().join("private"),
                provider_home: home,
            };
            let cwd = owned.path().to_str().unwrap();
            let uid = unsafe { libc::geteuid() };
            let gid = unsafe { libc::getegid() };
            let session_type = if route == "terminal" {
                "opencode"
            } else {
                "freshopencode"
            };
            let runtime_variant = if route == "terminal" {
                "managed_terminal_pty"
            } else {
                "opencode"
            };
            let resume: ResumeSpec = serde_json::from_value(serde_json::json!({
                "providerSession":{"provider":"opencode","providerStoreId":"synthetic-store","nativeSessionId":"ses_projection_retry"},
                "mode":session_type,"runtimeVariant":runtime_variant,"program":"/usr/bin/true","resumeArgv":[],
                "providerHome":"/home/freshell/provider","cwd":cwd,"workspacePath":cwd,
                "identityProvenance":"provider_observed","durablePosition":{},"creationSeedRef":"synthetic-seed",
                "checkpointRevision":0,"allocationState":"verified_durable","evidenceRevision":1,"neverDispatched":false,
            })).unwrap();
            let terminal = (route == "terminal").then(|| serde_json::from_value(serde_json::json!({
                "terminalId":"synthetic-projection","streamId":"synthetic-stream","mode":"opencode","program":"/usr/bin/true","args":[],"env":{},
                "cwd":cwd,"workspacePath":cwd,"runAsUid":uid,"runAsGid":gid,"cols":80,"rows":24,"projectKey":"synthetic",
                "providerLaunchContext":context,
            })).unwrap());
            let fresh = (route == "fresh").then(|| serde_json::from_value(serde_json::json!({
                "sessionId":"synthetic-projection","provider":"opencode","sessionType":session_type,"runtimeVariant":runtime_variant,
                "providerStoreId":"synthetic-store","cwd":cwd,"workspacePath":cwd,"runAsUid":uid,"runAsGid":gid,
                "providerLaunchContext":context,
            })).unwrap());
            let grant = GrantId::new();
            for attempt in 0..2 {
                let error = grant_execution(
                    &state,
                    GrantExecutionRequest {
                        native_identity_launch: None,

                        soul_id: SoulId::new(),
                        control_epoch: 1,
                        execution_generation: 1,
                        grant_id: grant.clone(),
                        fixture: None,
                        provider_path_inputs: Default::default(),
                        terminal: terminal.clone(),
                        fresh_agent: fresh.clone(),
                        resume_spec: Some(resume.clone()),
                        dispatch_budget: None,
                    },
                    &SystemGrantExecutionEffects,
                )
                .await
                .unwrap_err();
                assert_eq!(
                    error.code,
                    RuntimeErrorCode::HostUnreachable,
                    "{route}/{attempt}: retry must reach the source preparation failure"
                );
                assert!(
                    error.message.starts_with(
                        "capability_pending: provider configuration publication failed:"
                    ),
                    "{route}: actual common-copy failure: {}",
                    error.message
                );
                let persisted = state.persisted.lock().await;
                assert!(
                    persisted.grant_id.is_none(),
                    "{route}: failed projection cannot consume the execution grant"
                );
                assert_eq!(persisted.worker_launch_count, 0);
                assert!(persisted.worker_pid.is_none());
                assert_eq!(std::fs::read(&prior).unwrap(), b"prior-accepted-source");
            }
            assert!(state.pty.lock().await.is_none());
            assert!(state.fresh_agent.lock().await.is_none());
        }
    }

    #[tokio::test]
    async fn provider_secret_spawn_attempt_remains_consumed_after_launch_failure() {
        for provider in ["opencode", "codex"] {
            let owned = tempfile::tempdir().unwrap();
            let cwd = owned.path().to_str().unwrap();
            let program = owned.path().join("missing-owned-launcher");
            let terminal: TerminalLaunchSpec = serde_json::from_value(serde_json::json!({
            "terminalId":"synthetic-spawn","streamId":"synthetic-stream","mode":provider,
            "program":program,"args":[],"env":{"FRESHELL_OPENCODE_REBIND":"0"},"cwd":cwd,"workspacePath":cwd,
            "runAsUid":unsafe { libc::geteuid() },"runAsGid":unsafe { libc::getegid() },
            "cols":80,"rows":24,"projectKey":"synthetic",
        }))
        .unwrap();
            let resume: ResumeSpec = serde_json::from_value(serde_json::json!({
            "providerSession":{"provider":provider,"providerStoreId":"synthetic-store","nativeSessionId":"ses_synthetic_spawn"},
            "mode":provider,"runtimeVariant":"managed_terminal_pty","program":program,"resumeArgv":[],
            "environment":{"FRESHELL_OPENCODE_REBIND":"0"},
            "providerHome":"/home/freshell/provider","cwd":cwd,"workspacePath":cwd,
            "identityProvenance":"provider_observed","durablePosition":{},"creationSeedRef":"synthetic-seed",
            "checkpointRevision":0,"allocationState":"verified_durable","evidenceRevision":1,"neverDispatched":false,
        })).unwrap();
            let state = test_host_state();
            let grant = GrantId::new();
            for (attempt, expected) in [
                RuntimeErrorCode::HostUnreachable,
                RuntimeErrorCode::StaleExecutionGrant,
            ]
            .into_iter()
            .enumerate()
            {
                let error = grant_execution(
                    &state,
                    GrantExecutionRequest {
                        native_identity_launch: None,

                        soul_id: SoulId::new(),
                        control_epoch: 1,
                        execution_generation: 1,
                        grant_id: grant.clone(),
                        fixture: None,
                        provider_path_inputs: Default::default(),
                        terminal: Some(terminal.clone()),
                        fresh_agent: None,
                        resume_spec: Some(resume.clone()),
                        dispatch_budget: None,
                    },
                    &SystemGrantExecutionEffects,
                )
                .await
                .unwrap_err();
                assert_eq!(
                    error.code, expected,
                    "{provider}/{attempt}: failed native dispatch remains fenced"
                );
                let persisted = state.persisted.lock().await;
                assert_eq!(persisted.grant_id.as_ref(), Some(&grant));
                assert_eq!(persisted.worker_launch_count, 0);
                assert!(persisted.worker_pid.is_none());
            }
            assert!(state.pty.lock().await.is_none());
        }
    }

    fn grant_timing_events(state_dir: &Path) -> Vec<serde_json::Value> {
        journal_events(state_dir)
            .into_iter()
            .filter(|event| event["event"] == "host.grant_timing")
            .map(|event| event["data"].clone())
            .collect()
    }

    /// A refused grant still records how long the host held it and why, so a
    /// supervisor-side timeout can be told apart from a host-side refusal.
    #[tokio::test]
    async fn refused_grant_records_its_timing_and_refusal_code() {
        let state = test_host_state();
        {
            let mut persisted = state.persisted.lock().await;
            persisted.max_control_epoch = 7;
        }
        let grant_id = GrantId::new();
        let envelope = authenticated_host_envelope(
            &state,
            HostCommand::GrantExecution {
                incarnation_id: state.incarnation_id.clone(),
                soul_id: SoulId::new(),
                host_boot_id: state.host_boot_id.clone(),
                control_epoch: 1,
                execution_generation: 1,
                grant_id: grant_id.clone(),
                fixture: Some(FixtureKind::Heartbeat),
                provider_path_inputs: Default::default(),
                terminal: None,
                fresh_agent: None,
                resume_spec: None,
                dispatch_budget_ms: None,
                native_identity_launch: None,
            },
        );
        let error = dispatch(envelope, &state).await.unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::StaleExecutionGrant);
        let timing = grant_timing_events(&state.state_dir);
        assert_eq!(timing.len(), 1, "{timing:?}");
        assert_eq!(timing[0]["grantId"], serde_json::json!(grant_id));
        assert_eq!(timing[0]["outcome"], "refused");
        assert_eq!(timing[0]["severity"], "warn");
        assert_eq!(timing[0]["errorCode"], "STALE_EXECUTION_GRANT");
        assert_eq!(timing[0]["stages"], serde_json::json!([]));
    }

    /// The supervisor stops waiting shortly after the dispatch budget it sent.
    /// A host whose budget is already spent must not cross the native dispatch
    /// boundary: it refuses typed, names where the budget ran out, and leaves
    /// the grant unconsumed and no worker behind.
    #[tokio::test]
    async fn grant_whose_dispatch_budget_is_spent_is_refused_before_consumption() {
        let state = test_host_state();
        let grant_id = GrantId::new();
        let envelope = authenticated_host_envelope(
            &state,
            HostCommand::GrantExecution {
                incarnation_id: state.incarnation_id.clone(),
                soul_id: SoulId::new(),
                host_boot_id: state.host_boot_id.clone(),
                control_epoch: 1,
                execution_generation: 1,
                grant_id: grant_id.clone(),
                fixture: Some(FixtureKind::Heartbeat),
                provider_path_inputs: Default::default(),
                terminal: None,
                fresh_agent: None,
                resume_spec: None,
                dispatch_budget_ms: Some(0),
                native_identity_launch: None,
            },
        );

        let error = dispatch(envelope, &state).await.unwrap_err();

        assert_eq!(error.code, RuntimeErrorCode::HostUnreachable);
        assert!(
            error.message.contains("0ms dispatch budget")
                && error.message.contains("consume_grant"),
            "{}",
            error.message
        );
        let persisted = state.persisted.lock().await.clone();
        assert!(persisted.grant_id.is_none(), "the grant stays replayable");
        assert_eq!(persisted.worker_launch_count, 0);
        assert!(state.child.lock().await.is_none());
        let timing = grant_timing_events(&state.state_dir);
        assert_eq!(timing.len(), 1, "{timing:?}");
        assert_eq!(timing[0]["grantId"], serde_json::json!(grant_id));
        assert_eq!(timing[0]["outcome"], "refused");
        assert_eq!(timing[0]["errorCode"], "HOST_UNREACHABLE");
        assert_eq!(timing[0]["budgetMs"], 0);
        assert_eq!(timing[0]["budgetExhaustedBefore"], "consume_grant");
    }

    /// An awaited stage (a provider start that keeps retrying, a source
    /// reader) is cut at the dispatch deadline rather than allowed to run past
    /// the supervisor's wait, and the refusal names that stage.
    #[tokio::test]
    async fn awaited_stage_is_cut_at_the_dispatch_deadline() {
        let mut timeline = GrantStageTimeline::start(Some(Duration::from_millis(300)));
        timeline
            .run("prepare_terminal", async { Ok(()) })
            .await
            .expect("a stage inside the budget completes");
        let started = std::time::Instant::now();

        let error = timeline
            .run("start_sidecar", async {
                sleep(Duration::from_secs(30)).await;
                Ok(())
            })
            .await
            .unwrap_err();

        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the stage was cut at the deadline, not allowed to finish"
        );
        assert_eq!(error.code, RuntimeErrorCode::HostUnreachable);
        assert!(
            error.message.contains("300ms dispatch budget")
                && error.message.contains("start_sidecar"),
            "{}",
            error.message
        );
        let event = timeline.event(&GrantId::new(), Err(&error));
        assert_eq!(event["budgetMs"], 300);
        assert_eq!(event["budgetExhaustedBefore"], "start_sidecar");
        let stages = event["stages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|stage| stage["stage"].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        assert_eq!(stages, ["prepare_terminal"], "a cut stage is not completed");
    }

    static OPERATOR_MARKER_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct ScopedMarkerEnv(Vec<(&'static str, Option<std::ffi::OsString>)>);

    impl Drop for ScopedMarkerEnv {
        fn drop(&mut self) {
            for (key, value) in &self.0 {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

    fn scoped_marker_env(keys: &[&'static str]) -> ScopedMarkerEnv {
        ScopedMarkerEnv(
            keys.iter()
                .map(|key| (*key, std::env::var_os(key)))
                .collect(),
        )
    }

    fn journal_events(state_dir: &Path) -> Vec<serde_json::Value> {
        let bytes = std::fs::read(state_dir.join("host-lifecycle.jsonl")).unwrap_or_default();
        bytes
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).unwrap())
            .collect()
    }

    fn readiness_events(state_dir: &Path) -> Vec<serde_json::Value> {
        journal_events(state_dir)
            .into_iter()
            .filter(|event| event["event"] == "operator_home_readiness")
            .map(|event| event["data"].clone())
            .collect()
    }

    #[test]
    fn child_can_traverse_evaluates_dac_classes() {
        // All metadata is the IN-CONTAINER view. Under the rootless daemon an
        // operator-owned file (host uid/gid 1000) appears as container 0:0, and
        // the child's gid 0 then matches the file's group.
        assert!(child_can_traverse(0o700, 1000, 1000, 1000, 0)); // owner-x, child is owner
        assert!(child_can_traverse(0o750, 0, 0, 65_534, 0)); // group-x, gid match: the rootless production shape
        assert!(!child_can_traverse(0o750, 1000, 1000, 65_534, 0)); // group-x but gid mismatch: the rootful shape
        assert!(!child_can_traverse(0o700, 0, 0, 65_534, 0)); // the incident's failure surface
        assert!(!child_can_traverse(0o701, 0, 0, 65_534, 0)); // first-match: group with no x cannot fall through to other-x
        assert!(child_can_traverse(0o701, 1000, 1000, 65_534, 65_534)); // other-x applies when neither uid nor gid matches
    }

    #[cfg(unix)]
    #[test]
    fn readiness_event_reflects_real_home_metadata_and_survives_stat_failure() {
        let _lock = OPERATOR_MARKER_ENV_LOCK.lock().unwrap();
        let _env = scoped_marker_env(&["FRESHELL_OPERATOR_HOME", "FRESHELL_OPERATOR_HOME_MOUNT"]);

        // Case A: with the home mounted, mode 0750, owned by the test uid,
        // and the provider child identity 65534:0, the startup emission
        // produces exactly one operator_home_readiness event whose fields
        // match the stat and whose home_root_traversable_by_child equals
        // child_can_traverse applied to that stat.
        let state_dir = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(home.path(), std::fs::Permissions::from_mode(0o750)).unwrap();
        }
        let home_path = home.path().to_string_lossy().into_owned();
        std::env::set_var("FRESHELL_OPERATOR_HOME", home.path());
        std::env::set_var("FRESHELL_OPERATOR_HOME_MOUNT", "1");
        emit_operator_home_readiness(state_dir.path(), b"test-secret-material", 65_534, 0);
        let events = readiness_events(state_dir.path());
        assert_eq!(events.len(), 1, "case A: {events:?}");
        let data = &events[0];
        assert_eq!(data["path"], home_path);
        assert_eq!(data["present"], true);
        assert_eq!(data["mode"], "0750");
        {
            use std::os::unix::fs::MetadataExt;
            let metadata = std::fs::metadata(home.path()).unwrap();
            assert_eq!(data["uid"], u64::from(metadata.uid()));
            assert_eq!(data["gid"], u64::from(metadata.gid()));
            assert_eq!(
                data["home_root_traversable_by_child"],
                child_can_traverse(
                    metadata.mode() & 0o7777,
                    metadata.uid(),
                    metadata.gid(),
                    65_534,
                    0
                )
            );
        }
        let mut field_names: Vec<String> = data.as_object().unwrap().keys().cloned().collect();
        field_names.sort_unstable();
        assert_eq!(
            field_names,
            [
                "gid",
                "home_root_traversable_by_child",
                "mode",
                "path",
                "present",
                "uid"
            ]
        );

        // Case B: with FRESHELL_OPERATOR_HOME pointing at a path that does
        // not exist, the emission must produce one event with present:false
        // and startup must continue.
        let state_dir = tempfile::tempdir().unwrap();
        let missing = state_dir.path().join("no-such-operator-home");
        let missing_path = missing.to_string_lossy().into_owned();
        std::env::set_var("FRESHELL_OPERATOR_HOME", &missing);
        emit_operator_home_readiness(state_dir.path(), b"test-secret-material", 65_534, 0);
        let events = readiness_events(state_dir.path());
        assert_eq!(events.len(), 1, "case B: {events:?}");
        assert_eq!(events[0]["present"], false);
        assert_eq!(events[0]["path"], missing_path);
    }

    #[test]
    fn readiness_emission_requires_both_marker_env_vars() {
        let _lock = OPERATOR_MARKER_ENV_LOCK.lock().unwrap();
        let _env = scoped_marker_env(&["FRESHELL_OPERATOR_HOME", "FRESHELL_OPERATOR_HOME_MOUNT"]);
        let state_dir = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();

        std::env::set_var("FRESHELL_OPERATOR_HOME", home.path());
        std::env::remove_var("FRESHELL_OPERATOR_HOME_MOUNT");
        emit_operator_home_readiness(state_dir.path(), b"test-secret-material", 65_534, 0);
        assert!(readiness_events(state_dir.path()).is_empty());

        std::env::set_var("FRESHELL_OPERATOR_HOME_MOUNT", "1");
        std::env::remove_var("FRESHELL_OPERATOR_HOME");
        emit_operator_home_readiness(state_dir.path(), b"test-secret-material", 65_534, 0);
        assert!(readiness_events(state_dir.path()).is_empty());
    }

    #[test]
    fn provider_run_as_identity_defaults_when_env_absent() {
        let _lock = OPERATOR_MARKER_ENV_LOCK.lock().unwrap();
        let _env = scoped_marker_env(&[
            "FRESHELL_PROVIDER_RUN_AS_UID",
            "FRESHELL_PROVIDER_RUN_AS_GID",
        ]);
        std::env::remove_var("FRESHELL_PROVIDER_RUN_AS_UID");
        std::env::remove_var("FRESHELL_PROVIDER_RUN_AS_GID");
        assert_eq!(provider_run_as_identity(), (65_534, 0));
    }

    #[test]
    fn provider_run_as_identity_parses_set_env_values() {
        // Set-and-parseable vars produce the parsed child identity (the
        // identity startup feeds the operator_home_readiness event); a value
        // that does not parse keeps the per-field default.
        let identity = provider_run_as_identity_from(|key| match key {
            "FRESHELL_PROVIDER_RUN_AS_UID" => Some("1500".to_string()),
            "FRESHELL_PROVIDER_RUN_AS_GID" => Some("2500".to_string()),
            _ => None,
        });
        assert_eq!(identity, (1500, 2500));
        let partial = provider_run_as_identity_from(|key| match key {
            "FRESHELL_PROVIDER_RUN_AS_UID" => Some("not-a-uid".to_string()),
            _ => None,
        });
        assert_eq!(partial, (65_534, 0));
    }
}

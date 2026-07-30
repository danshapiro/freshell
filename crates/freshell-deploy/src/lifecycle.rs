use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::deployment::GenerationDescriptor;
use crate::durable::atomic_write;
use crate::error::{DeployError, Result};
use crate::journal::{ControlPaths, LaunchClaim, LaunchLane};
use crate::launch_receipt::{LaunchAttemptReceipt, LaunchAttemptReceiptStore};
use crate::legacy::NodePrerequisite;
use crate::paths::DeployPort;
use crate::probe::{DeploymentReadyReceipt, ProbeBackend, ProbeCommand, RealProbeBackend};
use crate::process_control::{LinuxPidfdBackend, StopPolicy, VerifiedProcess};
use crate::process_identity::{
    ExpectedListenerObservation, FileIdentity, LinuxProcfs, ProcessIdentity, RuntimeProvenance,
};
use crate::receipts::LiveReceipt;
use crate::store::{LockedStore, Store};

const LIFECYCLE_TIMEOUT: Duration = Duration::from_secs(20);

enum ExpectedProcessObservation {
    PortFree,
    Expected(Box<ProcessIdentity>),
    Foreign,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LifecycleLaunchRecord {
    schema_version: String,
    operation_id: String,
    port: DeployPort,
    generation_id: String,
    generation_root: PathBuf,
    server_executable: FileIdentity,
    controller_executable: PathBuf,
    runtime: RuntimeProvenance,
    node: NodePrerequisite,
    nonce: String,
    claim_file: PathBuf,
    ready_file: PathBuf,
    complete: bool,
}

impl LifecycleLaunchRecord {
    fn new(store: &Store) -> Result<Self> {
        let generation_id = store
            .selected_generation_id()?
            .ok_or_else(|| DeployError::Activation("current generation is missing".to_string()))?;
        let generation = store.verify_generation(&generation_id)?;
        let descriptor = GenerationDescriptor::read(&generation)?;
        let operation_id = Uuid::new_v4().to_string();
        let controls =
            ControlPaths::create_private(store.paths(), &format!("lifecycle-{operation_id}"))?;
        let mut runtime = descriptor.runtime_provenance(&generation.path);
        runtime.client_dir = store
            .paths()
            .current_pointer()
            .join("client")
            .display()
            .to_string();
        let record = Self {
            schema_version: "1".to_string(),
            operation_id,
            port: store.paths().port(),
            generation_id,
            generation_root: generation.path.clone(),
            server_executable: FileIdentity::from_path(
                &descriptor.server_executable(&generation.path),
            )?,
            controller_executable: descriptor.controller(&generation.path),
            runtime,
            node: descriptor.node,
            nonce: Uuid::new_v4().to_string(),
            claim_file: controls.directory.join("launch.json"),
            ready_file: controls.ready_file,
            complete: false,
        };
        record.validate(store)?;
        Ok(record)
    }

    fn validate(&self, store: &Store) -> Result<()> {
        if self.schema_version != "1"
            || self.operation_id.is_empty()
            || self.operation_id.contains('/')
            || self.nonce.is_empty()
            || self.port != store.paths().port()
        {
            return Err(DeployError::Journal(
                "lifecycle launch record identity is invalid".to_string(),
            ));
        }
        let generation = store.verify_generation(&self.generation_id)?;
        let descriptor = GenerationDescriptor::read(&generation)?;
        let controls = store
            .paths()
            .transactions_dir()
            .join(format!("lifecycle-{}", self.operation_id));
        let mut expected_runtime = descriptor.runtime_provenance(&generation.path);
        expected_runtime.client_dir = store
            .paths()
            .current_pointer()
            .join("client")
            .display()
            .to_string();
        if self.generation_root != generation.path
            || self.controller_executable != descriptor.controller(&generation.path)
            || self.server_executable
                != FileIdentity::from_path(&descriptor.server_executable(&generation.path))?
            || self.runtime != expected_runtime
            || self.node != descriptor.node
            || self.claim_file != controls.join("launch.json")
            || self.ready_file != controls.join("ready.json")
        {
            return Err(DeployError::Journal(
                "lifecycle launch record escaped the exact selected generation".to_string(),
            ));
        }
        Ok(())
    }

    fn to_json(&self) -> Result<Vec<u8>> {
        let mut bytes =
            serde_json::to_vec(self).map_err(|error| DeployError::Journal(error.to_string()))?;
        bytes.push(b'\n');
        Ok(bytes)
    }
}

pub(crate) fn execute_start_current(
    checkout: &Path,
    port: DeployPort,
    restart: bool,
) -> Result<()> {
    let store = Store::open(checkout, port)?;
    let auth_token = crate::controller::load_auth_token(checkout)?;
    let locked = store.lock()?;
    crate::controller::recover_unfinished_locked(&store, &locked, &auth_token)?;
    recover_or_start(&store, &locked, &auth_token, restart)
}

pub(crate) fn execute_stop_current(checkout: &Path, port: DeployPort) -> Result<()> {
    let store = Store::open(checkout, port)?;
    let auth_token = crate::controller::load_auth_token(checkout)?;
    let locked = store.lock()?;
    crate::controller::recover_unfinished_locked(&store, &locked, &auth_token)?;
    require_no_pending_lifecycle(&store)?;
    let selected = store
        .selected_generation_id()?
        .ok_or_else(|| DeployError::Activation("current generation is missing".to_string()))?;
    // A stored controller exists only in a managed generation. Reading the
    // descriptor also prevents a descriptor-less legacy receipt from being
    // converted into an unverifiable stopped state.
    GenerationDescriptor::read(&store.verify_generation(&selected)?)?;
    let live = store.read_live()?.ok_or_else(|| {
        DeployError::Activation("authoritative live receipt is missing".to_string())
    })?;
    if live.selected_generation_id != selected {
        return Err(DeployError::Activation(
            "live receipt disagrees with current generation".to_string(),
        ));
    }
    let Some(expected) = live.process_identity.as_ref() else {
        return Ok(());
    };
    stop_receipt_process(expected)?;
    locked.write_live(&LiveReceipt::new(selected, None, false, None))
}

pub(crate) fn recover_pending(checkout: &Path, port: DeployPort) -> Result<()> {
    let store = Store::open(checkout, port)?;
    let path = lifecycle_path(&store);
    let Some(record) = read_record(&store, &path)? else {
        return Ok(());
    };
    if record.complete {
        return Ok(());
    }
    let auth_token = crate::controller::load_auth_token(checkout)?;
    let locked = store.lock()?;
    recover_launch(&store, &locked, &auth_token, record)
}

fn recover_or_start(
    store: &Store,
    locked: &LockedStore<'_>,
    auth_token: &str,
    restart: bool,
) -> Result<()> {
    let path = lifecycle_path(store);
    if let Some(record) = read_record(store, &path)? {
        if !record.complete {
            recover_launch(store, locked, auth_token, record)?;
        }
    }
    let selected = store
        .selected_generation_id()?
        .ok_or_else(|| DeployError::Activation("current generation is missing".to_string()))?;
    let generation = store.verify_generation(&selected)?;
    let descriptor = GenerationDescriptor::read(&generation)?;
    verify_node_prerequisite(&descriptor.node, &generation.path)?;
    let live = store.read_live()?.ok_or_else(|| {
        DeployError::Activation("authoritative live receipt is missing".to_string())
    })?;
    if live.selected_generation_id != selected {
        return Err(DeployError::Activation(
            "live receipt disagrees with current generation".to_string(),
        ));
    }
    if let Some(expected) = live.process_identity.as_ref() {
        match observe_recorded_process(expected)? {
            ExpectedProcessObservation::Expected(actual) if *actual == *expected => {
                require_ordinary(store.paths().port())?;
                if !restart {
                    return Ok(());
                }
                stop_receipt_process(expected)?;
            }
            ExpectedProcessObservation::PortFree
                if !LinuxProcfs::default().process_birth_is_alive(expected)? => {}
            ExpectedProcessObservation::Expected(_) | ExpectedProcessObservation::Foreign => {
                return Err(DeployError::Activation(
                    "live listener is not the receipt-proven running process".to_string(),
                ))
            }
            ExpectedProcessObservation::PortFree => {
                return Err(DeployError::Activation(
                    "receipt-proven process remains alive without owning the live port".to_string(),
                ))
            }
        }
        locked.write_live(&LiveReceipt::new(selected.clone(), None, false, None))?;
    } else if LinuxProcfs::default().port_has_listener(store.paths().port())? {
        return Err(DeployError::Activation(
            "live port is occupied without authoritative lifecycle ownership".to_string(),
        ));
    }

    let record = LifecycleLaunchRecord::new(store)?;
    write_record(store, &path, &record)?;
    recover_launch(store, locked, auth_token, record)
}

fn recover_launch(
    store: &Store,
    locked: &LockedStore<'_>,
    auth_token: &str,
    mut record: LifecycleLaunchRecord,
) -> Result<()> {
    record.validate(store)?;
    if store.selected_generation_id()?.as_deref() != Some(&record.generation_id) {
        return Err(DeployError::Activation(
            "unfinished lifecycle launch no longer matches the selected generation".to_string(),
        ));
    }
    verify_node_prerequisite(&record.node, &record.generation_root)?;
    if record.complete {
        return Ok(());
    }
    let claim_store = LaunchAttemptReceiptStore::new(&record.claim_file)?;
    let existing_receipt = claim_store.read()?;
    match existing_receipt.as_ref() {
        Some(LaunchAttemptReceipt::Owned { claim }) => {
            if !claim_matches_record(claim, &record) {
                return Err(DeployError::Activation(
                    "lifecycle launch claim does not match its durable record".to_string(),
                ));
            }
            match observe_claimed_process(store, claim.executor.pid)? {
                ExpectedProcessObservation::Expected(process) => {
                    let ready = read_ready(&record.ready_file)?.ok_or_else(|| {
                        DeployError::Activation(
                            "lifecycle launch owns the port without a ready receipt".to_string(),
                        )
                    })?;
                    validate_started(&record, claim, &ready, &process)?;
                    require_ordinary(record.port)?;
                    return complete_launch(store, locked, record, *process);
                }
                ExpectedProcessObservation::Foreign => {
                    return Err(DeployError::Activation(
                        "lifecycle port is occupied without durable launch ownership".to_string(),
                    ))
                }
                ExpectedProcessObservation::PortFree => {}
            }
        }
        Some(LaunchAttemptReceipt::DefinitelyNotStarted { .. }) | None => {
            if LinuxProcfs::default().port_has_listener(record.port)? {
                return Err(DeployError::Activation(
                    "lifecycle port is occupied without durable launch ownership".to_string(),
                ));
            }
        }
    }

    match existing_receipt {
        None => spawn_lifecycle_helper(&record, auth_token)?,
        Some(LaunchAttemptReceipt::DefinitelyNotStarted { .. }) => {
            // A terminal attempt is never reused. Publish a fresh operation
            // before allowing another helper to execute.
            record = LifecycleLaunchRecord::new(store)?;
            write_record(store, &lifecycle_path(store), &record)?;
            spawn_lifecycle_helper(&record, auth_token)?;
        }
        Some(LaunchAttemptReceipt::Owned { claim }) => {
            if !claim_matches_record(&claim, &record) {
                return Err(DeployError::Activation(
                    "lifecycle launch claim does not match its durable record".to_string(),
                ));
            }
            let procfs = LinuxProcfs::default();
            if !procfs.executor_birth_is_alive(&claim.executor)? {
                claim_store.mark_definitely_not_started(&claim)?;
                record = LifecycleLaunchRecord::new(store)?;
                write_record(store, &lifecycle_path(store), &record)?;
                spawn_lifecycle_helper(&record, auth_token)?;
            }
        }
    }

    let deadline = Instant::now() + LIFECYCLE_TIMEOUT;
    loop {
        match LaunchAttemptReceiptStore::new(&record.claim_file)?.read()? {
            Some(LaunchAttemptReceipt::Owned { claim }) => {
                if !claim_matches_record(&claim, &record) {
                    return Err(DeployError::Activation(
                        "lifecycle launch claim does not match its durable record".to_string(),
                    ));
                }
                match observe_claimed_process(store, claim.executor.pid)? {
                    ExpectedProcessObservation::Expected(process) => {
                        if let Some(ready) = read_ready(&record.ready_file)? {
                            validate_started(&record, &claim, &ready, &process)?;
                            require_ordinary(record.port)?;
                            return complete_launch(store, locked, record, *process);
                        }
                    }
                    ExpectedProcessObservation::Foreign => {
                        return Err(DeployError::Activation(
                            "lifecycle listener appeared without its launch ownership".to_string(),
                        ))
                    }
                    ExpectedProcessObservation::PortFree => {}
                }
            }
            Some(LaunchAttemptReceipt::DefinitelyNotStarted { .. }) => {
                return Err(DeployError::Activation(
                    "lifecycle launch attempt ended without starting a server".to_string(),
                ))
            }
            None => {
                if LinuxProcfs::default().port_has_listener(record.port)? {
                    return Err(DeployError::Activation(
                        "lifecycle listener appeared without its launch claim".to_string(),
                    ));
                }
            }
        }
        if Instant::now() >= deadline {
            return Err(DeployError::Activation(
                "current generation did not become ready before the bounded deadline".to_string(),
            ));
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn complete_launch(
    store: &Store,
    locked: &LockedStore<'_>,
    mut record: LifecycleLaunchRecord,
    process: ProcessIdentity,
) -> Result<()> {
    locked.write_live(&LiveReceipt::new(
        record.generation_id.clone(),
        Some(record.generation_id.clone()),
        false,
        Some(process),
    ))?;
    record.complete = true;
    write_record(store, &lifecycle_path(store), &record)
}

fn stop_receipt_process(expected: &ProcessIdentity) -> Result<()> {
    match observe_recorded_process(expected)? {
        ExpectedProcessObservation::Expected(actual) if *actual == *expected => {
            let backend = LinuxPidfdBackend::new(LinuxProcfs::default());
            VerifiedProcess::bind(&backend, expected)?.terminate(StopPolicy::default())
        }
        ExpectedProcessObservation::PortFree
            if !LinuxProcfs::default().process_birth_is_alive(expected)? =>
        {
            Ok(())
        }
        ExpectedProcessObservation::Expected(_) | ExpectedProcessObservation::Foreign => {
            Err(DeployError::ProcessControl(
                "live port is owned by a process other than the receipt-proven current process"
                    .to_string(),
            ))
        }
        ExpectedProcessObservation::PortFree => Err(DeployError::ProcessControl(
            "receipt-proven process remains alive but no longer owns the live port".to_string(),
        )),
    }
}

fn observe_claimed_process(store: &Store, expected_pid: u32) -> Result<ExpectedProcessObservation> {
    let procfs = LinuxProcfs::default();
    let listener = match procfs.observe_listener_for_pid(store.paths().port(), expected_pid)? {
        ExpectedListenerObservation::PortFree => return Ok(ExpectedProcessObservation::PortFree),
        ExpectedListenerObservation::Foreign => return Ok(ExpectedProcessObservation::Foreign),
        ExpectedListenerObservation::Expected(listener) => listener,
    };
    let process = procfs.snapshot_listener(&listener)?;
    if procfs.observe_listener_for_pid(store.paths().port(), expected_pid)?
        != ExpectedListenerObservation::Expected(listener)
    {
        return Err(DeployError::ProcessIdentity(
            "listener ownership changed during lifecycle observation".to_string(),
        ));
    }
    Ok(ExpectedProcessObservation::Expected(Box::new(process)))
}

fn observe_recorded_process(expected: &ProcessIdentity) -> Result<ExpectedProcessObservation> {
    let procfs = LinuxProcfs::default();
    let listener = match procfs.observe_recorded_listener(&expected.listener)? {
        ExpectedListenerObservation::PortFree => return Ok(ExpectedProcessObservation::PortFree),
        ExpectedListenerObservation::Foreign => return Ok(ExpectedProcessObservation::Foreign),
        ExpectedListenerObservation::Expected(listener) => listener,
    };
    let process = procfs.snapshot_listener(&listener)?;
    if procfs.observe_recorded_listener(&listener)?
        != ExpectedListenerObservation::Expected(listener)
    {
        return Err(DeployError::ProcessIdentity(
            "recorded listener changed during lifecycle observation".to_string(),
        ));
    }
    Ok(ExpectedProcessObservation::Expected(Box::new(process)))
}

fn spawn_lifecycle_helper(record: &LifecycleLaunchRecord, auth_token: &str) -> Result<()> {
    let log_path = record
        .generation_root
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| DeployError::Activation("generation has no port root".to_string()))?
        .join("server.log");
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .custom_flags(libc::O_CLOEXEC)
        .open(&log_path)?;
    let stderr = log.try_clone()?;
    Command::new(&record.controller_executable)
        .arg("lifecycle-launch-helper")
        .arg("--record")
        .arg(
            record
                .generation_root
                .parent()
                .and_then(Path::parent)
                .expect("validated generation has port root")
                .join("lifecycle.json"),
        )
        .current_dir(&record.generation_root)
        .env("FRESHELL_DEPLOY_AUTH_TOKEN", auth_token)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(stderr))
        .spawn()
        .map(|_| ())
        .map_err(|error| {
            DeployError::Activation(format!("cannot start lifecycle launch helper: {error}"))
        })
}

pub fn execute_lifecycle_launch_helper(record_path: &Path) -> Result<()> {
    let checkout = checkout_from_lifecycle_path(record_path)?;
    let port = port_from_lifecycle_path(record_path)?;
    let store = Store::open(&checkout, port)?;
    let record = read_record(&store, record_path)?
        .ok_or_else(|| DeployError::Journal("lifecycle launch record is missing".to_string()))?;
    if record.complete
        || store.selected_generation_id()?.as_deref() != Some(&record.generation_id)
        || std::env::current_dir()? != record.generation_root
    {
        return Err(DeployError::Journal(
            "lifecycle helper is not bound to an incomplete exact-generation record".to_string(),
        ));
    }
    let procfs = LinuxProcfs::default();
    let executor = procfs.launch_executor_identity(
        std::process::id(),
        record.server_executable.clone(),
        &record.generation_root,
    )?;
    let claim = LaunchClaim {
        schema_version: "1".to_string(),
        claim_id: Uuid::new_v4().to_string(),
        transaction_id: record.operation_id.clone(),
        nonce: record.nonce.clone(),
        attempt_id: "current-0".to_string(),
        receipt_file: record.claim_file.clone(),
        lane: LaunchLane::TargetRollForward,
        generation_id: record.generation_id.clone(),
        port: record.port,
        executor,
    };
    let claim_store = LaunchAttemptReceiptStore::new(&record.claim_file)?;
    if claim_store.claim(&claim)?
        != (LaunchAttemptReceipt::Owned {
            claim: claim.clone(),
        })
    {
        return Ok(());
    }
    let auth_token = std::env::var("FRESHELL_DEPLOY_AUTH_TOKEN").map_err(|_| {
        DeployError::Activation("lifecycle helper AUTH_TOKEN is missing".to_string())
    })?;
    let external_environment = crate::production_env::production_environment(&checkout)?;
    let executable = record.generation_root.join("server/freshell-server");
    let mut command = Command::new(executable);
    command
        .current_dir(&record.generation_root)
        .env_clear()
        .envs(lifecycle_environment(
            &record,
            &auth_token,
            external_environment,
        )?);
    let error = command.exec();
    claim_store.mark_definitely_not_started(&claim)?;
    Err(DeployError::Activation(format!(
        "lifecycle helper could not exec current generation: {error}"
    )))
}

fn lifecycle_environment(
    record: &LifecycleLaunchRecord,
    auth_token: &str,
    mut environment: BTreeMap<OsString, OsString>,
) -> Result<BTreeMap<OsString, OsString>> {
    let node_parent = record.node.executable.parent().ok_or_else(|| {
        DeployError::Activation("Node executable has no verified parent".to_string())
    })?;
    for (key, value) in [
        (OsString::from("AUTH_TOKEN"), OsString::from(auth_token)),
        (
            OsString::from("FRESHELL_BIND_HOST"),
            OsString::from("0.0.0.0"),
        ),
        (
            OsString::from("FRESHELL_CLAUDE_NODE"),
            record.node.executable.as_os_str().to_owned(),
        ),
        (
            OsString::from("FRESHELL_CLAUDE_SIDECAR"),
            OsString::from(&record.runtime.claude_sidecar_entry),
        ),
        (
            OsString::from("FRESHELL_CLIENT_DIR"),
            OsString::from(&record.runtime.client_dir),
        ),
        (
            OsString::from("FRESHELL_DEPLOY_GENERATION_ID"),
            OsString::from(&record.generation_id),
        ),
        (
            OsString::from("FRESHELL_DEPLOY_NONCE"),
            OsString::from(&record.nonce),
        ),
        (
            OsString::from("FRESHELL_DEPLOY_READY_FILE"),
            record.ready_file.as_os_str().to_owned(),
        ),
        (
            OsString::from("FRESHELL_EXTENSIONS_DIR"),
            OsString::from(&record.runtime.extensions_dir),
        ),
        (
            OsString::from("FRESHELL_MCP_SERVER_ENTRY"),
            OsString::from(&record.runtime.mcp_entry),
        ),
        (OsString::from("NODE_ENV"), OsString::from("production")),
        (
            OsString::from("PORT"),
            OsString::from(record.port.to_string()),
        ),
    ] {
        environment.insert(key, value);
    }
    environment
        .entry(OsString::from("PATH"))
        .or_insert_with(|| node_parent.as_os_str().to_owned());
    Ok(environment)
}

fn validate_started(
    record: &LifecycleLaunchRecord,
    claim: &LaunchClaim,
    ready: &DeploymentReadyReceipt,
    process: &ProcessIdentity,
) -> Result<()> {
    ready.validate()?;
    if !claim_matches_record(claim, record)
        || ready.pid != claim.executor.pid
        || ready.nonce != record.nonce
        || ready.server_process_generation_id != record.generation_id
        || ready.validate()?.port() != record.port.get()
        || claim.executor.pid != process.pid
        || claim.executor.kernel_boot_id != process.kernel_boot_id
        || claim.executor.start_time_ticks != process.start_time_ticks
        || claim.executor.executable != process.executable
        || process.executable != record.server_executable
        || Path::new(&process.cwd) != record.generation_root
        || process.runtime != record.runtime
    {
        return Err(DeployError::Activation(
            "lifecycle ready/process evidence does not match its exact launch owner".to_string(),
        ));
    }
    Ok(())
}

fn claim_matches_record(claim: &LaunchClaim, record: &LifecycleLaunchRecord) -> bool {
    claim.schema_version == "1"
        && claim.transaction_id == record.operation_id
        && claim.nonce == record.nonce
        && claim.attempt_id == "current-0"
        && claim.receipt_file == record.claim_file
        && claim.lane == LaunchLane::TargetRollForward
        && claim.generation_id == record.generation_id
        && claim.port == record.port
        && claim.executor.executable == record.server_executable
        && Path::new(&claim.executor.cwd) == record.generation_root
        && claim.executor.effective_uid == unsafe { libc::geteuid() }
}

fn require_ordinary(port: DeployPort) -> Result<()> {
    let response = http_get(port, "/api/health")?;
    if response != 200 || http_get(port, "/")? != 200 {
        return Err(DeployError::Activation(
            "current generation is not serving ordinary healthy traffic".to_string(),
        ));
    }
    Ok(())
}

fn verify_node_prerequisite(node: &NodePrerequisite, generation_root: &Path) -> Result<()> {
    let output = RealProbeBackend::default().run_command(
        &ProbeCommand {
            program: node.executable.clone(),
            arguments: vec![OsString::from("--version")],
            current_dir: generation_root.to_path_buf(),
            environment: BTreeMap::new(),
            stdin: Vec::new(),
        },
        Duration::from_secs(5),
    )?;
    if std::str::from_utf8(&output.stdout).ok().map(str::trim) != Some(node.version.as_str()) {
        return Err(DeployError::Activation(
            "selected generation Node prerequisite changed".to_string(),
        ));
    }
    Ok(())
}

fn http_get(port: DeployPort, path: &str) -> Result<u16> {
    let address = SocketAddr::from(([127, 0, 0, 1], port.get()));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))
        .map_err(|error| DeployError::Activation(format!("HTTP connect failed: {error}")))?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    )?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response)?;
    let header_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| DeployError::Activation("HTTP response is malformed".to_string()))?;
    let headers = std::str::from_utf8(&response[..header_end])
        .map_err(|_| DeployError::Activation("HTTP response headers are not UTF-8".to_string()))?;
    headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|status| status.parse().ok())
        .ok_or_else(|| DeployError::Activation("HTTP status is malformed".to_string()))
}

fn read_ready(path: &Path) -> Result<Option<DeploymentReadyReceipt>> {
    let Some(bytes) = read_private_file(path, false)? else {
        return Ok(None);
    };
    let receipt = serde_json::from_slice(&bytes)
        .map_err(|error| DeployError::Activation(format!("invalid ready receipt: {error}")))?;
    Ok(Some(receipt))
}

fn lifecycle_path(store: &Store) -> PathBuf {
    store.paths().port_root().join("lifecycle.json")
}

fn read_record(store: &Store, path: &Path) -> Result<Option<LifecycleLaunchRecord>> {
    if path != lifecycle_path(store) {
        return Err(DeployError::UnsafeStorePath(path.to_path_buf()));
    }
    let Some(bytes) = read_private_file(path, true)? else {
        return Ok(None);
    };
    let record: LifecycleLaunchRecord = serde_json::from_slice(&bytes)
        .map_err(|error| DeployError::Journal(format!("invalid lifecycle journal: {error}")))?;
    record.validate(store)?;
    Ok(Some(record))
}

fn write_record(store: &Store, path: &Path, record: &LifecycleLaunchRecord) -> Result<()> {
    if path != lifecycle_path(store) {
        return Err(DeployError::UnsafeStorePath(path.to_path_buf()));
    }
    record.validate(store)?;
    atomic_write(path, &record.to_json()?, 0o600)
}

fn read_private_file(path: &Path, exact_private_mode: bool) -> Result<Option<Vec<u8>>> {
    let mut file = match fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || (exact_private_mode && metadata.mode() & 0o7777 != 0o600)
        || (!exact_private_mode && metadata.mode() & 0o022 != 0)
    {
        return Err(DeployError::Journal(
            "lifecycle evidence is not an owned protected regular file".to_string(),
        ));
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(Some(bytes))
}

fn require_no_pending_lifecycle(store: &Store) -> Result<()> {
    if read_record(store, &lifecycle_path(store))?.is_some_and(|record| !record.complete) {
        return Err(DeployError::Activation(
            "an unfinished current-generation launch must be recovered before stopping".to_string(),
        ));
    }
    Ok(())
}

fn checkout_from_lifecycle_path(path: &Path) -> Result<PathBuf> {
    if path.file_name().and_then(|name| name.to_str()) != Some("lifecycle.json") {
        return Err(DeployError::UnsafeStorePath(path.to_path_buf()));
    }
    path.parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .ok_or_else(|| DeployError::UnsafeStorePath(path.to_path_buf()))
}

fn port_from_lifecycle_path(path: &Path) -> Result<DeployPort> {
    let raw = path
        .parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        .ok_or_else(|| DeployError::UnsafeStorePath(path.to_path_buf()))?;
    DeployPort::parse(raw)
}

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

struct SelectedLaunchContract {
    server_executable: FileIdentity,
    controller_executable: PathBuf,
    runtime: RuntimeProvenance,
    node: NodePrerequisite,
    captured_legacy: bool,
}

fn selected_launch_contract(
    store: &Store,
    generation: &crate::store::Generation,
) -> Result<SelectedLaunchContract> {
    match GenerationDescriptor::read(generation) {
        Ok(descriptor) => {
            let mut runtime = descriptor.runtime_provenance(&generation.path);
            runtime.client_dir = store
                .paths()
                .current_pointer()
                .join("client")
                .display()
                .to_string();
            Ok(SelectedLaunchContract {
                server_executable: FileIdentity::from_path(
                    &descriptor.server_executable(&generation.path),
                )?,
                controller_executable: descriptor.controller(&generation.path),
                runtime,
                node: descriptor.node,
                captured_legacy: false,
            })
        }
        Err(descriptor_error) => {
            let legacy = store.read_legacy_capture()?.ok_or(descriptor_error)?;
            if legacy.generation_id != generation.id {
                return Err(DeployError::Activation(
                    "descriptor-less current generation is not the captured legacy recovery generation"
                        .to_string(),
                ));
            }
            let controller_executable = store.paths().legacy_controller().to_path_buf();
            let controller_metadata = fs::symlink_metadata(&controller_executable)?;
            if controller_metadata.file_type().is_symlink()
                || !controller_metadata.is_file()
                || controller_metadata.uid() != unsafe { libc::geteuid() }
                || controller_metadata.mode() & 0o7777 != 0o500
            {
                return Err(DeployError::UnsafeStorePath(controller_executable));
            }
            let mut runtime = crate::real_driver::runtime_from_bindings(
                &generation.path,
                &legacy.runtime,
                &legacy.node,
            );
            runtime.client_dir = store
                .paths()
                .current_pointer()
                .join("client")
                .display()
                .to_string();
            Ok(SelectedLaunchContract {
                server_executable: FileIdentity::from_path(
                    &generation.path.join(&legacy.runtime.server_executable),
                )?,
                controller_executable,
                runtime,
                node: legacy.node,
                captured_legacy: true,
            })
        }
    }
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    process_to_stop: Option<ProcessIdentity>,
    complete: bool,
}

impl LifecycleLaunchRecord {
    fn new(store: &Store, process_to_stop: Option<ProcessIdentity>) -> Result<Self> {
        let generation_id = store
            .selected_generation_id()?
            .ok_or_else(|| DeployError::Activation("current generation is missing".to_string()))?;
        let generation = store.verify_generation(&generation_id)?;
        let contract = selected_launch_contract(store, &generation)?;
        let operation_id = Uuid::new_v4().to_string();
        let controls =
            ControlPaths::create_private(store.paths(), &format!("lifecycle-{operation_id}"))?;
        let record = Self {
            schema_version: "1".to_string(),
            operation_id,
            port: store.paths().port(),
            generation_id,
            generation_root: generation.path.clone(),
            server_executable: contract.server_executable,
            controller_executable: contract.controller_executable,
            runtime: contract.runtime,
            node: contract.node,
            nonce: Uuid::new_v4().to_string(),
            claim_file: controls.directory.join("launch.json"),
            ready_file: controls.ready_file,
            process_to_stop,
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
        let contract = selected_launch_contract(store, &generation)?;
        let controls = store
            .paths()
            .transactions_dir()
            .join(format!("lifecycle-{}", self.operation_id));
        if self.generation_root != generation.path
            || self.controller_executable != contract.controller_executable
            || self.server_executable != contract.server_executable
            || self.runtime != contract.runtime
            || self.node != contract.node
            || self.claim_file != controls.join("launch.json")
            || self.ready_file != controls.join("ready.json")
        {
            return Err(DeployError::Journal(
                "lifecycle launch record escaped the exact selected generation".to_string(),
            ));
        }
        if let Some(process) = &self.process_to_stop {
            process.validate()?;
            if process.listener.port != self.port
                || process.effective_uid != unsafe { libc::geteuid() }
                || process.executable.sha256 != self.server_executable.sha256
                || if contract.captured_legacy {
                    process.executable.mode & !0o222 != self.server_executable.mode
                } else {
                    process.executable.mode != self.server_executable.mode
                }
            {
                return Err(DeployError::Journal(
                    "lifecycle restart process does not match the selected managed server"
                        .to_string(),
                ));
            }
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
    start_current_locked(&store, &locked, &auth_token, restart)
}

pub(crate) fn execute_stop_current(checkout: &Path, port: DeployPort) -> Result<()> {
    let store = Store::open(checkout, port)?;
    let locked = store.lock()?;
    if crate::controller::has_unfinished_transaction(&store)? {
        let auth_token = crate::controller::load_auth_token(checkout)?;
        crate::controller::recover_unfinished_locked(&store, &locked, &auth_token)?;
    }
    require_no_pending_lifecycle(&store)?;
    let selected = store
        .selected_generation_id()?
        .ok_or_else(|| DeployError::Activation("current generation is missing".to_string()))?;
    let generation = store.verify_generation(&selected)?;
    let captured_legacy = match GenerationDescriptor::read(&generation) {
        Ok(_) => None,
        Err(descriptor_error) => {
            let legacy = store.read_legacy_capture()?.ok_or(descriptor_error)?;
            if legacy.generation_id != selected {
                return Err(DeployError::InvalidReceipt(
                    "descriptor-less current generation is not the captured legacy recovery generation"
                        .to_string(),
                ));
            }
            Some(legacy)
        }
    };
    let live = store.read_live()?.ok_or_else(|| {
        DeployError::Activation("authoritative live receipt is missing".to_string())
    })?;
    if live.selected_generation_id != selected {
        return Err(DeployError::Activation(
            "live receipt disagrees with current generation".to_string(),
        ));
    }
    if let Some(legacy) = &captured_legacy {
        crate::controller::require_exact_captured_legacy(&selected, &live, legacy)?;
    }
    let Some(expected) = live.process_identity.as_ref() else {
        return Ok(());
    };
    stop_receipt_process(expected)?;
    locked.write_live(&LiveReceipt::new(selected, None, false, None))
}

pub(crate) fn recover_pending(checkout: &Path, port: DeployPort) -> Result<()> {
    recover_pending_with(checkout, port, || {}, recover_launch)
}

fn recover_pending_with<BeforeLock, Recover>(
    checkout: &Path,
    port: DeployPort,
    before_lock: BeforeLock,
    recover: Recover,
) -> Result<()>
where
    BeforeLock: FnOnce(),
    Recover: FnOnce(&Store, &LockedStore<'_>, &str, LifecycleLaunchRecord) -> Result<()>,
{
    let store = Store::open(checkout, port)?;
    before_lock();
    let locked = store.lock()?;
    let path = lifecycle_path(&store);
    let Some(record) = read_record(&store, &path)? else {
        return Ok(());
    };
    if record.complete {
        return Ok(());
    }
    let auth_token = crate::controller::load_auth_token(checkout)?;
    recover(&store, &locked, &auth_token, record)
}

pub(crate) fn start_current_locked(
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
    let contract = selected_launch_contract(store, &generation)?;
    verify_node_prerequisite(&contract.node, &generation.path)?;
    let live = store.read_live()?.ok_or_else(|| {
        DeployError::Activation("authoritative live receipt is missing".to_string())
    })?;
    if live.selected_generation_id != selected {
        return Err(DeployError::Activation(
            "live receipt disagrees with current generation".to_string(),
        ));
    }
    let process_to_stop = if let Some(expected) = live.process_identity.as_ref() {
        match observe_recorded_process(expected)? {
            ExpectedProcessObservation::Expected(actual) if *actual == *expected => {
                require_ordinary(store.paths().port())?;
                if !restart {
                    return Ok(());
                }
                Some(expected.clone())
            }
            ExpectedProcessObservation::PortFree
                if !LinuxProcfs::default().process_birth_is_alive(expected)? =>
            {
                Some(expected.clone())
            }
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
    } else if LinuxProcfs::default().port_has_listener(store.paths().port())? {
        return Err(DeployError::Activation(
            "live port is occupied without authoritative lifecycle ownership".to_string(),
        ));
    } else {
        None
    };

    let record = LifecycleLaunchRecord::new(store, process_to_stop)?;
    write_record(store, &path, &record)?;
    if restart && record.process_to_stop.is_some() {
        crate::sandbox_interrupt::interrupt_lifecycle_after(
            "lifecycle_restart_intent",
            store.paths().port(),
            store.paths().port_root(),
        );
    }
    recover_launch(store, locked, auth_token, record)
}

fn prepare_restart_process(
    store: &Store,
    locked: &LockedStore<'_>,
    mut record: LifecycleLaunchRecord,
) -> Result<LifecycleLaunchRecord> {
    let Some(expected) = record.process_to_stop.as_ref() else {
        return Ok(record);
    };
    let live = store.read_live()?.ok_or_else(|| {
        DeployError::Activation("authoritative live receipt is missing".to_string())
    })?;
    if live.selected_generation_id != record.generation_id {
        return Err(DeployError::Activation(
            "restart intent disagrees with the selected live generation".to_string(),
        ));
    }
    match live.process_identity.as_ref() {
        Some(actual) if actual == expected => {}
        None if live.running_server_generation_id.is_none() => {}
        _ => {
            return Err(DeployError::Activation(
                "restart intent no longer matches the authoritative live process".to_string(),
            ))
        }
    }

    stop_receipt_process(expected)?;
    crate::sandbox_interrupt::interrupt_lifecycle_after(
        "lifecycle_restart_process_stopped",
        store.paths().port(),
        store.paths().port_root(),
    );
    if live.process_identity.is_some() {
        locked.write_live(&LiveReceipt::new(
            record.generation_id.clone(),
            None,
            false,
            None,
        ))?;
    }
    record.process_to_stop = None;
    write_record(store, &lifecycle_path(store), &record)?;
    Ok(record)
}

fn recover_launch(
    store: &Store,
    locked: &LockedStore<'_>,
    auth_token: &str,
    record: LifecycleLaunchRecord,
) -> Result<()> {
    let mut record = prepare_restart_process(store, locked, record)?;
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
            record = LifecycleLaunchRecord::new(store, None)?;
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
                record = LifecycleLaunchRecord::new(store, None)?;
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

#[cfg(test)]
mod tests {
    use std::net::TcpListener;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc};

    use super::*;
    use crate::controller::{inspect_bootstrap_status, BootstrapStatus};
    use crate::legacy::{LegacyCaptureReceipt, NonSecretLaunchMetadata, RuntimeBindings};
    use crate::process_identity::ListenerIdentity;

    fn write(path: impl AsRef<Path>, bytes: impl AsRef<[u8]>) {
        let path = path.as_ref();
        fs::create_dir_all(path.parent().expect("fixture path has parent")).unwrap();
        fs::write(path, bytes).unwrap();
    }

    fn executable(path: impl AsRef<Path>, body: &str) {
        let path = path.as_ref();
        write(path, format!("#!/bin/sh\n{body}\n"));
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn managed_store() -> (tempfile::TempDir, Store, LifecycleLaunchRecord) {
        let fixture = tempfile::tempdir().unwrap();
        let checkout = fixture.path().join("checkout");
        fs::create_dir(&checkout).unwrap();
        write(checkout.join(".git"), "gitdir: /tmp/fixture.git\n");
        write(
            checkout.join(".env"),
            "AUTH_TOKEN=lifecycle-concurrency-test\n",
        );

        let node = fixture.path().join("node");
        executable(&node, "echo v22.0.0");
        let source = fixture.path().join("generation");
        executable(source.join("server/freshell-server"), "exit 0");
        executable(source.join("controller/freshell-deploy"), "exit 0");
        write(source.join("client/index.html"), "fixture\n");
        write(source.join("extensions/fixture.json"), "{}\n");
        write(source.join("dist/server/mcp/server.js"), "export {}\n");
        write(source.join("claude-sidecar/index.mjs"), "process.exit(0)\n");
        write(source.join("package.json"), "{}\n");
        write(source.join("package-lock.json"), "{}\n");
        write(
            source.join("node_modules/fixture/package.json"),
            "{\"name\":\"fixture\"}\n",
        );
        write(
            source.join("deployment.json"),
            format!(
                "{}\n",
                serde_json::json!({
                    "schemaVersion": "1",
                    "controllerExecutable": "controller/freshell-deploy",
                    "runtime": {
                        "serverExecutable": "server/freshell-server",
                        "clientDir": "client",
                        "extensionsDir": "extensions",
                        "distServerDir": "dist/server",
                        "mcpEntry": "dist/server/mcp/server.js",
                        "claudeSidecarEntry": "claude-sidecar/index.mjs",
                        "packageJson": "package.json",
                        "packageLock": "package-lock.json",
                        "productionNodeModules": "node_modules"
                    },
                    "node": {
                        "executable": node,
                        "version": "v22.0.0"
                    }
                })
            ),
        );

        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = DeployPort::new(listener.local_addr().unwrap().port()).unwrap();
        drop(listener);
        let store = Store::open(&checkout, port).unwrap();
        let locked = store.lock().unwrap();
        let generation = locked.import_tree(&source).unwrap();
        locked.select_generation(&generation.id).unwrap();
        drop(locked);
        let record = LifecycleLaunchRecord::new(&store, None).unwrap();
        write_record(&store, &lifecycle_path(&store), &record).unwrap();
        (fixture, store, record)
    }

    fn fake_running_process(record: &LifecycleLaunchRecord) -> ProcessIdentity {
        ProcessIdentity {
            pid: u32::MAX - 1,
            kernel_boot_id: "11111111-2222-3333-4444-555555555555".to_string(),
            start_time_ticks: "90071992547409931234".to_string(),
            executable: record.server_executable.clone(),
            listener: ListenerIdentity {
                port: record.port,
                socket_inode: "991122".to_string(),
                owner_pid: u32::MAX - 1,
                network_namespace: "net:[4026533111]".to_string(),
            },
            cwd: record.generation_root.display().to_string(),
            argv0: "freshell-server".to_string(),
            argument_count: 1,
            effective_uid: unsafe { libc::geteuid() },
            runtime: record.runtime.clone(),
        }
    }

    fn captured_legacy_store() -> (tempfile::TempDir, Store, ProcessIdentity) {
        let fixture = tempfile::tempdir().unwrap();
        let checkout = fixture.path().join("checkout");
        fs::create_dir(&checkout).unwrap();
        write(checkout.join(".git"), "gitdir: /tmp/fixture.git\n");

        let node = fixture.path().join("node");
        executable(&node, "echo v22.0.0");
        let source = fixture.path().join("legacy-generation");
        executable(source.join("server/freshell-server"), "exit 0");
        write(source.join("client/index.html"), "legacy fixture\n");
        write(source.join("extensions/fixture.json"), "{}\n");
        write(source.join("dist/server/mcp/server.js"), "export {}\n");
        write(source.join("claude-sidecar/index.mjs"), "process.exit(0)\n");
        write(source.join("package.json"), "{}\n");
        write(source.join("package-lock.json"), "{}\n");
        write(
            source.join("node_modules/fixture/package.json"),
            "{\"name\":\"fixture\"}\n",
        );

        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = DeployPort::new(listener.local_addr().unwrap().port()).unwrap();
        drop(listener);
        let store = Store::open(&checkout, port).unwrap();
        let locked = store.lock().unwrap();
        let generation = locked.import_tree(&source).unwrap();
        locked.select_generation(&generation.id).unwrap();

        let mut executable =
            FileIdentity::from_path(&generation.path.join("server/freshell-server")).unwrap();
        executable.mode |= 0o200;
        let process = ProcessIdentity {
            pid: u32::MAX - 1,
            kernel_boot_id: "11111111-2222-3333-4444-555555555555".to_string(),
            start_time_ticks: "90071992547409931234".to_string(),
            executable,
            listener: ListenerIdentity {
                port,
                socket_inode: "991122".to_string(),
                owner_pid: u32::MAX - 1,
                network_namespace: "net:[4026533111]".to_string(),
            },
            cwd: checkout.display().to_string(),
            argv0: "freshell-server".to_string(),
            argument_count: 1,
            effective_uid: unsafe { libc::geteuid() },
            runtime: RuntimeProvenance {
                client_dir: source.join("client").display().to_string(),
                extensions_dir: source.join("extensions").display().to_string(),
                dist_server_dir: source.join("dist/server").display().to_string(),
                mcp_entry: source
                    .join("dist/server/mcp/server.js")
                    .display()
                    .to_string(),
                claude_sidecar_entry: source
                    .join("claude-sidecar/index.mjs")
                    .display()
                    .to_string(),
                node_executable: node.display().to_string(),
                package_json: source.join("package.json").display().to_string(),
                package_lock: source.join("package-lock.json").display().to_string(),
                production_node_modules: source.join("node_modules").display().to_string(),
            },
        };
        let legacy = LegacyCaptureReceipt {
            schema_version: "1".to_string(),
            generation_id: generation.id.clone(),
            legacy: true,
            process: process.clone(),
            runtime: RuntimeBindings {
                server_executable: "server/freshell-server".to_string(),
                client_dir: "client".to_string(),
                extensions_dir: "extensions".to_string(),
                dist_server_dir: "dist/server".to_string(),
                mcp_entry: "dist/server/mcp/server.js".to_string(),
                claude_sidecar_entry: "claude-sidecar/index.mjs".to_string(),
                package_json: "package.json".to_string(),
                package_lock: "package-lock.json".to_string(),
                production_node_modules: "node_modules".to_string(),
            },
            node: NodePrerequisite {
                executable: node,
                version: "v22.0.0".to_string(),
            },
            launch: NonSecretLaunchMetadata {
                cwd: process.cwd.clone(),
                argv0: process.argv0.clone(),
                argument_count: process.argument_count,
            },
        };
        locked.write_legacy_capture(&legacy).unwrap();
        locked
            .write_live(&LiveReceipt::new(
                generation.id.clone(),
                Some(generation.id),
                true,
                Some(process.clone()),
            ))
            .unwrap();
        drop(locked);
        (fixture, store, process)
    }

    #[test]
    fn stop_current_accepts_the_receipt_proven_captured_legacy_selection() {
        let (_fixture, store, captured_process) = captured_legacy_store();

        execute_stop_current(store.paths().checkout(), store.paths().port()).unwrap();

        let stopped = store.read_live().unwrap().unwrap();
        assert_eq!(
            stopped.selected_generation_id,
            store.selected_generation_id().unwrap().unwrap()
        );
        assert_eq!(
            stopped.running_server_generation_id, None,
            "a stopped receipt must not claim the captured process is still running"
        );
        assert_eq!(stopped.process_identity, None);
        assert!(!stopped.legacy);
        assert_eq!(
            inspect_bootstrap_status(&store).unwrap(),
            BootstrapStatus::CapturedLegacy,
            "the launcher must keep selecting the immutable legacy controller after stop"
        );
        assert_eq!(
            store.read_legacy_capture().unwrap().unwrap().process,
            captured_process,
            "stop must not rewrite the capture evidence"
        );
    }

    #[test]
    fn stop_current_rejects_a_descriptorless_selection_without_capture_evidence() {
        let (_fixture, store, _captured_process) = captured_legacy_store();
        let live_before = fs::read(store.paths().live_receipt()).unwrap();
        fs::remove_file(store.paths().legacy_receipt()).unwrap();

        assert!(
            execute_stop_current(store.paths().checkout(), store.paths().port()).is_err(),
            "descriptor-less selection must fail closed without immutable capture evidence"
        );
        assert_eq!(
            fs::read(store.paths().live_receipt()).unwrap(),
            live_before,
            "a rejected stop must not rewrite authoritative process evidence"
        );
    }

    #[test]
    fn delayed_recovery_rereads_completed_operation_after_a_later_exact_stop() {
        let (_fixture, store, initial) = managed_store();
        let original_operation = initial.operation_id.clone();
        let checkout = store.paths().checkout().to_path_buf();
        let port = store.paths().port();
        let (paused_tx, paused_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel();
        let recovery_starts = Arc::new(AtomicUsize::new(0));
        let observed_starts = Arc::clone(&recovery_starts);
        let delayed_checkout = checkout.clone();

        let delayed = thread::spawn(move || {
            recover_pending_with(
                &delayed_checkout,
                port,
                || {
                    paused_tx.send(()).unwrap();
                    resume_rx.recv().unwrap();
                },
                |store, _locked, _token, _stale_record| {
                    observed_starts.fetch_add(1, Ordering::SeqCst);
                    let replacement = LifecycleLaunchRecord::new(store, None)?;
                    write_record(store, &lifecycle_path(store), &replacement)
                },
            )
        });
        paused_rx.recv().unwrap();

        let locked = store.lock().unwrap();
        let mut completed = read_record(&store, &lifecycle_path(&store))
            .unwrap()
            .unwrap();
        assert_eq!(completed.operation_id, original_operation);
        completed.complete = true;
        locked
            .write_live(&LiveReceipt::new(
                completed.generation_id.clone(),
                Some(completed.generation_id.clone()),
                false,
                Some(fake_running_process(&completed)),
            ))
            .unwrap();
        write_record(&store, &lifecycle_path(&store), &completed).unwrap();
        drop(locked);

        execute_stop_current(&checkout, port).unwrap();
        let stopped = store.read_live().unwrap().unwrap();
        assert!(stopped.process_identity.is_none());
        assert!(stopped.running_server_generation_id.is_none());

        resume_tx.send(()).unwrap();
        delayed.join().unwrap().unwrap();

        let authoritative = read_record(&store, &lifecycle_path(&store))
            .unwrap()
            .unwrap();
        assert_eq!(recovery_starts.load(Ordering::SeqCst), 0);
        assert_eq!(authoritative.operation_id, original_operation);
        assert!(authoritative.complete);
        let still_stopped = store.read_live().unwrap().unwrap();
        assert!(still_stopped.process_identity.is_none());
        assert!(still_stopped.running_server_generation_id.is_none());
    }
}

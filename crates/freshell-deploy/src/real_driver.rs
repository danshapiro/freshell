use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::net::SocketAddr;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use uuid::Uuid;

use crate::activation::{
    publish_activation_authorization, publish_activation_cancellation, read_activation_receipt,
    read_cancellation_receipt, ActivationDriver, ActivationReceiptObservation,
    CancellationReceiptObservation, LaunchAttemptObservation, LaunchSpec, PortState, ServiceState,
};
use crate::bounded_http::{get as bounded_http_get, HttpLimits, HttpResponse};
use crate::deployment::{required_predecessor_client_assets, GenerationDescriptor};
use crate::error::{DeployError, Result};
use crate::journal::{
    ControlPaths, DurableTransactionJournal, LaunchAttempt, LaunchAttemptState, LaunchClaim,
    LaunchLane, TransactionJournal, TransactionRecord,
};
use crate::launch_receipt::{LaunchAttemptReceipt, LaunchAttemptReceiptStore};
use crate::legacy::{
    NodePrerequisite, RealScratchProbe, RuntimeBindings, ScratchProbe, ScratchProbeRequest,
};
use crate::probe::{
    validate_client_only_entries, validate_compatibility_artifacts, CandidateEvidence,
    DeploymentReadyReceipt, GenerationProbe, GenerationProbeRequest, RealProbeBackend,
};
use crate::process_control::{LinuxPidfdBackend, StopPolicy, VerifiedProcess};
use crate::process_identity::{
    ExpectedListenerObservation, FileIdentity, LinuxProcfs, ProcessIdentity, RuntimeProvenance,
};
use crate::receipts::LiveReceipt;
use crate::store::{LockedStore, Store};

const LAUNCH_TIMEOUT: Duration = Duration::from_secs(20);
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

enum ExpectedProcessObservation {
    PortFree,
    Expected(Box<ProcessIdentity>),
    Foreign,
}

fn distinct_expected_processes<'a>(
    processes: impl IntoIterator<Item = &'a ProcessIdentity>,
) -> Vec<&'a ProcessIdentity> {
    let mut distinct = Vec::new();
    for process in processes {
        if !distinct.contains(&process) {
            distinct.push(process);
        }
    }
    distinct
}

pub struct RealActivationDriver<'store, 'lock> {
    store: &'store Store,
    locked: &'lock LockedStore<'store>,
    auth_token: String,
    procfs: LinuxProcfs,
    probe_sequence: u64,
}

impl<'store, 'lock> RealActivationDriver<'store, 'lock> {
    pub fn new(
        store: &'store Store,
        locked: &'lock LockedStore<'store>,
        auth_token: String,
    ) -> Result<Self> {
        if auth_token.is_empty() {
            return Err(DeployError::Activation(
                "AUTH_TOKEN must be available to the deployment controller".to_string(),
            ));
        }
        Ok(Self {
            store,
            locked,
            auth_token,
            procfs: LinuxProcfs::default(),
            probe_sequence: 0,
        })
    }

    pub(crate) fn preflight_fresh_target(&mut self, root: &Path, id: &str) -> Result<()> {
        if self.store.selected_generation_id()?.is_some()
            || self.store.read_live()?.is_some()
            || self.store.read_legacy_capture()?.is_some()
            || self.procfs.port_has_listener(self.store.paths().port())?
        {
            return Err(DeployError::Activation(
                "fresh deployment state changed before target preflight".to_string(),
            ));
        }
        self.probe_generation(root, id)
    }

    fn probe_generation(&mut self, root: &Path, id: &str) -> Result<()> {
        let generation = self.store.verify_generation(id)?;
        if generation.path != root {
            return Err(DeployError::Probe(
                "probe root does not match the immutable generation".to_string(),
            ));
        }
        let descriptor = GenerationDescriptor::read(&generation)?;
        self.probe_sequence = self
            .probe_sequence
            .checked_add(1)
            .ok_or_else(|| DeployError::Probe("probe sequence overflow".to_string()))?;
        let probe_root = self
            .store
            .paths()
            .port_root()
            .join("transactions")
            .join(format!(
                "probe-{}-{}",
                std::process::id(),
                self.probe_sequence
            ));
        fs::create_dir(&probe_root)?;
        fs::set_permissions(&probe_root, fs::Permissions::from_mode(0o700))?;
        let home = probe_root.join("home");
        fs::create_dir(&home)?;
        fs::set_permissions(&home, fs::Permissions::from_mode(0o700))?;
        let request = GenerationProbeRequest {
            generation_root: root.to_path_buf(),
            generation_id: id.to_string(),
            isolated_home: home,
            ready_file: probe_root.join("ready.json"),
            nonce: Uuid::new_v4().to_string(),
            auth_token: self.auth_token.clone(),
            runtime: descriptor.runtime,
            node: descriptor.node,
        };
        let result =
            GenerationProbe::new(&mut RealProbeBackend::default(), PROBE_TIMEOUT).verify(&request);
        remove_probe_directory(&probe_root)?;
        result.map(|_| ())
    }

    fn observe_claimed_process(
        &self,
        port: crate::paths::DeployPort,
        expected_pid: u32,
    ) -> Result<ExpectedProcessObservation> {
        let listener = match self.procfs.observe_listener_for_pid(port, expected_pid)? {
            ExpectedListenerObservation::PortFree => {
                return Ok(ExpectedProcessObservation::PortFree)
            }
            ExpectedListenerObservation::Foreign => return Ok(ExpectedProcessObservation::Foreign),
            ExpectedListenerObservation::Expected(listener) => listener,
        };
        let process = self.procfs.snapshot_listener(&listener)?;
        if self.procfs.observe_listener_for_pid(port, expected_pid)?
            != ExpectedListenerObservation::Expected(listener)
        {
            return Err(DeployError::ProcessIdentity(
                "listener ownership changed during deployment observation".to_string(),
            ));
        }
        Ok(ExpectedProcessObservation::Expected(Box::new(process)))
    }

    fn observe_recorded_process(
        &self,
        expected: &ProcessIdentity,
    ) -> Result<ExpectedProcessObservation> {
        let listener = match self.procfs.observe_recorded_listener(&expected.listener)? {
            ExpectedListenerObservation::PortFree => {
                return Ok(ExpectedProcessObservation::PortFree)
            }
            ExpectedListenerObservation::Foreign => return Ok(ExpectedProcessObservation::Foreign),
            ExpectedListenerObservation::Expected(listener) => listener,
        };
        let process = self.procfs.snapshot_listener(&listener)?;
        if self.procfs.observe_recorded_listener(&listener)?
            != ExpectedListenerObservation::Expected(listener)
        {
            return Err(DeployError::ProcessIdentity(
                "recorded listener changed during deployment observation".to_string(),
            ));
        }
        Ok(ExpectedProcessObservation::Expected(Box::new(process)))
    }

    fn candidate_service(&self, port: crate::paths::DeployPort) -> Result<ServiceState> {
        match http_get(port, "/", None)? {
            HttpResponse { status: 200, .. } => Ok(ServiceState::Ordinary),
            HttpResponse { status: 503, .. } => Ok(ServiceState::Gated),
            response => Err(DeployError::Activation(format!(
                "candidate returned unexpected HTTP status {}",
                response.status
            ))),
        }
    }

    fn spawn_launch_helper(&self, spec: &LaunchSpec, attempt: &LaunchAttempt) -> Result<()> {
        let executable = std::env::current_exe()?;
        let log_path = self.store.paths().port_root().join("server.log");
        let log = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .custom_flags(libc::O_CLOEXEC)
            .open(&log_path)?;
        fs::set_permissions(&log_path, fs::Permissions::from_mode(0o600))?;
        let stderr = log.try_clone()?;
        let mut command = Command::new(executable);
        command
            .arg("launch-helper")
            .arg("--journal")
            .arg(self.store.paths().transaction_journal())
            .arg("--attempt")
            .arg(&attempt.attempt_id)
            .current_dir(&spec.generation_root)
            .env("FRESHELL_DEPLOY_AUTH_TOKEN", &self.auth_token)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(stderr));
        command.spawn().map(|_| ()).map_err(|error| {
            DeployError::Activation(format!("cannot start durable launch helper: {error}"))
        })
    }

    fn observe_launch(
        &self,
        spec: &LaunchSpec,
        attempt: &LaunchAttempt,
        receipt: LaunchAttemptReceipt,
    ) -> Result<LaunchAttemptObservation> {
        match receipt {
            LaunchAttemptReceipt::DefinitelyNotStarted { claim } => {
                Ok(LaunchAttemptObservation::DefinitelyNotStarted(claim))
            }
            LaunchAttemptReceipt::Owned { claim } => {
                if !claim_matches_spec(&claim, spec, attempt) {
                    return Ok(LaunchAttemptObservation::Malformed);
                }
                let ready_path = server_ready_path(attempt)?;
                let ready = read_ready_receipt(&ready_path)?;
                if let Some(ready) = ready {
                    if ready.pid != claim.executor.pid
                        || ready.nonce != spec.nonce
                        || ready.server_process_generation_id != spec.generation_id
                        || ready.validate()?.port() != spec.port.get()
                    {
                        return Ok(LaunchAttemptObservation::Malformed);
                    }
                    let process =
                        match self.observe_claimed_process(spec.port, claim.executor.pid)? {
                            ExpectedProcessObservation::Expected(process) => process,
                            ExpectedProcessObservation::Foreign => {
                                return Ok(LaunchAttemptObservation::Malformed)
                            }
                            ExpectedProcessObservation::PortFree => {
                                if self.procfs.executor_birth_is_alive(&claim.executor)? {
                                    return Ok(LaunchAttemptObservation::Owned(claim));
                                }
                                let store = LaunchAttemptReceiptStore::new(&attempt.ready_file)?;
                                return match store.mark_definitely_not_started(&claim)? {
                                    LaunchAttemptReceipt::DefinitelyNotStarted { claim } => {
                                        Ok(LaunchAttemptObservation::DefinitelyNotStarted(claim))
                                    }
                                    LaunchAttemptReceipt::Owned { .. } => {
                                        unreachable!("terminal transition")
                                    }
                                };
                            }
                        };
                    if !executor_matches_process(&claim, &process)
                        || process.runtime != spec.runtime
                        || Path::new(&process.cwd) != spec.generation_root
                    {
                        return Ok(LaunchAttemptObservation::Malformed);
                    }
                    let service = self.candidate_service(spec.port)?;
                    return match attempt.lane {
                        LaunchLane::TargetGated if service == ServiceState::Gated => {
                            Ok(LaunchAttemptObservation::Gated {
                                claim,
                                candidate: CandidateEvidence {
                                    ready,
                                    process: *process,
                                },
                            })
                        }
                        LaunchLane::PriorRollback | LaunchLane::TargetRollForward
                            if service == ServiceState::Ordinary =>
                        {
                            Ok(LaunchAttemptObservation::Ordinary {
                                claim,
                                process: *process,
                            })
                        }
                        _ => Ok(LaunchAttemptObservation::Malformed),
                    };
                }
                if self.procfs.executor_birth_is_alive(&claim.executor)? {
                    return Ok(LaunchAttemptObservation::Owned(claim));
                }
                let store = LaunchAttemptReceiptStore::new(&attempt.ready_file)?;
                match store.mark_definitely_not_started(&claim)? {
                    LaunchAttemptReceipt::DefinitelyNotStarted { claim } => {
                        Ok(LaunchAttemptObservation::DefinitelyNotStarted(claim))
                    }
                    LaunchAttemptReceipt::Owned { .. } => unreachable!("terminal transition"),
                }
            }
        }
    }
}

impl ActivationDriver for RealActivationDriver<'_, '_> {
    fn preflight(&mut self, request: &crate::activation::ActivationRequest) -> Result<()> {
        if request.port != self.store.paths().port()
            || request.prior_generation_id
                != self
                    .store
                    .selected_generation_id()?
                    .ok_or_else(|| DeployError::Activation("current is missing".to_string()))?
            || self.store.read_live()?.as_ref() != Some(&request.prior_live)
        {
            return Err(DeployError::Activation(
                "activation preflight disagrees with authoritative store state".to_string(),
            ));
        }
        let prior = self.store.verify_generation(&request.prior_generation_id)?;
        let target = self
            .store
            .verify_generation(&request.target_generation_id)?;
        if request.mode == crate::journal::UpdateMode::ClientOnly {
            let required_assets = required_predecessor_client_assets(&prior)?;
            validate_client_only_entries(
                &prior.manifest.entries,
                &target.manifest.entries,
                &required_assets,
            )?;
            let process = request
                .prior_live
                .process_identity
                .as_ref()
                .ok_or_else(|| {
                    DeployError::Activation("client-only prior process is missing".to_string())
                })?;
            self.verify_running(process)?;
            let response = http_get(
                request.port,
                "/api/deployment-compatibility",
                Some(&self.auth_token),
            )?;
            if response.status != 200 {
                return Err(DeployError::Probe(format!(
                    "running server compatibility check returned {}",
                    response.status
                )));
            }
            let pair = validate_compatibility_artifacts(
                &target.path.join("client/deployment-compatibility.json"),
                &response.body,
            )?;
            if pair.server_process_generation_id.as_deref()
                != request.prior_live.running_server_generation_id.as_deref()
            {
                return Err(DeployError::Probe(
                    "running server compatibility identity changed".to_string(),
                ));
            }
            // The endpoint bootId is a Freshell process-boot UUID, while
            // ProcessIdentity.kernel_boot_id names the Linux kernel boot.
            // Bind the response to the exact listener birth by revalidating
            // the receipt-proven process immediately after the read instead
            // of comparing those intentionally different namespaces.
            self.verify_running(process)?;
            if !matches!(
                self.observe_recorded_process(process)?,
                ExpectedProcessObservation::Expected(actual) if *actual == *process
            ) {
                return Err(DeployError::Probe(
                    "running server changed during compatibility validation".to_string(),
                ));
            }
        }
        Ok(())
    }

    fn probe_target(&mut self, root: &Path, id: &str) -> Result<()> {
        self.probe_generation(root, id)
    }

    fn probe_prior(&mut self, root: &Path, id: &str) -> Result<()> {
        let generation = self.store.verify_generation(id)?;
        if generation.path != root {
            return Err(DeployError::Probe(
                "prior probe root does not match its generation".to_string(),
            ));
        }
        match GenerationDescriptor::read(&generation) {
            Ok(_) => self.probe_generation(root, id),
            Err(descriptor_error) => {
                let legacy = self.store.read_legacy_capture()?.ok_or(descriptor_error)?;
                if legacy.generation_id != id {
                    return Err(DeployError::Probe(
                        "descriptor-less prior is not the captured legacy generation".to_string(),
                    ));
                }
                let probe_root = self
                    .store
                    .paths()
                    .port_root()
                    .join("transactions")
                    .join(format!("legacy-probe-{}", Uuid::new_v4()));
                fs::create_dir(&probe_root)?;
                fs::set_permissions(&probe_root, fs::Permissions::from_mode(0o700))?;
                let home = probe_root.join("home");
                fs::create_dir(&home)?;
                fs::set_permissions(&home, fs::Permissions::from_mode(0o700))?;
                let request = ScratchProbeRequest {
                    generation_path: root.to_path_buf(),
                    generation_id: id.to_string(),
                    isolated_home: home,
                    port: 0,
                    runtime: legacy.runtime,
                    node: legacy.node,
                };
                let result = RealScratchProbe::default().verify(&request);
                remove_probe_directory(&probe_root)?;
                result
            }
        }
    }

    fn verify_running(&mut self, process: &ProcessIdentity) -> Result<()> {
        let backend = LinuxPidfdBackend::new(self.procfs.clone());
        VerifiedProcess::bind(&backend, process)?.revalidate()
    }

    fn verify_exited(&mut self, process: &ProcessIdentity) -> Result<()> {
        if self.procfs.process_birth_is_alive(process)? {
            return Err(DeployError::ProcessControl(format!(
                "exact process birth {} remains alive",
                process.pid
            )));
        }
        Ok(())
    }

    fn observe_port(&mut self, record: &TransactionRecord) -> Result<PortState> {
        let expected_processes = distinct_expected_processes(
            [
                record.expected_prior_process(),
                record
                    .candidate
                    .as_ref()
                    .map(|candidate| &candidate.process),
                record.active_relaunch_process(),
            ]
            .into_iter()
            .flatten(),
        );

        let mut observed_occupied = false;
        for expected in expected_processes {
            let process = match self.observe_recorded_process(expected)? {
                ExpectedProcessObservation::PortFree if !observed_occupied => {
                    return Ok(PortState::Free)
                }
                ExpectedProcessObservation::PortFree | ExpectedProcessObservation::Foreign => {
                    observed_occupied = true;
                    continue;
                }
                ExpectedProcessObservation::Expected(process) => process,
            };
            if record.expected_prior_process() == Some(&*process) {
                return Ok(PortState::Prior {
                    process: *process,
                    service: ServiceState::Ordinary,
                });
            }
            if let Some(candidate) = &record.candidate {
                if *process == candidate.process {
                    return Ok(PortState::Target {
                        candidate: candidate.clone(),
                        service: self.candidate_service(record.port)?,
                    });
                }
            }
            if record.active_relaunch_process() == Some(&*process) {
                return match record.active_relaunch_lane() {
                    Some(LaunchLane::PriorRollback) => Ok(PortState::Prior {
                        process: *process,
                        service: ServiceState::Ordinary,
                    }),
                    Some(LaunchLane::TargetRollForward) => {
                        Ok(PortState::TargetRelaunch { process: *process })
                    }
                    Some(LaunchLane::TargetGated) | None => Ok(PortState::Foreign),
                };
            }
            return Ok(PortState::Foreign);
        }
        if self.procfs.port_has_listener(record.port)? {
            Ok(PortState::Foreign)
        } else {
            Ok(PortState::Free)
        }
    }

    fn stop(&mut self, process: &ProcessIdentity) -> Result<()> {
        let backend = LinuxPidfdBackend::new(self.procfs.clone());
        VerifiedProcess::bind(&backend, process)?.terminate(StopPolicy::default())
    }

    fn ensure_launch_attempt(
        &mut self,
        spec: &LaunchSpec,
        attempt: &LaunchAttempt,
        claim_if_unclaimed: bool,
    ) -> Result<LaunchAttemptObservation> {
        let store = LaunchAttemptReceiptStore::new(&attempt.ready_file)?;
        let mut receipt = store.read()?;
        if receipt.is_none() {
            if !claim_if_unclaimed {
                return Ok(LaunchAttemptObservation::Unclaimed);
            }
            self.spawn_launch_helper(spec, attempt)?;
        }
        let deadline = Instant::now() + LAUNCH_TIMEOUT;
        loop {
            receipt = store.read()?;
            if let Some(receipt) = receipt {
                let observation = self.observe_launch(spec, attempt, receipt)?;
                if !matches!(observation, LaunchAttemptObservation::Owned(_)) {
                    return Ok(observation);
                }
                if Instant::now() >= deadline {
                    return Ok(observation);
                }
            } else if Instant::now() >= deadline {
                return Ok(LaunchAttemptObservation::Unclaimed);
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn selected_generation(&mut self) -> Result<String> {
        self.store
            .selected_generation_id()?
            .ok_or_else(|| DeployError::Activation("current generation is missing".to_string()))
    }

    fn switch_generation(&mut self, expected: &str, target: &str) -> Result<()> {
        if self.store.selected_generation_id()?.as_deref() != Some(expected) {
            return Err(DeployError::Activation(
                "current generation changed before pointer switch".to_string(),
            ));
        }
        self.locked.select_generation(target)
    }

    fn authorize(&mut self, candidate: &CandidateEvidence, controls: &ControlPaths) -> Result<()> {
        publish_activation_authorization(
            controls,
            &candidate.ready.nonce,
            &candidate.ready.server_process_generation_id,
        )
    }

    fn activation_receipt(
        &mut self,
        record: &TransactionRecord,
    ) -> Result<ActivationReceiptObservation> {
        read_activation_receipt(&record.controls)
    }

    fn request_activation_cancellation(
        &mut self,
        candidate: &CandidateEvidence,
        controls: &ControlPaths,
    ) -> Result<()> {
        publish_activation_cancellation(controls, &candidate.ready)
    }

    fn cancellation_receipt(
        &mut self,
        record: &TransactionRecord,
    ) -> Result<CancellationReceiptObservation> {
        read_cancellation_receipt(&record.controls)
    }

    fn verify_ordinary(&mut self, process: &ProcessIdentity) -> Result<()> {
        self.verify_running(process)?;
        let response = http_get(process.listener.port, "/api/health", None)?;
        if response.status != 200 {
            return Err(DeployError::Activation(format!(
                "ordinary health check returned {}",
                response.status
            )));
        }
        let root = http_get(process.listener.port, "/", None)?;
        if root.status != 200 {
            return Err(DeployError::Activation(format!(
                "ordinary client check returned {}",
                root.status
            )));
        }
        Ok(())
    }

    fn write_live(&mut self, receipt: &LiveReceipt) -> Result<()> {
        self.locked.write_live(receipt)
    }
}

pub fn execute_launch_helper(journal_path: &Path, attempt_id: &str) -> Result<()> {
    let journal = DurableTransactionJournal::new(journal_path)?;
    let record = journal
        .load()?
        .ok_or_else(|| DeployError::Journal("launch helper journal is missing".to_string()))?;
    let attempt = record
        .pending_launch_attempt()
        .filter(|attempt| attempt.attempt_id == attempt_id)
        .cloned()
        .ok_or_else(|| {
            DeployError::Journal(
                "launch helper attempt is not the exact pending journal attempt".to_string(),
            )
        })?;
    if !matches!(attempt.state, LaunchAttemptState::Unclaimed) {
        return Err(DeployError::Journal(
            "launch helper may claim only an unclaimed journal attempt".to_string(),
        ));
    }
    let spec = LaunchSpec::for_attempt(&record, &attempt)?;
    if std::env::current_dir()? != spec.generation_root {
        return Err(DeployError::Journal(
            "launch helper cwd is not the exact generation root".to_string(),
        ));
    }
    let executable_path = spec.generation_root.join("server/freshell-server");
    let executable = FileIdentity::from_path(&executable_path)?;
    let procfs = LinuxProcfs::default();
    let executor =
        procfs.launch_executor_identity(std::process::id(), executable, &spec.generation_root)?;
    let claim = LaunchClaim {
        schema_version: "1".to_string(),
        claim_id: Uuid::new_v4().to_string(),
        transaction_id: spec.transaction_id.clone(),
        nonce: spec.nonce.clone(),
        attempt_id: attempt.attempt_id.clone(),
        receipt_file: attempt.ready_file.clone(),
        lane: attempt.lane,
        generation_id: spec.generation_id.clone(),
        port: spec.port,
        executor,
    };
    let receipt_store = LaunchAttemptReceiptStore::new(&attempt.ready_file)?;
    let owned = receipt_store.claim(&claim)?;
    if owned
        != (LaunchAttemptReceipt::Owned {
            claim: claim.clone(),
        })
    {
        return Ok(());
    }
    let auth_token = std::env::var("FRESHELL_DEPLOY_AUTH_TOKEN")
        .map_err(|_| DeployError::Activation("launch helper AUTH_TOKEN is missing".to_string()))?;
    let checkout = record
        .port_root()?
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or_else(|| {
            DeployError::Activation("transaction store has no canonical checkout".to_string())
        })?;
    let external_environment = crate::production_env::production_environment(checkout)?;
    let mut command = Command::new(&executable_path);
    command
        .current_dir(&spec.generation_root)
        .env_clear()
        .envs(launch_environment(
            &spec,
            &attempt,
            &auth_token,
            external_environment,
        )?);
    let error = command.exec();
    receipt_store.mark_definitely_not_started(&claim)?;
    Err(DeployError::Activation(format!(
        "launch helper could not exec target: {error}"
    )))
}

fn launch_environment(
    spec: &LaunchSpec,
    attempt: &LaunchAttempt,
    auth_token: &str,
    mut environment: BTreeMap<OsString, OsString>,
) -> Result<BTreeMap<OsString, OsString>> {
    let node_parent = spec.node.executable.parent().ok_or_else(|| {
        DeployError::Activation("Node executable has no verified parent".to_string())
    })?;
    for (key, value) in [
        (OsString::from("AUTH_TOKEN"), OsString::from(auth_token)),
        (
            OsString::from("FRESHELL_CLAUDE_NODE"),
            spec.node.executable.as_os_str().to_owned(),
        ),
        (
            OsString::from("FRESHELL_CLAUDE_SIDECAR"),
            OsString::from(&spec.runtime.claude_sidecar_entry),
        ),
        (
            OsString::from("FRESHELL_CLIENT_DIR"),
            OsString::from(&spec.runtime.client_dir),
        ),
        (
            OsString::from("FRESHELL_DEPLOY_GENERATION_ID"),
            OsString::from(&spec.generation_id),
        ),
        (
            OsString::from("FRESHELL_DEPLOY_NONCE"),
            OsString::from(&spec.nonce),
        ),
        (
            OsString::from("FRESHELL_DEPLOY_READY_FILE"),
            server_ready_path(attempt)?.into_os_string(),
        ),
        (
            OsString::from("FRESHELL_EXTENSIONS_DIR"),
            OsString::from(&spec.runtime.extensions_dir),
        ),
        (
            OsString::from("FRESHELL_MCP_SERVER_ENTRY"),
            OsString::from(&spec.runtime.mcp_entry),
        ),
        (OsString::from("NODE_ENV"), OsString::from("production")),
        (
            OsString::from("PORT"),
            OsString::from(spec.port.to_string()),
        ),
    ] {
        environment.insert(key, value);
    }
    environment
        .entry(OsString::from("PATH"))
        .or_insert_with(|| node_parent.as_os_str().to_owned());
    if attempt.lane == LaunchLane::TargetGated {
        for (name, path) in [
            (
                "FRESHELL_DEPLOY_ACTIVATION_FILE",
                &spec.controls.authorization_file,
            ),
            (
                "FRESHELL_DEPLOY_ACTIVATED_FILE",
                &spec.controls.activated_file,
            ),
            (
                "FRESHELL_DEPLOY_CANCELLATION_FILE",
                &spec.controls.cancellation_file,
            ),
            (
                "FRESHELL_DEPLOY_CANCELLED_FILE",
                &spec.controls.cancelled_file,
            ),
        ] {
            environment.insert(OsString::from(name), path.as_os_str().to_owned());
        }
    }
    Ok(environment)
}

fn claim_matches_spec(claim: &LaunchClaim, spec: &LaunchSpec, attempt: &LaunchAttempt) -> bool {
    claim.schema_version == "1"
        && claim.transaction_id == spec.transaction_id
        && claim.nonce == spec.nonce
        && claim.attempt_id == attempt.attempt_id
        && claim.receipt_file == attempt.ready_file
        && claim.lane == attempt.lane
        && claim.generation_id == spec.generation_id
        && claim.port == spec.port
        && Path::new(&claim.executor.cwd) == spec.generation_root
        && claim.executor.effective_uid == unsafe { libc::geteuid() }
}

fn executor_matches_process(claim: &LaunchClaim, process: &ProcessIdentity) -> bool {
    claim.executor.pid == process.pid
        && claim.executor.kernel_boot_id == process.kernel_boot_id
        && claim.executor.start_time_ticks == process.start_time_ticks
        && claim.executor.executable == process.executable
        && claim.executor.cwd == process.cwd
        && claim.executor.effective_uid == process.effective_uid
}

fn server_ready_path(attempt: &LaunchAttempt) -> Result<PathBuf> {
    let parent = attempt
        .ready_file
        .parent()
        .ok_or_else(|| DeployError::Journal("launch receipt has no parent".to_string()))?;
    Ok(parent.join(format!("{}.server-ready.json", attempt.attempt_id)))
}

fn read_ready_receipt(path: &Path) -> Result<Option<DeploymentReadyReceipt>> {
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
        || metadata.mode() & 0o022 != 0
    {
        return Err(DeployError::Activation(
            "server ready receipt is not an owned protected regular file".to_string(),
        ));
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let receipt: DeploymentReadyReceipt = serde_json::from_slice(&bytes)
        .map_err(|error| DeployError::Activation(format!("invalid ready receipt: {error}")))?;
    receipt.validate()?;
    Ok(Some(receipt))
}

fn http_get(
    port: crate::paths::DeployPort,
    path: &str,
    auth_token: Option<&str>,
) -> Result<HttpResponse> {
    let address = SocketAddr::from(([127, 0, 0, 1], port.get()));
    bounded_http_get(
        address,
        &format!("127.0.0.1:{port}"),
        path,
        auth_token,
        HttpLimits::default(),
    )
    .map_err(|error| DeployError::Activation(format!("HTTP request failed: {error}")))
}

fn remove_probe_directory(path: &Path) -> Result<()> {
    if !path.starts_with(Path::new("/")) || path.file_name().is_none() || path == Path::new("/") {
        return Err(DeployError::UnsafeStorePath(path.to_path_buf()));
    }
    fs::remove_dir_all(path)?;
    Ok(())
}

pub(crate) fn runtime_from_bindings(
    root: &Path,
    bindings: &RuntimeBindings,
    node: &NodePrerequisite,
) -> RuntimeProvenance {
    RuntimeProvenance {
        client_dir: root.join(&bindings.client_dir).display().to_string(),
        extensions_dir: root.join(&bindings.extensions_dir).display().to_string(),
        dist_server_dir: root.join(&bindings.dist_server_dir).display().to_string(),
        mcp_entry: root.join(&bindings.mcp_entry).display().to_string(),
        claude_sidecar_entry: root
            .join(&bindings.claude_sidecar_entry)
            .display()
            .to_string(),
        node_executable: node.executable.display().to_string(),
        package_json: root.join(&bindings.package_json).display().to_string(),
        package_lock: root.join(&bindings.package_lock).display().to_string(),
        production_node_modules: root
            .join(&bindings.production_node_modules)
            .display()
            .to_string(),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::ffi::{OsStr, OsString};
    use std::path::PathBuf;

    use super::{distinct_expected_processes, launch_environment};
    use crate::activation::LaunchSpec;
    use crate::journal::{ControlPaths, LaunchAttempt, LaunchAttemptState, LaunchLane};
    use crate::legacy::NodePrerequisite;
    use crate::paths::DeployPort;
    use crate::process_identity::{
        FileIdentity, ListenerIdentity, ProcessIdentity, RuntimeProvenance,
    };

    fn identity(
        pid: u32,
        birth: &str,
        executable_inode: &str,
        socket_inode: &str,
    ) -> ProcessIdentity {
        ProcessIdentity {
            pid,
            kernel_boot_id: "11111111-2222-3333-4444-555555555555".to_string(),
            start_time_ticks: birth.to_string(),
            executable: FileIdentity {
                device: "2049".to_string(),
                inode: executable_inode.to_string(),
                sha256: "a".repeat(64),
                mode: 0o555,
            },
            listener: ListenerIdentity {
                port: DeployPort::new(43_127).unwrap(),
                socket_inode: socket_inode.to_string(),
                owner_pid: pid,
                network_namespace: "net:[4026533111]".to_string(),
            },
            cwd: "/tmp/generation".to_string(),
            argv0: "freshell-server".to_string(),
            argument_count: 1,
            effective_uid: unsafe { libc::geteuid() },
            runtime: RuntimeProvenance {
                client_dir: "/tmp/current/client".to_string(),
                extensions_dir: "/tmp/generation/extensions".to_string(),
                dist_server_dir: "/tmp/generation/dist/server".to_string(),
                mcp_entry: "/tmp/generation/dist/server/mcp/server.js".to_string(),
                claude_sidecar_entry: "/tmp/generation/sidecar/index.mjs".to_string(),
                node_executable: "/usr/bin/node".to_string(),
                package_json: "/tmp/generation/package.json".to_string(),
                package_lock: "/tmp/generation/package-lock.json".to_string(),
                production_node_modules: "/tmp/generation/node_modules".to_string(),
            },
        }
    }

    #[test]
    fn expected_processes_keep_same_pid_with_distinct_birth_and_listener_identity() {
        let stale = identity(41_337, "100", "200", "300");
        let reused = identity(41_337, "101", "201", "301");

        let distinct = distinct_expected_processes([&stale, &reused, &reused]);

        assert_eq!(distinct, vec![&stale, &reused]);
    }

    #[test]
    fn activation_launch_preserves_operator_bind_host_and_leaves_native_default_unset() {
        let root = PathBuf::from("/tmp/freshell-bind-host-test");
        let runtime_path = |name: &str| root.join(name).display().to_string();
        let spec = LaunchSpec {
            transaction_id: "transaction".to_string(),
            nonce: "nonce".to_string(),
            port: DeployPort::new(43_127).unwrap(),
            lane: LaunchLane::TargetRollForward,
            generation_id: "a".repeat(64),
            generation_root: root.clone(),
            runtime: RuntimeProvenance {
                client_dir: runtime_path("client"),
                extensions_dir: runtime_path("extensions"),
                dist_server_dir: runtime_path("dist/server"),
                mcp_entry: runtime_path("dist/server/mcp/server.js"),
                claude_sidecar_entry: runtime_path("sidecar/index.mjs"),
                node_executable: "/usr/bin/node".to_string(),
                package_json: runtime_path("package.json"),
                package_lock: runtime_path("package-lock.json"),
                production_node_modules: runtime_path("node_modules"),
            },
            node: NodePrerequisite {
                executable: PathBuf::from("/usr/bin/node"),
                version: "v22.0.0".to_string(),
            },
            controls: ControlPaths::new(root.join("controls")),
        };
        let attempt = LaunchAttempt {
            attempt_id: "target-0".to_string(),
            ready_file: root.join("controls/launch.json"),
            lane: LaunchLane::TargetRollForward,
            state: LaunchAttemptState::Unclaimed,
        };

        for host in ["127.0.0.1", "0.0.0.0"] {
            let environment = launch_environment(
                &spec,
                &attempt,
                "token",
                BTreeMap::from([(OsString::from("FRESHELL_BIND_HOST"), OsString::from(host))]),
            )
            .unwrap();
            assert_eq!(
                environment.get(OsStr::new("FRESHELL_BIND_HOST")),
                Some(&OsString::from(host))
            );
        }

        let environment = launch_environment(&spec, &attempt, "token", BTreeMap::new()).unwrap();
        assert!(
            !environment.contains_key(OsStr::new("FRESHELL_BIND_HOST")),
            "an absent operator override must leave bind selection to the server"
        );
    }
}

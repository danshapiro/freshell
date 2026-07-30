#![cfg(unix)]

mod support;

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use freshell_deploy::{
    publish_activation_authorization, read_activation_receipt, validate_client_only_entries,
    validate_compatibility_artifacts, ActivationController, ActivationDriver, ActivationProgress,
    ActivationReceiptObservation, ActivationRequest, CandidateEvidence, ControlPaths, DeployError,
    DeployPort, DurableTransactionJournal, EntryKind, FileIdentity, GenerationProbe,
    GenerationProbeRequest, LaunchAttempt, LaunchAttemptObservation, LaunchLane,
    LegacyCaptureReceipt, LiveReceipt, ManifestEntry, NodePrerequisite, NonSecretLaunchMetadata,
    PortState, ProbeBackend, ProbeCommand, ProbeCommandOutput, ProbeLaunch, RecoveryOutcome,
    Result, RuntimeBindings, RuntimeProvenance, ServiceState, Store, TransactionJournal,
    TransactionPhase, TransactionRecord, UpdateMode,
};

use support::{
    candidate, generation_root, process_identity, ready_receipt, FOREIGN_ID, NONCE, PRIOR_ID,
    TARGET_ID, TRANSACTION_ID,
};

#[derive(Default)]
struct MemoryJournal {
    record: Option<TransactionRecord>,
    phases: Vec<TransactionPhase>,
}

struct FailOnceJournal {
    inner: MemoryJournal,
    phase: TransactionPhase,
    failed: bool,
}

impl TransactionJournal for FailOnceJournal {
    fn load(&self) -> Result<Option<TransactionRecord>> {
        self.inner.load()
    }

    fn begin(&mut self, record: &TransactionRecord) -> Result<()> {
        self.inner.begin(record)
    }

    fn save(&mut self, record: &TransactionRecord) -> Result<()> {
        if !self.failed && record.phase == self.phase {
            self.failed = true;
            return Err(DeployError::Journal(
                "injected durable journal failure".to_string(),
            ));
        }
        self.inner.save(record)
    }
}

struct FailLaunchBindingJournal {
    inner: MemoryJournal,
    failed: bool,
}

impl TransactionJournal for FailLaunchBindingJournal {
    fn load(&self) -> Result<Option<TransactionRecord>> {
        self.inner.load()
    }

    fn begin(&mut self, record: &TransactionRecord) -> Result<()> {
        self.inner.begin(record)
    }

    fn save(&mut self, record: &TransactionRecord) -> Result<()> {
        let binds_pending = self
            .inner
            .record
            .as_ref()
            .and_then(|existing| existing.launch_attempts.last())
            .is_some_and(|attempt| {
                attempt.process_identity.is_none() && !attempt.definitely_not_started
            })
            && record.launch_attempts.last().is_some_and(|attempt| {
                attempt.process_identity.is_some() || attempt.definitely_not_started
            })
            && record
                .launch_attempts
                .last()
                .and_then(|attempt| attempt.process_identity.as_ref())
                .is_some();
        if !self.failed && binds_pending {
            self.failed = true;
            return Err(DeployError::Journal(
                "injected launch binding failure".to_string(),
            ));
        }
        self.inner.save(record)
    }
}

impl TransactionJournal for MemoryJournal {
    fn load(&self) -> Result<Option<TransactionRecord>> {
        Ok(self.record.clone().map(normalize_test_launch_history))
    }

    fn begin(&mut self, record: &TransactionRecord) -> Result<()> {
        if self.record.is_some() {
            return Err(DeployError::Journal(
                "active transaction exists".to_string(),
            ));
        }
        self.phases.push(record.phase);
        self.record = Some(record.clone());
        Ok(())
    }

    fn save(&mut self, record: &TransactionRecord) -> Result<()> {
        self.phases.push(record.phase);
        self.record = Some(record.clone());
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Event {
    Preflight,
    ProbeTarget,
    ProbePrior,
    VerifyRunning(u32),
    VerifyExited(u32),
    Stop(u32),
    StartGated(String),
    StartOrdinary(String),
    Switch(String, String),
    Authorize,
    VerifyOrdinary(u32),
    WriteLive(String, String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DriverOperation {
    Preflight,
    ProbeTarget,
    ProbePrior,
    Stop,
    StartGated,
    StartOrdinary,
    Switch,
    Authorize,
    WriteLive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FailureTiming {
    Before,
    After,
}

struct FakeDriver {
    prior: freshell_deploy::ProcessIdentity,
    target: CandidateEvidence,
    selected: String,
    state: PortState,
    receipt: ActivationReceiptObservation,
    cancellation_receipt: ActivationReceiptObservation,
    live: LiveReceipt,
    events: Vec<Event>,
    authorize_activates: bool,
    authorization_completes_during_cancellation: bool,
    relaunch_with_new_identity: bool,
    relaunch_sequence: u32,
    selected_reads: usize,
    steal_pointer_after_reads: Option<usize>,
    steal_pointer_after_switch: bool,
    steal_pointer_after_write_live: bool,
    fail_once: Option<(DriverOperation, FailureTiming)>,
    off_port_processes: Vec<freshell_deploy::ProcessIdentity>,
    stop_leaves_process_draining: bool,
    cancellation_delay_polls: usize,
    cancellation_requested: bool,
    cancellation_leaves_process_draining: bool,
    cancellation_publishes_both: bool,
    attempt_receipts: BTreeMap<String, LaunchAttemptObservation>,
}

impl FakeDriver {
    fn server(port: u16) -> Self {
        let prior = process_identity(PRIOR_ID, 5101, port);
        let target = candidate(TARGET_ID, 5102, port);
        Self {
            prior: prior.clone(),
            target: target.clone(),
            selected: PRIOR_ID.to_string(),
            state: PortState::Prior {
                process: prior.clone(),
                service: ServiceState::Ordinary,
            },
            receipt: ActivationReceiptObservation::Absent,
            cancellation_receipt: ActivationReceiptObservation::Absent,
            live: LiveReceipt::new(
                PRIOR_ID.to_string(),
                Some(PRIOR_ID.to_string()),
                false,
                Some(prior),
            ),
            events: Vec::new(),
            authorize_activates: true,
            authorization_completes_during_cancellation: false,
            relaunch_with_new_identity: false,
            relaunch_sequence: 0,
            selected_reads: 0,
            steal_pointer_after_reads: None,
            steal_pointer_after_switch: false,
            steal_pointer_after_write_live: false,
            fail_once: None,
            off_port_processes: Vec::new(),
            stop_leaves_process_draining: false,
            cancellation_delay_polls: 0,
            cancellation_requested: false,
            cancellation_leaves_process_draining: false,
            cancellation_publishes_both: false,
            attempt_receipts: BTreeMap::new(),
        }
    }

    fn target_gated(&mut self) {
        self.state = PortState::Target {
            candidate: self.target.clone(),
            service: ServiceState::Gated,
        };
    }

    fn target_ordinary_with_receipt(&mut self) {
        self.state = PortState::Target {
            candidate: self.target.clone(),
            service: ServiceState::Ordinary,
        };
        self.receipt = ActivationReceiptObservation::Present(self.target.ready.clone());
    }

    fn maybe_fail(&mut self, operation: DriverOperation, timing: FailureTiming) -> Result<()> {
        if self.fail_once == Some((operation, timing)) {
            self.fail_once = None;
            return Err(DeployError::Activation(format!(
                "injected {timing:?} {operation:?} IO failure"
            )));
        }
        Ok(())
    }
}

impl ActivationDriver for FakeDriver {
    fn preflight(&mut self, _request: &ActivationRequest) -> Result<()> {
        self.maybe_fail(DriverOperation::Preflight, FailureTiming::Before)?;
        self.events.push(Event::Preflight);
        self.maybe_fail(DriverOperation::Preflight, FailureTiming::After)
    }

    fn probe_target(&mut self, root: &Path, id: &str) -> Result<()> {
        self.maybe_fail(DriverOperation::ProbeTarget, FailureTiming::Before)?;
        assert_eq!(root, generation_root(self.prior.listener.port.get(), id));
        self.events.push(Event::ProbeTarget);
        self.maybe_fail(DriverOperation::ProbeTarget, FailureTiming::After)
    }

    fn probe_prior(&mut self, root: &Path, id: &str) -> Result<()> {
        self.maybe_fail(DriverOperation::ProbePrior, FailureTiming::Before)?;
        assert_eq!(root, generation_root(self.prior.listener.port.get(), id));
        self.events.push(Event::ProbePrior);
        self.maybe_fail(DriverOperation::ProbePrior, FailureTiming::After)
    }

    fn verify_running(&mut self, process: &freshell_deploy::ProcessIdentity) -> Result<()> {
        let observed = match &self.state {
            PortState::Prior {
                process: observed, ..
            } => Some(observed),
            PortState::Target {
                candidate: observed,
                ..
            } => Some(&observed.process),
            PortState::TargetRelaunch { process: observed } => Some(observed),
            PortState::Free | PortState::Foreign => None,
        };
        if observed != Some(process) {
            return Err(DeployError::Activation(
                "running process identity changed".to_string(),
            ));
        }
        self.events.push(Event::VerifyRunning(process.pid));
        Ok(())
    }

    fn verify_exited(&mut self, process: &freshell_deploy::ProcessIdentity) -> Result<()> {
        let still_running = match &self.state {
            PortState::Prior {
                process: observed, ..
            }
            | PortState::TargetRelaunch { process: observed } => observed == process,
            PortState::Target {
                candidate: observed,
                ..
            } => &observed.process == process,
            PortState::Free | PortState::Foreign => self
                .off_port_processes
                .iter()
                .any(|observed| observed == process),
        };
        if still_running {
            return Err(DeployError::Activation(
                "process expected exited is still live".to_string(),
            ));
        }
        self.events.push(Event::VerifyExited(process.pid));
        Ok(())
    }

    fn observe_port(&mut self, _record: &TransactionRecord) -> Result<PortState> {
        Ok(self.state.clone())
    }

    fn observe_launch_attempt(
        &mut self,
        attempt: &LaunchAttempt,
        _record: &TransactionRecord,
    ) -> Result<LaunchAttemptObservation> {
        Ok(self
            .attempt_receipts
            .get(&attempt.attempt_id)
            .cloned()
            .unwrap_or(LaunchAttemptObservation::Absent))
    }

    fn stop(&mut self, process: &freshell_deploy::ProcessIdentity) -> Result<()> {
        self.maybe_fail(DriverOperation::Stop, FailureTiming::Before)?;
        let observed = match &self.state {
            PortState::Prior { process, .. } => process,
            PortState::Target { candidate, .. } => &candidate.process,
            _ => {
                return Err(DeployError::Activation(
                    "cannot stop an unproven process".to_string(),
                ))
            }
        };
        if observed != process {
            return Err(DeployError::Activation(
                "stop identity mismatch".to_string(),
            ));
        }
        self.events.push(Event::Stop(process.pid));
        if self.stop_leaves_process_draining {
            self.off_port_processes.push(process.clone());
        }
        self.state = PortState::Free;
        self.maybe_fail(DriverOperation::Stop, FailureTiming::After)
    }

    fn start_gated(
        &mut self,
        root: &Path,
        generation_id: &str,
        runtime: &RuntimeProvenance,
        node: &NodePrerequisite,
        _controls: &ControlPaths,
        attempt: &LaunchAttempt,
    ) -> Result<CandidateEvidence> {
        if self.fail_once == Some((DriverOperation::StartGated, FailureTiming::Before)) {
            self.attempt_receipts.insert(
                attempt.attempt_id.clone(),
                LaunchAttemptObservation::DefinitelyNotStarted,
            );
        }
        self.maybe_fail(DriverOperation::StartGated, FailureTiming::Before)?;
        assert_eq!(
            root,
            generation_root(self.prior.listener.port.get(), generation_id)
        );
        assert_eq!(
            self.target.ready.server_process_generation_id,
            generation_id
        );
        assert_eq!(runtime, &self.target.process.runtime);
        assert_eq!(node.executable, Path::new("/usr/bin/node"));
        assert_eq!(node.version, "v22.0.0");
        self.events
            .push(Event::StartGated(root.display().to_string()));
        self.target_gated();
        self.attempt_receipts.insert(
            attempt.attempt_id.clone(),
            LaunchAttemptObservation::Gated(self.target.clone()),
        );
        self.maybe_fail(DriverOperation::StartGated, FailureTiming::After)?;
        Ok(self.target.clone())
    }

    fn start_ordinary(
        &mut self,
        generation_root: &Path,
        generation_id: &str,
        runtime: &RuntimeProvenance,
        node: &NodePrerequisite,
        attempt: &LaunchAttempt,
    ) -> Result<freshell_deploy::ProcessIdentity> {
        if !self.off_port_processes.is_empty() {
            return Err(DeployError::Activation(
                "cannot relaunch while an owned predecessor is draining off-port".to_string(),
            ));
        }
        if self.fail_once == Some((DriverOperation::StartOrdinary, FailureTiming::Before)) {
            self.attempt_receipts.insert(
                attempt.attempt_id.clone(),
                LaunchAttemptObservation::DefinitelyNotStarted,
            );
        }
        self.maybe_fail(DriverOperation::StartOrdinary, FailureTiming::Before)?;
        assert_eq!(
            generation_root,
            support::generation_root(self.prior.listener.port.get(), generation_id),
            "every relaunch cwd must be the immutable generation root"
        );
        assert_eq!(
            node.executable,
            Path::new("/usr/bin/node"),
            "ordinary relaunch rechecks the durably verified Node prerequisite"
        );
        assert_eq!(node.version, "v22.0.0");
        self.events
            .push(Event::StartOrdinary(generation_root.display().to_string()));
        let target_id = self.target.ready.server_process_generation_id.as_str();
        let mut process = if generation_id == target_id {
            self.target.process.clone()
        } else {
            self.prior.clone()
        };
        assert_eq!(
            runtime, &process.runtime,
            "ordinary relaunch receives the exact persisted runtime bindings"
        );
        if self.relaunch_with_new_identity {
            self.relaunch_sequence += 1;
            let offset = self.relaunch_sequence * 1_000;
            process = relaunched_identity(process, offset);
        }
        self.state = if generation_id == target_id {
            PortState::TargetRelaunch {
                process: process.clone(),
            }
        } else {
            PortState::Prior {
                process: process.clone(),
                service: ServiceState::Ordinary,
            }
        };
        self.attempt_receipts.insert(
            attempt.attempt_id.clone(),
            LaunchAttemptObservation::Ordinary(process.clone()),
        );
        self.maybe_fail(DriverOperation::StartOrdinary, FailureTiming::After)?;
        Ok(process)
    }

    fn selected_generation(&mut self) -> Result<String> {
        let selected = self.selected.clone();
        self.selected_reads += 1;
        if self.steal_pointer_after_reads == Some(self.selected_reads) {
            self.selected = FOREIGN_ID.to_string();
        }
        Ok(selected)
    }

    fn switch_generation(&mut self, expected: &str, target: &str) -> Result<()> {
        self.maybe_fail(DriverOperation::Switch, FailureTiming::Before)?;
        if self.selected != expected {
            return Err(DeployError::Activation(
                "current pointer changed".to_string(),
            ));
        }
        self.events
            .push(Event::Switch(expected.to_string(), target.to_string()));
        self.selected = target.to_string();
        if self.steal_pointer_after_switch {
            self.selected = FOREIGN_ID.to_string();
        }
        self.maybe_fail(DriverOperation::Switch, FailureTiming::After)
    }

    fn authorize(
        &mut self,
        _candidate: &CandidateEvidence,
        _controls: &ControlPaths,
    ) -> Result<()> {
        self.maybe_fail(DriverOperation::Authorize, FailureTiming::Before)?;
        self.events.push(Event::Authorize);
        if self.authorize_activates {
            self.target_ordinary_with_receipt();
        }
        self.maybe_fail(DriverOperation::Authorize, FailureTiming::After)
    }

    fn activation_receipt(
        &mut self,
        _record: &TransactionRecord,
    ) -> Result<ActivationReceiptObservation> {
        Ok(self.receipt.clone())
    }

    fn request_activation_cancellation(
        &mut self,
        _candidate: &CandidateEvidence,
        _controls: &ControlPaths,
    ) -> Result<()> {
        self.cancellation_requested = true;
        if self.authorization_completes_during_cancellation {
            self.target_ordinary_with_receipt();
        } else if self.cancellation_delay_polls == 0 {
            self.cancellation_receipt =
                ActivationReceiptObservation::Present(self.target.ready.clone());
            if self.cancellation_publishes_both {
                self.receipt = ActivationReceiptObservation::Present(self.target.ready.clone());
            }
            if self.cancellation_leaves_process_draining {
                self.off_port_processes.push(self.target.process.clone());
            }
            self.state = PortState::Free;
        }
        Ok(())
    }

    fn cancellation_receipt(
        &mut self,
        _record: &TransactionRecord,
    ) -> Result<ActivationReceiptObservation> {
        if self.cancellation_requested && self.cancellation_delay_polls > 0 {
            self.cancellation_delay_polls -= 1;
            if self.cancellation_delay_polls == 0 {
                self.cancellation_receipt =
                    ActivationReceiptObservation::Present(self.target.ready.clone());
                self.state = PortState::Free;
            }
        }
        Ok(self.cancellation_receipt.clone())
    }

    fn verify_ordinary(&mut self, process: &freshell_deploy::ProcessIdentity) -> Result<()> {
        match &self.state {
            PortState::Prior {
                process: actual,
                service: ServiceState::Ordinary,
            } if actual == process => {}
            PortState::Target {
                candidate,
                service: ServiceState::Ordinary,
            } if &candidate.process == process => {}
            PortState::TargetRelaunch { process: actual } if actual == process => {}
            _ => {
                return Err(DeployError::Activation(
                    "ordinary service is not proven".to_string(),
                ))
            }
        }
        self.events.push(Event::VerifyOrdinary(process.pid));
        Ok(())
    }

    fn write_live(&mut self, receipt: &LiveReceipt) -> Result<()> {
        self.maybe_fail(DriverOperation::WriteLive, FailureTiming::Before)?;
        self.events.push(Event::WriteLive(
            receipt.selected_generation_id.clone(),
            receipt
                .running_server_generation_id
                .clone()
                .unwrap_or_default(),
        ));
        self.live = receipt.clone();
        if self.steal_pointer_after_write_live {
            self.selected = FOREIGN_ID.to_string();
        }
        self.maybe_fail(DriverOperation::WriteLive, FailureTiming::After)
    }
}

fn request(mode: UpdateMode, port: u16) -> ActivationRequest {
    let prior = process_identity(PRIOR_ID, 5101, port);
    let target = process_identity(TARGET_ID, 5102, port);
    let mut prior_runtime = prior.runtime.clone();
    prior_runtime.client_dir = generation_root(port, PRIOR_ID)
        .join("client")
        .display()
        .to_string();
    let mut target_runtime = target.runtime.clone();
    target_runtime.client_dir = generation_root(port, TARGET_ID)
        .join("client")
        .display()
        .to_string();
    ActivationRequest {
        transaction_id: TRANSACTION_ID.to_string(),
        nonce: NONCE.to_string(),
        port: DeployPort::new(port).unwrap(),
        mode,
        prior_generation_id: PRIOR_ID.to_string(),
        target_generation_id: TARGET_ID.to_string(),
        prior_generation_root: generation_root(port, PRIOR_ID),
        target_generation_root: generation_root(port, TARGET_ID),
        prior_server_executable: prior.executable.clone(),
        target_server_executable: target.executable,
        prior_runtime,
        target_runtime,
        prior_node: NodePrerequisite {
            executable: PathBuf::from("/usr/bin/node"),
            version: "v22.0.0".to_string(),
        },
        target_node: NodePrerequisite {
            executable: PathBuf::from("/usr/bin/node"),
            version: "v22.0.0".to_string(),
        },
        prior_live: LiveReceipt::new(
            PRIOR_ID.to_string(),
            Some(PRIOR_ID.to_string()),
            false,
            Some(prior),
        ),
        controls: ControlPaths::new(
            Path::new("/private/checkout/.freshell-deploy/ports")
                .join(port.to_string())
                .join("transactions")
                .join(TRANSACTION_ID),
        ),
    }
}

fn dual_identity_request(
    mode: UpdateMode,
    port: u16,
    selected_prior_id: &str,
    target_id: &str,
    running: freshell_deploy::ProcessIdentity,
) -> ActivationRequest {
    let selected_prior = process_identity(selected_prior_id, 5101, port);
    let target = process_identity(target_id, 5102, port);
    let mut prior_runtime = selected_prior.runtime.clone();
    prior_runtime.client_dir = generation_root(port, selected_prior_id)
        .join("client")
        .display()
        .to_string();
    let mut target_runtime = target.runtime.clone();
    target_runtime.client_dir = generation_root(port, target_id)
        .join("client")
        .display()
        .to_string();
    ActivationRequest {
        transaction_id: TRANSACTION_ID.to_string(),
        nonce: NONCE.to_string(),
        port: DeployPort::new(port).unwrap(),
        mode,
        prior_generation_id: selected_prior_id.to_string(),
        target_generation_id: target_id.to_string(),
        prior_generation_root: generation_root(port, selected_prior_id),
        target_generation_root: generation_root(port, target_id),
        prior_server_executable: selected_prior.executable,
        target_server_executable: target.executable,
        prior_runtime,
        target_runtime,
        prior_node: NodePrerequisite {
            executable: PathBuf::from("/usr/bin/node"),
            version: "v22.0.0".to_string(),
        },
        target_node: NodePrerequisite {
            executable: PathBuf::from("/usr/bin/node"),
            version: "v22.0.0".to_string(),
        },
        prior_live: LiveReceipt::new(
            selected_prior_id.to_string(),
            Some(PRIOR_ID.to_string()),
            false,
            Some(running),
        ),
        controls: ControlPaths::new(
            Path::new("/private/checkout/.freshell-deploy/ports")
                .join(port.to_string())
                .join("transactions")
                .join(TRANSACTION_ID),
        ),
    }
}

fn prepared_record(mode: UpdateMode, port: u16) -> TransactionRecord {
    TransactionRecord::prepared(&request(mode, port)).unwrap()
}

fn seed_bound_relaunch(
    record: &mut TransactionRecord,
    lane: LaunchLane,
    process: freshell_deploy::ProcessIdentity,
) {
    let index = record.launch_attempts.len();
    let lane_name = match lane {
        LaunchLane::PriorRollback => "prior-rollback",
        LaunchLane::TargetRollForward => "target-roll-forward",
        LaunchLane::TargetGated => panic!("relaunch helper requires an ordinary lane"),
    };
    let attempt_id = format!("{lane_name}-{index}");
    record.launch_attempts.push(LaunchAttempt {
        ready_file: record
            .controls
            .directory
            .join(format!("launch-{attempt_id}.json")),
        attempt_id,
        lane,
        process_identity: Some(process.clone()),
        definitely_not_started: false,
    });
    record.relaunch_attempts.push(process);
}

fn normalize_test_launch_history(mut record: TransactionRecord) -> TransactionRecord {
    if record.launch_protocol_version.is_none() || record.candidate.is_none() {
        return record;
    }
    let has_bound_gated = record.launch_attempts.iter().any(|attempt| {
        attempt.lane == LaunchLane::TargetGated && attempt.process_identity.is_some()
    });
    if !has_bound_gated {
        let candidate = record.candidate.as_ref().unwrap();
        record.launch_attempts.insert(
            0,
            LaunchAttempt {
                attempt_id: String::new(),
                ready_file: PathBuf::new(),
                lane: LaunchLane::TargetGated,
                process_identity: Some(candidate.process.clone()),
                definitely_not_started: false,
            },
        );
        reindex_test_attempts(&mut record);
    }
    record
}

fn reindex_test_attempts(record: &mut TransactionRecord) {
    for (index, attempt) in record.launch_attempts.iter_mut().enumerate() {
        let lane_name = match attempt.lane {
            LaunchLane::TargetGated => "target-gated",
            LaunchLane::PriorRollback => "prior-rollback",
            LaunchLane::TargetRollForward => "target-roll-forward",
        };
        attempt.attempt_id = format!("{lane_name}-{index}");
        attempt.ready_file = record
            .controls
            .directory
            .join(format!("launch-{}.json", attempt.attempt_id));
    }
}

fn relaunched_identity(
    mut process: freshell_deploy::ProcessIdentity,
    offset: u32,
) -> freshell_deploy::ProcessIdentity {
    process.pid += offset;
    process.start_time_ticks = format!("{}0", process.start_time_ticks);
    process.listener.owner_pid = process.pid;
    process.listener.socket_inode = format!("{}0", process.listener.socket_inode);
    process
}

fn relocate_runtime(runtime: &mut RuntimeProvenance, root: &Path) {
    runtime.client_dir = root.join("client").display().to_string();
    runtime.extensions_dir = root.join("extensions").display().to_string();
    runtime.dist_server_dir = root.join("dist/server").display().to_string();
    runtime.mcp_entry = root.join("dist/server/mcp/server.js").display().to_string();
    runtime.claude_sidecar_entry = root.join("claude-sidecar/index.mjs").display().to_string();
    runtime.package_json = root.join("package.json").display().to_string();
    runtime.package_lock = root.join("package-lock.json").display().to_string();
    runtime.production_node_modules = root.join("node_modules").display().to_string();
}

fn relocate_record(record: &mut TransactionRecord, checkout_root: &Path) {
    let port_root = checkout_root
        .join(".freshell-deploy/ports")
        .join(record.port.to_string());
    record.prior_generation_root = port_root
        .join("generations")
        .join(&record.prior_generation_id);
    record.target_generation_root = port_root
        .join("generations")
        .join(&record.target_generation_id);
    relocate_runtime(&mut record.prior_runtime, &record.prior_generation_root);
    relocate_runtime(&mut record.target_runtime, &record.target_generation_root);
    let prior_process = record.prior_live.process_identity.as_mut().unwrap();
    prior_process.cwd = record.prior_generation_root.display().to_string();
    relocate_runtime(&mut prior_process.runtime, &record.prior_generation_root);
    prior_process.runtime.client_dir = port_root.join("current/client").display().to_string();
    if let Some(candidate) = record.candidate.as_mut() {
        candidate.process.cwd = record.target_generation_root.display().to_string();
        relocate_runtime(
            &mut candidate.process.runtime,
            &record.target_generation_root,
        );
        candidate.process.runtime.client_dir =
            port_root.join("current/client").display().to_string();
    }
    record.controls =
        ControlPaths::new(port_root.join("transactions").join(&record.transaction_id));
}

fn relocate_request(request: &mut ActivationRequest, checkout_root: &Path) {
    let port_root = checkout_root
        .join(".freshell-deploy/ports")
        .join(request.port.to_string());
    request.prior_generation_root = port_root
        .join("generations")
        .join(&request.prior_generation_id);
    request.target_generation_root = port_root
        .join("generations")
        .join(&request.target_generation_id);
    relocate_runtime(&mut request.prior_runtime, &request.prior_generation_root);
    relocate_runtime(&mut request.target_runtime, &request.target_generation_root);
    let prior_process = request.prior_live.process_identity.as_mut().unwrap();
    prior_process.cwd = request.prior_generation_root.display().to_string();
    relocate_runtime(&mut prior_process.runtime, &request.prior_generation_root);
    prior_process.runtime.client_dir = port_root.join("current/client").display().to_string();
}

fn create_private_transaction_directories(record: &TransactionRecord) {
    use std::os::unix::fs::PermissionsExt;

    let port_root = record
        .prior_generation_root
        .parent()
        .and_then(Path::parent)
        .unwrap();
    let ports = port_root.parent().unwrap();
    let deploy_root = ports.parent().unwrap();
    std::fs::create_dir_all(&record.controls.directory).unwrap();
    let transactions = port_root.join("transactions");
    for path in [
        deploy_root,
        ports,
        port_root,
        transactions.as_path(),
        record.controls.directory.as_path(),
    ] {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
}

fn step(journal: &mut MemoryJournal, driver: &mut FakeDriver) -> ActivationProgress {
    ActivationController::new(journal, driver).step().unwrap()
}

#[test]
fn preparation_finishes_all_preflight_before_the_first_durable_phase() {
    let mut journal = MemoryJournal::default();
    let mut driver = FakeDriver::server(3511);

    ActivationController::new(&mut journal, &mut driver)
        .begin(request(UpdateMode::Full, 3511))
        .unwrap();

    assert_eq!(journal.phases, vec![TransactionPhase::Prepared]);
    assert_eq!(
        driver.events,
        vec![Event::Preflight, Event::ProbeTarget, Event::ProbePrior]
    );
    assert_eq!(driver.selected, PRIOR_ID);
    assert!(matches!(driver.state, PortState::Prior { .. }));
}

#[test]
fn preparation_io_failures_never_publish_or_mutate_a_transaction() {
    for operation in [
        DriverOperation::Preflight,
        DriverOperation::ProbeTarget,
        DriverOperation::ProbePrior,
    ] {
        for timing in [FailureTiming::Before, FailureTiming::After] {
            let mut journal = MemoryJournal::default();
            let mut driver = FakeDriver::server(3558);
            driver.fail_once = Some((operation, timing));

            assert!(
                ActivationController::new(&mut journal, &mut driver)
                    .begin(request(UpdateMode::Full, 3558))
                    .is_err(),
                "{timing:?} {operation:?} failure must abort preparation"
            );
            assert!(journal.record.is_none());
            assert!(driver.events.iter().all(|event| !matches!(
                event,
                Event::Stop(_)
                    | Event::StartGated(_)
                    | Event::StartOrdinary(_)
                    | Event::Switch(_, _)
                    | Event::Authorize
                    | Event::WriteLive(_, _)
            )));
        }
    }
}

#[test]
fn last_chance_prior_probe_failure_never_interrupts_the_live_server() {
    for timing in [FailureTiming::Before, FailureTiming::After] {
        let mut record = prepared_record(UpdateMode::Full, 3562);
        record.phase = TransactionPhase::StopOldIntent;
        let mut journal = MemoryJournal {
            record: Some(record),
            phases: Vec::new(),
        };
        let mut driver = FakeDriver::server(3562);
        driver.fail_once = Some((DriverOperation::ProbePrior, timing));

        assert!(
            ActivationController::new(&mut journal, &mut driver)
                .run_with_timeout(Duration::from_secs(1))
                .is_err(),
            "{timing:?} last-chance prior probe failure returns the deployment failure"
        );
        assert!(
            driver
                .events
                .iter()
                .all(|event| !matches!(event, Event::Stop(_))),
            "the prior process must remain untouched when its immediate restartability probe fails"
        );
        assert!(matches!(driver.state, PortState::Prior { .. }));
        assert_eq!(
            journal.record.as_ref().unwrap().phase,
            TransactionPhase::RollbackComplete
        );
    }
}

#[test]
fn io_errors_before_and_after_each_live_side_effect_reconcile_by_durable_authority() {
    #[derive(Clone, Copy)]
    enum Case {
        StopPrior,
        StartGated,
        SwitchCurrent,
        Authorize,
        ConfirmedStart,
        CommittedWrite,
    }

    for case in [
        Case::StopPrior,
        Case::StartGated,
        Case::SwitchCurrent,
        Case::Authorize,
        Case::ConfirmedStart,
        Case::CommittedWrite,
    ] {
        for timing in [FailureTiming::Before, FailureTiming::After] {
            let mut record = prepared_record(UpdateMode::Full, 3559);
            let mut driver = FakeDriver::server(3559);
            let (operation, committed) = match case {
                Case::StopPrior => {
                    record.phase = TransactionPhase::StopOldIntent;
                    (DriverOperation::Stop, false)
                }
                Case::StartGated => {
                    record.phase = TransactionPhase::StartTargetIntent;
                    driver.state = PortState::Free;
                    (DriverOperation::StartGated, false)
                }
                Case::SwitchCurrent => {
                    record.phase = TransactionPhase::SwitchCurrentIntent;
                    record.candidate = Some(candidate(TARGET_ID, 5102, 3559));
                    driver.target_gated();
                    (DriverOperation::Switch, false)
                }
                Case::Authorize => {
                    record.phase = TransactionPhase::ActivationAuthorized;
                    record.candidate = Some(candidate(TARGET_ID, 5102, 3559));
                    driver.selected = TARGET_ID.to_string();
                    driver.target_gated();
                    (DriverOperation::Authorize, timing == FailureTiming::After)
                }
                Case::ConfirmedStart => {
                    record.phase = TransactionPhase::ActivationConfirmed;
                    record.candidate = Some(candidate(TARGET_ID, 5102, 3559));
                    driver.selected = TARGET_ID.to_string();
                    driver.state = PortState::Free;
                    (DriverOperation::StartOrdinary, true)
                }
                Case::CommittedWrite => {
                    record.phase = TransactionPhase::ActivationConfirmed;
                    record.candidate = Some(candidate(TARGET_ID, 5102, 3559));
                    driver.selected = TARGET_ID.to_string();
                    driver.target_ordinary_with_receipt();
                    (DriverOperation::WriteLive, true)
                }
            };
            driver.fail_once = Some((operation, timing));
            let mut journal = MemoryJournal {
                record: Some(record),
                phases: Vec::new(),
            };

            let result = ActivationController::new(&mut journal, &mut driver)
                .run_with_timeout(Duration::from_secs(1));

            if committed {
                assert_eq!(
                    result.unwrap(),
                    ActivationProgress::Complete,
                    "{timing:?} {operation:?} error after commit must reconcile forward"
                );
                assert_eq!(driver.selected, TARGET_ID);
                assert_eq!(
                    journal.record.as_ref().unwrap().phase,
                    TransactionPhase::ActivationConfirmed
                );
                assert!(journal.record.as_ref().unwrap().finalized);
            } else {
                assert!(
                    result.is_err(),
                    "{timing:?} {operation:?} error before commit returns the original failure"
                );
                assert_eq!(driver.selected, PRIOR_ID);
                assert_eq!(
                    journal.record.as_ref().unwrap().phase,
                    TransactionPhase::RollbackComplete
                );
                assert!(journal.record.as_ref().unwrap().finalized);
            }
        }
    }
}

#[test]
fn client_io_errors_reconcile_around_the_pointer_commit_boundary() {
    for timing in [FailureTiming::Before, FailureTiming::After] {
        let mut record = prepared_record(UpdateMode::ClientOnly, 3560);
        record.phase = TransactionPhase::SwitchCurrentIntent;
        let mut journal = MemoryJournal {
            record: Some(record),
            phases: Vec::new(),
        };
        let mut driver = FakeDriver::server(3560);
        driver.fail_once = Some((DriverOperation::Switch, timing));

        let result = ActivationController::new(&mut journal, &mut driver)
            .run_with_timeout(Duration::from_secs(1));

        if timing == FailureTiming::Before {
            assert!(result.is_err());
            assert_eq!(driver.selected, PRIOR_ID);
            assert_eq!(
                journal.record.as_ref().unwrap().phase,
                TransactionPhase::RollbackComplete
            );
        } else {
            assert_eq!(result.unwrap(), ActivationProgress::Complete);
            assert_eq!(driver.selected, TARGET_ID);
            assert_eq!(
                journal.record.as_ref().unwrap().phase,
                TransactionPhase::ActivationConfirmed
            );
            assert!(journal.record.as_ref().unwrap().finalized);
        }
    }

    for timing in [FailureTiming::Before, FailureTiming::After] {
        let mut record = prepared_record(UpdateMode::ClientOnly, 3561);
        record.phase = TransactionPhase::Activated;
        let mut journal = MemoryJournal {
            record: Some(record),
            phases: Vec::new(),
        };
        let mut driver = FakeDriver::server(3561);
        driver.selected = TARGET_ID.to_string();
        driver.fail_once = Some((DriverOperation::WriteLive, timing));

        assert_eq!(
            ActivationController::new(&mut journal, &mut driver)
                .run_with_timeout(Duration::from_secs(1))
                .unwrap(),
            ActivationProgress::Complete,
            "{timing:?} client live-receipt error after pointer commit must reconcile forward"
        );
        assert_eq!(
            journal.record.as_ref().unwrap().phase,
            TransactionPhase::ActivationConfirmed
        );
        assert!(journal.record.as_ref().unwrap().finalized);
    }
}

#[test]
fn restart_failures_retain_active_recovery_state_until_a_safe_retry() {
    for timing in [FailureTiming::Before, FailureTiming::After] {
        let mut rollback_record = prepared_record(UpdateMode::Full, 3563);
        rollback_record.phase = TransactionPhase::StartTargetIntent;
        let mut rollback_journal = MemoryJournal {
            record: Some(rollback_record),
            phases: Vec::new(),
        };
        let mut rollback_driver = FakeDriver::server(3563);
        rollback_driver.state = PortState::Free;
        rollback_driver.relaunch_with_new_identity = true;
        rollback_driver.fail_once = Some((DriverOperation::StartOrdinary, timing));

        assert!(
            ActivationController::new(&mut rollback_journal, &mut rollback_driver)
                .recover()
                .is_err(),
            "{timing:?} prior restart failure must surface"
        );
        assert_eq!(
            rollback_journal.record.as_ref().unwrap().phase,
            TransactionPhase::StartTargetIntent
        );
        assert!(!rollback_journal.record.as_ref().unwrap().finalized);
        assert_eq!(
            ActivationController::new(&mut rollback_journal, &mut rollback_driver)
                .recover()
                .unwrap(),
            RecoveryOutcome::RolledBack
        );

        let mut forward_record = prepared_record(UpdateMode::Full, 3564);
        forward_record.phase = TransactionPhase::ActivationConfirmed;
        forward_record.candidate = Some(candidate(TARGET_ID, 5102, 3564));
        let mut forward_journal = MemoryJournal {
            record: Some(forward_record),
            phases: Vec::new(),
        };
        let mut forward_driver = FakeDriver::server(3564);
        forward_driver.selected = TARGET_ID.to_string();
        forward_driver.state = PortState::Free;
        forward_driver.relaunch_with_new_identity = true;
        forward_driver.fail_once = Some((DriverOperation::StartOrdinary, timing));

        assert!(
            ActivationController::new(&mut forward_journal, &mut forward_driver)
                .recover()
                .is_err(),
            "{timing:?} committed-target restart failure must surface"
        );
        assert_eq!(
            forward_journal.record.as_ref().unwrap().phase,
            TransactionPhase::ActivationConfirmed
        );
        assert!(!forward_journal.record.as_ref().unwrap().finalized);
        assert_eq!(
            ActivationController::new(&mut forward_journal, &mut forward_driver)
                .recover()
                .unwrap(),
            RecoveryOutcome::Activated
        );
    }
}

#[test]
fn server_activation_keeps_the_candidate_gated_until_target_receipt_publication() {
    let mut journal = MemoryJournal::default();
    let mut driver = FakeDriver::server(3512);
    ActivationController::new(&mut journal, &mut driver)
        .begin(request(UpdateMode::Server, 3512))
        .unwrap();

    assert_eq!(step(&mut journal, &mut driver), ActivationProgress::Pending);
    assert_eq!(
        journal.record.as_ref().unwrap().phase,
        TransactionPhase::StopOldIntent
    );
    assert_eq!(step(&mut journal, &mut driver), ActivationProgress::Pending);
    assert_eq!(
        journal.record.as_ref().unwrap().phase,
        TransactionPhase::StartTargetIntent
    );
    assert_eq!(step(&mut journal, &mut driver), ActivationProgress::Pending);
    assert!(matches!(
        driver.state,
        PortState::Target {
            service: ServiceState::Gated,
            ..
        }
    ));
    assert_eq!(step(&mut journal, &mut driver), ActivationProgress::Pending);
    assert_eq!(step(&mut journal, &mut driver), ActivationProgress::Pending);
    assert_eq!(
        journal.record.as_ref().unwrap().phase,
        TransactionPhase::ActivationAuthorized
    );
    assert!(matches!(
        driver.state,
        PortState::Target {
            service: ServiceState::Gated,
            ..
        }
    ));

    assert_eq!(step(&mut journal, &mut driver), ActivationProgress::Pending);
    assert_eq!(
        journal.record.as_ref().unwrap().phase,
        TransactionPhase::Activated
    );
    assert!(matches!(
        driver.state,
        PortState::Target {
            service: ServiceState::Ordinary,
            ..
        }
    ));
    assert_eq!(step(&mut journal, &mut driver), ActivationProgress::Pending);
    assert_eq!(
        journal.record.as_ref().unwrap().phase,
        TransactionPhase::ActivationConfirmed
    );
    assert_eq!(
        step(&mut journal, &mut driver),
        ActivationProgress::Complete
    );
    assert_eq!(driver.live.selected_generation_id, TARGET_ID);
    assert_eq!(
        driver.live.running_server_generation_id.as_deref(),
        Some(TARGET_ID)
    );
    assert_eq!(
        Path::new(
            &driver
                .live
                .process_identity
                .as_ref()
                .unwrap()
                .runtime
                .client_dir
        ),
        support::stable_client(3512),
        "ordinary relaunches retain current/client as the live indirection"
    );
}

#[test]
fn recovery_rolls_back_every_clean_preconfirmation_state() {
    let cases = [
        (TransactionPhase::Prepared, false, false),
        (TransactionPhase::StopOldIntent, false, false),
        (TransactionPhase::StopOldIntent, true, false),
        (TransactionPhase::StartTargetIntent, true, false),
        (TransactionPhase::TargetReadyGated, true, false),
        (TransactionPhase::SwitchCurrentIntent, true, true),
        (TransactionPhase::ActivationAuthorized, true, true),
    ];

    for (phase, target_started, pointer_switched) in cases {
        let mut record = prepared_record(UpdateMode::Full, 3513);
        record.phase = phase;
        if target_started {
            record.candidate = Some(candidate(TARGET_ID, 5102, 3513));
        }
        let mut journal = MemoryJournal {
            record: Some(record),
            phases: Vec::new(),
        };
        let mut driver = FakeDriver::server(3513);
        if phase >= TransactionPhase::StartTargetIntent {
            driver.state = PortState::Free;
        }
        if target_started {
            driver.target_gated();
        }
        if pointer_switched {
            driver.selected = TARGET_ID.to_string();
        }

        let outcome = ActivationController::new(&mut journal, &mut driver)
            .recover()
            .unwrap();

        assert_eq!(outcome, RecoveryOutcome::RolledBack, "phase {phase:?}");
        assert_eq!(driver.selected, PRIOR_ID, "phase {phase:?}");
        assert_eq!(
            journal.record.as_ref().unwrap().phase,
            TransactionPhase::RollbackComplete,
            "phase {phase:?}"
        );
        assert_eq!(
            driver.live.selected_generation_id, PRIOR_ID,
            "phase {phase:?}"
        );
    }
}

#[test]
fn precommit_recovery_covers_each_stop_start_and_pointer_crash_window() {
    enum LiveWindow {
        Free,
        Gated,
    }
    let cases = [
        (TransactionPhase::StopOldIntent, false, LiveWindow::Free),
        (TransactionPhase::StartTargetIntent, false, LiveWindow::Free),
        (
            TransactionPhase::StartTargetIntent,
            false,
            LiveWindow::Gated,
        ),
        (
            TransactionPhase::SwitchCurrentIntent,
            true,
            LiveWindow::Gated,
        ),
        (
            TransactionPhase::ActivationAuthorized,
            true,
            LiveWindow::Gated,
        ),
    ];

    for (phase, pointer_target, window) in cases {
        let mut record = prepared_record(UpdateMode::Full, 3540);
        record.phase = phase;
        if phase >= TransactionPhase::TargetReadyGated {
            record.candidate = Some(candidate(TARGET_ID, 5102, 3540));
        }
        let mut journal = MemoryJournal {
            record: Some(record),
            phases: Vec::new(),
        };
        let mut driver = FakeDriver::server(3540);
        if pointer_target {
            driver.selected = TARGET_ID.to_string();
        }
        match window {
            LiveWindow::Free => driver.state = PortState::Free,
            LiveWindow::Gated => driver.target_gated(),
        }

        assert_eq!(
            ActivationController::new(&mut journal, &mut driver)
                .recover()
                .unwrap(),
            RecoveryOutcome::RolledBack,
            "phase {phase:?}"
        );
        assert_eq!(driver.selected, PRIOR_ID, "phase {phase:?}");
        assert_eq!(
            journal.record.as_ref().unwrap().phase,
            TransactionPhase::RollbackComplete,
            "phase {phase:?}"
        );
    }
}

#[test]
fn an_unconfirmed_visible_receipt_is_never_commit_authority_by_itself() {
    let mut record = prepared_record(UpdateMode::Server, 3514);
    record.phase = TransactionPhase::ActivationAuthorized;
    record.candidate = Some(candidate(TARGET_ID, 5102, 3514));
    let mut journal = MemoryJournal {
        record: Some(record),
        phases: Vec::new(),
    };
    let mut driver = FakeDriver::server(3514);
    driver.selected = TARGET_ID.to_string();
    driver.receipt = ActivationReceiptObservation::Present(ready_receipt(TARGET_ID, 5102, 3514));
    driver.state = PortState::Free;

    let result = ActivationController::new(&mut journal, &mut driver).recover();

    assert!(result.is_err());
    assert_eq!(
        journal.record.as_ref().unwrap().phase,
        TransactionPhase::ActivationAuthorized
    );
    assert_eq!(driver.selected, TARGET_ID);
    assert!(
        !driver
            .events
            .iter()
            .any(|event| matches!(event, Event::Stop(_) | Event::Switch(_, _))),
        "ambiguous receipt state must neither signal nor rewrite current"
    );
}

#[test]
fn durable_activated_authority_ignores_receipt_loss_but_rejects_gated_drift() {
    #[derive(Clone, Copy)]
    enum BrokenEvidence {
        Absent,
        Malformed,
        Ambiguous,
        Mismatched,
        Gated,
        Vanished,
    }
    for broken in [
        BrokenEvidence::Absent,
        BrokenEvidence::Malformed,
        BrokenEvidence::Ambiguous,
        BrokenEvidence::Mismatched,
        BrokenEvidence::Gated,
        BrokenEvidence::Vanished,
    ] {
        let mut record = prepared_record(UpdateMode::Server, 3541);
        record.phase = TransactionPhase::Activated;
        record.candidate = Some(candidate(TARGET_ID, 5102, 3541));
        let mut journal = MemoryJournal {
            record: Some(record),
            phases: Vec::new(),
        };
        let mut driver = FakeDriver::server(3541);
        driver.selected = TARGET_ID.to_string();
        driver.target_ordinary_with_receipt();
        match broken {
            BrokenEvidence::Absent => {
                driver.receipt = ActivationReceiptObservation::Absent;
            }
            BrokenEvidence::Malformed => {
                driver.receipt = ActivationReceiptObservation::Malformed;
            }
            BrokenEvidence::Ambiguous => {
                driver.receipt = ActivationReceiptObservation::StorageAmbiguous;
            }
            BrokenEvidence::Mismatched => {
                let mut receipt = ready_receipt(TARGET_ID, 5102, 3541);
                receipt.nonce = "different-nonce".to_string();
                driver.receipt = ActivationReceiptObservation::Present(receipt);
            }
            BrokenEvidence::Gated => {
                driver.target_gated();
            }
            BrokenEvidence::Vanished => {
                driver.state = PortState::Free;
            }
        }

        let result = ActivationController::new(&mut journal, &mut driver).recover();
        if matches!(broken, BrokenEvidence::Gated) {
            assert!(result.is_err());
            assert_eq!(
                journal.record.as_ref().unwrap().phase,
                TransactionPhase::Activated
            );
        } else {
            assert_eq!(result.unwrap(), RecoveryOutcome::Activated);
            assert_eq!(
                journal.record.as_ref().unwrap().phase,
                TransactionPhase::ActivationConfirmed
            );
            assert!(journal.record.as_ref().unwrap().finalized);
        }
    }
}

#[test]
fn exact_ordinary_target_can_reconcile_the_receipt_confirmation_window() {
    let mut record = prepared_record(UpdateMode::Server, 3515);
    record.phase = TransactionPhase::ActivationAuthorized;
    record.candidate = Some(candidate(TARGET_ID, 5102, 3515));
    let mut journal = MemoryJournal {
        record: Some(record),
        phases: Vec::new(),
    };
    let mut driver = FakeDriver::server(3515);
    driver.selected = TARGET_ID.to_string();
    driver.target_ordinary_with_receipt();

    let outcome = ActivationController::new(&mut journal, &mut driver)
        .recover()
        .unwrap();

    assert_eq!(outcome, RecoveryOutcome::Activated);
    assert_eq!(
        journal.record.as_ref().unwrap().phase,
        TransactionPhase::ActivationConfirmed
    );
    assert_eq!(driver.live.selected_generation_id, TARGET_ID);
}

#[test]
fn live_candidate_accepts_wildcard_bind_but_rejects_executable_and_runtime_drift() {
    let mut record = prepared_record(UpdateMode::Server, 3532);
    record.phase = TransactionPhase::TargetReadyGated;
    let mut exact = candidate(TARGET_ID, 5102, 3532);
    exact.ready.actual_address = "0.0.0.0:3532".to_string();
    record.candidate = Some(exact.clone());
    record = normalize_test_launch_history(record);
    record
        .validate()
        .expect("the live server may bind the normal wildcard address");

    let mut wrong_executable = record.clone();
    wrong_executable
        .candidate
        .as_mut()
        .unwrap()
        .process
        .executable
        .inode = "999999".to_string();
    assert!(wrong_executable.validate().is_err());

    let mutations: [fn(&mut RuntimeProvenance); 3] = [
        |runtime: &mut RuntimeProvenance| runtime.node_executable = "/foreign/node".to_string(),
        |runtime: &mut RuntimeProvenance| {
            runtime.mcp_entry = "/private/store/generations/foreign/mcp.js".to_string()
        },
        |runtime: &mut RuntimeProvenance| {
            runtime.production_node_modules = "/foreign/node_modules".to_string()
        },
    ];
    for mutate in mutations {
        let mut drifted = record.clone();
        mutate(&mut drifted.candidate.as_mut().unwrap().process.runtime);
        assert!(
            drifted.validate().is_err(),
            "durable target evidence must bind the complete runtime closure"
        );
    }
}

#[test]
fn confirmed_recovery_rolls_forward_and_relaunches_from_the_target_root() {
    let mut record = prepared_record(UpdateMode::Server, 3516);
    record.phase = TransactionPhase::ActivationConfirmed;
    record.candidate = Some(candidate(TARGET_ID, 5102, 3516));
    let mut journal = MemoryJournal {
        record: Some(record),
        phases: Vec::new(),
    };
    let mut driver = FakeDriver::server(3516);
    driver.selected = TARGET_ID.to_string();
    driver.state = PortState::Free;

    let outcome = ActivationController::new(&mut journal, &mut driver)
        .recover()
        .unwrap();

    assert_eq!(outcome, RecoveryOutcome::Activated);
    assert!(driver.events.contains(&Event::StartOrdinary(
        generation_root(3516, TARGET_ID).display().to_string()
    )));
    assert_eq!(driver.live.selected_generation_id, TARGET_ID);
    assert_eq!(
        driver.live.running_server_generation_id.as_deref(),
        Some(TARGET_ID)
    );
    assert_eq!(
        Path::new(
            &driver
                .live
                .process_identity
                .as_ref()
                .unwrap()
                .runtime
                .client_dir
        ),
        support::stable_client(3516),
        "ordinary relaunches retain current/client as the live indirection"
    );
}

#[test]
fn confirmed_recovery_rejects_prior_pointer_without_any_mutation() {
    for prior_running in [false, true] {
        let mut record = prepared_record(UpdateMode::Full, 3534);
        record.phase = TransactionPhase::ActivationConfirmed;
        record.candidate = Some(candidate(TARGET_ID, 5102, 3534));
        let mut journal = MemoryJournal {
            record: Some(record),
            phases: Vec::new(),
        };
        let mut driver = FakeDriver::server(3534);
        if !prior_running {
            driver.state = PortState::Free;
        }

        assert!(ActivationController::new(&mut journal, &mut driver)
            .recover()
            .is_err());
        assert!(driver.events.iter().all(|event| !matches!(
            event,
            Event::Stop(_) | Event::Switch(_, _) | Event::StartOrdinary(_) | Event::WriteLive(_, _)
        )));
    }
}

#[test]
fn bounded_run_rolls_back_a_stuck_gate_and_reports_reconciled_commit_as_success() {
    let mut record = prepared_record(UpdateMode::Server, 3535);
    record.phase = TransactionPhase::ActivationAuthorized;
    record.candidate = Some(candidate(TARGET_ID, 5102, 3535));
    let mut journal = MemoryJournal {
        record: Some(record),
        phases: Vec::new(),
    };
    let mut driver = FakeDriver::server(3535);
    driver.selected = TARGET_ID.to_string();
    driver.target_gated();
    driver.authorize_activates = false;

    assert!(
        ActivationController::new(&mut journal, &mut driver)
            .run_with_timeout(Duration::ZERO)
            .is_err(),
        "a bounded precommit timeout returns the deployment failure after rollback"
    );
    assert_eq!(
        journal.record.as_ref().unwrap().phase,
        TransactionPhase::RollbackComplete
    );
    assert_eq!(driver.selected, PRIOR_ID);

    let mut record = prepared_record(UpdateMode::Server, 3536);
    record.phase = TransactionPhase::ActivationConfirmed;
    record.candidate = Some(candidate(TARGET_ID, 5102, 3536));
    let mut journal = FailOnceJournal {
        inner: MemoryJournal {
            record: Some(record),
            phases: Vec::new(),
        },
        phase: TransactionPhase::ActivationConfirmed,
        failed: false,
    };
    let mut driver = FakeDriver::server(3536);
    driver.selected = TARGET_ID.to_string();
    driver.target_ordinary_with_receipt();

    assert_eq!(
        ActivationController::new(&mut journal, &mut driver)
            .run_with_timeout(Duration::from_secs(1))
            .unwrap(),
        ActivationProgress::Complete,
        "a committed update finalized by recovery must not be reported as failed"
    );
    assert!(
        journal.inner.record.as_ref().unwrap().finalized,
        "recovery completes the durable committed transaction"
    );
}

#[test]
fn delayed_authorization_completion_wins_the_cancellation_race() {
    let mut record = prepared_record(UpdateMode::Server, 3536);
    record.phase = TransactionPhase::ActivationAuthorized;
    record.candidate = Some(candidate(TARGET_ID, 5102, 3536));
    let mut journal = MemoryJournal {
        record: Some(record),
        phases: Vec::new(),
    };
    let mut driver = FakeDriver::server(3536);
    driver.selected = TARGET_ID.to_string();
    driver.target_gated();
    driver.receipt = ActivationReceiptObservation::Absent;
    driver.authorization_completes_during_cancellation = true;

    assert_eq!(
        ActivationController::new(&mut journal, &mut driver)
            .recover()
            .unwrap(),
        RecoveryOutcome::Activated
    );
    assert_eq!(driver.selected, TARGET_ID);
    assert!(driver
        .events
        .iter()
        .all(|event| !matches!(event, Event::Stop(_) | Event::Switch(_, _))));
}

#[test]
fn cancellation_recovery_waits_for_the_server_poll_to_acknowledge() {
    let mut record = prepared_record(UpdateMode::Server, 3538);
    record.phase = TransactionPhase::ActivationAuthorized;
    record.candidate = Some(candidate(TARGET_ID, 5102, 3538));
    let mut journal = MemoryJournal {
        record: Some(record),
        phases: Vec::new(),
    };
    let mut driver = FakeDriver::server(3538);
    driver.selected = TARGET_ID.to_string();
    driver.target_gated();
    driver.cancellation_delay_polls = 2;

    assert_eq!(
        ActivationController::new(&mut journal, &mut driver)
            .recover()
            .unwrap(),
        RecoveryOutcome::RolledBack
    );
}

#[test]
fn contradictory_activation_and_cancellation_receipts_fail_closed() {
    let mut record = prepared_record(UpdateMode::Server, 3539);
    record.phase = TransactionPhase::ActivationAuthorized;
    record.candidate = Some(candidate(TARGET_ID, 5102, 3539));
    let mut journal = MemoryJournal {
        record: Some(record),
        phases: Vec::new(),
    };
    let mut driver = FakeDriver::server(3539);
    driver.selected = TARGET_ID.to_string();
    driver.target_gated();
    driver.cancellation_publishes_both = true;

    assert!(ActivationController::new(&mut journal, &mut driver)
        .recover()
        .is_err());
    assert_eq!(driver.selected, TARGET_ID);
    assert!(driver
        .events
        .iter()
        .all(|event| !matches!(event, Event::Stop(_) | Event::Switch(_, _))));
}

#[test]
fn authorized_rollback_resumes_after_the_prior_pointer_was_restored() {
    let mut record = prepared_record(UpdateMode::Server, 3543);
    record.phase = TransactionPhase::ActivationAuthorized;
    record.candidate = Some(candidate(TARGET_ID, 5102, 3543));
    let mut journal = MemoryJournal {
        record: Some(record),
        phases: Vec::new(),
    };
    let mut driver = FakeDriver::server(3543);
    driver.selected = PRIOR_ID.to_string();
    driver.state = PortState::Free;
    driver.cancellation_receipt =
        ActivationReceiptObservation::Present(driver.target.ready.clone());

    assert_eq!(
        ActivationController::new(&mut journal, &mut driver)
            .recover()
            .unwrap(),
        RecoveryOutcome::RolledBack
    );
    assert_eq!(
        journal.record.as_ref().unwrap().phase,
        TransactionPhase::RollbackComplete
    );
    assert_eq!(driver.live.selected_generation_id, PRIOR_ID);
}

#[test]
fn authorized_rollback_replays_a_crash_after_restoring_the_prior_pointer() {
    let mut record = prepared_record(UpdateMode::Server, 3550);
    record.phase = TransactionPhase::ActivationAuthorized;
    record.candidate = Some(candidate(TARGET_ID, 5102, 3550));
    let mut journal = MemoryJournal {
        record: Some(record),
        phases: Vec::new(),
    };
    let mut driver = FakeDriver::server(3550);
    driver.selected = TARGET_ID.to_string();
    driver.target_gated();
    driver.fail_once = Some((DriverOperation::Switch, FailureTiming::After));

    assert!(ActivationController::new(&mut journal, &mut driver)
        .recover()
        .is_err());
    assert_eq!(driver.selected, PRIOR_ID);
    assert!(matches!(driver.state, PortState::Free));
    assert_eq!(
        journal.record.as_ref().unwrap().phase,
        TransactionPhase::ActivationAuthorized
    );

    assert_eq!(
        ActivationController::new(&mut journal, &mut driver)
            .recover()
            .unwrap(),
        RecoveryOutcome::RolledBack
    );
    assert_eq!(
        journal.record.as_ref().unwrap().phase,
        TransactionPhase::RollbackComplete
    );
}

#[test]
fn confirmed_client_pointer_drift_fails_before_live_receipt_mutation() {
    for (phase, selected) in [
        (TransactionPhase::Activated, PRIOR_ID),
        (TransactionPhase::Activated, FOREIGN_ID),
        (TransactionPhase::ActivationConfirmed, PRIOR_ID),
        (TransactionPhase::ActivationConfirmed, FOREIGN_ID),
    ] {
        let mut record = prepared_record(UpdateMode::ClientOnly, 3544);
        record.phase = phase;
        let mut journal = MemoryJournal {
            record: Some(record),
            phases: Vec::new(),
        };
        let mut driver = FakeDriver::server(3544);
        driver.selected = selected.to_string();
        let original_live = driver.live.clone();

        assert!(ActivationController::new(&mut journal, &mut driver)
            .recover()
            .is_err());
        assert_eq!(driver.live, original_live);
        assert!(driver.events.iter().all(|event| !matches!(
            event,
            Event::WriteLive(_, _)
                | Event::Switch(_, _)
                | Event::Stop(_)
                | Event::StartGated(_)
                | Event::StartOrdinary(_)
        )));
        assert_eq!(journal.record.as_ref().unwrap().phase, phase);
    }
}

#[test]
fn ordinary_activation_never_starts_beside_an_off_port_prior() {
    let mut record = prepared_record(UpdateMode::Server, 3542);
    record.phase = TransactionPhase::StartTargetIntent;
    let mut journal = MemoryJournal {
        record: Some(record),
        phases: Vec::new(),
    };
    let mut driver = FakeDriver::server(3542);
    driver.state = PortState::Free;
    driver.off_port_processes.push(driver.prior.clone());

    assert!(ActivationController::new(&mut journal, &mut driver)
        .step()
        .is_err());
    assert!(!driver
        .events
        .iter()
        .any(|event| matches!(event, Event::StartGated(_))));
}

#[test]
fn unbound_gated_attempt_is_recovered_before_off_port_rollback() {
    let mut record = prepared_record(UpdateMode::Server, 3547);
    record.phase = TransactionPhase::StartTargetIntent;
    let mut journal = FailLaunchBindingJournal {
        inner: MemoryJournal {
            record: Some(record),
            phases: Vec::new(),
        },
        failed: false,
    };
    let mut driver = FakeDriver::server(3547);
    driver.state = PortState::Free;

    assert!(ActivationController::new(&mut journal, &mut driver)
        .step()
        .is_err());
    let process = driver.target.process.clone();
    driver.state = PortState::Free;
    driver.off_port_processes.push(process.clone());

    assert!(ActivationController::new(&mut journal, &mut driver)
        .recover()
        .is_err());
    assert_eq!(
        journal
            .inner
            .record
            .as_ref()
            .unwrap()
            .candidate
            .as_ref()
            .unwrap()
            .process,
        process
    );
    assert_eq!(
        driver
            .events
            .iter()
            .filter(|event| matches!(event, Event::StartGated(_)))
            .count(),
        1
    );
}

#[test]
fn unbound_prior_relaunch_is_recovered_before_off_port_successor() {
    let mut record = prepared_record(UpdateMode::Server, 3548);
    record.phase = TransactionPhase::StartTargetIntent;
    let mut journal = FailLaunchBindingJournal {
        inner: MemoryJournal {
            record: Some(record),
            phases: Vec::new(),
        },
        failed: false,
    };
    let mut driver = FakeDriver::server(3548);
    driver.state = PortState::Free;
    driver.relaunch_with_new_identity = true;

    assert!(ActivationController::new(&mut journal, &mut driver)
        .recover()
        .is_err());
    let process = match &driver.state {
        PortState::Prior { process, .. } => process.clone(),
        state => panic!("expected prior relaunch, got {state:?}"),
    };
    driver.state = PortState::Free;
    driver.off_port_processes.push(process.clone());

    assert!(ActivationController::new(&mut journal, &mut driver)
        .recover()
        .is_err());
    assert_eq!(
        journal
            .inner
            .record
            .as_ref()
            .unwrap()
            .relaunch_attempts
            .last(),
        Some(&process)
    );
    assert_eq!(
        driver
            .events
            .iter()
            .filter(|event| matches!(event, Event::StartOrdinary(_)))
            .count(),
        1
    );
}

#[test]
fn unbound_target_relaunch_is_recovered_before_off_port_successor() {
    let mut record = prepared_record(UpdateMode::Server, 3549);
    record.phase = TransactionPhase::ActivationConfirmed;
    record.candidate = Some(candidate(TARGET_ID, 5102, 3549));
    let mut journal = FailLaunchBindingJournal {
        inner: MemoryJournal {
            record: Some(record),
            phases: Vec::new(),
        },
        failed: false,
    };
    let mut driver = FakeDriver::server(3549);
    driver.selected = TARGET_ID.to_string();
    driver.state = PortState::Free;
    driver.relaunch_with_new_identity = true;

    assert!(ActivationController::new(&mut journal, &mut driver)
        .recover()
        .is_err());
    let process = match &driver.state {
        PortState::TargetRelaunch { process } => process.clone(),
        state => panic!("expected target relaunch, got {state:?}"),
    };
    driver.state = PortState::Free;
    driver.off_port_processes.push(process.clone());

    assert!(ActivationController::new(&mut journal, &mut driver)
        .recover()
        .is_err());
    assert_eq!(
        journal
            .inner
            .record
            .as_ref()
            .unwrap()
            .relaunch_attempts
            .last(),
        Some(&process)
    );
    assert_eq!(
        driver
            .events
            .iter()
            .filter(|event| matches!(event, Event::StartOrdinary(_)))
            .count(),
        1
    );
}

#[test]
fn legacy_empty_launch_history_never_authorizes_start_or_signal() {
    for gated in [false, true] {
        let mut record = prepared_record(UpdateMode::Server, 3551);
        record.launch_protocol_version = None;
        record.phase = if gated {
            record.candidate = Some(candidate(TARGET_ID, 5102, 3551));
            TransactionPhase::TargetReadyGated
        } else {
            TransactionPhase::StartTargetIntent
        };
        let mut journal = MemoryJournal {
            record: Some(record),
            phases: Vec::new(),
        };
        let mut driver = FakeDriver::server(3551);
        if gated {
            driver.target_gated();
        } else {
            driver.state = PortState::Free;
        }

        assert!(ActivationController::new(&mut journal, &mut driver)
            .recover()
            .is_err());
        assert!(driver.events.iter().all(|event| !matches!(
            event,
            Event::Stop(_) | Event::StartGated(_) | Event::StartOrdinary(_)
        )));
    }
}

#[test]
fn a_free_port_does_not_authorize_relaunch_while_the_candidate_is_draining() {
    let mut record = prepared_record(UpdateMode::Server, 3537);
    record.phase = TransactionPhase::ActivationConfirmed;
    record.candidate = Some(candidate(TARGET_ID, 5102, 3537));
    let candidate_process = record.candidate.as_ref().unwrap().process.clone();
    let mut journal = MemoryJournal {
        record: Some(record),
        phases: Vec::new(),
    };
    let mut driver = FakeDriver::server(3537);
    driver.selected = TARGET_ID.to_string();
    driver.state = PortState::Free;
    driver.off_port_processes.push(candidate_process);

    assert!(ActivationController::new(&mut journal, &mut driver)
        .recover()
        .is_err());
    assert!(!driver
        .events
        .iter()
        .any(|event| matches!(event, Event::StartOrdinary(_) | Event::WriteLive(_, _))));
}

#[test]
fn foreign_pointer_or_port_fails_closed_without_signal_or_overwrite() {
    for foreign_pointer in [true, false] {
        let mut record = prepared_record(UpdateMode::Server, 3517);
        record.phase = TransactionPhase::SwitchCurrentIntent;
        record.candidate = Some(candidate(TARGET_ID, 5102, 3517));
        let mut journal = MemoryJournal {
            record: Some(record),
            phases: Vec::new(),
        };
        let mut driver = FakeDriver::server(3517);
        if foreign_pointer {
            driver.selected = FOREIGN_ID.to_string();
            driver.target_gated();
        } else {
            driver.selected = TARGET_ID.to_string();
            driver.state = PortState::Foreign;
        }

        let result = ActivationController::new(&mut journal, &mut driver).recover();

        assert!(result.is_err());
        assert!(
            !driver
                .events
                .iter()
                .any(|event| matches!(event, Event::Stop(_) | Event::Switch(_, _))),
            "foreign state must not be mutated"
        );
        assert_ne!(
            journal.record.as_ref().unwrap().phase,
            TransactionPhase::RollbackComplete
        );
    }
}

#[test]
fn pointer_theft_blocks_every_server_side_effect_and_confirmation_boundary() {
    enum Boundary {
        StopPrior,
        StartGated,
        Authorize,
        Confirm,
    }

    for boundary in [
        Boundary::StopPrior,
        Boundary::StartGated,
        Boundary::Authorize,
        Boundary::Confirm,
    ] {
        let mut record = prepared_record(UpdateMode::Full, 3548);
        let mut driver = FakeDriver::server(3548);
        driver.selected = FOREIGN_ID.to_string();
        match boundary {
            Boundary::StopPrior => {
                record.phase = TransactionPhase::StopOldIntent;
            }
            Boundary::StartGated => {
                record.phase = TransactionPhase::StartTargetIntent;
                driver.state = PortState::Free;
            }
            Boundary::Authorize => {
                record.phase = TransactionPhase::ActivationAuthorized;
                record.candidate = Some(candidate(TARGET_ID, 5102, 3548));
                driver.target_gated();
            }
            Boundary::Confirm => {
                record.phase = TransactionPhase::Activated;
                record.candidate = Some(candidate(TARGET_ID, 5102, 3548));
                driver.target_ordinary_with_receipt();
            }
        }
        let original_phase = record.phase;
        let mut journal = MemoryJournal {
            record: Some(record),
            phases: Vec::new(),
        };

        assert!(
            ActivationController::new(&mut journal, &mut driver)
                .step()
                .is_err(),
            "foreign current must fail closed at {original_phase:?}"
        );
        assert_eq!(journal.record.as_ref().unwrap().phase, original_phase);
        assert!(
            driver.events.iter().all(|event| !matches!(
                event,
                Event::Stop(_) | Event::StartGated(_) | Event::Authorize
            )),
            "foreign current must block the side effect at {original_phase:?}"
        );
    }
}

#[test]
fn recovery_never_promotes_target_receipt_when_current_is_not_target() {
    for phase in [
        TransactionPhase::ActivationAuthorized,
        TransactionPhase::Activated,
    ] {
        for selected in [PRIOR_ID, FOREIGN_ID] {
            let mut record = prepared_record(UpdateMode::Full, 3549);
            record.phase = phase;
            record.candidate = Some(candidate(TARGET_ID, 5102, 3549));
            let mut journal = MemoryJournal {
                record: Some(record),
                phases: Vec::new(),
            };
            let mut driver = FakeDriver::server(3549);
            driver.selected = selected.to_string();
            driver.target_ordinary_with_receipt();

            assert!(
                ActivationController::new(&mut journal, &mut driver)
                    .run_with_timeout(Duration::from_millis(1))
                    .is_err(),
                "receipt/live-target evidence with {selected} selected must fail closed at {phase:?}"
            );
            assert_eq!(
                journal.record.as_ref().unwrap().phase,
                phase,
                "recovery must not mint activation_confirmed authority"
            );
            assert!(
                driver.events.iter().all(|event| !matches!(
                    event,
                    Event::Stop(_)
                        | Event::StartGated(_)
                        | Event::StartOrdinary(_)
                        | Event::Switch(_, _)
                        | Event::Authorize
                        | Event::WriteLive(_, _)
                )),
                "pointer drift must not cause a live mutation"
            );
        }
    }
}

#[test]
fn recovery_rechecks_current_at_every_server_mutation_boundary() {
    enum Boundary {
        RollbackStop,
        RollbackStart,
        RollbackWrite,
        ForwardStop,
        ForwardStart,
        ForwardWrite,
    }

    for boundary in [
        Boundary::RollbackStop,
        Boundary::RollbackStart,
        Boundary::RollbackWrite,
        Boundary::ForwardStop,
        Boundary::ForwardStart,
        Boundary::ForwardWrite,
    ] {
        let mut record = prepared_record(UpdateMode::Full, 3550);
        let mut driver = FakeDriver::server(3550);
        let forbidden = match boundary {
            Boundary::RollbackStop => {
                record.phase = TransactionPhase::ActivationAuthorized;
                record.candidate = Some(candidate(TARGET_ID, 5102, 3550));
                driver.selected = TARGET_ID.to_string();
                driver.target_gated();
                "stop"
            }
            Boundary::RollbackStart => {
                record.phase = TransactionPhase::StartTargetIntent;
                driver.state = PortState::Free;
                "start"
            }
            Boundary::RollbackWrite => {
                record.phase = TransactionPhase::Prepared;
                "write"
            }
            Boundary::ForwardStop => {
                record.phase = TransactionPhase::ActivationConfirmed;
                record.candidate = Some(candidate(TARGET_ID, 5102, 3550));
                driver.selected = TARGET_ID.to_string();
                "stop"
            }
            Boundary::ForwardStart => {
                record.phase = TransactionPhase::ActivationConfirmed;
                record.candidate = Some(candidate(TARGET_ID, 5102, 3550));
                driver.selected = TARGET_ID.to_string();
                driver.state = PortState::Free;
                "start"
            }
            Boundary::ForwardWrite => {
                record.phase = TransactionPhase::ActivationConfirmed;
                record.candidate = Some(candidate(TARGET_ID, 5102, 3550));
                driver.selected = TARGET_ID.to_string();
                driver.target_ordinary_with_receipt();
                "write"
            }
        };
        driver.steal_pointer_after_reads = Some(1);
        let original_phase = record.phase;
        let mut journal = MemoryJournal {
            record: Some(record),
            phases: Vec::new(),
        };

        assert!(
            ActivationController::new(&mut journal, &mut driver)
                .recover()
                .is_err(),
            "pointer theft before recovery {forbidden} must fail closed"
        );
        match forbidden {
            "stop" => assert!(driver
                .events
                .iter()
                .all(|event| !matches!(event, Event::Stop(_)))),
            "start" => assert!(driver
                .events
                .iter()
                .all(|event| !matches!(event, Event::StartOrdinary(_)))),
            "write" => assert!(driver
                .events
                .iter()
                .all(|event| !matches!(event, Event::WriteLive(_, _)))),
            _ => unreachable!(),
        }
        assert_ne!(
            journal.record.as_ref().unwrap().phase,
            TransactionPhase::RollbackComplete,
            "pointer theft must retain the active recovery record from {original_phase:?}"
        );
    }
}

#[test]
fn client_recovery_rechecks_current_immediately_before_live_receipt_write() {
    for (selected, steal_after_reads) in [(PRIOR_ID, 1), (TARGET_ID, 2)] {
        let mut record = prepared_record(UpdateMode::ClientOnly, 3551);
        record.phase = TransactionPhase::ActivationConfirmed;
        let mut journal = MemoryJournal {
            record: Some(record),
            phases: Vec::new(),
        };
        let mut driver = FakeDriver::server(3551);
        driver.selected = selected.to_string();
        driver.steal_pointer_after_reads = Some(steal_after_reads);

        assert!(
            ActivationController::new(&mut journal, &mut driver)
                .recover()
                .is_err(),
            "client recovery must catch pointer theft after selecting {selected}"
        );
        assert!(driver
            .events
            .iter()
            .all(|event| !matches!(event, Event::WriteLive(_, _))));
    }
}

#[test]
fn client_forward_rechecks_current_after_switch_and_around_confirmation() {
    let mut record = prepared_record(UpdateMode::ClientOnly, 3552);
    record.phase = TransactionPhase::SwitchCurrentIntent;
    let mut journal = MemoryJournal {
        record: Some(record),
        phases: Vec::new(),
    };
    let mut driver = FakeDriver::server(3552);
    driver.steal_pointer_after_switch = true;

    assert!(
        ActivationController::new(&mut journal, &mut driver)
            .step()
            .is_err(),
        "pointer theft immediately after the client commit switch must be detected"
    );
    assert_eq!(
        journal.record.as_ref().unwrap().phase,
        TransactionPhase::SwitchCurrentIntent
    );

    for theft_after_write in [false, true] {
        let mut record = prepared_record(UpdateMode::ClientOnly, 3553);
        record.phase = TransactionPhase::Activated;
        let mut journal = MemoryJournal {
            record: Some(record),
            phases: Vec::new(),
        };
        let mut driver = FakeDriver::server(3553);
        driver.selected = TARGET_ID.to_string();
        if theft_after_write {
            driver.steal_pointer_after_write_live = true;
        } else {
            driver.steal_pointer_after_reads = Some(1);
        }

        assert!(
            ActivationController::new(&mut journal, &mut driver)
                .step()
                .is_err(),
            "pointer theft around client live publication must block confirmation"
        );
        assert_eq!(
            journal.record.as_ref().unwrap().phase,
            TransactionPhase::Activated
        );
        if !theft_after_write {
            assert!(
                driver
                    .events
                    .iter()
                    .all(|event| !matches!(event, Event::WriteLive(_, _))),
                "pre-write pointer theft must block the receipt mutation"
            );
        }
    }
}

#[test]
fn client_recovery_rechecks_current_before_each_commit_phase_save() {
    for phase in [
        TransactionPhase::SwitchCurrentIntent,
        TransactionPhase::Activated,
    ] {
        let mut record = prepared_record(UpdateMode::ClientOnly, 3554);
        record.phase = phase;
        let mut journal = MemoryJournal {
            record: Some(record),
            phases: Vec::new(),
        };
        let mut driver = FakeDriver::server(3554);
        driver.selected = TARGET_ID.to_string();
        driver.steal_pointer_after_reads = Some(4);

        assert!(
            ActivationController::new(&mut journal, &mut driver)
                .recover()
                .is_err(),
            "pointer theft before the next durable client phase must fail closed"
        );
        assert_eq!(
            journal.record.as_ref().unwrap().phase,
            phase,
            "recovery must not publish a stronger client commit phase"
        );
    }
}

#[test]
fn recovery_rechecks_current_after_exit_proof_before_relaunch_rebind_save() {
    let mut record = prepared_record(UpdateMode::Full, 3555);
    record.phase = TransactionPhase::ActivationConfirmed;
    record.candidate = Some(candidate(TARGET_ID, 5102, 3555));
    let first_relaunch = relaunched_identity(process_identity(TARGET_ID, 5102, 3555), 1_000);
    seed_bound_relaunch(&mut record, LaunchLane::TargetRollForward, first_relaunch);
    let mut journal = MemoryJournal {
        record: Some(record),
        phases: Vec::new(),
    };
    let mut driver = FakeDriver::server(3555);
    driver.selected = TARGET_ID.to_string();
    driver.state = PortState::Free;
    driver.relaunch_with_new_identity = true;
    driver.relaunch_sequence = 1;
    driver.steal_pointer_after_reads = Some(3);

    assert!(
        ActivationController::new(&mut journal, &mut driver)
            .recover()
            .is_err(),
        "pointer theft during old-attempt exit proof must block successor binding"
    );
    assert_eq!(
        journal.record.as_ref().unwrap().relaunch_attempts.len(),
        2,
        "the launched process identity must remain recoverable despite pointer theft"
    );
    assert!(!journal.record.as_ref().unwrap().finalized);
    assert!(!driver
        .events
        .iter()
        .any(|event| matches!(event, Event::WriteLive(_, _))));
}

#[test]
fn confirmed_recovery_never_overwrites_or_signals_foreign_state() {
    for foreign_pointer in [true, false] {
        let mut record = prepared_record(UpdateMode::Server, 3542);
        record.phase = TransactionPhase::ActivationConfirmed;
        record.candidate = Some(candidate(TARGET_ID, 5102, 3542));
        let mut journal = MemoryJournal {
            record: Some(record),
            phases: Vec::new(),
        };
        let mut driver = FakeDriver::server(3542);
        if foreign_pointer {
            driver.selected = FOREIGN_ID.to_string();
            driver.target_ordinary_with_receipt();
        } else {
            driver.selected = TARGET_ID.to_string();
            driver.state = PortState::Foreign;
        }

        assert!(ActivationController::new(&mut journal, &mut driver)
            .recover()
            .is_err());
        assert!(driver.events.iter().all(|event| !matches!(
            event,
            Event::Stop(_) | Event::Switch(_, _) | Event::StartOrdinary(_) | Event::WriteLive(_, _)
        )));
        assert!(!journal.record.as_ref().unwrap().finalized);
    }
}

#[test]
fn client_only_pointer_is_the_commit_boundary_and_server_identity_stays_prior() {
    for pointer_target in [false, true] {
        let mut record = prepared_record(UpdateMode::ClientOnly, 3518);
        record.phase = TransactionPhase::SwitchCurrentIntent;
        let mut journal = MemoryJournal {
            record: Some(record),
            phases: Vec::new(),
        };
        let mut driver = FakeDriver::server(3518);
        if pointer_target {
            driver.selected = TARGET_ID.to_string();
        }

        let outcome = ActivationController::new(&mut journal, &mut driver)
            .recover()
            .unwrap();

        if pointer_target {
            assert_eq!(outcome, RecoveryOutcome::ClientSelected);
            assert_eq!(driver.live.selected_generation_id, TARGET_ID);
            assert_eq!(
                driver.live.running_server_generation_id.as_deref(),
                Some(PRIOR_ID)
            );
            assert_eq!(
                journal.record.as_ref().unwrap().phase,
                TransactionPhase::ActivationConfirmed
            );
        } else {
            assert_eq!(outcome, RecoveryOutcome::RolledBack);
            assert_eq!(driver.live.selected_generation_id, PRIOR_ID);
        }
        assert!(
            !driver
                .events
                .iter()
                .any(|event| matches!(event, Event::Stop(_) | Event::StartGated(_))),
            "client-only recovery never signals or restarts the server"
        );
    }
}

#[test]
fn client_only_recovery_uses_pointer_authority_across_every_reachable_phase() {
    let cases = [
        (
            TransactionPhase::Prepared,
            false,
            RecoveryOutcome::RolledBack,
        ),
        (
            TransactionPhase::SwitchCurrentIntent,
            false,
            RecoveryOutcome::RolledBack,
        ),
        (
            TransactionPhase::SwitchCurrentIntent,
            true,
            RecoveryOutcome::ClientSelected,
        ),
        (
            TransactionPhase::Activated,
            true,
            RecoveryOutcome::ClientSelected,
        ),
        (
            TransactionPhase::ActivationConfirmed,
            true,
            RecoveryOutcome::ClientSelected,
        ),
    ];
    for (phase, pointer_target, expected) in cases {
        let mut record = prepared_record(UpdateMode::ClientOnly, 3543);
        record.phase = phase;
        let mut journal = MemoryJournal {
            record: Some(record),
            phases: Vec::new(),
        };
        let mut driver = FakeDriver::server(3543);
        if pointer_target {
            driver.selected = TARGET_ID.to_string();
        }

        assert_eq!(
            ActivationController::new(&mut journal, &mut driver)
                .recover()
                .unwrap(),
            expected,
            "phase {phase:?}, pointer_target={pointer_target}"
        );
        assert!(driver.events.iter().all(|event| !matches!(
            event,
            Event::Stop(_) | Event::StartGated(_) | Event::StartOrdinary(_)
        )));
    }
}

#[test]
fn dual_selected_and_running_identity_survives_chained_client_and_server_updates() {
    let port = 3530;
    let running_prior = process_identity(PRIOR_ID, 5101, port);
    let mut driver = FakeDriver::server(port);
    driver.selected = TARGET_ID.to_string();
    driver.live = LiveReceipt::new(
        TARGET_ID.to_string(),
        Some(PRIOR_ID.to_string()),
        false,
        Some(running_prior.clone()),
    );

    let mut client_journal = MemoryJournal::default();
    ActivationController::new(&mut client_journal, &mut driver)
        .begin(dual_identity_request(
            UpdateMode::ClientOnly,
            port,
            TARGET_ID,
            FOREIGN_ID,
            running_prior.clone(),
        ))
        .unwrap();
    for _ in 0..4 {
        ActivationController::new(&mut client_journal, &mut driver)
            .step()
            .unwrap();
    }
    assert_eq!(driver.live.selected_generation_id, FOREIGN_ID);
    assert_eq!(
        driver.live.running_server_generation_id.as_deref(),
        Some(PRIOR_ID),
        "a second client-only update must not relabel the unchanged process"
    );
    assert_eq!(
        driver.live.process_identity.as_ref(),
        Some(&running_prior),
        "the exact running process receipt is retained across client-only updates"
    );
    assert_eq!(
        Path::new(
            &driver
                .live
                .process_identity
                .as_ref()
                .unwrap()
                .runtime
                .client_dir
        ),
        support::stable_client(port),
        "client selection changes must preserve the live current/client indirection"
    );

    let mut server_driver = FakeDriver::server(port);
    server_driver.selected = TARGET_ID.to_string();
    server_driver.live = LiveReceipt::new(
        TARGET_ID.to_string(),
        Some(PRIOR_ID.to_string()),
        false,
        Some(running_prior.clone()),
    );
    server_driver.target = candidate(FOREIGN_ID, 5102, port);
    let mut server_journal = MemoryJournal::default();
    ActivationController::new(&mut server_journal, &mut server_driver)
        .begin(dual_identity_request(
            UpdateMode::Full,
            port,
            TARGET_ID,
            FOREIGN_ID,
            running_prior,
        ))
        .unwrap();
    assert_eq!(
        ActivationController::new(&mut server_journal, &mut server_driver)
            .step()
            .unwrap(),
        ActivationProgress::Pending
    );
    ActivationController::new(&mut server_journal, &mut server_driver)
        .step()
        .unwrap();
    assert!(
        server_driver.events.contains(&Event::Stop(5101)),
        "the next server update stops the receipt-proven running generation, not the selected one"
    );
    assert_eq!(
        server_journal.record.as_ref().unwrap().phase,
        TransactionPhase::StartTargetIntent
    );
}

#[test]
fn client_only_rejects_a_third_pointer_and_never_signals() {
    let mut record = prepared_record(UpdateMode::ClientOnly, 3519);
    record.phase = TransactionPhase::SwitchCurrentIntent;
    let mut journal = MemoryJournal {
        record: Some(record),
        phases: Vec::new(),
    };
    let mut driver = FakeDriver::server(3519);
    driver.selected = FOREIGN_ID.to_string();

    let result = ActivationController::new(&mut journal, &mut driver).recover();

    assert!(result.is_err());
    assert!(driver.events.iter().all(|event| !matches!(
        event,
        Event::Stop(_) | Event::Switch(_, _) | Event::StartGated(_)
    )));
}

#[test]
fn replay_reconciles_io_failure_after_each_commit_relevant_side_effect() {
    // Pointer switched, but activation-authorized phase did not become durable:
    // recovery sees the still-gated target and restores prior.
    let mut journal = FailOnceJournal {
        inner: MemoryJournal::default(),
        phase: TransactionPhase::ActivationAuthorized,
        failed: false,
    };
    let mut driver = FakeDriver::server(3523);
    ActivationController::new(&mut journal, &mut driver)
        .begin(request(UpdateMode::Server, 3523))
        .unwrap();
    for _ in 0..4 {
        ActivationController::new(&mut journal, &mut driver)
            .step()
            .unwrap();
    }
    assert!(ActivationController::new(&mut journal, &mut driver)
        .step()
        .is_err());
    assert_eq!(driver.selected, TARGET_ID);
    assert_eq!(
        journal.inner.record.as_ref().unwrap().phase,
        TransactionPhase::SwitchCurrentIntent
    );
    assert_eq!(
        ActivationController::new(&mut journal, &mut driver)
            .recover()
            .unwrap(),
        RecoveryOutcome::RolledBack
    );

    // Target receipt and ordinary gate are visible, but confirmation journal
    // failed. Exact replay may establish confirmation and roll forward.
    let mut record = prepared_record(UpdateMode::Server, 3524);
    record.phase = TransactionPhase::Activated;
    record.candidate = Some(candidate(TARGET_ID, 5102, 3524));
    let mut journal = FailOnceJournal {
        inner: MemoryJournal {
            record: Some(record),
            phases: Vec::new(),
        },
        phase: TransactionPhase::ActivationConfirmed,
        failed: false,
    };
    let mut driver = FakeDriver::server(3524);
    driver.selected = TARGET_ID.to_string();
    driver.target_ordinary_with_receipt();
    assert!(ActivationController::new(&mut journal, &mut driver)
        .step()
        .is_err());
    assert_eq!(
        ActivationController::new(&mut journal, &mut driver)
            .recover()
            .unwrap(),
        RecoveryOutcome::Activated
    );

    // Client-only pointer visibility is authoritative even when the next
    // journal publication failed.
    let mut journal = FailOnceJournal {
        inner: MemoryJournal::default(),
        phase: TransactionPhase::Activated,
        failed: false,
    };
    let mut driver = FakeDriver::server(3525);
    ActivationController::new(&mut journal, &mut driver)
        .begin(request(UpdateMode::ClientOnly, 3525))
        .unwrap();
    ActivationController::new(&mut journal, &mut driver)
        .step()
        .unwrap();
    assert!(ActivationController::new(&mut journal, &mut driver)
        .step()
        .is_err());
    assert_eq!(driver.selected, TARGET_ID);
    assert_eq!(
        ActivationController::new(&mut journal, &mut driver)
            .recover()
            .unwrap(),
        RecoveryOutcome::ClientSelected
    );
}

#[test]
fn replay_rebinds_new_process_identity_after_ordinary_relaunch_crashes() {
    for fail_phase in [
        TransactionPhase::StartTargetIntent,
        TransactionPhase::RollbackComplete,
    ] {
        let mut record = prepared_record(UpdateMode::Server, 3538);
        record.phase = TransactionPhase::StartTargetIntent;
        let mut journal = FailLaunchBindingJournal {
            inner: MemoryJournal {
                record: Some(record),
                phases: Vec::new(),
            },
            failed: false,
        };
        let mut driver = FakeDriver::server(3538);
        driver.state = PortState::Free;
        driver.relaunch_with_new_identity = true;

        assert!(ActivationController::new(&mut journal, &mut driver)
            .recover()
            .is_err());
        assert!(matches!(
            driver.state,
            PortState::Prior { ref process, .. } if process.pid == 6101
        ));
        assert_eq!(
            ActivationController::new(&mut journal, &mut driver)
                .recover()
                .unwrap(),
            RecoveryOutcome::RolledBack,
            "rollback replay must rebind its exact relaunched prior after {fail_phase:?}"
        );
        assert_eq!(driver.live.process_identity.as_ref().unwrap().pid, 6101);
    }

    let mut record = prepared_record(UpdateMode::Server, 3539);
    record.phase = TransactionPhase::ActivationConfirmed;
    record.candidate = Some(candidate(TARGET_ID, 5102, 3539));
    let mut journal = FailLaunchBindingJournal {
        inner: MemoryJournal {
            record: Some(record),
            phases: Vec::new(),
        },
        failed: false,
    };
    let mut driver = FakeDriver::server(3539);
    driver.selected = TARGET_ID.to_string();
    driver.state = PortState::Free;
    driver.relaunch_with_new_identity = true;

    assert!(ActivationController::new(&mut journal, &mut driver)
        .recover()
        .is_err());
    assert!(matches!(
        driver.state,
        PortState::TargetRelaunch { ref process } if process.pid == 6102
    ));
    assert_eq!(
        ActivationController::new(&mut journal, &mut driver)
            .recover()
            .unwrap(),
        RecoveryOutcome::Activated
    );
    assert_eq!(driver.live.process_identity.as_ref().unwrap().pid, 6102);
}

#[test]
fn replay_appends_a_new_attempt_only_after_the_bound_relaunch_exits() {
    let mut rollback_record = prepared_record(UpdateMode::Server, 3544);
    rollback_record.phase = TransactionPhase::StartTargetIntent;
    seed_bound_relaunch(
        &mut rollback_record,
        LaunchLane::PriorRollback,
        relaunched_identity(process_identity(PRIOR_ID, 5101, 3544), 1_000),
    );
    let mut rollback_journal = MemoryJournal {
        record: Some(rollback_record),
        phases: Vec::new(),
    };
    let mut rollback_driver = FakeDriver::server(3544);
    rollback_driver.state = PortState::Free;
    rollback_driver.relaunch_with_new_identity = true;
    rollback_driver.relaunch_sequence = 1;

    assert_eq!(
        ActivationController::new(&mut rollback_journal, &mut rollback_driver)
            .recover()
            .unwrap(),
        RecoveryOutcome::RolledBack
    );
    let rollback_final = rollback_journal.record.as_ref().unwrap();
    assert_eq!(rollback_final.relaunch_attempts.len(), 2);
    assert_eq!(rollback_final.relaunch_attempts.last().unwrap().pid, 7101);
    assert!(
        rollback_driver.events.contains(&Event::VerifyExited(6101)),
        "a prior attempt must be proven exited before its successor starts"
    );

    let mut target_record = prepared_record(UpdateMode::Server, 3545);
    target_record.phase = TransactionPhase::ActivationConfirmed;
    target_record.candidate = Some(candidate(TARGET_ID, 5102, 3545));
    seed_bound_relaunch(
        &mut target_record,
        LaunchLane::TargetRollForward,
        relaunched_identity(process_identity(TARGET_ID, 5102, 3545), 1_000),
    );
    let mut target_journal = MemoryJournal {
        record: Some(target_record),
        phases: Vec::new(),
    };
    let mut target_driver = FakeDriver::server(3545);
    target_driver.selected = TARGET_ID.to_string();
    target_driver.state = PortState::Free;
    target_driver.relaunch_with_new_identity = true;
    target_driver.relaunch_sequence = 1;

    assert_eq!(
        ActivationController::new(&mut target_journal, &mut target_driver)
            .recover()
            .unwrap(),
        RecoveryOutcome::Activated
    );
    let target_final = target_journal.record.as_ref().unwrap();
    assert_eq!(target_final.relaunch_attempts.len(), 2);
    assert_eq!(target_final.relaunch_attempts.last().unwrap().pid, 7102);
    assert!(
        target_driver.events.contains(&Event::VerifyExited(6102)),
        "a target attempt must be proven exited before its successor starts"
    );

    let mut crash_record = prepared_record(UpdateMode::Server, 3546);
    crash_record.phase = TransactionPhase::ActivationConfirmed;
    crash_record.candidate = Some(candidate(TARGET_ID, 5102, 3546));
    seed_bound_relaunch(
        &mut crash_record,
        LaunchLane::TargetRollForward,
        relaunched_identity(process_identity(TARGET_ID, 5102, 3546), 1_000),
    );
    let mut crash_journal = FailLaunchBindingJournal {
        inner: MemoryJournal {
            record: Some(crash_record),
            phases: Vec::new(),
        },
        failed: false,
    };
    let mut crash_driver = FakeDriver::server(3546);
    crash_driver.selected = TARGET_ID.to_string();
    crash_driver.state = PortState::Free;
    crash_driver.relaunch_with_new_identity = true;
    crash_driver.relaunch_sequence = 1;

    assert!(
        ActivationController::new(&mut crash_journal, &mut crash_driver)
            .recover()
            .is_err(),
        "injected crash occurs after successor start and before its journal append"
    );
    assert!(matches!(
        crash_driver.state,
        PortState::TargetRelaunch { ref process } if process.pid == 7102
    ));
    assert_eq!(
        ActivationController::new(&mut crash_journal, &mut crash_driver)
            .recover()
            .unwrap(),
        RecoveryOutcome::Activated
    );
    assert_eq!(
        crash_journal
            .inner
            .record
            .as_ref()
            .unwrap()
            .relaunch_attempts
            .last()
            .unwrap()
            .pid,
        7102
    );
}

#[test]
fn rollback_relaunch_preserves_validated_alternate_runtime_entries() {
    let mut record = prepared_record(UpdateMode::Server, 3547);
    record.phase = TransactionPhase::StartTargetIntent;
    record.prior_runtime.mcp_entry = record
        .prior_generation_root
        .join("dist/server/mcp/alternate.js")
        .display()
        .to_string();
    record.prior_runtime.claude_sidecar_entry = record
        .prior_generation_root
        .join("claude-sidecar/alternate.mjs")
        .display()
        .to_string();
    record.validate().unwrap();

    let mut journal = MemoryJournal {
        record: Some(record.clone()),
        phases: Vec::new(),
    };
    let mut driver = FakeDriver::server(3547);
    driver.state = PortState::Free;
    driver.prior.runtime = record.prior_runtime;
    driver.prior.runtime.client_dir = support::stable_client(3547).display().to_string();

    assert_eq!(
        ActivationController::new(&mut journal, &mut driver)
            .recover()
            .unwrap(),
        RecoveryOutcome::RolledBack
    );
    assert_eq!(
        driver
            .live
            .process_identity
            .as_ref()
            .unwrap()
            .runtime
            .mcp_entry,
        driver.prior.runtime.mcp_entry
    );
    assert_eq!(
        Path::new(
            &driver
                .live
                .process_identity
                .as_ref()
                .unwrap()
                .runtime
                .client_dir
        ),
        support::stable_client(3547),
        "rollback relaunches retain current/client as the live indirection"
    );
}

#[test]
fn replay_is_idempotent_after_terminal_rollback() {
    let mut journal = MemoryJournal {
        record: Some(prepared_record(UpdateMode::Server, 3526)),
        phases: Vec::new(),
    };
    let mut driver = FakeDriver::server(3526);
    let first = ActivationController::new(&mut journal, &mut driver)
        .recover()
        .unwrap();
    let event_count = driver.events.len();
    let second = ActivationController::new(&mut journal, &mut driver)
        .recover()
        .unwrap();

    assert_eq!(first, RecoveryOutcome::RolledBack);
    assert_eq!(second, RecoveryOutcome::RolledBack);
    assert_eq!(driver.events.len(), event_count);
}

#[test]
fn mismatched_activation_receipt_and_client_identity_drift_fail_closed() {
    let mut record = prepared_record(UpdateMode::Server, 3527);
    record.phase = TransactionPhase::ActivationAuthorized;
    record.candidate = Some(candidate(TARGET_ID, 5102, 3527));
    let mut journal = MemoryJournal {
        record: Some(record),
        phases: Vec::new(),
    };
    let mut driver = FakeDriver::server(3527);
    driver.selected = TARGET_ID.to_string();
    driver.target_ordinary_with_receipt();
    let mut wrong = ready_receipt(TARGET_ID, 5102, 3527);
    wrong.nonce = "foreign-nonce".to_string();
    driver.receipt = ActivationReceiptObservation::Present(wrong);

    assert!(ActivationController::new(&mut journal, &mut driver)
        .recover()
        .is_err());
    assert_eq!(
        journal.record.as_ref().unwrap().phase,
        TransactionPhase::ActivationAuthorized
    );

    let mut record = prepared_record(UpdateMode::ClientOnly, 3528);
    record.phase = TransactionPhase::SwitchCurrentIntent;
    let mut journal = MemoryJournal {
        record: Some(record),
        phases: Vec::new(),
    };
    let mut driver = FakeDriver::server(3528);
    driver.selected = TARGET_ID.to_string();
    let mut changed = driver.prior.clone();
    changed.start_time_ticks = "9999999".to_string();
    driver.state = PortState::Prior {
        process: changed,
        service: ServiceState::Ordinary,
    };

    assert!(ActivationController::new(&mut journal, &mut driver)
        .recover()
        .is_err());
    assert_eq!(driver.selected, TARGET_ID);
    assert!(driver.events.iter().all(|event| !matches!(
        event,
        Event::Stop(_) | Event::Switch(_, _) | Event::StartGated(_)
    )));
}

#[test]
fn compatibility_preflight_strictly_validates_both_artifact_declarations() {
    let fixture = tempfile::tempdir().unwrap();
    let client = fixture.path().join("deployment-compatibility.json");
    std::fs::write(
        &client,
        r#"{
          "schemaVersion":"1",
          "declaration":{
            "schemaVersion":"1","component":"client","version":"0.7.5",
            "supports":{"server":{"minInclusive":"0.7.0","maxExclusive":"0.7.1"}}
          },
          "declarationSha256":"43c554165e167d8d5b33b22b84ce63c8aa5940cc1ba9effb29d62c85aee1c6bb"
        }"#,
    )
    .unwrap();
    let response = br#"{
      "schemaVersion":"1",
      "serverDeclaration":{
        "schemaVersion":"1","component":"server","version":"0.7.0",
        "supports":{"client":{"minInclusive":"0.7.5","maxExclusive":"0.7.6"}}
      },
      "serverDeclarationSha256":"cb2a8fa7d33c53b91a19f2dccfe4ab4c7796e222f3d1107424079f38d33a1955",
      "serverProcessGenerationId":"2222222222222222222222222222222222222222222222222222222222222222",
      "bootId":"boot-11111111-2222-4333-8444-555555555555"
    }"#;

    let pair = validate_compatibility_artifacts(&client, response).unwrap();

    assert_eq!(pair.client.version, "0.7.5");
    assert_eq!(pair.server.version, "0.7.0");
    assert_eq!(
        pair.server_process_generation_id.as_deref(),
        Some(TARGET_ID)
    );
}

#[test]
fn compatibility_preflight_rejects_either_nonreciprocal_direction() {
    let fixture = tempfile::tempdir().unwrap();
    let client = fixture.path().join("deployment-compatibility.json");
    std::fs::write(
        &client,
        r#"{
          "schemaVersion":"1",
          "declaration":{
            "schemaVersion":"1","component":"client","version":"0.7.5",
            "supports":{"server":{"minInclusive":"0.8.0","maxExclusive":"0.9.0"}}
          },
          "declarationSha256":"d5bf7d12a59ab74ce2b2698d949a21a96105396498a6349da98eeb8e148d96fe"
        }"#,
    )
    .unwrap();
    let response = br#"{
      "schemaVersion":"1",
      "serverDeclaration":{
        "schemaVersion":"1","component":"server","version":"0.7.0",
        "supports":{"client":{"minInclusive":"0.7.5","maxExclusive":"0.7.6"}}
      },
      "serverDeclarationSha256":"cb2a8fa7d33c53b91a19f2dccfe4ab4c7796e222f3d1107424079f38d33a1955",
      "serverProcessGenerationId":null,
      "bootId":"boot-11111111-2222-4333-8444-555555555555"
    }"#;

    assert!(validate_compatibility_artifacts(&client, response).is_err());

    std::fs::write(
        &client,
        r#"{
          "schemaVersion":"1",
          "declaration":{
            "schemaVersion":"1","component":"client","version":"0.7.5",
            "supports":{"server":{"minInclusive":"0.7.0","maxExclusive":"0.7.1"}}
          },
          "declarationSha256":"43c554165e167d8d5b33b22b84ce63c8aa5940cc1ba9effb29d62c85aee1c6bb"
        }"#,
    )
    .unwrap();
    let server_rejects_client = response.to_vec();
    let server_rejects_client = String::from_utf8(server_rejects_client)
        .unwrap()
        .replace(
            r#""minInclusive":"0.7.5","maxExclusive":"0.7.6""#,
            r#""minInclusive":"0.8.0","maxExclusive":"0.9.0""#,
        )
        .replace(
            "cb2a8fa7d33c53b91a19f2dccfe4ab4c7796e222f3d1107424079f38d33a1955",
            "c35cfa82aca702e9eec13b8e72536e8464e0a2e71094b8eb17e7d570b2aa4d56",
        );
    assert!(validate_compatibility_artifacts(&client, server_rejects_client.as_bytes()).is_err());
}

#[test]
fn compatibility_preflight_rejects_duplicate_nested_declaration_keys() {
    let fixture = tempfile::tempdir().unwrap();
    let client = fixture.path().join("deployment-compatibility.json");
    std::fs::write(
        &client,
        r#"{
          "schemaVersion":"1",
          "declaration":{
            "schemaVersion":"1","component":"client","version":"9.9.9","version":"0.7.5",
            "supports":{"server":{"minInclusive":"0.7.0","maxExclusive":"0.7.1"}}
          },
          "declarationSha256":"43c554165e167d8d5b33b22b84ce63c8aa5940cc1ba9effb29d62c85aee1c6bb"
        }"#,
    )
    .unwrap();
    let response = br#"{
      "schemaVersion":"1",
      "serverDeclaration":{
        "schemaVersion":"1","component":"server","version":"0.7.0",
        "supports":{"client":{"minInclusive":"0.7.5","maxExclusive":"0.7.6"}}
      },
      "serverDeclarationSha256":"cb2a8fa7d33c53b91a19f2dccfe4ab4c7796e222f3d1107424079f38d33a1955",
      "serverProcessGenerationId":null,
      "bootId":"boot-11111111-2222-4333-8444-555555555555"
    }"#;

    assert!(validate_compatibility_artifacts(&client, response).is_err());
}

fn entry(path: &str, digest: &str) -> ManifestEntry {
    ManifestEntry {
        path: path.to_string(),
        kind: EntryKind::File,
        mode: 0o444,
        symlink_target: None,
        sha256: Some(digest.repeat(64)),
    }
}

#[test]
fn client_only_requires_byte_identical_server_runtime_and_retains_hashed_assets() {
    let prior = vec![
        entry("client/assets/old-hash.js", "a"),
        entry("client/index.html", "b"),
        entry("server/freshell-server", "c"),
        entry("node_modules/pkg/index.js", "d"),
    ];
    let mut valid_target = prior.clone();
    valid_target.retain(|entry| entry.path != "client/index.html");
    valid_target.push(entry("client/index.html", "e"));
    valid_target.push(entry("client/assets/new-hash.js", "f"));

    validate_client_only_entries(&prior, &valid_target).unwrap();

    let mut changed_server = valid_target.clone();
    changed_server
        .iter_mut()
        .find(|entry| entry.path == "server/freshell-server")
        .unwrap()
        .sha256 = Some("9".repeat(64));
    assert!(validate_client_only_entries(&prior, &changed_server).is_err());

    let mut dropped_old_asset = valid_target;
    dropped_old_asset.retain(|entry| entry.path != "client/assets/old-hash.js");
    assert!(validate_client_only_entries(&prior, &dropped_old_asset).is_err());
}

#[test]
fn store_exposes_a_private_durable_transaction_journal_path() {
    let checkout = tempfile::tempdir().unwrap();
    std::fs::write(checkout.path().join(".git"), "gitdir: fixture\n").unwrap();
    let store = Store::open(checkout.path(), DeployPort::new(3520).unwrap()).unwrap();
    let path = store.paths().transaction_journal();

    assert_eq!(
        path,
        store.paths().port_root().join("transaction.json").as_path()
    );
    DurableTransactionJournal::new(path).unwrap();
}

#[test]
fn transaction_roots_controls_and_journal_are_bound_to_one_store() {
    use std::os::unix::fs::PermissionsExt;

    let fixture = tempfile::tempdir().unwrap();
    let mut exact = prepared_record(UpdateMode::Server, 3537);
    relocate_record(&mut exact, fixture.path());
    exact.validate().unwrap();

    let mut cross_store = exact.clone();
    cross_store.target_generation_root = fixture
        .path()
        .join("other-store/generations")
        .join(TARGET_ID);
    relocate_runtime(
        &mut cross_store.target_runtime,
        &cross_store.target_generation_root,
    );
    assert!(cross_store.validate().is_err());

    let mut foreign_controls = exact.clone();
    foreign_controls.controls = ControlPaths::new(
        fixture
            .path()
            .join("other-store/transactions")
            .join(TRANSACTION_ID),
    );
    assert!(foreign_controls.validate().is_err());

    let wrong_journal_path = fixture.path().join("other-store/transaction.json");
    std::fs::create_dir_all(wrong_journal_path.parent().unwrap()).unwrap();
    assert!(
        DurableTransactionJournal::new(wrong_journal_path)
            .unwrap()
            .begin(&exact)
            .is_err(),
        "journal publication cannot escape the transaction's store"
    );

    create_private_transaction_directories(&exact);
    std::fs::set_permissions(
        &exact.controls.directory,
        std::fs::Permissions::from_mode(0o777),
    )
    .unwrap();
    let exact_journal = exact
        .prior_generation_root
        .parent()
        .and_then(Path::parent)
        .unwrap()
        .join("transaction.json");
    assert!(
        DurableTransactionJournal::new(exact_journal)
            .unwrap()
            .begin(&exact)
            .is_err(),
        "a non-private nonce/control directory must fail before journal publication"
    );
}

#[test]
fn durable_journal_round_trips_exact_phases_and_rejects_corruption() {
    use std::os::unix::fs::PermissionsExt;

    let fixture = tempfile::tempdir().unwrap();
    let mut prepared = prepared_record(UpdateMode::Server, 3520);
    relocate_record(&mut prepared, fixture.path());
    create_private_transaction_directories(&prepared);
    let path = fixture
        .path()
        .join(".freshell-deploy/ports/3520/transaction.json");
    let mut journal = DurableTransactionJournal::new(&path).unwrap();
    journal.begin(&prepared).unwrap();
    assert_eq!(journal.load().unwrap(), Some(prepared.clone()));
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o7777,
        0o600
    );

    let mut intent = prepared;
    intent.phase = TransactionPhase::StopOldIntent;
    journal.save(&intent).unwrap();
    assert_eq!(journal.load().unwrap(), Some(intent));

    std::fs::write(&path, b"{not-json}\n").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(
        journal.load().is_err(),
        "unreadable recovery state fails closed"
    );
}

#[test]
fn durable_journal_freezes_transaction_identity_and_candidate_evidence() {
    let fixture = tempfile::tempdir().unwrap();
    let mut original = prepared_record(UpdateMode::Server, 3531);
    relocate_record(&mut original, fixture.path());
    create_private_transaction_directories(&original);
    let path = fixture
        .path()
        .join(".freshell-deploy/ports/3531/transaction.json");
    let mut journal = DurableTransactionJournal::new(&path).unwrap();
    journal.begin(&original).unwrap();

    let mut replacements = Vec::new();

    let mut changed = original.clone();
    changed.nonce = "different-controller-nonce".to_string();
    replacements.push(changed);

    let mut changed = original.clone();
    changed.mode = UpdateMode::Full;
    replacements.push(changed);

    let mut changed = original.clone();
    changed.port = DeployPort::new(4531).unwrap();
    replacements.push(changed);

    let mut changed = original.clone();
    changed.prior_generation_root = Path::new("/other/private/generations").join(PRIOR_ID);
    changed.prior_runtime = process_identity(PRIOR_ID, 5101, 3531).runtime;
    for value in [
        &mut changed.prior_runtime.client_dir,
        &mut changed.prior_runtime.extensions_dir,
        &mut changed.prior_runtime.dist_server_dir,
        &mut changed.prior_runtime.mcp_entry,
        &mut changed.prior_runtime.claude_sidecar_entry,
        &mut changed.prior_runtime.package_json,
        &mut changed.prior_runtime.package_lock,
        &mut changed.prior_runtime.production_node_modules,
    ] {
        *value = value.replacen("/private/store", "/other/private", 1);
    }
    replacements.push(changed);

    let mut changed = original.clone();
    changed.target_server_executable.inode = "999999".to_string();
    replacements.push(changed);

    let mut changed = original.clone();
    changed.target_runtime.node_executable = "/opt/foreign/node".to_string();
    replacements.push(changed);

    let mut changed = original.clone();
    changed.target_node.version = "v99.0.0".to_string();
    replacements.push(changed);

    let mut changed = original.clone();
    changed.prior_live.legacy = true;
    replacements.push(changed);

    let mut changed = original.clone();
    changed.controls = ControlPaths::new(format!("/another/private/transactions/{TRANSACTION_ID}"));
    replacements.push(changed);

    for replacement in replacements {
        assert!(
            journal.save(&replacement).is_err(),
            "same-phase replacement changed a durable transaction invariant"
        );
        assert_eq!(journal.load().unwrap(), Some(original.clone()));
    }

    let mut stop = original.clone();
    stop.phase = TransactionPhase::StopOldIntent;
    journal.save(&stop).unwrap();
    let mut start = stop.clone();
    start.phase = TransactionPhase::StartTargetIntent;
    journal.save(&start).unwrap();
    let attempt_id = "target-gated-0".to_string();
    start.launch_attempts.push(LaunchAttempt {
        ready_file: start
            .controls
            .directory
            .join(format!("launch-{attempt_id}.json")),
        attempt_id,
        lane: LaunchLane::TargetGated,
        process_identity: None,
        definitely_not_started: false,
    });
    journal.save(&start).unwrap();
    let mut gated = start.clone();
    gated.phase = TransactionPhase::TargetReadyGated;
    let candidate = candidate(TARGET_ID, 5102, 3531);
    gated.candidate = Some(candidate);
    relocate_record(&mut gated, fixture.path());
    gated.launch_attempts.last_mut().unwrap().process_identity =
        Some(gated.candidate.as_ref().unwrap().process.clone());
    journal.save(&gated).unwrap();

    let mut replaced_candidate = gated.clone();
    replaced_candidate
        .candidate
        .as_mut()
        .unwrap()
        .process
        .start_time_ticks = "999999".to_string();
    assert!(journal.save(&replaced_candidate).is_err());
    assert_eq!(journal.load().unwrap(), Some(gated));
}

#[test]
fn transaction_control_receipts_are_private_durable_and_exactly_bound() {
    use std::os::unix::fs::PermissionsExt;

    let checkout = tempfile::tempdir().unwrap();
    std::fs::write(checkout.path().join(".git"), "gitdir: fixture\n").unwrap();
    let store = Store::open(checkout.path(), DeployPort::new(3521).unwrap()).unwrap();
    let controls = ControlPaths::create_private(store.paths(), TRANSACTION_ID).unwrap();

    assert_eq!(
        std::fs::metadata(&controls.directory)
            .unwrap()
            .permissions()
            .mode()
            & 0o7777,
        0o700
    );
    publish_activation_authorization(&controls, NONCE, TARGET_ID).unwrap();
    let authorization: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&controls.authorization_file).unwrap()).unwrap();
    assert_eq!(
        authorization,
        serde_json::json!({
            "schemaVersion": "1",
            "nonce": NONCE,
            "serverProcessGenerationId": TARGET_ID,
        })
    );

    std::fs::write(
        &controls.activated_file,
        serde_json::to_vec(&ready_receipt(TARGET_ID, 5102, 3521)).unwrap(),
    )
    .unwrap();
    assert!(matches!(
        read_activation_receipt(&controls),
        Ok(ActivationReceiptObservation::Present(receipt))
            if receipt.server_process_generation_id == TARGET_ID
    ));
}

fn managed_generation_source(parent: &Path, marker: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;

    let root = parent.join(format!("source-{marker}"));
    for directory in [
        "server",
        "client",
        "extensions",
        "dist/server/mcp",
        "claude-sidecar",
        "node_modules",
    ] {
        std::fs::create_dir_all(root.join(directory)).unwrap();
    }
    std::fs::write(root.join("server/freshell-server"), marker).unwrap();
    std::fs::set_permissions(
        root.join("server/freshell-server"),
        std::fs::Permissions::from_mode(0o555),
    )
    .unwrap();
    std::fs::write(root.join("client/index.html"), marker).unwrap();
    std::fs::write(root.join("dist/server/mcp/server.js"), "export {}").unwrap();
    std::fs::write(root.join("dist/server/mcp/alternate.js"), "export {}").unwrap();
    std::fs::write(root.join("claude-sidecar/index.mjs"), "export {}").unwrap();
    std::fs::write(root.join("claude-sidecar/alternate.mjs"), "export {}").unwrap();
    std::fs::write(root.join("package.json"), "{}").unwrap();
    std::fs::write(root.join("package-lock.json"), "{}").unwrap();
    root
}

#[test]
fn transaction_controls_are_create_new_and_cannot_reuse_an_existing_directory() {
    let fixture = tempfile::tempdir().unwrap();
    std::fs::create_dir(fixture.path().join(".git")).unwrap();
    let store = Store::open(fixture.path(), DeployPort::new(3556).unwrap()).unwrap();

    ControlPaths::create_private(store.paths(), TRANSACTION_ID).unwrap();
    assert!(
        ControlPaths::create_private(store.paths(), TRANSACTION_ID).is_err(),
        "even an empty preexisting transaction directory is stale replay state"
    );
}

#[test]
fn activation_begin_rejects_every_stale_control_receipt_before_driver_work() {
    use std::os::unix::fs::PermissionsExt;

    for stale_name in ["ready.json", "authorize.json", "activated.json"] {
        let fixture = tempfile::tempdir().unwrap();
        std::fs::create_dir(fixture.path().join(".git")).unwrap();
        let store = Store::open(fixture.path(), DeployPort::new(3557).unwrap()).unwrap();
        let controls = ControlPaths::create_private(store.paths(), TRANSACTION_ID).unwrap();
        let stale = controls.directory.join(stale_name);
        std::fs::write(&stale, b"stale exact-looking control evidence\n").unwrap();
        std::fs::set_permissions(&stale, std::fs::Permissions::from_mode(0o600)).unwrap();
        let mut activation = request(UpdateMode::Full, 3557);
        relocate_request(&mut activation, fixture.path());
        activation.controls = controls;
        let mut journal = MemoryJournal::default();
        let mut driver = FakeDriver::server(3557);

        assert!(
            ActivationController::new(&mut journal, &mut driver)
                .begin(activation)
                .is_err(),
            "stale {stale_name} must reject transaction begin"
        );
        assert!(
            driver.events.is_empty(),
            "stale controls must be rejected before preflight or probes"
        );
        assert!(journal.record.is_none());
    }
}

#[test]
fn managed_process_identity_keeps_a_stable_current_client_path_after_client_switch() {
    let checkout = tempfile::tempdir().unwrap();
    std::fs::write(checkout.path().join(".git"), "gitdir: fixture\n").unwrap();
    let store = Store::open(checkout.path(), DeployPort::new(3522).unwrap()).unwrap();
    let prior = store
        .lock()
        .unwrap()
        .import_tree(&managed_generation_source(checkout.path(), "prior"))
        .unwrap();
    let target = store
        .lock()
        .unwrap()
        .import_tree(&managed_generation_source(checkout.path(), "target"))
        .unwrap();
    store.lock().unwrap().select_generation(&target.id).unwrap();
    let path = |relative: &str| prior.path.join(relative).display().to_string();
    let mut process = freshell_deploy::ProcessIdentity {
        pid: 6201,
        kernel_boot_id: "11111111-2222-3333-4444-555555555555".to_string(),
        start_time_ticks: "620100".to_string(),
        executable: FileIdentity::from_path(&prior.path.join("server/freshell-server")).unwrap(),
        listener: freshell_deploy::ListenerIdentity {
            port: DeployPort::new(3522).unwrap(),
            socket_inode: "62016201".to_string(),
            owner_pid: 6201,
            network_namespace: "net:[4026533111]".to_string(),
        },
        cwd: prior.path.display().to_string(),
        argv0: "freshell-server".to_string(),
        argument_count: 1,
        effective_uid: unsafe { libc::geteuid() },
        runtime: RuntimeProvenance {
            client_dir: store
                .paths()
                .current_pointer()
                .join("client")
                .display()
                .to_string(),
            extensions_dir: path("extensions"),
            dist_server_dir: path("dist/server"),
            mcp_entry: path("dist/server/mcp/server.js"),
            claude_sidecar_entry: path("claude-sidecar/index.mjs"),
            node_executable: "/usr/bin/node".to_string(),
            package_json: path("package.json"),
            package_lock: path("package-lock.json"),
            production_node_modules: path("node_modules"),
        },
    };

    store
        .lock()
        .unwrap()
        .write_live(&LiveReceipt::new(
            target.id.clone(),
            Some(prior.id.clone()),
            false,
            Some(process.clone()),
        ))
        .expect("selected client may differ from immutable running server");

    let live = store.read_live().unwrap().unwrap();
    assert_eq!(live.selected_generation_id, target.id);
    assert_eq!(
        live.running_server_generation_id.as_deref(),
        Some(prior.id.as_str())
    );

    process.runtime.mcp_entry = path("dist/server/mcp/alternate.js");
    process.runtime.claude_sidecar_entry = path("claude-sidecar/alternate.mjs");
    store
        .lock()
        .unwrap()
        .write_live(&LiveReceipt::new(
            target.id,
            Some(prior.id),
            false,
            Some(process),
        ))
        .expect("validated alternate runtime entry bindings remain authoritative");
}

#[test]
fn unfinished_transaction_retains_both_generations_for_recovery() {
    let checkout = tempfile::tempdir().unwrap();
    std::fs::write(checkout.path().join(".git"), "gitdir: fixture\n").unwrap();
    let port = DeployPort::new(3533).unwrap();
    let store = Store::open(checkout.path(), port).unwrap();
    let prior = store
        .lock()
        .unwrap()
        .import_tree(&managed_generation_source(
            checkout.path(),
            "retained-prior",
        ))
        .unwrap();
    let target = store
        .lock()
        .unwrap()
        .import_tree(&managed_generation_source(
            checkout.path(),
            "retained-target",
        ))
        .unwrap();
    store.lock().unwrap().select_generation(&prior.id).unwrap();

    let runtime_for = |root: &Path| {
        let path = |relative: &str| root.join(relative).display().to_string();
        RuntimeProvenance {
            client_dir: path("client"),
            extensions_dir: path("extensions"),
            dist_server_dir: path("dist/server"),
            mcp_entry: path("dist/server/mcp/server.js"),
            claude_sidecar_entry: path("claude-sidecar/index.mjs"),
            node_executable: "/usr/bin/node".to_string(),
            package_json: path("package.json"),
            package_lock: path("package-lock.json"),
            production_node_modules: path("node_modules"),
        }
    };
    let process = freshell_deploy::ProcessIdentity {
        pid: 6301,
        kernel_boot_id: "11111111-2222-3333-4444-555555555555".to_string(),
        start_time_ticks: "630100".to_string(),
        executable: FileIdentity::from_path(&prior.path.join("server/freshell-server")).unwrap(),
        listener: freshell_deploy::ListenerIdentity {
            port,
            socket_inode: "63016301".to_string(),
            owner_pid: 6301,
            network_namespace: "net:[4026533111]".to_string(),
        },
        cwd: prior.path.display().to_string(),
        argv0: "freshell-server".to_string(),
        argument_count: 1,
        effective_uid: unsafe { libc::geteuid() },
        runtime: runtime_for(&prior.path),
    };
    let prior_live = LiveReceipt::new(
        prior.id.clone(),
        Some(prior.id.clone()),
        true,
        Some(process.clone()),
    );
    let runtime = RuntimeBindings {
        server_executable: "server/freshell-server".to_string(),
        client_dir: "client".to_string(),
        extensions_dir: "extensions".to_string(),
        dist_server_dir: "dist/server".to_string(),
        mcp_entry: "dist/server/mcp/server.js".to_string(),
        claude_sidecar_entry: "claude-sidecar/index.mjs".to_string(),
        package_json: "package.json".to_string(),
        package_lock: "package-lock.json".to_string(),
        production_node_modules: "node_modules".to_string(),
    };
    store
        .lock()
        .unwrap()
        .write_legacy_capture(&LegacyCaptureReceipt {
            schema_version: "1".to_string(),
            generation_id: prior.id.clone(),
            legacy: true,
            process: process.clone(),
            runtime,
            node: NodePrerequisite {
                executable: PathBuf::from("/usr/bin/node"),
                version: "v22.0.0".to_string(),
            },
            launch: NonSecretLaunchMetadata {
                cwd: process.cwd.clone(),
                argv0: process.argv0.clone(),
                argument_count: process.argument_count,
            },
        })
        .unwrap();
    store.lock().unwrap().write_live(&prior_live).unwrap();

    let controls = ControlPaths::create_private(store.paths(), TRANSACTION_ID).unwrap();
    let request = ActivationRequest {
        transaction_id: TRANSACTION_ID.to_string(),
        nonce: NONCE.to_string(),
        port,
        mode: UpdateMode::Full,
        prior_generation_id: prior.id.clone(),
        target_generation_id: target.id.clone(),
        prior_generation_root: prior.path.clone(),
        target_generation_root: target.path.clone(),
        prior_server_executable: process.executable.clone(),
        target_server_executable: FileIdentity::from_path(
            &target.path.join("server/freshell-server"),
        )
        .unwrap(),
        prior_runtime: process.runtime.clone(),
        target_runtime: runtime_for(&target.path),
        prior_node: NodePrerequisite {
            executable: PathBuf::from("/usr/bin/node"),
            version: "v22.0.0".to_string(),
        },
        target_node: NodePrerequisite {
            executable: PathBuf::from("/usr/bin/node"),
            version: "v22.0.0".to_string(),
        },
        prior_live,
        controls,
    };
    let record = TransactionRecord::prepared(&request).unwrap();
    DurableTransactionJournal::new(store.paths().transaction_journal())
        .unwrap()
        .begin(&record)
        .unwrap();

    for generation in [&prior, &target] {
        assert!(matches!(
            store.lock().unwrap().remove_generation(&generation.id),
            Err(DeployError::TransactionGeneration(id)) if id == generation.id
        ));
        store.verify_generation(&generation.id).unwrap();
    }
}

#[derive(Default)]
struct FakeProbeBackend {
    commands: Vec<ProbeCommand>,
    launch: Option<ProbeLaunch>,
    cleaned: bool,
    process: Option<freshell_deploy::ProcessIdentity>,
    second_process: Option<freshell_deploy::ProcessIdentity>,
    inspect_count: usize,
    ready: Vec<u8>,
    responses: BTreeMap<String, Vec<u8>>,
    fail_at: Option<&'static str>,
    cleanup_fails: bool,
    actual_listener_loopback: bool,
}

impl ProbeBackend for FakeProbeBackend {
    type Child = u32;

    fn run_command(
        &mut self,
        command: &ProbeCommand,
        _timeout: Duration,
    ) -> Result<ProbeCommandOutput> {
        self.commands.push(command.clone());
        let stdout = if command.arguments == [OsString::from("--version")] {
            b"v22.0.0\n".to_vec()
        } else {
            Vec::new()
        };
        Ok(ProbeCommandOutput {
            stdout,
            stderr: Vec::new(),
        })
    }

    fn spawn_server(&mut self, launch: &ProbeLaunch) -> Result<Self::Child> {
        self.launch = Some(launch.clone());
        Ok(6101)
    }

    fn child_pid(&self, child: &Self::Child) -> u32 {
        *child
    }

    fn wait_ready(
        &mut self,
        _child: &mut Self::Child,
        _ready_file: &Path,
        _timeout: Duration,
    ) -> Result<Vec<u8>> {
        if self.fail_at == Some("ready") {
            return Err(DeployError::Probe(
                "injected ready-file failure".to_string(),
            ));
        }
        Ok(self.ready.clone())
    }

    fn inspect_process(
        &mut self,
        _child: &Self::Child,
        _port: DeployPort,
    ) -> Result<freshell_deploy::ProcessIdentity> {
        if self.fail_at == Some("identity") {
            return Err(DeployError::Probe(
                "injected process-identity failure".to_string(),
            ));
        }
        let process = if self.inspect_count == 0 {
            self.process.clone()
        } else {
            self.second_process.clone().or_else(|| self.process.clone())
        };
        self.inspect_count += 1;
        Ok(process.unwrap())
    }

    fn listener_is_loopback(&mut self, _child: &Self::Child, _port: DeployPort) -> Result<bool> {
        Ok(self.actual_listener_loopback)
    }

    fn http_get(
        &mut self,
        _address: SocketAddr,
        path: &str,
        _auth_token: Option<&str>,
    ) -> Result<Vec<u8>> {
        let stage = match path {
            "/api/deployment-compatibility" => "compatibility",
            "/api/health" => "health",
            "/" => "client",
            _ => "unknown",
        };
        if self.fail_at == Some(stage) {
            return Err(DeployError::Probe(format!("injected {stage} HTTP failure")));
        }
        self.responses
            .get(path)
            .cloned()
            .ok_or_else(|| DeployError::Probe(format!("missing fake response for {path}")))
    }

    fn terminate_reap(
        &mut self,
        _child: &mut Self::Child,
        _process: Option<&freshell_deploy::ProcessIdentity>,
        _timeout: Duration,
    ) -> Result<()> {
        self.cleaned = true;
        if self.cleanup_fails {
            Err(DeployError::Probe(
                "injected probe cleanup failure".to_string(),
            ))
        } else {
            Ok(())
        }
    }
}

fn probe_fixture() -> (
    tempfile::TempDir,
    GenerationProbeRequest,
    freshell_deploy::ProcessIdentity,
) {
    use std::os::unix::fs::PermissionsExt;

    let fixture = tempfile::tempdir().unwrap();
    let generation = fixture.path().join("generations").join(TARGET_ID);
    for directory in [
        "server",
        "client",
        "extensions",
        "dist/server/mcp",
        "claude-sidecar",
        "node_modules",
    ] {
        std::fs::create_dir_all(generation.join(directory)).unwrap();
    }
    std::fs::write(generation.join("server/freshell-server"), b"server").unwrap();
    std::fs::set_permissions(
        generation.join("server/freshell-server"),
        std::fs::Permissions::from_mode(0o555),
    )
    .unwrap();
    std::fs::write(
        generation.join("client/index.html"),
        b"<main>candidate</main>",
    )
    .unwrap();
    std::fs::write(
        generation.join("client/deployment-compatibility.json"),
        r#"{
          "schemaVersion":"1",
          "declaration":{
            "schemaVersion":"1","component":"client","version":"0.7.5",
            "supports":{"server":{"minInclusive":"0.7.0","maxExclusive":"0.7.1"}}
          },
          "declarationSha256":"43c554165e167d8d5b33b22b84ce63c8aa5940cc1ba9effb29d62c85aee1c6bb"
        }"#,
    )
    .unwrap();
    std::fs::write(generation.join("dist/server/mcp/server.js"), "export {}").unwrap();
    std::fs::write(generation.join("claude-sidecar/index.mjs"), "export {}").unwrap();
    std::fs::write(generation.join("package.json"), "{}").unwrap();
    std::fs::write(generation.join("package-lock.json"), "{}").unwrap();
    let node = fixture.path().join("bin/node");
    std::fs::create_dir_all(node.parent().unwrap()).unwrap();
    std::fs::write(&node, "#!/bin/sh\n").unwrap();
    std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o555)).unwrap();
    let home = fixture.path().join("isolated-home");
    std::fs::create_dir(&home).unwrap();
    let controls = fixture.path().join("controls");
    std::fs::create_dir(&controls).unwrap();

    let path = |relative: &str| generation.join(relative).display().to_string();
    let process = freshell_deploy::ProcessIdentity {
        pid: 6101,
        kernel_boot_id: "11111111-2222-3333-4444-555555555555".to_string(),
        start_time_ticks: "987654".to_string(),
        executable: FileIdentity::from_path(&generation.join("server/freshell-server")).unwrap(),
        listener: freshell_deploy::ListenerIdentity {
            port: DeployPort::new(46101).unwrap(),
            socket_inode: "61016101".to_string(),
            owner_pid: 6101,
            network_namespace: "net:[4026533111]".to_string(),
        },
        cwd: generation.display().to_string(),
        argv0: "freshell-server".to_string(),
        argument_count: 1,
        effective_uid: unsafe { libc::geteuid() },
        runtime: RuntimeProvenance {
            client_dir: path("client"),
            extensions_dir: path("extensions"),
            dist_server_dir: path("dist/server"),
            mcp_entry: path("dist/server/mcp/server.js"),
            claude_sidecar_entry: path("claude-sidecar/index.mjs"),
            node_executable: node.display().to_string(),
            package_json: path("package.json"),
            package_lock: path("package-lock.json"),
            production_node_modules: path("node_modules"),
        },
    };
    let request = GenerationProbeRequest {
        generation_root: generation,
        generation_id: TARGET_ID.to_string(),
        isolated_home: home,
        ready_file: controls.join("ready.json"),
        nonce: NONCE.to_string(),
        auth_token: "isolated-probe-token".to_string(),
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
    };
    (fixture, request, process)
}

fn successful_probe_backend(process: freshell_deploy::ProcessIdentity) -> FakeProbeBackend {
    let mut backend = FakeProbeBackend {
        process: Some(process),
        actual_listener_loopback: true,
        ready: format!(
            "{{\"schemaVersion\":\"1\",\"nonce\":\"{NONCE}\",\"actualAddress\":\"127.0.0.1:46101\",\"pid\":6101,\"bootId\":\"boot-11111111-2222-4333-8444-555555555555\",\"instanceId\":\"srv-11111111-2222-4333-8444-555555555555\",\"serverProcessGenerationId\":\"{TARGET_ID}\",\"serverComponentVersion\":\"0.7.0\",\"buildCommit\":\"0123456789abcdef\"}}\n"
        )
        .into_bytes(),
        ..FakeProbeBackend::default()
    };
    backend.responses.insert(
        "/api/deployment-compatibility".to_string(),
        format!(
            "{{\"schemaVersion\":\"1\",\"serverDeclaration\":{{\"schemaVersion\":\"1\",\"component\":\"server\",\"version\":\"0.7.0\",\"supports\":{{\"client\":{{\"minInclusive\":\"0.7.5\",\"maxExclusive\":\"0.7.6\"}}}}}},\"serverDeclarationSha256\":\"cb2a8fa7d33c53b91a19f2dccfe4ab4c7796e222f3d1107424079f38d33a1955\",\"serverProcessGenerationId\":\"{TARGET_ID}\",\"bootId\":\"boot-11111111-2222-4333-8444-555555555555\"}}"
        )
        .into_bytes(),
    );
    backend.responses.insert(
        "/api/health".to_string(),
        br#"{"app":"freshell","ok":true,"requiresAuth":true,"version":"0.7.0","ready":true,"instanceId":"srv-11111111-2222-4333-8444-555555555555","startedAt":"2026-07-29T12:00:00.000Z"}"#.to_vec(),
    );
    backend
        .responses
        .insert("/".to_string(), b"<main>candidate</main>".to_vec());
    backend
}

#[test]
fn generation_probe_uses_actual_port_zero_allowlisted_env_and_exact_identity() {
    let (_fixture, request, process) = probe_fixture();
    let mut backend = successful_probe_backend(process);

    let result = GenerationProbe::new(&mut backend, Duration::from_secs(1))
        .verify(&request)
        .unwrap();

    assert_eq!(result.candidate.process.pid, 6101);
    assert_eq!(result.compatibility.client.version, "0.7.5");
    let launch = backend.launch.as_ref().unwrap();
    assert_eq!(launch.current_dir, request.generation_root);
    assert_eq!(
        launch.environment.get(std::ffi::OsStr::new("PORT")),
        Some(&OsString::from("0"))
    );
    let expected_names = [
        "AUTH_TOKEN",
        "FRESHELL_BIND_HOST",
        "FRESHELL_CLAUDE_NODE",
        "FRESHELL_CLAUDE_SIDECAR",
        "FRESHELL_CLIENT_DIR",
        "FRESHELL_DEPLOY_GENERATION_ID",
        "FRESHELL_DEPLOY_NONCE",
        "FRESHELL_DEPLOY_READY_FILE",
        "FRESHELL_EXTENSIONS_DIR",
        "FRESHELL_HOME",
        "FRESHELL_MCP_SERVER_ENTRY",
        "HOME",
        "NODE_ENV",
        "PATH",
        "PORT",
    ];
    assert_eq!(
        launch
            .environment
            .keys()
            .map(|key| key.to_str().unwrap())
            .collect::<Vec<_>>(),
        expected_names
    );
    assert!(
        backend.cleaned,
        "probe server must be terminated and reaped"
    );
    assert_eq!(
        backend
            .commands
            .iter()
            .filter(|command| command.program == request.node.executable)
            .count(),
        3,
        "Node version, real sidecar import, and real MCP import are all required"
    );
}

#[test]
fn generation_probe_rejects_identity_transfer_after_http_validation_and_cleans_up() {
    let (_fixture, request, process) = probe_fixture();
    let mut transferred = process.clone();
    transferred.listener.socket_inode = "99999999".to_string();
    let mut backend = successful_probe_backend(process);
    backend.second_process = Some(transferred);

    assert!(GenerationProbe::new(&mut backend, Duration::from_secs(1))
        .verify(&request)
        .is_err());
    assert_eq!(
        backend.inspect_count, 2,
        "the same retained child identity is revalidated after HTTP checks"
    );
    assert!(
        backend.cleaned,
        "identity transfer still terminates and reaps the retained child"
    );
}

#[test]
fn generation_probe_rejects_self_reported_loopback_when_socket_is_wildcard() {
    let (_fixture, request, process) = probe_fixture();
    let mut backend = successful_probe_backend(process);
    backend.actual_listener_loopback = false;

    assert!(
        GenerationProbe::new(&mut backend, Duration::from_secs(1))
            .verify(&request)
            .is_err(),
        "the actual listener address, not only ready.json, must be loopback"
    );
    assert!(backend.cleaned);
}

#[test]
fn generation_probe_cleans_every_post_spawn_failure_and_combines_cleanup_errors() {
    for stage in ["ready", "identity", "compatibility", "health", "client"] {
        let (_fixture, request, process) = probe_fixture();
        let mut backend = successful_probe_backend(process);
        backend.fail_at = Some(stage);

        let error = GenerationProbe::new(&mut backend, Duration::from_secs(1))
            .verify(&request)
            .unwrap_err();

        assert!(
            backend.cleaned,
            "post-spawn {stage} failure must terminate and reap the retained child"
        );
        assert!(
            error.to_string().contains(stage),
            "the {stage} failure must remain visible: {error}"
        );
    }

    let (_fixture, request, process) = probe_fixture();
    let mut backend = successful_probe_backend(process);
    backend.fail_at = Some("ready");
    backend.cleanup_fails = true;

    let error = GenerationProbe::new(&mut backend, Duration::from_secs(1))
        .verify(&request)
        .unwrap_err();
    let message = error.to_string();
    assert!(message.contains("injected ready-file failure"));
    assert!(message.contains("injected probe cleanup failure"));
}

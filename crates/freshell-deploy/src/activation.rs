use std::path::{Path, PathBuf};
use std::{fs, io::Read};
use std::{thread, time::Duration, time::Instant};

use serde::{Deserialize, Serialize};

use crate::durable::atomic_write;
use crate::error::{DeployError, Result};
use crate::journal::{
    validate_candidate, ControlPaths, LaunchAttempt, TransactionJournal, TransactionPhase,
    TransactionRecord, UpdateMode,
};
use crate::legacy::NodePrerequisite;
use crate::paths::DeployPort;
use crate::probe::{CandidateEvidence, DeploymentReadyReceipt};
use crate::process_identity::{ProcessIdentity, RuntimeProvenance};
use crate::receipts::LiveReceipt;
use crate::recovery::{recover_transaction, RecoveryOutcome};

#[derive(Debug, Clone)]
pub struct ActivationRequest {
    pub transaction_id: String,
    pub nonce: String,
    pub port: DeployPort,
    pub mode: UpdateMode,
    pub prior_generation_id: String,
    pub target_generation_id: String,
    pub prior_generation_root: PathBuf,
    pub target_generation_root: PathBuf,
    pub prior_server_executable: crate::process_identity::FileIdentity,
    pub target_server_executable: crate::process_identity::FileIdentity,
    pub prior_runtime: RuntimeProvenance,
    pub target_runtime: RuntimeProvenance,
    pub prior_node: NodePrerequisite,
    pub target_node: NodePrerequisite,
    pub prior_live: LiveReceipt,
    pub controls: ControlPaths,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceState {
    Gated,
    Ordinary,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PortState {
    Free,
    Prior {
        process: ProcessIdentity,
        service: ServiceState,
    },
    Target {
        candidate: CandidateEvidence,
        service: ServiceState,
    },
    TargetRelaunch {
        process: ProcessIdentity,
    },
    Foreign,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchAttemptObservation {
    Absent,
    DefinitelyNotStarted,
    Gated(CandidateEvidence),
    Ordinary(ProcessIdentity),
    Malformed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActivationReceiptObservation {
    Absent,
    Present(DeploymentReadyReceipt),
    Malformed,
    StorageAmbiguous,
}

pub type CancellationReceiptObservation = ActivationReceiptObservation;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActivationAuthorization {
    schema_version: String,
    nonce: String,
    server_process_generation_id: String,
}

pub fn publish_activation_authorization(
    controls: &ControlPaths,
    nonce: &str,
    generation_id: &str,
) -> Result<()> {
    crate::receipts::validate_generation_id(generation_id)?;
    if nonce.is_empty() {
        return Err(DeployError::Activation(
            "activation nonce must not be empty".to_string(),
        ));
    }
    let authorization = ActivationAuthorization {
        schema_version: "1".to_string(),
        nonce: nonce.to_string(),
        server_process_generation_id: generation_id.to_string(),
    };
    let mut bytes = serde_json::to_vec(&authorization)
        .map_err(|error| DeployError::Activation(error.to_string()))?;
    bytes.push(b'\n');
    atomic_write(&controls.authorization_file, &bytes, 0o600)
}

pub fn publish_activation_cancellation(
    controls: &ControlPaths,
    candidate: &DeploymentReadyReceipt,
) -> Result<()> {
    candidate.validate()?;
    let mut bytes = serde_json::to_vec(candidate)
        .map_err(|error| DeployError::Activation(error.to_string()))?;
    bytes.push(b'\n');
    atomic_write(&controls.cancellation_file, &bytes, 0o600)
}

pub fn read_activation_receipt(controls: &ControlPaths) -> Result<ActivationReceiptObservation> {
    read_deployment_receipt(&controls.activated_file)
}

pub fn read_cancellation_receipt(
    controls: &ControlPaths,
) -> Result<CancellationReceiptObservation> {
    read_deployment_receipt(&controls.cancelled_file)
}

fn read_deployment_receipt(path: &Path) -> Result<ActivationReceiptObservation> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

    let mut file = match fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ActivationReceiptObservation::Absent)
        }
        Err(error) => return Err(error.into()),
    };
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o022 != 0
    {
        return Err(DeployError::Activation(
            "activated receipt is not an owned non-writable-by-others regular file".to_string(),
        ));
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    match serde_json::from_slice::<DeploymentReadyReceipt>(&bytes) {
        Ok(receipt) if receipt.validate().is_ok() => {
            Ok(ActivationReceiptObservation::Present(receipt))
        }
        Ok(_) | Err(_) => Ok(ActivationReceiptObservation::Malformed),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivationProgress {
    Pending,
    Complete,
}

pub trait ActivationDriver {
    fn preflight(&mut self, request: &ActivationRequest) -> Result<()>;
    fn probe_target(&mut self, root: &Path, id: &str) -> Result<()>;
    fn probe_prior(&mut self, root: &Path, id: &str) -> Result<()>;
    fn verify_running(&mut self, process: &ProcessIdentity) -> Result<()>;
    fn verify_exited(&mut self, process: &ProcessIdentity) -> Result<()>;
    fn observe_port(&mut self, record: &TransactionRecord) -> Result<PortState>;
    fn observe_launch_attempt(
        &mut self,
        attempt: &LaunchAttempt,
        record: &TransactionRecord,
    ) -> Result<LaunchAttemptObservation>;
    fn stop(&mut self, process: &ProcessIdentity) -> Result<()>;
    /// Start a gated target for a previously journaled deterministic attempt.
    ///
    /// Before a child can outlive this call, it must durably self-publish
    /// exact `CandidateEvidence` at `attempt.ready_file`. A failure before
    /// spawn may be replayed as `DefinitelyNotStarted` only when that outcome
    /// is itself durably proven by the launcher.
    fn start_gated(
        &mut self,
        generation_root: &Path,
        generation_id: &str,
        runtime: &RuntimeProvenance,
        node: &NodePrerequisite,
        controls: &ControlPaths,
        attempt: &LaunchAttempt,
    ) -> Result<CandidateEvidence>;
    /// Start ordinary service under the same durable self-receipt contract as
    /// `start_gated`; the receipt must recover the exact process even after it
    /// has closed its listener and drained off-port.
    fn start_ordinary(
        &mut self,
        generation_root: &Path,
        generation_id: &str,
        runtime: &RuntimeProvenance,
        node: &NodePrerequisite,
        attempt: &LaunchAttempt,
    ) -> Result<ProcessIdentity>;
    fn selected_generation(&mut self) -> Result<String>;
    fn switch_generation(&mut self, expected: &str, target: &str) -> Result<()>;
    fn authorize(&mut self, candidate: &CandidateEvidence, controls: &ControlPaths) -> Result<()>;
    fn activation_receipt(
        &mut self,
        record: &TransactionRecord,
    ) -> Result<ActivationReceiptObservation>;
    fn request_activation_cancellation(
        &mut self,
        candidate: &CandidateEvidence,
        controls: &ControlPaths,
    ) -> Result<()>;
    fn cancellation_receipt(
        &mut self,
        record: &TransactionRecord,
    ) -> Result<CancellationReceiptObservation>;
    fn verify_ordinary(&mut self, process: &ProcessIdentity) -> Result<()>;
    fn write_live(&mut self, receipt: &LiveReceipt) -> Result<()>;
}

pub struct ActivationController<'a, Journal, Driver> {
    journal: &'a mut Journal,
    driver: &'a mut Driver,
}

impl<'a, Journal, Driver> ActivationController<'a, Journal, Driver>
where
    Journal: TransactionJournal,
    Driver: ActivationDriver,
{
    pub fn new(journal: &'a mut Journal, driver: &'a mut Driver) -> Self {
        Self { journal, driver }
    }

    pub fn begin(&mut self, request: ActivationRequest) -> Result<()> {
        // Validate all caller-provided paths and durable identity before any
        // driver is allowed to execute a probe or touch external state.
        let record = TransactionRecord::prepared(&request)?;
        request.controls.require_pristine()?;
        self.driver.preflight(&request)?;
        if request.mode.changes_server() {
            self.driver.probe_target(
                &request.target_generation_root,
                &request.target_generation_id,
            )?;
            self.driver
                .probe_prior(&request.prior_generation_root, &request.prior_generation_id)?;
        } else {
            let process = request
                .prior_live
                .process_identity
                .as_ref()
                .ok_or_else(|| {
                    DeployError::Activation(
                        "client-only preflight requires exact running process identity".to_string(),
                    )
                })?;
            self.driver.verify_running(process)?;
        }
        self.journal.begin(&record)
    }

    pub fn step(&mut self) -> Result<ActivationProgress> {
        let record = self
            .journal
            .load()?
            .ok_or_else(|| DeployError::Activation("no active transaction".to_string()))?;
        record.validate()?;
        if record.finalized || record.phase == TransactionPhase::RollbackComplete {
            return Ok(ActivationProgress::Complete);
        }
        if record.mode == UpdateMode::ClientOnly {
            return self.step_client(record);
        }
        self.step_server(record)
    }

    pub fn recover(&mut self) -> Result<RecoveryOutcome> {
        recover_transaction(self.journal, self.driver)
    }

    pub fn run(&mut self) -> Result<ActivationProgress> {
        self.run_with_timeout(Duration::from_secs(30))
    }

    pub fn run_with_timeout(&mut self, timeout: Duration) -> Result<ActivationProgress> {
        let deadline = Instant::now().checked_add(timeout).ok_or_else(|| {
            DeployError::Activation("activation timeout is outside the supported range".to_string())
        })?;
        loop {
            match self.step() {
                Ok(ActivationProgress::Pending) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(20));
                }
                Ok(ActivationProgress::Pending) => {
                    return self.reconcile_failure(DeployError::Activation(
                        "activation did not advance before the bounded deadline".to_string(),
                    ));
                }
                Ok(complete) => return Ok(complete),
                Err(activation_error) => return self.reconcile_failure(activation_error),
            }
        }
    }

    fn reconcile_failure(&mut self, activation_error: DeployError) -> Result<ActivationProgress> {
        match self.recover() {
            Ok(RecoveryOutcome::RolledBack) => Err(activation_error),
            Ok(RecoveryOutcome::Activated | RecoveryOutcome::ClientSelected) => {
                Ok(ActivationProgress::Complete)
            }
            Err(recovery_error) => Err(DeployError::Recovery(format!(
                "activation failed: {activation_error}; recovery failed: {recovery_error}"
            ))),
        }
    }

    fn step_server(&mut self, record: TransactionRecord) -> Result<ActivationProgress> {
        match record.phase {
            TransactionPhase::Prepared => {
                self.save(record.advanced(TransactionPhase::StopOldIntent)?)?;
            }
            TransactionPhase::StopOldIntent => {
                // The prior closure is probed during preparation and again in
                // the last possible moment before live interruption.
                self.driver
                    .probe_prior(&record.prior_generation_root, &record.prior_generation_id)?;
                match self.checked_port(&record)? {
                    PortState::Prior {
                        process,
                        service: ServiceState::Ordinary,
                    } => {
                        self.driver.verify_running(&process)?;
                        self.require_selected_generation(&record.prior_generation_id)?;
                        self.driver.stop(&process)?;
                    }
                    PortState::Free => {
                        self.driver.verify_exited(record.expected_prior_process())?;
                        self.require_selected_generation(&record.prior_generation_id)?;
                    }
                    _ => {
                        return Err(DeployError::Activation(
                            "old server is not the exact ordinary prior process".to_string(),
                        ))
                    }
                }
                self.save(record.advanced(TransactionPhase::StartTargetIntent)?)?;
            }
            TransactionPhase::StartTargetIntent => {
                let mut working = record.clone();
                let created = working.pending_launch_attempt().is_none();
                if created {
                    working =
                        working.with_new_launch_attempt(crate::journal::LaunchLane::TargetGated)?;
                    self.save(working.clone())?;
                }
                let attempt = working
                    .pending_launch_attempt()
                    .expect("new gated launch attempt")
                    .clone();
                let candidate = match self.checked_port(&working)? {
                    PortState::Free => {
                        self.driver
                            .verify_exited(working.expected_prior_process())?;
                        self.require_selected_generation(&working.prior_generation_id)?;
                        match self.driver.observe_launch_attempt(&attempt, &working)? {
                            LaunchAttemptObservation::Absent if created => {
                                self.driver.start_gated(
                                    &working.target_generation_root,
                                    &working.target_generation_id,
                                    &crate::journal::live_runtime(
                                        &working.target_runtime,
                                        &working.target_generation_root,
                                    )?,
                                    &working.target_node,
                                    &working.controls,
                                    &attempt,
                                )?
                            }
                            LaunchAttemptObservation::Absent => {
                                return Err(DeployError::Activation(
                                    "unbound gated launch attempt has no recoverable receipt"
                                        .to_string(),
                                ))
                            }
                            LaunchAttemptObservation::Gated(candidate) => candidate,
                            _ => return Err(DeployError::Activation(
                                "gated launch receipt is malformed or names an ordinary process"
                                    .to_string(),
                            )),
                        }
                    }
                    PortState::Target {
                        candidate,
                        service: ServiceState::Gated,
                    } => {
                        self.require_selected_generation(&working.prior_generation_id)?;
                        candidate
                    }
                    _ => {
                        return Err(DeployError::Activation(
                            "live port is not free for the gated target".to_string(),
                        ))
                    }
                };
                validate_candidate(&working, &candidate)?;
                self.require_selected_generation(&working.prior_generation_id)?;
                self.save(working.with_bound_gated_candidate(candidate)?)?;
            }
            TransactionPhase::TargetReadyGated => {
                require_target(&self.checked_port(&record)?, &record, ServiceState::Gated)?;
                self.require_selected_generation(&record.prior_generation_id)?;
                self.save(record.advanced(TransactionPhase::SwitchCurrentIntent)?)?;
            }
            TransactionPhase::SwitchCurrentIntent => {
                require_target(&self.checked_port(&record)?, &record, ServiceState::Gated)?;
                self.switch_exact(&record.prior_generation_id, &record.target_generation_id)?;
                self.save(record.advanced(TransactionPhase::ActivationAuthorized)?)?;
            }
            TransactionPhase::ActivationAuthorized => {
                let state = self.checked_port(&record)?;
                let candidate = require_target_any_service(&state, &record)?.clone();
                self.require_selected_generation(&record.target_generation_id)?;
                if matches!(
                    state,
                    PortState::Target {
                        service: ServiceState::Gated,
                        ..
                    }
                ) {
                    self.driver.authorize(&candidate, &record.controls)?;
                }
                self.require_selected_generation(&record.target_generation_id)?;
                match self.driver.activation_receipt(&record)? {
                    ActivationReceiptObservation::Absent => {
                        if matches!(
                            self.checked_port(&record)?,
                            PortState::Target {
                                service: ServiceState::Gated,
                                ..
                            }
                        ) {
                            return Ok(ActivationProgress::Pending);
                        }
                        return Err(DeployError::Activation(
                            "target admitted ordinary traffic without a durable receipt"
                                .to_string(),
                        ));
                    }
                    ActivationReceiptObservation::Present(receipt) => {
                        require_matching_receipt(&record, &candidate, &receipt)?;
                        require_target(
                            &self.checked_port(&record)?,
                            &record,
                            ServiceState::Ordinary,
                        )?;
                        self.require_selected_generation(&record.target_generation_id)?;
                        self.save(record.advanced(TransactionPhase::Activated)?)?;
                    }
                    ActivationReceiptObservation::Malformed
                    | ActivationReceiptObservation::StorageAmbiguous => {
                        return Err(DeployError::Activation(
                            "target activation receipt is unreadable or storage-ambiguous"
                                .to_string(),
                        ))
                    }
                }
            }
            TransactionPhase::Activated => {
                self.confirm_observed_activation(&record)?;
            }
            TransactionPhase::ActivationConfirmed => {
                crate::recovery::roll_forward_confirmed(self.journal, self.driver, &record)?;
                return Ok(ActivationProgress::Complete);
            }
            TransactionPhase::RollbackComplete => return Ok(ActivationProgress::Complete),
        }
        Ok(ActivationProgress::Pending)
    }

    fn step_client(&mut self, record: TransactionRecord) -> Result<ActivationProgress> {
        match record.phase {
            TransactionPhase::Prepared => {
                self.save(record.advanced(TransactionPhase::SwitchCurrentIntent)?)?;
            }
            TransactionPhase::SwitchCurrentIntent => {
                let state = self.checked_port(&record)?;
                let process = require_prior_ordinary(&state, &record)?;
                self.driver.verify_running(process)?;
                self.switch_exact(&record.prior_generation_id, &record.target_generation_id)?;
                let after_state = self.checked_port(&record)?;
                let after = require_prior_ordinary(&after_state, &record)?;
                self.driver.verify_running(after)?;
                self.require_selected_generation(&record.target_generation_id)?;
                self.save(record.advanced(TransactionPhase::Activated)?)?;
            }
            TransactionPhase::Activated => {
                let selected = self.driver.selected_generation()?;
                if selected != record.target_generation_id {
                    return Err(DeployError::Activation(
                        "client-only committed pointer no longer selects target".to_string(),
                    ));
                }
                let state = self.checked_port(&record)?;
                let process = require_prior_ordinary(&state, &record)?;
                self.driver.verify_running(process)?;
                self.require_selected_generation(&record.target_generation_id)?;
                let live = LiveReceipt::new(
                    record.target_generation_id.clone(),
                    Some(record.prior_running_generation_id().to_string()),
                    record.prior_live.legacy,
                    Some(process.clone()),
                );
                self.driver.write_live(&live)?;
                self.require_selected_generation(&record.target_generation_id)?;
                self.save(record.advanced(TransactionPhase::ActivationConfirmed)?)?;
            }
            TransactionPhase::ActivationConfirmed => {
                crate::recovery::finish_client_selection(self.journal, self.driver, &record)?;
                return Ok(ActivationProgress::Complete);
            }
            TransactionPhase::RollbackComplete => return Ok(ActivationProgress::Complete),
            _ => {
                return Err(DeployError::Activation(
                    "client-only transaction contains a server phase".to_string(),
                ))
            }
        }
        Ok(ActivationProgress::Pending)
    }

    fn confirm_observed_activation(&mut self, record: &TransactionRecord) -> Result<()> {
        let candidate = record.candidate.as_ref().ok_or_else(|| {
            DeployError::Activation("activated phase has no candidate evidence".to_string())
        })?;
        let receipt = match self.driver.activation_receipt(record)? {
            ActivationReceiptObservation::Present(receipt) => receipt,
            _ => {
                return Err(DeployError::Activation(
                    "activated evidence is absent or ambiguous before confirmation".to_string(),
                ))
            }
        };
        require_matching_receipt(record, candidate, &receipt)?;
        let state = self.checked_port(record)?;
        let process = require_target(&state, record, ServiceState::Ordinary)?;
        self.driver.verify_running(process)?;
        self.driver.verify_ordinary(process)?;
        self.require_selected_generation(&record.target_generation_id)?;
        self.save(record.advanced(TransactionPhase::ActivationConfirmed)?)
    }

    fn checked_port(&mut self, record: &TransactionRecord) -> Result<PortState> {
        let state = self.driver.observe_port(record)?;
        validate_port_state(record, &state)?;
        Ok(state)
    }

    fn switch_exact(&mut self, from: &str, to: &str) -> Result<()> {
        let current = self.driver.selected_generation()?;
        if current == to {
            return Ok(());
        }
        if current != from {
            return Err(DeployError::Activation(format!(
                "current pointer selects unexpected generation {current}"
            )));
        }
        self.driver.switch_generation(from, to)
    }

    fn require_selected_generation(&mut self, expected: &str) -> Result<()> {
        let current = self.driver.selected_generation()?;
        if current != expected {
            return Err(DeployError::Activation(format!(
                "current pointer selects unexpected generation {current}; expected {expected}"
            )));
        }
        Ok(())
    }

    fn save(&mut self, record: TransactionRecord) -> Result<()> {
        self.journal.save(&record)
    }
}

pub(crate) fn validate_port_state(record: &TransactionRecord, state: &PortState) -> Result<()> {
    match state {
        PortState::Free | PortState::Foreign => Ok(()),
        PortState::Prior { process, .. } => {
            if process != record.expected_prior_process() {
                return Err(DeployError::Recovery(
                    "port process labeled prior does not match prior receipt".to_string(),
                ));
            }
            Ok(())
        }
        PortState::Target { candidate, .. } => validate_candidate(record, candidate),
        PortState::TargetRelaunch { process } => {
            if record.phase != TransactionPhase::ActivationConfirmed {
                return Err(DeployError::Recovery(
                    "ordinary target relaunch appeared before durable confirmation".to_string(),
                ));
            }
            crate::journal::validate_generation_process(record, process, false)?;
            Ok(())
        }
    }
}

pub(crate) fn require_target<'a>(
    state: &'a PortState,
    record: &TransactionRecord,
    service: ServiceState,
) -> Result<&'a ProcessIdentity> {
    match state {
        PortState::Target {
            candidate,
            service: actual,
        } if *actual == service => {
            validate_candidate(record, candidate)?;
            Ok(&candidate.process)
        }
        _ => Err(DeployError::Recovery(format!(
            "exact target is not in required {service:?} state"
        ))),
    }
}

fn require_target_any_service<'a>(
    state: &'a PortState,
    record: &TransactionRecord,
) -> Result<&'a CandidateEvidence> {
    match state {
        PortState::Target { candidate, .. } => {
            validate_candidate(record, candidate)?;
            Ok(candidate)
        }
        _ => Err(DeployError::Activation(
            "exact target candidate is not on the live port".to_string(),
        )),
    }
}

pub(crate) fn require_prior_ordinary<'a>(
    state: &'a PortState,
    record: &TransactionRecord,
) -> Result<&'a ProcessIdentity> {
    match state {
        PortState::Prior {
            process,
            service: ServiceState::Ordinary,
        } if process == record.expected_prior_process() => Ok(process),
        _ => Err(DeployError::Recovery(
            "exact prior ordinary process is not on the live port".to_string(),
        )),
    }
}

pub(crate) fn require_matching_receipt(
    record: &TransactionRecord,
    candidate: &CandidateEvidence,
    receipt: &DeploymentReadyReceipt,
) -> Result<()> {
    receipt.validate()?;
    if receipt != &candidate.ready
        || receipt.nonce != record.nonce
        || receipt.server_process_generation_id != record.target_generation_id
    {
        return Err(DeployError::Recovery(
            "activated receipt does not match exact ready candidate".to_string(),
        ));
    }
    Ok(())
}

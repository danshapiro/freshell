use std::collections::BTreeSet;
use std::fs;
use std::io::Read;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::activation::ActivationRequest;
use crate::durable::{atomic_write, sync_directory};
use crate::error::{DeployError, Result};
use crate::paths::{ensure_private_directory, StorePaths};
use crate::probe::CandidateEvidence;
use crate::receipts::{validate_generation_id, LiveReceipt};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransactionPhase {
    Prepared,
    StopOldIntent,
    StartTargetIntent,
    TargetReadyGated,
    SwitchCurrentIntent,
    ActivationAuthorized,
    Activated,
    ActivationConfirmed,
    RollbackComplete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateMode {
    ClientOnly,
    Server,
    Full,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LaunchLane {
    TargetGated,
    PriorRollback,
    TargetRollForward,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchExecutorIdentity {
    pub pid: u32,
    pub kernel_boot_id: String,
    pub start_time_ticks: String,
    pub executable: crate::process_identity::FileIdentity,
    pub cwd: String,
    pub effective_uid: u32,
}

impl LaunchExecutorIdentity {
    fn validate(&self) -> Result<()> {
        let decimal =
            |value: &str| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit());
        let digest_is_valid = self.executable.sha256.len() == 64
            && self
                .executable
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
        let boot_id_is_valid = self.kernel_boot_id.len() == 36
            && self
                .kernel_boot_id
                .bytes()
                .enumerate()
                .all(|(index, byte)| {
                    if matches!(index, 8 | 13 | 18 | 23) {
                        byte == b'-'
                    } else {
                        byte.is_ascii_hexdigit()
                    }
                });
        let cwd = Path::new(&self.cwd);
        if self.pid == 0
            || !boot_id_is_valid
            || !decimal(&self.start_time_ticks)
            || !decimal(&self.executable.device)
            || !decimal(&self.executable.inode)
            || !digest_is_valid
            || self.executable.mode & 0o111 == 0
            || self.executable.mode & !0o7777 != 0
            || !cwd.is_absolute()
            || !cwd.components().all(|component| {
                matches!(
                    component,
                    std::path::Component::RootDir | std::path::Component::Normal(_)
                )
            })
        {
            return Err(DeployError::Journal(
                "launch executor identity is incomplete or malformed".to_string(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchClaim {
    pub schema_version: String,
    pub claim_id: String,
    pub transaction_id: String,
    pub nonce: String,
    pub attempt_id: String,
    pub receipt_file: PathBuf,
    pub lane: LaunchLane,
    pub generation_id: String,
    pub port: crate::paths::DeployPort,
    pub executor: LaunchExecutorIdentity,
}

impl LaunchClaim {
    fn validate(&self, record: &TransactionRecord, attempt: &LaunchAttempt) -> Result<()> {
        let expected_generation = match attempt.lane {
            LaunchLane::PriorRollback => &record.prior_generation_id,
            LaunchLane::TargetGated | LaunchLane::TargetRollForward => &record.target_generation_id,
        };
        let (expected_root, expected_executable) = match attempt.lane {
            LaunchLane::PriorRollback => (
                &record.prior_generation_root,
                &record.prior_server_executable,
            ),
            LaunchLane::TargetGated | LaunchLane::TargetRollForward => (
                &record.target_generation_root,
                &record.target_server_executable,
            ),
        };
        if self.schema_version != "1"
            || self.claim_id.is_empty()
            || self.claim_id.contains('/')
            || self.claim_id == "."
            || self.claim_id == ".."
            || self.transaction_id != record.transaction_id
            || self.nonce != record.nonce
            || self.attempt_id != attempt.attempt_id
            || self.receipt_file != attempt.ready_file
            || self.lane != attempt.lane
            || &self.generation_id != expected_generation
            || self.port != record.port
            || Path::new(&self.executor.cwd) != expected_root
            || &self.executor.executable != expected_executable
            || self.executor.effective_uid != record.expected_prior_process().effective_uid
        {
            return Err(DeployError::Journal(
                "launch claim is not exactly bound to its transaction, attempt, lane, and executor"
                    .to_string(),
            ));
        }
        self.executor.validate()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum LaunchAttemptState {
    Unclaimed,
    Owned {
        claim: LaunchClaim,
    },
    Started {
        claim: LaunchClaim,
        process_identity: Box<crate::process_identity::ProcessIdentity>,
    },
    DefinitelyNotStarted {
        claim: LaunchClaim,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchAttempt {
    pub attempt_id: String,
    pub ready_file: PathBuf,
    pub lane: LaunchLane,
    pub state: LaunchAttemptState,
}

impl LaunchAttempt {
    pub fn claim(&self) -> Option<&LaunchClaim> {
        match &self.state {
            LaunchAttemptState::Unclaimed => None,
            LaunchAttemptState::Owned { claim }
            | LaunchAttemptState::Started { claim, .. }
            | LaunchAttemptState::DefinitelyNotStarted { claim } => Some(claim),
        }
    }

    pub fn process_identity(&self) -> Option<&crate::process_identity::ProcessIdentity> {
        match &self.state {
            LaunchAttemptState::Started {
                process_identity, ..
            } => Some(process_identity.as_ref()),
            _ => None,
        }
    }

    pub fn is_pending(&self) -> bool {
        matches!(
            self.state,
            LaunchAttemptState::Unclaimed | LaunchAttemptState::Owned { .. }
        )
    }

    pub fn is_definitely_not_started(&self) -> bool {
        matches!(self.state, LaunchAttemptState::DefinitelyNotStarted { .. })
    }
}

impl UpdateMode {
    pub fn changes_server(self) -> bool {
        !matches!(self, Self::ClientOnly)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlPaths {
    pub directory: PathBuf,
    pub ready_file: PathBuf,
    pub authorization_file: PathBuf,
    pub activated_file: PathBuf,
    pub cancellation_file: PathBuf,
    pub cancelled_file: PathBuf,
}

impl ControlPaths {
    pub fn new(directory: impl AsRef<Path>) -> Self {
        let directory = directory.as_ref().to_path_buf();
        Self {
            ready_file: directory.join("ready.json"),
            authorization_file: directory.join("authorize.json"),
            activated_file: directory.join("activated.json"),
            cancellation_file: directory.join("cancel.json"),
            cancelled_file: directory.join("cancelled.json"),
            directory,
        }
    }

    pub fn create_private(paths: &StorePaths, transaction_id: &str) -> Result<Self> {
        if transaction_id.is_empty()
            || transaction_id.contains('/')
            || transaction_id == "."
            || transaction_id == ".."
        {
            return Err(DeployError::Journal(
                "transaction id is unsafe for a control directory".to_string(),
            ));
        }
        let directory = paths.transactions_dir().join(transaction_id);
        let mut builder = fs::DirBuilder::new();
        builder.mode(0o700);
        builder.create(&directory).map_err(|error| {
            DeployError::Journal(format!(
                "cannot create new transaction control directory {}: {error}",
                directory.display()
            ))
        })?;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
        ensure_private_directory(&directory)?;
        sync_directory(paths.transactions_dir())?;
        let controls = Self::new(directory);
        controls.validate(transaction_id)?;
        controls.require_pristine()?;
        Ok(controls)
    }

    fn validate(&self, transaction_id: &str) -> Result<()> {
        if !self.directory.is_absolute()
            || self.directory.file_name().and_then(|name| name.to_str()) != Some(transaction_id)
            || self.ready_file != self.directory.join("ready.json")
            || self.authorization_file != self.directory.join("authorize.json")
            || self.activated_file != self.directory.join("activated.json")
            || self.cancellation_file != self.directory.join("cancel.json")
            || self.cancelled_file != self.directory.join("cancelled.json")
        {
            return Err(DeployError::Journal(
                "transaction control paths are not exact absolute siblings".to_string(),
            ));
        }
        Ok(())
    }

    pub(crate) fn require_pristine(&self) -> Result<()> {
        for (label, path) in [
            ("ready receipt", &self.ready_file),
            ("authorization", &self.authorization_file),
            ("activated receipt", &self.activated_file),
            ("cancellation", &self.cancellation_file),
            ("cancelled receipt", &self.cancelled_file),
        ] {
            match fs::symlink_metadata(path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(DeployError::Journal(format!(
                        "cannot inspect transaction {label} {}: {error}",
                        path.display()
                    )))
                }
                Ok(_) => {
                    return Err(DeployError::Journal(format!(
                        "transaction {label} already exists: {}",
                        path.display()
                    )))
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransactionRecord {
    pub schema_version: String,
    pub transaction_id: String,
    pub nonce: String,
    pub port: crate::paths::DeployPort,
    pub mode: UpdateMode,
    pub prior_generation_id: String,
    pub target_generation_id: String,
    pub prior_generation_root: PathBuf,
    pub target_generation_root: PathBuf,
    pub prior_server_executable: crate::process_identity::FileIdentity,
    pub target_server_executable: crate::process_identity::FileIdentity,
    pub prior_runtime: crate::process_identity::RuntimeProvenance,
    pub target_runtime: crate::process_identity::RuntimeProvenance,
    pub prior_node: crate::legacy::NodePrerequisite,
    pub target_node: crate::legacy::NodePrerequisite,
    pub prior_live: LiveReceipt,
    pub controls: ControlPaths,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_protocol_version: Option<String>,
    pub candidate: Option<CandidateEvidence>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub relaunch_attempts: Vec<crate::process_identity::ProcessIdentity>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub launch_attempts: Vec<LaunchAttempt>,
    pub phase: TransactionPhase,
    #[serde(default)]
    pub finalized: bool,
}

impl TransactionRecord {
    pub fn prepared(request: &ActivationRequest) -> Result<Self> {
        let record = Self {
            schema_version: "1".to_string(),
            transaction_id: request.transaction_id.clone(),
            nonce: request.nonce.clone(),
            port: request.port,
            mode: request.mode,
            prior_generation_id: request.prior_generation_id.clone(),
            target_generation_id: request.target_generation_id.clone(),
            prior_generation_root: request.prior_generation_root.clone(),
            target_generation_root: request.target_generation_root.clone(),
            prior_server_executable: request.prior_server_executable.clone(),
            target_server_executable: request.target_server_executable.clone(),
            prior_runtime: request.prior_runtime.clone(),
            target_runtime: request.target_runtime.clone(),
            prior_node: request.prior_node.clone(),
            target_node: request.target_node.clone(),
            prior_live: request.prior_live.clone(),
            controls: request.controls.clone(),
            launch_protocol_version: Some("2".to_string()),
            candidate: None,
            relaunch_attempts: Vec::new(),
            launch_attempts: Vec::new(),
            phase: TransactionPhase::Prepared,
            finalized: false,
        };
        record.validate()?;
        Ok(record)
    }

    pub fn validate(&self) -> Result<()> {
        if self.schema_version != "1"
            || self.transaction_id.is_empty()
            || self.transaction_id.contains('/')
            || self.nonce.is_empty()
        {
            return Err(DeployError::Journal(
                "transaction identity is incomplete or malformed".to_string(),
            ));
        }
        validate_generation_id(&self.prior_generation_id)?;
        validate_generation_id(&self.target_generation_id)?;
        if self.prior_generation_id == self.target_generation_id {
            return Err(DeployError::Journal(
                "prior and target generations must be distinct".to_string(),
            ));
        }
        let prior_port_root =
            generation_port_root(&self.prior_generation_root, &self.prior_generation_id)?;
        let target_port_root =
            generation_port_root(&self.target_generation_root, &self.target_generation_id)?;
        if prior_port_root != target_port_root {
            return Err(DeployError::Journal(
                "prior and target generations belong to different deployment stores".to_string(),
            ));
        }
        validate_port_root(prior_port_root, self.port)?;
        for executable in [
            &self.prior_server_executable,
            &self.target_server_executable,
        ] {
            if executable.sha256.len() != 64
                || executable.mode & 0o111 == 0
                || executable.mode & !0o7777 != 0
            {
                return Err(DeployError::Journal(
                    "generation server executable identity is malformed".to_string(),
                ));
            }
        }
        validate_expected_runtime(&self.prior_runtime, &self.prior_generation_root)?;
        validate_expected_runtime(&self.target_runtime, &self.target_generation_root)?;
        validate_node_prerequisite(&self.prior_node, &self.prior_runtime)?;
        validate_node_prerequisite(&self.target_node, &self.target_runtime)?;
        self.controls.validate(&self.transaction_id)?;
        if self
            .launch_protocol_version
            .as_deref()
            .is_some_and(|version| version != "2")
        {
            return Err(DeployError::Journal(
                "launch protocol version is unsupported".to_string(),
            ));
        }
        if self.controls.directory
            != prior_port_root
                .join("transactions")
                .join(&self.transaction_id)
        {
            return Err(DeployError::Journal(
                "transaction controls are outside the exact deployment store".to_string(),
            ));
        }
        self.prior_live.validate()?;
        if self.prior_live.selected_generation_id != self.prior_generation_id
            || self.prior_live.running_server_generation_id.is_none()
            || self.prior_live.process_identity.is_none()
        {
            return Err(DeployError::Journal(
                "prior live receipt is not bound to the prior selected generation and an exact running process"
                    .to_string(),
            ));
        }
        if let Some(candidate) = &self.candidate {
            validate_candidate(self, candidate)?;
        }
        if self.mode == UpdateMode::ClientOnly && self.candidate.is_some() {
            return Err(DeployError::Journal(
                "client-only transaction must not own a server candidate".to_string(),
            ));
        }
        for process in &self.relaunch_attempts {
            if self.mode == UpdateMode::ClientOnly {
                return Err(DeployError::Journal(
                    "relaunch evidence is invalid for this transaction phase".to_string(),
                ));
            }
            let prior = self.phase != TransactionPhase::ActivationConfirmed;
            validate_generation_process(self, process, prior)?;
        }
        let mut claim_ids = BTreeSet::new();
        for (index, attempt) in self.launch_attempts.iter().enumerate() {
            let expected_id = format!("{}-{index}", attempt.lane.as_str());
            if attempt.attempt_id != expected_id
                || attempt.ready_file
                    != self
                        .controls
                        .directory
                        .join(format!("launch-{expected_id}.json"))
            {
                return Err(DeployError::Journal(
                    "launch attempt identity or receipt path is not deterministic".to_string(),
                ));
            }
            if let Some(claim) = attempt.claim() {
                claim.validate(self, attempt)?;
                if !claim_ids.insert(&claim.claim_id) {
                    return Err(DeployError::Journal(
                        "launch claim identity is reused across attempts".to_string(),
                    ));
                }
            }
            if let LaunchAttemptState::Started {
                claim,
                process_identity,
            } = &attempt.state
            {
                if !executor_matches_process(&claim.executor, process_identity) {
                    return Err(DeployError::Journal(
                        "started process birth identity differs from its launch owner".to_string(),
                    ));
                }
            }
            if attempt.is_pending()
                && !match attempt.lane {
                    LaunchLane::TargetGated => self.phase == TransactionPhase::StartTargetIntent,
                    LaunchLane::PriorRollback => {
                        self.mode.changes_server() && self.phase <= TransactionPhase::Activated
                    }
                    LaunchLane::TargetRollForward => {
                        self.mode.changes_server()
                            && self.phase == TransactionPhase::ActivationConfirmed
                    }
                }
            {
                return Err(DeployError::Journal(
                    "unbound launch attempt is invalid for this transaction phase".to_string(),
                ));
            }
            if self.launch_protocol_version.is_some()
                && match attempt.lane {
                    LaunchLane::TargetGated => false,
                    LaunchLane::PriorRollback => {
                        self.phase > TransactionPhase::Activated
                            && self.phase != TransactionPhase::RollbackComplete
                    }
                    LaunchLane::TargetRollForward => {
                        self.phase != TransactionPhase::ActivationConfirmed
                    }
                }
            {
                return Err(DeployError::Journal(
                    "launch attempt lane is invalid for the durable phase".to_string(),
                ));
            }
            if let Some(process) = attempt.process_identity() {
                validate_generation_process(
                    self,
                    process,
                    attempt.lane == LaunchLane::PriorRollback,
                )?;
            }
        }
        let unresolved = self
            .launch_attempts
            .iter()
            .enumerate()
            .filter(|(_, attempt)| attempt.is_pending())
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        if unresolved.len() > 1
            || unresolved
                .first()
                .is_some_and(|index| *index + 1 != self.launch_attempts.len())
            || (self.finalized && !unresolved.is_empty())
        {
            return Err(DeployError::Journal(
                "at most one final launch attempt may remain unresolved".to_string(),
            ));
        }
        let ordinary_bound = self
            .launch_attempts
            .iter()
            .filter(|attempt| attempt.lane != LaunchLane::TargetGated)
            .filter_map(LaunchAttempt::process_identity)
            .collect::<Vec<_>>();
        if self.launch_protocol_version.is_some()
            && (ordinary_bound.len() != self.relaunch_attempts.len()
                || !ordinary_bound
                    .iter()
                    .zip(self.relaunch_attempts.iter())
                    .all(|(attempt, process)| *attempt == process))
        {
            return Err(DeployError::Journal(
                "ordinary launch attempts are not mirrored by relaunch evidence".to_string(),
            ));
        }
        let bound_gated = self
            .launch_attempts
            .iter()
            .filter(|attempt| attempt.lane == LaunchLane::TargetGated)
            .filter_map(LaunchAttempt::process_identity)
            .collect::<Vec<_>>();
        if self.launch_protocol_version.is_some()
            && match &self.candidate {
                None => !bound_gated.is_empty(),
                Some(candidate) => {
                    bound_gated.len() != 1
                        || bound_gated.first().copied() != Some(&candidate.process)
                }
            }
        {
            return Err(DeployError::Journal(
                "bound gated launch attempt is not mirrored by candidate evidence".to_string(),
            ));
        }
        if self.launch_protocol_version.is_some() {
            let has_prior = self
                .launch_attempts
                .iter()
                .any(|attempt| attempt.lane == LaunchLane::PriorRollback);
            let has_target_roll = self
                .launch_attempts
                .iter()
                .any(|attempt| attempt.lane == LaunchLane::TargetRollForward);
            let mut ordinary_seen = false;
            for attempt in &self.launch_attempts {
                if attempt.lane == LaunchLane::TargetGated {
                    if ordinary_seen {
                        return Err(DeployError::Journal(
                            "gated launch attempts must precede every ordinary lane".to_string(),
                        ));
                    }
                } else {
                    ordinary_seen = true;
                }
            }
            if has_prior && has_target_roll {
                return Err(DeployError::Journal(
                    "rollback and roll-forward launch lanes are mutually exclusive".to_string(),
                ));
            }
        }
        if self.phase >= TransactionPhase::TargetReadyGated
            && self.phase < TransactionPhase::RollbackComplete
            && self.mode.changes_server()
            && self.candidate.is_none()
        {
            return Err(DeployError::Journal(
                "target-ready and later server phases require candidate evidence".to_string(),
            ));
        }
        if self.finalized
            && !matches!(
                self.phase,
                TransactionPhase::ActivationConfirmed | TransactionPhase::RollbackComplete
            )
        {
            return Err(DeployError::Journal(
                "only terminal phases may be finalized".to_string(),
            ));
        }
        Ok(())
    }

    pub(crate) fn advanced(&self, phase: TransactionPhase) -> Result<Self> {
        if !valid_transition(self.mode, self.phase, phase) {
            return Err(DeployError::Journal(format!(
                "invalid transaction phase transition {:?} -> {:?}",
                self.phase, phase
            )));
        }
        let mut next = self.clone();
        next.phase = phase;
        next.validate()?;
        Ok(next)
    }

    pub(crate) fn finalized(&self) -> Result<Self> {
        let mut next = self.clone();
        next.finalized = true;
        next.validate()?;
        Ok(next)
    }

    pub(crate) fn with_relaunch_process(
        &self,
        process: crate::process_identity::ProcessIdentity,
    ) -> Result<Self> {
        if self.relaunch_attempts.last() == Some(&process) {
            return Ok(self.clone());
        }
        let mut next = self.clone();
        next.relaunch_attempts.push(process);
        next.validate()?;
        Ok(next)
    }

    pub(crate) fn active_relaunch_process(
        &self,
    ) -> Option<&crate::process_identity::ProcessIdentity> {
        self.relaunch_attempts.last()
    }

    pub(crate) fn active_relaunch_lane(&self) -> Option<LaunchLane> {
        let active = self.active_relaunch_process()?;
        self.launch_attempts
            .iter()
            .rev()
            .find(|attempt| attempt.process_identity() == Some(active))
            .map(|attempt| attempt.lane)
    }

    pub(crate) fn pending_launch_attempt(&self) -> Option<&LaunchAttempt> {
        self.launch_attempts
            .last()
            .filter(|attempt| attempt.is_pending())
    }

    pub(crate) fn with_new_launch_attempt(&self, lane: LaunchLane) -> Result<Self> {
        if self.pending_launch_attempt().is_some() {
            return Err(DeployError::Journal(
                "cannot create a second unbound launch attempt".to_string(),
            ));
        }
        let attempt_id = format!("{}-{}", lane.as_str(), self.launch_attempts.len());
        let mut next = self.clone();
        next.launch_attempts.push(LaunchAttempt {
            ready_file: self
                .controls
                .directory
                .join(format!("launch-{attempt_id}.json")),
            attempt_id,
            lane,
            state: LaunchAttemptState::Unclaimed,
        });
        next.validate()?;
        Ok(next)
    }

    pub(crate) fn with_launch_owned(&self, claim: LaunchClaim) -> Result<Self> {
        let mut next = self.clone();
        let attempt = next.launch_attempts.last_mut().ok_or_else(|| {
            DeployError::Journal("cannot resolve a missing launch attempt".to_string())
        })?;
        if !matches!(attempt.state, LaunchAttemptState::Unclaimed) {
            return Err(DeployError::Journal(
                "only an unclaimed launch attempt can acquire an owner".to_string(),
            ));
        }
        attempt.state = LaunchAttemptState::Owned { claim };
        next.validate()?;
        Ok(next)
    }

    pub(crate) fn with_launch_definitely_not_started(&self, claim: LaunchClaim) -> Result<Self> {
        let mut next = self.clone();
        let attempt = next.launch_attempts.last_mut().ok_or_else(|| {
            DeployError::Journal("cannot resolve a missing launch attempt".to_string())
        })?;
        if !matches!(
            &attempt.state,
            LaunchAttemptState::Owned {
                claim: existing_claim
            } if existing_claim == &claim
        ) {
            return Err(DeployError::Journal(
                "only the exact owned launch can become not-started".to_string(),
            ));
        }
        attempt.state = LaunchAttemptState::DefinitelyNotStarted { claim };
        next.validate()?;
        Ok(next)
    }

    pub(crate) fn with_bound_gated_candidate(
        &self,
        claim: LaunchClaim,
        candidate: CandidateEvidence,
    ) -> Result<Self> {
        let mut next = self.clone();
        let attempt = next.launch_attempts.last_mut().ok_or_else(|| {
            DeployError::Journal("cannot bind a missing gated launch attempt".to_string())
        })?;
        if attempt.lane != LaunchLane::TargetGated
            || !matches!(
                &attempt.state,
                LaunchAttemptState::Owned {
                    claim: existing_claim
                } if existing_claim == &claim
            )
        {
            return Err(DeployError::Journal(
                "active launch attempt is not the exact owned gated target".to_string(),
            ));
        }
        attempt.state = LaunchAttemptState::Started {
            claim,
            process_identity: Box::new(candidate.process.clone()),
        };
        next.candidate = Some(candidate);
        next.phase = TransactionPhase::TargetReadyGated;
        if !valid_transition(self.mode, self.phase, next.phase) {
            return Err(DeployError::Journal(
                "gated launch binding cannot advance this phase".to_string(),
            ));
        }
        next.validate()?;
        Ok(next)
    }

    pub(crate) fn with_bound_relaunch_attempt(
        &self,
        claim: LaunchClaim,
        process: crate::process_identity::ProcessIdentity,
    ) -> Result<Self> {
        let mut next = self.clone();
        let attempt = next.launch_attempts.last_mut().ok_or_else(|| {
            DeployError::Journal("cannot bind a missing ordinary launch attempt".to_string())
        })?;
        if attempt.lane == LaunchLane::TargetGated
            || !matches!(
                &attempt.state,
                LaunchAttemptState::Owned {
                    claim: existing_claim
                } if existing_claim == &claim
            )
        {
            return Err(DeployError::Journal(
                "active launch attempt is not the exact owned ordinary relaunch".to_string(),
            ));
        }
        attempt.state = LaunchAttemptState::Started {
            claim,
            process_identity: Box::new(process.clone()),
        };
        next.relaunch_attempts.push(process);
        next.validate()?;
        Ok(next)
    }

    pub(crate) fn expected_prior_process(&self) -> &crate::process_identity::ProcessIdentity {
        self.prior_live
            .process_identity
            .as_ref()
            .expect("validated prior process identity")
    }

    pub(crate) fn prior_running_generation_id(&self) -> &str {
        self.prior_live
            .running_server_generation_id
            .as_deref()
            .expect("validated prior running generation identity")
    }

    pub(crate) fn port_root(&self) -> Result<&Path> {
        let prior = generation_port_root(&self.prior_generation_root, &self.prior_generation_id)?;
        let target =
            generation_port_root(&self.target_generation_root, &self.target_generation_id)?;
        if prior != target {
            return Err(DeployError::Journal(
                "transaction generation stores disagree".to_string(),
            ));
        }
        Ok(prior)
    }
}

impl LaunchLane {
    fn as_str(self) -> &'static str {
        match self {
            Self::TargetGated => "target-gated",
            Self::PriorRollback => "prior-rollback",
            Self::TargetRollForward => "target-roll-forward",
        }
    }
}

fn executor_matches_process(
    executor: &LaunchExecutorIdentity,
    process: &crate::process_identity::ProcessIdentity,
) -> bool {
    executor.pid == process.pid
        && executor.kernel_boot_id == process.kernel_boot_id
        && executor.start_time_ticks == process.start_time_ticks
        && executor.executable == process.executable
        && executor.cwd == process.cwd
        && executor.effective_uid == process.effective_uid
}

pub(crate) fn validate_candidate(
    record: &TransactionRecord,
    candidate: &CandidateEvidence,
) -> Result<()> {
    let address = candidate.validate()?;
    if candidate.ready.nonce != record.nonce
        || candidate.ready.server_process_generation_id != record.target_generation_id
        || address.port() != record.port.get()
        || candidate.process.listener.port != record.port
        || Path::new(&candidate.process.cwd) != record.target_generation_root
        || candidate.process.executable != record.target_server_executable
        || stable_client_path(&record.target_generation_root).as_deref()
            != Some(Path::new(&candidate.process.runtime.client_dir))
        || !runtime_matches_generation(
            &candidate.process.runtime,
            &record.target_runtime,
            &record.target_generation_root,
        )
    {
        return Err(DeployError::Journal(
            "candidate evidence does not match transaction nonce/generation/port/executable/runtime"
                .to_string(),
        ));
    }
    if let Some(expected) = &record.candidate {
        if expected != candidate {
            return Err(DeployError::Journal(
                "candidate evidence changed during the transaction".to_string(),
            ));
        }
    }
    Ok(())
}

fn validate_expected_runtime(
    runtime: &crate::process_identity::RuntimeProvenance,
    root: &Path,
) -> Result<()> {
    let generation_paths = [
        &runtime.client_dir,
        &runtime.extensions_dir,
        &runtime.dist_server_dir,
        &runtime.mcp_entry,
        &runtime.claude_sidecar_entry,
        &runtime.package_json,
        &runtime.package_lock,
        &runtime.production_node_modules,
    ];
    if generation_paths.into_iter().any(|actual| {
        let actual = Path::new(actual);
        !actual.is_absolute()
            || actual == root
            || !actual.starts_with(root)
            || !actual.components().all(|component| {
                matches!(
                    component,
                    std::path::Component::RootDir | std::path::Component::Normal(_)
                )
            })
    }) || !Path::new(&runtime.node_executable).is_absolute()
    {
        return Err(DeployError::Journal(
            "expected runtime closure escapes its immutable generation".to_string(),
        ));
    }
    Ok(())
}

fn validate_node_prerequisite(
    node: &crate::legacy::NodePrerequisite,
    runtime: &crate::process_identity::RuntimeProvenance,
) -> Result<()> {
    if !node.executable.is_absolute()
        || node.version.is_empty()
        || node.executable != Path::new(&runtime.node_executable)
    {
        return Err(DeployError::Journal(
            "Node prerequisite is incomplete or disagrees with runtime provenance".to_string(),
        ));
    }
    Ok(())
}

pub(crate) fn runtime_matches_generation(
    actual: &crate::process_identity::RuntimeProvenance,
    expected: &crate::process_identity::RuntimeProvenance,
    root: &Path,
) -> bool {
    let stable_client = root
        .parent()
        .and_then(Path::parent)
        .map(|port_root| port_root.join("current/client"));
    (actual.client_dir == expected.client_dir
        || stable_client.as_deref() == Some(Path::new(&actual.client_dir)))
        && actual.extensions_dir == expected.extensions_dir
        && actual.dist_server_dir == expected.dist_server_dir
        && actual.mcp_entry == expected.mcp_entry
        && actual.claude_sidecar_entry == expected.claude_sidecar_entry
        && actual.node_executable == expected.node_executable
        && actual.package_json == expected.package_json
        && actual.package_lock == expected.package_lock
        && actual.production_node_modules == expected.production_node_modules
}

fn stable_client_path(root: &Path) -> Option<PathBuf> {
    root.parent()
        .and_then(Path::parent)
        .map(|port_root| port_root.join("current/client"))
}

pub(crate) fn live_runtime(
    expected: &crate::process_identity::RuntimeProvenance,
    root: &Path,
) -> Result<crate::process_identity::RuntimeProvenance> {
    let mut runtime = expected.clone();
    runtime.client_dir = stable_client_path(root)
        .ok_or_else(|| DeployError::Journal("generation has no stable client path".to_string()))?
        .display()
        .to_string();
    Ok(runtime)
}

pub(crate) fn validate_generation_process(
    record: &TransactionRecord,
    process: &crate::process_identity::ProcessIdentity,
    prior: bool,
) -> Result<()> {
    process.validate()?;
    let (id, root, executable, runtime) = if prior {
        (
            &record.prior_generation_id,
            &record.prior_generation_root,
            &record.prior_server_executable,
            &record.prior_runtime,
        )
    } else {
        (
            &record.target_generation_id,
            &record.target_generation_root,
            &record.target_server_executable,
            &record.target_runtime,
        )
    };
    if process.listener.port != record.port
        || Path::new(&process.cwd) != root
        || process.executable != *executable
        || stable_client_path(root).as_deref() != Some(Path::new(&process.runtime.client_dir))
        || !runtime_matches_generation(&process.runtime, runtime, root)
    {
        return Err(DeployError::Recovery(format!(
            "relaunched generation {id} escaped its immutable generation root"
        )));
    }
    Ok(())
}

fn generation_port_root<'a>(root: &'a Path, id: &str) -> Result<&'a Path> {
    if !root.is_absolute()
        || root.file_name().and_then(|name| name.to_str()) != Some(id)
        || root
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            != Some("generations")
    {
        return Err(DeployError::Journal(format!(
            "generation root is not the immutable generations/{id} path"
        )));
    }
    root.parent()
        .and_then(Path::parent)
        .ok_or_else(|| DeployError::Journal("generation has no deployment port root".to_string()))
}

fn validate_port_root(root: &Path, port: crate::paths::DeployPort) -> Result<()> {
    let expected_port = port.to_string();
    if root.file_name().and_then(|name| name.to_str()) != Some(expected_port.as_str())
        || root
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            != Some("ports")
        || root
            .parent()
            .and_then(Path::parent)
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            != Some(".freshell-deploy")
    {
        return Err(DeployError::Journal(format!(
            "transaction store root is not .freshell-deploy/ports/{port}"
        )));
    }
    Ok(())
}

fn valid_transition(mode: UpdateMode, from: TransactionPhase, to: TransactionPhase) -> bool {
    if from == to {
        return true;
    }
    if to == TransactionPhase::RollbackComplete && from < TransactionPhase::ActivationConfirmed {
        return true;
    }
    match mode {
        UpdateMode::ClientOnly => matches!(
            (from, to),
            (
                TransactionPhase::Prepared,
                TransactionPhase::SwitchCurrentIntent
            ) | (
                TransactionPhase::SwitchCurrentIntent,
                TransactionPhase::Activated
            ) | (
                TransactionPhase::Activated,
                TransactionPhase::ActivationConfirmed
            )
        ),
        UpdateMode::Server | UpdateMode::Full => matches!(
            (from, to),
            (TransactionPhase::Prepared, TransactionPhase::StopOldIntent)
                | (
                    TransactionPhase::StopOldIntent,
                    TransactionPhase::StartTargetIntent
                )
                | (
                    TransactionPhase::StartTargetIntent,
                    TransactionPhase::TargetReadyGated
                )
                | (
                    TransactionPhase::TargetReadyGated,
                    TransactionPhase::SwitchCurrentIntent
                )
                | (
                    TransactionPhase::SwitchCurrentIntent,
                    TransactionPhase::ActivationAuthorized
                )
                | (
                    TransactionPhase::ActivationAuthorized,
                    TransactionPhase::Activated
                )
                | (
                    TransactionPhase::Activated,
                    TransactionPhase::ActivationConfirmed
                )
        ),
    }
}

pub trait TransactionJournal {
    fn load(&self) -> Result<Option<TransactionRecord>>;
    fn begin(&mut self, record: &TransactionRecord) -> Result<()>;
    fn save(&mut self, record: &TransactionRecord) -> Result<()>;
}

#[derive(Debug, Clone)]
pub struct DurableTransactionJournal {
    path: PathBuf,
}

impl DurableTransactionJournal {
    pub fn new(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        if !path.is_absolute()
            || path.file_name().and_then(|name| name.to_str()) != Some("transaction.json")
        {
            return Err(DeployError::Journal(
                "journal path must be an absolute transaction.json".to_string(),
            ));
        }
        Ok(Self {
            path: path.to_path_buf(),
        })
    }

    fn publish(&self, record: &TransactionRecord) -> Result<()> {
        record.validate()?;
        if self.path != record.port_root()?.join("transaction.json") {
            return Err(DeployError::Journal(
                "journal path is outside the transaction deployment store".to_string(),
            ));
        }
        validate_private_transaction_store(record)?;
        let mut bytes =
            serde_json::to_vec(record).map_err(|error| DeployError::Journal(error.to_string()))?;
        bytes.push(b'\n');
        match atomic_write(&self.path, &bytes, 0o600) {
            Ok(()) => Ok(()),
            Err(DeployError::StorageAmbiguous { .. }) => {
                let actual = read_private_file(&self.path)?.ok_or_else(|| {
                    DeployError::Journal(
                        "ambiguous journal publication left no reconcilable file".to_string(),
                    )
                })?;
                if actual != bytes {
                    return Err(DeployError::Journal(
                        "ambiguous journal publication does not contain exact intended bytes"
                            .to_string(),
                    ));
                }
                sync_directory(
                    self.path
                        .parent()
                        .expect("validated absolute journal has parent"),
                )
                .map_err(|error| {
                    DeployError::Journal(format!(
                        "cannot durably reconcile exact journal bytes: {error}"
                    ))
                })
            }
            Err(error) => Err(error),
        }
    }
}

impl TransactionJournal for DurableTransactionJournal {
    fn load(&self) -> Result<Option<TransactionRecord>> {
        let Some(bytes) = read_durable_private_file(&self.path)? else {
            return Ok(None);
        };
        let record: TransactionRecord = serde_json::from_slice(&bytes)
            .map_err(|error| DeployError::Journal(error.to_string()))?;
        record.validate()?;
        if self.path != record.port_root()?.join("transaction.json") {
            return Err(DeployError::Journal(
                "loaded journal is outside the transaction deployment store".to_string(),
            ));
        }
        validate_private_transaction_store(&record)?;
        Ok(Some(record))
    }

    fn begin(&mut self, record: &TransactionRecord) -> Result<()> {
        if let Some(existing) = self.load()? {
            if !existing.finalized && existing.phase != TransactionPhase::RollbackComplete {
                return Err(DeployError::Journal(format!(
                    "unfinished transaction {} requires recovery",
                    existing.transaction_id
                )));
            }
        }
        record.controls.require_pristine()?;
        self.publish(record)
    }

    fn save(&mut self, record: &TransactionRecord) -> Result<()> {
        let existing = self.load()?.ok_or_else(|| {
            DeployError::Journal("cannot advance a missing transaction".to_string())
        })?;
        let immutable_identity_matches = existing.schema_version == record.schema_version
            && existing.transaction_id == record.transaction_id
            && existing.nonce == record.nonce
            && existing.port == record.port
            && existing.mode == record.mode
            && existing.prior_generation_id == record.prior_generation_id
            && existing.target_generation_id == record.target_generation_id
            && existing.prior_generation_root == record.prior_generation_root
            && existing.target_generation_root == record.target_generation_root
            && existing.prior_server_executable == record.prior_server_executable
            && existing.target_server_executable == record.target_server_executable
            && existing.prior_runtime == record.prior_runtime
            && existing.target_runtime == record.target_runtime
            && existing.prior_node == record.prior_node
            && existing.target_node == record.target_node
            && existing.prior_live == record.prior_live
            && existing.controls == record.controls
            && existing.launch_protocol_version == record.launch_protocol_version;
        let candidate_matches = existing.candidate == record.candidate
            || (existing.candidate.is_none()
                && record.candidate.is_some()
                && existing.phase == TransactionPhase::StartTargetIntent
                && record.phase == TransactionPhase::TargetReadyGated);
        let protocol_candidate_matches = existing.launch_protocol_version.is_none()
            || candidate_advance_matches_gated_binding(&existing, record);
        let relaunch_matches = record
            .relaunch_attempts
            .starts_with(&existing.relaunch_attempts)
            && record.relaunch_attempts.len() <= existing.relaunch_attempts.len() + 1
            && (record.relaunch_attempts.len() == existing.relaunch_attempts.len()
                || existing.phase == record.phase);
        let launch_matches = launch_attempts_advance_monotonically(
            &existing.launch_attempts,
            &record.launch_attempts,
        ) && (existing.launch_attempts == record.launch_attempts
            || existing.phase == record.phase
            || (existing.phase == TransactionPhase::StartTargetIntent
                && record.phase == TransactionPhase::TargetReadyGated));
        let protocol_relaunch_matches = existing.launch_protocol_version.is_none()
            || relaunch_advance_matches_launch_binding(&existing, record);
        let finalization_is_monotonic = if existing.finalized == record.finalized {
            true
        } else {
            !existing.finalized
                && record.finalized
                && existing.phase == record.phase
                && existing.candidate == record.candidate
                && existing.relaunch_attempts == record.relaunch_attempts
                && existing.launch_attempts == record.launch_attempts
        };
        if !immutable_identity_matches
            || !candidate_matches
            || !protocol_candidate_matches
            || !relaunch_matches
            || !launch_matches
            || !protocol_relaunch_matches
            || !finalization_is_monotonic
            || !valid_transition(record.mode, existing.phase, record.phase)
        {
            return Err(DeployError::Journal(
                "journal replacement changes immutable evidence or does not advance the active transaction"
                    .to_string(),
            ));
        }
        self.publish(record)
    }
}

fn candidate_advance_matches_gated_binding(
    existing: &TransactionRecord,
    next: &TransactionRecord,
) -> bool {
    let candidate_added = existing.candidate.is_none() && next.candidate.is_some();
    let gated_bound = existing.launch_attempts.len() == next.launch_attempts.len()
        && existing
            .launch_attempts
            .last()
            .zip(next.launch_attempts.last())
            .is_some_and(|(old, new)| {
                old.attempt_id == new.attempt_id
                    && old.lane == LaunchLane::TargetGated
                    && matches!(old.state, LaunchAttemptState::Owned { .. })
                    && new.process_identity()
                        == next.candidate.as_ref().map(|candidate| &candidate.process)
            });
    candidate_added == gated_bound
}

fn relaunch_advance_matches_launch_binding(
    existing: &TransactionRecord,
    next: &TransactionRecord,
) -> bool {
    let relaunch_added = next.relaunch_attempts.len() == existing.relaunch_attempts.len() + 1;
    let launch_bound = existing.launch_attempts.len() == next.launch_attempts.len()
        && existing
            .launch_attempts
            .last()
            .zip(next.launch_attempts.last())
            .is_some_and(|(old, new)| {
                old.attempt_id == new.attempt_id
                    && old.lane == new.lane
                    && old.lane != LaunchLane::TargetGated
                    && matches!(old.state, LaunchAttemptState::Owned { .. })
                    && new.process_identity() == next.relaunch_attempts.last()
            });
    relaunch_added == launch_bound
}

fn launch_attempts_advance_monotonically(
    existing: &[LaunchAttempt],
    next: &[LaunchAttempt],
) -> bool {
    if next.len() < existing.len() || next.len() > existing.len() + 1 {
        return false;
    }
    let mut changed_existing = false;
    for (index, old) in existing.iter().enumerate() {
        let Some(new) = next.get(index) else {
            return false;
        };
        if old == new {
            continue;
        }
        changed_existing = true;
        let valid_state_edge = match (&old.state, &new.state) {
            (LaunchAttemptState::Unclaimed, LaunchAttemptState::Owned { .. }) => true,
            (
                LaunchAttemptState::Owned { claim: old_claim },
                LaunchAttemptState::Started {
                    claim: new_claim, ..
                }
                | LaunchAttemptState::DefinitelyNotStarted { claim: new_claim },
            ) => old_claim == new_claim,
            _ => false,
        };
        if index + 1 != existing.len()
            || old.attempt_id != new.attempt_id
            || old.ready_file != new.ready_file
            || old.lane != new.lane
            || !valid_state_edge
        {
            return false;
        }
    }
    if next.len() > existing.len() && changed_existing {
        return false;
    }
    next.len() == existing.len()
        || next
            .last()
            .is_some_and(|attempt| matches!(attempt.state, LaunchAttemptState::Unclaimed))
}

fn validate_private_transaction_store(record: &TransactionRecord) -> Result<()> {
    let port_root = record.port_root()?;
    let ports = port_root
        .parent()
        .ok_or_else(|| DeployError::Journal("port root has no ports directory".to_string()))?;
    let deploy_root = ports
        .parent()
        .ok_or_else(|| DeployError::Journal("ports directory has no deploy root".to_string()))?;
    let transactions = port_root.join("transactions");
    for (label, path) in [
        ("deploy root", deploy_root),
        ("ports directory", ports),
        ("port root", port_root),
        ("transactions directory", transactions.as_path()),
        (
            "transaction control directory",
            record.controls.directory.as_path(),
        ),
    ] {
        let metadata = fs::symlink_metadata(path).map_err(|error| {
            DeployError::Journal(format!("cannot inspect private {label}: {error}"))
        })?;
        if !metadata.is_dir()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o7777 != 0o700
        {
            return Err(DeployError::Journal(format!(
                "{label} is not an owned private directory: {}",
                path.display()
            )));
        }
    }
    Ok(())
}

fn read_private_file(path: &Path) -> Result<Option<Vec<u8>>> {
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
        || metadata.mode() & 0o7777 != 0o600
    {
        return Err(DeployError::Journal(format!(
            "journal is not a private owned regular file: {}",
            path.display()
        )));
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(Some(bytes))
}

fn read_durable_private_file(path: &Path) -> Result<Option<Vec<u8>>> {
    read_durable_private_file_with_sync(path, sync_directory)
}

fn read_durable_private_file_with_sync(
    path: &Path,
    sync_parent: impl Fn(&Path) -> Result<()>,
) -> Result<Option<Vec<u8>>> {
    let parent = path
        .parent()
        .ok_or_else(|| DeployError::UnsafeStorePath(path.to_path_buf()))?;
    let mut file = match fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(path)
    {
        Ok(file) => Some(file),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };

    // Acquiring authority from visible journal bytes also reconciles a prior
    // publisher that crashed after rename but before its parent-directory
    // fsync. No terminal phase is trusted until that ambiguity is resolved.
    if let Some(opened) = file.as_ref() {
        opened
            .sync_all()
            .map_err(|error| DeployError::StorageAmbiguous {
                operation: "journal authority file sync",
                path: path.to_path_buf(),
                cause: error.to_string(),
            })?;
    }
    sync_parent(parent).map_err(|error| DeployError::StorageAmbiguous {
        operation: "journal authority parent sync",
        path: path.to_path_buf(),
        cause: error.to_string(),
    })?;

    if file.is_none() {
        // Re-open after the parent sync so an entry published concurrently
        // with the first lookup cannot be reported as durably absent.
        file = match fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(path)
        {
            Ok(file) => Some(file),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let opened = file.as_ref().expect("successful reopen returned a file");
        opened
            .sync_all()
            .map_err(|error| DeployError::StorageAmbiguous {
                operation: "journal authority file sync",
                path: path.to_path_buf(),
                cause: error.to_string(),
            })?;
        sync_parent(parent).map_err(|error| DeployError::StorageAmbiguous {
            operation: "journal authority parent resync",
            path: path.to_path_buf(),
            cause: error.to_string(),
        })?;
    }

    let mut file = file.expect("missing file returned above");
    let opened_metadata = file.metadata()?;
    if !opened_metadata.is_file()
        || opened_metadata.uid() != unsafe { libc::geteuid() }
        || opened_metadata.mode() & 0o7777 != 0o600
    {
        return Err(DeployError::Journal(format!(
            "journal is not a private owned regular file: {}",
            path.display()
        )));
    }
    let visible_metadata = fs::symlink_metadata(path)?;
    if visible_metadata.file_type().is_symlink()
        || visible_metadata.dev() != opened_metadata.dev()
        || visible_metadata.ino() != opened_metadata.ino()
    {
        return Err(DeployError::StorageAmbiguous {
            operation: "journal authority pathname revalidation",
            path: path.to_path_buf(),
            cause: "journal pathname changed while acquiring authority".to_string(),
        });
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(Some(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn durable_load_refuses_visible_bytes_when_parent_sync_is_ambiguous() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("transaction.json");
        fs::write(&path, b"{\"phase\":\"rollback_complete\"}\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();

        let error = read_durable_private_file_with_sync(&path, |_| {
            Err(DeployError::Io(std::io::Error::other(
                "injected parent sync failure",
            )))
        })
        .unwrap_err();

        assert!(matches!(
            error,
            DeployError::StorageAmbiguous {
                operation: "journal authority parent sync",
                ..
            }
        ));
    }
}

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
}

impl ControlPaths {
    pub fn new(directory: impl AsRef<Path>) -> Self {
        let directory = directory.as_ref().to_path_buf();
        Self {
            ready_file: directory.join("ready.json"),
            authorization_file: directory.join("authorize.json"),
            activated_file: directory.join("activated.json"),
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
    pub candidate: Option<CandidateEvidence>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub relaunch_attempts: Vec<crate::process_identity::ProcessIdentity>,
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
            candidate: None,
            relaunch_attempts: Vec::new(),
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
            if self.mode == UpdateMode::ClientOnly || self.phase == TransactionPhase::Activated {
                return Err(DeployError::Journal(
                    "relaunch evidence is invalid for this transaction phase".to_string(),
                ));
            }
            let prior = self.phase != TransactionPhase::ActivationConfirmed;
            validate_generation_process(self, process, prior)?;
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

    pub(crate) fn with_candidate(
        &self,
        candidate: CandidateEvidence,
        phase: TransactionPhase,
    ) -> Result<Self> {
        let mut next = self.clone();
        next.candidate = Some(candidate);
        next.phase = phase;
        if !valid_transition(self.mode, self.phase, phase) {
            return Err(DeployError::Journal(format!(
                "invalid candidate phase transition {:?} -> {:?}",
                self.phase, phase
            )));
        }
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

fn stable_client_path(root: &Path) -> Option<PathBuf> {
    root.parent()
        .and_then(Path::parent)
        .map(|port_root| port_root.join("current/client"))
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
        let Some(bytes) = read_private_file(&self.path)? else {
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
            && existing.controls == record.controls;
        let candidate_matches = existing.candidate == record.candidate
            || (existing.candidate.is_none()
                && record.candidate.is_some()
                && existing.phase == TransactionPhase::StartTargetIntent
                && record.phase == TransactionPhase::TargetReadyGated);
        let relaunch_matches = record
            .relaunch_attempts
            .starts_with(&existing.relaunch_attempts)
            && record.relaunch_attempts.len() <= existing.relaunch_attempts.len() + 1
            && (record.relaunch_attempts.len() == existing.relaunch_attempts.len()
                || existing.phase == record.phase);
        let finalization_is_monotonic = !existing.finalized
            || (record.finalized
                && existing.phase == record.phase
                && existing.candidate == record.candidate);
        if !immutable_identity_matches
            || !candidate_matches
            || !relaunch_matches
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

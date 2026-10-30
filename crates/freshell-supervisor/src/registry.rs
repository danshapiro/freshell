use crate::admission::{AdmissionPolicy, ReservationTotals};
use crate::opencode_transfer::OpenCodeTransferStageReferences;
use crate::recovery_retry::{self, RecoveryRetry, TransientRecoveryFailure};
use freshell_runtime_protocol::{
    AllocationState, CleanupState, DesiredState, DockerDaemonId, DurabilityState, FixtureKind,
    FreshAgentLaunchSpec, FreshAgentTurnSettings, FreshProvider, GrantId, HostBootId,
    IncarnationId, IncidentId, InstallationId, LaunchNonce, LaunchState, LostSoulRepairTarget,
    NoticeId, OpenCodeAdoptionBaseline, OpenCodeTransferDescriptor, RecoveryAttemptId,
    RecoveryBlockReason, RecoveryPath, RecoveryState, RecoveryTrigger, RequestId,
    RestoreLostSoulsRequest, ResumeSpec, RuntimeLimits, RuntimeProfile, RuntimeView, SoulId,
    StopOutcome, TerminalLaunchSpec, ViewIntentRequest,
};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::OpenOptions,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

pub const SCHEMA_VERSION: u32 = 19;
mod input_reservation;
pub(crate) use input_reservation::binary_digest;
pub use input_reservation::{BoundInputReservation, OwnedInputReservation};
const ACTIVE_STATES: &str = "'prepared','created','starting','running','stopping'";

// Both capture phases validate their complete fence inside the same immediate
// transaction as the existing resume-spec identity check and persistence.
#[derive(Clone, Copy)]
enum ResumeSpecCapturePhase {
    ActiveIncarnation,
    RecoveryPrior,
}

enum NativeSessionTransitionEvidence {
    Operation(Option<freshell_runtime_protocol::ClaudeForkRecipe>),
    ClaudeClear(freshell_runtime_protocol::NativeIdentityObservation),
}

type ExistingSoulLaunchRow = (
    String,
    String,
    String,
    String,
    Option<String>,
    u64,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
);
type NativeImportObservationRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    bool,
    String,
    u64,
);
type RecoveryRevisionFenceRow = (u64, u64, u64, u64, u64, Option<String>, String);
type LiveNativeObservationRow = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    u64,
    String,
);
type StoppedRepairStartStateRow = (
    String,
    String,
    String,
    u64,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
);
type StoppedRepairTargetReceiptFenceRow = (
    String,
    String,
    String,
    Option<String>,
    u64,
    u64,
    u64,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    u64,
    String,
    String,
);

#[derive(Debug, thiserror::Error)]
pub enum RegistryError {
    #[error("runtime registry is already owned by another supervisor")]
    Busy,
    #[error("runtime registry schema {found} is newer than supported schema {supported}")]
    NewerSchema { found: u32, supported: u32 },
    #[error("runtime registry integrity check failed: {0}")]
    Integrity(String),
    #[error("installation id does not match the existing registry")]
    InstallationMismatch,
    #[error("request id was reused with different semantic payload")]
    RequestConflict,
    #[error("another active incarnation already exists for soul {0}")]
    ActiveIncarnation(SoulId),
    #[error("managed runtime resource reservation exceeds {scope} budget")]
    BlockedResource { scope: &'static str },
    #[error("stale control epoch: expected {expected}, current {current}")]
    StaleControlEpoch { expected: u64, current: u64 },
    #[error("stale soul intent revision: expected {expected}, current {current}")]
    StaleIntentRevision { expected: u64, current: u64 },
    #[error("unknown incarnation {0}")]
    UnknownIncarnation(IncarnationId),
    #[error("unknown soul {0}")]
    UnknownSoul(SoulId),
    #[error("invalid registry state: {0}")]
    InvalidState(String),
    #[error("recovery is already in progress for soul {0}")]
    RecoveryInProgress(SoulId),
    #[error("recovery is blocked for soul {soul_id}: {reason}")]
    RecoveryBlocked { soul_id: SoulId, reason: String },
    #[error("native session identity conflicts with durable soul identity")]
    NativeIdentityConflict,
    #[error("loss certification is blocked: {0}")]
    LossCertificationBlocked(String),
    #[error("loss incident persistence failed: {0}")]
    IncidentPersistenceFailed(String),
    #[error("unknown loss incident {0}")]
    IncidentNotFound(IncidentId),
    #[error("unknown runtime notice {0}")]
    NoticeNotFound(NoticeId),
    #[error("managed rollout migration is blocked: {0}")]
    MigrationBlocked(String),
    #[error("runtime repair is blocked: {0}")]
    RepairBlocked(String),
    #[error("terminal input request id was reused with different data")]
    InputConflict,
    #[error("fault injected at registry barrier {0}")]
    FaultInjected(&'static str),
    #[error("registry I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("registry SQLite failed: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("registry JSON failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("registry blocking task failed: {0}")]
    Join(String),
}

#[derive(Clone)]
pub struct Registry {
    inner: Arc<RegistryInner>,
    #[cfg(test)]
    pub(crate) retry_clock: Option<Arc<std::sync::atomic::AtomicI64>>,
}

struct RegistryInner {
    db_path: PathBuf,
    installation_id: InstallationId,
    control_epoch: u64,
    /// Held for its `Drop`: the registry root stays owned until the last
    /// handle to this registry is gone.
    _owner_lock: OwnerLock,
}

/// Exclusive supervisor ownership of one registry root (`supervisor.lock`).
struct OwnerLock(std::fs::File);

impl OwnerLock {
    fn acquire(root: &Path) -> Result<Self, RegistryError> {
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(root.join("supervisor.lock"))?;
        match file.try_lock() {
            Ok(()) => Ok(Self(file)),
            Err(std::fs::TryLockError::WouldBlock) => Err(RegistryError::Busy),
            Err(std::fs::TryLockError::Error(error)) => Err(RegistryError::Io(error)),
        }
    }
}

impl Drop for OwnerLock {
    fn drop(&mut self) {
        // The lock belongs to the open file description, which every
        // duplicate descriptor shares, including the copy that a child
        // process spawned by any other thread holds between fork and exec
        // (close-on-exec only closes it at exec). Closing this descriptor
        // alone would keep the root owned until that child execs, so a
        // successor opening the registry right after this owner is gone
        // would be refused as Busy. Unlocking releases ownership now.
        if let Err(error) = self.0.unlock() {
            tracing::warn!(
                event = "runtime.registry.owner_lock_release_failed",
                error = %error,
                "Registry owner lock release failed; it is released when every duplicate descriptor closes"
            );
        }
    }
}

#[derive(Debug, Clone)]
pub struct LaunchPreparation {
    pub soul_id: SoulId,
    pub provider: String,
    pub provider_store_id: String,
    pub native_session_id: Option<String>,
    pub creation_seed_ref: String,
    pub request_id: RequestId,
    pub payload_digest: String,
    pub requested_limits: RuntimeLimits,
    pub profile: RuntimeProfile,
    pub project_key: String,
    pub fixture: Option<FixtureKind>,
    pub terminal: Option<TerminalLaunchSpec>,
    pub fresh_agent: Option<FreshAgentLaunchSpec>,
    pub view_intent: Option<ViewIntentRequest>,
    pub admission: AdmissionPolicy,
}

#[derive(Debug, Clone)]
pub struct PreparedLaunch {
    pub soul_id: SoulId,
    pub incarnation_id: IncarnationId,
    pub launch_nonce: LaunchNonce,
    pub state: LaunchState,
    pub intent_revision: u64,
    pub existing_request: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct StoppedRepairOperation {
    pub status: String,
    pub result_json: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct StoppedRepairOwnerCandidate {
    pub soul_id: SoulId,
    pub source_store_id: Option<String>,
    pub root_session_id: Option<String>,
    pub source_generation: Option<String>,
    pub native_import_state: NativeImportState,
    pub native_import_authority: String,
    pub explicit_view_count: u64,
}

/// Persisted, body-free evidence for one exact installed source generation.
/// The helper's environment paths are checked before constructing this value
/// and represented only by a digest here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct StoppedRepairRootReceipt {
    pub root_session_id: String,
    pub canonical_soul_id: SoulId,
    pub transfer_id: String,
    /// Passive, body-free evidence needed to revalidate this exact imported
    /// baseline on an explicit resume. Payload bytes are never persisted.
    pub adoption_baseline: OpenCodeAdoptionBaseline,
    pub destination_store_id: String,
    pub source_store_id: String,
    pub source_generation: String,
    pub bundle_sha256: String,
    pub source_schema_fingerprint: String,
    pub migration_journal_fingerprint: String,
    pub target_image_ref: String,
    pub target_build_receipt: String,
    pub row_count: u64,
    pub asset_count: u64,
    pub structural_sha256: String,
    pub provider_uid: u32,
    pub provider_gid: u32,
    pub reader_environment_sha256: String,
    pub captured_identity_revision: u64,
    pub captured_evidence_revision: u64,
    pub captured_intent_revision: u64,
    pub captured_native_import_revision: u64,
    pub captured_native_import_state: String,
    pub captured_native_import_authority: String,
    pub incarnation_id: IncarnationId,
    pub execution_generation: u64,
}

impl StoppedRepairRootReceipt {
    pub(crate) fn adoption_baseline_matches_receipt(&self) -> bool {
        let descriptor = &self.adoption_baseline.descriptor;
        self.adoption_baseline.validate().is_ok()
            && descriptor.transfer_id == self.transfer_id
            && descriptor.provider == "opencode"
            && descriptor.source_store_id == self.source_store_id
            && descriptor.root_session_id == self.root_session_id
            && descriptor.source_generation == self.source_generation
            && descriptor.source_schema_fingerprint == self.source_schema_fingerprint
            && descriptor.migration_journal_fingerprint == self.migration_journal_fingerprint
            && descriptor.destination_store_id == self.destination_store_id
            && descriptor.destination_database_path == ".local/share/opencode/opencode.db"
            && descriptor.target_image_ref == self.target_image_ref
            && descriptor.target_build_receipt == self.target_build_receipt
            && descriptor.incarnation_id == self.incarnation_id.as_str()
            && descriptor.bundle_sha256 == self.bundle_sha256
    }
}

#[derive(Debug, Clone)]
pub struct BackendCreatedRecord {
    pub daemon_id: DockerDaemonId,
    pub container_id: String,
    pub image_ref: String,
    pub runtime_dir: PathBuf,
    pub host_binary_path: PathBuf,
    pub immutable_config_digest: String,
    pub launch_policy: Option<freshell_runtime_protocol::RuntimeLaunchPolicy>,
}

#[derive(Debug, Clone)]
pub struct ExecutionGrantRecord {
    pub control_epoch: u64,
    pub execution_generation: u64,
    pub grant_id: GrantId,
    pub host_boot_id: HostBootId,
}

/// Capability proving that a mutation targets a container durably recorded by
/// this installation. Its fields are private and the constructor is crate-
/// private: callers cannot manufacture kill authority from a pid, label, name,
/// environment variable, or arbitrary container id.
#[derive(Debug, Clone)]
pub struct OwnedRuntimeHandle {
    installation_id: InstallationId,
    soul_id: SoulId,
    provider_store_id: String,
    incarnation_id: IncarnationId,
    launch_nonce: LaunchNonce,
    daemon_id: DockerDaemonId,
    container_id: String,
    image_ref: String,
    runtime_dir: PathBuf,
    host_binary_path: PathBuf,
    immutable_config_digest: String,
    launch_policy: Option<freshell_runtime_protocol::RuntimeLaunchPolicy>,
    requested_limits: RuntimeLimits,
    fixture: Option<FixtureKind>,
    terminal: Option<TerminalLaunchSpec>,
    fresh_agent: Option<FreshAgentLaunchSpec>,
    provider_volume_name: String,
    // Ordinary Stop alone needs this fence. Keep it off the already-large
    // handle carried through nested recovery futures and their polling stacks.
    ordinary_stop: Option<Box<StopFence>>,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct StopFence {
    pub intent_revision: u64,
    pub execution_generation: u64,
}

pub(crate) struct StopProgress {
    pub outcome: Option<StopOutcome>,
    pub capability: Option<(String, String)>,
    pub settled: bool,
}

/// Read-only association to the last committed terminal incarnation. This is
/// deliberately not an OwnedRuntimeHandle and cannot authorize input or stop.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalOutputReadFence {
    intent_revision: u64,
    identity_revision: u64,
    execution_generation: u64,
    host_boot_id: Option<HostBootId>,
}

#[derive(Clone)]
pub(crate) struct RetainedOutputSource {
    pub incarnation_id: IncarnationId,
    pub runtime_dir: PathBuf,
    pub terminal_id: String,
    pub stream_id: String,
    pub native_session_id: Option<String>,
    pub read_fence: TerminalOutputReadFence,
    // Read strategy and completion facts, captured with the owner snapshot.
    // Neither state transition grants a new output owner.
    pub stopped: bool,
    pub verified_empty: bool,
}

impl RetainedOutputSource {
    fn same_owner(&self, current: &Self) -> bool {
        // Stop settlement changes read strategy/completion, not ownership of
        // bytes accepted after its intent. Intent changes remain in the fence.
        self.incarnation_id == current.incarnation_id
            && self.runtime_dir == current.runtime_dir
            && self.terminal_id == current.terminal_id
            && self.stream_id == current.stream_id
            && self.native_session_id == current.native_session_id
            && self.read_fence == current.read_fence
    }

    pub(crate) fn accepts_output(&self, current: &Self, observed_native: Option<&str>) -> bool {
        if self.same_owner(current) {
            return true;
        }
        // Independent status observation may resolve the first native root
        // during this read. Accept that same authenticated root without
        // rewriting it; later transitions still invalidate the captured read.
        if self.native_session_id.is_some()
            || observed_native.is_none()
            || current.native_session_id.as_deref() != observed_native
            || self.read_fence.identity_revision.checked_add(1)
                != Some(current.read_fence.identity_revision)
        {
            return false;
        }
        let mut resolved = self.clone();
        resolved.native_session_id = current.native_session_id.clone();
        resolved.read_fence.identity_revision = current.read_fence.identity_revision;
        resolved.same_owner(current)
    }
}

impl OwnedRuntimeHandle {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn from_registry(
        installation_id: InstallationId,
        soul_id: SoulId,
        provider_store_id: String,
        incarnation_id: IncarnationId,
        launch_nonce: LaunchNonce,
        daemon_id: DockerDaemonId,
        container_id: String,
        image_ref: String,
        runtime_dir: PathBuf,
        host_binary_path: PathBuf,
        immutable_config_digest: String,
        requested_limits: RuntimeLimits,
        fixture: Option<FixtureKind>,
        terminal: Option<TerminalLaunchSpec>,
        fresh_agent: Option<FreshAgentLaunchSpec>,
        provider_volume_name: String,
    ) -> Self {
        Self {
            installation_id,
            soul_id,
            provider_store_id,
            incarnation_id,
            launch_nonce,
            daemon_id,
            container_id,
            image_ref,
            runtime_dir,
            host_binary_path,
            immutable_config_digest,
            launch_policy: None,
            requested_limits,
            fixture,
            terminal,
            fresh_agent,
            provider_volume_name,
            ordinary_stop: None,
        }
    }

    pub(crate) fn stop_fence(&self) -> Result<StopFence, RegistryError> {
        self.ordinary_stop.as_deref().copied().ok_or_else(|| {
            RegistryError::InvalidState(
                "runtime handle was not issued by an ordinary Stop transaction".into(),
            )
        })
    }

    pub fn installation_id(&self) -> &InstallationId {
        &self.installation_id
    }
    pub fn soul_id(&self) -> &SoulId {
        &self.soul_id
    }
    pub fn provider_store_id(&self) -> &str {
        &self.provider_store_id
    }
    pub fn incarnation_id(&self) -> &IncarnationId {
        &self.incarnation_id
    }
    pub fn launch_nonce(&self) -> &LaunchNonce {
        &self.launch_nonce
    }
    pub fn daemon_id(&self) -> &DockerDaemonId {
        &self.daemon_id
    }
    pub fn container_id(&self) -> &str {
        &self.container_id
    }
    pub fn image_ref(&self) -> &str {
        &self.image_ref
    }
    pub fn runtime_dir(&self) -> &Path {
        &self.runtime_dir
    }
    pub fn host_binary_path(&self) -> &Path {
        &self.host_binary_path
    }
    pub fn immutable_config_digest(&self) -> &str {
        &self.immutable_config_digest
    }
    pub fn launch_policy(&self) -> Option<freshell_runtime_protocol::RuntimeLaunchPolicy> {
        self.launch_policy
    }
    pub(crate) fn with_launch_policy(
        mut self,
        policy: Option<freshell_runtime_protocol::RuntimeLaunchPolicy>,
    ) -> Self {
        self.launch_policy = policy;
        self
    }
    pub fn requested_limits(&self) -> RuntimeLimits {
        self.requested_limits
    }
    pub fn fixture(&self) -> Option<FixtureKind> {
        self.fixture
    }
    pub fn terminal(&self) -> Option<&TerminalLaunchSpec> {
        self.terminal.as_ref()
    }
    pub fn fresh_agent(&self) -> Option<&FreshAgentLaunchSpec> {
        self.fresh_agent.as_ref()
    }
    pub fn provider_volume_name(&self) -> &str {
        &self.provider_volume_name
    }
}

pub(crate) struct RetiredPreparedReplacement {
    pub incarnation_id: IncarnationId,
    pub journal: Option<(RecoveryAttemptId, u64)>,
}

#[derive(Debug, Clone)]
pub struct RecoveryContext {
    pub claude_fork: Option<freshell_runtime_protocol::ClaudeForkRecipe>,
    pub native_identity_launch: Option<freshell_runtime_protocol::NativeIdentityLaunch>,
    pub soul_id: SoulId,
    pub prior_handle: OwnedRuntimeHandle,
    pub provider: String,
    pub provider_store_id: String,
    pub native_session_id: Option<String>,
    pub creation_seed_ref: String,
    pub desired_state: DesiredState,
    pub intent_revision: u64,
    pub identity_revision: u64,
    pub recovery_state: RecoveryState,
    pub durability_state: DurabilityState,
    pub allocation_state: AllocationState,
    pub checkpoint_revision: u64,
    pub evidence_revision: u64,
    pub native_import_revision: u64,
    pub native_import_state: NativeImportState,
    pub native_import_source_store_id: Option<String>,
    pub native_import_root_session_id: Option<String>,
    pub native_import_source_generation: Option<String>,
    pub native_import_schema_fingerprint: Option<String>,
    pub native_import_migration_fingerprint: Option<String>,
    pub native_import_complete_inventory: bool,
    pub native_import_authority: String,
    pub recovery_attempt_id: Option<RecoveryAttemptId>,
    pub control_epoch: u64,
    pub resume_spec: Option<ResumeSpec>,
    pub opencode_adoption_baseline: Option<OpenCodeAdoptionBaseline>,
    pub project_key: String,
    pub profile: RuntimeProfile,
    pub fixture: Option<FixtureKind>,
    pub terminal: Option<TerminalLaunchSpec>,
    pub fresh_agent: Option<FreshAgentLaunchSpec>,
    pub requested_limits: RuntimeLimits,
    pub accepted_command_count: u64,
    pub completed_command_count: u64,
    pub dispatched_command_count: u64,
    pub never_dispatched: bool,
    pub recovery_window_started_at: Option<i64>,
    pub successful_recoveries_in_window: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeImportState {
    NotApplicable,
    Pending,
    Available,
    Absent,
    Unresolved,
    Unreadable,
    Unsupported,
    ExpiredStage,
    Partial,
    Completed,
    LegacyUnknown,
}

impl NativeImportState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotApplicable => "not_applicable",
            Self::Pending => "pending",
            Self::Available => "available",
            Self::Absent => "absent",
            Self::Unresolved => "unresolved",
            Self::Unreadable => "unreadable",
            Self::Unsupported => "unsupported",
            Self::ExpiredStage => "expired_stage",
            Self::Partial => "partial",
            Self::Completed => "completed",
            Self::LegacyUnknown => "legacy_unknown",
        }
    }

    fn parse(value: &str) -> Result<Self, RegistryError> {
        match value {
            "not_applicable" => Ok(Self::NotApplicable),
            "pending" => Ok(Self::Pending),
            "available" => Ok(Self::Available),
            "absent" => Ok(Self::Absent),
            "unresolved" => Ok(Self::Unresolved),
            "unreadable" => Ok(Self::Unreadable),
            "unsupported" => Ok(Self::Unsupported),
            "expired_stage" => Ok(Self::ExpiredStage),
            "partial" => Ok(Self::Partial),
            "completed" => Ok(Self::Completed),
            "legacy_unknown" => Ok(Self::LegacyUnknown),
            other => Err(RegistryError::Integrity(format!(
                "unknown native import state {other}"
            ))),
        }
    }

    pub fn loss_inventory_is_negative(self, complete_inventory: bool) -> bool {
        self == Self::NotApplicable || (self == Self::Absent && complete_inventory)
    }

    pub fn permits_pristine_seed(self, complete_inventory: bool) -> bool {
        self.loss_inventory_is_negative(complete_inventory)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryWriteFence {
    control_epoch: u64,
    intent_revision: u64,
    identity_revision: u64,
    evidence_revision: u64,
    native_import_revision: u64,
    recovery_attempt_id: Option<RecoveryAttemptId>,
    active_incarnation_id: IncarnationId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompleteNativeImportInventory {
    source_store_id: String,
    root_session_id: String,
    source_generation: String,
    schema_fingerprint: String,
    migration_fingerprint: String,
    inventory_fingerprint: String,
}

impl CompleteNativeImportInventory {
    fn authority(&self) -> String {
        format!("complete_source_inventory:{}", self.inventory_fingerprint)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeImportObservation {
    pub state: NativeImportState,
    pub source_store_id: Option<String>,
    pub root_session_id: Option<String>,
    pub source_generation: Option<String>,
    pub schema_fingerprint: Option<String>,
    pub migration_fingerprint: Option<String>,
    pub complete_source_inventory: Option<CompleteNativeImportInventory>,
}

impl RecoveryWriteFence {
    pub(crate) fn for_incarnation(mut self, incarnation_id: IncarnationId) -> Self {
        self.active_incarnation_id = incarnation_id;
        self
    }
}

impl RecoveryContext {
    pub(crate) fn permits_pristine_seed(&self) -> bool {
        self.never_dispatched
            && self.native_session_id.is_none()
            && self
                .native_import_state
                .permits_pristine_seed(self.native_import_absence_is_authoritative())
    }

    pub fn write_fence(&self) -> RecoveryWriteFence {
        RecoveryWriteFence {
            control_epoch: self.control_epoch,
            intent_revision: self.intent_revision,
            identity_revision: self.identity_revision,
            evidence_revision: self.evidence_revision,
            native_import_revision: self.native_import_revision,
            recovery_attempt_id: self.recovery_attempt_id.clone(),
            active_incarnation_id: self.prior_handle.incarnation_id().clone(),
        }
    }

    pub fn write_fence_for_attempt(&self, attempt_id: RecoveryAttemptId) -> RecoveryWriteFence {
        let mut fence = self.write_fence();
        fence.recovery_attempt_id = Some(attempt_id);
        fence
    }

    pub fn native_import_absence_is_authoritative(&self) -> bool {
        self.native_import_state == NativeImportState::Absent
            && self.native_import_complete_inventory
            && self
                .native_import_authority
                .strip_prefix("complete_source_inventory:")
                .is_some_and(is_lower_hex_sha256)
            && self
                .native_import_source_store_id
                .as_deref()
                .is_some_and(|value| !value.is_empty())
            && self
                .native_import_root_session_id
                .as_deref()
                .is_some_and(|value| !value.is_empty())
            && self
                .native_import_source_generation
                .as_deref()
                .is_some_and(|value| !value.is_empty())
            && self
                .native_import_schema_fingerprint
                .as_deref()
                .is_some_and(|value| !value.is_empty())
            && self
                .native_import_migration_fingerprint
                .as_deref()
                .is_some_and(|value| !value.is_empty())
    }

    pub fn native_import_is_definitively_negative(&self) -> bool {
        self.native_import_state == NativeImportState::NotApplicable
            || self.native_import_absence_is_authoritative()
    }
}

#[derive(Debug, Clone)]
pub struct RecoveryStart {
    pub attempt_id: RecoveryAttemptId,
    pub context: RecoveryContext,
}

#[derive(Debug, Clone)]
pub struct ReplacementPreparation {
    pub prepared: PreparedLaunch,
    pub fixture: Option<FixtureKind>,
    pub terminal: Option<TerminalLaunchSpec>,
    pub fresh_agent: Option<FreshAgentLaunchSpec>,
    pub resume_spec: Option<ResumeSpec>,
    pub prior_incarnation_id: IncarnationId,
    pub attempt_id: RecoveryAttemptId,
}

/// How turn settings fold into a recovery launch spec: a send's settings
/// replace only the fields they state, while a configure's absent effort
/// follows the provider's live configure rule.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SettingsFold {
    Turn,
    Configure,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputJournalDisposition {
    Dispatch,
    Completed,
    Ambiguous,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueuedInput {
    pub request_id: RequestId,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryDebugSnapshot {
    pub installation_id: InstallationId,
    pub control_epoch: u64,
    pub views: Vec<RuntimeView>,
}

impl Registry {
    pub fn open(
        root: impl AsRef<Path>,
        installation_hint: Option<InstallationId>,
    ) -> Result<Self, RegistryError> {
        let root = root.as_ref();
        std::fs::create_dir_all(root)?;
        // The registry contains protected queued input and durable provider
        // identity. Keep the entire SQLite/WAL directory supervisor-private.
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700))?;
        let owner_lock = OwnerLock::acquire(root)?;

        let db_path = root.join("runtime.sqlite3");
        let mut conn = open_connection(&db_path)?;
        let existing = table_exists(&conn, "installation")?;
        if !existing {
            create_schema(&mut conn, installation_hint.clone().unwrap_or_default())?;
        } else {
            migrate_schema(&mut conn)?;
        }
        verify_schema_and_integrity(&conn)?;

        let (installation_raw, schema_version, epoch): (String, u32, u64) = conn.query_row(
            "SELECT installation_id, schema_version, control_epoch FROM installation WHERE singleton=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        if schema_version > SCHEMA_VERSION {
            return Err(RegistryError::NewerSchema {
                found: schema_version,
                supported: SCHEMA_VERSION,
            });
        }
        let installation_id = InstallationId::parse(installation_raw)
            .map_err(|_| RegistryError::Integrity("invalid installation id".into()))?;
        if let Some(hint) = installation_hint {
            if hint != installation_id {
                return Err(RegistryError::InstallationMismatch);
            }
        }
        crate::view_intents::backfill_automatic_view_intents(&mut conn, &installation_id)?;

        let next_epoch = epoch
            .checked_add(1)
            .ok_or_else(|| RegistryError::Integrity("control epoch overflow".into()))?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "UPDATE installation SET control_epoch=?1 WHERE singleton=1 AND control_epoch=?2",
            params![next_epoch, epoch],
        )?;
        tx.commit()?;
        drop(conn);

        Ok(Self {
            #[cfg(test)]
            retry_clock: None,
            inner: Arc::new(RegistryInner {
                db_path,
                installation_id,
                control_epoch: next_epoch,
                _owner_lock: owner_lock,
            }),
        })
    }

    pub fn installation_id(&self) -> &InstallationId {
        &self.inner.installation_id
    }

    pub(crate) fn recovery_now_ms(&self) -> i64 {
        #[cfg(test)]
        if let Some(clock) = &self.retry_clock {
            return clock.load(std::sync::atomic::Ordering::SeqCst);
        }
        now_millis()
    }
    pub fn control_epoch(&self) -> u64 {
        self.inner.control_epoch
    }
    pub(crate) fn database_path(&self) -> &Path {
        &self.inner.db_path
    }
    pub(crate) fn registry_root(&self) -> &Path {
        self.inner
            .db_path
            .parent()
            .expect("registry database always has a parent")
    }

    pub fn assert_epoch(&self, expected: Option<u64>) -> Result<(), RegistryError> {
        if let Some(expected) = expected {
            if expected != self.control_epoch() {
                return Err(RegistryError::StaleControlEpoch {
                    expected,
                    current: self.control_epoch(),
                });
            }
        }
        Ok(())
    }

    pub async fn prepare_launch(
        &self,
        input: LaunchPreparation,
    ) -> Result<PreparedLaunch, RegistryError> {
        if let Some(terminal) = &input.terminal {
            terminal
                .validate()
                .map_err(|error| RegistryError::InvalidState(error.message))?;
            if terminal
                .opencode_transfer
                .as_ref()
                .is_some_and(|transfer| transfer.destination_store_id != input.provider_store_id)
            {
                return Err(RegistryError::InvalidState(
                    "OpenCode transfer destination does not match the provider store".into(),
                ));
            }
            if terminal.opencode_transfer.as_ref().is_some_and(|transfer| {
                transfer.provider != input.provider
                    || input.native_session_id.as_deref() != Some(transfer.root_session_id.as_str())
            }) {
                return Err(RegistryError::InvalidState(
                    "OpenCode transfer does not match the provider and requested native identity"
                        .into(),
                ));
            }
        }
        let installation_id = self.installation_id().clone();
        self.run_blocking(move |mut conn| {
            failpoint("prepare")?;
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

            if let Some((existing_digest, incarnation_raw)) = tx
                .query_row(
                    "SELECT payload_digest, incarnation_id FROM commands WHERE soul_id=?1 AND request_id=?2",
                    params![input.soul_id.as_str(), input.request_id.as_str()],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?
            {
                if existing_digest != input.payload_digest {
                    return Err(RegistryError::RequestConflict);
                }
                let incarnation_id = IncarnationId::parse(incarnation_raw)
                    .map_err(|_| RegistryError::Integrity("invalid incarnation id".into()))?;
                input_reservation::check_bound_reference(&tx, &input, &incarnation_id)?;
                let row = load_prepared_row(&tx, &incarnation_id)?;
                tx.commit()?;
                return Ok(PreparedLaunch { existing_request: true, ..row });
            }

            let now = now_millis();
            let profile_name = runtime_profile_name(input.profile);
            let provider_volume_name = stable_provider_volume_name(&installation_id, &input.soul_id);
            let transfer = input
                .terminal
                .as_ref()
                .and_then(|terminal| terminal.opencode_transfer.as_ref());
            let soul_row: Option<ExistingSoulLaunchRow> = tx
                .query_row(
                    "SELECT provider,provider_store_id,project_key,resource_profile,native_session_id,intent_revision,native_import_state,native_import_source_store_id,native_import_root_session_id,native_import_source_generation FROM souls WHERE soul_id=?1",
                    params![input.soul_id.as_str()],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?)),
                )
                .optional()?;
            let soul_intent_revision = if let Some((provider, store, project, profile, native, revision, import_state, source_store, source_root, source_generation)) = soul_row {
                if provider != input.provider
                    || store != input.provider_store_id
                    || project != input.project_key
                    || profile != profile_name
                    || (native.is_some() && native != input.native_session_id)
                {
                    return Err(RegistryError::InvalidState(
                        "existing soul launch identity/profile does not match request".into(),
                    ));
                }
                if let Some(transfer) = transfer {
                    let same_origin = source_store.as_deref() == Some(transfer.source_store_id.as_str())
                        && source_root.as_deref() == Some(transfer.root_session_id.as_str());
                    if import_state == NativeImportState::LegacyUnknown.as_str()
                        || (import_state != NativeImportState::NotApplicable.as_str() && !same_origin)
                    {
                        return Err(RegistryError::NativeIdentityConflict);
                    }
                    claim_native_origin_in_tx(
                        &tx,
                        &transfer.provider,
                        &transfer.source_store_id,
                        &transfer.root_session_id,
                        &input.soul_id,
                        Some(&transfer.source_generation),
                    )?;
                    if import_state != NativeImportState::Completed.as_str()
                        || source_generation.as_deref()
                            != Some(transfer.source_generation.as_str())
                    {
                        let changed = tx.execute(
                            "UPDATE souls SET native_import_state='pending',native_import_source_store_id=?1,native_import_root_session_id=?2,native_import_source_generation=?3,native_import_schema_fingerprint=?4,native_import_migration_fingerprint=?5,native_import_complete_inventory=0,native_import_authority='exact_source_snapshot',native_import_revision=native_import_revision+1,evidence_revision=evidence_revision+1,updated_at=?6 WHERE soul_id=?7 AND native_import_state=?8",
                            params![transfer.source_store_id, transfer.root_session_id, transfer.source_generation, transfer.source_schema_fingerprint, transfer.migration_journal_fingerprint, now, input.soul_id.as_str(), import_state],
                        )?;
                        if changed != 1 {
                            return Err(RegistryError::NativeIdentityConflict);
                        }
                    }
                }
                revision
            } else {
                tx.execute(
                    "INSERT INTO souls (soul_id,provider,provider_store_id,native_session_id,creation_seed_ref,desired_state,intent_revision,recovery_state,recovery_reason,recovery_attempt_id,durability_state,allocation_state,resume_spec,checkpoint_revision,evidence_revision,identity_revision,native_import_revision,native_import_state,native_import_source_store_id,native_import_root_session_id,native_import_source_generation,native_import_schema_fingerprint,native_import_migration_fingerprint,native_import_complete_inventory,native_import_authority,recovery_window_started_at,successful_recoveries_in_window,project_key,resource_profile,provider_volume_name,configured_limits,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,'running',1,'live',NULL,NULL,'unknown','allocated',NULL,0,?6,?7,?8,?9,?10,?11,?12,?13,?14,0,?15,NULL,0,?16,?17,?18,?19,?20,?20)",
                    params![
                        input.soul_id.as_str(),
                        input.provider,
                        input.provider_store_id,
                        input.native_session_id,
                        input.creation_seed_ref,
                        if transfer.is_some() { 1 } else { 0 },
                        if input.native_session_id.is_some() { 1 } else { 0 },
                        if transfer.is_some() { 1 } else { 0 },
                        if transfer.is_some() { NativeImportState::Pending.as_str() } else { NativeImportState::NotApplicable.as_str() },
                        transfer.map(|value| value.source_store_id.as_str()),
                        transfer.map(|value| value.root_session_id.as_str()),
                        transfer.map(|value| value.source_generation.as_str()),
                        transfer.map(|value| value.source_schema_fingerprint.as_str()),
                        transfer.map(|value| value.migration_journal_fingerprint.as_str()),
                        if transfer.is_some() { "exact_source_snapshot" } else { "no_import_configured" },
                        input.project_key,
                        profile_name,
                        provider_volume_name,
                        serde_json::to_string(&input.requested_limits)?,
                        now
                    ],
                )?;
                if let Some(transfer) = transfer {
                    claim_native_origin_in_tx(
                        &tx,
                        &transfer.provider,
                        &transfer.source_store_id,
                        &transfer.root_session_id,
                        &input.soul_id,
                        Some(&transfer.source_generation),
                    )?;
                }
                1
            };
            if input.terminal.is_some() || input.view_intent.is_some() {
                crate::view_intents::ensure_automatic_primary_in_tx(
                    &tx,
                    &installation_id,
                    &input.soul_id,
                    &input.project_key,
                    soul_intent_revision,
                    input.view_intent.as_ref(),
                    now,
                )?;
            }

            let active: Option<(String, String, String, String, Option<String>)> = tx
                .query_row(
                    &format!(
                        "SELECT i.incarnation_id,i.launch_state,s.desired_state,s.recovery_state,(SELECT c.payload_digest FROM commands c WHERE c.incarnation_id=i.incarnation_id ORDER BY c.created_at LIMIT 1) FROM incarnations i JOIN souls s ON s.soul_id=i.soul_id WHERE i.soul_id=?1 AND i.launch_state IN ({ACTIVE_STATES}) LIMIT 1"
                    ),
                    params![input.soul_id.as_str()],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
                )
                .optional()?;
            if let Some((incarnation_raw, launch_state, desired_state, recovery_state, active_digest)) = active {
                // A controller restart may present the same semantic launch
                // under a new request id. Adopt only a demonstrably live,
                // desired-running incarnation whose original durable command
                // digest exactly matches; never reinterpret a conflicting
                // request as continuity.
                if launch_state != "running"
                    || desired_state != "running"
                    || recovery_state != "live"
                    || active_digest.as_deref() != Some(input.payload_digest.as_str())
                {
                    return Err(RegistryError::ActiveIncarnation(input.soul_id));
                }
                let incarnation_id = IncarnationId::parse(incarnation_raw)
                    .map_err(|_| RegistryError::Integrity("invalid incarnation id".into()))?;
                input_reservation::check_bound_reference(&tx, &input, &incarnation_id)?;
                tx.execute(
                    "INSERT INTO commands (soul_id,request_id,payload_digest,protected_payload_ref,state,provider_ack_id,incarnation_id,event_cursor,created_at,updated_at) VALUES (?1,?2,?3,NULL,'running',NULL,?4,0,?5,?5)",
                    params![input.soul_id.as_str(), input.request_id.as_str(), input.payload_digest, incarnation_id.as_str(), now],
                )?;
                let row = load_prepared_row(&tx, &incarnation_id)?;
                tx.commit()?;
                return Ok(PreparedLaunch {
                    existing_request: true,
                    ..row
                });
            }

            let installation_used = reservation_totals(&tx, None)?;
            if !input.admission.installation.admits(installation_used, input.requested_limits) {
                return Err(RegistryError::BlockedResource { scope: "installation" });
            }
            let project_used = reservation_totals(&tx, Some(&input.project_key))?;
            if !input.admission.project.admits(project_used, input.requested_limits) {
                return Err(RegistryError::BlockedResource { scope: "project" });
            }

            let incarnation_id = input
                .terminal
                .as_ref()
                .and_then(|terminal| terminal.opencode_transfer.as_ref())
                .map(|transfer| {
                    IncarnationId::parse(transfer.incarnation_id.clone())
                        .map_err(|_| RegistryError::Integrity("invalid proposed transfer incarnation".into()))
                })
                .transpose()?
                .unwrap_or_else(IncarnationId::new);
            let incarnation_in_use: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM incarnations WHERE incarnation_id=?1)",
                params![incarnation_id.as_str()],
                |row| row.get(0),
            )?;
            if incarnation_in_use {
                return Err(RegistryError::InvalidState(
                    "proposed OpenCode transfer incarnation is already in use".into(),
                ));
            }
            input_reservation::bind_in_transaction(&tx, &input, &incarnation_id)?;
            let launch_nonce = LaunchNonce::new();
            let limits_json = serde_json::to_string(&input.requested_limits)?;
            let terminal_json = input.terminal.as_ref().map(serde_json::to_string).transpose()?;
            let fresh_agent_json = input
                .fresh_agent
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?;
            let terminal_id = input.terminal.as_ref().map(|t| t.terminal_id.as_str());
            let fixture_kind = input.fixture.map(fixture_kind_name);
            tx.execute(
                "INSERT INTO incarnations (incarnation_id,soul_id,launch_nonce,docker_daemon_id,container_id,image_ref,runtime_dir,host_binary_path,immutable_config_digest,launch_state,host_boot_id,execution_generation,grant_id,requested_limits,effective_limits,cleanup_state,fixture_kind,terminal_id,terminal_spec,fresh_agent_spec,prior_incarnation_id,recovery_attempt_id,exit_code,oom_killed,created_at,updated_at) VALUES (?1,?2,?3,NULL,NULL,NULL,NULL,NULL,NULL,'prepared',NULL,0,NULL,?4,NULL,'none',?5,?6,?7,?8,NULL,NULL,NULL,0,?9,?9)",
                params![incarnation_id.as_str(), input.soul_id.as_str(), launch_nonce.as_str(), limits_json, fixture_kind, terminal_id, terminal_json, fresh_agent_json, now],
            )?;
            tx.execute(
                "INSERT INTO admission_reservations (incarnation_id,project_key,cpu_milli,memory_bytes,pids_max,created_at) VALUES (?1,?2,?3,?4,?5,?6)",
                params![
                    incarnation_id.as_str(),
                    input.project_key,
                    input.requested_limits.cpu_milli,
                    input.requested_limits.memory_bytes,
                    input.requested_limits.pids_max,
                    now
                ],
            )?;
            if let Some(native_session_id) = input.native_session_id.as_deref() {
                tx.execute(
                    "INSERT INTO writer_claims (provider,provider_store_id,native_session_id,soul_id,incarnation_id,intent_revision) VALUES (?1,?2,?3,?4,?5,1)",
                    params![input.provider, input.provider_store_id, native_session_id, input.soul_id.as_str(), incarnation_id.as_str()],
                )?;
            }
            tx.execute(
                "INSERT INTO commands (soul_id,request_id,payload_digest,protected_payload_ref,state,provider_ack_id,incarnation_id,event_cursor,created_at,updated_at) VALUES (?1,?2,?3,NULL,'prepared',NULL,?4,0,?5,?5)",
                params![input.soul_id.as_str(), input.request_id.as_str(), input.payload_digest, incarnation_id.as_str(), now],
            )?;
            let intent_revision: u64 = tx.query_row(
                "SELECT intent_revision FROM souls WHERE soul_id=?1",
                params![input.soul_id.as_str()],
                |row| row.get(0),
            )?;
            tx.commit()?;
            Ok(PreparedLaunch { soul_id: input.soul_id, incarnation_id, launch_nonce, state: LaunchState::Prepared, intent_revision, existing_request: false })
        }).await
    }

    pub async fn commit_created(
        &self,
        incarnation_id: IncarnationId,
        created: BackendCreatedRecord,
    ) -> Result<(), RegistryError> {
        self.run_blocking(move |mut conn| {
            failpoint("commit_created")?;
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let now = now_millis();
            let changed = tx.execute(
                "UPDATE incarnations SET docker_daemon_id=?1,container_id=?2,image_ref=?3,runtime_dir=?4,host_binary_path=?5,immutable_config_digest=?6,launch_policy=?9,launch_state='created',updated_at=?7 WHERE incarnation_id=?8 AND launch_state='prepared' AND container_id IS NULL AND EXISTS (SELECT 1 FROM souls WHERE soul_id=incarnations.soul_id AND desired_state='running')",
                params![created.daemon_id.as_str(), created.container_id, created.image_ref, created.runtime_dir.to_string_lossy(), created.host_binary_path.to_string_lossy(), created.immutable_config_digest, now, incarnation_id.as_str(), created.launch_policy.map(|policy|serde_json::to_string(&policy)).transpose()?],
            )?;
            if changed != 1 { return Err(RegistryError::InvalidState(format!("cannot commit CREATED for {incarnation_id}"))); }
            tx.execute("UPDATE commands SET state='created',updated_at=?1 WHERE incarnation_id=?2", params![now, incarnation_id.as_str()])?;
            tx.commit()?;
            Ok(())
        }).await
    }

    pub async fn commit_execution_grant(
        &self,
        incarnation_id: IncarnationId,
        host_boot_id: HostBootId,
        effective_limits: RuntimeLimits,
    ) -> Result<ExecutionGrantRecord, RegistryError> {
        let control_epoch = self.control_epoch();
        self.run_blocking(move |mut conn| {
            failpoint("commit_grant")?;
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let existing: Option<(String, u64, String)> = tx.query_row(
                "SELECT host_boot_id,execution_generation,grant_id FROM incarnations WHERE incarnation_id=?1 AND launch_state='starting'",
                params![incarnation_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            ).optional()?;
            if let Some((boot, generation, grant)) = existing {
                let boot = HostBootId::parse(boot).map_err(|_| RegistryError::Integrity("invalid host boot id".into()))?;
                if boot != host_boot_id {
                    return Err(RegistryError::InvalidState("host boot changed while grant was outstanding".into()));
                }
                return Ok(ExecutionGrantRecord { control_epoch, execution_generation: generation, grant_id: GrantId::parse(grant).map_err(|_| RegistryError::Integrity("invalid grant id".into()))?, host_boot_id: boot });
            }

            let previous: u64 = tx.query_row(
                "SELECT i.execution_generation FROM incarnations i JOIN souls s ON s.soul_id=i.soul_id WHERE i.incarnation_id=?1 AND i.launch_state='created' AND s.desired_state='running'",
                params![incarnation_id.as_str()],
                |row| row.get(0),
            ).optional()?.ok_or_else(|| RegistryError::InvalidState(format!("cannot grant execution for {incarnation_id}; stop intent or lifecycle transition won")))?;
            let generation = previous.checked_add(1).ok_or_else(|| RegistryError::Integrity("execution generation overflow".into()))?;
            let grant_id = GrantId::new();
            let effective_json = serde_json::to_string(&effective_limits)?;
            let now = now_millis();
            let changed = tx.execute(
                "UPDATE incarnations SET launch_state='starting',host_boot_id=?1,execution_generation=?2,grant_id=?3,effective_limits=?4,updated_at=?5 WHERE incarnation_id=?6 AND launch_state='created' AND EXISTS (SELECT 1 FROM souls WHERE soul_id=incarnations.soul_id AND desired_state='running')",
                params![host_boot_id.as_str(), generation, grant_id.as_str(), effective_json, now, incarnation_id.as_str()],
            )?;
            if changed != 1 {
                return Err(RegistryError::InvalidState(format!(
                    "cannot persist execution grant for {incarnation_id}; stop intent won"
                )));
            }
            tx.execute("UPDATE commands SET state='starting',updated_at=?1 WHERE incarnation_id=?2", params![now, incarnation_id.as_str()])?;
            tx.commit()?;
            Ok(ExecutionGrantRecord { control_epoch, execution_generation: generation, grant_id, host_boot_id })
        }).await
    }

    /// Settle a Codex grant that the session host positively rejected before
    /// it could spawn the PTY worker. The caller must first stop the exact
    /// owned runtime and prove it empty; this transaction then rechecks the
    /// grant and intent fences before releasing the incarnation's claims.
    pub(crate) async fn fail_codex_pre_worker_start(
        &self,
        handle: OwnedRuntimeHandle,
        expected_intent_revision: u64,
        grant: ExecutionGrantRecord,
    ) -> Result<(), RegistryError> {
        if grant.control_epoch != self.control_epoch() {
            return Err(RegistryError::StaleControlEpoch {
                expected: grant.control_epoch,
                current: self.control_epoch(),
            });
        }
        if handle
            .terminal()
            .is_none_or(|terminal| terminal.mode != "codex")
            && handle
                .fresh_agent()
                .is_none_or(|agent| agent.provider != FreshProvider::Codex)
        {
            return Err(RegistryError::InvalidState(
                "pre-worker Codex failure does not own a Codex workload".into(),
            ));
        }

        let installation = self.installation_id().clone();
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let current = load_owned_handle(&tx, installation, handle.incarnation_id())?;
            if current.soul_id != handle.soul_id
                || current.provider_store_id != handle.provider_store_id
                || current.launch_nonce != handle.launch_nonce
                || current.daemon_id != handle.daemon_id
                || current.container_id != handle.container_id
                || current.image_ref != handle.image_ref
                || current.runtime_dir != handle.runtime_dir
                || current.host_binary_path != handle.host_binary_path
                || current.immutable_config_digest != handle.immutable_config_digest
                || current.launch_policy != handle.launch_policy
                || current.requested_limits != handle.requested_limits
                || current.fixture != handle.fixture
                || current.terminal != handle.terminal
                || current.fresh_agent != handle.fresh_agent
                || current.provider_volume_name != handle.provider_volume_name
            {
                return Err(RegistryError::InvalidState(
                    "pre-worker Codex runtime ownership changed".into(),
                ));
            }

            let (launch_state, cleanup_state, host_boot_id, execution_generation, grant_id, provider, desired_state, intent_revision): (
                String,
                String,
                Option<String>,
                u64,
                Option<String>,
                String,
                String,
                u64,
            ) = tx.query_row(
                "SELECT i.launch_state,i.cleanup_state,i.host_boot_id,i.execution_generation,i.grant_id,s.provider,s.desired_state,s.intent_revision FROM incarnations i JOIN souls s ON s.soul_id=i.soul_id WHERE i.incarnation_id=?1",
                params![handle.incarnation_id().as_str()],
                |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?)),
            )?;
            if launch_state != "starting"
                || cleanup_state != "none"
                || host_boot_id.as_deref() != Some(grant.host_boot_id.as_str())
                || execution_generation != grant.execution_generation
                || grant_id.as_deref() != Some(grant.grant_id.as_str())
                || provider != "codex"
                || desired_state != "running"
                || intent_revision != expected_intent_revision
            {
                return Err(RegistryError::InvalidState(
                    "pre-worker Codex grant or intent changed before settlement".into(),
                ));
            }

            let now = now_millis();
            let changed = tx.execute(
                "UPDATE incarnations SET launch_state='failed',cleanup_state='verified_empty',updated_at=?1 WHERE incarnation_id=?2 AND launch_state='starting' AND cleanup_state='none' AND host_boot_id=?3 AND execution_generation=?4 AND grant_id=?5 AND EXISTS (SELECT 1 FROM souls WHERE soul_id=incarnations.soul_id AND provider='codex' AND desired_state='running' AND intent_revision=?6)",
                params![now, handle.incarnation_id().as_str(), grant.host_boot_id.as_str(), grant.execution_generation, grant.grant_id.as_str(), expected_intent_revision],
            )?;
            if changed != 1 {
                return Err(RegistryError::InvalidState(
                    "pre-worker Codex incarnation changed during settlement".into(),
                ));
            }
            let commands_changed = tx.execute(
                "UPDATE commands SET state='failed',updated_at=?1 WHERE incarnation_id=?2 AND state='starting'",
                params![now, handle.incarnation_id().as_str()],
            )?;
            if commands_changed == 0 {
                return Err(RegistryError::InvalidState(
                    "pre-worker Codex launch command is no longer starting".into(),
                ));
            }
            tx.execute(
                "DELETE FROM writer_claims WHERE incarnation_id=?1",
                params![handle.incarnation_id().as_str()],
            )?;
            tx.execute(
                "DELETE FROM admission_reservations WHERE incarnation_id=?1",
                params![handle.incarnation_id().as_str()],
            )?;
            tx.commit()?;
            Ok(())
        })
        .await
    }

    pub async fn mark_running(&self, incarnation_id: IncarnationId) -> Result<(), RegistryError> {
        self.mark_running_with_provider_preparation(incarnation_id, false)
            .await
    }

    pub(crate) async fn mark_running_with_provider_preparation(
        &self,
        incarnation_id: IncarnationId,
        preparation_accepted: bool,
    ) -> Result<(), RegistryError> {
        let id = incarnation_id.clone();
        let soul: String = self
            .run_blocking(move |conn| {
                Ok(conn.query_row(
                    "SELECT soul_id FROM incarnations WHERE incarnation_id=?1",
                    params![id.as_str()],
                    |row| row.get(0),
                )?)
            })
            .await?;
        let soul =
            SoulId::parse(soul).map_err(|_| RegistryError::Integrity("invalid soul id".into()))?;
        let fence = self.recovery_write_fence(soul.clone()).await?;
        self.mark_running_observed_with_provider_preparation(
            soul,
            incarnation_id,
            fence,
            preparation_accepted,
        )
        .await
        .map(|_| ())
    }

    #[cfg(test)]
    pub(crate) async fn mark_running_observed(
        &self,
        soul: SoulId,
        incarnation_id: IncarnationId,
        fence: RecoveryWriteFence,
    ) -> Result<RecoveryWriteFence, RegistryError> {
        self.mark_running_observed_with_provider_preparation(soul, incarnation_id, fence, false)
            .await
    }

    pub(crate) async fn mark_running_observed_with_provider_preparation(
        &self,
        soul: SoulId,
        incarnation_id: IncarnationId,
        fence: RecoveryWriteFence,
        preparation_accepted: bool,
    ) -> Result<RecoveryWriteFence, RegistryError> {
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            validate_recovery_write_fence(&tx, &soul, &fence)?;
            if incarnation_id != fence.active_incarnation_id { return Err(RegistryError::NativeIdentityConflict); }
            validate_live_native_observation(&tx, &soul, &incarnation_id)?;
            let now = now_millis();
            let changed = tx.execute(
                "UPDATE incarnations SET launch_state='running',provider_preparation_pending=?3,updated_at=?1 WHERE incarnation_id=?2 AND launch_state='starting' AND EXISTS (SELECT 1 FROM souls WHERE soul_id=incarnations.soul_id AND desired_state='running')",
                params![now, incarnation_id.as_str(), preparation_accepted],
            )?;
            if changed != 1 { return Err(RegistryError::InvalidState(format!("cannot mark RUNNING for {incarnation_id}"))); }
            tx.execute("UPDATE commands SET state='running',updated_at=?1 WHERE incarnation_id=?2", params![now, incarnation_id.as_str()])?;
            let (soul_id, terminal_spec): (String, Option<String>) = tx.query_row(
                "SELECT soul_id,terminal_spec FROM incarnations WHERE incarnation_id=?1",
                params![incarnation_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            if let Some(terminal_spec) = terminal_spec {
                let terminal: TerminalLaunchSpec = serde_json::from_str(&terminal_spec)
                    .map_err(|_| RegistryError::Integrity("invalid terminal launch spec".into()))?;
                if let Some(transfer) = terminal.opencode_transfer {
                    let (provider, native, import_state, source_store, source_root, source_generation): (
                        String, Option<String>, String, Option<String>, Option<String>, Option<String>
                    ) = tx.query_row(
                        "SELECT provider,native_session_id,native_import_state,native_import_source_store_id,native_import_root_session_id,native_import_source_generation FROM souls WHERE soul_id=?1",
                        params![soul_id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
                    )?;
                    if provider != transfer.provider
                        || provider != "opencode"
                        || native.as_deref() != Some(transfer.root_session_id.as_str())
                        || source_store.as_deref() != Some(transfer.source_store_id.as_str())
                        || source_root.as_deref() != Some(transfer.root_session_id.as_str())
                        || source_generation.as_deref() != Some(transfer.source_generation.as_str())
                    {
                        return Err(RegistryError::NativeIdentityConflict);
                    }
                    match NativeImportState::parse(&import_state)? {
                        NativeImportState::Pending => {
                            let imported = tx.execute(
                                "UPDATE souls SET native_import_state='completed',native_import_complete_inventory=0,native_import_authority='verified_import_receipt',native_import_revision=native_import_revision+1,evidence_revision=evidence_revision+1,updated_at=?1 WHERE soul_id=?2 AND native_import_state='pending' AND native_import_source_store_id=?3 AND native_import_root_session_id=?4 AND native_import_source_generation=?5",
                                params![now, soul_id, transfer.source_store_id, transfer.root_session_id, transfer.source_generation],
                            )?;
                            if imported != 1 {
                                return Err(RegistryError::NativeIdentityConflict);
                            }
                        }
                        NativeImportState::Completed => {}
                        _ => return Err(RegistryError::NativeIdentityConflict),
                    }
                }
            }
            let successor = load_recovery_write_fence(&tx, &soul)?;
            tx.commit()?;
            Ok(successor)
        }).await
    }

    pub(crate) async fn provider_preparation_is_pending(
        &self,
        incarnation: IncarnationId,
    ) -> Result<bool, RegistryError> {
        self.run_blocking(move |conn| {
            Ok(conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM incarnations i JOIN souls s ON s.soul_id=i.soul_id WHERE i.incarnation_id=?1 AND i.provider_preparation_pending=1 AND i.launch_state='running' AND s.desired_state='running' AND s.recovery_state='live')",
                params![incarnation.as_str()], |row| row.get(0),
            )?)
        }).await
    }

    pub(crate) async fn mark_provider_preparation_complete(
        &self,
        incarnation: IncarnationId,
    ) -> Result<(), RegistryError> {
        self.run_blocking(move |conn| {
            conn.execute(
                "UPDATE incarnations SET provider_preparation_pending=0 WHERE incarnation_id=?1 AND provider_preparation_pending=1",
                params![incarnation.as_str()],
            )?;
            Ok(())
        }).await
    }

    pub async fn owned_handle(
        &self,
        incarnation_id: IncarnationId,
    ) -> Result<OwnedRuntimeHandle, RegistryError> {
        let installation = self.installation_id().clone();
        self.run_blocking(move |conn| load_owned_handle(&conn, installation, &incarnation_id))
            .await
    }

    pub(crate) async fn prior_provider_owner(
        &self,
        incarnation: IncarnationId,
    ) -> Result<Option<OwnedRuntimeHandle>, RegistryError> {
        let installation = self.installation_id().clone();
        self.run_blocking(move |conn| {
            let prior: Option<String> = conn.query_row(
                "SELECT prior_incarnation_id FROM incarnations WHERE incarnation_id=?1",
                params![incarnation.as_str()],
                |row| row.get(0),
            )?;
            prior
                .map(|raw| {
                    let prior = IncarnationId::parse(raw).map_err(|_| {
                        RegistryError::Integrity("invalid prior provider owner".into())
                    })?;
                    load_owned_handle(&conn, installation, &prior)
                })
                .transpose()
        })
        .await
    }

    pub(crate) async fn is_stopped_unaccepted_replacement(
        &self,
        incarnation: IncarnationId,
    ) -> Result<bool, RegistryError> {
        self.run_blocking(move |conn| {
            let soul: Option<String> = conn.query_row(
                "SELECT soul_id FROM incarnations WHERE incarnation_id=?1 AND prior_incarnation_id IS NOT NULL AND launch_state='stopped' AND cleanup_state='verified_empty'",
                [incarnation.as_str()], |row| row.get(0),
            ).optional()?;
            let Some(soul) = soul else { return Ok(false); };
            let soul = SoulId::parse(soul)
                .map_err(|_| RegistryError::Integrity("invalid failed replacement soul".into()))?;
            // Acceptance survives later attempts overwriting the incarnation's
            // attempt link. Never classify the retained conversation as a
            // disposable failed start from its current launch state alone.
            Ok(load_retained_incarnation(&conn, &soul)? != incarnation)
        }).await
    }

    pub async fn active_handle_for_soul(
        &self,
        soul_id: SoulId,
    ) -> Result<OwnedRuntimeHandle, RegistryError> {
        let installation = self.installation_id().clone();
        self.run_blocking(move |conn| {
            let incarnation_raw: Option<String> = conn
                .query_row(
                    "SELECT i.incarnation_id FROM incarnations i JOIN souls s ON s.soul_id=i.soul_id WHERE i.soul_id=?1 AND i.launch_state='running' AND s.desired_state='running' AND s.recovery_state='live' ORDER BY i.created_at DESC LIMIT 1",
                    params![soul_id.as_str()],
                    |row| row.get(0),
                )
                .optional()?;
            let raw = incarnation_raw.ok_or_else(|| RegistryError::UnknownSoul(soul_id))?;
            let incarnation = IncarnationId::parse(raw)
                .map_err(|_| RegistryError::Integrity("invalid incarnation id".into()))?;
            load_owned_handle(&conn, installation, &incarnation)
        })
        .await
    }

    pub(crate) async fn retained_output_source(
        &self,
        soul_id: SoulId,
    ) -> Result<RetainedOutputSource, RegistryError> {
        self.run_blocking(move |mut conn| {
            // Read one registry snapshot. Recovery's current control handle
            // can be an unaccepted replacement; retained reads instead follow
            // the last successful acceptance, independently of launch state.
            let tx = conn.transaction()?;
            let (native_session_id, intent_revision, identity_revision, stopped): (Option<String>, u64, u64, bool) = tx
                .query_row(
                    "SELECT native_session_id,intent_revision,identity_revision,desired_state='stopped' FROM souls WHERE soul_id=?1",
                    [soul_id.as_str()],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .optional()?
                .ok_or_else(|| RegistryError::UnknownSoul(soul_id.clone()))?;
            let incarnation_id = load_retained_incarnation(&tx, &soul_id)?;
            // Reading output needs the committed association, not the provider
            // launch payload or mutation authority carried by an owned handle.
            let (runtime_dir, terminal_id, stream_id, execution_generation, host_boot_id, verified_empty):
                (String, Option<String>, Option<String>, u64, Option<String>, bool) = tx.query_row(
                "SELECT runtime_dir,json_extract(terminal_spec,'$.terminalId'),json_extract(terminal_spec,'$.streamId'),execution_generation,host_boot_id,cleanup_state='verified_empty' FROM incarnations WHERE incarnation_id=?1 AND docker_daemon_id IS NOT NULL AND container_id IS NOT NULL AND image_ref IS NOT NULL AND runtime_dir IS NOT NULL AND host_binary_path IS NOT NULL AND immutable_config_digest IS NOT NULL",
                [incarnation_id.as_str()],
                |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)),
            )?;
            let missing_terminal = || RegistryError::InvalidState("soul has no retained terminal".into());
            let source = RetainedOutputSource {
                incarnation_id,
                runtime_dir: runtime_dir.into(),
                terminal_id: terminal_id.ok_or_else(missing_terminal)?,
                stream_id: stream_id.ok_or_else(missing_terminal)?,
                native_session_id,
                stopped,
                verified_empty,
                read_fence: TerminalOutputReadFence {
                    intent_revision,
                    identity_revision,
                    execution_generation,
                    host_boot_id: host_boot_id.map(HostBootId::parse).transpose().map_err(|_| RegistryError::Integrity("invalid retained host boot id".into()))?,
                },
            };
            tx.commit()?;
            Ok(source)
        })
        .await
    }

    pub async fn begin_stop(&self, soul_id: SoulId) -> Result<OwnedRuntimeHandle, RegistryError> {
        self.begin_stop_expected(soul_id, None).await
    }

    pub async fn begin_stop_expected(
        &self,
        soul_id: SoulId,
        expected_intent_revision: Option<u64>,
    ) -> Result<OwnedRuntimeHandle, RegistryError> {
        let installation = self.installation_id().clone();
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let incarnation: Option<(String, String)> = tx
                .query_row(
                    &format!(
                        "SELECT incarnation_id,launch_state FROM incarnations WHERE soul_id=?1 ORDER BY CASE WHEN launch_state IN ({ACTIVE_STATES}) THEN 0 ELSE 1 END,created_at DESC LIMIT 1"
                    ),
                    params![soul_id.as_str()],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let Some((incarnation_raw, launch_state)) = incarnation else {
                return Err(RegistryError::UnknownSoul(soul_id));
            };
            let incarnation_id = IncarnationId::parse(incarnation_raw)
                .map_err(|_| RegistryError::Integrity("invalid incarnation id".into()))?;
            let revision: u64 = tx.query_row(
                "SELECT intent_revision FROM souls WHERE soul_id=?1",
                params![soul_id.as_str()],
                |row| row.get(0),
            )?;
            if let Some(expected) = expected_intent_revision {
                if expected != revision {
                    return Err(RegistryError::StaleIntentRevision {
                        expected,
                        current: revision,
                    });
                }
            }
            // Capture ownership before changing PREPARED to stopping. An
            // uncommitted enclosure must never acquire mutation authority.
            let owned = load_owned_handle(&tx, installation, &incarnation_id);
            let execution_generation: u64 = tx.query_row(
                "SELECT execution_generation FROM incarnations WHERE incarnation_id=?1",
                [incarnation_id.as_str()], |row| row.get(0),
            )?;
            let now = now_millis();
            let next = revision
                .checked_add(1)
                .ok_or_else(|| RegistryError::Integrity("intent revision overflow".into()))?;
            tx.execute(
                "UPDATE souls SET desired_state='stopped',intent_revision=?1,recovery_state=CASE WHEN recovery_state='lost' THEN recovery_state ELSE 'stopped' END,recovery_reason=CASE WHEN recovery_state='lost' THEN recovery_reason ELSE 'STOP_INTENT' END,recovery_attempt_id=NULL,updated_at=?2 WHERE soul_id=?3 AND intent_revision=?4",
                params![next, now, soul_id.as_str(), revision],
            )?;
            tx.execute(
                "INSERT INTO stop_tombstones (soul_id,intent_revision,actor,reason,committed_at) VALUES (?1,?2,'supervisor','managed stop',?3)",
                params![soul_id.as_str(), next, now],
            )?;
            let committed_revision = next;
            crate::view_intents::hide_automatic_primary_in_tx(
                &tx,
                &soul_id,
                committed_revision,
                now,
            )?;
            if !matches!(launch_state.as_str(), "stopped" | "failed") {
                tx.execute(
                    "UPDATE incarnations SET launch_state='stopping',cleanup_state='requested',updated_at=?1 WHERE incarnation_id=?2",
                    params![now, incarnation_id.as_str()],
                )?;
            }
            tx.execute(
                "UPDATE input_commands SET state='ambiguous',updated_at=?1 WHERE soul_id=?2 AND state='dispatching'",
                params![now, soul_id.as_str()],
            )?;
            insert_ordinary_stop(&tx, &soul_id, &incarnation_id, next, execution_generation,
                owned.as_ref().ok(), owned.is_err().then_some(StopOutcome::BlockedOwnership))?;
            if owned.is_err() {
                tx.execute("UPDATE incarnations SET cleanup_state='blocked_ownership' WHERE incarnation_id=?1", [incarnation_id.as_str()])?;
            }
            tx.commit()?;
            let mut handle = owned?;
            handle.ordinary_stop = Some(Box::new(StopFence { intent_revision: next, execution_generation }));
            Ok(handle)
        })
        .await
    }

    /// Only the exact, still-current ordinary transaction issues a Stop
    /// handle. Lost cleanup and repaired stopped data use separate authority.
    pub async fn pending_stop_handles(&self) -> Result<Vec<OwnedRuntimeHandle>, RegistryError> {
        let installation = self.installation_id().clone();
        self.run_blocking(move |conn| {
            let mut query = conn.prepare("SELECT p.incarnation_id,p.intent_revision,p.execution_generation FROM ordinary_stops p JOIN souls s ON s.soul_id=p.soul_id WHERE p.settled=0 AND s.desired_state='stopped' AND s.intent_revision=p.intent_revision ORDER BY p.updated_at,p.soul_id")?;
            let rows = query.query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,u64>(1)?,r.get::<_,u64>(2)?)))?.collect::<Result<Vec<_>,_>>()?;
            let mut handles = Vec::new();
            for (raw, intent_revision, execution_generation) in rows {
                let incarnation = IncarnationId::parse(raw).map_err(|_| RegistryError::Integrity("invalid Stop incarnation".into()))?;
                match load_owned_handle(&conn, installation.clone(), &incarnation) {
                    Ok(mut handle) => {
                        handle.ordinary_stop = Some(Box::new(StopFence { intent_revision, execution_generation }));
                        if validate_ordinary_stop(&conn, &handle).is_ok() { handles.push(handle); }
                    }
                    Err(error) => tracing::warn!(incarnation_id=%incarnation, intent_revision, execution_generation, reason="blocked_ownership", error=%error, "supervisor.stop_pending_unowned"),
                }
            }
            Ok(handles)
        }).await
    }

    pub(crate) async fn stop_progress(
        &self,
        handle: &OwnedRuntimeHandle,
    ) -> Result<StopProgress, RegistryError> {
        let handle = handle.clone();
        self.run_blocking(move |conn| validate_ordinary_stop(&conn, &handle))
            .await
    }

    pub(crate) async fn record_ordinary_stop_outcome(
        &self,
        handle: &OwnedRuntimeHandle,
        outcome: StopOutcome,
    ) -> Result<(), RegistryError> {
        let handle = handle.clone();
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let progress = validate_ordinary_stop(&tx, &handle)?;
            if !progress.settled && progress.outcome != Some(StopOutcome::VerifiedEmpty) {
                mark_stop_outcome_in_tx(&tx, handle.incarnation_id(), outcome)?;
                let pending = outcome == StopOutcome::VerifiedEmpty && progress.capability.is_some();
                tx.execute("UPDATE ordinary_stops SET outcome=?1,revoke_pending=?2,settled=?3,updated_at=?4 WHERE soul_id=?5 AND incarnation_id=?6 AND intent_revision=?7",
                    params![stop_outcome_name(outcome),pending,outcome == StopOutcome::VerifiedEmpty && !pending,now_millis(),handle.soul_id().as_str(),handle.incarnation_id().as_str(),handle.stop_fence()?.intent_revision])?;
            }
            tx.commit()?;
            Ok(())
        }).await
    }

    pub(crate) async fn acknowledge_stop_revoke(
        &self,
        handle: &OwnedRuntimeHandle,
        endpoint: &str,
        grant_id: &str,
    ) -> Result<(), RegistryError> {
        let handle = handle.clone();
        let capability = (endpoint.to_owned(), grant_id.to_owned());
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let progress = validate_ordinary_stop(&tx, &handle)?;
            if progress.outcome != Some(StopOutcome::VerifiedEmpty) || progress.capability.as_ref() != Some(&capability) {
                return Err(RegistryError::InvalidState("Stop revoke acknowledgement changed target".into()));
            }
            tx.execute("UPDATE ordinary_stops SET revoke_pending=0,settled=1,updated_at=?1 WHERE soul_id=?2 AND incarnation_id=?3 AND intent_revision=?4 AND revoke_pending=1",
                params![now_millis(),handle.soul_id().as_str(),handle.incarnation_id().as_str(),handle.stop_fence()?.intent_revision])?;
            tx.commit()?;
            Ok(())
        }).await
    }

    /// Explicitly resumes a soul whose stopped OpenCode store was repaired.
    /// The repair receipt and canonical origin owner must still be present;
    /// this transition never creates a new soul or imports host data again.
    pub async fn start_stopped_data_repair(
        &self,
        soul_id: SoulId,
        expected_intent_revision: u64,
    ) -> Result<u64, RegistryError> {
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let current: StoppedRepairStartStateRow = tx.query_row(
                "SELECT provider,desired_state,recovery_state,intent_revision,native_import_state,native_import_authority,native_import_source_store_id,native_import_root_session_id,native_import_source_generation FROM souls WHERE soul_id=?1",
                params![soul_id.as_str()],
                |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?,row.get(8)?)),
            )?;
            if current.3 != expected_intent_revision {
                return Err(RegistryError::StaleIntentRevision {
                    expected: expected_intent_revision,
                    current: current.3,
                });
            }
            let (Some(source_store_id), Some(root_session_id), Some(source_generation)) =
                (current.6.as_deref(), current.7.as_deref(), current.8.as_deref())
            else {
                return Err(RegistryError::RecoveryBlocked {
                    soul_id,
                    reason: "DATA_REPAIR_RECEIPT_MISSING".into(),
                });
            };
            if current.0 != "opencode"
                || current.1 != "stopped"
                || current.2 != "data_repair_complete"
                || current.4 != NativeImportState::Completed.as_str()
                || current.5 != "verified_import_receipt"
            {
                return Err(RegistryError::RecoveryBlocked {
                    soul_id,
                    reason: "DATA_REPAIR_NOT_RESUMABLE".into(),
                });
            }
            let canonical_owner: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM native_origin_owners WHERE provider='opencode' AND source_store_id=?1 AND native_root_session_id=?2 AND source_generation=?3 AND owner_soul_id=?4 AND ownership_state='owned')",
                params![source_store_id, root_session_id, source_generation, soul_id.as_str()],
                |row| row.get(0),
            )?;
            // Native publication commits before diagnostic withdrawal. A
            // malformed old log must not keep a verified repaired root stopped.
            let applied_repair: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM stopped_repair_root_receipts r JOIN stopped_repair_operations o ON o.operation_id=r.operation_id WHERE o.status IN ('withdraw_pending','complete') AND r.status='verified' AND r.canonical_soul_id=?1 AND r.root_session_id=?2 AND r.source_store_id=?3 AND r.source_generation=?4)",
                params![soul_id.as_str(), root_session_id, source_store_id, source_generation],
                |row| row.get(0),
            )?;
            if !canonical_owner || !applied_repair {
                return Err(RegistryError::RecoveryBlocked {
                    soul_id,
                    reason: "DATA_REPAIR_RECEIPT_MISSING".into(),
                });
            }
            let next_revision = expected_intent_revision
                .checked_add(1)
                .ok_or_else(|| RegistryError::Integrity("intent revision overflow".into()))?;
            let now = now_millis();
            let changed = tx.execute(
                "UPDATE souls SET desired_state='running',intent_revision=?1,recovery_reason=NULL,recovery_attempt_id=NULL,updated_at=?2 WHERE soul_id=?3 AND desired_state='stopped' AND recovery_state='data_repair_complete' AND intent_revision=?4",
                params![next_revision, now, soul_id.as_str(), expected_intent_revision],
            )?;
            if changed != 1 {
                return Err(RegistryError::StaleIntentRevision {
                    expected: expected_intent_revision,
                    current: current.3,
                });
            }
            tx.execute(
                "UPDATE view_intents SET soul_intent_revision=?1,updated_at=?2 WHERE soul_id=?3",
                params![next_revision, now, soul_id.as_str()],
            )?;
            tx.commit()?;
            Ok(next_revision)
        })
        .await
    }

    pub async fn validate_stop_cleanup_target(
        &self,
        soul_id: SoulId,
        incarnation_id: IncarnationId,
    ) -> Result<(), RegistryError> {
        self.run_blocking(move |conn| {
            let current: Option<(String, String)> = conn
                .query_row(
                    "SELECT s.desired_state,(SELECT i.incarnation_id FROM incarnations i WHERE i.soul_id=s.soul_id ORDER BY i.created_at DESC LIMIT 1) FROM souls s WHERE s.soul_id=?1",
                    params![soul_id.as_str()],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let Some((desired_state, current_incarnation)) = current else {
                return Err(RegistryError::UnknownSoul(soul_id));
            };
            if desired_state != "stopped" || current_incarnation != incarnation_id.as_str() {
                return Err(RegistryError::InvalidState(
                    "stop cleanup target changed while waiting for the soul coordinator".into(),
                ));
            }
            Ok(())
        })
        .await
    }

    pub async fn mark_stop_outcome(
        &self,
        incarnation_id: IncarnationId,
        outcome: StopOutcome,
    ) -> Result<(), RegistryError> {
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            mark_stop_outcome_in_tx(&tx, &incarnation_id, outcome)?;
            tx.commit()?;
            Ok(())
        })
        .await
    }

    pub async fn begin_input(
        &self,
        soul_id: SoulId,
        request_id: RequestId,
        data: &[u8],
        correlation: Option<&[u8]>,
    ) -> Result<(InputJournalDisposition, IncarnationId), RegistryError> {
        self.begin_input_with_settings(soul_id, request_id, data, correlation, None)
            .await
    }

    pub(crate) async fn begin_fresh_input(
        &self,
        soul_id: SoulId,
        request_id: RequestId,
        data: &[u8],
        correlation: &[u8],
        settings: Option<FreshAgentTurnSettings>,
    ) -> Result<(InputJournalDisposition, IncarnationId), RegistryError> {
        self.begin_input_with_settings(soul_id, request_id, data, Some(correlation), settings)
            .await
    }

    async fn begin_input_with_settings(
        &self,
        soul_id: SoulId,
        request_id: RequestId,
        data: &[u8],
        correlation: Option<&[u8]>,
        settings: Option<FreshAgentTurnSettings>,
    ) -> Result<(InputJournalDisposition, IncarnationId), RegistryError> {
        let payload_digest = input_payload_digest(data, correlation);
        let protected_payload = data.to_vec();
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if let Some((existing_digest, existing_payload, state, recorded_incarnation)) = tx
                .query_row(
                    "SELECT payload_digest,protected_payload,state,incarnation_id FROM input_commands WHERE soul_id=?1 AND request_id=?2",
                    params![soul_id.as_str(), request_id.as_str()],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, Vec<u8>>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                        ))
                    },
                )
                .optional()?
            {
                if existing_digest != payload_digest || existing_payload != protected_payload {
                    return Err(RegistryError::InputConflict);
                }
                let recorded_incarnation = IncarnationId::parse(recorded_incarnation)
                    .map_err(|_| RegistryError::Integrity("invalid input incarnation id".into()))?;
                match state.as_str() {
                    "completed" => {
                        tx.commit()?;
                        return Ok((InputJournalDisposition::Completed, recorded_incarnation));
                    }
                    "dispatching" | "ambiguous" => {
                        tx.commit()?;
                        return Ok((InputJournalDisposition::Ambiguous, recorded_incarnation));
                    }
                    "queued" => {}
                    other => {
                        return Err(RegistryError::Integrity(format!(
                            "unknown input command state {other}"
                        )))
                    }
                }
            }

            let incarnation_raw: String = tx
                .query_row(
                    "SELECT i.incarnation_id FROM incarnations i JOIN souls s ON s.soul_id=i.soul_id WHERE i.soul_id=?1 AND i.launch_state='running' AND s.desired_state='running' AND s.recovery_state='live' ORDER BY i.created_at DESC LIMIT 1",
                    params![soul_id.as_str()],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or_else(|| RegistryError::UnknownSoul(soul_id.clone()))?;
            let incarnation_id = IncarnationId::parse(incarnation_raw)
                .map_err(|_| RegistryError::Integrity("invalid incarnation id".into()))?;

            // A settings refusal must roll back admission of the prompt too.
            // Recovery consumes every queued row, so publishing it separately
            // could later dispatch text from an already rejected request.
            if let Some(settings) = settings {
                update_fresh_agent_settings_in_tx(&tx, &soul_id, &incarnation_id, settings, SettingsFold::Turn)?;
            }
            let now = now_millis();
            let changed = tx.execute(
                "UPDATE input_commands SET incarnation_id=?1,updated_at=?2 WHERE soul_id=?3 AND request_id=?4 AND state='queued'",
                params![incarnation_id.as_str(), now, soul_id.as_str(), request_id.as_str()],
            )?;
            if changed == 0 {
                tx.execute(
                    "INSERT INTO input_commands (soul_id,request_id,payload_digest,protected_payload,incarnation_id,state,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,'queued',?6,?6)",
                    params![soul_id.as_str(), request_id.as_str(), payload_digest, protected_payload, incarnation_id.as_str(), now],
                )?;
            }
            tx.commit()?;
            Ok((InputJournalDisposition::Dispatch, incarnation_id))
        })
        .await
    }

    /// Read a terminal result without depending on current provider liveness.
    /// Queued requests still require the normal admission path before dispatch.
    pub(crate) async fn recorded_input_outcome(
        &self,
        soul_id: SoulId,
        request_id: RequestId,
        data: &[u8],
        correlation: Option<&[u8]>,
    ) -> Result<Option<InputJournalDisposition>, RegistryError> {
        let digest = input_payload_digest(data, correlation);
        let payload = data.to_vec();
        self.run_blocking(move |conn| {
            let row: Option<(String, Vec<u8>, String)> = conn
                .query_row(
                    "SELECT payload_digest,protected_payload,state FROM input_commands WHERE soul_id=?1 AND request_id=?2",
                    params![soul_id.as_str(), request_id.as_str()],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;
            let Some((stored_digest, stored_payload, state)) = row else {
                return Ok(None);
            };
            if stored_digest != digest || stored_payload != payload {
                return Err(RegistryError::InputConflict);
            }
            match state.as_str() {
                "completed" => Ok(Some(InputJournalDisposition::Completed)),
                "dispatching" | "ambiguous" => Ok(Some(InputJournalDisposition::Ambiguous)),
                "queued" => Ok(None),
                _ => Err(RegistryError::Integrity(format!("unknown input command state {state}"))),
            }
        })
        .await
    }

    /// Folds a send's turn settings into the soul's recovery launch spec.
    pub async fn update_fresh_agent_settings(
        &self,
        soul_id: SoulId,
        incarnation_id: IncarnationId,
        settings: FreshAgentTurnSettings,
    ) -> Result<(), RegistryError> {
        self.fold_fresh_agent_settings(soul_id, incarnation_id, settings, SettingsFold::Turn)
            .await
    }

    /// Folds a `freshAgent.configure` into the soul's recovery launch spec,
    /// with the same rule the host actor applies to its own copy.
    pub async fn configure_fresh_agent_settings(
        &self,
        soul_id: SoulId,
        incarnation_id: IncarnationId,
        settings: FreshAgentTurnSettings,
    ) -> Result<(), RegistryError> {
        self.fold_fresh_agent_settings(soul_id, incarnation_id, settings, SettingsFold::Configure)
            .await
    }

    async fn fold_fresh_agent_settings(
        &self,
        soul_id: SoulId,
        incarnation_id: IncarnationId,
        settings: FreshAgentTurnSettings,
        fold: SettingsFold,
    ) -> Result<(), RegistryError> {
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            update_fresh_agent_settings_in_tx(&tx, &soul_id, &incarnation_id, settings, fold)?;
            tx.commit()?;
            Ok(())
        })
        .await
    }

    pub async fn mark_input_dispatching(
        &self,
        soul_id: SoulId,
        request_id: RequestId,
    ) -> Result<(), RegistryError> {
        self.set_input_state(soul_id, request_id, "dispatching")
            .await
    }

    pub async fn disable_claude_fork_recovery_fenced(
        &self,
        soul_id: SoulId,
        fence: RecoveryWriteFence,
    ) -> Result<(), RegistryError> {
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            validate_recovery_write_fence(&tx, &soul_id, &fence)?;
            invalidate_claude_fork_recovery(&tx, &soul_id)?;
            tx.commit()?;
            Ok(())
        })
        .await
    }

    pub async fn mark_input_completed(
        &self,
        soul_id: SoulId,
        request_id: RequestId,
    ) -> Result<(), RegistryError> {
        self.set_input_state(soul_id, request_id, "completed").await
    }

    pub async fn mark_input_ambiguous(
        &self,
        soul_id: SoulId,
        request_id: RequestId,
    ) -> Result<(), RegistryError> {
        self.set_input_state(soul_id, request_id, "ambiguous").await
    }

    /// Atomically moves one never-dispatched command onto the replacement
    /// incarnation. Dispatching/ambiguous commands are deliberately excluded:
    /// response loss can never cause an interrupted prompt to be replayed.
    pub async fn claim_next_queued_input(
        &self,
        soul_id: SoulId,
        incarnation_id: IncarnationId,
    ) -> Result<Option<QueuedInput>, RegistryError> {
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let valid_target: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM incarnations i JOIN souls s ON s.soul_id=i.soul_id WHERE i.incarnation_id=?1 AND i.soul_id=?2 AND i.launch_state='running' AND s.desired_state='running')",
                params![incarnation_id.as_str(), soul_id.as_str()],
                |row| row.get(0),
            )?;
            if !valid_target {
                return Err(RegistryError::InvalidState(format!(
                    "replacement incarnation {incarnation_id} is not running for {soul_id}"
                )));
            }
            let queued: Option<(String, Vec<u8>)> = tx
                .query_row(
                    "SELECT request_id,protected_payload FROM input_commands WHERE soul_id=?1 AND state='queued' ORDER BY created_at,request_id LIMIT 1",
                    params![soul_id.as_str()],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let Some((request_raw, payload)) = queued else {
                tx.commit()?;
                return Ok(None);
            };
            let request_id = RequestId::parse(request_raw)
                .map_err(|_| RegistryError::Integrity("invalid queued request id".into()))?;
            let data = String::from_utf8(payload)
                .map_err(|_| RegistryError::Integrity("queued terminal input is not UTF-8".into()))?;
            let changed = tx.execute(
                "UPDATE input_commands SET incarnation_id=?1,state='dispatching',updated_at=?2 WHERE soul_id=?3 AND request_id=?4 AND state='queued'",
                params![incarnation_id.as_str(), now_millis(), soul_id.as_str(), request_id.as_str()],
            )?;
            if changed != 1 {
                return Err(RegistryError::InvalidState(
                    "queued input changed during replacement claim".into(),
                ));
            }
            invalidate_claude_fork_recovery(&tx, &soul_id)?;
            tx.commit()?;
            Ok(Some(QueuedInput { request_id, data }))
        })
        .await
    }

    async fn set_input_state(
        &self,
        soul_id: SoulId,
        request_id: RequestId,
        state: &'static str,
    ) -> Result<(), RegistryError> {
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let changed = tx.execute(
                "UPDATE input_commands SET state=?1,updated_at=?2 WHERE soul_id=?3 AND request_id=?4",
                params![state, now_millis(), soul_id.as_str(), request_id.as_str()],
            )?;
            if changed != 1 {
                return Err(RegistryError::InvalidState(format!(
                    "input command {} is not journaled",
                    request_id
                )));
            }
            if matches!(state, "dispatching" | "ambiguous") {
                invalidate_claude_fork_recovery(&tx, &soul_id)?;
            }
            tx.commit()?;
            Ok(())
        })
        .await
    }

    pub async fn record_native_session(
        &self,
        soul_id: SoulId,
        incarnation_id: IncarnationId,
        native_session_id: String,
    ) -> Result<(), RegistryError> {
        let fence = self.recovery_write_fence(soul_id.clone()).await?;
        self.record_native_session_fenced(soul_id, incarnation_id, native_session_id, fence)
            .await
            .map(|_| ())
    }

    pub async fn record_native_session_fenced(
        &self,
        soul_id: SoulId,
        incarnation_id: IncarnationId,
        native_session_id: String,
        fence: RecoveryWriteFence,
    ) -> Result<RecoveryWriteFence, RegistryError> {
        if native_session_id.is_empty() || native_session_id.chars().any(char::is_control) {
            return Err(RegistryError::NativeIdentityConflict);
        }
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            validate_recovery_write_fence(&tx, &soul_id, &fence)?;
            if incarnation_id != fence.active_incarnation_id {
                return Err(RegistryError::NativeIdentityConflict);
            }
            let (provider, store, existing, intent): (String, String, Option<String>, u64) = tx
                .query_row(
                    "SELECT provider,provider_store_id,native_session_id,intent_revision FROM souls WHERE soul_id=?1",
                    params![soul_id.as_str()],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .optional()?
                .ok_or_else(|| RegistryError::UnknownSoul(soul_id.clone()))?;
            let owner: String = tx
                .query_row(
                    "SELECT soul_id FROM incarnations WHERE incarnation_id=?1",
                    params![incarnation_id.as_str()],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or_else(|| RegistryError::UnknownIncarnation(incarnation_id.clone()))?;
            if owner != soul_id.as_str() || existing.as_deref().is_some_and(|id| id != native_session_id) {
                return Err(RegistryError::NativeIdentityConflict);
            }
            let fresh_agent_spec: Option<String> = tx.query_row(
                "SELECT fresh_agent_spec FROM incarnations WHERE incarnation_id=?1",
                params![incarnation_id.as_str()],
                |row| row.get(0),
            )?;
            if let Some(encoded) = fresh_agent_spec {
                let mut spec: FreshAgentLaunchSpec = serde_json::from_str(&encoded)
                    .map_err(|_| RegistryError::Integrity("invalid fresh-agent launch spec".into()))?;
                if spec
                    .native_session_id
                    .as_deref()
                    .is_some_and(|native| native != native_session_id)
                {
                    return Err(RegistryError::NativeIdentityConflict);
                }
                if spec.native_session_id.is_none() {
                    spec.native_session_id = Some(native_session_id.clone());
                    tx.execute(
                        "UPDATE incarnations SET fresh_agent_spec=?1,updated_at=?2 WHERE incarnation_id=?3",
                        params![serde_json::to_string(&spec)?, now_millis(), incarnation_id.as_str()],
                    )?;
                }
            }
            let now = now_millis();
            let identity_changed = existing.is_none();
            let updated = tx.execute(
                "UPDATE souls SET native_session_id=?1,identity_revision=identity_revision+?2,evidence_revision=evidence_revision+?2,allocation_state=CASE WHEN allocation_state='verified_durable' THEN allocation_state ELSE 'materializing' END,updated_at=?3 WHERE soul_id=?4 AND intent_revision=?5 AND identity_revision=?6 AND evidence_revision=?7",
                params![native_session_id, if identity_changed { 1_i64 } else { 0_i64 }, now, soul_id.as_str(), fence.intent_revision, fence.identity_revision, fence.evidence_revision],
            )?;
            if updated != 1 {
                return Err(RegistryError::NativeIdentityConflict);
            }
            let existing_claim: Option<String> = tx
                .query_row(
                    "SELECT incarnation_id FROM writer_claims WHERE provider=?1 AND provider_store_id=?2 AND native_session_id=?3",
                    params![provider, store, native_session_id],
                    |row| row.get(0),
                )
                .optional()?;
            match existing_claim {
                Some(claim) if claim == incarnation_id.as_str() => {}
                Some(_) => return Err(RegistryError::NativeIdentityConflict),
                None => {
                    tx.execute(
                        "INSERT INTO writer_claims (provider,provider_store_id,native_session_id,soul_id,incarnation_id,intent_revision) VALUES (?1,?2,?3,?4,?5,?6)",
                        params![provider, store, native_session_id, soul_id.as_str(), incarnation_id.as_str(), intent],
                    )?;
                }
            }
            let successor = load_recovery_write_fence(&tx, &soul_id)?;
            tx.commit()?;
            Ok(successor)
        })
        .await
    }

    pub async fn transition_native_session(
        &self,
        soul_id: SoulId,
        incarnation_id: IncarnationId,
        expected_parent: &str,
        child_session_id: &str,
    ) -> Result<(), RegistryError> {
        let fence = self.recovery_write_fence(soul_id.clone()).await?;
        self.transition_native_session_fenced(
            soul_id,
            incarnation_id,
            expected_parent,
            child_session_id,
            fence,
        )
        .await
        .map(|_| ())
    }

    pub async fn transition_native_session_fenced(
        &self,
        soul_id: SoulId,
        incarnation_id: IncarnationId,
        expected_parent: &str,
        child_session_id: &str,
        fence: RecoveryWriteFence,
    ) -> Result<RecoveryWriteFence, RegistryError> {
        self.transition_native_session_with_claude_fork_fenced(
            soul_id,
            incarnation_id,
            expected_parent,
            child_session_id,
            fence,
            None,
        )
        .await
    }

    pub async fn transition_native_session_with_claude_fork_fenced(
        &self,
        soul_id: SoulId,
        incarnation_id: IncarnationId,
        expected_parent: &str,
        child_session_id: &str,
        fence: RecoveryWriteFence,
        claude_fork: Option<freshell_runtime_protocol::ClaudeForkRecipe>,
    ) -> Result<RecoveryWriteFence, RegistryError> {
        self.transition_native_session_evidenced_fenced(
            soul_id,
            incarnation_id,
            expected_parent,
            child_session_id,
            fence,
            NativeSessionTransitionEvidence::Operation(claude_fork),
        )
        .await
    }

    pub async fn transition_claude_clear_fenced(
        &self,
        soul_id: SoulId,
        incarnation_id: IncarnationId,
        expected_parent: &str,
        child_session_id: &str,
        fence: RecoveryWriteFence,
        observation: freshell_runtime_protocol::NativeIdentityObservation,
    ) -> Result<RecoveryWriteFence, RegistryError> {
        self.transition_native_session_evidenced_fenced(
            soul_id,
            incarnation_id,
            expected_parent,
            child_session_id,
            fence,
            NativeSessionTransitionEvidence::ClaudeClear(observation),
        )
        .await
    }

    async fn transition_native_session_evidenced_fenced(
        &self,
        soul_id: SoulId,
        incarnation_id: IncarnationId,
        expected_parent: &str,
        child_session_id: &str,
        fence: RecoveryWriteFence,
        evidence: NativeSessionTransitionEvidence,
    ) -> Result<RecoveryWriteFence, RegistryError> {
        let (claude_fork, native_clear) = match evidence {
            NativeSessionTransitionEvidence::Operation(recipe) => (recipe, None),
            NativeSessionTransitionEvidence::ClaudeClear(observation) => (None, Some(observation)),
        };
        if let Some(recipe) = &claude_fork {
            recipe
                .validate(child_session_id)
                .map_err(|_| RegistryError::NativeIdentityConflict)?;
        }
        let expected_parent = expected_parent.to_string();
        let child_session_id = child_session_id.to_string();
        if expected_parent.is_empty()
            || child_session_id.is_empty()
            || expected_parent == child_session_id
            || expected_parent.chars().any(char::is_control)
            || child_session_id.chars().any(char::is_control)
        {
            return Err(RegistryError::NativeIdentityConflict);
        }
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            validate_recovery_write_fence(&tx, &soul_id, &fence)?;
            if incarnation_id != fence.active_incarnation_id {
                return Err(RegistryError::NativeIdentityConflict);
            }
            let (provider, store, existing, intent): (String, String, Option<String>, u64) = tx
                .query_row(
                    "SELECT provider,provider_store_id,native_session_id,intent_revision FROM souls WHERE soul_id=?1",
                    params![soul_id.as_str()],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .optional()?
                .ok_or_else(|| RegistryError::UnknownSoul(soul_id.clone()))?;
            let owner: String = tx.query_row(
                "SELECT soul_id FROM incarnations WHERE incarnation_id=?1",
                params![incarnation_id.as_str()], |row| row.get(0),
            ).optional()?.ok_or_else(|| RegistryError::UnknownIncarnation(incarnation_id.clone()))?;
            if owner != soul_id.as_str() {
                return Err(RegistryError::NativeIdentityConflict);
            }
            if claude_fork.is_some() && !matches!(provider.as_str(), "claude" | "kilroy") {
                return Err(RegistryError::NativeIdentityConflict);
            }
            let (launch, nonce, generation, prior_observation): (Option<String>, String, u64, Option<String>) = tx.query_row(
                "SELECT native_identity_launch,launch_nonce,execution_generation,native_identity_observation FROM incarnations WHERE incarnation_id=?1",
                params![incarnation_id.as_str()], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            if let Some(observation) = native_clear.as_ref() {
                let binding: freshell_runtime_protocol::NativeIdentityLaunch = serde_json::from_str(
                    launch.as_deref().ok_or(RegistryError::NativeIdentityConflict)?
                )?;
                if !matches!(provider.as_str(), "claude" | "kilroy")
                    || observation.source != freshell_runtime_protocol::NativeIdentitySource::ClaudeNativeClear
                    || observation.native_session_id != child_session_id
                    || !observation.matches_launch(&binding)
                    || binding.incarnation_id != incarnation_id
                    || binding.launch_nonce != nonce
                    || binding.execution_generation != generation
                {
                    return Err(RegistryError::NativeIdentityConflict);
                }
            }
            // The response to a successful provider fork can be lost. Retrying
            // the same transition after durable commit is idempotent.
            if existing.as_deref() == Some(child_session_id.as_str()) {
                let claim: Option<String> = tx.query_row(
                    "SELECT incarnation_id FROM writer_claims WHERE provider=?1 AND provider_store_id=?2 AND native_session_id=?3",
                    params![provider, store, child_session_id], |row| row.get(0),
                ).optional()?;
                if claim.as_deref() != Some(incarnation_id.as_str()) {
                    return Err(RegistryError::NativeIdentityConflict);
                }
                let successor = load_recovery_write_fence(&tx, &soul_id)?;
                tx.commit()?;
                return Ok(successor);
            }
            if existing.as_deref() != Some(expected_parent.as_str()) {
                return Err(RegistryError::NativeIdentityConflict);
            }
            let (fresh_spec, terminal_spec): (Option<String>, Option<String>) = tx.query_row(
                "SELECT fresh_agent_spec,terminal_spec FROM incarnations WHERE incarnation_id=?1",
                params![incarnation_id.as_str()], |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            let mut fresh_spec = fresh_spec.map(|encoded| serde_json::from_str::<FreshAgentLaunchSpec>(&encoded))
                .transpose().map_err(|_| RegistryError::Integrity("invalid fresh-agent launch spec".into()))?;
            let terminal_spec = terminal_spec.map(|encoded| serde_json::from_str::<TerminalLaunchSpec>(&encoded))
                .transpose().map_err(|_| RegistryError::Integrity("invalid terminal launch spec".into()))?;
            match (&fresh_spec, &terminal_spec) {
                (Some(spec), _) if spec.native_session_id.as_deref() == Some(expected_parent.as_str()) => {},
                (None, Some(spec)) if matches!(provider.as_str(), "claude" | "opencode") && spec.mode == provider => {},
                _ => return Err(RegistryError::NativeIdentityConflict),
            }
            let conflicting: Option<String> = tx.query_row(
                "SELECT incarnation_id FROM writer_claims WHERE provider=?1 AND provider_store_id=?2 AND native_session_id=?3",
                params![provider, store, child_session_id], |row| row.get(0),
            ).optional()?;
            if conflicting.is_some() {
                return Err(RegistryError::NativeIdentityConflict);
            }
            let removed = tx.execute(
                "DELETE FROM writer_claims WHERE provider=?1 AND provider_store_id=?2 AND native_session_id=?3 AND soul_id=?4 AND incarnation_id=?5",
                params![provider, store, expected_parent, soul_id.as_str(), incarnation_id.as_str()],
            )?;
            if removed != 1 {
                return Err(RegistryError::NativeIdentityConflict);
            }
            tx.execute(
                "INSERT INTO writer_claims (provider,provider_store_id,native_session_id,soul_id,incarnation_id,intent_revision) VALUES (?1,?2,?3,?4,?5,?6)",
                params![provider, store, child_session_id, soul_id.as_str(), incarnation_id.as_str(), intent],
            )?;
            // An in-soul reroot changes both the provider-native writer key
            // and the externally resumable presentation key. Persist them
            // together so a web-server restart cannot rediscover the retired
            // parent through inventory fallback.
            let now = now_millis();
            if let Some(spec) = fresh_spec.as_mut() {
                spec.session_id = child_session_id.clone();
                spec.native_session_id = Some(child_session_id.clone());
                if let Some(reference) = spec.session_ref.as_mut() {
                    reference.session_id = child_session_id.clone();
                }
                tx.execute(
                    "UPDATE incarnations SET fresh_agent_spec=?1,updated_at=?2 WHERE incarnation_id=?3",
                    params![serde_json::to_string(spec)?, now, incarnation_id.as_str()],
                )?;
            }
            // The terminal launch spec is part of Docker's immutable
            // ownership digest. The soul row and writer claim carry the live
            // identity; exact recovery creates a new launch from that id.
            // Any prior resume proof names the old branch. It must be
            // re-materialized from the child before a later replacement.
            let updated = tx.execute(
                "UPDATE souls SET native_session_id=?1,identity_revision=identity_revision+1,evidence_revision=evidence_revision+1,resume_spec=NULL,allocation_state='materializing',durability_state='live_only',checkpoint_revision=0,updated_at=?2,claude_fork_recipe=?7 WHERE soul_id=?3 AND intent_revision=?4 AND identity_revision=?5 AND evidence_revision=?6",
                params![child_session_id, now, soul_id.as_str(), fence.intent_revision, fence.identity_revision, fence.evidence_revision, claude_fork.as_ref().map(serde_json::to_string).transpose()?],
            )?;
            if updated != 1 {
                return Err(RegistryError::NativeIdentityConflict);
            }
            // A native clear happens inside the existing launched producer.
            // Explicit fork/rollback acknowledgements bind a new operation.
            if let Some(launch) = launch.filter(|_| fresh_spec.is_some() && native_clear.is_none()) {
                let mut launch: freshell_runtime_protocol::NativeIdentityLaunch = serde_json::from_str(&launch)?;
                let cleared_parent = prior_observation.as_deref()
                    .and_then(|encoded| serde_json::from_str::<freshell_runtime_protocol::NativeIdentityObservation>(encoded).ok())
                    .is_some_and(|observation| {
                        matches!(provider.as_str(), "claude" | "kilroy")
                            && observation.source == freshell_runtime_protocol::NativeIdentitySource::ClaudeNativeClear
                            && observation.native_session_id == expected_parent
                            && observation.matches_launch(&launch)
                    });
                if launch.incarnation_id != incarnation_id
                    || launch.launch_nonce != nonce
                    || launch.execution_generation != generation
                    || (launch.requested_native_session_id.as_deref().is_some_and(|root| root != expected_parent) && !cleared_parent)
                {
                    return Err(RegistryError::NativeIdentityConflict);
                }
                launch.evidence_revision = launch.evidence_revision.checked_add(1).ok_or(RegistryError::NativeIdentityConflict)?;
                launch.requested_native_session_id = Some(child_session_id.clone());
                tx.execute("UPDATE incarnations SET native_identity_launch=?1,native_identity_observation=NULL WHERE incarnation_id=?2",
                    params![serde_json::to_string(&launch)?,incarnation_id.as_str()])?;
            }
            if let Some(observation) = native_clear.as_ref() {
                // Keep the already validated current proof atomically with its
                // new root so a subsequent explicit operation can use it.
                tx.execute("UPDATE incarnations SET native_identity_observation=?2 WHERE incarnation_id=?1",
                    params![incarnation_id.as_str(), serde_json::to_string(observation)?])?;
            }
            let successor = load_recovery_write_fence(&tx, &soul_id)?;
            tx.commit()?;
            Ok(successor)
        }).await
    }

    pub async fn store_verified_resume_spec(
        &self,
        soul_id: SoulId,
        resume_spec: ResumeSpec,
    ) -> Result<ResumeSpec, RegistryError> {
        let fence = self.recovery_write_fence(soul_id.clone()).await?;
        self.store_verified_resume_spec_fenced(soul_id, resume_spec, fence)
            .await
    }

    pub async fn store_verified_resume_spec_fenced(
        &self,
        soul_id: SoulId,
        resume_spec: ResumeSpec,
        fence: RecoveryWriteFence,
    ) -> Result<ResumeSpec, RegistryError> {
        self.store_verified_resume_spec_in_phase(
            soul_id,
            resume_spec,
            fence,
            ResumeSpecCapturePhase::ActiveIncarnation,
        )
        .await
    }

    /// Recovery may start from the exact latest already-retired prior. Capture
    /// the positively read owned store before replacement so re-entry retains
    /// the exact native resume input. This never relaxes the active-only API.
    pub(crate) async fn store_verified_recovery_resume_spec_fenced(
        &self,
        soul_id: SoulId,
        resume_spec: ResumeSpec,
        fence: RecoveryWriteFence,
    ) -> Result<ResumeSpec, RegistryError> {
        self.store_verified_resume_spec_in_phase(
            soul_id,
            resume_spec,
            fence,
            ResumeSpecCapturePhase::RecoveryPrior,
        )
        .await
    }

    async fn store_verified_resume_spec_in_phase(
        &self,
        soul_id: SoulId,
        resume_spec: ResumeSpec,
        fence: RecoveryWriteFence,
        phase: ResumeSpecCapturePhase,
    ) -> Result<ResumeSpec, RegistryError> {
        self.store_verified_resume_spec_inner(soul_id, resume_spec, None, fence, phase)
            .await?
            .ok_or_else(|| {
                RegistryError::Integrity(
                    "unfenced resume evidence update was unexpectedly superseded".into(),
                )
            })
    }

    /// Store provider-store evidence only if the incarnation and evidence
    /// revision observed before the read are still current. An incarnation may
    /// remain usable for a retry after its soul is blocked, including when a
    /// failed cleanup left it stopping; `None` means its source or state changed.
    pub async fn store_verified_resume_spec_for_live_incarnation(
        &self,
        soul_id: SoulId,
        incarnation_id: IncarnationId,
        expected_evidence_revision: u64,
        resume_spec: ResumeSpec,
    ) -> Result<Option<ResumeSpec>, RegistryError> {
        let fence = self.recovery_write_fence(soul_id.clone()).await?;
        self.store_verified_resume_spec_for_live_incarnation_fenced(
            soul_id,
            incarnation_id,
            expected_evidence_revision,
            resume_spec,
            fence,
        )
        .await
    }

    pub async fn store_verified_resume_spec_for_live_incarnation_fenced(
        &self,
        soul_id: SoulId,
        incarnation_id: IncarnationId,
        expected_evidence_revision: u64,
        resume_spec: ResumeSpec,
        fence: RecoveryWriteFence,
    ) -> Result<Option<ResumeSpec>, RegistryError> {
        self.store_verified_resume_spec_inner(
            soul_id,
            resume_spec,
            Some((incarnation_id, expected_evidence_revision)),
            fence,
            ResumeSpecCapturePhase::ActiveIncarnation,
        )
        .await
    }

    async fn store_verified_resume_spec_inner(
        &self,
        soul_id: SoulId,
        mut resume_spec: ResumeSpec,
        expected_live_source: Option<(IncarnationId, u64)>,
        fence: RecoveryWriteFence,
        phase: ResumeSpecCapturePhase,
    ) -> Result<Option<ResumeSpec>, RegistryError> {
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            match phase {
                ResumeSpecCapturePhase::ActiveIncarnation => validate_recovery_write_fence(&tx, &soul_id, &fence)?,
                ResumeSpecCapturePhase::RecoveryPrior => validate_recovery_resume_capture_fence(&tx, &soul_id, &fence)?,
            }
            if let Some(recipe) = &resume_spec.claude_fork {
                let current: Option<String> = tx.query_row("SELECT claude_fork_recipe FROM souls WHERE soul_id=?1", params![soul_id.as_str()], |row| row.get(0))?;
                let current: Option<freshell_runtime_protocol::ClaudeForkRecipe> = current.map(|raw| serde_json::from_str(&raw)).transpose()?;
                if current.as_ref() != Some(recipe) { return Err(RegistryError::NativeIdentityConflict); }
            }
            let (provider, store, native, evidence, existing): (
                String,
                String,
                Option<String>,
                u64,
                Option<String>,
            ) = tx
                .query_row(
                    "SELECT provider,provider_store_id,native_session_id,evidence_revision,resume_spec FROM souls WHERE soul_id=?1",
                    params![soul_id.as_str()],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                        ))
                    },
                )
                .optional()?
                .ok_or_else(|| RegistryError::UnknownSoul(soul_id.clone()))?;
            if let Some((incarnation_id, expected_revision)) = expected_live_source.as_ref() {
                let current: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM incarnations i JOIN souls s ON s.soul_id=i.soul_id WHERE s.soul_id=?1 AND i.incarnation_id=?2 AND (i.launch_state='running' OR (i.launch_state='stopping' AND s.recovery_state='blocked')) AND s.desired_state='running' AND s.recovery_state IN ('live','blocked') AND s.recovery_attempt_id IS NULL AND s.evidence_revision=?3)",
                    params![soul_id.as_str(), incarnation_id.as_str(), expected_revision],
                    |row| row.get(0),
                )?;
                if !current {
                    tx.commit()?;
                    return Ok(None);
                }
            }
            if provider != resume_spec.provider_session.provider
                || store != resume_spec.provider_session.provider_store_id
                || native.as_deref() != Some(resume_spec.provider_session.native_session_id.as_str())
            {
                return Err(RegistryError::NativeIdentityConflict);
            }
            if let Some(existing) = existing {
                let existing: ResumeSpec = serde_json::from_str(&existing)?;
                if existing.provider_session == resume_spec.provider_session
                    && existing.claude_fork == resume_spec.claude_fork
                    && existing.program == resume_spec.program
                    && existing.cwd == resume_spec.cwd
                    && existing.workspace_path == resume_spec.workspace_path
                    && existing.environment == resume_spec.environment
                    && existing.opencode_adoption_baseline
                        == resume_spec.opencode_adoption_baseline
                    && existing.checkpoint_revision == resume_spec.checkpoint_revision
                    && existing.checkpoint_references == resume_spec.checkpoint_references
                    && existing.durable_position == resume_spec.durable_position
                {
                    tx.commit()?;
                    return Ok(Some(existing));
                }
            }
            let next_evidence = evidence
                .checked_add(1)
                .ok_or_else(|| RegistryError::Integrity("evidence revision overflow".into()))?;
            resume_spec.evidence_revision = next_evidence;
            resume_spec.allocation_state = AllocationState::VerifiedDurable;
            let encoded = serde_json::to_string(&resume_spec)?;
            let durability_state = if resume_spec.checkpoint_revision > 0 {
                "checkpoint_captured"
            } else {
                "resume_captured"
            };
            let changed = tx.execute(
                "UPDATE souls SET resume_spec=?1,evidence_revision=?2,allocation_state='verified_durable',durability_state=?3,checkpoint_revision=?4,updated_at=?5,claude_fork_recipe=?11 WHERE soul_id=?6 AND intent_revision=?7 AND identity_revision=?8 AND native_import_revision=?9 AND evidence_revision=?10",
                params![
                    encoded,
                    next_evidence,
                    durability_state,
                    resume_spec.checkpoint_revision,
                    now_millis(),
                    soul_id.as_str(),
                    fence.intent_revision,
                    fence.identity_revision,
                    fence.native_import_revision,
                    fence.evidence_revision,
                    resume_spec.claude_fork.as_ref().map(serde_json::to_string).transpose()?,
                ],
            )?;
            if changed != 1 {
                return Err(RegistryError::InvalidState(
                    "resume evidence changed while committing its verification".into(),
                ));
            }
            tx.commit()?;
            Ok(Some(resume_spec))
        })
        .await
    }

    pub async fn recovery_context(
        &self,
        soul_id: SoulId,
    ) -> Result<RecoveryContext, RegistryError> {
        let installation = self.installation_id().clone();
        // Keep the large context out of Tokio's blocking-task return storage
        // and its initialization temporaries on the recovery caller's stack.
        self.run_blocking(move |conn| {
            load_recovery_context(&conn, installation, &soul_id).map(Box::new)
        })
        .await
        .map(|context| *context)
    }

    /// Validate and durably register one exact stopped-repair batch before
    /// source discovery or transfer staging begins. The operation ID is also
    /// the idempotency key, so an HTTP retry cannot silently select a new set.
    pub(crate) async fn prepare_stopped_repair_operation(
        &self,
        operation_id: RequestId,
        request: RestoreLostSoulsRequest,
        scope: freshell_runtime_protocol::RepairBatchScope,
    ) -> Result<StoppedRepairOperation, RegistryError> {
        request
            .validate_exact_batch(&scope)
            .map_err(|_| RegistryError::RequestConflict)?;
        let scope_json = serde_json::to_string(&scope)?;
        let mut owner_choices = request.canonical_owners;
        owner_choices.sort_by(|left, right| left.root_session_id.cmp(&right.root_session_id));
        let owner_choices_json = serde_json::to_string(&owner_choices)?;
        let mut targets = request.targets;
        targets.sort_by(|left, right| {
            left.soul_id
                .as_str()
                .cmp(right.soul_id.as_str())
                .then_with(|| left.incident_id.as_str().cmp(right.incident_id.as_str()))
        });
        let targets_json = serde_json::to_string(&targets)?;
        let target_fingerprint = format!("{:x}", Sha256::digest(serde_json::to_vec(&targets)?));
        let operation_id_text = operation_id.to_string();
        let expected_epoch = request.expected_control_epoch;
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let current_epoch: u64 = tx.query_row(
                "SELECT control_epoch FROM installation WHERE singleton=1",
                [],
                |row| row.get(0),
            )?;
            if let Some(expected) = expected_epoch {
                if expected != current_epoch {
                    return Err(RegistryError::StaleControlEpoch {
                        expected,
                        current: current_epoch,
                    });
                }
            }

            type ExistingStoppedRepairOperationRow=(String,String,Option<String>,Option<String>,String);
            let existing: Option<ExistingStoppedRepairOperationRow> = tx
                .query_row(
                    "SELECT target_fingerprint,status,result_json,scope_json,owner_choices_json FROM stopped_repair_operations \
                     WHERE idempotency_key=?1",
                    params![operation_id_text],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
                )
                .optional()?;
            if let Some((existing_fingerprint, status, result_json, existing_scope, existing_choices)) = existing {
                if existing_fingerprint != target_fingerprint || existing_scope.as_deref() != Some(&scope_json) {
                    return Err(RegistryError::RequestConflict);
                }
                let existing_choices:Vec<freshell_runtime_protocol::CanonicalOwnerChoice>=serde_json::from_str(&existing_choices)?;
                if existing_choices.iter().any(|old|!owner_choices.contains(old)) {return Err(RegistryError::RequestConflict);}
                for choice in owner_choices.iter().filter(|choice|!existing_choices.contains(choice)) {
                    let root_has_receipt:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM stopped_repair_root_receipts WHERE operation_id=?1 AND root_session_id=?2)",params![operation_id_text,choice.root_session_id],|row|row.get(0))?;
                    if status!="importing" || root_has_receipt {return Err(RegistryError::RequestConflict);}
                }
                // The final database CAS removes the false loss rows before
                // the coordinated artifact withdrawal finishes. Once that
                // point is reached, retries must resume the durable
                // withdrawal record and must not revalidate a LOST-state
                // target that the successful CAS has already corrected.
                if matches!(status.as_str(), "withdraw_pending" | "complete") {
                    tx.commit()?;
                    return Ok(StoppedRepairOperation {
                        status,
                        result_json,
                    });
                }
            }

            for target in &targets {
                validate_stopped_repair_target_in_tx(&tx, target)?;
            }
            crate::stopped_repair_cas::validate_scope_members(&tx, &scope)?;
            crate::stopped_repair_cas::validate_scope_owner_evidence(&tx,&scope,&owner_choices)?;

            let now = now_millis();
            tx.execute(
                "INSERT INTO stopped_repair_operations \
                 (operation_id,idempotency_key,target_fingerprint,targets_json,scope_json,owner_choices_json,status,result_json,created_at,updated_at) \
                 VALUES (?1,?1,?2,?3,?5,?6,'importing',NULL,?4,?4) \
                 ON CONFLICT(idempotency_key) DO UPDATE SET updated_at=excluded.updated_at,owner_choices_json=excluded.owner_choices_json \
                 WHERE target_fingerprint=excluded.target_fingerprint",
                params![operation_id_text, target_fingerprint, targets_json, now, scope_json,owner_choices_json],
            )?;
            let (status, result_json): (String, Option<String>) = tx.query_row(
                "SELECT status,result_json FROM stopped_repair_operations WHERE operation_id=?1",
                params![operation_id_text],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            tx.commit()?;
            Ok(StoppedRepairOperation { status, result_json })
        })
        .await
    }

    pub(crate) async fn stopped_repair_owner_candidates(
        &self,
        root_session_id: String,
    ) -> Result<Vec<StoppedRepairOwnerCandidate>, RegistryError> {
        self.run_blocking(move |conn| {
            stopped_repair_owner_candidates_in_connection(&conn, &root_session_id)
        })
        .await
    }

    pub(crate) async fn persist_stopped_repair_root_receipt(
        &self,
        operation_id: RequestId,
        target: LostSoulRepairTarget,
        context: RecoveryContext,
        receipt: StoppedRepairRootReceipt,
    ) -> Result<(), RegistryError> {
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let operation_status: String = tx.query_row(
                "SELECT status FROM stopped_repair_operations WHERE operation_id=?1",
                params![operation_id.as_str()],
                |row| row.get(0),
            )?;
            if operation_status != "importing"
                || receipt.canonical_soul_id != target.soul_id
                || receipt.captured_intent_revision != target.expected_intent_revision
                || context.soul_id != target.soul_id
                || context.intent_revision != target.expected_intent_revision
                || context.provider != "opencode"
                || context.desired_state != DesiredState::Stopped
                || context.recovery_state != RecoveryState::Lost
                || receipt.incarnation_id != *context.prior_handle.incarnation_id()
                || receipt.destination_store_id != context.provider_store_id
                || receipt.root_session_id
                    != context
                        .native_import_root_session_id
                        .as_deref()
                        .or(context.native_session_id.as_deref())
                        .unwrap_or_default()
                || receipt.provider_uid
                    != context
                        .terminal
                        .as_ref()
                        .ok_or_else(|| RegistryError::InvalidState("repair target has no terminal spec".into()))?
                        .run_as_uid
                || receipt.provider_gid
                    != context
                        .terminal
                        .as_ref()
                        .ok_or_else(|| RegistryError::InvalidState("repair target has no terminal spec".into()))?
                        .run_as_gid
                || !is_lower_hex_sha256(&receipt.structural_sha256)
                || !is_lower_hex_sha256(&receipt.reader_environment_sha256)
                || !is_lower_hex_sha256(&receipt.bundle_sha256)
                || receipt.transfer_id.is_empty()
                || !receipt.adoption_baseline_matches_receipt()
            {
                return Err(RegistryError::NativeIdentityConflict);
            }
            let (scope_json,choices_json):(String,String)=tx.query_row("SELECT scope_json,owner_choices_json FROM stopped_repair_operations WHERE operation_id=?1",params![operation_id.as_str()],|row|Ok((row.get(0)?,row.get(1)?)))?;
            let scope:freshell_runtime_protocol::RepairBatchScope=serde_json::from_str(&scope_json)?;
            let choices:Vec<freshell_runtime_protocol::CanonicalOwnerChoice>=serde_json::from_str(&choices_json)?;
            crate::stopped_repair_cas::validate_scope_members(&tx,&scope)?;
            crate::stopped_repair_cas::validate_scope_owner_evidence(&tx,&scope,&choices)?;
            let root=scope.roots.iter().find(|root|root.root_session_id==receipt.root_session_id).ok_or(RegistryError::RequestConflict)?;
            if receipt.source_store_id!=scope.source_store_id || receipt.source_generation!=root.graph_digest
                || root.canonical_soul_id.as_ref().or_else(||choices.iter().find(|choice|choice.root_session_id==root.root_session_id).map(|choice|&choice.soul_id))!=Some(&receipt.canonical_soul_id) {return Err(RegistryError::RequestConflict);}
            let targets_json: String = tx.query_row(
                "SELECT targets_json FROM stopped_repair_operations WHERE operation_id=?1",
                params![operation_id.as_str()],
                |row| row.get(0),
            )?;
            let targets: Vec<LostSoulRepairTarget> = serde_json::from_str(&targets_json)?;
            if !targets.iter().any(|candidate| {
                candidate.soul_id == target.soul_id
                    && candidate.incident_id == target.incident_id
                    && candidate.expected_intent_revision == target.expected_intent_revision
            }) {
                return Err(RegistryError::RequestConflict);
            }
            validate_stopped_repair_target_in_tx(&tx, &target)?;

            let current: StoppedRepairTargetReceiptFenceRow = tx.query_row(
                "SELECT s.provider,s.provider_store_id,s.desired_state,s.loss_incident_id,s.identity_revision,s.evidence_revision,s.native_import_revision,s.native_import_state,s.native_import_source_store_id,s.native_import_root_session_id,s.native_import_source_generation,s.native_import_schema_fingerprint,s.native_import_migration_fingerprint,s.native_import_authority,i.execution_generation,i.launch_state,i.cleanup_state \
                 FROM souls s JOIN incarnations i ON i.soul_id=s.soul_id AND i.incarnation_id=?2 WHERE s.soul_id=?1",
                params![target.soul_id.as_str(), receipt.incarnation_id.as_str()],
                |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?,row.get(8)?,row.get(9)?,row.get(10)?,row.get(11)?,row.get(12)?,row.get(13)?,row.get(14)?,row.get(15)?,row.get(16)?)),
            )?;
            if current.0 != "opencode"
                || current.1 != receipt.destination_store_id
                || current.2 != "stopped"
                || current.3.as_deref() != Some(target.incident_id.as_str())
                || current.4 != receipt.captured_identity_revision
                || current.5 != receipt.captured_evidence_revision
                || current.6 != receipt.captured_native_import_revision
                || current.7 != receipt.captured_native_import_state
                || current.8 != context.native_import_source_store_id
                || current.9 != context.native_import_root_session_id
                || current.10 != context.native_import_source_generation
                || current.11 != context.native_import_schema_fingerprint
                || current.12 != context.native_import_migration_fingerprint
                || current.13 != receipt.captured_native_import_authority
                || current.14 != receipt.execution_generation
                || current.15 != "stopped"
                || current.16 != "verified_empty"
                || receipt.captured_identity_revision != context.identity_revision
                || receipt.captured_evidence_revision != context.evidence_revision
                || receipt.captured_native_import_revision != context.native_import_revision
                || receipt.captured_native_import_state != context.native_import_state.as_str()
                || receipt.captured_native_import_authority != context.native_import_authority
            {
                return Err(RegistryError::NativeIdentityConflict);
            }

            let import_summary = serde_json::to_string(&receipt)?;
            let readable_summary = serde_json::to_string(&serde_json::json!({
                "providerUid": receipt.provider_uid,
                "providerGid": receipt.provider_gid,
                "destinationStoreId": receipt.destination_store_id,
                "bundleSha256": receipt.bundle_sha256,
                "readerEnvironmentSha256": receipt.reader_environment_sha256,
                "structuralSha256": receipt.structural_sha256,
                "rowCount": receipt.row_count,
                "assetCount": receipt.asset_count,
            }))?;
            let existing: Option<(String, String)> = tx.query_row(
                "SELECT import_receipt_json,readable_receipt_json FROM stopped_repair_root_receipts WHERE operation_id=?1 AND root_session_id=?2",
                params![operation_id.as_str(), receipt.root_session_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ).optional()?;
            if let Some((old_import, old_readable)) = existing {
                if old_import != import_summary || old_readable != readable_summary {
                    return Err(RegistryError::RequestConflict);
                }
                tx.commit()?;
                return Ok(());
            }
            tx.execute(
                "INSERT INTO stopped_repair_root_receipts (operation_id,root_session_id,canonical_soul_id,transfer_id,source_store_id,source_generation,identity_revision,intent_revision,native_import_revision,active_incarnation_id,execution_generation,import_receipt_json,readable_receipt_json,status,updated_at) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,'verified',?14)",
                params![
                    operation_id.as_str(),
                    receipt.root_session_id,
                    receipt.canonical_soul_id.as_str(),
                    receipt.transfer_id,
                    receipt.source_store_id,
                    receipt.source_generation,
                    receipt.captured_identity_revision,
                    receipt.captured_intent_revision,
                    receipt.captured_native_import_revision,
                    receipt.incarnation_id.as_str(),
                    receipt.execution_generation,
                    import_summary,
                    readable_summary,
                    now_millis(),
                ],
            )?;
            tx.commit()?;
            Ok(())
        })
        .await
    }

    pub(crate) async fn stopped_repair_root_receipts(
        &self,
        operation_id: RequestId,
    ) -> Result<Vec<StoppedRepairRootReceipt>, RegistryError> {
        self.run_blocking(move |conn| {
            let mut statement = conn.prepare(
                "SELECT import_receipt_json FROM stopped_repair_root_receipts WHERE operation_id=?1 ORDER BY root_session_id",
            )?;
            let rows = statement.query_map(params![operation_id.as_str()], |row| {
                row.get::<_, String>(0)
            })?;
            rows.map(|row| {
                serde_json::from_str(&row?).map_err(RegistryError::from)
            })
            .collect()
        })
        .await
    }

    pub async fn recovery_write_fence(
        &self,
        soul_id: SoulId,
    ) -> Result<RecoveryWriteFence, RegistryError> {
        self.run_blocking(move |conn| load_recovery_write_fence(&conn, &soul_id))
            .await
    }

    /// Refresh a known exact origin using trusted host inventory. The caller
    /// captures context before discovery/I/O; completion never adopts a newer
    /// identity, import generation, or user intent.
    pub(crate) async fn refresh_native_import_inventory(
        &self,
        context: &RecoveryContext,
        inventory: Result<
            freshell_sessions::opencode_transfer::HostOpenCodeInventory,
            freshell_sessions::opencode_transfer::TransferError,
        >,
    ) -> Result<RecoveryContext, RegistryError> {
        if context.provider != "opencode"
            || matches!(
                context.native_import_state,
                NativeImportState::NotApplicable
                    | NativeImportState::LegacyUnknown
                    | NativeImportState::Pending
                    | NativeImportState::Partial
            )
        {
            return Ok(context.clone());
        }
        let (Some(store), Some(root), Some(generation), Some(schema), Some(migration)) = (
            context.native_import_source_store_id.clone(),
            context.native_import_root_session_id.clone(),
            context.native_import_source_generation.clone(),
            context.native_import_schema_fingerprint.clone(),
            context.native_import_migration_fingerprint.clone(),
        ) else {
            return Ok(context.clone());
        };
        let capture = context.clone();
        let observation = tokio::task::spawn_blocking(move || {
            let inspected =
                inventory.and_then(|inventory| inventory.inspect_exact_origin(&store, &root));
            let mut observation = NativeImportObservation {
                state: NativeImportState::Unresolved,
                source_store_id: Some(store.clone()),
                root_session_id: Some(root.clone()),
                source_generation: Some(generation.clone()),
                schema_fingerprint: Some(schema.clone()),
                migration_fingerprint: Some(migration.clone()),
                complete_source_inventory: None,
            };
            match inspected {
                Ok(found) if found.available() => observation.state = NativeImportState::Available,
                Ok(found)
                    if found.source_store_id() == store
                        && found.root_session_id() == root
                        && found.schema_fingerprint() == schema
                        && found.migration_fingerprint() == migration =>
                {
                    observation.state = NativeImportState::Absent;
                    observation.complete_source_inventory = Some(CompleteNativeImportInventory {
                        source_store_id: store,
                        root_session_id: root,
                        source_generation: generation,
                        schema_fingerprint: schema,
                        migration_fingerprint: migration,
                        inventory_fingerprint: found.inventory_fingerprint().into(),
                    });
                }
                _ => {}
            }
            observation
        })
        .await
        .map_err(|error| {
            RegistryError::Integrity(format!("native source inventory worker failed: {error}"))
        })?;
        let state = observation.state;
        let complete = observation.complete_source_inventory.is_some();
        let authority = observation
            .complete_source_inventory
            .as_ref()
            .map(CompleteNativeImportInventory::authority)
            .unwrap_or_else(|| "provider_import_probe".into());
        let revision = self
            .record_native_import_observation(
                capture.soul_id.clone(),
                capture.write_fence(),
                observation,
            )
            .await?;
        let mut successor = capture;
        if revision != successor.native_import_revision {
            successor.evidence_revision += 1;
        }
        successor.native_import_revision = revision;
        successor.native_import_state = state;
        successor.native_import_complete_inventory = complete;
        successor.native_import_authority = authority;
        Ok(successor)
    }

    pub async fn record_native_import_observation(
        &self,
        soul_id: SoulId,
        fence: RecoveryWriteFence,
        observation: NativeImportObservation,
    ) -> Result<u64, RegistryError> {
        let source_store_id = observation.source_store_id.clone();
        let root_session_id = observation.root_session_id.clone();
        let mut source_generation = observation.source_generation.clone();
        let mut schema_fingerprint = observation.schema_fingerprint.clone();
        let mut migration_fingerprint = observation.migration_fingerprint.clone();
        let complete_source_inventory = observation.complete_source_inventory.clone();
        let complete_inventory = complete_source_inventory.is_some();
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            validate_recovery_context_fence(&tx, &soul_id, &fence)?;
            let (
                provider,
                existing_state,
                existing_store,
                existing_root,
                existing_generation,
                existing_schema,
                existing_migration,
                _existing_complete,
                _existing_authority,
                current_revision,
            ): NativeImportObservationRow = tx.query_row(
                "SELECT provider,native_import_state,native_import_source_store_id,native_import_root_session_id,native_import_source_generation,native_import_schema_fingerprint,native_import_migration_fingerprint,native_import_complete_inventory,native_import_authority,native_import_revision FROM souls WHERE soul_id=?1",
                params![soul_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?)),
            )?;
            let authority = match observation.state {
                NativeImportState::NotApplicable => {
                    if source_store_id.is_some()
                        || root_session_id.is_some()
                        || source_generation.is_some()
                        || schema_fingerprint.is_some()
                        || migration_fingerprint.is_some()
                        || complete_source_inventory.is_some()
                    {
                        return Err(RegistryError::InvalidState(
                            "not-applicable native import observation must not name a source".into(),
                        ));
                    }
                    "no_import_configured".to_string()
                }
                NativeImportState::Absent => {
                    let exact_proof = complete_source_inventory.as_ref().is_some_and(|proof| {
                        Some(proof.source_store_id.as_str()) == source_store_id.as_deref()
                            && Some(proof.root_session_id.as_str()) == root_session_id.as_deref()
                            && Some(proof.source_generation.as_str()) == source_generation.as_deref()
                            && Some(proof.schema_fingerprint.as_str()) == schema_fingerprint.as_deref()
                            && Some(proof.migration_fingerprint.as_str())
                                == migration_fingerprint.as_deref()
                            && is_lower_hex_sha256(&proof.inventory_fingerprint)
                    });
                    if !exact_proof
                        || source_store_id.as_deref().is_none_or(str::is_empty)
                        || root_session_id.as_deref().is_none_or(str::is_empty)
                        || source_generation.as_deref().is_none_or(str::is_empty)
                        || schema_fingerprint.as_deref().is_none_or(str::is_empty)
                        || migration_fingerprint.as_deref().is_none_or(str::is_empty)
                    {
                        return Err(RegistryError::InvalidState(
                            "absent native import requires a complete inventory for an exact source generation".into(),
                        ));
                    }
                    complete_source_inventory.as_ref().expect("validated complete inventory").authority()
                }
                NativeImportState::LegacyUnknown => {
                    return Err(RegistryError::InvalidState(
                        "legacy unknown native import state can only be resolved by an explicit repair".into(),
                    ));
                }
                state => {
                    if complete_source_inventory.is_some()
                        || source_store_id.as_deref().is_none_or(str::is_empty)
                        || root_session_id.as_deref().is_none_or(str::is_empty)
                    {
                        return Err(RegistryError::InvalidState(
                            "native import observation requires an exact source locator and cannot claim absence".into(),
                        ));
                    }
                    if state == NativeImportState::Completed
                        && source_generation.as_deref().is_none_or(str::is_empty)
                    {
                        return Err(RegistryError::InvalidState(
                            "completed native import requires an exact source generation".into(),
                        ));
                    }
                    "provider_import_probe".to_string()
                }
            };
            if observation.state == NativeImportState::NotApplicable
                && (existing_state != NativeImportState::NotApplicable.as_str()
                    || existing_store.is_some()
                    || existing_root.is_some())
            {
                return Err(RegistryError::NativeIdentityConflict);
            }
            if observation.state != NativeImportState::NotApplicable {
                if provider != "opencode" {
                    return Err(RegistryError::InvalidState(
                        "native import observations are only valid for OpenCode".into(),
                    ));
                }
                if existing_state != NativeImportState::NotApplicable.as_str()
                    && (existing_store != source_store_id || existing_root != root_session_id)
                {
                    return Err(RegistryError::NativeIdentityConflict);
                }
                if source_generation.is_none() {
                    source_generation = existing_generation.clone();
                }
                if schema_fingerprint.is_none() {
                    schema_fingerprint = existing_schema.clone();
                }
                if migration_fingerprint.is_none() {
                    migration_fingerprint = existing_migration.clone();
                }
                claim_native_origin_in_tx(
                    &tx,
                    "opencode",
                    source_store_id.as_deref().expect("validated source store"),
                    root_session_id.as_deref().expect("validated source root"),
                    &soul_id,
                    source_generation.as_deref(),
                )?;
            }
            // Every completed census advances the fence, even if its verdict
            // is unchanged; otherwise an older in-flight negative can still win.
            let next_revision = current_revision
                .checked_add(1)
                .ok_or_else(|| RegistryError::Integrity("native import revision overflow".into()))?;
            let changed = tx.execute(
                "UPDATE souls SET native_import_state=?1,native_import_source_store_id=?2,native_import_root_session_id=?3,native_import_source_generation=?4,native_import_schema_fingerprint=?5,native_import_migration_fingerprint=?6,native_import_complete_inventory=?7,native_import_authority=?8,native_import_revision=?9,evidence_revision=evidence_revision+1,updated_at=?10 WHERE soul_id=?11 AND native_import_revision=?12 AND identity_revision=?13 AND evidence_revision=?14 AND intent_revision=?15",
                params![observation.state.as_str(), source_store_id, root_session_id, source_generation, schema_fingerprint, migration_fingerprint, complete_inventory, authority, next_revision, now_millis(), soul_id.as_str(), fence.native_import_revision, fence.identity_revision, fence.evidence_revision, fence.intent_revision],
            )?;
            if changed != 1 {
                return Err(RegistryError::NativeIdentityConflict);
            }
            tx.commit()?;
            Ok(next_revision)
        })
        .await
    }

    /// Retire a recovery replacement that never acquired a protected Docker
    /// identity. A crash after `create_stopped` but before the container-id
    /// commit may leave an unregistered stopped Docker object; the supervisor
    /// must not infer authority over it. The protected PREPARED row can be
    /// retired because no execution grant could have existed, allowing a new
    /// exact-owned replacement attempt while preserving the forensic row.
    pub(crate) async fn retire_unowned_prepared_replacement(
        &self,
        soul_id: SoulId,
    ) -> Result<Option<RetiredPreparedReplacement>, RegistryError> {
        let now = self.recovery_now_ms();
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let candidate: Option<(String, Option<String>)> = tx
                .query_row(
                    "SELECT incarnation_id,recovery_attempt_id FROM incarnations                      WHERE soul_id=?1 AND launch_state='prepared'                        AND prior_incarnation_id IS NOT NULL                        AND docker_daemon_id IS NULL AND container_id IS NULL                      ORDER BY created_at DESC LIMIT 1",
                    params![soul_id.as_str()],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let Some((incarnation_raw, attempt_raw)) = candidate else {
                tx.commit()?;
                return Ok(None);
            };
            let incarnation_id = IncarnationId::parse(incarnation_raw)
                .map_err(|_| RegistryError::Integrity("invalid incarnation id".into()))?;
            let changed = tx.execute(
                "UPDATE incarnations SET launch_state='failed',cleanup_state='termination_unconfirmed',updated_at=?1                  WHERE incarnation_id=?2 AND launch_state='prepared'                    AND docker_daemon_id IS NULL AND container_id IS NULL",
                params![now, incarnation_id.as_str()],
            )?;
            if changed != 1 {
                return Err(RegistryError::InvalidState(
                    "interrupted PREPARED replacement changed during retirement".into(),
                ));
            }
            // No provider could have executed without a committed container
            // identity and execution grant, so these provisional claims may be
            // released. The failed incarnation row itself remains forensics.
            tx.execute(
                "DELETE FROM writer_claims WHERE incarnation_id=?1",
                params![incarnation_id.as_str()],
            )?;
            tx.execute(
                "DELETE FROM admission_reservations WHERE incarnation_id=?1",
                params![incarnation_id.as_str()],
            )?;
            let mut journal = None;
            if let Some(raw) = attempt_raw {
                let attempt = RecoveryAttemptId::parse(raw)
                    .map_err(|_| RegistryError::Integrity("invalid interrupted attempt".into()))?;
                let revision: u64 = tx.query_row(
                    "SELECT intent_revision FROM recovery_attempts WHERE attempt_id=?1",
                    [attempt.as_str()], |row| row.get(0),
                )?;
                // An unfinished pre-migration journal already spent one try.
                // Upgrade only that current reservation before finishing it;
                // an older intent cannot acquire or overwrite a retry budget.
                tx.execute(
                    "INSERT OR IGNORE INTO recovery_retries (soul_id,intent_revision,attempt_count,reserved_attempt_id,last_reason)
                     SELECT a.soul_id,a.intent_revision,1,a.attempt_id,'reserved'
                     FROM recovery_attempts a JOIN souls s ON s.soul_id=a.soul_id
                     WHERE a.attempt_id=?1 AND a.finished_at IS NULL
                       AND s.intent_revision=a.intent_revision AND s.recovery_attempt_id=a.attempt_id
                       AND s.desired_state='running' AND s.recovery_state='recovering'",
                    [attempt.as_str()],
                )?;
                tx.execute(
                    "UPDATE recovery_attempts SET verdict='interrupted_before_ownership_commit',evidence_ref='unregistered_stopped_object_quarantined',finished_at=?1                      WHERE attempt_id=?2 AND finished_at IS NULL",
                    params![now, attempt.as_str()],
                )?;
                tx.execute(
                    "UPDATE souls SET recovery_state='blocked',recovery_reason='INTERRUPTED_BEFORE_OWNERSHIP_COMMIT',recovery_attempt_id=NULL,updated_at=?1
                     WHERE soul_id=?2 AND recovery_state='recovering' AND recovery_attempt_id=?3 AND intent_revision=?4",
                    params![now, soul_id.as_str(), attempt.as_str(), revision],
                )?;
                // Only the protected try is retryable. Its spent count and
                // backoff survive; the abandoned object acquires no authority.
                settle_recovery_retry_tx(&tx, &soul_id, revision, &attempt, now,
                    RetrySettlement::Blocked { retryable: true, reason: "ownership_not_committed" })?;
                journal = Some((attempt, revision));
            }
            tx.commit()?;
            Ok(Some(RetiredPreparedReplacement { incarnation_id, journal }))
        })
        .await
    }

    #[cfg(test)]
    pub async fn begin_recovery(
        &self,
        soul_id: SoulId,
        trigger: RecoveryTrigger,
        path: RecoveryPath,
    ) -> Result<RecoveryStart, RegistryError> {
        let fence = self.recovery_context(soul_id.clone()).await?.write_fence();
        self.begin_recovery_fenced(soul_id, trigger, path, fence)
            .await
    }

    /// Reserve before probing or touching the backend. A reservation and its
    /// journal entry share one immediate transaction and consume one attempt.
    pub(crate) async fn reserve_due_recovery_retry(
        &self,
        soul_id: SoulId,
        intent_revision: u64,
        now_ms: i64,
    ) -> Result<Option<RecoveryRetry>, RegistryError> {
        let installation = self.installation_id().clone();
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let context = load_recovery_context(&tx, installation, &soul_id)?;
            if context.intent_revision != intent_revision
                || context.desired_state != DesiredState::Running
                || context.recovery_state == RecoveryState::Lost
                || context.recovery_attempt_id.is_some()
            {
                return Ok(None);
            }
            let existing = load_recovery_retry(&tx, &soul_id, intent_revision)?;
            if existing.as_ref().is_some_and(|retry| !retry.is_due(now_ms)) {
                return Ok(None);
            }
            let attempt_count = existing.map_or(1, |retry| retry.attempt_count + 1);
            let attempt_id = RecoveryAttemptId::new();
            tx.execute(
                "INSERT INTO recovery_attempts (attempt_id,soul_id,prior_incarnation_id,intent_revision,path,verdict,started_at) VALUES (?1,?2,?3,?4,'reattach','started',?5)",
                params![attempt_id.as_str(), soul_id.as_str(), context.prior_handle.incarnation_id().as_str(), intent_revision, now_ms],
            )?;
            tx.execute(
                "INSERT INTO recovery_retries (soul_id,intent_revision,attempt_count,next_due_at_ms,reserved_attempt_id,last_reason) VALUES (?1,?2,?3,NULL,?4,'reserved') ON CONFLICT(soul_id,intent_revision) DO UPDATE SET attempt_count=excluded.attempt_count,next_due_at_ms=NULL,reserved_attempt_id=excluded.reserved_attempt_id,last_reason='reserved'",
                params![soul_id.as_str(), intent_revision, attempt_count, attempt_id.as_str()],
            )?;
            tx.execute(
                "UPDATE souls SET recovery_state='recovering',recovery_attempt_id=?1,updated_at=?2 WHERE soul_id=?3 AND intent_revision=?4 AND desired_state='running'",
                params![attempt_id.as_str(), now_ms, soul_id.as_str(), intent_revision],
            )?;
            let retry = load_recovery_retry(&tx, &soul_id, intent_revision)?;
            tx.commit()?;
            Ok(retry)
        }).await
    }

    /// Called only under the supervisor's lifecycle lock. Reopening or a
    /// cancelled task resumes the same unfinished journal, never a new create.
    pub(crate) async fn reserved_recovery_retry(
        &self,
        soul_id: SoulId,
        intent_revision: u64,
    ) -> Result<Option<RecoveryRetry>, RegistryError> {
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let active: Option<String> = tx.query_row(
                "SELECT s.recovery_attempt_id FROM souls s JOIN recovery_attempts a ON a.attempt_id=s.recovery_attempt_id WHERE s.soul_id=?1 AND s.intent_revision=?2 AND s.desired_state='running' AND s.recovery_state!='lost' AND a.intent_revision=s.intent_revision AND a.finished_at IS NULL",
                params![soul_id.as_str(), intent_revision], |row| row.get(0),
            ).optional()?;
            let Some(attempt) = active else {
                return Ok(None);
            };
            // Upgrade an interrupted pre-migration journal without granting a
            // free initial attempt or changing its owned incarnation.
            tx.execute(
                "INSERT OR IGNORE INTO recovery_retries (soul_id,intent_revision,attempt_count,reserved_attempt_id,last_reason) VALUES (?1,?2,1,?3,'reserved')",
                params![soul_id.as_str(), intent_revision, attempt],
            )?;
            let retry = load_recovery_retry(&tx, &soul_id, intent_revision)?
                .filter(|retry| retry.reserved_attempt_id.as_ref().is_some_and(|id| id.as_str() == attempt));
            tx.commit()?;
            Ok(retry)
        }).await
    }

    pub(crate) async fn pending_owned_replacement(
        &self,
        soul_id: SoulId,
    ) -> Result<Option<(PreparedLaunch, RecoveryContext)>, RegistryError> {
        let installation = self.installation_id().clone();
        self.run_blocking(move |conn| {
            let context = load_recovery_context(&conn, installation, &soul_id)?;
            let state: Option<String> = conn.query_row(
                "SELECT i.launch_state FROM incarnations i JOIN recovery_attempts a ON a.attempt_id=i.recovery_attempt_id WHERE i.incarnation_id=?1 AND i.recovery_attempt_id=?2 AND i.launch_state IN ('created','starting') AND i.prior_incarnation_id=a.prior_incarnation_id AND a.verdict='replacement_prepared' AND a.finished_at IS NULL AND a.intent_revision=?3",
                params![context.prior_handle.incarnation_id().as_str(), context.recovery_attempt_id.as_ref().map(RecoveryAttemptId::as_str), context.intent_revision],
                |row| row.get(0),
            ).optional()?;
            state.map(|state| Ok((
                PreparedLaunch {
                    soul_id,
                    incarnation_id: context.prior_handle.incarnation_id().clone(),
                    launch_nonce: context.prior_handle.launch_nonce().clone(),
                    state: parse_launch_state(&state)?,
                    intent_revision: context.intent_revision,
                    existing_request: true,
                },
                context,
            ))).transpose()
        }).await
    }

    pub(crate) async fn recovery_retry(
        &self,
        soul_id: SoulId,
        intent_revision: u64,
    ) -> Result<Option<RecoveryRetry>, RegistryError> {
        self.run_blocking(move |conn| load_recovery_retry(&conn, &soul_id, intent_revision))
            .await
    }

    pub(crate) async fn due_recovery_retries(
        &self,
        now_ms: i64,
    ) -> Result<Vec<(SoulId, u64)>, RegistryError> {
        self.run_blocking(move |conn| {
            let mut statement = conn.prepare("SELECT r.soul_id,r.intent_revision FROM recovery_retries r JOIN souls s ON s.soul_id=r.soul_id AND s.intent_revision=r.intent_revision WHERE s.desired_state='running' AND s.recovery_state!='lost' AND (r.reserved_attempt_id IS NOT NULL OR (r.attempt_count<3 AND r.next_due_at_ms<=?1))")?;
            let rows = statement.query_map([now_ms], |row| Ok((row.get::<_,String>(0)?,row.get::<_,u64>(1)?)))?.collect::<Result<Vec<_>,_>>()?;
            rows.into_iter().map(|(id, revision)| Ok((SoulId::parse(id).map_err(|_|RegistryError::Integrity("invalid retry soul".into()))?,revision))).collect()
        }).await
    }

    pub(crate) async fn rearm_recovery_retry(
        &self,
        soul_id: SoulId,
        expected_revision: u64,
    ) -> Result<u64, RegistryError> {
        let now = self.recovery_now_ms();
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let next = expected_revision.checked_add(1).ok_or_else(|| RegistryError::Integrity("intent revision overflow".into()))?;
            let changed = tx.execute(
                "UPDATE souls SET intent_revision=?1,recovery_attempt_id=NULL,recovery_reason=NULL,updated_at=?2 WHERE soul_id=?3 AND intent_revision=?4 AND desired_state='running' AND recovery_state!='lost'",
                params![next,now,soul_id.as_str(),expected_revision],
            )?;
            if changed != 1 {
                return Err(RegistryError::RecoveryBlocked { soul_id, reason: "STOP_INTENT_OR_STALE_ATTEMPT".into() });
            }
            // Rearm the exhausted success window with the deliberate intent,
            // before a transient probe can defer replacement until a later
            // automatic attempt (including after a supervisor restart).
            rearm_exhausted_success_window(&tx, &soul_id, now_millis())?;
            // Writer ownership follows the explicit action without changing
            // the provider root or any identity/evidence revision.
            tx.execute("UPDATE writer_claims SET intent_revision=?1 WHERE soul_id=?2", params![next,soul_id.as_str()])?;
            tx.execute("UPDATE view_intents SET soul_intent_revision=?1 WHERE soul_id=?2", params![next,soul_id.as_str()])?;
            tx.commit()?;
            Ok(next)
        }).await
    }

    pub async fn settle_recovery_retry(
        &self,
        soul_id: SoulId,
        intent_revision: u64,
        attempt_id: RecoveryAttemptId,
        retryable: bool,
        recovered: bool,
        now_ms: i64,
    ) -> Result<(), RegistryError> {
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            settle_recovery_retry_tx(
                &tx,
                &soul_id,
                intent_revision,
                &attempt_id,
                now_ms,
                if recovered {
                    RetrySettlement::Recovered
                } else {
                    RetrySettlement::Blocked {
                        retryable,
                        reason: "interrupted_attempt",
                    }
                },
            )?;
            tx.commit()?;
            Ok(())
        })
        .await
    }

    pub async fn begin_recovery_fenced(
        &self,
        soul_id: SoulId,
        trigger: RecoveryTrigger,
        path: RecoveryPath,
        fence: RecoveryWriteFence,
    ) -> Result<RecoveryStart, RegistryError> {
        let installation = self.installation_id().clone();
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            validate_recovery_revision_fence(&tx, &soul_id, &fence)?;
            let context = load_recovery_context(&tx, installation, &soul_id)?;
            if context.write_fence() != fence {
                return Err(RegistryError::InvalidState("recovery probe is stale".into()));
            }
            if context.desired_state == DesiredState::Stopped {
                return Err(RegistryError::RecoveryBlocked {
                    soul_id,
                    reason: "STOP_INTENT".into(),
                });
            }
            if path == RecoveryPath::PristineSeed && !context.permits_pristine_seed() {
                return Err(RegistryError::RecoveryBlocked {
                    soul_id,
                    reason: "PRISTINE_SEED_NO_LONGER_SAFE".into(),
                });
            }
            let reserved = load_recovery_retry(&tx, &soul_id, context.intent_revision)?
                .and_then(|retry| retry.reserved_attempt_id)
                .filter(|attempt| context.recovery_attempt_id.as_ref() == Some(attempt));
            if context.recovery_state == RecoveryState::Recovering && reserved.is_none() {
                return Err(RegistryError::RecoveryInProgress(soul_id));
            }
            if let Some(attempt) = reserved.as_ref() {
                let started: bool = tx.query_row("SELECT verdict='started' AND finished_at IS NULL FROM recovery_attempts WHERE attempt_id=?1", [attempt.as_str()], |r| r.get(0))?;
                if !started {
                    return Err(RegistryError::RecoveryInProgress(soul_id));
                }
            }
            let now = now_millis();
            let budget_available = freshell_agent_runtime::successful_recovery_budget_available(
                context.recovery_window_started_at,
                context.successful_recoveries_in_window,
                now,
            );
            if !budget_available && trigger != RecoveryTrigger::ManualRetry {
                let reason = "BLOCKED_RETRY_BUDGET";
                tx.execute(
                    "UPDATE souls SET recovery_state='blocked',recovery_reason=?1,updated_at=?2 WHERE soul_id=?3",
                    params![reason, now, context.soul_id.as_str()],
                )?;
                tx.commit()?;
                return Err(RegistryError::RecoveryBlocked {
                    soul_id: context.soul_id,
                    reason: reason.into(),
                });
            }
            if !budget_available && trigger == RecoveryTrigger::ManualRetry {
                // A deliberate user retry is the explicit rearm operation. It
                // clears the persisted flap window but keeps identity/history
                // intact and still runs through the same fenced transaction.
                rearm_exhausted_success_window(&tx, &context.soul_id, now)?;
            }
            let attempt_id = reserved.clone().unwrap_or_default();
            let trigger_name = recovery_trigger_name(trigger);
            tx.execute(
                "UPDATE souls SET recovery_state='recovering',recovery_reason=?1,recovery_attempt_id=?2,updated_at=?3 WHERE soul_id=?4 AND desired_state='running' AND intent_revision=?5",
                params![trigger_name, attempt_id.as_str(), now, context.soul_id.as_str(), context.intent_revision],
            )?;
            tx.execute(
                "UPDATE incarnations SET launch_state='stopping',cleanup_state='requested',recovery_attempt_id=?1,updated_at=?2 WHERE incarnation_id=?3 AND launch_state IN ('created','starting','running')",
                params![attempt_id.as_str(), now, context.prior_handle.incarnation_id().as_str()],
            )?;
            tx.execute(
                "UPDATE input_commands SET state='ambiguous',updated_at=?1 WHERE soul_id=?2 AND state='dispatching'",
                params![now, context.soul_id.as_str()],
            )?;
            if reserved.is_some() {
                tx.execute("UPDATE recovery_attempts SET path=?1 WHERE attempt_id=?2 AND verdict='started' AND finished_at IS NULL", params![recovery_path_name(path),attempt_id.as_str()])?;
            } else {
                tx.execute(
                    "INSERT INTO recovery_attempts (attempt_id,soul_id,prior_incarnation_id,intent_revision,path,verdict,evidence_ref,started_at,finished_at) VALUES (?1,?2,?3,?4,?5,'started',NULL,?6,NULL)",
                    params![attempt_id.as_str(), context.soul_id.as_str(), context.prior_handle.incarnation_id().as_str(), context.intent_revision, recovery_path_name(path), now],
                )?;
            }
            tx.commit()?;
            Ok(RecoveryStart { attempt_id, context })
        })
        .await
    }

    pub(crate) async fn validate_auth_lookup_attempt(
        &self,
        start: RecoveryStart,
    ) -> Result<bool, RegistryError> {
        self.run_blocking(move |conn| {
            let current:bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM souls WHERE soul_id=?1 AND desired_state='running' AND recovery_state='recovering' AND intent_revision=?2 AND recovery_attempt_id=?3)",
                params![start.context.soul_id.as_str(),start.context.intent_revision,start.attempt_id.as_str()],
                |row|row.get(0),
            )?;
            Ok(current)
        }).await
    }

    pub async fn prepare_replacement(
        &self,
        start: RecoveryStart,
        terminal: Option<TerminalLaunchSpec>,
        fresh_agent: Option<FreshAgentLaunchSpec>,
        resume_spec: Option<ResumeSpec>,
        path: RecoveryPath,
    ) -> Result<ReplacementPreparation, RegistryError> {
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let (desired, intent, recovery_attempt): (String, u64, Option<String>) = tx
                .query_row(
                    "SELECT desired_state,intent_revision,recovery_attempt_id FROM souls WHERE soul_id=?1",
                    params![start.context.soul_id.as_str()],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?;
            if desired != "running"
                || intent != start.context.intent_revision
                || recovery_attempt.as_deref() != Some(start.attempt_id.as_str())
            {
                return Err(RegistryError::RecoveryBlocked {
                    soul_id: start.context.soul_id,
                    reason: "STOP_INTENT_OR_STALE_ATTEMPT".into(),
                });
            }
            let replacement_fence = start
                .context
                .write_fence_for_attempt(start.attempt_id.clone());
            if let Err(error) = validate_recovery_revision_fence(
                &tx,
                &start.context.soul_id,
                &replacement_fence,
            ) {
                return match error {
                    RegistryError::InvalidState(_) => Err(RegistryError::RecoveryBlocked {
                        soul_id: start.context.soul_id,
                        reason: "STALE_MATERIALIZATION_OR_IMPORT_EVIDENCE".into(),
                    }),
                    other => Err(other),
                };
            }
            if path == RecoveryPath::PristineSeed {
                let never_dispatched: bool = tx.query_row(
                    "SELECT native_session_id IS NULL AND NOT EXISTS(SELECT 1 FROM input_commands WHERE soul_id=?1 AND state IN ('dispatching','completed','ambiguous')) FROM souls WHERE soul_id=?1",
                    params![start.context.soul_id.as_str()], |row| row.get(0),
                )?;
                if !never_dispatched || !start.context.permits_pristine_seed() {
                    return Err(RegistryError::RecoveryBlocked {
                        soul_id: start.context.soul_id,
                        reason: "PRISTINE_SEED_NO_LONGER_SAFE".into(),
                    });
                }
            }
            let (old_state, old_cleanup): (String, String) = tx.query_row(
                "SELECT launch_state,cleanup_state FROM incarnations WHERE incarnation_id=?1",
                params![start.context.prior_handle.incarnation_id().as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            if old_state != "stopped" || old_cleanup != "verified_empty" {
                return Err(RegistryError::RecoveryBlocked {
                    soul_id: start.context.soul_id,
                    reason: "OLD_RUNTIME_NOT_VERIFIED_EMPTY".into(),
                });
            }
            let active: Option<String> = tx
                .query_row(
                    &format!("SELECT incarnation_id FROM incarnations WHERE soul_id=?1 AND launch_state IN ({ACTIVE_STATES}) LIMIT 1"),
                    params![start.context.soul_id.as_str()],
                    |row| row.get(0),
                )
                .optional()?;
            if active.is_some() {
                return Err(RegistryError::ActiveIncarnation(start.context.soul_id));
            }
            let now = now_millis();
            let incarnation_id = IncarnationId::new();
            let launch_nonce = LaunchNonce::new();
            let limits_json = serde_json::to_string(&start.context.requested_limits)?;
            let terminal_json = terminal.as_ref().map(serde_json::to_string).transpose()?;
            let fresh_agent_json = fresh_agent
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?;
            let terminal_id = terminal.as_ref().map(|value| value.terminal_id.as_str());
            let fixture_kind = start.context.fixture.map(fixture_kind_name);
            tx.execute(
                "INSERT INTO incarnations (incarnation_id,soul_id,launch_nonce,docker_daemon_id,container_id,image_ref,runtime_dir,host_binary_path,immutable_config_digest,launch_state,host_boot_id,execution_generation,grant_id,requested_limits,effective_limits,cleanup_state,fixture_kind,terminal_id,terminal_spec,fresh_agent_spec,prior_incarnation_id,recovery_attempt_id,exit_code,oom_killed,created_at,updated_at) VALUES (?1,?2,?3,NULL,NULL,NULL,NULL,NULL,NULL,'prepared',NULL,0,NULL,?4,NULL,'none',?5,?6,?7,?8,?9,?10,NULL,0,?11,?11)",
                params![incarnation_id.as_str(), start.context.soul_id.as_str(), launch_nonce.as_str(), limits_json, fixture_kind, terminal_id, terminal_json, fresh_agent_json, start.context.prior_handle.incarnation_id().as_str(), start.attempt_id.as_str(), now],
            )?;
            tx.execute(
                "INSERT INTO admission_reservations (incarnation_id,project_key,cpu_milli,memory_bytes,pids_max,created_at) VALUES (?1,?2,?3,?4,?5,?6)",
                params![incarnation_id.as_str(), start.context.project_key, start.context.requested_limits.cpu_milli, start.context.requested_limits.memory_bytes, start.context.requested_limits.pids_max, now],
            )?;
            if let Some(spec) = resume_spec.as_ref() {
                tx.execute(
                    "INSERT INTO writer_claims (provider,provider_store_id,native_session_id,soul_id,incarnation_id,intent_revision) VALUES (?1,?2,?3,?4,?5,?6)",
                    params![spec.provider_session.provider, spec.provider_session.provider_store_id, spec.provider_session.native_session_id, start.context.soul_id.as_str(), incarnation_id.as_str(), start.context.intent_revision],
                )?;
            }
            let attempt_updated = tx.execute(
                "UPDATE recovery_attempts SET path=?1,verdict='replacement_prepared' WHERE attempt_id=?2 AND verdict='started' AND finished_at IS NULL",
                params![recovery_path_name(path), start.attempt_id.as_str()],
            )?;
            if attempt_updated != 1 {
                return Err(RegistryError::RecoveryBlocked {
                    soul_id: start.context.soul_id,
                    reason: "STOP_INTENT_OR_STALE_ATTEMPT".into(),
                });
            }
            tx.commit()?;
            Ok(ReplacementPreparation {
                prepared: PreparedLaunch {
                    soul_id: start.context.soul_id,
                    incarnation_id,
                    launch_nonce,
                    state: LaunchState::Prepared,
                    intent_revision: start.context.intent_revision,
                    existing_request: false,
                },
                fixture: start.context.fixture,
                terminal,
                fresh_agent,
                resume_spec,
                prior_incarnation_id: start.context.prior_handle.incarnation_id().clone(),
                attempt_id: start.attempt_id,
            })
        })
        .await
    }

    pub async fn bind_native_identity_launch(
        &self,
        launch: freshell_runtime_protocol::NativeIdentityLaunch,
    ) -> Result<freshell_runtime_protocol::NativeIdentityLaunch, RegistryError> {
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let (nonce,generation,existing):(String,u64,Option<String>) = tx.query_row(
                "SELECT launch_nonce,execution_generation,native_identity_launch FROM incarnations WHERE incarnation_id=?1 AND launch_state IN ('starting','running')",
                params![launch.incarnation_id.as_str()],|r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
            if launch.launch_nonce != nonce || launch.execution_generation != generation {
                return Err(RegistryError::NativeIdentityConflict);
            }
            let binding = if let Some(existing) = existing {
                let existing:freshell_runtime_protocol::NativeIdentityLaunch = serde_json::from_str(&existing)?;
                if existing.launch_nonce != nonce || existing.execution_generation != generation {
                    return Err(RegistryError::NativeIdentityConflict);
                }
                existing
            } else {
                tx.execute("UPDATE incarnations SET native_identity_launch=?1 WHERE incarnation_id=?2",
                    params![serde_json::to_string(&launch)?,launch.incarnation_id.as_str()])?;
                launch
            };
            tx.commit()?;
            Ok(binding)
        }).await
    }

    pub async fn record_native_identity_observation(
        &self,
        soul_id: SoulId,
        observation: freshell_runtime_protocol::NativeIdentityObservation,
        fence: RecoveryWriteFence,
    ) -> Result<(), RegistryError> {
        let installation = self.installation_id().clone();
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            validate_recovery_write_fence(&tx, &soul_id, &fence)?;
            let context = load_recovery_context(&tx, installation, &soul_id)?;
            if context.desired_state != DesiredState::Running
                || observation.incarnation_id != fence.active_incarnation_id
                || context.native_session_id.as_deref()
                    != Some(observation.native_session_id.as_str())
                || !observation.matches_provider(&context.provider, context.fresh_agent.is_some())
                || !context
                    .native_identity_launch
                    .as_ref()
                    .is_some_and(|launch| observation.matches_launch(launch))
            {
                return Err(RegistryError::NativeIdentityConflict);
            }
            tx.execute(
                "UPDATE incarnations SET native_identity_observation=?1 WHERE incarnation_id=?2",
                params![
                    serde_json::to_string(&observation)?,
                    observation.incarnation_id.as_str()
                ],
            )?;
            tx.commit()?;
            Ok(())
        })
        .await
    }

    pub async fn mark_recovery_live(
        &self,
        soul_id: SoulId,
        incarnation_id: IncarnationId,
        fence: RecoveryWriteFence,
    ) -> Result<(), RegistryError> {
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            validate_recovery_write_fence(&tx, &soul_id, &fence)?;
            if fence.active_incarnation_id != incarnation_id {
                return Err(RegistryError::InvalidState(
                    "recovery reattach incarnation changed before success was committed".into(),
                ));
            }
            let running: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM incarnations i JOIN souls s ON s.soul_id=i.soul_id WHERE i.incarnation_id=?1 AND i.soul_id=?2 AND i.launch_state='running' AND s.desired_state='running')",
                    params![incarnation_id.as_str(), soul_id.as_str()],
                    |row| row.get(0),
                )?;
            if !running {
                return Err(RegistryError::RecoveryBlocked {
                    soul_id,
                    reason: "STOP_INTENT_OR_STALE_INCARNATION".into(),
                });
            }
            validate_live_native_observation(&tx,&soul_id,&incarnation_id)?;
            if let Some(attempt) = fence.recovery_attempt_id.as_ref() {
                let replacement: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM recovery_attempts a JOIN incarnations i ON i.recovery_attempt_id=a.attempt_id WHERE a.attempt_id=?1 AND a.verdict='replacement_prepared' AND a.finished_at IS NULL AND i.incarnation_id=?2 AND i.prior_incarnation_id=a.prior_incarnation_id)", params![attempt.as_str(),incarnation_id.as_str()],|r|r.get(0))?;
                if replacement {
                    charge_successful_recovery(&tx, &soul_id, now_millis())?;
                    tx.execute("UPDATE incarnations SET provider_preparation_pending=1 WHERE incarnation_id=?1", [incarnation_id.as_str()])?;
                    tx.execute("UPDATE recovery_attempts SET evidence_ref=?1 WHERE attempt_id=?2", params![serde_json::to_string(&vec![format!("{ACCEPTED_INCARNATION_REF}{}", incarnation_id.as_str())])?, attempt.as_str()])?;
                }
                tx.execute("UPDATE recovery_attempts SET verdict=?1,finished_at=?2 WHERE attempt_id=?3 AND finished_at IS NULL",params![if replacement {"succeeded"} else {"reattached"},now_millis(),attempt.as_str()])?;
                settle_recovery_retry_tx(&tx, &soul_id, fence.intent_revision, attempt, now_millis(), RetrySettlement::Recovered)?;
            }
            let updated = tx.execute(
                "UPDATE souls SET recovery_state='live',recovery_reason=NULL,recovery_attempt_id=NULL,updated_at=?1 WHERE soul_id=?2 AND desired_state='running' AND intent_revision=?3 AND identity_revision=?4 AND evidence_revision=?5 AND native_import_revision=?6 AND recovery_attempt_id IS ?7",
                params![now_millis(), soul_id.as_str(), fence.intent_revision, fence.identity_revision, fence.evidence_revision, fence.native_import_revision, fence.recovery_attempt_id.as_ref().map(RecoveryAttemptId::as_str)],
            )?;
            if updated != 1 {
                return Err(RegistryError::InvalidState(
                    "recovery reattach state changed before success was committed".into(),
                ));
            }
            tx.commit()?;
            Ok(())
        })
        .await
    }

    pub async fn mark_recovery_success(
        &self,
        soul_id: SoulId,
        incarnation_id: IncarnationId,
        attempt_id: RecoveryAttemptId,
        fence: RecoveryWriteFence,
    ) -> Result<(), RegistryError> {
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            validate_recovery_write_fence(&tx, &soul_id, &fence)?;
            if fence.active_incarnation_id != incarnation_id
                || fence.recovery_attempt_id.as_ref() != Some(&attempt_id)
            {
                return Err(RegistryError::RecoveryBlocked {
                    soul_id,
                    reason: "STOP_INTENT_OR_STALE_ATTEMPT".into(),
                });
            }
            let now = now_millis();
            let (desired, current_attempt): (String, Option<String>) = tx.query_row(
                "SELECT desired_state,recovery_attempt_id FROM souls WHERE soul_id=?1",
                params![soul_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            if desired != "running" || current_attempt.as_deref() != Some(attempt_id.as_str()) {
                return Err(RegistryError::RecoveryBlocked {
                    soul_id,
                    reason: "STOP_INTENT_OR_STALE_ATTEMPT".into(),
                });
            }
            let (running, incarnation_attempt): (bool, Option<String>) = tx.query_row(
                "SELECT launch_state='running',recovery_attempt_id FROM incarnations WHERE incarnation_id=?1 AND soul_id=?2",
                params![incarnation_id.as_str(), soul_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            if !running || incarnation_attempt.as_deref() != Some(attempt_id.as_str()) {
                return Err(RegistryError::InvalidState(
                    "replacement is not RUNNING under the current recovery attempt".into(),
                ));
            }
            validate_live_native_observation(&tx,&soul_id,&incarnation_id)?;
            let updated = tx.execute(
                "UPDATE souls SET recovery_state='live',recovery_reason=NULL,recovery_attempt_id=NULL,updated_at=?1 WHERE soul_id=?2 AND desired_state='running' AND intent_revision=?3 AND identity_revision=?4 AND evidence_revision=?5 AND native_import_revision=?6 AND recovery_attempt_id=?7",
                params![now, soul_id.as_str(), fence.intent_revision, fence.identity_revision, fence.evidence_revision, fence.native_import_revision, attempt_id.as_str()],
            )?;
            if updated != 1 {
                return Err(RegistryError::RecoveryBlocked {
                    soul_id,
                    reason: "STOP_INTENT_OR_STALE_MATERIALIZATION".into(),
                });
            }
            tx.execute(
                "UPDATE incarnations SET provider_preparation_pending=1 WHERE incarnation_id=?1",
                params![incarnation_id.as_str()],
            )?;
            let attempt_updated = tx.execute(
                "UPDATE recovery_attempts SET verdict='succeeded',finished_at=?1,evidence_ref=?3 WHERE attempt_id=?2 AND verdict='replacement_prepared' AND finished_at IS NULL",
                params![now, attempt_id.as_str(), serde_json::to_string(&vec![format!("{ACCEPTED_INCARNATION_REF}{}", incarnation_id.as_str())])?],
            )?;
            if attempt_updated != 1 {
                return Err(RegistryError::RecoveryBlocked {
                    soul_id,
                    reason: "STOP_INTENT_OR_STALE_ATTEMPT".into(),
                });
            }
            charge_successful_recovery(&tx,&soul_id,now)?;
            settle_recovery_retry_tx(&tx, &soul_id, fence.intent_revision, &attempt_id, now, RetrySettlement::Recovered)?;
            tx.commit()?;
            Ok(())
        })
        .await
    }

    pub async fn mark_recovery_blocked(
        &self,
        soul_id: SoulId,
        attempt_id: Option<RecoveryAttemptId>,
        reason: RecoveryBlockReason,
        evidence: Vec<String>,
        fence: RecoveryWriteFence,
    ) -> Result<(), RegistryError> {
        self.mark_recovery_blocked_with_retry(soul_id, attempt_id, reason, evidence, fence, None)
            .await
    }

    pub(crate) async fn mark_recovery_blocked_with_retry(
        &self,
        soul_id: SoulId,
        attempt_id: Option<RecoveryAttemptId>,
        reason: RecoveryBlockReason,
        evidence: Vec<String>,
        fence: RecoveryWriteFence,
        transient: Option<TransientRecoveryFailure>,
    ) -> Result<(), RegistryError> {
        self.finish_recovery_blocked(
            soul_id,
            attempt_id,
            recovery_block_reason_name(reason),
            evidence,
            fence,
            transient.filter(|failure| failure.permits(reason)),
        )
        .await
    }

    async fn finish_recovery_blocked(
        &self,
        soul_id: SoulId,
        attempt_id: Option<RecoveryAttemptId>,
        reason: String,
        evidence: Vec<String>,
        fence: RecoveryWriteFence,
        transient: Option<TransientRecoveryFailure>,
    ) -> Result<(), RegistryError> {
        let retry_registry = self.clone();
        // A probe can block before replacement begins, but it still owns the
        // reservation made before that probe.
        let attempt_id = attempt_id.or_else(|| fence.recovery_attempt_id.clone());
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            validate_recovery_context_fence(&tx, &soul_id, &fence)?;
            if fence.recovery_attempt_id != attempt_id {
                return Err(RegistryError::InvalidState("blocked recovery attempt changed".into()));
            }
            let now = now_millis();
            let attempt_id_param = attempt_id.as_ref().map(RecoveryAttemptId::as_str);
            let updated = tx.execute(
                "UPDATE souls SET recovery_state='blocked',recovery_reason=?1,recovery_attempt_id=NULL,updated_at=?2 WHERE soul_id=?3 AND desired_state='running' AND recovery_attempt_id IS ?4",
                params![reason, now, soul_id.as_str(), attempt_id_param],
            )?;
            if updated != 1 {
                return Err(RegistryError::RecoveryBlocked {
                    soul_id,
                    reason: "STOP_INTENT_OR_STALE_ATTEMPT".into(),
                });
            }
            if let Some(attempt_id) = attempt_id {
                let attempt_updated = tx.execute(
                    "UPDATE recovery_attempts SET verdict='blocked',evidence_ref=?1,finished_at=?2 WHERE attempt_id=?3 AND verdict IN ('started','replacement_prepared') AND finished_at IS NULL",
                    params![serde_json::to_string(&evidence)?, now, attempt_id.as_str()],
                )?;
                if attempt_updated != 1 {
                    return Err(RegistryError::RecoveryBlocked {
                        soul_id,
                        reason: "STOP_INTENT_OR_STALE_ATTEMPT".into(),
                    });
                }
                settle_recovery_retry_tx(&tx, &soul_id, fence.intent_revision, &attempt_id, retry_registry.recovery_now_ms(),
                    RetrySettlement::Blocked {
                        retryable: transient.is_some(),
                        reason: transient.map(TransientRecoveryFailure::as_str).unwrap_or(&reason),
                    })?;
            } else if reason == recovery_block_reason_name(RecoveryBlockReason::StoreUnreadable) {
                // Discovery can refuse a due retry before reserving it. Keep
                // its counted history while removing the obsolete deadline.
                tx.execute(
                    "UPDATE recovery_retries SET next_due_at_ms=NULL,last_reason=?1 WHERE soul_id=?2 AND intent_revision=?3 AND reserved_attempt_id IS NULL",
                    params![reason, soul_id.as_str(), fence.intent_revision],
                )?;
            }
            tx.commit()?;
            Ok(())
        })
        .await
    }

    pub async fn inventory(&self) -> Result<Vec<RuntimeView>, RegistryError> {
        self.run_blocking(move |conn| load_inventory(&conn)).await
    }

    /// Transfer stages remain pinned while a prepared or retryable launch can
    /// still consume them. Running, stopped, and failed incarnations no
    /// longer need the stage after the host has acknowledged its durable
    /// OpenCode receipt.
    pub async fn opencode_transfer_stage_references(
        &self,
    ) -> Result<OpenCodeTransferStageReferences, RegistryError> {
        self.run_blocking(move |conn| {
            failpoint("opencode_transfer_stage_references")?;
            let mut statement = conn.prepare(
                "SELECT incarnation_id,terminal_spec FROM incarnations \
                 WHERE launch_state IN ('prepared','created','starting') \
                   AND terminal_spec IS NOT NULL",
            )?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let mut references = OpenCodeTransferStageReferences::new();
            for (incarnation_id, encoded) in rows {
                let terminal: serde_json::Value = serde_json::from_str(&encoded)?;
                if let Some(transfer) = terminal.get("opencodeTransfer") {
                    let descriptor: OpenCodeTransferDescriptor =
                        serde_json::from_value(transfer.clone()).map_err(|_| {
                            RegistryError::Integrity(
                                "prepared OpenCode transfer descriptor is invalid".into(),
                            )
                        })?;
                    descriptor.validate().map_err(|_| {
                        RegistryError::Integrity(
                            "prepared OpenCode transfer descriptor failed validation".into(),
                        )
                    })?;
                    if descriptor.incarnation_id != incarnation_id {
                        return Err(RegistryError::Integrity(
                            "prepared OpenCode transfer does not match its incarnation".into(),
                        ));
                    }
                    references
                        .entry(descriptor.transfer_id.clone())
                        .or_default()
                        .push(descriptor);
                }
            }
            Ok(references)
        })
        .await
    }

    /// Incarnations that may have a persisted host receipt after a crash in
    /// the grant-acknowledgement/release-marker gap. The service authenticates
    /// their hosts and validates the typed receipt against the terminal
    /// descriptor before making any stage release-eligible.
    pub async fn opencode_transfer_receipt_candidates(
        &self,
    ) -> Result<Vec<IncarnationId>, RegistryError> {
        self.run_blocking(move |conn| {
            let mut statement = conn.prepare(
                "SELECT incarnation_id,terminal_spec FROM incarnations \
                 WHERE launch_state IN ('starting','running') AND terminal_spec IS NOT NULL",
            )?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let mut candidates = Vec::new();
            for (incarnation, encoded) in rows {
                let terminal: serde_json::Value = serde_json::from_str(&encoded)?;
                if terminal.get("opencodeTransfer").is_some() {
                    candidates.push(IncarnationId::parse(incarnation).map_err(|_| {
                        RegistryError::Integrity("invalid OpenCode transfer incarnation id".into())
                    })?);
                }
            }
            Ok(candidates)
        })
        .await
    }

    pub async fn debug_snapshot(&self) -> Result<RegistryDebugSnapshot, RegistryError> {
        Ok(RegistryDebugSnapshot {
            installation_id: self.installation_id().clone(),
            control_epoch: self.control_epoch(),
            views: self.inventory().await?,
        })
    }

    pub(crate) async fn run_blocking<T, F>(&self, f: F) -> Result<T, RegistryError>
    where
        T: Send + 'static,
        F: FnOnce(Connection) -> Result<T, RegistryError> + Send + 'static,
    {
        let path = self.inner.db_path.clone();
        tokio::task::spawn_blocking(move || {
            let conn = open_connection(&path)?;
            f(conn)
        })
        .await
        .map_err(|e| RegistryError::Join(e.to_string()))?
    }
}

pub(crate) fn open_connection(path: &Path) -> Result<Connection, RegistryError> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "FULL")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(conn)
}

fn table_exists(conn: &Connection, table: &str) -> Result<bool, RegistryError> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        params![table],
        |row| row.get(0),
    )?)
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool, RegistryError> {
    let mut statement = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
    for candidate in columns {
        if candidate? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn update_fresh_agent_settings_in_tx(
    conn: &Connection,
    soul_id: &SoulId,
    incarnation_id: &IncarnationId,
    settings: FreshAgentTurnSettings,
    fold: SettingsFold,
) -> Result<(), RegistryError> {
    let encoded: String = conn
        .query_row(
            "SELECT fresh_agent_spec FROM incarnations WHERE soul_id=?1 AND incarnation_id=?2 AND launch_state='running'",
            params![soul_id.as_str(), incarnation_id.as_str()],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| RegistryError::UnknownIncarnation(incarnation_id.clone()))?;
    let mut spec: FreshAgentLaunchSpec = serde_json::from_str(&encoded)
        .map_err(|_| RegistryError::Integrity("invalid fresh-agent launch spec".into()))?;
    let effort = match fold {
        SettingsFold::Turn => settings.effort.clone().or_else(|| spec.effort.clone()),
        SettingsFold::Configure => settings.effort_after_configure(
            &spec.provider,
            spec.model.as_deref(),
            spec.effort.as_deref(),
        ),
    };
    if let Some(value) = settings.cwd {
        let cwd = std::fs::canonicalize(&value)
            .map_err(|_| RegistryError::InvalidState("fresh-agent cwd is unavailable".into()))?;
        let workspace = std::fs::canonicalize(&spec.workspace_path).map_err(|_| {
            RegistryError::InvalidState("fresh-agent workspace is unavailable".into())
        })?;
        if !cwd.is_dir() || !cwd.starts_with(&workspace) {
            return Err(RegistryError::InvalidState(
                "fresh-agent cwd is outside its workspace".into(),
            ));
        }
        spec.cwd = cwd.to_string_lossy().into_owned();
    }
    if let Some(value) = settings.model {
        spec.model = Some(value);
    }
    spec.effort = effort;
    if let Some(value) = settings.permission_mode {
        spec.permission_mode = Some(value);
    }
    if let Some(value) = settings.sandbox {
        spec.sandbox = Some(value);
    }
    spec.validate()
        .map_err(|error| RegistryError::InvalidState(error.message))?;
    let encoded = serde_json::to_string(&spec)
        .map_err(|_| RegistryError::Integrity("encode fresh-agent launch spec".into()))?;
    let changed = conn.execute(
        "UPDATE incarnations SET fresh_agent_spec=?1,updated_at=?2 WHERE soul_id=?3 AND incarnation_id=?4 AND launch_state='running'",
        params![encoded, now_millis(), soul_id.as_str(), incarnation_id.as_str()],
    )?;
    if changed != 1 {
        return Err(RegistryError::UnknownIncarnation(incarnation_id.clone()));
    }
    Ok(())
}

fn input_payload_digest(data: &[u8], correlation: Option<&[u8]>) -> String {
    let mut digest = Sha256::new();
    digest.update((data.len() as u64).to_be_bytes());
    digest.update(data);
    if let Some(correlation) = correlation {
        digest.update((correlation.len() as u64).to_be_bytes());
        digest.update(correlation);
    }
    format!("sha256:{:x}", digest.finalize())
}

fn reservation_totals(
    conn: &Connection,
    project_key: Option<&str>,
) -> Result<ReservationTotals, RegistryError> {
    let query = if project_key.is_some() {
        "SELECT COALESCE(SUM(cpu_milli),0),COALESCE(SUM(memory_bytes),0),COALESCE(SUM(pids_max),0) FROM admission_reservations WHERE project_key=?1"
    } else {
        "SELECT COALESCE(SUM(cpu_milli),0),COALESCE(SUM(memory_bytes),0),COALESCE(SUM(pids_max),0) FROM admission_reservations"
    };
    let row: (u64, u64, u64) = match project_key {
        Some(project) => conn.query_row(query, params![project], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?,
        None => conn.query_row(query, [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?,
    };
    Ok(ReservationTotals {
        cpu_milli: row.0,
        memory_bytes: row.1,
        pids_max: row.2,
    })
}

fn recovery_trigger_name(trigger: RecoveryTrigger) -> &'static str {
    match trigger {
        RecoveryTrigger::ProviderExit => "provider_exit",
        RecoveryTrigger::HostUnreachable => "host_unreachable",
        RecoveryTrigger::StartupReconcile => "startup_reconcile",
        RecoveryTrigger::ManualRetry => "manual_retry",
        RecoveryTrigger::RetryExhausted => "retry_exhausted",
        RecoveryTrigger::ExplicitRequest => "explicit_request",
    }
}

fn recovery_path_name(path: RecoveryPath) -> &'static str {
    match path {
        RecoveryPath::Reattach => "reattach",
        RecoveryPath::NativeResume => "native_resume",
        RecoveryPath::CheckpointRestore => "checkpoint_restore",
        RecoveryPath::PristineSeed => "pristine_seed",
        RecoveryPath::NativeImport => "native_import",
    }
}

fn recovery_block_reason_name(reason: RecoveryBlockReason) -> String {
    serde_json::to_value(reason)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| "RECOVERY_BLOCKED".into())
}

fn fixture_kind_name(fixture: FixtureKind) -> &'static str {
    match fixture {
        FixtureKind::Heartbeat => "heartbeat",
        FixtureKind::DescendantSpawner => "descendant_spawner",
        FixtureKind::CpuBurner => "cpu_burner",
        FixtureKind::MemoryAllocator => "memory_allocator",
        FixtureKind::NativeSession => "native_session",
        FixtureKind::SecurityProbe => "security_probe",
    }
}

fn parse_fixture_kind(value: &str) -> Result<FixtureKind, RegistryError> {
    match value {
        "heartbeat" => Ok(FixtureKind::Heartbeat),
        "descendant_spawner" => Ok(FixtureKind::DescendantSpawner),
        "cpu_burner" => Ok(FixtureKind::CpuBurner),
        "memory_allocator" => Ok(FixtureKind::MemoryAllocator),
        "native_session" => Ok(FixtureKind::NativeSession),
        "security_probe" => Ok(FixtureKind::SecurityProbe),
        other => Err(RegistryError::Integrity(format!(
            "unknown fixture kind {other}"
        ))),
    }
}

fn runtime_profile_name(profile: RuntimeProfile) -> &'static str {
    match profile {
        RuntimeProfile::DefaultAgent => "default_agent",
        RuntimeProfile::TestFixture => "test_fixture",
        RuntimeProfile::Custom => "custom",
    }
}

fn parse_runtime_profile(value: &str) -> Result<RuntimeProfile, RegistryError> {
    match value {
        "default_agent" => Ok(RuntimeProfile::DefaultAgent),
        "test_fixture" => Ok(RuntimeProfile::TestFixture),
        "custom" => Ok(RuntimeProfile::Custom),
        other => Err(RegistryError::Integrity(format!(
            "unknown runtime profile {other}"
        ))),
    }
}

pub fn stable_provider_volume_name(installation: &InstallationId, soul: &SoulId) -> String {
    let digest = Sha256::digest(format!("{}\0{}", installation.as_str(), soul.as_str()).as_bytes());
    format!("freshell-provider-{digest:x}")[..42].to_string()
}

fn rearm_exhausted_success_window(
    tx: &Connection,
    soul_id: &SoulId,
    now: i64,
) -> Result<(), RegistryError> {
    let (window_started, successes) = tx.query_row(
        "SELECT recovery_window_started_at,successful_recoveries_in_window FROM souls WHERE soul_id=?1",
        [soul_id.as_str()],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if !freshell_agent_runtime::successful_recovery_budget_available(window_started, successes, now)
    {
        tx.execute(
            "UPDATE souls SET recovery_window_started_at=?1,successful_recoveries_in_window=0 WHERE soul_id=?2",
            params![now, soul_id.as_str()],
        )?;
    }
    Ok(())
}

fn charge_successful_recovery(
    tx: &Connection,
    soul_id: &SoulId,
    now: i64,
) -> Result<(), RegistryError> {
    let (window_start, successes): (Option<i64>,u64) = tx.query_row("SELECT recovery_window_started_at,successful_recoveries_in_window FROM souls WHERE soul_id=?1",[soul_id.as_str()],|r|Ok((r.get(0)?,r.get(1)?)))?;
    let (next_window, next_successes) = match window_start {
        Some(started)
            if now.saturating_sub(started) < freshell_agent_runtime::RECOVERY_WINDOW_MS =>
        {
            (started, successes.saturating_add(1))
        }
        _ => (now, 1),
    };
    tx.execute("UPDATE souls SET recovery_window_started_at=?1,successful_recoveries_in_window=?2 WHERE soul_id=?3",params![next_window,next_successes,soul_id.as_str()])?;
    Ok(())
}

fn stop_outcome_name(outcome: StopOutcome) -> &'static str {
    match outcome {
        StopOutcome::VerifiedEmpty => "verified_empty",
        StopOutcome::BackendUnavailable => "backend_unavailable",
        StopOutcome::TerminationUnconfirmed => "termination_unconfirmed",
        StopOutcome::BlockedOwnership => "blocked_ownership",
    }
}

fn parse_stop_outcome(value: &str) -> Result<StopOutcome, RegistryError> {
    match value {
        "verified_empty" => Ok(StopOutcome::VerifiedEmpty),
        "backend_unavailable" => Ok(StopOutcome::BackendUnavailable),
        "termination_unconfirmed" => Ok(StopOutcome::TerminationUnconfirmed),
        "blocked_ownership" => Ok(StopOutcome::BlockedOwnership),
        _ => Err(RegistryError::Integrity(
            "unknown ordinary Stop outcome".into(),
        )),
    }
}

fn create_ordinary_stop_schema(conn: &Connection) -> Result<(), RegistryError> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS ordinary_stops (
        soul_id TEXT NOT NULL REFERENCES souls(soul_id),
        incarnation_id TEXT NOT NULL REFERENCES incarnations(incarnation_id),
        intent_revision INTEGER NOT NULL,
        execution_generation INTEGER NOT NULL,
        outcome TEXT CHECK(outcome IN ('verified_empty','backend_unavailable','termination_unconfirmed','blocked_ownership')),
        capability_endpoint TEXT,
        capability_grant_id TEXT,
        revoke_pending INTEGER NOT NULL CHECK(revoke_pending IN (0,1)),
        settled INTEGER NOT NULL CHECK(settled IN (0,1)),
        updated_at INTEGER NOT NULL,
        CHECK((capability_endpoint IS NULL) = (capability_grant_id IS NULL)),
        CHECK(revoke_pending=0 OR (outcome='verified_empty' AND capability_grant_id IS NOT NULL AND settled=0)),
        PRIMARY KEY(soul_id,incarnation_id,intent_revision)
    );")?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn insert_ordinary_stop(
    conn: &Connection,
    soul: &SoulId,
    incarnation: &IncarnationId,
    revision: u64,
    generation: u64,
    handle: Option<&OwnedRuntimeHandle>,
    outcome: Option<StopOutcome>,
) -> Result<(), RegistryError> {
    let capability = handle.and_then(|handle| {
        handle
            .terminal()
            .and_then(|terminal| terminal.provider_launch_context.as_ref())
            .or_else(|| {
                handle
                    .fresh_agent()
                    .and_then(|agent| agent.provider_launch_context.as_ref())
            })
            .and_then(|context| context.mcp_capability.as_ref())
    });
    let pending = outcome == Some(StopOutcome::VerifiedEmpty) && capability.is_some();
    conn.execute("INSERT OR IGNORE INTO ordinary_stops(soul_id,incarnation_id,intent_revision,execution_generation,outcome,capability_endpoint,capability_grant_id,revoke_pending,settled,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![soul.as_str(),incarnation.as_str(),revision,generation,outcome.map(stop_outcome_name),capability.map(|c| &c.endpoint),capability.map(|c| &c.grant_id),pending,outcome == Some(StopOutcome::VerifiedEmpty) && !pending,now_millis()])?;
    Ok(())
}

fn migrate_ordinary_stops(conn: &Connection) -> Result<(), RegistryError> {
    let installation: String =
        conn.query_row("SELECT installation_id FROM installation", [], |r| r.get(0))?;
    let installation = InstallationId::parse(installation)
        .map_err(|_| RegistryError::Integrity("invalid installation".into()))?;
    // Old tombstones did not name an incarnation. Admit only an unambiguous
    // latest enclosure that already existed at that exact ordinary Stop.
    let mut query = conn.prepare("SELECT s.soul_id,s.intent_revision,i.incarnation_id,i.execution_generation,i.cleanup_state FROM souls s JOIN stop_tombstones t ON t.soul_id=s.soul_id AND t.intent_revision=s.intent_revision JOIN incarnations i ON i.soul_id=s.soul_id WHERE s.desired_state='stopped' AND s.recovery_state!='lost' AND s.recovery_reason='STOP_INTENT' AND t.actor='supervisor' AND t.reason='managed stop' AND i.created_at<=t.committed_at AND NOT EXISTS(SELECT 1 FROM incarnations newer WHERE newer.soul_id=s.soul_id AND newer.incarnation_id!=i.incarnation_id AND newer.created_at>=i.created_at)")?;
    let rows = query
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, u64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, u64>(3)?,
                r.get::<_, String>(4)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (soul, revision, incarnation, generation, cleanup) in rows {
        let soul = SoulId::parse(soul)
            .map_err(|_| RegistryError::Integrity("invalid Stop soul".into()))?;
        let incarnation = IncarnationId::parse(incarnation)
            .map_err(|_| RegistryError::Integrity("invalid Stop incarnation".into()))?;
        let owned = load_owned_handle(conn, installation.clone(), &incarnation);
        let outcome = match cleanup.as_str() {
            "verified_empty" => Some(StopOutcome::VerifiedEmpty),
            "blocked_ownership" => Some(StopOutcome::BlockedOwnership),
            "termination_unconfirmed" => Some(StopOutcome::TerminationUnconfirmed),
            _ if owned.is_err() => Some(StopOutcome::BlockedOwnership),
            _ => None,
        };
        insert_ordinary_stop(
            conn,
            &soul,
            &incarnation,
            revision,
            generation,
            owned.as_ref().ok(),
            outcome,
        )?;
    }
    Ok(())
}

fn validate_ordinary_stop(
    conn: &Connection,
    handle: &OwnedRuntimeHandle,
) -> Result<StopProgress, RegistryError> {
    let fence = handle.stop_fence()?;
    let (desired, revision, current_incarnation): (String,u64,String) = conn.query_row(
        "SELECT desired_state,intent_revision,(SELECT incarnation_id FROM incarnations WHERE soul_id=s.soul_id ORDER BY created_at DESC,rowid DESC LIMIT 1) FROM souls s WHERE soul_id=?1",
        [handle.soul_id().as_str()], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)),
    )?;
    if revision != fence.intent_revision {
        return Err(RegistryError::StaleIntentRevision {
            expected: fence.intent_revision,
            current: revision,
        });
    }
    if desired != "stopped" || current_incarnation != handle.incarnation_id().as_str() {
        return Err(RegistryError::InvalidState(
            "ordinary Stop target changed".into(),
        ));
    }
    let current = load_owned_handle(
        conn,
        handle.installation_id.clone(),
        handle.incarnation_id(),
    )?;
    if current.launch_nonce != handle.launch_nonce
        || current.daemon_id != handle.daemon_id
        || current.container_id != handle.container_id
        || current.image_ref != handle.image_ref
        || current.runtime_dir != handle.runtime_dir
        || current.host_binary_path != handle.host_binary_path
        || current.immutable_config_digest != handle.immutable_config_digest
        || current.launch_policy != handle.launch_policy
        || current.provider_store_id != handle.provider_store_id
        || current.provider_volume_name != handle.provider_volume_name
        || current.requested_limits != handle.requested_limits
    {
        return Err(RegistryError::InvalidState(
            "ordinary Stop ownership changed".into(),
        ));
    }
    type Row = (Option<String>, Option<String>, Option<String>, bool);
    let (outcome, endpoint, grant, settled): Row = conn.query_row(
        "SELECT p.outcome,p.capability_endpoint,p.capability_grant_id,p.settled FROM ordinary_stops p JOIN incarnations i ON i.incarnation_id=p.incarnation_id WHERE p.soul_id=?1 AND p.incarnation_id=?2 AND p.intent_revision=?3 AND p.execution_generation=?4 AND i.execution_generation=p.execution_generation",
        params![handle.soul_id().as_str(),handle.incarnation_id().as_str(),fence.intent_revision,fence.execution_generation],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)),
    )?;
    Ok(StopProgress {
        outcome: outcome.as_deref().map(parse_stop_outcome).transpose()?,
        capability: endpoint.zip(grant),
        settled,
    })
}

fn mark_stop_outcome_in_tx(
    conn: &Connection,
    incarnation: &IncarnationId,
    outcome: StopOutcome,
) -> Result<(), RegistryError> {
    let (launch_state, cleanup_state) = match outcome {
        StopOutcome::VerifiedEmpty => ("stopped", "verified_empty"),
        StopOutcome::BlockedOwnership => ("stopping", "blocked_ownership"),
        StopOutcome::BackendUnavailable | StopOutcome::TerminationUnconfirmed => {
            ("stopping", "termination_unconfirmed")
        }
    };
    let now = now_millis();
    conn.execute("UPDATE incarnations SET launch_state=?1,cleanup_state=?2,updated_at=?3 WHERE incarnation_id=?4", params![launch_state,cleanup_state,now,incarnation.as_str()])?;
    if outcome == StopOutcome::VerifiedEmpty {
        conn.execute(
            "DELETE FROM writer_claims WHERE incarnation_id=?1",
            [incarnation.as_str()],
        )?;
        conn.execute(
            "DELETE FROM admission_reservations WHERE incarnation_id=?1",
            [incarnation.as_str()],
        )?;
        conn.execute(
            "UPDATE commands SET state='stopped',updated_at=?1 WHERE incarnation_id=?2",
            params![now, incarnation.as_str()],
        )?;
        conn.execute("UPDATE souls SET recovery_state='stopped',recovery_reason='STOP_INTENT',recovery_attempt_id=NULL,updated_at=?1 WHERE soul_id=(SELECT soul_id FROM incarnations WHERE incarnation_id=?2) AND desired_state='stopped' AND recovery_state!='lost'", params![now,incarnation.as_str()])?;
    }
    Ok(())
}

fn create_recovery_retry_schema(conn: &Connection) -> Result<(), RegistryError> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS recovery_retries (
        soul_id TEXT NOT NULL REFERENCES souls(soul_id),
        intent_revision INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL CHECK(attempt_count BETWEEN 1 AND 3),
        next_due_at_ms INTEGER,
        reserved_attempt_id TEXT REFERENCES recovery_attempts(attempt_id),
        last_reason TEXT NOT NULL,
        PRIMARY KEY(soul_id,intent_revision)
    );
    CREATE TRIGGER IF NOT EXISTS cancel_recovery_retry_on_intent
    AFTER UPDATE OF desired_state,intent_revision,recovery_state ON souls
    WHEN NEW.desired_state!='running' OR NEW.intent_revision!=OLD.intent_revision OR NEW.recovery_state='lost'
    BEGIN
        UPDATE recovery_attempts SET verdict='cancelled',finished_at=NEW.updated_at
            WHERE finished_at IS NULL AND attempt_id IN (SELECT reserved_attempt_id FROM recovery_retries WHERE soul_id=NEW.soul_id);
        DELETE FROM recovery_retries WHERE soul_id=NEW.soul_id;
        UPDATE souls SET recovery_attempt_id=NULL WHERE soul_id=NEW.soul_id;
    END;")?;
    Ok(())
}

fn load_recovery_retry(
    conn: &Connection,
    soul_id: &SoulId,
    intent_revision: u64,
) -> Result<Option<RecoveryRetry>, RegistryError> {
    let row: Option<(u8,Option<i64>,Option<String>,String)> = conn.query_row(
        "SELECT attempt_count,next_due_at_ms,reserved_attempt_id,last_reason FROM recovery_retries WHERE soul_id=?1 AND intent_revision=?2",
        params![soul_id.as_str(),intent_revision], |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)),
    ).optional()?;
    row.map(|(attempt_count, next_due_at_ms, attempt, last_reason)| {
        Ok(RecoveryRetry {
            soul_id: soul_id.clone(),
            intent_revision,
            attempt_count,
            next_due_at_ms,
            last_reason,
            reserved_attempt_id: attempt
                .map(RecoveryAttemptId::parse)
                .transpose()
                .map_err(|_| RegistryError::Integrity("invalid retry attempt".into()))?,
        })
    })
    .transpose()
}

enum RetrySettlement<'a> {
    Recovered,
    Blocked { retryable: bool, reason: &'a str },
}

fn settle_recovery_retry_tx(
    tx: &Connection,
    soul_id: &SoulId,
    intent_revision: u64,
    attempt_id: &RecoveryAttemptId,
    now_ms: i64,
    settlement: RetrySettlement<'_>,
) -> Result<(), RegistryError> {
    let Some(retry) = load_recovery_retry(tx, soul_id, intent_revision)? else {
        return Ok(());
    };
    if retry.reserved_attempt_id.as_ref() != Some(attempt_id) {
        return Ok(());
    }
    let eligible: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM souls WHERE soul_id=?1 AND intent_revision=?2 AND desired_state='running' AND recovery_state!='lost' AND (recovery_attempt_id IS NULL OR recovery_attempt_id=?3))",
        params![soul_id.as_str(), intent_revision, attempt_id.as_str()],
        |row| row.get(0),
    )?;
    if !eligible {
        return Ok(());
    }
    let (retryable, reason) = match settlement {
        RetrySettlement::Recovered => {
            // Only the validated live/success transaction can certify recovery.
            // A late caller carrying a success flag cannot clear an unfinished
            // reservation (and thereby grant a fresh automatic budget).
            let succeeded: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM recovery_attempts WHERE attempt_id=?1 AND soul_id=?2 AND intent_revision=?3 AND verdict IN ('succeeded','reattached') AND finished_at IS NOT NULL)",
            params![attempt_id.as_str(), soul_id.as_str(), intent_revision],
            |row| row.get(0),
        )?;
            if !succeeded {
                return Ok(());
            }
            tx.execute(
                "DELETE FROM recovery_retries WHERE soul_id=?1 AND intent_revision=?2",
                params![soul_id.as_str(), intent_revision],
            )?;
            return Ok(());
        }
        RetrySettlement::Blocked { retryable, reason } => (retryable, reason),
    };
    let reserved_at: i64 = tx.query_row(
        "SELECT started_at FROM recovery_attempts WHERE attempt_id=?1",
        [attempt_id.as_str()],
        |r| r.get(0),
    )?;
    let settled_at = now_ms.max(reserved_at);
    let due = recovery_retry::next_due(retry.attempt_count, retryable, settled_at);
    let exhausted = retryable && retry.attempt_count == 3;
    tx.execute("UPDATE recovery_retries SET reserved_attempt_id=NULL,next_due_at_ms=?1,last_reason=?2 WHERE soul_id=?3 AND intent_revision=?4 AND reserved_attempt_id=?5",params![due, if exhausted {"retry_exhausted"} else {reason},soul_id.as_str(),intent_revision,attempt_id.as_str()])?;
    tx.execute("UPDATE recovery_attempts SET verdict='blocked',finished_at=?1 WHERE attempt_id=?2 AND finished_at IS NULL", params![settled_at,attempt_id.as_str()])?;
    tx.execute("UPDATE souls SET recovery_state='blocked',recovery_attempt_id=NULL,recovery_reason=CASE WHEN ?1 THEN 'RETRY_BUDGET' ELSE COALESCE(recovery_reason,?2) END,updated_at=?3 WHERE soul_id=?4 AND intent_revision=?5",params![exhausted,reason,settled_at,soul_id.as_str(),intent_revision])?;
    Ok(())
}

fn create_schema(
    conn: &mut Connection,
    installation_id: InstallationId,
) -> Result<(), RegistryError> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute_batch(&format!(r#"
        CREATE TABLE installation (
            singleton INTEGER PRIMARY KEY CHECK(singleton=1),
            installation_id TEXT NOT NULL,
            schema_version INTEGER NOT NULL,
            control_epoch INTEGER NOT NULL,
            inventory_revision INTEGER NOT NULL DEFAULT 0,
            initial_scan_state TEXT NOT NULL DEFAULT 'pending',
            initial_scan_error TEXT,
            initial_scan_started_at INTEGER,
            initial_scan_finished_at INTEGER,
            initial_scan_peak_concurrency INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE souls (
            soul_id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            provider_store_id TEXT NOT NULL,
            native_session_id TEXT,
            creation_seed_ref TEXT NOT NULL,
            desired_state TEXT NOT NULL,
            intent_revision INTEGER NOT NULL,
            recovery_state TEXT NOT NULL,
            recovery_reason TEXT,
            recovery_attempt_id TEXT,
            durability_state TEXT NOT NULL,
            allocation_state TEXT NOT NULL,
            resume_spec TEXT,
            claude_fork_recipe TEXT,
            checkpoint_revision INTEGER NOT NULL,
            evidence_revision INTEGER NOT NULL,
            identity_revision INTEGER NOT NULL DEFAULT 0,
            native_import_revision INTEGER NOT NULL DEFAULT 0,
            native_import_state TEXT NOT NULL DEFAULT 'legacy_unknown',
            native_import_source_store_id TEXT,
            native_import_root_session_id TEXT,
            native_import_source_generation TEXT,
            native_import_schema_fingerprint TEXT,
            native_import_migration_fingerprint TEXT,
            native_import_complete_inventory INTEGER NOT NULL DEFAULT 0,
            native_import_authority TEXT NOT NULL DEFAULT 'legacy_unknown',
            recovery_window_started_at INTEGER,
            successful_recoveries_in_window INTEGER NOT NULL,
            project_key TEXT NOT NULL,
            resource_profile TEXT NOT NULL,
            provider_volume_name TEXT NOT NULL,
            configured_limits TEXT,
            loss_incident_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE incarnations (
            incarnation_id TEXT PRIMARY KEY,
            soul_id TEXT NOT NULL REFERENCES souls(soul_id),
            launch_nonce TEXT NOT NULL UNIQUE,
            docker_daemon_id TEXT,
            container_id TEXT,
            image_ref TEXT,
            runtime_dir TEXT,
            host_binary_path TEXT,
            immutable_config_digest TEXT,
            launch_policy TEXT,
            native_identity_launch TEXT,
            native_identity_observation TEXT,
            launch_state TEXT NOT NULL,
            host_boot_id TEXT,
            execution_generation INTEGER NOT NULL,
            grant_id TEXT,
            requested_limits TEXT NOT NULL,
            effective_limits TEXT,
            cleanup_state TEXT NOT NULL,
            fixture_kind TEXT,
            terminal_id TEXT,
            terminal_spec TEXT,
            fresh_agent_spec TEXT,
            prior_incarnation_id TEXT,
            recovery_attempt_id TEXT,
            provider_preparation_pending INTEGER NOT NULL DEFAULT 0,
            exit_code INTEGER,
            oom_killed INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX incarnation_container_identity ON incarnations(docker_daemon_id, container_id) WHERE container_id IS NOT NULL;
        CREATE UNIQUE INDEX one_active_incarnation_per_soul ON incarnations(soul_id) WHERE launch_state IN ({ACTIVE_STATES});
        CREATE TABLE writer_claims (
            claim_id INTEGER PRIMARY KEY AUTOINCREMENT,
            provider TEXT NOT NULL,
            provider_store_id TEXT NOT NULL,
            native_session_id TEXT,
            soul_id TEXT NOT NULL REFERENCES souls(soul_id),
            incarnation_id TEXT NOT NULL REFERENCES incarnations(incarnation_id),
            intent_revision INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX one_native_writer ON writer_claims(provider,provider_store_id,native_session_id) WHERE native_session_id IS NOT NULL;
        CREATE TABLE native_origin_owners (
            provider TEXT NOT NULL,
            source_store_id TEXT NOT NULL,
            native_root_session_id TEXT NOT NULL,
            owner_soul_id TEXT REFERENCES souls(soul_id),
            source_generation TEXT,
            ownership_state TEXT NOT NULL CHECK (ownership_state IN ('owned','ambiguous')),
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(provider,source_store_id,native_root_session_id)
        );
        CREATE TABLE commands (
            soul_id TEXT NOT NULL REFERENCES souls(soul_id),
            request_id TEXT NOT NULL,
            payload_digest TEXT NOT NULL,
            protected_payload_ref TEXT,
            state TEXT NOT NULL,
            provider_ack_id TEXT,
            incarnation_id TEXT NOT NULL REFERENCES incarnations(incarnation_id),
            event_cursor INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(soul_id, request_id)
        );
        CREATE TABLE input_commands (
            soul_id TEXT NOT NULL REFERENCES souls(soul_id),
            request_id TEXT NOT NULL,
            payload_digest TEXT NOT NULL,
            protected_payload BLOB NOT NULL,
            incarnation_id TEXT NOT NULL REFERENCES incarnations(incarnation_id),
            state TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(soul_id, request_id)
        );
        CREATE TABLE recovery_attempts (
            attempt_id TEXT PRIMARY KEY,
            soul_id TEXT NOT NULL REFERENCES souls(soul_id),
            prior_incarnation_id TEXT,
            intent_revision INTEGER NOT NULL,
            path TEXT NOT NULL,
            verdict TEXT NOT NULL,
            evidence_ref TEXT,
            started_at INTEGER NOT NULL,
            finished_at INTEGER
        );
        CREATE TABLE view_intents (
            view_id TEXT PRIMARY KEY,
            soul_id TEXT NOT NULL REFERENCES souls(soul_id),
            owner_id TEXT NOT NULL,
            workspace_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            preferred_tab_id TEXT NOT NULL,
            preferred_pane_id TEXT NOT NULL,
            title TEXT NOT NULL,
            placement_group TEXT NOT NULL,
            visibility TEXT NOT NULL,
            revision INTEGER NOT NULL,
            soul_intent_revision INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX one_automatic_primary_view_per_soul ON view_intents(owner_id,workspace_id,soul_id) WHERE kind='automatic_primary';
        CREATE TABLE outbox (
            event_id TEXT PRIMARY KEY,
            event_kind TEXT NOT NULL,
            payload TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            delivered_at INTEGER
        );
        CREATE TABLE loss_incidents (
            incident_id TEXT PRIMARY KEY,
            correlation_id TEXT NOT NULL,
            soul_id TEXT NOT NULL REFERENCES souls(soul_id),
            incarnation_id TEXT NOT NULL REFERENCES incarnations(incarnation_id),
            provider TEXT NOT NULL,
            provider_store_id TEXT NOT NULL,
            native_session_ref_hash TEXT NOT NULL,
            intent_revision INTEGER NOT NULL,
            decision_state TEXT NOT NULL,
            reason_code TEXT NOT NULL,
            certificate_json TEXT NOT NULL,
            cleanup_state TEXT NOT NULL,
            cleanup_json TEXT NOT NULL,
            observed_cause TEXT NOT NULL,
            missing_invariant TEXT NOT NULL,
            hypotheses_json TEXT NOT NULL,
            preventive_action TEXT NOT NULL,
            regression_case TEXT NOT NULL,
            captured_control_epoch INTEGER,
            captured_identity_revision INTEGER,
            captured_evidence_revision INTEGER,
            captured_native_import_revision INTEGER,
            captured_native_import_state TEXT,
            captured_source_store_id TEXT,
            captured_root_session_id TEXT,
            captured_source_generation TEXT,
            captured_source_schema_fingerprint TEXT,
            captured_migration_fingerprint TEXT,
            captured_native_import_complete INTEGER,
            captured_native_import_authority TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            closed_at INTEGER
        );
        CREATE UNIQUE INDEX one_loss_incident_per_soul_revision ON loss_incidents(soul_id,intent_revision);
        CREATE TABLE runtime_notices (
            notice_id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            message TEXT NOT NULL,
            reference TEXT NOT NULL,
            incident_ids_json TEXT NOT NULL,
            superseded_by TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE notice_receipts (
            notice_id TEXT NOT NULL REFERENCES runtime_notices(notice_id),
            profile_id TEXT NOT NULL,
            state TEXT NOT NULL,
            rendered_at INTEGER,
            acknowledged_at INTEGER,
            dismissed_at INTEGER,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(notice_id,profile_id)
        );
        CREATE TABLE runtime_counters (
            name TEXT NOT NULL,
            label TEXT NOT NULL,
            value INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(name,label)
        );
        CREATE TABLE rollout_state (
            singleton INTEGER PRIMARY KEY CHECK(singleton=1),
            mode TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE migration_runs (
            migration_id TEXT PRIMARY KEY,
            current_mode TEXT NOT NULL,
            requested_mode TEXT NOT NULL,
            dry_run INTEGER NOT NULL,
            plan_json TEXT NOT NULL,
            backup_path TEXT,
            applied_at INTEGER,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE repair_audits (
            audit_id TEXT PRIMARY KEY,
            audit_json TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE stopped_repair_operations (
            operation_id TEXT PRIMARY KEY,
            idempotency_key TEXT NOT NULL UNIQUE,
            target_fingerprint TEXT NOT NULL,
            targets_json TEXT NOT NULL,
            scope_json TEXT,
            owner_choices_json TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL CHECK (status IN ('importing','withdraw_pending','complete')),
            result_json TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE stopped_repair_root_receipts (
            operation_id TEXT NOT NULL REFERENCES stopped_repair_operations(operation_id),
            root_session_id TEXT NOT NULL,
            canonical_soul_id TEXT NOT NULL REFERENCES souls(soul_id),
            transfer_id TEXT NOT NULL,
            source_store_id TEXT NOT NULL,
            source_generation TEXT NOT NULL,
            identity_revision INTEGER NOT NULL,
            intent_revision INTEGER NOT NULL,
            native_import_revision INTEGER NOT NULL,
            active_incarnation_id TEXT NOT NULL REFERENCES incarnations(incarnation_id),
            execution_generation INTEGER NOT NULL,
            import_receipt_json TEXT NOT NULL,
            readable_receipt_json TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('verified')),
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(operation_id,root_session_id)
        );
        CREATE TABLE stopped_repair_withdrawals (
            operation_id TEXT PRIMARY KEY REFERENCES stopped_repair_operations(operation_id),
            generation TEXT NOT NULL,
            targets_json TEXT NOT NULL,
            incident_ids_json TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('files_pending','files_complete')),
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE stop_tombstones (
            soul_id TEXT NOT NULL REFERENCES souls(soul_id),
            intent_revision INTEGER NOT NULL,
            actor TEXT NOT NULL,
            reason TEXT NOT NULL,
            committed_at INTEGER NOT NULL,
            PRIMARY KEY(soul_id, intent_revision)
        );
        CREATE TABLE admission_reservations (
            incarnation_id TEXT PRIMARY KEY REFERENCES incarnations(incarnation_id),
            project_key TEXT NOT NULL,
            cpu_milli INTEGER NOT NULL,
            memory_bytes INTEGER NOT NULL,
            pids_max INTEGER NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TRIGGER souls_inventory_insert AFTER INSERT ON souls BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
        CREATE TRIGGER souls_inventory_update AFTER UPDATE ON souls BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
        CREATE TRIGGER souls_inventory_delete AFTER DELETE ON souls BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
        CREATE TRIGGER incarnations_inventory_insert AFTER INSERT ON incarnations BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
        CREATE TRIGGER incarnations_inventory_update AFTER UPDATE ON incarnations BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
        CREATE TRIGGER incarnations_inventory_delete AFTER DELETE ON incarnations BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
        CREATE TRIGGER view_intents_inventory_insert AFTER INSERT ON view_intents BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
        CREATE TRIGGER view_intents_inventory_update AFTER UPDATE ON view_intents BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
        CREATE TRIGGER view_intents_inventory_delete AFTER DELETE ON view_intents BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
    "#))?;
    input_reservation::create_table(&tx)?;
    create_recovery_retry_schema(&tx)?;
    create_ordinary_stop_schema(&tx)?;
    tx.execute("INSERT INTO installation (singleton,installation_id,schema_version,control_epoch,inventory_revision,initial_scan_state) VALUES (1,?1,?2,0,0,'pending')", params![installation_id.as_str(), SCHEMA_VERSION])?;
    tx.execute(
        "INSERT INTO rollout_state (singleton,mode,updated_at) VALUES (1,'legacy',?1)",
        params![now_millis()],
    )?;
    tx.commit()?;
    durable_sync_parent(conn.path().map(Path::new).and_then(Path::parent))?;
    Ok(())
}

fn migrate_schema(conn: &mut Connection) -> Result<(), RegistryError> {
    let mut schema: u32 = conn.query_row(
        "SELECT schema_version FROM installation WHERE singleton=1",
        [],
        |row| row.get(0),
    )?;
    if schema > SCHEMA_VERSION {
        return Err(RegistryError::NewerSchema {
            found: schema,
            supported: SCHEMA_VERSION,
        });
    }
    if schema == 1 {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch(
            r#"
            ALTER TABLE souls ADD COLUMN project_key TEXT NOT NULL DEFAULT 'default';
            ALTER TABLE souls ADD COLUMN resource_profile TEXT NOT NULL DEFAULT 'custom';
            ALTER TABLE souls ADD COLUMN provider_volume_name TEXT NOT NULL DEFAULT '';
            ALTER TABLE incarnations ADD COLUMN terminal_id TEXT;
            ALTER TABLE incarnations ADD COLUMN terminal_spec TEXT;
            CREATE TABLE admission_reservations (
                incarnation_id TEXT PRIMARY KEY REFERENCES incarnations(incarnation_id),
                project_key TEXT NOT NULL,
                cpu_milli INTEGER NOT NULL,
                memory_bytes INTEGER NOT NULL,
                pids_max INTEGER NOT NULL,
                created_at INTEGER NOT NULL
            );
            UPDATE installation SET schema_version=2 WHERE singleton=1;
            "#,
        )?;
        tx.commit()?;
        schema = 2;
    }
    if schema == 2 {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch(
            r#"
            ALTER TABLE souls ADD COLUMN recovery_reason TEXT;
            ALTER TABLE souls ADD COLUMN recovery_attempt_id TEXT;
            ALTER TABLE souls ADD COLUMN allocation_state TEXT NOT NULL DEFAULT 'allocated';
            ALTER TABLE souls ADD COLUMN resume_spec TEXT;
            ALTER TABLE souls ADD COLUMN evidence_revision INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE souls ADD COLUMN recovery_window_started_at INTEGER;
            ALTER TABLE souls ADD COLUMN successful_recoveries_in_window INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE incarnations ADD COLUMN fixture_kind TEXT;
            ALTER TABLE incarnations ADD COLUMN prior_incarnation_id TEXT;
            ALTER TABLE incarnations ADD COLUMN recovery_attempt_id TEXT;
            CREATE TABLE input_commands (
                soul_id TEXT NOT NULL REFERENCES souls(soul_id),
                request_id TEXT NOT NULL,
                payload_digest TEXT NOT NULL,
                incarnation_id TEXT NOT NULL REFERENCES incarnations(incarnation_id),
                state TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY(soul_id, request_id)
            );
            UPDATE installation SET schema_version=3 WHERE singleton=1;
            "#,
        )?;
        tx.commit()?;
        schema = 3;
    }
    if schema == 3 {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch(
            r#"
            ALTER TABLE input_commands ADD COLUMN protected_payload BLOB NOT NULL DEFAULT X'';
            UPDATE installation SET schema_version=4 WHERE singleton=1;
            "#,
        )?;
        tx.commit()?;
        schema = 4;
    }
    if schema == 4 {
        let add_inventory_revision = !column_exists(conn, "installation", "inventory_revision")?;
        let add_scan_state = !column_exists(conn, "installation", "initial_scan_state")?;
        let add_scan_error = !column_exists(conn, "installation", "initial_scan_error")?;
        let add_scan_started = !column_exists(conn, "installation", "initial_scan_started_at")?;
        let add_scan_finished = !column_exists(conn, "installation", "initial_scan_finished_at")?;
        let add_scan_peak = !column_exists(conn, "installation", "initial_scan_peak_concurrency")?;
        let add_configured_limits = !column_exists(conn, "souls", "configured_limits")?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if add_inventory_revision {
            tx.execute_batch(
                "ALTER TABLE installation ADD COLUMN inventory_revision INTEGER NOT NULL DEFAULT 0;",
            )?;
        }
        if add_scan_state {
            tx.execute_batch(
                "ALTER TABLE installation ADD COLUMN initial_scan_state TEXT NOT NULL DEFAULT 'pending';",
            )?;
        }
        if add_scan_error {
            tx.execute_batch("ALTER TABLE installation ADD COLUMN initial_scan_error TEXT;")?;
        }
        if add_scan_started {
            tx.execute_batch(
                "ALTER TABLE installation ADD COLUMN initial_scan_started_at INTEGER;",
            )?;
        }
        if add_scan_finished {
            tx.execute_batch(
                "ALTER TABLE installation ADD COLUMN initial_scan_finished_at INTEGER;",
            )?;
        }
        if add_scan_peak {
            tx.execute_batch(
                "ALTER TABLE installation ADD COLUMN initial_scan_peak_concurrency INTEGER NOT NULL DEFAULT 0;",
            )?;
        }
        if add_configured_limits {
            tx.execute_batch("ALTER TABLE souls ADD COLUMN configured_limits TEXT;")?;
        }
        tx.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS view_intents (
                view_id TEXT PRIMARY KEY,
                soul_id TEXT NOT NULL REFERENCES souls(soul_id),
                owner_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                preferred_tab_id TEXT NOT NULL,
                preferred_pane_id TEXT NOT NULL,
                title TEXT NOT NULL,
                placement_group TEXT NOT NULL,
                visibility TEXT NOT NULL,
                revision INTEGER NOT NULL,
                soul_intent_revision INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS one_automatic_primary_view_per_soul ON view_intents(owner_id,workspace_id,soul_id) WHERE kind='automatic_primary';
            CREATE TRIGGER IF NOT EXISTS souls_inventory_insert AFTER INSERT ON souls BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
            CREATE TRIGGER IF NOT EXISTS souls_inventory_update AFTER UPDATE ON souls BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
            CREATE TRIGGER IF NOT EXISTS souls_inventory_delete AFTER DELETE ON souls BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
            CREATE TRIGGER IF NOT EXISTS incarnations_inventory_insert AFTER INSERT ON incarnations BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
            CREATE TRIGGER IF NOT EXISTS incarnations_inventory_update AFTER UPDATE ON incarnations BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
            CREATE TRIGGER IF NOT EXISTS incarnations_inventory_delete AFTER DELETE ON incarnations BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
            CREATE TRIGGER IF NOT EXISTS view_intents_inventory_insert AFTER INSERT ON view_intents BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
            CREATE TRIGGER IF NOT EXISTS view_intents_inventory_update AFTER UPDATE ON view_intents BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
            CREATE TRIGGER IF NOT EXISTS view_intents_inventory_delete AFTER DELETE ON view_intents BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
            UPDATE souls SET configured_limits=(SELECT requested_limits FROM incarnations i WHERE i.soul_id=souls.soul_id ORDER BY i.created_at DESC LIMIT 1) WHERE configured_limits IS NULL;
            UPDATE installation SET schema_version=5,inventory_revision=inventory_revision+1 WHERE singleton=1;
            "#,
        )?;
        tx.commit()?;
        schema = 5;
    }
    if schema == 5 {
        let add_loss_incident_id = !column_exists(conn, "souls", "loss_incident_id")?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if add_loss_incident_id {
            tx.execute_batch("ALTER TABLE souls ADD COLUMN loss_incident_id TEXT;")?;
        }
        tx.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS loss_incidents (
                incident_id TEXT PRIMARY KEY,
                correlation_id TEXT NOT NULL,
                soul_id TEXT NOT NULL REFERENCES souls(soul_id),
                incarnation_id TEXT NOT NULL REFERENCES incarnations(incarnation_id),
                provider TEXT NOT NULL,
                provider_store_id TEXT NOT NULL,
                native_session_ref_hash TEXT NOT NULL,
                intent_revision INTEGER NOT NULL,
                decision_state TEXT NOT NULL,
                reason_code TEXT NOT NULL,
                certificate_json TEXT NOT NULL,
                cleanup_state TEXT NOT NULL,
                cleanup_json TEXT NOT NULL,
                observed_cause TEXT NOT NULL,
                missing_invariant TEXT NOT NULL,
                hypotheses_json TEXT NOT NULL,
                preventive_action TEXT NOT NULL,
                regression_case TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                closed_at INTEGER
            );
            CREATE UNIQUE INDEX IF NOT EXISTS one_loss_incident_per_soul_revision ON loss_incidents(soul_id,intent_revision);
            CREATE TABLE IF NOT EXISTS runtime_notices (
                notice_id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                message TEXT NOT NULL,
                reference TEXT NOT NULL,
                incident_ids_json TEXT NOT NULL,
                superseded_by TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS notice_receipts (
                notice_id TEXT NOT NULL REFERENCES runtime_notices(notice_id),
                profile_id TEXT NOT NULL,
                state TEXT NOT NULL,
                rendered_at INTEGER,
                acknowledged_at INTEGER,
                dismissed_at INTEGER,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY(notice_id,profile_id)
            );
            CREATE TABLE IF NOT EXISTS runtime_counters (
                name TEXT NOT NULL,
                label TEXT NOT NULL,
                value INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY(name,label)
            );
            CREATE TABLE IF NOT EXISTS rollout_state (
                singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                mode TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS migration_runs (
                migration_id TEXT PRIMARY KEY,
                current_mode TEXT NOT NULL,
                requested_mode TEXT NOT NULL,
                dry_run INTEGER NOT NULL,
                plan_json TEXT NOT NULL,
                backup_path TEXT,
                applied_at INTEGER,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS repair_audits (
                audit_id TEXT PRIMARY KEY,
                audit_json TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            INSERT OR IGNORE INTO rollout_state (singleton,mode,updated_at) VALUES (1,'legacy',0);
            UPDATE installation SET schema_version=6,inventory_revision=inventory_revision+1 WHERE singleton=1;
            "#,
        )?;
        tx.commit()?;
        schema = 6;
    }
    if schema == 6 {
        // Downgrade/restore drills can leave additive columns in place while
        // restoring an older installation version. Keep this migration
        // idempotent so opening that registry never destroys existing souls.
        let add_fresh_agent_spec = !column_exists(conn, "incarnations", "fresh_agent_spec")?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if add_fresh_agent_spec {
            tx.execute_batch("ALTER TABLE incarnations ADD COLUMN fresh_agent_spec TEXT;")?;
        }
        tx.execute_batch(
            "UPDATE installation SET schema_version=7,inventory_revision=inventory_revision+1 WHERE singleton=1;",
        )?;
        tx.commit()?;
        schema = 7;
    }
    if schema == 7 {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        input_reservation::create_table(&tx)?;
        tx.execute_batch("UPDATE installation SET schema_version=8 WHERE singleton=1;")?;
        tx.commit()?;
        schema = 8;
    }
    if schema == 8 {
        let add_provider = !column_exists(conn, "provider_input_preparations", "provider")?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if add_provider {
            tx.execute_batch("ALTER TABLE provider_input_preparations ADD COLUMN provider TEXT NOT NULL DEFAULT 'opencode';")?;
        }
        tx.execute_batch("UPDATE installation SET schema_version=9 WHERE singleton=1;")?;
        tx.commit()?;
        schema = 9;
    }
    if schema == 9 {
        let add_pending = !column_exists(conn, "incarnations", "provider_preparation_pending")?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if add_pending {
            tx.execute_batch("ALTER TABLE incarnations ADD COLUMN provider_preparation_pending INTEGER NOT NULL DEFAULT 0;")?;
        }
        // Legacy Running does not prove resumed native acceptance.
        tx.execute_batch("UPDATE installation SET schema_version=10 WHERE singleton=1;")?;
        tx.commit()?;
        schema = 10;
    }
    if schema == 10 {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        for (table, column, definition) in [
            ("souls", "identity_revision", "INTEGER NOT NULL DEFAULT 0"),
            (
                "souls",
                "native_import_revision",
                "INTEGER NOT NULL DEFAULT 0",
            ),
            (
                "souls",
                "native_import_state",
                "TEXT NOT NULL DEFAULT 'legacy_unknown'",
            ),
            ("souls", "native_import_source_store_id", "TEXT"),
            ("souls", "native_import_root_session_id", "TEXT"),
            ("souls", "native_import_source_generation", "TEXT"),
            ("souls", "native_import_schema_fingerprint", "TEXT"),
            ("souls", "native_import_migration_fingerprint", "TEXT"),
            (
                "souls",
                "native_import_complete_inventory",
                "INTEGER NOT NULL DEFAULT 0",
            ),
            (
                "souls",
                "native_import_authority",
                "TEXT NOT NULL DEFAULT 'legacy_unknown'",
            ),
            ("loss_incidents", "captured_control_epoch", "INTEGER"),
            ("loss_incidents", "captured_identity_revision", "INTEGER"),
            ("loss_incidents", "captured_evidence_revision", "INTEGER"),
            (
                "loss_incidents",
                "captured_native_import_revision",
                "INTEGER",
            ),
            ("loss_incidents", "captured_native_import_state", "TEXT"),
            ("loss_incidents", "captured_source_store_id", "TEXT"),
            ("loss_incidents", "captured_root_session_id", "TEXT"),
            ("loss_incidents", "captured_source_generation", "TEXT"),
            (
                "loss_incidents",
                "captured_source_schema_fingerprint",
                "TEXT",
            ),
            ("loss_incidents", "captured_migration_fingerprint", "TEXT"),
            (
                "loss_incidents",
                "captured_native_import_complete",
                "INTEGER",
            ),
            ("loss_incidents", "captured_native_import_authority", "TEXT"),
        ] {
            if !column_exists(&tx, table, column)? {
                tx.execute_batch(&format!(
                    "ALTER TABLE {table} ADD COLUMN {column} {definition};"
                ))?;
            }
        }
        tx.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS native_origin_owners (
                provider TEXT NOT NULL,
                source_store_id TEXT NOT NULL,
                native_root_session_id TEXT NOT NULL,
                owner_soul_id TEXT REFERENCES souls(soul_id),
                source_generation TEXT,
                ownership_state TEXT NOT NULL CHECK (ownership_state IN ('owned','ambiguous')),
                updated_at INTEGER NOT NULL,
                PRIMARY KEY(provider,source_store_id,native_root_session_id)
            );
            UPDATE installation SET schema_version=11,inventory_revision=inventory_revision+1 WHERE singleton=1;
            "#,
        )?;
        backfill_native_import_ownership(&tx)?;
        tx.execute_batch(
            r#"
            UPDATE loss_incidents SET
                captured_control_epoch=COALESCE(captured_control_epoch,(SELECT control_epoch FROM installation WHERE singleton=1)),
                captured_identity_revision=COALESCE(captured_identity_revision,(SELECT identity_revision FROM souls WHERE souls.soul_id=loss_incidents.soul_id)),
                captured_evidence_revision=COALESCE(captured_evidence_revision,(SELECT evidence_revision FROM souls WHERE souls.soul_id=loss_incidents.soul_id)),
                captured_native_import_revision=COALESCE(captured_native_import_revision,(SELECT native_import_revision FROM souls WHERE souls.soul_id=loss_incidents.soul_id)),
                captured_native_import_state=COALESCE(captured_native_import_state,(SELECT native_import_state FROM souls WHERE souls.soul_id=loss_incidents.soul_id)),
                captured_source_store_id=COALESCE(captured_source_store_id,(SELECT native_import_source_store_id FROM souls WHERE souls.soul_id=loss_incidents.soul_id)),
                captured_root_session_id=COALESCE(captured_root_session_id,(SELECT native_import_root_session_id FROM souls WHERE souls.soul_id=loss_incidents.soul_id)),
                captured_source_generation=COALESCE(captured_source_generation,(SELECT native_import_source_generation FROM souls WHERE souls.soul_id=loss_incidents.soul_id)),
                captured_source_schema_fingerprint=COALESCE(captured_source_schema_fingerprint,(SELECT native_import_schema_fingerprint FROM souls WHERE souls.soul_id=loss_incidents.soul_id)),
                captured_migration_fingerprint=COALESCE(captured_migration_fingerprint,(SELECT native_import_migration_fingerprint FROM souls WHERE souls.soul_id=loss_incidents.soul_id)),
                captured_native_import_complete=COALESCE(captured_native_import_complete,(SELECT native_import_complete_inventory FROM souls WHERE souls.soul_id=loss_incidents.soul_id)),
                captured_native_import_authority=COALESCE(captured_native_import_authority,(SELECT native_import_authority FROM souls WHERE souls.soul_id=loss_incidents.soul_id))
            WHERE EXISTS (SELECT 1 FROM souls WHERE souls.soul_id=loss_incidents.soul_id);
            "#,
        )?;
        tx.commit()?;
        schema = 11;
    }
    if schema == 11 {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS stopped_repair_operations (
                operation_id TEXT PRIMARY KEY,
                idempotency_key TEXT NOT NULL UNIQUE,
                target_fingerprint TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('importing','withdraw_pending','complete')),
                result_json TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS stopped_repair_withdrawals (
                operation_id TEXT PRIMARY KEY REFERENCES stopped_repair_operations(operation_id),
                generation TEXT NOT NULL,
                targets_json TEXT NOT NULL,
                incident_ids_json TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('files_pending','files_complete')),
                updated_at INTEGER NOT NULL
            );
            UPDATE installation SET schema_version=12,inventory_revision=inventory_revision+1 WHERE singleton=1;
            "#,
        )?;
        tx.commit()?;
        schema = 12;
    }
    if schema == 12 {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if !column_exists(&tx, "stopped_repair_operations", "targets_json")? {
            tx.execute_batch(
                "ALTER TABLE stopped_repair_operations ADD COLUMN targets_json TEXT NOT NULL DEFAULT '[]';",
            )?;
        }
        tx.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS stopped_repair_root_receipts (
                operation_id TEXT NOT NULL REFERENCES stopped_repair_operations(operation_id),
                root_session_id TEXT NOT NULL,
                canonical_soul_id TEXT NOT NULL REFERENCES souls(soul_id),
                transfer_id TEXT NOT NULL,
                source_store_id TEXT NOT NULL,
                source_generation TEXT NOT NULL,
                identity_revision INTEGER NOT NULL,
                intent_revision INTEGER NOT NULL,
                native_import_revision INTEGER NOT NULL,
                active_incarnation_id TEXT NOT NULL REFERENCES incarnations(incarnation_id),
                execution_generation INTEGER NOT NULL,
                import_receipt_json TEXT NOT NULL,
                readable_receipt_json TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('verified')),
                updated_at INTEGER NOT NULL,
                PRIMARY KEY(operation_id,root_session_id)
            );
            UPDATE installation SET schema_version=13,inventory_revision=inventory_revision+1 WHERE singleton=1;
            "#,
        )?;
        tx.commit()?;
        schema = 13;
    }
    if schema == 13 {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if !column_exists(&tx, "stopped_repair_operations", "scope_json")? {
            tx.execute_batch("ALTER TABLE stopped_repair_operations ADD COLUMN scope_json TEXT;")?;
        }
        if !column_exists(&tx, "stopped_repair_operations", "owner_choices_json")? {
            tx.execute_batch("ALTER TABLE stopped_repair_operations ADD COLUMN owner_choices_json TEXT NOT NULL DEFAULT '[]';")?;
        }
        tx.execute_batch("UPDATE installation SET schema_version=14,inventory_revision=inventory_revision+1 WHERE singleton=1;")?;
        tx.commit()?;
        schema = 14;
    }
    if schema == 14 {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if !column_exists(&tx, "incarnations", "launch_policy")? {
            tx.execute_batch("ALTER TABLE incarnations ADD COLUMN launch_policy TEXT;")?;
        }
        tx.execute_batch("UPDATE installation SET schema_version=15,inventory_revision=inventory_revision+1 WHERE singleton=1;")?;
        tx.commit()?;
        schema = 15;
    }
    if schema == 15 {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        for column in ["native_identity_launch", "native_identity_observation"] {
            if !column_exists(&tx, "incarnations", column)? {
                tx.execute_batch(&format!(
                    "ALTER TABLE incarnations ADD COLUMN {column} TEXT;"
                ))?;
            }
        }
        tx.execute_batch("UPDATE installation SET schema_version=16,inventory_revision=inventory_revision+1 WHERE singleton=1;")?;
        tx.commit()?;
        schema = 16;
    }
    if schema == 16 {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if !column_exists(&tx, "souls", "claude_fork_recipe")? {
            tx.execute_batch("ALTER TABLE souls ADD COLUMN claude_fork_recipe TEXT;")?;
        }
        tx.execute_batch("UPDATE installation SET schema_version=17,inventory_revision=inventory_revision+1 WHERE singleton=1;")?;
        tx.commit()?;
        schema = 17;
    }
    if schema == 17 {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        create_recovery_retry_schema(&tx)?;
        tx.execute_batch("UPDATE installation SET schema_version=18,inventory_revision=inventory_revision+1 WHERE singleton=1;")?;
        tx.commit()?;
        schema = 18;
    }
    if schema == 18 {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        create_ordinary_stop_schema(&tx)?;
        migrate_ordinary_stops(&tx)?;
        tx.execute_batch("UPDATE installation SET schema_version=19,inventory_revision=inventory_revision+1 WHERE singleton=1;")?;
        tx.commit()?;
        schema = 19;
    }
    if schema != SCHEMA_VERSION {
        return Err(RegistryError::Integrity(format!(
            "unsupported older schema {schema}"
        )));
    }
    durable_sync_parent(conn.path().map(Path::new).and_then(Path::parent))?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct NativeOriginKey {
    provider: String,
    source_store_id: String,
    root_session_id: String,
}

fn backfill_native_import_ownership(tx: &rusqlite::Transaction<'_>) -> Result<(), RegistryError> {
    let souls = {
        let mut statement = tx.prepare(
            "SELECT soul_id,provider,provider_store_id,native_session_id FROM souls ORDER BY soul_id",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    let mut origin_owners: BTreeMap<NativeOriginKey, BTreeSet<(String, Option<String>)>> =
        BTreeMap::new();

    for (soul_id, provider, _provider_store_id, _native_session_id) in souls {
        tx.execute(
            "UPDATE souls SET identity_revision=CASE WHEN native_session_id IS NULL THEN 0 ELSE 1 END WHERE soul_id=?1",
            params![soul_id],
        )?;
        if provider != "opencode" {
            tx.execute(
                "UPDATE souls SET native_import_state='not_applicable',native_import_authority='no_import_configured' WHERE soul_id=?1",
                params![soul_id],
            )?;
            continue;
        }

        let raw_specs = {
            let mut statement = tx.prepare(
                "SELECT terminal_spec FROM incarnations WHERE soul_id=?1 AND terminal_spec IS NOT NULL",
            )?;
            let rows = statement
                .query_map(params![soul_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        let mut descriptors =
            BTreeMap::<NativeOriginKey, BTreeSet<(String, String, String)>>::new();
        for raw in raw_specs {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
                continue;
            };
            let Some(raw_descriptor) = value.get("opencodeTransfer") else {
                continue;
            };
            let Ok(descriptor) =
                serde_json::from_value::<OpenCodeTransferDescriptor>(raw_descriptor.clone())
            else {
                continue;
            };
            if descriptor.validate().is_err() {
                continue;
            }
            let key = NativeOriginKey {
                provider: descriptor.provider.clone(),
                source_store_id: descriptor.source_store_id.clone(),
                root_session_id: descriptor.root_session_id.clone(),
            };
            descriptors.entry(key).or_default().insert((
                descriptor.source_generation,
                descriptor.source_schema_fingerprint,
                descriptor.migration_journal_fingerprint,
            ));
        }

        if descriptors.is_empty() {
            tx.execute(
                "UPDATE souls SET native_import_state='legacy_unknown',native_import_source_store_id=NULL,native_import_root_session_id=NULL,native_import_source_generation=NULL,native_import_schema_fingerprint=NULL,native_import_migration_fingerprint=NULL,native_import_complete_inventory=0,native_import_authority='legacy_unknown' WHERE soul_id=?1",
                params![soul_id],
            )?;
            continue;
        }

        let single_descriptor = (descriptors.len() == 1)
            .then(|| descriptors.iter().next())
            .flatten()
            .filter(|(_, values)| values.len() == 1);
        if let Some((key, values)) = single_descriptor {
            let (generation, schema_fingerprint, migration_fingerprint) =
                values.iter().next().expect("one descriptor generation");
            tx.execute(
                "UPDATE souls SET native_import_state='legacy_unknown',native_import_source_store_id=?1,native_import_root_session_id=?2,native_import_source_generation=?3,native_import_schema_fingerprint=?4,native_import_migration_fingerprint=?5,native_import_authority='legacy_unknown' WHERE soul_id=?6",
            params![key.source_store_id, key.root_session_id, generation, schema_fingerprint, migration_fingerprint, soul_id],
        )?;
        } else {
            tx.execute(
                "UPDATE souls SET native_import_state='legacy_unknown',native_import_authority='ambiguous_legacy_origin' WHERE soul_id=?1",
                params![soul_id],
            )?;
        }
        for (key, values) in descriptors {
            for (generation, _, _) in values {
                origin_owners
                    .entry(key.clone())
                    .or_default()
                    .insert((soul_id.clone(), Some(generation)));
            }
        }
    }

    for (key, candidates) in origin_owners {
        let soul_owners = candidates
            .iter()
            .map(|(soul_id, _)| soul_id.clone())
            .collect::<BTreeSet<_>>();
        let generations = candidates
            .iter()
            .filter_map(|(_, generation)| generation.clone())
            .collect::<BTreeSet<_>>();
        let is_unambiguous = soul_owners.len() == 1;
        let owner_soul_id = is_unambiguous
            .then(|| soul_owners.iter().next().cloned())
            .flatten();
        let generation = (is_unambiguous && generations.len() == 1)
            .then(|| generations.iter().next().cloned())
            .flatten();
        tx.execute(
            "INSERT OR REPLACE INTO native_origin_owners (provider,source_store_id,native_root_session_id,owner_soul_id,source_generation,ownership_state,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![key.provider, key.source_store_id, key.root_session_id, owner_soul_id, generation, if is_unambiguous { "owned" } else { "ambiguous" }, now_millis()],
        )?;
        if !is_unambiguous {
            for soul_id in soul_owners {
                tx.execute(
                    "UPDATE souls SET native_import_state='legacy_unknown',native_import_source_store_id=NULL,native_import_root_session_id=NULL,native_import_source_generation=NULL,native_import_schema_fingerprint=NULL,native_import_migration_fingerprint=NULL,native_import_complete_inventory=0,native_import_authority='ambiguous_legacy_origin' WHERE soul_id=?1",
                    params![soul_id],
                )?;
            }
        }
    }
    Ok(())
}

fn claim_native_origin_in_tx(
    tx: &rusqlite::Transaction<'_>,
    provider: &str,
    source_store_id: &str,
    root_session_id: &str,
    soul_id: &SoulId,
    generation: Option<&str>,
) -> Result<(), RegistryError> {
    let existing: Option<(Option<String>, Option<String>, String)> = tx
        .query_row(
            "SELECT owner_soul_id,source_generation,ownership_state FROM native_origin_owners WHERE provider=?1 AND source_store_id=?2 AND native_root_session_id=?3",
            params![provider, source_store_id, root_session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    match existing {
        None => {
            tx.execute(
                "INSERT INTO native_origin_owners (provider,source_store_id,native_root_session_id,owner_soul_id,source_generation,ownership_state,updated_at) VALUES (?1,?2,?3,?4,?5,'owned',?6)",
                params![provider, source_store_id, root_session_id, soul_id.as_str(), generation, now_millis()],
            )?;
        }
        Some((Some(owner), prior_generation, state))
            if owner == soul_id.as_str() && state == "owned" =>
        {
            if generation.is_some() && prior_generation.as_deref() != generation {
                tx.execute(
                    "UPDATE native_origin_owners SET source_generation=?1,updated_at=?2 WHERE provider=?3 AND source_store_id=?4 AND native_root_session_id=?5 AND owner_soul_id=?6 AND ownership_state='owned'",
                    params![generation, now_millis(), provider, source_store_id, root_session_id, soul_id.as_str()],
                )?;
            }
        }
        _ => return Err(RegistryError::NativeIdentityConflict),
    }
    Ok(())
}

fn is_lower_hex_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn load_recovery_write_fence(
    conn: &Connection,
    soul_id: &SoulId,
) -> Result<RecoveryWriteFence, RegistryError> {
    let row: (
        u64,
        u64,
        u64,
        u64,
        u64,
        Option<String>,
        Option<String>,
    ) = conn
        .query_row(
            &format!(
                "SELECT installation.control_epoch,souls.intent_revision,souls.identity_revision,souls.evidence_revision,souls.native_import_revision,souls.recovery_attempt_id,(SELECT incarnation_id FROM incarnations WHERE soul_id=souls.soul_id AND launch_state IN ({ACTIVE_STATES}) ORDER BY CASE WHEN launch_state IN ({ACTIVE_STATES}) THEN 0 ELSE 1 END,created_at DESC LIMIT 1) FROM souls JOIN installation ON installation.singleton=1 WHERE souls.soul_id=?1"
            ),
            params![soul_id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
        )
        .optional()?
        .ok_or_else(|| RegistryError::UnknownSoul(soul_id.clone()))?;
    let active_incarnation_id = row.6.ok_or_else(|| {
        RegistryError::InvalidState(format!("soul {soul_id} has no active incarnation"))
    })?;
    Ok(RecoveryWriteFence {
        control_epoch: row.0,
        intent_revision: row.1,
        identity_revision: row.2,
        evidence_revision: row.3,
        native_import_revision: row.4,
        recovery_attempt_id: row
            .5
            .map(RecoveryAttemptId::parse)
            .transpose()
            .map_err(|_| RegistryError::Integrity("invalid recovery attempt id".into()))?,
        active_incarnation_id: IncarnationId::parse(active_incarnation_id)
            .map_err(|_| RegistryError::Integrity("invalid active incarnation id".into()))?,
    })
}

fn validate_recovery_context_fence(
    tx: &rusqlite::Transaction<'_>,
    soul_id: &SoulId,
    fence: &RecoveryWriteFence,
) -> Result<(), RegistryError> {
    validate_recovery_revision_fence(tx, soul_id, fence)?;
    let latest = load_recovery_prior_incarnation(tx, soul_id, false)?;
    if latest != fence.active_incarnation_id {
        return Err(RegistryError::InvalidState(
            "recovery observation incarnation changed".into(),
        ));
    }
    Ok(())
}

fn load_recovery_prior_incarnation(
    conn: &Connection,
    soul_id: &SoulId,
    require_committed_ownership: bool,
) -> Result<IncarnationId, RegistryError> {
    // A retired, unowned replacement never became the recovery prior. All
    // other rows still fence observations, including a newer PREPARED or
    // unowned stopped row; only handle loading requires committed ownership.
    let incarnation: String = conn
        .query_row(
            &format!(
                "SELECT incarnation_id FROM incarnations WHERE soul_id=?1
                 AND NOT (launch_state='failed' AND cleanup_state='termination_unconfirmed'
                          AND prior_incarnation_id IS NOT NULL
                          AND docker_daemon_id IS NULL AND container_id IS NULL)
                 AND (NOT ?2 OR (docker_daemon_id IS NOT NULL AND container_id IS NOT NULL
                          AND image_ref IS NOT NULL AND runtime_dir IS NOT NULL
                          AND host_binary_path IS NOT NULL AND immutable_config_digest IS NOT NULL))
                 ORDER BY CASE WHEN launch_state IN ({ACTIVE_STATES}) THEN 0 ELSE 1 END,
                          created_at DESC,rowid DESC LIMIT 1"
            ),
            params![soul_id.as_str(), require_committed_ownership],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| RegistryError::InvalidState(format!("soul {soul_id} has no incarnation")))?;
    IncarnationId::parse(incarnation)
        .map_err(|_| RegistryError::Integrity("invalid incarnation id".into()))
}

pub(crate) fn deterministic_fresh_agent_fixture(
    provider: &str,
    agent: &FreshAgentLaunchSpec,
) -> bool {
    agent.fixture_transport
        == Some(freshell_runtime_protocol::FreshAgentFixtureTransport::Deterministic)
        && agent.provider.as_str() == provider
        && matches!(
            (&agent.provider, agent.session_type.as_str()),
            (
                freshell_runtime_protocol::FreshProvider::Claude,
                "freshclaude"
            ) | (freshell_runtime_protocol::FreshProvider::Kilroy, "kilroy")
                | (
                    freshell_runtime_protocol::FreshProvider::Codex,
                    "freshcodex"
                )
                | (
                    freshell_runtime_protocol::FreshProvider::Opencode,
                    "freshopencode"
                )
        )
}

#[cfg(test)]
mod deterministic_fixture_admission_tests {
    use super::*;

    #[tokio::test]
    async fn fixture_live_admission_requires_exact_supported_transport_and_mode() {
        let directory = tempfile::tempdir().unwrap();
        let registry = Registry::open(directory.path().join("registry"), None).unwrap();
        let soul = SoulId::new();
        let prepared = tests::materialize_test_runtime(&registry, soul.clone()).await;
        let connection =
            Connection::open(directory.path().join("registry/runtime.sqlite3")).unwrap();
        for (provider, mode) in [
            ("claude", "freshclaude"),
            ("kilroy", "kilroy"),
            ("codex", "freshcodex"),
            ("opencode", "freshopencode"),
        ] {
            let spec = serde_json::json!({"sessionId":"owned-fixture","provider":provider,"sessionType":mode,
                "runtimeVariant":"fixture-test","providerStoreId":"owned-store","cwd":"/owned","workspacePath":"/owned",
                "runAsUid":65534,"runAsGid":0,"fixtureTransport":"deterministic"});
            connection
                .execute(
                    "UPDATE souls SET provider=?1 WHERE soul_id=?2",
                    params![provider, soul.as_str()],
                )
                .unwrap();
            connection.execute("UPDATE incarnations SET fixture_kind=NULL,fresh_agent_spec=?1,native_identity_observation=NULL WHERE incarnation_id=?2",
                params![spec.to_string(),prepared.incarnation_id.as_str()]).unwrap();
            validate_live_native_observation(&connection, &soul, &prepared.incarnation_id).unwrap();
            for fault in [
                "genuine",
                "wrong-mode",
                "wrong-provider",
                "unknown-transport",
            ] {
                let mut changed = spec.clone();
                match fault {
                    "genuine" => {
                        changed.as_object_mut().unwrap().remove("fixtureTransport");
                    }
                    "wrong-mode" => changed["sessionType"] = "unregistered-mode".into(),
                    "wrong-provider" => {
                        changed["provider"] = if provider == "claude" {
                            "codex"
                        } else {
                            "claude"
                        }
                        .into()
                    }
                    "unknown-transport" => {
                        changed["fixtureTransport"] = "unregistered-fixture".into()
                    }
                    _ => unreachable!(),
                }
                connection
                    .execute(
                        "UPDATE incarnations SET fresh_agent_spec=?1 WHERE incarnation_id=?2",
                        params![changed.to_string(), prepared.incarnation_id.as_str()],
                    )
                    .unwrap();
                assert!(
                    validate_live_native_observation(&connection, &soul, &prepared.incarnation_id)
                        .is_err(),
                    "{provider}/{fault}"
                );
            }
        }
    }
}

fn validate_live_native_observation(
    conn: &Connection,
    soul: &SoulId,
    incarnation: &IncarnationId,
) -> Result<(), RegistryError> {
    let (provider,root,fresh,fixture,launch,observation,generation,nonce):
        LiveNativeObservationRow=conn.query_row(
        "SELECT s.provider,s.native_session_id,i.fresh_agent_spec,i.fixture_kind,i.native_identity_launch,i.native_identity_observation,i.execution_generation,i.launch_nonce FROM souls s JOIN incarnations i ON i.soul_id=s.soul_id WHERE s.soul_id=?1 AND i.incarnation_id=?2",
        params![soul.as_str(),incarnation.as_str()],|row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?)))?;
    let deterministic_fresh = fresh
        .as_deref()
        .map(serde_json::from_str::<FreshAgentLaunchSpec>)
        .transpose()?
        .as_ref()
        .is_some_and(|agent| deterministic_fresh_agent_fixture(&provider, agent));
    if fixture.is_some()
        || deterministic_fresh
        || !matches!(
            provider.as_str(),
            "claude" | "kilroy" | "codex" | "opencode" | "amplifier"
        )
    {
        return Ok(());
    }
    let Some((launch, observation)) = launch.zip(observation) else {
        return Err(RegistryError::RecoveryBlocked {
            soul_id: soul.clone(),
            reason: "NATIVE_IDENTITY_UNOBSERVED".into(),
        });
    };
    let launch: freshell_runtime_protocol::NativeIdentityLaunch = serde_json::from_str(&launch)?;
    let observation: freshell_runtime_protocol::NativeIdentityObservation =
        serde_json::from_str(&observation)?;
    if !observation.matches_launch(&launch)
        || !observation.matches_provider(&provider, fresh.is_some())
        || observation.incarnation_id != *incarnation
        || root.as_deref() != Some(observation.native_session_id.as_str())
        || launch.execution_generation != generation
        || launch.launch_nonce != nonce
    {
        return Err(RegistryError::NativeIdentityConflict);
    }
    Ok(())
}

fn invalidate_claude_fork_recovery(
    tx: &rusqlite::Transaction<'_>,
    soul_id: &SoulId,
) -> Result<(), RegistryError> {
    let current: Option<String> = tx.query_row(
        "SELECT claude_fork_recipe FROM souls WHERE soul_id=?1",
        params![soul_id.as_str()],
        |row| row.get(0),
    )?;
    if let Some(raw) = current {
        let mut recipe: freshell_runtime_protocol::ClaudeForkRecipe = serde_json::from_str(&raw)?;
        recipe.recovery_disabled = true;
        tx.execute("UPDATE souls SET claude_fork_recipe=?3,resume_spec=NULL,durability_state='live_only',allocation_state='materializing',updated_at=?2 WHERE soul_id=?1", params![soul_id.as_str(), now_millis(), serde_json::to_string(&recipe)?])?;
    }
    Ok(())
}

fn validate_recovery_write_fence(
    tx: &rusqlite::Transaction<'_>,
    soul_id: &SoulId,
    fence: &RecoveryWriteFence,
) -> Result<(), RegistryError> {
    validate_recovery_revision_fence(tx, soul_id, fence)?;
    let incarnation: Option<String> = tx
        .query_row(
            "SELECT incarnation_id FROM incarnations WHERE soul_id=?1 AND launch_state IN ('prepared','created','starting','running','stopping') ORDER BY CASE WHEN launch_state IN ('prepared','created','starting','running','stopping') THEN 0 ELSE 1 END,created_at DESC LIMIT 1",
            params![soul_id.as_str()],
            |row| row.get(0),
        )
        .optional()?;
    if incarnation.as_deref() != Some(fence.active_incarnation_id.as_str()) {
        return Err(RegistryError::InvalidState(
            "stale recovery write fence; active incarnation changed".into(),
        ));
    }
    Ok(())
}

fn validate_recovery_resume_capture_fence(
    tx: &rusqlite::Transaction<'_>,
    soul_id: &SoulId,
    fence: &RecoveryWriteFence,
) -> Result<(), RegistryError> {
    // Latest exact incarnation plus every revision, RUNNING intent and the
    // current reservation remain mandatory even when no active row exists.
    validate_recovery_context_fence(tx, soul_id, fence)?;
    let (state, cleanup): (String, String) = tx.query_row(
        "SELECT launch_state,cleanup_state FROM incarnations WHERE soul_id=?1 AND incarnation_id=?2",
        params![soul_id.as_str(), fence.active_incarnation_id.as_str()],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if parse_launch_state(&state)?.is_potentially_active() {
        return validate_recovery_write_fence(tx, soul_id, fence);
    }
    let conflicting_owner: bool = tx.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM incarnations WHERE soul_id=?1 AND launch_state IN ({ACTIVE_STATES})) OR EXISTS(SELECT 1 FROM writer_claims w JOIN souls s ON s.soul_id=?1 WHERE w.soul_id=s.soul_id OR (w.provider=s.provider AND w.provider_store_id=s.provider_store_id AND w.native_session_id=s.native_session_id))"),
        [soul_id.as_str()], |row| row.get(0),
    )?;
    if state != "stopped" || cleanup != "verified_empty" || conflicting_owner {
        return Err(RegistryError::InvalidState(
            "resume capture needs the latest verified-empty prior with no pending writer".into(),
        ));
    }
    Ok(())
}

fn validate_recovery_revision_fence(
    tx: &rusqlite::Transaction<'_>,
    soul_id: &SoulId,
    fence: &RecoveryWriteFence,
) -> Result<(), RegistryError> {
    let current: Option<RecoveryRevisionFenceRow> = tx
        .query_row(
            "SELECT installation.control_epoch,souls.intent_revision,souls.identity_revision,souls.evidence_revision,souls.native_import_revision,souls.recovery_attempt_id,souls.desired_state FROM souls JOIN installation ON installation.singleton=1 WHERE souls.soul_id=?1",
            params![soul_id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
        )
        .optional()?;
    let Some((epoch, intent, identity, evidence, import, attempt, desired)) = current else {
        return Err(RegistryError::UnknownSoul(soul_id.clone()));
    };
    if epoch != fence.control_epoch {
        return Err(RegistryError::StaleControlEpoch {
            expected: fence.control_epoch,
            current: epoch,
        });
    }
    if intent != fence.intent_revision {
        return Err(RegistryError::StaleIntentRevision {
            expected: fence.intent_revision,
            current: intent,
        });
    }
    let attempt_matches = match (&fence.recovery_attempt_id, attempt.as_deref()) {
        (None, None) => true,
        (Some(expected), Some(current)) => expected.as_str() == current,
        _ => false,
    };
    if identity != fence.identity_revision
        || evidence != fence.evidence_revision
        || import != fence.native_import_revision
        || !attempt_matches
        || desired != "running"
    {
        return Err(RegistryError::InvalidState(
            "stale recovery write fence; identity, evidence, import, attempt, or intent changed"
                .into(),
        ));
    }
    Ok(())
}

fn verify_schema_and_integrity(conn: &Connection) -> Result<(), RegistryError> {
    let schema: u32 = conn.query_row(
        "SELECT schema_version FROM installation WHERE singleton=1",
        [],
        |row| row.get(0),
    )?;
    if schema > SCHEMA_VERSION {
        return Err(RegistryError::NewerSchema {
            found: schema,
            supported: SCHEMA_VERSION,
        });
    }
    if schema != SCHEMA_VERSION {
        return Err(RegistryError::Integrity(format!(
            "unsupported older schema {schema}; migration missing"
        )));
    }
    let integrity: String = conn.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    if integrity != "ok" {
        return Err(RegistryError::Integrity(integrity));
    }
    Ok(())
}

fn load_prepared_row(
    conn: &Connection,
    incarnation_id: &IncarnationId,
) -> Result<PreparedLaunch, RegistryError> {
    let raw: (String, String, String, u64) = conn.query_row(
        "SELECT i.soul_id,i.launch_nonce,i.launch_state,s.intent_revision FROM incarnations i JOIN souls s ON s.soul_id=i.soul_id WHERE i.incarnation_id=?1",
        params![incarnation_id.as_str()],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    Ok(PreparedLaunch {
        soul_id: SoulId::parse(raw.0)
            .map_err(|_| RegistryError::Integrity("invalid soul id".into()))?,
        incarnation_id: incarnation_id.clone(),
        launch_nonce: LaunchNonce::parse(raw.1)
            .map_err(|_| RegistryError::Integrity("invalid launch nonce".into()))?,
        state: parse_launch_state(&raw.2)?,
        intent_revision: raw.3,
        existing_request: true,
    })
}

const ACCEPTED_INCARNATION_REF: &str = "accepted-incarnation://";

fn load_retained_incarnation(
    conn: &Connection,
    soul_id: &SoulId,
) -> Result<IncarnationId, RegistryError> {
    type AcceptedAttempt = (String, String, Option<String>, i64, i64);
    let accepted: Option<AcceptedAttempt> = conn.query_row(
        "SELECT attempt_id,prior_incarnation_id,evidence_ref,started_at,finished_at FROM recovery_attempts WHERE soul_id=?1 AND verdict='succeeded' AND finished_at IS NOT NULL ORDER BY rowid DESC LIMIT 1",
        [soul_id.as_str()],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    ).optional()?;
    let candidates = if let Some((attempt, prior, evidence, started, finished)) = accepted {
        let exact = evidence
            .map(|value| serde_json::from_str::<Vec<String>>(&value))
            .transpose()?
            .unwrap_or_default()
            .into_iter()
            .find_map(|value| {
                value
                    .strip_prefix(ACCEPTED_INCARNATION_REF)
                    .map(str::to_owned)
            });
        if let Some(exact) = exact {
            let belongs: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM incarnations WHERE incarnation_id=?1 AND soul_id=?2 AND prior_incarnation_id=?3)",
                params![exact, soul_id.as_str(), prior], |row| row.get(0),
            )?;
            if !belongs {
                return Err(RegistryError::Integrity(
                    "accepted retained incarnation relationship is missing".into(),
                ));
            }
            vec![exact]
        } else {
            // Older success rows lack the acceptance reference. Their original
            // attempt link is sufficient when preserved. begin_recovery can
            // overwrite that link on the accepted prior, so otherwise require
            // one child created within this successful attempt's interval.
            // Spool existence and current launch state are never acceptance.
            let mut stmt = conn.prepare("SELECT incarnation_id FROM incarnations WHERE soul_id=?1 AND prior_incarnation_id=?2 AND recovery_attempt_id=?3")?;
            let linked = stmt
                .query_map(params![soul_id.as_str(), prior, attempt], |row| {
                    row.get::<_, String>(0)
                })?
                .collect::<Result<Vec<_>, _>>()?;
            if linked.is_empty() {
                let mut stmt = conn.prepare("SELECT incarnation_id FROM incarnations WHERE soul_id=?1 AND prior_incarnation_id=?2 AND created_at BETWEEN ?3 AND ?4")?;
                let candidates = stmt
                    .query_map(params![soul_id.as_str(), prior, started, finished], |row| {
                        row.get::<_, String>(0)
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                candidates
            } else {
                linked
            }
        }
    } else {
        let mut stmt = conn.prepare("SELECT incarnation_id FROM incarnations WHERE soul_id=?1 AND prior_incarnation_id IS NULL")?;
        let candidates = stmt
            .query_map([soul_id.as_str()], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        candidates
    };
    let [raw] = candidates.as_slice() else {
        return Err(RegistryError::InvalidState(
            "retained output acceptance is missing or ambiguous; preserve runtime data and inspect the successful recovery attempt".into(),
        ));
    };
    IncarnationId::parse(raw.clone())
        .map_err(|_| RegistryError::Integrity("invalid retained incarnation id".into()))
}

pub(crate) fn load_owned_handle(
    conn: &Connection,
    installation: InstallationId,
    incarnation_id: &IncarnationId,
) -> Result<OwnedRuntimeHandle, RegistryError> {
    type OwnedRow = (
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
        String,
        Option<String>,
    );
    let raw: OwnedRow = conn.query_row(
        "SELECT i.soul_id,i.launch_nonce,i.docker_daemon_id,i.container_id,i.image_ref,i.runtime_dir,i.host_binary_path,i.immutable_config_digest,i.requested_limits,i.launch_state,i.fixture_kind,i.terminal_spec,i.fresh_agent_spec,s.provider_volume_name,s.provider_store_id,i.launch_policy FROM incarnations i JOIN souls s ON s.soul_id=i.soul_id WHERE i.incarnation_id=?1",
        params![incarnation_id.as_str()],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?,row.get(8)?,row.get(9)?,row.get(10)?,row.get(11)?,row.get(12)?,row.get(13)?,row.get(14)?,row.get(15)?)),
    ).optional()?.ok_or_else(|| RegistryError::UnknownIncarnation(incarnation_id.clone()))?;
    if raw.9 == "prepared" {
        return Err(RegistryError::InvalidState(
            "PREPARED incarnation has no mutation authority".into(),
        ));
    }
    let require = |value: Option<String>, field: &str| {
        value.ok_or_else(|| RegistryError::Integrity(format!("owned incarnation missing {field}")))
    };
    let fixture = raw.10.as_deref().map(parse_fixture_kind).transpose()?;
    let terminal = raw
        .11
        .map(|value| serde_json::from_str(&value))
        .transpose()?;
    let fresh_agent = raw
        .12
        .map(|value| serde_json::from_str(&value))
        .transpose()?;
    Ok(OwnedRuntimeHandle::from_registry(
        installation,
        SoulId::parse(raw.0).map_err(|_| RegistryError::Integrity("invalid soul id".into()))?,
        raw.14,
        incarnation_id.clone(),
        LaunchNonce::parse(raw.1)
            .map_err(|_| RegistryError::Integrity("invalid launch nonce".into()))?,
        DockerDaemonId::parse(require(raw.2, "docker_daemon_id")?)
            .map_err(|_| RegistryError::Integrity("invalid daemon id".into()))?,
        require(raw.3, "container_id")?,
        require(raw.4, "image_ref")?,
        PathBuf::from(require(raw.5, "runtime_dir")?),
        PathBuf::from(require(raw.6, "host_binary_path")?),
        require(raw.7, "immutable_config_digest")?,
        serde_json::from_str(&raw.8)?,
        fixture,
        terminal,
        fresh_agent,
        raw.13,
    )
    .with_launch_policy(
        raw.15
            .map(|value| serde_json::from_str(&value))
            .transpose()?,
    ))
}

struct StoppedRepairAdoptionBaselineLookup<'a> {
    soul_id: &'a SoulId,
    provider: &'a str,
    provider_store_id: &'a str,
    native_session_id: Option<&'a str>,
    native_import_state: &'a str,
    native_import_authority: &'a str,
    source_store_id: Option<&'a str>,
    root_session_id: Option<&'a str>,
    source_generation: Option<&'a str>,
}

fn load_stopped_repair_adoption_baseline(
    conn: &Connection,
    lookup: &StoppedRepairAdoptionBaselineLookup<'_>,
) -> Result<Option<OpenCodeAdoptionBaseline>, RegistryError> {
    if lookup.provider != "opencode"
        || lookup.native_import_state != NativeImportState::Completed.as_str()
        || lookup.native_import_authority != "verified_import_receipt"
    {
        return Ok(None);
    }
    let Some(root_session_id) = lookup.root_session_id.or(lookup.native_session_id) else {
        return Ok(None);
    };
    let mut statement = conn.prepare(
        "SELECT r.import_receipt_json FROM stopped_repair_root_receipts r \
         JOIN stopped_repair_operations o ON o.operation_id=r.operation_id \
         JOIN native_origin_owners n ON n.provider='opencode' \
          AND n.source_store_id=r.source_store_id \
          AND n.native_root_session_id=r.root_session_id \
          AND n.owner_soul_id=r.canonical_soul_id \
          AND n.source_generation=r.source_generation AND n.ownership_state='owned' \
         WHERE r.canonical_soul_id=?1 AND r.root_session_id=?2 \
          AND o.status IN ('withdraw_pending','complete') \
         ORDER BY r.updated_at DESC LIMIT 2",
    )?;
    let rows = statement
        .query_map(params![lookup.soul_id.as_str(), root_session_id], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<Result<Vec<_>, _>>()?;
    if rows.is_empty() {
        return Ok(None);
    }
    if rows.len() != 1 {
        return Err(RegistryError::Integrity(
            "repaired OpenCode soul has multiple exact adoption baselines".into(),
        ));
    }
    let receipt: StoppedRepairRootReceipt = serde_json::from_str(&rows[0])?;
    if !receipt.adoption_baseline_matches_receipt() {
        return Err(RegistryError::Integrity(
            "repaired OpenCode adoption baseline disagrees with its repair receipt".into(),
        ));
    }
    let baseline = receipt.adoption_baseline;
    let descriptor = &baseline.descriptor;
    if receipt.canonical_soul_id != *lookup.soul_id
        || receipt.root_session_id != root_session_id
        || receipt.destination_store_id != lookup.provider_store_id
        || Some(receipt.source_store_id.as_str()) != lookup.source_store_id
        || Some(receipt.source_generation.as_str()) != lookup.source_generation
        || descriptor.provider != lookup.provider
        || descriptor.destination_store_id != lookup.provider_store_id
        || descriptor.root_session_id != root_session_id
        || descriptor.source_store_id != receipt.source_store_id
        || descriptor.source_generation != receipt.source_generation
        || descriptor.bundle_sha256 != receipt.bundle_sha256
    {
        return Err(RegistryError::Integrity(
            "repaired OpenCode adoption baseline disagrees with the soul's verified import state"
                .into(),
        ));
    }
    Ok(Some(baseline))
}

fn load_recovery_context(
    conn: &Connection,
    installation: InstallationId,
    soul_id: &SoulId,
) -> Result<RecoveryContext, RegistryError> {
    type SoulRecoveryRow = (
        String,
        String,
        Option<String>,
        String,
        String,
        u64,
        String,
        String,
        String,
        u64,
        u64,
        u64,
        u64,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        bool,
        String,
        Option<String>,
        Option<String>,
        String,
        String,
        Option<i64>,
        u64,
        Option<String>,
        u64,
    );
    let row: SoulRecoveryRow = conn
        .query_row(
            "SELECT provider,provider_store_id,native_session_id,creation_seed_ref,desired_state,intent_revision,recovery_state,durability_state,allocation_state,checkpoint_revision,evidence_revision,identity_revision,native_import_revision,native_import_state,native_import_source_store_id,native_import_root_session_id,native_import_source_generation,native_import_schema_fingerprint,native_import_migration_fingerprint,native_import_complete_inventory,native_import_authority,recovery_attempt_id,resume_spec,project_key,resource_profile,recovery_window_started_at,successful_recoveries_in_window,configured_limits,(SELECT control_epoch FROM installation WHERE singleton=1) FROM souls WHERE soul_id=?1",
            params![soul_id.as_str()],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                    row.get(9)?,
                    row.get(10)?,
                    row.get(11)?,
                    row.get(12)?,
                    row.get(13)?,
                    row.get(14)?,
                    row.get(15)?,
                    row.get(16)?,
                    row.get(17)?,
                    row.get(18)?,
                    row.get(19)?,
                    row.get(20)?,
                    row.get(21)?,
                    row.get(22)?,
                    row.get(23)?,
                    row.get(24)?,
                    row.get(25)?,
                    row.get(26)?,
                    row.get(27)?,
                    row.get(28)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| RegistryError::UnknownSoul(soul_id.clone()))?;
    let incarnation_id = load_recovery_prior_incarnation(conn, soul_id, true)?;
    let prior_handle = load_owned_handle(conn, installation, &incarnation_id)?;
    let (accepted_command_count, completed_command_count, dispatched_count): (u64, u64, u64) =
        conn.query_row(
            "SELECT COUNT(*),COALESCE(SUM(CASE WHEN state='completed' THEN 1 ELSE 0 END),0),COALESCE(SUM(CASE WHEN state IN ('dispatching','completed','ambiguous') THEN 1 ELSE 0 END),0) FROM input_commands WHERE soul_id=?1",
            params![soul_id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
    let resume_spec = row
        .22
        .map(|value| serde_json::from_str(&value))
        .transpose()?;
    let opencode_adoption_baseline = load_stopped_repair_adoption_baseline(
        conn,
        &StoppedRepairAdoptionBaselineLookup {
            soul_id,
            provider: &row.0,
            provider_store_id: &row.1,
            native_session_id: row.2.as_deref(),
            native_import_state: &row.13,
            native_import_authority: &row.20,
            source_store_id: row.14.as_deref(),
            root_session_id: row.15.as_deref(),
            source_generation: row.16.as_deref(),
        },
    )?;
    // Coding providers may create a conversation while handling the initial
    // execution grant, before an input row or native-ID acknowledgement exists.
    // Only the existing settled rejection transaction proves an issued grant
    // was unconsumed. Shell has no implicit provider initialization turn.
    let requires_native = freshell_agent_runtime::recovery_paths(&row.0)
        .is_some_and(|paths| paths.contains(&RecoveryPath::NativeResume));
    let initialization_uncertain: bool = requires_native && conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM incarnations i WHERE i.soul_id=?1 AND i.grant_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM commands c WHERE c.incarnation_id=i.incarnation_id AND c.state='provider_inputs_changed'))",
        [soul_id.as_str()], |row| row.get(0),
    )?;
    let never_dispatched = dispatched_count == 0 && row.2.is_none() && !initialization_uncertain;
    Ok(RecoveryContext {
        claude_fork: conn
            .query_row(
                "SELECT claude_fork_recipe FROM souls WHERE soul_id=?1",
                params![soul_id.as_str()],
                |r| r.get::<_, Option<String>>(0),
            )?
            .map(|raw| serde_json::from_str(&raw))
            .transpose()?,
        native_identity_launch: conn
            .query_row(
                "SELECT native_identity_launch FROM incarnations WHERE incarnation_id=?1",
                params![prior_handle.incarnation_id().as_str()],
                |r| r.get::<_, Option<String>>(0),
            )?
            .map(|v| serde_json::from_str(&v))
            .transpose()?,
        soul_id: soul_id.clone(),
        provider: row.0,
        provider_store_id: row.1,
        native_session_id: row.2,
        creation_seed_ref: row.3,
        desired_state: parse_desired_state(&row.4)?,
        intent_revision: row.5,
        identity_revision: row.11,
        recovery_state: parse_recovery_state(&row.6)?,
        durability_state: parse_durability_state(&row.7)?,
        allocation_state: parse_allocation_state(&row.8)?,
        checkpoint_revision: row.9,
        evidence_revision: row.10,
        native_import_revision: row.12,
        native_import_state: NativeImportState::parse(&row.13)?,
        native_import_source_store_id: row.14.clone(),
        native_import_root_session_id: row.15.clone(),
        native_import_source_generation: row.16.clone(),
        native_import_schema_fingerprint: row.17.clone(),
        native_import_migration_fingerprint: row.18.clone(),
        native_import_complete_inventory: row.19,
        native_import_authority: row.20.clone(),
        recovery_attempt_id: row
            .21
            .clone()
            .map(RecoveryAttemptId::parse)
            .transpose()
            .map_err(|_| RegistryError::Integrity("invalid recovery attempt id".into()))?,
        control_epoch: row.28,
        resume_spec,
        opencode_adoption_baseline,
        project_key: row.23.clone(),
        profile: parse_runtime_profile(&row.24)?,
        fixture: prior_handle.fixture(),
        terminal: prior_handle.terminal().cloned(),
        fresh_agent: prior_handle.fresh_agent().cloned(),
        requested_limits: row
            .27
            .map(|value| serde_json::from_str(&value))
            .transpose()?
            .unwrap_or_else(|| prior_handle.requested_limits()),
        accepted_command_count,
        completed_command_count,
        dispatched_command_count: dispatched_count,
        never_dispatched,
        recovery_window_started_at: row.25,
        successful_recoveries_in_window: row.26,
        prior_handle,
    })
}

pub(crate) fn load_inventory(conn: &Connection) -> Result<Vec<RuntimeView>, RegistryError> {
    let mut stmt = conn.prepare(
        "SELECT i.soul_id,i.incarnation_id,i.launch_state,i.cleanup_state,s.intent_revision,i.container_id,i.host_boot_id,i.execution_generation,i.effective_limits,i.terminal_id,s.project_key,s.resource_profile,s.desired_state,s.recovery_state,s.durability_state,s.allocation_state,s.provider,s.native_session_id,s.recovery_reason,i.prior_incarnation_id,s.recovery_attempt_id,s.evidence_revision,s.successful_recoveries_in_window,i.terminal_spec,s.configured_limits,(SELECT MAX(v.revision) FROM view_intents v WHERE v.soul_id=i.soul_id),s.loss_incident_id,i.fresh_agent_spec,s.creation_seed_ref FROM incarnations i JOIN souls s ON s.soul_id=i.soul_id ORDER BY i.created_at,i.incarnation_id",
    )?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let effective: Option<String> = row.get(8)?;
        let profile: String = row.get(11)?;
        let terminal_spec: Option<TerminalLaunchSpec> = row
            .get::<_, Option<String>>(23)?
            .map(|value| serde_json::from_str(&value))
            .transpose()?;
        let fresh_agent_spec: Option<FreshAgentLaunchSpec> = row
            .get::<_, Option<String>>(27)?
            .map(|value| serde_json::from_str(&value))
            .transpose()?;
        out.push(RuntimeView {
            native_identity_observation: conn
                .query_row(
                    "SELECT native_identity_observation FROM incarnations WHERE incarnation_id=?1",
                    params![row.get::<_, String>(1)?],
                    |r| r.get::<_, Option<String>>(0),
                )?
                .map(|v| serde_json::from_str(&v))
                .transpose()?,
            soul_id: SoulId::parse(row.get::<_, String>(0)?)
                .map_err(|_| RegistryError::Integrity("invalid soul id".into()))?,
            incarnation_id: IncarnationId::parse(row.get::<_, String>(1)?)
                .map_err(|_| RegistryError::Integrity("invalid incarnation id".into()))?,
            launch_state: parse_launch_state(&row.get::<_, String>(2)?)?,
            cleanup_state: parse_cleanup_state(&row.get::<_, String>(3)?)?,
            intent_revision: row.get(4)?,
            container_id: row.get(5)?,
            host_boot_id: row
                .get::<_, Option<String>>(6)?
                .map(HostBootId::parse)
                .transpose()
                .map_err(|_| RegistryError::Integrity("invalid host boot id".into()))?,
            execution_generation: row.get(7)?,
            effective_limits: effective.map(|v| serde_json::from_str(&v)).transpose()?,
            configured_limits: row
                .get::<_, Option<String>>(24)?
                .map(|value| serde_json::from_str(&value))
                .transpose()?,
            view_intent_revision: row.get(25)?,
            terminal_id: row.get(9)?,
            terminal_stream_id: terminal_spec.as_ref().map(|spec| spec.stream_id.clone()),
            terminal_mode: terminal_spec.as_ref().map(|spec| spec.mode.clone()),
            terminal_cwd: terminal_spec.as_ref().map(|spec| spec.cwd.clone()),
            terminal_create_request_id: terminal_spec
                .as_ref()
                .and_then(|spec| spec.create_request_id.clone()),
            terminal_resume_session_id: terminal_spec
                .as_ref()
                .and_then(|spec| spec.resume_session_id.clone()),
            fresh_agent_session_id: fresh_agent_spec
                .as_ref()
                .map(|spec| spec.session_id.clone()),
            fresh_agent_create_request_id: if fresh_agent_spec.is_some() {
                Some(row.get(28)?)
            } else {
                None
            },
            fresh_agent_session_type: fresh_agent_spec
                .as_ref()
                .map(|spec| spec.session_type.clone()),
            fresh_agent_runtime_variant: fresh_agent_spec
                .as_ref()
                .map(|spec| spec.runtime_variant.clone()),
            project_key: Some(row.get(10)?),
            profile: Some(parse_runtime_profile(&profile)?),
            desired_state: parse_desired_state(&row.get::<_, String>(12)?)?,
            recovery_state: parse_recovery_state(&row.get::<_, String>(13)?)?,
            durability_state: parse_durability_state(&row.get::<_, String>(14)?)?,
            allocation_state: parse_allocation_state(&row.get::<_, String>(15)?)?,
            provider: Some(row.get(16)?),
            native_session_id: row.get(17)?,
            recovery_reason: row.get(18)?,
            incident_id: row
                .get::<_, Option<String>>(26)?
                .map(freshell_runtime_protocol::IncidentId::parse)
                .transpose()
                .map_err(|_| RegistryError::Integrity("invalid incident id".into()))?,
            prior_incarnation_id: row
                .get::<_, Option<String>>(19)?
                .map(IncarnationId::parse)
                .transpose()
                .map_err(|_| RegistryError::Integrity("invalid prior incarnation id".into()))?,
            recovery_attempt_id: row
                .get::<_, Option<String>>(20)?
                .map(RecoveryAttemptId::parse)
                .transpose()
                .map_err(|_| RegistryError::Integrity("invalid recovery attempt id".into()))?,
            evidence_revision: row.get(21)?,
            successful_recoveries_in_window: row.get(22)?,
        });
    }
    Ok(out)
}

fn parse_desired_state(value: &str) -> Result<DesiredState, RegistryError> {
    match value {
        "running" => Ok(DesiredState::Running),
        "stopped" => Ok(DesiredState::Stopped),
        other => Err(RegistryError::Integrity(format!(
            "unknown desired state {other}"
        ))),
    }
}

fn parse_recovery_state(value: &str) -> Result<RecoveryState, RegistryError> {
    match value {
        "live" => Ok(RecoveryState::Live),
        "recovering" => Ok(RecoveryState::Recovering),
        "blocked" => Ok(RecoveryState::Blocked),
        "lost" => Ok(RecoveryState::Lost),
        "stopped" => Ok(RecoveryState::Stopped),
        "data_repair_complete" => Ok(RecoveryState::DataRepairComplete),
        other => Err(RegistryError::Integrity(format!(
            "unknown recovery state {other}"
        ))),
    }
}

pub(crate) fn validate_stopped_repair_target_in_tx(
    tx: &rusqlite::Transaction<'_>,
    target: &LostSoulRepairTarget,
) -> Result<(), RegistryError> {
    let current_revision: Option<u64> = tx
        .query_row(
            "SELECT intent_revision FROM souls WHERE soul_id=?1",
            params![target.soul_id.as_str()],
            |row| row.get(0),
        )
        .optional()?;
    let Some(current_revision) = current_revision else {
        return Err(RegistryError::UnknownSoul(target.soul_id.clone()));
    };
    if current_revision != target.expected_intent_revision {
        return Err(RegistryError::StaleIntentRevision {
            expected: target.expected_intent_revision,
            current: current_revision,
        });
    }

    type TargetRow = (
        String,
        String,
        String,
        String,
        String,
        Option<String>,
        u64,
        u64,
        u64,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        bool,
        String,
        String,
        String,
        Option<String>,
        Option<u64>,
        Option<u64>,
        Option<u64>,
        Option<String>,
        Option<bool>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let row: TargetRow = tx
        .query_row(
            "SELECT l.certificate_json,l.cleanup_json,l.decision_state,l.cleanup_state, \
                    s.provider,s.native_session_id,s.identity_revision,s.evidence_revision, \
                    s.native_import_revision,s.native_import_state,s.native_import_source_store_id, \
                    s.native_import_root_session_id,s.native_import_source_generation, \
                    s.native_import_schema_fingerprint,s.native_import_complete_inventory, \
                    s.native_import_authority,s.desired_state,s.recovery_state,s.loss_incident_id, \
                    l.captured_identity_revision,l.captured_evidence_revision, \
                    l.captured_native_import_revision,l.captured_native_import_state, \
                    l.captured_native_import_complete,l.captured_native_import_authority, \
                    l.captured_source_store_id,l.captured_root_session_id,l.captured_source_generation, \
                    l.captured_source_schema_fingerprint,l.captured_migration_fingerprint, \
                    s.native_import_migration_fingerprint \
             FROM loss_incidents l JOIN souls s ON s.soul_id=l.soul_id \
             WHERE l.incident_id=?1 AND l.soul_id=?2",
            params![target.incident_id.as_str(), target.soul_id.as_str()],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                    row.get(9)?,
                    row.get(10)?,
                    row.get(11)?,
                    row.get(12)?,
                    row.get(13)?,
                    row.get(14)?,
                    row.get(15)?,
                    row.get(16)?,
                    row.get(17)?,
                    row.get(18)?,
                    row.get(19)?,
                    row.get(20)?,
                    row.get(21)?,
                    row.get(22)?,
                    row.get(23)?,
                    row.get(24)?,
                    row.get(25)?,
                    row.get(26)?,
                    row.get(27)?,
                    row.get(28)?,
                    row.get(29)?,
                    row.get(30)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| RegistryError::IncidentNotFound(target.incident_id.clone()))?;

    let certificate: freshell_runtime_protocol::LostDecisionCertificate =
        serde_json::from_str(&row.0)?;
    let cleanup: freshell_runtime_protocol::LossCleanupReport = serde_json::from_str(&row.1)?;
    let current_import_state = NativeImportState::parse(&row.9)?;
    if row.2 != "lost"
        || row.3 != "closed"
        || row.4 != "opencode"
        || row.16 != "stopped"
        || row.17 != "lost"
        || row.18.as_deref() != Some(target.incident_id.as_str())
        || row.19 != Some(row.6)
        || row.20 != Some(row.7)
        || row.21 != Some(row.8)
        || row.22.as_deref() != Some(current_import_state.as_str())
        || row.23 != Some(row.14)
        || row.24.as_deref() != Some(row.15.as_str())
        || row.25 != row.10
        || row.26 != row.11
        || row.27 != row.12
        || row.28 != row.13
        || row.29 != row.30
        || certificate.soul_id != target.soul_id
        || certificate.incident_id != target.incident_id
        || certificate.provider != "opencode"
        || certificate.decision.state != freshell_runtime_protocol::LossDecisionState::Lost
        || certificate.intent_revision.checked_add(1) != Some(target.expected_intent_revision)
        || certificate
            .cleanup_target
            .incarnation_id
            .as_str()
            .is_empty()
        || cleanup.owned_handle_ref != certificate.cleanup_target.owned_handle_ref
        || !cleanup.ownership_verified
        || !cleanup.verified_empty
        || cleanup.foreign_objects_touched != 0
        || row.5.is_none() && row.11.is_none()
    {
        return Err(RegistryError::RecoveryBlocked {
            soul_id: target.soul_id.clone(),
            reason: "target is not the exact closed, verified-empty OpenCode loss captured by this intent".into(),
        });
    }

    let incarnation_state: Option<(String, String, String, u64)> = tx
        .query_row(
            "SELECT launch_state,cleanup_state,incarnation_id,execution_generation \
             FROM incarnations WHERE soul_id=?1 AND incarnation_id=?2",
            params![
                target.soul_id.as_str(),
                certificate.cleanup_target.incarnation_id.as_str()
            ],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    if !matches!(incarnation_state, Some((ref launch, ref cleanup, _, _)) if launch == "stopped" && cleanup == "verified_empty")
    {
        return Err(RegistryError::RecoveryBlocked {
            soul_id: target.soul_id.clone(),
            reason: "the exact old incarnation cleanup is not settled and verified empty".into(),
        });
    }
    let active: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM incarnations WHERE soul_id=?1 AND launch_state IN ('prepared','created','starting','running','stopping'))",
        params![target.soul_id.as_str()],
        |row| row.get(0),
    )?;
    if active {
        return Err(RegistryError::RecoveryBlocked {
            soul_id: target.soul_id.clone(),
            reason: "an incarnation is still active for this stopped-repair target".into(),
        });
    }
    Ok(())
}

fn parse_durability_state(value: &str) -> Result<DurabilityState, RegistryError> {
    match value {
        "unknown" => Ok(DurabilityState::Unknown),
        "live_only" => Ok(DurabilityState::LiveOnly),
        "resume_captured" => Ok(DurabilityState::ResumeCaptured),
        "checkpoint_captured" => Ok(DurabilityState::CheckpointCaptured),
        "intrinsically_non_resumable" => Ok(DurabilityState::IntrinsicallyNonResumable),
        other => Err(RegistryError::Integrity(format!(
            "unknown durability state {other}"
        ))),
    }
}

fn parse_allocation_state(value: &str) -> Result<AllocationState, RegistryError> {
    match value {
        "allocated" => Ok(AllocationState::Allocated),
        "materializing" => Ok(AllocationState::Materializing),
        "verified_durable" => Ok(AllocationState::VerifiedDurable),
        "degraded" => Ok(AllocationState::Degraded),
        other => Err(RegistryError::Integrity(format!(
            "unknown allocation state {other}"
        ))),
    }
}

fn parse_launch_state(value: &str) -> Result<LaunchState, RegistryError> {
    Ok(match value {
        "prepared" => LaunchState::Prepared,
        "created" => LaunchState::Created,
        "starting" => LaunchState::Starting,
        "running" => LaunchState::Running,
        "stopping" => LaunchState::Stopping,
        "stopped" => LaunchState::Stopped,
        "failed" => LaunchState::Failed,
        other => {
            return Err(RegistryError::Integrity(format!(
                "unknown launch state {other}"
            )))
        }
    })
}

fn parse_cleanup_state(value: &str) -> Result<CleanupState, RegistryError> {
    Ok(match value {
        "none" => CleanupState::None,
        "requested" => CleanupState::Requested,
        "termination_unconfirmed" => CleanupState::TerminationUnconfirmed,
        "verified_empty" => CleanupState::VerifiedEmpty,
        "blocked_ownership" => CleanupState::BlockedOwnership,
        other => {
            return Err(RegistryError::Integrity(format!(
                "unknown cleanup state {other}"
            )))
        }
    })
}

pub(crate) fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn durable_sync_parent(parent: Option<&Path>) -> Result<(), RegistryError> {
    if let Some(parent) = parent {
        let dir = std::fs::File::open(parent)?;
        dir.sync_all()?;
    }
    Ok(())
}

#[cfg(feature = "runtime-test-faults")]
pub(crate) fn failpoint(name: &'static str) -> Result<(), RegistryError> {
    if std::env::var("FRESHELL_RUNTIME_DB_FAILPOINT")
        .ok()
        .as_deref()
        == Some(name)
    {
        return Err(RegistryError::FaultInjected(name));
    }
    Ok(())
}

#[cfg(not(feature = "runtime-test-faults"))]
pub(crate) fn failpoint(_name: &'static str) -> Result<(), RegistryError> {
    Ok(())
}

pub(crate) fn stopped_repair_owner_candidates_in_connection(
    conn: &Connection,
    root_session_id: &str,
) -> Result<Vec<StoppedRepairOwnerCandidate>, RegistryError> {
    let mut statement=conn.prepare("SELECT s.soul_id,s.native_import_source_store_id,COALESCE(s.native_import_root_session_id,s.native_session_id),s.native_import_source_generation,s.native_import_state,s.native_import_authority,(SELECT COUNT(*) FROM view_intents v WHERE v.soul_id=s.soul_id AND v.kind<>'automatic_primary') FROM souls s WHERE s.provider='opencode' AND (s.native_session_id=?1 OR s.native_import_root_session_id=?1) ORDER BY s.soul_id")?;
    let rows = statement.query_map(params![root_session_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, u64>(6)?,
        ))
    })?;
    let mut candidates = Vec::new();
    for row in rows {
        let (
            soul_id,
            source_store_id,
            root_session_id,
            source_generation,
            import_state,
            native_import_authority,
            explicit_view_count,
        ) = row?;
        candidates.push(StoppedRepairOwnerCandidate {
            soul_id: SoulId::parse(soul_id)
                .map_err(|_| RegistryError::Integrity("invalid OpenCode owner soul id".into()))?,
            source_store_id,
            root_session_id,
            source_generation,
            native_import_state: NativeImportState::parse(&import_state)?,
            native_import_authority,
            explicit_view_count,
        });
    }
    Ok(candidates)
}

#[cfg(test)]
pub(crate) mod tests {
    #[tokio::test]
    async fn recovery_initialization_grant_before_identity_is_not_pristine() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let soul = SoulId::new();
        let mut launch = prep(soul.clone(), RequestId::new(), "startup");
        launch.provider = "opencode".into();
        let prepared = registry.prepare_launch(launch).await.unwrap();
        registry
            .commit_created(
                prepared.incarnation_id.clone(),
                BackendCreatedRecord {
                    launch_policy: None,
                    daemon_id: DockerDaemonId::new(),
                    container_id: "a".repeat(64),
                    image_ref: format!("sha256:{}", "b".repeat(64)),
                    runtime_dir: dir.path().join("runtime"),
                    host_binary_path: dir.path().join("host"),
                    immutable_config_digest: format!("sha256:{}", "c".repeat(64)),
                },
            )
            .await
            .unwrap();
        assert!(
            registry
                .recovery_context(soul.clone())
                .await
                .unwrap()
                .never_dispatched
        );
        registry
            .commit_execution_grant(prepared.incarnation_id, HostBootId::new(), limits())
            .await
            .unwrap();
        let ctx = registry.recovery_context(soul).await.unwrap();
        assert!(ctx.native_session_id.is_none());
        assert_eq!(ctx.accepted_command_count, 0);
        assert!(!ctx.never_dispatched, "an issued initialization grant has uncertain provider execution even before input/native-ID capture");
    }

    #[tokio::test]
    async fn recovery_five_natural_successes_exhaust_durable_budget_until_manual_retry() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let soul = SoulId::new();
        materialize_test_runtime(&registry, soul.clone()).await;
        for expected in 1..=5 {
            let start = registry
                .begin_recovery(
                    soul.clone(),
                    RecoveryTrigger::ProviderExit,
                    RecoveryPath::PristineSeed,
                )
                .await
                .unwrap();
            registry
                .mark_stop_outcome(
                    start.context.prior_handle.incarnation_id().clone(),
                    StopOutcome::VerifiedEmpty,
                )
                .await
                .unwrap();
            let attempt = start.attempt_id.clone();
            let replacement = registry
                .prepare_replacement(start, None, None, None, RecoveryPath::PristineSeed)
                .await
                .unwrap();
            let id = replacement.prepared.incarnation_id.clone();
            registry
                .commit_created(
                    id.clone(),
                    BackendCreatedRecord {
                        launch_policy: None,
                        daemon_id: DockerDaemonId::new(),
                        container_id: format!("{expected:064x}"),
                        image_ref: format!("sha256:{}", "b".repeat(64)),
                        runtime_dir: dir.path().join(format!("runtime-{expected}")),
                        host_binary_path: dir.path().join("host"),
                        immutable_config_digest: format!("sha256:{}", "c".repeat(64)),
                    },
                )
                .await
                .unwrap();
            registry
                .commit_execution_grant(id.clone(), HostBootId::new(), limits())
                .await
                .unwrap();
            registry.mark_running(id.clone()).await.unwrap();
            registry
                .mark_recovery_success(
                    soul.clone(),
                    id,
                    attempt,
                    registry
                        .recovery_context(soul.clone())
                        .await
                        .unwrap()
                        .write_fence(),
                )
                .await
                .unwrap();
            assert_eq!(
                registry
                    .recovery_context(soul.clone())
                    .await
                    .unwrap()
                    .successful_recoveries_in_window,
                expected
            );
        }
        assert!(matches!(
            registry
                .begin_recovery(
                    soul.clone(),
                    RecoveryTrigger::ProviderExit,
                    RecoveryPath::PristineSeed
                )
                .await,
            Err(RegistryError::RecoveryBlocked { .. })
        ));
        drop(registry);
        let cold = Registry::open(dir.path(), None).unwrap();
        assert!(matches!(
            cold.begin_recovery(
                soul.clone(),
                RecoveryTrigger::StartupReconcile,
                RecoveryPath::PristineSeed
            )
            .await,
            Err(RegistryError::RecoveryBlocked { .. })
        ));
        let manual = cold
            .begin_recovery(
                soul,
                RecoveryTrigger::ManualRetry,
                RecoveryPath::PristineSeed,
            )
            .await
            .unwrap();
        assert_eq!(
            manual.context.successful_recoveries_in_window, 5,
            "pre-rearm context preserves history"
        );
        assert_eq!(
            cold.recovery_context(manual.context.soul_id)
                .await
                .unwrap()
                .successful_recoveries_in_window,
            0
        );
    }
    use super::*;

    fn limits() -> RuntimeLimits {
        RuntimeLimits {
            cpu_milli: 500,
            memory_bytes: 64 * 1024 * 1024,
            swap_bytes: 0,
            pids_max: 32,
        }
    }

    fn prep(soul: SoulId, request: RequestId, digest: &str) -> LaunchPreparation {
        LaunchPreparation {
            soul_id: soul,
            provider: "fixture".into(),
            provider_store_id: "store".into(),
            native_session_id: None,
            creation_seed_ref: "seed".into(),
            request_id: request,
            payload_digest: digest.into(),
            requested_limits: limits(),
            profile: RuntimeProfile::Custom,
            project_key: "test-project".into(),
            fixture: None,
            terminal: None,
            fresh_agent: None,
            view_intent: None,
            admission: AdmissionPolicy::default(),
        }
    }

    fn opencode_transfer_descriptor(transfer_id: &str) -> OpenCodeTransferDescriptor {
        let payload = b"12345678";
        let source_store_id = "b".repeat(64);
        let source_schema_fingerprint = "c".repeat(64);
        let migration_journal_fingerprint = "d".repeat(64);
        let generation = "e".repeat(64);
        let target_image_ref = format!("sha256:{}", "a".repeat(64));
        let payload_sha256 = format!("{:x}", Sha256::digest(payload));
        let manifest_json = serde_json::json!({
            "version": 1,
            "provider_schema": "opencode-1.18.21",
            "root_session_id": "ses_exact",
            "source_store_id": source_store_id,
            "source_schema_fingerprint": source_schema_fingerprint,
            "migration_journal_fingerprint": migration_journal_fingerprint,
            "generation": generation,
            "assets": [],
            "payload_bytes": payload.len(),
            "payload_sha256": payload_sha256,
            "rows": []
        })
        .to_string();
        let files = vec![freshell_runtime_protocol::OpenCodeTransferFile {
            index: 0,
            relative_path: "payload.json".into(),
            size_bytes: payload.len() as u64,
            sha256: payload_sha256,
        }];
        let target_build_receipt = freshell_runtime_protocol::opencode_target_build_receipt(
            &target_image_ref,
            "opencode-1.18.21",
        );
        let bundle_sha256 =
            freshell_runtime_protocol::opencode_transfer_bundle_digest(&manifest_json, &files);
        OpenCodeTransferDescriptor {
            transfer_id: transfer_id.into(),
            provider: "opencode".into(),
            source_store_id,
            root_session_id: "ses_exact".into(),
            source_generation: generation,
            provider_schema: "opencode-1.18.21".into(),
            source_schema_fingerprint,
            migration_journal_fingerprint,
            destination_store_id: "soul-exact".into(),
            destination_database_path: ".local/share/opencode/opencode.db".into(),
            target_image_ref,
            target_build_receipt,
            incarnation_id: "incarnation-test".into(),
            manifest_json,
            files: files.clone(),
            total_bytes: payload.len() as u64,
            bundle_sha256,
        }
    }

    fn opencode_terminal(
        descriptor: &OpenCodeTransferDescriptor,
        attempt_id: &str,
    ) -> TerminalLaunchSpec {
        serde_json::from_value(serde_json::json!({
            "terminalId": "terminal-transfer-restart",
            "streamId": "stream-transfer-restart",
            "mode": "opencode",
            "program": "opencode",
            "cwd": "/workspace",
            "runAsUid": 65534,
            "runAsGid": 0,
            "cols": 80,
            "rows": 24,
            "projectKey": "test-project",
            "workspacePath": "/workspace",
            "resumeSessionId": descriptor.root_session_id,
            "opencodeTransfer": descriptor,
            "opencodeTransferAttemptId": attempt_id,
        }))
        .unwrap()
    }

    fn opencode_prep(
        soul_id: SoulId,
        request_id: RequestId,
        descriptor: &OpenCodeTransferDescriptor,
        attempt_id: &str,
    ) -> LaunchPreparation {
        LaunchPreparation {
            soul_id,
            provider: "opencode".into(),
            provider_store_id: descriptor.destination_store_id.clone(),
            native_session_id: Some(descriptor.root_session_id.clone()),
            creation_seed_ref: "seed".into(),
            request_id,
            payload_digest: "stable-opencode-transfer-request".into(),
            requested_limits: limits(),
            profile: RuntimeProfile::Custom,
            project_key: "test-project".into(),
            fixture: None,
            terminal: Some(opencode_terminal(descriptor, attempt_id)),
            fresh_agent: None,
            view_intent: None,
            admission: AdmissionPolicy::default(),
        }
    }

    fn opencode_chunk(
        descriptor: &OpenCodeTransferDescriptor,
        attempt_id: &str,
    ) -> freshell_runtime_protocol::OpenCodeTransferChunk {
        let data = b"12345678".to_vec();
        freshell_runtime_protocol::OpenCodeTransferChunk {
            transfer_id: descriptor.transfer_id.clone(),
            attempt_id: attempt_id.into(),
            sequence: 0,
            file_index: 0,
            offset: 0,
            sha256: format!("{:x}", Sha256::digest(&data)),
            data,
        }
    }

    #[tokio::test]
    async fn provider_preparation_migration_preserves_unproved_running_and_accepted_pending_state()
    {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("registry");
        let registry = Registry::open(&root, None).unwrap();
        let prepared = registry
            .prepare_launch(prep(SoulId::new(), RequestId::new(), "pending"))
            .await
            .unwrap();
        let id = prepared.incarnation_id.clone();
        let conn = Connection::open(&registry.inner.db_path).unwrap();
        conn.execute(
            "UPDATE incarnations SET launch_state='running' WHERE incarnation_id=?1",
            params![id.as_str()],
        )
        .unwrap();
        assert!(
            !registry
                .provider_preparation_is_pending(id.clone())
                .await
                .unwrap(),
            "generic Running has no native acceptance proof"
        );
        conn.execute_batch("ALTER TABLE incarnations DROP COLUMN provider_preparation_pending; UPDATE installation SET schema_version=9;").unwrap();
        drop(conn);
        drop(registry);
        let migrated = Registry::open(&root, None).unwrap();
        assert!(
            !migrated
                .provider_preparation_is_pending(id.clone())
                .await
                .unwrap(),
            "legacy Running remains uncertain after migration"
        );
        let conn = Connection::open(&migrated.inner.db_path).unwrap();
        conn.execute(
            "UPDATE incarnations SET launch_state='starting' WHERE incarnation_id=?1",
            params![id.as_str()],
        )
        .unwrap();
        migrated
            .mark_running_with_provider_preparation(id.clone(), true)
            .await
            .unwrap();
        assert!(migrated
            .provider_preparation_is_pending(id.clone())
            .await
            .unwrap());
        // Idempotent upgrades preserve a real previously accepted pending proof.
        conn.execute_batch("UPDATE installation SET schema_version=9;")
            .unwrap();
        drop(conn);
        drop(migrated);
        let reopened = Registry::open(&root, None).unwrap();
        assert!(reopened
            .provider_preparation_is_pending(id.clone())
            .await
            .unwrap());
        reopened
            .mark_provider_preparation_complete(id.clone())
            .await
            .unwrap();
        assert!(!reopened.provider_preparation_is_pending(id).await.unwrap());
    }

    #[tokio::test]
    async fn provider_initial_reservation_migration_retains_legacy_opencode_authority() {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("synthetic-host");
        std::fs::write(&binary, "synthetic artifact").unwrap();
        let root = dir.path().join("registry");
        let registry = Registry::open(&root, None).unwrap();
        let request = freshell_runtime_protocol::ReserveProviderInputsRequest {
            expected_control_epoch: None,
            soul_id: SoulId::new(),
            provider: "opencode".into(),
            creation_seed_ref: "seed".into(),
        };
        let image = format!("sha256:{}", "a".repeat(64));
        let reservation = registry
            .reserve_initial_inputs(request.clone(), image.clone(), binary.clone())
            .await
            .unwrap();
        let observation = freshell_runtime_protocol::InitialAuthVolumeObservation::Absent {
            daemon_id: DockerDaemonId::new(),
        };
        let expected = registry
            .record_initial_observation(reservation, observation.clone())
            .await
            .unwrap();
        let conn = open_connection(&registry.inner.db_path).unwrap();
        conn.execute_batch("ALTER TABLE provider_input_preparations DROP COLUMN provider; UPDATE installation SET schema_version=8;").unwrap();
        drop(conn);
        drop(registry);
        let restored = Registry::open(&root, None).unwrap();
        let reservation = restored
            .reserve_initial_inputs(request.clone(), image.clone(), binary.clone())
            .await
            .unwrap();
        assert_eq!(
            restored
                .record_initial_observation(reservation, observation)
                .await
                .unwrap(),
            expected
        );
        let mut changed = request;
        changed.provider = "codex".into();
        assert!(
            matches!(
                restored
                    .reserve_initial_inputs(changed, image, binary)
                    .await,
                Err(RegistryError::RequestConflict)
            ),
            "legacy OpenCode reservations retain exact provider identity on reopen"
        );
    }

    #[tokio::test]
    async fn provider_kilroy_ordinary_authority_cannot_bind_the_other_claude_flavor() {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("synthetic-host");
        std::fs::write(&binary, "synthetic artifact").unwrap();
        let registry = Registry::open(dir.path().join("registry"), None).unwrap();
        let soul = SoulId::new();
        let request = freshell_runtime_protocol::ReserveProviderInputsRequest {
            expected_control_epoch: Some(registry.control_epoch()),
            soul_id: soul.clone(),
            provider: "kilroy".into(),
            creation_seed_ref: "seed".into(),
        };
        let reservation = registry
            .reserve_initial_inputs(
                request.clone(),
                format!("sha256:{}", "a".repeat(64)),
                binary.clone(),
            )
            .await
            .expect("the existing Kilroy flavor requires its distinct creation authority");
        let mut wrong = request;
        wrong.provider = "claude".into();
        assert!(matches!(
            registry
                .reserve_initial_inputs(wrong, format!("sha256:{}", "a".repeat(64)), binary)
                .await,
            Err(RegistryError::RequestConflict)
        ));
        let receipt = registry
            .record_initial_observation(
                reservation,
                freshell_runtime_protocol::InitialAuthVolumeObservation::Absent {
                    daemon_id: DockerDaemonId::new(),
                },
            )
            .await
            .unwrap();
        assert_eq!(receipt.provider, "kilroy");
        let mut launch = prep(soul, RequestId::new(), "kilroy-owned-inputs");
        launch.provider = "kilroy".into();
        launch.terminal = None;
        launch.fresh_agent = Some(serde_json::from_value(serde_json::json!({
            "sessionId":"synthetic-fresh", "provider":"kilroy", "sessionType":"kilroy",
            "runtimeVariant":"kilroy-claude-agent-sdk", "providerStoreId":"test-store",
            "cwd":"/synthetic/workspace", "workspacePath":"/synthetic/workspace", "runAsUid":65534,"runAsGid":0,
            "providerLaunchContext": {
                "preparation":{"claude":{"mcp_args":[]}},
                "mcpCapability":{"grantId":"grant-ordinary", "endpoint":"http://host.docker.internal:3001/api/mcp", "providerRelativePath":".freshell/mcp-capability.json"},
                "preparedInputs":{"generationId":"grant-ordinary", "initialAuthReservation":receipt.reservation_id,
                    "manifest":{"relativePath":".freshell/input-manifest.json","sha256":"a".repeat(64),"sourceCount":0,"aliasCount":0,"recipeCount":0}}
            }
        })).unwrap());
        let mut other = launch.clone();
        other.provider = "claude".into();
        let fresh = other.fresh_agent.as_mut().unwrap();
        fresh.provider = freshell_runtime_protocol::FreshProvider::Claude;
        fresh.session_type = "freshclaude".into();
        fresh.runtime_variant = "claude-agent-sdk".into();
        assert!(matches!(
            registry.prepare_launch(other).await,
            Err(RegistryError::RequestConflict)
        ));
        let prepared = registry.prepare_launch(launch).await.unwrap();
        let bound = registry
            .bound_input_reservation(prepared.incarnation_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(bound.reservation.provider, "kilroy");
    }

    #[tokio::test]
    async fn provider_ordinary_initial_reservation_preserves_provider_identity() {
        for provider in ["codex", "claude", "amplifier"] {
            for native_session_id in [None, Some("fixture-native-session".to_string())] {
                let dir = tempfile::tempdir().unwrap();
                let binary = dir.path().join("synthetic-host");
                std::fs::write(&binary, "synthetic artifact").unwrap();
                let registry = Registry::open(dir.path().join("registry"), None).unwrap();
                let soul = SoulId::new();
                let request = freshell_runtime_protocol::ReserveProviderInputsRequest {
                    expected_control_epoch: Some(registry.control_epoch()),
                    soul_id: soul.clone(),
                    provider: provider.into(),
                    creation_seed_ref: "seed".into(),
                };
                let image = format!("sha256:{}", "a".repeat(64));
                let reserved = registry
                    .reserve_initial_inputs(request.clone(), image.clone(), binary.clone())
                    .await
                    .expect(
                        "ordinary selected inputs require their own provider's creation authority",
                    );
                let retry = registry
                    .reserve_initial_inputs(request.clone(), image.clone(), binary.clone())
                    .await
                    .unwrap();
                assert_eq!(reserved.id, retry.id);
                let mut foreign = request.clone();
                foreign.provider = "opencode".into();
                assert!(matches!(
                    registry
                        .reserve_initial_inputs(foreign, image, binary)
                        .await,
                    Err(RegistryError::RequestConflict)
                ));
                let receipt = registry
                    .record_initial_observation(
                        reserved,
                        freshell_runtime_protocol::InitialAuthVolumeObservation::Absent {
                            daemon_id: DockerDaemonId::new(),
                        },
                    )
                    .await
                    .unwrap();
                assert_eq!(receipt.provider, provider);
                let mut launch = prep(soul.clone(), RequestId::new(), "ordinary-reserved-inputs");
                launch.provider = provider.into();
                launch.native_session_id = native_session_id.clone();
                // Reservation binding protects actual workload preparation, regardless
                // of which finite provider's selected ordinary resources it owns.
                launch.terminal = Some(serde_json::from_value(serde_json::json!({
                "terminalId":"synthetic-terminal", "streamId":"synthetic-stream", "projectKey":"test-project", "mode":provider,
                "program":provider,"args":[],"env":{},"resumeSessionId":native_session_id, "cwd":"/synthetic/workspace",
                "workspacePath":"/synthetic/workspace","cols":80,"rows":24,"runAsUid":65534,"runAsGid":0,
                "providerLaunchContext": {
                    "preparation":match provider {
                        "codex" => serde_json::json!({"codex":{"tui_args":[],"sidecar_args":[]}}),
                        "claude" => serde_json::json!({"claude":{"mcp_args":[]}}),
                        "amplifier" => serde_json::json!({"amplifier":{"bundle":"default","resume_args":[]}}),
                        _ => unreachable!(),
                    },
                    "mcpCapability":{"grantId":"grant-ordinary", "endpoint":"http://host.docker.internal:3001/api/mcp", "providerRelativePath":".freshell/mcp-capability.json"},
                    "preparedInputs":{"generationId":"grant-ordinary", "initialAuthReservation":receipt.reservation_id,
                        "manifest":{"relativePath":".freshell/input-manifest.json","sha256":"a".repeat(64),"sourceCount":0,"aliasCount":0,"recipeCount":0}}
                }
            })).unwrap());
                let mut wrong = launch.clone();
                wrong.provider = "opencode".into();
                let workload = wrong.terminal.as_mut().unwrap();
                workload.mode = "opencode".into();
                workload
                    .provider_launch_context
                    .as_mut()
                    .unwrap()
                    .preparation = freshell_runtime_protocol::ProviderPreparation::Opencode {
                    project_config: vec![],
                    tui_config: None,
                    tui_source: None,
                    inline_config: false,
                };
                let wrong_result = registry.prepare_launch(wrong.clone()).await;
                assert!(
                    matches!(wrong_result, Err(RegistryError::RequestConflict)),
                    "foreign provider bind outcome: {wrong_result:?}"
                );
                let prepared = registry.prepare_launch(launch.clone()).await.unwrap();
                assert_eq!(
                    registry
                        .prepare_launch(launch.clone())
                        .await
                        .unwrap()
                        .incarnation_id,
                    prepared.incarnation_id
                );
                assert!(matches!(registry.prepare_launch(wrong).await, Err(RegistryError::RequestConflict)),
                "a bound reservation retry cannot change provider even when its caller reuses the payload digest");
                let mut changed_seed = launch;
                changed_seed.creation_seed_ref = "changed-creation-seed".into();
                assert!(
                    matches!(
                        registry.prepare_launch(changed_seed).await,
                        Err(RegistryError::RequestConflict)
                    ),
                    "a bound reservation retry cannot change its creation seed"
                );
                let bound = registry
                    .bound_input_reservation(prepared.incarnation_id)
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(bound.reservation.soul_id, soul);
                assert!(registry
                    .initial_input_reservation(soul, receipt.reservation_id)
                    .await
                    .unwrap()
                    .is_none());
            }
        }
    }

    #[tokio::test]
    async fn provider_initial_input_reservation_binds_to_first_prepared_incarnation() {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("synthetic-host");
        std::fs::write(&binary, "synthetic artifact").unwrap();
        let registry = Registry::open(dir.path().join("registry"), None).unwrap();
        let soul = SoulId::new();
        let reserved = registry
            .reserve_initial_inputs(
                freshell_runtime_protocol::ReserveProviderInputsRequest {
                    expected_control_epoch: Some(registry.control_epoch()),
                    soul_id: soul.clone(),
                    provider: "opencode".into(),
                    creation_seed_ref: "seed".into(),
                },
                format!("sha256:{}", "a".repeat(64)),
                binary,
            )
            .await
            .unwrap();
        let observation = freshell_runtime_protocol::InitialAuthVolumeObservation::Absent {
            daemon_id: DockerDaemonId::new(),
        };
        let receipt = registry
            .record_initial_observation(reserved.clone(), observation.clone())
            .await
            .unwrap();
        assert_eq!(
            registry
                .record_initial_observation(reserved.clone(), observation)
                .await
                .unwrap(),
            receipt
        );
        assert!(
            registry
                .record_initial_observation(
                    reserved,
                    freshell_runtime_protocol::InitialAuthVolumeObservation::Absent {
                        daemon_id: DockerDaemonId::new()
                    }
                )
                .await
                .is_err(),
            "a repeated reserve cannot overwrite the original daemon observation"
        );
        let mut launch = prep(soul.clone(), RequestId::new(), "reserved-inputs");
        launch.provider = "opencode".into();
        launch.fresh_agent = Some(serde_json::from_value(serde_json::json!({
            "sessionId":"synthetic-session", "provider":"opencode", "sessionType":"freshopencode",
            "runtimeVariant":"opencode", "providerStoreId":"store", "cwd":"/synthetic/workspace",
            "workspacePath":"/synthetic/workspace", "runAsUid":65534, "runAsGid":0,
            "providerLaunchContext": {
                "preparation":{"opencode":{"project_config":[],"tui_config":null}},
                "mcpCapability":{"grantId":"grant-reservation", "endpoint":"http://host.docker.internal:3001/api/mcp",
                    "providerRelativePath":".config/opencode/freshell-mcp.json"},
                "preparedInputs":{"generationId":"grant-reservation", "initialAuthReservation":receipt.reservation_id,
                    "manifest":{"relativePath":".freshell/input-manifest.json","sha256":"a".repeat(64),
                        "sourceCount":0,"aliasCount":0,"recipeCount":0}}
            }
        })).expect("the complete prepared context must carry its initial auth reservation"));
        let mut existing_native = launch.clone();
        existing_native.native_session_id = Some("preexisting-opencode-session".into());
        assert!(
            matches!(
                registry.prepare_launch(existing_native).await,
                Err(RegistryError::RequestConflict)
            ),
            "OpenCode initial native-auth authority must remain identity-free"
        );
        let first = registry.prepare_launch(launch.clone()).await.unwrap();
        let replay = registry.prepare_launch(launch.clone()).await.unwrap();
        assert_eq!(first.incarnation_id, replay.incarnation_id);
        assert!(
            registry
                .bound_input_reservation(first.incarnation_id.clone())
                .await
                .unwrap()
                .is_some(),
            "creation authority remains available after the soul row is created"
        );
        assert!(registry
            .bound_input_reservation(IncarnationId::new())
            .await
            .unwrap()
            .is_none());
        assert!(
            registry
                .initial_input_reservation(soul.clone(), receipt.reservation_id.clone())
                .await
                .unwrap()
                .is_none(),
            "bound authority must no longer be reusable for a pre-soul absence lookup"
        );
        launch
            .fresh_agent
            .as_mut()
            .unwrap()
            .provider_launch_context
            .as_mut()
            .unwrap()
            .prepared_inputs
            .as_mut()
            .unwrap()
            .initial_auth_reservation = None;
        assert!(matches!(registry.prepare_launch(launch).await,Err(RegistryError::RequestConflict)),
            "a pending retry cannot remove or swap creation authority even with the same semantic digest");
        let conn = open_connection(&registry.inner.db_path).unwrap();
        let consumed: i64 = conn
            .query_row(
                "SELECT consumed FROM provider_input_preparations WHERE soul_id=?1",
                params![soul.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            consumed, 1,
            "preparing the workload must atomically bind, not leave reusable pre-soul authority"
        );
    }

    #[tokio::test]
    async fn stage_reference_query_pins_only_prepared_retryable_transfer_launches() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let prepared = registry
            .prepare_launch(prep(SoulId::new(), RequestId::new(), "transfer-ref"))
            .await
            .unwrap();
        let conn = open_connection(&registry.inner.db_path).unwrap();
        let mut descriptor = opencode_transfer_descriptor("transfer-ref");
        descriptor.incarnation_id = prepared.incarnation_id.as_str().to_owned();
        conn.execute(
            "UPDATE incarnations SET terminal_spec=?1 WHERE incarnation_id=?2",
            params![
                serde_json::json!({
                    "opencodeTransfer": descriptor
                })
                .to_string(),
                prepared.incarnation_id.as_str()
            ],
        )
        .unwrap();
        drop(conn);

        assert_eq!(
            registry
                .opencode_transfer_stage_references()
                .await
                .unwrap()
                .get("transfer-ref"),
            Some(&vec![descriptor.clone()])
        );
        assert!(
            registry
                .opencode_transfer_receipt_candidates()
                .await
                .unwrap()
                .is_empty(),
            "prepared launches must not query a host that has not accepted a grant"
        );

        let conn = open_connection(&registry.inner.db_path).unwrap();
        conn.execute(
            "UPDATE incarnations SET launch_state='starting' WHERE incarnation_id=?1",
            params![prepared.incarnation_id.as_str()],
        )
        .unwrap();
        drop(conn);
        assert_eq!(
            registry
                .opencode_transfer_receipt_candidates()
                .await
                .unwrap(),
            vec![prepared.incarnation_id.clone()],
            "starting launches may have a host-persisted ack whose supervisor marker was lost",
        );

        let conn = open_connection(&registry.inner.db_path).unwrap();
        conn.execute(
            "UPDATE incarnations SET launch_state='failed' WHERE incarnation_id=?1",
            params![prepared.incarnation_id.as_str()],
        )
        .unwrap();
        drop(conn);
        assert!(!registry
            .opencode_transfer_stage_references()
            .await
            .unwrap()
            .contains_key("transfer-ref"));
    }

    #[tokio::test]
    async fn native_import_origin_has_one_owner_across_destination_stores_and_survives_retirement()
    {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let mut first_descriptor = opencode_transfer_descriptor("origin-owner-a");
        first_descriptor.destination_store_id = "destination-a".into();
        first_descriptor.incarnation_id = "incarnation-origin-owner-a".into();
        let mut competing_descriptor = first_descriptor.clone();
        competing_descriptor.transfer_id = "origin-owner-b".into();
        competing_descriptor.destination_store_id = "destination-b".into();
        competing_descriptor.incarnation_id = "incarnation-origin-owner-b".into();
        let (first_result, competing_result) = tokio::join!(
            registry.prepare_launch(opencode_prep(
                SoulId::new(),
                RequestId::new(),
                &first_descriptor,
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            )),
            registry.prepare_launch(opencode_prep(
                SoulId::new(),
                RequestId::new(),
                &competing_descriptor,
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            )),
        );
        let (winner, loser) = match (first_result, competing_result) {
            (Ok(first), Err(error)) | (Err(error), Ok(first)) => (first, error),
            (Ok(_), Ok(_)) => panic!("two souls claimed one native import origin"),
            (Err(error), Err(other)) => panic!("both origin claims failed: {error}; {other}"),
        };
        assert!(matches!(loser, RegistryError::NativeIdentityConflict));

        registry
            .mark_stop_outcome(winner.incarnation_id.clone(), StopOutcome::VerifiedEmpty)
            .await
            .unwrap();
        let conn = open_connection(&registry.inner.db_path).unwrap();
        let (owner, state, generation): (String, String, String) = conn
            .query_row(
                "SELECT owner_soul_id,ownership_state,source_generation FROM native_origin_owners WHERE provider='opencode' AND source_store_id=?1 AND native_root_session_id=?2",
                params![first_descriptor.source_store_id, first_descriptor.root_session_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(owner, winner.soul_id.as_str());
        assert_eq!(state, "owned");
        assert_eq!(generation, first_descriptor.source_generation);
    }

    #[tokio::test]
    async fn native_import_refresh_requires_complete_absence_and_rejects_reordered_observations() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let mut descriptor = opencode_transfer_descriptor("native-import-refresh");
        descriptor.destination_store_id = "destination-import-refresh".into();
        descriptor.incarnation_id = "incarnation-import-refresh".into();
        let prepared = registry
            .prepare_launch(opencode_prep(
                SoulId::new(),
                RequestId::new(),
                &descriptor,
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ))
            .await
            .unwrap();
        let captured = registry
            .recovery_write_fence(prepared.soul_id.clone())
            .await
            .unwrap();
        let absent = NativeImportObservation {
            state: NativeImportState::Absent,
            source_store_id: Some(descriptor.source_store_id.clone()),
            root_session_id: Some(descriptor.root_session_id.clone()),
            source_generation: Some(descriptor.source_generation.clone()),
            schema_fingerprint: Some(descriptor.source_schema_fingerprint.clone()),
            migration_fingerprint: Some(descriptor.migration_journal_fingerprint.clone()),
            complete_source_inventory: None,
        };
        assert!(
            registry
                .record_native_import_observation(
                    prepared.soul_id.clone(),
                    captured.clone(),
                    absent.clone(),
                )
                .await
                .is_err(),
            "an unreadable or partial inventory cannot be recorded as absent"
        );

        let mut absent = absent;
        absent.complete_source_inventory = Some(CompleteNativeImportInventory {
            source_store_id: descriptor.source_store_id.clone(),
            root_session_id: descriptor.root_session_id.clone(),
            source_generation: descriptor.source_generation.clone(),
            schema_fingerprint: descriptor.source_schema_fingerprint.clone(),
            migration_fingerprint: descriptor.migration_journal_fingerprint.clone(),
            inventory_fingerprint: "f".repeat(64),
        });
        registry
            .record_native_import_observation(prepared.soul_id.clone(), captured.clone(), absent)
            .await
            .unwrap();
        let stale = NativeImportObservation {
            state: NativeImportState::Available,
            source_store_id: Some(descriptor.source_store_id.clone()),
            root_session_id: Some(descriptor.root_session_id.clone()),
            source_generation: Some(descriptor.source_generation.clone()),
            schema_fingerprint: Some(descriptor.source_schema_fingerprint.clone()),
            migration_fingerprint: Some(descriptor.migration_journal_fingerprint.clone()),
            complete_source_inventory: None,
        };
        assert!(
            registry
                .record_native_import_observation(prepared.soul_id, captured, stale)
                .await
                .is_err(),
            "a late refresh from an older evidence revision cannot overwrite absence"
        );
    }

    #[tokio::test]
    async fn committed_prepared_reference_recovers_registration_and_same_request_after_restart() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path().join("registry"), None).unwrap();
        let staging_root = dir.path().join("runtime");
        let descriptor = opencode_transfer_descriptor("transfer-prepared-restart");
        let soul_id = SoulId::new();
        let request_id = RequestId::new();
        let limits = crate::opencode_transfer::StagingLimits::for_test(8, 8);

        let staging =
            crate::opencode_transfer::OpenCodeTransferStaging::new(&staging_root, limits).unwrap();
        staging
            .begin(&descriptor, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 8)
            .unwrap();
        staging
            .write_chunk(&opencode_chunk(
                &descriptor,
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ))
            .unwrap();
        staging
            .finalize(&descriptor.transfer_id, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
            .unwrap();
        staging
            .mark_launch_registering(&descriptor, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", false)
            .unwrap();

        let prepared = registry
            .prepare_launch(opencode_prep(
                soul_id.clone(),
                request_id.clone(),
                &descriptor,
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ))
            .await
            .unwrap();
        assert!(!prepared.existing_request);
        assert_eq!(prepared.incarnation_id.as_str(), descriptor.incarnation_id);
        drop(staging);

        let references = registry.opencode_transfer_stage_references().await.unwrap();
        assert_eq!(
            references.get(&descriptor.transfer_id),
            Some(&vec![descriptor.clone()])
        );
        let restarted =
            crate::opencode_transfer::OpenCodeTransferStaging::new(&staging_root, limits).unwrap();
        restarted.reconcile_registering_ready(&references).unwrap();
        assert!(matches!(
            restarted
                .begin(&descriptor, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 8,)
                .unwrap(),
            crate::opencode_transfer::StagingStart::Started {
                next_sequence: 1,
                ..
            }
        ));

        let retried = registry
            .prepare_launch(opencode_prep(
                soul_id,
                request_id,
                &descriptor,
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            ))
            .await
            .unwrap();
        assert!(retried.existing_request);
        assert_eq!(retried.incarnation_id, prepared.incarnation_id);
        restarted
            .mark_launch_registering(&descriptor, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", true)
            .unwrap();
        restarted
            .mark_launch_claimed(&descriptor, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
            .unwrap();
    }

    #[cfg(unix)]
    async fn observe_opencode_readiness_identity(registry: &Registry, soul: &SoulId) {
        let context = registry.recovery_context(soul.clone()).await.unwrap();
        let view = registry
            .inventory()
            .await
            .unwrap()
            .into_iter()
            .find(|view| &view.incarnation_id == context.prior_handle.incarnation_id())
            .unwrap();
        let launch = registry
            .bind_native_identity_launch(freshell_runtime_protocol::NativeIdentityLaunch {
                incarnation_id: view.incarnation_id,
                launch_nonce: context.prior_handle.launch_nonce().as_str().into(),
                evidence_revision: context.evidence_revision,
                execution_generation: view.execution_generation,
                requested_native_session_id: context.native_session_id.clone(),
            })
            .await
            .unwrap();
        registry
            .record_native_identity_observation(
                soul.clone(),
                freshell_runtime_protocol::NativeIdentityObservation {
                    native_session_id: context.native_session_id.clone().unwrap(),
                    incarnation_id: launch.incarnation_id,
                    launch_nonce: launch.launch_nonce,
                    evidence_revision: launch.evidence_revision,
                    source: freshell_runtime_protocol::NativeIdentitySource::OpencodeTui,
                    evidence_digest: format!(
                        "{:x}",
                        Sha256::digest(b"synthetic scoped OpenCode readiness")
                    ),
                },
                context.write_fence(),
            )
            .await
            .unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "process-kill recovery test; run only through scripts/sandbox-test.sh"]
    async fn opencode_registry_readiness_commit_survives_process_crash_and_reopen() {
        use std::{os::unix::process::ExitStatusExt, process::Command};

        const ROOT_ENV: &str = "FRESHELL_OPENCODE_REGISTRY_CRASH_ROOT";
        const POINT_ENV: &str = "FRESHELL_OPENCODE_REGISTRY_CRASH_POINT";
        let executable = std::env::current_exe().expect("resolve this test executable");

        for point in ["before_mark_running", "after_mark_running"] {
            let dir = tempfile::tempdir().expect("create synthetic registry root");
            let child = Command::new(&executable)
                .args([
                    "--exact",
                    "registry::tests::opencode_registry_readiness_commit_crash_child",
                    "--ignored",
                    "--nocapture",
                ])
                .env(ROOT_ENV, dir.path())
                .env(POINT_ENV, point)
                .status()
                .expect("spawn synthetic registry crash child");
            assert_eq!(
                child.signal(),
                Some(libc::SIGKILL),
                "child must die at {point}; exit={child:?}"
            );

            let registry = Registry::open(dir.path(), None).expect("reopen production registry");
            let mut descriptor = opencode_transfer_descriptor("transfer-registry-crash");
            descriptor.incarnation_id = "incarnation-opencode-registry-crash".into();
            let soul_id = SoulId::parse("soul-opencode-registry-crash").unwrap();
            let request_id = RequestId::parse("request-opencode-registry-crash").unwrap();
            let replay = registry
                .prepare_launch(opencode_prep(
                    soul_id.clone(),
                    request_id,
                    &descriptor,
                    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                ))
                .await
                .expect("same synthetic launch must be recoverable after process death");
            assert!(replay.existing_request);
            assert_eq!(replay.incarnation_id.as_str(), descriptor.incarnation_id);
            // Revalidate the current scoped loader observation after reopen,
            // exactly as readiness retry requires for a genuine provider.
            observe_opencode_readiness_identity(&registry, &soul_id).await;

            if point == "before_mark_running" {
                assert_eq!(replay.state, LaunchState::Starting);
                assert_eq!(
                    registry
                        .opencode_transfer_receipt_candidates()
                        .await
                        .unwrap(),
                    vec![replay.incarnation_id.clone()],
                    "the interrupted readiness commit remains a recovery candidate"
                );
                registry
                    .mark_running(replay.incarnation_id.clone())
                    .await
                    .expect("registry readiness commit is retryable after host revalidation");
            } else {
                assert_eq!(
                    replay.state,
                    LaunchState::Running,
                    "a committed readiness state survives process death"
                );
                assert_eq!(
                    registry
                        .opencode_transfer_receipt_candidates()
                        .await
                        .unwrap(),
                    vec![replay.incarnation_id.clone()],
                    "running transfers remain candidates until the host receipt is revalidated"
                );
            }
            drop(registry);

            let reopened = Registry::open(dir.path(), None).expect("reopen after readiness retry");
            let committed = reopened
                .prepare_launch(opencode_prep(
                    soul_id,
                    RequestId::parse("request-opencode-registry-crash").unwrap(),
                    &descriptor,
                    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                ))
                .await
                .unwrap();
            assert_eq!(committed.state, LaunchState::Running);
            let connection = open_connection(&reopened.inner.db_path).unwrap();
            let command_state: String = connection
                .query_row(
                    "SELECT state FROM commands WHERE request_id=?1",
                    params!["request-opencode-registry-crash"],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(command_state, "running");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "child fixture for opencode_registry_readiness_commit_survives_process_crash_and_reopen"]
    async fn opencode_registry_readiness_commit_crash_child() {
        const ROOT_ENV: &str = "FRESHELL_OPENCODE_REGISTRY_CRASH_ROOT";
        const POINT_ENV: &str = "FRESHELL_OPENCODE_REGISTRY_CRASH_POINT";
        let Some(root) = std::env::var_os(ROOT_ENV).map(PathBuf::from) else {
            return;
        };
        let point = std::env::var(POINT_ENV).expect("crash checkpoint");
        let registry = Registry::open(&root, None).expect("create synthetic production registry");
        let mut descriptor = opencode_transfer_descriptor("transfer-registry-crash");
        descriptor.incarnation_id = "incarnation-opencode-registry-crash".into();
        let soul_id = SoulId::parse("soul-opencode-registry-crash").unwrap();
        let prepared = registry
            .prepare_launch(opencode_prep(
                soul_id.clone(),
                RequestId::parse("request-opencode-registry-crash").unwrap(),
                &descriptor,
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ))
            .await
            .unwrap();
        registry
            .commit_created(
                prepared.incarnation_id.clone(),
                BackendCreatedRecord {
                    daemon_id: DockerDaemonId::new(),
                    container_id: "synthetic-opencode-container".into(),
                    image_ref: descriptor.target_image_ref.clone(),
                    runtime_dir: root.join("runtime"),
                    host_binary_path: root.join("freshell-session-host"),
                    immutable_config_digest: "synthetic-config-digest".into(),
                    launch_policy: None,
                },
            )
            .await
            .unwrap();
        registry
            .commit_execution_grant(prepared.incarnation_id.clone(), HostBootId::new(), limits())
            .await
            .unwrap();
        observe_opencode_readiness_identity(&registry, &soul_id).await;
        if point == "before_mark_running" {
            unsafe {
                libc::kill(libc::getpid(), libc::SIGKILL);
            }
            std::process::abort();
        }
        registry
            .mark_running(prepared.incarnation_id)
            .await
            .unwrap();
        assert_eq!(point, "after_mark_running");
        unsafe {
            libc::kill(libc::getpid(), libc::SIGKILL);
        }
        std::process::abort();
    }

    #[tokio::test]
    async fn stage_reference_query_rejects_an_unreadable_transfer_descriptor() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let prepared = registry
            .prepare_launch(prep(SoulId::new(), RequestId::new(), "transfer-ref-bad"))
            .await
            .unwrap();
        let conn = open_connection(&registry.inner.db_path).unwrap();
        conn.execute(
            "UPDATE incarnations SET terminal_spec=?1 WHERE incarnation_id=?2",
            params![
                serde_json::json!({
                    "opencodeTransfer": {"transferId": "transfer-ref-bad"}
                })
                .to_string(),
                prepared.incarnation_id.as_str()
            ],
        )
        .unwrap();
        drop(conn);

        assert!(registry.opencode_transfer_stage_references().await.is_err());
    }

    #[tokio::test]
    async fn launch_policy_survives_commit_reopen_and_legacy_epoch_upgrade() {
        let root = tempfile::tempdir().unwrap();
        let registry = Registry::open(root.path(), None).unwrap();
        assert_eq!(registry.control_epoch(), 1);
        let soul = SoulId::new();
        let prepared = registry
            .prepare_launch(prep(soul.clone(), RequestId::new(), "profile-persistence"))
            .await
            .unwrap();
        registry
            .commit_created(
                prepared.incarnation_id.clone(),
                BackendCreatedRecord {
                    daemon_id: DockerDaemonId::new(),
                    container_id: "a".repeat(64),
                    image_ref: format!("sha256:{}", "b".repeat(64)),
                    runtime_dir: root.path().join("incarnation"),
                    host_binary_path: root.path().join("host"),
                    immutable_config_digest: "saved-modern-digest".into(),
                    launch_policy: Some(
                        freshell_runtime_protocol::RuntimeLaunchPolicy::ProviderVolumeV1,
                    ),
                },
            )
            .await
            .unwrap();
        assert_eq!(
            registry
                .owned_handle(prepared.incarnation_id.clone())
                .await
                .unwrap()
                .launch_policy(),
            Some(freshell_runtime_protocol::RuntimeLaunchPolicy::ProviderVolumeV1)
        );
        drop(registry);
        let registry = Registry::open(root.path(), None).unwrap();
        assert_eq!(registry.control_epoch(), 2);
        let modern = registry
            .owned_handle(prepared.incarnation_id.clone())
            .await
            .unwrap();
        assert_eq!(
            modern.launch_policy(),
            Some(freshell_runtime_protocol::RuntimeLaunchPolicy::ProviderVolumeV1)
        );
        assert_eq!(modern.immutable_config_digest(), "saved-modern-digest");
        drop(registry);
        let conn = open_connection(&root.path().join("runtime.sqlite3")).unwrap();
        conn.execute_batch("ALTER TABLE incarnations DROP COLUMN launch_policy; UPDATE installation SET schema_version=14; UPDATE incarnations SET immutable_config_digest='saved-legacy-digest';").unwrap();
        drop(conn);
        let registry = Registry::open(root.path(), None).unwrap();
        assert_eq!(registry.control_epoch(), 3);
        let legacy = registry
            .owned_handle(prepared.incarnation_id.clone())
            .await
            .unwrap();
        assert_eq!(legacy.launch_policy(), None);
        assert_eq!(legacy.immutable_config_digest(), "saved-legacy-digest");
        assert_eq!(legacy.container_id(), modern.container_id());
        assert_eq!(legacy.image_ref(), modern.image_ref());
        let conn = open_connection(&root.path().join("runtime.sqlite3")).unwrap();
        conn.execute(
            "UPDATE incarnations SET launch_policy=?1",
            ["\"unknown_future_policy\""],
        )
        .unwrap();
        drop(conn);
        assert!(
            registry
                .owned_handle(prepared.incarnation_id)
                .await
                .is_err(),
            "unknown policies cannot silently become legacy"
        );
    }

    pub(crate) async fn materialize_test_runtime(
        registry: &Registry,
        soul_id: SoulId,
    ) -> PreparedLaunch {
        let prepared = registry
            .prepare_launch(prep(soul_id, RequestId::new(), "materialized"))
            .await
            .unwrap();
        let daemon = DockerDaemonId::new();
        let runtime_dir = format!("/tmp/freshell-runtime-test/{}", prepared.incarnation_id);
        let host_binary = format!("{runtime_dir}/freshell-session-host");
        let conn = open_connection(&registry.inner.db_path).unwrap();
        conn.execute(
            "UPDATE incarnations SET docker_daemon_id=?1,container_id=?2,image_ref='phase3-test-image',runtime_dir=?3,host_binary_path=?4,immutable_config_digest='sha256:phase3-test',launch_state='running' WHERE incarnation_id=?5",
            params![
                daemon.as_str(),
                format!("container-{}", prepared.incarnation_id),
                runtime_dir,
                host_binary,
                prepared.incarnation_id.as_str()
            ],
        )
        .unwrap();
        prepared
    }

    pub(crate) async fn materialize_fresh_runtime(
        registry: &Registry,
        soul_id: SoulId,
        workspace: &Path,
    ) -> PreparedLaunch {
        let mut launch = prep(soul_id, RequestId::new(), "fresh-materialized");
        let workspace = std::fs::canonicalize(workspace).unwrap();
        launch.provider = "claude".into();
        launch.provider_store_id = "fresh-store".into();
        launch.fresh_agent = Some(FreshAgentLaunchSpec {
            session_id: "fresh-session".into(),
            provider: freshell_runtime_protocol::FreshProvider::Claude,
            session_type: "freshclaude".into(),
            runtime_variant: "claude-sdk-sidecar".into(),
            provider_store_id: "fresh-store".into(),
            cwd: workspace.to_string_lossy().into_owned(),
            workspace_path: workspace.to_string_lossy().into_owned(),
            git_common_dir: None,
            run_as_uid: 65_534,
            run_as_gid: 0,
            model: Some("initial-model".into()),
            effort: Some("low".into()),
            permission_mode: Some("ask".into()),
            sandbox: Some("workspace-write".into()),
            native_session_id: None,
            plugins: None,
            model_selection: None,
            session_ref: None,
            fixture_transport: None,
            provider_bootstrap_files: Vec::new(),
            provider_secret_references: Vec::new(),
            provider_launch_context: None,
        });
        let prepared = registry.prepare_launch(launch).await.unwrap();
        let runtime_dir = format!("/tmp/freshell-runtime-test/{}", prepared.incarnation_id);
        let conn = open_connection(&registry.inner.db_path).unwrap();
        conn.execute(
            "UPDATE incarnations SET docker_daemon_id=?1,container_id=?2,image_ref='phase3-test-image',runtime_dir=?3,host_binary_path=?4,immutable_config_digest='sha256:phase3-test',launch_state='running' WHERE incarnation_id=?5",
            params![
                DockerDaemonId::new().as_str(),
                format!("container-{}", prepared.incarnation_id),
                runtime_dir,
                format!("{runtime_dir}/freshell-session-host"),
                prepared.incarnation_id.as_str()
            ],
        )
        .unwrap();
        prepared
    }

    #[tokio::test]
    async fn request_dedupe_returns_same_incarnation_and_conflict_rejects_changed_payload() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let soul = SoulId::new();
        let request = RequestId::new();
        let first = registry
            .prepare_launch(prep(soul.clone(), request.clone(), "one"))
            .await
            .unwrap();
        let replay = registry
            .prepare_launch(prep(soul.clone(), request.clone(), "one"))
            .await
            .unwrap();
        assert_eq!(first.incarnation_id, replay.incarnation_id);
        assert!(replay.existing_request);
        let conflict = registry
            .prepare_launch(prep(soul, request, "two"))
            .await
            .unwrap_err();
        assert!(matches!(conflict, RegistryError::RequestConflict));
    }

    #[tokio::test]
    async fn request_dedupe_survives_registry_restart_with_active_incarnation() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let installation = registry.installation_id().clone();
        let soul = SoulId::new();
        let request = RequestId::new();
        let first = registry
            .prepare_launch(prep(soul.clone(), request.clone(), "one"))
            .await
            .unwrap();
        let conn = open_connection(&registry.inner.db_path).unwrap();
        conn.execute(
            "UPDATE incarnations SET docker_daemon_id=?1,container_id='container-one',image_ref='image-one',runtime_dir='/tmp/runtime-one',host_binary_path='/tmp/host-one',immutable_config_digest='digest-one',launch_state='running' WHERE incarnation_id=?2",
            params![DockerDaemonId::new().as_str(), first.incarnation_id.as_str()],
        )
        .unwrap();
        drop(conn);
        drop(registry);

        let reopened = Registry::open(dir.path(), Some(installation)).unwrap();
        let replay = reopened
            .prepare_launch(prep(soul, request, "one"))
            .await
            .unwrap();
        assert_eq!(first.incarnation_id, replay.incarnation_id);
        assert_eq!(replay.state, LaunchState::Running);
        assert!(replay.existing_request);
    }

    #[tokio::test]
    async fn new_request_adopts_only_semantically_identical_live_incarnation() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let soul = SoulId::new();
        let first = materialize_test_runtime(&registry, soul.clone()).await;

        let adopted = registry
            .prepare_launch(prep(soul.clone(), RequestId::new(), "materialized"))
            .await
            .unwrap();
        assert_eq!(adopted.incarnation_id, first.incarnation_id);
        assert_eq!(adopted.state, LaunchState::Running);
        assert!(adopted.existing_request);

        let conflict = registry
            .prepare_launch(prep(soul.clone(), RequestId::new(), "different"))
            .await
            .unwrap_err();
        assert!(matches!(conflict, RegistryError::ActiveIncarnation(id) if id == soul));

        let conn = open_connection(&registry.inner.db_path).unwrap();
        let bound_commands: u64 = conn
            .query_row(
                "SELECT COUNT(*) FROM commands WHERE incarnation_id=?1",
                params![first.incarnation_id.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(bound_commands, 2);
    }

    #[tokio::test]
    async fn provider_secret_registry_persists_source_and_capability_reference_without_contents() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let keys = workspace.path().join("keys.env");
        let secret = "amplifier-onecli-secret-never-persist";
        std::fs::write(&keys, format!("LUNAROUTE_API_KEY={secret}\n")).unwrap();
        let keys = std::fs::canonicalize(keys).unwrap();
        let workspace_path = std::fs::canonicalize(workspace.path()).unwrap();

        let registry = Registry::open(dir.path(), None).unwrap();
        let mut launch = prep(SoulId::new(), RequestId::new(), "bootstrap-ref-only");
        launch.provider = "amplifier".into();
        launch.terminal = Some(TerminalLaunchSpec {
            terminal_id: "terminal-bootstrap".into(),
            stream_id: "stream-bootstrap".into(),
            mode: "amplifier".into(),
            program: "/bin/true".into(),
            args: Vec::new(),
            env: std::collections::BTreeMap::new(),
            cwd: workspace_path.to_string_lossy().into_owned(),
            run_as_uid: 65_534,
            run_as_gid: 0,
            cols: 80,
            rows: 24,
            project_key: "bootstrap-test".into(),
            workspace_path: workspace_path.to_string_lossy().into_owned(),
            git_common_dir: None,
            create_request_id: Some("create-bootstrap".into()),
            resume_session_id: Some("session-bootstrap".into()),
            provider_model: None,
            provider_reasoning_effort: None,
            provider_sandbox: None,
            provider_permission_mode: None,
            provider_bootstrap_files: Vec::new(),
            provider_secret_references: vec![freshell_runtime_protocol::ProviderSecretReference {
                provider_relative_path: None,
                source_path: keys.to_string_lossy().into_owned(),
                profile:
                    freshell_runtime_protocol::ProviderSecretProfile::AmplifierOnecliLunarouteGlm53,
            }],
            provider_launch_context: Some(freshell_runtime_protocol::ProviderLaunchContext {
                prepared_inputs: None,
                preparation: freshell_runtime_protocol::ProviderPreparation::Amplifier {
                    bundle: "default".into(),
                    resume_args: Vec::new(),
                },
                mcp_capability: Some(freshell_runtime_protocol::McpCapabilityReference {
                    grant_id: "grant-registry-reference".into(),
                    endpoint: "http://host.docker.internal:3001/api/mcp".into(),
                    provider_relative_path: ".amplifier/freshell-mcp.json".into(),
                    host_gateway_address: None,
                }),
                config: Vec::new(),
            }),
            opencode_transfer: None,
            opencode_transfer_attempt_id: None,
            opencode_adoption: None,
        });
        for raw in [
            vec!["--api-key".into(), secret.into()],
            vec![format!("--api-key={secret}")],
        ] {
            assert!(freshell_runtime_protocol::durable_managed_terminal_args(
                "amplifier",
                raw.clone(),
                None
            )
            .is_err());
            let mut raw_launch = launch.clone();
            raw_launch.terminal.as_mut().unwrap().args = raw;
            assert!(matches!(
                registry.prepare_launch(raw_launch).await,
                Err(RegistryError::InvalidState(_))
            ));
            let conn = open_connection(&registry.inner.db_path).unwrap();
            let rows: i64 = conn
                .query_row("SELECT COUNT(*) FROM incarnations", [], |row| row.get(0))
                .unwrap();
            assert_eq!(rows, 0, "raw terminal argv reached durable registry");
        }
        assert!(!serde_json::to_string(launch.terminal.as_ref().unwrap())
            .unwrap()
            .contains(secret));
        registry.prepare_launch(launch).await.unwrap();

        let conn = open_connection(&registry.inner.db_path).unwrap();
        let terminal_json: String = conn
            .query_row(
                "SELECT terminal_spec FROM incarnations LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(terminal_json.contains(&keys.to_string_lossy().to_string()));
        assert!(terminal_json.contains("amplifier_onecli_lunaroute_glm53"));
        assert!(terminal_json.contains("grant-registry-reference"));
        assert!(!terminal_json.contains("onecli.example.invalid"));
        assert!(!terminal_json.contains(secret));
        drop(conn);

        let mut durable_bytes = Vec::new();
        for candidate in [
            registry.inner.db_path.clone(),
            registry.inner.db_path.with_extension("sqlite3-wal"),
        ] {
            if let Ok(bytes) = std::fs::read(candidate) {
                durable_bytes.extend(bytes);
            }
        }
        assert!(
            !String::from_utf8_lossy(&durable_bytes).contains(secret),
            "OneCLI secret bytes must never enter supervisor durable state"
        );
    }

    #[tokio::test]
    async fn opencode_inline_secret_stays_out_of_registry_row_and_digest() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace_path = std::fs::canonicalize(workspace.path()).unwrap();
        let secret = "nested-command-argument-secret";
        let private_stage = tempfile::tempdir().unwrap();
        std::fs::write(
            private_stage.path().join("inline-config.json"),
            format!(r#"{{"mcp":{{"vendor":{{"type":"local","command":["tool","--token","{secret}"]}}}}}}"#),
        ).unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let mut launch = prep(SoulId::new(), RequestId::new(), "typed-opencode-launch");
        launch.provider = "opencode".into();
        launch.terminal = Some(TerminalLaunchSpec {
            terminal_id: "terminal-inline".into(),
            stream_id: "stream-inline".into(),
            mode: "opencode".into(),
            program: "/bin/true".into(),
            args: Vec::new(),
            env: std::collections::BTreeMap::new(),
            cwd: workspace_path.to_string_lossy().into_owned(),
            run_as_uid: 65_534,
            run_as_gid: 0,
            cols: 80,
            rows: 24,
            project_key: "inline-test".into(),
            workspace_path: workspace_path.to_string_lossy().into_owned(),
            git_common_dir: None,
            create_request_id: None,
            resume_session_id: None,
            provider_model: None,
            provider_reasoning_effort: None,
            provider_sandbox: None,
            provider_permission_mode: None,
            provider_bootstrap_files: Vec::new(),
            provider_secret_references: Vec::new(),
            provider_launch_context: Some(freshell_runtime_protocol::ProviderLaunchContext {
                prepared_inputs: None,
                preparation: freshell_runtime_protocol::ProviderPreparation::Opencode {
                    project_config: Vec::new(),
                    tui_config: None,
                    tui_source: None,
                    inline_config: true,
                },
                mcp_capability: Some(freshell_runtime_protocol::McpCapabilityReference {
                    grant_id: "grant-inline".into(),
                    endpoint: "http://host.docker.internal:3001".into(),
                    provider_relative_path: ".freshell/mcp-capability.json".into(),
                    host_gateway_address: None,
                }),
                config: Vec::new(),
            }),
            opencode_transfer: None,
            opencode_transfer_attempt_id: None,
            opencode_adoption: None,
        });
        let digest_input = serde_json::to_vec(launch.terminal.as_ref().unwrap()).unwrap();
        assert!(!String::from_utf8_lossy(&digest_input).contains(secret));
        registry.prepare_launch(launch).await.unwrap();
        let conn = open_connection(&registry.inner.db_path).unwrap();
        let (row, digest): (String, String) = conn.query_row(
            "SELECT i.terminal_spec,c.payload_digest FROM incarnations i JOIN commands c ON c.incarnation_id=i.incarnation_id LIMIT 1",
            [], |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert!(row.contains("inline_config"));
        assert!(!row.contains(secret));
        assert!(!digest.contains(secret));
        for candidate in [
            registry.inner.db_path.clone(),
            registry.inner.db_path.with_extension("sqlite3-wal"),
        ] {
            if let Ok(bytes) = std::fs::read(candidate) {
                assert!(!String::from_utf8_lossy(&bytes).contains(secret));
            }
        }
    }

    #[test]
    fn second_supervisor_cannot_own_same_registry() {
        let dir = tempfile::tempdir().unwrap();
        let installation = InstallationId::new();
        let first = Registry::open(dir.path(), Some(installation.clone())).unwrap();
        let second = Registry::open(dir.path(), Some(installation));
        assert!(matches!(second, Err(RegistryError::Busy)));
        drop(first);
    }

    #[test]
    fn dropped_registry_releases_ownership_while_a_spawning_child_shares_its_lock() {
        let dir = tempfile::tempdir().unwrap();
        let first = Registry::open(dir.path(), None).unwrap();
        // A child process spawned by any other thread holds a duplicate of
        // every descriptor between fork and exec, and the ownership lock
        // belongs to the open file description that duplicate shares.
        let spawning_child_copy = first.inner._owner_lock.0.try_clone().unwrap();
        drop(first);
        let reopened = Registry::open(dir.path(), None)
            .expect("the dropped owner's lock must not outlive it in a duplicate descriptor");
        assert!(
            matches!(Registry::open(dir.path(), None), Err(RegistryError::Busy)),
            "the reopened registry owns the root exclusively"
        );
        drop(reopened);
        drop(spawning_child_copy);
    }

    #[tokio::test]
    async fn handle_does_not_exist_until_container_identity_is_committed() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let prepared = registry
            .prepare_launch(prep(SoulId::new(), RequestId::new(), "x"))
            .await
            .unwrap();
        let err = registry
            .owned_handle(prepared.incarnation_id)
            .await
            .unwrap_err();
        assert!(matches!(err, RegistryError::InvalidState(_)));
    }

    #[tokio::test]
    async fn admission_is_transactional_and_same_request_does_not_reserve_twice() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let policy = AdmissionPolicy {
            installation: crate::admission::AdmissionBudget::new(500, 64 * 1024 * 1024, 32),
            project: crate::admission::AdmissionBudget::new(500, 64 * 1024 * 1024, 32),
        };
        let soul = SoulId::new();
        let request = RequestId::new();
        let mut first = prep(soul, request.clone(), "same");
        first.admission = policy;
        let prepared = registry.prepare_launch(first.clone()).await.unwrap();
        let replay = registry.prepare_launch(first).await.unwrap();
        assert_eq!(prepared.incarnation_id, replay.incarnation_id);
        let mut excess = prep(SoulId::new(), RequestId::new(), "other");
        excess.admission = policy;
        let error = registry.prepare_launch(excess).await.unwrap_err();
        assert!(matches!(error, RegistryError::BlockedResource { .. }));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn protected_command_journal_is_private_and_replays_only_queued_input() {
        use std::os::unix::fs::PermissionsExt as _;

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("registry");
        let registry = Registry::open(&root, None).unwrap();
        assert_eq!(
            std::fs::metadata(&root).unwrap().permissions().mode() & 0o777,
            0o700
        );

        let soul = SoulId::new();
        let prepared = materialize_test_runtime(&registry, soul.clone()).await;
        let request = RequestId::new();
        let payload = b"queued prompt\n";
        let (disposition, incarnation) = registry
            .begin_input(soul.clone(), request.clone(), payload, None)
            .await
            .unwrap();
        assert_eq!(disposition, InputJournalDisposition::Dispatch);
        assert_eq!(incarnation, prepared.incarnation_id);

        let conn = open_connection(&registry.inner.db_path).unwrap();
        let (stored, state): (Vec<u8>, String) = conn
            .query_row(
                "SELECT protected_payload,state FROM input_commands WHERE soul_id=?1 AND request_id=?2",
                params![soul.as_str(), request.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(stored, payload);
        assert_eq!(state, "queued");
        drop(conn);

        let claimed = registry
            .claim_next_queued_input(soul.clone(), prepared.incarnation_id.clone())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(claimed.request_id, request);
        assert_eq!(claimed.data.as_bytes(), payload);
        assert!(registry
            .claim_next_queued_input(soul.clone(), prepared.incarnation_id.clone())
            .await
            .unwrap()
            .is_none());

        registry
            .mark_input_ambiguous(soul.clone(), request.clone())
            .await
            .unwrap();
        let conn = open_connection(&registry.inner.db_path).unwrap();
        conn.execute(
            "UPDATE incarnations SET launch_state='stopped' WHERE incarnation_id=?1",
            params![prepared.incarnation_id.as_str()],
        )
        .unwrap();
        drop(conn);

        let (disposition, recorded_incarnation) = registry
            .begin_input(soul.clone(), request.clone(), payload, None)
            .await
            .unwrap();
        assert_eq!(disposition, InputJournalDisposition::Ambiguous);
        assert_eq!(recorded_incarnation, prepared.incarnation_id);
        assert!(matches!(
            registry
                .begin_input(soul, request, b"different\n", None)
                .await,
            Err(RegistryError::InputConflict)
        ));
    }

    #[tokio::test]
    async fn input_idempotency_digest_includes_fresh_agent_turn_settings() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let soul = SoulId::new();
        materialize_test_runtime(&registry, soul.clone()).await;
        let request = RequestId::new();

        registry
            .begin_input(
                soul.clone(),
                request.clone(),
                b"same prompt",
                Some(br#"{"model":"model-a"}"#),
            )
            .await
            .unwrap();
        assert!(matches!(
            registry
                .begin_input(
                    soul,
                    request,
                    b"same prompt",
                    Some(br#"{"model":"model-b"}"#),
                )
                .await,
            Err(RegistryError::InputConflict)
        ));
    }

    #[tokio::test]
    async fn fresh_create_inventory_correlates_launch_without_mislabeling_non_fresh_seeds() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let fresh_soul = SoulId::new();
        let prepared =
            materialize_fresh_runtime(&registry, fresh_soul.clone(), workspace.path()).await;
        let non_fresh_soul = SoulId::new();
        materialize_test_runtime(&registry, non_fresh_soul.clone()).await;
        let inventory = registry.inventory().await.unwrap();
        let fresh = inventory
            .iter()
            .find(|view| view.soul_id == fresh_soul)
            .unwrap();
        assert_eq!(fresh.native_session_id, None);
        assert_eq!(
            serde_json::to_value(fresh).unwrap()["freshAgentCreateRequestId"],
            "seed"
        );
        let non_fresh = inventory
            .iter()
            .find(|view| view.soul_id == non_fresh_soul)
            .unwrap();
        assert!(serde_json::to_value(non_fresh)
            .unwrap()
            .get("freshAgentCreateRequestId")
            .is_none());
        registry
            .record_native_session(
                fresh_soul.clone(),
                prepared.incarnation_id,
                "native-observed".into(),
            )
            .await
            .unwrap();
        let inventory = registry.inventory().await.unwrap();
        let fresh = inventory
            .iter()
            .find(|view| view.soul_id == fresh_soul)
            .unwrap();
        assert_eq!(fresh.native_session_id.as_deref(), Some("native-observed"));
        assert_eq!(
            serde_json::to_value(fresh).unwrap()["freshAgentCreateRequestId"],
            "seed"
        );
    }

    #[tokio::test]
    async fn native_fork_transitions_identity_in_place_and_replaces_the_writer_claim() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let soul = SoulId::new();
        let prepared = materialize_fresh_runtime(&registry, soul.clone(), workspace.path()).await;
        registry
            .record_native_session(
                soul.clone(),
                prepared.incarnation_id.clone(),
                "native-parent".into(),
            )
            .await
            .unwrap();
        let parent_context = registry.recovery_context(soul.clone()).await.unwrap();
        let parent_launch = registry
            .bind_native_identity_launch(freshell_runtime_protocol::NativeIdentityLaunch {
                incarnation_id: prepared.incarnation_id.clone(),
                launch_nonce: parent_context.prior_handle.launch_nonce().as_str().into(),
                evidence_revision: parent_context.evidence_revision,
                execution_generation: 0,
                requested_native_session_id: Some("native-parent".into()),
            })
            .await
            .unwrap();
        let parent_observation = freshell_runtime_protocol::NativeIdentityObservation {
            native_session_id: "native-parent".into(),
            incarnation_id: prepared.incarnation_id.clone(),
            launch_nonce: parent_launch.launch_nonce.clone(),
            evidence_revision: parent_launch.evidence_revision,
            source: freshell_runtime_protocol::NativeIdentitySource::FreshProviderHandshake,
            evidence_digest: "a".repeat(64),
        };
        registry
            .record_native_identity_observation(
                soul.clone(),
                parent_observation.clone(),
                parent_context.write_fence(),
            )
            .await
            .unwrap();
        // Model an already-qualified parent branch. A provider-native fork
        // invalidates this exact resume/checkpoint evidence even though the
        // soul and enclosure stay live.
        {
            let conn = open_connection(&registry.inner.db_path).unwrap();
            conn.execute(
                "UPDATE souls SET durability_state='checkpoint_captured', allocation_state='verified_durable', checkpoint_revision=9, resume_spec='{}' WHERE soul_id=?1",
                params![soul.as_str()],
            )
            .unwrap();
        }

        registry
            .transition_native_session(
                soul.clone(),
                prepared.incarnation_id.clone(),
                "native-parent",
                "native-child",
            )
            .await
            .unwrap();
        // A retry after the transition is idempotent, but an unrelated expected parent is not.
        registry
            .transition_native_session(
                soul.clone(),
                prepared.incarnation_id.clone(),
                "native-parent",
                "native-child",
            )
            .await
            .unwrap();
        assert!(matches!(
            registry
                .transition_native_session(
                    soul.clone(),
                    prepared.incarnation_id.clone(),
                    "foreign-parent",
                    "another-child",
                )
                .await,
            Err(RegistryError::NativeIdentityConflict)
        ));

        let context = registry.recovery_context(soul.clone()).await.unwrap();
        assert_eq!(context.native_session_id.as_deref(), Some("native-child"));
        let child_launch = context.native_identity_launch.as_ref().unwrap();
        let child_observation = freshell_runtime_protocol::NativeIdentityObservation {
            native_session_id: "native-child".into(),
            evidence_revision: parent_launch.evidence_revision + 1,
            ..parent_observation.clone()
        };
        registry
            .record_native_identity_observation(
                soul.clone(),
                child_observation.clone(),
                context.write_fence(),
            )
            .await
            .expect("the current child observation must match the transitioned launch");
        assert!(child_observation.matches_launch(child_launch));
        assert!(registry
            .record_native_identity_observation(
                soul.clone(),
                parent_observation,
                context.write_fence()
            )
            .await
            .is_err());
        assert_eq!(context.resume_spec, None);
        assert_eq!(context.allocation_state, AllocationState::Materializing);
        assert_eq!(context.durability_state, DurabilityState::LiveOnly);
        assert_eq!(context.checkpoint_revision, 0);
        let child_candidate =
            crate::resume_catalog::exact_resume_candidate(&context, Some("native-child"))
                .unwrap()
                .expect(
                    "the live child identity can immediately construct its own resume candidate",
                );
        assert_eq!(
            child_candidate.provider_session.native_session_id,
            "native-child"
        );
        assert_eq!(child_candidate.checkpoint_revision, 0);
        assert_eq!(
            context
                .fresh_agent
                .as_ref()
                .and_then(|spec| spec.native_session_id.as_deref()),
            Some("native-child")
        );
        assert_eq!(
            context
                .fresh_agent
                .as_ref()
                .map(|spec| spec.session_id.as_str()),
            Some("native-child"),
            "inventory fallback must not resurrect the retired presentation alias",
        );
        let inventory = registry.inventory().await.unwrap();
        let view = inventory
            .iter()
            .find(|view| view.soul_id == soul)
            .expect("forked soul remains inventoried");
        assert_eq!(view.fresh_agent_session_id.as_deref(), Some("native-child"));
        assert_ne!(
            view.fresh_agent_session_id.as_deref(),
            Some("fresh-session")
        );
        assert_eq!(
            context.prior_handle.incarnation_id(),
            &prepared.incarnation_id
        );
        let conn = open_connection(&registry.inner.db_path).unwrap();
        let parent_claims: u64 = conn.query_row(
            "SELECT COUNT(*) FROM writer_claims WHERE soul_id=?1 AND native_session_id='native-parent'",
            params![soul.as_str()], |row| row.get(0),
        ).unwrap();
        let child_claims: u64 = conn.query_row(
            "SELECT COUNT(*) FROM writer_claims WHERE soul_id=?1 AND native_session_id='native-child' AND incarnation_id=?2",
            params![soul.as_str(), prepared.incarnation_id.as_str()], |row| row.get(0),
        ).unwrap();
        assert_eq!((parent_claims, child_claims), (0, 1));
    }

    #[tokio::test]
    async fn parent_backed_fork_registry_reopen_preserves_child_and_dispatch_invalidates_stale_probe(
    ) {
        use freshell_runtime_protocol::{ClaudeForkRecipe, ClaudeForkTarget};
        let dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let soul = SoulId::new();
        let prepared = materialize_fresh_runtime(&registry, soul.clone(), workspace.path()).await;
        let parent = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let child = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        registry
            .record_native_session(soul.clone(), prepared.incarnation_id.clone(), parent.into())
            .await
            .unwrap();
        let context = registry.recovery_context(soul.clone()).await.unwrap();
        let recipe = ClaudeForkRecipe {
            recovery_disabled: false,
            child_session_id: child.into(),
            parent_session_id: parent.into(),
            parent_transcript: format!(".claude/projects/work/{parent}.jsonl"),
            child_transcript: format!(".claude/projects/work/{child}.jsonl"),
            parent_sha256: "a".repeat(64),
            target: ClaudeForkTarget::Empty,
        };
        registry
            .transition_native_session_with_claude_fork_fenced(
                soul.clone(),
                prepared.incarnation_id,
                parent,
                child,
                context.write_fence(),
                Some(recipe.clone()),
            )
            .await
            .unwrap();
        drop(registry);
        let registry = Registry::open(dir.path(), None).unwrap();
        let context = registry.recovery_context(soul.clone()).await.unwrap();
        assert_eq!(context.native_session_id.as_deref(), Some(child));
        assert_eq!(context.claude_fork.as_ref(), Some(&recipe));
        let candidate = crate::resume_catalog::exact_resume_candidate(&context, Some(child))
            .unwrap()
            .unwrap();
        assert_eq!(candidate.claude_fork.as_ref(), Some(&recipe));
        registry
            .store_verified_resume_spec_fenced(soul.clone(), candidate, context.write_fence())
            .await
            .unwrap();
        let before = registry.recovery_context(soul.clone()).await.unwrap();
        let stale_probe = before.resume_spec.clone().unwrap();
        let input = RequestId::new();
        registry
            .begin_input(soul.clone(), input.clone(), b"child input", None)
            .await
            .unwrap();
        registry
            .mark_input_dispatching(soul.clone(), input.clone())
            .await
            .unwrap();
        let after = registry.recovery_context(soul.clone()).await.unwrap();
        let disabled = after
            .claude_fork
            .as_ref()
            .expect("retain the fork identity after retiring its recovery prefix");
        assert_eq!(
            serde_json::to_value(disabled).unwrap()["recoveryDisabled"],
            true,
            "disable older prefix in the durable dispatch transaction"
        );
        assert!(after.resume_spec.is_none());
        let disabled_candidate = crate::resume_catalog::exact_resume_candidate(&after, Some(child))
            .unwrap()
            .unwrap();
        assert!(disabled_candidate.claude_fork.unwrap().recovery_disabled);
        assert!(
            registry
                .store_verified_resume_spec_fenced(soul.clone(), stale_probe, before.write_fence())
                .await
                .is_err(),
            "a pre-dispatch probe cannot restore the retired recipe"
        );
        registry
            .mark_input_ambiguous(soul.clone(), input)
            .await
            .unwrap();
        drop(registry);
        let registry = Registry::open(dir.path(), None).unwrap();
        assert_eq!(
            serde_json::to_value(
                registry
                    .recovery_context(soul)
                    .await
                    .unwrap()
                    .claude_fork
                    .unwrap()
            )
            .unwrap()["recoveryDisabled"],
            true
        );
    }

    #[tokio::test]
    async fn terminal_claude_clear_persists_new_root_and_retires_parent_resume() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let soul = SoulId::new();
        let original = materialize_test_runtime(&registry, soul.clone()).await;
        let parent = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let child = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        let terminal: TerminalLaunchSpec = serde_json::from_value(serde_json::json!({
            "terminalId":"clear-terminal", "streamId":"clear-stream", "mode":"claude", "program":"claude",
            "cwd":"/workspace", "workspacePath":"/workspace", "projectKey":"clear",
            "runAsUid":65534, "runAsGid":0, "cols":80, "rows":24, "resumeSessionId":parent,
            "env":{"HOME":"/home/freshell/provider"}
        })).unwrap();
        let conn = open_connection(&registry.inner.db_path).unwrap();
        conn.execute(
            "UPDATE souls SET provider='claude' WHERE soul_id=?1",
            params![soul.as_str()],
        )
        .unwrap();
        conn.execute(
            "UPDATE incarnations SET terminal_spec=?1 WHERE incarnation_id=?2",
            params![
                serde_json::to_string(&terminal).unwrap(),
                original.incarnation_id.as_str()
            ],
        )
        .unwrap();
        registry
            .record_native_session(soul.clone(), original.incarnation_id.clone(), parent.into())
            .await
            .unwrap();
        let before = registry.recovery_context(soul.clone()).await.unwrap();
        let binding = registry
            .bind_native_identity_launch(freshell_runtime_protocol::NativeIdentityLaunch {
                incarnation_id: original.incarnation_id.clone(),
                launch_nonce: before.prior_handle.launch_nonce().as_str().into(),
                evidence_revision: before.evidence_revision,
                execution_generation: 0,
                requested_native_session_id: Some(parent.into()),
            })
            .await
            .unwrap();
        conn.execute("UPDATE souls SET resume_spec='{}',checkpoint_revision=4,durability_state='checkpoint_captured',allocation_state='verified_durable' WHERE soul_id=?1",params![soul.as_str()]).unwrap();
        crate::service::record_terminal_identity_observation(&registry, &before, child)
            .await
            .expect("qualified clear should reuse the atomic terminal reroot");
        assert!(
            crate::service::record_terminal_identity_observation(&registry, &before, parent)
                .await
                .is_err(),
            "an older output read cannot restore the retired root"
        );
        let current = registry.recovery_context(soul.clone()).await.unwrap();
        assert_eq!(current.native_session_id.as_deref(), Some(child));
        assert_eq!(
            current.resume_spec, None,
            "parent resume proof must be rebuilt from the new root"
        );
        assert_eq!(current.checkpoint_revision, 0);
        let observed = freshell_runtime_protocol::NativeIdentityObservation {
            native_session_id: child.into(),
            incarnation_id: original.incarnation_id.clone(),
            launch_nonce: binding.launch_nonce.clone(),
            evidence_revision: binding.evidence_revision,
            source: freshell_runtime_protocol::NativeIdentitySource::ClaudeNativeClear,
            evidence_digest: "a".repeat(64),
        };
        registry
            .record_native_identity_observation(
                soul.clone(),
                observed.clone(),
                current.write_fence(),
            )
            .await
            .expect("the same live launch can qualify its cleared root");
        let mut foreign = observed.clone();
        foreign.launch_nonce = "another-launch".into();
        assert!(registry
            .record_native_identity_observation(soul.clone(), foreign, current.write_fence())
            .await
            .is_err());
        let mut retired = observed;
        retired.native_session_id = parent.into();
        assert!(registry
            .record_native_identity_observation(soul.clone(), retired, current.write_fence())
            .await
            .is_err());
        let roots: Vec<String> = conn
            .prepare("SELECT native_session_id FROM writer_claims WHERE soul_id=?1")
            .unwrap()
            .query_map(params![soul.as_str()], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(roots, vec![child.to_string()]);
        drop(conn);
        drop(registry);
        let reopened = Registry::open(dir.path(), None).unwrap();
        let current = reopened.recovery_context(soul.clone()).await.unwrap();
        assert_eq!(
            current.native_session_id.as_deref(),
            Some(child),
            "a restarted supervisor must recover the new root"
        );
        let candidate = crate::resume_catalog::exact_resume_candidate(&current, None)
            .unwrap()
            .unwrap();
        let replacement =
            freshell_agent_runtime::prepare_terminal_for_resume(&terminal, &candidate).unwrap();
        assert_eq!(replacement.resume_session_id.as_deref(), Some(child));
        assert!(
            replacement
                .args
                .windows(2)
                .any(|args| args == ["--resume", child]),
            "the actual replacement adapter must resume the persisted cleared root"
        );
        let pending = current.clone();
        reopened.begin_stop(soul.clone()).await.unwrap();
        assert!(
            crate::service::record_terminal_identity_observation(&reopened, &pending, parent)
                .await
                .is_err(),
            "a late clear observation cannot override Stop"
        );
    }

    #[tokio::test]
    async fn fresh_claude_clear_retains_live_launch_and_retires_parent_resume() {
        use freshell_runtime_protocol::{
            NativeIdentityLaunch, NativeIdentityObservation, NativeIdentitySource,
        };
        let dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let soul = SoulId::new();
        let prepared = materialize_fresh_runtime(&registry, soul.clone(), workspace.path()).await;
        let parent = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let child = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        registry
            .record_native_session(soul.clone(), prepared.incarnation_id.clone(), parent.into())
            .await
            .unwrap();
        let before = registry.recovery_context(soul.clone()).await.unwrap();
        let launch = registry
            .bind_native_identity_launch(NativeIdentityLaunch {
                incarnation_id: prepared.incarnation_id.clone(),
                launch_nonce: before.prior_handle.launch_nonce().as_str().into(),
                evidence_revision: before.evidence_revision,
                execution_generation: 0,
                requested_native_session_id: Some(parent.into()),
            })
            .await
            .unwrap();
        let parent_observation = NativeIdentityObservation {
            native_session_id: parent.into(),
            incarnation_id: prepared.incarnation_id.clone(),
            launch_nonce: launch.launch_nonce.clone(),
            evidence_revision: launch.evidence_revision,
            source: NativeIdentitySource::FreshProviderHandshake,
            evidence_digest: "a".repeat(64),
        };
        registry
            .record_native_identity_observation(
                soul.clone(),
                parent_observation,
                before.write_fence(),
            )
            .await
            .unwrap();
        let conn = open_connection(&registry.inner.db_path).unwrap();
        let mut parent_resume = crate::checkpoints::tests::spec("claude");
        parent_resume.provider_session.native_session_id = parent.into();
        conn.execute("UPDATE souls SET resume_spec=?2, checkpoint_revision=4, durability_state='checkpoint_captured', allocation_state='verified_durable' WHERE soul_id=?1", params![soul.as_str(), serde_json::to_string(&parent_resume).unwrap()]).unwrap();
        let before = registry.recovery_context(soul.clone()).await.unwrap();
        let observation = NativeIdentityObservation {
            native_session_id: child.into(),
            incarnation_id: prepared.incarnation_id.clone(),
            launch_nonce: launch.launch_nonce.clone(),
            evidence_revision: launch.evidence_revision,
            source: NativeIdentitySource::ClaudeNativeClear,
            evidence_digest: "b".repeat(64),
        };
        for wrong_launch in [false, true] {
            let mut rejected = observation.clone();
            if wrong_launch {
                rejected.launch_nonce = "another-launch".into();
            } else {
                rejected.source = NativeIdentitySource::FreshProviderHandshake;
            }
            assert!(registry
                .transition_claude_clear_fenced(
                    soul.clone(),
                    prepared.incarnation_id.clone(),
                    parent,
                    child,
                    before.write_fence(),
                    rejected
                )
                .await
                .is_err());
            assert_eq!(
                registry
                    .recovery_context(soul.clone())
                    .await
                    .unwrap()
                    .native_session_id
                    .as_deref(),
                Some(parent)
            );
        }
        registry
            .transition_claude_clear_fenced(
                soul.clone(),
                prepared.incarnation_id.clone(),
                parent,
                child,
                before.write_fence(),
                observation.clone(),
            )
            .await
            .unwrap();
        let current = registry.recovery_context(soul.clone()).await.unwrap();
        assert_eq!(
            current.native_identity_launch.as_ref(),
            Some(&launch),
            "a clear changes the native root within the existing producer launch"
        );
        assert_eq!(current.native_session_id.as_deref(), Some(child));
        assert_eq!(current.resume_spec, None);
        assert_eq!(current.checkpoint_revision, 0);
        assert_eq!(
            current
                .prior_handle
                .fresh_agent()
                .unwrap()
                .native_session_id
                .as_deref(),
            Some(child)
        );
        let roots: Vec<String> = conn
            .prepare("SELECT native_session_id FROM writer_claims WHERE soul_id=?1")
            .unwrap()
            .query_map(params![soul.as_str()], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(roots, vec![child.to_string()]);
        registry
            .record_native_identity_observation(soul.clone(), observation, current.write_fence())
            .await
            .expect("actual clear proof still matches the immutable launch");
        // The clear remains the same producer, but a later explicit fork
        // starts a new native operation from that now-current cleared root.
        let grandchild = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        registry
            .transition_native_session_fenced(
                soul.clone(),
                prepared.incarnation_id.clone(),
                child,
                grandchild,
                current.write_fence(),
            )
            .await
            .expect("an explicit fork after native clear remains usable");
        let forked = registry.recovery_context(soul.clone()).await.unwrap();
        let fork_launch = forked.native_identity_launch.as_ref().unwrap();
        assert_eq!(fork_launch.evidence_revision, launch.evidence_revision + 1);
        assert_eq!(
            fork_launch.requested_native_session_id.as_deref(),
            Some(grandchild)
        );
        assert!(forked.resume_spec.is_none());
        registry.begin_stop(soul.clone()).await.unwrap();
        assert!(
            registry
                .transition_claude_clear_fenced(
                    soul,
                    prepared.incarnation_id,
                    grandchild,
                    parent,
                    forked.write_fence(),
                    NativeIdentityObservation {
                        native_session_id: parent.into(),
                        incarnation_id: launch.incarnation_id.clone(),
                        launch_nonce: launch.launch_nonce,
                        evidence_revision: fork_launch.evidence_revision,
                        source: NativeIdentitySource::ClaudeNativeClear,
                        evidence_digest: "c".repeat(64),
                    }
                )
                .await
                .is_err(),
            "late clear proof cannot reverse Stop"
        );
    }

    #[tokio::test]
    async fn terminal_opencode_switch_updates_resume_identity_and_writer_claim() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let soul = SoulId::new();
        let mut launch = prep(soul.clone(), RequestId::new(), "opencode-switch");
        launch.provider = "opencode".into();
        launch.provider_store_id = "opencode-store".into();
        launch.terminal = Some(TerminalLaunchSpec {
            terminal_id: "terminal-switch".into(),
            stream_id: "stream-switch".into(),
            mode: "opencode".into(),
            program: "opencode".into(),
            args: Vec::new(),
            env: Default::default(),
            cwd: workspace.path().to_string_lossy().into_owned(),
            run_as_uid: 65_534,
            run_as_gid: 0,
            cols: 80,
            rows: 24,
            project_key: "switch-project".into(),
            workspace_path: workspace.path().to_string_lossy().into_owned(),
            git_common_dir: None,
            create_request_id: None,
            resume_session_id: None,
            provider_model: None,
            provider_reasoning_effort: None,
            provider_sandbox: None,
            provider_permission_mode: None,
            provider_bootstrap_files: Vec::new(),
            provider_secret_references: Vec::new(),
            provider_launch_context: None,
            opencode_transfer: None,
            opencode_transfer_attempt_id: None,
            opencode_adoption: None,
        });
        let prepared = registry.prepare_launch(launch).await.unwrap();
        registry
            .record_native_session(
                soul.clone(),
                prepared.incarnation_id.clone(),
                "ses_Parent".into(),
            )
            .await
            .unwrap();
        registry
            .transition_native_session(
                soul.clone(),
                prepared.incarnation_id.clone(),
                "ses_Parent",
                "ses_Child",
            )
            .await
            .unwrap();
        registry
            .transition_native_session(
                soul.clone(),
                prepared.incarnation_id.clone(),
                "ses_Parent",
                "ses_Child",
            )
            .await
            .unwrap();
        let view = registry
            .inventory()
            .await
            .unwrap()
            .into_iter()
            .find(|view| view.soul_id == soul)
            .unwrap();
        assert_eq!(view.native_session_id.as_deref(), Some("ses_Child"));
        assert_eq!(view.terminal_resume_session_id, None);
        let conn = open_connection(&registry.inner.db_path).unwrap();
        let claims: Vec<String> = {
            let mut query = conn
                .prepare("SELECT native_session_id FROM writer_claims WHERE soul_id=?1")
                .unwrap();
            query
                .query_map(params![soul.as_str()], |row| row.get(0))
                .unwrap()
                .map(Result::unwrap)
                .collect()
        };
        assert_eq!(claims, vec!["ses_Child"]);
    }

    #[tokio::test]
    async fn accepted_fresh_agent_turn_settings_are_part_of_exact_recovery_profile() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let nested = workspace.path().join("nested");
        std::fs::create_dir(&nested).unwrap();
        let nested = std::fs::canonicalize(nested).unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let soul = SoulId::new();
        let prepared = materialize_fresh_runtime(&registry, soul.clone(), workspace.path()).await;

        registry
            .record_native_session(
                soul.clone(),
                prepared.incarnation_id.clone(),
                "native-fresh-session".into(),
            )
            .await
            .unwrap();

        registry
            .update_fresh_agent_settings(
                soul.clone(),
                prepared.incarnation_id,
                FreshAgentTurnSettings {
                    cwd: Some(nested.to_string_lossy().into_owned()),
                    model: Some("recovery-model".into()),
                    effort: Some("high".into()),
                    permission_mode: Some("accept-edits".into()),
                    sandbox: Some("danger-full-access".into()),
                },
            )
            .await
            .unwrap();

        let context = registry.recovery_context(soul).await.unwrap();
        let recovered = context.fresh_agent.expect("fresh-agent recovery spec");
        assert_eq!(recovered.cwd, nested.to_string_lossy());
        assert_eq!(recovered.model.as_deref(), Some("recovery-model"));
        assert_eq!(recovered.effort.as_deref(), Some("high"));
        assert_eq!(recovered.permission_mode.as_deref(), Some("accept-edits"));
        assert_eq!(recovered.sandbox.as_deref(), Some("danger-full-access"));
        assert_eq!(
            recovered.native_session_id.as_deref(),
            Some("native-fresh-session")
        );
        assert_eq!(recovered.provider_store_id, "fresh-store");
    }

    #[tokio::test]
    async fn retry_budget_is_persisted_and_manual_retry_rearms_without_identity_change() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let soul = SoulId::new();
        let prepared = materialize_test_runtime(&registry, soul.clone()).await;
        let conn = open_connection(&registry.inner.db_path).unwrap();
        conn.execute(
            "UPDATE souls SET recovery_window_started_at=?1,successful_recoveries_in_window=5 WHERE soul_id=?2",
            params![now_millis(), soul.as_str()],
        )
        .unwrap();
        drop(conn);

        let blocked = registry
            .begin_recovery(
                soul.clone(),
                RecoveryTrigger::ProviderExit,
                RecoveryPath::NativeResume,
            )
            .await
            .unwrap_err();
        assert!(matches!(
            blocked,
            RegistryError::RecoveryBlocked { ref reason, .. }
                if reason == "BLOCKED_RETRY_BUDGET"
        ));

        let start = registry
            .begin_recovery(
                soul.clone(),
                RecoveryTrigger::ManualRetry,
                RecoveryPath::NativeResume,
            )
            .await
            .unwrap();
        assert_eq!(
            start.context.prior_handle.incarnation_id(),
            &prepared.incarnation_id
        );
        let conn = open_connection(&registry.inner.db_path).unwrap();
        let (state, count, native): (String, u64, Option<String>) = conn
            .query_row(
                "SELECT recovery_state,successful_recoveries_in_window,native_session_id FROM souls WHERE soul_id=?1",
                params![soul.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(state, "recovering");
        assert_eq!(count, 0);
        assert_eq!(native, None);
    }

    pub(crate) fn native_inventory_fixture(path: &std::path::Path) -> rusqlite::Connection {
        const TEST_MIGRATIONS: &[&str] = &[
            "20260127222353_familiar_lady_ursula",
            "20260211171708_add_project_commands",
            "20260213144116_wakeful_the_professor",
            "20260225215848_workspace",
            "20260227213759_add_session_workspace_id",
            "20260228203230_blue_harpoon",
            "20260303231226_add_workspace_fields",
            "20260309230000_move_org_to_state",
            "20260312043431_session_message_cursor",
            "20260323234822_events",
            "20260410174513_workspace-name",
            "20260413175956_chief_energizer",
            "20260423070820_add_icon_url_override",
            "20260427172553_slow_nightmare",
            "20260428004200_add_session_path",
            "20260501142318_next_venus",
            "20260504145000_add_sync_owner",
            "20260507164347_add_workspace_time",
            "20260510033149_session_usage",
            "20260511000411_data_migration_state",
            "20260511173437_session-metadata",
            "20260601010001_normalize_storage_paths",
            "20260601202201_amazing_prowler",
            "20260602002951_lowly_union_jack",
            "20260602182828_add_project_directories",
            "20260603001617_session_message_projection_indexes",
            "20260603040000_session_message_projection_order",
            "20260603141458_session_input_inbox",
            "20260603160727_jittery_ezekiel_stane",
            "20260604172448_event_sourced_session_input",
            "20260605003541_add_session_context_snapshot",
            "20260605042240_add_context_epoch_agent",
            "20260611035744_credential",
            "20260611192811_lush_chimera",
            "20260612174303_project_dir_strategy",
            "20260622142730_simplify_session_context_epoch",
            "20260622170816_reset_v2_session_state",
            "20260622202450_simplify_session_input",
        ];

        let db = rusqlite::Connection::open(path).unwrap();
        db.execute_batch(include_str!(
            "../../freshell-sessions/src/opencode_schema_v1_18_21.sql"
        ))
        .unwrap();
        for (index, migration) in TEST_MIGRATIONS.iter().enumerate() {
            db.execute(
                "INSERT INTO migration(id,time_completed) VALUES (?1,?2)",
                params![migration, index as i64],
            )
            .unwrap();
        }
        db
    }

    #[tokio::test]
    async fn production_native_inventory_refresh_preserves_authority_and_rejects_reordering() {
        use freshell_sessions::opencode_transfer::HostOpenCodeInventory;
        let dir = tempfile::tempdir().unwrap();
        let source_path = dir.path().join("opencode.db");
        let db = native_inventory_fixture(&source_path);
        let store = format!(
            "{:x}",
            Sha256::digest(
                source_path
                    .canonicalize()
                    .unwrap()
                    .to_string_lossy()
                    .as_bytes()
            )
        );
        let inventory = HostOpenCodeInventory::new(source_path.clone());
        let census = inventory.inspect_exact_origin(&store, "ses_exact").unwrap();
        let registry = Registry::open(dir.path().join("registry"), None).unwrap();
        let soul = SoulId::new();
        materialize_test_runtime(&registry, soul.clone()).await;
        open_connection(&registry.inner.db_path).unwrap().execute(
            "UPDATE souls SET provider='opencode',native_session_id='ses_exact',native_import_state='completed',native_import_source_store_id=?1,native_import_root_session_id='ses_exact',native_import_source_generation=?2,native_import_schema_fingerprint=?3,native_import_migration_fingerprint=?4 WHERE soul_id=?5",
            params![store, "e".repeat(64), census.schema_fingerprint(), census.migration_fingerprint(), soul.as_str()],
        ).unwrap();
        let input = RequestId::new();
        registry
            .begin_input(soul.clone(), input.clone(), b"synthetic input", None)
            .await
            .unwrap();
        registry
            .mark_input_dispatching(soul.clone(), input)
            .await
            .unwrap();
        let captured = registry.recovery_context(soul.clone()).await.unwrap();
        assert_eq!(captured.dispatched_command_count, 1);
        assert_eq!(captured.native_session_id.as_deref(), Some("ses_exact"));
        let absent = registry
            .refresh_native_import_inventory(&captured, Ok(inventory.clone()))
            .await
            .unwrap();
        assert_eq!(
            absent.native_import_state,
            NativeImportState::Absent,
            "qualified complete absence must be produced through the refresh path"
        );
        assert!(absent.native_import_absence_is_authoritative());
        assert!(
            registry
                .recovery_context(soul.clone())
                .await
                .unwrap()
                .native_import_authority
                .ends_with(census.inventory_fingerprint()),
            "accepted source census binding must survive reloading the registry"
        );

        let supervisor = crate::recovery::tests::missing_supervisor(&dir, registry.clone());
        let negative_for = |context: &RecoveryContext| {
            let provider_home = dir
                .path()
                .join("native-census")
                .join(context.soul_id.as_str());
            std::fs::create_dir_all(&provider_home).unwrap();
            let terminal = serde_json::from_value(serde_json::json!({
                "terminalId":"native-census", "streamId":"native-census", "mode":"opencode",
                "program":"opencode", "cwd":"/workspace", "workspacePath":"/workspace",
                "env":{"HOME":"/home/freshell/provider","OPENCODE_DISABLE_CHANNEL_DB":"1"}, "runAsUid":65534, "runAsGid":0,
                "cols":80, "rows":24, "projectKey":"test"
            }))
            .unwrap();
            let spec = freshell_agent_runtime::build_resume_spec(
                freshell_agent_runtime::ResumeSpecInput {
                    provider: &context.provider,
                    provider_store_id: &context.provider_store_id,
                    native_session_id: context.native_session_id.as_deref().unwrap(),
                    terminal: &terminal,
                    provider_version: None,
                    creation_seed_ref: context.creation_seed_ref.clone(),
                    checkpoint_revision: 0,
                    evidence_revision: context.evidence_revision,
                    never_dispatched: false,
                },
            )
            .unwrap();
            match freshell_agent_runtime::probe_provider_store(&provider_home, &spec) {
                freshell_agent_runtime::ProviderStoreProbe::DefinitivelyUnavailable {
                    reason,
                    evidence,
                    store_state,
                    negative_paths,
                } => freshell_runtime_protocol::RecoveryProbe::DefinitivelyUnavailable {
                    path: RecoveryPath::NativeResume,
                    reason,
                    evidence,
                    store_state,
                    negative_paths,
                },
                other => panic!("expected actual complete absent store census: {other:?}"),
            }
        };
        let negative = negative_for(&absent);
        let paths = supervisor
            .collect_loss_path_evidence(&absent, &negative)
            .await
            .unwrap();
        assert!(paths
            .iter()
            .any(|row| row.path == RecoveryPath::NativeImport
                && row.verdict
                    == freshell_runtime_protocol::RecoveryEvidenceVerdict::DefinitiveNegative));

        db.execute("INSERT INTO project(id,worktree,time_created,time_updated,sandboxes) VALUES ('prj','/synthetic',1,1,'[]')", []).unwrap();
        db.execute("INSERT INTO session(id,slug,project_id,directory,title,version,time_created,time_updated) VALUES ('ses_exact','slug','prj','/synthetic','synthetic','1',1,1)", []).unwrap();
        let available = registry
            .refresh_native_import_inventory(&absent, Ok(inventory.clone()))
            .await
            .unwrap();
        assert_eq!(available.native_import_state, NativeImportState::Available);
        assert!(!available.native_import_absence_is_authoritative());
        assert!(matches!(
            supervisor
                .collect_loss_path_evidence(&available, &negative_for(&available))
                .await,
            Err(freshell_runtime_protocol::RecoveryProbe::Blocked {
                path: RecoveryPath::NativeImport,
                ..
            })
        ));

        assert!(
            registry
                .refresh_native_import_inventory(&captured, Ok(inventory.clone()))
                .await
                .is_err(),
            "reordered refresh must not supersede accepted evidence"
        );
        let partial = inventory
            .with_channel_database(source_path)
            .with_channel_database(dir.path().join("missing.db"));
        let unresolved = registry
            .refresh_native_import_inventory(&available, Ok(partial))
            .await
            .unwrap();
        assert_eq!(
            unresolved.native_import_state,
            NativeImportState::Unresolved
        );
        assert!(!unresolved.native_import_absence_is_authoritative());
        let discovery_error = freshell_sessions::opencode_transfer::TransferError::Io(
            "synthetic discovery denied".into(),
        );
        let unresolved_again = registry
            .refresh_native_import_inventory(&unresolved, Err(discovery_error))
            .await
            .unwrap();
        assert_eq!(
            unresolved_again.native_import_state,
            NativeImportState::Unresolved
        );
        assert!(
            unresolved_again.native_import_revision > unresolved.native_import_revision,
            "even repeated same-state refreshes must invalidate older in-flight observations"
        );
    }

    #[tokio::test]
    async fn recovery_begin_rejects_probe_to_begin_revision_races() {
        for column in [
            "identity_revision",
            "evidence_revision",
            "native_import_revision",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let registry = Registry::open(dir.path(), None).unwrap();
            let soul = SoulId::new();
            materialize_test_runtime(&registry, soul.clone()).await;
            let context = registry.recovery_context(soul.clone()).await.unwrap();
            open_connection(&registry.inner.db_path)
                .unwrap()
                .execute(
                    &format!("UPDATE souls SET {column}={column}+1 WHERE soul_id=?1"),
                    params![soul.as_str()],
                )
                .unwrap();
            assert!(
                registry
                    .begin_recovery_fenced(
                        soul.clone(),
                        RecoveryTrigger::ProviderExit,
                        RecoveryPath::PristineSeed,
                        context.write_fence()
                    )
                    .await
                    .is_err(),
                "{column} changed since probe"
            );
            assert_eq!(
                registry
                    .recovery_context(soul)
                    .await
                    .unwrap()
                    .recovery_state,
                RecoveryState::Live
            );
        }
    }

    #[tokio::test]
    async fn seed_replacement_rechecks_input_journal_before_preparation() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let soul = SoulId::new();
        let launch = materialize_test_runtime(&registry, soul.clone()).await;
        let request = RequestId::new();
        registry
            .begin_input(soul.clone(), request.clone(), b"synthetic input", None)
            .await
            .unwrap();
        let start = registry
            .begin_recovery(
                soul.clone(),
                RecoveryTrigger::ProviderExit,
                RecoveryPath::PristineSeed,
            )
            .await
            .unwrap();
        registry
            .mark_input_ambiguous(soul.clone(), request)
            .await
            .unwrap();
        registry
            .mark_stop_outcome(launch.incarnation_id, StopOutcome::VerifiedEmpty)
            .await
            .unwrap();
        assert!(
            registry
                .prepare_replacement(start, None, None, None, RecoveryPath::PristineSeed)
                .await
                .is_err(),
            "seed eligibility must be checked in the replacement transaction"
        );
    }

    #[tokio::test]
    async fn delayed_reattach_rejects_source_import_and_identity_changes() {
        for column in [
            "identity_revision",
            "evidence_revision",
            "native_import_revision",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let registry = Registry::open(dir.path(), None).unwrap();
            let soul = SoulId::new();
            let launch = materialize_test_runtime(&registry, soul.clone()).await;
            let context = registry.recovery_context(soul.clone()).await.unwrap();
            open_connection(&registry.inner.db_path).unwrap().execute(&format!("UPDATE souls SET {column}={column}+1,recovery_state='blocked' WHERE soul_id=?1"), params![soul.as_str()]).unwrap();
            assert!(registry
                .mark_recovery_live(soul.clone(), launch.incarnation_id, context.write_fence())
                .await
                .is_err());
            assert_eq!(
                registry
                    .recovery_context(soul)
                    .await
                    .unwrap()
                    .recovery_state,
                RecoveryState::Blocked
            );
        }
    }

    #[tokio::test]
    async fn live_publication_refuses_unobserved_native_incarnation() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let soul = SoulId::new();
        let prepared = materialize_test_runtime(&registry, soul.clone()).await;
        open_connection(&registry.inner.db_path)
            .unwrap()
            .execute(
                "UPDATE souls SET provider='claude',recovery_state='recovering' WHERE soul_id=?1",
                [soul.as_str()],
            )
            .unwrap();
        registry
            .record_native_session(
                soul.clone(),
                prepared.incarnation_id.clone(),
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into(),
            )
            .await
            .unwrap();
        let context = registry.recovery_context(soul.clone()).await.unwrap();
        let result = registry
            .mark_recovery_live(soul.clone(), prepared.incarnation_id, context.write_fence())
            .await;
        assert!(
            result.is_err(),
            "current native observation must be checked in the final LIVE transaction"
        );
        assert_eq!(
            registry
                .recovery_context(soul)
                .await
                .unwrap()
                .recovery_state,
            RecoveryState::Recovering
        );
    }

    #[tokio::test]
    async fn initial_running_publication_requires_the_current_native_observation() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let soul = SoulId::new();
        let prepared = materialize_test_runtime(&registry, soul.clone()).await;
        let conn = open_connection(&registry.inner.db_path).unwrap();
        conn.execute("UPDATE souls SET provider='claude',recovery_state='recovering',native_session_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' WHERE soul_id=?1",[soul.as_str()]).unwrap();
        conn.execute("UPDATE incarnations SET fixture_kind=NULL,launch_state='starting' WHERE incarnation_id=?1",[prepared.incarnation_id.as_str()]).unwrap();
        let generation = conn
            .query_row(
                "SELECT execution_generation FROM incarnations WHERE incarnation_id=?1",
                [prepared.incarnation_id.as_str()],
                |row| row.get::<_, u64>(0),
            )
            .unwrap();
        drop(conn);
        let context = registry.recovery_context(soul.clone()).await.unwrap();
        let missing = registry
            .mark_running_observed(
                soul.clone(),
                prepared.incarnation_id.clone(),
                context.write_fence(),
            )
            .await;
        assert!(
            matches!(missing, Err(RegistryError::RecoveryBlocked { .. })),
            "initial RUNNING must not release LIVE without current native evidence: {missing:?}"
        );
        assert_eq!(
            registry.inventory().await.unwrap()[0].launch_state,
            LaunchState::Starting
        );
        let launch = registry
            .bind_native_identity_launch(freshell_runtime_protocol::NativeIdentityLaunch {
                incarnation_id: prepared.incarnation_id.clone(),
                launch_nonce: context.prior_handle.launch_nonce().as_str().into(),
                evidence_revision: context.evidence_revision,
                execution_generation: generation,
                requested_native_session_id: context.native_session_id.clone(),
            })
            .await
            .unwrap();
        let observed = freshell_runtime_protocol::NativeIdentityObservation {
            native_session_id: context.native_session_id.clone().unwrap(),
            incarnation_id: prepared.incarnation_id.clone(),
            launch_nonce: launch.launch_nonce.clone(),
            evidence_revision: launch.evidence_revision,
            source: freshell_runtime_protocol::NativeIdentitySource::ClaudeNativeEvent,
            evidence_digest: "a".repeat(64),
        };
        registry
            .record_native_identity_observation(soul.clone(), observed, context.write_fence())
            .await
            .unwrap();
        registry
            .mark_running_observed(soul.clone(), prepared.incarnation_id, context.write_fence())
            .await
            .unwrap();
        assert_eq!(
            registry.inventory().await.unwrap()[0].launch_state,
            LaunchState::Running
        );
    }

    #[tokio::test]
    async fn recovery_seed_rejects_identity_observed_after_probe() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let soul = SoulId::new();
        let original = materialize_test_runtime(&registry, soul.clone()).await;
        let snapshot = registry.recovery_context(soul.clone()).await.unwrap();
        assert!(snapshot.never_dispatched);
        registry
            .record_native_session(
                soul.clone(),
                original.incarnation_id.clone(),
                "ses_materialized".into(),
            )
            .await
            .unwrap();
        assert!(
            registry
                .begin_recovery(
                    soul.clone(),
                    RecoveryTrigger::ProviderExit,
                    RecoveryPath::PristineSeed
                )
                .await
                .is_err(),
            "an observed identity must never be retired for a seed"
        );
        assert_eq!(
            registry.inventory().await.unwrap()[0].launch_state,
            LaunchState::Running
        );
    }

    #[tokio::test]
    async fn terminal_response_cannot_reverse_a_newer_native_transition() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let soul = SoulId::new();
        let original = materialize_test_runtime(&registry, soul.clone()).await;
        let mut terminal = opencode_terminal(&opencode_transfer_descriptor("test"), "attempt");
        terminal.opencode_transfer = None;
        terminal.resume_session_id = None;
        let conn = open_connection(&registry.inner.db_path).unwrap();
        conn.execute(
            "UPDATE souls SET provider='opencode' WHERE soul_id=?1",
            params![soul.as_str()],
        )
        .unwrap();
        conn.execute(
            "UPDATE incarnations SET terminal_spec=?1 WHERE incarnation_id=?2",
            params![
                serde_json::to_string(&terminal).unwrap(),
                original.incarnation_id.as_str()
            ],
        )
        .unwrap();
        registry
            .record_native_session(soul.clone(), original.incarnation_id, "ses_A".into())
            .await
            .unwrap();
        let pending_read = registry.recovery_context(soul.clone()).await.unwrap();
        crate::service::record_terminal_identity_observation(&registry, &pending_read, "ses_B")
            .await
            .unwrap();
        assert!(
            crate::service::record_terminal_identity_observation(&registry, &pending_read, "ses_A")
                .await
                .is_err(),
            "late A output must not undo the accepted A-to-B transition"
        );
        assert_eq!(
            registry
                .recovery_context(soul)
                .await
                .unwrap()
                .native_session_id
                .as_deref(),
            Some("ses_B")
        );
    }

    async fn retired_capture_fixture(registry: &Registry) -> (SoulId, RecoveryContext, ResumeSpec) {
        let soul = SoulId::new();
        let prepared = materialize_test_runtime(registry, soul.clone()).await;
        let conn = open_connection(&registry.inner.db_path).unwrap();
        conn.execute(
            "UPDATE souls SET provider='native-session-fixture' WHERE soul_id=?1",
            [soul.as_str()],
        )
        .unwrap();
        conn.execute(
            "UPDATE incarnations SET fixture_kind='native_session' WHERE incarnation_id=?1",
            [prepared.incarnation_id.as_str()],
        )
        .unwrap();
        drop(conn);
        registry
            .record_native_session(
                soul.clone(),
                prepared.incarnation_id.clone(),
                "retired-root".into(),
            )
            .await
            .unwrap();
        let context = registry.recovery_context(soul.clone()).await.unwrap();
        let spec = crate::resume_catalog::exact_resume_candidate(&context, None)
            .unwrap()
            .unwrap();
        registry
            .mark_stop_outcome(prepared.incarnation_id, StopOutcome::VerifiedEmpty)
            .await
            .unwrap();
        (soul, context, spec)
    }

    #[tokio::test]
    async fn retired_unowned_replacement_preserves_prior_capture_and_import_observations() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let (soul, _, spec) = retired_capture_fixture(&registry).await;
        let start = registry
            .begin_recovery(
                soul.clone(),
                RecoveryTrigger::ProviderExit,
                RecoveryPath::NativeResume,
            )
            .await
            .unwrap();
        let prior = start.context.prior_handle.incarnation_id().clone();
        registry
            .prepare_replacement(start, None, None, None, RecoveryPath::NativeResume)
            .await
            .unwrap();
        registry
            .retire_unowned_prepared_replacement(soul.clone())
            .await
            .unwrap()
            .unwrap();
        let context = registry.recovery_context(soul.clone()).await.unwrap();
        assert_eq!(context.prior_handle.incarnation_id(), &prior);
        let saved = registry
            .store_verified_recovery_resume_spec_fenced(soul.clone(), spec, context.write_fence())
            .await
            .unwrap();
        let context = registry.recovery_context(soul.clone()).await.unwrap();
        let revision = registry
            .record_native_import_observation(
                soul.clone(),
                context.write_fence(),
                NativeImportObservation {
                    state: NativeImportState::NotApplicable,
                    source_store_id: None,
                    root_session_id: None,
                    source_generation: None,
                    schema_fingerprint: None,
                    migration_fingerprint: None,
                    complete_source_inventory: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(revision, context.native_import_revision + 1);
        drop(registry);
        let reopened = Registry::open(dir.path(), None).unwrap();
        let persisted = reopened.recovery_context(soul).await.unwrap();
        assert_eq!(persisted.prior_handle.incarnation_id(), &prior);
        assert_eq!(persisted.resume_spec, Some(saved));
        assert_eq!(persisted.native_import_revision, revision);
        assert_eq!(persisted.evidence_revision, context.evidence_revision + 1);
    }

    #[tokio::test]
    async fn retired_resume_capture_preserves_active_only_api_and_saved_exact_input() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let (soul, context, spec) = retired_capture_fixture(&registry).await;
        assert!(
            registry
                .store_verified_resume_spec_fenced(
                    soul.clone(),
                    spec.clone(),
                    context.write_fence()
                )
                .await
                .is_err(),
            "the existing active-only API must still reject a retired prior"
        );
        assert!(registry
            .recovery_context(soul.clone())
            .await
            .unwrap()
            .resume_spec
            .is_none());
        let saved = registry
            .store_verified_recovery_resume_spec_fenced(
                soul.clone(),
                spec.clone(),
                context.write_fence(),
            )
            .await
            .unwrap();
        assert_eq!(saved.provider_session, spec.provider_session);
        assert_eq!(saved.evidence_revision, context.evidence_revision + 1);
        assert_eq!(saved.allocation_state, AllocationState::VerifiedDurable);
        let before = registry.recovery_context(soul.clone()).await.unwrap();
        let replay = registry
            .store_verified_recovery_resume_spec_fenced(
                soul.clone(),
                saved.clone(),
                before.write_fence(),
            )
            .await
            .unwrap();
        assert_eq!(
            replay, saved,
            "idempotent re-entry must not advance evidence"
        );
        drop(registry);
        let reopened = Registry::open(dir.path(), None).unwrap();
        assert_eq!(
            reopened.recovery_context(soul).await.unwrap().resume_spec,
            Some(saved)
        );
    }

    #[tokio::test]
    async fn retired_resume_capture_rejects_stale_or_unverified_prior_without_writing() {
        for case in [
            "evidence",
            "identity",
            "import",
            "intent",
            "control",
            "attempt",
            "stop_intent",
            "failed_prior",
            "unverified_cleanup",
            "new_active",
            "new_stopped",
            "new_owned_failed",
            "orphan_writer",
            "wrong_root",
            "wrong_store",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let registry = Registry::open(dir.path(), None).unwrap();
            let (soul, context, mut spec) = retired_capture_fixture(&registry).await;
            let conn = open_connection(&registry.inner.db_path).unwrap();
            match case {
                "evidence" => {
                    conn.execute(
                        "UPDATE souls SET evidence_revision=evidence_revision+1 WHERE soul_id=?1",
                        [soul.as_str()],
                    )
                    .unwrap();
                }
                "identity" => {
                    conn.execute(
                        "UPDATE souls SET identity_revision=identity_revision+1 WHERE soul_id=?1",
                        [soul.as_str()],
                    )
                    .unwrap();
                }
                "import" => {
                    conn.execute("UPDATE souls SET native_import_revision=native_import_revision+1 WHERE soul_id=?1", [soul.as_str()]).unwrap();
                }
                "intent" => {
                    conn.execute(
                        "UPDATE souls SET intent_revision=intent_revision+1 WHERE soul_id=?1",
                        [soul.as_str()],
                    )
                    .unwrap();
                }
                "control" => {
                    conn.execute("UPDATE installation SET control_epoch=control_epoch+1", [])
                        .unwrap();
                }
                "attempt" => {
                    conn.execute(
                        "UPDATE souls SET recovery_attempt_id=?1 WHERE soul_id=?2",
                        params![RecoveryAttemptId::new().as_str(), soul.as_str()],
                    )
                    .unwrap();
                }
                "stop_intent" => {
                    conn.execute(
                        "UPDATE souls SET desired_state='stopped' WHERE soul_id=?1",
                        [soul.as_str()],
                    )
                    .unwrap();
                }
                "failed_prior" => {
                    conn.execute(
                        "UPDATE incarnations SET launch_state='failed' WHERE incarnation_id=?1",
                        [context.prior_handle.incarnation_id().as_str()],
                    )
                    .unwrap();
                }
                "unverified_cleanup" => {
                    conn.execute("UPDATE incarnations SET cleanup_state='termination_unconfirmed' WHERE incarnation_id=?1", [context.prior_handle.incarnation_id().as_str()]).unwrap();
                }
                "new_active" | "new_stopped" | "new_owned_failed" => {
                    let mut preparation =
                        prep(soul.clone(), RequestId::new(), "new-retired-capture-owner");
                    preparation.provider = context.provider.clone();
                    preparation.native_session_id = context.native_session_id.clone();
                    preparation.fixture = context.fixture;
                    let current = registry.prepare_launch(preparation).await.unwrap();
                    if case == "new_owned_failed" {
                        registry
                            .commit_created(
                                current.incarnation_id.clone(),
                                BackendCreatedRecord {
                                    daemon_id: DockerDaemonId::new(),
                                    container_id: "new-owned-container".into(),
                                    image_ref: "new-owned-image".into(),
                                    runtime_dir: dir.path().join("new-runtime"),
                                    host_binary_path: dir.path().join("host"),
                                    immutable_config_digest: "new-owned-digest".into(),
                                    launch_policy: None,
                                },
                            )
                            .await
                            .unwrap();
                        conn.execute("UPDATE incarnations SET launch_state='failed',cleanup_state='termination_unconfirmed',prior_incarnation_id=?1 WHERE incarnation_id=?2",
                            params![context.prior_handle.incarnation_id().as_str(),current.incarnation_id.as_str()]).unwrap();
                    }
                    if case == "new_stopped" {
                        registry
                            .mark_stop_outcome(current.incarnation_id, StopOutcome::VerifiedEmpty)
                            .await
                            .unwrap();
                    }
                }
                "orphan_writer" => {
                    conn.execute("INSERT INTO writer_claims (provider,provider_store_id,native_session_id,soul_id,incarnation_id,intent_revision) VALUES (?1,?2,?3,?4,?5,?6)", params![context.provider, context.provider_store_id, context.native_session_id, soul.as_str(), context.prior_handle.incarnation_id().as_str(), context.intent_revision]).unwrap();
                }
                "wrong_root" => spec.provider_session.native_session_id = "wrong-root".into(),
                "wrong_store" => spec.provider_session.provider_store_id = "wrong-store".into(),
                _ => unreachable!(),
            }
            let evidence_before: u64 = conn
                .query_row(
                    "SELECT evidence_revision FROM souls WHERE soul_id=?1",
                    [soul.as_str()],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(
                registry
                    .store_verified_recovery_resume_spec_fenced(
                        soul.clone(),
                        spec,
                        context.write_fence()
                    )
                    .await
                    .is_err(),
                "{case}"
            );
            let stored: (Option<String>, u64) = conn
                .query_row(
                    "SELECT resume_spec,evidence_revision FROM souls WHERE soul_id=?1",
                    [soul.as_str()],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(
                stored,
                (None, evidence_before),
                "{case} must fail before any persistence"
            );
        }
    }

    #[tokio::test]
    async fn identity_fence_rejects_supplied_old_incarnation() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let soul = SoulId::new();
        let old = materialize_test_runtime(&registry, soul.clone()).await;
        registry
            .mark_stop_outcome(old.incarnation_id.clone(), StopOutcome::VerifiedEmpty)
            .await
            .unwrap();
        let current = materialize_test_runtime(&registry, soul.clone()).await;
        let fence = registry.recovery_write_fence(soul.clone()).await.unwrap();
        assert_ne!(old.incarnation_id, current.incarnation_id);
        assert!(
            registry
                .record_native_session_fenced(
                    soul.clone(),
                    old.incarnation_id,
                    "ses_stale".into(),
                    fence
                )
                .await
                .is_err(),
            "the supplied incarnation must equal the captured active incarnation"
        );
        assert_eq!(
            registry
                .recovery_context(soul)
                .await
                .unwrap()
                .native_session_id,
            None
        );
    }

    #[tokio::test]
    async fn blocked_verdict_rejects_same_attempt_newer_import_evidence() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let soul = SoulId::new();
        materialize_test_runtime(&registry, soul.clone()).await;
        let start = registry
            .begin_recovery(
                soul.clone(),
                RecoveryTrigger::ProviderExit,
                RecoveryPath::PristineSeed,
            )
            .await
            .unwrap();
        open_connection(&registry.inner.db_path)
            .unwrap()
            .execute(
                "UPDATE souls SET native_import_revision=native_import_revision+1 WHERE soul_id=?1",
                params![soul.as_str()],
            )
            .unwrap();
        assert!(
            registry
                .mark_recovery_blocked(
                    soul.clone(),
                    Some(start.attempt_id.clone()),
                    RecoveryBlockReason::ProviderUnavailable,
                    vec!["delayed negative".into()],
                    start
                        .context
                        .write_fence_for_attempt(start.attempt_id.clone())
                )
                .await
                .is_err(),
            "same attempt does not authorize stale evidence"
        );
        assert_eq!(
            registry
                .recovery_context(soul)
                .await
                .unwrap()
                .recovery_state,
            RecoveryState::Recovering
        );
    }

    #[tokio::test]
    async fn live_resume_evidence_rejects_superseded_incarnation_and_revision() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let soul = SoulId::new();
        let prepared = materialize_test_runtime(&registry, soul.clone()).await;
        let conn = open_connection(&registry.inner.db_path).unwrap();
        conn.execute(
            "UPDATE souls SET provider='opencode',native_session_id='exact-session' WHERE soul_id=?1",
            params![soul.as_str()],
        )
        .unwrap();
        drop(conn);

        let mut delayed = crate::checkpoints::tests::spec("opencode");
        delayed.durable_position.provider_cursor = Some("older-position".into());
        let mut newer = delayed.clone();
        newer.durable_position.provider_cursor = Some("newer-position".into());

        let first = registry
            .store_verified_resume_spec_for_live_incarnation(
                soul.clone(),
                prepared.incarnation_id.clone(),
                0,
                delayed.clone(),
            )
            .await
            .unwrap()
            .expect("the initial live incarnation and evidence revision are current");
        assert_eq!(first.evidence_revision, 1);

        let wrong_incarnation = registry
            .store_verified_resume_spec_for_live_incarnation(
                soul.clone(),
                IncarnationId::new(),
                first.evidence_revision,
                delayed.clone(),
            )
            .await
            .unwrap();
        assert!(
            wrong_incarnation.is_none(),
            "a probe from another incarnation cannot publish evidence"
        );

        registry
            .mark_stop_outcome(
                prepared.incarnation_id.clone(),
                StopOutcome::TerminationUnconfirmed,
            )
            .await
            .unwrap();
        registry
            .mark_recovery_blocked(
                soul.clone(),
                None,
                RecoveryBlockReason::ProviderUnavailable,
                vec!["synthetic provider store outage".into()],
                registry
                    .recovery_context(soul.clone())
                    .await
                    .unwrap()
                    .write_fence(),
            )
            .await
            .unwrap();
        let newer = registry
            .store_verified_resume_spec_for_live_incarnation(
                soul.clone(),
                prepared.incarnation_id.clone(),
                first.evidence_revision,
                newer,
            )
            .await
            .unwrap()
            .expect("a retry can publish evidence after blocked cleanup of the same incarnation");
        assert_eq!(
            newer.durable_position.provider_cursor.as_deref(),
            Some("newer-position")
        );

        let late = registry
            .store_verified_resume_spec_for_live_incarnation(
                soul.clone(),
                prepared.incarnation_id.clone(),
                0,
                delayed.clone(),
            )
            .await
            .unwrap();
        assert!(late.is_none(), "a late probe cannot replace newer evidence");

        let context = registry.recovery_context(soul.clone()).await.unwrap();
        let retained = context.resume_spec.expect("newer evidence remains saved");
        assert_eq!(retained.evidence_revision, newer.evidence_revision);
        assert_eq!(
            retained.durable_position.provider_cursor.as_deref(),
            Some("newer-position")
        );

        let start = registry
            .begin_recovery(
                soul.clone(),
                RecoveryTrigger::ProviderExit,
                RecoveryPath::NativeResume,
            )
            .await
            .unwrap();
        let during_recovery = registry
            .store_verified_resume_spec_for_live_incarnation(
                soul.clone(),
                start.context.prior_handle.incarnation_id().clone(),
                newer.evidence_revision,
                delayed,
            )
            .await
            .unwrap();
        assert!(
            during_recovery.is_none(),
            "an active recovery attempt cannot publish proof"
        );
        let final_context = registry.recovery_context(soul).await.unwrap();
        assert_eq!(final_context.recovery_state, RecoveryState::Recovering);
        assert_eq!(
            final_context
                .resume_spec
                .as_ref()
                .and_then(|spec| spec.durable_position.provider_cursor.as_deref()),
            Some("newer-position")
        );
    }

    #[tokio::test]
    async fn stop_intent_fences_a_recovery_attempt_before_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let soul = SoulId::new();
        materialize_test_runtime(&registry, soul.clone()).await;
        let start = registry
            .begin_recovery(
                soul.clone(),
                RecoveryTrigger::ProviderExit,
                RecoveryPath::NativeResume,
            )
            .await
            .unwrap();
        registry.begin_stop(soul).await.unwrap();
        let error = registry
            .prepare_replacement(start, None, None, None, RecoveryPath::NativeResume)
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            RegistryError::RecoveryBlocked { ref reason, .. }
                if reason == "STOP_INTENT_OR_STALE_ATTEMPT"
        ));
    }

    #[tokio::test]
    async fn explicit_stop_on_an_already_stopped_soul_advances_the_intent_revision() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let soul = SoulId::new();
        let prepared = materialize_test_runtime(&registry, soul.clone()).await;
        registry.begin_stop(soul.clone()).await.unwrap();
        registry
            .mark_stop_outcome(prepared.incarnation_id, StopOutcome::VerifiedEmpty)
            .await
            .unwrap();

        let before: u64 = open_connection(&registry.inner.db_path)
            .unwrap()
            .query_row(
                "SELECT intent_revision FROM souls WHERE soul_id=?1",
                params![soul.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        registry
            .begin_stop_expected(soul.clone(), Some(before))
            .await
            .unwrap();
        let conn = open_connection(&registry.inner.db_path).unwrap();
        let (after, desired, recovery, tombstones): (u64, String, String, u64) = conn
            .query_row(
                "SELECT intent_revision,desired_state,recovery_state,(SELECT COUNT(*) FROM stop_tombstones WHERE soul_id=?1) FROM souls WHERE soul_id=?1",
                params![soul.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(after, before + 1);
        assert_eq!(desired, "stopped");
        assert_eq!(recovery, "stopped");
        assert_eq!(tombstones, 2);
    }

    #[tokio::test]
    async fn exact_resume_replacement_requires_verified_empty_and_keeps_one_writer() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let soul = SoulId::new();
        let native_session_id = "ses_exact_recovery";
        let terminal = TerminalLaunchSpec {
            terminal_id: "terminal-exact-resume".into(),
            stream_id: "stream-exact-resume".into(),
            mode: "opencode".into(),
            program: "opencode".into(),
            args: vec!["--model".into(), "opencode/big-pickle".into()],
            env: std::collections::BTreeMap::from([(
                "HOME".into(),
                "/home/freshell/provider".into(),
            )]),
            cwd: "/workspace".into(),
            run_as_uid: 65_534,
            run_as_gid: 0,
            cols: 80,
            rows: 24,
            project_key: "project-exact-resume".into(),
            workspace_path: "/workspace".into(),
            git_common_dir: None,
            create_request_id: Some("create-exact-resume".into()),
            resume_session_id: None,
            provider_model: Some("opencode/big-pickle".into()),
            provider_reasoning_effort: None,
            provider_sandbox: None,
            provider_permission_mode: None,
            provider_bootstrap_files: Vec::new(),
            provider_secret_references: Vec::new(),
            provider_launch_context: None,
            opencode_transfer: None,
            opencode_transfer_attempt_id: None,
            opencode_adoption: None,
        };
        let mut launch = prep(soul.clone(), RequestId::new(), "exact-resume");
        launch.provider = "opencode".into();
        launch.provider_store_id = "store-exact-resume".into();
        launch.native_session_id = Some(native_session_id.into());
        launch.terminal = Some(terminal.clone());
        let original = registry.prepare_launch(launch).await.unwrap();
        let conn = open_connection(&registry.inner.db_path).unwrap();
        conn.execute(
            "UPDATE incarnations SET docker_daemon_id=?1,container_id=?2,image_ref='phase3-test-image',runtime_dir=?3,host_binary_path=?4,immutable_config_digest='sha256:phase3-test',launch_state='running' WHERE incarnation_id=?5",
            params![
                DockerDaemonId::new().as_str(),
                format!("container-{}", original.incarnation_id),
                format!("/tmp/freshell-runtime-test/{}", original.incarnation_id),
                format!("/tmp/freshell-runtime-test/{}/host", original.incarnation_id),
                original.incarnation_id.as_str(),
            ],
        )
        .unwrap();
        drop(conn);
        let resume_spec =
            freshell_agent_runtime::build_resume_spec(freshell_agent_runtime::ResumeSpecInput {
                provider: "opencode",
                provider_store_id: "store-exact-resume",
                native_session_id,
                terminal: &terminal,
                provider_version: Some("1.18.21".into()),
                creation_seed_ref: "seed".into(),
                checkpoint_revision: 0,
                evidence_revision: 0,
                never_dispatched: false,
            })
            .unwrap();
        let resume_spec = registry
            .store_verified_resume_spec(soul.clone(), resume_spec)
            .await
            .unwrap();
        let descriptor = opencode_transfer_descriptor("baseline-upgrade");
        let upgraded_baseline = freshell_runtime_protocol::OpenCodeAdoptionBaseline {
            manifest_sha256: format!("{:x}", Sha256::digest(descriptor.manifest_json.as_bytes())),
            descriptor,
        };
        let mut upgraded = resume_spec.clone();
        upgraded.opencode_adoption_baseline = Some(upgraded_baseline.clone());
        upgraded.environment.insert(
            "OPENCODE_DB".into(),
            "/home/freshell/provider/.local/share/opencode/opencode.db".into(),
        );
        let upgraded = registry
            .store_verified_resume_spec(soul.clone(), upgraded)
            .await
            .unwrap();
        assert_eq!(upgraded.opencode_adoption_baseline, Some(upgraded_baseline));
        assert_eq!(
            upgraded.environment.get("OPENCODE_DB").map(String::as_str),
            Some("/home/freshell/provider/.local/share/opencode/opencode.db")
        );
        let resume_spec = upgraded;
        let start = registry
            .begin_recovery(
                soul.clone(),
                RecoveryTrigger::ProviderExit,
                RecoveryPath::NativeResume,
            )
            .await
            .unwrap();

        let not_empty = registry
            .prepare_replacement(
                start.clone(),
                Some(terminal.clone()),
                None,
                Some(resume_spec.clone()),
                RecoveryPath::NativeResume,
            )
            .await
            .unwrap_err();
        assert!(matches!(
            not_empty,
            RegistryError::RecoveryBlocked { ref reason, .. }
                if reason == "OLD_RUNTIME_NOT_VERIFIED_EMPTY"
        ));

        registry
            .mark_stop_outcome(original.incarnation_id.clone(), StopOutcome::VerifiedEmpty)
            .await
            .unwrap();
        let replacement = registry
            .prepare_replacement(
                start,
                Some(terminal),
                None,
                Some(resume_spec),
                RecoveryPath::NativeResume,
            )
            .await
            .unwrap();
        assert_eq!(replacement.prior_incarnation_id, original.incarnation_id);
        assert_eq!(
            replacement
                .resume_spec
                .as_ref()
                .unwrap()
                .provider_session
                .native_session_id,
            native_session_id
        );
        assert!(replacement.terminal.is_some());
        let conn = open_connection(&registry.inner.db_path).unwrap();
        let claims: u64 = conn
            .query_row(
                "SELECT COUNT(*) FROM writer_claims WHERE soul_id=?1 AND native_session_id=?2",
                params![soul.as_str(), native_session_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(claims, 1, "exact recovery keeps one native-session writer");
    }

    #[tokio::test]
    async fn replacement_rejects_identity_evidence_or_import_revision_changes_after_recovery_start()
    {
        for revision_column in [
            "identity_revision",
            "evidence_revision",
            "native_import_revision",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let registry = Registry::open(dir.path(), None).unwrap();
            let soul = SoulId::new();
            let original = materialize_test_runtime(&registry, soul.clone()).await;
            let start = registry
                .begin_recovery(
                    soul.clone(),
                    RecoveryTrigger::ProviderExit,
                    RecoveryPath::PristineSeed,
                )
                .await
                .unwrap();
            registry
                .mark_stop_outcome(original.incarnation_id, StopOutcome::VerifiedEmpty)
                .await
                .unwrap();

            open_connection(&registry.inner.db_path)
                .unwrap()
                .execute(
                    &format!(
                        "UPDATE souls SET {revision_column}={revision_column}+1 WHERE soul_id=?1"
                    ),
                    params![soul.as_str()],
                )
                .unwrap();

            let error = registry
                .prepare_replacement(start, None, None, None, RecoveryPath::PristineSeed)
                .await
                .unwrap_err();
            assert!(
                matches!(
                    error,
                    RegistryError::RecoveryBlocked { ref reason, .. }
                        if reason == "STALE_MATERIALIZATION_OR_IMPORT_EVIDENCE"
                ),
                "{revision_column} must fence a replacement, got {error:?}"
            );
            let prepared_replacements: u64 = open_connection(&registry.inner.db_path)
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM incarnations WHERE soul_id=?1 AND prior_incarnation_id IS NOT NULL",
                    params![soul.as_str()],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(prepared_replacements, 0);
        }
    }

    #[tokio::test]
    async fn recovery_success_rejects_materialization_changes_after_its_fence() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let soul = SoulId::new();
        let original = materialize_test_runtime(&registry, soul.clone()).await;
        let start = registry
            .begin_recovery(
                soul.clone(),
                RecoveryTrigger::ProviderExit,
                RecoveryPath::PristineSeed,
            )
            .await
            .unwrap();
        registry
            .mark_stop_outcome(original.incarnation_id, StopOutcome::VerifiedEmpty)
            .await
            .unwrap();
        let replacement = registry
            .prepare_replacement(start.clone(), None, None, None, RecoveryPath::PristineSeed)
            .await
            .unwrap();
        open_connection(&registry.inner.db_path)
            .unwrap()
            .execute(
                "UPDATE incarnations SET docker_daemon_id=?1,container_id=?2,image_ref='phase3-test-image',runtime_dir=?3,host_binary_path=?4,immutable_config_digest='sha256:phase3-test',launch_state='running' WHERE incarnation_id=?5",
                params![
                    DockerDaemonId::new().as_str(),
                    format!("container-{}", replacement.prepared.incarnation_id),
                    format!("/tmp/freshell-runtime-test/{}", replacement.prepared.incarnation_id),
                    format!("/tmp/freshell-runtime-test/{}/host", replacement.prepared.incarnation_id),
                    replacement.prepared.incarnation_id.as_str(),
                ],
            )
            .unwrap();
        let context = registry.recovery_context(soul.clone()).await.unwrap();
        let fence = context.write_fence_for_attempt(start.attempt_id.clone());
        open_connection(&registry.inner.db_path)
            .unwrap()
            .execute(
                "UPDATE souls SET native_import_revision=native_import_revision+1 WHERE soul_id=?1",
                params![soul.as_str()],
            )
            .unwrap();

        assert!(registry
            .mark_recovery_success(
                soul.clone(),
                replacement.prepared.incarnation_id,
                start.attempt_id,
                fence,
            )
            .await
            .is_err());
        let context = registry.recovery_context(soul).await.unwrap();
        assert_eq!(context.recovery_state, RecoveryState::Recovering);
        assert!(context.recovery_attempt_id.is_some());
    }

    #[tokio::test]
    async fn stale_recovery_blocked_result_cannot_overwrite_stop_or_another_attempt() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let soul = SoulId::new();
        let original = materialize_test_runtime(&registry, soul.clone()).await;
        let start = registry
            .begin_recovery(
                soul.clone(),
                RecoveryTrigger::ProviderExit,
                RecoveryPath::PristineSeed,
            )
            .await
            .unwrap();
        registry.begin_stop(soul.clone()).await.unwrap();

        assert!(registry
            .mark_recovery_blocked(
                soul.clone(),
                Some(start.attempt_id.clone()),
                RecoveryBlockReason::ProviderUnavailable,
                vec!["late result".into()],
                start
                    .context
                    .write_fence_for_attempt(start.attempt_id.clone()),
            )
            .await
            .is_err());
        let context = registry.recovery_context(soul.clone()).await.unwrap();
        assert_eq!(context.desired_state, DesiredState::Stopped);
        assert_eq!(context.recovery_state, RecoveryState::Stopped);
        let attempt_verdict: String = open_connection(&registry.inner.db_path)
            .unwrap()
            .query_row(
                "SELECT verdict FROM recovery_attempts WHERE attempt_id=?1",
                params![start.attempt_id.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(attempt_verdict, "started");
        let _ = original;
    }

    #[tokio::test]
    async fn interrupted_prepared_replacement_is_retired_without_claiming_unknown_docker_object() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let soul = SoulId::new();
        let original = materialize_test_runtime(&registry, soul.clone()).await;
        let start = registry
            .begin_recovery(
                soul.clone(),
                RecoveryTrigger::ProviderExit,
                RecoveryPath::PristineSeed,
            )
            .await
            .unwrap();
        registry
            .mark_stop_outcome(original.incarnation_id.clone(), StopOutcome::VerifiedEmpty)
            .await
            .unwrap();
        let replacement = registry
            .prepare_replacement(start, None, None, None, RecoveryPath::PristineSeed)
            .await
            .unwrap();

        assert!(registry
            .retire_unowned_prepared_replacement(soul.clone())
            .await
            .unwrap()
            .is_some());
        assert!(registry
            .retire_unowned_prepared_replacement(soul.clone())
            .await
            .unwrap()
            .is_none());

        let context = registry.recovery_context(soul.clone()).await.unwrap();
        assert_eq!(
            context.prior_handle.incarnation_id(),
            &original.incarnation_id
        );
        assert_eq!(context.recovery_state, RecoveryState::Blocked);
        let conn = open_connection(&registry.inner.db_path).unwrap();
        let (state, cleanup, reservations, claims): (String, String, u64, u64) = conn
            .query_row(
                "SELECT i.launch_state,i.cleanup_state,                    (SELECT COUNT(*) FROM admission_reservations a WHERE a.incarnation_id=i.incarnation_id),                    (SELECT COUNT(*) FROM writer_claims w WHERE w.incarnation_id=i.incarnation_id)                 FROM incarnations i WHERE i.incarnation_id=?1",
                params![replacement.prepared.incarnation_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(state, "failed");
        assert_eq!(cleanup, "termination_unconfirmed");
        assert_eq!(reservations, 0);
        assert_eq!(claims, 0);
    }

    #[tokio::test]
    async fn one_recovery_attempt_cannot_create_two_active_incarnations() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let soul = SoulId::new();
        let prepared = materialize_test_runtime(&registry, soul.clone()).await;
        let start = registry
            .begin_recovery(
                soul.clone(),
                RecoveryTrigger::ProviderExit,
                RecoveryPath::PristineSeed,
            )
            .await
            .unwrap();
        registry
            .mark_stop_outcome(prepared.incarnation_id.clone(), StopOutcome::VerifiedEmpty)
            .await
            .unwrap();
        let replacement = registry
            .prepare_replacement(start.clone(), None, None, None, RecoveryPath::PristineSeed)
            .await
            .unwrap();
        assert_ne!(replacement.prepared.incarnation_id, prepared.incarnation_id);
        assert!(matches!(
            registry
                .prepare_replacement(start, None, None, None, RecoveryPath::PristineSeed)
                .await,
            Err(RegistryError::ActiveIncarnation(_))
        ));
        let conn = open_connection(&registry.inner.db_path).unwrap();
        let active: u64 = conn
            .query_row(
                &format!(
                    "SELECT COUNT(*) FROM incarnations WHERE soul_id=?1 AND launch_state IN ({ACTIVE_STATES})"
                ),
                params![soul.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(active, 1);
    }

    #[test]
    fn schema_three_migrates_protected_payload_without_recreating_registry() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("registry");
        let installation = InstallationId::new();
        let registry = Registry::open(&root, Some(installation.clone())).unwrap();
        let db = registry.inner.db_path.clone();
        drop(registry);

        let conn = open_connection(&db).unwrap();
        conn.execute_batch(
            r#"
            PRAGMA foreign_keys=OFF;
            BEGIN IMMEDIATE;
            ALTER TABLE input_commands RENAME TO input_commands_v4;
            CREATE TABLE input_commands (
                soul_id TEXT NOT NULL REFERENCES souls(soul_id),
                request_id TEXT NOT NULL,
                payload_digest TEXT NOT NULL,
                incarnation_id TEXT NOT NULL REFERENCES incarnations(incarnation_id),
                state TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY(soul_id, request_id)
            );
            DROP TABLE input_commands_v4;
            UPDATE installation SET schema_version=3 WHERE singleton=1;
            COMMIT;
            PRAGMA foreign_keys=ON;
            "#,
        )
        .unwrap();
        drop(conn);

        let migrated = Registry::open(&root, Some(installation)).unwrap();
        let conn = open_connection(&migrated.inner.db_path).unwrap();
        let schema: u32 = conn
            .query_row(
                "SELECT schema_version FROM installation WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(schema, SCHEMA_VERSION);
        let mut stmt = conn.prepare("PRAGMA table_info(input_commands)").unwrap();
        let columns: Vec<String> = stmt
            .query_map([], |row| row.get(1))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert!(columns.iter().any(|column| column == "protected_payload"));
    }

    fn drop_phase_six_schema(conn: &Connection) {
        conn.execute_batch(
            r#"
            PRAGMA foreign_keys=OFF;
            BEGIN IMMEDIATE;
            DROP TABLE IF EXISTS notice_receipts;
            DROP TABLE IF EXISTS runtime_notices;
            DROP TABLE IF EXISTS runtime_counters;
            DROP TABLE IF EXISTS migration_runs;
            DROP TABLE IF EXISTS repair_audits;
            DROP INDEX IF EXISTS one_loss_incident_per_soul_revision;
            DROP TABLE IF EXISTS loss_incidents;
            DROP TABLE IF EXISTS rollout_state;
            ALTER TABLE souls DROP COLUMN loss_incident_id;
            COMMIT;
            PRAGMA foreign_keys=ON;
            "#,
        )
        .unwrap();
    }

    fn downgrade_to_schema_seven(conn: &Connection) {
        conn.execute_batch(
            r#"
            PRAGMA foreign_keys=OFF;
            BEGIN IMMEDIATE;
            DROP TABLE IF EXISTS native_origin_owners;
            UPDATE souls SET identity_revision=0,native_import_revision=0,
                native_import_state='legacy_unknown',native_import_source_store_id=NULL,
                native_import_root_session_id=NULL,native_import_source_generation=NULL,
                native_import_schema_fingerprint=NULL,native_import_migration_fingerprint=NULL,
                native_import_complete_inventory=0,native_import_authority='legacy_unknown';
            UPDATE installation SET schema_version=7 WHERE singleton=1;
            COMMIT;
            PRAGMA foreign_keys=ON;
            "#,
        )
        .unwrap();
    }

    #[tokio::test]
    async fn schema_seven_backfills_only_unambiguous_descriptor_source_ownership() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("registry");
        let registry = Registry::open(&root, None).unwrap();
        let mut descriptor = opencode_transfer_descriptor("schema-seven-unique-origin");
        descriptor.destination_store_id = "destination-unique-origin".into();
        descriptor.incarnation_id = "incarnation-unique-origin".into();
        let prepared = registry
            .prepare_launch(opencode_prep(
                SoulId::new(),
                RequestId::new(),
                &descriptor,
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ))
            .await
            .unwrap();
        let db = registry.inner.db_path.clone();
        drop(registry);

        downgrade_to_schema_seven(&open_connection(&db).unwrap());
        let migrated = Registry::open(&root, None).unwrap();
        let conn = open_connection(&db).unwrap();
        let (owner, source_generation, ownership_state): (String, String, String) = conn
            .query_row(
                "SELECT owner_soul_id,source_generation,ownership_state FROM native_origin_owners WHERE provider='opencode' AND source_store_id=?1 AND native_root_session_id=?2",
                params![descriptor.source_store_id, descriptor.root_session_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(owner, prepared.soul_id.as_str());
        assert_eq!(source_generation, descriptor.source_generation);
        assert_eq!(ownership_state, "owned");
        let (source_store, state, identity_revision): (Option<String>, String, u64) = conn
            .query_row(
                "SELECT native_import_source_store_id,native_import_state,identity_revision FROM souls WHERE soul_id=?1",
                params![prepared.soul_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            source_store.as_deref(),
            Some(descriptor.source_store_id.as_str())
        );
        assert_eq!(state, "legacy_unknown");
        assert_eq!(identity_revision, 1);
        drop(conn);
        drop(migrated);
    }

    #[tokio::test]
    async fn schema_seven_duplicate_source_roots_are_ambiguous_and_unclaimed() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("registry");
        let registry = Registry::open(&root, None).unwrap();
        let mut first = opencode_transfer_descriptor("schema-seven-duplicate-a");
        first.destination_store_id = "destination-duplicate-a".into();
        first.incarnation_id = "incarnation-duplicate-a".into();
        let mut second = first.clone();
        second.transfer_id = "schema-seven-duplicate-b".into();
        second.destination_store_id = "destination-duplicate-b".into();
        second.incarnation_id = "incarnation-duplicate-b".into();
        let first_prepared = registry
            .prepare_launch(opencode_prep(
                SoulId::new(),
                RequestId::new(),
                &first,
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ))
            .await
            .unwrap();
        let conn = open_connection(&registry.inner.db_path).unwrap();
        conn.execute(
            "DELETE FROM native_origin_owners WHERE provider='opencode' AND source_store_id=?1 AND native_root_session_id=?2",
            params![first.source_store_id, first.root_session_id],
        )
        .unwrap();
        drop(conn);
        let second_prepared = registry
            .prepare_launch(opencode_prep(
                SoulId::new(),
                RequestId::new(),
                &second,
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            ))
            .await
            .unwrap();
        let db = registry.inner.db_path.clone();
        drop(registry);

        downgrade_to_schema_seven(&open_connection(&db).unwrap());
        let migrated = Registry::open(&root, None).unwrap();
        let conn = open_connection(&db).unwrap();
        let (owner, ownership_state): (Option<String>, String) = conn
            .query_row(
                "SELECT owner_soul_id,ownership_state FROM native_origin_owners WHERE provider='opencode' AND source_store_id=?1 AND native_root_session_id=?2",
                params![first.source_store_id, first.root_session_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(owner, None);
        assert_eq!(ownership_state, "ambiguous");
        let (soul_count, retained_source_count): (u64, u64) = conn
            .query_row(
                "SELECT COUNT(*),SUM(CASE WHEN native_import_source_store_id IS NULL THEN 1 ELSE 0 END) FROM souls WHERE soul_id IN (?1,?2)",
                params![first_prepared.soul_id.as_str(), second_prepared.soul_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(soul_count, 2);
        assert_eq!(retained_source_count, 2);
        drop(conn);
        drop(migrated);
    }

    #[tokio::test]
    async fn schema_seven_destination_store_is_never_backfilled_as_source_ownership() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("registry");
        let registry = Registry::open(&root, None).unwrap();
        let soul_id = SoulId::new();
        let mut launch = prep(
            soul_id.clone(),
            RequestId::new(),
            "schema-seven-no-descriptor",
        );
        launch.provider = "opencode".into();
        launch.provider_store_id = "destination-only-store".into();
        launch.native_session_id = Some("ses_legacy_no_descriptor".into());
        registry.prepare_launch(launch).await.unwrap();
        let unmaterialized_soul_id = SoulId::new();
        let mut unmaterialized = prep(
            unmaterialized_soul_id.clone(),
            RequestId::new(),
            "schema-seven-unmaterialized-no-descriptor",
        );
        unmaterialized.provider = "opencode".into();
        unmaterialized.provider_store_id = "destination-only-store-without-native-id".into();
        registry.prepare_launch(unmaterialized).await.unwrap();
        let db = registry.inner.db_path.clone();
        drop(registry);

        downgrade_to_schema_seven(&open_connection(&db).unwrap());
        let migrated = Registry::open(&root, None).unwrap();
        let conn = open_connection(&db).unwrap();
        let (state, source_store): (String, Option<String>) = conn
            .query_row(
                "SELECT native_import_state,native_import_source_store_id FROM souls WHERE soul_id=?1",
                params![soul_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let owner_count: u64 = conn
            .query_row(
                "SELECT COUNT(*) FROM native_origin_owners WHERE provider='opencode' AND source_store_id IN ('destination-only-store','destination-only-store-without-native-id')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(state, "legacy_unknown");
        assert_eq!(source_store, None);
        assert_eq!(owner_count, 0);
        let (unmaterialized_state, unmaterialized_source): (String, Option<String>) = conn
            .query_row(
                "SELECT native_import_state,native_import_source_store_id FROM souls WHERE soul_id=?1",
                params![unmaterialized_soul_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(unmaterialized_state, "legacy_unknown");
        assert_eq!(unmaterialized_source, None);
        drop(conn);
        drop(migrated);
    }

    #[tokio::test]
    async fn schema_five_migration_preserves_views_and_adds_loss_operations_tables() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("registry");
        let installation = InstallationId::new();
        let registry = Registry::open(&root, Some(installation.clone())).unwrap();
        let db = registry.inner.db_path.clone();
        let soul = SoulId::new();
        registry
            .prepare_launch(prep(soul.clone(), RequestId::new(), "schema-five"))
            .await
            .unwrap();
        let before_views: u64 = open_connection(&db)
            .unwrap()
            .query_row("SELECT COUNT(*) FROM view_intents", [], |row| row.get(0))
            .unwrap();
        drop(registry);

        let conn = open_connection(&db).unwrap();
        drop_phase_six_schema(&conn);
        conn.execute(
            "UPDATE installation SET schema_version=5 WHERE singleton=1",
            [],
        )
        .unwrap();
        drop(conn);

        let migrated = Registry::open(&root, Some(installation)).unwrap();
        let conn = open_connection(&migrated.inner.db_path).unwrap();
        let schema: u32 = conn
            .query_row(
                "SELECT schema_version FROM installation WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(schema, SCHEMA_VERSION);
        let after_views: u64 = conn
            .query_row("SELECT COUNT(*) FROM view_intents", [], |row| row.get(0))
            .unwrap();
        assert_eq!(after_views, before_views);
        for table in [
            "loss_incidents",
            "runtime_notices",
            "notice_receipts",
            "runtime_counters",
            "rollout_state",
            "migration_runs",
            "repair_audits",
        ] {
            assert!(table_exists(&conn, table).unwrap(), "missing {table}");
        }
        assert!(column_exists(&conn, "souls", "loss_incident_id").unwrap());
        let preserved: u64 = conn
            .query_row(
                "SELECT COUNT(*) FROM souls WHERE soul_id=?1",
                params![soul.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(preserved, 1);
    }

    #[tokio::test]
    async fn schema_four_migration_preserves_existing_rows_and_backfills_views() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("registry");
        let installation = InstallationId::new();
        let registry = Registry::open(&root, Some(installation.clone())).unwrap();
        let db = registry.inner.db_path.clone();
        let soul = SoulId::new();
        let prepared = registry
            .prepare_launch(prep(soul.clone(), RequestId::new(), "schema-four"))
            .await
            .unwrap();
        let conn = open_connection(&db).unwrap();
        conn.execute(
            "UPDATE incarnations SET terminal_spec='{}' WHERE incarnation_id=?1",
            params![prepared.incarnation_id.as_str()],
        )
        .unwrap();
        drop(conn);
        drop(registry);

        let conn = open_connection(&db).unwrap();
        drop_phase_six_schema(&conn);
        conn.execute_batch(
            r#"
            PRAGMA foreign_keys=OFF;
            BEGIN IMMEDIATE;
            DROP TRIGGER IF EXISTS souls_inventory_insert;
            DROP TRIGGER IF EXISTS souls_inventory_update;
            DROP TRIGGER IF EXISTS souls_inventory_delete;
            DROP TRIGGER IF EXISTS incarnations_inventory_insert;
            DROP TRIGGER IF EXISTS incarnations_inventory_update;
            DROP TRIGGER IF EXISTS incarnations_inventory_delete;
            DROP TRIGGER IF EXISTS view_intents_inventory_insert;
            DROP TRIGGER IF EXISTS view_intents_inventory_update;
            DROP TRIGGER IF EXISTS view_intents_inventory_delete;
            DROP INDEX IF EXISTS one_automatic_primary_view_per_soul;
            DROP TABLE IF EXISTS view_intents;
            ALTER TABLE souls DROP COLUMN configured_limits;
            ALTER TABLE installation DROP COLUMN inventory_revision;
            ALTER TABLE installation DROP COLUMN initial_scan_state;
            ALTER TABLE installation DROP COLUMN initial_scan_error;
            ALTER TABLE installation DROP COLUMN initial_scan_started_at;
            ALTER TABLE installation DROP COLUMN initial_scan_finished_at;
            ALTER TABLE installation DROP COLUMN initial_scan_peak_concurrency;
            UPDATE installation SET schema_version=4 WHERE singleton=1;
            COMMIT;
            PRAGMA foreign_keys=ON;
            "#,
        )
        .unwrap();
        drop(conn);

        let migrated = Registry::open(&root, Some(installation.clone())).unwrap();
        assert_eq!(migrated.installation_id(), &installation);
        let conn = open_connection(&migrated.inner.db_path).unwrap();
        let schema: u32 = conn
            .query_row(
                "SELECT schema_version FROM installation WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(schema, SCHEMA_VERSION);
        let preserved: u64 = conn
            .query_row(
                "SELECT COUNT(*) FROM souls WHERE soul_id=?1",
                params![soul.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(preserved, 1);
        let views: Vec<(String, String, String)> = {
            let mut statement = conn
                .prepare("SELECT soul_id,kind,visibility FROM view_intents WHERE soul_id=?1")
                .unwrap();
            statement
                .query_map(params![soul.as_str()], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })
                .unwrap()
                .map(Result::unwrap)
                .collect()
        };
        assert_eq!(
            views,
            vec![(
                soul.to_string(),
                "automatic_primary".into(),
                "visible".into()
            )]
        );
        assert!(column_exists(&conn, "souls", "configured_limits").unwrap());
        assert!(column_exists(&conn, "installation", "inventory_revision").unwrap());
    }

    #[test]
    fn newer_schema_fails_closed_without_replacing_database() {
        let dir = tempfile::tempdir().unwrap();
        let installation = InstallationId::new();
        let first = Registry::open(dir.path(), Some(installation.clone())).unwrap();
        let db = first.inner.db_path.clone();
        drop(first);
        let conn = open_connection(&db).unwrap();
        conn.execute(
            "UPDATE installation SET schema_version=999 WHERE singleton=1",
            [],
        )
        .unwrap();
        drop(conn);
        let error = Registry::open(dir.path(), Some(installation))
            .err()
            .expect("newer schema must fail closed");
        assert!(matches!(
            error,
            RegistryError::NewerSchema { found: 999, .. }
        ));
        assert!(db.exists());
    }

    #[test]
    fn fresh_schema_has_body_free_stopped_repair_recovery_tables() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let conn = open_connection(&registry.inner.db_path).unwrap();
        let schema: u32 = conn
            .query_row(
                "SELECT schema_version FROM installation WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(schema, SCHEMA_VERSION);
        assert!(table_exists(&conn, "stopped_repair_operations").unwrap());
        assert!(table_exists(&conn, "stopped_repair_withdrawals").unwrap());
    }

    // Insert inside registry.rs's existing tests module. Copy the accompanying SQL
    // fixture to src/registry/testdata/main-schema10.sql. Existing 7/8/9 tests remain.
    #[tokio::test]
    async fn main_schema_ten_upgrade_preserves_state_and_supports_fork_retry_and_stop() {
        use freshell_runtime_protocol::{
            ClaudeForkRecipe, ClaudeForkTarget, InitialAuthVolumeObservation,
        };
        use rusqlite::types::Value;

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("registry");
        std::fs::create_dir(&root).unwrap();
        let db = root.join("runtime.sqlite3");
        let installation = InstallationId::new();
        let soul = SoulId::new();
        let incarnation = IncarnationId::new();
        let nonce = LaunchNonce::new();
        let daemon = DockerDaemonId::new();
        let native = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let image = format!("sha256:{}", "a".repeat(64));
        let volume = stable_provider_volume_name(&installation, &soul);
        let runtime_dir = root.join("retained-runtime");
        let binary = dir.path().join("synthetic-host");
        std::fs::write(&binary, b"retained synthetic host").unwrap();
        let binary = std::fs::canonicalize(binary).unwrap();
        let binary_sha256 = binary_digest(&binary).unwrap();
        let requested_limits = serde_json::to_string(&limits()).unwrap();
        let observation = serde_json::to_string(&InitialAuthVolumeObservation::Absent {
            daemon_id: daemon.clone(),
        })
        .unwrap();

        // Start with the actual main schema, without opening today's Registry or
        // using today's create_schema and relabeling it as an older database.
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(include_str!("registry/testdata/main-schema10.sql"))
            .unwrap();
        conn.execute(
        "INSERT INTO installation(singleton,installation_id,schema_version,control_epoch) VALUES(1,?1,10,41)",
        [installation.as_str()],
    )
    .unwrap();
        conn.execute(
            "INSERT INTO rollout_state(singleton,mode,updated_at) VALUES(1,'legacy',4000)",
            [],
        )
        .unwrap();
        conn.execute(
        "INSERT INTO souls(soul_id,provider,provider_store_id,native_session_id,creation_seed_ref,desired_state,intent_revision,recovery_state,durability_state,allocation_state,checkpoint_revision,evidence_revision,recovery_window_started_at,successful_recoveries_in_window,project_key,resource_profile,provider_volume_name,configured_limits,created_at,updated_at) VALUES(?1,'codex','retained-store',?2,'retained-seed','running',1,'live','unknown','allocated',7,9,3000,2,'retained-project','custom',?3,?4,4000,4000)",
        params![soul.as_str(), native, volume, requested_limits],
    )
    .unwrap();
        conn.execute(
        "INSERT INTO incarnations(incarnation_id,soul_id,launch_nonce,docker_daemon_id,container_id,image_ref,runtime_dir,host_binary_path,immutable_config_digest,launch_state,execution_generation,requested_limits,effective_limits,cleanup_state,provider_preparation_pending,created_at,updated_at) VALUES(?1,?2,?3,?4,'retained-container',?5,?6,?7,'sha256:retained-config','running',3,?8,?8,'none',1,4000,4000)",
        params![
            incarnation.as_str(), soul.as_str(), nonce.as_str(), daemon.as_str(),
            image, runtime_dir.to_string_lossy(), binary.to_string_lossy(), requested_limits,
        ],
    )
    .unwrap();
        conn.execute(
        "INSERT INTO writer_claims(provider,provider_store_id,native_session_id,soul_id,incarnation_id,intent_revision) VALUES('codex','retained-store',?1,?2,?3,1)",
        params![native, soul.as_str(), incarnation.as_str()],
    )
    .unwrap();
        conn.execute(
        "INSERT INTO provider_input_preparations(soul_id,reservation_id,creation_seed_ref,provider,image_ref,host_binary_path,host_binary_sha256,intent_revision,observation,consumed,bound_incarnation_id) VALUES(?1,'retained-reservation','retained-seed','codex',?2,?3,?4,1,?5,1,?6)",
        params![soul.as_str(), image, binary.to_string_lossy(), binary_sha256, observation, incarnation.as_str()],
    )
    .unwrap();

        // Compare the original data, including opaque reservation evidence, before
        // exercising APIs which deliberately change that data. Explicit projections
        // omit only the new columns introduced by the upgrade.
        let retained_rows = |conn: &Connection| {
            [
            "SELECT soul_id,provider,provider_store_id,native_session_id,creation_seed_ref,desired_state,intent_revision,recovery_state,recovery_reason,recovery_attempt_id,durability_state,allocation_state,resume_spec,checkpoint_revision,evidence_revision,recovery_window_started_at,successful_recoveries_in_window,project_key,resource_profile,provider_volume_name,configured_limits,loss_incident_id,created_at,updated_at FROM souls",
            "SELECT incarnation_id,soul_id,launch_nonce,docker_daemon_id,container_id,image_ref,runtime_dir,host_binary_path,immutable_config_digest,launch_state,host_boot_id,execution_generation,grant_id,requested_limits,effective_limits,cleanup_state,fixture_kind,terminal_id,terminal_spec,fresh_agent_spec,prior_incarnation_id,recovery_attempt_id,provider_preparation_pending,exit_code,oom_killed,created_at,updated_at FROM incarnations",
            "SELECT soul_id,reservation_id,creation_seed_ref,provider,image_ref,host_binary_path,host_binary_sha256,intent_revision,observation,consumed,bound_incarnation_id FROM provider_input_preparations",
            "SELECT claim_id,provider,provider_store_id,native_session_id,soul_id,incarnation_id,intent_revision FROM writer_claims",
        ]
        .map(|sql| {
            conn.query_row(sql, [], |row| {
                (0..row.as_ref().column_count())
                    .map(|column| row.get::<_, Value>(column))
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .unwrap()
        })
        };
        let retained = retained_rows(&conn);
        drop(conn);

        let registry = Registry::open(&root, Some(installation.clone())).unwrap();
        assert_eq!(registry.installation_id(), &installation);
        assert_eq!(registry.control_epoch(), 42);
        let conn = Connection::open(&db).unwrap();
        assert_eq!(retained_rows(&conn), retained);
        drop(conn);
        let context = registry.recovery_context(soul.clone()).await.unwrap();
        assert_eq!(context.prior_handle.incarnation_id(), &incarnation);
        assert_eq!(context.native_session_id.as_deref(), Some(native));
        assert_eq!(
            context.native_import_state,
            NativeImportState::NotApplicable
        );
        assert_eq!(context.identity_revision, 1);
        assert_eq!(context.prior_handle.launch_policy(), None);
        assert!(registry
            .provider_preparation_is_pending(incarnation.clone())
            .await
            .unwrap());
        registry
            .mark_provider_preparation_complete(incarnation.clone())
            .await
            .unwrap();
        assert!(!registry
            .provider_preparation_is_pending(incarnation.clone())
            .await
            .unwrap());

        // Synthetic registry behavior: no provider invocation or Docker process.
        let fork_soul = SoulId::new();
        let fresh = materialize_fresh_runtime(&registry, fork_soul.clone(), dir.path()).await;
        let child = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        registry
            .record_native_session(
                fork_soul.clone(),
                fresh.incarnation_id.clone(),
                native.into(),
            )
            .await
            .unwrap();
        let context = registry.recovery_context(fork_soul.clone()).await.unwrap();
        let recipe = ClaudeForkRecipe {
            recovery_disabled: false,
            child_session_id: child.into(),
            parent_session_id: native.into(),
            parent_transcript: format!(".claude/projects/work/{native}.jsonl"),
            child_transcript: format!(".claude/projects/work/{child}.jsonl"),
            parent_sha256: "a".repeat(64),
            target: ClaudeForkTarget::Empty,
        };
        registry
            .transition_native_session_with_claude_fork_fenced(
                fork_soul.clone(),
                fresh.incarnation_id,
                native,
                child,
                context.write_fence(),
                Some(recipe.clone()),
            )
            .await
            .unwrap();
        let retry = registry
            .reserve_due_recovery_retry(soul.clone(), 1, 5000)
            .await
            .unwrap()
            .expect("the retained runtime can reserve its first recovery attempt");
        assert_eq!(retry.attempt_count, 1);
        let attempt = retry.reserved_attempt_id.clone().unwrap();
        drop(registry);

        let registry = Registry::open(&root, Some(installation.clone())).unwrap();
        let context = registry.recovery_context(fork_soul).await.unwrap();
        assert_eq!(context.native_session_id.as_deref(), Some(child));
        assert_eq!(context.claude_fork.as_ref(), Some(&recipe));
        let conn = Connection::open(&db).unwrap();
        let preparation_pending: bool = conn
            .query_row(
                "SELECT provider_preparation_pending FROM incarnations WHERE incarnation_id=?1",
                [incarnation.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!preparation_pending);
        drop(conn);
        assert_eq!(
            registry
                .reserved_recovery_retry(soul.clone(), 1)
                .await
                .unwrap(),
            Some(retry)
        );
        registry
            .settle_recovery_retry(soul.clone(), 1, attempt, true, false, 5001)
            .await
            .unwrap();
        let settled = registry
            .recovery_retry(soul.clone(), 1)
            .await
            .unwrap()
            .unwrap();
        let due = settled
            .next_due_at_ms
            .expect("retryable failure schedules another attempt");
        assert!(due > 5001);
        assert!(settled.reserved_attempt_id.is_none());
        assert!(registry
            .reserve_due_recovery_retry(soul.clone(), 1, due - 1)
            .await
            .unwrap()
            .is_none());
        let second = registry
            .reserve_due_recovery_retry(soul.clone(), 1, due)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(second.attempt_count, 2);

        let stop = registry
            .begin_stop_expected(soul.clone(), Some(1))
            .await
            .unwrap();
        assert_eq!(stop.incarnation_id(), &incarnation);
        let pending = registry.pending_stop_handles().await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].incarnation_id(), &incarnation);
        assert!(!registry.stop_progress(&stop).await.unwrap().settled);
        registry
            .record_ordinary_stop_outcome(&stop, StopOutcome::VerifiedEmpty)
            .await
            .unwrap();
        drop(registry);

        let registry = Registry::open(&root, Some(installation)).unwrap();
        let progress = registry.stop_progress(&stop).await.unwrap();
        assert!(progress.settled);
        assert_eq!(progress.outcome, Some(StopOutcome::VerifiedEmpty));
        assert!(registry.pending_stop_handles().await.unwrap().is_empty());
        assert!(registry
            .due_recovery_retries(i64::MAX)
            .await
            .unwrap()
            .is_empty());
        let stopped = registry.recovery_context(soul).await.unwrap();
        assert_eq!(stopped.desired_state, DesiredState::Stopped);
        assert_eq!(stopped.intent_revision, 2);
    }
}

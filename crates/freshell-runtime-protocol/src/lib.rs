//! Versioned control protocol and durable identity types for managed Freshell runtimes.
//!
//! This crate deliberately contains no process-management APIs. Runtime termination
//! authority lives in `freshell-supervisor` and is represented there by a private-
//! constructor ownership capability.

use hmac::{Hmac, Mac};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::Sha256;
use std::fmt;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const CONTROL_PROTOCOL_VERSION: u32 = 1;
pub const MAX_CONTROL_FRAME_BYTES: usize = 1024 * 1024;

type HmacSha256 = Hmac<Sha256>;

pub mod fresh_agent_ops;
pub use fresh_agent_ops::*;

#[cfg(test)]
#[path = "fresh_agent_ops_tests.rs"]
mod fresh_agent_ops_tests;

macro_rules! string_id {
    ($name:ident, $prefix:literal) => {
        #[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, PartialOrd, Ord)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn new() -> Self {
                Self(format!("{}{}", $prefix, uuid::Uuid::new_v4()))
            }

            pub fn parse(value: impl Into<String>) -> Result<Self, IdentityError> {
                let value = value.into();
                if value.is_empty()
                    || value.len() > 160
                    || value.bytes().any(|b| b.is_ascii_control())
                {
                    return Err(IdentityError::Invalid(stringify!($name)));
                }
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }

            pub fn into_string(self) -> String {
                self.0
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}

string_id!(InstallationId, "installation-");
string_id!(SoulId, "soul-");
string_id!(IncarnationId, "incarnation-");
string_id!(RequestId, "request-");
string_id!(LaunchNonce, "launch-");
string_id!(HostBootId, "hostboot-");
string_id!(GrantId, "grant-");
string_id!(RuntimeContainerId, "container-");
string_id!(DockerDaemonId, "daemon-");
string_id!(RecoveryAttemptId, "recovery-");
string_id!(ViewIntentId, "view-");
string_id!(ProjectionEventId, "projection-");
string_id!(IncidentId, "incident-");
string_id!(CorrelationId, "correlation-");
string_id!(NoticeId, "notice-");
string_id!(MigrationId, "migration-");

#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
pub enum IdentityError {
    #[error("invalid {0}")]
    Invalid(&'static str),
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSessionRef {
    pub provider: String,
    pub provider_store_id: String,
    pub native_session_id: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DesiredState {
    #[default]
    Running,
    Stopped,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryState {
    #[default]
    Live,
    Recovering,
    Blocked,
    Lost,
    Stopped,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DurabilityState {
    #[default]
    Unknown,
    LiveOnly,
    ResumeCaptured,
    CheckpointCaptured,
    IntrinsicallyNonResumable,
}

/// Materialization is deliberately separate from provider-id allocation. A
/// provider-minted id is not durable continuity evidence until its store has
/// been inspected and the identity is uniquely bound to the soul.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AllocationState {
    #[default]
    Allocated,
    Materializing,
    VerifiedDurable,
    Degraded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryPath {
    Reattach,
    NativeResume,
    CheckpointRestore,
    PristineSeed,
    NativeImport,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryTrigger {
    ProviderExit,
    HostUnreachable,
    StartupReconcile,
    ManualRetry,
    /// Records that the bounded automatic 2s/10s retry policy is exhausted.
    /// This is a blocked verdict, never evidence of loss.
    RetryExhausted,
    ExplicitRequest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RecoveryBlockReason {
    CredentialsExpired,
    RateLimited,
    ProviderUnavailable,
    StoreUnreadable,
    StoreMissing,
    WorkspaceUnavailable,
    IncompatibleBinary,
    UnsupportedProtocol,
    AmbiguousIdentity,
    ImplementationUnavailable,
    InsufficientResources,
    RetryBudget,
    StopIntent,
    OldRuntimeNotEmpty,
    WrongNativeIdentity,
    CommandAmbiguous,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryHint {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub automatic_after_ms: Option<u64>,
    pub manual_retry: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repair: Option<String>,
}

pub const RESUME_SPEC_SCHEMA_VERSION: u32 = 1;

fn default_resume_spec_schema_version() -> u32 {
    RESUME_SPEC_SCHEMA_VERSION
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IdentityProvenance {
    #[default]
    Unknown,
    Preallocated,
    ProviderObserved,
    Imported,
    FixtureObserved,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderVolumeRef {
    pub volume_name: String,
    pub mount_path: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DurablePosition {
    #[serde(default)]
    pub accepted_command_count: u64,
    #[serde(default)]
    pub completed_command_count: u64,
    #[serde(default)]
    pub output_sequence: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointReference {
    pub kind: String,
    pub reference: String,
    pub revision: u64,
    pub verified: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialReference {
    /// Relative path under the soul-scoped provider home. Credential bytes
    /// never enter the supervisor registry or control protocol.
    pub provider_relative_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeSpec {
    #[serde(default = "default_resume_spec_schema_version")]
    pub schema_version: u32,
    pub provider_session: ProviderSessionRef,
    pub mode: String,
    #[serde(default)]
    pub runtime_variant: String,
    pub program: String,
    #[serde(default)]
    pub resume_argv: Vec<String>,
    pub provider_home: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_volume: Option<ProviderVolumeRef>,
    pub cwd: String,
    pub workspace_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_profile: Option<RuntimeProfile>,
    #[serde(default)]
    pub environment: std::collections::BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_version: Option<String>,
    #[serde(default)]
    pub credential_references: Vec<CredentialReference>,
    #[serde(default)]
    pub identity_provenance: IdentityProvenance,
    #[serde(default)]
    pub durable_position: DurablePosition,
    #[serde(default)]
    pub checkpoint_references: Vec<CheckpointReference>,
    pub creation_seed_ref: String,
    pub checkpoint_revision: u64,
    pub allocation_state: AllocationState,
    pub evidence_revision: u64,
    /// True only when the durable command journal proves no provider input was
    /// ever dispatched. It is the sole authority for pristine-seed recovery.
    pub never_dispatched: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReattachHandle {
    pub incarnation_id: IncarnationId,
    pub host_boot_id: HostBootId,
    pub container_id: String,
}

/// A probe is evidence, not a command. In particular `Blocked` and
/// `DefinitivelyUnavailable` remain distinct so temporary failures can never
/// be promoted to loss merely because retries were exhausted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum RecoveryProbe {
    ReattachReady {
        handle: ReattachHandle,
        protocol_version: u32,
    },
    ResumeReady {
        resume_spec: Box<ResumeSpec>,
        evidence_revision: u64,
    },
    PristineSeedReady {
        seed: String,
        never_dispatched_proof: String,
    },
    DefinitivelyUnavailable {
        path: RecoveryPath,
        reason: String,
        #[serde(default)]
        evidence: Vec<String>,
        #[serde(default)]
        store_state: EvidenceStoreState,
    },
    Blocked {
        path: RecoveryPath,
        reason: RecoveryBlockReason,
        retry_hint: RetryHint,
        #[serde(default)]
        evidence: Vec<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryOutcome {
    Reattached,
    Replaced,
    Blocked,
    Lost,
    Stopped,
    AlreadyLive,
}

pub const LOSS_REPORT_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryEvidenceVerdict {
    DefinitiveNegative,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceStoreState {
    #[default]
    Unknown,
    NotApplicable,
    Missing,
    PresentReadable,
    PresentUnreadable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryPathEvidence {
    pub path: RecoveryPath,
    pub verdict: RecoveryEvidenceVerdict,
    pub reason_code: String,
    #[serde(default)]
    pub evidence_refs: Vec<String>,
    pub store_state: EvidenceStoreState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LossDecisionState {
    Lost,
    NonResumableTerminalEnded,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LossDecisionSummary {
    pub state: LossDecisionState,
    pub reason_code: String,
    pub unknown_paths: u32,
    pub retained_recoverable_evidence: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LossBuildEvidence {
    pub web_commit: String,
    pub supervisor_commit: String,
    pub host_image_digest: String,
    pub provider_version: String,
    pub protocol_version: u32,
    pub registry_schema_version: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncidentTimelineEvent {
    pub seq: u64,
    pub at: String,
    pub event: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oom_killed: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupDecisionEvidence {
    pub owned_handle_ref: String,
    pub ownership_verified: bool,
    pub incarnation_id: IncarnationId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LossCleanupReport {
    pub owned_handle_ref: String,
    pub ownership_verified: bool,
    pub graceful_attempt: String,
    pub forced_attempt: String,
    pub verified_empty: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verified_at: Option<String>,
    pub foreign_objects_touched: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncidentAnalysis {
    pub observed_cause: String,
    pub missing_invariant: String,
    #[serde(default)]
    pub hypotheses: Vec<String>,
    pub preventive_action: String,
    pub regression_case: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LostDecisionCertificate {
    pub schema_version: u32,
    pub event: String,
    pub incident_id: IncidentId,
    pub correlation_id: CorrelationId,
    pub installation_id: InstallationId,
    pub soul_id: SoulId,
    pub provider: String,
    pub provider_store_id: String,
    pub native_session_ref_hash: String,
    pub intent_revision: u64,
    #[serde(default)]
    pub incarnations: Vec<IncarnationId>,
    pub builds: LossBuildEvidence,
    #[serde(default)]
    pub timeline: Vec<IncidentTimelineEvent>,
    #[serde(default)]
    pub recovery_paths: Vec<RecoveryPathEvidence>,
    pub decision: LossDecisionSummary,
    pub cleanup_target: CleanupDecisionEvidence,
    pub analysis: IncidentAnalysis,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LossIncidentState {
    CleanupPending,
    CleanupFailed,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LossIncidentSummary {
    pub incident_id: IncidentId,
    pub correlation_id: CorrelationId,
    pub soul_id: SoulId,
    pub provider: String,
    pub state: LossIncidentState,
    pub reason_code: String,
    pub observed_cause: String,
    pub cleanup: LossCleanupReport,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NoticeKind {
    CleanupSucceeded,
    CleanupFailed,
    EndedWithoutProcess,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NoticeDeliveryState {
    Pending,
    Rendered,
    Acknowledged,
    Dismissed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeNotice {
    pub notice_id: NoticeId,
    pub kind: NoticeKind,
    pub message: String,
    pub reference: String,
    #[serde(default)]
    pub incident_ids: Vec<IncidentId>,
    pub delivery_state: NoticeDeliveryState,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingNoticesRequest {
    pub profile_id: String,
    #[serde(default = "default_projection_limit")]
    pub limit: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_control_epoch: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoticeReceiptRequest {
    pub notice_id: NoticeId,
    pub profile_id: String,
    pub state: NoticeDeliveryState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_control_epoch: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncidentSummaryRequest {
    pub incident_id: IncidentId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_control_epoch: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCounter {
    pub name: String,
    pub label: String,
    pub value: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeMetricsSnapshot {
    #[serde(default)]
    pub counters: Vec<RuntimeCounter>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ManagedRolloutMode {
    #[default]
    Legacy,
    ManagedOptIn,
    ManagedDefault,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationPlanRequest {
    pub requested_mode: ManagedRolloutMode,
    #[serde(default)]
    pub apply: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_path: Option<String>,
    /// Optional legacy metadata source inspected read-only. Phase 5 never
    /// rewrites or deletes the source, even when applying the rollout mode.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legacy_metadata_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_control_epoch: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationPlan {
    pub migration_id: MigrationId,
    pub current_mode: ManagedRolloutMode,
    pub requested_mode: ManagedRolloutMode,
    pub dry_run: bool,
    pub controller_ready: bool,
    pub image_verified: bool,
    pub registry_backup_required: bool,
    pub registry_backup_verified: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registry_backup_path: Option<String>,
    pub managed_soul_count: u64,
    pub legacy_metadata_count: u64,
    pub projected_cpu_milli: u64,
    pub projected_memory_bytes: u64,
    pub projected_pids: u64,
    #[serde(default)]
    pub blockers: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairRequest {
    #[serde(default)]
    pub apply: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_control_epoch: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairAudit {
    pub registry_integrity: String,
    pub protected_receipt_count: u64,
    pub unresolved_object_count: u64,
    pub unknown_ownership_count: u64,
    #[serde(default)]
    pub blocked_objects: Vec<String>,
    pub mutation_performed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LaunchState {
    Prepared,
    Created,
    Starting,
    Running,
    Stopping,
    Stopped,
    Failed,
}

impl LaunchState {
    pub fn is_potentially_active(self) -> bool {
        matches!(
            self,
            Self::Prepared | Self::Created | Self::Starting | Self::Running | Self::Stopping
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CleanupState {
    None,
    Requested,
    TerminationUnconfirmed,
    VerifiedEmpty,
    BlockedOwnership,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopOutcome {
    VerifiedEmpty,
    BlockedOwnership,
    BackendUnavailable,
    TerminationUnconfirmed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RuntimeErrorCode {
    InvalidRequest,
    ProtocolVersionMismatch,
    UnauthorizedRole,
    FrameTooLarge,
    RequestIdConflict,
    RegistryBusy,
    RegistryFailure,
    StaleControlEpoch,
    StaleIntentRevision,
    LossCertificationBlocked,
    IncidentPersistenceFailed,
    NoticeNotFound,
    MigrationBlocked,
    RepairBlocked,
    UnknownSoul,
    UnknownIncarnation,
    OwnershipMismatch,
    BackendUnavailable,
    TerminationUnconfirmed,
    HostUnreachable,
    HostAuthenticationFailed,
    StaleExecutionGrant,
    InvalidRuntimeLimits,
    BlockedResource,
    CommandAmbiguous,
    OutputCursorExpired,
    UnsupportedWorkload,
    UnsupportedOperation,
    OperationImplementationUnavailable,
    FaultInjected,
    RecoveryBlocked,
    RecoveryImplementationUnavailable,
    RecoveryWrongIdentity,
    RecoveryRetryBudget,
    RecoveryInProgress,
    RecoveryStopUnconfirmed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeLimits {
    pub cpu_milli: u64,
    pub memory_bytes: u64,
    /// Additional swap beyond `memory_bytes`. Zero means no swap allowance.
    pub swap_bytes: u64,
    pub pids_max: u64,
}

impl RuntimeLimits {
    pub fn validate(self) -> Result<Self, RuntimeError> {
        if self.cpu_milli == 0
            || self.memory_bytes < 16 * 1024 * 1024
            || self.pids_max == 0
            || self.cpu_milli > 1_000_000
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvalidRuntimeLimits,
                "runtime limits are outside the supported range",
            ));
        }
        Ok(self)
    }
}

/// Named resource profile saved with a managed soul. The numeric limits remain
/// authoritative; the profile records user intent and supports future edits without
/// silently changing a running incarnation.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeProfile {
    DefaultAgent,
    TestFixture,
    // Backward-compatible wire default for Phase 1 callers, which supplied
    // explicit numeric limits before named profiles existed. New managed
    // terminal callers always send an explicit profile.
    #[default]
    Custom,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InitialScanState {
    #[default]
    Pending,
    Scanning,
    Complete,
    Blocked,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ViewIntentKind {
    #[default]
    AutomaticPrimary,
    Explicit,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ViewVisibilityIntent {
    #[default]
    Visible,
    Detached,
    Hidden,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewIntent {
    pub view_id: ViewIntentId,
    pub soul_id: SoulId,
    pub owner_id: String,
    pub workspace_id: String,
    pub kind: ViewIntentKind,
    pub preferred_tab_id: String,
    pub preferred_pane_id: String,
    pub title: String,
    pub placement_group: String,
    pub visibility: ViewVisibilityIntent,
    pub revision: u64,
    pub soul_intent_revision: u64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewIntentRequest {
    #[serde(default)]
    pub owner_id: String,
    #[serde(default)]
    pub workspace_id: String,
    #[serde(default)]
    pub kind: ViewIntentKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_pane_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placement_group: Option<String>,
    #[serde(default)]
    pub visibility: ViewVisibilityIntent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeReadiness {
    pub inventory_revision: u64,
    pub initial_scan_state: InitialScanState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_scan_started_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_scan_finished_at: Option<i64>,
    #[serde(default)]
    pub blocked_subsystems: Vec<String>,
    #[serde(default = "default_startup_recovery_concurrency")]
    pub startup_recovery_concurrency_limit: u32,
    #[serde(default)]
    pub startup_recovery_peak: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_scan_duration_ms: Option<u64>,
}

fn default_startup_recovery_concurrency() -> u32 {
    4
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInventorySnapshot {
    pub revision: u64,
    pub readiness: RuntimeReadiness,
    #[serde(default)]
    pub souls: Vec<RuntimeView>,
    #[serde(default)]
    pub view_intents: Vec<ViewIntent>,
    #[serde(default)]
    pub pending_projection_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewProjectionEvent {
    pub event_id: ProjectionEventId,
    pub event_kind: String,
    pub view_intent: ViewIntent,
    pub soul_intent_revision: u64,
    #[serde(default)]
    pub inventory_revision: u64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LimitApplication {
    AppliedNow,
    NextIncarnation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderBootstrapFile {
    /// Canonical host path. This is a credential/config REFERENCE only; file
    /// bytes never enter the supervisor registry or Docker JSON payload.
    pub source_path: String,
    /// Relative path under the soul-owned provider HOME.
    pub provider_relative_path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderSecretProfile {
    /// The approved OneCLI deployment: Amplifier's VLLM module talks to the
    /// LunaRoute-compatible upstream through the credentialed HTTPS proxy
    /// referenced by the user's private keys.env.
    AmplifierOnecliLunarouteGlm53,
    /// Deserialization-only compatibility for pre-correction candidate state.
    /// Validation and secret resolution reject it rather than silently running
    /// an old Anthropic/Haiku launch as the new LunaRoute profile.
    #[serde(rename = "amplifier_onecli_anthropic_haiku_low")]
    LegacyAmplifierOnecliAnthropicHaikuLow,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSecretReference {
    /// Canonical private host file. Only this reference is durable; the
    /// session host reads its read-only mount immediately before child spawn.
    pub source_path: String,
    pub profile: ProviderSecretProfile,
}

/// Fresh-agent provider hosted inside one managed soul enclosure. Kilroy is
/// deliberately distinct from Claude because its runtime bundle/configuration
/// is part of the durable resume identity even though both use the Claude SDK.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FreshProvider {
    Claude,
    Kilroy,
    Codex,
    Opencode,
}

impl FreshProvider {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Kilroy => "kilroy",
            Self::Codex => "codex",
            Self::Opencode => "opencode",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentLaunchSpec {
    /// Stable presentation/session key used by the external Freshell wire.
    pub session_id: String,
    pub provider: FreshProvider,
    /// `freshclaude`, `kilroy`, `freshcodex`, or `freshopencode`.
    pub session_type: String,
    /// Provider runtime/bundle variant; never inferred again during recovery.
    pub runtime_variant: String,
    pub provider_store_id: String,
    pub cwd: String,
    pub workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_common_dir: Option<String>,
    pub run_as_uid: u32,
    pub run_as_gid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub provider_bootstrap_files: Vec<ProviderBootstrapFile>,
}

impl FreshAgentLaunchSpec {
    pub fn validate(&self) -> Result<(), RuntimeError> {
        let expected_type = match self.provider {
            FreshProvider::Claude => "freshclaude",
            FreshProvider::Kilroy => "kilroy",
            FreshProvider::Codex => "freshcodex",
            FreshProvider::Opencode => "freshopencode",
        };
        if self.session_id.is_empty()
            || self.session_type != expected_type
            || self.runtime_variant.is_empty()
            || self.provider_store_id.is_empty()
            || self.cwd.is_empty()
            || self.workspace_path.is_empty()
            || self.run_as_uid == 0
            || self.native_session_id.as_deref().is_some_and(str::is_empty)
            || self.provider_bootstrap_files.len() > 16
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                "managed fresh-agent launch has invalid required fields",
            ));
        }
        for value in [
            self.model.as_deref(),
            self.effort.as_deref(),
            self.permission_mode.as_deref(),
            self.sandbox.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            if value.len() > 256 || value.chars().any(char::is_control) {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::InvalidRequest,
                    "managed fresh-agent setting is oversized or contains control characters",
                ));
            }
        }
        for file in &self.provider_bootstrap_files {
            let source = std::path::Path::new(&file.source_path);
            let relative = std::path::Path::new(&file.provider_relative_path);
            if !source.is_absolute()
                || relative.is_absolute()
                || file.provider_relative_path.is_empty()
                || relative.components().any(|component| {
                    matches!(
                        component,
                        std::path::Component::ParentDir
                            | std::path::Component::RootDir
                            | std::path::Component::Prefix(_)
                    )
                })
            {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::InvalidRequest,
                    "managed provider bootstrap file path is unsafe",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum AgentEvent {
    Started {
        native_session_id: String,
    },
    Provider {
        payload: serde_json::Value,
    },
    PermissionRequested {
        decision_id: String,
        payload: serde_json::Value,
    },
    DecisionResolved {
        decision_id: String,
    },
    CommandOutcome {
        request_id: RequestId,
        state: CommandState,
    },
    Interrupted,
    Exited {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentJournalEvent {
    pub sequence: u64,
    pub event: AgentEvent,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventBatch {
    pub retained_from: u64,
    pub head: u64,
    pub reset_required: bool,
    pub events: Vec<AgentJournalEvent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalLaunchSpec {
    pub terminal_id: String,
    pub stream_id: String,
    pub mode: String,
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
    pub cwd: String,
    /// Numeric unprivileged identity used for the provider PTY child.
    /// The rootless Docker backend uses uid 65534 with gid 0: the mapped
    /// workspace remains group-writable while root-owned 0600 control files
    /// stay inaccessible. The trusted session host is the only uid-0 process.
    pub run_as_uid: u32,
    pub run_as_gid: u32,
    pub cols: u16,
    pub rows: u16,
    pub project_key: String,
    pub workspace_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_common_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub create_request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_session_id: Option<String>,
    /// Provider settings needed by host-owned helper services (notably the
    /// Codex app-server). These are ordinary launch policy, never credentials.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_reasoning_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_sandbox: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_permission_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub provider_bootstrap_files: Vec<ProviderBootstrapFile>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub provider_secret_references: Vec<ProviderSecretReference>,
}

impl TerminalLaunchSpec {
    pub fn validate(&self) -> Result<(), RuntimeError> {
        if self.terminal_id.is_empty()
            || self.stream_id.is_empty()
            || self.mode.is_empty()
            || self.program.is_empty()
            || self.cwd.is_empty()
            || self.project_key.is_empty()
            || self.workspace_path.is_empty()
            || self.run_as_uid == 0
            || self.cols == 0
            || self.rows == 0
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                "managed terminal launch has an empty/root-uid required field",
            ));
        }
        if self.env.len() > 512
            || self.args.len() > 512
            || self.provider_bootstrap_files.len() > 16
            || self.provider_secret_references.len() > 4
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                "managed terminal launch exceeds argv/env/bootstrap bounds",
            ));
        }
        for (name, value) in [
            ("providerModel", self.provider_model.as_deref()),
            (
                "providerReasoningEffort",
                self.provider_reasoning_effort.as_deref(),
            ),
            ("providerSandbox", self.provider_sandbox.as_deref()),
            (
                "providerPermissionMode",
                self.provider_permission_mode.as_deref(),
            ),
        ] {
            if let Some(value) = value {
                if value.is_empty() || value.len() > 256 || value.chars().any(|ch| ch.is_control())
                {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::InvalidRequest,
                        format!("managed terminal {name} is empty, oversized, or contains control characters"),
                    ));
                }
            }
        }
        for file in &self.provider_bootstrap_files {
            let source = std::path::Path::new(&file.source_path);
            let relative = std::path::Path::new(&file.provider_relative_path);
            if !source.is_absolute()
                || relative.is_absolute()
                || file.provider_relative_path.is_empty()
                || relative.components().any(|component| {
                    matches!(
                        component,
                        std::path::Component::ParentDir
                            | std::path::Component::RootDir
                            | std::path::Component::Prefix(_)
                    )
                })
            {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::InvalidRequest,
                    "managed provider bootstrap file path is unsafe",
                ));
            }
        }
        for secret in &self.provider_secret_references {
            let source = std::path::Path::new(&secret.source_path);
            if self.mode != "amplifier"
                || !source.is_absolute()
                || secret.source_path.chars().any(char::is_control)
                || !matches!(
                    secret.profile,
                    ProviderSecretProfile::AmplifierOnecliLunarouteGlm53
                )
            {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::InvalidRequest,
                    "managed provider secret reference is unsafe or unsupported",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandState {
    Queued,
    Dispatching,
    ProviderAcked,
    Completed,
    Ambiguous,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeOutputFrame {
    pub terminal_id: String,
    pub stream_epoch: String,
    pub seq_start: u64,
    pub seq_end: u64,
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeOutputBatch {
    pub incarnation_id: IncarnationId,
    pub terminal_id: String,
    pub stream_epoch: String,
    pub retained_from_seq: u64,
    pub head_seq: u64,
    pub reset_required: bool,
    pub truncated: bool,
    #[serde(default)]
    pub exited: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    /// Provider-native durable conversation id discovered by the session host.
    /// For OpenCode this is the soul-local `ses_*` row, never a web-side guess.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_session_id: Option<String>,
    #[serde(default)]
    pub frames: Vec<RuntimeOutputFrame>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeMetrics {
    pub cpu_usage_usec: u64,
    pub cpu_throttled_usec: u64,
    pub cpu_nr_throttled: u64,
    pub memory_current_bytes: u64,
    pub memory_peak_bytes: u64,
    pub memory_oom: u64,
    pub memory_oom_kill: u64,
    pub pids_current: u64,
    pub pids_max: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInputRequest {
    pub soul_id: SoulId,
    pub data: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_control_epoch: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentTurnSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentSendRequest {
    pub soul_id: SoulId,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<FreshAgentTurnSettings>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_control_epoch: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentForkRequest {
    pub soul_id: SoulId,
    pub parent_session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_control_epoch: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentForkResult {
    pub parent_session_id: String,
    pub child_session_id: String,
    pub parent_retired_by_runtime: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentResolveRequest {
    pub soul_id: SoulId,
    pub decision_id: String,
    pub decision: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_control_epoch: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentInterruptRequest {
    pub soul_id: SoulId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_control_epoch: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentReadEventsRequest {
    pub soul_id: SoulId,
    pub after_sequence: u64,
    pub max_events: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_control_epoch: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalResizeRequest {
    pub soul_id: SoulId,
    pub cols: u16,
    pub rows: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_control_epoch: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalReadOutputRequest {
    pub soul_id: SoulId,
    pub after_seq: u64,
    pub max_bytes: u64,
    /// Source epoch the caller has already rendered. Older clients omit it;
    /// the host then preserves cursor-only behavior for wire compatibility.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_stream_epoch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_control_epoch: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeMetricsRequest {
    pub soul_id: SoulId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_control_epoch: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeError {
    pub code: RuntimeErrorCode,
    pub message: String,
}

impl RuntimeError {
    pub fn new(code: RuntimeErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlRole {
    Web,
    Supervisor,
    Runtime,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope<T> {
    pub protocol_version: u32,
    pub request_id: RequestId,
    pub role: ControlRole,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth: Option<String>,
    pub body: T,
}

impl<T> Envelope<T> {
    pub fn new(request_id: RequestId, role: ControlRole, body: T) -> Self {
        Self {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            request_id,
            role,
            auth: None,
            body,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRequest {
    pub soul_id: SoulId,
    pub provider: String,
    pub provider_store_id: String,
    pub creation_seed_ref: String,
    pub limits: RuntimeLimits,
    #[serde(default)]
    pub profile: RuntimeProfile,
    #[serde(default = "default_project_key")]
    pub project_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fixture: Option<FixtureKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal: Option<TerminalLaunchSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fresh_agent: Option<FreshAgentLaunchSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view_intent: Option<ViewIntentRequest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_control_epoch: Option<u64>,
}

fn default_project_key() -> String {
    "default".to_string()
}

impl LaunchRequest {
    pub fn validate_workload(&self) -> Result<(), RuntimeError> {
        match (&self.fixture, &self.terminal, &self.fresh_agent) {
            (Some(_), None, None) => Ok(()),
            (None, Some(terminal), None) => terminal.validate(),
            (None, None, Some(agent)) => {
                agent.validate()?;
                if self.provider != agent.provider.as_str()
                    || self.provider_store_id != agent.provider_store_id
                    || (self.native_session_id.is_some()
                        && self.native_session_id != agent.native_session_id)
                {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::InvalidRequest,
                        "fresh-agent workload identity disagrees with its soul launch",
                    ));
                }
                Ok(())
            }
            _ => Err(RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                "launch must specify exactly one fixture, terminal, or fresh-agent workload",
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FixtureKind {
    Heartbeat,
    DescendantSpawner,
    CpuBurner,
    MemoryAllocator,
    NativeSession,
    SecurityProbe,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopRequest {
    pub soul_id: SoulId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_intent_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_control_epoch: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryProbeRequest {
    pub soul_id: SoulId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_control_epoch: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverRequest {
    pub soul_id: SoulId,
    #[serde(default = "default_recovery_trigger")]
    pub trigger: RecoveryTrigger,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_intent_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_control_epoch: Option<u64>,
}

fn default_recovery_trigger() -> RecoveryTrigger {
    RecoveryTrigger::ExplicitRequest
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingViewProjectionsRequest {
    #[serde(default = "default_projection_limit")]
    pub limit: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_control_epoch: Option<u64>,
}

fn default_projection_limit() -> u32 {
    100
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcknowledgeViewProjectionRequest {
    pub event_id: ProjectionEventId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_control_epoch: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateViewVisibilityRequest {
    pub view_id: ViewIntentId,
    pub visibility: ViewVisibilityIntent,
    pub expected_revision: u64,
    pub expected_soul_intent_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_control_epoch: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertViewIntentRequest {
    pub soul_id: SoulId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view_id: Option<ViewIntentId>,
    pub intent: ViewIntentRequest,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u64>,
    pub expected_soul_intent_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_control_epoch: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateLimitsRequest {
    pub soul_id: SoulId,
    pub limits: RuntimeLimits,
    pub expected_intent_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_control_epoch: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QualificationWriterClaimRequest {
    pub provider: String,
    pub native_session_id: String,
    pub soul_id: SoulId,
    pub incarnation_id: IncarnationId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QualificationWriterClaimEvidence {
    pub provider: String,
    pub provider_store_id: String,
    pub native_session_id: String,
    pub soul_id: SoulId,
    pub incarnation_id: IncarnationId,
    pub active_claim_count: u64,
    pub global_conflicting_claim_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "method", content = "params", rename_all = "snake_case")]
pub enum AdminCommand {
    Health,
    Launch(Box<LaunchRequest>),
    Stop(StopRequest),
    Inventory,
    InventorySnapshot,
    PendingViewProjections(PendingViewProjectionsRequest),
    AcknowledgeViewProjection(AcknowledgeViewProjectionRequest),
    UpdateViewVisibility(UpdateViewVisibilityRequest),
    UpsertViewIntent(UpsertViewIntentRequest),
    UpdateLimits(UpdateLimitsRequest),
    QualificationWriterClaim(QualificationWriterClaimRequest),
    PendingNotices(PendingNoticesRequest),
    NoticeReceipt(NoticeReceiptRequest),
    IncidentSummary(IncidentSummaryRequest),
    MetricsSnapshot,
    MigrationPlan(MigrationPlanRequest),
    RepairAudit(RepairRequest),
    TerminalInput(TerminalInputRequest),
    TerminalResize(TerminalResizeRequest),
    TerminalReadOutput(TerminalReadOutputRequest),
    FreshAgentSend(FreshAgentSendRequest),
    FreshAgentFork(FreshAgentForkRequest),
    FreshAgentCompact(FreshAgentCompactRequest),
    FreshAgentRollback(FreshAgentRollbackRequest),
    FreshAgentCapture(FreshAgentCaptureRequest),
    FreshAgentResolve(FreshAgentResolveRequest),
    FreshAgentInterrupt(FreshAgentInterruptRequest),
    FreshAgentReadEvents(FreshAgentReadEventsRequest),
    RuntimeMetrics(RuntimeMetricsRequest),
    ProbeRecovery(RecoveryProbeRequest),
    Recover(RecoverRequest),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeView {
    pub soul_id: SoulId,
    pub incarnation_id: IncarnationId,
    pub launch_state: LaunchState,
    pub cleanup_state: CleanupState,
    pub intent_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub container_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_boot_id: Option<HostBootId>,
    pub execution_generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_limits: Option<RuntimeLimits>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configured_limits: Option<RuntimeLimits>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view_intent_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_stream_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_create_request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_resume_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fresh_agent_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fresh_agent_session_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fresh_agent_runtime_variant: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<RuntimeProfile>,
    #[serde(default)]
    pub desired_state: DesiredState,
    #[serde(default)]
    pub recovery_state: RecoveryState,
    #[serde(default)]
    pub durability_state: DurabilityState,
    #[serde(default)]
    pub allocation_state: AllocationState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub incident_id: Option<IncidentId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prior_incarnation_id: Option<IncarnationId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery_attempt_id: Option<RecoveryAttemptId>,
    #[serde(default)]
    pub evidence_revision: u64,
    #[serde(default)]
    pub successful_recoveries_in_window: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryResult {
    pub outcome: RecoveryOutcome,
    pub view: RuntimeView,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub probe: Option<RecoveryProbe>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prior_incarnation_id: Option<IncarnationId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<RecoveryAttemptId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_native_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed_native_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub incident_id: Option<IncidentId>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateLimitsResult {
    pub view: RuntimeView,
    pub application: LimitApplication,
    pub configured_limits: RuntimeLimits,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_limits: Option<RuntimeLimits>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchResult {
    pub view: RuntimeView,
    pub worker_pid: u32,
    pub worker_launch_count: u64,
    pub host_boot_id: HostBootId,
    pub effective_limits: RuntimeLimits,
    #[serde(default)]
    pub fixture_evidence: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum AdminResult {
    Health {
        control_epoch: u64,
        installation_id: InstallationId,
    },
    Launch(LaunchResult),
    Stop {
        outcome: StopOutcome,
        view: RuntimeView,
    },
    Inventory(Vec<RuntimeView>),
    InventorySnapshot(RuntimeInventorySnapshot),
    PendingViewProjections(Vec<ViewProjectionEvent>),
    ViewProjectionAcknowledged,
    ViewIntent(ViewIntent),
    UpdateLimits(UpdateLimitsResult),
    QualificationWriterClaim(QualificationWriterClaimEvidence),
    PendingNotices(Vec<RuntimeNotice>),
    NoticeReceiptRecorded,
    IncidentSummary(LossIncidentSummary),
    MetricsSnapshot(RuntimeMetricsSnapshot),
    MigrationPlan(MigrationPlan),
    RepairAudit(RepairAudit),
    TerminalInput {
        state: CommandState,
    },
    TerminalResize,
    TerminalOutput(RuntimeOutputBatch),
    FreshAgentCommand {
        state: CommandState,
    },
    FreshAgentFork(FreshAgentForkResult),
    FreshAgentCapture(FreshAgentCapture),
    FreshAgentInterrupted,
    FreshAgentEvents(AgentEventBatch),
    RuntimeMetrics(RuntimeMetrics),
    RecoveryProbe(RecoveryProbe),
    Recovery(RecoveryResult),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminReply {
    pub request_id: RequestId,
    pub result: Result<AdminResult, RuntimeError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "method", content = "params", rename_all = "snake_case")]
pub enum HostCommand {
    Hello {
        incarnation_id: IncarnationId,
        challenge: String,
    },
    GrantExecution {
        incarnation_id: IncarnationId,
        soul_id: SoulId,
        host_boot_id: HostBootId,
        control_epoch: u64,
        execution_generation: u64,
        grant_id: GrantId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fixture: Option<FixtureKind>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        terminal: Option<Box<TerminalLaunchSpec>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fresh_agent: Option<Box<FreshAgentLaunchSpec>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resume_spec: Option<Box<ResumeSpec>>,
    },
    Stop {
        incarnation_id: IncarnationId,
        control_epoch: u64,
        execution_generation: u64,
    },
    SecurityProbe {
        incarnation_id: IncarnationId,
    },
    Status {
        incarnation_id: IncarnationId,
    },
    TerminalInput {
        incarnation_id: IncarnationId,
        request_id: RequestId,
        data: String,
    },
    TerminalResize {
        incarnation_id: IncarnationId,
        cols: u16,
        rows: u16,
    },
    TerminalReadOutput {
        incarnation_id: IncarnationId,
        after_seq: u64,
        max_bytes: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expected_stream_epoch: Option<String>,
    },
    FreshAgentSend {
        incarnation_id: IncarnationId,
        request_id: RequestId,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        settings: Option<FreshAgentTurnSettings>,
    },
    FreshAgentFork {
        incarnation_id: IncarnationId,
        request_id: RequestId,
        parent_session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input: Option<serde_json::Value>,
    },
    FreshAgentCompact {
        incarnation_id: IncarnationId,
        request_id: RequestId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        instructions: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    FreshAgentRollback {
        incarnation_id: IncarnationId,
        request_id: RequestId,
        direction: FreshAgentRollbackDirection,
        mode: FreshAgentRollbackMode,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    FreshAgentCapture {
        incarnation_id: IncarnationId,
        max_bytes: u32,
    },
    FreshAgentResolve {
        incarnation_id: IncarnationId,
        decision_id: String,
        decision: serde_json::Value,
    },
    FreshAgentInterrupt {
        incarnation_id: IncarnationId,
    },
    FreshAgentReadEvents {
        incarnation_id: IncarnationId,
        after_sequence: u64,
        max_events: u32,
    },
    RuntimeMetrics {
        incarnation_id: IncarnationId,
    },
    ProbeRecovery {
        incarnation_id: IncarnationId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resume_spec: Option<Box<ResumeSpec>>,
        creation_seed_ref: String,
        never_dispatched: bool,
        run_as_uid: u32,
        run_as_gid: u32,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum HostResult {
    Hello {
        host_boot_id: HostBootId,
        proof: String,
        capabilities: Vec<String>,
        effective_limits: RuntimeLimits,
    },
    GrantAccepted {
        host_boot_id: HostBootId,
        worker_pid: u32,
        worker_launch_count: u64,
        fixture_evidence: serde_json::Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        native_session_id: Option<String>,
    },
    Stopped,
    SecurityProbe(serde_json::Value),
    TerminalInput {
        state: CommandState,
    },
    TerminalResize,
    TerminalOutput(RuntimeOutputBatch),
    FreshAgentCommand {
        state: CommandState,
        /// Provider identity observed and durably recorded by the host actor
        /// at the same acceptance boundary as this acknowledgement.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        native_session_id: Option<String>,
    },
    FreshAgentFork(FreshAgentForkResult),
    FreshAgentInterrupted,
    FreshAgentCapture(FreshAgentCapture),
    FreshAgentEvents(AgentEventBatch),
    RuntimeMetrics(RuntimeMetrics),
    Status {
        host_boot_id: HostBootId,
        worker_pid: Option<u32>,
        worker_launch_count: u64,
        max_control_epoch: u64,
        max_execution_generation: u64,
        #[serde(default)]
        fixture_evidence: serde_json::Value,
        #[serde(default)]
        exited: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        native_session_id: Option<String>,
    },
    RecoveryProbe(RecoveryProbe),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostReply {
    pub request_id: RequestId,
    pub result: Result<HostResult, RuntimeError>,
}

pub fn host_proof(
    secret: &[u8],
    challenge: &str,
    host_boot_id: &HostBootId,
    incarnation_id: &IncarnationId,
) -> String {
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC accepts arbitrary key length");
    mac.update(challenge.as_bytes());
    mac.update(b"\0");
    mac.update(host_boot_id.as_str().as_bytes());
    mac.update(b"\0");
    mac.update(incarnation_id.as_str().as_bytes());
    hex_lower(&mac.finalize().into_bytes())
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0xf) as usize] as char);
    }
    out
}

#[derive(Debug, thiserror::Error)]
pub enum FrameError {
    #[error("control frame exceeds {MAX_CONTROL_FRAME_BYTES} bytes")]
    TooLarge,
    #[error("control frame I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("control frame JSON failed: {0}")]
    Json(#[from] serde_json::Error),
}

pub async fn write_frame<W, T>(writer: &mut W, value: &T) -> Result<(), FrameError>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() > MAX_CONTROL_FRAME_BYTES {
        return Err(FrameError::TooLarge);
    }
    writer
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .await?;
    writer.write_all(&bytes).await?;
    writer.flush().await?;
    Ok(())
}

pub async fn read_frame<R, T>(reader: &mut R) -> Result<T, FrameError>
where
    R: AsyncRead + Unpin,
    T: DeserializeOwned,
{
    let mut len = [0u8; 4];
    reader.read_exact(&mut len).await?;
    let len = u32::from_be_bytes(len) as usize;
    if len > MAX_CONTROL_FRAME_BYTES {
        return Err(FrameError::TooLarge);
    }
    let mut bytes = vec![0; len];
    reader.read_exact(&mut bytes).await?;
    Ok(serde_json::from_slice(&bytes)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_reject_control_characters_and_are_distinct() {
        assert!(SoulId::parse("bad\nvalue").is_err());
        assert_ne!(SoulId::new(), SoulId::new());
    }

    #[test]
    fn hmac_proof_is_scoped_to_boot_and_incarnation() {
        let incarnation = IncarnationId::new();
        let boot = HostBootId::new();
        let one = host_proof(b"secret", "challenge", &boot, &incarnation);
        let two = host_proof(b"secret", "challenge", &HostBootId::new(), &incarnation);
        assert_ne!(one, two);
    }

    #[tokio::test]
    async fn frame_rejects_oversized_payload_before_allocation() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&((MAX_CONTROL_FRAME_BYTES as u32) + 1).to_be_bytes());
        let mut cursor = std::io::Cursor::new(bytes);
        let result: Result<serde_json::Value, _> = read_frame(&mut cursor).await;
        assert!(matches!(result, Err(FrameError::TooLarge)));
    }

    #[tokio::test]
    async fn frame_round_trips() {
        let envelope = Envelope::new(RequestId::new(), ControlRole::Web, AdminCommand::Health);
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &envelope).await.unwrap();
        let mut cursor = std::io::Cursor::new(bytes);
        let restored: Envelope<AdminCommand> = read_frame(&mut cursor).await.unwrap();
        assert_eq!(restored.protocol_version, CONTROL_PROTOCOL_VERSION);
        assert!(matches!(restored.body, AdminCommand::Health));
    }

    #[test]
    fn legacy_resume_spec_remains_readable_after_contract_expansion() {
        let legacy = serde_json::json!({
            "providerSession": {
                "provider": "opencode",
                "providerStoreId": "store-one",
                "nativeSessionId": "ses_exact"
            },
            "mode": "opencode",
            "program": "opencode",
            "resumeArgv": ["--session", "ses_exact"],
            "providerHome": "/home/freshell/provider",
            "cwd": "/workspace",
            "workspacePath": "/workspace",
            "environment": {"HOME": "/home/freshell/provider"},
            "providerVersion": "1.18.21",
            "creationSeedRef": "seed-one",
            "checkpointRevision": 0,
            "allocationState": "verified_durable",
            "evidenceRevision": 7,
            "neverDispatched": false
        });
        let spec: ResumeSpec = serde_json::from_value(legacy).unwrap();
        assert_eq!(spec.schema_version, RESUME_SPEC_SCHEMA_VERSION);
        assert_eq!(spec.runtime_variant, "");
        assert_eq!(spec.provider_volume, None);
        assert_eq!(spec.identity_provenance, IdentityProvenance::Unknown);
        assert_eq!(spec.durable_position, DurablePosition::default());
        assert!(spec.credential_references.is_empty());
        assert!(spec.checkpoint_references.is_empty());
    }

    #[test]
    fn recovery_contract_serializes_references_not_credential_bytes() {
        let spec = ResumeSpec {
            schema_version: RESUME_SPEC_SCHEMA_VERSION,
            provider_session: ProviderSessionRef {
                provider: "claude".into(),
                provider_store_id: "store-one".into(),
                native_session_id: "session-one".into(),
            },
            mode: "claude".into(),
            runtime_variant: "managed_terminal_pty".into(),
            program: "claude".into(),
            resume_argv: vec!["--resume".into(), "session-one".into()],
            provider_home: "/home/freshell/provider".into(),
            provider_volume: Some(ProviderVolumeRef {
                volume_name: "freshell-provider-soul-one".into(),
                mount_path: "/home/freshell/provider".into(),
            }),
            cwd: "/workspace".into(),
            workspace_path: "/workspace".into(),
            project_key: Some("project-one".into()),
            runtime_profile: Some(RuntimeProfile::DefaultAgent),
            environment: std::collections::BTreeMap::from([(
                "HOME".into(),
                "/home/freshell/provider".into(),
            )]),
            model: Some("haiku".into()),
            reasoning_effort: Some("low".into()),
            permission_mode: Some("default".into()),
            image_ref: Some("sha256:image".into()),
            provider_version: Some("1.0.0".into()),
            credential_references: vec![CredentialReference {
                provider_relative_path: ".claude/.credentials.json".into(),
            }],
            identity_provenance: IdentityProvenance::ProviderObserved,
            durable_position: DurablePosition {
                accepted_command_count: 2,
                completed_command_count: 1,
                output_sequence: 9,
                provider_cursor: Some("transcript:9".into()),
            },
            checkpoint_references: vec![CheckpointReference {
                kind: "provider_state".into(),
                reference: "soul://soul-one/checkpoint/3".into(),
                revision: 3,
                verified: true,
            }],
            creation_seed_ref: "seed-one".into(),
            checkpoint_revision: 3,
            allocation_state: AllocationState::VerifiedDurable,
            evidence_revision: 9,
            never_dispatched: false,
        };
        let encoded = serde_json::to_string(&spec).unwrap();
        assert!(encoded.contains(".claude/.credentials.json"));
        assert!(!encoded.contains("secretbytes"));
        let restored: ResumeSpec = serde_json::from_str(&encoded).unwrap();
        assert_eq!(restored, spec);
    }

    #[test]
    fn recovery_probe_preserves_blocked_vs_definitive_semantics() {
        let blocked = RecoveryProbe::Blocked {
            path: RecoveryPath::NativeResume,
            reason: RecoveryBlockReason::CredentialsExpired,
            retry_hint: RetryHint {
                automatic_after_ms: None,
                manual_retry: true,
                repair: Some("refresh credentials".into()),
            },
            evidence: vec!["provider store remains present".into()],
        };
        let encoded = serde_json::to_value(&blocked).unwrap();
        assert_eq!(encoded["kind"], "blocked");
        assert_eq!(encoded["data"]["reason"], "CREDENTIALS_EXPIRED");
        assert!(matches!(
            serde_json::from_value::<RecoveryProbe>(encoded).unwrap(),
            RecoveryProbe::Blocked { .. }
        ));
    }

    #[test]
    fn legacy_amplifier_secret_profile_deserializes_but_is_not_reinterpreted() {
        let reference: ProviderSecretReference = serde_json::from_value(serde_json::json!({
            "sourcePath": "/private/keys.env",
            "profile": "amplifier_onecli_anthropic_haiku_low",
            "approvedEndpoint": "https://obsolete.example.invalid/v1"
        }))
        .unwrap();
        assert_eq!(
            reference.profile,
            ProviderSecretProfile::LegacyAmplifierOnecliAnthropicHaikuLow
        );
        assert_eq!(reference.source_path, "/private/keys.env");
    }

    #[test]
    fn managed_provider_options_are_bounded_and_control_free() {
        let mut spec = TerminalLaunchSpec {
            terminal_id: "terminal-one".into(),
            stream_id: "stream-one".into(),
            mode: "codex".into(),
            program: "codex".into(),
            args: Vec::new(),
            env: std::collections::BTreeMap::new(),
            cwd: "/workspace".into(),
            run_as_uid: 65_534,
            run_as_gid: 0,
            cols: 80,
            rows: 24,
            project_key: "project-one".into(),
            workspace_path: "/workspace".into(),
            git_common_dir: None,
            create_request_id: None,
            resume_session_id: None,
            provider_model: Some("gpt-5.6-luna".into()),
            provider_reasoning_effort: Some("minimal".into()),
            provider_sandbox: Some("workspace-write".into()),
            provider_permission_mode: Some("on-request".into()),
            provider_bootstrap_files: Vec::new(),
            provider_secret_references: Vec::new(),
        };
        assert!(spec.validate().is_ok());
        spec.provider_model = Some("bad\0model".into());
        assert!(spec.validate().is_err());
        spec.provider_model = Some("m".repeat(257));
        assert!(spec.validate().is_err());
        spec.provider_model = None;
        spec.provider_reasoning_effort = Some("line\nbreak".into());
        assert!(spec.validate().is_err());
        spec.provider_reasoning_effort = None;
        spec.provider_permission_mode = Some("line\nbreak".into());
        assert!(spec.validate().is_err());
    }

    fn fresh_agent_launch(provider: FreshProvider, session_type: &str) -> FreshAgentLaunchSpec {
        FreshAgentLaunchSpec {
            session_id: "presentation-one".into(),
            provider,
            session_type: session_type.into(),
            runtime_variant: "pinned-runtime-variant".into(),
            provider_store_id: "soul-store-one".into(),
            cwd: "/workspace/project".into(),
            workspace_path: "/workspace/project".into(),
            git_common_dir: Some("/workspace/project/.git".into()),
            run_as_uid: 65_534,
            run_as_gid: 0,
            model: Some("model-one".into()),
            effort: Some("high".into()),
            permission_mode: Some("ask".into()),
            sandbox: Some("workspace-write".into()),
            native_session_id: Some("native-one".into()),
            provider_bootstrap_files: vec![ProviderBootstrapFile {
                source_path: "/credential-reference-only".into(),
                provider_relative_path: ".provider/config.json".into(),
            }],
        }
    }

    #[test]
    fn terminal_output_epoch_hint_is_additive_and_round_trips() {
        let legacy: TerminalReadOutputRequest = serde_json::from_value(serde_json::json!({
            "soulId": "soul-output-compatibility",
            "afterSeq": 41,
            "maxBytes": 65536,
            "expectedControlEpoch": 7
        }))
        .unwrap();
        assert_eq!(legacy.expected_stream_epoch, None);

        let hinted = TerminalReadOutputRequest {
            soul_id: SoulId::parse("soul-output-compatibility").unwrap(),
            after_seq: 41,
            max_bytes: 65_536,
            expected_stream_epoch: Some("host-epoch-one".into()),
            expected_control_epoch: Some(7),
        };
        let encoded = serde_json::to_value(&hinted).unwrap();
        assert_eq!(encoded["expectedStreamEpoch"], "host-epoch-one");
        assert_eq!(
            serde_json::from_value::<TerminalReadOutputRequest>(encoded).unwrap(),
            hinted
        );

        let current_host = HostCommand::TerminalReadOutput {
            incarnation_id: IncarnationId::parse("incarnation-output-compatibility").unwrap(),
            after_seq: 41,
            max_bytes: 65_536,
            expected_stream_epoch: Some("host-epoch-one".into()),
        };
        let mut legacy_host = serde_json::to_value(current_host).unwrap();
        let params = legacy_host["params"].as_object_mut().unwrap();
        assert_eq!(
            params.remove("expected_stream_epoch"),
            Some(serde_json::json!("host-epoch-one"))
        );
        assert!(matches!(
            serde_json::from_value::<HostCommand>(legacy_host).unwrap(),
            HostCommand::TerminalReadOutput {
                expected_stream_epoch: None,
                ..
            }
        ));
    }

    #[test]
    fn fresh_agent_fork_is_a_same_runtime_session_transition_on_the_wire() {
        let request = FreshAgentForkRequest {
            soul_id: SoulId::parse("soul-fork-wire").unwrap(),
            parent_session_id: "native-parent".into(),
            input: Some(serde_json::json!({"atTurnId":"turn-4"})),
            expected_control_epoch: Some(8),
        };
        let encoded = serde_json::to_value(AdminCommand::FreshAgentFork(request.clone())).unwrap();
        assert_eq!(encoded["method"], "fresh_agent_fork");
        let decoded: AdminCommand = serde_json::from_value(encoded).unwrap();
        assert!(matches!(decoded, AdminCommand::FreshAgentFork(value) if value == request));

        let transition = FreshAgentForkResult {
            parent_session_id: "native-parent".into(),
            child_session_id: "native-child".into(),
            parent_retired_by_runtime: true,
        };
        let host = HostResult::FreshAgentFork(transition.clone());
        let decoded: HostResult =
            serde_json::from_value(serde_json::to_value(host).unwrap()).unwrap();
        assert!(matches!(decoded, HostResult::FreshAgentFork(value) if value == transition));
    }

    #[test]
    fn fresh_agent_launch_and_event_rpc_round_trip_without_secret_material() {
        for (provider, session_type) in [
            (FreshProvider::Claude, "freshclaude"),
            (FreshProvider::Kilroy, "kilroy"),
            (FreshProvider::Codex, "freshcodex"),
            (FreshProvider::Opencode, "freshopencode"),
        ] {
            let launch = fresh_agent_launch(provider, session_type);
            assert!(launch.validate().is_ok());
            let encoded = serde_json::to_string(&launch).unwrap();
            assert!(!encoded.contains("secret-token-value"));
            assert_eq!(
                serde_json::from_str::<FreshAgentLaunchSpec>(&encoded).unwrap(),
                launch
            );
        }

        let request = HostCommand::FreshAgentResolve {
            incarnation_id: IncarnationId::parse("incarnation-agent-rpc").unwrap(),
            decision_id: "decision-7".into(),
            decision: serde_json::json!({"behavior":"allow"}),
        };
        let encoded = serde_json::to_value(&request).unwrap();
        assert_eq!(encoded["method"], "fresh_agent_resolve");
        let decoded = serde_json::from_value::<HostCommand>(encoded).unwrap();
        assert!(matches!(
            decoded,
            HostCommand::FreshAgentResolve { decision_id, .. }
                if decision_id == "decision-7"
        ));
    }

    #[test]
    fn fresh_agent_validation_rejects_provider_type_mismatch_and_mixed_workloads() {
        let agent = fresh_agent_launch(FreshProvider::Codex, "freshclaude");
        assert_eq!(
            agent.validate().unwrap_err().code,
            RuntimeErrorCode::InvalidRequest
        );
        let mut request = LaunchRequest {
            soul_id: SoulId::parse("soul-agent-validation").unwrap(),
            provider: "codex".into(),
            provider_store_id: "soul-store-one".into(),
            creation_seed_ref: "seed-agent-validation".into(),
            limits: RuntimeLimits {
                cpu_milli: 1000,
                memory_bytes: 1024 * 1024 * 1024,
                swap_bytes: 0,
                pids_max: 128,
            },
            profile: RuntimeProfile::DefaultAgent,
            project_key: "project-agent-validation".into(),
            native_session_id: None,
            fixture: None,
            terminal: None,
            fresh_agent: Some(fresh_agent_launch(FreshProvider::Codex, "freshcodex")),
            view_intent: None,
            expected_control_epoch: None,
        };
        assert!(request.validate_workload().is_ok());
        request.fixture = Some(FixtureKind::Heartbeat);
        assert_eq!(
            request.validate_workload().unwrap_err().code,
            RuntimeErrorCode::InvalidRequest
        );

        let mut unsafe_agent = fresh_agent_launch(FreshProvider::Opencode, "freshopencode");
        unsafe_agent.provider_bootstrap_files[0].provider_relative_path =
            "../../run/freshell/secret".into();
        assert_eq!(
            unsafe_agent.validate().unwrap_err().code,
            RuntimeErrorCode::InvalidRequest
        );
    }

    #[test]
    fn phase4_inventory_and_view_intent_contract_round_trips() {
        let soul_id = SoulId::parse("soul-phase4-contract").unwrap();
        let view = ViewIntent {
            view_id: ViewIntentId::parse("view-phase4-contract").unwrap(),
            soul_id: soul_id.clone(),
            owner_id: "installation-owner".into(),
            workspace_id: "project-one".into(),
            kind: ViewIntentKind::AutomaticPrimary,
            preferred_tab_id: "managed-tab-phase4".into(),
            preferred_pane_id: "managed-pane-phase4".into(),
            title: "Recovered Claude agent".into(),
            placement_group: "Recovered agents".into(),
            visibility: ViewVisibilityIntent::Visible,
            revision: 3,
            soul_intent_revision: 7,
            created_at: 10,
            updated_at: 20,
        };
        let snapshot = RuntimeInventorySnapshot {
            revision: 11,
            readiness: RuntimeReadiness {
                inventory_revision: 11,
                initial_scan_state: InitialScanState::Complete,
                initial_scan_started_at: Some(5),
                initial_scan_finished_at: Some(9),
                blocked_subsystems: Vec::new(),
                startup_recovery_concurrency_limit: 4,
                startup_recovery_peak: 2,
                initial_scan_duration_ms: Some(4),
            },
            souls: Vec::new(),
            view_intents: vec![view],
            pending_projection_count: 1,
        };
        let encoded = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(encoded["readiness"]["initialScanState"], "complete");
        assert_eq!(encoded["viewIntents"][0]["kind"], "automatic_primary");
        assert_eq!(encoded["viewIntents"][0]["visibility"], "visible");
        assert_eq!(
            serde_json::from_value::<RuntimeInventorySnapshot>(encoded)
                .unwrap()
                .view_intents[0]
                .soul_id,
            soul_id
        );
    }

    #[test]
    fn legacy_runtime_view_stays_readable_after_phase4_optional_expansion() {
        let legacy = serde_json::json!({
            "soulId": "soul-legacy-view",
            "incarnationId": "incarnation-legacy-view",
            "launchState": "running",
            "cleanupState": "none",
            "intentRevision": 1,
            "executionGeneration": 1,
            "desiredState": "running",
            "recoveryState": "live",
            "durabilityState": "unknown",
            "allocationState": "allocated",
            "evidenceRevision": 0,
            "successfulRecoveriesInWindow": 0
        });
        let decoded: RuntimeView = serde_json::from_value(legacy).unwrap();
        assert_eq!(decoded.configured_limits, None);
        assert_eq!(decoded.view_intent_revision, None);
    }

    #[test]
    fn phase5_loss_and_notice_contract_round_trips_without_raw_native_identity() {
        let certificate = LostDecisionCertificate {
            schema_version: LOSS_REPORT_SCHEMA_VERSION,
            event: "soul.loss.finalized".into(),
            incident_id: IncidentId::parse("incident-contract").unwrap(),
            correlation_id: CorrelationId::parse("correlation-contract").unwrap(),
            installation_id: InstallationId::parse("installation-contract").unwrap(),
            soul_id: SoulId::parse("soul-contract").unwrap(),
            provider: "claude".into(),
            provider_store_id: "store-contract".into(),
            native_session_ref_hash: "sha256:deadbeef".into(),
            intent_revision: 7,
            incarnations: vec![IncarnationId::parse("incarnation-contract").unwrap()],
            builds: LossBuildEvidence {
                web_commit: "unknown".into(),
                supervisor_commit: "commit".into(),
                host_image_digest: "sha256:image".into(),
                provider_version: "1.0".into(),
                protocol_version: CONTROL_PROTOCOL_VERSION,
                registry_schema_version: 6,
            },
            timeline: vec![],
            recovery_paths: vec![RecoveryPathEvidence {
                path: RecoveryPath::NativeResume,
                verdict: RecoveryEvidenceVerdict::DefinitiveNegative,
                reason_code: "store_missing".into(),
                evidence_refs: vec!["evidence://native-store".into()],
                store_state: EvidenceStoreState::Missing,
            }],
            decision: LossDecisionSummary {
                state: LossDecisionState::Lost,
                reason_code: "all_applicable_recovery_paths_definitively_unavailable".into(),
                unknown_paths: 0,
                retained_recoverable_evidence: false,
            },
            cleanup_target: CleanupDecisionEvidence {
                owned_handle_ref: "registry://incarnation-contract".into(),
                ownership_verified: true,
                incarnation_id: IncarnationId::parse("incarnation-contract").unwrap(),
            },
            analysis: IncidentAnalysis {
                observed_cause: "provider state missing".into(),
                missing_invariant: "checkpoint unavailable".into(),
                hypotheses: vec![],
                preventive_action: "retain a verified checkpoint".into(),
                regression_case: "P5-G02".into(),
            },
            created_at: "2026-09-08T00:00:00Z".into(),
        };
        let encoded = serde_json::to_string(&certificate).unwrap();
        assert!(!encoded.contains("native-session-secret"));
        let restored: LostDecisionCertificate = serde_json::from_str(&encoded).unwrap();
        assert_eq!(restored, certificate);

        let notice = RuntimeNotice {
            notice_id: NoticeId::parse("notice-contract").unwrap(),
            kind: NoticeKind::CleanupSucceeded,
            message: "Found and cleaned up 1 lost agent process.".into(),
            reference: "CONTRACT".into(),
            incident_ids: vec![certificate.incident_id],
            delivery_state: NoticeDeliveryState::Pending,
            created_at: "2026-09-08T00:00:00Z".into(),
        };
        assert_eq!(
            serde_json::from_value::<RuntimeNotice>(serde_json::to_value(&notice).unwrap())
                .unwrap(),
            notice
        );
    }
}

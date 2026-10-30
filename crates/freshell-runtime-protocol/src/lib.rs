//! Versioned control protocol and durable identity types for managed Freshell runtimes.
//!
//! This crate deliberately contains no process-management APIs. Runtime termination
//! authority lives in `freshell-supervisor` and is represented there by a private-
//! constructor ownership capability.

use hmac::{Hmac, Mac};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

// v2 adds mandatory per-attempt ownership tokens to OpenCode transfer actions.
pub const CONTROL_PROTOCOL_VERSION: u32 = 2;
pub const MAX_CONTROL_FRAME_BYTES: usize = 1024 * 1024;
pub const MAX_NATIVE_HISTORY_FRAME_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_OPENCODE_TRANSFER_CHUNK_BYTES: usize = 256 * 1024;
pub const MAX_OPENCODE_TRANSFER_BUNDLE_BYTES: u64 = 8 * 1024 * 1024 * 1024;
pub const MAX_OPENCODE_TRANSFER_FILES: usize = 4096;
pub const MAX_OPENCODE_TRANSFER_MANIFEST_BYTES: usize = 512 * 1024;
pub const OPENCODE_TRANSFER_DESTINATION_DB: &str = ".local/share/opencode/opencode.db";

type HmacSha256 = Hmac<Sha256>;

pub mod fresh_agent_ops;
pub use fresh_agent_ops::*;
pub mod provider_inputs;
pub use provider_inputs::*;
pub mod terminal_spool;
pub use terminal_spool::{
    TerminalExitObservation, TerminalSpoolCompletion, TerminalSpoolDescriptor,
};

#[cfg(test)]
#[path = "fresh_agent_ops_tests.rs"]
mod fresh_agent_ops_tests;

#[cfg(test)]
#[path = "opencode_transfer_tests.rs"]
mod opencode_transfer_tests;

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
    DataRepairComplete,
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
    CapabilityPending,
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
    /// Native UUID-preserving recovery of an acknowledged Claude fork before
    /// its first input materializes a child transcript. Intent, not observation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_fork: Option<ClaudeForkRecipe>,
    #[serde(default = "default_resume_spec_schema_version")]
    pub schema_version: u32,
    pub provider_session: ProviderSessionRef,
    pub mode: String,
    #[serde(default)]
    pub runtime_variant: String,
    /// Test-only transport identity must survive supervisor-led recovery so
    /// the resumed host never silently crosses into a paid provider adapter.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fixture_transport: Option<FreshAgentFixtureTransport>,
    /// Passive evidence for the already installed OpenCode history baseline.
    /// This never requests staging or import; it only permits a fresh
    /// provider-reader check and incarnation-bound TUI adoption gate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opencode_adoption_baseline: Option<OpenCodeAdoptionBaseline>,
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaudeForkRecipe {
    /// Retains the missing-child blocker after a potentially accepted effect.
    /// A disabled source can never recreate its older prefix.
    #[serde(default)]
    pub recovery_disabled: bool,
    pub child_session_id: String,
    pub parent_session_id: String,
    pub parent_transcript: String,
    pub child_transcript: String,
    pub parent_sha256: String,
    pub target: ClaudeForkTarget,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ClaudeForkTarget {
    Prefix {
        cutoff_uuid: String,
        drop_turn_uuid: Option<String>,
    },
    Empty,
}

impl ClaudeForkRecipe {
    pub fn validate(&self, child: &str) -> Result<(), String> {
        let uuid = |value: &str| uuid::Uuid::parse_str(value).is_ok();
        let path = |value: &str, root: &str| {
            let path = std::path::Path::new(value);
            value.len() <= 4096
                && path.starts_with(".claude/projects")
                && path
                    .components()
                    .all(|part| matches!(part, std::path::Component::Normal(_)))
                && path.file_name().and_then(|name| name.to_str())
                    == Some(format!("{root}.jsonl").as_str())
        };
        if self.child_session_id != child
            || !uuid(child)
            || !uuid(&self.parent_session_id)
            || child == self.parent_session_id
            || !path(&self.parent_transcript, &self.parent_session_id)
            || !path(&self.child_transcript, child)
            || self.parent_sha256.len() != 64
            || !self
                .parent_sha256
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err("invalid Claude parent-backed fork recipe".into());
        }
        if let ClaudeForkTarget::Prefix {
            cutoff_uuid,
            drop_turn_uuid,
        } = &self.target
        {
            if !uuid(cutoff_uuid) || drop_turn_uuid.as_ref().is_some_and(|id| !uuid(id)) {
                return Err("invalid Claude fork cutoff".into());
            }
        }
        Ok(())
    }
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
        /// Path-specific negative inspection results. Empty legacy rows are
        /// intentionally insufficient to authorize loss of a coding session.
        #[serde(default)]
        negative_paths: Vec<RecoveryPathEvidence>,
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

/// One exact false-loss row selected for stopped restoration. Native paths,
/// provider payloads, and session contents are intentionally absent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LostSoulRepairTarget {
    pub soul_id: SoulId,
    pub incident_id: IncidentId,
    pub expected_intent_revision: u64,
}

/// A user-selected canonical owner for an otherwise ambiguous native root.
/// This is sent only after the server has returned its exact candidate soul
/// IDs; it contains no provider paths or session content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalOwnerChoice {
    pub root_session_id: String,
    pub soul_id: SoulId,
    pub expected_intent_revision: u64,
}

/// Exact source selection. Its members are independently resolved by the
/// supervisor; callers cannot supply the expected set of lost souls.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepairBatchSourceSelection {
    pub source_store_id: String,
    pub root_session_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepairBatchTarget {
    pub target: LostSoulRepairTarget,
    pub provider_store_id: String,
    pub root_session_id: String,
    pub incident_revision: u64,
    pub identity_revision: u64,
    pub native_import_revision: u64,
    pub evidence_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepairBatchRoot {
    pub root_session_id: String,
    pub graph_digest: String,
    pub eligible_owners: Vec<SoulId>,
    pub canonical_soul_id: Option<SoulId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepairBatchScope {
    pub scope_id: String,
    pub source_store_id: String,
    pub source_fingerprint: String,
    pub targets: Vec<RepairBatchTarget>,
    pub roots: Vec<RepairBatchRoot>,
}

impl RepairBatchScope {
    pub fn source_descriptor_digest(&self) -> String {
        let mut roots = self
            .roots
            .iter()
            .map(|root| (&root.root_session_id, &root.graph_digest))
            .collect::<Vec<_>>();
        roots.sort();
        hex::encode(Sha256::digest(
            serde_json::to_vec(&(&self.source_store_id, roots))
                .expect("source descriptor serializes"),
        ))
    }
    pub fn source_selection(&self) -> RepairBatchSourceSelection {
        RepairBatchSourceSelection {
            source_store_id: self.source_store_id.clone(),
            root_session_ids: self
                .roots
                .iter()
                .map(|root| root.root_session_id.clone())
                .collect(),
        }
    }

    pub fn descriptor_digest(&self) -> String {
        let mut descriptor = self.clone();
        descriptor.scope_id.clear();
        descriptor.targets.sort_by(|left, right| {
            left.target
                .soul_id
                .as_str()
                .cmp(right.target.soul_id.as_str())
        });
        descriptor
            .roots
            .sort_by(|left, right| left.root_session_id.cmp(&right.root_session_id));
        for root in &mut descriptor.roots {
            root.eligible_owners
                .sort_by(|left, right| left.as_str().cmp(right.as_str()));
        }
        hex::encode(Sha256::digest(
            serde_json::to_vec(&descriptor).expect("scope descriptor serializes"),
        ))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreflightLostSoulsRequest {
    pub source: RepairBatchSourceSelection,
    pub expected_control_epoch: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestoreLostSoulsRequest {
    pub scope_id: String,
    pub source: RepairBatchSourceSelection,
    pub targets: Vec<LostSoulRepairTarget>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub canonical_owners: Vec<CanonicalOwnerChoice>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_control_epoch: Option<u64>,
}

impl RestoreLostSoulsRequest {
    pub fn validate_payload(&self) -> Result<(), RuntimeError> {
        let mut souls = std::collections::BTreeSet::new();
        let mut incidents = std::collections::BTreeSet::new();
        if self.targets.is_empty()
            || !is_lower_hex_sha256(&self.scope_id)
            || !is_lower_hex_sha256(&self.source.source_store_id)
            || self.source.root_session_ids.is_empty()
            || self
                .source
                .root_session_ids
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != self.source.root_session_ids.len()
            || self.targets.iter().any(|target| {
                target.expected_intent_revision == 0
                    || !souls.insert(target.soul_id.as_str())
                    || !incidents.insert(target.incident_id.as_str())
            })
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                "stopped restoration requires a qualified scope and distinct revisioned soul and incident targets",
            ));
        }
        let mut roots = std::collections::BTreeSet::new();
        if self.canonical_owners.iter().any(|choice| {
            choice.root_session_id.trim().is_empty()
                || choice.root_session_id.len() > 160
                || choice
                    .root_session_id
                    .bytes()
                    .any(|byte| byte.is_ascii_control())
                || !roots.insert(choice.root_session_id.as_str())
        }) {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                "canonical owner choices require distinct, valid native root identifiers",
            ));
        }
        Ok(())
    }

    pub fn validate_exact_batch(&self, scope: &RepairBatchScope) -> Result<(), RuntimeError> {
        self.validate_payload()?;
        let refused = || {
            RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                "stopped restoration differs from the independently resolved exact scope",
            )
        };
        let mut expected = scope
            .targets
            .iter()
            .map(|member| member.target.clone())
            .collect::<Vec<_>>();
        let mut submitted = self.targets.clone();
        expected.sort_by(|left, right| left.soul_id.as_str().cmp(right.soul_id.as_str()));
        submitted.sort_by(|left, right| left.soul_id.as_str().cmp(right.soul_id.as_str()));
        let mut selection = self.source.clone();
        selection.root_session_ids.sort();
        let mut expected_selection = scope.source_selection();
        expected_selection.root_session_ids.sort();
        if self.scope_id != scope.scope_id
            || scope.scope_id != scope.descriptor_digest()
            || scope.source_fingerprint != scope.source_descriptor_digest()
            || expected != submitted
            || selection != expected_selection
            || scope
                .roots
                .iter()
                .map(|root| root.root_session_id.as_str())
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != scope.roots.len()
            || scope.targets.iter().any(|member| {
                !scope
                    .roots
                    .iter()
                    .any(|root| root.root_session_id == member.root_session_id)
            })
            || scope
                .targets
                .iter()
                .any(|member| member.provider_store_id.trim().is_empty())
            || scope.roots.iter().any(|root| {
                !is_lower_hex_sha256(&root.graph_digest)
                    || root.eligible_owners.is_empty()
                    || root
                        .eligible_owners
                        .iter()
                        .collect::<std::collections::BTreeSet<_>>()
                        .len()
                        != root.eligible_owners.len()
                    || root
                        .canonical_soul_id
                        .as_ref()
                        .is_some_and(|owner| !root.eligible_owners.contains(owner))
            })
        {
            return Err(refused());
        }
        for choice in &self.canonical_owners {
            let root = scope
                .roots
                .iter()
                .find(|root| root.root_session_id == choice.root_session_id)
                .ok_or_else(refused)?;
            if !root.eligible_owners.contains(&choice.soul_id)
                || root
                    .canonical_soul_id
                    .as_ref()
                    .is_some_and(|owner| owner != &choice.soul_id)
                || !scope.targets.iter().any(|member| {
                    member.target.soul_id == choice.soul_id
                        && member.root_session_id == choice.root_session_id
                        && member.target.expected_intent_revision == choice.expected_intent_revision
                })
            {
                return Err(refused());
            }
        }
        Ok(())
    }
}

fn is_lower_hex_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SoulRepairStatus {
    Pending,
    OwnerDecisionRequired,
    Complete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RootRepairImportStatus {
    Pending,
    OwnerDecisionRequired,
    StructurallyVerified,
    ProviderReadable,
    Complete,
}

/// Body-free progress for one canonical native root in a stopped correction.
/// It contains identity and revision codes only; source paths and transcript
/// data never cross the request boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreLostSoulRootResult {
    pub root_session_id: String,
    pub canonical_soul_id: Option<SoulId>,
    pub import_status: RootRepairImportStatus,
    pub intent_revision: Option<u64>,
    pub native_import_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub owner_candidates: Vec<SoulId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreLostSoulsResult {
    pub operation_id: RequestId,
    pub scope_id: String,
    pub status: SoulRepairStatus,
    pub repaired_target_count: u32,
    pub total_target_count: u32,
    #[serde(default)]
    pub roots: Vec<RestoreLostSoulRootResult>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registry_backup_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registry_backup_schema_version: Option<u32>,
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

/// Immutable enclosure policy captured at creation; absent values identify
/// historical rows, never permission to ignore current protected ownership facts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeLaunchPolicy {
    ProviderVolumeV1,
}

/// Read-only current-image qualification; never certifies a running provider identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetainedStoreCompatibilityRequest {
    pub provider_store_id: String,
    pub native_session_id: String,
    pub image_ref: String,
    pub provider_home: String,
    pub workspace_path: String,
    pub cwd: String,
    pub provider_uid: u32,
    pub provider_gid: u32,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetainedStoreCompatibilityReceipt {
    pub request: RetainedStoreCompatibilityRequest,
    pub provider_version: String,
    pub source_schema_fingerprint: String,
    pub migration_journal_fingerprint: String,
    pub generation: String,
    pub row_count: usize,
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
    ProviderInputsChanged,
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

/// Stable, body-free context for diagnosing a host activation failure.
/// This is optional so older supervisors and session hosts keep the existing
/// wire shape and newer ones can still read replies from older peers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RuntimeDiagnosticCode {
    HostSocketConnectFailed,
    HostCommandFrameFailed,
    HostCommandTimeout,
    ProviderStatePrepareFailed,
    ProviderSecretResolutionFailed,
    ProviderFilesPrepareFailed,
    ProviderLaunchPrepareFailed,
    CodexConfigPlanningFailed,
    CodexAppServerStartFailed,
    CodexProxyStartFailed,
    ProviderChildEnvironmentPrepareFailed,
    ProviderChildEnvironmentInstallFailed,
    ProviderProcessSpawnFailed,
    FreshAgentOpenFailed,
    FreshAgentProviderStartFailed,
    OpencodeActivityReadyTimeout,
    OpencodeActivityDisconnected,
}

/// A closed, body-free reason that a managed fresh-agent provider did not
/// start. This crosses the runtime boundary only after provider error text
/// has been reduced to one of these fixed categories.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FreshAgentProviderStartDiagnostic {
    Authentication,
    Arguments,
    Listener,
    Configuration,
    Network,
    Unclassified,
    NoDiagnostic,
}

impl FreshAgentProviderStartDiagnostic {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Authentication => "authentication",
            Self::Arguments => "arguments",
            Self::Listener => "listener",
            Self::Configuration => "configuration",
            Self::Network => "network",
            Self::Unclassified => "unclassified",
            Self::NoDiagnostic => "no-diagnostic",
        }
    }
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
    ClaudeConfigurationFile,
    CodexConfigurationFile,
    OpencodeConfigurationFile,
    AmplifierConfigurationFile,
    ClaudeOnecliEnvironment,
    ClaudeOnecliAuthFile,
    ClaudeOnecliCaFile,
    CodexOnecliEnvironment,
    CodexOnecliAuthFile,
    CodexOnecliCaFile,
    OpencodeOnecliEnvironment,
    OpencodeOnecliAuthFile,
    OpencodeOnecliCaFile,
    AmplifierOnecliEnvironment,
    AmplifierOnecliKeysFile,
    AmplifierOnecliCaFile,
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

impl ProviderSecretProfile {
    pub fn provider(self) -> &'static str {
        match self {
            Self::ClaudeOnecliEnvironment
            | Self::ClaudeOnecliAuthFile
            | Self::ClaudeOnecliCaFile
            | Self::ClaudeConfigurationFile => "claude",
            Self::CodexOnecliEnvironment
            | Self::CodexOnecliAuthFile
            | Self::CodexOnecliCaFile
            | Self::CodexConfigurationFile => "codex",
            Self::OpencodeOnecliEnvironment
            | Self::OpencodeOnecliAuthFile
            | Self::OpencodeOnecliCaFile
            | Self::OpencodeConfigurationFile => "opencode",
            Self::AmplifierOnecliEnvironment
            | Self::AmplifierConfigurationFile
            | Self::AmplifierOnecliKeysFile
            | Self::AmplifierOnecliCaFile
            | Self::AmplifierOnecliLunarouteGlm53
            | Self::LegacyAmplifierOnecliAnthropicHaikuLow => "amplifier",
        }
    }

    pub fn is_configuration_file(self) -> bool {
        matches!(
            self,
            Self::ClaudeConfigurationFile
                | Self::CodexConfigurationFile
                | Self::OpencodeConfigurationFile
                | Self::AmplifierConfigurationFile
        )
    }

    pub fn auth_relative_path(self) -> Option<&'static str> {
        match self {
            Self::ClaudeOnecliAuthFile => Some(".claude/.credentials.json"),
            Self::CodexOnecliAuthFile => Some(".codex/auth.json"),
            Self::OpencodeOnecliAuthFile => Some(".local/share/opencode/auth.json"),
            Self::AmplifierOnecliKeysFile => Some(".amplifier/keys.env"),
            _ => None,
        }
    }

    /// Provider-home path for a OneCLI file grant, including non-auth files
    /// such as the gateway CA certificate.
    pub fn provider_file_relative_path(self) -> Option<&'static str> {
        self.auth_relative_path().or(match self {
            Self::OpencodeOnecliCaFile
            | Self::ClaudeOnecliCaFile
            | Self::CodexOnecliCaFile
            | Self::AmplifierOnecliCaFile => Some(".config/onecli/gateway-ca.pem"),
            _ => None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSecretReference {
    /// Canonical private host file. Only this reference is durable; the
    /// session host reads its read-only mount immediately before child spawn.
    pub source_path: String,
    pub profile: ProviderSecretProfile,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_relative_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderLaunchContext {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prepared_inputs: Option<PreparedProviderInputs>,
    pub preparation: ProviderPreparation,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_capability: Option<McpCapabilityReference>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub config: Vec<ProviderConfigReference>,
}

/// Exact current producer inputs for an already owned soul's replacement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderReplacementPreparation {
    pub context: ProviderLaunchContext,
    pub secret_references: Vec<ProviderSecretReference>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum ProviderPreparation {
    Claude {
        mcp_args: Vec<String>,
    },
    Codex {
        tui_args: Vec<String>,
        sidecar_args: Vec<String>,
    },
    Opencode {
        project_config: Vec<ProviderConfigReference>,
        tui_config: Option<ProviderConfigReference>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tui_source: Option<ProviderConfigReference>,
        #[serde(default)]
        inline_config: bool,
    },
    Amplifier {
        bundle: String,
        resume_args: Vec<String>,
    },
}

impl ProviderPreparation {
    pub fn provider(&self) -> &'static str {
        match self {
            Self::Claude { .. } => "claude",
            Self::Codex { .. } => "codex",
            Self::Opencode { .. } => "opencode",
            Self::Amplifier { .. } => "amplifier",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpCapabilityReference {
    pub grant_id: String,
    pub endpoint: String,
    pub provider_relative_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_gateway_address: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderConfigRoot {
    Workspace,
    UserProvider,
    /// Fixed files staged beside an incarnation's private MCP grant.
    Ephemeral,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderConfigReference {
    pub root: ProviderConfigRoot,
    pub relative_path: String,
    pub provider_relative_path: String,
    pub format: String,
}

impl ProviderLaunchContext {
    pub fn validate(&self, provider: &str) -> Result<(), RuntimeError> {
        if let Some(inputs) = &self.prepared_inputs {
            inputs.validate(self.mcp_capability.as_ref())?;
        }
        let invalid = || {
            RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                "managed provider launch context is unsafe or mismatched",
            )
        };
        if self.preparation.provider() != provider
            || self.config.len() > 128
            || self
                .config
                .iter()
                .any(|reference| reference.root == ProviderConfigRoot::Ephemeral)
        {
            return Err(invalid());
        }
        let mut references: Vec<&ProviderConfigReference> = self.config.iter().collect();
        // These durable fields are limited to exact, non-secret recipes.
        // Provider-specific free-form launch arguments remain transient.
        match &self.preparation {
            ProviderPreparation::Claude { mcp_args } => {
                if !mcp_args.is_empty()
                    && !matches!(
                        (mcp_args.as_slice(), self.mcp_capability.as_ref()),
                        ([flag, path], Some(capability))
                            if flag == "--mcp-config"
                                && path == ".claude/freshell-mcp.json"
                                && (capability.provider_relative_path == ".freshell/mcp-capability.json"
                                    || path == &capability.provider_relative_path)
                    )
                {
                    return Err(invalid());
                }
            }
            ProviderPreparation::Codex {
                tui_args,
                sidecar_args,
            } => {
                let valid_recipe = |args: &[String]| {
                    args.len() == 6
                        && args[0] == "-c"
                        && args[1] == "mcp_servers.freshell.command=\"node\""
                        && args[2] == "-c"
                        && args[3] == "mcp_servers.freshell.args=[\"/opt/freshell-mcp/server.js\"]"
                        && args[4] == "-c"
                        && args[5] == "mcp_servers.freshell.env_vars=[\"FRESHELL\", \"FRESHELL_URL\", \"FRESHELL_TOKEN\", \"FRESHELL_TERMINAL_ID\", \"FRESHELL_TAB_ID\", \"FRESHELL_PANE_ID\"]"
                };
                if (!tui_args.is_empty() || !sidecar_args.is_empty())
                    && (self.mcp_capability.is_none()
                        || !valid_recipe(tui_args)
                        || !valid_recipe(sidecar_args))
                {
                    return Err(invalid());
                }
            }
            ProviderPreparation::Opencode {
                project_config,
                tui_config,
                tui_source,
                inline_config,
            } => {
                if project_config
                    .iter()
                    .any(|reference| reference.root == ProviderConfigRoot::Ephemeral)
                {
                    return Err(invalid());
                }
                references.extend(project_config.iter());
                references.extend(tui_config.iter());
                if *inline_config && self.mcp_capability.is_none() {
                    return Err(invalid());
                }
                if let Some(reference) = tui_config {
                    if self.mcp_capability.is_none() {
                        return Err(invalid());
                    }
                    let expected = match reference.format.as_str() {
                        "json" => Some(("tui-config.json", ".freshell/opencode/user-tui.json")),
                        "jsonc" => Some(("tui-config.jsonc", ".freshell/opencode/user-tui.jsonc")),
                        _ => None,
                    };
                    if reference.root != ProviderConfigRoot::Ephemeral
                        || expected
                            != Some((
                                reference.relative_path.as_str(),
                                reference.provider_relative_path.as_str(),
                            ))
                    {
                        return Err(invalid());
                    }
                }
                if let Some(source) = tui_source {
                    let Some(staged) = tui_config else {
                        return Err(invalid());
                    };
                    if !matches!(
                        source.root,
                        ProviderConfigRoot::Workspace | ProviderConfigRoot::UserProvider
                    ) || source.format != staged.format
                        || source.provider_relative_path != staged.provider_relative_path
                        || !safe_relative_path(&source.relative_path)
                    {
                        return Err(invalid());
                    }
                }
            }
            ProviderPreparation::Amplifier {
                bundle,
                resume_args,
            } => {
                if bundle != "default" || !resume_args.is_empty() {
                    return Err(invalid());
                }
            }
        }
        if references.len() > 128 {
            return Err(invalid());
        }
        for reference in references {
            if !safe_relative_path(&reference.relative_path)
                || !safe_relative_path(&reference.provider_relative_path)
                || !matches!(
                    reference.format.as_str(),
                    "json" | "jsonc" | "toml" | "yaml" | "text" | "directory"
                )
                || reference.relative_path.split('/').any(secret_component)
                || reference
                    .provider_relative_path
                    .split('/')
                    .any(secret_component)
                || (reference.root == ProviderConfigRoot::UserProvider && provider == "shell")
            {
                return Err(invalid());
            }
        }
        if let Some(capability) = &self.mcp_capability {
            if !capability.grant_id.starts_with("grant-")
                || capability.grant_id.len() > 128
                || !capability
                    .grant_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                || !safe_relative_path(&capability.provider_relative_path)
                || capability.endpoint.len() > 512
                || !(capability.endpoint.starts_with("http://")
                    || capability.endpoint.starts_with("https://"))
                || capability.endpoint.contains(['?', '#', '@', '\n', '\r'])
                || capability.endpoint.starts_with("http://127.")
                || capability.endpoint.starts_with("https://127.")
                || capability.endpoint.starts_with("http://localhost")
                || capability.endpoint.starts_with("https://localhost")
                || capability.endpoint.starts_with("http://[::1]")
                || capability.endpoint.starts_with("https://[::1]")
                || capability
                    .host_gateway_address
                    .as_ref()
                    .is_some_and(|address| {
                        address.parse::<std::net::Ipv4Addr>().map_or(true, |ip| {
                            ip.is_loopback() || ip.is_unspecified() || ip.is_multicast()
                        })
                    })
            {
                return Err(invalid());
            }
        }
        Ok(())
    }
}

fn safe_relative_path(value: &str) -> bool {
    let path = std::path::Path::new(value);
    !value.is_empty()
        && value.len() <= 512
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
        && !value.chars().any(char::is_control)
}

fn secret_component(value: &str) -> bool {
    matches!(
        value.to_ascii_lowercase().as_str(),
        ".credentials.json"
            | "auth.json"
            | "keys.env"
            | ".env"
            | "credentials"
            | "secrets"
            | "token.json"
    )
}

#[cfg(test)]
mod provider_launch_context_tests {
    use super::*;

    fn valid_adoption_baseline(root_session_id: &str) -> OpenCodeAdoptionBaseline {
        let source_store_id = "c".repeat(64);
        let source_generation = "d".repeat(64);
        let source_schema_fingerprint = "e".repeat(64);
        let migration_journal_fingerprint = "f".repeat(64);
        let payload = b"x";
        let payload_sha256 = sha256_hex(payload);
        let manifest_json = serde_json::json!({
            "version": 1,
            "provider_schema": "opencode-1.18.21",
            "root_session_id": root_session_id,
            "source_store_id": source_store_id,
            "source_schema_fingerprint": source_schema_fingerprint,
            "migration_journal_fingerprint": migration_journal_fingerprint,
            "sqlite_version": "test",
            "row_count": 0,
            "rows": [],
            "assets": [],
            "payload_bytes": payload.len(),
            "payload_sha256": payload_sha256,
            "generation": source_generation,
        })
        .to_string();
        let files = vec![OpenCodeTransferFile {
            index: 0,
            relative_path: "payload.json".into(),
            size_bytes: payload.len() as u64,
            sha256: payload_sha256,
        }];
        let target_image_ref = format!("sha256:{}", "a".repeat(64));
        let mut descriptor = OpenCodeTransferDescriptor {
            transfer_id: "transfer-adoption-test".into(),
            provider: "opencode".into(),
            source_store_id,
            root_session_id: root_session_id.into(),
            source_generation,
            provider_schema: "opencode-1.18.21".into(),
            source_schema_fingerprint,
            migration_journal_fingerprint,
            destination_store_id: "store-adoption-test".into(),
            destination_database_path: OPENCODE_TRANSFER_DESTINATION_DB.into(),
            target_image_ref: target_image_ref.clone(),
            target_build_receipt: opencode_target_build_receipt(
                &target_image_ref,
                "opencode-1.18.21",
            ),
            incarnation_id: "incarnation-import".into(),
            manifest_json,
            files,
            total_bytes: payload.len() as u64,
            bundle_sha256: String::new(),
        };
        descriptor.bundle_sha256 =
            opencode_transfer_bundle_digest(&descriptor.manifest_json, &descriptor.files);
        let manifest_sha256 = sha256_hex(descriptor.manifest_json.as_bytes());
        OpenCodeAdoptionBaseline {
            descriptor,
            manifest_sha256,
        }
    }

    #[test]
    fn old_terminal_launch_row_deserializes_without_provider_context() {
        let row = serde_json::json!({
            "terminalId":"terminal-old", "streamId":"stream-old", "mode":"claude",
            "program":"claude", "cwd":"/workspace", "runAsUid":65534,
            "runAsGid":0, "cols":80, "rows":24, "projectKey":"project-old",
            "workspacePath":"/workspace"
        });
        let launch: TerminalLaunchSpec = serde_json::from_value(row).unwrap();
        assert!(launch.provider_launch_context.is_none());
        assert!(launch.opencode_adoption.is_none());
    }

    #[test]
    fn old_host_status_row_defaults_to_no_opencode_adoption_gate() {
        let result: HostResult = serde_json::from_value(serde_json::json!({
            "kind": "status",
            "data": {
                "host_boot_id": "hostboot-legacy-status",
                "worker_pid": 42,
                "worker_launch_count": 1,
                "max_control_epoch": 1,
                "max_execution_generation": 1,
                "fixture_evidence": {},
                "exited": false
            }
        }))
        .unwrap();
        assert!(matches!(
            result,
            HostResult::Status {
                opencode_adoption: OpenCodeAdoptionStatus::NotRequired,
                ..
            }
        ));
    }

    #[test]
    fn adoption_expectation_and_observation_are_typed_and_body_free() {
        let incarnation_id = IncarnationId::parse("incarnation-adoption-test").unwrap();
        let expected = OpenCodeAdoptionExpectation {
            baseline: valid_adoption_baseline("ses_exactroot"),
            root_session_id: "ses_exactroot".into(),
            root_tail: OpenCodeVerifiedRootTail::Message {
                message_id: "msg_exact_tail".into(),
            },
            evidence_generation: "a".repeat(64),
            incarnation_id: incarnation_id.clone(),
            launch_nonce: "b".repeat(32),
        };
        expected.validate().unwrap();
        let observation = OpenCodeAdoptionObservation {
            terminal_id: "terminal-adoption-test".into(),
            root_session_id: expected.root_session_id.clone(),
            tail_message_id: Some("msg_exact_tail".into()),
            evidence_generation: expected.evidence_generation.clone(),
            incarnation_id,
            launch_nonce: expected.launch_nonce.clone(),
            hydrated: true,
            messages_read: OpenCodeMessagesRead::Success,
        };
        let json = serde_json::to_value(&observation).unwrap();
        assert_eq!(json["messagesRead"], "success");
        assert!(json.get("message").is_none());
        assert_eq!(
            serde_json::from_value::<OpenCodeAdoptionObservation>(json).unwrap(),
            observation
        );

        let empty: OpenCodeVerifiedRootTail = serde_json::from_value(serde_json::json!({
            "state": "qualified_empty"
        }))
        .unwrap();
        assert_eq!(empty, OpenCodeVerifiedRootTail::QualifiedEmpty);
    }

    #[test]
    fn old_fresh_agent_row_deserializes_without_context_or_secret_references() {
        let row = serde_json::json!({
            "sessionId":"old-fresh", "provider":"claude", "sessionType":"freshclaude",
            "runtimeVariant":"claude-sdk", "providerStoreId":"old-store",
            "cwd":"/workspace", "workspacePath":"/workspace", "runAsUid":65534,
            "runAsGid":0
        });
        let launch: FreshAgentLaunchSpec = serde_json::from_value(row).unwrap();
        assert!(launch.provider_launch_context.is_none());
        assert!(launch.provider_secret_references.is_empty());
        assert!(launch.plugins.is_none());
        assert!(launch.model_selection.is_none());
        assert!(launch.session_ref.is_none());
        let mut explicit_clear = launch;
        explicit_clear.model_selection = Some(None);
        let encoded = serde_json::to_value(&explicit_clear).unwrap();
        assert!(encoded.get("modelSelection").unwrap().is_null());
        assert_eq!(
            serde_json::from_value::<FreshAgentLaunchSpec>(encoded).unwrap(),
            explicit_clear
        );
    }

    #[test]
    fn opencode_tui_reference_is_fixed_and_keeps_jsonc_format() {
        let reference = ProviderConfigReference {
            root: ProviderConfigRoot::Ephemeral,
            relative_path: "tui-config.jsonc".into(),
            provider_relative_path: ".freshell/opencode/user-tui.jsonc".into(),
            format: "jsonc".into(),
        };
        let capability = McpCapabilityReference {
            grant_id: "grant-tui".into(),
            endpoint: "http://host.docker.internal:3001".into(),
            provider_relative_path: ".freshell/mcp-capability.json".into(),
            host_gateway_address: None,
        };
        let mut context = ProviderLaunchContext {
            prepared_inputs: None,
            preparation: ProviderPreparation::Opencode {
                project_config: Vec::new(),
                tui_config: Some(reference),
                tui_source: None,
                inline_config: true,
            },
            mcp_capability: Some(capability),
            config: Vec::new(),
        };
        context.validate("opencode").unwrap();
        if let ProviderPreparation::Opencode { tui_source, .. } = &mut context.preparation {
            *tui_source = Some(ProviderConfigReference {
                root: ProviderConfigRoot::UserProvider,
                relative_path: "tui.jsonc".into(),
                provider_relative_path: ".freshell/opencode/user-tui.jsonc".into(),
                format: "jsonc".into(),
            });
        }
        context.validate("opencode").unwrap();
        let encoded = serde_json::to_string(&context).unwrap();
        assert!(encoded.contains("tui_source"));
        if let ProviderPreparation::Opencode { tui_source, .. } = &mut context.preparation {
            tui_source.as_mut().unwrap().relative_path = "../outside.jsonc".into();
        }
        assert!(context.validate("opencode").is_err());
        if let ProviderPreparation::Opencode { tui_source, .. } = &mut context.preparation {
            tui_source.as_mut().unwrap().relative_path = "tui.jsonc".into();
        }
        if let ProviderPreparation::Opencode { tui_config, .. } = &mut context.preparation {
            tui_config.as_mut().unwrap().provider_relative_path =
                ".freshell/opencode/other.jsonc".into();
        }
        assert!(context.validate("opencode").is_err());
    }

    #[test]
    fn typed_provider_context_round_trips_without_secret_material() {
        let context = ProviderLaunchContext {
            prepared_inputs: None,
            preparation: ProviderPreparation::Claude {
                mcp_args: vec!["--mcp-config".into(), ".claude/freshell-mcp.json".into()],
            },
            mcp_capability: Some(McpCapabilityReference {
                grant_id: "grant-opaque-reference".into(),
                endpoint: "http://host.docker.internal:3001/api/mcp".into(),
                provider_relative_path: ".claude/freshell-mcp.json".into(),
                host_gateway_address: Some("192.168.3.150".into()),
            }),
            config: vec![ProviderConfigReference {
                root: ProviderConfigRoot::UserProvider,
                relative_path: "settings.json".into(),
                provider_relative_path: ".claude/settings.json".into(),
                format: "json".into(),
            }],
        };
        context.validate("claude").unwrap();
        let encoded = serde_json::to_string(&context).unwrap();
        assert!(!encoded.contains("test-secret-value"));
        assert_eq!(
            serde_json::from_str::<ProviderLaunchContext>(&encoded).unwrap(),
            context
        );
    }

    #[test]
    fn managed_codex_replaces_web_owned_mcp_args_with_soul_recipe() {
        let args = vec![
            "-c".into(),
            "tui.notification_method=bel".into(),
            "-c".into(),
            "mcp_servers.freshell.command=\"node\"".into(),
            "-c".into(),
            "mcp_servers.freshell.args=[\"/web/tools/server.ts\"]".into(),
            "-c".into(),
            "mcp_servers.freshell.env_vars=[\"FRESHELL\"]".into(),
            "--model".into(),
            "gpt-5.6-luna".into(),
        ];
        assert_eq!(
            durable_managed_terminal_args("codex", args, None).unwrap(),
            vec![
                "-c",
                "tui.notification_method=bel",
                "--model",
                "gpt-5.6-luna"
            ]
        );
    }

    #[test]
    fn managed_claude_fork_requires_one_exact_root_selector() {
        let root = "112fa138-8ed5-4f98-8977-4444e8433207";
        let args = vec!["--resume".into(), root.into(), "--fork-session".into()];
        assert!(validate_managed_terminal_args("claude", &args).is_ok());
        assert!(durable_managed_terminal_args("claude", args, None).is_ok());
        assert!(validate_managed_terminal_args(
            "claude",
            &["--session-id".into(), root.into(), "--fork-session".into()]
        )
        .is_ok());
        for invalid in [
            vec!["--fork-session".into()],
            vec![
                "--session-id".into(),
                root.into(),
                "--resume".into(),
                root.into(),
                "--fork-session".into(),
            ],
            vec!["--model".into(), "--resume".into(), "--fork-session".into()],
            vec![
                "--resume".into(),
                root.into(),
                "--fork-session".into(),
                "true".into(),
            ],
            vec![
                "--resume".into(),
                "bad\nroot".into(),
                "--fork-session".into(),
            ],
        ] {
            assert!(validate_managed_terminal_args("claude", &invalid).is_err());
        }
        assert!(validate_managed_terminal_args("codex", &["--fork-session".into()]).is_err());
    }

    #[test]
    fn managed_codex_pinned_update_setting_survives_durable_resume_without_expanding_overrides() {
        let args = vec![
            "--model".into(),
            "gpt-5.6-luna".into(),
            "-c".into(),
            "model_reasoning_effort=\"low\"".into(),
            "-c".into(),
            "check_for_update_on_startup=false".into(),
            "resume".into(),
            "thread-current".into(),
        ];
        validate_managed_terminal_args("codex", &args).unwrap();
        let durable = durable_managed_terminal_args("codex", args, None).unwrap();
        validate_managed_terminal_args("codex", &durable).unwrap();
        for value in [
            "check_for_update_on_startup=true",
            "check_for_update_on_startup=false\napi_key=secret",
            "check_for_update_on_startup=\"false\"",
            "check_for_update_on_startup=false;token=secret",
        ] {
            assert!(validate_managed_terminal_args("codex", &["-c".into(), value.into()]).is_err());
        }
        for provider in ["claude", "opencode", "amplifier"] {
            assert!(validate_managed_terminal_args(
                provider,
                &["-c".into(), "check_for_update_on_startup=false".into()]
            )
            .is_err());
        }
    }

    #[test]
    fn managed_codex_named_profile_control_reaches_durable_launch_arguments() {
        for flag in ["--profile", "-p"] {
            let original = vec![
                flag.into(),
                "selected_profile-1".into(),
                "--model".into(),
                "fixture-model".into(),
            ];
            assert_eq!(
                durable_managed_terminal_args("codex", original.clone(), None)
                    .expect("native named profile control must remain usable"),
                original
            );
            assert!(durable_managed_terminal_args(
                "codex",
                vec![flag.into(), "../config".into()],
                None
            )
            .is_err());
        }
    }

    #[test]
    fn managed_codex_accepts_only_the_packaged_mcp_recipe_after_preparation() {
        let args = vec![
            "-c".into(), "mcp_servers.freshell.command=\"node\"".into(),
            "-c".into(), "mcp_servers.freshell.args=[\"/opt/freshell-mcp/server.js\"]".into(),
            "-c".into(), "mcp_servers.freshell.env_vars=[\"FRESHELL\", \"FRESHELL_URL\", \"FRESHELL_TOKEN\", \"FRESHELL_TERMINAL_ID\", \"FRESHELL_TAB_ID\", \"FRESHELL_PANE_ID\"]".into(),
        ];
        assert!(validate_managed_terminal_args("codex", &args).is_ok());
        let mut unsafe_args = args;
        unsafe_args[3] = "mcp_servers.freshell.args=[\"/tmp/other.js\"]".into();
        assert!(validate_managed_terminal_args("codex", &unsafe_args).is_err());
    }

    #[test]
    fn raw_secret_payload_and_unapproved_config_paths_are_rejected() {
        let raw = serde_json::json!({
            "preparation":{"claude":{"mcpArgs":[]}}, "config":[],
            "token":"test-secret-value"
        });
        assert!(serde_json::from_value::<ProviderLaunchContext>(raw).is_err());
        let nested = serde_json::json!({
            "preparation":{"claude":{"mcp_args":[],"apiKey":"test-secret-value"}},
            "config":[]
        });
        assert!(serde_json::from_value::<ProviderLaunchContext>(nested).is_err());

        let context = ProviderLaunchContext {
            prepared_inputs: None,
            preparation: ProviderPreparation::Claude { mcp_args: vec![] },
            mcp_capability: None,
            config: vec![ProviderConfigReference {
                root: ProviderConfigRoot::UserProvider,
                relative_path: ".credentials.json".into(),
                provider_relative_path: ".claude/.credentials.json".into(),
                format: "json".into(),
            }],
        };
        assert!(context.validate("claude").is_err());
        let mut context = context;
        context.config.clear();
        context.mcp_capability = Some(McpCapabilityReference {
            grant_id: "grant-local-control".into(),
            endpoint: "http://127.0.0.1:10254/api/mcp".into(),
            provider_relative_path: ".claude/mcp.json".into(),
            host_gateway_address: None,
        });
        assert!(context.validate("claude").is_err());
        context.mcp_capability.as_mut().unwrap().endpoint =
            "http://host.docker.internal:3001/api/mcp".into();
        context
            .mcp_capability
            .as_mut()
            .unwrap()
            .host_gateway_address = Some("127.0.0.1".into());
        assert!(context.validate("claude").is_err());
    }

    #[test]
    fn separated_credential_argument_cannot_enter_a_durable_launch_row() {
        let mut launch: TerminalLaunchSpec = serde_json::from_value(serde_json::json!({
            "terminalId":"credential-test", "streamId":"stream-test", "mode":"claude",
            "program":"claude", "cwd":"/workspace", "runAsUid":65534,
            "runAsGid":0, "cols":80, "rows":24, "projectKey":"project-test",
            "workspacePath":"/workspace"
        }))
        .unwrap();
        launch.provider_launch_context = Some(ProviderLaunchContext {
            prepared_inputs: None,
            preparation: ProviderPreparation::Claude {
                mcp_args: vec!["--api-key".into(), "fixture-secret-bytes".into()],
            },
            mcp_capability: None,
            config: Vec::new(),
        });
        assert!(launch.validate().is_err());
        let serialized = serde_json::to_string(&launch).unwrap();
        let restored: TerminalLaunchSpec = serde_json::from_str(&serialized).unwrap();
        assert!(restored.validate().is_err());
        launch.provider_launch_context.as_mut().unwrap().preparation =
            ProviderPreparation::Claude {
                mcp_args: vec!["--api-key=fixture-secret-bytes".into()],
            };
        assert!(launch.validate().is_err());
        let context = launch.provider_launch_context.as_mut().unwrap();
        context.preparation = ProviderPreparation::Claude {
            mcp_args: vec!["--mcp-config".into(), "fixture-secret-bytes".into()],
        };
        context.mcp_capability = Some(McpCapabilityReference {
            grant_id: "grant-test".into(),
            endpoint: "http://host.docker.internal:3001/api/mcp".into(),
            provider_relative_path: "fixture-secret-bytes".into(),
            host_gateway_address: None,
        });
        assert!(launch.validate().is_err());
    }

    #[test]
    fn configuration_file_grants_allow_many_unique_destinations_in_both_launch_routes() {
        let references: Vec<_> = (0..128)
            .map(|index| ProviderSecretReference {
                source_path: format!("/private/reference-{index}"),
                profile: ProviderSecretProfile::OpencodeConfigurationFile,
                provider_relative_path: Some(format!(".freshell/references/{index}")),
            })
            .collect();
        assert!(validate_provider_secrets("opencode", &references).is_ok());
        let mut terminal: TerminalLaunchSpec = serde_json::from_value(serde_json::json!({
            "terminalId":"terminal", "streamId":"stream", "mode":"opencode",
            "program":"opencode", "cwd":"/workspace", "runAsUid":65534,
            "runAsGid":0, "cols":80, "rows":24, "projectKey":"project",
            "workspacePath":"/workspace"
        }))
        .unwrap();
        terminal.provider_secret_references = references.clone();
        assert!(terminal.validate().is_ok());
        let mut fresh: FreshAgentLaunchSpec = serde_json::from_value(serde_json::json!({
            "sessionId":"presentation", "provider":"opencode", "sessionType":"freshopencode",
            "runtimeVariant":"pinned", "providerStoreId":"store", "cwd":"/workspace",
            "workspacePath":"/workspace", "runAsUid":65534, "runAsGid":0
        }))
        .unwrap();
        fresh.provider_secret_references = references;
        assert!(fresh.validate().is_ok());
        // A valid filesystem path can exceed the legacy credential reference
        // limit. Configuration references use the preparation frame budget.
        let deep_source = format!("/private/{}/selected", "directory/".repeat(205));
        terminal.provider_secret_references[0].source_path = deep_source.clone();
        fresh.provider_secret_references[0].source_path = deep_source;
        assert!(terminal.validate().is_ok());
        assert!(fresh.validate().is_ok());
    }
    #[test]
    fn configuration_file_grants_reject_cross_provider_duplicate_and_unsafe_destinations() {
        let reference = ProviderSecretReference {
            source_path: "/private/reference".into(),
            profile: ProviderSecretProfile::ClaudeConfigurationFile,
            provider_relative_path: Some(".freshell/references/one".into()),
        };
        assert!(validate_provider_secrets("claude", std::slice::from_ref(&reference)).is_ok());
        assert!(validate_provider_secrets("codex", std::slice::from_ref(&reference)).is_err());
        assert!(
            validate_provider_secrets("claude", &[reference.clone(), reference.clone()]).is_err()
        );
        for path in [
            ".claude/auth.json",
            ".freshell/references/../one",
            ".freshell/references/one/two",
            "/absolute",
            ".freshell/references/",
        ] {
            let mut invalid = reference.clone();
            invalid.provider_relative_path = Some(path.into());
            assert!(validate_provider_secrets("claude", &[invalid]).is_err());
        }
        let mut legacy = reference;
        legacy.profile = ProviderSecretProfile::ClaudeOnecliAuthFile;
        assert!(validate_provider_secrets("claude", &[legacy]).is_err());
    }

    #[test]
    fn onecli_profiles_match_only_their_named_provider() {
        for (provider, profiles) in [
            (
                "claude",
                vec![
                    ProviderSecretProfile::ClaudeOnecliEnvironment,
                    ProviderSecretProfile::ClaudeOnecliAuthFile,
                    ProviderSecretProfile::ClaudeOnecliCaFile,
                ],
            ),
            (
                "codex",
                vec![
                    ProviderSecretProfile::CodexOnecliEnvironment,
                    ProviderSecretProfile::CodexOnecliAuthFile,
                    ProviderSecretProfile::CodexOnecliCaFile,
                ],
            ),
            (
                "opencode",
                vec![
                    ProviderSecretProfile::OpencodeOnecliEnvironment,
                    ProviderSecretProfile::OpencodeOnecliAuthFile,
                    ProviderSecretProfile::OpencodeOnecliCaFile,
                ],
            ),
            (
                "amplifier",
                vec![
                    ProviderSecretProfile::AmplifierOnecliEnvironment,
                    ProviderSecretProfile::AmplifierOnecliKeysFile,
                    ProviderSecretProfile::AmplifierOnecliCaFile,
                ],
            ),
        ] {
            for profile in profiles {
                let references = [ProviderSecretReference {
                    provider_relative_path: None,
                    source_path: "/private/onecli-grant".into(),
                    profile,
                }];
                assert!(validate_provider_secrets(provider, &references).is_ok());
                assert!(validate_provider_secrets("wrong-provider", &references).is_err());
            }
        }
        assert!(validate_provider_secrets(
            "amplifier",
            &[ProviderSecretReference {
                provider_relative_path: None,
                source_path: "/private/legacy".into(),
                profile: ProviderSecretProfile::LegacyAmplifierOnecliAnthropicHaikuLow,
            }]
        )
        .is_err());
    }

    #[test]
    fn terminal_launch_rejects_raw_secret_environment() {
        let row = serde_json::json!({
            "terminalId":"terminal-secret", "streamId":"stream-secret", "mode":"codex",
            "program":"codex", "cwd":"/workspace", "runAsUid":65534,
            "runAsGid":0, "cols":80, "rows":24, "projectKey":"project-secret",
            "workspacePath":"/workspace", "env":{"OPENAI_API_KEY":"fixture-secret-value"}
        });
        let launch: TerminalLaunchSpec = serde_json::from_value(row).unwrap();
        assert!(launch.validate().is_err());
    }
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

/// Test-only provider transport selected through the typed managed launch.
/// The protocol knows the request so ordinary hosts can reject it explicitly;
/// only a session-host compiled with its fixture feature may execute it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FreshAgentFixtureTransport {
    Deterministic,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelSelection {
    pub kind: String,
    pub model_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSessionReference {
    pub provider: String,
    pub session_id: String,
}

mod double_optional {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<T: Serialize, S: Serializer>(
        value: &Option<Option<T>>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        match value {
            Some(inner) => inner.serialize(serializer),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, T: Deserialize<'de>, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<Option<T>>, D::Error> {
        Ok(Some(Option::deserialize(deserializer)?))
    }
}

impl FreshProvider {
    pub fn native_provider(&self) -> &'static str {
        self.native_family()
    }

    /// Native input recipes are shared by the two existing Claude flavors.
    /// Runtime identities and reservation owners still use `as_str()`.
    pub fn native_family(&self) -> &'static str {
        match self {
            Self::Kilroy => "claude",
            _ => self.as_str(),
        }
    }

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugins: Option<Vec<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "double_optional"
    )]
    pub model_selection: Option<Option<ProviderModelSelection>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_ref: Option<ProviderSessionReference>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fixture_transport: Option<FreshAgentFixtureTransport>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub provider_bootstrap_files: Vec<ProviderBootstrapFile>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub provider_secret_references: Vec<ProviderSecretReference>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_launch_context: Option<ProviderLaunchContext>,
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
            || self
                .plugins
                .as_ref()
                .is_some_and(|plugins| plugins.len() > 64)
            || self.session_ref.as_ref().is_some_and(|reference| {
                reference.session_id.is_empty()
                    || reference.provider
                        != match self.provider {
                            FreshProvider::Kilroy => "claude",
                            _ => self.provider.as_str(),
                        }
                    || self
                        .native_session_id
                        .as_ref()
                        .is_some_and(|native| native != &reference.session_id)
            })
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
        if self.plugins.as_ref().is_some_and(|plugins| {
            plugins.iter().any(|plugin| {
                plugin.is_empty() || plugin.len() > 1024 || plugin.chars().any(char::is_control)
            })
        }) || self
            .model_selection
            .as_ref()
            .and_then(Option::as_ref)
            .is_some_and(|selection| {
                selection.kind.is_empty()
                    || selection.model_id.is_empty()
                    || selection.kind.len() > 256
                    || selection.model_id.len() > 256
                    || selection.kind.chars().any(char::is_control)
                    || selection.model_id.chars().any(char::is_control)
            })
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                "managed fresh-agent provider input is invalid",
            ));
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
        if let Some(context) = &self.provider_launch_context {
            context.validate(self.provider.native_provider())?;
        }
        validate_provider_secrets(
            self.provider.native_provider(),
            &self.provider_secret_references,
        )?;
        if let Some(inputs) = self
            .provider_launch_context
            .as_ref()
            .and_then(|context| context.prepared_inputs.as_ref())
        {
            inputs.validate_references(&self.provider_secret_references)?;
        }
        if self.provider != FreshProvider::Kilroy && !self.provider_bootstrap_files.is_empty() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                "raw credential bootstrap is unsupported for named managed providers",
            ));
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_launch_context: Option<ProviderLaunchContext>,
    /// Bounded metadata binding one exact native-history transfer to this
    /// OpenCode terminal. The bundle bytes are never embedded here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opencode_transfer: Option<OpenCodeTransferDescriptor>,
    /// Attempt token for the finalized stage's pending ownership claim. The
    /// supervisor consumes it atomically with durable launch preparation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opencode_transfer_attempt_id: Option<String>,
    /// A verified native root-history snapshot that the fresh OpenCode TUI
    /// must observe before this terminal accepts input. Absent on legacy and
    /// unmanaged OpenCode launches.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opencode_adoption: Option<OpenCodeAdoptionExpectation>,
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
        if let Some(transfer) = &self.opencode_transfer {
            transfer.validate()?;
            if self.mode != "opencode"
                || self.resume_session_id.as_deref() != Some(transfer.root_session_id.as_str())
                || !self
                    .opencode_transfer_attempt_id
                    .as_deref()
                    .is_some_and(valid_opencode_transfer_attempt_id)
            {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::RecoveryWrongIdentity,
                    "OpenCode transfer must match the resumed native session and a valid staging attempt",
                ));
            }
        } else if self.opencode_transfer_attempt_id.is_some() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                "OpenCode staging attempt has no transfer descriptor",
            ));
        }
        if let Some(adoption) = &self.opencode_adoption {
            adoption.validate()?;
            if self.mode != "opencode"
                || self.resume_session_id.as_deref() != Some(adoption.root_session_id.as_str())
            {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::RecoveryWrongIdentity,
                    "OpenCode adoption expectation does not match the resumed root session",
                ));
            }
        }
        if self.env.len() > 512 || self.args.len() > 512 || self.provider_bootstrap_files.len() > 16
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                "managed terminal launch exceeds argv/env/bootstrap bounds",
            ));
        }
        validate_managed_terminal_args(&self.mode, &self.args)?;
        for name in self.env.keys() {
            let upper = name.to_ascii_uppercase();
            if [
                "TOKEN",
                "API_KEY",
                "SECRET",
                "PASSWORD",
                "CREDENTIAL",
                "OAUTH",
                "PROXY",
            ]
            .iter()
            .any(|marker| upper.contains(marker))
            {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::InvalidRequest,
                    "managed provider secrets must use a OneCLI reference",
                ));
            }
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
            if !source.is_absolute() || secret.source_path.chars().any(char::is_control) {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::InvalidRequest,
                    "managed provider secret reference is unsafe or unsupported",
                ));
            }
        }
        validate_provider_secrets(&self.mode, &self.provider_secret_references)?;
        if let Some(inputs) = self
            .provider_launch_context
            .as_ref()
            .and_then(|context| context.prepared_inputs.as_ref())
        {
            inputs.validate_references(&self.provider_secret_references)?;
        }
        if let Some(context) = &self.provider_launch_context {
            context.validate(&self.mode)?;
        }
        if matches!(self.mode.as_str(), "claude" | "codex" | "opencode")
            && !self.provider_bootstrap_files.is_empty()
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                "raw credential bootstrap is unsupported for named managed providers",
            ));
        }
        Ok(())
    }
}

/// Approved SHA-256 digests of the managed Claude `--settings` recipe
/// (`freshell_platform::cli_launch::claude_settings_json`). The recipe is
/// pinned by digest (not raw text) so the list stays a fixed-size constant.
/// Superseded recipe revisions stay listed so durable argv persisted under
/// them keeps validating. When `freshell-platform` changes the recipe, add
/// the new digest here — the drift-guard test
/// (`approved_claude_settings_digests_track_current_recipes`) fails with the
/// computed digest until you do.
const APPROVED_CLAUDE_SETTINGS_DIGESTS: [&str; 4] = [
    // Current recipes (since 0908a4624, Oct 4 2026: bell via hook response).
    "41b86fd2aed9fa85ad0c3e99695de49fdadc36fcd6dc80d9fb53a2305b95cd71", // Unix
    "b48c5d93ff2129438e2e10dc9eadc45849ec1b93c683a1ca08aebaa55d46a786", // Windows
    // Superseded recipes (pre-0908a4624: bell via /dev/tty and CONOUT$).
    "aa8900bab7bd9bcbb64634d60593a9217c1639b539cea23318122b3428d123c6", // Unix
    "d2dcb96c036160b2469bcd732fdc8d767dd481f9c0c864ce47d58ed057652c4d", // Windows
];

/// Durable argv accepts only provider launch selectors. Credential-bearing
/// switches must be resolved through the child-only OneCLI path instead.
pub fn validate_managed_terminal_args(mode: &str, args: &[String]) -> Result<(), RuntimeError> {
    if !matches!(mode, "claude" | "codex" | "opencode" | "amplifier") {
        return Ok(()); // Legacy shell and Kilroy launches keep their contract.
    }
    let invalid = || {
        RuntimeError::new(
            RuntimeErrorCode::InvalidRequest,
            "managed provider arguments must use an approved non-secret recipe",
        )
    };
    let mut index = 0;
    let mut claude_fork = false;
    let mut claude_root_selectors = 0;
    while index < args.len() {
        let flag = args[index].as_str();
        if mode == "claude" && flag == "--init-only" {
            index += 1;
            continue;
        }
        if mode == "claude" && flag == "--fork-session" {
            claude_fork = true;
            index += 1;
            continue;
        }
        if mode == "codex" && flag == "resume" && index + 1 < args.len() {
            if !safe_selector(&args[index + 1]) {
                return Err(invalid());
            }
            index += 2;
            continue;
        }
        if mode == "amplifier"
            && args[index..].starts_with(&[
                "session".into(),
                "resume".into(),
                "--full-history".into(),
            ])
            && index + 3 < args.len()
        {
            if !safe_selector(&args[index + 3]) {
                return Err(invalid());
            }
            index += 4;
            continue;
        }
        let value = args.get(index + 1).ok_or_else(invalid)?;
        let allowed = match (mode, flag) {
            ("claude", "--settings") => {
                let digest = format!("{:x}", sha2::Sha256::digest(value.as_bytes()));
                value == freshell_platform::claude_inputs::MANAGED_SETTINGS_ARGUMENT
                    || freshell_platform::cli_launch::is_owned_claude_settings(value)
                    || APPROVED_CLAUDE_SETTINGS_DIGESTS.contains(&digest.as_str())
                    || [freshell_platform::cli_launch::ProviderTarget::Unix, freshell_platform::cli_launch::ProviderTarget::Windows].into_iter().any(|target| value == &freshell_platform::cli_launch::claude_settings_json(target))
                    || value == &freshell_platform::cli_launch::claude_managed_settings_json()
            }
            ("claude", "--mcp-config") => matches!(
                value.as_str(),
                ".claude/freshell-mcp.json" | "/home/freshell/provider/.claude/freshell-mcp.json"
            ),
            ("claude", "--session-id" | "--resume") => {
                claude_root_selectors += 1;
                safe_selector(value)
            }
            ("claude", "--model" | "--effort" | "--permission-mode") => safe_selector(value),
            ("claude", "--plugin-dir") => safe_selector(value),
            ("claude", "--setting-sources") => freshell_platform::claude_inputs::parse_setting_sources(value).is_ok(),
            ("codex", "-c") => {
                matches!(
                    value.as_str(),
                    "tui.notification_method=bel"
                        | "check_for_update_on_startup=false"
                        | "tui.notifications=['agent-turn-complete']"
                        | "features.apps=false"
                        | "mcp_servers.freshell.command=\"node\""
                        | "mcp_servers.freshell.args=[\"/opt/freshell-mcp/server.js\"]"
                        | "mcp_servers.freshell.env_vars=[\"FRESHELL\", \"FRESHELL_URL\", \"FRESHELL_TOKEN\", \"FRESHELL_TERMINAL_ID\", \"FRESHELL_TAB_ID\", \"FRESHELL_PANE_ID\"]"
                ) || value
                    .strip_prefix("model_reasoning_effort=\"")
                    .and_then(|part| part.strip_suffix('"'))
                    .is_some_and(safe_selector)
            }
            ("codex", "--profile" | "-p") => freshell_platform::codex_inputs::valid_profile(value),
            ("codex", "--model" | "--sandbox") => safe_selector(value),
            ("codex", "--remote") => value
                .strip_prefix("ws://127.0.0.1:")
                .is_some_and(|port| port.parse::<u16>().is_ok_and(|port| port > 0)),
            ("opencode", "--hostname") => value == "127.0.0.1",
            ("opencode", "--port") => value.parse::<u16>().is_ok(),
            ("opencode", "--session" | "--model") => safe_selector(value),
            ("amplifier", "--bundle" | "--provider" | "--model" | "--mode") => safe_selector(value),
            _ => false,
        };
        if !allowed {
            return Err(invalid());
        }
        index += 2;
    }
    if claude_fork && claude_root_selectors != 1 {
        return Err(invalid());
    }
    Ok(())
}

/// Convert the web process's ordinary launch argv into its durable recipe.
/// Claude's web-owned MCP file is omitted. Its shipped settings recipe is
/// regenerated; selected user settings use an owned marker resolved only from
/// accepted private inputs at final child argv construction.
pub fn durable_managed_terminal_args(
    mode: &str,
    args: Vec<String>,
    claude_settings: Option<&str>,
) -> Result<Vec<String>, RuntimeError> {
    if mode == "codex" {
        let mut out = Vec::with_capacity(args.len());
        let mut index = 0;
        while index < args.len() {
            if args[index] == "-c" {
                let value = args.get(index + 1).ok_or_else(|| {
                    RuntimeError::new(
                        RuntimeErrorCode::InvalidRequest,
                        "incomplete Codex config argument",
                    )
                })?;
                if value
                    .strip_prefix("mcp_servers.freshell.")
                    .and_then(|value| value.split_once('='))
                    .is_some_and(|(key, _)| matches!(key, "command" | "args" | "env_vars"))
                {
                    index += 2;
                    continue;
                }
            }
            out.push(args[index].clone());
            index += 1;
        }
        validate_managed_terminal_args(mode, &out)?;
        return Ok(out);
    }
    if mode != "claude" {
        validate_managed_terminal_args(mode, &args)?;
        return Ok(args);
    }
    let invalid = || {
        RuntimeError::new(
            RuntimeErrorCode::InvalidRequest,
            "managed Claude launch argument is incomplete or unsupported",
        )
    };
    let mut out = Vec::with_capacity(args.len());
    let mut index = 0;
    let mut selected_settings = None;
    while index < args.len() {
        match args[index].as_str() {
            flag if flag == "--setting-sources" || flag.starts_with("--setting-sources=") => {
                let value = if let Some(value) = flag.strip_prefix("--setting-sources=") {
                    index += 1;
                    value
                } else {
                    let value = args.get(index + 1).ok_or_else(invalid)?;
                    index += 2;
                    value.as_str()
                };
                let selected = freshell_platform::claude_inputs::parse_setting_sources(value)
                    .map_err(|_| invalid())?;
                out.push("--setting-sources".into());
                out.push(
                    selected
                        .into_iter()
                        .map(|source| source.as_str())
                        .collect::<Vec<_>>()
                        .join(","),
                );
            }
            "--mcp-config" => {
                args.get(index + 1).ok_or_else(invalid)?;
                index += 2;
            }
            flag if flag == "--settings" || flag.starts_with("--settings=") => {
                let value = if let Some(value) = flag.strip_prefix("--settings=") {
                    index += 1;
                    value
                } else {
                    let value = args.get(index + 1).ok_or_else(invalid)?;
                    index += 2;
                    value.as_str()
                };
                selected_settings = Some((out.len(), value));
            }
            _ => {
                out.push(args[index].clone());
                index += 1;
            }
        }
    }
    if let Some((position, value)) = selected_settings {
        out.insert(position, "--settings".into());
        out.insert(
            position + 1,
            if freshell_platform::cli_launch::is_owned_claude_settings(value) {
                claude_settings.ok_or_else(invalid)?.into()
            } else {
                freshell_platform::claude_inputs::MANAGED_SETTINGS_ARGUMENT.into()
            },
        );
    }
    validate_managed_terminal_args(mode, &out)?;
    Ok(out)
}

fn safe_selector(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'.' | b'_' | b'-' | b':' | b'/' | b'@' | b'+')
        })
}

pub fn validate_provider_secrets(
    provider: &str,
    references: &[ProviderSecretReference],
) -> Result<(), RuntimeError> {
    let invalid = || {
        RuntimeError::new(
            RuntimeErrorCode::InvalidRequest,
            "managed provider grant profile, destination or capacity is invalid",
        )
    };
    if references.len() > 132 {
        return Err(invalid());
    }
    let mut legacy_profiles = std::collections::BTreeSet::new();
    let mut destinations = std::collections::BTreeSet::new();
    for reference in references {
        if reference.profile.provider() != provider
            || !std::path::Path::new(&reference.source_path).is_absolute()
            || reference.source_path.len()
                > if reference.profile.is_configuration_file() {
                    MAX_CONTROL_FRAME_BYTES
                } else {
                    1024
                }
            || reference.source_path.chars().any(char::is_control)
            || matches!(
                reference.profile,
                ProviderSecretProfile::LegacyAmplifierOnecliAnthropicHaikuLow
            )
        {
            return Err(invalid());
        }
        if reference.profile.is_configuration_file() {
            let destination = reference
                .provider_relative_path
                .as_deref()
                .ok_or_else(invalid)?;
            let id = destination
                .strip_prefix(".freshell/references/")
                .ok_or_else(invalid)?;
            if id.is_empty()
                || id.len() > 128
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
                || !destinations.insert(destination)
                || destinations.len() > 128
            {
                return Err(invalid());
            }
        } else if reference.provider_relative_path.is_some()
            || !legacy_profiles.insert(reference.profile as u8)
            || legacy_profiles.len() > 4
        {
            return Err(invalid());
        }
    }
    Ok(())
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion: Option<TerminalSpoolCompletion>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    /// Provider-native durable conversation id discovered by the session host.
    /// For OpenCode this is the soul-local `ses_*` row, never a web-side guess.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_session_id: Option<String>,
    #[serde(default)]
    pub frames: Vec<RuntimeOutputFrame>,
    /// Native activity metadata from the private OpenCode endpoint. Raw
    /// provider events and HTTP bodies never cross this control boundary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opencode_activity: Option<freshell_activity::opencode::OpencodeActivityBatch>,
    /// Native Codex turn metadata from the host-owned app-server proxy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_activity: Option<freshell_activity::codex::CodexActivityBatch>,
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

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
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

impl FreshAgentTurnSettings {
    /// The effort a provider's live `freshAgent.configure` ends on. A
    /// configure states only what changed, except that the model selector's
    /// Default thinking row is sent as an absent effort. Claude and Kilroy
    /// read that absence as Default when the model changes, OpenCode always
    /// does, and Codex keeps the session's effort. Every durable copy of a
    /// hosted profile (the host actor's and the supervisor's recovery record)
    /// applies this same rule, so they agree with the live session and with
    /// each other.
    pub fn effort_after_configure(
        &self,
        provider: &FreshProvider,
        current_model: Option<&str>,
        current_effort: Option<&str>,
    ) -> Option<String> {
        if let Some(effort) = &self.effort {
            return Some(effort.clone());
        }
        let absent_means_default = match provider {
            FreshProvider::Claude | FreshProvider::Kilroy => self
                .model
                .as_deref()
                .is_some_and(|model| Some(model) != current_model),
            FreshProvider::Opencode => true,
            FreshProvider::Codex => false,
        };
        if absent_means_default {
            None
        } else {
            current_effort.map(str::to_string)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentSendRequest {
    pub soul_id: SoulId,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<FreshAgentTurnSettings>,
    /// Opaque checkpoint attempt identity, when this send crossed the modern
    /// server-owned snapshot barrier. It is passed through the managed host to
    /// the provider so the native turn receipt can be joined without text or
    /// ordinal matching.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint_logical_attempt_id: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_fork: Option<ClaudeForkRecipe>,
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
pub struct FreshAgentReadHistoryRequest {
    pub soul_id: SoulId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_control_epoch: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentReadSnapshotRequest {
    pub soul_id: SoulId,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic_code: Option<RuntimeDiagnosticCode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fresh_agent_provider_start_diagnostic: Option<FreshAgentProviderStartDiagnostic>,
}

impl RuntimeError {
    pub fn new(code: RuntimeErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            diagnostic_code: None,
            fresh_agent_provider_start_diagnostic: None,
        }
    }

    pub fn with_diagnostic_code(mut self, diagnostic_code: RuntimeDiagnosticCode) -> Self {
        self.diagnostic_code = Some(diagnostic_code);
        self
    }

    pub fn with_fresh_agent_provider_start_diagnostic(
        mut self,
        diagnostic: FreshAgentProviderStartDiagnostic,
    ) -> Self {
        self.fresh_agent_provider_start_diagnostic = Some(diagnostic);
        self
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

/// Immutable source and destination binding for one OpenCode history import.
/// It contains bounded metadata only; payload and asset bytes use the dedicated
/// chunk commands below.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeTransferDescriptor {
    pub transfer_id: String,
    pub provider: String,
    pub source_store_id: String,
    pub root_session_id: String,
    pub source_generation: String,
    pub provider_schema: String,
    pub source_schema_fingerprint: String,
    pub migration_journal_fingerprint: String,
    pub destination_store_id: String,
    pub destination_database_path: String,
    pub target_image_ref: String,
    pub target_build_receipt: String,
    pub incarnation_id: String,
    /// Serialized Task 1 manifest. It contains per-row digests and asset
    /// metadata, never message or prompt bodies.
    pub manifest_json: String,
    pub files: Vec<OpenCodeTransferFile>,
    pub total_bytes: u64,
    /// SHA-256 over the manifest and ordered file metadata. Per-file SHA-256
    /// values bind every transmitted byte.
    pub bundle_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeTransferFile {
    pub index: u32,
    pub relative_path: String,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeTransferChunk {
    pub transfer_id: String,
    /// Opaque fencing token for the Begin/resume attempt that owns this
    /// partial stage. A later Begin for the stable transfer ID supersedes it.
    pub attempt_id: String,
    pub sequence: u64,
    pub file_index: u32,
    pub offset: u64,
    #[serde(with = "base64_bytes")]
    pub data: Vec<u8>,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", content = "data", rename_all = "snake_case")]
pub enum OpenCodeTransferAction {
    TargetInfo,
    Begin {
        descriptor: Box<OpenCodeTransferDescriptor>,
        attempt_id: String,
    },
    WaitForCapacity {
        transfer_id: String,
        attempt_id: String,
    },
    Chunk(OpenCodeTransferChunk),
    Finalize {
        transfer_id: String,
        attempt_id: String,
    },
    Abort {
        transfer_id: String,
        attempt_id: String,
    },
}

/// Attempt tokens use UUID's simple 32-character lowercase hexadecimal form.
/// Keeping the wire form opaque avoids making attempt identity part of the
/// durable transfer descriptor or its readiness receipt.
pub fn valid_opencode_transfer_attempt_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_opencode_session_id(value: &str) -> bool {
    value
        .strip_prefix("ses_")
        .is_some_and(|id| !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_alphanumeric()))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", content = "data", rename_all = "snake_case")]
pub enum OpenCodeTransferResult {
    TargetInfo {
        image_ref: String,
        provider_schema: String,
        build_receipt: String,
    },
    Started {
        next_sequence: u64,
        file_offsets: Vec<OpenCodeTransferFileOffset>,
    },
    ChunkStored {
        sequence: u64,
    },
    Queued {
        transfer_id: String,
    },
    Ready {
        transfer_id: String,
    },
    Aborted {
        transfer_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeTransferFileOffset {
    pub file_index: u32,
    pub next_offset: u64,
}

/// Body-free acknowledgement that the session host revalidated the durable
/// structural import and provider-identity reader receipts before consuming
/// an execution grant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeTransferReadinessReceipt {
    pub transfer_id: String,
    pub destination_store_id: String,
    pub root_session_id: String,
    pub source_generation: String,
    pub provider_uid: u32,
    pub provider_gid: u32,
    pub structural_sha256: String,
    pub reader_receipt_sha256: String,
}

/// Exact verified root-history state that a resumed managed OpenCode TUI must
/// load before the session host will release user input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", content = "data", rename_all = "snake_case")]
pub enum OpenCodeVerifiedRootTail {
    Message {
        message_id: String,
    },
    /// This variant may be produced only after a successful native read has
    /// confirmed the root session has no messages.
    QualifiedEmpty,
}

/// Passive import metadata used to verify later store evolutions. It carries
/// no bundle bytes and never authorizes running the importer on resume.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeAdoptionBaseline {
    pub descriptor: OpenCodeTransferDescriptor,
    pub manifest_sha256: String,
}

/// Identity selected by the current native provider loader, never by argv or
/// an old transcript. The digest covers body-free producer evidence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeIdentitySource {
    CodexAppServer,
    OpencodeTui,
    ClaudeNativeEvent,
    /// The same CLI selected a new session through its native /clear command.
    ClaudeNativeClear,
    AmplifierNativeLoadedContext,
    FreshProviderHandshake,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeIdentityObservation {
    pub native_session_id: String,
    pub incarnation_id: IncarnationId,
    pub launch_nonce: String,
    pub evidence_revision: u64,
    pub source: NativeIdentitySource,
    pub evidence_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeIdentityLaunch {
    pub incarnation_id: IncarnationId,
    pub launch_nonce: String,
    pub evidence_revision: u64,
    pub execution_generation: u64,
    pub requested_native_session_id: Option<String>,
}

impl NativeIdentityObservation {
    pub fn matches_provider(&self, provider: &str, fresh_agent: bool) -> bool {
        if fresh_agent {
            return matches!(provider, "claude" | "kilroy" | "codex" | "opencode")
                && (self.source == NativeIdentitySource::FreshProviderHandshake
                    || (matches!(provider, "claude" | "kilroy")
                        && self.source == NativeIdentitySource::ClaudeNativeClear));
        }
        matches!(
            (provider, &self.source),
            ("claude", NativeIdentitySource::ClaudeNativeEvent)
                | ("claude", NativeIdentitySource::ClaudeNativeClear)
                | ("codex", NativeIdentitySource::CodexAppServer)
                | ("opencode", NativeIdentitySource::OpencodeTui)
                | (
                    "amplifier",
                    NativeIdentitySource::AmplifierNativeLoadedContext
                )
        )
    }

    pub fn matches_launch(&self, launch: &NativeIdentityLaunch) -> bool {
        !self.native_session_id.is_empty()
            && !self.native_session_id.chars().any(char::is_control)
            && self.incarnation_id == launch.incarnation_id
            && !self.launch_nonce.is_empty()
            && self.launch_nonce == launch.launch_nonce
            && self.evidence_revision == launch.evidence_revision
            // A native clear replaces the root within this same launched CLI.
            // Other loader observations must still acknowledge the requested root.
            && (self.source == NativeIdentitySource::ClaudeNativeClear
                || launch
                    .requested_native_session_id
                    .as_deref()
                    .is_none_or(|root| root == self.native_session_id))
            && self.evidence_digest.len() == 64
            && self
                .evidence_digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }
}

impl OpenCodeAdoptionBaseline {
    pub fn from_descriptor(descriptor: OpenCodeTransferDescriptor) -> Result<Self, RuntimeError> {
        let baseline = Self {
            manifest_sha256: sha256_hex(descriptor.manifest_json.as_bytes()),
            descriptor,
        };
        baseline.validate()?;
        Ok(baseline)
    }

    pub fn validate(&self) -> Result<(), RuntimeError> {
        self.descriptor.validate()?;
        if !is_lower_hex_64(&self.manifest_sha256)
            || sha256_hex(self.descriptor.manifest_json.as_bytes()) != self.manifest_sha256
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                "OpenCode adoption baseline manifest digest is invalid",
            ));
        }
        Ok(())
    }
}

/// Per-launch evidence required to open a managed OpenCode terminal's input
/// gate. `launch_nonce` makes observations from older launches inert even
/// when terminal and native session ids are reused.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeAdoptionExpectation {
    pub baseline: OpenCodeAdoptionBaseline,
    pub root_session_id: String,
    pub root_tail: OpenCodeVerifiedRootTail,
    pub evidence_generation: String,
    pub incarnation_id: IncarnationId,
    pub launch_nonce: String,
}

impl OpenCodeAdoptionExpectation {
    pub fn validate(&self) -> Result<(), RuntimeError> {
        self.baseline.validate()?;
        let tail_is_valid = match &self.root_tail {
            OpenCodeVerifiedRootTail::Message { message_id } => {
                !message_id.is_empty() && message_id.len() <= 256
            }
            OpenCodeVerifiedRootTail::QualifiedEmpty => true,
        };
        if !valid_opencode_session_id(&self.root_session_id)
            || self.baseline.descriptor.root_session_id != self.root_session_id
            || !tail_is_valid
            || !is_lower_hex_64(&self.evidence_generation)
            || !valid_opencode_transfer_attempt_id(&self.launch_nonce)
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                "OpenCode adoption expectation is invalid",
            ));
        }
        Ok(())
    }
}

/// Result of the plugin's fresh, hydrated TUI read of the active root
/// session's native messages. A failed read and a successful empty read are
/// distinct protocol states.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpenCodeMessagesRead {
    Success,
    EmptyConfirmed,
    Failed,
}

/// Body-free observation written by the OpenCode TUI plugin for one exact
/// terminal launch. It is not adoption evidence until the session host checks
/// every field against its launch expectation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenCodeAdoptionObservation {
    #[serde(alias = "terminal_id")]
    pub terminal_id: String,
    #[serde(alias = "root_session_id")]
    pub root_session_id: String,
    #[serde(alias = "tail_message_id")]
    pub tail_message_id: Option<String>,
    #[serde(alias = "evidence_generation")]
    pub evidence_generation: String,
    #[serde(alias = "incarnation_id")]
    pub incarnation_id: IncarnationId,
    #[serde(alias = "launch_nonce")]
    pub launch_nonce: String,
    pub hydrated: bool,
    #[serde(alias = "messages_read")]
    pub messages_read: OpenCodeMessagesRead,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "state", content = "data", rename_all = "snake_case")]
pub enum OpenCodeAdoptionStatus {
    #[default]
    NotRequired,
    AwaitingObservation,
    Observed {
        observation: OpenCodeAdoptionObservation,
    },
}

impl OpenCodeTransferReadinessReceipt {
    pub fn matches_descriptor(&self, descriptor: &OpenCodeTransferDescriptor) -> bool {
        self.transfer_id == descriptor.transfer_id
            && self.destination_store_id == descriptor.destination_store_id
            && self.root_session_id == descriptor.root_session_id
            && self.source_generation == descriptor.source_generation
            && is_lower_hex_64(&self.structural_sha256)
            && is_lower_hex_64(&self.reader_receipt_sha256)
    }
}

impl OpenCodeTransferDescriptor {
    pub fn validate(&self) -> Result<(), RuntimeError> {
        let invalid = || {
            RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                "OpenCode transfer descriptor is invalid or exceeds its bounds",
            )
        };
        if self.transfer_id.is_empty()
            || self.transfer_id.len() > 128
            || !self
                .transfer_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            || self.provider != "opencode"
            || !is_lower_hex_64(&self.source_store_id)
            || self.root_session_id.is_empty()
            || self.root_session_id.len() > 256
            || self.source_generation.len() != 64
            || self.provider_schema != "opencode-1.18.21"
            || self.source_schema_fingerprint.len() != 64
            || self.migration_journal_fingerprint.len() != 64
            || self.destination_store_id.is_empty()
            || self.destination_database_path != OPENCODE_TRANSFER_DESTINATION_DB
            || !self.target_image_ref.starts_with("sha256:")
            || self.target_image_ref.len() != "sha256:".len() + 64
            || self.target_build_receipt.len() != 64
            || self.incarnation_id.is_empty()
            || self.manifest_json.len() > MAX_OPENCODE_TRANSFER_MANIFEST_BYTES
            || self.files.is_empty()
            || self.files.len() > MAX_OPENCODE_TRANSFER_FILES
            || self.total_bytes == 0
            || self.total_bytes > MAX_OPENCODE_TRANSFER_BUNDLE_BYTES
            || !is_lower_hex_64(&self.source_generation)
            || !is_lower_hex_64(&self.source_schema_fingerprint)
            || !is_lower_hex_64(&self.migration_journal_fingerprint)
            || !is_lower_hex_64(&self.target_build_receipt)
            || !is_lower_hex_64(&self.bundle_sha256)
            || !is_lower_hex_64(&self.target_image_ref["sha256:".len()..])
            || self.target_build_receipt
                != opencode_target_build_receipt(&self.target_image_ref, &self.provider_schema)
        {
            return Err(invalid());
        }
        IncarnationId::parse(self.incarnation_id.clone()).map_err(|_| invalid())?;

        let manifest: serde_json::Value =
            serde_json::from_str(&self.manifest_json).map_err(|_| invalid())?;
        if manifest
            .get("root_session_id")
            .and_then(serde_json::Value::as_str)
            != Some(self.root_session_id.as_str())
            || manifest
                .get("source_store_id")
                .and_then(serde_json::Value::as_str)
                != Some(self.source_store_id.as_str())
            || manifest
                .get("generation")
                .and_then(serde_json::Value::as_str)
                != Some(self.source_generation.as_str())
            || manifest
                .get("provider_schema")
                .and_then(serde_json::Value::as_str)
                != Some(self.provider_schema.as_str())
            || manifest
                .get("source_schema_fingerprint")
                .and_then(serde_json::Value::as_str)
                != Some(self.source_schema_fingerprint.as_str())
            || manifest
                .get("migration_journal_fingerprint")
                .and_then(serde_json::Value::as_str)
                != Some(self.migration_journal_fingerprint.as_str())
            || !matches!(
                manifest.get("version").and_then(serde_json::Value::as_u64),
                Some(1 | 2)
            )
            || manifest
                .get("payload_bytes")
                .and_then(serde_json::Value::as_u64)
                != self.files.first().map(|file| file.size_bytes)
            || manifest
                .get("payload_sha256")
                .and_then(serde_json::Value::as_str)
                != self.files.first().map(|file| file.sha256.as_str())
        {
            return Err(invalid());
        }

        // New transfers put variable row/asset/snapshot metadata in the
        // existing checksummed bulk stream. Control messages stay bounded as
        // a conversation grows. Legacy descriptors retain their old arrays.
        let assets: &[serde_json::Value] = if manifest["version"] == 1 {
            manifest
                .get("assets")
                .and_then(serde_json::Value::as_array)
                .ok_or_else(invalid)?
        } else {
            let summary = &manifest["saved_snapshot_summary"];
            let valid_summary = match summary["status"].as_str() {
                Some("legacy_unqualified") => true,
                Some("qualified_references") => {
                    summary["retained_closure_count"].as_u64().is_some()
                        && summary["unavailable_reference_count"].as_u64().is_some()
                }
                _ => false,
            };
            if manifest["row_count"].as_u64().is_none()
                || manifest["asset_count"].as_u64().is_none()
                || !valid_summary
                || self.files.len() != 1
            {
                return Err(invalid());
            }
            &[]
        };
        let mut seen_indices = std::collections::BTreeSet::new();
        let mut seen_paths = std::collections::BTreeSet::new();
        let mut asset_metadata = std::collections::BTreeSet::new();
        let mut total = 0_u64;
        for (position, file) in self.files.iter().enumerate() {
            let path = std::path::Path::new(&file.relative_path);
            if file.index as usize != position
                || !seen_indices.insert(file.index)
                || !seen_paths.insert(file.relative_path.as_str())
                || file.relative_path.is_empty()
                || path.is_absolute()
                || path
                    .components()
                    .any(|component| !matches!(component, std::path::Component::Normal(_)))
                || file.size_bytes == 0
                || !is_lower_hex_64(&file.sha256)
            {
                return Err(invalid());
            }
            total = total.checked_add(file.size_bytes).ok_or_else(invalid)?;
        }
        for asset in assets {
            let kind = asset
                .get("kind")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(invalid)?;
            let path = asset
                .get("target_relative_path")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(invalid)?;
            let size = asset
                .get("size_bytes")
                .and_then(serde_json::Value::as_u64)
                .ok_or_else(invalid)?;
            let sha256 = asset
                .get("sha256")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(invalid)?;
            let relative = std::path::Path::new(path);
            let empty_workspace_reference =
                kind == "workspace_path_reference" && sha256 == sha256_hex(&[]);
            if kind.is_empty()
                || path.is_empty()
                || relative.is_absolute()
                || relative
                    .components()
                    .any(|component| !matches!(component, std::path::Component::Normal(_)))
                || (size == 0 && !empty_workspace_reference)
                || !is_lower_hex_64(sha256)
                || !asset_metadata.insert((path.to_string(), size, sha256.to_string()))
            {
                return Err(invalid());
            }
        }
        if self.files.iter().skip(1).any(|file| {
            !asset_metadata.contains(&(
                file.relative_path.clone(),
                file.size_bytes,
                file.sha256.clone(),
            ))
        }) {
            return Err(invalid());
        }
        if self.files[0].index != 0
            || self.files[0].relative_path != "payload.json"
            || total != self.total_bytes
            || self.bundle_sha256
                != opencode_transfer_bundle_digest(&self.manifest_json, &self.files)
        {
            return Err(invalid());
        }
        Ok(())
    }

    pub fn validate_launch_binding(
        &self,
        provider: &str,
        root_session_id: &str,
        destination_store_id: &str,
        incarnation_id: &str,
        image_ref: &str,
    ) -> Result<(), RuntimeError> {
        self.validate()?;
        if provider != self.provider
            || root_session_id != self.root_session_id
            || destination_store_id != self.destination_store_id
            || incarnation_id != self.incarnation_id
            || image_ref != self.target_image_ref
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::RecoveryWrongIdentity,
                "OpenCode transfer does not match the launch identity or target image",
            ));
        }
        Ok(())
    }
}

impl OpenCodeTransferChunk {
    pub fn validate(&self) -> Result<(), RuntimeError> {
        if self.transfer_id.is_empty()
            || self.transfer_id.len() > 128
            || !valid_opencode_transfer_attempt_id(&self.attempt_id)
            || self.data.is_empty()
            || self.data.len() > MAX_OPENCODE_TRANSFER_CHUNK_BYTES
            || !is_lower_hex_64(&self.sha256)
            || self.sha256 != sha256_hex(&self.data)
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                "OpenCode transfer chunk is invalid or exceeds 256 KiB",
            ));
        }
        Ok(())
    }
}

pub fn opencode_transfer_bundle_digest(
    manifest_json: &str,
    files: &[OpenCodeTransferFile],
) -> String {
    let mut files = files.to_vec();
    files.sort_by_key(|file| file.index);
    let mut hasher = Sha256::new();
    hasher.update(b"freshell-opencode-transfer-v1\0");
    hasher.update(manifest_json.as_bytes());
    hasher.update([0]);
    for file in files {
        hasher.update(file.index.to_be_bytes());
        hasher.update(file.relative_path.as_bytes());
        hasher.update([0]);
        hasher.update(file.size_bytes.to_be_bytes());
        hasher.update(file.sha256.as_bytes());
        hasher.update([0]);
    }
    hex::encode(hasher.finalize())
}

pub fn opencode_target_build_receipt(image_ref: &str, provider_schema: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"freshell-opencode-import-build-v1\0");
    hasher.update(image_ref.as_bytes());
    hasher.update([0]);
    hasher.update(provider_schema.as_bytes());
    hex::encode(hasher.finalize())
}

fn is_lower_hex_64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

mod base64_bytes {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&STANDARD.encode(bytes))
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Vec<u8>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        STANDARD.decode(value).map_err(serde::de::Error::custom)
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
            (None, Some(terminal), None) => {
                terminal.validate()?;
                if let Some(transfer) = &terminal.opencode_transfer {
                    if self.provider != "opencode"
                        || self.provider_store_id != transfer.destination_store_id
                        || self.native_session_id.as_deref()
                            != Some(transfer.root_session_id.as_str())
                    {
                        return Err(RuntimeError::new(
                            RuntimeErrorCode::RecoveryWrongIdentity,
                            "OpenCode transfer does not match the launch provider store or native session",
                        ));
                    }
                }
                if let Some(adoption) = &terminal.opencode_adoption {
                    if self.provider != "opencode"
                        || self.native_session_id.as_deref()
                            != Some(adoption.root_session_id.as_str())
                    {
                        return Err(RuntimeError::new(
                            RuntimeErrorCode::RecoveryWrongIdentity,
                            "OpenCode adoption expectation does not match the launch provider or native root",
                        ));
                    }
                }
                Ok(())
            }
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
    ReserveProviderInputs(ReserveProviderInputsRequest),
    NativeAuthLookup(NativeAuthLookupRequest),
    ObserveClaudeSources(Box<ObserveClaudeSourcesRequest>),
    BindProviderPathInputs(BindProviderPathInputsRequest),
    Launch(Box<LaunchRequest>),
    /// Dedicated authenticated, bounded OpenCode-history transfer channel.
    /// These chunk commands are never embedded in launch or host-control
    /// frames; launch carries only the immutable descriptor.
    OpenCodeTransfer(OpenCodeTransferAction),
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
    PreflightLostSouls(PreflightLostSoulsRequest),
    RestoreLostSouls(RestoreLostSoulsRequest),
    MetricsSnapshot,
    MigrationPlan(MigrationPlanRequest),
    RepairAudit(RepairRequest),
    TerminalInput(TerminalInputRequest),
    TerminalResize(TerminalResizeRequest),
    TerminalReadOutput(TerminalReadOutputRequest),
    FreshAgentSend(FreshAgentSendRequest),
    FreshAgentFork(FreshAgentForkRequest),
    FreshAgentCompact(FreshAgentCompactRequest),
    FreshAgentConfigure(FreshAgentConfigureRequest),
    FreshAgentRollback(FreshAgentRollbackRequest),
    FreshAgentCapture(FreshAgentCaptureRequest),
    FreshAgentResolve(FreshAgentResolveRequest),
    FreshAgentPrepareNative(FreshAgentInterruptRequest),
    FreshAgentInterrupt(FreshAgentInterruptRequest),
    FreshAgentReadEvents(FreshAgentReadEventsRequest),
    FreshAgentReadHistory(FreshAgentReadHistoryRequest),
    FreshAgentReadSnapshot(FreshAgentReadSnapshotRequest),
    RuntimeMetrics(RuntimeMetricsRequest),
    ProbeRecovery(RecoveryProbeRequest),
    Recover(RecoverRequest),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReserveProviderInputsRequest {
    pub expected_control_epoch: Option<u64>,
    pub soul_id: SoulId,
    pub provider: String,
    pub creation_seed_ref: String,
}

/// Exact registry-backed creation identity. The observation is recorded only
/// after the selected daemon confirms the reserved volume is absent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderInputReservation {
    pub reservation_id: String,
    pub installation_id: InstallationId,
    pub soul_id: SoulId,
    pub provider: String,
    pub creation_seed_ref: String,
    pub intent_revision: u64,
    pub provider_volume_name: String,
    pub image_ref: String,
    pub host_binary_path: String,
    pub host_binary_sha256: String,
    pub observation: InitialAuthVolumeObservation,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum InitialAuthVolumeObservation {
    /// The exact creation-owned volume after a positively rejected initial
    /// grant. This is retained ownership evidence, not a claim of absence.
    OwnedUndispatched {
        #[serde(rename = "daemonId")]
        daemon_id: DockerDaemonId,
        #[serde(rename = "incarnationId")]
        incarnation_id: IncarnationId,
    },
    Absent {
        #[serde(rename = "daemonId")]
        daemon_id: DockerDaemonId,
    },
}

/// Transient nested callback request; the authority is scoped by the supervisor
/// to the recovery attempt whose lifecycle lock is already held.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeAuthLookupRequest {
    pub expected_control_epoch: Option<u64>,
    pub soul_id: SoulId,
    pub attempt_authority: String,
    pub keys: Vec<String>,
}

/// Claude source selection has its own purpose and eligibility. Creation
/// absence authorizes an empty initial HOME, never source or native-store absence.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ClaudeSourceAuthority {
    InitialReservation {
        #[serde(rename = "reservationId")]
        reservation_id: String,
    },
    RecoveryAttempt {
        #[serde(rename = "attemptId")]
        attempt_id: String,
    },
}

pub type ClaudeSourceObservation = freshell_platform::claude_inputs::observation::ObservationReply;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObserveClaudeSourcesRequest {
    pub expected_control_epoch: Option<u64>,
    pub soul_id: SoulId,
    pub provider: String,
    pub authority: ClaudeSourceAuthority,
    pub workspace_path: String,
    pub git_common_dir: Option<String>,
    pub candidate: Option<PreparedProviderContext>,
    pub observation_request: freshell_platform::claude_inputs::observation::ObservationRequest,
}

/// Selection-only input to the fixed Claude candidate projection helper.
/// Ordinary documents stay on its verified private stage mount; credentials,
/// secret references and native provider stores are not projection inputs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaudeCandidateProjectionRequest {
    pub source_request: freshell_platform::claude_inputs::observation::ObservationRequest,
    pub workspace_path: String,
    pub provider_launch_context: ProviderLaunchContext,
    pub publication: ClaudeCandidatePublication,
}

/// Credential-free issuer metadata published beside a complete ordinary
/// Claude result. It qualifies the published generation, not a provider HOME.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaudeCandidatePublication {
    pub version: u8,
    pub soul_id: SoulId,
    pub provider: String,
    pub authority_sha256: String,
    pub initial_reservation_id: Option<String>,
    pub registry_attempt_id: Option<RecoveryAttemptId>,
    pub intent_revision: u64,
    pub prior_generation_id: Option<String>,
    pub generation_id: String,
    pub manifest_sha256: String,
    pub prepared_context_sha256: String,
    pub prepared_result_sha256: String,
    pub selector_manifest_sha256: String,
    pub plan_revision: u8,
    pub native_source_runtime: freshell_platform::claude_inputs::NativeSourceRuntime,
    pub workspace_path: String,
    pub cwd: std::path::PathBuf,
    pub git_common_dir: Option<String>,
}

/// Finite provenance supplied by the authenticated recovery callback owner.
/// The scope key itself is confined to the existing private callback channel.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaudeRecoverySourceBinding {
    pub provider: String,
    pub git_common_dir: Option<String>,
    pub authority_sha256: String,
    pub registry_attempt_id: RecoveryAttemptId,
    pub intent_revision: u64,
    pub prior_generation_id: String,
}

impl ClaudeRecoverySourceBinding {
    pub fn validate(&self) -> Result<(), RuntimeError> {
        if !matches!(self.provider.as_str(), "claude" | "kilroy")
            || self.authority_sha256.len() != 64
            || !self
                .authority_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || RecoveryAttemptId::parse(self.registry_attempt_id.as_str()).is_err()
            || self.intent_revision == 0
            || !self.prior_generation_id.starts_with("grant-")
            || uuid::Uuid::parse_str(&self.prior_generation_id[6..]).is_err()
            || self.git_common_dir.as_ref().is_some_and(|path| {
                path.len() > 64 * 1024
                    || path.chars().any(char::is_control)
                    || !std::path::Path::new(path).is_absolute()
            })
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                "Claude recovery source binding is unavailable; retain inputs and reprepare",
            ));
        }
        Ok(())
    }
}

impl ClaudeCandidateProjectionRequest {
    pub fn validate(&self) -> Result<(), RuntimeError> {
        use sha2::Digest;
        let invalid = || {
            RuntimeError::new(RuntimeErrorCode::InvalidRequest,
            "Claude candidate projection has incomplete ordinary selection metadata; retain inputs and reprepare")
        };
        self.source_request.validate().map_err(|_| invalid())?;
        self.provider_launch_context.validate("claude")?;
        let inputs = self
            .provider_launch_context
            .prepared_inputs
            .as_ref()
            .ok_or_else(invalid)?;
        if self.workspace_path.len() > 64 * 1024
            || self.workspace_path.chars().any(char::is_control)
            || !std::path::Path::new(&self.workspace_path).is_absolute()
            || !self.source_request.cwd.starts_with(&self.workspace_path)
            || inputs.manifest.source_count != 0
            || inputs.manifest.alias_count != 0
            || inputs.manifest.recipe_count != 0
            || inputs.indexed_files.is_some()
        {
            return Err(invalid());
        }
        let source = &self.source_request;
        let binding = source.candidate_binding.as_ref().ok_or_else(invalid)?;
        let published = &self.publication;
        let publication_bytes =
            bounded_json_bytes(published, MAX_CONTROL_FRAME_BYTES).map_err(|_| invalid())?;
        let context_bytes =
            bounded_json_bytes(&self.provider_launch_context, MAX_CONTROL_FRAME_BYTES)
                .map_err(|_| invalid())?;
        let initial = published.initial_reservation_id.as_ref();
        if published.version != 1
            || !matches!(published.provider.as_str(), "claude" | "kilroy")
            || (published.provider == "kilroy"
                && source.native_source_runtime
                    != freshell_platform::claude_inputs::NativeSourceRuntime::Sdk)
            || published.soul_id.as_str() != binding.soul_id
            || published.generation_id != binding.generation_id
            || published.generation_id != inputs.generation_id
            || published.manifest_sha256 != binding.manifest_sha256
            || published.manifest_sha256 != inputs.manifest.sha256
            || published.prepared_result_sha256 != binding.prepared_result_sha256
            || published.authority_sha256 != binding.authority_sha256
            || published.workspace_path != self.workspace_path
            || published.cwd != source.cwd
            || published.native_source_runtime != source.native_source_runtime
            || published.selector_manifest_sha256 != source.selector_manifest_sha256
            || published.plan_revision != source.plan_revision
            || published.intent_revision == 0
            || published.soul_id.as_str().len() > 160
            || published.soul_id.as_str().chars().any(char::is_control)
            || published.soul_id.as_str().is_empty()
            || format!("{:x}", Sha256::digest(publication_bytes)) != binding.publication_sha256
            || format!("{:x}", Sha256::digest(context_bytes)) != published.prepared_context_sha256
            || if let Some(reservation) = initial {
                published.intent_revision != 1
                    || uuid::Uuid::parse_str(reservation).is_err()
                    || inputs.initial_auth_reservation.as_ref() != initial
                    || published.registry_attempt_id.is_some()
                    || published.prior_generation_id.is_some()
            } else {
                published
                    .registry_attempt_id
                    .as_ref()
                    .is_none_or(|attempt| RecoveryAttemptId::parse(attempt.as_str()).is_err())
                    || published
                        .prior_generation_id
                        .as_ref()
                        .is_none_or(|generation| {
                            !generation.starts_with("grant-")
                                || uuid::Uuid::parse_str(&generation[6..]).is_err()
                        })
            }
            || published.git_common_dir.as_ref().is_some_and(|path| {
                path.len() > 64 * 1024
                    || path.chars().any(char::is_control)
                    || !std::path::Path::new(path).is_absolute()
            })
        {
            return Err(invalid());
        }
        bounded_json_bytes(
            source,
            freshell_platform::claude_inputs::observation::MAX_REQUEST_BYTES,
        )
        .map_err(|_| invalid())?;
        bounded_json_bytes(self, MAX_CONTROL_FRAME_BYTES).map_err(|_| invalid())?;
        Ok(())
    }
}

impl ObserveClaudeSourcesRequest {
    pub fn candidate_projection(
        &self,
        publication: ClaudeCandidatePublication,
    ) -> Result<ClaudeCandidateProjectionRequest, RuntimeError> {
        use sha2::Digest;
        self.validate()?;
        let unavailable = || {
            RuntimeError::new(
                RuntimeErrorCode::HostUnreachable,
                "Claude candidate publication binding unavailable; retain inputs and reprepare",
            )
        };
        let candidate = self.candidate.as_ref().ok_or_else(unavailable)?;
        let authority = bounded_json_bytes(&self.authority, MAX_CONTROL_FRAME_BYTES)
            .map_err(|_| unavailable())?;
        let result =
            bounded_json_bytes(candidate, MAX_CONTROL_FRAME_BYTES).map_err(|_| unavailable())?;
        if publication.soul_id != self.soul_id
            || publication.provider != self.provider
            || publication.workspace_path != self.workspace_path
            || publication.git_common_dir != self.git_common_dir
            || publication.authority_sha256 != format!("{:x}", Sha256::digest(authority))
            || publication.prepared_result_sha256 != format!("{:x}", Sha256::digest(result))
            || match &self.authority {
                ClaudeSourceAuthority::InitialReservation { reservation_id } => {
                    publication.initial_reservation_id.as_ref() != Some(reservation_id)
                }
                ClaudeSourceAuthority::RecoveryAttempt { .. } => {
                    publication.initial_reservation_id.is_some()
                }
            }
        {
            return Err(unavailable());
        }
        let projection = ClaudeCandidateProjectionRequest {
            source_request: self.observation_request.clone(),
            workspace_path: self.workspace_path.clone(),
            provider_launch_context: candidate.provider_launch_context.clone(),
            publication,
        };
        projection.validate()?;
        Ok(projection)
    }

    pub fn validate(&self) -> Result<(), RuntimeError> {
        let invalid = || {
            RuntimeError::new(RuntimeErrorCode::InvalidRequest,
            "Claude source request has invalid selection or authority; retain inputs and reprepare")
        };
        if !matches!(self.provider.as_str(), "claude" | "kilroy")
            || self.observation_request.home != std::path::Path::new("/home/freshell/provider")
        {
            return Err(invalid());
        }
        let id = match &self.authority {
            ClaudeSourceAuthority::InitialReservation { reservation_id } => reservation_id,
            ClaudeSourceAuthority::RecoveryAttempt { attempt_id } => attempt_id,
        };
        if id.len() != 36 || uuid::Uuid::parse_str(id).is_err() {
            return Err(invalid());
        }
        self.observation_request.validate().map_err(|_| invalid())?;
        for path in std::iter::once(&self.workspace_path).chain(self.git_common_dir.iter()) {
            if path.len() > 64 * 1024
                || path.chars().any(char::is_control)
                || !std::path::Path::new(path).is_absolute()
            {
                return Err(invalid());
            }
        }
        if !self
            .observation_request
            .cwd
            .starts_with(&self.workspace_path)
        {
            return Err(invalid());
        }
        if let Some(candidate) = &self.candidate {
            candidate.validate("claude")?;
            if candidate.provider_launch_context.prepared_inputs.is_none() {
                return Err(invalid());
            }
        }
        bounded_json_bytes(self, MAX_CONTROL_FRAME_BYTES).map_err(|_| invalid())?;
        Ok(())
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(transparent)]
pub struct NativeAuthValues(pub std::collections::BTreeMap<String, String>);
impl fmt::Debug for NativeAuthValues {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NativeAuthValues")
            .field("selected_count", &self.0.len())
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeView {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_identity_observation: Option<NativeIdentityObservation>,
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
    /// Original Fresh create request, persisted as the soul creation seed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fresh_agent_create_request_id: Option<String>,
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
    ProviderInputReservation(ProviderInputReservation),
    NativeAuthLookup(NativeAuthValues),
    ClaudeSourceObservation(ClaudeSourceObservation),
    ProviderPathInputsBound,
    Health {
        control_epoch: u64,
        installation_id: InstallationId,
    },
    Launch(LaunchResult),
    OpenCodeTransfer(OpenCodeTransferResult),
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
    PreflightLostSouls(RepairBatchScope),
    RestoreLostSouls(RestoreLostSoulsResult),
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
    FreshAgentHistory(serde_json::Value),
    FreshAgentSnapshot(serde_json::Value),
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
        #[serde(default, skip_serializing_if = "ProviderPathInputs::is_empty")]
        provider_path_inputs: ProviderPathInputs,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        terminal: Option<Box<TerminalLaunchSpec>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fresh_agent: Option<Box<FreshAgentLaunchSpec>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resume_spec: Option<Box<ResumeSpec>>,
        /// How long the host may spend dispatching this grant before it must
        /// reply. The supervisor waits a little longer than this for the
        /// reply, so a host that runs out refuses the grant with a typed error
        /// naming the stage it was in, instead of being abandoned mid-dispatch.
        /// Absent means the host applies no bound of its own.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        dispatch_budget_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        native_identity_launch: Option<NativeIdentityLaunch>,
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
    FreshAgentPrepareNative {
        incarnation_id: IncarnationId,
    },
    FreshAgentResumePending {
        incarnation_id: IncarnationId,
    },
    FreshAgentSend {
        incarnation_id: IncarnationId,
        request_id: RequestId,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        settings: Option<FreshAgentTurnSettings>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        checkpoint_logical_attempt_id: Option<String>,
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
    FreshAgentConfigure {
        incarnation_id: IncarnationId,
        request_id: RequestId,
        settings: FreshAgentTurnSettings,
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
    FreshAgentReadSnapshot {
        incarnation_id: IncarnationId,
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        native_identity_observation: Option<NativeIdentityObservation>,
        /// Present only when an OpenCode transfer's durable provider-reader
        /// receipt was revalidated before this grant was consumed.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        opencode_transfer_receipt: Option<OpenCodeTransferReadinessReceipt>,
        #[serde(default)]
        opencode_adoption: OpenCodeAdoptionStatus,
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        claude_fork: Option<ClaudeForkRecipe>,
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
    FreshAgentSnapshot(serde_json::Value),
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        native_identity_observation: Option<NativeIdentityObservation>,
        /// Persisted post-import and provider-reader receipt. Recovery uses it
        /// to finish the supervisor's release marker after a crash between
        /// grant acknowledgement and marker persistence.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        opencode_transfer_receipt: Option<OpenCodeTransferReadinessReceipt>,
        #[serde(default)]
        opencode_adoption: OpenCodeAdoptionStatus,
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
    #[error("control frame exceeds its byte budget")]
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
    write_frame_with_limit(writer, value, MAX_CONTROL_FRAME_BYTES).await
}

pub fn bounded_json_bytes<T: Serialize>(value: &T, limit: usize) -> Result<Vec<u8>, FrameError> {
    struct BoundedWriter {
        bytes: Vec<u8>,
        limit: usize,
        overflow: bool,
    }
    impl std::io::Write for BoundedWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            let Some(required) = self
                .bytes
                .len()
                .checked_add(bytes.len())
                .filter(|n| *n <= self.limit)
            else {
                self.overflow = true;
                return Err(std::io::Error::other("control frame exceeds limit"));
            };
            if required > self.bytes.capacity() {
                let capacity = self
                    .bytes
                    .capacity()
                    .saturating_mul(2)
                    .max(required)
                    .min(self.limit);
                self.bytes
                    .try_reserve_exact(capacity - self.bytes.len())
                    .map_err(std::io::Error::other)?;
            }
            self.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let limit = limit.min(u32::MAX as usize);
    let mut writer = BoundedWriter {
        bytes: Vec::with_capacity(limit.min(4096)),
        limit,
        overflow: false,
    };
    if let Err(error) = serde_json::to_writer(&mut writer, value) {
        return Err(if writer.overflow {
            FrameError::TooLarge
        } else {
            FrameError::Json(error)
        });
    }
    Ok(writer.bytes)
}

pub async fn write_frame_with_limit<W, T>(
    writer: &mut W,
    value: &T,
    limit: usize,
) -> Result<(), FrameError>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let bytes = bounded_json_bytes(value, limit)?;
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
    read_frame_with_limit(reader, MAX_CONTROL_FRAME_BYTES).await
}

pub async fn read_frame_with_limit<R, T>(reader: &mut R, limit: usize) -> Result<T, FrameError>
where
    R: AsyncRead + Unpin,
    T: DeserializeOwned,
{
    let mut len = [0u8; 4];
    reader.read_exact(&mut len).await?;
    let len = u32::from_be_bytes(len) as usize;
    if len > limit {
        return Err(FrameError::TooLarge);
    }
    let mut bytes = vec![0; len];
    reader.read_exact(&mut bytes).await?;
    Ok(serde_json::from_slice(&bytes)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The managed Claude `--settings` payload is BUILT by freshell-platform
    /// (`cli_launch::claude_settings_json`) but APPROVED by digest in this
    /// crate. The two once drifted (0908a4624 rewrote the bell commands
    /// without updating the approved digests) and every managed Claude launch
    /// was rejected for 10 days. This guard pins the crates together: if the
    /// recipe changes without the digest list, rust-gate fails HERE.
    #[test]
    fn approved_claude_settings_digests_track_current_recipes() {
        let mut drift = Vec::new();
        for target in [
            freshell_platform::cli_launch::ProviderTarget::Unix,
            freshell_platform::cli_launch::ProviderTarget::Windows,
        ] {
            let recipe = freshell_platform::cli_launch::claude_settings_json(target);
            let digest = format!("{:x}", sha2::Sha256::digest(recipe.as_bytes()));
            let args = vec!["--settings".to_string(), recipe];
            if validate_managed_terminal_args("claude", &args).is_err() {
                drift.push(format!("{target:?}: {digest}"));
            }
        }
        assert!(
            drift.is_empty(),
            "claude --settings recipe digests not in the approved list: \
             {drift:#?}; update APPROVED_CLAUDE_SETTINGS_DIGESTS in this \
             crate to match freshell-platform's current recipe"
        );
    }

    #[test]
    fn hosted_checkpoint_send_identity_is_optional_and_backward_compatible() {
        let request: FreshAgentSendRequest = serde_json::from_value(serde_json::json!({
            "soulId": "soul-hosted",
            "text": "continue",
            "checkpointLogicalAttemptId": "attempt-hosted-1"
        }))
        .unwrap();
        assert_eq!(
            request.checkpoint_logical_attempt_id.as_deref(),
            Some("attempt-hosted-1")
        );

        let legacy_request: FreshAgentSendRequest = serde_json::from_value(serde_json::json!({
            "soulId": "soul-hosted",
            "text": "legacy continue"
        }))
        .unwrap();
        assert_eq!(legacy_request.checkpoint_logical_attempt_id, None);
        assert_eq!(
            serde_json::to_value(&legacy_request).unwrap(),
            serde_json::json!({ "soulId": "soul-hosted", "text": "legacy continue" })
        );

        let host_command: HostCommand = serde_json::from_value(serde_json::json!({
            "method": "fresh_agent_send",
            "params": {
                "incarnation_id": "incarnation-hosted",
                "request_id": "request-hosted",
                "text": "continue",
                "checkpoint_logical_attempt_id": "attempt-hosted-1"
            }
        }))
        .unwrap();
        assert!(matches!(
            host_command,
            HostCommand::FreshAgentSend {
                checkpoint_logical_attempt_id: Some(ref id),
                ..
            } if id == "attempt-hosted-1"
        ));

        let legacy_host_command: HostCommand = serde_json::from_value(serde_json::json!({
            "method": "fresh_agent_send",
            "params": {
                "incarnation_id": "incarnation-hosted",
                "request_id": "request-hosted",
                "text": "legacy continue"
            }
        }))
        .unwrap();
        assert!(matches!(
            legacy_host_command,
            HostCommand::FreshAgentSend {
                checkpoint_logical_attempt_id: None,
                ..
            }
        ));
    }

    #[test]
    fn provider_preparation_serialization_stops_before_materializing_oversized_metadata() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        struct Many<'a>(&'a AtomicUsize);
        impl Serialize for Many<'_> {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                use serde::ser::SerializeSeq;
                let mut seq = serializer.serialize_seq(Some(100_000))?;
                for _ in 0..100_000 {
                    self.0.fetch_add(1, Ordering::SeqCst);
                    seq.serialize_element("metadata")?;
                }
                seq.end()
            }
        }
        let count = AtomicUsize::new(0);
        assert!(matches!(
            bounded_json_bytes(&Many(&count), 1024),
            Err(FrameError::TooLarge)
        ));
        assert!(
            count.load(Ordering::SeqCst) < 200,
            "oversized metadata was fully materialized before its bound"
        );
        let exact = serde_json::json!({"prepared":"metadata"});
        let bytes = serde_json::to_vec(&exact).unwrap();
        assert_eq!(bounded_json_bytes(&exact, bytes.len()).unwrap(), bytes);
    }

    #[test]
    fn runtime_errors_keep_optional_body_free_diagnostic_codes_compatible() {
        let error = RuntimeError::new(
            RuntimeErrorCode::HostUnreachable,
            "private detail must remain outside lifecycle diagnostics",
        )
        .with_diagnostic_code(RuntimeDiagnosticCode::ProviderStatePrepareFailed);
        let encoded = serde_json::to_value(&error).unwrap();
        assert_eq!(encoded["diagnosticCode"], "PROVIDER_STATE_PREPARE_FAILED");

        let provider_start = RuntimeError::new(
            RuntimeErrorCode::HostUnreachable,
            "hosted fresh-agent provider failed to start (startup diagnostic: authentication)",
        )
        .with_diagnostic_code(RuntimeDiagnosticCode::FreshAgentProviderStartFailed)
        .with_fresh_agent_provider_start_diagnostic(
            FreshAgentProviderStartDiagnostic::Authentication,
        );
        let encoded_provider_start = serde_json::to_value(provider_start).unwrap();
        assert_eq!(
            encoded_provider_start["diagnosticCode"],
            "FRESH_AGENT_PROVIDER_START_FAILED"
        );
        assert_eq!(
            encoded_provider_start["freshAgentProviderStartDiagnostic"],
            "authentication"
        );

        let old_payload = serde_json::json!({
            "code": "HOST_UNREACHABLE",
            "message": "legacy host error",
        });
        let decoded: RuntimeError = serde_json::from_value(old_payload).unwrap();
        assert_eq!(decoded.diagnostic_code, None);
        assert_eq!(decoded.fresh_agent_provider_start_diagnostic, None);

        let undecorated = serde_json::to_value(RuntimeError::new(
            RuntimeErrorCode::HostUnreachable,
            "legacy host error",
        ))
        .unwrap();
        assert!(undecorated.get("diagnosticCode").is_none());
        assert!(undecorated
            .get("freshAgentProviderStartDiagnostic")
            .is_none());
    }

    #[test]
    fn codex_prepare_diagnostics_have_stable_body_free_wire_codes() {
        let cases = [
            (
                RuntimeDiagnosticCode::CodexConfigPlanningFailed,
                "CODEX_CONFIG_PLANNING_FAILED",
            ),
            (
                RuntimeDiagnosticCode::CodexAppServerStartFailed,
                "CODEX_APP_SERVER_START_FAILED",
            ),
            (
                RuntimeDiagnosticCode::CodexProxyStartFailed,
                "CODEX_PROXY_START_FAILED",
            ),
        ];

        for (diagnostic_code, wire_code) in cases {
            let encoded = serde_json::to_value(diagnostic_code).unwrap();
            assert_eq!(encoded, wire_code);
            assert_eq!(
                serde_json::from_value::<RuntimeDiagnosticCode>(encoded).unwrap(),
                diagnostic_code
            );
        }
    }

    #[test]
    fn durable_terminal_argument_recipe_preserves_provider_options_and_legacy_modes() {
        for (provider, args) in [
            (
                "claude",
                vec!["--model", "claude-sonnet", "--session-id", "session-1"],
            ),
            (
                "codex",
                vec![
                    "-c",
                    "tui.notification_method=bel",
                    "--model",
                    "gpt-6",
                    "resume",
                    "thread-1",
                ],
            ),
            (
                "opencode",
                vec![
                    "--hostname",
                    "127.0.0.1",
                    "--port",
                    "0",
                    "--session",
                    "ses_1",
                ],
            ),
            (
                "amplifier",
                vec!["session", "resume", "--full-history", "session-1"],
            ),
        ] {
            let args = args.into_iter().map(str::to_string).collect::<Vec<_>>();
            assert_eq!(
                durable_managed_terminal_args(provider, args.clone(), None).unwrap(),
                args
            );
        }
        let legacy = vec!["--api-key".into(), "legacy-value".into()];
        assert_eq!(
            durable_managed_terminal_args("kilroy", legacy.clone(), None).unwrap(),
            legacy
        );
    }

    #[test]
    fn durable_terminal_argument_recipe_rejects_separated_and_inline_credentials() {
        for provider in ["claude", "codex", "opencode", "amplifier"] {
            for args in [
                vec!["--api-key".into(), "fixture-secret-bytes".into()],
                vec!["--api-key=fixture-secret-bytes".into()],
            ] {
                assert!(
                    durable_managed_terminal_args(provider, args, None).is_err(),
                    "{provider}"
                );
            }
        }
    }

    #[test]
    fn managed_claude_source_selector_survives_native_argument_recipe_and_rejects_unknown_sources()
    {
        for (input, selected) in [
            ("project,local", "project,local"),
            ("", ""),
            ("local, user,local", "user,local"),
        ] {
            let args = vec!["--setting-sources".into(), input.into()];
            let retained = durable_managed_terminal_args("claude", args, None).unwrap();
            assert_eq!(retained, vec!["--setting-sources", selected]);
            validate_managed_terminal_args("claude", &retained).unwrap();
        }
        let retained =
            durable_managed_terminal_args("claude", vec!["--setting-sources=project".into()], None)
                .unwrap();
        assert_eq!(retained, vec!["--setting-sources", "project"]);
        for input in ["unknown", "project,", "user,secret=value"] {
            assert!(durable_managed_terminal_args(
                "claude",
                vec!["--setting-sources".into(), input.into()],
                None
            )
            .is_err());
        }
    }

    #[test]
    fn claude_provider_native_plugin_argument_survives_durable_recipe() {
        let args = vec!["--plugin-dir".into(), "/workspace/claude-plugin".into()];
        assert_eq!(
            durable_managed_terminal_args("claude", args.clone(), None).unwrap(),
            args
        );
    }

    #[test]
    fn managed_claude_duplicate_settings_uses_only_last_native_selection() {
        use freshell_platform::claude_inputs::{
            selected_settings_argument, MANAGED_SETTINGS_ARGUMENT,
        };
        use freshell_platform::cli_launch::{claude_settings_json, ProviderTarget};
        let shipped = claude_settings_json(ProviderTarget::Unix);
        for ignored in [
            "missing-ignored-settings.json",
            "{\"env\":{\"PRIVATE_IGNORED\":\"sentinel\"}}",
        ] {
            for last in [format!("--settings={shipped}"), "--settings".into()] {
                let mut args = vec![
                    "--settings".into(),
                    ignored.into(),
                    "--init-only".into(),
                    last,
                ];
                if args.last().unwrap() == "--settings" {
                    args.push(shipped.clone());
                }
                let retained =
                    durable_managed_terminal_args("claude", args, Some(&shipped)).unwrap();
                validate_managed_terminal_args("claude", &retained).unwrap();
                assert_eq!(
                    selected_settings_argument(&retained),
                    Some(shipped.as_str())
                );
                assert!(!retained.iter().any(|arg| arg == MANAGED_SETTINGS_ARGUMENT),
                    "an ignored earlier selection must not demand private selected settings at spawn");
                assert!(!serde_json::to_string(&retained)
                    .unwrap()
                    .contains("PRIVATE_IGNORED"));
            }
        }
        let retained = durable_managed_terminal_args(
            "claude",
            vec![
                "--settings".into(),
                shipped.clone(),
                "--settings=selected-last.json".into(),
            ],
            Some(&shipped),
        )
        .unwrap();
        assert_eq!(
            selected_settings_argument(&retained),
            Some(MANAGED_SETTINGS_ARGUMENT)
        );
        assert_eq!(
            retained
                .iter()
                .filter(|arg| arg.as_str() == "--settings")
                .count(),
            1
        );
    }

    #[test]
    fn claude_native_initialization_argument_retains_selected_plugin_and_rejects_credentials() {
        let args = vec![
            "--init-only".into(),
            "--plugin-dir".into(),
            "/workspace/plugin".into(),
        ];
        assert_eq!(
            durable_managed_terminal_args("claude", args.clone(), None).unwrap(),
            args
        );
        assert!(durable_managed_terminal_args(
            "claude",
            vec![
                "--init-only".into(),
                "--api-key".into(),
                "private-value".into()
            ],
            None
        )
        .is_err());
        assert!(durable_managed_terminal_args("codex", vec!["--init-only".into()], None).is_err());
    }

    #[test]
    fn managed_claude_shipped_hook_recipe_is_accepted_and_custom_hooks_are_rejected() {
        use freshell_platform::cli_launch::{claude_settings_json, ProviderTarget};
        for target in [ProviderTarget::Unix, ProviderTarget::Windows] {
            let settings = claude_settings_json(target);
            assert!(validate_managed_terminal_args(
                "claude",
                &["--settings".into(), settings.clone()]
            )
            .is_ok());
            let mut changed: serde_json::Value = serde_json::from_str(&settings).unwrap();
            changed["hooks"]["Stop"][0]["hooks"][0]["command"] =
                serde_json::json!("echo PRIVATE_UNAPPROVED_HOOK");
            let error = validate_managed_terminal_args(
                "claude",
                &["--settings".into(), changed.to_string()],
            )
            .unwrap_err();
            assert!(!error.message.contains("PRIVATE_UNAPPROVED_HOOK"));
            changed = serde_json::from_str(&settings).unwrap();
            changed["env"] = serde_json::json!({"API_KEY":"PRIVATE_UNAPPROVED_SETTING"});
            assert!(validate_managed_terminal_args(
                "claude",
                &["--settings".into(), changed.to_string()]
            )
            .is_err());
        }
    }

    #[test]
    fn ids_reject_control_characters_and_are_distinct() {
        assert!(SoulId::parse("bad\nvalue").is_err());
        assert_ne!(SoulId::new(), SoulId::new());
    }

    #[test]
    fn stopped_repair_exact_batch_nine() {
        let members = (0..9)
            .map(|index| RepairBatchTarget {
                target: LostSoulRepairTarget {
                    soul_id: SoulId::parse(format!("soul-fixture-{index}")).unwrap(),
                    incident_id: IncidentId::parse(format!("incident-fixture-{index}")).unwrap(),
                    expected_intent_revision: 2,
                },
                root_session_id: format!("ses_fixture_root_{}", index % 7),
                provider_store_id: format!("store-fixture-{index}"),
                incident_revision: 1,
                identity_revision: 0,
                native_import_revision: 0,
                evidence_revision: 0,
            })
            .collect::<Vec<_>>();
        let mut scope = RepairBatchScope {
            scope_id: String::new(),
            source_store_id: "a".repeat(64),
            source_fingerprint: "b".repeat(64),
            targets: members,
            roots: (0..7)
                .map(|index| RepairBatchRoot {
                    root_session_id: format!("ses_fixture_root_{index}"),
                    graph_digest: "c".repeat(64),
                    eligible_owners: vec![SoulId::parse(format!("soul-fixture-{index}")).unwrap()],
                    canonical_soul_id: None,
                })
                .collect(),
        };
        scope.source_fingerprint = scope.source_descriptor_digest();
        scope.scope_id = scope.descriptor_digest();
        let request = RestoreLostSoulsRequest {
            scope_id: scope.scope_id.clone(),
            source: scope.source_selection(),
            targets: scope
                .targets
                .iter()
                .map(|member| member.target.clone())
                .collect(),
            canonical_owners: Vec::new(),
            expected_control_epoch: Some(1),
        };
        assert!(request.validate_exact_batch(&scope).is_ok());
        let mut eight = request.clone();
        eight.targets.pop();
        assert!(eight.validate_exact_batch(&scope).is_err());
        let mut ten = request.clone();
        let mut tenth = scope.targets[0].clone();
        tenth.target.soul_id = SoulId::parse("soul-fixture-tenth").unwrap();
        tenth.target.incident_id = IncidentId::parse("incident-fixture-tenth").unwrap();
        ten.targets.push(tenth.target.clone());
        assert!(ten.validate_exact_batch(&scope).is_err());
        let mut fresh_scope = scope.clone();
        fresh_scope.targets.push(tenth);
        fresh_scope.source_fingerprint = fresh_scope.source_descriptor_digest();
        fresh_scope.scope_id = fresh_scope.descriptor_digest();
        ten.scope_id = fresh_scope.scope_id.clone();
        assert!(ten.validate_exact_batch(&fresh_scope).is_ok());
        for mutate in [
            |request: &mut RestoreLostSoulsRequest| {
                request.targets[1].soul_id = request.targets[0].soul_id.clone();
            },
            |request: &mut RestoreLostSoulsRequest| {
                request.targets[1].incident_id = request.targets[0].incident_id.clone();
            },
            |request: &mut RestoreLostSoulsRequest| {
                request.targets[0].expected_intent_revision += 1;
            },
            |request: &mut RestoreLostSoulsRequest| {
                request.source.root_session_ids.pop();
            },
            |request: &mut RestoreLostSoulsRequest| {
                request.source.source_store_id = "d".repeat(64);
            },
            |request: &mut RestoreLostSoulsRequest| {
                request.scope_id = "e".repeat(64);
            },
        ] {
            let mut invalid = request.clone();
            mutate(&mut invalid);
            assert!(invalid.validate_exact_batch(&scope).is_err());
        }
    }

    #[test]
    fn stopped_repair_request_rejects_caller_supplied_paths_and_payloads() {
        let valid = serde_json::json!({
            "scopeId": "a".repeat(64),
            "source": {
                "sourceStoreId": "b".repeat(64),
                "rootSessionIds": ["ses_fixture_root"]
            },
            "targets": (0..8).map(|_| serde_json::json!({
                "soulId": SoulId::new(),
                "incidentId": IncidentId::new(),
                "expectedIntentRevision": 1
            })).collect::<Vec<_>>(),
            "expectedControlEpoch": 1
        });
        let request: RestoreLostSoulsRequest = serde_json::from_value(valid.clone())
            .expect("a request without caller-supplied paths or payloads must deserialize");
        request.validate_payload().unwrap();
        for (field, supplied) in [
            ("nativePath", serde_json::json!("/must/not/be/accepted")),
            (
                "nativePayload",
                serde_json::json!({"messages": [{"role": "user", "content": "caller supplied"}]}),
            ),
        ] {
            let mut invalid = valid.clone();
            invalid["targets"][0][field] = supplied;
            assert!(
                serde_json::from_value::<RestoreLostSoulsRequest>(invalid).is_err(),
                "caller-supplied {field} must be rejected"
            );
        }
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
        assert_eq!(spec.fixture_transport, None);
        assert_eq!(spec.provider_volume, None);
        assert_eq!(spec.identity_provenance, IdentityProvenance::Unknown);
        assert_eq!(spec.durable_position, DurablePosition::default());
        assert!(spec.credential_references.is_empty());
        assert!(spec.checkpoint_references.is_empty());
    }

    #[test]
    fn recovery_contract_serializes_references_not_credential_bytes() {
        let spec = ResumeSpec {
            claude_fork: None,
            schema_version: RESUME_SPEC_SCHEMA_VERSION,
            provider_session: ProviderSessionRef {
                provider: "claude".into(),
                provider_store_id: "store-one".into(),
                native_session_id: "session-one".into(),
            },
            mode: "claude".into(),
            runtime_variant: "managed_terminal_pty".into(),
            fixture_transport: None,
            opencode_adoption_baseline: None,
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
    fn recovery_negative_wire_preserves_inspected_rows_and_defaults_legacy_unknown() {
        let legacy = serde_json::json!({"kind":"definitively_unavailable","data":{
            "path":"native_resume","reason":"old absence","evidence":["store"],"store_state":"missing"
        }});
        let mut probe: RecoveryProbe = serde_json::from_value(legacy).unwrap();
        let RecoveryProbe::DefinitivelyUnavailable { negative_paths, .. } = &mut probe else {
            panic!("wrong probe")
        };
        assert!(
            negative_paths.is_empty(),
            "legacy wire must not invent inspection"
        );
        negative_paths.push(RecoveryPathEvidence {
            path: RecoveryPath::CheckpointRestore,
            verdict: RecoveryEvidenceVerdict::DefinitiveNegative,
            reason_code: "EXACT_SQLITE_NO_MATCH".into(),
            evidence_refs: vec!["provider://effective.db/exact-session".into()],
            store_state: EvidenceStoreState::PresentReadable,
        });
        let decoded: RecoveryProbe =
            serde_json::from_slice(&serde_json::to_vec(&probe).unwrap()).unwrap();
        assert_eq!(
            decoded, probe,
            "typed inspection must survive the host IPC wire"
        );
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
            provider_launch_context: None,
            opencode_transfer: None,
            opencode_transfer_attempt_id: None,
            opencode_adoption: None,
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
            plugins: None,
            model_selection: None,
            session_ref: None,
            fixture_transport: None,
            provider_bootstrap_files: Vec::new(),
            provider_secret_references: Vec::new(),
            provider_launch_context: None,
        }
    }

    #[test]
    fn kilroy_accepts_only_its_native_claude_context_and_grants_without_changing_mode() {
        let mut launch = fresh_agent_launch(FreshProvider::Kilroy, "kilroy");
        launch.provider_launch_context = Some(ProviderLaunchContext {
            prepared_inputs: None,
            preparation: ProviderPreparation::Claude {
                mcp_args: Vec::new(),
            },
            mcp_capability: None,
            config: Vec::new(),
        });
        launch.provider_secret_references = vec![
            ProviderSecretReference {
                source_path: "/private/claude.env".into(),
                profile: ProviderSecretProfile::ClaudeOnecliEnvironment,
                provider_relative_path: None,
            },
            ProviderSecretReference {
                source_path: "/private/claude-ca.pem".into(),
                profile: ProviderSecretProfile::ClaudeOnecliCaFile,
                provider_relative_path: None,
            },
        ];
        assert!(launch.validate().is_ok());
        assert_eq!(launch.provider.as_str(), "kilroy");
        assert_eq!(launch.session_type, "kilroy");
        let mut wrong = launch.clone();
        wrong.provider_secret_references[0].profile = ProviderSecretProfile::CodexOnecliEnvironment;
        assert!(wrong.validate().is_err());
        wrong = launch.clone();
        wrong.provider_launch_context.as_mut().unwrap().preparation = ProviderPreparation::Codex {
            tui_args: Vec::new(),
            sidecar_args: Vec::new(),
        };
        assert!(wrong.validate().is_err());
        launch.provider_bootstrap_files.push(ProviderBootstrapFile {
            source_path: "/private/legacy-auth".into(),
            provider_relative_path: ".claude/.credentials.json".into(),
        });
        assert!(launch.validate().is_ok());
        launch.provider = FreshProvider::Claude;
        launch.session_type = "freshclaude".into();
        assert!(launch.validate().is_err());
        launch.provider_bootstrap_files.clear();
        assert!(launch.validate().is_ok());
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
            claude_fork: None,
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
    fn fresh_kilroy_consumes_claude_recipes_without_changing_runtime_identity() {
        let mut launch = fresh_agent_launch(FreshProvider::Kilroy, "kilroy");
        let context = ProviderLaunchContext {
            preparation: ProviderPreparation::Claude {
                mcp_args: Vec::new(),
            },
            prepared_inputs: None,
            mcp_capability: None,
            config: Vec::new(),
        };
        assert!(context.validate("kilroy").is_err());
        launch.provider_launch_context = Some(context);
        launch.provider_secret_references = vec![ProviderSecretReference {
            source_path: "/synthetic/private/claude-environment".into(),
            profile: ProviderSecretProfile::ClaudeOnecliEnvironment,
            provider_relative_path: None,
        }];
        launch.validate().unwrap();
        let retained: FreshAgentLaunchSpec =
            serde_json::from_slice(&serde_json::to_vec(&launch).unwrap()).unwrap();
        assert_eq!(retained.provider, FreshProvider::Kilroy);
        assert_eq!(retained.session_type, "kilroy");
        assert_eq!(retained.native_session_id.as_deref(), Some("native-one"));
        assert_eq!(retained, launch);
        launch.provider = FreshProvider::Codex;
        launch.session_type = "freshcodex".into();
        assert!(launch.validate().is_err());
        launch.provider_launch_context = None;
        assert!(launch.validate().is_err());
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

        let mut unsafe_agent = fresh_agent_launch(FreshProvider::Kilroy, "kilroy");
        unsafe_agent
            .provider_bootstrap_files
            .push(ProviderBootstrapFile {
                source_path: "/credential-reference-only".into(),
                provider_relative_path: ".provider/config.json".into(),
            });
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

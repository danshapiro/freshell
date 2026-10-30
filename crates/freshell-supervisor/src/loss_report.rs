//! Certified managed-soul loss decisions and durable incident export.
//!
//! A loss decision is deliberately harder to construct than an ordinary
//! recovery result. The constructor consumes the provider capability
//! manifest's complete path inventory and refuses every unknown, unreadable,
//! ambiguous, viable, or unimplemented path. The resulting certificate
//! contains only hashes/references for provider-native identity and can be
//! committed before exact cleanup begins.

use crate::{
    notice_outbox::{enqueue_notice_in_tx, increment_counter_in_tx, millis_to_timestamp},
    registry::{
        load_owned_handle, NativeImportState, OwnedRuntimeHandle, RecoveryContext, Registry,
        RegistryError,
    },
    view_intents::{enqueue_projection, load_view_intent},
};
use freshell_agent_runtime::{managed_recovery_enabled, recovery_paths};
use freshell_runtime_observability::{
    atomic_write_redacted_json, now_rfc3339_millis, RotatingJsonlWriter,
};
use freshell_runtime_protocol::{
    CleanupDecisionEvidence, CorrelationId, DesiredState, EvidenceStoreState, IncidentAnalysis,
    IncidentId, IncidentTimelineEvent, InstallationId, LossBuildEvidence, LossCleanupReport,
    LossDecisionState, LossDecisionSummary, LostDecisionCertificate, NoticeKind,
    RecoveryEvidenceVerdict, RecoveryPath, RecoveryPathEvidence, RecoveryState, RuntimeNotice,
    StopOutcome, LOSS_REPORT_SCHEMA_VERSION,
};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::PathBuf,
    sync::{Mutex, MutexGuard},
    time::{Duration, SystemTime},
};

pub const INCIDENT_RETENTION_DAYS: u64 = 90;
pub const INCIDENT_RETENTION_COUNT: usize = 1_000;
pub const INCIDENT_RETENTION_BYTES: u64 = 100 * 1024 * 1024;
pub const INCIDENT_LOG_MAX_BYTES: u64 = 10 * 1024 * 1024;
pub const INCIDENT_LOG_BACKUPS: u32 = 4;

static INCIDENT_FILE_COORDINATOR: Mutex<()> = Mutex::new(());

pub(crate) fn incident_file_coordinator() -> MutexGuard<'static, ()> {
    INCIDENT_FILE_COORDINATOR
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Remove only JSONL records that carry one of the exact incident IDs.
///
/// A malformed record cannot be classified without risking unrelated data,
/// so it fails closed and leaves the caller's artifact untouched.
pub(crate) fn filter_incident_jsonl(
    bytes: &[u8],
    incident_ids: &std::collections::BTreeSet<String>,
) -> std::io::Result<Vec<u8>> {
    use std::io::{Error, ErrorKind};

    fn names_target_incident(value: &serde_json::Value, targets: &BTreeSet<String>) -> bool {
        match value {
            serde_json::Value::Object(object) => object.iter().any(|(key, value)| {
                let is_singular = matches!(key.as_str(), "incidentId" | "incident_id");
                let is_plural = matches!(key.as_str(), "incidentIds" | "incident_ids");
                let direct_match = if is_singular {
                    value.as_str().is_some_and(|value| targets.contains(value))
                } else if is_plural {
                    value.as_array().is_some_and(|values| {
                        values
                            .iter()
                            .any(|value| value.as_str().is_some_and(|id| targets.contains(id)))
                    })
                } else {
                    false
                };
                direct_match || names_target_incident(value, targets)
            }),
            serde_json::Value::Array(values) => values
                .iter()
                .any(|value| names_target_incident(value, targets)),
            _ => false,
        }
    }

    fn validate_incident_fields(value: &serde_json::Value) -> bool {
        match value {
            serde_json::Value::Object(object) => object.iter().all(|(key, value)| {
                let valid_field = match key.as_str() {
                    "incidentId" | "incident_id" => value.is_string(),
                    "incidentIds" | "incident_ids" => value
                        .as_array()
                        .is_some_and(|values| values.iter().all(serde_json::Value::is_string)),
                    _ => true,
                };
                valid_field && validate_incident_fields(value)
            }),
            serde_json::Value::Array(values) => values.iter().all(validate_incident_fields),
            _ => true,
        }
    }

    let mut filtered = Vec::with_capacity(bytes.len());
    for (index, raw_line) in bytes.split_inclusive(|byte| *byte == b'\n').enumerate() {
        let line = raw_line
            .strip_suffix(b"\n")
            .unwrap_or(raw_line)
            .strip_suffix(b"\r")
            .unwrap_or_else(|| raw_line.strip_suffix(b"\n").unwrap_or(raw_line));
        if line.iter().all(u8::is_ascii_whitespace) {
            filtered.extend_from_slice(raw_line);
            continue;
        }
        let value: serde_json::Value = serde_json::from_slice(line).map_err(|error| {
            Error::new(
                ErrorKind::InvalidData,
                format!(
                    "incident JSONL record {} is unclassifiable: {error}",
                    index + 1
                ),
            )
        })?;
        if !validate_incident_fields(&value) {
            return Err(Error::new(
                ErrorKind::InvalidData,
                format!(
                    "incident JSONL record {} has an invalid incident reference",
                    index + 1
                ),
            ));
        }
        if !names_target_incident(&value, incident_ids) {
            filtered.extend_from_slice(raw_line);
        }
    }
    Ok(filtered)
}

#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
pub enum LossDecisionError {
    #[error("loss certification requires the durable desired state to remain RUNNING")]
    StopIntent,
    #[error("loss certification cannot run for an already terminal soul")]
    AlreadyTerminal,
    #[error("loss certification requires a previously verified materialized identity")]
    UnverifiedMaterialization,
    #[error("loss certification requires an exact provider-native identity")]
    MissingNativeIdentity,
    #[error("pristine-seed recovery is still available because no input was dispatched")]
    PristineSeedAvailable,
    #[error("a verified native resume specification is still available")]
    NativeResumeAvailable,
    #[error("a checkpoint revision is retained and its restoration state is unresolved")]
    CheckpointAvailableOrUnknown,
    #[error("native import source state is incomplete or unresolved")]
    NativeImportAvailableOrUnknown,
    #[error("provider {0} has no managed recovery capability inventory")]
    MissingCapability(String),
    #[error("provider {0} is not enabled for managed runtime ownership")]
    DisabledProvider(String),
    #[error("applicable recovery path inventory does not match the provider manifest")]
    IncompletePathInventory,
    #[error("recovery path {0} did not produce exactly one definitive-negative record")]
    MissingPathEvidence(&'static str),
    #[error("recovery path {0} retained unknown or unreadable evidence")]
    UnknownPathEvidence(&'static str),
    #[error("recovery path {0} has no durable evidence reference")]
    MissingEvidenceReference(&'static str),
    #[error("cleanup authority is not the exact registry-owned prior incarnation")]
    UnsafeCleanupAuthority,
    #[error("incident analysis field {0} is empty")]
    MissingAnalysis(&'static str),
}

#[derive(Debug, Clone)]
pub struct LossDecisionInput<'a> {
    pub installation_id: &'a InstallationId,
    pub context: &'a RecoveryContext,
    pub cleanup_handle: &'a OwnedRuntimeHandle,
    pub path_evidence: Vec<RecoveryPathEvidence>,
    pub builds: LossBuildEvidence,
    pub timeline: Vec<IncidentTimelineEvent>,
    pub analysis: IncidentAnalysis,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LostDecision {
    certificate: LostDecisionCertificate,
    capture: LossDecisionCapture,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LossDecisionCapture {
    allocation_state: freshell_runtime_protocol::AllocationState,
    control_epoch: u64,
    identity_revision: u64,
    evidence_revision: u64,
    native_import_revision: u64,
    native_import_state: NativeImportState,
    native_import_source_store_id: Option<String>,
    native_import_root_session_id: Option<String>,
    native_import_source_generation: Option<String>,
    native_import_schema_fingerprint: Option<String>,
    native_import_migration_fingerprint: Option<String>,
    native_import_complete_inventory: bool,
    native_import_authority: String,
    recovery_attempt_id: Option<String>,
}

type LossCaptureValidationRow = (
    String,
    String,
    Option<String>,
    String,
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
    u64,
    String,
    Option<String>,
);

type LossIncidentCleanupRow = (
    String,
    String,
    String,
    String,
    String,
    Option<u64>,
    Option<u64>,
    Option<u64>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<bool>,
    Option<String>,
);

type LossSoulCleanupRow = (
    String,
    u64,
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
    bool,
    String,
);

impl LostDecision {
    pub fn try_new(input: LossDecisionInput<'_>) -> Result<Self, LossDecisionError> {
        Self::try_new_with_current_census(input, None)
    }

    // Only the supervisor supplies container evidence here, after its current
    // authenticated/owned-volume reader. Public callers must inspect locally.
    pub(crate) fn try_new_with_current_census(
        input: LossDecisionInput<'_>,
        current_native_census: Option<&[String]>,
    ) -> Result<Self, LossDecisionError> {
        let context = input.context;
        if context.desired_state != DesiredState::Running {
            return Err(LossDecisionError::StopIntent);
        }
        if matches!(
            context.recovery_state,
            RecoveryState::Lost | RecoveryState::Stopped
        ) {
            return Err(LossDecisionError::AlreadyTerminal);
        }
        // Shell never materializes a provider-native identity. Its durable
        // dispatch journal, together with the reattach/seed path inventory,
        // qualifies a non-resumable terminal end instead of native loss.
        if context.provider == "shell" {
            if context.dispatched_command_count == 0 {
                return Err(LossDecisionError::PristineSeedAvailable);
            }
        } else if context.allocation_state
            != freshell_runtime_protocol::AllocationState::VerifiedDurable
        {
            return Err(LossDecisionError::UnverifiedMaterialization);
        }
        if context.provider != "shell"
            && context
                .native_session_id
                .as_deref()
                .is_none_or(|id| id.trim().is_empty())
        {
            return Err(LossDecisionError::MissingNativeIdentity);
        }
        if !context.native_import_is_definitively_negative() {
            return Err(LossDecisionError::NativeImportAvailableOrUnknown);
        }
        if context.never_dispatched {
            return Err(LossDecisionError::PristineSeedAvailable);
        }
        // A persisted resume specification is an identity/argv contract, not
        // proof that its referenced provider state still exists. The typed
        // NativeResume path evidence below decides viability; a present spec
        // cannot override a fresh, definitive missing-store probe.
        // A recorded checkpoint revision is only a locator. The complete,
        // freshly evaluated CheckpointRestore path evidence below determines
        // whether the referenced checkpoint is still present and verified.
        if input.cleanup_handle.soul_id() != &context.soul_id
            || input.cleanup_handle.incarnation_id() != context.prior_handle.incarnation_id()
            || input.cleanup_handle.installation_id() != input.installation_id
        {
            return Err(LossDecisionError::UnsafeCleanupAuthority);
        }

        let applicable_paths = recovery_paths(&context.provider)
            .ok_or_else(|| LossDecisionError::MissingCapability(context.provider.clone()))?;
        if !managed_recovery_enabled(&context.provider) {
            return Err(LossDecisionError::DisabledProvider(
                context.provider.clone(),
            ));
        }
        validate_path_inventory(applicable_paths, &input.path_evidence)?;
        validate_native_absence(context, &input.path_evidence)?;
        if context.provider != "shell" {
            let native = input
                .path_evidence
                .iter()
                .find(|row| row.path == RecoveryPath::NativeResume)
                .ok_or(LossDecisionError::UnknownPathEvidence("native_resume"))?;
            if !freshell_agent_runtime::native_absence_census_current(&native.evidence_refs)
                && current_native_census.is_none_or(|current| {
                    !freshell_agent_runtime::same_native_absence_census(
                        &native.evidence_refs,
                        current,
                    )
                })
            {
                return Err(LossDecisionError::UnknownPathEvidence("native_resume"));
            }
        }
        validate_analysis(&input.analysis)?;

        let state = if context.provider == "shell" {
            LossDecisionState::NonResumableTerminalEnded
        } else {
            LossDecisionState::Lost
        };
        let reason_code = match state {
            LossDecisionState::Lost => "all_applicable_recovery_paths_definitively_unavailable",
            LossDecisionState::NonResumableTerminalEnded => {
                "non_resumable_terminal_ended_after_dispatch"
            }
        };
        let incident_id = IncidentId::new();
        let correlation_id = CorrelationId::new();
        let created_at = input.created_at.unwrap_or_else(now_rfc3339_millis);
        let native_session_ref_hash = hash_native_session_reference(
            &context.provider,
            &context.provider_store_id,
            context.native_session_id.as_deref(),
        );
        let certificate = LostDecisionCertificate {
            schema_version: LOSS_REPORT_SCHEMA_VERSION,
            event: "soul.loss.finalized".into(),
            incident_id,
            correlation_id,
            installation_id: input.installation_id.clone(),
            soul_id: context.soul_id.clone(),
            provider: context.provider.clone(),
            provider_store_id: context.provider_store_id.clone(),
            native_session_ref_hash,
            intent_revision: context.intent_revision,
            incarnations: vec![context.prior_handle.incarnation_id().clone()],
            builds: input.builds,
            timeline: input.timeline,
            recovery_paths: input.path_evidence,
            decision: LossDecisionSummary {
                state,
                reason_code: reason_code.into(),
                unknown_paths: 0,
                retained_recoverable_evidence: false,
            },
            cleanup_target: CleanupDecisionEvidence {
                owned_handle_ref: format!(
                    "registry://installation/{}/soul/{}/incarnation/{}",
                    input.installation_id,
                    context.soul_id,
                    context.prior_handle.incarnation_id()
                ),
                ownership_verified: true,
                incarnation_id: context.prior_handle.incarnation_id().clone(),
            },
            analysis: input.analysis,
            created_at,
        };
        Ok(Self {
            certificate,
            capture: LossDecisionCapture {
                allocation_state: context.allocation_state,
                control_epoch: context.control_epoch,
                identity_revision: context.identity_revision,
                evidence_revision: context.evidence_revision,
                native_import_revision: context.native_import_revision,
                native_import_state: context.native_import_state,
                native_import_source_store_id: context.native_import_source_store_id.clone(),
                native_import_root_session_id: context.native_import_root_session_id.clone(),
                native_import_source_generation: context.native_import_source_generation.clone(),
                native_import_schema_fingerprint: context.native_import_schema_fingerprint.clone(),
                native_import_migration_fingerprint: context
                    .native_import_migration_fingerprint
                    .clone(),
                native_import_complete_inventory: context.native_import_complete_inventory,
                native_import_authority: context.native_import_authority.clone(),
                recovery_attempt_id: context
                    .recovery_attempt_id
                    .as_ref()
                    .map(ToString::to_string),
            },
        })
    }

    pub fn certificate(&self) -> &LostDecisionCertificate {
        &self.certificate
    }

    pub fn into_certificate(self) -> LostDecisionCertificate {
        self.certificate
    }
}

fn validate_loss_capture(
    tx: &rusqlite::Transaction<'_>,
    certificate: &LostDecisionCertificate,
    capture: &LossDecisionCapture,
) -> Result<(), RegistryError> {
    let (
        provider,
        store,
        native_session_id,
        allocation_state,
        identity_revision,
        evidence_revision,
        native_import_revision,
        native_import_state,
        native_import_source_store_id,
        native_import_root_session_id,
        native_import_source_generation,
        native_import_schema_fingerprint,
        native_import_migration_fingerprint,
        native_import_complete_inventory,
        native_import_authority,
        recovery_attempt_id,
        control_epoch,
        recovery_state,
        current_incident,
    ): LossCaptureValidationRow = tx
        .query_row(
            "SELECT provider,provider_store_id,native_session_id,allocation_state,identity_revision,evidence_revision,native_import_revision,native_import_state,native_import_source_store_id,native_import_root_session_id,native_import_source_generation,native_import_schema_fingerprint,native_import_migration_fingerprint,native_import_complete_inventory,native_import_authority,recovery_attempt_id,installation.control_epoch,recovery_state,loss_incident_id \
             FROM souls JOIN installation ON installation.singleton=1 WHERE soul_id=?1",
            params![certificate.soul_id.as_str()],
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
                ))
            },
        )
        .optional()?
        .ok_or_else(|| RegistryError::UnknownSoul(certificate.soul_id.clone()))?;
    if provider != "shell"
        && !certificate.recovery_paths.iter().any(|row| {
            row.path == RecoveryPath::NativeResume
                && freshell_agent_runtime::native_absence_census_matches(
                    &provider,
                    &store,
                    native_session_id.as_deref().unwrap_or(""),
                    evidence_revision,
                    row.store_state,
                    &row.evidence_refs,
                )
        })
    {
        return Err(RegistryError::LossCertificationBlocked(
            "native absence census is unqualified or stale".into(),
        ));
    }
    let native_session_hash =
        hash_native_session_reference(&provider, &store, native_session_id.as_deref());
    let import_capture_matches = native_import_state == capture.native_import_state.as_str()
        && native_import_source_store_id == capture.native_import_source_store_id
        && native_import_root_session_id == capture.native_import_root_session_id
        && native_import_source_generation == capture.native_import_source_generation
        && native_import_schema_fingerprint == capture.native_import_schema_fingerprint
        && native_import_migration_fingerprint == capture.native_import_migration_fingerprint
        && native_import_complete_inventory == capture.native_import_complete_inventory
        && native_import_authority == capture.native_import_authority;
    let attempt_matches = recovery_attempt_id.as_deref() == capture.recovery_attempt_id.as_deref()
        || (recovery_state == "lost"
            && current_incident.as_deref() == Some(certificate.incident_id.as_str())
            && recovery_attempt_id.is_none());
    let materialization_qualified = if provider == "shell" {
        // Recheck the real journal in the incident-before-cleanup transaction;
        // a shell's allocated state alone never authorizes a terminal end.
        tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM input_commands WHERE soul_id=?1 AND state IN ('dispatching','completed','ambiguous'))",
            params![certificate.soul_id.as_str()],
            |row| row.get::<_, bool>(0),
        )?
    } else {
        capture.allocation_state == freshell_runtime_protocol::AllocationState::VerifiedDurable
            && native_session_id
                .as_deref()
                .is_some_and(|id| !id.trim().is_empty())
    };
    let allocation_state: freshell_runtime_protocol::AllocationState =
        serde_json::from_value(serde_json::Value::String(allocation_state))?;
    if !materialization_qualified
        || allocation_state != capture.allocation_state
        || control_epoch != capture.control_epoch
        || identity_revision != capture.identity_revision
        || evidence_revision != capture.evidence_revision
        || native_import_revision != capture.native_import_revision
        || !import_capture_matches
        || !attempt_matches
        || provider != certificate.provider
        || store != certificate.provider_store_id
        || native_session_hash != certificate.native_session_ref_hash
    {
        return Err(RegistryError::LossCertificationBlocked(
            "materialization or provider identity changed during loss certification".into(),
        ));
    }
    Ok(())
}

fn validate_path_inventory(
    applicable_paths: &[RecoveryPath],
    evidence: &[RecoveryPathEvidence],
) -> Result<(), LossDecisionError> {
    let applicable = path_multiset(applicable_paths.iter().copied());
    let observed = path_multiset(evidence.iter().map(|row| row.path));
    if applicable != observed {
        return Err(LossDecisionError::IncompletePathInventory);
    }
    for path in applicable_paths {
        let rows: Vec<_> = evidence.iter().filter(|row| row.path == *path).collect();
        if rows.len() != 1 || rows[0].verdict != RecoveryEvidenceVerdict::DefinitiveNegative {
            return Err(LossDecisionError::MissingPathEvidence(path_name(*path)));
        }
        let row = rows[0];
        if matches!(
            row.store_state,
            EvidenceStoreState::Unknown | EvidenceStoreState::PresentUnreadable
        ) {
            return Err(LossDecisionError::UnknownPathEvidence(path_name(*path)));
        }
        if row.evidence_refs.is_empty()
            || row.evidence_refs.iter().any(|item| item.trim().is_empty())
        {
            return Err(LossDecisionError::MissingEvidenceReference(path_name(
                *path,
            )));
        }
    }
    Ok(())
}

pub(crate) fn validate_native_absence(
    context: &RecoveryContext,
    paths: &[RecoveryPathEvidence],
) -> Result<(), LossDecisionError> {
    if context.provider == "shell" {
        return Ok(());
    }
    context
        .native_session_id
        .as_deref()
        .filter(|id| !id.trim().is_empty())
        .ok_or(LossDecisionError::MissingNativeIdentity)?;
    if !paths.iter().any(|row| {
        row.path == RecoveryPath::NativeResume
            && row.verdict == RecoveryEvidenceVerdict::DefinitiveNegative
            && native_absence_matches(context, row.store_state, &row.evidence_refs)
    }) {
        return Err(LossDecisionError::UnknownPathEvidence("native_resume"));
    }
    Ok(())
}

pub(crate) fn native_absence_matches(
    context: &RecoveryContext,
    store_state: EvidenceStoreState,
    evidence: &[String],
) -> bool {
    if context.provider == "shell" {
        return true;
    }
    if let Ok(Some(spec)) = crate::resume_catalog::exact_resume_candidate(context, None) {
        if !freshell_agent_runtime::native_absence_census_environment_matches(&spec, evidence) {
            return false;
        }
    }
    matches!(
        store_state,
        EvidenceStoreState::Missing | EvidenceStoreState::PresentReadable
    ) && context
        .native_session_id
        .as_deref()
        .filter(|id| !id.trim().is_empty())
        .is_some_and(|id| {
            freshell_agent_runtime::native_absence_census_matches(
                &context.provider,
                &context.provider_store_id,
                id,
                context.evidence_revision,
                store_state,
                evidence,
            )
        })
}

fn validate_analysis(analysis: &IncidentAnalysis) -> Result<(), LossDecisionError> {
    for (name, value) in [
        ("observed_cause", analysis.observed_cause.as_str()),
        ("missing_invariant", analysis.missing_invariant.as_str()),
        ("preventive_action", analysis.preventive_action.as_str()),
        ("regression_case", analysis.regression_case.as_str()),
    ] {
        if value.trim().is_empty() {
            return Err(LossDecisionError::MissingAnalysis(name));
        }
    }
    Ok(())
}

fn path_multiset(paths: impl Iterator<Item = RecoveryPath>) -> BTreeMap<&'static str, usize> {
    let mut counts = BTreeMap::new();
    for path in paths {
        *counts.entry(path_name(path)).or_insert(0) += 1;
    }
    counts
}

pub fn path_name(path: RecoveryPath) -> &'static str {
    match path {
        RecoveryPath::Reattach => "reattach",
        RecoveryPath::NativeResume => "native_resume",
        RecoveryPath::CheckpointRestore => "checkpoint_restore",
        RecoveryPath::PristineSeed => "pristine_seed",
        RecoveryPath::NativeImport => "native_import",
    }
}

pub fn hash_native_session_reference(
    provider: &str,
    provider_store_id: &str,
    native_session_id: Option<&str>,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"freshell-loss-native-session-v1\0");
    hasher.update(provider.as_bytes());
    hasher.update(b"\0");
    hasher.update(provider_store_id.as_bytes());
    hasher.update(b"\0");
    hasher.update(native_session_id.unwrap_or("<none>").as_bytes());
    format!("sha256:{:x}", hasher.finalize())
}

pub fn hash_loss_certificate(certificate: &LostDecisionCertificate) -> String {
    let encoded = serde_json::to_vec(certificate).expect("loss certificate is serializable");
    format!("{:x}", Sha256::digest(encoded))
}

#[derive(Clone)]
pub struct IncidentExporter {
    root: PathBuf,
    process_secret: String,
}

impl IncidentExporter {
    pub fn new(root: impl Into<PathBuf>, process_secret: impl Into<String>) -> Self {
        Self {
            root: root.into(),
            process_secret: process_secret.into(),
        }
    }

    pub fn export_certificate(
        &self,
        certificate: &LostDecisionCertificate,
    ) -> std::io::Result<PathBuf> {
        let _coordinator = incident_file_coordinator();
        self.export_certificate_coordinated(certificate)
    }

    pub(crate) fn export_certificate_coordinated(
        &self,
        certificate: &LostDecisionCertificate,
    ) -> std::io::Result<PathBuf> {
        fs::create_dir_all(&self.root)?;
        fs::set_permissions(&self.root, std::fs::Permissions::from_mode(0o700))?;
        let path = self
            .root
            .join(format!("{}.open.json", certificate.incident_id));
        atomic_write_redacted_json(&path, certificate, &self.process_secret)?;
        let writer = RotatingJsonlWriter::create(
            self.root.join("incidents.jsonl"),
            INCIDENT_LOG_MAX_BYTES,
            INCIDENT_LOG_BACKUPS,
            self.process_secret.clone(),
        )?;
        writer.write_json(certificate)?;
        writer.sync_all()?;
        Ok(path)
    }

    pub fn export_summary<T: serde::Serialize>(
        &self,
        incident_id: &IncidentId,
        closed: bool,
        value: &T,
    ) -> std::io::Result<PathBuf> {
        let _coordinator = incident_file_coordinator();
        self.export_summary_coordinated(incident_id, closed, value)
    }

    pub(crate) fn export_summary_coordinated<T: serde::Serialize>(
        &self,
        incident_id: &IncidentId,
        closed: bool,
        value: &T,
    ) -> std::io::Result<PathBuf> {
        fs::create_dir_all(&self.root)?;
        let suffix = if closed { "closed" } else { "open" };
        let target = self.root.join(format!("{incident_id}.{suffix}.json"));
        atomic_write_redacted_json(&target, value, &self.process_secret)?;
        if closed {
            let open = self.root.join(format!("{incident_id}.open.json"));
            match fs::remove_file(open) {
                Ok(()) => std::fs::File::open(&self.root)?.sync_all()?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        self.enforce_retention_coordinated()?;
        Ok(target)
    }

    /// Enforce the closed-incident age/count/byte bounds. Open incidents have
    /// an `.open.json` suffix and are deliberately never considered here.
    pub fn enforce_retention(&self) -> std::io::Result<Vec<PathBuf>> {
        let _coordinator = incident_file_coordinator();
        self.enforce_retention_coordinated()
    }

    fn enforce_retention_coordinated(&self) -> std::io::Result<Vec<PathBuf>> {
        fs::create_dir_all(&self.root)?;
        let mut closed = fs::read_dir(&self.root)?
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if !name.ends_with(".closed.json") {
                    return None;
                }
                let metadata = entry.metadata().ok()?;
                let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                Some((entry.path(), modified, metadata.len()))
            })
            .collect::<Vec<_>>();
        closed.sort_by_key(|(_, modified, _)| *modified);
        let cutoff = SystemTime::now()
            .checked_sub(Duration::from_secs(INCIDENT_RETENTION_DAYS * 24 * 60 * 60))
            .unwrap_or(SystemTime::UNIX_EPOCH);
        let mut total_bytes = closed.iter().map(|(_, _, bytes)| *bytes).sum::<u64>();
        let mut remaining = closed.len();
        let mut removed = Vec::new();
        for (path, modified, bytes) in closed {
            let over_age = modified < cutoff;
            let over_count = remaining > INCIDENT_RETENTION_COUNT;
            let over_bytes = total_bytes > INCIDENT_RETENTION_BYTES;
            if !(over_age || over_count || over_bytes) {
                continue;
            }
            fs::remove_file(&path)?;
            remaining = remaining.saturating_sub(1);
            total_bytes = total_bytes.saturating_sub(bytes);
            removed.push(path);
        }
        Ok(removed)
    }

    #[cfg(test)]
    pub(crate) fn retract_false_incidents_coordinated(
        &self,
        incident_ids: &BTreeSet<String>,
        lifecycle_log: &std::path::Path,
    ) -> std::io::Result<()> {
        self.retract_false_incidents_coordinated_checked(incident_ids, lifecycle_log, || Ok(()))
    }

    pub(crate) fn retract_false_incidents_coordinated_checked<F>(
        &self,
        incident_ids: &BTreeSet<String>,
        lifecycle_log: &std::path::Path,
        mut check_generation: F,
    ) -> std::io::Result<()>
    where
        F: FnMut() -> std::io::Result<()>,
    {
        retract_incident_files(
            &self.root,
            lifecycle_log,
            incident_ids,
            &mut check_generation,
        )
    }
}

enum IncidentFileEffect {
    Remove(PathBuf),
    Rewrite(PathBuf, Vec<u8>),
}

fn retract_incident_files(
    incident_root: &std::path::Path,
    lifecycle_log: &std::path::Path,
    incident_ids: &BTreeSet<String>,
    check_generation: &mut impl FnMut() -> std::io::Result<()>,
) -> std::io::Result<()> {
    let mut effects = Vec::new();
    for base in [
        incident_root.join("incidents.jsonl"),
        lifecycle_log.to_path_buf(),
    ] {
        for path in rotated_jsonl_paths(&base)? {
            let bytes = fs::read(&path)?;
            let filtered = filter_incident_jsonl(&bytes, incident_ids)?;
            if filtered == bytes {
                continue;
            }
            if filtered.is_empty() {
                effects.push(IncidentFileEffect::Remove(path));
            } else {
                effects.push(IncidentFileEffect::Rewrite(path, filtered));
            }
        }
    }

    let mut exact_exports = BTreeSet::new();
    for incident_id in incident_ids {
        exact_exports.insert(incident_root.join(format!("{incident_id}.open.json")));
        exact_exports.insert(incident_root.join(format!("{incident_id}.closed.json")));
    }
    for path in exact_exports {
        if regular_file_exists(&path)? {
            effects.push(IncidentFileEffect::Remove(path));
        }
    }
    for path in [
        incident_root,
        lifecycle_log.parent().unwrap_or(incident_root),
    ] {
        if !path.is_dir() {
            continue;
        }
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if incident_ids.iter().any(|incident_id| {
                ["open", "closed"]
                    .iter()
                    .any(|state| name.starts_with(&format!("{incident_id}.{state}.tmp-")))
            }) && regular_file_exists(&entry.path())?
            {
                effects.push(IncidentFileEffect::Remove(entry.path()));
            }
        }
    }

    // Classify every JSONL file before the first mutation. A malformed later
    // rotation therefore cannot leave an earlier file rewritten.
    for effect in effects {
        check_generation()?;
        match effect {
            IncidentFileEffect::Remove(path) => remove_synced(&path)?,
            IncidentFileEffect::Rewrite(path, bytes) => atomic_replace_synced(&path, &bytes)?,
        }
    }

    for base in [
        incident_root.join("incidents.jsonl"),
        lifecycle_log.to_path_buf(),
    ] {
        for path in rotated_jsonl_paths(&base)? {
            let bytes = fs::read(path)?;
            if filter_incident_jsonl(&bytes, incident_ids)? != bytes {
                return Err(std::io::Error::other(
                    "false incident remains in a serialized JSONL artifact",
                ));
            }
        }
    }
    for incident_id in incident_ids {
        for path in [
            incident_root.join(format!("{incident_id}.open.json")),
            incident_root.join(format!("{incident_id}.closed.json")),
        ] {
            if regular_file_exists(&path)? {
                return Err(std::io::Error::other(
                    "false incident export remains after withdrawal",
                ));
            }
        }
    }
    Ok(())
}

fn rotated_jsonl_paths(base: &std::path::Path) -> std::io::Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    if regular_file_exists(base)? {
        paths.push(base.to_path_buf());
    }
    let Some(parent) = base.parent() else {
        return Ok(paths);
    };
    if !parent.is_dir() {
        return Ok(paths);
    }
    let file_name = base.file_name().unwrap_or_default().to_string_lossy();
    for entry in fs::read_dir(parent)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name
            .strip_prefix(&format!("{file_name}."))
            .is_some_and(|suffix| {
                !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
            })
            && regular_file_exists(&entry.path())?
        {
            paths.push(entry.path());
        }
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

fn regular_file_exists(path: &std::path::Path) -> std::io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => Err(
            std::io::Error::other("incident artifact is not a regular file"),
        ),
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn remove_synced(path: &std::path::Path) -> std::io::Result<()> {
    if !regular_file_exists(path)? {
        return Ok(());
    }
    fs::remove_file(path)?;
    sync_parent(path)
}

fn atomic_replace_synced(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("incident log has no parent directory"))?;
    if !regular_file_exists(path)? {
        return Err(std::io::Error::other(
            "incident log disappeared during rewrite",
        ));
    }
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let temp = parent.join(format!(".{name}.freshell-retraction-tmp"));
    match fs::symlink_metadata(&temp) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err(std::io::Error::other(
                "incident retraction temporary is not a regular file",
            ));
        }
        Ok(_) => fs::remove_file(&temp)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp)?;
    let result = (|| {
        use std::io::Write;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temp, path)?;
        sync_parent(path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn sync_parent(path: &std::path::Path) -> std::io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("incident artifact has no parent directory"))?;
    fs::File::open(parent)?.sync_all()
}

use std::os::unix::fs::PermissionsExt;

#[derive(Debug, Clone)]
pub struct PreparedLoss {
    pub certificate: LostDecisionCertificate,
    pub handle: OwnedRuntimeHandle,
    pub committed_intent_revision: u64,
}

#[derive(Debug, Clone)]
pub struct PendingIncidentExport {
    pub event_id: String,
    pub event_kind: String,
    pub incident_id: IncidentId,
    pub payload: serde_json::Value,
}

impl Registry {
    /// Commit the loss certificate, stop/loss intent, exact cleanup target, and
    /// export outbox event in one FULL-synchronous transaction. No signal is
    /// sent before this method returns successfully.
    pub async fn prepare_loss(
        &self,
        decision: LostDecision,
    ) -> Result<PreparedLoss, RegistryError> {
        let installation = self.installation_id().clone();
        let LostDecision {
            certificate,
            capture,
        } = decision;
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            validate_loss_capture(&tx, &certificate, &capture)?;
            if let Some((existing_json, incarnation_raw, committed_revision, desired, recovery, current_incident)) = tx
                .query_row(
                    "SELECT certificate_json,incarnation_id, \
                     (SELECT intent_revision FROM souls WHERE soul_id=loss_incidents.soul_id), \
                     (SELECT desired_state FROM souls WHERE soul_id=loss_incidents.soul_id), \
                     (SELECT recovery_state FROM souls WHERE soul_id=loss_incidents.soul_id), \
                     (SELECT loss_incident_id FROM souls WHERE soul_id=loss_incidents.soul_id) \
                     FROM loss_incidents WHERE soul_id=?1 AND intent_revision=?2",
                    params![certificate.soul_id.as_str(), certificate.intent_revision],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, u64>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, Option<String>>(5)?,
                        ))
                    },
                )
                .optional()?
            {
                let existing: LostDecisionCertificate = serde_json::from_str(&existing_json)?;
                if existing != certificate {
                    return Err(RegistryError::RequestConflict);
                }
                let expected_committed_revision = certificate
                    .intent_revision
                    .checked_add(1)
                    .ok_or_else(|| RegistryError::Integrity("intent revision overflow".into()))?;
                if committed_revision != expected_committed_revision
                    || desired != "stopped"
                    || recovery != "lost"
                    || current_incident.as_deref() != Some(certificate.incident_id.as_str())
                {
                    return Err(RegistryError::StaleIntentRevision {
                        expected: expected_committed_revision,
                        current: committed_revision,
                    });
                }
                let incarnation_id = freshell_runtime_protocol::IncarnationId::parse(incarnation_raw)
                    .map_err(|_| RegistryError::Integrity("invalid loss incarnation id".into()))?;
                let handle = load_owned_handle(&tx, installation, &incarnation_id)?;
                tx.commit()?;
                return Ok(PreparedLoss {
                    certificate: existing,
                    handle,
                    committed_intent_revision: committed_revision,
                });
            }

            let (desired_state, current_revision, recovery_state): (String, u64, String) = tx
                .query_row(
                    "SELECT desired_state,intent_revision,recovery_state FROM souls WHERE soul_id=?1",
                    params![certificate.soul_id.as_str()],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?
                .ok_or_else(|| RegistryError::UnknownSoul(certificate.soul_id.clone()))?;
            if desired_state != "running"
                || current_revision != certificate.intent_revision
                || matches!(recovery_state.as_str(), "lost" | "stopped")
            {
                return Err(RegistryError::StaleIntentRevision {
                    expected: certificate.intent_revision,
                    current: current_revision,
                });
            }
            let incarnation_id = certificate.cleanup_target.incarnation_id.clone();
            let active: Option<String> = tx
                .query_row(
                    "SELECT incarnation_id FROM incarnations WHERE soul_id=?1 \
                     AND launch_state IN ('created','starting','running','stopping') \
                     ORDER BY created_at DESC LIMIT 1",
                    params![certificate.soul_id.as_str()],
                    |row| row.get(0),
                )
                .optional()?;
            if active.as_deref() != Some(incarnation_id.as_str()) {
                return Err(RegistryError::InvalidState(
                    "loss cleanup target is not the current active incarnation".into(),
                ));
            }
            let handle = load_owned_handle(&tx, installation, &incarnation_id)?;
            if !certificate.cleanup_target.ownership_verified
                || handle.soul_id() != &certificate.soul_id
            {
                return Err(RegistryError::InvalidState(
                    "loss certificate lacks exact owned cleanup authority".into(),
                ));
            }
            let next_revision = current_revision
                .checked_add(1)
                .ok_or_else(|| RegistryError::Integrity("intent revision overflow".into()))?;
            let now = crate::registry::now_millis();
            let initial_cleanup = LossCleanupReport {
                owned_handle_ref: certificate.cleanup_target.owned_handle_ref.clone(),
                ownership_verified: true,
                graceful_attempt: "not_started".into(),
                forced_attempt: "not_started".into(),
                verified_empty: false,
                verified_at: None,
                foreign_objects_touched: 0,
            };
            let certificate_json = serde_json::to_string(&certificate)?;
            tx.execute(
                "INSERT INTO loss_incidents \
                 (incident_id,correlation_id,soul_id,incarnation_id,provider,provider_store_id, \
                  native_session_ref_hash,intent_revision,decision_state,reason_code,certificate_json, \
                  cleanup_state,cleanup_json,observed_cause,missing_invariant,hypotheses_json, \
                  preventive_action,regression_case,captured_control_epoch,captured_identity_revision, \
                  captured_evidence_revision,captured_native_import_revision,captured_native_import_state, \
                  captured_source_store_id,captured_root_session_id,captured_source_generation, \
                  captured_source_schema_fingerprint,captured_migration_fingerprint, \
                  captured_native_import_complete,captured_native_import_authority,created_at,updated_at,closed_at) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'cleanup_pending',?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29,?30,?30,NULL)",
                params![
                    certificate.incident_id.as_str(),
                    certificate.correlation_id.as_str(),
                    certificate.soul_id.as_str(),
                    incarnation_id.as_str(),
                    certificate.provider,
                    certificate.provider_store_id,
                    certificate.native_session_ref_hash,
                    certificate.intent_revision,
                    loss_decision_state_name(certificate.decision.state),
                    certificate.decision.reason_code,
                    certificate_json,
                    serde_json::to_string(&initial_cleanup)?,
                    certificate.analysis.observed_cause,
                    certificate.analysis.missing_invariant,
                    serde_json::to_string(&certificate.analysis.hypotheses)?,
                    certificate.analysis.preventive_action,
                    certificate.analysis.regression_case,
                    capture.control_epoch,
                    capture.identity_revision,
                    capture.evidence_revision,
                    capture.native_import_revision,
                    capture.native_import_state.as_str(),
                    capture.native_import_source_store_id,
                    capture.native_import_root_session_id,
                    capture.native_import_source_generation,
                    capture.native_import_schema_fingerprint,
                    capture.native_import_migration_fingerprint,
                    capture.native_import_complete_inventory,
                    capture.native_import_authority,
                    now,
                ],
            )?;
            let soul_changed = tx.execute(
                "UPDATE souls SET desired_state='stopped',intent_revision=?1,recovery_state='lost', \
                 recovery_reason=?2,recovery_attempt_id=NULL,loss_incident_id=?3,updated_at=?4 \
                 WHERE soul_id=?5 AND intent_revision=?6 AND desired_state='running' AND identity_revision=?7 AND evidence_revision=?8 AND native_import_revision=?9",
                params![
                    next_revision,
                    format!("LOSS_CERTIFIED:{}", certificate.incident_id),
                    certificate.incident_id.as_str(),
                    now,
                    certificate.soul_id.as_str(),
                    current_revision,
                    capture.identity_revision,
                    capture.evidence_revision,
                    capture.native_import_revision,
                ],
            )?;
            if soul_changed != 1 {
                return Err(RegistryError::LossCertificationBlocked(
                    "soul revision changed while committing loss".into(),
                ));
            }
            let incarnation_changed = tx.execute(
                "UPDATE incarnations SET launch_state='stopping',cleanup_state='requested',updated_at=?1 \
                 WHERE incarnation_id=?2",
                params![now, incarnation_id.as_str()],
            )?;
            if incarnation_changed != 1 {
                return Err(RegistryError::InvalidState(
                    "loss cleanup incarnation changed while committing loss".into(),
                ));
            }
            tx.execute(
                "INSERT INTO stop_tombstones (soul_id,intent_revision,actor,reason,committed_at) \
                 VALUES (?1,?2,'loss-certificate',?3,?4)",
                params![
                    certificate.soul_id.as_str(),
                    next_revision,
                    format!("certified loss {}", certificate.incident_id),
                    now
                ],
            )?;

            // Every visible view remains as compact ended history. Advance the
            // soul fence and projection revision, but do not delete/detach it.
            let view_ids = {
                let mut statement = tx.prepare(
                    "SELECT view_id FROM view_intents WHERE soul_id=?1 ORDER BY view_id",
                )?;
                let rows = statement.query_map(params![certificate.soul_id.as_str()], |row| {
                    row.get::<_, String>(0)
                })?;
                rows.collect::<Result<Vec<_>, _>>()?
            };
            for raw in view_ids {
                let view_id = freshell_runtime_protocol::ViewIntentId::parse(raw)
                    .map_err(|_| RegistryError::Integrity("invalid view id".into()))?;
                let current = load_view_intent(&tx, &view_id)?
                    .ok_or_else(|| RegistryError::Integrity("view disappeared".into()))?;
                let view_revision = current
                    .revision
                    .checked_add(1)
                    .ok_or_else(|| RegistryError::Integrity("view revision overflow".into()))?;
                tx.execute(
                    "UPDATE view_intents SET revision=?1,soul_intent_revision=?2,updated_at=?3 \
                     WHERE view_id=?4 AND revision=?5",
                    params![
                        view_revision,
                        next_revision,
                        now,
                        view_id.as_str(),
                        current.revision
                    ],
                )?;
                let updated = load_view_intent(&tx, &view_id)?
                    .ok_or_else(|| RegistryError::Integrity("updated view disappeared".into()))?;
                enqueue_projection(&tx, &updated)?;
            }

            let export_event_id = format!("projection-loss-open-{}", certificate.incident_id);
            tx.execute(
                "INSERT INTO outbox (event_id,event_kind,payload,created_at,delivered_at) \
                 VALUES (?1,'loss_incident.open',?2,?3,NULL)",
                params![export_event_id, serde_json::to_string(&certificate)?, now],
            )?;
            crate::registry::failpoint("loss_before_incident_commit")?;
            increment_counter_in_tx(
                &tx,
                "recovery_outcome",
                match certificate.decision.state {
                    LossDecisionState::Lost => "lost",
                    LossDecisionState::NonResumableTerminalEnded => "terminal_ended",
                },
                1,
                now,
            )?;
            tx.commit()?;
            Ok(PreparedLoss {
                certificate,
                handle,
                committed_intent_revision: next_revision,
            })
        })
        .await
    }

    pub async fn finalize_loss_cleanup(
        &self,
        incident_id: IncidentId,
        outcome: StopOutcome,
        cleanup: LossCleanupReport,
    ) -> Result<RuntimeNotice, RegistryError> {
        self.finalize_loss_cleanup_with_census(incident_id, outcome, cleanup, None)
            .await
    }

    pub(crate) async fn finalize_loss_cleanup_with_census(
        &self,
        incident_id: IncidentId,
        outcome: StopOutcome,
        cleanup: LossCleanupReport,
        current_native_census: Option<Vec<String>>,
    ) -> Result<RuntimeNotice, RegistryError> {
        self.run_blocking(move |mut conn| {
            let _incident_coordinator = incident_file_coordinator();
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let (
                soul_id,
                incarnation_id,
                current_state,
                certificate_json,
                persisted_cleanup_json,
                captured_identity_revision,
                captured_evidence_revision,
                captured_native_import_revision,
                captured_native_import_state,
                captured_source_store_id,
                captured_root_session_id,
                captured_source_generation,
                captured_source_schema_fingerprint,
                captured_migration_fingerprint,
                captured_native_import_complete,
                captured_native_import_authority,
            ): LossIncidentCleanupRow = tx
                .query_row(
                    "SELECT soul_id,incarnation_id,cleanup_state,certificate_json,cleanup_json,captured_identity_revision,captured_evidence_revision,captured_native_import_revision,captured_native_import_state,captured_source_store_id,captured_root_session_id,captured_source_generation,captured_source_schema_fingerprint,captured_migration_fingerprint,captured_native_import_complete,captured_native_import_authority FROM loss_incidents WHERE incident_id=?1",
                    params![incident_id.as_str()],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?, row.get(10)?, row.get(11)?, row.get(12)?, row.get(13)?, row.get(14)?, row.get(15)?)),
                )
                .optional()?
                .ok_or_else(|| {
                    RegistryError::IncidentNotFound(incident_id.clone())
                })?;
            let certificate: LostDecisionCertificate = serde_json::from_str(&certificate_json)?;
            if certificate.provider != "shell" {
                let (provider, store, native_id, revision): (String, String, Option<String>, u64) = tx.query_row(
                    "SELECT provider,provider_store_id,native_session_id,evidence_revision FROM souls WHERE soul_id=?1",
                    params![soul_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )?;
                if provider != certificate.provider || store != certificate.provider_store_id
                    || hash_native_session_reference(&provider, &store, native_id.as_deref()) != certificate.native_session_ref_hash
                    || !certificate.recovery_paths.iter().any(|row|
                        row.path == RecoveryPath::NativeResume && freshell_agent_runtime::native_absence_census_matches(
                            &provider, &store, native_id.as_deref().unwrap_or(""), revision, row.store_state, &row.evidence_refs))
                {
                    return Err(RegistryError::LossCertificationBlocked("historical native absence census is unqualified or stale".into()));
                }
                let native = certificate.recovery_paths.iter().find(|row| row.path == RecoveryPath::NativeResume)
                    .ok_or_else(|| RegistryError::LossCertificationBlocked("native census is missing".into()))?;
                if freshell_agent_runtime::native_absence_census_is_container(&native.evidence_refs)
                    && current_native_census.as_ref().is_none_or(|current|
                        !freshell_agent_runtime::same_native_absence_census(&native.evidence_refs, current)) {
                    return Err(RegistryError::LossCertificationBlocked("current owned-volume census is missing or changed before final cleanup".into()));
                }
            }
            if current_state == "closed" {
                let persisted_cleanup: LossCleanupReport = serde_json::from_str(&persisted_cleanup_json)?;
                let kind = if persisted_cleanup.graceful_attempt == "not_required" {
                    NoticeKind::EndedWithoutProcess
                } else {
                    NoticeKind::CleanupSucceeded
                };
                let notice = enqueue_notice_in_tx(
                    &tx,
                    kind,
                    std::slice::from_ref(&incident_id),
                    persisted_cleanup.foreign_objects_touched,
                    crate::registry::now_millis(),
                )?;
                tx.commit()?;
                return Ok(notice);
            }
            if cleanup.owned_handle_ref != certificate.cleanup_target.owned_handle_ref
                || cleanup.foreign_objects_touched != 0
            {
                return Err(RegistryError::InvalidState(
                    "loss cleanup result does not match the exact certified ownership handle".into(),
                ));
            }
            let expected_revision = certificate
                .intent_revision
                .checked_add(1)
                .ok_or_else(|| RegistryError::Integrity("intent revision overflow".into()))?;
            let (
                desired_state,
                current_revision,
                recovery_state,
                current_incident,
                identity_revision,
                evidence_revision,
                native_import_revision,
                native_import_state,
                native_import_source_store_id,
                native_import_root_session_id,
                native_import_source_generation,
                native_import_schema_fingerprint,
                native_import_migration_fingerprint,
                native_import_complete_inventory,
                native_import_authority,
            ): LossSoulCleanupRow = tx.query_row(
                "SELECT desired_state,intent_revision,recovery_state,loss_incident_id,identity_revision,evidence_revision,native_import_revision,native_import_state,native_import_source_store_id,native_import_root_session_id,native_import_source_generation,native_import_schema_fingerprint,native_import_migration_fingerprint,native_import_complete_inventory,native_import_authority FROM souls WHERE soul_id=?1",
                params![soul_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?, row.get(10)?, row.get(11)?, row.get(12)?, row.get(13)?, row.get(14)?)),
            )?;
            if desired_state != "stopped"
                || current_revision != expected_revision
                || recovery_state != "lost"
                || current_incident.as_deref() != Some(incident_id.as_str())
            {
                return Err(RegistryError::StaleIntentRevision {
                    expected: expected_revision,
                    current: current_revision,
                });
            }
            let capture_matches = captured_identity_revision == Some(identity_revision)
                && captured_evidence_revision == Some(evidence_revision)
                && captured_native_import_revision == Some(native_import_revision)
                && captured_native_import_state.as_deref() == Some(native_import_state.as_str())
                && captured_source_store_id == native_import_source_store_id
                && captured_root_session_id == native_import_root_session_id
                && captured_source_generation == native_import_source_generation
                && captured_source_schema_fingerprint == native_import_schema_fingerprint
                && captured_migration_fingerprint == native_import_migration_fingerprint
                && captured_native_import_complete == Some(native_import_complete_inventory)
                && captured_native_import_authority.as_deref() == Some(native_import_authority.as_str());
            if !capture_matches {
                return Err(RegistryError::LossCertificationBlocked(
                    "identity or native import evidence changed after loss was committed".into(),
                ));
            }
            let now = crate::registry::now_millis();
            let verified = outcome == StopOutcome::VerifiedEmpty && cleanup.verified_empty;
            if verified && !cleanup.ownership_verified {
                return Err(RegistryError::InvalidState(
                    "verified-empty cleanup lacks exact ownership verification".into(),
                ));
            }
            let (incident_state, launch_state, cleanup_state, notice_kind) = if verified {
                (
                    "closed",
                    "stopped",
                    "verified_empty",
                    if cleanup.graceful_attempt == "not_required" {
                        NoticeKind::EndedWithoutProcess
                    } else {
                        NoticeKind::CleanupSucceeded
                    },
                )
            } else {
                (
                    "cleanup_failed",
                    "stopping",
                    match outcome {
                        StopOutcome::BlockedOwnership => "blocked_ownership",
                        _ => "termination_unconfirmed",
                    },
                    NoticeKind::CleanupFailed,
                )
            };
            let incident_changed = tx.execute(
                "UPDATE loss_incidents SET cleanup_state=?1,cleanup_json=?2,updated_at=?3,closed_at=?4 \
                 WHERE incident_id=?5 AND cleanup_state=?6",
                params![
                    incident_state,
                    serde_json::to_string(&cleanup)?,
                    now,
                    verified.then_some(now),
                    incident_id.as_str(),
                    current_state,
                ],
            )?;
            if incident_changed != 1 {
                return Err(RegistryError::RequestConflict);
            }
            let incarnation_changed = tx.execute(
                "UPDATE incarnations SET launch_state=?1,cleanup_state=?2,updated_at=?3 \
                 WHERE incarnation_id=?4 AND soul_id=?5",
                params![launch_state, cleanup_state, now, incarnation_id, soul_id],
            )?;
            if incarnation_changed != 1 {
                return Err(RegistryError::InvalidState(
                    "loss cleanup incarnation no longer belongs to the certified soul".into(),
                ));
            }
            if verified {
                tx.execute(
                    "DELETE FROM writer_claims WHERE incarnation_id=?1",
                    params![incarnation_id],
                )?;
                tx.execute(
                    "DELETE FROM admission_reservations WHERE incarnation_id=?1",
                    params![incarnation_id],
                )?;
                tx.execute(
                    "UPDATE commands SET state='lost',updated_at=?1 WHERE incarnation_id=?2",
                    params![now, incarnation_id],
                )?;
                tx.execute(
                    "UPDATE input_commands SET state='cancelled',updated_at=?1 \
                     WHERE incarnation_id=?2 AND state NOT IN ('completed','cancelled')",
                    params![now, incarnation_id],
                )?;
            }
            let soul_changed = tx.execute(
                "UPDATE souls SET recovery_state='lost',recovery_reason=?1,recovery_attempt_id=NULL, \
                 loss_incident_id=?2,updated_at=?3 WHERE soul_id=?4 AND intent_revision=?5 \
                 AND desired_state='stopped' AND recovery_state='lost' AND loss_incident_id=?2",
                params![
                    format!("LOSS_CERTIFIED:{incident_id}"),
                    incident_id.as_str(),
                    now,
                    soul_id,
                    expected_revision,
                ],
            )?;
            if soul_changed != 1 {
                return Err(RegistryError::StaleIntentRevision {
                    expected: expected_revision,
                    current: current_revision,
                });
            }
            let notice = enqueue_notice_in_tx(
                &tx,
                notice_kind,
                std::slice::from_ref(&incident_id),
                cleanup.foreign_objects_touched,
                now,
            )?;
            if verified {
                // A later verified cleanup supersedes the earlier failure
                // notice for this incident. Keep both durable for audit, but
                // deliver only the final truthful state to each profile.
                let candidates = {
                    let mut statement = tx.prepare(
                        "SELECT notice_id,incident_ids_json FROM runtime_notices                          WHERE superseded_by IS NULL AND notice_id!=?1",
                    )?;
                    let rows = statement.query_map(params![notice.notice_id.as_str()], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    })?;
                    rows.collect::<Result<Vec<_>, _>>()?
                };
                for (prior_notice_id, incident_json) in candidates {
                    let incident_ids: Vec<IncidentId> = serde_json::from_str(&incident_json)?;
                    if incident_ids.iter().any(|candidate| candidate == &incident_id) {
                        tx.execute(
                            "UPDATE runtime_notices SET superseded_by=?1,updated_at=?2 WHERE notice_id=?3",
                            params![notice.notice_id.as_str(), now, prior_notice_id],
                        )?;
                    }
                }
            }
            let certificate_sha256 = hash_loss_certificate(&certificate);
            let summary = serde_json::json!({
                "incidentId": incident_id,
                "event": "soul.loss.finalized",
                "certificate": certificate,
                "certificateSha256": certificate_sha256,
                "cleanupState": incident_state,
                "cleanup": cleanup,
                "noticeId": notice.notice_id,
                "updatedAt": millis_to_timestamp(now),
            });
            tx.execute(
                "INSERT OR REPLACE INTO outbox (event_id,event_kind,payload,created_at,delivered_at) \
                 VALUES (?1,'loss_incident.final',?2,?3,NULL)",
                params![
                    format!("projection-loss-final-{incident_id}"),
                    serde_json::to_string(&summary)?,
                    now
                ],
            )?;
            increment_counter_in_tx(
                &tx,
                "cleanup_outcome",
                if verified {
                    "verified_empty"
                } else {
                    cleanup_state
                },
                1,
                now,
            )?;
            tx.commit()?;
            Ok(notice)
        })
        .await
    }

    pub(crate) async fn export_and_ack_incident(
        &self,
        event: PendingIncidentExport,
        exporter: IncidentExporter,
    ) -> Result<Option<PathBuf>, RegistryError> {
        self.run_blocking(move |mut conn| {
            let _coordinator = incident_file_coordinator();
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let pending: Option<(String, String)> = tx
                .query_row(
                    "SELECT event_kind,payload FROM outbox WHERE event_id=?1 AND delivered_at IS NULL",
                    params![event.event_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let Some((event_kind, encoded_payload)) = pending else {
                return Ok(None);
            };
            let payload: serde_json::Value = serde_json::from_str(&encoded_payload)?;
            if event_kind != event.event_kind
                || payload != event.payload
                || payload.get("incidentId").and_then(serde_json::Value::as_str)
                    != Some(event.incident_id.as_str())
            {
                return Err(RegistryError::Integrity(
                    "incident export changed after it was queued".into(),
                ));
            }
            let path = if event.event_kind == "loss_incident.open" {
                let certificate = serde_json::from_value(event.payload.clone())?;
                exporter.export_certificate_coordinated(&certificate)?
            } else if event.event_kind == "loss_incident.final" {
                let closed = event
                    .payload
                    .get("cleanupState")
                    .and_then(serde_json::Value::as_str)
                    == Some("closed");
                exporter.export_summary_coordinated(
                    &event.incident_id,
                    closed,
                    &event.payload,
                )?
            } else {
                return Err(RegistryError::Integrity(
                    "unsupported incident export event kind".into(),
                ));
            };
            let changed = tx.execute(
                "UPDATE outbox SET delivered_at=COALESCE(delivered_at,?1) \
                 WHERE event_id=?2 AND delivered_at IS NULL",
                params![crate::registry::now_millis(), event.event_id],
            )?;
            if changed != 1 {
                return Err(RegistryError::InvalidState(
                    "incident export acknowledgement lost its pending row".into(),
                ));
            }
            tx.commit()?;
            Ok(Some(path))
        })
        .await
    }

    pub async fn pending_incident_exports(
        &self,
        limit: u32,
    ) -> Result<Vec<PendingIncidentExport>, RegistryError> {
        let limit = i64::from(limit.clamp(1, 100));
        self.run_blocking(move |conn| {
            let mut statement = conn.prepare(
                "SELECT event_id,event_kind,payload FROM outbox WHERE event_kind IN ('loss_incident.open','loss_incident.final') \
                 AND delivered_at IS NULL ORDER BY created_at,event_id LIMIT ?1",
            )?;
            let rows = statement.query_map(params![limit], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?;
            let mut exports = Vec::new();
            for row in rows {
                let (event_id, event_kind, payload) = row?;
                let payload: serde_json::Value = serde_json::from_str(&payload)?;
                let raw = payload
                    .get("incidentId")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| RegistryError::Integrity("incident export has no incidentId".into()))?;
                exports.push(PendingIncidentExport {
                    event_id,
                    event_kind,
                    incident_id: IncidentId::parse(raw)
                        .map_err(|_| RegistryError::Integrity("invalid incident id".into()))?,
                    payload,
                });
            }
            Ok(exports)
        })
        .await
    }

    pub async fn acknowledge_incident_export(&self, event_id: String) -> Result<(), RegistryError> {
        self.run_blocking(move |conn| {
            let changed = conn.execute(
                "UPDATE outbox SET delivered_at=COALESCE(delivered_at,?1) \
                 WHERE event_id=?2 AND event_kind IN ('loss_incident.open','loss_incident.final')",
                params![crate::registry::now_millis(), event_id],
            )?;
            if changed == 0 {
                return Err(RegistryError::InvalidState(
                    "unknown incident export event".into(),
                ));
            }
            Ok(())
        })
        .await
    }

    pub async fn loss_certificate(
        &self,
        incident_id: IncidentId,
    ) -> Result<LostDecisionCertificate, RegistryError> {
        self.run_blocking(move |conn| {
            let encoded = conn
                .query_row(
                    "SELECT certificate_json FROM loss_incidents WHERE incident_id=?1",
                    params![incident_id.as_str()],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .ok_or_else(|| RegistryError::IncidentNotFound(incident_id.clone()))?;
            Ok(serde_json::from_str(&encoded)?)
        })
        .await
    }
}

fn loss_decision_state_name(state: LossDecisionState) -> &'static str {
    match state {
        LossDecisionState::Lost => "lost",
        LossDecisionState::NonResumableTerminalEnded => "non_resumable_terminal_ended",
    }
}

#[cfg(test)]
#[path = "loss_report_tests.rs"]
mod tests;

//! Serialized automatic recovery for managed souls.
//!
//! Replacement ordering is intentionally strict:
//! durable recovery attempt -> probe -> stop exact owned enclosure -> verify
//! empty -> prepare one replacement claim -> exact resume -> verify the native
//! identity -> publish LIVE. No branch can substitute a fresh provider session
//! for a failed native resume.

use crate::{
    backend::{BackendError, BackendRuntimeState, StoppedOpenCodeRepairReceipts},
    checkpoints,
    loss_report::{
        hash_loss_certificate, path_name, IncidentExporter, LossDecisionInput, LostDecision,
    },
    recovery_retry::{RecoveryRetry, TransientRecoveryFailure},
    registry::{
        NativeImportState, OwnedRuntimeHandle, RecoveryContext, RecoveryWriteFence, RegistryError,
        StoppedRepairOwnerCandidate, StoppedRepairRootReceipt,
    },
    resume_catalog,
    service::{map_backend, LaunchWorkload, Supervisor},
};
use freshell_agent_runtime::{classify_provider_failure, recovery_paths};
use freshell_runtime_protocol::{
    opencode_target_build_receipt, opencode_transfer_bundle_digest, CleanupState, CommandState,
    DesiredState, EvidenceStoreState, HostCommand, HostResult, IncidentAnalysis,
    IncidentTimelineEvent, LaunchState, LossBuildEvidence, LossCleanupReport, ManagedRolloutMode,
    OpenCodeAdoptionBaseline, OpenCodeTransferChunk, OpenCodeTransferDescriptor,
    OpenCodeTransferFile, ReattachHandle, RecoverRequest, RecoveryAttemptId, RecoveryBlockReason,
    RecoveryEvidenceVerdict, RecoveryOutcome, RecoveryPath, RecoveryPathEvidence, RecoveryProbe,
    RecoveryResult, RecoveryTrigger, RestoreLostSoulRootResult, RestoreLostSoulsRequest,
    RestoreLostSoulsResult, RetryHint, RootRepairImportStatus, RuntimeError, RuntimeErrorCode,
    RuntimeView, SoulId, SoulRepairStatus, StopOutcome, TerminalLaunchSpec,
    CONTROL_PROTOCOL_VERSION, MAX_OPENCODE_TRANSFER_BUNDLE_BYTES,
    MAX_OPENCODE_TRANSFER_CHUNK_BYTES, OPENCODE_TRANSFER_DESTINATION_DB,
};
use freshell_sessions::opencode_transfer::{
    capture_qualified_batch, export_exact_session, ExportOptions, HostOpenCodeInventory,
    OpenCodeNativeSnapshot, TransferError,
};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::time::{sleep, Duration, Instant};

#[cfg(test)]
pub(crate) const LIVE_RESUME_EVIDENCE_RETRY_INTERVAL: Duration = Duration::from_secs(2);
#[cfg(not(test))]
pub(crate) const LIVE_RESUME_EVIDENCE_RETRY_INTERVAL: Duration = Duration::from_secs(30);
const LIVE_RESUME_EVIDENCE_ATTEMPT_CACHE_MAX_ENTRIES: usize = 1_024;
fn source_transfer_target_context(
    root: &str,
    target: &freshell_runtime_protocol::LostSoulRepairTarget,
    context: &RecoveryContext,
) -> serde_json::Value {
    // Source timing callbacks can outlive exact incident withdrawal.
    serde_json::json!({
        "rootSessionId": root, "soulId": target.soul_id,
        "incarnationId": context.prior_handle.incarnation_id(),
        "intentRevision": target.expected_intent_revision,
        "identityRevision": context.identity_revision,
        "nativeImportRevision": context.native_import_revision,
        "evidenceRevision": context.evidence_revision,
    })
}

fn stopped_source_export_options(
    extraction_root: PathBuf,
    lifecycle_log: PathBuf,
    operation: &'static str,
    targets: Vec<serde_json::Value>,
) -> ExportOptions {
    ExportOptions::new(extraction_root).with_progress_observer(move |progress| {
        let selected = targets
            .iter()
            .filter(|target| {
                progress
                    .root_session_id
                    .as_ref()
                    .is_none_or(|root| target["rootSessionId"] == *root)
            })
            .collect::<Vec<_>>();
        let mut data = serde_json::to_value(&progress).expect("body-free source progress");
        data["sourceOperation"] = operation.into();
        data["targetContext"] = serde_json::json!(selected);
        crate::service::append_event(
            &lifecycle_log,
            "supervisor.stopped_repair.source_phase",
            data,
        );
    })
}

fn stopped_repair_transfer_failure(
    path: &Path,
    phase: &str,
    source_database: &Path,
    roots: &[String],
    error: &TransferError,
) -> RuntimeError {
    // TransferError currently stores strings; retain only a numeric OS code
    // from std::io's suffix, never the arbitrary nested error text.
    let errno = match error {
        TransferError::Blocked(reason) | TransferError::Io(reason) => reason
            .rsplit_once("(os error ")
            .and_then(|(_, suffix)| suffix.strip_suffix(')'))
            .and_then(|number| number.parse::<i32>().ok()),
        _ => None,
    };
    let (class, reason) = match error {
        TransferError::Blocked(reason) => ("blocked", reason.as_str()),
        TransferError::Io(_) => ("io", "source transfer I/O failed"),
        TransferError::Sqlite(_) => ("sqlite", "source transfer SQLite failed"),
        TransferError::Serialization(_) => {
            ("serialization", "source transfer serialization failed")
        }
    };
    // Blocked reasons are producer-written context. Details after ':' include
    // Git stderr, JSON parser output and unrecognized schema names; omit them.
    // Session-specific workspace failures retain their class without identity
    // interpolated into the reason (the selected roots are separate metadata).
    let reason = reason.split(':').next().unwrap_or(reason);
    let reason = reason.split(" for session ").next().unwrap_or(reason);
    crate::service::append_event(
        path,
        "supervisor.stopped_repair.source_transfer_failed",
        serde_json::json!({
            "severity": "error", "phase": phase,
            "declaredSourceDatabase": source_database, "rootSessionIds": roots,
            "errorClass": class, "producerReason": reason,
            "errno": errno,
            "reasonCode": "source_not_exactly_resolvable",
        }),
    );
    stopped_repair_blocked("source_not_exactly_resolvable")
}

fn log_stopped_repair_import_failure(
    path: &Path,
    mut context: serde_json::Value,
    error: &BackendError,
    aborted: Result<(), crate::opencode_transfer::StagingError>,
) {
    context["backendCategory"] = match error {
        BackendError::StoppedRepair(detail) => {
            context["backendDiagnostic"] =
                serde_json::to_value(detail).expect("safe stopped diagnostic");
            detail.category
        }
        BackendError::Unavailable(_) => "unavailable",
        BackendError::OwnershipMismatch(_) => "ownership_mismatch",
        BackendError::PolicyMismatch(_) => "policy_mismatch",
        BackendError::DockerHttp { status, .. } => {
            context["backendHttpStatus"] = (*status).into();
            "docker_http"
        }
        BackendError::Malformed(_) => "malformed",
        BackendError::InvalidConfig(_) => "invalid_config",
    }
    .into();
    crate::service::append_event(
        path,
        "supervisor.stopped_repair.import_failed",
        context.clone(),
    );
    if let Err(error) = aborted {
        use crate::opencode_transfer::StagingError;
        let category = match error {
            StagingError::InvalidDescriptor(_) => "invalid_descriptor",
            StagingError::InvalidState(_) => "invalid_state",
            StagingError::Capacity(_) => "capacity",
            StagingError::Io(_) => "io",
            StagingError::Metadata(_) => "metadata",
        };
        context["severity"] = "warn".into();
        context["abortCategory"] = category.into();
        crate::service::append_event(
            path,
            "supervisor.stopped_repair.staging_abort_failed",
            context,
        );
    }
}

type StoppedRepairGroups = BTreeMap<
    String,
    Vec<(
        freshell_runtime_protocol::LostSoulRepairTarget,
        RecoveryContext,
    )>,
>;

pub(crate) fn stopped_repair_crash_boundary(point: &'static str) {
    crate::service::crash_if(point);
    #[cfg(test)]
    if std::env::var("FRESHELL_TASK007_STOPPED_REPAIR_CRASH_POINT")
        .ok()
        .as_deref()
        == Some(point)
    {
        assert_eq!(
            std::env::var("FRESHELL_SANDBOX_MODE").as_deref(),
            Ok("runtime-suite")
        );
        assert!(Path::new("/.dockerenv").exists());
        let marker = PathBuf::from(
            std::env::var_os("FRESHELL_TASK007_STOPPED_REPAIR_CRASH_MARKER")
                .expect("owned crash marker"),
        );
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&marker)
            .expect("fresh owned boundary marker");
        file.write_all(point.as_bytes())
            .and_then(|()| file.sync_all())
            .expect("record and sync actual stopped-repair boundary");
        std::fs::File::open(marker.parent().expect("owned marker directory"))
            .and_then(|directory| directory.sync_all())
            .expect("sync boundary marker directory");
        eprintln!("{{\"severity\":\"info\",\"event\":\"supervisor.stopped_repair.test_crash\",\"point\":\"{point}\"}}");
        std::process::abort();
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum NativeIdentityWait {
    Observed {
        native_session_id: String,
        elapsed_ms: u64,
    },
    ProviderExited {
        elapsed_ms: u64,
    },
    HostUnavailable {
        message: String,
        elapsed_ms: u64,
        transient: Option<TransientRecoveryFailure>,
    },
    TimedOut {
        adoption_pending: bool,
        elapsed_ms: u64,
    },
    StopIntent {
        elapsed_ms: u64,
    },
    IntentChanged {
        elapsed_ms: u64,
    },
}

const NATIVE_IDENTITY_STARTUP_TIMEOUT: Duration = Duration::from_secs(8);
const OPENCODE_TUI_READINESS_TIMEOUT: Duration = Duration::from_secs(180);

fn retained_runtime_probe(
    exited: bool,
    handle: ReattachHandle,
    captured: RecoveryProbe,
    native_store_required: bool,
) -> RecoveryProbe {
    if exited {
        return captured;
    }
    if !native_store_required {
        return RecoveryProbe::ReattachReady {
            handle,
            protocol_version: CONTROL_PROTOCOL_VERSION,
        };
    }
    match captured {
        RecoveryProbe::ResumeReady { .. } | RecoveryProbe::PristineSeedReady { .. } => {
            RecoveryProbe::ReattachReady {
                handle,
                protocol_version: CONTROL_PROTOCOL_VERSION,
            }
        }
        RecoveryProbe::DefinitivelyUnavailable { .. } => blocked(
            RecoveryPath::Reattach,
            RecoveryBlockReason::StoreUnreadable,
            "running provider has no qualified current store",
            Some(2000),
        ),
        other => other,
    }
}

fn retained_host_features_known(host: &crate::service::AuthenticatedHost) -> bool {
    ["owned-provider-config-v1", "provider-store-probe-v1"]
        .iter()
        .all(|required| {
            host.capabilities
                .iter()
                .any(|capability| capability == required)
        })
}
fn retained_status_observed(
    context: &RecoveryContext,
    host: &crate::service::AuthenticatedHost,
    status: &crate::service::HostStatus,
) -> bool {
    host.capabilities
        .iter()
        .any(|value| value == "native-identity-observation-v1")
        && current_native_observation(context, status).is_some()
}

fn deterministic_fresh_fixture(context: &RecoveryContext) -> bool {
    context.fresh_agent.as_ref().is_some_and(|agent| {
        crate::registry::deterministic_fresh_agent_fixture(&context.provider, agent)
    })
}

fn current_fixture_native_session<'a>(
    context: &RecoveryContext,
    status: &'a crate::service::HostStatus,
) -> Option<&'a str> {
    // Named fixtures expose synthetic roots, never real-provider proof.
    if !((context.provider == "native-session-fixture"
        && context.fixture == Some(freshell_runtime_protocol::FixtureKind::NativeSession))
        || deterministic_fresh_fixture(context))
        || status.exited
        || context
            .native_identity_launch
            .as_ref()
            .is_none_or(|launch| launch.execution_generation != status.max_execution_generation)
    {
        return None;
    }
    status
        .native_session_id
        .as_deref()
        .filter(|root| !root.is_empty() && context.native_session_id.as_deref() == Some(*root))
}

pub(crate) fn current_native_observation<'a>(
    context: &RecoveryContext,
    status: &'a crate::service::HostStatus,
) -> Option<&'a freshell_runtime_protocol::NativeIdentityObservation> {
    let launch = context.native_identity_launch.as_ref()?;
    let observation = status.native_identity_observation.as_ref()?;
    (observation.matches_launch(launch)
        && observation.matches_provider(&context.provider, context.fresh_agent.is_some())
        && observation.incarnation_id == *context.prior_handle.incarnation_id()
        && launch.launch_nonce == context.prior_handle.launch_nonce().as_str()
        && launch.execution_generation == status.max_execution_generation
        && status.native_session_id.as_deref() == Some(observation.native_session_id.as_str())
        && context
            .native_session_id
            .as_deref()
            .is_none_or(|root| root == observation.native_session_id))
    .then_some(observation)
}

pub(crate) fn native_identity_wait_timeout(opencode_tui_readiness_required: bool) -> Duration {
    if opencode_tui_readiness_required {
        OPENCODE_TUI_READINESS_TIMEOUT
    } else {
        NATIVE_IDENTITY_STARTUP_TIMEOUT
    }
}

#[cfg(any(test, feature = "runtime-test-faults"))]
fn stopped_repair_resume_observation_fault(
    context: &RecoveryContext,
    status: &crate::service::HostStatus,
    native_capability: bool,
    requested: bool,
    elapsed_ms: u64,
) -> Option<NativeIdentityWait> {
    (requested
        && native_capability
        && !status.exited
        && context.provider == "opencode"
        && context.native_import_state == NativeImportState::Completed
        && context.native_import_authority == "verified_import_receipt"
        && context.opencode_adoption_baseline.is_some()
        && current_native_observation(context, status).is_some())
    .then(|| NativeIdentityWait::HostUnavailable {
        message: "stopped-repair Resume observation rejected by the isolated test fault".into(),
        transient: None,
        elapsed_ms,
    })
}

fn native_identity_wait_cancellation(
    desired_state: DesiredState,
    current_intent_revision: u64,
    expected_intent_revision: u64,
    elapsed_ms: u64,
) -> Option<NativeIdentityWait> {
    if desired_state == DesiredState::Stopped {
        Some(NativeIdentityWait::StopIntent { elapsed_ms })
    } else if current_intent_revision != expected_intent_revision {
        Some(NativeIdentityWait::IntentChanged { elapsed_ms })
    } else {
        None
    }
}

fn native_identity_wait_from_status(
    exited: bool,
    native_session_id: Option<String>,
    elapsed_ms: u64,
) -> Option<NativeIdentityWait> {
    if exited {
        Some(NativeIdentityWait::ProviderExited { elapsed_ms })
    } else {
        native_session_id.map(|native_session_id| NativeIdentityWait::Observed {
            native_session_id,
            elapsed_ms,
        })
    }
}

fn validate_native_identity_wait(
    expected: &str,
    result: NativeIdentityWait,
) -> Result<String, (RecoveryBlockReason, String)> {
    match result {
        NativeIdentityWait::Observed {
            native_session_id, ..
        } if native_session_id == expected => Ok(native_session_id),
        NativeIdentityWait::Observed {
            native_session_id, ..
        } => Err((
            RecoveryBlockReason::WrongNativeIdentity,
            format!("expected native session {expected}, provider returned {native_session_id}"),
        )),
        NativeIdentityWait::ProviderExited { .. } => Err((
            RecoveryBlockReason::ProviderUnavailable,
            "provider exited before reporting its resumed native session identity".into(),
        )),
        NativeIdentityWait::TimedOut {
            adoption_pending, ..
        } => {
            let reason = if adoption_pending {
                RecoveryBlockReason::CapabilityPending
            } else {
                RecoveryBlockReason::ProviderUnavailable
            };
            Err((
                reason,
                "provider did not report its resumed native session identity before the readiness deadline"
                .into(),
            ))
        }
        NativeIdentityWait::HostUnavailable { message, .. } => {
            Err((RecoveryBlockReason::ProviderUnavailable, message))
        }
        NativeIdentityWait::StopIntent { .. } => Err((
            RecoveryBlockReason::StopIntent,
            "durable stop intent superseded provider readiness".into(),
        )),
        NativeIdentityWait::IntentChanged { .. } => Err((
            RecoveryBlockReason::ProviderUnavailable,
            "soul intent changed while waiting for provider readiness".into(),
        )),
    }
}

#[derive(Debug)]
pub(crate) enum CanonicalRootOwnerSelection<'a> {
    Chosen(&'a StoppedRepairOwnerCandidate),
    ChoiceRequired(Vec<SoulId>),
}

struct PreparedStoppedRepairRoot {
    root_session_id: String,
    target: freshell_runtime_protocol::LostSoulRepairTarget,
    captured: RecoveryContext,
    snapshot: OpenCodeNativeSnapshot,
}

enum StoppedRepairRootPreflight {
    Ready(Box<PreparedStoppedRepairRoot>),
    OwnerChoiceRequired(Vec<SoulId>),
}

pub(crate) fn choose_canonical_root_owner<'a>(
    candidates: &'a [StoppedRepairOwnerCandidate],
    source_store_id: &str,
    root_session_id: &str,
    source_generation: &str,
    choice: Option<&SoulId>,
) -> Result<CanonicalRootOwnerSelection<'a>, String> {
    let candidates = candidates
        .iter()
        .filter(|candidate| candidate.native_import_authority != "retired_duplicate")
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return Err("native root has no managed owner candidate".into());
    }
    let incompatible_receipt = candidates.iter().any(|candidate| {
        candidate.native_import_state == NativeImportState::Completed
            && candidate.native_import_authority == "verified_import_receipt"
            && candidate.root_session_id.as_deref() == Some(root_session_id)
            && (candidate.source_store_id.as_deref() != Some(source_store_id)
                || candidate.source_generation.as_deref() != Some(source_generation))
    });
    if incompatible_receipt {
        return Err("native root has a conflicting import receipt generation".into());
    }
    let receipts = candidates
        .iter()
        .filter(|candidate| {
            candidate.native_import_state == NativeImportState::Completed
                && candidate.native_import_authority == "verified_import_receipt"
                && candidate.source_store_id.as_deref() == Some(source_store_id)
                && candidate.root_session_id.as_deref() == Some(root_session_id)
                && candidate.source_generation.as_deref() == Some(source_generation)
        })
        .collect::<Vec<_>>();
    if let [owner] = receipts.as_slice() {
        if choice.is_some_and(|choice| owner.soul_id != *choice) {
            return Err("canonical owner choice conflicts with the verified import receipt".into());
        }
        return Ok(CanonicalRootOwnerSelection::Chosen(owner));
    }
    if receipts.len() > 1 {
        if let Some(choice) = choice {
            if let Some(owner) = receipts
                .iter()
                .find(|candidate| candidate.soul_id == *choice)
            {
                return Ok(CanonicalRootOwnerSelection::Chosen(owner));
            }
            return Err("canonical owner choice is not a valid receipt candidate".into());
        }
        return Ok(CanonicalRootOwnerSelection::ChoiceRequired(
            receipts
                .iter()
                .map(|candidate| candidate.soul_id.clone())
                .collect(),
        ));
    }

    let explicit = candidates
        .iter()
        .filter(|candidate| candidate.explicit_view_count > 0)
        .copied()
        .collect::<Vec<_>>();
    if let [owner] = explicit.as_slice() {
        if choice.is_some_and(|choice| owner.soul_id != *choice) {
            return Err("canonical owner choice conflicts with the unique explicit view".into());
        }
        return Ok(CanonicalRootOwnerSelection::Chosen(owner));
    }
    let choice_candidates = if explicit.len() > 1 {
        explicit
    } else {
        candidates
    };
    if let [owner] = choice_candidates.as_slice() {
        if choice.is_some_and(|choice| owner.soul_id != *choice) {
            return Err(
                "canonical owner choice conflicts with the unique remaining candidate".into(),
            );
        }
        return Ok(CanonicalRootOwnerSelection::Chosen(owner));
    }
    if let Some(choice) = choice {
        if let Some(owner) = choice_candidates
            .iter()
            .find(|candidate| candidate.soul_id == *choice)
        {
            return Ok(CanonicalRootOwnerSelection::Chosen(owner));
        }
        return Err("canonical owner choice is not a valid candidate".into());
    }
    Ok(CanonicalRootOwnerSelection::ChoiceRequired(
        choice_candidates
            .iter()
            .map(|candidate| candidate.soul_id.clone())
            .collect(),
    ))
}

fn is_lower_hex_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn stopped_repair_blocked(reason_code: &'static str) -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::RecoveryBlocked,
        format!("stopped OpenCode repair is pending ({reason_code})"),
    )
}

fn pending_stopped_repair_result(
    scope_id: &str,
    operation_id: freshell_runtime_protocol::RequestId,
    target_count: usize,
    progress: BTreeMap<String, RestoreLostSoulRootResult>,
) -> RestoreLostSoulsResult {
    RestoreLostSoulsResult {
        operation_id,
        scope_id: scope_id.to_string(),
        status: SoulRepairStatus::Pending,
        repaired_target_count: 0,
        total_target_count: target_count as u32,
        roots: progress.into_values().collect(),
    }
}

fn owner_decision_stopped_repair_result(
    scope_id: &str,
    operation_id: freshell_runtime_protocol::RequestId,
    target_count: usize,
    progress: BTreeMap<String, RestoreLostSoulRootResult>,
) -> RestoreLostSoulsResult {
    RestoreLostSoulsResult {
        operation_id,
        scope_id: scope_id.to_string(),
        status: SoulRepairStatus::OwnerDecisionRequired,
        repaired_target_count: 0,
        total_target_count: target_count as u32,
        roots: progress.into_values().collect(),
    }
}

fn stopped_repair_error_reason_code(error: &RuntimeError) -> Option<String> {
    error
        .message
        .strip_prefix("stopped OpenCode repair is pending (")
        .and_then(|message| message.strip_suffix(')'))
        .map(str::to_owned)
}

fn stopped_repair_transfer_id(
    operation_id: &freshell_runtime_protocol::RequestId,
    root_session_id: &str,
    source_generation: &str,
    canonical_soul_id: &SoulId,
) -> String {
    let input = format!(
        "{}\0{}\0{}\0{}",
        operation_id, root_session_id, source_generation, canonical_soul_id
    );
    let digest = format!("{:x}", Sha256::digest(input.as_bytes()));
    format!("stopped-repair-{}", &digest[..48])
}

fn same_stopped_repair_context(captured: &RecoveryContext, current: &RecoveryContext) -> bool {
    captured.soul_id == current.soul_id
        && captured.provider == current.provider
        && captured.provider_store_id == current.provider_store_id
        && captured.native_session_id == current.native_session_id
        && captured.native_import_revision == current.native_import_revision
        && captured.native_import_state == current.native_import_state
        && captured.native_import_source_store_id == current.native_import_source_store_id
        && captured.native_import_root_session_id == current.native_import_root_session_id
        && captured.native_import_source_generation == current.native_import_source_generation
        && captured.native_import_schema_fingerprint == current.native_import_schema_fingerprint
        && captured.native_import_migration_fingerprint
            == current.native_import_migration_fingerprint
        && captured.native_import_complete_inventory == current.native_import_complete_inventory
        && captured.native_import_authority == current.native_import_authority
        && captured.identity_revision == current.identity_revision
        && captured.evidence_revision == current.evidence_revision
        && captured.intent_revision == current.intent_revision
        && captured.desired_state == current.desired_state
        && captured.recovery_state == current.recovery_state
        && captured.control_epoch == current.control_epoch
        && captured.terminal == current.terminal
        && captured.prior_handle.incarnation_id() == current.prior_handle.incarnation_id()
        && captured.prior_handle.soul_id() == current.prior_handle.soul_id()
        && captured.prior_handle.provider_store_id() == current.prior_handle.provider_store_id()
        && captured.prior_handle.daemon_id() == current.prior_handle.daemon_id()
        && captured.prior_handle.container_id() == current.prior_handle.container_id()
        && captured.prior_handle.image_ref() == current.prior_handle.image_ref()
}

fn stopped_repair_execution_generation(
    views: &[RuntimeView],
    context: &RecoveryContext,
) -> Result<u64, ()> {
    let incarnation_id = context.prior_handle.incarnation_id();
    let old = views
        .iter()
        .find(|view| view.soul_id == context.soul_id && &view.incarnation_id == incarnation_id)
        .ok_or(())?;
    if old.launch_state != LaunchState::Stopped || old.cleanup_state != CleanupState::VerifiedEmpty
    {
        return Err(());
    }
    if views.iter().any(|view| {
        view.soul_id == context.soul_id
            && view.incarnation_id != *incarnation_id
            && view.launch_state.is_potentially_active()
    }) {
        return Err(());
    }
    Ok(old.execution_generation)
}

fn stage_snapshot_payload(
    snapshot: &OpenCodeNativeSnapshot,
    descriptor: &OpenCodeTransferDescriptor,
    attempt_id: &str,
    staging: &crate::opencode_transfer::OpenCodeTransferStaging,
    progress: &crate::opencode_transfer::StagingStart,
) -> Result<(), String> {
    let file = descriptor
        .files
        .first()
        .ok_or_else(|| "stopped repair has no payload file".to_string())?;
    let crate::opencode_transfer::StagingStart::Started {
        next_sequence,
        file_offsets,
    } = progress
    else {
        return Err("stopped repair staging has not started".into());
    };
    let [position] = file_offsets.as_slice() else {
        return Err("stopped repair staging has invalid payload offsets".into());
    };
    let chunk_bytes = MAX_OPENCODE_TRANSFER_CHUNK_BYTES as u64;
    if descriptor.files.len() != 1
        || position.file_index != file.index
        || position.next_offset > file.size_bytes
        || (position.next_offset < file.size_bytes && position.next_offset % chunk_bytes != 0)
        || *next_sequence != position.next_offset.div_ceil(chunk_bytes)
    {
        return Err("stopped repair staging has invalid payload progress".into());
    }
    let mut payload = snapshot
        .open_payload()
        .map_err(|_| "source payload cannot be reopened".to_string())?;
    // Read and verify the whole immutable source, but send only chunks after
    // the durable cursor. A retained prefix is not authority for changed bytes.
    let mut payload_digest = Sha256::new();
    let mut offset = 0_u64;
    let mut sequence = 0_u64;
    while offset < file.size_bytes {
        let chunk_size =
            (file.size_bytes - offset).min(MAX_OPENCODE_TRANSFER_CHUNK_BYTES as u64) as usize;
        let mut data = vec![0; chunk_size];
        payload
            .read_exact(&mut data)
            .map_err(|_| "source payload ended before its manifest size".to_string())?;
        payload_digest.update(&data);
        if sequence >= *next_sequence {
            let sha256 = format!("{:x}", Sha256::digest(&data));
            let chunk = OpenCodeTransferChunk {
                transfer_id: descriptor.transfer_id.clone(),
                attempt_id: attempt_id.into(),
                sequence,
                file_index: file.index,
                offset,
                sha256,
                data,
            };
            staging
                .write_chunk(&chunk)
                .map_err(|_| "stopped repair staging rejected a payload chunk".to_string())?;
        }
        offset += chunk_size as u64;
        sequence += 1;
    }
    let mut trailing = [0];
    if payload
        .read(&mut trailing)
        .map_err(|_| "source payload trailing check failed".to_string())?
        != 0
    {
        return Err("source payload exceeds its manifest size".into());
    }
    if format!("{:x}", payload_digest.finalize()) != file.sha256 {
        return Err("source payload differs from its manifest hash".into());
    }
    Ok(())
}

fn verified_stopped_repair_receipt(
    context: &RecoveryContext,
    descriptor: &OpenCodeTransferDescriptor,
    manifest: &freshell_sessions::opencode_transfer::OpenCodeTransferManifest,
    receipts: &StoppedOpenCodeRepairReceipts,
    execution_generation: u64,
) -> Result<StoppedRepairRootReceipt, ()> {
    let imported = &receipts.imported;
    let readable = &receipts.readable;
    let terminal = context.terminal.as_ref().ok_or(())?;
    let cwd = Path::new(&terminal.cwd).canonicalize().map_err(|_| ())?;
    let workspace = Path::new(&terminal.workspace_path)
        .canonicalize()
        .map_err(|_| ())?;
    if !cwd.starts_with(&workspace)
        || imported.version != 1
        || imported.transfer_id != descriptor.transfer_id
        || imported.destination_store_id != descriptor.destination_store_id
        || imported.destination_database_path != descriptor.destination_database_path
        || imported.root_session_id != descriptor.root_session_id
        || imported.source_store_id != descriptor.source_store_id
        || imported.source_generation != descriptor.source_generation
        || imported.source_schema_fingerprint != descriptor.source_schema_fingerprint
        || imported.migration_journal_fingerprint != descriptor.migration_journal_fingerprint
        || imported.target_image_ref != descriptor.target_image_ref
        || imported.target_build_receipt != descriptor.target_build_receipt
        || imported.bundle_sha256 != descriptor.bundle_sha256
        || imported.row_count != manifest.row_count as u64
        || imported.asset_count != manifest.asset_count() as u64
        || imported.saved_snapshot_summary
            != freshell_sessions::opencode_transfer::saved_snapshot_summary(manifest)
        || imported.structural_sha256.is_empty()
        || readable.version != 1
        || readable.transfer_id != descriptor.transfer_id
        || readable.destination_store_id != descriptor.destination_store_id
        || readable.root_session_id != descriptor.root_session_id
        || readable.source_generation != descriptor.source_generation
        || readable.target_image_ref != descriptor.target_image_ref
        || readable.target_build_receipt != descriptor.target_build_receipt
        || readable.provider_uid != terminal.run_as_uid
        || readable.provider_gid != terminal.run_as_gid
        || readable.home != "/home/freshell/provider"
        || readable.xdg_data_home != "/home/freshell/provider/.local/share"
        || readable.xdg_config_home != "/home/freshell/provider/.config"
        || readable.opencode_db != "/home/freshell/provider/.local/share/opencode/opencode.db"
        || readable.cwd != cwd.to_string_lossy()
        || readable.row_count != imported.row_count
        || readable.asset_count != imported.asset_count
        || readable.saved_snapshot_summary != imported.saved_snapshot_summary
        || readable.structural_sha256 != imported.structural_sha256
        || !is_lower_hex_sha256(&imported.structural_sha256)
    {
        return Err(());
    }
    let environment_receipt = serde_json::to_vec(&serde_json::json!({
        "providerUid": readable.provider_uid,
        "providerGid": readable.provider_gid,
        "home": readable.home,
        "xdgDataHome": readable.xdg_data_home,
        "xdgConfigHome": readable.xdg_config_home,
        "opencodeDb": readable.opencode_db,
        "cwd": readable.cwd,
    }))
    .map_err(|_| ())?;
    let reader_environment_sha256 = format!("{:x}", Sha256::digest(environment_receipt));
    let adoption_baseline = OpenCodeAdoptionBaseline {
        descriptor: descriptor.clone(),
        manifest_sha256: format!("{:x}", Sha256::digest(descriptor.manifest_json.as_bytes())),
    };
    adoption_baseline.validate().map_err(|_| ())?;
    Ok(StoppedRepairRootReceipt {
        root_session_id: descriptor.root_session_id.clone(),
        canonical_soul_id: context.soul_id.clone(),
        transfer_id: descriptor.transfer_id.clone(),
        adoption_baseline,
        destination_store_id: descriptor.destination_store_id.clone(),
        source_store_id: descriptor.source_store_id.clone(),
        source_generation: descriptor.source_generation.clone(),
        bundle_sha256: descriptor.bundle_sha256.clone(),
        source_schema_fingerprint: descriptor.source_schema_fingerprint.clone(),
        migration_journal_fingerprint: descriptor.migration_journal_fingerprint.clone(),
        target_image_ref: descriptor.target_image_ref.clone(),
        target_build_receipt: descriptor.target_build_receipt.clone(),
        row_count: imported.row_count,
        asset_count: imported.asset_count,
        structural_sha256: imported.structural_sha256.clone(),
        provider_uid: readable.provider_uid,
        provider_gid: readable.provider_gid,
        reader_environment_sha256,
        captured_identity_revision: context.identity_revision,
        captured_evidence_revision: context.evidence_revision,
        captured_intent_revision: context.intent_revision,
        captured_native_import_revision: context.native_import_revision,
        captured_native_import_state: context.native_import_state.as_str().into(),
        captured_native_import_authority: context.native_import_authority.clone(),
        incarnation_id: context.prior_handle.incarnation_id().clone(),
        execution_generation,
    })
}

impl Supervisor {
    pub(crate) async fn preflight_lost_souls(
        &self,
        request: freshell_runtime_protocol::PreflightLostSoulsRequest,
    ) -> Result<freshell_runtime_protocol::RepairBatchScope, RuntimeError> {
        self.registry
            .assert_epoch(request.expected_control_epoch)
            .map_err(map_registry)?;
        let inventory = tokio::task::spawn_blocking(
            HostOpenCodeInventory::from_process_environment_discovering_channels,
        )
        .await
        .map_err(|_| stopped_repair_blocked("source_inventory_worker_failed"))?
        .map_err(|_| stopped_repair_blocked("source_inventory_unreadable"))?;
        self.preflight_lost_souls_from_inventory(request, inventory)
            .await
    }

    pub(crate) async fn preflight_lost_souls_from_inventory(
        &self,
        request: freshell_runtime_protocol::PreflightLostSoulsRequest,
        inventory: HostOpenCodeInventory,
    ) -> Result<freshell_runtime_protocol::RepairBatchScope, RuntimeError> {
        self.registry
            .assert_epoch(request.expected_control_epoch)
            .map_err(map_registry)?;
        let targets = self
            .registry
            .repair_scope_members(request.source.clone())
            .await
            .map_err(map_registry)?;
        let mut groups = StoppedRepairGroups::new();
        for member in &targets {
            let context = self
                .registry
                .recovery_context(member.target.soul_id.clone())
                .await
                .map_err(map_registry)?;
            if context.identity_revision != member.identity_revision
                || context.intent_revision != member.target.expected_intent_revision
                || context.provider_store_id != member.provider_store_id
                || context.native_import_revision != member.native_import_revision
                || context.evidence_revision != member.evidence_revision
            {
                return Err(stopped_repair_blocked(
                    "target_scope_changed_during_preflight",
                ));
            }
            groups
                .entry(member.root_session_id.clone())
                .or_default()
                .push((member.target.clone(), context));
        }
        let inventory = self
            .capture_stopped_opencode_batch(&groups, inventory)
            .await?;
        let mut roots = Vec::new();
        for (root, contexts) in &groups {
            let snapshot = self
                .export_stopped_opencode_root(root, contexts, &inventory)
                .await?;
            let manifest = snapshot.manifest();
            if manifest.source_store_id != request.source.source_store_id {
                return Err(stopped_repair_blocked("source_store_reference_mismatch"));
            }
            let candidates = self
                .registry
                .stopped_repair_owner_candidates(root.clone())
                .await
                .map_err(map_registry)?;
            let selection = choose_canonical_root_owner(
                &candidates,
                &manifest.source_store_id,
                root,
                &manifest.generation,
                None,
            )
            .map_err(|_| stopped_repair_blocked("canonical_owner_receipt_conflict"))?;
            let (eligible_owners, canonical_soul_id) = match selection {
                CanonicalRootOwnerSelection::Chosen(owner) => {
                    (vec![owner.soul_id.clone()], Some(owner.soul_id.clone()))
                }
                CanonicalRootOwnerSelection::ChoiceRequired(owners) => (owners, None),
            };
            if eligible_owners.is_empty()
                || eligible_owners
                    .iter()
                    .any(|owner| !contexts.iter().any(|(target, _)| target.soul_id == *owner))
            {
                return Err(stopped_repair_blocked(
                    "canonical_owner_outside_exact_batch",
                ));
            }
            roots.push(freshell_runtime_protocol::RepairBatchRoot {
                root_session_id: root.clone(),
                graph_digest: manifest.generation.clone(),
                eligible_owners,
                canonical_soul_id,
            });
        }
        let mut scope = freshell_runtime_protocol::RepairBatchScope {
            scope_id: String::new(),
            source_store_id: request.source.source_store_id,
            source_fingerprint: String::new(),
            targets,
            roots,
        };
        scope.source_fingerprint = scope.source_descriptor_digest();
        scope.scope_id = scope.descriptor_digest();
        // Preflight creates no registry operation, and a concurrent change
        // must invalidate the preview before it can be presented for choices.
        if self
            .registry
            .repair_scope_members(scope.source_selection())
            .await
            .map_err(map_registry)?
            != scope.targets
        {
            return Err(stopped_repair_blocked(
                "target_scope_changed_during_preflight",
            ));
        }
        Ok(scope)
    }

    pub(crate) async fn restore_lost_souls(
        &self,
        operation_id: freshell_runtime_protocol::RequestId,
        request: RestoreLostSoulsRequest,
    ) -> Result<RestoreLostSoulsResult, RuntimeError> {
        self.restore_lost_souls_with_inventory(operation_id, request, async {
            tokio::task::spawn_blocking(
                HostOpenCodeInventory::from_process_environment_discovering_channels,
            )
            .await
            .map_err(|_| stopped_repair_blocked("source_inventory_worker_failed"))?
            .map_err(|_| stopped_repair_blocked("source_inventory_unreadable"))
        })
        .await
    }

    pub(crate) async fn restore_lost_souls_with_inventory(
        &self,
        operation_id: freshell_runtime_protocol::RequestId,
        request: RestoreLostSoulsRequest,
        source_inventory: impl std::future::Future<Output = Result<HostOpenCodeInventory, RuntimeError>>,
    ) -> Result<RestoreLostSoulsResult, RuntimeError> {
        let scope = match self
            .registry
            .stopped_repair_operation_scope(operation_id.clone())
            .await
            .map_err(map_registry)?
        {
            Some(scope) => scope,
            None => {
                for target in &request.targets {
                    let context = self
                        .registry
                        .recovery_context(target.soul_id.clone())
                        .await
                        .map_err(map_registry)?;
                    if context.intent_revision != target.expected_intent_revision {
                        return Err(map_registry(RegistryError::StaleIntentRevision {
                            expected: target.expected_intent_revision,
                            current: context.intent_revision,
                        }));
                    }
                }
                self.preflight_lost_souls(freshell_runtime_protocol::PreflightLostSoulsRequest {
                    source: request.source.clone(),
                    expected_control_epoch: request.expected_control_epoch,
                })
                .await?
            }
        };
        request.validate_exact_batch(&scope)?;
        let targets = request.targets.clone();
        let owner_choices = request
            .canonical_owners
            .iter()
            .map(|choice| (choice.root_session_id.clone(), choice.soul_id.clone()))
            .collect::<BTreeMap<_, _>>();
        let operation = self
            .registry
            .prepare_stopped_repair_operation(operation_id.clone(), request, scope.clone())
            .await
            .map_err(map_registry)?;
        if operation.status == "complete" {
            return operation
                .result_json
                .as_deref()
                .ok_or_else(|| {
                    RuntimeError::new(
                        RuntimeErrorCode::RegistryFailure,
                        "completed stopped-repair operation has no persisted result",
                    )
                })
                .and_then(|encoded| {
                    serde_json::from_str(encoded).map_err(|error| {
                        RuntimeError::new(
                            RuntimeErrorCode::RegistryFailure,
                            format!("completed stopped-repair result is invalid: {error}"),
                        )
                    })
                });
        }

        if operation.status == "withdraw_pending" {
            let roots = self
                .registry
                .stopped_repair_root_receipts(operation_id.clone())
                .await
                .map_err(map_registry)?;
            return self
                .finalize_stopped_repair_batch(
                    operation_id,
                    targets,
                    roots,
                    self.registry.registry_root().join("incidents"),
                    self.config.lifecycle_log.clone(),
                )
                .await
                .map_err(map_registry);
        }

        let mut soul_ids = targets
            .iter()
            .map(|target| target.soul_id.clone())
            .collect::<Vec<_>>();
        soul_ids.sort_by(|left, right| left.as_str().cmp(right.as_str()));
        soul_ids.dedup();
        let mut lifecycle_locks = Vec::with_capacity(soul_ids.len());
        for soul_id in &soul_ids {
            lifecycle_locks.push(self.lifecycle_lock(soul_id).await);
        }
        let mut _repair_guards = Vec::with_capacity(lifecycle_locks.len());
        for lifecycle_lock in lifecycle_locks {
            _repair_guards.push(lifecycle_lock.lock_owned().await);
        }

        let mut groups = StoppedRepairGroups::new();
        for target in &targets {
            let context = self
                .registry
                .recovery_context(target.soul_id.clone())
                .await
                .map_err(map_registry)?;
            if context.intent_revision != target.expected_intent_revision {
                return Err(map_registry(RegistryError::StaleIntentRevision {
                    expected: target.expected_intent_revision,
                    current: context.intent_revision,
                }));
            }
            let root = context
                .native_import_root_session_id
                .as_deref()
                .or(context.native_session_id.as_deref())
                .filter(|root| !root.is_empty())
                .ok_or_else(|| {
                    RuntimeError::new(
                        RuntimeErrorCode::RecoveryBlocked,
                        "stopped OpenCode repair target has no exact native root identifier",
                    )
                })?
                .to_string();
            groups
                .entry(root)
                .or_default()
                .push((target.clone(), context));
        }

        let mut progress = groups
            .keys()
            .map(|root| {
                (
                    root.clone(),
                    RestoreLostSoulRootResult {
                        root_session_id: root.clone(),
                        canonical_soul_id: None,
                        import_status: RootRepairImportStatus::Pending,
                        intent_revision: None,
                        native_import_revision: None,
                        owner_candidates: Vec::new(),
                        reason_code: None,
                    },
                )
            })
            .collect::<BTreeMap<_, _>>();
        if groups.len() != scope.roots.len() {
            return Ok(pending_stopped_repair_result(
                &scope.scope_id,
                operation_id,
                targets.len(),
                progress,
            ));
        }

        if owner_choices.keys().any(|root| !groups.contains_key(root)) {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                "canonical owner choice names a root outside this exact repair batch",
            ));
        }

        let inventory = match source_inventory.await {
            Ok(inventory) => inventory,
            Err(error) => {
                let reason = match stopped_repair_error_reason_code(&error).as_deref() {
                    Some("source_inventory_worker_failed") => "source_inventory_worker_failed",
                    _ => "source_inventory_unreadable",
                };
                return Ok(self.pending_stopped_repair_source_failure(
                    &scope,
                    operation_id,
                    &groups,
                    progress,
                    reason,
                ));
            }
        };
        let inventory = match self
            .capture_stopped_opencode_batch(&groups, inventory)
            .await
        {
            Ok(inventory) => inventory,
            Err(error) => {
                let reason = match stopped_repair_error_reason_code(&error).as_deref() {
                    Some("terminal_workspace_missing") => "terminal_workspace_missing",
                    Some("source_capture_worker_failed") => "source_capture_worker_failed",
                    _ => "source_not_exactly_resolvable",
                };
                return Ok(self.pending_stopped_repair_source_failure(
                    &scope,
                    operation_id,
                    &groups,
                    progress,
                    reason,
                ));
            }
        };

        let mut prepared_roots = Vec::with_capacity(groups.len());
        let mut owner_decision_required = false;
        let mut preflight_blocked = false;
        for (root, target_contexts) in &groups {
            match self
                .preflight_stopped_opencode_root(
                    root,
                    target_contexts,
                    &inventory,
                    &targets,
                    owner_choices.get(root),
                )
                .await
            {
                Ok(StoppedRepairRootPreflight::Ready(prepared)) => {
                    if prepared.snapshot.manifest().source_store_id != scope.source_store_id
                        || !scope.roots.iter().any(|scoped| {
                            scoped.root_session_id == *root
                                && scoped.graph_digest == prepared.snapshot.manifest().generation
                        })
                    {
                        return Ok(self.pending_stopped_repair_source_failure(
                            &scope,
                            operation_id,
                            &groups,
                            progress,
                            "source_scope_changed_before_import",
                        ));
                    }
                    progress
                        .get_mut(root)
                        .expect("root progress initialized")
                        .canonical_soul_id = Some(prepared.target.soul_id.clone());
                    progress
                        .get_mut(root)
                        .expect("root progress initialized")
                        .intent_revision = Some(prepared.target.expected_intent_revision);
                    prepared_roots.push(*prepared);
                }
                Ok(StoppedRepairRootPreflight::OwnerChoiceRequired(candidates)) => {
                    owner_decision_required = true;
                    let root_progress = progress.get_mut(root).expect("root progress initialized");
                    root_progress.import_status = RootRepairImportStatus::OwnerDecisionRequired;
                    root_progress.owner_candidates = candidates;
                }
                Err(error) if error.code == RuntimeErrorCode::StaleIntentRevision => {
                    return Err(error);
                }
                Err(error) => {
                    preflight_blocked = true;
                    progress
                        .get_mut(root)
                        .expect("root progress initialized")
                        .reason_code = stopped_repair_error_reason_code(&error);
                }
            }
        }

        if owner_decision_required {
            return Ok(owner_decision_stopped_repair_result(
                &scope.scope_id,
                operation_id,
                targets.len(),
                progress,
            ));
        }
        if preflight_blocked || prepared_roots.len() != groups.len() {
            return Ok(pending_stopped_repair_result(
                &scope.scope_id,
                operation_id,
                targets.len(),
                progress,
            ));
        }

        let mut verified_roots = Vec::with_capacity(groups.len());
        for prepared in prepared_roots {
            let root = prepared.root_session_id.clone();
            match self
                .repair_stopped_opencode_root(&operation_id, prepared)
                .await
            {
                Ok((target, receipt)) => {
                    progress.insert(
                        root.clone(),
                        RestoreLostSoulRootResult {
                            root_session_id: root,
                            canonical_soul_id: Some(target.soul_id.clone()),
                            import_status: RootRepairImportStatus::ProviderReadable,
                            intent_revision: Some(target.expected_intent_revision),
                            native_import_revision: Some(receipt.captured_native_import_revision),
                            owner_candidates: Vec::new(),
                            reason_code: None,
                        },
                    );
                    verified_roots.push(receipt);
                }
                Err(error) if error.code == RuntimeErrorCode::StaleIntentRevision => {
                    return Err(error);
                }
                Err(error) => {
                    progress
                        .get_mut(&root)
                        .expect("root progress initialized")
                        .reason_code = stopped_repair_error_reason_code(&error);
                    return Ok(pending_stopped_repair_result(
                        &scope.scope_id,
                        operation_id,
                        targets.len(),
                        progress,
                    ));
                }
            }
        }
        let receipts = self
            .registry
            .stopped_repair_root_receipts(operation_id.clone())
            .await
            .map_err(map_registry)?;
        if receipts.len() != scope.roots.len()
            || receipts
                .iter()
                .any(|receipt| !verified_roots.iter().any(|current| current == receipt))
        {
            return Ok(pending_stopped_repair_result(
                &scope.scope_id,
                operation_id,
                targets.len(),
                progress,
            ));
        }
        self.finalize_stopped_repair_batch(
            operation_id,
            targets,
            receipts,
            self.registry.registry_root().join("incidents"),
            self.config.lifecycle_log.clone(),
        )
        .await
        .map_err(map_registry)
    }

    async fn export_stopped_opencode_root(
        &self,
        root_session_id: &str,
        target_contexts: &[(
            freshell_runtime_protocol::LostSoulRepairTarget,
            RecoveryContext,
        )],
        inventory: &HostOpenCodeInventory,
    ) -> Result<OpenCodeNativeSnapshot, RuntimeError> {
        let mut trusted_workspaces = Vec::<PathBuf>::new();
        for (_, context) in target_contexts {
            let workspace = context
                .terminal
                .as_ref()
                .map(|terminal| PathBuf::from(&terminal.workspace_path))
                .ok_or_else(|| stopped_repair_blocked("terminal_workspace_missing"))?
                .canonicalize()
                .map_err(|_| stopped_repair_blocked("terminal_workspace_missing"))?;
            if !trusted_workspaces.contains(&workspace) {
                trusted_workspaces.push(workspace);
            }
        }
        let extraction_root = self
            .config
            .runtime_root
            .join("stopped-opencode-repair-extractions");
        let source_inventory = trusted_workspaces
            .into_iter()
            .fold(inventory.clone(), |inventory, workspace| {
                inventory.with_trusted_mount_for_selected_session(workspace)
            });
        let root = root_session_id.to_string();
        let source_database = source_inventory.declared_default_database().to_path_buf();
        let options = stopped_source_export_options(
            extraction_root,
            self.config.lifecycle_log.clone(),
            "export",
            target_contexts
                .iter()
                .map(|(target, context)| {
                    source_transfer_target_context(root_session_id, target, context)
                })
                .collect(),
        );
        let snapshot = tokio::task::spawn_blocking(move || {
            export_exact_session(&source_inventory, &root, options)
        })
        .await
        .map_err(|_| stopped_repair_blocked("source_export_worker_failed"))?
        .map_err(|error| {
            stopped_repair_transfer_failure(
                &self.config.lifecycle_log,
                "export",
                &source_database,
                &[root_session_id.to_string()],
                &error,
            )
        })?;
        Ok(snapshot)
    }

    fn pending_stopped_repair_source_failure(
        &self,
        scope: &freshell_runtime_protocol::RepairBatchScope,
        operation_id: freshell_runtime_protocol::RequestId,
        groups: &StoppedRepairGroups,
        mut progress: BTreeMap<String, RestoreLostSoulRootResult>,
        reason_code: &'static str,
    ) -> RestoreLostSoulsResult {
        for root in progress.values_mut() {
            root.reason_code = Some(reason_code.to_string());
        }
        for (root, targets) in groups {
            let generation = scope
                .roots
                .iter()
                .find(|member| member.root_session_id == *root)
                .map(|member| member.graph_digest.as_str());
            for (target, context) in targets {
                let captured = scope
                    .targets
                    .iter()
                    .find(|member| member.target.soul_id == target.soul_id);
                crate::service::append_event(
                    &self.config.lifecycle_log,
                    "supervisor.stopped_repair.source_failed",
                    serde_json::json!({
                        "severity": "error", "reasonCode": reason_code,
                        "operationId": operation_id, "scopeId": scope.scope_id,
                        "sourceStoreId": scope.source_store_id, "sourceFingerprint": scope.source_fingerprint,
                        "rootSessionId": root, "sourceGeneration": generation,
                        "soulId": target.soul_id, "incarnationId": context.prior_handle.incarnation_id(),
                        "intentRevision": target.expected_intent_revision,
                        "incidentId": target.incident_id,
                        "incidentRevision": captured.map(|member| member.incident_revision),
                        "identityRevision": captured.map(|member| member.identity_revision),
                        "nativeImportRevision": captured.map(|member| member.native_import_revision),
                        "evidenceRevision": captured.map(|member| member.evidence_revision),
                    }),
                );
            }
        }
        pending_stopped_repair_result(&scope.scope_id, operation_id, scope.targets.len(), progress)
    }

    async fn capture_stopped_opencode_batch(
        &self,
        groups: &StoppedRepairGroups,
        mut inventory: HostOpenCodeInventory,
    ) -> Result<HostOpenCodeInventory, RuntimeError> {
        for (_, context) in groups.values().flatten() {
            let workspace = context
                .terminal
                .as_ref()
                .map(|terminal| PathBuf::from(&terminal.workspace_path))
                .ok_or_else(|| stopped_repair_blocked("terminal_workspace_missing"))?
                .canonicalize()
                .map_err(|_| stopped_repair_blocked("terminal_workspace_missing"))?;
            inventory = inventory.with_trusted_mount_for_selected_session(workspace);
        }
        let roots = groups.keys().cloned().collect::<Vec<_>>();
        let selected_roots = roots.clone();
        let source_database = inventory.declared_default_database().to_path_buf();
        let extraction_root = self
            .config
            .runtime_root
            .join("stopped-opencode-repair-extractions");
        let options = stopped_source_export_options(
            extraction_root,
            self.config.lifecycle_log.clone(),
            "capture",
            groups
                .iter()
                .flat_map(|(root, contexts)| {
                    contexts.iter().map(move |(target, context)| {
                        source_transfer_target_context(root, target, context)
                    })
                })
                .collect(),
        );
        tokio::task::spawn_blocking(move || {
            capture_qualified_batch(&inventory, &roots, options).map(|capture| capture.inventory())
        })
        .await
        .map_err(|_| stopped_repair_blocked("source_capture_worker_failed"))?
        .map_err(|error| {
            stopped_repair_transfer_failure(
                &self.config.lifecycle_log,
                "capture",
                &source_database,
                &selected_roots,
                &error,
            )
        })
    }

    async fn preflight_stopped_opencode_root(
        &self,
        root_session_id: &str,
        target_contexts: &[(
            freshell_runtime_protocol::LostSoulRepairTarget,
            RecoveryContext,
        )],
        inventory: &HostOpenCodeInventory,
        all_targets: &[freshell_runtime_protocol::LostSoulRepairTarget],
        owner_choice: Option<&SoulId>,
    ) -> Result<StoppedRepairRootPreflight, RuntimeError> {
        let snapshot = self
            .export_stopped_opencode_root(root_session_id, target_contexts, inventory)
            .await?;
        let manifest = snapshot.manifest().clone();
        if manifest.root_session_id != root_session_id
            || manifest.provider_schema != "opencode-1.18.21"
            || manifest.payload_bytes == 0
            || manifest.payload_bytes > MAX_OPENCODE_TRANSFER_BUNDLE_BYTES
            || manifest.row_count == 0
        {
            return Err(stopped_repair_blocked("source_bundle_preflight_failed"));
        }
        let owner_candidates = self
            .registry
            .stopped_repair_owner_candidates(root_session_id.to_string())
            .await
            .map_err(map_registry)?;
        let canonical = choose_canonical_root_owner(
            &owner_candidates,
            &manifest.source_store_id,
            root_session_id,
            &manifest.generation,
            owner_choice,
        )
        .map_err(|reason| {
            let reason_code = if reason.contains("choice") {
                "canonical_owner_choice_invalid"
            } else if reason.contains("receipt") {
                "canonical_owner_receipt_conflict"
            } else {
                "canonical_owner_ambiguous"
            };
            stopped_repair_blocked(reason_code)
        })?;
        let canonical = match canonical {
            CanonicalRootOwnerSelection::Chosen(canonical) => canonical,
            CanonicalRootOwnerSelection::ChoiceRequired(candidates) => {
                return Ok(StoppedRepairRootPreflight::OwnerChoiceRequired(candidates));
            }
        };
        if !all_targets
            .iter()
            .any(|target| target.soul_id == canonical.soul_id)
        {
            return Err(stopped_repair_blocked(
                "canonical_owner_outside_exact_batch",
            ));
        }
        let (target, captured) = target_contexts
            .iter()
            .find(|(target, _)| target.soul_id == canonical.soul_id)
            .ok_or_else(|| stopped_repair_blocked("canonical_owner_has_no_loss_target"))?;
        let fresh = self
            .registry
            .recovery_context(canonical.soul_id.clone())
            .await
            .map_err(map_registry)?;
        if !same_stopped_repair_context(captured, &fresh) {
            return Err(stopped_repair_blocked(
                "target_generation_changed_before_import",
            ));
        }
        if captured.terminal.is_none() {
            return Err(stopped_repair_blocked("terminal_workspace_missing"));
        }
        Ok(StoppedRepairRootPreflight::Ready(Box::new(
            PreparedStoppedRepairRoot {
                root_session_id: root_session_id.to_owned(),
                target: target.clone(),
                captured: captured.clone(),
                snapshot,
            },
        )))
    }

    async fn repair_stopped_opencode_root(
        &self,
        operation_id: &freshell_runtime_protocol::RequestId,
        prepared: PreparedStoppedRepairRoot,
    ) -> Result<
        (
            freshell_runtime_protocol::LostSoulRepairTarget,
            StoppedRepairRootReceipt,
        ),
        RuntimeError,
    > {
        let root_session_id = prepared.root_session_id.as_str();
        let target = &prepared.target;
        let captured = &prepared.captured;
        let snapshot = prepared.snapshot;
        let manifest = snapshot.manifest().clone();
        let transfer_id = stopped_repair_transfer_id(
            operation_id,
            root_session_id,
            &manifest.generation,
            &target.soul_id,
        );
        let files = vec![OpenCodeTransferFile {
            index: 0,
            relative_path: "payload.json".into(),
            size_bytes: manifest.payload_bytes,
            sha256: manifest.payload_sha256.clone(),
        }];
        let manifest_json = serde_json::to_string(&manifest)
            .map_err(|_| stopped_repair_blocked("source_manifest_invalid"))?;
        let target_image_ref = captured.prior_handle.image_ref().to_string();
        let mut descriptor = OpenCodeTransferDescriptor {
            transfer_id: transfer_id.clone(),
            provider: "opencode".into(),
            source_store_id: manifest.source_store_id.clone(),
            root_session_id: root_session_id.into(),
            source_generation: manifest.generation.clone(),
            provider_schema: manifest.provider_schema.clone(),
            source_schema_fingerprint: manifest.source_schema_fingerprint.clone(),
            migration_journal_fingerprint: manifest.migration_journal_fingerprint.clone(),
            destination_store_id: captured.provider_store_id.clone(),
            destination_database_path: OPENCODE_TRANSFER_DESTINATION_DB.into(),
            target_build_receipt: opencode_target_build_receipt(
                &target_image_ref,
                &manifest.provider_schema,
            ),
            target_image_ref,
            incarnation_id: captured.prior_handle.incarnation_id().to_string(),
            manifest_json,
            files,
            total_bytes: manifest.payload_bytes,
            bundle_sha256: String::new(),
        };
        descriptor.bundle_sha256 =
            opencode_transfer_bundle_digest(&descriptor.manifest_json, &descriptor.files);
        descriptor
            .validate()
            .map_err(|_| stopped_repair_blocked("source_bundle_descriptor_invalid"))?;

        let attempt_id = uuid::Uuid::new_v4().simple().to_string();
        let staging = &self.opencode_transfer_staging;
        let mut lifecycle_guard = Some(
            Arc::clone(&self.opencode_transfer_lifecycle_lock)
                .lock_owned()
                .await,
        );
        let begin = staging
            .begin_from_filesystem(&descriptor, &attempt_id)
            .map_err(|_| stopped_repair_blocked("staging_capacity_or_state"))?;
        let progress = match begin {
            crate::opencode_transfer::StagingStart::Queued => {
                drop(lifecycle_guard.take());
                let progress = staging
                    .wait_for_capacity(&transfer_id, &attempt_id)
                    .await
                    .map_err(|_| stopped_repair_blocked("staging_capacity_or_state"))?;
                if matches!(progress, crate::opencode_transfer::StagingStart::Queued) {
                    return Err(stopped_repair_blocked("staging_capacity_or_state"));
                }
                lifecycle_guard = Some(
                    Arc::clone(&self.opencode_transfer_lifecycle_lock)
                        .lock_owned()
                        .await,
                );
                progress
            }
            progress => progress,
        };
        if stage_snapshot_payload(&snapshot, &descriptor, &attempt_id, staging, &progress).is_err()
        {
            if let Some(_guard) = lifecycle_guard.take() {
                let _ = staging.abort(&transfer_id, &attempt_id);
            }
            return Err(stopped_repair_blocked("staging_write_failed"));
        }
        let ready_dir = match staging
            .finalize(&transfer_id, &attempt_id)
            .and_then(|_| staging.verify_ready(&descriptor))
        {
            Ok(path) => path,
            Err(_) => {
                if let Some(_guard) = lifecycle_guard.take() {
                    let _ = staging.abort(&transfer_id, &attempt_id);
                }
                return Err(stopped_repair_blocked("staging_finalize_failed"));
            }
        };
        let fresh_before_helper = self
            .registry
            .recovery_context(target.soul_id.clone())
            .await
            .map_err(map_registry)?;
        if !same_stopped_repair_context(captured, &fresh_before_helper) {
            let _ = staging.abort(&transfer_id, &attempt_id);
            return Err(stopped_repair_blocked(
                "target_generation_changed_before_import",
            ));
        }
        let before_helper_views = self.registry.inventory().await.map_err(map_registry)?;
        let execution_generation =
            stopped_repair_execution_generation(&before_helper_views, captured)
                .map_err(|_| stopped_repair_blocked("old_cleanup_not_settled"))?;
        let receipts = match self
            .backend
            .repair_stopped_opencode(&captured.prior_handle, &descriptor, &ready_dir)
            .await
        {
            Ok(receipts) => receipts,
            Err(error) => {
                let aborted = staging.abort(&transfer_id, &attempt_id);
                log_stopped_repair_import_failure(
                    &self.config.lifecycle_log,
                    serde_json::json!({
                        "severity":"error", "reasonCode":"provider_reader_or_import_failed",
                        "operationId":operation_id, "rootSessionId":root_session_id,
                        "soulId":target.soul_id, "incarnationId":captured.prior_handle.incarnation_id(),
                        "intentRevision":target.expected_intent_revision, "incidentId":target.incident_id,
                        "identityRevision":captured.identity_revision, "evidenceRevision":captured.evidence_revision,
                        "nativeImportRevision":captured.native_import_revision,
                        "executionGeneration":execution_generation, "sourceStoreId":descriptor.source_store_id,
                        "sourceGeneration":descriptor.source_generation, "transferId":transfer_id,
                    }),
                    &error,
                    aborted,
                );
                return Err(stopped_repair_blocked("provider_reader_or_import_failed"));
            }
        };
        stopped_repair_crash_boundary("stopped_repair_after_import_publication");
        let after_helper_views = self.registry.inventory().await.map_err(map_registry)?;
        if stopped_repair_execution_generation(&after_helper_views, captured)
            .map_err(|_| stopped_repair_blocked("old_cleanup_generation_changed"))?
            != execution_generation
        {
            let _ = staging.abort(&transfer_id, &attempt_id);
            return Err(stopped_repair_blocked("old_cleanup_generation_changed"));
        }
        let summary = match verified_stopped_repair_receipt(
            captured,
            &descriptor,
            &manifest,
            &receipts,
            execution_generation,
        ) {
            Ok(summary) => summary,
            Err(_) => {
                let _ = staging.abort(&transfer_id, &attempt_id);
                return Err(stopped_repair_blocked("provider_reader_receipt_mismatch"));
            }
        };
        self.registry
            .persist_stopped_repair_root_receipt(
                operation_id.clone(),
                target.clone(),
                captured.clone(),
                summary.clone(),
            )
            .await
            .map_err(map_registry)?;
        let _references = self
            .registry
            .opencode_transfer_stage_references()
            .await
            .map_err(map_registry)?;
        let referenced = _references
            .keys()
            .cloned()
            .collect::<std::collections::HashSet<_>>();
        staging
            .abort_with_references(&transfer_id, &attempt_id, &referenced)
            .map_err(|_| stopped_repair_blocked("verified_stage_cleanup_pending"))?;
        drop(lifecycle_guard.take());
        Ok((target.clone(), summary))
    }

    pub(crate) async fn probe_recovery(
        &self,
        soul_id: SoulId,
    ) -> Result<RecoveryProbe, RuntimeError> {
        let lifecycle_lock = self.lifecycle_lock(&soul_id).await;
        let _guard = lifecycle_lock.lock().await;
        self.probe_recovery_inner(soul_id).await
    }

    pub(crate) async fn probe_recovery_locked(
        &self,
        soul_id: SoulId,
    ) -> Result<RecoveryProbe, RuntimeError> {
        self.probe_recovery_inner(soul_id).await
    }

    async fn probe_recovery_inner(&self, soul_id: SoulId) -> Result<RecoveryProbe, RuntimeError> {
        Ok(self.probe_recovery_observed(soul_id).await?.0)
    }

    async fn probe_recovery_observed(
        &self,
        soul_id: SoulId,
    ) -> Result<(RecoveryProbe, RecoveryContext), RuntimeError> {
        let (probe, context, _) = self.probe_recovery_for_attempt(soul_id).await?;
        Ok((probe, context))
    }

    async fn probe_recovery_for_attempt(
        &self,
        soul_id: SoulId,
    ) -> Result<
        (
            RecoveryProbe,
            RecoveryContext,
            Option<TransientRecoveryFailure>,
        ),
        RuntimeError,
    > {
        let (probe, context, transient) = Box::pin(self.classify_recovery(soul_id)).await?;
        self.log_recovery_preflight(&context, &probe);
        Ok((probe, context, transient))
    }

    async fn classify_recovery(
        &self,
        soul_id: SoulId,
    ) -> Result<
        (
            RecoveryProbe,
            RecoveryContext,
            Option<TransientRecoveryFailure>,
        ),
        RuntimeError,
    > {
        let mut context = self
            .registry
            .recovery_context(soul_id)
            .await
            .map_err(map_registry)?;
        let mut transient = None;
        let probe = Box::pin(self.probe_recovery_context(&mut context, &mut transient)).await?;
        let probe = match probe {
            RecoveryProbe::ResumeReady { resume_spec, .. } => {
                // Validate even an unchanged proof against the current attempt;
                // the recovery capture is idempotent after checking its fence.
                let stored = self
                    .registry
                    .store_verified_recovery_resume_spec_fenced(
                        context.soul_id.clone(),
                        *resume_spec,
                        context.write_fence(),
                    )
                    .await
                    .map_err(map_registry)?;
                context.evidence_revision = stored.evidence_revision;
                context.allocation_state = stored.allocation_state;
                context.resume_spec = Some(stored.clone());
                RecoveryProbe::ResumeReady {
                    evidence_revision: stored.evidence_revision,
                    resume_spec: Box::new(stored),
                }
            }
            probe => probe,
        };
        if !matches!(
            probe,
            RecoveryProbe::ReattachReady { .. } | RecoveryProbe::ResumeReady { .. }
        ) && context.desired_state == DesiredState::Running
            && context.provider == "opencode"
            // A completed receipt describes the installed destination, whether
            // its baseline came from ordinary import or stopped repair. A new
            // origin-source census cannot replace that import authority.
            && !(context.native_import_state == NativeImportState::Completed
                && context.native_import_authority == "verified_import_receipt")
            && !matches!(
                context.native_import_state,
                NativeImportState::NotApplicable
                    | NativeImportState::LegacyUnknown
                    | NativeImportState::Pending
                    | NativeImportState::Partial
            )
        {
            let inventory = tokio::task::spawn_blocking(
                HostOpenCodeInventory::from_process_environment_discovering_channels,
            )
            .await
            .map_err(|error| {
                RuntimeError::new(
                    RuntimeErrorCode::RegistryFailure,
                    format!("source inventory discovery worker failed: {error}"),
                )
            })?;
            context = self
                .registry
                .refresh_native_import_inventory(&context, inventory)
                .await
                .map_err(map_registry)?;
            crate::service::append_event(
                &self.config.lifecycle_log,
                "supervisor.recovery.native_import_inventory",
                serde_json::json!({
                    "soulId": context.soul_id, "state": context.native_import_state.as_str(), "revision": context.native_import_revision,
                    "complete": context.native_import_complete_inventory,
                }),
            );
        }
        let probe = after_native_probe(&context, probe);
        let transient = transient.filter(|failure| matches!(&probe,RecoveryProbe::Blocked { reason, .. } if failure.permits(*reason)));
        Ok((probe, context, transient))
    }

    fn log_recovery_preflight(&self, context: &RecoveryContext, probe: &RecoveryProbe) {
        let (block_reason, repair) = match probe {
            RecoveryProbe::Blocked {
                reason, retry_hint, ..
            } => (Some(reason), retry_hint.repair.as_deref()),
            _ => (None, None),
        };
        crate::service::append_event(
            &self.config.lifecycle_log,
            "supervisor.recovery.preflight",
            serde_json::json!({
                "severity": if block_reason.is_some() {"warn"} else {"info"},
                "soulId": context.soul_id,
                "incarnationId": context.prior_handle.incarnation_id(),
                "intentRevision": context.intent_revision,
                "identityRevision": context.identity_revision,
                "evidenceRevision": context.evidence_revision,
                "controlEpoch": context.control_epoch,
                "launchPolicy": context.prior_handle.launch_policy(),
                "classification": match probe {
                    RecoveryProbe::Blocked { .. } => "blocked",
                    RecoveryProbe::ReattachReady { .. } => "reattach_ready",
                    RecoveryProbe::ResumeReady { .. } => "resume_ready",
                    RecoveryProbe::PristineSeedReady { .. } => "pristine_seed_ready",
                    RecoveryProbe::DefinitivelyUnavailable { .. } => "definitively_unavailable",
                },
                "blockReason": block_reason,
                "repair": preflight_diagnostic_repair(repair),
                "matcherReason": preflight_diagnostic_repair(repair),
                "attemptReserved": context.recovery_attempt_id.is_some(),
            }),
        );
    }

    async fn probe_recovery_context(
        &self,
        context: &mut RecoveryContext,
        transient: &mut Option<TransientRecoveryFailure>,
    ) -> Result<RecoveryProbe, RuntimeError> {
        if context.desired_state == DesiredState::Stopped {
            return Ok(blocked(
                RecoveryPath::Reattach,
                RecoveryBlockReason::StopIntent,
                "the durable desired state is STOPPED",
                None,
            ));
        }

        let inspection = match self.backend.inspect(&context.prior_handle).await {
            Ok(inspection) => inspection,
            Err(BackendError::OwnershipMismatch(message)) => {
                return Ok(blocked(
                    RecoveryPath::Reattach,
                    RecoveryBlockReason::OldRuntimeNotEmpty,
                    &message,
                    None,
                ));
            }
            Err(BackendError::PolicyMismatch(message)) => {
                return Ok(blocked(
                    RecoveryPath::Reattach,
                    RecoveryBlockReason::CapabilityPending,
                    &message,
                    None,
                ));
            }
            Err(error) => {
                *transient = TransientRecoveryFailure::from_backend(&error);
                return Ok(blocked(
                    RecoveryPath::Reattach,
                    RecoveryBlockReason::ProviderUnavailable,
                    &error.to_string(),
                    Some(2_000),
                ));
            }
        };

        if inspection.state == BackendRuntimeState::Running {
            match self
                .authenticate_host(
                    context.prior_handle.incarnation_id(),
                    context.prior_handle.runtime_dir(),
                )
                .await
            {
                Ok(host) => {
                    if context.provider != "shell"
                        && context.fixture.is_none()
                        && !retained_host_features_known(&host)
                    {
                        return self
                            .retained_store_compatibility_probe(
                                context,
                                "retained_host_capability_unknown",
                                transient,
                            )
                            .await;
                    }
                    let status = match self
                        .host_status(
                            context.prior_handle.incarnation_id().clone(),
                            context.prior_handle.runtime_dir(),
                            &host,
                        )
                        .await
                    {
                        Ok(status) => status,
                        Err(_)
                            if context.fixture.is_none()
                                && context.provider == "opencode"
                                && context.native_session_id.is_some() =>
                        {
                            return self
                                .retained_store_compatibility_probe(
                                    context,
                                    "retained_host_status_unreachable",
                                    transient,
                                )
                                .await;
                        }
                        Err(_) if context.resume_spec.is_some() => {
                            return offline_probe(context);
                        }
                        Err(error) => {
                            *transient = TransientRecoveryFailure::from_runtime(&error);
                            return Ok(blocked(
                                RecoveryPath::Reattach,
                                RecoveryBlockReason::ProviderUnavailable,
                                &error.message,
                                Some(2_000),
                            ));
                        }
                    };
                    let native_observation_qualified = context.fixture.is_some()
                        || context.provider == "shell"
                        || current_fixture_native_session(context, &status).is_some()
                        || retained_status_observed(context, &host, &status);
                    if let Some(native_session_id) = status
                        .native_session_id
                        .as_ref()
                        .filter(|_| native_observation_qualified)
                    {
                        self.registry
                            .record_native_session_fenced(
                                context.soul_id.clone(),
                                context.prior_handle.incarnation_id().clone(),
                                native_session_id.clone(),
                                context.write_fence(),
                            )
                            .await
                            .map_err(map_registry)?;
                        if context.native_session_id.is_none() {
                            context.native_session_id = Some(native_session_id.clone());
                            context.identity_revision += 1;
                            context.evidence_revision += 1;
                        }
                    }
                    if !status.exited {
                        if !native_observation_qualified
                            && context.provider != "shell"
                            && context.fixture.is_none()
                        {
                            return self
                                .retained_store_compatibility_probe(
                                    context,
                                    "retained_native_observation_unqualified",
                                    transient,
                                )
                                .await;
                        }
                        if context.provider != "shell"
                            && context.fixture.is_none()
                            && !deterministic_fresh_fixture(context)
                        {
                            self.registry
                                .record_native_identity_observation(
                                    context.soul_id.clone(),
                                    status
                                        .native_identity_observation
                                        .clone()
                                        .expect("qualified current observation"),
                                    context.write_fence(),
                                )
                                .await
                                .map_err(map_registry)?;
                        }
                        if context.provider != "shell"
                            && context.resume_spec.is_none()
                            && !deterministic_fresh_fixture(context)
                        {
                            self.capture_live_resume_evidence(context, &host, &status)
                                .await;
                        }
                        return Ok(live_reattach_probe(context, &status));
                    }
                    if context.provider == "shell" {
                        return Ok(shell_terminal_end_probe(context));
                    }
                    let candidate = match resume_catalog::exact_resume_candidate(
                        &*context,
                        status
                            .native_session_id
                            .as_deref()
                            .filter(|_| native_observation_qualified),
                    ) {
                        Ok(candidate) => candidate,
                        Err(probe) => return Ok(probe),
                    };
                    // classify_recovery captures native proof once, under the
                    // current recovery fence, after this probe has completed.
                    let store_probe = self.probe_host_store(&*context, &host, candidate).await?;
                    crate::service::append_event(
                        &self.config.lifecycle_log,
                        "supervisor.recovery.store_probe",
                        serde_json::json!({
                            "soulId": context.soul_id,
                            "incarnationId": context.prior_handle.incarnation_id(),
                            "probe": store_probe,
                        }),
                    );
                    // A loader may emit its native root before later restoration
                    // fails. Re-read the current child after the independent store
                    // read, then persist only that still-live current observation.
                    let requires_native_observation = context.provider != "shell"
                        && context.fixture.is_none()
                        && !deterministic_fresh_fixture(context);
                    let status = if !status.exited && requires_native_observation {
                        self.host_status(
                            context.prior_handle.incarnation_id().clone(),
                            context.prior_handle.runtime_dir(),
                            &host,
                        )
                        .await?
                    } else {
                        status
                    };
                    let native_observation_qualified = !requires_native_observation
                        || retained_status_observed(context, &host, &status);
                    if !status.exited && requires_native_observation && native_observation_qualified
                    {
                        self.registry
                            .record_native_identity_observation(
                                context.soul_id.clone(),
                                status
                                    .native_identity_observation
                                    .clone()
                                    .expect("qualified observation"),
                                context.write_fence(),
                            )
                            .await
                            .map_err(map_registry)?;
                    }

                    if !status.exited
                        && context.provider != "shell"
                        && context.fixture.is_none()
                        && !deterministic_fresh_fixture(context)
                        && !native_observation_qualified
                        && matches!(
                            &store_probe,
                            RecoveryProbe::ResumeReady { .. }
                                | RecoveryProbe::PristineSeedReady { .. }
                        )
                    {
                        return self
                            .retained_store_compatibility_probe(
                                context,
                                "retained_native_observation_unqualified",
                                transient,
                            )
                            .await;
                    }
                    return Ok(retained_runtime_probe(
                        status.exited,
                        ReattachHandle {
                            incarnation_id: context.prior_handle.incarnation_id().clone(),
                            host_boot_id: status.host_boot_id,
                            container_id: context.prior_handle.container_id().to_owned(),
                        },
                        after_native_probe(context, store_probe),
                        context.provider != "shell"
                            && context.fixture.is_none()
                            && !deterministic_fresh_fixture(context),
                    ));
                }
                Err(_)
                    if context.fixture.is_none()
                        && context.provider == "opencode"
                        && context.native_session_id.is_some() =>
                {
                    return self
                        .retained_store_compatibility_probe(
                            context,
                            "retained_host_unreachable",
                            transient,
                        )
                        .await;
                }
                Err(_) if context.resume_spec.is_some() => {
                    return offline_probe(context);
                }
                Err(error) => {
                    *transient = TransientRecoveryFailure::from_runtime(&error);
                    return Ok(blocked(
                        RecoveryPath::Reattach,
                        RecoveryBlockReason::ProviderUnavailable,
                        &error.message,
                        Some(2_000),
                    ));
                }
            }
        }

        if matches!(
            inspection.state,
            BackendRuntimeState::Created
                | BackendRuntimeState::Exited
                | BackendRuntimeState::Dead
                | BackendRuntimeState::Missing
        ) {
            if context.fixture.is_none()
                && !deterministic_fresh_fixture(context)
                && context.provider == "opencode"
                && context.native_session_id.is_some()
            {
                return self
                    .retained_store_compatibility_probe(context, "retained_host_exited", transient)
                    .await;
            }
            if context.resume_spec.is_none()
                && context.native_session_id.is_some()
                && context.fixture.is_none()
                && !deterministic_fresh_fixture(context)
            {
                return self.probe_offline_store(context, transient).await;
            }
            return offline_probe(context);
        }

        Ok(blocked(
            RecoveryPath::Reattach,
            RecoveryBlockReason::OldRuntimeNotEmpty,
            &format!(
                "owned runtime is {:?}; it is neither attachable nor verified empty",
                inspection.state
            ),
            Some(2_000),
        ))
    }

    /// Capture a verified exact-session resume proof while the provider store
    /// is still reachable. A live process remains reattachable even when the
    /// provider cannot produce a proof yet; the lifecycle event records that
    /// gap so an eventual whole-enclosure exit does not look like a mystery.
    async fn capture_live_resume_evidence(
        &self,
        context: &RecoveryContext,
        host: &crate::service::AuthenticatedHost,
        status: &crate::service::HostStatus,
    ) {
        if !self.live_resume_evidence_capture_due(context, status).await {
            return;
        }

        let capture = match resume_catalog::exact_resume_candidate(
            context,
            status.native_session_id.as_deref(),
        ) {
            Ok(Some(candidate)) => {
                match self.probe_host_store(context, host, Some(candidate)).await {
                    Ok(RecoveryProbe::ResumeReady { resume_spec, .. }) => {
                        match self
                            .registry
                            .store_verified_resume_spec_for_live_incarnation(
                                context.soul_id.clone(),
                                context.prior_handle.incarnation_id().clone(),
                                context.evidence_revision,
                                *resume_spec,
                            )
                            .await
                        {
                            Ok(Some(stored)) => serde_json::json!({
                                "result": "captured",
                                "evidenceRevision": stored.evidence_revision,
                            }),
                            Ok(None) => serde_json::json!({
                                "result": "superseded",
                            }),
                            Err(error) => serde_json::json!({
                                "result": "persist_failed",
                                "error": error.to_string(),
                            }),
                        }
                    }
                    Ok(probe) => serde_json::json!({
                        "result": "not_verified",
                        "probe": probe,
                    }),
                    Err(error) => serde_json::json!({
                        "result": "probe_failed",
                        "errorCode": error.code,
                        "error": error.message,
                    }),
                }
            }
            Ok(None) => serde_json::json!({ "result": "identity_unavailable" }),
            Err(probe) => serde_json::json!({
                "result": "candidate_blocked",
                "probe": probe,
            }),
        };
        crate::service::append_event(
            &self.config.lifecycle_log,
            "supervisor.recovery.live_resume_evidence",
            serde_json::json!({
                "soulId": context.soul_id,
                "incarnationId": context.prior_handle.incarnation_id(),
                "provider": context.provider,
                "capture": capture,
            }),
        );
    }

    async fn live_resume_evidence_capture_due(
        &self,
        context: &RecoveryContext,
        status: &crate::service::HostStatus,
    ) -> bool {
        let key = (
            context.soul_id.as_str().to_string(),
            context.prior_handle.incarnation_id().as_str().to_string(),
            status
                .native_session_id
                .clone()
                .or_else(|| context.native_session_id.clone()),
        );
        let now = Instant::now();
        let mut attempts = self.live_resume_evidence_attempts.lock().await;
        attempts.retain(|_, attempted_at| {
            now.duration_since(*attempted_at) < LIVE_RESUME_EVIDENCE_RETRY_INTERVAL
        });
        if attempts.contains_key(&key) {
            return false;
        }

        if attempts.len() >= LIVE_RESUME_EVIDENCE_ATTEMPT_CACHE_MAX_ENTRIES {
            if let Some(oldest_key) = attempts
                .iter()
                .min_by_key(|(_, attempted_at)| **attempted_at)
                .map(|(key, _)| key.clone())
            {
                attempts.remove(&oldest_key);
            }
        }
        attempts.insert(key, now);
        true
    }

    /// A native loader observation may precede the first durable save. After
    /// host death, verify that save from the owned volume before capturing a
    /// resume spec; the recorded root and launch are only selection inputs.
    async fn probe_offline_store(
        &self,
        context: &RecoveryContext,
        transient: &mut Option<TransientRecoveryFailure>,
    ) -> Result<RecoveryProbe, RuntimeError> {
        let spec = match resume_catalog::exact_resume_candidate(context, None) {
            Ok(Some(spec)) => spec,
            Ok(None) => return offline_probe(context),
            Err(probe) => return Ok(probe),
        };
        let store = self
            .backend
            .read_native_census(
                &context.prior_handle,
                &spec,
                &self.config.host_binary_path,
                &self.config.image_ref,
            )
            .await;
        let reader_outcome = match &store {
            Ok(freshell_agent_runtime::ProviderStoreProbe::Ready { .. }) => "ready",
            Ok(freshell_agent_runtime::ProviderStoreProbe::Blocked { .. }) => "blocked",
            Ok(freshell_agent_runtime::ProviderStoreProbe::DefinitivelyUnavailable { .. }) => {
                "durable_content_absent"
            }
            Ok(freshell_agent_runtime::ProviderStoreProbe::ParentBackedClaudeFork { .. }) => {
                "parent_backed_recipe_unverified"
            }
            Err(BackendError::OwnershipMismatch(_)) => "ownership_mismatch",
            Err(BackendError::PolicyMismatch(_)) => "policy_mismatch",
            Err(BackendError::Malformed(_)) => "malformed_reader_result",
            Err(_) => "reader_unavailable",
        };
        let unverified_store = || {
            blocked(
                RecoveryPath::NativeResume,
                RecoveryBlockReason::StoreUnreadable,
                "the retained provider store has no verified durable resume evidence",
                None,
            )
        };
        let probe = match store {
            Ok(freshell_agent_runtime::ProviderStoreProbe::Ready { .. }) => {
                RecoveryProbe::ResumeReady {
                    evidence_revision: spec.evidence_revision,
                    resume_spec: Box::new(spec),
                }
            }
            Ok(freshell_agent_runtime::ProviderStoreProbe::Blocked {
                reason,
                retry_hint,
                evidence,
            }) => RecoveryProbe::Blocked {
                path: RecoveryPath::NativeResume,
                reason,
                retry_hint,
                evidence,
            },
            Err(error) => {
                *transient = TransientRecoveryFailure::from_backend(&error);
                if transient.is_some() {
                    blocked(
                        RecoveryPath::NativeResume,
                        RecoveryBlockReason::ProviderUnavailable,
                        "the retained provider store reader is temporarily unavailable",
                        Some(2_000),
                    )
                } else {
                    unverified_store()
                }
            }
            // This capture path establishes positive durability only. Negative
            // reads and parent-backed recipes retain the existing refusal to
            // substitute an unverified spec or authorize loss.
            Ok(_) => unverified_store(),
        };
        crate::service::append_event(
            &self.config.lifecycle_log,
            "supervisor.recovery.offline_store_probe",
            serde_json::json!({
                "severity": if matches!(probe, RecoveryProbe::ResumeReady { .. }) { "info" } else { "warn" },
                "soulId": context.soul_id,
                "incarnationId": context.prior_handle.incarnation_id(),
                "intentRevision": context.intent_revision,
                "identityRevision": context.identity_revision,
                "evidenceRevision": context.evidence_revision,
                "controlEpoch": context.control_epoch,
                "reason": if matches!(probe, RecoveryProbe::ResumeReady { .. }) { "durable_store_verified" } else { "durable_store_unverified" },
                "readerOutcome": reader_outcome,
                "blockReason": match &probe { RecoveryProbe::Blocked { reason, .. } => Some(reason), _ => None },
                "providerStoreId": context.provider_store_id,
                "executionGeneration": context.native_identity_launch.as_ref().map(|launch| launch.execution_generation),
                "attemptReserved": context.recovery_attempt_id.is_some(),
            }),
        );
        Ok(probe)
    }

    async fn retained_store_compatibility_probe(
        &self,
        context: &RecoveryContext,
        reason: &str,
        transient: &mut Option<TransientRecoveryFailure>,
    ) -> Result<RecoveryProbe, RuntimeError> {
        crate::service::append_event(
            &self.config.lifecycle_log,
            "supervisor.recovery.retained_qualification_started",
            serde_json::json!({
                "severity": "info",
                "soulId": context.soul_id,
                "incarnationId": context.prior_handle.incarnation_id(),
                "intentRevision": context.intent_revision,
                "identityRevision": context.identity_revision,
                "evidenceRevision": context.evidence_revision,
                "controlEpoch": context.control_epoch,
                "reason": reason,
                "attemptReserved": context.recovery_attempt_id.is_some(),
            }),
        );
        let candidate = resume_catalog::exact_resume_candidate(context, None);
        let result = match candidate {
            Ok(Some(spec)) if context.provider == "opencode" && context.fixture.is_none() => {
                let identity = context
                    .terminal
                    .as_ref()
                    .map(|terminal| (terminal.run_as_uid, terminal.run_as_gid))
                    .or_else(|| {
                        context
                            .fresh_agent
                            .as_ref()
                            .map(|agent| (agent.run_as_uid, agent.run_as_gid))
                    });
                if let Some((uid, gid)) = identity {
                    let request = freshell_runtime_protocol::RetainedStoreCompatibilityRequest {
                        provider_store_id: context.provider_store_id.clone(),
                        native_session_id: spec.provider_session.native_session_id.clone(),
                        image_ref: self.config.image_ref.clone(),
                        provider_home: spec.provider_home.clone(),
                        workspace_path: spec.workspace_path.clone(),
                        cwd: spec.cwd.clone(),
                        provider_uid: uid,
                        provider_gid: gid,
                    };
                    match self
                        .backend
                        .qualify_retained_opencode(
                            &context.prior_handle,
                            &request,
                            &self.config.host_binary_path,
                        )
                        .await
                    {
                        Ok(receipt) => {
                            crate::service::append_event(
                                &self.config.lifecycle_log,
                                "supervisor.recovery.retained_store_compatible",
                                serde_json::json!({"severity":"info","soulId":context.soul_id,"incarnationId":context.prior_handle.incarnation_id(),"intentRevision":context.intent_revision,"evidenceRevision":context.evidence_revision,"controlEpoch":context.control_epoch,"launchPolicy":context.prior_handle.launch_policy(),"reason":reason,"receipt":receipt,"attemptReserved":context.recovery_attempt_id.is_some()}),
                            );
                            RecoveryProbe::ResumeReady {
                                resume_spec: Box::new(spec),
                                evidence_revision: context.evidence_revision,
                            }
                        }
                        Err(error) => {
                            *transient = TransientRecoveryFailure::from_backend(&error);
                            blocked(
                                RecoveryPath::NativeResume,
                                if transient.is_some() {
                                    RecoveryBlockReason::ProviderUnavailable
                                } else {
                                    RecoveryBlockReason::StoreUnreadable
                                },
                                &format!(
                                    "current-image retained-store qualification failed: {error}"
                                ),
                                Some(2000),
                            )
                        }
                    }
                } else {
                    blocked(
                        RecoveryPath::NativeResume,
                        RecoveryBlockReason::CapabilityPending,
                        "retained provider identity is unavailable",
                        Some(2000),
                    )
                }
            }
            Err(probe) if context.native_session_id.is_some() => probe,
            _ => blocked(
                RecoveryPath::NativeResume,
                RecoveryBlockReason::CapabilityPending,
                reason,
                Some(2000),
            ),
        };
        Ok(result)
    }

    async fn probe_host_store(
        &self,
        context: &RecoveryContext,
        host: &crate::service::AuthenticatedHost,
        resume_spec: Option<freshell_runtime_protocol::ResumeSpec>,
    ) -> Result<RecoveryProbe, RuntimeError> {
        let (run_as_uid, run_as_gid) = context
            .terminal
            .as_ref()
            .map(|terminal| (terminal.run_as_uid, terminal.run_as_gid))
            .or_else(|| {
                context
                    .fresh_agent
                    .as_ref()
                    .map(|agent| (agent.run_as_uid, agent.run_as_gid))
            })
            // Test fixtures run as the host's workload user (root inside the
            // enclosure); real providers are always probed as their configured
            // unprivileged uid/gid above.
            .unwrap_or((0, 0));
        match self
            .send_authenticated_host_command(
                context.prior_handle.incarnation_id().clone(),
                context.prior_handle.runtime_dir(),
                host,
                HostCommand::ProbeRecovery {
                    incarnation_id: context.prior_handle.incarnation_id().clone(),
                    resume_spec: resume_spec.map(Box::new),
                    creation_seed_ref: context.creation_seed_ref.clone(),
                    never_dispatched: context.never_dispatched,
                    run_as_uid,
                    run_as_gid,
                },
            )
            .await?
        {
            HostResult::RecoveryProbe(probe) => Ok(probe),
            _ => Err(RuntimeError::new(
                RuntimeErrorCode::HostAuthenticationFailed,
                "unexpected recovery probe reply",
            )),
        }
    }

    pub(crate) async fn recover(
        &self,
        request: RecoverRequest,
    ) -> Result<RecoveryResult, RuntimeError> {
        Box::pin(self.recover_scheduled(request, false)).await
    }

    pub(crate) async fn recover_scheduled(
        &self,
        request: RecoverRequest,
        only_due_retry: bool,
    ) -> Result<RecoveryResult, RuntimeError> {
        let lifecycle_lock = self.lifecycle_lock(&request.soul_id).await;
        let _recovery_guard = lifecycle_lock.lock().await;
        #[cfg(test)]
        automatic_retry_tests::crash_boundary("before_reservation");
        self.registry
            .assert_soul_intent_revision(request.soul_id.clone(), request.expected_intent_revision)
            .await
            .map_err(map_registry)?;
        let before_retry = self
            .registry
            .recovery_context(request.soul_id.clone())
            .await
            .map_err(map_registry)?;
        if only_due_retry
            && !self
                .registry
                .recovery_retry(request.soul_id.clone(), before_retry.intent_revision)
                .await
                .map_err(map_registry)?
                .is_some_and(|retry| {
                    retry.reserved_attempt_id.is_some()
                        || retry.is_due(self.registry.recovery_now_ms())
                })
        {
            return Ok(RecoveryResult {
                outcome: match before_retry.recovery_state {
                    freshell_runtime_protocol::RecoveryState::Live => RecoveryOutcome::Reattached,
                    freshell_runtime_protocol::RecoveryState::Lost => RecoveryOutcome::Lost,
                    freshell_runtime_protocol::RecoveryState::Stopped => RecoveryOutcome::Stopped,
                    _ => RecoveryOutcome::Blocked,
                },
                view: self
                    .view_for(before_retry.prior_handle.incarnation_id())
                    .await?,
                probe: None,
                prior_incarnation_id: None,
                attempt_id: None,
                expected_native_session_id: before_retry.native_session_id,
                observed_native_session_id: None,
                incident_id: None,
            });
        }
        if request.trigger == RecoveryTrigger::ManualRetry
            && before_retry.desired_state == DesiredState::Stopped
            && before_retry.recovery_state
                == freshell_runtime_protocol::RecoveryState::DataRepairComplete
        {
            let expected_revision = request.expected_intent_revision.ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::InvalidRequest,
                    "resuming repaired data requires the current soul intent revision",
                )
            })?;
            let next_revision = self
                .registry
                .start_stopped_data_repair(request.soul_id.clone(), expected_revision)
                .await
                .map_err(map_registry)?;
            crate::service::append_event(
                &self.config.lifecycle_log,
                "supervisor.stopped_data_repair_resume_requested",
                serde_json::json!({"soulId":request.soul_id,"intentRevision":next_revision}),
            );
        }
        if request.trigger == RecoveryTrigger::ManualRetry
            && before_retry.desired_state == DesiredState::Running
            && before_retry.recovery_state != freshell_runtime_protocol::RecoveryState::Lost
        {
            let revision = self
                .registry
                .rearm_recovery_retry(request.soul_id.clone(), before_retry.intent_revision)
                .await
                .map_err(map_registry)?;
            let generation = self
                .view_for(before_retry.prior_handle.incarnation_id())
                .await
                .ok()
                .map(|view| view.execution_generation);
            crate::service::append_event(
                &self.config.lifecycle_log,
                "supervisor.recovery_retry.cancelled",
                serde_json::json!({"severity":"info","soulId":request.soul_id,"incarnationId":before_retry.prior_handle.incarnation_id(),"attemptId":before_retry.recovery_attempt_id,"executionGeneration":generation,"intentRevision":before_retry.intent_revision,"nextIntentRevision":revision,"controlEpoch":self.registry.control_epoch(),"reason":"manual_rearm"}),
            );
        }
        if let Some(view) = self
            .registry
            .inventory()
            .await
            .map_err(map_registry)?
            .into_iter()
            .rev()
            .find(|view| view.soul_id == request.soul_id)
        {
            if view.recovery_state == freshell_runtime_protocol::RecoveryState::Lost {
                return Ok(RecoveryResult {
                    outcome: RecoveryOutcome::Lost,
                    incident_id: view.incident_id.clone(),
                    expected_native_session_id: view.native_session_id.clone(),
                    observed_native_session_id: None,
                    prior_incarnation_id: view.prior_incarnation_id.clone(),
                    attempt_id: None,
                    probe: None,
                    view,
                });
            }
            if view.desired_state == DesiredState::Running
                && view.recovery_state == freshell_runtime_protocol::RecoveryState::Blocked
                && matches!(
                    view.recovery_reason.as_deref(),
                    Some("RETRY_BUDGET" | "BLOCKED_RETRY_BUDGET")
                )
                && request.trigger != RecoveryTrigger::ManualRetry
            {
                return Ok(RecoveryResult {
                    outcome: RecoveryOutcome::Blocked,
                    probe: Some(blocked(
                        RecoveryPath::NativeResume,
                        RecoveryBlockReason::RetryBudget,
                        "automatic recovery budget is exhausted; repair the dependency and explicitly retry",
                        None,
                    )),
                    view,
                    prior_incarnation_id: None,
                    attempt_id: None,
                    expected_native_session_id: None,
                    observed_native_session_id: None,
                    incident_id: None,
                });
            }
        }
        if let Some(retired) = self
            .registry
            .retire_unowned_prepared_replacement(request.soul_id.clone())
            .await
            .map_err(map_registry)?
        {
            crate::service::append_event(
                &self.config.lifecycle_log,
                "supervisor.recovery.interrupted_prepared_retired",
                serde_json::json!({
                    "severity":"warn", "soulId":request.soul_id,
                    "incarnationId":retired.incarnation_id,
                    "attemptId":retired.journal.as_ref().map(|(attempt, _)| attempt),
                    "intentRevision":retired.journal.as_ref().map(|(_, revision)| revision),
                    "priorIncarnationId":before_retry.prior_handle.incarnation_id(),
                    "currentIntentRevision":before_retry.intent_revision,
                    "controlEpoch":self.registry.control_epoch(),
                    "reason":"unregistered_stopped_object_quarantined",
                }),
            );
            if let Some(retry) = self
                .registry
                .recovery_retry(request.soul_id.clone(), before_retry.intent_revision)
                .await
                .map_err(map_registry)?
                .filter(|retry| {
                    retry.next_due_at_ms.is_some() || retry.last_reason == "retry_exhausted"
                })
            {
                self.log_recovery_retry(
                    if retry.last_reason == "retry_exhausted" {
                        "exhausted"
                    } else {
                        "scheduled"
                    },
                    &retry,
                    &before_retry.recovery_attempt_id,
                    &before_retry,
                )
                .await;
            }
        }
        if request.trigger == RecoveryTrigger::RetryExhausted {
            let initial_context = self
                .registry
                .recovery_context(request.soul_id.clone())
                .await
                .map_err(map_registry)?;
            let evidence =
                vec!["bounded automatic retry schedule exhausted (initial, 2s, 10s)".into()];
            let probe = RecoveryProbe::Blocked {
                path: RecoveryPath::NativeResume,
                reason: RecoveryBlockReason::RetryBudget,
                retry_hint: freshell_runtime_protocol::RetryHint {
                    automatic_after_ms: None,
                    manual_retry: true,
                    repair: Some("repair the dependency, then explicitly retry this soul".into()),
                },
                evidence: evidence.clone(),
            };
            self.registry
                .mark_recovery_blocked(
                    request.soul_id.clone(),
                    None,
                    RecoveryBlockReason::RetryBudget,
                    evidence,
                    initial_context.write_fence(),
                )
                .await
                .map_err(map_registry)?;
            let context = self
                .registry
                .recovery_context(request.soul_id)
                .await
                .map_err(map_registry)?;
            return Ok(RecoveryResult {
                outcome: RecoveryOutcome::Blocked,
                view: self.view_for(context.prior_handle.incarnation_id()).await?,
                probe: Some(probe),
                prior_incarnation_id: None,
                attempt_id: None,
                expected_native_session_id: None,
                observed_native_session_id: None,
                incident_id: None,
            });
        }
        let mut context = self
            .registry
            .recovery_context(request.soul_id.clone())
            .await
            .map_err(map_registry)?;
        if context.desired_state == DesiredState::Stopped {
            return self
                .complete_recovery_probe(
                    request,
                    blocked(
                        RecoveryPath::Reattach,
                        RecoveryBlockReason::StopIntent,
                        "the durable desired state is STOPPED",
                        None,
                    ),
                    context,
                    None,
                )
                .await;
        }
        let mut discovery_error = None;
        let reserved = match self
            .registry
            .reserved_recovery_retry(request.soul_id.clone(), context.intent_revision)
            .await
            .map_err(map_registry)?
        {
            Some(reserved) => Some(reserved),
            None => {
                let retry = self
                    .registry
                    .recovery_retry(request.soul_id.clone(), context.intent_revision)
                    .await
                    .map_err(map_registry)?;
                if retry
                    .as_ref()
                    .is_none_or(|retry| retry.is_due(self.registry.recovery_now_ms()))
                    && context.provider == "opencode"
                    && context.fixture.is_none()
                    && !deterministic_fresh_fixture(&context)
                {
                    // Discover an unreadable retained store without minting a
                    // replacement attempt. Successful discovery grants no
                    // mutation authority: the reserved route probes afresh.
                    // Box the large probe future as on the reserved route.
                    match Box::pin(self.classify_recovery(request.soul_id.clone())).await {
                        Ok((
                            mut probe @ RecoveryProbe::Blocked {
                                reason: RecoveryBlockReason::StoreUnreadable,
                                ..
                            },
                            observed,
                            _,
                        )) if observed.native_session_id.is_some() => {
                            // Missing identity also classifies as unreadable,
                            // but must settle the initial blocked reservation.
                            // Only a known retained root uses this no-attempt
                            // store-qualification refusal.
                            // Reader hints are not persisted retry schedules.
                            if let RecoveryProbe::Blocked { retry_hint, .. } = &mut probe {
                                retry_hint.automatic_after_ms = None;
                            }
                            self.log_recovery_preflight(&observed, &probe);
                            return self
                                .complete_recovery_probe(request, probe, observed, None)
                                .await;
                        }
                        Ok(_) => {}
                        // Discovery transport errors still consume and settle
                        // an eligible typed attempt below.
                        Err(error) => discovery_error = Some(error),
                    }
                    let intent_revision = context.intent_revision;
                    context = self
                        .registry
                        .recovery_context(request.soul_id.clone())
                        .await
                        .map_err(map_registry)?;
                    self.registry
                        .assert_soul_intent_revision(request.soul_id.clone(), Some(intent_revision))
                        .await
                        .map_err(map_registry)?;
                }
                self.registry
                    .reserve_due_recovery_retry(
                        request.soul_id.clone(),
                        context.intent_revision,
                        self.registry.recovery_now_ms(),
                    )
                    .await
                    .map_err(map_registry)?
            }
        };
        let Some(reserved) = reserved else {
            let context = self
                .registry
                .recovery_context(request.soul_id.clone())
                .await
                .map_err(map_registry)?;
            let pending = self
                .registry
                .recovery_retry(request.soul_id.clone(), context.intent_revision)
                .await
                .map_err(map_registry)?;
            let probe = pending.and_then(|retry| {
                retry.next_due_at_ms.map(|due| {
                    blocked(
                        RecoveryPath::Reattach,
                        if retry.last_reason == "preparation_unavailable" {
                            RecoveryBlockReason::CapabilityPending
                        } else {
                            RecoveryBlockReason::ProviderUnavailable
                        },
                        "the supervisor has scheduled another recovery attempt",
                        Some(due.saturating_sub(self.registry.recovery_now_ms()).max(0) as u64),
                    )
                })
            });
            return Ok(RecoveryResult {
                outcome: RecoveryOutcome::Blocked,
                view: self.view_for(context.prior_handle.incarnation_id()).await?,
                probe,
                prior_incarnation_id: None,
                attempt_id: None,
                expected_native_session_id: context.native_session_id,
                observed_native_session_id: None,
                incident_id: None,
            });
        };
        self.log_recovery_retry(
            "reserved",
            &reserved,
            &reserved.reserved_attempt_id,
            &context,
        )
        .await;
        #[cfg(test)]
        automatic_retry_tests::crash_boundary("after_reservation_before_dispatch");
        let mut result = match discovery_error {
            Some(error) => Err(error),
            None => Box::pin(self.run_reserved_recovery(request.clone())).await,
        };
        if let Err(error) = &result {
            let current = self
                .registry
                .recovery_context(request.soul_id.clone())
                .await
                .map_err(map_registry)?;
            if current.desired_state == DesiredState::Running
                && current.intent_revision == reserved.intent_revision
                && current.recovery_attempt_id == reserved.reserved_attempt_id
            {
                let transient = TransientRecoveryFailure::from_runtime(error);
                self.registry
                    .mark_recovery_blocked_with_retry(
                        request.soul_id.clone(),
                        reserved.reserved_attempt_id.clone(),
                        match error.code {
                            RuntimeErrorCode::RecoveryRetryBudget => {
                                RecoveryBlockReason::RetryBudget
                            }
                            RuntimeErrorCode::RecoveryWrongIdentity => {
                                RecoveryBlockReason::WrongNativeIdentity
                            }
                            _ => RecoveryBlockReason::ProviderUnavailable,
                        },
                        vec![error.message.clone()],
                        current.write_fence(),
                        transient,
                    )
                    .await
                    .map_err(map_registry)?;
            }
        }
        let settled = self
            .registry
            .recovery_retry(request.soul_id.clone(), reserved.intent_revision)
            .await
            .map_err(map_registry)?;
        if let Some(retry) = &settled {
            let state = if retry.last_reason == "retry_exhausted" {
                "exhausted"
            } else if retry.next_due_at_ms.is_some() {
                "scheduled"
            } else {
                "settled"
            };
            self.log_recovery_retry(state, retry, &reserved.reserved_attempt_id, &context)
                .await;
            if let Ok(result) = &mut result {
                if let Some(RecoveryProbe::Blocked {
                    reason, retry_hint, ..
                }) = &mut result.probe
                {
                    retry_hint.automatic_after_ms = retry.next_due_at_ms.map(|due| {
                        due.saturating_sub(self.registry.recovery_now_ms()).max(0) as u64
                    });
                    if retry.last_reason == "retry_exhausted" {
                        *reason = RecoveryBlockReason::RetryBudget;
                    }
                }
            }
        } else {
            let recovered = result.as_ref().is_ok_and(|result| {
                matches!(
                    result.outcome,
                    RecoveryOutcome::Reattached | RecoveryOutcome::Replaced
                )
            });
            let mut finished = reserved.clone();
            finished.reserved_attempt_id = None;
            finished.last_reason = if recovered { "recovered" } else { "cancelled" }.into();
            self.log_recovery_retry(
                if recovered { "settled" } else { "cancelled" },
                &finished,
                &reserved.reserved_attempt_id,
                &context,
            )
            .await;
        }
        #[cfg(test)]
        automatic_retry_tests::crash_boundary("after_settlement");
        result
    }

    async fn log_recovery_retry(
        &self,
        state: &str,
        retry: &RecoveryRetry,
        attempt_id: &Option<RecoveryAttemptId>,
        context: &RecoveryContext,
    ) {
        // Settlement can advance to an owned replacement. Observe that exact
        // incarnation while retaining the attempt identity after its row has
        // been cleared. Diagnostics never turn a committed result into failure.
        let current = self
            .registry
            .recovery_context(retry.soul_id.clone())
            .await
            .ok()
            .filter(|current| current.intent_revision == retry.intent_revision);
        let context = current.as_ref().unwrap_or(context);
        let generation = self
            .view_for(context.prior_handle.incarnation_id())
            .await
            .ok()
            .map(|view| view.execution_generation);
        crate::service::append_event(
            &self.config.lifecycle_log,
            &format!("supervisor.recovery_retry.{state}"),
            serde_json::json!({
                "severity":if state == "exhausted" {"warn"} else {"info"},"soulId":retry.soul_id,
                "incarnationId":context.prior_handle.incarnation_id(),"intentRevision":retry.intent_revision,
                "controlEpoch":self.registry.control_epoch(),"attemptId":attempt_id,
                "executionGeneration":generation,
                "attemptCount":retry.attempt_count,"nextDueAtMs":retry.next_due_at_ms,"reason":retry.last_reason,
            }),
        );
    }

    async fn run_reserved_recovery(
        &self,
        request: RecoverRequest,
    ) -> Result<RecoveryResult, RuntimeError> {
        if let Some((prepared, context)) = self
            .registry
            .pending_owned_replacement(request.soul_id.clone())
            .await
            .map_err(map_registry)?
        {
            // Inspect the registered object before resuming its idempotent
            // activation. Never repeat create_stopped for a reserved attempt.
            let inspection = self
                .backend
                .inspect(&context.prior_handle)
                .await
                .map_err(crate::service::map_backend)?;
            if !matches!(
                inspection.state,
                BackendRuntimeState::Created | BackendRuntimeState::Running
            ) {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::RecoveryBlocked,
                    "reserved replacement is no longer an owned startable runtime",
                ));
            }
            let workload = LaunchWorkload {
                soul_id: request.soul_id.clone(),
                fixture: context.fixture,
                terminal: context.terminal.clone(),
                fresh_agent: context.fresh_agent.clone(),
                resume_spec: context.resume_spec.clone(),
            };
            if let Err(error) = Box::pin(self.activate_prepared_observed(
                prepared.clone(),
                workload,
                context.requested_limits,
                context.write_fence(),
            ))
            .await
            {
                self.cleanup_failed_replacement(&prepared.incarnation_id)
                    .await;
                return Err(error);
            }
        }
        let (probe, observed_context, transient) = self
            .probe_recovery_for_attempt(request.soul_id.clone())
            .await?;
        self.complete_recovery_probe(request, probe, observed_context, transient)
            .await
    }

    fn complete_recovery_probe(
        &self,
        request: RecoverRequest,
        probe: RecoveryProbe,
        observed_context: RecoveryContext,
        transient: Option<TransientRecoveryFailure>,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<RecoveryResult, RuntimeError>> + Send + '_>,
    > {
        match probe.clone() {
            RecoveryProbe::ReattachReady { handle, .. } => Box::pin(async move {
                self.registry
                    .mark_recovery_live(
                        request.soul_id.clone(),
                        handle.incarnation_id.clone(),
                        observed_context.write_fence(),
                    )
                    .await
                    .map_err(map_registry)?;
                let owned = self
                    .registry
                    .owned_handle(handle.incarnation_id.clone())
                    .await
                    .map_err(map_registry)?;
                self.complete_pending_provider_preparation(&owned).await?;
                self.release_pending_native_permissions_after_live(
                    request.soul_id.clone(),
                    handle.incarnation_id.clone(),
                )
                .await?;
                Ok(RecoveryResult {
                    outcome: RecoveryOutcome::Reattached,
                    view: self.view_for(&handle.incarnation_id).await?,
                    probe: Some(probe),
                    prior_incarnation_id: None,
                    attempt_id: None,
                    expected_native_session_id: None,
                    observed_native_session_id: None,
                    incident_id: None,
                })
            }),
            RecoveryProbe::Blocked {
                reason, evidence, ..
            } => Box::pin(async move {
                if reason == RecoveryBlockReason::StopIntent {
                    let context = self
                        .registry
                        .recovery_context(request.soul_id)
                        .await
                        .map_err(map_registry)?;
                    return Ok(RecoveryResult {
                        outcome: RecoveryOutcome::Stopped,
                        view: self.view_for(context.prior_handle.incarnation_id()).await?,
                        probe: Some(probe),
                        prior_incarnation_id: None,
                        attempt_id: None,
                        expected_native_session_id: None,
                        observed_native_session_id: None,
                        incident_id: None,
                    });
                }
                self.registry
                    .mark_recovery_blocked_with_retry(
                        request.soul_id.clone(),
                        None,
                        reason,
                        evidence,
                        observed_context.write_fence(),
                        transient,
                    )
                    .await
                    .map_err(map_registry)?;
                let context = self
                    .registry
                    .recovery_context(request.soul_id)
                    .await
                    .map_err(map_registry)?;
                Ok(RecoveryResult {
                    outcome: RecoveryOutcome::Blocked,
                    view: self.view_for(context.prior_handle.incarnation_id()).await?,
                    probe: Some(probe),
                    prior_incarnation_id: None,
                    attempt_id: None,
                    expected_native_session_id: None,
                    observed_native_session_id: None,
                    incident_id: None,
                })
            }),
            RecoveryProbe::DefinitivelyUnavailable { .. } => Box::pin(async move {
                // Legacy and opt-out rollout states retain Phase 3 semantics:
                // a definitive provider-path negative is preserved as BLOCKED.
                // Only newly opted-in/default managed operation may authorize
                // the stricter Phase 5 loss certificate and cleanup pipeline.
                if self.registry.rollout_mode().await.map_err(map_registry)?
                    == ManagedRolloutMode::Legacy
                {
                    return self
                        .preserve_definitive_as_blocked(
                            request.soul_id,
                            probe,
                            observed_context.write_fence(),
                        )
                        .await;
                }
                // Loss authority requires a fresh second probe after every
                // recovery path has already reported a negative. A late host,
                // store, checkpoint, or stop-intent transition cancels loss.
                let (rechecked, rechecked_context, rechecked_transient) = self
                    .probe_recovery_for_attempt(request.soul_id.clone())
                    .await?;
                match rechecked.clone() {
                    RecoveryProbe::Blocked {
                        reason, evidence, ..
                    } => {
                        self.registry
                            .mark_recovery_blocked_with_retry(
                                request.soul_id.clone(),
                                None,
                                reason,
                                evidence,
                                rechecked_context.write_fence(),
                                rechecked_transient,
                            )
                            .await
                            .map_err(map_registry)?;
                        let context = self
                            .registry
                            .recovery_context(request.soul_id)
                            .await
                            .map_err(map_registry)?;
                        Ok(RecoveryResult {
                            outcome: if reason == RecoveryBlockReason::StopIntent {
                                RecoveryOutcome::Stopped
                            } else {
                                RecoveryOutcome::Blocked
                            },
                            view: self.view_for(context.prior_handle.incarnation_id()).await?,
                            probe: Some(rechecked),
                            prior_incarnation_id: None,
                            attempt_id: None,
                            expected_native_session_id: None,
                            observed_native_session_id: None,
                            incident_id: None,
                        })
                    }
                    RecoveryProbe::DefinitivelyUnavailable { .. } => {
                        Box::pin(self.certify_and_cleanup_loss(
                            request.soul_id,
                            request.trigger,
                            rechecked,
                        ))
                        .await
                    }
                    _ => {
                        // Reuse the positive completion branches instead of
                        // embedding their large launch futures in this loss
                        // revalidation poll frame.
                        self.complete_recovery_probe(
                            request,
                            rechecked,
                            rechecked_context,
                            rechecked_transient,
                        )
                        .await
                    }
                }
            }),
            RecoveryProbe::ResumeReady { resume_spec, .. } => Box::pin(async move {
                let path = if resume_spec.checkpoint_revision > 0 {
                    RecoveryPath::CheckpointRestore
                } else {
                    RecoveryPath::NativeResume
                };
                Box::pin(self.replace(
                    request.soul_id,
                    request.trigger,
                    path,
                    Some(*resume_spec),
                    probe,
                    observed_context.write_fence(),
                ))
                .await
            }),
            RecoveryProbe::PristineSeedReady { .. } => Box::pin(async move {
                Box::pin(self.replace(
                    request.soul_id,
                    request.trigger,
                    RecoveryPath::PristineSeed,
                    None,
                    probe,
                    observed_context.write_fence(),
                ))
                .await
            }),
        }
    }

    // Callers box this large, infrequent recovery future so its owned launch
    // and post-loader probe state do not inflate their polling stack.
    async fn replace(
        &self,
        soul_id: SoulId,
        trigger: RecoveryTrigger,
        path: RecoveryPath,
        resume_spec: Option<freshell_runtime_protocol::ResumeSpec>,
        probe: RecoveryProbe,
        probe_fence: RecoveryWriteFence,
    ) -> Result<RecoveryResult, RuntimeError> {
        let recovery_started = Instant::now();
        let start = match self
            .registry
            .begin_recovery_fenced(soul_id.clone(), trigger, path, probe_fence)
            .await
        {
            Ok(start) => start,
            Err(RegistryError::RecoveryBlocked { reason, .. })
                if reason.contains("STOP_INTENT") =>
            {
                let context = self
                    .registry
                    .recovery_context(soul_id)
                    .await
                    .map_err(map_registry)?;
                return Ok(RecoveryResult {
                    outcome: RecoveryOutcome::Stopped,
                    view: self.view_for(context.prior_handle.incarnation_id()).await?,
                    probe: Some(blocked(
                        path,
                        RecoveryBlockReason::StopIntent,
                        &reason,
                        None,
                    )),
                    prior_incarnation_id: None,
                    attempt_id: None,
                    expected_native_session_id: None,
                    observed_native_session_id: None,
                    incident_id: None,
                });
            }
            Err(error) => return Err(map_registry(error)),
        };
        let prior_incarnation_id = start.context.prior_handle.incarnation_id().clone();
        let attempt_id = start.attempt_id.clone();
        let mut verdict_fence = start.context.write_fence_for_attempt(attempt_id.clone());

        let stop_outcome = self
            .terminate_owned_for_recovery(&start.context.prior_handle)
            .await?;
        if stop_outcome != StopOutcome::VerifiedEmpty {
            let reason = RecoveryBlockReason::OldRuntimeNotEmpty;
            self.registry
                .mark_recovery_blocked(
                    soul_id.clone(),
                    Some(attempt_id.clone()),
                    reason,
                    vec![format!("stopOutcome={stop_outcome:?}")],
                    verdict_fence.clone(),
                )
                .await
                .map_err(map_registry)?;
            return Ok(RecoveryResult {
                outcome: RecoveryOutcome::Blocked,
                view: self.view_for(&prior_incarnation_id).await?,
                probe: Some(blocked(
                    path,
                    reason,
                    "the prior enclosure could not be proved empty",
                    Some(2_000),
                )),
                prior_incarnation_id: Some(prior_incarnation_id),
                attempt_id: Some(attempt_id),
                expected_native_session_id: resume_spec
                    .as_ref()
                    .map(|spec| spec.provider_session.native_session_id.clone()),
                observed_native_session_id: None,
                incident_id: None,
            });
        }

        let prior_has_indexed_inputs = start
            .context
            .prior_handle
            .terminal()
            .and_then(|spec| spec.provider_launch_context.as_ref())
            .or_else(|| {
                start
                    .context
                    .prior_handle
                    .fresh_agent()
                    .and_then(|spec| spec.provider_launch_context.as_ref())
            })
            .and_then(|context| context.prepared_inputs.as_ref())
            .is_some_and(|inputs| inputs.indexed_files.is_some());
        if prior_has_indexed_inputs
            && self
                .registry
                .is_stopped_unaccepted_replacement(prior_incarnation_id.clone())
                .await
                .map_err(map_registry)?
        {
            // The previous failed start can still own this retained input
            // generation after a transient cleanup failure. Release its exact
            // stopped ownership before a successor is prepared or published.
            if let Err(error) = self
                .discard_failed_replacement_inputs(&start.context.prior_handle)
                .await
            {
                let reason = RecoveryBlockReason::ProviderUnavailable;
                self.registry
                    .mark_recovery_blocked_with_retry(
                        soul_id.clone(),
                        Some(attempt_id.clone()),
                        reason,
                        vec![error.message.clone()],
                        verdict_fence.clone(),
                        TransientRecoveryFailure::from_runtime(&error),
                    )
                    .await
                    .map_err(map_registry)?;
                return Ok(RecoveryResult {
                    outcome: RecoveryOutcome::Blocked,
                    view: self.view_for(&prior_incarnation_id).await?,
                    probe: Some(blocked(path, reason, &error.message, Some(2_000))),
                    prior_incarnation_id: Some(prior_incarnation_id),
                    attempt_id: Some(attempt_id),
                    expected_native_session_id: resume_spec
                        .as_ref()
                        .map(|spec| spec.provider_session.native_session_id.clone()),
                    observed_native_session_id: None,
                    incident_id: None,
                });
            }
        }

        let replacement_terminal = if resume_spec.is_some() {
            terminal_without_first_boot_state(start.context.terminal.clone())
        } else {
            start.context.terminal.clone()
        };
        let mut replacement_terminal = replacement_terminal;
        let mut replacement_fresh = fresh_without_raw_bootstrap(start.context.fresh_agent.clone());
        if replacement_terminal.as_ref().is_some_and(|terminal| {
            matches!(
                terminal.mode.as_str(),
                "claude" | "codex" | "opencode" | "amplifier"
            ) && terminal
                .provider_launch_context
                .as_ref()
                .and_then(|context| context.mcp_capability.as_ref())
                .is_none()
        }) {
            let reason = RecoveryBlockReason::CapabilityPending;
            self.registry
                .mark_recovery_blocked(
                    soul_id.clone(),
                    Some(attempt_id.clone()),
                    reason,
                    vec!["managed MCP capability must be reissued before replacement".into()],
                    verdict_fence.clone(),
                )
                .await
                .map_err(map_registry)?;
            return Ok(RecoveryResult {
                outcome: RecoveryOutcome::Blocked,
                view: self.view_for(&prior_incarnation_id).await?,
                probe: Some(blocked(
                    path,
                    reason,
                    "managed MCP capability must be reissued before replacement",
                    Some(2_000),
                )),
                prior_incarnation_id: Some(prior_incarnation_id),
                attempt_id: Some(attempt_id),
                expected_native_session_id: resume_spec
                    .as_ref()
                    .map(|spec| spec.provider_session.native_session_id.clone()),
                observed_native_session_id: None,
                incident_id: None,
            });
        }
        let replacement_context = replacement_terminal
            .as_ref()
            .and_then(|terminal| {
                terminal.provider_launch_context.as_ref().map(|context| {
                    (
                        terminal.mode.clone(),
                        context.clone(),
                        terminal.provider_secret_references.clone(),
                        terminal.cwd.clone(),
                        terminal.workspace_path.clone(),
                    )
                })
            })
            .or_else(|| {
                replacement_fresh.as_ref().and_then(|agent| {
                    agent.provider_launch_context.as_ref().map(|context| {
                        (
                            agent.provider.native_provider().to_owned(),
                            context.clone(),
                            agent.provider_secret_references.clone(),
                            agent.cwd.clone(),
                            agent.workspace_path.clone(),
                        )
                    })
                })
            });
        if let Some((provider, context, references, cwd, workspace)) = replacement_context {
            if context.mcp_capability.is_some() {
                let refreshed_capability = self
                    .issue_replacement_mcp_capability(
                        &start,
                        &provider,
                        &context,
                        &references,
                        &cwd,
                        &workspace,
                    )
                    .await;
                let prepared_context = match refreshed_capability {
                    Ok(refreshed) => refreshed,
                    Err(error) => {
                        let reason = RecoveryBlockReason::CapabilityPending;
                        self.registry
                            .mark_recovery_blocked_with_retry(
                                soul_id.clone(),
                                Some(attempt_id.clone()),
                                reason,
                                vec![error.message.clone()],
                                verdict_fence.clone(),
                                TransientRecoveryFailure::from_runtime(&error)
                                    .map(|_| TransientRecoveryFailure::Preparation),
                            )
                            .await
                            .map_err(map_registry)?;
                        return Ok(RecoveryResult {
                            outcome: RecoveryOutcome::Blocked,
                            view: self.view_for(&prior_incarnation_id).await?,
                            probe: Some(blocked(path, reason, &error.message, Some(2_000))),
                            prior_incarnation_id: Some(prior_incarnation_id),
                            attempt_id: Some(attempt_id),
                            expected_native_session_id: resume_spec
                                .as_ref()
                                .map(|spec| spec.provider_session.native_session_id.clone()),
                            observed_native_session_id: None,
                            incident_id: None,
                        });
                    }
                };
                install_prepared_provider_context(
                    replacement_terminal.as_mut(),
                    replacement_fresh.as_mut(),
                    prepared_context,
                )?;
            }
        }
        let prepared = match self
            .registry
            .prepare_replacement(
                start.clone(),
                replacement_terminal,
                replacement_fresh,
                resume_spec.clone(),
                path,
            )
            .await
        {
            Ok(prepared) => prepared,
            Err(RegistryError::RecoveryBlocked { reason, .. })
                if reason.contains("STOP_INTENT") || reason.contains("STALE_ATTEMPT") =>
            {
                return Ok(RecoveryResult {
                    outcome: RecoveryOutcome::Stopped,
                    view: self.view_for(&prior_incarnation_id).await?,
                    probe: Some(blocked(
                        path,
                        RecoveryBlockReason::StopIntent,
                        &reason,
                        None,
                    )),
                    prior_incarnation_id: Some(prior_incarnation_id),
                    attempt_id: Some(attempt_id),
                    expected_native_session_id: resume_spec
                        .as_ref()
                        .map(|spec| spec.provider_session.native_session_id.clone()),
                    observed_native_session_id: None,
                    incident_id: None,
                });
            }
            Err(error) => return Err(map_registry(error)),
        };

        verdict_fence = verdict_fence.for_incarnation(prepared.prepared.incarnation_id.clone());
        if prepared.resume_spec.is_some() {
            crate::service::append_event(
                &self.config.lifecycle_log,
                "supervisor.recovery.replacement_writer_prepared",
                serde_json::json!({"severity":"info", "soulId":soul_id,
                    "priorIncarnationId":prior_incarnation_id, "incarnationId":prepared.prepared.incarnation_id,
                    "provider":start.context.provider, "providerStoreId":start.context.provider_store_id,
                    "nativeSessionId":start.context.native_session_id, "attemptId":attempt_id,
                    "intentRevision":start.context.intent_revision, "writerState":"prepared"}),
            );
        }
        let workload = LaunchWorkload {
            soul_id: soul_id.clone(),
            fixture: prepared.fixture,
            terminal: prepared.terminal.clone(),
            fresh_agent: prepared.fresh_agent.clone(),
            resume_spec: prepared.resume_spec.clone(),
        };
        let opencode_readiness = workload.opencode_tui_readiness_required(&start.context.provider);
        // Keep activation's owned launch/grant state off the replacement
        // polling frame, as at the other large recovery async boundaries.
        let launch = Box::pin(self.activate_prepared_observed(
            prepared.prepared.clone(),
            workload,
            start.context.requested_limits,
            verdict_fence.clone(),
        ))
        .await;
        match launch {
            Ok((_, successor)) => {
                verdict_fence = successor;
            }
            Err(error) => {
                let mut transient = TransientRecoveryFailure::from_runtime(&error);
                let reason = if error.message.starts_with("capability_pending:") {
                    transient = transient.map(|_| TransientRecoveryFailure::Preparation);
                    RecoveryBlockReason::CapabilityPending
                } else if transient.is_some() {
                    RecoveryBlockReason::ProviderUnavailable
                } else {
                    classify_provider_failure(&error.message)
                };
                crate::service::append_event(
                    &self.config.lifecycle_log,
                    "supervisor.recovery.activation_failed",
                    recovery_activation_failure_data(
                        &soul_id,
                        &prior_incarnation_id,
                        &prepared.prepared.incarnation_id,
                        &attempt_id,
                        path,
                        reason,
                        &error,
                    ),
                );
                self.cleanup_failed_replacement(&prepared.prepared.incarnation_id)
                    .await;
                self.registry
                    .mark_recovery_blocked_with_retry(
                        soul_id.clone(),
                        Some(attempt_id.clone()),
                        reason,
                        vec![error.message.clone()],
                        verdict_fence.clone(),
                        transient,
                    )
                    .await
                    .map_err(map_registry)?;
                return Ok(RecoveryResult {
                    outcome: RecoveryOutcome::Blocked,
                    view: self
                        .view_for_or_prior(&prepared.prepared.incarnation_id, &prior_incarnation_id)
                        .await?,
                    probe: Some(blocked(path, reason, &error.message, Some(2_000))),
                    prior_incarnation_id: Some(prior_incarnation_id),
                    attempt_id: Some(attempt_id),
                    expected_native_session_id: resume_spec
                        .as_ref()
                        .map(|spec| spec.provider_session.native_session_id.clone()),
                    observed_native_session_id: None,
                    incident_id: None,
                });
            }
        };

        let expected_native_session_id = resume_spec
            .as_ref()
            .map(|spec| spec.provider_session.native_session_id.clone());
        let requires_native = start.context.fixture.is_none()
            && matches!(
                start.context.provider.as_str(),
                "claude" | "kilroy" | "codex" | "opencode" | "amplifier"
            );
        let observed_native_session_id = if expected_native_session_id.is_some() || requires_native
        {
            let wait = self
                .wait_for_native_identity(
                    &soul_id,
                    &prepared.prepared.incarnation_id,
                    start.context.intent_revision,
                    native_identity_wait_timeout(opencode_readiness),
                    true,
                )
                .await;
            if matches!(wait, NativeIdentityWait::StopIntent { .. }) {
                let current = self
                    .registry
                    .recovery_context(soul_id.clone())
                    .await
                    .map_err(map_registry)?;
                return Ok(RecoveryResult {
                    outcome: RecoveryOutcome::Stopped,
                    view: self.view_for(current.prior_handle.incarnation_id()).await?,
                    probe: Some(blocked(
                        path,
                        RecoveryBlockReason::StopIntent,
                        "the durable desired state is STOPPED",
                        None,
                    )),
                    prior_incarnation_id: Some(prior_incarnation_id),
                    attempt_id: Some(attempt_id),
                    expected_native_session_id,
                    observed_native_session_id: None,
                    incident_id: None,
                });
            }
            if matches!(wait, NativeIdentityWait::IntentChanged { .. }) {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::StaleIntentRevision,
                    "soul intent changed while waiting for provider readiness",
                ));
            }
            let observed = match &wait {
                NativeIdentityWait::Observed {
                    native_session_id, ..
                } => Some(native_session_id.clone()),
                NativeIdentityWait::ProviderExited { .. }
                | NativeIdentityWait::HostUnavailable { .. }
                | NativeIdentityWait::TimedOut { .. }
                | NativeIdentityWait::StopIntent { .. }
                | NativeIdentityWait::IntentChanged { .. } => None,
            };
            let expected = expected_native_session_id
                .as_deref()
                .or(observed.as_deref())
                .unwrap_or("");
            if let Err((reason, message)) = validate_native_identity_wait(expected, wait.clone()) {
                let transient = match &wait {
                    NativeIdentityWait::HostUnavailable { transient, .. } => *transient,
                    _ => None,
                };
                let (wait_outcome, adoption_pending, elapsed_ms) = match wait {
                    NativeIdentityWait::Observed { elapsed_ms, .. } => {
                        ("identity_mismatch", false, elapsed_ms)
                    }
                    NativeIdentityWait::ProviderExited { elapsed_ms } => {
                        ("provider_exited", false, elapsed_ms)
                    }
                    NativeIdentityWait::HostUnavailable { elapsed_ms, .. } => {
                        ("host_unavailable", false, elapsed_ms)
                    }
                    NativeIdentityWait::TimedOut {
                        adoption_pending,
                        elapsed_ms,
                    } => ("timed_out", adoption_pending, elapsed_ms),
                    NativeIdentityWait::StopIntent { elapsed_ms } => {
                        ("stop_intent", false, elapsed_ms)
                    }
                    NativeIdentityWait::IntentChanged { elapsed_ms } => {
                        ("intent_changed", false, elapsed_ms)
                    }
                };
                crate::service::append_event(
                    &self.config.lifecycle_log,
                    "supervisor.recovery.native_identity_wait_failed",
                    serde_json::json!({
                        "soulId": soul_id,
                        "incarnationId": prepared.prepared.incarnation_id,
                        "provider": start.context.provider,
                        "outcome": wait_outcome,
                        "adoptionPending": adoption_pending,
                        "elapsedMs": elapsed_ms,
                        "reason": format!("{reason:?}"),
                    }),
                );
                self.cleanup_failed_replacement(&prepared.prepared.incarnation_id)
                    .await;
                self.registry
                    .mark_recovery_blocked_with_retry(
                        soul_id.clone(),
                        Some(attempt_id.clone()),
                        reason,
                        vec![message.clone()],
                        verdict_fence.clone(),
                        transient,
                    )
                    .await
                    .map_err(map_registry)?;
                return Ok(RecoveryResult {
                    outcome: RecoveryOutcome::Blocked,
                    view: self
                        .view_for_or_prior(&prepared.prepared.incarnation_id, &prior_incarnation_id)
                        .await?,
                    probe: Some(blocked(
                        path,
                        reason,
                        &message,
                        (reason != RecoveryBlockReason::WrongNativeIdentity).then_some(2_000),
                    )),
                    prior_incarnation_id: Some(prior_incarnation_id),
                    attempt_id: Some(attempt_id),
                    expected_native_session_id,
                    observed_native_session_id: observed,
                    incident_id: None,
                });
            }
            observed
        } else {
            None
        };

        if requires_native {
            let (current_probe, current, transient) =
                Box::pin(self.probe_recovery_for_attempt(soul_id.clone())).await?;
            let ready = matches!(&current_probe,RecoveryProbe::ReattachReady {handle,..}
                if handle.incarnation_id==prepared.prepared.incarnation_id);
            verdict_fence = current.write_fence_for_attempt(attempt_id.clone());
            if !ready {
                let (reason, message) = match &current_probe {
                    RecoveryProbe::Blocked {
                        reason, evidence, ..
                    } => (*reason, evidence.join("; ")),
                    _ => (
                        RecoveryBlockReason::ProviderUnavailable,
                        "current replacement lost its native/store readiness".into(),
                    ),
                };
                self.cleanup_failed_replacement(&prepared.prepared.incarnation_id)
                    .await;
                self.registry
                    .mark_recovery_blocked_with_retry(
                        soul_id.clone(),
                        Some(attempt_id.clone()),
                        reason,
                        vec![message.clone()],
                        verdict_fence.clone(),
                        transient,
                    )
                    .await
                    .map_err(map_registry)?;
                return Ok(RecoveryResult {
                    outcome: RecoveryOutcome::Blocked,
                    view: self
                        .view_for_or_prior(&prepared.prepared.incarnation_id, &prior_incarnation_id)
                        .await?,
                    probe: Some(blocked(path, reason, &message, Some(2000))),
                    prior_incarnation_id: Some(prior_incarnation_id),
                    attempt_id: Some(attempt_id),
                    expected_native_session_id,
                    observed_native_session_id,
                    incident_id: None,
                });
            }
        }

        #[cfg(test)]
        automatic_retry_tests::crash_boundary("after_replacement_before_settlement");
        let provider = start.context.provider.clone();
        self.registry
            .mark_recovery_success(
                soul_id.clone(),
                prepared.prepared.incarnation_id.clone(),
                attempt_id.clone(),
                verdict_fence,
            )
            .await
            .map_err(map_registry)?;
        let accepted = self
            .registry
            .owned_handle(prepared.prepared.incarnation_id.clone())
            .await
            .map_err(map_registry)?;
        self.complete_pending_provider_preparation(&accepted)
            .await?;
        let input_admission = match self
            .release_pending_native_permissions_after_live(
                soul_id.clone(),
                prepared.prepared.incarnation_id.clone(),
            )
            .await
        {
            Ok(()) => {
                self.replay_queued_inputs(soul_id.clone(), prepared.prepared.incarnation_id.clone())
                    .await
            }
            Err(error) => Err(error.message),
        };
        if let Err(message) = input_admission {
            let live_context = self
                .registry
                .recovery_context(soul_id.clone())
                .await
                .map_err(map_registry)?;
            self.registry
                .mark_recovery_blocked(
                    soul_id.clone(),
                    None,
                    RecoveryBlockReason::CommandAmbiguous,
                    vec![message.clone()],
                    live_context.write_fence(),
                )
                .await
                .map_err(map_registry)?;
            return Ok(RecoveryResult {
                outcome: RecoveryOutcome::Blocked,
                view: self.view_for(&prepared.prepared.incarnation_id).await?,
                probe: Some(blocked(
                    path,
                    RecoveryBlockReason::CommandAmbiguous,
                    &message,
                    None,
                )),
                prior_incarnation_id: Some(prior_incarnation_id),
                attempt_id: Some(attempt_id),
                expected_native_session_id,
                observed_native_session_id,
                incident_id: None,
            });
        }

        let elapsed_ms = recovery_started
            .elapsed()
            .as_millis()
            .min(u128::from(u64::MAX)) as u64;
        for (name, label) in [
            ("recovery_outcome", format!("{provider}:replaced")),
            (
                "recovery_downtime_bucket",
                format!("{provider}:{}", downtime_bucket(elapsed_ms)),
            ),
            (
                "checkpoint_age_bucket",
                format!(
                    "{provider}:{}",
                    if path == RecoveryPath::CheckpointRestore {
                        "verified_restore"
                    } else {
                        "not_used"
                    }
                ),
            ),
        ] {
            if let Err(error) = self
                .registry
                .increment_runtime_counter(name, label, 1)
                .await
            {
                crate::service::append_event(
                    &self.config.lifecycle_log,
                    "supervisor.metrics.counter_failed",
                    serde_json::json!({"name": name, "error": error.to_string()}),
                );
            }
        }
        Ok(RecoveryResult {
            outcome: RecoveryOutcome::Replaced,
            view: self.view_for(&prepared.prepared.incarnation_id).await?,
            probe: Some(probe),
            prior_incarnation_id: Some(prior_incarnation_id),
            attempt_id: Some(attempt_id),
            expected_native_session_id,
            observed_native_session_id,
            incident_id: None,
        })
    }

    async fn release_pending_native_permissions_after_live(
        &self,
        soul_id: SoulId,
        incarnation_id: freshell_runtime_protocol::IncarnationId,
    ) -> Result<(), RuntimeError> {
        let context = self
            .registry
            .recovery_context(soul_id.clone())
            .await
            .map_err(map_registry)?;
        let Some(agent) = context.fresh_agent.as_ref().filter(|agent| {
            matches!(
                agent.provider,
                freshell_runtime_protocol::FreshProvider::Claude
                    | freshell_runtime_protocol::FreshProvider::Kilroy
            )
        }) else {
            return Ok(());
        };
        if agent.fixture_transport.is_some() || context.fixture.is_some() {
            return Ok(());
        }
        if context.recovery_state != freshell_runtime_protocol::RecoveryState::Live
            || context.desired_state != DesiredState::Running
            || context.prior_handle.incarnation_id() != &incarnation_id
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::RecoveryBlocked,
                "native permission release requires current durable LIVE admission",
            ));
        }
        let host = self
            .authenticate_host(&incarnation_id, context.prior_handle.runtime_dir())
            .await?;
        let status = self
            .host_status(
                incarnation_id.clone(),
                context.prior_handle.runtime_dir(),
                &host,
            )
            .await?;
        if status.exited
            || !host
                .capabilities
                .iter()
                .any(|capability| capability == "native-identity-observation-v1")
            || current_native_observation(&context, &status).is_none()
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::RecoveryWrongIdentity,
                "current native observation is unavailable before permission release",
            ));
        }
        let reply = self
            .send_authenticated_host_command(
                incarnation_id.clone(),
                context.prior_handle.runtime_dir(),
                &host,
                HostCommand::FreshAgentResumePending {
                    incarnation_id: incarnation_id.clone(),
                },
            )
            .await?;
        match reply {
            HostResult::FreshAgentCommand {
                state: CommandState::ProviderAcked,
                ..
            } => {
                crate::service::append_event(
                    &self.config.lifecycle_log,
                    "supervisor.native_permission.released",
                    serde_json::json!({"severity":"info","soulId":soul_id,"incarnationId":incarnation_id,"dispatchOnly":true}),
                );
                Ok(())
            }
            _ => Err(RuntimeError::new(
                RuntimeErrorCode::HostUnreachable,
                "native permission release has no current dispatch acknowledgement",
            )),
        }
    }

    async fn preserve_definitive_as_blocked(
        &self,
        soul_id: SoulId,
        probe: RecoveryProbe,
        fence: RecoveryWriteFence,
    ) -> Result<RecoveryResult, RuntimeError> {
        let (path, store_state, message, evidence) = match &probe {
            RecoveryProbe::DefinitivelyUnavailable {
                path,
                reason,
                evidence,
                store_state,
                ..
            } => (*path, *store_state, reason.clone(), evidence.clone()),
            _ => {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::InvalidRequest,
                    "legacy loss preservation requires a definitive-negative probe",
                ))
            }
        };
        let (_, mut preserved_evidence) =
            normalized_negative_evidence(path, store_state, &evidence);
        preserved_evidence.push("rolloutMode=legacy".into());
        preserved_evidence.push(format!(
            "definitiveNegativeReasonDigest={}",
            digest_forensic_strings(std::slice::from_ref(&message))
        ));
        self.registry
            .mark_recovery_blocked(
                soul_id.clone(),
                None,
                RecoveryBlockReason::ImplementationUnavailable,
                preserved_evidence.clone(),
                fence,
            )
            .await
            .map_err(map_registry)?;
        let context = self
            .registry
            .recovery_context(soul_id)
            .await
            .map_err(map_registry)?;
        Ok(RecoveryResult {
            outcome: RecoveryOutcome::Blocked,
            view: self.view_for(context.prior_handle.incarnation_id()).await?,
            probe: Some(RecoveryProbe::Blocked {
                path,
                reason: RecoveryBlockReason::ImplementationUnavailable,
                retry_hint: RetryHint {
                    automatic_after_ms: None,
                    manual_retry: true,
                    repair: Some(
                        "enable managed-opt-in/default only after migration preflight and backup"
                            .into(),
                    ),
                },
                evidence: preserved_evidence,
            }),
            prior_incarnation_id: None,
            attempt_id: None,
            expected_native_session_id: context.native_session_id,
            observed_native_session_id: None,
            incident_id: None,
        })
    }

    async fn certify_and_cleanup_loss(
        &self,
        soul_id: SoulId,
        trigger: RecoveryTrigger,
        definitive_probe: RecoveryProbe,
    ) -> Result<RecoveryResult, RuntimeError> {
        // Native stores and authenticated hosts can become visible while the
        // complete path inventory is being evaluated. Re-run the full probe
        // and rebuild every path row from the refreshed intent immediately
        // before constructing the certificate. Any late positive, unreadable
        // state, or stop/new-intent fence cancels loss.
        let (final_probe, context) = self.probe_recovery_observed(soul_id.clone()).await?;
        if !final_probe_still_allows_loss(&final_probe) {
            return self
                .preserve_nonloss_probe(soul_id, trigger, final_probe, context.write_fence())
                .await;
        }
        let path_evidence = match self
            .collect_loss_path_evidence(&context, &final_probe)
            .await
        {
            Ok(evidence) => evidence,
            Err(probe) => {
                return self
                    .preserve_nonloss_probe(soul_id, trigger, probe, context.write_fence())
                    .await;
            }
        };
        let provider_version = context
            .resume_spec
            .as_ref()
            .and_then(|spec| spec.provider_version.clone())
            .unwrap_or_else(|| match context.provider.as_str() {
                "shell" => "builtin-shell".into(),
                "phase1-fixture" | "native-session-fixture" => "native-session-fixture-v1".into(),
                provider => format!("unreported-{provider}"),
            });
        let now = freshell_runtime_observability::now_rfc3339_millis();
        let analysis = IncidentAnalysis {
            observed_cause: "all_applicable_recovery_paths_definitively_unavailable".into(),
            missing_invariant: "no live enclosure, readable native store, verified checkpoint, or pristine never-dispatched seed remained".into(),
            hypotheses: vec![
                "provider state was removed or became irreversibly inconsistent".into(),
                "the runtime exited after its last durable recovery artifact disappeared".into(),
            ],
            preventive_action: "retain and continuously verify at least one independent native-store or checkpoint recovery artifact".into(),
            regression_case: "P5-G02".into(),
        };
        let current_native_census = self
            .current_native_census_for_paths(&context, &path_evidence)
            .await;
        if current_native_census.is_none() {
            return self
                .preserve_nonloss_probe(
                    soul_id,
                    trigger,
                    freshell_agent_runtime::unverified_native_probe(),
                    context.write_fence(),
                )
                .await;
        }
        let decision = match LostDecision::try_new_with_current_census(
            LossDecisionInput {
                installation_id: self.registry.installation_id(),
                context: &context,
                cleanup_handle: &context.prior_handle,
                path_evidence,
                builds: LossBuildEvidence {
                    web_commit: option_env!("FRESHELL_BUILD_COMMIT")
                        .unwrap_or("unknown")
                        .into(),
                    supervisor_commit: option_env!("FRESHELL_BUILD_COMMIT")
                        .unwrap_or("unknown")
                        .into(),
                    host_image_digest: self.config.image_ref.clone(),
                    provider_version,
                    protocol_version: CONTROL_PROTOCOL_VERSION,
                    registry_schema_version: crate::registry::SCHEMA_VERSION,
                },
                timeline: vec![
                    IncidentTimelineEvent {
                        seq: 1,
                        at: now.clone(),
                        event: format!("recovery_trigger:{trigger:?}"),
                        evidence_ref: Some(format!(
                            "registry://soul/{}/incarnation/{}",
                            soul_id,
                            context.prior_handle.incarnation_id()
                        )),
                        exit_code: None,
                        oom_killed: None,
                    },
                    IncidentTimelineEvent {
                        seq: 2,
                        at: now.clone(),
                        event: "all_applicable_recovery_paths_definitively_negative".into(),
                        evidence_ref: Some("capability-manifest://recoveryPaths".into()),
                        exit_code: None,
                        oom_killed: None,
                    },
                ],
                analysis,
                created_at: Some(now.clone()),
            },
            current_native_census.as_deref(),
        ) {
            Ok(decision) => decision,
            Err(error) => {
                let message = format!("loss certification blocked: {error}");
                self.registry
                    .mark_recovery_blocked(
                        soul_id.clone(),
                        None,
                        RecoveryBlockReason::ImplementationUnavailable,
                        vec![message.clone()],
                        context.write_fence(),
                    )
                    .await
                    .map_err(map_registry)?;
                crate::service::append_event(
                    &self.config.lifecycle_log,
                    "supervisor.loss.certification_blocked",
                    serde_json::json!({"soulId": soul_id, "error": message}),
                );
                return Ok(RecoveryResult {
                    outcome: RecoveryOutcome::Blocked,
                    view: self.view_for(context.prior_handle.incarnation_id()).await?,
                    probe: Some(blocked(
                        RecoveryPath::NativeResume,
                        RecoveryBlockReason::ImplementationUnavailable,
                        &message,
                        None,
                    )),
                    prior_incarnation_id: None,
                    attempt_id: None,
                    expected_native_session_id: context.native_session_id,
                    observed_native_session_id: None,
                    incident_id: None,
                });
            }
        };

        // Freeze stage publication through the loss commit. Existing partial
        // or queued entries were already considered; a newly begun transfer
        // must not slip between that census and certification.
        let staging_guard = self.opencode_transfer_lifecycle_lock.lock().await;
        if let Err(probe) = self.require_no_staged_native_source(&context).await {
            drop(staging_guard);
            return self
                .preserve_nonloss_probe(soul_id, trigger, probe, context.write_fence())
                .await;
        }
        if self
            .current_loss_native_census(&context, decision.certificate())
            .await
            .is_none()
        {
            drop(staging_guard);
            return self
                .preserve_nonloss_probe(
                    soul_id,
                    trigger,
                    freshell_agent_runtime::unverified_native_probe(),
                    context.write_fence(),
                )
                .await;
        }
        // The SQLite transaction below is the destructive-action gate. If it
        // cannot durably commit the incident and export intent, no stop signal
        // is sent and the caller receives an explicit persistence failure.
        let prepared = self
            .registry
            .prepare_loss(decision)
            .await
            .map_err(|error| {
                crate::service::append_event(
                    &self.config.lifecycle_log,
                    "supervisor.loss.incident_commit_failed",
                    serde_json::json!({"soulId": soul_id, "error": error.to_string()}),
                );
                RuntimeError::new(
                    RuntimeErrorCode::IncidentPersistenceFailed,
                    format!("incident-before-cleanup commit failed: {error}"),
                )
            })?;
        drop(staging_guard);
        if let Err(error) = crate::service::append_incident_event_if_current(
            &self.registry,
            &self.config.lifecycle_log,
            "supervisor.loss.incident_committed",
            serde_json::json!({
                "soulId": soul_id,
                "incidentId": prepared.certificate.incident_id,
                "certificateSha256": hash_loss_certificate(&prepared.certificate),
                "cleanupTarget": prepared.certificate.cleanup_target.owned_handle_ref,
                "foreignObjectsTouched": 0,
            }),
            prepared.certificate.incident_id.clone(),
        )
        .await
        {
            tracing::warn!(incident_id=%prepared.certificate.incident_id, error=%error, "supervisor.loss.incident_committed_event_failed");
        }
        crate::service::crash_if("after_loss_incident_commit");
        self.export_pending_incidents().await?;

        let current_context = self
            .registry
            .recovery_context(soul_id.clone())
            .await
            .map_err(map_registry)?;
        if self
            .current_loss_native_census(&current_context, &prepared.certificate)
            .await
            .is_none()
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::LossCertificationBlocked,
                "native storage changed before loss cleanup",
            ));
        }
        let preexisting_empty = self
            .backend
            .verify_empty(&prepared.handle)
            .await
            .unwrap_or(false);
        let outcome = self.terminate_owned_for_loss(&prepared.handle).await?;
        let verified_empty = outcome == StopOutcome::VerifiedEmpty;
        let cleanup = LossCleanupReport {
            owned_handle_ref: prepared.certificate.cleanup_target.owned_handle_ref.clone(),
            ownership_verified: true,
            graceful_attempt: if preexisting_empty {
                "not_required".into()
            } else {
                "authenticated_host_and_exact_backend_stop_requested".into()
            },
            forced_attempt: if preexisting_empty {
                "not_required".into()
            } else if verified_empty {
                "attempted_only_if_graceful_verification_required_escalation".into()
            } else {
                "attempted_if_safe_but_empty_state_unconfirmed".into()
            },
            verified_empty,
            verified_at: verified_empty.then(freshell_runtime_observability::now_rfc3339_millis),
            foreign_objects_touched: 0,
        };
        crate::service::crash_if("after_loss_cleanup_before_finalize");
        let incident_id = prepared.certificate.incident_id.clone();
        let current_native_census = self
            .current_loss_native_census(&current_context, &prepared.certificate)
            .await;
        let _notice = self
            .registry
            .finalize_loss_cleanup_with_census(
                incident_id.clone(),
                outcome,
                cleanup,
                current_native_census,
            )
            .await
            .map_err(map_registry)?;
        crate::service::crash_if("after_loss_finalize_before_export");
        self.export_pending_incidents().await?;
        if let Err(error) = crate::service::append_incident_event_if_current(
            &self.registry,
            &self.config.lifecycle_log,
            "supervisor.loss.finalized",
            serde_json::json!({
                "soulId": soul_id,
                "incidentId": incident_id,
                "certificateSha256": hash_loss_certificate(&prepared.certificate),
                "cleanupOutcome": outcome,
                "foreignObjectsTouched": 0,
            }),
            incident_id.clone(),
        )
        .await
        {
            tracing::warn!(incident_id=%incident_id, error=%error, "supervisor.loss.finalized_event_failed");
        }
        Ok(RecoveryResult {
            outcome: RecoveryOutcome::Lost,
            view: self.view_for(prepared.handle.incarnation_id()).await?,
            probe: Some(definitive_probe),
            prior_incarnation_id: None,
            attempt_id: None,
            expected_native_session_id: context.native_session_id,
            observed_native_session_id: None,
            incident_id: Some(incident_id),
        })
    }

    async fn preserve_nonloss_probe(
        &self,
        soul_id: SoulId,
        trigger: RecoveryTrigger,
        probe: RecoveryProbe,
        fence: RecoveryWriteFence,
    ) -> Result<RecoveryResult, RuntimeError> {
        match probe.clone() {
            RecoveryProbe::ReattachReady { handle, .. } => {
                self.registry
                    .mark_recovery_live(soul_id.clone(), handle.incarnation_id.clone(), fence)
                    .await
                    .map_err(map_registry)?;
                let owned = self
                    .registry
                    .owned_handle(handle.incarnation_id.clone())
                    .await
                    .map_err(map_registry)?;
                self.complete_pending_provider_preparation(&owned).await?;
                self.release_pending_native_permissions_after_live(
                    soul_id,
                    handle.incarnation_id.clone(),
                )
                .await?;
                Ok(RecoveryResult {
                    outcome: RecoveryOutcome::Reattached,
                    view: self.view_for(&handle.incarnation_id).await?,
                    probe: Some(probe),
                    prior_incarnation_id: None,
                    attempt_id: None,
                    expected_native_session_id: None,
                    observed_native_session_id: None,
                    incident_id: None,
                })
            }
            RecoveryProbe::ResumeReady { resume_spec, .. } => {
                let path = if resume_spec.checkpoint_revision > 0 {
                    RecoveryPath::CheckpointRestore
                } else {
                    RecoveryPath::NativeResume
                };
                Box::pin(self.replace(soul_id, trigger, path, Some(*resume_spec), probe, fence))
                    .await
            }
            RecoveryProbe::PristineSeedReady { .. } => {
                Box::pin(self.replace(
                    soul_id,
                    trigger,
                    RecoveryPath::PristineSeed,
                    None,
                    probe,
                    fence,
                ))
                .await
            }
            RecoveryProbe::Blocked {
                reason, evidence, ..
            } => {
                self.registry
                    .mark_recovery_blocked(soul_id.clone(), None, reason, evidence, fence)
                    .await
                    .map_err(map_registry)?;
                let context = self
                    .registry
                    .recovery_context(soul_id)
                    .await
                    .map_err(map_registry)?;
                Ok(RecoveryResult {
                    outcome: if reason == RecoveryBlockReason::StopIntent {
                        RecoveryOutcome::Stopped
                    } else {
                        RecoveryOutcome::Blocked
                    },
                    view: self.view_for(context.prior_handle.incarnation_id()).await?,
                    probe: Some(probe),
                    prior_incarnation_id: None,
                    attempt_id: None,
                    expected_native_session_id: context.native_session_id,
                    observed_native_session_id: None,
                    incident_id: None,
                })
            }
            RecoveryProbe::DefinitivelyUnavailable { .. } => Err(RuntimeError::new(
                RuntimeErrorCode::LossCertificationBlocked,
                "loss evidence collector returned a second unhandled definitive-negative probe",
            )),
        }
    }

    pub(crate) async fn collect_loss_path_evidence(
        &self,
        context: &RecoveryContext,
        native_probe: &RecoveryProbe,
    ) -> Result<Vec<RecoveryPathEvidence>, RecoveryProbe> {
        let provider_paths = recovery_paths(&context.provider).ok_or_else(|| {
            blocked(
                RecoveryPath::NativeResume,
                RecoveryBlockReason::ImplementationUnavailable,
                "provider has no recovery capability manifest entry",
                None,
            )
        })?;
        let mut evidence = Vec::new();
        for path in provider_paths {
            let row = match path {
                RecoveryPath::Reattach => self.prove_reattach_unavailable(context).await?,
                RecoveryPath::NativeResume | RecoveryPath::CheckpointRestore => {
                    let row = checkpoints::inspected_negative(native_probe, *path)?;
                    if *path == RecoveryPath::NativeResume
                        && !crate::loss_report::native_absence_matches(
                            context,
                            row.store_state,
                            &row.evidence_refs,
                        )
                    {
                        return Err(freshell_agent_runtime::unverified_native_probe());
                    }
                    row
                }
                RecoveryPath::PristineSeed => {
                    if pristine_seed_is_safe(
                        context.never_dispatched,
                        context.native_session_id.as_deref(),
                        context.native_import_state,
                        context.native_import_absence_is_authoritative(),
                    ) {
                        return Err(RecoveryProbe::PristineSeedReady {
                            seed: context.creation_seed_ref.clone(),
                            never_dispatched_proof: format!(
                                "{}:command-journal-empty",
                                context.prior_handle.incarnation_id()
                            ),
                        });
                    }
                    if context.dispatched_command_count == 0 {
                        return Err(blocked(
                            RecoveryPath::PristineSeed,
                            RecoveryBlockReason::AmbiguousIdentity,
                            "initialization/native identity is uncertain; no durable input dispatch establishes pristine-seed unavailability",
                            None,
                        ));
                    }
                    RecoveryPathEvidence {
                        path: RecoveryPath::PristineSeed,
                        verdict: RecoveryEvidenceVerdict::DefinitiveNegative,
                        reason_code: if context.never_dispatched {
                            "native_identity_or_import_prevents_pristine_seed"
                        } else {
                            "input_was_dispatched"
                        }
                        .into(),
                        evidence_refs: vec![
                            format!("acceptedCommandCount={}", context.accepted_command_count),
                            format!("completedCommandCount={}", context.completed_command_count),
                            format!(
                                "dispatchedCommandCount={}",
                                context.dispatched_command_count
                            ),
                        ],
                        store_state: EvidenceStoreState::NotApplicable,
                    }
                }
                RecoveryPath::NativeImport => {
                    self.require_no_staged_native_source(context).await?;
                    match context.native_import_state {
                        NativeImportState::NotApplicable => RecoveryPathEvidence {
                            path: RecoveryPath::NativeImport,
                            verdict: RecoveryEvidenceVerdict::DefinitiveNegative,
                            reason_code: "no_native_import_configured".into(),
                            evidence_refs: vec!["nativeImport=not_applicable".into()],
                            store_state: EvidenceStoreState::NotApplicable,
                        },
                        NativeImportState::Absent
                            if context.native_import_absence_is_authoritative() =>
                        {
                            let source_evidence = format!(
                                "{}\0{}\0{}",
                                context.native_import_source_store_id.as_deref().unwrap(),
                                context.native_import_root_session_id.as_deref().unwrap(),
                                context.native_import_source_generation.as_deref().unwrap(),
                            );
                            RecoveryPathEvidence {
                                path: RecoveryPath::NativeImport,
                                verdict: RecoveryEvidenceVerdict::DefinitiveNegative,
                                reason_code: "complete_source_inventory_absent".into(),
                                evidence_refs: vec![format!(
                                    "nativeImportSourceDigest=sha256:{:x}",
                                    Sha256::digest(source_evidence.as_bytes())
                                )],
                                store_state: EvidenceStoreState::Missing,
                            }
                        }
                        state => {
                            return Err(blocked(
                                RecoveryPath::NativeImport,
                                RecoveryBlockReason::StoreUnreadable,
                                &format!(
                                    "native import source is not authoritatively absent (state={}, authority={})",
                                    state.as_str(), context.native_import_authority
                                ),
                                None,
                            ));
                        }
                    }
                }
            };
            let mut row = row;
            let (reason_code, evidence_refs) =
                normalized_negative_evidence(row.path, row.store_state, &row.evidence_refs);
            row.reason_code = reason_code;
            // NativeResume was qualified above against the exact context and
            // current reader generation. Persist its typed receipt rather than
            // raw transient JSON, which can carry private diagnostic payloads.
            let native_census = (row.path == RecoveryPath::NativeResume)
                .then(|| {
                    freshell_agent_runtime::canonical_native_absence_census_reference(
                        &row.evidence_refs,
                    )
                })
                .flatten();
            let qualified_refs: Vec<_> = row
                .evidence_refs
                .iter()
                .filter(|reference| {
                    reference
                        .split_once("=sha256:")
                        .is_some_and(|(kind, digest)| {
                            kind == "nativeStoreCensus"
                                && digest.len() == 64
                                && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
                        })
                })
                .cloned()
                .collect();
            row.evidence_refs = evidence_refs;
            row.evidence_refs.extend(qualified_refs);
            row.evidence_refs.extend(native_census);
            evidence.push(row);
        }
        Ok(evidence)
    }

    async fn require_no_staged_native_source(
        &self,
        context: &RecoveryContext,
    ) -> Result<(), RecoveryProbe> {
        let (Some(store), Some(root)) = (
            &context.native_import_source_store_id,
            &context.native_import_root_session_id,
        ) else {
            return Ok(());
        };
        let staging = std::sync::Arc::clone(&self.opencode_transfer_staging);
        let store = store.clone();
        let root = root.clone();
        let result =
            tokio::task::spawn_blocking(move || staging.has_origin_artifact(&store, &root)).await;
        match result {
            Ok(Ok(false)) => Ok(()),
            _ => Err(blocked(
                RecoveryPath::NativeImport,
                RecoveryBlockReason::StoreUnreadable,
                "native transfer staging contains available or unresolved recovery artifacts",
                None,
            )),
        }
    }

    async fn prove_reattach_unavailable(
        &self,
        context: &RecoveryContext,
    ) -> Result<RecoveryPathEvidence, RecoveryProbe> {
        let inspection = self
            .backend
            .inspect(&context.prior_handle)
            .await
            .map_err(|error| {
                blocked(
                    RecoveryPath::Reattach,
                    match error {
                        BackendError::OwnershipMismatch(_) => {
                            RecoveryBlockReason::OldRuntimeNotEmpty
                        }
                        _ => RecoveryBlockReason::ProviderUnavailable,
                    },
                    &error.to_string(),
                    Some(2_000),
                )
            })?;
        match inspection.state {
            BackendRuntimeState::Missing
            | BackendRuntimeState::Exited
            | BackendRuntimeState::Dead => Ok(RecoveryPathEvidence {
                path: RecoveryPath::Reattach,
                verdict: RecoveryEvidenceVerdict::DefinitiveNegative,
                reason_code: format!("backend_{:?}", inspection.state).to_ascii_lowercase(),
                evidence_refs: vec![
                    format!("containerId={}", context.prior_handle.container_id()),
                    format!("backendState={:?}", inspection.state),
                ],
                store_state: EvidenceStoreState::NotApplicable,
            }),
            BackendRuntimeState::Running => {
                let host = self
                    .authenticate_host(
                        context.prior_handle.incarnation_id(),
                        context.prior_handle.runtime_dir(),
                    )
                    .await
                    .map_err(|error| {
                        blocked(
                            RecoveryPath::Reattach,
                            RecoveryBlockReason::ProviderUnavailable,
                            &format!(
                                "running enclosure has no authenticated host certainty: {}",
                                error.message
                            ),
                            Some(2_000),
                        )
                    })?;
                if context.provider!="shell" && context.fixture.is_none() && !retained_host_features_known(&host) {
                    return Err(blocked(RecoveryPath::Reattach,RecoveryBlockReason::CapabilityPending,"retained_host_capability_unknown",Some(2000)));
                }
                let status = self
                    .host_status(
                        context.prior_handle.incarnation_id().clone(),
                        context.prior_handle.runtime_dir(),
                        &host,
                    )
                    .await
                    .map_err(|error| {
                        blocked(
                            RecoveryPath::Reattach,
                            RecoveryBlockReason::ProviderUnavailable,
                            &format!("host liveness remains unknown: {}", error.message),
                            Some(2_000),
                        )
                    })?;
                if !status.exited {
                    let handle=ReattachHandle{incarnation_id:context.prior_handle.incarnation_id().clone(),host_boot_id:status.host_boot_id.clone(),container_id:context.prior_handle.container_id().into()};
                    if context.provider!="shell" && context.fixture.is_none() && !deterministic_fresh_fixture(context) {
                        let candidate=resume_catalog::exact_resume_candidate(context,None)?;
                        let captured=self.probe_host_store(context,&host,candidate).await.map_err(|error|blocked(RecoveryPath::Reattach,RecoveryBlockReason::StoreUnreadable,&error.message,Some(2000)))?;
                        let captured=after_native_probe(context,captured);
                        if !retained_status_observed(context,&host,&status) && matches!(&captured,RecoveryProbe::ResumeReady{..}|RecoveryProbe::PristineSeedReady{..}) {
                            return Err(blocked(RecoveryPath::Reattach,RecoveryBlockReason::CapabilityPending,"retained_native_observation_unqualified",Some(2000)));
                        }
                        return Err(retained_runtime_probe(false,handle,captured,true));
                    }
                    return Err(retained_runtime_probe(false,handle,RecoveryProbe::PristineSeedReady{seed:"fixture".into(),never_dispatched_proof:"fixture".into()},false));
                }
                Ok(RecoveryPathEvidence {
                    path: RecoveryPath::Reattach,
                    verdict: RecoveryEvidenceVerdict::DefinitiveNegative,
                    reason_code: "provider_worker_exited".into(),
                    evidence_refs: vec![
                        format!("containerId={}", context.prior_handle.container_id()),
                        format!("workerLaunchCount={}", status.worker_launch_count),
                        format!("workerPid={:?}", status.worker_pid),
                    ],
                    store_state: EvidenceStoreState::NotApplicable,
                })
            }
            other => Err(blocked(
                RecoveryPath::Reattach,
                RecoveryBlockReason::OldRuntimeNotEmpty,
                &format!(
                    "owned runtime is {other:?}; liveness is neither attachable nor definitively ended"
                ),
                Some(2_000),
            )),
        }
    }

    async fn current_loss_native_census(
        &self,
        context: &RecoveryContext,
        certificate: &freshell_runtime_protocol::LostDecisionCertificate,
    ) -> Option<Vec<String>> {
        let current = self
            .current_native_census_for_paths(context, &certificate.recovery_paths)
            .await;
        crate::service::append_event(
            &self.config.lifecycle_log,
            "supervisor.loss.current_native_census",
            serde_json::json!({
                "severity": if current.is_some() { "info" } else { "warn" },
                "soulId": context.soul_id, "incarnationId": context.prior_handle.incarnation_id(),
                "incidentId": certificate.incident_id, "intentRevision": context.intent_revision,
                "identityRevision": context.identity_revision, "evidenceRevision": context.evidence_revision,
                "controlEpoch": context.control_epoch,
                "reason": if current.is_some() { "current_exact_native_absence_verified" } else { "current_native_census_unavailable_or_changed" },
            }),
        );
        current
    }

    async fn current_native_census_for_paths(
        &self,
        context: &RecoveryContext,
        paths: &[RecoveryPathEvidence],
    ) -> Option<Vec<String>> {
        if context.provider == "shell" {
            return Some(Vec::new());
        }
        crate::loss_report::validate_native_absence(context, paths).ok()?;
        let native = paths
            .iter()
            .find(|row| row.path == RecoveryPath::NativeResume)?;
        if !freshell_agent_runtime::native_absence_census_is_container(&native.evidence_refs) {
            return freshell_agent_runtime::native_absence_census_current(&native.evidence_refs)
                .then(|| native.evidence_refs.clone());
        }
        let spec = resume_catalog::exact_resume_candidate(context, None).ok()??;
        let fresh = self
            .backend
            .read_native_census(
                &context.prior_handle,
                &spec,
                &self.config.host_binary_path,
                &self.config.image_ref,
            )
            .await
            .ok()?;
        let freshell_agent_runtime::ProviderStoreProbe::DefinitivelyUnavailable {
            evidence,
            store_state,
            ..
        } = fresh
        else {
            return None;
        };
        (crate::loss_report::native_absence_matches(context, store_state, &evidence)
            && freshell_agent_runtime::same_native_absence_census(&native.evidence_refs, &evidence))
        .then_some(evidence)
    }

    /// Resume the incident-before-cleanup pipeline only after a current census
    /// of the exact retained volume; a historical certificate is insufficient.
    pub async fn reconcile_pending_loss_cleanup(&self) -> Result<(), RuntimeError> {
        if self.drain_pending_incident_exports().await?
            == crate::stopped_repair_cas::StoppedRepairWithdrawalStatus::FilesPending
        {
            // Keep repair control available while durable withdrawal is
            // retryable, without proceeding to destructive loss cleanup.
            return Ok(());
        }
        let incidents = self
            .registry
            .unresolved_loss_incident_ids()
            .await
            .map_err(map_registry)?;
        for incident_id in incidents {
            let certificate = self
                .registry
                .loss_certificate(incident_id.clone())
                .await
                .map_err(map_registry)?;
            let lifecycle_lock = self.lifecycle_lock(&certificate.soul_id).await;
            let _guard = lifecycle_lock.lock().await;
            let context = self
                .registry
                .recovery_context(certificate.soul_id.clone())
                .await
                .map_err(map_registry)?;
            if self
                .current_loss_native_census(&context, &certificate)
                .await
                .is_none()
            {
                crate::service::append_event(
                    &self.config.lifecycle_log,
                    "supervisor.loss.historical_certification_blocked",
                    serde_json::json!({"severity":"warn","soulId":certificate.soul_id,
                        "incarnationId":certificate.cleanup_target.incarnation_id,"incidentId":incident_id,
                        "intentRevision":context.intent_revision,"identityRevision":context.identity_revision,
                        "evidenceRevision":context.evidence_revision,"controlEpoch":context.control_epoch,
                        "reason":"native_absence_census_unverified","cleanupContinued":false}),
                );
                continue;
            }
            let handle = self
                .registry
                .owned_handle(certificate.cleanup_target.incarnation_id.clone())
                .await
                .map_err(map_registry)?;
            let preexisting_empty = self.backend.verify_empty(&handle).await.unwrap_or(false);
            let outcome = self.terminate_owned_for_loss(&handle).await?;
            let verified_empty = outcome == StopOutcome::VerifiedEmpty;
            let cleanup = LossCleanupReport {
                owned_handle_ref: certificate.cleanup_target.owned_handle_ref.clone(),
                ownership_verified: true,
                graceful_attempt: if preexisting_empty {
                    "not_required".into()
                } else {
                    "startup_resume_authenticated_host_and_exact_backend_stop_requested".into()
                },
                forced_attempt: if preexisting_empty {
                    "not_required".into()
                } else if verified_empty {
                    "attempted_only_if_graceful_verification_required_escalation".into()
                } else {
                    "attempted_if_safe_but_empty_state_unconfirmed".into()
                },
                verified_empty,
                verified_at: verified_empty
                    .then(freshell_runtime_observability::now_rfc3339_millis),
                foreign_objects_touched: 0,
            };
            let current_native_census = self
                .current_loss_native_census(&context, &certificate)
                .await;
            self.registry
                .finalize_loss_cleanup_with_census(
                    incident_id.clone(),
                    outcome,
                    cleanup,
                    current_native_census,
                )
                .await
                .map_err(map_registry)?;
            if let Err(error) = crate::service::append_incident_event_if_current(
                &self.registry,
                &self.config.lifecycle_log,
                "supervisor.loss.startup_cleanup_resumed",
                serde_json::json!({
                    "incidentId": incident_id,
                    "soulId": certificate.soul_id,
                    "cleanupOutcome": outcome,
                }),
                incident_id.clone(),
            )
            .await
            {
                tracing::warn!(incident_id=%incident_id, error=%error, "supervisor.loss.startup_cleanup_event_failed");
            }
        }
        self.drain_pending_incident_exports().await?;
        Ok(())
    }

    pub(crate) async fn export_pending_incidents(&self) -> Result<(), RuntimeError> {
        match self.drain_pending_incident_exports().await? {
            crate::stopped_repair_cas::StoppedRepairWithdrawalStatus::Complete => Ok(()),
            crate::stopped_repair_cas::StoppedRepairWithdrawalStatus::FilesPending => {
                Err(RuntimeError::new(
                    RuntimeErrorCode::IncidentPersistenceFailed,
                    "a stopped-repair incident withdrawal remains pending",
                ))
            }
        }
    }

    async fn drain_pending_incident_exports(
        &self,
    ) -> Result<crate::stopped_repair_cas::StoppedRepairWithdrawalStatus, RuntimeError> {
        // Drain unrelated durable exports even if withdrawal failed. Return
        // that typed result only after all eligible artifacts are persisted.
        let withdrawal = self
            .registry
            .resume_pending_stopped_repair_withdrawal_status(
                self.registry.registry_root().join("incidents"),
                self.config.lifecycle_log.clone(),
            )
            .await
            .map_err(map_registry);
        let exports = match self.registry.pending_incident_exports(100).await {
            Ok(exports) => exports,
            Err(error) => {
                crate::service::append_event(
                    &self.config.lifecycle_log,
                    "supervisor.loss.export_queue_read_failed",
                    serde_json::json!({"error": error.to_string()}),
                );
                return Err(RuntimeError::new(
                    RuntimeErrorCode::IncidentPersistenceFailed,
                    "durable incident export queue is unavailable",
                ));
            }
        };
        let exporter = IncidentExporter::new(
            self.registry.registry_root().join("incidents"),
            self.config.control_secret.clone(),
        );
        for event in exports {
            #[cfg(feature = "runtime-test-faults")]
            let injected_export_failure = std::env::var("FRESHELL_RUNTIME_INCIDENT_EXPORT_FAIL")
                .ok()
                .as_deref()
                == Some("1");
            #[cfg(not(feature = "runtime-test-faults"))]
            let injected_export_failure = false;
            let result = if injected_export_failure {
                Err("injected incident export failure".to_string())
            } else {
                self.registry
                    .export_and_ack_incident(event.clone(), exporter.clone())
                    .await
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            };
            match result {
                Ok(()) => {}
                Err(error) => {
                    // The SQLite incident/export intent is already durable,
                    // but destructive cleanup remains blocked until the
                    // private atomic incident artifact also reaches disk.
                    // Leave the outbox row pending for startup reconciliation.
                    eprintln!(
                        "Freshell loss incident export pending for {}: {}",
                        event.incident_id, error
                    );
                    if let Err(logging_error) = crate::service::append_incident_event_if_current(
                        &self.registry,
                        &self.config.lifecycle_log,
                        "supervisor.loss.export_failed",
                        serde_json::json!({
                            "incidentId": event.incident_id,
                            "error": error.to_string(),
                            "retryPending": true,
                        }),
                        event.incident_id.clone(),
                    )
                    .await
                    {
                        tracing::warn!(incident_id=%event.incident_id, error=%logging_error, "supervisor.loss.export_failure_event_failed");
                    }
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::IncidentPersistenceFailed,
                        "durable incident artifact could not be persisted before cleanup",
                    ));
                }
            }
        }
        withdrawal
    }

    pub(crate) async fn resume_pending_stopped_repair_withdrawals(
        &self,
    ) -> Result<(), RuntimeError> {
        self.registry
            .resume_pending_stopped_repair_withdrawals(
                self.registry.registry_root().join("incidents"),
                self.config.lifecycle_log.clone(),
            )
            .await
            .map_err(map_registry)
    }

    async fn replay_queued_inputs(
        &self,
        soul_id: SoulId,
        incarnation_id: freshell_runtime_protocol::IncarnationId,
    ) -> Result<(), String> {
        let handle = self
            .registry
            .owned_handle(incarnation_id.clone())
            .await
            .map_err(|error| error.to_string())?;
        let host = self
            .authenticate_host(handle.incarnation_id(), handle.runtime_dir())
            .await
            .map_err(|error| error.message)?;
        loop {
            let Some(command) = self
                .registry
                .claim_next_queued_input(soul_id.clone(), incarnation_id.clone())
                .await
                .map_err(|error| error.to_string())?
            else {
                return Ok(());
            };
            let request_id = command.request_id.clone();
            let host_command = if let Some(agent) = handle.fresh_agent() {
                HostCommand::FreshAgentSend {
                    incarnation_id: incarnation_id.clone(),
                    request_id: request_id.clone(),
                    text: command.data,
                    settings: Some(fresh_agent_replay_settings(agent)),
                    checkpoint_logical_attempt_id: None,
                }
            } else {
                HostCommand::TerminalInput {
                    incarnation_id: incarnation_id.clone(),
                    request_id: request_id.clone(),
                    data: command.data,
                }
            };
            let response = self
                .send_authenticated_host_command(
                    incarnation_id.clone(),
                    handle.runtime_dir(),
                    &host,
                    host_command,
                )
                .await;
            match response {
                Ok(HostResult::TerminalInput {
                    state: CommandState::Completed,
                })
                | Ok(HostResult::FreshAgentCommand {
                    state: CommandState::ProviderAcked | CommandState::Completed,
                    ..
                }) => {
                    self.registry
                        .mark_input_completed(soul_id.clone(), request_id)
                        .await
                        .map_err(|error| error.to_string())?;
                }
                Ok(HostResult::TerminalInput { state })
                | Ok(HostResult::FreshAgentCommand { state, .. }) => {
                    self.registry
                        .mark_input_ambiguous(soul_id.clone(), request_id)
                        .await
                        .map_err(|error| error.to_string())?;
                    return Err(format!(
                        "queued input reply was {state:?}; the prompt will not be replayed"
                    ));
                }
                Ok(_) => {
                    self.registry
                        .mark_input_ambiguous(soul_id.clone(), request_id)
                        .await
                        .map_err(|error| error.to_string())?;
                    return Err(
                        "queued input received an unexpected host reply; the prompt will not be replayed"
                            .into(),
                    );
                }
                Err(error) => {
                    self.registry
                        .mark_input_ambiguous(soul_id.clone(), request_id)
                        .await
                        .map_err(|registry_error| registry_error.to_string())?;
                    return Err(format!(
                        "queued input acknowledgement was lost: {}; the prompt will not be replayed",
                        error.message
                    ));
                }
            }
        }
    }

    async fn terminate_owned_for_loss(
        &self,
        handle: &OwnedRuntimeHandle,
    ) -> Result<StopOutcome, RuntimeError> {
        #[cfg(feature = "runtime-test-faults")]
        if let Ok(value) = std::env::var("FRESHELL_RUNTIME_LOSS_CLEANUP_FAILPOINT") {
            let outcome = match value.as_str() {
                "backend_unavailable" => Some(StopOutcome::BackendUnavailable),
                "blocked_ownership" => Some(StopOutcome::BlockedOwnership),
                "termination_unconfirmed" => Some(StopOutcome::TerminationUnconfirmed),
                _ => None,
            };
            if let Some(outcome) = outcome {
                self.registry
                    .mark_stop_outcome(handle.incarnation_id().clone(), outcome)
                    .await
                    .map_err(map_registry)?;
                return Ok(outcome);
            }
        }
        self.terminate_owned_for_recovery(handle).await
    }

    async fn terminate_owned_for_recovery(
        &self,
        handle: &OwnedRuntimeHandle,
    ) -> Result<StopOutcome, RuntimeError> {
        if self.backend.verify_empty(handle).await.unwrap_or(false) {
            self.registry
                .mark_stop_outcome(handle.incarnation_id().clone(), StopOutcome::VerifiedEmpty)
                .await
                .map_err(map_registry)?;
            self.record_recovery_writer_release(handle);
            return Ok(StopOutcome::VerifiedEmpty);
        }
        if let Ok(host) = self
            .authenticate_host(handle.incarnation_id(), handle.runtime_dir())
            .await
        {
            let _ = self
                .send_host_stop(handle.incarnation_id().clone(), handle.runtime_dir(), &host)
                .await;
        }
        let outcome = match self.backend.request_stop(handle, 2).await {
            Ok(()) => match self
                .verify_empty_with_budget(handle, Duration::from_secs(3))
                .await
            {
                Ok(true) => StopOutcome::VerifiedEmpty,
                Ok(false) => match self.backend.force_stop(handle).await {
                    Ok(()) => match self
                        .verify_empty_with_budget(handle, Duration::from_secs(3))
                        .await
                    {
                        Ok(true) => StopOutcome::VerifiedEmpty,
                        _ => StopOutcome::TerminationUnconfirmed,
                    },
                    Err(BackendError::OwnershipMismatch(_)) => StopOutcome::BlockedOwnership,
                    Err(_) => StopOutcome::TerminationUnconfirmed,
                },
                Err(error) if error.code == RuntimeErrorCode::OwnershipMismatch => {
                    StopOutcome::BlockedOwnership
                }
                Err(_) => StopOutcome::TerminationUnconfirmed,
            },
            Err(BackendError::OwnershipMismatch(_)) => StopOutcome::BlockedOwnership,
            Err(BackendError::Unavailable(_)) => StopOutcome::BackendUnavailable,
            Err(_) => StopOutcome::TerminationUnconfirmed,
        };
        self.registry
            .mark_stop_outcome(handle.incarnation_id().clone(), outcome)
            .await
            .map_err(map_registry)?;
        if outcome == StopOutcome::VerifiedEmpty {
            self.record_recovery_writer_release(handle);
        }
        Ok(outcome)
    }

    fn record_recovery_writer_release(&self, handle: &OwnedRuntimeHandle) {
        crate::service::append_event(
            &self.config.lifecycle_log,
            "supervisor.recovery.old_writer_released",
            serde_json::json!({"severity":"info", "soulId":handle.soul_id(),
                "incarnationId":handle.incarnation_id(), "containerId":handle.container_id(),
                "providerStoreId":handle.provider_store_id(), "launchNonce":handle.launch_nonce(),
                "outcome":"verified_empty", "writerState":"released"}),
        );
    }

    pub(crate) async fn wait_for_native_identity(
        &self,
        soul_id: &SoulId,
        incarnation_id: &freshell_runtime_protocol::IncarnationId,
        expected_intent_revision: u64,
        timeout: Duration,
        persist_observation: bool,
    ) -> NativeIdentityWait {
        let started = Instant::now();
        let handle = match self.registry.owned_handle(incarnation_id.clone()).await {
            Ok(handle) => handle,
            Err(error) => {
                return NativeIdentityWait::HostUnavailable {
                    transient: None,
                    message: map_registry(error).message,
                    elapsed_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                }
            }
        };
        let deadline = started + timeout;
        loop {
            let elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
            let host = self
                .authenticate_host(handle.incarnation_id(), handle.runtime_dir())
                .await;
            let native_capability = host.as_ref().is_ok_and(|host| {
                host.capabilities
                    .iter()
                    .any(|value| value == "native-identity-observation-v1")
            });
            let status = match host {
                Ok(host) => {
                    self.host_status(handle.incarnation_id().clone(), handle.runtime_dir(), &host)
                        .await
                }
                Err(error) => Err(error),
            };
            let current = match self.registry.recovery_context(soul_id.clone()).await {
                Ok(current) => current,
                Err(error) => {
                    return NativeIdentityWait::HostUnavailable {
                        transient: None,
                        message: map_registry(error).message,
                        elapsed_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                    }
                }
            };
            if let Some(cancellation) = native_identity_wait_cancellation(
                current.desired_state,
                current.intent_revision,
                expected_intent_revision,
                started.elapsed().as_millis().min(u64::MAX as u128) as u64,
            ) {
                return cancellation;
            }
            let status = match status {
                Ok(status) => status,
                Err(error) => {
                    return NativeIdentityWait::HostUnavailable {
                        transient: TransientRecoveryFailure::from_runtime(&error),
                        message: error.message,
                        elapsed_ms,
                    }
                }
            };
            if let Some(native_session_id) = current_fixture_native_session(&current, &status) {
                return NativeIdentityWait::Observed {
                    native_session_id: native_session_id.into(),
                    elapsed_ms,
                };
            }
            let observation = current_native_observation(&current, &status)
                .filter(|observation| {
                    native_capability && observation.incarnation_id == *incarnation_id
                })
                .cloned();
            #[cfg(feature = "runtime-test-faults")]
            if let Some(failure) = stopped_repair_resume_observation_fault(
                &current,
                &status,
                native_capability && observation.is_some(),
                std::env::var("FRESHELL_RUNTIME_STOPPED_REPAIR_RESUME_OBSERVATION_FAIL")
                    .ok()
                    .as_deref()
                    == Some("1"),
                elapsed_ms,
            ) {
                crate::service::append_event(
                    &self.config.lifecycle_log,
                    "supervisor.stopped_repair_resume_observation_test_failure",
                    serde_json::json!({"severity":"warn","reason":"test_observation_failure",
                        "soulId":soul_id,"incarnationId":incarnation_id,
                        "executionGeneration":status.max_execution_generation}),
                );
                return failure;
            }
            if !status.exited && persist_observation {
                if let Some(observation) = observation.as_ref() {
                    let mut fence = current.write_fence();
                    if current.native_session_id.is_none() {
                        fence = match self
                            .registry
                            .record_native_session_fenced(
                                soul_id.clone(),
                                incarnation_id.clone(),
                                observation.native_session_id.clone(),
                                fence,
                            )
                            .await
                        {
                            Ok(fence) => fence,
                            Err(error) => {
                                return NativeIdentityWait::HostUnavailable {
                                    transient: None,
                                    message: map_registry(error).message,
                                    elapsed_ms,
                                }
                            }
                        };
                    }
                    if let Err(error) = self
                        .registry
                        .record_native_identity_observation(
                            soul_id.clone(),
                            observation.clone(),
                            fence,
                        )
                        .await
                    {
                        return NativeIdentityWait::HostUnavailable {
                            transient: None,
                            message: map_registry(error).message,
                            elapsed_ms,
                        };
                    }
                }
            }
            if let Some(result) = native_identity_wait_from_status(
                status.exited,
                observation
                    .as_ref()
                    .map(|observation| observation.native_session_id.clone()),
                started.elapsed().as_millis().min(u64::MAX as u128) as u64,
            ) {
                return result;
            }
            if Instant::now() >= deadline {
                return NativeIdentityWait::TimedOut {
                    adoption_pending: status.opencode_adoption
                        == freshell_runtime_protocol::OpenCodeAdoptionStatus::AwaitingObservation,
                    elapsed_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                };
            }
            sleep(Duration::from_millis(250)).await;
        }
    }

    async fn cleanup_failed_replacement(
        &self,
        incarnation_id: &freshell_runtime_protocol::IncarnationId,
    ) {
        if let Ok(handle) = self.registry.owned_handle(incarnation_id.clone()).await {
            if self
                .registry
                .recovery_context(handle.soul_id().clone())
                .await
                .is_ok_and(|current| {
                    current.desired_state == DesiredState::Stopped
                        && current.prior_handle.incarnation_id() == incarnation_id
                })
            {
                // The captured Stop owns this exact enclosure. An interrupted
                // auxiliary completion must not reenter its slow input cleanup
                // while still holding the lifecycle lock needed by Stop.
                crate::service::append_event(
                    &self.config.lifecycle_log,
                    "supervisor.recovery.cleanup_deferred_to_stop",
                    serde_json::json!({"severity":"info", "soulId":handle.soul_id(),
                        "incarnationId":handle.incarnation_id()}),
                );
                return;
            }
            if self.terminate_owned_for_recovery(&handle).await == Ok(StopOutcome::VerifiedEmpty) {
                let _ = self.discard_failed_replacement_inputs(&handle).await;
            }
        }
    }

    async fn discard_failed_replacement_inputs(
        &self,
        handle: &OwnedRuntimeHandle,
    ) -> Result<(), RuntimeError> {
        Box::pin(self.await_running_startup(
            handle.soul_id(),
            "failed_provider_inputs_cleanup",
            self.backend.discard_stopped_provider_inputs(handle),
        ))
        .await?
        .map_err(|error| {
            crate::service::append_event(
                &self.config.lifecycle_log,
                "supervisor.recovery.failed_inputs_cleanup_deferred",
                serde_json::json!({"severity":"warn", "soulId":handle.soul_id(),
                "incarnationId":handle.incarnation_id(), "backendErrorKind":match &error {
                    BackendError::OwnershipMismatch(_) => "ownership_mismatch", _ => "unavailable",
                }}),
            );
            map_backend(error)
        })
    }

    async fn view_for(
        &self,
        incarnation_id: &freshell_runtime_protocol::IncarnationId,
    ) -> Result<RuntimeView, RuntimeError> {
        self.registry
            .inventory()
            .await
            .map_err(map_registry)?
            .into_iter()
            .find(|view| &view.incarnation_id == incarnation_id)
            .ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::UnknownIncarnation,
                    incarnation_id.to_string(),
                )
            })
    }

    async fn view_for_or_prior(
        &self,
        incarnation_id: &freshell_runtime_protocol::IncarnationId,
        prior_incarnation_id: &freshell_runtime_protocol::IncarnationId,
    ) -> Result<RuntimeView, RuntimeError> {
        let inventory = self.registry.inventory().await.map_err(map_registry)?;
        if let Some(view) = inventory
            .iter()
            .find(|view| &view.incarnation_id == incarnation_id)
        {
            return Ok(view.clone());
        }
        inventory
            .into_iter()
            .find(|view| &view.incarnation_id == prior_incarnation_id)
            .ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::UnknownIncarnation,
                    incarnation_id.to_string(),
                )
            })
    }
}

fn fresh_agent_replay_settings(
    agent: &freshell_runtime_protocol::FreshAgentLaunchSpec,
) -> freshell_runtime_protocol::FreshAgentTurnSettings {
    freshell_runtime_protocol::FreshAgentTurnSettings {
        cwd: Some(agent.cwd.clone()),
        model: agent.model.clone(),
        effort: agent.effort.clone(),
        permission_mode: agent.permission_mode.clone(),
        sandbox: agent.sandbox.clone(),
    }
}

pub(crate) fn after_native_probe(context: &RecoveryContext, probe: RecoveryProbe) -> RecoveryProbe {
    if matches!(probe, RecoveryProbe::PristineSeedReady { .. }) && !context.permits_pristine_seed()
    {
        return blocked(
            RecoveryPath::PristineSeed,
            RecoveryBlockReason::StoreUnreadable,
            "native identity or import prevents pristine seed",
            None,
        );
    }
    if !matches!(probe, RecoveryProbe::DefinitivelyUnavailable { .. }) {
        return probe;
    }
    if pristine_seed_is_safe(
        context.never_dispatched,
        context.native_session_id.as_deref(),
        context.native_import_state,
        context.native_import_absence_is_authoritative(),
    ) {
        return RecoveryProbe::PristineSeedReady {
            seed: context.creation_seed_ref.clone(),
            never_dispatched_proof: format!(
                "{}:supervisor-and-host-command-journals-empty",
                context.soul_id
            ),
        };
    }
    // Shell has no native store or checkpoint path. Its terminal-end probe
    // is qualified again by the complete reattach/seed inventory before loss.
    if context.provider == "shell" {
        return probe;
    }
    let row = match checkpoints::inspected_negative(&probe, RecoveryPath::NativeResume) {
        Ok(row) => row,
        Err(blocked) => return blocked,
    };
    if !crate::loss_report::native_absence_matches(context, row.store_state, &row.evidence_refs) {
        return freshell_agent_runtime::unverified_native_probe();
    }
    match checkpoints::probe_after_provider(context, &probe) {
        RecoveryProbe::DefinitivelyUnavailable { .. } => probe,
        other => other,
    }
}

fn live_reattach_probe(
    context: &RecoveryContext,
    status: &crate::service::HostStatus,
) -> RecoveryProbe {
    if status.worker_pid.is_none() {
        return blocked(
            RecoveryPath::Reattach,
            RecoveryBlockReason::ProviderUnavailable,
            "host has no confirmed provider worker; process termination remains unknown",
            Some(2_000),
        );
    }
    RecoveryProbe::ReattachReady {
        handle: ReattachHandle {
            incarnation_id: context.prior_handle.incarnation_id().clone(),
            host_boot_id: status.host_boot_id.clone(),
            container_id: context.prior_handle.container_id().to_string(),
        },
        protocol_version: CONTROL_PROTOCOL_VERSION,
    }
}

/// Called only after authenticated worker exit or an owned ended backend
/// inspection. Final loss certification independently rechecks that proof.
fn shell_terminal_end_probe(context: &RecoveryContext) -> RecoveryProbe {
    if pristine_seed_is_safe(
        context.never_dispatched,
        context.native_session_id.as_deref(),
        context.native_import_state,
        context.native_import_absence_is_authoritative(),
    ) {
        return RecoveryProbe::PristineSeedReady {
            seed: context.creation_seed_ref.clone(),
            never_dispatched_proof: format!(
                "{}:supervisor-input-journal-undispatched",
                context.soul_id
            ),
        };
    }
    RecoveryProbe::DefinitivelyUnavailable {
        path: RecoveryPath::Reattach,
        reason: "non-resumable shell ended after input dispatch".into(),
        evidence: vec![format!(
            "incarnationId={}",
            context.prior_handle.incarnation_id()
        )],
        store_state: EvidenceStoreState::NotApplicable,
        negative_paths: Vec::new(),
    }
}

pub(crate) fn offline_probe(context: &RecoveryContext) -> Result<RecoveryProbe, RuntimeError> {
    if context.provider == "shell" {
        return Ok(shell_terminal_end_probe(context));
    }
    let completed_opencode_import = context.provider == "opencode"
        && context.native_import_state == NativeImportState::Completed
        && context.native_import_authority == "verified_import_receipt";
    if (context.recovery_state == freshell_runtime_protocol::RecoveryState::DataRepairComplete
        || context.opencode_adoption_baseline.is_some()
        || completed_opencode_import)
        && context.desired_state == DesiredState::Running
        && context.provider == "opencode"
        && context.native_import_state == NativeImportState::Completed
        && context.native_import_authority == "verified_import_receipt"
        && context.native_import_source_store_id.is_some()
        && context.native_import_root_session_id.as_deref() == context.native_session_id.as_deref()
        && context.native_import_source_generation.is_some()
    {
        return match resume_catalog::exact_resume_candidate(context, None) {
            Ok(Some(spec)) => Ok(RecoveryProbe::ResumeReady {
                evidence_revision: spec.evidence_revision,
                resume_spec: Box::new(spec),
            }),
            Ok(None) => Ok(blocked(
                RecoveryPath::NativeResume,
                RecoveryBlockReason::StoreUnreadable,
                "the repaired provider store has no exact resumable launch specification",
                None,
            )),
            Err(probe) => Ok(probe),
        };
    }
    if context.resume_spec.is_some() {
        return Ok(
            match resume_catalog::exact_resume_candidate(context, None) {
                Ok(Some(spec)) => RecoveryProbe::ResumeReady {
                    evidence_revision: spec.evidence_revision,
                    resume_spec: Box::new(spec),
                },
                Ok(None) => freshell_agent_runtime::unverified_native_probe(),
                Err(probe) => probe,
            },
        );
    }
    if context.native_session_id.is_some() {
        return Ok(blocked(
            RecoveryPath::NativeResume,
            RecoveryBlockReason::StoreUnreadable,
            "a native identity was allocated, but no verified durable resume evidence was captured",
            None,
        ));
    }
    if pristine_seed_is_safe(
        context.never_dispatched,
        context.native_session_id.as_deref(),
        context.native_import_state,
        context.native_import_absence_is_authoritative(),
    ) {
        return Ok(RecoveryProbe::PristineSeedReady {
            seed: context.creation_seed_ref.clone(),
            never_dispatched_proof: format!(
                "{}:supervisor-input-journal-and-initialization-undispatched",
                context.soul_id
            ),
        });
    }
    Ok(freshell_agent_runtime::unverified_native_probe())
}

fn pristine_seed_is_safe(
    never_dispatched: bool,
    native_session_id: Option<&str>,
    native_import_state: NativeImportState,
    complete_inventory: bool,
) -> bool {
    never_dispatched
        && native_session_id.is_none()
        && native_import_state.permits_pristine_seed(complete_inventory)
}

fn downtime_bucket(elapsed_ms: u64) -> &'static str {
    match elapsed_ms {
        0..=999 => "lt_1s",
        1_000..=4_999 => "lt_5s",
        5_000..=29_999 => "lt_30s",
        30_000..=299_999 => "lt_5m",
        _ => "ge_5m",
    }
}

fn blocked(
    path: RecoveryPath,
    reason: RecoveryBlockReason,
    message: &str,
    retry_after_ms: Option<u64>,
) -> RecoveryProbe {
    RecoveryProbe::Blocked {
        path,
        reason,
        retry_hint: RetryHint {
            automatic_after_ms: retry_after_ms,
            manual_retry: true,
            repair: Some(message.to_string()),
        },
        evidence: vec![message.to_string()],
    }
}

fn preflight_diagnostic_repair(repair: Option<&str>) -> Option<&'static str> {
    let repair = repair?;
    // A native transport error may carry arbitrary upstream data. Log only
    // recognized static causes; the authenticated response retains its hint.
    const SAFE_HINTS: &[&str] = &[
        "provider identity or exact storage census has not been verified",
        "runtime gained extra, duplicate, or missing mounts",
        "runtime mount topology changed",
        "owned_launch_policy_mismatch",
        "repair the soul-local OpenCode database",
    ];
    if let Some(hint) = SAFE_HINTS.iter().find(|hint| **hint == repair) {
        return Some(hint);
    }
    const SOURCE_CODES: &[&str] = &[
        "source_io_unavailable",
        "sqlite_source_unavailable",
        "native_row_unreadable",
        "unsupported_schema_or_migration",
        "workspace_or_asset_unavailable",
        "exact_graph_unavailable",
        "source_qualification_pending",
    ];
    SOURCE_CODES
        .iter()
        .find(|code| repair.contains(&format!("retained OpenCode qualification blocked ({code})")))
        .copied()
}

fn recovery_activation_failure_data(
    soul_id: &SoulId,
    prior_incarnation_id: &freshell_runtime_protocol::IncarnationId,
    replacement_incarnation_id: &freshell_runtime_protocol::IncarnationId,
    attempt_id: &RecoveryAttemptId,
    path: RecoveryPath,
    reason: RecoveryBlockReason,
    error: &RuntimeError,
) -> serde_json::Value {
    serde_json::json!({
        "soulId": soul_id,
        "priorIncarnationId": prior_incarnation_id,
        "replacementIncarnationId": replacement_incarnation_id,
        "attemptId": attempt_id,
        "path": path,
        "blockReason": reason,
        "errorCode": error.code,
        "errorClass": "provider_activation_failed",
        "severity": "warn",
    })
}

fn normalized_negative_evidence(
    path: RecoveryPath,
    store_state: EvidenceStoreState,
    transient_evidence: &[String],
) -> (String, Vec<String>) {
    let store = match store_state {
        EvidenceStoreState::Missing => "missing",
        EvidenceStoreState::PresentReadable => "present_readable",
        EvidenceStoreState::PresentUnreadable => "present_unreadable",
        EvidenceStoreState::Unknown => "unknown",
        EvidenceStoreState::NotApplicable => "not_applicable",
    };
    (
        format!("{}_definitive_negative_{store}", path_name(path)),
        vec![
            format!("recoveryPath={}", path_name(path)),
            format!("storeState={store}"),
            format!(
                "transientEvidenceDigest={}",
                digest_forensic_strings(transient_evidence)
            ),
        ],
    )
}

fn final_probe_still_allows_loss(probe: &RecoveryProbe) -> bool {
    matches!(probe, RecoveryProbe::DefinitivelyUnavailable { .. })
}

fn digest_forensic_strings(values: &[String]) -> String {
    let encoded = serde_json::to_vec(values).expect("forensic strings are serializable");
    format!("sha256:{:x}", Sha256::digest(encoded))
}

fn terminal_without_first_boot_state(
    terminal: Option<TerminalLaunchSpec>,
) -> Option<TerminalLaunchSpec> {
    terminal.map(|mut terminal| {
        // Exact recovery consumes the credential/config copies already named
        // by ResumeSpec::credential_references in the verified provider
        // volume. Source bind mounts and the OpenCode transfer descriptor are
        // first-launch inputs, not recovery dependencies: transfer staging is
        // released after import and may no longer exist when a host fails.
        // The saved OpenCode adoption baseline remains in ResumeSpec and is
        // revalidated against the installed store for each replacement.
        terminal.provider_bootstrap_files.clear();
        terminal.opencode_transfer = None;
        terminal.opencode_transfer_attempt_id = None;
        terminal.opencode_adoption = None;
        terminal
    })
}

fn install_prepared_provider_context(
    terminal: Option<&mut TerminalLaunchSpec>,
    fresh: Option<&mut freshell_runtime_protocol::FreshAgentLaunchSpec>,
    prepared: freshell_runtime_protocol::PreparedProviderContext,
) -> Result<(), RuntimeError> {
    match (terminal, fresh) {
        (Some(terminal), None) => {
            prepared.validate(&terminal.mode)?;
            terminal.provider_launch_context = Some(prepared.provider_launch_context);
            terminal.provider_secret_references = prepared.provider_secret_references;
        }
        (None, Some(agent)) => {
            prepared.validate(agent.provider.native_provider())?;
            agent.provider_launch_context = Some(prepared.provider_launch_context);
            agent.provider_secret_references = prepared.provider_secret_references;
        }
        _ => {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                "complete provider replacement requires exactly one workload",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
fn refresh_provider_context_from_user_root(
    context: &mut freshell_runtime_protocol::ProviderLaunchContext,
    provider: &str,
    workspace: &std::path::Path,
    project_dir: &std::path::Path,
    user_root: &std::path::Path,
) {
    use freshell_runtime_protocol::{
        ProviderConfigReference, ProviderConfigRoot, ProviderPreparation,
    };
    let (provider_dir, directories): (&str, &[&str]) = match provider {
        "claude" => (
            ".claude",
            &["plugins", "skills", "commands", "hooks", "agents"],
        ),
        "codex" => (".codex", &["skills", "rules"]),
        "opencode" => (
            ".config/opencode",
            &["plugin", "plugins", "agents", "commands", "skills"],
        ),
        "amplifier" => (".amplifier", &["bundles", "skills", "agents"]),
        _ => return,
    };
    let mut config = Vec::new();
    if let Ok(canonical_root) = std::fs::canonicalize(user_root) {
        if let Ok(entries) = std::fs::read_dir(&canonical_root) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let Some(name) = name.to_str() else { continue };
                let Some(source) = safe_provider_config_source(&canonical_root, &entry.path())
                else {
                    continue;
                };
                let format = if source.is_dir() {
                    if !directories.contains(&name) {
                        continue;
                    }
                    "directory"
                } else if source.is_file() {
                    match source.extension().and_then(|ext| ext.to_str()) {
                        Some("json") => "json",
                        Some("jsonc") => "jsonc",
                        Some("toml") => "toml",
                        Some("yaml" | "yml") => "yaml",
                        Some("md") => "text",
                        _ => continue,
                    }
                } else {
                    continue;
                };
                if matches!(
                    name.to_ascii_lowercase().as_str(),
                    "auth.json" | ".credentials.json" | "keys.env" | ".env" | "token.json"
                ) {
                    continue;
                }
                config.push(ProviderConfigReference {
                    root: ProviderConfigRoot::UserProvider,
                    relative_path: name.to_string(),
                    provider_relative_path: format!("{provider_dir}/{name}"),
                    format: format.into(),
                });
            }
        }
    }
    config.sort_by(|left, right| {
        left.provider_relative_path
            .cmp(&right.provider_relative_path)
    });
    context.config = config;

    if let ProviderPreparation::Opencode { project_config, .. } = &mut context.preparation {
        project_config.clear();
        let Ok(canonical_workspace) = std::fs::canonicalize(workspace) else {
            return;
        };
        let Ok(project_relative) = project_dir.strip_prefix(workspace) else {
            return;
        };
        for name in [
            "opencode.json",
            "opencode.jsonc",
            ".opencode/opencode.json",
            ".opencode/opencode.jsonc",
        ] {
            let relative_path = project_relative.join(name);
            let Some(relative_path) = relative_path
                .to_str()
                .map(|path| path.replace(std::path::MAIN_SEPARATOR, "/"))
            else {
                continue;
            };
            let candidate = workspace.join(&relative_path);
            if safe_provider_config_source(&canonical_workspace, &candidate)
                .is_some_and(|path| path.is_file())
            {
                project_config.push(ProviderConfigReference {
                    root: ProviderConfigRoot::Workspace,
                    relative_path: relative_path.clone(),
                    provider_relative_path: format!(".config/opencode/project/{relative_path}"),
                    format: if name.ends_with(".jsonc") {
                        "jsonc"
                    } else {
                        "json"
                    }
                    .into(),
                });
            }
        }
    }
}

#[cfg(test)]
fn safe_provider_config_source(
    root: &std::path::Path,
    candidate: &std::path::Path,
) -> Option<std::path::PathBuf> {
    let canonical = std::fs::canonicalize(candidate).ok()?;
    canonical.starts_with(root).then_some(canonical)
}

fn fresh_without_raw_bootstrap(
    agent: Option<freshell_runtime_protocol::FreshAgentLaunchSpec>,
) -> Option<freshell_runtime_protocol::FreshAgentLaunchSpec> {
    agent.map(|mut agent| {
        if agent.provider != freshell_runtime_protocol::FreshProvider::Kilroy {
            agent.provider_bootstrap_files.clear();
        }
        agent
    })
}

fn map_registry(error: RegistryError) -> RuntimeError {
    let code = match &error {
        RegistryError::Busy => RuntimeErrorCode::RegistryBusy,
        RegistryError::RequestConflict | RegistryError::InputConflict => {
            RuntimeErrorCode::RequestIdConflict
        }
        RegistryError::StaleControlEpoch { .. } => RuntimeErrorCode::StaleControlEpoch,
        RegistryError::StaleIntentRevision { .. } => RuntimeErrorCode::StaleIntentRevision,
        RegistryError::LossCertificationBlocked(_) => RuntimeErrorCode::LossCertificationBlocked,
        RegistryError::IncidentPersistenceFailed(_) | RegistryError::IncidentNotFound(_) => {
            RuntimeErrorCode::IncidentPersistenceFailed
        }
        RegistryError::NoticeNotFound(_) => RuntimeErrorCode::NoticeNotFound,
        RegistryError::MigrationBlocked(_) => RuntimeErrorCode::MigrationBlocked,
        RegistryError::RepairBlocked(_) => RuntimeErrorCode::RepairBlocked,
        RegistryError::UnknownSoul(_) => RuntimeErrorCode::UnknownSoul,
        RegistryError::UnknownIncarnation(_) => RuntimeErrorCode::UnknownIncarnation,
        RegistryError::BlockedResource { .. } => RuntimeErrorCode::BlockedResource,
        RegistryError::RecoveryInProgress(_) => RuntimeErrorCode::RecoveryInProgress,
        RegistryError::RecoveryBlocked { reason, .. } if reason.contains("RETRY_BUDGET") => {
            RuntimeErrorCode::RecoveryRetryBudget
        }
        RegistryError::RecoveryBlocked { .. } => RuntimeErrorCode::RecoveryBlocked,
        RegistryError::NativeIdentityConflict => RuntimeErrorCode::RecoveryWrongIdentity,
        RegistryError::FaultInjected(_) => RuntimeErrorCode::FaultInjected,
        _ => RuntimeErrorCode::RegistryFailure,
    };
    RuntimeError::new(code, error.to_string())
}

#[cfg(test)]
pub(crate) mod tests {
    include!("shell_recovery_tests.rs");
    include!("retained_output_tests.rs");
    use super::*;
    use freshell_agent_runtime::host_actor::{
        ActorError, DispatchAck, DispatchFailure, FreshAgentHostActor, FreshAgentProfile,
        FreshAgentTransport, TransportStart,
    };
    use freshell_runtime_protocol::{
        FreshAgentLaunchSpec, FreshProvider, IncarnationId, RequestId,
    };

    pub(crate) fn stopped_source_options_for_targets(
        extraction_root: PathBuf,
        lifecycle_log: PathBuf,
        targets: &[(
            String,
            freshell_runtime_protocol::LostSoulRepairTarget,
            RecoveryContext,
        )],
    ) -> ExportOptions {
        stopped_source_export_options(
            extraction_root,
            lifecycle_log,
            "capture",
            targets
                .iter()
                .map(|(root, target, context)| {
                    source_transfer_target_context(root, target, context)
                })
                .collect(),
        )
    }

    fn stopped_payload_fixture(
        directory: &Path,
    ) -> (OpenCodeNativeSnapshot, OpenCodeTransferDescriptor) {
        use freshell_sessions::opencode_transfer::{
            pinned_destination_migration_ids, pinned_destination_schema_sql,
        };
        let workspace = directory.join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let database = directory.join("source.sqlite");
        let source = rusqlite::Connection::open(&database).unwrap();
        source
            .execute_batch(pinned_destination_schema_sql())
            .unwrap();
        for migration in pinned_destination_migration_ids() {
            source
                .execute(
                    "INSERT INTO migration(id,time_completed) VALUES (?1,1)",
                    [migration],
                )
                .unwrap();
        }
        source.execute("INSERT INTO project(id,worktree,time_created,time_updated,sandboxes) VALUES ('fixture-project',?1,1,1,'[]')", [workspace.to_string_lossy().as_ref()]).unwrap();
        source.execute("INSERT INTO project_directory(project_id,directory,time_created) VALUES ('fixture-project',?1,1)", [workspace.to_string_lossy().as_ref()]).unwrap();
        source.execute("INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES ('ses_staging_restart','fixture-project','fixture',?1,?2,'1.18.21',1,1)", rusqlite::params![workspace.to_string_lossy().as_ref(), "synthetic".repeat(MAX_OPENCODE_TRANSFER_CHUNK_BYTES / 4)]).unwrap();
        drop(source);
        let snapshot = export_exact_session(
            &HostOpenCodeInventory::new(database)
                .with_trusted_mount_for_selected_session(workspace),
            "ses_staging_restart",
            ExportOptions::new(directory.join("extractions")),
        )
        .unwrap();
        let manifest = snapshot.manifest();
        assert!(manifest.payload_bytes > MAX_OPENCODE_TRANSFER_CHUNK_BYTES as u64);
        let image = format!("sha256:{}", "e".repeat(64));
        let manifest_json = serde_json::to_string(manifest).unwrap();
        let files = vec![OpenCodeTransferFile {
            index: 0,
            relative_path: "payload.json".into(),
            size_bytes: manifest.payload_bytes,
            sha256: manifest.payload_sha256.clone(),
        }];
        let descriptor = OpenCodeTransferDescriptor {
            transfer_id: "stopped-staging-restart".into(),
            provider: "opencode".into(),
            source_store_id: manifest.source_store_id.clone(),
            root_session_id: manifest.root_session_id.clone(),
            source_generation: manifest.generation.clone(),
            provider_schema: manifest.provider_schema.clone(),
            source_schema_fingerprint: manifest.source_schema_fingerprint.clone(),
            migration_journal_fingerprint: manifest.migration_journal_fingerprint.clone(),
            destination_store_id: "fixture-destination".into(),
            destination_database_path: OPENCODE_TRANSFER_DESTINATION_DB.into(),
            target_build_receipt: opencode_target_build_receipt(&image, &manifest.provider_schema),
            target_image_ref: image,
            incarnation_id: IncarnationId::new().to_string(),
            bundle_sha256: opencode_transfer_bundle_digest(&manifest_json, &files),
            manifest_json,
            total_bytes: manifest.payload_bytes,
            files,
        };
        descriptor.validate().unwrap();
        (snapshot, descriptor)
    }

    #[test]
    fn stopped_payload_completed_stage_reopens_and_finalizes() {
        use crate::opencode_transfer::{OpenCodeTransferStaging, StagingLimits, StagingStart};
        let directory = tempfile::Builder::new()
            .prefix("task007-staging-restart-")
            .tempdir()
            .unwrap();
        let (snapshot, descriptor) = stopped_payload_fixture(directory.path());
        let staging_root = directory.path().join("staging");
        let staging =
            OpenCodeTransferStaging::new(&staging_root, StagingLimits::production()).unwrap();
        let initial = uuid::Uuid::new_v4().simple().to_string();
        let reopened = uuid::Uuid::new_v4().simple().to_string();
        let progress = staging
            .begin_from_filesystem(&descriptor, &initial)
            .unwrap();
        stage_snapshot_payload(&snapshot, &descriptor, &initial, &staging, &progress).unwrap();
        let ready = staging.finalize(&descriptor.transfer_id, &initial).unwrap();
        drop(staging);
        let staging =
            OpenCodeTransferStaging::new(&staging_root, StagingLimits::production()).unwrap();
        let progress = staging
            .begin_from_filesystem(&descriptor, &reopened)
            .unwrap();
        assert!(
            matches!(progress, StagingStart::Started { next_sequence, ref file_offsets }
            if next_sequence > 1 && file_offsets[0].next_offset == descriptor.total_bytes)
        );
        stage_snapshot_payload(&snapshot, &descriptor, &reopened, &staging, &progress).unwrap();
        assert_eq!(
            staging
                .finalize(&descriptor.transfer_id, &reopened)
                .unwrap(),
            ready
        );
        assert_eq!(staging.verify_ready(&descriptor).unwrap(), ready);
        assert_stopped_payload_bytes(&snapshot, &ready);
        staging.abort(&descriptor.transfer_id, &reopened).unwrap();
        drop(staging);
        drop(snapshot);
        directory.close().unwrap();
    }

    fn assert_stopped_payload_bytes(snapshot: &OpenCodeNativeSnapshot, ready: &Path) {
        let mut original = Vec::new();
        snapshot
            .open_payload()
            .unwrap()
            .read_to_end(&mut original)
            .unwrap();
        let staged = std::fs::read(ready.join("entry-0000.bin")).unwrap();
        assert!(
            staged == original,
            "staged bytes differ from the exported snapshot"
        );
        assert_eq!(
            format!("{:x}", Sha256::digest(&staged)),
            snapshot.manifest().payload_sha256
        );
    }

    #[test]
    fn stopped_payload_partial_stage_resumes_nonzero_progress() {
        use crate::opencode_transfer::{OpenCodeTransferStaging, StagingLimits, StagingStart};
        let directory = tempfile::Builder::new()
            .prefix("task007-staging-restart-")
            .tempdir()
            .unwrap();
        let (snapshot, descriptor) = stopped_payload_fixture(directory.path());
        let staging_root = directory.path().join("staging");
        let staging =
            OpenCodeTransferStaging::new(&staging_root, StagingLimits::production()).unwrap();
        let initial = uuid::Uuid::new_v4().simple().to_string();
        staging
            .begin_from_filesystem(&descriptor, &initial)
            .unwrap();
        write_stopped_payload_first_chunk(&snapshot, &descriptor, &initial, &staging);
        drop(staging);
        let staging =
            OpenCodeTransferStaging::new(&staging_root, StagingLimits::production()).unwrap();
        let reopened = uuid::Uuid::new_v4().simple().to_string();
        let progress = staging
            .begin_from_filesystem(&descriptor, &reopened)
            .unwrap();
        assert!(
            matches!(progress, StagingStart::Started { next_sequence: 1, ref file_offsets }
            if file_offsets[0].next_offset == MAX_OPENCODE_TRANSFER_CHUNK_BYTES as u64)
        );
        assert!(
            stage_snapshot_payload(&snapshot, &descriptor, &initial, &staging, &progress).is_err(),
            "the old attempt cannot append after ownership transfers"
        );
        stage_snapshot_payload(&snapshot, &descriptor, &reopened, &staging, &progress).unwrap();
        let ready = staging
            .finalize(&descriptor.transfer_id, &reopened)
            .unwrap();
        assert_eq!(staging.verify_ready(&descriptor).unwrap(), ready);
        assert_stopped_payload_bytes(&snapshot, &ready);
        staging.abort(&descriptor.transfer_id, &reopened).unwrap();
        drop(staging);
        drop(snapshot);
        directory.close().unwrap();
    }

    fn write_stopped_payload_first_chunk(
        snapshot: &OpenCodeNativeSnapshot,
        descriptor: &OpenCodeTransferDescriptor,
        attempt: &str,
        staging: &crate::opencode_transfer::OpenCodeTransferStaging,
    ) {
        let mut data = vec![0; MAX_OPENCODE_TRANSFER_CHUNK_BYTES];
        snapshot
            .open_payload()
            .unwrap()
            .read_exact(&mut data)
            .unwrap();
        staging
            .write_chunk(&OpenCodeTransferChunk {
                transfer_id: descriptor.transfer_id.clone(),
                attempt_id: attempt.into(),
                sequence: 0,
                file_index: 0,
                offset: 0,
                sha256: format!("{:x}", Sha256::digest(&data)),
                data,
            })
            .unwrap();
    }

    #[test]
    fn stopped_payload_resumed_stage_refuses_changed_source_prefix() {
        use crate::opencode_transfer::{OpenCodeTransferStaging, StagingLimits};
        use std::{io::Write, os::fd::AsRawFd};
        let directory = tempfile::Builder::new()
            .prefix("task007-staging-restart-")
            .tempdir()
            .unwrap();
        let (snapshot, descriptor) = stopped_payload_fixture(directory.path());
        let staging_root = directory.path().join("staging");
        let staging =
            OpenCodeTransferStaging::new(&staging_root, StagingLimits::production()).unwrap();
        let initial = uuid::Uuid::new_v4().simple().to_string();
        staging
            .begin_from_filesystem(&descriptor, &initial)
            .unwrap();
        write_stopped_payload_first_chunk(&snapshot, &descriptor, &initial, &staging);
        drop(staging);
        let staging =
            OpenCodeTransferStaging::new(&staging_root, StagingLimits::production()).unwrap();
        let reopened = uuid::Uuid::new_v4().simple().to_string();
        let progress = staging
            .begin_from_filesystem(&descriptor, &reopened)
            .unwrap();
        // Corrupt only this test-owned exported snapshot, after the original
        // prefix is durably staged. Skipping writes must not trust changed data.
        let payload = snapshot.open_payload().unwrap();
        let mut writer = std::fs::OpenOptions::new()
            .write(true)
            .open(format!("/proc/self/fd/{}", payload.as_raw_fd()))
            .unwrap();
        writer.write_all(b"!").unwrap();
        writer.sync_all().unwrap();
        assert!(
            stage_snapshot_payload(&snapshot, &descriptor, &reopened, &staging, &progress).is_err()
        );
        drop(writer);
        drop(payload);
        staging.abort(&descriptor.transfer_id, &reopened).unwrap();
        drop(staging);
        drop(snapshot);
        directory.close().unwrap();
    }

    #[tokio::test]
    async fn stopped_payload_queued_stage_uses_wait_progress() {
        use crate::opencode_transfer::{OpenCodeTransferStaging, StagingLimits, StagingStart};
        let directory = tempfile::Builder::new()
            .prefix("task007-staging-restart-")
            .tempdir()
            .unwrap();
        let (snapshot, descriptor) = stopped_payload_fixture(directory.path());
        let staging = OpenCodeTransferStaging::new(
            directory.path().join("staging"),
            StagingLimits::for_test(descriptor.total_bytes, descriptor.total_bytes),
        )
        .unwrap();
        let initial = uuid::Uuid::new_v4().simple().to_string();
        staging
            .begin_from_filesystem(&descriptor, &initial)
            .unwrap();
        let mut queued_descriptor = descriptor.clone();
        queued_descriptor.transfer_id = "stopped-staging-queued".into();
        let queued_attempt = uuid::Uuid::new_v4().simple().to_string();
        assert_eq!(
            staging
                .begin_from_filesystem(&queued_descriptor, &queued_attempt)
                .unwrap(),
            StagingStart::Queued
        );
        staging.abort(&descriptor.transfer_id, &initial).unwrap();
        let progress = tokio::time::timeout(
            Duration::from_secs(2),
            staging.wait_for_capacity(&queued_descriptor.transfer_id, &queued_attempt),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(
            matches!(progress, StagingStart::Started { next_sequence: 0, ref file_offsets }
            if file_offsets[0].next_offset == 0)
        );
        stage_snapshot_payload(
            &snapshot,
            &queued_descriptor,
            &queued_attempt,
            &staging,
            &progress,
        )
        .unwrap();
        let ready = staging
            .finalize(&queued_descriptor.transfer_id, &queued_attempt)
            .unwrap();
        assert_eq!(staging.verify_ready(&queued_descriptor).unwrap(), ready);
        assert_stopped_payload_bytes(&snapshot, &ready);
        staging
            .abort(&queued_descriptor.transfer_id, &queued_attempt)
            .unwrap();
        drop(staging);
        drop(snapshot);
        directory.close().unwrap();
    }

    #[test]
    fn stopped_payload_fresh_stage_rejects_malformed_progress() {
        use crate::opencode_transfer::{OpenCodeTransferStaging, StagingLimits, StagingStart};
        let directory = tempfile::Builder::new()
            .prefix("task007-staging-restart-")
            .tempdir()
            .unwrap();
        let (snapshot, descriptor) = stopped_payload_fixture(directory.path());
        let staging = OpenCodeTransferStaging::new(
            directory.path().join("staging"),
            StagingLimits::production(),
        )
        .unwrap();
        let attempt = uuid::Uuid::new_v4().simple().to_string();
        let progress = staging
            .begin_from_filesystem(&descriptor, &attempt)
            .unwrap();
        for malformed in ["sequence", "offset", "index", "missing", "extra"] {
            let mut bad_progress = progress.clone();
            let StagingStart::Started {
                next_sequence,
                file_offsets,
            } = &mut bad_progress
            else {
                panic!("fresh stage queued");
            };
            match malformed {
                "sequence" => *next_sequence = 1,
                "offset" => file_offsets[0].next_offset = 1,
                "index" => file_offsets[0].file_index = 1,
                "missing" => file_offsets.clear(),
                "extra" => file_offsets.push(file_offsets[0].clone()),
                _ => unreachable!(),
            }
            assert!(
                stage_snapshot_payload(&snapshot, &descriptor, &attempt, &staging, &bad_progress)
                    .is_err(),
                "{malformed}"
            );
        }
        stage_snapshot_payload(&snapshot, &descriptor, &attempt, &staging, &progress).unwrap();
        let ready = staging.finalize(&descriptor.transfer_id, &attempt).unwrap();
        assert_eq!(staging.verify_ready(&descriptor).unwrap(), ready);
        assert_stopped_payload_bytes(&snapshot, &ready);
        staging.abort(&descriptor.transfer_id, &attempt).unwrap();
        drop(staging);
        drop(snapshot);
        directory.close().unwrap();
    }

    #[tokio::test]
    async fn stopped_repair_resume_observation_fault_requires_current_saved_baseline() {
        use freshell_runtime_protocol::{
            HostBootId, NativeIdentityLaunch, NativeIdentityObservation, NativeIdentitySource,
        };
        let dir = tempfile::tempdir().unwrap();
        let registry = crate::registry::Registry::open(dir.path().join("registry"), None).unwrap();
        let soul = SoulId::new();
        let prepared =
            crate::registry::tests::materialize_test_runtime(&registry, soul.clone()).await;
        let mut context = registry.recovery_context(soul).await.unwrap();
        context.provider = "opencode".into();
        context.native_session_id = Some("ses_repaired".into());
        context.native_import_state = NativeImportState::Completed;
        context.native_import_authority = "verified_import_receipt".into();
        context.native_identity_launch = Some(NativeIdentityLaunch {
            incarnation_id: prepared.incarnation_id.clone(),
            launch_nonce: prepared.launch_nonce.as_str().into(),
            evidence_revision: context.evidence_revision,
            execution_generation: 1,
            requested_native_session_id: context.native_session_id.clone(),
        });
        // A typed baseline for this domain test, not native continuity evidence.
        let payload = b"x";
        let payload_sha256 = format!("{:x}", Sha256::digest(payload));
        let manifest_json = serde_json::json!({"version":1,"provider_schema":"opencode-1.18.21",
            "root_session_id":"ses_repaired","source_store_id":"a".repeat(64),
            "source_schema_fingerprint":"b".repeat(64),"migration_journal_fingerprint":"c".repeat(64),
            "generation":"d".repeat(64),"assets":[],"rows":[],"row_count":0,
            "payload_bytes":payload.len(),"payload_sha256":payload_sha256}).to_string();
        let files = vec![OpenCodeTransferFile {
            index: 0,
            relative_path: "payload.json".into(),
            size_bytes: payload.len() as u64,
            sha256: payload_sha256,
        }];
        let image = format!("sha256:{}", "e".repeat(64));
        let descriptor = OpenCodeTransferDescriptor {
            transfer_id: "repaired-baseline".into(),
            provider: "opencode".into(),
            source_store_id: "a".repeat(64),
            root_session_id: "ses_repaired".into(),
            source_generation: "d".repeat(64),
            provider_schema: "opencode-1.18.21".into(),
            source_schema_fingerprint: "b".repeat(64),
            migration_journal_fingerprint: "c".repeat(64),
            destination_store_id: context.provider_store_id.clone(),
            destination_database_path: OPENCODE_TRANSFER_DESTINATION_DB.into(),
            target_image_ref: image.clone(),
            target_build_receipt: opencode_target_build_receipt(&image, "opencode-1.18.21"),
            incarnation_id: prepared.incarnation_id.to_string(),
            bundle_sha256: opencode_transfer_bundle_digest(&manifest_json, &files),
            manifest_json,
            files,
            total_bytes: payload.len() as u64,
        };
        context.opencode_adoption_baseline =
            Some(OpenCodeAdoptionBaseline::from_descriptor(descriptor).unwrap());
        let launch = context.native_identity_launch.as_ref().unwrap();
        let make_status = || crate::service::HostStatus {
            max_execution_generation: 1,
            native_identity_observation: Some(NativeIdentityObservation {
                native_session_id: "ses_repaired".into(),
                incarnation_id: launch.incarnation_id.clone(),
                launch_nonce: launch.launch_nonce.clone(),
                evidence_revision: launch.evidence_revision,
                source: NativeIdentitySource::OpencodeTui,
                evidence_digest: "f".repeat(64),
            }),
            host_boot_id: HostBootId::new(),
            worker_pid: Some(123),
            worker_launch_count: 1,
            fixture_evidence: serde_json::json!({}),
            exited: false,
            native_session_id: context.native_session_id.clone(),
            opencode_adoption: Default::default(),
            opencode_transfer_receipt: None,
        };
        let status = make_status();
        let baseline = context.opencode_adoption_baseline.clone();
        let failure = stopped_repair_resume_observation_fault(&context, &status, true, true, 17);
        assert!(matches!(
            failure,
            Some(NativeIdentityWait::HostUnavailable {
                transient: None,
                elapsed_ms: 17,
                ..
            })
        ));
        assert_eq!(context.opencode_adoption_baseline, baseline);
        assert!(
            stopped_repair_resume_observation_fault(&context, &status, true, false, 17).is_none()
        );
        assert!(
            stopped_repair_resume_observation_fault(&context, &status, false, true, 17).is_none()
        );
        for guard in [
            "exited",
            "missing",
            "root",
            "incarnation",
            "nonce",
            "evidence",
            "generation",
            "source",
        ] {
            let mut invalid = make_status();
            match guard {
                "exited" => invalid.exited = true,
                "missing" => invalid.native_identity_observation = None,
                "root" => {
                    invalid
                        .native_identity_observation
                        .as_mut()
                        .unwrap()
                        .native_session_id = "ses_other".into()
                }
                "incarnation" => {
                    invalid
                        .native_identity_observation
                        .as_mut()
                        .unwrap()
                        .incarnation_id = IncarnationId::new()
                }
                "nonce" => {
                    invalid
                        .native_identity_observation
                        .as_mut()
                        .unwrap()
                        .launch_nonce = "old".into()
                }
                "evidence" => {
                    invalid
                        .native_identity_observation
                        .as_mut()
                        .unwrap()
                        .evidence_revision += 1
                }
                "generation" => invalid.max_execution_generation += 1,
                "source" => {
                    invalid.native_identity_observation.as_mut().unwrap().source =
                        NativeIdentitySource::ClaudeNativeEvent
                }
                _ => unreachable!(),
            }
            assert!(
                stopped_repair_resume_observation_fault(&context, &invalid, true, true, 17)
                    .is_none(),
                "{guard}"
            );
        }
        let mut ordinary = context.clone();
        ordinary.opencode_adoption_baseline = None;
        assert!(
            stopped_repair_resume_observation_fault(&ordinary, &status, true, true, 17).is_none()
        );
        ordinary = context.clone();
        ordinary.provider = "claude".into();
        assert!(
            stopped_repair_resume_observation_fault(&ordinary, &status, true, true, 17).is_none()
        );
        ordinary = context.clone();
        ordinary.native_import_state = NativeImportState::Pending;
        assert!(
            stopped_repair_resume_observation_fault(&ordinary, &status, true, true, 17).is_none()
        );
        ordinary = context.clone();
        ordinary.native_import_authority = "legacy_unknown".into();
        assert!(
            stopped_repair_resume_observation_fault(&ordinary, &status, true, true, 17).is_none()
        );
    }

    #[tokio::test]
    async fn retained_fresh_fixture_reattaches_same_worker_after_supervisor_restart() {
        use freshell_runtime_protocol::{
            host_proof, read_frame, write_frame, Envelope, HostBootId, HostReply,
            NativeIdentityLaunch, RecoveryState,
        };
        for case in [
            "ordinary-provider",
            "wrong-mode",
            "wrong-provider",
            "missing-root",
            "wrong-root",
            "wrong-generation",
            "current-fixture",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let registry =
                crate::registry::Registry::open(dir.path().join("registry"), None).unwrap();
            let soul = SoulId::new();
            let prepared =
                crate::registry::tests::materialize_test_runtime(&registry, soul.clone()).await;
            let runtime = dir.path().join("owned-host");
            std::fs::create_dir(&runtime).unwrap();
            std::fs::write(runtime.join("secret"), b"synthetic-secret").unwrap();
            let native = "fixture-native-codex-current";
            let mut agent = serde_json::json!({
                "sessionId":"owned-fixture", "provider":"codex", "sessionType":"freshcodex",
                "runtimeVariant":"fixture-test", "providerStoreId":"owned-store",
                "cwd":dir.path(), "workspacePath":dir.path(), "runAsUid":65534,
                "runAsGid":0, "fixtureTransport":"deterministic", "nativeSessionId":native
            });
            match case {
                "ordinary-provider" => {
                    agent.as_object_mut().unwrap().remove("fixtureTransport");
                }
                "wrong-mode" => agent["sessionType"] = "freshopencode".into(),
                "wrong-provider" => agent["provider"] = "opencode".into(),
                _ => {}
            }
            let conn = rusqlite::Connection::open(registry.database_path()).unwrap();
            conn.execute(
                "UPDATE souls SET provider='codex',resume_spec=NULL WHERE soul_id=?1",
                [soul.as_str()],
            )
            .unwrap();
            conn.execute("UPDATE incarnations SET runtime_dir=?1,execution_generation=1,fixture_kind=NULL,fresh_agent_spec=?2 WHERE incarnation_id=?3",
                rusqlite::params![runtime.to_string_lossy(),agent.to_string(),prepared.incarnation_id.as_str()]).unwrap();
            drop(conn);
            registry
                .record_native_session(soul.clone(), prepared.incarnation_id.clone(), native.into())
                .await
                .unwrap();
            let before = registry.recovery_context(soul.clone()).await.unwrap();
            registry
                .bind_native_identity_launch(NativeIdentityLaunch {
                    incarnation_id: prepared.incarnation_id.clone(),
                    launch_nonce: before.prior_handle.launch_nonce().as_str().into(),
                    evidence_revision: before.evidence_revision,
                    execution_generation: 1,
                    requested_native_session_id: Some(native.into()),
                })
                .await
                .unwrap();
            let old_epoch = registry.control_epoch();
            let limits = before.requested_limits;
            let hosted_incarnation = prepared.incarnation_id.clone();
            let listener = tokio::net::UnixListener::bind(runtime.join("host.sock")).unwrap();
            let (close_host, mut host_closed) = tokio::sync::oneshot::channel::<()>();
            let responder = tokio::spawn(async move {
                let boot = HostBootId::new();
                loop {
                    let (mut socket, _) = tokio::select! {
                        _ = &mut host_closed => break,
                        accepted = listener.accept() => accepted.unwrap(),
                    };
                    let request: Envelope<HostCommand> = read_frame(&mut socket).await.unwrap();
                    if !matches!(&request.body, HostCommand::Hello { .. }) {
                        assert_eq!(
                            request.auth,
                            Some(host_proof(
                                b"synthetic-secret",
                                "command-auth",
                                &boot,
                                &hosted_incarnation
                            ))
                        );
                    }
                    let result = match request.body {
                        HostCommand::Hello {
                            incarnation_id,
                            challenge,
                        } => HostResult::Hello {
                            proof: host_proof(
                                b"synthetic-secret",
                                &challenge,
                                &boot,
                                &incarnation_id,
                            ),
                            host_boot_id: boot.clone(),
                            capabilities: vec![
                                "native-identity-observation-v1".into(),
                                "owned-provider-config-v1".into(),
                                "provider-store-probe-v1".into(),
                            ],
                            effective_limits: limits,
                        },
                        HostCommand::Status { .. } => HostResult::Status {
                            host_boot_id: boot.clone(),
                            worker_pid: Some(123),
                            worker_launch_count: 1,
                            max_control_epoch: old_epoch,
                            max_execution_generation: if case == "wrong-generation" {
                                2
                            } else {
                                1
                            },
                            fixture_evidence: serde_json::json!({"workload":"fresh-agent"}),
                            exited: false,
                            native_session_id: match case {
                                "missing-root" => None,
                                "wrong-root" => Some("fixture-native-other".into()),
                                _ => Some(native.into()),
                            },
                            // Deterministic transport identity is never native proof.
                            native_identity_observation: None,
                            opencode_transfer_receipt: None,
                            opencode_adoption: Default::default(),
                        },
                        other => {
                            panic!("reattach must not dispatch or replace the worker: {other:?}")
                        }
                    };
                    write_frame(
                        &mut socket,
                        &HostReply {
                            request_id: request.request_id,
                            result: Ok(result),
                        },
                    )
                    .await
                    .unwrap();
                }
            });
            // Reopen only the controller registry. The authenticated host and
            // its one existing worker survive with their original identity.
            drop(registry);
            let registry =
                crate::registry::Registry::open(dir.path().join("registry"), None).unwrap();
            assert!(registry.control_epoch() > old_epoch);
            let supervisor =
                supervisor_with_runtime_state(&dir, registry, BackendRuntimeState::Running);
            let result = supervisor
                .recover(RecoverRequest {
                    soul_id: soul.clone(),
                    trigger: RecoveryTrigger::StartupReconcile,
                    expected_intent_revision: Some(before.intent_revision),
                    expected_control_epoch: Some(supervisor.registry.control_epoch()),
                })
                .await
                .unwrap();
            close_host.send(()).unwrap();
            responder.await.unwrap();
            if case == "current-fixture" {
                assert_eq!(
                    result.outcome,
                    RecoveryOutcome::Reattached,
                    "{case}: {result:?}"
                );
                assert_eq!(result.view.recovery_state, RecoveryState::Live);
            } else {
                assert_eq!(
                    result.outcome,
                    RecoveryOutcome::Blocked,
                    "{case}: {result:?}"
                );
                assert!(
                    matches!(
                        result.probe,
                        Some(RecoveryProbe::Blocked {
                            reason: RecoveryBlockReason::CapabilityPending,
                            ..
                        })
                    ),
                    "{case}: {result:?}"
                );
            }
            let after = supervisor
                .registry
                .recovery_context(soul.clone())
                .await
                .unwrap();
            assert_eq!(
                after.prior_handle.incarnation_id(),
                before.prior_handle.incarnation_id()
            );
            assert_eq!(
                after.prior_handle.container_id(),
                before.prior_handle.container_id()
            );
            assert_eq!(after.native_session_id.as_deref(), Some(native));
            assert!(
                after.resume_spec.is_none(),
                "a synthetic root cannot establish durable native proof"
            );
            let conn = rusqlite::Connection::open(supervisor.registry.database_path()).unwrap();
            let (incarnations, observations): (u64, u64) = conn.query_row(
                "SELECT count(*),count(native_identity_observation) FROM incarnations WHERE soul_id=?1",
                [soul.as_str()], |row| Ok((row.get(0)?,row.get(1)?)),
            ).unwrap();
            assert_eq!((incarnations, observations), (1, 0), "{case}");
        }
    }

    #[tokio::test]
    async fn provider_observed_replacement() {
        use freshell_runtime_protocol::{
            host_proof, read_frame, write_frame, Envelope, HostBootId, HostReply,
            NativeIdentityLaunch, NativeIdentityObservation, NativeIdentitySource, RecoveryState,
        };
        use tokio::net::UnixListener;
        let dir = tempfile::tempdir().unwrap();
        let registry = crate::registry::Registry::open(dir.path().join("registry"), None).unwrap();
        let soul = SoulId::new();
        let prepared =
            crate::registry::tests::materialize_test_runtime(&registry, soul.clone()).await;
        let runtime = dir.path().join("owned-host");
        std::fs::create_dir(&runtime).unwrap();
        std::fs::write(runtime.join("secret"), b"synthetic-secret").unwrap();
        let conn = rusqlite::Connection::open(dir.path().join("registry/runtime.sqlite3")).unwrap();
        conn.execute(
            "UPDATE incarnations SET runtime_dir=?1,execution_generation=1 WHERE incarnation_id=?2",
            rusqlite::params![runtime.to_string_lossy(), prepared.incarnation_id.as_str()],
        )
        .unwrap();
        conn.execute(
            "UPDATE souls SET provider='claude' WHERE soul_id=?1",
            [soul.as_str()],
        )
        .unwrap();
        registry
            .record_native_session(
                soul.clone(),
                prepared.incarnation_id.clone(),
                "ses_requested".into(),
            )
            .await
            .unwrap();
        let context = registry.recovery_context(soul.clone()).await.unwrap();
        let binding = registry
            .bind_native_identity_launch(NativeIdentityLaunch {
                incarnation_id: prepared.incarnation_id.clone(),
                launch_nonce: context.prior_handle.launch_nonce().as_str().into(),
                evidence_revision: context.evidence_revision,
                execution_generation: 1,
                requested_native_session_id: Some("ses_requested".into()),
            })
            .await
            .unwrap();
        let current = NativeIdentityObservation {
            native_session_id: "ses_requested".into(),
            incarnation_id: binding.incarnation_id.clone(),
            launch_nonce: binding.launch_nonce.clone(),
            evidence_revision: binding.evidence_revision,
            source: NativeIdentitySource::ClaudeNativeEvent,
            evidence_digest: "a".repeat(64),
        };
        let observation = Arc::new(std::sync::Mutex::new(None::<NativeIdentityObservation>));
        let responder_observation = Arc::clone(&observation);
        let supervisor = missing_supervisor(&dir, registry.clone());
        let limits = registry
            .recovery_context(soul.clone())
            .await
            .unwrap()
            .requested_limits;
        let listener = UnixListener::bind(runtime.join("host.sock")).unwrap();
        let responder = tokio::spawn(async move {
            let boot = HostBootId::new();
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request: Envelope<HostCommand> = read_frame(&mut socket).await.unwrap();
                let result = match request.body {
                    HostCommand::Hello {
                        incarnation_id,
                        challenge,
                    } => HostResult::Hello {
                        proof: host_proof(b"synthetic-secret", &challenge, &boot, &incarnation_id),
                        host_boot_id: boot.clone(),
                        capabilities: vec!["native-identity-observation-v1".into()],
                        effective_limits: limits,
                    },
                    HostCommand::Status { .. } => HostResult::Status {
                        native_identity_observation: responder_observation.lock().unwrap().clone(),
                        host_boot_id: boot.clone(),
                        worker_pid: Some(123),
                        worker_launch_count: 1,
                        max_control_epoch: 1,
                        max_execution_generation: 1,
                        fixture_evidence: serde_json::json!({}),
                        exited: false,
                        native_session_id: Some("ses_requested".into()),
                        opencode_transfer_receipt: None,
                        opencode_adoption: Default::default(),
                    },
                    _ => panic!("unexpected command"),
                };
                write_frame(
                    &mut socket,
                    &HostReply {
                        request_id: request.request_id,
                        result: Ok(result),
                    },
                )
                .await
                .unwrap();
            }
        });
        let mut variants = vec![("missing", None)];
        let mut wrong = current.clone();
        wrong.native_session_id = "ses_other".into();
        variants.push(("wrong root", Some(wrong)));
        let mut wrong = current.clone();
        wrong.incarnation_id = IncarnationId::new();
        variants.push(("previous incarnation", Some(wrong)));
        let mut wrong = current.clone();
        wrong.launch_nonce = "previous-nonce".into();
        variants.push(("previous nonce", Some(wrong)));
        let mut wrong = current.clone();
        wrong.evidence_revision += 1;
        variants.push(("wrong evidence revision", Some(wrong)));
        let mut wrong = current.clone();
        wrong.source = NativeIdentitySource::CodexAppServer;
        variants.push(("wrong native source", Some(wrong)));
        variants.push(("current", Some(current)));
        let mut results = vec![];
        for (name, value) in variants {
            *observation.lock().unwrap() = value;
            let wait = supervisor
                .wait_for_native_identity(
                    &soul,
                    &prepared.incarnation_id,
                    prepared.intent_revision,
                    Duration::from_millis(20),
                    false,
                )
                .await;
            assert_eq!(
                matches!(wait, NativeIdentityWait::Observed { .. }),
                name == "current",
                "native startup acceptance for {name}"
            );
            let stored: Option<String> = rusqlite::Connection::open(
                dir.path().join("registry/runtime.sqlite3"),
            )
            .unwrap()
            .query_row(
                "SELECT native_identity_observation FROM incarnations WHERE incarnation_id=?1",
                [prepared.incarnation_id.as_str()],
                |row| row.get(0),
            )
            .unwrap();
            assert!(
                stored.is_none(),
                "startup wait must retain publication for the activation transaction"
            );
            assert_eq!(
                registry
                    .recovery_context(soul.clone())
                    .await
                    .unwrap()
                    .write_fence(),
                context.write_fence(),
                "startup wait must not advance the activation's original write fence"
            );
            let wait = supervisor
                .wait_for_native_identity(
                    &soul,
                    &prepared.incarnation_id,
                    prepared.intent_revision,
                    Duration::from_millis(20),
                    true,
                )
                .await;
            results.push((name, matches!(wait, NativeIdentityWait::Observed { .. })));
        }
        responder.abort();
        for (name, observed) in results {
            assert_eq!(
                observed,
                name == "current",
                "native replacement acceptance for {name}"
            );
        }
        let context = registry.recovery_context(soul.clone()).await.unwrap();
        registry
            .mark_recovery_live(soul.clone(), prepared.incarnation_id, context.write_fence())
            .await
            .unwrap();
        assert_eq!(
            registry
                .recovery_context(soul)
                .await
                .unwrap()
                .recovery_state,
            RecoveryState::Live
        );
    }

    fn pending_release_test_agent(
        provider: &FreshProvider,
        native: &str,
        workspace: &std::path::Path,
    ) -> FreshAgentLaunchSpec {
        let session_type = if provider == &FreshProvider::Kilroy {
            "kilroy"
        } else {
            "freshclaude"
        };
        serde_json::from_value(serde_json::json!({"sessionId":"pending-release","provider":provider,
            "sessionType":session_type,"runtimeVariant":"claude-sdk-sidecar","providerStoreId":"owned-store",
            "cwd":workspace,"workspacePath":workspace,"runAsUid":65534,"runAsGid":0,"nativeSessionId":native})).unwrap()
    }

    struct PendingReleaseTransport {
        native: String,
        evidence: serde_json::Value,
        prepared: std::sync::Mutex<Vec<serde_json::Value>>,
        continuations: std::sync::atomic::AtomicUsize,
        effects: std::sync::atomic::AtomicUsize,
    }

    #[async_trait::async_trait]
    impl FreshAgentTransport for PendingReleaseTransport {
        async fn start(&self, _: &FreshAgentProfile) -> Result<TransportStart, String> {
            Ok(TransportStart {
                native_session_id: Some(self.native.clone()),
            })
        }

        async fn native_identity_evidence(&self) -> Option<serde_json::Value> {
            Some(self.evidence.clone())
        }

        async fn prepare_native_permission_recovery(
            &self,
            checkpoints: Vec<serde_json::Value>,
        ) -> Result<(), String> {
            *self.prepared.lock().unwrap() = checkpoints;
            Ok(())
        }

        async fn resume_native_permission_recovery(&self) -> Result<(), DispatchFailure> {
            let checkpoints = std::mem::take(&mut *self.prepared.lock().unwrap());
            assert_eq!(
                checkpoints.len(),
                1,
                "continuation consumes the prepared checkpoint once"
            );
            assert_eq!(checkpoints[0]["nativeSessionId"], self.native);
            self.continuations
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }

        async fn dispatch(
            &self,
            _: &RequestId,
            _: &str,
            _: &FreshAgentProfile,
        ) -> Result<DispatchAck, DispatchFailure> {
            panic!("checkpoint release must not dispatch a new user turn")
        }

        async fn resolve_permission(
            &self,
            decision_id: &str,
            decision: serde_json::Value,
        ) -> Result<(), DispatchFailure> {
            assert_eq!(decision_id, "pending-release-card");
            assert_eq!(decision["behavior"], "allow");
            assert_eq!(
                self.continuations.load(std::sync::atomic::Ordering::SeqCst),
                1
            );
            self.effects
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }

        async fn interrupt(&self) -> Result<(), String> {
            Ok(())
        }

        async fn stop(self: Arc<Self>) -> Result<(), String> {
            Ok(())
        }

        fn take_event_stream(
            &self,
        ) -> Option<tokio::sync::mpsc::Receiver<freshell_runtime_protocol::AgentEvent>> {
            None
        }
    }

    #[tokio::test]
    async fn pending_native_release_requires_durable_live_before_owned_host_input() {
        assert_pending_native_release_reattaches(FreshProvider::Claude).await;
    }

    #[tokio::test]
    async fn pending_native_release_kilroy_reattaches_without_replaying_continuation() {
        assert_pending_native_release_reattaches(FreshProvider::Kilroy).await;
    }

    async fn assert_pending_native_release_reattaches(provider: FreshProvider) {
        use freshell_runtime_protocol::{
            host_proof, read_frame, write_frame, Envelope, HostBootId, HostReply, InitialScanState,
            NativeIdentityLaunch, NativeIdentityObservation, NativeIdentitySource, RecoveryState,
        };
        use sha2::{Digest, Sha256};
        let dir = tempfile::tempdir().unwrap();
        let registry = crate::registry::Registry::open(dir.path().join("registry"), None).unwrap();
        let soul = SoulId::new();
        let prepared =
            crate::registry::tests::materialize_test_runtime(&registry, soul.clone()).await;
        let native = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let runtime = dir.path().join("owned-host");
        std::fs::create_dir(&runtime).unwrap();
        std::fs::write(runtime.join("secret"), b"synthetic-secret").unwrap();
        let conn = rusqlite::Connection::open(dir.path().join("registry/runtime.sqlite3")).unwrap();
        let agent = pending_release_test_agent(&provider, native, dir.path());
        conn.execute("UPDATE incarnations SET runtime_dir=?1,execution_generation=1,fixture_kind=NULL,fresh_agent_spec=?2 WHERE incarnation_id=?3",
            rusqlite::params![runtime.to_string_lossy(), serde_json::to_string(&agent).unwrap(), prepared.incarnation_id.as_str()]).unwrap();
        conn.execute(
            "UPDATE souls SET provider=?1,provider_store_id='owned-store',recovery_state='recovering' WHERE soul_id=?2",
            rusqlite::params![provider.as_str(), soul.as_str()],
        )
        .unwrap();
        registry
            .record_native_session(soul.clone(), prepared.incarnation_id.clone(), native.into())
            .await
            .unwrap();
        let context = registry.recovery_context(soul.clone()).await.unwrap();
        let binding = registry
            .bind_native_identity_launch(NativeIdentityLaunch {
                incarnation_id: prepared.incarnation_id.clone(),
                launch_nonce: context.prior_handle.launch_nonce().as_str().into(),
                evidence_revision: context.evidence_revision,
                execution_generation: 1,
                requested_native_session_id: Some(native.into()),
            })
            .await
            .unwrap();
        let observation = NativeIdentityObservation {
            native_session_id: native.into(),
            incarnation_id: binding.incarnation_id.clone(),
            launch_nonce: binding.launch_nonce.clone(),
            evidence_revision: binding.evidence_revision,
            source: NativeIdentitySource::FreshProviderHandshake,
            evidence_digest: "a".repeat(64),
        };
        let context = registry.recovery_context(soul.clone()).await.unwrap();
        registry
            .record_native_identity_observation(
                soul.clone(),
                observation.clone(),
                context.write_fence(),
            )
            .await
            .unwrap();
        let current_observation = Arc::new(std::sync::Mutex::new(Some(observation.clone())));
        let responder_observation = current_observation.clone();
        let input = serde_json::json!({"command":"harmless"});
        let checkpoint = serde_json::json!({"nativeSessionId":native,"toolUseID":"toolu_release1",
            "toolName":"Bash","inputDigest":format!("{:x}", Sha256::digest(serde_json::to_vec(&input).unwrap())),
            "profileDigest":"b".repeat(64),"checkpointUuid":"release-checkpoint",
            "assistantUuid":"release-assistant","checkpointDigest":"c".repeat(64),"nativeVersion":"2.1.237"});
        let payload = |launch: &NativeIdentityLaunch| {
            serde_json::json!({
            "requestId":"pending-release-card","nativeRequestId":launch.launch_nonce,
            "toolUseID":"toolu_release1","tool":{"name":"Bash","input":input},"nativeCheckpoint":checkpoint,
            "nativeBinding":{"launch":launch,"queryGeneration":2,"nativeRequestId":launch.launch_nonce}})
        };
        let transport = |launch: &NativeIdentityLaunch| {
            Arc::new(PendingReleaseTransport {
                native: native.into(),
                evidence: serde_json::json!({"launch":launch,"queryGeneration":2}),
                prepared: Default::default(),
                continuations: Default::default(),
                effects: Default::default(),
            })
        };
        let profile: FreshAgentProfile =
            serde_json::from_value(serde_json::to_value(&agent).unwrap()).unwrap();
        let mut prior_binding = binding.clone();
        prior_binding.launch_nonce = "prior-native-query".into();
        let prior = FreshAgentHostActor::open(
            runtime.join("actor"),
            profile.clone(),
            transport(&prior_binding),
        )
        .await
        .unwrap();
        prior
            .record_permission("pending-release-card".into(), payload(&prior_binding))
            .await
            .unwrap();
        prior.stop().await.unwrap();
        let current = transport(&binding);
        let actor = FreshAgentHostActor::open(runtime.join("actor"), profile, current.clone())
            .await
            .unwrap();
        assert_eq!(*current.prepared.lock().unwrap(), vec![checkpoint.clone()]);
        let hosted_actor = actor.clone();
        let registry_path = dir.path().join("registry/runtime.sqlite3");
        let actual_soul = soul.clone();
        let limits = context.requested_limits;
        let hosted_incarnation = prepared.incarnation_id.clone();
        let listener = tokio::net::UnixListener::bind(runtime.join("host.sock")).unwrap();
        let (close_host, mut host_closed) = tokio::sync::oneshot::channel::<()>();
        let responder = tokio::spawn(async move {
            let boot = HostBootId::new();
            loop {
                let (mut socket, _) = tokio::select! {
                    _ = &mut host_closed => break,
                    accepted = listener.accept() => accepted.unwrap(),
                };
                let request: Envelope<HostCommand> = read_frame(&mut socket).await.unwrap();
                if !matches!(&request.body, HostCommand::Hello { .. }) {
                    assert_eq!(
                        request.auth,
                        Some(host_proof(
                            b"synthetic-secret",
                            "command-auth",
                            &boot,
                            &hosted_incarnation
                        ))
                    );
                }
                let result = match request.body {
                    HostCommand::Hello {
                        incarnation_id,
                        challenge,
                    } => Ok(HostResult::Hello {
                        proof: host_proof(b"synthetic-secret", &challenge, &boot, &incarnation_id),
                        host_boot_id: boot.clone(),
                        capabilities: vec![
                            "native-identity-observation-v1".into(),
                            "owned-provider-config-v1".into(),
                            "provider-store-probe-v1".into(),
                        ],
                        effective_limits: limits,
                    }),
                    HostCommand::Status { .. } => {
                        let native_identity_observation =
                            responder_observation.lock().unwrap().clone();
                        Ok(HostResult::Status {
                            native_identity_observation,
                            host_boot_id: boot.clone(),
                            worker_pid: Some(123),
                            worker_launch_count: 1,
                            max_control_epoch: 1,
                            max_execution_generation: 1,
                            fixture_evidence: serde_json::json!({}),
                            exited: false,
                            native_session_id: hosted_actor.observed_native_session_id().await,
                            opencode_transfer_receipt: None,
                            opencode_adoption: Default::default(),
                        })
                    }
                    HostCommand::ProbeRecovery {
                        resume_spec,
                        run_as_uid,
                        run_as_gid,
                        ..
                    } => {
                        assert_eq!((run_as_uid, run_as_gid), (65534, 0));
                        let resume_spec =
                            resume_spec.expect("exact retained native resume candidate");
                        assert_eq!(resume_spec.provider_session.native_session_id, native);
                        Ok(HostResult::RecoveryProbe(RecoveryProbe::ResumeReady {
                            evidence_revision: resume_spec.evidence_revision,
                            resume_spec,
                        }))
                    }
                    HostCommand::FreshAgentResumePending { incarnation_id } => {
                        assert_eq!(incarnation_id, hosted_incarnation);
                        let actual_registry = rusqlite::Connection::open(&registry_path).unwrap();
                        let state: String = actual_registry
                            .query_row(
                                "SELECT recovery_state FROM souls WHERE soul_id=?1",
                                [actual_soul.as_str()],
                                |row| row.get(0),
                            )
                            .unwrap();
                        assert_eq!(state, "live", "release cannot precede durable LIVE");
                        drop(actual_registry);
                        hosted_actor
                            .resume_pending_native_permissions()
                            .await
                            .map(|()| HostResult::FreshAgentCommand {
                                state: freshell_runtime_protocol::CommandState::ProviderAcked,
                                native_session_id: Some(native.into()),
                                claude_fork: None,
                            })
                            .map_err(|error| {
                                RuntimeError::new(
                                    match error {
                                        ActorError::AmbiguousDispatch => {
                                            RuntimeErrorCode::CommandAmbiguous
                                        }
                                        ActorError::NativeIdentityMismatch => {
                                            RuntimeErrorCode::RecoveryWrongIdentity
                                        }
                                        _ => RuntimeErrorCode::HostUnreachable,
                                    },
                                    error.to_string(),
                                )
                            })
                    }
                    _ => panic!("unexpected pending-release command"),
                };
                write_frame(
                    &mut socket,
                    &HostReply {
                        request_id: request.request_id,
                        result,
                    },
                )
                .await
                .unwrap();
            }
        });
        let supervisor =
            supervisor_with_runtime_state(&dir, registry.clone(), BackendRuntimeState::Running);
        let before = supervisor
            .release_pending_native_permissions_after_live(
                soul.clone(),
                prepared.incarnation_id.clone(),
            )
            .await;
        let context = registry.recovery_context(soul.clone()).await.unwrap();
        registry
            .mark_recovery_live(
                soul.clone(),
                prepared.incarnation_id.clone(),
                context.write_fence(),
            )
            .await
            .unwrap();
        *current_observation.lock().unwrap() = None;
        let withdrawn = supervisor
            .release_pending_native_permissions_after_live(
                soul.clone(),
                prepared.incarnation_id.clone(),
            )
            .await;
        let mut stale = observation.clone();
        stale.launch_nonce = "old-query-nonce".into();
        *current_observation.lock().unwrap() = Some(stale);
        let stale = supervisor
            .release_pending_native_permissions_after_live(
                soul.clone(),
                prepared.incarnation_id.clone(),
            )
            .await;
        *current_observation.lock().unwrap() = Some(observation.clone());
        let after = supervisor
            .release_pending_native_permissions_after_live(
                soul.clone(),
                prepared.incarnation_id.clone(),
            )
            .await;
        actor
            .record_permission("pending-release-card".into(), payload(&binding))
            .await
            .unwrap();
        assert_eq!(current.effects.load(std::sync::atomic::Ordering::SeqCst), 0);
        let recover = |revision| RecoverRequest {
            soul_id: soul.clone(),
            trigger: RecoveryTrigger::ManualRetry,
            expected_intent_revision: Some(revision),
            expected_control_epoch: Some(registry.control_epoch()),
        };
        let revision = registry
            .recovery_context(soul.clone())
            .await
            .unwrap()
            .intent_revision;
        let pending = supervisor.recover(recover(revision)).await;
        actor
            .resolve_permission(
                "pending-release-card",
                serde_json::json!({"behavior":"allow"}),
            )
            .await
            .unwrap();
        let revision = registry
            .recovery_context(soul.clone())
            .await
            .unwrap()
            .intent_revision;
        let resolved = supervisor.recover(recover(revision)).await;
        conn.execute(
            "UPDATE souls SET recovery_state='recovering' WHERE soul_id=?1",
            [soul.as_str()],
        )
        .unwrap();
        let context = registry.recovery_context(soul.clone()).await.unwrap();
        let lifecycle = supervisor.lifecycle_lock(&soul).await;
        let lifecycle_guard = lifecycle.lock().await;
        let reattached = supervisor
            .preserve_nonloss_probe(
                soul.clone(),
                RecoveryTrigger::StartupReconcile,
                RecoveryProbe::ReattachReady {
                    handle: ReattachHandle {
                        incarnation_id: prepared.incarnation_id.clone(),
                        host_boot_id: HostBootId::new(),
                        container_id: context.prior_handle.container_id().into(),
                    },
                    protocol_version: CONTROL_PROTOCOL_VERSION,
                },
                context.write_fence(),
            )
            .await;
        drop(lifecycle_guard);
        drop(supervisor);
        drop(registry);
        let registry = crate::registry::Registry::open(dir.path().join("registry"), None).unwrap();
        let restarted =
            supervisor_with_runtime_state(&dir, registry.clone(), BackendRuntimeState::Running);
        let startup = restarted.reconcile_startup().await.unwrap();
        let readiness = registry.inventory_snapshot().await.unwrap().readiness;
        let current_context = registry.recovery_context(soul.clone()).await.unwrap();
        close_host.send(()).unwrap();
        responder.await.unwrap();
        assert_eq!(
            actor.observed_native_session_id().await.as_deref(),
            Some(native)
        );
        assert_eq!(
            actor.observed_native_identity_evidence().await,
            Some(current.evidence.clone())
        );
        actor.stop().await.unwrap();
        assert!(
            before.is_err(),
            "pending release must refuse before durable LIVE"
        );
        assert!(
            withdrawn.is_err(),
            "withdrawn current observation must refuse before native input"
        );
        assert!(
            stale.is_err(),
            "stale current observation must refuse before native input"
        );
        assert!(
            after.is_ok(),
            "current LIVE release must reach the authenticated owned host: {after:?}"
        );
        let reattached_ok = |result: &Result<RecoveryResult, RuntimeError>| {
            matches!(
                result,
                Ok(RecoveryResult {
                    outcome: RecoveryOutcome::Reattached,
                    ..
                })
            )
        };
        assert!(reattached_ok(&pending) && reattached_ok(&resolved) && reattached_ok(&reattached)
            && startup.results.iter().all(|result| result.outcome == Some(RecoveryOutcome::Reattached) && result.error.is_none()),
            "settled release must preserve pending/resolved Recover and retained-host startup: pending={pending:?}, resolved={resolved:?}, preserved={reattached:?}, startup={startup:?}");
        assert_eq!(startup.scanned, 1);
        assert_eq!(readiness.initial_scan_state, InitialScanState::Complete);
        assert!(readiness.blocked_subsystems.is_empty());
        assert_eq!(current_context.recovery_state, RecoveryState::Live);
        assert_eq!(current_context.native_session_id.as_deref(), Some(native));
        assert_eq!(
            current_context.prior_handle.incarnation_id(),
            &prepared.incarnation_id
        );
        assert_eq!(
            current
                .continuations
                .load(std::sync::atomic::Ordering::SeqCst),
            1,
            "successful reattach must not repeat the accepted native continuation"
        );
        assert_eq!(current.effects.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn missing_adoption_observation_is_not_reported_as_wrong_native_identity() {
        assert_eq!(
            validate_native_identity_wait(
                "ses_expected",
                NativeIdentityWait::TimedOut {
                    adoption_pending: true,
                    elapsed_ms: 180_000,
                },
            )
            .unwrap_err()
            .0,
            RecoveryBlockReason::CapabilityPending
        );
        assert_eq!(
            validate_native_identity_wait(
                "ses_expected",
                NativeIdentityWait::ProviderExited { elapsed_ms: 8_000 },
            )
            .unwrap_err()
            .0,
            RecoveryBlockReason::ProviderUnavailable
        );
        assert_eq!(
            validate_native_identity_wait(
                "ses_expected",
                NativeIdentityWait::HostUnavailable {
                    transient: Some(TransientRecoveryFailure::Host),
                    message: "host status socket unavailable".into(),
                    elapsed_ms: 1_000,
                },
            )
            .unwrap_err()
            .0,
            RecoveryBlockReason::ProviderUnavailable
        );
        assert_eq!(
            validate_native_identity_wait(
                "ses_expected",
                NativeIdentityWait::TimedOut {
                    adoption_pending: false,
                    elapsed_ms: 8_000,
                },
            )
            .unwrap_err()
            .0,
            RecoveryBlockReason::ProviderUnavailable
        );
        assert_eq!(
            validate_native_identity_wait(
                "ses_expected",
                NativeIdentityWait::Observed {
                    native_session_id: "ses_other".into(),
                    elapsed_ms: 5_000,
                },
            )
            .unwrap_err()
            .0,
            RecoveryBlockReason::WrongNativeIdentity
        );
        assert_eq!(
            validate_native_identity_wait(
                "ses_expected",
                NativeIdentityWait::Observed {
                    native_session_id: "ses_expected".into(),
                    elapsed_ms: 5_000,
                },
            )
            .unwrap(),
            "ses_expected"
        );
    }

    #[test]
    fn opencode_adoption_wait_uses_the_browser_readiness_budget() {
        assert_eq!(native_identity_wait_timeout(true), Duration::from_secs(180));
        assert_eq!(native_identity_wait_timeout(false), Duration::from_secs(8));
    }

    #[test]
    fn stopped_intent_cancels_readiness_wait_without_rewriting_newer_intent() {
        assert_eq!(
            native_identity_wait_cancellation(DesiredState::Stopped, 7, 7, 1),
            Some(NativeIdentityWait::StopIntent { elapsed_ms: 1 })
        );
        assert_eq!(
            native_identity_wait_cancellation(DesiredState::Running, 8, 7, 2),
            Some(NativeIdentityWait::IntentChanged { elapsed_ms: 2 })
        );
        assert_eq!(
            native_identity_wait_cancellation(DesiredState::Running, 7, 7, 3),
            None
        );
    }

    #[test]
    fn exited_provider_is_not_accepted_even_if_it_retained_its_native_identity() {
        let result =
            native_identity_wait_from_status(true, Some("ses_expected".into()), 9_000).unwrap();
        assert_eq!(
            validate_native_identity_wait("ses_expected", result)
                .unwrap_err()
                .0,
            RecoveryBlockReason::ProviderUnavailable
        );
    }

    fn owner_candidate(id: &str) -> StoppedRepairOwnerCandidate {
        StoppedRepairOwnerCandidate {
            soul_id: SoulId::parse(id).unwrap(),
            source_store_id: Some("source-store".into()),
            root_session_id: Some("ses_exact".into()),
            source_generation: Some("generation-exact".into()),
            native_import_state: NativeImportState::Pending,
            native_import_authority: "exact_source_snapshot".into(),
            explicit_view_count: 0,
        }
    }

    #[test]
    fn duplicate_root_owner_selection_uses_receipts_views_then_explicit_choice() {
        let mut candidates = vec![owner_candidate("soul-one"), owner_candidate("soul-two")];
        candidates[0].native_import_state = NativeImportState::Completed;
        candidates[0].native_import_authority = "verified_import_receipt".into();
        let selection = choose_canonical_root_owner(
            &candidates,
            "source-store",
            "ses_exact",
            "generation-exact",
            None,
        )
        .unwrap();
        assert!(matches!(
            selection,
            CanonicalRootOwnerSelection::Chosen(owner) if owner.soul_id == candidates[0].soul_id
        ));

        candidates[0].native_import_state = NativeImportState::Pending;
        candidates[0].native_import_authority = "exact_source_snapshot".into();
        candidates[1].explicit_view_count = 1;
        let selection = choose_canonical_root_owner(
            &candidates,
            "source-store",
            "ses_exact",
            "generation-exact",
            None,
        )
        .unwrap();
        assert!(
            matches!(selection, CanonicalRootOwnerSelection::Chosen(owner)
            if owner.soul_id == candidates[1].soul_id)
        );

        candidates[1].explicit_view_count = 0;
        let selection = choose_canonical_root_owner(
            &candidates,
            "source-store",
            "ses_exact",
            "generation-exact",
            None,
        )
        .unwrap();
        assert!(
            matches!(selection, CanonicalRootOwnerSelection::ChoiceRequired(owners)
            if owners == vec![candidates[0].soul_id.clone(), candidates[1].soul_id.clone()])
        );

        let selected = choose_canonical_root_owner(
            &candidates,
            "source-store",
            "ses_exact",
            "generation-exact",
            Some(&candidates[1].soul_id),
        )
        .unwrap();
        assert!(
            matches!(selected, CanonicalRootOwnerSelection::Chosen(owner)
            if owner.soul_id == candidates[1].soul_id)
        );

        assert!(matches!(
            choose_canonical_root_owner(
                &candidates,
                "source-store",
                "ses_exact",
                "generation-exact",
                None,
            )
            .unwrap(),
            CanonicalRootOwnerSelection::ChoiceRequired(_)
        ));
    }

    #[test]
    fn duplicate_root_owner_selection_blocks_conflicting_receipt_generations() {
        let mut candidates = vec![owner_candidate("soul-one"), owner_candidate("soul-two")];
        candidates[0].native_import_state = NativeImportState::Completed;
        candidates[0].native_import_authority = "verified_import_receipt".into();
        candidates[0].source_generation = Some("generation-stale".into());
        candidates[1].explicit_view_count = 1;
        assert!(choose_canonical_root_owner(
            &candidates,
            "source-store",
            "ses_exact",
            "generation-exact",
            None,
        )
        .unwrap_err()
        .contains("conflicting import receipt"));
    }

    #[test]
    fn duplicate_root_owner_selection_ignores_retired_duplicate_authority() {
        let mut candidates = vec![owner_candidate("canonical"), owner_candidate("retired")];
        candidates[1].native_import_state = NativeImportState::Completed;
        candidates[1].native_import_authority = "retired_duplicate".into();
        candidates[1].explicit_view_count = 9;
        assert!(matches!(choose_canonical_root_owner(
            &candidates,
            "source-store",
            "ses_exact",
            "generation-exact",
            None,
        ).unwrap(), CanonicalRootOwnerSelection::Chosen(owner)
            if owner.soul_id == candidates[0].soul_id));
    }

    #[test]
    fn retained_runtime_alive_never_bypasses_blocked_store_reader() {
        let handle = ReattachHandle {
            incarnation_id: IncarnationId::new(),
            host_boot_id: freshell_runtime_protocol::HostBootId::new(),
            container_id: "exact-retained-container".into(),
        };
        let probe = blocked(
            RecoveryPath::NativeResume,
            RecoveryBlockReason::StoreUnreadable,
            "fixture config permission unavailable",
            Some(2000),
        );
        assert!(matches!(
            retained_runtime_probe(false, handle.clone(), probe, true),
            RecoveryProbe::Blocked {
                reason: RecoveryBlockReason::StoreUnreadable,
                ..
            }
        ));
        let unavailable = RecoveryProbe::DefinitivelyUnavailable {
            negative_paths: Vec::new(),
            path: RecoveryPath::NativeResume,
            reason: "store inspection incomplete".into(),
            evidence: vec![],
            store_state: freshell_runtime_protocol::EvidenceStoreState::Missing,
        };
        assert!(matches!(
            retained_runtime_probe(false, handle.clone(), unavailable, true),
            RecoveryProbe::Blocked {
                reason: RecoveryBlockReason::StoreUnreadable,
                ..
            }
        ));
        let pristine = RecoveryProbe::PristineSeedReady {
            seed: "proven-seed".into(),
            never_dispatched_proof: "durable-empty-journal".into(),
        };
        assert!(matches!(
            retained_runtime_probe(false, handle, pristine, true),
            RecoveryProbe::ReattachReady { .. }
        ));
    }

    #[tokio::test]
    async fn dispatched_shell_retains_its_terminal_end_policy_with_no_native_store() {
        let dir = tempfile::tempdir().unwrap();
        let registry = crate::registry::Registry::open(dir.path(), None).unwrap();
        let soul = SoulId::new();
        let launch =
            crate::registry::tests::materialize_test_runtime(&registry, soul.clone()).await;
        let conn = crate::registry::open_connection(registry.database_path()).unwrap();
        conn.execute(
            "UPDATE souls SET provider='shell',native_session_id=NULL WHERE soul_id=?1",
            [soul.as_str()],
        )
        .unwrap();
        conn.execute("INSERT INTO input_commands (soul_id,request_id,payload_digest,protected_payload,incarnation_id,state,created_at,updated_at) VALUES (?1,'dispatched','test',X'00',?2,'completed',1,1)", rusqlite::params![soul.as_str(),launch.incarnation_id.as_str()]).unwrap();
        let context = registry.recovery_context(soul).await.unwrap();
        let probe = offline_probe(&context).unwrap();
        assert!(
            matches!(probe, RecoveryProbe::DefinitivelyUnavailable { .. }),
            "{probe:?}"
        );
        let handle = ReattachHandle {
            incarnation_id: context.prior_handle.incarnation_id().clone(),
            host_boot_id: freshell_runtime_protocol::HostBootId::new(),
            container_id: context.prior_handle.container_id().into(),
        };
        assert!(matches!(
            retained_runtime_probe(true, handle.clone(), probe.clone(), false),
            RecoveryProbe::DefinitivelyUnavailable { .. }
        ));
        assert!(matches!(
            retained_runtime_probe(false, handle, probe, false),
            RecoveryProbe::ReattachReady { .. }
        ));
    }

    #[test]
    fn stopped_import_failure_preserves_first_diagnostic_when_abort_fails() {
        let dir = tempfile::tempdir().unwrap();
        let staging = crate::opencode_transfer::OpenCodeTransferStaging::new(
            dir.path().join("stage"),
            crate::opencode_transfer::StagingLimits::for_test(1024, 2048),
        )
        .unwrap();
        let aborted = staging.abort("transfer", "invalid attempt");
        assert!(aborted.is_err());
        let mut detail = crate::backend::StoppedRepairFailure::new("helper_nonzero_exit");
        detail.helper_exit = Some(17);
        let path = dir.path().join("lifecycle.jsonl");
        super::log_stopped_repair_import_failure(
            &path,
            serde_json::json!({"operationId":"synthetic-operation"}),
            &BackendError::StoppedRepair(Box::new(detail)),
            aborted,
        );
        let events: Vec<serde_json::Value> = std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(events.len(), 2);
        assert_eq!(
            events[0]["event"],
            "supervisor.stopped_repair.import_failed"
        );
        assert_eq!(events[0]["data"]["backendDiagnostic"]["helperExit"], 17);
        assert_eq!(
            events[1]["event"],
            "supervisor.stopped_repair.staging_abort_failed"
        );
        assert_eq!(events[1]["data"]["backendDiagnostic"]["helperExit"], 17);
        assert_eq!(events[1]["data"]["abortCategory"], "invalid_state");
    }

    struct ObservedRuntime {
        state: BackendRuntimeState,
        repaired: Option<Arc<RepairedPreflightEvidence>>,
    }

    #[derive(Default)]
    struct RepairedPreflightEvidence {
        ownership_mismatch: bool,
        baseline: Option<OpenCodeAdoptionBaseline>,
        qualifications: std::sync::atomic::AtomicUsize,
        empty_checks: std::sync::atomic::AtomicUsize,
    }

    #[async_trait::async_trait]
    impl crate::backend::RuntimeBackend for ObservedRuntime {
        async fn repair_stopped_opencode(
            &self,
            handle: &OwnedRuntimeHandle,
            _: &OpenCodeTransferDescriptor,
            _: &Path,
        ) -> Result<StoppedOpenCodeRepairReceipts, BackendError> {
            if handle.terminal().is_some_and(|terminal| {
                terminal
                    .env
                    .contains_key("FRESHELL_TEST_STOPPED_DIAGNOSTIC")
            }) {
                let mut detail = crate::backend::StoppedRepairFailure::new("helper_nonzero_exit");
                detail.helper_exit = Some(23);
                detail.wait_http_status = Some(200);
                detail.stage = Some("reader");
                detail.error_class = Some("io");
                detail.errno = Some(13);
                return Err(BackendError::StoppedRepair(Box::new(detail)));
            }
            Err(BackendError::Unavailable(
                "stopped OpenCode repair helper is unavailable".into(),
            ))
        }

        async fn inspect(
            &self,
            handle: &OwnedRuntimeHandle,
        ) -> Result<crate::backend::BackendInspection, BackendError> {
            if self
                .repaired
                .as_ref()
                .is_some_and(|evidence| evidence.ownership_mismatch)
            {
                return Err(BackendError::OwnershipMismatch(
                    "controlled saved binding mismatch".into(),
                ));
            }
            Ok(crate::backend::BackendInspection {
                state: self.state,
                configured_limits: handle.requested_limits(),
            })
        }
        async fn qualify_retained_opencode(
            &self,
            handle: &OwnedRuntimeHandle,
            request: &freshell_runtime_protocol::RetainedStoreCompatibilityRequest,
            _: &Path,
        ) -> Result<freshell_runtime_protocol::RetainedStoreCompatibilityReceipt, BackendError>
        {
            let Some(evidence) = &self.repaired else {
                return Err(BackendError::Unavailable(
                    "current-image retained-store qualification is unavailable".into(),
                ));
            };
            assert_eq!(request.provider_store_id, handle.provider_store_id());
            let terminal = handle.terminal().unwrap();
            assert_eq!(
                (request.provider_uid, request.provider_gid),
                (terminal.run_as_uid, terminal.run_as_gid)
            );
            assert_eq!(request.workspace_path, terminal.workspace_path);
            assert_eq!(request.cwd, terminal.cwd);
            let baseline = &evidence.baseline.as_ref().unwrap().descriptor;
            assert_eq!(request.native_session_id, baseline.root_session_id);
            evidence
                .qualifications
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            // Controlled backend transition evidence only. The source/import/
            // readability receipts and baseline come from the real library path
            // in loss_report_tests; this receipt is never native qualification.
            Ok(
                freshell_runtime_protocol::RetainedStoreCompatibilityReceipt {
                    request: request.clone(),
                    provider_version: "1.18.21".into(),
                    source_schema_fingerprint: baseline.source_schema_fingerprint.clone(),
                    migration_journal_fingerprint: baseline.migration_journal_fingerprint.clone(),
                    generation: baseline.source_generation.clone(),
                    row_count: serde_json::from_str::<serde_json::Value>(&baseline.manifest_json)
                        .unwrap()["row_count"]
                        .as_u64()
                        .unwrap() as usize,
                },
            )
        }
        async fn create_stopped(
            &self,
            _: &crate::backend::CreateRuntimeSpec,
        ) -> Result<crate::backend::BackendCreated, BackendError> {
            panic!("unexpected launch")
        }
        async fn start_host(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
            panic!("unexpected launch")
        }
        async fn request_stop(&self, _: &OwnedRuntimeHandle, _: u64) -> Result<(), BackendError> {
            panic!("unexpected stop")
        }
        async fn force_stop(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
            panic!("unexpected stop")
        }
        async fn verify_empty(&self, _: &OwnedRuntimeHandle) -> Result<bool, BackendError> {
            if let Some(evidence) = &self.repaired {
                evidence
                    .empty_checks
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                return Ok(self.state == BackendRuntimeState::Created);
            }
            Ok(true)
        }
        async fn list_known(
            &self,
            _: &[OwnedRuntimeHandle],
        ) -> Result<Vec<(IncarnationId, crate::backend::BackendInspection)>, BackendError> {
            panic!("unexpected list")
        }
        async fn read_limits(
            &self,
            handle: &OwnedRuntimeHandle,
        ) -> Result<freshell_runtime_protocol::RuntimeLimits, BackendError> {
            Ok(handle.requested_limits())
        }
        async fn enable_long_lived(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
            panic!("unexpected launch")
        }
    }

    pub(crate) fn missing_supervisor(
        dir: &tempfile::TempDir,
        registry: crate::registry::Registry,
    ) -> Supervisor {
        supervisor_with_runtime_state(dir, registry, BackendRuntimeState::Missing)
    }

    pub(crate) fn supervisor_with_runtime_state(
        dir: &tempfile::TempDir,
        registry: crate::registry::Registry,
        state: BackendRuntimeState,
    ) -> Supervisor {
        Supervisor::new(
            registry,
            std::sync::Arc::new(ObservedRuntime {
                state,
                repaired: None,
            }),
            crate::service::SupervisorConfig {
                runtime_root: dir.path().join("runtime"),
                control_socket_path: dir.path().join("control.sock"),
                host_binary_path: std::env::current_exe().unwrap(),
                image_ref: format!("sha256:{}", "a".repeat(64)),
                test_run_id: "native-inventory".into(),
                control_secret: "synthetic-secret".into(),
                lifecycle_log: dir.path().join("lifecycle.jsonl"),
                admission: crate::admission::AdmissionPolicy::default(),
            },
        )
        .unwrap()
    }

    pub(crate) fn assert_created_repaired_preflight<'a>(
        dir: &'a tempfile::TempDir,
        registry: &'a crate::registry::Registry,
        soul: &'a SoulId,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + 'a>> {
        Box::pin(async move {
            use std::sync::atomic::Ordering;
            let initial = registry.recovery_context(soul.clone()).await.unwrap();
            assert!(
                initial.opencode_adoption_baseline.is_some(),
                "test must use the published real import baseline"
            );
            registry
                .start_stopped_data_repair(soul.clone(), initial.intent_revision)
                .await
                .unwrap();
            for (state, mismatch) in [
                (BackendRuntimeState::Paused, false),
                (BackendRuntimeState::Restarting, false),
                (BackendRuntimeState::Created, true),
                (BackendRuntimeState::Created, false),
            ] {
                let evidence = Arc::new(RepairedPreflightEvidence {
                    ownership_mismatch: mismatch,
                    baseline: initial.opencode_adoption_baseline.clone(),
                    ..Default::default()
                });
                let config = (*missing_supervisor(dir, registry.clone()).config).clone();
                let supervisor = Supervisor::new(
                    registry.clone(),
                    Arc::new(ObservedRuntime {
                        state,
                        repaired: Some(evidence.clone()),
                    }),
                    config,
                )
                .unwrap();
                let mut current = registry.recovery_context(soul.clone()).await.unwrap();
                let fence = current.write_fence();
                let mut transient = None;
                let probe = supervisor
                    .probe_recovery_context(&mut current, &mut transient)
                    .await
                    .unwrap();
                let valid_created = state == BackendRuntimeState::Created && !mismatch;
                assert!(transient.is_none());
                assert_eq!(
                    current.write_fence(),
                    fence,
                    "preflight cannot advance durable evidence"
                );
                if valid_created {
                    let RecoveryProbe::ResumeReady {
                        resume_spec,
                        evidence_revision,
                    } = probe
                    else {
                        panic!("Created must reach retained qualification: {probe:?}")
                    };
                    assert_eq!(evidence_revision, current.evidence_revision);
                    assert_eq!(
                        resume_spec.provider_session.native_session_id,
                        current.native_session_id.clone().unwrap()
                    );
                    assert_eq!(
                        resume_spec.provider_session.provider_store_id,
                        current.provider_store_id
                    );
                    assert_eq!(
                        resume_spec.opencode_adoption_baseline,
                        initial.opencode_adoption_baseline
                    );
                    assert_eq!(evidence.qualifications.load(Ordering::SeqCst), 1);
                    // This is the actual independent empty-retirement boundary used
                    // by replacement. No callback, grant, replacement or native
                    // success is claimed by this transition regression.
                    assert_eq!(
                        supervisor
                            .terminate_owned_for_recovery(&current.prior_handle)
                            .await
                            .unwrap(),
                        StopOutcome::VerifiedEmpty
                    );
                    assert_eq!(
                        evidence.empty_checks.load(Ordering::SeqCst),
                        1,
                        "replacement independently proves old enclosure empty"
                    );
                } else {
                    assert!(
                        matches!(
                            probe,
                            RecoveryProbe::Blocked {
                                reason: RecoveryBlockReason::OldRuntimeNotEmpty,
                                ..
                            }
                        ),
                        "{state:?}/mismatch={mismatch}: {probe:?}"
                    );
                    assert_eq!(evidence.qualifications.load(Ordering::SeqCst), 0);
                    assert_eq!(evidence.empty_checks.load(Ordering::SeqCst), 0);
                }
                let after = registry.recovery_context(soul.clone()).await.unwrap();
                assert_eq!(
                    after.prior_handle.incarnation_id(),
                    initial.prior_handle.incarnation_id()
                );
                assert_eq!(after.native_session_id, initial.native_session_id);
                assert_eq!(after.provider_store_id, initial.provider_store_id);
                assert_eq!(
                    after.opencode_adoption_baseline,
                    initial.opencode_adoption_baseline
                );
            }
        })
    }

    pub(crate) fn absent_native_probe() -> RecoveryProbe {
        RecoveryProbe::DefinitivelyUnavailable {
            negative_paths: Vec::new(),
            path: RecoveryPath::NativeResume,
            reason: "synthetic native store absent".into(),
            evidence: vec![],
            store_state: EvidenceStoreState::Missing,
        }
    }

    pub(crate) async fn revalidate_previously_negative_loss(
        supervisor: &Supervisor,
        soul_id: SoulId,
    ) -> Result<RecoveryResult, RuntimeError> {
        supervisor
            .certify_and_cleanup_loss(
                soul_id,
                RecoveryTrigger::StartupReconcile,
                absent_native_probe(),
            )
            .await
    }

    #[tokio::test]
    async fn status_materialization_prevents_provider_seed_readiness() {
        let dir = tempfile::tempdir().unwrap();
        let registry = crate::registry::Registry::open(dir.path(), None).unwrap();
        let soul = SoulId::new();
        let launch =
            crate::registry::tests::materialize_test_runtime(&registry, soul.clone()).await;
        let before = registry.recovery_context(soul.clone()).await.unwrap();
        registry
            .record_native_session_fenced(
                soul.clone(),
                launch.incarnation_id,
                "ses_observed_status".into(),
                before.write_fence(),
            )
            .await
            .unwrap();
        let observed = registry.recovery_context(soul).await.unwrap();
        assert!(!matches!(
            after_native_probe(&observed, absent_native_probe()),
            RecoveryProbe::PristineSeedReady { .. }
        ));
        assert!(matches!(
            after_native_probe(
                &observed,
                RecoveryProbe::PristineSeedReady {
                    seed: before.creation_seed_ref,
                    never_dispatched_proof: "old host snapshot".into()
                }
            ),
            RecoveryProbe::Blocked {
                path: RecoveryPath::PristineSeed,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn pending_stopped_repair_withdrawal_does_not_suppress_unrelated_exports() {
        let dir = tempfile::tempdir().unwrap();
        let registry = crate::registry::Registry::open(dir.path(), None).unwrap();
        let operation_id = freshell_runtime_protocol::RequestId::new();
        let incident_id = freshell_runtime_protocol::IncidentId::new();
        let conn = crate::registry::open_connection(registry.database_path()).unwrap();
        conn.execute(
            "INSERT INTO stopped_repair_operations(operation_id,idempotency_key,target_fingerprint,targets_json,status,created_at,updated_at) VALUES (?1,?1,'test-fingerprint','[]','withdraw_pending',1,1)",
            rusqlite::params![operation_id.as_str()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO outbox(event_id,event_kind,payload,created_at) VALUES ('unrelated-final-export','loss_incident.final',?1,1)",
            rusqlite::params![serde_json::json!({
                "incidentId": incident_id,
                "cleanupState": "closed",
                "event": "unrelated"
            }).to_string()],
        )
        .unwrap();
        drop(conn);

        let supervisor = missing_supervisor(&dir, registry.clone());
        let result = supervisor.export_pending_incidents().await;
        assert!(result.is_err(), "failed withdrawal remains retryable");
        assert!(
            registry
                .registry_root()
                .join("incidents")
                .join(format!("{incident_id}.closed.json"))
                .exists(),
            "unrelated incident export completes despite the separate pending withdrawal"
        );
        let delivered: Option<i64> = crate::registry::open_connection(registry.database_path())
            .unwrap()
            .query_row(
                "SELECT delivered_at FROM outbox WHERE event_id='unrelated-final-export'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(delivered.is_some());
    }

    #[test]
    fn queued_fresh_prompt_replays_with_the_exact_persisted_turn_profile() {
        let agent = FreshAgentLaunchSpec {
            session_id: "presentation".into(),
            provider: FreshProvider::Codex,
            session_type: "freshcodex".into(),
            runtime_variant: "codex-app-server".into(),
            provider_store_id: "store".into(),
            cwd: "/workspace/nested".into(),
            workspace_path: "/workspace".into(),
            git_common_dir: None,
            run_as_uid: 65_534,
            run_as_gid: 0,
            model: Some("model-exact".into()),
            effort: Some("high".into()),
            permission_mode: Some("ask".into()),
            sandbox: Some("workspace-write".into()),
            native_session_id: Some("thread-exact".into()),
            plugins: None,
            model_selection: None,
            session_ref: None,
            fixture_transport: None,
            provider_bootstrap_files: Vec::new(),
            provider_secret_references: Vec::new(),
            provider_launch_context: None,
        };

        let settings = fresh_agent_replay_settings(&agent);
        assert_eq!(settings.cwd.as_deref(), Some("/workspace/nested"));
        assert_eq!(settings.model.as_deref(), Some("model-exact"));
        assert_eq!(settings.effort.as_deref(), Some("high"));
        assert_eq!(settings.permission_mode.as_deref(), Some("ask"));
        assert_eq!(settings.sandbox.as_deref(), Some("workspace-write"));
    }

    #[test]
    fn preflight_diagnostics_preserve_safe_causes_without_native_bodies_or_credentials() {
        assert_eq!(
            preflight_diagnostic_repair(Some(
                "Bearer private-credential; synthetic native message"
            )),
            None
        );
        assert_eq!(
            preflight_diagnostic_repair(Some("runtime mount topology changed")),
            Some("runtime mount topology changed")
        );
        assert_eq!(
            preflight_diagnostic_repair(Some("repair the soul-local OpenCode database")),
            Some("repair the soul-local OpenCode database")
        );
        assert_eq!(preflight_diagnostic_repair(Some("private upstream response; retained OpenCode qualification blocked (sqlite_source_unavailable); preserve the store")), Some("sqlite_source_unavailable"));
        assert_eq!(preflight_diagnostic_repair(None), None);
    }

    #[test]
    fn recovery_activation_diagnostic_links_generic_block_to_exact_failure() {
        let soul_id = SoulId::new();
        let prior = IncarnationId::new();
        let replacement = IncarnationId::new();
        let attempt = RecoveryAttemptId::new();
        let error = RuntimeError::new(
            RuntimeErrorCode::HostUnreachable,
            "prepare provider bootstrap: operation not permitted",
        );

        let data = recovery_activation_failure_data(
            &soul_id,
            &prior,
            &replacement,
            &attempt,
            RecoveryPath::NativeResume,
            RecoveryBlockReason::ProviderUnavailable,
            &error,
        );

        assert_eq!(data["soulId"], soul_id.as_str());
        assert_eq!(data["priorIncarnationId"], prior.as_str());
        assert_eq!(data["replacementIncarnationId"], replacement.as_str());
        assert_eq!(data["attemptId"], attempt.as_str());
        assert_eq!(data["path"], "native_resume");
        assert_eq!(data["blockReason"], "PROVIDER_UNAVAILABLE");
        assert_eq!(data["errorCode"], "HOST_UNREACHABLE");
        assert_eq!(data["errorClass"], "provider_activation_failed");
        assert_eq!(data["severity"], "warn");
        assert!(!data.to_string().contains("operation not permitted"));
    }

    #[test]
    fn loss_evidence_persists_only_structured_codes_and_transient_digests() {
        let synthetic = vec![
            "synthetic native transcript text".to_string(),
            "Bearer abcdefghijklmnop".to_string(),
        ];
        let (reason, refs) = normalized_negative_evidence(
            RecoveryPath::NativeResume,
            EvidenceStoreState::Missing,
            &synthetic,
        );
        let encoded = serde_json::to_string(&(reason, refs)).unwrap();
        assert!(encoded.contains("native_resume_definitive_negative_missing"));
        assert!(encoded.contains("transientEvidenceDigest=sha256:"));
        assert!(!encoded.contains("synthetic native transcript text"));
        assert!(!encoded.contains("abcdefghijklmnop"));
    }

    #[test]
    fn late_liveness_probe_cancels_loss_certification() {
        let late_live = RecoveryProbe::ReattachReady {
            handle: ReattachHandle {
                incarnation_id: IncarnationId::new(),
                host_boot_id: freshell_runtime_protocol::HostBootId::new(),
                container_id: "a".repeat(64),
            },
            protocol_version: CONTROL_PROTOCOL_VERSION,
        };
        assert!(!final_probe_still_allows_loss(&late_live));
        assert!(final_probe_still_allows_loss(
            &RecoveryProbe::DefinitivelyUnavailable {
                negative_paths: Vec::new(),
                path: RecoveryPath::NativeResume,
                reason: "structured-negative".into(),
                evidence: vec!["digest-only".into()],
                store_state: EvidenceStoreState::Missing,
            }
        ));
    }

    #[test]
    fn stale_never_dispatched_snapshot_cannot_seed_a_requested_identity_or_pending_import() {
        assert!(!pristine_seed_is_safe(
            true,
            Some("ses-requested"),
            crate::registry::NativeImportState::NotApplicable,
            false,
        ));
        for state in [
            crate::registry::NativeImportState::Pending,
            crate::registry::NativeImportState::Available,
            crate::registry::NativeImportState::Unresolved,
            crate::registry::NativeImportState::Unreadable,
            crate::registry::NativeImportState::Unsupported,
            crate::registry::NativeImportState::ExpiredStage,
            crate::registry::NativeImportState::Partial,
            crate::registry::NativeImportState::Completed,
            crate::registry::NativeImportState::LegacyUnknown,
        ] {
            assert!(
                !pristine_seed_is_safe(true, None, state, false),
                "{state:?} must not be overwritten by a fresh seed"
            );
        }
        assert!(pristine_seed_is_safe(
            true,
            None,
            crate::registry::NativeImportState::NotApplicable,
            false,
        ));
        assert!(pristine_seed_is_safe(
            true,
            None,
            crate::registry::NativeImportState::Absent,
            true,
        ));
        assert!(!pristine_seed_is_safe(
            true,
            None,
            crate::registry::NativeImportState::Absent,
            false,
        ));
    }

    #[test]
    fn recovery_refreshes_provider_config_from_nondefault_xdg_root() {
        use freshell_runtime_protocol::{ProviderLaunchContext, ProviderPreparation};
        let workspace = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let user_root = home.path().join("custom-xdg/opencode");
        std::fs::create_dir_all(&user_root).unwrap();
        std::fs::write(user_root.join("old.jsonc"), "{}").unwrap();
        let mut context = ProviderLaunchContext {
            prepared_inputs: None,
            preparation: ProviderPreparation::Opencode {
                project_config: vec![],
                tui_config: None,
                tui_source: None,
                inline_config: false,
            },
            mcp_capability: None,
            config: vec![],
        };
        refresh_provider_context_from_user_root(
            &mut context,
            "opencode",
            workspace.path(),
            workspace.path(),
            &user_root,
        );
        assert!(context
            .config
            .iter()
            .any(|reference| reference.relative_path == "old.jsonc"));
        std::fs::remove_file(user_root.join("old.jsonc")).unwrap();
        std::fs::write(user_root.join("new-provider.jsonc"), "{}").unwrap();
        std::fs::write(workspace.path().join("opencode.jsonc"), "{}").unwrap();
        refresh_provider_context_from_user_root(
            &mut context,
            "opencode",
            workspace.path(),
            workspace.path(),
            &user_root,
        );
        assert!(!context
            .config
            .iter()
            .any(|reference| reference.relative_path == "old.jsonc"));
        assert!(context
            .config
            .iter()
            .any(|reference| reference.relative_path == "new-provider.jsonc"));
        assert!(context.config.iter().all(|reference| {
            reference
                .provider_relative_path
                .starts_with(".config/opencode/")
        }));
        let ProviderPreparation::Opencode { project_config, .. } = &context.preparation else {
            panic!("wrong provider")
        };
        assert!(project_config
            .iter()
            .any(|reference| reference.relative_path == "opencode.jsonc"));
    }

    #[test]
    fn exact_replacement_drops_first_boot_sources_and_transfer_but_keeps_launch_identity() {
        let terminal = TerminalLaunchSpec {
            terminal_id: "terminal-exact".into(),
            stream_id: "stream-exact".into(),
            mode: "opencode".into(),
            program: "opencode".into(),
            args: vec!["--model".into(), "free".into()],
            env: std::collections::BTreeMap::new(),
            cwd: "/workspace".into(),
            run_as_uid: 65_534,
            run_as_gid: 0,
            cols: 80,
            rows: 24,
            project_key: "project-exact".into(),
            workspace_path: "/workspace".into(),
            git_common_dir: None,
            create_request_id: Some("create-exact".into()),
            resume_session_id: None,
            provider_model: Some("free".into()),
            provider_reasoning_effort: None,
            provider_sandbox: None,
            provider_permission_mode: None,
            provider_bootstrap_files: vec![freshell_runtime_protocol::ProviderBootstrapFile {
                source_path: "/first-boot/auth.json".into(),
                provider_relative_path: ".local/share/opencode/auth.json".into(),
            }],
            provider_secret_references: Vec::new(),
            provider_launch_context: None,
            opencode_transfer: Some(OpenCodeTransferDescriptor {
                transfer_id: "first-boot-transfer".into(),
                provider: "opencode".into(),
                source_store_id: "source-store".into(),
                root_session_id: "ses_exact".into(),
                source_generation: "generation".into(),
                provider_schema: "opencode-1.18.21".into(),
                source_schema_fingerprint: "schema-fingerprint".into(),
                migration_journal_fingerprint: "migration-fingerprint".into(),
                destination_store_id: "soul-exact".into(),
                destination_database_path: ".local/share/opencode/opencode.db".into(),
                target_image_ref: "sha256:image".into(),
                target_build_receipt: "build-receipt".into(),
                incarnation_id: "first-incarnation".into(),
                manifest_json: "{}".into(),
                files: Vec::new(),
                total_bytes: 0,
                bundle_sha256: "bundle-digest".into(),
            }),
            opencode_transfer_attempt_id: Some("a".repeat(32)),
            opencode_adoption: None,
        };

        let replacement = terminal_without_first_boot_state(Some(terminal.clone())).unwrap();

        assert!(replacement.provider_bootstrap_files.is_empty());
        assert!(replacement.opencode_transfer.is_none());
        assert!(replacement.opencode_transfer_attempt_id.is_none());
        assert_eq!(replacement.terminal_id, terminal.terminal_id);
        assert_eq!(replacement.program, terminal.program);
        assert_eq!(replacement.args, terminal.args);

        let mut replacement = replacement;
        replacement.provider_launch_context =
            Some(freshell_runtime_protocol::ProviderLaunchContext {
                prepared_inputs: None,
                preparation: freshell_runtime_protocol::ProviderPreparation::Opencode {
                    project_config: Vec::new(),
                    tui_config: None,
                    tui_source: None,
                    inline_config: false,
                },
                mcp_capability: Some(freshell_runtime_protocol::McpCapabilityReference {
                    grant_id: "grant-prior".into(),
                    endpoint: "http://host.docker.internal:3001".into(),
                    provider_relative_path: ".freshell/mcp-capability.json".into(),
                    host_gateway_address: None,
                }),
                config: Vec::new(),
            });
        let mut current_context = replacement.provider_launch_context.clone().unwrap();
        current_context.mcp_capability = Some(freshell_runtime_protocol::McpCapabilityReference {
            grant_id: "grant-new".into(),
            endpoint: "http://host.docker.internal:4001".into(),
            provider_relative_path: ".freshell/mcp-capability.json".into(),
            host_gateway_address: None,
        });
        install_prepared_provider_context(
            Some(&mut replacement),
            None,
            freshell_runtime_protocol::PreparedProviderContext {
                provider_launch_context: current_context,
                provider_secret_references: vec![],
            },
        )
        .unwrap();
        let reference = replacement
            .provider_launch_context
            .unwrap()
            .mcp_capability
            .unwrap();
        assert_eq!(reference.grant_id, "grant-new");
        assert_eq!(reference.endpoint, "http://host.docker.internal:4001");
    }
}

#[cfg(test)]
pub(crate) mod automatic_retry_tests {
    use super::*;
    use crate::{backend::*, registry::Registry, service::SupervisorConfig};
    use freshell_runtime_protocol::{
        host_proof, read_frame, write_frame, DockerDaemonId, Envelope, HostBootId, HostReply,
        IncarnationId, RecoveryState, RuntimeLimits,
    };
    use rusqlite::Connection;
    use std::sync::{
        atomic::{AtomicI64, Ordering},
        Mutex,
    };

    // These four subprocess tests are only entered by the documented runtime
    // sandbox. Abrupt exit skips every Rust destructor, including SQLite owners.
    pub(super) fn crash_boundary(point: &str) {
        if std::env::var("FRESHELL_RETRY_TEST_CRASH").ok().as_deref() != Some(point) {
            return;
        }
        assert_eq!(
            std::env::var("FRESHELL_SANDBOX_MODE").as_deref(),
            Ok("runtime-suite")
        );
        assert!(Path::new("/.dockerenv").exists());
        let root = PathBuf::from(std::env::var_os("FRESHELL_RETRY_TEST_ROOT").unwrap());
        std::fs::write(root.join("crash-boundary"), point).unwrap();
        std::process::abort();
    }

    struct BaselineStopReadiness {
        provider_home: PathBuf,
        workspace: PathBuf,
        baseline: OpenCodeAdoptionBaseline,
        pending: tokio::sync::Notify,
        complete: tokio::sync::Notify,
        launch: Mutex<Option<freshell_runtime_protocol::NativeIdentityLaunch>>,
    }

    struct RetryBackend {
        root: PathBuf,
        clock: Arc<AtomicI64>,
        hosts: Mutex<Vec<(PathBuf, tokio::task::JoinHandle<()>)>>,
        baseline_stop: Option<Arc<BaselineStopReadiness>>,
    }
    impl Drop for RetryBackend {
        fn drop(&mut self) {
            for (_, task) in self.hosts.get_mut().unwrap().drain(..) {
                task.abort();
            }
        }
    }
    impl RetryBackend {
        fn new(root: &Path, clock: Arc<AtomicI64>) -> Self {
            Self {
                root: root.into(),
                clock,
                hosts: Mutex::new(vec![]),
                baseline_stop: None,
            }
        }
        fn record(&self, name: &str, value: &str) {
            Self::record_at(&self.root, name, value);
        }
        fn record_at(root: &Path, name: &str, value: &str) {
            use std::io::Write;
            writeln!(
                std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(root.join(name))
                    .unwrap(),
                "{value}"
            )
            .unwrap();
        }
        fn count(&self, name: &str) -> usize {
            std::fs::read_to_string(self.root.join(name))
                .unwrap_or_default()
                .lines()
                .count()
        }
        fn state(&self, handle: &OwnedRuntimeHandle) -> BackendRuntimeState {
            let object = handle.runtime_dir().join("fixture-object");
            if !object.exists() {
                return BackendRuntimeState::Missing;
            }
            assert_eq!(
                std::fs::read_to_string(object).unwrap(),
                handle.container_id()
            );
            if handle.runtime_dir().join("fixture-stopped").exists() {
                BackendRuntimeState::Exited
            } else if handle.runtime_dir().join("fixture-started").exists() {
                BackendRuntimeState::Running
            } else {
                BackendRuntimeState::Created
            }
        }
        fn unavailable(&self, unavailable: bool) {
            let path = self.root.join("backend-unavailable");
            if unavailable {
                std::fs::write(path, b"unavailable").unwrap();
            } else if path.exists() {
                std::fs::remove_file(path).unwrap();
            }
        }
        fn reader_failure(&self, name: &str) -> Option<BackendError> {
            let value = std::fs::read_to_string(self.root.join(name)).ok()?;
            Some(match value.as_str() {
                "ownership" => BackendError::OwnershipMismatch("reader owner mismatch".into()),
                "policy" => BackendError::PolicyMismatch("reader policy mismatch".into()),
                "malformed" => BackendError::Malformed("invalid reader evidence".into()),
                _ => BackendError::DockerHttp {
                    status: value.parse().unwrap(),
                    body: "fictional reader HTTP failure".into(),
                },
            })
        }
        async fn host(&self, handle: &OwnedRuntimeHandle) {
            let runtime = handle.runtime_dir().to_path_buf();
            let mut hosts = self.hosts.lock().unwrap();
            if hosts.iter().any(|(path, _)| path == &runtime) {
                return;
            }
            let socket = runtime.join("host.sock");
            if socket.exists() {
                std::fs::remove_file(&socket).unwrap();
            }
            let listener = tokio::net::UnixListener::bind(socket).unwrap();
            let secret = std::fs::read(runtime.join("secret")).unwrap();
            let limits = handle.requested_limits();
            let boot_path = runtime.join("fixture-boot");
            let boot = if boot_path.exists() {
                HostBootId::parse(std::fs::read_to_string(&boot_path).unwrap()).unwrap()
            } else {
                let boot = HostBootId::new();
                std::fs::write(boot_path, boot.as_str()).unwrap();
                boot
            };
            let generation_path = runtime.join("fixture-generation");
            let native_launch_path = runtime.join("native-launch.json");
            let provider_home = self.root.join("provider");
            let amplifier_file =
                provider_home.join(".amplifier/projects/fixture/sessions/retry-root/metadata.json");
            let amplifier = amplifier_file.exists();
            let native_file = if amplifier {
                amplifier_file
            } else {
                provider_home.join(".codex/sessions/rollout-retry-root.jsonl")
            };
            let retained_observation = runtime.join("retained-opencode-observation.json");
            let retained_blocker = runtime.join("retained-store-unreadable");
            let retained_probe_failure = runtime.join("retained-probe-unreachable");
            let retained_post_read_failure = runtime.join("retained-fault-after-ready");
            let worker_exited = runtime.join("retained-worker-exited");
            let retained_provider = self.root.join("native-reader-fixture").exists()
                && (handle
                    .terminal()
                    .is_some_and(|terminal| terminal.mode == "opencode")
                    || handle.fresh_agent().is_some_and(|agent| {
                        agent.provider == freshell_runtime_protocol::FreshProvider::Opencode
                    }));
            let fresh_provider = handle.fresh_agent().is_some();
            let native_required =
                native_file.exists() || retained_observation.exists() || retained_provider;
            let final_identity_path = runtime.join("final-wrong-identity");
            let baseline_stop = self.baseline_stop.clone();
            let terminal = handle.terminal().cloned();
            let host_incarnation = handle.incarnation_id().clone();
            let facts_root = self.root.clone();
            let task = tokio::spawn(async move {
                loop {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let request: Envelope<HostCommand> = read_frame(&mut socket).await.unwrap();
                    if (retained_observation.exists()
                        || baseline_stop.is_some()
                        || worker_exited.exists())
                        && !matches!(&request.body, HostCommand::Hello { .. })
                    {
                        assert_eq!(
                            request.auth,
                            Some(host_proof(
                                &secret,
                                "command-auth",
                                &boot,
                                &host_incarnation
                            ))
                        );
                    }
                    let generation: u64 = std::fs::read_to_string(&generation_path)
                        .unwrap_or_else(|_| "0".into())
                        .parse()
                        .unwrap();
                    if let Some(readiness) = &baseline_stop {
                        let result = match request.body {
                            HostCommand::Hello {
                                incarnation_id,
                                challenge,
                            } => HostResult::Hello {
                                proof: host_proof(&secret, &challenge, &boot, &incarnation_id),
                                host_boot_id: boot.clone(),
                                capabilities: vec!["native-identity-observation-v1".into()],
                                effective_limits: limits,
                            },
                            HostCommand::GrantExecution {
                                execution_generation,
                                resume_spec,
                                native_identity_launch,
                                ..
                            } => {
                                use freshell_agent_runtime::opencode_transfer::{
                                    verify_installed_store, InstalledStoreReaderContext,
                                };
                                let spec = resume_spec.unwrap();
                                assert_eq!(
                                    spec.opencode_adoption_baseline,
                                    Some(readiness.baseline.clone())
                                );
                                assert_eq!(
                                    spec.provider_session.native_session_id,
                                    readiness.baseline.descriptor.root_session_id
                                );
                                let terminal = terminal.as_ref().unwrap();
                                assert!(terminal.opencode_transfer.is_none());
                                let home = &readiness.provider_home;
                                let receipt = verify_installed_store(
                                    &readiness.baseline.descriptor,
                                    &InstalledStoreReaderContext {
                                        database_path: &home
                                            .join(".local/share/opencode/opencode.db"),
                                        workspace_root: &readiness.workspace,
                                        provider_uid: terminal.run_as_uid,
                                        provider_gid: terminal.run_as_gid,
                                        home,
                                        xdg_data_home: &home.join(".local/share"),
                                        xdg_config_home: &home.join(".config"),
                                        cwd: &readiness.workspace,
                                    },
                                )
                                .unwrap();
                                assert!(receipt.row_count > 0);
                                RetryBackend::record_at(
                                    &facts_root,
                                    "baseline-current-reads",
                                    &serde_json::to_string(&receipt).unwrap(),
                                );
                                RetryBackend::record_at(
                                    &facts_root,
                                    "baseline-grants",
                                    &execution_generation.to_string(),
                                );
                                std::fs::write(&generation_path, execution_generation.to_string())
                                    .unwrap();
                                *readiness.launch.lock().unwrap() =
                                    Some(native_identity_launch.unwrap());
                                HostResult::GrantAccepted {
                                    host_boot_id: boot.clone(), worker_pid: 42, worker_launch_count: 1,
                                    fixture_evidence: serde_json::json!({}), native_session_id: None,
                                    native_identity_observation: None, opencode_transfer_receipt: None,
                                    opencode_adoption: freshell_runtime_protocol::OpenCodeAdoptionStatus::AwaitingObservation,
                                }
                            }
                            HostCommand::Status { .. } => {
                                readiness.pending.notify_one();
                                readiness.complete.notified().await;
                                let launch = readiness.launch.lock().unwrap().clone().unwrap();
                                assert_eq!(launch.execution_generation, generation);
                                assert_eq!(launch.incarnation_id, host_incarnation);
                                assert_eq!(
                                    launch.requested_native_session_id.as_deref(),
                                    Some(readiness.baseline.descriptor.root_session_id.as_str())
                                );
                                let observation = freshell_runtime_protocol::NativeIdentityObservation {
                                    native_session_id: readiness.baseline.descriptor.root_session_id.clone(),
                                    incarnation_id: launch.incarnation_id, launch_nonce: launch.launch_nonce,
                                    evidence_revision: launch.evidence_revision,
                                    source: freshell_runtime_protocol::NativeIdentitySource::OpencodeTui,
                                    evidence_digest: format!("{:x}", Sha256::digest(std::fs::read(facts_root.join("baseline-current-reads")).unwrap())),
                                };
                                RetryBackend::record_at(
                                    &facts_root,
                                    "baseline-late-observations",
                                    &serde_json::to_string(&observation).unwrap(),
                                );
                                HostResult::Status {
                                    host_boot_id: boot.clone(),
                                    worker_pid: Some(42),
                                    worker_launch_count: 1,
                                    max_control_epoch: 1,
                                    max_execution_generation: generation,
                                    fixture_evidence: serde_json::json!({}),
                                    exited: false,
                                    native_session_id: Some(observation.native_session_id.clone()),
                                    native_identity_observation: Some(observation),
                                    opencode_transfer_receipt: None,
                                    opencode_adoption: Default::default(),
                                }
                            }
                            HostCommand::Stop { .. } => {
                                RetryBackend::record_at(
                                    &facts_root,
                                    "baseline-host-stops",
                                    host_incarnation.as_str(),
                                );
                                HostResult::Stopped
                            }
                            other => {
                                panic!("cancelled baseline Resume cannot send more work: {other:?}")
                            }
                        };
                        write_frame(
                            &mut socket,
                            &HostReply {
                                request_id: request.request_id,
                                result: Ok(result),
                            },
                        )
                        .await
                        .unwrap();
                        continue;
                    }
                    let result = match request.body {
                        HostCommand::Hello {
                            incarnation_id,
                            challenge,
                        } => HostResult::Hello {
                            proof: host_proof(&secret, &challenge, &boot, &incarnation_id),
                            host_boot_id: boot.clone(),
                            capabilities: if native_required {
                                vec![
                                    "native-identity-observation-v1".into(),
                                    "owned-provider-config-v1".into(),
                                    "provider-store-probe-v1".into(),
                                ]
                            } else {
                                vec![]
                            },
                            effective_limits: limits,
                        },
                        HostCommand::GrantExecution {
                            execution_generation,
                            resume_spec,
                            native_identity_launch,
                            ..
                        } => {
                            if retained_observation.exists() {
                                RetryBackend::record_at(
                                    &facts_root,
                                    "retained-grants",
                                    host_incarnation.as_str(),
                                );
                            }
                            assert_eq!(
                                resume_spec.unwrap().provider_session.native_session_id,
                                "retry-root"
                            );
                            std::fs::write(&generation_path, execution_generation.to_string())
                                .unwrap();
                            if native_required {
                                std::fs::write(
                                    &native_launch_path,
                                    serde_json::to_vec(&native_identity_launch.unwrap()).unwrap(),
                                )
                                .unwrap();
                            }
                            HostResult::GrantAccepted {
                                host_boot_id: boot.clone(),
                                worker_pid: 42,
                                worker_launch_count: 1,
                                fixture_evidence: serde_json::json!({}),
                                native_session_id: Some("retry-root".into()),
                                native_identity_observation: None,
                                opencode_transfer_receipt: None,
                                opencode_adoption: Default::default(),
                            }
                        }
                        HostCommand::Status { .. } => {
                            let observation = if retained_observation.exists() {
                                Some(
                                    serde_json::from_slice::<
                                        freshell_runtime_protocol::NativeIdentityObservation,
                                    >(
                                        &std::fs::read(&retained_observation).unwrap()
                                    )
                                    .unwrap(),
                                )
                            } else {
                                native_required.then(|| {
                                let launch: freshell_runtime_protocol::NativeIdentityLaunch = serde_json::from_slice(&std::fs::read(&native_launch_path).unwrap()).unwrap();
                                if retained_provider {
                                    return freshell_runtime_protocol::NativeIdentityObservation {
                                        native_session_id: "retry-root".into(),
                                        incarnation_id: launch.incarnation_id,
                                        launch_nonce: launch.launch_nonce,
                                        evidence_revision: launch.evidence_revision,
                                        source: if fresh_provider {
                                            freshell_runtime_protocol::NativeIdentitySource::FreshProviderHandshake
                                        } else {
                                            freshell_runtime_protocol::NativeIdentitySource::OpencodeTui
                                        },
                                        evidence_digest: "b".repeat(64),
                                    };
                                }
                                let record: serde_json::Value = serde_json::from_slice(&std::fs::read(&native_file).unwrap()).unwrap();
                                freshell_runtime_protocol::NativeIdentityObservation {
                                    native_session_id: if final_identity_path.exists() { "wrong-root".into() } else if amplifier { record["session_id"].as_str().unwrap().into() } else { record["payload"]["id"].as_str().unwrap().into() },
                                    incarnation_id: launch.incarnation_id,
                                    launch_nonce: launch.launch_nonce,
                                    evidence_revision: launch.evidence_revision,
                                    source: if amplifier { freshell_runtime_protocol::NativeIdentitySource::AmplifierNativeLoadedContext } else { freshell_runtime_protocol::NativeIdentitySource::FreshProviderHandshake },
                                    evidence_digest: format!("{:x}", Sha256::digest(std::fs::read(&native_file).unwrap())),
                                }
                            })
                            };
                            HostResult::Status {
                                host_boot_id: boot.clone(),
                                worker_pid: Some(42),
                                worker_launch_count: 1,
                                max_control_epoch: 1,
                                max_execution_generation: generation,
                                fixture_evidence: serde_json::json!({}),
                                exited: worker_exited.exists(),
                                native_session_id: observation
                                    .as_ref()
                                    .map(|observation| observation.native_session_id.clone())
                                    .or_else(|| Some("retry-root".into())),
                                native_identity_observation: observation,
                                opencode_transfer_receipt: None,
                                opencode_adoption: Default::default(),
                            }
                        }
                        HostCommand::ProbeRecovery {
                            resume_spec,
                            incarnation_id,
                            run_as_uid,
                            run_as_gid,
                            ..
                        } => {
                            let spec = resume_spec.unwrap();
                            if retained_observation.exists() {
                                assert_eq!((run_as_uid, run_as_gid), (65534, 0));
                                assert_eq!(incarnation_id, host_incarnation);
                                assert_eq!(spec.provider_session.provider, "opencode");
                                assert_eq!(spec.provider_session.native_session_id, "retry-root");
                                RetryBackend::record_at(
                                    &facts_root,
                                    "retained-probes",
                                    host_incarnation.as_str(),
                                );
                                if retained_probe_failure.exists() {
                                    write_frame(
                                        &mut socket,
                                        &HostReply {
                                            request_id: request.request_id,
                                            result: Err(RuntimeError::new(
                                                RuntimeErrorCode::HostUnreachable,
                                                "retained probe transport unavailable",
                                            )),
                                        },
                                    )
                                    .await
                                    .unwrap();
                                    continue;
                                }
                            }
                            if native_file.exists()
                                || provider_home.join("native-session-state.json").exists()
                            {
                                assert!(matches!(
                                    freshell_agent_runtime::probe_provider_store(
                                        &provider_home,
                                        &spec
                                    ),
                                    freshell_agent_runtime::ProviderStoreProbe::Ready { .. }
                                ));
                            }
                            let probe = if retained_blocker.exists() {
                                blocked(
                                    RecoveryPath::NativeResume,
                                    RecoveryBlockReason::StoreUnreadable,
                                    "repair the soul-local OpenCode database",
                                    Some(2_000),
                                )
                            } else {
                                if retained_post_read_failure.exists() {
                                    std::fs::write(&retained_blocker, b"changed after preflight")
                                        .unwrap();
                                }
                                RecoveryProbe::ResumeReady {
                                    evidence_revision: spec.evidence_revision,
                                    resume_spec: spec,
                                }
                            };
                            HostResult::RecoveryProbe(probe)
                        }
                        HostCommand::Stop { .. } => {
                            if retained_observation.exists() {
                                RetryBackend::record_at(
                                    &facts_root,
                                    "retained-stops",
                                    host_incarnation.as_str(),
                                );
                            }
                            HostResult::Stopped
                        }
                        other => panic!("unexpected retry fixture command: {other:?}"),
                    };
                    write_frame(
                        &mut socket,
                        &HostReply {
                            request_id: request.request_id,
                            result: Ok(result),
                        },
                    )
                    .await
                    .unwrap();
                }
            });
            hosts.push((runtime, task));
        }
    }
    #[async_trait::async_trait]
    impl RuntimeBackend for RetryBackend {
        async fn read_native_census(
            &self,
            handle: &OwnedRuntimeHandle,
            spec: &freshell_runtime_protocol::ResumeSpec,
            reader_binary: &Path,
            image_ref: &str,
        ) -> Result<freshell_agent_runtime::ProviderStoreProbe, BackendError> {
            // Test-only volume transport; execute the real bounded provider
            // parser against this test's fictional native store.
            assert_eq!(
                spec.provider_session.provider_store_id,
                handle.provider_store_id()
            );
            assert_eq!(
                spec.provider_volume.as_ref().unwrap().volume_name,
                handle.provider_volume_name()
            );
            assert_eq!(reader_binary, std::env::current_exe().unwrap());
            assert_eq!(image_ref, format!("sha256:{}", "a".repeat(64)));
            assert_eq!(
                handle
                    .terminal()
                    .map(|t| (t.run_as_uid, t.run_as_gid))
                    .or_else(|| handle.fresh_agent().map(|a| (a.run_as_uid, a.run_as_gid))),
                Some((65534, 0))
            );
            self.record("native-census", handle.incarnation_id().as_str());
            if let Some(error) = self.reader_failure("native-reader-failure") {
                return Err(error);
            }
            if self.root.join("census-unavailable").exists() {
                return Err(BackendError::Unavailable(
                    "fictional reader unavailable".into(),
                ));
            }
            let result =
                freshell_agent_runtime::probe_provider_store(&self.root.join("provider"), spec);
            if self.root.join("census-stale-fence").exists() {
                Connection::open(self.root.join("registry/runtime.sqlite3"))
                    .unwrap()
                    .execute(
                        "UPDATE souls SET evidence_revision=evidence_revision+1 WHERE soul_id=?1",
                        [handle.soul_id().as_str()],
                    )
                    .unwrap();
            }
            Ok(result)
        }
        async fn qualify_retained_opencode(
            &self,
            handle: &OwnedRuntimeHandle,
            request: &freshell_runtime_protocol::RetainedStoreCompatibilityRequest,
            _: &Path,
        ) -> Result<freshell_runtime_protocol::RetainedStoreCompatibilityReceipt, BackendError>
        {
            if !self.root.join("native-reader-fixture").exists() {
                return Err(BackendError::Unavailable(
                    "current-image retained-store qualification is unavailable".into(),
                ));
            }
            self.record("retained-qualifications", handle.incarnation_id().as_str());
            assert_eq!(request.provider_store_id, handle.provider_store_id());
            assert_eq!(request.native_session_id, "retry-root");
            if let Some(error) = self.reader_failure("native-reader-failure") {
                return Err(error);
            }
            // This backend exercises transport and supervisor scheduling, not
            // native qualification; the real reader has separate store tests.
            Ok(
                freshell_runtime_protocol::RetainedStoreCompatibilityReceipt {
                    request: request.clone(),
                    provider_version: "1.18.21".into(),
                    source_schema_fingerprint: "c".repeat(64),
                    migration_journal_fingerprint: "d".repeat(64),
                    generation: "e".repeat(64),
                    row_count: 1,
                },
            )
        }
        async fn inspect(
            &self,
            handle: &OwnedRuntimeHandle,
        ) -> Result<BackendInspection, BackendError> {
            self.record("inspects", handle.incarnation_id().as_str());
            if self.root.join("backend-unavailable").exists() {
                return Err(BackendError::Unavailable("test backend offline".into()));
            }
            if let Ok(failure) = std::fs::read_to_string(self.root.join("final-inspection-failure"))
            {
                let activated: bool = Connection::open(self.root.join("registry/runtime.sqlite3")).unwrap().query_row(
                    "SELECT launch_state='running' AND native_identity_observation IS NOT NULL FROM incarnations WHERE incarnation_id=?1",
                    [handle.incarnation_id().as_str()], |row| row.get(0),
                ).unwrap();
                if activated {
                    self.record("final-inspection", handle.incarnation_id().as_str());
                    self.clock.store(750, Ordering::SeqCst);
                    if failure == "transient" {
                        return Err(BackendError::Unavailable(
                            "final native inspection temporarily unavailable".into(),
                        ));
                    }
                    std::fs::write(
                        handle.runtime_dir().join("final-wrong-identity"),
                        b"wrong-root",
                    )
                    .unwrap();
                }
            }
            let state = self.state(handle);
            if state == BackendRuntimeState::Running {
                self.host(handle).await;
            }
            Ok(BackendInspection {
                state,
                configured_limits: handle.requested_limits(),
            })
        }
        async fn create_stopped(
            &self,
            spec: &CreateRuntimeSpec,
        ) -> Result<BackendCreated, BackendError> {
            if let Ok(kind) = std::fs::read_to_string(self.root.join("create-failure")) {
                return Err(match kind.as_str() {
                    "transient" => BackendError::Unavailable("temporary dependency".into()),
                    "ownership" => BackendError::OwnershipMismatch("temporary dependency".into()),
                    "policy" => BackendError::PolicyMismatch("temporary dependency".into()),
                    "malformed" => BackendError::Malformed("temporary dependency".into()),
                    _ => BackendError::InvalidConfig("temporary dependency".into()),
                });
            }
            let container = format!("retry-container-{}", spec.incarnation_id);
            self.record("creates", &container);
            std::fs::write(spec.runtime_dir.join("fixture-object"), &container).unwrap();
            Ok(BackendCreated {
                daemon_id: DockerDaemonId::parse("retry-daemon").unwrap(),
                container_id: container,
                immutable_config_digest: "retry-fixture".into(),
            })
        }
        async fn start_host(&self, handle: &OwnedRuntimeHandle) -> Result<(), BackendError> {
            if self.baseline_stop.is_some() {
                self.record("baseline-host-starts", handle.incarnation_id().as_str());
            }
            std::fs::write(handle.runtime_dir().join("fixture-started"), b"started").unwrap();
            self.host(handle).await;
            Ok(())
        }
        async fn request_stop(
            &self,
            handle: &OwnedRuntimeHandle,
            _: u64,
        ) -> Result<(), BackendError> {
            // Like Docker, no-op Stop on a never-started enclosure leaves it
            // Created. Inspection must not silently start its host either.
            if handle.runtime_dir().join("fixture-started").exists() {
                std::fs::write(handle.runtime_dir().join("fixture-stopped"), b"stopped").unwrap();
            }
            Ok(())
        }
        async fn force_stop(&self, handle: &OwnedRuntimeHandle) -> Result<(), BackendError> {
            self.request_stop(handle, 0).await
        }
        async fn verify_empty(&self, handle: &OwnedRuntimeHandle) -> Result<bool, BackendError> {
            Ok(matches!(
                self.state(handle),
                BackendRuntimeState::Missing
                    | BackendRuntimeState::Created
                    | BackendRuntimeState::Exited
            ))
        }
        async fn read_limits(
            &self,
            handle: &OwnedRuntimeHandle,
        ) -> Result<RuntimeLimits, BackendError> {
            Ok(handle.requested_limits())
        }
        async fn enable_long_lived(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
            Ok(())
        }
        async fn list_known(
            &self,
            handles: &[OwnedRuntimeHandle],
        ) -> Result<Vec<(IncarnationId, BackendInspection)>, BackendError> {
            let mut result = vec![];
            for handle in handles {
                result.push((handle.incarnation_id().clone(), self.inspect(handle).await?));
            }
            Ok(result)
        }
    }

    fn open(root: &Path, now: i64) -> (Supervisor, Arc<RetryBackend>, Arc<AtomicI64>) {
        let mut registry = Registry::open(root.join("registry"), None).unwrap();
        let clock = Arc::new(AtomicI64::new(now));
        registry.retry_clock = Some(clock.clone());
        let backend = Arc::new(RetryBackend::new(root, clock.clone()));
        let supervisor = Supervisor::new(
            registry,
            backend.clone(),
            SupervisorConfig {
                runtime_root: root.join("runtime"),
                control_socket_path: root.join("control.sock"),
                host_binary_path: std::env::current_exe().unwrap(),
                image_ref: format!("sha256:{}", "a".repeat(64)),
                test_run_id: "automatic-retry".into(),
                control_secret: "synthetic-secret".into(),
                lifecycle_log: root.join("lifecycle.jsonl"),
                admission: crate::admission::AdmissionPolicy::default(),
            },
        )
        .unwrap();
        (supervisor, backend, clock)
    }
    async fn seed(supervisor: &Supervisor) -> SoulId {
        let soul = SoulId::new();
        let prepared =
            crate::registry::tests::materialize_test_runtime(&supervisor.registry, soul.clone())
                .await;
        let conn = Connection::open(supervisor.registry.database_path()).unwrap();
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
        supervisor
            .registry
            .record_native_session(soul.clone(), prepared.incarnation_id, "retry-root".into())
            .await
            .unwrap();
        let context = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        let spec = resume_catalog::exact_resume_candidate(&context, None)
            .unwrap()
            .unwrap();
        supervisor
            .registry
            .store_verified_resume_spec(soul.clone(), spec)
            .await
            .unwrap();
        soul
    }
    fn seed_native<'a>(
        supervisor: &'a Supervisor,
        root: &'a Path,
    ) -> impl std::future::Future<Output = SoulId> + Send + 'a {
        // Keep the common native fixture's nested launch future off callers'
        // default stacks, including the multi-reopen retry scenarios.
        Box::pin(async move {
            let soul = seed(supervisor).await;
            let context = supervisor
                .registry
                .recovery_context(soul.clone())
                .await
                .unwrap();
            let provider_home = root.join("provider");
            std::fs::create_dir_all(provider_home.join(".codex/sessions")).unwrap();
            std::fs::write(
                provider_home.join(".codex/sessions/rollout-retry-root.jsonl"),
                b"{\"type\":\"session_meta\",\"payload\":{\"id\":\"retry-root\"}}\n",
            )
            .unwrap();
            let agent: freshell_runtime_protocol::FreshAgentLaunchSpec = serde_json::from_value(serde_json::json!({
            "sessionId":"retry-fresh-codex", "provider":"codex", "sessionType":"freshcodex", "runtimeVariant":"codex-app-server-v1",
            "providerStoreId":context.provider_store_id, "cwd":root, "workspacePath":root,
            "runAsUid":65534, "runAsGid":0
        })).unwrap();
            agent.validate().unwrap();
            let conn = Connection::open(supervisor.registry.database_path()).unwrap();
            conn.execute(
                "UPDATE souls SET provider='codex',resume_spec=NULL WHERE soul_id=?1",
                [soul.as_str()],
            )
            .unwrap();
            conn.execute(
            "UPDATE incarnations SET fixture_kind=NULL,fresh_agent_spec=?1 WHERE incarnation_id=?2",
            rusqlite::params![
                serde_json::to_string(&agent).unwrap(),
                context.prior_handle.incarnation_id().as_str()
            ],
        )
        .unwrap();
            let context = supervisor
                .registry
                .recovery_context(soul.clone())
                .await
                .unwrap();
            let spec = resume_catalog::exact_resume_candidate(&context, None)
                .unwrap()
                .unwrap();
            assert!(matches!(
                freshell_agent_runtime::probe_provider_store(&provider_home, &spec),
                freshell_agent_runtime::ProviderStoreProbe::Ready { .. }
            ));
            supervisor
                .registry
                .store_verified_resume_spec(soul.clone(), spec)
                .await
                .unwrap();
            soul
        })
    }
    async fn seed_offline_amplifier(supervisor: &Supervisor, root: &Path) -> SoulId {
        let soul = seed(supervisor).await;
        let context = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        let runtime = root.join("retained-amplifier");
        std::fs::create_dir_all(&runtime).unwrap();
        std::fs::write(runtime.join("secret"), b"synthetic-secret").unwrap();
        std::fs::write(
            runtime.join("fixture-object"),
            context.prior_handle.container_id(),
        )
        .unwrap();
        std::fs::write(runtime.join("fixture-started"), b"started").unwrap();
        std::fs::write(runtime.join("fixture-stopped"), b"exited").unwrap();
        let terminal: TerminalLaunchSpec = serde_json::from_value(serde_json::json!({
            "terminalId":"ordinary-amplifier", "streamId":"amplifier-stream", "mode":"amplifier",
            "program":"amplifier", "cwd":root, "workspacePath":root, "projectKey":"fixture-project",
            "env":{"HOME":"/home/freshell/provider", "AMPLIFIER_HOME":"/home/freshell/provider/.amplifier"},
            "runAsUid":65534, "runAsGid":0, "cols":80, "rows":24
        })).unwrap();
        terminal.validate().unwrap();
        let conn = Connection::open(supervisor.registry.database_path()).unwrap();
        conn.execute("UPDATE souls SET provider='amplifier',resume_spec=NULL,allocation_state='materializing',durability_state='live_only',evidence_revision=0 WHERE soul_id=?1", [soul.as_str()]).unwrap();
        conn.execute(
            "UPDATE writer_claims SET provider='amplifier' WHERE soul_id=?1",
            [soul.as_str()],
        )
        .unwrap();
        conn.execute("UPDATE incarnations SET fixture_kind=NULL,terminal_spec=?1,runtime_dir=?2,execution_generation=1 WHERE incarnation_id=?3",
            rusqlite::params![serde_json::to_string(&terminal).unwrap(), runtime.to_str().unwrap(), context.prior_handle.incarnation_id().as_str()]).unwrap();
        drop(conn);
        let store = root.join("provider/.amplifier/projects/fixture/sessions/retry-root");
        std::fs::create_dir_all(&store).unwrap();
        std::fs::write(store.join("metadata.json"), serde_json::to_vec(&serde_json::json!({
            "session_id":"retry-root", "created":"2026-10-10T00:00:00Z", "working_dir":root, "turn_count":1
        })).unwrap()).unwrap();
        std::fs::write(
            store.join("metadata.json.backup"),
            b"{\"session_id\":\"retry-root\"}",
        )
        .unwrap();
        std::fs::write(store.join("transcript.jsonl.backup"), b"").unwrap();
        std::fs::write(store.join("transcript.jsonl"), b"{\"role\":\"user\",\"content\":\"fictional seed\"}\n{\"role\":\"assistant\",\"content\":\"fictional stored reply\"}\n").unwrap();
        std::fs::write(store.join("events.jsonl"), b"{\"event\":\"prompt:complete\",\"session_id\":\"retry-root\"}\n{\"event\":\"cleanup:store_end\",\"session_id\":\"retry-root\"}\n").unwrap();
        let context = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        let launch = freshell_runtime_protocol::NativeIdentityLaunch {
            incarnation_id: context.prior_handle.incarnation_id().clone(),
            launch_nonce: context.prior_handle.launch_nonce().as_str().into(),
            evidence_revision: context.evidence_revision,
            execution_generation: 1,
            requested_native_session_id: None,
        };
        supervisor
            .registry
            .bind_native_identity_launch(launch.clone())
            .await
            .unwrap();
        supervisor.registry.record_native_identity_observation(soul.clone(), freshell_runtime_protocol::NativeIdentityObservation {
            native_session_id: "retry-root".into(), incarnation_id: launch.incarnation_id,
            launch_nonce: launch.launch_nonce, evidence_revision: launch.evidence_revision,
            source: freshell_runtime_protocol::NativeIdentitySource::AmplifierNativeLoadedContext,
            evidence_digest: format!("{:x}", Sha256::digest(std::fs::read(store.join("metadata.json")).unwrap())),
        }, context.write_fence()).await.unwrap();
        let spec = resume_catalog::exact_resume_candidate(&context, None)
            .unwrap()
            .unwrap();
        assert!(matches!(
            freshell_agent_runtime::probe_provider_store(&root.join("provider"), &spec),
            freshell_agent_runtime::ProviderStoreProbe::Ready { .. }
        ));
        assert!(context.resume_spec.is_none());
        soul
    }

    fn fictional_amplifier_preparation(
        grant_id: &str,
    ) -> freshell_runtime_protocol::ProviderLaunchContext {
        serde_json::from_value(serde_json::json!({
            "preparation":{"amplifier":{"bundle":"default", "resume_args":[]}},
            "mcpCapability":{"grantId":grant_id, "endpoint":"http://host.docker.internal:9", "providerRelativePath":".freshell/mcp-capability.json"},
            "config":[]
        })).unwrap()
    }

    #[tokio::test]
    async fn offline_amplifier_captures_durable_store_before_exact_replacement() {
        Box::pin(offline_amplifier_capture_case()).await;
    }

    async fn offline_amplifier_capture_case() {
        // Capability-directory configuration is process-global. Keep this
        // wholly fictional replacement protocol isolated from other tests.
        const CHILD: &str = "FRESHELL_OFFLINE_AMPLIFIER_TEST_CHILD";
        let phase = std::env::var(CHILD).unwrap_or_default();
        if !matches!(phase.as_str(), "active" | "retired") {
            for phase in ["active", "retired"] {
                let output = std::process::Command::new("timeout")
                    .arg("60s")
                    .arg(std::env::current_exe().unwrap())
                    .args(["--exact", "recovery::automatic_retry_tests::offline_amplifier_captures_durable_store_before_exact_replacement", "--nocapture"])
                    .env(CHILD, phase)
                    .env_remove("FRESHELL_RUNTIME_CAPABILITY_DIR")
                    .output().unwrap();
                assert!(
                    output.status.success(),
                    "{phase}: {}\n{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            return;
        }
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let root = tempfile::tempdir().unwrap();
        let (supervisor, backend, _) = open(root.path(), 0);
        let soul = Box::pin(seed_offline_amplifier(&supervisor, root.path())).await;
        if phase == "retired" {
            let context = supervisor
                .registry
                .recovery_context(soul.clone())
                .await
                .unwrap();
            supervisor
                .registry
                .mark_stop_outcome(
                    context.prior_handle.incarnation_id().clone(),
                    StopOutcome::VerifiedEmpty,
                )
                .await
                .unwrap();
        }
        std::fs::create_dir(root.path().join("mcp-capabilities")).unwrap();
        std::fs::create_dir_all(root.path().join("provider-roots/grant-offline-fixture")).unwrap();
        crate::backend::docker::configure_capability_dir(&root.path().join("control.sock"))
            .unwrap();
        let before = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        let mut terminal = before.terminal.clone().unwrap();
        let launch_context = fictional_amplifier_preparation("grant-offline-fixture");
        terminal.provider_launch_context = Some(launch_context.clone());
        terminal.validate().unwrap();
        Connection::open(supervisor.registry.database_path())
            .unwrap()
            .execute(
                "UPDATE incarnations SET terminal_spec=?1 WHERE incarnation_id=?2",
                rusqlite::params![
                    serde_json::to_string(&terminal).unwrap(),
                    before.prior_handle.incarnation_id().as_str()
                ],
            )
            .unwrap();
        let listener = tokio::net::UnixListener::bind(root.path().join("mcp.sock")).unwrap();
        let response = serde_json::to_vec(&freshell_runtime_protocol::PreparedProviderContext {
            provider_launch_context: launch_context,
            provider_secret_references: vec![],
        })
        .unwrap();
        let callback = tokio::spawn(async move {
            let mut activated_incarnation = None;
            for action in ["issue", "activate", "commit"] {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = vec![];
                stream.read_to_end(&mut request).await.unwrap();
                let request: serde_json::Value = serde_json::from_slice(&request).unwrap();
                assert_eq!(request["action"], action);
                if action == "issue" {
                    assert_eq!(request["provider"], "amplifier");
                    stream.write_all(&response).await.unwrap();
                } else {
                    assert_eq!(request["grantId"], "grant-offline-fixture");
                    let incarnation = request["incarnationId"].as_str().unwrap();
                    if let Some(activated) = &activated_incarnation {
                        assert_eq!(incarnation, activated);
                    } else {
                        activated_incarnation = Some(incarnation.to_owned());
                    }
                    stream.write_all(b"ok").await.unwrap();
                }
            }
            activated_incarnation.unwrap()
        });
        assert!(before.resume_spec.is_none());
        let result = Box::pin(supervisor.recover(RecoverRequest {
            soul_id: soul.clone(),
            trigger: RecoveryTrigger::ProviderExit,
            expected_intent_revision: Some(before.intent_revision),
            expected_control_epoch: Some(supervisor.registry.control_epoch()),
        }))
        .await
        .unwrap();
        assert_eq!(
            result.outcome,
            RecoveryOutcome::Replaced,
            "probe={:?}",
            result.probe
        );
        let committed_incarnation = tokio::time::timeout(Duration::from_secs(5), callback)
            .await
            .unwrap()
            .unwrap();
        let after = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        assert_eq!(
            after.prior_handle.incarnation_id().as_str(),
            committed_incarnation
        );
        assert!(!supervisor
            .registry
            .provider_preparation_is_pending(after.prior_handle.incarnation_id().clone())
            .await
            .unwrap());
        let saved = after.resume_spec.unwrap();
        assert_eq!(saved.provider_session.native_session_id, "retry-root");
        assert_eq!(
            saved.provider_session.provider_store_id,
            before.provider_store_id
        );
        assert!(saved.evidence_revision > before.evidence_revision);
        assert_eq!(
            saved.allocation_state,
            freshell_runtime_protocol::AllocationState::VerifiedDurable
        );
        assert_ne!(
            after.prior_handle.incarnation_id(),
            before.prior_handle.incarnation_id()
        );
        assert_eq!(
            result.observed_native_session_id.as_deref(),
            Some("retry-root")
        );
        assert_eq!(backend.count("native-census"), 1);
        assert_eq!(backend.count("creates"), 1);
        assert_root_and_successes(&supervisor, &soul, 1).await;
    }

    #[tokio::test]
    async fn offline_amplifier_unverified_stores_cannot_capture_or_replace() {
        for case in [
            "missing_store",
            "missing_history",
            "unreadable",
            "tampered_root",
            "truncated",
            "ambiguous",
            "uninspected_home",
            "reader_unavailable",
            "pristine_stub",
        ] {
            let root = tempfile::tempdir().unwrap();
            let (supervisor, backend, _) = open(root.path(), 0);
            let soul = seed_offline_amplifier(&supervisor, root.path()).await;
            let before = supervisor
                .registry
                .recovery_context(soul.clone())
                .await
                .unwrap();
            let store = root
                .path()
                .join("provider/.amplifier/projects/fixture/sessions/retry-root");
            match case {
                "missing_store" => std::fs::rename(
                    root.path().join("provider/.amplifier"),
                    root.path().join("unmounted-store"),
                )
                .unwrap(),
                "missing_history" => {
                    // No recorded turn, event history or transcript may still
                    // establish materialization independently of the missing
                    // primary file. Empty backup artifacts remain incomplete.
                    std::fs::remove_file(store.join("transcript.jsonl")).unwrap();
                    std::fs::remove_file(store.join("events.jsonl")).unwrap();
                    let mut metadata: serde_json::Value = serde_json::from_slice(
                        &std::fs::read(store.join("metadata.json")).unwrap(),
                    )
                    .unwrap();
                    metadata.as_object_mut().unwrap().remove("turn_count");
                    std::fs::write(
                        store.join("metadata.json"),
                        serde_json::to_vec(&metadata).unwrap(),
                    )
                    .unwrap();
                }
                "unreadable" => {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(
                        store.join("metadata.json"),
                        std::fs::Permissions::from_mode(0o000),
                    )
                    .unwrap();
                }
                "tampered_root" => std::fs::write(
                    store.join("metadata.json"),
                    b"{\"session_id\":\"wrong-root\"}",
                )
                .unwrap(),
                "truncated" => std::fs::write(
                    store.join("events.jsonl"),
                    b"{\"event\":\"cleanup:store_end\",\"session_id\":\"retry-root\"",
                )
                .unwrap(),
                "ambiguous" => std::fs::create_dir_all(
                    root.path()
                        .join("provider/.amplifier/projects/another/sessions/retry-root"),
                )
                .unwrap(),
                "uninspected_home" => {
                    let mut terminal = before.terminal.clone().unwrap();
                    terminal
                        .env
                        .insert("AMPLIFIER_HOME".into(), "/uninspected-home".into());
                    Connection::open(supervisor.registry.database_path())
                        .unwrap()
                        .execute(
                            "UPDATE incarnations SET terminal_spec=?1 WHERE incarnation_id=?2",
                            rusqlite::params![
                                serde_json::to_string(&terminal).unwrap(),
                                before.prior_handle.incarnation_id().as_str()
                            ],
                        )
                        .unwrap();
                }
                "reader_unavailable" => {
                    std::fs::write(root.path().join("census-unavailable"), b"unavailable").unwrap()
                }
                "pristine_stub" => {
                    // A requested/observed identity plus a launcher directory
                    // must never be promoted to durable conversation evidence.
                    std::fs::write(store.join("metadata.json"), b"{\"session_id\":\"retry-root\",\"created\":\"fictional-date\",\"working_dir\":\"/fictional\"}").unwrap();
                    std::fs::write(store.join("transcript.jsonl"), b"").unwrap();
                    std::fs::write(
                        store.join("events.jsonl"),
                        b"{\"event\":\"session:start\",\"session_id\":\"retry-root\"}\n",
                    )
                    .unwrap();
                    std::fs::remove_file(store.join("metadata.json.backup")).unwrap();
                    std::fs::remove_file(store.join("transcript.jsonl.backup")).unwrap();
                }
                _ => unreachable!(),
            }
            let result = supervisor
                .recover(RecoverRequest {
                    soul_id: soul.clone(),
                    trigger: RecoveryTrigger::ProviderExit,
                    expected_intent_revision: Some(before.intent_revision),
                    expected_control_epoch: Some(supervisor.registry.control_epoch()),
                })
                .await
                .unwrap();
            assert_eq!(
                result.outcome,
                RecoveryOutcome::Blocked,
                "{case}: {:?}",
                result.probe
            );
            let after = supervisor.registry.recovery_context(soul).await.unwrap();
            assert!(after.resume_spec.is_none(), "{case}");
            assert_eq!(after.evidence_revision, before.evidence_revision, "{case}");
            assert_eq!(
                after.prior_handle.incarnation_id(),
                before.prior_handle.incarnation_id(),
                "{case}"
            );
            assert_eq!(backend.count("native-census"), 1, "{case}");
            assert_eq!(backend.count("creates"), 0, "{case}");
        }
    }

    #[tokio::test]
    async fn offline_amplifier_stale_capture_fence_cannot_grant_replacement() {
        let root = tempfile::tempdir().unwrap();
        let (supervisor, backend, _) = open(root.path(), 0);
        let soul = seed_offline_amplifier(&supervisor, root.path()).await;
        let before = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        std::fs::write(
            root.path().join("census-stale-fence"),
            b"change during read",
        )
        .unwrap();
        assert!(supervisor.probe_recovery(soul.clone()).await.is_err());
        let after = supervisor.registry.recovery_context(soul).await.unwrap();
        assert!(after.resume_spec.is_none());
        assert_eq!(after.evidence_revision, before.evidence_revision + 1);
        assert_eq!(
            after.prior_handle.incarnation_id(),
            before.prior_handle.incarnation_id()
        );
        assert_eq!(backend.count("native-census"), 1);
        assert_eq!(backend.count("creates"), 0);
    }

    #[tokio::test]
    async fn offline_amplifier_saved_spec_identity_validation_is_preserved() {
        for case in ["valid", "wrong_root", "wrong_store", "wrong_provider"] {
            let root = tempfile::tempdir().unwrap();
            let (supervisor, backend, _) = open(root.path(), 0);
            let soul = seed_offline_amplifier(&supervisor, root.path()).await;
            let before = supervisor
                .registry
                .recovery_context(soul.clone())
                .await
                .unwrap();
            let spec = resume_catalog::exact_resume_candidate(&before, None)
                .unwrap()
                .unwrap();
            let mut saved = supervisor
                .registry
                .store_verified_resume_spec_fenced(soul.clone(), spec, before.write_fence())
                .await
                .unwrap();
            match case {
                "wrong_root" => saved.provider_session.native_session_id = "wrong-root".into(),
                "wrong_store" => saved.provider_session.provider_store_id = "wrong-store".into(),
                "wrong_provider" => saved.provider_session.provider = "codex".into(),
                _ => {}
            }
            Connection::open(supervisor.registry.database_path())
                .unwrap()
                .execute(
                    "UPDATE souls SET resume_spec=?1 WHERE soul_id=?2",
                    rusqlite::params![serde_json::to_string(&saved).unwrap(), soul.as_str()],
                )
                .unwrap();
            let probe = supervisor.probe_recovery(soul.clone()).await.unwrap();
            if case == "valid" {
                assert!(matches!(probe, RecoveryProbe::ResumeReady { .. }));
            } else {
                assert!(
                    matches!(
                        probe,
                        RecoveryProbe::Blocked {
                            reason: RecoveryBlockReason::WrongNativeIdentity,
                            ..
                        }
                    ),
                    "{case}: {probe:?}"
                );
            }
            assert_eq!(backend.count("native-census"), 0, "{case}");
            assert_eq!(backend.count("creates"), 0, "{case}");
            assert_eq!(
                supervisor
                    .registry
                    .recovery_context(soul)
                    .await
                    .unwrap()
                    .resume_spec,
                Some(saved)
            );
        }
    }

    #[tokio::test]
    async fn offline_amplifier_missing_preparation_blocks_after_verified_retirement() {
        for callback_missing in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let (supervisor, backend, _) = open(root.path(), 0);
            let soul = seed_offline_amplifier(&supervisor, root.path()).await;
            let before = supervisor
                .registry
                .recovery_context(soul.clone())
                .await
                .unwrap();
            if callback_missing {
                let mut terminal = before.terminal.clone().unwrap();
                terminal.provider_launch_context =
                    Some(fictional_amplifier_preparation("grant-missing-fictional"));
                terminal.validate().unwrap();
                Connection::open(supervisor.registry.database_path())
                    .unwrap()
                    .execute(
                        "UPDATE incarnations SET terminal_spec=?1 WHERE incarnation_id=?2",
                        rusqlite::params![
                            serde_json::to_string(&terminal).unwrap(),
                            before.prior_handle.incarnation_id().as_str()
                        ],
                    )
                    .unwrap();
            }
            let result = supervisor
                .recover(RecoverRequest {
                    soul_id: soul.clone(),
                    trigger: RecoveryTrigger::ProviderExit,
                    expected_intent_revision: Some(before.intent_revision),
                    expected_control_epoch: Some(supervisor.registry.control_epoch()),
                })
                .await
                .unwrap();
            assert_eq!(result.outcome, RecoveryOutcome::Blocked);
            assert!(matches!(
                result.probe,
                Some(RecoveryProbe::Blocked {
                    reason: RecoveryBlockReason::CapabilityPending,
                    ..
                })
            ));
            let after = supervisor
                .registry
                .recovery_context(soul.clone())
                .await
                .unwrap();
            assert!(after.resume_spec.is_some());
            assert_eq!(
                after.recovery_state,
                freshell_runtime_protocol::RecoveryState::Blocked
            );
            assert_eq!(
                after.prior_handle.incarnation_id(),
                before.prior_handle.incarnation_id()
            );
            let conn = Connection::open(supervisor.registry.database_path()).unwrap();
            let state: (String, String) = conn
                .query_row(
                    "SELECT launch_state,cleanup_state FROM incarnations WHERE incarnation_id=?1",
                    [before.prior_handle.incarnation_id().as_str()],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(state, ("stopped".into(), "verified_empty".into()));
            let claims: u64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM writer_claims WHERE soul_id=?1",
                    [soul.as_str()],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(claims, 0);
            assert_eq!(backend.count("native-census"), 1);
            assert_eq!(backend.count("creates"), 0);
        }
    }

    #[tokio::test]
    async fn offline_amplifier_already_retired_prior_captures_before_missing_preparation_block() {
        let root = tempfile::tempdir().unwrap();
        let (supervisor, backend, _) = open(root.path(), 0);
        let soul = seed_offline_amplifier(&supervisor, root.path()).await;
        let before = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        // Legitimate owned retirement preserves RUNNING intent, but leaves the
        // latest prior row STOPPED and no active writer. This is also the phase
        // used by installed stopped-data repair before explicit Resume.
        assert!(backend.verify_empty(&before.prior_handle).await.unwrap());
        supervisor
            .registry
            .mark_stop_outcome(
                before.prior_handle.incarnation_id().clone(),
                StopOutcome::VerifiedEmpty,
            )
            .await
            .unwrap();
        let result = supervisor
            .recover(RecoverRequest {
                soul_id: soul.clone(),
                trigger: RecoveryTrigger::ProviderExit,
                expected_intent_revision: Some(before.intent_revision),
                expected_control_epoch: Some(supervisor.registry.control_epoch()),
            })
            .await
            .unwrap();
        assert_eq!(result.outcome, RecoveryOutcome::Blocked);
        assert!(matches!(
            result.probe,
            Some(RecoveryProbe::Blocked {
                reason: RecoveryBlockReason::CapabilityPending,
                ..
            })
        ));
        let saved = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap()
            .resume_spec
            .unwrap();
        assert_eq!(saved.provider_session.native_session_id, "retry-root");
        assert_eq!(backend.count("native-census"), 1);
        assert_eq!(backend.count("creates"), 0);
        drop(supervisor);
        drop(backend);
        let (reopened, backend, _) = open(root.path(), 1_000);
        let probe = reopened.probe_recovery(soul.clone()).await.unwrap();
        assert!(
            matches!(probe, RecoveryProbe::ResumeReady { ref resume_spec, .. } if **resume_spec == saved)
        );
        assert_eq!(
            reopened
                .registry
                .recovery_context(soul)
                .await
                .unwrap()
                .resume_spec,
            Some(saved)
        );
        assert_eq!(
            backend.count("native-census"),
            1,
            "re-entry must use the durable saved exact input"
        );
        assert_eq!(backend.count("creates"), 0);
    }

    #[tokio::test]
    async fn offline_amplifier_unknown_identity_cannot_use_unselected_history() {
        let root = tempfile::tempdir().unwrap();
        let (supervisor, backend, _) = open(root.path(), 0);
        let soul = seed_offline_amplifier(&supervisor, root.path()).await;
        let mut context = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        context.native_session_id = None;
        context.never_dispatched = false;
        let mut transient = None;
        let probe = supervisor
            .probe_recovery_context(&mut context, &mut transient)
            .await
            .unwrap();
        assert!(matches!(probe, RecoveryProbe::Blocked { .. }));
        assert_eq!(backend.count("native-census"), 0);
        assert_eq!(backend.count("creates"), 0);
        assert!(supervisor
            .registry
            .recovery_context(soul)
            .await
            .unwrap()
            .resume_spec
            .is_none());
    }

    fn attempts(root: &Path) -> Vec<(String, String)> {
        let conn = Connection::open(root.join("registry/runtime.sqlite3")).unwrap();
        let mut stmt = conn
            .prepare("SELECT attempt_id,verdict FROM recovery_attempts ORDER BY started_at,rowid")
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }
    fn due(root: &Path) -> Option<i64> {
        let conn = Connection::open(root.join("registry/runtime.sqlite3")).unwrap();
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='recovery_retries')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        if !exists {
            return None;
        }
        conn.query_row("SELECT next_due_at_ms FROM recovery_retries", [], |r| {
            r.get(0)
        })
        .unwrap_or(None)
    }
    async fn assert_root_and_successes(supervisor: &Supervisor, soul: &SoulId, successes: u64) {
        let context = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        assert_eq!(context.native_session_id.as_deref(), Some("retry-root"));
        assert_eq!(context.successful_recoveries_in_window, successes);
    }

    async fn seed_retained_opencode(supervisor: &Supervisor, root: &Path) -> SoulId {
        let soul = seed(supervisor).await;
        let context = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        let runtime = root.join("retained");
        std::fs::create_dir_all(&runtime).unwrap();
        std::fs::write(runtime.join("secret"), b"synthetic-secret").unwrap();
        std::fs::write(
            runtime.join("fixture-object"),
            context.prior_handle.container_id(),
        )
        .unwrap();
        std::fs::write(runtime.join("fixture-started"), b"started").unwrap();
        std::fs::write(runtime.join("fixture-generation"), b"1").unwrap();
        let terminal: TerminalLaunchSpec = serde_json::from_value(serde_json::json!({
            "terminalId":"retained-terminal", "streamId":"retained-stream", "mode":"opencode",
            "program":"opencode", "cwd":root, "workspacePath":root, "projectKey":"retained-project",
            "env":{"HOME":"/home/freshell/provider", "XDG_DATA_HOME":"/home/freshell/provider/.local/share", "XDG_CONFIG_HOME":"/home/freshell/provider/.config", "OPENCODE_DB":"/home/freshell/provider/.local/share/opencode/opencode.db"},
            "runAsUid":65534, "runAsGid":0, "cols":80, "rows":24
        })).unwrap();
        terminal.validate().unwrap();
        let conn = Connection::open(supervisor.registry.database_path()).unwrap();
        conn.execute(
            "UPDATE souls SET provider='opencode',resume_spec=NULL WHERE soul_id=?1",
            [soul.as_str()],
        )
        .unwrap();
        conn.execute(
            "UPDATE writer_claims SET provider='opencode' WHERE soul_id=?1",
            [soul.as_str()],
        )
        .unwrap();
        conn.execute("UPDATE incarnations SET fixture_kind=NULL,terminal_spec=?1,runtime_dir=?2,execution_generation=1 WHERE incarnation_id=?3",
            rusqlite::params![serde_json::to_string(&terminal).unwrap(), runtime.to_str().unwrap(), context.prior_handle.incarnation_id().as_str()]).unwrap();
        drop(conn);
        let context = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        let launch = freshell_runtime_protocol::NativeIdentityLaunch {
            incarnation_id: context.prior_handle.incarnation_id().clone(),
            launch_nonce: context.prior_handle.launch_nonce().as_str().into(),
            evidence_revision: context.evidence_revision,
            execution_generation: 1,
            requested_native_session_id: None,
        };
        supervisor
            .registry
            .bind_native_identity_launch(launch.clone())
            .await
            .unwrap();
        let observation = freshell_runtime_protocol::NativeIdentityObservation {
            native_session_id: "retry-root".into(),
            incarnation_id: launch.incarnation_id,
            launch_nonce: launch.launch_nonce,
            evidence_revision: launch.evidence_revision,
            source: freshell_runtime_protocol::NativeIdentitySource::OpencodeTui,
            evidence_digest: "b".repeat(64),
        };
        std::fs::write(
            runtime.join("retained-opencode-observation.json"),
            serde_json::to_vec(&observation).unwrap(),
        )
        .unwrap();
        std::fs::write(runtime.join("retained-store-unreadable"), b"unreadable").unwrap();
        // Keep a real settled historical journal to catch accidental refunds or
        // comparison of only the new revision's retry count.
        supervisor
            .registry
            .reserve_due_recovery_retry(soul.clone(), context.intent_revision, 0)
            .await
            .unwrap()
            .unwrap();
        let reserved = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        supervisor
            .registry
            .mark_recovery_blocked(
                soul.clone(),
                None,
                RecoveryBlockReason::StoreUnreadable,
                vec!["historical blocked attempt".into()],
                reserved.write_fence(),
            )
            .await
            .unwrap();
        supervisor
            .registry
            .rearm_recovery_retry(soul.clone(), context.intent_revision)
            .await
            .unwrap();
        soul
    }

    async fn seed_retained_exited_opencode(supervisor: &Supervisor, root: &Path) -> SoulId {
        let soul = seed_retained_opencode(supervisor, root).await;
        // The enclosure remains healthy, but its worker has ended. This is the
        // production branch that needs the independent retained store reader.
        std::fs::write(root.join("retained/retained-worker-exited"), b"exited").unwrap();
        soul
    }

    async fn seed_completed_opencode_import(supervisor: &Supervisor, root: &Path) -> SoulId {
        let soul = seed_retained_opencode(supervisor, root).await;
        let context = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        let mut descriptor = resume_catalog::tests::imported_opencode_descriptor();
        descriptor.destination_store_id = context.provider_store_id.clone();
        descriptor.incarnation_id = context.prior_handle.incarnation_id().to_string();
        descriptor.root_session_id = context.native_session_id.clone().unwrap();
        let mut manifest: serde_json::Value =
            serde_json::from_str(&descriptor.manifest_json).unwrap();
        manifest["root_session_id"] = descriptor.root_session_id.clone().into();
        descriptor.manifest_json = serde_json::to_string(&manifest).unwrap();
        descriptor.bundle_sha256 = freshell_runtime_protocol::opencode_transfer_bundle_digest(
            &descriptor.manifest_json,
            &descriptor.files,
        );
        descriptor.validate().unwrap();
        let mut terminal = context.terminal.clone().unwrap();
        terminal.opencode_transfer = Some(descriptor.clone());
        terminal.opencode_transfer_attempt_id = Some("ordinary-import-attempt".into());
        let conn = Connection::open(supervisor.registry.database_path()).unwrap();
        conn.execute("UPDATE souls SET native_import_state='pending',native_import_source_store_id=?1,native_import_root_session_id=?2,native_import_source_generation=?3,native_import_schema_fingerprint=?4,native_import_migration_fingerprint=?5,native_import_authority='staged_transfer' WHERE soul_id=?6",
            rusqlite::params![descriptor.source_store_id,descriptor.root_session_id,descriptor.source_generation,descriptor.source_schema_fingerprint,descriptor.migration_journal_fingerprint,soul.as_str()]).unwrap();
        conn.execute("UPDATE incarnations SET terminal_spec=?1,launch_state='starting' WHERE incarnation_id=?2",
            rusqlite::params![serde_json::to_string(&terminal).unwrap(),context.prior_handle.incarnation_id().as_str()]).unwrap();
        drop(conn);
        let context = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        let observation = serde_json::from_slice(
            &std::fs::read(root.join("retained/retained-opencode-observation.json")).unwrap(),
        )
        .unwrap();
        supervisor
            .registry
            .record_native_identity_observation(soul.clone(), observation, context.write_fence())
            .await
            .unwrap();
        // Publish through the ordinary launch-completion path; there is no
        // stopped-repair operation or receipt in this fixture.
        supervisor
            .registry
            .mark_running(context.prior_handle.incarnation_id().clone())
            .await
            .unwrap();
        std::fs::remove_file(root.join("retained/retained-store-unreadable")).unwrap();
        soul
    }

    #[tokio::test]
    async fn completed_import_authority_survives_transient_recovery_probe() {
        for saved_spec in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let (supervisor, backend, clock) = open(dir.path(), 0);
            let soul = seed_completed_opencode_import(&supervisor, dir.path()).await;
            let initial = supervisor
                .registry
                .recovery_context(soul.clone())
                .await
                .unwrap();
            assert!(initial.opencode_adoption_baseline.is_none());
            assert_eq!(initial.native_import_state, NativeImportState::Completed);
            let spec = resume_catalog::exact_resume_candidate(&initial, None)
                .unwrap()
                .unwrap();
            let baseline = spec.opencode_adoption_baseline.clone().unwrap();
            if saved_spec {
                supervisor
                    .registry
                    .store_verified_resume_spec(soul.clone(), spec)
                    .await
                    .unwrap();
                // Later incarnations recover from the saved spec after the
                // first-boot transfer descriptor has been stripped.
                let mut terminal = initial.terminal.clone().unwrap();
                terminal.opencode_transfer = None;
                terminal.opencode_transfer_attempt_id = None;
                Connection::open(supervisor.registry.database_path())
                    .unwrap()
                    .execute(
                        "UPDATE incarnations SET terminal_spec=?1 WHERE incarnation_id=?2",
                        rusqlite::params![
                            serde_json::to_string(&terminal).unwrap(),
                            initial.prior_handle.incarnation_id().as_str()
                        ],
                    )
                    .unwrap();
            }
            backend.unavailable(true);
            supervisor.reconcile_startup().await.unwrap();
            let blocked = supervisor
                .registry
                .recovery_context(soul.clone())
                .await
                .unwrap();
            assert_eq!(
                blocked.native_import_state,
                NativeImportState::Completed,
                "an origin-source refresh cannot overwrite the completed destination import"
            );
            assert_eq!(blocked.native_import_authority, "verified_import_receipt");
            assert_eq!(
                blocked.native_import_revision,
                initial.native_import_revision
            );
            assert_eq!(
                resume_catalog::exact_resume_candidate(&blocked, None)
                    .unwrap()
                    .unwrap()
                    .opencode_adoption_baseline,
                Some(baseline.clone())
            );
            assert_eq!(due(dir.path()), Some(2_000));
            assert_eq!(backend.count("creates"), 0);

            backend.unavailable(false);
            clock.store(2_000, Ordering::SeqCst);
            let report = supervisor.reconcile_startup().await.unwrap();
            assert!(
                report
                    .results
                    .iter()
                    .all(|r| r.outcome == Some(RecoveryOutcome::Reattached)),
                "{report:?}"
            );
            let recovered = supervisor.registry.recovery_context(soul).await.unwrap();
            assert_eq!(recovered.recovery_state, RecoveryState::Live);
            assert_eq!(
                recovered.prior_handle.incarnation_id(),
                initial.prior_handle.incarnation_id()
            );
            assert_eq!(recovered.native_session_id, initial.native_session_id);
            assert_eq!(
                recovered.resume_spec.unwrap().opencode_adoption_baseline,
                Some(baseline)
            );
            assert_eq!(due(dir.path()), None);
            close_retry_hosts(&backend).await;
        }
    }

    async fn seed_offline_native_reader(
        supervisor: &Supervisor,
        root: &Path,
        opencode: bool,
    ) -> SoulId {
        if opencode {
            std::fs::write(root.join("native-reader-fixture"), b"fixture").unwrap();
            let soul = seed_retained_opencode(supervisor, root).await;
            std::fs::write(root.join("retained/fixture-stopped"), b"stopped").unwrap();
            std::fs::remove_file(root.join("retained/retained-store-unreadable")).unwrap();
            let context = supervisor
                .registry
                .recovery_context(soul.clone())
                .await
                .unwrap();
            let agent: freshell_runtime_protocol::FreshAgentLaunchSpec = serde_json::from_value(serde_json::json!({
                "sessionId":"retry-fresh-opencode", "provider":"opencode", "sessionType":"freshopencode", "runtimeVariant":"opencode-serve-v1",
                "providerStoreId":context.provider_store_id, "cwd":root, "workspacePath":root,
                "runAsUid":65534, "runAsGid":0
            })).unwrap();
            agent.validate().unwrap();
            Connection::open(supervisor.registry.database_path()).unwrap().execute(
                "UPDATE incarnations SET terminal_spec=NULL,fresh_agent_spec=?1 WHERE incarnation_id=?2",
                rusqlite::params![serde_json::to_string(&agent).unwrap(),context.prior_handle.incarnation_id().as_str()],
            ).unwrap();
            soul
        } else {
            let soul = seed_native(supervisor, root).await;
            Connection::open(supervisor.registry.database_path())
                .unwrap()
                .execute(
                    "UPDATE souls SET resume_spec=NULL WHERE soul_id=?1",
                    [soul.as_str()],
                )
                .unwrap();
            soul
        }
    }

    #[tokio::test]
    async fn native_reader_transient_offline_codex_retries() {
        Box::pin(native_reader_transient_retry_case(false, false)).await;
    }

    #[tokio::test]
    async fn native_reader_transient_offline_codex_preserves_due_retry() {
        Box::pin(native_reader_transient_retry_case(false, true)).await;
    }

    #[tokio::test]
    async fn native_reader_transient_retained_opencode_retries() {
        Box::pin(native_reader_transient_retry_case(true, false)).await;
    }

    #[tokio::test]
    async fn native_reader_transient_retained_opencode_preserves_due_retry() {
        Box::pin(native_reader_transient_retry_case(true, true)).await;
    }

    async fn native_reader_transient_retry_case(opencode: bool, prior_backend_attempt: bool) {
        let dir = tempfile::tempdir().unwrap();
        let (supervisor, backend, clock) = open(dir.path(), 0);
        let soul = Box::pin(seed_offline_native_reader(
            &supervisor,
            dir.path(),
            opencode,
        ))
        .await;
        let before = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        let journals = attempts(dir.path()).len();
        if prior_backend_attempt {
            backend.unavailable(true);
            supervisor.reconcile_startup().await.unwrap();
            assert_eq!(due(dir.path()), Some(2_000));
            backend.unavailable(false);
            clock.store(2_000, Ordering::SeqCst);
        }
        std::fs::write(dir.path().join("native-reader-failure"), b"503").unwrap();
        let report = supervisor.reconcile_startup().await.unwrap();
        let expected_count = 1 + u8::from(prior_backend_attempt);
        let expected_due = if prior_backend_attempt { 12_000 } else { 2_000 };
        let retry = supervisor
            .registry
            .recovery_retry(soul.clone(), before.intent_revision)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            retry.attempt_count, expected_count,
            "opencode={opencode}, prior={prior_backend_attempt}: {report:?}"
        );
        assert_eq!(
            retry.next_due_at_ms,
            Some(expected_due),
            "typed helper HTTP failures must retain the bounded retry schedule: {report:?}"
        );
        assert_eq!(retry.last_reason, "backend_unavailable");
        assert_eq!(
            attempts(dir.path()).len(),
            journals + usize::from(expected_count)
        );
        assert_eq!(
            backend.count("creates"),
            0,
            "an unverified store cannot start a replacement"
        );
        let blocked = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        assert!(blocked.resume_spec.is_none());
        assert_eq!(
            blocked.prior_handle.incarnation_id(),
            before.prior_handle.incarnation_id()
        );
        let reader_counter = if opencode {
            "retained-qualifications"
        } else {
            "native-census"
        };
        let reads = backend.count(reader_counter);
        assert!(
            reads > 0,
            "the typed failure must come from the reader after successful inspection"
        );
        supervisor.observe_once().await.unwrap();
        assert_eq!(backend.count(reader_counter), reads);

        std::fs::remove_file(dir.path().join("native-reader-failure")).unwrap();
        clock.store(expected_due, Ordering::SeqCst);
        supervisor.observe_once().await.unwrap();
        let recovered = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        assert_eq!(
            recovered.recovery_state,
            RecoveryState::Live,
            "opencode={opencode}, prior={prior_backend_attempt}: {}",
            std::fs::read_to_string(dir.path().join("lifecycle.jsonl")).unwrap()
        );
        assert_eq!(recovered.native_session_id, before.native_session_id);
        assert!(recovered.resume_spec.is_some());
        assert_eq!(backend.count("creates"), 1);
        assert_eq!(
            attempts(dir.path()).len(),
            journals + usize::from(expected_count) + 1
        );
        assert_eq!(due(dir.path()), None);
        assert_root_and_successes(&supervisor, &soul, 1).await;
        close_retry_hosts(&backend).await;
    }

    #[tokio::test]
    async fn native_reader_transient_failures_exhaust_the_existing_three_attempt_budget() {
        for opencode in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let (supervisor, backend, clock) = open(dir.path(), 0);
            let soul = seed_offline_native_reader(&supervisor, dir.path(), opencode).await;
            let before = supervisor
                .registry
                .recovery_context(soul.clone())
                .await
                .unwrap();
            let journals = attempts(dir.path()).len();
            std::fs::write(dir.path().join("native-reader-failure"), b"503").unwrap();
            for (at, due, count) in [
                (0, Some(2_000), 1),
                (2_000, Some(12_000), 2),
                (12_000, None, 3),
            ] {
                clock.store(at, Ordering::SeqCst);
                supervisor.reconcile_startup().await.unwrap();
                let retry = supervisor
                    .registry
                    .recovery_retry(soul.clone(), before.intent_revision)
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(retry.attempt_count, count);
                assert_eq!(retry.next_due_at_ms, due);
                assert_eq!(attempts(dir.path()).len(), journals + usize::from(count));
            }
            let inspections = backend.count("inspects");
            clock.store(50_000, Ordering::SeqCst);
            supervisor.observe_once().await.unwrap();
            assert_eq!(backend.count("inspects"), inspections);
            assert_eq!(backend.count("creates"), 0);
            assert!(supervisor
                .registry
                .recovery_context(soul)
                .await
                .unwrap()
                .resume_spec
                .is_none());
            close_retry_hosts(&backend).await;
        }
    }

    #[tokio::test]
    async fn native_reader_permanent_failures_do_not_schedule_or_start_replacements() {
        for opencode in [false, true] {
            for failure in ["403", "404", "ownership", "policy", "malformed"] {
                let dir = tempfile::tempdir().unwrap();
                let (supervisor, backend, _) = open(dir.path(), 0);
                let soul = seed_offline_native_reader(&supervisor, dir.path(), opencode).await;
                std::fs::write(dir.path().join("native-reader-failure"), failure).unwrap();
                supervisor.reconcile_startup().await.unwrap();
                let context = supervisor.registry.recovery_context(soul).await.unwrap();
                assert_eq!(context.recovery_state, RecoveryState::Blocked);
                assert!(context.resume_spec.is_none());
                assert_eq!(due(dir.path()), None, "opencode={opencode}, {failure}");
                assert_eq!(backend.count("creates"), 0);
                close_retry_hosts(&backend).await;
            }
        }
    }

    #[tokio::test]
    async fn retained_live_worker_reattaches_without_requiring_unreadable_store() {
        let dir = tempfile::tempdir().unwrap();
        let (supervisor, backend, _) = open(dir.path(), 0);
        let soul = seed_retained_opencode(&supervisor, dir.path()).await;
        let before = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        let result = supervisor
            .recover(RecoverRequest {
                soul_id: soul,
                trigger: RecoveryTrigger::StartupReconcile,
                expected_intent_revision: Some(before.intent_revision),
                expected_control_epoch: Some(supervisor.registry.control_epoch()),
            })
            .await
            .unwrap();
        close_retry_hosts(&backend).await;
        assert_eq!(result.outcome, RecoveryOutcome::Reattached);
        assert_eq!(
            result.view.incarnation_id,
            *before.prior_handle.incarnation_id()
        );
        // A best-effort capture of missing saved resume evidence reads once;
        // its refusal must not gate authenticated healthy reattachment.
        assert_eq!(backend.count("retained-probes"), 1);
        assert_eq!(backend.count("creates"), 0);
        assert_eq!(backend.count("retained-grants"), 0);
        assert_eq!(backend.count("retained-stops"), 0);
    }

    #[tokio::test]
    async fn retained_live_worker_captures_missing_evidence_and_reattaches_in_one_attempt() {
        let dir = tempfile::tempdir().unwrap();
        let (supervisor, backend, _) = open(dir.path(), 0);
        let soul = seed_retained_opencode(&supervisor, dir.path()).await;
        std::fs::remove_file(dir.path().join("retained/retained-store-unreadable")).unwrap();
        let before = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        assert!(before.resume_spec.is_none());
        let journals = attempts(dir.path());
        let result = supervisor
            .recover(RecoverRequest {
                soul_id: soul.clone(),
                trigger: RecoveryTrigger::StartupReconcile,
                expected_intent_revision: Some(before.intent_revision),
                expected_control_epoch: Some(supervisor.registry.control_epoch()),
            })
            .await;
        close_retry_hosts(&backend).await;
        let result = result.expect("one recovery call must save missing evidence and reattach");
        assert_eq!(result.outcome, RecoveryOutcome::Reattached);
        assert_eq!(
            result.view.incarnation_id,
            *before.prior_handle.incarnation_id()
        );
        assert_eq!(result.view.recovery_state, RecoveryState::Live);
        let after = supervisor.registry.recovery_context(soul).await.unwrap();
        assert_eq!(after.evidence_revision, before.evidence_revision + 1);
        let saved = after
            .resume_spec
            .expect("verified native evidence must be saved");
        assert_eq!(saved.evidence_revision, after.evidence_revision);
        assert_eq!(saved.provider_session.native_session_id, "retry-root");
        let settled = attempts(dir.path());
        assert_eq!(&settled[..journals.len()], journals.as_slice());
        assert_eq!(settled.len(), journals.len() + 1);
        assert_eq!(settled.last().unwrap().1, "reattached");
        assert_eq!(backend.count("retained-probes"), 1);
        assert_eq!(backend.count("creates"), 0);
        assert_eq!(backend.count("retained-grants"), 0);
        assert_eq!(backend.count("retained-stops"), 0);
    }

    async fn retained_unreadable_no_new_attempt_case(manual: bool) {
        let dir = tempfile::tempdir().unwrap();
        let (supervisor, backend, _) = open(dir.path(), 0);
        let soul = seed_retained_exited_opencode(&supervisor, dir.path()).await;
        let before = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        let journals = attempts(dir.path());
        assert_eq!(journals.len(), 1);
        drop(supervisor);
        drop(backend);
        let (supervisor, backend, _) = open(dir.path(), 1_000);
        if manual {
            let result = supervisor
                .recover(RecoverRequest {
                    soul_id: soul.clone(),
                    trigger: RecoveryTrigger::ManualRetry,
                    expected_intent_revision: Some(before.intent_revision),
                    expected_control_epoch: Some(supervisor.registry.control_epoch()),
                })
                .await
                .unwrap();
            assert_eq!(result.outcome, RecoveryOutcome::Blocked);
            assert!(
                matches!(
                    result.probe,
                    Some(RecoveryProbe::Blocked {
                        reason: RecoveryBlockReason::StoreUnreadable,
                        ..
                    })
                ),
                "{result:?}"
            );
            assert!(
                matches!(
                    result.probe,
                    Some(RecoveryProbe::Blocked { retry_hint, .. })
                        if retry_hint.automatic_after_ms.is_none()
                ),
                "an unscheduled refusal must not advertise an automatic retry"
            );
        } else {
            let report = supervisor.reconcile_startup().await.unwrap();
            assert!(
                report
                    .results
                    .iter()
                    .all(|result| result.outcome == Some(RecoveryOutcome::Blocked)
                        && result.error.is_none()),
                "{report:?}"
            );
        }
        let after = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        let actual_journals = attempts(dir.path());
        let retry = supervisor
            .registry
            .recovery_retry(soul.clone(), after.intent_revision)
            .await
            .unwrap();
        let events: Vec<serde_json::Value> =
            std::fs::read_to_string(dir.path().join("lifecycle.jsonl"))
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
        let conn = Connection::open(supervisor.registry.database_path()).unwrap();
        let writers: u64 = conn
            .query_row(
                "SELECT count(*) FROM writer_claims WHERE soul_id=?1",
                [soul.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        let incidents: u64 = conn
            .query_row(
                "SELECT count(*) FROM loss_incidents WHERE soul_id=?1",
                [soul.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        drop(conn);
        close_retry_hosts(&backend).await;
        assert_eq!(
            actual_journals, journals,
            "a retained unreadable store must not insert or rewrite any recovery journal"
        );
        assert!(retry.is_none());
        assert_eq!(due(dir.path()), None);
        assert_eq!(after.recovery_state, RecoveryState::Blocked);
        assert_eq!(
            after.intent_revision,
            before.intent_revision + u64::from(manual)
        );
        assert_eq!(
            after.prior_handle.incarnation_id(),
            before.prior_handle.incarnation_id()
        );
        assert_eq!(
            after.prior_handle.container_id(),
            before.prior_handle.container_id()
        );
        assert_eq!(
            after.prior_handle.immutable_config_digest(),
            before.prior_handle.immutable_config_digest()
        );
        assert_eq!(after.native_session_id, before.native_session_id);
        assert_eq!(after.provider_store_id, before.provider_store_id);
        assert_eq!(after.native_identity_launch, before.native_identity_launch);
        assert_eq!(writers, 1);
        assert_eq!(incidents, 0);
        assert_eq!(backend.count("creates"), 0);
        assert_eq!(backend.count("retained-grants"), 0);
        assert_eq!(backend.count("retained-stops"), 0);
        assert_eq!(
            backend.state(&after.prior_handle),
            BackendRuntimeState::Running
        );
        let preflight = events
            .iter()
            .rev()
            .find(|event| event["event"] == "supervisor.recovery.preflight")
            .unwrap();
        assert_eq!(preflight["data"]["attemptReserved"], false);
        assert_eq!(preflight["data"]["blockReason"], "STORE_UNREADABLE");
        assert_eq!(preflight["data"]["severity"], "warn");
        assert_eq!(
            preflight["data"]["controlEpoch"],
            supervisor.registry.control_epoch()
        );
        if !manual {
            // Also preserve the original fixture's startup-then-manual sequence.
            let result = supervisor
                .recover(RecoverRequest {
                    soul_id: soul.clone(),
                    trigger: RecoveryTrigger::ManualRetry,
                    expected_intent_revision: Some(after.intent_revision),
                    expected_control_epoch: Some(supervisor.registry.control_epoch()),
                })
                .await
                .unwrap();
            assert_eq!(result.outcome, RecoveryOutcome::Blocked);
            assert_eq!(attempts(dir.path()), journals);
            close_retry_hosts(&backend).await;
        }
        drop(supervisor);
        drop(backend);
        let (supervisor, backend, _) = open(dir.path(), 20_000);
        supervisor.reconcile_startup().await.unwrap();
        supervisor.observe_once().await.unwrap();
        close_retry_hosts(&backend).await;
        assert_eq!(attempts(dir.path()), journals);
        assert_eq!(due(dir.path()), None);
        // Restore a healthy retained worker as well as its reader, then require
        // fresh authenticated live truth before reattaching the same writer.
        std::fs::remove_file(dir.path().join("retained/retained-store-unreadable")).unwrap();
        std::fs::remove_file(dir.path().join("retained/retained-worker-exited")).unwrap();
        let current = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        let result = supervisor
            .recover(RecoverRequest {
                soul_id: soul.clone(),
                trigger: RecoveryTrigger::ManualRetry,
                expected_intent_revision: Some(current.intent_revision),
                expected_control_epoch: Some(supervisor.registry.control_epoch()),
            })
            .await
            .unwrap();
        close_retry_hosts(&backend).await;
        assert_eq!(result.outcome, RecoveryOutcome::Reattached);
        assert_eq!(
            result.view.incarnation_id,
            *before.prior_handle.incarnation_id()
        );
        assert_eq!(result.view.native_session_id, before.native_session_id);
        assert_eq!(attempts(dir.path()).len(), journals.len() + 1);
        assert_eq!(backend.count("creates"), 0);
        assert_eq!(backend.count("retained-grants"), 0);
        assert_eq!(backend.count("retained-stops"), 0);
    }

    #[tokio::test]
    async fn retained_unreadable_startup_reserves_no_new_attempt() {
        retained_unreadable_no_new_attempt_case(false).await;
    }

    #[tokio::test]
    async fn retained_unreadable_manual_retry_reserves_no_new_attempt() {
        retained_unreadable_no_new_attempt_case(true).await;
    }

    #[tokio::test]
    async fn retained_unreadable_existing_reservation_keeps_its_journal() {
        let dir = tempfile::tempdir().unwrap();
        let (supervisor, backend, _) = open(dir.path(), 0);
        let soul = seed_retained_exited_opencode(&supervisor, dir.path()).await;
        let before = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        let reserved = supervisor
            .registry
            .reserve_due_recovery_retry(soul.clone(), before.intent_revision, 0)
            .await
            .unwrap()
            .unwrap();
        let journals = attempts(dir.path());
        let result = supervisor
            .recover(RecoverRequest {
                soul_id: soul.clone(),
                trigger: RecoveryTrigger::StartupReconcile,
                expected_intent_revision: Some(before.intent_revision),
                expected_control_epoch: Some(supervisor.registry.control_epoch()),
            })
            .await
            .unwrap();
        close_retry_hosts(&backend).await;
        assert_eq!(result.outcome, RecoveryOutcome::Blocked);
        let settled = attempts(dir.path());
        assert_eq!(
            settled.iter().map(|row| &row.0).collect::<Vec<_>>(),
            journals.iter().map(|row| &row.0).collect::<Vec<_>>()
        );
        assert_eq!(
            settled.last().unwrap(),
            &(
                reserved.reserved_attempt_id.unwrap().to_string(),
                "blocked".into()
            )
        );
        assert_eq!(backend.count("creates"), 0);
        assert_eq!(backend.count("retained-probes"), 1);
        let retry = supervisor
            .registry
            .recovery_retry(soul, before.intent_revision)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(retry.attempt_count, 1);
        assert_eq!(retry.last_reason, "STORE_UNREADABLE");
        assert_eq!(retry.next_due_at_ms, None);
    }

    #[tokio::test]
    async fn retained_unreadable_transient_schedule_still_counts_and_bounds_attempts() {
        for host_failure in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let (supervisor, backend, clock) = open(dir.path(), 0);
            let soul = seed_retained_exited_opencode(&supervisor, dir.path()).await;
            if host_failure {
                std::fs::write(
                    dir.path().join("retained/retained-probe-unreachable"),
                    b"unreachable",
                )
                .unwrap();
            } else {
                backend.unavailable(true);
            }
            let revision = supervisor
                .registry
                .recovery_context(soul.clone())
                .await
                .unwrap()
                .intent_revision;
            for (at, expected_due, count) in [
                (0, Some(2_000), 1),
                (2_000, Some(12_000), 2),
                (12_000, None, 3),
            ] {
                clock.store(at, Ordering::SeqCst);
                supervisor.reconcile_startup().await.unwrap();
                let retry = supervisor
                    .registry
                    .recovery_retry(soul.clone(), revision)
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(retry.attempt_count, count);
                assert_eq!(retry.next_due_at_ms, expected_due);
                assert_eq!(attempts(dir.path()).len(), usize::from(count) + 1);
                let inspections = backend.count("inspects");
                clock.store(at + 1, Ordering::SeqCst);
                supervisor.reconcile_startup().await.unwrap();
                assert_eq!(
                    backend.count("inspects"),
                    inspections,
                    "nondue/exhausted recovery must not preflight"
                );
                assert_eq!(attempts(dir.path()).len(), usize::from(count) + 1);
            }
            close_retry_hosts(&backend).await;
            assert_eq!(backend.count("creates"), 0);
            assert_eq!(backend.count("retained-grants"), 0);
            assert_eq!(backend.count("retained-stops"), 0);
        }
    }

    #[tokio::test]
    async fn retained_unreadable_is_rechecked_after_successful_unreserved_discovery() {
        let dir = tempfile::tempdir().unwrap();
        let (supervisor, backend, _) = open(dir.path(), 0);
        let soul = seed_retained_exited_opencode(&supervisor, dir.path()).await;
        let before = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        std::fs::remove_file(dir.path().join("retained/retained-store-unreadable")).unwrap();
        std::fs::write(
            dir.path().join("retained/retained-fault-after-ready"),
            b"fault after read",
        )
        .unwrap();
        let journals = attempts(dir.path());
        let result = supervisor
            .recover(RecoverRequest {
                soul_id: soul.clone(),
                trigger: RecoveryTrigger::StartupReconcile,
                expected_intent_revision: Some(before.intent_revision),
                expected_control_epoch: Some(supervisor.registry.control_epoch()),
            })
            .await
            .unwrap();
        close_retry_hosts(&backend).await;
        assert_eq!(result.outcome, RecoveryOutcome::Blocked);
        assert!(matches!(
            result.probe,
            Some(RecoveryProbe::Blocked {
                reason: RecoveryBlockReason::StoreUnreadable,
                ..
            })
        ));
        assert_eq!(
            backend.count("retained-probes"),
            2,
            "the current reserved store read cannot reuse early success"
        );
        assert_eq!(
            attempts(dir.path()).len(),
            journals.len() + 1,
            "the blocker arose after an honest reservation"
        );
        assert_eq!(backend.count("creates"), 0);
        assert_eq!(backend.count("retained-grants"), 0);
        assert_eq!(backend.count("retained-stops"), 0);
        assert_eq!(
            result.view.incarnation_id,
            *before.prior_handle.incarnation_id()
        );
        assert_eq!(result.view.recovery_state, RecoveryState::Blocked);
    }

    #[tokio::test]
    async fn retained_unreadable_cancels_existing_due_retry_without_refunding_history() {
        let dir = tempfile::tempdir().unwrap();
        let (supervisor, backend, clock) = open(dir.path(), 0);
        let soul = seed_retained_exited_opencode(&supervisor, dir.path()).await;
        backend.unavailable(true);
        supervisor.reconcile_startup().await.unwrap();
        let journals = attempts(dir.path());
        assert_eq!(journals.len(), 2);
        assert_eq!(due(dir.path()), Some(2_000));
        backend.unavailable(false);
        clock.store(2_000, Ordering::SeqCst);
        supervisor.reconcile_startup().await.unwrap();
        close_retry_hosts(&backend).await;
        assert_eq!(attempts(dir.path()), journals);
        assert_eq!(due(dir.path()), None, "an unreadable store must cancel the old transient deadline without reserving an attempt");
        let context = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        let retry = supervisor
            .registry
            .recovery_retry(soul.clone(), context.intent_revision)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(retry.attempt_count, 1);
        assert_eq!(retry.reserved_attempt_id, None);
        assert_eq!(retry.last_reason, "STORE_UNREADABLE");
        let inspections = backend.count("inspects");
        clock.store(50_000, Ordering::SeqCst);
        supervisor.reconcile_startup().await.unwrap();
        supervisor.observe_once().await.unwrap();
        close_retry_hosts(&backend).await;
        assert_eq!(backend.count("inspects"), inspections);
        assert_eq!(attempts(dir.path()), journals);
        assert_eq!(backend.count("creates"), 0);
    }

    #[tokio::test]
    async fn retained_unreadable_stale_blocked_fence_cannot_rebind_current_context() {
        for intent in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let (supervisor, backend, _) = open(dir.path(), 0);
            let soul = seed_retained_exited_opencode(&supervisor, dir.path()).await;
            let journals = attempts(dir.path());
            let (probe, observed, _) = supervisor.classify_recovery(soul.clone()).await.unwrap();
            assert!(matches!(
                probe,
                RecoveryProbe::Blocked {
                    reason: RecoveryBlockReason::StoreUnreadable,
                    ..
                }
            ));
            Connection::open(supervisor.registry.database_path())
                .unwrap()
                .execute(
                    if intent {
                        "UPDATE souls SET intent_revision=intent_revision+1 WHERE soul_id=?1"
                    } else {
                        "UPDATE souls SET evidence_revision=evidence_revision+1 WHERE soul_id=?1"
                    },
                    [soul.as_str()],
                )
                .unwrap();
            let result = supervisor
                .complete_recovery_probe(
                    RecoverRequest {
                        soul_id: soul.clone(),
                        trigger: RecoveryTrigger::StartupReconcile,
                        expected_intent_revision: Some(observed.intent_revision),
                        expected_control_epoch: Some(supervisor.registry.control_epoch()),
                    },
                    probe,
                    observed,
                    None,
                )
                .await;
            close_retry_hosts(&backend).await;
            assert!(
                result.is_err(),
                "an old blocker cannot be written against newer current truth"
            );
            assert_eq!(attempts(dir.path()), journals);
            assert_eq!(backend.count("creates"), 0);
            assert_eq!(backend.count("retained-grants"), 0);
            assert_eq!(backend.count("retained-stops"), 0);
        }
    }

    #[tokio::test]
    async fn retry_final_native_inspection_keeps_typed_transient() {
        for failure in ["transient", "identity"] {
            let dir = tempfile::tempdir().unwrap();
            let (supervisor, backend, _) = open(dir.path(), 0);
            let soul = seed_native(&supervisor, dir.path()).await;
            std::fs::write(dir.path().join("final-inspection-failure"), failure).unwrap();
            supervisor.reconcile_startup().await.unwrap();
            assert_eq!(
                backend.count("final-inspection"),
                1,
                "must reach the activated native replacement's final inspection"
            );
            assert_eq!(backend.count("creates"), 1);
            assert_eq!(attempts(dir.path()).len(), 1);
            assert_eq!(
                due(dir.path()),
                (failure == "transient").then_some(2_750),
                "{failure}: delay starts at final failure settlement"
            );
            assert_root_and_successes(&supervisor, &soul, 0).await;
            std::fs::remove_file(dir.path().join("final-inspection-failure")).unwrap();
            drop(supervisor);
            drop(backend);
            let (supervisor, backend, clock) = open(dir.path(), 2_000);
            supervisor.reconcile_startup().await.unwrap();
            assert_eq!(attempts(dir.path()).len(), 1);
            clock.store(2_750, Ordering::SeqCst);
            supervisor.observe_once().await.unwrap();
            let current = supervisor
                .registry
                .recovery_context(soul.clone())
                .await
                .unwrap();
            if failure == "transient" {
                assert_eq!(current.recovery_state, RecoveryState::Live);
                assert_eq!(backend.count("creates"), 2);
                assert_eq!(attempts(dir.path()).len(), 2);
                assert_root_and_successes(&supervisor, &soul, 1).await;
            } else {
                assert_eq!(current.recovery_state, RecoveryState::Blocked);
                assert_eq!(backend.count("creates"), 1);
                assert_eq!(attempts(dir.path()).len(), 1);
                assert_root_and_successes(&supervisor, &soul, 0).await;
            }
            assert_eq!(due(dir.path()), None);
        }
    }

    #[tokio::test]
    async fn automatic_retry_survives_restart_without_budget_reset() {
        let dir = tempfile::tempdir().unwrap();
        let (supervisor, backend, _) = open(dir.path(), 0);
        let soul = seed(&supervisor).await;
        backend.unavailable(true);
        supervisor.reconcile_startup().await.unwrap();
        assert_eq!(backend.count("inspects"), 1);
        drop(supervisor);
        drop(backend);
        let (supervisor, backend, clock) = open(dir.path(), 1_000);
        supervisor.reconcile_startup().await.unwrap();
        assert_eq!(
            backend.count("inspects"),
            1,
            "restart before the deadline must not spend another automatic attempt"
        );
        assert_eq!(due(dir.path()), Some(2_000));
        clock.store(2_000, Ordering::SeqCst);
        supervisor.reconcile_startup().await.unwrap();
        assert_eq!(backend.count("inspects"), 2);
        assert_eq!(due(dir.path()), Some(12_000));
        drop(supervisor);
        drop(backend);
        let (supervisor, backend, clock) = open(dir.path(), 3_000);
        supervisor.reconcile_startup().await.unwrap();
        assert_eq!(backend.count("inspects"), 2);
        clock.store(-1_000, Ordering::SeqCst);
        supervisor.reconcile_startup().await.unwrap();
        assert_eq!(
            backend.count("inspects"),
            2,
            "clock rollback cannot mint an attempt"
        );
        clock.store(12_000, Ordering::SeqCst);
        supervisor.reconcile_startup().await.unwrap();
        assert_eq!(backend.count("inspects"), 3);
        assert_eq!(attempts(dir.path()).len(), 3);
        assert_eq!(due(dir.path()), None);
        assert_root_and_successes(&supervisor, &soul, 0).await;
        drop(supervisor);
        drop(backend);
        let (supervisor, backend, _) = open(dir.path(), 1_000_000);
        supervisor.reconcile_startup().await.unwrap();
        assert_eq!(
            backend.count("inspects"),
            3,
            "exhaustion must survive restart"
        );
        assert!(supervisor
            .registry
            .inventory()
            .await
            .unwrap()
            .iter()
            .any(|v| v.soul_id == soul
                && v.recovery_reason
                    .as_deref()
                    .is_some_and(|r| r.contains("RETRY_BUDGET"))));
    }

    #[tokio::test]
    async fn reserved_retry_recovers_exited_worker_in_running_enclosure() {
        Box::pin(reserved_exited_worker_retry_case(false, true)).await;
    }

    #[tokio::test]
    async fn reserved_retry_recovers_exited_worker_after_backend_outage() {
        Box::pin(reserved_exited_worker_retry_case(true, true)).await;
    }

    #[tokio::test]
    async fn reserved_retry_recovers_exited_worker_without_saved_proof() {
        Box::pin(reserved_exited_worker_retry_case(false, false)).await;
    }

    async fn reserved_exited_worker_retry_case(prior_backend_outage: bool, saved_proof: bool) {
        let dir = tempfile::tempdir().unwrap();
        let (supervisor, backend, clock) = open(dir.path(), 0);
        let soul = Box::pin(seed(&supervisor)).await;
        let before = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        let runtime = dir.path().join("running-prior");
        std::fs::create_dir(&runtime).unwrap();
        std::fs::write(runtime.join("secret"), b"synthetic-secret").unwrap();
        std::fs::write(
            runtime.join("fixture-object"),
            before.prior_handle.container_id(),
        )
        .unwrap();
        if !saved_proof {
            Connection::open(supervisor.registry.database_path())
                .unwrap()
                .execute(
                    "UPDATE souls SET resume_spec=NULL,allocation_state='materializing',durability_state='live_only' WHERE soul_id=?1",
                    [soul.as_str()],
                )
                .unwrap();
        }
        std::fs::write(runtime.join("fixture-started"), b"started").unwrap();
        std::fs::write(runtime.join("fixture-generation"), b"1").unwrap();
        std::fs::write(runtime.join("retained-worker-exited"), b"exited").unwrap();
        Connection::open(supervisor.registry.database_path())
            .unwrap()
            .execute(
                "UPDATE incarnations SET runtime_dir=?1,execution_generation=1 WHERE incarnation_id=?2",
                rusqlite::params![runtime.to_str().unwrap(), before.prior_handle.incarnation_id().as_str()],
            )
            .unwrap();
        let provider_home = dir.path().join("provider");
        std::fs::create_dir(&provider_home).unwrap();
        std::fs::write(
            provider_home.join("native-session-state.json"),
            b"{\"sessionId\":\"retry-root\",\"history\":[\"stored native turn\"],\"checkpointRevision\":0}",
        )
        .unwrap();

        if prior_backend_outage {
            backend.unavailable(true);
            let report = Box::pin(supervisor.reconcile_startup()).await.unwrap();
            assert_eq!(report.results.len(), 1);
            assert_eq!(report.results[0].outcome, Some(RecoveryOutcome::Blocked));
            assert_eq!(due(dir.path()), Some(2_000));
            assert_eq!(backend.count("creates"), 0);
            backend.unavailable(false);
            clock.store(2_000, Ordering::SeqCst);
        }
        let context = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        assert_eq!(
            backend.state(&context.prior_handle),
            BackendRuntimeState::Running
        );
        let result = Box::pin(supervisor.recover(RecoverRequest {
            soul_id: soul.clone(),
            trigger: if prior_backend_outage {
                RecoveryTrigger::StartupReconcile
            } else {
                RecoveryTrigger::ProviderExit
            },
            expected_intent_revision: Some(context.intent_revision),
            expected_control_epoch: Some(supervisor.registry.control_epoch()),
        }))
        .await
        .unwrap();
        assert_eq!(
            result.outcome,
            RecoveryOutcome::Replaced,
            "valid native readiness must survive the current reservation: {result:?}"
        );
        assert_eq!(result.view.recovery_state, RecoveryState::Live);
        assert_eq!(
            result.expected_native_session_id.as_deref(),
            Some("retry-root")
        );
        assert_eq!(
            result.observed_native_session_id.as_deref(),
            Some("retry-root")
        );
        assert_ne!(
            result.view.incarnation_id,
            *before.prior_handle.incarnation_id()
        );
        assert_eq!(
            attempts(dir.path()).len(),
            1 + usize::from(prior_backend_outage)
        );
        assert_eq!(backend.count("creates"), 1);
        assert_root_and_successes(&supervisor, &soul, 1).await;
        assert_eq!(due(dir.path()), None);
        let recovered = supervisor.registry.recovery_context(soul).await.unwrap();
        assert!(recovered.recovery_attempt_id.is_none());
        assert_eq!(
            recovered.evidence_revision,
            before.evidence_revision + u64::from(!saved_proof),
            "a newly captured proof advances evidence exactly once; idempotent proof stays current"
        );
    }

    #[tokio::test]
    async fn retry_dependency_available_on_second_attempt_resumes_same_root_once() {
        let dir = tempfile::tempdir().unwrap();
        let (supervisor, backend, clock) = open(dir.path(), 0);
        let soul = seed(&supervisor).await;
        backend.unavailable(true);
        supervisor.reconcile_startup().await.unwrap();
        let failed_events = std::fs::read_to_string(dir.path().join("lifecycle.jsonl")).unwrap();
        assert!(!failed_events.contains("supervisor.recovery.old_writer_released"));
        assert!(!failed_events.contains("supervisor.recovery.replacement_writer_prepared"));
        backend.unavailable(false);
        clock.store(2_000, Ordering::SeqCst);
        let report = supervisor.reconcile_startup().await.unwrap();
        assert!(
            report
                .results
                .iter()
                .all(|r| r.outcome == Some(RecoveryOutcome::Replaced)),
            "{report:?}"
        );
        assert_eq!(
            attempts(dir.path()).len(),
            2,
            "both failures and successes have reserved journals"
        );
        assert_eq!(backend.count("creates"), 1);
        assert_root_and_successes(&supervisor, &soul, 1).await;
        assert_eq!(due(dir.path()), None);
        let journals = attempts(dir.path());
        let events: Vec<serde_json::Value> =
            std::fs::read_to_string(dir.path().join("lifecycle.jsonl"))
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
        let scheduled = events
            .iter()
            .find(|event| event["event"] == "supervisor.recovery_retry.scheduled")
            .unwrap()
            .get("data")
            .unwrap();
        assert_eq!(scheduled["attemptId"], journals[0].0);
        assert_eq!(scheduled["nextDueAtMs"], 2_000);
        let settled = events
            .iter()
            .rev()
            .find(|event| event["event"] == "supervisor.recovery_retry.settled")
            .unwrap()
            .get("data")
            .unwrap();
        let current = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        let view = supervisor
            .view_for(current.prior_handle.incarnation_id())
            .await
            .unwrap();
        assert_eq!(settled["attemptId"], journals[1].0);
        assert_eq!(settled["incarnationId"], view.incarnation_id.as_str());
        assert_eq!(settled["executionGeneration"], view.execution_generation);
        assert_eq!(settled["intentRevision"], view.intent_revision);
        assert_eq!(settled["reason"], "recovered");
        assert_eq!(settled["severity"], "info");
        let released = events
            .iter()
            .position(|event| event["event"] == "supervisor.recovery.old_writer_released")
            .unwrap();
        let prepared = events
            .iter()
            .position(|event| event["event"] == "supervisor.recovery.replacement_writer_prepared")
            .unwrap();
        let running = events
            .iter()
            .position(|event| event["event"] == "supervisor.launch_running")
            .unwrap();
        assert!(released < prepared && prepared < running);
        assert_eq!(events[released]["data"]["soulId"], soul.as_str());
        assert_eq!(events[released]["data"]["outcome"], "verified_empty");
        assert_eq!(
            events[prepared]["data"]["priorIncarnationId"],
            events[released]["data"]["incarnationId"]
        );
        assert_eq!(
            events[prepared]["data"]["incarnationId"],
            view.incarnation_id.as_str()
        );
        assert_eq!(events[prepared]["data"]["writerState"], "prepared");
    }

    #[tokio::test]
    async fn retry_manual_rearm_survives_early_transient_and_restart() {
        let dir = tempfile::tempdir().unwrap();
        let (supervisor, backend, _) = open(dir.path(), 0);
        let soul = seed(&supervisor).await;
        let context = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        Connection::open(supervisor.registry.database_path()).unwrap().execute(
            "UPDATE souls SET recovery_window_started_at=?1,successful_recoveries_in_window=5 WHERE soul_id=?2",
            rusqlite::params![crate::registry::now_millis(), soul.as_str()],
        ).unwrap();
        backend.unavailable(true);
        let first = supervisor
            .recover(RecoverRequest {
                soul_id: soul.clone(),
                trigger: RecoveryTrigger::ManualRetry,
                expected_intent_revision: Some(context.intent_revision),
                expected_control_epoch: Some(supervisor.registry.control_epoch()),
            })
            .await
            .unwrap();
        assert_eq!(first.outcome, RecoveryOutcome::Blocked);
        assert_eq!(due(dir.path()), Some(2_000));
        assert_eq!(backend.count("creates"), 0);
        drop(supervisor);
        drop(backend);

        let (supervisor, backend, clock) = open(dir.path(), 1_000);
        backend.unavailable(false);
        supervisor.reconcile_startup().await.unwrap();
        assert_eq!(attempts(dir.path()).len(), 1);
        clock.store(2_000, Ordering::SeqCst);
        supervisor.observe_once().await.unwrap();
        let current = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        assert_eq!(current.recovery_state, RecoveryState::Live);
        assert_eq!(current.intent_revision, context.intent_revision + 1);
        assert_eq!(backend.count("creates"), 1);
        assert_eq!(attempts(dir.path()).len(), 2);
        assert_root_and_successes(&supervisor, &soul, 1).await;
        assert_eq!(due(dir.path()), None);
        // A subsequent automatic replacement spends another success from the
        // same window; only the deliberate action above may rearm it.
        backend
            .request_stop(&current.prior_handle, 0)
            .await
            .unwrap();
        let next = supervisor
            .recover(RecoverRequest {
                soul_id: soul.clone(),
                trigger: RecoveryTrigger::ProviderExit,
                expected_intent_revision: Some(current.intent_revision),
                expected_control_epoch: Some(supervisor.registry.control_epoch()),
            })
            .await
            .unwrap();
        assert_eq!(next.outcome, RecoveryOutcome::Replaced);
        assert_root_and_successes(&supervisor, &soul, 2).await;
        assert_eq!(next.view.intent_revision, context.intent_revision + 1);
    }

    #[tokio::test]
    async fn retry_activation_eligibility_uses_the_typed_failure() {
        for (kind, retryable) in [
            ("transient", true),
            ("ownership", false),
            ("policy", false),
            ("malformed", false),
            ("config", false),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let (supervisor, backend, clock) = open(dir.path(), 0);
            let soul = seed(&supervisor).await;
            std::fs::write(dir.path().join("create-failure"), kind).unwrap();
            supervisor.reconcile_startup().await.unwrap();
            assert_eq!(due(dir.path()), retryable.then_some(2_000), "{kind}");
            let count = backend.count("inspects");
            clock.store(20_000, Ordering::SeqCst);
            supervisor.observe_once().await.unwrap();
            assert_eq!(
                attempts(dir.path()).len(),
                if retryable { 2 } else { 1 },
                "{kind}"
            );
            if !retryable {
                assert_eq!(
                    backend.count("inspects"),
                    count,
                    "{kind} must require deliberate correction"
                );
            }
            assert_root_and_successes(&supervisor, &soul, 0).await;
        }
    }

    #[tokio::test]
    async fn retry_valid_wrong_provider_preparation_is_not_transient() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let grants = tempfile::tempdir().unwrap();
        std::fs::create_dir(grants.path().join("mcp-capabilities")).unwrap();
        std::fs::create_dir_all(grants.path().join("provider-roots/grant-retry-test")).unwrap();
        crate::backend::docker::configure_capability_dir(&grants.path().join("control.sock"))
            .unwrap();
        assert_eq!(
            crate::backend::docker::staged_provider_root_for_grant("grant-retry-test").unwrap(),
            grants.path().join("provider-roots/grant-retry-test")
        );
        for case in ["wrong_provider", "missing_capability", "unavailable"] {
            let dir = tempfile::tempdir().unwrap();
            let (supervisor, backend, clock) = open(dir.path(), 0);
            let soul = seed(&supervisor).await;
            let context = supervisor
                .registry
                .recovery_context(soul.clone())
                .await
                .unwrap();
            let launch_context = serde_json::json!({
                "preparation":{"codex":{"tui_args":[],"sidecar_args":[]}},
                "mcpCapability":{"grantId":"grant-retry-test", "endpoint":"http://host.docker.internal:9", "providerRelativePath":".freshell/mcp-capability.json"},
                "config":[]
            });
            let terminal: TerminalLaunchSpec = serde_json::from_value(serde_json::json!({
                "terminalId":"preparation-retry", "streamId":"preparation-stream", "mode":"codex", "program":"codex",
                "cwd":dir.path(), "workspacePath":dir.path(), "projectKey":"preparation-retry",
                "runAsUid":65534, "runAsGid":0, "cols":80, "rows":24, "providerLaunchContext":launch_context,
            })).unwrap();
            terminal.validate().unwrap();
            Connection::open(supervisor.registry.database_path())
                .unwrap()
                .execute(
                    "UPDATE incarnations SET terminal_spec=?1 WHERE incarnation_id=?2",
                    rusqlite::params![
                        serde_json::to_string(&terminal).unwrap(),
                        context.prior_handle.incarnation_id().as_str()
                    ],
                )
                .unwrap();
            let server = if case == "unavailable" {
                None
            } else {
                let listener = tokio::net::UnixListener::bind(dir.path().join("mcp.sock")).unwrap();
                let mut response = terminal.provider_launch_context.unwrap();
                if case == "wrong_provider" {
                    response.preparation =
                        freshell_runtime_protocol::ProviderPreparation::Opencode {
                            project_config: vec![],
                            tui_config: None,
                            tui_source: None,
                            inline_config: false,
                        };
                } else {
                    response.mcp_capability = None;
                }
                let response =
                    serde_json::to_vec(&freshell_runtime_protocol::PreparedProviderContext {
                        provider_launch_context: response,
                        provider_secret_references: vec![],
                    })
                    .unwrap();
                Some(tokio::spawn(async move {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let mut request = vec![];
                    stream.read_to_end(&mut request).await.unwrap();
                    let request: serde_json::Value = serde_json::from_slice(&request).unwrap();
                    assert_eq!(request["action"], "issue");
                    assert_eq!(request["provider"], "codex");
                    stream.write_all(&response).await.unwrap();
                }))
            };
            let report = supervisor.reconcile_startup().await.unwrap();
            if let Some(server) = server {
                server.await.unwrap();
            }
            assert_eq!(
                due(dir.path()),
                (case == "unavailable").then_some(2_000),
                "{case}: {report:?}"
            );
            let journals = attempts(dir.path());
            assert_eq!(journals.len(), 1);
            assert_eq!(journals[0].1, "blocked", "{case}: {report:?}");
            let unfinished: u64 = Connection::open(supervisor.registry.database_path())
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM recovery_attempts WHERE finished_at IS NULL",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(unfinished, 0);
            assert_eq!(
                backend.count("creates"),
                0,
                "a mismatched preparation cannot dispatch a provider"
            );
            clock.store(2_000, Ordering::SeqCst);
            supervisor.observe_once().await.unwrap();
            assert_eq!(
                attempts(dir.path()).len(),
                if case == "unavailable" { 2 } else { 1 }
            );
            assert_eq!(backend.count("creates"), 0);
            assert_root_and_successes(&supervisor, &soul, 0).await;
        }
    }

    #[tokio::test]
    async fn retry_preparation_callback_retries_only_transport_failure() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for response in [
            None,
            Some(b"host unavailable".to_vec()),
            Some(vec![b'x'; 256 * 1024 + 1]),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let (supervisor, _, _) = open(dir.path(), 0);
            let soul = seed(&supervisor).await;
            let context = supervisor
                .registry
                .recovery_context(soul.clone())
                .await
                .unwrap();
            let reserved = supervisor
                .registry
                .reserve_due_recovery_retry(soul.clone(), context.intent_revision, 0)
                .await
                .unwrap()
                .unwrap();
            let unavailable = response.is_none();
            let server = response.map(|response| {
                let listener = tokio::net::UnixListener::bind(dir.path().join("mcp.sock")).unwrap();
                tokio::spawn(async move {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let mut request = Vec::new();
                    stream.read_to_end(&mut request).await.unwrap();
                    stream.write_all(&response).await.unwrap();
                })
            });
            let start = crate::registry::RecoveryStart {
                attempt_id: reserved
                    .reserved_attempt_id
                    .clone()
                    .expect("reserved callback attempt"),
                context: context.clone(),
            };
            let prior = freshell_runtime_protocol::ProviderLaunchContext {
                preparation: freshell_runtime_protocol::ProviderPreparation::Codex {
                    tui_args: vec![],
                    sidecar_args: vec![],
                },
                config: vec![],
                mcp_capability: None,
                prepared_inputs: None,
            };
            let error = supervisor
                .issue_replacement_mcp_capability(&start, "codex", &prior, &[], "/tmp", "/tmp")
                .await
                .unwrap_err();
            if let Some(server) = server {
                server.await.unwrap();
            }
            assert_eq!(
                error.code,
                if unavailable {
                    RuntimeErrorCode::HostUnreachable
                } else {
                    RuntimeErrorCode::RecoveryBlocked
                }
            );
            let context = supervisor
                .registry
                .recovery_context(soul.clone())
                .await
                .unwrap();
            supervisor
                .registry
                .mark_recovery_blocked_with_retry(
                    soul.clone(),
                    reserved.reserved_attempt_id,
                    RecoveryBlockReason::CapabilityPending,
                    vec![error.message.clone()],
                    context.write_fence(),
                    TransientRecoveryFailure::from_runtime(&error)
                        .map(|_| TransientRecoveryFailure::Preparation),
                )
                .await
                .unwrap();
            assert_eq!(due(dir.path()), unavailable.then_some(2_000));
            assert_root_and_successes(&supervisor, &soul, 0).await;
        }
    }

    #[tokio::test]
    async fn retry_startup_and_observer_share_one_due_attempt() {
        let dir = tempfile::tempdir().unwrap();
        let (supervisor, backend, clock) = open(dir.path(), 0);
        let soul = seed(&supervisor).await;
        backend.unavailable(true);
        supervisor.reconcile_startup().await.unwrap();
        backend.unavailable(false);
        clock.store(2_000, Ordering::SeqCst);
        let (startup, observer) =
            tokio::join!(supervisor.reconcile_startup(), supervisor.observe_once());
        startup.unwrap();
        observer.unwrap();
        assert_eq!(
            attempts(dir.path()).len(),
            2,
            "startup and observer must dispatch the same due reservation only once"
        );
        assert_eq!(backend.count("creates"), 1);
        assert_root_and_successes(&supervisor, &soul, 1).await;
    }

    #[tokio::test]
    async fn retry_reservation_cancellation_and_manual_rearm_are_transactional() {
        for action in ["stop", "new_intent", "lost", "manual"] {
            let dir = tempfile::tempdir().unwrap();
            let (supervisor, backend, clock) = open(dir.path(), 0);
            let soul = seed(&supervisor).await;
            let revision = supervisor
                .registry
                .recovery_context(soul.clone())
                .await
                .unwrap()
                .intent_revision;
            let (left, right) = tokio::join!(
                supervisor
                    .registry
                    .reserve_due_recovery_retry(soul.clone(), revision, 0),
                supervisor
                    .registry
                    .reserve_due_recovery_retry(soul.clone(), revision, 0)
            );
            let reservations: Vec<_> = [left.unwrap(), right.unwrap()]
                .into_iter()
                .flatten()
                .collect();
            assert_eq!(reservations.len(), 1);
            let attempt = reservations[0].reserved_attempt_id.clone().unwrap();
            assert!(supervisor
                .registry
                .reserve_due_recovery_retry(soul.clone(), revision + 1, 0)
                .await
                .unwrap()
                .is_none());
            match action {
                "stop" => {
                    supervisor
                        .registry
                        .begin_stop_expected(soul.clone(), Some(revision))
                        .await
                        .unwrap();
                }
                "manual" => {
                    supervisor
                        .registry
                        .settle_recovery_retry(
                            soul.clone(),
                            revision,
                            attempt.clone(),
                            true,
                            false,
                            0,
                        )
                        .await
                        .unwrap();
                    assert_eq!(due(dir.path()), Some(2_000));
                    backend.unavailable(true);
                    clock.store(1_000, Ordering::SeqCst);
                    supervisor
                        .recover(RecoverRequest {
                            soul_id: soul.clone(),
                            trigger: RecoveryTrigger::ManualRetry,
                            expected_intent_revision: Some(revision),
                            expected_control_epoch: Some(supervisor.registry.control_epoch()),
                        })
                        .await
                        .unwrap();
                    assert_eq!(attempts(dir.path()).len(), 2);
                    assert_eq!(
                        supervisor
                            .registry
                            .recovery_context(soul.clone())
                            .await
                            .unwrap()
                            .intent_revision,
                        revision + 1
                    );
                    assert_eq!(due(dir.path()), Some(3_000));
                    let stale = supervisor
                        .recover(RecoverRequest {
                            soul_id: soul.clone(),
                            trigger: RecoveryTrigger::ManualRetry,
                            expected_intent_revision: Some(revision),
                            expected_control_epoch: Some(supervisor.registry.control_epoch()),
                        })
                        .await
                        .unwrap_err();
                    assert_eq!(stale.code, RuntimeErrorCode::StaleIntentRevision);
                    assert_eq!(attempts(dir.path()).len(), 2);
                }
                "new_intent" | "lost" => {
                    // These are the same durable soul UPDATEs used by intent
                    // and loss writers; the migration trigger is the shared
                    // production cancellation path inside their transaction.
                    let conn = Connection::open(supervisor.registry.database_path()).unwrap();
                    conn.execute(
                        if action == "lost" {
                            "UPDATE souls SET recovery_state='lost' WHERE soul_id=?1"
                        } else {
                            "UPDATE souls SET intent_revision=intent_revision+1 WHERE soul_id=?1"
                        },
                        [soul.as_str()],
                    )
                    .unwrap();
                }
                _ => unreachable!(),
            }
            let expected_due = due(dir.path());
            supervisor
                .registry
                .settle_recovery_retry(soul.clone(), revision, attempt.clone(), true, false, 50_000)
                .await
                .unwrap();
            supervisor
                .registry
                .settle_recovery_retry(soul.clone(), revision, attempt, false, true, 60_000)
                .await
                .unwrap();
            assert_eq!(
                due(dir.path()),
                expected_due,
                "a stale completion must not rearm or clear the newer action"
            );
            assert!(supervisor
                .registry
                .recovery_retry(soul.clone(), revision)
                .await
                .unwrap()
                .is_none());
            drop(supervisor);
            drop(backend);
            let (supervisor, _, _) = open(dir.path(), 70_000);
            assert!(supervisor
                .registry
                .recovery_retry(soul.clone(), revision)
                .await
                .unwrap()
                .is_none());
            assert_root_and_successes(&supervisor, &soul, 0).await;
        }
    }

    #[tokio::test]
    async fn retry_unqualified_native_store_does_not_rearm_from_a_hint() {
        let dir = tempfile::tempdir().unwrap();
        let (supervisor, backend, clock) = open(dir.path(), 0);
        let soul = seed(&supervisor).await;
        let conn = Connection::open(supervisor.registry.database_path()).unwrap();
        conn.execute(
            "UPDATE souls SET resume_spec=NULL WHERE soul_id=?1",
            [soul.as_str()],
        )
        .unwrap();
        supervisor.reconcile_startup().await.unwrap();
        assert_eq!(due(dir.path()), None);
        clock.store(20_000, Ordering::SeqCst);
        supervisor.reconcile_startup().await.unwrap();
        supervisor.observe_once().await.unwrap();
        assert_eq!(backend.count("inspects"), 1);
        assert_eq!(backend.count("creates"), 0);
        assert_root_and_successes(&supervisor, &soul, 0).await;
    }

    struct ReservedReplacement {
        supervisor: Supervisor,
        backend: Arc<RetryBackend>,
        soul: SoulId,
        original_intent_revision: u64,
        attempt_id: String,
        handle: OwnedRuntimeHandle,
    }

    async fn reserved_replacement(root: &Path, starting: bool) -> ReservedReplacement {
        let (supervisor, backend, _) = open(root, 0);
        let soul = seed(&supervisor).await;
        let original = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        let reserved = supervisor
            .registry
            .reserve_due_recovery_retry(soul.clone(), original.intent_revision, 0)
            .await
            .unwrap()
            .unwrap();
        let start = supervisor
            .registry
            .begin_recovery(
                soul.clone(),
                RecoveryTrigger::ProviderExit,
                RecoveryPath::NativeResume,
            )
            .await
            .unwrap();
        supervisor
            .registry
            .mark_stop_outcome(
                original.prior_handle.incarnation_id().clone(),
                StopOutcome::VerifiedEmpty,
            )
            .await
            .unwrap();
        let replacement = supervisor
            .registry
            .prepare_replacement(
                start,
                None,
                None,
                original.resume_spec,
                RecoveryPath::NativeResume,
            )
            .await
            .unwrap();
        let runtime = root
            .join("runtime")
            .join(replacement.prepared.incarnation_id.as_str());
        std::fs::create_dir_all(&runtime).unwrap();
        std::fs::write(runtime.join("secret"), b"retry-secret").unwrap();
        let created = backend
            .create_stopped(&CreateRuntimeSpec {
                initial_input_reservation: None,
                prior_provider_owner: None,
                installation_id: supervisor.registry.installation_id().clone(),
                soul_id: soul.clone(),
                incarnation_id: replacement.prepared.incarnation_id.clone(),
                image_ref: supervisor.config.image_ref.clone(),
                host_binary_path: supervisor.config.host_binary_path.clone(),
                runtime_dir: runtime.clone(),
                limits: original.requested_limits,
                test_run_id: "retry-reopen".into(),
                terminal: None,
                fresh_agent: None,
                opencode_transfer_dir: None,
                provider_volume_name: "retry-volume".into(),
            })
            .await
            .unwrap();
        supervisor
            .registry
            .commit_created(
                replacement.prepared.incarnation_id.clone(),
                crate::registry::BackendCreatedRecord {
                    daemon_id: created.daemon_id,
                    container_id: created.container_id.clone(),
                    image_ref: supervisor.config.image_ref.clone(),
                    runtime_dir: runtime,
                    host_binary_path: supervisor.config.host_binary_path.clone(),
                    immutable_config_digest: created.immutable_config_digest,
                    launch_policy: None,
                },
            )
            .await
            .unwrap();
        if starting {
            let handle = supervisor
                .registry
                .owned_handle(replacement.prepared.incarnation_id.clone())
                .await
                .unwrap();
            backend.start_host(&handle).await.unwrap();
            supervisor
                .authenticate_host(handle.incarnation_id(), handle.runtime_dir())
                .await
                .unwrap();
            let boot = HostBootId::parse(
                std::fs::read_to_string(handle.runtime_dir().join("fixture-boot")).unwrap(),
            )
            .unwrap();
            supervisor
                .registry
                .commit_execution_grant(
                    handle.incarnation_id().clone(),
                    boot,
                    original.requested_limits,
                )
                .await
                .unwrap();
        }
        let handle = supervisor
            .registry
            .owned_handle(replacement.prepared.incarnation_id)
            .await
            .unwrap();
        ReservedReplacement {
            supervisor,
            backend,
            soul,
            original_intent_revision: original.intent_revision,
            attempt_id: reserved.reserved_attempt_id.unwrap().to_string(),
            handle,
        }
    }

    pub(crate) async fn assert_baseline_only_stop_cancellation(
        dir: &tempfile::TempDir,
        registry: &Registry,
        soul: &SoulId,
    ) -> RecoveryContext {
        use freshell_runtime_protocol::{
            AdminCommand, AdminResult, ControlRole, RequestId, StopRequest,
        };
        let initial = registry.recovery_context(soul.clone()).await.unwrap();
        let readiness = Arc::new(BaselineStopReadiness {
            provider_home: dir.path().join(format!("provider-{soul}")),
            workspace: dir.path().join("workspace"),
            baseline: initial.opencode_adoption_baseline.clone().unwrap(),
            pending: tokio::sync::Notify::new(),
            complete: tokio::sync::Notify::new(),
            launch: Mutex::new(None),
        });
        let mut backend = RetryBackend::new(dir.path(), Arc::new(AtomicI64::new(0)));
        backend.baseline_stop = Some(readiness.clone());
        let backend = Arc::new(backend);
        let config = (*super::tests::missing_supervisor(dir, registry.clone()).config).clone();
        let supervisor = Supervisor::new(registry.clone(), backend.clone(), config).unwrap();
        let revision = registry
            .start_stopped_data_repair(soul.clone(), initial.intent_revision)
            .await
            .unwrap();
        let current = registry.recovery_context(soul.clone()).await.unwrap();
        let spec = resume_catalog::exact_resume_candidate(&current, None)
            .unwrap()
            .unwrap();
        registry
            .store_verified_recovery_resume_spec_fenced(
                soul.clone(),
                spec.clone(),
                current.write_fence(),
            )
            .await
            .unwrap();
        let reserved = registry
            .reserve_due_recovery_retry(soul.clone(), revision, registry.recovery_now_ms())
            .await
            .unwrap()
            .unwrap();
        let start = registry
            .begin_recovery(
                soul.clone(),
                RecoveryTrigger::ManualRetry,
                RecoveryPath::NativeResume,
            )
            .await
            .unwrap();
        registry
            .mark_stop_outcome(
                initial.prior_handle.incarnation_id().clone(),
                StopOutcome::VerifiedEmpty,
            )
            .await
            .unwrap();
        // Resume an already reserved/owned Created replacement through the
        // same production path used after an interrupted preparation. Only the
        // transport peer is controlled; import and current reader are real.
        let replacement = registry
            .prepare_replacement(
                start,
                terminal_without_first_boot_state(current.terminal),
                None,
                Some(spec),
                RecoveryPath::NativeResume,
            )
            .await
            .unwrap();
        let runtime = supervisor
            .ensure_incarnation_dir(&replacement.prepared)
            .unwrap();
        let created = backend
            .create_stopped(&CreateRuntimeSpec {
                initial_input_reservation: None,
                prior_provider_owner: None,
                installation_id: registry.installation_id().clone(),
                soul_id: soul.clone(),
                incarnation_id: replacement.prepared.incarnation_id.clone(),
                image_ref: supervisor.config.image_ref.clone(),
                host_binary_path: supervisor.config.host_binary_path.clone(),
                runtime_dir: runtime.clone(),
                limits: initial.requested_limits,
                test_run_id: "baseline-stop".into(),
                terminal: replacement.terminal.clone(),
                fresh_agent: None,
                opencode_transfer_dir: None,
                provider_volume_name: initial.prior_handle.provider_volume_name().to_owned(),
            })
            .await
            .unwrap();
        registry
            .commit_created(
                replacement.prepared.incarnation_id.clone(),
                crate::registry::BackendCreatedRecord {
                    daemon_id: created.daemon_id,
                    container_id: created.container_id,
                    image_ref: supervisor.config.image_ref.clone(),
                    runtime_dir: runtime,
                    host_binary_path: supervisor.config.host_binary_path.clone(),
                    immutable_config_digest: created.immutable_config_digest,
                    launch_policy: None,
                },
            )
            .await
            .unwrap();
        let conn = Connection::open(registry.database_path()).unwrap();
        let initial_souls: u64 = conn
            .query_row("SELECT count(*) FROM souls", [], |row| row.get(0))
            .unwrap();
        conn.execute_batch("CREATE TABLE baseline_stop_effects(kind TEXT);
            CREATE TRIGGER baseline_stop_live AFTER UPDATE OF recovery_state ON souls WHEN NEW.recovery_state='live' BEGIN INSERT INTO baseline_stop_effects VALUES('live'); END;").unwrap();
        drop(conn);
        let recovering = {
            let supervisor = supervisor.clone();
            let soul = soul.clone();
            tokio::spawn(async move {
                supervisor
                    .recover(RecoverRequest {
                        soul_id: soul,
                        trigger: RecoveryTrigger::StartupReconcile,
                        expected_intent_revision: Some(revision),
                        expected_control_epoch: Some(supervisor.registry.control_epoch()),
                    })
                    .await
            })
        };
        tokio::time::timeout(Duration::from_secs(5), readiness.pending.notified())
            .await
            .expect("actual native readiness must wait after reading the imported baseline");
        assert!(!recovering.is_finished());
        assert_eq!(backend.count("baseline-current-reads"), 1);
        assert_eq!(backend.count("baseline-grants"), 1);
        let stopping = {
            let supervisor = supervisor.clone();
            let mut envelope = Envelope::new(
                RequestId::new(),
                ControlRole::Web,
                AdminCommand::Stop(StopRequest {
                    soul_id: soul.clone(),
                    expected_intent_revision: Some(revision),
                    expected_control_epoch: Some(registry.control_epoch()),
                }),
            );
            envelope.auth = Some(supervisor.config.control_secret.clone());
            tokio::spawn(async move { supervisor.dispatch(envelope).await })
        };
        let stopped = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let current = registry.recovery_context(soul.clone()).await.unwrap();
                if current.desired_state == DesiredState::Stopped {
                    break current;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("ordinary Stop commits while native readiness retains lifecycle custody");
        assert_eq!(stopped.intent_revision, revision + 1);
        assert!(!stopping.is_finished());
        assert_eq!(backend.count("baseline-host-stops"), 0);
        readiness.complete.notify_one();
        let recovery = tokio::time::timeout(Duration::from_secs(5), recovering)
            .await
            .expect("cancelled readiness must release recovery without another host read")
            .unwrap();
        assert_eq!(
            recovery.unwrap_err().code,
            RuntimeErrorCode::StaleIntentRevision
        );
        let stop = tokio::time::timeout(Duration::from_secs(5), stopping)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            stop.result.unwrap(),
            AdminResult::Stop {
                outcome: StopOutcome::VerifiedEmpty,
                ..
            }
        ));
        let after = registry.recovery_context(soul.clone()).await.unwrap();
        assert_eq!(after.desired_state, DesiredState::Stopped);
        assert_eq!(after.recovery_state, RecoveryState::Stopped);
        assert_eq!(after.intent_revision, stopped.intent_revision);
        assert_eq!(
            after.opencode_adoption_baseline,
            initial.opencode_adoption_baseline
        );
        assert_eq!(after.native_session_id, initial.native_session_id);
        assert_eq!(
            after.native_identity_launch,
            readiness.launch.lock().unwrap().clone()
        );
        assert_eq!(after.native_import_revision, initial.native_import_revision);
        assert_eq!(
            after.native_import_source_generation,
            initial.native_import_source_generation
        );
        assert_eq!(
            after.native_import_authority,
            initial.native_import_authority
        );
        assert_eq!(after.provider_store_id, initial.provider_store_id);
        assert_eq!(
            after.prior_handle.incarnation_id(),
            &replacement.prepared.incarnation_id
        );
        assert_eq!(after.successful_recoveries_in_window, 0);
        assert_eq!(
            backend.count("creates"),
            1,
            "only the pre-Stop prepared enclosure exists"
        );
        assert_eq!(
            backend.count("baseline-grants"),
            1,
            "no execution grant after Stop"
        );
        assert_eq!(backend.count("baseline-late-observations"), 1);
        assert_eq!(
            backend.count("baseline-host-starts"),
            1,
            "no new provider host start after Stop"
        );
        assert!(registry.pending_stop_handles().await.unwrap().is_empty());
        assert!(registry
            .recovery_retry(soul.clone(), revision)
            .await
            .unwrap()
            .is_none());
        let refused_input = {
            let supervisor = supervisor.clone();
            let soul = soul.clone();
            tokio::spawn(async move {
                Box::pin(assert_stopped_input_refused(&supervisor, &soul)).await;
            })
        };
        tokio::time::timeout(Duration::from_secs(5), refused_input)
            .await
            .expect("stopped input refusal must complete without host IPC")
            .unwrap();
        let conn = Connection::open(registry.database_path()).unwrap();
        let counts: (u64, u64, u64) = conn.query_row("SELECT (SELECT count(*) FROM souls),(SELECT count(*) FROM baseline_stop_effects),(SELECT count(*) FROM input_commands)", [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap();
        assert_eq!(
            counts,
            (initial_souls, 0, 0),
            "no fresh soul, transient LIVE or input journal entry"
        );
        let generation: u64 = conn
            .query_row(
                "SELECT execution_generation FROM incarnations WHERE incarnation_id=?1",
                [replacement.prepared.incarnation_id.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            generation, 1,
            "Stop cannot mint another execution generation"
        );
        let observation: Option<String> = conn
            .query_row(
                "SELECT native_identity_observation FROM incarnations WHERE incarnation_id=?1",
                [replacement.prepared.incarnation_id.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            observation.is_none(),
            "late observation must not publish after Stop"
        );
        let verdict: String = conn
            .query_row(
                "SELECT verdict FROM recovery_attempts WHERE attempt_id=?1",
                [reserved.reserved_attempt_id.unwrap().as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(verdict, "cancelled");
        let writers: u64 = conn
            .query_row(
                "SELECT count(*) FROM writer_claims WHERE soul_id=?1",
                [soul.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(writers, 0);
        let events: Vec<serde_json::Value> =
            std::fs::read_to_string(&supervisor.config.lifecycle_log)
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
        assert!(events.iter().any(|event| event["event"]
            == "supervisor.native_startup_wait_finished"
            && event["data"]["outcome"] == "stop_intent"));
        eprintln!(
            "{}",
            serde_json::json!({"severity":"info", "event":"task007.baseline_only_stop.completed", "currentReads":backend.count("baseline-current-reads"), "lateObservations":backend.count("baseline-late-observations"), "executionGrants":backend.count("baseline-grants"), "preparedEnclosures":backend.count("creates"), "runningIntentRevision":revision, "stoppedIntentRevision":after.intent_revision, "writerClaims":writers, "liveTransitions":counts.1, "inputEntries":counts.2, "stopOutcome":"verified_empty", "attemptVerdict":verdict})
        );
        close_retry_hosts(&backend).await;
        after
    }

    async fn assert_stopped_input_refused(supervisor: &Supervisor, soul: &SoulId) {
        use freshell_runtime_protocol::{
            AdminCommand, ControlRole, RequestId, TerminalInputRequest,
        };
        let mut input = Envelope::new(
            RequestId::new(),
            ControlRole::Web,
            AdminCommand::TerminalInput(TerminalInputRequest {
                soul_id: soul.clone(),
                data: "fictional input must be refused".into(),
                expected_control_epoch: Some(supervisor.registry.control_epoch()),
            }),
        );
        input.auth = Some(supervisor.config.control_secret.clone());
        assert!(
            Box::pin(supervisor.dispatch(input)).await.result.is_err(),
            "stopped repaired soul must refuse input before host IPC"
        );
    }

    async fn close_retry_hosts(backend: &RetryBackend) {
        let hosts = backend
            .hosts
            .lock()
            .unwrap()
            .drain(..)
            .map(|(_, task)| task)
            .collect::<Vec<_>>();
        for task in hosts {
            task.abort();
            let _ = task.await;
        }
    }

    fn uncommitted_replacement<'a>(
        supervisor: &'a Supervisor,
        backend: &'a RetryBackend,
        soul: &'a SoulId,
    ) -> impl std::future::Future<Output = (IncarnationId, PathBuf, String)> + Send + 'a {
        // Allocate this shared setup future before callers retain it across
        // the recovery passes and reopen assertions on default test stacks.
        Box::pin(async move {
            let original = supervisor
                .registry
                .recovery_context(soul.clone())
                .await
                .unwrap();
            supervisor
                .registry
                .reserve_due_recovery_retry(
                    soul.clone(),
                    original.intent_revision,
                    supervisor.registry.recovery_now_ms(),
                )
                .await
                .unwrap()
                .unwrap();
            let start = supervisor
                .registry
                .begin_recovery(
                    soul.clone(),
                    RecoveryTrigger::ProviderExit,
                    RecoveryPath::NativeResume,
                )
                .await
                .unwrap();
            supervisor
                .registry
                .mark_stop_outcome(
                    original.prior_handle.incarnation_id().clone(),
                    StopOutcome::VerifiedEmpty,
                )
                .await
                .unwrap();
            let replacement = supervisor
                .registry
                .prepare_replacement(
                    start,
                    original.terminal,
                    original.fresh_agent,
                    original.resume_spec,
                    RecoveryPath::NativeResume,
                )
                .await
                .unwrap();
            let incarnation = replacement.prepared.incarnation_id;
            let runtime = supervisor.config.runtime_root.join(incarnation.as_str());
            std::fs::create_dir_all(&runtime).unwrap();
            let created = backend
                .create_stopped(&CreateRuntimeSpec {
                    initial_input_reservation: None,
                    prior_provider_owner: None,
                    installation_id: supervisor.registry.installation_id().clone(),
                    soul_id: soul.clone(),
                    incarnation_id: incarnation.clone(),
                    image_ref: supervisor.config.image_ref.clone(),
                    host_binary_path: supervisor.config.host_binary_path.clone(),
                    runtime_dir: runtime.clone(),
                    limits: original.requested_limits,
                    test_run_id: "retry-uncommitted".into(),
                    terminal: None,
                    fresh_agent: None,
                    opencode_transfer_dir: None,
                    provider_volume_name: "retry-volume".into(),
                })
                .await
                .unwrap();
            // Model the exact persisted boundary without aborting a host process:
            // create returned, but ownership was never committed to the registry.
            (incarnation, runtime, created.container_id)
        })
    }

    fn assert_uncommitted_object_quarantined(
        supervisor: &Supervisor,
        backend: &RetryBackend,
        incarnation: &IncarnationId,
        runtime: &Path,
        container: &str,
    ) {
        assert_eq!(
            std::fs::read_to_string(runtime.join("fixture-object")).unwrap(),
            container
        );
        assert!(!runtime.join("fixture-started").exists());
        assert!(!runtime.join("fixture-stopped").exists());
        let conn = Connection::open(supervisor.registry.database_path()).unwrap();
        let facts: (String, String, Option<String>, u64, u64, u64) = conn
            .query_row(
                "SELECT launch_state,cleanup_state,container_id,execution_generation,
             (SELECT count(*) FROM writer_claims WHERE incarnation_id=?1),
             (SELECT count(*) FROM admission_reservations WHERE incarnation_id=?1)
             FROM incarnations WHERE incarnation_id=?1",
                [incarnation.as_str()],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            facts,
            (
                "failed".into(),
                "termination_unconfirmed".into(),
                None,
                0,
                0,
                0
            )
        );
        let inspected = std::fs::read_to_string(backend.root.join("inspects")).unwrap_or_default();
        assert!(!inspected.lines().any(|value| value == incarnation.as_str()));
    }

    fn assert_retirement_event(
        root: &Path,
        incarnation: &IncarnationId,
        attempt: &str,
        original: &RecoveryContext,
        current_revision: u64,
    ) {
        let events = std::fs::read_to_string(root.join("lifecycle.jsonl")).unwrap();
        let retired = events
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .find(|event| event["event"] == "supervisor.recovery.interrupted_prepared_retired")
            .unwrap();
        assert_eq!(retired["data"]["incarnationId"], incarnation.as_str());
        assert_eq!(retired["data"]["attemptId"], attempt);
        assert_eq!(retired["data"]["intentRevision"], original.intent_revision);
        assert_eq!(
            retired["data"]["priorIncarnationId"],
            original.prior_handle.incarnation_id().as_str()
        );
        assert_eq!(retired["data"]["currentIntentRevision"], current_revision);
    }

    #[tokio::test]
    async fn retry_uncommitted_replacement_reopens_with_backoff_and_preserves_native_root() {
        let dir = tempfile::tempdir().unwrap();
        let (supervisor, backend, _) = open(dir.path(), 0);
        let soul = seed_native(&supervisor, dir.path()).await;

        let original = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        let (incarnation, runtime, container) =
            uncommitted_replacement(&supervisor, &backend, &soul).await;
        let attempt = attempts(dir.path())[0].0.clone();
        drop(supervisor);
        drop(backend);

        let (supervisor, backend, _) = open(dir.path(), 1_000);
        let report = supervisor.reconcile_startup().await.unwrap();
        assert!(
            report.results.iter().all(|result| result.error.is_none()),
            "{report:?}"
        );
        assert_eq!(due(dir.path()), Some(3_000));
        let retry = supervisor
            .registry
            .recovery_retry(soul.clone(), original.intent_revision)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(retry.attempt_count, 1);
        assert!(retry.reserved_attempt_id.is_none());
        assert_eq!(
            attempts(dir.path()),
            vec![(
                attempt.clone(),
                "interrupted_before_ownership_commit".into()
            )]
        );
        assert_eq!(backend.count("creates"), 1);
        assert_uncommitted_object_quarantined(
            &supervisor,
            &backend,
            &incarnation,
            &runtime,
            &container,
        );
        let events = std::fs::read_to_string(dir.path().join("lifecycle.jsonl")).unwrap();
        assert_retirement_event(
            dir.path(),
            &incarnation,
            &attempt,
            &original,
            original.intent_revision,
        );
        let scheduled: serde_json::Value = events
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .find(|event| event["event"] == "supervisor.recovery_retry.scheduled")
            .unwrap();
        assert_eq!(scheduled["data"]["attemptCount"], 1);
        assert_eq!(scheduled["data"]["nextDueAtMs"], 3_000);
        assert_eq!(scheduled["data"]["reason"], "ownership_not_committed");
        assert_eq!(scheduled["data"]["severity"], "info");
        drop(supervisor);
        drop(backend);

        let (supervisor, backend, clock) = open(dir.path(), 2_000);
        supervisor.reconcile_startup().await.unwrap();
        assert_eq!(due(dir.path()), Some(3_000));
        assert_eq!(backend.count("creates"), 1);
        clock.store(3_000, Ordering::SeqCst);
        supervisor.observe_once().await.unwrap();
        let current = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        assert_eq!(current.recovery_state, RecoveryState::Live);
        assert_eq!(current.intent_revision, original.intent_revision);
        assert_ne!(current.prior_handle.incarnation_id(), &incarnation);
        assert_ne!(current.prior_handle.container_id(), container);
        assert_eq!(backend.count("creates"), 2);
        assert_eq!(attempts(dir.path()).len(), 2);
        assert_eq!(attempts(dir.path())[1].1, "succeeded");
        assert_eq!(due(dir.path()), None);
        assert_root_and_successes(&supervisor, &soul, 1).await;
        assert_uncommitted_object_quarantined(
            &supervisor,
            &backend,
            &incarnation,
            &runtime,
            &container,
        );
        close_retry_hosts(&backend).await;
    }

    #[tokio::test]
    async fn retired_unowned_replacement_settles_dependency_failure_across_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let (supervisor, backend, _) = open(dir.path(), 0);
        let soul = seed_native(&supervisor, dir.path()).await;

        let original = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        let (incarnation, runtime, container) =
            uncommitted_replacement(&supervisor, &backend, &soul).await;
        drop(supervisor);
        drop(backend);

        let (supervisor, backend, clock) = open(dir.path(), 1_000);
        supervisor.reconcile_startup().await.unwrap();
        assert_eq!(due(dir.path()), Some(3_000));
        backend.unavailable(true);
        clock.store(3_000, Ordering::SeqCst);
        let report = supervisor.reconcile_startup().await.unwrap();
        assert!(
            report.results.iter().all(|result| result.error.is_none()),
            "{report:?}"
        );
        let blocked = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        assert_eq!(blocked.recovery_state, RecoveryState::Blocked);
        assert_eq!(
            blocked.prior_handle.incarnation_id(),
            original.prior_handle.incarnation_id()
        );
        let settled = supervisor
            .registry
            .recovery_retry(soul.clone(), original.intent_revision)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(settled.attempt_count, 2);
        assert!(settled.reserved_attempt_id.is_none());
        assert_eq!(settled.next_due_at_ms, Some(13_000));
        assert_eq!(settled.last_reason, "backend_unavailable");
        let journals = attempts(dir.path());
        assert_eq!(journals.len(), 2);
        assert_eq!(journals[1].1, "blocked");
        assert_uncommitted_object_quarantined(
            &supervisor,
            &backend,
            &incarnation,
            &runtime,
            &container,
        );
        drop(supervisor);
        drop(backend);

        let (supervisor, backend, clock) = open(dir.path(), 4_000);
        supervisor.reconcile_startup().await.unwrap();
        supervisor.observe_once().await.unwrap();
        assert_eq!(attempts(dir.path()), journals);
        assert_eq!(
            supervisor
                .registry
                .recovery_retry(soul.clone(), original.intent_revision)
                .await
                .unwrap()
                .unwrap(),
            settled
        );
        assert_eq!(backend.count("creates"), 1);
        backend.unavailable(false);
        clock.store(13_000, Ordering::SeqCst);
        supervisor.observe_once().await.unwrap();
        let recovered = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        assert_eq!(recovered.recovery_state, RecoveryState::Live);
        assert_eq!(recovered.native_session_id, original.native_session_id);
        assert_eq!(recovered.provider_store_id, original.provider_store_id);
        assert_eq!(recovered.intent_revision, original.intent_revision);
        assert_eq!(backend.count("creates"), 2);
        assert_eq!(attempts(dir.path()).len(), 3);
        assert_eq!(attempts(dir.path())[2].1, "succeeded");
        assert_eq!(due(dir.path()), None);
        assert_root_and_successes(&supervisor, &soul, 1).await;
        assert_uncommitted_object_quarantined(
            &supervisor,
            &backend,
            &incarnation,
            &runtime,
            &container,
        );
        close_retry_hosts(&backend).await;
    }

    #[tokio::test]
    async fn retry_uncommitted_replacements_preserve_three_attempt_exhaustion() {
        let dir = tempfile::tempdir().unwrap();
        let (supervisor, backend, clock) = open(dir.path(), 0);
        let soul = seed(&supervisor).await;
        for (count, now, expected_due) in [
            (1, 0, Some(2_000)),
            (2, 2_000, Some(12_000)),
            (3, 12_000, None),
        ] {
            clock.store(now, Ordering::SeqCst);
            let (incarnation, runtime, container) =
                uncommitted_replacement(&supervisor, &backend, &soul).await;
            supervisor.reconcile_startup().await.unwrap();
            assert_eq!(due(dir.path()), expected_due);
            assert_eq!(attempts(dir.path()).len(), count);
            assert_uncommitted_object_quarantined(
                &supervisor,
                &backend,
                &incarnation,
                &runtime,
                &container,
            );
        }
        drop(supervisor);
        drop(backend);
        let (supervisor, backend, _) = open(dir.path(), 1_000_000);
        supervisor.reconcile_startup().await.unwrap();
        supervisor.observe_once().await.unwrap();
        assert_eq!(attempts(dir.path()).len(), 3);
        assert_eq!(backend.count("creates"), 3);
        assert_eq!(due(dir.path()), None);
        assert!(supervisor
            .registry
            .inventory()
            .await
            .unwrap()
            .iter()
            .any(|view| view.soul_id == soul
                && view.recovery_reason.as_deref() == Some("RETRY_BUDGET")));
        assert_root_and_successes(&supervisor, &soul, 0).await;
    }

    #[tokio::test]
    async fn retry_uncommitted_legacy_journal_consumes_its_existing_attempt() {
        let dir = tempfile::tempdir().unwrap();
        let (supervisor, backend, _) = open(dir.path(), 0);
        let soul = seed(&supervisor).await;
        let (incarnation, runtime, container) =
            uncommitted_replacement(&supervisor, &backend, &soul).await;
        // The unfinished pre-migration journal still represents a spent try.
        Connection::open(supervisor.registry.database_path())
            .unwrap()
            .execute("DELETE FROM recovery_retries", [])
            .unwrap();
        drop(supervisor);
        drop(backend);
        let (supervisor, backend, _) = open(dir.path(), 1_000);
        supervisor.reconcile_startup().await.unwrap();
        assert_eq!(backend.count("creates"), 1);
        assert_eq!(attempts(dir.path()).len(), 1);
        assert_eq!(due(dir.path()), Some(3_000));
        assert_uncommitted_object_quarantined(
            &supervisor,
            &backend,
            &incarnation,
            &runtime,
            &container,
        );
        close_retry_hosts(&backend).await;
    }

    #[tokio::test]
    async fn retry_uncommitted_old_intent_cannot_cancel_current_reservation() {
        let dir = tempfile::tempdir().unwrap();
        let (supervisor, backend, clock) = open(dir.path(), 0);
        let soul = seed(&supervisor).await;
        let original = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        let (incarnation, runtime, container) =
            uncommitted_replacement(&supervisor, &backend, &soul).await;
        let revision = supervisor
            .registry
            .rearm_recovery_retry(soul.clone(), original.intent_revision)
            .await
            .unwrap();
        let retired_attempt = attempts(dir.path())[0].0.clone();
        clock.store(1_000, Ordering::SeqCst);
        let reserved = supervisor
            .registry
            .reserve_due_recovery_retry(soul.clone(), revision, 1_000)
            .await
            .unwrap()
            .unwrap();
        assert!(supervisor
            .recover(RecoverRequest {
                soul_id: soul.clone(),
                trigger: RecoveryTrigger::StartupReconcile,
                expected_intent_revision: Some(original.intent_revision),
                expected_control_epoch: Some(supervisor.registry.control_epoch()),
            })
            .await
            .is_err());
        assert_eq!(backend.count("creates"), 1);
        let result = supervisor
            .recover(RecoverRequest {
                soul_id: soul.clone(),
                trigger: RecoveryTrigger::StartupReconcile,
                expected_intent_revision: Some(revision),
                expected_control_epoch: Some(supervisor.registry.control_epoch()),
            })
            .await
            .unwrap();
        assert_eq!(result.outcome, RecoveryOutcome::Replaced);
        assert_eq!(
            attempts(dir.path())[1],
            (
                reserved.reserved_attempt_id.unwrap().to_string(),
                "succeeded".into()
            )
        );
        assert_eq!(result.view.intent_revision, revision);
        assert_retirement_event(
            dir.path(),
            &incarnation,
            &retired_attempt,
            &original,
            revision,
        );
        assert_uncommitted_object_quarantined(
            &supervisor,
            &backend,
            &incarnation,
            &runtime,
            &container,
        );
        close_retry_hosts(&backend).await;
    }

    #[tokio::test]
    async fn retry_uncommitted_replacement_retirement_never_rearms_stop() {
        let dir = tempfile::tempdir().unwrap();
        let (supervisor, backend, clock) = open(dir.path(), 0);
        let soul = seed(&supervisor).await;
        let original = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        let (incarnation, runtime, container) =
            uncommitted_replacement(&supervisor, &backend, &soul).await;
        supervisor
            .registry
            .retire_unowned_prepared_replacement(soul.clone())
            .await
            .unwrap();
        assert_uncommitted_object_quarantined(
            &supervisor,
            &backend,
            &incarnation,
            &runtime,
            &container,
        );
        // Stop commits its durable intent even when it cannot issue a handle
        // for the quarantined object's missing ownership record.
        assert!(supervisor.registry.begin_stop(soul.clone()).await.is_err());
        clock.store(1_000_000, Ordering::SeqCst);
        supervisor.reconcile_startup().await.unwrap();
        supervisor.observe_once().await.unwrap();
        let context = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        assert_eq!(context.desired_state, DesiredState::Stopped);
        assert_eq!(context.intent_revision, original.intent_revision + 1);
        assert_eq!(context.recovery_state, RecoveryState::Stopped);
        assert_eq!(backend.count("creates"), 1);
        assert_eq!(attempts(dir.path()).len(), 1);
        assert_eq!(due(dir.path()), None);
        assert_eq!(
            std::fs::read_to_string(runtime.join("fixture-object")).unwrap(),
            container
        );
        assert!(!runtime.join("fixture-started").exists());
        assert!(!runtime.join("fixture-stopped").exists());
        close_retry_hosts(&backend).await;
    }

    #[tokio::test]
    async fn retry_resumes_owned_created_and_starting_replacements_without_creation() {
        for starting in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let ReservedReplacement {
                supervisor,
                backend,
                soul,
                original_intent_revision: _,
                attempt_id,
                handle,
            } = reserved_replacement(dir.path(), starting).await;
            close_retry_hosts(&backend).await;
            drop(supervisor);
            drop(backend);
            let (supervisor, backend, _) = open(dir.path(), 1_000);
            let report = supervisor.reconcile_startup().await.unwrap();
            let current = supervisor
                .registry
                .recovery_context(soul.clone())
                .await
                .unwrap();
            assert_eq!(
                current.recovery_state,
                RecoveryState::Live,
                "starting={starting}: {report:?}"
            );
            assert_eq!(
                current.prior_handle.incarnation_id(),
                handle.incarnation_id()
            );
            assert_eq!(current.prior_handle.container_id(), handle.container_id());
            assert_eq!(backend.count("creates"), 1);
            assert_eq!(attempts(dir.path()), vec![(attempt_id, "succeeded".into())]);
            assert_root_and_successes(&supervisor, &soul, 1).await;
            close_retry_hosts(&backend).await;
        }
    }

    #[tokio::test]
    async fn ordinary_stop_cancels_reserved_created_and_starting_replacements() {
        for starting in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let ReservedReplacement {
                supervisor,
                backend,
                soul,
                original_intent_revision,
                attempt_id,
                handle,
            } = reserved_replacement(dir.path(), starting).await;
            let stop = supervisor.registry.begin_stop(soul.clone()).await.unwrap();
            assert_eq!(stop.incarnation_id(), handle.incarnation_id());
            assert!(supervisor
                .registry
                .recovery_retry(soul.clone(), original_intent_revision)
                .await
                .unwrap()
                .is_none());
            close_retry_hosts(&backend).await;
            drop(supervisor);
            drop(backend);
            let (supervisor, backend, _) = open(dir.path(), 1_000);
            let report = supervisor.reconcile_startup().await.unwrap();
            assert!(
                report.results.iter().all(|result| result.error.is_none()),
                "{report:?}"
            );
            let current = supervisor
                .registry
                .recovery_context(soul.clone())
                .await
                .unwrap();
            assert_eq!(current.desired_state, DesiredState::Stopped);
            assert_eq!(
                current.intent_revision,
                stop.stop_fence().unwrap().intent_revision
            );
            assert_eq!(
                current.prior_handle.incarnation_id(),
                handle.incarnation_id()
            );
            assert_eq!(current.prior_handle.container_id(), handle.container_id());
            assert_eq!(backend.count("creates"), 1);
            assert_eq!(attempts(dir.path()), vec![(attempt_id, "cancelled".into())]);
            assert!(supervisor
                .registry
                .pending_stop_handles()
                .await
                .unwrap()
                .is_empty());
            assert_root_and_successes(&supervisor, &soul, 0).await;
            let conn = Connection::open(supervisor.registry.database_path()).unwrap();
            let (generation, writers): (u64,u64) = conn.query_row(
                "SELECT execution_generation,(SELECT count(*) FROM writer_claims WHERE soul_id=?1) FROM incarnations WHERE incarnation_id=?2",
                rusqlite::params![soul.as_str(), handle.incarnation_id().as_str()], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
            assert_eq!(generation, u64::from(starting));
            assert_eq!(writers, 0);
            assert_eq!(
                backend.inspect(&handle).await.unwrap().state,
                if starting {
                    BackendRuntimeState::Exited
                } else {
                    BackendRuntimeState::Created
                }
            );
            assert_eq!(
                handle.runtime_dir().join("fixture-started").exists(),
                starting
            );
            close_retry_hosts(&backend).await;
        }
    }

    #[tokio::test]
    async fn retry_schema14_upgrade_preserves_identity_and_schedules_after_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let (supervisor, backend, _) = open(dir.path(), 0);
        let soul = seed(&supervisor).await;
        let original = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        let conn = Connection::open(supervisor.registry.database_path()).unwrap();
        conn.execute_batch("DROP TRIGGER cancel_recovery_retry_on_intent; DROP TABLE recovery_retries; UPDATE installation SET schema_version=14;").unwrap();
        drop(conn);
        drop(supervisor);
        drop(backend);
        let (supervisor, backend, _) = open(dir.path(), 0);
        backend.unavailable(true);
        supervisor.reconcile_startup().await.unwrap();
        let migrated = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        assert_eq!(
            migrated.prior_handle.incarnation_id(),
            original.prior_handle.incarnation_id()
        );
        assert_eq!(migrated.native_session_id, original.native_session_id);
        assert_eq!(migrated.resume_spec, original.resume_spec);
        assert_eq!(due(dir.path()), Some(2_000));
        drop(supervisor);
        drop(backend);
        let (supervisor, backend, _) = open(dir.path(), 1_000);
        supervisor.reconcile_startup().await.unwrap();
        assert_eq!(backend.count("inspects"), 1);
    }

    #[tokio::test]
    async fn retry_deadlines_follow_settlement_and_duplicate_completion_is_inert() {
        let dir = tempfile::tempdir().unwrap();
        let (supervisor, _, _) = open(dir.path(), 0);
        let soul = seed(&supervisor).await;
        let revision = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap()
            .intent_revision;
        let first = supervisor
            .registry
            .reserve_due_recovery_retry(soul.clone(), revision, 0)
            .await
            .unwrap()
            .unwrap();
        let first_id = first.reserved_attempt_id.unwrap();
        supervisor
            .registry
            .settle_recovery_retry(soul.clone(), revision, first_id.clone(), true, false, 1_500)
            .await
            .unwrap();
        assert_eq!(due(dir.path()), Some(3_500));
        supervisor
            .registry
            .settle_recovery_retry(soul.clone(), revision, first_id, true, false, 9_000)
            .await
            .unwrap();
        assert_eq!(due(dir.path()), Some(3_500));
        assert!(supervisor
            .registry
            .reserve_due_recovery_retry(soul.clone(), revision, 3_499)
            .await
            .unwrap()
            .is_none());
        let second = supervisor
            .registry
            .reserve_due_recovery_retry(soul.clone(), revision, 3_500)
            .await
            .unwrap()
            .unwrap();
        supervisor
            .registry
            .settle_recovery_retry(
                soul.clone(),
                revision,
                second.reserved_attempt_id.unwrap(),
                true,
                false,
                6_000,
            )
            .await
            .unwrap();
        assert_eq!(due(dir.path()), Some(16_000));
        let third = supervisor
            .registry
            .reserve_due_recovery_retry(soul.clone(), revision, 16_000)
            .await
            .unwrap()
            .unwrap();
        supervisor
            .registry
            .settle_recovery_retry(
                soul.clone(),
                revision,
                third.reserved_attempt_id.unwrap(),
                true,
                false,
                -1_000,
            )
            .await
            .unwrap();
        assert_eq!(due(dir.path()), None);
        assert!(supervisor
            .registry
            .reserve_due_recovery_retry(soul, revision, i64::MAX)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn retry_settlement_rejects_conflicting_attempt_and_unverified_success() {
        for conflicting in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let (supervisor, _, _) = open(dir.path(), 0);
            let soul = seed(&supervisor).await;
            let revision = supervisor
                .registry
                .recovery_context(soul.clone())
                .await
                .unwrap()
                .intent_revision;
            let reserved = supervisor
                .registry
                .reserve_due_recovery_retry(soul.clone(), revision, 0)
                .await
                .unwrap()
                .unwrap();
            let attempt = reserved.reserved_attempt_id.clone().unwrap();
            let current_attempt = if conflicting {
                let newer = RecoveryAttemptId::new();
                let conn = Connection::open(supervisor.registry.database_path()).unwrap();
                conn.execute("INSERT INTO recovery_attempts(attempt_id,soul_id,prior_incarnation_id,intent_revision,path,verdict,started_at) SELECT ?1,soul_id,prior_incarnation_id,intent_revision,path,'started',1 FROM recovery_attempts WHERE attempt_id=?2", rusqlite::params![newer.as_str(),attempt.as_str()]).unwrap();
                conn.execute(
                    "UPDATE souls SET recovery_attempt_id=?1 WHERE soul_id=?2",
                    rusqlite::params![newer.as_str(), soul.as_str()],
                )
                .unwrap();
                newer
            } else {
                attempt.clone()
            };
            supervisor
                .registry
                .settle_recovery_retry(
                    soul.clone(),
                    revision,
                    attempt,
                    conflicting,
                    !conflicting,
                    1_000,
                )
                .await
                .unwrap();
            assert_eq!(
                supervisor
                    .registry
                    .recovery_retry(soul.clone(), revision)
                    .await
                    .unwrap(),
                Some(reserved),
                "a conflicting attempt or unverified success must not settle the reservation"
            );
            let context = supervisor
                .registry
                .recovery_context(soul.clone())
                .await
                .unwrap();
            assert_eq!(context.recovery_attempt_id, Some(current_attempt));
            assert_eq!(context.recovery_state, RecoveryState::Recovering);
            assert_eq!(attempts(dir.path())[0].1, "started");
            assert_root_and_successes(&supervisor, &soul, 0).await;
        }
    }

    #[test]
    fn retry_subprocess_driver() {
        let Some(root) = std::env::var_os("FRESHELL_RETRY_TEST_ROOT") else {
            return;
        };
        assert_eq!(
            std::env::var("FRESHELL_SANDBOX_MODE").as_deref(),
            Ok("runtime-suite")
        );
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let (supervisor, _, _) = open(Path::new(&root), 0);
            supervisor.reconcile_startup().await.unwrap();
            panic!("requested production crash boundary was not reached");
        });
    }
    async fn crash_case(point: &str) {
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(
            std::env::var("FRESHELL_SANDBOX_MODE").as_deref(),
            Ok("runtime-suite")
        );
        assert!(Path::new("/.dockerenv").exists());
        let dir = tempfile::tempdir().unwrap();
        let (supervisor, backend, _) = open(dir.path(), 0);
        let soul = seed(&supervisor).await;
        backend.unavailable(point != "after_replacement_before_settlement");
        drop(supervisor);
        drop(backend);
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "recovery::automatic_retry_tests::retry_subprocess_driver",
                "--exact",
                "--nocapture",
            ])
            .env("FRESHELL_RETRY_TEST_ROOT", dir.path())
            .env("FRESHELL_RETRY_TEST_CRASH", point)
            .output()
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("crash-boundary"))
                .ok()
                .as_deref(),
            Some(point),
            "{}",
            String::from_utf8_lossy(&child.stderr)
        );
        assert_eq!(
            child.status.signal(),
            Some(6),
            "child must actually abort at the named boundary"
        );
        let prior_attempts = attempts(dir.path());
        assert_eq!(
            prior_attempts.len(),
            usize::from(point != "before_reservation"),
            "reservation must be durable before provider work"
        );
        let (supervisor, backend, _) = open(dir.path(), 1_000);
        let before = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        let owned = before.prior_handle.clone();
        supervisor.reconcile_startup().await.unwrap();
        let after = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        if point == "after_replacement_before_settlement" {
            assert_eq!(after.recovery_state, RecoveryState::Live);
            assert_eq!(after.prior_handle.incarnation_id(), owned.incarnation_id());
            assert_eq!(after.prior_handle.container_id(), owned.container_id());
            assert_eq!(
                backend.count("creates"),
                1,
                "restart must adopt the exact owned replacement"
            );
            assert_eq!(
                attempts(dir.path()),
                vec![(prior_attempts[0].0.clone(), "succeeded".into())]
            );
            assert_root_and_successes(&supervisor, &soul, 1).await;
        } else {
            assert_eq!(attempts(dir.path()).len(), 1);
            if !prior_attempts.is_empty() {
                assert_eq!(attempts(dir.path())[0].0, prior_attempts[0].0);
            }
            assert_eq!(backend.count("creates"), 0);
            assert_eq!(
                due(dir.path()),
                Some(if point == "after_settlement" {
                    2_000
                } else {
                    3_000
                })
            );
            assert_root_and_successes(&supervisor, &soul, 0).await;
        }
        drop(supervisor);
        drop(backend);
        let (supervisor, backend, _) = open(dir.path(), 1_500);
        supervisor.reconcile_startup().await.unwrap();
        assert_root_and_successes(
            &supervisor,
            &soul,
            u64::from(point == "after_replacement_before_settlement"),
        )
        .await;
        assert_eq!(
            backend.count("creates"),
            usize::from(point == "after_replacement_before_settlement")
        );
    }
    #[tokio::test]
    #[ignore = "destructive subprocess crash; Docker --runtime-suite sandbox only"]
    async fn automatic_retry_crash_before_reservation() {
        crash_case("before_reservation").await;
    }
    #[tokio::test]
    #[ignore = "destructive subprocess crash; Docker --runtime-suite sandbox only"]
    async fn automatic_retry_crash_after_reservation_before_dispatch() {
        crash_case("after_reservation_before_dispatch").await;
    }
    #[tokio::test]
    #[ignore = "destructive subprocess crash; Docker --runtime-suite sandbox only"]
    async fn automatic_retry_crash_after_replacement_before_settlement() {
        crash_case("after_replacement_before_settlement").await;
    }
    #[tokio::test]
    #[ignore = "destructive subprocess crash; Docker --runtime-suite sandbox only"]
    async fn automatic_retry_crash_after_settlement() {
        crash_case("after_settlement").await;
    }
}

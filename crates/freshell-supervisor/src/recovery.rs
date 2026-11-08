//! Serialized automatic recovery for managed souls.
//!
//! Replacement ordering is intentionally strict:
//! probe -> durable recovery attempt -> stop exact owned enclosure -> verify
//! empty -> prepare one replacement claim -> exact resume -> verify the native
//! identity -> publish LIVE. No branch can substitute a fresh provider session
//! for a failed native resume.

use crate::{
    backend::{BackendError, BackendRuntimeState, StoppedOpenCodeRepairReceipts},
    checkpoints,
    loss_report::{
        hash_loss_certificate, path_name, IncidentExporter, LossDecisionInput, LostDecision,
    },
    registry::{
        NativeImportState, OwnedRuntimeHandle, RecoveryContext, RecoveryWriteFence, RegistryError,
        StoppedRepairOwnerCandidate, StoppedRepairRootReceipt,
    },
    resume_catalog,
    service::{LaunchWorkload, Supervisor},
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
    export_exact_session, ExportOptions, HostOpenCodeInventory, OpenCodeNativeSnapshot,
};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::time::{sleep, Duration, Instant};

#[derive(Debug, Clone, PartialEq, Eq)]
enum NativeIdentityWait {
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
const OPENCODE_ADOPTION_READINESS_TIMEOUT: Duration = Duration::from_secs(180);

fn native_identity_wait_timeout(opencode_adoption_required: bool) -> Duration {
    if opencode_adoption_required {
        OPENCODE_ADOPTION_READINESS_TIMEOUT
    } else {
        NATIVE_IDENTITY_STARTUP_TIMEOUT
    }
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
enum CanonicalRootOwnerSelection<'a> {
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

fn choose_canonical_root_owner<'a>(
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
    operation_id: freshell_runtime_protocol::RequestId,
    target_count: usize,
    progress: BTreeMap<String, RestoreLostSoulRootResult>,
) -> RestoreLostSoulsResult {
    RestoreLostSoulsResult {
        operation_id,
        status: SoulRepairStatus::Pending,
        repaired_target_count: 0,
        total_target_count: target_count as u32,
        roots: progress.into_values().collect(),
    }
}

fn owner_decision_stopped_repair_result(
    operation_id: freshell_runtime_protocol::RequestId,
    target_count: usize,
    progress: BTreeMap<String, RestoreLostSoulRootResult>,
) -> RestoreLostSoulsResult {
    RestoreLostSoulsResult {
        operation_id,
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
) -> Result<(), String> {
    let file = descriptor
        .files
        .first()
        .ok_or_else(|| "stopped repair has no payload file".to_string())?;
    let mut payload = snapshot
        .open_payload()
        .map_err(|_| "source payload cannot be reopened".to_string())?;
    let mut offset = 0_u64;
    let mut sequence = 0_u64;
    while offset < file.size_bytes {
        let chunk_size =
            (file.size_bytes - offset).min(MAX_OPENCODE_TRANSFER_CHUNK_BYTES as u64) as usize;
        let mut data = vec![0; chunk_size];
        payload
            .read_exact(&mut data)
            .map_err(|_| "source payload ended before its manifest size".to_string())?;
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
        || imported.asset_count != manifest.assets.len() as u64
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
    pub(crate) async fn restore_lost_souls(
        &self,
        operation_id: freshell_runtime_protocol::RequestId,
        request: RestoreLostSoulsRequest,
    ) -> Result<RestoreLostSoulsResult, RuntimeError> {
        request.validate_exact_batch()?;
        let targets = request.targets.clone();
        let owner_choices = request
            .canonical_owners
            .iter()
            .map(|choice| (choice.root_session_id.clone(), choice.soul_id.clone()))
            .collect::<BTreeMap<_, _>>();
        let operation = self
            .registry
            .prepare_stopped_repair_operation(operation_id.clone(), request)
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

        let mut groups = BTreeMap::<
            String,
            Vec<(
                freshell_runtime_protocol::LostSoulRepairTarget,
                RecoveryContext,
            )>,
        >::new();
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
        if groups.len() != 7 {
            return Ok(pending_stopped_repair_result(
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

        let inventory = match tokio::task::spawn_blocking(
            HostOpenCodeInventory::from_process_environment_discovering_channels,
        )
        .await
        {
            Ok(Ok(inventory)) => inventory,
            _ => {
                return Ok(pending_stopped_repair_result(
                    operation_id,
                    targets.len(),
                    progress,
                ))
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
                operation_id,
                targets.len(),
                progress,
            ));
        }
        if preflight_blocked || prepared_roots.len() != groups.len() {
            return Ok(pending_stopped_repair_result(
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
        if receipts.len() != 7
            || receipts
                .iter()
                .any(|receipt| !verified_roots.iter().any(|current| current == receipt))
        {
            return Ok(pending_stopped_repair_result(
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
        let snapshot = tokio::task::spawn_blocking(move || {
            export_exact_session(
                &source_inventory,
                &root,
                ExportOptions::new(extraction_root),
            )
        })
        .await
        .map_err(|_| stopped_repair_blocked("source_export_worker_failed"))?
        .map_err(|_| stopped_repair_blocked("source_not_exactly_resolvable"))?;
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
        if matches!(begin, crate::opencode_transfer::StagingStart::Queued) {
            drop(lifecycle_guard.take());
            match staging
                .wait_for_capacity(&transfer_id, &attempt_id)
                .await
                .map_err(|_| stopped_repair_blocked("staging_capacity_or_state"))?
            {
                crate::opencode_transfer::StagingStart::Started { .. } => {
                    lifecycle_guard = Some(
                        Arc::clone(&self.opencode_transfer_lifecycle_lock)
                            .lock_owned()
                            .await,
                    );
                }
                crate::opencode_transfer::StagingStart::Queued => {
                    return Err(stopped_repair_blocked("staging_capacity_or_state"));
                }
            }
        }
        if stage_snapshot_payload(&snapshot, &descriptor, &attempt_id, staging).is_err() {
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
            Err(_) => {
                let _ = staging.abort(&transfer_id, &attempt_id);
                return Err(stopped_repair_blocked("provider_reader_or_import_failed"));
            }
        };
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
        let mut context = self
            .registry
            .recovery_context(soul_id)
            .await
            .map_err(map_registry)?;
        let probe = self.probe_recovery_context(&mut context).await?;
        let probe = match probe {
            RecoveryProbe::ResumeReady { resume_spec, .. }
                if context.resume_spec.as_ref() != Some(&*resume_spec) =>
            {
                let stored = self
                    .registry
                    .store_verified_resume_spec_fenced(
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
        Ok((after_native_probe(&context, probe), context))
    }

    async fn probe_recovery_context(
        &self,
        context: &mut RecoveryContext,
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
                ))
            }
            Err(error) => {
                return Ok(blocked(
                    RecoveryPath::Reattach,
                    RecoveryBlockReason::ProviderUnavailable,
                    &error.to_string(),
                    Some(2_000),
                ))
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
                    let status = match self
                        .host_status(
                            context.prior_handle.incarnation_id().clone(),
                            context.prior_handle.runtime_dir(),
                            &host,
                        )
                        .await
                    {
                        Ok(status) => status,
                        Err(_) if context.resume_spec.is_some() => return offline_probe(context),
                        Err(error) => {
                            return Ok(blocked(
                                RecoveryPath::Reattach,
                                RecoveryBlockReason::ProviderUnavailable,
                                &error.message,
                                Some(2_000),
                            ));
                        }
                    };
                    if let Some(native_session_id) = status.native_session_id.as_ref() {
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
                    let candidate = match resume_catalog::exact_resume_candidate(
                        &*context,
                        status.native_session_id.as_deref(),
                    ) {
                        Ok(candidate) => candidate,
                        Err(probe) => return Ok(probe),
                    };
                    let store_fence = context.write_fence();
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
                    let captured = match store_probe {
                        RecoveryProbe::ResumeReady { resume_spec, .. } => {
                            let stored = self
                                .registry
                                .store_verified_resume_spec_fenced(
                                    context.soul_id.clone(),
                                    *resume_spec,
                                    store_fence,
                                )
                                .await
                                .map_err(map_registry)?;
                            context.evidence_revision =
                                context.evidence_revision.max(stored.evidence_revision);
                            context.resume_spec = Some(stored.clone());
                            context.allocation_state = stored.allocation_state;
                            RecoveryProbe::ResumeReady {
                                evidence_revision: stored.evidence_revision,
                                resume_spec: Box::new(stored),
                            }
                        }
                        other => other,
                    };

                    if !status.exited {
                        return Ok(RecoveryProbe::ReattachReady {
                            handle: ReattachHandle {
                                incarnation_id: context.prior_handle.incarnation_id().clone(),
                                host_boot_id: status.host_boot_id,
                                container_id: context.prior_handle.container_id().to_string(),
                            },
                            protocol_version: CONTROL_PROTOCOL_VERSION,
                        });
                    }
                    return Ok(after_native_probe(context, captured));
                }
                Err(_) if context.resume_spec.is_some() => return offline_probe(context),
                Err(error) => {
                    return Ok(blocked(
                        RecoveryPath::Reattach,
                        RecoveryBlockReason::ProviderUnavailable,
                        &error.message,
                        Some(2_000),
                    ))
                }
            }
        }

        if matches!(
            inspection.state,
            BackendRuntimeState::Exited | BackendRuntimeState::Dead | BackendRuntimeState::Missing
        ) {
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
        let lifecycle_lock = self.lifecycle_lock(&request.soul_id).await;
        let _recovery_guard = lifecycle_lock.lock().await;
        self.registry
            .assert_soul_intent_revision(request.soul_id.clone(), request.expected_intent_revision)
            .await
            .map_err(map_registry)?;
        let before_retry = self
            .registry
            .recovery_context(request.soul_id.clone())
            .await
            .map_err(map_registry)?;
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
        }
        if self
            .registry
            .retire_unowned_prepared_replacement(request.soul_id.clone())
            .await
            .map_err(map_registry)?
        {
            crate::service::append_event(
                &self.config.lifecycle_log,
                "supervisor.recovery.interrupted_prepared_retired",
                serde_json::json!({"soulId": request.soul_id}),
            );
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
        let (probe, observed_context) = self
            .probe_recovery_observed(request.soul_id.clone())
            .await?;
        match probe.clone() {
            RecoveryProbe::ReattachReady { handle, .. } => {
                self.registry
                    .mark_recovery_live(
                        request.soul_id.clone(),
                        handle.incarnation_id.clone(),
                        observed_context.write_fence(),
                    )
                    .await
                    .map_err(map_registry)?;
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
            RecoveryProbe::Blocked {
                reason, evidence, ..
            } => {
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
                    .mark_recovery_blocked(
                        request.soul_id.clone(),
                        None,
                        reason,
                        evidence,
                        observed_context.write_fence(),
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
            }
            RecoveryProbe::DefinitivelyUnavailable { .. } => {
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
                let (rechecked, rechecked_context) = self
                    .probe_recovery_observed(request.soul_id.clone())
                    .await?;
                match rechecked.clone() {
                    RecoveryProbe::ReattachReady { handle, .. } => {
                        self.registry
                            .mark_recovery_live(
                                request.soul_id.clone(),
                                handle.incarnation_id.clone(),
                                rechecked_context.write_fence(),
                            )
                            .await
                            .map_err(map_registry)?;
                        Ok(RecoveryResult {
                            outcome: RecoveryOutcome::Reattached,
                            view: self.view_for(&handle.incarnation_id).await?,
                            probe: Some(rechecked),
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
                        self.replace(
                            request.soul_id,
                            request.trigger,
                            path,
                            Some(*resume_spec),
                            rechecked,
                            rechecked_context.write_fence(),
                        )
                        .await
                    }
                    RecoveryProbe::PristineSeedReady { .. } => {
                        self.replace(
                            request.soul_id,
                            request.trigger,
                            RecoveryPath::PristineSeed,
                            None,
                            rechecked,
                            rechecked_context.write_fence(),
                        )
                        .await
                    }
                    RecoveryProbe::Blocked {
                        reason, evidence, ..
                    } => {
                        self.registry
                            .mark_recovery_blocked(
                                request.soul_id.clone(),
                                None,
                                reason,
                                evidence,
                                rechecked_context.write_fence(),
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
                        self.certify_and_cleanup_loss(request.soul_id, request.trigger, rechecked)
                            .await
                    }
                }
            }
            RecoveryProbe::ResumeReady { resume_spec, .. } => {
                let path = if resume_spec.checkpoint_revision > 0 {
                    RecoveryPath::CheckpointRestore
                } else {
                    RecoveryPath::NativeResume
                };
                self.replace(
                    request.soul_id,
                    request.trigger,
                    path,
                    Some(*resume_spec),
                    probe,
                    observed_context.write_fence(),
                )
                .await
            }
            RecoveryProbe::PristineSeedReady { .. } => {
                self.replace(
                    request.soul_id,
                    request.trigger,
                    RecoveryPath::PristineSeed,
                    None,
                    probe,
                    observed_context.write_fence(),
                )
                .await
            }
        }
    }

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

        let replacement_terminal = if resume_spec.is_some() {
            terminal_without_first_boot_state(start.context.terminal.clone())
        } else {
            start.context.terminal.clone()
        };
        let mut replacement_terminal = replacement_terminal;
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
        if let Some(terminal) = replacement_terminal.as_mut() {
            if terminal
                .provider_launch_context
                .as_ref()
                .and_then(|context| context.mcp_capability.as_ref())
                .is_some()
            {
                let tui_source = terminal
                    .provider_launch_context
                    .as_ref()
                    .and_then(|context| {
                        if let freshell_runtime_protocol::ProviderPreparation::Opencode {
                            tui_source,
                            ..
                        } = &context.preparation
                        {
                            tui_source.as_ref()
                        } else {
                            None
                        }
                    });
                let refreshed_capability = self
                    .issue_replacement_mcp_capability(&soul_id, &terminal.mode, tui_source, &terminal.workspace_path)
                    .await
                    .and_then(|reference| {
                        crate::backend::docker::staged_provider_root_for_grant(
                            &reference.grant_id,
                        )
                        .map(|staged_root| (reference, staged_root))
                        .map_err(|error| {
                            RuntimeError::new(
                                    RuntimeErrorCode::HostUnreachable,
                                    format!("capability_pending: staged provider root unavailable: {error}"),
                                )
                        })
                    });
                let (reference, staged_root) = match refreshed_capability {
                    Ok(refreshed) => refreshed,
                    Err(error) => {
                        let reason = RecoveryBlockReason::CapabilityPending;
                        self.registry
                            .mark_recovery_blocked(
                                soul_id.clone(),
                                Some(attempt_id.clone()),
                                reason,
                                vec![error.message.clone()],
                                verdict_fence.clone(),
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
                replace_terminal_mcp_reference(terminal, reference);
                refresh_terminal_provider_config(terminal, &staged_root);
            }
        }
        let prepared = match self
            .registry
            .prepare_replacement(
                start.clone(),
                replacement_terminal,
                fresh_without_raw_bootstrap(start.context.fresh_agent.clone()),
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
        let launch = self
            .activate_prepared_observed(
                prepared.prepared.clone(),
                LaunchWorkload {
                    soul_id: soul_id.clone(),
                    fixture: prepared.fixture,
                    terminal: prepared.terminal.clone(),
                    fresh_agent: prepared.fresh_agent.clone(),
                    resume_spec: prepared.resume_spec.clone(),
                },
                start.context.requested_limits,
                verdict_fence.clone(),
            )
            .await;
        match launch {
            Ok((_, successor)) => {
                verdict_fence = successor;
            }
            Err(error) => {
                let reason = if error.message.starts_with("capability_pending:") {
                    RecoveryBlockReason::CapabilityPending
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
                    .mark_recovery_blocked(
                        soul_id.clone(),
                        Some(attempt_id.clone()),
                        reason,
                        vec![error.message.clone()],
                        verdict_fence.clone(),
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
        let observed_native_session_id = if let Some(expected) =
            expected_native_session_id.as_deref()
        {
            let adoption_required = resume_spec
                .as_ref()
                .is_some_and(|spec| spec.opencode_adoption_baseline.is_some());
            let wait = self
                .wait_for_native_identity(
                    &soul_id,
                    &prepared.prepared.incarnation_id,
                    start.context.intent_revision,
                    native_identity_wait_timeout(adoption_required),
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
            if let Err((reason, message)) = validate_native_identity_wait(expected, wait.clone()) {
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
                    .mark_recovery_blocked(
                        soul_id.clone(),
                        Some(attempt_id.clone()),
                        reason,
                        vec![message.clone()],
                        verdict_fence.clone(),
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

        if let Err(message) = self
            .replay_queued_inputs(soul_id.clone(), prepared.prepared.incarnation_id.clone())
            .await
        {
            self.registry
                .mark_recovery_blocked(
                    soul_id.clone(),
                    Some(attempt_id.clone()),
                    RecoveryBlockReason::CommandAmbiguous,
                    vec![message.clone()],
                    verdict_fence.clone(),
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

        let provider = start.context.provider.clone();
        self.registry
            .mark_recovery_success(
                soul_id,
                prepared.prepared.incarnation_id.clone(),
                attempt_id.clone(),
                verdict_fence,
            )
            .await
            .map_err(map_registry)?;
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
        let decision = match LostDecision::try_new(LossDecisionInput {
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
        }) {
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
        let _notice = self
            .registry
            .finalize_loss_cleanup(incident_id.clone(), outcome, cleanup)
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
                    .mark_recovery_live(soul_id, handle.incarnation_id.clone(), fence)
                    .await
                    .map_err(map_registry)?;
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
                self.replace(soul_id, trigger, path, Some(*resume_spec), probe, fence)
                    .await
            }
            RecoveryProbe::PristineSeedReady { .. } => {
                self.replace(
                    soul_id,
                    trigger,
                    RecoveryPath::PristineSeed,
                    None,
                    probe,
                    fence,
                )
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
                RecoveryPath::NativeResume => match native_probe {
                    RecoveryProbe::DefinitivelyUnavailable {
                        reason,
                        evidence,
                        store_state,
                        ..
                    } => {
                        if matches!(
                            store_state,
                            EvidenceStoreState::Unknown | EvidenceStoreState::PresentUnreadable
                        ) {
                            return Err(blocked(
                                RecoveryPath::NativeResume,
                                RecoveryBlockReason::StoreUnreadable,
                                "native provider state is not definitively readable or missing",
                                None,
                            ));
                        }
                        RecoveryPathEvidence {
                            path: RecoveryPath::NativeResume,
                            verdict: RecoveryEvidenceVerdict::DefinitiveNegative,
                            reason_code: reason.clone(),
                            evidence_refs: evidence.clone(),
                            store_state: *store_state,
                        }
                    }
                    other => return Err(other.clone()),
                },
                RecoveryPath::CheckpointRestore => {
                    match checkpoints::probe_after_provider(context, native_probe) {
                        RecoveryProbe::DefinitivelyUnavailable {
                            reason,
                            evidence,
                            store_state,
                            ..
                        } => RecoveryPathEvidence {
                            path: RecoveryPath::CheckpointRestore,
                            verdict: RecoveryEvidenceVerdict::DefinitiveNegative,
                            reason_code: reason,
                            evidence_refs: evidence,
                            store_state,
                        },
                        other => return Err(other),
                    }
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
            row.evidence_refs = evidence_refs;
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
                    return Err(RecoveryProbe::ReattachReady {
                        handle: ReattachHandle {
                            incarnation_id: context.prior_handle.incarnation_id().clone(),
                            host_boot_id: status.host_boot_id,
                            container_id: context.prior_handle.container_id().to_string(),
                        },
                        protocol_version: CONTROL_PROTOCOL_VERSION,
                    });
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

    /// Resume the incident-before-cleanup pipeline after a supervisor
    /// crash. The incident row and exact cleanup capability were committed
    /// together, so this never discovers authority from Docker-wide state.
    pub async fn reconcile_pending_loss_cleanup(&self) -> Result<(), RuntimeError> {
        self.export_pending_incidents().await?;
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
            self.registry
                .finalize_loss_cleanup(incident_id.clone(), outcome, cleanup)
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
        self.export_pending_incidents().await?;
        Ok(())
    }

    pub(crate) async fn export_pending_incidents(&self) -> Result<(), RuntimeError> {
        let withdrawal_still_pending = match self.resume_pending_stopped_repair_withdrawals().await
        {
            Ok(()) => false,
            Err(error) => {
                crate::service::append_event(
                    &self.config.lifecycle_log,
                    "supervisor.stopped_repair_withdrawal_deferred",
                    serde_json::json!({"error": error.message}),
                );
                true
            }
        };
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
        if withdrawal_still_pending {
            return Err(RuntimeError::new(
                RuntimeErrorCode::IncidentPersistenceFailed,
                "a stopped-repair incident withdrawal remains pending",
            ));
        }
        Ok(())
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
        Ok(outcome)
    }

    async fn wait_for_native_identity(
        &self,
        soul_id: &SoulId,
        incarnation_id: &freshell_runtime_protocol::IncarnationId,
        expected_intent_revision: u64,
        timeout: Duration,
    ) -> NativeIdentityWait {
        let started = Instant::now();
        let handle = match self.registry.owned_handle(incarnation_id.clone()).await {
            Ok(handle) => handle,
            Err(error) => {
                return NativeIdentityWait::HostUnavailable {
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
            let status = match host {
                Ok(host) => self
                    .host_status(handle.incarnation_id().clone(), handle.runtime_dir(), &host)
                    .await
                    .map_err(|error| error.message),
                Err(error) => Err(error.message),
            };
            let current = match self.registry.recovery_context(soul_id.clone()).await {
                Ok(current) => current,
                Err(error) => {
                    return NativeIdentityWait::HostUnavailable {
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
                Err(message) => {
                    return NativeIdentityWait::HostUnavailable {
                        message,
                        elapsed_ms,
                    }
                }
            };
            if let Some(result) = native_identity_wait_from_status(
                status.exited,
                status.native_session_id,
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
            let _ = self.terminate_owned_for_recovery(&handle).await;
        }
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
    match probe {
        RecoveryProbe::PristineSeedReady { .. } if !context.permits_pristine_seed() => blocked(
            RecoveryPath::PristineSeed,
            RecoveryBlockReason::StoreUnreadable,
            "native identity or import prevents pristine seed",
            None,
        ),
        ready @ RecoveryProbe::ResumeReady { .. }
        | ready @ RecoveryProbe::Blocked { .. }
        | ready @ RecoveryProbe::PristineSeedReady { .. }
        | ready @ RecoveryProbe::ReattachReady { .. } => ready,
        RecoveryProbe::DefinitivelyUnavailable {
            reason,
            mut evidence,
            store_state,
            ..
        } => {
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
            match checkpoints::probe_after_provider(
                context,
                &RecoveryProbe::DefinitivelyUnavailable {
                    path: RecoveryPath::NativeResume,
                    reason: reason.clone(),
                    evidence: evidence.clone(),
                    store_state,
                },
            ) {
                blocked @ RecoveryProbe::Blocked { .. } => blocked,
                RecoveryProbe::DefinitivelyUnavailable {
                    reason: checkpoint_reason,
                    evidence: checkpoint_evidence,
                    ..
                } => {
                    evidence.extend(checkpoint_evidence);
                    RecoveryProbe::DefinitivelyUnavailable {
                        path: RecoveryPath::NativeResume,
                        reason: format!(
                            "native resume unavailable ({reason}); checkpoint unavailable ({checkpoint_reason}); pristine seed forbidden after dispatch"
                        ),
                        evidence,
                        store_state,
                    }
                }
                other => other,
            }
        }
    }
}

pub(crate) fn offline_probe(context: &RecoveryContext) -> Result<RecoveryProbe, RuntimeError> {
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
    if let Some(spec) = context.resume_spec.clone() {
        return Ok(RecoveryProbe::ResumeReady {
            evidence_revision: spec.evidence_revision,
            resume_spec: Box::new(spec),
        });
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
            never_dispatched_proof: format!("{}:supervisor-input-journal-empty", context.soul_id),
        });
    }
    match checkpoints::probe(context) {
        blocked_probe @ RecoveryProbe::Blocked { .. } => Ok(blocked_probe),
        RecoveryProbe::DefinitivelyUnavailable {
            mut evidence,
            reason,
            ..
        } => {
            evidence.push("nativeResume=definitively_unavailable".into());
            Ok(RecoveryProbe::DefinitivelyUnavailable {
                path: RecoveryPath::NativeResume,
                reason: format!("native resume unavailable; {reason}"),
                evidence,
                store_state: freshell_runtime_protocol::EvidenceStoreState::Missing,
            })
        }
        other => Ok(other),
    }
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

fn refresh_terminal_provider_config(
    terminal: &mut TerminalLaunchSpec,
    user_root: &std::path::Path,
) {
    let Some(context) = terminal.provider_launch_context.as_mut() else {
        return;
    };
    refresh_provider_context_from_user_root(
        context,
        &terminal.mode,
        std::path::Path::new(&terminal.workspace_path),
        std::path::Path::new(&terminal.cwd),
        user_root,
    );
}

fn replace_terminal_mcp_reference(
    terminal: &mut TerminalLaunchSpec,
    reference: freshell_runtime_protocol::McpCapabilityReference,
) {
    if let Some(context) = terminal.provider_launch_context.as_mut() {
        context.mcp_capability = Some(reference);
    }
}

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
    use super::*;
    use freshell_runtime_protocol::{FreshAgentLaunchSpec, FreshProvider, IncarnationId};

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

    struct ObservedRuntime(BackendRuntimeState);

    #[async_trait::async_trait]
    impl crate::backend::RuntimeBackend for ObservedRuntime {
        async fn inspect(
            &self,
            handle: &OwnedRuntimeHandle,
        ) -> Result<crate::backend::BackendInspection, BackendError> {
            Ok(crate::backend::BackendInspection {
                state: self.0,
                configured_limits: handle.requested_limits(),
            })
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
            std::sync::Arc::new(ObservedRuntime(state)),
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

    pub(crate) fn absent_native_probe() -> RecoveryProbe {
        RecoveryProbe::DefinitivelyUnavailable {
            path: RecoveryPath::NativeResume,
            reason: "synthetic native store absent".into(),
            evidence: vec![],
            store_state: EvidenceStoreState::Missing,
        }
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
        replace_terminal_mcp_reference(
            &mut replacement,
            freshell_runtime_protocol::McpCapabilityReference {
                grant_id: "grant-new".into(),
                endpoint: "http://host.docker.internal:4001".into(),
                provider_relative_path: ".freshell/mcp-capability.json".into(),
                host_gateway_address: None,
            },
        );
        let reference = replacement
            .provider_launch_context
            .unwrap()
            .mcp_capability
            .unwrap();
        assert_eq!(reference.grant_id, "grant-new");
        assert_eq!(reference.endpoint, "http://host.docker.internal:4001");
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
}

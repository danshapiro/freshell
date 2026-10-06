//! Final receipt-fenced correction and crash-safe withdrawal of exact false
//! OpenCode loss records.

use crate::{
    loss_report::{incident_file_coordinator, IncidentExporter},
    notice_outbox::sanitize_false_incident_notices_in_tx,
    registry::{
        now_millis, open_connection, validate_stopped_repair_target_in_tx, Registry, RegistryError,
        StoppedRepairRootReceipt,
    },
    service::Supervisor,
    view_intents::{enqueue_projection, load_view_intent},
};
use freshell_runtime_protocol::{
    LostSoulRepairTarget, RequestId, RestoreLostSoulRootResult, RestoreLostSoulsResult,
    RootRepairImportStatus, SoulId, SoulRepairStatus,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Error as IoError,
    path::PathBuf,
};

struct WithdrawalFileContext {
    db_path: PathBuf,
    incident_root: PathBuf,
    lifecycle_log: PathBuf,
}

impl Registry {
    pub(crate) async fn finalize_stopped_repair_batch(
        &self,
        operation_id: RequestId,
        targets: Vec<LostSoulRepairTarget>,
        roots: Vec<StoppedRepairRootReceipt>,
        incident_root: PathBuf,
        lifecycle_log: PathBuf,
    ) -> Result<RestoreLostSoulsResult, RegistryError> {
        let mut targets = targets;
        targets.sort_by(target_order);
        let mut roots = roots;
        roots.sort_by(|left, right| left.root_session_id.cmp(&right.root_session_id));
        if !valid_exact_targets(&targets)
            || roots.len() != 7
            || roots
                .windows(2)
                .any(|pair| pair[0].root_session_id == pair[1].root_session_id)
        {
            return Err(RegistryError::RequestConflict);
        }
        let expected_targets = targets.clone();
        let db_path = self.database_path().to_path_buf();
        self.run_blocking(move |mut conn| {
            let _file_coordinator = incident_file_coordinator();
            let operation = load_operation(&conn, &operation_id)?;
            validate_operation_targets(&operation, &expected_targets)?;
            match operation.status.as_str() {
                "complete" => {
                    let encoded = operation.result_json.ok_or_else(|| {
                        RegistryError::Integrity(
                            "completed stopped-repair operation has no result".into(),
                        )
                    })?;
                    return serde_json::from_str(&encoded).map_err(RegistryError::from);
                }
                "withdraw_pending" => {
                    let marker = load_withdrawal(&conn, &operation_id)?;
                    validate_withdrawal(&operation, &marker, &expected_targets)?;
                    let persisted_roots = load_root_receipts(&conn, &operation_id)?;
                    validate_exact_receipts(&persisted_roots, &roots)?;
                    return finish_pending_withdrawal(
                        &mut conn,
                        &operation_id,
                        &marker,
                        &expected_targets,
                        &persisted_roots,
                        WithdrawalFileContext {
                            db_path: db_path.clone(),
                            incident_root,
                            lifecycle_log,
                        },
                    );
                }
                "importing" => {}
                _ => {
                    return Err(RegistryError::Integrity(
                        "invalid stopped-repair operation state".into(),
                    ))
                }
            }

            let persisted_roots = load_root_receipts(&conn, &operation_id)?;
            validate_exact_receipts(&persisted_roots, &roots)?;
            let marker = commit_stopped_repair_cas(
                &mut conn,
                &operation_id,
                &expected_targets,
                &persisted_roots,
            )?;
            finish_pending_withdrawal(
                &mut conn,
                &operation_id,
                &marker,
                &expected_targets,
                &persisted_roots,
                WithdrawalFileContext {
                    db_path: db_path.clone(),
                    incident_root,
                    lifecycle_log,
                },
            )
        })
        .await
    }

    pub(crate) async fn resume_pending_stopped_repair_withdrawals(
        &self,
        incident_root: PathBuf,
        lifecycle_log: PathBuf,
    ) -> Result<(), RegistryError> {
        let db_path = self.database_path().to_path_buf();
        self.run_blocking(move |mut conn| {
            let _file_coordinator = incident_file_coordinator();
            let pending = {
                let mut statement = conn.prepare(
                    "SELECT operation_id FROM stopped_repair_operations WHERE status='withdraw_pending' ORDER BY operation_id",
                )?;
                let rows = statement
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                rows
            };
            for raw_id in pending {
                let operation_id = RequestId::parse(raw_id)
                    .map_err(|_| RegistryError::Integrity("invalid stopped-repair operation id".into()))?;
                let operation = load_operation(&conn, &operation_id)?;
                let targets: Vec<LostSoulRepairTarget> = serde_json::from_str(&operation.targets_json)?;
                let marker = load_withdrawal(&conn, &operation_id)?;
                validate_withdrawal(&operation, &marker, &targets)?;
                let roots = load_root_receipts(&conn, &operation_id)?;
                if roots.len() != 7 {
                    return Err(RegistryError::Integrity(
                        "pending stopped-repair withdrawal does not have seven verified roots".into(),
                    ));
                }
                finish_pending_withdrawal(
                    &mut conn,
                    &operation_id,
                    &marker,
                    &targets,
                    &roots,
                    WithdrawalFileContext {
                        db_path: db_path.clone(),
                        incident_root: incident_root.clone(),
                        lifecycle_log: lifecycle_log.clone(),
                    },
                )?;
            }
            Ok(())
        })
        .await
    }
}

#[derive(Debug)]
struct StoredOperation {
    status: String,
    target_fingerprint: String,
    targets_json: String,
    result_json: Option<String>,
}

#[derive(Debug)]
struct WithdrawalMarker {
    generation: String,
    targets_json: String,
    incident_ids_json: String,
    status: String,
}

#[derive(Debug)]
struct TargetFence {
    provider_store_id: String,
    native_session_id: Option<String>,
    native_import_source_store_id: Option<String>,
    native_import_root_session_id: Option<String>,
    native_import_source_generation: Option<String>,
    native_import_schema_fingerprint: Option<String>,
    native_import_migration_fingerprint: Option<String>,
    native_import_state: String,
    native_import_authority: String,
    identity_revision: u64,
    evidence_revision: u64,
    intent_revision: u64,
    native_import_revision: u64,
    loss_incident_id: Option<String>,
    incarnation_id: String,
    execution_generation: u64,
    launch_state: String,
    cleanup_state: String,
}

fn target_order(left: &LostSoulRepairTarget, right: &LostSoulRepairTarget) -> std::cmp::Ordering {
    left.soul_id
        .as_str()
        .cmp(right.soul_id.as_str())
        .then_with(|| left.incident_id.as_str().cmp(right.incident_id.as_str()))
}

fn valid_exact_targets(targets: &[LostSoulRepairTarget]) -> bool {
    freshell_runtime_protocol::RestoreLostSoulsRequest {
        targets: targets.to_vec(),
        canonical_owners: Vec::new(),
        expected_control_epoch: None,
    }
    .validate_exact_batch()
    .is_ok()
}

fn load_operation(
    conn: &Connection,
    operation_id: &RequestId,
) -> Result<StoredOperation, RegistryError> {
    conn.query_row(
        "SELECT status,target_fingerprint,targets_json,result_json FROM stopped_repair_operations WHERE operation_id=?1",
        params![operation_id.as_str()],
        |row| {
            Ok(StoredOperation {
                status: row.get(0)?,
                target_fingerprint: row.get(1)?,
                targets_json: row.get(2)?,
                result_json: row.get(3)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| RegistryError::InvalidState("unknown stopped-repair operation".into()))
}

fn validate_operation_targets(
    operation: &StoredOperation,
    targets: &[LostSoulRepairTarget],
) -> Result<(), RegistryError> {
    let mut persisted: Vec<LostSoulRepairTarget> = serde_json::from_str(&operation.targets_json)?;
    persisted.sort_by(target_order);
    let mut requested = targets.to_vec();
    requested.sort_by(target_order);
    if persisted != requested
        || operation.targets_json != serde_json::to_string(&persisted)?
        || operation.target_fingerprint != target_fingerprint(&requested)?
    {
        return Err(RegistryError::RequestConflict);
    }
    Ok(())
}

fn target_fingerprint(targets: &[LostSoulRepairTarget]) -> Result<String, RegistryError> {
    let bytes = serde_json::to_vec(targets)?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn load_withdrawal(
    conn: &Connection,
    operation_id: &RequestId,
) -> Result<WithdrawalMarker, RegistryError> {
    conn.query_row(
        "SELECT generation,targets_json,incident_ids_json,status FROM stopped_repair_withdrawals WHERE operation_id=?1",
        params![operation_id.as_str()],
        |row| {
            Ok(WithdrawalMarker {
                generation: row.get(0)?,
                targets_json: row.get(1)?,
                incident_ids_json: row.get(2)?,
                status: row.get(3)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| RegistryError::Integrity("stopped-repair withdrawal marker is missing".into()))
}

fn validate_withdrawal(
    operation: &StoredOperation,
    marker: &WithdrawalMarker,
    targets: &[LostSoulRepairTarget],
) -> Result<(), RegistryError> {
    validate_operation_targets(operation, targets)?;
    let mut marker_targets: Vec<LostSoulRepairTarget> = serde_json::from_str(&marker.targets_json)?;
    marker_targets.sort_by(target_order);
    let mut expected_targets = targets.to_vec();
    expected_targets.sort_by(target_order);
    let expected_incidents = expected_targets
        .iter()
        .map(|target| target.incident_id.as_str().to_owned())
        .collect::<Vec<_>>();
    let persisted_incidents: Vec<String> = serde_json::from_str(&marker.incident_ids_json)?;
    if !valid_exact_targets(&expected_targets)
        || operation.status != "withdraw_pending"
        || marker.status != "files_pending"
        || marker_targets != expected_targets
        || marker.targets_json != serde_json::to_string(&expected_targets)?
        || persisted_incidents != expected_incidents
    {
        return Err(RegistryError::Integrity(
            "stopped-repair withdrawal marker does not match the exact operation targets".into(),
        ));
    }
    Ok(())
}

fn load_root_receipts(
    conn: &Connection,
    operation_id: &RequestId,
) -> Result<Vec<StoppedRepairRootReceipt>, RegistryError> {
    let mut statement = conn.prepare(
        "SELECT root_session_id,canonical_soul_id,transfer_id,source_store_id,source_generation,identity_revision,intent_revision,native_import_revision,active_incarnation_id,execution_generation,import_receipt_json,readable_receipt_json,status \
         FROM stopped_repair_root_receipts WHERE operation_id=?1 ORDER BY root_session_id",
    )?;
    let rows = statement.query_map(params![operation_id.as_str()], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, u64>(5)?,
            row.get::<_, u64>(6)?,
            row.get::<_, u64>(7)?,
            row.get::<_, String>(8)?,
            row.get::<_, u64>(9)?,
            row.get::<_, String>(10)?,
            row.get::<_, String>(11)?,
            row.get::<_, String>(12)?,
        ))
    })?;
    let mut receipts = Vec::new();
    for row in rows {
        let (
            root_session_id,
            canonical_soul_id,
            transfer_id,
            source_store_id,
            source_generation,
            identity_revision,
            intent_revision,
            native_import_revision,
            incarnation_id,
            execution_generation,
            import_json,
            readable_json,
            status,
        ) = row?;
        let receipt: StoppedRepairRootReceipt = serde_json::from_str(&import_json)?;
        let readable: Value = serde_json::from_str(&readable_json)?;
        let persisted_canonical = SoulId::parse(canonical_soul_id).map_err(|_| {
            RegistryError::Integrity("invalid stopped-repair canonical soul id".into())
        })?;
        let persisted_incarnation = freshell_runtime_protocol::IncarnationId::parse(incarnation_id)
            .map_err(|_| {
                RegistryError::Integrity("invalid stopped-repair incarnation id".into())
            })?;
        let scalar_match = status == "verified"
            && receipt.root_session_id == root_session_id
            && receipt.canonical_soul_id == persisted_canonical
            && receipt.transfer_id == transfer_id
            && receipt.source_store_id == source_store_id
            && receipt.source_generation == source_generation
            && receipt.captured_identity_revision == identity_revision
            && receipt.captured_intent_revision == intent_revision
            && receipt.captured_native_import_revision == native_import_revision
            && receipt.incarnation_id == persisted_incarnation
            && receipt.execution_generation == execution_generation;
        let readable_match = readable.get("providerUid").and_then(Value::as_u64)
            == Some(u64::from(receipt.provider_uid))
            && readable.get("providerGid").and_then(Value::as_u64)
                == Some(u64::from(receipt.provider_gid))
            && readable.get("destinationStoreId").and_then(Value::as_str)
                == Some(receipt.destination_store_id.as_str())
            && readable.get("bundleSha256").and_then(Value::as_str)
                == Some(receipt.bundle_sha256.as_str())
            && readable
                .get("readerEnvironmentSha256")
                .and_then(Value::as_str)
                == Some(receipt.reader_environment_sha256.as_str())
            && readable.get("structuralSha256").and_then(Value::as_str)
                == Some(receipt.structural_sha256.as_str())
            && readable.get("rowCount").and_then(Value::as_u64) == Some(receipt.row_count)
            && readable.get("assetCount").and_then(Value::as_u64) == Some(receipt.asset_count);
        if !scalar_match || !readable_match {
            return Err(RegistryError::Integrity(
                format!(
                    "stopped-repair receipt columns and summaries do not agree (scalar={scalar_match}, readable={readable_match})"
                ),
            ));
        }
        receipts.push(receipt);
    }
    Ok(receipts)
}

fn validate_exact_receipts(
    persisted: &[StoppedRepairRootReceipt],
    submitted: &[StoppedRepairRootReceipt],
) -> Result<(), RegistryError> {
    let mut persisted = persisted.to_vec();
    let mut submitted = submitted.to_vec();
    persisted.sort_by(|left, right| left.root_session_id.cmp(&right.root_session_id));
    submitted.sort_by(|left, right| left.root_session_id.cmp(&right.root_session_id));
    if persisted.len() != 7 || persisted != submitted {
        return Err(RegistryError::RequestConflict);
    }
    Ok(())
}

fn load_target_fence(
    tx: &Transaction<'_>,
    target: &LostSoulRepairTarget,
) -> Result<TargetFence, RegistryError> {
    let row = tx.query_row(
        "SELECT s.provider_store_id,s.native_session_id,s.native_import_source_store_id,s.native_import_root_session_id,s.native_import_source_generation,s.native_import_schema_fingerprint,s.native_import_migration_fingerprint,s.native_import_state,s.native_import_authority,s.identity_revision,s.evidence_revision,s.intent_revision,s.native_import_revision,s.loss_incident_id,l.incarnation_id,i.execution_generation,i.launch_state,i.cleanup_state \
         FROM souls s JOIN loss_incidents l ON l.soul_id=s.soul_id AND l.incident_id=?2 \
         JOIN incarnations i ON i.soul_id=s.soul_id AND i.incarnation_id=l.incarnation_id WHERE s.soul_id=?1",
        params![target.soul_id.as_str(), target.incident_id.as_str()],
        |row| {
            Ok(TargetFence {
                provider_store_id: row.get(0)?,
                native_session_id: row.get(1)?,
                native_import_source_store_id: row.get(2)?,
                native_import_root_session_id: row.get(3)?,
                native_import_source_generation: row.get(4)?,
                native_import_schema_fingerprint: row.get(5)?,
                native_import_migration_fingerprint: row.get(6)?,
                native_import_state: row.get(7)?,
                native_import_authority: row.get(8)?,
                identity_revision: row.get(9)?,
                evidence_revision: row.get(10)?,
                intent_revision: row.get(11)?,
                native_import_revision: row.get(12)?,
                loss_incident_id: row.get(13)?,
                incarnation_id: row.get(14)?,
                execution_generation: row.get(15)?,
                launch_state: row.get(16)?,
                cleanup_state: row.get(17)?,
            })
        },
    )?;
    Ok(row)
}

fn commit_stopped_repair_cas(
    conn: &mut Connection,
    operation_id: &RequestId,
    targets: &[LostSoulRepairTarget],
    roots: &[StoppedRepairRootReceipt],
) -> Result<WithdrawalMarker, RegistryError> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let operation = load_operation(&tx, operation_id)?;
    validate_operation_targets(&operation, targets)?;
    if operation.status != "importing" {
        return Err(RegistryError::RequestConflict);
    }
    validate_targets_and_receipts(&tx, targets, roots)?;

    let now = now_millis();
    let target_by_soul = targets
        .iter()
        .map(|target| (target.soul_id.as_str().to_owned(), target))
        .collect::<BTreeMap<_, _>>();
    for receipt in roots {
        let target = target_by_soul
            .get(receipt.canonical_soul_id.as_str())
            .ok_or(RegistryError::RequestConflict)?;
        let next_import_revision = receipt
            .captured_native_import_revision
            .checked_add(1)
            .ok_or_else(|| RegistryError::Integrity("native import revision overflow".into()))?;
        let changed = tx.execute(
            "UPDATE souls SET recovery_state='data_repair_complete',recovery_reason=NULL,recovery_attempt_id=NULL, \
             native_import_state='completed',native_import_source_store_id=?1,native_import_root_session_id=?2, \
             native_import_source_generation=?3,native_import_schema_fingerprint=?4,native_import_migration_fingerprint=?5, \
             native_import_complete_inventory=0,native_import_authority='verified_import_receipt', \
             native_import_revision=?6,evidence_revision=evidence_revision+1,loss_incident_id=NULL,updated_at=?7 \
             WHERE soul_id=?8 AND provider='opencode' AND provider_store_id=?9 AND desired_state='stopped' \
             AND recovery_state='lost' AND loss_incident_id=?10 AND intent_revision=?11 \
             AND identity_revision=?12 AND evidence_revision=?13 AND native_import_revision=?14 \
             AND native_import_state=?15 AND native_import_authority=?16",
            params![
                receipt.source_store_id,
                receipt.root_session_id,
                receipt.source_generation,
                receipt.source_schema_fingerprint,
                receipt.migration_journal_fingerprint,
                next_import_revision,
                now,
                target.soul_id.as_str(),
                receipt.destination_store_id,
                target.incident_id.as_str(),
                target.expected_intent_revision,
                receipt.captured_identity_revision,
                receipt.captured_evidence_revision,
                receipt.captured_native_import_revision,
                receipt.captured_native_import_state,
                receipt.captured_native_import_authority,
            ],
        )?;
        if changed != 1 {
            return Err(RegistryError::NativeIdentityConflict);
        }
        upsert_native_origin_owner(&tx, receipt, &target_by_soul, now)?;
    }

    remove_loss_projection_rows(&tx, targets)?;
    rebind_duplicate_views(&tx, targets, roots, now)?;
    for target in targets {
        let removed_tombstones = tx.execute(
            "DELETE FROM stop_tombstones WHERE soul_id=?1 AND intent_revision=?2 AND actor='loss-certificate' AND reason=?3",
            params![
                target.soul_id.as_str(),
                target.expected_intent_revision,
                format!("certified loss {}", target.incident_id),
            ],
        )?;
        if removed_tombstones != 1 {
            return Err(RegistryError::Integrity(
                "exact loss-generated stop tombstone was not present".into(),
            ));
        }
        remove_exact_loss_outbox(&tx, target)?;
        let removed = tx.execute(
            "DELETE FROM loss_incidents WHERE incident_id=?1 AND soul_id=?2",
            params![target.incident_id.as_str(), target.soul_id.as_str()],
        )?;
        if removed != 1 {
            return Err(RegistryError::IncidentNotFound(target.incident_id.clone()));
        }
    }
    let false_ids = targets
        .iter()
        .map(|target| target.incident_id.as_str().to_owned())
        .collect::<BTreeSet<_>>();
    sanitize_false_incident_notices_in_tx(&tx, &false_ids, now)?;

    let marker_targets_json = serde_json::to_string(targets)?;
    let incident_ids = targets
        .iter()
        .map(|target| target.incident_id.as_str().to_owned())
        .collect::<Vec<_>>();
    let incident_ids_json = serde_json::to_string(&incident_ids)?;
    let generation = withdrawal_generation(operation_id, targets, roots)?;
    tx.execute(
        "INSERT INTO stopped_repair_withdrawals(operation_id,generation,targets_json,incident_ids_json,status,updated_at) \
         VALUES (?1,?2,?3,?4,'files_pending',?5)",
        params![operation_id.as_str(), generation, marker_targets_json, incident_ids_json, now],
    )?;
    let changed = tx.execute(
        "UPDATE stopped_repair_operations SET status='withdraw_pending',updated_at=?1 WHERE operation_id=?2 AND status='importing'",
        params![now, operation_id.as_str()],
    )?;
    if changed != 1 {
        return Err(RegistryError::RequestConflict);
    }
    let marker = load_withdrawal(&tx, operation_id)?;
    tx.commit()?;
    Ok(marker)
}

fn validate_targets_and_receipts(
    tx: &Transaction<'_>,
    targets: &[LostSoulRepairTarget],
    roots: &[StoppedRepairRootReceipt],
) -> Result<(), RegistryError> {
    if !valid_exact_targets(targets) || roots.len() != 7 {
        return Err(RegistryError::RequestConflict);
    }
    let mut root_names = BTreeSet::new();
    let mut by_root = BTreeMap::<String, Vec<&LostSoulRepairTarget>>::new();
    let mut target_fences = BTreeMap::<String, TargetFence>::new();
    for target in targets {
        validate_stopped_repair_target_in_tx(tx, target)?;
        let fence = load_target_fence(tx, target)?;
        if fence.intent_revision != target.expected_intent_revision
            || fence.loss_incident_id.as_deref() != Some(target.incident_id.as_str())
            || fence.launch_state != "stopped"
            || fence.cleanup_state != "verified_empty"
        {
            return Err(RegistryError::RecoveryBlocked {
                soul_id: target.soul_id.clone(),
                reason: "stopped-repair target changed after receipt verification".into(),
            });
        }
        let root = fence
            .native_import_root_session_id
            .as_deref()
            .or(fence.native_session_id.as_deref())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| RegistryError::NativeIdentityConflict)?
            .to_owned();
        root_names.insert(root.clone());
        by_root.entry(root).or_default().push(target);
        target_fences.insert(target.soul_id.as_str().to_owned(), fence);
    }
    if root_names.len() != 7
        || roots
            .iter()
            .map(|root| root.root_session_id.as_str())
            .collect::<BTreeSet<_>>()
            .len()
            != 7
        || root_names
            != roots
                .iter()
                .map(|root| root.root_session_id.clone())
                .collect()
    {
        return Err(RegistryError::NativeIdentityConflict);
    }

    let target_souls = targets
        .iter()
        .map(|target| target.soul_id.as_str().to_owned())
        .collect::<BTreeSet<_>>();
    for receipt in roots {
        let candidates = by_root
            .get(&receipt.root_session_id)
            .ok_or(RegistryError::NativeIdentityConflict)?;
        let canonical = candidates
            .iter()
            .filter(|target| target.soul_id == receipt.canonical_soul_id)
            .copied()
            .collect::<Vec<_>>();
        if canonical.len() != 1
            || receipt.transfer_id.is_empty()
            || !is_lower_hex_sha256(&receipt.bundle_sha256)
            || !is_lower_hex_sha256(&receipt.structural_sha256)
            || !is_lower_hex_sha256(&receipt.reader_environment_sha256)
            || !is_lower_hex_sha256(&receipt.source_schema_fingerprint)
            || !is_lower_hex_sha256(&receipt.migration_journal_fingerprint)
            || receipt.destination_store_id.is_empty()
            || receipt.source_store_id.is_empty()
            || receipt.source_generation.is_empty()
            || !receipt.adoption_baseline_matches_receipt()
        {
            return Err(RegistryError::NativeIdentityConflict);
        }
        let target = canonical[0];
        let fence = target_fences
            .get(target.soul_id.as_str())
            .ok_or(RegistryError::NativeIdentityConflict)?;
        if fence.provider_store_id != receipt.destination_store_id
            || !source_descriptor_matches_or_is_unbound_legacy(fence, receipt)
            || fence.native_import_state != receipt.captured_native_import_state
            || fence.native_import_authority != receipt.captured_native_import_authority
            || fence.identity_revision != receipt.captured_identity_revision
            || fence.evidence_revision != receipt.captured_evidence_revision
            || fence.intent_revision != receipt.captured_intent_revision
            || fence.native_import_revision != receipt.captured_native_import_revision
            || receipt.captured_intent_revision != target.expected_intent_revision
            || fence.incarnation_id != receipt.incarnation_id.as_str()
            || fence.execution_generation != receipt.execution_generation
        {
            return Err(RegistryError::NativeIdentityConflict);
        }

        // Every candidate for this native root must be among this exact batch
        // and must describe the same source origin and generation.
        let registered = {
            let mut statement = tx.prepare(
                "SELECT soul_id FROM souls WHERE provider='opencode' \
                 AND (native_import_root_session_id=?1 OR native_session_id=?1) \
                 AND native_import_authority!='retired_duplicate' ORDER BY soul_id",
            )?;
            let rows = statement
                .query_map(params![receipt.root_session_id], |row| {
                    row.get::<_, String>(0)
                })?
                .collect::<Result<BTreeSet<_>, _>>()?;
            rows
        };
        let expected = candidates
            .iter()
            .map(|target| target.soul_id.as_str().to_owned())
            .collect::<BTreeSet<_>>();
        if registered != expected || !expected.is_subset(&target_souls) {
            return Err(RegistryError::NativeIdentityConflict);
        }
        for candidate in candidates {
            let candidate_fence = target_fences
                .get(candidate.soul_id.as_str())
                .ok_or(RegistryError::NativeIdentityConflict)?;
            if !source_descriptor_matches_or_is_unbound_legacy(candidate_fence, receipt) {
                return Err(RegistryError::NativeIdentityConflict);
            }
        }

        let owner: Option<Option<String>> = tx
            .query_row(
                "SELECT owner_soul_id FROM native_origin_owners WHERE provider='opencode' AND source_store_id=?1 AND native_root_session_id=?2",
                params![receipt.source_store_id, receipt.root_session_id],
                |row| row.get(0),
            )
            .optional()?;
        if owner
            .flatten()
            .is_some_and(|owner| !target_souls.contains(&owner))
        {
            return Err(RegistryError::NativeIdentityConflict);
        }
    }
    Ok(())
}

fn source_descriptor_matches_or_is_unbound_legacy(
    fence: &TargetFence,
    receipt: &StoppedRepairRootReceipt,
) -> bool {
    let exact_match = fence.native_import_source_store_id.as_deref()
        == Some(receipt.source_store_id.as_str())
        && fence.native_import_root_session_id.as_deref() == Some(receipt.root_session_id.as_str())
        && fence.native_import_source_generation.as_deref()
            == Some(receipt.source_generation.as_str())
        && fence.native_import_schema_fingerprint.as_deref()
            == Some(receipt.source_schema_fingerprint.as_str())
        && fence.native_import_migration_fingerprint.as_deref()
            == Some(receipt.migration_journal_fingerprint.as_str());
    let unbound_legacy = fence.native_import_state == "legacy_unknown"
        && fence.native_import_authority == "legacy_unknown"
        && fence.native_import_source_store_id.is_none()
        && fence.native_import_root_session_id.is_none()
        && fence.native_import_source_generation.is_none()
        && fence.native_import_schema_fingerprint.is_none()
        && fence.native_import_migration_fingerprint.is_none();
    exact_match || unbound_legacy
}

fn upsert_native_origin_owner(
    tx: &Transaction<'_>,
    receipt: &StoppedRepairRootReceipt,
    targets: &BTreeMap<String, &LostSoulRepairTarget>,
    now: i64,
) -> Result<(), RegistryError> {
    let existing: Option<(Option<String>, String)> = tx
        .query_row(
            "SELECT owner_soul_id,ownership_state FROM native_origin_owners WHERE provider='opencode' AND source_store_id=?1 AND native_root_session_id=?2",
            params![receipt.source_store_id, receipt.root_session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((Some(owner), _)) = existing.as_ref() {
        if !targets.contains_key(owner) {
            return Err(RegistryError::NativeIdentityConflict);
        }
    }
    tx.execute(
        "INSERT INTO native_origin_owners(provider,source_store_id,native_root_session_id,owner_soul_id,source_generation,ownership_state,updated_at) \
         VALUES ('opencode',?1,?2,?3,?4,'owned',?5) \
         ON CONFLICT(provider,source_store_id,native_root_session_id) DO UPDATE SET \
         owner_soul_id=excluded.owner_soul_id,source_generation=excluded.source_generation,ownership_state='owned',updated_at=excluded.updated_at",
        params![
            receipt.source_store_id,
            receipt.root_session_id,
            receipt.canonical_soul_id.as_str(),
            receipt.source_generation,
            now,
        ],
    )?;
    Ok(())
}

fn rebind_duplicate_views(
    tx: &Transaction<'_>,
    targets: &[LostSoulRepairTarget],
    roots: &[StoppedRepairRootReceipt],
    now: i64,
) -> Result<(), RegistryError> {
    let target_by_soul = targets
        .iter()
        .map(|target| (target.soul_id.as_str().to_owned(), target))
        .collect::<BTreeMap<_, _>>();
    for receipt in roots {
        let target = target_by_soul
            .get(receipt.canonical_soul_id.as_str())
            .ok_or(RegistryError::NativeIdentityConflict)?;
        let mut duplicates = Vec::new();
        for candidate in targets {
            if candidate.soul_id != receipt.canonical_soul_id
                && target_by_soul.contains_key(candidate.soul_id.as_str())
                && candidate_root(tx, candidate)? == receipt.root_session_id
            {
                duplicates.push(candidate.soul_id.clone());
            }
        }
        for duplicate in duplicates {
            let view_ids = {
                let mut statement = tx.prepare(
                    "SELECT view_id FROM view_intents WHERE soul_id=?1 ORDER BY view_id",
                )?;
                let rows = statement
                    .query_map(params![duplicate.as_str()], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                rows
            };
            for raw_view_id in view_ids {
                let view_id = freshell_runtime_protocol::ViewIntentId::parse(raw_view_id)
                    .map_err(|_| RegistryError::Integrity("invalid duplicate view id".into()))?;
                let view = load_view_intent(tx, &view_id)?
                    .ok_or_else(|| RegistryError::Integrity("duplicate view disappeared".into()))?;
                let duplicate_auto = matches!(
                    view.kind,
                    freshell_runtime_protocol::ViewIntentKind::AutomaticPrimary
                );
                let canonical_auto_exists = duplicate_auto
                    && tx.query_row(
                        "SELECT EXISTS(SELECT 1 FROM view_intents WHERE soul_id=?1 AND owner_id=?2 AND workspace_id=?3 AND kind='automatic_primary')",
                        params![receipt.canonical_soul_id.as_str(), view.owner_id, view.workspace_id],
                        |row| row.get::<_, bool>(0),
                    )?;
                if canonical_auto_exists {
                    delete_view_projection_rows(tx, &view_id)?;
                    tx.execute(
                        "DELETE FROM view_intents WHERE view_id=?1 AND soul_id=?2 AND kind='automatic_primary'",
                        params![view_id.as_str(), duplicate.as_str()],
                    )?;
                } else {
                    let changed = tx.execute(
                        "UPDATE view_intents SET soul_id=?1,revision=revision+1,soul_intent_revision=?2,updated_at=?3 WHERE view_id=?4 AND soul_id=?5 AND revision=?6",
                        params![
                            receipt.canonical_soul_id.as_str(),
                            target.expected_intent_revision,
                            now,
                            view_id.as_str(),
                            duplicate.as_str(),
                            view.revision,
                        ],
                    )?;
                    if changed != 1 {
                        return Err(RegistryError::RequestConflict);
                    }
                }
            }
            // Keep historical FK references and command/incarnation records;
            // retire the duplicate so it cannot re-enter owner ranking.
            let changed = tx.execute(
                "UPDATE souls SET desired_state='stopped',recovery_state='stopped',recovery_reason='RETIRED_DUPLICATE',recovery_attempt_id=NULL,loss_incident_id=NULL,native_import_authority='retired_duplicate',evidence_revision=evidence_revision+1,updated_at=?1 WHERE soul_id=?2 AND desired_state='stopped' AND recovery_state='lost' AND intent_revision=?3",
                params![now, duplicate.as_str(), target_by_soul[duplicate.as_str()].expected_intent_revision],
            )?;
            if changed != 1 {
                return Err(RegistryError::NativeIdentityConflict);
            }
        }
        reproject_canonical_views(
            tx,
            &receipt.canonical_soul_id,
            target.expected_intent_revision,
            now,
        )?;
    }
    Ok(())
}

fn candidate_root(
    tx: &Transaction<'_>,
    target: &LostSoulRepairTarget,
) -> Result<String, RegistryError> {
    let (root, native): (Option<String>, Option<String>) = tx.query_row(
        "SELECT native_import_root_session_id,native_session_id FROM souls WHERE soul_id=?1",
        params![target.soul_id.as_str()],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    root.or(native)
        .filter(|value| !value.is_empty())
        .ok_or(RegistryError::NativeIdentityConflict)
}

fn reproject_canonical_views(
    tx: &Transaction<'_>,
    canonical_soul_id: &SoulId,
    intent_revision: u64,
    now: i64,
) -> Result<(), RegistryError> {
    let view_ids = {
        let mut statement =
            tx.prepare("SELECT view_id FROM view_intents WHERE soul_id=?1 ORDER BY view_id")?;
        let rows = statement
            .query_map(params![canonical_soul_id.as_str()], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    for raw_view_id in view_ids {
        let view_id = freshell_runtime_protocol::ViewIntentId::parse(raw_view_id)
            .map_err(|_| RegistryError::Integrity("invalid canonical view id".into()))?;
        let current = load_view_intent(tx, &view_id)?
            .ok_or_else(|| RegistryError::Integrity("canonical view disappeared".into()))?;
        let changed = tx.execute(
            "UPDATE view_intents SET revision=revision+1,soul_intent_revision=?1,updated_at=?2 WHERE view_id=?3 AND revision=?4",
            params![intent_revision, now, view_id.as_str(), current.revision],
        )?;
        if changed != 1 {
            return Err(RegistryError::RequestConflict);
        }
        let updated = load_view_intent(tx, &view_id)?
            .ok_or_else(|| RegistryError::Integrity("updated canonical view disappeared".into()))?;
        enqueue_projection(tx, &updated)?;
    }
    Ok(())
}

fn delete_view_projection_rows(
    tx: &Transaction<'_>,
    view_id: &freshell_runtime_protocol::ViewIntentId,
) -> Result<(), RegistryError> {
    let prefix = format!("projection-{}-", view_id.as_str());
    let event_ids = {
        let mut statement =
            tx.prepare("SELECT event_id FROM outbox WHERE event_kind='view_intent.changed'")?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    for event_id in event_ids {
        let is_exact_projection = event_id
            .strip_prefix(&prefix)
            .is_some_and(|revision| revision.parse::<u64>().is_ok());
        if is_exact_projection {
            tx.execute(
                "DELETE FROM outbox WHERE event_id=?1 AND event_kind='view_intent.changed'",
                params![event_id],
            )?;
        }
    }
    Ok(())
}

fn remove_loss_projection_rows(
    tx: &Transaction<'_>,
    targets: &[LostSoulRepairTarget],
) -> Result<(), RegistryError> {
    let revision_by_soul = targets
        .iter()
        .map(|target| (target.soul_id.as_str(), target.expected_intent_revision))
        .collect::<BTreeMap<_, _>>();
    let rows = {
        let mut statement = tx.prepare(
            "SELECT event_id,payload FROM outbox WHERE event_kind='view_intent.changed'",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    for (event_id, payload) in rows {
        let value: Value = serde_json::from_str(&payload)?;
        let intent = value.get("viewIntent").or_else(|| value.get("view_intent"));
        let soul_id = intent
            .and_then(|intent| intent.get("soulId").or_else(|| intent.get("soul_id")))
            .and_then(Value::as_str);
        let intent_revision = value
            .get("soulIntentRevision")
            .or_else(|| value.get("soul_intent_revision"))
            .and_then(Value::as_u64);
        if soul_id
            .and_then(|soul| revision_by_soul.get(soul).map(|revision| (soul, revision)))
            .is_some_and(|(_, revision)| Some(*revision) == intent_revision)
        {
            tx.execute(
                "DELETE FROM outbox WHERE event_kind='view_intent.changed' AND event_id=?1",
                params![event_id],
            )?;
        }
    }
    Ok(())
}

fn remove_exact_loss_outbox(
    tx: &Transaction<'_>,
    target: &LostSoulRepairTarget,
) -> Result<(), RegistryError> {
    for (kind, suffix) in [
        ("loss_incident.open", "open"),
        ("loss_incident.final", "final"),
    ] {
        let event_id = format!("projection-loss-{suffix}-{}", target.incident_id);
        let payload: Option<String> = tx
            .query_row(
                "SELECT payload FROM outbox WHERE event_id=?1 AND event_kind=?2",
                params![event_id, kind],
                |row| row.get(0),
            )
            .optional()?;
        let payload = payload.ok_or_else(|| {
            RegistryError::Integrity("exact false-loss projection row is missing".into())
        })?;
        let value: Value = serde_json::from_str(&payload)?;
        let incident_id = value.get("incidentId").and_then(Value::as_str).or_else(|| {
            value
                .get("certificate")
                .and_then(|certificate| certificate.get("incidentId"))
                .and_then(Value::as_str)
        });
        if incident_id != Some(target.incident_id.as_str()) {
            return Err(RegistryError::Integrity(
                "false-loss outbox row did not match its exact incident ID".into(),
            ));
        }
        tx.execute(
            "DELETE FROM outbox WHERE event_id=?1 AND event_kind=?2",
            params![event_id, kind],
        )?;
    }
    Ok(())
}

fn withdrawal_generation(
    operation_id: &RequestId,
    targets: &[LostSoulRepairTarget],
    roots: &[StoppedRepairRootReceipt],
) -> Result<String, RegistryError> {
    let mut hasher = Sha256::new();
    hasher.update(b"freshell-stopped-repair-withdrawal-v1\0");
    hasher.update(operation_id.as_str().as_bytes());
    hasher.update(serde_json::to_vec(targets)?);
    hasher.update(serde_json::to_vec(roots)?);
    Ok(format!("{:x}", hasher.finalize()))
}

fn finish_pending_withdrawal(
    conn: &mut Connection,
    operation_id: &RequestId,
    marker: &WithdrawalMarker,
    targets: &[LostSoulRepairTarget],
    roots: &[StoppedRepairRootReceipt],
    file_context: WithdrawalFileContext,
) -> Result<RestoreLostSoulsResult, RegistryError> {
    let operation = load_operation(conn, operation_id)?;
    validate_withdrawal(&operation, marker, targets)?;
    if marker.generation != withdrawal_generation(operation_id, targets, roots)? {
        return Err(RegistryError::Integrity(
            "stopped-repair withdrawal generation does not match its exact receipts".into(),
        ));
    }
    let incident_ids = serde_json::from_str::<Vec<String>>(&marker.incident_ids_json)?
        .into_iter()
        .collect::<BTreeSet<_>>();
    let exporter = IncidentExporter::new(file_context.incident_root, String::new());
    let expected_generation = marker.generation.clone();
    let expected_targets_json = marker.targets_json.clone();
    let expected_incident_ids_json = marker.incident_ids_json.clone();
    let expected_operation_id = operation_id.clone();
    let check_path = file_context.db_path;
    let mut check_generation = || {
        let check_conn =
            open_connection(&check_path).map_err(|error| IoError::other(error.to_string()))?;
        let current: Option<(String, String, String, String, String)> = check_conn
            .query_row(
                "SELECT o.status,w.generation,w.targets_json,w.incident_ids_json,w.status \
                 FROM stopped_repair_operations o JOIN stopped_repair_withdrawals w ON w.operation_id=o.operation_id \
                 WHERE o.operation_id=?1",
                params![expected_operation_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .optional()
            .map_err(|error| IoError::other(error.to_string()))?;
        match current {
            Some((
                operation_status,
                generation,
                targets_json,
                incident_ids_json,
                marker_status,
            )) if operation_status == "withdraw_pending"
                && marker_status == "files_pending"
                && generation == expected_generation
                && targets_json == expected_targets_json
                && incident_ids_json == expected_incident_ids_json =>
            {
                Ok(())
            }
            _ => Err(IoError::other(
                "stopped-repair withdrawal generation changed before file effect",
            )),
        }
    };
    check_generation()?;
    exporter.retract_false_incidents_coordinated_checked(
        &incident_ids,
        &file_context.lifecycle_log,
        &mut check_generation,
    )?;
    check_generation()?;

    let result = complete_result(operation_id.clone(), roots)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current = load_operation(&tx, operation_id)?;
    let current_marker = load_withdrawal(&tx, operation_id)?;
    validate_withdrawal(&current, &current_marker, targets)?;
    if current_marker.generation != marker.generation
        || current_marker.targets_json != marker.targets_json
        || current_marker.incident_ids_json != marker.incident_ids_json
    {
        return Err(RegistryError::RequestConflict);
    }
    tx.execute(
        "DELETE FROM stopped_repair_withdrawals WHERE operation_id=?1 AND generation=?2 AND status='files_pending'",
        params![operation_id.as_str(), marker.generation],
    )?;
    let encoded = serde_json::to_string(&result)?;
    let changed = tx.execute(
        "UPDATE stopped_repair_operations SET status='complete',result_json=?1,updated_at=?2 \
         WHERE operation_id=?3 AND status='withdraw_pending'",
        params![encoded, now_millis(), operation_id.as_str()],
    )?;
    if changed != 1 {
        return Err(RegistryError::RequestConflict);
    }
    tx.commit()?;
    Ok(result)
}

fn complete_result(
    operation_id: RequestId,
    roots: &[StoppedRepairRootReceipt],
) -> Result<RestoreLostSoulsResult, RegistryError> {
    if roots.len() != 7 {
        return Err(RegistryError::Integrity(
            "completed repair requires seven exact root receipts".into(),
        ));
    }
    let mut results = roots
        .iter()
        .map(|receipt| {
            Ok(RestoreLostSoulRootResult {
                root_session_id: receipt.root_session_id.clone(),
                canonical_soul_id: Some(receipt.canonical_soul_id.clone()),
                import_status: RootRepairImportStatus::Complete,
                intent_revision: Some(receipt.captured_intent_revision),
                native_import_revision: Some(
                    receipt
                        .captured_native_import_revision
                        .checked_add(1)
                        .ok_or_else(|| {
                            RegistryError::Integrity("native import revision overflow".into())
                        })?,
                ),
                owner_candidates: Vec::new(),
                reason_code: None,
            })
        })
        .collect::<Result<Vec<_>, RegistryError>>()?;
    results.sort_by(|left, right| left.root_session_id.cmp(&right.root_session_id));
    Ok(RestoreLostSoulsResult {
        operation_id,
        status: SoulRepairStatus::Complete,
        repaired_target_count: 8,
        total_target_count: 8,
        roots: results,
    })
}

fn is_lower_hex_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

impl Supervisor {
    pub(crate) async fn finalize_stopped_repair_batch(
        &self,
        operation_id: RequestId,
        targets: Vec<LostSoulRepairTarget>,
        roots: Vec<StoppedRepairRootReceipt>,
        incident_root: PathBuf,
        lifecycle_log: PathBuf,
    ) -> Result<RestoreLostSoulsResult, RegistryError> {
        self.registry
            .finalize_stopped_repair_batch(
                operation_id,
                targets,
                roots,
                incident_root,
                lifecycle_log,
            )
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::SCHEMA_VERSION;
    use freshell_runtime_protocol::{
        opencode_target_build_receipt, opencode_transfer_bundle_digest, IncidentId,
        OpenCodeAdoptionBaseline, OpenCodeTransferDescriptor, OpenCodeTransferFile,
        RootRepairImportStatus, SoulId, SoulRepairStatus, OPENCODE_TRANSFER_DESTINATION_DB,
    };
    use rusqlite::{params, Connection};
    use serde_json::json;
    use sha2::{Digest, Sha256};
    use std::collections::BTreeSet;

    fn test_targets() -> Vec<LostSoulRepairTarget> {
        (0..8)
            .map(|index| LostSoulRepairTarget {
                soul_id: SoulId::parse(format!("soul-target-{index}")).unwrap(),
                incident_id: IncidentId::parse(format!("incident-false-{index}")).unwrap(),
                expected_intent_revision: index + 11,
            })
            .collect()
    }

    fn test_roots(targets: &[LostSoulRepairTarget]) -> Vec<StoppedRepairRootReceipt> {
        (0..7)
            .map(|index| {
                let root_session_id = format!("ses_root_{index}");
                let transfer_id = format!("transfer-{index}");
                let source_store_id =
                    format!("{:x}", Sha256::digest(format!("store-{index}").as_bytes()));
                let source_generation = format!(
                    "{:x}",
                    Sha256::digest(format!("generation-{index}").as_bytes())
                );
                let source_schema_fingerprint = "a".repeat(64);
                let migration_journal_fingerprint = "b".repeat(64);
                let target_image_ref = format!("sha256:{}", "c".repeat(64));
                let target_build_receipt =
                    opencode_target_build_receipt(&target_image_ref, "opencode-1.18.21");
                let payload_sha256 = format!("{:x}", Sha256::digest(b"x"));
                let manifest_json = json!({
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
                    "payload_bytes": 1,
                    "payload_sha256": payload_sha256,
                    "generation": source_generation,
                })
                .to_string();
                let files = vec![OpenCodeTransferFile {
                    index: 0,
                    relative_path: "payload.json".into(),
                    size_bytes: 1,
                    sha256: payload_sha256,
                }];
                let mut descriptor = OpenCodeTransferDescriptor {
                    transfer_id: transfer_id.clone(),
                    provider: "opencode".into(),
                    source_store_id: source_store_id.clone(),
                    root_session_id: root_session_id.clone(),
                    source_generation: source_generation.clone(),
                    provider_schema: "opencode-1.18.21".into(),
                    source_schema_fingerprint: source_schema_fingerprint.clone(),
                    migration_journal_fingerprint: migration_journal_fingerprint.clone(),
                    destination_store_id: format!("destination-{index}"),
                    destination_database_path: OPENCODE_TRANSFER_DESTINATION_DB.into(),
                    target_image_ref: target_image_ref.clone(),
                    target_build_receipt: target_build_receipt.clone(),
                    incarnation_id: format!("incarnation-{index}"),
                    manifest_json,
                    files,
                    total_bytes: 1,
                    bundle_sha256: String::new(),
                };
                descriptor.bundle_sha256 =
                    opencode_transfer_bundle_digest(&descriptor.manifest_json, &descriptor.files);
                let adoption_baseline = OpenCodeAdoptionBaseline {
                    manifest_sha256: format!(
                        "{:x}",
                        Sha256::digest(descriptor.manifest_json.as_bytes())
                    ),
                    descriptor: descriptor.clone(),
                };
                assert!(adoption_baseline.validate().is_ok());
                StoppedRepairRootReceipt {
                    root_session_id,
                    canonical_soul_id: targets[index].soul_id.clone(),
                    transfer_id,
                    adoption_baseline,
                    destination_store_id: descriptor.destination_store_id,
                    source_store_id,
                    source_generation,
                    bundle_sha256: descriptor.bundle_sha256,
                    source_schema_fingerprint,
                    migration_journal_fingerprint,
                    target_image_ref,
                    target_build_receipt,
                    row_count: 0,
                    asset_count: 0,
                    structural_sha256: "c".repeat(64),
                    provider_uid: 65534,
                    provider_gid: 65534,
                    reader_environment_sha256: "d".repeat(64),
                    captured_identity_revision: 4,
                    captured_evidence_revision: 9,
                    captured_intent_revision: targets[index].expected_intent_revision,
                    captured_native_import_revision: 3,
                    captured_native_import_state: "pending".into(),
                    captured_native_import_authority: "exact_source_snapshot".into(),
                    incarnation_id: freshell_runtime_protocol::IncarnationId::parse(format!(
                        "incarnation-{index}"
                    ))
                    .unwrap(),
                    execution_generation: 5,
                }
            })
            .collect()
    }

    fn seed_pending_operation(
        registry: &Registry,
        operation_id: &RequestId,
        targets: &[LostSoulRepairTarget],
        roots: &[StoppedRepairRootReceipt],
    ) {
        let mut sorted_targets = targets.to_vec();
        sorted_targets.sort_by(|left, right| {
            left.soul_id
                .as_str()
                .cmp(right.soul_id.as_str())
                .then_with(|| left.incident_id.as_str().cmp(right.incident_id.as_str()))
        });
        let targets_json = serde_json::to_string(&sorted_targets).unwrap();
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&sorted_targets).unwrap())
        );
        let incident_ids = sorted_targets
            .iter()
            .map(|target| target.incident_id.as_str().to_string())
            .collect::<Vec<_>>();
        let incident_ids_json = serde_json::to_string(&incident_ids).unwrap();
        let conn = Connection::open(registry.database_path()).unwrap();
        conn.pragma_update(None, "foreign_keys", "OFF").unwrap();
        let now = 1_800_000_000_000_i64;
        conn.execute(
            "INSERT INTO stopped_repair_operations(operation_id,idempotency_key,target_fingerprint,targets_json,status,result_json,created_at,updated_at) VALUES (?1,?1,?2,?3,'withdraw_pending',NULL,?4,?4)",
            params![operation_id.as_str(), fingerprint, targets_json, now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO stopped_repair_withdrawals(operation_id,generation,targets_json,incident_ids_json,status,updated_at) VALUES (?1,?2,?3,?4,'files_pending',?5)",
            params![
                operation_id.as_str(),
                withdrawal_generation(operation_id, &sorted_targets, roots).unwrap(),
                serde_json::to_string(&sorted_targets).unwrap(),
                incident_ids_json,
                now,
            ],
        )
        .unwrap();
        for receipt in roots {
            conn.execute(
                "INSERT INTO stopped_repair_root_receipts(operation_id,root_session_id,canonical_soul_id,transfer_id,source_store_id,source_generation,identity_revision,intent_revision,native_import_revision,active_incarnation_id,execution_generation,import_receipt_json,readable_receipt_json,status,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,'verified',?14)",
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
                    serde_json::to_string(receipt).unwrap(),
                    json!({
                        "providerUid": receipt.provider_uid,
                        "providerGid": receipt.provider_gid,
                        "destinationStoreId": receipt.destination_store_id,
                        "bundleSha256": receipt.bundle_sha256,
                        "readerEnvironmentSha256": receipt.reader_environment_sha256,
                        "structuralSha256": receipt.structural_sha256,
                        "rowCount": receipt.row_count,
                        "assetCount": receipt.asset_count,
                    })
                    .to_string(),
                    now,
                ],
            )
            .unwrap();
        }
    }

    fn incident_line(id: &str) -> String {
        json!({"incidentId": id, "event": "soul.loss.finalized"}).to_string()
    }

    #[test]
    fn view_projection_retraction_requires_exact_view_and_revision_suffix() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE outbox(event_id TEXT PRIMARY KEY,event_kind TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL,delivered_at INTEGER);",
        )
        .unwrap();
        for event_id in [
            "projection-view-a-1",
            "projection-view-a-2",
            "projection-view-a-b-1",
            "projection-view-aardvark-1",
            "projection-viewXa-1",
            "projection-view-a-2-not-a-revision",
        ] {
            conn.execute(
                "INSERT INTO outbox(event_id,event_kind,payload,created_at) VALUES (?1,'view_intent.changed','{}',1)",
                params![event_id],
            )
            .unwrap();
        }
        let tx = conn.transaction().unwrap();
        delete_view_projection_rows(
            &tx,
            &freshell_runtime_protocol::ViewIntentId::parse("view-a").unwrap(),
        )
        .unwrap();
        tx.commit().unwrap();

        let mut statement = conn
            .prepare("SELECT event_id FROM outbox ORDER BY event_id")
            .unwrap();
        let remaining = statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            remaining,
            [
                "projection-view-a-2-not-a-revision".to_string(),
                "projection-view-a-b-1".to_string(),
                "projection-view-aardvark-1".to_string(),
                "projection-viewXa-1".to_string(),
            ]
        );
    }

    #[tokio::test]
    async fn pending_withdrawal_retry_is_exact_idempotent_and_preserves_unrelated_records() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path().join("registry"), None).unwrap();
        let operation_id = RequestId::new();
        let targets = test_targets();
        let roots = test_roots(&targets);
        seed_pending_operation(&registry, &operation_id, &targets, &roots);

        let incident_root = dir.path().join("incidents");
        std::fs::create_dir_all(&incident_root).unwrap();
        let lifecycle_log = dir.path().join("logs/lifecycle.jsonl");
        std::fs::create_dir_all(lifecycle_log.parent().unwrap()).unwrap();
        let unrelated_id = "incident-unrelated";
        let false_id = targets[0].incident_id.to_string();
        let false_export = incident_root.join(format!("{false_id}.open.json"));
        let unrelated_export = incident_root.join(format!("{unrelated_id}.closed.json"));
        std::fs::write(&false_export, json!({"incidentId": false_id}).to_string()).unwrap();
        std::fs::write(
            &unrelated_export,
            json!({"incidentId": unrelated_id}).to_string(),
        )
        .unwrap();
        let false_log_line = incident_line(&false_id);
        let unrelated_log_line = incident_line(unrelated_id);
        let active_incident_log = incident_root.join("incidents.jsonl");
        let rotated_incident_log = incident_root.join("incidents.jsonl.1");
        std::fs::write(
            &active_incident_log,
            format!("{false_log_line}\n{unrelated_log_line}\n"),
        )
        .unwrap();
        std::fs::write(&rotated_incident_log, format!("{false_log_line}\n")).unwrap();
        std::fs::write(
            &lifecycle_log,
            format!("{false_log_line}\n{unrelated_log_line}\n"),
        )
        .unwrap();

        // A malformed later file is classified before any earlier mutation.
        std::fs::write(
            lifecycle_log.parent().unwrap().join("lifecycle.jsonl.1"),
            "{broken\n",
        )
        .unwrap();
        let first = registry
            .finalize_stopped_repair_batch(
                operation_id.clone(),
                targets.clone(),
                roots.clone(),
                incident_root.clone(),
                lifecycle_log.clone(),
            )
            .await;
        assert!(
            first.is_err(),
            "malformed JSONL must keep correction pending"
        );
        assert_eq!(
            std::fs::read_to_string(&active_incident_log)
                .unwrap()
                .lines()
                .count(),
            2
        );
        assert!(false_export.exists());
        let pending: (String, i64) = Connection::open(registry.database_path())
            .unwrap()
            .query_row(
                "SELECT o.status,(SELECT COUNT(*) FROM stopped_repair_withdrawals w WHERE w.operation_id=o.operation_id) FROM stopped_repair_operations o WHERE operation_id=?1",
                params![operation_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(pending, ("withdraw_pending".into(), 1));

        let correct_generation = withdrawal_generation(&operation_id, &targets, &roots).unwrap();
        Connection::open(registry.database_path())
            .unwrap()
            .execute(
                "UPDATE stopped_repair_withdrawals SET generation='stale-generation' WHERE operation_id=?1",
                params![operation_id.as_str()],
            )
            .unwrap();
        std::fs::remove_file(lifecycle_log.parent().unwrap().join("lifecycle.jsonl.1")).unwrap();
        assert!(registry
            .resume_pending_stopped_repair_withdrawals(incident_root.clone(), lifecycle_log.clone())
            .await
            .is_err());
        assert!(
            false_export.exists(),
            "a stale withdrawal generation cannot remove exports"
        );
        assert_eq!(
            std::fs::read_to_string(&active_incident_log).unwrap(),
            format!("{false_log_line}\n{unrelated_log_line}\n"),
            "a stale withdrawal generation cannot rewrite lifecycle files"
        );
        Connection::open(registry.database_path())
            .unwrap()
            .execute(
                "UPDATE stopped_repair_withdrawals SET generation=?1 WHERE operation_id=?2",
                params![correct_generation, operation_id.as_str()],
            )
            .unwrap();
        registry
            .resume_pending_stopped_repair_withdrawals(incident_root.clone(), lifecycle_log.clone())
            .await
            .unwrap();

        assert!(!false_export.exists());
        assert!(unrelated_export.exists());
        assert_eq!(
            std::fs::read_to_string(&active_incident_log).unwrap(),
            format!("{unrelated_log_line}\n")
        );
        assert!(!rotated_incident_log.exists());
        assert_eq!(
            std::fs::read_to_string(&lifecycle_log).unwrap(),
            format!("{unrelated_log_line}\n")
        );
        let (status, result_json, marker_count): (String, Option<String>, i64) =
            Connection::open(registry.database_path())
                .unwrap()
                .query_row(
                    "SELECT o.status,o.result_json,(SELECT COUNT(*) FROM stopped_repair_withdrawals w WHERE w.operation_id=o.operation_id) FROM stopped_repair_operations o WHERE operation_id=?1",
                    params![operation_id.as_str()],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();
        assert_eq!(status, "complete");
        assert_eq!(marker_count, 0);
        let result: RestoreLostSoulsResult =
            serde_json::from_str(result_json.as_deref().unwrap()).unwrap();
        assert_eq!(result.status, SoulRepairStatus::Complete);
        assert_eq!(result.repaired_target_count, 8);
        assert_eq!(result.total_target_count, 8);
        assert_eq!(result.roots.len(), 7);
        assert!(result.roots.iter().all(|root| {
            root.import_status == RootRepairImportStatus::Complete
                && root.canonical_soul_id.is_some()
                && root.intent_revision.is_some()
                && root.native_import_revision.is_some()
        }));

        let retried = registry
            .finalize_stopped_repair_batch(
                operation_id,
                targets.clone(),
                roots,
                incident_root,
                lifecycle_log,
            )
            .await
            .unwrap();
        assert_eq!(
            retried, result,
            "completed operation retries are idempotent"
        );

        let remaining_false_events = std::fs::read_to_string(active_incident_log)
            .unwrap()
            .lines()
            .filter(|line| line.contains(&false_id))
            .count();
        assert_eq!(remaining_false_events, 0);
        let distinct_incidents = targets
            .iter()
            .map(|target| target.incident_id.to_string())
            .collect::<BTreeSet<_>>();
        assert_eq!(distinct_incidents.len(), 8);
        let schema: u32 = Connection::open(registry.database_path())
            .unwrap()
            .query_row(
                "SELECT schema_version FROM installation WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(schema, SCHEMA_VERSION);
    }
}

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
    LostSoulRepairTarget, RepairBatchScope, RepairBatchSourceSelection, RepairBatchTarget,
    RequestId, RestoreLostSoulRootResult, RestoreLostSoulsResult, RootRepairImportStatus, SoulId,
    SoulRepairStatus,
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

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum StoppedRepairWithdrawalStatus {
    Complete,
    FilesPending,
}

enum WithdrawalAttempt {
    Complete(RestoreLostSoulsResult),
    FilesPending(IoError),
}

impl Registry {
    pub(crate) async fn repair_scope_members(
        &self,
        source: RepairBatchSourceSelection,
    ) -> Result<Vec<RepairBatchTarget>, RegistryError> {
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Deferred)?;
            let members = resolve_scope_members(&tx, &source)?;
            for member in &members {
                validate_stopped_repair_target_in_tx(&tx, &member.target)?;
            }
            tx.rollback()?;
            Ok(members)
        })
        .await
    }

    pub(crate) async fn stopped_repair_operation_scope(
        &self,
        operation_id: RequestId,
    ) -> Result<Option<RepairBatchScope>, RegistryError> {
        self.run_blocking(move |conn| {
            let encoded: Option<Option<String>> = conn
                .query_row(
                    "SELECT scope_json FROM stopped_repair_operations WHERE operation_id=?1",
                    params![operation_id.as_str()],
                    |row| row.get(0),
                )
                .optional()?;
            match encoded {
                None => Ok(None),
                Some(Some(encoded)) => Ok(Some(serde_json::from_str(&encoded)?)),
                Some(None) => Err(RegistryError::Integrity(
                    "legacy stopped-repair operation has no qualified original scope".into(),
                )),
            }
        })
        .await
    }

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
            || roots.is_empty()
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
            crate::recovery::stopped_repair_crash_boundary(
                "stopped_repair_after_repair_cas_before_withdrawal",
            );
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
        match self
            .resume_pending_stopped_repair_withdrawal_status(incident_root, lifecycle_log)
            .await?
        {
            StoppedRepairWithdrawalStatus::Complete => Ok(()),
            StoppedRepairWithdrawalStatus::FilesPending => Err(RegistryError::Io(IoError::other(
                "a stopped-repair incident withdrawal remains pending",
            ))),
        }
    }

    pub(crate) async fn resume_pending_stopped_repair_withdrawal_status(
        &self,
        incident_root: PathBuf,
        lifecycle_log: PathBuf,
    ) -> Result<StoppedRepairWithdrawalStatus, RegistryError> {
        let db_path = self.database_path().to_path_buf();
        let event_log = lifecycle_log.clone();
        let (status, deferred_events) = self.run_blocking(move |mut conn| {
            let _file_coordinator = incident_file_coordinator();
            let mut status = StoppedRepairWithdrawalStatus::Complete;
            let mut deferred_events = Vec::new();
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
                if roots.len() != operation.scope.roots.len() {
                    return Err(RegistryError::Integrity(
                        "pending stopped-repair withdrawal does not have seven verified roots".into(),
                    ));
                }
                match try_finish_pending_withdrawal(
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
                )? {
                    WithdrawalAttempt::Complete(_) => {}
                    WithdrawalAttempt::FilesPending(error) => {
                        status = StoppedRepairWithdrawalStatus::FilesPending;
                        deferred_events.push(serde_json::json!({"severity":"warn", "operationId":operation_id,
                                "generation":marker.generation, "reason":"withdrawal_files_pending",
                                "targets":targets,
                                "roots":roots.iter().map(|root| serde_json::json!({
                                    "soulId":root.canonical_soul_id,
                                    "incarnationId":root.incarnation_id,
                                    "intentRevision":root.captured_intent_revision,
                                    "executionGeneration":root.execution_generation,
                                })).collect::<Vec<_>>(),
                                "retryPending":true, "cleanupContinued":false, "error":error.to_string()}),
                        );
                    }
                }
            }
            Ok((status, deferred_events))
        })
        .await?;
        // append_event takes the same file coordinator as withdrawal. Publish
        // diagnostics only after the coordinated file transaction releases it.
        for data in deferred_events {
            crate::service::append_event(
                &event_log,
                "supervisor.stopped_repair_withdrawal_deferred",
                data,
            );
        }
        Ok(status)
    }
}

fn resolve_scope_members(
    conn: &Connection,
    source: &RepairBatchSourceSelection,
) -> Result<Vec<RepairBatchTarget>, RegistryError> {
    let mut members = Vec::new();
    let roots = source.root_session_ids.iter().collect::<BTreeSet<_>>();
    if roots.is_empty()
        || roots.len() != source.root_session_ids.len()
        || !is_lower_hex_sha256(&source.source_store_id)
    {
        return Err(RegistryError::RequestConflict);
    }
    for root in roots {
        let mut statement = conn.prepare(
            "SELECT s.soul_id,s.loss_incident_id,s.intent_revision,l.intent_revision,s.identity_revision,s.native_import_revision,s.evidence_revision,s.provider_store_id \
             FROM souls s JOIN loss_incidents l ON l.incident_id=s.loss_incident_id AND l.soul_id=s.soul_id \
             WHERE s.provider='opencode' AND s.desired_state='stopped' AND s.recovery_state='lost' \
             AND COALESCE(s.native_import_root_session_id,s.native_session_id)=?1 \
             AND (s.native_import_source_store_id=?2 OR (s.native_import_source_store_id IS NULL AND s.native_import_authority='legacy_unknown')) \
             ORDER BY s.soul_id",
        )?;
        let rows = statement.query_map(params![root, source.source_store_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, u64>(2)?,
                row.get::<_, u64>(3)?,
                row.get::<_, u64>(4)?,
                row.get::<_, u64>(5)?,
                row.get::<_, u64>(6)?,
                row.get::<_, String>(7)?,
            ))
        })?;
        let start = members.len();
        for row in rows {
            let (
                soul,
                incident,
                intent,
                incident_revision,
                identity_revision,
                native_import_revision,
                evidence_revision,
                provider_store_id,
            ) = row?;
            members.push(RepairBatchTarget {
                target: LostSoulRepairTarget {
                    soul_id: SoulId::parse(soul).map_err(|_| RegistryError::RequestConflict)?,
                    incident_id: freshell_runtime_protocol::IncidentId::parse(incident)
                        .map_err(|_| RegistryError::RequestConflict)?,
                    expected_intent_revision: intent,
                },
                provider_store_id,
                root_session_id: root.clone(),
                incident_revision,
                identity_revision,
                native_import_revision,
                evidence_revision,
            });
        }
        if members.len() == start {
            return Err(RegistryError::RequestConflict);
        }
    }
    members.sort_by(|left, right| target_order(&left.target, &right.target));
    Ok(members)
}

pub(crate) fn validate_scope_members(
    conn: &Connection,
    scope: &RepairBatchScope,
) -> Result<(), RegistryError> {
    let mut frozen = scope.targets.clone();
    frozen.sort_by(|left, right| target_order(&left.target, &right.target));
    if scope.scope_id != scope.descriptor_digest()
        || resolve_scope_members(conn, &scope.source_selection())? != frozen
    {
        return Err(RegistryError::RequestConflict);
    }
    Ok(())
}

#[derive(Debug)]
struct StoredOperation {
    status: String,
    target_fingerprint: String,
    targets_json: String,
    result_json: Option<String>,
    scope: RepairBatchScope,
    owner_choices: Vec<freshell_runtime_protocol::CanonicalOwnerChoice>,
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
    let mut souls = BTreeSet::new();
    let mut incidents = BTreeSet::new();
    !targets.is_empty()
        && targets.iter().all(|target| {
            target.expected_intent_revision > 0
                && souls.insert(target.soul_id.as_str())
                && incidents.insert(target.incident_id.as_str())
        })
}

fn load_operation(
    conn: &Connection,
    operation_id: &RequestId,
) -> Result<StoredOperation, RegistryError> {
    conn.query_row(
        "SELECT status,target_fingerprint,targets_json,result_json,scope_json,owner_choices_json FROM stopped_repair_operations WHERE operation_id=?1",
        params![operation_id.as_str()],
        |row| {
            Ok(StoredOperation {
                status: row.get(0)?,
                target_fingerprint: row.get(1)?,
                targets_json: row.get(2)?,
                result_json: row.get(3)?,
                scope: serde_json::from_str(&row.get::<_, String>(4)?).map_err(|error| rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(error)))?,
                owner_choices: serde_json::from_str(&row.get::<_, String>(5)?).map_err(|error| rusqlite::Error::FromSqlConversionFailure(5, rusqlite::types::Type::Text, Box::new(error)))?,
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
    let mut scoped = operation
        .scope
        .targets
        .iter()
        .map(|member| member.target.clone())
        .collect::<Vec<_>>();
    scoped.sort_by(target_order);
    if persisted != requested
        || scoped != requested
        || operation.scope.scope_id != operation.scope.descriptor_digest()
        || operation.targets_json != serde_json::to_string(&persisted)?
        || operation.target_fingerprint != target_fingerprint(&requested)?
    {
        return Err(RegistryError::RequestConflict);
    }
    Ok(())
}

pub(crate) fn validate_scope_owner_evidence(
    conn: &Connection,
    scope: &RepairBatchScope,
    owner_choices: &[freshell_runtime_protocol::CanonicalOwnerChoice],
) -> Result<(), RegistryError> {
    for root in &scope.roots {
        let candidates = crate::registry::stopped_repair_owner_candidates_in_connection(
            conn,
            &root.root_session_id,
        )?;
        let selection = crate::recovery::choose_canonical_root_owner(
            &candidates,
            &scope.source_store_id,
            &root.root_session_id,
            &root.graph_digest,
            None,
        )
        .map_err(|_| RegistryError::RequestConflict)?;
        let (mut eligible, canonical) = match selection {
            crate::recovery::CanonicalRootOwnerSelection::Chosen(owner) => {
                (vec![owner.soul_id.clone()], Some(owner.soul_id.clone()))
            }
            crate::recovery::CanonicalRootOwnerSelection::ChoiceRequired(owners) => (owners, None),
        };
        eligible.sort();
        let mut frozen = root.eligible_owners.clone();
        frozen.sort();
        if eligible != frozen || canonical != root.canonical_soul_id {
            return Err(RegistryError::RequestConflict);
        }
        if let Some(choice) = owner_choices
            .iter()
            .find(|choice| choice.root_session_id == root.root_session_id)
        {
            if !matches!(crate::recovery::choose_canonical_root_owner(&candidates,&scope.source_store_id,&root.root_session_id,&root.graph_digest,Some(&choice.soul_id)),Ok(crate::recovery::CanonicalRootOwnerSelection::Chosen(owner)) if owner.soul_id==choice.soul_id)
            {
                return Err(RegistryError::RequestConflict);
            }
        }
    }
    Ok(())
}

pub(crate) fn validate_scope_receipts(
    scope: &RepairBatchScope,
    owner_choices: &[freshell_runtime_protocol::CanonicalOwnerChoice],
    receipts: &[StoppedRepairRootReceipt],
) -> Result<(), RegistryError> {
    if scope.roots.len() != receipts.len()
        || scope.roots.iter().any(|root| {
            receipts
                .iter()
                .filter(|receipt| {
                    receipt.root_session_id == root.root_session_id
                        && receipt.source_store_id == scope.source_store_id
                        && receipt.source_generation == root.graph_digest
                        && root.eligible_owners.contains(&receipt.canonical_soul_id)
                        && root.canonical_soul_id.as_ref().or_else(|| {
                            owner_choices
                                .iter()
                                .find(|choice| choice.root_session_id == root.root_session_id)
                                .map(|choice| &choice.soul_id)
                        }) == Some(&receipt.canonical_soul_id)
                })
                .count()
                != 1
        })
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
    if persisted.is_empty() || persisted != submitted {
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
    validate_scope_members(&tx, &operation.scope)?;
    validate_scope_owner_evidence(&tx, &operation.scope, &operation.owner_choices)?;
    validate_scope_receipts(&operation.scope, &operation.owner_choices, roots)?;
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
    if !valid_exact_targets(targets) || roots.is_empty() {
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
    if roots
        .iter()
        .map(|root| root.root_session_id.as_str())
        .collect::<BTreeSet<_>>()
        .len()
        != roots.len()
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
    match try_finish_pending_withdrawal(conn, operation_id, marker, targets, roots, file_context)? {
        WithdrawalAttempt::Complete(result) => Ok(result),
        WithdrawalAttempt::FilesPending(_) => {
            let operation = load_operation(conn, operation_id)?;
            // Import and repair CAS are durable; only incident-file withdrawal
            // remains pending. Do not acknowledge its marker or persist completion.
            repaired_result(
                operation_id.clone(),
                operation.scope.scope_id,
                targets.len(),
                roots,
                SoulRepairStatus::Pending,
            )
        }
    }
}

fn try_finish_pending_withdrawal(
    conn: &mut Connection,
    operation_id: &RequestId,
    marker: &WithdrawalMarker,
    targets: &[LostSoulRepairTarget],
    roots: &[StoppedRepairRootReceipt],
    file_context: WithdrawalFileContext,
) -> Result<WithdrawalAttempt, RegistryError> {
    let operation = load_operation(conn, operation_id)?;
    validate_withdrawal(&operation, marker, targets)?;
    if marker.generation != withdrawal_generation(operation_id, targets, roots)? {
        return Err(RegistryError::Integrity(
            "stopped-repair withdrawal generation does not match its exact receipts".into(),
        ));
    }
    validate_scope_receipts(&operation.scope, &operation.owner_choices, roots)?;
    let incident_ids = serde_json::from_str::<Vec<String>>(&marker.incident_ids_json)?
        .into_iter()
        .collect::<BTreeSet<_>>();
    let exporter = IncidentExporter::new(file_context.incident_root, String::new());
    let expected_generation = marker.generation.clone();
    let expected_targets_json = marker.targets_json.clone();
    let expected_incident_ids_json = marker.incident_ids_json.clone();
    let expected_operation_id = operation_id.clone();
    let check_path = file_context.db_path;
    let generation_check_failed = std::cell::Cell::new(false);
    let mut check_generation = || {
        let result = (|| {
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
        })();
        if result.is_err() {
            generation_check_failed.set(true);
        }
        result
    };
    check_generation()?;
    if let Err(error) = exporter.retract_false_incidents_coordinated_checked(
        &incident_ids,
        &file_context.lifecycle_log,
        &mut check_generation,
    ) {
        // Only file classification/rewrite/sync failures are retryable.
        // A failed registry/generation fence remains fatal on every path.
        return if generation_check_failed.get() {
            Err(RegistryError::Io(error))
        } else {
            Ok(WithdrawalAttempt::FilesPending(error))
        };
    }
    check_generation()?;

    crate::recovery::stopped_repair_crash_boundary("stopped_repair_during_withdrawal_before_ack");

    let original = load_operation(conn, operation_id)?;
    validate_scope_receipts(&original.scope, &original.owner_choices, roots)?;
    let result = repaired_result(
        operation_id.clone(),
        original.scope.scope_id,
        targets.len(),
        roots,
        SoulRepairStatus::Complete,
    )?;
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
    Ok(WithdrawalAttempt::Complete(result))
}

fn repaired_result(
    operation_id: RequestId,
    scope_id: String,
    target_count: usize,
    roots: &[StoppedRepairRootReceipt],
    status: SoulRepairStatus,
) -> Result<RestoreLostSoulsResult, RegistryError> {
    if roots.is_empty() {
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
        scope_id,
        status,
        repaired_target_count: target_count
            .try_into()
            .map_err(|_| RegistryError::RequestConflict)?,
        total_target_count: target_count
            .try_into()
            .map_err(|_| RegistryError::RequestConflict)?,
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
        (0..9)
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
                let source_store_id = "a".repeat(64);
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
        let mut scope = RepairBatchScope {
            scope_id: String::new(),
            source_store_id: "a".repeat(64),
            source_fingerprint: "b".repeat(64),
            targets: sorted_targets
                .iter()
                .map(|target| {
                    let index = targets
                        .iter()
                        .position(|original| original.soul_id == target.soul_id)
                        .unwrap();
                    let root_index = if index == 8 { 0 } else { index.min(6) };
                    RepairBatchTarget {
                        provider_store_id: format!("store-fixture-{index}"),
                        target: target.clone(),
                        root_session_id: roots[root_index].root_session_id.clone(),
                        incident_revision: 1,
                        identity_revision: 4,
                        native_import_revision: 3,
                        evidence_revision: 9,
                    }
                })
                .collect(),
            roots: roots
                .iter()
                .map(|receipt| freshell_runtime_protocol::RepairBatchRoot {
                    root_session_id: receipt.root_session_id.clone(),
                    graph_digest: receipt.source_generation.clone(),
                    eligible_owners: vec![receipt.canonical_soul_id.clone()],
                    canonical_soul_id: Some(receipt.canonical_soul_id.clone()),
                })
                .collect(),
        };
        scope.source_fingerprint = scope.source_descriptor_digest();
        scope.scope_id = scope.descriptor_digest();
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
            "INSERT INTO stopped_repair_operations(operation_id,idempotency_key,target_fingerprint,targets_json,scope_json,status,result_json,created_at,updated_at) VALUES (?1,?1,?2,?3,?5,'withdraw_pending',NULL,?4,?4)",
            params![operation_id.as_str(), fingerprint, targets_json, now, serde_json::to_string(&scope).unwrap()],
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

    #[tokio::test]
    async fn verified_repaired_root_resumes_while_unrelated_log_withdrawal_is_pending() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let operation = RequestId::new();
        let targets = test_targets();
        let roots = test_roots(&targets);
        seed_pending_operation(&registry, &operation, &targets, &roots);
        let receipt = &roots[0];
        let conn = Connection::open(registry.database_path()).unwrap();
        conn.execute(
            "INSERT INTO souls(soul_id,provider,provider_store_id,native_session_id,creation_seed_ref,desired_state,intent_revision,recovery_state,durability_state,allocation_state,checkpoint_revision,evidence_revision,successful_recoveries_in_window,project_key,resource_profile,provider_volume_name,created_at,updated_at,native_import_state,native_import_authority,native_import_source_store_id,native_import_root_session_id,native_import_source_generation) VALUES(?1,'opencode',?2,?3,'seed','stopped',?4,'data_repair_complete','resume_captured','verified_durable',0,10,0,'project','interactive','volume',1,1,'completed','verified_import_receipt',?5,?3,?6)",
            params![receipt.canonical_soul_id.as_str(), receipt.destination_store_id, receipt.root_session_id, receipt.captured_intent_revision, receipt.source_store_id, receipt.source_generation],
        ).unwrap();
        conn.execute(
            "INSERT INTO native_origin_owners(provider,source_store_id,native_root_session_id,owner_soul_id,source_generation,ownership_state,updated_at) VALUES('opencode',?1,?2,?3,?4,'owned',1)",
            params![receipt.source_store_id, receipt.root_session_id, receipt.canonical_soul_id.as_str(), receipt.source_generation],
        ).unwrap();
        let log = dir.path().join("lifecycle.jsonl");
        let partial = b"{\"event\":\"unrelated interrupted write";
        std::fs::write(&log, partial).unwrap();
        assert!(matches!(
            registry
                .resume_pending_stopped_repair_withdrawal_status(
                    dir.path().join("incidents"),
                    log.clone()
                )
                .await
                .unwrap(),
            StoppedRepairWithdrawalStatus::FilesPending,
        ));
        let preserved_log = std::fs::read(&log).unwrap();
        assert!(
            preserved_log.starts_with(partial),
            "withdrawal must preserve the interrupted diagnostic row"
        );
        assert!(matches!(
            registry
                .start_stopped_data_repair(
                    receipt.canonical_soul_id.clone(),
                    receipt.captured_intent_revision - 1
                )
                .await,
            Err(RegistryError::StaleIntentRevision { .. }),
        ));
        conn.execute("UPDATE stopped_repair_root_receipts SET source_generation=?1 WHERE operation_id=?2 AND root_session_id=?3",
            params!["f".repeat(64), operation.as_str(), receipt.root_session_id]).unwrap();
        assert!(
            registry
                .start_stopped_data_repair(
                    receipt.canonical_soul_id.clone(),
                    receipt.captured_intent_revision
                )
                .await
                .is_err(),
            "a receipt from a different native import cannot authorize Resume"
        );
        conn.execute("UPDATE stopped_repair_root_receipts SET source_generation=?1 WHERE operation_id=?2 AND root_session_id=?3",
            params![receipt.source_generation, operation.as_str(), receipt.root_session_id]).unwrap();
        conn.execute(
            "UPDATE stopped_repair_operations SET status='importing' WHERE operation_id=?1",
            [operation.as_str()],
        )
        .unwrap();
        assert!(
            registry
                .start_stopped_data_repair(
                    receipt.canonical_soul_id.clone(),
                    receipt.captured_intent_revision
                )
                .await
                .is_err(),
            "an unapplied repair cannot authorize Resume"
        );
        conn.execute(
            "UPDATE stopped_repair_operations SET status='withdraw_pending' WHERE operation_id=?1",
            [operation.as_str()],
        )
        .unwrap();
        let next = registry
            .start_stopped_data_repair(
                receipt.canonical_soul_id.clone(),
                receipt.captured_intent_revision,
            )
            .await
            .expect("verified native repair must be resumable while diagnostic cleanup is pending");
        assert_eq!(next, receipt.captured_intent_revision + 1);
        assert_eq!(std::fs::read(&log).unwrap(), preserved_log);
        assert_eq!(
            conn.query_row(
                "SELECT status FROM stopped_repair_operations WHERE operation_id=?1",
                [operation.as_str()],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "withdraw_pending"
        );
        assert_eq!(
            conn.query_row(
                "SELECT desired_state FROM souls WHERE soul_id=?1",
                [receipt.canonical_soul_id.as_str()],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "running"
        );
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

    #[test]
    fn view_projection_retraction_treats_percent_and_underscore_as_literal_ids() {
        for view_id in ["view%exact", "view_exact"] {
            let mut conn = Connection::open_in_memory().unwrap();
            conn.execute_batch("CREATE TABLE outbox(event_id TEXT PRIMARY KEY,event_kind TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL,delivered_at INTEGER);").unwrap();
            let selected = [
                format!("projection-{view_id}-1"),
                format!("projection-{view_id}-42"),
            ];
            let unrelated = [
                "projection-viewXexact-1".to_string(),
                format!("projection-{view_id}-child-1"),
                format!("projection-{view_id}-42-not-a-revision"),
                format!("projection-{view_id}suffix-1"),
            ];
            for id in selected.iter().chain(&unrelated) {
                conn.execute("INSERT INTO outbox(event_id,event_kind,payload,created_at) VALUES (?1,'view_intent.changed','{}',1)", [id]).unwrap();
            }
            let tx = conn.transaction().unwrap();
            delete_view_projection_rows(
                &tx,
                &freshell_runtime_protocol::ViewIntentId::parse(view_id).unwrap(),
            )
            .unwrap();
            tx.commit().unwrap();
            for id in selected {
                assert_eq!(
                    conn.query_row(
                        "SELECT count(*) FROM outbox WHERE event_id=?1",
                        [id],
                        |row| row.get::<_, u32>(0)
                    )
                    .unwrap(),
                    0
                );
            }
            for id in unrelated {
                assert_eq!(
                    conn.query_row(
                        "SELECT count(*) FROM outbox WHERE event_id=?1",
                        [id],
                        |row| row.get::<_, u32>(0)
                    )
                    .unwrap(),
                    1
                );
            }
        }
    }

    #[tokio::test]
    async fn pending_stopped_repair_withdrawal_does_not_suppress_unrelated_exports_after_file_obstruction(
    ) {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let operation = RequestId::new();
        let targets = test_targets();
        let roots = test_roots(&targets);
        // This fixture represents the durable post-CAS boundary. Import and
        // provider access are tested separately on the actual helper path.
        seed_pending_operation(&registry, &operation, &targets, &roots);
        let supervisor = crate::recovery::tests::missing_supervisor(&dir, registry.clone());
        let incidents = dir.path().join("incidents");
        std::fs::create_dir_all(&incidents).unwrap();
        let selected = incidents.join(format!("{}.open.json", targets[0].incident_id));
        let selected_bytes =
            serde_json::to_vec(&json!({"incidentId":targets[0].incident_id})).unwrap();
        std::fs::write(&selected, &selected_bytes).unwrap();
        let log = incidents.join("incidents.jsonl");
        let blocked_bytes = format!(
            "{}\n{{unclassifiable\n",
            incident_line(targets[0].incident_id.as_str())
        );
        std::fs::write(&log, blocked_bytes.as_bytes()).unwrap();
        let unrelated = IncidentId::parse("incident-unrelated-drain").unwrap();
        let conn = Connection::open(registry.database_path()).unwrap();
        conn.execute("INSERT INTO outbox(event_id,event_kind,payload,created_at) VALUES ('unrelated-drain','loss_incident.final',?1,1)", [json!({"incidentId":unrelated,"cleanupState":"closed","event":"unrelated"}).to_string()]).unwrap();
        drop(conn);
        assert!(supervisor.export_pending_incidents().await.is_err());
        assert_eq!(std::fs::read(&selected).unwrap(), selected_bytes);
        assert_eq!(std::fs::read(&log).unwrap(), blocked_bytes.as_bytes());
        let unrelated_export = incidents.join(format!("{unrelated}.closed.json"));
        let unrelated_bytes = std::fs::read(&unrelated_export).unwrap();
        let conn = Connection::open(registry.database_path()).unwrap();
        assert!(conn
            .query_row(
                "SELECT delivered_at FROM outbox WHERE event_id='unrelated-drain'",
                [],
                |row| row.get::<_, Option<i64>>(0)
            )
            .unwrap()
            .is_some());
        assert_eq!(
            conn.query_row(
                "SELECT status FROM stopped_repair_operations WHERE operation_id=?1",
                [operation.as_str()],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "withdraw_pending"
        );
        drop(conn);
        std::fs::write(
            &log,
            format!("{}\n", incident_line(targets[0].incident_id.as_str())),
        )
        .unwrap();
        supervisor.export_pending_incidents().await.unwrap();
        assert!(!selected.exists());
        assert!(!log.exists());
        assert_eq!(std::fs::read(&unrelated_export).unwrap(), unrelated_bytes);
        let conn = Connection::open(registry.database_path()).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT status FROM stopped_repair_operations WHERE operation_id=?1",
                [operation.as_str()],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "complete"
        );
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM stopped_repair_withdrawals WHERE operation_id=?1",
                [operation.as_str()],
                |row| row.get::<_, u32>(0)
            )
            .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn pending_withdrawal_startup_keeps_nonwithdrawal_persistence_failures_fatal() {
        for fault in ["generation", "receipt", "export_artifact", "export_queue"] {
            let dir = tempfile::tempdir().unwrap();
            let registry = Registry::open(dir.path(), None).unwrap();
            let operation = RequestId::new();
            let targets = test_targets();
            let roots = test_roots(&targets);
            seed_pending_operation(&registry, &operation, &targets, &roots);
            let supervisor = crate::recovery::tests::missing_supervisor(&dir, registry.clone());
            // Genuine file pending work must never conceal an unrelated failure.
            std::fs::create_dir(dir.path().join("lifecycle.jsonl.1")).unwrap();
            let conn = Connection::open(registry.database_path()).unwrap();
            match fault {
                "generation" => {
                    conn.execute(
                        "UPDATE stopped_repair_withdrawals SET generation='stale'",
                        [],
                    )
                    .unwrap();
                }
                "receipt" => {
                    conn.execute(
                        "UPDATE stopped_repair_root_receipts SET import_receipt_json='{broken'",
                        [],
                    )
                    .unwrap();
                }
                "export_artifact" => {
                    std::fs::write(dir.path().join("incidents"), b"owned obstruction").unwrap();
                    conn.execute("INSERT INTO outbox(event_id,event_kind,payload,created_at) VALUES ('failed-export','loss_incident.final',?1,1)", [json!({"incidentId":"unrelated","cleanupState":"closed"}).to_string()]).unwrap();
                }
                "export_queue" => {
                    conn.execute("ALTER TABLE outbox RENAME TO unavailable_outbox", [])
                        .unwrap();
                }
                _ => unreachable!(),
            }
            assert!(
                supervisor.reconcile_pending_loss_cleanup().await.is_err(),
                "{fault} must still refuse startup"
            );
            assert_eq!(
                conn.query_row(
                    "SELECT status FROM stopped_repair_operations WHERE operation_id=?1",
                    [operation.as_str()],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
                "withdraw_pending"
            );
            if fault == "export_artifact" {
                assert_eq!(
                    std::fs::read(dir.path().join("incidents")).unwrap(),
                    b"owned obstruction"
                );
                let delivered: Option<i64> = conn
                    .query_row(
                        "SELECT delivered_at FROM outbox WHERE event_id='failed-export'",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert!(delivered.is_none());
            }
        }
    }

    #[tokio::test]
    async fn restore_lost_souls_nine() {
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
        let preserved_files = [
            &false_export,
            &unrelated_export,
            &active_incident_log,
            &rotated_incident_log,
            &lifecycle_log,
        ]
        .map(|path| (path.clone(), std::fs::read(path).unwrap()));
        let first = registry
            .finalize_stopped_repair_batch(
                operation_id.clone(),
                targets.clone(),
                roots.clone(),
                incident_root.clone(),
                lifecycle_log.clone(),
            )
            .await
            .expect("file withdrawal obstruction must return retryable progress");
        assert_eq!(first.status, SoulRepairStatus::Pending);
        assert_eq!(first.operation_id, operation_id);
        assert_eq!(
            (first.repaired_target_count, first.total_target_count),
            (9, 9)
        );
        assert_eq!(first.roots.len(), 7);
        for receipt in &roots {
            let result = first
                .roots
                .iter()
                .find(|root| root.root_session_id == receipt.root_session_id)
                .unwrap();
            assert_eq!(
                result.canonical_soul_id.as_ref(),
                Some(&receipt.canonical_soul_id)
            );
            assert_eq!(result.import_status, RootRepairImportStatus::Complete);
            assert_eq!(
                result.intent_revision,
                Some(receipt.captured_intent_revision)
            );
            assert_eq!(
                result.native_import_revision,
                Some(receipt.captured_native_import_revision + 1)
            );
        }
        assert_eq!(
            first.scope_id,
            registry
                .stopped_repair_operation_scope(operation_id.clone())
                .await
                .unwrap()
                .unwrap()
                .scope_id
        );
        let repeated = registry
            .finalize_stopped_repair_batch(
                operation_id.clone(),
                targets.clone(),
                roots.clone(),
                incident_root.clone(),
                lifecycle_log.clone(),
            )
            .await
            .unwrap();
        assert_eq!(repeated, first);
        for (path, bytes) in &preserved_files {
            assert_eq!(std::fs::read(path).unwrap(), *bytes);
        }
        assert_eq!(
            std::fs::read_to_string(&active_incident_log)
                .unwrap()
                .lines()
                .count(),
            2
        );
        assert!(false_export.exists());
        let pending: (String, String, Option<String>) = Connection::open(registry.database_path())
            .unwrap()
            .query_row(
                "SELECT o.status,w.status,o.result_json FROM stopped_repair_operations o JOIN stopped_repair_withdrawals w USING(operation_id) WHERE operation_id=?1",
                params![operation_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            pending,
            ("withdraw_pending".into(), "files_pending".into(), None)
        );

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
        assert!(registry
            .finalize_stopped_repair_batch(
                operation_id.clone(),
                targets.clone(),
                roots.clone(),
                incident_root.clone(),
                lifecycle_log.clone()
            )
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
        let completed = registry
            .finalize_stopped_repair_batch(
                operation_id.clone(),
                targets.clone(),
                roots.clone(),
                incident_root.clone(),
                lifecycle_log.clone(),
            )
            .await
            .unwrap();
        assert_eq!(completed.status, SoulRepairStatus::Complete);
        assert_eq!(completed.roots, first.roots);

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
        assert_eq!(result.repaired_target_count, 9);
        assert_eq!(result.total_target_count, 9);
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
        assert_eq!(distinct_incidents.len(), 9);
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

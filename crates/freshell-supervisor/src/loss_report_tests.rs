use super::*;
use crate::{
    admission::AdmissionPolicy,
    registry::{BackendCreatedRecord, LaunchPreparation, NativeImportState, RecoveryContext},
    service::{Supervisor, SupervisorConfig},
};
use freshell_runtime_protocol::{
    AllocationState, DockerDaemonId, DurabilityState, FixtureKind, HostBootId, IncarnationId,
    LaunchNonce, RecoveryBlockReason, RuntimeLimits, RuntimeProfile, SoulId,
};
use rusqlite::{params, Connection};
use std::collections::BTreeSet;

fn evidence(context: Option<&RecoveryContext>) -> Vec<RecoveryPathEvidence> {
    let (native_import_state, complete_inventory) = context
        .map(|context| {
            (
                context.native_import_state,
                context.native_import_complete_inventory,
            )
        })
        .unwrap_or((NativeImportState::NotApplicable, false));
    let native_import_evidence = match native_import_state {
        NativeImportState::Absent if complete_inventory => RecoveryPathEvidence {
            path: RecoveryPath::NativeImport,
            verdict: RecoveryEvidenceVerdict::DefinitiveNegative,
            reason_code: "source_inventory_complete_absent".into(),
            evidence_refs: vec!["nativeImport=complete_absent".into()],
            store_state: EvidenceStoreState::Missing,
        },
        NativeImportState::NotApplicable => RecoveryPathEvidence {
            path: RecoveryPath::NativeImport,
            verdict: RecoveryEvidenceVerdict::DefinitiveNegative,
            reason_code: "no_native_import_configured".into(),
            evidence_refs: vec!["nativeImport=not_applicable".into()],
            store_state: EvidenceStoreState::NotApplicable,
        },
        _ => RecoveryPathEvidence {
            path: RecoveryPath::NativeImport,
            verdict: RecoveryEvidenceVerdict::DefinitiveNegative,
            reason_code: "source_inventory_unresolved".into(),
            evidence_refs: vec!["nativeImport=unresolved".into()],
            store_state: EvidenceStoreState::Unknown,
        },
    };
    vec![
        RecoveryPathEvidence {
            path: RecoveryPath::Reattach,
            verdict: RecoveryEvidenceVerdict::DefinitiveNegative,
            reason_code: "runtime_absent".into(),
            evidence_refs: vec!["backend://missing".into()],
            store_state: EvidenceStoreState::NotApplicable,
        },
        RecoveryPathEvidence {
            path: RecoveryPath::NativeResume,
            verdict: RecoveryEvidenceVerdict::DefinitiveNegative,
            reason_code: "provider_store_missing".into(),
            evidence_refs: vec!["provider://missing".into()],
            store_state: EvidenceStoreState::Missing,
        },
        RecoveryPathEvidence {
            path: RecoveryPath::CheckpointRestore,
            verdict: RecoveryEvidenceVerdict::DefinitiveNegative,
            reason_code: "checkpoint_missing".into(),
            evidence_refs: vec!["checkpointRevision=0".into()],
            store_state: EvidenceStoreState::Missing,
        },
        RecoveryPathEvidence {
            path: RecoveryPath::PristineSeed,
            verdict: RecoveryEvidenceVerdict::DefinitiveNegative,
            reason_code: "input_was_dispatched".into(),
            evidence_refs: vec!["commandJournal.dispatched>0".into()],
            store_state: EvidenceStoreState::NotApplicable,
        },
        native_import_evidence,
    ]
}

fn limits() -> RuntimeLimits {
    RuntimeLimits {
        cpu_milli: 500,
        memory_bytes: 64 * 1024 * 1024,
        swap_bytes: 0,
        pids_max: 32,
    }
}

async fn prepared_context(root: &std::path::Path) -> (Registry, RecoveryContext) {
    let registry = Registry::open(root, None).unwrap();
    let context = prepared_context_in_registry(&registry, root).await;
    (registry, context)
}

async fn prepared_context_in_registry(
    registry: &Registry,
    root: &std::path::Path,
) -> RecoveryContext {
    let soul_id = SoulId::new();
    let prepared = registry
        .prepare_launch(LaunchPreparation {
            soul_id: soul_id.clone(),
            provider: "opencode".into(),
            provider_store_id: "store-test".into(),
            native_session_id: Some("ses_test_exact".into()),
            creation_seed_ref: "seed-test".into(),
            request_id: freshell_runtime_protocol::RequestId::new(),
            payload_digest: "payload-test".into(),
            requested_limits: limits(),
            profile: RuntimeProfile::Custom,
            project_key: "test-project".into(),
            fixture: None,
            terminal: None,
            fresh_agent: None,
            view_intent: None,
            admission: AdmissionPolicy::default(),
        })
        .await
        .unwrap();
    registry
        .commit_created(
            prepared.incarnation_id.clone(),
            BackendCreatedRecord {
                daemon_id: DockerDaemonId::new(),
                container_id: "a".repeat(64),
                image_ref: format!("sha256:{}", "b".repeat(64)),
                runtime_dir: root.join("runtime"),
                host_binary_path: root.join("runtime/host"),
                immutable_config_digest: format!("sha256:{}", "c".repeat(64)),
            },
        )
        .await
        .unwrap();
    registry
        .commit_execution_grant(prepared.incarnation_id.clone(), HostBootId::new(), limits())
        .await
        .unwrap();
    registry
        .mark_running(prepared.incarnation_id.clone())
        .await
        .unwrap();
    let conn = Connection::open(root.join("runtime.sqlite3")).unwrap();
    conn.execute(
        "UPDATE souls SET allocation_state='verified_durable' WHERE soul_id=?1",
        params![soul_id.as_str()],
    )
    .unwrap();
    drop(conn);
    registry.recovery_context(soul_id).await.unwrap()
}

fn decision_for(
    registry: &Registry,
    context: &RecoveryContext,
) -> Result<LostDecision, LossDecisionError> {
    LostDecision::try_new(LossDecisionInput {
        installation_id: registry.installation_id(),
        context,
        cleanup_handle: &context.prior_handle,
        path_evidence: evidence(Some(context)),
        builds: LossBuildEvidence {
            web_commit: "d".repeat(40),
            supervisor_commit: "d".repeat(40),
            host_image_digest: format!("sha256:{}", "b".repeat(64)),
            provider_version: "test".into(),
            protocol_version: 1,
            registry_schema_version: crate::registry::SCHEMA_VERSION,
        },
        timeline: vec![IncidentTimelineEvent {
            seq: 1,
            at: "2026-09-09T00:00:00.000Z".into(),
            event: "loss.checked".into(),
            evidence_ref: Some("registry://exact".into()),
            exit_code: None,
            oom_killed: None,
        }],
        analysis: IncidentAnalysis {
            observed_cause: "all_paths_absent".into(),
            missing_invariant: "durable_provider_state".into(),
            hypotheses: vec!["state_deleted".into()],
            preventive_action: "retain_state".into(),
            regression_case: "loss_stale_finalize".into(),
        },
        created_at: Some("2026-09-09T00:00:00.000Z".into()),
    })
}

async fn prepared_loss(root: &std::path::Path) -> (Registry, PreparedLoss) {
    let (registry, prepared_loss, _) = prepared_loss_with_decision(root).await;
    (registry, prepared_loss)
}

async fn prepared_loss_with_decision(
    root: &std::path::Path,
) -> (Registry, PreparedLoss, LostDecision) {
    let (registry, context) = prepared_context(root).await;
    let decision = decision_for(&registry, &context).unwrap();
    let prepared_loss = registry.prepare_loss(decision.clone()).await.unwrap();
    (registry, prepared_loss, decision)
}

fn cleanup(prepared: &PreparedLoss) -> LossCleanupReport {
    LossCleanupReport {
        owned_handle_ref: prepared.certificate.cleanup_target.owned_handle_ref.clone(),
        ownership_verified: true,
        graceful_attempt: "completed".into(),
        forced_attempt: "not_required".into(),
        verified_empty: true,
        verified_at: Some("2026-09-09T00:00:01.000Z".into()),
        foreign_objects_touched: 0,
    }
}

#[test]
fn unknown_or_unreadable_path_can_never_construct_loss() {
    let mut rows = evidence(None);
    rows[1].store_state = EvidenceStoreState::PresentUnreadable;
    assert!(matches!(
        validate_path_inventory(
            &[
                RecoveryPath::Reattach,
                RecoveryPath::NativeResume,
                RecoveryPath::CheckpointRestore,
                RecoveryPath::PristineSeed,
                RecoveryPath::NativeImport,
            ],
            &rows,
        ),
        Err(LossDecisionError::UnknownPathEvidence("native_resume"))
    ));
    rows[1].store_state = EvidenceStoreState::Unknown;
    assert!(validate_path_inventory(
        &[
            RecoveryPath::Reattach,
            RecoveryPath::NativeResume,
            RecoveryPath::CheckpointRestore,
            RecoveryPath::PristineSeed,
            RecoveryPath::NativeImport,
        ],
        &rows,
    )
    .is_err());
}

#[test]
fn missing_or_duplicate_manifest_path_can_never_construct_loss() {
    let mut rows = evidence(None);
    rows.pop();
    assert_eq!(
        validate_path_inventory(
            &[
                RecoveryPath::Reattach,
                RecoveryPath::NativeResume,
                RecoveryPath::CheckpointRestore,
                RecoveryPath::PristineSeed,
                RecoveryPath::NativeImport,
            ],
            &rows,
        ),
        Err(LossDecisionError::IncompletePathInventory)
    );
    rows.push(rows[0].clone());
    assert_eq!(
        validate_path_inventory(
            &[
                RecoveryPath::Reattach,
                RecoveryPath::NativeResume,
                RecoveryPath::CheckpointRestore,
                RecoveryPath::PristineSeed,
                RecoveryPath::NativeImport,
            ],
            &rows,
        ),
        Err(LossDecisionError::IncompletePathInventory)
    );
}

#[tokio::test]
async fn allocated_or_materializing_souls_cannot_be_certified_lost() {
    let dir = tempfile::tempdir().unwrap();
    let (registry, context) = prepared_context(dir.path()).await;

    for allocation_state in [AllocationState::Allocated, AllocationState::Materializing] {
        let mut candidate = context.clone();
        candidate.allocation_state = allocation_state;
        assert!(
            decision_for(&registry, &candidate).is_err(),
            "{allocation_state:?} soul must stay retryable instead of becoming Lost"
        );
    }
}

#[tokio::test]
async fn loss_commit_rejects_newer_materialization_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let (registry, context) = prepared_context(dir.path()).await;
    let decision = decision_for(&registry, &context).unwrap();

    let conn = Connection::open(dir.path().join("runtime.sqlite3")).unwrap();
    conn.execute(
        "UPDATE souls SET allocation_state='materializing',evidence_revision=evidence_revision+1 WHERE soul_id=?1",
        params![context.soul_id.as_str()],
    )
    .unwrap();
    drop(conn);

    assert!(registry.prepare_loss(decision).await.is_err());
    let conn = Connection::open(dir.path().join("runtime.sqlite3")).unwrap();
    let incidents: u64 = conn
        .query_row(
            "SELECT COUNT(*) FROM loss_incidents WHERE soul_id=?1",
            params![context.soul_id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        incidents, 0,
        "stale loss evidence must not commit a certificate"
    );
    let (desired, recovery): (String, String) = conn
        .query_row(
            "SELECT desired_state,recovery_state FROM souls WHERE soul_id=?1",
            params![context.soul_id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!((desired.as_str(), recovery.as_str()), ("running", "live"));
}

#[tokio::test]
async fn loss_commit_rejects_newer_native_import_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let (registry, context) = prepared_context(dir.path()).await;
    let decision = decision_for(&registry, &context).unwrap();

    let conn = Connection::open(dir.path().join("runtime.sqlite3")).unwrap();
    conn.execute(
        "UPDATE souls SET native_import_state='pending',native_import_revision=native_import_revision+1,evidence_revision=evidence_revision+1 WHERE soul_id=?1",
        params![context.soul_id.as_str()],
    )
    .unwrap();
    drop(conn);

    assert!(registry.prepare_loss(decision).await.is_err());
    let conn = Connection::open(dir.path().join("runtime.sqlite3")).unwrap();
    let incidents: u64 = conn
        .query_row(
            "SELECT COUNT(*) FROM loss_incidents WHERE soul_id=?1",
            params![context.soul_id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(incidents, 0, "stale import evidence cannot certify loss");
    let (desired, recovery): (String, String) = conn
        .query_row(
            "SELECT desired_state,recovery_state FROM souls WHERE soul_id=?1",
            params![context.soul_id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!((desired.as_str(), recovery.as_str()), ("running", "live"));
}

#[tokio::test]
async fn incomplete_or_unresolved_native_import_states_cannot_be_certified_lost() {
    let dir = tempfile::tempdir().unwrap();
    let (registry, mut context) = prepared_context(dir.path()).await;
    let conn = Connection::open(dir.path().join("runtime.sqlite3")).unwrap();
    for state in [
        NativeImportState::Pending,
        NativeImportState::Available,
        NativeImportState::Unresolved,
        NativeImportState::Unreadable,
        NativeImportState::Unsupported,
        NativeImportState::ExpiredStage,
        NativeImportState::Partial,
        NativeImportState::Completed,
        NativeImportState::LegacyUnknown,
    ] {
        conn.execute(
            "UPDATE souls SET native_import_state=?1,native_import_revision=native_import_revision+1 WHERE soul_id=?2",
            params![state.as_str(), context.soul_id.as_str()],
        )
        .unwrap();
        context = registry
            .recovery_context(context.soul_id.clone())
            .await
            .unwrap();
        assert!(
            decision_for(&registry, &context).is_err(),
            "{state:?} must remain retryable instead of being certified lost"
        );
    }
}

#[tokio::test]
async fn complete_absence_of_the_exact_native_import_source_can_be_certified_lost() {
    let dir = tempfile::tempdir().unwrap();
    let (registry, mut context) = prepared_context(dir.path()).await;
    let conn = Connection::open(dir.path().join("runtime.sqlite3")).unwrap();
    let source_path = dir.path().join("opencode.db");
    let _source = crate::registry::tests::native_inventory_fixture(&source_path);
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
    let inventory = freshell_sessions::opencode_transfer::HostOpenCodeInventory::new(source_path);
    let census = inventory
        .inspect_exact_origin(&store, "ses_test_exact")
        .unwrap();
    conn.execute(
        "UPDATE souls SET native_import_state='completed',native_import_source_store_id=?1,native_import_root_session_id='ses_test_exact',native_import_source_generation=?2,native_import_schema_fingerprint=?3,native_import_migration_fingerprint=?4 WHERE soul_id=?5",
        params![store, "e".repeat(64), census.schema_fingerprint(), census.migration_fingerprint(), context.soul_id.as_str()],
    ).unwrap();
    context = registry
        .recovery_context(context.soul_id.clone())
        .await
        .unwrap();
    context = registry
        .refresh_native_import_inventory(&context, Ok(inventory))
        .await
        .unwrap();
    assert_eq!(context.native_import_state, NativeImportState::Absent);
    assert!(context.native_import_complete_inventory);
    let decision = decision_for(&registry, &context).unwrap();
    assert!(registry.prepare_loss(decision).await.is_ok());
}

#[tokio::test]
async fn stale_intent_cannot_finalize_or_release_the_certified_writer() {
    let dir = tempfile::tempdir().unwrap();
    let (registry, prepared, original_decision) = prepared_loss_with_decision(dir.path()).await;
    let db = dir.path().join("runtime.sqlite3");
    let conn = Connection::open(&db).unwrap();
    conn.execute(
        "UPDATE souls SET desired_state='running',intent_revision=intent_revision+1,recovery_state='live',loss_incident_id=NULL WHERE soul_id=?1",
        params![prepared.certificate.soul_id.as_str()],
    )
    .unwrap();
    drop(conn);

    let replay_error = registry.prepare_loss(original_decision).await.unwrap_err();
    assert!(matches!(
        replay_error,
        RegistryError::StaleIntentRevision { .. }
    ));
    let error = registry
        .finalize_loss_cleanup(
            prepared.certificate.incident_id.clone(),
            StopOutcome::VerifiedEmpty,
            cleanup(&prepared),
        )
        .await
        .unwrap_err();
    assert!(matches!(error, RegistryError::StaleIntentRevision { .. }));
    let conn = Connection::open(&db).unwrap();
    let state: String = conn
        .query_row(
            "SELECT cleanup_state FROM loss_incidents WHERE incident_id=?1",
            params![prepared.certificate.incident_id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    let claims: u64 = conn
        .query_row(
            "SELECT COUNT(*) FROM writer_claims WHERE incarnation_id=?1",
            params![prepared.handle.incarnation_id().as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(state, "cleanup_pending");
    assert_eq!(claims, 1);
}

#[tokio::test]
async fn cleanup_result_must_match_exact_handle_and_zero_foreign_objects() {
    let dir = tempfile::tempdir().unwrap();
    let (registry, prepared) = prepared_loss(dir.path()).await;
    let mut report = cleanup(&prepared);
    report.foreign_objects_touched = 1;
    let error = registry
        .finalize_loss_cleanup(
            prepared.certificate.incident_id.clone(),
            StopOutcome::VerifiedEmpty,
            report,
        )
        .await
        .unwrap_err();
    assert!(matches!(error, RegistryError::InvalidState(_)));
}

#[tokio::test]
async fn closed_incident_retry_uses_persisted_cleanup_notice_semantics() {
    let dir = tempfile::tempdir().unwrap();
    let (registry, prepared) = prepared_loss(dir.path()).await;
    let first = registry
        .finalize_loss_cleanup(
            prepared.certificate.incident_id.clone(),
            StopOutcome::VerifiedEmpty,
            cleanup(&prepared),
        )
        .await
        .unwrap();
    let mut conflicting_retry = cleanup(&prepared);
    conflicting_retry.graceful_attempt = "not_required".into();
    let retry = registry
        .finalize_loss_cleanup(
            prepared.certificate.incident_id.clone(),
            StopOutcome::VerifiedEmpty,
            conflicting_retry,
        )
        .await
        .unwrap();
    assert_eq!(first.notice_id, retry.notice_id);
    assert_eq!(retry.kind, NoticeKind::CleanupSucceeded);
}

#[tokio::test]
async fn stopped_repair_checks_every_exact_loss_revision_before_source_access() {
    use freshell_runtime_protocol::{
        LostSoulRepairTarget, RequestId, RestoreLostSoulsRequest, RuntimeErrorCode,
    };

    let dir = tempfile::tempdir().unwrap();
    let registry = Registry::open(dir.path(), None).unwrap();
    let mut targets = Vec::new();
    for _ in 0..8 {
        let context = prepared_context_in_registry(&registry, dir.path()).await;
        let decision = decision_for(&registry, &context).unwrap();
        let prepared = registry.prepare_loss(decision).await.unwrap();
        registry
            .finalize_loss_cleanup(
                prepared.certificate.incident_id.clone(),
                freshell_runtime_protocol::StopOutcome::VerifiedEmpty,
                cleanup(&prepared),
            )
            .await
            .unwrap();
        targets.push(LostSoulRepairTarget {
            soul_id: prepared.certificate.soul_id,
            incident_id: prepared.certificate.incident_id,
            expected_intent_revision: prepared.committed_intent_revision,
        });
    }
    targets[4].expected_intent_revision += 1;
    let supervisor = crate::recovery::tests::missing_supervisor(&dir, registry.clone());
    let result = supervisor
        .restore_lost_souls(
            RequestId::new(),
            RestoreLostSoulsRequest {
                targets,
                canonical_owners: Vec::new(),
                expected_control_epoch: Some(registry.control_epoch()),
            },
        )
        .await;

    assert_eq!(
        result.unwrap_err().code,
        RuntimeErrorCode::StaleIntentRevision
    );
}

#[tokio::test]
async fn stopped_repair_retry_after_withdrawal_cas_resumes_without_lost_row_validation() {
    use freshell_runtime_protocol::{LostSoulRepairTarget, RequestId, RestoreLostSoulsRequest};

    let dir = tempfile::tempdir().unwrap();
    let registry = Registry::open(dir.path(), None).unwrap();
    let mut targets = Vec::new();
    for _ in 0..8 {
        let context = prepared_context_in_registry(&registry, dir.path()).await;
        let decision = decision_for(&registry, &context).unwrap();
        let prepared = registry.prepare_loss(decision).await.unwrap();
        registry
            .finalize_loss_cleanup(
                prepared.certificate.incident_id.clone(),
                freshell_runtime_protocol::StopOutcome::VerifiedEmpty,
                cleanup(&prepared),
            )
            .await
            .unwrap();
        targets.push(LostSoulRepairTarget {
            soul_id: prepared.certificate.soul_id,
            incident_id: prepared.certificate.incident_id,
            expected_intent_revision: prepared.committed_intent_revision,
        });
    }
    let operation_id = RequestId::new();
    let request = RestoreLostSoulsRequest {
        targets: targets.clone(),
        canonical_owners: Vec::new(),
        expected_control_epoch: Some(registry.control_epoch()),
    };
    let prepared = registry
        .prepare_stopped_repair_operation(operation_id.clone(), request.clone())
        .await
        .unwrap();
    assert_eq!(prepared.status, "importing");

    Connection::open(registry.database_path())
        .unwrap()
        .execute(
            "UPDATE stopped_repair_operations SET status='withdraw_pending' WHERE operation_id=?1",
            params![operation_id.to_string()],
        )
        .unwrap();
    for target in &targets {
        Connection::open(registry.database_path())
            .unwrap()
            .execute(
                "DELETE FROM loss_incidents WHERE incident_id=?1 AND soul_id=?2",
                params![target.incident_id.as_str(), target.soul_id.as_str()],
            )
            .unwrap();
    }

    let resumed = registry
        .prepare_stopped_repair_operation(operation_id, request)
        .await
        .unwrap();
    assert_eq!(resumed.status, "withdraw_pending");
}

#[tokio::test]
async fn stopped_repair_first_cas_completes_seven_roots_and_withdraws_only_false_loss_records() {
    use freshell_runtime_protocol::{
        opencode_target_build_receipt, opencode_transfer_bundle_digest, IncidentId,
        LostSoulRepairTarget, NoticeKind, OpenCodeAdoptionBaseline, OpenCodeTransferDescriptor,
        OpenCodeTransferFile, RequestId, RestoreLostSoulsRequest, SoulRepairStatus,
        UpsertViewIntentRequest, ViewIntentId, ViewIntentKind, ViewIntentRequest,
        OPENCODE_TRANSFER_DESTINATION_DB,
    };

    let dir = tempfile::tempdir().unwrap();
    let registry = Registry::open(dir.path(), None).unwrap();
    let schema_fingerprint = "a".repeat(64);
    let migration_fingerprint = "b".repeat(64);
    let mut targets = Vec::new();
    let mut contexts = Vec::new();

    for index in 0..8 {
        let context = prepared_context_in_registry(&registry, dir.path()).await;
        let prepared = registry
            .prepare_loss(decision_for(&registry, &context).unwrap())
            .await
            .unwrap();
        registry
            .finalize_loss_cleanup(
                prepared.certificate.incident_id.clone(),
                freshell_runtime_protocol::StopOutcome::VerifiedEmpty,
                cleanup(&prepared),
            )
            .await
            .unwrap();

        let root_index = index.min(6);
        let root_session_id = format!("ses_repair_root_{root_index}");
        let terminal_spec = serde_json::json!({
            "terminalId": format!("term-repair-{index}"),
            "streamId": format!("stream-repair-{index}"),
            "mode": "opencode",
            "program": "opencode",
            "env": {
                "HOME": "/home/freshell/provider",
                "XDG_DATA_HOME": "/home/freshell/provider/.local/share",
                "XDG_CONFIG_HOME": "/home/freshell/provider/.config"
            },
            "cwd": "/workspace",
            "runAsUid": 65534,
            "runAsGid": 65534,
            "cols": 80,
            "rows": 24,
            "projectKey": "test-project",
            "workspacePath": "/workspace"
        })
        .to_string();
        let mut conn = Connection::open(registry.database_path()).unwrap();
        let tx = conn.transaction().unwrap();
        tx.execute(
            "UPDATE souls SET native_session_id=?1,native_import_state='legacy_unknown', \
             native_import_source_store_id=NULL,native_import_root_session_id=NULL, \
             native_import_source_generation=NULL,native_import_schema_fingerprint=NULL, \
             native_import_migration_fingerprint=NULL,native_import_complete_inventory=0, \
             native_import_authority='legacy_unknown' WHERE soul_id=?2",
            params![root_session_id, prepared.certificate.soul_id.as_str()],
        )
        .unwrap();
        tx.execute(
            "UPDATE incarnations SET terminal_spec=?1 WHERE incarnation_id=?2",
            params![
                terminal_spec,
                context.prior_handle.incarnation_id().as_str()
            ],
        )
        .unwrap();
        tx.execute(
            "UPDATE loss_incidents SET captured_native_import_state='legacy_unknown', \
             captured_native_import_complete=0,captured_native_import_authority='legacy_unknown', \
             captured_source_store_id=NULL,captured_root_session_id=NULL,captured_source_generation=NULL, \
             captured_source_schema_fingerprint=NULL,captured_migration_fingerprint=NULL \
             WHERE incident_id=?1 AND soul_id=?2",
            params![
                prepared.certificate.incident_id.as_str(),
                prepared.certificate.soul_id.as_str(),
            ],
        )
        .unwrap();
        tx.commit().unwrap();

        targets.push(LostSoulRepairTarget {
            soul_id: prepared.certificate.soul_id,
            incident_id: prepared.certificate.incident_id,
            expected_intent_revision: prepared.committed_intent_revision,
        });
        contexts.push(
            registry
                .recovery_context(targets[index].soul_id.clone())
                .await
                .unwrap(),
        );
    }

    let owner_id = "repair-test-owner";
    let workspace_id = "test-project";
    for index in [6, 7] {
        registry
            .upsert_view_intent(UpsertViewIntentRequest {
                soul_id: targets[index].soul_id.clone(),
                view_id: None,
                intent: ViewIntentRequest {
                    owner_id: owner_id.into(),
                    workspace_id: workspace_id.into(),
                    kind: ViewIntentKind::AutomaticPrimary,
                    ..ViewIntentRequest::default()
                },
                expected_revision: None,
                expected_soul_intent_revision: targets[index].expected_intent_revision,
                expected_control_epoch: None,
            })
            .await
            .unwrap();
    }
    let explicit_duplicate_view = ViewIntentId::parse("view-repair-duplicate-explicit").unwrap();
    registry
        .upsert_view_intent(UpsertViewIntentRequest {
            soul_id: targets[7].soul_id.clone(),
            view_id: Some(explicit_duplicate_view.clone()),
            intent: ViewIntentRequest {
                owner_id: owner_id.into(),
                workspace_id: workspace_id.into(),
                kind: ViewIntentKind::Explicit,
                preferred_tab_id: Some("tab-explicit-repair".into()),
                preferred_pane_id: Some("pane-explicit-repair".into()),
                ..ViewIntentRequest::default()
            },
            expected_revision: None,
            expected_soul_intent_revision: targets[7].expected_intent_revision,
            expected_control_epoch: None,
        })
        .await
        .unwrap();

    let operation_id = RequestId::new();
    let request = RestoreLostSoulsRequest {
        targets: targets.clone(),
        canonical_owners: Vec::new(),
        expected_control_epoch: Some(registry.control_epoch()),
    };
    let operation = registry
        .prepare_stopped_repair_operation(operation_id.clone(), request)
        .await
        .unwrap();
    assert_eq!(operation.status, "importing");

    let mut roots = Vec::new();
    for root_index in 0..7 {
        let context = &contexts[root_index];
        let target = &targets[root_index];
        let root_session_id = format!("ses_repair_root_{root_index}");
        let source_store_id = format!(
            "{:x}",
            Sha256::digest(format!("host-store-{root_index}").as_bytes())
        );
        let source_generation = format!(
            "{:x}",
            Sha256::digest(format!("generation-{root_index}").as_bytes())
        );
        let transfer_id = format!("transfer-root-{root_index}");
        let target_image_ref = context.prior_handle.image_ref().to_owned();
        let target_build_receipt =
            opencode_target_build_receipt(&target_image_ref, "opencode-1.18.21");
        let payload_sha256 = format!("{:x}", Sha256::digest(b"x"));
        let manifest_json = serde_json::json!({
            "version": 1,
            "provider_schema": "opencode-1.18.21",
            "root_session_id": root_session_id,
            "source_store_id": source_store_id,
            "source_schema_fingerprint": schema_fingerprint,
            "migration_journal_fingerprint": migration_fingerprint,
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
            source_schema_fingerprint: schema_fingerprint.clone(),
            migration_journal_fingerprint: migration_fingerprint.clone(),
            destination_store_id: context.provider_store_id.clone(),
            destination_database_path: OPENCODE_TRANSFER_DESTINATION_DB.into(),
            target_image_ref: target_image_ref.clone(),
            target_build_receipt: target_build_receipt.clone(),
            incarnation_id: context.prior_handle.incarnation_id().as_str().into(),
            manifest_json,
            files,
            total_bytes: 1,
            bundle_sha256: String::new(),
        };
        descriptor.bundle_sha256 =
            opencode_transfer_bundle_digest(&descriptor.manifest_json, &descriptor.files);
        let adoption_baseline = OpenCodeAdoptionBaseline {
            manifest_sha256: format!("{:x}", Sha256::digest(descriptor.manifest_json.as_bytes())),
            descriptor: descriptor.clone(),
        };
        adoption_baseline.validate().unwrap();
        let execution_generation: u64 = Connection::open(registry.database_path())
            .unwrap()
            .query_row(
                "SELECT execution_generation FROM incarnations WHERE incarnation_id=?1",
                params![context.prior_handle.incarnation_id().as_str()],
                |row| row.get(0),
            )
            .unwrap();
        let receipt = crate::registry::StoppedRepairRootReceipt {
            root_session_id,
            canonical_soul_id: target.soul_id.clone(),
            transfer_id,
            adoption_baseline,
            destination_store_id: context.provider_store_id.clone(),
            source_store_id,
            source_generation,
            bundle_sha256: descriptor.bundle_sha256,
            source_schema_fingerprint: schema_fingerprint.clone(),
            migration_journal_fingerprint: migration_fingerprint.clone(),
            target_image_ref,
            target_build_receipt,
            row_count: 0,
            asset_count: 0,
            structural_sha256: "c".repeat(64),
            provider_uid: context.terminal.as_ref().unwrap().run_as_uid,
            provider_gid: context.terminal.as_ref().unwrap().run_as_gid,
            reader_environment_sha256: "d".repeat(64),
            captured_identity_revision: context.identity_revision,
            captured_evidence_revision: context.evidence_revision,
            captured_intent_revision: target.expected_intent_revision,
            captured_native_import_revision: context.native_import_revision,
            captured_native_import_state: context.native_import_state.as_str().into(),
            captured_native_import_authority: context.native_import_authority.clone(),
            incarnation_id: context.prior_handle.incarnation_id().clone(),
            execution_generation,
        };
        registry
            .persist_stopped_repair_root_receipt(
                operation_id.clone(),
                target.clone(),
                context.clone(),
                receipt.clone(),
            )
            .await
            .unwrap();
        roots.push(receipt);
    }
    assert_eq!(
        registry
            .stopped_repair_root_receipts(operation_id.clone())
            .await
            .unwrap(),
        roots,
        "all seven exact receipt summaries must be durable before the CAS"
    );

    // Model the stale duplicate as the current owner of the shared native
    // origin so the CAS must transfer that exact ownership to target 6.
    Connection::open(registry.database_path())
        .unwrap()
        .execute(
            "INSERT INTO native_origin_owners(provider,source_store_id,native_root_session_id,owner_soul_id,source_generation,ownership_state,updated_at) \
             VALUES ('opencode',?1,?2,?3,?4,'owned',1)",
            params![
                roots[6].source_store_id,
                roots[6].root_session_id,
                targets[7].soul_id.as_str(),
                roots[6].source_generation,
            ],
        )
        .unwrap();

    // Keep a valid unrelated notice and outbox event beside the eight false
    // incidents. Their presence proves cleanup selects exact IDs and event
    // kinds rather than emptying the projection tables.
    {
        let mut conn = Connection::open(registry.database_path()).unwrap();
        let tx = conn.transaction().unwrap();
        crate::notice_outbox::enqueue_notice_in_tx(
            &tx,
            NoticeKind::CleanupSucceeded,
            &[IncidentId::parse("incident-unrelated").unwrap()],
            0,
            1_800_000_000_000,
        )
        .unwrap();
        tx.execute(
            "INSERT INTO outbox(event_id,event_kind,payload,created_at,delivered_at) \
             VALUES ('unrelated-sentinel','unrelated.event','{}',?1,NULL)",
            params![1_800_000_000_000_i64],
        )
        .unwrap();
        tx.commit().unwrap();
    }

    let incident_root = dir.path().join("incidents");
    std::fs::create_dir_all(&incident_root).unwrap();
    let lifecycle_log = dir.path().join("logs/lifecycle.jsonl");
    std::fs::create_dir_all(lifecycle_log.parent().unwrap()).unwrap();
    let mut false_lines = String::new();
    for target in &targets {
        let incident_id = target.incident_id.as_str();
        std::fs::write(
            incident_root.join(format!("{incident_id}.open.json")),
            serde_json::json!({"incidentId": incident_id}).to_string(),
        )
        .unwrap();
        std::fs::write(
            incident_root.join(format!("{incident_id}.closed.json")),
            serde_json::json!({"incidentId": incident_id}).to_string(),
        )
        .unwrap();
        false_lines.push_str(
            &serde_json::json!({"incidentId": incident_id, "event": "soul.loss.finalized"})
                .to_string(),
        );
        false_lines.push('\n');
    }
    let unrelated_line = "{\"incidentId\":\"incident-false-0-extra\",\"event\":\"keep\"}\n";
    std::fs::write(
        incident_root.join("incidents.jsonl"),
        format!("{false_lines}{unrelated_line}"),
    )
    .unwrap();
    std::fs::write(&lifecycle_log, format!("{false_lines}{unrelated_line}")).unwrap();
    let similar_export = incident_root.join("incident-false-0-extra.closed.json");
    std::fs::write(&similar_export, b"unrelated exact-id neighbor").unwrap();

    let result = registry
        .finalize_stopped_repair_batch(
            operation_id.clone(),
            targets.clone(),
            roots.clone(),
            incident_root.clone(),
            lifecycle_log.clone(),
        )
        .await
        .unwrap();

    assert_eq!(result.operation_id, operation_id);
    assert_eq!(result.status, SoulRepairStatus::Complete);
    assert_eq!(result.repaired_target_count, 8);
    assert_eq!(result.total_target_count, 8);
    assert_eq!(result.roots.len(), 7);
    assert!(result.roots.iter().all(|root| {
        root.canonical_soul_id.is_some()
            && root.import_status == freshell_runtime_protocol::RootRepairImportStatus::Complete
            && root.native_import_revision == Some(1)
    }));

    let conn = Connection::open(registry.database_path()).unwrap();
    for root_index in 0..7 {
        let canonical = &targets[root_index];
        let root_session_id = format!("ses_repair_root_{root_index}");
        let source_store_id = roots[root_index].source_store_id.clone();
        type RepairedSoulImportStateRow = (
            String,
            String,
            String,
            String,
            u64,
            Option<String>,
            Option<String>,
            Option<String>,
        );
        let (desired, recovery, import_state, authority, import_revision, stored_source, stored_root, loss_id): RepairedSoulImportStateRow = conn
            .query_row(
                "SELECT desired_state,recovery_state,native_import_state,native_import_authority, \
                 native_import_revision,native_import_source_store_id,native_import_root_session_id,loss_incident_id \
                 FROM souls WHERE soul_id=?1",
                params![canonical.soul_id.as_str()],
                |row| {
                    Ok((
                        row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?,
                        row.get(5)?, row.get(6)?, row.get(7)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(desired, "stopped");
        assert_eq!(recovery, "data_repair_complete");
        assert_eq!(import_state, "completed");
        assert_eq!(authority, "verified_import_receipt");
        assert_eq!(import_revision, 1);
        assert_eq!(stored_source.as_deref(), Some(source_store_id.as_str()));
        assert_eq!(stored_root.as_deref(), Some(root_session_id.as_str()));
        assert_eq!(loss_id, None);

        let origin: (Option<String>, String, String) = conn
            .query_row(
                "SELECT owner_soul_id,source_generation,ownership_state FROM native_origin_owners \
                 WHERE provider='opencode' AND source_store_id=?1 AND native_root_session_id=?2",
                params![source_store_id, root_session_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(origin.0.as_deref(), Some(canonical.soul_id.as_str()));
        assert_eq!(origin.1, roots[root_index].source_generation);
        assert_eq!(origin.2, "owned");

        let terminal_json: String = conn
            .query_row(
                "SELECT terminal_spec FROM incarnations WHERE incarnation_id=?1",
                params![contexts[root_index].prior_handle.incarnation_id().as_str()],
                |row| row.get(0),
            )
            .unwrap();
        let terminal: serde_json::Value = serde_json::from_str(&terminal_json).unwrap();
        assert!(
            terminal.pointer("/opencodeTransfer").is_none(),
            "resume evidence must stay separate from the staged-transfer descriptor"
        );
    }

    let repaired_context = registry
        .recovery_context(targets[0].soul_id.clone())
        .await
        .unwrap();
    let persisted_baseline = repaired_context
        .opencode_adoption_baseline
        .clone()
        .expect("completed repair receipt supplies an exact resume baseline");
    assert!(repaired_context
        .terminal
        .as_ref()
        .is_some_and(|terminal| terminal.opencode_transfer.is_none()));
    let next_intent_revision = registry
        .start_stopped_data_repair(
            targets[0].soul_id.clone(),
            targets[0].expected_intent_revision,
        )
        .await
        .unwrap();
    let running_repaired_context = registry
        .recovery_context(targets[0].soul_id.clone())
        .await
        .unwrap();
    assert_eq!(
        running_repaired_context.intent_revision,
        next_intent_revision
    );
    let exact_candidate =
        crate::resume_catalog::exact_resume_candidate(&running_repaired_context, None);
    assert!(
        exact_candidate.is_ok(),
        "exact repaired resume candidate failed: {exact_candidate:?}"
    );
    // The authenticated-host path uses this candidate when the provider has
    // exited but the session host is still running; it must retain the
    // completed repair baseline before the host performs its current-store
    // check.
    let host_resume_spec = exact_candidate
        .unwrap()
        .expect("exact host resume candidate");
    assert_eq!(
        host_resume_spec.opencode_adoption_baseline,
        Some(persisted_baseline.clone())
    );
    assert_eq!(
        host_resume_spec
            .environment
            .get("OPENCODE_DB")
            .map(String::as_str),
        Some("/home/freshell/provider/.local/share/opencode/opencode.db")
    );
    // A legacy stored specification takes an early return in the base
    // candidate builder. The authenticated host must receive the repaired
    // evidence on this path too, even after the soul has left repair state.
    let mut stored_context = running_repaired_context.clone();
    stored_context.recovery_state = freshell_runtime_protocol::RecoveryState::Blocked;
    let mut legacy_spec = host_resume_spec.clone();
    legacy_spec.opencode_adoption_baseline = None;
    legacy_spec.environment.remove("OPENCODE_DB");
    stored_context.resume_spec = Some(legacy_spec);
    let stored_host_candidate = crate::resume_catalog::exact_resume_candidate(
        &stored_context,
        stored_context.native_session_id.as_deref(),
    )
    .unwrap()
    .expect("stored legacy host resume candidate");
    assert_eq!(
        stored_host_candidate.opencode_adoption_baseline,
        Some(persisted_baseline.clone())
    );
    assert_eq!(
        stored_host_candidate.environment.get("OPENCODE_DB"),
        host_resume_spec.environment.get("OPENCODE_DB")
    );

    let mut stale_spec = stored_host_candidate;
    let stale_baseline = &roots[1].adoption_baseline;
    assert_ne!(stale_baseline, &persisted_baseline);
    stale_baseline.validate().unwrap();
    stale_spec.opencode_adoption_baseline = Some(stale_baseline.clone());
    stored_context.resume_spec = Some(stale_spec);
    assert!(matches!(
        crate::resume_catalog::exact_resume_candidate(
            &stored_context,
            stored_context.native_session_id.as_deref(),
        ),
        Err(freshell_runtime_protocol::RecoveryProbe::Blocked {
            reason: RecoveryBlockReason::WrongNativeIdentity,
            ..
        })
    ));
    let resume_probe = crate::recovery::offline_probe(&running_repaired_context).unwrap();
    let freshell_runtime_protocol::RecoveryProbe::ResumeReady { resume_spec, .. } = resume_probe
    else {
        panic!("repaired legacy soul should have an exact resume candidate: {resume_probe:?}");
    };
    assert_eq!(
        resume_spec.opencode_adoption_baseline,
        Some(persisted_baseline.clone())
    );
    assert_eq!(
        resume_spec
            .environment
            .get("OPENCODE_DB")
            .map(String::as_str),
        Some("/home/freshell/provider/.local/share/opencode/opencode.db")
    );
    assert_eq!(
        resume_spec
            .environment
            .get("XDG_DATA_HOME")
            .map(String::as_str),
        Some("/home/freshell/provider/.local/share")
    );

    let recovery_start = registry
        .begin_recovery_fenced(
            targets[0].soul_id.clone(),
            freshell_runtime_protocol::RecoveryTrigger::ManualRetry,
            freshell_runtime_protocol::RecoveryPath::NativeResume,
            running_repaired_context.write_fence(),
        )
        .await
        .unwrap();
    registry
        .mark_recovery_blocked(
            targets[0].soul_id.clone(),
            Some(recovery_start.attempt_id.clone()),
            RecoveryBlockReason::ProviderUnavailable,
            vec!["synthetic first resume reader failure".into()],
            recovery_start
                .context
                .write_fence_for_attempt(recovery_start.attempt_id.clone()),
        )
        .await
        .unwrap();
    let retrying_repaired_context = registry
        .recovery_context(targets[0].soul_id.clone())
        .await
        .unwrap();
    assert_eq!(
        retrying_repaired_context.recovery_state,
        freshell_runtime_protocol::RecoveryState::Blocked
    );
    let retry_probe = crate::recovery::offline_probe(&retrying_repaired_context).unwrap();
    let freshell_runtime_protocol::RecoveryProbe::ResumeReady {
        resume_spec: retry_spec,
        ..
    } = retry_probe
    else {
        panic!("repaired retry should preserve its adoption baseline: {retry_probe:?}");
    };
    assert_eq!(
        retry_spec.opencode_adoption_baseline,
        Some(persisted_baseline.clone())
    );
    assert_eq!(
        retry_spec
            .environment
            .get("OPENCODE_DB")
            .map(String::as_str),
        Some("/home/freshell/provider/.local/share/opencode/opencode.db")
    );

    let duplicate = &targets[7];
    let canonical_duplicate_root = &targets[6];
    let retired: (String, String, Option<String>, Option<String>) = conn
        .query_row(
            "SELECT desired_state,recovery_state,recovery_reason,loss_incident_id \
             FROM souls WHERE soul_id=?1",
            params![duplicate.soul_id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(
        retired,
        (
            "stopped".into(),
            "stopped".into(),
            Some("RETIRED_DUPLICATE".into()),
            None
        )
    );
    let duplicate_authority: String = conn
        .query_row(
            "SELECT native_import_authority FROM souls WHERE soul_id=?1",
            params![duplicate.soul_id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(duplicate_authority, "retired_duplicate");

    let explicit_owner: (String, String, u64) = conn
        .query_row(
            "SELECT soul_id,owner_id,revision FROM view_intents WHERE view_id=?1",
            params![explicit_duplicate_view.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(explicit_owner.0, canonical_duplicate_root.soul_id.as_str());
    assert_eq!(explicit_owner.1, owner_id);
    assert!(explicit_owner.2 > 1);
    let automatic_views: Vec<String> = conn
        .prepare(
            "SELECT soul_id FROM view_intents WHERE owner_id=?1 AND workspace_id=?2 \
             AND kind='automatic_primary' AND soul_id IN (?3,?4) ORDER BY soul_id",
        )
        .unwrap()
        .query_map(
            params![
                owner_id,
                workspace_id,
                canonical_duplicate_root.soul_id.as_str(),
                duplicate.soul_id.as_str(),
            ],
            |row| row.get(0),
        )
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(
        automatic_views,
        vec![canonical_duplicate_root.soul_id.as_str().to_owned()],
        "the canonical automatic view remains and its duplicate collapses"
    );

    for target in &targets {
        let incident_count: u64 = conn
            .query_row(
                "SELECT COUNT(*) FROM loss_incidents WHERE incident_id=?1 AND soul_id=?2",
                params![target.incident_id.as_str(), target.soul_id.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        let tombstone_count: u64 = conn
            .query_row(
                "SELECT COUNT(*) FROM stop_tombstones WHERE soul_id=?1 AND intent_revision=?2 \
                 AND actor='loss-certificate' AND reason=?3",
                params![
                    target.soul_id.as_str(),
                    target.expected_intent_revision,
                    format!("certified loss {}", target.incident_id),
                ],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(incident_count, 0);
        assert_eq!(tombstone_count, 0);
        for suffix in ["open", "final"] {
            let outbox_count: u64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM outbox WHERE event_id=?1 AND event_kind=?2",
                    params![
                        format!("projection-loss-{suffix}-{}", target.incident_id),
                        if suffix == "open" {
                            "loss_incident.open"
                        } else {
                            "loss_incident.final"
                        },
                    ],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(outbox_count, 0);
        }
        assert!(!incident_root
            .join(format!("{}.open.json", target.incident_id))
            .exists());
        assert!(!incident_root
            .join(format!("{}.closed.json", target.incident_id))
            .exists());
    }

    let remaining_notice_incidents: Vec<String> = conn
        .prepare("SELECT incident_ids_json FROM runtime_notices")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let remaining_notice_ids = remaining_notice_incidents
        .iter()
        .flat_map(|encoded| serde_json::from_str::<Vec<String>>(encoded).unwrap())
        .collect::<BTreeSet<_>>();
    let false_incident_ids = targets
        .iter()
        .map(|target| target.incident_id.as_str().to_owned())
        .collect::<BTreeSet<_>>();
    assert!(false_incident_ids.is_disjoint(&remaining_notice_ids));
    assert!(remaining_notice_ids.contains("incident-unrelated"));
    let projected_notice_payloads: Vec<String> = conn
        .prepare("SELECT payload FROM outbox WHERE event_kind='runtime.notice'")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let projected_notice_ids = projected_notice_payloads
        .iter()
        .flat_map(|encoded| {
            serde_json::from_str::<serde_json::Value>(encoded)
                .unwrap()
                .get("incidentIds")
                .and_then(serde_json::Value::as_array)
                .unwrap()
                .iter()
                .map(|value| value.as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        })
        .collect::<BTreeSet<_>>();
    assert!(false_incident_ids.is_disjoint(&projected_notice_ids));
    assert!(projected_notice_ids.contains("incident-unrelated"));
    let unrelated_event_count: u64 = conn
        .query_row(
            "SELECT COUNT(*) FROM outbox WHERE event_id='unrelated-sentinel' AND event_kind='unrelated.event'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(unrelated_event_count, 1);
    let unrelated_notice_count: u64 = conn
        .query_row(
            "SELECT COUNT(*) FROM outbox WHERE event_kind='runtime.notice' AND json_extract(payload,'$.incidentIds[0]')='incident-unrelated'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(unrelated_notice_count, 1);

    assert_eq!(
        std::fs::read_to_string(incident_root.join("incidents.jsonl")).unwrap(),
        unrelated_line
    );
    assert_eq!(
        std::fs::read_to_string(&lifecycle_log).unwrap(),
        unrelated_line
    );
    assert_eq!(
        std::fs::read(&similar_export).unwrap(),
        b"unrelated exact-id neighbor"
    );
    let (status, marker_count): (String, u64) = conn
        .query_row(
            "SELECT o.status,(SELECT COUNT(*) FROM stopped_repair_withdrawals w WHERE w.operation_id=o.operation_id) \
             FROM stopped_repair_operations o WHERE o.operation_id=?1",
            params![operation_id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(status, "complete");
    assert_eq!(marker_count, 0);
}

#[tokio::test]
async fn stale_lifecycle_writer_does_not_recreate_withdrawn_incident_after_retraction() {
    let dir = tempfile::tempdir().unwrap();
    let (registry, prepared) = prepared_loss(dir.path()).await;
    registry
        .finalize_loss_cleanup(
            prepared.certificate.incident_id.clone(),
            freshell_runtime_protocol::StopOutcome::VerifiedEmpty,
            cleanup(&prepared),
        )
        .await
        .unwrap();
    Connection::open(registry.database_path())
        .unwrap()
        .execute(
            "DELETE FROM loss_incidents WHERE incident_id=?1",
            params![prepared.certificate.incident_id.as_str()],
        )
        .unwrap();

    let lifecycle = dir.path().join("lifecycle.jsonl");
    let written = crate::service::append_incident_event_if_current(
        &registry,
        &lifecycle,
        "supervisor.loss.finalized",
        serde_json::json!({
            "incidentId": prepared.certificate.incident_id,
            "soulId": prepared.certificate.soul_id,
        }),
        prepared.certificate.incident_id,
    )
    .await
    .unwrap();

    assert!(!written);
    assert!(!lifecycle.exists());
}

#[test]
fn incident_export_redacts_and_never_evicts_open_reports() {
    let dir = tempfile::tempdir().unwrap();
    let exporter = IncidentExporter::new(dir.path(), "top-secret-native-id");
    let open = dir.path().join("incident-open.open.json");
    fs::write(&open, b"open").unwrap();
    let finalized_open = dir.path().join("incident-new.open.json");
    fs::write(&finalized_open, b"open").unwrap();
    let old = dir.path().join("incident-old.closed.json");
    fs::write(&old, vec![b'x'; 8]).unwrap();
    exporter
        .export_summary(
            &IncidentId::parse("incident-new").unwrap(),
            true,
            &serde_json::json!({
                "token": "top-secret-native-id",
                "safe": "retained"
            }),
        )
        .unwrap();
    assert!(open.exists());
    assert!(!finalized_open.exists());
    let content = fs::read_to_string(dir.path().join("incident-new.closed.json")).unwrap();
    assert!(!content.contains("top-secret-native-id"));
    assert!(content.contains("retained"));
}

#[test]
fn withdraw_false_incident_jsonl_matches_structured_ids_not_substrings() {
    let input = concat!(
        "{\"event\":\"soul.loss.finalized\",\"incidentId\":\"incident-target\",\"data\":{\"incidentId\":\"incident-target\"}}\n",
        "{\"incidentId\":\"incident-target-extra\",\"message\":\"incident-target\"}\n",
        "{\"incidentIds\":[\"incident-target\",\"incident-other\"],\"event\":\"notice\"}\n",
        "{\"event\":\"unrelated\",\"message\":\"mentions incident-target in prose\"}\n",
    );
    let targets = BTreeSet::from(["incident-target".to_string()]);

    let filtered = filter_incident_jsonl(input.as_bytes(), &targets).unwrap();

    assert_eq!(
        String::from_utf8(filtered).unwrap(),
        concat!(
            "{\"incidentId\":\"incident-target-extra\",\"message\":\"incident-target\"}\n",
            "{\"event\":\"unrelated\",\"message\":\"mentions incident-target in prose\"}\n",
        )
    );
}

#[test]
fn withdraw_false_incident_jsonl_blocks_unclassifiable_records() {
    let targets = BTreeSet::from(["incident-target".to_string()]);
    let input = b"{\"incidentId\":\"incident-target\"}\nnot-json\n";

    let error = filter_incident_jsonl(input, &targets).unwrap_err();

    assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    assert!(error.to_string().contains("record 2"));
}

#[test]
fn withdraw_false_incidents_removes_exact_exports_and_rewrites_rotations() {
    let dir = tempfile::tempdir().unwrap();
    let incident_root = dir.path().join("incidents");
    let lifecycle = dir.path().join("lifecycle.jsonl");
    std::fs::create_dir_all(&incident_root).unwrap();
    let false_id = "incident-false-1";
    let similar_id = "incident-false-10";

    std::fs::write(
        incident_root.join("incidents.jsonl"),
        format!(
            "{{\"incidentId\":\"{false_id}\",\"event\":\"false\"}}\n{{\"incidentId\":\"{similar_id}\",\"event\":\"unrelated\"}}\n"
        ),
    )
    .unwrap();
    std::fs::write(
        incident_root.join("incidents.jsonl.1"),
        format!(
            "{{\"incidentIds\":[\"{false_id}\",\"another\"],\"event\":\"mixed\"}}\n{{\"event\":\"body mentions {false_id}\"}}\n"
        ),
    )
    .unwrap();
    std::fs::write(
        &lifecycle,
        format!("{{\"data\":{{\"incident_id\":\"{false_id}\"}}}}\n{{\"event\":\"keep\"}}\n"),
    )
    .unwrap();
    std::fs::write(
        incident_root.join(format!("{false_id}.open.json")),
        b"obsolete open export",
    )
    .unwrap();
    std::fs::write(
        incident_root.join(format!("{false_id}.closed.json")),
        b"obsolete closed export",
    )
    .unwrap();
    std::fs::write(
        incident_root.join(format!("{similar_id}.open.json")),
        b"unrelated export",
    )
    .unwrap();

    IncidentExporter::new(&incident_root, "test-secret")
        .retract_false_incidents_coordinated(&BTreeSet::from([false_id.to_string()]), &lifecycle)
        .unwrap();

    assert_eq!(
        std::fs::read_to_string(incident_root.join("incidents.jsonl")).unwrap(),
        format!("{{\"incidentId\":\"{similar_id}\",\"event\":\"unrelated\"}}\n")
    );
    assert_eq!(
        std::fs::read_to_string(incident_root.join("incidents.jsonl.1")).unwrap(),
        format!("{{\"event\":\"body mentions {false_id}\"}}\n")
    );
    assert_eq!(
        std::fs::read_to_string(&lifecycle).unwrap(),
        "{\"event\":\"keep\"}\n"
    );
    assert!(!incident_root.join(format!("{false_id}.open.json")).exists());
    assert!(!incident_root
        .join(format!("{false_id}.closed.json"))
        .exists());
    assert!(incident_root
        .join(format!("{similar_id}.open.json"))
        .exists());
}

#[test]
fn withdraw_false_incidents_classifies_all_rotations_before_mutating() {
    let dir = tempfile::tempdir().unwrap();
    let incident_root = dir.path().join("incidents");
    let lifecycle = dir.path().join("lifecycle.jsonl");
    std::fs::create_dir_all(&incident_root).unwrap();
    let first = incident_root.join("incidents.jsonl");
    std::fs::write(&first, b"{\"incidentId\":\"incident-false-1\"}\n").unwrap();
    std::fs::write(incident_root.join("incidents.jsonl.1"), b"not-json\n").unwrap();

    let error = IncidentExporter::new(&incident_root, "test-secret")
        .retract_false_incidents_coordinated(
            &BTreeSet::from(["incident-false-1".to_string()]),
            &lifecycle,
        )
        .unwrap_err();

    assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    assert_eq!(
        std::fs::read_to_string(first).unwrap(),
        "{\"incidentId\":\"incident-false-1\"}\n"
    );
}

#[test]
fn ownership_capability_types_remain_in_supervisor_crate() {
    let _ = std::any::TypeId::of::<OwnedRuntimeHandle>();
    let _ = std::any::TypeId::of::<RecoveryContext>();
    let _ = std::any::TypeId::of::<LaunchPreparation>();
    let _ = std::any::TypeId::of::<Supervisor>();
    let _ = std::any::TypeId::of::<SupervisorConfig>();
    let _ = std::any::TypeId::of::<AdmissionPolicy>();
    let _ = std::any::TypeId::of::<RuntimeLimits>();
    let _ = std::any::TypeId::of::<RuntimeProfile>();
    let _ = std::any::TypeId::of::<FixtureKind>();
    let _ = std::any::TypeId::of::<SoulId>();
    let _ = std::any::TypeId::of::<IncarnationId>();
    let _ = std::any::TypeId::of::<LaunchNonce>();
    let _ = std::any::TypeId::of::<DockerDaemonId>();
    let _ = std::any::TypeId::of::<AllocationState>();
    let _ = std::any::TypeId::of::<DurabilityState>();
    let _ = std::any::TypeId::of::<RecoveryBlockReason>();
}

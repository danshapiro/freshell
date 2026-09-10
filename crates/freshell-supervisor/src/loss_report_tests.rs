use super::*;
use crate::{
    admission::AdmissionPolicy,
    registry::{BackendCreatedRecord, LaunchPreparation},
    service::{Supervisor, SupervisorConfig},
};
use freshell_runtime_protocol::{
    AllocationState, DockerDaemonId, DurabilityState, FixtureKind, HostBootId, IncarnationId,
    LaunchNonce, RecoveryBlockReason, RuntimeLimits, RuntimeProfile, SoulId,
};
use rusqlite::{params, Connection};

fn evidence() -> Vec<RecoveryPathEvidence> {
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

async fn prepared_loss(root: &std::path::Path) -> (Registry, PreparedLoss) {
    let registry = Registry::open(root, None).unwrap();
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
    let context = registry.recovery_context(soul_id).await.unwrap();
    let decision = LostDecision::try_new(LossDecisionInput {
        installation_id: registry.installation_id(),
        context: &context,
        cleanup_handle: &context.prior_handle,
        path_evidence: evidence(),
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
    .unwrap();
    let prepared_loss = registry.prepare_loss(decision).await.unwrap();
    (registry, prepared_loss)
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
    let mut rows = evidence();
    rows[1].store_state = EvidenceStoreState::PresentUnreadable;
    assert!(matches!(
        validate_path_inventory(
            &[
                RecoveryPath::Reattach,
                RecoveryPath::NativeResume,
                RecoveryPath::CheckpointRestore,
                RecoveryPath::PristineSeed,
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
        ],
        &rows,
    )
    .is_err());
}

#[test]
fn missing_or_duplicate_manifest_path_can_never_construct_loss() {
    let mut rows = evidence();
    rows.pop();
    assert_eq!(
        validate_path_inventory(
            &[
                RecoveryPath::Reattach,
                RecoveryPath::NativeResume,
                RecoveryPath::CheckpointRestore,
                RecoveryPath::PristineSeed,
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
            ],
            &rows,
        ),
        Err(LossDecisionError::IncompletePathInventory)
    );
}

#[tokio::test]
async fn stale_intent_cannot_finalize_or_release_the_certified_writer() {
    let dir = tempfile::tempdir().unwrap();
    let (registry, prepared) = prepared_loss(dir.path()).await;
    let db = dir.path().join("runtime.sqlite3");
    let conn = Connection::open(&db).unwrap();
    conn.execute(
        "UPDATE souls SET desired_state='running',intent_revision=intent_revision+1,recovery_state='live',loss_incident_id=NULL WHERE soul_id=?1",
        params![prepared.certificate.soul_id.as_str()],
    )
    .unwrap();
    drop(conn);

    let replay_error = registry
        .prepare_loss(LostDecision {
            certificate: prepared.certificate.clone(),
        })
        .await
        .unwrap_err();
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

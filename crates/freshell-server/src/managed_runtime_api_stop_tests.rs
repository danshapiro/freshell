use super::*;
use async_trait::async_trait;
use axum::{
    body::{to_bytes, Body},
    http::Request,
};
use freshell_runtime_protocol::*;
use freshell_supervisor::{
    admission::AdmissionPolicy,
    backend::{BackendCreated, BackendError, BackendInspection, CreateRuntimeSpec, RuntimeBackend},
    loss_report::{LossDecisionInput, LostDecision},
    registry::{BackendCreatedRecord, LaunchPreparation, OwnedRuntimeHandle, Registry},
    service::{serve_control, Supervisor, SupervisorConfig},
};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tower::ServiceExt;

/// No processes or containers are created. The real supervisor owns the stop
/// decision and registry writes; only the external runtime backend is replaced.
#[derive(Default)]
struct StopBackend {
    uncertain: AtomicBool,
    stopped: Mutex<Vec<(SoulId, IncarnationId)>>,
}

#[async_trait]
impl RuntimeBackend for StopBackend {
    async fn create_stopped(&self, _: &CreateRuntimeSpec) -> Result<BackendCreated, BackendError> {
        unreachable!()
    }
    async fn start_host(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
        unreachable!()
    }
    async fn inspect(&self, _: &OwnedRuntimeHandle) -> Result<BackendInspection, BackendError> {
        unreachable!()
    }
    async fn request_stop(&self, handle: &OwnedRuntimeHandle, _: u64) -> Result<(), BackendError> {
        self.stopped
            .lock()
            .unwrap()
            .push((handle.soul_id().clone(), handle.incarnation_id().clone()));
        if self.uncertain.load(Ordering::SeqCst) {
            Err(BackendError::DockerHttp {
                status: 503,
                body: "cleanup unconfirmed".into(),
            })
        } else {
            Ok(())
        }
    }
    async fn force_stop(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
        unreachable!()
    }
    async fn verify_empty(&self, _: &OwnedRuntimeHandle) -> Result<bool, BackendError> {
        Ok(true)
    }
    async fn list_known(
        &self,
        _: &[OwnedRuntimeHandle],
    ) -> Result<Vec<(IncarnationId, BackendInspection)>, BackendError> {
        unreachable!()
    }
    async fn read_limits(&self, _: &OwnedRuntimeHandle) -> Result<RuntimeLimits, BackendError> {
        unreachable!()
    }
    async fn enable_long_lived(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
        unreachable!()
    }
}

fn limits() -> RuntimeLimits {
    RuntimeLimits {
        cpu_milli: 500,
        memory_bytes: 64 * 1024 * 1024,
        swap_bytes: 0,
        pids_max: 32,
    }
}

async fn certified_lost_soul(root: &std::path::Path) -> (Registry, RuntimeView) {
    let registry = Registry::open(root, None).unwrap();
    let soul_id = SoulId::new();
    let fresh_agent: FreshAgentLaunchSpec = serde_json::from_value(json!({
        "sessionId": "fresh-retained-thread", "provider": "opencode", "sessionType": "freshopencode",
        "runtimeVariant": "opencode", "providerStoreId": "store-test", "cwd": "/workspace",
        "workspacePath": "/workspace", "runAsUid": 1000, "runAsGid": 1000,
        "nativeSessionId": "retained-thread"
    })).unwrap();
    let prepared = registry
        .prepare_launch(LaunchPreparation {
            soul_id: soul_id.clone(),
            provider: "opencode".into(),
            provider_store_id: "store-test".into(),
            native_session_id: Some("retained-thread".into()),
            creation_seed_ref: "seed-test".into(),
            request_id: RequestId::new(),
            payload_digest: "payload-test".into(),
            requested_limits: limits(),
            profile: RuntimeProfile::Custom,
            project_key: "workspace".into(),
            fixture: None,
            terminal: None,
            fresh_agent: Some(fresh_agent),
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
                host_binary_path: root.join("host"),
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
        .mark_running(prepared.incarnation_id)
        .await
        .unwrap();
    let context = registry.recovery_context(soul_id.clone()).await.unwrap();
    let paths = [
        (
            RecoveryPath::Reattach,
            EvidenceStoreState::NotApplicable,
            "runtime_absent",
        ),
        (
            RecoveryPath::NativeResume,
            EvidenceStoreState::Missing,
            "provider_store_missing",
        ),
        (
            RecoveryPath::CheckpointRestore,
            EvidenceStoreState::Missing,
            "checkpoint_missing",
        ),
        (
            RecoveryPath::PristineSeed,
            EvidenceStoreState::NotApplicable,
            "input_was_dispatched",
        ),
    ]
    .into_iter()
    .map(|(path, store_state, reason)| RecoveryPathEvidence {
        path,
        store_state,
        verdict: RecoveryEvidenceVerdict::DefinitiveNegative,
        reason_code: reason.into(),
        evidence_refs: vec![format!("fixture://{reason}")],
    })
    .collect();
    let decision = LostDecision::try_new(LossDecisionInput {
        installation_id: registry.installation_id(),
        context: &context,
        cleanup_handle: &context.prior_handle,
        path_evidence: paths,
        builds: LossBuildEvidence {
            web_commit: "d".repeat(40),
            supervisor_commit: "d".repeat(40),
            host_image_digest: format!("sha256:{}", "b".repeat(64)),
            provider_version: "fixture".into(),
            protocol_version: CONTROL_PROTOCOL_VERSION,
            registry_schema_version: freshell_supervisor::registry::SCHEMA_VERSION,
        },
        timeline: vec![IncidentTimelineEvent {
            seq: 1,
            at: "2026-10-03T00:00:00.000Z".into(),
            event: "loss.checked".into(),
            evidence_ref: Some("fixture://all-paths-absent".into()),
            exit_code: None,
            oom_killed: None,
        }],
        analysis: IncidentAnalysis {
            observed_cause: "all_paths_absent".into(),
            missing_invariant: "durable_provider_state".into(),
            hypotheses: vec!["state_deleted".into()],
            preventive_action: "retain_state".into(),
            regression_case: "stop_lost_soul".into(),
        },
        created_at: None,
    })
    .unwrap();
    let loss = registry.prepare_loss(decision).await.unwrap();
    registry
        .finalize_loss_cleanup(
            loss.certificate.incident_id,
            StopOutcome::TerminationUnconfirmed,
            LossCleanupReport {
                owned_handle_ref: loss.certificate.cleanup_target.owned_handle_ref,
                ownership_verified: true,
                graceful_attempt: "failed".into(),
                forced_attempt: "not_attempted".into(),
                verified_empty: false,
                verified_at: None,
                foreign_objects_touched: 0,
            },
        )
        .await
        .unwrap();
    let view = registry.inventory().await.unwrap().pop().unwrap();
    assert_eq!(view.desired_state, DesiredState::Stopped);
    assert_eq!(view.recovery_state, RecoveryState::Lost);
    assert_eq!(view.cleanup_state, CleanupState::TerminationUnconfirmed);
    (registry, view)
}

async fn web_router(socket: &std::path::Path, root: &std::path::Path) -> Router {
    let (tx, _) = tokio::sync::broadcast::channel(16);
    router(
        ManagedRuntimeApiState::new(
            Arc::new("web-token".into()),
            Some(RuntimeClient::new(socket, "test-control-secret")),
            Some(root.join("projections.json")),
            Arc::new(PaneLedger::new(Some(root.join("ledger")))),
            Arc::new(tx),
        )
        .await
        .unwrap(),
    )
}

async fn stop(
    router: &Router,
    view: &RuntimeView,
    revision: u64,
) -> (StatusCode, serde_json::Value) {
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/runtime/souls/{}/stop", view.soul_id))
                .header("x-auth-token", "web-token")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({ "requestId": RequestId::new(), "expectedIntentRevision": revision })
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap())
}

#[tokio::test]
async fn restored_web_stops_persisted_lost_soul_only_after_verified_cleanup() {
    let temp = tempfile::tempdir().unwrap();
    let (registry, before) = certified_lost_soul(temp.path()).await;
    let backend = Arc::new(StopBackend::default());
    backend.uncertain.store(true, Ordering::SeqCst);
    let socket = temp.path().join("control.sock");
    let supervisor = Supervisor::new(
        registry.clone(),
        backend.clone(),
        SupervisorConfig {
            runtime_root: temp.path().into(),
            control_socket_path: socket.clone(),
            host_binary_path: std::env::current_exe().unwrap(),
            image_ref: format!("sha256:{}", "b".repeat(64)),
            test_run_id: "stop-lost-fixture".into(),
            control_secret: "test-control-secret".into(),
            lifecycle_log: temp.path().join("lifecycle.jsonl"),
            admission: AdmissionPolicy::default(),
        },
    )
    .unwrap();
    let socket_for_server = socket.clone();
    let control =
        tokio::spawn(async move { serve_control(supervisor, &socket_for_server).await.unwrap() });
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while !socket.exists() {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();

    // Rebuild web state from persisted inventory, with no session alias cache.
    drop(web_router(&socket, temp.path()).await);
    let restored = web_router(&socket, temp.path()).await;
    let inventory_response = restored
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/runtime/souls")
                .header("x-auth-token", "web-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(inventory_response.status(), StatusCode::OK);
    let inventory: serde_json::Value = serde_json::from_slice(
        &to_bytes(inventory_response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        inventory["souls"][0]["freshAgentSessionId"],
        "fresh-retained-thread"
    );
    let (status, uncertain) = stop(&restored, &before, before.intent_revision).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(uncertain["outcome"], "termination_unconfirmed");
    assert_eq!(uncertain["soul"]["soulId"], before.soul_id.as_str());
    assert_eq!(uncertain["soul"]["nativeSessionId"], "retained-thread");
    assert_eq!(
        uncertain["soul"]["freshAgentSessionId"],
        "fresh-retained-thread"
    );
    assert_eq!(uncertain["soul"]["recoveryState"], "lost");
    assert_eq!(uncertain["soul"]["cleanupState"], "termination_unconfirmed");
    assert_eq!(
        registry
            .loss_certificate(before.incident_id.clone().unwrap())
            .await
            .unwrap()
            .soul_id,
        before.soul_id
    );

    let (status, _) = stop(&restored, &before, before.intent_revision - 1).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(backend.stopped.lock().unwrap().len(), 1);

    backend.uncertain.store(false, Ordering::SeqCst);
    let (status, verified) = stop(&restored, &before, before.intent_revision).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(verified["outcome"], "verified_empty");
    assert_eq!(verified["soul"]["cleanupState"], "verified_empty");
    assert_eq!(verified["soul"]["recoveryState"], "lost");
    assert_eq!(verified["soul"]["nativeSessionId"], "retained-thread");
    assert_eq!(verified["soul"]["intentRevision"], before.intent_revision);
    assert_eq!(
        *backend.stopped.lock().unwrap(),
        vec![(before.soul_id.clone(), before.incarnation_id.clone()); 2]
    );
    control.abort();
    let _ = control.await;
}

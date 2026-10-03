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
    history_home: Option<PathBuf>,
}

#[async_trait]
impl RuntimeBackend for StopBackend {
    async fn read_native_history(
        &self,
        handle: &OwnedRuntimeHandle,
        provider: &str,
        native_id: &str,
        _: &std::path::Path,
    ) -> Result<serde_json::Value, BackendError> {
        assert_eq!(handle.fresh_agent().unwrap().provider.as_str(), provider);
        freshell_freshagent::native_history::read(
            provider,
            self.history_home.as_deref().expect("owned native fixture"),
            native_id,
        )
        .map_err(BackendError::Unavailable)
    }
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

async fn fixture_soul(root: &std::path::Path, certify_loss: bool) -> (Registry, RuntimeView) {
    fixture_fresh_soul(
        root,
        certify_loss,
        "opencode",
        "freshopencode",
        "retained-thread",
    )
    .await
}

async fn fixture_fresh_soul(
    root: &std::path::Path,
    certify_loss: bool,
    provider: &str,
    session_type: &str,
    native_id: &str,
) -> (Registry, RuntimeView) {
    let registry = Registry::open(root, None).unwrap();
    let soul_id = SoulId::new();
    let fresh_agent: FreshAgentLaunchSpec = serde_json::from_value(json!({
        "sessionId": "fresh-retained-thread", "provider": provider, "sessionType": session_type,
        "runtimeVariant": provider, "providerStoreId": "store-test", "cwd": "/workspace",
        "workspacePath": "/workspace", "runAsUid": 1000, "runAsGid": 1000,
        "nativeSessionId": native_id
    }))
    .unwrap();
    let prepared = registry
        .prepare_launch(LaunchPreparation {
            soul_id: soul_id.clone(),
            provider: provider.into(),
            provider_store_id: "store-test".into(),
            native_session_id: Some(native_id.into()),
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
    if !certify_loss {
        let view = registry.inventory().await.unwrap().pop().unwrap();
        assert_eq!(view.desired_state, DesiredState::Running);
        return (registry, view);
    }
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

async fn start_control(
    root: &std::path::Path,
    registry: Registry,
    backend: Arc<StopBackend>,
) -> (PathBuf, tokio::task::JoinHandle<()>) {
    let socket = root.join("control.sock");
    let supervisor = Supervisor::new(
        registry.clone(),
        backend.clone(),
        SupervisorConfig {
            runtime_root: root.into(),
            control_socket_path: socket.clone(),
            host_binary_path: std::env::current_exe().unwrap(),
            image_ref: format!("sha256:{}", "b".repeat(64)),
            test_run_id: "stop-lost-fixture".into(),
            control_secret: "test-control-secret".into(),
            lifecycle_log: root.join("lifecycle.jsonl"),
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
    (socket, control)
}

#[tokio::test]
async fn restored_web_stops_persisted_lost_soul_only_after_verified_cleanup() {
    let temp = tempfile::tempdir().unwrap();
    let (registry, before) = fixture_soul(temp.path(), true).await;
    let backend = Arc::new(StopBackend::default());
    backend.uncertain.store(true, Ordering::SeqCst);
    let (socket, control) = start_control(temp.path(), registry.clone(), backend.clone()).await;

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

#[tokio::test]
async fn running_soul_uncertain_stop_returns_the_revision_for_immediate_retry() {
    let temp = tempfile::tempdir().unwrap();
    let (registry, before) = fixture_soul(temp.path(), false).await;
    let backend = Arc::new(StopBackend::default());
    backend.uncertain.store(true, Ordering::SeqCst);
    let (socket, control) = start_control(temp.path(), registry.clone(), backend.clone()).await;
    let router = web_router(&socket, temp.path()).await;

    let (status, uncertain) = stop(&router, &before, before.intent_revision).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(uncertain["outcome"], "termination_unconfirmed");
    assert_eq!(uncertain["soul"]["desiredState"], "stopped");
    let returned_revision = uncertain["soul"]["intentRevision"].as_u64().unwrap();
    assert_eq!(returned_revision, before.intent_revision + 1);
    assert_eq!(uncertain["soul"]["soulId"], before.soul_id.as_str());
    assert_eq!(uncertain["soul"]["nativeSessionId"], "retained-thread");

    let (status, _) = stop(&router, &before, before.intent_revision).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(backend.stopped.lock().unwrap().len(), 1);

    backend.uncertain.store(false, Ordering::SeqCst);
    let (status, verified) = stop(&router, &before, returned_revision).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(verified["outcome"], "verified_empty");
    assert_eq!(verified["soul"]["intentRevision"], returned_revision);
    assert_eq!(verified["soul"]["nativeSessionId"], "retained-thread");
    assert_eq!(
        *backend.stopped.lock().unwrap(),
        vec![(before.soul_id, before.incarnation_id); 2]
    );
    control.abort();
    let _ = control.await;
}

#[tokio::test]
async fn restored_web_reads_exact_persisted_lost_native_history_without_starting_runtime() {
    let temp = tempfile::tempdir().unwrap();
    let (registry, before) = fixture_soul(temp.path(), true).await;
    let home = temp.path().join("owned-provider-store");
    let directory = home.join(".local/share/opencode");
    std::fs::create_dir_all(&directory).unwrap();
    let connection = rusqlite::Connection::open(directory.join("opencode.db")).unwrap();
    connection.execute_batch("CREATE TABLE session (id TEXT PRIMARY KEY,title TEXT,time_updated INTEGER,revert TEXT);
      CREATE TABLE message (id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT);
      INSERT INTO session VALUES ('retained-thread','Durable name',2,NULL);
      INSERT INTO session VALUES ('foreign-thread','Foreign',2,NULL);").unwrap();
    let saved_text = "Actual saved managed answer\n".repeat(50_000);
    assert!(saved_text.len() > freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES);
    for (id, text) in [
        ("retained-thread", saved_text.as_str()),
        ("foreign-thread", "Foreign history"),
    ] {
        connection
            .execute(
                "INSERT INTO message VALUES (?1,?2,1,?3)",
                rusqlite::params![
                    format!("{id}-message"),
                    id,
                    json!({"role":"assistant","time":{"created":1,"completed":2}}).to_string()
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO part VALUES (?1,?2,?3,1,?4)",
                rusqlite::params![
                    format!("{id}-part"),
                    id,
                    format!("{id}-message"),
                    json!({"type":"text","text":text}).to_string()
                ],
            )
            .unwrap();
    }
    drop(connection);
    let backend = Arc::new(StopBackend {
        history_home: Some(home),
        ..Default::default()
    });
    let (socket, control) = start_control(temp.path(), registry.clone(), backend.clone()).await;
    // Reconstruct the web API: no provider actor, running-soul lookup or alias cache.
    drop(web_router(&socket, temp.path()).await);
    let router = web_router(&socket, temp.path()).await;
    let response = router
        .oneshot(
            Request::builder()
                .uri(format!("/api/runtime/souls/{}/history", before.soul_id))
                .header("x-auth-token", "web-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: serde_json::Value =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(body["threadId"], "retained-thread");
    assert_eq!(body["turns"][0]["items"][0]["text"], saved_text);
    assert_eq!(body["capabilities"]["send"], false);
    assert_eq!(registry.inventory().await.unwrap().pop().unwrap(), before);
    assert!(backend.stopped.lock().unwrap().is_empty());
    control.abort();
    let _ = control.await;
}

#[tokio::test]
async fn unavailable_runtime_and_invalid_mutation_keep_their_http_error_contracts() {
    let root = tempfile::tempdir().unwrap();
    let (tx, _) = tokio::sync::broadcast::channel(16);
    let router = router(
        ManagedRuntimeApiState::new(
            Arc::new("web-token".into()),
            None,
            None,
            Arc::new(PaneLedger::new(Some(root.path().join("ledger")))),
            Arc::new(tx),
        )
        .await
        .unwrap(),
    );
    for (method, uri, body, status, error) in [
        (
            "GET",
            "/api/runtime/souls/retained-soul/history",
            None,
            StatusCode::SERVICE_UNAVAILABLE,
            "Managed runtime unavailable",
        ),
        (
            "POST",
            "/api/runtime/souls/retained-soul/stop",
            Some(json!({"expectedIntentRevision":1})),
            StatusCode::BAD_REQUEST,
            "requestId is required",
        ),
        (
            "POST",
            "/api/runtime/souls/retained-soul/stop",
            Some(json!({"requestId":" ","expectedIntentRevision":1})),
            StatusCode::BAD_REQUEST,
            "requestId is required",
        ),
        (
            "POST",
            "/api/runtime/souls/retained-soul/stop",
            Some(json!({"requestId":"valid-request","expectedIntentRevision":1})),
            StatusCode::SERVICE_UNAVAILABLE,
            "Managed runtime unavailable",
        ),
    ] {
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(uri)
                    .header("x-auth-token", "web-token")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        body.map(|body| body.to_string()).unwrap_or_default(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), status);
        let body: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(body, json!({"error":error}));
    }
}

#[tokio::test]
async fn restored_api_reads_managed_claude_and_kilroy_native_history_without_an_actor() {
    for (provider, session_type) in [("claude", "freshclaude"), ("kilroy", "kilroy")] {
        let temp = tempfile::tempdir().unwrap();
        let id = "44444444-4444-4444-8444-444444444444";
        let (registry, before) =
            fixture_fresh_soul(temp.path(), false, provider, session_type, id).await;
        registry
            .mark_recovery_blocked(
                before.soul_id.clone(),
                None,
                RecoveryBlockReason::StoreUnreadable,
                vec!["fixture native store temporarily unavailable".into()],
            )
            .await
            .unwrap();
        let handle = registry.begin_stop(before.soul_id.clone()).await.unwrap();
        registry
            .mark_stop_outcome(handle.incarnation_id().clone(), StopOutcome::VerifiedEmpty)
            .await
            .unwrap();
        let before = registry.inventory().await.unwrap().pop().unwrap();
        assert_eq!(before.desired_state, DesiredState::Stopped);
        let home = temp.path().join("owned-provider-store");
        let directory = home.join(".claude/projects/-workspace");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join(format!("{id}.jsonl")),
            include_str!("../../../test/fixtures/managed-native-history/claude.jsonl"),
        )
        .unwrap();
        let backend = Arc::new(StopBackend {
            history_home: Some(home),
            ..Default::default()
        });
        let (socket, control) = start_control(temp.path(), registry.clone(), backend.clone()).await;
        drop(web_router(&socket, temp.path()).await);
        let response = web_router(&socket, temp.path())
            .await
            .oneshot(
                Request::builder()
                    .uri(format!("/api/runtime/souls/{}/history", before.soul_id))
                    .header("x-auth-token", "web-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(body["threadId"], id);
        assert_eq!(body["sessionType"], session_type);
        assert_eq!(body["provider"], "claude");
        assert!(body["turns"]
            .to_string()
            .contains("Saved native Claude answer"));
        assert!(body["turns"].to_string().contains("toolu_native"));
        assert_eq!(body["capabilities"]["send"], false);
        assert_eq!(registry.inventory().await.unwrap().pop().unwrap(), before);
        assert!(backend.stopped.lock().unwrap().is_empty());
        control.abort();
        let _ = control.await;
    }
}

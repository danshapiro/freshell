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
use sha2::Digest;
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
    // Observation is independent of signal errors; default handles are occupied.
    empty: AtomicBool,
    empty_after_error: AtomicBool,
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
            if self.empty_after_error.load(Ordering::SeqCst) {
                self.empty.store(true, Ordering::SeqCst);
            }
            Err(BackendError::DockerHttp {
                status: 503,
                body: "cleanup unconfirmed".into(),
            })
        } else {
            self.empty.store(true, Ordering::SeqCst);
            Ok(())
        }
    }
    async fn force_stop(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
        unreachable!()
    }
    async fn verify_empty(&self, _: &OwnedRuntimeHandle) -> Result<bool, BackendError> {
        Ok(self.empty.load(Ordering::SeqCst))
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
    fixture_fresh_soul_with_cleanup(root, certify_loss, provider, session_type, native_id, false)
        .await
}

pub(super) async fn fixture_fresh_soul_with_cleanup(
    root: &std::path::Path,
    certify_loss: bool,
    provider: &str,
    session_type: &str,
    native_id: &str,
    verified_empty: bool,
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
                launch_policy: None,
            },
        )
        .await
        .unwrap();
    let grant = registry
        .commit_execution_grant(prepared.incarnation_id.clone(), HostBootId::new(), limits())
        .await
        .unwrap();
    let context = registry.recovery_context(soul_id.clone()).await.unwrap();
    let launch = registry
        .bind_native_identity_launch(NativeIdentityLaunch {
            incarnation_id: prepared.incarnation_id.clone(),
            launch_nonce: context.prior_handle.launch_nonce().as_str().into(),
            evidence_revision: context.evidence_revision,
            execution_generation: grant.execution_generation,
            requested_native_session_id: context.native_session_id.clone(),
        })
        .await
        .unwrap();
    let context = registry.recovery_context(soul_id.clone()).await.unwrap();
    // Controlled setup for the retained-runtime backend fixture, not native
    // qualification: exercise the production current-launch publication gate.
    registry
        .record_native_identity_observation(
            soul_id.clone(),
            NativeIdentityObservation {
                native_session_id: native_id.into(),
                incarnation_id: launch.incarnation_id,
                launch_nonce: launch.launch_nonce,
                evidence_revision: launch.evidence_revision,
                source: NativeIdentitySource::FreshProviderHandshake,
                evidence_digest: "a".repeat(64),
            },
            context.write_fence(),
        )
        .await
        .unwrap();
    registry
        .mark_running(prepared.incarnation_id)
        .await
        .unwrap();
    // The backend fixture represents a previously observed durable native
    // store; process launch alone deliberately no longer certifies it.
    rusqlite::Connection::open(root.join("runtime.sqlite3"))
        .unwrap()
        .execute(
            "UPDATE souls SET allocation_state='verified_durable' WHERE soul_id=?1",
            [soul_id.as_str()],
        )
        .unwrap();
    if !certify_loss {
        let view = registry
            .inventory()
            .await
            .unwrap()
            .into_iter()
            .find(|view| view.soul_id == soul_id)
            .unwrap();
        assert_eq!(view.desired_state, DesiredState::Running);
        return (registry, view);
    }
    let context = registry.recovery_context(soul_id.clone()).await.unwrap();
    let provider_home = root
        .join("qualified-empty-provider-store")
        .join(soul_id.as_str());
    std::fs::create_dir_all(&provider_home).unwrap();
    let mut spec = freshell_supervisor::resume_catalog::exact_resume_candidate(&context, None)
        .unwrap()
        .unwrap();
    // This injected reader owns one exact synthetic database. Recording its
    // selector makes a missing DB authoritative; an unrecorded default could
    // belong to a different native channel and must remain inconclusive.
    if provider == "opencode" {
        spec.environment.insert(
            "OPENCODE_DB".into(),
            provider_home
                .join(".local/share/opencode/opencode.db")
                .to_string_lossy()
                .into_owned(),
        );
        spec = registry
            .store_verified_resume_spec(soul_id.clone(), spec)
            .await
            .unwrap();
    }
    let context = registry.recovery_context(soul_id.clone()).await.unwrap();
    let freshell_agent_runtime::ProviderStoreProbe::DefinitivelyUnavailable {
        reason: native_reason,
        evidence: native_evidence,
        store_state: native_store_state,
        negative_paths: _,
    } = freshell_agent_runtime::probe_provider_store(&provider_home, &spec)
    else {
        panic!("loss fixture requires an actual complete native reader negative");
    };
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
            RecoveryPath::NativeImport,
            EvidenceStoreState::NotApplicable,
            "no_native_import_configured",
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
        store_state: if path == RecoveryPath::NativeResume {
            native_store_state
        } else {
            store_state
        },
        verdict: RecoveryEvidenceVerdict::DefinitiveNegative,
        reason_code: if path == RecoveryPath::NativeResume {
            native_reason.clone()
        } else {
            reason.into()
        },
        evidence_refs: if path == RecoveryPath::NativeResume {
            native_evidence.clone()
        } else {
            vec![format!("fixture://{reason}")]
        },
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
            if verified_empty {
                StopOutcome::VerifiedEmpty
            } else {
                StopOutcome::TerminationUnconfirmed
            },
            LossCleanupReport {
                owned_handle_ref: loss.certificate.cleanup_target.owned_handle_ref,
                ownership_verified: true,
                graceful_attempt: "failed".into(),
                forced_attempt: "not_attempted".into(),
                verified_empty,
                verified_at: None,
                foreign_objects_touched: 0,
            },
        )
        .await
        .unwrap();
    let view = registry
        .inventory()
        .await
        .unwrap()
        .into_iter()
        .find(|view| view.soul_id == soul_id)
        .unwrap();
    assert_eq!(view.desired_state, DesiredState::Stopped);
    assert_eq!(view.recovery_state, RecoveryState::Lost);
    assert_eq!(
        view.cleanup_state,
        if verified_empty {
            CleanupState::VerifiedEmpty
        } else {
            CleanupState::TerminationUnconfirmed
        }
    );
    (registry, view)
}

pub(super) async fn web_router(socket: &std::path::Path, root: &std::path::Path) -> Router {
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

pub(super) async fn start_control(
    root: &std::path::Path,
    registry: Registry,
    backend: Arc<dyn RuntimeBackend>,
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

async fn set_view_visibility(
    router: &Router,
    view: &ViewIntent,
    visibility: ViewVisibilityIntent,
) -> (StatusCode, serde_json::Value) {
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!("/api/runtime/views/{}", view.view_id))
                .header("x-auth-token", "web-token")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "requestId": RequestId::new(), "visibility": visibility,
                        "expectedRevision": view.revision,
                        "expectedSoulIntentRevision": view.soul_intent_revision,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

async fn automatic_view(registry: &Registry, soul: &RuntimeView) -> ViewIntent {
    registry
        .upsert_view_intent(UpsertViewIntentRequest {
            soul_id: soul.soul_id.clone(),
            view_id: None,
            intent: ViewIntentRequest::default(),
            expected_revision: None,
            expected_soul_intent_revision: soul.intent_revision,
            expected_control_epoch: None,
        })
        .await
        .unwrap()
}

#[tokio::test]
async fn stop_backend_observes_occupied_failure_then_successful_cleanup() {
    let temp = tempfile::Builder::new()
        .prefix("task007-server-stop-fixture-")
        .tempdir()
        .unwrap();
    let (registry, before) = fixture_soul(temp.path(), false).await;
    let handle = registry
        .recovery_context(before.soul_id.clone())
        .await
        .unwrap()
        .prior_handle;
    let backend = StopBackend::default();
    assert!(!backend.verify_empty(&handle).await.unwrap());

    backend.uncertain.store(true, Ordering::SeqCst);
    assert!(matches!(
        backend.request_stop(&handle, 2).await,
        Err(BackendError::DockerHttp { status: 503, .. })
    ));
    assert!(!backend.verify_empty(&handle).await.unwrap());

    backend.uncertain.store(false, Ordering::SeqCst);
    backend.request_stop(&handle, 2).await.unwrap();
    assert!(backend.verify_empty(&handle).await.unwrap());
    assert_eq!(
        *backend.stopped.lock().unwrap(),
        vec![(before.soul_id.clone(), before.incarnation_id.clone()); 2]
    );

    let concurrent_cleanup = StopBackend::default();
    concurrent_cleanup.uncertain.store(true, Ordering::SeqCst);
    concurrent_cleanup
        .empty_after_error
        .store(true, Ordering::SeqCst);
    assert!(!concurrent_cleanup.verify_empty(&handle).await.unwrap());
    assert!(matches!(
        concurrent_cleanup.request_stop(&handle, 2).await,
        Err(BackendError::DockerHttp { status: 503, .. })
    ));
    assert!(concurrent_cleanup.verify_empty(&handle).await.unwrap());
    assert_eq!(
        *concurrent_cleanup.stopped.lock().unwrap(),
        vec![(before.soul_id, before.incarnation_id)]
    );
}

#[tokio::test]
async fn stop_error_with_observed_empty_releases_the_exact_owned_writer() {
    for certify_loss in [false, true] {
        let backend = Arc::new(StopBackend::default());
        backend.uncertain.store(true, Ordering::SeqCst);
        backend.empty_after_error.store(true, Ordering::SeqCst);
        assert_verified_empty_stop(backend, certify_loss, 1).await;
    }
}

#[tokio::test]
async fn already_empty_stop_releases_the_owned_writer_without_a_signal() {
    let backend = Arc::new(StopBackend::default());
    backend.empty.store(true, Ordering::SeqCst);
    // Even a failing signal must remain unattempted when emptiness is observed first.
    backend.uncertain.store(true, Ordering::SeqCst);
    assert_verified_empty_stop(backend, false, 0).await;
}

async fn assert_verified_empty_stop(
    backend: Arc<StopBackend>,
    certify_loss: bool,
    expected_stop_attempts: usize,
) {
    let temp = tempfile::Builder::new()
        .prefix("task007-server-stop-fixture-")
        .tempdir()
        .unwrap();
    let (registry, before) = fixture_soul(temp.path(), certify_loss).await;
    let connection = rusqlite::Connection::open(temp.path().join("runtime.sqlite3")).unwrap();
    let writer_count = || {
        connection
            .query_row(
                "SELECT count(*) FROM writer_claims WHERE soul_id=?1 AND incarnation_id=?2",
                rusqlite::params![before.soul_id.as_str(), before.incarnation_id.as_str()],
                |row| row.get::<_, u64>(0),
            )
            .unwrap()
    };
    assert_eq!(writer_count(), 1);
    let certificate = if let Some(incident) = before.incident_id.clone() {
        Some(serde_json::to_value(registry.loss_certificate(incident).await.unwrap()).unwrap())
    } else {
        None
    };
    let handle = registry
        .recovery_context(before.soul_id.clone())
        .await
        .unwrap()
        .prior_handle;
    assert_eq!(
        backend.verify_empty(&handle).await.unwrap(),
        expected_stop_attempts == 0
    );
    let (socket, control) = start_control(temp.path(), registry.clone(), backend.clone()).await;
    let web = web_router(&socket, temp.path()).await;
    let (status, stopped) = stop(&web, &before, before.intent_revision).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(stopped["outcome"], "verified_empty");
    assert_eq!(stopped["soul"]["cleanupState"], "verified_empty");
    assert_eq!(stopped["soul"]["desiredState"], "stopped");
    assert_eq!(
        stopped["soul"]["recoveryState"],
        if certify_loss { "lost" } else { "stopped" }
    );
    assert_eq!(stopped["soul"]["soulId"], before.soul_id.as_str());
    assert_eq!(
        stopped["soul"]["incarnationId"],
        before.incarnation_id.as_str()
    );
    assert_eq!(stopped["soul"]["nativeSessionId"], "retained-thread");
    assert_eq!(
        stopped["soul"]["freshAgentSessionId"],
        "fresh-retained-thread"
    );
    assert_eq!(
        stopped["soul"]["intentRevision"],
        before.intent_revision + 1
    );
    assert_eq!(writer_count(), 0);
    assert!(backend.verify_empty(&handle).await.unwrap());
    assert_eq!(
        *backend.stopped.lock().unwrap(),
        vec![(before.soul_id.clone(), before.incarnation_id.clone()); expected_stop_attempts]
    );
    if let Some(incident) = before.incident_id.clone() {
        assert_eq!(
            Some(serde_json::to_value(registry.loss_certificate(incident).await.unwrap()).unwrap()),
            certificate
        );
    }
    control.abort();
    assert!(control.await.unwrap_err().is_cancelled());
    let owned_root = temp.path().to_path_buf();
    drop(web);
    drop(connection);
    drop(registry);
    drop(temp);
    assert!(!socket.exists());
    assert!(!owned_root.exists());
}

#[tokio::test]
async fn stopped_hidden_view_satisfies_stale_detach_without_mutating_new_authority() {
    let temp = tempfile::tempdir().unwrap();
    let (registry, before) = fixture_soul(temp.path(), false).await;
    let frozen = automatic_view(&registry, &before).await;
    let backend = Arc::new(StopBackend::default());
    let (socket, control) = start_control(temp.path(), registry.clone(), backend.clone()).await;
    let web = web_router(&socket, temp.path()).await;
    let (status, stopped) = stop(&web, &before, before.intent_revision).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(stopped["outcome"], "verified_empty");
    assert_eq!(
        *backend.stopped.lock().unwrap(),
        vec![(before.soul_id.clone(), before.incarnation_id.clone())]
    );
    let hidden = registry.inventory_snapshot().await.unwrap().view_intents[0].clone();
    assert_eq!(hidden.visibility, ViewVisibilityIntent::Hidden);
    assert!(hidden.revision > frozen.revision);
    assert!(hidden.soul_intent_revision > frozen.soul_intent_revision);

    // Ordinary pane close and tab Shift-close still carry the pre-kill
    // projection until the inventory broadcast reaches that browser.
    for _ in 0..2 {
        let (status, body) =
            set_view_visibility(&web, &frozen, ViewVisibilityIntent::Detached).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(serde_json::from_value::<ViewIntent>(body).unwrap(), hidden);
        assert_eq!(
            registry.inventory_snapshot().await.unwrap().view_intents[0],
            hidden
        );
    }
    let mut future = hidden.clone();
    future.revision += 1;
    let (status, _) = set_view_visibility(&web, &future, ViewVisibilityIntent::Detached).await;
    assert_eq!(status, StatusCode::CONFLICT);
    future.revision = hidden.revision;
    future.soul_intent_revision += 1;
    let (status, _) = set_view_visibility(&web, &future, ViewVisibilityIntent::Detached).await;
    assert_eq!(status, StatusCode::CONFLICT);
    // A stale visible write still cannot reopen a stopped view.
    let (status, _) = set_view_visibility(&web, &frozen, ViewVisibilityIntent::Visible).await;
    assert_eq!(status, StatusCode::CONFLICT);
    // A newer explicit visible view is authority even while stopped.
    let (status, _) = set_view_visibility(&web, &hidden, ViewVisibilityIntent::Visible).await;
    assert_eq!(status, StatusCode::OK);
    let visible = registry.inventory_snapshot().await.unwrap().view_intents[0].clone();
    let (status, _) = set_view_visibility(&web, &frozen, ViewVisibilityIntent::Detached).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        registry.inventory_snapshot().await.unwrap().view_intents[0],
        visible
    );
    control.abort();
    let _ = control.await;
}

#[tokio::test]
async fn stale_detach_cannot_close_running_or_cleanup_unconfirmed_views() {
    let temp = tempfile::tempdir().unwrap();
    let (registry, before) = fixture_soul(temp.path(), false).await;
    let frozen = automatic_view(&registry, &before).await;
    let backend = Arc::new(StopBackend::default());
    let (socket, control) = start_control(temp.path(), registry.clone(), backend.clone()).await;
    let web = web_router(&socket, temp.path()).await;
    let (status, _) = set_view_visibility(&web, &frozen, ViewVisibilityIntent::Visible).await;
    assert_eq!(status, StatusCode::OK);
    let newer = registry.inventory_snapshot().await.unwrap().view_intents[0].clone();
    let (status, _) = set_view_visibility(&web, &frozen, ViewVisibilityIntent::Detached).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        registry.inventory_snapshot().await.unwrap().view_intents[0],
        newer
    );
    backend.uncertain.store(true, Ordering::SeqCst);
    let (status, stopped) = stop(&web, &before, before.intent_revision).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(stopped["outcome"], "termination_unconfirmed");
    let hidden = registry.inventory_snapshot().await.unwrap().view_intents[0].clone();
    assert_eq!(hidden.visibility, ViewVisibilityIntent::Hidden);
    let (status, _) = set_view_visibility(&web, &frozen, ViewVisibilityIntent::Detached).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        registry.inventory_snapshot().await.unwrap().view_intents[0],
        hidden
    );
    control.abort();
    let _ = control.await;
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
    let returned_revision = uncertain["soul"]["intentRevision"].as_u64().unwrap();
    assert_eq!(returned_revision, before.intent_revision + 1);
    let (status, verified) = stop(&restored, &before, returned_revision).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(verified["outcome"], "verified_empty");
    assert_eq!(verified["soul"]["cleanupState"], "verified_empty");
    assert_eq!(verified["soul"]["recoveryState"], "lost");
    assert_eq!(verified["soul"]["nativeSessionId"], "retained-thread");
    assert_eq!(verified["soul"]["intentRevision"], returned_revision + 1);
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
    assert_eq!(verified["soul"]["intentRevision"], returned_revision + 1);
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
    connection.execute_batch("CREATE TABLE session (id TEXT PRIMARY KEY,title TEXT,time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT);
      INSERT INTO session VALUES ('retained-thread','Durable name',2);
      INSERT INTO session VALUES ('foreign-thread','Foreign',2);").unwrap();
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
async fn restored_web_reads_large_retained_codex_history_without_source_or_registry_writes() {
    use std::io::Write;
    let temp = tempfile::tempdir().unwrap();
    let (registry, before) = fixture_fresh_soul(
        temp.path(),
        false,
        "codex",
        "freshcodex",
        "large-native-thread",
    )
    .await;
    let fence = registry
        .recovery_write_fence(before.soul_id.clone())
        .await
        .unwrap();
    registry
        .mark_recovery_blocked(
            before.soul_id.clone(),
            None,
            RecoveryBlockReason::ProviderUnavailable,
            vec!["fixture://provider-unavailable".into()],
            fence,
        )
        .await
        .unwrap();
    let before = registry.inventory().await.unwrap().pop().unwrap();
    let home = temp.path().join("owned-provider-store");
    let directory = home.join(".codex/sessions/2026/10/03");
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("rollout-large-native-thread.jsonl");
    let mut file = std::fs::File::create(&path).unwrap();
    writeln!(
        file,
        "{}",
        json!({"type":"session_meta","payload":{"id":"large-native-thread"}})
    )
    .unwrap();
    let answer = "Actual saved answer\n".repeat(8000);
    for index in 0..140 {
        for row in [
            json!({"type":"turn_context","payload":{"turn_id":format!("turn-{index}")}}),
            json!({"type":"event_msg","payload":{"type":"user_message","message":"Repeated actual prompt"}}),
            json!({"type":"event_msg","payload":{"type":"task_complete","last_agent_message":answer}}),
        ] {
            writeln!(file, "{row}").unwrap();
        }
    }
    let recent_parts = |kind: &str, tail: &str| {
        let mut parts: Vec<serde_json::Value> = (0..24).map(|index| json!({"type":kind,"text":format!("Earlier array part {index} {}", "saved ".repeat(32_000))})).collect();
        parts.push(json!({"type":kind,"text":tail}));
        parts
    };
    for row in [
        json!({"type":"turn_context","payload":{"turn_id":"latest-turn"}}),
        json!({"type":"response_item","payload":{"type":"message","id":"latest-prompt","role":"user","content":[{"type":"input_text","text":"Latest actual saved prompt"}]}}),
        json!({"type":"response_item","payload":{"type":"function_call","call_id":"latest-tool","name":"exec_command","arguments":"{\"cmd\":\"pwd\"}"}}),
        json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"latest-tool","output":recent_parts("input_text", "/actual-workspace")}}),
        json!({"type":"response_item","payload":{"type":"message","id":"latest-answer","role":"assistant","content":recent_parts("output_text", "Latest actual saved answer FRESHELL_NATIVE_HISTORY_OMITTED_SHA256:body")}}),
    ] {
        writeln!(file, "{row}").unwrap();
    }
    drop(file);
    let source_before = std::fs::read(&path).unwrap();
    assert!(source_before.len() as u64 > freshell_freshagent::native_history::MAX_HISTORY_BYTES);
    let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
    let backend = Arc::new(StopBackend {
        history_home: Some(home),
        ..Default::default()
    });
    let (socket, control) = start_control(temp.path(), registry.clone(), backend.clone()).await;
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
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert!((bytes.len() as u64) < freshell_freshagent::native_history::MAX_HISTORY_BYTES);
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["threadId"], "large-native-thread");
    assert_eq!(
        body["extensions"]["codex"]["nativeHistoryRetention"]["partial"],
        true
    );
    assert_eq!(body["capabilities"]["send"], false);
    let text = body["turns"].to_string();
    assert!(text.contains("Latest actual saved prompt"));
    assert!(text.contains("Latest actual saved answer FRESHELL_NATIVE_HISTORY_OMITTED_SHA256:body"));
    assert!(text.contains("latest-tool"));
    assert!(text.contains("/actual-workspace"));
    assert_eq!(std::fs::read(&path).unwrap(), source_before);
    assert_eq!(
        std::fs::metadata(&path).unwrap().modified().unwrap(),
        modified
    );
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
        let fence = registry
            .recovery_write_fence(before.soul_id.clone())
            .await
            .unwrap();
        registry
            .mark_recovery_blocked(
                before.soul_id.clone(),
                None,
                RecoveryBlockReason::StoreUnreadable,
                vec!["fixture native store temporarily unavailable".into()],
                fence,
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

#[tokio::test]
async fn restore_lost_souls_route_requires_auth_and_runtime_connection() {
    let temp = tempfile::tempdir().unwrap();
    let (tx, _) = tokio::sync::broadcast::channel(16);
    let state = ManagedRuntimeApiState::new(
        Arc::new("web-token".into()),
        None,
        Some(temp.path().join("projections.json")),
        Arc::new(PaneLedger::new(Some(temp.path().join("ledger")))),
        Arc::new(tx),
    )
    .await
    .unwrap();
    let app = router(state);
    let targets = (0..9)
        .map(|_| {
            json!({
                "soulId": SoulId::new(),
                "incidentId": IncidentId::new(),
                "expectedIntentRevision": 1
            })
        })
        .collect::<Vec<_>>();
    let body = json!({
        "idempotencyKey": RequestId::new(),
        "scopeId": "a".repeat(64),
        "source": {"sourceStoreId": "b".repeat(64), "rootSessionIds": ["ses_fixture_root_alpha"]},
        "targets": targets
    })
    .to_string();

    let unauthorized = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/runtime/soul-loss-repairs")
                .header("content-type", "application/json")
                .body(Body::from(body.clone()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    let unavailable = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/runtime/soul-loss-repairs")
                .header("x-auth-token", "web-token")
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unavailable.status(), StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn durable_souls_routes_refuse_actual_stale_preview_and_unknown_members_without_writes() {
    let temp = tempfile::tempdir().unwrap();
    let registry = Registry::open(temp.path(), None).unwrap();
    let (socket, control) = start_control(
        temp.path(),
        registry.clone(),
        Arc::new(StopBackend::default()),
    )
    .await;
    let app = web_router(&socket, temp.path()).await;
    for (route, body) in [
        (
            "/api/runtime/soul-loss-repairs/preflight",
            json!({"sourceStoreId":"a".repeat(64),"rootSessionIds":["ses_fixture_root"],"expectedControlEpoch":registry.control_epoch()+1}),
        ),
        (
            "/api/runtime/soul-loss-repairs",
            json!({"idempotencyKey":RequestId::new(),"scopeId":"b".repeat(64),"source":{"sourceStoreId":"a".repeat(64),"rootSessionIds":["ses_fixture_root"]},"targets":[{"soulId":SoulId::new(),"incidentId":IncidentId::new(),"expectedIntentRevision":2}]}),
        ),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(route)
                    .header("x-auth-token", "web-token")
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(!response.status().is_success());
        assert_ne!(
            response.status(),
            StatusCode::UNPROCESSABLE_ENTITY,
            "valid wire requests reach real supervisor validation"
        );
    }
    assert!(registry.inventory().await.unwrap().is_empty());
    let connection = rusqlite::Connection::open(temp.path().join("runtime.sqlite3")).unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT count(*) FROM stopped_repair_operations",
                [],
                |row| row.get::<_, u64>(0)
            )
            .unwrap(),
        0
    );
    control.abort();
    let _ = control.await;
}

// Keep production source discovery in a child with an empty environment so
// neither parallel tests nor any real provider store can influence admission.
#[tokio::test]
async fn durable_souls_routes_refuse_substituted_member_and_stale_existing_target() {
    const CHILD: &str = "FRESHELL_TEST_SCOPED_REPAIR_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let home = tempfile::tempdir().unwrap();
        let mut child = tokio::process::Command::new(std::env::current_exe().unwrap());
        child
            .args([
                "managed_runtime_api::stop_contract_tests::durable_souls_routes_refuse_substituted_member_and_stale_existing_target",
                "--exact",
                "--nocapture",
            ])
            .env_clear()
            .env(CHILD, "1")
            .env("HOME", home.path())
            .env("XDG_DATA_HOME", home.path().join("data"))
            .kill_on_drop(true);
        let output = tokio::time::timeout(std::time::Duration::from_secs(60), child.output())
            .await
            .expect("isolated scoped-route fixture completes within one minute")
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(output.status.success(), "{stdout}\n{stderr}");
        assert!(
            stdout.contains("1 passed"),
            "the child must execute the route case: {stdout}"
        );
        return;
    }

    let temp = tempfile::tempdir().unwrap();
    let data_home = freshell_sessions::parse::default_opencode_data_home();
    std::fs::create_dir_all(&data_home).unwrap();
    let source_path = data_home.join("opencode.db");
    let roots = (0..7)
        .map(|index| format!("ses_route_root_{index}"))
        .collect::<Vec<_>>();
    scoped_repair_source(&source_path, temp.path(), &roots);
    let source_before = std::fs::read(&source_path).unwrap();
    let source = RepairBatchSourceSelection {
        source_store_id: format!(
            "{:x}",
            sha2::Sha256::digest(
                source_path
                    .canonicalize()
                    .unwrap()
                    .to_string_lossy()
                    .as_bytes()
            )
        ),
        root_session_ids: roots.clone(),
    };
    let registry_root = temp.path().join("registry");
    for index in 0..9 {
        fixture_fresh_soul_with_cleanup(
            &registry_root,
            true,
            "opencode",
            "freshopencode",
            &roots[index % 7],
            true,
        )
        .await;
    }
    let registry = Registry::open(&registry_root, None).unwrap();
    let connection = rusqlite::Connection::open(registry_root.join("runtime.sqlite3")).unwrap();
    // Represent migrated, unbound legacy false-loss metadata. This records no
    // source absence or import proof; the real preflight must inspect SQLite.
    connection.execute_batch(
        "UPDATE souls SET native_import_state='legacy_unknown',native_import_authority='legacy_unknown';
         UPDATE loss_incidents SET captured_native_import_state='legacy_unknown',captured_native_import_authority='legacy_unknown';",
    ).unwrap();
    let terminal = json!({"terminalId":"terminal-scoped-route","streamId":"stream-scoped-route","mode":"opencode","program":"opencode","env":{},"runAsUid":65534,"runAsGid":0,"cols":80,"rows":24,"projectKey":"workspace","workspacePath":temp.path(),"cwd":temp.path()});
    connection
        .execute(
            "UPDATE incarnations SET terminal_spec=?1,fresh_agent_spec=NULL",
            [terminal.to_string()],
        )
        .unwrap();
    let backend = Arc::new(StopBackend::default());
    let (socket, control) = start_control(&registry_root, registry.clone(), backend.clone()).await;
    let app = web_router(&socket, &registry_root).await;
    let before = scoped_repair_registry_state(&connection);
    let inventory_before = registry.inventory().await.unwrap();
    assert_eq!(inventory_before.len(), 9);
    assert!(inventory_before
        .iter()
        .all(|view| view.desired_state == DesiredState::Stopped
            && view.recovery_state == RecoveryState::Lost
            && view.intent_revision == 2));
    let (status, body) = repair_post(
        &app,
        "/api/runtime/soul-loss-repairs/preflight",
        serde_json::to_value(&source).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let scope: RepairBatchScope = serde_json::from_value(body).unwrap();
    assert_eq!(scope.targets.len(), 9);
    assert_eq!(scope.roots.len(), 7);
    assert_eq!(
        scope
            .roots
            .iter()
            .filter(|root| root.eligible_owners.len() == 2 && root.canonical_soul_id.is_none())
            .count(),
        2
    );
    let request = RestoreLostSoulsRequest {
        scope_id: scope.scope_id.clone(),
        source,
        targets: scope
            .targets
            .iter()
            .map(|member| member.target.clone())
            .collect(),
        canonical_owners: scope
            .roots
            .iter()
            .map(|root| {
                let owner = root.eligible_owners.first().unwrap();
                CanonicalOwnerChoice {
                    root_session_id: root.root_session_id.clone(),
                    soul_id: owner.clone(),
                    expected_intent_revision: scope
                        .targets
                        .iter()
                        .find(|member| member.target.soul_id == *owner)
                        .unwrap()
                        .target
                        .expected_intent_revision,
                }
            })
            .collect(),
        expected_control_epoch: None,
    };
    // Validity comes from the independently resolved production scope, not a
    // caller-built descriptor. No import or conversation is started here.
    request.validate_exact_batch(&scope).unwrap();
    assert_eq!(scoped_repair_registry_state(&connection), before);

    let mut substituted = request.clone();
    substituted.targets[0].incident_id = IncidentId::new();
    let mut stale = request.clone();
    stale.targets[0].expected_intent_revision = 1;
    for (invalid, expected_status, expected_error) in [
        (substituted, StatusCode::BAD_REQUEST, "runtime supervisor rejected request: InvalidRequest: stopped restoration differs from the independently resolved exact scope"),
        (stale, StatusCode::CONFLICT, "runtime supervisor rejected request: StaleIntentRevision: stale soul intent revision: expected 1, current 2"),
    ] {
        invalid.validate_payload().unwrap();
        let mut body = serde_json::to_value(&invalid).unwrap();
        body.as_object_mut().unwrap().remove("expectedControlEpoch");
        body["idempotencyKey"] = json!(RequestId::new());
        let (status, reply) = repair_post(&app, "/api/runtime/soul-loss-repairs", body).await;
        assert_eq!(status, expected_status, "{reply}");
        assert_eq!(reply, json!({"error": expected_error}));
        assert_eq!(scoped_repair_registry_state(&connection), before);
        assert_eq!(registry.inventory().await.unwrap(), inventory_before);
        assert_eq!(std::fs::read(&source_path).unwrap(), source_before);
        assert!(backend.stopped.lock().unwrap().is_empty());
    }
    control.abort();
    let _ = control.await;
}

async fn repair_post(
    app: &Router,
    route: &str,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(route)
                .header("x-auth-token", "web-token")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap())
}

fn scoped_repair_registry_state(
    connection: &rusqlite::Connection,
) -> Vec<Vec<Vec<rusqlite::types::Value>>> {
    [
        "souls",
        "incarnations",
        "loss_incidents",
        "stopped_repair_operations",
        "stopped_repair_root_receipts",
        "stopped_repair_withdrawals",
        "native_origin_owners",
        "view_intents",
        "outbox",
        "runtime_notices",
        "notice_receipts",
    ]
    .into_iter()
    .map(|table| {
        let mut statement = connection
            .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
            .unwrap();
        let columns = statement.column_count();
        statement
            .query_map([], |row| (0..columns).map(|index| row.get(index)).collect())
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    })
    .collect()
}

fn scoped_repair_source(path: &std::path::Path, workspace: &std::path::Path, roots: &[String]) {
    let connection = rusqlite::Connection::open(path).unwrap();
    connection
        .execute_batch(include_str!(
            "../../freshell-sessions/src/opencode_schema_v1_18_21.sql"
        ))
        .unwrap();
    const MIGRATIONS: &[&str] = &[
        "20260127222353_familiar_lady_ursula",
        "20260211171708_add_project_commands",
        "20260213144116_wakeful_the_professor",
        "20260225215848_workspace",
        "20260227213759_add_session_workspace_id",
        "20260228203230_blue_harpoon",
        "20260303231226_add_workspace_fields",
        "20260309230000_move_org_to_state",
        "20260312043431_session_message_cursor",
        "20260323234822_events",
        "20260410174513_workspace-name",
        "20260413175956_chief_energizer",
        "20260423070820_add_icon_url_override",
        "20260427172553_slow_nightmare",
        "20260428004200_add_session_path",
        "20260501142318_next_venus",
        "20260504145000_add_sync_owner",
        "20260507164347_add_workspace_time",
        "20260510033149_session_usage",
        "20260511000411_data_migration_state",
        "20260511173437_session-metadata",
        "20260601010001_normalize_storage_paths",
        "20260601202201_amazing_prowler",
        "20260602002951_lowly_union_jack",
        "20260602182828_add_project_directories",
        "20260603001617_session_message_projection_indexes",
        "20260603040000_session_message_projection_order",
        "20260603141458_session_input_inbox",
        "20260603160727_jittery_ezekiel_stane",
        "20260604172448_event_sourced_session_input",
        "20260605003541_add_session_context_snapshot",
        "20260605042240_add_context_epoch_agent",
        "20260611035744_credential",
        "20260611192811_lush_chimera",
        "20260612174303_project_dir_strategy",
        "20260622142730_simplify_session_context_epoch",
        "20260622170816_reset_v2_session_state",
        "20260622202450_simplify_session_input",
    ];
    for (index, migration) in MIGRATIONS.iter().enumerate() {
        connection
            .execute(
                "INSERT INTO migration VALUES (?1,?2)",
                rusqlite::params![migration, index],
            )
            .unwrap();
    }
    connection.execute("INSERT INTO project(id,worktree,time_created,time_updated,sandboxes) VALUES ('route-project',?1,1,1,'[]')", [workspace.to_string_lossy().as_ref()]).unwrap();
    for root in roots {
        connection.execute("INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES (?1,'route-project',?1,?2,'route fixture','1.18.21',1,1)", rusqlite::params![root,workspace.to_string_lossy().as_ref()]).unwrap();
        connection.execute("INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES (?1,?2,1,1,?3)", rusqlite::params![format!("msg_{root}"),root,json!({"role":"user","content":"synthetic retained history"}).to_string()]).unwrap();
    }
}

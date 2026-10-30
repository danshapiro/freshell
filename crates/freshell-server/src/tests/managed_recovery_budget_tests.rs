use super::*;
use freshell_runtime_protocol::*;
use freshell_supervisor::{backend::*, registry::*, service::*};
use rusqlite::OptionalExtension;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

struct StartupBackend {
    repaired: AtomicBool,
    inspections: AtomicUsize,
}
#[async_trait::async_trait]
impl RuntimeBackend for StartupBackend {
    async fn create_stopped(&self, _: &CreateRuntimeSpec) -> Result<BackendCreated, BackendError> {
        panic!("dispatched conversation must not be replaced")
    }
    async fn start_host(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
        panic!("no replacement host")
    }
    async fn inspect(&self, _: &OwnedRuntimeHandle) -> Result<BackendInspection, BackendError> {
        self.inspections.fetch_add(1, Ordering::SeqCst);
        if !self.repaired.load(Ordering::SeqCst) {
            return Err(BackendError::Unavailable(
                "synthetic startup provider unavailable".into(),
            ));
        }
        Ok(BackendInspection {
            state: BackendRuntimeState::Running,
            configured_limits: limits(),
        })
    }
    async fn request_stop(&self, _: &OwnedRuntimeHandle, _: u64) -> Result<(), BackendError> {
        panic!("must retain dispatched data")
    }
    async fn force_stop(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
        panic!("must retain dispatched data")
    }
    async fn verify_empty(&self, _: &OwnedRuntimeHandle) -> Result<bool, BackendError> {
        Ok(false)
    }
    async fn list_known(
        &self,
        _: &[OwnedRuntimeHandle],
    ) -> Result<Vec<(IncarnationId, BackendInspection)>, BackendError> {
        Ok(vec![])
    }
    async fn read_limits(&self, _: &OwnedRuntimeHandle) -> Result<RuntimeLimits, BackendError> {
        Ok(limits())
    }
    async fn enable_long_lived(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
        Ok(())
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

async fn control(
    supervisor: Supervisor,
    path: &Path,
    seen: Arc<std::sync::Mutex<Vec<RecoveryTrigger>>>,
) -> (
    tokio::sync::oneshot::Sender<()>,
    tokio::task::JoinHandle<()>,
) {
    let listener = tokio::net::UnixListener::bind(path).unwrap();
    let (tx, mut rx) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        loop {
            let mut socket =
                tokio::select! {_=&mut rx=>break,accepted=listener.accept()=>accepted.unwrap().0};
            let envelope: Envelope<AdminCommand> = read_frame(&mut socket).await.unwrap();
            if let AdminCommand::Recover(request) = &envelope.body {
                seen.lock().unwrap().push(request.trigger);
            }
            let reply = supervisor.dispatch(envelope).await;
            write_frame(&mut socket, &reply).await.unwrap();
        }
    });
    (tx, task)
}

#[derive(Debug, PartialEq, Eq)]
struct BudgetRetry {
    intent_revision: u64,
    attempt_count: usize,
    next_due_at_ms: Option<i64>,
    reserved_attempt_id: Option<String>,
    last_reason: String,
    settled_at_ms: i64,
}

fn budget_retry(db: &Path, soul: &SoulId) -> Option<BudgetRetry> {
    rusqlite::Connection::open(db).unwrap().query_row(
        "SELECT r.intent_revision,r.attempt_count,r.next_due_at_ms,r.reserved_attempt_id,r.last_reason,s.updated_at FROM recovery_retries r JOIN souls s ON s.soul_id=r.soul_id AND s.intent_revision=r.intent_revision WHERE r.soul_id=?1",
        [soul.as_str()],
        |row| Ok(BudgetRetry {
            intent_revision: row.get(0)?,
            attempt_count: row.get(1)?,
            next_due_at_ms: row.get(2)?,
            reserved_attempt_id: row.get(3)?,
            last_reason: row.get(4)?,
            settled_at_ms: row.get(5)?,
        }),
    ).optional().unwrap()
}

struct BudgetAttempt {
    intent_revision: u64,
    verdict: String,
    started_at: i64,
    finished_at: i64,
}

fn budget_attempts(db: &Path, soul: &SoulId) -> Vec<BudgetAttempt> {
    let conn = rusqlite::Connection::open(db).unwrap();
    let mut query = conn.prepare(
        "SELECT intent_revision,verdict,started_at,finished_at FROM recovery_attempts WHERE soul_id=?1 ORDER BY rowid",
    ).unwrap();
    let rows = query
        .query_map([soul.as_str()], |row| {
            Ok(BudgetAttempt {
                intent_revision: row.get(0)?,
                verdict: row.get(1)?,
                started_at: row.get(2)?,
                finished_at: row.get(3)?,
            })
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    rows
}

async fn wait_for_budget_deadline(due: i64) {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let now = i64::try_from(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_millis(),
            )
            .unwrap();
            if now >= due {
                break;
            }
            tokio::time::sleep(Duration::from_millis((due - now) as u64 + 1)).await;
        }
    })
    .await
    .expect("persisted recovery deadline must arrive");
}

#[tokio::test]
async fn startup_recovery_naturally_exhausts_and_cold_hydration_requires_manual_retry() {
    let root = tempfile::tempdir().unwrap();
    let registry_root = root.path().join("registry");
    let registry = Registry::open(&registry_root, None).unwrap();
    let runtime = root.path().join("runtime");
    std::fs::create_dir(&runtime).unwrap();
    let binary = runtime.join("synthetic-host");
    std::fs::write(&binary, b"fixture").unwrap();
    let config = SupervisorConfig {
        runtime_root: runtime.clone(),
        control_socket_path: root.path().join("control.sock"),
        host_binary_path: binary.clone(),
        image_ref: format!("sha256:{}", "b".repeat(64)),
        test_run_id: "natural-startup-budget".into(),
        control_secret: "synthetic-control-secret".into(),
        lifecycle_log: root.path().join("lifecycle.jsonl"),
        admission: Default::default(),
    };
    let soul = SoulId::new();
    let prepared = registry
        .prepare_launch(LaunchPreparation {
            soul_id: soul.clone(),
            provider: "opencode".into(),
            provider_store_id: "exact-store".into(),
            native_session_id: None,
            creation_seed_ref: "original-seed".into(),
            request_id: RequestId::new(),
            payload_digest: "fixture".into(),
            requested_limits: limits(),
            profile: RuntimeProfile::Custom,
            project_key: "fixture".into(),
            fixture: None,
            terminal: None,
            fresh_agent: None,
            view_intent: None,
            admission: Default::default(),
        })
        .await
        .unwrap();
    registry
        .commit_created(
            prepared.incarnation_id.clone(),
            BackendCreatedRecord {
                launch_policy: None,
                daemon_id: DockerDaemonId::new(),
                container_id: "a".repeat(64),
                image_ref: config.image_ref.clone(),
                runtime_dir: runtime.clone(),
                host_binary_path: binary,
                immutable_config_digest: format!("sha256:{}", "c".repeat(64)),
            },
        )
        .await
        .unwrap();
    let grant = registry
        .commit_execution_grant(prepared.incarnation_id.clone(), HostBootId::new(), limits())
        .await
        .unwrap();
    let context = registry.recovery_context(soul.clone()).await.unwrap();
    let launch = registry
        .bind_native_identity_launch(NativeIdentityLaunch {
            incarnation_id: prepared.incarnation_id.clone(),
            launch_nonce: prepared.launch_nonce.to_string(),
            evidence_revision: context.evidence_revision,
            execution_generation: grant.execution_generation,
            requested_native_session_id: None,
        })
        .await
        .unwrap();
    let observation = NativeIdentityObservation {
        native_session_id: "ses_startup_repaired".into(),
        incarnation_id: launch.incarnation_id.clone(),
        launch_nonce: launch.launch_nonce.clone(),
        evidence_revision: launch.evidence_revision,
        source: NativeIdentitySource::OpencodeTui,
        evidence_digest: "d".repeat(64),
    };
    registry
        .record_native_session(
            soul.clone(),
            prepared.incarnation_id.clone(),
            observation.native_session_id.clone(),
        )
        .await
        .unwrap();
    let context = registry.recovery_context(soul.clone()).await.unwrap();
    registry
        .record_native_identity_observation(
            soul.clone(),
            observation.clone(),
            context.write_fence(),
        )
        .await
        .unwrap();
    registry
        .mark_running(prepared.incarnation_id.clone())
        .await
        .unwrap();
    let input = RequestId::new();
    registry
        .begin_input(soul.clone(), input.clone(), b"accepted-turn", None)
        .await
        .unwrap();
    registry
        .mark_input_dispatching(soul.clone(), input.clone())
        .await
        .unwrap();
    let output = runtime.join("retained-output");
    std::fs::write(&output, b"startup diagnostic").unwrap();
    let backend = Arc::new(StartupBackend {
        repaired: AtomicBool::new(false),
        inspections: AtomicUsize::new(0),
    });
    let supervisor = Supervisor::new(registry.clone(), backend.clone(), config.clone()).unwrap();
    let seen = Arc::new(std::sync::Mutex::new(vec![]));
    let (shutdown, task) = control(
        supervisor.clone(),
        &config.control_socket_path,
        seen.clone(),
    )
    .await;
    let client = RuntimeClient::new(&config.control_socket_path, &config.control_secret);
    let db = registry_root.join("runtime.sqlite3");
    let started = tokio::time::Instant::now();
    let initial = supervisor.reconcile_startup().await.unwrap();
    assert_eq!(initial.scanned, 1);
    assert_eq!(initial.results.len(), 1);
    assert_eq!(initial.results[0].soul_id, soul);
    assert_eq!(initial.results[0].outcome, Some(RecoveryOutcome::Blocked));
    assert!(initial.results[0].error.is_none());

    // A controller request observes the pending persisted schedule. It neither
    // sleeps through that schedule nor owns a second retry loop.
    let pending = client
        .recover(soul.clone(), RecoveryTrigger::ProviderExit)
        .await
        .unwrap();
    assert_eq!(pending.outcome, RecoveryOutcome::Blocked);
    assert!(matches!(
        pending.probe,
        Some(RecoveryProbe::Blocked { retry_hint, .. })
            if retry_hint.automatic_after_ms.is_some()
    ));
    supervisor.observe_once().await.unwrap();
    assert_eq!(budget_attempts(&db, &soul).len(), 1);

    let mut prior_due = None;
    for count in 1..=3 {
        if let Some(due) = prior_due {
            wait_for_budget_deadline(due).await;
            supervisor.observe_once().await.unwrap();
        }
        let attempts = budget_attempts(&db, &soul);
        assert_eq!(attempts.len(), count);
        assert!(attempts.iter().all(|attempt| {
            attempt.intent_revision == 1
                && attempt.verdict == "blocked"
                && attempt.finished_at >= attempt.started_at
        }));
        let last = attempts.last().unwrap();
        if let Some(due) = prior_due {
            assert!(
                last.started_at >= due,
                "the supervisor cannot dispatch early"
            );
        }
        let retry = budget_retry(&db, &soul).expect("persist the spent automatic budget");
        assert_eq!(retry.attempt_count, count);
        assert_eq!(retry.intent_revision, 1);
        assert!(retry.reserved_attempt_id.is_none());
        assert_eq!(
            retry.next_due_at_ms,
            match count {
                1 => Some(retry.settled_at_ms + 2_000),
                2 => Some(retry.settled_at_ms + 10_000),
                _ => None,
            },
            "backoff starts when the failed attempt settles"
        );
        assert!(retry.settled_at_ms >= last.finished_at);
        assert_eq!(
            retry.last_reason,
            if count == 3 {
                "retry_exhausted"
            } else {
                "backend_unavailable"
            }
        );
        // OpenCode checks the retained store before reservation and probes
        // again under the reserved attempt. Both inspections are read-only.
        assert_eq!(backend.inspections.load(Ordering::SeqCst), count * 2);
        prior_due = retry.next_due_at_ms;
    }
    assert!(started.elapsed() >= Duration::from_secs(12));
    let exhausted = registry.recovery_context(soul.clone()).await.unwrap();
    assert_eq!(exhausted.recovery_state, RecoveryState::Blocked);
    assert_eq!(
        registry.inventory().await.unwrap()[0]
            .recovery_reason
            .as_deref(),
        Some("RETRY_BUDGET")
    );
    supervisor.observe_once().await.unwrap();
    assert_eq!(budget_attempts(&db, &soul).len(), 3);
    assert_eq!(backend.inspections.load(Ordering::SeqCst), 6);
    assert_eq!(*seen.lock().unwrap(), vec![RecoveryTrigger::ProviderExit]);
    shutdown.send(()).unwrap();
    task.await.unwrap();
    drop(supervisor);
    drop(registry);
    drop(client);
    std::fs::remove_file(&config.control_socket_path).unwrap();
    let registry = Registry::open(&registry_root, None).unwrap();
    let supervisor = Supervisor::new(registry.clone(), backend.clone(), config.clone()).unwrap();
    let (shutdown, task) = control(
        supervisor.clone(),
        &config.control_socket_path,
        seen.clone(),
    )
    .await;
    let reopened_budget = budget_retry(&db, &soul).unwrap();
    assert_eq!(reopened_budget.attempt_count, 3);
    assert_eq!(reopened_budget.next_due_at_ms, None);
    assert_eq!(reopened_budget.last_reason, "retry_exhausted");
    let client = RuntimeClient::new(&config.control_socket_path, &config.control_secret);
    backend.repaired.store(true, Ordering::SeqCst);
    let secret = b"synthetic-host-secret";
    std::fs::write(runtime.join("secret"), secret).unwrap();
    let listener = tokio::net::UnixListener::bind(runtime.join("host.sock")).unwrap();
    let (stop_host, mut stop_rx) = tokio::sync::oneshot::channel();
    let host_control_epoch = registry.control_epoch();
    let host = tokio::spawn(async move {
        let boot = HostBootId::new();
        loop {
            let mut socket =
                tokio::select! {_=&mut stop_rx=>break,a=listener.accept()=>a.unwrap().0};
            let envelope: Envelope<HostCommand> = read_frame(&mut socket).await.unwrap();
            let result = match envelope.body {
                HostCommand::Hello {
                    challenge,
                    incarnation_id,
                } => HostResult::Hello {
                    host_boot_id: boot.clone(),
                    proof: host_proof(secret, &challenge, &boot, &incarnation_id),
                    capabilities: vec![
                        "owned-provider-config-v1".into(),
                        "provider-store-probe-v1".into(),
                        "native-identity-observation-v1".into(),
                    ],
                    effective_limits: limits(),
                },
                HostCommand::Status { .. } => HostResult::Status {
                    host_boot_id: boot.clone(),
                    worker_pid: Some(123),
                    worker_launch_count: 1,
                    max_control_epoch: host_control_epoch,
                    max_execution_generation: launch.execution_generation,
                    fixture_evidence: serde_json::json!({}),
                    exited: false,
                    native_session_id: Some(observation.native_session_id.clone()),
                    native_identity_observation: Some(observation.clone()),
                    opencode_adoption: OpenCodeAdoptionStatus::NotRequired,
                    opencode_transfer_receipt: None,
                },
                HostCommand::ProbeRecovery { .. } => {
                    HostResult::RecoveryProbe(RecoveryProbe::Blocked {
                        path: RecoveryPath::NativeResume,
                        reason: RecoveryBlockReason::AmbiguousIdentity,
                        retry_hint: RetryHint {
                            automatic_after_ms: None,
                            manual_retry: true,
                            repair: Some("capture identity".into()),
                        },
                        evidence: vec![],
                    })
                }
                other => panic!("unexpected repaired-host command {other:?}"),
            };
            write_frame(
                &mut socket,
                &HostReply {
                    request_id: envelope.request_id,
                    result: Ok(result),
                },
            )
            .await
            .unwrap();
        }
    });
    // Repairing the dependency while the controller was down does not grant
    // a fresh automatic budget on startup or on a later observation pass.
    let cold_scan = supervisor.reconcile_startup().await.unwrap();
    assert_eq!(cold_scan.results.len(), 1);
    assert_eq!(cold_scan.results[0].outcome, Some(RecoveryOutcome::Blocked));
    assert!(cold_scan.results[0].error.is_none());
    supervisor.observe_once().await.unwrap();
    let automatic = client
        .recover(soul.clone(), RecoveryTrigger::StartupReconcile)
        .await
        .unwrap();
    assert_eq!(budget_attempts(&db, &soul).len(), 3);
    assert_eq!(backend.inspections.load(Ordering::SeqCst), 6);
    assert_eq!(budget_retry(&db, &soul), Some(reopened_budget));
    let manual = client
        .recover(soul.clone(), RecoveryTrigger::ManualRetry)
        .await
        .unwrap();
    shutdown.send(()).unwrap();
    task.await.unwrap();
    stop_host.send(()).unwrap();
    host.await.unwrap();
    assert_eq!(
        automatic.outcome,
        RecoveryOutcome::Blocked,
        "cold automatic request must remain blocked after repair"
    );
    assert_eq!(
        automatic.view.recovery_reason.as_deref(),
        Some("RETRY_BUDGET")
    );
    assert_eq!(automatic.view.intent_revision, 1);
    if let Some(probe) = automatic.probe.as_ref() {
        assert!(matches!(probe, RecoveryProbe::Blocked {
            reason: RecoveryBlockReason::RetryBudget, ..
        }), "exhaustion may only return the persisted budget refusal: {probe:?}");
    }
    assert_eq!(
        manual.outcome,
        RecoveryOutcome::Reattached,
        "only explicit manual retry rearms recovery"
    );
    assert_eq!(manual.view.incarnation_id, prepared.incarnation_id);
    assert_eq!(manual.view.intent_revision, 2);
    assert_eq!(
        manual.view.native_session_id.as_deref(),
        Some("ses_startup_repaired")
    );
    assert_eq!(manual.view.recovery_state, RecoveryState::Live);
    assert_eq!(
        budget_retry(&db, &soul),
        None,
        "successful manual reattach settles the new budget"
    );
    let attempts = budget_attempts(&db, &soul);
    assert_eq!(attempts.len(), 4);
    assert_eq!(attempts[3].intent_revision, 2);
    assert_eq!(attempts[3].verdict, "reattached");
    assert_eq!(backend.inspections.load(Ordering::SeqCst), 8);
    assert_eq!(
        *seen.lock().unwrap(),
        vec![
            RecoveryTrigger::ProviderExit,
            RecoveryTrigger::StartupReconcile,
            RecoveryTrigger::ManualRetry
        ]
    );
    let conn = rusqlite::Connection::open(&db).unwrap();
    let retained_input: (Vec<u8>, String, String) = conn.query_row(
        "SELECT protected_payload,state,incarnation_id FROM input_commands WHERE soul_id=?1 AND request_id=?2",
        rusqlite::params![soul.as_str(), input.as_str()],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).unwrap();
    assert_eq!(
        retained_input,
        (
            b"accepted-turn".to_vec(),
            "dispatching".into(),
            prepared.incarnation_id.to_string()
        )
    );
    assert_eq!(std::fs::read(output).unwrap(), b"startup diagnostic");
    assert_eq!(
        registry.inventory().await.unwrap().len(),
        1,
        "no replacement conversation"
    );
}

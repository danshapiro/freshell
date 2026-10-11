use super::*;
use freshell_runtime_protocol::*;
use freshell_supervisor::{backend::*, registry::*, service::*};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

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
    registry
        .commit_execution_grant(prepared.incarnation_id.clone(), HostBootId::new(), limits())
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
        .mark_input_dispatching(soul.clone(), input)
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
    let started = tokio::time::Instant::now();
    let exhausted = recover_with_policy(&client, soul.clone(), RecoveryTrigger::ProviderExit)
        .await
        .unwrap();
    assert!(started.elapsed() >= std::time::Duration::from_secs(12));
    assert_eq!(backend.inspections.load(Ordering::SeqCst), 3);
    assert_eq!(
        *seen.lock().unwrap(),
        vec![
            RecoveryTrigger::ProviderExit,
            RecoveryTrigger::ProviderExit,
            RecoveryTrigger::ProviderExit,
            RecoveryTrigger::RetryExhausted
        ]
    );
    assert!(matches!(
        exhausted.probe,
        Some(RecoveryProbe::Blocked {
            reason: RecoveryBlockReason::RetryBudget,
            ..
        })
    ));
    shutdown.send(()).unwrap();
    task.await.unwrap();
    drop(supervisor);
    drop(registry);
    drop(client);
    std::fs::remove_file(&config.control_socket_path).unwrap();
    let registry = Registry::open(&registry_root, None).unwrap();
    let supervisor = Supervisor::new(registry.clone(), backend.clone(), config.clone()).unwrap();
    let (shutdown, task) = control(supervisor, &config.control_socket_path, seen).await;
    let client = RuntimeClient::new(&config.control_socket_path, &config.control_secret);
    backend.repaired.store(true, Ordering::SeqCst);
    let secret = b"synthetic-host-secret";
    std::fs::write(runtime.join("secret"), secret).unwrap();
    let listener = tokio::net::UnixListener::bind(runtime.join("host.sock")).unwrap();
    let (stop_host, mut stop_rx) = tokio::sync::oneshot::channel();
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
                    capabilities: vec![],
                    effective_limits: limits(),
                },
                HostCommand::Status { .. } => HostResult::Status {
                    host_boot_id: boot.clone(),
                    worker_pid: Some(123),
                    worker_launch_count: 1,
                    max_control_epoch: 1,
                    max_execution_generation: 1,
                    fixture_evidence: serde_json::json!({}),
                    exited: false,
                    native_session_id: None,
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
    let automatic = client
        .recover(soul.clone(), RecoveryTrigger::StartupReconcile)
        .await
        .unwrap();
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
    assert!(matches!(
        automatic.probe,
        Some(RecoveryProbe::Blocked {
            reason: RecoveryBlockReason::RetryBudget,
            ..
        })
    ));
    assert_eq!(
        manual.outcome,
        RecoveryOutcome::Reattached,
        "only explicit manual retry rearms recovery"
    );
    assert_eq!(manual.view.incarnation_id, prepared.incarnation_id);
    assert_eq!(std::fs::read(output).unwrap(), b"startup diagnostic");
    assert_eq!(
        registry.inventory().await.unwrap().len(),
        1,
        "no replacement conversation"
    );
}

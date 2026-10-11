struct ShellBackend(std::sync::Mutex<BackendRuntimeState>);
#[async_trait::async_trait]
impl crate::backend::RuntimeBackend for ShellBackend {
    async fn create_stopped(
        &self,
        _: &crate::backend::CreateRuntimeSpec,
    ) -> Result<crate::backend::BackendCreated, BackendError> {
        panic!("no shell replacement permitted after dispatch")
    }
    async fn start_host(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
        panic!("no new host")
    }
    async fn inspect(
        &self,
        _: &OwnedRuntimeHandle,
    ) -> Result<crate::backend::BackendInspection, BackendError> {
        Ok(crate::backend::BackendInspection {
            state: *self.0.lock().unwrap(),
            configured_limits: checkpoints::tests::limits(),
        })
    }
    async fn request_stop(&self, _: &OwnedRuntimeHandle, _: u64) -> Result<(), BackendError> {
        *self.0.lock().unwrap() = BackendRuntimeState::Exited;
        Ok(())
    }
    async fn force_stop(&self, h: &OwnedRuntimeHandle) -> Result<(), BackendError> {
        self.request_stop(h, 0).await
    }
    async fn verify_empty(&self, _: &OwnedRuntimeHandle) -> Result<bool, BackendError> {
        Ok(matches!(
            *self.0.lock().unwrap(),
            BackendRuntimeState::Exited | BackendRuntimeState::Missing
        ))
    }
    async fn list_known(
        &self,
        h: &[OwnedRuntimeHandle],
    ) -> Result<Vec<(IncarnationId, crate::backend::BackendInspection)>, BackendError> {
        let mut v = vec![];
        for h in h {
            v.push((h.incarnation_id().clone(), self.inspect(h).await?));
        }
        Ok(v)
    }
    async fn read_limits(
        &self,
        _: &OwnedRuntimeHandle,
    ) -> Result<freshell_runtime_protocol::RuntimeLimits, BackendError> {
        Ok(checkpoints::tests::limits())
    }
    async fn enable_long_lived(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
        Ok(())
    }
}

async fn shell_supervisor(
    root: &std::path::Path,
    state: BackendRuntimeState,
    dispatched: bool,
) -> (Supervisor, RecoveryContext) {
    let (registry, ctx) = checkpoints::tests::context(root, "shell", dispatched).await;
    registry
        .plan_or_apply_migration(
            freshell_runtime_protocol::MigrationPlanRequest {
                requested_mode: ManagedRolloutMode::ManagedOptIn,
                apply: true,
                backup_path: None,
                legacy_metadata_path: None,
                expected_control_epoch: None,
            },
            true,
            true,
        )
        .await
        .unwrap();
    let config = crate::service::SupervisorConfig {
        runtime_root: root.join("runtime"),
        control_socket_path: root.join("control.sock"),
        host_binary_path: root.join("runtime/host"),
        image_ref: format!("sha256:{}", "b".repeat(64)),
        test_run_id: "shell-recovery".into(),
        control_secret: "synthetic-control-secret".into(),
        lifecycle_log: root.join("lifecycle.jsonl"),
        admission: crate::admission::AdmissionPolicy::default(),
    };
    (
        Supervisor::new(
            registry,
            std::sync::Arc::new(ShellBackend(std::sync::Mutex::new(state))),
            config,
        )
        .unwrap(),
        ctx,
    )
}

async fn shell_host(
    ctx: &RecoveryContext,
) -> (
    tokio::sync::oneshot::Sender<()>,
    tokio::task::JoinHandle<usize>,
) {
    recovery_host(
        ctx,
        RecoveryProbe::DefinitivelyUnavailable {
            path: RecoveryPath::NativeResume,
            reason: "no identity".into(),
            evidence: vec!["synthetic".into()],
            store_state: EvidenceStoreState::Missing,
            negative_paths: vec![],
        },
    )
    .await
}

async fn recovery_host(
    ctx: &RecoveryContext,
    probe: RecoveryProbe,
) -> (
    tokio::sync::oneshot::Sender<()>,
    tokio::task::JoinHandle<usize>,
) {
    recovery_host_status(ctx, probe, true, Some(123)).await
}

async fn recovery_host_status(
    ctx: &RecoveryContext,
    probe: RecoveryProbe,
    exited: bool,
    worker_pid: Option<u32>,
) -> (
    tokio::sync::oneshot::Sender<()>,
    tokio::task::JoinHandle<usize>,
) {
    let runtime = ctx.prior_handle.runtime_dir();
    let secret = b"synthetic-host-secret";
    std::fs::write(runtime.join("secret"), secret).unwrap();
    let listener = tokio::net::UnixListener::bind(runtime.join("host.sock")).unwrap();
    let boot = freshell_runtime_protocol::HostBootId::new();
    let native_session_id = ctx.native_session_id.clone();
    let (tx, mut rx) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        let mut native_probes = 0;
        loop {
            let socket = tokio::select! { _=&mut rx => break, v=listener.accept()=>v.unwrap().0 };
            let mut socket = socket;
            let envelope: freshell_runtime_protocol::Envelope<HostCommand> =
                freshell_runtime_protocol::read_frame(&mut socket)
                    .await
                    .unwrap();
            let result = match envelope.body {
                HostCommand::Hello {
                    incarnation_id,
                    challenge,
                } => HostResult::Hello {
                    host_boot_id: boot.clone(),
                    proof: freshell_runtime_protocol::host_proof(
                        secret,
                        &challenge,
                        &boot,
                        &incarnation_id,
                    ),
                    capabilities: vec![],
                    effective_limits: checkpoints::tests::limits(),
                },
                HostCommand::Status { .. } => HostResult::Status {
                    host_boot_id: boot.clone(),
                    worker_pid,
                    worker_launch_count: 1,
                    max_control_epoch: 1,
                    max_execution_generation: 1,
                    fixture_evidence: serde_json::json!({}),
                    exited,
                    native_session_id: native_session_id.clone(),
                },
                HostCommand::ProbeRecovery { .. } => {
                    native_probes += 1;
                    HostResult::RecoveryProbe(probe.clone())
                }
                HostCommand::Stop { .. } => HostResult::Stopped,
                other => panic!("unexpected shell command {other:?}"),
            };
            freshell_runtime_protocol::write_frame(
                &mut socket,
                &freshell_runtime_protocol::HostReply {
                    request_id: envelope.request_id,
                    result: Ok(result),
                },
            )
            .await
            .unwrap();
        }
        native_probes
    });
    (tx, task)
}

#[tokio::test]
async fn recovery_online_without_worker_does_not_claim_live() {
    for worker_pid in [Some(123), None] {
        let temp = tempfile::tempdir().unwrap();
        let (supervisor, ctx) =
            shell_supervisor(temp.path(), BackendRuntimeState::Running, true).await;
        let output = ctx.prior_handle.runtime_dir().join("retained-output");
        std::fs::write(&output, b"retained startup diagnostic").unwrap();
        let probe = RecoveryProbe::Blocked {
            path: RecoveryPath::NativeResume,
            reason: RecoveryBlockReason::AmbiguousIdentity,
            retry_hint: RetryHint {
                automatic_after_ms: None,
                manual_retry: true,
                repair: None,
            },
            evidence: vec!["unrecorded worker".into()],
        };
        let (shutdown, task) = recovery_host_status(&ctx, probe, false, worker_pid).await;
        let result = supervisor
            .recover(RecoverRequest {
                soul_id: ctx.soul_id.clone(),
                trigger: RecoveryTrigger::ProviderExit,
                expected_intent_revision: None,
                expected_control_epoch: None,
            })
            .await;
        shutdown.send(()).unwrap();
        assert_eq!(task.await.unwrap(), 0);
        let result = result.unwrap();
        assert_eq!(
            result.outcome,
            if worker_pid.is_some() {
                RecoveryOutcome::Reattached
            } else {
                RecoveryOutcome::Blocked
            },
            "a live host without a worker cannot prove reattachment"
        );
        assert_eq!(
            result.view.incarnation_id,
            *ctx.prior_handle.incarnation_id()
        );
        assert!(result.incident_id.is_none());
        assert_eq!(
            result.view.cleanup_state,
            freshell_runtime_protocol::CleanupState::None
        );
        assert_eq!(
            std::fs::read(output).unwrap(),
            b"retained startup diagnostic"
        );
        assert_eq!(
            supervisor
                .backend
                .inspect(&ctx.prior_handle)
                .await
                .unwrap()
                .state,
            BackendRuntimeState::Running
        );
        assert!(!supervisor
            .backend
            .verify_empty(&ctx.prior_handle)
            .await
            .unwrap());
        assert_eq!(supervisor.registry.inventory().await.unwrap().len(), 1);
    }
}

async fn shell_ended(online: bool) {
    let temp = tempfile::tempdir().unwrap();
    let (supervisor, ctx) = shell_supervisor(
        temp.path(),
        if online {
            BackendRuntimeState::Running
        } else {
            BackendRuntimeState::Exited
        },
        true,
    )
    .await;
    let output = ctx.prior_handle.runtime_dir().join("retained-output");
    std::fs::write(&output, b"last-shell-diagnostic").unwrap();
    let host = if online {
        Some(shell_host(&ctx).await)
    } else {
        None
    };
    let result = supervisor
        .recover(RecoverRequest {
            soul_id: ctx.soul_id.clone(),
            trigger: RecoveryTrigger::ProviderExit,
            expected_intent_revision: None,
            expected_control_epoch: None,
        })
        .await;
    if let Some((shutdown, task)) = host {
        shutdown.send(()).unwrap();
        assert_eq!(
            task.await.unwrap(),
            0,
            "shell has no native/checkpoint recovery paths"
        );
    }
    let result = result.unwrap();
    assert_eq!(result.outcome, RecoveryOutcome::Lost);
    let certificate = supervisor
        .registry
        .loss_certificate(result.incident_id.unwrap())
        .await
        .unwrap();
    assert_eq!(
        certificate.decision.state,
        freshell_runtime_protocol::LossDecisionState::NonResumableTerminalEnded
    );
    assert_eq!(certificate.recovery_paths.len(), 2);
    assert!(certificate
        .recovery_paths
        .iter()
        .all(|p| matches!(p.path, RecoveryPath::Reattach | RecoveryPath::PristineSeed)));
    assert_eq!(std::fs::read(output).unwrap(), b"last-shell-diagnostic");
    assert_eq!(supervisor.registry.inventory().await.unwrap().len(), 1);
}

#[tokio::test]
async fn shell_dispatched_verified_end_online() {
    shell_ended(true).await;
}
#[tokio::test]
async fn shell_dispatched_verified_end_offline() {
    shell_ended(false).await;
}
#[tokio::test]
async fn shell_uncertain_end_blocks() {
    let temp = tempfile::tempdir().unwrap();
    let (s, ctx) = shell_supervisor(temp.path(), BackendRuntimeState::Restarting, true).await;
    let result = s
        .recover(RecoverRequest {
            soul_id: ctx.soul_id,
            trigger: RecoveryTrigger::ProviderExit,
            expected_intent_revision: None,
            expected_control_epoch: None,
        })
        .await
        .unwrap();
    assert_eq!(result.outcome, RecoveryOutcome::Blocked);
    assert!(result.incident_id.is_none());
    assert_eq!(
        result.view.cleanup_state,
        freshell_runtime_protocol::CleanupState::None
    );
}
#[tokio::test]
async fn shell_never_dispatched_preserves_pristine_seed() {
    let temp = tempfile::tempdir().unwrap();
    let (s, ctx) = shell_supervisor(temp.path(), BackendRuntimeState::Exited, false).await;
    assert!(
        matches!(s.probe_recovery(ctx.soul_id).await.unwrap(),RecoveryProbe::PristineSeedReady {seed,..} if seed=="original-seed")
    );
}

#[tokio::test]
async fn recovery_inspected_sqlite_absence_certifies_loss_and_preserves_output() {
    let temp = tempfile::tempdir().unwrap();
    let (registry, ctx) = checkpoints::tests::context(temp.path(), "opencode", true).await;
    let db = temp.path().join("effective.db");
    let connection = rusqlite::Connection::open(&db).unwrap();
    connection
        .execute("CREATE TABLE session(id TEXT PRIMARY KEY)", [])
        .unwrap();
    drop(connection);
    let mut spec = checkpoints::tests::spec("opencode");
    spec.environment
        .insert("OPENCODE_DB".into(), db.display().to_string());
    registry
        .store_verified_resume_spec(ctx.soul_id.clone(), spec.clone())
        .await
        .unwrap();
    let inspected = freshell_agent_runtime::probe_provider_store(temp.path(), &spec);
    let freshell_agent_runtime::ProviderStoreProbe::DefinitivelyUnavailable {
        reason,
        evidence,
        store_state,
        negative_paths,
    } = inspected
    else {
        panic!("{inspected:?}")
    };
    let probe = RecoveryProbe::DefinitivelyUnavailable {
        path: RecoveryPath::NativeResume,
        reason,
        evidence,
        store_state,
        negative_paths,
    };
    registry
        .plan_or_apply_migration(
            freshell_runtime_protocol::MigrationPlanRequest {
                requested_mode: ManagedRolloutMode::ManagedOptIn,
                apply: true,
                backup_path: None,
                legacy_metadata_path: None,
                expected_control_epoch: None,
            },
            true,
            true,
        )
        .await
        .unwrap();
    let config = crate::service::SupervisorConfig {
        runtime_root: temp.path().join("runtime"),
        control_socket_path: temp.path().join("control.sock"),
        host_binary_path: ctx.prior_handle.host_binary_path().to_path_buf(),
        image_ref: ctx.prior_handle.image_ref().into(),
        test_run_id: "inspected-loss".into(),
        control_secret: "synthetic-control-secret".into(),
        lifecycle_log: temp.path().join("lifecycle.jsonl"),
        admission: Default::default(),
    };
    let supervisor = Supervisor::new(
        registry,
        std::sync::Arc::new(ShellBackend(std::sync::Mutex::new(
            BackendRuntimeState::Running,
        ))),
        config,
    )
    .unwrap();
    let output = ctx.prior_handle.runtime_dir().join("retained-output");
    std::fs::write(&output, b"last-provider-diagnostic").unwrap();
    let (shutdown, task) = recovery_host(&ctx, probe).await;
    let result = supervisor
        .recover(RecoverRequest {
            soul_id: ctx.soul_id,
            trigger: RecoveryTrigger::ProviderExit,
            expected_intent_revision: None,
            expected_control_epoch: None,
        })
        .await;
    shutdown.send(()).unwrap();
    assert!(task.await.unwrap() > 0);
    let result = result.unwrap();
    assert_eq!(result.outcome, RecoveryOutcome::Lost);
    let certificate = supervisor
        .registry
        .loss_certificate(result.incident_id.unwrap())
        .await
        .unwrap();
    assert_eq!(
        certificate.decision.state,
        freshell_runtime_protocol::LossDecisionState::Lost
    );
    assert_eq!(certificate.recovery_paths.len(), 4);
    assert!(certificate
        .recovery_paths
        .iter()
        .filter(|row| matches!(
            row.path,
            RecoveryPath::NativeResume | RecoveryPath::CheckpointRestore
        ))
        .all(|row| row.store_state == EvidenceStoreState::PresentReadable));
    assert_eq!(std::fs::read(output).unwrap(), b"last-provider-diagnostic");
    assert_eq!(supervisor.registry.inventory().await.unwrap().len(), 1);
}

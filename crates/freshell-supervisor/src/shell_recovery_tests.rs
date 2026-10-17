struct RecoveryBackend(std::sync::Mutex<BackendRuntimeState>);
#[async_trait::async_trait]
impl crate::backend::RuntimeBackend for RecoveryBackend {
    async fn create_stopped(
        &self,
        _: &crate::backend::CreateRuntimeSpec,
    ) -> Result<crate::backend::BackendCreated, BackendError> {
        panic!("no replacement permitted after dispatch")
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
    async fn qualify_retained_opencode(
        &self,
        handle: &OwnedRuntimeHandle,
        request: &freshell_runtime_protocol::RetainedStoreCompatibilityRequest,
        _: &std::path::Path,
    ) -> Result<freshell_runtime_protocol::RetainedStoreCompatibilityReceipt, BackendError> {
        let terminal = handle.terminal().expect("retained launch metadata");
        assert_eq!(terminal.mode, "opencode");
        assert_eq!(request.provider_store_id, handle.provider_store_id());
        assert_eq!(
            Some(request.native_session_id.as_str()),
            terminal.resume_session_id.as_deref()
        );
        assert_eq!(request.cwd, terminal.cwd);
        assert_eq!(request.workspace_path, terminal.workspace_path);
        assert_eq!(request.provider_uid, terminal.run_as_uid);
        assert_eq!(request.provider_gid, terminal.run_as_gid);
        // No provider store or native proof is installed in this backend.
        // Exercise a failed qualification, without inventing a native census.
        Err(BackendError::Malformed(
            "fixture retained provider store has no verified native evidence".into(),
        ))
    }
}

async fn shell_supervisor(
    root: &std::path::Path,
    state: BackendRuntimeState,
    dispatched: bool,
) -> (Supervisor, RecoveryContext) {
    let (registry, ctx) = checkpoints::tests::context(root, "shell", dispatched).await;
    recovery_supervisor(root, registry, ctx, state).await
}

async fn recovery_supervisor(
    root: &std::path::Path,
    registry: crate::registry::Registry,
    ctx: RecoveryContext,
    state: BackendRuntimeState,
) -> (Supervisor, RecoveryContext) {
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
        test_run_id: "recovery-fixture".into(),
        control_secret: "synthetic-control-secret".into(),
        lifecycle_log: root.join("lifecycle.jsonl"),
        admission: crate::admission::AdmissionPolicy::default(),
    };
    (
        Supervisor::new(
            registry,
            std::sync::Arc::new(RecoveryBackend(std::sync::Mutex::new(state))),
            config,
        )
        .unwrap(),
        ctx,
    )
}

async fn offline_coding_provider_without_verified_resume(native_session_id: Option<&str>) {
    let temp = tempfile::tempdir().unwrap();
    let (registry, ctx) = checkpoints::tests::context_with_native_identity(
        temp.path(),
        "opencode",
        false,
        native_session_id,
    )
    .await;
    registry
        .commit_execution_grant(
            ctx.prior_handle.incarnation_id().clone(),
            freshell_runtime_protocol::HostBootId::new(),
            checkpoints::tests::limits(),
        )
        .await
        .unwrap();
    assert!(matches!(
        registry.mark_running(ctx.prior_handle.incarnation_id().clone()).await,
        Err(RegistryError::RecoveryBlocked { reason, .. }) if reason == "NATIVE_IDENTITY_UNOBSERVED"
    ));
    // Reproduce a retained record admitted before native observation became
    // mandatory. Modern admission must refuse it; recovery must still retain
    // its real dispatch journal and output without certifying native loss.
    let terminal: freshell_runtime_protocol::TerminalLaunchSpec =
        serde_json::from_value(serde_json::json!({
            "terminalId":"unverified-terminal", "streamId":"unverified-stream",
            "mode":"opencode", "program":"opencode", "cwd":"/workspace",
            "workspacePath":"/workspace", "projectKey":"fixture",
            "env":{"HOME":"/home/freshell/provider"}, "cols":80,"rows":24,
            "runAsUid":65534,"runAsGid":0,"resumeSessionId":native_session_id
        }))
        .unwrap();
    let legacy = rusqlite::Connection::open(registry.database_path()).unwrap();
    legacy
        .execute(
            "UPDATE incarnations SET launch_state='running',terminal_spec=?2,terminal_id=?3 WHERE incarnation_id=?1",
            rusqlite::params![
                ctx.prior_handle.incarnation_id().as_str(),
                serde_json::to_string(&terminal).unwrap(),
                terminal.terminal_id,
            ],
        )
        .unwrap();
    legacy
        .execute(
            "UPDATE souls SET recovery_state='live' WHERE soul_id=?1",
            [ctx.soul_id.as_str()],
        )
        .unwrap();
    drop(legacy);
    let input = freshell_runtime_protocol::RequestId::new();
    registry
        .begin_input(ctx.soul_id.clone(), input.clone(), b"synthetic-input", None)
        .await
        .unwrap();
    registry
        .mark_input_dispatching(ctx.soul_id.clone(), input)
        .await
        .unwrap();
    let ctx = registry.recovery_context(ctx.soul_id).await.unwrap();
    assert_eq!(ctx.native_session_id.as_deref(), native_session_id);
    assert!(ctx.resume_spec.is_none());
    assert_eq!(ctx.checkpoint_revision, 0);
    assert_eq!(ctx.dispatched_command_count, 1);
    assert!(!ctx.never_dispatched);
    let (supervisor, ctx) =
        recovery_supervisor(temp.path(), registry, ctx, BackendRuntimeState::Exited).await;
    let output = ctx.prior_handle.runtime_dir().join("retained-output");
    std::fs::write(&output, b"provider exited before verified identity capture").unwrap();
    let before = supervisor.registry.inventory().await.unwrap();
    let connection = rusqlite::Connection::open(supervisor.registry.database_path()).unwrap();
    let retained_input = || {
        connection
            .query_row(
                "SELECT protected_payload,state,incarnation_id FROM input_commands WHERE soul_id=?1",
                [ctx.soul_id.as_str()],
                |row| {
                    Ok((
                        row.get::<_, Vec<u8>>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .unwrap()
    };
    let input_before = retained_input();
    assert_eq!(input_before.0, b"synthetic-input");
    assert_eq!(input_before.1, "dispatching");
    let result = supervisor
        .recover(RecoverRequest {
            soul_id: ctx.soul_id.clone(),
            trigger: RecoveryTrigger::ProviderExit,
            expected_intent_revision: None,
            expected_control_epoch: None,
        })
        .await
        .unwrap();

    assert_eq!(result.outcome, RecoveryOutcome::Blocked);
    let Some(RecoveryProbe::Blocked {
        path,
        reason,
        retry_hint,
        evidence,
    }) = result.probe
    else {
        panic!(
            "offline missing metadata must remain unknown: {:?}",
            result.probe
        );
    };
    assert_eq!(path, RecoveryPath::NativeResume);
    assert_eq!(reason, RecoveryBlockReason::StoreUnreadable);
    assert!(retry_hint.manual_retry);
    assert!(retry_hint.automatic_after_ms.is_none());
    assert!(retry_hint.repair.is_some_and(|repair| !repair.is_empty()));
    if native_session_id.is_some() {
        assert!(!evidence.is_empty());
    } else {
        assert!(
            evidence.is_empty(),
            "unknown native identity has no inspected proof"
        );
    }
    let qualification_attempts = std::fs::read_to_string(&supervisor.config.lifecycle_log)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .filter(|event| event["event"] == "supervisor.recovery.retained_qualification_started")
        .count();
    assert_eq!(qualification_attempts > 0, native_session_id.is_some());
    assert_eq!(result.view.soul_id, ctx.soul_id);
    assert_eq!(
        result.view.incarnation_id,
        *ctx.prior_handle.incarnation_id()
    );
    assert_eq!(result.view.container_id, before[0].container_id);
    assert_eq!(
        result.view.execution_generation,
        before[0].execution_generation
    );
    assert_eq!(result.view.native_session_id.as_deref(), native_session_id);
    assert_eq!(
        result.view.recovery_state,
        freshell_runtime_protocol::RecoveryState::Blocked
    );
    assert_eq!(
        result.view.cleanup_state,
        freshell_runtime_protocol::CleanupState::None
    );
    assert!(result.incident_id.is_none());
    assert!(result.view.incident_id.is_none());
    assert!(result.attempt_id.is_none());
    assert!(result.prior_incarnation_id.is_none());
    assert!(supervisor
        .registry
        .unresolved_loss_incident_ids()
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM loss_incidents", [], |row| row
                .get::<_, u64>(0))
            .unwrap(),
        0
    );
    let after = supervisor.registry.inventory().await.unwrap();
    assert_eq!(after.len(), 1, "recovery must not create a replacement");
    assert_eq!(after[0], result.view);
    let retained = supervisor
        .registry
        .recovery_context(ctx.soul_id.clone())
        .await
        .unwrap();
    assert_eq!(
        retained.prior_handle.incarnation_id(),
        ctx.prior_handle.incarnation_id()
    );
    assert_eq!(
        retained.prior_handle.container_id(),
        ctx.prior_handle.container_id()
    );
    assert_eq!(
        retained.prior_handle.runtime_dir(),
        ctx.prior_handle.runtime_dir()
    );
    assert_eq!(retained.dispatched_command_count, 1);
    assert_eq!(retained.native_session_id.as_deref(), native_session_id);
    assert!(retained.resume_spec.is_none());
    assert_eq!(retained_input(), input_before);
    assert_eq!(
        std::fs::read(output).unwrap(),
        b"provider exited before verified identity capture"
    );
}

#[tokio::test]
async fn recovery_offline_dispatched_without_identity_blocks_and_preserves_data() {
    offline_coding_provider_without_verified_resume(None).await;
}

#[tokio::test]
async fn recovery_offline_identity_without_verified_resume_blocks_and_preserves_data() {
    offline_coding_provider_without_verified_resume(Some("exact-session")).await;
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
    recovery_host_status(ctx, probe, true, Some(123), None).await
}

async fn recovery_host_status(
    ctx: &RecoveryContext,
    probe: RecoveryProbe,
    exited: bool,
    worker_pid: Option<u32>,
    native_observation: Option<freshell_runtime_protocol::NativeIdentityObservation>,
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
    let capabilities = if native_observation.is_some() {
        vec![
            "owned-provider-config-v1".to_string(),
            "provider-store-probe-v1".to_string(),
            "native-identity-observation-v1".to_string(),
        ]
    } else {
        vec![]
    };
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
                    capabilities: capabilities.clone(),
                    effective_limits: checkpoints::tests::limits(),
                },
                HostCommand::Status { .. } => HostResult::Status {
                    native_identity_observation: native_observation.clone(),
                    opencode_adoption:
                        freshell_runtime_protocol::OpenCodeAdoptionStatus::NotRequired,
                    opencode_transfer_receipt: None,
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
        let (shutdown, task) = recovery_host_status(&ctx, probe, false, worker_pid, None).await;
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
    assert_eq!(
        ctx.allocation_state,
        freshell_runtime_protocol::AllocationState::Allocated
    );
    assert!(ctx.native_session_id.is_none());
    assert_eq!(ctx.dispatched_command_count, 1);
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
    assert_eq!(result.outcome, RecoveryOutcome::Lost, "{result:?}");
    assert_eq!(result.view.cleanup_state, CleanupState::VerifiedEmpty);
    assert!(supervisor
        .backend
        .verify_empty(&ctx.prior_handle)
        .await
        .unwrap());
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
    assert_eq!(
        certificate.cleanup_target.incarnation_id,
        *ctx.prior_handle.incarnation_id()
    );
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
    for execution_granted in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let (s, ctx) = shell_supervisor(temp.path(), BackendRuntimeState::Exited, false).await;
        if execution_granted {
            s.registry
                .commit_execution_grant(
                    ctx.prior_handle.incarnation_id().clone(),
                    freshell_runtime_protocol::HostBootId::new(),
                    checkpoints::tests::limits(),
                )
                .await
                .unwrap();
            s.registry
                .mark_running(ctx.prior_handle.incarnation_id().clone())
                .await
                .unwrap();
            s.registry
                .begin_input(
                    ctx.soul_id.clone(),
                    freshell_runtime_protocol::RequestId::new(),
                    b"accepted but never dispatched",
                    None,
                )
                .await
                .unwrap();
        }
        assert!(
            matches!(s.probe_recovery(ctx.soul_id).await.unwrap(),RecoveryProbe::PristineSeedReady {seed,..} if seed=="original-seed")
        );
        assert!(s
            .registry
            .unresolved_loss_incident_ids()
            .await
            .unwrap()
            .is_empty());
    }
}

#[tokio::test]
async fn shell_stop_intent_prevents_terminal_end_loss() {
    let temp = tempfile::tempdir().unwrap();
    let (s, ctx) = shell_supervisor(temp.path(), BackendRuntimeState::Exited, true).await;
    let stopped = s.registry.begin_stop(ctx.soul_id.clone()).await.unwrap();
    let result = s
        .recover(RecoverRequest {
            soul_id: ctx.soul_id.clone(),
            trigger: RecoveryTrigger::ProviderExit,
            expected_intent_revision: None,
            expected_control_epoch: None,
        })
        .await
        .unwrap();
    assert_eq!(result.outcome, RecoveryOutcome::Stopped);
    assert_eq!(result.view.desired_state, DesiredState::Stopped);
    assert_eq!(result.view.incarnation_id, *stopped.incarnation_id());
    assert!(result.incident_id.is_none());
    assert!(s
        .registry
        .unresolved_loss_incident_ids()
        .await
        .unwrap()
        .is_empty());
    assert_eq!(s.registry.inventory().await.unwrap().len(), 1);
}

#[tokio::test]
async fn recovery_inspected_sqlite_absence_certifies_loss_and_preserves_output() {
    let temp = tempfile::tempdir().unwrap();
    let (registry, ctx) = checkpoints::tests::context(temp.path(), "opencode", true).await;
    let db = temp.path().join("effective.db");
    checkpoints::tests::create_empty_opencode_store(&db);
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
        std::sync::Arc::new(RecoveryBackend(std::sync::Mutex::new(
            BackendRuntimeState::Running,
        ))),
        config,
    )
    .unwrap();
    let output = ctx.prior_handle.runtime_dir().join("retained-output");
    std::fs::write(&output, b"last-provider-diagnostic").unwrap();
    let observation = supervisor
        .registry
        .inventory()
        .await
        .unwrap()
        .into_iter()
        .find(|view| view.soul_id == ctx.soul_id)
        .unwrap()
        .native_identity_observation
        .expect("valid dispatched fixture must retain its actual admitted observation");
    let (shutdown, task) =
        recovery_host_status(&ctx, probe, true, Some(123), Some(observation)).await;
    let result = supervisor
        .recover(RecoverRequest {
            soul_id: ctx.soul_id,
            trigger: RecoveryTrigger::ProviderExit,
            expected_intent_revision: None,
            expected_control_epoch: None,
        })
        .await;
    shutdown.send(()).unwrap();
    assert!(task.await.unwrap() > 0, "{result:?}");
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
    assert_eq!(certificate.recovery_paths.len(), 5);
    for path in [
        RecoveryPath::Reattach,
        RecoveryPath::NativeResume,
        RecoveryPath::CheckpointRestore,
        RecoveryPath::PristineSeed,
        RecoveryPath::NativeImport,
    ] {
        let row = certificate
            .recovery_paths
            .iter()
            .find(|row| row.path == path)
            .unwrap_or_else(|| panic!("loss must account for the {path:?} recovery path"));
        assert_eq!(
            row.verdict,
            freshell_runtime_protocol::RecoveryEvidenceVerdict::DefinitiveNegative
        );
        assert!(!row.reason_code.is_empty());
        assert!(!row.evidence_refs.is_empty());
    }
    let import = certificate
        .recovery_paths
        .iter()
        .find(|row| row.path == RecoveryPath::NativeImport)
        .unwrap();
    assert_eq!(import.store_state, EvidenceStoreState::NotApplicable);
    assert_eq!(
        import.reason_code,
        "native_import_definitive_negative_not_applicable"
    );
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

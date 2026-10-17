// Retained reads use actual supervisor/SQLite ownership and real spool files.
async fn retained_output_fixture(
    root: &std::path::Path,
    state: BackendRuntimeState,
) -> (Supervisor, RecoveryContext) {
    let (registry, context) = checkpoints::tests::context(root, "shell", true).await;
    // Match the producer's runtime_root/incarnation layout rather than the
    // checkpoint helper's deliberately minimal shared-root fixture.
    let runtime_dir = root
        .join("runtime")
        .join(context.prior_handle.incarnation_id().as_str());
    std::fs::create_dir(&runtime_dir).unwrap();
    let terminal: freshell_runtime_protocol::TerminalLaunchSpec = serde_json::from_value(serde_json::json!({
        "terminalId":"retained-terminal","streamId":"launch-prefix","mode":"shell","program":"/bin/sh",
        "cwd":"/workspace","runAsUid":65534,"runAsGid":0,"cols":120,"rows":30,
        "projectKey":"fixture","workspacePath":"/workspace"
    })).unwrap();
    let conn = rusqlite::Connection::open(registry.database_path()).unwrap();
    conn.execute(
        "UPDATE incarnations SET terminal_spec=?1,terminal_id=?2,runtime_dir=?4 WHERE incarnation_id=?3",
        rusqlite::params![
            serde_json::to_string(&terminal).unwrap(),
            terminal.terminal_id,
            context.prior_handle.incarnation_id().as_str(),
            runtime_dir.to_str().unwrap()
        ],
    )
    .unwrap();
    conn.execute("UPDATE souls SET recovery_state='blocked',recovery_reason='ambiguous_identity' WHERE soul_id=?1",[context.soul_id.as_str()]).unwrap();
    drop(conn);
    let context = registry.recovery_context(context.soul_id).await.unwrap();
    let incarnation = context.prior_handle.incarnation_id();
    let directory = context.prior_handle.runtime_dir();
    std::fs::write(
        directory.join("terminal-spool-descriptor.json"),
        serde_json::to_vec(&serde_json::json!({
            "schemaVersion":1,"incarnationId":incarnation,"terminalId":"retained-terminal",
            "streamEpoch":"launch-prefix-hostboot-exact","segmentLimitBytes":33554432
        }))
        .unwrap(),
    )
    .unwrap();
    let frames = (1..=3).map(|seq|serde_json::to_string(&serde_json::json!({"frame":{
        "terminalId":"retained-terminal","streamEpoch":"launch-prefix-hostboot-exact",
        "seqStart":seq,"seqEnd":seq,"data":if seq==3 {"final diagnostic".into()} else {"x".repeat(65536)}
    }})).unwrap()+"\n").collect::<String>();
    std::fs::write(directory.join("terminal-spool-current.jsonl"), frames).unwrap();
    recovery_supervisor(root, registry, context, state).await
}

async fn retained_output_read(
    supervisor: &Supervisor,
    soul: SoulId,
    after: u64,
) -> Result<freshell_runtime_protocol::RuntimeOutputBatch, RuntimeError> {
    let mut envelope = freshell_runtime_protocol::Envelope::new(
        freshell_runtime_protocol::RequestId::new(),
        freshell_runtime_protocol::ControlRole::Web,
        freshell_runtime_protocol::AdminCommand::TerminalReadOutput(
            freshell_runtime_protocol::TerminalReadOutputRequest {
                soul_id: soul,
                after_seq: after,
                max_bytes: 65536,
                expected_stream_epoch: Some("launch-prefix-hostboot-exact".into()),
                expected_control_epoch: None,
            },
        ),
    );
    envelope.auth = Some("synthetic-control-secret".into());
    match supervisor.dispatch(envelope).await.result? {
        freshell_runtime_protocol::AdminResult::TerminalOutput(output) => Ok(output),
        other => panic!("unexpected retained read {other:?}"),
    }
}

async fn retained_output_replacement(
    supervisor: &Supervisor,
    soul: SoulId,
    with_spool: bool,
) -> crate::registry::ReplacementPreparation {
    let registry = &supervisor.registry;
    let start = registry
        .begin_recovery(
            soul.clone(),
            RecoveryTrigger::ManualRetry,
            RecoveryPath::CheckpointRestore,
        )
        .await
        .unwrap();
    registry
        .mark_stop_outcome(
            start.context.prior_handle.incarnation_id().clone(),
            StopOutcome::VerifiedEmpty,
        )
        .await
        .unwrap();
    let replacement = registry
        .prepare_replacement(
            start.clone(),
            start.context.prior_handle.terminal().cloned(),
            None,
            None,
            RecoveryPath::CheckpointRestore,
        )
        .await
        .unwrap();
    let runtime_dir = supervisor
        .config
        .runtime_root
        .join(replacement.prepared.incarnation_id.as_str());
    std::fs::create_dir(&runtime_dir).unwrap();
    registry
        .commit_created(
            replacement.prepared.incarnation_id.clone(),
            crate::registry::BackendCreatedRecord {
                launch_policy: None,
                daemon_id: freshell_runtime_protocol::DockerDaemonId::new(),
                container_id: replacement
                    .prepared
                    .incarnation_id
                    .as_str()
                    .replace('-', "")
                    .repeat(2),
                image_ref: format!("sha256:{}", "b".repeat(64)),
                host_binary_path: runtime_dir.join("host"),
                runtime_dir: runtime_dir.clone(),
                immutable_config_digest: format!("sha256:{}", "c".repeat(64)),
            },
        )
        .await
        .unwrap();
    if with_spool {
        registry
            .commit_execution_grant(
                replacement.prepared.incarnation_id.clone(),
                freshell_runtime_protocol::HostBootId::new(),
                checkpoints::tests::limits(),
            )
            .await
            .unwrap();
        registry
            .mark_running(replacement.prepared.incarnation_id.clone())
            .await
            .unwrap();
        std::fs::write(runtime_dir.join("terminal-spool-descriptor.json"), serde_json::to_vec(&serde_json::json!({
            "schemaVersion":1,"incarnationId":replacement.prepared.incarnation_id,"terminalId":"retained-terminal",
            "streamEpoch":format!("launch-prefix-replacement-hostboot-{}", replacement.prepared.incarnation_id),"segmentLimitBytes":33554432
        })).unwrap()).unwrap();
        std::fs::write(runtime_dir.join("terminal-spool-current.jsonl"), serde_json::to_string(&serde_json::json!({"frame":{
            "terminalId":"retained-terminal","streamEpoch":format!("launch-prefix-replacement-hostboot-{}", replacement.prepared.incarnation_id),"seqStart":1,"seqEnd":1,"data":format!("replacement output {}", replacement.prepared.incarnation_id)
        }})).unwrap()+"\n").unwrap();
    }
    replacement
}

async fn retained_output_assert_warm_and_cold(
    supervisor: Supervisor,
    soul: SoulId,
    accepted: Option<freshell_runtime_protocol::IncarnationId>,
) {
    let config = (*supervisor.config).clone();
    let database_root = supervisor
        .registry
        .database_path()
        .parent()
        .unwrap()
        .to_path_buf();
    let assert_read = |output: freshell_runtime_protocol::RuntimeOutputBatch| {
        assert_eq!(
            output.stream_epoch,
            accepted
                .as_ref()
                .map(|id| format!("launch-prefix-replacement-hostboot-{id}"))
                .unwrap_or_else(|| "launch-prefix-hostboot-exact".into())
        );
        assert_eq!(
            output.frames[0].data,
            accepted
                .as_ref()
                .map(|id| format!("replacement output {id}"))
                .unwrap_or_else(|| "x".repeat(65536))
        );
        assert_eq!(output.reset_required, accepted.is_some());
    };
    assert_read(
        retained_output_read(&supervisor, soul.clone(), 0)
            .await
            .expect("warm read resolves accepted output"),
    );
    drop(supervisor);
    let cold = Supervisor::new(
        crate::registry::Registry::open(database_root, None).unwrap(),
        std::sync::Arc::new(RecoveryBackend(std::sync::Mutex::new(
            BackendRuntimeState::Exited,
        ))),
        config,
    )
    .unwrap();
    assert_read(
        retained_output_read(&cold, soul, 0)
            .await
            .expect("cold read resolves accepted output"),
    );
}

#[tokio::test]
async fn retained_output_owned_preparing_replacement_keeps_committed_prior() {
    let root = tempfile::tempdir().unwrap();
    let (supervisor, context) =
        retained_output_fixture(root.path(), BackendRuntimeState::Exited).await;
    retained_output_replacement(&supervisor, context.soul_id.clone(), false).await;
    retained_output_assert_warm_and_cold(supervisor, context.soul_id, None).await;
}

#[tokio::test]
async fn retained_output_failed_activation_without_spool_keeps_committed_prior() {
    let root = tempfile::tempdir().unwrap();
    let (supervisor, context) =
        retained_output_fixture(root.path(), BackendRuntimeState::Exited).await;
    let replacement =
        retained_output_replacement(&supervisor, context.soul_id.clone(), false).await;
    supervisor
        .registry
        .mark_stop_outcome(
            replacement.prepared.incarnation_id,
            StopOutcome::VerifiedEmpty,
        )
        .await
        .unwrap();
    supervisor
        .registry
        .mark_recovery_blocked(
            context.soul_id.clone(),
            Some(replacement.attempt_id),
            RecoveryBlockReason::ProviderUnavailable,
            vec!["synthetic activation failure".into()],
            supervisor
                .registry
                .recovery_context(context.soul_id.clone())
                .await
                .unwrap()
                .write_fence(),
        )
        .await
        .unwrap();
    retained_output_assert_warm_and_cold(supervisor, context.soul_id, None).await;
}

#[tokio::test]
async fn retained_output_wrong_identity_spool_cannot_displace_committed_prior() {
    let root = tempfile::tempdir().unwrap();
    let (supervisor, context) =
        retained_output_fixture(root.path(), BackendRuntimeState::Exited).await;
    let replacement = retained_output_replacement(&supervisor, context.soul_id.clone(), true).await;
    supervisor
        .registry
        .mark_stop_outcome(
            replacement.prepared.incarnation_id,
            StopOutcome::VerifiedEmpty,
        )
        .await
        .unwrap();
    supervisor
        .registry
        .mark_recovery_blocked(
            context.soul_id.clone(),
            Some(replacement.attempt_id),
            RecoveryBlockReason::WrongNativeIdentity,
            vec!["synthetic wrong identity".into()],
            supervisor
                .registry
                .recovery_context(context.soul_id.clone())
                .await
                .unwrap()
                .write_fence(),
        )
        .await
        .unwrap();
    retained_output_assert_warm_and_cold(supervisor, context.soul_id, None).await;
}

#[tokio::test]
async fn retained_output_accepted_replacement_becomes_source_and_survives_later_failure() {
    let root = tempfile::tempdir().unwrap();
    let (supervisor, context) =
        retained_output_fixture(root.path(), BackendRuntimeState::Exited).await;
    let replacement = retained_output_replacement(&supervisor, context.soul_id.clone(), true).await;
    supervisor
        .registry
        .mark_recovery_success(
            context.soul_id.clone(),
            replacement.prepared.incarnation_id.clone(),
            replacement.attempt_id,
            supervisor
                .registry
                .recovery_context(context.soul_id.clone())
                .await
                .unwrap()
                .write_fence(),
        )
        .await
        .unwrap();
    let output = retained_output_read(&supervisor, context.soul_id.clone(), 0)
        .await
        .unwrap();
    assert_eq!(
        output.frames[0].data,
        format!("replacement output {}", replacement.prepared.incarnation_id)
    );
    let failed = retained_output_replacement(&supervisor, context.soul_id.clone(), true).await;
    supervisor
        .registry
        .mark_stop_outcome(failed.prepared.incarnation_id, StopOutcome::VerifiedEmpty)
        .await
        .unwrap();
    supervisor
        .registry
        .mark_recovery_blocked(
            context.soul_id.clone(),
            Some(failed.attempt_id),
            RecoveryBlockReason::WrongNativeIdentity,
            vec![],
            supervisor
                .registry
                .recovery_context(context.soul_id.clone())
                .await
                .unwrap()
                .write_fence(),
        )
        .await
        .unwrap();
    retained_output_assert_warm_and_cold(
        supervisor,
        context.soul_id,
        Some(replacement.prepared.incarnation_id),
    )
    .await;
}

#[tokio::test]
async fn retained_output_legacy_success_with_overwritten_attempt_keeps_accepted_stream() {
    let root = tempfile::tempdir().unwrap();
    let (supervisor, context) =
        retained_output_fixture(root.path(), BackendRuntimeState::Exited).await;
    let replacement = retained_output_replacement(&supervisor, context.soul_id.clone(), true).await;
    supervisor
        .registry
        .mark_recovery_success(
            context.soul_id.clone(),
            replacement.prepared.incarnation_id.clone(),
            replacement.attempt_id.clone(),
            supervisor
                .registry
                .recovery_context(context.soul_id.clone())
                .await
                .unwrap()
                .write_fence(),
        )
        .await
        .unwrap();
    // Old successful rows did not carry an exact accepted-incarnation ref.
    let conn = rusqlite::Connection::open(supervisor.registry.database_path()).unwrap();
    conn.execute(
        "UPDATE recovery_attempts SET evidence_ref=NULL WHERE attempt_id=?1",
        [replacement.attempt_id.as_str()],
    )
    .unwrap();
    drop(conn);
    let failed = retained_output_replacement(&supervisor, context.soul_id.clone(), false).await;
    supervisor
        .registry
        .mark_stop_outcome(failed.prepared.incarnation_id, StopOutcome::VerifiedEmpty)
        .await
        .unwrap();
    supervisor
        .registry
        .mark_recovery_blocked(
            context.soul_id.clone(),
            Some(failed.attempt_id),
            RecoveryBlockReason::ProviderUnavailable,
            vec![],
            supervisor
                .registry
                .recovery_context(context.soul_id.clone())
                .await
                .unwrap()
                .write_fence(),
        )
        .await
        .unwrap();
    retained_output_assert_warm_and_cold(
        supervisor,
        context.soul_id,
        Some(replacement.prepared.incarnation_id),
    )
    .await;
}

#[tokio::test]
async fn retained_output_blocked_handle_replays_without_input_authority() {
    let root = tempfile::tempdir().unwrap();
    let (supervisor, context) =
        retained_output_fixture(root.path(), BackendRuntimeState::Running).await;
    let output = retained_output_read(&supervisor, context.soul_id.clone(), 0).await;
    assert!(
        supervisor
            .registry
            .active_handle_for_soul(context.soul_id)
            .await
            .is_err(),
        "retained resolver must not relax input authority"
    );
    let output =
        output.expect("blocked exact owned spool remains readable without active input handle");
    assert_eq!(output.frames[0].data, "x".repeat(65536));
    assert_eq!(output.head_seq, 3);
    assert!(
        !output.exited,
        "unsettled writer is independent of recovery outcome"
    );
}

#[tokio::test]
async fn retained_output_after_stop_does_not_wait_for_unavailable_host() {
    let root = tempfile::tempdir().unwrap();
    let (supervisor, context) =
        retained_output_fixture(root.path(), BackendRuntimeState::Exited).await;
    let runtime = context.prior_handle.runtime_dir();
    std::fs::write(runtime.join("secret"), b"synthetic-retained-host-secret").unwrap();
    assert!(!runtime.join("host.sock").exists());
    let mut stop = freshell_runtime_protocol::Envelope::new(
        freshell_runtime_protocol::RequestId::new(),
        freshell_runtime_protocol::ControlRole::Web,
        freshell_runtime_protocol::AdminCommand::Stop(freshell_runtime_protocol::StopRequest {
            soul_id: context.soul_id.clone(),
            expected_intent_revision: None,
            expected_control_epoch: None,
        }),
    );
    stop.auth = Some("synthetic-control-secret".into());
    let stopped = supervisor.dispatch(stop).await.result.unwrap();
    let freshell_runtime_protocol::AdminResult::Stop { outcome, view } = stopped else {
        panic!("unexpected Stop reply: {stopped:?}")
    };
    assert_eq!(outcome, StopOutcome::VerifiedEmpty);
    assert_eq!(view.desired_state, freshell_runtime_protocol::DesiredState::Stopped);
    let mut before = supervisor.registry.inventory().await.unwrap();

    let config = (*supervisor.config).clone();
    let database_root = supervisor.registry.database_path().parent().unwrap().to_path_buf();
    let mut supervisor = supervisor;
    let mut reads = Vec::new();
    for reader in 0..2 {
        if reader == 1 {
            drop(supervisor);
            supervisor = Supervisor::new(
                crate::registry::Registry::open(&database_root, None).unwrap(),
                std::sync::Arc::new(RecoveryBackend(std::sync::Mutex::new(
                    BackendRuntimeState::Exited,
                ))),
                config.clone(),
            )
            .unwrap();
            // Reopening reconciles legacy view-intent metadata. Establish
            // the read's baseline after that separate existing operation.
            before = supervisor.registry.inventory().await.unwrap();
        }
        // The real WebSocket pre-attach output refresh has this 500ms bound.
        // Keep the retained secret: missing it would bypass the host retry.
        reads.push(
            tokio::time::timeout(
                std::time::Duration::from_millis(500),
                retained_output_read(&supervisor, context.soul_id.clone(), 2),
            )
            .await,
        );
        assert_eq!(supervisor.registry.inventory().await.unwrap(), before);
    }
    assert!(
        reads.iter().all(Result::is_ok),
        "post-Stop output must reach the caller before its attach deadline: {reads:?}"
    );
    for read in reads {
        let output = read.unwrap().expect("accepted stopped spool remains readable");
        assert_eq!(output.incarnation_id, *context.prior_handle.incarnation_id());
        assert_eq!(output.terminal_id, "retained-terminal");
        assert_eq!(output.stream_epoch, "launch-prefix-hostboot-exact");
        assert_eq!(output.native_session_id, context.native_session_id);
        assert_eq!(output.frames.len(), 1);
        assert_eq!(output.frames[0].data, "final diagnostic");
        assert!(output.exited);
        assert!(output.completion.is_some());
    }
    assert_eq!(supervisor.registry.inventory().await.unwrap(), before);
    assert!(!runtime.join("host.sock").exists());
}

#[tokio::test]
async fn retained_output_stop_intent_keeps_draining_spool_open() {
    let root = tempfile::tempdir().unwrap();
    let (supervisor, context) =
        retained_output_fixture(root.path(), BackendRuntimeState::Running).await;
    let runtime = context.prior_handle.runtime_dir();
    std::fs::write(runtime.join("secret"), b"synthetic-retained-host-secret").unwrap();
    supervisor
        .registry
        .record_native_session(
            context.soul_id.clone(),
            context.prior_handle.incarnation_id().clone(),
            "retained-native-root".into(),
        )
        .await
        .unwrap();
    let stopping = supervisor
        .registry
        .begin_stop(context.soul_id.clone())
        .await
        .unwrap();
    supervisor
        .registry
        .record_ordinary_stop_outcome(&stopping, StopOutcome::TerminationUnconfirmed)
        .await
        .unwrap();
    let before = supervisor.registry.inventory().await.unwrap();
    for after in [2, 3] {
        if after == 3 {
            use std::io::Write;
            let mut spool = std::fs::OpenOptions::new()
                .append(true)
                .open(runtime.join("terminal-spool-current.jsonl"))
                .unwrap();
            writeln!(spool, "{}", serde_json::json!({"frame":{
                "terminalId":"retained-terminal","streamEpoch":"launch-prefix-hostboot-exact",
                "seqStart":4,"seqEnd":4,"data":"drained after Stop"
            }})).unwrap();
        }
        let output = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            retained_output_read(&supervisor, context.soul_id.clone(), after),
        )
        .await
        .expect("committed Stop must not wait for an unavailable host")
        .expect("accepted draining bytes remain readable");
        assert_eq!(output.incarnation_id, *context.prior_handle.incarnation_id());
        assert_eq!(output.terminal_id, "retained-terminal");
        assert_eq!(output.stream_epoch, "launch-prefix-hostboot-exact");
        assert_eq!(output.native_session_id.as_deref(), Some("retained-native-root"));
        assert_eq!(output.frames.len(), 1);
        assert_eq!(
            output.frames[0].data,
            if after == 2 { "final diagnostic" } else { "drained after Stop" }
        );
        assert!(!output.exited, "Stop intent is not verified termination");
        assert!(output.completion.is_none());
        assert!(!runtime.join("terminal-spool-completion.json").exists());
    }
    assert_eq!(supervisor.registry.inventory().await.unwrap(), before);
    assert!(!runtime.join("host.sock").exists());
}

#[tokio::test]
async fn retained_output_verified_end_survives_cleanup_and_cold_supervisor() {
    let root = tempfile::tempdir().unwrap();
    let (supervisor, context) =
        retained_output_fixture(root.path(), BackendRuntimeState::Exited).await;
    let result = supervisor
        .recover(RecoverRequest {
            soul_id: context.soul_id.clone(),
            trigger: RecoveryTrigger::ProviderExit,
            expected_intent_revision: None,
            expected_control_epoch: None,
        })
        .await
        .unwrap();
    assert_eq!(result.outcome, RecoveryOutcome::Lost, "{result:?}");
    let config = (*supervisor.config).clone();
    let database_root = supervisor
        .registry
        .database_path()
        .parent()
        .unwrap()
        .to_path_buf();
    drop(supervisor);
    let registry = crate::registry::Registry::open(&database_root, None).unwrap();
    let supervisor = Supervisor::new(
        registry,
        std::sync::Arc::new(RecoveryBackend(std::sync::Mutex::new(
            BackendRuntimeState::Exited,
        ))),
        config,
    )
    .unwrap();
    let mut windows = vec![];
    for _reader in 0..2 {
        let mut cursor = 0;
        let mut data = String::new();
        loop {
            let batch = retained_output_read(&supervisor, context.soul_id.clone(), cursor)
                .await
                .expect("cleaned up exact stream survives supervisor restart");
            assert!(
                batch.exited,
                "verified empty backend settles writer before frozen scan"
            );
            assert_eq!(batch.stream_epoch, "launch-prefix-hostboot-exact");
            for frame in batch.frames {
                cursor = frame.seq_end;
                data.push_str(&frame.data);
            }
            if cursor == batch.head_seq {
                break;
            }
        }
        windows.push(data);
    }
    assert_eq!(windows[0], windows[1]);
    assert_eq!(windows[0], "x".repeat(131072) + "final diagnostic");
}

#[tokio::test]
async fn concurrent_verified_empty_reads_share_one_completion_commit() {
    let root = tempfile::tempdir().unwrap();
    let (_supervisor, context) =
        retained_output_fixture(root.path(), BackendRuntimeState::Exited).await;
    let incarnation_id = context.prior_handle.incarnation_id().clone();
    let runtime_dir = context.prior_handle.runtime_dir().to_path_buf();
    let terminal = context.prior_handle.terminal().unwrap().clone();
    let gate = std::sync::Arc::new(std::sync::Barrier::new(32));
    let readers = (0..32)
        .map(|_| {
            let gate = std::sync::Arc::clone(&gate);
            let source = crate::registry::RetainedOutputSource {
                incarnation_id: incarnation_id.clone(),
                runtime_dir: runtime_dir.clone(),
                terminal_id: terminal.terminal_id.clone(),
                stream_id: terminal.stream_id.clone(),
                read_fence: Default::default(),
            stopped: false,
            verified_empty: false,
                native_session_id: None,
            };
            tokio::task::spawn_blocking(move || {
                gate.wait();
                crate::retained_output::read(
                    source,
                    0,
                    65536,
                    Some("launch-prefix-hostboot-exact".into()),
                    true,
                )
            })
        })
        .collect::<Vec<_>>();

    for reader in readers {
        let output = reader.await.unwrap().unwrap();
        assert!(output.exited);
        assert_eq!(output.head_seq, 3);
        assert!(matches!(
            output.completion.unwrap().exit,
            freshell_runtime_protocol::TerminalExitObservation::Unavailable
        ));
    }
    let completion: freshell_runtime_protocol::TerminalSpoolCompletion = serde_json::from_slice(
        &std::fs::read(runtime_dir.join("terminal-spool-completion.json")).unwrap(),
    )
    .unwrap();
    completion
        .validate(
            &freshell_runtime_protocol::TerminalSpoolDescriptor {
                schema_version: 1,
                incarnation_id,
                terminal_id: terminal.terminal_id,
                stream_epoch: "launch-prefix-hostboot-exact".into(),
                segment_limit_bytes: 33554432,
            },
            3,
        )
        .unwrap();
    assert_eq!(
        std::fs::read_dir(&runtime_dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with(".terminal-spool-completion.json.tmp-"))
            .count(),
        0,
        "concurrent completion temporaries are cleaned up"
    );
}

#[tokio::test]
async fn retained_output_missing_spool_reports_real_failure() {
    let root = tempfile::tempdir().unwrap();
    let (supervisor, context) =
        retained_output_fixture(root.path(), BackendRuntimeState::Exited).await;
    std::fs::remove_file(
        context
            .prior_handle
            .runtime_dir()
            .join("terminal-spool-current.jsonl"),
    )
    .unwrap();
    let error = retained_output_read(&supervisor, context.soul_id, 0)
        .await
        .unwrap_err();
    assert_eq!(
        error.code,
        RuntimeErrorCode::HostUnreachable,
        "owned but unavailable output is not an unknown soul"
    );
}

#[tokio::test]
async fn retained_output_loss_with_unconfirmed_cleanup_does_not_invent_completion() {
    let root = tempfile::tempdir().unwrap();
    let (supervisor, context) =
        retained_output_fixture(root.path(), BackendRuntimeState::Running).await;
    let conn = rusqlite::Connection::open(supervisor.registry.database_path()).unwrap();
    conn.execute(
        "UPDATE souls SET recovery_state='lost' WHERE soul_id=?1",
        [context.soul_id.as_str()],
    )
    .unwrap();
    conn.execute(
        "UPDATE incarnations SET cleanup_state='termination_unconfirmed' WHERE incarnation_id=?1",
        [context.prior_handle.incarnation_id().as_str()],
    )
    .unwrap();
    drop(conn);
    let read = retained_output_read(&supervisor, context.soul_id.clone(), 0)
        .await
        .unwrap();
    assert!(!read.exited);
    assert!(read.completion.is_none());
    assert!(read.exit_code.is_none());
    assert_eq!(read.head_seq, 3);
    assert_eq!(read.frames[0].data, "x".repeat(65536));
    assert!(!context
        .prior_handle
        .runtime_dir()
        .join("terminal-spool-completion.json")
        .exists());
}

#[tokio::test]
async fn retained_output_rejects_registry_path_outside_owned_runtime_root() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let (supervisor, context) =
        retained_output_fixture(root.path(), BackendRuntimeState::Exited).await;
    for name in [
        "terminal-spool-descriptor.json",
        "terminal-spool-current.jsonl",
    ] {
        std::fs::copy(
            context.prior_handle.runtime_dir().join(name),
            outside.path().join(name),
        )
        .unwrap();
    }
    let conn = rusqlite::Connection::open(supervisor.registry.database_path()).unwrap();
    conn.execute(
        "UPDATE incarnations SET runtime_dir=?1 WHERE incarnation_id=?2",
        rusqlite::params![
            outside.path().to_str().unwrap(),
            context.prior_handle.incarnation_id().as_str()
        ],
    )
    .unwrap();
    drop(conn);
    let result = retained_output_read(&supervisor, context.soul_id, 0).await;
    assert!(
        result.is_err(),
        "stored directory association cannot read another runtime root"
    );
}

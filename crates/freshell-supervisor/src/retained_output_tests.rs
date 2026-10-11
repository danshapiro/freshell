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
    assert_eq!(result.outcome, RecoveryOutcome::Lost);
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

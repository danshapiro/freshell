#[derive(Clone, Copy)]
enum ClaimTeardownPath {
    Create,
    Historical,
}

#[derive(Debug)]
enum ClaimTeardownResult {
    Create(CodexCreateOutcome),
    Historical(Result<(), ResumeSessionError>),
}

async fn assert_claim_refusal_retains_exact_writer_until_teardown(path: ClaimTeardownPath) {
    let _env = ENV_LOCK.lock().await;
    let (mut state, mut replies, sink) = state_with_sink();
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    state.set_ownership(registry.clone());
    let id = match path {
        ClaimTeardownPath::Create => "create-claim-refusal-teardown",
        ClaimTeardownPath::Historical => "historical-claim-refusal-teardown",
    };
    let request_id = "claim-refusal-create-request";
    sink.seed(
        PROVIDER,
        id,
        crate::identity_sink::FreshAgentSettings::default(),
    );
    let temporary = tempfile::tempdir().unwrap();
    let requests = temporary.path().join("requests.jsonl");
    let operations = temporary.path().join("operations.jsonl");
    let pid_path = temporary.path().join("sidecar.pid");
    configure_fake_codex_cmd(
        &json!({
            "appendRequestLogPath": requests,
            "appendThreadOperationLogPath": operations,
            "sidecarPidFile": pid_path,
        })
        .to_string(),
    );
    let gate = sink.arm_claim_commit_gate(PROVIDER, id);
    let (mut cleanup_entered, mut cleanup_completed, cleanup_release) =
        arm_delayed_exact_cleanup(&state);
    let operation_state = state.clone();
    let mut operation = tokio::spawn(async move {
        match path {
            ClaimTeardownPath::Create => ClaimTeardownResult::Create(
                create_resume_operation_for_test(&operation_state, request_id, id).await,
            ),
            ClaimTeardownPath::Historical => ClaimTeardownResult::Historical(
                operation_state
                    .ensure_session_resumable_once(id, None, None, None)
                    .await
                    .map(|_| ()),
            ),
        }
    });
    let gate = tokio::time::timeout(
        Duration::from_secs(20),
        tokio::task::spawn_blocking(move || {
            gate.entered
                .recv_timeout(Duration::from_secs(15))
                .expect("the successful native resume must reach its conditional claim commit");
            gate
        }),
    )
    .await
    .expect("claim entry observation is bounded")
    .unwrap();

    // The provider's operation witness is durable before its successful reply.
    // Reaching the claim gate proves that reply was accepted by the real lane.
    let native_operations: Vec<Value> = std::fs::read_to_string(&operations)
        .unwrap()
        .lines()
        .map(|row| serde_json::from_str(row).unwrap())
        .collect();
    assert_eq!(
        native_operations.len(),
        1,
        "exactly one native resume is permitted"
    );
    let native = &native_operations[0];
    assert_eq!(native["method"], "thread/resume");
    assert_eq!(native["threadId"], id);
    assert_eq!(native["params"]["threadId"], id);
    let pid: u32 = std::fs::read_to_string(&pid_path)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert_eq!(native["pid"].as_u64(), Some(u64::from(pid)));
    let runtime_id = native["sidecarOwnershipId"].as_str().unwrap().to_string();
    assert!(!runtime_id.is_empty());
    assert!(
        !crate::ownership_lane::partial_pid_confirmed_dead(pid),
        "the successful native writer is still alive at claim commit"
    );
    let start_time = freshell_codex::sidecar_store::proc_starttime(pid as i32);
    #[cfg(target_os = "linux")]
    assert!(
        start_time.is_some(),
        "capture the live writer's exact process incarnation"
    );
    assert!(
        !state.sessions.lock().await.contains_key(id),
        "the claim gate precedes runtime registration"
    );

    // Advance both the durable close fence and the coordinator owner while the
    // real conditional claim decision is parked. Cleanup belongs only to the
    // original native writer; its old ticket cannot release this replacement.
    crate::PaneIdentitySink::retire_closed(sink.as_ref(), PROVIDER, id)
        .await
        .unwrap();
    let closed_at = sink.kill_tombstone_at_ms(PROVIDER, id);
    assert!(closed_at.is_some());
    let freshell_ownership::OwnershipState::Starting {
        operation_id,
        generation,
        ..
    } = registry.observe(PROVIDER, id).state
    else {
        panic!("resume must hold its Starting owner")
    };
    assert_eq!(
        registry.fail(PROVIDER, id, &operation_id, generation, false),
        freshell_ownership::FailOutcome::Released
    );
    let freshell_ownership::BeginOutcome::Granted { generation } = registry.begin_start(
        PROVIDER,
        id,
        freshell_ownership::RuntimeOwnerKind::Terminal,
        "claim-teardown-replacement",
        None,
        "claim-teardown-test",
        crate::session_lease::now_epoch_ms(),
    ) else {
        panic!("the replacement terminal claims the key")
    };
    assert_eq!(
        registry.commit_live(
            PROVIDER,
            id,
            "claim-teardown-replacement",
            generation,
            freshell_ownership::OwnerIdentity {
                kind: freshell_ownership::RuntimeOwnerKind::Terminal,
                terminal_id: Some("claim-teardown-terminal".into()),
                live_session_key: None,
                pid: None,
                ownership_id: None,
            }
        ),
        freshell_ownership::CommitOutcome::Committed
    );
    let replacement = registry.observe(PROVIDER, id);
    gate.release
        .send(())
        .expect("release the stale claim decision");
    tokio::time::timeout(
        Duration::from_secs(15),
        tokio::task::spawn_blocking(move || {
            gate.decided
                .recv_timeout(Duration::from_secs(10))
                .expect("the claim decision must settle after release");
        }),
    )
    .await
    .expect("claim decision observation is bounded")
    .unwrap();

    let recorded = match tokio::time::timeout(Duration::from_secs(10), cleanup_entered.recv()).await
    {
        Ok(Some(recorded)) => recorded,
        other => {
            // Settle this test's own task before reporting the intended RED.
            let finished = operation.is_finished();
            let _ = cleanup_release.send(true);
            if !finished {
                operation.abort();
            }
            let _ = tokio::time::timeout(Duration::from_secs(10), operation).await;
            state.shutdown().await;
            panic!("a post-native claim refusal must enter exact writer cleanup: {other:?}; operation_finished={finished}");
        }
    };
    assert_eq!(
        recorded.pid, pid,
        "cleanup must identify the writer that answered this resume"
    );
    assert_eq!(recorded.ownership_id, runtime_id);
    assert_eq!(recorded.start_time, start_time);
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut operation)
            .await
            .is_err(),
        "claim refusal cannot return before its exact cleanup proof is released"
    );
    assert!(
        matches!(
            state.leases.claim(
                PROVIDER,
                id,
                "during-claim-cleanup",
                crate::session_lease::now_epoch_ms()
            ),
            crate::session_lease::FreshSessionClaim::Held { .. }
        ),
        "the provider lease remains held until exact writer teardown is confirmed"
    );
    assert_eq!(registry.observe(PROVIDER, id), replacement);
    assert!(!state.sessions.lock().await.contains_key(id));
    assert!(sink
        .claim_refusals
        .lock()
        .unwrap()
        .contains(&(PROVIDER.into(), id.into())));
    while let Ok(frame) = replies.try_recv() {
        let frame: Value = serde_json::from_str(&frame).unwrap();
        assert_ne!(frame["type"], "freshAgent.created");
        assert!(
            !(frame["type"] == "freshAgent.create.failed" && frame["requestId"] == request_id),
            "the requester must not receive failure before confirmed cleanup"
        );
    }

    cleanup_release.send(true).unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(10), cleanup_completed.recv())
            .await
            .expect("released cleanup must finish")
            .expect("cleanup reports its exact death proof")
    );
    let outcome = tokio::time::timeout(Duration::from_secs(10), operation)
        .await
        .expect("the failed resume settles after cleanup")
        .unwrap();
    assert!(
        crate::ownership_lane::partial_pid_confirmed_dead(pid),
        "the native writer must be confirmed dead before the failure is observed"
    );
    let owner = match outcome {
        ClaimTeardownResult::Create(CodexCreateOutcome::Failed {
            code,
            recovery,
            owner,
            ..
        }) => {
            assert_eq!(code, "FRESH_AGENT_CREATE_FAILED");
            assert!(recovery.is_superseded());
            let frames: Vec<Value> = std::iter::from_fn(|| replies.try_recv().ok())
                .map(|frame| serde_json::from_str(&frame).unwrap())
                .collect();
            let failures: Vec<_> = frames
                .iter()
                .filter(|frame| {
                    frame["type"] == "freshAgent.create.failed" && frame["requestId"] == request_id
                })
                .collect();
            assert_eq!(
                failures.len(),
                1,
                "the create requester receives exactly one correlated failure"
            );
            assert_eq!(failures[0]["code"], "FRESH_AGENT_CREATE_FAILED");
            assert_eq!(failures[0]["ownerKind"], "terminal");
            assert_eq!(failures[0]["ownerEpoch"], replacement.epoch);
            assert_eq!(failures[0]["ownerGeneration"], replacement.generation);
            owner
        }
        ClaimTeardownResult::Historical(Err(ResumeSessionError::Superseded(failure))) => {
            failure.owner
        }
        other => panic!("the refused claim must return its superseded failure: {other:?}"),
    }
    .expect("the refusal retains the replacement owner");
    assert_eq!(owner.owner_kind, "terminal");
    assert_eq!(owner.owner_epoch, replacement.epoch);
    assert_eq!(owner.owner_generation, replacement.generation);
    assert!(matches!(
        state.leases.claim(
            PROVIDER,
            id,
            "after-claim-cleanup",
            crate::session_lease::now_epoch_ms()
        ),
        crate::session_lease::FreshSessionClaim::Acquired
    ));
    state.leases.fail(PROVIDER, id, "after-claim-cleanup");
    assert_eq!(registry.observe(PROVIDER, id), replacement);
    assert_eq!(sink.kill_tombstone_at_ms(PROVIDER, id), closed_at);
    assert_eq!(
        sink.states
            .lock()
            .unwrap()
            .get(&(PROVIDER.into(), id.into()))
            .copied(),
        Some(crate::identity_sink::FakeRowState::Closed)
    );
    assert!(!state.sessions.lock().await.contains_key(id));
    let requests: Vec<Value> = std::fs::read_to_string(&requests)
        .unwrap()
        .lines()
        .map(|row| serde_json::from_str(row).unwrap())
        .collect();
    assert_eq!(
        requests
            .iter()
            .filter(|row| row["method"] == "thread/resume")
            .count(),
        1
    );
    assert!(
        !requests
            .iter()
            .any(|row| row["method"] == "thread/start" || row["method"] == "turn/start"),
        "claim refusal cannot mint a replacement thread or dispatch user input"
    );
    state.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn successful_create_resume_claim_refusal_holds_lease_until_exact_writer_teardown() {
    assert_claim_refusal_retains_exact_writer_until_teardown(ClaimTeardownPath::Create).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn successful_historical_resume_claim_refusal_holds_lease_until_exact_writer_teardown() {
    assert_claim_refusal_retains_exact_writer_until_teardown(ClaimTeardownPath::Historical).await;
}

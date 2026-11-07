#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn superseded_mint_staging_preserves_original_owner_runtime_and_durable_chain() {
    use freshell_ownership::{
        BeginOutcome, CommitOutcome, OwnerIdentity, OwnershipState, RuntimeOwnerKind,
        RuntimeOwnershipRegistry,
    };

    let _environment = ENV_LOCK.lock().await;
    let (mut state, original, sink) = crashed_publication_fixture().await;
    let original_runtime = state.sessions.lock().await[&original]
        .sidecar_ownership_id
        .clone();
    state.mark_thread_dead(&original).await;
    let registry = Arc::new(RuntimeOwnershipRegistry::with_epoch(691));
    state.set_ownership(registry.clone());
    let target = "publication-minted-target";
    let temporary = tempfile::tempdir().unwrap();
    let native_pid = temporary.path().join("replacement-pid");
    let requests = temporary.path().join("native-requests.jsonl");
    configure_fake_codex_cmd(
        &json!({
            "threadStartThreadId": target,
            "sidecarPidFile": native_pid,
            "appendRequestLogPath": requests
        })
        .to_string(),
    );
    let stall = sink.arm_binding_stall(PROVIDER, target);
    let recovering = state.clone();
    let recovering_id = original.clone();
    let task = tokio::spawn(async move {
        recovering
            .ensure_session_alive(&recovering_id, None, DeadThreadCachePolicy::Respect)
            .await
    });
    stall
        .entered
        .recv_timeout(Duration::from_secs(15))
        .expect("the real minted replacement reaches its durable binding write");
    let pid: u32 = std::fs::read_to_string(native_pid)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert!(
        !crate::ownership_lane::partial_pid_confirmed_dead(pid),
        "the staged replacement has an independently observed live native writer"
    );
    let target_claim = sink
        .bindings
        .lock()
        .unwrap()
        .iter()
        .rev()
        .find(|binding| binding.session_id == target)
        .unwrap()
        .claim
        .clone()
        .unwrap();
    assert!(matches!(registry.observe(PROVIDER, target).state,
        OwnershipState::Starting { kind: RuntimeOwnerKind::FreshAgent, operation_id, generation, .. }
            if operation_id == target_claim.operation_id && generation == target_claim.generation));
    assert_eq!(state.sessions.lock().await[target].sidecar_pid, Some(pid));

    // Mint recovery released the original key while retaining its old runtime
    // record. This competing owner changes the SOURCE, not the target claim.
    assert!(matches!(
        registry.observe(PROVIDER, &original).state,
        OwnershipState::Vacant
    ));
    let BeginOutcome::Granted { generation } = registry.begin_start(
        PROVIDER,
        &original,
        RuntimeOwnerKind::Terminal,
        "original-source-takeover",
        None,
        "test",
        1,
    ) else {
        panic!("a terminal obtains the original source key while staging waits");
    };
    assert_eq!(
        registry.commit_live(
            PROVIDER,
            &original,
            "original-source-takeover",
            generation,
            OwnerIdentity {
                kind: RuntimeOwnerKind::Terminal,
                terminal_id: Some("original-source-terminal".into()),
                live_session_key: None,
                pid: None,
                ownership_id: None,
            },
        ),
        CommitOutcome::Committed
    );
    let source_owner = registry.observe(PROVIDER, &original);
    stall.release.send(()).unwrap();
    let result = tokio::time::timeout(Duration::from_secs(15), task)
        .await
        .expect("the superseded mint settles its native writer and durable repair")
        .unwrap();

    // Capture these before shutdown so shutdown cannot supply the writer-death
    // witness or repair a stale publication on behalf of the operation.
    let writer_dead = crate::ownership_lane::partial_pid_confirmed_dead(pid);
    let (retained_runtime, target_registered) = {
        let sessions = state.sessions.lock().await;
        (
            sessions
                .get(&original)
                .map(|session| session.sidecar_ownership_id.clone()),
            sessions.contains_key(target),
        )
    };
    let source_after = registry.observe(PROVIDER, &original);
    let source_chain = crate::PaneIdentitySink::chain_terminus(sink.as_ref(), PROVIDER, &original);
    let repaired = sink.repairs.lock().unwrap().iter().any(|repair| {
        repair
            == &(
                PROVIDER.into(),
                target.into(),
                target_claim.operation_id.clone(),
                target_claim.epoch,
                target_claim.generation,
            )
    });
    let budget = state
        .session_recovery
        .status(&state.recovery_map_key(&original))
        .await
        .unwrap();
    state.shutdown().await;

    let Err(EnsureAliveError::Superseded(failure)) = result else {
        panic!("source takeover must refuse the pending mint as superseded: {result:?}");
    };
    assert_eq!(
        failure.owner,
        Some(crate::ownership_lane::TerminalOwnerFields {
            owner_kind: "terminal",
            owner_epoch: source_owner.epoch,
            owner_generation: generation,
        }),
        "the refusal names the source owner, not the fresh-agent target claim"
    );
    assert_eq!(source_after, source_owner);
    assert_eq!(retained_runtime.as_deref(), Some(original_runtime.as_str()));
    assert!(!target_registered);
    assert!(
        writer_dead,
        "the mint refuses only after its exact native writer is dead"
    );
    assert!(
        repaired,
        "the attempted target binding is repaired before refusal"
    );
    assert_eq!(
        source_chain, None,
        "a staged, refused replacement cannot redirect the original identity"
    );
    assert_eq!(budget.failed_launches, 0);
    assert!(budget.retry_after_ms.is_none());
    assert!(!budget.in_flight);
    let methods = std::fs::read_to_string(requests)
        .unwrap()
        .lines()
        .map(|line| {
            serde_json::from_str::<Value>(line).unwrap()["method"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect::<Vec<_>>();
    assert_eq!(
        methods
            .iter()
            .filter(|method| *method == "thread/start")
            .count(),
        1
    );
    assert!(!methods.iter().any(|method| method == "thread/resume"));
}

#[derive(Clone, Copy)]
enum SourcePublicationCase {
    Cancel,
    FailureBeforeWrite,
    FailureAfterApply,
}

async fn assert_committed_replacement_survives_publication(case: SourcePublicationCase) {
    let _environment = ENV_LOCK.lock().await;
    let (mut state, original, sink) = crashed_publication_fixture().await;
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    state.set_ownership(registry.clone());
    state.mark_thread_dead(&original).await;
    let target = "publication-committed-target";
    configure_fake_codex_cmd(&json!({"threadStartThreadId": target}).to_string());
    let stage = sink.arm_binding_stall(PROVIDER, target);
    let mut replies = state.broadcast_tx.subscribe();
    let recovering = state.clone();
    let recovering_id = original.clone();
    let task = tokio::spawn(async move {
        recovering
            .ensure_session_alive_once(&recovering_id, None, DeadThreadCachePolicy::Respect)
            .await
    });
    stage
        .entered
        .recv_timeout(Duration::from_secs(10))
        .expect("replacement staged");
    assert!(matches!(
        registry.observe(PROVIDER, target).state,
        freshell_ownership::OwnershipState::Starting { .. }
    ));
    assert_eq!(
        crate::PaneIdentitySink::chain_terminus(sink.as_ref(), PROVIDER, &original),
        None
    );
    let source_state = sink
        .states
        .lock()
        .unwrap()
        .get(&(PROVIDER.into(), original.clone()))
        .copied();
    let source_retires = sink.retires.lock().unwrap().clone();
    let staged_generation = registry.observe(PROVIDER, target).generation;
    let (pid, runtime_id) = {
        let sessions = state.sessions.lock().await;
        let target_session = &sessions[target];
        (
            target_session.sidecar_pid.unwrap(),
            target_session.sidecar_ownership_id.clone(),
        )
    };
    assert!(!crate::ownership_lane::partial_pid_confirmed_dead(pid));
    let publication = match case {
        SourcePublicationCase::Cancel => Some(sink.arm_binding_stall(PROVIDER, target)),
        SourcePublicationCase::FailureBeforeWrite => {
            // Stage has already applied. This makes the final write refuse
            // before applying any source retirement or old-to-new link.
            sink.set_fail_writes(true);
            None
        }
        SourcePublicationCase::FailureAfterApply => {
            Some(sink.arm_binding_stall_result(PROVIDER, target, true))
        }
    };
    stage.release.send(()).unwrap();
    let parked_target_owner = publication.as_ref().map(|publication| {
        publication
            .entered
            .recv_timeout(Duration::from_secs(10))
            .expect("source link publishes after Live commit");
        let target_owner = registry.observe(PROVIDER, target);
        assert!(matches!(
            target_owner.state,
            freshell_ownership::OwnershipState::Live { .. }
        ));
        assert!(
            matches!(
                registry.begin_start(
                    PROVIDER,
                    &original,
                    freshell_ownership::RuntimeOwnerKind::Terminal,
                    "late-source-takeover",
                    None,
                    "test",
                    0
                ),
                freshell_ownership::BeginOutcome::Blocked { .. }
            ),
            "the source stays owned while its durable replacement link is publishing"
        );
        target_owner
    });
    if matches!(case, SourcePublicationCase::Cancel) {
        let publication = publication.expect("cancellation parks the final publication");
        task.abort();
        assert!(tokio::time::timeout(Duration::from_secs(10), task)
            .await
            .expect("the canceled requester settles")
            .unwrap_err()
            .is_cancelled());
        publication.release.send(()).unwrap();
        publication
            .completed
            .recv_timeout(Duration::from_secs(10))
            .expect("publication outlives its canceled waiter");
    } else {
        if let Some(publication) = publication {
            publication.release.send(()).unwrap();
        }
        let outcome = tokio::time::timeout(Duration::from_secs(10), task)
            .await
            .unwrap()
            .unwrap();
        assert!(
            matches!(outcome, Ok(EnsureAliveOutcome::Respawned { new_session_id }) if new_session_id == target)
        );
        let mut alarm = false;
        while let Ok(wire) = replies.try_recv() {
            let message: Value = serde_json::from_str(&wire).unwrap();
            alarm |=
                message["sessionId"] == target && message["event"]["code"] == "LEDGER_WRITE_FAILED";
        }
        assert!(
            alarm,
            "final publication I/O failure is visible for the retained live target"
        );
    }
    assert!(state.has_live_session(target).await);
    assert!(!crate::ownership_lane::partial_pid_confirmed_dead(pid));
    let target_owner = registry.observe(PROVIDER, target);
    assert_eq!(target_owner.generation, staged_generation);
    assert!(matches!(&target_owner.state,
        freshell_ownership::OwnershipState::Live { owner, .. }
            if owner.kind == freshell_ownership::RuntimeOwnerKind::FreshAgent
                && owner.live_session_key.as_deref() == Some(target)
                && owner.pid == Some(pid)));
    if let Some(parked_owner) = parked_target_owner {
        assert_eq!(target_owner, parked_owner);
    }
    {
        let sessions = state.sessions.lock().await;
        assert_eq!(sessions[target].sidecar_pid, Some(pid));
        assert_eq!(sessions[target].sidecar_ownership_id, runtime_id);
    }
    let source_chain = crate::PaneIdentitySink::chain_terminus(sink.as_ref(), PROVIDER, &original);
    match case {
        SourcePublicationCase::FailureBeforeWrite => {
            assert_eq!(
                source_chain, None,
                "a failed write cannot publish the source link"
            );
            assert_eq!(
                sink.states
                    .lock()
                    .unwrap()
                    .get(&(PROVIDER.into(), original.clone()))
                    .copied(),
                source_state,
                "the failed write leaves the original row unchanged"
            );
            assert_eq!(
                *sink.retires.lock().unwrap(),
                source_retires,
                "the failed write never retires the original"
            );
            assert!(!sink
                .bindings
                .lock()
                .unwrap()
                .iter()
                .any(|binding| binding.supersedes.as_deref() == Some(original.as_str())));
        }
        SourcePublicationCase::Cancel | SourcePublicationCase::FailureAfterApply => {
            assert_eq!(
                source_chain.as_deref(),
                Some(target),
                "a successfully applied source link survives cancellation or its later error"
            );
        }
    }
    assert!(
        matches!(state.leases.claim(PROVIDER, &original, "competitor", crate::session_lease::now_epoch_ms()),
        crate::session_lease::FreshSessionClaim::BoundLive { live_session_key } if live_session_key == target)
    );
    assert!(!sink
        .repairs
        .lock()
        .unwrap()
        .iter()
        .any(|repair| repair.1 == target));
    sink.set_fail_writes(false);
    tokio::time::timeout(Duration::from_secs(15), state.shutdown())
        .await
        .expect("the committed replacement is cleaned up after publication observations");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn canceled_source_publication_retains_the_committed_replacement_writer() {
    assert_committed_replacement_survives_publication(SourcePublicationCase::Cancel).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_source_publication_retains_the_committed_replacement_writer_and_reports_io() {
    assert_committed_replacement_survives_publication(SourcePublicationCase::FailureBeforeWrite)
        .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_source_publication_after_apply_retains_committed_writer_and_persisted_link() {
    assert_committed_replacement_survives_publication(SourcePublicationCase::FailureAfterApply)
        .await;
}

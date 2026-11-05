use super::*;

async fn poll_adoption_to_checkpoint(
    mut adoption: std::pin::Pin<&mut impl std::future::Future>,
    signal: &std::sync::mpsc::Receiver<()>,
    checkpoint: &str,
) {
    tokio::time::timeout(
        Duration::from_secs(5),
        std::future::poll_fn(|cx| {
            assert!(
                std::future::Future::poll(adoption.as_mut(), cx).is_pending(),
                "adoption completed before {checkpoint}"
            );
            match signal.try_recv() {
                Ok(()) => std::task::Poll::Ready(()),
                Err(std::sync::mpsc::TryRecvError::Empty) => std::task::Poll::Pending,
                Err(error) => panic!("{checkpoint} disconnected: {error}"),
            }
        }),
    )
    .await
    .expect(checkpoint);
}

fn vacate_claude_owner_for_map_hit(
    registry: &Arc<freshell_ownership::RuntimeOwnershipRegistry>,
    session_id: &str,
) -> freshell_ownership::ObservedFence {
    let live = registry.observe(PROVIDER, session_id);
    let generation = match live.state {
        freshell_ownership::OwnershipState::Live { generation, .. } => generation,
        state => panic!("map-hit fixture must begin with a live owner: {state:?}"),
    };
    let stop_op = format!("test-vacate-{session_id}");
    let freshell_ownership::StopOutcome::Granted {
        generation: stop_generation,
    } = registry.begin_stop(
        PROVIDER,
        session_id,
        &stop_op,
        &freshell_ownership::StopClaim {
            expected_kind: freshell_ownership::RuntimeOwnerKind::FreshAgent,
            expected_runtime: None,
            observed: freshell_ownership::ObservedFence {
                epoch: live.epoch,
                generation,
            },
        },
        "test",
        freshell_ownership::now_epoch_ms(),
    )
    else {
        panic!("the fixture must vacate ownership while keeping the mapped runtime")
    };
    assert_eq!(
        registry.commit_stop(PROVIDER, session_id, &stop_op, stop_generation),
        freshell_ownership::CommitOutcome::Committed,
    );
    let vacant = registry.observe(PROVIDER, session_id);
    freshell_ownership::ObservedFence {
        epoch: vacant.epoch,
        generation: vacant.generation,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_binding_and_name_are_durable_before_live_and_created() {
    let _env_lock = CLAUDE_ENV_LOCK.lock().await;
    let env = FakeClaudeSidecarEnv::install_with_knobs(Some(1500), false);
    let (mut state, mut rx) = state_with_bus();
    let identity = Arc::new(crate::identity_sink::FakeIdentitySink::default());
    state.set_identity_sink(identity.clone());
    state.set_ownership(Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new()));
    let names = crate::naming::test_support::RecordingSink::new();
    state.set_session_naming(names.clone());
    let mut msg = dedup_create_msg("create-bound-before-live");
    msg.naming_handle = Some("pre-create-name".into());
    let task = {
        let state = state.clone();
        tokio::spawn(async move { state.handle_create(msg, None).await })
    };
    let line = env.create_request().await;
    let id = line["sessionId"].as_str().unwrap().to_string();
    assert!(uuid::Uuid::parse_str(&id).is_ok());
    let gate = identity.arm_binding_stall(PROVIDER, &id);
    gate.entered.recv_timeout(Duration::from_secs(10)).unwrap();
    assert!(matches!(
        state.ownership_snapshot(PROVIDER, &id).state,
        freshell_ownership::OwnershipState::Starting { .. }
    ));
    while let Ok(raw) = rx.try_recv() {
        assert_ne!(
            serde_json::from_str::<Value>(&raw).unwrap()["type"],
            "freshAgent.created"
        );
    }
    gate.release.send(()).unwrap();
    let outcome = task.await.unwrap();
    assert!(
        matches!(outcome, ClaudeCreateOutcome::Created { ref session_id, .. } if session_id == &id)
    );
    let created = await_claude_created(&mut rx, "create-bound-before-live").await;
    assert_eq!(
        created["nameRef"],
        json!({"kind":"session", "provider":"claude", "sessionId":id})
    );
    assert!(matches!(
        state.ownership_snapshot(PROVIDER, &id).state,
        freshell_ownership::OwnershipState::Live { .. }
    ));
    let updates = names
        .get(vec![
            freshell_protocol::session_names::SessionNameRef::Pending {
                id: "pre-create-name".into(),
            },
        ])
        .await
        .unwrap();
    assert_eq!(
        updates[0].record.name_ref,
        freshell_protocol::session_names::SessionNameRef::Session {
            provider: freshell_protocol::session_names::NamedProvider::Claude,
            session_id: id.clone()
        }
    );
    let mut replay = dedup_create_msg("create-bound-before-live");
    replay.naming_handle = Some("pre-create-name".into());
    state.handle_create(replay, None).await;
    let replayed = await_claude_created(&mut rx, "create-bound-before-live").await;
    assert_eq!(
        replayed["nameRef"], created["nameRef"],
        "a replay adopts the durable name identity"
    );
    assert_eq!(replayed["sessionName"], created["sessionName"]);
    assert!(identity
        .geneses
        .lock()
        .unwrap()
        .contains_key(&(PROVIDER.into(), id)));
    state.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_adoption_uses_the_retained_exact_owner_claim_not_the_sidecar_id() {
    let _env_lock = CLAUDE_ENV_LOCK.lock().await;
    let env = FakeClaudeSidecarEnv::install();
    let (mut state, mut rx) = state_with_bus();
    let identity = Arc::new(crate::identity_sink::FakeIdentitySink::default());
    state.set_identity_sink(identity.clone());
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    state.set_ownership(registry.clone());

    state
        .handle_create(dedup_create_msg("adoption-owner"), None)
        .await;
    let created = await_claude_created(&mut rx, "adoption-owner").await;
    let session_id = created["sessionId"].as_str().unwrap().to_string();
    let stamp = crate::ownership_lane::peek_retained_stamp(&state.ownership_stamps, &session_id)
        .expect("the established runtime retains its exact coordinator stamp");
    let sidecar_id = state.sessions.lock().await[&session_id]
        .ownership_id
        .clone();
    assert_ne!(stamp.operation_id, sidecar_id);
    assert_eq!(
        stamp.owner.ownership_id.as_deref(),
        Some(stamp.operation_id.as_str())
    );
    assert_eq!(
        registry.observe(PROVIDER, &session_id).generation,
        stamp.generation
    );

    identity.bindings.lock().unwrap().clear();
    let mut adopted = dedup_create_msg("adoption-requester");
    adopted.resume_session_id = Some(session_id.clone());
    adopted.session_ref = Some(claude_session_ref(&session_id));
    let outcome = state.handle_create(adopted, None).await;
    assert!(matches!(
        outcome,
        ClaudeCreateOutcome::Created {
            session_id: ref returned,
            ..
        } if returned == &session_id
    ));
    let _ = await_claude_created(&mut rx, "adoption-requester").await;

    let row = identity
        .bindings
        .lock()
        .unwrap()
        .iter()
        .rev()
        .find(|row| row.provider == PROVIDER && row.session_id == session_id)
        .cloned()
        .expect("adoption persists the live identity");
    assert_eq!(
        row.claim,
        Some(crate::identity_sink::BindingClaim::live_fresh_agent(
            PROVIDER,
            &session_id,
            &stamp.operation_id,
            stamp.epoch,
            stamp.generation,
        )),
        "the claim uses the coordinator's exact operation id and fence"
    );
    assert_eq!(row.settings, crate::identity_sink::SettingsUpdate::Keep);
    assert_eq!(
        env.spawn_count(),
        1,
        "adoption must not start another sidecar"
    );
    state.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn vacant_map_hit_create_keeps_starting_until_binding_persists() {
    let _env_lock = CLAUDE_ENV_LOCK.lock().await;
    let env = FakeClaudeSidecarEnv::install();
    let (mut state, mut rx) = state_with_bus();
    let identity = Arc::new(crate::identity_sink::FakeIdentitySink::default());
    state.set_identity_sink(identity.clone());
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    state.set_ownership(registry.clone());

    state
        .handle_create(dedup_create_msg("vacant-map-hit-owner"), None)
        .await;
    let created = await_claude_created(&mut rx, "vacant-map-hit-owner").await;
    let session_id = created["sessionId"].as_str().unwrap().to_string();
    while rx.try_recv().is_ok() {}
    let vacant_fence = vacate_claude_owner_for_map_hit(&registry, &session_id);
    identity.bindings.lock().unwrap().clear();
    let stall = identity.arm_binding_stall(PROVIDER, &session_id);

    let mut resume = dedup_create_msg("vacant-map-hit-adopt");
    resume.resume_session_id = Some(session_id.clone());
    resume.session_ref = Some(claude_session_ref(&session_id));
    resume.observed_epoch = Some(vacant_fence.epoch);
    resume.observed_generation = Some(vacant_fence.generation);
    let state2 = state.clone();
    let task = tokio::spawn(async move { state2.handle_create(resume, None).await });
    stall
        .entered
        .recv_timeout(Duration::from_secs(15))
        .expect("the map-hit adoption reaches its durable binding write");

    let starting = registry.observe(PROVIDER, &session_id);
    let (operation_id, epoch, generation) = match starting.state {
        freshell_ownership::OwnershipState::Starting {
            ref operation_id,
            generation,
            ..
        } => (operation_id.clone(), starting.epoch, generation),
        state => panic!("the map-hit binding write must remain Starting: {state:?}"),
    };
    assert!(matches!(
        registry.begin_handoff(
            PROVIDER,
            &session_id,
            freshell_ownership::RuntimeOwnerKind::Terminal,
            "handoff-during-claude-map-hit-write",
            None,
            "test",
            freshell_ownership::now_epoch_ms(),
        ),
        freshell_ownership::BeginOutcome::Blocked { .. }
    ));
    let binding = identity.bindings.lock().unwrap().last().cloned().unwrap();
    let expected_operation_id = operation_id.clone();
    assert_eq!(
        binding.claim,
        Some(crate::identity_sink::BindingClaim {
            provider: PROVIDER.into(),
            session_id: session_id.clone(),
            operation_id: expected_operation_id.clone(),
            epoch,
            generation,
            kind: crate::identity_sink::BindingClaimKind::Starting,
        }),
        "the parked write carries the exact ticket that still holds Starting"
    );
    assert_eq!(
        binding.settings,
        crate::identity_sink::SettingsUpdate::Keep,
        "map-hit identity establishment never replaces saved settings with defaults"
    );
    let premature_frames = std::iter::from_fn(|| rx.try_recv().ok())
        .map(|raw| serde_json::from_str::<serde_json::Value>(&raw).unwrap())
        .filter(|frame| {
            (frame["type"] == "freshAgent.created" && frame["requestId"] == "vacant-map-hit-adopt")
                || (frame["type"] == "session.runtimeOwner"
                    && frame["operationId"] == expected_operation_id)
        })
        .collect::<Vec<_>>();
    assert!(
        premature_frames.is_empty(),
        "the adopt cannot publish before persistence: {premature_frames:?}"
    );

    stall.release.send(()).unwrap();
    let outcome = task.await.unwrap();
    assert!(matches!(
        outcome,
        ClaudeCreateOutcome::Created { session_id: ref returned, .. } if returned == &session_id
    ));
    let created = await_claude_created(&mut rx, "vacant-map-hit-adopt").await;
    assert_eq!(created["sessionId"], session_id);
    assert!(matches!(
        registry.observe(PROVIDER, &session_id).state,
        freshell_ownership::OwnershipState::Live { .. }
    ));
    assert_eq!(
        env.spawn_count(),
        1,
        "the existing native runtime is adopted"
    );
    state.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn vacant_map_hit_cancellation_after_binding_keeps_the_existing_writer_fenced() {
    let _env_lock = CLAUDE_ENV_LOCK.lock().await;
    let _env = FakeClaudeSidecarEnv::install();
    let (mut state, mut rx) = state_with_bus();
    let identity = Arc::new(crate::identity_sink::FakeIdentitySink::default());
    state.set_identity_sink(identity.clone());
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    state.set_ownership(registry.clone());
    state
        .handle_create(dedup_create_msg("cancel-map-hit-owner"), None)
        .await;
    let created = await_claude_created(&mut rx, "cancel-map-hit-owner").await;
    let session_id = created["sessionId"].as_str().unwrap().to_string();
    vacate_claude_owner_for_map_hit(&registry, &session_id);
    let operation_id = "cancel-map-hit-adopt";
    let freshell_ownership::BeginOutcome::Granted { generation } = registry.begin_start(
        PROVIDER,
        &session_id,
        freshell_ownership::RuntimeOwnerKind::FreshAgent,
        operation_id,
        None,
        "test",
        freshell_ownership::now_epoch_ms(),
    ) else {
        panic!("the vacant runtime must admit its adoption claim")
    };
    let ticket = freshell_ownership::OperationTicket::new(
        registry.clone(),
        PROVIDER,
        &session_id,
        operation_id,
        freshell_ownership::RuntimeOwnerKind::FreshAgent,
        generation,
        "test",
    );
    let stall = identity.arm_binding_stall(PROVIDER, &session_id);
    let mut adoption = Box::pin(state.adopt_live_create_with_starting_ticket(
        operation_id,
        None,
        &session_id,
        "claude",
        Some(ticket),
    ));
    // A sidecar reader may hold this lock before adoption reaches persistence.
    // Force that scheduling order instead of relying on incidental contention.
    let initial_map_hold = state.sessions.lock().await;
    std::future::poll_fn(|cx| {
        assert!(std::future::Future::poll(adoption.as_mut(), cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    assert!(matches!(
        stall.entered.try_recv(),
        Err(std::sync::mpsc::TryRecvError::Empty)
    ));
    drop(initial_map_hold);
    poll_adoption_to_checkpoint(
        adoption.as_mut(),
        &stall.entered,
        "the binding write is parked",
    )
    .await;

    let mapped_runtime = state.sessions.lock().await;
    stall.release.send(()).unwrap();
    poll_adoption_to_checkpoint(
        adoption.as_mut(),
        &stall.completed,
        "the binding write returned before cancellation",
    )
    .await;
    // Persistence has returned; the next map lookup is blocked by our lock.
    // Cancel precisely here, while the existing native runtime is still mapped.
    drop(adoption);
    assert!(
        matches!(
            registry.observe(PROVIDER, &session_id).state,
            freshell_ownership::OwnershipState::Starting { ref operation_id, .. }
                if operation_id == "cancel-map-hit-adopt"
        ),
        "canceling the post-write lookup must retain its exact Starting claim"
    );
    assert!(registry.recover_stale_starts(u64::MAX, 0).is_empty());
    drop(mapped_runtime);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if matches!(
                registry.observe(PROVIDER, &session_id).state,
                freshell_ownership::OwnershipState::Live { .. }
            ) {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the canceled adoption durably recovers its existing runtime");
    assert!(identity.repairs.lock().unwrap().is_empty());
    state.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn vacant_map_hit_create_write_failure_keeps_the_starting_writer_fence() {
    let _env_lock = CLAUDE_ENV_LOCK.lock().await;
    let _env = FakeClaudeSidecarEnv::install();
    let (mut state, mut rx) = state_with_bus();
    let identity = Arc::new(crate::identity_sink::FakeIdentitySink::default());
    state.set_identity_sink(identity.clone());
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    state.set_ownership(registry.clone());

    state
        .handle_create(dedup_create_msg("vacant-map-hit-failure-owner"), None)
        .await;
    let created = await_claude_created(&mut rx, "vacant-map-hit-failure-owner").await;
    let session_id = created["sessionId"].as_str().unwrap().to_string();
    let vacant_fence = vacate_claude_owner_for_map_hit(&registry, &session_id);
    identity.bindings.lock().unwrap().clear();
    identity.set_fail_writes(true);

    let mut resume = dedup_create_msg("vacant-map-hit-failure-adopt");
    resume.resume_session_id = Some(session_id.clone());
    resume.session_ref = Some(claude_session_ref(&session_id));
    resume.observed_epoch = Some(vacant_fence.epoch);
    resume.observed_generation = Some(vacant_fence.generation);
    let outcome = state.handle_create(resume, None).await;
    assert!(matches!(
        outcome,
        ClaudeCreateOutcome::Failed { ref code, .. } if code == "LEDGER_WRITE_FAILED"
    ));
    assert!(
        matches!(
            registry.observe(PROVIDER, &session_id).state,
            freshell_ownership::OwnershipState::Starting { .. }
        ),
        "a failed map-hit bind leaves its existing writer fenced Starting"
    );
    assert!(
        matches!(
            registry.begin_handoff(
                PROVIDER,
                &session_id,
                freshell_ownership::RuntimeOwnerKind::Terminal,
                "handoff-after-claude-map-hit-write-failure",
                None,
                "test",
                freshell_ownership::now_epoch_ms(),
            ),
            freshell_ownership::BeginOutcome::Blocked { .. }
        ),
        "a failed identity write cannot admit a terminal second writer"
    );
    let reply = await_claude_created(&mut rx, "vacant-map-hit-failure-adopt").await;
    assert_eq!(reply["type"], "freshAgent.create.failed", "{reply}");
    assert!(identity.bindings.lock().unwrap().is_empty());
    identity.set_fail_writes(false);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if matches!(
                registry.observe(PROVIDER, &session_id).state,
                freshell_ownership::OwnershipState::Live { .. }
            ) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the retained exact map-hit claim retries persistence and becomes Live");
    assert!(
        identity.repairs.lock().unwrap().is_empty(),
        "a recoverable map-hit write must not tombstone the operation being retried"
    );
    state.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_adoption_without_a_current_exact_stamp_refuses_without_writing() {
    let _env_lock = CLAUDE_ENV_LOCK.lock().await;
    let env = FakeClaudeSidecarEnv::install();
    let (mut state, mut rx) = state_with_bus();
    let identity = Arc::new(crate::identity_sink::FakeIdentitySink::default());
    state.set_identity_sink(identity.clone());
    state.set_ownership(Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new()));

    state
        .handle_create(dedup_create_msg("missing-stamp-owner"), None)
        .await;
    let created = await_claude_created(&mut rx, "missing-stamp-owner").await;
    let session_id = created["sessionId"].as_str().unwrap().to_string();
    let stamp = crate::ownership_lane::take_retained_stamp(&state.ownership_stamps, &session_id)
        .expect("the established runtime retains its exact coordinator stamp");
    identity.bindings.lock().unwrap().clear();

    let mut missing = dedup_create_msg("missing-stamp-adoption");
    missing.resume_session_id = Some(session_id.clone());
    missing.session_ref = Some(claude_session_ref(&session_id));
    let missing_outcome = state.handle_create(missing, None).await;
    let missing_reply = await_claude_created(&mut rx, "missing-stamp-adoption").await;
    let missing_refused = matches!(
        missing_outcome,
        ClaudeCreateOutcome::Failed { ref code, .. } if code == "LEDGER_WRITE_FAILED"
    ) && missing_reply["type"] == "freshAgent.create.failed";

    let mut stale_stamp = stamp.clone();
    stale_stamp.generation += 1;
    crate::ownership_lane::restore_retained_stamp(
        &state.ownership_stamps,
        &session_id,
        stale_stamp,
    );
    let mut stale = dedup_create_msg("stale-stamp-adoption");
    stale.resume_session_id = Some(session_id.clone());
    stale.session_ref = Some(claude_session_ref(&session_id));
    let stale_outcome = state.handle_create(stale, None).await;
    let stale_reply = await_claude_created(&mut rx, "stale-stamp-adoption").await;
    let stale_refused = matches!(
        stale_outcome,
        ClaudeCreateOutcome::Failed { ref code, .. } if code == "LEDGER_WRITE_FAILED"
    ) && stale_reply["type"] == "freshAgent.create.failed";

    // Restore the exact live stamp so teardown can release the original
    // coordinator claim under its real fence.
    crate::ownership_lane::restore_retained_stamp(&state.ownership_stamps, &session_id, stamp);
    assert!(
        missing_refused,
        "an absent live-owner stamp must fail closed"
    );
    assert!(stale_refused, "a stale live-owner stamp must fail closed");
    assert!(
        identity.bindings.lock().unwrap().is_empty(),
        "refused adoptions must not issue unfenced identity writes"
    );
    assert_eq!(
        env.spawn_count(),
        1,
        "adoption must not start another sidecar"
    );
    state.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_binding_write_failure_never_publishes_created_or_commits_live() {
    let _env_lock = CLAUDE_ENV_LOCK.lock().await;
    let env = FakeClaudeSidecarEnv::install_with_knobs(Some(1500), false);
    let (mut state, mut rx) = state_with_bus();
    let identity = Arc::new(crate::identity_sink::FakeIdentitySink::default());
    state.set_identity_sink(identity.clone());
    state.set_ownership(Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new()));
    let task = {
        let state = state.clone();
        tokio::spawn(async move {
            state
                .handle_create(dedup_create_msg("failed-create-binding"), None)
                .await
        })
    };
    let line = env.create_request().await;
    let id = line["sessionId"].as_str().unwrap();
    let gate = identity.arm_post_commit_stall(PROVIDER, id);
    gate.applied.recv_timeout(Duration::from_secs(10)).unwrap();
    identity.set_fail_writes(true);
    gate.release.send(()).unwrap();
    let outcome = task.await.unwrap();
    assert!(
        matches!(outcome, ClaudeCreateOutcome::Failed { ref code, .. } if code == "LEDGER_WRITE_FAILED"),
        "{outcome:?}"
    );
    assert!(!state.sessions.lock().await.contains_key(id));
    assert!(!matches!(
        state.ownership_snapshot(PROVIDER, id).state,
        freshell_ownership::OwnershipState::Live { .. }
    ));
    while let Ok(raw) = rx.try_recv() {
        assert_ne!(
            serde_json::from_str::<Value>(&raw).unwrap()["type"],
            "freshAgent.created"
        );
    }
    assert!(identity.bindings.lock().unwrap().is_empty());
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_confirmed_late_teardown_releases_the_lease_without_an_ownership_registry() {
    let _env_lock = CLAUDE_ENV_LOCK.lock().await;
    let _env = FakeClaudeSidecarEnv::install();
    let (mut state, mut rx) = state_with_bus();
    state.set_handoff_confirm_rounds_for_test(Some(1));
    state.set_identity_sink(Arc::new(crate::identity_sink::FakeIdentitySink::default()));
    state
        .handle_create(dedup_create_msg("unwired-lease-create"), None)
        .await;
    let created = await_claude_created(&mut rx, "unwired-lease-create").await;
    let id = created["sessionId"].as_str().unwrap().to_string();
    let ownership_id = state.sessions.lock().await[&id].ownership_id.clone();
    let (mut descendant, _ready) = spawn_term_immune_tagged_child(&ownership_id).await;
    state.handle_kill(kill_msg(&id)).await;
    assert!(!state.sessions.lock().await.contains_key(&id));
    tokio::time::timeout(Duration::from_secs(15), descendant.wait())
        .await
        .expect("the late teardown confirms the descendant died")
        .unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let mut reopen = dedup_create_msg("unwired-lease-reopen");
        reopen.resume_session_id = Some(id.clone());
        let outcome = state.handle_create(reopen, None).await;
        match outcome {
            ClaudeCreateOutcome::Created { .. } => {
                assert!(
                    state.sessions.lock().await.contains_key(&id),
                    "reopen must establish a runtime, never acknowledge a stale lease binding"
                );
                break;
            }
            ClaudeCreateOutcome::Failed { code, .. } => {
                assert_eq!(code, "SESSION_RESERVED");
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "confirmed cleanup never released its completed lease"
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
    }
    state.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn canceled_map_hit_public_create_keeps_the_incumbent_fenced_before_lookup() {
    let _env_lock = CLAUDE_ENV_LOCK.lock().await;
    let _env = FakeClaudeSidecarEnv::install();
    let (mut state, mut rx) = state_with_bus();
    let sink = Arc::new(crate::identity_sink::FakeIdentitySink::default());
    state.set_identity_sink(sink.clone());
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    state.set_ownership(registry.clone());
    for session_type in ["claude", "kilroy"] {
        let mut msg = dedup_create_msg(&format!("outer-lookup-owner-{session_type}"));
        msg.session_type = if session_type == "kilroy" {
            SessionType::Kilroy
        } else {
            SessionType::Freshclaude
        };
        state.handle_create(msg.clone(), None).await;
        let created = await_claude_created(&mut rx, &msg.request_id).await;
        let id = created["sessionId"].as_str().unwrap().to_string();
        vacate_claude_owner_for_map_hit(&registry, &id);
        let held = state.sessions.lock().await;
        let incumbent = held[&id].ownership_id.clone();
        let pid = held[&id].child.id().unwrap();
        msg.request_id = format!("outer-lookup-adopt-{session_type}");
        msg.resume_session_id = Some(id.clone());
        let mut request = Box::pin(state.handle_create(msg, None));
        assert!(futures_util::poll!(&mut request).is_pending());
        assert!(matches!(
            registry.observe(PROVIDER, &id).state,
            freshell_ownership::OwnershipState::Starting { .. }
        ));
        drop(request);
        let fenced = matches!(
            registry.observe(PROVIDER, &id).state,
            freshell_ownership::OwnershipState::Starting { .. }
        );
        assert!(!crate::ownership_lane::partial_pid_confirmed_dead(pid));
        drop(held);
        if !fenced {
            state.shutdown().await;
            panic!("public create cancellation released ownership over its living {session_type} incumbent");
        }
        tokio::time::timeout(Duration::from_secs(10), async {
            while !matches!(
                registry.observe(PROVIDER, &id).state,
                freshell_ownership::OwnershipState::Live { .. }
            ) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the protected first lookup adopts the exact incumbent");
        assert_eq!(state.sessions.lock().await[&id].ownership_id, incumbent);
    }
    assert!(sink.repairs.lock().unwrap().is_empty());
    state.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn registered_startup_claude_settles_before_repair_on_cancel_and_failure() {
    let _env_lock = CLAUDE_ENV_LOCK.lock().await;
    for cancel in [true, false] {
        let env = FakeClaudeSidecarEnv::install_with_knobs(Some(1500), false);
        let (mut state, _rx) = state_with_bus();
        let sink = Arc::new(crate::identity_sink::FakeIdentitySink::default());
        state.set_identity_sink(sink.clone());
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        state.set_ownership(registry.clone());
        let msg = dedup_create_msg("registered-startup-cleanup");
        let st = state.clone();
        let task = tokio::spawn(async move { st.handle_create(msg, None).await });
        let request = env.create_request().await;
        let id = request["sessionId"].as_str().unwrap().to_string();
        let stall = sink.arm_binding_stall_result(PROVIDER, &id, !cancel);
        stall.entered.recv_timeout(Duration::from_secs(15)).unwrap();
        let held = state.sessions.lock().await;
        let pid = held[&id].child.id().unwrap();
        assert!(!crate::ownership_lane::partial_pid_confirmed_dead(pid));
        if cancel {
            task.abort();
        }
        let _ = stall.release.send(());
        tokio::time::sleep(Duration::from_millis(100)).await;
        let fenced = matches!(
            registry.observe(PROVIDER, &id).state,
            freshell_ownership::OwnershipState::Starting { .. }
        );
        let unrepaired = sink.repairs.lock().unwrap().is_empty();
        drop(held);
        if !fenced || !unrepaired {
            state.shutdown().await;
            panic!("cancel={cancel}: repair released a still-registered native runtime");
        }
        if cancel {
            assert!(task.await.unwrap_err().is_cancelled());
        } else {
            assert!(matches!(
                task.await.unwrap(),
                ClaudeCreateOutcome::Failed { .. }
            ));
        }
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let vacant = matches!(
                    registry.observe(PROVIDER, &id).state,
                    freshell_ownership::OwnershipState::Vacant
                );
                let dead = crate::ownership_lane::partial_pid_confirmed_dead(pid);
                assert!(!vacant || dead);
                if vacant {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(!state.sessions.lock().await.contains_key(&id));
        assert_eq!(sink.repairs.lock().unwrap().len(), 1);
        state.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn registered_startup_claude_preserves_replacement_on_cancel_and_failure() {
    let _env_lock = CLAUDE_ENV_LOCK.lock().await;
    for cancel in [true, false] {
        let env = FakeClaudeSidecarEnv::install_with_knobs(Some(500), false);
        let (mut state, _rx) = state_with_bus();
        let sink = Arc::new(crate::identity_sink::FakeIdentitySink::default());
        state.set_identity_sink(sink.clone());
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        state.set_ownership(registry.clone());
        let task = {
            let st = state.clone();
            tokio::spawn(async move {
                st.handle_create(dedup_create_msg("old-startup"), None)
                    .await
            })
        };
        let request = env.create_request().await;
        let id = request["sessionId"].as_str().unwrap().to_string();
        let stall = sink.arm_binding_stall_result(PROVIDER, &id, !cancel);
        stall.entered.recv_timeout(Duration::from_secs(15)).unwrap();
        let old = state.sessions.lock().await.remove(&id).unwrap();
        let old_pid = old.child.id().unwrap();
        let old_claim = sink
            .bindings
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .claim
            .clone()
            .unwrap();
        let ClaudeCreateOutcome::Created {
            session_id: replacement_key,
            ..
        } = state
            .handle_create(dedup_create_msg("replacement-startup"), None)
            .await
        else {
            panic!("replacement startup succeeds")
        };
        let replacement = state
            .sessions
            .lock()
            .await
            .remove(&replacement_key)
            .unwrap();
        let replacement_id = replacement.ownership_id.clone();
        let replacement_pid = replacement.child.id().unwrap();
        state.sessions.lock().await.insert(id.clone(), replacement);
        registry.fail(
            PROVIDER,
            &id,
            &old_claim.operation_id,
            old_claim.generation,
            false,
        );
        let crate::ownership_lane::LaneClaim::Granted(ticket) =
            state.begin_lane_claim_at(&id, "replacement-owner", None, "test")
        else {
            panic!("replacement claim")
        };
        state
            .commit_lane_claim_at(&mut Some(ticket), &id, Some(replacement_pid))
            .unwrap();
        let owner = registry.observe(PROVIDER, &id);
        if cancel {
            task.abort();
        }
        let _ = stall.release.send(());
        if cancel {
            assert!(task.await.unwrap_err().is_cancelled());
        } else {
            assert!(matches!(
                task.await.unwrap(),
                ClaudeCreateOutcome::Failed { .. }
            ));
        }
        tokio::time::timeout(Duration::from_secs(10), async {
            while sink.repairs.lock().unwrap().is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(crate::ownership_lane::partial_pid_confirmed_dead(old_pid));
        assert!(!crate::ownership_lane::partial_pid_confirmed_dead(
            replacement_pid
        ));
        assert_eq!(
            state.sessions.lock().await[&id].ownership_id,
            replacement_id
        );
        assert_eq!(registry.observe(PROVIDER, &id), owner);
        let _ = state.teardown_removed_session_logged(old).await;
        state.shutdown().await;
    }
}

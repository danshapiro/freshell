use super::*;

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

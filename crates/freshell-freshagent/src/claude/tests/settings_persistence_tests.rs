use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_configure_receipt_after_reset_saves_the_same_runtime_under_its_current_uuid() {
    let (state, _rx) = state_with_bus();
    let identity = Arc::new(crate::identity_sink::FakeIdentitySink::default());
    state.set_identity_sink(identity.clone());
    let old = uuid::Uuid::new_v4().to_string();
    let new = uuid::Uuid::new_v4().to_string();
    insert_fake_claude_session(&state, &old).await;
    let pending = state.sessions.lock().await[&old].pending.clone();
    let turn_lock = state.sessions.lock().await[&old].turn_lock.clone();
    let task = {
        let state = state.clone();
        let old = old.clone();
        tokio::spawn(async move {
            let _turn = turn_lock.lock().await;
            state
                .configure_for_send(
                    &old,
                    &freshell_protocol::FreshAgentSendSettings {
                        model: Some("sonnet".into()),
                        cwd: None,
                        effort: None,
                        permission_mode: None,
                        sandbox: None,
                    },
                )
                .await
        })
    };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if state.sessions.lock().await[&old]
            .configuration
            .pending
            .is_some()
        {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "configure did not reach its control await"
        );
        tokio::task::yield_now().await;
    }
    state
        .rekey_conversation(&old, &new, "freshclaude", &pending, "test-control-await")
        .await
        .unwrap();
    let (_, reply) = state
        .sessions
        .lock()
        .await
        .get_mut(&new)
        .unwrap()
        .configuration
        .pending
        .take()
        .unwrap();
    reply.send(Ok(())).unwrap();
    let result = task.await.unwrap();
    let saved = identity
        .settings
        .lock()
        .unwrap()
        .get(&(PROVIDER.into(), new.clone()))
        .cloned();
    state.shutdown().await;
    assert!(result.is_ok(), "{result:?}");
    assert_eq!(saved.unwrap().model.as_deref(), Some("sonnet"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn settings_persistence_failure_preserves_the_runtime_and_unsent_prompt_for_retry() {
    let _env_lock = CLAUDE_ENV_LOCK.lock().await;
    let env = FakeClaudeSidecarEnv::install();
    let (mut state, _rx) = state_with_bus();
    let identity = Arc::new(crate::identity_sink::FakeIdentitySink::default());
    state.set_identity_sink(identity.clone());
    state.set_ownership(Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new()));
    let mut create = dedup_create_msg("settings-persist-retry-create");
    create.model = Some("opus".into());
    let ClaudeCreateOutcome::Created { session_id, .. } = state.handle_create(create, None).await
    else {
        panic!("a settings persistence fixture must create");
    };
    let owner = state.sessions.lock().await[&session_id]
        .ownership_id
        .clone();
    let observed = state.ownership_snapshot(PROVIDER, &session_id);
    let mut send = send_msg(&session_id, "keep this prompt until settings are saved");
    send.settings = Some(freshell_protocol::FreshAgentSendSettings {
        model: Some("sonnet".into()),
        cwd: None,
        effort: None,
        permission_mode: None,
        sandbox: None,
    });
    send.checkpoint_intent = Some(freshell_protocol::FreshAgentCheckpointIntent {
        logical_attempt_id: "settings-persist-checkpoint-attempt".into(),
        workspace: None,
    });
    send.observed_epoch = Some(observed.epoch);
    send.observed_generation = Some(observed.generation);
    identity.set_fail_writes(true);
    let refused = state.handle_send(send.clone()).await;
    let same_runtime = state
        .sessions
        .lock()
        .await
        .get(&session_id)
        .is_some_and(|session| {
            session.ownership_id == owner
                && session.configuration.settings.model.as_deref() == Some("sonnet")
        });
    identity.set_fail_writes(false);
    if !same_runtime || !matches!(refused, ClaudeSendOutcome::Refused { .. }) {
        state.shutdown().await;
        panic!("failed settings persistence must preserve the runtime and refuse its prompt: same_runtime={same_runtime}, outcome={refused:?}");
    }
    let initial = env.respond_log_frames(1).await;
    assert_eq!(
        initial.len(),
        1,
        "the first prompt was never sent: {initial:?}"
    );
    assert_eq!(initial[0]["type"], "configure");
    send.request_id = Some("settings-persist-retry-send".into());
    let accepted = state.handle_send(send).await;
    let recorded = env.respond_log_frames(3).await;
    let saved = identity
        .settings
        .lock()
        .unwrap()
        .get(&(PROVIDER.into(), session_id.clone()))
        .cloned();
    state.shutdown().await;
    assert!(
        matches!(accepted, ClaudeSendOutcome::Accepted { .. }),
        "{accepted:?}"
    );
    assert_eq!(saved.unwrap().model.as_deref(), Some("sonnet"));
    assert_eq!(
        recorded
            .iter()
            .filter(|frame| frame["type"] == "send")
            .count(),
        1
    );
}

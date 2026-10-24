use super::*;
use std::{future::Future, task::Poll};

#[tokio::test]
async fn an_enabled_resume_waiter_survives_fast_owner_completion() {
    let state = state();
    let owner = state.try_resume_flight("fast-resume").unwrap();
    let waiting = state.wait_resume_flight("fast-resume");
    tokio::pin!(waiting);
    std::future::poll_fn(|cx| {
        assert!(matches!(waiting.as_mut().poll(cx), Poll::Pending));
        Poll::Ready(())
    })
    .await;
    drop(owner);
    let next = tokio::time::timeout(Duration::from_secs(1), waiting)
        .await
        .expect("completion must wake the already-registered waiter");
    drop(next);
    assert!(!state.resuming.lock().unwrap().contains("fast-resume"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn canceling_a_resume_owner_wakes_its_enabled_waiter() {
    let state = state();
    let acquired = Arc::new(tokio::sync::Notify::new());
    let owner = {
        let state = state.clone();
        let acquired = acquired.clone();
        tokio::spawn(async move {
            let _flight = state.wait_resume_flight("canceled-resume").await;
            acquired.notify_one();
            std::future::pending::<()>().await;
        })
    };
    acquired.notified().await;
    let waiting = state.wait_resume_flight("canceled-resume");
    tokio::pin!(waiting);
    std::future::poll_fn(|cx| {
        assert!(matches!(waiting.as_mut().poll(cx), Poll::Pending));
        Poll::Ready(())
    })
    .await;
    owner.abort();
    assert!(owner.await.unwrap_err().is_cancelled());
    let next = tokio::time::timeout(Duration::from_secs(1), waiting)
        .await
        .expect("RAII cancellation must remove the flight before waking its waiter");
    drop(next);
    assert!(!state.resuming.lock().unwrap().contains("canceled-resume"));
}

#[tokio::test]
async fn a_configure_receipt_from_a_replaced_runtime_cannot_change_its_replacement() {
    let (state, _rx) = state_with_bus();
    let id = uuid::Uuid::new_v4().to_string();
    insert_fake_claude_session(&state, &id).await;
    let turn_lock = state.sessions.lock().await[&id].turn_lock.clone();
    let configuring = {
        let state = state.clone();
        let id = id.clone();
        let turn_lock = turn_lock.clone();
        tokio::spawn(async move {
            let _turn = turn_lock.lock().await;
            state
                .configure_for_send(
                    &id,
                    &freshell_protocol::FreshAgentSendSettings {
                        model: Some("old-runtime-model".into()),
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
    let old_reply = loop {
        if let Some((_, reply)) = state
            .sessions
            .lock()
            .await
            .get_mut(&id)
            .unwrap()
            .configuration
            .pending
            .take()
        {
            break reply;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "configure never reached its RPC wait"
        );
        tokio::task::yield_now().await;
    };
    let removed = state.sessions.lock().await.remove(&id).unwrap();
    insert_fake_claude_session(&state, &id).await;
    {
        let mut sessions = state.sessions.lock().await;
        let replacement = sessions.get_mut(&id).unwrap();
        replacement.ownership_id = "replacement-runtime".into();
        replacement.turn_lock = turn_lock;
        replacement.configuration.settings.model = Some("replacement-model".into());
    }
    old_reply.send(Ok(())).unwrap();
    let outcome = configuring.await.unwrap();
    assert!(
        outcome.is_err(),
        "an obsolete receipt must not acknowledge a replacement's settings"
    );
    assert_eq!(
        state.sessions.lock().await[&id]
            .configuration
            .settings
            .model
            .as_deref(),
        Some("replacement-model")
    );
    let _ = state.teardown_removed_session_logged(removed).await;
    state.shutdown().await;
}

#[tokio::test]
async fn an_observed_hosted_transcript_cannot_fall_back_to_fresh_after_it_is_removed() {
    let _guard = CLAUDE_ENV_LOCK.lock().await;
    let env = FakeClaudeSidecarEnv::install();
    env.program(json!([{"kind":"text", "data":{"text":"transcript observed"}}]));
    let home = tempfile::tempdir().unwrap();
    let (st, mut rx) = state_with_bus();
    let mut environment: Vec<(String, String)> = std::env::vars().collect();
    environment.retain(|(key, _)| key != "CLAUDE_CONFIG_DIR");
    environment.push((
        "CLAUDE_CONFIG_DIR".into(),
        home.path().to_string_lossy().into(),
    ));
    let st = st.with_sidecar_environment(environment);
    st.handle_create(dedup_create_msg("hosted-observed-genesis"), None)
        .await;
    let created = await_claude_created(&mut rx, "hosted-observed-genesis").await;
    let id = created["sessionId"].as_str().unwrap().to_string();
    assert!(st.sessions.lock().await[&id].launch_genesis.is_some());
    write_fake_transcript(home.path(), &id);
    st.handle_send(send_msg(&id, "observe the saved transcript"))
        .await;
    await_frame_of_inner_type(&mut rx, "freshAgent.result").await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while st.sessions.lock().await[&id].launch_genesis.is_some() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "observing the transcript must retire the in-memory Fresh genesis too"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let pid = st.sessions.lock().await[&id].child.id().unwrap();
    // SAFETY: this process belongs to this test's isolated fake sidecar.
    assert_eq!(unsafe { libc::kill(pid as i32, libc::SIGKILL) }, 0);
    loop {
        let status = await_frame_of_inner_type(&mut rx, "freshAgent.status").await;
        if status["event"]["status"] == "exited" {
            break;
        }
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while st.resolve_session_key(&id).await.is_some() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the dead runtime was not removed"
        );
        tokio::task::yield_now().await;
    }
    // The real CLI wrote its own project directory in addition to the seeded
    // file. Once its writer is confirmed stopped, remove every copy of this id.
    let mut moved = 0;
    for project in std::fs::read_dir(home.path().join("projects")).unwrap() {
        let transcript = project.unwrap().path().join(format!("{id}.jsonl"));
        if transcript.is_file() {
            std::fs::rename(&transcript, transcript.with_extension("saved")).unwrap();
            moved += 1;
        }
    }
    assert!(
        moved >= 1,
        "the observed transcript was present before removal"
    );
    assert!(matches!(
        st.ensure_runtime(&id, SessionType::Freshclaude, None, None)
            .await,
        Err(recovery::RuntimeResumeError::Lost)
    ));
    assert_eq!(
        env.spawn_count(),
        1,
        "a conversed session is never recreated Fresh"
    );
    st.shutdown().await;
}

#[tokio::test]
async fn a_compact_with_an_obsolete_owner_fence_never_arms_or_writes_a_turn() {
    let (mut st, mut rx) = state_with_bus();
    st.set_ownership(Arc::new(
        freshell_ownership::RuntimeOwnershipRegistry::with_epoch(41),
    ));
    let id = uuid::Uuid::new_v4().to_string();
    insert_fake_claude_session(&st, &id).await;
    let mut msg = compact_msg(&id, None);
    msg.request_id = Some("stale-compact".into());
    msg.observed_epoch = Some(41);
    msg.observed_generation = Some(7);
    st.handle_compact(msg).await;
    let frame: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
    assert_eq!(frame["event"]["code"], "SESSION_RESERVED", "{frame}");
    assert_eq!(frame["event"]["requestId"], "stale-compact");
    assert!(!st.sessions.lock().await[&id].ledger.lock().unwrap().busy());
    st.shutdown().await;
}

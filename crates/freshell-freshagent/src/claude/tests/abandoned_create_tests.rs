use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn abandoned_create_cannot_close_a_replacement_with_the_same_session_id() {
    let (mut state, _rx) = state_with_bus();
    let sink = Arc::new(crate::identity_sink::FakeIdentitySink::default());
    state.set_identity_sink(sink.clone());
    let id = uuid::Uuid::new_v4().to_string();
    insert_fake_claude_session(&state, &id).await;
    let owner = state.sessions.lock().await[&id].ownership_id.clone();
    let pause = Arc::new(AdoptionTestPause {
        reached: std::sync::atomic::AtomicBool::new(false),
        notify: tokio::sync::Notify::new(),
    });
    state.kill_after_resolve_pause = Some(pause.clone());
    let task = {
        let state = state.clone();
        let id = id.clone();
        tokio::spawn(async move {
            state
                .abandon_created_runtime(&id, SessionType::Freshclaude, &owner)
                .await;
        })
    };
    tokio::time::timeout(Duration::from_secs(5), async {
        while !pause.reached.load(std::sync::atomic::Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let old = state.sessions.lock().await.remove(&id).unwrap();
    insert_fake_claude_session(&state, &id).await;
    state
        .sessions
        .lock()
        .await
        .get_mut(&id)
        .unwrap()
        .ownership_id = "replacement".into();
    pause.notify.notify_one();
    task.await.unwrap();
    let replacement_alive = state
        .sessions
        .lock()
        .await
        .get_mut(&id)
        .is_some_and(|session| {
            session.ownership_id == "replacement" && session.child.try_wait().unwrap().is_none()
        });
    let retired = sink.retires.lock().unwrap().clone();
    state.teardown_removed_session_logged(old).await;
    state.shutdown().await;
    assert!(
        replacement_alive,
        "a stale create receipt must leave the replacement alive"
    );
    assert!(
        retired.is_empty(),
        "a stale receipt must not close durable rows: {retired:?}"
    );
}

#[tokio::test]
async fn abandoned_create_closes_only_its_allocated_runtime() {
    let (state, _rx) = state_with_bus();
    let id = uuid::Uuid::new_v4().to_string();
    insert_fake_claude_session(&state, &id).await;
    let owner = state.sessions.lock().await[&id].ownership_id.clone();
    state
        .abandon_created_runtime(&id, SessionType::Freshclaude, &owner)
        .await;
    assert!(!state.sessions.lock().await.contains_key(&id));
}

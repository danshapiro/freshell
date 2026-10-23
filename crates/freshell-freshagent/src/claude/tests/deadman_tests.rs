use super::*;

async fn clock_forward(ms: u64) {
    tokio::time::advance(Duration::from_millis(ms)).await;
    // Let a due waiter validate its runtime and publish before reading the bus.
    tokio::task::yield_now().await;
    tokio::task::yield_now().await;
}

#[tokio::test(start_paused = true)]
async fn tool_heartbeats_feed_only_below_the_effective_cap_and_never_clear_stuck_above_it() {
    let configurations = [
        (vec![], 720_000),
        (vec![("BASH_MAX_TIMEOUT_MS", "300")], 120_300),
        (
            vec![
                ("BASH_MAX_TIMEOUT_MS", "0"),
                ("FRESHELL_FRESHCLAUDE_TOOL_HEARTBEAT_CAP_MS", "0"),
            ],
            720_000,
        ),
        (
            vec![
                ("BASH_MAX_TIMEOUT_MS", "300"),
                ("FRESHELL_FRESHCLAUDE_TOOL_HEARTBEAT_CAP_MS", "200"),
            ],
            200,
        ),
    ];
    for (settings, cap) in configurations {
        let (st, mut rx) = state_with_bus();
        let mut env: Vec<(String, String)> = settings
            .into_iter()
            .map(|(key, value)| (key.into(), value.into()))
            .collect();
        env.push(("FRESHELL_FRESHCLAUDE_QUIET_WINDOW_MS".into(), "100".into()));
        let st = st.with_sidecar_environment(env);
        let id = uuid::Uuid::new_v4().to_string();
        insert_fake_claude_session(&st, &id).await;
        let owner = {
            let sessions = st.sessions.lock().await;
            let session = &sessions[&id];
            session.ledger.lock().unwrap().arm(
                "running".into(),
                None,
                crate::claude_turns::SendKind::Turn,
            );
            session.ownership_id.clone()
        };
        st.note_claude_stdout(&id, &owner, None).await;
        clock_forward(90).await;
        st.note_claude_stdout(
            &id,
            &owner,
            Some(&json!({"type":"sdk.heartbeat", "kind":"tool", "elapsedMs":cap - 1})),
        )
        .await;
        clock_forward(90).await;
        assert_ne!(st.live_snapshot_overlay(&id).await["status"], "stuck");
        st.note_claude_stdout(
            &id,
            &owner,
            Some(&json!({"type":"sdk.heartbeat", "kind":"tool", "elapsedMs":cap})),
        )
        .await;
        clock_forward(15).await;
        assert_eq!(st.live_snapshot_overlay(&id).await["status"], "stuck");
        st.note_claude_stdout(
            &id,
            &owner,
            Some(&json!({"type":"sdk.heartbeat", "kind":"tool", "elapsedMs":cap + 1})),
        )
        .await;
        assert_eq!(
            st.live_snapshot_overlay(&id).await["status"],
            "stuck",
            "an expired tool heartbeat is not renewed progress"
        );
        let first: Vec<Value> = std::iter::from_fn(|| rx.try_recv().ok())
            .map(|raw| serde_json::from_str(&raw).unwrap())
            .collect();
        assert_eq!(
            first
                .iter()
                .filter(|frame| frame["event"]["type"] == "freshAgent.turn.complete")
                .count(),
            1
        );
        for kind in ["retry", "task"] {
            st.note_claude_stdout(
                &id,
                &owner,
                Some(&json!({"type":"sdk.heartbeat", "kind":kind, "elapsedMs":cap + 1})),
            )
            .await;
            assert_eq!(st.live_snapshot_overlay(&id).await["status"], "running");
            clock_forward(90).await;
            assert_ne!(st.live_snapshot_overlay(&id).await["status"], "stuck");
        }
        clock_forward(15).await;
        assert_eq!(st.live_snapshot_overlay(&id).await["status"], "stuck");
        // Even a non-JSON stdout line is liveness, unlike an expired tool heartbeat.
        st.note_claude_stdout(&id, &owner, None).await;
        assert_eq!(st.live_snapshot_overlay(&id).await["status"], "running");
        tokio::time::resume();
        st.shutdown().await;
        tokio::time::pause();
    }
}

#[tokio::test(start_paused = true)]
async fn an_old_quiet_waiter_never_flags_a_replacement_runtime_with_the_same_session_id() {
    let (st, mut rx) = state_with_bus();
    let st = st
        .with_sidecar_environment([("FRESHELL_FRESHCLAUDE_QUIET_WINDOW_MS".into(), "100".into())]);
    let id = uuid::Uuid::new_v4().to_string();
    insert_fake_claude_session(&st, &id).await;
    let owner = {
        let sessions = st.sessions.lock().await;
        let session = &sessions[&id];
        session.ledger.lock().unwrap().arm(
            "old-turn".into(),
            None,
            crate::claude_turns::SendKind::Turn,
        );
        session.ownership_id.clone()
    };
    st.note_claude_stdout(&id, &owner, None).await;
    let removed = st.sessions.lock().await.remove(&id).unwrap();
    insert_fake_claude_session(&st, &id).await;
    st.sessions.lock().await.get_mut(&id).unwrap().ownership_id = "replacement-runtime".into();
    clock_forward(150).await;
    assert!(
        removed.quiet.state.lock().unwrap().is_stuck(),
        "the obsolete waiter's deadline actually fired"
    );
    assert_eq!(st.live_snapshot_overlay(&id).await["status"], "idle");
    assert!(
        rx.try_recv().is_err(),
        "an old timeout published into the new runtime"
    );
    tokio::time::resume();
    st.teardown_removed_session_logged(removed).await;
    st.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn an_idle_runtime_never_arms_a_quiet_timeout() {
    let (st, mut rx) = state_with_bus();
    let st = st
        .with_sidecar_environment([("FRESHELL_FRESHCLAUDE_QUIET_WINDOW_MS".into(), "100".into())]);
    let id = uuid::Uuid::new_v4().to_string();
    insert_fake_claude_session(&st, &id).await;
    let owner = st.sessions.lock().await[&id].ownership_id.clone();
    st.note_claude_stdout(&id, &owner, None).await;
    clock_forward(1_000).await;
    assert_eq!(st.live_snapshot_overlay(&id).await["status"], "idle");
    assert!(rx.try_recv().is_err());
    tokio::time::resume();
    st.shutdown().await;
}

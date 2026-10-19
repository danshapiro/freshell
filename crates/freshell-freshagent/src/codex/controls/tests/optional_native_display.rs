use super::*;

#[tokio::test]
async fn live_codex_known_small_display_keeps_complete_native_snapshot() {
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir(home.path().join("sessions")).unwrap();
    std::fs::write(
        home.path().join("sessions/rollout-thread-1.jsonl"),
        "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-1\"}}\n",
    )
    .unwrap();
    let (state, peer, _) = runtime_with_native_home(home.path()).await;
    let query = tokio::spawn({
        let state = state.clone();
        async move { state.get_snapshot("thread-1", None).await }
    });
    let (id, method, params) = peer.expect_request().await;
    assert_eq!(method, "thread/read");
    let includes_complete_history = params["includeTurns"] == true;
    if includes_complete_history {
        peer.respond(&id, json!({"thread":{"id":"thread-1","status":{"type":"idle"},"turns":[
            {"id":"turn-1","items":[{"id":"answer-1","type":"agentMessage","text":"First saved answer"}]},
            {"id":"turn-2","items":[{"id":"answer-2","type":"agentMessage","text":"Newest saved answer"}]}
        ]}}));
    } else {
        peer.respond_error(
            &id,
            -32603,
            "small-history fixture requires the complete native read",
        );
    }
    let result = query.await.unwrap();
    peer.disconnect();
    state.shutdown().await;
    assert!(
        includes_complete_history,
        "known small history keeps the ordinary complete snapshot"
    );
    let snapshot = result.unwrap();
    let turns = snapshot["turns"].as_array().unwrap();
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[0]["items"][0]["text"], "First saved answer");
    assert_eq!(turns[1]["items"][0]["text"], "Newest saved answer");
    assert_ne!(
        snapshot["extensions"]["codex"]["nativeHistoryRetention"]["partial"],
        true
    );
}

#[tokio::test]
async fn live_codex_native_controls_survive_older_display_worker_failure() {
    const CHILD: &str = "FRESHELL_CODEX_OLDER_DISPLAY_FAILURE_CHILD";
    if std::env::var(CHILD).as_deref() != Ok("1") {
        // Only this isolated test process has a managed reader identity. Other
        // tests cannot observe or race these environment variables.
        let uid = if unsafe { libc::geteuid() } == 0 {
            1000
        } else {
            65534
        };
        let output = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "codex::controls::tests::optional_native_display::live_codex_native_controls_survive_older_display_worker_failure",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .env("FRESHELL_PROVIDER_RUN_AS_UID", uid.to_string())
            .env("FRESHELL_PROVIDER_RUN_AS_GID", uid.to_string())
            .output()
            .await
            .unwrap();
        assert!(
            output.status.success(),
            "isolated native display failure fixture failed: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }

    let home = tempfile::tempdir().unwrap();
    let sessions = home.path().join("sessions");
    std::fs::create_dir(&sessions).unwrap();
    let rows = [
        json!({"type":"session_meta","payload":{"id":"thread-1"}}),
        json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"saved history ".repeat(400_000)}]}}),
    ];
    std::fs::write(
        sessions.join("rollout-thread-1.jsonl"),
        rows.iter()
            .map(|row| format!("{row}\n"))
            .collect::<String>(),
    )
    .unwrap();

    // This test executable deliberately has no production worker CLI. The real
    // provider-UID worker process therefore exits unsuccessfully, exercising the
    // same optional-display failure returned by a reader that cannot run/read.
    let (state, peer, mut events) = runtime_with_native_home(home.path()).await;
    peer.request_client(
        &RequestId::Int(89),
        "item/commandExecution/requestApproval",
        json!({"threadId":"thread-1","turnId":"active-turn","itemId":"live-command","command":"pwd"}),
    );
    let pending = event(&mut events).await;
    event(&mut events).await;

    let mut query = tokio::spawn({
        let state = state.clone();
        async move { state.get_snapshot("thread-1", None).await }
    });
    let snapshot = tokio::select! {
        result = &mut query => result.unwrap(),
        request = peer.expect_request() => {
            let (id, method, params) = request;
            assert_eq!(method, "thread/read");
            assert_eq!(params["includeTurns"], false);
            peer.respond(&id, json!({"thread":{"id":"thread-1","status":{"type":"active"},"turns":[]}}));
            let (id, method, params) = peer.expect_request().await;
            assert_eq!(method, "thread/turns/list");
            assert_eq!(params["itemsView"], "full");
            peer.respond(&id, json!({"data":[{"id":"active-turn","status":"inProgress","itemsView":"full","items":[{"id":"native-answer","type":"agentMessage","text":"Current output survives unavailable older display"}]}],"nextCursor":null,"backwardsCursor":null}));
            query.await.unwrap()
        }
    };
    let native_reply = if snapshot.is_ok() {
        state
            .handle_approval_respond(
                serde_json::from_value(json!({
                    "provider":"codex","sessionType":"freshcodex","sessionId":"thread-1",
                    "requestId":pending["requestId"],"decision":{"behavior":"allow"}
                }))
                .unwrap(),
            )
            .await;
        peer.next_raw_frame().await
    } else {
        None
    };
    peer.disconnect();
    state.shutdown().await;

    let snapshot =
        snapshot.expect("unavailable older display must preserve the same-root live owner");
    assert_eq!(snapshot["threadId"], "thread-1");
    assert_eq!(snapshot["status"], "running");
    assert_eq!(snapshot["capabilities"]["interrupt"], true);
    assert_eq!(
        snapshot["pendingApprovals"][0]["requestId"],
        pending["requestId"]
    );
    assert_eq!(
        snapshot["turns"][0]["items"][0]["text"],
        "Current output survives unavailable older display"
    );
    assert_eq!(
        native_reply,
        Some(json!({"id":89,"result":{"decision":"accept"}}))
    );
    assert_ne!(snapshot["extensions"]["codex"]["ownerKind"], "vacant");
    assert_eq!(
        snapshot["extensions"]["codex"]["nativeHistoryRetention"]["partial"],
        true
    );
    assert_eq!(
        snapshot["extensions"]["codex"]["nativeHistoryRetention"]["olderHistoryUnavailable"],
        true
    );
}

#[tokio::test]
async fn live_codex_native_controls_survive_absent_older_display() {
    assert_absent_older_display(false).await;
}

#[tokio::test]
async fn live_codex_empty_native_thread_survives_absent_older_display() {
    assert_absent_older_display(true).await;
}

async fn assert_absent_older_display(native_turn_not_materialized: bool) {
    let home = tempfile::tempdir().unwrap();
    let (state, peer, mut events) = runtime_with_native_home(home.path()).await;
    peer.request_client(
        &RequestId::Int(89),
        "item/commandExecution/requestApproval",
        json!({"threadId":"thread-1","turnId":"active-turn","itemId":"live-command","command":"pwd"}),
    );
    let pending = event(&mut events).await;
    event(&mut events).await;
    let query = tokio::spawn({
        let state = state.clone();
        async move { state.get_snapshot("thread-1", None).await }
    });
    let (id, method, params) = peer.expect_request().await;
    assert_eq!(method, "thread/read");
    let requested_accumulated_history = params["includeTurns"] != false;
    if requested_accumulated_history {
        peer.respond_error(
            &id,
            -32603,
            "guarded native API: cached accumulated history exceeds transport limit",
        );
    } else {
        peer.respond(
            &id,
            json!({"thread":{"id":"thread-1","status":{"type":"active"},"turns":[]}}),
        );
        let (id, method, params) = peer.expect_request().await;
        assert_eq!(method, "thread/turns/list");
        assert_eq!(params["limit"], 1);
        assert_eq!(params["itemsView"], "full");
        if native_turn_not_materialized {
            peer.respond_error(&id, -32601, "list_turns is not supported yet");
        } else {
            peer.respond(
                &id,
                json!({"data":[{
                    "id":"active-turn","status":"inProgress","itemsView":"full",
                    "items":[{"id":"native-answer","type":"agentMessage",
                        "text":"Current output survives absent older history"}]
                }],"nextCursor":null,"backwardsCursor":null}),
            );
        }
    }
    let snapshot = query.await.unwrap();
    let native_reply = if snapshot.is_ok() {
        state
            .handle_approval_respond(
                serde_json::from_value(json!({
                    "provider":"codex","sessionType":"freshcodex","sessionId":"thread-1",
                    "requestId":pending["requestId"],"decision":{"behavior":"allow"}
                }))
                .unwrap(),
            )
            .await;
        peer.next_raw_frame().await
    } else {
        None
    };
    peer.disconnect();
    state.shutdown().await;

    assert!(
        !requested_accumulated_history,
        "missing optional disk history must not trigger an accumulated native-history read"
    );
    let snapshot =
        snapshot.expect("a loaded native thread remains usable without older disk display");
    assert_eq!(snapshot["threadId"], "thread-1");
    assert_eq!(snapshot["status"], "running");
    assert_eq!(snapshot["capabilities"]["interrupt"], true);
    assert_eq!(
        snapshot["pendingApprovals"][0]["requestId"],
        pending["requestId"]
    );
    let turns = snapshot["turns"].as_array().unwrap();
    if native_turn_not_materialized {
        assert!(turns.is_empty());
    } else {
        assert_eq!(
            turns[0]["items"][0]["text"],
            "Current output survives absent older history"
        );
    }
    assert_ne!(snapshot["extensions"]["codex"]["ownerKind"], "vacant");
    if native_turn_not_materialized {
        assert_ne!(
            snapshot["extensions"]["codex"]["nativeHistoryRetention"]["partial"], true,
            "a brand-new native thread has no omitted conversation"
        );
    } else {
        assert_eq!(
            snapshot["extensions"]["codex"]["nativeHistoryRetention"]["partial"],
            true
        );
        assert_eq!(
            snapshot["extensions"]["codex"]["nativeHistoryRetention"]["olderHistoryUnavailable"],
            true
        );
    }
    assert_eq!(
        native_reply,
        Some(json!({"id":89,"result":{"decision":"accept"}}))
    );
}

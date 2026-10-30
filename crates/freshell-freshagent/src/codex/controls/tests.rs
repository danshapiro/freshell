use super::*;
use crate::codex::tests::{insert_fake_session_with_real_consumer, spawn_sleeper, state_with_bus};
use freshell_codex::ChannelPeer;

#[cfg(unix)]
mod optional_native_display;

async fn runtime() -> (
    FreshCodexState,
    ChannelPeer,
    tokio::sync::broadcast::Receiver<String>,
) {
    let (transport, peer) = freshell_codex::new_channel_transport();
    let (client, notifications) = CodexAppServerClient::connect(transport);
    let (state, rx) = state_with_bus();
    insert_fake_session_with_real_consumer(
        &state,
        "thread-1",
        Arc::new(client),
        Arc::new(StdMutex::new(Some("turn-1".into()))),
        notifications,
        spawn_sleeper(),
        "codex-controls-fixture",
    )
    .await;
    (state, peer, rx)
}

async fn event(rx: &mut tokio::sync::broadcast::Receiver<String>) -> Value {
    let frame = tokio::time::timeout(Duration::from_secs(3), rx.recv())
        .await
        .expect("event timeout")
        .unwrap();
    serde_json::from_str::<Value>(&frame).unwrap()["event"].clone()
}

async fn snapshot(state: &FreshCodexState, peer: &ChannelPeer) -> Value {
    snapshot_with_turns(state, peer, json!([])).await
}

async fn snapshot_with_turns(state: &FreshCodexState, peer: &ChannelPeer, turns: Value) -> Value {
    let read = tokio::spawn({
        let state = state.clone();
        async move { state.get_snapshot("thread-1", None).await.unwrap() }
    });
    let (mut id, mut method, _) = peer.expect_request().await;
    if method == "initialize" {
        peer.respond(&id, json!({}));
        peer.expect_notification().await;
        (id, method, _) = peer.expect_request().await;
    }
    assert_eq!(method, "thread/read");
    peer.respond(
        &id,
        json!({ "thread": {"id":"thread-1", "status":{"type":"active"}, "turns":turns} }),
    );
    read.await.unwrap()
}

#[tokio::test]
async fn live_codex_snapshot_retains_large_history_and_responds_to_original_pending_approval() {
    let (state, peer, mut rx) = runtime().await;
    peer.request_client(
        &RequestId::Int(77),
        "item/commandExecution/requestApproval",
        json!({"threadId":"thread-1","turnId":"turn-1","itemId":"item-1","command":"pwd"}),
    );
    let request = event(&mut rx).await;
    event(&mut rx).await;
    let text = "ordinary large output ".repeat(50_000);
    let turns: Vec<_> = (0..34)
        .map(|index| {
            json!({"id":format!("turn-{index}"),
        "items":[{"id":format!("answer-{index}"),"type":"agentMessage","text":text}]})
        })
        .collect();
    let snapshot = snapshot_with_turns(&state, &peer, json!(turns)).await;
    state
        .handle_approval_respond(
            serde_json::from_value(json!({
                "provider":"codex","sessionType":"freshcodex","sessionId":"thread-1",
                "requestId":request["requestId"],"decision":{"behavior":"allow"}
            }))
            .unwrap(),
        )
        .await;
    let native_reply = peer.next_raw_frame().await.unwrap();
    peer.disconnect();
    state.shutdown().await;
    assert!(
        serde_json::to_vec(&snapshot).unwrap().len()
            < crate::native_history::MAX_HISTORY_BYTES as usize
    );
    assert_eq!(snapshot["status"], "running");
    assert_eq!(
        snapshot["pendingApprovals"][0]["requestId"],
        request["requestId"]
    );
    assert_eq!(snapshot["pendingApprovals"][0]["toolName"], "Bash");
    assert_eq!(snapshot["capabilities"]["approvals"], true);
    assert_eq!(
        native_reply,
        json!({"id":77,"result":{"decision":"accept"}})
    );
}

#[tokio::test]
async fn codex_user_controls_approval_round_trip_preserves_ids_and_reloads_pending_cards() {
    let (state, peer, mut rx) = runtime().await;
    for (id, method, allow, expected) in [
        (
            RequestId::Int(41),
            "item/commandExecution/requestApproval",
            true,
            json!({"decision":"accept"}),
        ),
        (
            RequestId::Str("file-request".into()),
            "item/fileChange/requestApproval",
            false,
            json!({"decision":"decline"}),
        ),
        (
            RequestId::Int(43),
            "item/permissions/requestApproval",
            true,
            json!({"permissions":{"network":{"enabled":true}},"scope":"turn"}),
        ),
        (
            RequestId::Int(44),
            "item/permissions/requestApproval",
            false,
            json!({"permissions":{},"scope":"turn"}),
        ),
    ] {
        peer.request_client(&id, method, json!({"threadId":"thread-1","turnId":"turn-1","itemId":"item-1","command":"npm test","reason":"Run tests","permissions":{"network":{"enabled":true}}}));
        assert_eq!(
            event(&mut rx).await["type"],
            "freshAgent.permission.request"
        );
        assert_eq!(event(&mut rx).await["type"], "freshAgent.turn.waiting");
        let pending = snapshot(&state, &peer).await;
        assert_eq!(pending["capabilities"]["approvals"], true);
        assert_eq!(pending["pendingApprovals"].as_array().unwrap().len(), 1);
        state.handle_approval_respond(serde_json::from_value(json!({
            "provider":"codex","sessionType":"freshcodex","sessionId":"thread-1", "requestId":pending["pendingApprovals"][0]["requestId"],
            "decision":{"behavior":if allow {"allow"} else {"deny"}}
        })).unwrap()).await;
        assert_eq!(
            peer.next_raw_frame().await.unwrap(),
            json!({"id":id.to_json(),"result":expected})
        );
        assert_eq!(
            event(&mut rx).await["type"],
            "freshAgent.permission.cancelled"
        );
        assert_eq!(snapshot(&state, &peer).await["pendingApprovals"], json!([]));
    }
    peer.disconnect();
    state.shutdown().await;
}

#[tokio::test]
async fn codex_user_controls_questions_use_stable_ids_and_require_all_answers() {
    let (state, peer, mut rx) = runtime().await;
    peer.request_client(&RequestId::Int(5), "item/tool/requestUserInput", json!({
        "threadId":"thread-1","turnId":"turn-1","itemId":"ask-1", "questions":[
            {"id":"first","question":"Pick one","header":"First","options":[{"label":"A","description":"Alpha"}]},
            {"id":"second","question":"Pick one","header":"Second","options":null}
        ]
    }));
    let request = event(&mut rx).await;
    assert_eq!(request["type"], "freshAgent.question.request");
    event(&mut rx).await;
    let pending = snapshot(&state, &peer).await;
    assert_eq!(
        pending["pendingQuestions"][0]["questions"][0]["id"],
        "first"
    );
    let response = |answers| {
        serde_json::from_value(json!({"provider":"codex","sessionType":"freshcodex","sessionId":"thread-1","requestId":request["requestId"],"answers":answers})).unwrap()
    };
    state
        .handle_question_respond(response(json!({"first":"A"})))
        .await;
    assert_eq!(event(&mut rx).await["code"], "INVALID_ANSWER");
    assert_eq!(
        snapshot(&state, &peer).await["pendingQuestions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    state
        .handle_question_respond(response(json!({"first":"A","second":"My answer"})))
        .await;
    assert_eq!(
        peer.next_raw_frame().await.unwrap(),
        json!({"id":5,"result":{"answers":{"first":{"answers":["A"]},"second":{"answers":["My answer"]}}}})
    );
    assert_eq!(
        event(&mut rx).await["type"],
        "freshAgent.question.cancelled"
    );
    peer.disconnect();
    state.shutdown().await;
}

#[tokio::test]
async fn codex_user_controls_resolved_and_interrupted_requests_clear_without_completion_chime() {
    let (state, peer, mut rx) = runtime().await;
    let params =
        json!({"threadId":"thread-1","turnId":"turn-1","itemId":"item-1","command":"npm test"});
    peer.request_client(
        &RequestId::Int(8),
        "item/commandExecution/requestApproval",
        params.clone(),
    );
    event(&mut rx).await;
    event(&mut rx).await;
    peer.request_client(
        &RequestId::Int(8),
        "item/commandExecution/requestApproval",
        params.clone(),
    );
    assert_eq!(
        event(&mut rx).await["type"],
        "freshAgent.permission.request"
    );
    assert!(
        rx.try_recv().is_err(),
        "Repeated request must not ring again"
    );
    peer.emit_notification(
        "serverRequest/resolved",
        json!({"threadId":"thread-1","requestId":8}),
    );
    assert_eq!(
        event(&mut rx).await["type"],
        "freshAgent.permission.cancelled"
    );
    peer.request_client(
        &RequestId::Int(9),
        "item/commandExecution/requestApproval",
        params,
    );
    event(&mut rx).await;
    event(&mut rx).await;
    // The user interrupts the turn through the REAL lane — handle_interrupt
    // arms the user-interrupt marker before its `turn/interrupt` RPC, so the
    // interrupted completion below stays silent under the unified guard.
    let interrupt = tokio::spawn({
        let state = state.clone();
        async move {
            state
                .handle_interrupt(FreshAgentInterrupt {
                    request_id: None,
                    provider: freshell_protocol::AgentProvider::Codex,
                    session_id: "thread-1".to_string(),
                    session_type: freshell_protocol::SessionType::Freshcodex,
                    cwd: None,
                })
                .await;
        }
    });
    let (mut id, mut method, _) = peer.expect_request().await;
    if method == "initialize" {
        peer.respond(&id, json!({}));
        peer.expect_notification().await;
        (id, method, _) = peer.expect_request().await;
    }
    assert_eq!(method, "turn/interrupt");
    peer.respond(&id, json!({}));
    interrupt.await.expect("interrupt task");
    peer.emit_notification(
        "turn/completed",
        json!({"threadId":"thread-1","turnId":"turn-1","status":"interrupted"}),
    );
    assert_eq!(
        event(&mut rx).await["type"],
        "freshAgent.permission.cancelled"
    );
    assert_eq!(event(&mut rx).await["type"], "freshAgent.session.snapshot");
    assert_eq!(snapshot(&state, &peer).await["pendingApprovals"], json!([]));
    assert!(
        rx.try_recv().is_err(),
        "Interrupted turn must not chime completion"
    );
    peer.disconnect();
    state.shutdown().await;
}

#[tokio::test]
async fn codex_user_controls_failed_response_keeps_request_available() {
    let (state, peer, mut rx) = runtime().await;
    peer.request_client(
        &RequestId::Int(10),
        "item/fileChange/requestApproval",
        json!({"threadId":"thread-1","turnId":"turn-1","itemId":"edit"}),
    );
    let request = event(&mut rx).await;
    event(&mut rx).await;
    // Close the client's transport after aborting the consumer, so the response
    // failure is tested independently of the disconnect's cancellation handling.
    state
        .sessions
        .lock()
        .await
        .get("thread-1")
        .unwrap()
        .consumer
        .abort();
    peer.disconnect();
    let client = state
        .sessions
        .lock()
        .await
        .get("thread-1")
        .unwrap()
        .client
        .clone();
    client.close().await;
    state.handle_approval_respond(serde_json::from_value(json!({"provider":"codex","sessionType":"freshcodex","sessionId":"thread-1","requestId":request["requestId"],"decision":{"behavior":"allow"}})).unwrap()).await;
    assert_eq!(event(&mut rx).await["code"], "RESPONSE_FAILED");
    let mut pending = json!({"capabilities":{}});
    state.overlay_controls("thread-1", &mut pending).await;
    assert_eq!(pending["pendingApprovals"].as_array().unwrap().len(), 1);
    state.shutdown().await;
}

async fn runtime_with_native_home(
    home: &std::path::Path,
) -> (
    FreshCodexState,
    ChannelPeer,
    tokio::sync::broadcast::Receiver<String>,
) {
    let (state, peer, events) = runtime().await;
    let client = state.sessions.lock().await["thread-1"].client.clone();
    let initialize = tokio::spawn(async move { client.initialize().await.unwrap() });
    let (id, method, _) = peer.expect_request().await;
    assert_eq!(method, "initialize");
    peer.respond(&id, json!({"codexHome":home}));
    peer.expect_notification().await;
    initialize.await.unwrap();
    (state, peer, events)
}

#[tokio::test]
async fn live_codex_large_native_snapshot_preserves_partial_output_and_original_pending_control() {
    use std::io::Write;
    let native_home = tempfile::tempdir().unwrap();
    let home = native_home.path();
    let sessions = home.join("sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    let path = sessions.join("rollout-thread-1.jsonl");
    let mut source = std::fs::File::create(&path).unwrap();
    writeln!(
        source,
        "{}",
        json!({"type":"session_meta","payload":{"id":"thread-1","history_mode":"paginated"}})
    )
    .unwrap();
    let text = "n".repeat(65_000);
    for index in 0..1100 {
        writeln!(
            source,
            "{}",
            json!({"type":"turn_context","payload":{"turn_id":format!("saved-{index}")}})
        )
        .unwrap();
        writeln!(source,"{}",json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":text}]}})).unwrap();
    }
    writeln!(
        source,
        "{}",
        json!({"type":"turn_context","payload":{"turn_id":"active-turn"}})
    )
    .unwrap();
    writeln!(source,"{}",json!({"type":"response_item","payload":{"type":"message","id":"legacy-earlier","role":"assistant","content":[{"type":"output_text","text":"Earlier current-turn commentary"}]}})).unwrap();
    writeln!(source,"{}",json!({"type":"response_item","payload":{"type":"function_call","call_id":"stored-command","name":"exec_command","arguments":"{\"cmd\":\"pwd\"}"}})).unwrap();
    writeln!(source,"{}",json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"stored-command","output":"retained same-turn tool output"}})).unwrap();
    writeln!(source,"{}",json!({"type":"response_item","payload":{"type":"message","id":"legacy-stale","role":"assistant","content":[{"type":"output_text","text":"Stale saved partial"}]}})).unwrap();
    source.sync_all().unwrap();
    assert!(source.metadata().unwrap().len() > 64 * 1024 * 1024);
    drop(source);
    let (state, peer, mut events) = runtime_with_native_home(home).await;
    peer.request_client(&RequestId::Int(89),"item/commandExecution/requestApproval",
        json!({"threadId":"thread-1","turnId":"active-turn","itemId":"live-command","command":"pwd"}));
    let pending = event(&mut events).await;
    event(&mut events).await;
    let task = tokio::spawn({
        let state = state.clone();
        async move { state.get_snapshot("thread-1", None).await }
    });
    let (mut id, mut method, mut params) = peer.expect_request().await;
    if method == "initialize" {
        peer.respond(&id, json!({"codexHome":home}));
        peer.expect_notification().await;
        (id, method, params) = peer.expect_request().await;
    }
    assert_eq!(method, "thread/read");
    let included_all_turns = params["includeTurns"] != false;
    if included_all_turns {
        peer.respond_error(
            &id,
            -32603,
            "guarded native API: full history would exceed the64MiB transport limit",
        );
    } else {
        peer.respond(
            &id,
            json!({"thread":{"id":"thread-1","status":{"type":"active"},"turns":[]}}),
        );
        let (page_id, page_method, page_params) = peer.expect_request().await;
        assert_eq!(page_method, "thread/turns/list");
        assert_eq!(page_params["threadId"], "thread-1");
        assert_eq!(page_params["limit"], 1);
        assert_eq!(page_params["sortDirection"], "desc");
        let latest = json!({"id":"item-9","type":"agentMessage","text":"Current partial answer absent from the saved rollout"});
        let items = if page_params["itemsView"] == "full" {
            json!([{"id":"item-6","type":"userMessage","content":[{"type":"text","text":"Current user context"}]},
                {"id":"item-7","type":"agentMessage","text":"Earlier current-turn commentary"},
                {"id":"stored-command","type":"commandExecution","command":"pwd","status":"completed","aggregatedOutput":"retained same-turn tool output"},latest])
        } else {
            json!([latest])
        };
        peer.respond(&page_id,json!({"data":[{"id":"active-turn","status":"inProgress","itemsView":page_params["itemsView"],"items":items}],"nextCursor":null,"backwardsCursor":null}));
    }
    let result = task.await.unwrap();
    let native_reply = if result.is_ok() {
        state
            .handle_approval_respond(
                serde_json::from_value(
                    json!({"provider":"codex","sessionType":"freshcodex","sessionId":"thread-1",
            "requestId":pending["requestId"],"decision":{"behavior":"allow"}}),
                )
                .unwrap(),
            )
            .await;
        Some(peer.next_raw_frame().await.unwrap())
    } else {
        None
    };
    peer.disconnect();
    state.shutdown().await;
    assert!(
        !included_all_turns,
        "a known large native history must never be requested as one WebSocket message: {result:?}"
    );
    let snapshot = result.unwrap();
    assert!(
        serde_json::to_vec(&snapshot).unwrap().len()
            < crate::native_history::MAX_HISTORY_BYTES as usize
    );
    assert_eq!(snapshot["threadId"], "thread-1");
    assert_eq!(snapshot["status"], "running");
    assert_eq!(snapshot["capabilities"]["interrupt"], true);
    assert_eq!(snapshot["capabilities"]["approvals"], true);
    assert_eq!(
        snapshot["pendingApprovals"][0]["requestId"],
        pending["requestId"]
    );
    assert!(
        snapshot["turns"].as_array().unwrap().len() > 1,
        "bounded saved history joins the current native turn"
    );
    let current_rows = snapshot["turns"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|turn| {
            turn["turnId"]
                .as_str()
                .is_some_and(|id| id.starts_with("active-turn:row-"))
        })
        .collect::<Vec<_>>();
    assert_eq!(
        current_rows.len(),
        4,
        "the full native turn keeps its user, commentary, tool and partial answer rows"
    );
    for (index, row) in current_rows.iter().enumerate() {
        assert_eq!(row["turnId"], format!("active-turn:row-{index}"));
    }
    assert!(!serde_json::to_string(&snapshot)
        .unwrap()
        .contains("Stale saved partial"));
    assert_eq!(
        snapshot["turns"].as_array().unwrap().last().unwrap()["turnId"],
        "active-turn:row-3"
    );
    let items = current_rows
        .iter()
        .flat_map(|row| row["items"].as_array().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        items.iter().filter(|item| item["id"] == "item-9").count(),
        1
    );
    assert!(items.iter().any(|item| item["id"] == "item-9"
        && item["text"] == "Current partial answer absent from the saved rollout"));
    assert!(
        items.iter().any(|item| item["id"] == "stored-command"
            && item["output"] == "retained same-turn tool output"),
        "retained current-turn tools must not disappear into a text-only summary: {items:?}"
    );
    assert!(items
        .iter()
        .any(|item| item["id"] == "item-7" && item["text"] == "Earlier current-turn commentary"));
    assert!(items
        .iter()
        .any(|item| item["text"] == "Current user context"));
    assert_ne!(snapshot["extensions"]["codex"]["ownerKind"], "vacant");
    assert_eq!(
        native_reply,
        Some(json!({"id":89,"result":{"decision":"accept"}}))
    );
}

#[tokio::test]
async fn live_codex_large_native_snapshot_refuses_mismatched_live_root() {
    let home = tempfile::tempdir().unwrap();
    let sessions = home.path().join("sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    let rows = [
        json!({"type":"session_meta","payload":{"id":"thread-1"}}),
        json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"x".repeat(5*1024*1024)}]}}),
    ];
    std::fs::write(
        sessions.join("rollout-thread-1.jsonl"),
        rows.iter()
            .map(|row| format!("{row}\n"))
            .collect::<String>(),
    )
    .unwrap();
    let (state, peer, _) = runtime_with_native_home(home.path()).await;
    let task = tokio::spawn({
        let state = state.clone();
        async move { state.get_snapshot("thread-1", None).await }
    });
    let (id, method, params) = peer.expect_request().await;
    assert_eq!(method, "thread/read");
    peer.respond(
        &id,
        json!({"thread":{"id":"another-root","status":{"type":"active"},"turns":[]}}),
    );
    let result = task.await.unwrap();
    peer.disconnect();
    state.shutdown().await;
    assert_eq!(params["includeTurns"], false);
    assert!(
        matches!(result,Err(CodexSnapshotError::Protocol(message)) if message.contains("another Codex root"))
    );
}

use super::*;
use crate::codex::tests::{insert_fake_session_with_real_consumer, spawn_sleeper, state_with_bus};
use freshell_codex::ChannelPeer;

async fn runtime() -> (
    FreshCodexState,
    ChannelPeer,
    tokio::sync::broadcast::Receiver<String>,
) {
    runtime_for("thread-1", "turn-1").await
}

async fn runtime_for(
    session_id: &str,
    turn_id: &str,
) -> (
    FreshCodexState,
    ChannelPeer,
    tokio::sync::broadcast::Receiver<String>,
) {
    let (transport, peer) = freshell_codex::new_channel_transport();
    let (client, notifications) = CodexAppServerClient::connect(transport);
    let (state, rx) = state_with_bus();
    insert_fake_session_with_real_consumer(
        &state,
        session_id,
        Arc::new(client),
        Arc::new(StdMutex::new(Some(turn_id.into()))),
        notifications,
        spawn_sleeper(),
        "codex-controls-fixture",
    )
    .await;
    (state, peer, rx)
}

fn task001_child_control_frames() -> Vec<Value> {
    serde_json::from_str::<Value>(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../test/fixtures/fresh-agent/codex/task001-child-approval.json"
    )))
    .unwrap()["frames"]
        .as_array()
        .unwrap()
        .clone()
}

async fn child_control_runtime() -> (
    FreshCodexState,
    ChannelPeer,
    tokio::sync::broadcast::Receiver<String>,
    Vec<Value>,
) {
    let frames = task001_child_control_frames();
    let (state, peer, rx) = runtime_for(
        frames[0]["params"]["threadId"].as_str().unwrap(),
        frames[0]["params"]["turnId"].as_str().unwrap(),
    )
    .await;
    for frame in &frames[..2] {
        peer.emit_notification(frame["method"].as_str().unwrap(), frame["params"].clone());
    }
    (state, peer, rx, frames)
}

async fn child_approval_event(rx: &mut tokio::sync::broadcast::Receiver<String>) -> Value {
    loop {
        let next = event(rx).await;
        if next["type"] == "freshAgent.permission.request" {
            return next;
        }
    }
}

#[tokio::test]
async fn task5_actual_parent_owned_child_approval_uses_parent_client_without_a_child_writer() {
    let (state, peer, mut rx, frames) = child_control_runtime().await;
    let parent = frames[0]["params"]["threadId"].as_str().unwrap();
    let parent_turn = frames[0]["params"]["turnId"].as_str().unwrap();
    let child = frames[2]["params"]["threadId"].as_str().unwrap();
    peer.request_client(
        &RequestId::Int(0),
        frames[2]["method"].as_str().unwrap(),
        frames[2]["params"].clone(),
    );
    let request = tokio::select! {
        request = child_approval_event(&mut rx) => request,
        frame = peer.next_raw_frame() => panic!("projection-proven child approval was refused: {frame:?}"),
    };
    assert_eq!(request["sessionId"], parent);
    assert_eq!(request["providerRequest"]["id"], 0);
    assert_eq!(request["providerRequest"]["threadId"], child);
    let mut snapshot = json!({"capabilities":{}});
    state.overlay_controls(parent, &mut snapshot).await;
    assert_eq!(
        snapshot["pendingApprovals"][0]["requestId"],
        request["requestId"]
    );
    assert_eq!(state.awaited_control_count(parent), 1);
    {
        let sessions = state.sessions.lock().await;
        assert_eq!(sessions.len(), 1);
        assert!(!sessions.contains_key(child));
        assert_eq!(
            sessions[parent].active_turn.lock().unwrap().as_deref(),
            Some(parent_turn)
        );
    }
    assert!(state.try_handle_approval_respond(serde_json::from_value(json!({"provider":"codex","sessionType":"freshcodex","sessionId":parent,"requestId":request["requestId"],"decision":{"nativeDecision":"cancel"}})).unwrap()).await);
    assert_eq!(
        peer.next_raw_frame().await.unwrap(),
        json!({"id":0,"result":{"decision":"cancel"}})
    );
    assert!(state.retained_control_events(parent).await.is_empty());
    peer.disconnect();
    state.shutdown().await;
}

#[tokio::test]
async fn task5_child_control_still_refuses_unrelated_threads_and_wrong_native_child_turns() {
    for invalid_thread in [true, false] {
        let (state, peer, _rx, frames) = child_control_runtime().await;
        let parent = frames[0]["params"]["threadId"].as_str().unwrap();
        let mut params = frames[2]["params"].clone();
        params[if invalid_thread { "threadId" } else { "turnId" }] =
            json!("unrelated-native-identity");
        peer.request_client(
            &RequestId::Int(0),
            frames[2]["method"].as_str().unwrap(),
            params,
        );
        assert!(peer.next_raw_frame().await.unwrap().get("error").is_some());
        assert!(state.retained_control_events(parent).await.is_empty());
        peer.disconnect();
        state.shutdown().await;
    }
}

#[tokio::test]
async fn task5_child_control_outlives_parent_terminal_and_keeps_its_native_owner() {
    // This is a deliberate interleaving, not the capture's completion ordering.
    let (state, peer, mut rx, frames) = child_control_runtime().await;
    let parent = frames[0]["params"]["threadId"].as_str().unwrap();
    let parent_turn = frames[0]["params"]["turnId"].as_str().unwrap();
    peer.request_client(
        &RequestId::Int(0),
        frames[2]["method"].as_str().unwrap(),
        frames[2]["params"].clone(),
    );
    let request = child_approval_event(&mut rx).await;
    peer.emit_notification(
        "turn/completed",
        json!({"threadId":parent,"turn":{"id":parent_turn,"status":"completed","items":[]}}),
    );
    loop {
        let next = event(&mut rx).await;
        assert_ne!(next["type"], "freshAgent.permission.cancelled");
        if next["type"] == "freshAgent.turn.complete" {
            break;
        }
    }
    assert_eq!(state.awaited_control_count(parent), 1);
    assert_eq!(
        state.retained_control_events(parent).await[0]["requestId"],
        request["requestId"]
    );
    assert!(state.try_handle_approval_respond(serde_json::from_value(json!({"provider":"codex","sessionType":"freshcodex","sessionId":parent,"requestId":request["requestId"],"decision":{"nativeDecision":"cancel"}})).unwrap()).await);
    assert_eq!(
        peer.next_raw_frame().await.unwrap(),
        json!({"id":0,"result":{"decision":"cancel"}})
    );
    peer.disconnect();
    state.shutdown().await;
}

#[tokio::test]
async fn task5_child_resolution_and_terminal_only_cancel_the_matching_native_thread() {
    for finish in ["serverRequest/resolved", "turn/completed", "thread/closed"] {
        let (state, peer, mut rx, frames) = child_control_runtime().await;
        let parent = frames[0]["params"]["threadId"].as_str().unwrap();
        let parent_turn = frames[0]["params"]["turnId"].as_str().unwrap();
        let child = frames[2]["params"]["threadId"].as_str().unwrap();
        let child_turn = frames[2]["params"]["turnId"].as_str().unwrap();
        peer.request_client(
            &RequestId::Int(0),
            frames[2]["method"].as_str().unwrap(),
            frames[2]["params"].clone(),
        );
        let child_request = child_approval_event(&mut rx).await;
        peer.request_client(
            &RequestId::Int(301),
            "item/commandExecution/requestApproval",
            json!({"threadId":parent,"turnId":parent_turn,"command":"parent fixture"}),
        );
        let parent_request = child_approval_event(&mut rx).await;
        peer.emit_notification(finish, match finish {
            "serverRequest/resolved" => json!({"threadId":child,"requestId":0}),
            "turn/completed" => json!({"threadId":child,"turn":{"id":child_turn,"status":"completed","items":[]}}),
            _ => json!({"threadId":child}),
        });
        loop {
            let next = event(&mut rx).await;
            if next["type"] == "freshAgent.permission.cancelled" {
                assert_eq!(next["requestId"], child_request["requestId"]);
                break;
            }
        }
        let retained = state.retained_control_events(parent).await;
        assert_eq!(retained.len(), 1);
        assert_eq!(retained[0]["requestId"], parent_request["requestId"]);
        assert_eq!(state.awaited_control_count(parent), 1);
        assert_eq!(
            state.sessions.lock().await[parent]
                .active_turn
                .lock()
                .unwrap()
                .as_deref(),
            Some(parent_turn)
        );
        peer.disconnect();
        state.shutdown().await;
    }
}

#[tokio::test]
async fn task5_parent_source_close_drains_child_and_parent_controls_once() {
    for disconnect in [false, true] {
        let (state, peer, mut rx, frames) = child_control_runtime().await;
        let parent = frames[0]["params"]["threadId"].as_str().unwrap();
        let parent_turn = frames[0]["params"]["turnId"].as_str().unwrap();
        peer.request_client(
            &RequestId::Int(0),
            frames[2]["method"].as_str().unwrap(),
            frames[2]["params"].clone(),
        );
        let child_request = child_approval_event(&mut rx).await;
        peer.request_client(
            &RequestId::Int(301),
            "item/commandExecution/requestApproval",
            json!({"threadId":parent,"turnId":parent_turn,"command":"parent fixture"}),
        );
        let parent_request = child_approval_event(&mut rx).await;
        let remaining_peer = if disconnect {
            peer.disconnect();
            None
        } else {
            peer.emit_notification("thread/closed", json!({"threadId":parent}));
            Some(peer)
        };
        let mut cancelled = Vec::new();
        while cancelled.len() < 2 {
            let next = event(&mut rx).await;
            if next["type"] == "freshAgent.permission.cancelled" {
                cancelled.push(next["requestId"].clone());
            }
        }
        assert!(cancelled.contains(&child_request["requestId"]));
        assert!(cancelled.contains(&parent_request["requestId"]));
        assert_eq!(state.awaited_control_count(parent), 0);
        assert!(state.retained_control_events(parent).await.is_empty());
        state.clear_controls(parent).await;
        while let Ok(frame) = rx.try_recv() {
            let frame: Value = serde_json::from_str(&frame).unwrap();
            assert_ne!(frame["event"]["type"], "freshAgent.permission.cancelled");
        }
        if let Some(peer) = remaining_peer {
            peer.disconnect();
        }
        tokio::time::timeout(Duration::from_secs(3), state.shutdown())
            .await
            .expect("owned channel fixture teardown must complete");
    }
}

#[tokio::test]
async fn task5_child_relationship_requires_the_exact_native_parent_sender() {
    let mut frames = task001_child_control_frames();
    let parent = frames[0]["params"]["threadId"].as_str().unwrap().to_owned();
    let parent_turn = frames[0]["params"]["turnId"].as_str().unwrap().to_owned();
    frames[0]["params"]["item"]["senderThreadId"] = json!("unrelated-parent");
    let (state, peer, _rx) = runtime_for(&parent, &parent_turn).await;
    for frame in &frames[..2] {
        peer.emit_notification(frame["method"].as_str().unwrap(), frame["params"].clone());
    }
    peer.request_client(
        &RequestId::Int(0),
        frames[2]["method"].as_str().unwrap(),
        frames[2]["params"].clone(),
    );
    assert!(peer.next_raw_frame().await.unwrap().get("error").is_some());
    assert!(state.retained_control_events(&parent).await.is_empty());
    peer.disconnect();
    state.shutdown().await;
}

#[tokio::test]
async fn task5_child_control_survives_real_parent_display_eviction_without_restoring_rows() {
    // Deliberate bounded continuation after the captured relationship, not a
    // claim that the Task001 capture contains forty subsequent parent turns.
    let (state, peer, mut rx, frames) = child_control_runtime().await;
    let parent = frames[0]["params"]["threadId"].as_str().unwrap();
    let parent_turn = frames[0]["params"]["turnId"].as_str().unwrap();
    let child = frames[2]["params"]["threadId"].as_str().unwrap();
    peer.request_client(
        &RequestId::Int(0),
        frames[2]["method"].as_str().unwrap(),
        frames[2]["params"].clone(),
    );
    let request = child_approval_event(&mut rx).await;
    peer.emit_notification(
        "turn/completed",
        json!({"threadId":parent,"turn":{"id":parent_turn,"status":"completed","items":[]}}),
    );
    loop {
        if event(&mut rx).await["type"] == "freshAgent.turn.complete" {
            break;
        }
    }
    for index in 0..40 {
        let turn = format!("later-parent-turn-{index}");
        peer.emit_notification(
            "turn/started",
            json!({"threadId":parent,"turn":{"id":turn,"status":"inProgress","items":[]}}),
        );
        peer.emit_notification("item/completed", json!({"threadId":parent,"turnId":turn,"item":{"id":format!("later-parent-item-{index}"),"type":"agentMessage","text":"Parent continuation"}}));
        peer.emit_notification(
            "turn/completed",
            json!({"threadId":parent,"turn":{"id":turn,"status":"completed","items":[]}}),
        );
        loop {
            let next = event(&mut rx).await;
            assert_ne!(next["type"], "freshAgent.permission.cancelled");
            if next["type"] == "freshAgent.turn.complete" {
                break;
            }
        }
    }
    let source = state.sessions.lock().await[parent].projection.clone();
    assert!(
        !source.lock().unwrap().knows_child_thread(child),
        "the actual projection must have evicted the old spawn payload"
    );
    assert_eq!(
        state.retained_control_events(parent).await[0]["requestId"],
        request["requestId"]
    );
    assert!(state.try_handle_approval_respond(serde_json::from_value(json!({"provider":"codex","sessionType":"freshcodex","sessionId":parent,"requestId":request["requestId"],"decision":{"nativeDecision":"cancel"}})).unwrap()).await, "display retention must not invalidate the still-awaited child control");
    assert_eq!(
        peer.next_raw_frame().await.unwrap(),
        json!({"id":0,"result":{"decision":"cancel"}})
    );
    assert!(
        !source.lock().unwrap().knows_child_thread(child),
        "answering must not revive the evicted display row"
    );
    assert_eq!(state.sessions.lock().await.len(), 1);
    peer.disconnect();
    state.shutdown().await;
}

async fn replace_child_control_source(
    state: &FreshCodexState,
    parent: &str,
    frames: &[Value],
) -> Arc<StdMutex<projection::CodexProjection>> {
    let source = Arc::new(StdMutex::new(projection::CodexProjection::new(
        "replacement-parent-source".into(),
        parent.into(),
    )));
    source
        .lock()
        .unwrap()
        .apply(frames[0]["method"].as_str().unwrap(), &frames[0]["params"])
        .unwrap();
    state
        .sessions
        .lock()
        .await
        .get_mut(parent)
        .unwrap()
        .projection = source.clone();
    let child_start = freshell_codex::protocol::classify_notification(
        frames[1]["method"].as_str().unwrap(),
        Some(&frames[1]["params"]),
    );
    state
        .observe_child_control_turn(parent, &source, &child_start)
        .await;
    source
}

#[tokio::test]
async fn task5_old_child_answer_cannot_cross_projection_replacement_with_reused_native_scope() {
    let (state, peer, mut rx, frames) = child_control_runtime().await;
    let parent = frames[0]["params"]["threadId"].as_str().unwrap();
    peer.request_client(
        &RequestId::Int(0),
        frames[2]["method"].as_str().unwrap(),
        frames[2]["params"].clone(),
    );
    let request = child_approval_event(&mut rx).await;
    let source = replace_child_control_source(&state, parent, &frames).await;
    assert!(source
        .lock()
        .unwrap()
        .knows_child_thread(frames[2]["params"]["threadId"].as_str().unwrap()));
    assert!(!state.try_handle_approval_respond(serde_json::from_value(json!({"provider":"codex","sessionType":"freshcodex","sessionId":parent,"requestId":request["requestId"],"decision":{"nativeDecision":"cancel"}})).unwrap()).await, "the old operation must stay bound to its original projection even if a new source proves the same child IDs");
    assert_eq!(state.retained_control_events(parent).await.len(), 1);
    assert!(
        tokio::time::timeout(Duration::from_millis(30), peer.next_raw_frame())
            .await
            .is_err()
    );
    peer.disconnect();
    state.shutdown().await;
}

#[tokio::test]
async fn task5_reissued_child_rpc_on_new_projection_gets_a_new_public_operation_key() {
    let (state, peer, mut rx, frames) = child_control_runtime().await;
    let parent = frames[0]["params"]["threadId"].as_str().unwrap();
    peer.request_client(
        &RequestId::Int(0),
        frames[2]["method"].as_str().unwrap(),
        frames[2]["params"].clone(),
    );
    let original = child_approval_event(&mut rx).await;
    let source = replace_child_control_source(&state, parent, &frames).await;
    let notification = CodexNotification::ServerRequest {
        id: RequestId::Int(0),
        method: frames[2]["method"].as_str().unwrap().into(),
        params: frames[2]["params"].clone(),
    };
    assert!(
        state
            .consume_control_notification(parent, &notification, &source)
            .await
    );
    let current = state.retained_control_events(parent).await;
    assert_eq!(current.len(), 1);
    assert_ne!(
        current[0]["requestId"], original["requestId"],
        "source replacement must not reuse the old public answer key"
    );
    assert_eq!(current[0]["providerRequest"]["id"], 0);
    peer.disconnect();
    state.shutdown().await;
}

async fn event(rx: &mut tokio::sync::broadcast::Receiver<String>) -> Value {
    let frame = tokio::time::timeout(Duration::from_secs(3), rx.recv())
        .await
        .expect("event timeout")
        .unwrap();
    serde_json::from_str::<Value>(&frame).unwrap()["event"].clone()
}

async fn snapshot(state: &FreshCodexState, peer: &ChannelPeer) -> Value {
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
        json!({ "thread": {"id":"thread-1", "status":{"type":"active"}, "turns":[]} }),
    );
    read.await.unwrap()
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

#[tokio::test]
async fn codex_question_keeps_secret_other_and_blocking_flags_on_reload() {
    let (state, peer, mut rx) = runtime().await;
    peer.request_client(
        &RequestId::Int(51),
        "item/tool/requestUserInput",
        json!({
            "threadId":"thread-1","turnId":"turn-1","itemId":"ask-1","isBlocking":false,
            "questions":[{"id":"token","header":"Token","question":"Enter token",
                "options":null,"isOther":false,"isSecret":true}]
        }),
    );
    let request = event(&mut rx).await;
    assert_eq!(request["questions"][0]["isSecret"], true);
    assert_eq!(request["isBlocking"], false);
    let pending = snapshot(&state, &peer).await;
    assert_eq!(
        pending["pendingQuestions"][0]["questions"][0]["isOther"],
        false
    );
    assert_eq!(
        pending["pendingQuestions"][0]["questions"][0]["isSecret"],
        true
    );
    let answer = "  token, punctuation!  ";
    state.handle_question_respond(serde_json::from_value(json!({"provider":"codex","sessionType":"freshcodex","sessionId":"thread-1","requestId":request["requestId"],"answers":{"token":answer}})).unwrap()).await;
    assert_eq!(
        peer.next_raw_frame().await.unwrap(),
        json!({"id":51,"result":{"answers":{"token":{"answers":[answer]}}}})
    );
    peer.disconnect();
    state.shutdown().await;
}

#[tokio::test]
async fn task5_awaited_questions_pause_quiet_deadman_regardless_of_blocking_flag() {
    for blocking in [false, true] {
        let (state, peer, mut rx) = runtime().await;
        state.set_codex_quiet_window_ms_for_tests(80);
        peer.request_client(&RequestId::Int(61), "item/tool/requestUserInput", json!({"threadId":"thread-1","turnId":"turn-1","isBlocking":blocking,"questions":[{"id":"a","question":"A?"}]}));
        assert_eq!(event(&mut rx).await["type"], "freshAgent.question.request");
        assert_eq!(event(&mut rx).await["type"], "freshAgent.turn.waiting");
        tokio::time::sleep(Duration::from_millis(300)).await;
        while let Ok(frame) = rx.try_recv() {
            let value: Value = serde_json::from_str(&frame).unwrap();
            assert_ne!(
                value["event"]["status"], "stuck",
                "awaited native RPC must pause quiet detection: {value}"
            );
        }
        peer.disconnect();
        state.shutdown().await;
    }
}

#[tokio::test]
async fn task5_last_awaited_reply_rearms_a_full_quiet_window() {
    let (state, peer, mut rx) = runtime().await;
    state.set_codex_quiet_window_ms_for_tests(120);
    let mut keys = Vec::new();
    for id in [71, 72] {
        peer.request_client(&RequestId::Int(id), "item/tool/requestUserInput", json!({"threadId":"thread-1","turnId":"turn-1","isBlocking":false,"questions":[{"id":"a","question":"A?"}]}));
        let request = event(&mut rx).await;
        assert_eq!(request["type"], "freshAgent.question.request");
        keys.push(request["requestId"].clone());
        if id == 71 {
            event(&mut rx).await;
        }
    }
    let respond = |id| {
        serde_json::from_value(json!({"provider":"codex","sessionType":"freshcodex","sessionId":"thread-1","requestId":id,"answers":{"a":"one, exact answer"}})).unwrap()
    };
    state.handle_question_respond(respond(&keys[0])).await;
    peer.next_raw_frame().await.unwrap();
    event(&mut rx).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        rx.try_recv().is_err(),
        "one unresolved native control must still pause detection"
    );
    state.handle_question_respond(respond(&keys[1])).await;
    peer.next_raw_frame().await.unwrap();
    event(&mut rx).await;
    assert!(
        tokio::time::timeout(Duration::from_millis(60), rx.recv())
            .await
            .is_err(),
        "last response starts a NEW quiet window"
    );
    let stuck = event(&mut rx).await;
    assert_eq!(
        stuck["status"], "stuck",
        "owed native work must be watched after final answer: {stuck}"
    );
    peer.disconnect();
    state.shutdown().await;
}

#[tokio::test]
async fn task5_approval_metadata_and_offered_cancel_are_preserved() {
    let (state, peer, mut rx) = runtime().await;
    peer.request_client(&RequestId::Str("41".into()), "item/commandExecution/requestApproval", json!({"threadId":"thread-1","turnId":"turn-1","itemId":"command","approvalId":"approval-distinct","networkApprovalContext":{"host":"example.com","protocol":"https"},"availableDecisions":["accept","cancel"]}));
    let request = event(&mut rx).await;
    assert_eq!(
        request["native"]["availableDecisions"],
        json!(["accept", "cancel"])
    );
    assert_eq!(
        request["native"]["networkApprovalContext"]["host"],
        "example.com"
    );
    event(&mut rx).await;
    state.handle_approval_respond(serde_json::from_value(json!({"provider":"codex","sessionType":"freshcodex","sessionId":"thread-1","requestId":request["requestId"],"decision":{"nativeDecision":"cancel"}})).unwrap()).await;
    assert_eq!(
        peer.next_raw_frame().await.unwrap(),
        json!({"id":"41","result":{"decision":"cancel"}})
    );
    peer.disconnect();
    state.shutdown().await;
}

#[tokio::test]
async fn task5_approval_cannot_grant_a_decision_native_did_not_offer() {
    let (state, peer, mut rx) = runtime().await;
    peer.request_client(&RequestId::Int(91), "item/commandExecution/requestApproval", json!({"threadId":"thread-1","turnId":"turn-1","command":"echo x","availableDecisions":["cancel"]}));
    let request = event(&mut rx).await;
    event(&mut rx).await;
    state.handle_approval_respond(serde_json::from_value(json!({"provider":"codex","sessionType":"freshcodex","sessionId":"thread-1","requestId":request["requestId"],"decision":{"behavior":"allow"}})).unwrap()).await;
    assert_eq!(event(&mut rx).await["code"], "INVALID_ANSWER");
    assert!(
        tokio::time::timeout(Duration::from_millis(30), peer.next_raw_frame())
            .await
            .is_err()
    );
    peer.disconnect();
    state.shutdown().await;
}

#[tokio::test]
async fn task5_approval_without_offered_decisions_refuses_session_grant_and_allows_retry() {
    let (state, peer, mut rx) = runtime().await;
    for native_id in [RequestId::Int(92), RequestId::Str("92".into())] {
        peer.request_client(
            &native_id,
            "item/commandExecution/requestApproval",
            json!({"threadId":"thread-1","turnId":"turn-1","itemId":"command-92","command":"npm test"}),
        );
        let request = event(&mut rx).await;
        assert_eq!(request["type"], "freshAgent.permission.request");
        assert_eq!(event(&mut rx).await["type"], "freshAgent.turn.waiting");
        let before = snapshot(&state, &peer).await;
        assert_eq!(before["pendingApprovals"].as_array().unwrap().len(), 1);
        assert_eq!(
            before["pendingApprovals"][0]["requestId"],
            request["requestId"]
        );
        assert_eq!(
            before["pendingApprovals"][0]["providerRequest"]["id"],
            native_id.to_json()
        );
        assert_eq!(state.awaited_control_count("thread-1"), 1);
        let response = |decision| {
            serde_json::from_value(json!({
                "provider":"codex","sessionType":"freshcodex","sessionId":"thread-1",
                "requestId":request["requestId"],"decision":{"nativeDecision":decision}
            }))
            .unwrap()
        };

        state
            .handle_approval_respond(response("acceptForSession"))
            .await;
        let refused = event(&mut rx).await;
        assert_eq!(refused["type"], "freshAgent.error");
        assert_eq!(refused["code"], "INVALID_ANSWER");
        assert_eq!(refused["sessionId"], "thread-1");
        assert!(
            tokio::time::timeout(Duration::from_millis(30), peer.next_raw_frame())
                .await
                .is_err(),
            "an unoffered session grant must not answer the native RPC"
        );
        assert_eq!(
            snapshot(&state, &peer).await["pendingApprovals"],
            before["pendingApprovals"]
        );
        assert_eq!(state.awaited_control_count("thread-1"), 1);

        state.handle_approval_respond(response("accept")).await;
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(3), peer.next_raw_frame())
                .await
                .expect("the supported retry answers the original native RPC")
                .unwrap(),
            json!({"id":native_id.to_json(),"result":{"decision":"accept"}})
        );
        let cancelled = event(&mut rx).await;
        assert_eq!(cancelled["type"], "freshAgent.permission.cancelled");
        assert_eq!(cancelled["requestId"], request["requestId"]);
        assert_eq!(snapshot(&state, &peer).await["pendingApprovals"], json!([]));
        assert_eq!(state.awaited_control_count("thread-1"), 0);
    }
    peer.disconnect();
    tokio::time::timeout(Duration::from_secs(3), state.shutdown())
        .await
        .expect("owned controls fixture shuts down");
}

#[tokio::test]
async fn task5_stale_turn_control_is_refused_before_it_becomes_answerable() {
    let (state, peer, mut rx) = runtime().await;
    peer.request_client(
        &RequestId::Int(99),
        "item/tool/requestUserInput",
        json!({"threadId":"thread-1","turnId":"old-turn","questions":[{"id":"a","question":"A?"}]}),
    );
    let response = tokio::time::timeout(Duration::from_millis(300), peer.next_raw_frame())
        .await
        .expect("stale native request receives a refusal")
        .unwrap();
    assert!(response.get("error").is_some(), "{response}");
    assert_ne!(event(&mut rx).await["type"], "freshAgent.question.request");
    peer.disconnect();
    state.shutdown().await;
}

#[tokio::test]
async fn task5_mcp_form_and_url_requests_are_retained_as_elicitations() {
    for (mode, body) in [
        (
            "form",
            json!({"requestedSchema":{"type":"object","properties":{"token":{"type":"string","writeOnly":true}},"required":["token"]}}),
        ),
        (
            "openai/form",
            json!({"requestedSchema":{"type":"object","properties":{"age":{"type":"integer","minimum":1}},"required":["age"]}}),
        ),
        (
            "openaiForm",
            json!({"requestedSchema":{"type":"object","properties":{"enabled":{"type":"boolean"}}}}),
        ),
        (
            "url",
            json!({"url":"https://example.com/verify","elicitationId":"public-url-id"}),
        ),
    ] {
        let (state, peer, mut rx) = runtime().await;
        let mut params = json!({"threadId":"thread-1","turnId":null,"serverName":"contract","mode":mode,"message":"Fixture request"});
        params
            .as_object_mut()
            .unwrap()
            .extend(body.as_object().unwrap().clone());
        peer.request_client(&RequestId::Int(41), "mcpServer/elicitation/request", params);
        let request = event(&mut rx).await;
        assert_eq!(
            request["type"], "freshAgent.elicitation.request",
            "{request}"
        );
        assert_eq!(request["mode"], mode);
        let pending = snapshot(&state, &peer).await;
        assert_eq!(
            pending["pendingElicitations"][0]["requestId"],
            request["requestId"]
        );
        assert_eq!(
            pending["pendingElicitations"][0]["providerRequest"]["id"],
            41
        );
        peer.disconnect();
        state.shutdown().await;
    }
}

#[test]
fn task5_elicitation_response_is_a_typed_client_message() {
    let response = json!({"type":"freshAgent.elicitation.respond","provider":"codex","sessionType":"freshcodex","sessionId":"thread-1","requestId":"41","action":"accept","content":{"age":3,"enabled":true,"name":"hello","colors":["blue"]}});
    let parsed = serde_json::from_value::<freshell_protocol::ClientMessage>(response.clone());
    assert!(
        parsed.is_ok(),
        "new response must have ordinary WS ingress: {parsed:?}"
    );
    assert_eq!(serde_json::to_value(parsed.unwrap()).unwrap(), response);
}

#[tokio::test]
async fn task5_unsupported_elicitation_declines_once_and_explains_subtype() {
    for (mode, schema) in [
        ("openai/userVerification", json!(null)),
        (
            "form",
            json!({"type":"object","properties":{"nested":{"type":"object","properties":{}}}}),
        ),
    ] {
        let (state, peer, mut rx) = runtime().await;
        peer.request_client(&RequestId::Int(101), "mcpServer/elicitation/request", json!({"threadId":"thread-1","serverName":"contract","mode":mode,"title":"Verify", "message":"Fixture", "requestedSchema":schema}));
        assert_eq!(
            peer.next_raw_frame().await.unwrap(),
            json!({"id":101,"result":{"action":"decline","content":null}})
        );
        let notice = event(&mut rx).await;
        assert_eq!(notice["code"], "UNSUPPORTED_ELICITATION");
        assert!(notice["message"].as_str().unwrap().contains(mode));
        peer.disconnect();
        state.shutdown().await;
    }
}

async fn invalid_elicitation(content: Value) {
    let (state, peer, mut rx) = runtime().await;
    peer.request_client(&RequestId::Int(111), "mcpServer/elicitation/request", json!({"threadId":"thread-1","turnId":"turn-1","serverName":"contract","mode":"form","message":"Fixture","requestedSchema":{"type":"object","properties":{"count":{"type":"integer","minimum":1,"maximum":5},"color":{"type":"string","enum":["blue","green"]},"name":{"type":"string","minLength":2,"maxLength":8},"colors":{"type":"array","items":{"type":"string","enum":["blue","green"]},"minItems":1,"maxItems":2}},"required":["count","color","name","colors"]}}));
    let request = event(&mut rx).await;
    event(&mut rx).await;
    state.handle_elicitation_respond(serde_json::from_value(json!({"provider":"codex","sessionType":"freshcodex","sessionId":"thread-1","requestId":request["requestId"],"action":"accept","content":content})).unwrap()).await;
    assert_eq!(event(&mut rx).await["code"], "INVALID_ANSWER");
    assert!(
        tokio::time::timeout(Duration::from_millis(30), peer.next_raw_frame())
            .await
            .is_err(),
        "invalid answer must leave native RPC pending"
    );
    assert_eq!(state.retained_control_events("thread-1").await.len(), 1);
    peer.disconnect();
    state.shutdown().await;
}
macro_rules! invalid_elicitation_case {
    ($name:ident, $patch:expr) => {
        #[tokio::test]
        async fn $name() {
            let mut content = json!({"count":3,"color":"blue","name":"valid","colors":["green"]});
            ($patch)(&mut content);
            invalid_elicitation(content).await;
        }
    }
}
invalid_elicitation_case!(task5_form_rejects_missing_required, |v: &mut Value| {
    v.as_object_mut().unwrap().remove("name");
});
invalid_elicitation_case!(task5_form_rejects_wrong_type, |v: &mut Value| {
    v["count"] = json!("3");
});
invalid_elicitation_case!(task5_form_rejects_fractional_integer, |v: &mut Value| {
    v["count"] = json!(1.5);
});
invalid_elicitation_case!(task5_form_rejects_numeric_range, |v: &mut Value| {
    v["count"] = json!(10);
});
invalid_elicitation_case!(task5_form_rejects_unknown_enum, |v: &mut Value| {
    v["color"] = json!("red");
});
invalid_elicitation_case!(task5_form_rejects_string_bounds, |v: &mut Value| {
    v["name"] = json!("x");
});
invalid_elicitation_case!(task5_form_rejects_array_enum, |v: &mut Value| {
    v["colors"] = json!(["red"]);
});
invalid_elicitation_case!(task5_form_rejects_extra_fields, |v: &mut Value| {
    v["extra"] = json!(true);
});

#[tokio::test]
async fn task5_form_and_url_actions_preserve_original_native_id_type() {
    let (state, peer, mut rx) = runtime().await;
    let mut keys = Vec::new();
    for id in [RequestId::Int(41), RequestId::Str("41".into())] {
        peer.request_client(&id, "mcpServer/elicitation/request", json!({"threadId":"thread-1","serverName":"contract","mode":"url","message":"Visit then confirm","url":"https://example.com","elicitationId":"public-url"}));
        let request = event(&mut rx).await;
        if id == RequestId::Int(41) {
            event(&mut rx).await;
        }
        assert_eq!(request["providerRequest"]["id"], id.to_json());
        keys.push(request["requestId"].clone());
    }
    assert_eq!(state.retained_control_events("thread-1").await.len(), 2);
    for (key, id, action) in [
        (&keys[1], json!("41"), "cancel"),
        (&keys[0], json!(41), "accept"),
    ] {
        state.handle_elicitation_respond(serde_json::from_value(json!({"provider":"codex","sessionType":"freshcodex","sessionId":"thread-1","requestId":key,"action":action,"content":null})).unwrap()).await;
        assert_eq!(
            peer.next_raw_frame().await.unwrap(),
            json!({"id":id,"result":{"action":action,"content":null}})
        );
        assert_eq!(
            event(&mut rx).await["type"],
            "freshAgent.elicitation.cancelled"
        );
    }
    peer.disconnect();
    state.shutdown().await;
}

#[tokio::test]
async fn task5_question_rejects_other_when_native_only_offers_choices() {
    let (state, peer, mut rx) = runtime().await;
    peer.request_client(&RequestId::Int(121),"item/tool/requestUserInput",json!({"threadId":"thread-1","turnId":"turn-1","isBlocking":false,"questions":[{"id":"pick","question":"Pick","isOther":false,"options":[{"label":"A","description":"Alpha"}]}]}));
    let request = event(&mut rx).await;
    event(&mut rx).await;
    state.handle_question_respond(serde_json::from_value(json!({"provider":"codex","sessionType":"freshcodex","sessionId":"thread-1","requestId":request["requestId"],"answers":{"pick":"unoffered"}})).unwrap()).await;
    assert_eq!(event(&mut rx).await["code"], "INVALID_ANSWER");
    peer.disconnect();
    state.shutdown().await;
}

#[test]
fn task5_async_agent_message_retains_delivery_and_native_identity() {
    let items=map_codex_item("async-question",&json!({"id":"async-question","type":"agentMessage","text":"Where?","delivery":"async","questions":[{"title":"Where?","options":["Staging","Production"]}]}),"agentMessage").unwrap();
    assert_eq!(items[0]["extensions"]["codex"]["delivery"], "async");
    assert_eq!(items[0]["extensions"]["codex"]["itemId"], "async-question");
}

#[tokio::test]
async fn task5_async_attention_is_nonblocking_deduplicated_and_does_not_hide_silent_work() {
    let (state, peer, mut rx) = runtime().await;
    state.set_codex_quiet_window_ms_for_tests(150);
    let item = json!({"threadId":"thread-1","turnId":"turn-1","item":{"id":"async-one","type":"agentMessage","text":"Work continues","delivery":"async","questions":[{"title":"Where?","options":["Staging","Production"]}]}});
    peer.emit_notification("item/completed", item.clone());
    let available = tokio::time::timeout(Duration::from_millis(500), async {
        loop {
            let value = event(&mut rx).await;
            if value["type"] == "freshAgent.question.available" {
                break value;
            }
        }
    })
    .await
    .expect("async question must emit an actionable, nonblocking attention edge");
    assert_eq!(available["awaited"], false);
    assert_eq!(available["itemId"], "async-one");
    assert!(available["at"].as_i64().is_some());
    assert!(
        state.retained_control_events("thread-1").await.is_empty(),
        "async questions never enter pending decisions"
    );
    peer.emit_notification("item/completed", item);
    peer.emit_notification("item/started",json!({"threadId":"thread-1","turnId":"turn-1","item":{"id":"command","type":"commandExecution","command":"keep working","status":"inProgress"}}));
    let stuck = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let value = event(&mut rx).await;
            assert_ne!(
                value["type"], "freshAgent.question.available",
                "same native item must not ring twice"
            );
            if value["status"] == "stuck" {
                break value;
            }
        }
    })
    .await
    .expect("ordinary owed work must still trip the quiet deadman");
    assert_eq!(stuck["status"], "stuck");
    assert!(
        tokio::time::timeout(Duration::from_millis(30), peer.next_raw_frame())
            .await
            .is_err(),
        "async visibility never creates a native response RPC"
    );
    peer.disconnect();
    state.shutdown().await;
}

#[tokio::test]
async fn task5_nonterminal_completion_cannot_cancel_awaited_controls() {
    let (state, peer, mut rx) = runtime().await;
    peer.request_client(&RequestId::Int(141),"item/tool/requestUserInput",json!({"threadId":"thread-1","turnId":"turn-1","isBlocking":false,"questions":[{"id":"q","question":"Question"}]}));
    event(&mut rx).await;
    event(&mut rx).await;
    peer.emit_notification(
        "turn/completed",
        json!({"threadId":"thread-1","turnId":"turn-1","status":"inProgress"}),
    );
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(state.retained_control_events("thread-1").await.len(), 1);
    while let Ok(raw) = rx.try_recv() {
        let frame: Value = serde_json::from_str(&raw).unwrap();
        assert_ne!(
            frame["event"]["type"], "freshAgent.question.cancelled",
            "nonterminal notification must not dismiss the question"
        );
    }
    peer.disconnect();
    state.shutdown().await;
}

#[tokio::test]
async fn task5_unrepresentable_openai_schema_is_declined_instead_of_silently_dropping_constraints()
{
    let (state, peer, mut rx) = runtime().await;
    peer.request_client(&RequestId::Int(151),"mcpServer/elicitation/request",json!({"threadId":"thread-1","serverName":"contract","mode":"openai/form","message":"Constrained form","requestedSchema":{"type":"object","properties":{"name":{"type":"string"}},"anyOf":[{"required":["name"]}]}}));
    let response = tokio::time::timeout(Duration::from_millis(300), peer.next_raw_frame())
        .await
        .expect("unsupported schema must release its native waiter")
        .unwrap();
    assert_eq!(
        response,
        json!({"id":151,"result":{"action":"decline","content":null}})
    );
    let notice = event(&mut rx).await;
    assert_eq!(notice["code"], "UNSUPPORTED_ELICITATION");
    assert!(notice["message"].as_str().unwrap().contains("flat"));
    peer.disconnect();
    state.shutdown().await;
}

#[tokio::test]
async fn task5_structured_only_approval_choices_are_explicitly_refused() {
    let (state, peer, mut rx) = runtime().await;
    peer.request_client(&RequestId::Int(161),"item/commandExecution/requestApproval",json!({"threadId":"thread-1","turnId":"turn-1","itemId":"command","availableDecisions":[{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["echo"]}}]}));
    let response = tokio::time::timeout(Duration::from_millis(300), peer.next_raw_frame())
        .await
        .expect("unsupported decision subtype must receive an explicit native refusal")
        .unwrap();
    assert!(response.get("error").is_some());
    assert_eq!(event(&mut rx).await["code"], "UNSUPPORTED_CAPABILITY");
    assert!(state.retained_control_events("thread-1").await.is_empty());
    peer.disconnect();
    state.shutdown().await;
}

#[tokio::test]
async fn task5_nonprimitive_form_default_is_declined_before_publication() {
    let (state, peer, mut rx) = runtime().await;
    peer.request_client(&RequestId::Int(171),"mcpServer/elicitation/request",json!({"threadId":"thread-1","serverName":"contract","mode":"openaiForm","message":"Form","requestedSchema":{"type":"object","properties":{"name":{"type":"string","default":{"nested":"value"}}}}}));
    let response = tokio::time::timeout(Duration::from_millis(300), peer.next_raw_frame())
        .await
        .expect("nonprimitive default must not break snapshot publication")
        .unwrap();
    assert_eq!(
        response,
        json!({"id":171,"result":{"action":"decline","content":null}})
    );
    assert_eq!(event(&mut rx).await["code"], "UNSUPPORTED_ELICITATION");
    peer.disconnect();
    state.shutdown().await;
}

#[tokio::test]
async fn task5_native_question_answers_require_question_ids_when_titles_repeat() {
    let (state, peer, mut rx) = runtime().await;
    peer.request_client(&RequestId::Int(181),"item/tool/requestUserInput",json!({"threadId":"thread-1","turnId":"turn-1","questions":[{"id":"first","question":"Same title"},{"id":"second","question":"Same title"}]}));
    let request = event(&mut rx).await;
    event(&mut rx).await;
    state.handle_question_respond(serde_json::from_value(json!({"provider":"codex","sessionType":"freshcodex","sessionId":"thread-1","requestId":request["requestId"],"answers":{"Same title":"ambiguous"}})).unwrap()).await;
    assert_eq!(event(&mut rx).await["code"], "INVALID_ANSWER");
    assert_eq!(state.retained_control_events("thread-1").await.len(), 1);
    peer.disconnect();
    state.shutdown().await;
}

#[tokio::test]
async fn task5_mcp_enum_names_are_labels_and_do_not_replace_native_values() {
    let (state, peer, mut rx) = runtime().await;
    peer.request_client(&RequestId::Int(191),"mcpServer/elicitation/request",json!({"threadId":"thread-1","serverName":"contract","mode":"form","message":"Pick","requestedSchema":{"type":"object","properties":{"color":{"type":"string","enum":["blue","green"],"enumNames":["Blue hue","Green hue"]}}}}));
    let request = event(&mut rx).await;
    assert_eq!(
        request["fields"][0]["choices"][0],
        json!({"value":"blue","label":"Blue hue"})
    );
    peer.disconnect();
    state.shutdown().await;
}

async fn task5_unsupported_field(field: Value) {
    let (state, peer, mut rx) = runtime().await;
    peer.request_client(&RequestId::Int(201),"mcpServer/elicitation/request",json!({"threadId":"thread-1","serverName":"contract","mode":"openaiForm","message":"Form","requestedSchema":{"type":"object","properties":{"field":field}}}));
    let response = tokio::time::timeout(Duration::from_millis(300), peer.next_raw_frame())
        .await
        .expect("unsupported field must release the native waiter")
        .unwrap();
    assert_eq!(
        response,
        json!({"id":201,"result":{"action":"decline","content":null}})
    );
    assert_eq!(event(&mut rx).await["code"], "UNSUPPORTED_ELICITATION");
    peer.disconnect();
    state.shutdown().await;
}
macro_rules! unsupported_field_case {
    ($name:ident,$field:expr) => {
        #[tokio::test]
        async fn $name() {
            task5_unsupported_field($field).await;
        }
    };
}
unsupported_field_case!(
    task5_unsupported_leaf_constraint,
    json!({"type":"string","allOf":[{"minLength":2}]})
);
unsupported_field_case!(
    task5_unsupported_description_type,
    json!({"type":"string","description":{"nested":"value"}})
);
unsupported_field_case!(
    task5_unsupported_numeric_bound_type,
    json!({"type":"number","minimum":"one"})
);
unsupported_field_case!(
    task5_unsupported_format,
    json!({"type":"string","format":"unknown-format"})
);
unsupported_field_case!(
    task5_unsupported_array_item_type,
    json!({"type":"array","items":{"type":"integer","enum":["blue"]}})
);
unsupported_field_case!(
    task5_unsupported_secret_hint_type,
    json!({"type":"string","writeOnly":"yes"})
);

#[test]
fn task5_rejects_non_array_required_metadata() {
    assert!(elicitation::normalize(&json!({"mode":"openaiForm","serverName":"contract","message":"Form","requestedSchema":{"type":"object","required":"field","properties":{"field":{"type":"string"}}}})).is_none());
}
#[test]
fn task5_rejects_non_array_enum_metadata() {
    assert!(elicitation::normalize(&json!({"mode":"openai/form","serverName":"contract","message":"Form","requestedSchema":{"type":"object","properties":{"field":{"type":"string","enum":"blue"}}}})).is_none());
}

#[test]
fn task5_rejects_non_string_url_identity_before_publication() {
    assert!(elicitation::normalize(&json!({"mode":"url","serverName":"contract","message":"Visit","url":"https://example.com","elicitationId":{"nested":"unsupported"}})).is_none());
}

#[tokio::test]
async fn task5_approval_and_elicitation_waiters_pause_quiet_deadman() {
    for (method, params) in [
        (
            "item/commandExecution/requestApproval",
            json!({"command":"fixture","availableDecisions":["cancel"]}),
        ),
        (
            "mcpServer/elicitation/request",
            json!({"mode":"url","serverName":"contract","message":"Visit","url":"https://example.com","elicitationId":"url-id"}),
        ),
    ] {
        let (state, peer, mut rx) = runtime().await;
        state.set_codex_quiet_window_ms_for_tests(60);
        let mut params = params;
        params["threadId"] = json!("thread-1");
        params["turnId"] = json!("turn-1");
        peer.request_client(&RequestId::Int(271), method, params);
        event(&mut rx).await;
        assert_eq!(event(&mut rx).await["type"], "freshAgent.turn.waiting");
        assert_eq!(state.awaited_control_count("thread-1"), 1);
        tokio::time::sleep(Duration::from_millis(240)).await;
        while let Ok(frame) = rx.try_recv() {
            let frame: Value = serde_json::from_str(&frame).unwrap();
            assert_ne!(frame["event"]["status"], "stuck");
            assert_ne!(frame["event"]["type"], "freshAgent.turn.complete");
        }
        peer.disconnect();
        state.shutdown().await;
    }
}

#[tokio::test]
async fn task5_secret_form_defaults_stay_private_while_original_native_identity_is_retained() {
    let (state, peer, mut rx) = runtime().await;
    let secret = "sensitive-default-fixture";
    peer.request_client(&RequestId::Int(211),"mcpServer/elicitation/request",json!({"threadId":"thread-1","serverName":"contract","mode":"openaiForm","message":"Form","requestedSchema":{"type":"object","properties":{"token":{"type":"string","writeOnly":true,"default":secret}},"required":["token"]}}));
    let request = event(&mut rx).await;
    assert_eq!(request["providerRequest"]["id"], 211);
    assert_eq!(
        request["providerRequest"]["method"],
        "mcpServer/elicitation/request"
    );
    assert!(
        !request.to_string().contains(secret),
        "secret defaults must not enter public controls or durable permission events"
    );
    let snapshot = snapshot(&state, &peer).await;
    assert!(!snapshot["pendingElicitations"].to_string().contains(secret));
    peer.disconnect();
    state.shutdown().await;
}

#[tokio::test]
async fn task5_reissued_native_id_rejects_old_public_answer_but_duplicate_replay_is_stable() {
    let (state, peer, mut rx) = runtime().await;
    let params = json!({"threadId":"thread-1","turnId":"turn-1","questions":[{"id":"answer","question":"Current question"}]});
    peer.request_client(
        &RequestId::Int(251),
        "item/tool/requestUserInput",
        params.clone(),
    );
    let original = event(&mut rx).await;
    event(&mut rx).await;
    peer.request_client(
        &RequestId::Int(251),
        "item/tool/requestUserInput",
        params.clone(),
    );
    assert_eq!(event(&mut rx).await["requestId"], original["requestId"]);
    assert_eq!(
        snapshot(&state, &peer).await["pendingQuestions"][0]["requestId"],
        original["requestId"]
    );
    assert_eq!(state.awaited_control_count("thread-1"), 1);
    peer.emit_notification(
        "serverRequest/resolved",
        json!({"threadId":"thread-1","requestId":251}),
    );
    assert_eq!(event(&mut rx).await["requestId"], original["requestId"]);
    peer.request_client(&RequestId::Int(251), "item/tool/requestUserInput", params);
    let current = event(&mut rx).await;
    event(&mut rx).await;
    assert_ne!(
        current["requestId"], original["requestId"],
        "a new native operation must not accept an old browser answer"
    );
    let answer = |key: &Value| {
        serde_json::from_value(json!({"provider":"codex","sessionType":"freshcodex","sessionId":"thread-1","requestId":key,"answers":{"answer":"exact value"}})).unwrap()
    };
    assert!(
        !state
            .try_handle_question_respond(answer(&original["requestId"]))
            .await
    );
    assert_eq!(event(&mut rx).await["code"], "REQUEST_UNAVAILABLE");
    assert_eq!(state.awaited_control_count("thread-1"), 1);
    assert!(
        state
            .try_handle_question_respond(answer(&current["requestId"]))
            .await
    );
    assert_eq!(
        peer.next_raw_frame().await.unwrap(),
        json!({"id":251,"result":{"answers":{"answer":{"answers":["exact value"]}}}})
    );
    peer.disconnect();
    state.shutdown().await;
}

#[tokio::test]
async fn task5_pending_answer_cannot_cross_native_client_incarnations() {
    let (state, peer, mut rx) = runtime().await;
    peer.request_client(&RequestId::Int(253), "item/tool/requestUserInput", json!({"threadId":"thread-1","turnId":"turn-1","questions":[{"id":"answer","question":"Old native client"}]}));
    let original = event(&mut rx).await;
    event(&mut rx).await;
    let (transport, new_peer) = freshell_codex::new_channel_transport();
    let (client, _notifications) = CodexAppServerClient::connect(transport);
    state
        .sessions
        .lock()
        .await
        .get_mut("thread-1")
        .unwrap()
        .client = Arc::new(client);
    assert!(!state.try_handle_question_respond(serde_json::from_value(json!({"provider":"codex","sessionType":"freshcodex","sessionId":"thread-1","requestId":original["requestId"],"answers":{"answer":"stale answer"}})).unwrap()).await, "an old question must not be written into the new native client");
    assert_eq!(event(&mut rx).await["code"], "REQUEST_UNAVAILABLE");
    assert!(
        tokio::time::timeout(Duration::from_millis(30), new_peer.next_raw_frame())
            .await
            .is_err()
    );
    peer.disconnect();
    new_peer.disconnect();
    state.shutdown().await;
}

#[tokio::test]
async fn task5_retired_turn_cannot_register_a_new_awaited_question() {
    let (state, peer, mut rx) = runtime().await;
    *state
        .sessions
        .lock()
        .await
        .get("thread-1")
        .unwrap()
        .retired_turn_id
        .lock()
        .unwrap() = Some("retired-turn".into());
    peer.request_client(&RequestId::Int(281), "item/tool/requestUserInput", json!({"threadId":"thread-1","turnId":"retired-turn","questions":[{"id":"answer","question":"Retired question"}]}));
    let response = tokio::time::timeout(Duration::from_millis(300), peer.next_raw_frame())
        .await
        .expect("a retired turn's late control must receive a native refusal")
        .unwrap();
    assert_eq!(response["id"], 281);
    assert!(response.get("error").is_some());
    assert_eq!(event(&mut rx).await["code"], "REQUEST_UNAVAILABLE");
    assert_eq!(state.awaited_control_count("thread-1"), 0);
    assert!(state.retained_control_events("thread-1").await.is_empty());
    peer.disconnect();
    state.shutdown().await;
}

#[tokio::test]
async fn task5_control_diagnostics_keep_locators_and_severity_without_secret_payloads() {
    use crate::claude_sidecar_io::test_capture::{capture, with_message};
    let (events, _guard) = capture();
    let (state, peer, mut rx) = runtime().await;
    let secret = "sensitive-answer-fixture";
    peer.request_client(&RequestId::Int(261), "mcpServer/elicitation/request", json!({"threadId":"thread-1","turnId":"turn-1","itemId":"form-item","serverName":"contract","mode":"form","requestedSchema":{"type":"object","properties":{"token":{"type":"object","default":secret}}}}));
    assert_eq!(
        peer.next_raw_frame().await.unwrap()["result"]["action"],
        "decline"
    );
    assert_eq!(event(&mut rx).await["code"], "UNSUPPORTED_ELICITATION");
    peer.request_client(&RequestId::Int(262), "item/tool/requestUserInput", json!({"threadId":"thread-1","turnId":"turn-1","itemId":"question-item","questions":[{"id":"token","question":"Secret?","isSecret":true,"isOther":false,"options":[{"label":"offered","description":"A choice"}]}]}));
    let request = event(&mut rx).await;
    event(&mut rx).await;
    assert!(!state.try_handle_question_respond(serde_json::from_value(json!({"provider":"codex","sessionType":"freshcodex","sessionId":"thread-1","requestId":request["requestId"],"answers":{"token":secret}})).unwrap()).await);
    assert_eq!(event(&mut rx).await["code"], "INVALID_ANSWER");
    let invalid = with_message(&events, "freshagent.codex.invalid_control_answer");
    assert_eq!(invalid.len(), 1);
    assert_eq!(invalid[0].level, tracing::Level::WARN);
    assert_eq!(invalid[0].field("native_item_id"), Some("question-item"));
    let unsupported = with_message(&events, "freshagent.codex.unsupported_request");
    assert_eq!(unsupported.len(), 1);
    assert_eq!(unsupported[0].level, tracing::Level::WARN);
    assert_eq!(unsupported[0].field("native_turn_id"), Some("turn-1"));
    assert!(!format!("{:?}", events.lock().unwrap()).contains(secret));
    peer.disconnect();
    state.shutdown().await;
}

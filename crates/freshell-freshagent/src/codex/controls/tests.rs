use super::*;
use crate::codex::tests::{insert_fake_session_with_real_consumer, spawn_sleeper, state_with_bus};
use freshell_codex::ChannelPeer;

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

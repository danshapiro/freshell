//! End-to-end scripted drive of the codex app-server client over the in-memory
//! [`ChannelTransport`] — NO real app-server, NO live API calls. Proves the full CORE path
//! the T2-over-rust step (3.8b) will later run live: connect → initialize→initialized
//! handshake → `thread/start` → `turn/start` (**effort forwarded VERBATIM**, DEV-0003) →
//! `turn/completed` notification → the STATUS-GUARDED positive completion edge.
//!
//! The server side is scripted with the committed fake-app-server's message shapes
//! (`test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs`).

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use freshell_codex::{
    new_channel_transport, to_codex_reasoning_effort, ClientFrame, CodexAdapterEvent,
    CodexAppServerClient, CodexNotification, CodexSubscription, StartThreadParams, StartTurnParams,
};

const THREAD_ID: &str = "019810de-1e5f-7db3-9c47-1c2a3b4c5d6e";

/// Script the initialize handshake: respond to the initialize request, consume `initialized`.
async fn drive_handshake(peer: &freshell_codex::ChannelPeer) {
    let (id, method, _params) = peer.expect_request().await;
    assert_eq!(method, "initialize");
    peer.respond(
        &id,
        json!({ "userAgent": "codex-cli 0.142.5", "codexHome": "/h", "platformFamily": "unix", "platformOs": "linux" }),
    );
    let (note, _) = peer.expect_notification().await;
    assert_eq!(note, "initialized");
}

#[tokio::test]
async fn full_drive_completed_turn_emits_the_positive_edge_with_verbatim_effort() {
    let (transport, peer) = new_channel_transport();
    let (client, mut notifs) = CodexAppServerClient::connect(transport);
    let client = Arc::new(client);

    // Drive create + send on a task (they block on the scripted server).
    let driver = {
        let client = client.clone();
        tokio::spawn(async move {
            let started = client
                .start_thread(StartThreadParams {
                    cwd: Some("/work".to_string()),
                    model: Some("gpt-5.3-codex-spark".to_string()),
                    sandbox: Some("workspace-write".to_string()),
                    approval_policy: Some("never".to_string()),
                })
                .await
                .expect("thread/start");
            assert_eq!(started.thread_id, THREAD_ID);

            // The effort is wire-mapped by the model layer, then forwarded verbatim by the client.
            let effort = to_codex_reasoning_effort(Some("none"))
                .expect("map")
                .unwrap();
            let turn = client
                .start_turn(StartTurnParams {
                    thread_id: THREAD_ID.to_string(),
                    input: vec![json!({ "type": "text", "text": "freshell-t2-ok" })],
                    cwd: Some("/work".to_string()),
                    model: Some("gpt-5.3-codex-spark".to_string()),
                    effort: Some(effort),
                    sandbox_policy: Some(json!({ "type": "workspaceWrite" })),
                    approval_policy: Some(json!("never")),
                })
                .await
                .expect("turn/start");
            assert_eq!(turn.turn_id, "turn-1");
        })
    };

    // ── server script ────────────────────────────────────────────────────────────────
    drive_handshake(&peer).await;

    // thread/start
    let (start_id, start_method, start_params) = peer.expect_request().await;
    assert_eq!(start_method, "thread/start");
    assert_eq!(start_params["model"], json!("gpt-5.3-codex-spark"));
    assert_eq!(start_params["persistExtendedHistory"], json!(true));
    peer.respond(
        &start_id,
        json!({ "thread": { "id": THREAD_ID }, "reasoningEffort": "none" }),
    );

    // turn/start — DEV-0003: effort crosses the wire VERBATIM as "none".
    let (turn_id, turn_method, turn_params) = peer.expect_request().await;
    assert_eq!(turn_method, "turn/start");
    assert_eq!(turn_params["threadId"], json!(THREAD_ID));
    assert_eq!(
        turn_params["effort"],
        json!("none"),
        "DEV-0003: none forwarded verbatim"
    );
    peer.respond(&turn_id, json!({ "turn": { "id": "turn-1" } }));

    driver.await.expect("driver task");

    // The server later emits turn/completed(completed) — the async completion.
    peer.emit_notification(
        "turn/completed",
        json!({ "threadId": THREAD_ID, "turnId": "turn-1", "turn": { "id": "turn-1", "status": "completed" } }),
    );

    // The consumer classifies it; the subscription gate turns it into the positive edge.
    let mut sub = CodexSubscription::new(THREAD_ID);
    let notification = notifs.recv().await.expect("a notification");
    let events = match notification {
        CodexNotification::TurnCompleted(ev) => sub.on_turn_completed(&ev, 1_700_000_000_000),
        other => panic!("expected TurnCompleted, got {other:?}"),
    };
    assert!(
        events
            .iter()
            .any(|e| matches!(e, CodexAdapterEvent::TurnComplete { .. })),
        "completed → the positive sdk.turn.complete edge fired: {events:?}"
    );
}

#[tokio::test]
async fn full_drive_interrupted_turn_does_not_chime() {
    let (transport, peer) = new_channel_transport();
    let (client, mut notifs) = CodexAppServerClient::connect(transport);
    let client = Arc::new(client);

    let driver = {
        let client = client.clone();
        tokio::spawn(async move {
            client
                .start_thread(StartThreadParams::default())
                .await
                .expect("thread/start");
            // minimal effort — the OTHER DEV-0003 verbatim value.
            let effort = to_codex_reasoning_effort(Some("minimal"))
                .expect("map")
                .unwrap();
            client
                .start_turn(StartTurnParams {
                    thread_id: THREAD_ID.to_string(),
                    input: vec![json!({ "type": "text", "text": "hi" })],
                    cwd: None,
                    model: None,
                    effort: Some(effort),
                    sandbox_policy: None,
                    approval_policy: None,
                })
                .await
                .expect("turn/start");
        })
    };

    drive_handshake(&peer).await;
    let (start_id, _m, _p) = peer.expect_request().await;
    peer.respond(&start_id, json!({ "thread": { "id": THREAD_ID } }));
    let (turn_id, _m, turn_params) = peer.expect_request().await;
    assert_eq!(
        turn_params["effort"],
        json!("minimal"),
        "DEV-0003: minimal forwarded verbatim"
    );
    peer.respond(&turn_id, json!({ "turn": { "id": "turn-1" } }));
    driver.await.expect("driver task");

    // An interrupt arrives as turn/completed with status 'interrupted' — must NOT chime.
    peer.emit_notification(
        "turn/completed",
        json!({ "threadId": THREAD_ID, "turnId": "turn-1", "turn": { "id": "turn-1", "status": "interrupted" } }),
    );

    let mut sub = CodexSubscription::new(THREAD_ID);
    let notification = notifs.recv().await.expect("a notification");
    let events = match notification {
        CodexNotification::TurnCompleted(ev) => sub.on_turn_completed(&ev, 1_700_000_000_000),
        other => panic!("expected TurnCompleted, got {other:?}"),
    };
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, CodexAdapterEvent::TurnComplete { .. })),
        "interrupted → NO chime: {events:?}"
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, CodexAdapterEvent::StatusSnapshot { .. })),
        "interrupted still emits the idle snapshot"
    );
}

#[tokio::test]
async fn rpc_error_on_turn_start_surfaces_to_the_caller() {
    let (transport, peer) = new_channel_transport();
    let (client, _notifs) = CodexAppServerClient::connect(transport);
    let client = Arc::new(client);

    let driver = {
        let client = client.clone();
        tokio::spawn(async move {
            client
                .start_thread(StartThreadParams::default())
                .await
                .expect("thread/start");
            client
                .start_turn(StartTurnParams {
                    thread_id: THREAD_ID.to_string(),
                    input: vec![json!({ "type": "text", "text": "hi" })],
                    cwd: None,
                    model: None,
                    effort: None,
                    sandbox_policy: None,
                    approval_policy: None,
                })
                .await
        })
    };

    drive_handshake(&peer).await;
    let (start_id, _m, _p) = peer.expect_request().await;
    peer.respond(&start_id, json!({ "thread": { "id": THREAD_ID } }));
    let (turn_id, _m, _p) = peer.expect_request().await;
    peer.respond_error(&turn_id, -32000, "turn rejected");

    let result = driver.await.expect("driver task");
    assert!(
        result.is_err(),
        "an RPC error on turn/start propagates: {result:?}"
    );
}

/// The client→server request framing is exactly `{ id, method, params }` with no `jsonrpc`
/// tag (faithful to `client.ts:796`; the real cli tolerates its absence).
#[tokio::test]
async fn client_request_frames_carry_no_jsonrpc_tag() {
    let (transport, peer) = new_channel_transport();
    let (client, _notifs) = CodexAppServerClient::connect(transport);
    let client = Arc::new(client);

    let driver = {
        let client = client.clone();
        tokio::spawn(async move { client.initialize().await })
    };

    // Inspect the raw initialize frame shape.
    match peer.next_frame().await.expect("frame") {
        ClientFrame::Request { id, method, params } => {
            assert_eq!(method, "initialize");
            assert!(params.get("clientInfo").is_some());
            peer.respond(&id, json!({ "userAgent": "x", "codexHome": "/h", "platformFamily": "u", "platformOs": "l" }));
        }
        other => panic!("expected a request, got {other:?}"),
    }
    // The follow-up initialized notification has no id.
    assert!(matches!(
        peer.next_frame().await,
        Some(ClientFrame::Notification { .. })
    ));

    tokio::time::timeout(Duration::from_secs(1), driver)
        .await
        .expect("initialize completes")
        .expect("task")
        .expect("initialize ok");
}

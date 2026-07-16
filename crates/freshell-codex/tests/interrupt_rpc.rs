//! `turn/interrupt` RPC round-trip -> the STATUS-GUARDED reducer. Proves the full interrupt
//! path a live `freshAgent.interrupt` drives (`server/fresh-agent/adapters/codex/adapter.ts`
//! `interrupt(sessionId)`, `:1004-1021`): issuing `turn/interrupt` produces the exact wire
//! frame the app-server expects, and the app-server's resulting
//! `turn/completed{status:'interrupted'}` notification yields an idle
//! `freshAgent.session.snapshot`-shaped event with NO positive chime (`:911-928`).

use std::sync::Arc;

use serde_json::json;

use freshell_codex::{
    new_channel_transport, CodexAdapterEvent, CodexAppServerClient, CodexNotification,
    CodexSubscription, StartThreadParams, StartTurnParams,
};

const THREAD_ID: &str = "019810de-1e5f-7db3-9c47-1c2a3b4c5d6e";

#[tokio::test]
async fn interrupt_turn_rpc_then_interrupted_completion_snapshots_without_chime() {
    let (transport, peer) = new_channel_transport();
    let (client, mut notifs) = CodexAppServerClient::connect(transport);
    let client = Arc::new(client);

    let driver = {
        let client = client.clone();
        tokio::spawn(async move {
            client.start_thread(StartThreadParams::default()).await.expect("thread/start");
            let turn = client
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
                .expect("turn/start");
            client.interrupt_turn(THREAD_ID, &turn.turn_id).await.expect("turn/interrupt");
        })
    };

    // initialize -> thread/start -> turn/start (scripted, as in app_server_drive.rs).
    let (init_id, _m, _p) = peer.expect_request().await;
    peer.respond(
        &init_id,
        json!({ "userAgent": "x", "codexHome": "/h", "platformFamily": "u", "platformOs": "l" }),
    );
    let _ = peer.expect_notification().await;
    let (start_id, _m, _p) = peer.expect_request().await;
    peer.respond(&start_id, json!({ "thread": { "id": THREAD_ID } }));
    let (turn_id, _m, _p) = peer.expect_request().await;
    peer.respond(&turn_id, json!({ "turn": { "id": "turn-1" } }));

    // turn/interrupt -- assert the exact params shape (client.ts:433-439).
    let (interrupt_id, interrupt_method, interrupt_params) = peer.expect_request().await;
    assert_eq!(interrupt_method, "turn/interrupt");
    assert_eq!(interrupt_params["threadId"], json!(THREAD_ID));
    assert_eq!(interrupt_params["turnId"], json!("turn-1"));
    peer.respond(&interrupt_id, json!({}));

    driver.await.expect("driver task");

    // The app-server settles the interrupted turn asynchronously.
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
        events.iter().any(|e| matches!(e, CodexAdapterEvent::StatusSnapshot { .. })),
        "an idle snapshot always fires: {events:?}"
    );
    assert!(
        !events.iter().any(|e| matches!(e, CodexAdapterEvent::TurnComplete { .. })),
        "an interrupt must NEVER chime: {events:?}"
    );
}

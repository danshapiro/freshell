//! Real socket protocol coverage without provider binaries or PTY processes.
mod common;
use common::TestWs;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

async fn receive(ws: &mut TestWs, kind: &str) -> Value {
    tokio::time::timeout(common::FRAME_BUDGET, async {
        loop {
            match ws
                .next()
                .await
                .expect("socket remains open")
                .expect("valid frame")
            {
                Message::Text(text) => {
                    let value: Value = serde_json::from_str(&text).expect("JSON");
                    if value["type"] == kind {
                        return value;
                    }
                    assert_ne!(value["type"], "error", "unexpected error: {value}");
                }
                Message::Ping(bytes) => {
                    ws.send(Message::Pong(bytes)).await.unwrap();
                }
                Message::Close(_) => panic!("unexpected close"),
                _ => {}
            }
        }
    })
    .await
    .expect("bounded frame receive")
}
async fn connect(url: &str, opt_in: bool) -> (TestWs, Value) {
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    let mut hello = json!({"type":"hello","token":common::AUTH_TOKEN,
        "protocolVersion":freshell_protocol::WS_PROTOCOL_VERSION});
    if opt_in {
        hello["capabilities"] = json!({"terminalInterestV1":true});
    }
    ws.send(Message::Text(hello.to_string())).await.unwrap();
    let ready = receive(&mut ws, "ready").await;
    receive(&mut ws, "terminal.inventory").await;
    (ws, ready)
}
async fn send(ws: &mut TestWs, value: Value) {
    ws.send(Message::Text(value.to_string())).await.unwrap();
}

#[tokio::test]
async fn capability_is_advertised_only_to_opted_in_connection() {
    let (url, _) = common::spawn_server_with_specs(vec![]).await;
    let (_old, old_ready) = connect(&url, false).await;
    assert!(old_ready["capabilities"]["terminalInterestV1"].is_null());
    let (_new, new_ready) = connect(&url, true).await;
    assert_eq!(new_ready["capabilities"]["terminalInterestV1"], true);
}
#[tokio::test]
async fn accepted_snapshot_never_creates_or_attaches_a_terminal() {
    let (url, registry) = common::spawn_server_with_specs(vec![]).await;
    let (mut ws, _) = connect(&url, true).await;
    send(
        &mut ws,
        json!({"type":"terminal.interest","revision":1,
        "focusedTerminalId":"not-a-terminal","visibleTerminalIds":["not-a-terminal"]}),
    )
    .await;
    send(&mut ws, json!({"type":"ping"})).await;
    receive(&mut ws, "pong").await; // fences the preceding typed dispatch
    assert!(registry.directory().is_empty());
}
#[tokio::test]
async fn unnegotiated_interest_is_rejected_without_disconnecting() {
    let (url, _) = common::spawn_server_with_specs(vec![]).await;
    let (mut ws, _) = connect(&url, false).await;
    send(
        &mut ws,
        json!({"type":"terminal.interest","revision":1,
        "focusedTerminalId":null,"visibleTerminalIds":[]}),
    )
    .await;
    assert_eq!(receive(&mut ws, "error").await["code"], "INVALID_MESSAGE");
    send(&mut ws, json!({"type":"ping"})).await;
    receive(&mut ws, "pong").await;
}
#[tokio::test]
async fn malformed_and_stale_snapshots_have_bounded_non_destructive_handling() {
    let (url, _) = common::spawn_server_with_specs(vec![]).await;
    let (mut ws, _) = connect(&url, true).await;
    send(
        &mut ws,
        json!({"type":"terminal.interest","revision":2,
        "focusedTerminalId":"A","visibleTerminalIds":["A"]}),
    )
    .await;
    send(
        &mut ws,
        json!({"type":"terminal.interest","revision":1,
        "focusedTerminalId":null,"visibleTerminalIds":[]}),
    )
    .await;
    send(&mut ws, json!({"type":"ping"})).await;
    receive(&mut ws, "pong").await;
    send(
        &mut ws,
        json!({"type":"terminal.interest","revision":3,
        "focusedTerminalId":"B","visibleTerminalIds":["A"]}),
    )
    .await;
    assert_eq!(receive(&mut ws, "error").await["code"], "INVALID_MESSAGE");
    send(&mut ws, json!({"type":"ping"})).await;
    receive(&mut ws, "pong").await;
}

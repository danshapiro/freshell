mod common;

use common::claude_rig::{ClaudeRig, RigKind, RIG_FRAME_BUDGET};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

async fn ready(rig: &ClaudeRig, replay: bool) -> Value {
    let (mut socket, _) = tokio_tungstenite::connect_async(&rig.url).await.unwrap();
    socket
        .send(Message::Text(
            json!({
                "type": "hello", "token": common::AUTH_TOKEN,
                "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
                "capabilities": { "freshAgentAttentionReplayV1": replay },
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    let frame = tokio::time::timeout(RIG_FRAME_BUDGET, socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let Message::Text(frame) = frame else {
        panic!("the first frame is ready");
    };
    let value: Value = serde_json::from_str(&frame).unwrap();
    assert_eq!(
        value["type"], "ready",
        "the snapshot precedes live frames: {value}"
    );
    value
}

fn mark<'a>(ready: &'a Value, session_id: &str) -> &'a Value {
    ready["freshAgentAttention"]
        .as_array()
        .unwrap_or_else(|| panic!("attention snapshot missing: {ready}"))
        .iter()
        .find(|mark| mark["sessionId"] == session_id)
        .unwrap_or_else(|| panic!("session {session_id} missing: {ready}"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ready_retains_created_and_completed_sessions_only_for_opted_in_clients() {
    let rig = ClaudeRig::start(RigKind::Sim).await;
    let mut first = rig.connect().await;
    let session_id = first.create("create-1").await;
    let created = ready(&rig, true).await;
    assert!(mark(&created, &session_id)
        .get("lastTurnCompleteAt")
        .is_none());
    first.send_text(&session_id, "send-1", "hello").await;
    let edge = first.wait_for_event("freshAgent.turn.complete").await;
    let reconnect = ready(&rig, true).await;
    assert_eq!(
        mark(&reconnect, &session_id)["lastTurnCompleteAt"],
        edge["event"]["at"]
    );
    assert_eq!(mark(&reconnect, &session_id)["provider"], "claude");
    assert!(ready(&rig, false)
        .await
        .get("freshAgentAttention")
        .is_none());
    first.kill(&session_id).await;
    assert!(ready(&rig, true).await.get("freshAgentAttention").is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ready_replays_waiting_only_until_the_last_control_is_answered() {
    let program = json!({ "rules": [{
        "on": "msg:prompt", "match": { "text": "ask" },
        "emit": [{ "kind": "approval", "data": { "tool": "Bash", "input": { "command": "ls" } } }],
    }] })
    .to_string();
    let rig =
        ClaudeRig::start_with_env(RigKind::Sim, &[("FRESHELL_CLAUDE_SIM_PROGRAM", &program)]).await;
    let mut first = rig.connect().await;
    let created = first
        .request_create("create-approval", json!({ "permissionMode": "default" }))
        .await;
    let session_id = created["sessionId"].as_str().unwrap().to_string();
    first.send_text(&session_id, "send-approval", "ask").await;
    let request = first.wait_for_event("freshAgent.permission.request").await;
    let waiting = first.wait_for_event("freshAgent.turn.waiting").await;
    let reconnect = ready(&rig, true).await;
    assert_eq!(
        mark(&reconnect, &session_id)["lastWaitingAt"],
        waiting["event"]["at"]
    );
    first.send(json!({
        "type": "freshAgent.approval.respond", "provider": "claude", "sessionType": "freshclaude",
        "sessionId": session_id, "requestId": request["event"]["requestId"],
        "decision": { "behavior": "allow", "updatedInput": { "command": "ls" } },
    })).await;
    let complete = first.wait_for_event("freshAgent.turn.complete").await;
    let reconnect = ready(&rig, true).await;
    assert!(mark(&reconnect, &session_id).get("lastWaitingAt").is_none());
    assert_eq!(
        mark(&reconnect, &session_id)["lastTurnCompleteAt"],
        complete["event"]["at"]
    );
    first.kill(&session_id).await;
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ready_retains_a_crashed_turn_but_not_its_dead_approval() {
    let program = json!({ "rules": [{
        "on": "msg:prompt", "match": { "text": "ask" },
        "emit": [{ "kind": "approval", "data": { "tool": "Bash", "input": { "command": "ls" } } }],
    }] })
    .to_string();
    let rig =
        ClaudeRig::start_with_env(RigKind::Sim, &[("FRESHELL_CLAUDE_SIM_PROGRAM", &program)]).await;
    let mut first = rig.connect().await;
    let created = first
        .request_create("create-crash", json!({ "permissionMode": "default" }))
        .await;
    let session_id = created["sessionId"].as_str().unwrap().to_string();
    first.send_text(&session_id, "send-crash", "ask").await;
    first.wait_for_event("freshAgent.turn.waiting").await;
    assert!(mark(&ready(&rig, true).await, &session_id)
        .get("lastWaitingAt")
        .is_some());
    rig.kill_first_sidecar(&mut first).await;
    let edge = first.wait_for_event("freshAgent.turn.complete").await;
    let reconnect = ready(&rig, true).await;
    assert_eq!(
        mark(&reconnect, &session_id)["lastTurnCompleteAt"],
        edge["event"]["at"]
    );
    assert!(mark(&reconnect, &session_id).get("lastWaitingAt").is_none());
}

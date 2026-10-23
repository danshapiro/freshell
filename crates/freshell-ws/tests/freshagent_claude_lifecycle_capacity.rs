//! A queued command stays attributable until its terminal lifecycle fact, even
//! when one session has more than the sidecar's former 256-id retention limit.
//! The real sidecar runs over the CLI simulator behind the real WS server.

mod common;

use std::time::Duration;

use common::claude_rig::{ClaudeRig, RigConnection, RigKind, RIG_FRAME_BUDGET};
use serde_json::json;

const QUEUED_COMMANDS: usize = 257;

async fn wait_for_results(conn: &mut RigConnection, count: usize) {
    let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
    while conn.events_seen("freshAgent.result") < count {
        assert!(
            tokio::time::Instant::now() < deadline,
            "only {} of {count} results arrived; frames: {:?}",
            conn.events_seen("freshAgent.result"),
            conn.frames
        );
        conn.read_for(Duration::from_millis(50)).await;
    }
}

async fn wait_for_idle(conn: &mut RigConnection, session_id: &str, result_count: usize) {
    let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
    loop {
        let last_status = conn.frames.iter().rev().find_map(|frame| {
            (frame["type"] == "freshAgent.event"
                && frame["event"]["type"] == "freshAgent.status"
                && frame["sessionId"] == session_id)
                .then(|| frame["event"]["status"].as_str())
                .flatten()
        });
        if conn.events_seen("freshAgent.result") >= result_count && last_status == Some("idle") {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the session did not become idle after {result_count} results; last status: {last_status:?}; frames: {:?}",
            conn.frames
        );
        conn.read_for(Duration::from_millis(50)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_backlog_over_256_commands_returns_the_turn_ledger_to_idle() {
    let rig =
        ClaudeRig::start_with_env(RigKind::Sim, &[("FRESHELL_CLAUDE_SIM_TIME_SCALE", "0")]).await;
    let mut conn = rig.connect().await;
    let session_id = conn.create("create-capacity").await;

    conn.send_text(&session_id, "send-hang", "HANG").await;
    conn.wait_for_event("freshAgent.session.init").await;

    // Keep the first turn in flight while every following send waits in the
    // CLI queue. Await each acceptance so every queued command reached the sidecar.
    for index in 0..QUEUED_COMMANDS {
        let request_id = format!("queued-{index}");
        conn.send_text(&session_id, &request_id, "queued command")
            .await;
        conn.wait_for(&format!("acceptance for {request_id}"), |frame| {
            frame["type"] == "freshAgent.send.accepted" && frame["requestId"] == request_id
        })
        .await;
    }

    conn.send(json!({
        "type": "freshAgent.interrupt",
        "provider": "claude",
        "sessionType": "freshclaude",
        "sessionId": session_id,
    }))
    .await;

    // Stop ends the in-flight HANG command; all queued commands still run.
    // Each terminal result must retire its own started UUID from the ledger.
    let expected_results = QUEUED_COMMANDS + 1;
    wait_for_results(&mut conn, expected_results).await;
    wait_for_idle(&mut conn, &session_id, expected_results).await;
    assert_eq!(
        conn.events_seen("freshAgent.result"),
        expected_results,
        "the interrupted turn and every queued send settled"
    );
}

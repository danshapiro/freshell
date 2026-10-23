//! A stalled sidecar stdin belongs to one runtime. Other sessions remain usable,
//! and a timed-out write ends the stalled runtime through the normal EOF path.
//! Run in the disposable runtime sandbox: these tests deliberately wedge a child.

mod common;

use std::time::Duration;

use common::claude_rig::{ClaudeRig, RigConnection, RigKind, RIG_FRAME_BUDGET};
use freshell_freshagent::ClaudeSendOutcome;
use freshell_protocol::{FreshAgentKill, FreshAgentSend, SessionType};
use serde_json::json;

fn send(session_id: &str, request_id: &str, text: String) -> FreshAgentSend {
    serde_json::from_value(json!({
        "type": "freshAgent.send", "provider": "claude", "sessionType": "freshclaude",
        "sessionId": session_id, "requestId": request_id, "text": text,
    }))
    .unwrap()
}

async fn stalled_rig(timeout_ms: &str) -> (ClaudeRig, RigConnection, String) {
    let program = json!({"rules": [{
        "on": "msg:prompt", "match": {"text": "stall now"},
        "emit": [{"kind": "stall_stdin"}, {"kind": "hang"}],
    }]})
    .to_string();
    let rig = ClaudeRig::start_with_env(
        RigKind::Sim,
        &[
            ("FRESHELL_CLAUDE_SIM_PROGRAM", &program),
            ("FRESHELL_FRESHCLAUDE_WRITE_TIMEOUT_MS", timeout_ms),
        ],
    )
    .await;
    let mut conn = rig.connect().await;
    let stalled = conn.create("create-stalled").await;
    conn.send_text(&stalled, "stall", "stall now").await;
    let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
    while rig.ledger_rows("stall_stdin").is_empty() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "stdin never stalled"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    (rig, conn, stalled)
}

fn block_stdin(rig: &ClaudeRig, stalled: &str) -> tokio::task::JoinHandle<ClaudeSendOutcome> {
    let state = rig.fresh_claude.clone();
    // Larger than the OS pipe and Node stream buffers; the paused sidecar cannot
    // consume it. Call the runtime directly to avoid the WS message-size limit.
    let request = send(stalled, "blocked", "x".repeat(2 * 1024 * 1024));
    tokio::spawn(async move { state.handle_send(request).await })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stalled_stdin_does_not_block_another_sessions_send_snapshot_or_kill() {
    // Longer than the healthy-operation budget: a global map lock with just a
    // write timeout would still fail this test.
    let (rig, mut conn, stalled) = stalled_rig("5000").await;
    let healthy = conn.create("create-healthy").await;
    let durable = rig.converse(&mut conn, &healthy, &["before stall"]).await;
    let blocked = block_stdin(&rig, &stalled);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!blocked.is_finished(), "the sidecar must really be blocked");

    let operations = async {
        let outcome = rig
            .fresh_claude
            .handle_send(send(&healthy, "healthy", "still works".into()))
            .await;
        assert!(matches!(outcome, ClaudeSendOutcome::Accepted { .. }));
        rig.fresh_claude
            .get_snapshot(SessionType::Freshclaude, &durable)
            .await
            .expect("healthy snapshot");
        let kill: FreshAgentKill = serde_json::from_value(json!({
            "type": "freshAgent.kill", "provider": "claude", "sessionType": "freshclaude",
            "sessionId": healthy,
        }))
        .unwrap();
        rig.fresh_claude.handle_kill(kill).await;
    };
    let result = tokio::time::timeout(Duration::from_secs(1), operations).await;
    // Cancel the test's own pending send even on red, so its held lock cannot
    // obstruct cleanup in the old implementation.
    blocked.abort();
    let _ = blocked.await;
    assert!(
        result.is_ok(),
        "a stalled sidecar blocked a healthy session"
    );
    rig.fresh_claude.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_500ms_write_timeout_kills_only_its_runtime_and_rings_the_owed_turn_once() {
    let (rig, mut conn, stalled) = stalled_rig("500").await;
    let healthy = conn.create("create-healthy").await;
    let blocked = block_stdin(&rig, &stalled);
    let refused = tokio::time::timeout(Duration::from_secs(3), blocked).await;
    assert!(refused.is_ok(), "the stalled write never timed out");
    assert!(matches!(
        refused.unwrap().unwrap(),
        ClaudeSendOutcome::Refused { .. }
    ));
    conn.wait_for("the wedged sidecar's EOF report", |frame| {
        frame["type"] == "freshAgent.event"
            && frame["sessionId"] == stalled
            && frame["event"]["type"] == "freshAgent.error"
            && frame["event"]["code"] == "SIDECAR_EXITED"
    })
    .await;
    conn.read_for(Duration::from_millis(200)).await;
    assert_eq!(
        conn.frames
            .iter()
            .filter(|frame| frame["sessionId"] == stalled
                && frame["event"]["type"] == "freshAgent.turn.complete")
            .count(),
        1,
        "the original stalled turn is owed exactly one attention edge"
    );
    let stalled_durable = conn.init_session_id(&stalled);
    assert!(!rig.fresh_claude.has_live_session(&stalled_durable).await);
    assert!(matches!(
        rig.fresh_claude
            .handle_send(send(&healthy, "after-timeout", "still works".into()))
            .await,
        ClaudeSendOutcome::Accepted { .. }
    ));
    conn.wait_for("the other runtime still completes turns", |frame| {
        frame["sessionId"] == healthy && frame["event"]["type"] == "freshAgent.result"
    })
    .await;
    assert!(
        rig.fresh_claude
            .has_live_session(&conn.init_session_id(&healthy))
            .await
    );
    assert_eq!(
        rig.fresh_claude.live_snapshot_overlay(&stalled).await["status"],
        "exited"
    );
    rig.fresh_claude.shutdown().await;
}

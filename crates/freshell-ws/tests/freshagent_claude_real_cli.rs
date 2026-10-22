//! The freshclaude lane that runs the REAL claude sidecar
//! (`crates/freshell-claude-sidecar/index.mjs`) behind a real freshell-ws server
//! (design §11.5; C04 adds the smoke test, C29 completes the lane). Each case runs
//! on both rigs from `common::claude_rig`:
//!   - `sim`: RealSidecarSim, the sidecar over the CLI simulator
//!     (`test/fixtures/claude-cli-sim`, kept honest by the conformance suite);
//!   - `cli`: RealSidecarCli, the sidecar over the pinned SDK and its bundled CLI,
//!     talking only to the local fake Anthropic endpoint (never the real API).
//!
//! A missing node, sidecar, simulator or pinned CLI fails the test; nothing here
//! is ever skipped.

mod common;

use common::claude_rig::{ClaudeRig, RigKind};

/// Today's plain turn works end to end: create, one send, a successful result,
/// and exactly one attention edge (`freshAgent.turn.complete`) for the turn. An
/// explicit kill afterwards is the end marker: a requested teardown never rings.
async fn create_send_result_rings_once(kind: RigKind) {
    let rig = ClaudeRig::start(kind).await;
    let mut conn = rig.connect().await;

    let session_id = conn.create("create-1").await;
    conn.send_text(&session_id, "send-1", "hello").await;

    let result = conn.wait_for_event("freshAgent.result").await;
    assert_eq!(result["event"]["result"], "success", "{result}");
    let complete = conn.wait_for_event("freshAgent.turn.complete").await;
    assert!(
        complete["event"]["at"].is_u64(),
        "the edge carries a numeric `at`: {complete}"
    );

    // The turn ran in the rig's isolated CLAUDE_CONFIG_DIR: its transcript is there.
    let transcripts = rig.wait_for_transcripts().await;
    assert_eq!(transcripts.len(), 1, "{transcripts:?}");

    conn.kill(&session_id).await;
    assert_eq!(
        conn.events_seen("freshAgent.turn.complete"),
        1,
        "exactly one attention edge for one turn; frames: {:?}",
        conn.frames
    );

    if kind == RigKind::Sim {
        // The turn really ran on the simulator.
        let prompts = rig.ledger_rows("prompt");
        assert_eq!(prompts.len(), 1, "{prompts:?}");
        assert_eq!(prompts[0]["text"], "hello");
    }
}

/// A new pane's messages are sent the way the browser sends every message: with a
/// checkpoint intent, which the coordinator fences. The CLI reports the session
/// only once a prompt runs (T1), so nothing owns the new pane's session in the
/// coordinator yet: the first send must still run, not be refused as
/// SESSION_RESERVED. Once the session is reported the coordinator owns it under
/// its durable id, and the next send, fenced with the owner pair the client
/// observed for that id, runs too.
async fn first_checkpointed_send_of_a_new_pane_runs(kind: RigKind) {
    let rig = ClaudeRig::start(kind).await;
    let mut conn = rig.connect().await;

    let session_id = conn.create("create-1").await;
    conn.send_checkpointed_text(&session_id, "send-1", "hello")
        .await;
    let result = conn.wait_for_event("freshAgent.result").await;
    assert_eq!(result["event"]["result"], "success", "{result}");
    let first_edge = conn.wait_for_event("freshAgent.turn.complete").await;
    let first_at = first_edge["event"]["at"].as_u64().expect("numeric at");
    assert_eq!(
        conn.request_errors("send-1"),
        Vec::<serde_json::Value>::new(),
        "the first send is not refused"
    );

    conn.send_checkpointed_text(&session_id, "send-2", "again")
        .await;
    conn.wait_for("the second turn's attention edge", |v| {
        v["type"] == "freshAgent.event"
            && v["event"]["type"] == "freshAgent.turn.complete"
            && v["event"]["at"].as_u64() > Some(first_at)
    })
    .await;
    conn.kill(&session_id).await;
    assert_eq!(
        conn.events_seen("freshAgent.result"),
        2,
        "{:?}",
        conn.frames
    );
    assert_eq!(
        conn.events_seen("freshAgent.turn.complete"),
        2,
        "{:?}",
        conn.frames
    );
    assert_eq!(
        conn.request_errors("send-2"),
        Vec::<serde_json::Value>::new(),
        "the second send is not refused"
    );
}

mod sim {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn create_send_result_rings_once() {
        super::create_send_result_rings_once(RigKind::Sim).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn first_checkpointed_send_of_a_new_pane_runs() {
        super::first_checkpointed_send_of_a_new_pane_runs(RigKind::Sim).await;
    }
}

mod cli {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn create_send_result_rings_once() {
        super::create_send_result_rings_once(RigKind::Cli).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn first_checkpointed_send_of_a_new_pane_runs() {
        super::first_checkpointed_send_of_a_new_pane_runs(RigKind::Cli).await;
    }
}

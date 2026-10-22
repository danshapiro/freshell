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

mod sim {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn create_send_result_rings_once() {
        super::create_send_result_rings_once(RigKind::Sim).await;
    }
}

mod cli {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn create_send_result_rings_once() {
        super::create_send_result_rings_once(RigKind::Cli).await;
    }
}

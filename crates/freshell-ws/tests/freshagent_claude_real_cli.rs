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
use common::log_capture::{self, CapturedEvent};
use serde_json::json;
use tracing::Level;

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

/// The sidecar's stderr log reaches the server log (G14). Each record is
/// re-emitted at its own severity with the sidecar's ownership id; once the
/// sidecar has named its session, the session id and type too. The join
/// between the two ids is logged when the session is bound.
async fn sidecar_log_records_reach_the_server_log(kind: RigKind) {
    let logs = log_capture::install();
    let rig = ClaudeRig::start(kind).await;
    let mut conn = rig.connect().await;
    let session_id = conn.create("create-1").await;

    let bound = logs
        .wait_for("the sidecar bound to the new session", |event| {
            event.message == "freshagent.claude.sidecar_bound"
                && event.field("session_id") == Some(session_id.as_str())
        })
        .await;
    assert_eq!(
        bound.field("session_type"),
        Some("freshclaude"),
        "{bound:?}"
    );
    let ownership_id = bound
        .field("ownership_id")
        .expect("the bound event names the sidecar's ownership id")
        .to_string();
    let sidecar_log = |sidecar_event: &'static str| {
        let ownership_id = ownership_id.clone();
        move |event: &CapturedEvent| {
            event.message == "freshagent.claude.sidecar_log"
                && event.field("ownership_id") == Some(ownership_id.as_str())
                && event.field("sidecar_event") == Some(sidecar_event)
        }
    };

    let ready = logs
        .wait_for("the sidecar's ready record", sidecar_log("sidecar.ready"))
        .await;
    assert_eq!(ready.level, Level::INFO, "{ready:?}");
    assert_eq!(ready.field("component"), Some("claude-sidecar"));

    // The CLI refuses an unknown permission mode (T7); the sidecar logs the
    // refusal as a warning about this session.
    conn.send(json!({
        "type": "freshAgent.configure",
        "provider": "claude",
        "sessionType": "freshclaude",
        "sessionId": session_id,
        "requestId": "configure-1",
        "settings": { "permissionMode": "no-such-mode" },
    }))
    .await;
    conn.wait_for("the settings failure", |v| {
        v["type"] == "freshAgent.event"
            && v["event"]["type"] == "freshAgent.error"
            && v["event"]["code"] == "CLAUDE_SETTINGS_FAILED"
    })
    .await;
    let failed = logs
        .wait_for(
            "the sidecar's configure.failed record",
            sidecar_log("configure.failed"),
        )
        .await;
    assert_eq!(failed.level, Level::WARN, "{failed:?}");
    assert_eq!(failed.field("session_id"), Some(session_id.as_str()));
    assert_eq!(failed.field("session_type"), Some("freshclaude"));

    conn.kill(&session_id).await;
}

/// Every attention edge is logged as it leaves the server (G14, design §5.5):
/// a forwarded sidecar `turn.complete` is the info event
/// `freshagent.turn.complete` with the session, its type, the source and the
/// edge's `at`.
async fn a_forwarded_turn_complete_is_logged(kind: RigKind) {
    let logs = log_capture::install();
    let rig = ClaudeRig::start(kind).await;
    let mut conn = rig.connect().await;
    let session_id = conn.create("create-1").await;
    conn.send_text(&session_id, "send-1", "hello").await;
    let edge = conn.wait_for_event("freshAgent.turn.complete").await;
    let at = edge["event"]["at"]
        .as_i64()
        .expect("numeric at")
        .to_string();

    let logged = logs
        .wait_for("the turn.complete log event", |event| {
            event.message == "freshagent.turn.complete"
                && event.field("session_id") == Some(session_id.as_str())
        })
        .await;
    assert_eq!(logged.level, Level::INFO, "{logged:?}");
    assert_eq!(logged.field("provider"), Some("claude"));
    assert_eq!(logged.field("session_type"), Some("freshclaude"));
    assert_eq!(logged.field("source"), Some("freshclaude/sidecar"));
    assert_eq!(logged.field("at"), Some(at.as_str()));

    conn.kill(&session_id).await;
    let edges = logs.matching(|event| {
        event.message == "freshagent.turn.complete"
            && event.field("session_id") == Some(session_id.as_str())
    });
    assert_eq!(edges.len(), 1, "one logged edge per edge sent: {edges:?}");
}

mod sim {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sidecar_log_records_reach_the_server_log() {
        super::sidecar_log_records_reach_the_server_log(RigKind::Sim).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_forwarded_turn_complete_is_logged() {
        super::a_forwarded_turn_complete_is_logged(RigKind::Sim).await;
    }

    /// A forwarded `turn.waiting` (a question raised mid-turn) is logged as
    /// `freshagent.turn.waiting`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_forwarded_turn_waiting_is_logged() {
        let logs = log_capture::install();
        let program = json!({ "rules": [{
            "on": "msg:prompt", "match": { "text": "please ask" },
            "emit": [{ "kind": "question", "data": { "questions": [{
                "question": "Which one?", "header": "Pick", "multiSelect": false,
                "options": [{ "label": "A", "description": "a" }, { "label": "B", "description": "b" }],
            }] } }],
        }] });
        let rig = ClaudeRig::start_with_env(
            RigKind::Sim,
            &[("FRESHELL_CLAUDE_SIM_PROGRAM", &program.to_string())],
        )
        .await;
        let mut conn = rig.connect().await;
        let session_id = conn.create("create-1").await;
        conn.send_text(&session_id, "send-1", "please ask").await;
        let edge = conn.wait_for_event("freshAgent.turn.waiting").await;
        let at = edge["event"]["at"]
            .as_i64()
            .expect("numeric at")
            .to_string();
        let logged = logs
            .wait_for("the turn.waiting log event", |event| {
                event.message == "freshagent.turn.waiting"
                    && event.field("session_id") == Some(session_id.as_str())
            })
            .await;
        assert_eq!(logged.level, Level::INFO, "{logged:?}");
        assert_eq!(logged.field("provider"), Some("claude"));
        assert_eq!(logged.field("session_type"), Some("freshclaude"));
        assert_eq!(logged.field("source"), Some("freshclaude/sidecar"));
        assert_eq!(logged.field("at"), Some(at.as_str()));
        conn.kill(&session_id).await;
    }

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
    async fn sidecar_log_records_reach_the_server_log() {
        super::sidecar_log_records_reach_the_server_log(RigKind::Cli).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_forwarded_turn_complete_is_logged() {
        super::a_forwarded_turn_complete_is_logged(RigKind::Cli).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn create_send_result_rings_once() {
        super::create_send_result_rings_once(RigKind::Cli).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn first_checkpointed_send_of_a_new_pane_runs() {
        super::first_checkpointed_send_of_a_new_pane_runs(RigKind::Cli).await;
    }
}

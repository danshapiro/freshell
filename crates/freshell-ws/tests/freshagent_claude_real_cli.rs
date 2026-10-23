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

use common::claude_rig::{ClaudeRig, RigKind, RigOptions};
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

/// Design §11.5 item 10, zero-turn restart: a session created and never sent to
/// has no transcript yet (T3). After a restart its pane's attach boots it again
/// from the `Fresh` genesis its binding row records, under its own id; its first
/// turn writes that id's transcript, and the genesis is then cleared (§4.1).
async fn a_zero_turn_session_restarts_fresh_under_its_own_id(kind: RigKind) {
    let rig = ClaudeRig::start_with_options(
        kind,
        RigOptions {
            durable_ledger: true,
            ..RigOptions::default()
        },
    )
    .await;
    let id = uuid::Uuid::new_v4().to_string();
    rig.seed_pending_session(&id, &json!({ "kind": "fresh" }));
    let mut conn = rig.connect().await;

    conn.attach(&id).await;
    conn.send_text(&id, "send-1", "hello").await;
    let result = conn.wait_for_event("freshAgent.result").await;
    assert_eq!(result["event"]["result"], "success", "{result}");
    assert_eq!(
        conn.init_session_id(&id),
        id,
        "the CLI ran under the session's id"
    );
    rig.wait_for_transcript(&id).await;
    rig.wait_for_genesis_cleared(&id).await;
    conn.kill(&id).await;
}

/// One finished turn (its `freshAgent.result`) for `text` sent to `session_id`,
/// and its lines on disk: the CLI flushes a transcript line 95-200 ms after its
/// SDK frame (T3), and an undo reads the transcript.
async fn turn(
    rig: &ClaudeRig,
    conn: &mut common::claude_rig::RigConnection,
    session_id: &str,
    request_id: &str,
    text: &str,
) {
    let results = conn.events_seen("freshAgent.result");
    conn.send_text(session_id, request_id, text).await;
    let deadline = tokio::time::Instant::now() + common::claude_rig::RIG_FRAME_BUDGET;
    while conn.events_seen("freshAgent.result") == results {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the turn {request_id} never finished"
        );
        conn.read_for(std::time::Duration::from_millis(50)).await;
    }
    let durable = conn.init_session_id(session_id);
    let path = rig.wait_for_transcript(&durable).await;
    loop {
        let lines: Vec<serde_json::Value> = std::fs::read_to_string(&path)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect();
        let prompt = lines.iter().rposition(|line| {
            line["type"] == "user" && line["message"]["content"][0]["text"] == text
        });
        if prompt.is_some_and(|at| lines[at..].iter().any(|line| line["type"] == "assistant")) {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the turn {request_id} never reached disk"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}

/// An undo or redo from the pane `pane_id` of the session `durable`, fenced
/// with the owner pair the client holds; returns the requester's answer.
async fn rollback(
    conn: &mut common::claude_rig::RigConnection,
    kind: &str,
    pane_id: &str,
    durable: &str,
    request_id: &str,
) -> serde_json::Value {
    let (epoch, generation) = conn.owner_pair(durable).expect("an owner record");
    conn.send(json!({
        "type": format!("freshAgent.{kind}"),
        "provider": "claude",
        "sessionType": "freshclaude",
        "sessionId": pane_id,
        "requestId": request_id,
        "mode": "step",
        "observedEpoch": epoch,
        "observedGeneration": generation,
    }))
    .await;
    conn.wait_for(&format!("the answer to {request_id}"), |v| {
        v["type"] == "freshAgent.event"
            && v["event"]["requestId"] == request_id
            && matches!(
                v["event"]["type"].as_str(),
                Some("freshAgent.rolledBack" | "freshAgent.redone" | "freshAgent.error")
            )
    })
    .await["event"]
        .clone()
}

/// The replacement id an undo or redo ack names (and that it succeeded).
fn replacement(answer: &serde_json::Value, expected: &str) -> String {
    assert_eq!(answer["type"], expected, "{answer}");
    answer["newSessionId"]
        .as_str()
        .expect("the ack names the replacement")
        .to_string()
}

/// The prompts a session's snapshot holds, in order.
async fn prompts_of(rig: &ClaudeRig, session_id: &str) -> Vec<String> {
    let snapshot = rig
        .fresh_claude
        .get_snapshot(freshell_protocol::SessionType::Freshclaude, session_id)
        .await
        .unwrap_or_else(|error| panic!("a snapshot of {session_id}: {error:?}"));
    snapshot["turns"]
        .as_array()
        .expect("turns")
        .iter()
        .filter(|turn| turn["role"] == "user")
        .filter_map(|turn| turn["items"][0]["text"].as_str().map(str::to_string))
        .collect()
}

/// Design §11.5 item 5 (C13, G01): undo, send, redo, and two undos with no send
/// between them, each answered once the CLI booted the replacement (no init is
/// awaited). A send after an undo runs in the replacement (the CLI reports its
/// id) and destroys redo; an undo of that conversation and its redo restore the
/// sent turn; a second undo before any send forks the original again.
async fn undo_send_redo_and_two_undos_without_a_send(kind: RigKind) {
    let rig = ClaudeRig::start_with_options(
        kind,
        RigOptions {
            durable_ledger: true,
            ..RigOptions::default()
        },
    )
    .await;
    let mut conn = rig.connect().await;
    let pane = conn.create("create-1").await;
    turn(&rig, &mut conn, &pane, "send-1", "first prompt").await;
    turn(&rig, &mut conn, &pane, "send-2", "second prompt").await;
    turn(&rig, &mut conn, &pane, "send-3", "third prompt").await;
    let a = conn.init_session_id(&pane);

    let c = replacement(
        &rollback(&mut conn, "undo", &pane, &a, "undo-1").await,
        "freshAgent.rolledBack",
    );
    assert_eq!(
        prompts_of(&rig, &c).await,
        ["first prompt", "second prompt"]
    );
    turn(&rig, &mut conn, &c, "send-4", "another third prompt").await;
    assert_eq!(
        conn.init_session_id(&c),
        c,
        "the send ran in the replacement"
    );
    let refused = rollback(&mut conn, "redo", &c, &c, "redo-after-send").await;
    assert_eq!(
        refused["code"], "REDO_UNAVAILABLE",
        "a send destroys redo: {refused}"
    );

    let d = replacement(
        &rollback(&mut conn, "undo", &c, &c, "undo-2").await,
        "freshAgent.rolledBack",
    );
    let e = replacement(
        &rollback(&mut conn, "redo", &d, &d, "redo-1").await,
        "freshAgent.redone",
    );
    assert_eq!(
        prompts_of(&rig, &e).await,
        ["first prompt", "second prompt", "another third prompt"]
    );

    let f1 = replacement(
        &rollback(&mut conn, "undo", &e, &e, "undo-3").await,
        "freshAgent.rolledBack",
    );
    let f2 = replacement(
        &rollback(&mut conn, "undo", &f1, &f1, "undo-4").await,
        "freshAgent.rolledBack",
    );
    assert_eq!(prompts_of(&rig, &f2).await, ["first prompt"]);
    turn(&rig, &mut conn, &f2, "send-5", "after two undos").await;
    assert_eq!(conn.init_session_id(&f2), f2);
    assert_eq!(
        prompts_of(&rig, &f2).await,
        ["first prompt", "after two undos"]
    );
    conn.kill(&f2).await;
}

mod sim {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn undo_send_redo_and_two_undos_without_a_send() {
        super::undo_send_redo_and_two_undos_without_a_send(RigKind::Sim).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_zero_turn_session_restarts_fresh_under_its_own_id() {
        super::a_zero_turn_session_restarts_fresh_under_its_own_id(RigKind::Sim).await;
    }

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
    async fn undo_send_redo_and_two_undos_without_a_send() {
        super::undo_send_redo_and_two_undos_without_a_send(RigKind::Cli).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_zero_turn_session_restarts_fresh_under_its_own_id() {
        super::a_zero_turn_session_restarts_fresh_under_its_own_id(RigKind::Cli).await;
    }

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

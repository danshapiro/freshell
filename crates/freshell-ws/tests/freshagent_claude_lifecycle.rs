//! How a freshclaude session ends when nobody asked it to (design §5.7 and §11.3
//! of docs/plans/2026-10-22-freshclaude-core-runtime.md; G02, G23). Every case runs
//! the REAL claude sidecar over the CLI simulator (RealSidecarSim,
//! `common::claude_rig`).
//!
//! The sidecar hosts one session, so when that session's SDK stream ends it reports
//! the end (`sdk.stream.ended`) and exits; the server's end-of-output path then ends
//! the session: one `freshAgent.error{SIDECAR_EXITED}` carrying the cause, exactly
//! one attention edge when a turn was running, and no live session left behind.
//! A Node death reports nothing, so the server rings for it itself.
//!
//! Unix only: the tests read the sidecar's pid and signal it (rust-gate runs on Linux).
#![cfg(unix)]

mod common;

use std::time::Duration;

use common::claude_rig::{ClaudeRig, RigConnection, RigKind, RIG_FRAME_BUDGET};
use serde_json::{json, Value};

/// How long a test keeps reading after the exit report before it counts edges: the
/// server sends any edge of its own right after the report, so a second edge would
/// arrive well inside this window.
const QUIET: Duration = Duration::from_millis(500);

async fn rig_with_program(rules: Value) -> ClaudeRig {
    let program = json!({ "rules": rules }).to_string();
    ClaudeRig::start_with_env(RigKind::Sim, &[("FRESHELL_CLAUDE_SIM_PROGRAM", &program)]).await
}

/// The pid of the sidecar process: the simulator runs inside it and stamps every
/// ledger row with its host's pid.
async fn sidecar_pid(rig: &ClaudeRig) -> i32 {
    let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
    loop {
        if let Some(row) = rig.ledger_rows("boot").first() {
            return row["pid"].as_i64().expect("the boot row carries a pid") as i32;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the simulated CLI never booted"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Whether a process with this pid still exists (a zombie counts: it is not gone).
fn process_exists(pid: i32) -> bool {
    // SAFETY: signal 0 only checks for the process; nothing is sent.
    unsafe { libc::kill(pid, 0) == 0 }
}

async fn wait_until_gone(pid: i32) {
    let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
    while process_exists(pid) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the sidecar process {pid} is still there"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn wait_for_sidecar_exited(conn: &mut RigConnection, session_id: &str) -> Value {
    let frame = conn
        .wait_for("freshAgent.error{SIDECAR_EXITED}", |v| {
            v["type"] == "freshAgent.event"
                && v["event"]["type"] == "freshAgent.error"
                && v["event"]["code"] == "SIDECAR_EXITED"
        })
        .await;
    assert_eq!(frame["sessionId"], session_id, "{frame}");
    assert_eq!(frame["event"]["sessionId"], session_id, "{frame}");
    frame["event"].clone()
}

/// The durable id the session's first turn reported (`freshAgent.session.init`).
fn durable_id(conn: &RigConnection, session_id: &str) -> String {
    conn.frames
        .iter()
        .find_map(|v| {
            (v["type"] == "freshAgent.event"
                && v["event"]["type"] == "freshAgent.session.init"
                && v["event"]["sessionId"] == session_id)
                .then(|| v["event"]["cliSessionId"].as_str().map(str::to_string))
                .flatten()
        })
        .expect("the session reported its durable id")
}

/// The statuses broadcast for the session, in order.
fn statuses(conn: &RigConnection, session_id: &str) -> Vec<String> {
    conn.frames
        .iter()
        .filter(|v| {
            v["type"] == "freshAgent.event"
                && v["event"]["type"] == "freshAgent.status"
                && v["sessionId"] == session_id
        })
        .filter_map(|v| v["event"]["status"].as_str().map(str::to_string))
        .collect()
}

/// The CLI dies mid-turn (SIGKILL, T14): one attention edge for the lost turn, one
/// SIDECAR_EXITED naming the CLI's death, and the sidecar process is gone.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cli_crash_mid_turn_rings_once_and_reports_the_cause() {
    let rig = rig_with_program(json!([{ "on": "msg:prompt", "emit": [
        { "kind": "text", "data": { "text": "partial" } },
        { "kind": "crash" },
    ] }]))
    .await;
    let mut conn = rig.connect().await;
    let session_id = conn.create("create-1").await;
    conn.send_text(&session_id, "send-1", "a turn the CLI dies in")
        .await;
    let pid = sidecar_pid(&rig).await;

    let exited = wait_for_sidecar_exited(&mut conn, &session_id).await;
    assert_eq!(
        exited["cause"],
        json!({ "reason": "cli_exited", "message": "Claude Code process terminated by signal SIGKILL" }),
        "{exited}"
    );
    assert!(
        exited["message"].as_str().is_some_and(
            |message| message.contains("Claude Code process terminated by signal SIGKILL")
        ),
        "the banner says what happened: {exited}"
    );
    wait_until_gone(pid).await;

    conn.read_for(QUIET).await;
    assert_eq!(
        conn.events_seen("freshAgent.turn.complete"),
        1,
        "exactly one edge for the lost turn; frames: {:?}",
        conn.frames
    );
    assert_eq!(
        conn.events_seen("freshAgent.result"),
        0,
        "{:?}",
        conn.frames
    );
    assert_eq!(
        conn.frames
            .iter()
            .filter(|v| v["event"]["code"] == "SIDECAR_EXITED")
            .count(),
        1,
        "one exit report; frames: {:?}",
        conn.frames
    );
}

/// The CLI ends the stream cleanly in the middle of the session's second turn (it
/// exits 0, so the SDK's iterator just ends). The earlier turn's result must not
/// leave the session busy (G23): the session ends, its last status is idle, and
/// the server no longer holds it as live.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_natural_end_of_stream_mid_turn_leaves_the_session_not_busy() {
    let rig = rig_with_program(
        json!([{ "on": "msg:prompt", "match": { "text": "second" }, "emit": [
        { "kind": "text", "data": { "text": "partial" } },
        { "kind": "crash", "data": { "code": 0 } },
    ] }]),
    )
    .await;
    let mut conn = rig.connect().await;
    let session_id = conn.create("create-1").await;
    conn.send_text(&session_id, "send-1", "first").await;
    conn.wait_for_event("freshAgent.turn.complete").await;
    let durable = durable_id(&conn, &session_id);
    assert!(rig.fresh_claude.has_live_session(&durable).await);
    let pid = sidecar_pid(&rig).await;

    conn.send_text(&session_id, "send-2", "second").await;
    let exited = wait_for_sidecar_exited(&mut conn, &session_id).await;
    assert_eq!(exited["cause"]["reason"], "stream_eof", "{exited}");
    wait_until_gone(pid).await;

    conn.read_for(QUIET).await;
    assert_eq!(
        statuses(&conn, &session_id).last().map(String::as_str),
        Some("idle"),
        "the session's last status is idle; frames: {:?}",
        conn.frames
    );
    assert!(
        !rig.fresh_claude.has_live_session(&durable).await,
        "the ended session is not held as live (and so cannot stay busy)"
    );
    assert_eq!(
        conn.events_seen("freshAgent.turn.complete"),
        2,
        "one edge per turn; frames: {:?}",
        conn.frames
    );
}

/// The Node sidecar itself is killed mid-turn: it reports nothing, so the server
/// rings for the lost turn itself, once, and names the signal.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_node_death_mid_turn_rings_once() {
    let rig = rig_with_program(json!([{ "on": "msg:prompt", "emit": [{ "kind": "hang" }] }])).await;
    let mut conn = rig.connect().await;
    let session_id = conn.create("create-1").await;
    conn.send_text(&session_id, "send-1", "a turn that never ends")
        .await;
    conn.wait_for_event("freshAgent.session.init").await;
    let pid = sidecar_pid(&rig).await;
    // SAFETY: the pid is this rig's own sidecar, read from its simulator's ledger.
    assert_eq!(unsafe { libc::kill(pid, libc::SIGKILL) }, 0);

    let exited = wait_for_sidecar_exited(&mut conn, &session_id).await;
    assert_eq!(exited["cause"]["reason"], "sidecar_exited", "{exited}");
    assert_eq!(exited["cause"]["signal"], "SIGKILL", "{exited}");
    wait_until_gone(pid).await;

    conn.read_for(QUIET).await;
    assert_eq!(
        conn.events_seen("freshAgent.turn.complete"),
        1,
        "exactly one edge for the lost turn; frames: {:?}",
        conn.frames
    );
}

/// An idle session whose CLI dies ends with the exit report and no edge.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_idle_cli_death_reports_the_exit_without_an_edge() {
    let rig =
        rig_with_program(json!([{ "on": "start", "emit": [{ "kind": "crash", "delayMs": 300 }] }]))
            .await;
    let mut conn = rig.connect().await;
    let session_id = conn.create("create-1").await;

    let exited = wait_for_sidecar_exited(&mut conn, &session_id).await;
    assert_eq!(exited["cause"]["reason"], "cli_exited", "{exited}");
    conn.read_for(QUIET).await;
    assert_eq!(
        conn.events_seen("freshAgent.turn.complete"),
        0,
        "{:?}",
        conn.frames
    );
}

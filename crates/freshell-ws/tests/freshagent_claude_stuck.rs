//! Quiet-window detection and process-only recovery use the real runtime path.
#![cfg(unix)]

mod common;

use common::claude_rig::{ClaudeRig, RigConnection, RigKind, RigOptions};
use serde_json::{json, Value};
use std::time::Duration;

fn statuses(conn: &RigConnection, status: &str) -> usize {
    conn.frames
        .iter()
        .filter(|frame| {
            frame["event"]["type"] == "freshAgent.status" && frame["event"]["status"] == status
        })
        .count()
}

async fn quiet_rig(program: Option<Value>) -> ClaudeRig {
    let mut env = vec![("FRESHELL_FRESHCLAUDE_QUIET_WINDOW_MS".into(), "150".into())];
    if let Some(program) = program {
        env.push(("FRESHELL_CLAUDE_SIM_PROGRAM".into(), program.to_string()));
    }
    ClaudeRig::start_with_options(
        RigKind::Sim,
        RigOptions {
            env,
            durable_ledger: true,
            ..RigOptions::default()
        },
    )
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_quiet_busy_session_becomes_stuck_and_rings_once_per_epoch() {
    let logs = common::log_capture::install();
    let rig = quiet_rig(None).await;
    let mut conn = rig.connect().await;
    let id = conn.create("quiet-hang").await;
    conn.send_text(&id, "hanging-turn", "HANG").await;
    conn.read_for(Duration::from_millis(700)).await;
    assert_eq!(statuses(&conn, "stuck"), 1, "{:#?}", conn.frames);
    assert_eq!(conn.events_seen("freshAgent.turn.complete"), 1);
    assert_eq!(
        conn.events_seen("freshAgent.result"),
        0,
        "a stuck edge never settles a turn"
    );
    assert_eq!(
        rig.fresh_claude.live_snapshot_overlay(&id).await["status"],
        "stuck"
    );
    let edge = logs
        .wait_for("the quiet deadman's edge", |event| {
            event.message == "freshagent.turn.complete" && event.field("session_id") == Some(&id)
        })
        .await;
    assert_eq!(edge.field("source"), Some("quiet_deadman"));
    conn.read_for(Duration::from_millis(450)).await;
    assert_eq!(
        conn.events_seen("freshAgent.turn.complete"),
        1,
        "the same quiet epoch rings once"
    );
    rig.fresh_claude.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn later_stdout_activity_resolves_stuck_and_starts_a_new_quiet_epoch() {
    let rig = quiet_rig(Some(json!({"rules":[{"on":"msg:prompt", "match":{"text":"late progress"},
        "emit":[{"kind":"text", "delayMs":1500, "data":{"text":"still working"}}, {"kind":"hang"}]}]}))).await;
    let mut conn = rig.connect().await;
    let id = conn.create("quiet-late-progress").await;
    conn.send_text(&id, "late-progress-turn", "late progress")
        .await;
    conn.read_for(Duration::from_millis(700)).await;
    assert_eq!(statuses(&conn, "stuck"), 1, "{:#?}", conn.frames);
    let first_stuck = conn
        .frames
        .iter()
        .position(|frame| frame["event"]["status"] == "stuck")
        .unwrap();
    conn.wait_for("activity resolving the stuck state", |frame| {
        frame["event"]["content"].as_array().is_some_and(|content| {
            content.iter().any(|block| {
                block["text"]
                    .as_str()
                    .is_some_and(|text| text.contains("still working"))
            })
        })
    })
    .await;
    assert!(conn
        .frames
        .iter()
        .skip(first_stuck + 1)
        .any(|frame| frame["event"]["status"] == "running"));
    conn.read_for(Duration::from_millis(500)).await;
    assert_eq!(
        statuses(&conn, "stuck"),
        2,
        "a new silent epoch follows real progress"
    );
    assert_eq!(conn.events_seen("freshAgent.turn.complete"), 2);
    rig.fresh_claude.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pending_approval_pauses_the_deadman_until_the_user_answers() {
    let rig = quiet_rig(Some(json!({"rules":[{"on":"msg:prompt", "match":{"text":"ask then hang"},
        "emit":[{"kind":"approval", "data":{"tool":"Bash", "input":{"command":"ls"}}}, {"kind":"hang"}]}]}))).await;
    let mut conn = rig.connect().await;
    let created = conn
        .request_create("quiet-approval", json!({"permissionMode":"default"}))
        .await;
    let id = created["sessionId"].as_str().unwrap();
    conn.send_text(id, "approval-turn", "ask then hang").await;
    let approval = conn.wait_for_event("freshAgent.permission.request").await;
    conn.wait_for_event("freshAgent.turn.waiting").await;
    conn.read_for(Duration::from_millis(600)).await;
    assert_eq!(
        statuses(&conn, "stuck"),
        0,
        "the user is blocking this turn"
    );
    assert_eq!(conn.events_seen("freshAgent.turn.complete"), 0);
    conn.send(json!({"type":"freshAgent.approval.respond", "provider":"claude", "sessionType":"freshclaude",
        "sessionId":id, "requestId":approval["event"]["requestId"],
        "decision":{"behavior":"allow", "updatedInput":{"command":"ls"}}})).await;
    conn.read_for(Duration::from_millis(700)).await;
    assert_eq!(
        statuses(&conn, "stuck"),
        1,
        "the resumed agent is now blocking the turn"
    );
    assert_eq!(conn.events_seen("freshAgent.turn.complete"), 1);
    rig.fresh_claude.shutdown().await;
}

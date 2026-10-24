//! Every incoming native id follows durable supersession after a server restart.

mod common;

use common::claude_rig::{ClaudeRig, RigKind, RigOptions};
use freshell_ownership::{BeginOutcome, CommitOutcome, OwnerIdentity, RuntimeOwnerKind};
use freshell_ws::pane_ledger::{RetiredReason, RowState};
use serde_json::json;
use std::process::Stdio;

async fn persisted_reset_after_restart() -> (ClaudeRig, String, String) {
    let mut rig = ClaudeRig::start_with_options(
        RigKind::Sim,
        RigOptions {
            durable_ledger: true,
            ..RigOptions::default()
        },
    )
    .await;
    let mut conn = rig.connect().await;
    let old = conn.create("persisted-native-close-create").await;
    rig.converse(&mut conn, &old, &["saved before the native reset"])
        .await;
    let start = conn.frames.len();
    conn.send_text(&old, "persisted-native-clear", "/clear")
        .await;
    let materialized = conn
        .wait_for_since(start, "the native reset", |frame| {
            frame["type"] == "freshAgent.session.materialized" && frame["previousSessionId"] == old
        })
        .await;
    let current = materialized["sessionId"].as_str().unwrap().to_string();
    assert_ne!(old, current);
    conn.wait_for_since(start, "the cleared command settling", |frame| {
        frame["sessionId"] == current
            && frame["event"]["type"] == "freshAgent.status"
            && frame["event"]["status"] == "idle"
    })
    .await;
    rig.converse(&mut conn, &current, &["saved in the current conversation"])
        .await;
    rig.restart().await;
    let resolution = rig
        .pane_ledger
        .as_ref()
        .unwrap()
        .lookup_by_session("claude", &old)
        .unwrap();
    assert!(resolution.corrected);
    assert_eq!(resolution.row.session_id, current);
    assert!(!rig.fresh_claude.has_live_session(&old).await);
    assert!(!rig.fresh_claude.has_live_session(&current).await);
    (rig, old, current)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn closing_a_prior_native_id_after_restart_closes_its_reattached_current_runtime() {
    let (rig, old, current) = persisted_reset_after_restart().await;
    let mut conn = rig.connect().await;
    conn.attach(&current).await;
    assert!(rig.fresh_claude.has_live_session(&current).await);
    let processes = rig.runtime_processes(&current);
    conn.kill(&old).await;
    let ledger = rig.pane_ledger.as_ref().unwrap();
    let row = ledger.load_binding("claude", &current).unwrap();
    let live = rig.fresh_claude.has_live_session(&current).await;
    assert!(
        !live,
        "late kill({old}) left current {current} running; row={row:?}, current fence={:?}",
        ledger.kill_tombstone_at("claude", &current)
    );
    assert_eq!(row.state, RowState::Retired);
    assert_eq!(row.retired_reason, Some(RetiredReason::Closed));
    assert!(ledger.kill_tombstone_at("claude", &current).is_some());
    processes
        .wait_until_exited("closing a superseded native UUID")
        .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_prior_native_close_after_restart_refuses_the_current_terminal_owner() {
    let (rig, old, current) = persisted_reset_after_restart().await;
    let mut terminal = tokio::process::Command::new("node")
        .args(["-e", "setInterval(() => {}, 1000)"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let op = "terminal-after-native-reset";
    let BeginOutcome::Granted { generation } = rig.ownership.begin_start(
        "claude",
        &current,
        RuntimeOwnerKind::Terminal,
        op,
        None,
        "test",
        freshell_ownership::now_epoch_ms(),
    ) else {
        panic!("the restarted coordinator has no owner")
    };
    let owner = OwnerIdentity {
        kind: RuntimeOwnerKind::Terminal,
        terminal_id: Some(op.into()),
        live_session_key: None,
        pid: terminal.id(),
        ownership_id: Some(op.into()),
    };
    assert!(matches!(
        rig.ownership
            .commit_live("claude", &current, op, generation, owner),
        CommitOutcome::Committed
    ));
    let before = rig.ownership.observe("claude", &current);
    let mut conn = rig.connect().await;
    let start = conn.frames.len();
    conn.send(json!({"type":"freshAgent.kill", "provider":"claude", "sessionType":"freshclaude", "sessionId":old})).await;
    let answer = conn
        .wait_for_since(start, "the late native close answer", |frame| {
            frame["type"] == "freshAgent.killed" && frame["sessionId"] == old
        })
        .await;
    assert_eq!(answer["success"], false, "{answer}");
    assert_eq!(answer["code"], "FOREIGN_OWNER", "{answer}");
    assert_eq!(
        rig.ownership.observe("claude", &current).state,
        before.state
    );
    assert!(
        terminal.try_wait().unwrap().is_none(),
        "the terminal writer survives"
    );
    let ledger = rig.pane_ledger.as_ref().unwrap();
    assert_eq!(
        ledger.load_binding("claude", &current).unwrap().state,
        RowState::Bound
    );
    for id in [&old, &current] {
        assert!(ledger.kill_tombstone_at("claude", id).is_none());
    }
    terminal.start_kill().unwrap();
    terminal.wait().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn closing_a_prior_native_id_after_restart_closes_the_untracked_bound_terminus() {
    let (rig, old, current) = persisted_reset_after_restart().await;
    let mut conn = rig.connect().await;
    conn.kill(&old).await;
    assert!(!rig.fresh_claude.has_live_session(&current).await);
    let ledger = rig.pane_ledger.as_ref().unwrap();
    let row = ledger.load_binding("claude", &current).unwrap();
    assert_eq!(
        row.state,
        RowState::Retired,
        "a closed conversation is not a recovery offer: {row:?}"
    );
    assert_eq!(row.retired_reason, Some(RetiredReason::Closed));
    for id in [&old, &current] {
        assert!(ledger.kill_tombstone_at("claude", id).is_some());
    }
}

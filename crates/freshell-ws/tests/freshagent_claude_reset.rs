//! A conversation reset changes the durable identity of one live runtime.

mod common;

use common::claude_rig::{ClaudeRig, RigKind, RigOptions, RIG_FRAME_BUDGET};
use serde_json::json;
use std::time::Duration;

fn dialogue_rows(text: &str) -> Vec<serde_json::Value> {
    text.lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .filter(|row: &serde_json::Value| row["type"] == "user" || row["type"] == "assistant")
        .collect()
}

async fn conversation_reset(kind: RigKind, drop_announcement: bool) {
    let rig = ClaudeRig::start_with_options(
        kind,
        RigOptions {
            durable_ledger: true,
            env: if drop_announcement {
                vec![(
                    "FRESHELL_CLAUDE_SIM_DROP_CONVERSATION_RESET".into(),
                    "1".into(),
                )]
            } else {
                vec![]
            },
            ..RigOptions::default()
        },
    )
    .await;
    let mut conn = rig.connect().await;
    let old = conn.create("create-reset").await;
    rig.converse(&mut conn, &old, &["before clear"]).await;
    let original_path = rig.wait_for_transcript(&old).await;
    let original_text = std::fs::read_to_string(&original_path).unwrap();
    let before = conn.frames.len();

    conn.send_text(&old, "clear-command", "/clear").await;
    let init = conn
        .wait_for("the post-clear init", |frame| {
            frame["event"]["type"] == "freshAgent.session.init"
                && frame["event"]["cliSessionId"] != old
        })
        .await;
    let new = init["event"]["cliSessionId"].as_str().unwrap().to_string();
    assert!(uuid::Uuid::parse_str(&new).is_ok() && new != old);
    let materialized = conn.frames[before..]
        .iter()
        .find(|frame| frame["type"] == "freshAgent.session.materialized")
        .expect("the pane must follow the reset before receiving the new init");
    assert_eq!(materialized["previousSessionId"], old);
    assert_eq!(materialized["sessionId"], new);
    assert_eq!(
        materialized["sessionRef"],
        json!({"provider":"claude", "sessionId":new})
    );
    assert_eq!(
        init["sessionId"], new,
        "the init is stamped with the new id"
    );

    conn.wait_for("the cleared turn's result", |frame| {
        frame["sessionId"] == new && frame["event"]["type"] == "freshAgent.result"
    })
    .await;
    conn.wait_for("the clear command retired under the new id", |frame| {
        frame["sessionId"] == new
            && frame["event"]["type"] == "freshAgent.status"
            && frame["event"]["status"] == "idle"
    })
    .await;
    assert_eq!(rig.fresh_claude.session_busy(&new).await, Some(false));
    let ledger = rig.pane_ledger.as_ref().unwrap();
    assert_eq!(
        ledger
            .load_binding("claude", &old)
            .unwrap()
            .superseded_by
            .unwrap()
            .session_id,
        new,
    );
    assert!(ledger.load_binding("claude", &new).is_some());
    assert_eq!(
        ledger
            .lookup_by_create_request_id("claude", "create-reset")
            .unwrap()
            .session_id,
        new,
        "replaying the create must follow the same conversation reset",
    );
    let (status, snapshot) = rig.snapshot(&new).await;
    assert_eq!(status, 200, "{snapshot}");
    assert!(!snapshot.to_string().contains("before clear"));

    let results_before = conn.events_seen("freshAgent.result");
    let after_reset = conn.frames.len();
    conn.send_text(&new, "after-reset", "after clear").await;
    let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
    loop {
        let frames = &conn.frames[after_reset..];
        let completed = frames.iter().any(|frame| {
            frame["sessionId"] == new && frame["event"]["type"] == "freshAgent.turn.complete"
        });
        let idle = frames.iter().any(|frame| {
            frame["sessionId"] == new
                && frame["event"]["type"] == "freshAgent.status"
                && frame["event"]["status"] == "idle"
        });
        if completed && idle {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the new conversation never finished its next turn"
        );
        conn.read_for(Duration::from_millis(50)).await;
    }
    assert_eq!(conn.events_seen("freshAgent.result"), results_before + 1);
    assert_eq!(rig.fresh_claude.session_busy(&new).await, Some(false));
    // The CLI appends queue bookkeeping to the old file during /clear. Its
    // conversation messages remain intact; the next turn belongs only to B.
    assert_eq!(
        dialogue_rows(&std::fs::read_to_string(original_path).unwrap()),
        dialogue_rows(&original_text),
    );
    assert_eq!(
        conn.frames[before..]
            .iter()
            .filter(|frame| frame["type"] == "freshAgent.session.materialized")
            .count(),
        1,
        "the per-turn init after reset does not rekey again",
    );
    // A request issued before /clear still targets this runtime. Teardown
    // must release the moved lease, so B can subsequently be resumed.
    conn.kill(&old).await;
    assert!(!rig.fresh_claude.has_live_session(&new).await);
    let mut resumed = rig.connect().await;
    resumed.attach(&new).await;
    rig.converse(&mut resumed, &new, &["after reset and resume"])
        .await;
    rig.fresh_claude.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn clear_moves_the_live_record_binding_and_turn_to_the_new_uuid() {
    conversation_reset(RigKind::Sim, false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pinned_cli_clear_then_send_keeps_the_new_conversation_working() {
    conversation_reset(RigKind::Cli, false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unannounced_init_identity_change_keeps_following_the_healthy_runtime() {
    conversation_reset(RigKind::Sim, true).await;
}

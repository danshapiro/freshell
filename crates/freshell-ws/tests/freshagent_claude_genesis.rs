//! A claude session with no transcript yet boots from its genesis (core-runtime
//! design §4.1-§4.3, C12).
//!
//! A session's binding row records how it came to be (`{"kind":"fresh"}`, or a
//! lazy fork of a parent at a point) until its transcript is observed on disk.
//! After a restart the pane's attach finds no live session and no transcript, and
//! the lane boots the session again from that genesis, under the session's own id;
//! once the first turn's transcript is on disk the genesis is cleared.
//!
//! Each test runs the real sidecar over the CLI simulator (RealSidecarSim) and a
//! real pane ledger, seeds the binding row the way a lane that mints a pending
//! session writes it (nothing writes one before C13), and checks the `query()`
//! options the simulator recorded, the transcript the CLI wrote and the row.

mod common;

use std::time::Duration;

use serde_json::{json, Value};

use common::claude_rig::{ClaudeRig, RigConnection, RigKind, RigOptions, RIG_FRAME_BUDGET};
use freshell_ws::pane_ledger::PaneLedger;

async fn ledger_rig() -> (ClaudeRig, std::sync::Arc<PaneLedger>) {
    let rig = ClaudeRig::start_with_options(
        RigKind::Sim,
        RigOptions {
            durable_ledger: true,
            ..RigOptions::default()
        },
    )
    .await;
    let ledger = rig.pane_ledger.clone().expect("the rig has a ledger");
    (rig, ledger)
}

/// One finished turn per prompt (each `freshAgent.result`).
async fn converse(conn: &mut RigConnection, session_id: &str, prompts: &[&str]) {
    for (n, prompt) in prompts.iter().enumerate() {
        let results_before = conn.events_seen("freshAgent.result");
        conn.send_text(session_id, &format!("send-{session_id}-{n}"), prompt)
            .await;
        let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
        while conn.events_seen("freshAgent.result") == results_before {
            assert!(
                tokio::time::Instant::now() < deadline,
                "turn {n} never finished"
            );
            conn.read_for(Duration::from_millis(50)).await;
        }
    }
}

/// The `query()` options the simulator recorded, the first matching `predicate`.
async fn wait_for_query(rig: &ClaudeRig, what: &str, predicate: impl Fn(&Value) -> bool) -> Value {
    let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
    loop {
        let options: Vec<Value> = rig
            .ledger_rows("query")
            .into_iter()
            .map(|row| row["options"].clone())
            .collect();
        if let Some(found) = options.iter().find(|o| predicate(o)) {
            return found.clone();
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "no query() call for {what}; recorded: {options:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn turn_ids(snapshot: &Value) -> Vec<String> {
    snapshot["turns"]
        .as_array()
        .expect("turns")
        .iter()
        .filter_map(|t| t["turnId"].as_str().map(str::to_string))
        .collect()
}

/// §4.3 "create, no send, server restart": the zero-turn session boots a fresh
/// conversation under its own id again (T3), its first turn writes that id's
/// transcript, and the genesis is then cleared.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_zero_turn_session_reboots_fresh_under_its_own_id_and_its_genesis_clears() {
    let (rig, ledger) = ledger_rig().await;
    let id = uuid::Uuid::new_v4().to_string();
    rig.seed_pending_session(&id, &json!({ "kind": "fresh" }));
    let mut conn = rig.connect().await;

    conn.attach(&id).await;
    let boot = wait_for_query(&rig, "the fresh boot", |o| o["sessionId"] == id.as_str()).await;
    assert_eq!(
        boot.get("resume"),
        None,
        "a fresh boot resumes nothing: {boot}"
    );
    assert_eq!(
        boot.get("forkSession"),
        None,
        "a fresh boot forks nothing: {boot}"
    );
    assert_eq!(
        ledger.binding_genesis("claude", &id),
        Some(json!({ "kind": "fresh" })),
        "the genesis stays until the transcript is on disk"
    );

    converse(&mut conn, &id, &["first prompt"]).await;
    assert_eq!(
        conn.init_session_id(&id),
        id,
        "the CLI ran under the session's id"
    );
    rig.wait_for_transcript(&id).await;
    rig.wait_for_genesis_cleared(&id).await;
    let row = ledger.load_binding("claude", &id).expect("the row stays");
    assert_eq!(row.genesis, None);
    assert_eq!(row.cwd.as_deref(), rig.workspace.to_str());
}

/// §4.3 "undo, then restart before sending": the pending fork boots the same lazy
/// fork of its parent again under its own id (T6). Before its first prompt its
/// snapshot is the parent's prefix; once that prompt writes the fork's transcript
/// the same turns (ids included) lead it, the parent is untouched, and the
/// genesis is cleared.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pending_fork_reboots_the_same_fork_and_keeps_its_turn_ids() {
    let (rig, _) = ledger_rig().await;
    let mut conn = rig.connect().await;

    // The parent: a conversation of two turns.
    let parent_pane = conn.create("create-parent").await;
    converse(&mut conn, &parent_pane, &["first prompt", "second prompt"]).await;
    let parent = conn.init_session_id(&parent_pane);
    let parent_path = rig.wait_for_transcript(&parent).await;
    let parent_before = std::fs::read_to_string(&parent_path).expect("read the parent");
    let first_answer = parent_before
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|line| line["type"] == "assistant")
        .and_then(|line| line["uuid"].as_str().map(str::to_string))
        .expect("the parent's first answer");

    let child = uuid::Uuid::new_v4().to_string();
    rig.seed_pending_session(
        &child,
        &json!({ "kind": "fork", "parent": parent, "at": first_answer }),
    );
    let pending = rig
        .fresh_claude
        .get_snapshot(freshell_protocol::SessionType::Freshclaude, &child)
        .await
        .expect("a pending fork has a snapshot");
    let pending_turns = turn_ids(&pending);
    assert_eq!(
        pending_turns.last(),
        Some(&first_answer),
        "the parent's prefix through the fork point: {pending}"
    );

    conn.attach(&child).await;
    let boot = wait_for_query(&rig, "the fork boot", |o| {
        o["forkSession"] == true && o["sessionId"] == child.as_str()
    })
    .await;
    assert_eq!(boot["resume"], json!(parent), "{boot}");
    assert_eq!(boot["resumeSessionAt"], json!(first_answer), "{boot}");

    converse(&mut conn, &child, &["a different second prompt"]).await;
    assert_eq!(
        conn.init_session_id(&child),
        child,
        "the fork ran under the session's id"
    );
    rig.wait_for_transcript(&child).await;
    let materialized = rig
        .fresh_claude
        .get_snapshot(freshell_protocol::SessionType::Freshclaude, &child)
        .await
        .expect("the fork has a snapshot");
    let materialized_turns = turn_ids(&materialized);
    assert!(
        materialized_turns.len() > pending_turns.len()
            && materialized_turns[..pending_turns.len()] == pending_turns[..],
        "the pending turns lead the materialized fork with the same ids: \
         pending {pending_turns:?}, materialized {materialized_turns:?}"
    );
    assert_eq!(
        std::fs::read_to_string(&parent_path).expect("read the parent"),
        parent_before,
        "the fork never rewrites its parent"
    );
    rig.wait_for_genesis_cleared(&child).await;
}

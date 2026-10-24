//! A hosted kernel follows native conversation resets across runtime recovery.

mod common;

use common::claude_rig::{ClaudeRig, RigConnection, RigKind, RigOptions};
use serde_json::Value;

async fn reset(conn: &mut RigConnection, old: &str, request: &str) -> String {
    let start = conn.frames.len();
    conn.send_text(old, request, "/clear").await;
    let materialized = conn
        .wait_for_since(start, "the reset identity", |frame| {
            frame["type"] == "freshAgent.session.materialized" && frame["previousSessionId"] == old
        })
        .await;
    let new = materialized["sessionId"].as_str().unwrap().to_string();
    conn.wait_for_since(start, "the reset command settling", |frame| {
        frame["sessionId"] == new
            && frame["event"]["type"] == "freshAgent.status"
            && frame["event"]["status"] == "idle"
    })
    .await;
    new
}

async fn send_and_result(conn: &mut RigConnection, id: &str, request: &str) -> Value {
    let start = conn.frames.len();
    conn.send_text(id, request, request).await;
    conn.wait_for_since(start, "the submitted turn result", |frame| {
        frame["event"]["type"] == "freshAgent.result"
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unwired_native_lineage_survives_two_resets_and_runtime_recovery() {
    let rig = ClaudeRig::start_with_options(
        RigKind::Sim,
        RigOptions {
            unwired_runtime: true,
            ..RigOptions::default()
        },
    )
    .await;
    let mut conn = rig.connect().await;
    let a = conn.create("native-lineage-create").await;
    rig.converse(&mut conn, &a, &["original dialogue"]).await;
    let b = reset(&mut conn, &a, "first-native-reset").await;
    rig.converse(&mut conn, &b, &["middle dialogue"]).await;
    let c = reset(&mut conn, &b, "second-native-reset").await;
    rig.converse(&mut conn, &c, &["current dialogue"]).await;
    assert_eq!(rig.ledger_rows("boot").len(), 1);
    rig.kill_first_sidecar(&mut conn).await;
    rig.converse(&mut conn, &c, &["recover current conversation"])
        .await;
    assert_eq!(rig.ledger_rows("boot").len(), 2);

    let late_a = send_and_result(&mut conn, &a, "late-first-identity-send").await;
    assert_eq!(
        late_a["sessionId"], c,
        "the old UUID must address the recovered writer"
    );
    let late_b = send_and_result(&mut conn, &b, "late-second-identity-send").await;
    assert_eq!(late_b["sessionId"], c);
    assert_eq!(
        rig.ledger_rows("boot").len(),
        2,
        "late requests never reopen historical writers"
    );
    conn.kill(&a).await;
    assert!(!rig.fresh_claude.has_live_session(&c).await);
    rig.fresh_claude.shutdown().await;
}

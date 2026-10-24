//! The durable identity exists at create, including before the first prompt.

mod common;

use common::claude_rig::{ClaudeRig, RigKind, RigOptions};
use freshell_ws::pane_ledger::RowState;
use serde_json::json;

async fn create_identity(kind: RigKind) {
    for flavor in ["freshclaude", "kilroy"] {
        let rig = ClaudeRig::start_with_options(
            kind,
            RigOptions {
                durable_ledger: true,
                ..RigOptions::default()
            },
        )
        .await;
        let mut conn = rig.connect().await;
        let created = conn
            .request_create("create-identity", json!({"sessionType":flavor}))
            .await;
        let id = created["sessionId"].as_str().unwrap();
        assert!(
            uuid::Uuid::parse_str(id).is_ok(),
            "create must expose its durable UUID: {created}"
        );
        assert_eq!(
            created["sessionRef"],
            json!({"provider":"claude", "sessionId":id})
        );
        let ledger = rig.pane_ledger.as_ref().unwrap();
        let binding = ledger
            .lookup_by_session("claude", id)
            .expect("bound at create");
        assert_eq!(binding.row.state, RowState::Bound);
        assert_eq!(binding.row.mode, flavor);
        assert_eq!(
            ledger.binding_genesis("claude", id),
            Some(json!({"kind":"fresh"}))
        );
        assert_eq!(
            ledger
                .lookup_by_create_request_id("claude", "create-identity")
                .unwrap()
                .session_id,
            id
        );
        let (status, snapshot) = rig.snapshot(id).await;
        assert_eq!(status, 200, "{snapshot}");
        assert_eq!(snapshot["turns"], json!([]));
        conn.send(
            json!({"type":"freshAgent.send", "provider":"claude", "sessionType":flavor,
            "sessionId":id, "requestId":"first-send", "text":"first prompt"}),
        )
        .await;
        conn.wait_for("the first turn", |frame| {
            frame["event"]["type"] == "freshAgent.result"
        })
        .await;
        conn.read_for(std::time::Duration::from_millis(200)).await;
        assert_eq!(conn.init_session_id(id), id);
        assert_eq!(
            ledger
                .lookup_by_create_request_id("claude", "create-identity")
                .unwrap()
                .session_id,
            id,
            "a repeated SDK init preserves create-request lineage"
        );
        assert!(
            !conn
                .frames
                .iter()
                .any(|frame| frame["type"] == "freshAgent.session.materialized"),
            "a create-time UUID never materializes into a second identity"
        );
        rig.fresh_claude.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_binds_one_durable_uuid_before_any_prompt_for_claude_and_kilroy() {
    create_identity(RigKind::Sim).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_cli_create_keeps_one_uuid_before_and_after_the_first_prompt() {
    create_identity(RigKind::Cli).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn redriving_create_after_restart_recovers_the_same_zero_turn_uuid() {
    let mut rig = ClaudeRig::start_with_options(
        RigKind::Sim,
        RigOptions {
            durable_ledger: true,
            ..RigOptions::default()
        },
    )
    .await;
    let mut first = rig.connect().await;
    let created = first.request_create("same-create", json!({})).await;
    let id = created["sessionId"].as_str().unwrap().to_string();
    rig.restart().await;
    let mut second = rig.connect().await;
    let replay = second.request_create("same-create", json!({})).await;
    assert_eq!(replay["type"], "freshAgent.created", "{replay}");
    assert_eq!(
        replay["sessionId"], id,
        "restart must not mint another conversation"
    );
    assert_eq!(replay["sessionRef"]["sessionId"], id);
    let launches = rig.ledger_rows("query");
    assert_eq!(launches.len(), 2);
    assert_eq!(
        launches[1]["options"]["sessionId"], id,
        "zero-turn recovery boots Fresh under its durable id"
    );
    assert!(launches[1]["options"]["resume"].is_null());
    rig.fresh_claude.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn attaching_after_restart_reopens_a_zero_turn_uuid_with_fresh_boot() {
    let mut rig = ClaudeRig::start_with_options(
        RigKind::Sim,
        RigOptions {
            durable_ledger: true,
            ..RigOptions::default()
        },
    )
    .await;
    let mut first = rig.connect().await;
    let created = first.request_create("zero-turn-attach", json!({})).await;
    let id = created["sessionId"].as_str().unwrap().to_string();
    rig.restart().await;
    let mut second = rig.connect().await;
    second.attach(&id).await;
    let (status, snapshot) = rig.snapshot(&id).await;
    assert_eq!(status, 200, "{snapshot}");
    assert_eq!(snapshot["turns"], json!([]));
    let launches = rig.ledger_rows("query");
    assert_eq!(launches.len(), 2);
    assert_eq!(launches[1]["options"]["sessionId"], id);
    assert!(launches[1]["options"]["resume"].is_null());
    rig.fresh_claude.shutdown().await;
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_explicit_reopen_reclaims_the_same_closed_zero_turn_uuid() {
    for flavor in ["freshclaude", "kilroy"] {
        let rig = ClaudeRig::start_with_options(
            RigKind::Sim,
            RigOptions {
                durable_ledger: true,
                ..RigOptions::default()
            },
        )
        .await;
        let mut conn = rig.connect().await;
        let created = conn
            .request_create("zero-turn-close", json!({"sessionType":flavor}))
            .await;
        let id = created["sessionId"].as_str().unwrap();
        conn.send(json!({"type":"freshAgent.kill", "provider":"claude",
            "sessionType":flavor, "sessionId":id}))
            .await;
        let killed = conn
            .wait_for("the zero-turn close", |frame| {
                frame["type"] == "freshAgent.killed"
            })
            .await;
        assert_eq!(killed["success"], true, "{killed}");
        let reopened = conn
            .request_create(
                "zero-turn-reopen",
                json!({
                    "sessionType":flavor, "sessionRef":{"provider":"claude", "sessionId":id}
                }),
            )
            .await;
        assert_eq!(reopened["type"], "freshAgent.created", "{reopened}");
        assert_eq!(reopened["sessionId"], id);
        let ledger = rig.pane_ledger.as_ref().unwrap();
        assert_eq!(
            ledger.lookup_by_session("claude", id).unwrap().row.state,
            RowState::Bound
        );
        let (status, snapshot) = rig.snapshot(id).await;
        assert_eq!(status, 200, "{snapshot}");
        assert_eq!(snapshot["turns"], json!([]));
        let launches = rig.ledger_rows("query");
        assert_eq!(launches.len(), 2);
        assert_eq!(launches[1]["options"]["sessionId"], id);
        assert!(launches[1]["options"]["resume"].is_null());
        rig.fresh_claude.shutdown().await;
    }
}

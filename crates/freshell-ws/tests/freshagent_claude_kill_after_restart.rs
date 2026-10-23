//! Read compatibility for placeholder aliases persisted by older servers.
//! New runtimes use UUIDs; seed the old on-disk records, then exercise the
//! production sidecar and the actual kill/attach paths across ledger reloads.

mod common;

use common::claude_rig::{ClaudeRig, RigKind, RigOptions};
use freshell_ws::pane_ledger::{RetiredReason, RowState};
use serde_json::json;

async fn legacy_close_survives_restart(close_before_restart: bool) {
    let mut rig = ClaudeRig::start_with_options(
        RigKind::Sim,
        RigOptions {
            durable_ledger: true,
            ..RigOptions::default()
        },
    )
    .await;
    let mut old_server = rig.connect().await;
    let durable = old_server.create("legacy-record-source").await;
    rig.converse(&mut old_server, &durable, &["saved before the upgrade"])
        .await;
    let placeholder = "persisted-old-pane-placeholder";
    rig.pane_ledger
        .as_ref()
        .unwrap()
        .record_alias_tombstone("claude", placeholder, &durable, 1_000)
        .unwrap();
    // The old runtime is gone. The alias is now exclusively on disk, as
    // it is when a server upgrade first reads an older pane's saved state.
    rig.restart().await;
    assert!(rig
        .pane_ledger
        .as_ref()
        .unwrap()
        .alias_tombstone_records("claude", placeholder)
        .iter()
        .any(|(id, _)| id == &durable));
    if close_before_restart {
        rig.connect().await.kill(placeholder).await;
        rig.restart().await;
    }
    let mut client = rig.connect().await;
    if !close_before_restart {
        client.kill(placeholder).await;
    }
    let ledger = rig.pane_ledger.as_ref().unwrap();
    let row = ledger.load_binding("claude", &durable).unwrap();
    assert_eq!(row.state, RowState::Retired);
    assert_eq!(row.retired_reason, Some(RetiredReason::Closed));
    for id in [placeholder, durable.as_str()] {
        assert!(
            ledger.kill_tombstone_at("claude", id).is_some(),
            "missing close fence for {id}"
        );
    }

    client
        .send(json!({
            "type":"freshAgent.attach", "provider":"claude", "sessionType":"freshclaude",
            "sessionId":placeholder, "sessionRef":{"provider":"claude", "sessionId":durable},
        }))
        .await;
    let error = client
        .wait_for("a closed legacy pane refusal", |frame| {
            frame["event"]["type"] == "freshAgent.error"
                && frame["event"]["code"] == "SESSION_CLOSED"
        })
        .await;
    assert_eq!(error["sessionId"], placeholder);
    assert!(!rig.fresh_claude.has_live_session(&durable).await);
    assert_eq!(
        ledger.load_binding("claude", &durable).unwrap().state,
        RowState::Retired
    );
    assert!(ledger.kill_tombstone_at("claude", &durable).is_some());

    // An explicit new open of the durable conversation is still allowed.
    // A closed legacy pane and a new open are distinct user actions.
    let mut reopened = rig.connect().await;
    reopened.attach(&durable).await;
    rig.converse(&mut reopened, &durable, &["explicitly reopened"])
        .await;
    rig.fresh_claude.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_kill_by_legacy_placeholder_after_restart_closes_its_durable_row() {
    legacy_close_survives_restart(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_legacy_close_written_before_restart_still_blocks_the_late_attach() {
    legacy_close_survives_restart(true).await;
}

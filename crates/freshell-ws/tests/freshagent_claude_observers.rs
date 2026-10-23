//! Attaching another page observes one canonical runtime without resetting peers.

mod common;

use common::claude_rig::{ClaudeRig, RigKind, RigOptions};
use serde_json::json;
use std::time::Duration;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn attaching_mid_turn_acknowledges_running_only_to_the_requester() {
    let rig = ClaudeRig::start(RigKind::Sim).await;
    let mut first = rig.connect().await;
    let session = first.create("create-observers").await;
    let mut second = rig.connect().await;
    first.send_text(&session, "hang", "HANG").await;
    first.wait_for_event("freshAgent.stream").await;
    second
        .send(json!({
            "type": "freshAgent.attach", "provider": "claude", "sessionType": "freshclaude",
            "sessionId": session, "sessionRef": {"provider":"claude", "sessionId":session},
        }))
        .await;
    let ack = second.wait_for_event("freshAgent.session.snapshot").await;
    assert_eq!(ack["sessionId"], session);
    assert_eq!(ack["event"]["status"], "running");
    first.read_for(Duration::from_millis(100)).await;
    assert_eq!(
        first.events_seen("freshAgent.session.snapshot"),
        0,
        "another page's attach must not reset this page's live stream"
    );

    // Finish the held turn, then prove both observers receive the next
    // stream, status, result and completion under the same durable UUID.
    first.send(json!({
        "type":"freshAgent.interrupt", "provider":"claude", "sessionType":"freshclaude", "sessionId":session,
    })).await;
    first.wait_for_event("freshAgent.result").await;
    first.read_for(Duration::from_millis(100)).await;
    second.read_for(Duration::from_millis(100)).await;
    first.frames.clear();
    second.frames.clear();
    first
        .send_text(&session, "next", "both pages receive this turn")
        .await;
    for page in [&mut first, &mut second] {
        page.wait_for_event("freshAgent.turn.complete").await;
        for event in [
            "freshAgent.stream",
            "freshAgent.status",
            "freshAgent.result",
        ] {
            assert!(
                page.frames.iter().any(|frame| {
                    frame["sessionId"] == session && frame["event"]["type"] == event
                }),
                "the observer missed {event}: {:?}",
                page.frames
            );
        }
        assert_eq!(page.events_seen("freshAgent.turn.complete"), 1);
    }
    rig.fresh_claude.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_legacy_placeholder_attach_materializes_and_resumes_the_durable_uuid() {
    let mut rig = ClaudeRig::start_with_options(
        RigKind::Sim,
        RigOptions {
            durable_ledger: true,
            ..RigOptions::default()
        },
    )
    .await;
    let mut first = rig.connect().await;
    let session = first.create("create-legacy-observer").await;
    rig.converse(&mut first, &session, &["before the restart"])
        .await;
    rig.restart().await;
    let mut legacy = rig.connect().await;
    legacy.send(json!({
        "type": "freshAgent.attach", "provider":"claude", "sessionType":"freshclaude",
        "sessionId":"legacy-placeholder", "sessionRef":{"provider":"claude", "sessionId":session},
    })).await;
    legacy.wait_for_event("freshAgent.session.snapshot").await;
    let materialized = legacy
        .frames
        .iter()
        .position(|frame| {
            frame["type"] == "freshAgent.session.materialized"
                && frame["previousSessionId"] == "legacy-placeholder"
                && frame["sessionId"] == session
        })
        .expect("an open legacy pane must learn the canonical UUID");
    let ack = legacy
        .frames
        .iter()
        .position(|frame| {
            frame["sessionId"] == session && frame["event"]["type"] == "freshAgent.session.snapshot"
        })
        .expect("the migrated pane must receive its attach acknowledgement");
    assert!(materialized < ack);
    assert!(rig.fresh_claude.has_live_session(&session).await);
    rig.converse(&mut legacy, &session, &["after legacy migration"])
        .await;
    rig.fresh_claude.shutdown().await;
}

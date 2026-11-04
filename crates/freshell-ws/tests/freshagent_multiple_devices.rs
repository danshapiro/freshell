//! Requester-scoped attach replies for independent browser connections.

mod common;

use common::claude_rig::{ClaudeRig, RigKind};
use common::multiple_devices::{
    attach_request, legacy_attach_request, FRESH_AGENT_RECONCILIATION_CAPABILITY,
};
use serde_json::json;
use std::time::Duration;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn attach_requester_isolation() {
    let rig = ClaudeRig::start(RigKind::Sim).await;
    let mut first = rig
        .connect_with_capabilities(json!({ (FRESH_AGENT_RECONCILIATION_CAPABILITY): true }))
        .await;
    let session = first.create("create-multiple-device-attach").await;
    let mut second = rig
        .connect_with_capabilities(json!({ (FRESH_AGENT_RECONCILIATION_CAPABILITY): true }))
        .await;

    first
        .send_text(&session, "held-multiple-device-turn", "HANG")
        .await;
    first.wait_for_event("freshAgent.stream").await;

    let peer_start = first.frames.len();
    let reply_start = second.frames.len();
    second
        .send(attach_request(
            "claude",
            "freshclaude",
            &session,
            "mobile-view",
            "mobile-attach-1",
        ))
        .await;
    let attached = second
        .wait_for_since(reply_start, "the correlated attach result", |frame| {
            frame["type"] == "freshAgent.attached"
                && frame["requestId"] == "mobile-attach-1"
                && frame["viewId"] == "mobile-view"
        })
        .await;
    assert_eq!(attached["status"], "running");
    assert_eq!(attached["snapshot"]["type"], "freshAgent.session.snapshot");
    assert_eq!(attached["snapshot"]["status"], "running");
    second.read_for(Duration::from_millis(100)).await;
    assert_eq!(
        second.frames[reply_start..]
            .iter()
            .filter(|frame| frame["type"] == "freshAgent.attached")
            .count(),
        1,
        "one attach request must settle exactly once"
    );

    first.read_for(Duration::from_millis(100)).await;
    assert!(
        !first.frames[peer_start..].iter().any(|frame| {
            frame["type"] == "freshAgent.attached"
                || (frame["type"] == "freshAgent.event"
                    && frame["event"]["type"] == "freshAgent.session.snapshot")
        }),
        "the first view must not receive the second view's attach snapshot"
    );

    let failure_start = second.frames.len();
    second
        .send(json!({
            "type": "freshAgent.attach",
            "requestId": "mobile-attach-invalid-fence",
            "viewId": "mobile-view",
            "provider": "claude",
            "sessionType": "freshclaude",
            "sessionId": session,
            "sessionRef": { "provider": "claude", "sessionId": session },
            "observedEpoch": 7,
        }))
        .await;
    let failed = second
        .wait_for_since(failure_start, "typed requester attach failure", |frame| {
            frame["type"] == "freshAgent.attach.failed"
                && frame["requestId"] == "mobile-attach-invalid-fence"
        })
        .await;
    assert_eq!(failed["code"], "INVALID_FENCE");
    first.read_for(Duration::from_millis(100)).await;
    assert!(!first.frames[peer_start..].iter().any(|frame| {
        frame["type"] == "freshAgent.attach.failed"
            || (frame["type"] == "freshAgent.event"
                && frame["event"]["type"] == "freshAgent.error"
                && frame["event"]["code"] == "INVALID_FENCE")
    }));

    first
        .send(json!({
            "type": "freshAgent.interrupt",
            "provider": "claude",
            "sessionType": "freshclaude",
            "sessionId": session,
        }))
        .await;
    first.wait_for_event("freshAgent.result").await;
    second.wait_for_event("freshAgent.result").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn legacy_attach_keeps_event_shape_on_its_requester_only() {
    let rig = ClaudeRig::start(RigKind::Sim).await;
    let mut first = rig.connect().await;
    let session = first.create("legacy-multiple-device-attach").await;
    let mut second = rig.connect().await;

    first
        .send_text(&session, "held-legacy-attach-turn", "HANG")
        .await;
    first.wait_for_event("freshAgent.stream").await;

    let peer_start = first.frames.len();
    let requester_start = second.frames.len();
    second
        .send(legacy_attach_request(
            "claude",
            "freshclaude",
            &session,
            "legacy-mobile-view",
        ))
        .await;
    let snapshot = second
        .wait_for_since(
            requester_start,
            "legacy event-shaped attach snapshot",
            |frame| {
                frame["type"] == "freshAgent.event"
                    && frame["event"]["type"] == "freshAgent.session.snapshot"
                    && frame["sessionId"] == session
            },
        )
        .await;
    assert_eq!(snapshot["event"]["status"], "running");
    second.read_for(Duration::from_millis(100)).await;
    assert!(
        !second.frames[requester_start..]
            .iter()
            .any(|frame| frame["type"] == "freshAgent.attached"),
        "an unnegotiated request without requestId keeps the prior event-shaped protocol"
    );

    first.read_for(Duration::from_millis(100)).await;
    assert!(
        !first.frames[peer_start..].iter().any(|frame| {
            frame["type"] == "freshAgent.event"
                && frame["event"]["type"] == "freshAgent.session.snapshot"
                && frame["sessionId"] == session
        }),
        "the legacy attach snapshot is requester-scoped even though its wire shape is old"
    );

    let unnegotiated_start = second.frames.len();
    second
        .send(json!({
            "type": "freshAgent.attach",
            "requestId": "legacy-client-attach-request-id",
            "viewId": "legacy-mobile-view",
            "provider": "claude",
            "sessionType": "freshclaude",
            "sessionId": session,
            "sessionRef": { "provider": "claude", "sessionId": session },
        }))
        .await;
    second
        .wait_for_since(
            unnegotiated_start,
            "unnegotiated event-shaped compatibility snapshot",
            |frame| {
                frame["type"] == "freshAgent.event"
                    && frame["event"]["type"] == "freshAgent.session.snapshot"
                    && frame["sessionId"] == session
            },
        )
        .await;
    second.read_for(Duration::from_millis(100)).await;
    assert!(!second.frames[unnegotiated_start..].iter().any(|frame| {
        matches!(
            frame["type"].as_str(),
            Some("freshAgent.attached" | "freshAgent.attach.failed")
        )
    }));

    first
        .send(json!({
            "type": "freshAgent.interrupt",
            "provider": "claude",
            "sessionType": "freshclaude",
            "sessionId": session,
        }))
        .await;
    first.wait_for_event("freshAgent.result").await;
    second.wait_for_event("freshAgent.result").await;
}

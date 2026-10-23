//! Process-only Claude recovery preserves the durable conversation.
#![cfg(unix)]
mod common;
use common::claude_rig::{ClaudeRig, RigKind, RigOptions};
use freshell_freshagent::{ClaudeSendOutcome, ClaudeTurnEvent};
use freshell_ws::pane_ledger::RowState;
use serde_json::json;
use std::time::Duration;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn malformed_and_obsolete_recovery_fences_leave_the_runtime_and_binding_live() {
    let rig = ClaudeRig::start_with_options(
        RigKind::Sim,
        RigOptions {
            durable_ledger: true,
            ..RigOptions::default()
        },
    )
    .await;
    let mut conn = rig.connect().await;
    let id = conn.create("fenced-recovery-stop").await;
    let owner = rig.fresh_claude.ownership_snapshot("claude", &id);
    assert!(owner.generation > 0);
    for (request_id, fields, code) in [
        (
            "half-recovery-fence",
            json!({"observedEpoch":owner.epoch}),
            "INVALID_FENCE",
        ),
        (
            "stale-recovery-fence",
            json!({"observedEpoch":owner.epoch, "observedGeneration":owner.generation - 1}),
            "STALE_CLAIM",
        ),
    ] {
        let mut request = json!({"type":"freshAgent.recovery.stop", "provider":"claude", "sessionType":"freshclaude",
            "sessionId":id, "requestId":request_id});
        request
            .as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        conn.send(request).await;
        let refused = conn
            .wait_for("the fenced recovery refusal", |frame| {
                frame["type"] == "freshAgent.recovery.stopped" && frame["requestId"] == request_id
            })
            .await;
        assert_eq!(refused["success"], false, "{refused}");
        assert_eq!(refused["code"], code, "{refused}");
        assert!(rig.fresh_claude.has_live_session(&id).await);
        assert_eq!(
            rig.pane_ledger
                .as_ref()
                .unwrap()
                .lookup_by_session("claude", &id)
                .unwrap()
                .row
                .state,
            RowState::Bound
        );
    }
    assert_eq!(rig.ledger_rows("query").len(), 1);
    rig.fresh_claude.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unsupported_recovery_stop_cells_reply_to_the_original_request_and_provider() {
    let rig = ClaudeRig::start(RigKind::Sim).await;
    let mut conn = rig.connect().await;
    for (provider, session_type) in [
        ("opencode", "freshopencode"),
        ("amplifier", "freshclaude"),
        ("claude", "freshcodex"),
    ] {
        let request_id = format!("unsupported-{provider}-{session_type}");
        conn.send(json!({"type":"freshAgent.recovery.stop", "provider":provider, "sessionType":session_type,
            "sessionId":"unsupported-recovery-session", "requestId":request_id})).await;
        let reply = conn
            .wait_for("the recovery capability refusal", |frame| {
                frame["type"] == "freshAgent.recovery.stopped" && frame["requestId"] == request_id
            })
            .await;
        assert_eq!(reply["success"], false, "{reply}");
        assert_eq!(reply["code"], "UNSUPPORTED_CAPABILITY", "{reply}");
        assert_eq!(reply["provider"], provider);
        assert_eq!(reply["sessionType"], session_type);
    }
    assert!(rig.ledger_rows("query").is_empty());
    rig.fresh_claude.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recovery_stop_keeps_the_binding_and_ends_only_the_owned_runtime_without_a_bell() {
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
            .request_create("process-only-recovery", json!({"sessionType":flavor}))
            .await;
        let id = created["sessionId"].as_str().unwrap();
        let mut events = rig.fresh_claude.subscribe_turn_events();
        let outcome = rig.fresh_claude.handle_send(serde_json::from_value(json!({
            "provider":"claude", "sessionType":flavor, "sessionId":id, "requestId":"recover-hang", "text":"HANG",
        })).unwrap()).await;
        let ClaudeSendOutcome::Accepted { ownership_id, .. } = outcome else {
            panic!("the hanging turn must be accepted: {outcome:?}");
        };
        let before = conn.events_seen("freshAgent.turn.complete");
        conn.send(
            json!({"type":"freshAgent.recovery.stop", "provider":"claude", "sessionType":flavor,
            "sessionId":id, "requestId":"stop-for-recovery"}),
        )
        .await;
        let stopped = conn
            .wait_for("the correlated recovery stop", |frame| {
                frame["type"] == "freshAgent.recovery.stopped"
                    && frame["requestId"] == "stop-for-recovery"
            })
            .await;
        assert_eq!(stopped["success"], true, "{stopped}");
        assert_eq!(stopped["provider"], "claude");
        assert_eq!(stopped["sessionType"], flavor);
        let ended = tokio::time::timeout(Duration::from_secs(1), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(
            matches!(ended, ClaudeTurnEvent::Ended { ownership_id: old, .. } if old == ownership_id)
        );
        assert!(!rig.fresh_claude.has_live_session(id).await);
        assert_eq!(
            rig.pane_ledger
                .as_ref()
                .unwrap()
                .lookup_by_session("claude", id)
                .unwrap()
                .row
                .state,
            RowState::Bound
        );
        assert_eq!(
            rig.fresh_claude.live_snapshot_overlay(id).await["status"],
            "exited"
        );
        conn.read_for(Duration::from_millis(250)).await;
        assert_eq!(
            conn.events_seen("freshAgent.turn.complete"),
            before,
            "a requested recovery stop never rings"
        );
        conn.attach(id).await;
        assert!(rig.fresh_claude.has_live_session(id).await);
        assert_eq!(rig.ledger_rows("query").len(), 2);
        rig.fresh_claude.shutdown().await;
    }
}

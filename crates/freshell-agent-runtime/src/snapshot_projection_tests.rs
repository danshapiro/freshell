use crate::snapshot_projection::project_hosted_snapshot;
use serde_json::{json, Value};

fn advertised_capabilities() -> Value {
    json!({
        "send": true,
        "interrupt": true,
        "approvals": true,
        "questions": true,
        "fork": true,
        "worktrees": true,
        "diffs": true,
        "childThreads": true,
        "undo": true,
        "redo": true,
        "settingScopes": {
            "model": "per-send",
            "effort": "per-send",
            "sandbox": "per-send",
            "permissionMode": "per-send"
        }
    })
}

#[test]
fn every_hosted_provider_and_snapshot_envelope_intersects_native_and_gateway_truth() {
    let providers = [
        ("claude", "freshclaude", true, false),
        ("claude", "kilroy", true, false),
        ("codex", "freshcodex", false, true),
        ("opencode", "freshopencode", true, true),
    ];

    for (provider, session_type, redo_supported, fork_supported) in providers {
        for (snapshot_type, nested) in [
            ("freshAgent.session.snapshot", false),
            ("freshAgent.session.snapshot", true),
            ("freshAgent.snapshot", false),
            ("freshAgent.snapshot", true),
        ] {
            let snapshot = json!({
                "type": snapshot_type,
                "provider": provider,
                "sessionType": session_type,
                "sessionId": "native-session",
                "capabilities": advertised_capabilities(),
                "rollback": {
                    "canRedo": true,
                    "undoneDepth": 1,
                    "redoableTurnIds": ["turn-1"]
                }
            });
            let mut payload = if nested {
                json!({
                    "type": "freshAgent.event",
                    "provider": provider,
                    "sessionType": session_type,
                    "sessionId": "native-session",
                    "event": snapshot
                })
            } else {
                snapshot
            };

            project_hosted_snapshot(&mut payload, provider, session_type);
            let projected = if nested { &payload["event"] } else { &payload };
            let capabilities = &projected["capabilities"];

            for supported in [
                "send",
                "interrupt",
                "approvals",
                "questions",
                "diffs",
                "undo",
            ] {
                assert_eq!(
                    capabilities[supported], true,
                    "{provider}/{session_type}/{supported}"
                );
            }
            assert_eq!(
                capabilities["fork"], fork_supported,
                "{provider}/{session_type}/fork"
            );
            assert_eq!(capabilities["worktrees"], false);
            assert_eq!(
                capabilities["childThreads"], true,
                "provider child topology must remain visible without becoming a soul"
            );
            assert_eq!(
                capabilities["redo"], redo_supported,
                "{provider}/{session_type}/redo"
            );
            assert_eq!(projected["rollback"]["canRedo"], redo_supported);
            assert_eq!(
                projected["rollback"].get("redoableTurnIds").is_some(),
                redo_supported,
                "redo targets exist iff redo dispatch is supported"
            );
        }
    }
}

#[test]
fn native_false_remains_false_for_operations_the_gateway_implements() {
    let mut payload = json!({
        "type": "freshAgent.session.snapshot",
        "provider": "opencode",
        "sessionType": "freshopencode",
        "capabilities": {
            "send": false,
            "interrupt": false,
            "approvals": false,
            "questions": false,
            "fork": false,
            "diffs": false,
            "undo": false,
            "redo": false
        },
        "rollback": {"canRedo": true, "undoneDepth": 1, "redoableTurnIds": ["turn-1"]}
    });

    project_hosted_snapshot(&mut payload, "opencode", "freshopencode");
    for capability in [
        "send",
        "interrupt",
        "approvals",
        "questions",
        "fork",
        "diffs",
        "childThreads",
        "undo",
        "redo",
    ] {
        assert_eq!(
            payload["capabilities"][capability], false,
            "native {capability} false was falsified"
        );
    }
    assert_eq!(payload["capabilities"]["worktrees"], false);
    assert_eq!(payload["rollback"]["canRedo"], false);
    assert!(payload["rollback"].get("redoableTurnIds").is_none());
}

#[test]
fn malformed_or_mismatched_snapshot_capabilities_fail_closed() {
    for (provider, session_type, capabilities) in [
        ("opencode", "freshopencode", Value::Null),
        ("opencode", "freshopencode", json!({})),
        (
            "opencode",
            "freshopencode",
            json!({"send":"yes","interrupt":1,"fork":true,"undo":true,"redo":true}),
        ),
        ("codex", "freshopencode", advertised_capabilities()),
        ("future-provider", "freshfuture", advertised_capabilities()),
    ] {
        let mut payload = json!({
            "type": "freshAgent.event",
            "provider": provider,
            "sessionType": session_type,
            "event": {
                "type": "freshAgent.session.snapshot",
                "capabilities": capabilities,
                "rollback": {"canRedo": true, "undoneDepth": 1, "redoableTurnIds": ["turn-1"]}
            }
        });

        project_hosted_snapshot(&mut payload, provider, session_type);
        let projected = &payload["event"];
        for capability in [
            "send",
            "interrupt",
            "approvals",
            "questions",
            "fork",
            "worktrees",
            "diffs",
            "childThreads",
            "undo",
            "redo",
        ] {
            assert_eq!(
                projected["capabilities"][capability], false,
                "{capability} did not fail closed"
            );
        }
        assert_eq!(projected["rollback"]["canRedo"], false);
        assert!(projected["rollback"].get("redoableTurnIds").is_none());
    }
}

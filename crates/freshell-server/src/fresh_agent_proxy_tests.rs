use super::*;

#[test]
fn presentation_rewrite_keeps_materialized_native_identity() {
    let mut created = serde_json::json!({
        "type":"freshAgent.created",
        "sessionId":"internal",
        "sessionRef":{"provider":"opencode","sessionId":"internal"}
    });
    rewrite_presentation_id(&mut created, "public");
    assert_eq!(created["sessionId"], "public");
    assert_eq!(created["sessionRef"]["sessionId"], "public");

    let mut materialized = serde_json::json!({
        "type":"freshAgent.session.materialized",
        "previousSessionId":"internal",
        "sessionId":"native"
    });
    rewrite_presentation_id(&mut materialized, "public");
    assert_eq!(materialized["previousSessionId"], "public");
    assert_eq!(materialized["sessionId"], "native");
}

#[test]
fn stable_ids_are_provider_scoped_and_do_not_contain_input() {
    let claude = stable_soul_id("claude", "private-request-content").unwrap();
    let codex = stable_soul_id("codex", "private-request-content").unwrap();
    assert_ne!(claude, codex);
    assert!(!claude.as_str().contains("private-request-content"));
}

#[test]
fn resume_reuses_only_the_exact_running_soul_identity() {
    assert!(resume_identity_matches(
        DesiredState::Running,
        Some("codex"),
        Some("thread-7"),
        Some("managed-codex-public"),
        "codex",
        "thread-7",
    ));
    assert!(resume_identity_matches(
        DesiredState::Running,
        Some("codex"),
        Some("thread-7"),
        Some("managed-codex-public"),
        "codex",
        "managed-codex-public",
    ));
    assert!(!resume_identity_matches(
        DesiredState::Running,
        Some("claude"),
        Some("thread-7"),
        None,
        "codex",
        "thread-7",
    ));
    assert!(!resume_identity_matches(
        DesiredState::Stopped,
        Some("codex"),
        Some("thread-7"),
        None,
        "codex",
        "thread-7",
    ));
}

#[test]
fn only_provider_terminal_edges_complete_a_rest_turn() {
    assert!(provider_event_completes_turn(&AgentEvent::Provider {
        payload: serde_json::json!({
            "type":"freshAgent.event",
            "event":{"type":"freshAgent.turn.complete"}
        }),
    }));
    assert!(provider_event_completes_turn(&AgentEvent::Provider {
        payload: serde_json::json!({
            "type":"freshAgent.event",
            "event":{"type":"freshAgent.status","status":"idle"}
        }),
    }));
    assert!(!provider_event_completes_turn(&AgentEvent::Provider {
        payload: serde_json::json!({
            "type":"freshAgent.event",
            "event":{"type":"freshAgent.status","status":"busy"}
        }),
    }));
}

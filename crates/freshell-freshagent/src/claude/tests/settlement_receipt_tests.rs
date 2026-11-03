use super::*;
use crate::claude::turn_status::SettledTurn;
use crate::claude_edges::EdgeRecord;
use crate::claude_turns::ResultVerdict;

#[test]
fn correlated_settlement_preserves_absorbed_requests_outcomes_and_public_failure() {
    for (verdict, expected, message) in [
        (
            ResultVerdict::Completed { is_error: false },
            "completed",
            None,
        ),
        (
            ResultVerdict::Failed {
                message: "The provider could not complete the turn.".into(),
            },
            "failed",
            Some("The provider could not complete the turn."),
        ),
        (ResultVerdict::Silent, "interrupted", None),
    ] {
        let (state, mut rx) = state_with_bus();
        let clock = crate::attention::AttentionClock::default();
        let record = EdgeRecord {
            session_key: "owned-key",
            stamp: "owned-session",
            sidecar_session_id: "sidecar-session",
            session_type: "freshclaude",
            clock: &clock,
        };
        state.ring_settled_turn(
            &record,
            SettledTurn {
                busy: false,
                verdict,
                request_ids: vec!["first-request".into(), "absorbed-request".into()],
                command_ids: vec!["first-command".into(), "absorbed-command".into()],
            },
        );
        let frames: Vec<Value> = std::iter::from_fn(|| rx.try_recv().ok())
            .map(|raw| serde_json::from_str(&raw).unwrap())
            .collect();
        let receipt = frames
            .iter()
            .find(|frame| frame["event"]["type"] == "freshAgent.turn.settled")
            .expect("every settled request needs a correlated result");
        assert_eq!(receipt["provider"], "claude");
        assert_eq!(receipt["sessionId"], "owned-session");
        assert_eq!(
            receipt["event"]["requestIds"],
            json!(["first-request", "absorbed-request"])
        );
        assert_eq!(receipt["event"]["outcome"], expected);
        assert_eq!(receipt["event"]["message"].as_str(), message);
    }
}

#[test]
fn compact_without_a_send_request_has_no_correlated_settlement() {
    let (state, mut rx) = state_with_bus();
    let clock = crate::attention::AttentionClock::default();
    let record = EdgeRecord {
        session_key: "owned-key",
        stamp: "owned-session",
        sidecar_session_id: "sidecar-session",
        session_type: "freshclaude",
        clock: &clock,
    };
    state.ring_settled_turn(
        &record,
        SettledTurn {
            busy: false,
            verdict: ResultVerdict::Completed { is_error: false },
            request_ids: vec![],
            command_ids: vec!["compact-command".into()],
        },
    );
    assert!(std::iter::from_fn(|| rx.try_recv().ok()).all(|raw| {
        serde_json::from_str::<Value>(&raw).unwrap()["event"]["type"] != "freshAgent.turn.settled"
    }));
}

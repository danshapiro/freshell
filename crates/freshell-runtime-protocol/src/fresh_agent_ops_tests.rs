use super::*;

#[test]
fn semantic_operation_requests_round_trip_with_stable_identity() {
    let soul_id = SoulId::parse("soul-ops").unwrap();
    let compact = FreshAgentCompactRequest {
        soul_id: soul_id.clone(),
        instructions: Some("retain decisions".into()),
        cwd: Some("/workspace".into()),
        expected_control_epoch: Some(7),
    };
    assert_eq!(
        serde_json::from_value::<FreshAgentCompactRequest>(serde_json::to_value(&compact).unwrap())
            .unwrap(),
        compact
    );
    let rollback = FreshAgentRollbackRequest {
        soul_id,
        direction: FreshAgentRollbackDirection::Undo,
        mode: FreshAgentRollbackMode::ToTurn,
        turn_id: Some("turn-7".into()),
        cwd: Some("/workspace".into()),
        expected_control_epoch: Some(7),
    };
    assert_eq!(
        serde_json::from_value::<FreshAgentRollbackRequest>(
            serde_json::to_value(&rollback).unwrap()
        )
        .unwrap(),
        rollback
    );
}

#[test]
fn capture_contract_preserves_exact_identity_and_bounds() {
    let capture = FreshAgentCapture {
        provider: FreshProvider::Claude,
        session_type: "freshclaude".into(),
        presentation_session_id: "presentation-1".into(),
        native_session_id: "native-1".into(),
        text: "user: hello".into(),
        truncated: false,
    };
    let restored: FreshAgentCapture =
        serde_json::from_value(serde_json::to_value(&capture).unwrap()).unwrap();
    assert_eq!(restored, capture);
}

#[test]
fn admin_and_host_envelopes_keep_the_same_semantic_request_id() {
    let request_id = RequestId::parse("request-semantic-1").unwrap();
    let soul_id = SoulId::parse("soul-semantic-1").unwrap();
    let admin = Envelope::new(
        request_id.clone(),
        ControlRole::Web,
        AdminCommand::FreshAgentRollback(FreshAgentRollbackRequest {
            soul_id,
            direction: FreshAgentRollbackDirection::Redo,
            mode: FreshAgentRollbackMode::Step,
            turn_id: None,
            cwd: None,
            expected_control_epoch: Some(4),
        }),
    );
    let admin: Envelope<AdminCommand> =
        serde_json::from_value(serde_json::to_value(admin).unwrap()).unwrap();
    assert_eq!(admin.request_id, request_id);

    let host = HostCommand::FreshAgentRollback {
        incarnation_id: IncarnationId::parse("incarnation-semantic-1").unwrap(),
        request_id: request_id.clone(),
        direction: FreshAgentRollbackDirection::Redo,
        mode: FreshAgentRollbackMode::Step,
        turn_id: None,
        cwd: None,
    };
    let restored: HostCommand =
        serde_json::from_value(serde_json::to_value(host).unwrap()).unwrap();
    assert!(matches!(
        restored,
        HostCommand::FreshAgentRollback {
            request_id: restored_id,
            ..
        } if restored_id == request_id
    ));
}

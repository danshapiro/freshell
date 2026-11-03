use super::*;
use freshell_runtime_protocol::{FreshAgentSendDiagnosticOutcome, RecoveryBlockReason};

async fn blocked_fixture() -> (tempfile::TempDir, Registry, SoulId, Supervisor) {
    let root = tempfile::tempdir().unwrap();
    let registry = Registry::open(root.path().join("registry"), None).unwrap();
    let soul = SoulId::new();
    crate::registry::tests::materialize_fresh_runtime(&registry, soul.clone(), root.path()).await;
    let supervisor = crate::recovery::tests::missing_supervisor(&root, registry.clone());
    (root, registry, soul, supervisor)
}

async fn block(registry: &Registry, soul: &SoulId) {
    let context = registry.recovery_context(soul.clone()).await.unwrap();
    registry
        .mark_recovery_blocked(
            soul.clone(),
            None,
            RecoveryBlockReason::StoreUnreadable,
            Vec::new(),
            context.write_fence(),
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn new_blocked_send_is_refused_with_the_available_recovery_reason() {
    for with_reason in [true, false] {
        let (_root, registry, soul, supervisor) = blocked_fixture().await;
        block(&registry, &soul).await;
        if !with_reason {
            let database = rusqlite::Connection::open(registry.database_path()).unwrap();
            database
                .execute(
                    "UPDATE souls SET recovery_reason=NULL WHERE soul_id=?1",
                    [soul.as_str()],
                )
                .unwrap();
        }
        let before = registry.recovery_context(soul.clone()).await.unwrap();
        let request = RequestId::parse("new-blocked-send").unwrap();
        let error = supervisor
            .fresh_agent_send(
                request.clone(),
                soul.clone(),
                "new message".into(),
                None,
                None,
            )
            .await
            .unwrap_err();
        let diagnostic = error
            .fresh_agent_send_diagnostic
            .expect("a new, unadmitted message must have a typed refusal");
        assert_eq!(diagnostic.outcome, FreshAgentSendDiagnosticOutcome::Refused);
        let message = diagnostic
            .message
            .expect("the refusal must explain the failure");
        assert!(message.contains("blocked"), "{message}");
        assert_eq!(
            message.contains("STORE_UNREADABLE"),
            with_reason,
            "{message}"
        );
        assert!(matches!(
            registry
                .recorded_input_outcome(soul.clone(), request, b"new message", Some(b"null"))
                .await
                .unwrap(),
            Some(InputJournalDisposition::Refused(_))
        ));
        let after = registry.recovery_context(soul).await.unwrap();
        assert_eq!(after.accepted_command_count, before.accepted_command_count);
        assert_eq!(
            after.dispatched_command_count,
            before.dispatched_command_count
        );
        assert_eq!(after.never_dispatched, before.never_dispatched);
    }
}

#[tokio::test]
async fn blocked_send_preserves_existing_queued_ambiguous_and_accepted_outcomes() {
    let (_root, registry, soul, supervisor) = blocked_fixture().await;
    for (id, state) in [
        ("already-queued", "queued"),
        ("already-dispatching", "dispatching"),
        ("already-accepted", "completed"),
    ] {
        let request = RequestId::parse(id).unwrap();
        registry
            .begin_fresh_input(
                soul.clone(),
                request.clone(),
                b"prior message",
                b"null",
                None,
            )
            .await
            .unwrap();
        match state {
            "dispatching" => registry
                .mark_input_dispatching(soul.clone(), request)
                .await
                .unwrap(),
            "completed" => registry
                .mark_input_completed(soul.clone(), request)
                .await
                .unwrap(),
            _ => {}
        }
    }
    block(&registry, &soul).await;

    let queued = supervisor
        .fresh_agent_send(
            RequestId::parse("already-queued").unwrap(),
            soul.clone(),
            "prior message".into(),
            None,
            None,
        )
        .await
        .unwrap_err();
    assert!(
        queued.fresh_agent_send_diagnostic.is_none(),
        "a queued request can still be replayed"
    );
    let dispatching = supervisor
        .fresh_agent_send(
            RequestId::parse("already-dispatching").unwrap(),
            soul.clone(),
            "prior message".into(),
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(dispatching, CommandState::Ambiguous);
    let accepted = supervisor
        .fresh_agent_send(
            RequestId::parse("already-accepted").unwrap(),
            soul,
            "prior message".into(),
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(accepted, CommandState::Completed);
}

#[tokio::test]
async fn blocked_send_refusal_preserves_input_settings_and_checkpoint_identity() {
    let (_root, registry, soul, supervisor) = blocked_fixture().await;
    block(&registry, &soul).await;
    let request = RequestId::parse("blocked-correlated-send").unwrap();
    let settings = freshell_runtime_protocol::FreshAgentTurnSettings {
        model: Some("original-model".into()),
        ..Default::default()
    };
    let initial = supervisor
        .fresh_agent_send(
            request.clone(),
            soul.clone(),
            "original message".into(),
            Some(settings.clone()),
            Some("original-attempt".into()),
        )
        .await
        .unwrap_err();
    assert_eq!(
        initial.fresh_agent_send_diagnostic.unwrap().outcome,
        FreshAgentSendDiagnosticOutcome::Refused
    );
    for (message, model, attempt) in [
        ("different message", "original-model", "original-attempt"),
        ("original message", "different-model", "original-attempt"),
        ("original message", "original-model", "different-attempt"),
    ] {
        let changed_settings = freshell_runtime_protocol::FreshAgentTurnSettings {
            model: Some(model.into()),
            ..Default::default()
        };
        let conflict = supervisor
            .fresh_agent_send(
                request.clone(),
                soul.clone(),
                message.into(),
                Some(changed_settings),
                Some(attempt.into()),
            )
            .await
            .unwrap_err();
        assert_eq!(conflict.code, RuntimeErrorCode::RequestIdConflict);
    }
}

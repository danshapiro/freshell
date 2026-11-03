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
        let database = rusqlite::Connection::open(registry.database_path()).unwrap();
        let state: String = database
            .query_row(
                "SELECT state FROM input_commands WHERE soul_id=?1 AND request_id=?2",
                rusqlite::params![soul.as_str(), request.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            state, "refused",
            "the refused input must be journaled without becoming queued"
        );
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

#[tokio::test]
async fn queued_fresh_agent_recovery_continues_after_cancelled_input() {
    Box::pin(queued_fresh_agent_recovery_case("cancelled")).await;
}

#[tokio::test]
async fn queued_fresh_agent_recovery_continues_after_diagnosed_refusal() {
    Box::pin(queued_fresh_agent_recovery_case("diagnostic")).await;
}

#[tokio::test]
async fn queued_fresh_agent_recovery_stops_before_later_input_when_delivery_is_uncertain() {
    Box::pin(queued_fresh_agent_recovery_case("ambiguous")).await;
}

async fn queued_fresh_agent_recovery_case(mode: &str) {
    use crate::registry::InputJournalDisposition;
    use freshell_runtime_protocol::{FreshAgentSendDiagnosticOutcome, RequestId};

    let root = tempfile::tempdir().unwrap();
    let (supervisor, backend, _) = open(root.path(), 0);
    let soul = seed_native(&supervisor, root.path()).await;
    let before = supervisor
        .registry
        .recovery_context(soul.clone())
        .await
        .unwrap();
    let first = RequestId::parse("queued-first").unwrap();
    let second = RequestId::parse("queued-second").unwrap();
    for (request, text) in [
        (&first, b"first prompt".as_slice()),
        (&second, b"second prompt".as_slice()),
    ] {
        supervisor
            .registry
            .begin_fresh_input(soul.clone(), request.clone(), text, b"null", None)
            .await
            .unwrap();
    }
    std::fs::write(root.path().join("queued-recovery-mode"), mode).unwrap();

    // Exercise the production recovery caller from an exited prior incarnation
    // through the authenticated replacement host and queued-input journal.
    let result = supervisor
        .recover(RecoverRequest {
            soul_id: soul.clone(),
            trigger: RecoveryTrigger::ProviderExit,
            expected_intent_revision: Some(before.intent_revision),
            expected_control_epoch: Some(supervisor.registry.control_epoch()),
        })
        .await
        .unwrap();
    if result.outcome == RecoveryOutcome::Replaced {
        supervisor
            .replay_queued_inputs(soul.clone(), result.view.incarnation_id.clone())
            .await
            .unwrap();
    }
    let first_outcome = supervisor
        .registry
        .recorded_input_outcome(soul.clone(), first, b"first prompt", Some(b"null"))
        .await
        .unwrap();
    let second_outcome = supervisor
        .registry
        .recorded_input_outcome(soul.clone(), second, b"second prompt", Some(b"null"))
        .await
        .unwrap();
    let sends =
        std::fs::read_to_string(root.path().join("queued-recovery-sends")).unwrap_or_default();
    let current = supervisor.registry.recovery_context(soul).await.unwrap();
    close_retry_hosts(&backend).await;

    if mode == "ambiguous" {
        assert_eq!(result.outcome, RecoveryOutcome::Blocked, "{result:?}");
        assert!(matches!(
            result.probe,
            Some(RecoveryProbe::Blocked {
                reason: RecoveryBlockReason::CommandAmbiguous,
                ..
            })
        ));
        assert_eq!(current.recovery_state, RecoveryState::Blocked);
        assert_eq!(first_outcome, Some(InputJournalDisposition::Ambiguous));
        assert_eq!(second_outcome, None);
        assert_eq!(
            sends.lines().collect::<Vec<_>>(),
            ["queued-first:first prompt"]
        );
    } else {
        assert_eq!(
            result.outcome,
            RecoveryOutcome::Replaced,
            "{mode}: {result:?}"
        );
        assert_eq!(current.recovery_state, RecoveryState::Live);
        let Some(InputJournalDisposition::Refused(diagnostic)) = first_outcome else {
            panic!("the first prompt must retain its definite refusal: {first_outcome:?}");
        };
        assert_eq!(diagnostic.outcome, FreshAgentSendDiagnosticOutcome::Refused);
        assert_eq!(
            diagnostic.message.as_deref(),
            (mode == "diagnostic").then_some("already-published queued refusal")
        );
        assert_eq!(second_outcome, Some(InputJournalDisposition::Completed));
        assert_eq!(
            sends.lines().collect::<Vec<_>>(),
            ["queued-first:first prompt", "queued-second:second prompt",]
        );
    }
}

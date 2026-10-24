use super::*;
use crate::TurnOutcome;
use std::time::Duration;

fn lane(enabled: bool) -> ClaudeRestLane {
    ClaudeRestLane::new(
        FreshClaudeState::new(Arc::new(tokio::sync::broadcast::channel(32).0)),
        Arc::new(move || enabled),
    )
}

fn create() -> RestLaneCreate {
    RestLaneCreate {
        provider: "claude".into(),
        session_type: "freshclaude".into(),
        request_id: "create-rest".into(),
        ..Default::default()
    }
}

fn send(text: &str) -> RestLaneSend {
    RestLaneSend {
        provider: "claude".into(),
        session_type: "freshclaude".into(),
        session_id: "67cebd37-9576-4de0-93bb-8f286f5fc499".into(),
        request_id: "rest-request".into(),
        text: text.into(),
        timeout_ms: 100,
        observed_epoch: None,
        observed_generation: None,
    }
}

#[tokio::test]
async fn disabled_create_is_forbidden_before_a_runtime_is_started() {
    let error = Arc::new(lane(false))
        .create_agent(create())
        .await
        .unwrap_err();
    assert_eq!(error.kind, RestLaneErrorKind::Forbidden);
    assert_eq!(error.code, "FRESH_AGENT_DISABLED");
}

#[tokio::test]
async fn local_lane_refuses_other_providers_and_session_types() {
    let mut request = create();
    request.provider = "codex".into();
    assert_eq!(
        Arc::new(lane(true))
            .create_agent(request)
            .await
            .unwrap_err()
            .kind,
        RestLaneErrorKind::BadRequest
    );
    let mut request = send("hello");
    request.session_type = "freshcodex".into();
    assert_eq!(
        lane(true).send_agent(request).await.unwrap_err().kind,
        RestLaneErrorKind::BadRequest
    );
}

#[tokio::test]
async fn line_terminators_only_are_noop_without_a_live_runtime() {
    for text in ["\r", "\n", "\r\n", "\n\r\n"] {
        let result = lane(true).send_agent(send(text)).await.unwrap();
        assert!(result.noop);
        assert!(result.completed);
        assert_eq!(result.submitted_turn_id, None);
    }
}

#[tokio::test]
async fn send_for_a_missing_conversation_returns_a_permanent_not_found() {
    let root = tempfile::tempdir().unwrap();
    let state = FreshClaudeState::new(Arc::new(tokio::sync::broadcast::channel(32).0))
        .with_sidecar_environment([(
            "CLAUDE_CONFIG_DIR".into(),
            root.path().to_str().unwrap().into(),
        )]);
    let lane = ClaudeRestLane::new(state, Arc::new(|| true));
    let error = lane.send_agent(send("hello\r")).await.unwrap_err();
    assert_eq!(error.kind, RestLaneErrorKind::NotFound);
    assert_eq!(error.code, "INVALID_SESSION_ID");
    assert_eq!(error.retryable, Some(false));
    assert_eq!(error.retry_after_ms, None);
}

#[tokio::test]
#[cfg(unix)]
async fn capture_distinguishes_missing_history_from_unreadable_storage() {
    let root = tempfile::tempdir().unwrap();
    let state = FreshClaudeState::new(Arc::new(tokio::sync::broadcast::channel(32).0))
        .with_sidecar_environment([(
            "CLAUDE_CONFIG_DIR".into(),
            root.path().to_str().unwrap().into(),
        )]);
    let lane = ClaudeRestLane::new(state, Arc::new(|| true));
    let request = RestLaneCapture {
        provider: "claude".into(),
        session_type: "freshclaude".into(),
        session_id: "67cebd37-9576-4de0-93bb-8f286f5fc499".into(),
        max_bytes: 1024,
    };
    assert_eq!(
        lane.capture(request.clone()).await,
        Err(RestLaneCaptureError::NotFound)
    );
    // A symlink loop gives a real store traversal error even for root, unlike
    // mode 000. Capture must not report that unchecked conversation as absent.
    std::os::unix::fs::symlink("projects", root.path().join("projects")).unwrap();
    assert_eq!(
        lane.capture(request).await,
        Err(RestLaneCaptureError::Unavailable)
    );
}

fn settled(session: &str, request: &str, uuid: &str) -> ClaudeTurnEvent {
    ClaudeTurnEvent::Settled {
        session_key: session.into(),
        retired_request_ids: vec![request.into()],
        retired_command_ids: vec![uuid.into()],
        outcome: TurnOutcome::Completed,
        at: None,
    }
}

#[tokio::test]
async fn completion_requires_the_accepted_command_uuid_and_request_even_when_sends_share_a_request_id(
) {
    let (tx, mut rx) = tokio::sync::broadcast::channel(16);
    let future = wait_for_turn(
        &mut rx,
        "session",
        "runtime-new",
        "request",
        "uuid",
        Duration::from_secs(1),
    );
    tokio::pin!(future);
    assert!(futures_util::poll!(&mut future).is_pending());
    for unrelated in [
        settled("another-session", "request", "another-uuid"),
        settled("session", "request", "another-uuid"),
        settled("session", "another-request", "uuid"),
        ClaudeTurnEvent::Waiting {
            session_key: "session".into(),
            at: 1,
        },
        ClaudeTurnEvent::Ended {
            session_key: "session".into(),
            ownership_id: "runtime-old".into(),
            reason: "sidecar_exited".into(),
        },
    ] {
        tx.send(unrelated).unwrap();
        assert!(futures_util::poll!(&mut future).is_pending());
    }
    // A user-silenced result still settles its sender, despite carrying no bell.
    tx.send(settled("session", "request", "uuid")).unwrap();
    assert_eq!(future.await, Ok(Some("session".into())));
}

#[tokio::test]
async fn the_accepted_uuid_settles_after_the_runtime_moves_to_a_new_session_key() {
    let (tx, mut rx) = tokio::sync::broadcast::channel(16);
    tx.send(settled("new-session-key", "request", "uuid"))
        .unwrap();
    assert_eq!(
        wait_for_turn(
            &mut rx,
            "accepted-session-key",
            "runtime",
            "request",
            "uuid",
            Duration::ZERO
        )
        .await,
        Ok(Some("new-session-key".into()))
    );
}

#[tokio::test]
async fn only_the_accepted_runtime_ending_refuses_the_waiting_send() {
    let (tx, mut rx) = tokio::sync::broadcast::channel(16);
    tx.send(ClaudeTurnEvent::Ended {
        session_key: "session".into(),
        ownership_id: "runtime-new".into(),
        reason: "cli_exited".into(),
    })
    .unwrap();
    let error = wait_for_turn(
        &mut rx,
        "session",
        "runtime-new",
        "request",
        "uuid",
        Duration::from_secs(1),
    )
    .await
    .unwrap_err();
    assert_eq!(error.kind, RestLaneErrorKind::Conflict);
    assert_eq!(error.code, "FRESH_AGENT_SESSION_ENDED");
    assert_eq!(error.retryable, Some(true));
}

#[tokio::test]
async fn a_deadline_reports_an_incomplete_turn() {
    let (_tx, mut rx) = tokio::sync::broadcast::channel(16);
    assert_eq!(
        wait_for_turn(
            &mut rx,
            "session",
            "runtime",
            "request",
            "uuid",
            Duration::ZERO
        )
        .await,
        Ok(None)
    );
}

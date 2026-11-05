use super::*;
use freshell_runtime_protocol::{
    AgentEventBatch, AgentJournalEvent, CommandState, FreshAgentSendDiagnostic,
    FreshAgentSendDiagnosticOutcome, RuntimeError,
};
use std::sync::atomic::{AtomicUsize, Ordering};

async fn hosted_rest_send_case(
    scenario: &'static str,
) -> Result<RestLaneSendResult, RestLaneError> {
    let (provider, session_type) = if scenario.starts_with("claude-") {
        ("claude", "freshclaude")
    } else if scenario.starts_with("opencode-") {
        ("opencode", "freshopencode")
    } else {
        ("codex", "freshcodex")
    };
    let root = tempfile::tempdir().unwrap();
    let socket = root.path().join("rest-send-supervisor.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let sends = Arc::new(AtomicUsize::new(0));
    let observed = sends.clone();
    let server = tokio::spawn(async move {
        let mut reads = 0;
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let envelope: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
            let result = match envelope.body {
                AdminCommand::Health => Ok(AdminResult::Health {
                    control_epoch: 7,
                    installation_id: InstallationId::new(),
                }),
                AdminCommand::FreshAgentSend(request) => {
                    assert_eq!(request.text, "one rest prompt");
                    assert_eq!(envelope.request_id.as_str(), "rest-owned-request");
                    observed.fetch_add(1, Ordering::SeqCst);
                    match scenario {
                        "refused" => Err(RuntimeError::new(
                            RuntimeErrorCode::HostUnreachable,
                            "hosted fresh-agent command failed",
                        )
                        .with_fresh_agent_send_diagnostic(FreshAgentSendDiagnostic {
                            outcome: FreshAgentSendDiagnosticOutcome::Refused,
                            message: Some("CODEX_TURN_START_FAILED: model is at capacity".into()),
                        })),
                        "ambiguous" => Ok(AdminResult::FreshAgentCommand {
                            state: CommandState::Ambiguous,
                        }),
                        _ => Ok(AdminResult::FreshAgentCommand {
                            state: CommandState::ProviderAcked,
                        }),
                    }
                }
                AdminCommand::FreshAgentReadEvents(request) => {
                    reads += 1;
                    let mut events = Vec::new();
                    if reads > 1 {
                        let frames = match scenario {
                            "unrelated" => vec![
                                serde_json::json!({"type":"freshAgent.event","provider":"codex","sessionType":"freshcodex","sessionId":"native-rest","event":{"type":"freshAgent.status","status":"idle"}}),
                                serde_json::json!({"type":"freshAgent.event","provider":"codex","sessionType":"freshcodex","sessionId":"native-rest","event":{"type":"freshAgent.status","status":"busy"}}),
                                serde_json::json!({"type":"freshAgent.event","provider":"codex","sessionType":"freshcodex","sessionId":"native-rest","event":{"type":"freshAgent.turn.complete"}}),
                                serde_json::json!({"type":"freshAgent.event","provider":"codex","sessionType":"freshcodex","sessionId":"native-rest","event":{"type":"freshAgent.transcript.patch","projectionId":"owned","historyGeneration":0,"afterRevision":0,"ops":[{"op":"settleTurn","nativeTurnId":"other-turn","status":"completed","revision":1}]}}),
                            ],
                            "failed"
                            | "failed-after-ack"
                            | "failed-without-message"
                            | "late-correction"
                            | "completed"
                            | "interrupted"
                            | "foreign-ack" => {
                                let status = match scenario {
                                    "completed" => "completed",
                                    "interrupted" => "interrupted",
                                    _ => "failed",
                                };
                                let turns = if matches!(
                                    scenario,
                                    "failed"
                                        | "failed-after-ack"
                                        | "late-correction"
                                        | "foreign-ack"
                                ) {
                                    serde_json::json!([{"role":"assistant","error":{"name":"CodexError","message":"Selected model is at capacity. Please try a different model."},"items":[]}])
                                } else {
                                    serde_json::json!([])
                                };
                                let mut ops = vec![
                                    serde_json::json!({"op":"resetTurn","nativeTurnId":"target-turn","turns":turns,"correctSettled":status == "failed","revision":1}),
                                ];
                                if scenario != "late-correction" {
                                    ops.push(serde_json::json!({"op":"settleTurn","nativeTurnId":"target-turn","status":status,"revision":2}));
                                }
                                let patch = serde_json::json!({"type":"freshAgent.event","provider":"codex","sessionType":"freshcodex","sessionId":"native-rest","event":{"type":"freshAgent.transcript.patch","projectionId":"owned","historyGeneration":0,"afterRevision":0,"ops":ops}});
                                let accepted = serde_json::json!({"type":"freshAgent.send.accepted","provider":"codex","sessionType":"freshcodex","sessionId":"native-rest","requestId":if scenario == "foreign-ack" { "different-request" } else { "rest-owned-request" },"submittedTurnId":"target-turn"});
                                if scenario == "failed-after-ack" {
                                    vec![accepted, patch]
                                } else {
                                    vec![patch, accepted]
                                }
                            }
                            "claude-completed"
                            | "opencode-completed"
                            | "claude-failed"
                            | "opencode-failed"
                            | "claude-foreign"
                            | "opencode-foreign"
                            | "claude-failed-before-acceptance" => {
                                let failed = scenario.ends_with("-failed")
                                    || scenario == "claude-failed-before-acceptance";
                                let foreign = scenario.ends_with("-foreign");
                                let mut accepted = serde_json::json!({"type":"freshAgent.send.accepted", "provider":provider, "sessionType":session_type, "sessionId":"native-rest", "requestId":"rest-owned-request"});
                                if provider == "claude" {
                                    accepted["submittedTurnId"] = serde_json::json!("claude-turn");
                                }
                                let mut settled = serde_json::json!({"type":"freshAgent.event", "provider":provider, "sessionType":session_type, "sessionId":"native-rest", "event":{"type":"freshAgent.turn.settled", "requestIds":[if foreign { "different-request" } else { "rest-owned-request" }], "outcome":if failed { "failed" } else { "completed" }}});
                                if failed && provider == "claude" {
                                    settled["event"]["message"] =
                                        serde_json::json!("provider declined the selected model");
                                }
                                if scenario == "claude-failed-before-acceptance" {
                                    vec![settled, accepted]
                                } else {
                                    vec![
                                        accepted,
                                        serde_json::json!({"type":"freshAgent.event", "provider":provider, "sessionType":session_type, "sessionId":"native-rest", "event":{"type":"freshAgent.turn.complete", "outcome":"completed", "at":1}}),
                                        settled,
                                    ]
                                }
                            }
                            "opencode-deferred-refusal"
                            | "opencode-deferred-ambiguous"
                            | "opencode-foreign-error" => vec![
                                serde_json::json!({"type":"freshAgent.send.accepted", "provider":provider, "sessionType":session_type, "sessionId":"native-rest", "requestId":"rest-owned-request"}),
                                serde_json::json!({"type":"error", "code":"INTERNAL_ERROR", "requestId":if scenario == "opencode-foreign-error" { "different-request" } else { "rest-owned-request" },
                                    "message":if scenario == "opencode-deferred-ambiguous" { "FRESH_AGENT_DELIVERY_AMBIGUOUS: Delivery could not be confirmed." } else { "SESSION_RESERVED: The queued message could not be started." }}),
                            ],
                            "opencode-deferred-uncertain-event"
                            | "opencode-uncertain-then-exited"
                            | "opencode-uncertain-then-completed" => {
                                let mut events = vec![
                                    serde_json::json!({"type":"freshAgent.send.accepted", "provider":provider, "sessionType":session_type, "sessionId":"native-rest", "requestId":"rest-owned-request"}),
                                    serde_json::json!({"type":"freshAgent.event", "provider":provider, "sessionType":session_type, "sessionId":"native-rest", "event":{"type":"freshAgent.send.uncertain", "sessionId":"native-rest", "requestId":"rest-owned-request", "message":"FRESH_AGENT_DELIVERY_AMBIGUOUS: Delivery could not be confirmed."}}),
                                ];
                                if scenario != "opencode-deferred-uncertain-event" {
                                    events.push(serde_json::json!({"type":"freshAgent.event", "provider":provider, "sessionType":session_type, "sessionId":"native-rest", "event":{"type":"freshAgent.turn.settled", "requestIds":["rest-owned-request"], "outcome":if scenario == "opencode-uncertain-then-exited" { "exited" } else { "completed" }}}));
                                }
                                events
                            }
                            _ => vec![],
                        };
                        for (index, payload) in frames.into_iter().enumerate() {
                            let sequence = 11 + index as u64;
                            if sequence > request.after_sequence {
                                events.push(AgentJournalEvent {
                                    sequence,
                                    event: AgentEvent::Provider { payload },
                                });
                            }
                        }
                    }
                    Ok(AdminResult::FreshAgentEvents(AgentEventBatch {
                        retained_state: None,
                        retained_from: 1,
                        head: if reads == 1 { 10 } else { 14 },
                        reset_required: false,
                        events,
                    }))
                }
                other => panic!("unexpected hosted REST request: {other:?}"),
            };
            let _ = write_frame(
                &mut stream,
                &AdminReply {
                    request_id: envelope.request_id,
                    result,
                },
            )
            .await;
        }
    });
    let (proxy, _) = configure_proxy(
        &socket,
        HashMap::from([(
            (provider.into(), "public-rest".into()),
            SoulId::parse("rest-owned-soul").unwrap(),
        )]),
    );
    let result = proxy
        .send_agent(RestLaneSend {
            request_id: "rest-owned-request".into(),
            session_id: "public-rest".into(),
            provider: provider.into(),
            session_type: session_type.into(),
            text: "one rest prompt".into(),
            timeout_ms: 200,
            observed_epoch: None,
            observed_generation: None,
        })
        .await;
    server.abort();
    let _ = server.await;
    assert_eq!(
        sends.load(Ordering::SeqCst),
        1,
        "the REST gateway must never retry this send"
    );
    result
}

#[tokio::test]
async fn hosted_rest_send_matches_claude_and_opencode_settlements_to_the_request() {
    for provider in ["claude", "opencode"] {
        let completed = hosted_rest_send_case(if provider == "claude" {
            "claude-completed"
        } else {
            "opencode-completed"
        })
        .await
        .unwrap();
        assert!(
            completed.completed,
            "{provider}: matching successful settlement must complete"
        );
        assert_eq!(
            completed.submitted_turn_id.as_deref(),
            if provider == "claude" {
                Some("claude-turn")
            } else {
                None
            }
        );
        let failed = hosted_rest_send_case(if provider == "claude" {
            "claude-failed"
        } else {
            "opencode-failed"
        })
        .await
        .unwrap_err();
        assert_eq!(failed.kind, RestLaneErrorKind::Conflict, "{provider}");
        assert_eq!(failed.code, "FRESH_AGENT_TURN_FAILED", "{provider}");
        if provider == "claude" {
            assert_eq!(failed.message, "provider declined the selected model");
        }
        assert_eq!(
            failed.correlation.unwrap().request_id.as_deref(),
            Some("rest-owned-request")
        );
        let foreign = hosted_rest_send_case(if provider == "claude" {
            "claude-foreign"
        } else {
            "opencode-foreign"
        })
        .await
        .unwrap();
        assert!(
            !foreign.completed,
            "{provider}: another request's settlement must not complete this send"
        );
    }
    let failed = hosted_rest_send_case("claude-failed-before-acceptance")
        .await
        .unwrap_err();
    assert_eq!(failed.message, "provider declined the selected model");
    assert_eq!(
        failed.correlation.unwrap().submitted_turn_id.as_deref(),
        Some("claude-turn")
    );
}

#[tokio::test]
async fn hosted_rest_send_reports_only_its_own_deferred_opencode_refusal() {
    let refusal = hosted_rest_send_case("opencode-deferred-refusal")
        .await
        .unwrap_err();
    assert_eq!(refusal.kind, RestLaneErrorKind::Conflict);
    assert_eq!(refusal.code, "SESSION_RESERVED");
    assert_eq!(refusal.message, "The queued message could not be started.");
    assert_eq!(
        refusal.correlation.unwrap().request_id.as_deref(),
        Some("rest-owned-request")
    );
    let uncertain = hosted_rest_send_case("opencode-deferred-ambiguous")
        .await
        .unwrap_err();
    assert_eq!(uncertain.kind, RestLaneErrorKind::Conflict);
    assert_eq!(uncertain.code, "FRESH_AGENT_DELIVERY_AMBIGUOUS");
    assert_eq!(uncertain.retryable, Some(false));
    let uncertain_event = hosted_rest_send_case("opencode-deferred-uncertain-event")
        .await
        .unwrap_err();
    assert_eq!(uncertain_event.kind, RestLaneErrorKind::Conflict);
    assert_eq!(uncertain_event.code, "FRESH_AGENT_DELIVERY_AMBIGUOUS");
    assert_eq!(uncertain_event.retryable, Some(false));
    let exited = hosted_rest_send_case("opencode-uncertain-then-exited")
        .await
        .unwrap_err();
    assert_eq!(
        exited.code, "FRESH_AGENT_DELIVERY_AMBIGUOUS",
        "an exit does not resolve uncertain delivery"
    );
    let completed = hosted_rest_send_case("opencode-uncertain-then-completed")
        .await
        .unwrap();
    assert!(
        completed.completed,
        "an exact completed settlement proves delivery"
    );
    let foreign = hosted_rest_send_case("opencode-foreign-error")
        .await
        .unwrap();
    assert!(
        !foreign.completed,
        "another request's error must not settle this send"
    );
}

#[tokio::test]
async fn hosted_rest_send_replays_the_matching_failure_after_the_first_response_is_lost() {
    let root = tempfile::tempdir().unwrap();
    let socket = root.path().join("rest-replay-supervisor.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let native_dispatches = Arc::new(AtomicUsize::new(0));
    let observed_calls = calls.clone();
    let observed_dispatches = native_dispatches.clone();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        let mut started_tx = Some(started_tx);
        let mut release_rx = Some(release_rx);
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let envelope: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
            let result = match envelope.body {
                AdminCommand::Health => Ok(AdminResult::Health {
                    control_epoch: 7,
                    installation_id: InstallationId::new(),
                }),
                AdminCommand::FreshAgentSend(request) => {
                    assert_eq!(envelope.request_id.as_str(), "rest-replay-request");
                    assert_eq!(request.text, "one rest prompt");
                    if observed_calls.fetch_add(1, Ordering::SeqCst) == 0 {
                        observed_dispatches.fetch_add(1, Ordering::SeqCst);
                        let _ = started_tx.take().unwrap().send(());
                        let release = release_rx.take().unwrap();
                        let request_id = envelope.request_id;
                        tokio::spawn(async move {
                            let _ = release.await;
                            let _ = write_frame(
                                &mut stream,
                                &AdminReply {
                                    request_id,
                                    result: Ok(AdminResult::FreshAgentCommand {
                                        state: CommandState::ProviderAcked,
                                    }),
                                },
                            )
                            .await;
                        });
                        continue;
                    }
                    Ok(AdminResult::FreshAgentCommand {
                        state: CommandState::Completed,
                    })
                }
                AdminCommand::FreshAgentReadEvents(request) => {
                    let mut events = Vec::new();
                    if observed_calls.load(Ordering::SeqCst) > 0 {
                        let frames = [
                            serde_json::json!({"type":"freshAgent.send.accepted", "provider":"codex", "sessionType":"freshcodex", "sessionId":"native-rest", "requestId":"rest-replay-request", "submittedTurnId":"replayed-turn"}),
                            serde_json::json!({"type":"freshAgent.event", "provider":"codex", "sessionType":"freshcodex", "sessionId":"native-rest", "event":{"type":"freshAgent.transcript.patch", "projectionId":"owned", "historyGeneration":0, "afterRevision":0, "ops":[{"op":"resetTurn", "nativeTurnId":"replayed-turn", "turns":[{"role":"assistant", "error":{"name":"CodexError", "message":"Selected model is at capacity. Please try a different model."}, "items":[]}], "correctSettled":true, "revision":1},{"op":"settleTurn", "nativeTurnId":"replayed-turn", "status":"failed", "revision":2}]}}),
                        ];
                        for (index, payload) in frames.into_iter().enumerate() {
                            let sequence = 11 + index as u64;
                            if sequence > request.after_sequence
                                && events.len() < request.max_events as usize
                            {
                                events.push(AgentJournalEvent {
                                    sequence,
                                    event: AgentEvent::Provider { payload },
                                });
                            }
                        }
                    }
                    Ok(AdminResult::FreshAgentEvents(AgentEventBatch {
                        retained_state: None,
                        retained_from: 1,
                        head: if observed_calls.load(Ordering::SeqCst) > 0 {
                            12
                        } else {
                            10
                        },
                        reset_required: false,
                        events,
                    }))
                }
                other => panic!("unexpected hosted REST replay request: {other:?}"),
            };
            let _ = write_frame(
                &mut stream,
                &AdminReply {
                    request_id: envelope.request_id,
                    result,
                },
            )
            .await;
        }
    });
    let (proxy, _) = configure_proxy(
        &socket,
        HashMap::from([(
            ("codex".into(), "public-rest".into()),
            SoulId::parse("rest-owned-soul").unwrap(),
        )]),
    );
    let request = RestLaneSend {
        request_id: "rest-replay-request".into(),
        session_id: "public-rest".into(),
        provider: "codex".into(),
        session_type: "freshcodex".into(),
        text: "one rest prompt".into(),
        timeout_ms: 3000,
        observed_epoch: None,
        observed_generation: None,
    };
    let first = {
        let proxy = proxy.clone();
        let request = request.clone();
        tokio::spawn(async move { proxy.send_agent(request).await })
    };
    tokio::time::timeout(Duration::from_secs(3), started_rx)
        .await
        .unwrap()
        .unwrap();
    first.abort();
    let _ = first.await;
    let _ = release_tx.send(());
    let replay = proxy.send_agent(request).await;
    server.abort();
    let _ = server.await;
    let error = replay.expect_err("the stored failed turn must survive a lost first response");
    assert_eq!(error.code, "CODEX_TURN_FAILED");
    assert_eq!(
        error.message,
        "Selected model is at capacity. Please try a different model."
    );
    let correlation = error.correlation.unwrap();
    assert_eq!(
        correlation.request_id.as_deref(),
        Some("rest-replay-request")
    );
    assert_eq!(
        correlation.submitted_turn_id.as_deref(),
        Some("replayed-turn")
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        native_dispatches.load(Ordering::SeqCst),
        1,
        "the supervisor must not redispatch the input"
    );
}

#[tokio::test]
async fn hosted_rest_send_replays_a_claude_failure_through_the_real_supervisor_without_redispatch()
{
    use super::readiness_tests::readiness_fixture;
    use freshell_runtime_protocol::HostCommand;

    let fixture = readiness_fixture().await;
    fixture.ready.store(true, Ordering::SeqCst);
    let (proxy, _) = configure_proxy(
        &fixture.control_socket,
        HashMap::from([(
            ("claude".into(), "owned-public-parent".into()),
            fixture.soul.clone(),
        )]),
    );
    let request = RestLaneSend {
        request_id: "real-replay-request".into(),
        session_id: "owned-public-parent".into(),
        provider: "claude".into(),
        session_type: "freshclaude".into(),
        text: "one original browser input".into(),
        timeout_ms: 3000,
        observed_epoch: None,
        observed_generation: None,
    };
    let first = {
        let proxy = proxy.clone();
        let request = request.clone();
        tokio::spawn(async move { proxy.send_agent(request).await })
    };
    tokio::time::timeout(Duration::from_secs(5), async {
        while !fixture
            .commands
            .lock()
            .unwrap()
            .iter()
            .any(|command| matches!(command, HostCommand::FreshAgentSend { .. }))
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the initial request must reach the real supervisor's owned host");
    first.abort();
    let _ = first.await;
    fixture.events.lock().unwrap().extend([
        AgentJournalEvent { sequence:4, event:AgentEvent::Provider { payload:serde_json::json!({
            "type":"freshAgent.send.accepted", "provider":"claude", "sessionType":"freshclaude",
            "sessionId":"owned-public-parent", "requestId":"real-replay-request", "submittedTurnId":"claude-turn"
        }) } },
        AgentJournalEvent { sequence:5, event:AgentEvent::Provider { payload:serde_json::json!({
            "type":"freshAgent.event", "provider":"claude", "sessionType":"freshclaude", "sessionId":"owned-public-parent",
            "event":{"type":"freshAgent.turn.settled", "requestIds":["real-replay-request"], "outcome":"failed", "message":"provider declined the selected model"}
        }) } },
    ]);
    let error = proxy
        .send_agent(request)
        .await
        .expect_err("a replay must return the stored failed settlement");
    assert_eq!(error.code, "FRESH_AGENT_TURN_FAILED");
    assert_eq!(error.message, "provider declined the selected model");
    let correlation = error.correlation.unwrap();
    assert_eq!(
        correlation.request_id.as_deref(),
        Some("real-replay-request")
    );
    assert_eq!(
        correlation.submitted_turn_id.as_deref(),
        Some("claude-turn")
    );
    assert_eq!(
        fixture
            .commands
            .lock()
            .unwrap()
            .iter()
            .filter(|command| matches!(command, HostCommand::FreshAgentSend { .. }))
            .count(),
        1,
        "replaying must not dispatch the input twice"
    );
}

#[tokio::test]
async fn hosted_rest_send_reports_typed_refusal_and_uncertain_delivery_with_request_correlation() {
    let refused = hosted_rest_send_case("refused").await.unwrap_err();
    assert_eq!(refused.code, "CODEX_TURN_START_FAILED");
    assert_eq!(refused.message, "model is at capacity");
    assert_eq!(
        refused.correlation.as_ref().unwrap().request_id.as_deref(),
        Some("rest-owned-request")
    );
    assert_eq!(
        refused.correlation.as_ref().unwrap().session_id.as_deref(),
        Some("public-rest")
    );
    let ambiguous = hosted_rest_send_case("ambiguous").await.unwrap_err();
    assert_eq!(ambiguous.kind, RestLaneErrorKind::Conflict);
    assert_eq!(ambiguous.code, "CODEX_DELIVERY_AMBIGUOUS");
    assert_eq!(ambiguous.retryable, Some(false));
    assert_eq!(
        ambiguous.correlation.unwrap().request_id.as_deref(),
        Some("rest-owned-request")
    );
}

#[tokio::test]
async fn hosted_rest_send_requires_a_matching_turn_and_reports_its_failure() {
    let unrelated = hosted_rest_send_case("unrelated").await.unwrap();
    assert!(
        !unrelated.completed,
        "unrelated idle and turn completion cannot settle this send"
    );
    assert!(unrelated.submitted_turn_id.is_none());
    for scenario in ["failed", "failed-after-ack", "late-correction"] {
        let failed = hosted_rest_send_case(scenario).await.unwrap_err();
        assert_eq!(failed.kind, RestLaneErrorKind::Conflict, "{scenario}");
        assert_eq!(failed.code, "CODEX_TURN_FAILED", "{scenario}");
        assert_eq!(
            failed.message, "Selected model is at capacity. Please try a different model.",
            "{scenario}"
        );
        let correlation = failed.correlation.unwrap();
        assert_eq!(
            correlation.request_id.as_deref(),
            Some("rest-owned-request"),
            "{scenario}"
        );
        assert_eq!(
            correlation.submitted_turn_id.as_deref(),
            Some("target-turn"),
            "{scenario}"
        );
    }
    let failed_without_message = hosted_rest_send_case("failed-without-message")
        .await
        .unwrap_err();
    assert_eq!(failed_without_message.code, "CODEX_TURN_FAILED");
    assert!(!failed_without_message.message.trim().is_empty());
    let interrupted = hosted_rest_send_case("interrupted").await.unwrap_err();
    assert_eq!(interrupted.kind, RestLaneErrorKind::Conflict);
    assert_eq!(interrupted.code, "CODEX_TURN_INTERRUPTED");
    let foreign = hosted_rest_send_case("foreign-ack").await.unwrap();
    assert!(!foreign.completed);
    assert!(foreign.submitted_turn_id.is_none());
    let completed = hosted_rest_send_case("completed").await.unwrap();
    assert!(completed.completed);
    assert_eq!(completed.submitted_turn_id.as_deref(), Some("target-turn"));
}

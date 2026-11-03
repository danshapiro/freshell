use super::*;
use freshell_runtime_protocol::{CommandState, RuntimeError};

include!("fresh_agent_send_replay_tests.rs");

/// Exercise the real proxy and its runtime client over the control socket.
/// The supervisor fixture returns the additive, already-public provider
/// diagnostic before its independently delivered journal receipt can arrive.
async fn send_case(scenario: &'static str, request_id: Option<&str>) -> serde_json::Value {
    send_case_for_provider(scenario, request_id, "codex").await
}

async fn send_case_for_provider(
    scenario: &'static str,
    request_id: Option<&str>,
    provider: &'static str,
) -> serde_json::Value {
    let root = tempfile::tempdir().unwrap();
    let socket = root.path().join("supervisor.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let sends = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = sends.clone();
    let server = tokio::spawn(async move {
        for _ in 0..2 {
            let (mut stream, _) = listener.accept().await.unwrap();
            let envelope: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
            let mut reply = match envelope.body {
                AdminCommand::Health => serde_json::to_value(AdminReply {
                    request_id: envelope.request_id,
                    result: Ok(AdminResult::Health {
                        control_epoch: 7,
                        installation_id: InstallationId::new(),
                    }),
                })
                .unwrap(),
                AdminCommand::FreshAgentSend(send) => {
                    observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    assert_eq!(send.text, "one owned message");
                    assert_eq!(send.soul_id.as_str(), "send-owned-soul");
                    let result = match scenario {
                        "ambiguous-state" => Ok(AdminResult::FreshAgentCommand {
                            state: CommandState::Ambiguous,
                        }),
                        "recovery-refusal" => Err(RuntimeError::new(
                            RuntimeErrorCode::RecoveryBlocked,
                            "fresh-agent input requires the current committed native identity",
                        )),
                        "request-conflict" => Err(RuntimeError::new(
                            RuntimeErrorCode::RequestIdConflict,
                            "private prompt in registry error: do-not-publish",
                        )),
                        "invalid-request" => Err(RuntimeError::new(
                            RuntimeErrorCode::InvalidRequest,
                            "private settings in validation error: do-not-publish",
                        )),
                        "other-recovery-refusal" => Err(RuntimeError::new(
                            RuntimeErrorCode::RecoveryBlocked,
                            "private backend failure: do-not-publish",
                        )),
                        "ownership-uncertain" => Err(RuntimeError::new(
                            RuntimeErrorCode::OwnershipMismatch,
                            "native identity could not be recorded after acceptance",
                        )),
                        _ => Err(RuntimeError::new(
                            RuntimeErrorCode::HostUnreachable,
                            if scenario == "opaque" {
                                "private prompt and credential: do-not-publish"
                            } else {
                                "hosted fresh-agent command failed"
                            },
                        )),
                    };
                    serde_json::to_value(AdminReply {
                        request_id: envelope.request_id,
                        result,
                    })
                    .unwrap()
                }
                other => panic!("unexpected send control request: {other:?}"),
            };
            if let Some(error) = reply.pointer_mut("/result/Err") {
                let diagnostic = match scenario {
                    "provider-refused" => Some(serde_json::json!({
                        "outcome":"refused",
                        "message":"CODEX_TURN_START_FAILED: Selected model is at capacity. Please try a different model."
                    })),
                    "provider-ambiguous" => Some(serde_json::json!({
                        "outcome":"ambiguous",
                        "message":"CODEX_DELIVERY_AMBIGUOUS: native response was lost"
                    })),
                    "provider-ambiguous-unprefixed" => Some(serde_json::json!({
                        "outcome":"ambiguous",
                        "message":"native response was lost"
                    })),
                    "unpublished-refusal" => Some(serde_json::json!({
                        "outcome":"refused"
                    })),
                    "blocked-new-refusal" => Some(serde_json::json!({
                        "outcome":"refused",
                        "message":"The hosted session is blocked during recovery (STORE_UNREADABLE); this message was not sent."
                    })),
                    _ => None,
                };
                if let Some(diagnostic) = diagnostic {
                    error["freshAgentSendDiagnostic"] = diagnostic;
                }
            }
            write_frame(&mut stream, &reply).await.unwrap();
        }
    });
    let session_type = match provider {
        "claude" => "freshclaude",
        "opencode" => "freshopencode",
        _ => "freshcodex",
    };
    let (proxy, mut frames) = configure_proxy(
        &socket,
        HashMap::from([(
            (provider.into(), "public-thread".into()),
            SoulId::parse("send-owned-soul").unwrap(),
        )]),
    );
    let message = serde_json::from_value(serde_json::json!({
        "provider":provider, "sessionId":"public-thread", "sessionType":session_type,
        "requestId":request_id, "text":"one owned message"
    }))
    .unwrap();
    proxy.dispatch_send(message).await;
    server.await.unwrap();
    let frame: serde_json::Value = serde_json::from_str(
        &tokio::time::timeout(Duration::from_secs(1), frames.recv())
            .await
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert!(
        frames.try_recv().is_err(),
        "one send must publish only its own result"
    );
    assert_eq!(
        sends.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "a refused or uncertain send must never be retried"
    );
    frame
}

#[tokio::test]
async fn hosted_send_generic_uncertainty_uses_an_additive_session_event_for_old_clients() {
    for provider in ["claude", "opencode"] {
        for request_id in [Some("owned-request"), None] {
            let frame = send_case_for_provider("ambiguous-state", request_id, provider).await;
            assert_eq!(frame["type"], "freshAgent.event", "{provider}: {frame}");
            assert_eq!(frame["provider"], provider);
            assert_eq!(frame["sessionId"], "public-thread");
            assert_eq!(frame["event"]["type"], "freshAgent.send.uncertain");
            assert_eq!(frame["event"]["sessionId"], "public-thread");
            assert_eq!(
                frame["event"]
                    .get("requestId")
                    .and_then(serde_json::Value::as_str),
                request_id
            );
            assert!(frame["event"]["message"]
                .as_str()
                .unwrap()
                .starts_with("FRESH_AGENT_DELIVERY_AMBIGUOUS:"));
        }
    }
}

#[tokio::test]
async fn hosted_send_preserves_published_provider_diagnostic_before_journal_replay() {
    for (scenario, expected) in [
        (
            "provider-refused",
            "CODEX_TURN_START_FAILED: Selected model is at capacity. Please try a different model.",
        ),
        (
            "provider-ambiguous",
            "CODEX_DELIVERY_AMBIGUOUS: native response was lost",
        ),
        (
            "provider-ambiguous-unprefixed",
            "CODEX_DELIVERY_AMBIGUOUS: native response was lost",
        ),
    ] {
        let frame = send_case(scenario, Some("initiating-pane-request")).await;
        assert_eq!(frame["type"], "error", "{scenario}: {frame}");
        assert_eq!(frame["code"], "INTERNAL_ERROR");
        assert_eq!(frame["requestId"], "initiating-pane-request");
        assert_eq!(frame["message"], expected);
    }
}

#[tokio::test]
async fn hosted_codex_send_preserves_typed_recovery_refusal() {
    let frame = send_case("blocked-new-refusal", Some("blocked-codex-send")).await;
    assert_eq!(frame["type"], "error", "{frame}");
    assert_eq!(frame["requestId"], "blocked-codex-send");
    assert!(frame["message"]
        .as_str()
        .unwrap()
        .contains("STORE_UNREADABLE"));
    assert!(!frame["message"]
        .as_str()
        .unwrap()
        .starts_with("CODEX_DELIVERY_AMBIGUOUS:"));
}

#[tokio::test]
async fn hosted_blocked_send_distinguishes_new_from_queued_input() {
    use super::readiness_tests::readiness_fixture;
    use freshell_runtime_protocol::RecoveryBlockReason;
    use rusqlite::OptionalExtension;
    use std::sync::atomic::Ordering;

    for queued in [false, true] {
        let fixture = readiness_fixture().await;
        fixture.ready.store(true, Ordering::SeqCst);
        let request = RequestId::parse(if queued {
            "blocked-queued"
        } else {
            "blocked-new"
        })
        .unwrap();
        if queued {
            fixture
                .registry
                .begin_input(
                    fixture.soul.clone(),
                    request.clone(),
                    b"one original browser input",
                    Some(b"null"),
                )
                .await
                .unwrap();
        }
        let context = fixture
            .registry
            .recovery_context(fixture.soul.clone())
            .await
            .unwrap();
        fixture
            .registry
            .mark_recovery_blocked(
                fixture.soul.clone(),
                None,
                RecoveryBlockReason::StoreUnreadable,
                Vec::new(),
                context.write_fence(),
            )
            .await
            .unwrap();
        let (proxy, mut frames) = configure_proxy(
            &fixture.control_socket,
            HashMap::from([(
                ("claude".into(), "owned-public-parent".into()),
                fixture.soul.clone(),
            )]),
        );
        proxy.dispatch_send(serde_json::from_value(serde_json::json!({
            "provider":"claude", "sessionId":"owned-public-parent", "sessionType":"freshclaude",
            "requestId":request.as_str(), "text":"one original browser input"
        })).unwrap()).await;
        let frame: serde_json::Value = serde_json::from_str(
            &tokio::time::timeout(Duration::from_secs(3), frames.recv())
                .await
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        if queued {
            assert_eq!(
                frame["event"]["type"], "freshAgent.send.uncertain",
                "{frame}"
            );
            assert_eq!(frame["event"]["requestId"], request.as_str());
        } else {
            assert_eq!(frame["type"], "error", "{frame}");
            assert_eq!(frame["requestId"], request.as_str());
            assert!(
                frame["message"]
                    .as_str()
                    .unwrap()
                    .contains("STORE_UNREADABLE"),
                "{frame}"
            );
        }
        assert!(
            fixture.sent_roots.lock().unwrap().is_empty(),
            "a blocked send must not reach the host"
        );
        if !queued {
            let context = fixture
                .registry
                .recovery_context(fixture.soul.clone())
                .await
                .unwrap();
            fixture
                .registry
                .mark_recovery_live(
                    fixture.soul.clone(),
                    fixture.launch.incarnation_id.clone(),
                    context.write_fence(),
                )
                .await
                .unwrap();
            proxy.dispatch_send(serde_json::from_value(serde_json::json!({
                "provider":"claude", "sessionId":"owned-public-parent", "sessionType":"freshclaude",
                "requestId":request.as_str(), "text":"one original browser input"
            })).unwrap()).await;
            assert!(
                fixture.sent_roots.lock().unwrap().is_empty(),
                "a refused request must not be dispatched after recovery"
            );
            let replay: serde_json::Value = serde_json::from_str(
                &tokio::time::timeout(Duration::from_secs(3), frames.recv())
                    .await
                    .unwrap()
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(replay["type"], "error", "{replay}");
            assert_eq!(replay["requestId"], request.as_str());
            assert_eq!(replay["message"], frame["message"]);
            proxy.dispatch_send(serde_json::from_value(serde_json::json!({
                "provider":"claude", "sessionId":"owned-public-parent", "sessionType":"freshclaude",
                "requestId":request.as_str(), "text":"a different browser input"
            })).unwrap()).await;
            let conflict: serde_json::Value = serde_json::from_str(
                &tokio::time::timeout(Duration::from_secs(3), frames.recv())
                    .await
                    .unwrap()
                    .unwrap(),
            )
            .unwrap();
            assert!(
                conflict["message"]
                    .as_str()
                    .unwrap()
                    .contains("request ID was already used"),
                "{conflict}"
            );
            assert!(fixture.sent_roots.lock().unwrap().is_empty());
        }
        let database =
            rusqlite::Connection::open(fixture.root.path().join("registry/runtime.sqlite3"))
                .unwrap();
        let state: Option<String> = database
            .query_row(
                "SELECT state FROM input_commands WHERE soul_id=?1 AND request_id=?2",
                rusqlite::params![fixture.soul.as_str(), request.as_str()],
                |row| row.get(0),
            )
            .optional()
            .unwrap();
        assert_eq!(
            state.as_deref(),
            Some(if queued { "queued" } else { "refused" })
        );
    }
}

#[tokio::test]
async fn hosted_unknown_soul_after_host_dispatch_remains_uncertain() {
    use super::readiness_tests::readiness_fixture;
    use std::sync::atomic::Ordering;
    let fixture = readiness_fixture().await;
    fixture.ready.store(true, Ordering::SeqCst);
    *fixture.send_failure.lock().unwrap() = Some(RuntimeError::new(
        RuntimeErrorCode::UnknownSoul,
        "the reply followed a possibly accepted input",
    ));
    let (proxy, mut frames) = configure_proxy(
        &fixture.control_socket,
        HashMap::from([(
            ("claude".into(), "owned-public-parent".into()),
            fixture.soul.clone(),
        )]),
    );
    proxy
        .dispatch_send(
            serde_json::from_value(serde_json::json!({
                "provider":"claude", "sessionId":"owned-public-parent", "sessionType":"freshclaude",
                "requestId":"unknown-after-dispatch", "text":"one original browser input"
            }))
            .unwrap(),
        )
        .await;
    let frame: serde_json::Value = serde_json::from_str(
        &tokio::time::timeout(Duration::from_secs(3), frames.recv())
            .await
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        frame["event"]["type"], "freshAgent.send.uncertain",
        "{frame}"
    );
    assert_eq!(frame["event"]["requestId"], "unknown-after-dispatch");
    assert_eq!(
        fixture.sent_roots.lock().unwrap().len(),
        1,
        "the host saw the input"
    );
}

#[tokio::test]
async fn hosted_send_classifies_unsettled_and_redacts_untyped_host_errors() {
    for scenario in ["ambiguous-state", "opaque", "ownership-uncertain"] {
        let frame = send_case(scenario, Some("owned-request")).await;
        assert_eq!(frame["type"], "error", "{scenario}: {frame}");
        assert_eq!(frame["requestId"], "owned-request");
        let message = frame["message"].as_str().unwrap();
        assert!(
            message.starts_with("CODEX_DELIVERY_AMBIGUOUS:"),
            "{scenario}: {frame}"
        );
        assert!(!message.contains("do-not-publish"));
    }
}

#[tokio::test]
async fn hosted_send_classifies_body_free_pre_dispatch_refusals_without_exposing_runtime_text() {
    for scenario in [
        "request-conflict",
        "invalid-request",
        "other-recovery-refusal",
        "unpublished-refusal",
    ] {
        let frame = send_case(scenario, Some("owned-request")).await;
        assert_eq!(frame["type"], "error", "{scenario}: {frame}");
        assert_eq!(frame["requestId"], "owned-request");
        let message = frame["message"].as_str().unwrap();
        assert!(
            !message.starts_with("CODEX_DELIVERY_AMBIGUOUS:"),
            "{scenario}: {frame}"
        );
        assert!(!message.contains("do-not-publish"), "{scenario}: {frame}");
    }
}

#[tokio::test]
async fn hosted_send_reports_safe_pre_dispatch_recovery_reason_to_the_request() {
    let frame = send_case("recovery-refusal", Some("owned-request")).await;
    assert_eq!(frame["type"], "error", "{frame}");
    assert_eq!(frame["requestId"], "owned-request");
    assert_eq!(
        frame["message"],
        "fresh-agent input requires the current committed native identity"
    );
}

#[tokio::test]
async fn hosted_send_without_request_id_keeps_the_session_scoped_event() {
    let frame = send_case("provider-refused", None).await;
    assert_eq!(frame["type"], "freshAgent.event", "{frame}");
    assert_eq!(frame["sessionId"], "public-thread");
    assert_eq!(frame["event"]["type"], "freshAgent.error");
}

#[tokio::test]
async fn hosted_send_diagnostic_crosses_the_real_supervisor_from_its_authenticated_host() {
    use super::readiness_tests::readiness_fixture;
    use freshell_runtime_protocol::{FreshAgentSendDiagnostic, FreshAgentSendDiagnosticOutcome};
    use std::sync::atomic::Ordering;

    let fixture = readiness_fixture().await;
    fixture.ready.store(true, Ordering::SeqCst);
    *fixture.send_failure.lock().unwrap() = Some(
        RuntimeError::new(
            RuntimeErrorCode::HostUnreachable,
            "hosted fresh-agent command failed",
        )
        .with_fresh_agent_send_diagnostic(FreshAgentSendDiagnostic {
            outcome: FreshAgentSendDiagnosticOutcome::Refused,
            message: Some("Provider declined this exact message.".into()),
        }),
    );
    let (proxy, mut frames) = configure_proxy(
        &fixture.control_socket,
        HashMap::from([(
            ("claude".into(), "owned-public-parent".into()),
            fixture.soul.clone(),
        )]),
    );
    proxy
        .dispatch_send(
            serde_json::from_value(serde_json::json!({
                "provider":"claude", "sessionId":"owned-public-parent", "sessionType":"freshclaude",
                "requestId":"owned-supervisor-send", "text":"one original browser input"
            }))
            .unwrap(),
        )
        .await;
    let frame: serde_json::Value = serde_json::from_str(
        &tokio::time::timeout(Duration::from_secs(3), frames.recv())
            .await
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(frame["type"], "error", "{frame}");
    assert_eq!(frame["requestId"], "owned-supervisor-send");
    assert_eq!(frame["message"], "Provider declined this exact message.");
    assert_eq!(
        fixture
            .commands
            .lock()
            .unwrap()
            .iter()
            .filter(|command| matches!(
                command,
                freshell_runtime_protocol::HostCommand::FreshAgentSend { .. }
            ))
            .count(),
        1
    );
    assert!(
        frames.try_recv().is_err(),
        "a refusal must not create a session-wide companion error"
    );
}

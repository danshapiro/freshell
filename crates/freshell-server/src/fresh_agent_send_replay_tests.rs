#[tokio::test]
async fn hosted_send_replay_refusal_survives_a_lost_response_without_a_second_dispatch() {
    use super::readiness_tests::readiness_fixture;
    use freshell_runtime_protocol::{
        FreshAgentSendDiagnostic, FreshAgentSendDiagnosticOutcome, FreshAgentSendRequest,
    };
    use std::sync::atomic::Ordering;

    for diagnostic in [Some("the exact published provider refusal"), None] {
        let fixture = readiness_fixture().await;
        fixture.ready.store(true, Ordering::SeqCst);
        *fixture.send_failure.lock().unwrap() = Some(
            RuntimeError::new(
                RuntimeErrorCode::HostUnreachable,
                "hosted fresh-agent command failed",
            )
            .with_fresh_agent_send_diagnostic(FreshAgentSendDiagnostic {
                outcome: FreshAgentSendDiagnosticOutcome::Refused,
                message: diagnostic.map(str::to_owned),
            }),
        );

        // The first web connection vanishes after sending the request. The
        // real supervisor still owns its in-flight dispatch and journal write.
        let mut socket = tokio::net::UnixStream::connect(&fixture.control_socket)
            .await
            .unwrap();
        let mut envelope = Envelope::new(
            RequestId::parse("lost-refusal-response").unwrap(),
            ControlRole::Web,
            AdminCommand::FreshAgentSend(FreshAgentSendRequest {
                soul_id: fixture.soul.clone(),
                text: "one original browser input".into(),
                settings: None,
                checkpoint_logical_attempt_id: None,
                expected_control_epoch: Some(fixture.registry.control_epoch()),
            }),
        );
        envelope.auth = Some("0123456789abcdef".into());
        write_frame(&mut socket, &envelope).await.unwrap();
        drop(socket);
        tokio::time::timeout(Duration::from_secs(5), async {
            while !fixture.commands.lock().unwrap().iter().any(|command| {
                matches!(
                    command,
                    freshell_runtime_protocol::HostCommand::FreshAgentSend { .. }
                )
            }) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the first request must reach the owned host");

        let (proxy, mut frames) = configure_proxy(
            &fixture.control_socket,
            HashMap::from([(
                ("claude".into(), "owned-public-parent".into()),
                fixture.soul.clone(),
            )]),
        );
        proxy.dispatch_send(serde_json::from_value(serde_json::json!({
            "provider":"claude", "sessionId":"owned-public-parent", "sessionType":"freshclaude",
            "requestId":"lost-refusal-response", "text":"one original browser input"
        })).unwrap()).await;
        let frame: serde_json::Value = serde_json::from_str(
            &tokio::time::timeout(Duration::from_secs(3), frames.recv())
                .await
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(frame["type"], "error", "{frame}");
        assert_eq!(frame["requestId"], "lost-refusal-response");
        assert_eq!(
            frame["message"],
            diagnostic.unwrap_or("The provider did not accept this message.")
        );
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
            1,
            "replaying a refused request must never dispatch the input again"
        );
        assert!(frames.try_recv().is_err());
        proxy.dispatch_send(serde_json::from_value(serde_json::json!({
            "provider":"claude", "sessionId":"owned-public-parent", "sessionType":"freshclaude",
            "requestId":"lost-refusal-response", "text":"different input must not reuse the request"
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
    }
}

#[tokio::test]
async fn hosted_send_replay_legacy_reserved_send_keeps_the_session_scoped_reservation_event() {
    use super::readiness_tests::readiness_fixture;
    use freshell_runtime_protocol::{FreshAgentSendDiagnostic, FreshAgentSendDiagnosticOutcome};
    use std::sync::atomic::Ordering;
    let fixture = readiness_fixture().await;
    fixture.ready.store(true, Ordering::SeqCst);
    *fixture.send_failure.lock().unwrap() = Some(
        RuntimeError::new(RuntimeErrorCode::HostUnreachable, "hosted fresh-agent command failed")
            .with_fresh_agent_send_diagnostic(FreshAgentSendDiagnostic {
                outcome: FreshAgentSendDiagnosticOutcome::Refused,
                message: Some("SESSION_RESERVED: The previous session is finishing its remaining messages. Please try again.".into()),
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
                "text":"one original browser input"
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
    assert_eq!(frame["type"], "freshAgent.event", "{frame}");
    assert_eq!(frame["event"]["type"], "freshAgent.error");
    assert_eq!(frame["event"]["code"], "SESSION_RESERVED");
    assert_eq!(
        frame["event"]["message"],
        "The previous session is finishing its remaining messages. Please try again."
    );
    let commands = fixture.commands.lock().unwrap();
    let ids: Vec<_> = commands
        .iter()
        .filter_map(|command| match command {
            freshell_runtime_protocol::HostCommand::FreshAgentSend { request_id, .. } => {
                Some(request_id.as_str())
            }
            _ => None,
        })
        .collect();
    assert_eq!(ids.len(), 1);
    assert!(
        !ids[0].is_empty(),
        "the host receives an internal request ID even for a legacy send"
    );
}

#[tokio::test]
async fn hosted_send_replay_claude_uncertain_write_stays_ambiguous_without_redispatch() {
    use super::readiness_tests::readiness_fixture;
    use freshell_runtime_protocol::{
        FreshAgentSendDiagnostic, FreshAgentSendDiagnosticOutcome, FreshAgentSendRequest,
    };
    use std::sync::atomic::Ordering;

    let fixture = readiness_fixture().await;
    fixture.ready.store(true, Ordering::SeqCst);
    *fixture.send_failure.lock().unwrap() = Some(
        RuntimeError::new(
            RuntimeErrorCode::CommandAmbiguous,
            "hosted fresh-agent command failed",
        )
        .with_fresh_agent_send_diagnostic(FreshAgentSendDiagnostic {
            outcome: FreshAgentSendDiagnosticOutcome::Ambiguous,
            message: Some(
                "FRESH_AGENT_DELIVERY_AMBIGUOUS: The sidecar could not confirm input delivery."
                    .into(),
            ),
        }),
    );
    let request_id = RequestId::parse("lost-uncertain-claude-response").unwrap();
    let mut socket = tokio::net::UnixStream::connect(&fixture.control_socket)
        .await
        .unwrap();
    let mut envelope = Envelope::new(
        request_id.clone(),
        ControlRole::Web,
        AdminCommand::FreshAgentSend(FreshAgentSendRequest {
            soul_id: fixture.soul.clone(),
            text: "one original browser input".into(),
            settings: None,
            checkpoint_logical_attempt_id: None,
            expected_control_epoch: Some(fixture.registry.control_epoch()),
        }),
    );
    envelope.auth = Some("0123456789abcdef".into());
    write_frame(&mut socket, &envelope).await.unwrap();
    drop(socket);
    tokio::time::timeout(Duration::from_secs(5), async {
        while !fixture.commands.lock().unwrap().iter().any(|command| {
            matches!(
                command,
                freshell_runtime_protocol::HostCommand::FreshAgentSend { .. }
            )
        }) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the first request must reach the owned host");
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
                "requestId":"lost-uncertain-claude-response", "text":"one original browser input"
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
    assert_eq!(frame["type"], "freshAgent.event");
    assert_eq!(frame["event"]["type"], "freshAgent.send.uncertain");
    assert_eq!(
        frame["event"]["requestId"],
        "lost-uncertain-claude-response"
    );
    assert!(
        frame["event"]["message"]
            .as_str()
            .unwrap()
            .starts_with("FRESH_AGENT_DELIVERY_AMBIGUOUS:"),
        "{frame}"
    );
    let database =
        rusqlite::Connection::open(fixture.root.path().join("registry/runtime.sqlite3")).unwrap();
    let recorded: String = database
        .query_row(
            "SELECT state FROM input_commands WHERE soul_id=?1 AND request_id=?2",
            rusqlite::params![fixture.soul.as_str(), request_id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(recorded, "ambiguous");
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
        1,
        "a lost uncertain result must not redispatch the input"
    );
}

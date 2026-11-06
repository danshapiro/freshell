#[tokio::test]
async fn hosted_send_delivery_refuses_only_the_new_send_when_an_earlier_delivery_is_unresolved() {
    let logs = tempfile::tempdir().unwrap();
    let request_log = logs.path().join("requests.jsonl");
    let mut fixture = native_codex_fixture(json!({
        "appendRequestLogPath":request_log,
        "overrides":{"turn/start":{"error":{
            "code":-32603,"message":"the first native response was lost"
        }}}
    }))
    .await;
    let actor = FreshAgentHostActor::open(
        fixture.dir.path().join("earlier-unknown-actor"),
        fixture.profile.clone(),
        fixture.transport.clone(),
    )
    .await
    .unwrap();
    let host = crate::tests::test_host_state();
    let host_dir = host.state_dir.clone();
    let launch = freshell_runtime_protocol::NativeIdentityLaunch {
        incarnation_id: host.incarnation_id.clone(),
        launch_nonce: "owned-earlier-unknown-host".into(),
        evidence_revision: 1,
        execution_generation: 1,
        requested_native_session_id: actor.profile().await.native_session_id,
    };
    {
        let mut persisted = host.persisted.lock().await;
        persisted.native_identity_launch = Some(launch.clone());
        persisted.max_execution_generation = 1;
    }
    *host.fresh_agent.lock().await = Some(actor.clone());
    tokio::time::timeout(Duration::from_secs(5), async {
        while crate::fresh_native_observation(&launch, &actor)
            .await
            .is_none()
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the host must observe its owned native provider");

    async fn send(host: Arc<crate::HostState>, id: &str, text: &str) -> Value {
        let (mut socket, host_socket) = tokio::net::UnixStream::pair().unwrap();
        let host_task = tokio::spawn(crate::handle_connection(host_socket, host.clone()));
        freshell_runtime_protocol::write_frame(
            &mut socket,
            &crate::tests::authenticated_host_envelope(
                &host,
                freshell_runtime_protocol::HostCommand::FreshAgentSend {
                    incarnation_id: host.incarnation_id.clone(),
                    request_id: RequestId::parse(id).unwrap(),
                    text: text.into(),
                    settings: None,
                    checkpoint_logical_attempt_id: None,
                    codex_dispatch_recovery_source: None,
                },
            ),
        )
        .await
        .unwrap();
        let response: freshell_runtime_protocol::HostReply =
            freshell_runtime_protocol::read_frame(&mut socket)
                .await
                .unwrap();
        drop(socket);
        host_task.await.unwrap().unwrap();
        serde_json::to_value(
            response
                .result
                .expect_err("both sends must answer with their delivery outcome"),
        )
        .unwrap()
    }

    let first = send(host.clone(), "earlier-unknown", "first prompt").await;
    let second = send(host.clone(), "later-refused", "second prompt").await;
    let receipts = tokio::time::timeout(Duration::from_secs(5), async {
        let mut receipts = std::collections::HashMap::new();
        while receipts.len() < 2 {
            let frame: Value =
                serde_json::from_str(&fixture.diagnostic.recv().await.unwrap()).unwrap();
            if frame["type"] == "error" {
                if let Some(id @ ("earlier-unknown" | "later-refused")) =
                    frame["requestId"].as_str()
                {
                    receipts.insert(id.to_owned(), frame["message"].clone());
                }
            }
        }
        receipts
    })
    .await
    .expect("both exact request-scoped provider receipts must be published");
    let outcomes = actor.read_events(0, 256).await.events;
    actor.stop().await.unwrap();
    std::fs::remove_dir_all(host_dir).unwrap();

    assert_eq!(first["freshAgentSendDiagnostic"]["outcome"], "ambiguous");
    assert!(first["freshAgentSendDiagnostic"]["message"]
        .as_str()
        .unwrap()
        .starts_with("CODEX_DELIVERY_AMBIGUOUS:"));
    assert_eq!(
        receipts["earlier-unknown"],
        first["freshAgentSendDiagnostic"]["message"]
    );
    assert_eq!(second["freshAgentSendDiagnostic"]["outcome"], "refused");
    assert_eq!(second["freshAgentSendDiagnostic"]["message"],
        "CODEX_PREVIOUS_DELIVERY_AMBIGUOUS: Earlier input has unresolved native delivery; recover or inspect the conversation before sending again");
    assert_eq!(
        receipts["later-refused"],
        second["freshAgentSendDiagnostic"]["message"]
    );
    assert!(outcomes
        .iter()
        .any(|entry| matches!(&entry.event, AgentEvent::CommandOutcome {
        request_id, state:freshell_runtime_protocol::CommandState::Ambiguous,
    } if request_id.as_str()=="earlier-unknown")));
    assert!(outcomes
        .iter()
        .any(|entry| matches!(&entry.event, AgentEvent::CommandOutcome {
        request_id, state:freshell_runtime_protocol::CommandState::Cancelled,
    } if request_id.as_str()=="later-refused")));
    let starts = std::fs::read_to_string(request_log)
        .unwrap()
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|row| row["method"] == "turn/start")
        .count();
    assert_eq!(starts, 1, "only the first request may reach Codex");
}

#[tokio::test]
async fn hosted_send_delivery_reserved_send_is_scoped_to_its_request_and_keeps_legacy_notice() {
    let logs = tempfile::tempdir().unwrap();
    let requests = logs.path().join("reserved-requests.jsonl");
    let original = uuid::Uuid::new_v4().to_string();
    let mut fixture = native_codex_fixture(json!({"threadStartThreadId":original,
        "recordTurns":true,"appendRequestLogPath":requests,
        "exitProcessAfterMethodsOnce":["thread/start"]}))
    .await;
    let mut cleanup = NativeCodexCleanupReadiness::withheld(&fixture, true);
    let actor = FreshAgentHostActor::open(
        fixture.dir.path().join("reserved-send-actor"),
        fixture.profile.clone(),
        fixture.transport.clone(),
    )
    .await
    .unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let boots = native_boots(&fixture);
    let boot = &boots[0];
    cleanup
        .observe_original(&original, boot, false, deadline)
        .await;
    wait_for_native_exit(&fixture, boot, deadline)
        .await
        .unwrap();
    let ProviderState::Codex(state) = &fixture.transport.state else {
        unreachable!()
    };
    cleanup
        .assert_original_remains_unconfirmed(state, &original, deadline)
        .await;
    while fixture.diagnostic.try_recv().is_ok() {}

    let refusal = actor
        .dispatch(
            RequestId::parse("reserved-pane-request").unwrap(),
            "request-scoped input".into(),
            None,
        )
        .await;
    let mut scoped = Vec::new();
    while let Ok(frame) = fixture.diagnostic.try_recv() {
        scoped.push(serde_json::from_str::<Value>(&frame).unwrap());
    }
    let legacy_send: FreshAgentSend = serde_json::from_value(json!({
        "provider":"codex", "sessionId":original, "sessionType":"freshcodex", "text":"legacy input"
    }))
    .unwrap();
    state.handle_send(legacy_send).await;
    let mut legacy = Vec::new();
    while let Ok(frame) = fixture.diagnostic.try_recv() {
        legacy.push(serde_json::from_str::<Value>(&frame).unwrap());
    }
    let boots_after = native_boots(&fixture);
    actor.stop().await.unwrap();
    assert!(matches!(refusal,
        Err(freshell_agent_runtime::host_actor::ActorError::ProviderSendDiagnostic(ref diagnostic))
        if diagnostic.message.as_deref().is_some_and(|message| message.starts_with("SESSION_RESERVED:"))));
    assert!(scoped.iter().any(|frame| frame["type"] == "error"
        && frame["requestId"] == "reserved-pane-request"
        && frame["message"]
            .as_str()
            .is_some_and(|message| message.starts_with("SESSION_RESERVED:"))));
    assert!(
        !scoped
            .iter()
            .any(|frame| frame["event"]["type"] == "freshAgent.error"
                && frame["event"]["code"] == "SESSION_RESERVED"),
        "a request-scoped refusal must not reach other panes: {scoped:?}"
    );
    assert!(
        legacy
            .iter()
            .any(|frame| frame["event"]["type"] == "freshAgent.error"
                && frame["event"]["code"] == "SESSION_RESERVED"),
        "legacy sends still need their session-scoped error"
    );
    assert_eq!(
        boots_after.len(),
        1,
        "neither refusal may launch another provider"
    );
    let rows = std::fs::read_to_string(requests).unwrap();
    assert!(!rows.contains("request-scoped input") && !rows.contains("legacy input"));
}

#[tokio::test]
async fn hosted_send_delivery_legacy_provider_refusal_preserves_its_published_message() {
    for provider in [FreshProvider::Claude, FreshProvider::Opencode] {
        let transport = HostedTransport::new(provider.clone()).await;
        *transport.session_id.lock().await = Some("missing-owned-session".into());
        let mut frames = transport.provider_frames.subscribe();
        let request = RequestId::parse(format!("missing-{}-send", provider.as_str())).unwrap();
        let failure = transport
            .dispatch(&request, "unsent prompt", &parity_profile(provider.clone()))
            .await
            .expect_err("the actual provider handler must refuse the missing session");
        let receipt = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let frame: Value = serde_json::from_str(&frames.recv().await.unwrap()).unwrap();
                if frame["type"] == "error" && frame["requestId"] == request.as_str() {
                    break frame;
                }
            }
        })
        .await
        .expect("the provider publishes the refusal for this exact request");
        transport.stop().await.unwrap();
        let diagnostic = failure
            .provider_diagnostic
            .expect("the already-public provider receipt must reach the actor");
        assert_eq!(
            diagnostic.outcome,
            freshell_runtime_protocol::FreshAgentSendDiagnosticOutcome::Refused
        );
        assert_eq!(diagnostic.message.as_deref(), receipt["message"].as_str());
        assert!(!failure.acceptance_ambiguous, "{provider:?}");
    }
}

#[test]
fn hosted_send_delivery_uncertainty_is_not_a_definite_refusal() {
    let frame = json!({ "type": "freshAgent.event", "provider": "claude", "sessionType": "freshclaude", "sessionId": "owned-session", "event": {
        "type": "freshAgent.send.uncertain", "sessionId": "owned-session", "requestId": "ambiguous-send",
        "message": "FRESH_AGENT_DELIVERY_AMBIGUOUS: Claude could not confirm delivery." }
    });
    let receipt = parse_send_outcome(&frame).expect("a correlated provider receipt is observed");
    assert_eq!(receipt.0, "ambiguous-send");
    assert!(
        matches!(receipt.1, HostedSendReceipt::Ambiguous { .. }),
        "the prompt may already have been delivered"
    );
    assert!(receipt.1.matches_source(
        AgentProvider::Claude,
        SessionType::Freshclaude,
        "owned-session"
    ));
    assert!(!receipt.1.matches_source(
        AgentProvider::Claude,
        SessionType::Freshclaude,
        "other-session"
    ));
    assert!(!receipt.1.matches_source(
        AgentProvider::Opencode,
        SessionType::Freshclaude,
        "owned-session"
    ));
    assert!(!receipt
        .1
        .matches_source(AgentProvider::Claude, SessionType::Kilroy, "owned-session"));
    let mut foreign_inner = frame.clone();
    foreign_inner["event"]["sessionId"] = json!("other-session");
    assert!(parse_send_outcome(&foreign_inner).is_none());
}

struct DeliveredClaudeLineWithFailedFlush(Arc<std::sync::Mutex<Vec<u8>>>);

impl tokio::io::AsyncWrite for DeliveredClaudeLineWithFailedFlush {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
        bytes: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        std::task::Poll::Ready(Ok(bytes.len()))
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::task::Poll::Ready(Err(std::io::Error::other("PRIVATE_FLUSH_DETAIL")))
    }

    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::task::Poll::Ready(Ok(()))
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hosted_claude_delivered_line_with_failed_flush_stays_ambiguous_in_the_actor_journal() {
    let _lock = NATIVE_PROVIDER_FIXTURE_LOCK.lock().await;
    let claude = SimulatedClaude::start(&[]).await;
    let actor = FreshAgentHostActor::open(
        claude.root.path().join("ambiguous-send-actor"),
        claude.profile(None),
        claude.transport.clone(),
    )
    .await
    .unwrap();
    let session_id = claude
        .transport
        .provider_session_id()
        .await
        .expect("started session");
    let ProviderState::Claude(state) = &claude.transport.state else {
        unreachable!()
    };
    let bytes = Arc::new(std::sync::Mutex::new(Vec::new()));
    let original_writer = state
        .replace_sidecar_writer_for_tests(
            &session_id,
            DeliveredClaudeLineWithFailedFlush(bytes.clone()),
        )
        .await
        .expect("live sidecar writer");
    let request_id = RequestId::parse("ambiguous-claude-send").unwrap();
    let outcome = actor
        .dispatch(request_id.clone(), "delivered once".into(), None)
        .await;
    let delivered = bytes.lock().unwrap().clone();
    let retry = actor
        .dispatch(request_id.clone(), "delivered once".into(), None)
        .await;
    let retried = bytes.lock().unwrap().clone();
    let events = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let events = actor.read_events(0, 256).await.events;
            if events.iter().any(|entry| {
                matches!(&entry.event, AgentEvent::Provider { payload }
                if payload["event"]["type"] == "freshAgent.send.uncertain"
                    && payload["event"]["requestId"] == request_id.as_str())
            }) {
                break events;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the uncertainty event must reach the actor journal");
    let stopped = actor.stop().await;
    drop(original_writer);

    assert_eq!(
        delivered.last(),
        Some(&b'\n'),
        "the complete send line was written before flush failed"
    );
    let send: Value = serde_json::from_slice(&delivered).unwrap();
    assert_eq!(send["type"], "send");
    assert_eq!(send["text"], "delivered once");
    assert!(
        matches!(outcome,
        Err(freshell_agent_runtime::host_actor::ActorError::ProviderSendDiagnostic(ref diagnostic))
        if diagnostic.outcome == freshell_runtime_protocol::FreshAgentSendDiagnosticOutcome::Ambiguous
            && diagnostic.message.as_deref().is_some_and(|message| message.starts_with("FRESH_AGENT_DELIVERY_AMBIGUOUS:") && !message.contains("PRIVATE_FLUSH_DETAIL"))),
        "the actual hosted provider must report uncertainty: {outcome:?}"
    );
    assert!(matches!(
        retry,
        Err(freshell_agent_runtime::host_actor::ActorError::AmbiguousDispatch)
    ));
    assert_eq!(
        retried, delivered,
        "retrying the same request must not write it again"
    );
    assert!(
        events
            .iter()
            .any(|entry| matches!(&entry.event, AgentEvent::CommandOutcome {
        request_id: observed, state: freshell_runtime_protocol::CommandState::Ambiguous,
    } if observed == &request_id)),
        "the actor must retain uncertain delivery"
    );
    assert!(!format!("{events:?}").contains("PRIVATE_FLUSH_DETAIL"));
    stopped.unwrap();
}

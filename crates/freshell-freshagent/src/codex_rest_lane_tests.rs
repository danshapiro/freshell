use super::*;
use crate::codex_rest_lane::CodexRestLane;
use crate::rest_lane::*;
use axum::http::StatusCode;
use freshell_protocol::{AgentProvider, SessionType};

fn http_pane(state: FreshCodexState, id: &str) -> (axum::Router, String) {
    let api = crate::FreshAgentState::new(
        Arc::new("tok".into()),
        Arc::new(tokio::sync::broadcast::channel(64).0),
    )
    .with_terminal_registry(freshell_terminal::TerminalRegistry::new());
    let (tab, pane) = api.layout.create_tab(None);
    api.layout.attach_pane_content(&tab, &pane, json!({"kind":"fresh-agent","provider":"codex","sessionType":"freshcodex","sessionRef":{"provider":"codex","sessionId":id}}));
    api.set_codex_rest_lane(Arc::new(CodexRestLane::new(state, Arc::new(|| true))))
        .unwrap();
    (crate::router(api), pane)
}

async fn post_http(router: axum::Router, uri: &str, body: Value) -> (StatusCode, Value) {
    use tower::util::ServiceExt;
    let response = router
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri(uri)
                .header("x-auth-token", "tok")
                .header("content-type", "application/json")
                .body(axum::body::Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

async fn accepted(frames: &mut tokio::sync::broadcast::Receiver<String>, request: &str) {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let value: Value = serde_json::from_str(&frames.recv().await.unwrap()).unwrap();
            if value["type"] == "freshAgent.send.accepted" && value["requestId"] == request {
                break;
            }
        }
    })
    .await
    .unwrap();
}

async fn capture_from_peer(
    lane: &CodexRestLane,
    request: RestLaneCapture,
    peer: &freshell_codex::ChannelPeer,
    raw: &Value,
) -> Result<RestLaneCaptureResult, RestLaneCaptureError> {
    let mut capturing = Box::pin(lane.capture(request));
    tokio::select! {
        result = &mut capturing => result,
        (id, method, _) = peer.expect_request() => {
            assert_eq!(method, "thread/read");
            peer.respond(&id, raw.clone());
            capturing.await
        }
    }
}

async fn channel_session(id: &str) -> (FreshCodexState, freshell_codex::ChannelPeer) {
    let (state, _) = super::tests::state_with_bus();
    let (transport, peer) = freshell_codex::new_channel_transport();
    let (client, notifs) =
        CodexAppServerClient::connect_with_timeout(transport, Duration::from_millis(200));
    super::tests::insert_fake_session_with_real_consumer(
        &state,
        id,
        Arc::new(client),
        Arc::new(StdMutex::new(None)),
        notifs,
        super::tests::spawn_sleeper(),
        &format!("task009-owner-{id}"),
    )
    .await;
    (state, peer)
}

fn send(id: &str, request: &str) -> FreshAgentSend {
    FreshAgentSend {
        provider: AgentProvider::Codex,
        session_type: SessionType::Freshcodex,
        session_id: id.into(),
        request_id: Some(request.into()),
        text: "original recoverable prompt".into(),
        cwd: None,
        images: None,
        settings: None,
        checkpoint_intent: None,
        observed_epoch: None,
        observed_generation: None,
    }
}

async fn initialize(peer: &freshell_codex::ChannelPeer) {
    let (id, method, _) = peer.expect_request().await;
    assert_eq!(method, "initialize");
    peer.respond(&id, json!({"userAgent":"fixture","codexHome":"/fixture","platformFamily":"unix","platformOs":"linux"}));
    assert_eq!(peer.expect_notification().await.0, "initialized");
}

async fn typed_send_receipt(response: &str) {
    let session = format!("task009-send-{response}");
    let (state, peer) = channel_session(&session).await;
    let submitting = {
        let state = state.clone();
        let session = session.clone();
        tokio::spawn(async move { state.handle_send(send(&session, "request-9")).await })
    };
    initialize(&peer).await;
    let (id, method, params) = peer.expect_request().await;
    assert_eq!(method, "turn/start");
    assert_eq!(params["input"][0]["text"], "original recoverable prompt");
    match response {
        "accepted" => peer.respond(&id, json!({"turn":{"id":"native-9"}})),
        "refused" => peer.respond_error(&id, -32602, "not admitted"),
        "internal" => peer.respond_error(&id, -32603, "possibly admitted"),
        _ => {}
    }
    let result = submitting.await.unwrap();
    let facts = state
        .sessions
        .lock()
        .await
        .get(&session)
        .unwrap()
        .turn_state
        .lock()
        .unwrap()
        .facts()
        .clone();
    drop(peer);
    state.shutdown().await;
    match (response, result) {
        (
            "accepted",
            CodexSendOutcome::Accepted {
                session_id,
                submitted_turn_id,
                incarnation_id,
                ..
            },
        ) => {
            assert_eq!(
                (
                    session_id.as_str(),
                    submitted_turn_id.as_str(),
                    incarnation_id.as_str()
                ),
                (
                    session.as_str(),
                    "native-9",
                    format!("task009-owner-{session}").as_str()
                )
            );
            assert_eq!(facts[0].settlement, None, "acceptance is not settlement");
        }
        ("refused", CodexSendOutcome::Refused { code, .. }) => {
            assert_eq!(code, "CODEX_TURN_START_FAILED");
            assert_eq!(facts[0].delivery, turn_state::Delivery::Refused);
        }
        (
            "internal" | "timeout",
            CodexSendOutcome::Ambiguous {
                session_id,
                request_id,
                incarnation_id,
                code,
                ..
            },
        ) => {
            assert_eq!(
                (
                    session_id.as_str(),
                    request_id.as_str(),
                    incarnation_id.as_str(),
                    code.as_str()
                ),
                (
                    session.as_str(),
                    "request-9",
                    format!("task009-owner-{session}").as_str(),
                    "CODEX_DELIVERY_AMBIGUOUS"
                )
            );
            assert_eq!(facts[0].settlement, None);
            assert_eq!(facts[0].delivery, turn_state::Delivery::Ambiguous);
        }
        (_, other) => {
            panic!("{response} must return its actual native delivery receipt: {other:?}")
        }
    }
}

#[tokio::test]
async fn task009_rest_lane_typed_acceptance_is_not_settlement() {
    typed_send_receipt("accepted").await;
}
#[tokio::test]
async fn task009_rest_lane_typed_preadmission_refusal() {
    typed_send_receipt("refused").await;
}
#[tokio::test]
async fn task009_rest_lane_typed_internal_error_stays_ambiguous() {
    typed_send_receipt("internal").await;
}
#[tokio::test]
async fn task009_rest_lane_typed_timeout_stays_ambiguous() {
    typed_send_receipt("timeout").await;
}

#[tokio::test]
async fn task009_rest_lane_private_settlement_ignores_idle_and_stop_ack_and_names_actual_evidence()
{
    let (state, peer) = channel_session("task009-events").await;
    let mut events = state.subscribe_turn_events();
    let submitting = {
        let state = state.clone();
        tokio::spawn(async move {
            state
                .handle_send(send("task009-events", "request-events"))
                .await
        })
    };
    initialize(&peer).await;
    let (id, _, _) = peer.expect_request().await;
    peer.respond(&id, json!({"turn":{"id":"native-events"}}));
    let _ = submitting.await.unwrap();
    let interrupt = {
        let state = state.clone();
        tokio::spawn(async move {
            state
                .handle_interrupt(FreshAgentInterrupt {
                    provider: AgentProvider::Codex,
                    session_type: SessionType::Freshcodex,
                    session_id: "task009-events".into(),
                    request_id: None,
                    cwd: None,
                })
                .await
        })
    };
    let (id, method, _) = peer.expect_request().await;
    assert_eq!(method, "turn/interrupt");
    peer.respond(&id, json!({}));
    interrupt.await.unwrap();
    peer.emit_notification(
        "thread/status/changed",
        json!({"threadId":"task009-events","status":{"type":"idle"}}),
    );
    peer.emit_notification(
        "turn/completed",
        json!({"threadId":"foreign","turn":{"id":"native-events","status":"completed"}}),
    );
    peer.emit_notification(
        "turn/completed",
        json!({"threadId":"task009-events","turn":{"id":"unrelated","status":"completed"}}),
    );
    let premature = tokio::time::timeout(Duration::from_millis(50), events.recv()).await;
    peer.emit_notification(
        "turn/completed",
        json!({"threadId":"task009-events","turn":{"id":"native-events","status":"interrupted"}}),
    );
    let settled = tokio::time::timeout(Duration::from_secs(1), events.recv()).await;
    drop(peer);
    state.shutdown().await;
    assert!(
        premature.is_err(),
        "ACK/status/foreign terminal cannot settle: {premature:?}"
    );
    assert!(
        matches!(settled, Ok(Ok(CodexTurnEvent::Settled {
        session_id, turn_id, incarnation_id, request_ids,
        outcome: NativeSettlement::Interrupted, source: CodexSettlementSource::NativeNotification,
    })) if session_id == "task009-events" && turn_id.as_deref() == Some("native-events") && incarnation_id == "task009-owner-task009-events" && request_ids == ["request-events"]),
        "matching native terminal must publish its typed evidence"
    );
}

#[tokio::test]
async fn task009_rest_lane_typed_create_and_adoption_distinguish_cleanup_authority() {
    let _environment = super::tests::ENV_LOCK.lock().await;
    super::tests::configure_fake_codex_cmd(
        r#"{"threadStartThreadId":"task009-created","recordTurns":true}"#,
    );
    let (state, _) = super::tests::state_with_bus();
    let request: FreshAgentCreate = serde_json::from_value(json!({
        "requestId":"task009-create", "provider":"codex", "sessionType":"freshcodex",
        "model":"provider-current", "effort":"xhigh", "collaborationMode":"plan",
        "sandbox":"workspace-write", "permissionMode":"on-request",
    }))
    .unwrap();
    let created = state.handle_create(request.clone(), None).await;
    let mut resume = request;
    resume.request_id = "task009-adopt".into();
    resume.session_ref = Some(SessionLocator {
        provider: "codex".into(),
        session_id: "task009-created".into(),
    });
    let adopted = state.handle_create(resume, None).await;
    let writers = state.sessions.lock().await.len();
    state.shutdown().await;
    assert_eq!(writers, 1);
    assert!(
        matches!(created, CodexCreateOutcome::Created { session_id, session_ref: Some(reference), cleanup_ownership_id: Some(owner) } if session_id == "task009-created" && reference.session_id == session_id && !owner.is_empty())
    );
    assert!(
        matches!(adopted, CodexCreateOutcome::Created { session_id, cleanup_ownership_id: None, .. } if session_id == "task009-created")
    );
}

#[tokio::test]
async fn task009_rest_lane_http_same_id_steers_wait_for_one_actual_terminal() {
    let (state, peer) = channel_session("task009-http-steer").await;
    let (router, pane) = http_pane(state.clone(), "task009-http-steer");
    let mut frames = state.broadcast_tx.subscribe();
    let first_router = router.clone();
    let first_uri = format!("/api/panes/{pane}/send-keys");
    let mut first = tokio::spawn(async move {
        post_http(
            first_router,
            &first_uri,
            json!({"data":"first\r","requestId":"first","timeout":3}),
        )
        .await
    });
    initialize(&peer).await;
    let (id, method, params) = peer.expect_request().await;
    assert_eq!(method, "turn/start");
    assert_eq!(params["input"][0]["text"], "first");
    peer.respond(&id, json!({"turn":{"id":"shared-native-turn"}}));
    accepted(&mut frames, "first").await;
    let first_early = tokio::time::timeout(Duration::from_millis(30), &mut first)
        .await
        .ok()
        .map(Result::unwrap);
    let second_uri = format!("/api/panes/{pane}/send-keys");
    let mut second = tokio::spawn(async move {
        post_http(
            router,
            &second_uri,
            json!({"data":"steer\n","requestId":"second","timeout":3}),
        )
        .await
    });
    let (id, method, params) = peer.expect_request().await;
    assert_eq!(method, "turn/steer");
    assert_eq!(params["expectedTurnId"], "shared-native-turn");
    peer.respond(&id, json!({"turnId":"shared-native-turn"}));
    accepted(&mut frames, "second").await;
    let second_early = tokio::time::timeout(Duration::from_millis(30), &mut second)
        .await
        .ok()
        .map(Result::unwrap);
    let early = (first_early.is_some(), second_early.is_some());
    peer.emit_notification(
        "thread/status/changed",
        json!({"threadId":"task009-http-steer","status":{"type":"idle"}}),
    );
    peer.emit_notification(
        "turn/completed",
        json!({"threadId":"task009-http-steer","turn":{"id":"unrelated","status":"completed"}}),
    );
    peer.emit_notification("turn/completed", json!({"threadId":"task009-http-steer","turn":{"id":"shared-native-turn","status":"completed"}}));
    let one = match first_early {
        Some(value) => value,
        None => first.await.unwrap(),
    };
    let two = match second_early {
        Some(value) => value,
        None => second.await.unwrap(),
    };
    drop(peer);
    state.shutdown().await;
    assert_eq!(
        early,
        (false, false),
        "HTTP must remain pending after native admission"
    );
    for (status, body) in [one, two] {
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["status"], "ok", "{body}");
        assert_eq!(body["data"]["status"], "idle", "{body}");
        assert_eq!(body["data"]["submittedTurnId"], "shared-native-turn");
    }
}

#[tokio::test]
async fn task009_rest_lane_http_uncertainty_keeps_native_request_receipt_and_never_replays() {
    let (state, peer) = channel_session("task009-http-uncertain").await;
    let (router, pane) = http_pane(state.clone(), "task009-http-uncertain");
    let uri = format!("/api/panes/{pane}/send-keys");
    let submitting = tokio::spawn(async move {
        post_http(
            router,
            &uri,
            json!({"data":"uncertain prompt\r","requestId":"uncertain-9"}),
        )
        .await
    });
    initialize(&peer).await;
    let (id, method, _) = peer.expect_request().await;
    assert_eq!(method, "turn/start");
    peer.respond_error(&id, -32603, "delivery cannot be proven");
    let (status, body) = submitting.await.unwrap();
    let no_replay = tokio::time::timeout(Duration::from_millis(30), peer.next_raw_frame())
        .await
        .is_err();
    drop(peer);
    state.shutdown().await;
    assert!(no_replay);
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["code"], "CODEX_DELIVERY_AMBIGUOUS");
    assert_eq!(body["retryable"], false);
    assert_eq!(body["requestId"], "uncertain-9");
    assert_eq!(body["sessionId"], "task009-http-uncertain");
    assert!(body["incarnationId"]
        .as_str()
        .is_some_and(|id| !id.is_empty()));
    assert!(
        body.get("submittedTurnId").is_none(),
        "unknown delivery cannot invent a native turn id"
    );
}

#[tokio::test]
async fn task009_rest_lane_capture_preserves_native_output_and_bounds_utf8_separately() {
    let (state, peer) = channel_session("task009-capture").await;
    let mut events = state.subscribe_turn_events();
    let submitting = {
        let state = state.clone();
        tokio::spawn(async move {
            state
                .handle_send(send("task009-capture", "capture-control"))
                .await
        })
    };
    initialize(&peer).await;
    let (id, _, _) = peer.expect_request().await;
    peer.respond(&id, json!({"turn":{"id":"captured-turn"}}));
    submitting.await.unwrap();
    let reading = {
        let state = state.clone();
        tokio::spawn(async move { state.get_snapshot("task009-capture", None).await })
    };
    let (id, method, _) = peer.expect_request().await;
    assert_eq!(method, "thread/read");
    let raw = json!({"thread":{"id":"task009-capture","status":{"type":"idle"},"turns":[{"id":"captured-turn","status":"completed","items":[{"type":"userMessage","id":"u","content":[{"type":"text","text":"éé"}]},{"type":"agentMessage","id":"a","text":"actual retained answer"}]}]}});
    peer.respond(&id, raw.clone());
    let ready = reading.await.unwrap().unwrap();
    let evidence = tokio::time::timeout(Duration::from_secs(1), events.recv())
        .await
        .unwrap()
        .unwrap();
    let lane = CodexRestLane::new(state.clone(), Arc::new(|| true));
    let request = RestLaneCapture {
        session_id: "task009-capture".into(),
        provider: "codex".into(),
        session_type: "freshcodex".into(),
        max_bytes: 7,
    };
    let short = capture_from_peer(&lane, request.clone(), &peer, &raw).await;
    let full = capture_from_peer(
        &lane,
        RestLaneCapture {
            max_bytes: 4096,
            ..request
        },
        &peer,
        &raw,
    )
    .await;
    drop(peer);
    state.shutdown().await;
    assert_eq!(
        ready["status"], "idle",
        "native terminal read established fixture readiness"
    );
    assert!(matches!(
        evidence,
        CodexTurnEvent::Settled {
            outcome: NativeSettlement::Completed,
            source: CodexSettlementSource::NativeThreadRead,
            ..
        }
    ));
    let short = short.unwrap();
    let full = full.unwrap();
    assert_eq!(short.text, "user: ");
    assert!(short.truncated);
    assert!(!full.truncated);
    assert!(full.text.contains("user: éé"));
    assert!(full.text.contains("assistant: actual retained answer"));
}

#[tokio::test]
async fn task009_rest_lane_socket_loss_does_not_settle_until_the_owned_process_exits() {
    let (state, peer) = channel_session("task009-owned-exit").await;
    let (router, pane) = http_pane(state.clone(), "task009-owned-exit");
    let mut events = state.subscribe_turn_events();
    let mut frames = state.broadcast_tx.subscribe();
    let uri = format!("/api/panes/{pane}/send-keys");
    let mut submitting = tokio::spawn(async move {
        post_http(
            router,
            &uri,
            json!({"data":"owned exit","requestId":"owned-exit","timeout":3}),
        )
        .await
    });
    initialize(&peer).await;
    let (id, _, _) = peer.expect_request().await;
    peer.respond(&id, json!({"turn":{"id":"owned-exit-native"}}));
    accepted(&mut frames, "owned-exit").await;
    drop(peer);
    let early = tokio::time::timeout(Duration::from_millis(50), &mut submitting)
        .await
        .ok()
        .map(Result::unwrap);
    let before_exit = early.is_none();
    let no_false_event = events.try_recv().is_err();
    state.shutdown().await;
    let (status, body) = match early {
        Some(result) => result,
        None => submitting.await.unwrap(),
    };
    let evidence = tokio::time::timeout(Duration::from_secs(1), events.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(
        before_exit && no_false_event,
        "transport loss is not native termination"
    );
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["code"], "FRESH_AGENT_SESSION_ENDED");
    assert_eq!(body["submittedTurnId"], "owned-exit-native");
    assert!(matches!(
        evidence,
        CodexTurnEvent::Settled {
            outcome: NativeSettlement::OwnedExit,
            source: CodexSettlementSource::ConfirmedOwnedExit,
            ..
        }
    ));
}

#[tokio::test]
async fn task009_rest_lane_old_cleanup_receipt_cannot_stop_a_resumed_incarnation() {
    let _environment = super::tests::ENV_LOCK.lock().await;
    super::tests::configure_fake_codex_cmd(
        r#"{"threadStartThreadId":"task009-replaced","recordTurns":true}"#,
    );
    let (state, _) = super::tests::state_with_bus();
    let lane = Arc::new(CodexRestLane::new(state.clone(), Arc::new(|| true)));
    let request = RestLaneCreate {
        request_id: "original-incarnation".into(),
        provider: "codex".into(),
        session_type: "freshcodex".into(),
        ..Default::default()
    };
    let original = lane.clone().create_agent(request.clone()).await.unwrap();
    state
        .handle_recovery_stop(FreshAgentRecoveryStop {
            provider: AgentProvider::Codex,
            session_type: SessionType::Freshcodex,
            session_id: original.session_id.clone(),
            request_id: "owned-stop".into(),
            observed_epoch: None,
            observed_generation: None,
        })
        .await;
    let resume = RestLaneCreate {
        request_id: "replacement-incarnation".into(),
        native_session_id: Some(original.session_id.clone()),
        ..request.clone()
    };
    let replacement = lane.clone().create_agent(resume.clone()).await.unwrap();
    lane.abandon_create(&request, &original).await.unwrap();
    let survives = state.has_live_session(&replacement.session_id).await;
    let sent = lane
        .send_agent(RestLaneSend {
            provider: "codex".into(),
            session_type: "freshcodex".into(),
            session_id: replacement.session_id.clone(),
            request_id: "replacement-send".into(),
            text: "replacement is still the writer\r".into(),
            timeout_ms: 2000,
            observed_epoch: None,
            observed_generation: None,
        })
        .await;
    let cleanup = lane.abandon_create(&resume, &replacement).await;
    let stopped = !state.has_live_session(&replacement.session_id).await;
    state.shutdown().await;
    assert_ne!(original.cleanup_token, replacement.cleanup_token);
    assert!(survives);
    assert!(sent.unwrap().completed);
    assert!(cleanup.is_ok() && stopped);
}

#[tokio::test]
async fn task009_rest_lane_http_deadline_returns_only_native_admission_as_approximate() {
    let (state, peer) = channel_session("task009-deadline").await;
    let (router, pane) = http_pane(state.clone(), "task009-deadline");
    let uri = format!("/api/panes/{pane}/send-keys");
    let submitting = tokio::spawn(async move {
        post_http(
            router,
            &uri,
            json!({"data":"not yet terminal\r\n","requestId":"deadline-request","timeout":0}),
        )
        .await
    });
    initialize(&peer).await;
    let (id, method, params) = peer.expect_request().await;
    assert_eq!(method, "turn/start");
    peer.respond(&id, json!({"turn":{"id":"deadline-native"}}));
    let (status, body) = submitting.await.unwrap();
    drop(peer);
    state.shutdown().await;
    assert_eq!(
        params["input"][0]["text"], "not yet terminal\r",
        "strip exactly one terminator"
    );
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "approx");
    assert_eq!(body["data"]["status"], "approx");
    assert_eq!(body["data"]["submittedTurnId"], "deadline-native");
}

#[tokio::test]
async fn task009_rest_lane_enter_only_is_a_noop_without_creating_a_runtime() {
    let (state, _) = super::tests::state_with_bus();
    let lane = CodexRestLane::new(state.clone(), Arc::new(|| true));
    for text in ["\r", "\n", "\r\n", "\n\r\n"] {
        let sent = lane
            .send_agent(RestLaneSend {
                provider: "codex".into(),
                session_type: "freshcodex".into(),
                session_id: "never-started".into(),
                request_id: "enter-only".into(),
                text: text.into(),
                timeout_ms: 0,
                observed_epoch: None,
                observed_generation: None,
            })
            .await
            .unwrap();
        assert!(sent.noop && sent.completed);
        assert!(sent.submitted_turn_id.is_none());
    }
    assert!(state.sessions.lock().await.is_empty());
    state.shutdown().await;
}

#[tokio::test]
async fn task009_rest_lane_headless_capture_hydrates_native_history_without_a_browser() {
    let _environment = super::tests::ENV_LOCK.lock().await;
    super::tests::configure_fake_codex_cmd(
        r#"{"threadStartThreadId":"task009-headless-history","recordTurns":true}"#,
    );
    let (state, _) = super::tests::state_with_bus();
    let lane = Arc::new(CodexRestLane::new(state.clone(), Arc::new(|| true)));
    let created = lane
        .clone()
        .create_agent(RestLaneCreate {
            request_id: "headless-history".into(),
            provider: "codex".into(),
            session_type: "freshcodex".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    let sent = lane
        .send_agent(RestLaneSend {
            request_id: "headless-history-send".into(),
            session_id: created.session_id.clone(),
            provider: "codex".into(),
            session_type: "freshcodex".into(),
            text: "headless saved history\r".into(),
            timeout_ms: 2000,
            observed_epoch: None,
            observed_generation: None,
        })
        .await
        .unwrap();
    let captured = lane
        .capture(RestLaneCapture {
            session_id: created.session_id.clone(),
            provider: "codex".into(),
            session_type: "freshcodex".into(),
            max_bytes: 4096,
        })
        .await;
    // Readiness proof follows capture: no UI or earlier GET can mask a cold
    // headless capture by hydrating the retained projection first.
    let native = state.get_snapshot(&created.session_id, None).await.unwrap();
    state.shutdown().await;
    assert!(sent.completed);
    assert_eq!(native["turns"].as_array().unwrap().len(), 2);
    let captured = captured.unwrap();
    assert!(
        captured.text.contains("user: headless saved history"),
        "{}",
        captured.text
    );
    assert!(
        captured.text.contains("assistant: Fixture turn"),
        "{}",
        captured.text
    );
}

#[tokio::test]
async fn task009_rest_lane_abandon_only_stops_the_runtime_its_create_established() {
    let _environment = super::tests::ENV_LOCK.lock().await;
    super::tests::configure_fake_codex_cmd(
        r#"{"threadStartThreadId":"task009-cleanup","recordTurns":true}"#,
    );
    let (state, _) = super::tests::state_with_bus();
    let lane = Arc::new(CodexRestLane::new(state.clone(), Arc::new(|| true)));
    let request = RestLaneCreate {
        request_id: "cleanup-create".into(),
        provider: "codex".into(),
        session_type: "freshcodex".into(),
        ..Default::default()
    };
    let created = lane.clone().create_agent(request.clone()).await.unwrap();
    let resume = RestLaneCreate {
        request_id: "cleanup-adopt".into(),
        native_session_id: Some(created.session_id.clone()),
        ..request.clone()
    };
    let adopted = lane.clone().create_agent(resume.clone()).await.unwrap();
    lane.abandon_create(&resume, &adopted).await.unwrap();
    let adopted_survives = state.has_live_session(&created.session_id).await;
    let stale = RestLaneCreated {
        cleanup_token: Some("foreign-incarnation".into()),
        ..created.clone()
    };
    let stale_cleanup = lane.abandon_create(&request, &stale).await;
    let stale_survives = state.has_live_session(&created.session_id).await;
    let owned_cleanup = lane.abandon_create(&request, &created).await;
    let owned_survives = state.has_live_session(&created.session_id).await;
    state.shutdown().await;
    assert!(adopted.cleanup_token.is_none());
    assert!(
        stale_cleanup.is_ok() && owned_cleanup.is_ok(),
        "stale={stale_cleanup:?}, owned={owned_cleanup:?}"
    );
    assert!(
        adopted_survives && stale_survives,
        "adoption or a foreign receipt cannot kill this writer"
    );
    assert!(
        !owned_survives,
        "abandoned create must confirm its owned runtime stopped"
    );
}

#[tokio::test]
async fn task009_rest_lane_http_startup_stop_waits_for_native_terminal_and_blocks_later_start() {
    let (state, peer) = channel_session("task009-startup-stop").await;
    let (router, pane) = http_pane(state.clone(), "task009-startup-stop");
    let first_uri = format!("/api/panes/{pane}/send-keys");
    let first_router = router.clone();
    let mut first = tokio::spawn(async move {
        post_http(
            first_router,
            &first_uri,
            json!({"data":"startup","requestId":"startup","timeout":3}),
        )
        .await
    });
    initialize(&peer).await;
    let (start_id, method, _) = peer.expect_request().await;
    assert_eq!(method, "turn/start");
    state
        .handle_interrupt(FreshAgentInterrupt {
            provider: AgentProvider::Codex,
            session_type: SessionType::Freshcodex,
            session_id: "task009-startup-stop".into(),
            request_id: None,
            cwd: None,
        })
        .await;
    let before_startup = tokio::time::timeout(Duration::from_millis(30), &mut first)
        .await
        .is_err();
    let mut events = state.subscribe_turn_events();
    peer.respond(&start_id, json!({"turn":{"id":"startup-native"}}));
    let (stop_id, method, params) = peer.expect_request().await;
    assert_eq!(method, "turn/interrupt");
    assert_eq!(params["turnId"], "startup-native");
    peer.emit_notification("turn/completed", json!({"threadId":"task009-startup-stop","turn":{"id":"startup-native","status":"interrupted"}}));
    let terminal = tokio::time::timeout(Duration::from_secs(2), events.recv())
        .await
        .unwrap()
        .unwrap();
    let turns = state
        .sessions
        .lock()
        .await
        .get("task009-startup-stop")
        .unwrap()
        .turn_state
        .clone();
    let waiting = turns.lock().unwrap().waiting_for_stop.clone();
    let later_uri = format!("/api/panes/{pane}/send-keys");
    let later = tokio::spawn(async move {
        post_http(
            router,
            &later_uri,
            json!({"data":"later","requestId":"later","timeout":3}),
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(2), waiting.notified())
        .await
        .unwrap();
    let no_later_start = tokio::time::timeout(Duration::from_millis(30), peer.next_raw_frame())
        .await
        .is_err();
    peer.respond(&stop_id, json!({}));
    let (id, method, _) = peer.expect_request().await;
    assert_eq!(method, "turn/start");
    peer.respond(&id, json!({"turn":{"id":"later-native"}}));
    peer.emit_notification("turn/completed", json!({"threadId":"task009-startup-stop","turn":{"id":"later-native","status":"completed"}}));
    let first = first.await.unwrap();
    let later = later.await.unwrap();
    drop(peer);
    state.shutdown().await;
    assert!(
        before_startup && no_later_start,
        "startup result and unresolved Stop gate native issuance"
    );
    assert!(matches!(
        terminal,
        CodexTurnEvent::Settled {
            outcome: NativeSettlement::Interrupted,
            source: CodexSettlementSource::NativeNotification,
            ..
        }
    ));
    assert_eq!(first.0, StatusCode::CONFLICT, "{:?}", first.1);
    assert_eq!(first.1["code"], "CODEX_TURN_INTERRUPTED");
    assert_eq!(later.1["data"]["status"], "idle", "{:?}", later.1);
}

#[tokio::test]
async fn task009_rest_lane_http_create_refusal_names_the_actual_owner() {
    use freshell_ownership::{
        BeginOutcome, CommitOutcome, OwnerIdentity, RuntimeOwnerKind, RuntimeOwnershipRegistry,
    };
    let registry = Arc::new(RuntimeOwnershipRegistry::with_epoch(91));
    let BeginOutcome::Granted { generation } = registry.begin_start(
        "codex",
        "owned-codex",
        RuntimeOwnerKind::Terminal,
        "terminal-start",
        None,
        "fixture",
        1,
    ) else {
        panic!("initial owner granted");
    };
    assert_eq!(
        registry.commit_live(
            "codex",
            "owned-codex",
            "terminal-start",
            generation,
            OwnerIdentity {
                kind: RuntimeOwnerKind::Terminal,
                terminal_id: Some("owning-terminal".into()),
                live_session_key: None,
                pid: None,
                ownership_id: None,
            }
        ),
        CommitOutcome::Committed
    );
    let (mut state, _) = super::tests::state_with_bus();
    state.set_ownership(registry);
    let (router, _) = http_pane(state.clone(), "owned-codex");
    let (status, body) = post_http(
        router,
        "/api/tabs",
        json!({"agent":"codex","sessionRef":{"provider":"codex","sessionId":"owned-codex"}}),
    )
    .await;
    state.shutdown().await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(
        json!([
            body["ownerKind"],
            body["ownerEpoch"],
            body["ownerGeneration"]
        ]),
        json!(["terminal", 91, generation])
    );
}

#[tokio::test]
async fn task009_rest_lane_headless_create_and_resume_publish_the_native_effective_settings() {
    let _environment = super::tests::ENV_LOCK.lock().await;
    let workspace = tempfile::tempdir().unwrap();
    let native_cwd = workspace.path().join("native-cwd");
    std::fs::create_dir(&native_cwd).unwrap();
    let request_log = workspace.path().join("native-requests.jsonl");
    super::tests::configure_fake_codex_cmd(&json!({
        "recordTurns":true,"uniqueThreadIds":true,"appendRequestLogPath":request_log,
        "effectiveThreadSettings":{"model":"native-effective","cwd":native_cwd,"sandbox":"read-only","approvalPolicy":"on-request"}
    }).to_string());
    let (state, _) = super::tests::state_with_bus();
    let api = crate::FreshAgentState::new(
        Arc::new("tok".into()),
        Arc::new(tokio::sync::broadcast::channel(64).0),
    )
    .with_terminal_registry(freshell_terminal::TerminalRegistry::new());
    api.set_codex_rest_lane(Arc::new(CodexRestLane::new(
        state.clone(),
        Arc::new(|| true),
    )))
    .unwrap();
    api.set_rest_create_settings_reader(Arc::new(|| Box::pin(async {
        freshell_protocol::SettingsFreshAgent { default_plugins:vec![], enabled:true, initial_setup_done:None,
            providers:json!({"freshcodex":{"modelSelection":{"kind":"exact","modelId":"provider-current"},"effort":"ultra","collaborationMode":"plan","sandbox":"workspace-write","defaultPermissionMode":"on-request"}})
        }.into()
    }))).unwrap();
    let router = crate::router(api.clone());
    let (status, created) = post_http(
        router.clone(),
        "/api/tabs",
        json!({"agent":"codex","cwd":workspace.path(),"effort":null}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let native = created["data"]["sessionRef"]["sessionId"].as_str().unwrap();
    let ready = state.get_snapshot(native, None).await.unwrap();
    let (resume_status, resumed) = post_http(
        router,
        "/api/tabs",
        json!({"agent":"codex","sessionRef":{"provider":"codex","sessionId":native}}),
    )
    .await;
    let contents = [&created, &resumed].map(|body| {
        api.layout
            .get_pane_snapshot(body["data"]["paneId"].as_str().unwrap())
            .unwrap()
            .pane_content
            .unwrap()
    });
    let native_requests = std::fs::read_to_string(request_log)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    state.shutdown().await;
    assert_eq!(
        ready["settings"]["model"], "native-effective",
        "the real owning runtime established native-effective settings before layout assertions"
    );
    assert_eq!(resume_status, StatusCode::OK, "{resumed}");
    assert_eq!(
        native_requests
            .iter()
            .filter(|row| row["method"] == "thread/start")
            .count(),
        1
    );
    assert_eq!(
        native_requests
            .iter()
            .filter(|row| row["method"] == "thread/resume")
            .count(),
        0,
        "live canonical resume adopts the existing writer"
    );
    for content in contents {
        assert_eq!(
            json!({"model":content["model"],"cwd":content["initialCwd"],"sandbox":content["sandbox"],"permissionMode":content["permissionMode"],"collaborationMode":content["collaborationMode"],"effortIsNativeDefault":content["effortIsNativeDefault"]}),
            json!({"model":"native-effective","cwd":native_cwd,"sandbox":"read-only","permissionMode":"on-request","collaborationMode":"plan","effortIsNativeDefault":true})
        );
    }
}

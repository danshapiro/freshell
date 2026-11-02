#[tokio::test]
async fn codex_rest_previous_unknown_delivery_refuses_the_new_request_with_its_own_correlation() {
    let session = "rest-earlier-unknown";
    let (state, peer) = channel_session(session).await;
    let (router, pane) = http_pane(state.clone(), session);
    let uri = format!("/api/panes/{pane}/send-keys");
    let first = {
        let router = router.clone();
        let uri = uri.clone();
        tokio::spawn(async move {
            post_http(
                router,
                &uri,
                json!({
                    "data":"first uncertain prompt\r", "requestId":"earlier-request"
                }),
            )
            .await
        })
    };
    initialize(&peer).await;
    let (id, method, _) = peer.expect_request().await;
    assert_eq!(method, "turn/start");
    peer.respond_error(&id, -32603, "the first response was lost");
    let (first_status, first_body) = first.await.unwrap();
    let (second_status, second_body) = post_http(
        router,
        &uri,
        json!({
            "data":"second refused prompt\r", "requestId":"later-request"
        }),
    )
    .await;
    let no_second_native_send =
        tokio::time::timeout(Duration::from_millis(50), peer.next_raw_frame())
            .await
            .is_err();
    drop(peer);
    state.shutdown().await;
    assert_eq!(first_status, StatusCode::CONFLICT, "{first_body}");
    assert_eq!(first_body["code"], "CODEX_DELIVERY_AMBIGUOUS");
    assert_eq!(first_body["requestId"], "earlier-request");
    assert_eq!(second_status, StatusCode::CONFLICT, "{second_body}");
    assert_eq!(second_body["code"], "CODEX_PREVIOUS_DELIVERY_AMBIGUOUS");
    assert_eq!(second_body["message"], "Earlier input has unresolved native delivery; recover or inspect the conversation before sending again");
    assert_eq!(second_body["requestId"], "later-request");
    assert_eq!(second_body["sessionId"], session);
    assert_eq!(second_body["retryable"], false);
    assert!(second_body.get("submittedTurnId").is_none());
    assert!(
        no_second_native_send,
        "the refused second request must not reach Codex"
    );
}

#[tokio::test]
async fn codex_rest_matched_failed_turn_preserves_the_exact_provider_diagnostic() {
    for scenario in ["completion", "prior-error", "missing"] {
        let session = format!("rest-failed-{scenario}");
        let (state, peer) = channel_session(&session).await;
        let (router, pane) = http_pane(state.clone(), &session);
        let uri = format!("/api/panes/{pane}/send-keys");
        let mut frames = state.broadcast_tx.subscribe();
        let submitting = tokio::spawn(async move {
            post_http(
                router,
                &uri,
                json!({
                    "data":"run a prompt\r", "requestId":"owned-request", "timeout":3
                }),
            )
            .await
        });
        initialize(&peer).await;
        let (id, method, _) = peer.expect_request().await;
        assert_eq!(method, "turn/start");
        peer.respond(&id, json!({"turn":{"id":"owned-turn"}}));
        accepted(&mut frames, "owned-request").await;
        if scenario == "prior-error" {
            peer.emit_notification("error", json!({
                "threadId":session, "turnId":"owned-turn", "willRetry":false,
                "error":{"message":"Selected model is at capacity. Please try a different model."}
            }));
        }
        let error = if scenario == "completion" {
            json!({"message":"Selected model is at capacity. Please try a different model."})
        } else {
            Value::Null
        };
        peer.emit_notification(
            "turn/completed",
            json!({
                "threadId":session, "turn":{"id":"owned-turn", "status":"failed", "error":error}
            }),
        );
        let (status, body) = submitting.await.unwrap();
        drop(peer);
        state.shutdown().await;
        assert_eq!(status, StatusCode::CONFLICT, "{scenario}: {body}");
        assert_eq!(body["code"], "CODEX_TURN_FAILED", "{scenario}");
        let expected = if scenario == "missing" {
            "the submitted Codex turn failed"
        } else {
            "Selected model is at capacity. Please try a different model."
        };
        assert_eq!(body["message"], expected, "{scenario}: {body}");
        assert_eq!(body["sessionId"], session);
        assert_eq!(body["requestId"], "owned-request");
        assert_eq!(body["incarnationId"], format!("task009-owner-{session}"));
        assert_eq!(body["submittedTurnId"], "owned-turn");
        assert_eq!(body["retryable"], false);
    }
}

#[tokio::test]
async fn codex_rest_provider_start_refusal_is_correlated_to_the_request() {
    let session = "rest-refused-start";
    let (state, peer) = channel_session(session).await;
    let (router, pane) = http_pane(state.clone(), session);
    let uri = format!("/api/panes/{pane}/send-keys");
    let submitting = tokio::spawn(async move {
        post_http(
            router,
            &uri,
            json!({
                "data":"try a prompt\r", "requestId":"refused-request"
            }),
        )
        .await
    });
    initialize(&peer).await;
    let (id, method, _) = peer.expect_request().await;
    assert_eq!(method, "turn/start");
    peer.respond_error(&id, -32602, "model is at capacity");
    let (status, body) = submitting.await.unwrap();
    drop(peer);
    state.shutdown().await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(body["code"], "CODEX_TURN_START_FAILED");
    assert!(body["message"]
        .as_str()
        .unwrap()
        .contains("model is at capacity"));
    assert_eq!(body["sessionId"], session);
    assert_eq!(body["requestId"], "refused-request");
    assert!(body.get("submittedTurnId").is_none());
}

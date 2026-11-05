#[tokio::test]
async fn stop_correlation_latched_provider_error_keeps_the_original_request_id() {
    for notification_first in [false, true] {
        let (st, mut rx) = state_with_bus();
        let (transport, peer) = freshell_codex::new_channel_transport();
        let (client, notifs) = CodexAppServerClient::connect(transport);
        insert_fake_session_with_real_consumer(
            &st,
            "thread-pending-stop",
            Arc::new(client),
            Arc::new(StdMutex::new(None)),
            notifs,
            spawn_sleeper(),
            "pending-stop-correlation",
        )
        .await;
        let send = {
            let st = st.clone();
            tokio::spawn(async move {
                st.handle_send(send_msg("thread-pending-stop", "first"))
                    .await
            })
        };
        answer_initialize(&peer).await;
        let (start_id, method, _) = peer.expect_request().await;
        assert_eq!(method, "turn/start");
        let mut stop = task4_stop("thread-pending-stop");
        stop.request_id = Some("original-stop-request".into());
        st.handle_interrupt(stop).await;
        task4_no_native_frame(&peer).await;
        if notification_first {
            peer.emit_notification("turn/started", json!({"threadId":"thread-pending-stop", "turn":{"id":"accepted","status":"inProgress"}}));
        } else {
            peer.respond(&start_id, json!({"turn":{"id":"accepted"}}));
        }
        let (stop_id, method, _) = peer.expect_request().await;
        assert_eq!(method, "turn/interrupt");
        peer.respond_error(&stop_id, -32602, "the provider refused the stop");
        if notification_first {
            peer.respond(&start_id, json!({"turn":{"id":"accepted"}}));
        }
        send.await.unwrap();
        let frames = collect_frames_until(&mut rx, Duration::from_secs(2), |w| {
            w["event"]["code"] == "CODEX_INTERRUPT_FAILED"
        })
        .await;
        assert!(frames.matched);
        let event = &frames.frames.last().unwrap()["event"];
        assert_eq!(event["requestId"], "original-stop-request", "{event}");
        assert!(event["message"]
            .as_str()
            .unwrap()
            .contains("the provider refused the stop"));
        drop(peer);
        st.shutdown().await;
    }
}

#[tokio::test]
async fn stop_correlation_legacy_request_keeps_its_original_error_shape() {
    let (st, mut rx) = state_with_bus();
    st.handle_interrupt(task4_stop("missing-legacy-thread"))
        .await;
    let frame: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
    assert_eq!(frame["type"], "error");
    assert!(
        rx.try_recv().is_err(),
        "a legacy Stop must not acquire a new session error"
    );
}

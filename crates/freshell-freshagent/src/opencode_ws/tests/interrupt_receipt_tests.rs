use super::*;

fn interrupt_request(session_id: &str, request_id: Option<&str>) -> FreshAgentInterrupt {
    FreshAgentInterrupt {
        request_id: request_id.map(str::to_owned),
        provider: AgentProvider::Opencode,
        session_id: session_id.into(),
        session_type: SessionType::Freshopencode,
        cwd: None,
    }
}

#[tokio::test]
async fn failed_interrupts_report_their_request_and_preserve_the_running_turn() {
    for (kind, request_id, uncertain, diagnostic) in [
        (
            "undelivered",
            Some("stop-undelivered"),
            false,
            "could not receive the Stop request",
        ),
        (
            "transport",
            Some("stop-transport"),
            true,
            "connection to OpenCode failed",
        ),
        ("http", Some("stop-http"), true, "HTTP 500"),
        ("transport", None, true, "connection to OpenCode failed"),
    ] {
        let (st, http, mut rx) =
            compact_state(r#"{"model":null}"#, SummarizeOutcome::OkAnswered).await;
        insert_compact_session(&st, "ses_stop", Some("prov-a/mdl-x")).await;
        http.arm_status_busy("ses_stop", 1000);
        match kind {
            "undelivered" => http.arm_abort_refused(),
            "transport" => http.arm_abort_ambiguous(),
            "http" => http.arm_abort_fail(),
            _ => unreachable!(),
        }
        let session = st.sessions.lock().await.get("ses_stop").cloned().unwrap();
        session.lock().await.turn_task = Some(TurnTask {
            kind: TurnTaskKind::Send,
            settlement: None,
            handle: tokio::spawn(std::future::pending::<()>()),
            compact_settled_rx: None,
            settling: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        });

        st.handle_interrupt(interrupt_request("ses_stop", request_id))
            .await;
        let frames = drain_frames(&mut rx);
        let errors: Vec<_> = frames
            .iter()
            .filter(|frame| is_event(frame, "freshAgent.operation.error", None))
            .collect();
        assert!(
            !frames
                .iter()
                .any(|frame| is_event(frame, "freshAgent.error", None)),
            "a Stop receipt must not be mistaken for a terminal session error: {frames:?}"
        );
        if let Some(id) = request_id {
            assert_eq!(errors.len(), 1, "{kind}: {frames:?}");
            let event = &errors[0]["event"];
            assert_eq!(event["code"], "OPENCODE_INTERRUPT_FAILED", "{event}");
            assert_eq!(event["requestId"], id, "{event}");
            assert_eq!(event["operationReceipt"], true, "{event}");
            assert!(
                !event["message"]
                    .as_str()
                    .unwrap()
                    .contains("PRIVATE_STOP_ERROR_SENTINEL"),
                "{event}"
            );
            assert!(
                !event["message"].as_str().unwrap().contains("127.0.0.1"),
                "{event}"
            );
            assert!(
                event["message"].as_str().unwrap().contains(diagnostic),
                "{event}"
            );
            if uncertain {
                assert_eq!(event["operationOutcomeUncertain"], true, "{event}");
            } else {
                assert!(event.get("operationOutcomeUncertain").is_none(), "{event}");
            }
        } else {
            assert!(
                errors.is_empty(),
                "legacy failed Stop remains silent: {frames:?}"
            );
        }
        assert!(!frames
            .iter()
            .any(|frame| is_event(frame, "freshAgent.turn.complete", None)));
        assert!(!frames.iter().any(|frame| is_event(
            frame,
            "freshAgent.session.snapshot",
            Some("idle")
        )));
        let mut session = session.lock().await;
        assert!(session.orphaned_daemon_turn.load(Ordering::SeqCst));
        assert!(!session.turn_aborted.load(Ordering::SeqCst));
        assert_eq!(session.abort_in_flight.load(Ordering::SeqCst), 0);
        let task = session
            .turn_task
            .take()
            .expect("the live turn must remain observable");
        assert!(!task.is_finished());
        task.handle.abort();
    }
}

#[tokio::test]
async fn unknown_interrupt_correlates_new_requests_and_preserves_legacy_error() {
    for request_id in [Some("stop-unknown"), None] {
        let (st, _http, mut rx) =
            compact_state(r#"{"model":null}"#, SummarizeOutcome::OkAnswered).await;
        st.handle_interrupt(interrupt_request("ses_unknown", request_id))
            .await;
        let frames = drain_frames(&mut rx);
        if let Some(id) = request_id {
            let event = frames
                .iter()
                .find(|frame| is_event(frame, "freshAgent.operation.error", None))
                .expect("the requested Stop must report the missing session");
            assert_eq!(event["event"]["code"], "SESSION_NOT_FOUND");
            assert_eq!(event["event"]["requestId"], id);
            assert_eq!(event["event"]["operationReceipt"], true);
            assert!(event["event"].get("operationOutcomeUncertain").is_none());
            assert!(!frames
                .iter()
                .any(|frame| is_event(frame, "freshAgent.error", None)));
        } else {
            assert!(frames.iter().any(|frame| frame["type"] == "error"
                && frame["message"]
                    .as_str()
                    .is_some_and(|message| message.contains("SESSION_NOT_FOUND"))));
            assert!(!frames
                .iter()
                .any(|frame| is_event(frame, "freshAgent.error", None)));
        }
    }
}

#[tokio::test]
async fn interrupted_stop_timeout_reports_a_safe_timeout_and_uncertainty() {
    let (st, http, mut rx, _tx) = compact_state_gated_cfg(
        r#"{"model":null}"#,
        SummarizeOutcome::OkAnswered,
        None,
        None,
        Some(Duration::from_millis(40)),
    )
    .await;
    insert_compact_session(&st, "ses_stop_timeout", Some("prov-a/mdl-x")).await;
    http.arm_abort_hang();
    st.handle_interrupt(interrupt_request("ses_stop_timeout", Some("stop-timeout")))
        .await;
    let frames = drain_frames(&mut rx);
    let event = &frames
        .iter()
        .find(|frame| is_event(frame, "freshAgent.operation.error", None))
        .expect("the timed-out Stop reports a correlated operation error")["event"];
    assert_eq!(event["requestId"], "stop-timeout");
    assert_eq!(event["operationReceipt"], true);
    assert_eq!(event["operationOutcomeUncertain"], true);
    let message = event["message"].as_str().unwrap();
    assert!(message.contains("40ms"), "{event}");
    assert!(!message.contains("127.0.0.1"), "{event}");
}

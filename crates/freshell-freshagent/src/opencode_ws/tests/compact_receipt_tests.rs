use super::*;

fn assert_compact_receipt(frame: &Value, request_id: Option<&str>, uncertain: bool) {
    let event = frame.get("event").expect("nested event");
    assert_eq!(event["type"], "freshAgent.error", "{frame}");
    match request_id {
        Some(id) => {
            assert_eq!(event["requestId"], id, "{frame}");
            assert_eq!(event["operationReceipt"], true, "{frame}");
            if uncertain {
                assert_eq!(event["operationOutcomeUncertain"], true, "{frame}");
            } else {
                assert!(event.get("operationOutcomeUncertain").is_none(), "{frame}");
            }
        }
        None => {
            for key in ["requestId", "operationReceipt", "operationOutcomeUncertain"] {
                assert!(
                    event.get(key).is_none(),
                    "legacy compact added {key}: {frame}"
                );
            }
        }
    }
}

#[tokio::test]
async fn compact_busy_receipt_preserves_the_running_turn_and_legacy_shape() {
    for request_id in [Some("busy-compact"), None] {
        let (st, http, mut rx) =
            compact_state(r#"{"model":null}"#, SummarizeOutcome::OkAnswered).await;
        insert_compact_session(&st, "ses_1", Some("prov-a/mdl-x")).await;
        let session = st.sessions.lock().await.get("ses_1").cloned().unwrap();
        session.lock().await.turn_task = Some(TurnTask {
            kind: TurnTaskKind::Send,
            settlement: None,
            handle: tokio::spawn(std::future::pending::<()>()),
            compact_settled_rx: None,
            settling: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        });
        let mut msg = compact_msg("ses_1");
        msg.request_id = request_id.map(str::to_owned);
        st.handle_compact(msg).await;

        let frames = drain_frames(&mut rx);
        let refusal = frames
            .iter()
            .find(|frame| is_event(frame, "freshAgent.error", None))
            .expect("a busy compact must be refused");
        assert_eq!(refusal["event"]["code"], "INTERNAL_ERROR");
        assert!(refusal["event"]["message"]
            .as_str()
            .unwrap()
            .contains("turn is in progress"));
        assert_compact_receipt(refusal, request_id, false);
        assert!(http.summarize_requests().is_empty());
        assert!(!frames
            .iter()
            .any(|frame| is_event(frame, "freshAgent.turn.complete", None)));
        let task = session
            .lock()
            .await
            .turn_task
            .take()
            .expect("the original turn remains registered");
        assert!(
            !task.is_finished(),
            "the refused compact must not end the running turn"
        );
        task.handle.abort();
    }
}

#[tokio::test]
async fn compact_preflight_refusals_retain_request_identity_without_posting() {
    let (st, http, mut rx) = compact_state(r#"{"model":null}"#, SummarizeOutcome::OkAnswered).await;
    let mut unknown = compact_msg("ses_unknown");
    unknown.request_id = Some("unknown-compact".into());
    st.handle_compact(unknown).await;
    let unknown = frames_until(&mut rx, |frame| is_event(frame, "freshAgent.error", None)).await;
    let frame = unknown.last().unwrap();
    assert_eq!(frame["event"]["code"], "INVALID_SESSION_ID");
    assert_compact_receipt(frame, Some("unknown-compact"), false);

    let mut invalid = compact_msg("ses_invalid");
    invalid.request_id = Some("invalid-fence-compact".into());
    invalid.observed_epoch = Some(1);
    st.handle_compact(invalid).await;
    let invalid = frames_until(&mut rx, |frame| is_event(frame, "freshAgent.error", None)).await;
    let frame = invalid.last().unwrap();
    assert_eq!(frame["event"]["code"], "INVALID_FENCE");
    assert_compact_receipt(frame, Some("invalid-fence-compact"), false);

    insert_compact_session(&st, "ses_no_model", Some("noslash")).await;
    let mut no_model = compact_msg("ses_no_model");
    no_model.request_id = Some("no-model-compact".into());
    st.handle_compact(no_model).await;
    let no_model = frames_until(&mut rx, |frame| is_event(frame, "freshAgent.error", None)).await;
    let frame = no_model.last().unwrap();
    assert_eq!(frame["event"]["code"], "OPENCODE_COMPACT_FAILED");
    assert!(frame["event"]["message"]
        .as_str()
        .unwrap()
        .contains("no model/provider pair"));
    assert_compact_receipt(frame, Some("no-model-compact"), false);
    assert!(no_model.iter().any(|frame| is_event(
        frame,
        "freshAgent.session.snapshot",
        Some("idle")
    )));
    assert!(
        http.summarize_requests().is_empty(),
        "preflight failures must not post"
    );
}

#[tokio::test]
async fn compact_ownership_and_ledger_refusals_keep_the_request_id() {
    let (mut st, http, mut rx) =
        compact_state(r#"{"model":null}"#, SummarizeOutcome::OkAnswered).await;
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    st.set_ownership(registry.clone());
    insert_compact_session(&st, "ses_stale", Some("prov-a/mdl-x")).await;
    let stale = seed_live_then_stop_to_vacant(&registry, "ses_stale").await;
    let mut msg = compact_msg("ses_stale");
    msg.request_id = Some("stale-compact".into());
    msg.observed_epoch = Some(registry.boot_epoch());
    msg.observed_generation = Some(stale);
    st.handle_compact(msg).await;
    let frames = frames_until(&mut rx, |frame| is_event(frame, "freshAgent.error", None)).await;
    let frame = frames.last().unwrap();
    assert_eq!(frame["event"]["code"], "SESSION_RESERVED");
    assert_compact_receipt(frame, Some("stale-compact"), false);
    assert!(http.summarize_requests().is_empty());

    let (st, http, mut rx) = compact_state(r#"{"model":null}"#, SummarizeOutcome::OkAnswered).await;
    insert_compact_session(&st, "ses_ledger", Some("prov-a/mdl-x")).await;
    let sink = seed_redoable_record(&st, "ses_ledger").await;
    sink.set_fail_writes(true);
    let mut msg = compact_msg("ses_ledger");
    msg.request_id = Some("ledger-compact".into());
    st.handle_compact(msg).await;
    let frames = frames_until(&mut rx, |frame| is_event(frame, "freshAgent.error", None)).await;
    let frame = frames.last().unwrap();
    assert_eq!(
        frame["event"]["message"],
        crate::rollback_record::LEDGER_WRITE_REFUSAL_COPY
    );
    assert_compact_receipt(frame, Some("ledger-compact"), false);
    assert!(http.summarize_requests().is_empty());
    assert!(sink
        .load_rollback(PROVIDER, "ses_ledger")
        .unwrap()
        .can_redo());
}

#[tokio::test]
async fn compact_post_receipts_report_delivery_uncertainty_and_keep_redo_truth() {
    for (outcome, request_id, uncertain, delivered, diagnostic) in [
        (
            SummarizeOutcome::Undelivered,
            Some("undelivered-compact"),
            false,
            false,
            "connect refused",
        ),
        (
            SummarizeOutcome::MidflightTransport,
            Some("ambiguous-compact"),
            true,
            true,
            "transport error",
        ),
        (
            SummarizeOutcome::Answered500,
            Some("answered-compact"),
            true,
            true,
            "500",
        ),
        (
            SummarizeOutcome::MidflightTransport,
            None,
            true,
            true,
            "transport error",
        ),
    ] {
        let (st, http, mut rx) = compact_state(r#"{"model":null}"#, outcome).await;
        insert_compact_session(&st, "ses_1", Some("prov-a/mdl-x")).await;
        let sink = seed_redoable_record(&st, "ses_1").await;
        let mut msg = compact_msg("ses_1");
        msg.request_id = request_id.map(str::to_owned);
        st.handle_compact(msg).await;
        let frames = frames_until(&mut rx, |frame| is_event(frame, "freshAgent.error", None)).await;
        let frame = frames.last().unwrap();
        assert_eq!(frame["event"]["code"], "OPENCODE_COMPACT_FAILED");
        assert!(
            frame["event"]["message"]
                .as_str()
                .unwrap()
                .contains(diagnostic),
            "{frame}"
        );
        assert_compact_receipt(frame, request_id, uncertain);
        assert_eq!(http.summarize_requests().len(), usize::from(delivered));
        assert!(frames.iter().any(|frame| is_event(
            frame,
            "freshAgent.session.snapshot",
            Some("idle")
        )));
        let record = sink
            .load_rollback(PROVIDER, "ses_1")
            .expect("rollback record");
        assert_eq!(
            record.redo_destroyed, delivered,
            "delivery verdict must preserve redo semantics"
        );
    }
}

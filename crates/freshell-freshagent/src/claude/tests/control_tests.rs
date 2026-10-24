use super::*;

#[tokio::test]
async fn an_unwritten_stop_reports_its_request_and_does_not_suppress_the_turn() {
    let (st, mut rx) = state_with_bus();
    let id = uuid::Uuid::new_v4().to_string();
    insert_fake_claude_session(&st, &id).await;
    let (write, read) = tokio::io::duplex(4096);
    drop(read);
    let ledger = {
        let mut sessions = st.sessions.lock().await;
        let session = sessions.get_mut(&id).unwrap();
        session.stdin = crate::claude_sidecar_io::SidecarWriter::spawn(
            write,
            crate::claude_sidecar_io::SidecarLogLabels::new("broken-stop", "freshclaude", None),
            Duration::from_secs(1),
        )
        .0;
        session.ledger.lock().unwrap().arm(
            "owed-turn".into(),
            None,
            crate::claude_turns::SendKind::Turn,
        );
        session.ledger.clone()
    };
    let request: FreshAgentInterrupt = serde_json::from_value(json!({
        "provider":"claude", "sessionType":"freshclaude", "sessionId":id,
        "requestId":"unwritten-stop",
    }))
    .unwrap();
    st.handle_interrupt(request).await;
    let frame: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
    assert_eq!(frame["event"]["code"], "CLAUDE_INTERRUPT_FAILED", "{frame}");
    assert_eq!(frame["event"]["requestId"], "unwritten-stop", "{frame}");
    assert!(!ledger.lock().unwrap().stop_latched());
    assert!(ledger.lock().unwrap().busy());
    let result = crate::claude_turns::TurnFact::from_line(
        &json!({"type":"sdk.result", "subtype":"success", "isError":false}),
    )
    .unwrap();
    let crate::claude_turns::Folded::Settled(settlement) = ledger.lock().unwrap().fold(&result)
    else {
        panic!("the original turn still settles");
    };
    assert!(settlement.verdict.rings());
    st.shutdown().await;
}

#[tokio::test]
async fn a_delayed_stop_reissue_cannot_interrupt_a_replacement_with_the_same_durable_id() {
    use tokio::io::AsyncReadExt;
    let st = state();
    let id = uuid::Uuid::new_v4().to_string();
    insert_fake_claude_session(&st, &id).await;
    let removed = st.sessions.lock().await.remove(&id).unwrap();
    let old_ownership_id = removed.ownership_id.clone();
    st.teardown_removed_session_logged(removed).await;
    insert_fake_claude_session(&st, &id).await;
    let (write, mut read) = tokio::io::duplex(4096);
    {
        let mut sessions = st.sessions.lock().await;
        let session = sessions.get_mut(&id).unwrap();
        session.ownership_id = "replacement-for-delayed-stop".into();
        assert_ne!(session.ownership_id, old_ownership_id);
        session.stdin = crate::claude_sidecar_io::SidecarWriter::spawn(
            write,
            crate::claude_sidecar_io::SidecarLogLabels::new(
                "replacement-stop",
                "freshclaude",
                None,
            ),
            Duration::from_secs(1),
        )
        .0;
    }
    let reissue = crate::claude_turns::StopReissue {
        stop_id: "obsolete-stop".into(),
        request_id: None,
        reissue_id: "obsolete-stop:1".into(),
        case: crate::claude_turns::ReissueCase::A,
        target: "old-turn".into(),
        reissues: 1,
    };
    st.reissue_stop(&id, &old_ownership_id, &id, "freshclaude", &reissue)
        .await;
    let mut bytes = [0; 4096];
    assert!(
        tokio::time::timeout(Duration::from_millis(25), read.read(&mut bytes))
            .await
            .is_err(),
        "an old reissue wrote an interrupt to the replacement runtime"
    );
    st.shutdown().await;
}

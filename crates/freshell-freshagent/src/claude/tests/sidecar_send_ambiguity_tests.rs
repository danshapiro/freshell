use super::*;
use crate::claude_sidecar_io::{SidecarLogLabels, SidecarWriter};
use std::{
    pin::Pin,
    task::{Context, Poll},
    time::Duration,
};
use tokio::io::AsyncWrite;

struct DeliveredLineWithFailedFlush {
    delivered: Arc<std::sync::Mutex<Vec<u8>>>,
    stalls: bool,
}

impl AsyncWrite for DeliveredLineWithFailedFlush {
    fn poll_write(
        self: Pin<&mut Self>,
        _: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        self.delivered.lock().unwrap().extend_from_slice(bytes);
        Poll::Ready(Ok(bytes.len()))
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        if self.stalls {
            Poll::Pending
        } else {
            Poll::Ready(Err(std::io::Error::other("PRIVATE_FLUSH_DETAIL")))
        }
    }
    fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

#[tokio::test]
async fn a_delivered_send_with_failed_or_stalled_flush_remains_delivery_ambiguous() {
    for stalls in [false, true] {
        let (state, mut frames) = state_with_bus();
        let session_id = "550e8400-e29b-41d4-a716-446655440000";
        insert_fake_claude_session(&state, session_id).await;
        let delivered = Arc::new(std::sync::Mutex::new(Vec::new()));
        let (writer, _fault) = SidecarWriter::spawn(
            DeliveredLineWithFailedFlush {
                delivered: delivered.clone(),
                stalls,
            },
            SidecarLogLabels::new("owned-send", "freshclaude", None),
            Duration::from_millis(30),
        );
        state
            .sessions
            .lock()
            .await
            .get_mut(session_id)
            .unwrap()
            .stdin = writer;
        let mut request = send_msg(session_id, "one message received by the sidecar");
        request.request_id = Some("ambiguous-send".into());
        let outcome = state.handle_send(request).await;
        let bytes = delivered.lock().unwrap().clone();
        assert_eq!(
            bytes.last(),
            Some(&b'\n'),
            "the full frame reached the sidecar before flush failed"
        );
        let sent: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(sent["text"], "one message received by the sidecar");
        assert!(
            !matches!(outcome, ClaudeSendOutcome::Refused { .. }),
            "a delivered line cannot be refused: {outcome:?}"
        );
        let messages: Vec<Value> = std::iter::from_fn(|| frames.try_recv().ok())
            .map(|raw| serde_json::from_str(&raw).unwrap())
            .collect();
        let error = messages
            .iter()
            .find(|frame| {
                frame["type"] == "freshAgent.event"
                    && frame["sessionId"] == session_id
                    && frame["event"]["type"] == "freshAgent.send.uncertain"
                    && frame["event"]["requestId"] == "ambiguous-send"
            })
            .expect("the requester must receive an uncertainty warning");
        assert!(
            error["event"]["message"]
                .as_str()
                .unwrap()
                .starts_with("FRESH_AGENT_DELIVERY_AMBIGUOUS:"),
            "{error}"
        );
        assert!(!error.to_string().contains("PRIVATE_FLUSH_DETAIL"));
        assert!(
            state.session_busy(session_id).await.unwrap(),
            "the uncertain send remains reserved"
        );
    }
}

#[tokio::test]
async fn a_writer_closed_before_submission_is_a_definite_refusal() {
    let (state, mut frames) = state_with_bus();
    let session_id = "550e8400-e29b-41d4-a716-446655440001";
    insert_fake_claude_session(&state, session_id).await;
    let (stdin, _reader) = tokio::io::duplex(4096);
    let (writer, _fault) = SidecarWriter::spawn(
        stdin,
        SidecarLogLabels::new("closed-send", "freshclaude", None),
        Duration::from_secs(1),
    );
    writer
        .shutdown(tokio::time::Instant::now() + Duration::from_millis(100))
        .await;
    state
        .sessions
        .lock()
        .await
        .get_mut(session_id)
        .unwrap()
        .stdin = writer;
    let mut request = send_msg(session_id, "not submitted");
    request.request_id = Some("closed-before-send".into());
    let outcome = state.handle_send(request).await;
    assert!(
        matches!(outcome, ClaudeSendOutcome::Refused { .. }),
        "{outcome:?}"
    );
    assert!(!state.session_busy(session_id).await.unwrap());
    let messages: Vec<Value> = std::iter::from_fn(|| frames.try_recv().ok())
        .map(|raw| serde_json::from_str(&raw).unwrap())
        .collect();
    assert!(messages
        .iter()
        .any(|frame| frame["type"] == "error" && frame["requestId"] == "closed-before-send"));
    assert!(!messages
        .iter()
        .any(|frame| frame["event"]["type"] == "freshAgent.send.uncertain"));
}

#[tokio::test]
async fn direct_rest_send_keeps_delivery_ambiguous_and_returns_its_correlation() {
    use crate::rest_lane::{FreshAgentRestLane, RestLaneErrorKind, RestLaneSend};

    let (state, _frames) = state_with_bus();
    let session_id = "550e8400-e29b-41d4-a716-446655440002";
    insert_fake_claude_session(&state, session_id).await;
    let bytes = Arc::new(std::sync::Mutex::new(Vec::new()));
    let (writer, _fault) = SidecarWriter::spawn(
        DeliveredLineWithFailedFlush {
            delivered: bytes.clone(),
            stalls: false,
        },
        SidecarLogLabels::new("rest-send", "freshclaude", None),
        Duration::from_secs(1),
    );
    state
        .sessions
        .lock()
        .await
        .get_mut(session_id)
        .unwrap()
        .stdin = writer;
    let lane = crate::claude_rest_lane::ClaudeRestLane::new(state.clone(), Arc::new(|| true));
    let result = lane
        .send_agent(RestLaneSend {
            request_id: "ambiguous-rest-send".into(),
            session_id: session_id.into(),
            provider: "claude".into(),
            session_type: "freshclaude".into(),
            text: "delivered before flush".into(),
            timeout_ms: 1_000,
            observed_epoch: None,
            observed_generation: None,
        })
        .await
        .expect_err("a possibly delivered send must not be reported as accepted or refused");
    assert_eq!(bytes.lock().unwrap().last(), Some(&b'\n'));
    assert_eq!(result.kind, RestLaneErrorKind::Conflict);
    assert_eq!(result.code, "FRESH_AGENT_DELIVERY_AMBIGUOUS");
    assert_eq!(result.retryable, Some(false));
    assert!(!result.message.contains("PRIVATE_FLUSH_DETAIL"));
    let correlation = result
        .correlation
        .expect("a caller needs the exact send identity");
    assert_eq!(correlation.session_id.as_deref(), Some(session_id));
    assert_eq!(
        correlation.request_id.as_deref(),
        Some("ambiguous-rest-send")
    );
    assert!(correlation.submitted_turn_id.is_some());
    assert!(state.session_busy(session_id).await.unwrap());
}

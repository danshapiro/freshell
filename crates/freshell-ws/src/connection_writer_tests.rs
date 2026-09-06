use super::*;
use futures_util::task::AtomicWaker;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Default)]
struct Capture {
    frames: Mutex<Vec<Message>>,
    block_flush: AtomicBool,
    fail: AtomicBool,
    waker: AtomicWaker,
    started: Notify,
}

struct TestSink(Arc<Capture>);
impl Sink<Message> for TestSink {
    type Error = ();
    fn poll_ready(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), ()>> {
        Poll::Ready(Ok(()))
    }
    fn start_send(self: Pin<&mut Self>, frame: Message) -> Result<(), ()> {
        self.0.frames.lock().unwrap().push(frame);
        self.0.started.notify_one();
        Ok(())
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), ()>> {
        self.0.waker.register(cx.waker());
        if self.0.fail.load(Ordering::SeqCst) {
            Poll::Ready(Err(()))
        } else if self.0.block_flush.load(Ordering::SeqCst) {
            Poll::Pending
        } else {
            Poll::Ready(Ok(()))
        }
    }
    fn poll_close(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), ()>> {
        self.poll_flush(cx)
    }
}

fn output(seq: i64) -> ServerMessage {
    ServerMessage::TerminalOutput(freshell_protocol::TerminalOutput {
        terminal_id: "term".into(),
        stream_id: "stream".into(),
        attach_request_id: Some("attach".into()),
        seq_start: seq,
        seq_end: seq,
        data: format!("data-{seq}"),
        source: None,
    })
}
fn notice(text: &str) -> Message {
    Message::Text(text.to_string().into())
}
fn leased_text(frame: &Message) -> String {
    match frame {
        Message::Text(text) => text.to_string(),
        other => format!("{other:?}"),
    }
}

fn text_frames(capture: &Capture) -> Vec<String> {
    capture
        .frames
        .lock()
        .unwrap()
        .iter()
        .filter_map(|frame| {
            if let Message::Text(text) = frame {
                Some(text.to_string())
            } else {
                None
            }
        })
        .collect()
}
async fn started(capture: &Capture) {
    tokio::time::timeout(Duration::from_secs(2), capture.started.notified())
        .await
        .unwrap();
}
fn unblock(capture: &Capture) {
    capture.block_flush.store(false, Ordering::SeqCst);
    capture.waker.wake();
}
async fn join(task: tokio::task::JoinHandle<WriterExit>) -> WriterExit {
    tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn blocked_flush_does_not_block_producers_and_is_still_accounted() {
    let (mut sender, pump) = WriterSender::new(4096, 4096, Duration::from_secs(10));
    let capture = Arc::new(Capture::default());
    capture.block_flush.store(true, Ordering::SeqCst);
    let msg = output(1);
    let bytes = serde_json::to_string(&msg).unwrap().len();
    assert!(sender.push_server(msg));
    let task = tokio::spawn(pump.run(TestSink(Arc::clone(&capture))));
    started(&capture).await;
    assert_eq!(sender.pending_output_bytes(), bytes);
    // This uses the same nonblocking Sink interface the reader's handlers use.
    tokio::time::timeout(Duration::from_secs(2), sender.send(notice("control")))
        .await
        .unwrap()
        .unwrap();
    assert!(sender.push_server(output(2)));
    assert!(sender.pending_output_bytes() > bytes);
    sender.stop_without_close();
    assert_eq!(join(task).await, WriterExit::Stopped);
    assert_eq!(
        text_frames(&capture).len(),
        1,
        "cancelled send is never retried"
    );
    assert_eq!(sender.pending_output_bytes(), 0);
    assert!(
        !sender.push_server(output(3)),
        "no orphan outbox after exit"
    );
}

#[tokio::test]
async fn controls_preempt_the_next_frame_not_the_inflight_frame() {
    let (mut sender, pump) = WriterSender::new(4096, 4096, Duration::from_secs(10));
    let capture = Arc::new(Capture::default());
    capture.block_flush.store(true, Ordering::SeqCst);
    assert!(sender.push_server(output(1)));
    assert!(sender.push_server(output(2)));
    let task = tokio::spawn(pump.run(TestSink(Arc::clone(&capture))));
    started(&capture).await;
    sender.send(notice("urgent")).await.unwrap();
    unblock(&capture);
    // A ping receipt is a deterministic fence behind the urgent control.
    let receipt = sender.queue_ping().unwrap();
    tokio::time::timeout(Duration::from_secs(2), receipt)
        .await
        .unwrap()
        .unwrap();
    let frames = text_frames(&capture);
    assert!(frames[0].contains("data-1"));
    assert_eq!(frames[1], "urgent");
    sender.stop_without_close();
    let _ = join(task).await;
}

#[tokio::test]
async fn preludes_always_precede_replay_and_exit_follows_output() {
    let (mut sender, pump) = WriterSender::new(4096, 4096, Duration::from_secs(10));
    sender.send(notice("ready")).await.unwrap();
    sender.send(notice("modes")).await.unwrap();
    sender.push_server(output(1));
    sender.push_server(output(2));
    sender.push_server(ServerMessage::TerminalExit(
        freshell_protocol::TerminalExit {
            terminal_id: "term".into(),
            exit_code: 0,
        },
    ));
    // Drive the exact queue selection used by the pump; no timing assumptions.
    let mut frames = Vec::new();
    while let Some(next) = pump.take_next().unwrap() {
        if matches!(&next.frame, Message::Text(_)) {
            frames.push(leased_text(&next.frame));
        }
        pump.finish_frame(next.output_bytes, next.control_bytes);
    }
    assert_eq!(frames[0], "ready");
    assert_eq!(frames[1], "modes");
    assert!(frames[2].contains("data-1"));
    assert!(frames[3].contains("data-2"));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&frames[4]).unwrap()["type"],
        "terminal.exit"
    );
}

#[tokio::test]
async fn control_budget_includes_inflight_entries_and_zero_byte_messages() {
    let (mut sender, pump) = WriterSender::new(4096, 256, Duration::from_secs(10));
    sender.send(Message::Ping(Vec::new().into())).await.unwrap();
    let next = pump.take_next().unwrap().unwrap();
    assert_eq!(next.control_bytes, 128);
    sender.send(Message::Ping(Vec::new().into())).await.unwrap();
    assert_eq!(
        sender.send(Message::Ping(Vec::new().into())).await,
        Err(WriterExit::ControlOverflow)
    );
    assert!(pump.stop.borrow().is_some());
}

#[tokio::test]
async fn unanswered_ping_times_out_at_the_next_tick() {
    let (sender, pump) = WriterSender::new(4096, 4096, Duration::from_secs(10));
    let mut keepalive = Keepalive::default();
    keepalive.tick(&sender).unwrap();
    // The common case: the idle writer flushes the ping a hair after its
    // tick. Detection still lands at the NEXT tick boundary — deadlines are
    // cycle-counted, so a late flush never slides detection a full cycle.
    let next = pump.take_next().unwrap().unwrap();
    next.flushed.unwrap().send(()).unwrap();
    pump.finish_frame(next.output_bytes, next.control_bytes);
    assert_eq!(keepalive.tick(&sender), Err(KeepaliveError::TimedOut));
}

#[tokio::test]
async fn an_unflushed_ping_also_times_out_at_the_next_tick() {
    let (sender, _pump) = WriterSender::new(4096, 4096, Duration::from_secs(10));
    let mut keepalive = Keepalive::default();
    keepalive.tick(&sender).unwrap();
    // Controls preempt output, so a ping still unflushed when the next tick
    // fires means the socket could not emit a single control frame all
    // cycle: wedged (the writer's per-send stall is a separate, wider bound).
    assert_eq!(keepalive.tick(&sender), Err(KeepaliveError::TimedOut));
}

#[tokio::test]
async fn answered_ping_retires_and_the_next_tick_queues_a_fresh_one() {
    let (sender, pump) = WriterSender::new(4096, 4096, Duration::from_secs(10));
    let mut keepalive = Keepalive::default();
    keepalive.tick(&sender).unwrap();
    let next = pump.take_next().unwrap().unwrap();
    // Pong observed BEFORE the flush receipt is processed still answers the
    // ping (a pong carries no cookie; ordering with the receipt is the
    // transport's business).
    keepalive.observe_pong();
    next.flushed.unwrap().send(()).unwrap();
    pump.finish_frame(next.output_bytes, next.control_bytes);
    keepalive.tick(&sender).unwrap();
    // Healthy cadence: exactly one fresh ping queued for the new cycle.
    let next = pump.take_next().unwrap().unwrap();
    assert!(next.flushed.is_some());
    assert!(pump.take_next().unwrap().is_none());
    // The new ping's deadline is armed for this same one-cycle rule.
    assert_eq!(keepalive.tick(&sender), Err(KeepaliveError::TimedOut));
}

#[tokio::test]
async fn a_pong_before_any_ping_grants_no_exemption() {
    let (sender, _pump) = WriterSender::new(4096, 4096, Duration::from_secs(10));
    let mut keepalive = Keepalive::default();
    keepalive.observe_pong();
    keepalive.tick(&sender).unwrap();
    // The stray pong was consumed by queueing; the ping it could not have
    // answered still needs its own pong within one cycle.
    assert_eq!(keepalive.tick(&sender), Err(KeepaliveError::TimedOut));
}

#[tokio::test]
async fn a_lost_flush_receipt_reports_the_writer_as_gone() {
    let (sender, pump) = WriterSender::new(4096, 4096, Duration::from_secs(10));
    let mut keepalive = Keepalive::default();
    keepalive.tick(&sender).unwrap();
    // Pump teardown drops the queued ping's receipt sender unanswered.
    drop(pump);
    assert_eq!(
        keepalive.tick(&sender),
        Err(KeepaliveError::Writer(WriterExit::Stopped))
    );
}

#[tokio::test]
async fn saturated_streak_never_reorders_a_prelude_behind_its_replay() {
    let (mut sender, pump) = WriterSender::new(1 << 20, 1 << 20, Duration::from_secs(10));
    // One strictly-older output frame (e.g. another terminal's live stream)
    // predates everything below; leapfrogging IT is exactly what the
    // fairness rule exists for.
    assert!(sender.push_server(output(100)));
    // Saturate the streak at the limit, as an idle connection's keepalive
    // pings would.
    for i in 0..CONTROL_STREAK_LIMIT {
        sender.send(notice(&format!("k{i}"))).await.unwrap();
    }
    for _ in 0..CONTROL_STREAK_LIMIT {
        let next = pump.take_next().unwrap().unwrap();
        assert!(matches!(next.frame, Message::Text(_)));
        pump.finish_frame(next.output_bytes, next.control_bytes);
    }
    // The attach prelude then replay, admitted in that order under one lock.
    let ready: ServerMessage = serde_json::from_value(serde_json::json!({
        "type":"terminal.attach.ready", "terminalId":"term", "attachRequestId":"a2",
        "streamId":"stream", "headSeq":1, "replayFromSeq":1, "replayToSeq":2
    }))
    .unwrap();
    assert!(sender.push_server(ready));
    assert!(sender.push_server(ServerMessage::TerminalModesSync(
        freshell_protocol::TerminalModesSync {
            attach_request_id: "a2".into(),
            data: "\u{1b}[?1003h".into(),
            stream_id: "stream".into(),
            terminal_id: "term".into(),
        }
    )));
    assert!(sender.push_server(output(1)));
    assert!(sender.push_server(output(2)));
    let mut kinds = Vec::new();
    while let Some(next) = pump.take_next().unwrap() {
        let value: serde_json::Value = serde_json::from_str(&leased_text(&next.frame)).unwrap();
        kinds.push(value["type"].as_str().unwrap().to_string());
        pump.finish_frame(next.output_bytes, next.control_bytes);
    }
    let pos = |kind: &str| kinds.iter().position(|k| k == kind).unwrap();
    let ready_at = pos("terminal.attach.ready");
    let sync_at = pos("terminal.modes.sync");
    assert!(
        ready_at < sync_at,
        "modes.sync must never precede its attach.ready: {kinds:?}"
    );
    let first_replay = kinds
        .iter()
        .enumerate()
        .filter(|(_, k)| **k == "terminal.output")
        .map(|(i, _)| i)
        // output(100) is the stale frame; the attach's replay starts after it.
        .nth(1)
        .unwrap();
    assert!(
        sync_at < first_replay,
        "modes.sync must precede its attach's replay: {kinds:?}"
    );
}

#[tokio::test]
async fn controls_cannot_starve_output_indefinitely() {
    let (mut sender, pump) = WriterSender::new(1 << 20, 1 << 20, Duration::from_secs(10));
    for seq in 0..16 {
        assert!(sender.push_server(output(seq)));
    }
    for _ in 0..16 {
        sender.send(notice("c")).await.unwrap();
    }
    let mut order = Vec::new();
    while let Some(next) = pump.take_next().unwrap() {
        order.push(leased_text(&next.frame));
        pump.finish_frame(next.output_bytes, next.control_bytes);
    }
    let outputs: Vec<usize> = order
        .iter()
        .enumerate()
        .filter_map(|(i, frame)| frame.contains("data-").then_some(i))
        .collect();
    assert_eq!(outputs.len(), 16, "every output frame must be delivered");
    assert!(
        outputs[0] <= CONTROL_STREAK_LIMIT,
        "first output must arrive within the streak limit, got position {}",
        outputs[0]
    );
}

#[tokio::test(start_paused = true)]
async fn stalled_socket_times_out_and_closes_admission() {
    let (sender, pump) = WriterSender::new(4096, 4096, Duration::from_millis(20));
    let capture = Arc::new(Capture::default());
    capture.block_flush.store(true, Ordering::SeqCst);
    sender.push_server(output(1));
    let task = tokio::spawn(pump.run(TestSink(Arc::clone(&capture))));
    assert_eq!(join(task).await, WriterExit::SendTimedOut);
    assert_eq!(text_frames(&capture).len(), 1);
    assert!(!sender.push_server(output(2)));
}

#[tokio::test]
async fn socket_failure_does_not_retry_or_keep_buffering() {
    let (sender, pump) = WriterSender::new(4096, 4096, Duration::from_secs(10));
    let capture = Arc::new(Capture::default());
    capture.fail.store(true, Ordering::SeqCst);
    sender.push_server(output(1));
    assert_eq!(
        join(tokio::spawn(pump.run(TestSink(Arc::clone(&capture))))).await,
        WriterExit::SendFailed
    );
    assert_eq!(text_frames(&capture).len(), 1);
    assert!(!sender.push_server(output(2)));
}

#[tokio::test]
async fn idle_close_preserves_the_requested_close_code() {
    let (mut sender, pump) = WriterSender::new(4096, 4096, Duration::from_secs(10));
    let capture = Arc::new(Capture::default());
    sender
        .send(Message::Close(Some(CloseFrame {
            code: 4009,
            reason: "Server shutting down".into(),
        })))
        .await
        .unwrap();
    let _ = join(tokio::spawn(pump.run(TestSink(Arc::clone(&capture))))).await;
    let frames = capture.frames.lock().unwrap();
    assert!(matches!(&frames[0], Message::Close(Some(close)) if close.code == 4009));
}

#[tokio::test]
async fn aborting_the_writer_releases_queued_memory_and_rejects_stale_sinks() {
    let (sender, pump) = WriterSender::new(4096, 4096, Duration::from_secs(10));
    let capture = Arc::new(Capture::default());
    capture.block_flush.store(true, Ordering::SeqCst);
    sender.push_server(output(1));
    let task = tokio::spawn(pump.run(TestSink(Arc::clone(&capture))));
    started(&capture).await;
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert_eq!(sender.pending_output_bytes(), 0);
    assert!(!sender.push_server(output(2)));
}

#[tokio::test]
async fn superseding_attach_discards_old_queued_output_and_old_exit() {
    let (sender, pump) = WriterSender::new(4096, 4096, Duration::from_secs(10));
    sender.push_server(output(1));
    sender.push_server(ServerMessage::TerminalExit(
        freshell_protocol::TerminalExit {
            terminal_id: "term".into(),
            exit_code: 0,
        },
    ));
    let ready: ServerMessage = serde_json::from_value(serde_json::json!({
        "type":"terminal.attach.ready", "terminalId":"term", "attachRequestId":"new-attach",
        "streamId":"stream", "headSeq":1, "replayFromSeq":1, "replayToSeq":1
    }))
    .unwrap();
    sender.push_server(ready);
    let mut replay = output(1);
    if let ServerMessage::TerminalOutput(frame) = &mut replay {
        frame.attach_request_id = Some("new-attach".into());
    }
    sender.push_server(replay);
    sender.push_server(ServerMessage::TerminalExit(
        freshell_protocol::TerminalExit {
            terminal_id: "term".into(),
            exit_code: 0,
        },
    ));
    let mut kinds = Vec::new();
    while let Some(next) = pump.take_next().unwrap() {
        let value: serde_json::Value = serde_json::from_str(&leased_text(&next.frame)).unwrap();
        kinds.push(value["type"].as_str().unwrap().to_string());
        if value["type"] == "terminal.output" {
            assert_eq!(value["attachRequestId"], "new-attach");
        }
        pump.finish_frame(next.output_bytes, next.control_bytes);
    }
    assert_eq!(
        kinds,
        vec!["terminal.attach.ready", "terminal.output", "terminal.exit"]
    );
}

#[tokio::test]
async fn overflow_stops_a_pending_flush_without_waiting_for_send_timeout() {
    let (mut sender, pump) = WriterSender::new(4096, 128, Duration::from_secs(10));
    let capture = Arc::new(Capture::default());
    capture.block_flush.store(true, Ordering::SeqCst);
    sender.push_server(output(1));
    let task = tokio::spawn(pump.run(TestSink(Arc::clone(&capture))));
    started(&capture).await;
    // An empty lane always admits ONE frame, even an oversize one (a single
    // large legitimate control must not close an otherwise idle connection).
    sender.send(notice("over-budget-but-first")).await.unwrap();
    // Continued flooding while that frame is still in flight overflows
    // loudly — without waiting for the per-send timeout.
    assert_eq!(
        sender.send(notice("over-budget")).await,
        Err(WriterExit::ControlOverflow)
    );
    assert_eq!(join(task).await, WriterExit::ControlOverflow);
    assert_eq!(text_frames(&capture).len(), 1);
}

fn named_output(terminal_id: &str, seq: i64) -> ServerMessage {
    let mut message = output(seq);
    if let ServerMessage::TerminalOutput(frame) = &mut message {
        frame.terminal_id = terminal_id.to_string();
    }
    message
}
fn interest(
    revision: u64,
    focused: Option<&str>,
    visible: &[&str],
) -> freshell_protocol::client_messages::TerminalInterest {
    freshell_protocol::client_messages::TerminalInterest {
        revision,
        focused_terminal_id: focused.map(str::to_string),
        visible_terminal_ids: visible.iter().map(|s| s.to_string()).collect(),
    }
}
fn taken_terminal(pump: &WriterPump) -> String {
    let next = pump.take_next().unwrap().unwrap();
    let id = if let Message::Text(text) = &next.frame {
        serde_json::from_str::<serde_json::Value>(text).unwrap()["terminalId"]
            .as_str()
            .unwrap()
            .to_string()
    } else {
        panic!("expected output")
    };
    pump.finish_frame(next.output_bytes, next.control_bytes);
    id
}

#[tokio::test]
async fn fresh_interest_reprioritizes_queued_output_without_an_attach() {
    let (sender, pump) = WriterSender::new(100_000, 4096, Duration::from_secs(10));
    sender.enable_terminal_interest();
    sender
        .set_terminal_interest(&interest(1, Some("a"), &["a"]))
        .unwrap();
    for seq in 0..10 {
        sender.push_server(named_output("a", seq));
        sender.push_server(named_output("b", seq));
    }
    sender
        .set_terminal_interest(&interest(2, Some("b"), &["b"]))
        .unwrap();
    assert_eq!(taken_terminal(&pump), "b");
}

#[tokio::test]
async fn stale_interest_does_not_undo_new_focus() {
    let (sender, pump) = WriterSender::new(100_000, 4096, Duration::from_secs(10));
    sender.enable_terminal_interest();
    sender
        .set_terminal_interest(&interest(2, Some("b"), &["b"]))
        .unwrap();
    sender
        .set_terminal_interest(&interest(1, Some("a"), &["a"]))
        .unwrap();
    sender.push_server(named_output("a", 1));
    sender.push_server(named_output("b", 1));
    assert_eq!(taken_terminal(&pump), "b");
}

#[tokio::test]
async fn focus_does_not_cancel_the_inflight_frame_or_lose_following_bytes() {
    let (sender, pump) = WriterSender::new(100_000, 4096, Duration::from_secs(10));
    sender.enable_terminal_interest();
    sender
        .set_terminal_interest(&interest(1, Some("a"), &["a"]))
        .unwrap();
    sender.push_server(named_output("a", 1));
    sender.push_server(named_output("a", 2));
    sender.push_server(named_output("b", 1));
    let active = pump.take_next().unwrap().unwrap();
    let before = sender.pending_output_bytes();
    sender
        .set_terminal_interest(&interest(2, Some("b"), &["b"]))
        .unwrap();
    assert_eq!(sender.pending_output_bytes(), before);
    pump.finish_frame(active.output_bytes, active.control_bytes);
    assert_eq!(taken_terminal(&pump), "b");
    assert_eq!(taken_terminal(&pump), "a");
    assert_eq!(sender.pending_output_bytes(), 0);
}

#[tokio::test]
async fn attach_priority_works_for_clients_without_interest_capability() {
    let (sender, pump) = WriterSender::new(100_000, 4096, Duration::from_secs(10));
    sender.set_attachment_priority("background", true);
    sender.set_attachment_priority("visible", false);
    sender.push_server(named_output("background", 1));
    sender.push_server(named_output("visible", 1));
    assert_eq!(taken_terminal(&pump), "visible");
}

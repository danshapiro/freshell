use super::*;
use futures_util::task::AtomicWaker;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

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

/// The paced drain's admission reservation (responsive-terminal-restore
/// W1, round-5): while the connection's output backlog cannot absorb a
/// page of `bytes` at/under the watermark, the reservation PENDS — the
/// sink itself (`push_server`) admits without yielding, so this gate is
/// what bounds a producing drain by the connection queue's REAL
/// consumption. The reservation grants only when the writer pump has
/// completed actual frame sends and the published backlog leaves room
/// for the page (backlog + reservation + page <= watermark).
#[tokio::test]
async fn drain_admission_waits_for_real_queue_consumption() {
    let (sender, pump) = WriterSender::new(4096, 4096, Duration::from_secs(10));
    let capture = Arc::new(Capture::default());
    capture.block_flush.store(true, Ordering::SeqCst);
    // Fill past the watermark (output_limit/2 = 2048 bytes): a blocked
    // in-flight frame plus enough queued pages.
    for seq in 1..=24 {
        assert!(sender.push_server(output(seq)));
    }
    let task = tokio::spawn(pump.run(TestSink(Arc::clone(&capture))));
    started(&capture).await;
    assert!(
        sender.pending_output_bytes() >= sender.backlog_watermark(),
        "the fixture holds the backlog at/above the watermark (pending {})",
        sender.pending_output_bytes()
    );
    let permit = sender.reserve_drain_admission(1024);
    tokio::pin!(permit);
    // The reservation is CLOSED: it must not resolve while the backlog
    // cannot absorb the page.
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut permit)
            .await
            .is_err(),
        "the reservation stays closed while the backlog cannot absorb the page"
    );
    {
        let queues = sender.shared.queues.lock().unwrap();
        assert_eq!(queues.drain_reserved, 0, "nothing was reserved yet");
    }
    // REAL consumption releases it: the in-flight frame's flush completes
    // and `finish_frame` publishes the drained backlog.
    unblock(&capture);
    let permit = tokio::time::timeout(Duration::from_secs(2), permit)
        .await
        .expect("the reservation grants when the pump drains real frames");
    {
        let queues = sender.shared.queues.lock().unwrap();
        assert_eq!(
            queues.drain_reserved, 1024,
            "the granted permit holds its bytes"
        );
    }
    drop(permit);
    {
        let queues = sender.shared.queues.lock().unwrap();
        assert_eq!(
            queues.drain_reserved, 0,
            "dropping the permit releases the reservation"
        );
    }
    sender.stop_without_close();
    let _ = join(task).await;
}

/// Round-5 finding 1 (degenerate settings): a drain page LARGER than the
/// admission watermark (a queue/page relationship the boot clamp exists
/// to prevent — injected directly here) must still admit once the queue
/// fully drains: the reservation gate can never DEADLOCK, whatever the
/// budget. The oversize page admits into a fully drained queue only.
#[tokio::test]
async fn an_oversize_drain_page_admits_into_a_fully_drained_queue() {
    let (sender, pump) = WriterSender::new(64 * 1024, 4096, Duration::from_secs(10));
    // The degenerate shape: the 64 KiB minimum queue (watermark 32 KiB)
    // against the default-sized 128 KiB page budget.
    assert_eq!(sender.backlog_watermark(), 32 * 1024);
    let capture = Arc::new(Capture::default());
    capture.block_flush.store(true, Ordering::SeqCst);
    assert!(sender.push_server(output(1)));
    let task = tokio::spawn(pump.run(TestSink(Arc::clone(&capture))));
    started(&capture).await;
    // The oversize reservation pends while ANY backlog stands (the
    // in-flight frame alone blocks it): grantable only into a fully
    // drained queue.
    let permit = sender.reserve_drain_admission(128 * 1024);
    tokio::pin!(permit);
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut permit)
            .await
            .is_err(),
        "the oversize reservation waits for a fully drained queue"
    );
    unblock(&capture);
    let permit = tokio::time::timeout(Duration::from_secs(2), permit)
        .await
        .expect("the oversize page admits once the queue is fully drained — no deadlock");
    drop(permit);
    sender.stop_without_close();
    let _ = join(task).await;
}

/// Round-2 finding F5: releasing a [`DrainAdmission`] must WAKE the tasks
/// waiting on the backlog watch channel — a drain that consumed the
/// available reservation and completed WITHOUT admitting (a `CaughtUp` or
/// `Gone` verdict: a retention gap instead of a page, a cancelled session)
/// frees admission capacity, and a concurrently gated drain must
/// re-evaluate immediately rather than sleeping until an unrelated socket
/// send or keepalive publishes the backlog. At the supported 64 KiB queue
/// floor two 32 KiB drains are exactly this shape (watermark 32 KiB, the
/// floor's clamped page budget 32 KiB): drain A holds the whole watermark;
/// drain B is gated; A completes without admitting.
///
/// Bounded-assert discipline: the wake is observed VIA THE CHANNEL/state —
/// the reservation resolves without a single completed socket send (the
/// pump is never run), so the only possible waker is the release itself.
#[tokio::test]
async fn drain_admission_release_wakes_a_gated_drain_without_a_socket_send() {
    let (sender, _pump) = WriterSender::new(64 * 1024, 4096, Duration::from_secs(10));
    assert_eq!(
        sender.backlog_watermark(),
        32 * 1024,
        "the reviewer's 64 KiB queue-floor shape"
    );
    // Drain A consumes the whole watermark's reservation.
    let permit_a = sender
        .reserve_drain_admission(32 * 1024)
        .await
        .expect("drain A reserves against an empty queue");
    {
        let queues = sender.shared.queues.lock().unwrap();
        assert_eq!(queues.drain_reserved, 32 * 1024);
    }
    // Drain B gates: A's reservation leaves no room for a second page.
    let permit_b = sender.reserve_drain_admission(32 * 1024);
    tokio::pin!(permit_b);
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut permit_b)
            .await
            .is_err(),
        "drain B stays gated while drain A holds the reservation"
    );
    // Drain A completes WITHOUT admitting anything (the CaughtUp/Gone
    // shape: no page was built, no frame was sent): its release alone must
    // free and PUBLISH the capacity.
    drop(permit_a);
    let permit_b = tokio::time::timeout(Duration::from_secs(2), permit_b)
        .await
        .expect("the release alone wakes the gated drain — no socket send required")
        .expect("the writer is alive");
    {
        let queues = sender.shared.queues.lock().unwrap();
        assert_eq!(
            queues.drain_reserved,
            32 * 1024,
            "drain B now holds the released capacity"
        );
    }
    assert_eq!(
        sender.completed_sends(),
        0,
        "no socket send ever happened: the wake came from the reservation release"
    );
    drop(permit_b);
}

/// Round-5 finding 1 (Major), the reviewer's exact scenario: MULTIPLE pane
/// drains awakened together against a JUST-UNDER-WATERMARK backlog with
/// FULL-SIZE pages. The drain admission gate must account for the page it
/// is about to admit AND reserve admission capacity atomically, so
/// concurrent pane drains can never double-book the watermark. Observed
/// end state: ZERO queue_overflow evictions and the admitted aggregate
/// never exceeding the watermark + one page.
///
/// The reviewer's numbers: the supported 256 KiB queue cap, the default
/// 128 KiB paced page budget (watermark = 128 KiB).
#[tokio::test]
async fn concurrent_full_size_drain_admissions_never_self_spill_the_queue() {
    let events = crate::invariants::capture::capture();
    let (sender, pump) = WriterSender::new(256 * 1024, 4096, Duration::from_secs(10));
    let capture = Arc::new(Capture::default());
    capture.block_flush.store(true, Ordering::SeqCst);
    let watermark = sender.backlog_watermark();
    assert_eq!(watermark, 128 * 1024, "the reviewer's 256 KiB queue shape");

    // One FULL-SIZE paced page: a single output frame whose serialized
    // size sits just under the default 128 KiB page budget.
    let page = |terminal_id: &'static str, seq: i64| {
        let mut message = output(seq);
        if let ServerMessage::TerminalOutput(frame) = &mut message {
            frame.terminal_id = terminal_id.to_string();
            frame.data = "P".repeat(128 * 1024 - 256);
        }
        message
    };
    let page_bytes = serde_json::to_string(&page("drain-admit-probe", 1))
        .unwrap()
        .len();
    assert!(
        page_bytes < 128 * 1024,
        "the fixture's page is a realistic full-size page (serialized {page_bytes})"
    );

    // Fill the backlog to JUST UNDER the watermark (the reviewer's
    // "just-under-watermark" wake state) with the socket blocked.
    let mut seq = 0;
    while sender.pending_output_bytes() < watermark - 2048 {
        seq += 1;
        assert!(sender.push_server(named_output("drain-admit-fill", seq)));
    }
    let task = tokio::spawn(pump.run(TestSink(Arc::clone(&capture))));
    started(&capture).await;
    let backlog_at_wake = sender.pending_output_bytes();
    assert!(
        backlog_at_wake < watermark,
        "the fixture wakes the drains just under the watermark ({backlog_at_wake})"
    );
    let spill_count = || {
        events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| {
                e.message.contains("queue_overflow_spill")
                    && e.fields
                        .get("terminal_id")
                        .is_some_and(|id| id.starts_with("drain-admit"))
            })
            .count()
    };
    assert_eq!(spill_count(), 0, "no spill before the drains wake");

    // THE CONCURRENT WAKE: three pane drains reserve their full-size page
    // admissions together against the just-under-watermark backlog. The
    // reserve-then-admit gate must grant NONE of them while the backlog
    // stands (each reservation accounts for its own page — the page can
    // no longer ride on top of the backlog unaccounted).
    let max_observed = Arc::new(AtomicUsize::new(0));
    let mut drains = Vec::new();
    for (drain, terminal_id) in ["drain-admit-a", "drain-admit-b", "drain-admit-c"]
        .into_iter()
        .enumerate()
    {
        let sender = sender.clone();
        let max_observed = Arc::clone(&max_observed);
        drains.push(tokio::spawn(async move {
            let permit = sender
                .reserve_drain_admission(page_bytes)
                .await
                .expect("the writer is alive");
            assert!(sender.push_server(page(terminal_id, 1 + drain as i64)));
            let observed = sender.pending_output_bytes();
            max_observed.fetch_max(observed, Ordering::SeqCst);
            drop(permit);
        }));
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    {
        let queues = sender.shared.queues.lock().unwrap();
        assert_eq!(
            queues.drain_reserved, 0,
            "no reservation is granted against a backlog the page cannot join \
             without crossing the watermark"
        );
    }
    assert_eq!(
        spill_count(),
        0,
        "no page was admitted while the backlog stood (the socket is blocked)"
    );
    assert_eq!(
        max_observed.load(Ordering::SeqCst),
        0,
        "no drain admitted anything before the queue drained"
    );

    // REAL consumption releases the admissions: the pump drains the
    // backlog, the reservations grant, and every drain completes its page.
    unblock(&capture);
    for drain in drains {
        tokio::time::timeout(Duration::from_secs(5), drain)
            .await
            .expect("each reserved drain completes")
            .unwrap();
    }

    // THE BOUND: zero drain-induced queue_overflow evictions, and the
    // admitted aggregate never exceeded the watermark + one page.
    let observed = max_observed.load(Ordering::SeqCst);
    assert_eq!(
        spill_count(),
        0,
        "THE BOUND: concurrent pane drains must never evict the connection's own pages \
         (observed aggregate {observed}B vs watermark {watermark}B + one page {page_bytes}B)"
    );
    assert!(
        observed <= watermark + page_bytes,
        "THE BOUND: the admitted aggregate ({observed}) must never exceed the watermark \
         ({watermark}) + one page ({page_bytes})",
    );
    {
        let queues = sender.shared.queues.lock().unwrap();
        assert_eq!(
            queues.drain_reserved, 0,
            "every reservation was released after its page became real backlog"
        );
    }

    sender.stop_without_close();
    let _ = join(task).await;
}

/// E2R1 finding 2(b) — the SUB-CAP twin of
/// [`concurrent_full_size_drain_admissions_never_self_spill_the_queue`]:
/// a client's `replayPageBytes` request far below the production frame
/// size makes every page the builder's ATOMIC single-frame result, so
/// the drain's reservation must be max(requested budget, the atomic
/// page ceiling) — reserving only the requested bytes lets all three
/// concurrent pane drains be granted together against the same
/// just-under-watermark backlog, each admitting a full atomic page on
/// top of it, and the queue evicts the drains' own pages. The numbers
/// mirror the full-size twin's shape at the supported 64 KiB queue
/// floor: watermark 32 KiB, requested budget 2048 bytes, atomic pages
/// ~8.4 KiB (a maximal PTY read under the fragment cap).
#[tokio::test]
async fn concurrent_sub_cap_drain_admissions_never_under_reserve_the_atomic_page() {
    let events = crate::invariants::capture::capture();
    let (sender, pump) = WriterSender::new(64 * 1024, 4096, Duration::from_secs(10));
    let capture = Arc::new(Capture::default());
    capture.block_flush.store(true, Ordering::SeqCst);
    let watermark = sender.backlog_watermark();
    assert_eq!(
        watermark,
        32 * 1024,
        "the supported 64 KiB queue floor's watermark"
    );

    // One ATOMIC page: a single output frame whose serialized size is a
    // full PTY read (~8 KiB data) — far above the 2048-byte requested
    // page budget, and within the fragment cap (frames are
    // pre-fragmented, so this is the worst case production can stage).
    let page = |terminal_id: &'static str, seq: i64| {
        let mut message = output(seq);
        if let ServerMessage::TerminalOutput(frame) = &mut message {
            frame.terminal_id = terminal_id.to_string();
            frame.data = "P".repeat(8 * 1024);
        }
        message
    };
    let page_bytes = serde_json::to_string(&page("drain-subcap-probe", 1))
        .unwrap()
        .len();
    let ceiling = freshell_terminal::paced_atomic_page_serialized_ceiling();
    assert!(
        page_bytes <= ceiling,
        "the fixture's atomic page is a real single frame under the ceiling \
         ({page_bytes} <= {ceiling})"
    );
    assert!(
        page_bytes > 2048,
        "the atomic page provably exceeds the sub-cap request (the under-booked page)"
    );

    // Fill the backlog to JUST UNDER the grant threshold for three
    // 2048-byte reservations (the wake state where the pre-fix gate
    // granted all of them together) with the socket blocked.
    let admission_bytes = crate::paced_replay::drain_admission_bytes(2048);
    let grant_backlog_cap = watermark.saturating_sub(3 * 2048);
    let mut seq = 0;
    while sender.pending_output_bytes() < grant_backlog_cap.saturating_sub(4096) {
        seq += 1;
        assert!(sender.push_server(named_output("drain-subcap-fill", seq)));
    }
    let task = tokio::spawn(pump.run(TestSink(Arc::clone(&capture))));
    started(&capture).await;
    let backlog_at_wake = sender.pending_output_bytes();
    assert!(
        backlog_at_wake < grant_backlog_cap,
        "the fixture wakes the drains just under the {grant_backlog_cap}-byte grant \
         threshold ({backlog_at_wake})"
    );
    let spill_count = || {
        events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| {
                e.message.contains("queue_overflow_spill")
                    && e.fields
                        .get("terminal_id")
                        .is_some_and(|id| id.starts_with("drain-subcap"))
            })
            .count()
    };
    assert_eq!(spill_count(), 0, "no spill before the drains wake");

    // THE CONCURRENT WAKE: three pane drains reserve their sub-cap
    // admissions together against the just-under-watermark backlog. The
    // gate must grant NONE of them while the backlog stands — a
    // reservation of only the requested 2048 bytes would admit all
    // three, and their ~8.4 KiB atomic pages (+ the standing backlog)
    // would blow past the 64 KiB queue and evict the drains' own pages.
    let max_observed = Arc::new(AtomicUsize::new(0));
    let mut drains = Vec::new();
    for (drain, terminal_id) in ["drain-subcap-a", "drain-subcap-b", "drain-subcap-c"]
        .into_iter()
        .enumerate()
    {
        let sender = sender.clone();
        let max_observed = Arc::clone(&max_observed);
        drains.push(tokio::spawn(async move {
            let permit = sender
                .reserve_drain_admission(admission_bytes)
                .await
                .expect("the writer is alive");
            assert!(sender.push_server(page(terminal_id, 1 + drain as i64)));
            let observed = sender.pending_output_bytes();
            max_observed.fetch_max(observed, Ordering::SeqCst);
            drop(permit);
        }));
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    {
        let queues = sender.shared.queues.lock().unwrap();
        assert_eq!(
            queues.drain_reserved, 0,
            "no sub-cap reservation is granted against a backlog the atomic page \
             cannot join without crossing the watermark"
        );
    }
    assert_eq!(
        spill_count(),
        0,
        "no atomic page was admitted while the backlog stood (the socket is blocked)"
    );
    assert_eq!(
        max_observed.load(Ordering::SeqCst),
        0,
        "no drain admitted anything before the queue drained"
    );

    // REAL consumption releases the admissions: the pump drains the
    // backlog, the reservations grant (serialized by their atomic-page
    // size), and every drain completes its page.
    unblock(&capture);
    for drain in drains {
        tokio::time::timeout(Duration::from_secs(5), drain)
            .await
            .expect("each reserved sub-cap drain completes")
            .unwrap();
    }

    // THE BOUND: zero drain-induced queue_overflow evictions, and the
    // admitted aggregate never exceeded the watermark + one atomic page.
    let observed = max_observed.load(Ordering::SeqCst);
    assert_eq!(
        spill_count(),
        0,
        "THE BOUND: concurrent sub-cap pane drains must never evict the connection's \
         own pages by under-reserving their atomic pages (observed aggregate \
         {observed}B vs watermark {watermark}B + one atomic page {page_bytes}B)"
    );
    assert!(
        observed <= watermark + page_bytes,
        "THE BOUND: the admitted aggregate ({observed}) must never exceed the \
         watermark ({watermark}) + one atomic page ({page_bytes})"
    );
    {
        let queues = sender.shared.queues.lock().unwrap();
        assert_eq!(
            queues.drain_reserved, 0,
            "every reservation was released after its page became real backlog"
        );
    }

    sender.stop_without_close();
    let _ = join(task).await;
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
            managed_retained: None,
            exit_code_available: None,
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
            managed_retained: None,
            exit_code_available: None,
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
            managed_retained: None,
            exit_code_available: None,
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

/// An oversized indivisible OUTPUT frame — larger than the ENTIRE queue cap —
/// spills immediately (output frames are themselves evictable, so the cap
/// evicts the oversize frame the moment it is admitted) instead of
/// accumulating unbounded bytes or closing the connection: the push
/// succeeds, the loss is the honest queue-overflow gap covering exactly that
/// frame, and pending bytes stay bounded at zero. (The CONTROL lane's
/// one-oversize-frame grace is separate — see
/// `overflow_stops_a_pending_flush_without_waiting_for_send_timeout`.)
#[tokio::test]
async fn oversized_indivisible_output_frame_spills_instead_of_accumulating() {
    let (sender, pump) = overflow_writer();
    let probe = serde_json::to_string(&output(1)).unwrap().len();
    let mut huge = output(1);
    if let ServerMessage::TerminalOutput(frame) = &mut huge {
        // Serialized length comfortably exceeds the whole cap.
        frame.data = "X".repeat(probe * 2);
    }
    assert!(
        sender.push_server(huge),
        "admission must survive an oversize frame (it spills, never wedges)"
    );
    assert_eq!(
        sender.pending_output_bytes(),
        0,
        "the oversize frame must not accumulate: the queue stays bounded"
    );
    let next = pump.take_next().unwrap().unwrap();
    let gap: serde_json::Value = serde_json::from_str(&leased_text(&next.frame)).unwrap();
    assert_eq!(gap["type"], "terminal.output.gap");
    assert_eq!(gap["reason"], "queue_overflow");
    assert_eq!(
        gap["fromSeq"], 1,
        "the gap covers exactly the oversize frame"
    );
    assert_eq!(gap["toSeq"], 1);
    pump.finish_frame(next.output_bytes, next.control_bytes);
    assert!(
        pump.take_next().unwrap().is_none(),
        "nothing else was retained behind the oversize frame"
    );
}

/// Task-007 review M2 (landed by task-010): the rate-limited
/// `ws.terminal_stream.queue_overflow_spill` event must fire at ADMISSION
/// time — the moment the eviction happens — not at gap-lease time, so a
/// connection that spills and then dies while backlogged (its coalesced
/// gap never surfaces from the stuck queue) still leaves spill evidence in
/// the live log. The pump is NEVER run until after the emit assertions:
/// nothing is leased, so a lease-time emit would produce no event at all.
#[tokio::test]
async fn spill_observability_fires_at_admission_time_even_if_the_gap_is_never_leased() {
    let events = crate::invariants::capture::capture();
    // Cap sized to exactly ONE of THIS terminal's frames (the longer
    // terminal id makes each serialized frame larger than `output(1)`'s
    // probe, so `overflow_writer()` would self-evict frame 1).
    let (sender, pump) = {
        let probe = serde_json::to_string(&named_output("spill-admission", 1))
            .unwrap()
            .len();
        WriterSender::new(probe, 4096, Duration::from_secs(10))
    };
    let spill_events = || {
        events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| {
                e.message.contains("queue_overflow_spill")
                    && e.fields.get("terminal_id").map(String::as_str) == Some("spill-admission")
            })
            .count()
    };
    // Frame 1 alone fits the cap (probe bytes); frame 2's admission evicts
    // frame 1; frame 3's admission evicts frame 2.
    assert!(sender.push_server(named_output("spill-admission", 1)));
    {
        let queues = sender.shared.queues.lock().unwrap();
        assert!(
            queues.spill_last_logged.is_none(),
            "no spill bookkeeping before any eviction"
        );
    }
    assert_eq!(spill_events(), 0, "no eviction has happened yet");
    assert!(sender.push_server(named_output("spill-admission", 2)));
    // The FIRST eviction emits immediately (rate limiter idle) with the
    // evicted frame's own range — without any pump lease.
    {
        let queues = sender.shared.queues.lock().unwrap();
        assert!(
            queues.spill_last_logged.is_some(),
            "the eviction at admission time must record the spill"
        );
    }
    {
        let captured: Vec<_> = events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| {
                e.message.contains("queue_overflow_spill")
                    && e.fields.get("terminal_id").map(String::as_str) == Some("spill-admission")
            })
            .cloned()
            .collect();
        assert_eq!(
            captured.len(),
            1,
            "admission-time eviction must emit exactly one spill event with no pump lease: {captured:?}"
        );
        assert_eq!(
            captured[0].fields.get("from_seq").map(String::as_str),
            Some("1")
        );
        assert_eq!(
            captured[0].fields.get("to_seq").map(String::as_str),
            Some("1")
        );
        assert_eq!(
            captured[0].fields.get("suppressed").map(String::as_str),
            Some("0")
        );
    }
    // A second eviction inside the rate-limit window folds into the
    // `suppressed` counter (one event per window).
    assert!(sender.push_server(named_output("spill-admission", 3)));
    {
        let queues = sender.shared.queues.lock().unwrap();
        assert_eq!(
            queues.spill_suppressed, 1,
            "the in-window eviction folds into suppressed"
        );
    }
    // NOW lease everything (including the coalesced [1..=2] gap): gap
    // DELIVERY is not a spill occurrence — no new event, no extra fold.
    let mut leased_gap = None;
    while let Some(next) = pump.take_next().unwrap() {
        let text = leased_text(&next.frame);
        if text.contains("terminal.output.gap") {
            leased_gap = Some(serde_json::from_str::<serde_json::Value>(&text).unwrap());
        }
        pump.finish_frame(next.output_bytes, next.control_bytes);
    }
    let gap = leased_gap.expect("the coalesced gap must lease");
    assert_eq!(gap["fromSeq"], 1);
    assert_eq!(gap["toSeq"], 2);
    {
        let queues = sender.shared.queues.lock().unwrap();
        assert_eq!(
            queues.spill_suppressed, 1,
            "leasing the gap is not a spill occurrence"
        );
    }
    assert_eq!(
        spill_events(),
        1,
        "delivery of the gap must not emit a second spill event"
    );
}

/// Drain-progress liveness (responsive-terminal-restore Workstream 3): the
/// completed-send counter moves ONLY on successful socket sends. Supersede
/// and eviction shrink queued bytes without touching it, and a leased frame
/// counts only once its flush finishes.
#[tokio::test]
async fn completed_sends_counts_only_successful_socket_sends() {
    let (mut sender, pump) = WriterSender::new(1 << 20, 1 << 20, Duration::from_secs(10));
    assert_eq!(sender.completed_sends(), 0);
    // Two queued output frames and one control.
    assert!(sender.push_server(output(1)));
    assert!(sender.push_server(output(2)));
    sender.send(notice("control")).await.unwrap();
    // A superseding attach DISCARDS another terminal's queued output — a
    // byte reduction that is not a send and must not count as progress.
    assert!(sender.push_server(named_output("victim", 1)));
    assert!(sender.push_server(
        serde_json::from_value(serde_json::json!({
            "type":"terminal.attach.ready", "terminalId":"victim", "attachRequestId":"a2",
            "streamId":"stream", "headSeq":1, "replayFromSeq":1, "replayToSeq":1
        }))
        .unwrap()
    ));
    assert_eq!(
        sender.completed_sends(),
        0,
        "admission, eviction and supersede are not sends"
    );
    // Drive the pump: every take_next + finish_frame pair is one successful
    // send; the discarded victim frame never leases.
    let mut sends = 0u64;
    while let Some(next) = pump.take_next().unwrap() {
        pump.finish_frame(next.output_bytes, next.control_bytes);
        sends += 1;
        assert_eq!(
            sender.completed_sends(),
            sends,
            "exactly one count per completed send"
        );
    }
    assert_eq!(
        sends, 4,
        "control + superseding attach.ready + two output frames were sent"
    );
    assert_eq!(sender.completed_sends(), 4);
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
        claimed_terminal_ids: None,
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

/// Force exactly one queue-overflow eviction: the output limit admits the
/// first frame alone, so the second push evicts the first and materializes
/// its gap. The limit is derived from the probe frame's serialized size so
/// the eviction is deterministic without hardcoding byte counts.
fn overflow_writer() -> (WriterSender, WriterPump) {
    let probe = serde_json::to_string(&output(1)).unwrap().len();
    WriterSender::new(probe, 4096, Duration::from_secs(10))
}

#[tokio::test]
async fn queue_overflow_gap_carries_restore_bounds_on_paced_connections() {
    // Restore contract (responsive-terminal-restore): a connection that
    // negotiated pacedTerminalReplayV1 (modeled here by an installed
    // gap-bounds source) sees its queue-overflow gaps stamped with the
    // terminal's CURRENT headSeq + oldestRetainedSeq, resolved at
    // gap-emission (lease) time.
    let (sender, pump) = overflow_writer();
    sender.set_paced_replay_gap_bounds(Arc::new(|_| {
        Some(freshell_terminal::ReplayBounds {
            head_seq: 421,
            oldest_retained_seq: 7,
        })
    }));
    assert!(sender.push_server(output(1)));
    assert!(sender.push_server(output(2))); // evicts output(1) -> queue_overflow gap
    let next = pump.take_next().unwrap().unwrap();
    let gap: serde_json::Value = serde_json::from_str(&leased_text(&next.frame)).unwrap();
    assert_eq!(gap["type"], "terminal.output.gap");
    assert_eq!(gap["reason"], "queue_overflow");
    assert_eq!(gap["fromSeq"], 1);
    assert_eq!(gap["toSeq"], 1);
    assert_eq!(gap["headSeq"], 421, "negotiated gap carries headSeq: {gap}");
    assert_eq!(
        gap["oldestRetainedSeq"], 7,
        "negotiated gap carries oldestRetainedSeq: {gap}"
    );
    pump.finish_frame(next.output_bytes, next.control_bytes);
    // The evicted frame's successor still delivers.
    let next = pump.take_next().unwrap().unwrap();
    assert!(leased_text(&next.frame).contains("data-2"));
    pump.finish_frame(next.output_bytes, next.control_bytes);
}

#[tokio::test]
async fn queue_overflow_gap_without_paced_negotiation_keeps_the_frozen_shape() {
    // Compatibility invariant (load-bearing): a connection that did NOT
    // negotiate sees gap frames byte-identical to the pre-contract wire —
    // no headSeq, no oldestRetainedSeq, and exactly the frozen key set.
    let (sender, pump) = overflow_writer();
    assert!(sender.push_server(output(1)));
    assert!(sender.push_server(output(2))); // evicts output(1) -> queue_overflow gap
    let next = pump.take_next().unwrap().unwrap();
    let gap: serde_json::Value = serde_json::from_str(&leased_text(&next.frame)).unwrap();
    assert_eq!(gap["type"], "terminal.output.gap");
    let mut keys: Vec<&str> = gap
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec![
            "attachRequestId",
            "fromSeq",
            "reason",
            "streamId",
            "terminalId",
            "toSeq",
            "type",
        ],
        "the non-negotiated gap frame keeps the pre-contract key set: {gap}"
    );
    pump.finish_frame(next.output_bytes, next.control_bytes);
}

/// A directly pushed `terminal.output.gap` (the paced path emits retention
/// gaps through `push_server`, unlike the queue's own lease-time gap
/// materialization): the gap is sequenced WITH the terminal's output — it
/// must lease strictly AFTER output admitted before it, never jumping ahead
/// on the preemptive control lane, and it must never be evictable or
/// byte-charged.
#[tokio::test]
async fn server_pushed_restore_gap_stays_ordered_with_the_terminals_output() {
    let (sender, pump) = WriterSender::new(100_000, 4096, Duration::from_secs(10));
    assert!(sender.push_server(output(1)));
    let gap = ServerMessage::TerminalOutputGap(freshell_protocol::TerminalOutputGap {
        terminal_id: "term".into(),
        stream_id: "stream".into(),
        attach_request_id: Some("attach".into()),
        from_seq: 1,
        to_seq: 9,
        reason: freshell_protocol::TerminalOutputGapReason::ReplayWindowExceeded,
        head_seq: Some(12),
        oldest_retained_seq: Some(10),
    });
    assert!(sender.push_server(gap));

    let first = pump.take_next().unwrap().unwrap();
    assert!(
        leased_text(&first.frame).contains("data-1"),
        "output admitted BEFORE the gap leases first"
    );
    pump.finish_frame(first.output_bytes, first.control_bytes);

    let second = pump.take_next().unwrap().unwrap();
    let gap_json: serde_json::Value = serde_json::from_str(&leased_text(&second.frame)).unwrap();
    assert_eq!(gap_json["type"], "terminal.output.gap");
    assert_eq!(
        second.output_bytes, 0,
        "the gap leases as a zero-weight sequenced control (never byte-charged)"
    );
    pump.finish_frame(second.output_bytes, second.control_bytes);
}

/// The server-pushed restore gap must survive queue overflow eviction: like
/// `terminal.exit`, it is a non-evictable sequenced control — the byte cap
/// evicts payload frames, never the gap.
#[tokio::test]
async fn server_pushed_restore_gap_is_not_evictable_under_overflow() {
    let (sender, pump) = overflow_writer();
    assert!(sender.push_server(output(1)));
    let gap = ServerMessage::TerminalOutputGap(freshell_protocol::TerminalOutputGap {
        terminal_id: "term".into(),
        stream_id: "stream".into(),
        attach_request_id: Some("attach".into()),
        from_seq: 2,
        to_seq: 2,
        reason: freshell_protocol::TerminalOutputGapReason::ReplayWindowExceeded,
        head_seq: None,
        oldest_retained_seq: None,
    });
    assert!(sender.push_server(gap));
    // Overflow: output(2) does not fit and evicts the OLDEST EVICTABLE entry —
    // output(1) — never the non-evictable gap.
    assert!(sender.push_server(output(2)));

    let first = pump.take_next().unwrap().unwrap();
    let first_json: serde_json::Value = serde_json::from_str(&leased_text(&first.frame)).unwrap();
    assert_eq!(
        first_json["type"], "terminal.output.gap",
        "the queue-overflow gap head leases first (the evicted output(1))"
    );
    pump.finish_frame(first.output_bytes, first.control_bytes);

    let second = pump.take_next().unwrap().unwrap();
    let second_json: serde_json::Value = serde_json::from_str(&leased_text(&second.frame)).unwrap();
    assert_eq!(
        second_json["type"], "terminal.output.gap",
        "the server-pushed restore gap survives the overflow eviction"
    );
    assert_eq!(second_json["fromSeq"], 2);
    pump.finish_frame(second.output_bytes, second.control_bytes);

    let third = pump.take_next().unwrap().unwrap();
    assert!(leased_text(&third.frame).contains("data-2"));
    pump.finish_frame(third.output_bytes, third.control_bytes);
}

/// Task-2 review follow-up (Minor 2): a writer stop that lands while the Gap
/// arm has RELEASED the admission lock to resolve negotiated bounds (after
/// the pop, before the materialize) must yield NO flushed frame — the
/// re-acquire re-check of `closed` aborts the lease and the pump exits via
/// the stop watch, leaving the popped gap unflushed.
#[tokio::test]
async fn writer_stop_landing_during_gap_bounds_resolution_flushes_no_frame() {
    let (sender, pump) = overflow_writer();
    let stopping = sender.clone();
    sender.set_paced_replay_gap_bounds(Arc::new(move |_| {
        // The stop lands mid-resolution: the gap was already popped and the
        // admission lock released.
        stopping.stop_without_close();
        Some(freshell_terminal::ReplayBounds {
            head_seq: 9,
            oldest_retained_seq: 2,
        })
    }));
    assert!(sender.push_server(output(1)));
    assert!(sender.push_server(output(2))); // evicts output(1) -> queue gap

    let capture = Arc::new(Capture::default());
    let task = tokio::spawn(pump.run(TestSink(Arc::clone(&capture))));
    assert_eq!(join(task).await, WriterExit::Stopped);
    assert!(
        text_frames(&capture).is_empty(),
        "a stop before the lease must leave nothing flushed"
    );
    assert_eq!(sender.pending_output_bytes(), 0);
}

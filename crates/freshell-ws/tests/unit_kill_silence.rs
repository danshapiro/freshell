//! A Shift-X is silent (Stage 2: LB-37): no `terminal.idle` and no
//! `terminal.turn.complete` for the pane between the kill and its Gone, nor
//! after the acknowledgement — even when a turn completed just before the
//! kill (its idle grace window was armed), the agent reports a completion
//! after the kill's SIGINT (as real Codex does), or a turn ends on its own
//! while the stop reads which threads the app-server holds, before its
//! first signal. Own binary: Gone is held 2.5 s (past the 2 s idle grace)
//! through the env-gated test hook.
#![cfg(target_os = "linux")]
#[path = "support/unit_harness.rs"]
mod unit_harness;

use std::collections::BTreeSet;
use std::time::Duration;

use serde_json::json;
use unit_harness::{GoneDelay, HarnessOpts, TestWs, ThreadReadHeldUp, UnitHarness};

/// Every frame from now until `window` after the `terminal.killed` ack of
/// `request_id` (which must arrive within 15 s).
async fn frames_through_ack(
    h: &UnitHarness,
    ws: &mut TestWs,
    request_id: &str,
    window: Duration,
) -> Vec<serde_json::Value> {
    let mut seen = Vec::new();
    let ack_deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let remaining = ack_deadline.saturating_duration_since(tokio::time::Instant::now());
        let frame = h
            .next_matching(ws, remaining, |_| true)
            .await
            .unwrap_or_else(|| panic!("the kill is acknowledged; seen {seen:?}"));
        let acked = frame["type"] == "terminal.killed" && frame["requestId"] == request_id;
        seen.push(frame);
        if acked {
            break;
        }
    }
    let deadline = tokio::time::Instant::now() + window;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        match h.next_matching(ws, remaining, |_| true).await {
            Some(frame) => seen.push(frame),
            None => break,
        }
    }
    seen
}

/// Every frame from now through the first one satisfying `pred` (which
/// must arrive within `limit`).
async fn frames_until(
    h: &UnitHarness,
    ws: &mut TestWs,
    limit: Duration,
    pred: impl Fn(&serde_json::Value) -> bool,
) -> Vec<serde_json::Value> {
    let mut seen = Vec::new();
    let deadline = tokio::time::Instant::now() + limit;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let frame = h
            .next_matching(ws, remaining, |_| true)
            .await
            .unwrap_or_else(|| panic!("the awaited frame arrives; seen {seen:?}"));
        let done = pred(&frame);
        seen.push(frame);
        if done {
            return seen;
        }
    }
}

/// Whether `frame` is the live owner frame saying `session_id` is Stopping.
fn stopping_frame(frame: &serde_json::Value, session_id: &str) -> bool {
    frame["type"] == "session.runtimeOwner"
        && frame["sessionId"] == session_id
        && frame["transition"] == "stopping"
}

/// The ids of this process's threads now running a read of a unit's
/// thread lock files before a stop (`reconcile_before_stop` names them
/// `unit-thread-read`; the kernel keeps the first 15 bytes of a name).
fn thread_reads_running() -> BTreeSet<u32> {
    const READ_THREAD: &str = "unit-thread-rea";
    std::fs::read_dir("/proc/self/task")
        .expect("this process's threads")
        .flatten()
        .filter(|task| {
            std::fs::read_to_string(task.path().join("comm"))
                .is_ok_and(|comm| comm.trim_end() == READ_THREAD)
        })
        .filter_map(|task| task.file_name().to_str()?.parse().ok())
        .collect()
}

/// Waits (bounded) until a read of a unit's thread lock files runs that
/// `before` did not list.
async fn a_new_thread_read(before: &BTreeSet<u32>) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while thread_reads_running().is_subset(before) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the read before the stop's first signal began"
        );
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
}

/// Starts a Codex pane resuming `session_id` and a turn in it (the fake
/// takes a minute to complete it on its own), returning its terminal.
async fn pane_with_a_turn_in_flight(
    h: &UnitHarness,
    ws: &mut TestWs,
    create_request_id: &str,
    session_id: &str,
) -> String {
    let tid = h
        .create_codex(ws, create_request_id, Some(session_id))
        .await;
    h.next_matching(ws, Duration::from_secs(10), |f| {
        f["type"] == "terminal.output"
            && f["data"]
                .as_str()
                .is_some_and(|d| d.contains("FAKE_TUI_READY"))
    })
    .await
    .expect("the TUI is ready");
    h.send(
        ws,
        json!({"type": "terminal.input", "terminalId": tid, "data": "turn go\r"}),
    )
    .await;
    h.next_matching(ws, Duration::from_secs(10), |f| {
        f["type"] == "codex.activity.updated"
            && f["upsert"].as_array().is_some_and(|rows| {
                rows.iter()
                    .any(|row| row["terminalId"] == tid.as_str() && row["phase"] == "busy")
            })
    })
    .await
    .expect("the turn is in flight");
    tid
}

/// The proxied `turn/completed{completed}` of `session_id`'s turn, as the
/// router hands it to the activity hub.
fn turn_completed(h: &UnitHarness, tid: &str, session_id: &str) {
    h.state
        .activity
        .as_ref()
        .expect("the harness wires the activity hub")
        .note_codex_proxy_turn(tid, session_id, None, Some("completed"), true);
}

fn attention_edges<'a>(frames: &'a [serde_json::Value], tid: &str) -> Vec<&'a serde_json::Value> {
    frames
        .iter()
        .filter(|f| {
            (f["type"] == "terminal.idle" || f["type"] == "terminal.turn.complete")
                && f["terminalId"] == tid
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_turn_completed_just_before_shift_x_never_rings() {
    let h = UnitHarness::start(HarnessOpts {
        behavior: json!({"turnCompleteDelayMs": 200}),
        activity_hub: true,
        ..Default::default()
    })
    .await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-sil", Some("t-sil")).await;
    h.next_matching(&mut ws, Duration::from_secs(10), |f| {
        f["type"] == "terminal.output"
            && f["data"]
                .as_str()
                .is_some_and(|d| d.contains("FAKE_TUI_READY"))
    })
    .await
    .expect("the TUI is ready");
    let _delay = GoneDelay::set(2500);
    h.send(
        &mut ws,
        json!({"type": "terminal.input", "terminalId": tid, "data": "turn go\r"}),
    )
    .await;
    h.next_matching(&mut ws, Duration::from_secs(10), |f| {
        f["type"] == "terminal.turn.complete" && f["terminalId"] == tid.as_str()
    })
    .await
    .expect("the turn completed (the idle grace window is armed)");
    h.send(
        &mut ws,
        json!({"type": "terminal.kill", "terminalId": tid, "requestId": "rk-sil", "createRequestId": "crq-sil"}),
    )
    .await;
    let frames = frames_through_ack(&h, &mut ws, "rk-sil", Duration::from_millis(2500)).await;
    let idle: Vec<_> = frames
        .iter()
        .filter(|f| f["type"] == "terminal.idle" && f["terminalId"] == tid.as_str())
        .collect();
    assert!(idle.is_empty(), "no idle edge for a killed pane: {idle:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_turn_completing_during_the_stop_never_rings() {
    let h = UnitHarness::start(HarnessOpts {
        behavior: json!({"turnCompleteDelayMs": 60000}),
        activity_hub: true,
        ..Default::default()
    })
    .await;
    let mut ws = h.connect().await;
    // A turn is in flight when the kill lands.
    let tid = pane_with_a_turn_in_flight(&h, &mut ws, "crq-sil2", "t-sil2").await;
    let _delay = GoneDelay::set(2500);
    h.send(
        &mut ws,
        json!({"type": "terminal.kill", "terminalId": tid, "requestId": "rk-sil2", "createRequestId": "crq-sil2"}),
    )
    .await;
    // The stop has begun once the conversation's live frame says so; its
    // SIGINT is on its way.
    let mut frames = frames_until(&h, &mut ws, Duration::from_secs(10), |f| {
        stopping_frame(f, "t-sil2")
    })
    .await;
    // The proxied `turn/completed{completed}` real Codex sends just after
    // the kill's SIGINT.
    turn_completed(&h, &tid, "t-sil2");
    frames.extend(frames_through_ack(&h, &mut ws, "rk-sil2", Duration::from_millis(2500)).await);
    let edges = attention_edges(&frames, &tid);
    assert!(
        edges.is_empty(),
        "no idle or turn-complete edge for a pane being killed: {edges:?}"
    );
}

/// Task 14 re-review R3-I1: between the kill and the stop's first signal,
/// the stop reads which threads the pane's app-server holds (up to 1 s on a
/// slow host or Codex home). A turn that ends on its own during that read
/// ends a turn of a pane the user is killing: it rings nothing either.
#[tokio::test(flavor = "multi_thread")]
async fn a_turn_ending_during_the_read_before_the_stop_never_rings() {
    let h = UnitHarness::start(HarnessOpts {
        behavior: json!({"turnCompleteDelayMs": 60000}),
        activity_hub: true,
        ..Default::default()
    })
    .await;
    let mut ws = h.connect().await;
    let tid = pane_with_a_turn_in_flight(&h, &mut ws, "crq-sil3", "t-sil3").await;
    let ownership = h.state.ownership.clone().expect("an owner registry");
    let _delay = GoneDelay::set(2500);
    let _held_up = ThreadReadHeldUp::set(800);
    let reads_before = thread_reads_running();
    h.send(
        &mut ws,
        json!({"type": "terminal.kill", "terminalId": tid, "requestId": "rk-sil3", "createRequestId": "crq-sil3"}),
    )
    .await;
    a_new_thread_read(&reads_before).await;
    // The turn ends on its own while the read is held up.
    turn_completed(&h, &tid, "t-sil3");
    assert!(
        matches!(
            ownership.observe("codex", "t-sil3").state,
            freshell_ownership::OwnershipState::Live { .. }
        ),
        "the turn ended during the read, before the stop moved the pane's conversation to Stopping"
    );
    let frames = frames_through_ack(&h, &mut ws, "rk-sil3", Duration::from_millis(2500)).await;
    assert!(
        frames.iter().any(|f| stopping_frame(f, "t-sil3")),
        "the stop went on after the read"
    );
    let edges = attention_edges(&frames, &tid);
    assert!(
        edges.is_empty(),
        "no idle or turn-complete edge for a pane being killed: {edges:?}"
    );
}

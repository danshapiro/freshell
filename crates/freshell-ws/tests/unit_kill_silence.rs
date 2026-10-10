//! A Shift-X is silent (Stage 2: LB-37): no `terminal.idle` and no
//! `terminal.turn.complete` for the pane between the kill and its Gone, nor
//! after the acknowledgement — even when a turn completed just before the
//! kill (its idle grace window was armed) or the agent reports a completion
//! after the kill's SIGINT (as real Codex does). Own binary: Gone is held
//! 2.5 s (past the 2 s idle grace) through the env-gated test hook.
#![cfg(target_os = "linux")]
#[path = "support/unit_harness.rs"]
mod unit_harness;

use std::time::Duration;

use serde_json::json;
use unit_harness::{GoneDelay, HarnessOpts, TestWs, UnitHarness};

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
    let tid = h.create_codex(&mut ws, "crq-sil2", Some("t-sil2")).await;
    h.next_matching(&mut ws, Duration::from_secs(10), |f| {
        f["type"] == "terminal.output"
            && f["data"]
                .as_str()
                .is_some_and(|d| d.contains("FAKE_TUI_READY"))
    })
    .await
    .expect("the TUI is ready");
    // A turn is in flight when the kill lands.
    h.send(
        &mut ws,
        json!({"type": "terminal.input", "terminalId": tid, "data": "turn go\r"}),
    )
    .await;
    h.next_matching(&mut ws, Duration::from_secs(10), |f| {
        f["type"] == "codex.activity.updated"
            && f["upsert"].as_array().is_some_and(|rows| {
                rows.iter()
                    .any(|row| row["terminalId"] == tid.as_str() && row["phase"] == "busy")
            })
    })
    .await
    .expect("the turn is in flight");
    let _delay = GoneDelay::set(2500);
    h.send(
        &mut ws,
        json!({"type": "terminal.kill", "terminalId": tid, "requestId": "rk-sil2", "createRequestId": "crq-sil2"}),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    // The proxied `turn/completed{completed}` real Codex sends just after
    // the kill's SIGINT.
    h.state
        .activity
        .as_ref()
        .expect("the harness wires the activity hub")
        .note_codex_proxy_turn(&tid, "t-sil2", None, Some("completed"), true);
    let frames = frames_through_ack(&h, &mut ws, "rk-sil2", Duration::from_millis(2500)).await;
    let edges = attention_edges(&frames, &tid);
    assert!(
        edges.is_empty(),
        "no idle or turn-complete edge for a pane being killed: {edges:?}"
    );
}

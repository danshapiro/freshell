//! Every thread a pane's app-server holds is held by the pane's unit: the
//! earlier conversations its app-server still has loaded (found by one read
//! of the unit members' lock files), helper threads (announced only by
//! `thread/status/changed`), and, never, the TUI's ephemeral title threads.
//! Each is Live in the owner registry under the pane's terminal and listed
//! in the sidecar record, is released when Codex unloads it, and is Vacant
//! with its lock released at the pane's Gone. Reopening a conversation the
//! unit holds as an extra thread answers the holding pane's terminal and
//! starts nothing (Decision 1, Stage 2: LB-25, LB-38, LB-51).
#![cfg(target_os = "linux")]
#[path = "support/unit_harness.rs"]
mod unit_harness;

use std::collections::BTreeSet;
use std::time::Duration;

use freshell_ownership::OwnershipState;
use serde_json::json;
use unit_harness::{fake_codex, HarnessOpts, UnitHarness};

async fn eventually(what: &str, f: impl Fn() -> bool) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !f() {
        assert!(tokio::time::Instant::now() < deadline, "timed out: {what}");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn live_under(h: &UnitHarness, sid: &str, tid: &str) -> bool {
    matches!(h.state.ownership.as_ref().unwrap().observe("codex", sid).state,
        OwnershipState::Live { ref owner, .. } if owner.terminal_id.as_deref() == Some(tid))
}

fn vacant(h: &UnitHarness, sid: &str) -> bool {
    h.state
        .ownership
        .as_ref()
        .unwrap()
        .observe("codex", sid)
        .state
        == OwnershipState::Vacant
}

/// The `heldThreadIds` of the harness's one sidecar record (`None` while
/// there is no record; the record leaves out an empty list).
fn held_thread_ids(h: &UnitHarness) -> Option<BTreeSet<String>> {
    let records = h.home.path().join(".freshell/rust-codex-sidecars");
    let row: serde_json::Value = std::fs::read_dir(&records)
        .ok()?
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .filter_map(|raw| serde_json::from_str(&raw).ok())
        .next()?;
    serde_json::from_value(row.get("heldThreadIds").cloned().unwrap_or(json!([]))).ok()
}

fn set(ids: &[&str]) -> BTreeSet<String> {
    ids.iter().map(|id| id.to_string()).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn helper_and_earlier_threads_are_held_by_the_pane_unit_and_released_at_gone() {
    let h = UnitHarness::start(HarnessOpts {
        behavior: json!({"preloadedThreads": ["t-old"], "turnCompleteDelayMs": 60000,
                         "helperThreadOnTurn": {"id": "t-help", "durationMs": 60000}}),
        ..Default::default()
    })
    .await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-th", Some("t-main")).await;
    h.next_matching(&mut ws, Duration::from_secs(10), |f| {
        f["type"] == "terminal.output"
            && f["data"]
                .as_str()
                .is_some_and(|d| d.contains("FAKE_TUI_READY"))
    })
    .await
    .unwrap();
    eventually("earlier conversation held (member lock read)", || {
        live_under(&h, "t-old", &tid)
    })
    .await;
    h.send(
        &mut ws,
        json!({"type": "terminal.input", "terminalId": tid, "data": "turn go\r"}),
    )
    .await;
    eventually("helper thread held (proxy stream)", || {
        live_under(&h, "t-help", &tid)
    })
    .await;
    // The record write runs off the proxy router.
    eventually("the sidecar record lists both threads", || {
        held_thread_ids(&h).is_some_and(|held| held.contains("t-old") && held.contains("t-help"))
    })
    .await;
    // The turn started the TUI's ephemeral title thread, which holds no
    // lock and is never held; the main thread is the record's `sessionId`.
    assert_eq!(
        held_thread_ids(&h).unwrap(),
        set(&["t-old", "t-help"]),
        "exactly the earlier conversation and the helper"
    );

    h.send(
        &mut ws,
        json!({"type": "terminal.kill", "terminalId": tid, "requestId": "rk", "createRequestId": "crq-th"}),
    )
    .await;
    h.next_matching(&mut ws, Duration::from_secs(10), |f| {
        f["type"] == "terminal.killed"
    })
    .await
    .unwrap();
    for sid in ["t-main", "t-old", "t-help"] {
        assert_eq!(
            h.state
                .ownership
                .as_ref()
                .unwrap()
                .observe("codex", sid)
                .state,
            OwnershipState::Vacant,
            "{sid}"
        );
        assert!(!fake_codex::lock_held(&h.lock(sid)), "{sid} lock released");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn reopen_of_an_extra_thread_answers_the_holder_and_spawns_nothing() {
    let h = UnitHarness::start(HarnessOpts {
        behavior: json!({"preloadedThreads": ["t-extra"]}),
        ..Default::default()
    })
    .await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-holder", Some("t-shown")).await;
    eventually("extra held", || live_under(&h, "t-extra", &tid)).await;
    let launchers_before = std::fs::read_dir(&h.manifests).unwrap().count();
    let mut other = h.connect().await;
    h.send(&mut other, json!({"type": "terminal.create", "requestId": "crq-reopen", "mode": "codex", "shell": "system",
        "sessionRef": {"provider": "codex", "sessionId": "t-extra"}})).await;
    let created = h
        .next_matching(&mut other, Duration::from_secs(10), |f| {
            f["requestId"] == "crq-reopen"
                && (f["type"] == "terminal.created" || f["type"] == "error")
        })
        .await
        .expect("answered");
    assert_eq!(created["type"], "terminal.created", "{created}");
    assert_eq!(
        created["terminalId"],
        tid.as_str(),
        "the reopen names the holding pane's terminal"
    );
    assert_eq!(
        std::fs::read_dir(&h.manifests).unwrap().count(),
        launchers_before,
        "no second app-server"
    );
    assert!(
        live_under(&h, "t-extra", &tid),
        "the reopen released nothing"
    );
}

/// A helper the parent closes (Codex's `close_agent`) is announced unloaded
/// only by a lone `thread/status/changed {notLoaded}`, never `thread/closed`
/// (Stage 2: LB-38; V9 N3). It leaves the unit then: Vacant, and gone from
/// the sidecar record.
#[tokio::test(flavor = "multi_thread")]
async fn a_helper_that_closes_is_released_from_the_unit() {
    let h = UnitHarness::start(HarnessOpts {
        behavior: json!({"turnCompleteDelayMs": 60000,
                         "helperThreadOnTurn": {"id": "t-h2", "durationMs": 60000, "closeAfterMs": 2000}}),
        ..Default::default()
    })
    .await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-h2", Some("t-main2")).await;
    h.next_matching(&mut ws, Duration::from_secs(10), |f| {
        f["type"] == "terminal.output"
            && f["data"]
                .as_str()
                .is_some_and(|d| d.contains("FAKE_TUI_READY"))
    })
    .await
    .unwrap();
    h.send(
        &mut ws,
        json!({"type": "terminal.input", "terminalId": tid, "data": "turn go\r"}),
    )
    .await;
    eventually("the helper is held", || live_under(&h, "t-h2", &tid)).await;
    eventually("the sidecar record lists the helper", || {
        held_thread_ids(&h).is_some_and(|held| held.contains("t-h2"))
    })
    .await;
    eventually("the closed helper is Vacant", || vacant(&h, "t-h2")).await;
    eventually("the closed helper leaves the sidecar record", || {
        held_thread_ids(&h).is_some_and(|held| !held.contains("t-h2"))
    })
    .await;
    assert!(
        !fake_codex::lock_held(&h.lock("t-h2")),
        "Codex released the closed helper's lock"
    );
    assert!(
        live_under(&h, "t-main2", &tid),
        "the pane's own conversation stays"
    );
}

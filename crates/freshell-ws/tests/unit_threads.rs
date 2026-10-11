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
use std::path::{Path, PathBuf};
use std::time::Duration;

use freshell_codex::launch_lifecycle::CodexTerminalLaunchManager;
use freshell_ownership::OwnershipState;
use serde_json::json;
use unit_harness::{fake_codex, HarnessOpts, TestWs, UnitHarness};

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

/// The lock files the pane's unit checks at Gone.
fn lock_paths(h: &UnitHarness, tid: &str) -> BTreeSet<PathBuf> {
    h.unit_for(tid).lock_paths().into_iter().collect()
}

/// The writer lock of each thread under `codex_home`.
fn locks_under(codex_home: &Path, ids: &[&str]) -> BTreeSet<PathBuf> {
    ids.iter()
        .map(|id| fake_codex::thread_lock_path(codex_home, id))
        .collect()
}

async fn tui_ready(h: &UnitHarness, ws: &mut TestWs) {
    h.next_matching(ws, Duration::from_secs(10), |f| {
        f["type"] == "terminal.output"
            && f["data"]
                .as_str()
                .is_some_and(|d| d.contains("FAKE_TUI_READY"))
    })
    .await
    .expect("the TUI is up");
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
    assert_eq!(
        lock_paths(&h, &tid),
        locks_under(&h.codex_home, &["t-main2", "t-h2"]),
        "the Gone lock check covers the helper's lock and the pane's own"
    );
    eventually("the closed helper is Vacant", || vacant(&h, "t-h2")).await;
    eventually("the closed helper leaves the sidecar record", || {
        held_thread_ids(&h).is_some_and(|held| !held.contains("t-h2"))
    })
    .await;
    assert_eq!(
        lock_paths(&h, &tid),
        locks_under(&h.codex_home, &["t-main2"]),
        "the closed helper's lock leaves the Gone lock check"
    );
    assert!(
        !fake_codex::lock_held(&h.lock("t-h2")),
        "Codex released the closed helper's lock"
    );
    assert!(
        live_under(&h, "t-main2", &tid),
        "the pane's own conversation stays"
    );
}

/// A pane that never holds an extra thread: its own conversation's lock is
/// on its unit (the Gone lock check reads it) as soon as the create is
/// answered, under the Codex home the app-server reported, and the paths
/// follow the threads the app-server holds. The server's own Codex home
/// moving afterwards changes nothing (Stage 2: LB-29).
#[tokio::test(flavor = "multi_thread")]
async fn a_panes_own_conversation_lock_is_on_its_unit_under_the_home_codex_reported() {
    let h = UnitHarness::start(HarnessOpts {
        behavior: json!({"turnCompleteDelayMs": 60000,
                         "helperThreadOnTurn": {"id": "t-solo-help", "durationMs": 60000}}),
        ..Default::default()
    })
    .await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-solo", Some("t-solo")).await;
    assert_eq!(
        lock_paths(&h, &tid),
        locks_under(&h.codex_home, &["t-solo"]),
        "the pane's own conversation, before any extra thread"
    );

    let elsewhere = h.home.path().join("elsewhere");
    std::env::set_var("CODEX_HOME", &elsewhere);
    std::env::set_var("HOME", &elsewhere);
    tui_ready(&h, &mut ws).await;
    h.send(
        &mut ws,
        json!({"type": "terminal.input", "terminalId": tid, "data": "turn go\r"}),
    )
    .await;
    eventually("the helper is held", || live_under(&h, "t-solo-help", &tid)).await;
    assert_eq!(
        lock_paths(&h, &tid),
        locks_under(&h.codex_home, &["t-solo", "t-solo-help"]),
        "under the home the app-server reported, not the server's own"
    );
}

/// A fresh pane learns its conversation when Codex starts it: the adopted
/// conversation's lock joins the unit's lock paths.
#[tokio::test(flavor = "multi_thread")]
async fn a_fresh_panes_lock_paths_follow_the_conversation_it_adopts() {
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-fresh-locks", None).await;
    eventually("the pane adopts its conversation", || {
        h.state.identity.session_ref_for(&tid).is_some()
    })
    .await;
    let main = h
        .state
        .identity
        .session_ref_for(&tid)
        .expect("adopted")
        .session_id;
    eventually("the adopted conversation's lock is on the unit", || {
        lock_paths(&h, &tid) == locks_under(&h.codex_home, &[main.as_str()])
    })
    .await;
}

/// The read right before a stop's first signal (Stage 2: LB-51): a thread
/// the app-server loaded after the pane was up, which no event announced,
/// is on the unit before anything is signalled, so it goes through
/// Stopping with the pane's own conversation and is Vacant at the answer.
#[tokio::test(flavor = "multi_thread")]
async fn a_thread_loaded_without_an_announcement_goes_through_stopping() {
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-quiet", Some("t-loud")).await;
    tui_ready(&h, &mut ws).await;
    let url = CodexTerminalLaunchManager::global()
        .sidecar_ws_url(&tid)
        .expect("the app-server's own address");
    let port: u16 = url
        .rsplit(':')
        .next()
        .and_then(|port| port.trim_end_matches('/').parse().ok())
        .unwrap_or_else(|| panic!("a port in {url}"));
    let mut second_client = fake_codex::Rpc::connect(port).await;
    second_client
        .call("fixture/loadThread", json!({"threadId": "t-quiet"}))
        .await
        .expect("the app-server loads the thread");
    assert!(fake_codex::holds_lock_fd(
        h.native_pid(&tid),
        &h.lock("t-quiet")
    ));
    assert!(vacant(&h, "t-quiet"), "nothing announced the thread");

    h.send(
        &mut ws,
        json!({"type": "terminal.kill", "terminalId": tid, "requestId": "rk-quiet", "createRequestId": "crq-quiet"}),
    )
    .await;
    let stopping = std::cell::Cell::new(false);
    let killed = h
        .next_matching(&mut ws, Duration::from_secs(15), |f| {
            if f["type"] == "session.runtimeOwner"
                && f["sessionId"] == "t-quiet"
                && f["transition"] == "stopping"
            {
                stopping.set(true);
            }
            f["type"] == "terminal.killed" && f["requestId"] == "rk-quiet"
        })
        .await
        .expect("the kill is answered");
    assert_eq!(killed["success"], true, "{killed}");
    assert!(
        stopping.get(),
        "the unannounced thread went through Stopping with the pane"
    );
    assert!(vacant(&h, "t-quiet"));
    assert!(!fake_codex::lock_held(&h.lock("t-quiet")));
}

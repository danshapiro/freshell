//! Killed panes are remembered (Task 18; Stage 2: LB-36, LB-22): a stop a
//! person asked for (Shift-X, a kill command, a cleanup stop) or a clean
//! quit writes a durable stopped-pane record at Gone, before the exit is
//! published, so a late or offline device is told "stopped" instead of
//! re-creating the conversation: an attach to the terminal answers
//! `INVALID_TERMINAL_ID` with `terminalStopped: true`, a reconcile answers
//! the `stopped` verdict, and a create still carrying the pane's
//! createRequestId is refused as stopped and spawns nothing. A reopen mints a
//! new createRequestId and is never matched; a crash is never remembered.
#![cfg(target_os = "linux")]
#[path = "support/unit_harness.rs"]
mod unit_harness;

use std::time::Duration;

use freshell_ws::pane_ledger::{StoppedPaneRecord, LEDGER_VERSION, STOPPED_KIND_TERMINAL};
use serde_json::json;
use unit_harness::{fake_codex, AutoResumeMode, HarnessOpts, TestWs, UnitHarness};

const LIMIT: Duration = Duration::from_secs(15);

/// The harness with an enabled pane ledger (as `main.rs` runs it).
fn with_ledger(opts: HarnessOpts) -> HarnessOpts {
    HarnessOpts {
        pane_ledger: true,
        ..opts
    }
}

async fn killed_pane(h: &UnitHarness) -> String {
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-m", Some("t-mem")).await;
    h.send(
        &mut ws,
        json!({"type": "terminal.kill", "terminalId": tid, "requestId": "rk", "createRequestId": "crq-m"}),
    )
    .await;
    let killed = h
        .next_matching(&mut ws, Duration::from_secs(10), |f| {
            f["type"] == "terminal.killed" && f["requestId"] == "rk"
        })
        .await
        .expect("the kill is answered");
    assert_eq!(killed["success"], true, "{killed}");
    tid
}

/// Sends a `pane.reconcile.request` for `pane` and returns its verdict.
async fn reconcile_one(
    h: &UnitHarness,
    ws: &mut TestWs,
    reconcile_id: &str,
    pane: serde_json::Value,
) -> serde_json::Value {
    h.send(
        ws,
        json!({"type": "pane.reconcile.request", "reconcileId": reconcile_id, "panes": [pane]}),
    )
    .await;
    let result = h
        .next_matching(ws, LIMIT, |f| {
            f["type"] == "pane.reconcile.result" && f["reconcileId"] == reconcile_id
        })
        .await
        .expect("the reconcile is answered");
    result["verdicts"][0].clone()
}

fn codex_pane(
    terminal_id: Option<&str>,
    create_request_id: &str,
    session_id: &str,
) -> serde_json::Value {
    let mut pane = json!({
        "paneKey": format!("tab-1:{create_request_id}"),
        "kind": "terminal",
        "mode": "codex",
        "createRequestId": create_request_id,
        "sessionRef": {"provider": "codex", "sessionId": session_id},
    });
    if let Some(terminal_id) = terminal_id {
        pane["terminalId"] = json!(terminal_id);
    }
    pane
}

/// A `terminal.create` of the Codex conversation `session_id` under `crq`.
fn codex_create(h: &UnitHarness, crq: &str, session_id: &str, restore: bool) -> serde_json::Value {
    let mut create = json!({
        "type": "terminal.create",
        "requestId": crq,
        "mode": "codex",
        "shell": "system",
        "cwd": h.home.path().display().to_string(),
        "sessionRef": {"provider": "codex", "sessionId": session_id},
    });
    if restore {
        create["restore"] = json!(true);
    }
    create
}

/// Sends `create` and asserts it is refused as a stopped pane and spawns
/// nothing.
async fn assert_create_refused_as_stopped(
    h: &UnitHarness,
    ws: &mut TestWs,
    create: serde_json::Value,
) {
    let crq = create["requestId"].as_str().expect("requestId").to_string();
    let terminals_before = h.state.registry.identity_probe_rows().len();
    let launches_before = manifest_count(h);
    h.send(ws, create).await;
    let answer = h
        .next_matching(ws, LIMIT, |f| {
            f["requestId"] == crq.as_str()
                && (f["type"] == "terminal.created" || f["type"] == "error")
        })
        .await
        .expect("the create is answered");
    assert_eq!(answer["type"], "error", "the create is refused: {answer}");
    assert_eq!(answer["code"], "INVALID_TERMINAL_ID", "{answer}");
    assert_eq!(answer["terminalStopped"], true, "{answer}");
    assert!(
        h.next_matching(ws, Duration::from_millis(500), |f| {
            f["type"] == "terminal.created" && f["requestId"] == crq.as_str()
        })
        .await
        .is_none(),
        "no terminal is created for the stopped pane"
    );
    assert_eq!(
        h.state.registry.identity_probe_rows().len(),
        terminals_before,
        "no terminal was spawned"
    );
    assert_eq!(
        manifest_count(h),
        launches_before,
        "no app-server was started"
    );
}

/// How many processes the fake Codex has started (one manifest each).
fn manifest_count(h: &UnitHarness) -> usize {
    std::fs::read_dir(&h.manifests)
        .map(|entries| entries.flatten().count())
        .unwrap_or(0)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_late_attach_to_a_killed_pane_is_told_it_was_stopped() {
    let h = UnitHarness::start(with_ledger(HarnessOpts::default())).await;
    let tid = killed_pane(&h).await;
    let mut late = h.connect().await; // device B, hidden pane, never subscribed
    h.send(
        &mut late,
        json!({"type": "terminal.attach", "terminalId": tid, "attachRequestId": "ra",
            "intent": "viewport_hydrate", "cols": 120, "rows": 30}),
    )
    .await;
    let err = h
        .next_matching(&mut late, Duration::from_secs(5), |f| {
            f["type"] == "error" && f["terminalId"] == tid.as_str()
        })
        .await
        .expect("the attach is answered");
    assert_eq!(err["code"], "INVALID_TERMINAL_ID", "{err}");
    assert_eq!(err["terminalStopped"], true, "{err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_offline_device_reconciling_a_killed_pane_gets_stopped_not_respawn() {
    let h = UnitHarness::start(with_ledger(HarnessOpts::default())).await;
    let tid = killed_pane(&h).await;
    let mut offline = h.connect().await;
    let verdict = reconcile_one(
        &h,
        &mut offline,
        "rr",
        codex_pane(Some(&tid), "crq-m", "t-mem"),
    )
    .await;
    assert_eq!(verdict["verdict"], "stopped", "{verdict}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_create_carrying_the_killed_create_request_id_is_told_stopped() {
    let h = UnitHarness::start(with_ledger(HarnessOpts::default())).await;
    let tid = killed_pane(&h).await;
    let mut other = h.connect().await;
    // A held create re-sent on reconnect, and the same pane's restore.
    assert_create_refused_as_stopped(&h, &mut other, codex_create(&h, "crq-m", "t-mem", false))
        .await;
    assert_create_refused_as_stopped(&h, &mut other, codex_create(&h, "crq-m", "t-mem", true))
        .await;
    let record = h
        .state
        .pane_ledger
        .stopped_pane_for_create_request("crq-m")
        .expect("the refused creates never clear the record");
    assert_eq!(record.terminal_id.as_deref(), Some(tid.as_str()));
    assert_eq!(record.reason, "shift-x");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_reopen_with_a_new_create_request_id_is_not_stopped() {
    let h = UnitHarness::start(with_ledger(HarnessOpts::default())).await;
    killed_pane(&h).await;
    let mut ws = h.connect().await;
    let reopened = h.create_codex(&mut ws, "crq-reopen", Some("t-mem")).await;
    let verdict = reconcile_one(
        &h,
        &mut ws,
        "rr-reopen",
        codex_pane(Some(&reopened), "crq-reopen", "t-mem"),
    )
    .await;
    assert_eq!(verdict["verdict"], "attach", "{verdict}");
    assert_eq!(verdict["terminalId"], reopened.as_str(), "{verdict}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_clean_quit_is_remembered_and_a_crash_is_not() {
    let mut h = UnitHarness::start(with_ledger(HarnessOpts {
        auto_resume: AutoResumeMode::Capture,
        ..Default::default()
    }))
    .await;
    let mut ws = h.connect().await;

    let quit = h.create_codex(&mut ws, "crq-q", Some("t-q")).await;
    h.next_matching(&mut ws, LIMIT, |f| {
        f["type"] == "terminal.output"
            && f["terminalId"] == quit.as_str()
            && f["data"]
                .as_str()
                .is_some_and(|d| d.contains("FAKE_TUI_READY"))
    })
    .await
    .expect("the TUI is ready");
    tokio::time::timeout(LIMIT, h.state.units.start_settled(h.unit_for(&quit).id()))
        .await
        .expect("the start settled");
    h.send(
        &mut ws,
        json!({"type": "terminal.input", "terminalId": quit, "data": "quit\r"}),
    )
    .await;
    let exit = h
        .next_matching(&mut ws, LIMIT, |f| {
            f["type"] == "terminal.exit" && f["terminalId"] == quit.as_str()
        })
        .await
        .expect("the quit ends the pane");
    assert_eq!(exit["exitCode"], 0, "{exit}");
    let verdict = reconcile_one(&h, &mut ws, "rr-q", codex_pane(Some(&quit), "crq-q", "t-q")).await;
    assert_eq!(
        verdict["verdict"], "stopped",
        "a clean quit is remembered: {verdict}"
    );

    let crashed = h.create_codex(&mut ws, "crq-x", Some("t-x")).await;
    tokio::time::timeout(
        LIMIT,
        h.state.units.start_settled(h.unit_for(&crashed).id()),
    )
    .await
    .expect("the start settled");
    h.kill_native(&crashed);
    h.next_matching(&mut ws, LIMIT, |f| {
        f["type"] == "terminal.exit" && f["terminalId"] == crashed.as_str()
    })
    .await
    .expect("the app-server's death ends the pane");
    tokio::time::timeout(LIMIT, h.crash_rx.as_mut().unwrap().recv())
        .await
        .expect("the crash reaches auto-resume")
        .expect("a crash event");
    let verdict = reconcile_one(
        &h,
        &mut ws,
        "rr-x",
        codex_pane(Some(&crashed), "crq-x", "t-x"),
    )
    .await;
    assert_ne!(
        verdict["verdict"], "stopped",
        "a crash is not remembered: {verdict}"
    );
    assert!(h
        .state
        .pane_ledger
        .stopped_pane_for_terminal(&crashed)
        .is_none());
    assert!(h
        .state
        .pane_ledger
        .stopped_pane_for_create_request("crq-x")
        .is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_kill_of_a_starting_pane_is_remembered_by_create_request_id() {
    let h = UnitHarness::start(with_ledger(HarnessOpts {
        behavior: json!({"listenDelayMs": 3000}),
        ..Default::default()
    }))
    .await;
    let mut ws = h.connect().await;
    h.seed_rollout("t-s");
    h.send(&mut ws, codex_create(&h, "crq-s", "t-s", true))
        .await;
    // The launcher and the native are spawned, not yet listening.
    let manifests = h.manifests.clone();
    fake_codex::wait_until(
        "the start is under way",
        Duration::from_secs(10),
        move || {
            std::fs::read_dir(&manifests)
                .map(|entries| entries.flatten().count() >= 2)
                .unwrap_or(false)
        },
    )
    .await;
    h.send(
        &mut ws,
        json!({"type": "terminal.kill", "requestId": "rks", "createRequestId": "crq-s"}),
    )
    .await;
    let killed = h
        .next_matching(&mut ws, LIMIT, |f| {
            f["type"] == "terminal.killed" && f["requestId"] == "rks"
        })
        .await
        .expect("the kill is answered");
    assert_eq!(killed["success"], true, "{killed}");

    let record = h
        .state
        .pane_ledger
        .stopped_pane_for_create_request("crq-s")
        .expect("the starting pane is remembered");
    assert_eq!(
        record.terminal_id, None,
        "it never bound a terminal: {record:?}"
    );
    let verdict = reconcile_one(
        &h,
        &mut ws,
        "rr-s",
        json!({"paneKey": "tab-1:crq-s", "kind": "terminal", "mode": "codex",
            "createRequestId": "crq-s", "sessionRef": {"provider": "codex", "sessionId": "t-s"}}),
    )
    .await;
    assert_eq!(verdict["verdict"], "stopped", "{verdict}");
}

/// The memory is durable: a stop recorded before a restart (a record this
/// server never held in memory) is still answered "stopped" by the attach,
/// the create (interactive and restore) and the reconcile.
#[tokio::test(flavor = "multi_thread")]
async fn a_pane_stopped_before_a_restart_is_still_answered_stopped() {
    let h = UnitHarness::start(with_ledger(HarnessOpts::default())).await;
    h.state
        .pane_ledger
        .record_stopped_pane(&StoppedPaneRecord {
            ledger_version: LEDGER_VERSION,
            terminal_id: Some("0123456789abcdef0123456789abcdef".into()),
            create_request_id: Some("crq-before".into()),
            provider: Some("codex".into()),
            session_id: Some("t-before".into()),
            kind: STOPPED_KIND_TERMINAL.into(),
            reason: "shift-x".into(),
            stopped_at_ms: 1,
        })
        .expect("the earlier server's record");
    assert!(
        !h.state.units.killed_start("crq-before"),
        "this server never saw the kill"
    );
    let mut ws = h.connect().await;

    h.send(
        &mut ws,
        json!({"type": "terminal.attach", "terminalId": "0123456789abcdef0123456789abcdef",
            "attachRequestId": "ra-before", "intent": "viewport_hydrate", "cols": 120, "rows": 30}),
    )
    .await;
    let err = h
        .next_matching(&mut ws, LIMIT, |f| {
            f["type"] == "error" && f["requestId"] == "ra-before"
        })
        .await
        .expect("the attach is answered");
    assert_eq!(err["terminalStopped"], true, "{err}");

    assert_create_refused_as_stopped(
        &h,
        &mut ws,
        codex_create(&h, "crq-before", "t-before", false),
    )
    .await;
    assert_create_refused_as_stopped(
        &h,
        &mut ws,
        codex_create(&h, "crq-before", "t-before", true),
    )
    .await;

    let verdict = reconcile_one(
        &h,
        &mut ws,
        "rr-before",
        codex_pane(
            Some("0123456789abcdef0123456789abcdef"),
            "crq-before",
            "t-before",
        ),
    )
    .await;
    assert_eq!(verdict["verdict"], "stopped", "{verdict}");
    let verdict = reconcile_one(
        &h,
        &mut ws,
        "rr-before-crq",
        codex_pane(None, "crq-before", "t-before"),
    )
    .await;
    assert_eq!(
        verdict["verdict"], "stopped",
        "by createRequestId alone: {verdict}"
    );
}

/// A cleanup stop (the idle reaper's) is a stop the server decided for the
/// person: it is remembered like a kill, so other devices show the pane
/// stopped instead of re-creating it.
#[tokio::test(flavor = "multi_thread")]
async fn a_cleanup_stop_is_remembered() {
    let h = UnitHarness::start(with_ledger(HarnessOpts::default())).await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-idle", Some("t-idle")).await;
    let unit_id = h.unit_for(&tid).id().as_str().to_string();
    let hook =
        freshell_ws::unit_lifecycle::kill_hook(h.state.clone(), tokio::runtime::Handle::current());
    assert!(hook(&tid, &unit_id, "idle"), "the idle reap stops the unit");
    h.next_matching(&mut ws, LIMIT, |f| {
        f["type"] == "terminal.exit" && f["terminalId"] == tid.as_str()
    })
    .await
    .expect("the cleanup stop ends the pane");
    let record = h
        .state
        .pane_ledger
        .stopped_pane_for_terminal(&tid)
        .expect("the cleaned-up pane is remembered");
    assert_eq!(record.reason, "cleanup");
    assert_eq!(record.create_request_id.as_deref(), Some("crq-idle"));
}

/// A kill the server runs as an internal teardown (a failed create's
/// cleanup, a replaced respawn, the ownership watchdog: the registry's kill
/// hook, `kill-command` with no request to remember the pane) is not a
/// person's stop: nothing is remembered, so the pane's createRequestId can
/// still start it.
#[tokio::test(flavor = "multi_thread")]
async fn an_internal_teardown_kill_is_not_remembered() {
    let h = UnitHarness::start(with_ledger(HarnessOpts::default())).await;
    let mut ws = h.connect().await;
    let tid = h
        .create_codex(&mut ws, "crq-internal", Some("t-internal"))
        .await;
    assert!(
        h.state.registry.kill(&tid),
        "the registry kill stops the unit"
    );
    h.next_matching(&mut ws, LIMIT, |f| {
        f["type"] == "terminal.exit" && f["terminalId"] == tid.as_str()
    })
    .await
    .expect("the teardown ends the pane");
    assert!(h
        .state
        .pane_ledger
        .stopped_pane_for_terminal(&tid)
        .is_none());
    assert!(h
        .state
        .pane_ledger
        .stopped_pane_for_create_request("crq-internal")
        .is_none());
    let verdict = reconcile_one(
        &h,
        &mut ws,
        "rr-internal",
        codex_pane(Some(&tid), "crq-internal", "t-internal"),
    )
    .await;
    assert_ne!(verdict["verdict"], "stopped", "{verdict}");
}

/// A person's kill that joins a stop already running for another reason (an
/// internal teardown's `kill-command`, which the kill does not take over) is
/// still remembered: the joining kill asks for the memory, and the stop's
/// Gone honours it.
#[tokio::test(flavor = "multi_thread")]
async fn a_kill_that_joins_an_internal_stop_is_remembered() {
    let h = UnitHarness::start(with_ledger(HarnessOpts::default())).await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-join", Some("t-join")).await;
    let _gone = unit_harness::GoneDelay::set(1500);
    assert!(
        h.state.registry.kill(&tid),
        "the internal teardown stops the unit"
    );
    assert!(
        h.unit_for(&tid).stop_in_flight().is_some(),
        "the internal stop runs"
    );
    h.send(
        &mut ws,
        json!({"type": "terminal.kill", "terminalId": tid, "requestId": "rk-join", "createRequestId": "crq-join"}),
    )
    .await;
    let killed = h
        .next_matching(&mut ws, LIMIT, |f| {
            f["type"] == "terminal.killed" && f["requestId"] == "rk-join"
        })
        .await
        .expect("the joining kill is answered at Gone");
    assert_eq!(killed["success"], true, "{killed}");
    let record = h
        .state
        .pane_ledger
        .stopped_pane_for_terminal(&tid)
        .expect("the person's kill is remembered");
    assert_eq!(
        record.reason, "kill-command",
        "the stop kept its first reason"
    );
    assert_eq!(record.create_request_id.as_deref(), Some("crq-join"));
}

/// Waits (bounded) until `f` holds.
async fn eventually(what: &str, f: impl Fn() -> bool) {
    let deadline = tokio::time::Instant::now() + LIMIT;
    while !f() {
        assert!(tokio::time::Instant::now() < deadline, "timed out: {what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// Releases the pane ledger's test-only close hold however the test ends
/// (a held close otherwise blocks a runtime thread past the test).
struct ReleaseCloseHold(std::sync::Arc<freshell_ws::pane_ledger::ClosePauseGate>);

impl ReleaseCloseHold {
    fn release(&self) {
        let mut paused = self.0.paused.lock().expect("close hold lock");
        *paused = false;
        self.0.release.notify_all();
    }
}

impl Drop for ReleaseCloseHold {
    fn drop(&mut self) {
        self.release();
    }
}

/// A kill naming only a createRequestId whose pane is nowhere (never
/// started here, or long gone) is remembered durably by that
/// createRequestId, so after a restart a create still carrying it is told
/// "stopped" too, not only until this server stops (review M1b).
#[tokio::test(flavor = "multi_thread")]
async fn a_kill_of_a_create_request_id_that_finds_nothing_is_remembered_durably() {
    let h = UnitHarness::start(with_ledger(HarnessOpts::default())).await;
    let mut ws = h.connect().await;
    h.send(
        &mut ws,
        json!({"type": "terminal.kill", "requestId": "rk-none", "createRequestId": "crq-none"}),
    )
    .await;
    h.next_matching(&mut ws, LIMIT, |f| {
        f["type"] == "terminal.killed" && f["requestId"] == "rk-none"
    })
    .await
    .expect("the kill is answered");
    let record = h
        .state
        .pane_ledger
        .stopped_pane_for_create_request("crq-none")
        .expect("the killed createRequestId is remembered durably");
    assert_eq!(record.terminal_id, None, "{record:?}");
    assert_eq!(record.kind, STOPPED_KIND_TERMINAL);
}

/// A person's kill that reaches a stopping pane but joins the stop only
/// after that stop's Gone was published (here the kill's durable pane close
/// is held until an app-server crash has ended the pane) is still
/// remembered, by the kill's own terminal id and createRequestId, before it
/// is answered (review M1c).
#[tokio::test(flavor = "multi_thread")]
async fn a_kill_joining_a_stop_after_its_gone_is_still_remembered() {
    let mut h = UnitHarness::start(with_ledger(HarnessOpts {
        auto_resume: AutoResumeMode::Capture,
        ..Default::default()
    }))
    .await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-late", Some("t-late")).await;
    tokio::time::timeout(LIMIT, h.state.units.start_settled(h.unit_for(&tid).id()))
        .await
        .expect("the start settled");
    let unit = h.unit_for(&tid);
    let _gone = unit_harness::GoneDelay::set(3000);
    let hold = ReleaseCloseHold(h.state.pane_ledger.arm_close_pause_for_tests());

    h.kill_native(&tid);
    eventually("the crash stop runs", || unit.stop_in_flight().is_some()).await;
    // The kill finds the stopping pane, and its durable close is held.
    h.send(
        &mut ws,
        json!({"type": "terminal.kill", "terminalId": tid, "requestId": "rk-late", "createRequestId": "crq-late"}),
    )
    .await;
    // The crash's stop ends the pane without the kill: its Gone was
    // published, and its crash event sent, before the kill joined.
    tokio::time::timeout(LIMIT, h.crash_rx.as_mut().unwrap().recv())
        .await
        .expect("the crash's Gone is published")
        .expect("a crash event");
    assert!(
        h.state
            .pane_ledger
            .stopped_pane_for_terminal(&tid)
            .is_none(),
        "the crash's Gone remembered nothing"
    );
    hold.release();

    let killed = h
        .next_matching(&mut ws, LIMIT, |f| {
            f["type"] == "terminal.killed" && f["requestId"] == "rk-late"
        })
        .await
        .expect("the late kill is answered");
    assert_eq!(killed["success"], true, "{killed}");
    let record = h
        .state
        .pane_ledger
        .stopped_pane_for_terminal(&tid)
        .expect("the person's kill is remembered");
    assert_eq!(record.create_request_id.as_deref(), Some("crq-late"));
    assert_eq!(record.reason, "shift-x");
    assert!(h
        .state
        .pane_ledger
        .stopped_pane_for_create_request("crq-late")
        .is_some());
}

/// A person's kill that joins the stop of a pane whose unit the server
/// knows by no createRequestId (a unit registered without one) is
/// remembered by the kill's own createRequestId as well as by its
/// terminal, so a create still carrying that createRequestId is told
/// "stopped" (review M1d).
#[tokio::test(flavor = "multi_thread")]
async fn a_kill_joining_the_stop_of_a_unit_with_no_create_request_id_remembers_its_own() {
    let h = UnitHarness::start(with_ledger(HarnessOpts::default())).await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-own", Some("t-own")).await;
    tokio::time::timeout(LIMIT, h.state.units.start_settled(h.unit_for(&tid).id()))
        .await
        .expect("the start settled");
    let entry = h.state.units.by_terminal(&tid).expect("the pane's unit");
    h.state.units.register(freshell_containment::UnitEntry {
        create_request_id: None,
        ..entry
    });
    let _gone = unit_harness::GoneDelay::set(1500);
    assert!(
        h.state.registry.kill(&tid),
        "an internal teardown stops the unit"
    );
    assert!(
        h.unit_for(&tid).stop_in_flight().is_some(),
        "the internal stop runs"
    );
    h.send(
        &mut ws,
        json!({"type": "terminal.kill", "terminalId": tid, "requestId": "rk-own", "createRequestId": "crq-own"}),
    )
    .await;
    let killed = h
        .next_matching(&mut ws, LIMIT, |f| {
            f["type"] == "terminal.killed" && f["requestId"] == "rk-own"
        })
        .await
        .expect("the joining kill is answered at Gone");
    assert_eq!(killed["success"], true, "{killed}");
    assert!(
        h.state
            .pane_ledger
            .stopped_pane_for_terminal(&tid)
            .is_some(),
        "the pane is remembered by its terminal"
    );
    let record = h
        .state
        .pane_ledger
        .stopped_pane_for_create_request("crq-own")
        .expect("the kill's own createRequestId is remembered");
    assert_eq!(record.kind, STOPPED_KIND_TERMINAL);
}

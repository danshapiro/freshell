//! A request that must wait for a conversation's Gone is PARKED, never
//! awaited inline: the connection's message loop and its serial create
//! worker keep serving while a reopen waits, a parked reopen dies with its
//! connection, and a kill that joins a crash's stop beats auto-resume
//! (Stage 2: LB-20, LB-31, LB-36).
//!
//! Its own test binary: Gone of every unit stop is held about 3 s through
//! the containment's process-wide test hook.
#![cfg(target_os = "linux")]
#[path = "support/unit_harness.rs"]
mod unit_harness;

use std::time::{Duration, Instant};

use freshell_terminal::UnitEnding;
use serde_json::json;
use unit_harness::{fake_codex, AutoResumeMode, GoneDelay, HarnessOpts, TestWs, UnitHarness};

const GONE_DELAY_MS: u64 = 3000;

async fn tui_ready(h: &UnitHarness, ws: &mut TestWs) {
    h.next_matching(ws, Duration::from_secs(10), |f| {
        f["type"] == "terminal.output"
            && f["data"]
                .as_str()
                .is_some_and(|d| d.contains("FAKE_TUI_READY"))
    })
    .await
    .expect("the TUI is ready");
}

async fn eventually(what: &str, limit: Duration, f: impl Fn() -> bool) {
    let deadline = tokio::time::Instant::now() + limit;
    while !f() {
        assert!(tokio::time::Instant::now() < deadline, "timed out: {what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// Waits until the pane's start settled (its screen's placement confirmed):
/// an exit before that is a typed start failure, never a crash.
async fn start_settled(h: &UnitHarness, tid: &str) {
    eventually("the pane's start settles", Duration::from_secs(10), || {
        h.state
            .units
            .by_terminal(tid)
            .is_some_and(|entry| h.state.units.start_is_settled(entry.unit.id()))
    })
    .await;
}

/// A shell pane on `ws`, attached.
async fn create_shell(h: &UnitHarness, ws: &mut TestWs, crq: &str) -> String {
    h.send(
        ws,
        json!({"type": "terminal.create", "requestId": crq, "mode": "shell", "shell": "system",
            "cwd": h.home.path().display().to_string()}),
    )
    .await;
    let created = h
        .next_matching(ws, Duration::from_secs(10), |f| {
            f["requestId"] == crq && (f["type"] == "terminal.created" || f["type"] == "error")
        })
        .await
        .expect("the shell create is answered");
    assert_eq!(created["type"], "terminal.created", "{created}");
    let tid = created["terminalId"].as_str().unwrap().to_string();
    h.attach(ws, &tid).await;
    tid
}

fn reopen(crq: &str, session: &str) -> serde_json::Value {
    json!({"type": "terminal.create", "requestId": crq, "mode": "codex", "shell": "system",
        "sessionRef": {"provider": "codex", "sessionId": session}})
}

/// Codex pane A (resume `t-pk`) and shell pane C on one connection; A is
/// Shift-X killed (its Gone is held). Returns (A, C, A's native pid and
/// start time).
async fn pane_a_killed_and_shell_c(h: &UnitHarness, ws: &mut TestWs) -> (String, String, u32, u64) {
    let a = h.create_codex(ws, "crq-a", Some("t-pk")).await;
    tui_ready(h, ws).await;
    let c = create_shell(h, ws, "crq-sh").await;
    let native = h.native_pid(&a);
    let native_start = h.native_manifest(&a).start_time(native);
    h.send(
        ws,
        json!({"type": "terminal.kill", "terminalId": a, "requestId": "rk-a", "createRequestId": "crq-a"}),
    )
    .await;
    (a, c, native, native_start)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_parked_reopen_does_not_block_its_connection() {
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let _gone = GoneDelay::set(GONE_DELAY_MS);
    let mut ws = h.connect().await;
    let (_a, c, native, native_start) = pane_a_killed_and_shell_c(&h, &mut ws).await;

    h.send(&mut ws, reopen("crq-b", "t-pk")).await;
    let sent = Instant::now();
    h.send(
        &mut ws,
        json!({"type": "terminal.input", "terminalId": c, "data": "echo PING\r"}),
    )
    .await;
    h.send(
        &mut ws,
        json!({"type": "terminal.create", "requestId": "crq-c", "mode": "shell", "shell": "system",
            "cwd": h.home.path().display().to_string()}),
    )
    .await;

    let mut ping_at = None;
    let mut crq_c_at = None;
    let mut crq_b = None;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while crq_b.is_none() {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let frame = h
            .next_matching(&mut ws, remaining, |f| {
                (f["type"] == "terminal.output"
                    && f["terminalId"] == c.as_str()
                    && f["data"].as_str().is_some_and(|d| d.contains("PING")))
                    || f["requestId"] == "crq-c"
                    || f["requestId"] == "crq-b"
            })
            .await
            .expect("every request is answered");
        if frame["requestId"] == "crq-b" {
            assert_ne!(frame["code"], "SESSION_RESERVED", "never refused: {frame}");
            assert_eq!(frame["type"], "terminal.created", "{frame}");
            assert!(
                fake_codex::proc_starttime(native) != Some(native_start),
                "crq-b is created only after A's native exited"
            );
            assert!(ping_at.is_some(), "C's output came before crq-b's answer");
            assert!(crq_c_at.is_some(), "crq-c was answered before crq-b");
            crq_b = Some(frame);
        } else if frame["requestId"] == "crq-c" {
            assert_eq!(frame["type"], "terminal.created", "{frame}");
            crq_c_at.get_or_insert(sent.elapsed());
        } else {
            ping_at.get_or_insert(sent.elapsed());
        }
    }
    let ping_at = ping_at.unwrap();
    let crq_c_at = crq_c_at.unwrap();
    assert!(
        ping_at <= Duration::from_secs(1),
        "the loop served C's input at once ({ping_at:?})"
    );
    assert!(
        crq_c_at <= Duration::from_secs(2),
        "the create worker served crq-c while crq-b waited ({crq_c_at:?})"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_parked_reopen_dies_with_its_connection() {
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let _gone = GoneDelay::set(GONE_DELAY_MS);
    let mut ws = h.connect().await;
    let (_a, _c, native, native_start) = pane_a_killed_and_shell_c(&h, &mut ws).await;
    h.send(&mut ws, reopen("crq-b", "t-pk")).await;
    eventually("crq-b is parked", Duration::from_secs(5), || {
        h.state.gone_waits.is_parked("crq-b")
    })
    .await;
    drop(ws);
    eventually(
        "the parked reopen died with its connection",
        Duration::from_secs(5),
        || !h.state.gone_waits.is_parked("crq-b"),
    )
    .await;

    eventually("A's native exited (Gone)", Duration::from_secs(15), || {
        fake_codex::proc_starttime(native) != Some(native_start)
    })
    .await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(h
        .state
        .registry
        .terminal_for_create_request("crq-b")
        .is_none());
    assert!(h.state.units.by_create_request("crq-b").is_none());
}

/// A crash's stop (an agent exit) is in flight when a kill joins it: the kill
/// takes the stop over and the crash is never auto-resumed (no replacement,
/// nothing left under the pane's create-request id).
///
/// Before Task 17 a crash of the TUI ends the unit as an agent exit (Task 17
/// makes it a screen restart and detects the app-server's own death; this
/// test's crash then moves to the native app-server).
#[tokio::test(flavor = "multi_thread")]
async fn a_kill_racing_an_app_server_crash_wins_over_auto_resume() {
    let h = UnitHarness::start(HarnessOpts {
        behavior: json!({"turnCompleteDelayMs": 60000}),
        auto_resume: AutoResumeMode::Hub,
        ..Default::default()
    })
    .await;
    let _gone = GoneDelay::set(GONE_DELAY_MS);
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-ar", Some("t-ar")).await;
    tui_ready(&h, &mut ws).await;
    start_settled(&h, &tid).await;
    h.send(
        &mut ws,
        json!({"type": "terminal.input", "terminalId": tid, "data": "turn go\r"}),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    h.send(
        &mut ws,
        json!({"type": "terminal.input", "terminalId": tid, "data": "crash\r"}),
    )
    .await;
    eventually(
        "the crash's stop is in flight",
        Duration::from_secs(10),
        || {
            matches!(
                h.state.registry.ending(&tid),
                Some(UnitEnding::AgentExited { .. })
            )
        },
    )
    .await;
    h.send(
        &mut ws,
        json!({"type": "terminal.kill", "terminalId": tid, "requestId": "rk", "createRequestId": "crq-ar"}),
    )
    .await;
    let killed = h
        .next_matching(&mut ws, Duration::from_secs(15), |f| {
            f["type"] == "terminal.killed" && f["requestId"] == "rk"
        })
        .await
        .expect("the kill is answered");
    assert_eq!(killed["success"], true, "{killed}");
    let resumed = h
        .next_matching(&mut ws, Duration::from_secs(2), |f| {
            f["type"] == "terminal.replaced"
                || (f["type"] == "terminal.created" && f["requestId"] == "crq-ar")
                || (f["type"] == "terminal.status" && f["status"] == "recovering")
        })
        .await;
    assert!(resumed.is_none(), "never auto-resumed: {resumed:?}");
    assert!(h.state.units.by_create_request("crq-ar").is_none());
    assert!(h
        .state
        .registry
        .terminal_for_create_request("crq-ar")
        .is_none());
}

/// A stuck restart (a kill that keeps the conversation resumable) joining a
/// crash's stop does not take the stop over, so the crash still reaches the
/// auto-resume hub; the kill cancels that auto-resume (keyed by the crashed
/// terminal), so the user's restart is the pane's only replacement: the hub
/// settles the old terminal "auto-resume cancelled" and starts nothing
/// (Stage 2: LB-36).
#[tokio::test(flavor = "multi_thread")]
async fn a_stuck_restart_racing_a_crash_cancels_its_auto_resume() {
    let h = UnitHarness::start(HarnessOpts {
        behavior: json!({"turnCompleteDelayMs": 60000}),
        auto_resume: AutoResumeMode::Hub,
        ..Default::default()
    })
    .await;
    let _gone = GoneDelay::set(GONE_DELAY_MS);
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-sr", Some("t-sr")).await;
    tui_ready(&h, &mut ws).await;
    start_settled(&h, &tid).await;
    h.send(
        &mut ws,
        json!({"type": "terminal.input", "terminalId": tid, "data": "crash\r"}),
    )
    .await;
    eventually(
        "the crash's stop is in flight",
        Duration::from_secs(10),
        || {
            matches!(
                h.state.registry.ending(&tid),
                Some(UnitEnding::AgentExited { .. })
            )
        },
    )
    .await;
    h.send(
        &mut ws,
        json!({"type": "terminal.kill", "terminalId": tid, "requestId": "rk", "createRequestId": "crq-sr",
            "reason": "stuck-recovery"}),
    )
    .await;
    let killed = h
        .next_matching(&mut ws, Duration::from_secs(15), |f| {
            f["type"] == "terminal.killed" && f["requestId"] == "rk"
        })
        .await
        .expect("the kill is answered");
    assert_eq!(killed["success"], true, "{killed}");
    let settled = h
        .next_matching(&mut ws, Duration::from_secs(5), |f| {
            f["type"] == "terminal.replaced"
                || (f["type"] == "terminal.status"
                    && f["terminalId"] == tid.as_str()
                    && f["status"] == "exited")
        })
        .await
        .expect("the hub settles the crashed terminal");
    assert_eq!(
        settled["type"], "terminal.status",
        "never auto-resumed: {settled}"
    );
    assert_eq!(settled["reason"], "auto-resume cancelled", "{settled}");
    assert!(
        h.next_matching(&mut ws, Duration::from_secs(2), |f| f["type"]
            == "terminal.replaced")
            .await
            .is_none(),
        "no replacement"
    );
}

/// A kill naming a create parked until a Gone withdraws it: the kill is
/// answered at once (nothing was started for that pane), and the create
/// never runs, not even after the Gone.
#[tokio::test(flavor = "multi_thread")]
async fn a_kill_withdraws_a_parked_reopen() {
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let _gone = GoneDelay::set(GONE_DELAY_MS);
    let mut ws = h.connect().await;
    let (_a, _c, native, native_start) = pane_a_killed_and_shell_c(&h, &mut ws).await;
    h.send(&mut ws, reopen("crq-b", "t-pk")).await;
    eventually("crq-b is parked", Duration::from_secs(5), || {
        h.state.gone_waits.is_parked("crq-b")
    })
    .await;
    let sent = Instant::now();
    h.send(
        &mut ws,
        json!({"type": "terminal.kill", "requestId": "rk-b", "createRequestId": "crq-b"}),
    )
    .await;
    let killed = h
        .next_matching(&mut ws, Duration::from_secs(10), |f| {
            f["type"] == "terminal.killed" && f["requestId"] == "rk-b"
        })
        .await
        .expect("the kill is answered");
    assert_eq!(killed["success"], true, "{killed}");
    assert_eq!(
        fake_codex::proc_starttime(native),
        Some(native_start),
        "the kill was answered without waiting for A's Gone (after {:?})",
        sent.elapsed()
    );
    assert!(!h.state.gone_waits.is_parked("crq-b"));
    eventually("A's native exited (Gone)", Duration::from_secs(15), || {
        fake_codex::proc_starttime(native) != Some(native_start)
    })
    .await;
    let created = h
        .next_matching(&mut ws, Duration::from_secs(3), |f| {
            f["requestId"] == "crq-b"
        })
        .await;
    assert!(
        created.is_none(),
        "the withdrawn create never runs: {created:?}"
    );
    assert!(h
        .state
        .registry
        .terminal_for_create_request("crq-b")
        .is_none());
}

/// A kill that names a running pane is not a withdraw of the pane's parked
/// create, even when that create waits under the same create-request id:
/// here a stuck restart's respawn, parked while the restart's own stop runs,
/// and then a Shift-X of the same pane. The Shift-X stops the pane, and the
/// parked respawn is still answered at Gone (as stopped), never left without
/// an answer.
#[tokio::test(flavor = "multi_thread")]
async fn a_kill_naming_a_running_pane_leaves_its_parked_create_to_be_answered() {
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let _gone = GoneDelay::set(GONE_DELAY_MS);
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-m1", None).await;
    let ready = h
        .next_matching(&mut ws, Duration::from_secs(10), |f| {
            f["type"] == "terminal.output"
                && f["data"]
                    .as_str()
                    .is_some_and(|d| d.contains("FAKE_TUI_READY thread="))
        })
        .await
        .expect("the TUI is ready");
    let thread = ready["data"]
        .as_str()
        .unwrap()
        .split("FAKE_TUI_READY thread=")
        .nth(1)
        .and_then(|rest| rest.split_whitespace().next())
        .expect("the TUI names its thread")
        .to_string();
    start_settled(&h, &tid).await;
    let registry = h.state.ownership.clone().expect("an owner registry");
    eventually(
        "the pane holds its conversation",
        Duration::from_secs(10),
        || {
            matches!(registry.observe("codex", &thread).state,
            freshell_ownership::OwnershipState::Live { ref owner, .. }
                if owner.terminal_id.as_deref() == Some(tid.as_str()))
        },
    )
    .await;

    // The stuck restart: its kill keeps the pane's create-request id, and
    // its respawn reuses it, parked until the Gone.
    h.send(
        &mut ws,
        json!({"type": "terminal.kill", "terminalId": tid, "requestId": "rk-restart",
            "createRequestId": "crq-m1", "reason": "stuck-recovery"}),
    )
    .await;
    eventually(
        "the conversation is Stopping",
        Duration::from_secs(10),
        || {
            matches!(
                registry.observe("codex", &thread).state,
                freshell_ownership::OwnershipState::Stopping { .. }
            )
        },
    )
    .await;
    h.send(
        &mut ws,
        json!({"type": "terminal.create", "requestId": "crq-m1", "mode": "codex", "shell": "system",
            "restore": true, "cwd": h.home.path().display().to_string(),
            "sessionRef": {"provider": "codex", "sessionId": thread}}),
    )
    .await;
    eventually("the respawn is parked", Duration::from_secs(5), || {
        h.state.gone_waits.is_parked("crq-m1")
    })
    .await;

    // A Shift-X of the same pane names its running unit.
    h.send(
        &mut ws,
        json!({"type": "terminal.kill", "terminalId": tid, "requestId": "rk-x",
            "createRequestId": "crq-m1"}),
    )
    .await;
    let answer = h
        .next_matching(&mut ws, Duration::from_secs(20), |f| {
            f["requestId"] == "crq-m1" && (f["type"] == "terminal.created" || f["type"] == "error")
        })
        .await
        .expect("the parked respawn is answered");
    assert_eq!(answer["type"], "error", "the pane was stopped: {answer}");
    assert_eq!(answer["code"], "INVALID_TERMINAL_ID", "{answer}");
    assert!(h.state.units.by_create_request("crq-m1").is_none());
}

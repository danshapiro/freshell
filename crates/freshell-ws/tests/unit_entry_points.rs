//! Every way back into a conversation goes through the owner registry and
//! waits (event-driven) for the old unit's Gone instead of refusing and
//! asking the client to poll: an interactive reopen, a restore (sidebar,
//! Resume dialog), a stuck restart and an attach by the conversation all
//! wait while the conversation is `Stopping` and then proceed, so a kill
//! followed at once by a reopen never meets "open in another app". A
//! conversation killed before its first turn (Codex wrote no rollout) is
//! reopened as a new conversation. A restore of a conversation another pane
//! holds as an extra thread answers that pane and starts no second
//! app-server (Stage 2: LB-20, LB-21, LB-25, LB-41).
#![cfg(target_os = "linux")]
#[path = "support/unit_harness.rs"]
mod unit_harness;

use std::time::Duration;

use freshell_ownership::OwnershipState;
use serde_json::json;
use unit_harness::{fake_codex, GoneDelay, HarnessOpts, TestWs, UnitHarness};

async fn ready(h: &UnitHarness, ws: &mut TestWs) -> String {
    let frame = h
        .next_matching(ws, Duration::from_secs(10), |f| {
            f["type"] == "terminal.output"
                && f["data"]
                    .as_str()
                    .is_some_and(|d| d.contains("FAKE_TUI_READY"))
        })
        .await
        .expect("tui ready");
    frame["data"].as_str().unwrap().to_string()
}

/// The thread a `FAKE_TUI_READY thread=<id>` line names.
fn ready_thread(output: &str) -> String {
    output
        .split("FAKE_TUI_READY thread=")
        .nth(1)
        .and_then(|rest| rest.split_whitespace().next())
        .expect("a FAKE_TUI_READY line names its thread")
        .to_string()
}

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

/// Kill and reopen back to back: the reopen must wait for Gone, then start a
/// NEW app-server that resumes cleanly — never "open in another app". Gone
/// is held a moment (longer than a restore takes to plan its launch), so
/// the conversation is still `Stopping` whenever the reopen reaches it.
async fn kill_then_reopen(create: serde_json::Value, reason: Option<&str>) {
    let h = UnitHarness::start(HarnessOpts {
        behavior: json!({"turnCompleteDelayMs": 60000}),
        ..Default::default()
    })
    .await;
    let _gone = GoneDelay::set(2500);
    let mut ws = h.connect().await;
    let old = h.create_codex(&mut ws, "crq-old", Some("t-ep")).await;
    ready(&h, &mut ws).await;
    h.send(
        &mut ws,
        json!({"type": "terminal.input", "terminalId": old, "data": "turn go\r"}),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let old_native = h.native_pid(&old);
    let old_native_start = h.native_manifest(&old).start_time(old_native);
    let mut kill = json!({"type": "terminal.kill", "terminalId": old, "requestId": "rk", "createRequestId": "crq-old"});
    if let Some(r) = reason {
        kill["reason"] = json!(r);
    }
    h.send(&mut ws, kill).await;
    h.send(&mut ws, create).await; // immediately: the key is Stopping right now
    let mut killed_first = false;
    let created = loop {
        let frame = h
            .next_matching(&mut ws, Duration::from_secs(15), |f| {
                (f["type"] == "terminal.killed" && f["requestId"] == "rk")
                    || (f["requestId"] == "crq-new"
                        && (f["type"] == "terminal.created" || f["type"] == "error"))
            })
            .await
            .expect("the reopen is answered");
        if frame["type"] == "terminal.killed" {
            assert_eq!(frame["success"], true, "{frame}");
            killed_first = true;
            continue;
        }
        break frame;
    };
    assert_eq!(created["type"], "terminal.created", "{created}");
    assert!(
        killed_first,
        "the kill (answered at Gone) is answered before the reopen"
    );
    assert!(
        fake_codex::proc_starttime(old_native) != Some(old_native_start),
        "the reopen started only after the old app-server was gone"
    );
    let new = created["terminalId"].as_str().unwrap().to_string();
    assert_ne!(new, old);
    h.attach(&mut ws, &new).await;
    let out = h
        .next_matching(&mut ws, Duration::from_secs(10), |f| {
            f["type"] == "terminal.output"
                && f["terminalId"] == new.as_str()
                && f["data"].as_str().is_some_and(|d| {
                    d.contains("FAKE_TUI_READY") || d.contains("open in another app")
                })
        })
        .await
        .expect("new tui answered");
    assert!(
        out["data"]
            .as_str()
            .unwrap()
            .contains("FAKE_TUI_READY thread=t-ep"),
        "resumed cleanly: {out}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_interactive_reopen_waits_for_gone() {
    kill_then_reopen(
        json!({"type": "terminal.create", "requestId": "crq-new", "mode": "codex", "shell": "system",
        "sessionRef": {"provider": "codex", "sessionId": "t-ep"}}),
        None,
    )
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_restore_reopen_waits_for_gone() {
    kill_then_reopen(
        json!({"type": "terminal.create", "requestId": "crq-new", "mode": "codex", "shell": "system", "restore": true,
        "sessionRef": {"provider": "codex", "sessionId": "t-ep"}}),
        None,
    )
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_stuck_restart_waits_for_gone() {
    kill_then_reopen(
        json!({"type": "terminal.create", "requestId": "crq-new", "mode": "codex", "shell": "system", "restore": true,
        "sessionRef": {"provider": "codex", "sessionId": "t-ep"}}),
        Some("stuck-recovery"),
    )
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_attach_by_session_ref_during_stopping_waits_instead_of_refusing() {
    let h = UnitHarness::start(HarnessOpts {
        behavior: json!({"turnCompleteDelayMs": 60000}),
        ..Default::default()
    })
    .await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-at", Some("t-at")).await;
    h.send(
        &mut ws,
        json!({"type": "terminal.kill", "terminalId": tid, "requestId": "rk", "createRequestId": "crq-at"}),
    )
    .await;
    let mut other = h.connect().await;
    h.send(
        &mut other,
        json!({"type": "terminal.attach", "terminalId": tid, "intent": "viewport_hydrate",
            "cols": 120, "rows": 30, "attachRequestId": "ra",
            "sessionRef": {"provider": "codex", "sessionId": "t-at"}}),
    )
    .await;
    let answer = h
        .next_matching(&mut other, Duration::from_secs(10), |f| {
            f["requestId"] == "ra"
                || f["attachRequestId"] == "ra"
                || (f["terminalId"] == tid.as_str() && f["type"] == "error")
        })
        .await
        .expect("answered");
    assert_ne!(
        answer["code"], "SESSION_RESERVED",
        "waits for Gone instead of asking the client to poll: {answer}"
    );
    assert_eq!(
        answer["code"], "INVALID_TERMINAL_ID",
        "answered after Gone, when the terminal is gone: {answer}"
    );
}

/// A conversation killed before its first turn has no rollout (Codex writes
/// it only at the first turn): its reopen starts a NEW conversation in the
/// new pane instead of failing or crash-looping the screen (Stage 2: LB-41).
#[tokio::test(flavor = "multi_thread")]
async fn a_conversation_killed_before_its_first_turn_reopens_as_a_new_conversation() {
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let mut ws = h.connect().await;
    let first = h.create_codex(&mut ws, "crq-fresh", None).await;
    let id = ready_thread(&ready(&h, &mut ws).await);
    h.send(
        &mut ws,
        json!({"type": "terminal.kill", "terminalId": first, "requestId": "rk", "createRequestId": "crq-fresh"}),
    )
    .await;
    let killed = h
        .next_matching(&mut ws, Duration::from_secs(10), |f| {
            f["type"] == "terminal.killed" && f["requestId"] == "rk"
        })
        .await
        .expect("the kill is answered");
    assert_eq!(killed["success"], true, "{killed}");

    h.send(
        &mut ws,
        json!({"type": "terminal.create", "requestId": "crq-new", "mode": "codex", "shell": "system",
            "restore": true, "cwd": h.home.path().display().to_string(),
            "sessionRef": {"provider": "codex", "sessionId": id}}),
    )
    .await;
    let created = h
        .next_matching(&mut ws, Duration::from_secs(20), |f| {
            f["requestId"] == "crq-new" && (f["type"] == "terminal.created" || f["type"] == "error")
        })
        .await
        .expect("the reopen is answered");
    assert_eq!(
        created["type"], "terminal.created",
        "not an error: {created}"
    );
    let new = created["terminalId"].as_str().unwrap().to_string();
    h.attach(&mut ws, &new).await;
    let new_thread = ready_thread(&ready(&h, &mut ws).await);
    assert_ne!(new_thread, id, "a new conversation");
    assert!(
        h.next_matching(&mut ws, Duration::from_secs(3), |f| {
            f["type"] == "terminal.exit" && f["terminalId"] == new.as_str()
        })
        .await
        .is_none(),
        "the new screen does not crash"
    );
}

/// M4 (Task 14 review): a restore-class reopen (sidebar, Resume dialog) of a
/// conversation another pane's unit holds as an extra thread is answered
/// with the holding pane, like an interactive one, and starts no second
/// app-server: the holder is checked before the launch is planned.
#[tokio::test(flavor = "multi_thread")]
async fn a_restore_reopen_of_an_extra_thread_answers_the_holder_and_starts_no_app_server() {
    let h = UnitHarness::start(HarnessOpts {
        behavior: json!({"preloadedThreads": ["t-extra"]}),
        ..Default::default()
    })
    .await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-holder", Some("t-shown")).await;
    eventually("extra held", || live_under(&h, "t-extra", &tid)).await;
    let manifests_before = std::fs::read_dir(&h.manifests).unwrap().count();
    let mut other = h.connect().await;
    h.send(&mut other, json!({"type": "terminal.create", "requestId": "crq-reopen", "mode": "codex", "shell": "system",
        "restore": true, "sessionRef": {"provider": "codex", "sessionId": "t-extra"}})).await;
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
    // Any launcher it started would have written its manifest by now.
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(
        std::fs::read_dir(&h.manifests).unwrap().count(),
        manifests_before,
        "no second app-server"
    );
    assert!(
        live_under(&h, "t-extra", &tid),
        "the reopen released nothing"
    );
}

async fn start_settled(h: &UnitHarness, tid: &str) {
    let unit = h.unit_for(tid);
    tokio::time::timeout(
        Duration::from_secs(10),
        h.state.units.start_settled(unit.id()),
    )
    .await
    .expect("the pane's start settled");
}

/// The REST door (`POST /api/tabs`): a reopen of a conversation whose unit
/// is being stopped waits for its Gone (here within the 5 s bound) and then
/// resumes it in a new app-server (Decision 8; Stage 2: LB-20).
#[tokio::test(flavor = "multi_thread")]
async fn a_rest_reopen_waits_for_gone() {
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let _gone = GoneDelay::set(1500);
    let mut ws = h.connect().await;
    let old = h
        .create_codex(&mut ws, "crq-rest-old", Some("t-rest"))
        .await;
    ready(&h, &mut ws).await;
    start_settled(&h, &old).await;
    let old_native = h.native_pid(&old);
    let old_native_start = h.native_manifest(&old).start_time(old_native);
    h.send(
        &mut ws,
        json!({"type": "terminal.kill", "terminalId": old, "requestId": "rk", "createRequestId": "crq-rest-old"}),
    )
    .await;
    eventually("the conversation is Stopping", || {
        matches!(
            h.state
                .ownership
                .as_ref()
                .unwrap()
                .observe("codex", "t-rest")
                .state,
            OwnershipState::Stopping { .. }
        )
    })
    .await;
    let (status, body) = h.rest_create_codex(Some("t-rest")).await;
    assert_eq!(status, 200, "{body}");
    assert!(
        fake_codex::proc_starttime(old_native) != Some(old_native_start),
        "the reopen ran only after the old app-server was gone"
    );
    let new = body["data"]["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    assert_ne!(new, old);
    assert!(
        live_under(&h, "t-rest", &new),
        "the new pane holds the conversation"
    );
}

/// The REST door: a conversation killed before its first turn (no rollout)
/// is started new instead of failing (Stage 2: LB-41).
#[tokio::test(flavor = "multi_thread")]
async fn a_rest_reopen_of_a_conversation_killed_before_its_first_turn_starts_a_new_one() {
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let (status, body) = h
        .post(
            "/api/tabs",
            json!({"mode": "codex", "cwd": h.home.path().display().to_string(),
                "sessionRef": {"provider": "codex", "sessionId": "t-never-had-a-turn"}}),
        )
        .await;
    assert_eq!(status, 200, "a new conversation, not an error: {body}");
    let tid = body["data"]["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    let mut ws = h.connect().await;
    h.attach(&mut ws, &tid).await;
    let thread = ready_thread(&ready(&h, &mut ws).await);
    assert_ne!(thread, "t-never-had-a-turn", "a new conversation");
}

/// The fresh-agent door: a `freshAgent.create` resuming a conversation whose
/// terminal pane's unit is being stopped is parked and dispatched at Gone
/// (never refused), so the freshcodex pane resumes the conversation after
/// the old app-server is gone.
#[tokio::test(flavor = "multi_thread")]
async fn a_fresh_agent_reopen_waits_for_gone() {
    let h = UnitHarness::start(HarnessOpts::default()).await;
    h.state.fresh_codex.set_enabled(true);
    let _gone = GoneDelay::set(2000);
    let mut ws = h.connect().await;
    let old = h.create_codex(&mut ws, "crq-fa-old", Some("t-fa")).await;
    ready(&h, &mut ws).await;
    start_settled(&h, &old).await;
    let old_native = h.native_pid(&old);
    let old_native_start = h.native_manifest(&old).start_time(old_native);
    h.send(
        &mut ws,
        json!({"type": "terminal.kill", "terminalId": old, "requestId": "rk", "createRequestId": "crq-fa-old"}),
    )
    .await;
    h.send(
        &mut ws,
        json!({"type": "freshAgent.create", "requestId": "crq-fa-new", "sessionType": "freshcodex",
            "provider": "codex", "cwd": h.home.path().display().to_string(),
            "sessionRef": {"provider": "codex", "sessionId": "t-fa"}}),
    )
    .await;
    eventually("the fresh-agent create is parked", || {
        h.state.gone_waits.is_parked("crq-fa-new")
    })
    .await;
    let answer = h
        .next_matching(&mut ws, Duration::from_secs(30), |f| {
            f["requestId"] == "crq-fa-new"
                && (f["type"] == "freshAgent.created" || f["type"] == "freshAgent.create.failed")
        })
        .await
        .expect("the fresh-agent create is answered");
    assert_eq!(answer["type"], "freshAgent.created", "{answer}");
    assert_eq!(answer["sessionId"], "t-fa", "{answer}");
    assert!(
        fake_codex::proc_starttime(old_native) != Some(old_native_start),
        "the freshcodex pane resumed only after the old app-server was gone"
    );
    h.state.fresh_codex.shutdown().await;
}

/// Auto-resume after a crash of a conversation that never had a turn: the
/// replacement is a new conversation (Stage 2: LB-41), still announced as
/// the crashed pane's replacement.
#[tokio::test(flavor = "multi_thread")]
async fn an_auto_resume_of_a_conversation_that_never_had_a_turn_starts_a_new_one() {
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-ar-fresh", None).await;
    let thread = ready_thread(&ready(&h, &mut ws).await);
    start_settled(&h, &tid).await;
    eventually("the pane's conversation is known", || {
        h.state
            .identity
            .session_ref_for(&tid)
            .is_some_and(|locator| locator.session_id == thread)
    })
    .await;
    h.send(
        &mut ws,
        json!({"type": "terminal.input", "terminalId": tid, "data": "crash\r"}),
    )
    .await;
    let replaced = h
        .next_matching(&mut ws, Duration::from_secs(30), |f| {
            f["type"] == "terminal.replaced" && f["oldTerminalId"] == tid.as_str()
        })
        .await
        .expect("the crashed pane is replaced");
    let new = replaced["newTerminalId"].as_str().unwrap().to_string();
    h.attach(&mut ws, &new).await;
    let new_thread = ready_thread(&ready(&h, &mut ws).await);
    assert_ne!(
        new_thread, thread,
        "the replacement runs a new conversation"
    );
    assert!(
        h.next_matching(&mut ws, Duration::from_secs(3), |f| {
            f["type"] == "terminal.exit" && f["terminalId"] == new.as_str()
        })
        .await
        .is_none(),
        "the replacement does not crash"
    );
}

/// Task 12 handoff edge (a): a switch of a thread a pane's unit holds as an
/// EXTRA thread answers that pane and stops nothing, while the switch of the
/// pane's own conversation, made at the same time, succeeds on its first
/// attempt.
#[tokio::test(flavor = "multi_thread")]
async fn a_switch_of_an_extra_thread_answers_the_holder_while_the_main_switch_succeeds() {
    let h = UnitHarness::start(HarnessOpts {
        behavior: json!({"preloadedThreads": ["t-sw-extra"]}),
        ..Default::default()
    })
    .await;
    let mut ws = h.connect().await;
    let prior = h.create_codex(&mut ws, "crq-sw", Some("t-sw-main")).await;
    ready(&h, &mut ws).await;
    start_settled(&h, &prior).await;
    eventually("extra held", || live_under(&h, "t-sw-extra", &prior)).await;

    let switch = |sid: &'static str| {
        json!({"provider": "codex", "sessionId": sid, "targetKind": "terminal", "mode": "codex",
            "cwd": h.home.path().display().to_string(), "deviceId": "test-device"})
    };
    let (extra, main) = tokio::join!(
        h.post("/api/sessions/handoff", switch("t-sw-extra")),
        h.post("/api/sessions/handoff", switch("t-sw-main")),
    );
    assert_eq!(extra.1["ok"], json!(false), "{}", extra.1);
    assert_eq!(
        extra.1["error"]["code"], "HELD_BY_ANOTHER_PANE",
        "{}",
        extra.1
    );
    assert_eq!(
        extra.1["error"]["holderTerminalId"],
        prior.as_str(),
        "the holder is named: {}",
        extra.1
    );
    assert_eq!(main.0, 200, "{}", main.1);
    assert_eq!(main.1["ok"], json!(true), "first attempt: {}", main.1);
}

/// A switch from a Codex terminal pane in its unit to a freshcodex pane
/// stops the pane through the single stop path and succeeds on its first
/// attempt (Task 12's note: first-attempt success with a unit-row prior,
/// including a freshcodex target).
#[tokio::test(flavor = "multi_thread")]
async fn a_switch_to_freshcodex_from_a_pane_in_its_unit_succeeds_on_the_first_attempt() {
    let h = UnitHarness::start(HarnessOpts::default()).await;
    h.state.fresh_codex.set_enabled(true);
    let mut ws = h.connect().await;
    let prior = h.create_codex(&mut ws, "crq-sw-fc", Some("t-sw-fc")).await;
    ready(&h, &mut ws).await;
    start_settled(&h, &prior).await;
    let prior_native = h.native_pid(&prior);
    let (status, body) = h
        .post(
            "/api/sessions/handoff",
            json!({"provider": "codex", "sessionId": "t-sw-fc", "targetKind": "fresh-agent",
                "sessionType": "freshcodex", "cwd": h.home.path().display().to_string(),
                "deviceId": "test-device"}),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["ok"], json!(true), "first attempt: {body}");
    assert!(
        !fake_codex::pid_alive(prior_native),
        "the prior's app-server is gone"
    );
    assert!(
        h.state.units.by_terminal(&prior).is_none(),
        "the prior's unit was Gone before the switch answered"
    );
    h.state.fresh_codex.shutdown().await;
}

/// A switch to terminal Codex of a freshcodex conversation that never had a
/// turn cannot move it: Codex wrote no rollout, so there is nothing to
/// resume, and a handoff moves one exact conversation, so it starts no new
/// one in its place. The switch is refused for good (not retryable: every
/// retry would meet the same missing rollout) with a plain message.
#[tokio::test(flavor = "multi_thread")]
async fn a_switch_to_the_terminal_of_a_conversation_that_never_had_a_turn_is_refused_for_good() {
    let h = UnitHarness::start(HarnessOpts::default()).await;
    h.state.fresh_codex.set_enabled(true);
    let mut ws = h.connect().await;
    let cwd = h.home.path().display().to_string();
    h.send(
        &mut ws,
        json!({"type": "freshAgent.create", "requestId": "crq-fc-fresh", "sessionType": "freshcodex",
            "provider": "codex", "cwd": cwd}),
    )
    .await;
    let created = h
        .next_matching(&mut ws, Duration::from_secs(30), |f| {
            f["requestId"] == "crq-fc-fresh"
                && (f["type"] == "freshAgent.created" || f["type"] == "freshAgent.create.failed")
        })
        .await
        .expect("the freshcodex create is answered");
    assert_eq!(created["type"], "freshAgent.created", "{created}");
    let session_id = created["sessionId"].as_str().unwrap().to_string();

    let (status, body) = h
        .post(
            "/api/sessions/handoff",
            json!({"provider": "codex", "sessionId": session_id, "targetKind": "terminal",
                "mode": "codex", "cwd": cwd, "deviceId": "test-device"}),
        )
        .await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["ok"], json!(false), "{body}");
    assert_eq!(body["error"]["code"], "TARGET_SPAWN_FAILED", "{body}");
    assert_eq!(
        body["error"]["retryable"],
        json!(false),
        "a retry would fail the same way: {body}"
    );
    assert!(
        body["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("no messages yet")),
        "a plain message: {body}"
    );
    h.state.fresh_codex.shutdown().await;
}

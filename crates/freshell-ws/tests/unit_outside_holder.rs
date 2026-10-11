//! A conversation held by a process outside Freshell (a shell `codex`,
//! Codex's own daemon or desktop app, `codex exec`) is reported at once,
//! by that process's pid and name, never waited for and never started
//! beside it; one a live Freshell pane's app-server holds answers that pane.
//! Holders are found by file descriptor under the Codex home the new
//! app-server reported, right after it is ready (Stage 2: LB-28, LB-29,
//! LB-46). Every writer conflict Codex reports by itself ("already has an
//! active writer" / "open in another app") is an ERROR log naming the
//! holder it finds.
#![cfg(target_os = "linux")]
#[path = "../../freshell-containment/tests/support/capture.rs"]
#[allow(dead_code)]
mod capture;
#[path = "support/unit_harness.rs"]
mod unit_harness;

use std::sync::OnceLock;
use std::time::Duration;

use serde_json::json;
use tracing_subscriber::prelude::*;
use unit_harness::{fake_codex, GoneDelay, HarnessOpts, TestWs, UnitHarness};

/// One capture of the `freshell_unit` events for the whole binary (each test
/// asserts only on events about its own conversation).
fn captured() -> capture::Captured {
    static CAPTURE: OnceLock<capture::Captured> = OnceLock::new();
    CAPTURE
        .get_or_init(|| {
            let cap = capture::Captured::default();
            let _ = tracing::subscriber::set_global_default(
                tracing_subscriber::registry().with(cap.clone()),
            );
            cap
        })
        .clone()
}

async fn eventually(what: &str, f: impl Fn() -> bool) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !f() {
        assert!(tokio::time::Instant::now() < deadline, "timed out: {what}");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// The TUI of `terminal_id` printed `needle`.
async fn output_shows(h: &UnitHarness, ws: &mut TestWs, terminal_id: &str, needle: &str) {
    h.next_matching(ws, Duration::from_secs(10), |f| {
        f["type"] == "terminal.output"
            && f["terminalId"] == terminal_id
            && f["data"].as_str().is_some_and(|d| d.contains(needle))
    })
    .await
    .unwrap_or_else(|| panic!("{terminal_id} printed {needle:?}"));
}

/// A Codex reopen of `session_id` (restore class when `restore`).
fn reopen(request_id: &str, session_id: &str, restore: bool) -> serde_json::Value {
    let mut create = json!({
        "type": "terminal.create",
        "requestId": request_id,
        "mode": "codex",
        "shell": "system",
        "sessionRef": {"provider": "codex", "sessionId": session_id},
    });
    if restore {
        create["restore"] = json!(true);
    }
    create
}

/// The answer to the create `request_id` within `limit`.
async fn answer(
    h: &UnitHarness,
    ws: &mut TestWs,
    request_id: &str,
    limit: Duration,
) -> Option<serde_json::Value> {
    h.next_matching(ws, limit, |f| {
        f["requestId"] == request_id && (f["type"] == "terminal.created" || f["type"] == "error")
    })
    .await
}

/// The refusal naming `holder`: its code, pid and process name, the
/// message the user reads, and no argument of its command line anywhere.
fn assert_names_the_outside_holder(
    error: &serde_json::Value,
    holder: &fake_codex::OutsideHolder,
    argv: &[String],
) {
    assert_eq!(error["type"], "error", "{error}");
    assert_eq!(error["code"], "CONVERSATION_HELD_ELSEWHERE", "{error}");
    assert_eq!(error["holderPid"], holder.pid(), "{error}");
    assert_eq!(error["holderCommand"], "perl", "{error}");
    assert_eq!(
        error["message"],
        format!(
            "This conversation is open in another program (pid {}: perl). Close it there, \
             then reopen it here.",
            holder.pid()
        ),
        "{error}"
    );
    let frame = error.to_string();
    for arg in argv.iter().skip(1) {
        assert!(
            !frame.contains(arg.as_str()),
            "argv {arg:?} leaked: {frame}"
        );
    }
}

/// The ERROR `unit.writer_conflict` the refusal logged for `thread`:
/// holder by pid and process name, no command line.
async fn assert_conflict_logged(thread: &str, holder_pid: u32, source: &str) {
    let pid = holder_pid.to_string();
    let event = captured()
        .wait_for(
            tracing::Level::ERROR,
            "unit.writer_conflict",
            &[("thread_id", thread), ("source", source)],
            Duration::from_secs(10),
        )
        .await
        .unwrap_or_else(|| panic!("an ERROR unit.writer_conflict for {thread}"));
    assert_eq!(event.fields.get("holder_pid"), Some(&pid), "{event:?}");
    assert_eq!(
        event.fields.get("holder_name").map(String::as_str),
        Some("perl"),
        "{event:?}"
    );
    assert_eq!(
        event.fields.get("holder_visible").map(String::as_str),
        Some("true"),
        "{event:?}"
    );
    assert!(!event.fields.contains_key("holder_command"), "{event:?}");
}

/// A restore (sidebar, Resume dialog) of a conversation a process outside
/// Freshell holds: a typed error naming that process by pid and name at
/// once, no pane, the attempt's app-server stopped, and an ERROR log.
#[tokio::test(flavor = "multi_thread")]
async fn an_outside_holder_is_reported_at_once_and_nothing_is_started() {
    let _ = captured();
    let h = UnitHarness::start(HarnessOpts::default()).await;
    h.seed_rollout("t-out");
    let holder = fake_codex::OutsideHolder::hold(&h.lock("t-out"));
    let argv = holder.argv();
    let mut ws = h.connect().await;

    h.send(&mut ws, reopen("crq-out", "t-out", true)).await;
    let error = answer(&h, &mut ws, "crq-out", Duration::from_secs(3))
        .await
        .expect("the reopen is answered within 3 s");
    assert_names_the_outside_holder(&error, &holder, &argv);
    assert!(
        answer(&h, &mut ws, "crq-out", Duration::from_millis(500))
            .await
            .is_none(),
        "no terminal.created follows"
    );
    eventually("the attempt's sidecar was stopped", || {
        h.state.units.by_create_request("crq-out").is_none()
    })
    .await;
    assert_conflict_logged("t-out", holder.pid(), "preflight").await;
    assert!(
        fake_codex::pid_alive(holder.pid()),
        "the outside holder is never signalled"
    );
}

/// The interactive reopen (a create with a `sessionRef` and no restore
/// flag) and the REST door (`POST /api/tabs`) give the same answer.
#[tokio::test(flavor = "multi_thread")]
async fn every_reopen_door_reports_the_outside_holder() {
    let _ = captured();
    let h = UnitHarness::start(HarnessOpts::default()).await;
    h.seed_rollout("t-out-i");
    let holder = fake_codex::OutsideHolder::hold(&h.lock("t-out-i"));
    let argv = holder.argv();
    let mut ws = h.connect().await;

    h.send(&mut ws, reopen("crq-out-i", "t-out-i", false)).await;
    let error = answer(&h, &mut ws, "crq-out-i", Duration::from_secs(3))
        .await
        .expect("the interactive reopen is answered within 3 s");
    assert_names_the_outside_holder(&error, &holder, &argv);
    eventually("the interactive attempt's sidecar was stopped", || {
        h.state.units.by_create_request("crq-out-i").is_none()
    })
    .await;

    assert_conflict_logged("t-out-i", holder.pid(), "preflight").await;

    let rest_holder = fake_codex::OutsideHolder::hold(&h.lock("t-out-r"));
    let rest_argv = rest_holder.argv();
    let (status, body) = h.rest_create_codex(Some("t-out-r")).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["code"], "CONVERSATION_HELD_ELSEWHERE", "{body}");
    assert_eq!(body["holderPid"], rest_holder.pid(), "{body}");
    assert_eq!(body["holderCommand"], "perl", "{body}");
    assert_eq!(
        body["message"],
        format!(
            "This conversation is open in another program (pid {}: perl). Close it there, \
             then reopen it here.",
            rest_holder.pid()
        ),
        "{body}"
    );
    for arg in rest_argv.iter().skip(1) {
        assert!(
            !body.to_string().contains(arg.as_str()),
            "argv leaked: {body}"
        );
    }
    assert_conflict_logged("t-out-r", rest_holder.pid(), "preflight").await;
    assert!(fake_codex::pid_alive(holder.pid()));
    assert!(fake_codex::pid_alive(rest_holder.pid()));
}

/// An auto-resume (a crashed pane's respawn, which has no client to
/// answer) of a conversation a process outside Freshell holds is refused:
/// the refusal names the holder by pid and process name, the conflict is
/// logged at ERROR, the one attempt's app-server is stopped and never
/// retried, and the holder is never signalled.
#[tokio::test(flavor = "multi_thread")]
async fn an_auto_resume_of_a_conversation_held_outside_freshell_is_refused_and_never_retried() {
    let _ = captured();
    let h = UnitHarness::start(HarnessOpts::default()).await;
    h.seed_rollout("t-auto-out");
    let holder = fake_codex::OutsideHolder::hold(&h.lock("t-auto-out"));
    let natives_before: Vec<u32> = h.native_manifests().iter().map(|m| m.pid).collect();

    let refusal = freshell_ws::terminal::respawn_agent_terminal(
        &h.state,
        &freshell_ws::terminal::AgentRespawnRequest {
            mode: "codex".into(),
            provider: "codex".into(),
            session_id: "t-auto-out".into(),
            create_request_id: "crq-auto-out".into(),
            cwd: Some(h.home.path().display().to_string()),
        },
    )
    .await
    .expect_err("a respawn beside an outside holder is refused");
    match refusal {
        freshell_ws::terminal::RespawnError::LaunchUnresolvable(message) => assert_eq!(
            message,
            freshell_protocol::conversation_held_elsewhere_message(holder.pid(), "perl")
        ),
        other => panic!("expected the holder refusal, got {other:?}"),
    }
    assert_conflict_logged("t-auto-out", holder.pid(), "preflight").await;

    eventually("the attempt's sidecar was stopped", || {
        h.state.units.by_create_request("crq-auto-out").is_none()
    })
    .await;
    let attempts: Vec<u32> = h
        .native_manifests()
        .iter()
        .map(|m| m.pid)
        .filter(|pid| !natives_before.contains(pid))
        .collect();
    assert_eq!(
        attempts.len(),
        1,
        "one app-server was started and never retried: {attempts:?}"
    );
    eventually("the attempt's app-server is gone", || {
        !fake_codex::pid_alive(attempts[0])
    })
    .await;
    assert!(
        fake_codex::pid_alive(holder.pid()),
        "the outside holder is never signalled"
    );
}

/// A conversation a live pane's app-server holds without the owner registry
/// knowing (loaded by another client of that app-server, announced on no
/// connection) is that pane's: a reopen answers the holding pane, through
/// either door, and reports no outside program.
#[tokio::test(flavor = "multi_thread")]
async fn a_reopen_of_a_thread_another_panes_app_server_holds_answers_that_pane() {
    let _ = captured();
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let mut ws = h.connect().await;
    let (holder_tid, _loader) =
        quietly_holding_pane(&h, &mut ws, "crq-holder", "t-quiet-held").await;

    let mut other = h.connect().await;
    h.send(&mut other, reopen("crq-quiet", "t-quiet-held", true))
        .await;
    let created = answer(&h, &mut other, "crq-quiet", Duration::from_secs(10))
        .await
        .expect("the reopen is answered");
    assert_eq!(created["type"], "terminal.created", "{created}");
    assert_eq!(
        created["terminalId"],
        holder_tid.as_str(),
        "the reopen names the holding pane's terminal"
    );
    eventually("the attempt's sidecar was stopped", || {
        h.state.units.by_create_request("crq-quiet").is_none()
    })
    .await;

    let (status, body) = h.rest_create_codex(Some("t-quiet-held")).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["code"], "RESTORE_UNAVAILABLE", "{body}");
    assert_eq!(body["liveTerminalId"], holder_tid.as_str(), "{body}");
    assert!(
        captured()
            .first(
                tracing::Level::ERROR,
                "unit.writer_conflict",
                &[("thread_id", "t-quiet-held")]
            )
            .is_none(),
        "a Freshell pane is never reported as another program"
    );
}

/// The interactive reopen (a create with a `sessionRef` and no restore
/// flag) of a conversation another pane's app-server holds without the
/// owner registry knowing answers that pane too, and reports no outside
/// program.
#[tokio::test(flavor = "multi_thread")]
async fn an_interactive_reopen_of_a_thread_another_panes_app_server_holds_answers_that_pane() {
    let _ = captured();
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let mut ws = h.connect().await;
    let (holder_tid, _loader) =
        quietly_holding_pane(&h, &mut ws, "crq-holder-i", "t-quiet-held-i").await;

    let mut other = h.connect().await;
    h.send(&mut other, reopen("crq-quiet-i", "t-quiet-held-i", false))
        .await;
    let created = answer(&h, &mut other, "crq-quiet-i", Duration::from_secs(10))
        .await
        .expect("the interactive reopen is answered");
    assert_eq!(created["type"], "terminal.created", "{created}");
    assert_eq!(
        created["terminalId"],
        holder_tid.as_str(),
        "the interactive reopen names the holding pane's terminal"
    );
    eventually("the interactive attempt's sidecar was stopped", || {
        h.state.units.by_create_request("crq-quiet-i").is_none()
    })
    .await;
    assert!(
        captured()
            .first(
                tracing::Level::ERROR,
                "unit.writer_conflict",
                &[("thread_id", "t-quiet-held-i")]
            )
            .is_none(),
        "a Freshell pane is never reported as another program"
    );
}

/// Creates a Codex pane (`request_id`) whose app-server then loads
/// `thread_id` for another client of it, announced on no connection: the
/// pane's native holds that conversation's lock while the owner registry
/// does not know it. The rollout of `thread_id` is seeded. Returns the
/// pane's terminal id and the client that made it load the thread (kept for
/// the test's lifetime).
async fn quietly_holding_pane(
    h: &UnitHarness,
    ws: &mut TestWs,
    request_id: &str,
    thread_id: &str,
) -> (String, fake_codex::Rpc) {
    let holder_tid = h
        .create_codex(ws, request_id, Some(&format!("{thread_id}-shown")))
        .await;
    output_shows(h, ws, &holder_tid, "FAKE_TUI_READY").await;
    let url = freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::global()
        .sidecar_ws_url(&holder_tid)
        .expect("the app-server's own address");
    let port: u16 = url
        .rsplit(':')
        .next()
        .and_then(|port| port.trim_end_matches('/').parse().ok())
        .unwrap_or_else(|| panic!("a port in {url}"));
    let mut second_client = fake_codex::Rpc::connect(port).await;
    second_client
        .call("fixture/loadThread", json!({"threadId": thread_id}))
        .await
        .expect("the app-server loads the thread");
    assert!(fake_codex::holds_lock_fd(
        h.native_pid(&holder_tid),
        &h.lock(thread_id)
    ));
    h.seed_rollout(thread_id);
    (holder_tid, second_client)
}

/// A holder lookup that cannot finish in time (a hung network mount) is
/// "could not check", never "held": the reopen goes on (Codex's own lock
/// then decides) and a WARN says the check was skipped.
#[tokio::test(flavor = "multi_thread")]
async fn a_holder_lookup_that_cannot_finish_in_time_lets_the_reopen_proceed() {
    let _ = captured();
    let h = UnitHarness::start(HarnessOpts::default()).await;
    h.seed_rollout("t-slow");
    let _holder = fake_codex::OutsideHolder::hold(&h.lock("t-slow"));
    let _slow = HolderLookupHeldUp::set(2500);
    let mut ws = h.connect().await;

    h.send(&mut ws, reopen("crq-slow", "t-slow", true)).await;
    let created = answer(&h, &mut ws, "crq-slow", Duration::from_secs(15))
        .await
        .expect("the reopen is answered");
    assert_eq!(created["type"], "terminal.created", "{created}");
    assert!(
        captured()
            .wait_for(
                tracing::Level::WARN,
                "unit.resume_preflight.skipped",
                &[("thread_id", "t-slow"), ("reason", "lookup_unchecked")],
                Duration::from_secs(5),
            )
            .await
            .is_some(),
        "the skipped check is logged"
    );
}

/// A reopen parked while the conversation's pane is being stopped runs the
/// holder check when it is redelivered at Gone: a process outside Freshell
/// that took the conversation meanwhile is reported at once, not waited for.
#[tokio::test(flavor = "multi_thread")]
async fn a_reopen_parked_on_a_stop_reports_an_outside_holder_that_took_the_conversation() {
    let _ = captured();
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let mut ws = h.connect().await;
    let old = h
        .create_codex(&mut ws, "crq-park-old", Some("t-park"))
        .await;
    output_shows(&h, &mut ws, &old, "FAKE_TUI_READY").await;
    let lock = h.lock("t-park");
    assert!(fake_codex::holds_lock_fd(h.native_pid(&old), &lock));

    let _gone = GoneDelay::set(2500);
    h.send(
        &mut ws,
        json!({"type": "terminal.kill", "terminalId": old, "requestId": "rk-park", "createRequestId": "crq-park-old"}),
    )
    .await;
    // The reopen parks: the conversation is Stopping until Gone.
    h.send(&mut ws, reopen("crq-park-new", "t-park", true))
        .await;
    // Once the old app-server released the lock, an outside program takes it
    // (its flock waits for the release), all before the delayed Gone.
    let holder = tokio::task::spawn_blocking(move || fake_codex::OutsideHolder::hold(&lock))
        .await
        .expect("the outside holder took the lock");
    let argv = holder.argv();

    let mut killed = false;
    let error = loop {
        let frame = h
            .next_matching(&mut ws, Duration::from_secs(20), |f| {
                (f["type"] == "terminal.killed" && f["requestId"] == "rk-park")
                    || (f["requestId"] == "crq-park-new"
                        && (f["type"] == "terminal.created" || f["type"] == "error"))
            })
            .await
            .expect("the kill and the reopen are answered");
        if frame["type"] == "terminal.killed" {
            assert_eq!(frame["success"], true, "{frame}");
            killed = true;
            continue;
        }
        break frame;
    };
    assert!(killed, "the reopen ran only after the kill's Gone");
    assert_names_the_outside_holder(&error, &holder, &argv);
    assert_conflict_logged("t-park", holder.pid(), "preflight").await;
}

/// Holds up every outside-holder lookup that starts while alive by `ms`
/// (the containment's env-gated hook). Create it after the harness.
struct HolderLookupHeldUp;

impl HolderLookupHeldUp {
    fn set(ms: u64) -> Self {
        std::env::set_var("FRESHELL_TEST_HOOKS", "1");
        std::env::set_var("FRESHELL_TEST_UNIT_HOLDER_LOOKUP_DELAY_MS", ms.to_string());
        HolderLookupHeldUp
    }
}

impl Drop for HolderLookupHeldUp {
    fn drop(&mut self) {
        std::env::remove_var("FRESHELL_TEST_UNIT_HOLDER_LOOKUP_DELAY_MS");
        std::env::remove_var("FRESHELL_TEST_HOOKS");
    }
}

/// A conflict Codex hits by itself (the TUI of pane B resumes the
/// conversation pane A's app-server holds) is an ERROR naming the holder the
/// lock lookup finds by file descriptor (A's native app-server), with the
/// thread taken from B's pending request.
#[tokio::test(flavor = "multi_thread")]
async fn a_conflict_the_tui_hits_by_itself_is_logged_as_an_error() {
    let _ = captured();
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let mut ws = h.connect().await;
    let a = h.create_codex(&mut ws, "crq-a", Some("t-held")).await;
    output_shows(&h, &mut ws, &a, "FAKE_TUI_READY").await;
    let b = h.create_codex(&mut ws, "crq-b", Some("t-other")).await;
    output_shows(&h, &mut ws, &b, "FAKE_TUI_READY").await;

    h.send(
        &mut ws,
        json!({"type": "terminal.input", "terminalId": b, "data": "resume t-held\r"}),
    )
    .await;
    output_shows(&h, &mut ws, &b, "open in another app").await;
    assert_conflict_logged_with_holder(&h, "t-held", h.native_pid(&a)).await;
}

async fn assert_conflict_logged_with_holder(_h: &UnitHarness, thread: &str, holder_pid: u32) {
    let pid = holder_pid.to_string();
    let event = captured()
        .wait_for(
            tracing::Level::ERROR,
            "unit.writer_conflict",
            &[("thread_id", thread), ("source", "proxy")],
            Duration::from_secs(10),
        )
        .await
        .unwrap_or_else(|| panic!("an ERROR unit.writer_conflict for {thread} from the proxy"));
    assert_eq!(event.fields.get("holder_pid"), Some(&pid), "{event:?}");
    assert_eq!(
        event.fields.get("holder_visible").map(String::as_str),
        Some("true"),
        "{event:?}"
    );
    assert!(!event.fields.contains_key("holder_command"), "{event:?}");
}

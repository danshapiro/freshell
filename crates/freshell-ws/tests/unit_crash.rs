//! Crashes, screen-only crashes and self-exits of a Codex pane's unit
//! (Task 17; Stage 2: LB-40, LB-19, LB-45). The Codex 0.162 TUI never exits
//! when its app-server dies (it reconnects and stays up), so the death of
//! the native app-server is detected from that process's own exit and ends
//! the whole unit as a crash; a screen that exits while the app-server runs
//! is restarted in the same terminal row against it, unless the user quit
//! Codex with no turn running (then the whole unit ends).
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
use unit_harness::{fake_codex, AutoResumeMode, HarnessOpts, TestWs, UnitHarness};

const LIMIT: Duration = Duration::from_secs(15);

/// One capture of the `freshell_unit` events for the whole binary (each test
/// asserts only on events about its own terminal).
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

/// The terminal's output frames seen so far: the highest `seqEnd` and the
/// stream id, so a test can check that a replacement screen continues the
/// row's sequence under the same stream.
#[derive(Default)]
struct OutputSeen {
    highest_seq_end: i64,
    stream_id: Option<String>,
}

impl OutputSeen {
    /// Records `frame` (a `terminal.output` of the terminal) and checks it
    /// continues the sequence: same stream, starting after every frame
    /// seen before it (a client drops a frame whose `seqStart` is not above
    /// the highest sequence it saw).
    fn note(&mut self, frame: &serde_json::Value) {
        let stream = frame["streamId"].as_str().expect("streamId").to_string();
        let seq_start = frame["seqStart"].as_i64().expect("seqStart");
        let seq_end = frame["seqEnd"].as_i64().expect("seqEnd");
        if let Some(seen) = self.stream_id.as_deref() {
            assert_eq!(seen, stream, "the row keeps one stream: {frame}");
            assert!(
                seq_start > self.highest_seq_end,
                "output continues the row's sequence (seqStart {seq_start} after seqEnd {}): {frame}",
                self.highest_seq_end
            );
        }
        self.stream_id = Some(stream);
        self.highest_seq_end = self.highest_seq_end.max(seq_end);
    }
}

/// Waits for the next `FAKE_TUI_READY` line of `tid`, noting every output
/// frame of `tid` on the way; returns that line's frame.
async fn ready_seen(
    h: &UnitHarness,
    ws: &mut TestWs,
    tid: &str,
    seen: &mut OutputSeen,
) -> serde_json::Value {
    let deadline = tokio::time::Instant::now() + LIMIT;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let frame = h
            .next_matching(ws, remaining, |f| {
                f["type"] == "terminal.output" && f["terminalId"] == tid
            })
            .await
            .unwrap_or_else(|| panic!("FAKE_TUI_READY of {tid} within {LIMIT:?}"));
        seen.note(&frame);
        if frame["data"]
            .as_str()
            .is_some_and(|d| d.contains("FAKE_TUI_READY"))
        {
            return frame;
        }
    }
}

async fn ready(h: &UnitHarness, ws: &mut TestWs, tid: &str) -> serde_json::Value {
    ready_seen(h, ws, tid, &mut OutputSeen::default()).await
}

async fn start_settled(h: &UnitHarness, tid: &str) {
    tokio::time::timeout(LIMIT, h.state.units.start_settled(h.unit_for(tid).id()))
        .await
        .expect("the start settled");
}

async fn eventually(what: &str, f: impl Fn() -> bool) {
    let deadline = tokio::time::Instant::now() + LIMIT;
    while !f() {
        assert!(tokio::time::Instant::now() < deadline, "timed out: {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Sends `turn go` and waits until the activity hub reports the pane busy.
async fn turn_in_flight(h: &UnitHarness, ws: &mut TestWs, tid: &str) {
    h.send(
        ws,
        json!({"type": "terminal.input", "terminalId": tid, "data": "turn go\r"}),
    )
    .await;
    h.next_matching(ws, LIMIT, |f| {
        f["type"] == "codex.activity.updated"
            && f["upsert"].as_array().is_some_and(|rows| {
                rows.iter()
                    .any(|row| row["terminalId"] == tid && row["phase"] == "busy")
            })
    })
    .await
    .expect("the turn is in flight");
}

/// Sends `turn go` and waits until the pane's thread table reports a
/// running turn (the fake broadcast the thread's `active` status).
async fn turn_running(h: &UnitHarness, ws: &mut TestWs, tid: &str) {
    h.send(
        ws,
        json!({"type": "terminal.input", "terminalId": tid, "data": "turn go\r"}),
    )
    .await;
    eventually("the pane's thread table reports a running turn", || {
        freshell_ws::unit_threads::turn_running(&h.state, tid)
    })
    .await;
}

/// SIGKILLs the pane's current screen (the TUI), by pid and pinned start
/// time; returns its pid.
fn kill_screen(h: &UnitHarness, tid: &str) -> u32 {
    let screen = h.unit_for(tid).screen().expect("the unit's screen");
    assert!(
        fake_codex::signal_own_child(screen.pid(), screen.identity().start, libc::SIGKILL),
        "the screen was signalled"
    );
    screen.pid()
}

fn screen_pid(h: &UnitHarness, tid: &str) -> u32 {
    h.unit_for(tid).screen().expect("the unit's screen").pid()
}

/// The next `terminal.exit` of `tid`, or `None` within `limit`.
async fn exit_within(
    h: &UnitHarness,
    ws: &mut TestWs,
    tid: &str,
    limit: Duration,
) -> Option<serde_json::Value> {
    h.next_matching(ws, limit, |f| {
        f["type"] == "terminal.exit" && f["terminalId"] == tid
    })
    .await
}

#[tokio::test(flavor = "multi_thread")]
async fn app_server_death_mid_reply_is_a_crash_that_rings_and_publishes_only_after_gone() {
    let mut h = UnitHarness::start(HarnessOpts {
        behavior: json!({"turnCompleteDelayMs": 60000}),
        auto_resume: AutoResumeMode::Capture,
        activity_hub: true,
        ..Default::default()
    })
    .await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-c", Some("t-crash")).await;
    ready(&h, &mut ws, &tid).await;
    start_settled(&h, &tid).await;
    turn_in_flight(&h, &mut ws, &tid).await;
    let screen = screen_pid(&h, &tid);

    h.kill_native(&tid); // the app-server dies on its own; the TUI stays up

    // terminal.exit (the terminal's stream) and the death bell (the
    // server-wide broadcast) are both published at Gone; either can come
    // first.
    let deadline = tokio::time::Instant::now() + LIMIT;
    let (mut exit, mut bell) = (None, false);
    while exit.is_none() || !bell {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let frame = h
            .next_matching(&mut ws, remaining, |f| {
                (f["type"] == "terminal.exit" || f["type"] == "terminal.idle")
                    && f["terminalId"] == tid.as_str()
            })
            .await
            .unwrap_or_else(|| {
                panic!(
                    "terminal.exit (seen: {}) and the death bell (seen: {bell})",
                    exit.is_some()
                )
            });
        if frame["type"] == "terminal.exit" {
            assert!(
                !fake_codex::pid_alive(screen),
                "the whole unit, its TUI included, ended before terminal.exit"
            );
            exit = Some(frame);
        } else {
            bell = true;
        }
    }
    let exit = exit.expect("terminal.exit");
    assert_ne!(exit["exitCode"], 0, "a crash, not a clean exit: {exit}");
    let crash = tokio::time::timeout(LIMIT, h.crash_rx.as_mut().unwrap().recv())
        .await
        .expect("a crash event within the limit")
        .expect("a crash event");
    assert_eq!(crash.terminal_id, tid);
    assert_ne!(crash.exit_code, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn after_an_app_server_crash_auto_resume_reopens_cleanly() {
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-r", Some("t-resume")).await;
    ready(&h, &mut ws, &tid).await;
    start_settled(&h, &tid).await;

    let old_native = h.kill_native(&tid);

    let replaced = h
        .next_matching(&mut ws, Duration::from_secs(30), |f| {
            f["type"] == "terminal.replaced" && f["oldTerminalId"] == tid.as_str()
        })
        .await
        .expect("the crashed pane is auto-resumed");
    let new = replaced["newTerminalId"].as_str().unwrap().to_string();
    h.attach(&mut ws, &new).await;
    let out = h
        .next_matching(&mut ws, LIMIT, |f| {
            f["type"] == "terminal.output"
                && f["terminalId"] == new.as_str()
                && f["data"].as_str().is_some_and(|d| {
                    d.contains("FAKE_TUI_READY") || d.contains("open in another app")
                })
        })
        .await
        .expect("the replacement's TUI answers");
    assert!(
        out["data"]
            .as_str()
            .unwrap()
            .contains("FAKE_TUI_READY thread=t-resume"),
        "the replacement resumed the conversation with no writer conflict: {out}"
    );
    assert_ne!(
        h.native_pid(&new),
        old_native,
        "the replacement runs its own app-server"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_screen_only_crash_restarts_the_screen_against_the_running_app_server_silently() {
    let mut h = UnitHarness::start(HarnessOpts {
        auto_resume: AutoResumeMode::Capture,
        activity_hub: true,
        ..Default::default()
    })
    .await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-s", Some("t-screen")).await;
    let mut seen = OutputSeen::default();
    ready_seen(&h, &mut ws, &tid, &mut seen).await;
    start_settled(&h, &tid).await;
    let native = h.native_pid(&tid);
    let old_screen = screen_pid(&h, &tid);

    h.send(
        &mut ws,
        json!({"type": "terminal.input", "terminalId": tid, "data": "crash\r"}),
    )
    .await; // the TUI exits 1
    let again = ready_seen(&h, &mut ws, &tid, &mut seen).await;
    assert!(
        again["data"]
            .as_str()
            .unwrap()
            .contains("FAKE_TUI_READY thread=t-screen"),
        "a NEW screen in the SAME terminal resumed the same thread: {again}"
    );
    assert!(fake_codex::pid_alive(native), "the agent kept running");
    assert_eq!(h.native_pid(&tid), native);
    eventually("the unit pins the new screen", || {
        screen_pid(&h, &tid) != old_screen
    })
    .await;
    assert!(
        h.next_matching(&mut ws, Duration::from_secs(3), |f| {
            (f["type"] == "terminal.exit"
                || f["type"] == "terminal.idle"
                || f["type"] == "terminal.turn.complete")
                && f["terminalId"] == tid.as_str()
        })
        .await
        .is_none(),
        "no exit and no idle/turn-complete edge for a screen restart"
    );
    assert!(
        tokio::time::timeout(
            Duration::from_millis(500),
            h.crash_rx.as_mut().unwrap().recv()
        )
        .await
        .is_err(),
        "no crash event"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn quitting_codex_ends_the_unit_without_auto_resume() {
    let mut h = UnitHarness::start(HarnessOpts {
        auto_resume: AutoResumeMode::Capture,
        pane_ledger: true,
        ..Default::default()
    })
    .await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-q", Some("t-q")).await;
    ready(&h, &mut ws, &tid).await;
    start_settled(&h, &tid).await;
    let native = h.native_pid(&tid);

    h.send(
        &mut ws,
        json!({"type": "terminal.input", "terminalId": tid, "data": "quit\r"}),
    )
    .await;
    let exit = exit_within(&h, &mut ws, &tid, LIMIT)
        .await
        .expect("the quit ends the pane");
    assert_eq!(exit["exitCode"], 0, "{exit}");
    assert!(
        !fake_codex::pid_alive(native),
        "quitting ends the detached app-server too"
    );
    let crash = tokio::time::timeout(Duration::from_secs(3), h.crash_rx.as_mut().unwrap().recv())
        .await
        .expect("the exit reaches auto-resume")
        .expect("a crash event");
    assert_eq!(
        crash.exit_code, 0,
        "auto-resume's decide() settles a clean exit"
    );
    assert!(
        h.state.units.killed_start("crq-q"),
        "a clean quit is remembered as a stopped pane"
    );
    let record = h
        .state
        .pane_ledger
        .stopped_pane_for_terminal(&tid)
        .expect("a clean quit is remembered durably too (Task 18)");
    assert_eq!(record.create_request_id.as_deref(), Some("crq-q"));
    assert_eq!(record.reason, "agent-exited");
}

/// Codex's "quit, run in background" (exit 0 with a turn running): the work
/// goes on in the app-server, so the screen is restarted to keep it visible
/// (Stage 2: LB-40; V8 §40b).
#[tokio::test(flavor = "multi_thread")]
async fn quitting_codex_while_a_turn_runs_keeps_the_agent_and_restarts_the_screen() {
    let mut h = UnitHarness::start(HarnessOpts {
        behavior: json!({"turnCompleteDelayMs": 60000}),
        auto_resume: AutoResumeMode::Capture,
        ..Default::default()
    })
    .await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-qb", Some("t-qb")).await;
    ready(&h, &mut ws, &tid).await;
    start_settled(&h, &tid).await;
    let native = h.native_pid(&tid);
    turn_running(&h, &mut ws, &tid).await;

    h.send(
        &mut ws,
        json!({"type": "terminal.input", "terminalId": tid, "data": "quit\r"}),
    )
    .await; // the TUI exits 0
    let again = ready(&h, &mut ws, &tid).await;
    assert!(
        again["data"]
            .as_str()
            .unwrap()
            .contains("FAKE_TUI_READY thread=t-qb"),
        "a new screen in the same terminal shows the running work: {again}"
    );
    assert!(fake_codex::pid_alive(native), "the agent kept running");
    assert_eq!(h.native_pid(&tid), native);
    assert!(
        exit_within(&h, &mut ws, &tid, Duration::from_secs(3))
            .await
            .is_none(),
        "no terminal.exit"
    );
    assert!(
        tokio::time::timeout(
            Duration::from_millis(500),
            h.crash_rx.as_mut().unwrap().recv()
        )
        .await
        .is_err(),
        "no crash event"
    );
}

/// A turn already running before the pane's TUI attached to it (as in an
/// app-server a restarted Freshell reclaims mid-turn: no client heard the
/// turn start, and Codex announces nothing for a resume of a running
/// thread) is seen through the resume answer's thread status, so a quit
/// then keeps the agent and restarts the screen instead of ending the unit
/// (Task 17 review M2).
#[tokio::test(flavor = "multi_thread")]
async fn a_turn_running_before_the_tui_attached_keeps_the_agent_when_codex_quits() {
    let mut h = UnitHarness::start(HarnessOpts {
        behavior: json!({
            "preloadedThreads": ["t-mid"],
            "preloadedTurns": ["t-mid"],
            "turnCompleteDelayMs": 60000,
        }),
        auto_resume: AutoResumeMode::Capture,
        ..Default::default()
    })
    .await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-mid", Some("t-pane")).await;
    ready(&h, &mut ws, &tid).await;
    start_settled(&h, &tid).await;
    let native = h.native_pid(&tid);
    assert!(
        !freshell_ws::unit_threads::turn_running(&h.state, &tid),
        "no client heard the running turn start"
    );

    // The TUI attaches to the conversation that runs a turn.
    h.send(
        &mut ws,
        json!({"type": "terminal.input", "terminalId": tid, "data": "resume t-mid\r"}),
    )
    .await;
    let shown = ready(&h, &mut ws, &tid).await;
    assert!(
        shown["data"]
            .as_str()
            .unwrap()
            .contains("FAKE_TUI_READY thread=t-mid"),
        "{shown}"
    );
    h.send(
        &mut ws,
        json!({"type": "terminal.input", "terminalId": tid, "data": "quit\r"}),
    )
    .await; // the TUI exits 0
    let next = h
        .next_matching(&mut ws, LIMIT, |f| {
            f["terminalId"] == tid.as_str()
                && (f["type"] == "terminal.exit"
                    || (f["type"] == "terminal.output"
                        && f["data"]
                            .as_str()
                            .is_some_and(|d| d.contains("FAKE_TUI_READY"))))
        })
        .await
        .expect("a restarted screen or the pane's exit");
    assert_eq!(
        next["type"], "terminal.output",
        "the quit backgrounded the running turn and restarted the screen: {next}"
    );
    assert!(fake_codex::pid_alive(native), "the agent kept running");
    assert_eq!(h.native_pid(&tid), native);
    assert!(
        exit_within(&h, &mut ws, &tid, Duration::from_secs(3))
            .await
            .is_none(),
        "no terminal.exit"
    );
    assert!(
        tokio::time::timeout(
            Duration::from_millis(500),
            h.crash_rx.as_mut().unwrap().recv()
        )
        .await
        .is_err(),
        "no crash event"
    );
}

/// A quit that stops the running turn first (an interrupt, then an
/// immediate quit) is the user quitting Codex: the TUI exits 0 the moment it
/// sees its turn end, and the whole unit ends, whether or not the router has
/// applied that end to the pane's thread table yet (Task 17 review M3).
#[tokio::test(flavor = "multi_thread")]
async fn stopping_the_turn_and_quitting_at_once_ends_the_unit() {
    let mut h = UnitHarness::start(HarnessOpts {
        behavior: json!({"turnCompleteDelayMs": 60000}),
        auto_resume: AutoResumeMode::Capture,
        ..Default::default()
    })
    .await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-sq", Some("t-sq")).await;
    ready(&h, &mut ws, &tid).await;
    start_settled(&h, &tid).await;
    let native = h.native_pid(&tid);
    turn_running(&h, &mut ws, &tid).await;

    h.send(
        &mut ws,
        json!({"type": "terminal.input", "terminalId": tid, "data": "stop-and-quit\r"}),
    )
    .await;
    let exit = exit_within(&h, &mut ws, &tid, LIMIT)
        .await
        .expect("the quit ends the pane");
    assert_eq!(exit["exitCode"], 0, "{exit}");
    assert!(
        !fake_codex::pid_alive(native),
        "quitting ends the detached app-server too"
    );
    let crash = tokio::time::timeout(LIMIT, h.crash_rx.as_mut().unwrap().recv())
        .await
        .expect("the exit reaches auto-resume")
        .expect("a crash event");
    assert_eq!(
        crash.exit_code, 0,
        "auto-resume's decide() settles a clean exit"
    );
    assert!(
        h.state.units.killed_start("crq-sq"),
        "a clean quit is remembered as a stopped pane"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn quick_screen_crashes_end_the_unit_at_the_respawn_cap() {
    let mut h = UnitHarness::start(HarnessOpts {
        auto_resume: AutoResumeMode::Capture,
        ..Default::default()
    })
    .await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-cap", Some("t-cap")).await;
    ready(&h, &mut ws, &tid).await;
    start_settled(&h, &tid).await;
    let native = h.native_pid(&tid);
    let cap = 3; // the registry's default respawn generation cap

    let mut restarts = 0;
    let exit = 'crashes: {
        for _ in 0..10 {
            h.send(
                &mut ws,
                json!({"type": "terminal.input", "terminalId": tid, "data": "crash\r"}),
            )
            .await;
            let next = h
                .next_matching(&mut ws, LIMIT, |f| {
                    f["terminalId"] == tid.as_str()
                        && (f["type"] == "terminal.exit"
                            || (f["type"] == "terminal.output"
                                && f["data"]
                                    .as_str()
                                    .is_some_and(|d| d.contains("FAKE_TUI_READY"))))
                })
                .await
                .expect("a restarted screen or the pane's exit");
            if next["type"] == "terminal.exit" {
                assert!(
                    !fake_codex::pid_alive(native),
                    "the exit arrives only after the app-server has exited"
                );
                break 'crashes next;
            }
            restarts += 1;
        }
        panic!("no terminal.exit after 10 crashes ({restarts} restarts)");
    };
    assert_eq!(
        restarts, cap,
        "screens restart up to the cap, then the unit ends"
    );
    assert_ne!(exit["exitCode"], 0, "{exit}");
    let crash = tokio::time::timeout(LIMIT, h.crash_rx.as_mut().unwrap().recv())
        .await
        .expect("a crash event within the limit")
        .expect("a crash event");
    assert_eq!(crash.terminal_id, tid);
    assert_ne!(crash.exit_code, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_quit_during_a_backgrounded_restart_does_not_count_toward_the_cap() {
    let mut h = UnitHarness::start(HarnessOpts {
        behavior: json!({"turnCompleteDelayMs": 60000}),
        auto_resume: AutoResumeMode::Capture,
        ..Default::default()
    })
    .await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-qq", Some("t-qq")).await;
    ready(&h, &mut ws, &tid).await;
    start_settled(&h, &tid).await;
    let native = h.native_pid(&tid);
    turn_running(&h, &mut ws, &tid).await;

    for quit in 1..=4 {
        let before = screen_pid(&h, &tid);
        // A person reads Codex's quit prompt before choosing: no quit comes
        // within the floor of its screen's start.
        tokio::time::sleep(freshell_ws::unit_lifecycle::BACKGROUND_QUIT_FLOOR).await;
        h.send(
            &mut ws,
            json!({"type": "terminal.input", "terminalId": tid, "data": "quit\r"}),
        )
        .await;
        let next = h
            .next_matching(&mut ws, LIMIT, |f| {
                f["terminalId"] == tid.as_str()
                    && (f["type"] == "terminal.exit"
                        || (f["type"] == "terminal.output"
                            && f["data"]
                                .as_str()
                                .is_some_and(|d| d.contains("FAKE_TUI_READY"))))
            })
            .await
            .unwrap_or_else(|| panic!("quit {quit}: a restarted screen"));
        assert_eq!(
            next["type"], "terminal.output",
            "quit {quit} restarted the screen: {next}"
        );
        eventually("the unit pins the new screen", || {
            screen_pid(&h, &tid) != before
        })
        .await;
    }
    assert!(fake_codex::pid_alive(native), "the unit stays up");
    assert!(h.state.registry.ending(&tid).is_none());
    assert!(
        tokio::time::timeout(
            Duration::from_millis(500),
            h.crash_rx.as_mut().unwrap().recv()
        )
        .await
        .is_err(),
        "no crash event"
    );
}

/// A screen that quits (exit 0) as it starts while a turn runs is not a
/// person choosing "run in background" (no one chooses that faster than the
/// floor): such restarts count toward the respawn cap, so a TUI that keeps
/// quitting as it starts ends the unit instead of restarting until the turn
/// ends (Task 17 review M1).
#[tokio::test(flavor = "multi_thread")]
async fn screens_that_quit_as_they_start_while_a_turn_runs_end_the_unit_at_the_respawn_cap() {
    screens_that_quit_as_they_start_end_the_unit_at_the_cap("qs", None, LIMIT).await;
}

/// The floor's clock starts once a screen was spawned: a screen whose
/// spawn takes longer than the floor (a loaded host) and that then quits at
/// once is as fast as any other screen that quits as it starts, so its
/// restarts count toward the cap too (Task 17 re-review R2-m2).
#[tokio::test(flavor = "multi_thread")]
async fn screens_slow_to_spawn_that_quit_at_once_end_the_unit_at_the_respawn_cap() {
    let spawn_takes =
        freshell_ws::unit_lifecycle::BACKGROUND_QUIT_FLOOR + Duration::from_millis(200);
    // Each restart takes longer; the turn still runs for 60 s.
    screens_that_quit_as_they_start_end_the_unit_at_the_cap("qss", Some(spawn_takes), LIMIT * 2)
        .await;
}

/// A pane with a turn running whose screens, from its first quit on, quit
/// (exit 0) as they start: the row's counted screen restarts reach the
/// respawn cap, the restart past the cap is refused, and that refusal ends
/// the unit with the screens' code, its app-server included, and auto-resume
/// hears a clean exit, within `limit` of the first quit. With `spawn_takes`,
/// every screen spawn after the first takes that long before it returns (its
/// process already exists).
async fn screens_that_quit_as_they_start_end_the_unit_at_the_cap(
    name: &str,
    spawn_takes: Option<Duration>,
    limit: Duration,
) {
    let log = captured();
    let mut h = UnitHarness::start(HarnessOpts {
        behavior: json!({"turnCompleteDelayMs": 60000}),
        auto_resume: AutoResumeMode::Capture,
        pane_ledger: true,
        ..Default::default()
    })
    .await;
    let cap = 3;
    h.state.registry.set_respawn_generation_cap(cap);
    let mut ws = h.connect().await;
    let (request_id, thread_id) = (format!("crq-{name}"), format!("t-{name}"));
    let tid = h
        .create_codex(&mut ws, &request_id, Some(thread_id.as_str()))
        .await;
    ready(&h, &mut ws, &tid).await;
    start_settled(&h, &tid).await;
    let native = h.native_pid(&tid);
    turn_running(&h, &mut ws, &tid).await;

    if let Some(spawn_takes) = spawn_takes {
        h.state
            .registry
            .set_process_start_reader(std::sync::Arc::new(move |pid| {
                std::thread::sleep(spawn_takes);
                freshell_containment::process::start_time(pid).ok()
            }));
    }
    // Every screen started from now on quits as it starts (exit 0).
    std::fs::write(h.home.path().join(".fake-tui-quit-at-start"), "").expect("the marker");
    h.send(
        &mut ws,
        json!({"type": "terminal.input", "terminalId": tid, "data": "quit\r"}),
    )
    .await;

    let exit = exit_within(&h, &mut ws, &tid, limit)
        .await
        .expect("screens that quit as they start end the unit at the respawn cap");
    assert_eq!(exit["exitCode"], 0, "the screens' own code: {exit}");
    assert!(
        !fake_codex::pid_alive(native),
        "the whole unit ended, its app-server included"
    );
    let crash = tokio::time::timeout(LIMIT, h.crash_rx.as_mut().unwrap().recv())
        .await
        .expect("the end reaches auto-resume")
        .expect("a crash event");
    assert_eq!(crash.terminal_id, tid);
    assert_eq!(
        crash.exit_code, 0,
        "auto-resume's decide() settles a clean exit"
    );
    // A pane whose screens keep quitting as they start ends as a clean
    // quit: remembered as stopped (Task 17's flag, Task 18's record).
    let record = h
        .state
        .pane_ledger
        .stopped_pane_for_create_request(&request_id)
        .expect("the pane is remembered as stopped");
    assert_eq!(record.terminal_id.as_deref(), Some(tid.as_str()));

    // What ended the unit: the restart past the cap, refused by the registry
    // (any other failed restart, or an end at a quit, logs no such refusal).
    let refused = log
        .wait_for(
            tracing::Level::ERROR,
            "unit.screen.respawn_failed",
            &[("terminal_id", tid.as_str()), ("cause", "respawn cap")],
            LIMIT,
        )
        .await
        .unwrap_or_else(|| {
            panic!(
                "the unit ended because its next screen restart was past the respawn cap; \
                 the row's unit events: {:#?}",
                unit_events_of(&log, &tid)
            )
        });
    // Before it, the row's counted restarts reached the cap: the last screen
    // it installed was its `cap`-th quick restart in a row.
    let counts = quick_restart_counts(&log, &tid, refused.at);
    assert_eq!(
        counts.last().copied(),
        Some(cap as u32),
        "the screens restarted counted up to the cap before the unit ended \
         (the row's quick-restart count at each screen it installed: {counts:?})"
    );
}

/// The `quick_screen_restarts` count of every screen the row `terminal_id`
/// installed (`terminal.screen_replaced`) up to `until`, in order.
fn quick_restart_counts(
    log: &capture::Captured,
    terminal_id: &str,
    until: std::time::Instant,
) -> Vec<u32> {
    log.0
        .lock()
        .unwrap()
        .iter()
        .filter(|e| {
            e.event == "terminal.screen_replaced"
                && e.fields.get("terminal_id").map(String::as_str) == Some(terminal_id)
                && e.at <= until
        })
        .map(|e| {
            e.fields["quick_screen_restarts"]
                .parse()
                .expect("a numeric quick_screen_restarts")
        })
        .collect()
}

/// Every captured unit event of the row `terminal_id` (name and fields), for
/// a failure message.
fn unit_events_of(log: &capture::Captured, terminal_id: &str) -> Vec<String> {
    log.0
        .lock()
        .unwrap()
        .iter()
        .filter(|e| e.fields.get("terminal_id").map(String::as_str) == Some(terminal_id))
        .map(|e| format!("{} {} {:?}", e.level, e.event, e.fields))
        .collect()
}

/// During a server shutdown a screen's exit belongs to the retention path,
/// never to a restart or an end (Stage 2: LB-45).
#[tokio::test(flavor = "multi_thread")]
async fn a_screen_exit_after_shutdown_started_is_left_to_retention() {
    let h = UnitHarness::start(HarnessOpts {
        auto_resume: AutoResumeMode::Capture,
        ..Default::default()
    })
    .await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-sd", Some("t-sd")).await;
    ready(&h, &mut ws, &tid).await;
    start_settled(&h, &tid).await;
    let native = h.native_pid(&tid);

    h.state
        .shutdown_started
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let dead = kill_screen(&h, &tid);

    assert!(
        exit_within(&h, &mut ws, &tid, Duration::from_secs(2))
            .await
            .is_none(),
        "no terminal.exit"
    );
    assert_eq!(screen_pid(&h, &tid), dead, "no new screen starts");
    assert!(
        !fake_codex::pid_alive(dead),
        "the screen is dead (the test killed it)"
    );
    assert!(
        fake_codex::pid_alive(native),
        "the app-server keeps running"
    );
    assert!(h.unit_for(&tid).stop_in_flight().is_none(), "no stop began");
}

/// During a server shutdown the app-server's own exit is left to the
/// shutdown too (it stops or keeps every unit): no end, no crash event for
/// auto-resume while the server stops, and the unit's record stays for the
/// next boot (Task 17 review M5).
#[tokio::test(flavor = "multi_thread")]
async fn an_app_server_exit_after_shutdown_started_is_left_to_the_shutdown() {
    let mut h = UnitHarness::start(HarnessOpts {
        auto_resume: AutoResumeMode::Capture,
        ..Default::default()
    })
    .await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-sdm", Some("t-sdm")).await;
    ready(&h, &mut ws, &tid).await;
    start_settled(&h, &tid).await;

    h.state
        .shutdown_started
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let native = h.kill_native(&tid);

    assert!(
        exit_within(&h, &mut ws, &tid, Duration::from_secs(2))
            .await
            .is_none(),
        "no terminal.exit"
    );
    assert!(
        !fake_codex::pid_alive(native),
        "the app-server is dead (the test killed it)"
    );
    assert!(
        tokio::time::timeout(
            Duration::from_millis(500),
            h.crash_rx.as_mut().unwrap().recv()
        )
        .await
        .is_err(),
        "no crash event while the server stops"
    );
    let unit = h.unit_for(&tid);
    assert!(unit.stop_in_flight().is_none(), "no stop began");
    let record = h
        .state
        .units
        .containment
        .recorded_units()
        .expect("the unit records")
        .into_iter()
        .find(|record| &record.unit_id == unit.id())
        .expect("the unit's record stays for the next boot");
    assert_eq!(
        record.state,
        freshell_containment::UnitRecordState::Running,
        "the record is left as it was, for the next boot to decide"
    );
}

//! Every Codex terminal pane is created inside its unit: the TUI (the
//! screen), the native app-server behind the npm launcher (the main) and
//! everything it starts are members of one unit; the start settles only once
//! the screen's placement is confirmed; and the TUI quitting ends the whole
//! unit before anything is published, with a crash event fenced by the
//! post-commit generation.
#![cfg(target_os = "linux")]
#[path = "support/unit_harness.rs"]
mod unit_harness;

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use unit_harness::{fake_codex, AutoResumeMode, GoneDelay, HarnessOpts, UnitHarness};

const LIMIT: Duration = Duration::from_secs(15);

#[tokio::test(flavor = "multi_thread")]
async fn a_codex_pane_is_one_unit_holding_the_tui_and_the_sidecar() {
    let h = UnitHarness::start(HarnessOpts {
        behavior: json!({"threadStartThreadId": "t-one", "spawnHelperProcess": true}),
        ..Default::default()
    })
    .await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-one", None).await;
    let unit = h.unit_for(&tid);
    // The TUI's placement in the unit is confirmed when the start settles.
    tokio::time::timeout(LIMIT, h.state.units.start_settled(unit.id()))
        .await
        .expect("the start settles once its screen is placed");
    let manifest = h.native_manifest(&tid);
    let helper = {
        let manifests = h.manifests.clone();
        let native = manifest.pid;
        fake_codex::wait_until("the native reports its helper", LIMIT, move || {
            std::fs::read_to_string(manifests.join(format!("native-{native}.json")))
                .ok()
                .and_then(|raw| serde_json::from_str::<fake_codex::NativeManifest>(&raw).ok())
                .is_some_and(|m| m.children.helper.is_some())
        })
        .await;
        h.native_manifest(&tid).children.helper.unwrap()
    };
    let members: Vec<u32> = {
        let unit = unit.clone();
        tokio::task::spawn_blocking(move || unit.members().unwrap())
            .await
            .unwrap()
            .iter()
            .map(|m| m.pid)
            .collect()
    };
    let screen = unit
        .screen()
        .expect("the TUI is pinned as the screen")
        .pid();
    assert!(members.contains(&screen), "the TUI is a member");
    assert!(
        members.contains(&manifest.pid),
        "the native app-server is a member"
    );
    assert!(
        members.contains(&helper),
        "its own-process-group helper is a member"
    );
    assert_ne!(screen, manifest.pid, "screen and main differ for Codex");
}

#[tokio::test(flavor = "multi_thread")]
async fn quitting_the_codex_tui_ends_the_whole_unit_before_anything_is_published() {
    let h = UnitHarness::start(HarnessOpts {
        behavior: json!({"threadStartThreadId": "t-quit"}),
        ..Default::default()
    })
    .await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-quit", None).await;
    let native = h.native_pid(&tid);
    h.next_matching(&mut ws, Duration::from_secs(10), |f| {
        f["type"] == "terminal.output"
            && f["data"]
                .as_str()
                .is_some_and(|d| d.contains("FAKE_TUI_READY"))
    })
    .await
    .expect("tui ready");
    tokio::time::timeout(LIMIT, h.state.units.start_settled(h.unit_for(&tid).id()))
        .await
        .expect("the start settled");
    h.send(
        &mut ws,
        json!({"type": "terminal.input", "terminalId": tid, "data": "quit\r"}),
    )
    .await;
    let exit = h
        .exit_and_vacant(&mut ws, Duration::from_secs(20), &tid, "t-quit", || {
            assert!(
                !fake_codex::pid_alive(native),
                "terminal.exit and Vacant are published only after the app-server is gone"
            );
        })
        .await;
    assert_eq!(exit["exitCode"], 0);
    assert!(
        h.state.units.by_terminal(&tid).is_none(),
        "a settled start's entry is removed before Vacant is committed"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_crash_event_built_at_gone_carries_the_post_commit_fence() {
    let mut h = UnitHarness::start(HarnessOpts {
        auto_resume: AutoResumeMode::Capture,
        ..Default::default()
    })
    .await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-crash", Some("t-crash")).await;
    h.next_matching(&mut ws, Duration::from_secs(10), |f| {
        f["type"] == "terminal.output"
            && f["data"]
                .as_str()
                .is_some_and(|d| d.contains("FAKE_TUI_READY"))
    })
    .await
    .expect("tui ready");
    tokio::time::timeout(LIMIT, h.state.units.start_settled(h.unit_for(&tid).id()))
        .await
        .expect("the start settled");
    let ownership = h.state.ownership.clone().expect("an owner registry");
    let live = ownership.observe("codex", "t-crash");
    assert!(
        matches!(live.state, freshell_ownership::OwnershipState::Live { .. }),
        "the resumed pane holds its conversation: {:?}",
        live.state
    );

    h.send(
        &mut ws,
        json!({"type": "terminal.input", "terminalId": tid, "data": "quit\r"}),
    )
    .await;
    let crash = tokio::time::timeout(LIMIT, h.crash_rx.as_mut().unwrap().recv())
        .await
        .expect("a crash event at Gone")
        .expect("the auto-resume channel is open");
    assert_eq!(crash.terminal_id, tid);
    let after = ownership.observe("codex", "t-crash");
    assert!(
        matches!(after.state, freshell_ownership::OwnershipState::Vacant),
        "Vacant at Gone: {:?}",
        after.state
    );
    assert!(
        after.generation > live.generation,
        "the stop advanced the generation"
    );
    assert_eq!(
        crash.observed_fence,
        Some((ownership.boot_epoch(), after.generation)),
        "the crash event carries the post-commit pair auto-resume's claim accepts"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_start_settles_once_the_screen_is_placed() {
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-place", None).await;
    let unit = h.unit_for(&tid);
    tokio::time::timeout(
        unit_harness_placement_deadline() + Duration::from_secs(1),
        h.state.units.start_settled(unit.id()),
    )
    .await
    .expect("the start settles once the screen's placement is confirmed");
    let screen = unit.screen().expect("the screen is pinned").pid();
    let placed = {
        let unit = unit.clone();
        tokio::task::spawn_blocking(move || unit.confirm_placement(screen))
            .await
            .unwrap()
    };
    assert!(
        placed.is_ok(),
        "the screen is placed in the unit: {placed:?}"
    );
    assert!(h.state.units.start_is_settled(unit.id()));
}

fn unit_harness_placement_deadline() -> Duration {
    freshell_ws::unit_lifecycle::PLACEMENT_DEADLINE
}

fn is_vacant(h: &UnitHarness, session_id: &str) -> bool {
    matches!(
        h.state
            .ownership
            .as_ref()
            .expect("an owner registry")
            .observe("codex", session_id)
            .state,
        freshell_ownership::OwnershipState::Vacant
    )
}

async fn eventually(what: &str, f: impl Fn() -> bool) {
    let deadline = tokio::time::Instant::now() + LIMIT;
    while !f() {
        assert!(tokio::time::Instant::now() < deadline, "timed out: {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// A restore-class Codex create plans its launch (its app-server resumes the
/// conversation in the pane's unit) before it claims the conversation. When
/// it then gives up early (here another create holds the conversation's
/// sessionRef lease), the conversation is released only at that unit's
/// Gone, never when the create answers (Task 12 review M1).
#[tokio::test(flavor = "multi_thread")]
async fn a_restore_create_that_gives_up_early_releases_its_conversation_only_at_gone() {
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let locator = freshell_protocol::SessionLocator {
        provider: "codex".into(),
        session_id: "t-early".into(),
    };
    assert!(matches!(
        h.state
            .registry
            .claim_session_ref(&locator, "crq-other-holder", 0, 1_000),
        freshell_terminal::registry::SessionRefClaim::Acquired
    ));
    // Gone is confirmed 1.5 s after the kill, so the release order shows.
    let _gone_delay = GoneDelay::set(1500);
    let mut ws = h.connect().await;
    h.send(
        &mut ws,
        json!({
            "type": "terminal.create",
            "requestId": "crq-early",
            "mode": "codex",
            "shell": "system",
            "cwd": h.home.path().display().to_string(),
            "restore": true,
            "sessionRef": { "provider": "codex", "sessionId": "t-early" },
        }),
    )
    .await;
    let answer = h
        .next_matching(&mut ws, LIMIT, |f| {
            f["requestId"] == "crq-early"
                && (f["type"] == "terminal.created" || f["type"] == "error")
        })
        .await
        .expect("an answer to the create");
    assert_eq!(answer["type"], "error", "{answer}");
    let natives = h.native_manifests();
    assert_eq!(natives.len(), 1, "the restore planned its app-server first");
    let entry = h
        .state
        .units
        .all()
        .into_iter()
        .next()
        .expect("the given-up start's entry lives until its unit is Gone");

    // The create has returned and dropped its holds.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        !is_vacant(&h, "t-early"),
        "the conversation is not released before the unit's Gone"
    );
    entry
        .unit
        .stop_in_flight()
        .expect("the given-up start stopped its unit")
        .wait_for(LIMIT)
        .await
        .expect("the unit reaches Gone");
    assert!(
        !fake_codex::pid_alive(natives[0].pid),
        "the app-server is dead"
    );
    eventually("the conversation is released at Gone", || {
        is_vacant(&h, "t-early")
    })
    .await;
    eventually("the entry is removed", || h.state.units.all().is_empty()).await;
    h.state
        .registry
        .fail_session_ref_claim(&locator, "crq-other-holder");
}

/// An auto-resume whose replacement start is given up inside its unit (here
/// the replacement's plan resumed the conversation in a new app-server, then
/// it found no spawn permit in time) releases the conversation only at that
/// unit's Gone, never when the hub settles the failure (Task 12 review M1,
/// the respawn path).
#[tokio::test(flavor = "multi_thread")]
async fn a_failed_auto_resume_releases_its_conversation_only_at_its_units_gone() {
    let gate = Arc::new(freshell_freshagent::spawn_gate::SpawnGate::new(1, 8));
    let h = UnitHarness::start(HarnessOpts {
        spawn_gate: Some((Arc::clone(&gate), Duration::from_secs(30))),
        create_protect: freshell_ws::create_limit::CreateProtectConfig {
            spawn_timeout_ms: 1500,
            ..Default::default()
        },
        ..Default::default()
    })
    .await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-auto", Some("t-auto")).await;
    h.next_matching(&mut ws, LIMIT, |f| {
        f["type"] == "terminal.output"
            && f["data"]
                .as_str()
                .is_some_and(|d| d.contains("FAKE_TUI_READY"))
    })
    .await
    .expect("tui ready");
    tokio::time::timeout(LIMIT, h.state.units.start_settled(h.unit_for(&tid).id()))
        .await
        .expect("the start settled");
    // The replacement will find no spawn permit.
    let (_cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
    let held = gate
        .acquire(Duration::from_secs(1), &mut cancel_rx)
        .await
        .expect("hold the only spawn permit");
    let _gone_delay = GoneDelay::set(1500);

    h.send(
        &mut ws,
        json!({"type": "terminal.input", "terminalId": tid, "data": "crash\r"}),
    )
    .await;
    let settled = h
        .next_matching(&mut ws, Duration::from_secs(30), |f| {
            f["type"] == "terminal.status" && f["terminalId"] == tid && f["status"] == "exited"
        })
        .await
        .expect("the hub settles the auto-resume");
    assert_eq!(settled["reason"], "respawn_failed", "{settled}");
    let natives = h.native_manifests();
    assert_eq!(
        natives.len(),
        2,
        "the replacement planned its own app-server"
    );
    assert!(
        !is_vacant(&h, "t-auto"),
        "the conversation is not released before the replacement's unit is Gone"
    );
    eventually("the conversation is released at Gone", || {
        is_vacant(&h, "t-auto")
    })
    .await;
    for native in &natives {
        assert!(
            !fake_codex::pid_alive(native.pid),
            "every app-server is dead"
        );
    }
    eventually("no unit entry is left", || h.state.units.all().is_empty()).await;
    drop(held);
}

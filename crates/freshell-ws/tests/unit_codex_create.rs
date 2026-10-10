//! Every Codex terminal pane is created inside its unit: the TUI (the
//! screen), the native app-server behind the npm launcher (the main) and
//! everything it starts are members of one unit; the start settles only once
//! the screen's placement is confirmed; and the TUI quitting ends the whole
//! unit before anything is published, with a crash event fenced by the
//! post-commit generation.
#![cfg(target_os = "linux")]
#[path = "support/unit_harness.rs"]
mod unit_harness;

use std::time::Duration;

use serde_json::json;
use unit_harness::{fake_codex, AutoResumeMode, HarnessOpts, UnitHarness};

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
        .next_matching(&mut ws, Duration::from_secs(10), |f| {
            f["type"] == "terminal.exit" && f["terminalId"] == tid
        })
        .await
        .expect("terminal.exit");
    assert!(
        !fake_codex::pid_alive(native),
        "terminal.exit is published only after the app-server is gone"
    );
    assert_eq!(exit["exitCode"], 0);
    h.next_matching(&mut ws, Duration::from_secs(10), |f| {
        f["type"] == "session.runtimeOwner"
            && f["sessionId"] == "t-quit"
            && f["ownerKind"] == "vacant"
    })
    .await
    .expect("the conversation is Vacant at Gone");
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

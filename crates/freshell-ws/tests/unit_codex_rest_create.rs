//! Codex terminal panes created through the REST lane (`POST /api/tabs`)
//! run inside their unit exactly like WebSocket-created ones: the REST lane
//! shares the server's unit directory and containment
//! (`FreshAgentState::with_units`, as `main.rs` wires it), every stop runs
//! through the WebSocket layer's single stop path, `terminal.exit` and
//! Vacant are published only at Gone, and a REST start that is given up
//! (its unit could not be recorded, its TUI could not spawn, or a stop
//! reached Gone before it committed) leaves no process, no row and no
//! directory entry behind and releases its conversation only at Gone.
//! Also: a handoff away from a pane in its unit succeeds on its first
//! attempt.
#![cfg(target_os = "linux")]
#[path = "support/unit_harness.rs"]
mod unit_harness;

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use unit_harness::{fake_codex, GoneDelay, HarnessOpts, UnitHarness};

const LIMIT: Duration = Duration::from_secs(15);

fn terminal_id_of(body: &serde_json::Value) -> String {
    body["data"]["terminalId"]
        .as_str()
        .unwrap_or_else(|| panic!("the REST create names its terminal: {body}"))
        .to_string()
}

async fn tui_ready(h: &UnitHarness, ws: &mut unit_harness::TestWs) {
    h.next_matching(ws, LIMIT, |f| {
        f["type"] == "terminal.output"
            && f["data"]
                .as_str()
                .is_some_and(|d| d.contains("FAKE_TUI_READY"))
    })
    .await
    .expect("the TUI is ready");
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

/// The happy path: the REST-created pane's TUI, its native app-server and
/// the app-server's own-process-group helper are members of ONE unit, the
/// conversation's owner is stamped with that unit, and quitting the TUI
/// publishes `terminal.exit` only once the app-server is dead and Vacant
/// only at Gone (after the pane's directory entry is gone).
#[tokio::test(flavor = "multi_thread")]
async fn a_rest_created_codex_pane_is_one_unit_and_its_end_is_published_at_gone() {
    let h = UnitHarness::start(HarnessOpts {
        behavior: json!({"spawnHelperProcess": true}),
        ..Default::default()
    })
    .await;
    let (status, body) = h.rest_create_codex(Some("t-rest")).await;
    assert_eq!(status, 200, "{body}");
    let tid = terminal_id_of(&body);

    let unit = h.unit_for(&tid);
    tokio::time::timeout(LIMIT, h.state.units.start_settled(unit.id()))
        .await
        .expect("the REST start settles once its screen is placed");
    let native = h.native_pid(&tid);
    let helper = {
        let manifests = h.manifests.clone();
        fake_codex::wait_until("the native reports its helper", LIMIT, move || {
            std::fs::read_to_string(manifests.join(format!("native-{native}.json")))
                .ok()
                .and_then(|raw| serde_json::from_str::<fake_codex::NativeManifest>(&raw).ok())
                .is_some_and(|m| m.children.helper.is_some())
        })
        .await;
        h.native_manifest(&tid).children.helper.unwrap()
    };
    let screen = unit
        .screen()
        .expect("the TUI is pinned as the screen")
        .pid();
    let members: Vec<u32> = {
        let unit = unit.clone();
        tokio::task::spawn_blocking(move || unit.members().unwrap())
            .await
            .unwrap()
            .iter()
            .map(|m| m.pid)
            .collect()
    };
    assert!(
        members.contains(&screen),
        "the TUI is a member: {members:?}"
    );
    assert!(members.contains(&native), "the app-server is a member");
    assert!(members.contains(&helper), "its helper is a member");
    match h
        .state
        .ownership
        .as_ref()
        .unwrap()
        .observe("codex", "t-rest")
        .state
    {
        freshell_ownership::OwnershipState::Live { owner, .. } => assert_eq!(
            owner.unit_id.as_deref(),
            Some(unit.id().as_str()),
            "the owner is stamped with the pane's unit"
        ),
        other => panic!("the REST pane holds its conversation: {other:?}"),
    }

    let mut ws = h.connect().await;
    h.attach(&mut ws, &tid).await;
    tui_ready(&h, &mut ws).await;
    h.send(
        &mut ws,
        json!({"type": "terminal.input", "terminalId": tid, "data": "quit\r"}),
    )
    .await;
    let exit = h
        .next_matching(&mut ws, LIMIT, |f| {
            f["type"] == "terminal.exit" && f["terminalId"] == tid
        })
        .await
        .expect("terminal.exit");
    assert!(
        !fake_codex::pid_alive(native),
        "terminal.exit is published only after the app-server is gone"
    );
    assert_eq!(exit["exitCode"], 0);
    h.next_matching(&mut ws, LIMIT, |f| {
        f["type"] == "session.runtimeOwner"
            && f["sessionId"] == "t-rest"
            && f["ownerKind"] == "vacant"
    })
    .await
    .expect("the conversation is Vacant at Gone");
    assert!(
        h.state.units.by_terminal(&tid).is_none(),
        "the settled start's entry is removed before Vacant is committed"
    );
}

/// A REST Codex create whose unit record cannot be written fails before
/// anything starts: no app-server, no row, no directory entry, and the
/// conversation it claimed is released.
#[tokio::test(flavor = "multi_thread")]
async fn a_rest_codex_start_whose_unit_cannot_be_recorded_starts_nothing() {
    let not_a_dir = tempfile::NamedTempFile::new().unwrap();
    let h = UnitHarness::start(HarnessOpts {
        containment: Some(freshell_containment::Containment::tag_backend(
            freshell_containment::SelectOptions {
                shim: None,
                state_root: not_a_dir.path().to_path_buf(),
            },
        )),
        ..Default::default()
    })
    .await;
    let (status, body) = h.rest_create_codex(Some("t-norecord")).await;
    assert_eq!(status, 500, "{body}");
    assert!(
        body.to_string()
            .contains("codex unit could not be recorded"),
        "{body}"
    );
    assert!(h.native_manifests().is_empty(), "no app-server was started");
    assert!(
        h.state.registry.inventory().is_empty(),
        "no terminal row was created"
    );
    assert!(h.state.units.all().is_empty(), "no unit entry is left");
    assert!(is_vacant(&h, "t-norecord"), "the conversation is released");
}

/// The REST start's TUI cannot spawn after its plan started the app-server
/// in the pane's unit: the start is given up through the single stop path,
/// so the app-server dies and the entry goes, and the conversation is
/// released only at the unit's Gone (never when the create answers).
#[tokio::test(flavor = "multi_thread")]
async fn a_rest_codex_spawn_failure_stops_its_unit_and_releases_the_conversation_at_gone() {
    let h = UnitHarness::start(HarnessOpts {
        rest_codex_tui_cmd: Some("freshell-test-no-such-codex-tui".into()),
        ..Default::default()
    })
    .await;
    // Gone is confirmed 1.5 s after the kill, so the release order shows.
    let _gone_delay = GoneDelay::set(1500);
    let (status, body) = h.rest_create_codex(Some("t-nospawn")).await;
    assert_eq!(status, 400, "{body}");
    let natives = h.native_manifests();
    assert_eq!(natives.len(), 1, "the plan started one app-server");
    assert!(
        !is_vacant(&h, "t-nospawn"),
        "the conversation is not released when the create answers"
    );
    let entry = h
        .state
        .units
        .all()
        .into_iter()
        .next()
        .expect("the given-up start's entry lives until its unit is Gone");
    let report = entry
        .unit
        .stop_in_flight()
        .expect("the give-up stopped the unit")
        .wait_for(LIMIT)
        .await
        .expect("the unit reaches Gone");
    assert_eq!(report.reason, "start-cancelled");
    assert!(
        !fake_codex::pid_alive(natives[0].pid),
        "the app-server is dead"
    );
    eventually("the conversation is released after Gone", || {
        is_vacant(&h, "t-nospawn")
    })
    .await;
    eventually("the entry is removed", || h.state.units.all().is_empty()).await;
    assert!(h.state.registry.inventory().is_empty(), "no row is left");
}

/// A stop that reaches Gone while a REST start waits for its spawn permit
/// (after its plan started the app-server) ends the start: the create is
/// answered as cancelled, no TUI row is created, and nothing is left.
#[tokio::test(flavor = "multi_thread")]
async fn a_stop_that_reaches_gone_before_a_rest_start_commits_ends_the_start() {
    let gate = Arc::new(freshell_freshagent::spawn_gate::SpawnGate::new(1, 8));
    let h = Arc::new(
        UnitHarness::start(HarnessOpts {
            spawn_gate: Some((Arc::clone(&gate), Duration::from_secs(30))),
            ..Default::default()
        })
        .await,
    );
    let (_cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
    let held = gate
        .acquire(Duration::from_secs(1), &mut cancel_rx)
        .await
        .expect("hold the only spawn permit");
    let queued_before = gate.queued_total();
    let create = tokio::spawn({
        let h = Arc::clone(&h);
        async move { h.rest_create_codex(Some("t-gone")).await }
    });
    // The plan finished (its app-server runs) and the start waits for the
    // permit.
    eventually("the REST start waits for its spawn permit", || {
        gate.queued_total() > queued_before
    })
    .await;
    let entry = h
        .state
        .units
        .all()
        .into_iter()
        .next()
        .expect("the starting entry");
    let natives = h.native_manifests();
    assert_eq!(natives.len(), 1, "the plan started one app-server");

    let stop = h
        .state
        .units
        .stop_unit(
            entry.unit.id(),
            freshell_containment::StopMode::Force,
            freshell_containment::StopReason::ShiftX,
            "test-kill",
        )
        .expect("the start's unit stops through the lifecycle");
    stop.wait_for(LIMIT).await.expect("Gone");
    drop(held);

    let (status, body) = tokio::time::timeout(Duration::from_secs(60), create)
        .await
        .expect("the create answers")
        .unwrap();
    assert_ne!(
        status, 200,
        "a start stopped before it committed fails: {body}"
    );
    assert!(
        !fake_codex::pid_alive(natives[0].pid),
        "the app-server is dead"
    );
    assert!(
        h.state.registry.inventory().is_empty(),
        "no TUI row was created"
    );
    eventually("the entry is removed", || h.state.units.all().is_empty()).await;
    eventually("the conversation is released", || is_vacant(&h, "t-gone")).await;
}

/// A switch away from a Codex terminal pane in its unit (here to a new
/// terminal pane of the same conversation, through the real handoff runner)
/// succeeds on its first attempt: the prior is stopped under the handoff's
/// own operation, so the handoff keeps its key and commits it to the target
/// (Task 12 review I2: a fresh kill operation made that commit stale).
#[tokio::test(flavor = "multi_thread")]
async fn a_handoff_away_from_a_pane_in_its_unit_succeeds_on_the_first_attempt() {
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let mut ws = h.connect().await;
    let prior = h
        .create_codex(&mut ws, "crq-handoff", Some("t-handoff"))
        .await;
    tui_ready(&h, &mut ws).await;
    let prior_unit = h.unit_for(&prior);
    tokio::time::timeout(LIMIT, h.state.units.start_settled(prior_unit.id()))
        .await
        .expect("the prior's start settled");
    let prior_native = h.native_pid(&prior);

    let (status, body) = h
        .post(
            "/api/sessions/handoff",
            json!({
                "provider": "codex",
                "sessionId": "t-handoff",
                "targetKind": "terminal",
                "mode": "codex",
                "cwd": h.home.path().display().to_string(),
                "deviceId": "test-device",
            }),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body["ok"],
        json!(true),
        "the first attempt succeeds: {body}"
    );

    assert!(
        !fake_codex::pid_alive(prior_native),
        "the prior's app-server is gone"
    );
    assert!(
        h.state.units.by_terminal(&prior).is_none(),
        "the prior's unit is gone"
    );
    match h
        .state
        .ownership
        .as_ref()
        .unwrap()
        .observe("codex", "t-handoff")
        .state
    {
        freshell_ownership::OwnershipState::Live { owner, .. } => {
            let target = owner.terminal_id.expect("a terminal owner");
            assert_ne!(target, prior, "the target owns the conversation");
            assert!(h.state.registry.is_pty_running(&target));
        }
        other => panic!("the handoff committed its target: {other:?}"),
    }
}

async fn eventually(what: &str, f: impl Fn() -> bool) {
    let deadline = tokio::time::Instant::now() + LIMIT;
    while !f() {
        assert!(tokio::time::Instant::now() < deadline, "timed out: {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

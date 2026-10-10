//! Lib tests of the pane-unit lifecycle core: the screen-exit hook's start
//! failure, joins that never send a crash event, and the single stop path's
//! registry-driven join. Units run on the tag backend with their records
//! under a per-test temporary state root. Linux only (PTY screens).
#![cfg(target_os = "linux")]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use freshell_containment::{Containment, MemberRole, SelectOptions, StopMode, StopReason};
use freshell_protocol::ServerMessage;
use freshell_terminal::{FrameSink, PacedAttachOptions, UnitPlacement};

use super::*;
use crate::auto_resume::CrashEvent;

const LIMIT: Duration = Duration::from_secs(15);

/// A test state with an enabled owner registry (shared with the terminal
/// registry, as at boot), an auto-resume receiver and tag-backend units
/// under `root`, with the unit lifecycle wired.
fn unit_state(
    root: &std::path::Path,
) -> (WsState, tokio::sync::mpsc::UnboundedReceiver<CrashEvent>) {
    let mut state = crate::test_ws_state();
    let ownership = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    state.registry =
        freshell_terminal::TerminalRegistry::new().with_ownership(Arc::clone(&ownership));
    state.ownership = Some(ownership);
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    state.auto_resume_tx = tx;
    state.units = UnitServices {
        directory: UnitDirectory::new(),
        containment: Containment::tag_backend(SelectOptions {
            shim: None,
            state_root: root.to_path_buf(),
        }),
    };
    wire(&state, &tokio::runtime::Handle::current());
    (state, rx)
}

fn bash(script: &str) -> freshell_platform::SpawnSpec {
    freshell_platform::SpawnSpec {
        program: "bash".into(),
        args: vec!["-c".into(), script.into()],
        env_overrides: Default::default(),
        cwd: None,
        cols: 80,
        rows: 24,
    }
}

fn env() -> std::collections::BTreeMap<String, String> {
    std::env::vars()
        .filter(|(k, _)| k == "PATH" || k == "HOME")
        .collect()
}

/// Spawns `script` as the screen of `scope`'s current unit, in row `tid`.
async fn spawn_screen(state: &WsState, scope: &StartScope, tid: &str, script: &str) -> u32 {
    let unit = scope.unit();
    let placement = unit.placement(MemberRole::Screen).expect("placement");
    let registry = state.registry.clone();
    let tid = tid.to_string();
    let spec = bash(script);
    tokio::task::spawn_blocking(move || {
        registry.create_in_unit(
            &spec,
            &env(),
            tid,
            uuid::Uuid::new_v4().to_string(),
            "codex",
            None,
            Some("crq"),
            None,
            None,
            UnitPlacement {
                unit_id: unit.id().to_string(),
                wrapper: placement.wrapper,
                env: placement.env,
                main_is_screen: false,
            },
        )
    })
    .await
    .unwrap()
    .expect("screen spawned")
}

fn attach_collector(state: &WsState, tid: &str) -> Arc<Mutex<Vec<ServerMessage>>> {
    let seen: Arc<Mutex<Vec<ServerMessage>>> = Arc::default();
    let sink: FrameSink = Arc::new({
        let seen = seen.clone();
        move |msg| seen.lock().unwrap().push(msg)
    });
    let _ = state.registry.attach(
        tid,
        1,
        sink,
        Some("a".into()),
        0,
        false,
        false,
        None,
        None,
        None,
        PacedAttachOptions::default(),
    );
    seen
}

fn exit_codes(seen: &Arc<Mutex<Vec<ServerMessage>>>) -> Vec<i64> {
    seen.lock()
        .unwrap()
        .iter()
        .filter_map(|m| match m {
            ServerMessage::TerminalExit(e) => Some(e.exit_code),
            _ => None,
        })
        .collect()
}

async fn eventually(what: &str, f: impl Fn() -> bool) {
    let deadline = tokio::time::Instant::now() + LIMIT;
    while !f() {
        assert!(tokio::time::Instant::now() < deadline, "timed out: {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// A screen that exits before its start settled is a typed start failure:
/// no crash event, an ERROR `unit.placement_failed` with its exit code, the
/// row published with that code and kept `Exited`, and the start, given up
/// by its create, ends settled.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_exit_before_placement_is_confirmed_is_a_start_failure_not_a_crash() {
    let logs = crate::invariants::capture::capture();
    let root = tempfile::tempdir().unwrap();
    let (state, mut crashes) = unit_state(root.path());
    let scope =
        StartScope::begin(&state, "codex", "codex", "crq-early", "T-early", None).expect("start");
    let unit = scope.unit();

    // No `spawned`/`bind` yet: the exit races the start.
    spawn_screen(&state, &scope, "T-early", "sleep 0.5; exit 1").await;
    let seen = attach_collector(&state, "T-early");

    let stop = {
        let watched = unit.clone();
        eventually("the screen exit stops the unit", move || {
            watched.stop_in_flight().is_some()
        })
        .await;
        unit.stop_in_flight().unwrap()
    };
    let report = stop.wait_for(LIMIT).await.expect("Gone");
    assert_eq!(report.reason, "placement-failed");
    assert_eq!(
        exit_codes(&seen),
        vec![1],
        "published with the screen's code"
    );
    let row = state.registry.probe("T-early").expect("the row is kept");
    assert_eq!(row.status, freshell_protocol::TerminalRunStatus::Exited);
    let failed = {
        let logs = logs.lock().unwrap_or_else(|p| p.into_inner());
        logs.iter()
            .filter(|e| {
                e.fields.get("event").map(String::as_str) == Some("unit.placement_failed")
                    && e.fields.get("unit_id").map(String::as_str) == Some(unit.id().as_str())
            })
            .cloned()
            .collect::<Vec<_>>()
    };
    assert_eq!(failed.len(), 1, "one placement failure line");
    assert_eq!(
        failed[0].fields.get("exit_code").map(String::as_str),
        Some("1")
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(500), crashes.recv())
            .await
            .is_err(),
        "a start failure is never a crash"
    );

    // The create sees its start cancelled and gives it up.
    assert!(scope.cancelled());
    let settled = state.units.start_settled(unit.id());
    scope.abandon(None);
    tokio::time::timeout(LIMIT, settled)
        .await
        .expect("the start ends settled");
    assert!(state.units.get(unit.id()).is_none());
    assert_eq!(
        state.registry.probe("T-early").map(|r| r.status),
        Some(freshell_protocol::TerminalRunStatus::Exited),
        "giving the start up leaves the failed row as it was published"
    );
}

/// A running pane's unit, bound and committed, with its screen `script`.
async fn running_pane(state: &WsState, tid: &str, crq: &str, script: &str) -> UnitEntry {
    let mut scope = StartScope::begin(state, "codex", "codex", crq, tid, None).expect("start");
    let pid = spawn_screen(state, &scope, tid, script).await;
    assert_eq!(scope.spawned(tid, pid), Spawned::Running);
    scope.bind();
    let unit = scope.unit();
    scope.commit();
    tokio::time::timeout(LIMIT, state.units.start_settled(unit.id()))
        .await
        .expect("the placed start settles");
    state.units.get(unit.id()).expect("a running pane's entry")
}

/// A user kill that joins an agent-exit stop before that stop runs takes
/// over its reason, and the crash event is not sent.
#[test]
fn a_kill_joining_an_agent_exit_stop_sends_no_crash_event() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let root = tempfile::tempdir().unwrap();
        let (state, mut crashes) = unit_state(root.path());
        let entry = running_pane(&state, "T-join", "crq-join", "sleep 30").await;

        // Back to back, no await: the kill joins before the stop task runs.
        let first = stop_terminal_unit(
            &state,
            &entry,
            UnitStopCommand {
                mode: StopMode::Force,
                reason: StopReason::AgentExited { exit_code: Some(3) },
                initiator: "unit-screen-exit".into(),
                operation_id: "unit-exit-test".into(),
                record_stopped_pane: false,
            },
        );
        let second = stop_terminal_unit(
            &state,
            &entry,
            UnitStopCommand {
                mode: StopMode::Force,
                reason: StopReason::ShiftX,
                initiator: "test-kill".into(),
                operation_id: "term-kill-test".into(),
                record_stopped_pane: true,
            },
        );
        let report = first.wait_for(LIMIT).await.expect("Gone");
        assert_eq!(report.reason, "shift-x", "the kill took over the stop");
        assert_eq!(second.try_report(), Some(report));
        assert!(
            tokio::time::timeout(Duration::from_millis(500), crashes.recv())
                .await
                .is_err(),
            "a stop a user kill took over sends no crash event"
        );
        assert!(state.units.killed_start("crq-join"));
        assert!(
            state.registry.probe("T-join").is_none(),
            "the killed pane's row is removed like every kill's, never kept as a crashed one"
        );
    });
}

/// Two stop calls back to back with different operation ids: one stop, one
/// Gone publication, the unit's key committed Vacant under the FIRST call's
/// operation (the registry decided the join), and both handles see the
/// same report.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_terminal_unit_is_the_only_stop_and_joins_by_registry_state() {
    let root = tempfile::tempdir().unwrap();
    let (state, _crashes) = unit_state(root.path());
    let entry = running_pane(&state, "T-only", "crq-only", "sleep 30").await;
    let ownership = state.ownership.clone().unwrap();
    let freshell_ownership::BeginOutcome::Granted { generation } = ownership.begin_start(
        "codex",
        "s-only",
        freshell_ownership::RuntimeOwnerKind::Terminal,
        "op-start",
        None,
        "test",
        1,
    ) else {
        panic!("granted")
    };
    assert_eq!(
        ownership.commit_live(
            "codex",
            "s-only",
            "op-start",
            generation,
            freshell_ownership::OwnerIdentity {
                terminal_id: Some("T-only".into()),
                unit_id: Some(entry.unit.id().to_string()),
                ..Default::default()
            },
        ),
        freshell_ownership::CommitOutcome::Committed
    );
    let mut frames = state.broadcast_tx.subscribe();

    let command = |operation_id: &str| UnitStopCommand {
        mode: StopMode::Force,
        reason: StopReason::ShiftX,
        initiator: "test-kill".into(),
        operation_id: operation_id.into(),
        record_stopped_pane: false,
    };
    let first = stop_terminal_unit(&state, &entry, command("op-first"));
    let second = stop_terminal_unit(&state, &entry, command("op-second"));
    let report = first.wait_for(LIMIT).await.expect("Gone");
    assert_eq!(second.wait_for(LIMIT).await, Some(report));

    let snapshot = ownership.observe("codex", "s-only");
    assert!(
        matches!(snapshot.state, freshell_ownership::OwnershipState::Vacant),
        "Vacant at Gone: {:?}",
        snapshot.state
    );
    let mut owner_frames = Vec::new();
    while let Ok(frame) = frames.try_recv() {
        let value: serde_json::Value = serde_json::from_str(&frame).unwrap();
        if value["type"] == "session.runtimeOwner" && value["sessionId"] == "s-only" {
            owner_frames.push(value);
        }
    }
    let transitions: Vec<_> = owner_frames
        .iter()
        .map(|f| f["transition"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        transitions,
        vec!["stopping".to_string(), "released".to_string()],
        "one stop began and one Gone was published"
    );
    assert_eq!(owner_frames[1]["operationId"], "op-first");
    assert_eq!(owner_frames[1]["ownerKind"], "vacant");
}

/// A key of the unit already Stopping under ANOTHER operation (a stop a
/// different lane began) is joined under that operation, so the one Gone
/// commit releases it: the registry, not the caller, decides the operation.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stop_joins_a_key_already_stopping_under_another_operation() {
    let root = tempfile::tempdir().unwrap();
    let (state, _crashes) = unit_state(root.path());
    let entry = running_pane(&state, "T-other", "crq-other", "sleep 30").await;
    let ownership = state.ownership.clone().unwrap();
    let freshell_ownership::BeginOutcome::Granted { generation } = ownership.begin_start(
        "codex",
        "s-other",
        freshell_ownership::RuntimeOwnerKind::Terminal,
        "op-start",
        None,
        "test",
        1,
    ) else {
        panic!("granted")
    };
    ownership.commit_live(
        "codex",
        "s-other",
        "op-start",
        generation,
        freshell_ownership::OwnerIdentity {
            terminal_id: Some("T-other".into()),
            unit_id: Some(entry.unit.id().to_string()),
            ..Default::default()
        },
    );
    // Another lane began the unit's stop first.
    ownership.begin_unit_stop(entry.unit.id().as_str(), "op-elsewhere", "another-lane", 2);

    let report = stop_terminal_unit(
        &state,
        &entry,
        UnitStopCommand {
            mode: StopMode::Force,
            reason: StopReason::ShiftX,
            initiator: "test-kill".into(),
            operation_id: "op-mine".into(),
            record_stopped_pane: false,
        },
    )
    .wait_for(LIMIT)
    .await
    .expect("Gone");
    assert_eq!(report.reason, "shift-x");
    assert!(
        matches!(
            ownership.observe("codex", "s-other").state,
            freshell_ownership::OwnershipState::Vacant
        ),
        "the key the other lane moved to Stopping is released at Gone"
    );
}

/// The `freshell_unit` lines captured for `unit`.
fn unit_lines(
    logs: &Arc<Mutex<Vec<crate::invariants::capture::CapturedEvent>>>,
    unit: &AgentUnit,
    event: &str,
) -> usize {
    let logs = logs.lock().unwrap_or_else(|p| p.into_inner());
    logs.iter()
        .filter(|e| {
            e.fields.get("event").map(String::as_str) == Some(event)
                && e.fields.get("unit_id").map(String::as_str) == Some(unit.id().as_str())
        })
        .count()
}

/// A screen its own unit's stop killed is part of that stop, never a
/// placement failure: here the stop began before the start's row was noted
/// (so it marked no ending), and the screen's exit then arrives while the
/// stop is in flight. No `unit.placement_failed`, and the row is removed as
/// the requested stop it is (Task 12 review M3).
#[test]
fn a_screen_its_own_stop_killed_is_not_a_placement_failure() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let logs = crate::invariants::capture::capture();
        let root = tempfile::tempdir().unwrap();
        let (state, _crashes) = unit_state(root.path());
        let mut scope =
            StartScope::begin(&state, "codex", "codex", "crq-own", "T-own", None).expect("start");
        let unit = scope.unit();
        let pid = spawn_screen(&state, &scope, "T-own", "sleep 30").await;

        // Back to back, no await: the stop begins before the row is noted,
        // then the row is noted, then the screen's exit (the stop killing
        // it) reaches the hook while the stop is in flight.
        let stop = stop_terminal_unit(
            &state,
            &state.units.get(unit.id()).expect("the starting entry"),
            UnitStopCommand {
                mode: StopMode::Force,
                reason: StopReason::ShiftX,
                initiator: "test-kill".into(),
                operation_id: "term-kill-own".into(),
                record_stopped_pane: true,
            },
        );
        assert_eq!(scope.spawned("T-own", pid), Spawned::Running);
        on_screen_exit(
            &state,
            UnitScreenExit {
                terminal_id: "T-own".into(),
                unit_id: unit.id().to_string(),
                exit_code: 137,
                screen_generation: 0,
            },
        );

        let report = stop.wait_for(LIMIT).await.expect("Gone");
        assert_eq!(report.reason, "shift-x");
        assert_eq!(
            unit_lines(&logs, &unit, "unit.placement_failed"),
            0,
            "the stop's own kill is not a start failure"
        );
        assert!(
            state.registry.probe("T-own").is_none(),
            "the row ends as the requested stop: removed, not kept Exited"
        );
        scope.abandon(None);
    });
}

/// A unit stop that begins before its start knows a terminal broadcasts the
/// live "stopping" owner frame WITHOUT a terminal id (never `""`), and one
/// that knows it names it (Task 12 review N4).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stopping_frame_names_a_terminal_only_when_one_is_known() {
    let root = tempfile::tempdir().unwrap();
    let (state, _crashes) = unit_state(root.path());
    let ownership = state.ownership.clone().unwrap();
    let scope =
        StartScope::begin(&state, "codex", "codex", "crq-frame", "T-frame", None).expect("start");
    let unit = scope.unit();
    let hold = |session: &str, terminal: Option<&str>| {
        let freshell_ownership::BeginOutcome::Granted { generation } = ownership.begin_start(
            "codex",
            session,
            freshell_ownership::RuntimeOwnerKind::Terminal,
            "op-start",
            None,
            "test",
            1,
        ) else {
            panic!("granted")
        };
        assert_eq!(
            ownership.commit_live(
                "codex",
                session,
                "op-start",
                generation,
                freshell_ownership::OwnerIdentity {
                    terminal_id: terminal.map(str::to_string),
                    unit_id: Some(unit.id().to_string()),
                    ..Default::default()
                },
            ),
            freshell_ownership::CommitOutcome::Committed
        );
    };
    hold("s-frame", None);
    let mut frames = state.broadcast_tx.subscribe();

    let stop = stop_terminal_unit(
        &state,
        &state.units.get(unit.id()).expect("the starting entry"),
        UnitStopCommand {
            mode: StopMode::Force,
            reason: StopReason::ShiftX,
            initiator: "test-kill".into(),
            operation_id: "op-frame".into(),
            record_stopped_pane: false,
        },
    );
    let stopping = loop {
        let frame: serde_json::Value = serde_json::from_str(
            &tokio::time::timeout(LIMIT, frames.recv())
                .await
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        if frame["type"] == "session.runtimeOwner" && frame["transition"] == "stopping" {
            break frame;
        }
    };
    assert_eq!(stopping["sessionId"], "s-frame");
    assert!(
        stopping.get("terminalId").is_none(),
        "no terminal is known yet, so none is named: {stopping}"
    );
    stop.wait_for(LIMIT).await.expect("Gone");
    scope.abandon(None);

    // A pane whose row is known names it.
    let entry = running_pane(&state, "T-named", "crq-named", "sleep 30").await;
    let ownership_unit = entry.unit.id().to_string();
    let freshell_ownership::BeginOutcome::Granted { generation } = ownership.begin_start(
        "codex",
        "s-named",
        freshell_ownership::RuntimeOwnerKind::Terminal,
        "op-start-2",
        None,
        "test",
        1,
    ) else {
        panic!("granted")
    };
    ownership.commit_live(
        "codex",
        "s-named",
        "op-start-2",
        generation,
        freshell_ownership::OwnerIdentity {
            terminal_id: Some("T-named".into()),
            unit_id: Some(ownership_unit),
            ..Default::default()
        },
    );
    let stop = stop_terminal_unit(
        &state,
        &entry,
        UnitStopCommand {
            mode: StopMode::Force,
            reason: StopReason::ShiftX,
            initiator: "test-kill".into(),
            operation_id: "op-named".into(),
            record_stopped_pane: false,
        },
    );
    let stopping = loop {
        let frame: serde_json::Value = serde_json::from_str(
            &tokio::time::timeout(LIMIT, frames.recv())
                .await
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        if frame["type"] == "session.runtimeOwner"
            && frame["transition"] == "stopping"
            && frame["sessionId"] == "s-named"
        {
            break frame;
        }
    };
    assert_eq!(stopping["terminalId"], "T-named");
    stop.wait_for(LIMIT).await.expect("Gone");
}

/// A start pins its screen only as the exact process its row spawned (pid
/// AND the start time the row recorded at the spawn): when that pid names a
/// different incarnation the screen is not pinned (so no stop ever signals
/// that process) and `unit.screen_unpinned` says why (Task 12 review N1).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_start_pins_its_screen_by_pid_and_start_time() {
    let logs = crate::invariants::capture::capture();
    let root = tempfile::tempdir().unwrap();
    let (state, _crashes) = unit_state(root.path());

    // The real reader: pinned, as the incarnation the row recorded.
    let mut scope =
        StartScope::begin(&state, "codex", "codex", "crq-pin", "T-pin", None).expect("start");
    let pid = spawn_screen(&state, &scope, "T-pin", "sleep 30").await;
    let recorded = state
        .registry
        .screen_start_time("T-pin")
        .expect("the row recorded its screen's start time at the spawn");
    assert_eq!(scope.spawned("T-pin", pid), Spawned::Running);
    let pinned = scope.unit().screen().expect("the screen is pinned");
    assert_eq!((pinned.pid(), pinned.identity().start), (pid, recorded));
    scope.abandon(None);

    // The row recorded another incarnation (the pid was reused): no pin.
    state.registry.set_process_start_reader(Arc::new(|pid| {
        freshell_containment::process::start_time(pid)
            .ok()
            .map(|start| start + 1)
    }));
    let mut scope = StartScope::begin(&state, "codex", "codex", "crq-other", "T-other-pin", None)
        .expect("start");
    let unit = scope.unit();
    let pid = spawn_screen(&state, &scope, "T-other-pin", "sleep 30").await;
    assert_eq!(scope.spawned("T-other-pin", pid), Spawned::Running);
    assert!(
        unit.screen().is_none(),
        "a pid naming another incarnation is never pinned"
    );
    assert_eq!(unit_lines(&logs, &unit, "unit.screen_unpinned"), 1);
    scope.abandon(None);
}

/// A row spawned into a unit whose stop already reached Gone: `spawned`
/// answers at once (never waiting for the screen), and the start's
/// abandonment kills the screen through its pin and ends the row as a
/// requested stop. The same holds for a start given up through the
/// directory (the REST lane's route) (Task 12 review N2, M4).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_row_spawned_after_its_units_gone_is_ended_by_the_abandonment() {
    let root = tempfile::tempdir().unwrap();
    let (state, _crashes) = unit_state(root.path());
    for (tid, through_directory) in [("T-late", false), ("T-late-rest", true)] {
        let mut scope =
            StartScope::begin(&state, "codex", "codex", &format!("crq-{tid}"), tid, None)
                .expect("start");
        let unit = scope.unit();
        // The placement is taken before the stop (the create's race).
        let placement = unit.placement(MemberRole::Screen).expect("placement");
        stop_terminal_unit(
            &state,
            &state.units.get(unit.id()).expect("the starting entry"),
            UnitStopCommand {
                mode: StopMode::Force,
                reason: StopReason::ShiftX,
                initiator: "test-kill".into(),
                operation_id: format!("term-kill-{tid}"),
                record_stopped_pane: true,
            },
        )
        .wait_for(LIMIT)
        .await
        .expect("Gone before the row exists");
        let pid = {
            let registry = state.registry.clone();
            let tid = tid.to_string();
            let unit_id = unit.id().to_string();
            tokio::task::spawn_blocking(move || {
                registry.create_in_unit(
                    &bash("sleep 30"),
                    &env(),
                    tid,
                    uuid::Uuid::new_v4().to_string(),
                    "codex",
                    None,
                    None,
                    None,
                    None,
                    UnitPlacement {
                        unit_id,
                        wrapper: placement.wrapper,
                        env: placement.env,
                        main_is_screen: false,
                    },
                )
            })
            .await
            .unwrap()
            .expect("the screen spawned")
        };

        let began = std::time::Instant::now();
        assert_eq!(scope.spawned(tid, pid), Spawned::AlreadyStopped);
        assert!(
            began.elapsed() < Duration::from_secs(1),
            "spawned never waits for the screen ({:?})",
            began.elapsed()
        );
        let screen = unit.screen().expect("the screen is pinned");
        if through_directory {
            // The REST lane gives its start up through the directory.
            std::mem::forget(scope);
            state
                .units
                .abandon_start(freshell_containment::AbandonedStart {
                    entry: UnitEntry {
                        terminal_id: Some(tid.to_string()),
                        ..state.units.get(unit.id()).expect("the entry")
                    },
                    base: None,
                    initiator: "rest-start-cancelled".into(),
                    claim: None,
                })
                .unwrap_or_else(|_| panic!("the lifecycle is installed"));
        } else {
            scope.abandon(None);
        }
        tokio::time::timeout(LIMIT, screen.exited())
            .await
            .expect("the abandonment kills the screen")
            .unwrap();
        eventually("the row is ended and removed", || {
            state.registry.probe(tid).is_none()
        })
        .await;
        eventually("the entry is removed", || {
            state.units.get(unit.id()).is_none()
        })
        .await;
    }
}

/// A claim held elsewhere (the auto-resume hub's) and relayed to a start
/// given up is dropped only once the unit is Gone, never before (Task 12
/// review M1, the respawn path).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_relayed_claim_is_dropped_only_at_gone() {
    let root = tempfile::tempdir().unwrap();
    let (state, _crashes) = unit_state(root.path());
    let mut scope =
        StartScope::begin(&state, "codex", "codex", "crq-relay", "T-relay", None).expect("start");
    let unit = scope.unit();
    // A screen that ignores SIGINT: Gone only after the 1 s escalation.
    let pid = spawn_screen(&state, &scope, "T-relay", "trap '' INT TERM; sleep 30").await;
    assert_eq!(scope.spawned("T-relay", pid), Spawned::Running);
    let (relay_tx, relay_rx) = tokio::sync::oneshot::channel();
    scope.release_claim_after_gone(relay_rx);
    scope.abandon(None);

    // The holder hands its claim over right after the start was given up.
    let gone_at_drop: Arc<Mutex<Option<bool>>> = Arc::default();
    struct Claim(AgentUnit, Arc<Mutex<Option<bool>>>);
    impl Drop for Claim {
        fn drop(&mut self) {
            let gone = self
                .0
                .stop_in_flight()
                .is_some_and(|stop| stop.try_report().is_some());
            *self.1.lock().unwrap() = Some(gone);
        }
    }
    let claim: Box<dyn std::any::Any + Send> = Box::new(Claim(unit.clone(), gone_at_drop.clone()));
    if let Err(claim) = relay_tx.send(claim) {
        drop(claim);
    }
    assert_eq!(
        *gone_at_drop.lock().unwrap(),
        None,
        "the claim is held while the unit stops"
    );
    eventually("the relayed claim is dropped", || {
        gone_at_drop.lock().unwrap().is_some()
    })
    .await;
    assert_eq!(
        *gone_at_drop.lock().unwrap(),
        Some(true),
        "the claim was dropped only after the unit's Gone"
    );
    eventually("the entry is removed after the claim", || {
        state.units.get(unit.id()).is_none()
    })
    .await;
}

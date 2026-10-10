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
    assert_eq!(scope.spawned(tid, pid).await, Spawned::Running);
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

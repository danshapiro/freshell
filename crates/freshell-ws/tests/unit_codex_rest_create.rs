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
        .exit_and_vacant(&mut ws, 2 * LIMIT, &tid, "t-rest", || {
            assert!(
                !fake_codex::pid_alive(native),
                "terminal.exit and Vacant are published only after the app-server is gone"
            );
        })
        .await;
    assert_eq!(exit["exitCode"], 0);
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

/// What [`RegistrationHook`] runs, with the registering terminal's id.
type OnRegistration = Box<dyn FnOnce(&str) + Send>;

/// A REST identity binder that runs its hook (once) with the terminal id
/// when the create registers the pane's identity: after the create's bind,
/// before its late claim and its commit.
#[derive(Default)]
struct RegistrationHook {
    hook: std::sync::Mutex<Option<OnRegistration>>,
}

impl std::fmt::Debug for RegistrationHook {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RegistrationHook")
    }
}

impl freshell_terminal::registry::PaneIdentityBinder for RegistrationHook {
    fn record_prespawn_claude_binding(
        &self,
        _session_id: &str,
        _terminal_id: &str,
        _mode: &str,
        _cwd: Option<&str>,
        _create_request_id: Option<&str>,
    ) {
    }

    fn delete_prespawn_claude_binding(&self, _session_id: &str) {}

    fn register_create_identity(
        &self,
        terminal_id: &str,
        _mode: &str,
        _resume_session_id: Option<&str>,
        _cwd: Option<&str>,
        _create_request_id: Option<&str>,
        _observed: Option<(u64, u64)>,
    ) -> Result<(), std::io::Error> {
        if let Some(hook) = self.hook.lock().unwrap().take() {
            hook(terminal_id);
        }
        Ok(())
    }

    fn retire_pane_identity(&self, _terminal_id: &str) {}
}

/// The terminal a hook stopped and the handle of that stop.
type StoppedAtRegistration =
    Arc<std::sync::Mutex<Option<(String, freshell_containment::StopHandle)>>>;

/// Arms `registration` so that, after a REST create's bind, `before` runs
/// and then the start's unit is stopped as a failed placement (an ending
/// that keeps the pane's row as a failed start); with `until_gone` the
/// create continues only once that stop reached Gone. Yields the terminal
/// and the stop's handle once the hook ran.
fn stop_at_registration(
    h: &UnitHarness,
    registration: &RegistrationHook,
    until_gone: bool,
    before: impl FnOnce() + Send + 'static,
) -> StoppedAtRegistration {
    let stop = Arc::new(std::sync::Mutex::new(None));
    *registration.hook.lock().unwrap() = Some(Box::new({
        let units = h.state.units.directory.clone();
        let stop = stop.clone();
        move |terminal_id: &str| {
            before();
            let entry = units
                .by_terminal(terminal_id)
                .expect("the bound start's entry names its terminal");
            let handle = units
                .stop_unit(
                    entry.unit.id(),
                    freshell_containment::StopMode::Force,
                    freshell_containment::StopReason::PlacementFailed { exit_code: None },
                    "test-placement-failed",
                )
                .expect("the start's unit stops through the lifecycle");
            if until_gone {
                // The identity registration runs on a blocking thread.
                tokio::runtime::Handle::current()
                    .block_on(handle.wait_for(LIMIT))
                    .expect("the unit reaches Gone");
            }
            *stop.lock().unwrap() = Some((terminal_id.to_string(), handle));
        }
    }));
    stop
}

/// What a REST start stopped after its bind must leave once its unit is
/// Gone: the conversation released, no directory entry, the pane not
/// running and its app-server dead.
async fn assert_released_at_gone(
    h: &UnitHarness,
    session_id: &str,
    tid: &str,
    stop: freshell_containment::StopHandle,
) {
    stop.wait_for(LIMIT).await.expect("the unit reaches Gone");
    eventually("the conversation is released after Gone", || {
        is_vacant(h, session_id)
    })
    .await;
    eventually("the entry is removed", || h.state.units.all().is_empty()).await;
    assert!(
        !h.state.registry.is_pty_running(tid),
        "the pane is not running"
    );
    for native in h.native_manifests() {
        assert!(!fake_codex::pid_alive(native.pid), "the app-server is dead");
    }
}

/// A stop that begins after a REST start's bind (here its placement
/// failing) moves the start's claim to Stopping at once, because the claim
/// is stamped with the unit after the bind (so every device is told the
/// conversation is stopping), and gives the start up before it commits:
/// the create is answered as cancelled, and the conversation is released
/// at the unit's Gone (Task 12 re-review 2, Minor 1).
#[tokio::test(flavor = "multi_thread")]
async fn a_stop_after_the_bind_moves_a_rest_starts_claim_to_stopping_and_gives_it_up() {
    let registration = Arc::new(RegistrationHook::default());
    let h = UnitHarness::start(HarnessOpts {
        rest_identity_binder: Some(registration.clone()),
        ..Default::default()
    })
    .await;
    // Gone is held 1.5 s after the kill, so the stop is still in flight
    // when the create answers.
    let _gone_delay = GoneDelay::set(1500);
    let stop = stop_at_registration(&h, &registration, false, || {});

    let (status, body) = h.rest_create_codex(Some("t-bound")).await;
    let (tid, stop) = stop
        .lock()
        .unwrap()
        .take()
        .expect("the start's unit was stopped after its bind");
    assert_ne!(
        status, 200,
        "a start stopped after its bind never commits: {body}"
    );
    let during_stop = h
        .state
        .ownership
        .as_ref()
        .unwrap()
        .observe("codex", "t-bound")
        .state;
    assert!(
        matches!(
            during_stop,
            freshell_ownership::OwnershipState::Stopping { .. }
        ),
        "the claim is Stopping while the unit stops: {during_stop:?}"
    );
    assert_released_at_gone(&h, "t-bound", &tid, stop).await;
}

/// The same when the create claims its conversation only after the spawn
/// (its first claim answered Adopt over a terminal owner that went away
/// mid-spawn): the stop began after the bind, before that late claim. The
/// create is answered as cancelled and never commits the conversation Live
/// for the stopping pane; once the unit is Gone the conversation is
/// released (Task 12 re-review 2, Minor 1).
#[tokio::test(flavor = "multi_thread")]
async fn a_stop_after_the_bind_gives_a_late_claimed_rest_start_up_before_it_commits() {
    late_claimed_rest_start_stopped_after_its_bind(false).await;
}

/// The same when that stop already reached Gone before the late claim: the
/// claim is not tagged with the gone unit, so it is released rather than
/// left Stopping under a stop that already finished.
#[tokio::test(flavor = "multi_thread")]
async fn a_late_claimed_rest_start_whose_unit_is_already_gone_releases_its_claim() {
    late_claimed_rest_start_stopped_after_its_bind(true).await;
}

async fn late_claimed_rest_start_stopped_after_its_bind(until_gone: bool) {
    let registration = Arc::new(RegistrationHook::default());
    let h = UnitHarness::start(HarnessOpts {
        rest_identity_binder: Some(registration.clone()),
        ..Default::default()
    })
    .await;
    // Unless the hook waits for Gone, Gone is held 1.5 s after the kill, so
    // the stop is still in flight when the create commits or gives up.
    let _gone_delay = (!until_gone).then(|| GoneDelay::set(1500));
    let ownership = h.state.ownership.clone().expect("an owner registry");

    // A terminal owner with no row holds the conversation: the create's
    // claim answers Adopt, so it spawns under its attach guard with no
    // claim of its own and claims after the spawn.
    let phantom_op = "op-phantom";
    let freshell_ownership::BeginOutcome::Granted { generation } = ownership.begin_start(
        "codex",
        "t-late",
        freshell_ownership::RuntimeOwnerKind::Terminal,
        phantom_op,
        None,
        "test",
        1_000,
    ) else {
        panic!("the phantom's start is granted")
    };
    let mut phantom = freshell_ownership::OwnerIdentity {
        kind: freshell_ownership::RuntimeOwnerKind::Terminal,
        terminal_id: Some("t-phantom".into()),
        live_session_key: None,
        pid: None,
        ownership_id: None,
        unit_id: None,
        hold: freshell_ownership::HoldKind::Main,
    };
    assert_eq!(
        ownership.commit_live("codex", "t-late", phantom_op, generation, phantom.clone()),
        freshell_ownership::CommitOutcome::Committed
    );
    phantom.ownership_id = Some(phantom_op.to_string());
    // After the bind the phantom goes away (so the late claim is granted),
    // then the start's unit is stopped.
    let stop = stop_at_registration(&h, &registration, until_gone, {
        let ownership = ownership.clone();
        move || {
            ownership.release(
                "codex",
                "t-late",
                &freshell_ownership::ReleaseClaim {
                    operation_id: phantom_op.to_string(),
                    generation,
                    runtime: Some(phantom),
                },
                "test",
            );
        }
    });

    let (status, body) = h.rest_create_codex(Some("t-late")).await;
    let (tid, stop) = stop
        .lock()
        .unwrap()
        .take()
        .expect("the start's unit was stopped after its bind");
    assert_ne!(
        status, 200,
        "a start stopped after its bind never commits: {body}"
    );
    let answered = ownership.observe("codex", "t-late").state;
    assert!(
        !matches!(answered, freshell_ownership::OwnershipState::Live { .. }),
        "the conversation is never committed Live for the stopped pane: {answered:?}"
    );
    assert_released_at_gone(&h, "t-late", &tid, stop).await;
}

/// A switch away from a Codex terminal pane in its unit (here to a new
/// terminal pane of the same conversation, through the real handoff runner)
/// succeeds on its first attempt: the prior is stopped under the handoff's
/// own operation, so the handoff keeps its key and commits it to the target
/// (Task 12 review I2: a fresh kill operation made that commit stale), and
/// the handoff answers only after the prior's Gone.
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
    // The handoff waits for the prior's Gone, which removes its entry.
    assert!(
        h.state.units.by_terminal(&prior).is_none(),
        "the prior's unit was Gone before the handoff answered"
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

/// A handoff away from a Codex terminal pane in its unit waits for that
/// unit's Gone, not only for its screen's death: the prior's row stays
/// until Gone, and a target spawned before it would be refused because the
/// conversation still has a running terminal. Here Gone is held 1.5 s
/// after the prior's processes died; the handoff still succeeds on its
/// first attempt, and the prior is fully gone when it answers.
#[tokio::test(flavor = "multi_thread")]
async fn a_handoff_away_from_a_pane_in_its_unit_waits_for_its_gone() {
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let mut ws = h.connect().await;
    let prior = h
        .create_codex(&mut ws, "crq-handoff-gone", Some("t-handoff-gone"))
        .await;
    tui_ready(&h, &mut ws).await;
    let prior_unit = h.unit_for(&prior);
    tokio::time::timeout(LIMIT, h.state.units.start_settled(prior_unit.id()))
        .await
        .expect("the prior's start settled");
    let prior_native = h.native_pid(&prior);
    let _gone_delay = GoneDelay::set(1500);

    let (status, body) = h
        .post(
            "/api/sessions/handoff",
            json!({
                "provider": "codex",
                "sessionId": "t-handoff-gone",
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
        prior_unit
            .stop_in_flight()
            .and_then(|stop| stop.try_report())
            .is_some(),
        "the prior's unit was Gone before the handoff answered"
    );
    assert!(
        !h.state.registry.is_pty_running(&prior),
        "the prior's row is gone"
    );
    assert!(
        !fake_codex::pid_alive(prior_native),
        "the prior's app-server is gone"
    );
    match h
        .state
        .ownership
        .as_ref()
        .unwrap()
        .observe("codex", "t-handoff-gone")
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

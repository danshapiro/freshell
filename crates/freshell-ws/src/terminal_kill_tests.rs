//! Lib tests of `terminal.kill` for panes outside a coding-agent unit
//! (managed, supervisor-owned panes: a kill never answers before their stop
//! is verified, Stage 2: LB-13), of the not-found rule (an unknown terminal
//! counts as killed only when the owner registry confirms nothing holds a
//! conversation under it), of a kill that names no pane, and of the create
//! side's holds that a kill releases (the given-up create's lease release,
//! the late claim's unit stamp).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use freshell_terminal::registry::{
    ManagedOutputRead, ManagedTerminalController, ManagedTerminalDescriptor, ManagedTerminalFuture,
    ManagedTerminalLaunch,
};

use super::*;

const LIMIT: Duration = Duration::from_secs(10);

fn descriptor(terminal_id: &str, create_request_id: &str) -> ManagedTerminalDescriptor {
    ManagedTerminalDescriptor {
        soul_id: format!("soul-{terminal_id}"),
        incarnation_id: "incarnation-1".into(),
        terminal_id: terminal_id.into(),
        stream_id: format!("stream-{terminal_id}"),
        mode: "shell".into(),
        cwd: "/workspace".into(),
        resume_session_id: None,
        create_request_id: Some(create_request_id.into()),
    }
}

/// A supervisor whose `launch` waits on a gate and answers the launched
/// soul, whose inventory answers `running`, and whose `stop` records what it
/// was asked to stop.
#[derive(Default)]
struct Supervisor {
    gate: tokio::sync::Notify,
    gated: std::sync::atomic::AtomicBool,
    running: Mutex<Option<ManagedTerminalDescriptor>>,
    stopped: Mutex<Vec<ManagedTerminalDescriptor>>,
}

impl ManagedTerminalController for Supervisor {
    fn lookup_terminal<'a>(
        &'a self,
        terminal_id: &'a str,
        _create_request_id: Option<String>,
    ) -> ManagedTerminalFuture<'a, Result<Option<ManagedTerminalDescriptor>, String>> {
        let found = self
            .running
            .lock()
            .unwrap()
            .clone()
            .filter(|running| running.terminal_id == terminal_id);
        Box::pin(async move { Ok(found) })
    }

    fn launch<'a>(
        &'a self,
        request: ManagedTerminalLaunch,
    ) -> ManagedTerminalFuture<'a, Result<ManagedTerminalDescriptor, String>> {
        Box::pin(async move {
            if self.gated.load(std::sync::atomic::Ordering::SeqCst) {
                self.gate.notified().await;
            }
            Ok(descriptor(
                &request.terminal_id,
                request.create_request_id.as_deref().unwrap_or_default(),
            ))
        })
    }

    fn input<'a>(
        &'a self,
        _terminal: ManagedTerminalDescriptor,
        _data: String,
    ) -> ManagedTerminalFuture<'a, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }

    fn resize<'a>(
        &'a self,
        _terminal: ManagedTerminalDescriptor,
        _cols: u16,
        _rows: u16,
    ) -> ManagedTerminalFuture<'a, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }

    fn stop<'a>(
        &'a self,
        terminal: ManagedTerminalDescriptor,
    ) -> ManagedTerminalFuture<'a, Result<(), String>> {
        self.stopped.lock().unwrap().push(terminal);
        Box::pin(async { Ok(()) })
    }

    fn read_output<'a>(
        &'a self,
        _terminal: ManagedTerminalDescriptor,
        _after_seq: i64,
        _max_bytes: u64,
    ) -> ManagedTerminalFuture<'a, Result<ManagedOutputRead, String>> {
        Box::pin(async { Err("not needed".into()) })
    }
}

/// Every frame a connection was sent, in order.
type Frames = Arc<Mutex<Vec<ServerMessage>>>;

fn connection() -> (FrameSink, Frames) {
    let frames: Frames = Arc::default();
    let sink: FrameSink = Arc::new({
        let frames = frames.clone();
        move |msg| frames.lock().unwrap().push(msg)
    });
    (sink, frames)
}

async fn eventually(what: &str, f: impl Fn() -> bool) {
    let deadline = tokio::time::Instant::now() + LIMIT;
    while !f() {
        assert!(tokio::time::Instant::now() < deadline, "timed out: {what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn position(frames: &Frames, pred: impl Fn(&ServerMessage) -> bool) -> Option<usize> {
    frames.lock().unwrap().iter().position(pred)
}

fn kill_answer(frames: &Frames, request_id: &str) -> Option<(usize, bool)> {
    let frames = frames.lock().unwrap();
    frames.iter().enumerate().find_map(|(i, msg)| match msg {
        ServerMessage::TerminalKilled(killed) if killed.request_id == request_id => {
            Some((i, killed.success))
        }
        _ => None,
    })
}

/// The `terminal.killed` answering `request_id`, if any.
fn killed(frames: &Frames, request_id: &str) -> Option<freshell_protocol::TerminalKilled> {
    frames.lock().unwrap().iter().find_map(|msg| match msg {
        ServerMessage::TerminalKilled(killed) if killed.request_id == request_id => {
            Some(killed.clone())
        }
        _ => None,
    })
}

/// A test state whose terminal registry shares an enabled owner registry
/// (as at boot).
fn owned_state() -> (WsState, Arc<freshell_ownership::RuntimeOwnershipRegistry>) {
    let mut state = super::pane_reconcile_gate_tests::state();
    let ownership = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    state.registry =
        freshell_terminal::TerminalRegistry::new().with_ownership(Arc::clone(&ownership));
    state.ownership = Some(Arc::clone(&ownership));
    (state, ownership)
}

fn kill_of(
    terminal_id: Option<&str>,
    create_request_id: Option<&str>,
    request_id: Option<&str>,
) -> TerminalKill {
    TerminalKill {
        terminal_id: terminal_id.map(str::to_string),
        request_id: request_id.map(str::to_string),
        create_request_id: create_request_id.map(str::to_string),
        observed_epoch: None,
        observed_generation: None,
        reason: None,
    }
}

/// The not-found rule through `terminal.kill` (User Request defect 6): a
/// kill naming a terminal nothing runs for, while a conversation is still
/// Stopping under that terminal, is not answered until the owner registry
/// confirms it Gone, and only then answered success.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_kill_of_an_unknown_terminal_waits_while_its_conversation_is_stopping() {
    let (state, ownership) = owned_state();
    let owner = freshell_ownership::OwnerIdentity {
        terminal_id: Some("T-x".into()),
        unit_id: Some("u-x".into()),
        ..Default::default()
    };
    assert!(ownership.restore_stopping("codex", "t-x", owner, "op-x", "test", 1));
    let (sink, frames) = connection();
    let (_open, closed) = tokio::sync::watch::channel(false);
    handle_kill(
        kill_of(Some("T-x"), None, Some("rk-x")),
        &sink,
        &closed,
        &state,
        "test-kill",
    )
    .await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        kill_answer(&frames, "rk-x"),
        None,
        "no answer while a conversation is still Stopping under the terminal"
    );

    ownership.commit_unit_stop("u-x", "op-x");
    eventually("the kill is answered at Gone", || {
        kill_answer(&frames, "rk-x").is_some()
    })
    .await;
    let answer = killed(&frames, "rk-x").unwrap();
    assert!(answer.success, "{answer:?}");
    assert_eq!(answer.error, None);
}

/// The not-found rule through `terminal.kill`: a kill naming a terminal
/// nothing runs for, while a conversation is still held Live under it, is
/// not confirmed: `success:false, error:"OWNER_WITHOUT_RUNTIME"`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_kill_of_an_unknown_terminal_still_owning_a_live_conversation_fails() {
    let (state, ownership) = owned_state();
    let freshell_ownership::BeginOutcome::Granted { generation } = ownership.begin_start(
        "codex",
        "t-y",
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
        "t-y",
        "op-start",
        generation,
        freshell_ownership::OwnerIdentity {
            terminal_id: Some("T-y".into()),
            ..Default::default()
        },
    );
    let (sink, frames) = connection();
    let (_open, closed) = tokio::sync::watch::channel(false);
    handle_kill(
        kill_of(Some("T-y"), None, Some("rk-y")),
        &sink,
        &closed,
        &state,
        "test-kill",
    )
    .await;
    eventually("the kill is answered", || {
        kill_answer(&frames, "rk-y").is_some()
    })
    .await;
    let answer = killed(&frames, "rk-y").unwrap();
    assert!(!answer.success, "{answer:?}");
    assert_eq!(answer.error.as_deref(), Some("OWNER_WITHOUT_RUNTIME"));
}

/// A `terminal.kill` naming neither a terminal nor a create-request id
/// names no pane: it is answered as an invalid message, never success
/// (`success:true` means Gone was confirmed). A requestId-less one gets the
/// legacy `INVALID_MESSAGE` error frame.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_kill_naming_no_pane_is_refused_as_invalid() {
    let (state, _ownership) = owned_state();
    let (sink, frames) = connection();
    let (_open, closed) = tokio::sync::watch::channel(false);
    handle_kill(
        kill_of(None, None, Some("rk-none")),
        &sink,
        &closed,
        &state,
        "test-kill",
    )
    .await;
    handle_kill(
        kill_of(None, None, None),
        &sink,
        &closed,
        &state,
        "test-kill",
    )
    .await;
    eventually("both kills are answered", || {
        frames.lock().unwrap().len() >= 2
    })
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let answer = killed(&frames, "rk-none").expect("the correlated kill is answered");
    assert!(!answer.success, "{answer:?}");
    assert_eq!(
        answer.error.as_deref(),
        Some("terminal.kill needs terminalId or createRequestId")
    );
    let frames = frames.lock().unwrap().clone();
    assert_eq!(frames.len(), 2, "one answer each: {frames:?}");
    assert!(
        frames.iter().any(|msg| matches!(msg,
            ServerMessage::Error(e) if e.code == ErrorCode::InvalidMessage
                && e.request_id.is_none()
                && e.terminal_id.is_none()
                && e.message == "terminal.kill needs terminalId or createRequestId")),
        "the requestId-less kill gets the legacy INVALID_MESSAGE frame: {frames:?}"
    );
}

/// A managed pane killed while its launch is in flight (the kill names it
/// by createRequestId alone): the kill is not answered until the launch
/// returns; the launched soul is then stopped through the supervisor and
/// never registered, the create is refused as stopped, and only then does
/// `terminal.killed{success:true}` arrive (before, the kill answered
/// success at once and the soul kept running).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_kill_of_a_starting_managed_pane_stops_the_soul_when_its_launch_returns() {
    let state = super::pane_reconcile_gate_tests::state();
    let supervisor = Arc::new(Supervisor::default());
    supervisor
        .gated
        .store(true, std::sync::atomic::Ordering::SeqCst);
    state
        .registry
        .set_managed_controller(Some(supervisor.clone()));
    let conn_id = 41;
    state.registry.set_managed_runtime_connection(conn_id, true);
    let (sink, frames) = connection();

    let create: TerminalCreate = serde_json::from_value(serde_json::json!({
        "requestId": "crq-m",
        "mode": "shell",
        "shell": "system",
    }))
    .expect("terminal create");
    let creating = tokio::spawn({
        let state = state.clone();
        let sink = sink.clone();
        async move {
            let mut out = crate::create_gate::CreateOutput::Channel(&sink);
            let mut limiter = crate::create_limit::CreateRateLimiter::new(100, 1000);
            handle_create(
                create,
                None,
                &mut out,
                &state,
                conn_id,
                false,
                &mut limiter,
                &ConnectionIdentity::default(),
                now_ms(),
            )
            .await
        }
    });
    eventually("the managed launch is in flight", || {
        state.units.managed_starts().settled("crq-m").is_some()
    })
    .await;

    let (_open, closed) = tokio::sync::watch::channel(false);
    let kill = TerminalKill {
        terminal_id: None,
        request_id: Some("rk-m".into()),
        create_request_id: Some("crq-m".into()),
        observed_epoch: None,
        observed_generation: None,
        reason: None,
    };
    handle_kill(kill, &sink, &closed, &state, "test-kill").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        kill_answer(&frames, "rk-m"),
        None,
        "no answer before the launch returns"
    );

    supervisor.gate.notify_one();
    tokio::time::timeout(LIMIT, creating)
        .await
        .expect("the create finishes")
        .unwrap();
    eventually("the kill is answered", || {
        kill_answer(&frames, "rk-m").is_some()
    })
    .await;
    let stopped = supervisor.stopped.lock().unwrap().clone();
    assert_eq!(stopped.len(), 1, "the launched soul was stopped");
    let launched = &stopped[0];
    assert!(
        !state.registry.is_managed(&launched.terminal_id),
        "no facade was registered for the killed pane"
    );
    let refusal = position(&frames, |msg| {
        matches!(msg, ServerMessage::Error(e)
            if e.request_id.as_deref() == Some("crq-m")
                && e.code == ErrorCode::InvalidTerminalId)
    })
    .expect("the create is refused as stopped");
    assert!(
        position(&frames, |msg| matches!(
            msg,
            ServerMessage::TerminalCreated(_)
        ))
        .is_none(),
        "the killed pane was never created"
    );
    let (answered, success) = kill_answer(&frames, "rk-m").unwrap();
    assert!(success, "the kill succeeded");
    assert!(
        answered > refusal,
        "the kill is answered only after the create"
    );
}

/// A soul the supervisor still runs whose facade was not re-adopted (a
/// web-server restart): a kill naming its terminal stops it through the
/// supervisor's inventory before answering success (before, the
/// unknown-terminal arm answered success and stopped nothing).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_kill_of_an_unadopted_managed_terminal_stops_it_through_inventory() {
    let state = super::pane_reconcile_gate_tests::state();
    let supervisor = Arc::new(Supervisor::default());
    *supervisor.running.lock().unwrap() = Some(descriptor("T-m", "crq-old"));
    state
        .registry
        .set_managed_controller(Some(supervisor.clone()));
    let (sink, frames) = connection();
    let (_open, closed) = tokio::sync::watch::channel(false);
    let kill = TerminalKill {
        terminal_id: Some("T-m".into()),
        request_id: Some("rk-inv".into()),
        create_request_id: None,
        observed_epoch: None,
        observed_generation: None,
        reason: None,
    };
    handle_kill(kill, &sink, &closed, &state, "test-kill").await;
    eventually("the kill is answered", || {
        kill_answer(&frames, "rk-inv").is_some()
    })
    .await;
    assert_eq!(
        *supervisor.stopped.lock().unwrap(),
        vec![descriptor("T-m", "crq-old")],
        "the supervisor stopped the soul"
    );
    assert_eq!(kill_answer(&frames, "rk-inv").map(|(_, ok)| ok), Some(true));
    assert!(!state.registry.is_managed("T-m"));
}

/// Task 12 re-review 3, m2 (the WebSocket create's twin of the REST lane's):
/// a given-up create's lease release frees the conversation's sessionRef
/// lease only while that create still holds it.
#[test]
fn a_given_up_creates_lease_release_leaves_a_lease_another_create_took() {
    let registry = freshell_terminal::TerminalRegistry::new();
    let locator = SessionLocator {
        provider: "codex".into(),
        session_id: "t-m2".into(),
    };
    let release = |holder: &str| ReleaseLeaseAfterGone {
        registry: registry.clone(),
        locator: locator.clone(),
        holder_create_request_id: holder.to_string(),
    };
    assert!(matches!(
        registry.claim_session_ref(&locator, "crq-reopen", 2, 1_000),
        freshell_terminal::registry::SessionRefClaim::Acquired
    ));
    drop(release("crq-given-up"));
    assert!(
        matches!(
            registry.claim_session_ref(&locator, "crq-third", 3, 1_500),
            freshell_terminal::registry::SessionRefClaim::Held { .. }
        ),
        "the reopen keeps its lease"
    );
    drop(release("crq-reopen"));
    assert!(matches!(
        registry.claim_session_ref(&locator, "crq-third", 3, 2_000),
        freshell_terminal::registry::SessionRefClaim::Acquired
    ));
}

/// The WebSocket create's LATE claim (a create that spawned with no
/// coordinator claim) is stamped with the unit its row was spawned into, as
/// the pre-spawn claim is: a stop of that unit moves the key to Stopping and
/// its Gone releases it, so a commit racing the stop fails stale instead of
/// committing Live for a dying pane (Task 12 residual, re-review 3 n2).
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_late_claim_of_a_unit_row_is_stamped_with_its_unit() {
    let root = tempfile::tempdir().unwrap();
    let mut state = super::pane_reconcile_gate_tests::state();
    let ownership = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    state.registry =
        freshell_terminal::TerminalRegistry::new().with_ownership(Arc::clone(&ownership));
    state.ownership = Some(Arc::clone(&ownership));
    state.units = crate::unit_lifecycle::UnitServices {
        directory: freshell_containment::UnitDirectory::new(),
        containment: freshell_containment::Containment::tag_backend(
            freshell_containment::SelectOptions {
                shim: None,
                state_root: root.path().to_path_buf(),
            },
        ),
    };
    crate::unit_lifecycle::wire(&state, &tokio::runtime::Handle::current());

    let mut scope = crate::unit_lifecycle::StartScope::begin(
        &state, "codex", "codex", "crq-late", "T-late", None,
    )
    .expect("start");
    let unit = scope.unit();
    let placement = unit
        .placement(freshell_containment::MemberRole::Screen)
        .expect("placement");
    let pid = {
        let registry = state.registry.clone();
        let unit_id = unit.id().to_string();
        tokio::task::spawn_blocking(move || {
            registry.create_in_unit(
                &freshell_platform::SpawnSpec {
                    program: "sleep".into(),
                    args: vec!["30".into()],
                    env_overrides: Default::default(),
                    cwd: None,
                    cols: 80,
                    rows: 24,
                },
                &std::env::vars()
                    .filter(|(k, _)| k == "PATH" || k == "HOME")
                    .collect(),
                "T-late".into(),
                "S-late".into(),
                "codex",
                None,
                Some("crq-late"),
                None,
                None,
                freshell_terminal::UnitPlacement {
                    unit_id,
                    wrapper: placement.wrapper,
                    env: placement.env,
                    main_is_screen: false,
                },
            )
        })
        .await
        .unwrap()
        .expect("screen spawned")
    };
    assert_eq!(
        scope.spawned("T-late", pid),
        crate::unit_lifecycle::Spawned::Running
    );
    scope.bind();

    let locator = SessionLocator {
        provider: "codex".into(),
        session_id: "s-late".into(),
    };
    let claim = claim_late_for_spawned_row(
        &state,
        &locator,
        "crq-late",
        7,
        None,
        "T-late",
        Some(&scope),
    )
    .expect("the late claim is granted")
    .expect("the coordinator is wired");
    assert!(
        ownership
            .keys_for_unit(unit.id().as_str())
            .iter()
            .any(|(key, _)| key.session_id == "s-late"),
        "the late claim's key is stamped with the row's unit"
    );

    let stop = crate::unit_lifecycle::stop_terminal_unit(
        &state,
        &state.units.get(unit.id()).expect("the starting entry"),
        crate::unit_lifecycle::UnitStopCommand {
            mode: freshell_containment::StopMode::Force,
            reason: freshell_containment::StopReason::ShiftX,
            initiator: "test-kill".into(),
            operation_id: "term-kill-late".into(),
            record_stopped_pane: true,
        },
    );
    assert!(matches!(
        ownership.observe("codex", "s-late").state,
        freshell_ownership::OwnershipState::Stopping { .. }
    ));
    assert!(
        claim.commit("T-late").is_err(),
        "a commit racing the stop fails stale"
    );
    stop.wait_for(LIMIT).await.expect("Gone");
    scope.abandon(None);
    assert_eq!(
        ownership.observe("codex", "s-late").state,
        freshell_ownership::OwnershipState::Vacant,
        "the unit's Gone released the late claim's key"
    );
}

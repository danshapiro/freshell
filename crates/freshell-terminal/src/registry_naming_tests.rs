//! Name reliability (Task 10): a managed facade row presents its MODE label —
//! never the hard-coded "Shell" — until the naming bind overwrites it with
//! the saved name, and a binding that moves away from its cached record can
//! drop that cache. Headless: no PTY, no async runtime.
use super::*;
use std::task::{Context, Poll, Waker};

fn immediate<F: Future>(future: F) -> F::Output {
    let mut future = Box::pin(future);
    match future
        .as_mut()
        .poll(&mut Context::from_waker(Waker::noop()))
    {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("headless test future unexpectedly waited"),
    }
}

fn opencode_soul(terminal_id: &str) -> ManagedTerminalDescriptor {
    ManagedTerminalDescriptor {
        soul_id: format!("soul-{terminal_id}"),
        incarnation_id: format!("incarnation-{terminal_id}"),
        terminal_id: terminal_id.to_string(),
        stream_id: format!("S-{terminal_id}"),
        mode: "opencode".into(),
        cwd: "/workspace".into(),
        resume_session_id: Some("ses_soul".into()),
        create_request_id: Some(format!("req-{terminal_id}")),
    }
}

fn lifecycle(state: ManagedLifecycleState, reason: &str) -> ManagedLifecycle {
    ManagedLifecycle {
        state,
        recovery_summary: Some(freshell_protocol::ManagedRecoverySummary {
            desired_state: "running".into(),
            recovery_state: match state {
                ManagedLifecycleState::Blocked => "blocked",
                ManagedLifecycleState::Ended => "stopped",
                ManagedLifecycleState::Running => "live",
                ManagedLifecycleState::Recovering => "recovering",
            }
            .into(),
            reason: Some(reason.into()),
            attempt_id: None,
            incident_id: None,
            durability_state: "unknown".into(),
            allocation_state: "allocated".into(),
        }),
    }
}

struct InputController {
    terminal: ManagedTerminalDescriptor,
    lifecycle: ManagedLifecycle,
    input_calls: Arc<std::sync::atomic::AtomicUsize>,
}

impl ManagedTerminalController for InputController {
    fn lifecycle_observation<'a>(
        &'a self,
        _: &'a ManagedTerminalDescriptor,
    ) -> ManagedTerminalFuture<'a, Option<ManagedLifecycle>> {
        Box::pin(std::future::ready(Some(self.lifecycle.clone())))
    }

    fn lookup_terminal<'a>(
        &'a self,
        _: &'a str,
        _: Option<String>,
    ) -> ManagedTerminalFuture<'a, Result<Option<ManagedTerminalDescriptor>, String>> {
        Box::pin(std::future::ready(Ok(Some(self.terminal.clone()))))
    }

    fn launch<'a>(
        &'a self,
        _: ManagedTerminalLaunch,
    ) -> ManagedTerminalFuture<'a, Result<ManagedTerminalDescriptor, ManagedTerminalLaunchError>>
    {
        panic!("input test must not launch a terminal")
    }

    fn input<'a>(
        &'a self,
        _: ManagedTerminalDescriptor,
        _: String,
    ) -> ManagedTerminalFuture<'a, Result<(), ManagedTerminalInputError>> {
        self.input_calls
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Box::pin(std::future::ready(Ok(())))
    }

    fn resize<'a>(
        &'a self,
        _: ManagedTerminalDescriptor,
        _: u16,
        _: u16,
    ) -> ManagedTerminalFuture<'a, Result<(), String>> {
        panic!("input test must not resize a terminal")
    }

    fn stop<'a>(
        &'a self,
        _: ManagedTerminalDescriptor,
    ) -> ManagedTerminalFuture<'a, Result<(), String>> {
        panic!("input test must not stop a terminal")
    }

    fn read_output<'a>(
        &'a self,
        _: ManagedTerminalDescriptor,
        _: i64,
        _: u64,
    ) -> ManagedTerminalFuture<'a, Result<ManagedOutputRead, String>> {
        panic!("input test must not read terminal output")
    }
}

fn managed_input_reaches_controller(
    descriptor: ManagedTerminalDescriptor,
    lifecycle: ManagedLifecycle,
) -> bool {
    let registry = TerminalRegistry::new();
    registry.register_managed(descriptor.clone(), descriptor.mode.clone());
    let input_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    registry.set_managed_controller(Some(Arc::new(InputController {
        terminal: descriptor.clone(),
        lifecycle: lifecycle.clone(),
        input_calls: Arc::clone(&input_calls),
    })));
    assert!(registry.publish_managed_lifecycle(&descriptor.terminal_id, Some(lifecycle),));

    let result =
        immediate(registry.managed_input(&descriptor.terminal_id, "safe test input".into()));
    if result.is_ok() {
        assert_eq!(input_calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        true
    } else {
        assert_eq!(result, Err(ManagedTerminalInputError::RecoveryBlocked));
        assert_eq!(input_calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        false
    }
}

#[test]
fn blocked_fresh_opencode_startup_input_reaches_managed_controller() {
    let mut descriptor = opencode_soul("T-open-first-input");
    descriptor.resume_session_id = None;
    assert!(managed_input_reaches_controller(
        descriptor,
        lifecycle(ManagedLifecycleState::Blocked, "CAPABILITY_PENDING"),
    ));
}

#[test]
fn ended_managed_terminal_input_stays_blocked_before_controller() {
    let descriptor = opencode_soul("T-ended-input");
    assert!(!managed_input_reaches_controller(
        descriptor,
        lifecycle(ManagedLifecycleState::Ended, "session_exited"),
    ));
}

#[test]
fn completed_managed_terminal_stays_blocked_when_cached_lifecycle_is_blocked() {
    let descriptor = opencode_soul("T-completed-blocked-input");
    let registry = TerminalRegistry::new();
    registry.register_managed(descriptor.clone(), descriptor.mode.clone());
    let input_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let blocked = lifecycle(ManagedLifecycleState::Blocked, "CAPABILITY_PENDING");
    registry.set_managed_controller(Some(Arc::new(InputController {
        terminal: descriptor.clone(),
        lifecycle: blocked.clone(),
        input_calls: Arc::clone(&input_calls),
    })));

    assert!(registry.finish_managed_completion(&descriptor.terminal_id, Some(17)));
    assert!(registry.publish_managed_lifecycle(&descriptor.terminal_id, Some(blocked),));

    assert_eq!(
        immediate(registry.managed_input(&descriptor.terminal_id, "safe test input".into())),
        Err(ManagedTerminalInputError::RecoveryBlocked)
    );
    assert_eq!(input_calls.load(std::sync::atomic::Ordering::SeqCst), 0);
}

/// The supervisor's inventory after a web restart: lookup answers the soul.
#[derive(Clone)]
struct FirstLookupGate {
    lookup_count: Arc<std::sync::atomic::AtomicUsize>,
    started: Arc<std::sync::atomic::AtomicBool>,
    release: Arc<std::sync::atomic::AtomicBool>,
}

struct InventoryController {
    soul: ManagedTerminalDescriptor,
    first_lookup_gate: Option<FirstLookupGate>,
}

impl ManagedTerminalController for InventoryController {
    fn lookup_terminal<'a>(
        &'a self,
        terminal_id: &'a str,
        _: Option<String>,
    ) -> ManagedTerminalFuture<'a, Result<Option<ManagedTerminalDescriptor>, String>> {
        let gate = self.first_lookup_gate.clone();
        let lookup_index = gate.as_ref().map(|gate| {
            gate.lookup_count
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        });
        let found = (terminal_id == self.soul.terminal_id).then(|| self.soul.clone());
        Box::pin(async move {
            if let (Some(gate), Some(0)) = (gate, lookup_index) {
                gate.started
                    .store(true, std::sync::atomic::Ordering::SeqCst);
                while !gate.release.load(std::sync::atomic::Ordering::SeqCst) {
                    std::thread::yield_now();
                }
            }
            Ok(found)
        })
    }
    fn launch<'a>(
        &'a self,
        _: ManagedTerminalLaunch,
    ) -> ManagedTerminalFuture<'a, Result<ManagedTerminalDescriptor, ManagedTerminalLaunchError>>
    {
        panic!("adoption must never launch a provider")
    }
    fn input<'a>(
        &'a self,
        _: ManagedTerminalDescriptor,
        _: String,
    ) -> ManagedTerminalFuture<'a, Result<(), ManagedTerminalInputError>> {
        panic!("adoption must never replay input")
    }
    fn resize<'a>(
        &'a self,
        _: ManagedTerminalDescriptor,
        _: u16,
        _: u16,
    ) -> ManagedTerminalFuture<'a, Result<(), String>> {
        panic!("adoption must never resize")
    }
    fn stop<'a>(
        &'a self,
        _: ManagedTerminalDescriptor,
    ) -> ManagedTerminalFuture<'a, Result<(), String>> {
        panic!("adoption must never stop a provider")
    }
    fn read_output<'a>(
        &'a self,
        _: ManagedTerminalDescriptor,
        _: i64,
        _: u64,
    ) -> ManagedTerminalFuture<'a, Result<ManagedOutputRead, String>> {
        panic!("adoption must never read output")
    }
}

#[test]
fn register_managed_titles_an_agent_row_with_the_passed_mode_label() {
    let registry = TerminalRegistry::new();
    registry.register_managed(opencode_soul("T-label"), "OpenCode".to_string());
    assert_eq!(
        registry.title_of("T-label").as_deref(),
        Some("OpenCode"),
        "an agent facade presents its mode label, never Shell"
    );
}

#[test]
fn register_managed_through_reconcile_adoption_titles_from_the_mode_label() {
    let registry = TerminalRegistry::new();
    registry.set_managed_controller(Some(Arc::new(InventoryController {
        soul: opencode_soul("T-adopted"),
        first_lookup_gate: None,
    })));
    let mut labelled_modes = Vec::new();
    let adopted = immediate(registry.adopt_managed_for_reconcile(
        "T-adopted",
        Some("req-T-adopted".into()),
        |mode| {
            labelled_modes.push(mode.to_string());
            "OpenCode".to_string()
        },
    ))
    .expect("lookup succeeds");
    assert!(adopted, "the soul is reconstructed");
    assert_eq!(labelled_modes, vec!["opencode".to_string()]);
    assert_eq!(registry.title_of("T-adopted").as_deref(), Some("OpenCode"));
}

fn run_until_ready<F: Future>(future: F) -> F::Output {
    let mut future = Box::pin(future);
    let mut context = Context::from_waker(Waker::noop());
    loop {
        match future.as_mut().poll(&mut context) {
            Poll::Ready(output) => return output,
            Poll::Pending => std::thread::yield_now(),
        }
    }
}

#[test]
fn concurrent_reconcile_adoption_keeps_the_existing_live_facade() {
    let registry = TerminalRegistry::new();
    let first_lookup_started = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let release_first_lookup = Arc::new(std::sync::atomic::AtomicBool::new(false));
    registry.set_managed_controller(Some(Arc::new(InventoryController {
        soul: opencode_soul("T-concurrent-adopt"),
        first_lookup_gate: Some(FirstLookupGate {
            lookup_count: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            started: Arc::clone(&first_lookup_started),
            release: Arc::clone(&release_first_lookup),
        }),
    })));

    let first_registry = registry.clone();
    let delayed_adoption = std::thread::spawn(move || {
        run_until_ready(first_registry.adopt_managed_for_reconcile(
            "T-concurrent-adopt",
            Some("req-T-concurrent-adopt".into()),
            |_| "OpenCode".into(),
        ))
    });

    let started_at = std::time::Instant::now();
    while !first_lookup_started.load(std::sync::atomic::Ordering::SeqCst)
        && started_at.elapsed() < std::time::Duration::from_secs(2)
    {
        std::thread::yield_now();
    }
    let first_started = first_lookup_started.load(std::sync::atomic::Ordering::SeqCst);
    if !first_started {
        release_first_lookup.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    assert!(first_started, "first inventory lookup should be in flight");

    assert!(immediate(registry.adopt_managed_for_reconcile(
        "T-concurrent-adopt",
        Some("req-T-concurrent-adopt".into()),
        |_| "OpenCode".into(),
    ))
    .expect("second inventory lookup succeeds"));

    assert!(
        registry
            .attach(
                "T-concurrent-adopt",
                7,
                Arc::new(|_| {}),
                None,
                0,
                false,
                false,
                None,
                None,
                None,
                PacedAttachOptions::default(),
            )
            .found
    );
    assert!(registry.ingest_managed_output(
        "T-concurrent-adopt",
        1,
        1,
        "viewer output survives\n".into(),
    ));

    release_first_lookup.store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(delayed_adoption
        .join()
        .expect("first adoption thread completes")
        .expect("first inventory lookup succeeds"));

    let row = registry
        .directory()
        .into_iter()
        .find(|entry| entry.terminal_id == "T-concurrent-adopt")
        .expect("managed facade remains registered");
    assert!(row.has_clients, "the first viewer remains subscribed");
    assert_eq!(row.snapshot, "viewer output survives\n");
}

#[test]
fn register_managed_row_drops_a_moved_binding_cache_back_to_the_fallback_title() {
    let registry = TerminalRegistry::new();
    registry.register_managed(opencode_soul("T-moved"), "OpenCode".to_string());
    let record = freshell_protocol::session_names::SessionNameRecord {
        name_ref: freshell_protocol::session_names::SessionNameRef::Session {
            provider: freshell_protocol::session_names::NamedProvider::Opencode,
            session_id: "ses_old".into(),
        },
        name: "Old conversation".into(),
        source: freshell_protocol::session_names::NameSource::Manual,
        revision: 2,
        manual_revision: Some(2),
        renamed_at: None,
        legacy_origin: None,
    };
    registry.update_session_name("T-moved", &record);
    assert_eq!(
        registry.title_of("T-moved").as_deref(),
        Some("Old conversation")
    );

    registry.clear_session_name("T-moved", "OpenCode");

    assert!(
        registry.session_name_of("T-moved").is_none(),
        "the moved row no longer advertises the old session's record"
    );
    assert_eq!(registry.title_of("T-moved").as_deref(), Some("OpenCode"));
}

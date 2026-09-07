mod common;

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use freshell_protocol::{
    AgentRestart, AgentRestartFailureCode, AgentRuntimeKind, ClientMessage, FreshAgentCreateFailed,
    FreshAgentCreated, FreshAgentEvent, FreshAgentSessionMaterialized, InventoryTerminal,
    PaneReconcileResult, PaneVerdict, ReconcileVerdict, RuntimeDescriptor, ServerMessage,
    SessionLocator, TerminalAttachReady, TerminalCreated, TerminalExit, TerminalInventory,
    TerminalOutput, TerminalRunStatus, TerminalSessionAssociated,
};
use freshell_ws::restart::{
    run_restart_recovery_driver, JournalParentSync, ProductionFreshPreflight,
    ProductionFreshResumePlan, ProductionFreshRuntime, RestartCoordinator, RestartFailure,
    RestartIngressLimits, RestartOutcome, RestartReplacementFence, RestartResumeContext,
    RestartRetirementAction, RestartRetirementFence, RestartRuntime, RuntimeLocator,
    SpawnRegistrationRaceGate,
};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::{Context, SubscriberExt};
use tracing_subscriber::Layer;

#[derive(Debug, Clone, Default)]
struct CapturedTraceEvent {
    message: String,
    fields: BTreeMap<String, String>,
}

#[derive(Default)]
struct TraceFieldVisitor {
    message: String,
    fields: BTreeMap<String, String>,
}

impl Visit for TraceFieldVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        let rendered = format!("{value:?}");
        if field.name() == "message" {
            self.message = rendered;
        } else {
            self.fields.insert(field.name().to_string(), rendered);
        }
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message = value.to_string();
        } else {
            self.fields
                .insert(field.name().to_string(), value.to_string());
        }
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.fields
            .insert(field.name().to_string(), value.to_string());
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.fields
            .insert(field.name().to_string(), value.to_string());
    }
}

struct TraceCaptureLayer {
    events: Arc<Mutex<Vec<CapturedTraceEvent>>>,
}

impl<S: Subscriber> Layer<S> for TraceCaptureLayer {
    fn on_event(&self, event: &Event<'_>, _context: Context<'_, S>) {
        let mut visitor = TraceFieldVisitor::default();
        event.record(&mut visitor);
        self.events
            .lock()
            .expect("trace capture lock")
            .push(CapturedTraceEvent {
                message: visitor.message,
                fields: visitor.fields,
            });
    }
}

fn capture_traces() -> (
    Arc<Mutex<Vec<CapturedTraceEvent>>>,
    tracing::subscriber::DefaultGuard,
) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let subscriber = tracing_subscriber::registry().with(TraceCaptureLayer {
        events: Arc::clone(&events),
    });
    let guard = tracing::subscriber::set_default(subscriber);
    (events, guard)
}

struct FakeRuntime {
    events: Mutex<Vec<&'static str>>,
    running: AtomicBool,
    shutdowns: AtomicUsize,
    resumable: bool,
    replacement_id: &'static str,
}

impl FakeRuntime {
    fn resumable(replacement_id: &'static str) -> Self {
        Self {
            events: Mutex::new(Vec::new()),
            running: AtomicBool::new(true),
            shutdowns: AtomicUsize::new(0),
            resumable: true,
            replacement_id,
        }
    }

    fn unresumable() -> Self {
        Self {
            events: Mutex::new(Vec::new()),
            running: AtomicBool::new(true),
            shutdowns: AtomicUsize::new(0),
            resumable: false,
            replacement_id: "unused",
        }
    }
}

#[async_trait::async_trait]
impl RestartRuntime for FakeRuntime {
    type ResumePlan = ();

    async fn preflight(&self, _request: &AgentRestart) -> Result<Self::ResumePlan, RestartFailure> {
        self.events.lock().unwrap().push("preflight");
        if self.resumable {
            Ok(())
        } else {
            Err(RestartFailure::new(
                AgentRestartFailureCode::Unresumable,
                "durable session is unavailable",
                false,
            ))
        }
    }

    async fn shutdown_for_restart(
        &self,
        _request: &AgentRestart,
        _plan: &Self::ResumePlan,
    ) -> Result<(), RestartFailure> {
        assert_eq!(
            self.events.lock().unwrap().as_slice(),
            ["preflight"],
            "shutdown must happen only after successful preflight"
        );
        self.events.lock().unwrap().push("shutdown");
        self.shutdowns.fetch_add(1, Ordering::SeqCst);
        self.running.store(false, Ordering::SeqCst);
        Ok(())
    }

    async fn create_replacement(
        &self,
        _request: &AgentRestart,
        _plan: Self::ResumePlan,
    ) -> Result<String, RestartFailure> {
        assert!(!self.running.load(Ordering::SeqCst));
        self.events.lock().unwrap().push("replace");
        Ok(self.replacement_id.to_string())
    }
}

struct OrderedRuntime {
    phase: Arc<AtomicUsize>,
}

#[async_trait::async_trait]
impl RestartRuntime for OrderedRuntime {
    type ResumePlan = ();

    async fn preflight(&self, _request: &AgentRestart) -> Result<(), RestartFailure> {
        assert_eq!(self.phase.swap(1, Ordering::SeqCst), 0);
        Ok(())
    }

    async fn shutdown_for_restart(
        &self,
        _request: &AgentRestart,
        _plan: &(),
    ) -> Result<(), RestartFailure> {
        assert_eq!(
            self.phase.swap(3, Ordering::SeqCst),
            2,
            "started must be emitted after preflight and before shutdown"
        );
        Ok(())
    }

    async fn create_replacement(
        &self,
        _request: &AgentRestart,
        _plan: (),
    ) -> Result<String, RestartFailure> {
        assert_eq!(self.phase.swap(4, Ordering::SeqCst), 3);
        Ok("term-2".to_string())
    }
}

fn locator() -> RuntimeLocator {
    RuntimeLocator::new(AgentRuntimeKind::Terminal, "claude", "durable-1")
}

fn restart(request_id: &str, live_id: &str, generation: u64) -> AgentRestart {
    AgentRestart {
        request_id: request_id.to_string(),
        provider: "claude".to_string(),
        session_id: "durable-1".to_string(),
        kind: AgentRuntimeKind::Terminal,
        live_id: live_id.to_string(),
        expected_generation: generation,
    }
}

struct PresentSessions;

impl freshell_ws::existence::SessionExistenceProbe for PresentSessions {
    fn exists(
        &self,
        _provider: &str,
        _session_id: &str,
    ) -> freshell_ws::existence::SessionExistence {
        freshell_ws::existence::SessionExistence::Present
    }

    fn ever_observed(&self, _provider: &str, _session_id: &str) -> bool {
        true
    }
}

#[tokio::test]
async fn restart_preflights_before_stopping_the_selected_runtime() {
    let coordinator = RestartCoordinator::new();
    coordinator.register_initial(locator(), "term-1");
    let runtime = FakeRuntime::resumable("term-2");

    let outcome = coordinator
        .execute(restart("r1", "term-1", 1), &runtime)
        .await;

    assert!(!outcome.replayed);
    assert!(matches!(
        outcome.messages.as_slice(),
        [
            ServerMessage::AgentRestartStarted(_),
            ServerMessage::AgentRestartReplaced(_)
        ]
    ));
    assert_eq!(
        runtime.events.lock().unwrap().as_slice(),
        ["preflight", "shutdown", "replace"]
    );
}

#[tokio::test]
async fn started_is_emitted_after_preflight_and_before_shutdown() {
    let coordinator = RestartCoordinator::new();
    coordinator.register_initial(locator(), "term-1");
    let phase = Arc::new(AtomicUsize::new(0));
    let runtime = OrderedRuntime {
        phase: Arc::clone(&phase),
    };
    coordinator
        .execute_with_events(
            restart("r1", "term-1", 1),
            &runtime,
            |message| match message {
                ServerMessage::AgentRestartStarted(_) => {
                    assert_eq!(phase.swap(2, Ordering::SeqCst), 1);
                }
                ServerMessage::AgentRestartReplaced(_) => {
                    assert_eq!(phase.swap(5, Ordering::SeqCst), 4);
                }
                other => panic!("unexpected event: {other:?}"),
            },
        )
        .await;
    assert_eq!(phase.load(Ordering::SeqCst), 5);
}

#[tokio::test]
async fn unresumable_restart_fails_without_stopping_the_live_runtime() {
    let coordinator = RestartCoordinator::new();
    coordinator.register_initial(locator(), "term-1");
    let runtime = FakeRuntime::unresumable();

    let outcome = coordinator
        .execute(restart("r1", "term-1", 1), &runtime)
        .await;

    assert!(matches!(
        outcome.messages.as_slice(),
        [ServerMessage::AgentRestartFailed(message)]
            if message.code == AgentRestartFailureCode::Unresumable
    ));
    assert!(runtime.running.load(Ordering::SeqCst));
    assert_eq!(runtime.shutdowns.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn runtime_generation_is_stable_across_attach_and_reconnect_and_changes_on_replacement() {
    let coordinator = RestartCoordinator::new();
    let created = coordinator.register_initial(locator(), "term-1");
    let attached = coordinator
        .runtime_for_live(AgentRuntimeKind::Terminal, "term-1")
        .unwrap();
    let reconnected = coordinator.register_initial(locator(), "term-1");

    assert_eq!(created, attached);
    assert_eq!(created, reconnected);

    let outcome = coordinator
        .execute(
            restart("r1", "term-1", created.generation),
            &FakeRuntime::resumable("term-2"),
        )
        .await;
    let ServerMessage::AgentRestartReplaced(replaced) = &outcome.messages[1] else {
        panic!("expected replacement");
    };
    assert_eq!(replaced.old_runtime.as_runtime_descriptor(), created);
    assert_eq!(replaced.runtime.runtime_id, "term-2");
    assert_eq!(replaced.runtime.generation, created.generation + 1);
    assert_eq!(
        coordinator
            .runtime_for_live(AgentRuntimeKind::Terminal, "term-2")
            .unwrap(),
        replaced.runtime
    );
}

#[tokio::test]
async fn terminal_admission_serializes_a_fresh_agent_restart_for_the_same_session() {
    let coordinator = RestartCoordinator::new();
    let fresh_locator =
        RuntimeLocator::new(AgentRuntimeKind::FreshAgent, "claude", "durable-shared");
    coordinator.register_initial(fresh_locator, "fresh-1");
    let admission = coordinator
        .acquire_session_admission("claude", "durable-shared")
        .await
        .expect("terminal create admission");
    let runtime = Arc::new(FakeRuntime::resumable("fresh-2"));
    let task_coordinator = coordinator.clone();
    let task_runtime = Arc::clone(&runtime);
    let task = tokio::spawn(async move {
        task_coordinator
            .execute(
                AgentRestart {
                    request_id: "cross-kind-restart".to_string(),
                    provider: "claude".to_string(),
                    session_id: "durable-shared".to_string(),
                    kind: AgentRuntimeKind::FreshAgent,
                    live_id: "fresh-1".to_string(),
                    expected_generation: 1,
                },
                task_runtime.as_ref(),
            )
            .await
    });

    tokio::task::yield_now().await;
    assert!(
        !task.is_finished(),
        "fresh-agent restart must wait for terminal admission on the same durable session"
    );
    drop(admission);

    assert!(matches!(
        task.await.unwrap().messages.last(),
        Some(ServerMessage::AgentRestartReplaced(replaced))
            if replaced.runtime.runtime_id == "fresh-2"
    ));
}

#[tokio::test]
async fn a_pending_terminal_recovery_reserves_the_session_across_runtime_kinds() {
    let coordinator = RestartCoordinator::new();
    coordinator.register_initial(locator(), "term-1");
    coordinator
        .execute(
            restart("pending-cross-kind", "term-1", 1),
            &ReplacementFails,
        )
        .await;

    let fresh_locator = RuntimeLocator::new(AgentRuntimeKind::FreshAgent, "claude", "durable-1");
    assert!(
        coordinator.retirement_pending_for(&fresh_locator),
        "the compatibility probe must ignore runtime kind"
    );
    assert!(
        coordinator
            .acquire_session_admission("claude", "durable-1")
            .await
            .is_err(),
        "atomic admission must reject the same durable session"
    );
    coordinator
        .acquire_session_admission("claude", "durable-unrelated")
        .await
        .expect("an unrelated durable session remains admissible");
}

#[tokio::test]
async fn resend_after_requester_disconnect_replays_the_stored_terminal_result() {
    let coordinator = RestartCoordinator::new();
    coordinator.register_initial(locator(), "term-1");
    let runtime = FakeRuntime::resumable("term-2");
    let request = restart("r1", "term-1", 1);

    let first = coordinator.execute(request.clone(), &runtime).await;
    assert!(matches!(
        first.messages.last(),
        Some(ServerMessage::AgentRestartReplaced(_))
    ));

    let replay = coordinator.execute(request, &runtime).await;
    assert!(replay.replayed);
    assert!(matches!(
        replay.messages.as_slice(),
        [ServerMessage::AgentRestartReplaced(_)]
    ));
    assert_eq!(
        runtime.shutdowns.load(Ordering::SeqCst),
        1,
        "replay must not run teardown twice"
    );
}

#[tokio::test]
async fn concurrent_distinct_requests_for_one_old_runtime_share_the_replacement() {
    let temp = tempfile::tempdir().unwrap();
    let persistence_path = temp.path().join("restart-state.json");
    let coordinator = RestartCoordinator::new_persistent(persistence_path.clone()).unwrap();
    coordinator.register_initial(locator(), "term-1");
    let runtime = Arc::new(FakeRuntime::resumable("term-2"));
    let first_request = restart("r1", "term-1", 1);
    let second_request = restart("r2", "term-1", 1);

    let (first, second) = tokio::join!(
        coordinator.execute(first_request, runtime.as_ref()),
        coordinator.execute(second_request.clone(), runtime.as_ref()),
    );

    let first_replaced = first
        .messages
        .iter()
        .find_map(|message| match message {
            ServerMessage::AgentRestartReplaced(replaced) => Some(replaced),
            _ => None,
        })
        .expect("transaction owner receives replacement");
    let second_replaced = second
        .messages
        .iter()
        .find_map(|message| match message {
            ServerMessage::AgentRestartReplaced(replaced) => Some(replaced),
            _ => None,
        })
        .expect("transaction follower receives correlated replacement");
    assert_eq!(first_replaced.request_id, "r1");
    assert_eq!(second_replaced.request_id, "r2");
    assert_eq!(first_replaced.old_runtime, second_replaced.old_runtime);
    assert_eq!(first_replaced.runtime, second_replaced.runtime);
    assert_eq!(
        runtime.shutdowns.load(Ordering::SeqCst),
        1,
        "distinct request ids for the same old generation must share one teardown"
    );

    drop(coordinator);
    let reopened = RestartCoordinator::new_persistent(persistence_path).unwrap();
    let replay = reopened.execute(second_request, runtime.as_ref()).await;
    assert!(replay.replayed);
    assert!(matches!(
        replay.messages.as_slice(),
        [ServerMessage::AgentRestartReplaced(replaced)]
            if replaced.request_id == "r2"
                && replaced.runtime.runtime_id == "term-2"
                && replaced.runtime.generation == 2
    ));
    assert_eq!(runtime.shutdowns.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn request_id_reuse_with_a_different_fingerprint_is_rejected() {
    let coordinator = RestartCoordinator::new();
    coordinator.register_initial(locator(), "term-1");
    let runtime = FakeRuntime::resumable("term-2");
    coordinator
        .execute(restart("r1", "term-1", 1), &runtime)
        .await;

    let conflict = coordinator
        .execute(restart("r1", "term-other", 1), &runtime)
        .await;
    assert!(conflict.replayed);
    assert!(matches!(
        conflict.messages.as_slice(),
        [ServerMessage::AgentRestartFailed(message)]
            if message.code == AgentRestartFailureCode::RequestIdConflict
    ));
    assert_eq!(runtime.shutdowns.load(Ordering::SeqCst), 1);
}

#[test]
fn late_terminal_association_binds_the_existing_live_runtime_to_the_durable_locator() {
    let coordinator = RestartCoordinator::new();
    let descriptor = coordinator.register_live(AgentRuntimeKind::Terminal, "term-late");
    let mut associated = ServerMessage::TerminalSessionAssociated(TerminalSessionAssociated {
        terminal_id: "term-late".to_string(),
        session_ref: SessionLocator {
            provider: "opencode".to_string(),
            session_id: "durable-late".to_string(),
        },
        previous_session_id: None,
        runtime: None,
    });

    coordinator.observe_server_message(&mut associated);

    assert_eq!(
        coordinator.runtime_for_locator(&RuntimeLocator::new(
            AgentRuntimeKind::Terminal,
            "opencode",
            "durable-late",
        )),
        Some(descriptor.clone())
    );
    let ServerMessage::TerminalSessionAssociated(associated) = associated else {
        unreachable!()
    };
    assert_eq!(associated.runtime, Some(descriptor));
}

#[test]
fn terminal_lifecycle_surfaces_share_one_server_owned_descriptor() {
    let coordinator = RestartCoordinator::new();
    let session_ref = SessionLocator {
        provider: "claude".to_string(),
        session_id: "durable-1".to_string(),
    };
    let mut created = ServerMessage::TerminalCreated(TerminalCreated {
        created_at: 1,
        request_id: "create-1".to_string(),
        terminal_id: "term-1".to_string(),
        clear_codex_durability: None,
        cwd: None,
        restore_error: None,
        session_ref: Some(session_ref.clone()),
        runtime: None,
        notice: None,
    });
    coordinator.observe_server_message(&mut created);
    let ServerMessage::TerminalCreated(created) = created else {
        unreachable!()
    };
    let expected = created.runtime.unwrap();

    let mut attach = ServerMessage::TerminalAttachReady(TerminalAttachReady {
        head_seq: 0,
        replay_from_seq: 1,
        replay_to_seq: 0,
        stream_id: "stream-1".to_string(),
        terminal_id: "term-1".to_string(),
        attach_request_id: Some("attach-1".to_string()),
        effective_since_seq: Some(0),
        geometry_authority: None,
        geometry_epoch: None,
        replay_reset_reason: None,
        requested_since_seq: Some(0),
        session_ref: Some(session_ref.clone()),
        runtime: None,
    });
    coordinator.observe_server_message(&mut attach);
    let ServerMessage::TerminalAttachReady(attach) = attach else {
        unreachable!()
    };
    assert_eq!(attach.runtime, Some(expected.clone()));

    let mut inventory = ServerMessage::TerminalInventory(TerminalInventory {
        boot_id: "boot-1".to_string(),
        terminals: vec![InventoryTerminal {
            created_at: 1,
            last_activity_at: 2,
            mode: "claude".to_string(),
            status: TerminalRunStatus::Running,
            terminal_id: "term-1".to_string(),
            title: "Claude".to_string(),
            codex_durability: None,
            cwd: None,
            description: None,
            runtime_status: None,
            session_ref: Some(session_ref),
            runtime: None,
        }],
        terminal_meta: vec![],
    });
    coordinator.observe_server_message(&mut inventory);
    let ServerMessage::TerminalInventory(inventory) = inventory else {
        unreachable!()
    };
    assert_eq!(inventory.terminals[0].runtime, Some(expected.clone()));

    let mut output = ServerMessage::TerminalOutput(TerminalOutput {
        data: "hi".to_string(),
        seq_end: 1,
        seq_start: 1,
        stream_id: "stream-1".to_string(),
        terminal_id: "term-1".to_string(),
        attach_request_id: None,
        source: None,
        runtime: None,
    });
    coordinator.observe_server_message(&mut output);
    let ServerMessage::TerminalOutput(output) = output else {
        unreachable!()
    };
    assert_eq!(output.runtime, Some(expected.clone()));

    let mut exit = ServerMessage::TerminalExit(TerminalExit {
        exit_code: 0,
        terminal_id: "term-1".to_string(),
        runtime: None,
    });
    coordinator.observe_server_message(&mut exit);
    let ServerMessage::TerminalExit(exit) = exit else {
        unreachable!()
    };
    assert_eq!(exit.runtime, Some(expected));
}

#[test]
fn ordinary_terminal_lifecycle_still_receives_a_runtime_fence() {
    let coordinator = RestartCoordinator::new();
    let mut created = ServerMessage::TerminalCreated(TerminalCreated {
        created_at: 1,
        request_id: "create-shell".to_string(),
        terminal_id: "shell-1".to_string(),
        clear_codex_durability: None,
        cwd: None,
        restore_error: None,
        session_ref: None,
        runtime: None,
        notice: None,
    });

    coordinator.observe_server_message(&mut created);

    let ServerMessage::TerminalCreated(created) = created else {
        unreachable!()
    };
    assert_eq!(
        created.runtime,
        Some(RuntimeDescriptor {
            runtime_id: "shell-1".to_string(),
            generation: 1,
        })
    );
}

#[tokio::test]
async fn retired_runtime_frames_keep_the_old_generation_fence() {
    let coordinator = RestartCoordinator::new();
    let old = coordinator.register_initial(locator(), "term-1");
    coordinator
        .execute(
            restart("r1", "term-1", old.generation),
            &FakeRuntime::resumable("term-2"),
        )
        .await;

    assert_eq!(
        coordinator
            .runtime_for_live(AgentRuntimeKind::Terminal, "term-1")
            .unwrap(),
        old
    );
    assert_eq!(
        coordinator
            .runtime_for_live(AgentRuntimeKind::Terminal, "term-2")
            .unwrap(),
        RuntimeDescriptor {
            runtime_id: "term-2".to_string(),
            generation: old.generation + 1,
        }
    );
}

#[tokio::test]
async fn late_association_from_retired_terminal_cannot_reclaim_the_locator() {
    let coordinator = RestartCoordinator::new();
    let old = coordinator.register_initial(locator(), "term-1");
    coordinator
        .execute(
            restart("r1", "term-1", old.generation),
            &FakeRuntime::resumable("term-2"),
        )
        .await;

    let mut late = ServerMessage::TerminalSessionAssociated(TerminalSessionAssociated {
        terminal_id: "term-1".to_string(),
        session_ref: SessionLocator {
            provider: "claude".to_string(),
            session_id: "durable-1".to_string(),
        },
        previous_session_id: None,
        runtime: None,
    });
    coordinator.observe_server_message(&mut late);

    assert_eq!(
        coordinator.runtime_for_locator(&locator()),
        Some(RuntimeDescriptor {
            runtime_id: "term-2".to_string(),
            generation: old.generation + 1,
        }),
        "a delayed association from the retired predecessor must not become current"
    );
    let ServerMessage::TerminalSessionAssociated(late) = late else {
        unreachable!()
    };
    assert_eq!(
        late.runtime,
        Some(old),
        "the delayed frame still carries the predecessor fence"
    );
}

#[tokio::test]
async fn replacement_must_report_a_distinct_live_runtime() {
    let coordinator = RestartCoordinator::new();
    coordinator.register_initial(locator(), "term-1");

    let outcome = coordinator
        .execute(
            restart("same-runtime", "term-1", 1),
            &FakeRuntime::resumable("term-1"),
        )
        .await;

    assert!(matches!(
        outcome.messages.last(),
        Some(ServerMessage::AgentRestartFailed(message))
            if message.code == AgentRestartFailureCode::ReplacementFailed
                && message.retryable
    ));
    assert_eq!(coordinator.runtime_for_locator(&locator()), None);
}

#[test]
fn fresh_agent_create_and_stream_frames_share_one_descriptor() {
    let coordinator = RestartCoordinator::new();
    let mut created = ServerMessage::FreshAgentCreated(FreshAgentCreated {
        provider: "claude".to_string(),
        request_id: "create-1".to_string(),
        runtime_provider: "claude".to_string(),
        session_id: "live-1".to_string(),
        session_type: "freshclaude".to_string(),
        session_ref: Some(SessionLocator {
            provider: "claude".to_string(),
            session_id: "durable-1".to_string(),
        }),
        runtime: None,
    });
    coordinator.observe_server_message(&mut created);
    let ServerMessage::FreshAgentCreated(created) = created else {
        unreachable!()
    };
    let expected = created.runtime.unwrap();

    let mut event = ServerMessage::FreshAgentEvent(FreshAgentEvent {
        event: serde_json::json!({"type": "freshAgent.stream"}),
        provider: "claude".to_string(),
        session_id: "live-1".to_string(),
        session_type: "freshclaude".to_string(),
        runtime: None,
    });
    coordinator.observe_server_message(&mut event);
    let ServerMessage::FreshAgentEvent(event) = event else {
        unreachable!()
    };
    assert_eq!(event.runtime, Some(expected));
}

#[test]
fn negotiated_restart_descriptor_matrix_is_enriched_and_verifiable() {
    let coordinator = RestartCoordinator::new();
    let session_ref = SessionLocator {
        provider: "claude".to_string(),
        session_id: "durable-matrix".to_string(),
    };
    let mut messages = vec![
        ServerMessage::FreshAgentCreated(FreshAgentCreated {
            provider: "claude".to_string(),
            request_id: "matrix-create".to_string(),
            runtime_provider: "claude".to_string(),
            session_id: "durable-matrix".to_string(),
            session_type: "freshclaude".to_string(),
            session_ref: Some(session_ref.clone()),
            runtime: None,
        }),
        ServerMessage::FreshAgentEvent(FreshAgentEvent {
            event: serde_json::json!({"type": "freshAgent.snapshot"}),
            provider: "claude".to_string(),
            session_id: "durable-matrix".to_string(),
            session_type: "freshclaude".to_string(),
            runtime: None,
        }),
        ServerMessage::FreshAgentSessionMaterialized(FreshAgentSessionMaterialized {
            previous_session_id: "placeholder".to_string(),
            provider: "claude".to_string(),
            session_id: "durable-matrix".to_string(),
            session_type: "freshclaude".to_string(),
            session_ref: Some(session_ref.clone()),
            runtime: None,
        }),
        ServerMessage::PaneReconcileResult(PaneReconcileResult {
            reconcile_id: "matrix-reconcile".to_string(),
            boot_id: "boot-test".to_string(),
            server_instance_id: "srv-test".to_string(),
            verdicts: vec![PaneVerdict {
                pane_key: "fresh-pane".to_string(),
                verdict: ReconcileVerdict::Attach,
                terminal_id: None,
                session_ref: Some(session_ref),
                corrected: None,
                reason: None,
                duplicate: None,
                runtime: None,
            }],
        }),
    ];

    for message in &mut messages {
        coordinator.observe_server_message(message);
        assert!(
            RestartCoordinator::restart_runtime_contract_satisfied(message),
            "agentRestartV1 must make the promised runtime descriptor non-optional: {message:?}"
        );
    }
}

#[test]
fn negotiated_runtime_surface_without_an_authoritative_descriptor_is_not_forwarded() {
    let coordinator = RestartCoordinator::new();
    let missing = serde_json::to_string(&ServerMessage::FreshAgentEvent(FreshAgentEvent {
        event: serde_json::json!({"type": "freshAgent.stream", "delta": "orphan"}),
        provider: "claude".to_string(),
        session_id: "unknown-runtime".to_string(),
        session_type: "freshclaude".to_string(),
        runtime: None,
    }))
    .unwrap();

    assert!(
        coordinator.observe_serialized(&missing).is_none(),
        "the upgraded server must not violate its agentRestartV1 descriptor guarantee"
    );
}

#[test]
fn runtime_independent_fresh_agent_errors_are_forwarded_without_a_descriptor() {
    let coordinator = RestartCoordinator::new();
    let error = serde_json::to_string(&ServerMessage::FreshAgentEvent(FreshAgentEvent {
        event: serde_json::json!({
            "type": "freshAgent.error",
            "code": "INVALID_SESSION_ID",
            "message": "session not found",
        }),
        provider: "claude".to_string(),
        session_id: "unknown-runtime".to_string(),
        session_type: "freshclaude".to_string(),
        runtime: None,
    }))
    .unwrap();

    assert_eq!(
        coordinator.observe_serialized(&error),
        Some(error),
        "runtime-independent control errors must reach the client recovery path"
    );
}

#[test]
fn fresh_agent_replacement_uses_a_distinct_live_identity_and_fences_old_frames() {
    let coordinator = RestartCoordinator::new();
    let session_ref = SessionLocator {
        provider: "claude".to_string(),
        session_id: "durable-1".to_string(),
    };
    let old = RuntimeDescriptor {
        runtime_id: "fresh-runtime-old".to_string(),
        generation: 1,
    };
    let replacement = RuntimeDescriptor {
        runtime_id: "fresh-runtime-new".to_string(),
        generation: 2,
    };
    for (request_id, runtime) in [
        ("create-old", old.clone()),
        ("create-new", replacement.clone()),
    ] {
        let mut created = ServerMessage::FreshAgentCreated(FreshAgentCreated {
            provider: "claude".to_string(),
            request_id: request_id.to_string(),
            runtime_provider: "claude".to_string(),
            session_id: "durable-1".to_string(),
            session_type: "freshclaude".to_string(),
            session_ref: Some(session_ref.clone()),
            runtime: Some(runtime),
        });
        coordinator.observe_server_message(&mut created);
    }

    let mut queued_old = ServerMessage::FreshAgentEvent(FreshAgentEvent {
        event: serde_json::json!({"type": "freshAgent.stream", "delta": "old"}),
        provider: "claude".to_string(),
        session_id: "durable-1".to_string(),
        session_type: "freshclaude".to_string(),
        runtime: Some(old.clone()),
    });
    coordinator.observe_server_message(&mut queued_old);

    let ServerMessage::FreshAgentEvent(queued_old) = queued_old else {
        unreachable!()
    };
    assert_eq!(queued_old.runtime, Some(old));
    assert_eq!(
        coordinator.runtime_for_locator(&RuntimeLocator::new(
            AgentRuntimeKind::FreshAgent,
            "claude",
            "durable-1",
        )),
        Some(replacement)
    );
}

#[tokio::test]
async fn terminal_result_replays_after_coordinator_reopens_from_disk() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("restart-state.json");
    let coordinator = RestartCoordinator::new_persistent(path.clone()).unwrap();
    coordinator.register_initial(locator(), "term-1");
    let request = restart("durable-r1", "term-1", 1);
    coordinator
        .execute(request.clone(), &FakeRuntime::resumable("term-2"))
        .await;
    drop(coordinator);

    let reopened = RestartCoordinator::new_persistent(path).unwrap();
    let runtime = FakeRuntime::resumable("must-not-run");
    let replay = reopened.execute(request, &runtime).await;

    assert!(replay.replayed);
    assert!(matches!(
        replay.messages.as_slice(),
        [ServerMessage::AgentRestartReplaced(_)]
    ));
    assert_eq!(runtime.shutdowns.load(Ordering::SeqCst), 0);
}

#[test]
fn persistent_coordinator_rejects_corrupt_truncated_and_unreadable_journals() {
    for (case, bytes) in [
        ("corrupt", b"not-json".as_slice()),
        ("truncated", br#"{"generations":["#.as_slice()),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("restart-state.json");
        std::fs::write(&path, bytes).unwrap();

        let error = RestartCoordinator::new_persistent(&path)
            .err()
            .unwrap_or_else(|| panic!("{case} journal must fail closed"));

        assert_eq!(
            error.kind(),
            std::io::ErrorKind::InvalidData,
            "{case} journal must report invalid persisted state"
        );
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("restart-state.json");
        std::fs::write(&path, b"{}").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        let error = RestartCoordinator::new_persistent(&path)
            .err()
            .expect("an unreadable journal must fail closed");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
    }

    #[cfg(not(unix))]
    {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("restart-state.json");
        std::fs::create_dir(&path).unwrap();
        let error = RestartCoordinator::new_persistent(path)
            .err()
            .expect("an unreadable journal path must fail closed");
        assert_ne!(error.kind(), std::io::ErrorKind::NotFound);
    }
}

#[test]
fn persistent_coordinator_holds_an_exclusive_sibling_lock_for_clone_lifetime() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("restart-state.json");
    let first = RestartCoordinator::new_persistent(path.clone()).unwrap();
    let first_clone = first.clone();

    let competing_error = RestartCoordinator::new_persistent(path.clone())
        .err()
        .expect("a second journal owner must fail closed");
    assert!(
        matches!(
            competing_error.kind(),
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Other
        ),
        "unexpected lock failure: {competing_error}"
    );
    assert!(temp.path().join("restart-state.lock").exists());

    drop(first);
    assert!(
        RestartCoordinator::new_persistent(path.clone()).is_err(),
        "a coordinator clone must retain journal ownership"
    );
    drop(first_clone);
    RestartCoordinator::new_persistent(path)
        .expect("the journal lock must be released with the final coordinator clone");
}

#[test]
fn cross_process_journal_lock_is_exclusive() {
    if let Ok(path) = std::env::var("FRESHELL_TEST_RESTART_LOCK_PATH") {
        let ready = std::env::var("FRESHELL_TEST_RESTART_LOCK_READY").unwrap();
        let release = std::env::var("FRESHELL_TEST_RESTART_LOCK_RELEASE").unwrap();
        let _coordinator =
            RestartCoordinator::new_persistent(path).expect("helper acquires journal lock");
        std::fs::write(&ready, b"ready").unwrap();
        for _ in 0..500 {
            if std::path::Path::new(&release).exists() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("parent never released journal lock helper");
    }

    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("restart-state.json");
    let ready = temp.path().join("ready");
    let release = temp.path().join("release");
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "cross_process_journal_lock_is_exclusive",
            "--nocapture",
        ])
        .env("FRESHELL_TEST_RESTART_LOCK_PATH", &path)
        .env("FRESHELL_TEST_RESTART_LOCK_READY", &ready)
        .env("FRESHELL_TEST_RESTART_LOCK_RELEASE", &release)
        .spawn()
        .expect("spawn lock helper");
    for _ in 0..200 {
        if ready.exists() {
            break;
        }
        assert!(
            child.try_wait().unwrap().is_none(),
            "journal lock helper exited before acquiring the lock"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(ready.exists(), "journal lock helper never became ready");

    let error = RestartCoordinator::new_persistent(path.clone())
        .err()
        .expect("a different process must exclude this journal owner");
    assert!(
        matches!(
            error.kind(),
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Other
        ),
        "unexpected cross-process lock failure: {error}"
    );

    std::fs::write(&release, b"release").unwrap();
    assert!(child.wait().unwrap().success());
    RestartCoordinator::new_persistent(path)
        .expect("the child process release must make the journal available");
}

struct ReplacementFails;

#[async_trait::async_trait]
impl RestartRuntime for ReplacementFails {
    type ResumePlan = ();

    async fn preflight(&self, _request: &AgentRestart) -> Result<(), RestartFailure> {
        Ok(())
    }

    async fn shutdown_for_restart(
        &self,
        _request: &AgentRestart,
        _plan: &(),
    ) -> Result<(), RestartFailure> {
        Ok(())
    }

    async fn create_replacement(
        &self,
        _request: &AgentRestart,
        _plan: (),
    ) -> Result<String, RestartFailure> {
        Err(RestartFailure::new(
            AgentRestartFailureCode::ReplacementFailed,
            "replacement failed",
            true,
        ))
    }
}

struct PreflightReservation {
    aborted: AtomicUsize,
}

#[async_trait::async_trait]
impl RestartRuntime for PreflightReservation {
    type ResumePlan = ();

    async fn preflight(&self, _request: &AgentRestart) -> Result<(), RestartFailure> {
        Ok(())
    }

    async fn abort_preflight(&self, _request: &AgentRestart, _plan: &()) {
        self.aborted.fetch_add(1, Ordering::SeqCst);
    }

    async fn shutdown_for_restart(
        &self,
        _request: &AgentRestart,
        _plan: &(),
    ) -> Result<(), RestartFailure> {
        panic!("journal failure must prevent teardown")
    }

    async fn create_replacement(
        &self,
        _request: &AgentRestart,
        _plan: (),
    ) -> Result<String, RestartFailure> {
        panic!("journal failure must prevent replacement")
    }
}

struct NonRetryableReplacementFails;

#[async_trait::async_trait]
impl RestartRuntime for NonRetryableReplacementFails {
    type ResumePlan = ();

    async fn preflight(&self, _request: &AgentRestart) -> Result<(), RestartFailure> {
        Ok(())
    }

    async fn shutdown_for_restart(
        &self,
        _request: &AgentRestart,
        _plan: &(),
    ) -> Result<(), RestartFailure> {
        Ok(())
    }

    async fn create_replacement(
        &self,
        _request: &AgentRestart,
        _plan: (),
    ) -> Result<String, RestartFailure> {
        Err(RestartFailure::new(
            AgentRestartFailureCode::ReplacementFailed,
            "replacement cannot resume this durable session",
            false,
        ))
    }
}

fn make_restart_state_unwritable(path: &std::path::Path) {
    std::fs::remove_file(path).expect("remove restart state file");
    std::fs::create_dir(path).expect("replace restart state with directory");
}

#[derive(Clone, Copy)]
enum FaultingReplacement {
    RetryableFailure,
    TerminalFailure,
    Success,
}

struct FaultDuringReplacement {
    persistence_path: std::path::PathBuf,
    replacement: FaultingReplacement,
}

#[async_trait::async_trait]
impl RestartRuntime for FaultDuringReplacement {
    type ResumePlan = ();

    async fn preflight(&self, _request: &AgentRestart) -> Result<(), RestartFailure> {
        Ok(())
    }

    async fn shutdown_for_restart(
        &self,
        _request: &AgentRestart,
        _plan: &(),
    ) -> Result<(), RestartFailure> {
        Ok(())
    }

    async fn create_replacement(
        &self,
        _request: &AgentRestart,
        _plan: (),
    ) -> Result<String, RestartFailure> {
        make_restart_state_unwritable(&self.persistence_path);
        match self.replacement {
            FaultingReplacement::RetryableFailure => Err(RestartFailure::new(
                AgentRestartFailureCode::ReplacementFailed,
                "temporary replacement failure",
                true,
            )),
            FaultingReplacement::TerminalFailure => Err(RestartFailure::new(
                AgentRestartFailureCode::ReplacementFailed,
                "terminal replacement failure",
                false,
            )),
            FaultingReplacement::Success => Ok("term-created-before-commit".to_string()),
        }
    }
}

struct FaultAfterRetirement {
    persistence_path: std::path::PathBuf,
}

#[async_trait::async_trait]
impl RestartRuntime for FaultAfterRetirement {
    type ResumePlan = ();

    async fn preflight(&self, _request: &AgentRestart) -> Result<(), RestartFailure> {
        Ok(())
    }

    async fn shutdown_for_restart(
        &self,
        _request: &AgentRestart,
        _plan: &(),
    ) -> Result<(), RestartFailure> {
        make_restart_state_unwritable(&self.persistence_path);
        Ok(())
    }

    async fn create_replacement(
        &self,
        _request: &AgentRestart,
        _plan: (),
    ) -> Result<String, RestartFailure> {
        panic!("replacement cannot start before retirement completion is durable")
    }
}

fn assert_post_retirement_persistence_failure_is_recoverable(outcome: &RestartOutcome) {
    assert!(matches!(
        outcome.messages.last(),
        Some(ServerMessage::AgentRestartFailed(message))
            if message.retryable
                && message.recovery_pending
                && message.code == AgentRestartFailureCode::PreflightFailed
    ));
}

#[tokio::test]
async fn every_initial_post_retirement_persistence_fault_reports_recovery_pending() {
    for replacement in [
        FaultingReplacement::RetryableFailure,
        FaultingReplacement::TerminalFailure,
        FaultingReplacement::Success,
    ] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("restart-state.json");
        let coordinator = RestartCoordinator::new_persistent(path.clone()).unwrap();
        coordinator.register_initial(locator(), "term-1");
        let outcome = coordinator
            .execute(
                restart("post-retirement-fault", "term-1", 1),
                &FaultDuringReplacement {
                    persistence_path: path,
                    replacement,
                },
            )
            .await;
        assert_post_retirement_persistence_failure_is_recoverable(&outcome);
    }

    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("restart-state.json");
    let coordinator = RestartCoordinator::new_persistent(path.clone()).unwrap();
    coordinator.register_initial(locator(), "term-1");
    let outcome = coordinator
        .execute(
            restart("retirement-complete-fault", "term-1", 1),
            &FaultAfterRetirement {
                persistence_path: path,
            },
        )
        .await;
    assert_post_retirement_persistence_failure_is_recoverable(&outcome);
}

struct FaultDuringRecovery {
    persistence_path: std::path::PathBuf,
    replacement: FaultingReplacement,
}

#[async_trait::async_trait]
impl RestartRuntime for FaultDuringRecovery {
    type ResumePlan = ();

    async fn preflight(&self, _request: &AgentRestart) -> Result<(), RestartFailure> {
        panic!("post-retirement recovery must not preflight the vanished runtime")
    }

    async fn shutdown_for_restart(
        &self,
        _request: &AgentRestart,
        _plan: &(),
    ) -> Result<(), RestartFailure> {
        panic!("completed retirement must not run twice")
    }

    async fn create_replacement(
        &self,
        _request: &AgentRestart,
        _plan: (),
    ) -> Result<String, RestartFailure> {
        panic!("recovery must use recover_replacement")
    }

    async fn recover_replacement(
        &self,
        _request: &AgentRestart,
        _context: Option<&RestartResumeContext>,
    ) -> Result<String, RestartFailure> {
        make_restart_state_unwritable(&self.persistence_path);
        match self.replacement {
            FaultingReplacement::RetryableFailure => Err(RestartFailure::new(
                AgentRestartFailureCode::ReplacementFailed,
                "temporary recovery failure",
                true,
            )),
            FaultingReplacement::TerminalFailure => Err(RestartFailure::new(
                AgentRestartFailureCode::ReplacementFailed,
                "terminal recovery failure",
                false,
            )),
            FaultingReplacement::Success => Ok("term-recovered-before-commit".to_string()),
        }
    }
}

struct FaultAfterRecoveredRetirement {
    persistence_path: std::path::PathBuf,
}

#[async_trait::async_trait]
impl RestartRuntime for FaultAfterRecoveredRetirement {
    type ResumePlan = ();

    async fn preflight(&self, _request: &AgentRestart) -> Result<(), RestartFailure> {
        Ok(())
    }

    async fn shutdown_for_restart(
        &self,
        _request: &AgentRestart,
        _plan: &(),
    ) -> Result<(), RestartFailure> {
        panic!("boot recovery must use recover_retirement")
    }

    async fn create_replacement(
        &self,
        _request: &AgentRestart,
        _plan: (),
    ) -> Result<String, RestartFailure> {
        panic!("replacement cannot precede durable recovered retirement")
    }

    async fn recover_retirement(
        &self,
        _request: &AgentRestart,
        _context: Option<&RestartResumeContext>,
    ) -> Result<(), RestartFailure> {
        make_restart_state_unwritable(&self.persistence_path);
        Ok(())
    }
}

#[tokio::test]
async fn every_recovery_and_adoption_persistence_fault_reports_recovery_pending() {
    for replacement in [
        FaultingReplacement::RetryableFailure,
        FaultingReplacement::TerminalFailure,
        FaultingReplacement::Success,
    ] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("restart-state.json");
        let request = restart("recovery-persistence-fault", "term-1", 1);
        let coordinator = RestartCoordinator::new_persistent(path.clone()).unwrap();
        coordinator.register_initial(locator(), "term-1");
        coordinator
            .execute(request.clone(), &ReplacementFails)
            .await;
        drop(coordinator);

        let reopened = RestartCoordinator::new_persistent(path.clone()).unwrap();
        let outcome = reopened
            .execute(
                request,
                &FaultDuringRecovery {
                    persistence_path: path,
                    replacement,
                },
            )
            .await;
        assert_post_retirement_persistence_failure_is_recoverable(&outcome);
    }

    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("restart-state.json");
    let request = restart("retirement-recovery-persistence-fault", "term-1", 1);
    let coordinator = RestartCoordinator::new_persistent(path.clone()).unwrap();
    coordinator.register_initial(locator(), "term-1");
    let incomplete = RetirementRetries {
        shutdowns: AtomicUsize::new(0),
    };
    coordinator.execute(request.clone(), &incomplete).await;
    drop(coordinator);
    let reopened = RestartCoordinator::new_persistent(path.clone()).unwrap();
    let outcome = reopened
        .execute(
            request,
            &FaultAfterRecoveredRetirement {
                persistence_path: path,
            },
        )
        .await;
    assert_post_retirement_persistence_failure_is_recoverable(&outcome);

    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("restart-state.json");
    let request = restart("adoption-persistence-fault", "term-1", 1);
    let coordinator = RestartCoordinator::new_persistent(path.clone()).unwrap();
    coordinator.register_initial(locator(), "term-1");
    coordinator
        .execute(request.clone(), &ReplacementFails)
        .await;
    drop(coordinator);
    let reopened = RestartCoordinator::new_persistent(path.clone()).unwrap();
    reopened.register_supplied(
        locator(),
        RuntimeDescriptor {
            runtime_id: "term-observed-replacement".to_string(),
            generation: 2,
        },
    );
    make_restart_state_unwritable(&path);
    let outcome = reopened
        .execute(
            request,
            &RecoveryMustNotSpawn {
                attempts: AtomicUsize::new(0),
            },
        )
        .await;
    assert_post_retirement_persistence_failure_is_recoverable(&outcome);
}

struct RetirementRetries {
    shutdowns: AtomicUsize,
}

#[async_trait::async_trait]
impl RestartRuntime for RetirementRetries {
    type ResumePlan = ();

    async fn preflight(&self, _request: &AgentRestart) -> Result<(), RestartFailure> {
        Ok(())
    }

    async fn shutdown_for_restart(
        &self,
        _request: &AgentRestart,
        _plan: &(),
    ) -> Result<(), RestartFailure> {
        if self.shutdowns.fetch_add(1, Ordering::SeqCst) == 0 {
            Err(RestartFailure::new(
                AgentRestartFailureCode::ShutdownFailed,
                "retirement barrier is not yet quiescent",
                true,
            ))
        } else {
            Ok(())
        }
    }

    async fn create_replacement(
        &self,
        _request: &AgentRestart,
        _plan: (),
    ) -> Result<String, RestartFailure> {
        Ok("term-after-retirement".to_string())
    }
}

struct ConcurrentRetirementGate {
    shutdowns: AtomicUsize,
    allow_retirement: AtomicBool,
    retry_entered: tokio::sync::Barrier,
    retry_release: tokio::sync::Notify,
}

#[async_trait::async_trait]
impl RestartRuntime for ConcurrentRetirementGate {
    type ResumePlan = ();

    async fn preflight(&self, _request: &AgentRestart) -> Result<(), RestartFailure> {
        Ok(())
    }

    async fn shutdown_for_restart(
        &self,
        _request: &AgentRestart,
        _plan: &(),
    ) -> Result<(), RestartFailure> {
        let attempt = self.shutdowns.fetch_add(1, Ordering::SeqCst);
        if attempt == 1 {
            self.retry_entered.wait().await;
            self.retry_release.notified().await;
        }
        if self.allow_retirement.load(Ordering::SeqCst) {
            Ok(())
        } else {
            Err(RestartFailure::new(
                AgentRestartFailureCode::ShutdownFailed,
                "retirement barrier remains active",
                true,
            ))
        }
    }

    async fn create_replacement(
        &self,
        _request: &AgentRestart,
        _plan: (),
    ) -> Result<String, RestartFailure> {
        panic!("the already-registered replacement must be adopted after retirement")
    }
}

#[tokio::test]
async fn retryable_retirement_finishes_before_replacement() {
    let coordinator = RestartCoordinator::new();
    coordinator.register_initial(locator(), "term-1");
    let request = restart("retirement-r1", "term-1", 1);
    let runtime = RetirementRetries {
        shutdowns: AtomicUsize::new(0),
    };

    let first = coordinator.execute(request.clone(), &runtime).await;
    assert!(matches!(
        first.messages.last(),
        Some(ServerMessage::AgentRestartFailed(message))
            if message.code == AgentRestartFailureCode::ShutdownFailed
                && message.retryable
                && message.recovery_pending
    ));
    assert_eq!(
        coordinator
            .pending_recoveries()
            .first()
            .map(|pending| pending.retirement_pending),
        Some(true)
    );

    let recovered = coordinator.execute(request, &runtime).await;
    assert!(matches!(
        recovered.messages.last(),
        Some(ServerMessage::AgentRestartReplaced(message))
            if message.runtime.runtime_id == "term-after-retirement"
    ));
    assert_eq!(runtime.shutdowns.load(Ordering::SeqCst), 2);
    assert!(coordinator.pending_recoveries().is_empty());
}

/// Regression for the boot/reconcile race: a newly observed runtime for the
/// same durable locator is not proof that the persisted predecessor stopped.
/// The retirement journal must remain authoritative until its provider fence
/// succeeds, even when reconciliation registers a higher generation before a
/// client (or boot recovery) retries the original request.
#[tokio::test]
async fn registered_replacement_waits_for_pending_retirement_before_adoption() {
    let coordinator = RestartCoordinator::new();
    coordinator.register_initial(locator(), "term-1");
    let request = restart("retirement-adoption-r1", "term-1", 1);
    let runtime = Arc::new(ConcurrentRetirementGate {
        shutdowns: AtomicUsize::new(0),
        allow_retirement: AtomicBool::new(false),
        retry_entered: tokio::sync::Barrier::new(2),
        retry_release: tokio::sync::Notify::new(),
    });

    let first = coordinator.execute(request.clone(), runtime.as_ref()).await;
    assert!(matches!(
        first.messages.last(),
        Some(ServerMessage::AgentRestartFailed(message))
            if message.code == AgentRestartFailureCode::ShutdownFailed
                && message.retryable
                && message.recovery_pending
    ));

    let retry_coordinator = coordinator.clone();
    let retry_request = request.clone();
    let retry_runtime = Arc::clone(&runtime);
    let retry = tokio::spawn(async move {
        retry_coordinator
            .execute(retry_request, retry_runtime.as_ref())
            .await
    });
    runtime.retry_entered.wait().await;

    // A create/reconcile observation arrives while retirement recovery is
    // actively blocked inside its provider fence.
    let observed = coordinator.register_initial(locator(), "term-observed-during-retirement");
    assert!(observed.generation > request.expected_generation);
    assert!(
        !retry.is_finished(),
        "runtime observation must not bypass the in-flight retirement fence"
    );
    runtime.retry_release.notify_one();

    let (events, _trace_guard) = capture_traces();
    let still_blocked = retry.await.unwrap();

    assert_eq!(
        runtime.shutdowns.load(Ordering::SeqCst),
        2,
        "the provider retirement fence must run before adopting an observed runtime"
    );
    assert!(matches!(
        still_blocked.messages.last(),
        Some(ServerMessage::AgentRestartFailed(message))
            if message.code == AgentRestartFailureCode::ShutdownFailed
                && message.retryable
                && message.recovery_pending
    ));
    assert_eq!(
        coordinator.pending_recoveries().len(),
        1,
        "a blocked fence must retain the durable journal despite the observed runtime"
    );
    assert_eq!(
        coordinator
            .runtime_for_locator(&locator())
            .map(|runtime| runtime.runtime_id),
        Some("term-observed-during-retirement".to_string())
    );
    runtime.allow_retirement.store(true, Ordering::SeqCst);
    let recovered = coordinator.execute(request, runtime.as_ref()).await;
    assert_eq!(runtime.shutdowns.load(Ordering::SeqCst), 3);
    assert!(matches!(
        recovered.messages.last(),
        Some(ServerMessage::AgentRestartReplaced(message))
            if message.runtime.runtime_id == "term-observed-during-retirement"
    ));
    assert!(coordinator.pending_recoveries().is_empty());
    assert!(
        events.lock().unwrap().iter().any(|event| {
            event.message == "agent.restart.recovery.registered_replacement_waiting_for_retirement"
                && event.fields.get("request_id") == Some(&"retirement-adoption-r1".to_string())
        }),
        "the safety deferral must be visible in structured logs"
    );
}

/// A blocked boot retirement is a session-scoped create fence: retrying that
/// durable locator cannot start a second writer, while an unrelated locator
/// continues to use the normal create path.
#[tokio::test]
async fn pending_retirement_blocks_only_the_matching_terminal_create() {
    let (url, registry, state) = common::spawn_server_with_specs_and_state(vec![
        common::sleeper_cli_spec("claude"),
        common::sleeper_cli_spec("amplifier"),
    ])
    .await;
    let blocked_session = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let old = state.restart.register_initial(
        RuntimeLocator::new(AgentRuntimeKind::Terminal, "claude", blocked_session),
        "term-blocked-predecessor",
    );
    let runtime = ConcurrentRetirementGate {
        shutdowns: AtomicUsize::new(0),
        allow_retirement: AtomicBool::new(false),
        retry_entered: tokio::sync::Barrier::new(2),
        retry_release: tokio::sync::Notify::new(),
    };
    state
        .restart
        .execute(
            AgentRestart {
                request_id: "blocked-create-retirement".to_string(),
                provider: "claude".to_string(),
                session_id: blocked_session.to_string(),
                kind: AgentRuntimeKind::Terminal,
                live_id: old.runtime_id,
                expected_generation: old.generation,
            },
            &runtime,
        )
        .await;
    assert!(state.restart.pending_recoveries()[0].retirement_pending);

    let (mut ws, _) = common::connect_and_capture_inventory_with_capabilities(
        &url,
        Some(serde_json::json!({ "paneReconcileV1": true })),
    )
    .await;
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "pane.reconcile.request",
            "reconcileId": "blocked-retirement-reconcile",
            "panes": [
                {
                    "paneKey": "blocked-pane",
                    "kind": "terminal",
                    "mode": "claude",
                    "createRequestId": "blocked-matching-create",
                    "resumeSessionId": blocked_session,
                    "sessionRef": {
                        "provider": "claude",
                        "sessionId": blocked_session
                    }
                },
                {
                    "paneKey": "unrelated-pane",
                    "kind": "terminal",
                    "mode": "amplifier",
                    "createRequestId": "allowed-unrelated-create",
                    "resumeSessionId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                    "sessionRef": {
                        "provider": "amplifier",
                        "sessionId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
                    }
                }
            ]
        })
        .to_string(),
    ))
    .await
    .unwrap();
    let reconciled = common::next_frame_of_type(&mut ws, "pane.reconcile.result").await;
    let verdicts = reconciled["verdicts"].as_array().unwrap();
    assert_eq!(verdicts[0]["paneKey"], "blocked-pane");
    assert_eq!(verdicts[0]["verdict"], "error");
    assert_eq!(verdicts[0]["reason"], "restart_retirement_pending");
    assert_ne!(
        verdicts[1]["reason"], "restart_retirement_pending",
        "unrelated reconciliation remains available"
    );

    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.create",
            "requestId": "blocked-matching-create",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir(),
            "restore": true,
            "resumeSessionId": blocked_session,
            "sessionRef": {
                "provider": "claude",
                "sessionId": blocked_session
            }
        })
        .to_string(),
    ))
    .await
    .unwrap();
    let blocked = common::next_frame_of_type(&mut ws, "error").await;
    assert_eq!(blocked["code"], "SESSION_RESERVED");
    assert_eq!(blocked["requestId"], "blocked-matching-create");
    assert!(
        registry.inventory().is_empty(),
        "the matching durable create must not spawn a replacement writer"
    );

    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.create",
            "requestId": "allowed-unrelated-create",
            "mode": "amplifier",
            "shell": "system",
            "cwd": std::env::temp_dir(),
            "restore": true,
            "resumeSessionId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            "sessionRef": {
                "provider": "amplifier",
                "sessionId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
            }
        })
        .to_string(),
    ))
    .await
    .unwrap();
    let created = common::next_frame_of_type(&mut ws, "terminal.created").await;
    assert_eq!(created["requestId"], "allowed-unrelated-create");
    assert_eq!(registry.inventory().len(), 1);
    registry.kill_all();
}

#[tokio::test]
async fn reconcile_fences_the_server_authoritative_session_not_a_stale_client_claim() {
    let (url, registry, state) =
        common::spawn_server_with_specs_and_state(vec![common::sleeper_cli_spec("claude")]).await;
    let (mut ws, _) = common::connect_and_capture_inventory_with_capabilities(
        &url,
        Some(serde_json::json!({ "paneReconcileV1": true })),
    )
    .await;
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.create",
            "requestId": "authoritative-reconcile-create",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir(),
        })
        .to_string(),
    ))
    .await
    .unwrap();
    let created = common::next_frame_of_type(&mut ws, "terminal.created").await;
    let terminal_id = created["terminalId"].as_str().unwrap().to_string();
    let authoritative_session = created["sessionRef"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();

    // Model a historical fresh-agent predecessor still retiring for the
    // same durable transcript. The live terminal itself remains available
    // so reconciliation produces an authoritative corrected sessionRef.
    let old = state.restart.register_initial(
        RuntimeLocator::new(
            AgentRuntimeKind::FreshAgent,
            "claude",
            &authoritative_session,
        ),
        "fresh-historical-predecessor",
    );
    state
        .restart
        .execute(
            AgentRestart {
                request_id: "authoritative-reconcile-retirement".to_string(),
                provider: "claude".to_string(),
                session_id: authoritative_session.clone(),
                kind: AgentRuntimeKind::FreshAgent,
                live_id: old.runtime_id,
                expected_generation: old.generation,
            },
            &ConcurrentRetirementGate {
                shutdowns: AtomicUsize::new(0),
                allow_retirement: AtomicBool::new(false),
                retry_entered: tokio::sync::Barrier::new(2),
                retry_release: tokio::sync::Notify::new(),
            },
        )
        .await;

    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "pane.reconcile.request",
            "reconcileId": "authoritative-reconcile",
            "panes": [{
                "paneKey": "authoritative-pane",
                "kind": "terminal",
                "mode": "claude",
                "terminalId": terminal_id,
                "createRequestId": "authoritative-reconcile-create",
                "sessionRef": {
                    "provider": "claude",
                    "sessionId": "stale-client-session"
                }
            }]
        })
        .to_string(),
    ))
    .await
    .unwrap();
    let result = common::next_frame_of_type(&mut ws, "pane.reconcile.result").await;
    let verdict = &result["verdicts"][0];
    assert_eq!(verdict["verdict"], "error");
    assert_eq!(verdict["reason"], "restart_retirement_pending");
    assert_eq!(
        verdict["sessionRef"]["sessionId"], authoritative_session,
        "the restart fence must follow the server-corrected identity"
    );
    registry.kill_all();
}

#[tokio::test]
async fn pending_retirement_blocks_only_the_matching_fresh_agent_create() {
    let (url, registry, state) = common::spawn_server_with_specs_and_state(vec![]).await;
    state.fresh_codex.set_enabled(true);
    let blocked_session = "ses_blocked_restart_retirement";
    let old = state.restart.register_initial(
        RuntimeLocator::new(AgentRuntimeKind::FreshAgent, "opencode", blocked_session),
        "fresh-opencode-blocked-predecessor",
    );
    let runtime = ConcurrentRetirementGate {
        shutdowns: AtomicUsize::new(0),
        allow_retirement: AtomicBool::new(false),
        retry_entered: tokio::sync::Barrier::new(2),
        retry_release: tokio::sync::Notify::new(),
    };
    state
        .restart
        .execute(
            AgentRestart {
                request_id: "blocked-fresh-create-retirement".to_string(),
                provider: "opencode".to_string(),
                session_id: blocked_session.to_string(),
                kind: AgentRuntimeKind::FreshAgent,
                live_id: old.runtime_id,
                expected_generation: old.generation,
            },
            &runtime,
        )
        .await;
    let (mut ws, _) = common::connect_and_capture_inventory(&url).await;
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "freshAgent.create",
            "requestId": "blocked-matching-fresh-create",
            "sessionType": "freshopencode",
            "provider": "opencode",
            "resumeSessionId": blocked_session,
            "sessionRef": {
                "provider": "opencode",
                "sessionId": blocked_session
            }
        })
        .to_string(),
    ))
    .await
    .unwrap();
    let blocked = common::next_frame_of_type(&mut ws, "freshAgent.create.failed").await;
    assert_eq!(blocked["code"], "SESSION_RESERVED");
    assert_eq!(blocked["requestId"], "blocked-matching-fresh-create");

    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "freshAgent.create",
            "requestId": "allowed-unrelated-fresh-create",
            "sessionType": "freshopencode",
            "provider": "opencode"
        })
        .to_string(),
    ))
    .await
    .unwrap();
    let created = common::next_frame_of_type(&mut ws, "freshAgent.created").await;
    assert_eq!(created["requestId"], "allowed-unrelated-fresh-create");
    assert_eq!(
        created["sessionId"],
        "freshopencode-allowed-unrelated-fresh-create"
    );
    registry.kill_all();
}

#[tokio::test]
async fn pending_retirement_blocks_matching_fresh_agent_attach_without_blocking_unrelated_attach() {
    let (url, registry, state) = common::spawn_server_with_specs_and_state(vec![]).await;
    state.fresh_codex.set_enabled(true);
    let blocked_session = "7f8e9d0c-1b2a-43d4-85e6-f708192a3b4c";
    let old = state.restart.register_initial(
        RuntimeLocator::new(AgentRuntimeKind::FreshAgent, "claude", blocked_session),
        "fresh-claude-blocked-predecessor",
    );
    let runtime = ConcurrentRetirementGate {
        shutdowns: AtomicUsize::new(0),
        allow_retirement: AtomicBool::new(false),
        retry_entered: tokio::sync::Barrier::new(2),
        retry_release: tokio::sync::Notify::new(),
    };
    state
        .restart
        .execute(
            AgentRestart {
                request_id: "blocked-fresh-attach-retirement".to_string(),
                provider: "claude".to_string(),
                session_id: blocked_session.to_string(),
                kind: AgentRuntimeKind::FreshAgent,
                live_id: old.runtime_id,
                expected_generation: old.generation,
            },
            &runtime,
        )
        .await;
    let blocked_opencode_session = "ses_blocked_opencode_attach_retirement";
    let old_opencode = state.restart.register_initial(
        RuntimeLocator::new(
            AgentRuntimeKind::FreshAgent,
            "opencode",
            blocked_opencode_session,
        ),
        "fresh-opencode-attach-blocked-predecessor",
    );
    let opencode_runtime = ConcurrentRetirementGate {
        shutdowns: AtomicUsize::new(0),
        allow_retirement: AtomicBool::new(false),
        retry_entered: tokio::sync::Barrier::new(2),
        retry_release: tokio::sync::Notify::new(),
    };
    state
        .restart
        .execute(
            AgentRestart {
                request_id: "blocked-opencode-attach-retirement".to_string(),
                provider: "opencode".to_string(),
                session_id: blocked_opencode_session.to_string(),
                kind: AgentRuntimeKind::FreshAgent,
                live_id: old_opencode.runtime_id,
                expected_generation: old_opencode.generation,
            },
            &opencode_runtime,
        )
        .await;

    let (mut ws, _) = common::connect_and_capture_inventory(&url).await;
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "freshAgent.attach",
            "provider": "claude",
            "sessionId": "blocked-attach-client-pane",
            "sessionType": "freshclaude",
            "resumeSessionId": blocked_session,
            "sessionRef": {
                "provider": "claude",
                "sessionId": blocked_session
            }
        })
        .to_string(),
    ))
    .await
    .unwrap();
    let blocked = common::next_frame_of_type(&mut ws, "freshAgent.event").await;
    assert_eq!(blocked["provider"], "claude");
    assert_eq!(blocked["sessionId"], "blocked-attach-client-pane");
    assert_eq!(blocked["event"]["type"], "freshAgent.error");
    assert_eq!(blocked["event"]["code"], "SESSION_RESERVED");
    assert!(
        !state
            .fresh_claude
            .has_live_session("blocked-attach-client-pane")
            .await,
        "blocked attach must not register or spawn a replacement runtime"
    );

    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "freshAgent.attach",
            "provider": "opencode",
            "sessionId": blocked_opencode_session,
            "sessionType": "freshopencode"
        })
        .to_string(),
    ))
    .await
    .unwrap();
    let blocked_opencode = common::next_frame_of_type(&mut ws, "freshAgent.event").await;
    assert_eq!(blocked_opencode["provider"], "opencode");
    assert_eq!(blocked_opencode["sessionId"], blocked_opencode_session);
    assert_eq!(blocked_opencode["event"]["type"], "freshAgent.error");
    assert_eq!(blocked_opencode["event"]["code"], "SESSION_RESERVED");
    assert!(
        !state
            .fresh_opencode
            .has_live_session(blocked_opencode_session)
            .await,
        "blocked OpenCode attach must not cold-start or register a replacement runtime"
    );

    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "freshAgent.create",
            "requestId": "allowed-unrelated-attach",
            "sessionType": "freshopencode",
            "provider": "opencode"
        })
        .to_string(),
    ))
    .await
    .unwrap();
    let created = common::next_frame_of_type(&mut ws, "freshAgent.created").await;
    let unrelated_session = created["sessionId"]
        .as_str()
        .expect("created session id")
        .to_string();

    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "freshAgent.attach",
            "provider": "opencode",
            "sessionId": unrelated_session,
            "sessionType": "freshopencode"
        })
        .to_string(),
    ))
    .await
    .unwrap();
    let unrelated = common::next_frame_of_type(&mut ws, "freshAgent.event").await;
    assert_eq!(unrelated["provider"], "opencode");
    assert_eq!(unrelated["sessionId"], unrelated_session);
    assert_eq!(unrelated["event"]["type"], "freshAgent.session.snapshot");
    assert_ne!(unrelated["event"]["code"], "SESSION_RESERVED");
    registry.kill_all();
}

#[tokio::test]
async fn non_retryable_replacement_failure_logs_its_terminal_restart_outcome() {
    let coordinator = RestartCoordinator::new();
    coordinator.register_initial(locator(), "term-1");
    let (events, _trace_guard) = capture_traces();

    let outcome = coordinator
        .execute(
            restart("terminal-failure-r1", "term-1", 1),
            &NonRetryableReplacementFails,
        )
        .await;

    assert!(matches!(
        outcome.messages.as_slice(),
        [ServerMessage::AgentRestartStarted(_), ServerMessage::AgentRestartFailed(message)]
            if message.code == AgentRestartFailureCode::ReplacementFailed && !message.retryable
    ));
    let event = events
        .lock()
        .expect("trace capture lock")
        .iter()
        .find(|event| event.message == "agent.restart.replacement.failed")
        .cloned()
        .expect("non-retryable replacement failure must be logged");
    assert_eq!(
        event.fields.get("request_id").map(String::as_str),
        Some("terminal-failure-r1")
    );
    assert_eq!(
        event.fields.get("provider").map(String::as_str),
        Some("claude")
    );
    assert_eq!(
        event.fields.get("session_id").map(String::as_str),
        Some("durable-1")
    );
    assert_eq!(
        event.fields.get("runtime_id").map(String::as_str),
        Some("term-1")
    );
    assert_eq!(
        event.fields.get("generation").map(String::as_str),
        Some("1")
    );
    assert_eq!(
        event.fields.get("code").map(String::as_str),
        Some("ReplacementFailed")
    );
    assert_eq!(
        event.fields.get("retryable").map(String::as_str),
        Some("false")
    );
    assert_eq!(
        event.fields.get("error").map(String::as_str),
        Some("replacement cannot resume this durable session")
    );
}

#[tokio::test]
async fn retryable_post_shutdown_failure_is_durable_without_claiming_old_runtime_current() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("restart-state.json");
    let coordinator = RestartCoordinator::new_persistent(path.clone()).unwrap();
    coordinator.register_initial(locator(), "term-1");
    coordinator
        .execute(restart("pending-r1", "term-1", 1), &ReplacementFails)
        .await;
    assert_eq!(coordinator.runtime_for_locator(&locator()), None);
    drop(coordinator);

    let reopened = RestartCoordinator::new_persistent(path).unwrap();
    assert_eq!(reopened.runtime_for_locator(&locator()), None);
    assert_eq!(reopened.pending_recoveries().len(), 1);
    assert_eq!(reopened.pending_recoveries()[0].request_id, "pending-r1");
}

struct RecoveringReplacement {
    attempts: AtomicUsize,
}

#[async_trait::async_trait]
impl RestartRuntime for RecoveringReplacement {
    type ResumePlan = ();

    async fn preflight(&self, _request: &AgentRestart) -> Result<(), RestartFailure> {
        Ok(())
    }

    async fn shutdown_for_restart(
        &self,
        _request: &AgentRestart,
        _plan: &(),
    ) -> Result<(), RestartFailure> {
        panic!("a pending post-shutdown recovery must not tear down the old runtime twice")
    }

    async fn create_replacement(
        &self,
        _request: &AgentRestart,
        _plan: (),
    ) -> Result<String, RestartFailure> {
        self.attempts.fetch_add(1, Ordering::SeqCst);
        Ok("term-recovered".to_string())
    }
}

#[tokio::test]
async fn identical_retry_resumes_a_persisted_post_shutdown_replacement() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("restart-state.json");
    let request = restart("pending-r1", "term-1", 1);
    let coordinator = RestartCoordinator::new_persistent(path.clone()).unwrap();
    coordinator.register_initial(locator(), "term-1");
    coordinator
        .execute(request.clone(), &ReplacementFails)
        .await;
    drop(coordinator);

    let reopened = RestartCoordinator::new_persistent(path).unwrap();
    let runtime = RecoveringReplacement {
        attempts: AtomicUsize::new(0),
    };
    let recovered = reopened.execute(request.clone(), &runtime).await;

    assert!(!recovered.replayed);
    assert!(matches!(
        recovered.messages.last(),
        Some(ServerMessage::AgentRestartReplaced(message))
            if message.runtime.runtime_id == "term-recovered"
    ));
    assert_eq!(runtime.attempts.load(Ordering::SeqCst), 1);
    assert!(reopened.pending_recoveries().is_empty());

    let replay = reopened.execute(request, &runtime).await;
    assert!(replay.replayed);
    assert_eq!(runtime.attempts.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn distinct_request_can_drive_and_replay_persisted_recovery() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("restart-state.json");
    let owner = restart("pending-owner", "term-1", 1);
    let follower = restart("pending-follower", "term-1", 1);
    let coordinator = RestartCoordinator::new_persistent(path.clone()).unwrap();
    coordinator.register_initial(locator(), "term-1");

    let owner_failure = coordinator.execute(owner.clone(), &ReplacementFails).await;
    assert!(matches!(
        owner_failure.messages.last(),
        Some(ServerMessage::AgentRestartFailed(message))
            if message.retryable && message.recovery_pending
    ));

    // A second client must correlate to the already-retired predecessor rather
    // than receiving RUNTIME_NOT_FOUND. Its own failed recovery attempt and
    // request id must survive a server reopen.
    let follower_failure = coordinator
        .execute(follower.clone(), &ReplacementFails)
        .await;
    assert!(matches!(
        follower_failure.messages.last(),
        Some(ServerMessage::AgentRestartFailed(message))
            if message.request_id == "pending-follower"
                && message.retryable
                && message.recovery_pending
    ));
    drop(coordinator);

    let reopened = RestartCoordinator::new_persistent(path).unwrap();
    let runtime = RecoveringReplacement {
        attempts: AtomicUsize::new(0),
    };
    let owner_recovered = reopened.execute(owner.clone(), &runtime).await;
    let owner_replacement = match owner_recovered.messages.last() {
        Some(ServerMessage::AgentRestartReplaced(message)) => message.clone(),
        other => panic!("owner recovery did not replace runtime: {other:?}"),
    };

    let follower_replay = reopened.execute(follower, &runtime).await;
    assert!(follower_replay.replayed);
    assert!(matches!(
        follower_replay.messages.as_slice(),
        [ServerMessage::AgentRestartReplaced(message)]
            if message.request_id == "pending-follower"
                && message.runtime == owner_replacement.runtime
                && message.old_runtime.old_runtime_id
                    == owner_replacement.old_runtime.old_runtime_id
    ));
    assert_eq!(
        runtime.attempts.load(Ordering::SeqCst),
        1,
        "correlated follower replay must not launch another replacement"
    );

    let owner_replay = reopened.execute(owner, &runtime).await;
    assert!(owner_replay.replayed);
    assert_eq!(runtime.attempts.load(Ordering::SeqCst), 1);
    assert!(reopened.pending_recoveries().is_empty());
}

#[tokio::test]
async fn persistence_failure_before_shutdown_fails_closed() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("restart-state.json");
    let coordinator = RestartCoordinator::new_persistent(path.clone()).unwrap();
    coordinator.register_initial(locator(), "term-1");
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    let runtime = FakeRuntime::resumable("must-not-start");

    let outcome = coordinator
        .execute(restart("persistence-r1", "term-1", 1), &runtime)
        .await;

    assert_eq!(runtime.shutdowns.load(Ordering::SeqCst), 0);
    assert!(runtime.running.load(Ordering::SeqCst));
    assert!(matches!(
        outcome.messages.as_slice(),
        [ServerMessage::AgentRestartFailed(message)]
            if message.retryable
                && message.code == AgentRestartFailureCode::PreflightFailed
    ));
}

#[tokio::test]
async fn persistence_failure_releases_the_non_destructive_preflight_reservation() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("restart-state.json");
    let coordinator = RestartCoordinator::new_persistent(path.clone()).unwrap();
    coordinator.register_initial(locator(), "term-1");
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    let runtime = PreflightReservation {
        aborted: AtomicUsize::new(0),
    };

    coordinator
        .execute(restart("abort-preflight-r1", "term-1", 1), &runtime)
        .await;

    assert_eq!(
        runtime.aborted.load(Ordering::SeqCst),
        1,
        "a failed durable boundary must release provider preflight state"
    );
}

#[tokio::test]
async fn reopened_late_terminal_association_advances_persisted_generation() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("restart-state.json");
    let coordinator = RestartCoordinator::new_persistent(path.clone()).unwrap();
    coordinator.register_initial(locator(), "term-1");
    coordinator
        .execute(
            restart("generation-r1", "term-1", 1),
            &FakeRuntime::resumable("term-2"),
        )
        .await;
    drop(coordinator);

    let reopened = RestartCoordinator::new_persistent(path).unwrap();
    reopened.register_live(AgentRuntimeKind::Terminal, "term-late");
    let mut associated = ServerMessage::TerminalSessionAssociated(TerminalSessionAssociated {
        terminal_id: "term-late".to_string(),
        session_ref: SessionLocator {
            provider: "claude".to_string(),
            session_id: "durable-1".to_string(),
        },
        previous_session_id: None,
        runtime: None,
    });
    reopened.observe_server_message(&mut associated);

    let ServerMessage::TerminalSessionAssociated(associated) = associated else {
        unreachable!()
    };
    assert_eq!(
        associated.runtime,
        Some(RuntimeDescriptor {
            runtime_id: "term-late".to_string(),
            generation: 3,
        })
    );
}

#[tokio::test]
async fn durable_terminal_results_use_a_bounded_recent_replay_window() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("bounded-restart-state.json");
    let coordinator = RestartCoordinator::new_persistent_with_limits(
        path.clone(),
        2,
        2,
        RestartIngressLimits::default(),
    )
    .unwrap();
    for index in 0..3 {
        let locator = RuntimeLocator::new(
            AgentRuntimeKind::Terminal,
            "claude",
            format!("durable-{index}"),
        );
        let live = format!("term-{index}");
        coordinator.register_initial(locator, &live);
        coordinator
            .execute(
                AgentRestart {
                    request_id: format!("bounded-r{index}"),
                    provider: "claude".to_string(),
                    session_id: format!("durable-{index}"),
                    kind: AgentRuntimeKind::Terminal,
                    live_id: live,
                    expected_generation: 1,
                },
                &FakeRuntime::resumable("replacement"),
            )
            .await;
    }

    assert_eq!(coordinator.retained_result_count(), 2);
    assert!(coordinator.retained_lock_counts().0 <= 2);
    assert!(coordinator.retained_lock_counts().1 <= 2);
    drop(coordinator);

    let reopened =
        RestartCoordinator::new_persistent_with_limits(path, 2, 2, RestartIngressLimits::default())
            .unwrap();
    assert_eq!(reopened.retained_result_count(), 2);
    let runtime = FakeRuntime::resumable("must-not-run");
    let replay = reopened
        .execute(
            AgentRestart {
                request_id: "bounded-r2".to_string(),
                provider: "claude".to_string(),
                session_id: "durable-2".to_string(),
                kind: AgentRuntimeKind::Terminal,
                live_id: "term-2".to_string(),
                expected_generation: 1,
            },
            &runtime,
        )
        .await;
    assert!(replay.replayed);
    assert_eq!(runtime.shutdowns.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn unique_invalid_restart_requests_cannot_grow_the_durable_journal_without_bound() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("bounded-invalid-restart-state.json");
    let coordinator = RestartCoordinator::new_persistent_with_limits(
        path.clone(),
        3,
        2,
        RestartIngressLimits::default(),
    )
    .unwrap();

    for index in 0..20 {
        let outcome = coordinator
            .execute(
                AgentRestart {
                    request_id: format!("invalid-r{index}"),
                    provider: "claude".to_string(),
                    session_id: format!("missing-{index}"),
                    kind: AgentRuntimeKind::Terminal,
                    live_id: format!("missing-runtime-{index}"),
                    expected_generation: 1,
                },
                &FakeRuntime::resumable("must-not-run"),
            )
            .await;
        assert!(matches!(
            outcome.messages.as_slice(),
            [ServerMessage::AgentRestartFailed(failed)]
                if failed.code == AgentRestartFailureCode::RuntimeNotFound
        ));
    }

    assert_eq!(coordinator.retained_result_count(), 3);
    let journal: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(journal["results"].as_array().unwrap().len(), 3);
    drop(coordinator);

    let reopened =
        RestartCoordinator::new_persistent_with_limits(path, 3, 2, RestartIngressLimits::default())
            .unwrap();
    let replay = reopened
        .execute(
            AgentRestart {
                request_id: "invalid-r19".to_string(),
                provider: "claude".to_string(),
                session_id: "missing-19".to_string(),
                kind: AgentRuntimeKind::Terminal,
                live_id: "missing-runtime-19".to_string(),
                expected_generation: 1,
            },
            &FakeRuntime::resumable("must-not-run"),
        )
        .await;
    assert!(replay.replayed);
    assert!(matches!(
        replay.messages.as_slice(),
        [ServerMessage::AgentRestartFailed(failed)]
            if failed.code == AgentRestartFailureCode::RuntimeNotFound
    ));
}

// ---------------------------------------------------------------------------
// Bounded restart ingress (fix 6). Every bound — field byte caps, the durable
// pending-row cap, the per-session queue cap, and the global in-flight cap —
// is enforced BEFORE any task spawns or lock is allocated, overload returns a
// typed `OVERLOADED` failure frame, and correlated client resends of one
// request id bypass admission entirely (LB-03) so they can never overload a
// healthy restart.
// ---------------------------------------------------------------------------

/// A 300-byte `sessionId` (field cap is 256) is refused at the WS door with
/// `OVERLOADED` echoing the request's runtime descriptor — before any spawn,
/// any lock, or any started frame.
#[tokio::test]
async fn oversized_restart_field_is_rejected_at_the_door_without_spawning() {
    let (url, registry, state) = common::spawn_server_with_specs_and_state(vec![]).await;
    let runtime = Arc::new(FakeRuntime::resumable("must-not-run"));
    let _runtime_registration = state.restart.set_runtime(runtime.clone());
    state.restart.register_initial(locator(), "term-oversized");
    let (mut ws, _) = common::connect_and_capture_inventory_with_capabilities(
        &url,
        Some(serde_json::json!({ "agentRestartV1": true })),
    )
    .await;

    let oversized = AgentRestart {
        request_id: "oversized-r1".to_string(),
        provider: "claude".to_string(),
        session_id: "x".repeat(300),
        kind: AgentRuntimeKind::Terminal,
        live_id: "term-oversized".to_string(),
        expected_generation: 1,
    };
    ws.send(WsMessage::Text(
        serde_json::to_string(&ClientMessage::AgentRestart(oversized)).unwrap(),
    ))
    .await
    .unwrap();

    let failed = next_restart_failed_for(&mut ws, "oversized-r1").await;
    assert_eq!(failed["code"], "OVERLOADED");
    assert_eq!(failed["retryable"], false);
    assert_eq!(failed["recoveryPending"], false);
    // The failure frame mirrors the capability-rejection descriptor fill.
    assert_eq!(failed["runtimeId"], "term-oversized");
    assert_eq!(failed["generation"], 1);

    let started = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        common::next_frame_of_type(&mut ws, "agent.restart.started"),
    )
    .await;
    assert!(
        started.is_err(),
        "no agent.restart.started may arrive for a door-rejected request: {started:?}"
    );
    assert_eq!(
        state.restart.in_flight_transaction_count(),
        0,
        "the oversized request never registered a transaction"
    );
    assert_eq!(runtime.shutdowns.load(Ordering::SeqCst), 0);
    registry.kill_all();
}

/// The durable pending-row cap is a limits-ctor knob: with the cap clamped to
/// one and one row already seeded, a new DISTINCT request is refused
/// (retryable) without the journal's `pendingRecoveries` changing on disk.
#[tokio::test]
async fn pending_row_cap_rejects_new_restart_without_touching_the_journal() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("pending-cap-restart-state.json");
    let coordinator = RestartCoordinator::new_persistent_with_limits(
        path.clone(),
        8,
        8,
        RestartIngressLimits {
            pending_recoveries: 1,
            ..RestartIngressLimits::default()
        },
    )
    .unwrap();
    coordinator.register_initial(locator(), "term-seed");
    // Seed one durable pending row (retryable retirement failure).
    let seeded = coordinator
        .execute(
            restart("pending-cap-seed", "term-seed", 1),
            &RetirementRetries {
                shutdowns: AtomicUsize::new(0),
            },
        )
        .await;
    assert!(
        matches!(
            seeded.messages.last(),
            Some(ServerMessage::AgentRestartFailed(failed)) if failed.retryable && failed.recovery_pending
        ),
        "the seed transaction must leave a retained pending row: {:?}",
        seeded.messages
    );
    assert_eq!(coordinator.pending_recoveries().len(), 1);
    let journal_before = std::fs::read(&path).unwrap();

    let failure = coordinator
        .try_admit_restart(&AgentRestart {
            request_id: "pending-cap-new".to_string(),
            provider: "claude".to_string(),
            session_id: "durable-other".to_string(),
            kind: AgentRuntimeKind::Terminal,
            live_id: "term-other".to_string(),
            expected_generation: 1,
        })
        .expect_err("the pending-row cap must reject a new distinct request");
    assert_eq!(failure.code, AgentRestartFailureCode::Overloaded);
    assert!(
        failure.retryable,
        "a full journal is transient for a later retry"
    );
    assert_eq!(
        coordinator.pending_recoveries().len(),
        1,
        "the refused request never owns a pending row"
    );
    assert_eq!(
        std::fs::read(&path).unwrap(),
        journal_before,
        "the refused request left the on-disk journal untouched"
    );
}

/// Five DISTINCT new request ids for one durable session arrive while the
/// retirement machinery is gated: the default per-session queue cap (4)
/// admits the first four and refuses the fifth at the door with `OVERLOADED`
/// before any spawn for it; once the gate opens the admitted four drain to
/// completion (the owner runs the one retirement; the other three adopt the
/// owner's durable result under their own request ids).
#[tokio::test]
async fn per_session_queue_cap_rejects_excess_queued_restarts() {
    let (url, registry, state) = common::spawn_server_with_specs_and_state(vec![]).await;
    let runtime = Arc::new(GatedSharedRuntime {
        entered: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
        shutdowns: AtomicUsize::new(0),
    });
    let _runtime_registration = state.restart.set_runtime(runtime.clone());
    state.restart.register_initial(locator(), "term-queued");
    let (mut ws, _) = common::connect_and_capture_inventory_with_capabilities(
        &url,
        Some(serde_json::json!({ "agentRestartV1": true })),
    )
    .await;

    for index in 1..=5 {
        ws.send(WsMessage::Text(
            serde_json::to_string(&ClientMessage::AgentRestart(restart(
                &format!("queued-r{index}"),
                "term-queued",
                1,
            )))
            .unwrap(),
        ))
        .await
        .unwrap();
    }

    // The fifth arrival is refused while the admitted four hold every per-slot.
    let failed = next_restart_failed_for(&mut ws, "queued-r5").await;
    assert_eq!(failed["code"], "OVERLOADED");
    assert_eq!(failed["retryable"], true);
    assert_eq!(
        state.restart.in_flight_transaction_count(),
        4,
        "exactly the four admitted requests are registered"
    );

    runtime.release.notify_waiters();
    let mut started = 0usize;
    let mut replaced = 0usize;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    while replaced < 4 {
        let message = tokio::time::timeout_at(deadline, ws.next())
            .await
            .expect("the four admitted restarts drain after the gate opens")
            .expect("websocket stays connected")
            .expect("websocket frame");
        let WsMessage::Text(text) = message else {
            continue;
        };
        let frame: serde_json::Value = serde_json::from_str(&text).expect("json frame");
        match frame["type"].as_str() {
            Some("agent.restart.started") => {
                assert_eq!(frame["requestId"], "queued-r1");
                started += 1;
            }
            Some("agent.restart.replaced") => {
                let request_id = frame["requestId"].as_str().unwrap();
                assert!(
                    (1..=4).any(|index| request_id == format!("queued-r{index}")),
                    "only admitted requests may complete: {frame}"
                );
                replaced += 1;
            }
            Some("agent.restart.failed") => {
                panic!("no admitted arrival may fail after the gate opens: {frame}");
            }
            _ => {}
        }
    }
    assert_eq!(started, 1, "one owner transaction ran");
    assert_eq!(replaced, 4, "all four admitted requests completed");
    assert_eq!(runtime.shutdowns.load(Ordering::SeqCst), 1);
    assert_eq!(
        state.restart.in_flight_transaction_count(),
        0,
        "every admission drain released its registration"
    );
    registry.kill_all();
}

/// The global in-flight cap is a limits-ctor knob: with one slot and a gated
/// transaction holding it, a second distinct request (another session, so the
/// per-session cap cannot be the limiter) is refused retryable; draining the
/// first frees the slot for a later admission.
#[tokio::test]
async fn global_in_flight_cap_rejects_overload() {
    let coordinator = RestartCoordinator::new_with_limits(
        8,
        8,
        RestartIngressLimits {
            in_flight: 1,
            ..RestartIngressLimits::default()
        },
    );
    coordinator.register_initial(locator(), "term-global");
    let runtime = Arc::new(GatedSharedRuntime {
        entered: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
        shutdowns: AtomicUsize::new(0),
    });
    let _registration = coordinator.set_runtime(runtime.clone());

    let first = restart("global-r1", "term-global", 1);
    let guard = coordinator
        .try_admit_restart(&first)
        .expect("the first admission fits the global cap");
    let accepted = coordinator
        .spawn_registered(first, Some(guard), |_| {})
        .await;
    assert!(accepted);
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        runtime.entered.notified(),
    )
    .await
    .expect("the first transaction parked inside preflight holding the one slot");

    let second = AgentRestart {
        request_id: "global-r2".to_string(),
        provider: "claude".to_string(),
        session_id: "durable-other".to_string(),
        kind: AgentRuntimeKind::Terminal,
        live_id: "term-other".to_string(),
        expected_generation: 1,
    };
    coordinator.register_initial(
        RuntimeLocator::new(AgentRuntimeKind::Terminal, "claude", "durable-other"),
        "term-other",
    );
    let failure = coordinator
        .try_admit_restart(&second)
        .expect_err("the single global in-flight slot is taken");
    assert_eq!(failure.code, AgentRestartFailureCode::Overloaded);
    assert!(failure.retryable);

    runtime.release.notify_waiters();
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        coordinator.join_in_flight_transactions(),
    )
    .await
    .expect("the gated transaction drains once un-gated");
    coordinator
        .try_admit_restart(&second)
        .expect("the released global slot admits a new request");
}

/// LB-03 anti-regression pin: the shipped client resends the SAME request id
/// on a backoff loop, so six arrivals of one request id through a gated
/// retirement must NEVER be Overloaded — every resend is known (in-flight
/// id, durable row, or stored result) and bypasses admission, and each one
/// replays/receives the one transaction's terminal result.
#[tokio::test]
async fn correlated_resends_of_one_request_bypass_admission_and_never_overload() {
    let (url, registry, state) = common::spawn_server_with_specs_and_state(vec![]).await;
    let runtime = Arc::new(GatedSharedRuntime {
        entered: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
        shutdowns: AtomicUsize::new(0),
    });
    let _runtime_registration = state.restart.set_runtime(runtime.clone());
    state.restart.register_initial(locator(), "term-resend");
    let (mut ws, _) = common::connect_and_capture_inventory_with_capabilities(
        &url,
        Some(serde_json::json!({ "agentRestartV1": true })),
    )
    .await;

    for _ in 0..6 {
        ws.send(WsMessage::Text(
            serde_json::to_string(&ClientMessage::AgentRestart(restart(
                "resend-r1",
                "term-resend",
                1,
            )))
            .unwrap(),
        ))
        .await
        .unwrap();
    }
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        runtime.entered.notified(),
    )
    .await
    .expect("the first arrival parked inside preflight");
    assert_eq!(
        state.restart.in_flight_transaction_count(),
        1,
        "six arrivals of ONE request id register one distinct in-flight request"
    );

    runtime.release.notify_waiters();
    let mut started = 0usize;
    let mut replaced = 0usize;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    while replaced < 6 {
        let message = tokio::time::timeout_at(deadline, ws.next())
            .await
            .expect("the owner and five resends all settle after the gate opens")
            .expect("websocket stays connected")
            .expect("websocket frame");
        let WsMessage::Text(text) = message else {
            continue;
        };
        let frame: serde_json::Value = serde_json::from_str(&text).expect("json frame");
        if frame["requestId"] != "resend-r1" {
            continue;
        }
        match frame["type"].as_str() {
            Some("agent.restart.started") => started += 1,
            Some("agent.restart.replaced") => replaced += 1,
            Some("agent.restart.failed") => {
                panic!("a correlated resend must never fail — least of all OVERLOADED: {frame}")
            }
            _ => {}
        }
    }
    assert_eq!(started, 1, "exactly one transaction started");
    assert_eq!(replaced, 6, "every arrival received the terminal result");
    assert_eq!(runtime.shutdowns.load(Ordering::SeqCst), 1);
    registry.kill_all();
}

struct RecoveryMustNotSpawn {
    attempts: AtomicUsize,
}

#[async_trait::async_trait]
impl RestartRuntime for RecoveryMustNotSpawn {
    type ResumePlan = ();

    async fn preflight(&self, _request: &AgentRestart) -> Result<(), RestartFailure> {
        panic!("an already registered replacement must be adopted before recovery preflight")
    }

    async fn shutdown_for_restart(
        &self,
        _request: &AgentRestart,
        _plan: &(),
    ) -> Result<(), RestartFailure> {
        panic!("the retired runtime must not be shut down twice")
    }

    async fn create_replacement(
        &self,
        _request: &AgentRestart,
        _plan: (),
    ) -> Result<String, RestartFailure> {
        self.attempts.fetch_add(1, Ordering::SeqCst);
        panic!("an already registered replacement must not be spawned twice")
    }

    async fn recover_replacement(
        &self,
        _request: &AgentRestart,
        _context: Option<&RestartResumeContext>,
    ) -> Result<String, RestartFailure> {
        self.attempts.fetch_add(1, Ordering::SeqCst);
        panic!("an already registered replacement must not be spawned twice")
    }
}

struct ReplacementBreaksDurableCommit {
    coordinator: RestartCoordinator,
    persistence_path: std::path::PathBuf,
    creates: AtomicUsize,
}

#[async_trait::async_trait]
impl RestartRuntime for ReplacementBreaksDurableCommit {
    type ResumePlan = ();

    async fn preflight(&self, _request: &AgentRestart) -> Result<(), RestartFailure> {
        Ok(())
    }

    async fn shutdown_for_restart(
        &self,
        _request: &AgentRestart,
        _plan: &(),
    ) -> Result<(), RestartFailure> {
        Ok(())
    }

    async fn create_replacement(
        &self,
        _request: &AgentRestart,
        _plan: (),
    ) -> Result<String, RestartFailure> {
        self.creates.fetch_add(1, Ordering::SeqCst);
        std::fs::remove_file(&self.persistence_path).unwrap();
        std::fs::create_dir(&self.persistence_path).unwrap();
        self.coordinator
            .register_initial(locator(), "term-ambiguous-success");
        Ok("term-ambiguous-success".to_string())
    }
}

#[tokio::test]
async fn pending_retry_adopts_registered_replacement_after_ambiguous_durable_commit() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("restart-state.json");
    let coordinator = RestartCoordinator::new_persistent(path.clone()).unwrap();
    coordinator.register_initial(locator(), "term-1");
    let request = restart("ambiguous-r1", "term-1", 1);
    let first_runtime = ReplacementBreaksDurableCommit {
        coordinator: coordinator.clone(),
        persistence_path: path.clone(),
        creates: AtomicUsize::new(0),
    };

    let first = coordinator.execute(request.clone(), &first_runtime).await;
    assert!(matches!(
        first.messages.last(),
        Some(ServerMessage::AgentRestartFailed(message)) if message.retryable
    ));
    assert_eq!(first_runtime.creates.load(Ordering::SeqCst), 1);
    assert_eq!(
        coordinator.runtime_for_locator(&locator()),
        Some(RuntimeDescriptor {
            runtime_id: "term-ambiguous-success".to_string(),
            generation: 2,
        })
    );

    std::fs::remove_dir(&path).unwrap();
    let retry_runtime = RecoveryMustNotSpawn {
        attempts: AtomicUsize::new(0),
    };
    let retry = coordinator.execute(request.clone(), &retry_runtime).await;

    assert!(matches!(
        retry.messages.last(),
        Some(ServerMessage::AgentRestartReplaced(message))
            if message.runtime.runtime_id == "term-ambiguous-success"
                && message.runtime.generation == 2
    ));
    assert_eq!(retry_runtime.attempts.load(Ordering::SeqCst), 0);
    assert!(coordinator.pending_recoveries().is_empty());

    let replay = coordinator.execute(request, &retry_runtime).await;
    assert!(replay.replayed);
    assert_eq!(retry_runtime.attempts.load(Ordering::SeqCst), 0);
}

struct DurableSpawnFenceRuntime {
    persistence_path: std::path::PathBuf,
    ambiguous_writer_alive: Arc<AtomicBool>,
    quiesces: Arc<AtomicUsize>,
}

#[async_trait::async_trait]
impl RestartRuntime for DurableSpawnFenceRuntime {
    type ResumePlan = ();

    async fn preflight(&self, _request: &AgentRestart) -> Result<(), RestartFailure> {
        Ok(())
    }

    async fn shutdown_for_restart(
        &self,
        _request: &AgentRestart,
        _plan: &(),
    ) -> Result<(), RestartFailure> {
        Ok(())
    }

    async fn create_replacement(
        &self,
        _request: &AgentRestart,
        _plan: (),
    ) -> Result<String, RestartFailure> {
        panic!("fenced adapters must never use the unfenced spawn seam")
    }

    fn requires_replacement_fence(&self) -> bool {
        true
    }

    async fn create_replacement_fenced(
        &self,
        _request: &AgentRestart,
        _plan: (),
        fence: Option<&RestartReplacementFence>,
    ) -> Result<String, RestartFailure> {
        let fence = fence.expect("replacement fence must precede spawn");
        let journal: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&self.persistence_path).unwrap()).unwrap();
        assert!(journal["pendingRecoveries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|pending| pending["replacement_fence"]["ownershipId"] == fence.ownership_id));
        self.ambiguous_writer_alive.store(true, Ordering::SeqCst);
        Err(RestartFailure::new(
            AgentRestartFailureCode::ReplacementFailed,
            "simulated crash-ambiguous spawn",
            true,
        ))
    }

    async fn recover_ambiguous_replacement(
        &self,
        _request: &AgentRestart,
        _context: Option<&RestartResumeContext>,
        _fence: &RestartReplacementFence,
    ) -> Result<(), RestartFailure> {
        assert!(
            self.ambiguous_writer_alive.swap(false, Ordering::SeqCst),
            "recovery must observe the ambiguous writer"
        );
        self.quiesces.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    async fn recover_replacement(
        &self,
        _request: &AgentRestart,
        _context: Option<&RestartResumeContext>,
    ) -> Result<String, RestartFailure> {
        panic!("fenced adapters must never use the unfenced recovery seam")
    }

    async fn recover_replacement_fenced(
        &self,
        _request: &AgentRestart,
        _context: Option<&RestartResumeContext>,
        fence: Option<&RestartReplacementFence>,
    ) -> Result<String, RestartFailure> {
        assert!(fence.is_some());
        assert!(
            !self.ambiguous_writer_alive.load(Ordering::SeqCst),
            "a second writer must not spawn until ambiguous ownership is quiescent"
        );
        Ok("term-after-fenced-recovery".to_string())
    }
}

#[tokio::test]
async fn persisted_spawn_fence_quiesces_ambiguous_writer_before_boot_retry() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("restart-state.json");
    let ambiguous_writer_alive = Arc::new(AtomicBool::new(false));
    let quiesces = Arc::new(AtomicUsize::new(0));
    let request = restart("spawn-fence-r1", "term-1", 1);

    let coordinator = RestartCoordinator::new_persistent(path.clone()).unwrap();
    coordinator.register_initial(locator(), "term-1");
    let first_runtime = DurableSpawnFenceRuntime {
        persistence_path: path.clone(),
        ambiguous_writer_alive: Arc::clone(&ambiguous_writer_alive),
        quiesces: Arc::clone(&quiesces),
    };
    let first = coordinator.execute(request.clone(), &first_runtime).await;
    assert!(matches!(
        first.messages.last(),
        Some(ServerMessage::AgentRestartFailed(failed))
            if failed.retryable && failed.recovery_pending
    ));
    assert!(ambiguous_writer_alive.load(Ordering::SeqCst));
    drop(coordinator);

    let reopened = RestartCoordinator::new_persistent(path.clone()).unwrap();
    let recovery_runtime = DurableSpawnFenceRuntime {
        persistence_path: path,
        ambiguous_writer_alive: Arc::clone(&ambiguous_writer_alive),
        quiesces: Arc::clone(&quiesces),
    };
    let recovered = reopened.execute(request, &recovery_runtime).await;

    assert!(matches!(
        recovered.messages.last(),
        Some(ServerMessage::AgentRestartReplaced(replaced))
            if replaced.runtime.runtime_id == "term-after-fenced-recovery"
    ));
    assert!(!ambiguous_writer_alive.load(Ordering::SeqCst));
    assert_eq!(quiesces.load(Ordering::SeqCst), 1);
}

#[test]
fn coordinator_bounds_runtime_identity_and_generation_retention() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("bounded-ownership-state.json");
    let coordinator = RestartCoordinator::new_persistent_with_limits(
        path.clone(),
        2,
        2,
        RestartIngressLimits::default(),
    )
    .unwrap();

    for index in 0..8 {
        let locator = RuntimeLocator::new(
            AgentRuntimeKind::FreshAgent,
            "claude",
            format!("durable-{index}"),
        );
        let descriptor = coordinator.register_initial(locator, format!("fresh-{index}"));
        let mut created = ServerMessage::FreshAgentCreated(FreshAgentCreated {
            provider: "claude".to_string(),
            request_id: format!("create-{index}"),
            runtime_provider: "claude".to_string(),
            session_id: format!("alias-{index}"),
            session_type: "freshclaude".to_string(),
            session_ref: Some(SessionLocator {
                provider: "claude".to_string(),
                session_id: format!("durable-{index}"),
            }),
            runtime: Some(descriptor),
        });
        coordinator.observe_server_message(&mut created);
    }

    let counts = coordinator.retained_ownership_counts();
    // Fix 8: live descriptors are PINNED while their runtime is registered —
    // capacity pruning applies ONLY to the retired descriptor window. All
    // eight registrations above are still live (none retired/unpinned), so
    // the live store holds all eight; the retired window stays bounded.
    assert_eq!(counts.descriptors, 8, "{counts:?}");
    assert!(counts.retired_descriptors <= 2, "{counts:?}");
    assert!(counts.live_locators <= 2, "{counts:?}");
    assert!(counts.current_locators <= 2, "{counts:?}");
    assert!(counts.fresh_aliases <= 2, "{counts:?}");
    assert!(counts.generation_high_waters <= 2, "{counts:?}");
    drop(coordinator);

    let reopened =
        RestartCoordinator::new_persistent_with_limits(path, 2, 2, RestartIngressLimits::default())
            .unwrap();
    assert!(reopened.retained_ownership_counts().generation_high_waters <= 2);
}

#[tokio::test]
async fn retired_descriptor_fences_late_frames_only_for_the_bounded_window() {
    let coordinator = RestartCoordinator::new_with_limits(2, 2, RestartIngressLimits::default());
    let old = coordinator.register_initial(locator(), "term-old");
    coordinator
        .execute(
            restart("bounded-fence", "term-old", old.generation),
            &FakeRuntime::resumable("term-new"),
        )
        .await;
    assert_eq!(
        coordinator.runtime_for_live(AgentRuntimeKind::Terminal, "term-old"),
        Some(old)
    );

    coordinator.register_live(AgentRuntimeKind::Terminal, "unrelated");

    assert_eq!(
        coordinator.runtime_for_live(AgentRuntimeKind::Terminal, "term-old"),
        None,
        "the oldest retired fence is eventually evicted instead of leaking forever"
    );
}

/// Fix 8: a LIVE descriptor is pinned separately from the bounded retired
/// window. Once more than 1,024 register/retire transitions churn through the
/// coordinator, an ACTIVE terminal pane's descriptor must still be found —
/// otherwise `observe_server_message` leaves `runtime: None` and the contract
/// gate black-holes every output/exit frame for that pane.
#[tokio::test]
async fn live_descriptor_survives_more_than_1024_retired_transitions_and_output_is_delivered() {
    let coordinator =
        RestartCoordinator::new_with_limits(1_024, 1_024, RestartIngressLimits::default());
    // One long-lived ACTIVE terminal runtime: this is the pane whose output
    // must never fall out of the enrichment path.
    let live = coordinator.register_live(AgentRuntimeKind::Terminal, "term-live-target");

    // 1,100 full register->retire cycles for OTHER ids through the
    // coordinator's real registration/retirement seams. Each cycle admits the
    // retired predecessor and its live replacement, so the descriptor window
    // overflows 1,024 several times over.
    for index in 0..1_100usize {
        let session_id = format!("churn-session-{index}");
        let old_id = format!("term-churn-{index}-old");
        let new_id: &'static str = Box::leak(format!("term-churn-{index}-new").into_boxed_str());
        let old = coordinator.register_initial(
            RuntimeLocator::new(AgentRuntimeKind::Terminal, "churn", &session_id),
            old_id.clone(),
        );
        coordinator
            .execute(
                AgentRestart {
                    request_id: format!("churn-restart-{index}"),
                    provider: "churn".to_string(),
                    session_id,
                    kind: AgentRuntimeKind::Terminal,
                    live_id: old_id,
                    expected_generation: old.generation,
                },
                &FakeRuntime::resumable(new_id),
            )
            .await;
    }

    // The ACTIVE pane's descriptor survived the churn: enrichment fills the
    // frame and the contract gate passes it for delivery.
    assert_eq!(
        coordinator.runtime_for_live(AgentRuntimeKind::Terminal, "term-live-target"),
        Some(live.clone()),
        "a live runtime's descriptor must be pinned apart from the retired window"
    );
    let mut output = ServerMessage::TerminalOutput(TerminalOutput {
        terminal_id: "term-live-target".to_string(),
        stream_id: "stream-live".to_string(),
        data: "still alive".to_string(),
        seq_start: 0,
        seq_end: 1,
        attach_request_id: None,
        source: None,
        runtime: None,
    });
    coordinator.observe_server_message(&mut output);
    let ServerMessage::TerminalOutput(output) = &output else {
        unreachable!()
    };
    assert_eq!(
        output.runtime,
        Some(live),
        "the enrichment path must fill the live runtime even after >1,024 retired transitions"
    );
    assert!(
        RestartCoordinator::restart_runtime_contract_satisfied(&ServerMessage::TerminalOutput(
            output.clone()
        )),
        "the contract gate must pass the enriched output frame"
    );

    // The retired HALF still rides the bounded 1,024 FIFO: the oldest
    // retired generations are evicted (no leak), recent retirements still
    // fence late frames.
    assert_eq!(
        coordinator.runtime_for_live(AgentRuntimeKind::Terminal, "term-churn-0-old"),
        None,
        "the bounded retired window evicts its oldest entries instead of leaking"
    );
    assert_eq!(
        coordinator.runtime_for_live(AgentRuntimeKind::Terminal, "term-churn-1090-old"),
        Some(RuntimeDescriptor {
            runtime_id: "term-churn-1090-old".to_string(),
            generation: 1,
        }),
        "a recently retired descriptor still fences its late frames"
    );
}

/// Fix 8: a PTY exit is the terminal identity's final retirement — the exit
/// hook must MOVE its descriptor into the bounded retired store (late frames
/// still fenced) instead of pinning the live store forever.
#[tokio::test]
async fn pty_exit_unpins_descriptor_into_the_bounded_retired_store() {
    let (url, registry, mut state) =
        common::spawn_server_with_specs_and_state(vec![common::sleeper_cli_spec("amplifier")])
            .await;
    state.session_existence = Arc::new(PresentSessions);
    let _runtime_registration = state.restart.set_runtime(Arc::new(
        freshell_ws::restart::ProductionRestartRuntime::new(state.clone()),
    ));
    let (mut ws, _) = common::connect_and_capture_inventory_with_capabilities(
        &url,
        Some(serde_json::json!({ "agentRestartV1": true })),
    )
    .await;

    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.create",
            "requestId": "unpin-create",
            "mode": "amplifier",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
        })
        .to_string(),
    ))
    .await
    .unwrap();
    let created = common::next_frame_of_type(&mut ws, "terminal.created").await;
    let terminal_id = created["terminalId"].as_str().unwrap().to_string();
    let session_id = created["sessionRef"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    let generation = created["runtime"]["generation"].as_u64().unwrap();

    ws.send(WsMessage::Text(
        serde_json::to_string(&ClientMessage::AgentRestart(AgentRestart {
            request_id: "unpin-restart".to_string(),
            provider: "amplifier".to_string(),
            session_id,
            kind: AgentRuntimeKind::Terminal,
            live_id: terminal_id.clone(),
            expected_generation: generation,
        }))
        .unwrap(),
    ))
    .await
    .unwrap();
    common::next_frame_of_type(&mut ws, "agent.restart.started").await;
    let replaced = common::next_frame_of_type(&mut ws, "agent.restart.replaced").await;
    let replacement_id = replaced["runtimeId"].as_str().unwrap().to_string();
    let replacement_generation = replaced["generation"].as_u64().unwrap();
    assert!(registry.is_live(&replacement_id));

    // Kill the replacement PTY: its exit hook retires the descriptor.
    registry.kill(&replacement_id);

    // Once the exit hook ran, neither generation may still be pinned in the
    // live descriptor store: the original was retired by the restart itself
    // and the replacement was retired by its observed exit.
    let mut drained = None;
    for _ in 0..100 {
        let counts = state.restart.retained_ownership_counts();
        if counts.descriptors == 0 {
            drained = Some(counts);
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let counts = drained.expect(
        "PTY exit must unpin the descriptor from the live store instead of pinning it forever",
    );
    assert_eq!(counts.descriptors, 0, "{counts:?}");

    // Late in-flight frames for the exited PTY stay fenced by its retired
    // descriptor: enrichment still fills `runtime` and the contract gate
    // still passes the frame.
    let mut late = ServerMessage::TerminalOutput(TerminalOutput {
        terminal_id: replacement_id.clone(),
        stream_id: "stream-exited".to_string(),
        data: "late".to_string(),
        seq_start: 0,
        seq_end: 1,
        attach_request_id: None,
        source: None,
        runtime: None,
    });
    state.restart.observe_server_message(&mut late);
    let ServerMessage::TerminalOutput(late) = &late else {
        unreachable!()
    };
    assert_eq!(
        late.runtime,
        Some(RuntimeDescriptor {
            runtime_id: replacement_id,
            generation: replacement_generation,
        }),
        "a late frame for the exited PTY is still fenced by the retired descriptor"
    );
    assert!(RestartCoordinator::restart_runtime_contract_satisfied(
        &ServerMessage::TerminalOutput(late.clone())
    ));
    registry.kill_all();
}

struct ContextRecoveryRuntime {
    expected_cwd: String,
}

#[async_trait::async_trait]
impl RestartRuntime for ContextRecoveryRuntime {
    type ResumePlan = ();

    async fn preflight(&self, _request: &AgentRestart) -> Result<(), RestartFailure> {
        Ok(())
    }

    async fn shutdown_for_restart(
        &self,
        _request: &AgentRestart,
        _plan: &(),
    ) -> Result<(), RestartFailure> {
        Ok(())
    }

    async fn create_replacement(
        &self,
        _request: &AgentRestart,
        _plan: (),
    ) -> Result<String, RestartFailure> {
        Err(RestartFailure::new(
            AgentRestartFailureCode::ReplacementFailed,
            "restart server before replacement",
            true,
        ))
    }

    fn persisted_resume_context(
        &self,
        _request: &AgentRestart,
        _plan: &(),
    ) -> Option<RestartResumeContext> {
        Some(RestartResumeContext {
            terminal_cwd: Some(self.expected_cwd.clone()),
            ..RestartResumeContext::default()
        })
    }

    async fn recover_replacement(
        &self,
        _request: &AgentRestart,
        context: Option<&RestartResumeContext>,
    ) -> Result<String, RestartFailure> {
        assert_eq!(
            context.and_then(|context| context.terminal_cwd.as_deref()),
            Some(self.expected_cwd.as_str())
        );
        Ok("term-context-recovered".to_string())
    }
}

#[tokio::test]
async fn terminal_resume_context_survives_boot_recovery() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("restart-state.json");
    let request = restart("context-r1", "term-1", 1);
    let runtime = ContextRecoveryRuntime {
        expected_cwd: "/workspace/project".to_string(),
    };
    let coordinator = RestartCoordinator::new_persistent(path.clone()).unwrap();
    coordinator.register_initial(locator(), "term-1");
    coordinator.execute(request.clone(), &runtime).await;
    drop(coordinator);

    let reopened = RestartCoordinator::new_persistent(path).unwrap();
    let recovered = reopened.execute(request, &runtime).await;

    assert!(matches!(
        recovered.messages.last(),
        Some(ServerMessage::AgentRestartReplaced(message))
            if message.runtime.runtime_id == "term-context-recovered"
    ));
}

#[tokio::test]
async fn production_boot_recovery_recreates_terminal_with_persisted_cwd() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("restart-state.json");
    let cwd = temp.path().join("restored-working-directory");
    std::fs::create_dir(&cwd).unwrap();
    let locator = RuntimeLocator::new(AgentRuntimeKind::Terminal, "amplifier", "durable-context");
    let request = AgentRestart {
        request_id: "production-context-r1".to_string(),
        provider: "amplifier".to_string(),
        session_id: "durable-context".to_string(),
        kind: AgentRuntimeKind::Terminal,
        live_id: "term-context-old".to_string(),
        expected_generation: 1,
    };
    let failing = ContextRecoveryRuntime {
        expected_cwd: cwd.to_string_lossy().into_owned(),
    };
    let coordinator = RestartCoordinator::new_persistent(path.clone()).unwrap();
    coordinator.register_initial(locator, &request.live_id);
    coordinator.execute(request.clone(), &failing).await;
    drop(coordinator);

    let (_url, registry, mut state) =
        common::spawn_server_with_specs_and_state(vec![common::sleeper_cli_spec("amplifier")])
            .await;
    state.session_existence = Arc::new(PresentSessions);
    let reopened = RestartCoordinator::new_persistent(path).unwrap();
    let production = freshell_ws::restart::ProductionRestartRuntime::new(state);
    let recovered = reopened.execute(request, &production).await;
    let ServerMessage::AgentRestartReplaced(replaced) =
        recovered.messages.last().expect("terminal result")
    else {
        panic!("expected production replacement: {:?}", recovered.messages)
    };
    let probe = registry
        .probe(&replaced.runtime.runtime_id)
        .expect("replacement terminal is live");
    assert_eq!(probe.cwd.as_deref(), cwd.to_str());
    registry.kill_all();
}

struct ConcurrentRuntime {
    entered: Arc<tokio::sync::Barrier>,
    replacement: &'static str,
}

#[async_trait::async_trait]
impl RestartRuntime for ConcurrentRuntime {
    type ResumePlan = ();

    async fn preflight(&self, _request: &AgentRestart) -> Result<(), RestartFailure> {
        self.entered.wait().await;
        Ok(())
    }

    async fn shutdown_for_restart(
        &self,
        _request: &AgentRestart,
        _plan: &(),
    ) -> Result<(), RestartFailure> {
        Ok(())
    }

    async fn create_replacement(
        &self,
        _request: &AgentRestart,
        _plan: (),
    ) -> Result<String, RestartFailure> {
        Ok(self.replacement.to_string())
    }
}

struct GatedSharedRuntime {
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
    shutdowns: AtomicUsize,
}

struct RetryThenRecoverSharedRuntime {
    shutdowns: AtomicUsize,
    replacements: AtomicUsize,
}

#[async_trait::async_trait]
impl RestartRuntime for RetryThenRecoverSharedRuntime {
    type ResumePlan = ();

    async fn preflight(&self, _request: &AgentRestart) -> Result<(), RestartFailure> {
        Ok(())
    }

    async fn shutdown_for_restart(
        &self,
        _request: &AgentRestart,
        _plan: &(),
    ) -> Result<(), RestartFailure> {
        self.shutdowns.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    async fn create_replacement(
        &self,
        _request: &AgentRestart,
        _plan: (),
    ) -> Result<String, RestartFailure> {
        if self.replacements.fetch_add(1, Ordering::SeqCst) == 0 {
            Err(RestartFailure::new(
                AgentRestartFailureCode::ReplacementFailed,
                "first replacement attempt failed",
                true,
            ))
        } else {
            Ok("term-shared-recovered".to_string())
        }
    }
}

#[async_trait::async_trait]
impl RestartRuntime for GatedSharedRuntime {
    type ResumePlan = ();

    async fn preflight(&self, _request: &AgentRestart) -> Result<(), RestartFailure> {
        self.entered.notify_one();
        self.release.notified().await;
        Ok(())
    }

    async fn shutdown_for_restart(
        &self,
        _request: &AgentRestart,
        _plan: &(),
    ) -> Result<(), RestartFailure> {
        self.shutdowns.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    async fn create_replacement(
        &self,
        _request: &AgentRestart,
        _plan: (),
    ) -> Result<String, RestartFailure> {
        Ok("term-shared-replacement".to_string())
    }
}

async fn next_restart_replaced_for(ws: &mut common::TestWs, request_id: &str) -> serde_json::Value {
    for _ in 0..40u8 {
        let message = tokio::time::timeout(std::time::Duration::from_secs(5), ws.next())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for replacement {request_id}"))
            .expect("restart websocket remains connected")
            .expect("restart websocket frame");
        let WsMessage::Text(text) = message else {
            continue;
        };
        let frame: serde_json::Value = serde_json::from_str(&text).expect("json frame");
        if frame["type"] == "agent.restart.replaced" && frame["requestId"] == request_id {
            return frame;
        }
    }
    panic!("no correlated replacement for {request_id}");
}

async fn next_restart_failed_for(ws: &mut common::TestWs, request_id: &str) -> serde_json::Value {
    for _ in 0..40u8 {
        let message = tokio::time::timeout(std::time::Duration::from_secs(5), ws.next())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for failure {request_id}"))
            .expect("restart websocket remains connected")
            .expect("restart websocket frame");
        let WsMessage::Text(text) = message else {
            continue;
        };
        let frame: serde_json::Value = serde_json::from_str(&text).expect("json frame");
        if frame["type"] == "agent.restart.failed" && frame["requestId"] == request_id {
            return frame;
        }
    }
    panic!("no correlated failure for {request_id}");
}

#[tokio::test]
async fn unrelated_provider_runtimes_restart_concurrently() {
    let coordinator = RestartCoordinator::new();
    let second_locator = RuntimeLocator::new(AgentRuntimeKind::Terminal, "codex", "durable-2");
    coordinator.register_initial(locator(), "term-1");
    coordinator.register_initial(second_locator, "term-2");
    let entered = Arc::new(tokio::sync::Barrier::new(2));
    let first = ConcurrentRuntime {
        entered: Arc::clone(&entered),
        replacement: "term-1b",
    };
    let second = ConcurrentRuntime {
        entered,
        replacement: "term-2b",
    };
    let second_request = AgentRestart {
        request_id: "r2".to_string(),
        provider: "codex".to_string(),
        session_id: "durable-2".to_string(),
        kind: AgentRuntimeKind::Terminal,
        live_id: "term-2".to_string(),
        expected_generation: 1,
    };

    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        tokio::join!(
            coordinator.execute(restart("r1", "term-1", 1), &first),
            coordinator.execute(second_request, &second),
        );
    })
    .await
    .expect("unrelated runtime locks must not serialize each other");
}

#[tokio::test]
async fn two_clients_with_distinct_requests_share_one_restart_and_reconnect_replays_follower() {
    let (url, registry, state) = common::spawn_server_with_specs_and_state(vec![]).await;
    let runtime = Arc::new(GatedSharedRuntime {
        entered: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
        shutdowns: AtomicUsize::new(0),
    });
    let _runtime_registration = state.restart.set_runtime(runtime.clone());
    state.restart.register_initial(locator(), "term-shared-old");
    let capabilities = Some(serde_json::json!({ "agentRestartV1": true }));
    let (mut owner_ws, _) =
        common::connect_and_capture_inventory_with_capabilities(&url, capabilities.clone()).await;
    let (mut follower_ws, _) =
        common::connect_and_capture_inventory_with_capabilities(&url, capabilities.clone()).await;

    owner_ws
        .send(WsMessage::Text(
            serde_json::to_string(&ClientMessage::AgentRestart(restart(
                "two-client-owner",
                "term-shared-old",
                1,
            )))
            .unwrap(),
        ))
        .await
        .unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        runtime.entered.notified(),
    )
    .await
    .expect("owner reached preflight");

    let follower_request = restart("two-client-follower", "term-shared-old", 1);
    follower_ws
        .send(WsMessage::Text(
            serde_json::to_string(&ClientMessage::AgentRestart(follower_request.clone())).unwrap(),
        ))
        .await
        .unwrap();
    let accepted_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while state.restart.retained_lock_counts().0 < 2 {
        assert!(
            tokio::time::Instant::now() < accepted_deadline,
            "follower request was not accepted before owner release"
        );
        tokio::task::yield_now().await;
    }
    runtime.release.notify_waiters();

    let owner = next_restart_replaced_for(&mut owner_ws, "two-client-owner").await;
    let follower = next_restart_replaced_for(&mut follower_ws, "two-client-follower").await;
    assert_eq!(owner["runtimeId"], "term-shared-replacement");
    assert_eq!(follower["runtimeId"], owner["runtimeId"]);
    assert_eq!(follower["generation"], owner["generation"]);
    assert_eq!(runtime.shutdowns.load(Ordering::SeqCst), 1);

    drop(follower_ws);
    let (mut reconnected, _) =
        common::connect_and_capture_inventory_with_capabilities(&url, capabilities).await;
    reconnected
        .send(WsMessage::Text(
            serde_json::to_string(&ClientMessage::AgentRestart(follower_request)).unwrap(),
        ))
        .await
        .unwrap();
    let replay = next_restart_replaced_for(&mut reconnected, "two-client-follower").await;
    assert_eq!(replay["runtimeId"], "term-shared-replacement");
    assert_eq!(replay["generation"], 2);
    assert_eq!(
        runtime.shutdowns.load(Ordering::SeqCst),
        1,
        "reconnect replay must not start a second transaction"
    );
    registry.kill_all();
}

#[tokio::test]
async fn distinct_client_recovers_retryable_owner_transaction_and_owner_reconnect_replays() {
    let (url, registry, state) = common::spawn_server_with_specs_and_state(vec![]).await;
    let runtime = Arc::new(RetryThenRecoverSharedRuntime {
        shutdowns: AtomicUsize::new(0),
        replacements: AtomicUsize::new(0),
    });
    let _runtime_registration = state.restart.set_runtime(runtime.clone());
    state.restart.register_initial(locator(), "term-retry-old");
    let capabilities = Some(serde_json::json!({ "agentRestartV1": true }));
    let (mut owner_ws, _) =
        common::connect_and_capture_inventory_with_capabilities(&url, capabilities.clone()).await;
    let owner_request = restart("retry-owner", "term-retry-old", 1);
    owner_ws
        .send(WsMessage::Text(
            serde_json::to_string(&ClientMessage::AgentRestart(owner_request.clone())).unwrap(),
        ))
        .await
        .unwrap();

    let failure = next_restart_failed_for(&mut owner_ws, "retry-owner").await;
    assert_eq!(failure["retryable"], true);
    assert_eq!(failure["recoveryPending"], true);
    drop(owner_ws);

    let (mut follower_ws, _) =
        common::connect_and_capture_inventory_with_capabilities(&url, capabilities.clone()).await;
    let follower_request = restart("retry-follower", "term-retry-old", 1);
    follower_ws
        .send(WsMessage::Text(
            serde_json::to_string(&ClientMessage::AgentRestart(follower_request)).unwrap(),
        ))
        .await
        .unwrap();
    let follower = next_restart_replaced_for(&mut follower_ws, "retry-follower").await;
    assert_eq!(follower["runtimeId"], "term-shared-recovered");

    let (mut reconnected_owner, _) =
        common::connect_and_capture_inventory_with_capabilities(&url, capabilities).await;
    reconnected_owner
        .send(WsMessage::Text(
            serde_json::to_string(&ClientMessage::AgentRestart(owner_request)).unwrap(),
        ))
        .await
        .unwrap();
    let owner_replay = next_restart_replaced_for(&mut reconnected_owner, "retry-owner").await;
    assert_eq!(owner_replay["runtimeId"], follower["runtimeId"]);
    assert_eq!(owner_replay["generation"], follower["generation"]);
    assert_eq!(runtime.shutdowns.load(Ordering::SeqCst), 1);
    assert_eq!(runtime.replacements.load(Ordering::SeqCst), 2);
    registry.kill_all();
}

#[tokio::test]
async fn connected_websocket_dispatches_restart_started_replaced_and_failed() {
    let (url, registry, state) = common::spawn_server_with_specs_and_state(vec![]).await;
    let _runtime_registration = state
        .restart
        .set_runtime(Arc::new(FakeRuntime::resumable("term-ws-2")));
    state.restart.register_initial(locator(), "term-ws-1");
    let (mut ws, _) = common::connect_and_capture_inventory_with_capabilities(
        &url,
        Some(serde_json::json!({ "agentRestartV1": true })),
    )
    .await;

    ws.send(WsMessage::Text(
        serde_json::to_string(&ClientMessage::AgentRestart(restart(
            "ws-r1",
            "term-ws-1",
            1,
        )))
        .unwrap(),
    ))
    .await
    .unwrap();
    let started = common::next_frame_of_type(&mut ws, "agent.restart.started").await;
    let replaced = common::next_frame_of_type(&mut ws, "agent.restart.replaced").await;
    assert_eq!(started["requestId"], "ws-r1");
    assert_eq!(replaced["runtimeId"], "term-ws-2");

    let failed_locator =
        RuntimeLocator::new(AgentRuntimeKind::Terminal, "claude", "durable-failed");
    state
        .restart
        .register_initial(failed_locator, "term-ws-failed");
    let _runtime_registration = state
        .restart
        .set_runtime(Arc::new(FakeRuntime::unresumable()));
    let failed_request = AgentRestart {
        request_id: "ws-r2".to_string(),
        provider: "claude".to_string(),
        session_id: "durable-failed".to_string(),
        kind: AgentRuntimeKind::Terminal,
        live_id: "term-ws-failed".to_string(),
        expected_generation: 1,
    };
    ws.send(WsMessage::Text(
        serde_json::to_string(&ClientMessage::AgentRestart(failed_request)).unwrap(),
    ))
    .await
    .unwrap();
    let failed = common::next_frame_of_type(&mut ws, "agent.restart.failed").await;
    assert_eq!(failed["requestId"], "ws-r2");
    assert_eq!(failed["code"], "UNRESUMABLE");

    registry.kill_all();
}

#[tokio::test]
async fn v7_connection_without_restart_negotiation_receives_a_correlated_failure() {
    let (url, registry, state) = common::spawn_server_with_specs_and_state(vec![]).await;
    let runtime = Arc::new(FakeRuntime::resumable("must-not-start"));
    let _runtime_registration = state.restart.set_runtime(runtime.clone());
    state
        .restart
        .register_initial(locator(), "term-unnegotiated");
    let (mut ws, _) = common::connect_and_capture_inventory(&url).await;

    ws.send(WsMessage::Text(
        serde_json::to_string(&ClientMessage::AgentRestart(restart(
            "unnegotiated-r1",
            "term-unnegotiated",
            1,
        )))
        .unwrap(),
    ))
    .await
    .unwrap();

    let failed = common::next_frame_of_type(&mut ws, "agent.restart.failed").await;
    assert_eq!(failed["requestId"], "unnegotiated-r1");
    assert_eq!(failed["runtimeId"], "term-unnegotiated");
    assert_eq!(failed["generation"], 1);
    assert_eq!(failed["code"], "CAPABILITY_NOT_NEGOTIATED");
    assert_eq!(failed["retryable"], false);
    assert_eq!(runtime.shutdowns.load(Ordering::SeqCst), 0);
    registry.kill_all();
}

#[tokio::test]
async fn production_terminal_adapter_uses_the_builtin_restore_path() {
    let (url, registry, mut state) =
        common::spawn_server_with_specs_and_state(vec![common::sleeper_cli_spec("amplifier")])
            .await;
    state.session_existence = Arc::new(PresentSessions);
    let _runtime_registration = state.restart.set_runtime(Arc::new(
        freshell_ws::restart::ProductionRestartRuntime::new(state.clone()),
    ));
    let (mut ws, _) = common::connect_and_capture_inventory_with_capabilities(
        &url,
        Some(serde_json::json!({ "agentRestartV1": true })),
    )
    .await;
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.create",
            "requestId": "production-adapter-create",
            "mode": "amplifier",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
        })
        .to_string(),
    ))
    .await
    .unwrap();
    let created = common::next_frame_of_type(&mut ws, "terminal.created").await;
    let terminal_id = created["terminalId"].as_str().unwrap().to_string();
    let session_id = created["sessionRef"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    let generation = created["runtime"]["generation"].as_u64().unwrap();

    ws.send(WsMessage::Text(
        serde_json::to_string(&ClientMessage::AgentRestart(AgentRestart {
            request_id: "production-adapter-restart".to_string(),
            provider: "amplifier".to_string(),
            session_id,
            kind: AgentRuntimeKind::Terminal,
            live_id: terminal_id.clone(),
            expected_generation: generation,
        }))
        .unwrap(),
    ))
    .await
    .unwrap();
    common::next_frame_of_type(&mut ws, "agent.restart.started").await;
    let replaced = common::next_frame_of_type(&mut ws, "agent.restart.replaced").await;
    let replacement_id = replaced["runtimeId"].as_str().unwrap();

    assert_ne!(replacement_id, terminal_id);
    assert!(!registry.is_live(&terminal_id));
    assert!(registry.is_live(replacement_id));
    #[cfg(target_os = "linux")]
    {
        let replacement_pid = registry
            .pid_of(replacement_id)
            .expect("replacement child pid");
        // The tagging is applied to the spawn env BEFORE exec (terminal.rs
        // ownership-mark insertion), so once the replacement child has
        // completed clone→exec the marker is always present; a read caught
        // inside that kernel window returns an EMPTY /proc environ. On a
        // 96-core host running the whole suite this race is a frequent flake;
        // poll briefly instead of widening it.
        assert!(
            wait_until(std::time::Duration::from_secs(2), || {
                std::fs::read(format!("/proc/{replacement_pid}/environ"))
                    .map(|environ| {
                        environ.split(|byte| *byte == 0).any(|variable| {
                            variable.starts_with(b"FRESHELL_RESTART_REPLACEMENT_ID=")
                        })
                    })
                    .unwrap_or(false)
            })
            .await,
            "replacement pid {replacement_pid} should carry the restart marker within 2s of exec"
        );
    }
    registry.kill_all();
}

#[tokio::test]
async fn production_terminal_preflight_persists_non_system_shell_and_provider_settings() {
    let mut spec = common::sleeper_cli_spec("claude");
    spec.model_args = Some(vec!["--model".to_string(), "{{model}}".to_string()]);
    spec.permission_mode_args = Some(vec![
        "--permission-mode".to_string(),
        "{{permissionMode}}".to_string(),
    ]);
    spec.sandbox_args = Some(vec!["--sandbox".to_string(), "{{sandbox}}".to_string()]);
    let (url, registry, mut state) = common::spawn_server_with_specs_and_state(vec![spec]).await;
    state.session_existence = Arc::new(PresentSessions);
    let mut settings = common::test_settings_value();
    settings["codingCli"]["providers"]["claude"] = serde_json::json!({
        "model": "opus-terminal",
        "permissionMode": "plan",
        "sandbox": "workspace-write"
    });
    state.settings = Arc::new(serde_json::from_value(settings).unwrap());
    let production = freshell_ws::restart::ProductionRestartRuntime::new(state.clone());
    let (mut ws, _) = common::connect_and_capture_inventory_with_capabilities(
        &url,
        Some(serde_json::json!({ "agentRestartV1": true })),
    )
    .await;
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.create",
            "requestId": "production-adapter-create",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "restore": true,
            "resumeSessionId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "sessionRef": {
                "provider": "claude",
                "sessionId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
            }
        })
        .to_string(),
    ))
    .await
    .unwrap();
    let created = common::next_frame_of_type(&mut ws, "terminal.created").await;
    let terminal_id = created["terminalId"].as_str().unwrap().to_string();
    let session_id = created["sessionRef"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    let generation = created["runtime"]["generation"].as_u64().unwrap();
    assert_eq!(
        registry.probe(&terminal_id).unwrap().restart_launch,
        Some(freshell_terminal::TerminalRestartLaunch {
            shell: freshell_protocol::Shell::System,
            permission_mode: None,
            model: None,
            sandbox: None,
            codex_managed: None,
        }),
        "ordinary create stamps the actual launch inputs from the server instance"
    );
    registry.set_restart_launch(
        &terminal_id,
        freshell_terminal::TerminalRestartLaunch {
            shell: freshell_protocol::Shell::Wsl,
            permission_mode: Some("plan".to_string()),
            model: Some("opus-terminal".to_string()),
            sandbox: Some("workspace-write".to_string()),
            codex_managed: None,
        },
    );

    let request = AgentRestart {
        request_id: "production-adapter-restart".to_string(),
        provider: "claude".to_string(),
        session_id,
        kind: AgentRuntimeKind::Terminal,
        live_id: terminal_id,
        expected_generation: generation,
    };
    RestartRuntime::preflight(&production, &request)
        .await
        .expect("terminal preflight");
    let context = RestartRuntime::persisted_resume_context(&production, &request, &())
        .expect("persisted terminal plan");
    let context: RestartResumeContext =
        serde_json::from_slice(&serde_json::to_vec(&context).unwrap()).unwrap();
    assert_eq!(context.terminal_shell, Some(freshell_protocol::Shell::Wsl));
    assert_eq!(context.terminal_model.as_deref(), Some("opus-terminal"));
    assert_eq!(context.terminal_permission_mode.as_deref(), Some("plan"));
    assert_eq!(context.terminal_sandbox.as_deref(), Some("workspace-write"));
    registry.kill_all();
}

#[tokio::test]
async fn configured_plain_codex_restart_keeps_app_server_settings_off_cli_argv() {
    let temp = tempfile::tempdir().unwrap();
    let argv_path = temp.path().join("codex-argv.txt");
    let script_path = temp.path().join("codex-sleeper.sh");
    std::fs::write(
        &script_path,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nexec sleep 30\n",
            argv_path.display()
        ),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(&script_path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&script_path, permissions).unwrap();
    }
    let mut spec = common::sleeper_cli_spec("codex");
    spec.default_cmd = script_path.to_string_lossy().to_string();
    spec.model_args = Some(vec!["--model".to_string(), "{{model}}".to_string()]);
    spec.permission_mode_args = Some(vec![
        "--permission-mode".to_string(),
        "{{permissionMode}}".to_string(),
    ]);
    spec.sandbox_args = Some(vec!["--sandbox".to_string(), "{{sandbox}}".to_string()]);

    let (url, registry, mut state) = common::spawn_server_with_specs_and_state(vec![spec]).await;
    let (mut ws, _) = common::connect_and_capture_inventory_with_capabilities(
        &url,
        Some(serde_json::json!({ "agentRestartV1": true })),
    )
    .await;
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.create",
            "requestId": "plain-codex-create",
            "mode": "codex",
            "shell": "system",
            "cwd": temp.path(),
            "restore": true,
            "resumeSessionId": "durable-codex",
            "sessionRef": {
                "provider": "codex",
                "sessionId": "durable-codex"
            }
        })
        .to_string(),
    ))
    .await
    .unwrap();
    let created = common::next_frame_of_type(&mut ws, "terminal.created").await;
    let terminal_id = created["terminalId"].as_str().unwrap().to_string();
    let generation = created["runtime"]["generation"].as_u64().unwrap();
    assert_eq!(
        registry.probe(&terminal_id).unwrap().restart_launch,
        Some(freshell_terminal::TerminalRestartLaunch {
            shell: freshell_protocol::Shell::System,
            permission_mode: None,
            model: None,
            sandbox: None,
            codex_managed: Some(false),
        }),
        "plain Codex records the actual stripped CLI launch, not configured values"
    );

    let mut settings = common::test_settings_value();
    settings["codingCli"]["providers"]["codex"] = serde_json::json!({
        "model": "gpt-5.3-codex",
        "permissionMode": "on-request",
        "sandbox": "workspace-write"
    });
    state.settings = Arc::new(serde_json::from_value(settings).unwrap());
    state.session_existence = Arc::new(PresentSessions);
    let production = freshell_ws::restart::ProductionRestartRuntime::new(state.clone());
    let outcome = state
        .restart
        .execute(
            AgentRestart {
                request_id: "plain-codex-restart".to_string(),
                provider: "codex".to_string(),
                session_id: "durable-codex".to_string(),
                kind: AgentRuntimeKind::Terminal,
                live_id: terminal_id,
                expected_generation: generation,
            },
            &production,
        )
        .await;
    assert!(matches!(
        outcome.messages.last(),
        Some(ServerMessage::AgentRestartReplaced(_))
    ));

    let argv = std::fs::read_to_string(&argv_path).unwrap();
    assert!(argv.contains("--resume\ndurable-codex"));
    assert!(!argv.contains("--model"), "{argv}");
    assert!(!argv.contains("--sandbox"), "{argv}");
    assert!(!argv.contains("--permission-mode"), "{argv}");
    registry.kill_all();
}

#[test]
fn managed_codex_terminal_plan_survives_boot_serialization_without_becoming_cli_settings() {
    let context = RestartResumeContext {
        terminal_cwd: Some("/workspace/codex".to_string()),
        terminal_shell: Some(freshell_protocol::Shell::System),
        terminal_permission_mode: Some("on-request".to_string()),
        terminal_model: Some("gpt-5.3-codex".to_string()),
        terminal_sandbox: Some("workspace-write".to_string()),
        terminal_codex_managed: Some(true),
        ..RestartResumeContext::default()
    };

    let encoded = serde_json::to_vec(&context).unwrap();
    let recovered: RestartResumeContext = serde_json::from_slice(&encoded).unwrap();
    assert_eq!(recovered, context);
    assert_eq!(recovered.terminal_codex_managed, Some(true));
}

struct FaithfulFreshRuntime {
    coordinator: RestartCoordinator,
    broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
    live: Mutex<HashMap<(String, String), String>>,
    events: Mutex<Vec<String>>,
    plans: Mutex<HashMap<(String, String), ProductionFreshResumePlan>>,
    creates: Mutex<Vec<freshell_protocol::FreshAgentCreate>>,
    fail_next_create: AtomicBool,
}

fn provider_name(provider: freshell_protocol::AgentProvider) -> &'static str {
    match provider {
        freshell_protocol::AgentProvider::Claude => "claude",
        freshell_protocol::AgentProvider::Codex => "codex",
        freshell_protocol::AgentProvider::Opencode => "opencode",
        freshell_protocol::AgentProvider::Amplifier => "amplifier",
    }
}

struct UnrelatedTrafficFreshRuntime {
    broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
}

#[async_trait::async_trait]
impl ProductionFreshRuntime for UnrelatedTrafficFreshRuntime {
    async fn has_live_session(
        &self,
        _provider: freshell_protocol::AgentProvider,
        _session_id: &str,
    ) -> bool {
        true
    }

    async fn shutdown_for_restart(
        &self,
        _provider: freshell_protocol::AgentProvider,
        _session_id: &str,
        _expected_runtime_id: &str,
    ) -> bool {
        true
    }

    async fn capture_resume_plan(
        &self,
        provider: freshell_protocol::AgentProvider,
        _session_id: &str,
        _expected_runtime_id: &str,
    ) -> Option<ProductionFreshResumePlan> {
        Some(ProductionFreshResumePlan {
            session_type: match provider {
                freshell_protocol::AgentProvider::Claude => {
                    freshell_protocol::SessionType::Freshclaude
                }
                freshell_protocol::AgentProvider::Codex => {
                    freshell_protocol::SessionType::Freshcodex
                }
                freshell_protocol::AgentProvider::Opencode => {
                    freshell_protocol::SessionType::Freshopencode
                }
                freshell_protocol::AgentProvider::Amplifier => return None,
            },
            cwd: None,
            model: None,
            effort: None,
            permission_mode: None,
            sandbox: None,
        })
    }

    async fn handle_create(
        &self,
        _provider: freshell_protocol::AgentProvider,
        _create: freshell_protocol::FreshAgentCreate,
    ) {
        let broadcast_tx = Arc::clone(&self.broadcast_tx);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                if broadcast_tx.send("{}".to_string()).is_err() {
                    break;
                }
            }
        });
    }
}

#[async_trait::async_trait]
impl ProductionFreshRuntime for FaithfulFreshRuntime {
    async fn has_live_session(
        &self,
        provider: freshell_protocol::AgentProvider,
        session_id: &str,
    ) -> bool {
        let provider = provider_name(provider);
        self.events
            .lock()
            .unwrap()
            .push(format!("preflight:{provider}:{session_id}"));
        self.live
            .lock()
            .unwrap()
            .contains_key(&(provider.to_string(), session_id.to_string()))
    }

    async fn shutdown_for_restart(
        &self,
        provider: freshell_protocol::AgentProvider,
        session_id: &str,
        expected_runtime_id: &str,
    ) -> bool {
        let provider = provider_name(provider);
        self.events.lock().unwrap().push(format!(
            "shutdown:{provider}:{session_id}:{expected_runtime_id}"
        ));
        let mut live = self.live.lock().unwrap();
        let key = (provider.to_string(), session_id.to_string());
        if live.get(&key).map(String::as_str) != Some(expected_runtime_id) {
            return false;
        }
        live.remove(&key);
        true
    }

    async fn capture_resume_plan(
        &self,
        provider: freshell_protocol::AgentProvider,
        session_id: &str,
        _expected_runtime_id: &str,
    ) -> Option<ProductionFreshResumePlan> {
        let provider = provider_name(provider).to_string();
        self.plans
            .lock()
            .unwrap()
            .get(&(provider, session_id.to_string()))
            .cloned()
    }

    async fn handle_create(
        &self,
        provider: freshell_protocol::AgentProvider,
        create: freshell_protocol::FreshAgentCreate,
    ) {
        let provider = provider_name(provider);
        self.creates.lock().unwrap().push(create.clone());
        if self.fail_next_create.swap(false, Ordering::SeqCst) {
            self.broadcast_tx
                .send(
                    serde_json::to_string(&ServerMessage::FreshAgentCreateFailed(
                        FreshAgentCreateFailed {
                            code: "TEMPORARY_FAILURE".to_string(),
                            message: "retry after server restart".to_string(),
                            request_id: create.request_id,
                            retryable: Some(true),
                        },
                    ))
                    .unwrap(),
                )
                .unwrap();
            return;
        }
        let durable_id = create
            .resume_session_id
            .as_deref()
            .expect("production restart must use the resume path");
        self.events
            .lock()
            .unwrap()
            .push(format!("resume:{provider}:{durable_id}"));
        let runtime_id = format!("fresh-{provider}-replacement");
        let runtime = self.coordinator.register_initial(
            RuntimeLocator::new(AgentRuntimeKind::FreshAgent, provider, durable_id),
            &runtime_id,
        );
        self.live
            .lock()
            .unwrap()
            .insert((provider.to_string(), durable_id.to_string()), runtime_id);
        let created = ServerMessage::FreshAgentCreated(FreshAgentCreated {
            provider: provider.to_string(),
            request_id: create.request_id,
            runtime_provider: provider.to_string(),
            session_id: durable_id.to_string(),
            session_type: match create.session_type {
                freshell_protocol::SessionType::Freshclaude => "freshclaude",
                freshell_protocol::SessionType::Kilroy => "kilroy",
                freshell_protocol::SessionType::Freshcodex => "freshcodex",
                freshell_protocol::SessionType::Freshopencode => "freshopencode",
            }
            .to_string(),
            session_ref: create.session_ref,
            runtime: Some(runtime),
        });
        self.broadcast_tx
            .send(serde_json::to_string(&created).unwrap())
            .unwrap();
    }
}

struct BootFenceFreshRuntime {
    coordinator: RestartCoordinator,
    broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
    live: AtomicBool,
    session_type: freshell_protocol::SessionType,
    barrier: Option<freshell_codex::transport::OwnedProcessTreeBarrier>,
    predecessor: Arc<Mutex<std::process::Child>>,
    leave_retirement_pending: bool,
    creates: AtomicUsize,
}

#[async_trait::async_trait]
impl ProductionFreshRuntime for BootFenceFreshRuntime {
    async fn has_live_session(
        &self,
        _provider: freshell_protocol::AgentProvider,
        _session_id: &str,
    ) -> bool {
        self.live.load(Ordering::SeqCst)
    }

    async fn shutdown_for_restart(
        &self,
        _provider: freshell_protocol::AgentProvider,
        _session_id: &str,
        _expected_runtime_id: &str,
    ) -> bool {
        !self.leave_retirement_pending
    }

    async fn shutdown_for_restart_detailed(
        &self,
        _provider: freshell_protocol::AgentProvider,
        _session_id: &str,
        _expected_runtime_id: &str,
    ) -> freshell_freshagent::RestartShutdownOutcome {
        if self.leave_retirement_pending {
            freshell_freshagent::RestartShutdownOutcome::RetirementIncomplete {
                message: "simulate server exit after the durable retirement journal".to_string(),
            }
        } else {
            freshell_freshagent::RestartShutdownOutcome::Stopped
        }
    }

    async fn capture_resume_plan(
        &self,
        _provider: freshell_protocol::AgentProvider,
        _session_id: &str,
        _expected_runtime_id: &str,
    ) -> Option<ProductionFreshResumePlan> {
        Some(ProductionFreshResumePlan {
            session_type: self.session_type,
            cwd: Some("/workspace/boot-fence".to_string()),
            model: None,
            effort: None,
            permission_mode: None,
            sandbox: None,
        })
    }

    async fn capture_restart_actions(
        &self,
        _provider: freshell_protocol::AgentProvider,
        _session_id: &str,
        _expected_runtime_id: &str,
    ) -> Result<Vec<RestartRetirementAction>, String> {
        self.barrier
            .clone()
            .map(|barrier| vec![RestartRetirementAction::ProcessTree { barrier }])
            .ok_or_else(|| "test predecessor barrier unavailable".to_string())
    }

    async fn handle_create(
        &self,
        provider: freshell_protocol::AgentProvider,
        create: freshell_protocol::FreshAgentCreate,
    ) {
        assert!(
            self.predecessor
                .lock()
                .unwrap()
                .try_wait()
                .expect("inspect predecessor")
                .is_some(),
            "boot recovery must confirm the predecessor dead before replacement create"
        );
        self.creates.fetch_add(1, Ordering::SeqCst);
        self.live.store(true, Ordering::SeqCst);
        let durable_id = create
            .resume_session_id
            .as_deref()
            .expect("restart uses durable resume");
        let provider_name = provider_name(provider);
        let runtime = self.coordinator.register_initial(
            RuntimeLocator::new(AgentRuntimeKind::FreshAgent, provider_name, durable_id),
            format!("fresh-{provider_name}-boot-replacement"),
        );
        let created = ServerMessage::FreshAgentCreated(FreshAgentCreated {
            provider: provider_name.to_string(),
            request_id: create.request_id,
            runtime_provider: provider_name.to_string(),
            session_id: durable_id.to_string(),
            session_type: match create.session_type {
                freshell_protocol::SessionType::Freshclaude => "freshclaude",
                freshell_protocol::SessionType::Kilroy => "kilroy",
                freshell_protocol::SessionType::Freshcodex => "freshcodex",
                freshell_protocol::SessionType::Freshopencode => "freshopencode",
            }
            .to_string(),
            session_ref: create.session_ref,
            runtime: Some(runtime),
        });
        self.broadcast_tx
            .send(serde_json::to_string(&created).unwrap())
            .unwrap();
    }
}

fn spawn_boot_fence_predecessor(
    ownership_id: &str,
) -> (
    Arc<Mutex<std::process::Child>>,
    freshell_codex::transport::OwnedProcessTreeBarrier,
) {
    const OWNERSHIP_ENV: &str = "FRESHELL_TEST_RESTART_BOOT_OWNER";
    let child = std::process::Command::new("sh")
        .args(["-c", "while :; do sleep 1; done"])
        .env(OWNERSHIP_ENV, ownership_id)
        .spawn()
        .expect("spawn predecessor writer");
    let barrier = freshell_codex::transport::OwnedProcessTreeBarrier::capture(
        child.id(),
        OWNERSHIP_ENV,
        ownership_id,
    );
    (Arc::new(Mutex::new(child)), barrier)
}

struct PendingTerminalBootFence {
    fence: RestartRetirementFence,
    cwd: String,
}

#[async_trait::async_trait]
impl RestartRuntime for PendingTerminalBootFence {
    type ResumePlan = ();

    async fn preflight(&self, _request: &AgentRestart) -> Result<(), RestartFailure> {
        Ok(())
    }

    async fn shutdown_for_restart(
        &self,
        _request: &AgentRestart,
        _plan: &(),
    ) -> Result<(), RestartFailure> {
        Err(RestartFailure::new(
            AgentRestartFailureCode::ShutdownFailed,
            "simulate server exit before local terminal retirement",
            true,
        ))
    }

    async fn create_replacement(
        &self,
        _request: &AgentRestart,
        _plan: (),
    ) -> Result<String, RestartFailure> {
        unreachable!("retirement remains pending")
    }

    fn persisted_resume_context(
        &self,
        _request: &AgentRestart,
        _plan: &(),
    ) -> Option<RestartResumeContext> {
        Some(RestartResumeContext {
            terminal_cwd: Some(self.cwd.clone()),
            terminal_shell: Some(freshell_protocol::Shell::System),
            ..RestartResumeContext::default()
        })
    }

    fn persisted_retirement_fence(
        &self,
        _request: &AgentRestart,
        _plan: &(),
    ) -> Option<RestartRetirementFence> {
        Some(self.fence.clone())
    }
}

#[tokio::test]
async fn production_boot_recovery_finishes_persisted_claude_and_codex_retirements() {
    for (provider, session_type) in [
        ("claude", freshell_protocol::SessionType::Freshclaude),
        ("codex", freshell_protocol::SessionType::Freshcodex),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("restart-state.json");
        let (predecessor, barrier) =
            spawn_boot_fence_predecessor(&format!("{provider}-{}", uuid::Uuid::new_v4()));
        let (_url, registry, mut state) = common::spawn_server_with_specs_and_state(vec![]).await;
        state.boot_id = Arc::new(format!("boot-origin-{provider}"));
        state.session_existence = Arc::new(PresentSessions);
        state.restart = RestartCoordinator::new_persistent(path.clone()).unwrap();
        let durable_id = format!("durable-{provider}-boot-fence");
        let old_runtime_id = format!("fresh-{provider}-boot-old");
        let old = state.restart.register_initial(
            RuntimeLocator::new(AgentRuntimeKind::FreshAgent, provider, &durable_id),
            &old_runtime_id,
        );
        let first_runtime = Arc::new(BootFenceFreshRuntime {
            coordinator: state.restart.clone(),
            broadcast_tx: Arc::clone(&state.broadcast_tx),
            live: AtomicBool::new(true),
            session_type,
            barrier: Some(barrier),
            predecessor: Arc::clone(&predecessor),
            leave_retirement_pending: true,
            creates: AtomicUsize::new(0),
        });
        let production = freshell_ws::restart::ProductionRestartRuntime::with_fresh_runtime(
            state.clone(),
            first_runtime,
        );
        let request = AgentRestart {
            request_id: format!("boot-fence-{provider}"),
            provider: provider.to_string(),
            session_id: durable_id,
            kind: AgentRuntimeKind::FreshAgent,
            live_id: old_runtime_id,
            expected_generation: old.generation,
        };

        let first = state.restart.execute(request.clone(), &production).await;
        assert!(matches!(
            first.messages.last(),
            Some(ServerMessage::AgentRestartFailed(failed))
                if failed.retryable && failed.recovery_pending
        ));
        assert!(state.restart.pending_recoveries()[0]
            .retirement_fence
            .is_some());
        drop(production);
        drop(state);

        let reopened = RestartCoordinator::new_persistent(path).unwrap();
        let (_url, recovery_registry, mut recovery_state) =
            common::spawn_server_with_specs_and_state(vec![]).await;
        recovery_state.boot_id = Arc::new(format!("boot-recovery-{provider}"));
        recovery_state.session_existence = Arc::new(PresentSessions);
        recovery_state.restart = reopened.clone();
        let recovery_runtime = Arc::new(BootFenceFreshRuntime {
            coordinator: reopened.clone(),
            broadcast_tx: Arc::clone(&recovery_state.broadcast_tx),
            live: AtomicBool::new(false),
            session_type,
            barrier: None,
            predecessor: Arc::clone(&predecessor),
            leave_retirement_pending: false,
            creates: AtomicUsize::new(0),
        });
        let production = freshell_ws::restart::ProductionRestartRuntime::with_fresh_runtime(
            recovery_state,
            recovery_runtime.clone(),
        );

        let recovered = reopened.execute(request, &production).await;
        assert!(matches!(
            recovered.messages.last(),
            Some(ServerMessage::AgentRestartReplaced(_))
        ));
        assert_eq!(recovery_runtime.creates.load(Ordering::SeqCst), 1);
        assert!(reopened.pending_recoveries().is_empty());
        registry.kill_all();
        recovery_registry.kill_all();
        if predecessor.lock().unwrap().try_wait().unwrap().is_none() {
            let _ = predecessor.lock().unwrap().kill();
            let _ = predecessor.lock().unwrap().wait();
        }
    }
}

#[tokio::test]
async fn production_boot_recovery_finishes_persisted_terminal_retirement_before_restore() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("restart-state.json");
    let (predecessor, barrier) =
        spawn_boot_fence_predecessor(&format!("terminal-{}", uuid::Uuid::new_v4()));
    let request = AgentRestart {
        request_id: "boot-fence-terminal".to_string(),
        provider: "amplifier".to_string(),
        session_id: "durable-terminal-boot-fence".to_string(),
        kind: AgentRuntimeKind::Terminal,
        live_id: "terminal-boot-old".to_string(),
        expected_generation: 1,
    };
    let coordinator = RestartCoordinator::new_persistent(path.clone()).unwrap();
    coordinator.register_initial(
        RuntimeLocator::new(
            AgentRuntimeKind::Terminal,
            "amplifier",
            "durable-terminal-boot-fence",
        ),
        &request.live_id,
    );
    let first = coordinator
        .execute(
            request.clone(),
            &PendingTerminalBootFence {
                fence: RestartRetirementFence {
                    origin_boot_id: "boot-terminal-origin".to_string(),
                    actions: vec![RestartRetirementAction::ProcessTree { barrier }],
                },
                cwd: temp.path().to_string_lossy().into_owned(),
            },
        )
        .await;
    assert!(matches!(
        first.messages.last(),
        Some(ServerMessage::AgentRestartFailed(failed))
            if failed.retryable && failed.recovery_pending
    ));
    drop(coordinator);

    let reopened = RestartCoordinator::new_persistent(path).unwrap();
    let (_url, registry, mut state) =
        common::spawn_server_with_specs_and_state(vec![common::sleeper_cli_spec("amplifier")])
            .await;
    state.boot_id = Arc::new("boot-terminal-recovery".to_string());
    state.session_existence = Arc::new(PresentSessions);
    state.restart = reopened.clone();
    let production = freshell_ws::restart::ProductionRestartRuntime::new(state);

    let recovered = reopened.execute(request, &production).await;
    assert!(matches!(
        recovered.messages.last(),
        Some(ServerMessage::AgentRestartReplaced(_))
    ));
    assert!(
        predecessor
            .lock()
            .unwrap()
            .try_wait()
            .expect("inspect predecessor")
            .is_some(),
        "terminal replacement must wait for the persisted predecessor tree"
    );
    assert!(reopened.pending_recoveries().is_empty());
    registry.kill_all();
}

#[tokio::test]
async fn production_boot_recovery_without_a_persisted_fence_fails_safe() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("restart-state.json");
    let request = restart("missing-boot-fence", "term-1", 1);
    let coordinator = RestartCoordinator::new_persistent(path.clone()).unwrap();
    coordinator.register_initial(locator(), "term-1");
    coordinator
        .execute(
            request.clone(),
            &RetirementRetries {
                shutdowns: AtomicUsize::new(0),
            },
        )
        .await;
    drop(coordinator);

    let reopened = RestartCoordinator::new_persistent(path).unwrap();
    let (_url, registry, mut state) =
        common::spawn_server_with_specs_and_state(vec![common::sleeper_cli_spec("claude")]).await;
    state.boot_id = Arc::new("boot-without-fence".to_string());
    state.session_existence = Arc::new(PresentSessions);
    state.restart = reopened.clone();
    let production = freshell_ws::restart::ProductionRestartRuntime::new(state);

    let outcome = reopened.execute(request, &production).await;
    assert!(matches!(
        outcome.messages.last(),
        Some(ServerMessage::AgentRestartFailed(failed))
            if failed.code == AgentRestartFailureCode::ShutdownFailed
                && failed.retryable
                && failed.recovery_pending
                && failed.message.contains("retirement fence is unavailable")
    ));
    assert_eq!(reopened.pending_recoveries().len(), 1);
    assert!(
        registry.inventory().is_empty(),
        "no replacement writer may start"
    );
    registry.kill_all();
}

#[tokio::test]
async fn production_fresh_adapters_preflight_exact_teardown_and_resume_all_providers() {
    for provider in ["claude", "codex", "opencode"] {
        let (_url, registry, mut state) = common::spawn_server_with_specs_and_state(vec![]).await;
        state.session_existence = Arc::new(PresentSessions);
        let durable_id = format!("durable-{provider}");
        let old_runtime_id = format!("fresh-{provider}-old");
        let locator =
            RuntimeLocator::new(AgentRuntimeKind::FreshAgent, provider, durable_id.clone());
        let old = state
            .restart
            .register_initial(locator.clone(), &old_runtime_id);
        let faithful = Arc::new(FaithfulFreshRuntime {
            coordinator: state.restart.clone(),
            broadcast_tx: Arc::clone(&state.broadcast_tx),
            live: Mutex::new(HashMap::from([(
                (provider.to_string(), durable_id.clone()),
                old_runtime_id.clone(),
            )])),
            events: Mutex::new(Vec::new()),
            plans: Mutex::new(HashMap::from([(
                (provider.to_string(), durable_id.clone()),
                ProductionFreshResumePlan {
                    session_type: match provider {
                        "claude" => freshell_protocol::SessionType::Freshclaude,
                        "codex" => freshell_protocol::SessionType::Freshcodex,
                        "opencode" => freshell_protocol::SessionType::Freshopencode,
                        _ => unreachable!(),
                    },
                    cwd: None,
                    model: None,
                    effort: None,
                    permission_mode: None,
                    sandbox: None,
                },
            )])),
            creates: Mutex::new(Vec::new()),
            fail_next_create: AtomicBool::new(false),
        });
        let production = freshell_ws::restart::ProductionRestartRuntime::with_fresh_runtime(
            state.clone(),
            faithful.clone(),
        );
        let request = AgentRestart {
            request_id: format!("production-{provider}-restart"),
            provider: provider.to_string(),
            session_id: durable_id.clone(),
            kind: AgentRuntimeKind::FreshAgent,
            live_id: old_runtime_id.clone(),
            expected_generation: old.generation,
        };

        let outcome = state.restart.execute(request, &production).await;

        let ServerMessage::AgentRestartReplaced(replaced) =
            outcome.messages.last().expect("terminal result")
        else {
            panic!("expected {provider} replacement: {:?}", outcome.messages)
        };
        assert_eq!(
            replaced.runtime,
            RuntimeDescriptor {
                runtime_id: format!("fresh-{provider}-replacement"),
                generation: old.generation + 1,
            }
        );
        assert_eq!(
            state.restart.runtime_for_locator(&locator),
            Some(replaced.runtime.clone())
        );
        assert_eq!(
            faithful.events.lock().unwrap().as_slice(),
            [
                format!("preflight:{provider}:{durable_id}"),
                format!("shutdown:{provider}:{durable_id}:{old_runtime_id}"),
                format!("resume:{provider}:{durable_id}"),
                format!("preflight:{provider}:{durable_id}"),
            ],
            "{provider} must use preflight, exact-runtime teardown, and durable resume"
        );
        registry.kill_all();
    }
}

#[tokio::test]
async fn production_fresh_restart_and_recovery_preserve_kilroy_and_claude_settings() {
    let (_url, registry, mut state) = common::spawn_server_with_specs_and_state(vec![]).await;
    state.session_existence = Arc::new(PresentSessions);
    let durable_id = "durable-kilroy".to_string();
    let old_runtime_id = "fresh-kilroy-old".to_string();
    let old = state.restart.register_initial(
        RuntimeLocator::new(AgentRuntimeKind::FreshAgent, "claude", durable_id.clone()),
        &old_runtime_id,
    );
    let faithful = Arc::new(FaithfulFreshRuntime {
        coordinator: state.restart.clone(),
        broadcast_tx: Arc::clone(&state.broadcast_tx),
        live: Mutex::new(HashMap::from([(
            ("claude".to_string(), durable_id.clone()),
            old_runtime_id.clone(),
        )])),
        events: Mutex::new(Vec::new()),
        plans: Mutex::new(HashMap::from([(
            ("claude".to_string(), durable_id.clone()),
            ProductionFreshResumePlan {
                session_type: freshell_protocol::SessionType::Kilroy,
                cwd: Some("/workspace/kilroy".to_string()),
                model: Some("claude-opus-4-1".to_string()),
                effort: Some("high".to_string()),
                permission_mode: Some("plan".to_string()),
                sandbox: Some(freshell_protocol::Sandbox::WorkspaceWrite),
            },
        )])),
        creates: Mutex::new(Vec::new()),
        fail_next_create: AtomicBool::new(false),
    });
    let production = freshell_ws::restart::ProductionRestartRuntime::with_fresh_runtime(
        state.clone(),
        faithful.clone(),
    );
    let request = AgentRestart {
        request_id: "production-kilroy-restart".to_string(),
        provider: "claude".to_string(),
        session_id: durable_id,
        kind: AgentRuntimeKind::FreshAgent,
        live_id: old_runtime_id,
        expected_generation: old.generation,
    };

    RestartRuntime::preflight(&production, &request)
        .await
        .expect("kilroy preflight");
    let persisted = RestartRuntime::persisted_resume_context(&production, &request, &())
        .expect("resume context");
    let persisted: RestartResumeContext =
        serde_json::from_slice(&serde_json::to_vec(&persisted).unwrap()).unwrap();
    RestartRuntime::recover_replacement(&production, &request, Some(&persisted))
        .await
        .expect("boot-style recovery");

    let creates = faithful.creates.lock().unwrap();
    let create = creates.last().expect("one recovered create");
    assert_eq!(create.session_type, freshell_protocol::SessionType::Kilroy);
    assert_eq!(create.cwd.as_deref(), Some("/workspace/kilroy"));
    assert_eq!(create.model.as_deref(), Some("claude-opus-4-1"));
    assert_eq!(create.effort.as_deref(), Some("high"));
    assert_eq!(create.permission_mode.as_deref(), Some("plan"));
    assert_eq!(
        create.sandbox,
        Some(freshell_protocol::Sandbox::WorkspaceWrite)
    );
    registry.kill_all();
}

#[tokio::test]
async fn production_fresh_boot_recovery_reuses_the_persisted_kilroy_plan() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("restart-state.json");
    let (_url, registry, mut state) = common::spawn_server_with_specs_and_state(vec![]).await;
    state.session_existence = Arc::new(PresentSessions);
    state.restart = RestartCoordinator::new_persistent(path.clone()).unwrap();
    let durable_id = "durable-kilroy-boot".to_string();
    let old_runtime_id = "fresh-kilroy-boot-old".to_string();
    let old = state.restart.register_initial(
        RuntimeLocator::new(AgentRuntimeKind::FreshAgent, "claude", durable_id.clone()),
        &old_runtime_id,
    );
    let exact_plan = ProductionFreshResumePlan {
        session_type: freshell_protocol::SessionType::Kilroy,
        cwd: Some("/workspace/kilroy-boot".to_string()),
        model: Some("claude-opus-boot".to_string()),
        effort: Some("max".to_string()),
        permission_mode: Some("acceptEdits".to_string()),
        sandbox: Some(freshell_protocol::Sandbox::ReadOnly),
    };
    let failing = Arc::new(FaithfulFreshRuntime {
        coordinator: state.restart.clone(),
        broadcast_tx: Arc::clone(&state.broadcast_tx),
        live: Mutex::new(HashMap::from([(
            ("claude".to_string(), durable_id.clone()),
            old_runtime_id.clone(),
        )])),
        events: Mutex::new(Vec::new()),
        plans: Mutex::new(HashMap::from([(
            ("claude".to_string(), durable_id.clone()),
            exact_plan,
        )])),
        creates: Mutex::new(Vec::new()),
        fail_next_create: AtomicBool::new(true),
    });
    let production =
        freshell_ws::restart::ProductionRestartRuntime::with_fresh_runtime(state.clone(), failing);
    let request = AgentRestart {
        request_id: "production-kilroy-boot-r1".to_string(),
        provider: "claude".to_string(),
        session_id: durable_id.clone(),
        kind: AgentRuntimeKind::FreshAgent,
        live_id: old_runtime_id,
        expected_generation: old.generation,
    };
    let first = state.restart.execute(request.clone(), &production).await;
    assert!(matches!(
        first.messages.last(),
        Some(ServerMessage::AgentRestartFailed(failed)) if failed.retryable
    ));

    drop(production);
    drop(state);
    let reopened = RestartCoordinator::new_persistent(path).unwrap();
    let (_url, recovery_registry, mut recovery_state) =
        common::spawn_server_with_specs_and_state(vec![]).await;
    recovery_state.session_existence = Arc::new(PresentSessions);
    recovery_state.restart = reopened.clone();
    let recovering = Arc::new(FaithfulFreshRuntime {
        coordinator: reopened.clone(),
        broadcast_tx: Arc::clone(&recovery_state.broadcast_tx),
        live: Mutex::new(HashMap::new()),
        events: Mutex::new(Vec::new()),
        plans: Mutex::new(HashMap::new()),
        creates: Mutex::new(Vec::new()),
        fail_next_create: AtomicBool::new(false),
    });
    let production = Arc::new(
        freshell_ws::restart::ProductionRestartRuntime::with_fresh_runtime(
            recovery_state,
            recovering.clone(),
        ),
    );
    let _registration = reopened.set_runtime(production);
    reopened.recover_pending_registered(|_| {}).await;

    let creates = recovering.creates.lock().unwrap();
    let create = creates.last().expect("boot recovery create");
    assert_eq!(create.session_type, freshell_protocol::SessionType::Kilroy);
    assert_eq!(create.cwd.as_deref(), Some("/workspace/kilroy-boot"));
    assert_eq!(create.model.as_deref(), Some("claude-opus-boot"));
    assert_eq!(create.effort.as_deref(), Some("max"));
    assert_eq!(create.permission_mode.as_deref(), Some("acceptEdits"));
    assert_eq!(create.sandbox, Some(freshell_protocol::Sandbox::ReadOnly));
    assert!(reopened.pending_recoveries().is_empty());
    registry.kill_all();
    recovery_registry.kill_all();
}

#[tokio::test(start_paused = true)]
async fn fresh_replacement_result_uses_one_deadline_despite_unrelated_broadcasts() {
    let (_url, registry, mut state) = common::spawn_server_with_specs_and_state(vec![]).await;
    state.session_existence = Arc::new(PresentSessions);
    let fresh_runtime = Arc::new(UnrelatedTrafficFreshRuntime {
        broadcast_tx: Arc::clone(&state.broadcast_tx),
    });
    let production =
        freshell_ws::restart::ProductionRestartRuntime::with_fresh_runtime(state, fresh_runtime);
    let request = AgentRestart {
        request_id: "deadline-r1".to_string(),
        provider: "claude".to_string(),
        session_id: "durable-deadline".to_string(),
        kind: AgentRuntimeKind::FreshAgent,
        live_id: "fresh-old".to_string(),
        expected_generation: 1,
    };
    RestartRuntime::preflight(&production, &request)
        .await
        .expect("deadline test preflight");

    let waiter =
        tokio::spawn(
            async move { RestartRuntime::create_replacement(&production, &request, ()).await },
        );
    tokio::task::yield_now().await;
    for _ in 0..31 {
        tokio::time::advance(std::time::Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
    }

    assert!(
        waiter.is_finished(),
        "unrelated broadcast traffic must not restart the 30-second result timeout"
    );
    let failure = waiter.await.unwrap().unwrap_err();
    assert_eq!(failure.code, AgentRestartFailureCode::ReplacementFailed);
    assert!(failure.retryable);
    assert_eq!(
        failure.message,
        "fresh-agent replacement did not report a result"
    );
    registry.kill_all();
}

// ---------------------------------------------------------------------------
// Fix 7: active restart plans are never evicted by other requests' preflight
// floods, and every terminal outcome (commit, terminal failure) removes the
// plan and releases the OpenCode preflight reservation through the
// `RestartRuntime::on_terminal_outcome` hook. Retryable outcomes keep both
// the durable row and the plan so a same-request retry reuses its token.
// ---------------------------------------------------------------------------

/// One deterministically parked shutdown: the production adapter holds the
/// request's active plan between preflight and replacement creation, which is
/// exactly the window an eviction would have to hit.
#[derive(Clone)]
struct RecordedShutdownGate {
    session_id: String,
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
}

/// Fix-7 recording seam: faithful enough to drive the real
/// `ProductionRestartRuntime` ordering (reserve → shutdown → fenced create →
/// commit) without external provider binaries, while recording every
/// reservation acquire/release tuple and injecting gated or failing shutdowns.
struct ReservationRecordingFreshRuntime {
    coordinator: RestartCoordinator,
    broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
    live: Mutex<HashMap<(String, String), String>>,
    plans: Mutex<HashMap<(String, String), ProductionFreshResumePlan>>,
    reservations: Mutex<Vec<(String, String, String)>>,
    releases: Mutex<Vec<(freshell_protocol::AgentProvider, String, String, String)>>,
    shutdown_outcomes:
        Mutex<HashMap<(String, String), freshell_freshagent::RestartShutdownOutcome>>,
    shutdown_gate: Mutex<Option<RecordedShutdownGate>>,
}

impl ReservationRecordingFreshRuntime {
    fn new(
        coordinator: RestartCoordinator,
        broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
    ) -> Self {
        Self {
            coordinator,
            broadcast_tx,
            live: Mutex::new(HashMap::new()),
            plans: Mutex::new(HashMap::new()),
            reservations: Mutex::new(Vec::new()),
            releases: Mutex::new(Vec::new()),
            shutdown_outcomes: Mutex::new(HashMap::new()),
            shutdown_gate: Mutex::new(None),
        }
    }

    fn enroll_live_session(&self, provider: &str, session_id: &str, runtime_id: &str) {
        self.live.lock().unwrap().insert(
            (provider.to_string(), session_id.to_string()),
            runtime_id.to_string(),
        );
        self.plans.lock().unwrap().insert(
            (provider.to_string(), session_id.to_string()),
            ProductionFreshResumePlan {
                session_type: match provider {
                    "codex" => freshell_protocol::SessionType::Freshcodex,
                    "opencode" => freshell_protocol::SessionType::Freshopencode,
                    _ => freshell_protocol::SessionType::Freshclaude,
                },
                cwd: None,
                model: None,
                effort: None,
                permission_mode: None,
                sandbox: None,
            },
        );
    }

    fn gate_shutdown_for(
        &self,
        session_id: &str,
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    ) {
        *self.shutdown_gate.lock().unwrap() = Some(RecordedShutdownGate {
            session_id: session_id.to_string(),
            entered,
            release,
        });
    }

    fn set_shutdown_outcome(
        &self,
        provider: &str,
        session_id: &str,
        outcome: freshell_freshagent::RestartShutdownOutcome,
    ) {
        self.shutdown_outcomes
            .lock()
            .unwrap()
            .insert((provider.to_string(), session_id.to_string()), outcome);
    }

    fn releases(&self) -> Vec<(freshell_protocol::AgentProvider, String, String, String)> {
        self.releases.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl ProductionFreshRuntime for ReservationRecordingFreshRuntime {
    async fn has_live_session(
        &self,
        provider: freshell_protocol::AgentProvider,
        session_id: &str,
    ) -> bool {
        self.live
            .lock()
            .unwrap()
            .contains_key(&(provider_name(provider).to_string(), session_id.to_string()))
    }

    async fn shutdown_for_restart(
        &self,
        provider: freshell_protocol::AgentProvider,
        session_id: &str,
        expected_runtime_id: &str,
    ) -> bool {
        let mut live = self.live.lock().unwrap();
        let key = (provider_name(provider).to_string(), session_id.to_string());
        if live.get(&key).map(String::as_str) != Some(expected_runtime_id) {
            return false;
        }
        live.remove(&key);
        true
    }

    /// The recording test world owns no out-of-process OpenCode writer, so a
    /// cross-boot ambiguous-replacement abort quiesces nothing: success with
    /// zero actions (the default "unavailable" answer would block the fence
    /// re-proof convergence lane this seam now exercises).
    async fn recover_opencode_remote_abort(
        &self,
        _session_id: &str,
        _cwd: Option<&str>,
    ) -> freshell_freshagent::RestartShutdownOutcome {
        // No out-of-process writer exists in the recording test world, so
        // "aborted" is the confirmed end state (the coordinator-only `Stale`
        // path is exercised separately by the missing-session tests).
        freshell_freshagent::RestartShutdownOutcome::Stopped
    }

    async fn shutdown_reserved_for_restart_detailed(
        &self,
        provider: freshell_protocol::AgentProvider,
        session_id: &str,
        expected_runtime_id: &str,
        reservation_token: Option<&str>,
    ) -> freshell_freshagent::RestartShutdownOutcome {
        let key = (provider_name(provider).to_string(), session_id.to_string());
        if let Some(outcome) = self.shutdown_outcomes.lock().unwrap().get(&key).cloned() {
            return outcome;
        }
        let gate = self.shutdown_gate.lock().unwrap().clone();
        if let Some(gate) = gate.filter(|gate| gate.session_id == session_id) {
            gate.entered.notify_one();
            gate.release.notified().await;
        }
        // The adapter hands the exact reservation token its plan recorded at
        // preflight; only OpenCode plans carry one.
        assert_eq!(
            reservation_token.is_some(),
            provider == freshell_protocol::AgentProvider::Opencode
        );
        let mut live = self.live.lock().unwrap();
        if live.get(&key).map(String::as_str) != Some(expected_runtime_id) {
            return freshell_freshagent::RestartShutdownOutcome::Stale;
        }
        live.remove(&key);
        freshell_freshagent::RestartShutdownOutcome::Stopped
    }

    async fn capture_resume_plan(
        &self,
        provider: freshell_protocol::AgentProvider,
        session_id: &str,
        _expected_runtime_id: &str,
    ) -> Option<ProductionFreshResumePlan> {
        self.plans
            .lock()
            .unwrap()
            .get(&(provider_name(provider).to_string(), session_id.to_string()))
            .cloned()
    }

    async fn reserve_restart_preflight(
        &self,
        provider: freshell_protocol::AgentProvider,
        session_id: &str,
        expected_runtime_id: &str,
        reservation_token: &str,
    ) -> Result<ProductionFreshPreflight, String> {
        if !self.has_live_session(provider, session_id).await {
            return Err("selected fresh-agent runtime is no longer live".to_string());
        }
        let plan = self
            .capture_resume_plan(provider, session_id, expected_runtime_id)
            .await
            .ok_or_else(|| "selected fresh-agent runtime settings are unavailable".to_string())?;
        // Only the OpenCode lane holds a provider-side reservation.
        let token = (provider == freshell_protocol::AgentProvider::Opencode)
            .then(|| reservation_token.to_string());
        if let Some(token) = &token {
            self.reservations.lock().unwrap().push((
                session_id.to_string(),
                expected_runtime_id.to_string(),
                token.clone(),
            ));
        }
        Ok(ProductionFreshPreflight {
            plan,
            actions: Vec::new(),
            reservation_token: token,
        })
    }

    async fn release_restart_preflight(
        &self,
        provider: freshell_protocol::AgentProvider,
        session_id: &str,
        expected_runtime_id: &str,
        reservation_token: &str,
    ) {
        self.releases.lock().unwrap().push((
            provider,
            session_id.to_string(),
            expected_runtime_id.to_string(),
            reservation_token.to_string(),
        ));
    }

    async fn handle_create(
        &self,
        provider: freshell_protocol::AgentProvider,
        create: freshell_protocol::FreshAgentCreate,
    ) {
        let durable_id = create
            .resume_session_id
            .as_deref()
            .expect("production restart must use the resume path");
        let provider = provider_name(provider);
        let runtime_id = format!("fresh-{provider}-replacement-{durable_id}");
        let runtime = self.coordinator.register_initial(
            RuntimeLocator::new(AgentRuntimeKind::FreshAgent, provider, durable_id),
            &runtime_id,
        );
        self.live
            .lock()
            .unwrap()
            .insert((provider.to_string(), durable_id.to_string()), runtime_id);
        let created = ServerMessage::FreshAgentCreated(FreshAgentCreated {
            provider: provider.to_string(),
            request_id: create.request_id,
            runtime_provider: provider.to_string(),
            session_id: durable_id.to_string(),
            session_type: match create.session_type {
                freshell_protocol::SessionType::Freshclaude => "freshclaude",
                freshell_protocol::SessionType::Kilroy => "kilroy",
                freshell_protocol::SessionType::Freshcodex => "freshcodex",
                freshell_protocol::SessionType::Freshopencode => "freshopencode",
            }
            .to_string(),
            session_ref: create.session_ref,
            runtime: Some(runtime),
        });
        self.broadcast_tx
            .send(serde_json::to_string(&created).unwrap())
            .unwrap();
    }
}

/// LB-12: direct host paths (the recovery adapter, concurrent door races) can
/// reach `ProductionRestartRuntime::preflight` without crossing the Task-7
/// ingress caps. More than the 1,024-wide retired/history bound of such
/// preflights must never evict an in-flight transaction's active plan. The
/// flood's OpenCode plans all hold reservations, so the pre-fix eviction —
/// which skipped reservation holders — deterministically selected the held
/// transaction's non-reservation plan.
#[tokio::test]
async fn active_plan_survives_preflight_flood_from_other_requests() {
    let (_url, registry, mut state) = common::spawn_server_with_specs_and_state(vec![]).await;
    state.session_existence = Arc::new(PresentSessions);
    let durable_id = "durable-flood-held".to_string();
    let old_runtime_id = "fresh-claude-flood-held-old".to_string();
    let locator = RuntimeLocator::new(AgentRuntimeKind::FreshAgent, "claude", durable_id.clone());
    let old = state.restart.register_initial(locator, &old_runtime_id);
    let fresh_runtime = Arc::new(ReservationRecordingFreshRuntime::new(
        state.restart.clone(),
        Arc::clone(&state.broadcast_tx),
    ));
    fresh_runtime.enroll_live_session("claude", &durable_id, &old_runtime_id);
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    fresh_runtime.gate_shutdown_for(&durable_id, Arc::clone(&entered), Arc::clone(&release));
    let production = Arc::new(
        freshell_ws::restart::ProductionRestartRuntime::with_fresh_runtime(
            state.clone(),
            fresh_runtime.clone(),
        ),
    );
    let _registration = state.restart.set_runtime(production.clone());
    let request = AgentRestart {
        request_id: "flood-held".to_string(),
        provider: "claude".to_string(),
        session_id: durable_id.clone(),
        kind: AgentRuntimeKind::FreshAgent,
        live_id: old_runtime_id.clone(),
        expected_generation: old.generation,
    };
    let driver = {
        let restart = state.restart.clone();
        let request = request.clone();
        tokio::spawn(async move { restart.execute_registered(request, |_| {}).await })
    };
    // The held transaction is now parked mid-shutdown: preflight inserted its
    // active plan, replacement creation has not consumed it.
    entered.notified().await;

    for index in 0..(1_024 + 8) {
        let flood = AgentRestart {
            request_id: format!("flood-{index}"),
            provider: "opencode".to_string(),
            session_id: format!("durable-flood-{index}"),
            kind: AgentRuntimeKind::FreshAgent,
            live_id: format!("fresh-opencode-flood-{index}"),
            expected_generation: 1,
        };
        fresh_runtime.enroll_live_session("opencode", &flood.session_id, &flood.live_id);
        RestartRuntime::preflight(production.as_ref(), &flood)
            .await
            .expect("a direct preflight beyond the retired/history bound still admits");
    }

    release.notify_one();
    let outcome = driver.await.expect("held transaction task");
    assert!(
        matches!(
            outcome.messages.last(),
            Some(ServerMessage::AgentRestartReplaced(replaced))
                if replaced.request_id == request.request_id
        ),
        "the held transaction must commit: its active plan was never evicted by the flood: {:?}",
        outcome.messages
    );
    assert!(state.restart.pending_recoveries().is_empty());
    registry.kill_all();
}

/// A committed OpenCode restart must remove its active plan AND release the
/// provider-side preflight reservation with the exact
/// (provider, session, runtime, token) tuple it was acquired under; otherwise
/// the session stays "reserved by another restart" forever (kill/interrupt
/// refused).
#[tokio::test]
async fn commit_removes_plan_and_releases_opencode_preflight_reservation() {
    let (_url, registry, mut state) = common::spawn_server_with_specs_and_state(vec![]).await;
    state.session_existence = Arc::new(PresentSessions);
    let durable_id = "durable-release-commit".to_string();
    let old_runtime_id = "fresh-opencode-release-old".to_string();
    let locator = RuntimeLocator::new(AgentRuntimeKind::FreshAgent, "opencode", durable_id.clone());
    let old = state.restart.register_initial(locator, &old_runtime_id);
    let fresh_runtime = Arc::new(ReservationRecordingFreshRuntime::new(
        state.restart.clone(),
        Arc::clone(&state.broadcast_tx),
    ));
    fresh_runtime.enroll_live_session("opencode", &durable_id, &old_runtime_id);
    let production = Arc::new(
        freshell_ws::restart::ProductionRestartRuntime::with_fresh_runtime(
            state.clone(),
            fresh_runtime.clone(),
        ),
    );
    let _registration = state.restart.set_runtime(production.clone());
    let request = AgentRestart {
        request_id: "release-commit".to_string(),
        provider: "opencode".to_string(),
        session_id: durable_id.clone(),
        kind: AgentRuntimeKind::FreshAgent,
        live_id: old_runtime_id.clone(),
        expected_generation: old.generation,
    };

    let outcome = state
        .restart
        .execute_registered(request.clone(), |_| {})
        .await;

    assert!(
        matches!(
            outcome.messages.last(),
            Some(ServerMessage::AgentRestartReplaced(_))
        ),
        "the restart commits before its release is checked: {:?}",
        outcome.messages
    );
    assert_eq!(
        fresh_runtime.releases(),
        vec![(
            freshell_protocol::AgentProvider::Opencode,
            durable_id.clone(),
            old_runtime_id.clone(),
            format!("restart-preflight:{}", request.request_id),
        )],
        "a committed restart releases its preflight reservation exactly once, with the exact tuple"
    );
    assert!(
        RestartRuntime::persisted_resume_context(production.as_ref(), &request, &()).is_none(),
        "a committed request's active plan is removed"
    );
    assert!(state.restart.pending_recoveries().is_empty());
    registry.kill_all();
}

/// A TERMINAL (non-retryable) shutdown failure is a terminal outcome: the
/// durable row is removed, the plan goes with it, and the OpenCode
/// reservation is released. Compare the retryable counterpart below.
#[tokio::test]
async fn terminal_shutdown_failure_removes_plan_and_releases_reservation() {
    let (_url, registry, mut state) = common::spawn_server_with_specs_and_state(vec![]).await;
    state.session_existence = Arc::new(PresentSessions);
    let durable_id = "durable-release-terminal-failure".to_string();
    let old_runtime_id = "fresh-opencode-terminal-failure-old".to_string();
    let locator = RuntimeLocator::new(AgentRuntimeKind::FreshAgent, "opencode", durable_id.clone());
    let old = state.restart.register_initial(locator, &old_runtime_id);
    let fresh_runtime = Arc::new(ReservationRecordingFreshRuntime::new(
        state.restart.clone(),
        Arc::clone(&state.broadcast_tx),
    ));
    fresh_runtime.enroll_live_session("opencode", &durable_id, &old_runtime_id);
    fresh_runtime.set_shutdown_outcome(
        "opencode",
        &durable_id,
        freshell_freshagent::RestartShutdownOutcome::Stale,
    );
    let production = Arc::new(
        freshell_ws::restart::ProductionRestartRuntime::with_fresh_runtime(
            state.clone(),
            fresh_runtime.clone(),
        ),
    );
    let _registration = state.restart.set_runtime(production.clone());
    let request = AgentRestart {
        request_id: "release-terminal-failure".to_string(),
        provider: "opencode".to_string(),
        session_id: durable_id.clone(),
        kind: AgentRuntimeKind::FreshAgent,
        live_id: old_runtime_id.clone(),
        expected_generation: old.generation,
    };
    assert!(
        RestartRuntime::persisted_resume_context(production.as_ref(), &request, &()).is_none(),
        "no plan exists before preflight"
    );

    let outcome = state
        .restart
        .execute_registered(request.clone(), |_| {})
        .await;

    let Some(ServerMessage::AgentRestartFailed(failed)) = outcome.messages.last() else {
        panic!("terminal shutdown failure expected: {:?}", outcome.messages);
    };
    assert!(
        !failed.retryable,
        "a terminal shutdown failure is not retryable"
    );
    assert!(
        !failed.recovery_pending,
        "a terminal shutdown failure retains no recovery row"
    );
    assert_eq!(
        fresh_runtime.releases(),
        vec![(
            freshell_protocol::AgentProvider::Opencode,
            durable_id.clone(),
            old_runtime_id.clone(),
            format!("restart-preflight:{}", request.request_id),
        )],
        "a terminal shutdown failure releases the reservation it can never use"
    );
    assert!(
        RestartRuntime::persisted_resume_context(production.as_ref(), &request, &()).is_none(),
        "a terminal failure removes the request's active plan"
    );
    assert!(state.restart.pending_recoveries().is_empty());
    registry.kill_all();
}

/// Counterpart: a RETRYABLE shutdown failure keeps the durable row AND the
/// plan, so a same-request retry/redegraded recovery reuses the exact
/// reservation token instead of colliding with "reserved by another restart".
#[tokio::test]
async fn retryable_shutdown_failure_keeps_plan_and_reservation() {
    let (_url, registry, mut state) = common::spawn_server_with_specs_and_state(vec![]).await;
    state.session_existence = Arc::new(PresentSessions);
    let durable_id = "durable-release-retryable".to_string();
    let old_runtime_id = "fresh-opencode-retryable-old".to_string();
    let locator = RuntimeLocator::new(AgentRuntimeKind::FreshAgent, "opencode", durable_id.clone());
    let old = state.restart.register_initial(locator, &old_runtime_id);
    let fresh_runtime = Arc::new(ReservationRecordingFreshRuntime::new(
        state.restart.clone(),
        Arc::clone(&state.broadcast_tx),
    ));
    fresh_runtime.enroll_live_session("opencode", &durable_id, &old_runtime_id);
    fresh_runtime.set_shutdown_outcome(
        "opencode",
        &durable_id,
        freshell_freshagent::RestartShutdownOutcome::RetirementIncomplete {
            message: "degraded remote abort".to_string(),
        },
    );
    let production = Arc::new(
        freshell_ws::restart::ProductionRestartRuntime::with_fresh_runtime(
            state.clone(),
            fresh_runtime.clone(),
        ),
    );
    let _registration = state.restart.set_runtime(production.clone());
    let request = AgentRestart {
        request_id: "release-retryable".to_string(),
        provider: "opencode".to_string(),
        session_id: durable_id.clone(),
        kind: AgentRuntimeKind::FreshAgent,
        live_id: old_runtime_id.clone(),
        expected_generation: old.generation,
    };

    let outcome = state
        .restart
        .execute_registered(request.clone(), |_| {})
        .await;

    let Some(ServerMessage::AgentRestartFailed(failed)) = outcome.messages.last() else {
        panic!(
            "retryable shutdown failure expected: {:?}",
            outcome.messages
        );
    };
    assert!(failed.retryable);
    assert!(
        failed.recovery_pending,
        "a retryable shutdown failure retains its recovery row"
    );
    assert!(
        fresh_runtime.releases().is_empty(),
        "the reservation survives for the retry: {:?}",
        fresh_runtime.releases()
    );
    assert!(
        RestartRuntime::persisted_resume_context(production.as_ref(), &request, &()).is_some(),
        "a retryable failure keeps the request's active plan"
    );
    assert_eq!(state.restart.pending_recoveries().len(), 1);
    registry.kill_all();
}

#[tokio::test]
async fn boot_recovery_runs_through_the_registered_adapter_and_persists_result() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("restart-state.json");
    let request = restart("boot-pending-r1", "term-1", 1);
    let coordinator = RestartCoordinator::new_persistent(path.clone()).unwrap();
    coordinator.register_initial(locator(), "term-1");
    coordinator
        .execute(request.clone(), &ReplacementFails)
        .await;
    drop(coordinator);

    let reopened = RestartCoordinator::new_persistent(path).unwrap();
    let runtime = Arc::new(RecoveringReplacement {
        attempts: AtomicUsize::new(0),
    });
    let _runtime_registration = reopened.set_runtime(runtime.clone());
    let emitted = Mutex::new(Vec::new());
    reopened
        .recover_pending_registered(|message| emitted.lock().unwrap().push(message.clone()))
        .await;

    assert_eq!(runtime.attempts.load(Ordering::SeqCst), 1);
    assert!(reopened.pending_recoveries().is_empty());
    assert!(matches!(
        emitted.lock().unwrap().last(),
        Some(ServerMessage::AgentRestartReplaced(_))
    ));
    let replay = reopened.execute_registered(request, |_| {}).await;
    assert!(replay.replayed);
}

#[tokio::test]
async fn fresh_agent_runtime_is_registered_before_created_broadcast() {
    let coordinator = RestartCoordinator::new();
    let (broadcast_tx, mut broadcast_rx) = tokio::sync::broadcast::channel(16);
    let auth = Arc::new("test-token".to_string());
    let state = freshell_freshagent::FreshOpencodeState::new(
        freshell_freshagent::FreshAgentState::new(auth, Arc::new(broadcast_tx)),
    );
    state.set_runtime_registry(Arc::new(coordinator.clone()));
    let create: freshell_protocol::FreshAgentCreate = serde_json::from_value(serde_json::json!({
        "requestId": "fresh-create-1",
        "sessionType": "freshopencode",
        "provider": "opencode"
    }))
    .unwrap();

    state.handle_create(create, None).await;

    let raw = broadcast_rx.recv().await.unwrap();
    let created: ServerMessage = serde_json::from_str(&raw).unwrap();
    let ServerMessage::FreshAgentCreated(created) = created else {
        panic!("expected freshAgent.created")
    };
    let runtime = created.runtime.expect("runtime is stamped at creation");
    assert!(runtime.runtime_id.starts_with("fresh-runtime-"));
    assert_eq!(
        coordinator.runtime_for_locator(&RuntimeLocator::new(
            AgentRuntimeKind::FreshAgent,
            "opencode",
            "freshopencode-fresh-create-1",
        )),
        Some(runtime)
    );
}

// ---------------------------------------------------------------------------
// Always-on recovery driver (fix 2). The process-lifetime loop in
// `freshell_ws::restart::run_restart_recovery_driver` parks on the
// coordinator's recovery Notify and is woken by every committed transaction
// write that leaves durable pending rows — recovery no longer needs a boot
// pass with pending rows or a browser resend. The two `start_paused` tests
// below are the old main.rs boot-retry driver tests, moved and re-sequenced
// per LB-08 (a spawn with pending rows now drives an immediate first pass, so
// the zero-first-pass assertion requires the shutdown latch to precede the
// spawn).
// ---------------------------------------------------------------------------

/// Real-time bounded poll (LB-08: this suite has no shared wait helper). The
/// driver's wake latency is scheduling-bound, so probe with a deadline instead
/// of assuming a fixed sleep is enough.
async fn wait_until(deadline: std::time::Duration, mut probe: impl FnMut() -> bool) -> bool {
    let until = tokio::time::Instant::now() + deadline;
    while tokio::time::Instant::now() < until {
        if probe() {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    probe()
}

/// Paused-time sibling of `wait_until`: bounded scheduler yields only (no
/// timers), so probing can never move virtual time.
async fn yield_until(mut probe: impl FnMut() -> bool) -> bool {
    for _ in 0..1_000 {
        if probe() {
            return true;
        }
        tokio::task::yield_now().await;
    }
    probe()
}

/// Faithful port of the old main.rs test-module helper (LB-08: recreated
/// suite-local): label + pid + nanos + counter uniqueness for throwaway
/// journal dirs.
fn unique_temp_dir(label: &str) -> std::path::PathBuf {
    static COUNTER: AtomicUsize = AtomicUsize::new(0);
    std::env::temp_dir().join(format!(
        "freshell-restart-driver-{label}-{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ))
}

fn driver_test_locator(session_id: &str) -> RuntimeLocator {
    RuntimeLocator::new(AgentRuntimeKind::Terminal, "claude", session_id)
}

fn driver_test_request(request_id: &str, session_id: &str, live_id: &str) -> AgentRestart {
    AgentRestart {
        request_id: request_id.to_string(),
        provider: "claude".to_string(),
        session_id: session_id.to_string(),
        kind: AgentRuntimeKind::Terminal,
        live_id: live_id.to_string(),
        expected_generation: 1,
    }
}

/// Every direct teardown attempt fails retryably (leaving the durable pending
/// row); the server-owned recovery pass then always retires and replaces
/// successfully. Tracks total runtime traffic so paused-time tests can prove
/// the parked driver does not busy-poll.
struct FlakyThenSucceedRuntime {
    shutdown_calls: AtomicUsize,
    recovery_attempts: AtomicUsize,
    replacements: AtomicUsize,
}

impl FlakyThenSucceedRuntime {
    fn new() -> Self {
        Self {
            shutdown_calls: AtomicUsize::new(0),
            recovery_attempts: AtomicUsize::new(0),
            replacements: AtomicUsize::new(0),
        }
    }

    fn call_count(&self) -> usize {
        self.shutdown_calls.load(Ordering::SeqCst)
            + self.recovery_attempts.load(Ordering::SeqCst)
            + self.replacements.load(Ordering::SeqCst)
    }

    fn succeeded_count(&self) -> usize {
        self.replacements.load(Ordering::SeqCst)
    }
}

#[async_trait::async_trait]
impl RestartRuntime for FlakyThenSucceedRuntime {
    type ResumePlan = ();

    async fn preflight(&self, _request: &AgentRestart) -> Result<(), RestartFailure> {
        Ok(())
    }

    async fn shutdown_for_restart(
        &self,
        _request: &AgentRestart,
        _plan: &(),
    ) -> Result<(), RestartFailure> {
        self.shutdown_calls.fetch_add(1, Ordering::SeqCst);
        Err(RestartFailure::new(
            AgentRestartFailureCode::ShutdownFailed,
            "transient retirement fence failure",
            true,
        ))
    }

    async fn create_replacement(
        &self,
        _request: &AgentRestart,
        _plan: (),
    ) -> Result<String, RestartFailure> {
        unreachable!("retirement never completes on the direct path")
    }

    async fn recover_persisted_retirement(
        &self,
        _request: &AgentRestart,
        _context: Option<&RestartResumeContext>,
        _fence: Option<&RestartRetirementFence>,
    ) -> Result<(), RestartFailure> {
        self.recovery_attempts.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    async fn recover_replacement(
        &self,
        _request: &AgentRestart,
        _context: Option<&RestartResumeContext>,
    ) -> Result<String, RestartFailure> {
        self.replacements.fetch_add(1, Ordering::SeqCst);
        Ok("term-after-runtime-wake".to_string())
    }
}

/// Retirement never completes: every direct teardown fails retryably, so the
/// durable row survives for the driver's recovery passes. (Faithful port of
/// the old main.rs driver-test module local per LB-08.)
struct RetirementAlwaysPending;

#[async_trait::async_trait]
impl RestartRuntime for RetirementAlwaysPending {
    type ResumePlan = ();

    async fn preflight(&self, _request: &AgentRestart) -> Result<(), RestartFailure> {
        Ok(())
    }

    async fn shutdown_for_restart(
        &self,
        _request: &AgentRestart,
        _plan: &(),
    ) -> Result<(), RestartFailure> {
        Err(RestartFailure::new(
            AgentRestartFailureCode::ShutdownFailed,
            "retirement fence is still active",
            true,
        ))
    }

    async fn create_replacement(
        &self,
        _request: &AgentRestart,
        _plan: (),
    ) -> Result<String, RestartFailure> {
        unreachable!("retirement never completed")
    }
}

/// Boot-loadable recovery: `recover_persisted_retirement` fails retryably
/// until `succeeds_on_attempt`, then lets `recover_replacement` finish the
/// row. (Faithful port of the old main.rs driver-test module local per LB-08.)
struct TransientBootRecovery {
    retirement_attempts: AtomicUsize,
    succeeds_on_attempt: usize,
}

#[async_trait::async_trait]
impl RestartRuntime for TransientBootRecovery {
    type ResumePlan = ();

    async fn preflight(&self, _request: &AgentRestart) -> Result<(), RestartFailure> {
        Ok(())
    }

    async fn shutdown_for_restart(
        &self,
        _request: &AgentRestart,
        _plan: &(),
    ) -> Result<(), RestartFailure> {
        unreachable!("boot recovery uses the persisted retirement path")
    }

    async fn create_replacement(
        &self,
        _request: &AgentRestart,
        _plan: (),
    ) -> Result<String, RestartFailure> {
        unreachable!("boot recovery uses recover_replacement")
    }

    async fn recover_persisted_retirement(
        &self,
        _request: &AgentRestart,
        _context: Option<&RestartResumeContext>,
        _fence: Option<&RestartRetirementFence>,
    ) -> Result<(), RestartFailure> {
        let attempt = self.retirement_attempts.fetch_add(1, Ordering::SeqCst) + 1;
        if attempt < self.succeeds_on_attempt {
            Err(RestartFailure::new(
                AgentRestartFailureCode::ShutdownFailed,
                "transient retirement fence failure",
                true,
            ))
        } else {
            Ok(())
        }
    }

    async fn recover_replacement(
        &self,
        _request: &AgentRestart,
        _context: Option<&RestartResumeContext>,
    ) -> Result<String, RestartFailure> {
        Ok("term-after-background-recovery".to_string())
    }
}

#[tokio::test] // real time, bounded
async fn runtime_created_pending_row_wakes_the_recovery_driver() {
    let restart = RestartCoordinator::new(); // in-memory; no persistence needed
    restart.register_initial(
        driver_test_locator("runtime-wake-session"),
        "term-before-runtime-wake",
    );
    let runtime = Arc::new(FlakyThenSucceedRuntime::new());
    let _registration = restart.set_runtime(runtime.clone());
    let shutdown_started = Arc::new(AtomicBool::new(false));
    let shutdown_notify = Arc::new(tokio::sync::Notify::new());
    let emitted = Arc::new(Mutex::new(Vec::new()));
    let emit_sink = Arc::clone(&emitted);
    let driver = tokio::spawn(run_restart_recovery_driver(
        restart.clone(),
        shutdown_started.clone(),
        shutdown_notify.clone(),
        move |message| emit_sink.lock().unwrap().push(message.clone()),
    ));
    // The driver starts with ZERO pending rows — the pre-fix driver exited
    // immediately in that state.
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(!driver.is_finished(), "driver must park, not exit on empty");
    // A normal-runtime failure creates a retryable row (no boot, no browser
    // resend).
    let outcome = restart
        .execute_registered(
            driver_test_request(
                "runtime-wake-r1",
                "runtime-wake-session",
                "term-before-runtime-wake",
            ),
            |_| {},
        )
        .await;
    assert!(
        matches!(
            outcome.messages.last(),
            Some(ServerMessage::AgentRestartFailed(failed)) if failed.retryable && failed.recovery_pending
        ),
        "the runtime failure must leave a retryable durable row: {:?}",
        outcome.messages
    );
    // The driver wakes on the Notify and finishes the row by itself.
    assert!(
        wait_until(std::time::Duration::from_secs(5), || restart
            .pending_recoveries()
            .is_empty())
        .await,
        "the always-on driver must drain a runtime-created pending row with no browser resend"
    );
    assert!(
        runtime.succeeded_count() >= 1,
        "the drained row must end in a recovered replacement"
    );
    // The moved driver keeps the exact emit threading main.rs had: the
    // recovery terminal result reaches the sink the caller handed the driver.
    assert!(
        wait_until(std::time::Duration::from_secs(1), || {
            emitted.lock().unwrap().iter().any(|message| {
                matches!(
                    message,
                    ServerMessage::AgentRestartReplaced(replaced)
                        if replaced.runtime.runtime_id == "term-after-runtime-wake"
                )
            })
        })
        .await,
        "recovery results must flow through the driver's emit sink"
    );
    // Shutdown edge (LB-07 evidence): `notify_waiters` stores no permit, so
    // the driver re-checks the latch after every select arm and must exit
    // promptly even when the notify lands between iterations.
    shutdown_started.store(true, Ordering::SeqCst);
    shutdown_notify.notify_waiters();
    tokio::time::timeout(std::time::Duration::from_secs(2), driver)
        .await
        .expect("driver exits on shutdown")
        .expect("driver task did not panic");
    drop(_registration);
}

/// Paused-time sibling: a parked (or drained) driver never busy-polls. After
/// each wake+drain the runtime call count stays flat across a virtual minute
/// until the NEXT runtime-created row wakes it again.
#[tokio::test(start_paused = true)]
async fn parked_recovery_driver_does_not_busy_poll_between_wakes() {
    let restart = RestartCoordinator::new();
    restart.register_initial(
        driver_test_locator("parked-session-a"),
        "term-before-park-a",
    );
    let runtime = Arc::new(FlakyThenSucceedRuntime::new());
    let _registration = restart.set_runtime(runtime.clone());
    let shutdown_started = Arc::new(AtomicBool::new(false));
    let shutdown_notify = Arc::new(tokio::sync::Notify::new());
    let driver = tokio::spawn(run_restart_recovery_driver(
        restart.clone(),
        shutdown_started.clone(),
        shutdown_notify.clone(),
        |_| {},
    ));
    // Parked on empty: scheduler yields alone must not produce any runtime
    // traffic, and the driver must not exit.
    assert!(
        !yield_until(|| driver.is_finished()).await,
        "driver must park, not exit on empty"
    );
    assert_eq!(runtime.call_count(), 0);

    // Wake #1: a runtime-created retryable row drains with no time advance.
    restart
        .execute_registered(
            driver_test_request("park-a-r1", "parked-session-a", "term-before-park-a"),
            |_| {},
        )
        .await;
    assert!(
        yield_until(|| runtime.succeeded_count() >= 1).await,
        "the notify wake must drive the pass without advancing time"
    );
    assert!(restart.pending_recoveries().is_empty());
    let settled = runtime.call_count();

    // A virtual minute of silence: still no traffic, still parked (not exited).
    tokio::time::advance(std::time::Duration::from_secs(60)).await;
    tokio::task::yield_now().await;
    assert_eq!(
        runtime.call_count(),
        settled,
        "the parked driver must not busy-poll between wakes"
    );
    assert!(
        !driver.is_finished(),
        "the driver stays alive and parked after a drain"
    );

    // Wake #2: another runtime-created row drains again without time passing.
    restart.register_initial(
        driver_test_locator("parked-session-b"),
        "term-before-park-b",
    );
    restart
        .execute_registered(
            driver_test_request("park-b-r1", "parked-session-b", "term-before-park-b"),
            |_| {},
        )
        .await;
    assert!(
        yield_until(|| runtime.succeeded_count() >= 2).await,
        "the next wake must drive without advancing time"
    );
    assert!(restart.pending_recoveries().is_empty());

    shutdown_started.store(true, Ordering::SeqCst);
    shutdown_notify.notify_waiters();
    driver.await.expect("driver exits on shutdown");
    drop(_registration);
}

/// A browser may disappear with the server process that initiated a restart.
/// Boot-loaded retryable rows must still finish under the always-on driver
/// with the old backoff shape, re-sequenced for the new spawn behavior
/// (LB-08): an immediate first pass while rows exist, then a doubling delay,
/// then a park — never a busy-loop.
#[tokio::test(start_paused = true)]
async fn recovery_driver_continues_retryable_boot_recovery_with_backoff() {
    let restart_dir = unique_temp_dir("restart-background-retry");
    let restart_path = restart_dir.join("restart-state.json");
    let coordinator = RestartCoordinator::new_persistent(restart_path.clone()).unwrap();
    coordinator.register_initial(
        driver_test_locator("background-retry-session"),
        "term-before-background-retry",
    );
    coordinator
        .execute(
            driver_test_request(
                "background-retry-r1",
                "background-retry-session",
                "term-before-background-retry",
            ),
            &RetirementAlwaysPending,
        )
        .await;
    assert_eq!(coordinator.pending_recoveries().len(), 1);
    drop(coordinator);

    let coordinator = RestartCoordinator::new_persistent(restart_path).unwrap();
    assert_eq!(
        coordinator.pending_recoveries().len(),
        1,
        "the next server boot must inherit the unfinished transaction"
    );
    let runtime = Arc::new(TransientBootRecovery {
        retirement_attempts: AtomicUsize::new(0),
        succeeds_on_attempt: 3,
    });
    let _registration = coordinator.set_runtime(runtime.clone());

    // The boot pass (main.rs keeps `complete_restart_boot_recovery`; a direct
    // registered recovery pass is the same attempt against the public API):
    // the first recovery attempt still fails retryably.
    coordinator.recover_pending_registered(|_| {}).await;
    assert_eq!(runtime.retirement_attempts.load(Ordering::SeqCst), 1);
    assert_eq!(coordinator.pending_recoveries().len(), 1);

    let shutdown_notify = Arc::new(tokio::sync::Notify::new());
    let shutdown_started = Arc::new(AtomicBool::new(false));
    let driver = tokio::spawn(run_restart_recovery_driver(
        coordinator.clone(),
        shutdown_started.clone(),
        shutdown_notify.clone(),
        |_| {},
    ));

    // RE-SEQUENCED (LB-08): a spawn with a pending row drives an immediate
    // first pass — the old driver slept `initial_delay` before attempting.
    assert!(
        yield_until(|| runtime.retirement_attempts.load(Ordering::SeqCst) == 2).await,
        "spawn with a pending row must drive an immediate first pass"
    );
    assert_eq!(coordinator.pending_recoveries().len(), 1);

    // The failed pass backs the next attempt off (initial 1s doubled to 2s):
    // within that window the driver must not busy-loop.
    tokio::time::advance(std::time::Duration::from_millis(1_999)).await;
    tokio::task::yield_now().await;
    assert_eq!(
        runtime.retirement_attempts.load(Ordering::SeqCst),
        2,
        "the driver must back off between failed passes, not busy-loop"
    );
    tokio::time::advance(std::time::Duration::from_millis(1)).await;
    assert!(
        yield_until(|| runtime.retirement_attempts.load(Ordering::SeqCst) == 3).await,
        "the next pass fires when the backoff expires"
    );
    assert!(
        yield_until(|| coordinator.pending_recoveries().is_empty()).await,
        "server-owned recovery must release the durable session reservation"
    );

    // Drained: the driver parks instead of exiting (always-on) and stays quiet.
    tokio::time::advance(std::time::Duration::from_secs(60)).await;
    tokio::task::yield_now().await;
    assert_eq!(runtime.retirement_attempts.load(Ordering::SeqCst), 3);
    assert!(
        !driver.is_finished(),
        "the driver parks after draining instead of exiting"
    );

    shutdown_started.store(true, Ordering::SeqCst);
    shutdown_notify.notify_waiters();
    driver.await.expect("driver exits on shutdown");
    drop(_registration);
    drop(coordinator);
    std::fs::remove_dir_all(restart_dir).ok();
}

/// Shutdown stops the driver without touching the durable journal, so the
/// next boot inherits the unfinished transaction. RE-SEQUENCED per LB-08:
/// because a spawn with pending rows now drives an immediate first pass, the
/// shutdown latch must be set BEFORE the spawn for the zero-attempts
/// assertion to hold (the loop-top latch check guarantees no pass starts).
#[tokio::test(start_paused = true)]
async fn recovery_driver_stops_when_shutdown_precedes_spawn() {
    let restart_dir = unique_temp_dir("restart-background-shutdown");
    let restart_path = restart_dir.join("restart-state.json");
    let coordinator = RestartCoordinator::new_persistent(restart_path.clone()).unwrap();
    coordinator.register_initial(
        driver_test_locator("shutdown-session"),
        "term-before-shutdown",
    );
    coordinator
        .execute(
            driver_test_request(
                "shutdown-retry-r1",
                "shutdown-session",
                "term-before-shutdown",
            ),
            &RetirementAlwaysPending,
        )
        .await;
    assert_eq!(coordinator.pending_recoveries().len(), 1);
    let runtime = Arc::new(TransientBootRecovery {
        retirement_attempts: AtomicUsize::new(0),
        succeeds_on_attempt: usize::MAX,
    });
    let _registration = coordinator.set_runtime(runtime.clone());
    let shutdown_notify = Arc::new(tokio::sync::Notify::new());
    let shutdown_started = Arc::new(AtomicBool::new(false));

    // Latch BEFORE spawn (LB-08). The old driver slept `initial_delay` first,
    // so a post-spawn latch still observed zero attempts; the always-on
    // driver's immediate first pass requires this ordering instead.
    shutdown_started.store(true, Ordering::SeqCst);
    shutdown_notify.notify_waiters();
    let driver = tokio::spawn(run_restart_recovery_driver(
        coordinator.clone(),
        shutdown_started.clone(),
        shutdown_notify.clone(),
        |_| {},
    ));

    driver.await.unwrap();
    tokio::time::advance(std::time::Duration::from_secs(10)).await;

    assert_eq!(runtime.retirement_attempts.load(Ordering::SeqCst), 0);
    assert_eq!(
        coordinator.pending_recoveries().len(),
        1,
        "shutdown preserves the durable transaction for the next boot"
    );
    drop(_registration);
    drop(coordinator);

    let reopened = RestartCoordinator::new_persistent(restart_path).unwrap();
    assert_eq!(
        reopened.pending_recoveries().len(),
        1,
        "the next server boot must inherit the unfinished transaction"
    );
    drop(reopened);
    std::fs::remove_dir_all(restart_dir).ok();
}

// ---------------------------------------------------------------------------
// Indeterminate durable-commit semantics (fix 3). A journal rename that lands
// but whose parent-directory fsync fails leaves the transaction record
// durable-maybe: the coordinator must stay fail-closed (retain the pending
// row through the fail-closed union merge), report `recovery_pending: true`
// without proceeding, and let the always-on driver converge the retained row
// once the directory can be re-synced.
// ---------------------------------------------------------------------------

/// Parent-directory sync injection for the indeterminate-commit tests: every
/// invocation consumes one latched failure; with an empty budget the sync
/// succeeds. Tests arm the budget at the exact phase they want to fault.
struct ParentSyncFault {
    latched: AtomicUsize,
}

impl ParentSyncFault {
    fn latch(&self, failures: usize) {
        self.latched.store(failures, Ordering::SeqCst);
    }

    fn gate(self: &Arc<Self>) -> JournalParentSync {
        let this = Arc::clone(self);
        Arc::new(move |_parent: &Path| {
            if this
                .latched
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |remaining| {
                    remaining.checked_sub(1)
                })
                .is_ok()
            {
                return Err(std::io::Error::other("injected directory sync failure"));
            }
            Ok(())
        })
    }
}

/// Records the lifecycle calls a fail-closed indeterminate write must and must
/// not make. The default recovery seams re-drive preflight/shutdown/create, so
/// the same recorder serves the direct pass and the driver's convergence pass.
struct IndeterminateRecorderRuntime {
    aborts: AtomicUsize,
    shutdowns: AtomicUsize,
    creates: AtomicUsize,
    replacement_id: &'static str,
    arm_on_create: Option<Arc<ParentSyncFault>>,
}

impl IndeterminateRecorderRuntime {
    fn new(replacement_id: &'static str) -> Self {
        Self {
            aborts: AtomicUsize::new(0),
            shutdowns: AtomicUsize::new(0),
            creates: AtomicUsize::new(0),
            replacement_id,
            arm_on_create: None,
        }
    }

    /// Latch exactly one sync fault at replacement-creation time, so the very
    /// next journal write — the replacement commit — is the indeterminate one.
    fn arming_on_create(mut self, fault: &Arc<ParentSyncFault>) -> Self {
        self.arm_on_create = Some(Arc::clone(fault));
        self
    }
}

#[async_trait::async_trait]
impl RestartRuntime for IndeterminateRecorderRuntime {
    type ResumePlan = ();

    async fn preflight(&self, _request: &AgentRestart) -> Result<(), RestartFailure> {
        Ok(())
    }

    async fn abort_preflight(&self, _request: &AgentRestart, _plan: &()) {
        self.aborts.fetch_add(1, Ordering::SeqCst);
    }

    async fn shutdown_for_restart(
        &self,
        _request: &AgentRestart,
        _plan: &(),
    ) -> Result<(), RestartFailure> {
        self.shutdowns.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    async fn create_replacement(
        &self,
        _request: &AgentRestart,
        _plan: (),
    ) -> Result<String, RestartFailure> {
        if let Some(fault) = &self.arm_on_create {
            fault.latch(1);
        }
        self.creates.fetch_add(1, Ordering::SeqCst);
        Ok(self.replacement_id.to_string())
    }
}

#[tokio::test] // real time, bounded (drives the always-on recovery driver)
async fn indeterminate_journal_write_during_record_shutdown_pending_keeps_row_and_reports_recovery_pending(
) {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("restart-state.json");
    let fault = Arc::new(ParentSyncFault {
        latched: AtomicUsize::new(0),
    });
    let coordinator = RestartCoordinator::new_persistent_with_test_parent_sync(
        path.clone(),
        16,
        16,
        RestartIngressLimits::default(),
        fault.gate(),
    )
    .unwrap();
    coordinator.register_initial(locator(), "term-1");
    let runtime = Arc::new(IndeterminateRecorderRuntime::new(
        "term-after-indeterminate-add",
    ));
    let _registration = coordinator.set_runtime(runtime.clone());
    let emitted = Arc::new(Mutex::new(Vec::new()));
    let emit_sink = Arc::clone(&emitted);

    // The fault is latched for exactly the add-side write (the registration
    // above committed clean against an empty budget).
    fault.latch(1);
    let request = restart("indeterminate-add-r1", "term-1", 1);
    let outcome = coordinator
        .execute_registered(request, move |message| {
            emit_sink.lock().unwrap().push(message.clone());
        })
        .await;

    // One durable-maybe frame and no phase progression: the rename landed, so
    // the row is retained (fail-closed) instead of the candidate being
    // discarded, and teardown must not begin this pass.
    assert!(
        matches!(
            outcome.messages.as_slice(),
            [ServerMessage::AgentRestartFailed(failed)]
                if failed.request_id == "indeterminate-add-r1"
                    && failed.retryable
                    && failed.recovery_pending
        ),
        "the add-side indeterminate write must surface one retryable recovery-pending failure: {:?}",
        outcome.messages
    );
    assert!(
        !outcome.messages.iter().any(|message| matches!(
            message,
            ServerMessage::AgentRestartStarted(_) | ServerMessage::AgentRestartReplaced(_)
        )),
        "no started/replaced phase may be emitted for an indeterminate add"
    );
    assert_eq!(
        runtime.aborts.load(Ordering::SeqCst),
        0,
        "the preflight reservation must NOT be aborted: the retained row owns it"
    );
    assert_eq!(
        runtime.shutdowns.load(Ordering::SeqCst),
        0,
        "teardown must not begin while the boundary write is indeterminate"
    );
    // Fail-closed on both sides: the row is in memory AND on disk (the rename
    // landed even though the directory sync failed).
    let pending = coordinator.pending_recoveries();
    assert!(
        pending
            .iter()
            .any(|row| row.request_id == "indeterminate-add-r1" && row.retirement_pending),
        "the indeterminate add must retain the pending row in memory: {pending:?}"
    );
    let journal = std::fs::read_to_string(&path).unwrap();
    assert!(
        journal.contains("indeterminate-add-r1"),
        "the rename landed, so the journal already names the retained row"
    );

    // The always-on driver re-drives the retained row with no browser resend;
    // the single latched fault is spent, so recovery commits clean.
    let shutdown_started = Arc::new(AtomicBool::new(false));
    let shutdown_notify = Arc::new(tokio::sync::Notify::new());
    let driver_sink = Arc::clone(&emitted);
    let driver = tokio::spawn(run_restart_recovery_driver(
        coordinator.clone(),
        shutdown_started.clone(),
        shutdown_notify.clone(),
        move |message| driver_sink.lock().unwrap().push(message.clone()),
    ));
    assert!(
        wait_until(std::time::Duration::from_secs(5), || coordinator
            .pending_recoveries()
            .is_empty())
        .await,
        "the driver must drain the retained row once the fault is spent"
    );
    assert_eq!(
        runtime.shutdowns.load(Ordering::SeqCst),
        1,
        "recovery runs teardown exactly once for the retained row"
    );
    assert_eq!(runtime.aborts.load(Ordering::SeqCst), 0);
    assert!(
        wait_until(std::time::Duration::from_secs(1), || {
            emitted.lock().unwrap().iter().any(|message| {
                matches!(
                    message,
                    ServerMessage::AgentRestartReplaced(replaced)
                        if replaced.request_id == "indeterminate-add-r1"
                            && replaced.runtime.runtime_id == "term-after-indeterminate-add"
                )
            })
        })
        .await,
        "recovery convergence delivers the replaced frame through the driver sink"
    );

    shutdown_started.store(true, Ordering::SeqCst);
    shutdown_notify.notify_waiters();
    tokio::time::timeout(std::time::Duration::from_secs(2), driver)
        .await
        .expect("driver exits on shutdown")
        .expect("driver task did not panic");
    drop(_registration);
}

#[tokio::test] // real time, bounded (drives the always-on recovery driver)
async fn indeterminate_journal_write_during_commit_keeps_pending_row_and_defers_replaced_frame() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("restart-state.json");
    let fault = Arc::new(ParentSyncFault {
        latched: AtomicUsize::new(0),
    });
    let coordinator = RestartCoordinator::new_persistent_with_test_parent_sync(
        path.clone(),
        16,
        16,
        RestartIngressLimits::default(),
        fault.gate(),
    )
    .unwrap();
    coordinator.register_initial(locator(), "term-1");
    let runtime = Arc::new(
        IndeterminateRecorderRuntime::new("term-after-indeterminate-commit")
            .arming_on_create(&fault),
    );
    let _registration = coordinator.set_runtime(runtime.clone());
    let emitted = Arc::new(Mutex::new(Vec::new()));
    let emit_sink = Arc::clone(&emitted);

    // The add-side and retirement writes commit clean; `create_replacement`
    // latches the fault so exactly the commit write is indeterminate.
    let request = restart("indeterminate-commit-r1", "term-1", 1);
    let outcome = coordinator
        .execute_registered(request.clone(), move |message| {
            emit_sink.lock().unwrap().push(message.clone());
        })
        .await;

    // The replacement exists, but its commit is durable-maybe: the client gets
    // a recovery-pending failure — never a `replaced` frame we cannot prove.
    assert!(
        matches!(
            outcome.messages.as_slice(),
            [ServerMessage::AgentRestartStarted(_), ServerMessage::AgentRestartFailed(failed)]
                if failed.request_id == "indeterminate-commit-r1"
                    && !failed.retryable
                    && failed.recovery_pending
        ),
        "the commit-side indeterminate write must end in a non-retryable recovery-pending failure: {:?}",
        outcome.messages
    );
    assert_eq!(runtime.shutdowns.load(Ordering::SeqCst), 1);
    assert_eq!(runtime.creates.load(Ordering::SeqCst), 1);
    // Fail-closed union merge: the candidate's bindings/results were adopted
    // (the replacement is registered) while the pending row was retained.
    let pending = coordinator.pending_recoveries();
    assert!(
        pending
            .iter()
            .any(|row| row.request_id == "indeterminate-commit-r1"),
        "the indeterminate commit must retain the pending row in memory: {pending:?}"
    );
    assert_eq!(
        coordinator.runtime_for_locator(&locator()),
        Some(RuntimeDescriptor {
            runtime_id: "term-after-indeterminate-commit".to_string(),
            generation: 2,
        }),
        "the fail-closed merge adopts the candidate's replacement binding"
    );

    // The always-on driver converges the retained row through the adoption
    // path (no second teardown, no second spawn).
    let shutdown_started = Arc::new(AtomicBool::new(false));
    let shutdown_notify = Arc::new(tokio::sync::Notify::new());
    let driver_sink = Arc::clone(&emitted);
    let driver = tokio::spawn(run_restart_recovery_driver(
        coordinator.clone(),
        shutdown_started.clone(),
        shutdown_notify.clone(),
        move |message| driver_sink.lock().unwrap().push(message.clone()),
    ));
    assert!(
        wait_until(std::time::Duration::from_secs(5), || coordinator
            .pending_recoveries()
            .is_empty())
        .await,
        "the driver must converge the retained row through adoption"
    );
    assert_eq!(
        runtime.creates.load(Ordering::SeqCst),
        1,
        "convergence adopts the registered replacement instead of spawning again"
    );
    assert_eq!(runtime.shutdowns.load(Ordering::SeqCst), 1);
    assert!(
        wait_until(std::time::Duration::from_secs(1), || {
            emitted.lock().unwrap().iter().any(|message| {
                matches!(
                    message,
                    ServerMessage::AgentRestartReplaced(replaced)
                        if replaced.request_id == "indeterminate-commit-r1"
                            && replaced.runtime.runtime_id == "term-after-indeterminate-commit"
                )
            })
        })
        .await,
        "the deferred replaced frame arrives only after a clean commit"
    );

    // A duplicate of the same request now replays the committed terminal
    // result (the adoption flow's idempotent-convergence contract of
    // pending_retry_adopts_registered_replacement_after_ambiguous_durable_commit).
    let replay = coordinator.execute_registered(request, |_| {}).await;
    assert!(replay.replayed);
    assert!(matches!(
        replay.messages.as_slice(),
        [ServerMessage::AgentRestartReplaced(replaced)]
            if replaced.request_id == "indeterminate-commit-r1"
                && replaced.runtime.runtime_id == "term-after-indeterminate-commit"
    ));

    shutdown_started.store(true, Ordering::SeqCst);
    shutdown_notify.notify_waiters();
    tokio::time::timeout(std::time::Duration::from_secs(2), driver)
        .await
        .expect("driver exits on shutdown")
        .expect("driver task did not panic");
    drop(_registration);
}

/// Wraps the production restart adapter so the commit-write parent-sync fault
/// can be armed at the exact boundary the coordinator will hit NEXT: a
/// SUCCESSFUL replacement creation. Arming inside the create flow would risk
/// an entrant write consuming the latched fault before the commit write runs;
/// arming after an Ok return guarantees the next journal parent sync IS the
/// commit write (matching `IndeterminateRecorderRuntime::arming_on_create`).
/// Every other trait method delegates untouched, and the fault is one-shot so
/// a later recovery create cannot re-arm it.
struct CommitIndeterminateProductionRuntime {
    inner: Arc<freshell_ws::restart::ProductionRestartRuntime>,
    fault: Arc<ParentSyncFault>,
    unspent: AtomicBool,
}

impl CommitIndeterminateProductionRuntime {
    fn new(
        inner: Arc<freshell_ws::restart::ProductionRestartRuntime>,
        fault: Arc<ParentSyncFault>,
    ) -> Self {
        Self {
            inner,
            fault,
            unspent: AtomicBool::new(true),
        }
    }
}

#[async_trait::async_trait]
impl RestartRuntime for CommitIndeterminateProductionRuntime {
    type ResumePlan = ();

    async fn preflight(&self, request: &AgentRestart) -> Result<Self::ResumePlan, RestartFailure> {
        RestartRuntime::preflight(self.inner.as_ref(), request).await
    }

    async fn abort_preflight(&self, request: &AgentRestart, plan: &Self::ResumePlan) {
        RestartRuntime::abort_preflight(self.inner.as_ref(), request, plan).await;
    }

    async fn on_terminal_outcome(&self, request: &AgentRestart) {
        RestartRuntime::on_terminal_outcome(self.inner.as_ref(), request).await;
    }

    async fn shutdown_for_restart(
        &self,
        request: &AgentRestart,
        plan: &Self::ResumePlan,
    ) -> Result<(), RestartFailure> {
        RestartRuntime::shutdown_for_restart(self.inner.as_ref(), request, plan).await
    }

    async fn create_replacement(
        &self,
        request: &AgentRestart,
        plan: Self::ResumePlan,
    ) -> Result<String, RestartFailure> {
        let created = RestartRuntime::create_replacement(self.inner.as_ref(), request, plan).await;
        if created.is_ok() && self.unspent.swap(false, Ordering::SeqCst) {
            self.fault.latch(1);
        }
        created
    }

    fn requires_replacement_fence(&self) -> bool {
        RestartRuntime::requires_replacement_fence(self.inner.as_ref())
    }

    async fn create_replacement_fenced(
        &self,
        request: &AgentRestart,
        plan: Self::ResumePlan,
        fence: Option<&RestartReplacementFence>,
    ) -> Result<String, RestartFailure> {
        let created =
            RestartRuntime::create_replacement_fenced(self.inner.as_ref(), request, plan, fence)
                .await;
        if created.is_ok() && self.unspent.swap(false, Ordering::SeqCst) {
            self.fault.latch(1);
        }
        created
    }

    fn persisted_resume_context(
        &self,
        request: &AgentRestart,
        plan: &Self::ResumePlan,
    ) -> Option<RestartResumeContext> {
        RestartRuntime::persisted_resume_context(self.inner.as_ref(), request, plan)
    }

    fn persisted_retirement_fence(
        &self,
        request: &AgentRestart,
        plan: &Self::ResumePlan,
    ) -> Option<RestartRetirementFence> {
        RestartRuntime::persisted_retirement_fence(self.inner.as_ref(), request, plan)
    }

    async fn recover_replacement(
        &self,
        request: &AgentRestart,
        context: Option<&RestartResumeContext>,
    ) -> Result<String, RestartFailure> {
        RestartRuntime::recover_replacement(self.inner.as_ref(), request, context).await
    }

    async fn recover_ambiguous_replacement(
        &self,
        request: &AgentRestart,
        context: Option<&RestartResumeContext>,
        fence: &RestartReplacementFence,
    ) -> Result<(), RestartFailure> {
        RestartRuntime::recover_ambiguous_replacement(self.inner.as_ref(), request, context, fence)
            .await
    }

    async fn recover_replacement_fenced(
        &self,
        request: &AgentRestart,
        context: Option<&RestartResumeContext>,
        fence: Option<&RestartReplacementFence>,
    ) -> Result<String, RestartFailure> {
        RestartRuntime::recover_replacement_fenced(self.inner.as_ref(), request, context, fence)
            .await
    }

    async fn recover_retirement(
        &self,
        request: &AgentRestart,
        context: Option<&RestartResumeContext>,
    ) -> Result<(), RestartFailure> {
        RestartRuntime::recover_retirement(self.inner.as_ref(), request, context).await
    }

    async fn recover_persisted_retirement(
        &self,
        request: &AgentRestart,
        context: Option<&RestartResumeContext>,
        fence: Option<&RestartRetirementFence>,
    ) -> Result<(), RestartFailure> {
        RestartRuntime::recover_persisted_retirement(self.inner.as_ref(), request, context, fence)
            .await
    }
}

/// Indeterminate durable commit is NOT a terminal outcome (Task 5 / fix 3): the
/// pending row AND the active plan are retained for cross-boot recovery, so
/// the OpenCode preflight reservation must NOT be released at the ambiguous
/// boundary (Task-8 review Minor pin). Only when the always-on driver later
/// converges the retained row to a clean commit does the reservation release
/// fire — exactly once, with the exact tuple.
#[tokio::test] // real time, bounded (drives the always-on recovery driver)
async fn indeterminate_commit_keeps_plan_and_reservation_until_driver_converges() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("restart-state.json");
    let fault = Arc::new(ParentSyncFault {
        latched: AtomicUsize::new(0),
    });
    let (_url, registry, mut state) = common::spawn_server_with_specs_and_state(vec![]).await;
    state.session_existence = Arc::new(PresentSessions);
    let coordinator = RestartCoordinator::new_persistent_with_test_parent_sync(
        path.clone(),
        16,
        16,
        RestartIngressLimits::default(),
        fault.gate(),
    )
    .unwrap();
    // Re-home the test server state on the faulted coordinator BEFORE the
    // production adapter is built, so every internal reference agrees.
    state.restart = coordinator.clone();

    let durable_id = "durable-indeterminate-release".to_string();
    let old_runtime_id = "fresh-opencode-indeterminate-old".to_string();
    let locator = RuntimeLocator::new(AgentRuntimeKind::FreshAgent, "opencode", durable_id.clone());
    let old = coordinator.register_initial(locator, &old_runtime_id);
    let fresh_runtime = Arc::new(ReservationRecordingFreshRuntime::new(
        coordinator.clone(),
        Arc::clone(&state.broadcast_tx),
    ));
    fresh_runtime.enroll_live_session("opencode", &durable_id, &old_runtime_id);
    let production = Arc::new(
        freshell_ws::restart::ProductionRestartRuntime::with_fresh_runtime(
            state.clone(),
            fresh_runtime.clone(),
        ),
    );
    let fragile = Arc::new(CommitIndeterminateProductionRuntime::new(
        production.clone(),
        fault.clone(),
    ));
    let _registration = coordinator.set_runtime(fragile);
    let request = AgentRestart {
        request_id: "indeterminate-release".to_string(),
        provider: "opencode".to_string(),
        session_id: durable_id.clone(),
        kind: AgentRuntimeKind::FreshAgent,
        live_id: old_runtime_id.clone(),
        expected_generation: old.generation,
    };

    let emitted = Arc::new(Mutex::new(Vec::new()));
    let emit_sink = Arc::clone(&emitted);
    let outcome = coordinator
        .execute_registered(request.clone(), move |message| {
            emit_sink.lock().unwrap().push(message.clone());
        })
        .await;

    // Same immediate shape as the recorder test: started, then a non-retryable
    // recovery-pending failure — never a `replaced` frame.
    assert!(
        matches!(
            outcome.messages.as_slice(),
            [ServerMessage::AgentRestartStarted(_), ServerMessage::AgentRestartFailed(failed)]
                if failed.request_id == "indeterminate-release"
                    && !failed.retryable
                    && failed.recovery_pending
        ),
        "the indeterminate commit must end in a non-retryable recovery-pending failure: {:?}",
        outcome.messages
    );

    // THE PIN: the ambiguous boundary is NOT terminal — the reservation is NOT
    // released and the active plan is NOT removed (cross-boot recovery owns both).
    assert!(
        fresh_runtime.releases().is_empty(),
        "an indeterminate commit must NOT release the preflight reservation: {:?}",
        fresh_runtime.releases()
    );
    assert!(
        RestartRuntime::persisted_resume_context(production.as_ref(), &request, &()).is_some(),
        "an indeterminate commit must retain the active plan"
    );
    assert!(
        coordinator
            .pending_recoveries()
            .iter()
            .any(|row| row.request_id == "indeterminate-release"),
        "the pending row is retained for recovery"
    );

    // The driver converges the retained row to a clean commit (fault spent);
    // only then does the single terminal-outcome release fire.
    let shutdown_started = Arc::new(AtomicBool::new(false));
    let shutdown_notify = Arc::new(tokio::sync::Notify::new());
    let driver_sink = Arc::clone(&emitted);
    let driver = tokio::spawn(run_restart_recovery_driver(
        coordinator.clone(),
        shutdown_started.clone(),
        shutdown_notify.clone(),
        move |message| driver_sink.lock().unwrap().push(message.clone()),
    ));
    assert!(
        wait_until(std::time::Duration::from_secs(5), || coordinator
            .pending_recoveries()
            .is_empty())
        .await,
        "the driver must converge the retained row to a clean commit"
    );
    assert_eq!(
        fresh_runtime.releases(),
        vec![(
            freshell_protocol::AgentProvider::Opencode,
            durable_id.clone(),
            old_runtime_id.clone(),
            format!("restart-preflight:{}", request.request_id),
        )],
        "the reservation is released exactly once, on the converged terminal commit"
    );
    assert!(
        RestartRuntime::persisted_resume_context(production.as_ref(), &request, &()).is_none(),
        "the converged commit removes the active plan"
    );

    shutdown_started.store(true, Ordering::SeqCst);
    shutdown_notify.notify_waiters();
    tokio::time::timeout(std::time::Duration::from_secs(2), driver)
        .await
        .expect("driver exits on shutdown")
        .expect("driver task did not panic");
    drop(_registration);
    registry.kill_all();
}

/// Counting wrapper over the production adapter for the fence-defer test:
/// records `create` entries and the parent-sync counter value at the first
/// create — in a faultless pass that count IS the fence write's sync ordinal
/// (the fence write is the last journal write before fenced replacement
/// creation). Every trait method delegates untouched.
struct CreateOrdinalRecordingRuntime {
    inner: Arc<freshell_ws::restart::ProductionRestartRuntime>,
    syncs: Arc<AtomicUsize>,
    syncs_at_first_create: Arc<AtomicUsize>,
    creates: Arc<AtomicUsize>,
}

impl CreateOrdinalRecordingRuntime {
    fn record_create_entry(&self) {
        self.creates.fetch_add(1, Ordering::SeqCst);
        self.syncs_at_first_create
            .store(self.syncs.load(Ordering::SeqCst), Ordering::SeqCst);
    }
}

#[async_trait::async_trait]
impl RestartRuntime for CreateOrdinalRecordingRuntime {
    type ResumePlan = ();

    async fn preflight(&self, request: &AgentRestart) -> Result<Self::ResumePlan, RestartFailure> {
        RestartRuntime::preflight(self.inner.as_ref(), request).await
    }

    async fn abort_preflight(&self, request: &AgentRestart, plan: &Self::ResumePlan) {
        RestartRuntime::abort_preflight(self.inner.as_ref(), request, plan).await;
    }

    async fn on_terminal_outcome(&self, request: &AgentRestart) {
        RestartRuntime::on_terminal_outcome(self.inner.as_ref(), request).await;
    }

    async fn shutdown_for_restart(
        &self,
        request: &AgentRestart,
        plan: &Self::ResumePlan,
    ) -> Result<(), RestartFailure> {
        RestartRuntime::shutdown_for_restart(self.inner.as_ref(), request, plan).await
    }

    async fn create_replacement(
        &self,
        request: &AgentRestart,
        plan: Self::ResumePlan,
    ) -> Result<String, RestartFailure> {
        self.record_create_entry();
        RestartRuntime::create_replacement(self.inner.as_ref(), request, plan).await
    }

    fn requires_replacement_fence(&self) -> bool {
        RestartRuntime::requires_replacement_fence(self.inner.as_ref())
    }

    async fn create_replacement_fenced(
        &self,
        request: &AgentRestart,
        plan: Self::ResumePlan,
        fence: Option<&RestartReplacementFence>,
    ) -> Result<String, RestartFailure> {
        self.record_create_entry();
        RestartRuntime::create_replacement_fenced(self.inner.as_ref(), request, plan, fence).await
    }

    fn persisted_resume_context(
        &self,
        request: &AgentRestart,
        plan: &Self::ResumePlan,
    ) -> Option<RestartResumeContext> {
        RestartRuntime::persisted_resume_context(self.inner.as_ref(), request, plan)
    }

    fn persisted_retirement_fence(
        &self,
        request: &AgentRestart,
        plan: &Self::ResumePlan,
    ) -> Option<RestartRetirementFence> {
        RestartRuntime::persisted_retirement_fence(self.inner.as_ref(), request, plan)
    }

    async fn recover_replacement(
        &self,
        request: &AgentRestart,
        context: Option<&RestartResumeContext>,
    ) -> Result<String, RestartFailure> {
        self.record_create_entry();
        RestartRuntime::recover_replacement(self.inner.as_ref(), request, context).await
    }

    async fn recover_ambiguous_replacement(
        &self,
        request: &AgentRestart,
        context: Option<&RestartResumeContext>,
        fence: &RestartReplacementFence,
    ) -> Result<(), RestartFailure> {
        RestartRuntime::recover_ambiguous_replacement(self.inner.as_ref(), request, context, fence)
            .await
    }

    async fn recover_replacement_fenced(
        &self,
        request: &AgentRestart,
        context: Option<&RestartResumeContext>,
        fence: Option<&RestartReplacementFence>,
    ) -> Result<String, RestartFailure> {
        self.record_create_entry();
        RestartRuntime::recover_replacement_fenced(self.inner.as_ref(), request, context, fence)
            .await
    }

    async fn recover_retirement(
        &self,
        request: &AgentRestart,
        context: Option<&RestartResumeContext>,
    ) -> Result<(), RestartFailure> {
        RestartRuntime::recover_retirement(self.inner.as_ref(), request, context).await
    }

    async fn recover_persisted_retirement(
        &self,
        request: &AgentRestart,
        context: Option<&RestartResumeContext>,
        fence: Option<&RestartRetirementFence>,
    ) -> Result<(), RestartFailure> {
        RestartRuntime::recover_persisted_retirement(self.inner.as_ref(), request, context, fence)
            .await
    }
}

/// Shared scenario builder for the fence-defer test: a scratch-server state
/// re-homed onto a persistent coordinator whose parent-sync gate is supplied
/// by the test, plus the production adapter behind the ordinal recorder.
#[allow(clippy::type_complexity)]
async fn fence_defer_scenario(
    gate: freshell_ws::restart::JournalParentSync,
    syncs: Arc<AtomicUsize>,
    syncs_at_first_create: Arc<AtomicUsize>,
    creates: Arc<AtomicUsize>,
) -> (
    RestartCoordinator,
    Arc<ReservationRecordingFreshRuntime>,
    Arc<freshell_ws::restart::ProductionRestartRuntime>,
    AgentRestart,
    freshell_ws::restart::RestartRuntimeRegistration,
    freshell_ws::WsState,
    freshell_terminal::TerminalRegistry,
    tempfile::TempDir,
) {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("restart-state.json");
    let coordinator = RestartCoordinator::new_persistent_with_test_parent_sync(
        path,
        16,
        16,
        RestartIngressLimits::default(),
        gate,
    )
    .unwrap();
    let (_url, registry, mut state) = common::spawn_server_with_specs_and_state(vec![]).await;
    state.session_existence = Arc::new(PresentSessions);
    state.restart = coordinator.clone();

    let durable_id = "durable-fence-defer".to_string();
    let old_runtime_id = "fresh-opencode-fence-defer-old".to_string();
    let locator = RuntimeLocator::new(AgentRuntimeKind::FreshAgent, "opencode", durable_id.clone());
    let old = coordinator.register_initial(locator, &old_runtime_id);
    let fresh_runtime = Arc::new(ReservationRecordingFreshRuntime::new(
        coordinator.clone(),
        Arc::clone(&state.broadcast_tx),
    ));
    fresh_runtime.enroll_live_session("opencode", &durable_id, &old_runtime_id);
    let production = Arc::new(
        freshell_ws::restart::ProductionRestartRuntime::with_fresh_runtime(
            state.clone(),
            fresh_runtime.clone(),
        ),
    );
    let wrapper = Arc::new(CreateOrdinalRecordingRuntime {
        inner: production.clone(),
        syncs,
        syncs_at_first_create,
        creates,
    });
    let registration: freshell_ws::restart::RestartRuntimeRegistration =
        coordinator.set_runtime(wrapper);
    let request = AgentRestart {
        request_id: "fence-defer".to_string(),
        provider: "opencode".to_string(),
        session_id: durable_id,
        kind: AgentRuntimeKind::FreshAgent,
        live_id: old_runtime_id,
        expected_generation: old.generation,
    };
    (
        coordinator,
        fresh_runtime,
        production,
        request,
        registration,
        state,
        registry,
        temp,
    )
}

/// Whole-branch review I-1 (fix 3 contract): the replacement fence is the
/// provenance boot recovery uses to quiesce a post-crash ambiguous writer —
/// its write is therefore inside the indeterminate-commit contract. An
/// INDETERMINATE fence write must NOT proceed to spawn: defer retryable +
/// recovery_pending, retain the row, keep the plan/reservation, and re-drive
/// through the always-on driver, which re-proves the journal directory before
/// trusting the fence.
#[tokio::test] // real time, bounded (drives the always-on recovery driver)
async fn indeterminate_replacement_fence_write_defers_spawn_until_reproven() {
    // Phase A — calibrate the fence write's parent-sync ordinal: run an
    // unfaulted pass and read the sync counter at the first replacement
    // creation (the fence write is the last journal write before it).
    let syncs = Arc::new(AtomicUsize::new(0));
    let syncs_at_first_create = Arc::new(AtomicUsize::new(0));
    let creates = Arc::new(AtomicUsize::new(0));
    {
        let counting_gate: freshell_ws::restart::JournalParentSync = Arc::new({
            let syncs = Arc::clone(&syncs);
            move |_parent: &Path| -> std::io::Result<()> {
                syncs.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
        });
        let (coordinator, _fresh, _production, request, _registration, _state, registry, _temp) =
            fence_defer_scenario(
                counting_gate,
                Arc::clone(&syncs),
                Arc::clone(&syncs_at_first_create),
                Arc::clone(&creates),
            )
            .await;
        let outcome = coordinator
            .execute_registered(request.clone(), |_| {})
            .await;
        assert!(
            matches!(
                outcome.messages.last(),
                Some(ServerMessage::AgentRestartReplaced(replaced))
                    if replaced.request_id == request.request_id
            ),
            "the unfaulted calibration pass must commit: {:?}",
            outcome.messages
        );
        registry.kill_all();
    }
    assert_eq!(
        creates.load(Ordering::SeqCst),
        1,
        "calibration created exactly one replacement"
    );
    let fence_ordinal = syncs_at_first_create.load(Ordering::SeqCst);
    assert!(
        fence_ordinal >= 3,
        "the fence write is at least the 3rd journal parent sync (boundary + retirement-complete + fence): counted {fence_ordinal}"
    );

    // Phase B — same scenario, faulting exactly the fence write's parent sync.
    let syncs = Arc::new(AtomicUsize::new(0));
    let syncs_at_first_create = Arc::new(AtomicUsize::new(0));
    let creates = Arc::new(AtomicUsize::new(0));
    let fault_gate: freshell_ws::restart::JournalParentSync = Arc::new({
        let syncs = Arc::clone(&syncs);
        move |_parent: &Path| -> std::io::Result<()> {
            let at = syncs.fetch_add(1, Ordering::SeqCst) + 1;
            if at == fence_ordinal {
                return Err(std::io::Error::other(
                    "injected fence-write parent sync failure",
                ));
            }
            Ok(())
        }
    });
    let (coordinator, fresh_runtime, production, request, _registration, _state, registry, _temp) =
        fence_defer_scenario(
            fault_gate,
            Arc::clone(&syncs),
            Arc::clone(&syncs_at_first_create),
            Arc::clone(&creates),
        )
        .await;

    let emitted = Arc::new(Mutex::new(Vec::new()));
    let emit_sink = Arc::clone(&emitted);
    let outcome = coordinator
        .execute_registered(request.clone(), move |message| {
            emit_sink.lock().unwrap().push(message.clone());
        })
        .await;

    // The deferred pass must NOT spawn: no create call, a retryable +
    // recovery_pending failure frame, a retained row holding the fence, a
    // retained plan, and NO reservation release.
    assert_eq!(
        creates.load(Ordering::SeqCst),
        0,
        "an indeterminate fence write must NOT proceed to replacement creation"
    );
    assert_eq!(
        fresh_runtime.releases(),
        vec![],
        "the deferred outcome keeps the OpenCode reservation for the re-drive"
    );
    assert!(
        matches!(
            outcome.messages.as_slice(),
            [ServerMessage::AgentRestartStarted(_), ServerMessage::AgentRestartFailed(failed)]
                if failed.request_id == "fence-defer"
                    && failed.retryable
                    && failed.recovery_pending
        ),
        "the deferred pass surfaces retryable + recovery_pending: {:?}",
        outcome.messages
    );
    let pending = coordinator.pending_recoveries();
    assert!(
        pending
            .iter()
            .any(|row| row.request_id == "fence-defer" && row.replacement_fence.is_some()),
        "the retained row holds the (durability-unproven) fence for re-proof: {pending:?}"
    );
    assert!(
        RestartRuntime::persisted_resume_context(production.as_ref(), &request, &()).is_some(),
        "the deferred pass keeps the request's active plan"
    );

    // The always-on driver re-drives: the re-proof write clears the dirty flag
    // (the one-shot fault is spent), and only then does the pass create and
    // commit — AFTER the fence is durably proven.
    let shutdown_started = Arc::new(AtomicBool::new(false));
    let shutdown_notify = Arc::new(tokio::sync::Notify::new());
    let driver_sink = Arc::clone(&emitted);
    let driver = tokio::spawn(run_restart_recovery_driver(
        coordinator.clone(),
        shutdown_started.clone(),
        shutdown_notify.clone(),
        move |message| driver_sink.lock().unwrap().push(message.clone()),
    ));
    assert!(
        wait_until(std::time::Duration::from_secs(5), || coordinator
            .pending_recoveries()
            .is_empty())
        .await,
        "the driver must converge the retained row once the fence is re-proven (creates={} syncs={} pending={:?})",
        creates.load(Ordering::SeqCst),
        syncs.load(Ordering::SeqCst),
        coordinator.pending_recoveries(),
    );
    assert_eq!(
        creates.load(Ordering::SeqCst),
        1,
        "exactly one replacement is created, after the fence re-proof"
    );
    assert_eq!(
        fresh_runtime.releases(),
        vec![(
            freshell_protocol::AgentProvider::Opencode,
            "durable-fence-defer".to_string(),
            "fresh-opencode-fence-defer-old".to_string(),
            format!("restart-preflight:{}", request.request_id),
        )],
        "the reservation is released exactly once, on the converged terminal commit"
    );
    assert!(
        RestartRuntime::persisted_resume_context(production.as_ref(), &request, &()).is_none(),
        "the converged commit removes the active plan"
    );

    shutdown_started.store(true, Ordering::SeqCst);
    shutdown_notify.notify_waiters();
    tokio::time::timeout(std::time::Duration::from_secs(2), driver)
        .await
        .expect("driver exits on shutdown")
        .expect("driver task did not panic");
    registry.kill_all();
}

// graceful shutdown, owns every registered in-flight transaction in a JoinSet
// the shutdown sequence joins before provider/terminal cleanup, refuses
// replacement creation once latched (retryable, durable row retained,
// `recovery_pending`), and drains the codex/claude restart quarantines through
// their confirmed process-tree barriers — all under ONE shared deadline
// inside the SAFE-11 hard-timeout watchdog (join ≤ 3s, drains ≤ 2s).
// ---------------------------------------------------------------------------

/// Fast-path rejection at the WS door: once the shutdown latch flips,
/// `spawn_registered` refuses WITHOUT registering a task — the typed failure
/// frame is emitted through the same broadcast sink, no `AgentRestartStarted`
/// fires, and no durable pending row is created.
#[tokio::test]
async fn restart_spawn_rejected_once_shutdown_latched() {
    let coordinator = RestartCoordinator::new();
    coordinator.register_initial(locator(), "term-1");
    coordinator.begin_restart_shutdown();
    let emitted = Arc::new(Mutex::new(Vec::new()));
    let emit_sink = Arc::clone(&emitted);

    let accepted = coordinator
        .spawn_registered(
            restart("shutdown-spawn-r1", "term-1", 1),
            None,
            move |message| {
                emit_sink.lock().unwrap().push(message.clone());
            },
        )
        .await;

    assert!(
        !accepted,
        "a spawn after the shutdown latch must be refused"
    );
    let messages = emitted.lock().unwrap().clone();
    assert!(
        matches!(
            messages.as_slice(),
            [ServerMessage::AgentRestartFailed(failed)]
                if failed.request_id == "shutdown-spawn-r1"
                    && failed.code == AgentRestartFailureCode::ShutdownFailed
                    && failed.retryable
                    && !failed.recovery_pending
        ),
        "the door must emit exactly one typed shutdown rejection: {messages:?}"
    );
    assert!(
        !messages
            .iter()
            .any(|message| matches!(message, ServerMessage::AgentRestartStarted(_))),
        "no started event fires for a rejected spawn"
    );
    assert!(
        coordinator.pending_recoveries().is_empty(),
        "no durable pending row is created for a rejected spawn"
    );
    tokio::time::timeout(
        std::time::Duration::from_secs(1),
        coordinator.join_in_flight_transactions(),
    )
    .await
    .expect("the register set is empty, so the join resolves immediately");
}

/// A deferred RETRY (not a fresh request) arriving after the shutdown latch
/// must keep reporting `recovery_pending` when its durable row already exists:
/// cross-boot recovery owns the retained transaction and the client keys on
/// the flag. A never-started request still reports `recovery_pending: false`
/// (see `restart_spawn_rejected_once_shutdown_latched`).
#[tokio::test]
async fn latched_retry_of_a_retained_pending_row_reports_recovery_pending() {
    let coordinator = RestartCoordinator::new();
    coordinator.register_initial(locator(), "term-1");
    coordinator
        .execute(
            restart("shutdown-retry-r1", "term-1", 1),
            &RetirementRetries {
                shutdowns: AtomicUsize::new(0),
            },
        )
        .await;
    assert_eq!(
        coordinator.pending_recoveries().len(),
        1,
        "the retryable retirement failure must retain its durable row"
    );

    coordinator.begin_restart_shutdown();
    let emitted = Arc::new(Mutex::new(Vec::new()));
    let emit_sink = Arc::clone(&emitted);
    let accepted = coordinator
        .spawn_registered(
            restart("shutdown-retry-r1", "term-1", 1),
            None,
            move |message| {
                emit_sink.lock().unwrap().push(message.clone());
            },
        )
        .await;
    assert!(!accepted, "a latched retry is refused without spawning");
    let messages = emitted.lock().unwrap().clone();
    assert!(
        matches!(
            messages.as_slice(),
            [ServerMessage::AgentRestartFailed(failed)]
                if failed.code == AgentRestartFailureCode::ShutdownFailed
                    && failed.retryable
                    && failed.recovery_pending
        ),
        "the latched retry rejection must report recovery_pending: {messages:?}"
    );
}

/// A retirement that parks inside `shutdown_for_restart` so tests can flip the
/// shutdown latch deterministically mid-transaction. `creates` proves the
/// replacement was never minted after the latch.
#[derive(Default)]
struct GatedRetirementRuntime {
    shutdown_entered: tokio::sync::Notify,
    shutdown_release: tokio::sync::Notify,
    preflights: AtomicUsize,
    shutdowns: AtomicUsize,
    creates: AtomicUsize,
}

#[async_trait::async_trait]
impl RestartRuntime for GatedRetirementRuntime {
    type ResumePlan = ();

    async fn preflight(&self, _request: &AgentRestart) -> Result<(), RestartFailure> {
        self.preflights.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    async fn shutdown_for_restart(
        &self,
        _request: &AgentRestart,
        _plan: &(),
    ) -> Result<(), RestartFailure> {
        self.shutdowns.fetch_add(1, Ordering::SeqCst);
        self.shutdown_entered.notify_one();
        self.shutdown_release.notified().await;
        Ok(())
    }

    async fn create_replacement(
        &self,
        _request: &AgentRestart,
        _plan: (),
    ) -> Result<String, RestartFailure> {
        self.creates.fetch_add(1, Ordering::SeqCst);
        Ok("term-must-not-be-created".to_string())
    }
}

/// In-flight settlement + mid-transaction latch: a transaction parked inside
/// provider teardown when shutdown begins is still OWNED by the coordinator —
/// the shutdown join awaits it, and once the latch is observed the replacement
/// is refused (retryable + `recovery_pending`, durable row retained) instead
/// of minting a writer the cleanup sweep would race.
#[tokio::test]
async fn in_flight_transaction_is_joined_by_shutdown_and_replacement_creation_after_latch_is_refused(
) {
    let coordinator = RestartCoordinator::new();
    coordinator.register_initial(locator(), "term-1");
    let runtime = Arc::new(GatedRetirementRuntime::default());
    let _registration = coordinator.set_runtime(runtime.clone());
    let emitted = Arc::new(Mutex::new(Vec::new()));
    let emit_sink = Arc::clone(&emitted);

    let accepted = coordinator
        .spawn_registered(restart("in-flight-r1", "term-1", 1), None, move |message| {
            emit_sink.lock().unwrap().push(message.clone());
        })
        .await;
    assert!(accepted, "pre-latch spawn registers normally");
    // Deterministic: the transaction is parked INSIDE provider teardown before
    // the latch flips, so the refusal below must come from the pre-replacement
    // latch check, never the entry check.
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        runtime.shutdown_entered.notified(),
    )
    .await
    .expect("the transaction reached the gated retirement");

    coordinator.begin_restart_shutdown();
    runtime.shutdown_release.notify_one();

    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        coordinator.join_in_flight_transactions(),
    )
    .await
    .expect("shutdown joins the in-flight transaction once retirement un-gates");

    assert_eq!(
        runtime.preflights.load(Ordering::SeqCst),
        1,
        "preflight ran exactly once"
    );
    assert_eq!(
        runtime.shutdowns.load(Ordering::SeqCst),
        1,
        "the in-flight retirement completed"
    );
    assert_eq!(
        runtime.creates.load(Ordering::SeqCst),
        0,
        "create_replacement_fenced must NOT run once the latch is set"
    );
    let messages = emitted.lock().unwrap().clone();
    assert!(
        messages
            .iter()
            .any(|message| matches!(message, ServerMessage::AgentRestartStarted(_))),
        "the in-flight transaction announced started before the latch: {messages:?}"
    );
    let failed = messages
        .iter()
        .find_map(|message| match message {
            ServerMessage::AgentRestartFailed(failed) => Some(failed),
            _ => None,
        })
        .expect("a terminal failure frame was emitted");
    assert_eq!(failed.request_id, "in-flight-r1");
    assert_eq!(failed.code, AgentRestartFailureCode::ShutdownFailed);
    assert!(failed.retryable, "the refusal is retryable");
    assert!(
        failed.recovery_pending,
        "the refusal retains the durable row (recovery_pending)"
    );
    let pending = coordinator.pending_recoveries();
    assert_eq!(pending.len(), 1, "the durable row is retained");
    assert!(
        !pending[0].retirement_pending,
        "retirement completed before the latch refusal, so only the replacement is owed"
    );
    drop(_registration);
}

/// Mid-flight RECOVERY sibling of the latch refusal: a retry that already
/// entered `recover_persisted_retirement` when the latch flips must defer its
/// `recover_replacement_fenced` call the same way (retryable +
/// `recovery_pending`, row retained, no spawn).
#[tokio::test]
async fn recovery_in_flight_defers_replacement_creation_after_shutdown_latch() {
    /// First direct teardown attempt fails retryably (leaving the durable row
    /// with `retirement_pending`); the later recovery pass parks inside
    /// `recover_persisted_retirement` so the test can latch deterministically
    /// before the replacement phase.
    struct GatedRecoveryRuntime {
        recovery_entered: tokio::sync::Notify,
        recovery_release: tokio::sync::Notify,
        shutdown_calls: AtomicUsize,
        creates: AtomicUsize,
    }

    impl GatedRecoveryRuntime {
        fn new() -> Self {
            Self {
                recovery_entered: tokio::sync::Notify::new(),
                recovery_release: tokio::sync::Notify::new(),
                shutdown_calls: AtomicUsize::new(0),
                creates: AtomicUsize::new(0),
            }
        }
    }

    #[async_trait::async_trait]
    impl RestartRuntime for GatedRecoveryRuntime {
        type ResumePlan = ();

        async fn preflight(&self, _request: &AgentRestart) -> Result<(), RestartFailure> {
            Ok(())
        }

        async fn shutdown_for_restart(
            &self,
            _request: &AgentRestart,
            _plan: &(),
        ) -> Result<(), RestartFailure> {
            if self.shutdown_calls.fetch_add(1, Ordering::SeqCst) == 0 {
                return Err(RestartFailure::new(
                    AgentRestartFailureCode::ShutdownFailed,
                    "transient teardown failure",
                    true,
                ));
            }
            Ok(())
        }

        async fn create_replacement(
            &self,
            _request: &AgentRestart,
            _plan: (),
        ) -> Result<String, RestartFailure> {
            self.creates.fetch_add(1, Ordering::SeqCst);
            Ok("term-must-not-be-recovered".to_string())
        }

        async fn recover_persisted_retirement(
            &self,
            _request: &AgentRestart,
            _context: Option<&RestartResumeContext>,
            _fence: Option<&RestartRetirementFence>,
        ) -> Result<(), RestartFailure> {
            self.recovery_entered.notify_one();
            self.recovery_release.notified().await;
            Ok(())
        }
    }

    let coordinator = RestartCoordinator::new();
    coordinator.register_initial(locator(), "term-1");
    let runtime = Arc::new(GatedRecoveryRuntime::new());
    let _registration = coordinator.set_runtime(runtime.clone());

    // Seed the retained row: shutdown fails retryably, so the transaction
    // stops at `retirement_pending`.
    let seeded = coordinator
        .execute(restart("recovery-latch-r1", "term-1", 1), runtime.as_ref())
        .await;
    assert!(
        matches!(
            seeded.messages.last(),
            Some(ServerMessage::AgentRestartFailed(failed))
                if failed.retryable && failed.recovery_pending
        ),
        "the seed run must retain a retryable pending row: {:?}",
        seeded.messages
    );
    assert_eq!(coordinator.pending_recoveries().len(), 1);
    assert!(coordinator.pending_recoveries()[0].retirement_pending);

    // Re-drive the retained row; the pass parks inside the recovery
    // retirement so the latch can flip between phases.
    let emitted = Arc::new(Mutex::new(Vec::new()));
    let emit_sink = Arc::clone(&emitted);
    let retry_coordinator = coordinator.clone();
    let retry = tokio::spawn(async move {
        retry_coordinator
            .execute_registered(restart("recovery-latch-r1", "term-1", 1), move |message| {
                emit_sink.lock().unwrap().push(message.clone());
            })
            .await
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        runtime.recovery_entered.notified(),
    )
    .await
    .expect("the retried transaction reached the gated recovery retirement");

    coordinator.begin_restart_shutdown();
    runtime.recovery_release.notify_one();
    tokio::time::timeout(std::time::Duration::from_secs(5), retry)
        .await
        .expect("the latched retry settles")
        .expect("the retry task did not panic");

    assert_eq!(
        runtime.creates.load(Ordering::SeqCst),
        0,
        "recover_replacement_fenced must NOT run once the latch is set"
    );
    let messages = emitted.lock().unwrap().clone();
    assert!(
        messages
            .iter()
            .any(|message| matches!(message, ServerMessage::AgentRestartStarted(_))),
        "the recovery retry announced started before the latch: {messages:?}"
    );
    let failed = messages
        .iter()
        .find_map(|message| match message {
            ServerMessage::AgentRestartFailed(failed) => Some(failed),
            _ => None,
        })
        .expect("a terminal failure frame was emitted");
    assert!(failed.retryable, "the recovery deferral is retryable");
    assert!(
        failed.recovery_pending,
        "the recovery deferral retains the durable row"
    );
    let pending = coordinator.pending_recoveries();
    assert_eq!(pending.len(), 1, "the durable row is retained");
    assert!(
        !pending[0].retirement_pending,
        "the retirement phase finished; only the replacement is owed"
    );
    drop(_registration);
}

/// The recovery pass consults the latch too: once shutdown begins, driving
/// retained rows spawns nothing and the rows remain for next-boot recovery.
#[tokio::test]
async fn recovery_pass_skips_replacement_creation_after_shutdown_latch() {
    /// Teardown succeeds; the first replacement create fails retryably so the
    /// retained row already owes ONLY the replacement phase
    /// (`retirement_pending == false`).
    struct FailCreateOnceRuntime {
        creates: AtomicUsize,
    }

    #[async_trait::async_trait]
    impl RestartRuntime for FailCreateOnceRuntime {
        type ResumePlan = ();

        async fn preflight(&self, _request: &AgentRestart) -> Result<(), RestartFailure> {
            Ok(())
        }

        async fn shutdown_for_restart(
            &self,
            _request: &AgentRestart,
            _plan: &(),
        ) -> Result<(), RestartFailure> {
            Ok(())
        }

        async fn create_replacement(
            &self,
            _request: &AgentRestart,
            _plan: (),
        ) -> Result<String, RestartFailure> {
            if self.creates.fetch_add(1, Ordering::SeqCst) == 0 {
                return Err(RestartFailure::new(
                    AgentRestartFailureCode::ReplacementFailed,
                    "injected create failure",
                    true,
                ));
            }
            Ok("term-must-not-be-recovered".to_string())
        }
    }

    let coordinator = RestartCoordinator::new();
    coordinator.register_initial(locator(), "term-1");
    let runtime = Arc::new(FailCreateOnceRuntime {
        creates: AtomicUsize::new(0),
    });
    let _registration = coordinator.set_runtime(runtime.clone());
    coordinator
        .execute(restart("recovery-pass-r1", "term-1", 1), runtime.as_ref())
        .await;
    assert_eq!(coordinator.pending_recoveries().len(), 1);
    assert!(
        !coordinator.pending_recoveries()[0].retirement_pending,
        "the seeded row owes only the replacement phase"
    );
    assert_eq!(runtime.creates.load(Ordering::SeqCst), 1);

    coordinator.begin_restart_shutdown();
    coordinator.recover_pending_registered(|_| {}).await;

    assert_eq!(
        runtime.creates.load(Ordering::SeqCst),
        1,
        "the latched recovery pass must not spawn a replacement"
    );
    assert_eq!(
        coordinator.pending_recoveries().len(),
        1,
        "the row is retained for next-boot recovery"
    );
    drop(_registration);
}

/// LB-06 (load-bearing, mandatory): a spawner that passed the fast-path latch
/// check and then parked before the transactions mutex must NOT register once
/// `begin_restart_shutdown` + a completed (empty) join have run — the latch is
/// re-checked INSIDE the lock, so the finished drain can never be followed by
/// a late racing insert. The parking seam makes the exact interleaving
/// deterministic without sleeps.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn spawn_registered_cannot_insert_after_the_drain_observed_empty() {
    let coordinator = RestartCoordinator::new();
    coordinator.register_initial(locator(), "term-1");
    let gate = SpawnRegistrationRaceGate::default();
    coordinator.set_spawn_registration_race_gate(gate.clone());
    gate.arm();

    let emitted = Arc::new(Mutex::new(Vec::new()));
    let emit_sink = Arc::clone(&emitted);
    let spawn_coordinator = coordinator.clone();
    let spawned = tokio::spawn(async move {
        spawn_coordinator
            .spawn_registered(restart("race-r1", "term-1", 1), None, move |message| {
                emit_sink.lock().unwrap().push(message.clone());
            })
            .await
    });

    // Deterministic: the spawner passed the fast-path latch check and now
    // parks immediately before the transactions mutex.
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        gate.wait_until_fast_path_passed(),
    )
    .await
    .expect("the spawner reached the pre-lock parking seam");

    // The whole shutdown interlock runs to completion while the spawner parks:
    // the latch is set, then the drain observes an EMPTY set and finishes.
    coordinator.begin_restart_shutdown();
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        coordinator.join_in_flight_transactions(),
    )
    .await
    .expect("the drain must observe the set empty and complete while the spawner is parked");

    // Release the parked spawner: the in-mutex re-check must now observe the
    // latch, emit the typed rejection, and refuse registration.
    gate.release();
    let accepted = tokio::time::timeout(std::time::Duration::from_secs(5), spawned)
        .await
        .expect("the released spawner completes")
        .expect("the spawner task did not panic");
    assert!(
        !accepted,
        "a spawn crossing a completed drain must be refused"
    );
    let messages = emitted.lock().unwrap().clone();
    assert!(
        matches!(
            messages.as_slice(),
            [ServerMessage::AgentRestartFailed(failed)]
                if failed.request_id == "race-r1"
                    && failed.code == AgentRestartFailureCode::ShutdownFailed
                    && failed.retryable
                    && !failed.recovery_pending
        ),
        "the late spawner receives exactly the typed shutdown rejection: {messages:?}"
    );
    assert!(
        !messages
            .iter()
            .any(|message| matches!(message, ServerMessage::AgentRestartStarted(_))),
        "no late AgentRestartStarted may arrive after a completed drain"
    );
    assert!(
        coordinator.pending_recoveries().is_empty(),
        "the late spawner must not create a durable row either"
    );
    // The drain had already finished; a second join still resolves immediately.
    tokio::time::timeout(
        std::time::Duration::from_secs(1),
        coordinator.join_in_flight_transactions(),
    )
    .await
    .expect("the register set stays empty after the refused late spawn");
}

/// LB-02 (load-bearing, mandatory): the phased shutdown order — latch → join
/// the in-flight transaction set → parallel per-provider quarantine drains —
/// completes inside the shared deadline envelope (join ≤ 3,000 ms, drains ≤
/// 2,000 ms total, within the SAFE-11 hard timeout) with a LIVE gated
/// transaction mid-flight and a QUARANTINED codex retirement, and leaves no
/// orphan: the quarantined sidecar's pid is confirmed gone from /proc.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn shutdown_sequence_completes_within_the_shared_deadline_with_a_live_gated_transaction_and_quarantine_entry(
) {
    // ── Live gated transaction (parked inside provider teardown) ──
    let coordinator = RestartCoordinator::new();
    coordinator.register_initial(locator(), "term-1");
    let runtime = Arc::new(GatedRetirementRuntime::default());
    let _registration = coordinator.set_runtime(runtime.clone());
    let accepted = coordinator
        .spawn_registered(restart("lb02-r1", "term-1", 1), None, |_| {})
        .await;
    assert!(accepted);
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        runtime.shutdown_entered.notified(),
    )
    .await
    .expect("the live transaction reached the gated retirement");

    // ── One quarantined codex retirement (a parked consumer forces the first
    // drive to retire Incomplete with the kill confirmed by the exit-watcher's
    // barrier; releasing the blocker lets the DRAIN finish the joins) ──
    let bus = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let codex = freshell_freshagent::FreshCodexState::new(
        Arc::new("tok".to_string()),
        Arc::clone(&bus),
        serde_json::json!({ "freshAgent": { "enabled": false } }),
    );
    let claude = freshell_freshagent::FreshClaudeState::new(Arc::clone(&bus));
    let (transport, peer) = freshell_codex::new_channel_transport();
    let (client, _notifs) = freshell_codex::CodexAppServerClient::connect(transport);
    let blocker_release = Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
    let parked_consumer = {
        let release = Arc::clone(&blocker_release);
        tokio::task::spawn_blocking(move || {
            let (released, wake) = &*release;
            let mut released = released.lock().unwrap();
            while !*released {
                released = wake.wait(released).unwrap();
            }
        })
    };
    let child = tokio::process::Command::new("sleep")
        .arg("30")
        .kill_on_drop(true)
        .spawn()
        .expect("spawn the quarantined sidecar fixture");
    let child_pid = child.id().expect("fixture pid") as i32;
    let ownership_id = format!("codex-drain-lb02-{}", uuid::Uuid::new_v4());
    let fixture_runtime = codex
        .insert_fixture_session_for_restart_shutdown(
            "thread-lb02-drain",
            Arc::new(client),
            parked_consumer,
            child,
            &ownership_id,
        )
        .await;
    drop(peer);
    let outcome = codex
        .shutdown_for_restart_detailed("thread-lb02-drain", &fixture_runtime.runtime_id)
        .await;
    assert!(
        matches!(
            outcome,
            freshell_freshagent::RestartShutdownOutcome::RetirementIncomplete { .. }
        ),
        "the parked consumer must leave the retirement quarantined: {outcome:?}"
    );
    assert_eq!(
        codex.restart_retirement_count_for_test().await,
        1,
        "one retirement is quarantined for the drain"
    );
    {
        let (released, wake) = &*blocker_release;
        *released.lock().unwrap() = true;
        wake.notify_all();
    }

    // ── The Task-6 phased order with the production 3s/2s split ──
    let phase_start = tokio::time::Instant::now();
    coordinator.begin_restart_shutdown();
    runtime.shutdown_release.notify_one();
    let join_deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(3_000);
    tokio::time::timeout_at(join_deadline, coordinator.join_in_flight_transactions())
        .await
        .expect("the in-flight transaction join resolves within the 3s phase budget");
    assert_eq!(
        runtime.creates.load(Ordering::SeqCst),
        0,
        "the latched transaction refused its replacement"
    );
    assert_eq!(
        coordinator.pending_recoveries().len(),
        1,
        "the durable row is retained for cross-boot recovery"
    );

    let drain_deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(2_000);
    tokio::join!(
        codex.drain_restart_retirements(drain_deadline),
        claude.drain_restart_retirements(drain_deadline),
    );

    assert!(
        phase_start.elapsed() < std::time::Duration::from_millis(5_000),
        "latch + join + parallel drains must complete inside the shared envelope: {:?}",
        phase_start.elapsed()
    );
    assert_eq!(
        codex.restart_retirement_count_for_test().await,
        0,
        "the quarantine drain ran every entry to quiescence"
    );
    // No orphan: the quarantined sidecar's kill was CONFIRMED (barrier + reap),
    // not detached — the pid is gone from /proc (ESRCH, not a zombie).
    let probe = unsafe { libc::kill(child_pid, 0) };
    assert!(
        probe != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH),
        "the quarantined sidecar pid must be gone from /proc after the drain"
    );
    drop(_registration);
}

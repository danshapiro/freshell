//! Headless regression tests: source epochs must survive the complete replay seam.
use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::task::{Context, Poll, Waker};

#[test]
fn managed_registration_announces_the_native_activity_lifecycle() {
    let registry = TerminalRegistry::new();
    let events = Arc::new(Mutex::new(Vec::new()));
    let capture = events.clone();
    registry.set_activity_observer(Arc::new(move |event| capture.lock().unwrap().push(event)));
    registry.register_managed(
        ManagedTerminalDescriptor {
            soul_id: "activity-soul".into(),
            incarnation_id: "activity-incarnation".into(),
            terminal_id: "activity-terminal".into(),
            stream_id: "activity-epoch".into(),
            mode: "opencode".into(),
            cwd: "/workspace".into(),
            resume_session_id: Some("ses_native".into()),
            create_request_id: None,
        },
        "OpenCode".into(),
    );
    assert!(
        matches!(events.lock().unwrap().as_slice(), [ActivityEvent::Created {
        terminal_id, mode, resume_session_id: Some(session), ..
    }] if terminal_id == "activity-terminal" && mode == "opencode" && session == "ses_native")
    );
}

fn poll_once<F: Future>(future: Pin<&mut F>) -> Poll<F::Output> {
    future.poll(&mut Context::from_waker(Waker::noop()))
}
fn immediate<F: Future>(future: F) -> F::Output {
    let mut future = Box::pin(future);
    match poll_once(future.as_mut()) {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("headless test future unexpectedly waited"),
    }
}

struct Controller {
    hold: AtomicBool,
    calls: AtomicUsize,
    observed: Mutex<Vec<(String, i64)>>,
    response: Mutex<ManagedOutputRead>,
}
impl ManagedTerminalController for Controller {
    fn lookup_terminal<'a>(
        &'a self,
        _: &'a str,
        _: Option<String>,
    ) -> ManagedTerminalFuture<'a, Result<Option<ManagedTerminalDescriptor>, String>> {
        Box::pin(std::future::ready(Ok(None)))
    }
    fn launch<'a>(
        &'a self,
        _: ManagedTerminalLaunch,
    ) -> ManagedTerminalFuture<'a, Result<ManagedTerminalDescriptor, ManagedTerminalLaunchError>>
    {
        panic!("output recovery must not launch a provider")
    }
    fn input<'a>(
        &'a self,
        _: ManagedTerminalDescriptor,
        _: String,
    ) -> ManagedTerminalFuture<'a, Result<(), ManagedTerminalInputError>> {
        panic!("output recovery must not replay input")
    }
    fn resize<'a>(
        &'a self,
        _: ManagedTerminalDescriptor,
        _: u16,
        _: u16,
    ) -> ManagedTerminalFuture<'a, Result<(), String>> {
        panic!("headless output test does not resize")
    }
    fn stop<'a>(
        &'a self,
        _: ManagedTerminalDescriptor,
    ) -> ManagedTerminalFuture<'a, Result<(), String>> {
        panic!("output recovery must not stop a provider")
    }
    fn read_output<'a>(
        &'a self,
        terminal: ManagedTerminalDescriptor,
        cursor: i64,
        _: u64,
    ) -> ManagedTerminalFuture<'a, Result<ManagedOutputRead, String>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.observed
            .lock()
            .unwrap()
            .push((terminal.stream_id, cursor));
        Box::pin(std::future::poll_fn(move |_| {
            if self.hold.load(Ordering::SeqCst) {
                Poll::Pending
            } else {
                Poll::Ready(Ok(self.response.lock().unwrap().clone()))
            }
        }))
    }
}

fn fixture() -> (TerminalRegistry, Arc<Controller>) {
    let registry = TerminalRegistry::new();
    registry.register_managed(
        ManagedTerminalDescriptor {
            soul_id: "soul-stable".into(),
            incarnation_id: "incarnation-old".into(),
            terminal_id: "terminal-stable".into(),
            stream_id: "epoch-old".into(),
            mode: "opencode".into(),
            cwd: "/workspace".into(),
            resume_session_id: Some("native-original".into()),
            create_request_id: Some("create-once".into()),
        },
        "OpenCode".to_string(),
    );
    registry.ingest_managed_output("terminal-stable", 206, 206, "old conversation tail".into());
    let controller = Arc::new(Controller {
        hold: AtomicBool::new(false),
        calls: AtomicUsize::new(0),
        observed: Mutex::new(Vec::new()),
        response: Mutex::new(ManagedOutputRead {
            lifecycle: None,
            completion: None,
            codex_activity: None,
            opencode_activity: None,
            stream_epoch: Some("epoch-new".into()),
            incarnation_id: Some("incarnation-new".into()),
            reset_required: true,
            truncated: false,
            retained_from_seq: 1,
            head_seq: 2,
            exit_code: None,
            native_session_id: Some("native-original".into()),
            chunks: vec![
                ManagedOutputChunk {
                    seq_start: 1,
                    seq_end: 1,
                    data: "provider restored".into(),
                },
                ManagedOutputChunk {
                    seq_start: 2,
                    seq_end: 2,
                    data: "provider prompt".into(),
                },
            ],
        }),
    });
    registry.set_managed_controller(Some(controller.clone()));
    (registry, controller)
}

fn collect_messages() -> (FrameSink, Arc<std::sync::Mutex<Vec<ServerMessage>>>) {
    let messages = Arc::new(std::sync::Mutex::new(Vec::new()));
    let captured = Arc::clone(&messages);
    let sink: FrameSink = Arc::new(move |frame| captured.lock().unwrap().push(frame));
    (sink, messages)
}

#[test]
fn managed_source_epoch_changes_are_announced_to_both_views_before_new_output() {
    let (registry, controller) = fixture();
    let captures: Vec<_> = (1..=2)
        .map(|conn| {
            let frames = Arc::new(Mutex::new(Vec::new()));
            let captured = Arc::clone(&frames);
            assert!(
                registry
                    .attach(
                        "terminal-stable",
                        conn,
                        Arc::new(move |frame| captured.lock().unwrap().push(frame)),
                        Some(format!("attach-{conn}")),
                        206,
                        false,
                        false,
                        None,
                        None,
                        None,
                        PacedAttachOptions::default(),
                    )
                    .found
            );
            frames.lock().unwrap().clear();
            frames
        })
        .collect();
    immediate(registry.refresh_managed_output("terminal-stable", 65536)).unwrap();
    let descriptor = registry.managed_descriptor("terminal-stable").unwrap();
    assert_eq!(descriptor.stream_id, "epoch-new");
    assert_eq!(descriptor.incarnation_id, "incarnation-new");
    assert_eq!(descriptor.soul_id, "soul-stable");
    assert_eq!(
        descriptor.resume_session_id.as_deref(),
        Some("native-original")
    );
    assert_eq!(registry.managed_output_cursor("terminal-stable"), Some(2));
    for (index, capture) in captures.iter().enumerate() {
        let frames = capture.lock().unwrap();
        match &frames[0] {
            ServerMessage::TerminalStreamChanged(changed) => {
                assert_eq!(changed.stream_id, "epoch-new");
                assert_eq!(
                    changed.attach_request_id.as_deref(),
                    Some(format!("attach-{}", index + 1).as_str())
                );
            }
            other => panic!("stream transition must precede output, got {other:?}"),
        }
        let outputs: Vec<_> = frames
            .iter()
            .filter_map(|f| {
                if let ServerMessage::TerminalOutput(v) = f {
                    Some(v)
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(outputs.len(), 2);
        assert_eq!(outputs[0].seq_start, 1);
        assert!(outputs.iter().all(|v| v.stream_id == "epoch-new"));
        assert!(outputs[1].data.contains("provider prompt"));
        assert!(!frames
            .iter()
            .any(|f| matches!(f, ServerMessage::TerminalExit(_))));
    }
    controller.response.lock().unwrap().reset_required = false;
    immediate(registry.refresh_managed_output("terminal-stable", 65536)).unwrap();
    assert_eq!(
        controller.observed.lock().unwrap().as_slice(),
        &[("epoch-old".into(), 206), ("epoch-new".into(), 2)]
    );
    assert_eq!(
        captures[0].lock().unwrap().len(),
        3,
        "same-epoch duplicate reads must not reset or replay"
    );
}

#[test]
fn managed_concurrent_output_reads_coalesce_and_cancellation_releases_the_claim() {
    let (registry, controller) = fixture();
    controller.hold.store(true, Ordering::SeqCst);
    let mut first = Box::pin(registry.refresh_managed_output("terminal-stable", 65536));
    assert!(poll_once(first.as_mut()).is_pending());
    let mut second = Box::pin(registry.refresh_managed_output("terminal-stable", 65536));
    let Poll::Ready(Ok(read)) = poll_once(second.as_mut()) else {
        panic!("second poll must coalesce, not block or race")
    };
    assert!(read.chunks.is_empty());
    assert_eq!(controller.calls.load(Ordering::SeqCst), 1);
    drop(first); // Models the websocket poll timeout cancelling an in-flight RPC.
    controller.hold.store(false, Ordering::SeqCst);
    immediate(registry.refresh_managed_output("terminal-stable", 65536)).unwrap();
    assert_eq!(controller.calls.load(Ordering::SeqCst), 2);
    assert_eq!(registry.managed_output_cursor("terminal-stable"), Some(2));
}

#[test]
fn managed_epoch_transition_rejects_a_different_native_conversation() {
    let (registry, controller) = fixture();
    controller.response.lock().unwrap().native_session_id = Some("foreign-conversation".into());
    assert!(immediate(registry.refresh_managed_output("terminal-stable", 65536)).is_err());
    assert_eq!(
        registry
            .managed_descriptor("terminal-stable")
            .unwrap()
            .stream_id,
        "epoch-old"
    );
    assert_eq!(registry.managed_output_cursor("terminal-stable"), Some(206));
}

#[test]
fn managed_opencode_same_runtime_accepts_a_signaled_session_switch() {
    let (registry, controller) = fixture();
    {
        let mut response = controller.response.lock().unwrap();
        response.stream_epoch = Some("epoch-old".into());
        response.incarnation_id = Some("incarnation-old".into());
        response.reset_required = false;
        response.retained_from_seq = 206;
        response.head_seq = 206;
        response.native_session_id = Some("ses_Switched".into());
        response.chunks.clear();
    }
    let read = immediate(registry.refresh_managed_output("terminal-stable", 65536)).unwrap();
    assert_eq!(read.native_session_id.as_deref(), Some("ses_Switched"));
    assert_eq!(
        registry
            .managed_descriptor("terminal-stable")
            .unwrap()
            .resume_session_id
            .as_deref(),
        Some("ses_Switched")
    );
    assert_eq!(registry.managed_output_cursor("terminal-stable"), Some(206));
}

#[test]
fn managed_output_shell_terminal_ended_final_tail() {
    let (registry, controller) = fixture();
    {
        let mut inner = registry.inner.lock().unwrap();
        let handle = inner.terminals.get_mut("terminal-stable").unwrap();
        handle.managed.as_mut().unwrap().mode = "shell".into();
        handle.shared.lock().unwrap().mode = "shell".into();
    }
    {
        let mut response = controller.response.lock().unwrap();
        response.stream_epoch = Some("epoch-old".into());
        response.incarnation_id = Some("incarnation-old".into());
        response.reset_required = false;
        response.retained_from_seq = 206;
        response.head_seq = 208;
        response.exit_code = Some(17);
        response.chunks = vec![ManagedOutputChunk {
            seq_start: 207,
            seq_end: 207,
            data: "x".repeat(65536),
        }];
    }
    immediate(registry.refresh_managed_output("terminal-stable", 65536)).unwrap();
    assert_eq!(registry.managed_output_cursor("terminal-stable"), Some(207));
    assert_eq!(registry.inventory()[0].status, TerminalRunStatus::Running);
    controller.response.lock().unwrap().chunks = vec![ManagedOutputChunk {
        seq_start: 208,
        seq_end: 208,
        data: "final tail".into(),
    }];
    immediate(registry.refresh_managed_output("terminal-stable", 65536)).unwrap();
    registry.finish_managed_exit("terminal-stable", 17);
    assert_eq!(registry.inventory()[0].status, TerminalRunStatus::Exited);
    assert!(registry.exists("terminal-stable"));
    assert_eq!(registry.managed_output_cursor("terminal-stable"), Some(208));
    assert!(
        registry
            .live_managed_owner_for_session("shell", "native-original")
            .is_some(),
        "retained managed membership continues to dominate ordinary recreation after exit"
    );
    assert!(registry.directory()[0].snapshot.ends_with("final tail"));
}

#[test]
fn managed_output_paced_exit_preserves_explicit_code_availability() {
    for code in [None, Some(-1)] {
        let (registry, _) = fixture();
        immediate(registry.refresh_managed_output("terminal-stable", 65536)).unwrap();
        registry.set_paced_page_max_bytes(0);
        let captured = Arc::new(Mutex::new(Vec::new()));
        let sink = captured.clone();
        let start = registry
            .attach(
                "terminal-stable",
                77,
                Arc::new(move |frame| sink.lock().unwrap().push(frame)),
                Some("explicit-availability".into()),
                0,
                false,
                true,
                None,
                None,
                None,
                PacedAttachOptions::default(),
            )
            .paced
            .expect("managed retained tail uses paced replay");
        assert!(registry.finish_managed_completion("terminal-stable", code));
        let mut cursor = start.session.page_end;
        loop {
            match registry.complete_paced_tail(
                "terminal-stable",
                77,
                "explicit-availability",
                cursor,
                2,
                0,
            ) {
                PacedTailCompletion::Handoff { end_seq, .. } => cursor = end_seq,
                PacedTailCompletion::Completed { .. } => break,
                other => panic!("unexpected completion: {other:?}"),
            }
        }
        let frames = captured.lock().unwrap();
        let exits: Vec<_> = frames
            .iter()
            .filter_map(|frame| match frame {
                ServerMessage::TerminalExit(exit) => Some(exit),
                _ => None,
            })
            .collect();
        assert_eq!(exits.len(), 1);
        assert_eq!(exits[0].managed_retained, Some(true));
        assert_eq!(exits[0].exit_code_available, Some(code.is_some()));
        assert_eq!(exits[0].exit_code, code.unwrap_or(-1));
        assert_eq!(registry.managed_attached_to(77), vec!["terminal-stable"]);
    }
}

fn lifecycle_with_recovery_state(
    state: ManagedLifecycleState,
    recovery_state: &str,
    desired_state: &str,
) -> ManagedLifecycle {
    ManagedLifecycle {
        state,
        recovery_summary: Some(freshell_protocol::ManagedRecoverySummary {
            desired_state: desired_state.into(),
            recovery_state: recovery_state.into(),
            reason: Some("fixture final recovery state".into()),
            attempt_id: Some("attempt-fixture".into()),
            incident_id: Some("incident-fixture".into()),
            durability_state: "retained".into(),
            allocation_state: "retained".into(),
        }),
    }
}

#[test]
fn final_managed_lifecycle_marks_facade_exited_without_inventing_exit_code() {
    for (state, recovery_state, desired_state, runtime_status) in [
        (
            ManagedLifecycleState::Blocked,
            "blocked",
            "running",
            freshell_protocol::RuntimeStatus::Blocked,
        ),
        (
            ManagedLifecycleState::Ended,
            "lost",
            "running",
            freshell_protocol::RuntimeStatus::Exited,
        ),
        (
            ManagedLifecycleState::Ended,
            "stopped",
            "stopped",
            freshell_protocol::RuntimeStatus::Exited,
        ),
    ] {
        let (registry, _) = fixture();
        assert!(registry.ingest_managed_output(
            "terminal-stable",
            207,
            207,
            "retained final output".into(),
        ));
        registry.publish_managed_lifecycle(
            "terminal-stable",
            Some(lifecycle_with_recovery_state(
                state,
                recovery_state,
                desired_state,
            )),
        );

        let row = &registry.inventory()[0];
        assert_eq!(row.status, TerminalRunStatus::Exited);
        assert_eq!(row.runtime_status, Some(runtime_status));
        assert_eq!(
            row.recovery_summary
                .as_ref()
                .map(|summary| summary.recovery_state.as_str()),
            Some(recovery_state)
        );
        assert!(!registry.is_live("terminal-stable"));
        assert!(registry.exists("terminal-stable"));
        assert!(registry.directory()[0]
            .snapshot
            .contains("retained final output"));

        let (sink, seen) = collect_messages();
        assert!(
            registry
                .attach(
                    "terminal-stable",
                    77,
                    sink,
                    Some("final-lifecycle-attach".into()),
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
        let frames = seen.lock().unwrap();
        assert!(frames.iter().any(|frame| matches!(frame,
            ServerMessage::TerminalOutput(output) if output.data.contains("retained final output"))));
        assert!(frames.iter().any(|frame| matches!(frame,
            ServerMessage::TerminalExit(exit)
                if exit.managed_retained == Some(true)
                    && exit.exit_code == -1
                    && exit.exit_code_available == Some(false))));
    }
}

#[test]
fn managed_completion_after_ended_lifecycle_publishes_the_observed_exit_code() {
    let (registry, _) = fixture();
    let (sink, seen) = collect_messages();
    assert!(
        registry
            .attach(
                "terminal-stable",
                78,
                sink,
                Some("completion-after-lifecycle".into()),
                206,
                false,
                false,
                None,
                None,
                None,
                PacedAttachOptions::default(),
            )
            .found
    );
    seen.lock().unwrap().clear();

    registry.publish_managed_lifecycle(
        "terminal-stable",
        Some(lifecycle_with_recovery_state(
            ManagedLifecycleState::Ended,
            "lost",
            "running",
        )),
    );
    assert!(!registry.is_live("terminal-stable"));
    assert!(!seen
        .lock()
        .unwrap()
        .iter()
        .any(|frame| matches!(frame, ServerMessage::TerminalExit(_))));

    assert!(registry.finish_managed_exit("terminal-stable", 17));
    assert!(seen.lock().unwrap().iter().any(|frame| matches!(frame,
        ServerMessage::TerminalExit(exit)
            if exit.exit_code == 17
                && exit.exit_code_available == Some(true)
                && exit.managed_retained == Some(true))));
}

#[test]
fn managed_unknown_completion_after_ended_lifecycle_notifies_attached_viewer_once() {
    let (registry, _) = fixture();
    let (sink, seen) = collect_messages();
    assert!(
        registry
            .attach(
                "terminal-stable",
                79,
                sink,
                Some("unknown-completion-after-lifecycle".into()),
                206,
                false,
                false,
                None,
                None,
                None,
                PacedAttachOptions::default(),
            )
            .found
    );
    seen.lock().unwrap().clear();

    registry.publish_managed_lifecycle(
        "terminal-stable",
        Some(lifecycle_with_recovery_state(
            ManagedLifecycleState::Ended,
            "lost",
            "running",
        )),
    );
    assert!(!seen
        .lock()
        .unwrap()
        .iter()
        .any(|frame| matches!(frame, ServerMessage::TerminalExit(_))));

    assert!(registry.finish_managed_completion("terminal-stable", None));
    {
        let frames = seen.lock().unwrap();
        assert!(frames.iter().any(|frame| matches!(frame,
            ServerMessage::TerminalExit(exit)
                if exit.exit_code == -1
                    && exit.exit_code_available == Some(false)
                    && exit.managed_retained == Some(true))));
    }

    seen.lock().unwrap().clear();
    assert!(registry.finish_managed_completion("terminal-stable", None));
    assert!(!seen
        .lock()
        .unwrap()
        .iter()
        .any(|frame| matches!(frame, ServerMessage::TerminalExit(_))));
}

#[test]
fn managed_blocked_lifecycle_can_transition_through_recovery_back_to_running() {
    let (registry, _) = fixture();
    registry.publish_managed_lifecycle(
        "terminal-stable",
        Some(lifecycle_with_recovery_state(
            ManagedLifecycleState::Blocked,
            "blocked",
            "running",
        )),
    );
    assert!(!registry.is_live("terminal-stable"));

    registry.publish_managed_lifecycle(
        "terminal-stable",
        Some(lifecycle_with_recovery_state(
            ManagedLifecycleState::Recovering,
            "recovering",
            "running",
        )),
    );
    assert!(registry.is_live("terminal-stable"));
    assert_eq!(
        registry.inventory()[0].runtime_status,
        Some(freshell_protocol::RuntimeStatus::Recovering)
    );

    registry.publish_managed_lifecycle(
        "terminal-stable",
        Some(lifecycle_with_recovery_state(
            ManagedLifecycleState::Running,
            "live",
            "running",
        )),
    );
    let row = &registry.inventory()[0];
    assert!(registry.is_live("terminal-stable"));
    assert_eq!(row.status, TerminalRunStatus::Running);
    assert_eq!(
        row.runtime_status,
        Some(freshell_protocol::RuntimeStatus::Running)
    );
    assert_eq!(
        row.recovery_summary.as_ref().unwrap().recovery_state,
        "live"
    );
}

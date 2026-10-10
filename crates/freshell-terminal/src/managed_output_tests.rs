//! Headless regression tests: source epochs must survive the complete replay seam.
use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::task::{Context, Poll, Waker};

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
    ) -> ManagedTerminalFuture<'a, Result<ManagedTerminalDescriptor, String>> {
        panic!("output recovery must not launch a provider")
    }
    fn input<'a>(
        &'a self,
        _: ManagedTerminalDescriptor,
        _: String,
    ) -> ManagedTerminalFuture<'a, Result<(), String>> {
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
    registry.register_managed(ManagedTerminalDescriptor {
        soul_id: "soul-stable".into(),
        incarnation_id: "incarnation-old".into(),
        terminal_id: "terminal-stable".into(),
        stream_id: "epoch-old".into(),
        mode: "opencode".into(),
        cwd: "/workspace".into(),
        resume_session_id: Some("native-original".into()),
        create_request_id: Some("create-once".into()),
    });
    registry.ingest_managed_output("terminal-stable", 206, 206, "old conversation tail".into());
    let controller = Arc::new(Controller {
        hold: AtomicBool::new(false),
        calls: AtomicUsize::new(0),
        observed: Mutex::new(Vec::new()),
        response: Mutex::new(ManagedOutputRead {
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

/// Records what the WebSocket kill path hands the supervisor: the lookup of
/// a terminal (by id and create-request id) and the per-soul stop.
#[derive(Default)]
struct StopRecorder {
    found: Mutex<Option<ManagedTerminalDescriptor>>,
    lookups: Mutex<Vec<(String, Option<String>)>>,
    stopped: Mutex<Vec<ManagedTerminalDescriptor>>,
    fail_stop: AtomicBool,
}
impl ManagedTerminalController for StopRecorder {
    fn lookup_terminal<'a>(
        &'a self,
        terminal_id: &'a str,
        create_request_id: Option<String>,
    ) -> ManagedTerminalFuture<'a, Result<Option<ManagedTerminalDescriptor>, String>> {
        self.lookups
            .lock()
            .unwrap()
            .push((terminal_id.to_string(), create_request_id));
        Box::pin(std::future::ready(Ok(self.found.lock().unwrap().clone())))
    }
    fn launch<'a>(
        &'a self,
        _: ManagedTerminalLaunch,
    ) -> ManagedTerminalFuture<'a, Result<ManagedTerminalDescriptor, String>> {
        panic!("a kill never launches")
    }
    fn input<'a>(
        &'a self,
        _: ManagedTerminalDescriptor,
        _: String,
    ) -> ManagedTerminalFuture<'a, Result<(), String>> {
        panic!("a kill never writes input")
    }
    fn resize<'a>(
        &'a self,
        _: ManagedTerminalDescriptor,
        _: u16,
        _: u16,
    ) -> ManagedTerminalFuture<'a, Result<(), String>> {
        panic!("a kill never resizes")
    }
    fn stop<'a>(
        &'a self,
        terminal: ManagedTerminalDescriptor,
    ) -> ManagedTerminalFuture<'a, Result<(), String>> {
        self.stopped.lock().unwrap().push(terminal);
        let result = if self.fail_stop.load(Ordering::SeqCst) {
            Err("supervisor could not verify the stop".to_string())
        } else {
            Ok(())
        };
        Box::pin(std::future::ready(result))
    }
    fn read_output<'a>(
        &'a self,
        _: ManagedTerminalDescriptor,
        _: i64,
        _: u64,
    ) -> ManagedTerminalFuture<'a, Result<ManagedOutputRead, String>> {
        panic!("a kill never reads output")
    }
}

fn soul(terminal_id: &str) -> ManagedTerminalDescriptor {
    ManagedTerminalDescriptor {
        soul_id: format!("soul-{terminal_id}"),
        incarnation_id: "incarnation-1".into(),
        terminal_id: terminal_id.into(),
        stream_id: "stream-1".into(),
        mode: "shell".into(),
        cwd: "/workspace".into(),
        resume_session_id: None,
        create_request_id: Some(format!("crq-{terminal_id}")),
    }
}

/// The kill path's supervisor seams (Task 13, LB-13): the inventory lookup
/// of a terminal the registry no longer holds, and the per-soul stop of a
/// descriptor no facade was registered for (a soul whose launch returned
/// after its pane was killed). `Ok` only on the supervisor's verified stop;
/// without a controller both answer the managed stop's own error.
#[test]
fn the_kill_path_reaches_the_supervisor_by_descriptor() {
    let registry = TerminalRegistry::new();
    assert_eq!(
        immediate(registry.lookup_managed("T-gone", None)),
        Err("managed runtime controller unavailable".to_string())
    );
    assert_eq!(
        immediate(registry.managed_stop_descriptor(soul("T-gone"))),
        Err("managed runtime controller unavailable".to_string())
    );

    let controller = Arc::new(StopRecorder::default());
    registry.set_managed_controller(Some(controller.clone()));
    assert_eq!(
        immediate(registry.lookup_managed("T-gone", Some("crq-x".into()))),
        Ok(None)
    );
    *controller.found.lock().unwrap() = Some(soul("T-gone"));
    assert_eq!(
        immediate(registry.lookup_managed("T-gone", None)),
        Ok(Some(soul("T-gone")))
    );
    assert_eq!(
        *controller.lookups.lock().unwrap(),
        vec![
            ("T-gone".to_string(), Some("crq-x".to_string())),
            ("T-gone".to_string(), None)
        ]
    );

    assert_eq!(
        immediate(registry.managed_stop_descriptor(soul("T-launched"))),
        Ok(())
    );
    controller.fail_stop.store(true, Ordering::SeqCst);
    assert_eq!(
        immediate(registry.managed_stop_descriptor(soul("T-launched"))),
        Err("supervisor could not verify the stop".to_string())
    );
    assert_eq!(
        *controller.stopped.lock().unwrap(),
        vec![soul("T-launched"), soul("T-launched")]
    );
    assert!(
        !registry.is_managed("T-launched"),
        "stopping a descriptor never registers a facade"
    );
}

/// A managed facade whose kill marked it `Requested` reports `stopping` in
/// the inventory until its stop is verified (or `clear_ending` takes it
/// back when the stop failed).
#[test]
fn a_managed_row_being_stopped_reports_stopping() {
    let registry = TerminalRegistry::new();
    registry.register_managed(soul("T-m"));
    assert!(registry.mark_ending("T-m", UnitEnding::Requested));
    let row = registry
        .inventory()
        .into_iter()
        .find(|row| row.terminal_id == "T-m")
        .expect("the facade's row");
    assert_eq!(
        row.runtime_status,
        Some(freshell_protocol::RuntimeStatus::Stopping)
    );
    registry.clear_ending("T-m");
    let row = registry
        .inventory()
        .into_iter()
        .find(|row| row.terminal_id == "T-m")
        .expect("the facade's row");
    assert_eq!(row.runtime_status, None);
}

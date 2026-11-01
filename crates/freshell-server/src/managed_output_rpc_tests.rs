//! Real authenticated Unix-socket reads exercise the web/source epoch boundary.
use super::*;
use freshell_runtime_protocol::{
    read_frame, write_frame, AdminCommand, AdminReply, AdminResult, Envelope, IncarnationId,
    InstallationId, RuntimeOutputBatch, RuntimeOutputFrame,
};
use tokio::net::UnixListener;

async fn read_fixture(
    source_epoch: &str,
    expected_epoch: &str,
    foreign_terminal: bool,
) -> Result<ManagedOutputRead, String> {
    read_fixture_cached(source_epoch, expected_epoch, foreign_terminal, false).await
}

async fn read_fixture_cached(
    source_epoch: &str,
    expected_epoch: &str,
    foreign_terminal: bool,
    cached_blocked: bool,
) -> Result<ManagedOutputRead, String> {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("control.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let source_epoch = source_epoch.to_string();
    let expected_epoch = expected_epoch.to_string();
    let source_for_server = source_epoch.clone();
    let expected_for_server = expected_epoch.clone();
    let server = tokio::spawn(async move {
        let incarnation = IncarnationId::new();
        let mut reads = Vec::new();
        for index in 0..2 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request: Envelope<AdminCommand> = read_frame(&mut socket).await.unwrap();
            assert_eq!(request.auth.as_deref(), Some("synthetic-epoch-test-secret"));
            let result = if index == 0 {
                assert!(matches!(request.body, AdminCommand::Health));
                AdminResult::Health {
                    control_epoch: 1,
                    installation_id: InstallationId::new(),
                }
            } else {
                let AdminCommand::TerminalReadOutput(read) = request.body else {
                    panic!("unexpected command")
                };
                reads.push((read.after_seq, read.expected_stream_epoch.clone()));
                let changed =
                    read.expected_stream_epoch.as_deref() != Some(source_for_server.as_str());
                let seq = if changed { 1 } else { read.after_seq + 1 };
                let terminal = if foreign_terminal {
                    "another-terminal"
                } else {
                    "terminal-owned"
                };
                AdminResult::TerminalOutput(RuntimeOutputBatch {
                    incarnation_id: incarnation.clone(),
                    terminal_id: terminal.into(),
                    codex_activity: Some(freshell_activity::codex::CodexActivityBatch {
                        retained_from_seq: 1,
                        head_seq: 2,
                        events: [false, true]
                            .into_iter()
                            .enumerate()
                            .map(|(index, completed)| {
                                freshell_activity::codex::CodexActivityEvent {
                                    seq: index as u64 + 1,
                                    at: index as i64 + 100,
                                    thread_id: "native-owned".into(),
                                    turn_id: Some("turn-owned".into()),
                                    status: completed.then(|| "completed".into()),
                                    completed,
                                }
                            })
                            .collect(),
                    }),
                    opencode_activity: Some(freshell_activity::opencode::OpencodeActivityBatch {
                        retained_from_seq: 1,
                        head_seq: 2,
                        events: [
                            freshell_activity::opencode::OpencodeStatus::Busy,
                            freshell_activity::opencode::OpencodeStatus::Idle,
                        ]
                        .into_iter()
                        .enumerate()
                        .map(
                            |(index, status)| freshell_activity::opencode::OpencodeActivityEvent {
                                seq: index as u64 + 1,
                                at: index as i64 + 100,
                                cycle: 1,
                                stream: 1,
                                event: freshell_activity::opencode::OpencodeLaneEvent::Status {
                                    session_id: "native-owned".into(),
                                    status,
                                },
                            },
                        )
                        .collect(),
                    }),
                    stream_epoch: source_for_server.clone(),
                    retained_from_seq: 1,
                    head_seq: 300,
                    reset_required: changed,
                    truncated: changed,
                    exited: false,
                    completion: None,
                    exit_code: None,
                    native_session_id: Some("native-owned".into()),
                    frames: vec![RuntimeOutputFrame {
                        terminal_id: terminal.into(),
                        stream_epoch: source_for_server.clone(),
                        seq_start: seq,
                        seq_end: seq,
                        data: if seq == 1 {
                            "whole retained new epoch"
                        } else {
                            "cursor-relative output"
                        }
                        .into(),
                    }],
                })
            };
            write_frame(
                &mut socket,
                &AdminReply {
                    request_id: request.request_id,
                    result: Ok(result),
                },
            )
            .await
            .unwrap();
        }
        assert_eq!(reads, vec![(206, Some(expected_for_server))]);
    });
    let controller = ServerManagedRuntimeController {
        client: RuntimeClient::new(&socket, "synthetic-epoch-test-secret"),
        recovery: Arc::new(ManagedRecoveryState::default()),
    };
    let soul = SoulId::new();
    if cached_blocked {
        controller.recovery.slots.lock().await.insert(
            soul.to_string(),
            SoulRecoverySlot {
                sequence: 1,
                task_in_flight: false,
                incarnation_id: None,
                terminal_id: None,
                intent_revision: None,
                evidence_revision: None,
                publication: RecoveryPublication::Failed {
                    code: RuntimeErrorCode::InvalidRequest,
                    previous: None,
                },
                observed_epoch: None,
                observed_exit_code: None,
                observed_completion: None,
            },
        );
    }
    let result = controller
        .read_output(
            ManagedTerminalDescriptor {
                soul_id: soul.to_string(),
                incarnation_id: IncarnationId::new().to_string(),
                terminal_id: "terminal-owned".into(),
                stream_id: expected_epoch,
                mode: "opencode".into(),
                cwd: "/workspace".into(),
                resume_session_id: Some("native-owned".into()),
                create_request_id: Some("create-owned".into()),
            },
            206,
            65536,
        )
        .await;
    if cached_blocked && result.is_err() {
        // The old cached-error path never reaches the socket. Join that idle
        // fixture before the behavioral assertion rather than leaking a task.
        server.abort();
        assert!(server.await.unwrap_err().is_cancelled());
    } else {
        tokio::time::timeout(std::time::Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap();
    }
    result
}

#[tokio::test]
async fn managed_runtime_cached_blocked_output_remains_readable() {
    let output = read_fixture_cached("same-epoch", "same-epoch", false, true)
        .await
        .expect("final blocked verdict cannot suppress retained output access");
    assert_eq!(output.chunks[0].data, "cursor-relative output");
    let lifecycle = output
        .lifecycle
        .expect("classified failed recovery remains a typed blocked observation");
    assert_eq!(lifecycle.state, ManagedLifecycleState::Blocked);
    assert_eq!(
        lifecycle.recovery_summary.unwrap().reason.as_deref(),
        Some("invalid_request")
    );
}

#[tokio::test]
async fn changed_host_epoch_replays_from_zero_in_one_supervisor_round_trip() {
    let output = read_fixture("new-epoch", "old-epoch", false).await.unwrap();
    assert!(output.reset_required);
    assert_eq!(output.stream_epoch.as_deref(), Some("new-epoch"));
    assert!(output.incarnation_id.is_some());
    assert_eq!(output.native_session_id.as_deref(), Some("native-owned"));
    assert_eq!(output.chunks[0].seq_start, 1);
    assert_eq!(output.chunks[0].data, "whole retained new epoch");
}

#[tokio::test]
async fn managed_control_rpc_preserves_native_codex_turns_independently_of_terminal_bytes() {
    let output = read_fixture("same-epoch", "same-epoch", false)
        .await
        .unwrap();
    let native = output
        .codex_activity
        .expect("Codex turns must cross the authenticated host output RPC");
    native.validate().unwrap();
    assert!(!native.events[0].completed);
    assert!(native.events[1].completed);
    assert_eq!(native.events[1].status.as_deref(), Some("completed"));
    assert_eq!(output.chunks[0].seq_start, 207);
}

#[tokio::test]
async fn managed_control_rpc_preserves_native_activity_independently_of_terminal_byte_cursor() {
    let output = read_fixture("same-epoch", "same-epoch", false)
        .await
        .unwrap();
    assert_eq!(output.chunks[0].seq_start, 207);
    let native = output
        .opencode_activity
        .expect("native metadata must cross the authenticated output RPC");
    native.validate().unwrap();
    assert_eq!(native.events[0].at, 100);
    assert_eq!(native.events[1].at, 101);
    assert_eq!(native.events[0].seq, 1);
    assert!(matches!(
        native.events[0].event,
        freshell_activity::opencode::OpencodeLaneEvent::Status {
            status: freshell_activity::opencode::OpencodeStatus::Busy,
            ..
        }
    ));
    assert!(matches!(
        native.events[1].event,
        freshell_activity::opencode::OpencodeLaneEvent::Status {
            status: freshell_activity::opencode::OpencodeStatus::Idle,
            ..
        }
    ));
}

#[tokio::test]
async fn same_host_epoch_preserves_the_exact_existing_cursor_without_replay() {
    let output = read_fixture("same-epoch", "same-epoch", false)
        .await
        .unwrap();
    assert!(!output.reset_required);
    assert_eq!(output.chunks[0].seq_start, 207);
    assert_eq!(output.chunks[0].data, "cursor-relative output");
}

#[tokio::test]
async fn authenticated_source_cannot_substitute_another_terminal_for_this_facade() {
    let output = read_fixture("same-epoch", "same-epoch", true).await;
    assert!(
        output.is_err(),
        "authenticated transport is not proof of matching terminal ownership"
    );
}

#[tokio::test]
async fn managed_runtime_failed_retained_read_publishes_blocked_without_fabricating_output() {
    let root = tempfile::tempdir().unwrap();
    let soul = SoulId::new();
    let incarnation = IncarnationId::new();
    let controller = Arc::new(ServerManagedRuntimeController {
        client: RuntimeClient::new(
            root.path().join("missing-control.sock"),
            "synthetic-failed-read",
        ),
        recovery: Arc::new(ManagedRecoveryState::default()),
    });
    controller.recovery.slots.lock().await.insert(
        soul.to_string(),
        SoulRecoverySlot {
            sequence: 1,
            task_in_flight: false,
            incarnation_id: Some(incarnation.to_string()),
            terminal_id: Some("failed-retained-read".into()),
            intent_revision: Some(1),
            evidence_revision: Some(1),
            publication: RecoveryPublication::Failed {
                code: RuntimeErrorCode::HostUnreachable,
                previous: None,
            },
            observed_epoch: None,
            observed_exit_code: None,
            observed_completion: None,
        },
    );
    let registry = freshell_terminal::TerminalRegistry::new();
    let descriptor = ManagedTerminalDescriptor {
        soul_id: soul.to_string(),
        incarnation_id: incarnation.to_string(),
        terminal_id: "failed-retained-read".into(),
        stream_id: "failed-read-epoch".into(),
        mode: "opencode".into(),
        cwd: "/workspace".into(),
        resume_session_id: Some("native-retained-failure".into()),
        create_request_id: Some("failed-read-create".into()),
    };
    registry.register_managed(descriptor.clone(), "Shell".to_string());
    registry.set_managed_controller(Some(controller.clone()));
    let result = registry
        .refresh_managed_output(&descriptor.terminal_id, 65536)
        .await;
    assert!(
        result.is_err(),
        "unreadable retained output must remain an actual error"
    );
    let inventory = registry.inventory();
    assert_eq!(inventory.len(), 1);
    assert_eq!(
        inventory[0].runtime_status,
        Some(freshell_protocol::RuntimeStatus::Blocked)
    );
    assert_eq!(
        inventory[0]
            .recovery_summary
            .as_ref()
            .unwrap()
            .reason
            .as_deref(),
        Some("host_unreachable")
    );
    assert_eq!(
        registry.managed_output_cursor(&descriptor.terminal_id),
        Some(0)
    );
    assert!(registry
        .managed_descriptor(&descriptor.terminal_id)
        .is_some());
    assert!(controller
        .input(descriptor, "must not dispatch".into())
        .await
        .is_err());
}

async fn first_eof_evidence() -> (
    ManagedOutputRead,
    (Option<String>, Option<i64>, Option<ManagedOutputCompletion>),
    Vec<serde_json::Value>,
    String,
) {
    use tracing::instrument::WithSubscriber;
    use tracing_subscriber::prelude::*;
    let events = Arc::new(std::sync::Mutex::new(vec![]));
    let subscriber =
        tracing_subscriber::registry().with(super::tests::transitions::CaptureLogs(events.clone()));
    let root = tempfile::tempdir().unwrap();
    let socket_path = root.path().join("first-eof-control.sock");
    let listener = UnixListener::bind(&socket_path).unwrap();
    let soul = SoulId::new();
    let incarnation = IncarnationId::new();
    let controller = Arc::new(ServerManagedRuntimeController {
        client: RuntimeClient::new(&socket_path, "synthetic-first-eof"),
        recovery: Arc::default(),
    });
    let server_controller = controller.clone();
    let server_soul = soul.clone();
    let server_incarnation = incarnation.clone();
    let server = tokio::spawn(async move {
        let mut observation = None;
        for _ in 0..3 {
            let (mut peer, _) = listener.accept().await.unwrap();
            let request: Envelope<AdminCommand> = read_frame(&mut peer).await.unwrap();
            let result = match request.body {
                AdminCommand::Health => AdminResult::Health {
                    control_epoch: 1,
                    installation_id: InstallationId::new(),
                },
                AdminCommand::TerminalReadOutput(_) => {
                    AdminResult::TerminalOutput(RuntimeOutputBatch {
                        codex_activity: None,
                        opencode_activity: None,
                        incarnation_id: server_incarnation.clone(),
                        terminal_id: "first-eof-terminal".into(),
                        stream_epoch: "actual-first-host-epoch".into(),
                        retained_from_seq: 1,
                        head_seq: 1,
                        reset_required: false,
                        truncated: false,
                        exited: true,
                        exit_code: Some(19),
                        native_session_id: None,
                        completion: None,
                        frames: vec![RuntimeOutputFrame {
                            terminal_id: "first-eof-terminal".into(),
                            stream_epoch: "actual-first-host-epoch".into(),
                            seq_start: 1,
                            seq_end: 1,
                            data: "final tail".into(),
                        }],
                    })
                }
                AdminCommand::Recover(_) => {
                    let slots = server_controller.recovery.slots.lock().await;
                    let slot = slots
                        .get(server_soul.as_str())
                        .expect("recovery owns a slot before dispatch");
                    observation = Some((
                        slot.observed_epoch.clone(),
                        slot.observed_exit_code,
                        slot.observed_completion.clone(),
                    ));
                    drop(slots);
                    let view: RuntimeView = serde_json::from_value(serde_json::json!({
                        "soulId":server_soul,"incarnationId":server_incarnation,"launchState":"stopped",
                        "cleanupState":"verified_empty","desiredState":"stopped","recoveryState":"stopped",
                        "intentRevision":1,"executionGeneration":1,"terminalId":"first-eof-terminal",
                        "terminalStreamId":"actual-first-host-epoch","terminalMode":"shell","terminalCwd":"/workspace"
                    })).unwrap();
                    AdminResult::Recovery(freshell_runtime_protocol::RecoveryResult {
                        outcome: RecoveryOutcome::Stopped,
                        view,
                        probe: None,
                        prior_incarnation_id: None,
                        attempt_id: None,
                        expected_native_session_id: None,
                        observed_native_session_id: None,
                        incident_id: None,
                    })
                }
                other => panic!("unexpected first EOF command: {other:?}"),
            };
            write_frame(
                &mut peer,
                &AdminReply {
                    request_id: request.request_id,
                    result: Ok(result),
                },
            )
            .await
            .unwrap();
        }
        observation.unwrap()
    });
    let read = controller
        .read_output(
            ManagedTerminalDescriptor {
                soul_id: soul.to_string(),
                incarnation_id: incarnation.to_string(),
                terminal_id: "first-eof-terminal".into(),
                stream_id: "actual-first-host-epoch".into(),
                mode: "shell".into(),
                cwd: "/workspace".into(),
                resume_session_id: None,
                create_request_id: None,
            },
            0,
            65536,
        )
        .with_subscriber(subscriber)
        .await;
    let observed = tokio::time::timeout(std::time::Duration::from_secs(15), server)
        .await
        .unwrap()
        .unwrap();
    // The fixture and recovery publication settle before any behavioral assertion.
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while controller.recovery_in_flight(soul.as_str()).await {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let captured = events.lock().unwrap().clone();
    (read.unwrap(), observed, captured, incarnation.to_string())
}

#[tokio::test]
async fn managed_runtime_first_eof_observation_precedes_recovery_dispatch() {
    let (read, observed, _, incarnation) = first_eof_evidence().await;
    assert_eq!(read.chunks[0].data, "final tail");
    assert_eq!(observed.0.as_deref(), Some("actual-first-host-epoch"));
    assert_eq!(observed.1, Some(19));
    let completion = observed
        .2
        .expect("first EOF retains its coherent completion before dispatch");
    assert_eq!(completion.head_seq, 1);
    assert_eq!(completion.exit_code, Some(19));
    assert_eq!(completion.incarnation_id, incarnation);
}

#[tokio::test]
async fn managed_runtime_first_eof_transition_identifies_the_existing_handle() {
    let (_, _, events, incarnation) = first_eof_evidence().await;
    let event = events
        .iter()
        .find(|event| event["fields"]["event"] == "managed_runtime.recovery_transition")
        .expect("first EOF publishes a recovery transition");
    assert_eq!(event["fields"]["terminal_id"], "first-eof-terminal");
    assert_eq!(event["fields"]["incarnation_id"], incarnation);
    for field in ["soul_id", "from", "to", "cause"] {
        assert!(!event["fields"][field].is_null());
    }
}

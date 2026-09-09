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
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("control.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let source_epoch = source_epoch.to_string();
    let expected_epoch = expected_epoch.to_string();
    let source_for_server = source_epoch.clone();
    let changed = source_epoch != expected_epoch;
    let server = tokio::spawn(async move {
        let incarnation = IncarnationId::new();
        let mut cursors = Vec::new();
        for index in 0..if changed { 3 } else { 2 } {
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
                cursors.push(read.after_seq);
                let seq = read.after_seq + 1;
                let terminal = if foreign_terminal {
                    "another-terminal"
                } else {
                    "terminal-owned"
                };
                AdminResult::TerminalOutput(RuntimeOutputBatch {
                    incarnation_id: incarnation.clone(),
                    terminal_id: terminal.into(),
                    stream_epoch: source_for_server.clone(),
                    retained_from_seq: 1,
                    head_seq: 300,
                    reset_required: false,
                    truncated: false,
                    exited: false,
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
        assert_eq!(cursors, if changed { vec![206, 0] } else { vec![206] });
    });
    let controller = ServerManagedRuntimeController {
        client: RuntimeClient::new(&socket, "synthetic-epoch-test-secret"),
        recovery: Arc::new(ManagedRecoveryState::default()),
    };
    let result = controller
        .read_output(
            ManagedTerminalDescriptor {
                soul_id: SoulId::new().to_string(),
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
    tokio::time::timeout(std::time::Duration::from_secs(5), server)
        .await
        .unwrap()
        .unwrap();
    result
}

#[tokio::test]
async fn changed_host_epoch_replays_from_zero_even_if_new_head_exceeds_old_cursor() {
    let output = read_fixture("new-epoch", "old-epoch", false).await.unwrap();
    assert!(output.reset_required);
    assert_eq!(output.stream_epoch.as_deref(), Some("new-epoch"));
    assert!(output.incarnation_id.is_some());
    assert_eq!(output.native_session_id.as_deref(), Some("native-owned"));
    assert_eq!(output.chunks[0].seq_start, 1);
    assert_eq!(output.chunks[0].data, "whole retained new epoch");
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

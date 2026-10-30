//! Authenticated input refusals stay typed without retaining native/provider detail.
use super::*;
use freshell_runtime_protocol::{
    read_frame, write_frame, AdminCommand, AdminReply, AdminResult, CommandState, Envelope,
    InstallationId, RuntimeDiagnosticCode, RuntimeError,
};
use tokio::net::UnixListener;

#[tokio::test]
async fn native_readiness_refusal_remains_body_free_and_requires_explicit_input_retry() {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("input.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let soul = SoulId::new();
    let expected_soul = soul.clone();
    let server = tokio::spawn(async move {
        let mut input_ids = std::collections::HashSet::new();
        let mut accepted = 0;
        for index in 0..4 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request: Envelope<AdminCommand> = read_frame(&mut socket).await.unwrap();
            assert_eq!(request.auth.as_deref(), Some("synthetic-input-secret"));
            let result = match request.body {
                AdminCommand::Health if index == 0 => Ok(AdminResult::Health {
                    control_epoch: 1,
                    installation_id: InstallationId::new(),
                }),
                AdminCommand::TerminalInput(input) => {
                    assert_eq!(input.soul_id, expected_soul);
                    assert_eq!(input.data, "synthetic-input\r");
                    assert!(input_ids.insert(request.request_id.clone()));
                    if index < 3 {
                        let diagnostic = if index == 1 {
                            RuntimeDiagnosticCode::OpencodeActivityReadyTimeout
                        } else {
                            RuntimeDiagnosticCode::OpencodeActivityDisconnected
                        };
                        Err(RuntimeError::new(
                            RuntimeErrorCode::RecoveryBlocked,
                            "private-provider-readiness-detail-sentinel",
                        )
                        .with_diagnostic_code(diagnostic))
                    } else {
                        accepted += 1;
                        Ok(AdminResult::TerminalInput {
                            state: CommandState::Completed,
                        })
                    }
                }
                _ => panic!("input must not trigger recovery, launch, or implicit redispatch"),
            };
            write_frame(
                &mut socket,
                &AdminReply {
                    request_id: request.request_id,
                    result,
                },
            )
            .await
            .unwrap();
        }
        assert_eq!(input_ids.len(), 3);
        assert_eq!(accepted, 1);
    });
    let controller = ServerManagedRuntimeController {
        client: RuntimeClient::new(&socket, "synthetic-input-secret"),
        recovery: Arc::new(ManagedRecoveryState::default()),
    };
    let terminal = ManagedTerminalDescriptor {
        soul_id: soul.to_string(),
        incarnation_id: IncarnationId::new().to_string(),
        terminal_id: "input-terminal".into(),
        stream_id: "input-stream".into(),
        mode: "opencode".into(),
        cwd: "/workspace".into(),
        resume_session_id: Some("ses_input".into()),
        create_request_id: None,
    };
    let mut refused = Vec::new();
    for _ in 0..2 {
        refused.push(
            controller
                .input(terminal.clone(), "synthetic-input\r".into())
                .await
                .unwrap_err(),
        );
    }
    controller
        .input(terminal, "synthetic-input\r".into())
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), server)
        .await
        .unwrap()
        .unwrap();
    for refusal in refused {
        assert_eq!(refusal, ManagedTerminalInputError::RecoveryBlocked);
        assert!(
            !refusal.to_string().contains("private-provider"),
            "native detail must not escape the typed input boundary"
        );
    }
}

#[tokio::test]
async fn input_during_recovery_is_typed_pending_without_contacting_supervisor() {
    let dir = tempfile::tempdir().unwrap();
    let soul = SoulId::new();
    let controller = ServerManagedRuntimeController {
        client: RuntimeClient::new(dir.path().join("unbound.sock"), "synthetic-input-secret"),
        recovery: Arc::new(ManagedRecoveryState::default()),
    };
    controller
        .begin_recovery(&soul, false)
        .await
        .expect("reserve the actual controller recovery slot");
    let refusal = controller
        .input(
            ManagedTerminalDescriptor {
                soul_id: soul.to_string(),
                incarnation_id: IncarnationId::new().to_string(),
                terminal_id: "pending-input".into(),
                stream_id: "pending-stream".into(),
                mode: "opencode".into(),
                cwd: "/workspace".into(),
                resume_session_id: Some("ses_pending".into()),
                create_request_id: None,
            },
            "synthetic-input\r".into(),
        )
        .await
        .unwrap_err();
    assert_eq!(refusal, ManagedTerminalInputError::RecoveryPending);
}

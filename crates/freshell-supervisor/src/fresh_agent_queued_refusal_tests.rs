#[tokio::test]
async fn queued_fresh_agent_refusal_is_not_misclassified_as_ambiguous_or_replayed() {
    use freshell_runtime_protocol::{
        host_proof, read_frame, write_frame, ControlRole, Envelope, FreshAgentSendDiagnostic,
        FreshAgentSendDiagnosticOutcome, HostBootId, HostReply,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};
    for reported_state in [false, true] {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("runtime")).unwrap();
        let registry = crate::registry::Registry::open(root.path().join("registry"), None).unwrap();
        let soul = SoulId::new();
        let prepared =
            crate::registry::tests::materialize_fresh_runtime(&registry, soul.clone(), root.path())
                .await;
        let host_dir = root.path().join("host");
        std::fs::create_dir(&host_dir).unwrap();
        let host_secret = b"owned-queued-refusal-secret";
        std::fs::write(host_dir.join("secret"), host_secret).unwrap();
        let database = rusqlite::Connection::open(registry.database_path()).unwrap();
        database
            .execute(
                "UPDATE incarnations SET runtime_dir=?1 WHERE incarnation_id=?2",
                rusqlite::params![host_dir.to_string_lossy(), prepared.incarnation_id.as_str()],
            )
            .unwrap();
        drop(database);
        let request = RequestId::parse("queued-refusal").unwrap();
        registry
            .begin_fresh_input(
                soul.clone(),
                request.clone(),
                b"queued input",
                b"null",
                None,
            )
            .await
            .unwrap();
        let limits = registry
            .recovery_context(soul.clone())
            .await
            .unwrap()
            .requested_limits;
        let listener = tokio::net::UnixListener::bind(host_dir.join("host.sock")).unwrap();
        let sends = Arc::new(AtomicUsize::new(0));
        let observed = sends.clone();
        let host = tokio::spawn(async move {
            let boot = HostBootId::new();
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let envelope: Envelope<HostCommand> = read_frame(&mut socket).await.unwrap();
                assert_eq!(envelope.role, ControlRole::Supervisor);
                let result =
                    match envelope.body {
                        HostCommand::Hello {
                            incarnation_id,
                            challenge,
                        } => Ok(HostResult::Hello {
                            host_boot_id: boot.clone(),
                            proof: host_proof(host_secret, &challenge, &boot, &incarnation_id),
                            capabilities: vec![],
                            effective_limits: limits,
                        }),
                        HostCommand::FreshAgentSend { text, .. } => {
                            observed.fetch_add(1, Ordering::SeqCst);
                            assert_eq!(text, "queued input");
                            if reported_state {
                                Ok(HostResult::FreshAgentCommand {
                                    state: CommandState::Cancelled,
                                    native_session_id: None,
                                    native_identity: None,
                                    claude_fork: None,
                                })
                            } else {
                                Err(RuntimeError::new(
                                    RuntimeErrorCode::HostUnreachable,
                                    "hosted fresh-agent command failed",
                                )
                                .with_fresh_agent_send_diagnostic(FreshAgentSendDiagnostic {
                                    outcome: FreshAgentSendDiagnosticOutcome::Refused,
                                    message: Some("already-published queued refusal".into()),
                                }))
                            }
                        }
                        other => panic!("unexpected recovery host command: {other:?}"),
                    };
                write_frame(
                    &mut socket,
                    &HostReply {
                        request_id: envelope.request_id,
                        result,
                    },
                )
                .await
                .unwrap();
            }
        });
        let supervisor = missing_supervisor(&root, registry.clone());
        supervisor
            .replay_queued_inputs(soul.clone(), prepared.incarnation_id.clone())
            .await
            .unwrap();
        let outcome = registry
            .recorded_input_outcome(
                soul.clone(),
                request.clone(),
                b"queued input",
                Some(b"null"),
            )
            .await
            .unwrap();
        assert!(
            format!("{outcome:?}").contains("Refused"),
            "a known refusal must remain definite: {outcome:?}"
        );
        supervisor
            .replay_queued_inputs(soul, prepared.incarnation_id)
            .await
            .unwrap();
        assert_eq!(
            sends.load(Ordering::SeqCst),
            1,
            "recovery must not replay the refused prompt"
        );
        host.abort();
        let _ = host.await;
    }
}

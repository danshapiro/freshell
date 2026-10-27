//! Name reliability (Task 8, D6): a managed terminal launch requests its
//! automatic view WITHOUT a title. The view title used to be the provider
//! label ("Shell agent", "OpenCode agent"), which every browser refresh then
//! wrote over the tab's real name. Names belong to the user and the saved
//! name document, never to the runtime.
//!
//! The actual controller launch path runs against a synthetic supervisor on
//! an owned Unix socket; only the supervisor's replies are fixed.
use super::*;
use freshell_runtime_protocol::*;
use std::collections::BTreeMap;
use tokio::net::UnixListener;

#[tokio::test]
async fn managed_launch_sends_no_provider_label_title() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let socket = root.path().join("supervisor.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let (captured_tx, captured_rx) = tokio::sync::oneshot::channel::<LaunchRequest>();
    let supervisor = tokio::spawn(async move {
        let mut captured = Some(captured_tx);
        while captured.is_some() {
            let (mut peer, _) = listener.accept().await.unwrap();
            let envelope: Envelope<AdminCommand> = read_frame(&mut peer).await.unwrap();
            let result = match envelope.body {
                AdminCommand::Health => Ok(AdminResult::Health {
                    control_epoch: 1,
                    installation_id: InstallationId::new(),
                }),
                AdminCommand::Inventory => Ok(AdminResult::Inventory(vec![])),
                AdminCommand::Launch(request) => {
                    let view: RuntimeView = serde_json::from_value(serde_json::json!({
                        "soulId": request.soul_id, "incarnationId": IncarnationId::new(),
                        "launchState": "running", "cleanupState": "none", "intentRevision": 1,
                        "executionGeneration": 1, "desiredState": "running", "recoveryState": "live",
                        "durabilityState": "unknown", "allocationState": "allocated",
                        "evidenceRevision": 0, "successfulRecoveriesInWindow": 0
                    }))
                    .unwrap();
                    let reply = AdminResult::Launch(LaunchResult {
                        view,
                        worker_pid: 1,
                        worker_launch_count: 1,
                        host_boot_id: HostBootId::new(),
                        effective_limits: request.limits,
                        fixture_evidence: serde_json::Value::Null,
                    });
                    if let Some(sender) = captured.take() {
                        let _ = sender.send(*request);
                    }
                    Ok(reply)
                }
                other => panic!("unexpected supervisor command during a shell launch: {other:?}"),
            };
            write_frame(
                &mut peer,
                &AdminReply {
                    request_id: envelope.request_id,
                    result,
                },
            )
            .await
            .unwrap();
        }
    });
    let controller = ServerManagedRuntimeController {
        client: RuntimeClient::new(&socket, "fixture-control-secret"),
        recovery: Arc::new(ManagedRecoveryState::default()),
    };

    controller
        .launch(ManagedTerminalLaunch {
            spec: freshell_platform::SpawnSpec {
                program: "bash".into(),
                args: vec![],
                env_overrides: BTreeMap::new(),
                cwd: Some(workspace.to_string_lossy().into_owned()),
                cols: 80,
                rows: 24,
            },
            env: BTreeMap::new(),
            terminal_id: "terminal-untitled".into(),
            stream_id: "stream-untitled".into(),
            mode: "shell".into(),
            resume_session_id: None,
            provider_model: None,
            provider_reasoning_effort: None,
            provider_sandbox: None,
            provider_permission_mode: None,
            view_tab_id: Some("tab-untitled".into()),
            view_pane_id: Some("pane-untitled".into()),
            create_request_id: Some("create-untitled".into()),
        })
        .await
        .expect("the managed shell launch succeeds against the synthetic supervisor");
    let request = captured_rx.await.unwrap();
    supervisor.await.unwrap();

    let view = request
        .view_intent
        .expect("a managed launch requests its automatic primary view");
    assert_eq!(
        view.title, None,
        "the runtime never names a view (it used to send a provider label)"
    );
    assert_eq!(view.kind, ViewIntentKind::AutomaticPrimary);
    assert_eq!(view.preferred_tab_id.as_deref(), Some("tab-untitled"));
    assert_eq!(view.preferred_pane_id.as_deref(), Some("pane-untitled"));
}

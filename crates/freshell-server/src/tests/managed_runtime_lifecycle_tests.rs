use super::*;
use freshell_runtime_protocol::*;
use freshell_terminal::TerminalRegistry;
use serde_json::{json, Value};

async fn tool_listing(url: &str, mcp: bool) -> Value {
    let mut command = tokio::process::Command::new("node");
    command.args(["--import", "tsx"]);
    if mcp {
        command.args(["--input-type=module","-e",
            "import {executeAction} from './tools/freshell-mcp/freshell-tool.ts'; executeAction('list-terminals').then(v=>{console.log(JSON.stringify(v));process.exit(0)}).catch(e=>{console.error(e);process.exit(1)});"]);
    } else {
        command.args(["tools/freshell-cli/index.ts", "list-terminals"]);
    }
    command
        .current_dir(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .parent()
                .unwrap(),
        )
        .env("FRESHELL_URL", url)
        .env("FRESHELL_TOKEN", "synthetic-directory-token")
        .kill_on_drop(true);
    let result = tokio::time::timeout(std::time::Duration::from_secs(20), command.output())
        .await
        .unwrap()
        .unwrap();
    assert!(
        result.status.success(),
        "actual tool failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    serde_json::from_slice(&result.stdout).expect("actual tool JSON")
}

async fn directory_fixture(
    recovery_state: &str,
) -> (
    Vec<Value>,
    Vec<freshell_protocol::InventoryTerminal>,
    bool,
    String,
) {
    directory_fixture_with_retry(recovery_state, false).await
}
async fn directory_fixture_with_retry(
    recovery_state: &str,
    manual_retry: bool,
) -> (
    Vec<Value>,
    Vec<freshell_protocol::InventoryTerminal>,
    bool,
    String,
) {
    let root = tempfile::tempdir().unwrap();
    let socket = root.path().join("directory-control.sock");
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    let soul = SoulId::new();
    let incarnation = IncarnationId::new();
    let ended = matches!(recovery_state, "lost" | "stopped");
    let outcome = if recovery_state == "lost" {
        RecoveryOutcome::Lost
    } else if recovery_state == "stopped" {
        RecoveryOutcome::Stopped
    } else {
        RecoveryOutcome::Blocked
    };
    let view:RuntimeView=serde_json::from_value(json!({"soulId":soul,"incarnationId":incarnation,
        "launchState":if ended {"stopped"} else {"running"},"cleanupState":if ended {"verified_empty"} else {"none"},
        "intentRevision":1,"executionGeneration":1,"terminalId":"directory-retained","terminalStreamId":"directory-epoch",
        "terminalMode":if ended {"shell"} else {"opencode"},"terminalCwd":"/workspace",
        "desiredState":if recovery_state=="stopped" {"stopped"} else {"running"},"recoveryState":recovery_state,
        "recoveryReason":if ended {"non_resumable_terminal_ended"} else {"ambiguous_identity"},
        "nativeSessionId":"native-directory-retained","incidentId":"incident-directory-retained",
        "recoveryAttemptId":"recovery-directory-retained"
    })).unwrap();
    let mut control_view = view.clone();
    let (stop_control, mut control_stop) = tokio::sync::oneshot::channel();
    let control = tokio::spawn(async move {
        loop {
            let mut peer = tokio::select! {_=&mut control_stop=>break,accepted=listener.accept()=>accepted.unwrap().0};
            let request: Envelope<AdminCommand> = read_frame(&mut peer).await.unwrap();
            let result = match request.body {
                AdminCommand::Health => AdminResult::Health {
                    control_epoch: 1,
                    installation_id: InstallationId::new(),
                },
                AdminCommand::Inventory => AdminResult::Inventory(vec![control_view.clone()]),
                AdminCommand::InventorySnapshot => {
                    AdminResult::InventorySnapshot(RuntimeInventorySnapshot {
                        revision: 1,
                        readiness: serde_json::from_value(
                            json!({"inventoryRevision":1,"initialScanState":"complete"}),
                        )
                        .unwrap(),
                        souls: vec![control_view.clone()],
                        view_intents: vec![],
                        pending_projection_count: 0,
                    })
                }
                AdminCommand::TerminalReadOutput(read) => {
                    AdminResult::TerminalOutput(RuntimeOutputBatch {
                        incarnation_id: incarnation.clone(),
                        terminal_id: "directory-retained".into(),
                        stream_epoch: "directory-epoch".into(),
                        retained_from_seq: 1,
                        head_seq: 1,
                        reset_required: false,
                        truncated: false,
                        exited: ended,
                        completion: None,
                        exit_code: ended.then_some(23),
                        native_session_id: Some("native-directory-retained".into()),
                        frames: if read.after_seq == 0 {
                            vec![RuntimeOutputFrame {
                                terminal_id: "directory-retained".into(),
                                stream_epoch: "directory-epoch".into(),
                                seq_start: 1,
                                seq_end: 1,
                                data: "retained directory diagnostic".into(),
                            }]
                        } else {
                            vec![]
                        },
                    })
                }
                AdminCommand::Recover(request) => {
                    if request.trigger == RecoveryTrigger::ManualRetry {
                        control_view.recovery_state = RecoveryState::Live;
                        control_view.launch_state = LaunchState::Running;
                        control_view.cleanup_state = CleanupState::None;
                        control_view.recovery_reason = None;
                    }
                    AdminResult::Recovery(RecoveryResult {
                        outcome: if request.trigger == RecoveryTrigger::ManualRetry {
                            RecoveryOutcome::AlreadyLive
                        } else {
                            outcome
                        },
                        view: control_view.clone(),
                        probe: None,
                        prior_incarnation_id: None,
                        attempt_id: control_view.recovery_attempt_id.clone(),
                        expected_native_session_id: None,
                        observed_native_session_id: None,
                        incident_id: control_view.incident_id.clone(),
                    })
                }
                AdminCommand::TerminalInput(_) => AdminResult::TerminalInput {
                    state: CommandState::Completed,
                },
                other => panic!("unexpected managed directory command {other:?}"),
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
    });
    let controller = Arc::new(ServerManagedRuntimeController {
        client: RuntimeClient::new(&socket, "synthetic-control"),
        recovery: Arc::new(ManagedRecoveryState::default()),
    });
    let registry = TerminalRegistry::new();
    registry.set_managed_controller(Some(controller.clone()));
    // Register the same exact identity even on the old cold-lookup failure so
    // every plain/paged/tool surface actually executes before RED assertions.
    let descriptor = controller
        .lookup_terminal("directory-retained", None)
        .await
        .unwrap()
        .unwrap_or_else(|| managed_descriptor_from_view(&view, None).unwrap());
    registry.register_managed(descriptor, "Shell".to_string());
    let read = registry
        .refresh_managed_output("directory-retained", 65536)
        .await
        .unwrap();
    registry.publish_managed_lifecycle("directory-retained", read.lifecycle.clone());
    if let Some(code) = read.exit_code {
        if registry.managed_output_cursor("directory-retained") == Some(read.head_seq) {
            registry.finish_managed_exit("directory-retained", code);
        }
    }
    for _ in 0..100 {
        if !controller.recovery_in_flight(soul.as_str()).await {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let (broadcast, _) = tokio::sync::broadcast::channel(16);
    let state = crate::terminals::TerminalsState {
        auth_token: Arc::new("synthetic-directory-token".into()),
        settings: crate::settings_store::SettingsStore::load(Some(root.path()), vec![]),
        registry: registry.clone(),
        broadcast_tx: Arc::new(broadcast),
        terminals_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
    };
    let api_state = crate::managed_runtime_api::ManagedRuntimeApiState::new(
        Arc::new("synthetic-directory-token".into()),
        Some(controller.runtime_client()),
        None,
        Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
            root.path().join("ledger"),
        ))),
        state.broadcast_tx.clone(),
    )
    .await
    .unwrap()
    .with_terminal_controller(Some(controller.clone()));
    let app = crate::terminals::router(state).merge(crate::managed_runtime_api::router(api_state));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (stop_http, http_stop) = tokio::sync::oneshot::channel();
    let http = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                http_stop.await.ok();
            })
            .await
            .unwrap();
    });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    if manual_retry {
        let initial = registry
            .managed_input("directory-retained", "blocked bytes".into())
            .await;
        // Retain the result, and assert after both fixtures have actually joined.
        let response = client
            .post(format!("{url}/api/runtime/souls/{soul}/retry"))
            .header("x-auth-token", "synthetic-directory-token")
            .json(&json!({"requestId":RequestId::new(),"expectedIntentRevision":1}))
            .send()
            .await
            .unwrap();
        let retry: Value = response.json().await.unwrap();
        let read = registry
            .refresh_managed_output("directory-retained", 65536)
            .await
            .unwrap();
        registry.publish_managed_lifecycle("directory-retained", read.lifecycle);
        let mut listings = vec![];
        for suffix in ["/api/terminals", "/api/terminals?priority=visible"] {
            let listing: Value = client
                .get(format!("{url}{suffix}"))
                .header("x-auth-token", "synthetic-directory-token")
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            listings.push(if listing.is_array() {
                listing
            } else {
                listing["items"].clone()
            });
        }
        listings.push(tool_listing(&url, false).await);
        listings.push(tool_listing(&url, true).await);
        let input_blocked = registry
            .managed_input("directory-retained", "retry bytes".into())
            .await
            .is_err();
        let inventory = registry.inventory();
        let snapshot = registry.directory()[0].snapshot.clone();
        stop_http.send(()).unwrap();
        http.await.unwrap();
        stop_control.send(()).unwrap();
        control.await.unwrap();
        assert!(
            initial.is_err(),
            "cold retained blocked/recovering facade refuses input before manual retry"
        );
        assert_eq!(
            retry["outcome"], "already_live",
            "actual HTTP retry publishes a full successful outcome"
        );
        return (listings, inventory, input_blocked, snapshot);
    }
    let mut listings = vec![];
    for suffix in ["/api/terminals", "/api/terminals?priority=visible"] {
        let response: Value = client
            .get(format!("{url}{suffix}"))
            .header("x-auth-token", "synthetic-directory-token")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        listings.push(if response.is_array() {
            response
        } else {
            response["items"].clone()
        });
    }
    listings.push(tool_listing(&url, false).await);
    listings.push(tool_listing(&url, true).await);
    let input_blocked = registry
        .managed_input("directory-retained", "not dispatched".into())
        .await
        .is_err();
    let inventory = registry.inventory();
    let snapshot = registry.directory()[0].snapshot.clone();
    stop_http.send(()).unwrap();
    http.await.unwrap();
    stop_control.send(()).unwrap();
    control.await.unwrap();
    (listings, inventory, input_blocked, snapshot)
}

#[tokio::test]
async fn managed_runtime_actual_plain_paged_mcp_cli_keep_blocked_retained_facade() {
    let (listings, inventory, input_blocked, snapshot) = directory_fixture("blocked").await;
    for listing in listings {
        assert_eq!(listing[0]["terminalId"], "directory-retained");
        assert_eq!(
            listing[0]["status"], "blocked",
            "actual Rust facade and all pass-through listings report blocked"
        );
        assert_eq!(
            listing[0]["sessionRef"]["sessionId"],
            "native-directory-retained"
        );
        assert_eq!(
            listing[0]["recoverySummary"]["incidentId"],
            "incident-directory-retained"
        );
    }
    assert_eq!(inventory[0].terminal_id, "directory-retained");
    assert!(
        input_blocked,
        "blocked retained handle refuses input without automatic retry"
    );
    assert_eq!(snapshot, "retained directory diagnostic");
}

#[tokio::test]
async fn managed_runtime_actual_plain_paged_mcp_cli_keep_verified_final_facades() {
    for state in ["lost", "stopped"] {
        let (listings, inventory, input_blocked, snapshot) = directory_fixture(state).await;
        for listing in listings {
            assert_eq!(listing[0]["status"], "exited");
            assert_eq!(listing[0]["terminalId"], "directory-retained");
        }
        assert_eq!(
            inventory[0].status,
            freshell_protocol::TerminalRunStatus::Exited
        );
        assert!(input_blocked);
        assert_eq!(snapshot, "retained directory diagnostic");
    }
}

#[tokio::test]
async fn managed_runtime_actual_http_retry_from_blocked_and_cold_recovering_restores_all_listings_and_input(
) {
    for state in ["blocked", "recovering"] {
        let (listings, inventory, input_blocked, snapshot) =
            directory_fixture_with_retry(state, true).await;
        for listing in listings {
            assert_eq!(listing[0]["status"], "running");
            assert_eq!(listing[0]["terminalId"], "directory-retained");
            assert_eq!(
                listing[0]["sessionRef"]["sessionId"],
                "native-directory-retained"
            );
            assert_eq!(listing[0]["recoverySummary"]["recoveryState"], "live");
        }
        assert_eq!(
            inventory[0].runtime_status,
            Some(freshell_protocol::RuntimeStatus::Running)
        );
        assert!(
            !input_blocked,
            "successful explicit retry unblocks actual input"
        );
        assert_eq!(snapshot, "retained directory diagnostic");
    }
}

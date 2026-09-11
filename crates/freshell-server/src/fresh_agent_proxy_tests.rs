use super::*;
use freshell_protocol::FreshAgentFork;
use freshell_runtime_protocol::{
    read_frame, write_frame, AdminCommand, AdminReply, AdminResult, AllocationState, CleanupState,
    ControlRole, DurabilityState, Envelope, FreshAgentForkResult, IncarnationId, InstallationId,
    LaunchState, RecoveryState, RuntimeErrorCode, RuntimeInventorySnapshot, RuntimeProfile,
    RuntimeReadiness, RuntimeView, ViewIntent, ViewIntentId, ViewVisibilityIntent,
};
use tokio::net::UnixListener;

#[test]
fn presentation_rewrite_keeps_materialized_native_identity() {
    let mut created = serde_json::json!({
        "type":"freshAgent.created",
        "sessionId":"internal",
        "sessionRef":{"provider":"opencode","sessionId":"internal"}
    });
    rewrite_presentation_id(&mut created, "public");
    assert_eq!(created["sessionId"], "public");
    assert_eq!(created["sessionRef"]["sessionId"], "public");

    let mut materialized = serde_json::json!({
        "type":"freshAgent.session.materialized",
        "previousSessionId":"internal",
        "sessionId":"native"
    });
    rewrite_presentation_id(&mut materialized, "public");
    assert_eq!(materialized["previousSessionId"], "public");
    assert_eq!(materialized["sessionId"], "native");
}

#[test]
fn stable_ids_are_provider_scoped_and_do_not_contain_input() {
    let claude = stable_soul_id("claude", "private-request-content").unwrap();
    let codex = stable_soul_id("codex", "private-request-content").unwrap();
    assert_ne!(claude, codex);
    assert!(!claude.as_str().contains("private-request-content"));
}

#[test]
fn kilroy_keeps_claude_public_routing_distinct_from_its_runtime_identity() {
    assert_eq!(fresh_provider_wire(&FreshProvider::Kilroy), "claude");
    assert_eq!(FreshProvider::Kilroy.as_str(), "kilroy");
    assert_eq!(
        rest_agent_identity("claude", "kilroy"),
        Ok((AgentProvider::Claude, SessionType::Kilroy))
    );
    assert!(resume_identity_matches(
        DesiredState::Running,
        Some("kilroy"),
        Some("kilroy-native"),
        Some("managed-kilroy-public"),
        "kilroy",
        "managed-kilroy-public",
    ));
}

#[test]
fn fixture_mode_selection_is_exact_and_rejects_duplicates() {
    assert_eq!(
        parse_fixture_modes("freshclaude,kilroy,freshcodex,freshopencode")
            .unwrap()
            .len(),
        4
    );
    for invalid in [
        "",
        "all",
        "claude",
        "freshclaude, freshcodex",
        "freshcodex,freshcodex",
        "freshopencode,",
    ] {
        assert!(
            parse_fixture_modes(invalid).is_err(),
            "accepted {invalid:?}"
        );
    }
}

#[test]
fn resume_reuses_only_the_exact_running_soul_identity() {
    assert!(resume_identity_matches(
        DesiredState::Running,
        Some("codex"),
        Some("thread-7"),
        Some("managed-codex-public"),
        "codex",
        "thread-7",
    ));
    assert!(resume_identity_matches(
        DesiredState::Running,
        Some("codex"),
        Some("thread-7"),
        Some("managed-codex-public"),
        "codex",
        "managed-codex-public",
    ));
    assert!(!resume_identity_matches(
        DesiredState::Running,
        Some("claude"),
        Some("thread-7"),
        None,
        "codex",
        "thread-7",
    ));
    assert!(!resume_identity_matches(
        DesiredState::Stopped,
        Some("codex"),
        Some("thread-7"),
        None,
        "codex",
        "thread-7",
    ));
}

#[test]
fn only_provider_terminal_edges_complete_a_rest_turn() {
    assert!(provider_event_completes_turn(&AgentEvent::Provider {
        payload: serde_json::json!({
            "type":"freshAgent.event",
            "event":{"type":"freshAgent.turn.complete"}
        }),
    }));
    assert!(provider_event_completes_turn(&AgentEvent::Provider {
        payload: serde_json::json!({
            "type":"freshAgent.event",
            "event":{"type":"freshAgent.status","status":"idle"}
        }),
    }));
    assert!(!provider_event_completes_turn(&AgentEvent::Provider {
        payload: serde_json::json!({
            "type":"freshAgent.event",
            "event":{"type":"freshAgent.status","status":"busy"}
        }),
    }));
}

#[test]
fn provider_child_threads_remain_snapshot_topology_not_runtime_creation_intents() {
    let mut payload = serde_json::json!({
        "type":"freshAgent.event",
        "sessionId":"native-parent",
        "provider":"codex",
        "sessionType":"freshcodex",
        "event":{
            "type":"freshAgent.session.snapshot",
            "sessionId":"native-parent",
            "capabilities":{"fork":true,"childThreads":true},
            "childThreads":[
                {"id":"provider-child-1","status":"running"},
                {"id":"provider-child-2","status":"completed"}
            ]
        }
    });
    rewrite_presentation_id(&mut payload, "public-parent");
    assert_eq!(payload["sessionId"], "public-parent");
    // Routing alias is outer-envelope state; provider snapshot identity remains
    // native so nested provider topology is not rewritten into Freshell lifecycle IDs.
    assert_eq!(
        payload["event"]["sessionId"], "public-parent",
        "the gateway rewrites only the containing session to its presentation id",
    );
    assert_eq!(payload["event"]["capabilities"]["childThreads"], true);
    assert_eq!(
        payload["event"]["childThreads"].as_array().unwrap().len(),
        2
    );
    assert_eq!(
        payload["event"]["childThreads"][0]["id"],
        "provider-child-1"
    );
    assert!(payload.get("soulId").is_none());
    assert!(payload["event"]["childThreads"][0].get("soulId").is_none());
}

#[tokio::test]
async fn managed_provider_fork_rekeys_the_same_soul_without_launch_or_stop() {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("supervisor.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let soul = SoulId::parse("soul-same-fork").unwrap();
    let expected_soul = soul.clone();
    let server = tokio::spawn(async move {
        let mut methods = Vec::new();
        for index in 0..2 {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
            assert_eq!(request.role, ControlRole::Web);
            assert_eq!(request.auth.as_deref(), Some("0123456789abcdef"));
            let result = match request.body {
                AdminCommand::Health if index == 0 => {
                    methods.push("health");
                    AdminResult::Health {
                        control_epoch: 77,
                        installation_id: InstallationId::parse("installation-fork-test").unwrap(),
                    }
                }
                AdminCommand::FreshAgentFork(fork) if index == 1 => {
                    methods.push("fresh_agent_fork");
                    assert_eq!(fork.soul_id, expected_soul);
                    assert_eq!(fork.parent_session_id, "public-parent");
                    assert_eq!(fork.input, Some(serde_json::json!({"atTurnId":"turn-4"})));
                    assert_eq!(fork.expected_control_epoch, Some(77));
                    AdminResult::FreshAgentFork(FreshAgentForkResult {
                        parent_session_id: "public-parent".into(),
                        child_session_id: "native-child".into(),
                        parent_retired_by_runtime: true,
                    })
                }
                other => panic!("fork gateway must not launch or stop a soul: {other:?}"),
            };
            write_frame(
                &mut stream,
                &AdminReply {
                    request_id: request.request_id,
                    result: Ok(result),
                },
            )
            .await
            .unwrap();
        }
        methods
    });
    let client = RuntimeClient::new(&socket, "0123456789abcdef");
    let (broadcast, mut receiver) = broadcast::channel(16);
    let proxy = Arc::new(HostedFreshAgentProxy {
        client,
        broadcast: Arc::new(broadcast),
        aliases: Mutex::new(HashMap::from([(
            ("codex".into(), "public-parent".into()),
            soul.clone(),
        )])),
        presentation_ids: Mutex::new(HashMap::from([(soul.clone(), "public-parent".into())])),
        pollers: Mutex::new(HashSet::new()),
        fixture_modes: HashSet::new(),
    });
    Arc::clone(&proxy)
        .handle(HostedFreshAgentCommand::Fork(FreshAgentFork {
            provider: AgentProvider::Codex,
            session_id: "public-parent".into(),
            session_type: SessionType::Freshcodex,
            input: Some(serde_json::json!({"atTurnId":"turn-4"})),
            request_id: Some("fork-request-1".into()),
            cwd: Some("/workspace".into()),
            tab_id: Some("tab-one".into()),
        }))
        .await;

    let frame = tokio::time::timeout(Duration::from_secs(2), receiver.recv())
        .await
        .unwrap()
        .unwrap();
    let message: ServerMessage = serde_json::from_str(&frame).unwrap();
    let ServerMessage::FreshAgentForked(forked) = message else {
        panic!("expected forked reply")
    };
    assert_eq!(forked.parent_session_id, "public-parent");
    assert_eq!(forked.session_id, "native-child");
    assert_eq!(forked.parent_retired_by_runtime, Some(true));
    assert_eq!(
        proxy
            .resolve_soul(
                &AgentProvider::Codex,
                SessionType::Freshcodex,
                "native-child"
            )
            .await,
        Some(soul.clone())
    );
    assert_eq!(
        proxy
            .presentation_ids
            .lock()
            .await
            .get(&soul)
            .map(String::as_str),
        Some("native-child")
    );
    let aliases = proxy.aliases.lock().await;
    assert_eq!(
        aliases.get(&("codex".into(), "native-child".into())),
        Some(&soul)
    );
    assert!(
        !aliases
            .keys()
            .any(|(provider, session)| provider == "codex" && session == "public-parent"),
        "retired parent aliases must not remain command-authoritative after an in-soul fork",
    );
    drop(aliases);
    assert_eq!(server.await.unwrap(), vec!["health", "fresh_agent_fork"]);
}

#[test]
fn semantic_operation_failures_keep_typed_public_codes() {
    use freshell_runtime_client::ClientError;
    assert_eq!(
        operation_error_code(&ClientError::Runtime(
            RuntimeErrorCode::UnsupportedOperation,
            "redacted".into(),
        )),
        "UNSUPPORTED_CAPABILITY"
    );
    assert_eq!(
        operation_error_code(&ClientError::Runtime(
            RuntimeErrorCode::CommandAmbiguous,
            "redacted".into(),
        )),
        "COMMAND_AMBIGUOUS"
    );
    assert_eq!(
        operation_error_code(&ClientError::Runtime(
            RuntimeErrorCode::OperationImplementationUnavailable,
            "redacted".into(),
        )),
        "IMPLEMENTATION_UNAVAILABLE"
    );
}

fn advertised_capabilities() -> serde_json::Value {
    serde_json::json!({
        "send": true,
        "interrupt": true,
        "approvals": true,
        "questions": true,
        "fork": true,
        "worktrees": true,
        "diffs": true,
        "childThreads": true,
        "undo": true,
        "redo": true,
        "settingScopes": {
            "model": "per-send",
            "effort": "per-send",
            "sandbox": "per-send",
            "permissionMode": "per-send"
        }
    })
}

#[test]
fn hosted_snapshot_capabilities_are_intersected_for_every_provider_and_envelope_shape() {
    let providers = [
        ("claude", "freshclaude", true, false),
        ("claude", "kilroy", true, false),
        ("codex", "freshcodex", false, true),
        ("opencode", "freshopencode", true, true),
    ];

    for (provider, session_type, redo_supported, fork_supported) in providers {
        for (snapshot_type, nested) in [
            ("freshAgent.session.snapshot", false),
            ("freshAgent.session.snapshot", true),
            ("freshAgent.snapshot", false),
            ("freshAgent.snapshot", true),
        ] {
            let snapshot = serde_json::json!({
                "type": snapshot_type,
                "provider": provider,
                "sessionType": session_type,
                "sessionId": "native-session",
                "capabilities": advertised_capabilities(),
                "rollback": {
                    "canRedo": true,
                    "undoneDepth": 1,
                    "redoableTurnIds": ["turn-1"]
                }
            });
            let mut payload = if nested {
                serde_json::json!({
                    "type": "freshAgent.event",
                    "provider": provider,
                    "sessionType": session_type,
                    "sessionId": "native-session",
                    "event": snapshot
                })
            } else {
                snapshot
            };

            rewrite_presentation_id(&mut payload, "public-session");
            freshell_agent_runtime::snapshot_projection::project_hosted_snapshot(
                &mut payload,
                provider,
                session_type,
            );
            let projected = if nested { &payload["event"] } else { &payload };
            let capabilities = &projected["capabilities"];

            assert_eq!(capabilities["send"], true, "{provider}/{session_type}");
            assert_eq!(capabilities["interrupt"], true, "{provider}/{session_type}");
            assert_eq!(capabilities["approvals"], true, "{provider}/{session_type}");
            assert_eq!(capabilities["questions"], true, "{provider}/{session_type}");
            assert_eq!(
                capabilities["fork"], fork_supported,
                "{provider}/{session_type}"
            );
            assert_eq!(
                capabilities["worktrees"], false,
                "{provider}/{session_type}"
            );
            assert_eq!(
                capabilities["childThreads"], true,
                "nested provider child topology stays visible without lifecycle promotion"
            );
            assert_eq!(capabilities["diffs"], true, "{provider}/{session_type}");
            assert_eq!(capabilities["undo"], true, "{provider}/{session_type}");
            assert_eq!(
                capabilities["redo"], redo_supported,
                "{provider}/{session_type}"
            );
            assert_eq!(
                projected["rollback"]["canRedo"], redo_supported,
                "{provider}/{session_type}"
            );
            if redo_supported {
                assert_eq!(
                    projected["rollback"]["redoableTurnIds"],
                    serde_json::json!(["turn-1"])
                );
            } else {
                assert!(
                    projected["rollback"].get("redoableTurnIds").is_none(),
                    "redo targets must disappear when redo cannot dispatch"
                );
            }
            assert_eq!(projected["sessionId"], "public-session");
        }
    }
}

#[test]
fn hosted_snapshot_unknown_capability_payloads_fail_closed_without_falsifying_known_truth() {
    for capabilities in [
        serde_json::Value::Null,
        serde_json::json!({}),
        serde_json::json!({"send":"yes","interrupt":1,"fork":true,"undo":true,"redo":true}),
    ] {
        let mut payload = serde_json::json!({
            "type": "freshAgent.event",
            "provider": "opencode",
            "sessionType": "freshopencode",
            "sessionId": "native-session",
            "event": {
                "type": "freshAgent.session.snapshot",
                "sessionId": "native-session",
                "capabilities": capabilities,
                "rollback": {"canRedo": true, "undoneDepth": 1, "redoableTurnIds": ["turn-1"]}
            }
        });

        rewrite_presentation_id(&mut payload, "public-session");
        freshell_agent_runtime::snapshot_projection::project_hosted_snapshot(
            &mut payload,
            "opencode",
            "freshopencode",
        );
        let projected = &payload["event"];
        for capability in [
            "send",
            "interrupt",
            "approvals",
            "questions",
            "fork",
            "worktrees",
            "diffs",
            "childThreads",
            "undo",
            "redo",
        ] {
            assert_eq!(
                projected["capabilities"][capability], false,
                "unknown {capability} must fail closed"
            );
        }
        assert_eq!(projected["rollback"]["canRedo"], false);
        assert!(projected["rollback"].get("redoableTurnIds").is_none());
    }
}

#[test]
fn managed_public_session_id_uses_runtime_provider_for_kilroy() {
    let request = "request-kilroy";
    assert_eq!(
        managed_public_session_id(&FreshProvider::Kilroy, request),
        format!("managed-kilroy-{}", stable_hex(request))
    );
    assert_ne!(
        managed_public_session_id(&FreshProvider::Kilroy, request),
        format!("managed-claude-{}", stable_hex(request))
    );
}

#[test]
fn resolves_a_managed_rest_pane_from_supervisor_view_intent_after_web_restart() {
    let soul = SoulId::parse("soul-rest-recovery").unwrap();
    let snapshot = RuntimeInventorySnapshot {
        revision: 9,
        readiness: RuntimeReadiness {
            inventory_revision: 9,
            initial_scan_state: freshell_runtime_protocol::InitialScanState::Complete,
            initial_scan_started_at: Some(1),
            initial_scan_finished_at: Some(2),
            blocked_subsystems: Vec::new(),
            startup_recovery_concurrency_limit: 4,
            startup_recovery_peak: 1,
            initial_scan_duration_ms: Some(1),
        },
        souls: vec![RuntimeView {
            soul_id: soul.clone(),
            incarnation_id: IncarnationId::parse("incarnation-rest-recovery").unwrap(),
            launch_state: LaunchState::Running,
            cleanup_state: CleanupState::None,
            intent_revision: 3,
            container_id: Some("a".repeat(64)),
            host_boot_id: None,
            execution_generation: 1,
            effective_limits: None,
            configured_limits: None,
            view_intent_revision: Some(2),
            terminal_id: None,
            terminal_stream_id: None,
            terminal_mode: None,
            terminal_cwd: None,
            terminal_create_request_id: None,
            terminal_resume_session_id: None,
            fresh_agent_session_id: Some("managed-kilroy-session".into()),
            fresh_agent_session_type: Some("kilroy".into()),
            fresh_agent_runtime_variant: Some("kilroy-claude-agent-sdk".into()),
            project_key: Some("project-one".into()),
            profile: Some(RuntimeProfile::DefaultAgent),
            desired_state: DesiredState::Running,
            recovery_state: RecoveryState::Live,
            durability_state: DurabilityState::ResumeCaptured,
            allocation_state: AllocationState::VerifiedDurable,
            provider: Some("kilroy".into()),
            native_session_id: Some("native-kilroy".into()),
            recovery_reason: None,
            incident_id: None,
            prior_incarnation_id: None,
            recovery_attempt_id: None,
            evidence_revision: 1,
            successful_recoveries_in_window: 0,
        }],
        view_intents: vec![ViewIntent {
            view_id: ViewIntentId::parse("view-rest-recovery").unwrap(),
            soul_id: soul,
            owner_id: "installation".into(),
            workspace_id: "project-one".into(),
            kind: ViewIntentKind::AutomaticPrimary,
            preferred_tab_id: "tab-restored".into(),
            preferred_pane_id: "pane-restored".into(),
            title: "Kilroy agent".into(),
            placement_group: "Recovered agents".into(),
            visibility: ViewVisibilityIntent::Visible,
            revision: 2,
            soul_intent_revision: 3,
            created_at: 1,
            updated_at: 2,
        }],
        pending_projection_count: 0,
    };
    assert_eq!(
        hosted_rest_pane_from_snapshot(&snapshot, "pane-restored"),
        Some(HostedRestPane {
            tab_id: "tab-restored".into(),
            pane_id: "pane-restored".into(),
            session_id: "managed-kilroy-session".into(),
            provider: "claude".into(),
            session_type: "kilroy".into(),
            title: Some("Kilroy agent".into()),
        })
    );
    assert_eq!(
        hosted_rest_pane_from_snapshot(&snapshot, "not-this-pane"),
        None
    );

    let mut detached = snapshot.clone();
    detached.view_intents[0].visibility = ViewVisibilityIntent::Detached;
    assert_eq!(
        hosted_rest_pane_from_snapshot(&detached, "pane-restored"),
        None,
        "a stale REST pane id must not recreate a deliberately detached view"
    );
}

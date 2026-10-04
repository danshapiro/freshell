use super::*;
use freshell_protocol::{FreshAgentFork, FreshAgentRecoveryStop};
use freshell_runtime_protocol::{
    read_frame, write_frame, AdminCommand, AdminReply, AdminResult, ControlRole, Envelope,
    FreshAgentForkResult, InstallationId, RuntimeErrorCode,
};
use tokio::net::UnixListener;

#[test]
fn hosted_created_frame_uses_the_public_request_identity() {
    let (broadcast, mut receiver) = broadcast::channel(8);
    let proxy = HostedFreshAgentProxy {
        client: RuntimeClient::new("/tmp/unopened-fresh-agent-proxy.sock", "fixture"),
        broadcast: Arc::new(broadcast),
        aliases: Mutex::new(HashMap::new()),
        presentation_ids: Mutex::new(HashMap::new()),
        pollers: Mutex::new(HashSet::new()),
        fixture_modes: HashSet::new(),
        naming: OnceLock::new(),
    };
    proxy.forward_host_event(
        AgentEvent::Provider {
            payload: serde_json::json!({
                "type":"freshAgent.created", "requestId":"host-internal", "sessionId":"native"
            }),
        },
        "claude",
        "public",
        "freshclaude",
    );
    assert!(
        receiver.try_recv().is_err(),
        "internal create ID must not reach the client"
    );
}

#[tokio::test]
async fn managed_recovery_stop_refuses_without_contacting_the_host() {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("supervisor.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let soul = SoulId::parse("managed-codex-soul").unwrap();
    let (broadcast, mut receiver) = broadcast::channel(16);
    let proxy = Arc::new(HostedFreshAgentProxy {
        client: RuntimeClient::new(&socket, "0123456789abcdef"),
        broadcast: Arc::new(broadcast),
        aliases: Mutex::new(HashMap::from([(("codex".into(), "thread-1".into()), soul)])),
        presentation_ids: Mutex::new(HashMap::new()),
        pollers: Mutex::new(HashSet::new()),
        fixture_modes: HashSet::new(),
        naming: OnceLock::new(),
    });

    proxy
        .handle(HostedFreshAgentCommand::RecoveryStop(
            FreshAgentRecoveryStop {
                request_id: "stop-123".into(),
                provider: AgentProvider::Codex,
                session_id: "thread-1".into(),
                session_type: SessionType::Freshcodex,
                observed_epoch: None,
                observed_generation: None,
            },
        ))
        .await;

    let frame = receiver.try_recv().unwrap();
    let ServerMessage::FreshAgentRecoveryStopped(stopped) = serde_json::from_str(&frame).unwrap()
    else {
        panic!("expected recovery refusal")
    };
    assert_eq!(stopped.request_id, "stop-123");
    assert_eq!(stopped.code.as_deref(), Some("UNSUPPORTED_CAPABILITY"));
    assert!(!stopped.success);
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err(),
        "recovery refusal must not contact the host"
    );
}

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
fn rest_and_hosted_create_use_the_same_kilroy_presentation_identity() {
    let (public_provider, session_type) = rest_agent_identity("claude", "kilroy").unwrap();
    let runtime_provider = fresh_provider(&Some(public_provider), session_type).unwrap();
    let request_id = "kilroy-rest-request";
    let expected = format!("managed-kilroy-{}", stable_hex(request_id));
    assert_eq!(
        presentation_id_for_create(&runtime_provider, request_id, None),
        expected
    );
    assert_eq!(
        presentation_id_for_create(&runtime_provider, request_id, Some("native-42")),
        "native-42"
    );
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
        naming: std::sync::OnceLock::new(),
    });
    Arc::clone(&proxy)
        .handle(HostedFreshAgentCommand::Fork(FreshAgentFork {
            observed_epoch: None,
            observed_generation: None,
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
            ("rest", false),
        ] {
            let snapshot = serde_json::json!({
                "type": snapshot_type,
                "provider": provider,
                "sessionType": session_type,
                "sessionId": "native-session",
                "threadId": "native-session",
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
            if snapshot_type == "rest" {
                payload.as_object_mut().unwrap().remove("type");
                freshell_agent_runtime::snapshot_projection::project_hosted_rest_snapshot(
                    &mut payload,
                    provider,
                    session_type,
                );
            } else {
                freshell_agent_runtime::snapshot_projection::project_hosted_snapshot(
                    &mut payload,
                    provider,
                    session_type,
                );
            }
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
            assert_eq!(projected["threadId"], "native-session");
            assert_eq!(
                projected["sessionId"],
                if snapshot_type == "rest" {
                    "native-session"
                } else {
                    "public-session"
                }
            );
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

#[tokio::test]
async fn rollback_commands_keep_direction_target_and_request_fences() {
    for direction in [
        FreshAgentRollbackDirection::Undo,
        FreshAgentRollbackDirection::Redo,
    ] {
        let root = tempfile::tempdir().unwrap();
        let socket = root.path().join("rollback.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let soul = SoulId::new();
        let expected_soul = soul.clone();
        let server = tokio::spawn(async move {
            for index in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let request: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
                let result = match request.body {
                    AdminCommand::Health if index == 0 => AdminResult::Health {
                        control_epoch: 77,
                        installation_id: InstallationId::new(),
                    },
                    AdminCommand::FreshAgentRollback(rollback) if index == 1 => {
                        assert_eq!(request.request_id.as_str(), "rollback-ui-request");
                        assert_eq!(rollback.soul_id, expected_soul);
                        assert_eq!(rollback.direction, direction);
                        assert_eq!(rollback.mode, FreshAgentRollbackMode::ToTurn);
                        assert_eq!(rollback.turn_id.as_deref(), Some("turn-selected"));
                        assert_eq!(rollback.cwd.as_deref(), Some("/workspace"));
                        assert_eq!(rollback.expected_control_epoch, Some(77));
                        AdminResult::FreshAgentCommand {
                            state: freshell_runtime_protocol::CommandState::Completed,
                        }
                    }
                    other => panic!("unexpected rollback request {other:?}"),
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
        });
        let (broadcast, _) = broadcast::channel(16);
        let proxy = Arc::new(HostedFreshAgentProxy {
            client: RuntimeClient::new(&socket, "0123456789abcdef"),
            broadcast: Arc::new(broadcast),
            aliases: Mutex::new(HashMap::from([(
                ("codex".into(), "public-thread".into()),
                soul,
            )])),
            presentation_ids: Mutex::new(HashMap::new()),
            pollers: Mutex::new(HashSet::new()),
            fixture_modes: HashSet::new(),
            naming: OnceLock::new(),
        });
        let message = serde_json::json!({"provider":"codex","sessionId":"public-thread","sessionType":"freshcodex",
            "requestId":"rollback-ui-request","mode":"toTurn","turnId":"turn-selected","cwd":"/workspace"});
        let command = match direction {
            FreshAgentRollbackDirection::Undo => {
                HostedFreshAgentCommand::Undo(serde_json::from_value(message).unwrap())
            }
            FreshAgentRollbackDirection::Redo => {
                HostedFreshAgentCommand::Redo(serde_json::from_value(message).unwrap())
            }
        };
        proxy.handle(command).await;
        server.await.unwrap();
    }
}

static SNAPSHOT_OUTAGE_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct SnapshotTestEnv(Vec<(&'static str, Option<std::ffi::OsString>)>);
impl SnapshotTestEnv {
    fn isolate(root: &Path) -> Self {
        let keys = [
            "HOME",
            "CODEX_HOME",
            "CLAUDE_CONFIG_DIR",
            "CLAUDE_HOME",
            "XDG_DATA_HOME",
            "CODEX_CMD",
            "FAKE_CODEX_APP_SERVER_BEHAVIOR",
            "FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES",
        ];
        let saved = Self(
            keys.iter()
                .map(|key| (*key, std::env::var_os(key)))
                .collect(),
        );
        std::env::set_var("HOME", root.join("empty-home"));
        std::env::set_var("CODEX_HOME", root.join("configured-codex"));
        std::env::set_var("CLAUDE_CONFIG_DIR", root.join("configured-claude"));
        std::env::remove_var("CLAUDE_HOME");
        std::env::set_var("XDG_DATA_HOME", root.join("configured-xdg"));
        std::env::set_var("CODEX_CMD", "/never-start-a-provider-for-saved-history");
        saved
    }
}
impl Drop for SnapshotTestEnv {
    fn drop(&mut self) {
        for (key, value) in &self.0 {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }
}

fn snapshot_outage_proxy(socket: &Path) -> Arc<HostedFreshAgentProxy> {
    Arc::new(HostedFreshAgentProxy {
        client: RuntimeClient::new(socket, "0123456789abcdef"),
        broadcast: Arc::new(broadcast::channel(16).0),
        aliases: Mutex::new(HashMap::new()),
        presentation_ids: Mutex::new(HashMap::new()),
        pollers: Mutex::new(HashSet::new()),
        fixture_modes: HashSet::new(),
        naming: OnceLock::new(),
    })
}

async fn snapshot_route_value(
    app: &axum::Router,
    session_type: &str,
    provider: &str,
    native: &str,
) -> (axum::http::StatusCode, serde_json::Value) {
    use tower::ServiceExt;
    let reply = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .uri(format!(
                    "/api/fresh-agent/threads/{session_type}/{provider}/{native}"
                ))
                .header("x-auth-token", "tok")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = reply.status();
    let bytes = axum::body::to_bytes(reply.into_body(), 32 * 1024 * 1024)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn real_gateway_pre_native_opencode_projects_only_current_empty_owned_registration() {
    use freshell_freshagent::hosted_rest::HostedRestSnapshot;
    for scenario in [
        "empty",
        "nonempty",
        "wrong-provider",
        "materialized",
        "owner-changed",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("owned.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let mut server = tokio::spawn(async move {
            let mut inventories = 0;
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let request: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
                let result = match request.body {
                    AdminCommand::Health => AdminResult::Health {
                        control_epoch: 7,
                        installation_id: InstallationId::new(),
                    },
                    AdminCommand::Inventory => {
                        inventories += 1;
                        AdminResult::Inventory(vec![serde_json::from_value(serde_json::json!({
                            "soulId":"owned-soul", "incarnationId":if scenario == "owner-changed" && inventories == 2 {"new-owner"} else {"owned-owner"},
                            "launchState":"running", "cleanupState":"none", "intentRevision":1, "executionGeneration":1,
                            "desiredState":"running", "recoveryState":"live", "durabilityState":"unknown", "allocationState":"allocated",
                            "evidenceRevision":0, "successfulRecoveriesInWindow":0, "provider":"opencode", "freshAgentSessionId":"managed-opencode-public",
                            "nativeSessionId":if scenario == "materialized" && inventories == 2 {Some("ses_new")} else {None}
                        })).unwrap()])
                    }
                    AdminCommand::FreshAgentReadSnapshot(read) => {
                        assert_eq!(read.soul_id.as_str(), "owned-soul");
                        AdminResult::FreshAgentSnapshot(
                            serde_json::json!({"threadId":"freshopencode-host-registered", "provider":if scenario == "wrong-provider" {"codex"} else {"opencode"},
                            "sessionType":"freshopencode", "status":"idle", "turns":if scenario == "nonempty" {serde_json::json!([{"turnId":"native"}])} else {serde_json::json!([])},
                            "capabilities":{"send":true,"interrupt":false,"approvals":false,"questions":false,"fork":false}, "extensions":{"opencode":{"statusFromLiveState":true}}}),
                        )
                    }
                    other => panic!("unexpected zero-turn read {other:?}"),
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
                if inventories == 2 {
                    break;
                }
            }
        });
        let proxy = snapshot_outage_proxy(&socket);
        let result = proxy
            .snapshot(HostedRestSnapshot {
                session_id: "managed-opencode-public".into(),
                provider: "opencode".into(),
                session_type: "freshopencode".into(),
            })
            .await;
        let joined = tokio::time::timeout(Duration::from_secs(1), &mut server).await;
        if joined.is_err() {
            server.abort();
            let _ = server.await;
        }
        joined
            .expect("owned socket fixture must finish")
            .expect("owned socket fixture protocol must succeed");
        assert_eq!(result.is_ok(), scenario == "empty", "{scenario}");
        if let Ok(Some(snapshot)) = result {
            assert_eq!(snapshot["threadId"], "managed-opencode-public");
            assert_eq!(snapshot["capabilities"]["send"], true);
        }
    }
}

#[tokio::test]
async fn real_gateway_managed_snapshot_failure_reads_owned_history_and_refuses_wrong_local_store() {
    let _lock = SNAPSHOT_OUTAGE_ENV_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let _env = SnapshotTestEnv::isolate(dir.path());
    let local_path = dir
        .path()
        .join("configured-codex/sessions/rollout-session-activity.jsonl");
    std::fs::create_dir_all(local_path.parent().unwrap()).unwrap();
    std::fs::write(
        &local_path,
        include_str!("../../../test/fixtures/coding-cli/codex/task-events.sanitized.jsonl"),
    )
    .unwrap();
    let local_opencode_path = dir.path().join("configured-xdg/opencode/opencode.db");
    std::fs::create_dir_all(local_opencode_path.parent().unwrap()).unwrap();
    let db = rusqlite::Connection::open(&local_opencode_path).unwrap();
    db.execute_batch("CREATE TABLE session(id TEXT PRIMARY KEY,title TEXT,time_updated INTEGER); CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE part(id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT); INSERT INTO session VALUES('ses_owned','Wrong local',2);").unwrap();
    db.execute("INSERT INTO message VALUES('wrong-message','ses_owned',1,?1)", [serde_json::json!({"id":"wrong-message","role":"assistant","time":{"created":1,"completed":2}}).to_string()]).unwrap();
    db.execute("INSERT INTO part VALUES('wrong-part','ses_owned','wrong-message',1,?1)", [serde_json::json!({"id":"wrong-part","type":"text","text":"Wrong local OpenCode source"}).to_string()]).unwrap();
    drop(db);
    let local_before = std::fs::read(&local_path).unwrap();
    let opencode_before = std::fs::read(&local_opencode_path).unwrap();
    for (provider, session_type, native, history_available) in [
        ("codex", "freshcodex", "session-activity", true),
        ("codex", "freshcodex", "session-activity", false),
        ("opencode", "freshopencode", "ses_owned", true),
        ("opencode", "freshopencode", "ses_owned", false),
    ] {
        let socket = dir
            .path()
            .join(format!("owned-{provider}-{history_available}.sock"));
        let listener = UnixListener::bind(&socket).unwrap();
        let mut server = tokio::spawn(async move {
            let mut read_history = false;
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let request: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
                let mut done = false;
                let result = match request.body {
                    AdminCommand::Health => Ok(AdminResult::Health {
                        control_epoch: 7,
                        installation_id: InstallationId::new(),
                    }),
                    AdminCommand::Inventory => {
                        done = read_history;
                        Ok(AdminResult::Inventory(vec![serde_json::from_value(serde_json::json!({
                        "soulId":"owned-soul", "incarnationId":"owned-incarnation", "launchState":"running", "cleanupState":"none",
                        "intentRevision":1, "executionGeneration":1, "desiredState":"running", "recoveryState":"live",
                        "durabilityState":"unknown", "allocationState":"allocated", "evidenceRevision":0, "successfulRecoveriesInWindow":0,
                        "provider":provider, "nativeSessionId":native, "freshAgentSessionId":"managed-public",
                        "freshAgentSessionType":session_type
                    })).unwrap()]))
                    }
                    AdminCommand::FreshAgentReadSnapshot(read) => {
                        assert_eq!(read.soul_id.as_str(), "owned-soul");
                        Err(freshell_runtime_protocol::RuntimeError::new(
                            RuntimeErrorCode::HostUnreachable,
                            "hosted fresh-agent command failed",
                        ))
                    }
                    AdminCommand::FreshAgentReadHistory(read) => {
                        assert_eq!(read.soul_id.as_str(), "owned-soul");
                        read_history = true;
                        done = !history_available;
                        if history_available {
                            Ok(AdminResult::FreshAgentHistory(serde_json::json!({
                                "threadId":native, "provider":provider, "sessionType":session_type, "status":"idle",
                                "turns":[{"turnId":"owned-volume-answer"}], "capabilities":{"send":false},
                                "extensions":{(provider):{"ownerKind":"vacant", "nativeHistoryAvailable":true}}
                            })))
                        } else {
                            Err(freshell_runtime_protocol::RuntimeError::new(
                                RuntimeErrorCode::HostUnreachable,
                                "owned history unavailable",
                            ))
                        }
                    }
                    other => panic!("unexpected read {other:?}"),
                };
                write_frame(
                    &mut stream,
                    &AdminReply {
                        request_id: request.request_id,
                        result,
                    },
                )
                .await
                .unwrap();
                if done {
                    break;
                }
            }
        });
        let (broadcast, _) = broadcast::channel(16);
        let broadcast = Arc::new(broadcast);
        let owner =
            freshell_freshagent::FreshAgentState::new(Arc::new("tok".into()), broadcast.clone());
        owner
            .set_hosted_rest_gateway(snapshot_outage_proxy(&socket))
            .unwrap();
        let app = freshell_freshagent::snapshot::router(
            freshell_freshagent::snapshot::SnapshotState::new(
                Arc::new("tok".into()),
                freshell_freshagent::FreshCodexState::new(
                    Arc::new("tok".into()),
                    broadcast.clone(),
                    serde_json::json!({}),
                ),
                owner,
                freshell_freshagent::FreshClaudeState::new(broadcast),
            ),
        );
        let (status, value) = snapshot_route_value(&app, session_type, provider, native).await;
        // Join only the owned fixture; old behavior never requests history.
        let joined = tokio::time::timeout(Duration::from_millis(500), &mut server).await;
        if joined.is_err() {
            server.abort();
            let _ = server.await;
        }
        joined
            .expect("gateway must request history from the same owned soul")
            .expect("owned history fixture protocol must succeed");
        assert_eq!(
            status,
            if history_available {
                axum::http::StatusCode::OK
            } else {
                axum::http::StatusCode::SERVICE_UNAVAILABLE
            }
        );
        if history_available {
            assert_eq!(value["turns"][0]["turnId"], "owned-volume-answer");
            assert_eq!(value["threadId"], native);
            assert_eq!(value["provider"], provider);
            assert_eq!(value["sessionType"], session_type);
            assert_eq!(value["extensions"][provider]["ownerKind"], "vacant");
            assert_eq!(
                value["extensions"][provider]["nativeHistoryAvailable"],
                true
            );
            assert_eq!(value["extensions"][provider]["statusFromLiveState"], false);
            assert_eq!(value["capabilities"]["send"], false);
            assert!(!value.to_string().contains("Wrong local OpenCode source"));
        }
    }
    assert_eq!(std::fs::read(&local_path).unwrap(), local_before);
    assert_eq!(
        std::fs::read(&local_opencode_path).unwrap(),
        opencode_before
    );
    let proxy = snapshot_outage_proxy(&dir.path().join("absent-supervisor.sock"));
    proxy.aliases.lock().await.insert(
        ("codex".into(), "session-activity".into()),
        SoulId::parse("owned-soul").unwrap(),
    );
    let (broadcast, _) = broadcast::channel(16);
    let broadcast = Arc::new(broadcast);
    let owner =
        freshell_freshagent::FreshAgentState::new(Arc::new("tok".into()), broadcast.clone());
    owner.set_hosted_rest_gateway(proxy).unwrap();
    let app =
        freshell_freshagent::snapshot::router(freshell_freshagent::snapshot::SnapshotState::new(
            Arc::new("tok".into()),
            freshell_freshagent::FreshCodexState::new(
                Arc::new("tok".into()),
                broadcast.clone(),
                serde_json::json!({}),
            ),
            owner,
            freshell_freshagent::FreshClaudeState::new(broadcast),
        ));
    assert_eq!(
        snapshot_route_value(&app, "freshcodex", "codex", "session-activity")
            .await
            .0,
        axum::http::StatusCode::SERVICE_UNAVAILABLE
    );
}

#[tokio::test]
async fn real_gateway_outage_preserves_exact_cold_native_history_without_live_authority() {
    let _lock = SNAPSHOT_OUTAGE_ENV_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let _env = SnapshotTestEnv::isolate(dir.path());
    let socket = dir.path().join("owned-supervisor.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    drop(listener);
    std::fs::remove_file(&socket).unwrap(); // Only this fixture's socket becomes unavailable.
    let codex_path = dir
        .path()
        .join("configured-codex/sessions/rollout-session-activity.jsonl");
    let claude_path = dir
        .path()
        .join("configured-claude/projects/fixture/44444444-4444-4444-8444-444444444444.jsonl");
    let db_path = dir.path().join("configured-xdg/opencode/opencode.db");
    for path in [&codex_path, &claude_path, &db_path] {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    }
    std::fs::write(
        &codex_path,
        include_str!("../../../test/fixtures/coding-cli/codex/task-events.sanitized.jsonl"),
    )
    .unwrap();
    std::fs::write(
        &claude_path,
        include_str!("../../../test/fixtures/managed-native-history/claude.jsonl"),
    )
    .unwrap();
    let db = rusqlite::Connection::open(&db_path).unwrap();
    db.execute_batch("CREATE TABLE session(id TEXT PRIMARY KEY,title TEXT,time_updated INTEGER); CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE part(id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT); INSERT INTO session VALUES('ses_saved','Saved',2);").unwrap();
    db.execute("INSERT INTO message VALUES('message-one','ses_saved',1,?1)", [serde_json::json!({"id":"message-one","role":"assistant","time":{"created":1,"completed":2}}).to_string()]).unwrap();
    db.execute("INSERT INTO part VALUES('part-one','ses_saved','message-one',1,?1)", [serde_json::json!({"id":"part-one","type":"text","text":"Saved native OpenCode answer"}).to_string()]).unwrap();
    drop(db);
    let paths = [&codex_path, &claude_path, &db_path];
    let before: Vec<_> = paths
        .iter()
        .map(|path| {
            (
                std::fs::read(path).unwrap(),
                std::fs::metadata(path).unwrap().modified().unwrap(),
            )
        })
        .collect();
    let broadcast = Arc::new(broadcast::channel(64).0);
    let codex = freshell_freshagent::FreshCodexState::new(
        Arc::new("tok".into()),
        broadcast.clone(),
        serde_json::json!({}),
    );
    let claude = freshell_freshagent::FreshClaudeState::new(broadcast.clone());
    let opencode = freshell_freshagent::FreshAgentState::new(Arc::new("tok".into()), broadcast);
    let proxy = snapshot_outage_proxy(&socket);
    opencode.set_hosted_rest_gateway(proxy.clone()).unwrap();
    let app =
        freshell_freshagent::snapshot::router(freshell_freshagent::snapshot::SnapshotState::new(
            Arc::new("tok".into()),
            codex.clone(),
            opencode,
            claude.clone(),
        ));
    for (kind, provider, native, text) in [
        (
            "freshcodex",
            "codex",
            "session-activity",
            "Sanitized completion",
        ),
        (
            "freshclaude",
            "claude",
            "44444444-4444-4444-8444-444444444444",
            "Saved native Claude answer",
        ),
        (
            "kilroy",
            "claude",
            "44444444-4444-4444-8444-444444444444",
            "Saved native Claude answer",
        ),
        (
            "freshopencode",
            "opencode",
            "ses_saved",
            "Saved native OpenCode answer",
        ),
    ] {
        let (status, value) = snapshot_route_value(&app, kind, provider, native).await;
        assert_eq!(status, axum::http::StatusCode::OK, "{kind}: {value}");
        assert_eq!(value["threadId"], native);
        assert_eq!(value["sessionType"], kind);
        assert_eq!(value["provider"], provider);
        assert!(
            value["turns"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|turn| turn["items"].as_array().unwrap())
                .any(|item| item["text"] == text),
            "{kind}: {value}"
        );
        assert_eq!(
            value["extensions"][provider]["nativeHistoryAvailable"],
            true
        );
        assert_ne!(value["extensions"][provider]["statusFromLiveState"], true);
        assert!(value["capabilities"]
            .as_object()
            .unwrap()
            .values()
            .filter(|v| v.is_boolean())
            .all(|v| v == false));
    }
    for (kind, provider, id) in [
        ("freshcodex", "codex", "managed-freshcodex-unresolved"),
        ("freshcodex", "codex", "foreign-session"),
        ("freshclaude", "claude", "missing-native"),
        ("freshopencode", "opencode", "ses_missing"),
    ] {
        assert_eq!(
            snapshot_route_value(&app, kind, provider, id).await.0,
            axum::http::StatusCode::SERVICE_UNAVAILABLE
        );
    }
    // Exact-looking names cannot substitute for a readable, matching native source.
    let wrong_codex = codex_path.with_file_name("rollout-wrong-native.jsonl");
    std::fs::write(&wrong_codex, std::fs::read(&codex_path).unwrap()).unwrap();
    let unreadable_claude =
        claude_path.with_file_name("55555555-5555-4555-8555-555555555555.jsonl");
    std::fs::write(&unreadable_claude, [0xff, 0xfe]).unwrap();
    for (kind, provider, id) in [
        ("freshcodex", "codex", "wrong-native"),
        (
            "freshclaude",
            "claude",
            "55555555-5555-4555-8555-555555555555",
        ),
    ] {
        assert_eq!(
            snapshot_route_value(&app, kind, provider, id).await.0,
            axum::http::StatusCode::SERVICE_UNAVAILABLE
        );
    }
    for (path, (bytes, modified)) in paths.iter().zip(before) {
        assert_eq!(std::fs::read(path).unwrap(), bytes);
        assert_eq!(
            std::fs::metadata(path).unwrap().modified().unwrap(),
            modified
        );
    }
    std::fs::write(&db_path, b"not a SQLite database").unwrap();
    assert_eq!(
        snapshot_route_value(&app, "freshopencode", "opencode", "ses_saved")
            .await
            .0,
        axum::http::StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(std::fs::read(&db_path).unwrap(), b"not a SQLite database");
    assert!(!codex.has_live_session("session-activity").await);
    assert!(
        !claude
            .has_live_session("44444444-4444-4444-8444-444444444444")
            .await
    );
    assert!(proxy.pollers.lock().await.is_empty());
}

#[tokio::test]
async fn real_gateway_outage_keeps_a_registered_local_provider_snapshot_live() {
    let _lock = SNAPSHOT_OUTAGE_ENV_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let _env = SnapshotTestEnv::isolate(dir.path());
    std::env::set_var(
        "CODEX_CMD",
        format!(
            "node {}/../../test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs",
            env!("CARGO_MANIFEST_DIR")
        ),
    );
    std::env::set_var(
        "FAKE_CODEX_APP_SERVER_BEHAVIOR",
        r#"{"threadStartThreadId":"local-owned-thread"}"#,
    );
    std::env::set_var("FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES", "1");
    let (tx, mut rx) = broadcast::channel(64);
    let broadcast = Arc::new(tx);
    let ownership = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    let mut codex = freshell_freshagent::FreshCodexState::new(
        Arc::new("tok".into()),
        broadcast.clone(),
        serde_json::json!({"freshAgent":{"enabled":true}}),
    );
    codex.set_ownership(ownership.clone());
    codex.handle_create(serde_json::from_value(serde_json::json!({"requestId":"local-provider-start","sessionType":"freshcodex","provider":"codex"})).unwrap(), None).await;
    let created: serde_json::Value = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let frame: serde_json::Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
            if frame["type"] == "freshAgent.created" || frame["type"] == "freshAgent.create.failed"
            {
                break frame;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(created["type"], "freshAgent.created", "{created}");
    let native = created["sessionId"].as_str().unwrap();
    let saved_path = dir
        .path()
        .join("configured-codex/sessions")
        .join(format!("rollout-{native}.jsonl"));
    std::fs::create_dir_all(saved_path.parent().unwrap()).unwrap();
    let saved = include_str!("../../../test/fixtures/coding-cli/codex/task-events.sanitized.jsonl")
        .replace("session-activity", native);
    std::fs::write(&saved_path, &saved).unwrap();
    let before = ownership.observe("codex", native);
    let socket = dir.path().join("owned-supervisor.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    drop(listener);
    std::fs::remove_file(&socket).unwrap();
    let opencode =
        freshell_freshagent::FreshAgentState::new(Arc::new("tok".into()), broadcast.clone());
    opencode
        .set_hosted_rest_gateway(snapshot_outage_proxy(&socket))
        .unwrap();
    let app =
        freshell_freshagent::snapshot::router(freshell_freshagent::snapshot::SnapshotState::new(
            Arc::new("tok".into()),
            codex.clone(),
            opencode,
            freshell_freshagent::FreshClaudeState::new(broadcast),
        ));
    let (status, value) = snapshot_route_value(&app, "freshcodex", "codex", native).await;
    let after = ownership.observe("codex", native);
    // Park the real read after its local runtime capture, then change ownership.
    let reached = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    codex.set_snapshot_pause_after_capture_for_tests(Arc::new({
        let reached = reached.clone();
        let release = release.clone();
        move |_| {
            let reached = reached.clone();
            let release = release.clone();
            Box::pin(async move {
                reached.notify_one();
                release.notified().await;
            })
        }
    }));
    let held = tokio::spawn({
        let app = app.clone();
        let native = native.to_owned();
        async move { snapshot_route_value(&app, "freshcodex", "codex", &native).await }
    });
    tokio::time::timeout(Duration::from_secs(10), reached.notified())
        .await
        .unwrap();
    let freshell_ownership::BeginOutcome::Granted { generation } = ownership.begin_handoff(
        "codex",
        native,
        freshell_ownership::RuntimeOwnerKind::Terminal,
        "snapshot-outage-handoff",
        None,
        "test",
        freshell_ownership::now_epoch_ms(),
    ) else {
        panic!("expected owned handoff")
    };
    release.notify_one();
    let (held_status, held_value) = tokio::time::timeout(Duration::from_secs(10), held)
        .await
        .unwrap()
        .unwrap();
    codex.clear_snapshot_pause_after_capture_for_tests();
    // The captured runtime is still registered but its retained generation is stale.
    ownership.fail(
        "codex",
        native,
        "snapshot-outage-handoff",
        generation,
        false,
    );
    let (stale_status, stale_value) =
        snapshot_route_value(&app, "freshcodex", "codex", native).await;
    // Always join teardown of the one provider this fixture created, including RED.
    codex.handle_kill(serde_json::from_value(serde_json::json!({"sessionId":native,"sessionType":"freshcodex","provider":"codex"})).unwrap()).await;
    assert!(!codex.has_live_session(native).await);
    assert_eq!(std::fs::read_to_string(&saved_path).unwrap(), saved);
    assert_eq!(status, axum::http::StatusCode::OK, "{value}");
    assert_eq!(before, after);
    assert_eq!(value["threadId"], native);
    assert_eq!(value["capabilities"]["send"], true);
    assert_ne!(value["extensions"]["codex"]["nativeHistoryAvailable"], true);
    assert!(
        value["turns"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|turn| turn["items"].as_array().unwrap())
            .any(|item| item["text"] == "Fixture turn"),
        "{value}"
    );
    // A provider's typed handoff refusal stays authoritative even when saved history exists.
    assert_eq!(
        held_status,
        axum::http::StatusCode::CONFLICT,
        "{held_value}"
    );
    assert_eq!(held_value["code"], "RESTORE_UNAVAILABLE");
    assert_eq!(held_value["ownerGeneration"], generation);
    assert!(held_value.get("ownerKind").is_none());
    assert!(held_value.get("turns").is_none());
    assert!(held_value.get("capabilities").is_none());
    // An unconfirmed runtime without a provider refusal still reads only saved history.
    assert_eq!(stale_status, axum::http::StatusCode::OK, "{stale_value}");
    assert_eq!(stale_value["threadId"], native);
    assert_eq!(
        stale_value["extensions"]["codex"]["nativeHistoryAvailable"],
        true
    );
    assert_ne!(
        stale_value["extensions"]["codex"]["statusFromLiveState"],
        true
    );
    assert_eq!(stale_value["capabilities"]["send"], false);
}

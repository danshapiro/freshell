use super::*;
use freshell_protocol::FreshAgentFork;
use freshell_runtime_protocol::{
    read_frame, write_frame, AdminCommand, AdminReply, AdminResult, ControlRole, Envelope,
    FreshAgentForkResult, InstallationId,
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
    assert_eq!(payload["event"]["sessionId"], "native-parent");
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
            .resolve_soul(&AgentProvider::Codex, "native-child")
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

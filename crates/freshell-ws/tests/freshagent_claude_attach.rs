//! WS-level proof for restart-resilience P0.2 slice 1: the real dispatch
//! (`terminal.rs`'s `ClientMessage::FreshAgentAttach` arm) must route a claude/kilroy
//! `freshAgent.attach` to `FreshClaudeState::handle_attach` instead of swallowing it
//! via `_ => {}`. Unit-level coverage exists in `claude.rs::tests`, but -- exactly like
//! the kill/interrupt dispatch gap before it (`freshagent_claude_kill_interrupt.rs`) --
//! it is unreachable from the wire until the dispatch arm exists. Harness duplicated
//! from that file per the repo's per-test-file convention.

mod common;

use common::claude_sim_environment::ClaudeSimEnvironment;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_ws::WsState;

const AUTH_TOKEN: &str = "s3cr3t-token-abcdef";

// ── server harness (duplicated from diag01_lifecycle_events.rs's convention, with
//    `freshAgent.enabled: true` so `freshAgent.create` actually dispatches) ──

fn test_settings_value() -> serde_json::Value {
    serde_json::json!({
        "ai": {},
        "codingCli": { "enabledProviders": [], "mcpServer": true, "providers": {} },
        "editor": { "externalEditor": "auto" },
        "extensions": { "disabled": [] },
        "freshAgent": { "defaultPlugins": [], "enabled": true, "providers": {} },
        "logging": { "debug": false },
        "network": { "configured": true, "host": "127.0.0.1" },
        "panes": { "defaultNewPane": "ask" },
        "safety": { "autoKillIdleMinutes": 15 },
        "sidebar": {
            "autoGenerateTitles": true,
            "excludeFirstChatMustStart": false,
            "excludeFirstChatSubstrings": []
        },
        "terminal": { "scrollback": 10000 }
    })
}

async fn spawn_server(environment: &ClaudeSimEnvironment) -> String {
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings =
        Arc::new(serde_json::from_value(test_settings_value()).expect("valid settings fixture"));

    let state = WsState {
        layout: Default::default(),
        terminal_meta: Default::default(),
        pane_ledger: std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::disabled()),
        identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
        auth_token: Arc::clone(&auth_token),
        server_instance_id: Arc::new("srv-test".to_string()),
        boot_id: Arc::new("boot-test".to_string()),
        settings,
        handshake_settings: Arc::new(tokio::sync::RwLock::new(
            serde_json::from_value(test_settings_value()).expect("valid settings fixture"),
        )),
        broadcast_tx: Arc::clone(&broadcast_tx),
        auto_resume_tx: tokio::sync::mpsc::unbounded_channel().0,
        auto_resume_cancels: Default::default(),
        fresh_codex: freshell_freshagent::FreshCodexState::new(
            Arc::clone(&auth_token),
            Arc::clone(&broadcast_tx),
            serde_json::json!({ "freshAgent": { "enabled": true } }),
        ),
        fresh_claude: freshell_freshagent::FreshClaudeState::new(Arc::clone(&broadcast_tx))
            .with_sidecar_environment(environment.environment()),
        fresh_opencode: freshell_freshagent::FreshOpencodeState::new(
            freshell_freshagent::FreshAgentState::new(
                Arc::clone(&auth_token),
                Arc::clone(&broadcast_tx),
            ),
        ),
        registry: freshell_terminal::TerminalRegistry::new(),
        tabs: freshell_ws::tabs::TabsRegistry::new(),
        screenshots: freshell_ws::screenshot::ScreenshotBroker::new(Arc::clone(&broadcast_tx)),
        subagent_interest: Default::default(),
        host_stats: Default::default(),
        checkpoint_send: Default::default(),
        terminals_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        sessions_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        cli_commands: Arc::new(Vec::new()),
        shutdown: Arc::new(tokio::sync::Notify::new()),
        ping_interval_ms: 30_000,
        hello_timeout_ms: 5_000,
        allowed_origins: Arc::new(freshell_ws::origin::default_allowed_origins()),
        ws_max_payload_bytes: 16 * 1024 * 1024,
        term09: freshell_ws::backpressure::Term09Config::default(),
        create_protect: freshell_ws::create_limit::CreateProtectConfig::default(),
        spawn_gate: std::sync::Arc::new(freshell_ws::spawn_gate::SpawnGate::new(4, 64)),
        shutdown_started: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        create_dedupe: std::sync::Arc::new(freshell_ws::create_dedupe::CreateDedupe::default()),
        config_fallback: None,
        opencode_locator: None,
        codex_locator: None,
        activity: None,
        session_existence: std::sync::Arc::new(freshell_ws::existence::NoIndexProbe::default()),
        reconcile_deferral_budget_ms: freshell_ws::reconcile::RECONCILE_DEFERRAL_BUDGET_MS_DEFAULT,
        fresh_agent_respawn_counts: Default::default(),
        ownership: None,
    };

    let router = freshell_ws::router(state);
    // Ephemeral loopback port only -- NEVER the self-hosted 3001/3002 ports.
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    format!("ws://{addr}/ws")
}

type TestWs =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect_and_complete_handshake(url: &str) -> TestWs {
    let (mut ws, _resp) = tokio_tungstenite::connect_async(url)
        .await
        .expect("ws connect");
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "hello",
            "token": AUTH_TOKEN,
            "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
        })
        .to_string(),
    ))
    .await
    .expect("send hello");

    // Drain the handshake frames (ready + whatever else precedes it) until `ready`.
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("handshake message within timeout")
            .expect("stream not ended")
            .expect("no ws error");
        let WsMessage::Text(text) = msg else {
            continue;
        };
        let value: Value = serde_json::from_str(&text).unwrap();
        if value["type"] == "ready" {
            break;
        }
    }
    ws
}

async fn send_json(ws: &mut TestWs, value: &Value) {
    ws.send(WsMessage::Text(value.to_string()))
        .await
        .expect("send frame");
}

/// Drain frames until one matching `predicate` arrives (or the budget expires).
async fn await_frame(
    ws: &mut TestWs,
    budget: Duration,
    predicate: impl Fn(&Value) -> bool,
) -> Value {
    tokio::time::timeout(budget, async {
        loop {
            let msg = ws
                .next()
                .await
                .expect("stream not ended")
                .expect("no ws error");
            let WsMessage::Text(text) = msg else {
                continue;
            };
            let value: Value = serde_json::from_str(&text).unwrap();
            if predicate(&value) {
                return value;
            }
        }
    })
    .await
    .expect("expected frame did not arrive within budget")
}

/// A claude `freshAgent.attach` for a session id this server process does not track
/// (the always-true case right after a server restart) must produce the
/// `freshAgent.error{code:'INVALID_SESSION_ID'}` lost-session frame on the wire --
/// the frame the frozen client folds into `markSessionLost` -> `triggerRecovery`.
/// Before the fix the dispatch swallowed the message and NO frame ever arrived
/// (this test then fails with `await_frame` panicking on its timeout budget).
#[tokio::test]
async fn claude_attach_for_untracked_session_emits_lost_session_frame_over_ws() {
    let env = ClaudeSimEnvironment::new();
    let url = spawn_server(&env).await;
    let mut ws = connect_and_complete_handshake(&url).await;

    send_json(
        &mut ws,
        &serde_json::json!({
            "type": "freshAgent.attach",
            "provider": "claude",
            "sessionId": "restarted-away",
            "sessionType": "freshclaude",
        }),
    )
    .await;

    let frame = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "freshAgent.event" && v["sessionId"] == "restarted-away"
    })
    .await;

    assert_eq!(frame["provider"], "claude");
    assert_eq!(frame["sessionType"], "freshclaude");
    assert_eq!(frame["event"]["type"], "freshAgent.error");
    assert_eq!(frame["event"]["code"], "INVALID_SESSION_ID");
}

/// Restart parity (Task 6): an attach for an untracked session that DOES carry a
/// durable claude UUID with a resumable transcript must be resumed in place -- the
/// server spawns a sidecar with a resume boot and emits the idle
/// `freshAgent.session.snapshot` whose `timelineSessionId` is the durable UUID (the
/// frozen client persists it unvalidated -- NEVER a nanoid), all under the CLIENT's
/// canonical native session id. Before the fix this attach produced the lost frame instead
/// (this test then fails with `await_frame` panicking on its timeout budget).
#[tokio::test]
async fn claude_attach_with_resumable_transcript_resumes_and_emits_snapshot_over_ws() {
    let durable = "abababab-abab-4bab-8bab-abababababab";
    let env = ClaudeSimEnvironment::new();
    env.seed_transcript(durable);

    let url = spawn_server(&env).await;
    let mut ws = connect_and_complete_handshake(&url).await;

    send_json(
        &mut ws,
        &serde_json::json!({
            "type": "freshAgent.attach",
            "provider": "claude",
            "sessionId": "gone-after-restart",
            "sessionType": "freshclaude",
            "sessionRef": { "provider": "claude", "sessionId": durable },
        }),
    )
    .await;

    let frame = await_frame(&mut ws, Duration::from_secs(15), |v| {
        v["type"] == "freshAgent.event" && v["event"]["type"] == "freshAgent.session.snapshot"
    })
    .await;

    assert_eq!(frame["sessionId"], durable);
    assert_eq!(frame["sessionType"], "freshclaude");
    assert_eq!(frame["event"]["status"], "idle");
    assert_eq!(frame["event"]["timelineSessionId"], durable);
    assert_eq!(env.rows("query").len(), 1);
    assert_eq!(env.rows("query")[0]["options"]["resume"], durable);
    assert_eq!(env.rows("boot")[0]["sessionId"], durable);
}

/// G28: an attach by durable UUID while the transcript store cannot be READ
/// (the projects path cannot be traversed) must not be adjudicated "lost". The server cannot
/// prove the transcript gone, so it answers the transient
/// `CLAUDE_ATTACH_RESUME_FAILED` error -- never the `INVALID_SESSION_ID` frame
/// the client folds into `markSessionLost` and starts a recovery for -- and it
/// spawns no sidecar against an unchecked store.
#[cfg(unix)]
#[tokio::test]
async fn claude_attach_with_an_unreadable_store_is_transient_not_lost() {
    let durable = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
    let env = ClaudeSimEnvironment::new();
    std::fs::create_dir_all(env.config_dir()).unwrap();
    // A loop produces a real traversal error even when the sandbox user may
    // bypass Unix permission bits. Missing/non-directory paths are clean misses.
    std::os::unix::fs::symlink("projects", env.config_dir().join("projects")).unwrap();

    let url = spawn_server(&env).await;
    let mut ws = connect_and_complete_handshake(&url).await;

    send_json(
        &mut ws,
        &serde_json::json!({
            "type": "freshAgent.attach",
            "provider": "claude",
            "sessionId": "pane-with-unreadable-store",
            "sessionType": "freshclaude",
            "sessionRef": { "provider": "claude", "sessionId": durable },
        }),
    )
    .await;

    // A transient failure stays scoped to this pane and is distinct from
    // the permanent INVALID_SESSION_ID lost-session response.
    let frame = await_frame(&mut ws, Duration::from_secs(15), |v| {
        (v["type"] == "freshAgent.event" && v["sessionId"] == "pane-with-unreadable-store")
            || v["type"] == "error"
    })
    .await;
    assert_eq!(
        frame["event"]["type"], "freshAgent.error",
        "an unreadable store must not mark the session lost: {frame}"
    );
    assert!(
        frame["event"]["code"] == "CLAUDE_ATTACH_RESUME_FAILED",
        "the attach answers with the transient resume failure: {frame}"
    );

    let creates = env.rows("query").len();
    assert_eq!(
        creates, 0,
        "no sidecar may spawn against an unchecked store"
    );
}

/// Kilroy panes ride the same claude provider arm with `sessionType: "kilroy"`; the
/// envelope must echo it (through the real serde parse of `ClientMessage`, which the
/// unit tests bypass) or the client builds the wrong session locator.
#[tokio::test]
async fn kilroy_attach_for_untracked_session_emits_lost_session_frame_over_ws() {
    let env = ClaudeSimEnvironment::new();
    let url = spawn_server(&env).await;
    let mut ws = connect_and_complete_handshake(&url).await;

    send_json(
        &mut ws,
        &serde_json::json!({
            "type": "freshAgent.attach",
            "provider": "claude",
            "sessionId": "kilroy-was-here",
            "sessionType": "kilroy",
        }),
    )
    .await;

    let frame = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "freshAgent.event" && v["sessionId"] == "kilroy-was-here"
    })
    .await;

    assert_eq!(frame["provider"], "claude");
    assert_eq!(frame["sessionType"], "kilroy");
    assert_eq!(frame["event"]["code"], "INVALID_SESSION_ID");
}

// Native session identity is established at create, before the CLI's first init.
// Attach, send and events must all keep addressing that same conversation.

async fn create_live_claude_session(
    ws: &mut TestWs,
    env: &ClaudeSimEnvironment,
    request_id: &str,
) -> String {
    send_json(
        ws,
        &serde_json::json!({
            "type": "freshAgent.create",
            "requestId": request_id,
            "sessionType": "freshclaude",
            "provider": "claude",
            "cwd": env.workspace(),
        }),
    )
    .await;
    let created = await_frame(ws, Duration::from_secs(15), |v| {
        v["type"] == "freshAgent.created" && v["requestId"] == request_id
    })
    .await;
    let native_id = created["sessionId"]
        .as_str()
        .expect("created carries sessionId")
        .to_string();
    assert!(uuid::Uuid::parse_str(&native_id).is_ok(), "{created}");
    assert_eq!(created["sessionRef"]["sessionId"], native_id);
    assert_eq!(env.rows("boot")[0]["sessionId"], native_id);
    native_id
}

/// A warm attach acknowledges the same native conversation without a second query.
#[tokio::test]
async fn attach_by_native_id_on_a_live_session_acks() {
    let env = ClaudeSimEnvironment::new();

    let url = spawn_server(&env).await;
    let mut ws = connect_and_complete_handshake(&url).await;
    let native_id = create_live_claude_session(&mut ws, &env, "req-10b-attach").await;

    let mut ws2 = connect_and_complete_handshake(&url).await;
    send_json(
        &mut ws2,
        &serde_json::json!({
            "type": "freshAgent.attach",
            "provider": "claude",
            "sessionId": native_id,
            "sessionType": "freshclaude",
            "sessionRef": { "provider": "claude", "sessionId": native_id },
        }),
    )
    .await;

    let frame = await_frame(&mut ws2, Duration::from_secs(10), |v| {
        v["sessionId"] == native_id && v["event"]["type"] == "freshAgent.session.snapshot"
    })
    .await;
    assert_eq!(frame["type"], "freshAgent.event");

    // No second sidecar: exactly one actual SDK query.
    let creates = env.rows("query").len();
    assert_eq!(creates, 1, "attach-to-live must not spawn a second sidecar");
}

/// A send addressed by the native ID reaches the already live SDK query exactly once.
#[tokio::test]
async fn send_by_native_id_routes_to_the_live_session() {
    let env = ClaudeSimEnvironment::new();

    let url = spawn_server(&env).await;
    let mut ws = connect_and_complete_handshake(&url).await;
    let native_id = create_live_claude_session(&mut ws, &env, "req-10b-send").await;

    send_json(
        &mut ws,
        &serde_json::json!({
            "type": "freshAgent.send",
            "provider": "claude",
            "sessionId": native_id,
            "sessionType": "freshclaude",
            "text": "ping",
            "requestId": "send-10b",
        }),
    )
    .await;

    let accepted = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "freshAgent.send.accepted" && v["requestId"] == "send-10b"
    })
    .await;
    assert_eq!(accepted["sessionId"], native_id);

    // An actual SDK assistant frame proves the sidecar processed the routed send.
    await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "freshAgent.event" && v["event"]["type"] == "freshAgent.assistant"
    })
    .await;

    let prompts = env.rows("prompt");
    assert_eq!(
        prompts.len(),
        1,
        "the SDK must receive exactly one routed send"
    );
    assert_eq!(prompts[0]["sessionId"], native_id);
    assert_eq!(prompts[0]["uuid"], accepted["submittedTurnId"]);
    assert_eq!(
        prompts[0]["content"],
        serde_json::json!([{"type":"text", "text":"ping"}])
    );
}

/// Event envelopes after a warm attach retain the same native session identity.
#[tokio::test]
async fn events_after_native_attach_are_stamped_with_the_native_id() {
    let env = ClaudeSimEnvironment::new();

    let url = spawn_server(&env).await;
    let mut ws = connect_and_complete_handshake(&url).await;
    let native_id = create_live_claude_session(&mut ws, &env, "req-10b-events").await;

    let mut ws2 = connect_and_complete_handshake(&url).await;
    send_json(
        &mut ws2,
        &serde_json::json!({
            "type": "freshAgent.attach",
            "provider": "claude",
            "sessionId": native_id,
            "sessionType": "freshclaude",
            "sessionRef": { "provider": "claude", "sessionId": native_id },
        }),
    )
    .await;
    // The snapshot acknowledgement gates the ordering (attach handled before the send below).
    await_frame(&mut ws2, Duration::from_secs(10), |v| {
        v["sessionId"] == native_id && v["event"]["type"] == "freshAgent.session.snapshot"
    })
    .await;

    // Run an actual turn after attach and observe its assistant event.
    send_json(
        &mut ws2,
        &serde_json::json!({
            "type": "freshAgent.send",
            "provider": "claude",
            "sessionId": native_id,
            "sessionType": "freshclaude",
            "text": "poke",
            "requestId": "send-10b-events",
        }),
    )
    .await;

    let event = await_frame(&mut ws2, Duration::from_secs(10), |v| {
        v["type"] == "freshAgent.event" && v["event"]["type"] == "freshAgent.assistant"
    })
    .await;
    assert_eq!(
        event["sessionId"], native_id,
        "post-attach envelopes must be stamped with the native id"
    );
}

/// ejh6: a `freshAgent.attach` carrying `resumeSessionId` is rejected with
/// `freshAgent.error{code:"FRESH_AGENT_CREATE_FAILED"}` + frozen text. No
/// sidecar spawn, no manager.attach call. Attach has no requestId, so the
/// rejection rides the freshAgent.error event channel keyed by sessionId.
#[tokio::test]
async fn legacy_reject_freshagent_attach() {
    let env = ClaudeSimEnvironment::new();
    let url = spawn_server(&env).await;
    let mut ws = connect_and_complete_handshake(&url).await;

    // ejh6 presence (finding 9): rejection fires for any string, including "".
    for (label, legacy) in [("string", "legacy-durable-id"), ("empty-string", "")] {
        send_json(
            &mut ws,
            &serde_json::json!({
                "type": "freshAgent.attach",
                "sessionId": "cli-session-legacy-attach",
                "sessionType": "freshclaude",
                "provider": "claude",
                "resumeSessionId": legacy,
            }),
        )
        .await;

        let err = await_frame(&mut ws, Duration::from_secs(10), |v| {
            v["type"] == "freshAgent.event"
                && v["event"]["type"] == "freshAgent.error"
                && v["sessionId"] == "cli-session-legacy-attach"
        })
        .await;
        assert_eq!(
            err["event"]["code"],
            serde_json::json!("FRESH_AGENT_CREATE_FAILED"),
            "{label}: attach legacy reject must use the create-failed family code: {err}"
        );
        assert_eq!(
            err["event"]["message"],
            serde_json::json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."),
            "{label}: frozen text: {err}"
        );
    }
    let create_count = env.rows("query").len();
    assert_eq!(
        create_count, 0,
        "no sidecar may spawn for a rejected legacy attach"
    );
}

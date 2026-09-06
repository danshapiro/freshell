//! Task 8 (amplifier watch reduction): `sessions.prefs` ingestion —
//! per-connection `includeSubagents` interest plumbing.
//!
//! A REAL `/ws` connection (the `ui_layout_sync.rs` harness convention) sends
//! the client's `sessions.prefs` frame; the socket loop's
//! `ClientMessage::SessionsPrefs` dispatch arm must OVERWRITE that
//! connection's entry in the shared `SubagentInterestRegistry`, and the
//! connection-teardown block must CLEAR it. Connected-ness plus the latest
//! declared flag is the whole gate (never a fetch-recency time window). No
//! reply frame exists (parity with `ui.layout.sync`), so a `ping`/`pong`
//! round-trip on the SAME connection is the ordering barrier: the serve loop
//! dispatches inbound frames sequentially, so by the time `pong` arrives the
//! prefs frame sent before the `ping` has been fully ingested.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_ws::WsState;

const AUTH_TOKEN: &str = "s3cr3t-token-abcdef";

fn test_settings_value() -> serde_json::Value {
    serde_json::json!({
        "ai": {},
        "codingCli": { "enabledProviders": [], "mcpServer": true, "providers": {} },
        "editor": { "externalEditor": "auto" },
        "extensions": { "disabled": [] },
        "freshAgent": { "defaultPlugins": [], "enabled": false, "providers": {} },
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

/// Real axum server on an ephemeral loopback port. Returns the ws URL plus
/// the `SubagentInterestRegistry` handle cloned into `WsState::subagent_interest`
/// (the registry is `Arc`-backed, so asserting on this handle observes the
/// socket path's ingestion + teardown). Unlike `ui_layout_sync.rs` this
/// harness serves ONLY the WS router (no rest_router wiring).
async fn spawn_server() -> (
    String,
    freshell_ws::subagent_interest::SubagentInterestRegistry,
) {
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings =
        Arc::new(serde_json::from_value(test_settings_value()).expect("valid settings fixture"));
    let interest = freshell_ws::subagent_interest::SubagentInterestRegistry::default();

    let state = WsState {
        layout: Default::default(),
        identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
        terminal_meta: Default::default(),
        pane_ledger: std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::disabled()),
        auto_resume_tx: tokio::sync::mpsc::unbounded_channel().0,
        auto_resume_cancels: Default::default(),
        auth_token: Arc::clone(&auth_token),
        server_instance_id: Arc::new("srv-test".to_string()),
        boot_id: Arc::new("boot-test".to_string()),
        settings,
        handshake_settings: Arc::new(tokio::sync::RwLock::new(
            serde_json::from_value(test_settings_value()).expect("valid settings fixture"),
        )),
        broadcast_tx: Arc::clone(&broadcast_tx),
        fresh_codex: freshell_freshagent::FreshCodexState::new(
            Arc::clone(&auth_token),
            Arc::clone(&broadcast_tx),
            serde_json::json!({ "freshAgent": { "enabled": false } }),
        ),
        fresh_claude: freshell_freshagent::FreshClaudeState::new(Arc::clone(&broadcast_tx)),
        fresh_opencode: freshell_freshagent::FreshOpencodeState::new(
            freshell_freshagent::FreshAgentState::new(
                Arc::clone(&auth_token),
                Arc::clone(&broadcast_tx),
            ),
        ),
        registry: freshell_terminal::TerminalRegistry::new(),
        tabs: freshell_ws::tabs::TabsRegistry::new(),
        screenshots: freshell_ws::screenshot::ScreenshotBroker::new(Arc::clone(&broadcast_tx)),
        subagent_interest: interest.clone(),
        host_stats: Default::default(),
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
    };

    let router = freshell_ws::router(state);
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    (format!("ws://{addr}/ws", addr = addr), interest)
}

type TestWs =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Connect + hello, draining the 4-frame handshake (`config_fallback` is None
/// in this harness): ready -> settings.updated -> perf.logging ->
/// terminal.inventory.
async fn connect_and_hello(url: &str) -> TestWs {
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
    let inventory = next_frame_of_type(&mut ws, "terminal.inventory").await;
    assert!(
        !inventory.is_null(),
        "handshake must contain terminal.inventory"
    );
    ws
}

/// Read text frames until one with `type == wanted` arrives (bounded).
async fn next_frame_of_type(ws: &mut TestWs, wanted: &str) -> serde_json::Value {
    for _ in 0..20u8 {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for a {wanted} frame"))
            .expect("stream not ended")
            .expect("no ws error");
        if let WsMessage::Text(text) = &msg {
            let value: serde_json::Value = serde_json::from_str(text).expect("json frame");
            if value["type"] == serde_json::json!(wanted) {
                return value;
            }
        }
    }
    panic!("no {wanted} frame within 20 messages");
}

#[tokio::test]
async fn subagent_interest_registry_clears_on_disconnect() {
    let (url, interest) = spawn_server().await;
    let mut ws = connect_and_hello(&url).await;
    assert!(!interest.any());

    ws.send(WsMessage::Text(
        serde_json::json!({"type":"sessions.prefs","includeSubagents":true}).to_string(),
    ))
    .await
    .unwrap();
    // Ordering barrier: ping/pong proves the frame was ingested.
    ws.send(WsMessage::Text(r#"{"type":"ping"}"#.into()))
        .await
        .unwrap();
    let _ = next_frame_of_type(&mut ws, "pong").await;
    assert!(interest.any(), "frame registered");

    // Second connection subscribes too.
    let mut ws2 = connect_and_hello(&url).await;
    ws2.send(WsMessage::Text(
        serde_json::json!({"type":"sessions.prefs","includeSubagents":true}).to_string(),
    ))
    .await
    .unwrap();
    ws2.send(WsMessage::Text(r#"{"type":"ping"}"#.into()))
        .await
        .unwrap();
    let _ = next_frame_of_type(&mut ws2, "pong").await;
    assert!(interest.any());

    // First disconnects: still armed (second remains).
    drop(ws);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(interest.any(), "one remaining connection keeps the gate on");

    // Last disconnect: clears (regression 15's stop-on-disconnect).
    drop(ws2);
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if !interest.any() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("cleared when the last interested connection left");
}

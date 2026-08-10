//! Task 13 (AUTO-01 spine): `ui.layout.sync` ingestion.
//!
//! A REAL `/ws` connection (the `session_identity_frames.rs` harness
//! convention) sends the client's layout mirror frame; the socket loop's
//! `ClientMessage::UiLayoutSync` dispatch arm must REPLACE the shared
//! server-side `LayoutStore` snapshot (`update_from_ui`) -- the port of the
//! dedicated `case 'ui.layout.sync'` arm's `this.layoutStore.updateFromUi(m,
//! ws.connectionId || 'unknown')` (`server/ws-handler.ts:1966-1969`).
//!
//! No reply frame exists (Node sends none), so a `ping`/`pong` round-trip on
//! the SAME connection is the ordering barrier: the serve loop dispatches
//! inbound frames sequentially, so by the time `pong` arrives the layout
//! frame sent before the `ping` has been fully ingested.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_freshagent::layout_store::LayoutStore;
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
/// the SAME `LayoutStore` handle cloned into `WsState::layout` (the store is
/// `Arc`-backed, so asserting on this handle observes the socket path's
/// ingestion).
async fn spawn_server() -> (String, LayoutStore) {
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings =
        Arc::new(serde_json::from_value(test_settings_value()).expect("valid settings fixture"));
    let layout = LayoutStore::default();

    let state = WsState {
        layout: layout.clone(),
        identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
        terminal_meta: Default::default(),
        pane_ledger: std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::disabled()),
        auto_resume_tx: tokio::sync::mpsc::unbounded_channel().0,
        auto_resume_cancels: Default::default(),
        auth_token: Arc::clone(&auth_token),
        server_instance_id: Arc::new("srv-test".to_string()),
        boot_id: Arc::new("boot-test".to_string()),
        settings,
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

    (format!("ws://{addr}/ws", addr = addr), layout)
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

/// **RED for Task 13**: a `ui.layout.sync` client frame must populate the
/// shared server-side `LayoutStore` -- `has_snapshot()` flips true,
/// `list_tabs()` reflects the payload's tab rows + active tab, and the source
/// connection id is stamped. No reply frame is asserted because none exists
/// (the `pong` barrier proves dispatch completed).
#[tokio::test]
async fn ui_layout_sync_frame_populates_the_shared_layout_store() {
    let (url, layout) = spawn_server().await;
    let mut ws = connect_and_hello(&url).await;
    assert!(
        !layout.has_snapshot(),
        "harness sanity: the store starts empty"
    );

    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "ui.layout.sync",
            "tabs": [{"id": "t1", "title": "Work"}],
            "activeTabId": "t1",
            "layouts": {"t1": {"type": "leaf", "id": "p1", "content": {
                "kind": "terminal", "mode": "shell",
                "createRequestId": "r1", "status": "running"
            }}},
            "activePane": {"t1": "p1"},
            "paneTitles": {},
            "paneTitleSetByUser": {},
            "timestamp": 123
        })
        .to_string(),
    ))
    .await
    .expect("send ui.layout.sync");

    // Ordering barrier: the serve loop dispatches this connection's frames
    // sequentially, so the pong proves the layout frame was handled.
    ws.send(WsMessage::Text(
        serde_json::json!({ "type": "ping" }).to_string(),
    ))
    .await
    .expect("send ping");
    next_frame_of_type(&mut ws, "pong").await;

    assert!(
        layout.has_snapshot(),
        "ui.layout.sync must REPLACE the shared layout snapshot"
    );
    let (tabs, active) = layout.list_tabs();
    assert_eq!(tabs.len(), 1, "one tab row: {tabs:?}");
    assert_eq!(tabs[0]["id"], serde_json::json!("t1"));
    assert_eq!(tabs[0]["title"], serde_json::json!("Work"));
    assert_eq!(tabs[0]["activePaneId"], serde_json::json!("p1"));
    assert_eq!(active.as_deref(), Some("t1"));
    assert!(
        layout.source_connection_id().is_some(),
        "ingestion must stamp the source connection id"
    );
}

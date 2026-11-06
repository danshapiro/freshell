//! Session-index readiness wire tests (auto-restore-warming Task 2):
//! `sessionIndexReadyV1` negotiation, the `ready.sessionIndexReady` state
//! field, and the capability-gated `sessions.index.ready` boot broadcast.
//!
//! Three contracts, one file:
//! 1. a negotiating client's ready frame carries the CURRENT readiness
//!    state — an already-ready reconnect (the race where the index warms
//!    between connections) converges to `true`, not a stale `false`;
//! 2. the readiness broadcast reaches exactly the negotiating connections;
//! 3. a frozen client's wire stays byte-for-byte legacy — it never receives
//!    the new frame and its ready frame gains no `sessionIndexReady` field.
//!
//! Same real axum server + raw tokio-tungstenite client convention as
//! `tests/pane_reconcile.rs` (ephemeral loopback port, never a fixed one).
//! That harness's `Server` handle exposes only `{url, registry, identity}`,
//! but the readiness broadcast needs a live `&WsState` to call
//! `broadcast_sessions_index_ready` on — so this file owns a thin local
//! wrapper that ALSO retains a cloned state handle. `WsState` is `Clone`
//! (every field is an Arc/primitive) and the broadcast reads only the
//! SHARED `broadcast_tx`, so the retained clone drives the same bus the
//! live connections subscribe to — exactly what the production boot
//! wiring (Task 3) does with the production state.

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

/// The local spawn wrapper: a real axum server on an ephemeral loopback
/// port PLUS a retained `Arc<WsState>` handle (a clone sharing the same
/// `broadcast_tx` the served connections subscribe to) so tests can call
/// `broadcast_sessions_index_ready` directly, exactly like the Task 3
/// production boot wiring will.
struct Server {
    url: String,
    state: Arc<WsState>,
}

async fn spawn_server_with(mutate: impl FnOnce(&mut WsState)) -> Server {
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings =
        Arc::new(serde_json::from_value(test_settings_value()).expect("valid settings fixture"));

    let mut state = WsState {
        session_index_ready: None,
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
        ownership: None,
    };
    mutate(&mut state);
    let retained = Arc::new(state.clone());

    let router = freshell_ws::router(state);
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    Server {
        url: format!("ws://{addr}/ws"),
        state: retained,
    }
}

type TestWs =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Connect, send a `hello` carrying `capabilities`, and consume the 4-frame
/// connect handshake (`ready` + `settings.updated` + `perf.logging` +
/// `terminal.inventory`; no `config.fallback` on this fixture). Returns the
/// socket and the parsed `ready` frame.
async fn connect_hello(url: &str, capabilities: serde_json::Value) -> (TestWs, serde_json::Value) {
    let (mut ws, _resp) = tokio_tungstenite::connect_async(url)
        .await
        .expect("ws connect");
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "hello",
            "token": AUTH_TOKEN,
            "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
            "capabilities": capabilities,
        })
        .to_string(),
    ))
    .await
    .expect("send hello");

    let mut ready = serde_json::Value::Null;
    for _ in 0..4u8 {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("handshake message within timeout")
            .expect("stream not ended")
            .expect("no ws error");
        if let WsMessage::Text(text) = &msg {
            let value: serde_json::Value = serde_json::from_str(text).expect("json frame");
            if value["type"] == serde_json::json!("ready") {
                ready = value;
            }
        }
    }
    assert!(!ready.is_null(), "handshake must contain ready");
    (ws, ready)
}

/// Read the next JSON text frame from the socket (bounded).
async fn next_frame(ws: &mut TestWs) -> serde_json::Value {
    let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
        .await
        .expect("frame within timeout")
        .expect("stream not ended")
        .expect("no ws error");
    let WsMessage::Text(text) = msg else {
        panic!("expected a text frame, got {msg:?}");
    };
    serde_json::from_str(&text).expect("frame is JSON")
}

/// True iff NO frame arrives within `window` — the frozen-silence probe for
/// the broadcast gate (a keepalive ping would also count as a violation,
/// so the window stays well under the 30s ping cadence).
async fn expect_silence(ws: &mut TestWs, window: Duration) -> bool {
    matches!(tokio::time::timeout(window, ws.next()).await, Err(_elapsed))
}

/// Contract 1: a negotiating client's ready frame carries the CURRENT
/// readiness state. First connect while the index is cold → `false`; once
/// readiness publishes, a reconnect's ready reports `true` — the
/// already-ready subscription race converges instead of stranding the
/// client on a stale `false` (or forcing it to wait for the broadcast).
#[tokio::test]
async fn ready_frame_carries_current_readiness_state_for_negotiating_clients() {
    let (ready_tx, ready_rx) = tokio::sync::watch::channel(false);
    let server = spawn_server_with(|state| state.session_index_ready = Some(ready_rx)).await;

    let (_ws, ready) = connect_hello(
        &server.url,
        serde_json::json!({ "sessionIndexReadyV1": true }),
    )
    .await;
    assert_eq!(
        ready["sessionIndexReady"], false,
        "a cold index must report false: {ready}"
    );
    assert_eq!(
        ready["capabilities"]["sessionIndexReadyV1"], true,
        "the echo must be advertised back: {ready}"
    );

    // The index warms; a reconnect's handshake reads the CURRENT state.
    ready_tx.send(true).expect("watch alive");
    let (_ws2, ready2) = connect_hello(
        &server.url,
        serde_json::json!({ "sessionIndexReadyV1": true }),
    )
    .await;
    assert_eq!(
        ready2["sessionIndexReady"], true,
        "an already-ready reconnect must converge to true: {ready2}"
    );
}

/// Contracts 2 + 3: the readiness broadcast reaches exactly the
/// negotiating connections, and the frozen wire stays byte-for-byte
/// legacy — the frozen connection never receives the frame, and its ready
/// carries NO `sessionIndexReady` field at all.
#[tokio::test]
async fn readiness_broadcast_reaches_only_negotiating_connections() {
    let (ready_tx, ready_rx) = tokio::sync::watch::channel(false);
    let server = spawn_server_with(|state| state.session_index_ready = Some(ready_rx)).await;

    let (mut negotiated, negotiated_ready) = connect_hello(
        &server.url,
        serde_json::json!({ "sessionIndexReadyV1": true }),
    )
    .await;
    assert_eq!(
        negotiated_ready["sessionIndexReady"], false,
        "cold index at handshake time: {negotiated_ready}"
    );

    let (mut frozen, frozen_ready) = connect_hello(&server.url, serde_json::json!({})).await;
    assert!(
        frozen_ready.get("sessionIndexReady").is_none(),
        "a frozen ready must not gain the state field: {frozen_ready}"
    );
    assert!(
        frozen_ready.get("capabilities").is_none(),
        "a frozen ready must not gain a capabilities object: {frozen_ready}"
    );

    // The index warms and the boot wiring fires the one-per-boot broadcast —
    // the production Task 3 wiring calls exactly this function on the
    // production state, which shares the broadcast bus with this handle.
    ready_tx.send(true).expect("watch alive");
    freshell_ws::terminal::broadcast_sessions_index_ready(&server.state);

    let frame = next_frame(&mut negotiated).await;
    assert_eq!(
        frame["type"], "sessions.index.ready",
        "the negotiating connection receives the readiness broadcast: {frame}"
    );
    assert!(
        expect_silence(&mut frozen, Duration::from_millis(300)).await,
        "the frozen connection must never receive the readiness broadcast"
    );
}

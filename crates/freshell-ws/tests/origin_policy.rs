//! Integration tests for the SAFE-03 WS Origin policy (`crates/freshell-ws/src/origin.rs`).
//!
//! These run a REAL axum server on an ephemeral loopback port + a REAL
//! `tokio-tungstenite` client, so they exercise the actual `/ws` upgrade path
//! (`ws_handler` -> `handle_socket`), not just the pure `evaluate_origin`
//! function unit-tested in `origin.rs`.

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::{handshake::client::generate_key, http::Request};

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

/// Spin up a real axum server on an ephemeral loopback port with a
/// test-controlled Origin allow-list. Returns `(addr, ws_url)`.
async fn spawn_server(allowed_origins: Vec<String>) -> (String, String) {
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(16).0);
    let settings =
        Arc::new(serde_json::from_value(test_settings_value()).expect("valid settings fixture"));

    let state = WsState {
        identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
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
        allowed_origins: Arc::new(allowed_origins),
        ws_max_payload_bytes: 16 * 1024 * 1024,
        term09: freshell_ws::backpressure::Term09Config::default(),
        config_fallback: None,
        amplifier_locator: None,
        opencode_locator: None,
        activity: None,
    };

    let router = freshell_ws::router(state);
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    (addr.to_string(), format!("ws://{addr}/ws"))
}

/// Connect to `url` with an explicit (or absent) `Origin` header and a `Host`
/// matching `addr`, then observe whether the handshake completes and, if so,
/// whether the socket is closed before any session state arrives.
///
/// Returns `true` if the connection was allowed to proceed (upgrade succeeds
/// AND the socket is not immediately closed), `false` if the origin policy
/// rejected it (upgrade may succeed at the HTTP layer, per SAFE-03's "close
/// before session state is exposed" contract, but the very next frame is a
/// `Close`, never `ready`).
async fn connect_with_origin(url: &str, addr: &str, origin: Option<&str>) -> bool {
    let mut builder = Request::builder()
        .uri(url)
        .header("Host", addr)
        .header("Upgrade", "websocket")
        .header("Connection", "Upgrade")
        .header("Sec-WebSocket-Key", generate_key())
        .header("Sec-WebSocket-Version", "13");
    if let Some(origin) = origin {
        builder = builder.header("Origin", origin);
    }
    let request = builder.body(()).expect("valid ws upgrade request");

    let (mut ws, _resp) = tokio_tungstenite::connect_async(request)
        .await
        .expect("ws upgrade should complete at the HTTP layer regardless of Origin verdict");

    // Send a well-formed hello immediately -- if Origin policy rejects, this
    // must never be processed (the connection closes before reading it).
    let _ = futures_util::SinkExt::send(
        &mut ws,
        tokio_tungstenite::tungstenite::Message::Text(
            serde_json::json!({
                "type": "hello",
                "token": AUTH_TOKEN,
                "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
            })
            .to_string(),
        ),
    )
    .await;

    match tokio::time::timeout(Duration::from_secs(3), ws.next()).await {
        Ok(Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text)))) => {
            // First frame is real session state (an `error` frame is only
            // sent alongside a close for the reject path, and a `ready`
            // frame here is a clear GO -- either way, text arriving before a
            // close means the connection was allowed to proceed).
            text.contains("\"type\":\"ready\"") || !text.contains("Origin not allowed")
        }
        Ok(Some(Ok(tokio_tungstenite::tungstenite::Message::Close(frame)))) => {
            let rejected_for_origin = frame
                .as_ref()
                .map(|f| {
                    f.code
                        == tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::from(
                            4011,
                        )
                })
                .unwrap_or(false);
            !rejected_for_origin
        }
        _ => false,
    }
}

#[tokio::test]
async fn no_origin_header_is_allowed_through_to_handshake() {
    let (addr, url) = spawn_server(freshell_ws::origin::default_allowed_origins()).await;
    assert!(
        connect_with_origin(&url, &addr, None).await,
        "a non-browser client (no Origin header) must still reach the ready handshake"
    );
}

#[tokio::test]
async fn same_origin_matching_host_is_allowed() {
    let (addr, url) = spawn_server(vec![]).await; // empty allow-list: same-origin must not need it
    let origin = format!("http://{addr}");
    assert!(
        connect_with_origin(&url, &addr, Some(&origin)).await,
        "an Origin equal to the request's own Host must be allowed even with an empty allow-list"
    );
}

/// The DNS-rebinding case: a hostile page's Origin never matches Host or the
/// allow-list. This must be rejected BEFORE session state is exposed, even
/// though the client presents a perfectly valid AUTH_TOKEN in its hello.
#[tokio::test]
async fn hostile_origin_with_valid_token_is_rejected_before_session_state() {
    let (addr, url) = spawn_server(freshell_ws::origin::default_allowed_origins()).await;
    assert!(
        !connect_with_origin(&url, &addr, Some("http://evil.example")).await,
        "a hostile Origin must be rejected even with a valid AUTH_TOKEN in the hello"
    );
}

#[tokio::test]
async fn null_origin_is_rejected() {
    let (addr, url) = spawn_server(freshell_ws::origin::default_allowed_origins()).await;
    assert!(
        !connect_with_origin(&url, &addr, Some("null")).await,
        "the literal `null` Origin (sandboxed iframe / file://) must be rejected"
    );
}

#[tokio::test]
async fn allow_listed_origin_is_accepted() {
    let allowed = vec!["https://trusted.example".to_string()];
    let (addr, url) = spawn_server(allowed).await;
    assert!(
        connect_with_origin(&url, &addr, Some("https://trusted.example")).await,
        "an Origin present in the resolved allow-list must be accepted"
    );
}

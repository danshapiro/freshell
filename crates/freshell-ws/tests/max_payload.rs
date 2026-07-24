//! Integration tests for SAFE-06's inbound frame/message size bound (legacy
//! parity: `server/ws-handler.ts:226,728` --
//! `wsMaxPayloadBytes: Number(process.env.WS_MAX_PAYLOAD_BYTES || 16 * 1024 * 1024)`
//! passed to the `ws` library's `maxPayload`, which aborts a connection whose
//! message exceeds it).
//!
//! These run a REAL axum server (on an ephemeral loopback port -- never a
//! fixed/reserved one) and a REAL `tokio-tungstenite` WS client, so they
//! exercise the actual `WebSocketUpgrade` config wired in `crate::ws_handler`,
//! not a mock.
//!
//! Boundary strategy: JSON permits insignificant whitespace between tokens,
//! so a syntactically-valid `terminal.create` frame is padded with leading
//! spaces (inside the object, right after `{`) to hit an EXACT target byte
//! length. This lets the test pin the precise accept/reject boundary without
//! depending on any internal frame-vs-message-size distinction.

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

/// Build a `WsState` with a test-controlled `ws_max_payload_bytes` and spin up
/// a real axum server on an ephemeral loopback port. Returns its `ws://` URL.
async fn spawn_server(ws_max_payload_bytes: usize) -> String {
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
        allowed_origins: Arc::new(freshell_ws::origin::default_allowed_origins()),
        ws_max_payload_bytes,
        term09: freshell_ws::backpressure::Term09Config::default(),
        config_fallback: None,
        amplifier_locator: None,
        opencode_locator: None,
        session_existence: std::sync::Arc::new(freshell_ws::existence::NoIndexProbe::default()),
    };

    let router = freshell_ws::router(state);
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    format!("ws://{addr}/ws", addr = addr)
}

type TestWs =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Connect, send `hello`, and read past the 4-message connect handshake so
/// the socket is past auth and ready for a `terminal.*` frame.
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

    for _ in 0..4u8 {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("handshake message within timeout")
            .expect("stream not ended")
            .expect("no ws error");
        assert!(
            matches!(msg, WsMessage::Text(_)),
            "expected a text handshake frame, got {msg:?}"
        );
    }
    ws
}

/// A syntactically-valid `terminal.create` frame, whitespace-padded to an
/// EXACT total byte length. Padding is inserted right after the opening
/// brace, where JSON permits insignificant whitespace between tokens.
fn padded_terminal_create(request_id: &str, total_len: usize) -> String {
    let unpadded = serde_json::json!({
        "type": "terminal.create",
        "requestId": request_id,
        "mode": "shell",
        "shell": "system",
    })
    .to_string();
    // `unpadded` is "{...}"; insert padding spaces immediately after the `{`.
    assert!(
        total_len >= unpadded.len(),
        "target length {total_len} smaller than the unpadded frame ({} bytes)",
        unpadded.len()
    );
    let pad = total_len - unpadded.len();
    format!("{{{}{}", " ".repeat(pad), &unpadded[1..])
}

/// Read frames until a `terminal.created` for `request_id` arrives, or the
/// deadline elapses. Returns `true` if it arrived.
async fn wait_for_terminal_created(ws: &mut TestWs, request_id: &str) -> bool {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(2), ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
                    continue;
                };
                if value.get("type").and_then(|v| v.as_str()) == Some("terminal.created")
                    && value.get("requestId").and_then(|v| v.as_str()) == Some(request_id)
                {
                    return true;
                }
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(_))) | Ok(None) => return false,
            Err(_) => return false,
        }
    }
    false
}

/// A frame whose serialized size is EXACTLY the configured max is accepted
/// and dispatched normally (a `terminal.created` reply arrives) -- the just-
/// below-the-limit half of SAFE-06's Playwright validation ("Send just-below/
/// just-above-limit ... WS payloads ... assert correct rejection ... and
/// exact ... reassembly for allowed data").
#[tokio::test]
async fn message_at_exactly_the_limit_is_accepted_and_processed() {
    let max_payload = 4096usize;
    let url = spawn_server(max_payload).await;
    let mut ws = connect_and_complete_handshake(&url).await;

    let frame = padded_terminal_create("at-limit", max_payload);
    assert_eq!(frame.len(), max_payload);
    ws.send(WsMessage::Text(frame)).await.expect("send frame");

    assert!(
        wait_for_terminal_created(&mut ws, "at-limit").await,
        "a frame at exactly ws_max_payload_bytes should be accepted and dispatched"
    );
}

/// A frame one byte over the configured max is rejected at the transport
/// layer: the connection ends (error or close) instead of producing the
/// `terminal.created` reply a same-shaped-but-smaller frame would. A SECOND,
/// independent connection stays fully healthy throughout -- proving the
/// oversized flood on connection A has no cross-client impact (SAFE-06:
/// "... and unaffected second-client health").
#[tokio::test]
async fn message_one_byte_over_the_limit_is_rejected_without_affecting_other_clients() {
    let max_payload = 4096usize;
    let url = spawn_server(max_payload).await;

    let mut ws_a = connect_and_complete_handshake(&url).await;
    let oversized = padded_terminal_create("over-limit", max_payload + 1);
    assert_eq!(oversized.len(), max_payload + 1);
    // The client-side write itself may succeed (tungstenite doesn't cap
    // outgoing size); the rejection happens when the SERVER reads it back.
    let _ = ws_a.send(WsMessage::Text(oversized)).await;

    // Connection A must never see the frame processed (no terminal.created
    // for this request id) -- it should instead observe the connection end.
    let processed = wait_for_terminal_created(&mut ws_a, "over-limit").await;
    assert!(
        !processed,
        "an oversized frame must not be dispatched to the application layer"
    );

    // A fresh, independent connection B proves the server itself stayed
    // healthy -- the oversized frame on A didn't crash/wedge the process.
    let mut ws_b = connect_and_complete_handshake(&url).await;
    let ok_frame = padded_terminal_create("client-b-ok", 200);
    ws_b.send(WsMessage::Text(ok_frame))
        .await
        .expect("send frame on second connection");
    assert!(
        wait_for_terminal_created(&mut ws_b, "client-b-ok").await,
        "a second, independent connection must be unaffected by client A's oversized frame"
    );
}

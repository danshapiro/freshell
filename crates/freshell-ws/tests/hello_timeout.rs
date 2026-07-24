//! Integration tests for the `/ws` hello-handshake deadline (SAFE-05, legacy
//! parity: `server/ws-handler.ts:1167-1171` -- `state.helloTimer =
//! setTimeout(() => { if (!state.authenticated) ws.close(CLOSE_CODES.HELLO_TIMEOUT,
//! 'Hello timeout') }, helloTimeoutMs)`, cleared only on a successful `hello`
//! at `ws-handler.ts:1856`).
//!
//! Before this fix, `crates/freshell-ws/src/lib.rs`'s `handle_socket` read the
//! first client frame with NO deadline at all (confirmed by exhaustive grep
//! across `crates/` for `hello_timeout`/`HELLO_TIMEOUT` prior to this change):
//! a connection that opened and never sent anything (or sent only control
//! frames) stayed open forever. These tests run a REAL axum server (on an
//! ephemeral loopback port -- never a fixed/reserved one) and a REAL
//! `tokio-tungstenite` WS client, so they exercise the actual accept path, not
//! a mock.

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
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

/// Build a `WsState` with a test-controlled `hello_timeout_ms`, spin up a real
/// axum server on an ephemeral loopback port (`127.0.0.1:0`, never a fixed/
/// reserved port), and return its `ws://` URL.
async fn spawn_server(hello_timeout_ms: u64) -> String {
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
        hello_timeout_ms,
        allowed_origins: Arc::new(freshell_ws::origin::default_allowed_origins()),
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

    format!("ws://{addr}/ws", addr = addr)
}

/// **RED test for the actual defect**: a connection that opens and never
/// sends ANYTHING (no `hello`, no other frame) must be closed with
/// `HELLO_TIMEOUT` (4002) once `hello_timeout_ms` elapses -- legacy parity:
/// `ws-handler.ts:1167-1171` / `CLOSE_CODES.HELLO_TIMEOUT` (`:255`, `4002`).
/// Before the fix, `handle_socket`'s first-frame read had no deadline at all,
/// so this test would time out waiting for a close frame that never came.
#[tokio::test]
async fn connection_with_no_hello_is_closed_with_hello_timeout_code() {
    let hello_timeout_ms = 200;
    let url = spawn_server(hello_timeout_ms).await;

    let (mut ws, _resp) = tokio_tungstenite::connect_async(&url)
        .await
        .expect("ws connect");

    // Deliberately send nothing. Wait comfortably past the deadline for the
    // close frame.
    let outcome = tokio::time::timeout(Duration::from_secs(5), ws.next()).await;

    match outcome {
        Ok(Some(Ok(WsMessage::Close(frame)))) => {
            let code = frame.map(|f| f.code);
            assert_eq!(
                code,
                Some(
                    tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::from(4002)
                ),
                "a connection that never sends hello must close with HELLO_TIMEOUT (4002), \
                 matching legacy's CLOSE_CODES.HELLO_TIMEOUT (ws-handler.ts:255)"
            );
        }
        Ok(Some(Ok(other))) => panic!("expected a Close frame, got {other:?}"),
        Ok(Some(Err(err))) => panic!("unexpected ws error: {err}"),
        Ok(None) => panic!("stream ended without any frame (expected a Close frame)"),
        Err(_) => panic!(
            "timed out waiting for the server to close an un-helloed connection \
             (hello_timeout_ms={hello_timeout_ms}) -- the hello-timeout deadline is not enforced"
        ),
    }
}

/// **Control**: a connection that completes `hello` well within the deadline
/// must stay open past it -- the timer is cleared on authentication
/// (`ws-handler.ts:1856`), not merely delayed.
#[tokio::test]
async fn connection_with_timely_hello_stays_open_past_the_deadline() {
    let hello_timeout_ms = 100;
    let url = spawn_server(hello_timeout_ms).await;

    let (mut ws, _resp) = tokio_tungstenite::connect_async(&url)
        .await
        .expect("ws connect");

    use futures_util::SinkExt;
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

    // Read the 4-message connect handshake (ready / settings.updated /
    // perf.logging / terminal.inventory) -- proves authentication succeeded.
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

    // Wait past the (short) hello deadline. An authenticated connection must
    // NOT be closed by the (already-cleared) hello timer.
    tokio::time::sleep(Duration::from_millis(hello_timeout_ms * 5)).await;

    match tokio::time::timeout(Duration::from_millis(200), ws.next()).await {
        Err(_) => {} // no frame arrived -- connection is still open and quiet, as expected
        Ok(Some(Ok(WsMessage::Close(frame)))) => {
            panic!("authenticated connection was closed unexpectedly: {frame:?}")
        }
        Ok(other) => panic!("unexpected frame/end on an authenticated connection: {other:?}"),
    }
}

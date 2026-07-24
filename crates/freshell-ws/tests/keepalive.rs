//! Integration tests for the `/ws` keepalive contract (legacy parity:
//! `server/ws-handler.ts:745-755` — a per-connection `setInterval` that
//! `ws.ping()`s on a configured cadence and `ws.terminate()`s the socket if no
//! pong arrived since the previous tick).
//!
//! Before this fix, `crates/freshell-ws/src/terminal.rs`'s connection loop sent
//! NO server-initiated traffic at all on an otherwise-idle socket. These tests
//! run a REAL axum server (on an ephemeral loopback port — never a fixed/
//! reserved one) and a REAL `tokio-tungstenite` WS client, so they exercise the
//! actual `tokio::select!` loop, not a mock.

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

/// Build a `WsState` with test-controlled `ping_interval_ms` and broadcast
/// channel capacity, spin up a real axum server on an ephemeral loopback port
/// (`127.0.0.1:0`, never a fixed/reserved port), and return its `ws://` URL
/// plus the broadcast sender (so a test can push bus frames the way REST
/// handlers do, e.g. fresh-agent turn events).
async fn spawn_server(
    ping_interval_ms: u64,
    broadcast_capacity: usize,
) -> (String, Arc<tokio::sync::broadcast::Sender<String>>) {
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(broadcast_capacity).0);
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
        ping_interval_ms,
        hello_timeout_ms: 5_000,
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

    (format!("ws://{addr}/ws", addr = addr), broadcast_tx)
}

type TestWs =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Connect, send `hello`, and read past the 4-message connect handshake
/// (`ready` / `settings.updated` / `perf.logging` / `terminal.inventory`) so
/// the socket is past auth and ready to observe keepalive traffic.
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

/// **RED test for the actual defect**: today's `terminal::run()` sends NO
/// server-initiated traffic at all, so this fails against the pre-fix code
/// (zero `Ping` frames observed within several configured intervals). Legacy
/// parity: `ws-handler.ts:745-755` pings every `pingIntervalMs` tick. A
/// well-behaved client (this one) auto-replies pong on every read
/// (`tungstenite` queues + flushes the pong automatically — see
/// `protocol/mod.rs`'s `write()` doc: "upon receiving ping messages tungstenite
/// queues pong replies automatically"), so surviving several consecutive
/// cycles also proves the pong is being accepted and does NOT trip the
/// missed-pong termination path.
#[tokio::test]
async fn idle_connection_receives_periodic_pings_and_survives_multiple_cycles() {
    let ping_interval_ms = 30;
    let (url, _broadcast_tx) = spawn_server(ping_interval_ms, 16).await;
    let mut ws = connect_and_complete_handshake(&url).await;

    let mut ping_count = 0u32;
    let deadline = tokio::time::Instant::now() + Duration::from_millis(ping_interval_ms * 8);
    while tokio::time::Instant::now() < deadline && ping_count < 4 {
        match tokio::time::timeout(Duration::from_millis(ping_interval_ms * 4), ws.next()).await {
            Ok(Some(Ok(WsMessage::Ping(_)))) => ping_count += 1,
            Ok(Some(Ok(_))) => {} // ignore any other frame type
            Ok(Some(Err(err))) => panic!("unexpected ws error: {err}"),
            Ok(None) => panic!("connection closed unexpectedly while awaiting keepalive pings"),
            Err(_) => break, // timed out waiting — fall through to the count assertion
        }
    }

    assert!(
        ping_count >= 4,
        "expected >= 4 server-initiated Ping frames across several keepalive cycles \
         (legacy parity: ws-handler.ts:745-755), got {ping_count}"
    );
}

/// **SAFE-10**: a slow broadcast consumer that falls behind past the
/// channel's capacity (`RecvError::Lagged`) must NOT be left silently stale
/// (the pre-SAFE-10 `Err(RecvError::Lagged(_)) => {}` arm skipped the gap
/// and kept serving with NO signal that frames were dropped, so the
/// client's UI would go permanently stale — ghost terminals, stuck busy
/// indicators, missed `settings.updated`, etc.). Legacy parity
/// (`server/ws-handler.ts:1562-1568`/`:1680-1710`): a slow consumer is
/// detected and the socket is closed with `CLOSE_CODES.BACKPRESSURE` (4008,
/// reason `"Backpressure"`), forcing the client to reconnect and run the
/// full handshake resync (`ready` + `settings.updated` + inventory). The
/// tokio broadcast model has no per-socket `bufferedAmount` equivalent (it
/// drops rather than buffers), so this translates the *intent* (recover,
/// don't go stale) via the same close code, not the buffered-bytes
/// mechanism — see `terminal.rs`'s `Err(RecvError::Lagged(dropped))` arm.
///
/// Was RED before the fix: the pre-fix `Err(RecvError::Lagged(_)) => {}`
/// arm never closes, so this test timed out waiting for a close frame and
/// instead observed the (stale) post-flood marker delivered as an ordinary
/// text frame, proving the old silent-skip behavior.
#[tokio::test]
async fn slow_broadcast_consumer_lag_closes_with_backpressure_code_for_resync() {
    // A tiny channel capacity so a small flood guarantees a `Lagged` gap for a
    // consumer that hasn't drained yet.
    let broadcast_capacity = 4;
    let (url, broadcast_tx) = spawn_server(30_000, broadcast_capacity).await;
    let mut ws = connect_and_complete_handshake(&url).await;

    // Flood well past capacity while the client isn't reading yet — the
    // connection's very first `bcast_rx.recv()` observes `Lagged`.
    for i in 0..(broadcast_capacity * 5) {
        let _ = broadcast_tx.send(format!(r#"{{"type":"flood","seq":{i}}}"#));
    }
    // A distinguishable marker sent after the flood — must NOT reach the
    // client as an ordinary text frame; the connection should already be
    // closing by the time this would have been delivered.
    let _ = broadcast_tx.send(r#"{"type":"marker","id":"post-flood"}"#.to_string());

    let mut close_code = None;
    let mut saw_marker_as_text = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(2), ws.next()).await {
            Ok(Some(Ok(WsMessage::Close(frame)))) => {
                close_code = frame.map(|f| f.code);
                break;
            }
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                if text.contains("post-flood") {
                    saw_marker_as_text = true;
                }
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(_))) => break, // an abrupt close also reads as a stream error; fine either way
            Ok(None) => break,
            Err(_) => break,
        }
    }

    assert_eq!(
        close_code,
        Some(tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::from(4008)),
        "a broadcast-lagged connection must close with the backpressure code (4008) so the \
         client reconnects and resyncs, matching legacy's CLOSE_CODES.BACKPRESSURE"
    );
    assert!(
        !saw_marker_as_text,
        "a lagged connection must not keep silently serving stale post-lag frames as if \
         nothing happened"
    );
}

/// **Missed-pong termination**: a connection that never answers a ping is
/// terminated after exactly one unanswered cycle (legacy `ws.isAlive` /
/// `ws.terminate()`). The client here deliberately stops polling the stream
/// after the handshake — per `tungstenite`'s own contract ("you should not
/// respond to ping frames manually"; the auto-pong is only queued+flushed on
/// the NEXT `read`/`write`/`flush` call), never polling again means no pong
/// is ever sent, genuinely simulating an unresponsive peer (not a clean
/// close).
#[tokio::test]
async fn connection_with_no_pong_reply_is_terminated_after_one_missed_cycle() {
    let ping_interval_ms = 30;
    let (url, _broadcast_tx) = spawn_server(ping_interval_ms, 16).await;
    let mut ws = connect_and_complete_handshake(&url).await;

    // Deliberately go silent: no further reads/writes/flushes means
    // tungstenite never processes (and thus never auto-replies to) the
    // server's ping — the server should see tick 1 (ping sent, isAlive =
    // false) then tick 2 (still false => terminate) and drop the connection.
    tokio::time::sleep(Duration::from_millis(ping_interval_ms * 6)).await;

    // Resume reading: we expect AT MOST the one buffered ping (sent before we
    // went silent) followed by the connection ending — never a second ping,
    // since the server terminates instead of ticking again once a pong is
    // overdue.
    let mut ping_count = 0u32;
    let mut terminated = false;
    for _ in 0..8u8 {
        match tokio::time::timeout(Duration::from_secs(2), ws.next()).await {
            Ok(Some(Ok(WsMessage::Ping(_)))) => ping_count += 1,
            Ok(Some(Ok(WsMessage::Close(_)))) | Ok(None) => {
                terminated = true;
                break;
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(_))) => {
                terminated = true;
                break;
            }
            Err(_) => break,
        }
    }

    assert!(
        terminated,
        "server should terminate a connection that never answers its keepalive ping"
    );
    assert!(
        ping_count <= 1,
        "server should terminate on the first missed pong, not send a second ping \
         (got {ping_count} pings)"
    );
}

//! SAFE-08: client restore diagnostics. `client.diagnostic` frames are
//! currently parsed by `ClientMessage` (the wire variant already exists,
//! `client_messages.rs:24`) but `handle_client_text`'s match in
//! `terminal.rs` has no dispatch arm for it -- it silently falls through to
//! the catch-all `_ => true`, so a real `restore_unavailable` diagnostic is
//! dropped with NO structured log. Legacy parity:
//! `server/ws-handler.ts:1901-1915`'s `client_restore_unavailable`
//! session-lifecycle record. This is a pure diagnostic: no reply, no state
//! mutation, no repair server-side (the repair is the client's own fresh
//! `terminal.create { recoveryIntent }`, deduped client-side).
//!
//! Same real axum server + real `tokio-tungstenite` client harness
//! convention as `keepalive.rs`/`diag01_lifecycle_events.rs`, with the same
//! thread-local capturing `tracing` layer as `diag01_lifecycle_events.rs`
//! (safe under parallel `cargo test` -- see that file's fix history).

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_ws::WsState;

const AUTH_TOKEN: &str = "s3cr3t-token-abcdef";

// ── capturing tracing layer (dev-only test facility, duplicated from
// diag01_lifecycle_events.rs's convention) ─────────────────────────────────

use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::{Context, SubscriberExt};
use tracing_subscriber::Layer;

#[derive(Debug, Clone, Default)]
struct CapturedEvent {
    message: String,
    fields: BTreeMap<String, String>,
}

#[derive(Default)]
struct FieldVisitor {
    message: String,
    fields: BTreeMap<String, String>,
}

impl Visit for FieldVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        let rendered = format!("{value:?}");
        if field.name() == "message" {
            self.message = rendered;
        } else {
            self.fields.insert(field.name().to_string(), rendered);
        }
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message = value.to_string();
        } else {
            self.fields
                .insert(field.name().to_string(), value.to_string());
        }
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.fields
            .insert(field.name().to_string(), value.to_string());
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.fields
            .insert(field.name().to_string(), value.to_string());
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.fields
            .insert(field.name().to_string(), value.to_string());
    }
}

struct CaptureLayer {
    events: Arc<Mutex<Vec<CapturedEvent>>>,
}

impl<S: Subscriber> Layer<S> for CaptureLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let mut visitor = FieldVisitor::default();
        event.record(&mut visitor);
        self.events
            .lock()
            .expect("capture lock")
            .push(CapturedEvent {
                message: visitor.message,
                fields: visitor.fields,
            });
    }
}

fn capture() -> (
    Arc<Mutex<Vec<CapturedEvent>>>,
    tracing::subscriber::DefaultGuard,
) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let layer = CaptureLayer {
        events: Arc::clone(&events),
    };
    let subscriber = tracing_subscriber::registry().with(layer);
    let guard = tracing::subscriber::set_default(subscriber);
    (events, guard)
}

// ── server harness (duplicated from keepalive.rs's convention) ────────────

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

async fn spawn_server() -> String {
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
        ws_max_payload_bytes: 16 * 1024 * 1024,
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

async fn wait_for_event(
    events: &Arc<Mutex<Vec<CapturedEvent>>>,
    message: &str,
) -> Option<CapturedEvent> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        {
            let captured = events.lock().unwrap();
            if let Some(found) = captured.iter().find(|e| e.message == message) {
                return Some(found.clone());
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// **RED before implementation**: `handle_client_text` has no dispatch arm
/// for `ClientMessage::ClientDiagnostic`, so this frame is silently dropped
/// and `ws.restore.unavailable` never fires.
#[tokio::test]
async fn restore_unavailable_diagnostic_emits_structured_event_with_expected_fields() {
    let (events, _guard) = capture();
    let url = spawn_server().await;
    let mut ws = connect_and_complete_handshake(&url).await;

    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "client.diagnostic",
            "event": "restore_unavailable",
            "reason": "dead_live_handle",
            "terminalId": "term-abc123",
            "tabId": "tab-1",
            "paneId": "pane-1",
            "mode": "shell",
            "hasSessionRef": false,
        })
        .to_string(),
    ))
    .await
    .expect("send client.diagnostic");

    let found = wait_for_event(&events, "ws.restore.unavailable")
        .await
        .expect("expected a ws.restore.unavailable tracing event");

    assert_eq!(
        found.fields.get("event").map(String::as_str),
        Some("client_restore_unavailable")
    );
    assert_eq!(
        found.fields.get("terminal_id").map(String::as_str),
        Some("term-abc123")
    );
    assert_eq!(
        found.fields.get("tab_id").map(String::as_str),
        Some("tab-1")
    );
    assert_eq!(
        found.fields.get("pane_id").map(String::as_str),
        Some("pane-1")
    );
    assert_eq!(found.fields.get("mode").map(String::as_str), Some("shell"));
    assert_eq!(
        found.fields.get("reason").map(String::as_str),
        Some("dead_live_handle")
    );
    assert_eq!(
        found.fields.get("has_session_ref").map(String::as_str),
        Some("false")
    );
    assert!(
        found.fields.contains_key("connection_id"),
        "restore-diagnostic event must carry connection_id"
    );

    // Pure diagnostic: no reply frame, no close -- the connection stays open
    // and idle traffic keeps flowing. Prove liveness with a second
    // terminal.create round-trip on the SAME socket.
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.create",
            "requestId": "req-after-diag",
            "mode": "shell",
            "shell": "system",
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.create after diagnostic");

    let reply = tokio::time::timeout(Duration::from_secs(5), ws.next())
        .await
        .expect("expected a reply within timeout")
        .expect("stream not ended")
        .expect("no ws error");
    match reply {
        WsMessage::Text(text) => {
            assert!(
                text.contains("\"terminal.created\""),
                "expected terminal.created after the diagnostic frame, got {text}"
            );
        }
        other => panic!("expected a text frame, got {other:?}"),
    }
}

/// **No-op tolerance**: an `event` value other than `restore_unavailable`
/// (the schema pins the literal, but the Rust wire type is a plain
/// `String`) must not be logged as `client_restore_unavailable` and must not
/// error/close the connection -- mirrors legacy's
/// `if (m.event === 'restore_unavailable')` guard (`ws-handler.ts:1902`).
#[tokio::test]
async fn diagnostic_with_unknown_event_value_is_tolerated_and_not_logged() {
    let (events, _guard) = capture();
    let url = spawn_server().await;
    let mut ws = connect_and_complete_handshake(&url).await;

    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "client.diagnostic",
            "event": "some_future_event",
            "reason": "dead_live_handle",
            "terminalId": "term-xyz",
            "tabId": "tab-1",
            "paneId": "pane-1",
            "mode": "shell",
            "hasSessionRef": false,
        })
        .to_string(),
    ))
    .await
    .expect("send client.diagnostic with unknown event");

    // Prove liveness (no close) instead of a fixed sleep: a subsequent
    // terminal.create still round-trips normally.
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.create",
            "requestId": "req-after-unknown-diag",
            "mode": "shell",
            "shell": "system",
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.create after unknown diagnostic");

    let reply = tokio::time::timeout(Duration::from_secs(5), ws.next())
        .await
        .expect("expected a reply within timeout")
        .expect("stream not ended")
        .expect("no ws error");
    assert!(
        matches!(reply, WsMessage::Text(ref t) if t.contains("\"terminal.created\"")),
        "connection must stay alive and keep serving after an unrecognized diagnostic event, got {reply:?}"
    );

    let captured = events.lock().unwrap();
    assert!(
        !captured
            .iter()
            .any(|e| e.message == "ws.restore.unavailable"),
        "an unrecognized diagnostic event value must not emit ws.restore.unavailable"
    );
}

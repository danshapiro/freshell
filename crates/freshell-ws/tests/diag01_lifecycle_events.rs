//! DIAG-01 lifecycle tracing events for the WS transport: connection
//! established/closed, hello rejected (never the token), keepalive
//! termination. Runs a REAL axum server (ephemeral loopback port) and a REAL
//! `tokio-tungstenite` client, same harness convention as `keepalive.rs`, so
//! these exercise the actual connect/auth/close paths rather than mocks.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_ws::WsState;

const AUTH_TOKEN: &str = "s3cr3t-token-abcdef";

// ── capturing tracing layer (dev-only test facility) ──────────────────────

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

/// Install a thread-local capturing subscriber for the life of the returned
/// guard. `#[tokio::test]` defaults to a CURRENT-THREAD runtime, so the
/// spawned server task (via `tokio::spawn` inside `spawn_server`) is polled
/// on this SAME OS thread and observes the thread-local default too.
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

async fn spawn_server(ping_interval_ms: u64) -> String {
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
        ping_interval_ms,
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

/// **RED before implementation**: none of `ws.hello.rejected`,
/// `ws.connection.established`, `ws.connection.closed` are emitted today.
/// Covers 3 representative DIAG-01 WS lifecycle events in one real
/// connect/auth/close flow, per crate.
#[tokio::test]
async fn diag01_ws_lifecycle_events_fire_with_expected_fields_and_never_leak_the_token() {
    let (events, _guard) = capture();
    let url = spawn_server(30_000).await;

    // 1. Bad token -> `ws.hello.rejected` (warn, reason="bad_token"), then the
    // server closes the socket itself (code 4001) -> `ws.connection.closed`.
    {
        let (mut ws, _resp) = tokio_tungstenite::connect_async(&url)
            .await
            .expect("connect");
        ws.send(WsMessage::Text(
            serde_json::json!({
                "type": "hello",
                "token": "definitely-not-the-real-token",
                "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
            })
            .to_string(),
        ))
        .await
        .expect("send hello");
        // Drain until the server closes the connection.
        loop {
            match tokio::time::timeout(Duration::from_secs(5), ws.next()).await {
                Ok(Some(Ok(WsMessage::Close(_)))) | Ok(None) => break,
                Ok(Some(Ok(_))) => continue,
                Ok(Some(Err(_))) => break,
                Err(_) => break,
            }
        }
    }

    // 2. Good handshake, then a clean client-initiated close -> `ws.connection.established`
    // followed by `ws.connection.closed` (reason reflecting the client close).
    {
        let mut ws = connect_and_complete_handshake(&url).await;
        ws.close(None).await.expect("client close");
        // Give the server loop a beat to observe the close and tear down.
        let _ = tokio::time::timeout(Duration::from_secs(2), ws.next()).await;
    }

    // Bound the wait for the server's async logging to catch up (best-effort
    // polling rather than a fixed sleep -- more robust under CI load).
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        {
            let captured = events.lock().unwrap();
            let have_all = captured.iter().any(|e| e.message == "ws.hello.rejected")
                && captured
                    .iter()
                    .any(|e| e.message == "ws.connection.established")
                && captured.iter().any(|e| e.message == "ws.connection.closed");
            if have_all || tokio::time::Instant::now() >= deadline {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    let captured = events.lock().unwrap().clone();

    let hello_rejected = captured
        .iter()
        .find(|e| e.message == "ws.hello.rejected")
        .expect("expected a ws.hello.rejected tracing event");
    assert_eq!(
        hello_rejected.fields.get("reason").map(String::as_str),
        Some("bad_token")
    );
    for value in hello_rejected.fields.values() {
        assert_ne!(
            value, AUTH_TOKEN,
            "hello.rejected must never log the real token"
        );
    }
    assert!(
        !hello_rejected.message.contains(AUTH_TOKEN),
        "hello.rejected message must never contain the real token"
    );

    let established = captured
        .iter()
        .find(|e| e.message == "ws.connection.established")
        .expect("expected a ws.connection.established tracing event");
    assert!(
        established.fields.contains_key("connection_id"),
        "connection.established must carry connection_id"
    );
    assert!(
        established.fields.contains_key("origin_kind"),
        "connection.established must carry the origin allowed-kind"
    );

    let closed = captured
        .iter()
        .find(|e| e.message == "ws.connection.closed")
        .expect("expected a ws.connection.closed tracing event");
    assert!(
        closed.fields.contains_key("reason"),
        "connection.closed must carry a reason"
    );
    assert!(
        closed.fields.contains_key("connection_id"),
        "connection.closed must carry connection_id"
    );
}

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
use tracing::span::{Attributes, Id};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::{Context, SubscriberExt};
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::Layer;

#[derive(Debug, Clone, Default)]
struct CapturedEvent {
    message: String,
    /// Span-merged view (span fields root->leaf, then event fields) — what
    /// the production JsonLayer writes.
    fields: BTreeMap<String, String>,
    /// The event's OWN fields only (no span merge) — proves dual-carrier
    /// claims, which require the field ON THE EVENT.
    event_fields: BTreeMap<String, String>,
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

/// Span-local storage mirroring the production `JsonLayer`'s `SpanFields`:
/// fields recorded at span creation are merged into every event captured
/// while that span is in the scope chain (root -> leaf; event fields win on
/// collision) -- exactly how `freshell-server`'s JSONL writer produces
/// `connection_id` on in-connection events.
struct SpanFields(BTreeMap<String, String>);

impl<S> Layer<S> for CaptureLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_new_span(&self, attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
        let mut visitor = FieldVisitor::default();
        attrs.record(&mut visitor);
        if let Some(span) = ctx.span(id) {
            span.extensions_mut().insert(SpanFields(visitor.fields));
        }
    }

    fn on_event(&self, event: &Event<'_>, ctx: Context<'_, S>) {
        let mut visitor = FieldVisitor::default();
        event.record(&mut visitor);
        let mut fields = BTreeMap::new();
        if let Some(scope) = ctx.event_scope(event) {
            for span in scope.from_root() {
                let extensions = span.extensions();
                if let Some(SpanFields(span_fields)) = extensions.get::<SpanFields>() {
                    for (k, v) in span_fields {
                        fields.insert(k.clone(), v.clone());
                    }
                }
            }
        }
        for (k, v) in &visitor.fields {
            fields.insert(k.clone(), v.clone());
        }
        self.events
            .lock()
            .expect("capture lock")
            .push(CapturedEvent {
                message: visitor.message,
                fields,
                event_fields: visitor.fields,
            });
    }
}

/// Install a thread-local capturing subscriber for the life of the returned
/// guard. `#[tokio::test]` defaults to a CURRENT-THREAD runtime, so the
/// spawned server task (via `tokio::spawn` inside `spawn_server`) is polled
/// on this SAME OS thread and observes the thread-local default too.
///
/// NOTE: events emitted on `spawn_blocking` pool threads (e.g. the
/// registry's `terminal.created`, fired from `handle_create`'s blocking PTY
/// spawn) do NOT observe this thread-local guard -- capture of those goes
/// through the process-`GLOBAL` subscriber below.
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

/// Process-global capture for events emitted OFF the test's own thread --
/// the `spawn_blocking` pool (registry.create's `terminal.created`) has no
/// thread-local dispatcher, so only a global default observes them. Same
/// OnceLock-install semantics as `freshell-freshagent`'s diag01 capture
/// (c62385ab4): first caller installs; `get_or_init` is the synchronization;
/// every later call is a cheap no-op. Events from ALL tests in this binary
/// land in the shared vec, so reads MUST filter by a per-test-unique field
/// (the freshly minted `terminal_id`), never by "ever seen".
static GLOBAL_EVENTS: std::sync::OnceLock<Arc<Mutex<Vec<CapturedEvent>>>> =
    std::sync::OnceLock::new();

fn global_capture() -> (Arc<Mutex<Vec<CapturedEvent>>>, usize) {
    let events = GLOBAL_EVENTS
        .get_or_init(|| {
            let events = Arc::new(Mutex::new(Vec::new()));
            let layer = CaptureLayer {
                events: Arc::clone(&events),
            };
            let subscriber = tracing_subscriber::registry().with(layer);
            // This binary installs no other global subscriber; `.expect()`
            // turns any future second-installer regression into an immediate
            // diagnosable panic instead of a silently-empty capture.
            tracing::subscriber::set_global_default(subscriber)
                .expect("this test binary installs exactly one global subscriber");
            events
        })
        .clone();
    let start_index = events.lock().expect("capture lock").len();
    (events, start_index)
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
        pane_ledger: std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::disabled()),
        layout: Default::default(),
        identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
        terminal_meta: Default::default(),
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
        terminals_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        sessions_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        cli_commands: Arc::new(Vec::new()),
        shutdown: Arc::new(tokio::sync::Notify::new()),
        ping_interval_ms,
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
    assert!(
        closed.event_fields.contains_key("origin_kind"),
        "connection.closed must carry origin_kind AS AN EVENT FIELD (dual-carrier: \
         the span's copy dies along with the span under target-directive-only filters; \
         only the event's own fields survive those)"
    );
}

/// Proves DIAG-01's "connection ownership" clause holds for events emitted
/// while *serving* a connection: the registry's `terminal.created` (fired
/// from `handle_create`'s `spawn_blocking` PTY spawn on a pool thread) must
/// carry the serving connection's `connection_id` -- via the `ws_conn` span
/// wrapping `run_loop` + the `spawn_blocking_in_span` context hop, observed
/// here exactly the way the production `JsonLayer` flattens span fields
/// into the JSONL line.
#[tokio::test]
async fn diag01_in_connection_events_carry_the_connection_id() {
    let (events, start_index) = global_capture();
    let url = spawn_server(30_000).await;
    let mut ws = connect_and_complete_handshake(&url).await;

    let request_id = format!("diag01-conn-span-{}", uuid::Uuid::new_v4());
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.create",
            "requestId": request_id,
            "mode": "shell",
            "shell": "system",
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.create");

    // Await the terminal.created reply frame and capture the minted id -- the
    // airtight filter key for the global event vec below.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    let mut wire_terminal_id: Option<String> = None;
    while tokio::time::Instant::now() < deadline && wire_terminal_id.is_none() {
        match tokio::time::timeout(Duration::from_secs(5), ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
                    continue;
                };
                if value.get("type").and_then(|v| v.as_str()) == Some("terminal.created")
                    && value.get("requestId").and_then(|v| v.as_str()) == Some(request_id.as_str())
                {
                    wire_terminal_id = value
                        .get("terminalId")
                        .and_then(|v| v.as_str())
                        .map(str::to_string);
                }
            }
            Ok(Some(Ok(_))) => {}
            other => panic!("unexpected frame awaiting terminal.created: {other:?}"),
        }
    }
    let terminal_id = wire_terminal_id.expect("never received terminal.created frame");
    ws.close(None).await.ok();

    // Poll for OUR captured tracing events to settle (bounded): the created
    // event keyed by our terminal_id, then a beat for the close-path events.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while tokio::time::Instant::now() < deadline {
        let present = {
            let captured = events.lock().unwrap();
            captured[start_index..].iter().any(|e| {
                e.message == "terminal.created"
                    && e.fields.get("terminal_id").map(String::as_str) == Some(terminal_id.as_str())
            })
        };
        if present {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    tokio::time::sleep(Duration::from_millis(200)).await;

    let captured = events.lock().unwrap().clone();

    // Key everything off OUR terminal's uniquely-identified created event
    // (other tests in this binary share the global vec; never match on just
    // an event name here).
    let created = captured[start_index..]
        .iter()
        .find(|e| {
            e.message == "terminal.created"
                && e.fields.get("terminal_id").map(String::as_str) == Some(terminal_id.as_str())
        })
        .expect("expected a terminal.created tracing event for our terminal_id");
    let conn_id = created
        .fields
        .get("connection_id")
        .cloned()
        .unwrap_or_else(|| {
            panic!(
                "terminal.created must inherit the serving connection's id via the \
                 ws_conn span; got fields: {:?}",
                created.fields
            )
        });

    // Coherence: the same connection_id appears on this connection's
    // established AND closed lifecycle events, so the whole lifecycle of a
    // connection (and the work it performed) is attributable to one id.
    for name in ["ws.connection.established", "ws.connection.closed"] {
        let matching = captured[start_index..]
            .iter()
            .any(|e| e.message == name && e.fields.get("connection_id") == Some(&conn_id));
        assert!(
            matching,
            "expected a {name} event with connection_id {conn_id}"
        );
    }

    // The ws-side settle companion carries the SAME join as explicit EVENT
    // fields (not span context) -- the dual-carrier design (review round 2):
    // span enrichment dies under tracing-subscriber's target-directive-only
    // filters (empirically, even a matched `freshell_ws=info` directive
    // disables span callsites), but an event's own fields ride through any
    // filter that admits the event. `ws.terminal.create.settled` is the
    // connection_id <-> terminal_id <-> requestId join that survives.
    let settled = captured[start_index..]
        .iter()
        .find(|e| {
            e.message == "ws.terminal.create.settled"
                && e.fields.get("terminal_id").map(String::as_str) == Some(terminal_id.as_str())
        })
        .expect("expected a ws.terminal.create.settled companion event for our terminal_id");
    assert_eq!(
        settled.fields.get("connection_id").map(String::as_str),
        Some(conn_id.as_str()),
        "settle companion carries connection_id as an event field"
    );
    assert_eq!(
        settled.fields.get("request_id").map(String::as_str),
        Some(request_id.as_str()),
        "settle companion carries the client requestId as an event field"
    );
}
